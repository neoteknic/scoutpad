package com.neote.moorebotscout

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.hardware.input.InputManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Bundle
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.MimeTypeMap
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.RenderProcessGoneDetail
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import mobilebridge.Mobilebridge
import org.json.JSONObject
import org.json.JSONArray
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity(), InputManager.InputDeviceListener {
    private lateinit var webView: WebView
    private lateinit var inputManager: InputManager
    private val axes = FloatArray(4)
    private val buttons = BooleanArray(16)
    private lateinit var controllerSelection: ControllerSelection
    private val observedControllers = mutableSetOf<Int>()
    private var resumed = false
    private var awaitingNeutral = true
    private var motionActive = false
    private var emitScheduled = false
    private var pageReady = false
    private var feedbackTone: ToneGenerator? = null
    private val shutdownExecutor = Executors.newSingleThreadExecutor()
    private var fileChooser: ValueCallback<Array<Uri>>? = null
    private val chooseSound = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileChooser?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        fileChooser = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enterImmersiveMode()
        controllerSelection = ControllerSelection(
            getSharedPreferences("controller", Context.MODE_PRIVATE).getString("descriptor", null)
        )

        val error = Mobilebridge.start("192.168.0.142")
        Mobilebridge.setSoundEncoder(RobotSoundEncoder())

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = false
            setBackgroundColor(0xff07110f.toInt())
            webViewClient = AssetInterceptClient(this@MainActivity)
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(view: WebView?, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                    fileChooser?.onReceiveValue(null)
                    fileChooser = callback
                    return try {
                        chooseSound.launch(params.createIntent().apply { type = "audio/*"; addCategory(Intent.CATEGORY_OPENABLE) })
                        true
                    } catch (_: RuntimeException) {
                        fileChooser?.onReceiveValue(null)
                        fileChooser = null
                        true
                    }
                }
            }
            addJavascriptInterface(ControllerInterface(), "ScoutInput")
            setOnLongClickListener { true }
        }
        setContentView(webView)

        inputManager = getSystemService(Context.INPUT_SERVICE) as InputManager
        inputManager.registerInputDeviceListener(this, null)
        refreshController()
        webView.loadUrl("http://127.0.0.1:18114/")

        if (error.isNotEmpty()) {
            webView.postDelayed({
                webView.evaluateJavascript(
                    "window.console.error(${quoteJs(error)});",
                    null
                )
            }, 500)
        }
    }

    override fun onResume() {
        super.onResume()
        enterImmersiveMode()
        resumed = true
        resetInputs()
        refreshController()
        Mobilebridge.suspend(false)
        if (::webView.isInitialized) {
            webView.onResume()
            emitGamepadState()
            emitLifecycle()
        }
    }

    override fun onPause() {
        resumed = false
        resetInputs()
        Mobilebridge.suspend(true)
        emitGamepadState()
        emitLifecycle()
        if (::webView.isInitialized) webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        fileChooser?.onReceiveValue(null)
        fileChooser = null
        feedbackTone?.release()
        feedbackTone = null
        if (::inputManager.isInitialized) inputManager.unregisterInputDeviceListener(this)
        shutdownExecutor.execute { Mobilebridge.stop() }
        shutdownExecutor.shutdown()
        if (::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_MOVE && isController(event.source)) {
            if (!resumed) return true
            val device = event.device ?: return super.dispatchGenericMotionEvent(event)
            var leftX = centeredAxis(event, device, MotionEvent.AXIS_X)
            var leftY = centeredAxis(event, device, MotionEvent.AXIS_Y)
            var rightX = centeredAxis(event, device, MotionEvent.AXIS_Z)
            var rightY = centeredAxis(event, device, MotionEvent.AXIS_RZ)
            if (device.getMotionRange(MotionEvent.AXIS_Z, event.source) == null) rightX = centeredAxis(event, device, MotionEvent.AXIS_RX)
            if (device.getMotionRange(MotionEvent.AXIS_RZ, event.source) == null) rightY = centeredAxis(event, device, MotionEvent.AXIS_RY)

            val hatX = centeredAxis(event, device, MotionEvent.AXIS_HAT_X)
            val hatY = centeredAxis(event, device, MotionEvent.AXIS_HAT_Y)
            if (leftX == 0f) leftX = hatX
            if (leftY == 0f) leftY = hatY

            val activeInput = listOf(leftX, leftY, rightX, rightY).any { kotlin.math.abs(it) >= 0.15f }
            if (!selectController(device, activeInput)) return true
            if (activeInput && !motionActive) emitControllerInput(device.id)
            motionActive = activeInput

            if (awaitingNeutral) {
                if (listOf(leftX, leftY, rightX, rightY).all { kotlin.math.abs(it) < 0.15f }) awaitingNeutral = false
                else return true
            }

            axes[0] = leftX
            axes[1] = leftY
            axes[2] = rightX
            axes[3] = rightY
            emitGamepadState()
            return true
        }
        return super.dispatchGenericMotionEvent(event)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (!KeyEvent.isGamepadButton(event.keyCode) && event.keyCode !in KeyEvent.KEYCODE_DPAD_UP..KeyEvent.KEYCODE_DPAD_RIGHT) return super.dispatchKeyEvent(event)
        if (!resumed) return true
        val device = event.device ?: return super.dispatchKeyEvent(event)
        if (!isController(event.source) && !KeyEvent.isGamepadButton(event.keyCode) && controllerDevices().none { it.id == device.id }) return super.dispatchKeyEvent(event)
        val pressed = event.action != KeyEvent.ACTION_UP
        if (!selectController(device, pressed && event.repeatCount == 0)) return true
        if (pressed && event.repeatCount == 0 && event.keyCode in KeyEvent.KEYCODE_DPAD_UP..KeyEvent.KEYCODE_DPAD_RIGHT) emitControllerInput(device.id)
        if (awaitingNeutral && event.keyCode in KeyEvent.KEYCODE_DPAD_UP..KeyEvent.KEYCODE_DPAD_RIGHT) {
            if (!pressed) awaitingNeutral = false
            return true
        }
        when (event.keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT -> axes[0] = if (pressed) -1f else if (axes[0] < 0f) 0f else axes[0]
            KeyEvent.KEYCODE_DPAD_RIGHT -> axes[0] = if (pressed) 1f else if (axes[0] > 0f) 0f else axes[0]
            KeyEvent.KEYCODE_DPAD_UP -> axes[1] = if (pressed) -1f else if (axes[1] < 0f) 0f else axes[1]
            KeyEvent.KEYCODE_DPAD_DOWN -> axes[1] = if (pressed) 1f else if (axes[1] > 0f) 0f else axes[1]
            else -> Unit
        }
        if (event.keyCode in KeyEvent.KEYCODE_DPAD_UP..KeyEvent.KEYCODE_DPAD_RIGHT) {
            emitGamepadState()
            return true
        }

        val buttonIndex = when (event.keyCode) {
            KeyEvent.KEYCODE_BUTTON_A -> 0
            KeyEvent.KEYCODE_BUTTON_B -> 1
            KeyEvent.KEYCODE_BUTTON_X -> 2
            KeyEvent.KEYCODE_BUTTON_Y -> 3
            KeyEvent.KEYCODE_BUTTON_L1 -> 4
            KeyEvent.KEYCODE_BUTTON_R1 -> 5
            KeyEvent.KEYCODE_BUTTON_L2 -> 6
            KeyEvent.KEYCODE_BUTTON_R2 -> 7
            KeyEvent.KEYCODE_BUTTON_SELECT -> 8
            KeyEvent.KEYCODE_BUTTON_START -> 9
            KeyEvent.KEYCODE_BUTTON_THUMBL -> 10
            KeyEvent.KEYCODE_BUTTON_THUMBR -> 11
            else -> -1
        }
        if (buttonIndex >= 0) {
            val justPressed = pressed && !buttons[buttonIndex] && event.repeatCount == 0
            buttons[buttonIndex] = pressed
            emitGamepadState()
            if (justPressed && pageReady) {
                webView.evaluateJavascript("window.scoutNativeButton && window.scoutNativeButton($buttonIndex,${device.id});", null)
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onInputDeviceAdded(deviceId: Int) { refreshController(); emitGamepadState() }
    override fun onInputDeviceChanged(deviceId: Int) { refreshController(); emitGamepadState() }

    override fun onInputDeviceRemoved(deviceId: Int) {
        observedControllers.remove(deviceId)
        refreshController()
        emitGamepadState()
    }

    private fun centeredAxis(event: MotionEvent, device: InputDevice, axis: Int): Float {
        val range = device.getMotionRange(axis, event.source) ?: return 0f
        val value = event.getAxisValue(axis)
        return if (kotlin.math.abs(value) > range.flat) value.coerceIn(-1f, 1f) else 0f
    }

    private fun emitGamepadState() {
        if (!::webView.isInitialized || emitScheduled) return
        emitScheduled = true
        webView.postOnAnimation {
            emitScheduled = false
            if (!pageReady) return@postOnAnimation
            val axesJson = axes.joinToString(prefix = "[", postfix = "]") { it.toString() }
            val buttonsJson = buttons.joinToString(prefix = "[", postfix = "]") { it.toString() }
            val device = controllerSelection.activeId?.let { InputDevice.getDevice(it) }
            webView.evaluateJavascript(
                "window.scoutNativeGamepadUpdate && window.scoutNativeGamepadUpdate($axesJson,$buttonsJson,${device != null},${quoteJs(device?.name.orEmpty())},${device?.id ?: "null"});",
                null
            )
        }
    }

    private fun resetInputs() {
        axes.fill(0f)
        buttons.fill(false)
        awaitingNeutral = true
        motionActive = false
    }

    private fun emitControllerInput(deviceId: Int) {
        if (pageReady) webView.evaluateJavascript("window.scoutNativeInput && window.scoutNativeInput($deviceId);", null)
    }

    private fun refreshController() {
        val previousId = controllerSelection.activeId
        controllerSelection.refresh(controllerDevices().map { ControllerDevice(it.id, it.descriptor) })
        if (previousId != controllerSelection.activeId) resetController()
        emitControllerList()
    }

    private fun selectController(device: InputDevice, activeInput: Boolean): Boolean {
        if (observedControllers.add(device.id)) refreshController()
        val previousId = controllerSelection.activeId
        val accepted = controllerSelection.accepts(device.id, activeInput)
        if (previousId != controllerSelection.activeId) {
            resetInputs()
            emitControllerList()
            // Deliver a neutral state before the first real event from a newly detected controller.
            if (pageReady) webView.evaluateJavascript(
                "window.scoutNativeGamepadUpdate && window.scoutNativeGamepadUpdate([0,0,0,0],[],true,${quoteJs(device.name)},${device.id});", null
            )
        }
        return accepted
    }

    private fun controllerDevices(): List<InputDevice> = InputDevice.getDeviceIds().toList().mapNotNull { InputDevice.getDevice(it) }
        .filter { device ->
            observedControllers.contains(device.id) || isController(device.sources) ||
                device.hasKeys(KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_BUTTON_B, KeyEvent.KEYCODE_BUTTON_START).any { it }
        }

    private fun resetController() {
        resetInputs()
        Mobilebridge.suspend(true)
        Mobilebridge.suspend(!resumed)
        if (pageReady) webView.evaluateJavascript("window.scoutNativeControllerChanged && window.scoutNativeControllerChanged();", null)
        emitGamepadState()
    }

    private fun emitControllerList() {
        if (!::webView.isInitialized || !pageReady) return
        val devices = JSONArray()
        controllerDevices().forEach { device ->
            devices.put(JSONObject().put("id", device.id).put("name", device.name)
                .put("descriptor", device.descriptor).put("virtual", device.isVirtual)
                .put("analog", device.supportsSource(InputDevice.SOURCE_JOYSTICK)))
        }
        val preference = controllerSelection.preferredDescriptor
        val selection = JSONObject().put("mode", if (preference == null) "auto" else "manual")
            .put("activeId", controllerSelection.activeId ?: JSONObject.NULL)
            .put("selectedId", if (preference == null) JSONObject.NULL else controllerSelection.activeId ?: JSONObject.NULL)
        webView.evaluateJavascript("window.scoutNativeControllersUpdate && window.scoutNativeControllersUpdate($devices,$selection);", null)
    }

    inner class ControllerInterface {
        @JavascriptInterface
        fun feedback(event: String) { runOnUiThread {
            if (!resumed) return@runOnUiThread
            val tone = when (event) {
                "dock" -> ToneGenerator.TONE_PROP_ACK
                "cancelDock" -> ToneGenerator.TONE_PROP_NACK
                else -> return@runOnUiThread
            }
            try {
                if (feedbackTone == null) feedbackTone = ToneGenerator(AudioManager.STREAM_MUSIC, 70)
                feedbackTone?.startTone(tone, 350)
            } catch (_: RuntimeException) { /* Audio feedback must not interrupt controls. */ }
        } }

        @JavascriptInterface
        fun refresh() { runOnUiThread { refreshController(); emitGamepadState() } }

        @JavascriptInterface
        fun select(value: String) { runOnUiThread {
            val id = if (value == "auto") null else value.toIntOrNull() ?: return@runOnUiThread
            if (!controllerSelection.choose(id)) return@runOnUiThread
            getSharedPreferences("controller", Context.MODE_PRIVATE).edit()
                .putString("descriptor", controllerSelection.preferredDescriptor).apply()
            resetController()
            emitControllerList()
        } }
    }

    private fun emitLifecycle() {
        if (!::webView.isInitialized || !pageReady) return
        webView.evaluateJavascript("window.scoutNativeLifecycle && window.scoutNativeLifecycle($resumed);", null)
    }

    private fun isController(source: Int): Boolean {
        return source and InputDevice.SOURCE_GAMEPAD == InputDevice.SOURCE_GAMEPAD ||
            source and InputDevice.SOURCE_JOYSTICK == InputDevice.SOURCE_JOYSTICK ||
            source and InputDevice.SOURCE_DPAD == InputDevice.SOURCE_DPAD
    }

    private fun enterImmersiveMode() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility =
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    }

    private fun quoteJs(value: String): String = JSONObject.quote(value)

    private class AssetInterceptClient(private val activity: MainActivity) : WebViewClient() {
        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            activity.pageReady = true
            view?.evaluateJavascript("window.scoutAndroid = true; document.body.classList.add('android-console');", null)
            activity.emitGamepadState()
            activity.emitControllerList()
            activity.emitLifecycle()
        }

        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
            val uri = request?.url ?: return true
            return !isLocalPage(uri)
        }

        @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
        override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
            return !isLocalPage(Uri.parse(url ?: return true))
        }

        private fun isLocalPage(uri: Uri): Boolean = uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port == 18114

        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            Mobilebridge.suspend(true)
            activity.pageReady = false
            activity.setContentView(View(activity))
            activity.recreate()
            return true
        }

        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
            val uri = request?.url ?: return null
            if (uri.host != "127.0.0.1" || uri.port != 18114 || uri.path?.startsWith("/api/") == true) {
                return null
            }
            val assetPath = when (val path = uri.path.orEmpty().trimStart('/')) {
                "" -> "index.html"
                else -> path
            }
            return try {
                val mime = mimeType(assetPath)
                WebResourceResponse(mime, "UTF-8", activity.assets.open(assetPath))
            } catch (_: Exception) {
                null
            }
        }

        private fun mimeType(path: String): String = when {
            path.endsWith(".js") -> "text/javascript"
            path.endsWith(".css") -> "text/css"
            path.endsWith(".html") -> "text/html"
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(
                Uri.parse(path).lastPathSegment?.substringAfterLast('.', "")
            ) ?: "application/octet-stream"
        }
    }
}
