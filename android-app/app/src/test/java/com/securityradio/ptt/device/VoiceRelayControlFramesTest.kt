package com.securityradio.ptt.device

import org.junit.Assert.assertEquals
import org.junit.Test

/** Wire-format guards for half-duplex control frames (parity with server + web). */
class VoiceRelayControlFramesTest {
    @Test
    fun releaseAirJson_matchesRelayProtocol() {
        assertEquals("""{"type":"release_air"}""", VoiceRelayTransport.RELEASE_AIR_JSON)
    }
}
