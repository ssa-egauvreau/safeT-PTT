import AVFoundation

/// Configures the shared AVAudioSession for half-duplex radio voice: speakerphone
/// by default, allow Bluetooth headsets.
///
/// Mode is `.default`, NOT `.voiceChat`. `.voiceChat` routes through Apple's
/// voice-processing I/O, which ties output to the *call* volume bus and applies
/// telephony-style AGC — the "quiet even at full volume, like a phone call"
/// symptom operators reported. `.default` keeps RX on the media volume bus so it
/// plays at full speaker level. PTT is half-duplex (we don't play and capture at
/// the same instant) and the uplink already runs `ImbeTxConditioner`, so the
/// system echo-cancellation `.voiceChat` provided isn't needed.
enum AudioSessionManager {
    static func configureForVoice() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .default,
            options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP]
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
