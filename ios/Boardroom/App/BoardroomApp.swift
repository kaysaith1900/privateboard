import SwiftUI

@main
struct BoardroomApp: App {
    @State private var app = AppState()
    @State private var localeTick = 0   // bump → rebuild tree on language change
    @State private var enteredBackground = false   // gate the foreground recovery on a REAL suspend
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .preferredColorScheme(.dark)
                .tint(.bbGold)
                .id(localeTick)
                .onReceive(NotificationCenter.default.publisher(for: .bbLocaleChanged)) { _ in
                    localeTick += 1
                }
        }
        // Resume from background · iOS may have reclaimed the loopback's listening
        // socket while suspended, blanking every avatar + the API-keys list. Recover
        // on the first .active AFTER a real .background. NB: unlocking goes
        // .background → .inactive → .active (never a DIRECT background→active), so the
        // old `old == .background && new == .active` guard never fired and recovery
        // only happened on a full restart. Track the suspend with a flag instead, so
        // the intermediate .inactive doesn't swallow the transition. Control Center /
        // launch are .active⇄.inactive only (flag stays false → no needless rebind).
        .onChange(of: scenePhase) { _, new in
            switch new {
            case .background: enteredBackground = true
            case .active where enteredBackground: enteredBackground = false; app.handleForeground()
            default: break
            }
        }
    }
}
