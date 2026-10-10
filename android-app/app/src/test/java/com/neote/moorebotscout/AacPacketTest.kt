package com.neote.moorebotscout

import org.junit.Assert.*
import org.junit.Test

class AacPacketTest {
    @Test fun mono16kHeaderAndLength() {
        val packet = AacPacket.wrap(ByteArray(100) { 42 })
        val byte = { index: Int -> packet[index].toInt() and 255 }
        assertEquals(107, packet.size)
        assertEquals(255, byte(0))
        assertEquals(1, byte(2) shr 6)
        assertEquals(8, (byte(2) shr 2) and 15)
        assertEquals(1, ((byte(2) and 1) shl 2) or (byte(3) shr 6))
        assertEquals(107, ((byte(3) and 3) shl 11) or (byte(4) shl 3) or (byte(5) shr 5))
        assertEquals(42, byte(7))
    }
    @Test(expected = IllegalArgumentException::class) fun rejectsOversizedFrame() { AacPacket.wrap(ByteArray(1018)) }
    @Test(expected = IllegalArgumentException::class) fun rejectsEmptyFrame() { AacPacket.wrap(ByteArray(0)) }
}
