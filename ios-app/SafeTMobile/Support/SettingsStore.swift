import Foundation
import SwiftUI

/// UserDefaults-backed operator preferences. `@Published` mutations land on the
/// main actor because SwiftUI observers expect that; UserDefaults itself is
/// thread-safe.
final class SettingsStore: ObservableObject {
    enum AppColorScheme: String, CaseIterable, Codable {
        case system, dark, light
        var label: String {
            switch self {
            case .system: return "System"
            case .dark: return "Dark"
            case .light: return "Light"
            }
        }
        var colorScheme: ColorScheme? {
            switch self {
            case .system: return nil
            case .dark: return .dark
            case .light: return .light
            }
        }
    }

    enum AudioRoute: String, CaseIterable, Codable {
        case auto, earpiece, speaker, bluetooth

        var label: String {
            switch self {
            case .auto: return "Auto"
            case .earpiece: return "Earpiece"
            case .speaker: return "Speaker"
            case .bluetooth: return "Bluetooth"
            }
        }

        var icon: String {
            switch self {
            case .auto: return "speaker.wave.2"
            case .earpiece: return "ear"
            case .speaker: return "speaker.wave.3.fill"
            case .bluetooth: return "headphones"
            }
        }
    }

    static let shared = SettingsStore()

    private let defaults: UserDefaults

    @Published var appColorScheme: AppColorScheme {
        didSet { defaults.set(appColorScheme.rawValue, forKey: Keys.appColorScheme) }
    }
    @Published var hardwarePttEnabled: Bool {
        didSet { defaults.set(hardwarePttEnabled, forKey: Keys.hardwarePtt) }
    }
    @Published var audioRoute: AudioRoute {
        didSet { defaults.set(audioRoute.rawValue, forKey: Keys.audioRoute) }
    }
    @Published var notificationSoundsEnabled: Bool {
        didSet { defaults.set(notificationSoundsEnabled, forKey: Keys.notificationSounds) }
    }
    @Published var playbackVolume: Float {
        didSet { defaults.set(playbackVolume, forKey: Keys.playbackVolume) }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let rawScheme = defaults.string(forKey: Keys.appColorScheme) ?? AppColorScheme.system.rawValue
        appColorScheme = AppColorScheme(rawValue: rawScheme) ?? .system
        hardwarePttEnabled = defaults.bool(forKey: Keys.hardwarePtt)
        let rawRoute = defaults.string(forKey: Keys.audioRoute) ?? AudioRoute.auto.rawValue
        audioRoute = AudioRoute(rawValue: rawRoute) ?? .auto
        notificationSoundsEnabled = (defaults.object(forKey: Keys.notificationSounds) as? Bool) ?? true
        playbackVolume = defaults.object(forKey: Keys.playbackVolume) as? Float ?? 1.0
    }

    private enum Keys {
        static let appColorScheme = "safet.appColorScheme"
        static let hardwarePtt = "safet.hardwarePttEnabled"
        static let audioRoute = "safet.audioRoute"
        static let notificationSounds = "safet.notificationSoundsEnabled"
        static let playbackVolume = "safet.playbackVolume"
    }
}
