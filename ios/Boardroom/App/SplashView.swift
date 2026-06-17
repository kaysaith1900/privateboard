import SwiftUI

/// Launch splash · a black surface with the centred brand logo and the
/// PrivateBoard slogan, shown for a beat at cold start before the home screen
/// fades in. Mirrors the desktop boot splash (public/splash.html): centred mark,
/// wordmark, slogan, one-shot fade-in + single-dim breathing (no shadow/glow
/// animation, per the project's no-shadow-animation rule).
struct SplashView: View {
    @State private var appeared = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 14) {
                Image("LaunchLogo")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 144, height: 144)
                    .clipShape(RoundedRectangle(cornerRadius: 36, style: .continuous))
                    .opacity(appeared ? 1 : 0.74)
                    .animation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true), value: appeared)
                VStack(spacing: 6) {
                    Text(Loc.t("m_splash_title"))
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(Color.bbInk)
                    Text(Loc.t("m_splash_slogan"))
                        .font(.system(size: 12, weight: .medium))
                        .kerning(0.4)
                        .foregroundStyle(Color.bbInkFaint)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.horizontal, 40)
        }
        .onAppear { appeared = true }
    }
}
