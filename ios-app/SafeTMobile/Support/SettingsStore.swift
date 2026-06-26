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
    /// Experimental "media-style" listening: while only monitoring, use a
    /// `.playback` audio session instead of the always-on voice-call session, so
    /// iOS stops treating the app as an ongoing phone call (no constant mic-in-use
    /// indicator, other audio isn't commandeered). The voice-call session is
    /// brought up only for the duration of a transmission. Default off keeps the
    /// known-good always-on voice path.
    @Published var mediaListenMode: Bool {
        didSet { defaults.set(mediaListenMode, forKey: Keys.mediaListenMode) }
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
        mediaListenMode = defaults.bool(forKey: Keys.mediaListenMode)
    }

    // MARK: - Scan selection persistence

    /// Persist the operator's scan picks (lowercased channel names) and whether
    /// scan was armed, so the selection survives relaunch — mirrors the Android
    /// scan persistence. Plain UserDefaults (not @Published): the ViewModel owns
    /// scan state, this is just durable storage.
    func saveScanSelection(channels: Set<String>, active: Bool) {
        defaults.set(Array(channels), forKey: Keys.scanChannels)
        defaults.set(active, forKey: Keys.scanActive)
    }

    var savedScanChannels: Set<String> {
        Set((defaults.array(forKey: Keys.scanChannels) as? [String]) ?? [])
    }

    var savedScanActive: Bool {
        defaults.bool(forKey: Keys.scanActive)
    }

    private enum Keys {
        static let appColorScheme = "safet.appColorScheme"
        static let hardwarePtt = "safet.hardwarePttEnabled"
        static let audioRoute = "safet.audioRoute"
        static let notificationSounds = "safet.notificationSoundsEnabled"
        static let playbackVolume = "safet.playbackVolume"
        static let mediaListenMode = "safet.mediaListenMode"
        static let scanChannels = "safet.scanIncludedChannels"
        static let scanActive = "safet.scanActive"
    }
}
