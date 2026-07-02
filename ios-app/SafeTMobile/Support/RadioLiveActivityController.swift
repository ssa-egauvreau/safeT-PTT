import Foundation

#if canImport(ActivityKit)
import ActivityKit

@available(iOS 16.2, *)
@MainActor
final class RadioLiveActivityController {
    static let shared = RadioLiveActivityController()

    private var currentActivity: Activity<RadioActivityAttributes>?
    private var currentChannel: String = ""
    /// Tail of the serialized update chain. `Activity.update` is async and the
    /// callers fire-and-forget, so two rapid state changes (RX → IDLE) used to
    /// race and could land on the island in the wrong order — the stale write
    /// then stuck. Every update awaits the previous one instead.
    private var updateChain: Task<Void, Never>?

    /// Starts a Live Activity if one isn't already running, or updates the
    /// existing one in place. Calling this on every channel mutation keeps the
    /// widget surface in sync without leaking an extra activity per channel
    /// switch.
    func startOrUpdate(channel: String, callsign: String?, stateLabel: String,
                       talker: String? = nil, scanChannel: String? = nil) {
        let state = RadioActivityAttributes.ContentState(
            channel: channel,
            callsign: callsign,
            stateLabel: stateLabel,
            talker: talker,
            scanChannel: scanChannel
        )
        if let activity = currentActivity {
            currentChannel = channel
            enqueueUpdate(activity, state)
            return
        }
        let attributes = RadioActivityAttributes()
        let content = ActivityContent(state: state, staleDate: nil)
        currentActivity = try? Activity.request(attributes: attributes, content: content, pushType: nil)
        currentChannel = channel
    }

    /// Chain the update behind whatever is already in flight so states apply
    /// in the exact order the radio produced them.
    private func enqueueUpdate(_ activity: Activity<RadioActivityAttributes>,
                               _ state: RadioActivityAttributes.ContentState) {
        let previous = updateChain
        updateChain = Task {
            await previous?.value
            await activity.update(ActivityContent(state: state, staleDate: nil))
        }
    }

    /// Tears down the current Live Activity. The currentActivity reference is
    /// cleared synchronously so a concurrent `startOrUpdate(channel:)` from a
    /// freshly logged-in session can't see the soon-to-be-ended activity and
    /// fall into the "already running" branch.
    func end() {
        let prior = currentActivity
        let priorChain = updateChain
        currentActivity = nil
        currentChannel = ""
        updateChain = nil
        guard let prior else { return }
        Task {
            await priorChain?.value
            await prior.end(nil, dismissalPolicy: .immediate)
        }
    }

    /// Ends any Live Activities left running by a *previous* process — e.g. a
    /// crash or force-quit that skipped the normal `end()` paths and stranded
    /// the activity on the Lock Screen / Dynamic Island. After such an exit the
    /// system-side activity is still alive, but this fresh singleton's
    /// `currentActivity` is nil, so nothing would otherwise reap it. Safe to
    /// call at launch and on foreground: it never ends the activity this
    /// process currently owns.
    func endOrphanedActivities() {
        let keepId = currentActivity?.id
        for activity in Activity<RadioActivityAttributes>.activities where activity.id != keepId {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }
}
#endif
