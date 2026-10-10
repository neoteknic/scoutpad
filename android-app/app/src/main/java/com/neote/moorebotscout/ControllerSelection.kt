package com.neote.moorebotscout

internal data class ControllerDevice(val id: Int, val descriptor: String)

internal class ControllerSelection(var preferredDescriptor: String? = null) {
    var activeId: Int? = null
        private set
    private var devices = emptyList<ControllerDevice>()

    fun refresh(available: List<ControllerDevice>) {
        devices = available
        activeId = if (preferredDescriptor != null) {
            devices.firstOrNull { it.descriptor == preferredDescriptor }?.id
        } else {
            activeId?.takeIf { id -> devices.any { it.id == id } }
        }
    }

    fun choose(id: Int?): Boolean {
        val device = id?.let { selected -> devices.firstOrNull { it.id == selected } }
        if (id != null && device == null) return false
        preferredDescriptor = device?.descriptor
        activeId = device?.id
        return true
    }

    fun accepts(id: Int, activeInput: Boolean): Boolean {
        if (devices.none { it.id == id }) return false
        if (preferredDescriptor == null && activeId == null && activeInput) activeId = id
        return activeId == id
    }
}
