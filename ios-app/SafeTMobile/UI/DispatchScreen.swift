import AVFoundation
import SwiftUI

/// Operator-only console: toggle the 10-33 (emergency-traffic) marker per
/// channel and preview agency soundboard tones. Gated behind the user's
/// role at the navigation entry point in RadioScreen — this view assumes
/// the caller has dispatcher or admin role on the server side.
///
/// Tone playback is currently LOCAL preview only — there is no server-side
/// endpoint to broadcast a tone to all radios on a channel. The list and
/// preview exist so dispatchers can audition the library; broadcasting is
/// a follow-up that needs a new server endpoint first.
struct DispatchScreen: View {
    let api: RadioApiClient

    @State private var channels: [String] = []
    @State private var channelsError: String?
    /// Tri-state per channel — `nil` here means "fetch hasn't completed",
    /// `.failed` means the GET errored and we don't know the real state,
    /// `.known(Bool)` is the server's last successful answer. Without this
    /// distinction, a failed status read silently rendered as NORMAL TRAFFIC
    /// even when the channel actually had 10-33 ACTIVE — operationally unsafe.
    @State private var ten33: [String: Ten33Cell] = [:]
    @State private var ten33Loading: Set<String> = []
    @State private var ten33Error: String?

    enum Ten33Cell: Equatable {
        case known(Bool)
        case failed
    }

    @State private var toneOuts: [ToneOut] = []
    @State private var toneOutsLoading = false
    @State private var toneOutsError: String?

    @State private var nowPlayingId: Int?
    @State private var loadingAudioId: Int?
    @State private var previewPlayer: AVAudioPlayer?
    @State private var previewDelegate: PreviewDelegate?

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                ten33Section
                toneOutsSection
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 14)
        }
        .background(Color.safetBackground.ignoresSafeArea())
        .navigationTitle("DISPATCH")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await refreshChannels()
            await refreshTen33All()
            await refreshToneOuts()
        }
        .refreshable {
            await refreshChannels()
            await refreshTen33All()
            await refreshToneOuts()
        }
    }

    private func refreshChannels() async {
        do {
            channels = try await api.channels().map(\.name)
            channelsError = nil
        } catch {
            channelsError = "Channel list failed: \(error)"
        }
    }

    // MARK: - 10-33 section

    private var ten33Section: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader("10-33 EMERGENCY TRAFFIC")
            if let ten33Error {
                Text(ten33Error)
                    .font(.system(size: 10, weight: .heavy, design: .monospaced))
                    .foregroundColor(.safetRed)
            }
            // Surface channel-list load failures BEFORE the empty-state text.
            // Previously a /me/channels failure rendered "NO CHANNELS" — telling
            // operators there were no channels rather than that the load failed
            // could drive incorrect dispatch decisions.
            if let channelsError {
                Text(channelsError)
                    .font(.system(size: 10, weight: .heavy, design: .monospaced))
                    .foregroundColor(.safetRed)
            } else if channels.isEmpty {
                Text("NO CHANNELS")
                    .font(.system(size: 11, weight: .heavy, design: .monospaced))
                    .foregroundColor(.safetTextDim)
            } else {
                VStack(spacing: 6) {
                    ForEach(channels, id: \.self) { channel in
                        ten33Row(channel: channel)
                    }
                }
            }
        }
    }

    private func ten33Row(channel: String) -> some View {
        let cell = ten33[channel]
        let busy = ten33Loading.contains(channel)
        let isActive: Bool = {
            if case .known(let on) = cell { return on } else { return false }
        }()
        let isUnknown = cell == .failed
        return HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(channel)
                    .font(.system(size: 13, weight: .heavy, design: .monospaced))
                    .foregroundColor(.safetText)
                Text(statusLabel(for: cell))
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundColor(statusColor(for: cell))
            }
            Spacer()
            if busy {
                ProgressView().tint(.safetText)
            } else if isUnknown {
                // Don't expose a toggle when we don't trust our local state —
                // flipping it would POST a value that could silently overwrite
                // a real on-channel 10-33 we haven't read yet. Offer a refresh
                // instead so the operator can re-query and unblock the toggle.
                Button {
                    Task { await refreshTen33All() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(.safetAmber)
                }
            } else {
                Toggle(
                    "",
                    isOn: Binding(
                        get: { isActive },
                        // Explicit `newValue in` — the prior `$0` shorthand
                        // wrapped in a nested Task made Swift infer a
                        // 0-argument closure for the binding setter, producing
                        // a contextual-signature mismatch under Xcode 16.
                        set: { newValue in
                            Task { await setTen33(channel: channel, active: newValue) }
                        }
                    )
                )
                .labelsHidden()
                .tint(.safetRed)
            }
        }
        .padding(12)
        .background(rowBackground(for: cell))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(rowBorder(for: cell), lineWidth: 1))
        .cornerRadius(8)
    }

    private func statusLabel(for cell: Ten33Cell?) -> String {
        switch cell {
        case .known(true): return "10-33 ACTIVE"
        case .known(false): return "NORMAL TRAFFIC"
        case .failed: return "STATUS UNKNOWN — TAP ⟳"
        case .none: return "LOADING…"
        }
    }

    private func statusColor(for cell: Ten33Cell?) -> Color {
        switch cell {
        case .known(true): return .safetRed
        case .known(false): return .safetTextDim
        case .failed: return .safetAmber
        case .none: return .safetTextDim
        }
    }

    private func rowBackground(for cell: Ten33Cell?) -> Color {
        switch cell {
        case .known(true): return Color.safetRed.opacity(0.12)
        case .failed: return Color.safetAmber.opacity(0.10)
        default: return Color.safetSurface
        }
    }

    private func rowBorder(for cell: Ten33Cell?) -> Color {
        switch cell {
        case .known(true): return .safetRed
        case .failed: return .safetAmber
        default: return .safetBorder
        }
    }

    // MARK: - tone-outs section

    private var toneOutsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader("TONE-OUTS (PREVIEW)")
            Text("Tap to audition. Broadcast to channel not yet supported.")
                .font(.system(size: 10))
                .foregroundColor(.safetTextDim)
                .padding(.bottom, 4)
            if toneOutsLoading && toneOuts.isEmpty {
                ProgressView().tint(.safetText).frame(maxWidth: .infinity).padding(.vertical, 24)
            } else if let toneOutsError, toneOuts.isEmpty {
                Text(toneOutsError)
                    .font(.system(size: 10, weight: .heavy, design: .monospaced))
                    .foregroundColor(.safetRed)
            } else if toneOuts.isEmpty {
                Text("NO TONE-OUTS CONFIGURED")
                    .font(.system(size: 11, weight: .heavy, design: .monospaced))
                    .foregroundColor(.safetTextDim)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 8)], spacing: 8) {
                    ForEach(toneOuts) { tone in
                        toneTile(tone)
                    }
                }
            }
        }
    }

    private func toneTile(_ tone: ToneOut) -> some View {
        let isPlaying = nowPlayingId == tone.id
        let isLoading = loadingAudioId == tone.id
        return Button {
            handleToneTap(tone)
        } label: {
            VStack(spacing: 6) {
                if isLoading {
                    ProgressView().tint(.safetText).frame(width: 32, height: 32)
                } else {
                    Image(systemName: isPlaying ? "stop.circle.fill" : "speaker.wave.2.circle.fill")
                        .resizable()
                        .frame(width: 32, height: 32)
                        .foregroundColor(isPlaying ? .safetRed : .safetGreen)
                }
                Text(tone.name)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(.safetText)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, minHeight: 84)
            .padding(8)
            .background(Color.safetSurface)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.safetBorder, lineWidth: 1))
            .cornerRadius(8)
        }
        .buttonStyle(.plain)
        .disabled(!tone.hasAudio)
        .opacity(tone.hasAudio ? 1 : 0.5)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .heavy, design: .monospaced))
            .foregroundColor(.safetTextDim)
            .padding(.horizontal, 2)
    }

    // MARK: - actions

    private func setTen33(channel: String, active: Bool) async {
        ten33Loading.insert(channel)
        defer { ten33Loading.remove(channel) }
        let previous = ten33[channel]
        ten33[channel] = .known(active) // optimistic
        do {
            try await api.setTen33(channel: channel, active: active)
            ten33Error = nil
        } catch {
            ten33[channel] = previous // rollback (including back to .failed if it was unknown)
            ten33Error = "10-33 \(active ? "set" : "clear") failed: \(error)"
        }
    }

    private func refreshTen33All() async {
        await withTaskGroup(of: (String, Ten33Cell).self) { group in
            for channel in channels {
                group.addTask {
                    do {
                        let active = try await api.ten33Status(channel: channel)
                        return (channel, .known(active))
                    } catch {
                        // Mark explicitly as failed — without this the row
                        // would silently render NORMAL TRAFFIC even if the
                        // channel actually had 10-33 active server-side.
                        return (channel, .failed)
                    }
                }
            }
            for await (channel, cell) in group {
                ten33[channel] = cell
            }
        }
    }

    private func refreshToneOuts() async {
        toneOutsLoading = true
        defer { toneOutsLoading = false }
        do {
            toneOuts = try await api.toneOuts()
            toneOutsError = nil
        } catch {
            toneOutsError = "Tone-outs failed: \(error)"
        }
    }

    private func handleToneTap(_ tone: ToneOut) {
        if nowPlayingId == tone.id {
            stopPreview()
            return
        }
        Task { await loadAndPlayPreview(tone) }
    }

    private func loadAndPlayPreview(_ tone: ToneOut) async {
        loadingAudioId = tone.id
        defer { loadingAudioId = nil }
        do {
            let data = try await api.toneOutAudio(id: tone.id)
            stopPreview()
            let player = try AVAudioPlayer(data: data)
            let delegate = PreviewDelegate { Task { @MainActor in nowPlayingId = nil } }
            player.delegate = delegate
            player.prepareToPlay()
            player.play()
            previewPlayer = player
            previewDelegate = delegate
            nowPlayingId = tone.id
        } catch {
            toneOutsError = "Couldn't preview: \(error.localizedDescription)"
        }
    }

    private func stopPreview() {
        previewPlayer?.stop()
        previewPlayer = nil
        previewDelegate = nil
        nowPlayingId = nil
    }

    private final class PreviewDelegate: NSObject, AVAudioPlayerDelegate {
        let onFinish: () -> Void
        init(_ onFinish: @escaping () -> Void) { self.onFinish = onFinish }
        func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully _: Bool) {
            onFinish()
        }
    }
}
