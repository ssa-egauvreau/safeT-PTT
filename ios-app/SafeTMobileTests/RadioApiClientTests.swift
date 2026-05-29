import XCTest
@testable import SafeTMobile

final class RadioApiClientTests: XCTestCase {
    private let baseURL = URL(string: "https://radio.example.com")!

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    private func makeClient(token: String? = "test-token") -> RadioApiClient {
        RadioApiClient(baseURL: baseURL, token: token, session: StubURLProtocol.makeSession())
    }

    // MARK: - channels()

    func test_channels_hitsMeChannels_withBearerAuth_andDecodesResponse() async throws {
        StubURLProtocol.handler = { _ in
            let json = #"{ "channels": [{ "id": 1, "name": "OPS-1" }, { "id": 2, "name": "OPS-2" }] }"#
            return .init(body: Data(json.utf8))
        }

        let channels = try await makeClient().channels()

        XCTAssertEqual(channels.map(\.id), [1, 2])
        XCTAssertEqual(channels.map(\.name), ["OPS-1", "OPS-2"])

        let request = try XCTUnwrap(StubURLProtocol.observedRequests.first)
        XCTAssertEqual(request.url?.path, "/v1/me/channels")
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-Radio-Key"))
    }

    func test_authHeader_isOmitted_whenTokenIsNil() async throws {
        StubURLProtocol.handler = { _ in .init(body: Data(#"{ "channels": [] }"#.utf8)) }

        _ = try await makeClient(token: nil).channels()

        let request = try XCTUnwrap(StubURLProtocol.observedRequests.first)
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    }

    func test_authHeader_isOmitted_whenTokenIsBlank() async throws {
        StubURLProtocol.handler = { _ in .init(body: Data(#"{ "channels": [] }"#.utf8)) }

        _ = try await makeClient(token: "").channels()

        let request = try XCTUnwrap(StubURLProtocol.observedRequests.first)
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    }

    func test_non2xx_throwsBadStatus() async {
        StubURLProtocol.handler = { _ in .init(statusCode: 503) }

        do {
            _ = try await makeClient().channels()
            XCTFail("expected RadioApiError.badStatus")
        } catch let RadioApiError.badStatus(code) {
            XCTAssertEqual(code, 503)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    // MARK: - airState()

    func test_airState_includesChannelQuery_andDecodesSnakeCase() async throws {
        StubURLProtocol.handler = { _ in
            let json = #"{ "occupied": true, "transmitting_unit_id": "A1B2C3", "transmitting_display_name": "Patrol 1" }"#
            return .init(body: Data(json.utf8))
        }

        let air = try await makeClient().airState(channel: "OPS-1")

        XCTAssertTrue(air.occupied)
        XCTAssertEqual(air.transmittingUnitId, "A1B2C3")
        XCTAssertEqual(air.transmittingDisplayName, "Patrol 1")

        let request = try XCTUnwrap(StubURLProtocol.observedRequests.first)
        let comps = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
        XCTAssertEqual(comps?.path, "/v1/air")
        XCTAssertEqual(comps?.queryItems, [URLQueryItem(name: "channel", value: "OPS-1")])
    }

    func test_airState_omitsQuery_whenChannelIsNil() async throws {
        StubURLProtocol.handler = { _ in .init(body: Data(#"{ "occupied": false }"#.utf8)) }

        _ = try await makeClient().airState(channel: nil)

        let request = try XCTUnwrap(StubURLProtocol.observedRequests.first)
        XCTAssertNil(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems)
    }

    // MARK: - presenceHeartbeat() / presenceCount()

    func test_presenceHeartbeat_postsSnakeCaseBody() async throws {
        StubURLProtocol.handler = { _ in .init(body: Data()) }

        try await makeClient().presenceHeartbeat(unitId: "A1B2C3", channel: "OPS-1")

        let request = try XCTUnwrap(StubURLProtocol.observedRequests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/v1/presence/heartbeat")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")

        let body = try XCTUnwrap(request.httpBody)
        let decoded = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertEqual(decoded?["unit_id"] as? String, "A1B2C3")
        XCTAssertEqual(decoded?["channel"] as? String, "OPS-1")
    }

    func test_presenceCount_decodesCount() async throws {
        StubURLProtocol.handler = { _ in .init(body: Data(#"{ "count": 7 }"#.utf8)) }

        let count = try await makeClient().presenceCount(channel: "OPS-1")

        XCTAssertEqual(count, 7)
    }

    // MARK: - inbox()

    func test_inbox_decodesSnakeCaseAlerts_andSendsExpectedQuery() async throws {
        StubURLProtocol.handler = { _ in
            let json = """
            {
              "alerts": [
                {
                  "id": 42,
                  "kind": "emergency",
                  "channel_name": "OPS-1",
                  "from_unit": "A1B2C3",
                  "from_name": "Unit 7",
                  "message": "help",
                  "active": true
                }
              ],
              "last_id": 42
            }
            """
            return .init(body: Data(json.utf8))
        }

        let response = try await makeClient().inbox(unit: "Z9Z9Z9", channel: "OPS-1", since: 17)

        XCTAssertEqual(response.lastId, 42)
        XCTAssertEqual(response.alerts.first?.kind, "emergency")
        XCTAssertEqual(response.alerts.first?.fromUnit, "A1B2C3")

        let request = try XCTUnwrap(StubURLProtocol.observedRequests.first)
        let items = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertEqual(items.first { $0.name == "unit" }?.value, "Z9Z9Z9")
        XCTAssertEqual(items.first { $0.name == "since" }?.value, "17")
        XCTAssertEqual(items.first { $0.name == "channel" }?.value, "OPS-1")
    }

    // MARK: - talkActivity()

    func test_talkActivity_decodesMainAndScan() async throws {
        StubURLProtocol.handler = { _ in
            let json = """
            {
              "main": {
                "channel": "OPS-1",
                "active": true,
                "unit_id": "A1",
                "username": "Patrol"
              },
              "scan": {
                "channel": "OPS-2",
                "active": false,
                "unit_id": null,
                "username": null
              }
            }
            """
            return .init(body: Data(json.utf8))
        }

        let ta = try await makeClient().talkActivity(home: "OPS-1", scan: "OPS-2")
        XCTAssertEqual(ta.main?.unitId, "A1")
        XCTAssertEqual(ta.main?.username, "Patrol")
        XCTAssertEqual(ta.scan?.active, false)
    }

    // MARK: - setEmergency()

    func test_setEmergency_encodesAllFields_andOmitsNilMessage() async throws {
        StubURLProtocol.handler = { _ in .init(body: Data()) }

        try await makeClient().setEmergency(
            unitId: "A1B2C3",
            channel: "OPS-1",
            active: true,
            message: nil
        )

        let request = try XCTUnwrap(StubURLProtocol.observedRequests.first)
        XCTAssertEqual(request.url?.path, "/v1/radio/emergency")
        let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any]
        XCTAssertEqual(body?["unit_id"] as? String, "A1B2C3")
        XCTAssertEqual(body?["channel"] as? String, "OPS-1")
        XCTAssertEqual(body?["active"] as? Bool, true)
        // JSONEncoder emits `null` for nil Optional<String>; both shapes are acceptable to the server.
        if let message = body?["message"] {
            XCTAssertTrue(message is NSNull, "expected null message, got \(message)")
        }
    }
}
