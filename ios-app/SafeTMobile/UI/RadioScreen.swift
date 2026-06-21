import AVFoundation
import SwiftUI
import UIKit

/// A contiguous zone bank in the channel picker — a header ("ZONE 1 · PATROL")
/// and the channels under it. Identifiable so the dropdown's `ForEach` is stable.
private struct ChannelZoneGroup: Identifiable {
    let id: Int
    let header: String
    var options: [ChannelOption]
}

/// Quick zone/channel picker — a dropdown grouped by zone bank so the operator
/// can jump straight to a channel instead of stepping ▲/▼ through the whole
/// catalog. Mirrors the Android zone-select affordance.
///
/// Extracted into its own `Equatable` view (used via `.equatable()`) so the
/// radio shell's once-per-second clock re-render doesn't rebuild the open Menu
/// and bounce its scroll position back to the top. The `onSelect` closure is
/// deliberately excluded from `==` — only the rendered data gates a redraw.
private struct ChannelPickerMenu: View, Equatable {
    let channels: [ChannelOption]
    let selectedIndex: Int
    let displayLabel: String
    let disabled: Bool
    let onSelect: (Int) -> Void

    static func == (lhs: ChannelPickerMenu, rhs: ChannelPickerMenu) -> Bool {
        lhs.selectedIndex == rhs.selectedIndex &&
        lhs.displayLabel == rhs.displayLabel &&
        lhs.disabled == rhs.disabled &&
        lhs.channels == rhs.channels
    }

    var body: some View {
        Menu {
            ForEach(groupedChannels) { group in
                Section(group.header) {
                    ForEach(group.options) { option in
                        Button {
                            onSelect(option.index)
                        } label: {
                            if option.index == selectedIndex {
                                Label(option.displayLabel, systemImage: "checkmark")
                            } else {
                                Text(option.displayLabel)
                            }
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "line.3.horizontal")
                    .font(.safet(size: 13, weight: .bold))
                Text(displayLabel)
                    .font(.safet(size: 14, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                Spacer()
                Image(systemName: "chevron.up.chevron.down")
                    .font(.safet(size: 11, weight: .bold))
            }
            .foregroundColor(.safetText)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity)
            .frame(height: 46)
            .background(Color.safetSurface)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.safetBorder, lineWidth: 1))
            .cornerRadius(8)
        }
        .disabled(disabled)
        .accessibilityLabel("Select zone and channel")
        .accessibilityValue("Currently \(displayLabel)")
    }

    /// Groups channels into contiguous zone sections. The catalog arrives ordered
    /// by zone number (server `ORDER BY zone_number`), so consecutive grouping
    /// preserves the intended bank layout.
    private var groupedChannels: [ChannelZoneGroup] {
        var groups: [ChannelZoneGroup] = []
        for option in channels {
            let header = option.zoneHeader
            if let last = groups.last, last.header == header {
                groups[groups.count - 1].options.append(option)
            } else {
                groups.append(ChannelZoneGroup(id: groups.count, header: header, options: [option]))
            }
        }
        return groups
    }
}

/// The safeT Mobile radio shell — status strip, channel display, controls,
/// emergency, and a press-and-hold PTT bar.
struct RadioScreen: View {
    @StateObject private var viewModel: RadioViewModel
    @EnvironmentObject private var session: AuthSession
    @EnvironmentObject private var settings: SettingsStore
    @State private var pttDown = false
    @State private var showingDispatch = false
    @State private var showingMap = false
    @State private var showingUnits = false
    @State private var showingTranscripts = false
    @State private var showingSettings = false
    @State private var showingMultiChannel = false
    @State private var micStatus: AVAudioSession.RecordPermission = Self.initialMicStatus()
    /// SF Symbol name reflecting whichever AVAudioSession output the OS has
    /// actually picked right now (not just the saved preference). Updated on
    /// appear and on AVAudioSession.routeChangeNotification so plugging in
    /// BT headphones flips the glyph live.
    @State private var liveRouteIcon: String = "speaker.wave.2"
    @Environment(\.scenePhase) private var scenePhase

    /// Construct the view-model lazily inside the StateObject autoclosure so
    /// SwiftUI retains the instance across re-renders. Building the view-model
    /// in the caller (e.g. `RadioScreen(viewModel: RadioViewModel(...))`)
    /// instantiates a fresh VM every body invocation; the autoclosure form
    /// only fires once per `.id(user.id)` lifetime.
    init(user: AuthenticatedUser, token: String) {
        _viewModel = StateObject(wrappedValue: RadioViewModel(user: user, token: token))
    }

    private static func initialMicStatus() -> AVAudioSession.RecordPermission {
        if ProcessInfo.processInfo.arguments.contains("-uitest-logged-in") { return .granted }
        return AVAudioSession.sharedInstance().recordPermission
    }

    var body: some View {
        Group {
            switch micStatus {
            case .denied: micDeniedCard
            // .undetermined intentionally renders the radio shell — the
            // view-model's `requestRecordPermission()` triggers the OS prompt
            // organically on the first PTT-related call. An in-app "Allow
            // Microphone" card here used to fire alongside the OS prompt,
            // double-stacking the dialog on first launch.
            case .undetermined: radioShell
            case .granted: radioShell
            @unknown default: radioShell
            }
        }
        .onAppear { micStatus = Self.initialMicStatus() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            micStatus = Self.initialMicStatus()
        }
    }

    private var radioShell: some View {
        let state = viewModel.uiState
        return ZStack {
            Color.safetBackground.ignoresSafeArea()
            VStack(spacing: 12) {
                statusStrip(state)
                operatorStrip(state)
                tabStrip(state)
                displayPanel(state)
                channelRow(state)
                Spacer(minLength: 12)
                emergencyButton(state)
                pttBar(state)
            }
            .padding(16)
            // Siri-style AI-dispatcher overlay, centered over the radio UI so the
            // channel name / buttons around it stay visible. Keying PTT drops it.
            AiActivityOverlayView(activity: state.aiActivity, pttPressed: state.isPttPressed)
                .allowsHitTesting(false)
                .animation(.easeInOut(duration: 0.25), value: state.aiActivity)
        }
        .onChange(of: scenePhase) { phase in
            // Clear the Dynamic Island when the app is closed/backgrounded and
            // bring it back when the operator returns. See RadioViewModel.
            switch phase {
            case .background: viewModel.endLiveActivityForBackground()
            case .active: viewModel.reassertLiveActivity()
            default: break
            }
        }
        .sheet(isPresented: $showingDispatch) { sheetWrap("DISPATCH", isPresented: $showingDispatch) {
            if let token = session.token {
                DispatchScreen(api: RadioApiClient(token: token))
            }
        } }
        .sheet(isPresented: $showingMap) { sheetWrap("MAP", isPresented: $showingMap) {
            if let token = session.token {
                MapScreen(api: RadioApiClient(token: token))
            }
        } }
        .sheet(isPresented: $showingTranscripts) { sheetWrap("TX LOG", isPresented: $showingTranscripts) {
            if let token = session.token {
                TranscriptionsScreen(api: RadioApiClient(token: token))
            }
        } }
        .sheet(isPresented: $showingUnits) { sheetWrap("UNITS", isPresented: $showingUnits) {
            if let token = session.token {
                UnitsScreen(api: RadioApiClient(token: token))
            }
        } }
        .sheet(isPresented: $showingSettings) {
            SettingsScreen(
                state: viewModel.uiState,
                onEvent: { viewModel.handle($0) },
                onSignOut: {
                    // Drive teardown purely off the auth state: clearing the
                    // session flips RootView to LoginScreen, which removes this
                    // RadioScreen (and the settings sheet presented from it)
                    // wholesale. Do NOT also toggle `showingSettings` here —
                    // animating the sheet's dismissal in the same pass that the
                    // presenter is torn down races the two transactions and can
                    // wedge the modal session, leaving the login screen onscreen
                    // but uninteractive (the sign-out UI test hangs at "SIGN IN").
                    session.logout()
                },
                onClose: { showingSettings = false }
            )
            // Re-inject the SettingsStore explicitly on the sheet
            // content. Environment objects usually propagate across
            // sheet presentations, but the explicit injection is the
            // robust path — without it, an env-object lookup failure
            // inside SettingsScreen.controlsSection crashes the app
            // when the user taps SETTINGS.
            .environmentObject(settings)
            .environmentObject(session)
        }
        .sheet(isPresented: $showingMultiChannel) { sheetWrap("SCAN CHANNELS", isPresented: $showingMultiChannel) {
            if let token = session.token {
                MultiChannelScreen(
                    api: RadioApiClient(token: token),
                    initialSelection: viewModel.uiState.scanIncludedChannels,
                    scanActive: viewModel.uiState.scanActive,
                    onSelectionChanged: { channels in viewModel.handle(.setScanChannels(channels)) },
                    onScanToggle: { viewModel.handle(.toggleScan) }
                )
            }
        } }
    }

    @ViewBuilder
    private var micDeniedCard: some View {
        ZStack {
            Color.safetBackground.ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: "mic.slash.fill")
                    .font(.safet(size: 48, weight: .bold))
                    .foregroundColor(.safetRed)
                Text("MICROPHONE BLOCKED")
                    .font(.safet(size: 16, weight: .heavy))
                    .foregroundColor(.safetText)
                Text("safeT can't transmit voice without the mic. Open Settings to allow microphone access.")
                    .font(.safet(size: 13))
                    .foregroundColor(.safetTextDim)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Text("OPEN SETTINGS")
                        .font(.safet(size: 14, weight: .heavy))
                        .foregroundColor(.white)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 12)
                        .background(Color.safetBlue)
                        .cornerRadius(8)
                }
            }
            .padding(24)
        }
    }

    @ViewBuilder
    private func sheetWrap<Content: View>(
        _ title: String,
        isPresented: Binding<Bool>,
        @ViewBuilder content: () -> Content
    ) -> some View {
        NavigationStack {
            content()
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("CLOSE") { isPresented.wrappedValue = false }
                            .font(.safet(size: 12, weight: .bold))
                            .foregroundColor(.safetText)
                    }
                }
        }
    }

    // MARK: - status strip

    private func statusStrip(_ state: RadioUiState) -> some View {
        HStack(spacing: 8) {
            Text("UNIT \(state.localShortUnitId)")
                .font(.safet(size: 12, weight: .semibold))
                .foregroundColor(.safetTextDim)
            Spacer()
            Text(state.systemTime)
                .font(.safet(size: 13, weight: .semibold))
                .foregroundColor(.safetText)
            Spacer()
            audioRouteMenu
            networkPill(state)
        }
    }

    private var audioRouteMenu: some View {
        Menu {
            ForEach(SettingsStore.AudioRoute.allCases, id: \.self) { route in
                Button {
                    settings.audioRoute = route
                    AudioSessionManager.applyRoute(route)
                    refreshLiveRouteIcon()
                } label: {
                    Label(route.label, systemImage: route.icon)
                }
            }
        } label: {
            Image(systemName: liveRouteIcon)
                .font(.safet(size: 14, weight: .semibold))
                .foregroundColor(.safetTextDim)
                .frame(width: 24, height: 24)
        }
        .onAppear { refreshLiveRouteIcon() }
        .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.routeChangeNotification)) { _ in
            refreshLiveRouteIcon()
        }
        .accessibilityLabel("Audio route")
        .accessibilityValue(settings.audioRoute.label)
    }

    /// Maps the AVAudioSession's currently selected output port to an SF
    /// Symbol so the status-strip glyph reflects what the OS is actually
    /// playing through, not just the saved preference. Falls through to the
    /// generic speaker icon for ports we haven't categorised.
    private func refreshLiveRouteIcon() {
        let session = AVAudioSession.sharedInstance()
        let port = session.currentRoute.outputs.first?.portType
        switch port {
        case .some(.headphones):
            liveRouteIcon = "headphones"
        case .some(.bluetoothA2DP), .some(.bluetoothHFP), .some(.bluetoothLE):
            liveRouteIcon = "headphones"
        case .some(.builtInSpeaker):
            liveRouteIcon = "speaker.wave.2"
        case .some(.builtInReceiver):
            liveRouteIcon = "ear"
        default:
            liveRouteIcon = "speaker.wave.2"
        }
    }

    private func operatorStrip(_ state: RadioUiState) -> some View {
        HStack(spacing: 6) {
            Text(state.operatorDisplayName.uppercased())
                .font(.safet(size: 11, weight: .semibold))
                .foregroundColor(.safetTextDim)
                .lineLimit(1)
                .truncationMode(.tail)
            if !state.agencyName.isEmpty {
                Text("·").foregroundColor(.safetTextDim.opacity(0.6)).font(.safet(size: 10))
                Text(state.agencyName)
                    .font(.safet(size: 11, weight: .medium))
                    .foregroundColor(.safetTextDim)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer()
        }
    }

    // Icon-only tab buttons. Earlier revisions paired an SF Symbol with a
    // label inside each pill; once the operator/agency line was added beside
    // them the row ran out of horizontal space and SwiftUI wrapped each text
    // label vertically (one letter per line). Icons-only keeps every button a
    // fixed square so the row stays scannable regardless of label length.
    private func tabStrip(_ state: RadioUiState) -> some View {
        HStack(spacing: 8) {
            if session.currentUser?.isOperator == true {
                tabButton(icon: "shield.lefthalf.filled", label: "DISPATCH", tint: .safetAmber) {
                    showingDispatch = true
                }
            }
            tabButton(icon: "map", label: "MAP") { showingMap = true }
            tabButton(icon: "person.2.fill", label: "UNITS") { showingUnits = true }
            tabButton(icon: "text.bubble", label: "TX LOG") { showingTranscripts = true }
            tabButton(icon: "waveform.circle", label: "CHANNELS") { showingMultiChannel = true }
            tabButton(
                icon: "dot.radiowaves.left.and.right",
                label: "SCAN",
                tint: state.scanActive ? .safetGreen : .safetTextDim,
                highlighted: state.scanActive
            ) {
                showingMultiChannel = true
            }
            tabButton(icon: "gearshape.fill", label: "SETTINGS") { showingSettings = true }
        }
    }

    private func tabButton(
        icon: String,
        label: String,
        tint: Color = .safetTextDim,
        highlighted: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: icon)
                    .font(.safet(size: 15, weight: .bold))
                Text(label)
                    .font(.safet(size: 8, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
            .foregroundColor(tint)
            .frame(maxWidth: .infinity)
            .frame(height: 42)
            .background(highlighted ? tint.opacity(0.15) : Color.safetSurface)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(highlighted ? tint : Color.safetBorder, lineWidth: 1)
            )
            .cornerRadius(8)
        }
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func networkPill(_ state: RadioUiState) -> some View {
        if state.isReconnecting {
            pillBody(text: "Reconnecting", color: .safetAmber)
        } else if state.networkLabel == "OFFLINE" {
            pillBody(text: "Offline", color: .safetRed)
        } else if let started = state.connectionStartedAt {
            TimelineView(.periodic(from: started, by: 1)) { context in
                let secs = max(0, Int(context.date.timeIntervalSince(started)))
                pillBody(text: "Connected · \(secs)s", color: .safetGreen)
            }
        } else {
            pillBody(text: state.networkLabel, color: .safetAmber)
        }
    }

    private func pillBody(text: String, color: Color) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text)
                .font(.safet(size: 10, weight: .bold))
                .foregroundColor(color)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .overlay(Capsule().stroke(color.opacity(0.6), lineWidth: 1))
    }

    // MARK: - LCD display

    private func displayPanel(_ state: RadioUiState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if state.channelTen33 {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.safet(size: 10, weight: .bold))
                    Text("10-33 EMERGENCY TRAFFIC")
                        .font(.safet(size: 11, weight: .heavy))
                }
                .foregroundColor(.safetAmber)
                .padding(.vertical, 4)
                .padding(.horizontal, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.safetAmber.opacity(0.15))
                .cornerRadius(6)
            }

            VStack(alignment: .leading, spacing: 8) {
                if !state.zoneLabel.isEmpty {
                    Text(state.zoneLabel)
                        .font(.safet(size: 15, weight: .bold))
                        .foregroundColor(.safetTextDim)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                Text(state.channelDisplayLabel)
                    .font(.safet(size: 34, weight: .heavy))
                    .foregroundColor(.safetText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)

                if state.aiDispatchEnabled {
                    // Rainbow "AI DISPATCH" capsule — this channel runs the AI dispatcher.
                    Text("✦ AI DISPATCH")
                        .font(.safet(size: 11, weight: .bold, design: .rounded))
                        .foregroundColor(.black)
                        .padding(.vertical, 2)
                        .padding(.horizontal, 8)
                        .background(
                            LinearGradient(
                                colors: [
                                    Color(red: 1.0, green: 0.37, blue: 0.43),
                                    Color(red: 1.0, green: 0.77, blue: 0.44),
                                    Color(red: 0.22, green: 0.98, blue: 0.84),
                                    Color(red: 0.50, green: 0.50, blue: 0.84),
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .clipShape(Capsule())
                }

                if !state.channelCodecLabel.isEmpty {
                    Text(state.channelCodecLabel)
                        .font(.safet(size: 11, weight: .semibold, design: .rounded))
                        .foregroundColor(.safetTextDim)
                        .padding(.vertical, 2)
                        .padding(.horizontal, 6)
                        .background(Color.safetTextDim.opacity(0.12))
                        .cornerRadius(4)
                }

                if !state.unitsOnChannel.isEmpty {
                    let maxVisible = 4
                    let displayed = Array(state.unitsOnChannel.prefix(maxVisible))
                    let overflow = state.unitsOnChannel.count - maxVisible
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(displayed, id: \.self) { unit in
                            Text("• \(unit)")
                                .font(.safet(size: 11, weight: .medium))
                                .foregroundColor(.safetTextDim)
                                .lineLimit(1)
                        }
                        if overflow > 0 {
                            Text("+ \(overflow) more")
                                .font(.safet(size: 10, weight: .semibold))
                                .foregroundColor(.safetTextDim.opacity(0.6))
                        }
                    }
                }
            }

            HStack {
                Text(state.channelPosition)
                    .font(.safet(size: 13, weight: .semibold))
                    .foregroundColor(.safetTextDim)
                Spacer()
                if state.isReceivingAudio {
                    Text("RX")
                        .font(.safet(size: 11, weight: .heavy))
                        .foregroundColor(.safetSignal)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .overlay(Capsule().stroke(Color.safetSignal.opacity(0.7), lineWidth: 1))
                }
            }

            if !state.rxAttributedLine.isEmpty, !state.channelTen33 {
                Text(state.rxAttributedLine)
                    .font(.safet(size: 12, weight: .bold))
                    .foregroundColor(state.rxFromScan ? .safetGreen : .safetSignal)
                    .lineLimit(2)
                    .minimumScaleFactor(0.7)
            }

            if state.scanActive {
                scanBanner(state)
            }

            Divider().overlay(Color.safetBorder)

            Text(state.channelsLoading ? "SYNCING…" : state.statusMessage)
                .font(.safet(size: 13, weight: .bold))
                .foregroundColor(statusColor(state))
                .lineLimit(1)
                .minimumScaleFactor(0.6)

            if let error = state.channelSyncError {
                Button("RETRY SYNC") { viewModel.handle(.retryChannelSync) }
                    .font(.safet(size: 11, weight: .bold))
                    .foregroundColor(.safetSignal)
                    .accessibilityLabel(Text(error))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.safetSurface)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.safetBorder, lineWidth: 1))
        .cornerRadius(10)
    }

    private func scanBanner(_ state: RadioUiState) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.safet(size: 10, weight: .bold))
            if let rx = state.scanRxChannel {
                Text("SCAN: \(rx.uppercased())")
                    .font(.safet(size: 11, weight: .heavy))
            } else {
                let home = state.channelLabel.lowercased()
                let count = state.scanIncludedChannels.filter { $0 != home }.count
                Text(count > 0 ? "SCAN ON · \(count) CH" : "SCAN ON · PICK CHANNELS")
                    .font(.safet(size: 11, weight: .heavy))
            }
            Spacer()
        }
        .foregroundColor(state.scanRxChannel != nil ? .safetGreen : .safetSignal)
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .background((state.scanRxChannel != nil ? Color.safetGreen : Color.safetSignal).opacity(0.12))
        .cornerRadius(6)
    }

    private func statusColor(_ state: RadioUiState) -> Color {
        if state.isEmergencyActive { return .safetRed }
        if state.pttBusyTone { return .safetAmber }
        if state.isTransmitting { return .safetGreen }
        if state.isReceivingAudio { return .safetSignal }
        return .safetTextDim
    }

    // MARK: - channel controls

    private func channelRow(_ state: RadioUiState) -> some View {
        // Only offer zone stepping when the catalog actually has more than one zone.
        let zoneCount = Set(state.channels.map { $0.zoneNumber }).count
        return VStack(spacing: 10) {
            // Equatable so the once-per-second clock tick (which re-renders this
            // whole screen) doesn't rebuild the open dropdown and bounce its
            // scroll back to the top.
            ChannelPickerMenu(
                channels: state.channels,
                selectedIndex: state.channelIndex,
                displayLabel: state.channelDisplayLabel,
                disabled: state.channelsLoading || state.channels.isEmpty,
                onSelect: { viewModel.handle(.selectChannel($0)) }
            )
            .equatable()
            if zoneCount > 1 {
                HStack(spacing: 10) {
                    controlButton(title: "ZONE \u{25BC}", enabled: !state.channelsLoading) {
                        viewModel.handle(.zoneDown)
                    }
                    .accessibilityLabel("Zone down")
                    controlButton(title: "ZONE \u{25B2}", enabled: !state.channelsLoading) {
                        viewModel.handle(.zoneUp)
                    }
                    .accessibilityLabel("Zone up")
                }
            }
            HStack(spacing: 10) {
                controlButton(title: "CH \u{25BC}", enabled: !state.channelsLoading) {
                    viewModel.handle(.channelDown)
                }
                .accessibilityLabel("Channel down")
                .accessibilityValue("Currently \(state.channelLabel)")
                controlButton(title: "CH \u{25B2}", enabled: !state.channelsLoading) {
                    viewModel.handle(.channelUp)
                }
                .accessibilityLabel("Channel up")
                .accessibilityValue("Currently \(state.channelLabel)")
                controlIconButton(systemImage: "gobackward", enabled: !state.channelsLoading) {
                    viewModel.replay()
                }
                .accessibilityLabel("Replay last message")
            }
        }
    }

    private func controlButton(
        title: String,
        tint: Color = .safetText,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(.safet(size: 13, weight: .bold))
                .foregroundColor(enabled ? tint : .safetTextDim.opacity(0.5))
                .frame(maxWidth: .infinity)
                .frame(height: 46)
                .background(Color.safetSurface)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.safetBorder, lineWidth: 1))
                .cornerRadius(8)
        }
        .disabled(!enabled)
    }

    /// Icon variant of `controlButton` — used for the replay control.
    private func controlIconButton(
        systemImage: String,
        tint: Color = .safetText,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.safet(size: 18, weight: .bold))
                .foregroundColor(enabled ? tint : .safetTextDim.opacity(0.5))
                .frame(maxWidth: .infinity)
                .frame(height: 46)
                .background(Color.safetSurface)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.safetBorder, lineWidth: 1))
                .cornerRadius(8)
        }
        .disabled(!enabled)
    }

    // MARK: - emergency

    private func emergencyButton(_ state: RadioUiState) -> some View {
        Button {
            viewModel.handle(.emergencyToggle)
        } label: {
            Text(state.isEmergencyActive ? "EMERGENCY ACTIVE \u{2014} TAP TO CLEAR" : "EMERGENCY")
                .font(.safet(size: 14, weight: .heavy))
                .foregroundColor(state.isEmergencyActive ? .white : .safetRed)
                .frame(maxWidth: .infinity)
                .frame(height: 48)
                .background(state.isEmergencyActive ? Color.safetRed : Color.safetRed.opacity(0.16))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.safetRed, lineWidth: 1.5))
                .cornerRadius(9)
        }
    }

    // MARK: - PTT

    private func pttBar(_ state: RadioUiState) -> some View {
        VStack(spacing: 4) {
            pttTitleView(state)
            Text(pttSubtitle(state))
                .font(.safet(size: 10, weight: .semibold))
                .opacity(0.85)
        }
        .foregroundColor(state.isListenOnly ? .safetTextDim : .white)
        .frame(maxWidth: .infinity)
        .frame(height: 116)
        .background(pttColor(state))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(state.isListenOnly ? Color.safetBorder : Color.clear, lineWidth: 1)
        )
        .cornerRadius(12)
        // Listen-only channels can't key — grey the bar out and swallow taps so
        // the operator gets no "keying" feedback. The hardware/remote PTT paths
        // are gated identically in the view-model. Gated on isListenOnly (not
        // !canTransmit) so a still-loading channel doesn't grey out the bar.
        .opacity(state.isListenOnly ? 0.55 : 1.0)
        .allowsHitTesting(!state.isListenOnly)
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    if !pttDown {
                        pttDown = true
                        viewModel.handle(.pttPressed)
                    }
                }
                .onEnded { _ in
                    pttDown = false
                    viewModel.handle(.pttReleased)
                }
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Push to talk")
        .accessibilityHint(state.isListenOnly
            ? "Listen only on channel \(state.channelLabel)"
            : "Hold to transmit on channel \(state.channelLabel)")
        .accessibilityValue(state.isTransmitting ? "Transmitting" : (state.isListenOnly ? "Listen only" : "Idle"))
    }

    /// While transmitting, render "XMIT" with the lightning-bolt SF Symbol so
    /// the operator gets the visual radio-style "I'm on air" signal. Other
    /// states fall back to plain text via `pttTitle`.
    @ViewBuilder
    private func pttTitleView(_ state: RadioUiState) -> some View {
        if state.isTransmitting {
            HStack(spacing: 6) {
                Image(systemName: "bolt.fill")
                    .font(.safet(size: 22, weight: .heavy))
                Text("XMIT")
                    .font(.safet(size: 22, weight: .heavy))
            }
        } else {
            Text(pttTitle(state))
                .font(.safet(size: 22, weight: .heavy))
        }
    }

    private func pttTitle(_ state: RadioUiState) -> String {
        if state.isListenOnly { return "LISTEN ONLY" }
        if state.pttBusyTone { return "CHANNEL BUSY" }
        // isTransmitting is rendered by pttTitleView's icon+text branch — never reached here.
        if state.isPttPressed { return "KEYING…" }
        return "HOLD TO TALK"
    }

    private func pttSubtitle(_ state: RadioUiState) -> String {
        if state.isListenOnly { return "MONITOR ONLY ON THIS CHANNEL" }
        if state.isTransmitting { return "PCM 16K MONO \u{2014} HALF-DUPLEX" }
        return "PRESS AND HOLD"
    }

    private func pttColor(_ state: RadioUiState) -> Color {
        if state.isListenOnly { return .safetSurface }
        if state.pttBusyTone { return .safetRed }
        if state.isTransmitting { return .safetGreen }
        if state.isPttPressed { return .safetGreen.opacity(0.5) }
        return .safetBlue
    }
}

// MARK: - AI dispatcher activity overlay

/// Rainbow used by the AI overlay (orb sweep, chip, response rule). File-scoped
/// so the three overlay views share one definition.
private let aiRainbow: [Color] = [
    Color(red: 1.00, green: 0.37, blue: 0.43),
    Color(red: 1.00, green: 0.76, blue: 0.44),
    Color(red: 0.22, green: 0.98, blue: 0.84),
    Color(red: 0.50, green: 0.50, blue: 0.84),
    Color(red: 1.00, green: 0.37, blue: 0.43),
]

/// Siri/Gemini-style overlay shown while the AI dispatcher is thinking or
/// speaking. Centered over the radio UI (the channel name and the buttons around
/// it stay visible). Mirrors the Android `AiActivityOverlay`: keying PTT drops
/// it, and a "thinking" cue only shows on the radio she's actually answering.
private struct AiActivityOverlayView: View {
    let activity: AiActivityUi?
    let pttPressed: Bool

    var body: some View {
        if let activity, !pttPressed, shouldShow(activity) {
            VStack(spacing: 18) {
                chip
                switch activity.phase {
                case .thinking: AiThinkingVisual()
                case .speaking: AiSpeakingVisual(activity: activity)
                }
            }
            .padding(22)
            .frame(maxWidth: 360)
            .background(Color.safetSurface.opacity(0.96))
            .clipShape(RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.safetBorder, lineWidth: 1))
            .padding(.horizontal, 16)
            .transition(.opacity)
        }
    }

    private func shouldShow(_ a: AiActivityUi) -> Bool {
        // While she's only *thinking*, show the cue just for the radio she's
        // answering. Once she *speaks* it's on-air for everyone on the channel.
        if a.phase == .thinking && !a.forYou { return false }
        return true
    }

    private var chip: some View {
        Text("\u{2726} AI DISPATCH")
            .font(.safet(size: 13, weight: .bold))
            .foregroundColor(Color(red: 0.04, green: 0.04, blue: 0.07))
            .padding(.horizontal, 14)
            .padding(.vertical, 4)
            .background(
                LinearGradient(colors: aiRainbow, startPoint: .leading, endPoint: .trailing)
            )
            .clipShape(Capsule())
    }
}

/// Breathing rainbow orb + "THINKING" + rippling dots.
private struct AiThinkingVisual: View {
    @State private var spin = false
    @State private var pulse = false

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle()
                    .fill(AngularGradient(gradient: Gradient(colors: aiRainbow), center: .center))
                    .frame(width: 96, height: 96)
                    .rotationEffect(.degrees(spin ? 360 : 0))
                    .scaleEffect(pulse ? 1.0 : 0.9)
                Circle()
                    .fill(Color.safetSurface.opacity(0.88))
                    .frame(width: 52, height: 52)
            }
            Text("THINKING")
                .font(.safet(size: 26, weight: .heavy))
                .foregroundColor(.safetText)
            Text("\u{2022}  \u{2022}  \u{2022}")
                .font(.safet(size: 26, weight: .bold))
                .foregroundColor(.safetText)
                .opacity(pulse ? 1.0 : 0.35)
        }
        .onAppear {
            withAnimation(.linear(duration: 2.6).repeatForever(autoreverses: false)) { spin = true }
            withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { pulse = true }
        }
    }
}

/// Rainbow-themed response: a short action tag, a rainbow rule, then what she said.
private struct AiSpeakingVisual: View {
    let activity: AiActivityUi

    var body: some View {
        VStack(spacing: 12) {
            if !activity.tag.isEmpty {
                Text(activity.tag)
                    .font(.safet(size: 14, weight: .bold))
                    .foregroundColor(.safetBlue)
                    .multilineTextAlignment(.center)
            }
            Capsule()
                .fill(LinearGradient(colors: aiRainbow, startPoint: .leading, endPoint: .trailing))
                .frame(width: 120, height: 3)
            Text(activity.text.isEmpty ? "\u{2026}" : activity.text)
                .font(.safet(size: 22, weight: .semibold))
                .foregroundColor(.safetText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
    }
}
