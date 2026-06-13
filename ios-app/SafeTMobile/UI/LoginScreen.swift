import SwiftUI

/// Username/password gate. After a successful login `AuthSession` switches
/// the root view to `RadioScreen` automatically.
struct LoginScreen: View {
    @EnvironmentObject private var session: AuthSession
    @State private var username = ""
    @State private var password = ""
    @FocusState private var focused: Field?

    private enum Field { case username, password }

    var body: some View {
        ZStack {
            Color.safetBackground.ignoresSafeArea()
            VStack(spacing: 18) {
                Spacer()

                VStack(spacing: 4) {
                    Text("safeT")
                        .font(.safet(size: 36, weight: .heavy, design: .rounded))
                        .foregroundColor(.safetSignal)
                    Text("MOBILE")
                        .font(.safet(size: 14, weight: .bold))
                        .tracking(6)
                        .foregroundColor(.safetTextDim)
                }
                .padding(.bottom, 16)

                field(
                    title: "USERNAME",
                    text: $username,
                    contentType: .username,
                    autocaps: false,
                    field: .username
                )
                .submitLabel(.next)
                .onSubmit { focused = .password }

                field(
                    title: "PASSWORD",
                    text: $password,
                    contentType: .password,
                    isSecure: true,
                    field: .password
                )
                .submitLabel(.go)
                .onSubmit { signIn() }

                if let error = session.loginError {
                    Text(error)
                        .font(.safet(size: 12, weight: .semibold))
                        .foregroundColor(.safetRed)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Button(action: signIn) {
                    ZStack {
                        Text("SIGN IN")
                            .font(.safet(size: 15, weight: .heavy))
                            .opacity(session.isLoggingIn ? 0 : 1)
                        if session.isLoggingIn {
                            ProgressView().tint(.white)
                        }
                    }
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(Color.safetBlue)
                    .cornerRadius(10)
                }
                .disabled(session.isLoggingIn)
                .padding(.top, 6)

                Spacer()
                Spacer()
            }
            .padding(24)
        }
        .onAppear { focused = .username }
    }

    private func field(
        title: String,
        text: Binding<String>,
        contentType: UITextContentType,
        isSecure: Bool = false,
        autocaps: Bool = false,
        field: Field
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.safet(size: 10, weight: .bold))
                .tracking(2)
                .foregroundColor(.safetTextDim)
            Group {
                if isSecure {
                    SecureField("", text: text)
                } else {
                    TextField("", text: text)
                        .textInputAutocapitalization(autocaps ? .sentences : .never)
                        .autocorrectionDisabled(true)
                }
            }
            .textContentType(contentType)
            .focused($focused, equals: field)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.safetSurface)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.safetBorder, lineWidth: 1))
            .cornerRadius(8)
            .foregroundColor(.safetText)
            .font(.safet(size: 16, weight: .semibold, design: .monospaced))
        }
    }

    private func signIn() {
        focused = nil
        Task { await session.login(username: username, password: password) }
    }
}

#Preview {
    LoginScreen()
        .environmentObject(AuthSession())
        .preferredColorScheme(.dark)
}
