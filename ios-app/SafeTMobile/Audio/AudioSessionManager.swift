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
enum AudioSessionManager {
    static func configureForVoice() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP]
        )
        try session.setActive(true, options: [])
        applyRoute(SettingsStore.shared.audioRoute)
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
