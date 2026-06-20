package com.securityradio.ptt.device

/** Output pan for a voice playout buffer. */
enum class StereoPan {
    /** Mono output — write samples as-is to a mono AudioTrack. */
    NONE,

    /** Hard-pan to the left ear (stereo output, right channel silent). */
    LEFT,

    /** Hard-pan to the right ear (stereo output, left channel silent). */
    RIGHT,
}
