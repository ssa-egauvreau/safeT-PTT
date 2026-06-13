import SwiftUI

/// safeT Mobile typography. Mirrors the Android handset, which renders its LCD
/// shell in **Roboto Condensed** (see `android-app` `LcdTypography.kt` /
/// `res/font/roboto_condensed_*`). The same two TTFs are bundled here
/// (`Resources/Fonts/RobotoCondensed-{Regular,Bold}.ttf`, registered via
/// `UIAppFonts` in Info.plist) so both clients read identically.
///
/// `safet(size:weight:design:)` is a drop-in shape-match for `Font.system(size:
/// weight:design:)` so call sites swap one for the other without touching their
/// arguments. The bundled family ships only Regular + Bold faces, so the weight
/// is collapsed to one of those two rather than passed to `.weight()` (which
/// would otherwise synthesize a faux-bold). `design` is accepted for call-site
/// compatibility but ignored — Roboto Condensed is a single design.
///
/// If the custom font ever fails to load, `Font.custom` falls back to the system
/// font automatically, so a registration problem degrades to the old look rather
/// than crashing.
extension Font {
    static func safet(
        size: CGFloat,
        weight: Font.Weight = .regular,
        design: Font.Design = .default
    ) -> Font {
        _ = design
        let bold = weight == .bold || weight == .heavy || weight == .black || weight == .semibold
        // fixedSize (not size:) so text keeps the app's existing fixed metrics
        // instead of scaling with Dynamic Type — matches the prior .system(size:)
        // behaviour and keeps the dense radio layout stable.
        return .custom(bold ? "RobotoCondensed-Bold" : "RobotoCondensed-Regular", fixedSize: size)
    }
}
