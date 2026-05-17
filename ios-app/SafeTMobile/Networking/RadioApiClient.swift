import Foundation

// MARK: - DTOs

struct ChannelDTO: Decodable, Identifiable {
    let id: Int
    let name: String
}

struct AirState: Decodable {
    let occupied: Bool
    let transmittingUnitId: String?
}

struct InboxAlert: Decodable {
    let id: Int
    let kind: String
    let channelName: String?
    let fromUnit: String?
    let fromName: String?
    let message: String?
    let active: Bool
}

struct InboxResponse: Decodable {
    let alerts: [InboxAlert]
    let lastId: Int
}

/// Body of `POST /v1/radio/location`. Unknown fields are omitted (not sent as
/// null) so the server treats missing accuracy/heading/speed as absent.
struct LocationReport: Encodable {
    let unitId: String
    let lat: Double
    let lon: Double
    let channel: String?
    let accuracyM: Double?
    let heading: Double?
    let speedMps: Double?

    enum CodingKeys: String, CodingKey {
        case unitId, lat, lon, channel, accuracyM, heading, speedMps
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(unitId, forKey: .unitId)
        try container.encode(lat, forKey: .lat)
        try container.encode(lon, forKey: .lon)
        try container.encodeIfPresent(channel, forKey: .channel)
        try container.encodeIfPresent(accuracyM, forKey: .accuracyM)
        try container.encodeIfPresent(heading, forKey: .heading)
        try container.encodeIfPresent(speedMps, forKey: .speedMps)
    }
}

enum RadioApiError: Error {
    case invalidURL
    case badStatus(Int)
}

// MARK: - Client

/// Talks to the safeT PTT server's handset endpoints (shared-key auth).
final class RadioApiClient {
    private let baseURL: URL
    private let apiKey: String
    private let session: URLSession

    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }()

    init(
        baseURL: URL = RadioConfig.apiBaseURL,
        apiKey: String = RadioConfig.radioApiKey,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.session = session
    }

    func channels() async throws -> [ChannelDTO] {
        struct Response: Decodable { let channels: [ChannelDTO] }
        return try await get("v1/channels", as: Response.self).channels
    }

    func airState(channel: String?) async throws -> AirState {
        let query = channel.map { [URLQueryItem(name: "channel", value: $0)] } ?? []
        return try await get("v1/air", query: query, as: AirState.self)
    }

    func presenceHeartbeat(unitId: String, channel: String) async throws {
        struct Body: Encodable { let unitId: String; let channel: String }
        try await post("v1/presence/heartbeat", body: Body(unitId: unitId, channel: channel))
    }

    func presenceCount(channel: String) async throws -> Int {
        struct Response: Decodable { let count: Int }
        let query = [URLQueryItem(name: "channel", value: channel)]
        return try await get("v1/presence/count", query: query, as: Response.self).count
    }

    func reportLocation(_ report: LocationReport) async throws {
        try await post("v1/radio/location", body: report)
    }

    func inbox(unit: String, channel: String?, since: Int) async throws -> InboxResponse {
        var query = [
            URLQueryItem(name: "unit", value: unit),
            URLQueryItem(name: "since", value: String(since)),
        ]
        if let channel { query.append(URLQueryItem(name: "channel", value: channel)) }
        return try await get("v1/radio/inbox", query: query, as: InboxResponse.self)
    }

    func setEmergency(unitId: String, channel: String?, active: Bool, message: String?) async throws {
        struct Body: Encodable {
            let unitId: String
            let channel: String?
            let active: Bool
            let message: String?
        }
        try await post(
            "v1/radio/emergency",
            body: Body(unitId: unitId, channel: channel, active: active, message: message)
        )
    }

    // MARK: - transport

    private func get<T: Decodable>(
        _ path: String,
        query: [URLQueryItem] = [],
        as type: T.Type
    ) async throws -> T {
        var components = URLComponents(
            url: baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        )
        if !query.isEmpty { components?.queryItems = query }
        guard let url = components?.url else { throw RadioApiError.invalidURL }
        var request = URLRequest(url: url)
        applyAuth(&request)
        return try await send(request, as: type)
    }

    private func post<B: Encodable>(_ path: String, body: B) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        applyAuth(&request)
        try await sendDiscardingBody(request)
    }

    private func applyAuth(_ request: inout URLRequest) {
        if !apiKey.isEmpty {
            request.setValue(apiKey, forHTTPHeaderField: "X-Radio-Key")
        }
    }

    private func send<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let data = try await sendDiscardingBody(request)
        return try decoder.decode(type, from: data)
    }

    @discardableResult
    private func sendDiscardingBody(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(status) else {
            throw RadioApiError.badStatus(status)
        }
        return data
    }
}
