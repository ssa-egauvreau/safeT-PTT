import CoreLocation
import Foundation

/// Reports the handset's GPS position to the server so it appears on the dispatch map.
final class LocationReporter: NSObject, CLLocationManagerDelegate {
    private let api: RadioApiClient
    private let manager = CLLocationManager()

    private var unitId = ""
    private var channel: String?
    private var running = false
    private var lastPostAt = Date.distantPast

    /// Called when location authorization changes; `true` once when-in-use/always is granted.
    var onAuthorizationChange: ((Bool) -> Void)?

    /// Minimum gap between position posts.
    private let minPostInterval: TimeInterval = 12

    init(api: RadioApiClient) {
        self.api = api
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = 25
    }

    func configure(unitId: String) {
        self.unitId = unitId.trimmingCharacters(in: .whitespaces).uppercased()
    }

    func setChannel(_ channel: String?) {
        let trimmed = channel?.trimmingCharacters(in: .whitespaces)
        self.channel = (trimmed?.isEmpty == false && trimmed != "----") ? trimmed : nil
    }

    func start() {
        guard !running else { return }
        running = true
        // UI tests boot with `-uitest-logged-in`; skip the system location
        // prompt so XCTest isn't blocked by SpringBoard's "Allow location?"
        // sheet when tapping SETTINGS or the PTT bar.
        if ProcessInfo.processInfo.arguments.contains("-uitest-logged-in") {
            onAuthorizationChange?(true)
            return
        }
        manager.requestWhenInUseAuthorization()
        manager.startUpdatingLocation()
    }

    func stop() {
        guard running else { return }
        running = false
        manager.stopUpdatingLocation()
    }

    // MARK: - CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last, !unitId.isEmpty else { return }
        let now = Date()
        guard now.timeIntervalSince(lastPostAt) >= minPostInterval else { return }
        lastPostAt = now

        let report = LocationReport(
            unitId: unitId,
            lat: location.coordinate.latitude,
            lon: location.coordinate.longitude,
            channel: channel,
            accuracyM: location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : nil,
            heading: location.course >= 0 ? location.course : nil,
            speedMps: location.speed >= 0 ? location.speed : nil,
            // Always "ios" from this app — server's whitelist accepts it and
            // surfaces a platform badge in the UNITS roster.
            clientType: "ios"
        )
        Task { try? await api.reportLocation(report) }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Non-fatal — the server keeps the last known position.
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let authorized = manager.authorizationStatus == .authorizedWhenInUse
            || manager.authorizationStatus == .authorizedAlways
        onAuthorizationChange?(authorized)
    }
}
