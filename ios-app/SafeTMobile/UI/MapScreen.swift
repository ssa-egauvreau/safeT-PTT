import CoreLocation
import MapKit
import SwiftUI

/// Live unit map. Polls `GET /v1/locations` every 5 s while visible and
/// renders one marker per unit via MKMapView (clustering at zoom-out, follow-me
/// toggle). Auto-fits the viewport on first load.
struct MapScreen: View {
    let api: RadioApiClient

    @State private var positions: [UnitPosition] = []
    @State private var region = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 39.5, longitude: -98.35), // continental US fallback
        span: MKCoordinateSpan(latitudeDelta: 40, longitudeDelta: 60)
    )
    @State private var didAutoFit = false
    @State private var pollTask: Task<Void, Never>?
    @State private var selectedUnit: String?
    @State private var loadError: String?
    @State private var followMe = false

    /// Polling cadence — mirrors the web console.
    private static let pollInterval: Duration = .seconds(5)

    var body: some View {
        ZStack(alignment: .bottom) {
            MapKitMap(
                region: $region,
                positions: positions,
                followMe: $followMe,
                selectedUnit: $selectedUnit
            )
            .ignoresSafeArea(edges: .bottom)
            .overlay(alignment: .top) {
                if let loadError {
                    Text(loadError)
                        .font(.safet(size: 11, weight: .bold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(Color.safetRed)
                        .cornerRadius(6)
                        .padding(.top, 8)
                }
            }
            footer
        }
        .navigationTitle("UNIT MAP")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    followMe.toggle()
                } label: {
                    Image(systemName: followMe ? "location.fill" : "location")
                        .foregroundColor(.safetText)
                }
                .accessibilityLabel(followMe ? "Stop following me" : "Follow me")
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    fitToPositions(animated: true)
                } label: {
                    Image(systemName: "scope")
                        .foregroundColor(.safetText)
                }
                .disabled(positions.isEmpty)
            }
        }
        .task {
            await loadOnce()
            startPolling()
        }
        .onDisappear {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    @ViewBuilder
    private var footer: some View {
        if let selectedUnit, let position = positions.first(where: { $0.unitId == selectedUnit }) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(position.unitId)
                        .font(.safet(size: 14, weight: .heavy, design: .monospaced))
                        .foregroundColor(.safetText)
                    if let name = position.displayName, !name.isEmpty {
                        Text("• \(name)")
                            .font(.safet(size: 12))
                            .foregroundColor(.safetTextDim)
                    }
                    Spacer()
                    Button {
                        self.selectedUnit = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundColor(.safetTextDim)
                    }
                }
                HStack(spacing: 12) {
                    if let channel = position.channelName, !channel.isEmpty {
                        Text("CH \(channel)")
                            .font(.safet(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundColor(.safetSignal)
                    }
                    Text(formatAgo(position.updatedAt))
                        .font(.safet(size: 11, weight: .medium, design: .monospaced))
                        .foregroundColor(.safetTextDim)
                    if let speed = position.speedMps {
                        Text(String(format: "%.0f m/s", speed))
                            .font(.safet(size: 11, weight: .medium, design: .monospaced))
                            .foregroundColor(.safetTextDim)
                    }
                }
            }
            .padding(12)
            .background(Color.safetSurface)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.safetBorder, lineWidth: 1))
            .cornerRadius(10)
            .padding(.horizontal, 12)
            .padding(.bottom, 10)
        } else if positions.isEmpty {
            Text("NO UNITS REPORTING")
                .font(.safet(size: 11, weight: .heavy, design: .monospaced))
                .foregroundColor(.safetTextDim)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Color.safetSurface.opacity(0.92))
                .cornerRadius(6)
                .padding(.bottom, 12)
        }
    }

    // MARK: - polling

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

    private func loadOnce() async {
        // First load happens here; subsequent polls go through refresh()
        // directly. Auto-fit lives inside refresh() so that even if the very
        // first response is empty (or fails), the first non-empty response
        // from a later poll still recentres the map without the operator
        // having to tap the scope button.
        await refresh()
    }

    private func refresh() async {
        do {
            positions = try await api.positions()
            loadError = nil
            // Auto-fit on the first non-empty payload — guards against the
            // initial fetch returning [] (or failing) and leaving the viewport
            // stuck on the continental-US fallback forever.
            if !didAutoFit, !positions.isEmpty {
                fitToPositions(animated: false)
                didAutoFit = true
            }
        } catch {
            loadError = "MAP REFRESH FAILED — \(error)"
        }
    }

    /// Re-centre + zoom to fit all current positions. Skips when the list is
    /// empty (would zoom to nowhere). Adds a 30% padding on each axis so pins
    /// aren't pinned to the edges of the viewport.
    private func fitToPositions(animated: Bool) {
        guard !positions.isEmpty else { return }
        if positions.count == 1, let p = positions.first {
            let coord = CLLocationCoordinate2D(latitude: p.lat, longitude: p.lon)
            let newRegion = MKCoordinateRegion(
                center: coord,
                span: MKCoordinateSpan(latitudeDelta: 0.02, longitudeDelta: 0.02)
            )
            withMaybeAnimation(animated) { region = newRegion }
            return
        }
        let lats = positions.map(\.lat)
        let lons = positions.map(\.lon)
        let minLat = lats.min()!
        let maxLat = lats.max()!
        let minLon = lons.min()!
        let maxLon = lons.max()!
        let centre = CLLocationCoordinate2D(
            latitude: (minLat + maxLat) / 2,
            longitude: (minLon + maxLon) / 2
        )
        let span = MKCoordinateSpan(
            latitudeDelta: max((maxLat - minLat) * 1.3, 0.01),
            longitudeDelta: max((maxLon - minLon) * 1.3, 0.01)
        )
        let newRegion = MKCoordinateRegion(center: centre, span: span)
        withMaybeAnimation(animated) { region = newRegion }
    }

    private func withMaybeAnimation(_ animated: Bool, _ body: () -> Void) {
        if animated {
            withAnimation(.easeInOut(duration: 0.4)) { body() }
        } else {
            body()
        }
    }

    // MARK: - formatting

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

    private func formatAgo(_ raw: String) -> String {
        let date = Self.iso8601.date(from: raw) ?? Self.iso8601NoFractional.date(from: raw)
        guard let date else { return raw }
        let seconds = Int(-date.timeIntervalSinceNow)
        if seconds < 5 { return "now" }
        if seconds < 60 { return "\(seconds)s ago" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        if seconds < 86_400 { return "\(seconds / 3600)h ago" }
        return "\(seconds / 86_400)d ago"
    }
}
