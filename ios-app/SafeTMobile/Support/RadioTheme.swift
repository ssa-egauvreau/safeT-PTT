import SwiftUI
import UIKit

/// safeT PTT brand palette. Colors adapt automatically to light and dark mode.
extension Color {
    // Structural colors — background, surface, border, and text all shift
    // between the dark-navy theme (default / dark mode) and a high-contrast
    // light theme when the user selects Light or follows System in Settings.
    static let safetBackground = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x0B1220) : UIColor(safetHex: 0xF1F5F9)
    })
    static let safetSurface = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x111827) : UIColor(safetHex: 0xFFFFFF)
    })
    static let safetBorder = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x1F2937) : UIColor(safetHex: 0xCBD5E1)
    })
    static let safetText = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0xF3F4F6) : UIColor(safetHex: 0x0F172A)
    })
    static let safetTextDim = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x94A3B8) : UIColor(safetHex: 0x475569)
    })

    // Brand / status colors — slightly deeper in light mode to maintain
    // sufficient contrast against a white/near-white background.
    static let safetBlue = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x2563EB) : UIColor(safetHex: 0x1D4ED8)
    })
    static let safetSignal = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x22C5E5) : UIColor(safetHex: 0x0891B2)
    })
    static let safetGreen = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0x4ADE80) : UIColor(safetHex: 0x16A34A)
    })
    static let safetAmber = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0xF59E0B) : UIColor(safetHex: 0xD97706)
    })
    static let safetRed = Color(UIColor { t in
        t.userInterfaceStyle == .dark
            ? UIColor(safetHex: 0xEF4444) : UIColor(safetHex: 0xDC2626)
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
