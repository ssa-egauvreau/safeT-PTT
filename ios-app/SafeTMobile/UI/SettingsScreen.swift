import SwiftUI

/// Operator-facing settings sheet. Drives the radio shell's scan list, surfaces
/// read-only GPS / account status, and gates sign-out behind a confirmation so
/// it can't be hit by mistake mid-shift.
struct SettingsScreen: View {
    let state: RadioUiState
    let onEvent: (RadioUiEvent) -> Void
    let onSignOut: () -> Void
    let onClose: () -> Void

    @EnvironmentObject private var settings: SettingsStore
    @State private var confirmingSignOut = false

    var body: some View {
        NavigationStack {
            List {
                appearanceSection
                accountSection
                controlsSection
                audioSection
                scanSection
                gpsSection
                aboutSection
                signOutSection
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.safetBackground)
            .navigationTitle("SETTINGS")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("CLOSE") { onClose() }
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(.safetText)
                }
            }
            .confirmationDialog("Sign out of safeT?", isPresented: $confirmingSignOut) {
                Button("Sign Out", role: .destructive) {
                    onSignOut()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You will be returned to the login screen.")
            }
        }
    }

    // MARK: - Appearance

    private var appearanceSection: some View {
        Section {
            Picker("Theme", selection: $settings.appColorScheme) {
                ForEach(SettingsStore.AppColorScheme.allCases, id: \.self) { scheme in
                    Text(scheme.label).tag(scheme)
                }
            }
            .pickerStyle(.segmented)
        } header: {
            Text("Appearance")
        } footer: {
            Text("System follows the iOS display setting. Dark is the default for night / low-light operations.")
                .font(.system(size: 11))
                .foregroundColor(.safetTextDim)
        }
        .listRowBackground(Color.safetSurface)
    }

    // MARK: - Account

    private var accountSection: some View {
        Section("Account") {
            row("Operator", state.operatorDisplayName)
            row("Unit", state.localShortUnitId)
            if !state.agencyName.isEmpty {
                row("Agency", state.agencyName)
            }
        }
        .listRowBackground(Color.safetSurface)
    }

    // MARK: - Controls

    private var controlsSection: some View {
        Section {
            Toggle("Large PTT button", isOn: $settings.bigPttButtonEnabled)
                .tint(.safetGreen)
                .foregroundColor(.safetText)
            Toggle("Hardware PTT (Volume Down / Action Button)", isOn: $settings.hardwarePttEnabled)
                .tint(.safetGreen)
                .foregroundColor(.safetText)
        } header: {
            Text("Controls")
        } footer: {
            Text("Volume Down (held) keys the mic while the radio screen is open. On iPhone 15 Pro and later, bind the Action Button to the 'Start PTT' / 'Stop PTT' shortcuts via Settings → Action Button.")
                .font(.system(size: 11))
                .foregroundColor(.safetTextDim)
        }
        .listRowBackground(Color.safetSurface)
    }

    // MARK: - Audio

    private var audioSection: some View {
        Section {
            Toggle("Notification Sounds", isOn: $settings.notificationSoundsEnabled)
                .tint(.safetGreen)
                .foregroundColor(.safetText)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Playback Volume")
                        .foregroundColor(.safetText)
                    Spacer()
                    Text("\(Int(settings.playbackVolume * 100))%")
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundColor(.safetTextDim)
                }
                Slider(value: $settings.playbackVolume, in: 0...1, step: 0.05)
                    .tint(.safetGreen)
            }
            .padding(.vertical, 4)
            Picker("Audio Route", selection: $settings.audioRoute) {
                ForEach(SettingsStore.AudioRoute.allCases, id: \.self) { route in
                    Label(route.label, systemImage: route.icon).tag(route)
                }
            }
            .foregroundColor(.safetText)
            .tint(.safetGreen)
        } header: {
            Text("Audio")
        } footer: {
            Text("Notification sounds cover channel-switch beeps and PTT cues. Emergency alerts always play regardless of this setting. Playback volume controls incoming voice audio.")
                .font(.system(size: 11))
                .foregroundColor(.safetTextDim)
        }
        .listRowBackground(Color.safetSurface)
    }

    // MARK: - Scan

    private var scanSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { state.scanActive },
                set: { _ in onEvent(.toggleScan) }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Scan")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.safetText)
                    Text(scanSubtitle)
                        .font(.system(size: 11))
                        .foregroundColor(.safetTextDim)
                }
            }
            .tint(.safetGreen)
            NavigationLink {
                ScanPickerScreen(
                    channels: state.channelCatalog,
                    homeChannel: tunedChannel,
                    selection: Binding(
                        get: { state.scanIncludedChannels },
                        set: { onEvent(.setScanChannels($0)) }
                    )
                )
            } label: {
                HStack {
                    Text("Scan Channels")
                        .foregroundColor(.safetText)
                    Spacer()
                    Text(scanChannelsLabel)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundColor(.safetTextDim)
                }
            }
            .disabled(state.channelCatalog.isEmpty)
        } header: {
            Text("Scan")
        } footer: {
            Text("Scan opens extra listen-only streams for the channels you pick. The currently tuned channel is always heard.")
                .font(.system(size: 11))
                .foregroundColor(.safetTextDim)
        }
        .listRowBackground(Color.safetSurface)
    }

    // MARK: - GPS

    private var gpsSection: some View {
        Section {
            HStack {
                Image(systemName: state.locationAuthorized ? "location.fill" : "location.slash")
                    .foregroundColor(state.locationAuthorized ? .safetGreen : .safetAmber)
                VStack(alignment: .leading, spacing: 2) {
                    Text("GPS")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.safetText)
                    Text(state.locationAuthorized
                         ? "Reporting position to dispatch"
                         : "Awaiting location permission")
                        .font(.system(size: 11))
                        .foregroundColor(.safetTextDim)
                }
            }
        } header: {
            Text("Location")
        } footer: {
            Text("GPS is always on for unit safety. Change permission in iOS Settings → safeT Mobile.")
                .font(.system(size: 11))
                .foregroundColor(.safetTextDim)
        }
        .listRowBackground(Color.safetSurface)
    }

    // MARK: - About

    private var aboutSection: some View {
        Section("About") {
            row("App", "safeT Mobile")
            row("Version", appVersion)
            row("Server", RadioConfig.apiBaseURL.host(percentEncoded: false) ?? "—")
        }
        .listRowBackground(Color.safetSurface)
    }

    // MARK: - Sign out

    private var signOutSection: some View {
        Section {
            Button(role: .destructive) {
                confirmingSignOut = true
            } label: {
                HStack {
                    Image(systemName: "rectangle.portrait.and.arrow.right")
                        .accessibilityHidden(true)
                    Text("Sign Out…")
                        .font(.system(size: 15, weight: .semibold))
                }
                .foregroundColor(.safetRed)
            }
            .accessibilityLabel("Sign Out…")
        }
        .listRowBackground(Color.safetSurface)
    }

    // MARK: - Helpers

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.body)
                .foregroundColor(.safetTextDim)
            Spacer()
            Text(value)
                .font(.system(.footnote, design: .monospaced))
                .foregroundColor(.safetText)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .accessibilityElement(children: .combine)
    }

    private var tunedChannel: String? {
        state.channelLabel == "----" ? nil : state.channelLabel
    }

    private var scanSubtitle: String {
        if state.scanActive {
            let home = tunedChannel?.lowercased() ?? ""
            let listening = state.scanIncludedChannels.filter { $0 != home }.count
            return listening > 0 ? "Listening to \(listening) channel\(listening == 1 ? "" : "s")" : "Pick channels below"
        }
        return "Off"
    }

    private var scanChannelsLabel: String {
        let count = state.scanIncludedChannels.count
        return count > 0 ? "\(count) selected" : "None"
    }

    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "0.0"
        let build = info?["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }
}
