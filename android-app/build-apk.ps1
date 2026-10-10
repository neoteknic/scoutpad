$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AndroidSdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$AndroidNdk = Join-Path $AndroidSdk "ndk\27.2.12479018"
$JavaHome = "C:\Program Files\Android\Android Studio\jbr"
$GoBin = Join-Path $ProjectRoot ".tools\go\bin"
$GoMobileBin = Join-Path $ProjectRoot ".tools\go-bin"
$Gradle = Join-Path $ProjectRoot ".tools\gradle-8.9\bin\gradle.bat"

$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $AndroidSdk
$env:ANDROID_NDK_HOME = $AndroidNdk
$env:PATH = "$JavaHome\bin;$GoBin;$GoMobileBin;$env:PATH"

if (-not (Test-Path -LiteralPath $Gradle)) {
    throw "Gradle 8.9 introuvable dans .tools."
}

Push-Location (Join-Path $ProjectRoot "bridge\mobilebridge")
try {
    & (Join-Path $GoMobileBin "gomobile.exe") bind -target=android -androidapi 23 -o "..\..\android-app\app\libs\mobilebridge.aar" .
    if ($LASTEXITCODE -ne 0) { throw "Echec gomobile bind" }
} finally {
    Pop-Location
}

Push-Location $PSScriptRoot
try {
    & $Gradle --no-daemon assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "Echec Gradle" }
} finally {
    Pop-Location
}

$BuiltApk = Join-Path $PSScriptRoot "app\build\outputs\apk\debug\app-debug.apk"
$OutputApk = Join-Path $ProjectRoot "Moorebot-Scout-Android.apk"
Copy-Item -LiteralPath $BuiltApk -Destination $OutputApk -Force
Write-Host "APK creee : $OutputApk"
