// iCloud sync · the iOS control plane (the app-side counterpart of the desktop
// SyncManager). @MainActor + @Observable so the settings UI binds to it directly.
// Owns the BoardroomSync engine against the app's GRDB pool, persists the user's
// toggle, drives convergence on scenePhase transitions + remote-change pushes,
// and surfaces live progress. iCloud I/O (forUbiquityContainerIdentifier) is
// done off the main thread.
//
// ⚠️ Requires the app to ship the iCloud capability + the
// `iCloud.ai.boardroom.mobile` container (Xcode → Signing & Capabilities) and
// the Info.plist NSUbiquitousContainers entry — otherwise makeTransport()
// returns nil and the coordinator reports `available == false`.

import Foundation
import Observation
import GRDB
import BoardroomStorage
import BoardroomSync

extension Notification.Name {
    /// Posted (main thread) after a sync applied ≥1 remote op to the local DB, so
    /// the shell can reload rooms + roster and repaint without an app restart.
    static let bbSyncApplied = Notification.Name("bb.sync.applied")
}

@MainActor
@Observable
final class SyncCoordinator {
    struct Status {
        var enabled = false      // the user's toggle (persisted)
        var available = false    // an iCloud container is reachable
        var running = false      // engine active
        var state = "off"        // off | idle | syncing | error
        var lastSyncAt: Date?
        var pending = 0          // local changes waiting to upload
        var tracked = 0          // ops this device has synced (proof data is in iCloud)
        var deviceID: String?
        var error: String?
    }

    static let shared = SyncCoordinator()
    private init() {}

    private(set) var status = Status()

    @ObservationIgnored private var pool: DatabasePool?
    @ObservationIgnored private var engine: SyncEngine?
    @ObservationIgnored private var observer: ICloudChangeObserver?
    @ObservationIgnored private var syncing = false

    /// Call once at launch (after the native DB is open) — adopts the persisted toggle.
    func attach(pool: DatabasePool) async {
        self.pool = pool
        status.available = await Task.detached { ICloudContainer.documentsRoot() != nil }.value
        let persisted = (try? await pool.read { db in
            try String.fetchOne(db, sql: "SELECT value FROM sync_state WHERE key = 'user_enabled'")
        }) ?? nil
        if persisted == "1" { await start() } else { await refreshCounts() }
    }

    /// Lazily resolve the GRDB pool from the engine host. The settings screen can
    /// be reached before the launch `.task` runs `attach`, so every entry point
    /// resolves the pool here instead of silently no-op'ing on a nil pool.
    private func ensurePool() -> DatabasePool? {
        if pool == nil { pool = NativeEngineHost.shared?.db.pool }
        return pool
    }

    /// The settings toggle.
    func setEnabled(_ on: Bool) async {
        guard let pool = ensurePool() else {
            status.error = "Engine not ready — reopen the app and try again."
            status.state = "error"
            return
        }
        status.enabled = on   // reflect the toggle immediately, before any I/O
        try? await pool.write { db in try SyncState.set(db, "user_enabled", on ? "1" : "0") }
        if on { await start() } else { await stop() }
    }

    /// Force a convergence beat (Sync-now button / scenePhase).
    func syncNow() async {
        if engine == nil, status.enabled { await start() }   // self-heal if enabled but never started
        guard let engine, !syncing else { await refreshCounts(); return }
        syncing = true
        status.state = "syncing"
        do {
            let result = try await engine.sync()
            status.lastSyncAt = Date()
            status.error = nil
            status.state = "idle"
            // Peers' changes just landed in the local DB — tell the shell to reload
            // rooms + roster so the UI updates live instead of only after a restart.
            if result.applied > 0 { NotificationCenter.default.post(name: .bbSyncApplied, object: nil) }
        } catch {
            status.error = "\(error)"
            status.state = "error"
        }
        syncing = false
        await refreshCounts()
    }

    /// Refresh availability + pending/tracked counts without a full sync (e.g.
    /// when the settings screen appears).
    func refresh() async { _ = ensurePool(); await refreshCounts() }

    /// scenePhase → background: flush + pull before the app suspends.
    func onBackground() async { if engine != nil { await syncNow() } }
    /// scenePhase → active: pull whatever peers changed while away.
    func onForeground() async { if engine != nil { await syncNow() } }

    // MARK: - internals

    private func start() async {
        guard let pool = ensurePool(), engine == nil else { return }
        status.enabled = true
        let transport = await Task.detached { ICloudContainer.makeTransport() }.value
        guard let transport else {
            let signedIn = await Task.detached { ICloudContainer.isSignedIn }.value
            status.available = false; status.running = false; status.state = "error"
            status.error = signedIn
                ? "iCloud is on, but this app's iCloud container isn't available. If it persists after a relaunch, the installed build is missing the iCloud capability for container \(ICloudContainer.identifier) (re-check Signing & Capabilities → iCloud)."
                : "Not signed in to iCloud. Open Settings → your name → iCloud and turn on iCloud Drive, then reopen the app."
            return
        }
        do {
            let e = try await SyncEngine(pool: pool, transport: transport)
            engine = e
            status.available = true; status.running = true; status.state = "idle"; status.error = nil
            status.deviceID = e.device
            // One-time full export of pre-existing rows so a device that already
            // had directors/rooms/memories uploads them (the app container path is
            // stable, so a fixed folder tag is enough — no desktop-style re-point).
            _ = try? await e.ensureGenesis(folderTag: "icloud-app-container")
            let obs = ICloudChangeObserver {
                Task { @MainActor in await SyncCoordinator.shared.syncNow() }
            }
            obs.start()
            observer = obs
            await syncNow()
        } catch {
            status.error = "\(error)"; status.state = "error"; status.running = false
        }
    }

    private func stop() async {
        observer?.stop(); observer = nil
        if let engine { _ = try? await engine.push() } // final flush before tearing down
        engine = nil
        status.running = false
        status.state = status.enabled ? "idle" : "off"
        await refreshCounts()
    }

    private func refreshCounts() async {
        guard let pool else { return }
        let counts = try? await pool.read { db -> (Int, Int) in
            (try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM sync_outbox") ?? 0,
             try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM synced_ops") ?? 0)
        }
        if let counts { status.pending = counts.0; status.tracked = counts.1 }
        status.available = await Task.detached { ICloudContainer.documentsRoot() != nil }.value
    }
}
