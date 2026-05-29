import XCTest
@testable import SafeTMobile

/// Regression coverage for the PTT capture-session gate added in
/// "ios: gate uplink frames by capture session" (PR #152).
///
/// The gate exists to prevent a class of bugs where a delayed uplink frame
/// from a prior PTT key-up arrives on the main actor *after* `stopCapture`
/// has run, sneaks past `resetUplinkState()`, and either leaks a stale IMBE
/// tail into the next transmission or — worse — keeps the previous talker's
/// PCM accumulating into `pcmAcc` while the user is no longer keyed up.
///
/// The hardware audio path (AVAudioEngine, P25 native vocoder, URLSession
/// WebSocket) is intentionally NOT exercised here — those are integration
/// surfaces and would make the tests environment-dependent. We focus on the
/// session-id state machine that owns the gating decision, which is the
/// piece that actually changed.
@MainActor
final class VoiceTransportSessionGatingTests: XCTestCase {
    private let baseURL = URL(string: "wss://radio.example.com")!

    private func makeTransport() -> VoiceTransport {
        // VoiceAudio's initializer only wires AVAudioEngine nodes; it does
        // not start the engine or activate the audio session, so it is safe
        // to construct in a unit-test bundle without a real mic route.
        let audio = VoiceAudio()
        let session = URLSession(configuration: .ephemeral)
        return VoiceTransport(
            baseURL: baseURL,
            token: "test-token",
            unitId: "TEST01",
            audio: audio,
            session: session
        )
    }

    // MARK: - start/stopUplinkCapture state machine

    func test_freshTransport_hasNoActiveCaptureSession() {
        let transport = makeTransport()
        XCTAssertNil(transport.activeCaptureSessionId)
    }

    func test_startUplinkCapture_armsTheProvidedSessionId() {
        let transport = makeTransport()
        transport.startUplinkCapture(sessionId: 42)
        XCTAssertEqual(transport.activeCaptureSessionId, 42)
    }

    func test_startUplinkCapture_replacesAnyPriorSessionId() {
        // Simulates two successive PTT cycles where VoiceAudio.startCapture()
        // bumps the session id between them. The new id MUST take over so
        // late frames from the prior cycle stop being accepted.
        let transport = makeTransport()
        transport.startUplinkCapture(sessionId: 1)
        transport.startUplinkCapture(sessionId: 2)
        XCTAssertEqual(transport.activeCaptureSessionId, 2)
    }

    func test_stopUplinkCapture_clearsActiveSessionId() {
        let transport = makeTransport()
        transport.startUplinkCapture(sessionId: 7)
        transport.stopUplinkCapture()
        XCTAssertNil(transport.activeCaptureSessionId)
    }

    func test_stopUplinkCapture_isIdempotent_whenNothingArmed() {
        let transport = makeTransport()
        // Should not crash or leave the field in a weird state.
        transport.stopUplinkCapture()
        transport.stopUplinkCapture()
        XCTAssertNil(transport.activeCaptureSessionId)
    }

    func test_disconnect_clearsActiveSessionId_evenWithoutJoin() {
        // disconnect() must scrub the session id so a stale frame queued
        // before the socket tear-down cannot be admitted on the next
        // openSocket()/join() cycle.
        let transport = makeTransport()
        transport.startUplinkCapture(sessionId: 99)
        transport.disconnect()
        XCTAssertNil(transport.activeCaptureSessionId)
    }

    // MARK: - resetUplinkState() does NOT change gate ownership

    func test_resetUplinkState_doesNotClearActiveSessionId() {
        // resetUplinkState() flushes the PCM accumulator and the IMBE
        // conditioner for the *current* talkspurt — it is called every
        // time `startUplinkCapture` arms a new session and must therefore
        // leave the just-armed session id intact.
        let transport = makeTransport()
        transport.startUplinkCapture(sessionId: 12345)
        transport.resetUplinkState()
        XCTAssertEqual(transport.activeCaptureSessionId, 12345)
    }

    // MARK: - UInt64 boundary behaviour matches VoiceAudio's id generator

    func test_releaseAirJson_matchesRelayProtocol() {
        XCTAssertEqual(VoiceTransport.releaseAirJSON, "{\"type\":\"release_air\"}")
    }

    func test_stopUplinkCapture_sendsReleaseAirWithoutCrashingWhenSocketClosed() {
        let transport = makeTransport()
        transport.startUplinkCapture(sessionId: 1)
        transport.stopUplinkCapture()
        XCTAssertNil(transport.activeCaptureSessionId)
    }

    func test_activeCaptureSessionId_acceptsUInt64Max() {
        // VoiceAudio increments `captureSessionId &+= 1` (wrapping). The
        // gate stores the raw UInt64 — verify the maximum boundary round
        // trips so a wrap-around never silently zeros the gate.
        let transport = makeTransport()
        transport.startUplinkCapture(sessionId: UInt64.max)
        XCTAssertEqual(transport.activeCaptureSessionId, UInt64.max)
    }
}
