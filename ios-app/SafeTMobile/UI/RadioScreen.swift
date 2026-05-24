import SwiftUI

/// The safeT Mobile radio shell — status strip, channel display, controls,
/// emergency, and a press-and-hold PTT bar.
struct RadioScreen: View {
    @StateObject var viewModel: RadioViewModel
    @EnvironmentObject private var session: AuthSession
    @State private var pttDown = false
    @State private var showingDispatch = false
    @State private var showingTranscripts = false

    var body: some View {
        let state = viewModel.uiState
        ZStack {
            Color.safetBackground.ignoresSafeArea()
            VStack(spacing: 14) {
                statusStrip(state)
                operatorStrip(state)
                displayPanel(state)
                channelRow(state)
                Spacer(minLength: 12)
                emergencyButton(state)
                pttBar(state)
            }
            .padding(16)
        }
        .sheet(isPresented: $showingDispatch) {
            if let token = session.token {
                NavigationStack {
                    DispatchScreen(api: RadioApiClient(token: token))
                        .toolbar {
                            ToolbarItem(placement: .navigationBarLeading) {
                                Button("CLOSE") { showingDispatch = false }
                                    .font(.system(size: 12, weight: .bold))
                                    .foregroundColor(.safetText)
                            }
                        }
                }
                .preferredColorScheme(.dark)
            }
        }
        .sheet(isPresented: $showingTranscripts) {
            if let token = session.token {
                NavigationStack {
                    TranscriptionsScreen(api: RadioApiClient(token: token))
                        .toolbar {
                            ToolbarItem(placement: .navigationBarLeading) {
                                Button("CLOSE") { showingTranscripts = false }
                                    .font(.system(size: 12, weight: .bold))
                                    .foregroundColor(.safetText)
                            }
                        }
                }
                .preferredColorScheme(.dark)
            }
        }
    }

    // MARK: - status strip

    private func statusStrip(_ state: RadioUiState) -> some View {
        HStack {
            Text("UNIT \(state.localShortUnitId)")
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundColor(.safetTextDim)
            Spacer()
            Text(state.systemTime)
                .font(.system(size: 13, weight: .semibold, design: .monospaced))
                .foregroundColor(.safetText)
            Spacer()
            networkPill(state.networkLabel)
        }
    }

    private func operatorStrip(_ state: RadioUiState) -> some View {
        HStack(spacing: 8) {
            Text(state.operatorDisplayName.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.safetTextDim)
                .lineLimit(1)
            if !state.agencyName.isEmpty {
                Text("•").foregroundColor(.safetTextDim.opacity(0.6)).font(.system(size: 10))
                Text(state.agencyName)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(.safetTextDim)
                    .lineLimit(1)
            }
            Spacer()
            if session.currentUser?.isOperator == true {
                Button {
                    showingDispatch = true
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "shield.lefthalf.filled")
                            .font(.system(size: 10, weight: .bold))
                        Text("DISPATCH")
                            .font(.system(size: 10, weight: .bold))
                    }
                    .foregroundColor(.safetAmber)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .overlay(Capsule().stroke(Color.safetAmber.opacity(0.7), lineWidth: 1))
                }
            }
            Button {
                showingTranscripts = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "text.bubble")
                        .font(.system(size: 10, weight: .bold))
                    Text("TX LOG")
                        .font(.system(size: 10, weight: .bold))
                }
                .foregroundColor(.safetTextDim)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .overlay(Capsule().stroke(Color.safetBorder, lineWidth: 1))
            }
            Button("SIGN OUT") { session.logout() }
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(.safetTextDim)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .overlay(Capsule().stroke(Color.safetBorder, lineWidth: 1))
        }
    }

    private func networkPill(_ label: String) -> some View {
        let color: Color = label == "ONLINE" ? .safetGreen : (label == "OFFLINE" ? .safetRed : .safetAmber)
        return Text(label)
            .font(.system(size: 10, weight: .bold))
            .foregroundColor(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .overlay(Capsule().stroke(color.opacity(0.6), lineWidth: 1))
    }

    // MARK: - LCD display

    private func displayPanel(_ state: RadioUiState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(state.displayLine1.uppercased())
                .font(.system(size: 11, weight: .bold))
                .tracking(2)
                .foregroundColor(.safetSignal)

            Text(state.channelLabel)
                .font(.system(size: 34, weight: .heavy, design: .rounded))
                .foregroundColor(.safetText)
                .lineLimit(1)
                .minimumScaleFactor(0.5)

            HStack {
                Text(state.channelPosition)
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .foregroundColor(.safetTextDim)
                Spacer()
                if state.isReceivingAudio {
                    Text("RX")
                        .font(.system(size: 11, weight: .heavy))
                        .foregroundColor(.safetSignal)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .overlay(Capsule().stroke(Color.safetSignal.opacity(0.7), lineWidth: 1))
                }
                if let count = state.radiosOnlineOnChannel {
                    Text("\(count) ON CHANNEL")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(.safetTextDim)
                }
            }

            Text(state.displayLine2)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(.safetTextDim)
                .lineLimit(1)

            Divider().overlay(Color.safetBorder)

            Text(state.channelsLoading ? "SYNCING…" : state.statusMessage)
                .font(.system(size: 13, weight: .bold, design: .monospaced))
                .foregroundColor(statusColor(state))
                .lineLimit(1)
                .minimumScaleFactor(0.6)

            if let error = state.channelSyncError {
                Button("RETRY SYNC") { viewModel.handle(.retryChannelSync) }
                    .font(.system(size: 11, weight: .bold))
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

    private func statusColor(_ state: RadioUiState) -> Color {
        if state.isEmergencyActive { return .safetRed }
        if state.pttBusyTone { return .safetAmber }
        if state.isTransmitting { return .safetGreen }
        if state.isReceivingAudio { return .safetSignal }
        return .safetTextDim
    }

    // MARK: - channel / GPS controls

    private func channelRow(_ state: RadioUiState) -> some View {
        let gps = gpsButtonStyle(state)
        return HStack(spacing: 10) {
            controlButton(title: "CH \u{25BC}", enabled: !state.channelsLoading) {
                viewModel.handle(.channelDown)
            }
            controlButton(title: gps.title, tint: gps.tint, enabled: true) {
                viewModel.handle(.toggleGps)
            }
            controlButton(title: "CH \u{25B2}", enabled: !state.channelsLoading) {
                viewModel.handle(.channelUp)
            }
        }
    }

    private func gpsButtonStyle(_ state: RadioUiState) -> (title: String, tint: Color) {
        if !state.gpsActive { return ("GPS OFF", .safetTextDim) }
        if state.locationAuthorized { return ("GPS ON", .safetGreen) }
        return ("GPS \u{2014} NO ACCESS", .safetAmber)
    }

    private func controlButton(
        title: String,
        tint: Color = .safetText,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .bold))
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
                .font(.system(size: 14, weight: .heavy))
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
                .font(.system(size: 10, weight: .semibold))
                .opacity(0.85)
        }
        .foregroundColor(.white)
        .frame(maxWidth: .infinity)
        .frame(height: 116)
        .background(pttColor(state))
        .cornerRadius(12)
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
    }

    /// While transmitting, render "XMIT" with the lightning-bolt SF Symbol so
    /// the operator gets the visual radio-style "I'm on air" signal. Other
    /// states fall back to plain text via `pttTitle`.
    @ViewBuilder
    private func pttTitleView(_ state: RadioUiState) -> some View {
        if state.isTransmitting {
            HStack(spacing: 6) {
                Image(systemName: "bolt.fill")
                    .font(.system(size: 22, weight: .heavy))
                Text("XMIT")
                    .font(.system(size: 22, weight: .heavy))
            }
        } else {
            Text(pttTitle(state))
                .font(.system(size: 22, weight: .heavy))
        }
    }

    private func pttTitle(_ state: RadioUiState) -> String {
        if state.pttBusyTone { return "CHANNEL BUSY" }
        // isTransmitting is rendered by pttTitleView's icon+text branch — never reached here.
        if state.isPttPressed { return "KEYING…" }
        return "HOLD TO TALK"
    }

    private func pttSubtitle(_ state: RadioUiState) -> String {
        if !state.canTransmit && state.networkLabel == "ONLINE" { return "MONITOR ONLY ON THIS CHANNEL" }
        if state.isTransmitting { return "PCM 16K MONO \u{2014} HALF-DUPLEX" }
        return "PRESS AND HOLD"
    }

    private func pttColor(_ state: RadioUiState) -> Color {
        if state.pttBusyTone { return .safetRed }
        if state.isTransmitting { return .safetGreen }
        if state.isPttPressed { return .safetGreen.opacity(0.5) }
        return .safetBlue
    }
}
