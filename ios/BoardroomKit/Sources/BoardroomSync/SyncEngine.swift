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

    /// Flush locally-captured ops into our own append-only segment.
    @discardableResult
    public func push() async throws -> Int {
        let reg = registry
        let ops = try await pool.write { db -> [SyncOp] in
            _ = try SyncCapture.flushStaged(db, reg) // assign HLC + clock to trigger-staged rows
            return try SyncOutbox.read(db)
        }
        if ops.isEmpty { return 0 }
        let extOps = try await SyncBlobs.externalize(transport, ops, reg) // big data-URLs → blob refs
        try await transport.push(device: device, ops: extOps)
        let ids = ops.map(\.op_id)
        try await pool.write { db in try SyncOutbox.clear(db, opIds: ids) }
        return ops.count
    }

    /// Fetch peers' new ops and merge them; persist cursors only after apply.
    @discardableResult
    public func pull() async throws -> Int {
        let cursors = try await pool.read { db in try Self.loadCursors(db) }
        let result = try await transport.pull(cursors: cursors)
        let remote = result.ops.filter { $0.device != device }
        let reg = registry
        let intOps = try await SyncBlobs.internalize(transport, remote, reg) // blob refs → data-URLs
        let applied = try await pool.write { db in try SyncApply.applyOps(db, intOps, reg) }
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
    public func sync() async throws -> (pushed: Int, applied: Int) {
        let pushed = try await push()
        let applied = try await pull()
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
