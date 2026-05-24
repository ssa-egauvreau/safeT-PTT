import AVFoundation
import Foundation

/// Plays a downloaded transmission WAV. One playback at a time — selecting a
/// new transmission stops the previous one. Held by `TranscriptionsScreen`
/// for the lifetime of the view.
///
/// Uses `AVAudioPlayer(data:)` rather than a temp file — the WAVs are small
/// (typically &lt;500 KB for a 20-second talk-spurt) and keeping it in-memory
/// keeps the playback path simple. Plays on the shared `AVAudioSession`,
/// which is fine because the live voice engine and transmission playback
/// are mutually exclusive in practice (you don't review past traffic while
/// keyed up).
@MainActor
final class TranscriptionPlayer: ObservableObject {
    @Published private(set) var playingId: Int?

    private var player: AVAudioPlayer?
    private var delegate: PlayerDelegate?

    func play(id: Int, data: Data) {
        stop()
        do {
            let p = try AVAudioPlayer(data: data)
            let d = PlayerDelegate { [weak self] in
                Task { @MainActor in self?.playingId = nil }
            }
            p.delegate = d
            p.prepareToPlay()
            p.play()
            player = p
            delegate = d
            playingId = id
        } catch {
            playingId = nil
        }
    }

    func stop() {
        player?.stop()
        player = nil
        delegate = nil
        playingId = nil
    }

    /// AVAudioPlayer's delegate isn't Sendable — wrap it so we can hop back
    /// to the main actor when playback finishes.
    private final class PlayerDelegate: NSObject, AVAudioPlayerDelegate {
        let onFinish: () -> Void
        init(_ onFinish: @escaping () -> Void) { self.onFinish = onFinish }
        func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully _: Bool) {
            onFinish()
        }
    }
}
