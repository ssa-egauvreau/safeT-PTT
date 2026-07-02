import SwiftUI

/// The safeT brand mark — signal bars + lightning bolt — ported 1:1 from
/// `brand/safet-logo.svg` into native SwiftUI shapes (the SVG uses `<text>`
/// elements the asset-catalog SVG renderer can't handle, so the mark is drawn
/// in code instead of shipped as an image). Colors are the fixed brand values,
/// not theme tokens, so the logo reads identically in light and dark mode.
enum SafeTBrand {
    static let blue = Color(hex: 0x2563EB)
    static let cyan = Color(hex: 0x22C5E5)
}

/// The four blue signal bars of the mark. Coordinates are the SVG's symbol
/// coordinates in a 96×96 design space, scaled to whatever rect SwiftUI gives.
private struct SafeTBarsShape: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 96
        let sy = rect.height / 96
        var path = Path()
        // (x, y, width, height, cornerRadius) straight from the SVG rects.
        let bars: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] = [
            (10, 60, 12, 20, 2.5),
            (26, 49, 12, 31, 2.5),
            (42, 38, 12, 42, 2.5),
            (40, 12, 46, 12, 3.0),
        ]
        for (x, y, w, h, r) in bars {
            path.addRoundedRect(
                in: CGRect(x: rect.minX + x * sx, y: rect.minY + y * sy, width: w * sx, height: h * sy),
                cornerSize: CGSize(width: r * sx, height: r * sy)
            )
        }
        return path
    }
}

/// The cyan lightning bolt. Path points are the SVG's
/// `M67 24 L53 51 L63 51 L55 84 L80 48 L67 48 L75 24 Z` in the same 96×96 space.
private struct SafeTBoltShape: Shape {
    func path(in rect: CGRect) -> Path {
        let sx = rect.width / 96
        let sy = rect.height / 96
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * sx, y: rect.minY + y * sy)
        }
        var path = Path()
        path.move(to: point(67, 24))
        path.addLine(to: point(53, 51))
        path.addLine(to: point(63, 51))
        path.addLine(to: point(55, 84))
        path.addLine(to: point(80, 48))
        path.addLine(to: point(67, 48))
        path.addLine(to: point(75, 24))
        path.closeSubpath()
        return path
    }
}

/// The bare symbol (bars + bolt), sized by its frame.
struct SafeTLogoMark: View {
    var body: some View {
        ZStack {
            SafeTBarsShape().fill(SafeTBrand.blue)
            SafeTBoltShape().fill(SafeTBrand.cyan)
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

/// Symbol + "safeT" wordmark (with the brand cyan T) + a small caption line —
/// the lockup the login screen shows.
struct SafeTLogoView: View {
    var caption: String = "MOBILE"

    var body: some View {
        VStack(spacing: 12) {
            SafeTLogoMark()
                .frame(width: 84, height: 84)
            VStack(spacing: 4) {
                HStack(spacing: 0) {
                    Text("safe")
                        .foregroundColor(.safetText)
                    Text("T")
                        .foregroundColor(SafeTBrand.cyan)
                }
                .font(.safet(size: 40, weight: .semibold, design: .rounded))
                Text(caption)
                    .font(.safet(size: 14, weight: .bold))
                    .tracking(6)
                    .foregroundColor(.safetTextDim)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("safeT \(caption.capitalized)")
    }
}

#Preview {
    ZStack {
        Color.safetBackground.ignoresSafeArea()
        SafeTLogoView()
    }
    .preferredColorScheme(.dark)
}
