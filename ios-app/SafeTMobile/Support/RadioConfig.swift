import Foundation

/// Server connection settings, read from Info.plist (set in project.yml).
enum RadioConfig {
    static let apiBaseURL: URL = {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "APIBaseURL") as? String) ?? ""
        return URL(string: raw) ?? URL(string: "https://example.invalid")!
    }()

    static let radioApiKey: String =
        (Bundle.main.object(forInfoDictionaryKey: "RadioAPIKey") as? String) ?? ""
}
