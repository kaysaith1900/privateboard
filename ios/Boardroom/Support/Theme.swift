import SwiftUI

// Palette + type ported 1:1 from public/mobile/voice-room.css (:root tokens).
// Warm near-black ground, cream ink, gold accent, iOS-26 Liquid-Glass surfaces.
extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }

    static let bbBg        = Color(hex: 0x0E0C0A)   // --bg · warm near-black
    static let bbSurface   = Color(hex: 0x141414)   // cards
    static let bbSurfaceHi = Color(hex: 0x1B1B1B)   // raised rows / pressed
    static let bbCard      = Color(hex: 0x191918)   // STANDARD grouped-container / list-cell surface · sits above bbBg. Reuse this for any "card on the dark ground" elsewhere.
    static let bbInk       = Color(hex: 0xECE9E2)   // --ink
    static let bbInkDim    = Color(hex: 0x9A958B)   // --ink-dim
    static let bbInkFaint  = Color(hex: 0x6A655C)   // --ink-faint
    static let bbGold      = Color(hex: 0xC9A46B)   // --gold
    static let bbAmber     = Color(hex: 0xD9A441)   // replay / paused
    static let bbLine      = Color.white.opacity(0.10)   // --line
    static let bbGlassFill = Color.white.opacity(0.14)   // glass button base
    static let bbGlassRim  = Color.white.opacity(0.24)   // glass border
}

// Type scale · sans = system, mono = monospaced design. (Project rule: no 13px.)
extension Font {
    /// 11px mono uppercase kicker / label.
    static func bbKicker(_ size: CGFloat = 11) -> Font { .system(size: size, weight: .bold, design: .monospaced) }
    static let bbBody    = Font.system(size: 14)                 // body / chip / row
    static let bbBodyMed = Font.system(size: 14, weight: .medium)
    static let bbCardTitle = Font.system(size: 16, weight: .medium)
    static let bbCaption = Font.system(size: 20, weight: .medium)
    static let bbMonoSmall = Font.system(size: 12, weight: .semibold, design: .monospaced)
}

extension RoomStatus {
    var label: String {
        switch self {
        case .live: return Loc.t("m_rc_live")
        case .paused: return Loc.t("m_rc_paused")
        case .adjourned: return Loc.t("m_rc_adjourned")
        }
    }
    var tint: Color {
        switch self {
        case .live: return .bbGold
        case .paused: return .bbAmber
        case .adjourned: return .bbInkFaint
        }
    }
    var pulses: Bool { self == .live }
}

// A mono uppercase kicker label with a leading status-tinted dot.
struct Kicker: View {
    let text: String
    var color: Color = .bbGold
    var dot: Bool = false
    var pulse: Bool = false
    var body: some View {
        HStack(spacing: 7) {
            if dot { PulseDot(color: color, on: pulse) }
            Text(text.uppercased())
                .font(.bbKicker())
                .kerning(1.5)
                .foregroundStyle(color)
        }
    }
}

// Blinking status dot (live). Single-dim opacity pulse — no glow (project rule).
struct PulseDot: View {
    var color: Color = .bbGold
    var on: Bool = true
    @State private var dim = false
    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .opacity(on && dim ? 0.3 : 1)
            .animation(on ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true) : .default, value: dim)
            .onAppear { if on { dim = true } }
    }
}
