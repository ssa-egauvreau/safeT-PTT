import SwiftUI

@main
struct SafeTMobileApp: App {
    var body: some Scene {
        WindowGroup {
            RadioScreen()
                .preferredColorScheme(.dark)
        }
    }
}
