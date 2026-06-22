import Foundation

/// Cross-platform voice / air timing (keep in sync with `docs/voice-timing.md`).
enum VoiceTiming {
    /// Server `/v1/air` TTL when `release_air` is not sent.
    static let voiceAirTtlMs = 900
    /// Gap between inbound voice frames that starts a new talk-spurt.
    static let talkSpurtGapSeconds: TimeInterval = 0.3
    /// Android PTT hold air probe.
    static let airPollWhilePttSeconds: TimeInterval = 0.25
    /// Default talk-activity poll (idle).
    static let talkActivityPollSeconds: TimeInterval = 1.2
    /// Faster talk-activity poll while someone appears on air or PTT held.
    static let talkActivityFastPollSeconds: TimeInterval = 0.4
    static let inboxPollSeconds: TimeInterval = 2.0
    /// Faster inbox cadence while the AI-dispatcher cue is live, so the
    /// thinking → speaking transition and her reply text update fluidly instead
    /// of stepping on the 2 s idle poll. Drops back to `inboxPollSeconds` when idle.
    static let inboxFastPollSeconds: TimeInterval = 0.6
    static let catalogPollSeconds: TimeInterval = 15.0
    static let presencePollSeconds: TimeInterval = 12.0

    /// Exponential backoff for WebSocket reconnect, in seconds.
    /// Attempt 1 returns 1, attempt 2 returns 2, capped at `cap`.
    static func backoffDelaySeconds(attempt: Int, cap: Double) -> Double {
        min(pow(2.0, Double(max(0, attempt - 1))), cap)
    }
}
