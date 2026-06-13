import Foundation

/// Explicit user/device intents the UI forwards to `RadioViewModel`.
enum RadioUiEvent {
    case retryChannelSync
    case channelUp
    case channelDown
    /// Jump directly to a channel by its tuning-order index (zone/channel dropdown).
    case selectChannel(Int)
    case pttPressed
    case pttReleased
    case emergencyToggle
    case toggleScan
    case setScanChannels(Set<String>)
}
