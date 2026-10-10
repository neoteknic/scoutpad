package com.neote.moorebotscout

import org.junit.Assert.*
import org.junit.Test

class DpadInputTest {
    @Test fun allDirectionsAndDiagonals() {
        val pad = DpadInput()
        assertEquals(listOf(12, 14), pad.hat(-1f, -1f))
        assertEquals(emptyList<Int>(), pad.hat(-1f, -1f))
        assertEquals(listOf(13, 15), pad.hat(1f, 1f))
        assertEquals(emptyList<Int>(), pad.hat(0f, 0f))
        for (index in 12..15) assertFalse(pad.pressed(index))
    }

    @Test fun keyAndHatDoNotDoubleTriggerOrReleaseEachOther() {
        val pad = DpadInput()
        assertEquals(listOf(12), pad.key(12, true))
        assertEquals(emptyList<Int>(), pad.key(12, true))
        assertEquals(emptyList<Int>(), pad.hat(0f, -1f))
        pad.key(12, false)
        assertTrue(pad.pressed(12))
        pad.hat(0f, 0f)
        assertFalse(pad.pressed(12))
        assertEquals(listOf(12), pad.hat(0f, -1f))
    }

    @Test fun resetClearsBothSources() {
        val pad = DpadInput()
        pad.key(14, true)
        pad.hat(1f, 0f)
        pad.reset()
        for (index in 12..15) assertFalse(pad.pressed(index))
        assertEquals(listOf(15), pad.key(15, true))
    }
}
