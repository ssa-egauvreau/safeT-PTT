import Foundation

/// Explicit user/device intents the UI forwards to `RadioViewModel`.
enum RadioUiEvent {
    case retryChannelSync
    case channelUp
    case channelDown
    case pttPressed
    case pttReleased
    case emergencyToggle
    case toggleGps
}
