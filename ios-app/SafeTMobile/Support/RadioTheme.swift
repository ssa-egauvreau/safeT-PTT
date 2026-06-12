import SwiftUI
import UIKit

/// safeT PTT brand palette. Colors adapt automatically to light and dark mode.
extension Color {
    // Structural colors — background, surface, border, and text all shift
    // between the dark-navy theme (default / dark mode) and a high-contrast
    // light theme when the user selects Light or follows System in Settings.
    // Dark-mode values mirror the Android LCD palette (RadioLcdPalette.night()
    // / RadioTheme.kt) so the two handsets read identically. Light-mode values
    // are kept as the high-contrast safeT light theme.
    static let safetBackground = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x05070B) : UIColor(safetHex: 0xF1F5F9)
    })
    static let safetSurface = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x15171C) : UIColor(safetHex: 0xFFFFFF)
    })
    static let safetBorder = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x1E2A38) : UIColor(safetHex: 0xCBD5E1)
    })
    static let safetText = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0xC5D4E8) : UIColor(safetHex: 0x0F172A)
    })
    static let safetTextDim = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x8FA9C4) : UIColor(safetHex: 0x475569)
    })

    // Brand / status colors — dark-mode values match Android's status* tokens;
    // light-mode values stay slightly deeper for contrast on a near-white field.
    static let safetBlue = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x5B9FFF) : UIColor(safetHex: 0x1D4ED8)
    })
    static let safetSignal = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x5B9FFF) : UIColor(safetHex: 0x0891B2)
    })
    static let safetGreen = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x4ADE80) : UIColor(safetHex: 0x16A34A)
    })
    static let safetAmber = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0xFFC048) : UIColor(safetHex: 0xD97706)
    })
    static let safetRed = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0xFF5252) : UIColor(safetHex: 0xDC2626)
    })

    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: 1.0
        )
    }
}

private extension UIColor {
    convenience init(safetHex hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255.0,
            green: CGFloat((hex >> 8) & 0xFF) / 255.0,
            blue: CGFloat(hex & 0xFF) / 255.0,
            alpha: 1.0
        )
    }
}
