import SwiftUI

/// Browse + search recent recorded transmissions and play back the WAV.
/// Backed by `GET /v1/transmissions` with full server-side filtering
/// (channel / user / from / to / search) and `GET /v1/transmissions/:id/audio`
/// for playback.
///
/// Reloads on appear, pull-to-refresh, and any filter change. No live polling
/// — operators review past traffic episodically, so a manual refresh model is
/// enough and keeps battery / data usage down. Pagination is "fetch a bigger
/// page": server caps `limit` at 500, so the "Load more" button bumps the
/// current limit by 100 each press up to the cap.
struct TranscriptionsScreen: View {
    let api: RadioApiClient

    @StateObject private var player = TranscriptionPlayer()
    @State private var transmissions: [Transmission] = []
    @State private var search = ""
    @State private var loading = false
    @State private var error: String?
    @State private var loadingAudioId: Int?

    // MARK: - filters
    @State private var filterChannel: String?
    @State private var filterUnit: String = ""
    @State private var filterFrom: Date?
    @State private var filterTo: Date?
    /// Channels available to filter on — fetched once on appear from /me/channels.
    @State private var availableChannels: [String] = []
    /// Which filter editor sheet is currently open (nil = none).
    @State private var openEditor: FilterEditor?

    enum FilterEditor: String, Identifiable {
        case channel, unit, from, to
        var id: String { rawValue }
    }

    // MARK: - pagination
    /// Server cap is 500; we start at 200 (vs the old hard-coded 80 that left
    /// operators stuck when transmissions exceeded that count).
    @State private var limit: Int = 200
    private static let pageStep: Int = 100
    private static let maxLimit: Int = 500

    /// Debounce the search input so we don't fire a request on every keystroke.
    @State private var searchTask: Task<Void, Never>?
    /// Current in-flight reload — tracked so a fresh search query can cancel
    /// the stale one. Without this, a slow response for an older query could
    /// overwrite newer results.
    @State private var reloadTask: Task<Void, Never>?
    /// Current in-flight audio fetch — tracked so a second row tap cancels the
    /// first. Otherwise a slow download for row A could finish after row B's
    /// quick one and unexpectedly switch playback back to A.
    @State private var audioFetchTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            searchBar
            filterBar
            content
        }
        .background(Color.safetBackground.ignoresSafeArea())
        .navigationTitle("TRANSCRIPTS")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await refreshAvailableChannels()
            await reload()
        }
        .onDisappear {
            // Cancel any in-flight network work and stop playback so dismissing
            // the sheet mid-fetch doesn't trigger player.play() off-screen or
            // leak audio after the screen is gone.
            audioFetchTask?.cancel()
            audioFetchTask = nil
            reloadTask?.cancel()
            reloadTask = nil
            searchTask?.cancel()
            searchTask = nil
            player.stop()
        }
        .sheet(item: $openEditor) { editor in
            NavigationStack { filterEditorSheet(editor) }
                .presentationDetents([.medium])
                .preferredColorScheme(.dark)
        }
    }

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundColor(.safetTextDim)
            TextField("Search transcript text", text: $search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundColor(.safetText)
                .onChange(of: search) { _ in scheduleSearch() }
            if !search.isEmpty {
                Button {
                    search = ""
                    scheduleSearch()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.safetTextDim)
                }
            }
        }
        .padding(10)
        .background(Color.safetSurface)
        .overlay(Rectangle().frame(height: 1).foregroundColor(.safetBorder), alignment: .bottom)
    }

    /// Horizontal scrolling row of filter chips. Each chip is tappable and
    /// opens a sheet with the relevant editor. Active filters show their value
    /// inline with a red border; unset filters show "CHANNEL", "UNIT", etc.
    /// in dim color. A "Clear" button appears whenever any filter is set.
    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                filterChip(
                    label: filterChannel ?? "CHANNEL",
                    isActive: filterChannel != nil,
                    icon: "antenna.radiowaves.left.and.right"
                ) { openEditor = .channel }
                filterChip(
                    label: filterUnit.isEmpty ? "UNIT" : filterUnit,
                    isActive: !filterUnit.isEmpty,
                    icon: "person.fill"
                ) { openEditor = .unit }
                filterChip(
                    label: filterFrom.map { "FROM \(shortDate($0))" } ?? "FROM",
                    isActive: filterFrom != nil,
                    icon: "calendar"
                ) { openEditor = .from }
                filterChip(
                    label: filterTo.map { "TO \(shortDate($0))" } ?? "TO",
                    isActive: filterTo != nil,
                    icon: "calendar"
                ) { openEditor = .to }
                if anyFilterSet {
                    Button {
                        clearFilters()
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 10, weight: .bold))
                            Text("CLEAR")
                                .font(.system(size: 10, weight: .heavy, design: .monospaced))
                        }
                        .foregroundColor(.safetRed)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        .background(Color.safetBackground)
        .overlay(Rectangle().frame(height: 1).foregroundColor(.safetBorder), alignment: .bottom)
    }

    private func filterChip(
        label: String,
        isActive: Bool,
        icon: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .bold))
                Text(label)
                    .font(.system(size: 10, weight: .heavy, design: .monospaced))
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
            }
            .foregroundColor(isActive ? .safetRed : .safetTextDim)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .overlay(Capsule().stroke(isActive ? Color.safetRed : Color.safetBorder, lineWidth: 1))
        }
    }

    private var anyFilterSet: Bool {
        filterChannel != nil || !filterUnit.isEmpty || filterFrom != nil || filterTo != nil
    }

    private func clearFilters() {
        filterChannel = nil
        filterUnit = ""
        filterFrom = nil
        filterTo = nil
        Task { await reload() }
    }

    // MARK: - filter editor sheet

    @ViewBuilder
    private func filterEditorSheet(_ editor: FilterEditor) -> some View {
        switch editor {
        case .channel: channelPicker
        case .unit: unitPicker
        case .from: datePicker(title: "FROM", binding: $filterFrom)
        case .to: datePicker(title: "TO", binding: $filterTo)
        }
    }

    private var channelPicker: some View {
        List {
            Button {
                filterChannel = nil
                openEditor = nil
                Task { await reload() }
            } label: {
                HStack {
                    Text("ANY CHANNEL")
                        .font(.system(size: 13, weight: .heavy, design: .monospaced))
                        .foregroundColor(filterChannel == nil ? .safetRed : .safetText)
                    Spacer()
                    if filterChannel == nil {
                        Image(systemName: "checkmark").foregroundColor(.safetRed)
                    }
                }
            }
            ForEach(availableChannels, id: \.self) { ch in
                Button {
                    filterChannel = ch
                    openEditor = nil
                    Task { await reload() }
                } label: {
                    HStack {
                        Text(ch)
                            .font(.system(size: 13, weight: .heavy, design: .monospaced))
                            .foregroundColor(filterChannel == ch ? .safetRed : .safetText)
                        Spacer()
                        if filterChannel == ch {
                            Image(systemName: "checkmark").foregroundColor(.safetRed)
                        }
                    }
                }
            }
        }
        .navigationTitle("CHANNEL")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("DONE") { openEditor = nil }
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(.safetText)
            }
        }
    }

    private var unitPicker: some View {
        VStack(spacing: 16) {
            Text("Filter by exact unit ID (e.g. K12, UNIT4). Case-insensitive.")
                .font(.system(size: 11))
                .foregroundColor(.safetTextDim)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            TextField("UNIT ID", text: $filterUnit)
                .font(.system(size: 16, weight: .heavy, design: .monospaced))
                .multilineTextAlignment(.center)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .padding(12)
                .background(Color.safetSurface)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.safetBorder, lineWidth: 1))
                .cornerRadius(8)
                .padding(.horizontal, 16)
            HStack(spacing: 12) {
                Button("CLEAR") {
                    filterUnit = ""
                    openEditor = nil
                    Task { await reload() }
                }
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(.safetTextDim)
                Spacer()
                Button("APPLY") {
                    openEditor = nil
                    Task { await reload() }
                }
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(.safetRed)
            }
            .padding(.horizontal, 24)
            Spacer()
        }
        .padding(.top, 20)
        .navigationTitle("UNIT")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func datePicker(title: String, binding: Binding<Date?>) -> some View {
        // Wrap an optional Date in a non-optional binding for DatePicker;
        // default to "now" when picking starts, then commit on APPLY.
        let dateBinding = Binding<Date>(
            get: { binding.wrappedValue ?? Date() },
            set: { binding.wrappedValue = $0 }
        )
        return VStack(spacing: 12) {
            DatePicker(
                "",
                selection: dateBinding,
                displayedComponents: [.date, .hourAndMinute]
            )
            .datePickerStyle(.wheel)
            .labelsHidden()
            HStack(spacing: 12) {
                Button("CLEAR") {
                    binding.wrappedValue = nil
                    openEditor = nil
                    Task { await reload() }
                }
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(.safetTextDim)
                Spacer()
                Button("APPLY") {
                    if binding.wrappedValue == nil { binding.wrappedValue = Date() }
                    openEditor = nil
                    Task { await reload() }
                }
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(.safetRed)
            }
            .padding(.horizontal, 24)
            Spacer()
        }
        .padding(.top, 8)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private var content: some View {
        if loading && transmissions.isEmpty {
            ProgressView()
                .tint(.safetText)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error, transmissions.isEmpty {
            VStack(spacing: 12) {
                Text("CAN'T LOAD TRANSCRIPTS")
                    .font(.system(size: 12, weight: .heavy))
                    .foregroundColor(.safetRed)
                Text(error)
                    .font(.system(size: 11))
                    .foregroundColor(.safetTextDim)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                Button("RETRY") { Task { await reload() } }
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(.safetText)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if transmissions.isEmpty {
            Text(search.isEmpty ? "NO RECENT TRANSMISSIONS" : "NO MATCHES")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(.safetTextDim)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            list
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 8) {
                ForEach(transmissions) { tx in
                    row(tx)
                }
                listFooter
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .refreshable { await reload() }
    }

    /// Footer of the list — either a "Load more" button (we're below the cap
    /// AND the last fetch filled the page, suggesting more rows exist) or a
    /// terminal "End of log" stamp. Without this, operators with >200 rows had
    /// no signal that more existed or any way to reach them.
    @ViewBuilder
    private var listFooter: some View {
        if loading && !transmissions.isEmpty {
            ProgressView().tint(.safetText).padding(.vertical, 12)
        } else if transmissions.count >= limit && limit < Self.maxLimit {
            Button {
                Task { await loadMore() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.down.circle.fill")
                    Text("LOAD \(Self.pageStep) MORE")
                        .font(.system(size: 11, weight: .heavy, design: .monospaced))
                }
                .foregroundColor(.safetSignal)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.safetSignal.opacity(0.5), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .padding(.top, 6)
        } else if transmissions.count >= Self.maxLimit {
            Text("SHOWING FIRST \(Self.maxLimit) — NARROW WITH FILTERS")
                .font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundColor(.safetAmber)
                .padding(.vertical, 12)
        } else if !transmissions.isEmpty {
            Text("END OF LOG")
                .font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundColor(.safetTextDim)
                .padding(.vertical, 12)
        }
    }

    private func row(_ tx: Transmission) -> some View {
        let isPlaying = player.playingId == tx.id
        let isLoadingAudio = loadingAudioId == tx.id
        return Button {
            handleTap(tx)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                playIcon(isPlaying: isPlaying, isLoading: isLoadingAudio)
                    .frame(width: 28, height: 28)
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(tx.channelName)
                            .font(.system(size: 11, weight: .heavy, design: .monospaced))
                            .foregroundColor(.safetSignal)
                        Spacer()
                        Text(formatTime(tx.startedAt))
                            .font(.system(size: 10, weight: .semibold, design: .monospaced))
                            .foregroundColor(.safetTextDim)
                    }
                    HStack(spacing: 6) {
                        Text(tx.unitId ?? "?")
                            .font(.system(size: 11, weight: .bold, design: .monospaced))
                            .foregroundColor(.safetText)
                        if let name = tx.displayName, !name.isEmpty {
                            Text("• \(name)")
                                .font(.system(size: 10))
                                .foregroundColor(.safetTextDim)
                        }
                        Spacer()
                        Text(formatDuration(tx.durationMs))
                            .font(.system(size: 10, weight: .semibold, design: .monospaced))
                            .foregroundColor(.safetTextDim)
                    }
                    transcriptLine(tx)
                }
            }
            .padding(10)
            .background(Color.safetSurface)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.safetBorder, lineWidth: 1))
            .cornerRadius(8)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func playIcon(isPlaying: Bool, isLoading: Bool) -> some View {
        if isLoading {
            ProgressView().tint(.safetText)
        } else {
            Image(systemName: isPlaying ? "stop.circle.fill" : "play.circle.fill")
                .resizable()
                .foregroundColor(isPlaying ? .safetRed : .safetGreen)
        }
    }

    @ViewBuilder
    private func transcriptLine(_ tx: Transmission) -> some View {
        switch tx.transcriptStatus {
        case "done":
            if let text = tx.transcript, !text.isEmpty {
                Text(text)
                    .font(.system(size: 12))
                    .foregroundColor(.safetText)
                    .multilineTextAlignment(.leading)
            } else {
                Text("(no speech detected)")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.safetTextDim)
            }
        case "pending":
            Text("TRANSCRIBING…")
                .font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundColor(.safetAmber)
        case "failed":
            // Server emits "failed" when Whisper errored on this clip (not
            // "error" — earlier mapping was wrong, falling into default and
            // rendering nothing).
            Text("TRANSCRIPT FAILED")
                .font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundColor(.safetRed)
        case "disabled":
            // Transcription is globally off for this agency. Operators need
            // to know the silence is intentional, not a missing transcript.
            Text("TRANSCRIPTION OFF")
                .font(.system(size: 10, weight: .heavy, design: .monospaced))
                .foregroundColor(.safetTextDim)
        default:
            // Defensive — should never hit. If the server adds a new status
            // value, render it raw so it's visible in the field instead of
            // silently disappearing.
            Text(tx.transcriptStatus.uppercased())
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundColor(.safetTextDim)
        }
    }

    // MARK: - actions

    private func handleTap(_ tx: Transmission) {
        if player.playingId == tx.id {
            player.stop()
            audioFetchTask?.cancel()
            audioFetchTask = nil
            return
        }
        // Replace any in-flight fetch — the user's latest tap wins. Without
        // this, a slow A-download finishing after a fast B-download would
        // hand back to play() and stomp on the user's actual selection.
        audioFetchTask?.cancel()
        audioFetchTask = Task { await loadAndPlay(tx) }
    }

    private func loadAndPlay(_ tx: Transmission) async {
        loadingAudioId = tx.id
        defer {
            // Only clear the spinner if it's still showing OUR row — a newer
            // fetch may have already taken over.
            if loadingAudioId == tx.id { loadingAudioId = nil }
        }
        do {
            let data = try await api.transmissionAudio(id: tx.id)
            // After the await, the task may have been cancelled (user tapped
            // another row) or the user may have explicitly stopped. Bail in
            // both cases — don't play stale audio.
            guard !Task.isCancelled, loadingAudioId == tx.id else { return }
            player.play(id: tx.id, data: data)
        } catch is CancellationError {
            return
        } catch {
            // URLSession's data(for:) rethrows a URLError(.cancelled) on
            // Task.cancel(); treat it like CancellationError.
            if (error as? URLError)?.code == .cancelled { return }
            self.error = "Couldn't load audio: \(error.localizedDescription)"
        }
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        let snapshot = search
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, snapshot == search else { return }
            await reload()
        }
    }

    private func reload() async {
        // Cancel any in-flight reload — fast typing was causing slow responses
        // for older queries to clobber newer results. Capture the query at the
        // start so we can also discard if the user has changed it before our
        // request returns.
        reloadTask?.cancel()
        let snapshot = search.isEmpty ? nil : search
        let task = Task { [snapshot] in
            await performReload(query: snapshot)
        }
        reloadTask = task
        await task.value
    }

    private func performReload(query: String?) async {
        loading = true
        error = nil
        // Only clear the spinner if THIS reload is still the active one and
        // wasn't cancelled. Without the guard, an older cancelled reload's
        // defer would flip loading=false while a newer reload is still
        // in-flight — the UI would briefly show "no matches" or stale rows
        // before the real result arrived.
        defer {
            if !Task.isCancelled, (query ?? "") == search {
                loading = false
            }
        }
        do {
            let result = try await api.transmissions(
                limit: limit,
                search: query,
                channel: filterChannel,
                user: filterUnit.isEmpty ? nil : filterUnit.uppercased(),
                from: filterFrom.map(Self.iso8601String),
                to: filterTo.map(Self.iso8601String)
            )
            // Drop the result if the user has changed the search box while we
            // were in-flight, or if a newer reload took over.
            guard !Task.isCancelled, (query ?? "") == search else { return }
            transmissions = result
        } catch is CancellationError {
            return
        } catch {
            if (error as? URLError)?.code == .cancelled { return }
            self.error = "\(error)"
        }
    }

    /// Bumps `limit` by `pageStep` (capped at server max) and re-fetches.
    /// Server doesn't support offset/cursor pagination so we always re-fetch
    /// the whole page — slightly wasteful but matches how the web console does
    /// it and keeps the result set in sort order without merging.
    private func loadMore() async {
        guard limit < Self.maxLimit else { return }
        limit = min(limit + Self.pageStep, Self.maxLimit)
        await reload()
    }

    /// Populate the channel-filter picker with whatever channels the operator
    /// has permission to see. Fails silently — picker just stays empty if the
    /// channels list can't be fetched.
    private func refreshAvailableChannels() async {
        do {
            availableChannels = try await api.channels().map(\.name)
        } catch {
            // Non-fatal; an empty picker is recoverable by retrying the sheet.
        }
    }

    // MARK: - formatting

    /// ISO-8601 with second precision — matches what the server expects for
    /// `from` / `to` query params.
    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static func iso8601String(_ date: Date) -> String {
        iso8601.string(from: date)
    }

    private static let chipDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d HH:mm"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    private func shortDate(_ date: Date) -> String {
        Self.chipDateFormatter.string(from: date)
    }

    // MARK: - formatting

    private static let serverDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let serverDateFormatterFallback: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
    private static let displayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d HH:mm:ss"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    private func formatTime(_ raw: String) -> String {
        let date = Self.serverDateFormatter.date(from: raw) ?? Self.serverDateFormatterFallback.date(from: raw)
        guard let date else { return raw }
        return Self.displayFormatter.string(from: date)
    }

    private func formatDuration(_ ms: Int) -> String {
        let seconds = max(0, ms) / 1000
        let m = seconds / 60
        let s = seconds % 60
        return String(format: "%d:%02d", m, s)
    }
}
