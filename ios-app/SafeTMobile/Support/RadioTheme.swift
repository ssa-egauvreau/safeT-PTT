import SwiftUI

/// safeT PTT brand palette.
extension Color {
    static let safetBackground = Color(hex: 0x0B1220)
    static let safetSurface = Color(hex: 0x111827)
    static let safetBorder = Color(hex: 0x1F2937)
    static let safetBlue = Color(hex: 0x2563EB)
    static let safetSignal = Color(hex: 0x22C5E5)
    static let safetGreen = Color(hex: 0x4ADE80)
    static let safetAmber = Color(hex: 0xF59E0B)
    static let safetRed = Color(hex: 0xEF4444)
    static let safetText = Color(hex: 0xF3F4F6)
    static let safetTextDim = Color(hex: 0x94A3B8)

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
