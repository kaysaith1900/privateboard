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
                .onReceive(NotificationCenter.default.publisher(for: .bbSyncApplied)) { _ in
                    app.applySyncedChanges()   // iCloud merge → reload rooms + roster live
                }
                .task {
                    // iCloud sync · adopt the persisted toggle once the native DB is open.
                    if let pool = NativeEngineHost.shared?.db.pool {
                        await SyncCoordinator.shared.attach(pool: pool)
                    }
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
            case .background:
                enteredBackground = true
                Task { await SyncCoordinator.shared.onBackground() } // flush+pull before suspend
            case .active where enteredBackground:
                enteredBackground = false
                app.handleForeground()
                Task { await SyncCoordinator.shared.onForeground() } // pull peers' changes
            default: break
            }
        }
    }
}
