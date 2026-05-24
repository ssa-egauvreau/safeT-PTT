import XCTest
@testable import SafeTMobile

/// LocationReport must omit unknown fields (not send `null`) so the server can
/// treat accuracy/heading/speed as absent rather than zero.
final class LocationReportTests: XCTestCase {
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }()

    func test_encode_omitsNilOptionalFields() throws {
        let report = LocationReport(
            unitId: "A1B2C3",
            lat: 45.5,
            lon: -73.6,
            channel: nil,
            accuracyM: nil,
            heading: nil,
            speedMps: nil,
            clientType: "ios"
        )

        let json = try JSONSerialization.jsonObject(with: encoder.encode(report)) as? [String: Any]
        XCTAssertEqual(json?["unit_id"] as? String, "A1B2C3")
        XCTAssertEqual(json?["lat"] as? Double, 45.5)
        XCTAssertEqual(json?["lon"] as? Double, -73.6)
        XCTAssertNil(json?["channel"])
        XCTAssertNil(json?["accuracy_m"])
        XCTAssertNil(json?["heading"])
        XCTAssertNil(json?["speed_mps"])
        // clientType is required (non-optional) and always serialized so the
        // server can render a platform badge per row in the UNITS roster.
        XCTAssertEqual(json?["client_type"] as? String, "ios")
    }

    func test_encode_includesOptionalFields_whenPresent() throws {
        let report = LocationReport(
            unitId: "A1B2C3",
            lat: 45.5,
            lon: -73.6,
            channel: "OPS-1",
            accuracyM: 12.5,
            heading: 270,
            speedMps: 4.4,
            clientType: "ios"
        )

        let json = try JSONSerialization.jsonObject(with: encoder.encode(report)) as? [String: Any]
        XCTAssertEqual(json?["channel"] as? String, "OPS-1")
        XCTAssertEqual(json?["accuracy_m"] as? Double, 12.5)
        XCTAssertEqual(json?["heading"] as? Double, 270)
        XCTAssertEqual(json?["speed_mps"] as? Double, 4.4)
        XCTAssertEqual(json?["client_type"] as? String, "ios")
    }
}
