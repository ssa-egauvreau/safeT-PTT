import Foundation

// MARK: - DTOs

struct ChannelDTO: Decodable, Identifiable {
    let id: Int
    let name: String
    /// Zone bank name from the portal ("PATROL", "Simulcast", …); nil/blank when
    /// the channel isn't grouped into a zone.
    let zone: String?
    /// Zone bank number shown in front of the channel name on the display
    /// ("1 GREEN 1"). nil when ungrouped. Decoded from JSON `zone_number` via
    /// the client's `convertFromSnakeCase` strategy.
    let zoneNumber: Int?
    /// Server permission grant for this channel — "listen_only" | "talk" |
    /// "talk_priority". Drives the PTT gate (listen-only channels can't key).
    let permission: String?
    /// True when the AI dispatcher is enabled on this channel (radios show an AI badge).
    /// Decoded from JSON `ai_dispatch_enabled` via `convertFromSnakeCase`.
    let aiDispatchEnabled: Bool?
    /// Three-way AI dispatch engagement mode: "off" | "supervised" | "full_auto".
    /// Decoded from JSON `ai_dispatch_mode` via `convertFromSnakeCase`.
    let aiDispatchMode: String?
}

struct AirState: Decodable {
    let occupied: Bool
    let transmittingUnitId: String?
    let transmittingDisplayName: String?
    /// When true, keyed traffic is from a yielding bridge/AI — local PTT is allowed.
    let transmittingYields: Bool?
}

struct TalkerSnapshot: Decodable {
    let channel: String
    let active: Bool
    let unitId: String?
    let username: String?
}

struct TalkActivity: Decodable {
    let main: TalkerSnapshot?
    let scan: TalkerSnapshot?
}

struct InboxAlert: Decodable {
    let id: Int
    let kind: String
    let channelName: String?
    /// Set when the page is directed at one unit; nil for a channel/all broadcast.
    let targetUnit: String?
    let fromUnit: String?
    let fromName: String?
    let message: String?
    let active: Bool
    let createdAt: String?
    /// True when the page carries a picture attachment (fetched lazily).
    let hasImage: Bool?
    // NOTE: all field names are camelCase to match the client's
    // `.convertFromSnakeCase` decoder (channel_name → channelName, etc.).
}

/// Request body for POST /v1/radio/alerts/{id}/ack-response.
struct AlertResponseDto: Encodable {
    let unit: String
    let response: String
}

/// The `ai_activity` block from `/radio/inbox` — what the AI dispatcher is doing
/// right now on the tuned channel. `for_you` is true when this radio is the unit
/// she's responding to (drives the full thinking cue vs. a quiet net-wide one).
///
/// No explicit CodingKeys: the client decoder uses `.convertFromSnakeCase`, which
/// rewrites `for_you` → `forYou` BEFORE matching, so a `case forYou = "for_you"`
/// would never match (that's why the AI overlay never appeared).
struct InboxAiActivity: Decodable {
    let phase: String
    let unit: String
    let forYou: Bool
    let text: String?
    /// Clean, screen-friendly reply (no phonetics). For a plate/VIN return this
    /// is "8ABC123 — 2019 Toyota Camry" instead of the spelled-out TTS. Prefer
    /// this over `text` for display; falls back to `text` when absent.
    /// (`.convertFromSnakeCase` rewrites `display_text` → `displayText`.)
    let displayText: String?
    /// Literal queried plate for a plate return (e.g. "8ABC123").
    let plate: String?
    /// Full VIN for a plate/VIN return — render whole with the last 6 bold.
    let vin: String?
    let tag: String?
}

struct InboxResponse: Decodable {
    let alerts: [InboxAlert]
    let lastId: Int
    /// Channel names with 10-33 (emergency traffic) active — from inbox poll.
    let ten33: [String]
    /// Live AI-dispatcher activity on the tuned channel (thinking / speaking),
    /// or nil when she's idle. Drives the Siri-style on-radio overlay.
    let aiActivity: InboxAiActivity?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        alerts = try c.decode([InboxAlert].self, forKey: .alerts)
        lastId = try c.decode(Int.self, forKey: .lastId)
        ten33 = try c.decodeIfPresent([String].self, forKey: .ten33) ?? []
        aiActivity = try c.decodeIfPresent(InboxAiActivity.self, forKey: .aiActivity)
    }

    // Keys are matched against the `.convertFromSnakeCase`-converted JSON, so
    // `ai_activity` arrives as `aiActivity` — the case must be camelCase.
    private enum CodingKeys: String, CodingKey {
        case alerts, lastId, ten33, aiActivity
    }
}

/// One row from `GET /v1/transmissions`. Maps the server `TransmissionRow`.
/// `transcriptStatus` is one of `"pending"` | `"done"` | `"failed"` |
/// `"disabled"` (see server/src/store.ts and aiDispatch/engine.ts). UI
/// renders a spinner, the text, an error tag, or a "transcription off"
/// note accordingly.
struct Transmission: Decodable, Identifiable, Hashable {
    let id: Int
    let channelName: String
    let unitId: String?
    let displayName: String?
    let startedAt: String
    let durationMs: Int
    let transcript: String?
    let transcriptStatus: String
}

/// One row from `GET /v1/tone-outs` — soundboard entry metadata. Audio bytes
/// are fetched on demand via `toneOutAudio(id:)`. `playMode` is one of
/// "single" | "loop" | "once_per_press" (server-side enum); we only use the
/// name here for display.
struct ToneOut: Decodable, Identifiable, Hashable {
    let id: Int
    let name: String
    let playMode: String
    let iconKind: String
    let iconColor: String
    let hasImage: Bool
    let hasAudio: Bool
    let sortOrder: Int
}

/// One row from `GET /v1/locations`. Mirrors server `RadioPosition`. All
/// position fields are required; channel / display / accuracy / heading /
/// speed / device type / client type are optional metadata.
/// `clientType` is "ios" | "android" | "web" | "radio" | "desktop" or nil if
/// the reporting client hasn't been updated to send the field yet.
struct UnitPosition: Decodable, Identifiable, Hashable {
    var id: String { unitId }
    let unitId: String
    let displayName: String?
    let channelName: String?
    let lat: Double
    let lon: Double
    let accuracyM: Double?
    let heading: Double?
    let speedMps: Double?
    let deviceType: String?
    let clientType: String?
    let updatedAt: String
}

/// Body of `POST /v1/radio/location`. Unknown fields are omitted (not sent as
/// null) so the server treats missing accuracy/heading/speed as absent.
/// `clientType` is always sent as "ios" — server uses it to render the
/// platform badge in the UNITS roster and on the live map.
struct LocationReport: Encodable {
    let unitId: String
    let lat: Double
    let lon: Double
    let channel: String?
    let accuracyM: Double?
    let heading: Double?
    let speedMps: Double?
    let clientType: String

    enum CodingKeys: String, CodingKey {
        case unitId, lat, lon, channel, accuracyM, heading, speedMps, clientType
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
        try container.encode(clientType, forKey: .clientType)
    }
}

/// Response shape for `GET /v1/audio/config`. `config` is `nil` when no admin
/// has pushed agency audio settings yet — the handset just keeps its defaults.
/// `updatedAt` is server-stamped ISO-8601; the iOS client doesn't consult it,
/// but it's surfaced for parity with the web's `AudioConfigSummaryResponse`.
struct AudioConfigSummaryResponse: Decodable {
    let config: AudioConfigSummary?
    let updatedAt: String?
}

/// Device-friendly summary of the agency-wide audio config. Mirrors the
/// server-side `DeviceAudioConfig` (`server/src/audioConfig.ts`) and the
/// Android `AudioConfigDto`. iOS currently consumes only the `postDecode`
/// RX uses `postDecode`; TX uses `bypassMicProcessing` via `VoiceTransport`.
struct AudioConfigSummary: Decodable {
    let agcEnabled: Bool?
    let noiseSuppression: Bool?
    let gainMultiplier: Double?
    let bypassMicProcessing: Bool?
    let postDecode: PostDecodeSummary?
}

/// Verbatim subset of `AudioLabConfig.postDecode` the handset consumes on
/// RX. Optional fields fall back to safe "feature off" defaults inside
/// `PostDecodeChain.Config` so a partial config from any vintage of admin
/// push produces a coherent processor.
struct PostDecodeSummary: Decodable {
    let upsampleMode: String?
    let hpfEnabled: Bool?
    let hpfHz: Double?
    let lpfEnabled: Bool?
    let lpfHz: Double?
    let lowShelfEnabled: Bool?
    let lowShelfHz: Double?
    let lowShelfDb: Double?
    let highShelfEnabled: Bool?
    let highShelfHz: Double?
    let highShelfDb: Double?
    let presenceEnabled: Bool?
    let presenceHz: Double?
    let presenceDb: Double?
    let presenceQ: Double?
    let saturationAmount: Double?
    /// Run the chain on the Opus (16 kHz) path too. Shapes nothing on its own.
    let wideband: Bool?
    /// Feed-forward compressor, after the biquads and before saturation.
    let compressorEnabled: Bool?
    let compressorThresholdDb: Double?
    let compressorRatio: Double?
    let compressorAttackMs: Double?
    let compressorReleaseMs: Double?
    let compressorMakeupDb: Double?
    /// End-of-transmission cue, synthesized locally on `air_released`.
    let rogerBeepEnabled: Bool?
    let rogerBeepHz: Double?
    let rogerBeepMs: Double?
    let squelchTailEnabled: Bool?
    let squelchTailMs: Double?
    let squelchTailLevel: Double?

    /// Build the typed `PostDecodeChain.Config` the processor consumes.
    /// Optional fields default to the documented "feature off" values so an
    /// older server (or a partial push) produces a coherent chain.
    func toConfig() -> PostDecodeChain.Config {
        return PostDecodeChain.Config(
            upsampleMode: PostDecodeChain.UpsampleMode(upsampleMode),
            hpfEnabled: hpfEnabled ?? false,
            hpfHz: hpfHz ?? 250,
            lpfEnabled: lpfEnabled ?? false,
            lpfHz: lpfHz ?? 3300,
            lowShelfEnabled: lowShelfEnabled ?? false,
            lowShelfHz: lowShelfHz ?? 200,
            lowShelfDb: lowShelfDb ?? 0,
            highShelfEnabled: highShelfEnabled ?? false,
            highShelfHz: highShelfHz ?? 2500,
            highShelfDb: highShelfDb ?? 0,
            presenceEnabled: presenceEnabled ?? false,
            presenceHz: presenceHz ?? 2200,
            presenceDb: presenceDb ?? 0,
            presenceQ: presenceQ ?? 1.0,
            saturationAmount: saturationAmount ?? 0,
            wideband: wideband ?? false,
            compressorEnabled: compressorEnabled ?? false,
            compressorThresholdDb: compressorThresholdDb ?? -24,
            compressorRatio: compressorRatio ?? 3.0,
            compressorAttackMs: compressorAttackMs ?? 5,
            compressorReleaseMs: compressorReleaseMs ?? 80,
            compressorMakeupDb: compressorMakeupDb ?? 0,
            rogerBeepEnabled: rogerBeepEnabled ?? false,
            rogerBeepHz: rogerBeepHz ?? 1200,
            rogerBeepMs: rogerBeepMs ?? 120,
            squelchTailEnabled: squelchTailEnabled ?? false,
            squelchTailMs: squelchTailMs ?? 90,
            squelchTailLevel: squelchTailLevel ?? 0.05
        )
    }
}

/// Minimal shape of the server's JSON error body (`{ "error": "code" }`).
private struct ServerError: Decodable {
    let error: String?
}

enum RadioApiError: Error {
    case invalidURL
    /// Non-2xx response. `code` is the server's `{ "error": "..." }` string when
    /// present (e.g. "session_superseded"), used to distinguish a terminal,
    /// must-re-auth failure from a transient/generic 401.
    case badStatus(Int, code: String? = nil)

    var status: Int? {
        if case let .badStatus(status, _) = self { return status }
        return nil
    }

    /// True only for definitive session-invalid signals, where dropping to the
    /// login screen is correct. A generic/transient 401 must NOT force a logout.
    var isTerminalSession: Bool {
        guard case let .badStatus(status, code) = self else { return false }
        switch (status, code) {
        case (401, "session_superseded"), (401, "account_disabled"),
             (403, "agency_disabled"), (403, "agency_suspended_billing"):
            return true
        default:
            return false
        }
    }
}

// MARK: - Client

/// Talks to the safeT PTT server's authenticated endpoints. The JWT is acquired
/// at login (`AuthApiClient.login`) and presented here as `Authorization: Bearer`.
final class RadioApiClient {
    private let baseURL: URL
    private let token: String?
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
        token: String? = nil,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    func channels() async throws -> [ChannelDTO] {
        struct Response: Decodable { let channels: [ChannelDTO] }
        // After login, channel membership is per-user — /me/channels returns
        // only the channels the JWT is allowed to key or monitor.
        return try await get("v1/me/channels", as: Response.self).channels
    }

    func airState(channel: String?) async throws -> AirState {
        let query = channel.map { [URLQueryItem(name: "channel", value: $0)] } ?? []
        return try await get("v1/air", query: query, as: AirState.self)
    }

    /// Live talker hints for home + optional scan channels (same as Android `/v1/talk-activity`).
    func talkActivity(home: String?, scan: String?) async throws -> TalkActivity {
        var query: [URLQueryItem] = []
        if let home, !home.isEmpty {
            query.append(URLQueryItem(name: "home", value: home))
        }
        if let scan, !scan.isEmpty {
            query.append(URLQueryItem(name: "scan", value: scan))
        }
        return try await get("v1/talk-activity", query: query, as: TalkActivity.self)
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

    // MARK: - dispatch (operator role required server-side)

    /// `GET /v1/channels/ten33?channel=X` — current 10-33 (emergency-traffic)
    /// state for a channel. 403 if the caller isn't admin/dispatcher.
    func ten33Status(channel: String) async throws -> Bool {
        struct Response: Decodable { let active: Bool }
        let query = [URLQueryItem(name: "channel", value: channel)]
        return try await get("v1/channels/ten33", query: query, as: Response.self).active
    }

    /// `POST /v1/channels/ten33` — set the 10-33 marker for a channel. Server
    /// applies the marker via the AI-dispatch loopback so radios on that
    /// channel see it in their next inbox poll.
    func setTen33(channel: String, active: Bool) async throws {
        struct Body: Encodable { let channel: String; let active: Bool }
        try await post("v1/channels/ten33", body: Body(channel: channel, active: active))
    }

    /// `GET /v1/tone-outs` — list metadata for every soundboard entry in the
    /// caller's agency. Available to all agency members; admin role required
    /// to create / update / delete (POST /v1/admin/tone-outs).
    func toneOuts() async throws -> [ToneOut] {
        struct Response: Decodable { let toneOuts: [ToneOut] }
        return try await get("v1/tone-outs", as: Response.self).toneOuts
    }

    /// `GET /v1/tone-outs/:id/audio` — raw audio bytes (typically WAV or MP3)
    /// for a tone-out, suitable for local AVAudioPlayer playback.
    func toneOutAudio(id: Int) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/tone-outs/\(id)/audio"))
        applyAuth(&request)
        return try await sendDiscardingBody(request)
    }

    /// `GET /v1/locations` — every reporting unit in this user's agency with
    /// its latest fix. Server enforces agency scoping; nothing to filter here.
    func positions() async throws -> [UnitPosition] {
        struct Response: Decodable { let positions: [UnitPosition] }
        return try await get("v1/locations", as: Response.self).positions
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

    /// `GET /v1/transmissions` — recent recorded transmissions for this user's
    /// agency, with optional server-side filtering. Server enforces the
    /// per-channel visibility filter by user role (admin/dispatcher see all,
    /// members only see their authorised channels). Server caps `limit` at 500
    /// — passing anything higher is silently truncated.
    ///
    /// - Parameters:
    ///   - limit: max rows to return (default 200, server cap 500).
    ///   - search: free-text match against transcript content.
    ///   - channel: exact channel name to restrict to.
    ///   - user: exact unit id (uppercase) to restrict to.
    ///   - from: ISO-8601 lower bound on `started_at` (inclusive).
    ///   - to: ISO-8601 upper bound on `started_at` (inclusive).
    func transmissions(
        limit: Int = 200,
        search: String? = nil,
        channel: String? = nil,
        user: String? = nil,
        from: String? = nil,
        to: String? = nil
    ) async throws -> [Transmission] {
        struct Response: Decodable { let transmissions: [Transmission] }
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        let trimmed: (String?) -> String? = { v in
            guard let v else { return nil }
            let t = v.trimmingCharacters(in: .whitespaces)
            return t.isEmpty ? nil : t
        }
        if let s = trimmed(search) { query.append(URLQueryItem(name: "search", value: s)) }
        if let c = trimmed(channel) { query.append(URLQueryItem(name: "channel", value: c)) }
        if let u = trimmed(user) { query.append(URLQueryItem(name: "user", value: u)) }
        if let f = trimmed(from) { query.append(URLQueryItem(name: "from", value: f)) }
        if let t = trimmed(to) { query.append(URLQueryItem(name: "to", value: t)) }
        return try await get("v1/transmissions", query: query, as: Response.self).transmissions
    }

    /// Downloads the WAV body of one transmission. Returned `Data` is a complete
    /// audio file (WAV header + PCM payload) — handed straight to AVAudioPlayer.
    func transmissionAudio(id: Int) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/transmissions/\(id)/audio"))
        applyAuth(&request)
        return try await sendDiscardingBody(request)
    }

    /// `GET /v1/radio/alerts/{id}/image` — the picture attached to a page, fetched
    /// lazily (only when `hasImage` is true). Returns the raw image bytes.
    func alertImage(id: Int) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/radio/alerts/\(id)/image"))
        applyAuth(&request)
        return try await sendDiscardingBody(request)
    }

    /// `POST /v1/radio/alerts/{id}/ack-response` — radio's ACK / reply to a page.
    func respondToAlert(id: Int, unit: String, response: String) async throws {
        try await post(
            "v1/radio/alerts/\(id)/ack-response",
            body: AlertResponseDto(unit: unit, response: String(response.prefix(60)))
        )
    }

    /// Agency-wide audio config a logged-in member fetches on connect /
    /// reconnect. Mirrors the Android `RadioApi.audioConfig()` and the web
    /// console's `getAudioConfigSummary()` — the same server route powers
    /// all three clients so admin presets land identically everywhere.
    func audioConfig() async throws -> AudioConfigSummaryResponse {
        return try await get("v1/audio/config", as: AudioConfigSummaryResponse.self)
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
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
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
            // Pull the server's `{ "error": "..." }` code out so callers can tell
            // a terminal session error from a transient one.
            let code = (try? JSONDecoder().decode(ServerError.self, from: data))?.error
            throw RadioApiError.badStatus(status, code: code)
        }
        return data
    }
}
