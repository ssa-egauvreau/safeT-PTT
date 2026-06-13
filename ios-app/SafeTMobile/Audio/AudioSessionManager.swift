import AVFoundation

/// Manages the shared AVAudioSession for half-duplex radio voice. We switch
/// category by phase so the volume buttons control the *media* volume (speaker
/// icon) while listening, instead of the *call* volume (phone icon) that
/// `.playAndRecord` forces the whole time:
///
/// - `configureForPlayback()` — RX / idle. `.playback` keeps incoming audio on
///   the media-volume bus (loud, speaker icon). No mic.
/// - `configureForTransmit()` — PTT held. `.playAndRecord` + `.voiceChat`
///   (echo cancellation, speakerphone, Bluetooth) to capture the mic. The
///   call-volume bus is fine here — the operator is talking, not listening.
///
/// `VoiceAudio` rebuilds its engine across the switch; the permit beep masks the
/// brief reconfiguration so the operator never keys into dead air.
enum AudioSessionManager {
    /// Listening / idle: media-volume playback. Speaker icon, full volume.
    static func configureForPlayback() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playback,
            mode: .default,
            options: [.allowBluetoothA2DP, .allowAirPlay]
        )
        try session.setActive(true, options: [])
        applyRoute(SettingsStore.shared.audioRoute)
    }

    /// Transmitting: record + play with voice processing for the mic.
    static func configureForTransmit() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
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
