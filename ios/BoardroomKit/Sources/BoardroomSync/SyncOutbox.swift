// iCloud sync · capture local writes into `sync_outbox`. Port of
// `src/sync/outbox.ts`. Called by the GRDB afterCommit hook AFTER the app
// has written the row — this layer only records the change. JSON helpers
// encode/decode the `cols` payload.

import Foundation
import GRDB

public enum SyncOutbox {
    static func encodeCols(_ cols: [String: SyncValue]) -> String {
        guard let data = try? JSONEncoder().encode(cols),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }

    static func decodeCols(_ json: String?) -> [String: SyncValue]? {
        guard let json, let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode([String: SyncValue].self, from: data)
    }

    @discardableResult
    public static func recordUpsert(_ db: Database, _ registry: Registry,
                                    _ entity: String, _ pk: String,
                                    _ cols: [String: SyncValue]) throws -> SyncOp {
        try record(db, registry, entity, pk, .upsert, cols)
    }

    @discardableResult
    public static func recordDelete(_ db: Database, _ registry: Registry,
                                    _ entity: String, _ pk: String) throws -> SyncOp {
        try record(db, registry, entity, pk, .delete, nil)
    }

    private static func record(_ db: Database, _ registry: Registry,
                               _ entity: String, _ pk: String,
                               _ op: OpType, _ cols: [String: SyncValue]?) throws -> SyncOp {
        guard let spec = registry[entity] else { throw SyncError.unknownEntity(entity) }
        let dev = try SyncState.deviceId(db)
        let hlc = try SyncState.nextHlc(db, device: dev)
        let opId = UUID().uuidString
        let ts = Int64(Date().timeIntervalSince1970 * 1000)

        try db.execute(
            sql: """
            INSERT INTO sync_outbox (op_id, entity, pk, op, cols_json, hlc, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            arguments: [opId, entity, pk, op.rawValue,
                        cols != nil ? encodeCols(cols!) : nil, hlc, ts])

        // Advance our own clocks so the merge keeps our write over an older peer op.
        if op == .delete {
            try FieldVersion.setTombstone(db, entity, pk, hlc)
        } else if spec.mode == .lww {
            for field in (cols ?? [:]).keys { try FieldVersion.set(db, entity, pk, field, hlc) }
        }
        // Pre-seed the applied ledger so reading our own oplog back is a no-op.
        try db.execute(
            sql: "INSERT OR IGNORE INTO synced_ops (op_id, device, applied_at) VALUES (?, ?, ?)",
            arguments: [opId, dev, ts])

        return SyncOp(op_id: opId, device: dev, entity: entity, pk: pk, op: op, cols: cols, hlc: hlc, ts: ts)
    }

    /// Drain pending outbox rows in flush order.
    public static func read(_ db: Database, limit: Int = 5000) throws -> [SyncOp] {
        let dev = try SyncState.deviceId(db)
        let rows = try Row.fetchAll(
            db,
            sql: """
            SELECT op_id, entity, pk, op, cols_json, hlc, created_at
            FROM sync_outbox ORDER BY seq ASC LIMIT ?
            """,
            arguments: [limit])
        return rows.map { r in
            SyncOp(
                op_id: r["op_id"], device: dev, entity: r["entity"], pk: r["pk"],
                op: OpType(rawValue: r["op"]) ?? .upsert,
                cols: decodeCols(r["cols_json"]),
                hlc: r["hlc"], ts: r["created_at"])
        }
    }

    public static func clear(_ db: Database, opIds: [String]) throws {
        for id in opIds {
            try db.execute(sql: "DELETE FROM sync_outbox WHERE op_id = ?", arguments: [id])
        }
    }
}

public enum SyncError: Error {
    case unknownEntity(String)
    case unsafeIdentifier(String)
}
