// iCloud sync · the engine actor (port of `src/sync/engine.ts`). push() flushes
// our outbox into our oplog segment; pull() merges peers' segments; sync() does
// both. Driven on quiescence (room adjourn / scenePhase background / before the
// GRDB WAL checkpoint) — never on the live hot path. Actor-isolated so the
// fire-and-forget flush is concurrency-safe alongside the room engine.

import Foundation
import GRDB

public actor SyncEngine {
    private let pool: DatabasePool
    private let transport: SyncTransport
    private let registry: Registry
    public nonisolated let device: String

    private static let cursorPrefix = "cursor:"

    public init(pool: DatabasePool, transport: SyncTransport, registry: Registry = SyncRegistry.entities) async throws {
        self.pool = pool
        self.transport = transport
        self.registry = registry
        self.device = try await pool.write { db in
            let id = try SyncState.deviceId(db)
            try SyncState.set(db, "enabled", "1")    // turn on the capture triggers
            try SyncCapture.setSuppressed(db, false) // defensive · clear stale suppression
            return id
        }
    }

    /// Sync progress callback · `(phase, done, total)`. Fired off-actor; the UI
    /// hops to the main actor itself. Lets the settings screen show a moving bar +
    /// live counts instead of one opaque "syncing…" with no feedback.
    public enum Phase: Sendable, Equatable { case uploading, downloading }
    public typealias Progress = @Sendable (_ phase: Phase, _ done: Int, _ total: Int) -> Void

    private static let batchSize = 300

    /// Flush locally-captured ops into our own append-only segment, IN BATCHES so a
    /// large first sync (genesis · thousands of ops) reports steady progress and the
    /// outbox count visibly drains instead of jumping 2500→0 at the very end.
    @discardableResult
    public func push(progress: Progress? = nil) async throws -> Int {
        let reg = registry
        let total = try await pool.write { db -> Int in
            _ = try SyncCapture.flushStaged(db, reg) // assign HLC + clock to all staged rows once
            return try SyncOutbox.count(db)
        }
        if total == 0 { return 0 }
        var pushed = 0
        while true {
            let ops = try await pool.read { db in try SyncOutbox.read(db, limit: Self.batchSize) }
            if ops.isEmpty { break }
            let extOps = try await SyncBlobs.externalize(transport, ops, reg) // data-URLs → blob refs
            try await transport.push(device: device, ops: extOps)
            let ids = ops.map(\.op_id)
            try await pool.write { db in try SyncOutbox.clear(db, opIds: ids) }
            pushed += ops.count
            progress?(.uploading, pushed, total)
        }
        return pushed
    }

    /// Fetch peers' new ops and merge them IN BATCHES (progress + responsiveness);
    /// persist cursors only after the whole apply so a mid-way failure re-pulls
    /// (idempotent via the synced_ops ledger).
    @discardableResult
    public func pull(progress: Progress? = nil) async throws -> Int {
        let cursors = try await pool.read { db in try Self.loadCursors(db) }
        let result = try await transport.pull(cursors: cursors)
        let remote = result.ops.filter { $0.device != device }
        let reg = registry
        let total = remote.count
        if total == 0 {
            try await pool.write { db in try Self.saveCursors(db, result.cursors) }
            return 0
        }
        progress?(.downloading, 0, total)
        let intOps = try await SyncBlobs.internalize(transport, remote, reg) // blob refs → data-URLs (downloads blobs)
        var applied = 0
        var i = 0
        while i < intOps.count {
            let slice = Array(intOps[i ..< min(i + Self.batchSize, intOps.count)])
            applied += try await pool.write { db in try SyncApply.applyOps(db, slice, reg) }
            i += slice.count
            progress?(.downloading, min(i, total), total)
        }
        try await pool.write { db in try Self.saveCursors(db, result.cursors) }
        return applied
    }

    /// One-time full export of every existing local row into the outbox, the
    /// first time this device syncs to a given folder (port of
    /// `SyncEngine.ensureGenesis` in src/sync/engine.ts). The capture triggers
    /// only fire on writes made AFTER enabling, so without this a device that
    /// already had directors / rooms / memories would never upload them.
    /// Idempotent per folder via a `genesis:<folderTag>` marker. Returns the
    /// number of rows staged.
    @discardableResult
    public func ensureGenesis(folderTag: String) async throws -> Int {
        let key = "genesis:\(folderTag):v\(SyncGenesis.version)"
        return try await pool.write { db -> Int in
            if try SyncState.get(db, key) == "1" { return 0 }
            var staged = 0
            for sql in SyncGenesis.statements {
                try db.execute(sql: sql)
                staged += db.changesCount
            }
            try SyncState.set(db, key, "1")
            return staged
        }
    }

    /// One quiescent convergence beat.
    @discardableResult
    public func sync(progress: Progress? = nil) async throws -> (pushed: Int, applied: Int) {
        let pushed = try await push(progress: progress)
        let applied = try await pull(progress: progress)
        return (pushed, applied)
    }

    static func loadCursors(_ db: Database) throws -> [String: Int] {
        let rows = try Row.fetchAll(db, sql: "SELECT key, value FROM sync_state WHERE key LIKE ?",
                                    arguments: ["\(cursorPrefix)%"])
        var out: [String: Int] = [:]
        for r in rows {
            let key: String = r["key"]
            let value: String = r["value"]
            out[String(key.dropFirst(cursorPrefix.count))] = Int(value) ?? 0
        }
        return out
    }

    static func saveCursors(_ db: Database, _ cursors: [String: Int]) throws {
        for (device, n) in cursors {
            try SyncState.set(db, "\(cursorPrefix)\(device)", String(n))
        }
    }
}
