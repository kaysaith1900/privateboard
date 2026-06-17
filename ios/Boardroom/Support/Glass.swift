import SwiftUI

/// Native Apple Liquid Glass (iOS 26) wrappers. The whole app routes its glass
/// surfaces through these so everything uses the real `.glassEffect()` — the
/// genuine system material with its refraction, specular highlight and the
/// fluid morph inside a `GlassEffectContainer`.
extension View {
    func glassCircle() -> some View { glassEffect(.regular, in: Circle()) }
    func glassPill() -> some View { glassEffect(.regular, in: Capsule()) }
    func glassRound(_ radius: CGFloat) -> some View {
        glassEffect(.regular, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

/// Frosted-gradient header scrim · the SINGLE shared treatment for pinned top
/// chrome (Home masthead + text-room top bar), so the list and the transcript
/// dissolve UNDER a consistent blurred band instead of scrolling crisply to the
/// very top edge. A blur of the content behind, washed with the app bg, fading
/// to clear at the bottom. Callers add `.ignoresSafeArea(edges: .top)` so it
/// reaches under the status bar, and size it (a `.background` fills the masthead;
/// a framed overlay sets the band height in the room).
struct TopScrim: View {
    var body: some View {
        // Photos / Music top-bar treatment · a PROGRESSIVE blur (radius ramps to
        // full at the top) instead of a flat gray material film. A faint warm-dark
        // wash (matching `bbBg`) fades out for title legibility — kept light so the
        // blur stays visible (the previous near-opaque wash is what read as cheap).
        VariableBlurView(maxBlurRadius: 20)
            .overlay(
                LinearGradient(colors: [Color.bbBg.opacity(0.55), Color.bbBg.opacity(0.12), Color.bbBg.opacity(0)],
                               startPoint: .top, endPoint: .bottom)
            )
            .allowsHitTesting(false)
    }
}

/// Round Liquid-Glass icon button (top-bar / dock idiom). Uses the genuine
/// `.glassEffect(.regular.interactive())` material at an EXACT `size`×`size`
/// frame — `.buttonStyle(.glass)` adds its own internal padding, which makes a
/// button taller than a sibling `glassPill`/`glassCircle` of the same frame and
/// breaks height parity in a bar. Manual glass keeps every chrome element the
/// same height. (`.interactive()` still gives the press/lift/shimmer.)
struct GlassIconButton: View {
    let system: String
    var size: CGFloat = 44     // top-bar spec (matches the ChatGPT topbar.PNG reference)
    var tint: Color = .bbInk
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: size, height: size)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Circle())
    }
}
