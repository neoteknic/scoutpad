package com.neote.moorebotscout

// Some controllers report the same direction through both key and hat events.
class DpadInput {
    private val keys = BooleanArray(4)
    private val hats = BooleanArray(4)

    fun pressed(index: Int): Boolean = keys[index - 12] || hats[index - 12]

    fun key(index: Int, down: Boolean): List<Int> = update { keys[index - 12] = down }

    fun hat(x: Float, y: Float): List<Int> = update {
        hats[0] = y < -0.5f
        hats[1] = y > 0.5f
        hats[2] = x < -0.5f
        hats[3] = x > 0.5f
    }

    private fun update(change: () -> Unit): List<Int> {
        val previous = (12..15).map { pressed(it) }
        change()
        return (12..15).filter { pressed(it) && !previous[it - 12] }
    }

    fun reset() { keys.fill(false); hats.fill(false) }
}
