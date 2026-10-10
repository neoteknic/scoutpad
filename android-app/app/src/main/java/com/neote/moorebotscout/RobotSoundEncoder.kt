package com.neote.moorebotscout

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import mobilebridge.SoundEncoder
import java.io.ByteArrayOutputStream

object AacPacket {
    fun wrap(data: ByteArray): ByteArray {
        val length = data.size + 7
        require(data.isNotEmpty() && length <= 1024) { "Trame audio trop grande pour le Scout" }
        val header = byteArrayOf(0xff.toByte(), 0xf1.toByte(), 0x60, (0x40 or (length shr 11)).toByte(),
            (length shr 3).toByte(), (((length and 7) shl 5) or 0x1f).toByte(), 0xfc.toByte())
        return header + data
    }
}

class RobotSoundEncoder : SoundEncoder {
    override fun encodePCM(pcm: ByteArray): ByteArray {
        require(pcm.isNotEmpty() && pcm.size <= 960000 && pcm.size % 2 == 0) { "Son limite a 30 secondes" }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        var started = false
        try {
            val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, 16000, 1).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, 32000)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 4096)
            }
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            started = true
            val output = ByteArrayOutputStream()
            val info = MediaCodec.BufferInfo()
            var offset = 0
            var inputEnded = false
            val deadline = System.nanoTime() + 15_000_000_000L
            while (System.nanoTime() < deadline) {
                if (!inputEnded) {
                    val index = codec.dequeueInputBuffer(10000)
                    if (index >= 0) {
                        val buffer = requireNotNull(codec.getInputBuffer(index))
                        buffer.clear()
                        val size = minOf(buffer.remaining(), pcm.size - offset) and -2
                        buffer.put(pcm, offset, size)
                        val timestamp = offset.toLong() / 2 * 1_000_000 / 16000
                        offset += size
                        inputEnded = offset == pcm.size
                        codec.queueInputBuffer(index, 0, size, timestamp,
                            if (inputEnded) MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
                    }
                }
                val index = codec.dequeueOutputBuffer(info, 10000)
                if (index >= 0) {
                    try {
                        if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                            val buffer = requireNotNull(codec.getOutputBuffer(index))
                            buffer.position(info.offset)
                            buffer.limit(info.offset + info.size)
                            val data = ByteArray(info.size)
                            buffer.get(data)
                            output.write(AacPacket.wrap(data))
                        }
                    } finally { codec.releaseOutputBuffer(index, false) }
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return output.toByteArray()
                }
            }
            error("Delai de conversion audio depasse")
        } finally {
            try { if (started) codec.stop() } finally { codec.release() }
        }
    }
}
