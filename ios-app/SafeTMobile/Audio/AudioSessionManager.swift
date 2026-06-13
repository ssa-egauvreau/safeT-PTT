import AVFoundation
import os

/// Manages the shared AVAudioSession for half-duplex radio voice, switching
/// category by phase so the volume buttons control the **media** volume (speaker
/// icon, loud) while listening instead of the **call** volume (phone icon, quiet)
/// that `.playAndRecord` forces continuously:
///
/// - `configureForPlayback()` — RX / idle. `.playback`, media-volume bus.
/// - `configureForTransmit()` — PTT held. `.playAndRecord` + `.voiceChat` for the
///   mic; the call-volume bus is fine here because the operator is talking.
///
/// Every transition is logged (subsystem `com.safetptt.mobile`, category
/// `audiosession`) so a regression is traceable from the device console.
enum AudioSessionManager {
    private static let logger = Logger(subsystem: "com.safetptt.mobile", category: "audiosession")

    /// Listening / idle: media-volume playback. Speaker icon, full volume.
    static func configureForPlayback() throws {
        let session = AVAudioSession.sharedInstance()
        do {
            // NOTE: .allowAirPlay is ONLY valid with .playAndRecord — including it
            // here makes setCategory fail with OSStatus -50, which silently kills
            // the playback session (and thus all RX audio). Keep options minimal.
            try session.setCategory(.playback, mode: .default, options: [.allowBluetoothA2DP])
            try session.setActive(true, options: [])
            applyRoute(SettingsStore.shared.audioRoute)
            logger.log("session -> playback OK (media volume)")
        } catch {
            logger.error("session -> playback FAILED: \(error.localizedDescription, privacy: .public)")
            throw error
        }
    }

    /// Transmitting: record + play with voice processing for the mic.
    static func configureForTransmit() throws {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat,
                                    options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP])
            try session.setActive(true, options: [])
            applyRoute(SettingsStore.shared.audioRoute)
            logger.log("session -> transmit OK (playAndRecord/voiceChat)")
        } catch {
            logger.error("session -> transmit FAILED: \(error.localizedDescription, privacy: .public)")
            throw error
        }
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
