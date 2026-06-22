import AVFoundation
import Foundation

/// Plays the four bundled radio UI sounds (channel switch, PTT permit, busy
/// alert, emergency alert). Mirrors a subset of the Android `RadioUiSoundPlayer`
/// surface so the same UX cues fire on both platforms.
///
/// Plays via `AVAudioPlayer` on the shared audio session — does NOT touch the
/// AVAudioEngine that `VoiceAudio` owns, so a sound and a live PTT transmission
/// can coexist without interrupting each other. Each sound has its own player
/// instance so overlapping triggers (e.g. busy beep while emergency is firing)
/// don't cut each other off.
@MainActor
final class RadioSounds {
    /// Bundled WAVs that ship in SafeTMobile/Resources/Sounds/. Filenames must
    /// match what XcodeGen puts in the .app bundle.
    enum Cue: String, CaseIterable {
        case channelSwitch = "channel_switch"
        case pttPermit = "ptt_permit"
        case busy = "busy"
        case emergency = "emergency"
        /// Distinct two-tone chirp for an incoming page/message (so it isn't
        /// confused with the channel-switch blip it used to share).
        case page = "page"
        /// Rising chime confirming an action succeeded (page sent, key saved).
        case success = "success"
        /// Low descending blip signalling a failed action (send failed, etc.).
        case error = "error"
    }

    /// One pre-loaded AVAudioPlayer per cue so playback starts with zero
    /// decode latency. Created lazily on first use of each cue.
    private var players: [Cue: AVAudioPlayer] = [:]

    /// Play the cue once. No-op if the asset is missing from the bundle (logged
    /// but not crashed — radio UX shouldn't fail on a missing chime).
    /// Emergency alerts always play regardless of the notification-sounds setting.
    func play(_ cue: Cue) {
        guard cue == .emergency || SettingsStore.shared.notificationSoundsEnabled else { return }
        guard let player = player(for: cue) else { return }
        if player.isPlaying { player.currentTime = 0 }
        player.play()
    }

    /// Stop a cue mid-playback. Safe to call when the cue isn't playing.
    func stop(_ cue: Cue) {
        players[cue]?.stop()
    }

    private func player(for cue: Cue) -> AVAudioPlayer? {
        if let existing = players[cue] { return existing }
        guard let url = Bundle.main.url(forResource: cue.rawValue, withExtension: "wav") else {
            return nil
        }
        let player: AVAudioPlayer
        do {
            player = try AVAudioPlayer(contentsOf: url)
        } catch {
            return nil
        }
        player.prepareToPlay()
        players[cue] = player
        return player
    }
}
