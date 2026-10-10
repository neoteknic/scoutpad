package com.neote.moorebotscout

import org.junit.Assert.*
import org.junit.Test

class ControllerSelectionTest {
    private val xbox = ControllerDevice(2, "virtual-xbox")
    private val mangmi = ControllerDevice(7, "integrated-mangmi")

    @Test fun automaticWaitsForInputInsteadOfChoosingFirstListedDevice() {
        val selection = ControllerSelection()
        selection.refresh(listOf(xbox, mangmi))
        assertNull(selection.activeId)
        assertFalse(selection.accepts(xbox.id, false))
        assertTrue(selection.accepts(mangmi.id, true))
        assertEquals(mangmi.id, selection.activeId)
        assertFalse(selection.accepts(xbox.id, true))
    }

    @Test fun manualSelectionIgnoresOtherInputsAndDoesNotFallBackAfterRemoval() {
        val selection = ControllerSelection()
        selection.refresh(listOf(xbox, mangmi))
        assertTrue(selection.choose(mangmi.id))
        assertFalse(selection.accepts(xbox.id, true))
        selection.refresh(listOf(xbox))
        assertNull(selection.activeId)
        assertFalse(selection.accepts(xbox.id, true))
    }

    @Test fun savedDescriptorRestoresDeviceEvenWhenAndroidChangesItsId() {
        val selection = ControllerSelection(mangmi.descriptor)
        val reconnected = mangmi.copy(id = 42)
        selection.refresh(listOf(xbox, reconnected))
        assertEquals(reconnected.id, selection.activeId)
        assertTrue(selection.accepts(reconnected.id, false))
    }

    @Test fun returningToAutomaticClearsTheOldLock() {
        val selection = ControllerSelection()
        selection.refresh(listOf(xbox, mangmi))
        selection.choose(xbox.id)
        assertTrue(selection.choose(null))
        assertNull(selection.activeId)
        assertTrue(selection.accepts(mangmi.id, true))
    }

    @Test fun invalidChoiceDoesNotChangeCurrentSelection() {
        val selection = ControllerSelection()
        selection.refresh(listOf(mangmi))
        selection.choose(mangmi.id)
        assertFalse(selection.choose(999))
        assertEquals(mangmi.id, selection.activeId)
    }
}
