import SwiftUI

@main
struct SafeTMobileApp: App {
    @StateObject private var session: AuthSession = {
        #if DEBUG
        if CommandLine.arguments.contains("-uitest-logged-in") {
            return AuthSession.forUITesting()
        }
        #endif
        return AuthSession()
    }()
    @StateObject private var settings = SettingsStore.shared

    init() {
        #if canImport(ActivityKit)
        if #available(iOS 16.2, *) {
            // A crash or force-quit can't run our normal Live Activity end()
            // paths, so an activity from the previous process can stay stranded
            // on the Lock Screen / Dynamic Island. Reap any such orphans at
            // launch, before the radio requests a fresh one.
            Task { @MainActor in
                RadioLiveActivityController.shared.endOrphanedActivities()
            }
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(settings)
                .preferredColorScheme(settings.appColorScheme.colorScheme)
        }
    }
}

/// Switches between the login screen and the radio shell as the session's
/// current user changes.
private struct RootView: View {
    @EnvironmentObject private var session: AuthSession

    var body: some View {
        if let user = session.currentUser, let token = session.token {
            // Pass user/token (not a pre-built view-model) so RadioScreen's
            // StateObject autoclosure owns the VM lifetime. Constructing the
            // VM at the call site would build a fresh instance on every
            // RootView re-render, defeating @StateObject's retention.
            RadioScreen(user: user, token: token)
                .id(user.id)
        } else {
            LoginScreen()
        }
    }
}
