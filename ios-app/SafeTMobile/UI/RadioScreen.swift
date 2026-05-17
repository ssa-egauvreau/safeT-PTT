import SwiftUI

/// The safeT Mobile radio shell — status strip, channel display, controls,
/// emergency, and a press-and-hold PTT bar. Voice transmit is not wired yet.
struct RadioScreen: View {
    @StateObject private var viewModel = RadioViewModel()
    @State private var pttDown = false

    var body: some View {
        let state = viewModel.uiState
        ZStack {
            Color.safetBackground.ignoresSafeArea()
            VStack(spacing: 14) {
                statusStrip(state)
                displayPanel(state)
                channelRow(state)
                Spacer(minLength: 12)
                emergencyButton(state)
                pttBar(state)
            }
            .padding(16)
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
        if state.isPttPressed { return .safetGreen }
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
            Text(pttTitle(state))
                .font(.system(size: 22, weight: .heavy))
            Text("VOICE TRANSMIT \u{2014} COMING SOON")
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

    private func pttTitle(_ state: RadioUiState) -> String {
        if state.pttBusyTone { return "CHANNEL BUSY" }
        if state.isPttPressed { return "ON AIR" }
        return "HOLD TO TALK"
    }

    private func pttColor(_ state: RadioUiState) -> Color {
        if state.pttBusyTone { return .safetRed }
        if state.isPttPressed { return .safetGreen }
        return .safetBlue
    }
}

#Preview {
    RadioScreen()
        .preferredColorScheme(.dark)
}
