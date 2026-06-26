import AVFoundation

/// Configures the shared AVAudioSession for half-duplex radio voice: speakerphone
/// by default, voice-chat mode (echo cancellation), allow Bluetooth headsets.
///
/// Mode is `.voiceChat` (Apple's voice-processing I/O). An earlier attempt to use
/// `.default` to make RX louder regressed incoming audio — it garbled and dropped
/// frames, because the playback engine + inbound jitter buffer rely on the
/// voice-processing I/O's fixed 16 kHz clock/buffering. RX integrity wins over
/// loudness, so `.voiceChat` stays; the volume work is handled separately without
/// touching the playback path.
///
/// `configureForListen()` is the opt-in "media-style" alternative (Settings →
/// Audio → Media Audio Mode): a `.playback` session used WHILE ONLY MONITORING
/// so iOS no longer treats the app as an ongoing phone call. `VoiceAudio` swaps
/// to `configureForVoice()` for the duration of each transmission and back. The
/// always-on path (`configureForVoice()` held for the whole session) remains the
/// default precisely because it sidesteps the 16 kHz→48 kHz resample the
/// `.playback` listen path has to do.
enum AudioSessionManager {
    static func configureForVoice() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            // `.allowBluetooth` is technically deprecated in favour of
            // `.allowBluetoothHFP`, but that symbol isn't in the iOS 16 SDK this
            // project builds against, so keep the working spelling. The
            // deprecation warning is cosmetic.
            options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
        )
        try session.setActive(true, options: [])
        applyRoute(SettingsStore.shared.audioRoute)
    }

    /// Media-style listen session for `mediaListenMode`: `.playback` opens NO
    /// input, so iOS shows no mic-in-use indicator and the app isn't treated as a
    /// live call while the operator is only monitoring. RX plays at full media
    /// loudness through the current output route (speaker, or A2DP Bluetooth /
    /// wired headphones when connected). The mic-bearing `.playAndRecord` session
    /// is restored by `configureForVoice()` for the length of each transmission.
    ///
    /// Earpiece routing isn't honored here — `overrideOutputAudioPort(.speaker)`
    /// and receiver routing are `.playAndRecord` concepts — so `.playback` always
    /// uses the loud route, which is what we want for hands-off monitoring anyway.
    static func configureForListen() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playback,
            mode: .default,
            // A2DP so incoming voice reaches Bluetooth headphones / a car stereo;
            // no HFP mic profile is needed because `.playback` never opens input.
            options: [.allowBluetoothA2DP]
        )
        try session.setActive(true, options: [])
    }

    static func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    static func applyRoute(_ route: SettingsStore.AudioRoute) {
        let session = AVAudioSession.sharedInstance()
        switch route {
        case .auto, .earpiece:
            try? session.overrideOutputAudioPort(.none)
        case .speaker:
            try? session.overrideOutputAudioPort(.speaker)
        case .bluetooth:
            let btTypes: Set<AVAudioSession.Port> = [.bluetoothHFP, .bluetoothLE, .bluetoothA2DP]
            if let input = session.availableInputs?.first(where: { btTypes.contains($0.portType) }) {
                try? session.setPreferredInput(input)
            }
            try? session.overrideOutputAudioPort(.none)
        }
    }

    /// iOS 16-compatible record-permission request.
    static func requestRecordPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }
}
