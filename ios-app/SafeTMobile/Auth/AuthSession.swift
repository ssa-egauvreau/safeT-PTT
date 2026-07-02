import Foundation

/// Holds the signed-in user and JWT, persists them in the Keychain across
/// launches, and is the single source of truth `RootView` watches to decide
/// whether to show the login screen or the radio.
///
/// The signed-in credentials are kept in the Keychain alongside the token
/// (device-only, never synced) so the radio can silently mint a fresh token
/// when the server rejects the stored one — non-radio roles get 12-hour JWTs
/// server-side, and without silent re-auth the handset wakes up "connected"
/// to a dead session and the operator has to log out/in by hand.
@MainActor
final class AuthSession: ObservableObject {
    @Published private(set) var currentUser: AuthenticatedUser?
    @Published private(set) var token: String?
    @Published private(set) var isLoggingIn = false
    @Published var loginError: String?

    private let api: AuthApiClient
    private let keychain: KeychainStore
    /// Guards against overlapping silent re-auth attempts when several radio
    /// polls report auth rejection in the same window.
    private var isRecovering = false

    private static let lastUsernameKey = "safet.lastUsername"

    init(api: AuthApiClient = AuthApiClient(), keychain: KeychainStore = KeychainStore()) {
        self.api = api
        self.keychain = keychain
        restoreFromKeychain()
    }

    private struct Stored: Codable {
        let token: String
        let user: AuthenticatedUser
        // Credentials for silent re-auth. Optional so blobs persisted by older
        // builds (token + user only) still decode; those installs regain silent
        // re-auth on their next manual login.
        var username: String? = nil
        var password: String? = nil
    }

    /// Username from the most recent successful login, used to prefill the
    /// login screen after a sign-out / session expiry.
    var lastUsername: String {
        UserDefaults.standard.string(forKey: Self.lastUsernameKey) ?? ""
    }

    private func restoreFromKeychain() {
        guard let data = keychain.read() else { return }
        guard let stored = try? JSONDecoder().decode(Stored.self, from: data) else {
            keychain.delete()
            return
        }
        token = stored.token
        currentUser = stored.user
    }

    func login(username: String, password: String) async {
        isLoggingIn = true
        loginError = nil
        defer { isLoggingIn = false }
        do {
            let response = try await api.login(username: username, password: password)
            persist(token: response.token, user: response.user,
                    username: username.trimmingCharacters(in: .whitespaces), password: password)
        } catch let error as AuthError {
            loginError = error.errorDescription
        } catch {
            loginError = AuthError.network(error).errorDescription
        }
    }

    /// The radio reported that the server definitively rejected the stored
    /// token (expired / secret rotated / superseded). Try to mint a fresh token
    /// with the stored credentials; publishing the new token rebuilds the radio
    /// screen. Falls back to a full sign-out (login screen) when there are no
    /// stored credentials or the server rejects them; a network failure leaves
    /// the session alone so the next poll cycle retries.
    func recoverSession() async {
        guard !isRecovering else { return }
        guard currentUser != nil else { return }
        isRecovering = true
        defer { isRecovering = false }

        guard let data = keychain.read(),
              let stored = try? JSONDecoder().decode(Stored.self, from: data),
              let username = stored.username, !username.isEmpty,
              let password = stored.password, !password.isEmpty else {
            // Nothing to re-auth with (pre-credential-storage install) — drop
            // to the login screen instead of sitting on a broken radio.
            logout()
            return
        }
        do {
            let response = try await api.login(username: username, password: password)
            persist(token: response.token, user: response.user, username: username, password: password)
        } catch let error as AuthError {
            switch error {
            case .invalidLogin, .missingCredentials:
                // Password changed / account removed — a fresh token is not
                // coming. Sign out so the operator sees the login screen.
                logout()
                loginError = "Session expired — sign in again."
            case .server, .network:
                // Transient — keep the session; the radio keeps polling and a
                // later rejection retriggers recovery.
                break
            }
        } catch {
            // Unknown transport failure — treat as transient (see above).
        }
    }

    func logout() {
        keychain.delete()
        token = nil
        currentUser = nil
        loginError = nil
    }

    private func persist(token: String, user: AuthenticatedUser, username: String, password: String) {
        let stored = Stored(token: token, user: user, username: username, password: password)
        if let data = try? JSONEncoder().encode(stored) {
            keychain.write(data)
        }
        UserDefaults.standard.set(username, forKey: Self.lastUsernameKey)
        self.token = token
        currentUser = user
    }
}

#if DEBUG
extension AuthSession {
    /// Test-only hook: stub a signed-in user so UI tests can render the radio
    /// screen without hitting the server. Triggered by `-uitest-logged-in`.
    static func forUITesting() -> AuthSession {
        let session = AuthSession(api: AuthApiClient(), keychain: KeychainStore(service: "ui-test", account: "ui-test"))
        session.token = "ui-test-token"
        session.currentUser = AuthenticatedUser(
            id: 0,
            username: "uitester",
            displayName: "UI Tester",
            role: "radio",
            unitId: "UITEST",
            agencyId: 0,
            agencyName: "UI Test Agency"
        )
        return session
    }
}
#endif
