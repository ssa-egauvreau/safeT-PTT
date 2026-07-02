import Foundation
import Network

/// Singleton NWPathMonitor wrapper. The NWPathMonitor publishes updates on
/// its own private queue; we hop everything to MainActor before mutating
/// `isReachable` or firing `onChange` so callers (RadioViewModel) can read
/// the property + the callback safely without an actor isolation gap.
final class NetworkPathMonitor {
    static let shared = NetworkPathMonitor()

    @MainActor private(set) var isReachable: Bool = true
    @MainActor private var onChange: ((Bool) -> Void)?
    /// Generation of the current `onChange` owner. Lets a deinitializing owner
    /// clear ONLY its own callback: during a session handoff (silent re-auth
    /// rebuilds the radio view-model) the new VM registers before the old VM's
    /// async teardown runs, and an unconditional `onChange = nil` there would
    /// silently disconnect the new VM from network-recovery events.
    @MainActor private var callbackGeneration = 0

    /// Register the reachability callback; returns a token for `clearCallback`.
    @MainActor
    @discardableResult
    func setCallback(_ callback: @escaping (Bool) -> Void) -> Int {
        callbackGeneration += 1
        onChange = callback
        return callbackGeneration
    }

    /// Clear the callback iff `token` still owns it (see `setCallback`).
    @MainActor
    func clearCallback(token: Int) {
        if token == callbackGeneration {
            onChange = nil
        }
    }

    private let monitor: NWPathMonitor
    private let queue = DispatchQueue(label: "safet.net")

    init() {
        monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let reachable = (path.status == .satisfied)
            DispatchQueue.main.async { [weak self] in
                self?.update(isReachable: reachable)
            }
        }
        monitor.start(queue: queue)
    }

    @MainActor
    private func update(isReachable: Bool) {
        let changed = self.isReachable != isReachable
        self.isReachable = isReachable
        if changed { onChange?(isReachable) }
    }
}
