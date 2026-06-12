import XCTest
@testable import SafeTMobile

final class SettingsStoreTests: XCTestCase {
    private func freshDefaults() -> UserDefaults {
        UserDefaults(suiteName: "test-\(UUID().uuidString)")!
    }

    func test_hardwarePtt_roundTripsThroughDefaults() {
        let defaults = freshDefaults()
        let store = SettingsStore(defaults: defaults)
        XCTAssertFalse(store.hardwarePttEnabled)
        store.hardwarePttEnabled = true
        XCTAssertTrue(defaults.bool(forKey: "safet.hardwarePttEnabled"))

        let reloaded = SettingsStore(defaults: defaults)
        XCTAssertTrue(reloaded.hardwarePttEnabled)
    }

    func test_audioRoute_roundTripsAsRawValue() {
        let defaults = freshDefaults()
        let store = SettingsStore(defaults: defaults)
        XCTAssertEqual(store.audioRoute, .auto)
        store.audioRoute = .bluetooth
        XCTAssertEqual(defaults.string(forKey: "safet.audioRoute"), "bluetooth")
        let reloaded = SettingsStore(defaults: defaults)
        XCTAssertEqual(reloaded.audioRoute, .bluetooth)
    }
}
