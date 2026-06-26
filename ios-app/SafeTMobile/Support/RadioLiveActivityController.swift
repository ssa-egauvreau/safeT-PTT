import Foundation

#if canImport(ActivityKit)
import ActivityKit

@available(iOS 16.2, *)
@MainActor
final class RadioLiveActivityController {
    static let shared = RadioLiveActivityController()

    private var currentActivity: Activity<RadioActivityAttributes>?
    private var currentChannel: String = ""

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
            Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
            return
        }
        let attributes = RadioActivityAttributes()
        let content = ActivityContent(state: state, staleDate: nil)
        currentActivity = try? Activity.request(attributes: attributes, content: content, pushType: nil)
        currentChannel = channel
    }

    /// Updates the running activity's callsign/stateLabel without changing the
    /// channel. No-op when no activity is currently running.
    func update(callsign: String?, stateLabel: String) {
        guard let activity = currentActivity else { return }
        let state = RadioActivityAttributes.ContentState(
            channel: currentChannel,
            callsign: callsign,
            stateLabel: stateLabel
        )
        Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
    }

    /// Tears down the current Live Activity. The currentActivity reference is
    /// cleared synchronously so a concurrent `startOrUpdate(channel:)` from a
    /// freshly logged-in session can't see the soon-to-be-ended activity and
    /// fall into the "already running" branch.
    func end() {
        let prior = currentActivity
        currentActivity = nil
        currentChannel = ""
        guard let prior else { return }
        Task { await prior.end(nil, dismissalPolicy: .immediate) }
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
