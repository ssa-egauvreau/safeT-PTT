import Foundation

/// Stable short unit label for this handset, persisted until real accounts exist.
enum LocalUnitIdentifier {
    private static let key = "safet.localUnitId"

    static func shortUnitId() -> String {
        let defaults = UserDefaults.standard
        if let existing = defaults.string(forKey: key)?
            .trimmingCharacters(in: .whitespaces), !existing.isEmpty {
            return existing.uppercased()
        }
        let created = String(UUID().uuidString.prefix(6)).uppercased()
        defaults.set(created, forKey: key)
        return created
    }
}
