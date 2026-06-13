import SwiftUI

/// Roster of every unit reporting location in this agency. Each row shows
/// display name, unit ID, device type (radio / handheld / dispatch console /
/// phone / radio bridge), current channel, and last-seen age. Searchable +
/// pull-to-refresh + polls every 10 s while visible (matches the MAP screen
/// cadence). Sort: ONLINE (last fix < 5 min) first, then by display name.
///
/// Platform (iOS / Android / web) column is intentionally absent for now —
/// the server doesn't track or surface client-type per session. Follow-up PR
/// adds that.
struct UnitsScreen: View {
    let api: RadioApiClient

    @State private var units: [UnitPosition] = []
    @State private var search = ""
    @State private var loading = false
    @State private var error: String?
    @State private var pollTask: Task<Void, Never>?

    /// A unit is "online" if its last position fix is within this window.
    /// Matches the web console's stale-cutoff so iOS and web agree.
    private static let onlineThreshold: TimeInterval = 5 * 60
    private static let pollInterval: Duration = .seconds(10)

    var body: some View {
        content
            .background(Color.safetBackground.ignoresSafeArea())
            .navigationTitle("UNITS")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $search, placement: .automatic, prompt: "Search by unit or name")
            .task {
                await refresh()
                startPolling()
            }
            .onDisappear {
                pollTask?.cancel()
                pollTask = nil
            }
    }

    @ViewBuilder
    private var content: some View {
        if loading && units.isEmpty {
            ProgressView().tint(.safetText).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error, units.isEmpty {
            ScrollView {
                VStack(spacing: 12) {
                    Text("CAN'T LOAD UNITS")
                        .font(.safet(size: 12, weight: .heavy)).foregroundColor(.safetRed)
                    Text(error)
                        .font(.safet(size: 11)).foregroundColor(.safetTextDim)
                        .multilineTextAlignment(.center).padding(.horizontal, 24)
                    Button("RETRY") { Task { await refresh() } }
                        .font(.safet(size: 12, weight: .bold)).foregroundColor(.safetText)
                }
                .frame(maxWidth: .infinity, minHeight: 300)
            }
            .refreshable { await refresh() }
        } else if filteredUnits.isEmpty {
            ScrollView {
                // Spacers + minHeight keep the empty-state text vertically
                // centered inside the scroll viewport (the way it was before
                // `.refreshable` forced the ScrollView wrapper). Without the
                // Spacers the text glues to the top of the visible area.
                VStack {
                    Spacer(minLength: 80)
                    Text(units.isEmpty ? "NO UNITS REPORTING" : "NO MATCHES")
                        .font(.safet(size: 12, weight: .semibold)).foregroundColor(.safetTextDim)
                    Spacer(minLength: 80)
                }
                .frame(maxWidth: .infinity, minHeight: 400)
            }
            .refreshable { await refresh() }
        } else {
            list
        }
    }

    private var list: some View {
        ScrollView {
            // Counts header — "12 ONLINE • 3 OFFLINE" so dispatchers can tell
            // at a glance how many radios are live.
            countsHeader
            LazyVStack(spacing: 6) {
                ForEach(filteredUnits) { unit in
                    row(unit)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .refreshable { await refresh() }
    }

    private var countsHeader: some View {
        let onlineCount = units.filter(isOnline).count
        let offlineCount = units.count - onlineCount
        return HStack(spacing: 12) {
            HStack(spacing: 4) {
                Circle().fill(Color.safetGreen).frame(width: 6, height: 6)
                Text("\(onlineCount) ONLINE")
                    .font(.safet(size: 10, weight: .heavy, design: .monospaced))
                    .foregroundColor(.safetGreen)
            }
            HStack(spacing: 4) {
                Circle().fill(Color.safetTextDim).frame(width: 6, height: 6)
                Text("\(offlineCount) OFFLINE")
                    .font(.safet(size: 10, weight: .heavy, design: .monospaced))
                    .foregroundColor(.safetTextDim)
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    private func row(_ unit: UnitPosition) -> some View {
        let online = isOnline(unit)
        return HStack(spacing: 10) {
            // Status dot + device-type icon stack
            VStack(spacing: 4) {
                Circle()
                    .fill(online ? Color.safetGreen : Color.safetTextDim)
                    .frame(width: 8, height: 8)
                Image(systemName: deviceIcon(unit.deviceType))
                    .font(.safet(size: 14))
                    .foregroundColor(.safetTextDim)
            }
            .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(unit.unitId)
                        .font(.safet(size: 13, weight: .heavy, design: .monospaced))
                        .foregroundColor(.safetText)
                    if let name = unit.displayName, !name.isEmpty {
                        Text(name)
                            .font(.safet(size: 11))
                            .foregroundColor(.safetTextDim)
                            .lineLimit(1)
                    }
                    Spacer()
                    Text(deviceLabel(unit.deviceType))
                        .font(.safet(size: 9, weight: .heavy, design: .monospaced))
                        .foregroundColor(.safetTextDim)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .overlay(Capsule().stroke(Color.safetBorder, lineWidth: 1))
                }
                HStack(spacing: 8) {
                    if let channel = unit.channelName, !channel.isEmpty {
                        Text("CH \(channel)")
                            .font(.safet(size: 10, weight: .semibold, design: .monospaced))
                            .foregroundColor(.safetSignal)
                    } else {
                        Text("NO CHANNEL")
                            .font(.safet(size: 10, weight: .semibold, design: .monospaced))
                            .foregroundColor(.safetTextDim)
                    }
                    Spacer()
                    Text(formatAgo(unit.updatedAt))
                        .font(.safet(size: 10, weight: .medium, design: .monospaced))
                        .foregroundColor(online ? .safetTextDim : .safetAmber)
                    platformBadge(unit.clientType)
                }
            }
        }
        .padding(10)
        .background(Color.safetSurface)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.safetBorder, lineWidth: 1))
        .cornerRadius(8)
    }

    // MARK: - data

    private var filteredUnits: [UnitPosition] {
        let trimmed = search.trimmingCharacters(in: .whitespaces).lowercased()
        let base: [UnitPosition]
        if trimmed.isEmpty {
            base = units
        } else {
            base = units.filter {
                $0.unitId.lowercased().contains(trimmed)
                    || ($0.displayName?.lowercased().contains(trimmed) ?? false)
            }
        }
        // Stable sort: online before offline, then alphabetical by display
        // name then unit ID. Avoids units jumping around between polls.
        return base.sorted { a, b in
            let aOnline = isOnline(a)
            let bOnline = isOnline(b)
            if aOnline != bOnline { return aOnline }
            let aKey = (a.displayName ?? a.unitId).lowercased()
            let bKey = (b.displayName ?? b.unitId).lowercased()
            if aKey != bKey { return aKey < bKey }
            return a.unitId < b.unitId
        }
    }

    private func isOnline(_ unit: UnitPosition) -> Bool {
        guard let date = parseServerDate(unit.updatedAt) else { return false }
        return -date.timeIntervalSinceNow < Self.onlineThreshold
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.pollInterval)
                if Task.isCancelled { break }
                await refresh()
            }
        }
    }

    private func refresh() async {
        loading = true
        defer { loading = false }
        do {
            units = try await api.positions()
            error = nil
        } catch {
            self.error = "\(error)"
        }
    }

    // MARK: - device type rendering

    /// Maps the server's device_type string to an SF Symbol.
    /// Server enum (see server/src/store.ts DEVICE_TYPES):
    ///   unit_radio, handheld, dispatch_console, phone, radio_bridge
    private func deviceIcon(_ type: String?) -> String {
        switch type {
        case "unit_radio": return "car.fill"
        case "handheld": return "antenna.radiowaves.left.and.right"
        case "dispatch_console": return "rectangle.inset.filled.on.rectangle"
        case "phone": return "iphone"
        case "radio_bridge": return "arrow.left.arrow.right.circle"
        default: return "questionmark.circle"
        }
    }

    /// Short label shown in the device-type chip on each row.
    private func deviceLabel(_ type: String?) -> String {
        switch type {
        case "unit_radio": return "IN-CAR"
        case "handheld": return "RADIO"
        case "dispatch_console": return "DISPATCH"
        case "phone": return "PHONE"
        case "radio_bridge": return "BRIDGE"
        default: return "—"
        }
    }

    // MARK: - platform badge

    /// Compact text badge for the platform the unit is reporting from.
    /// Text badges (not SF Symbols) so the look is consistent across iOS / web
    /// / Android — Apple-provided symbols for non-Apple platforms are
    /// inconsistent. Nil clientType (pre-tracking clients) renders as "—".
    @ViewBuilder
    private func platformBadge(_ clientType: String?) -> some View {
        if let clientType {
            Text(platformLabel(clientType))
                .font(.safet(size: 9, weight: .heavy, design: .monospaced))
                .foregroundColor(platformColor(clientType))
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .overlay(RoundedRectangle(cornerRadius: 3).stroke(platformColor(clientType).opacity(0.6), lineWidth: 1))
        } else {
            Text("—")
                .font(.safet(size: 10, weight: .heavy, design: .monospaced))
                .foregroundColor(.safetTextDim.opacity(0.4))
        }
    }

    private func platformLabel(_ clientType: String) -> String {
        switch clientType {
        case "ios": return "iOS"
        case "android": return "AND"
        case "web": return "WEB"
        case "desktop": return "DESK"
        case "radio": return "RAD"
        default: return clientType.uppercased()
        }
    }

    private func platformColor(_ clientType: String) -> Color {
        switch clientType {
        case "ios": return .safetText
        case "android": return .safetGreen
        case "web": return .safetSignal
        case "desktop": return .safetAmber
        case "radio": return .safetRed
        default: return .safetTextDim
        }
    }

    // MARK: - date formatting

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let iso8601NoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private func parseServerDate(_ raw: String) -> Date? {
        Self.iso8601.date(from: raw) ?? Self.iso8601NoFractional.date(from: raw)
    }

    private func formatAgo(_ raw: String) -> String {
        guard let date = parseServerDate(raw) else { return raw }
        let seconds = Int(-date.timeIntervalSinceNow)
        if seconds < 5 { return "now" }
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3600)h" }
        return "\(seconds / 86_400)d"
    }
}
