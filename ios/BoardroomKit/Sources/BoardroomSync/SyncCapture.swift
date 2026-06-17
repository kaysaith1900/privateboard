// iCloud sync · the capture bridge (port of `src/sync/capture.ts`). SQLite
// triggers (migration 060) stage every write to a syncable table into
// `sync_outbox` with an EMPTY hlc; flushStaged() assigns the HLC + per-field LWW
// clock + ledger seed at push time, in local write order.

import Foundation
import GRDB

public enum SyncCapture {
    static let CAP_OFF = "cap_off"

    /// Toggle trigger capture. applyOps wraps its writes with this so merging a
    /// remote op never re-captures it (echo loop).
    public static func setSuppressed(_ db: Database, _ on: Bool) throws {
        try SyncState.set(db, CAP_OFF, on ? "1" : "0")
    }

    /// Fill HLC + field-version + ledger for trigger-staged rows (hlc = '').
    @discardableResult
    public static func flushStaged(_ db: Database, _ registry: Registry) throws -> Int {
        let dev = try SyncState.deviceId(db)
        let staged = try Row.fetchAll(
            db,
            sql: "SELECT seq, op_id, entity, pk, op, cols_json FROM sync_outbox WHERE hlc = '' ORDER BY seq ASC")
        if staged.isEmpty { return 0 }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        for row in staged {
            let seq: Int64 = row["seq"]
            let entity: String = row["entity"]
            let pk: String = row["pk"]
            let op: String = row["op"]
            let opId: String = row["op_id"]
            guard let spec = registry[entity] else {
                try db.execute(sql: "DELETE FROM sync_outbox WHERE seq = ?", arguments: [seq])
                continue
            }
            let hlc = try SyncState.nextHlc(db, device: dev)
            try db.execute(sql: "UPDATE sync_outbox SET hlc = ? WHERE seq = ?", arguments: [hlc, seq])
            if op == "delete" {
                try FieldVersion.setTombstone(db, entity, pk, hlc)
            } else if spec.mode == .lww, let colsJson: String = row["cols_json"],
                      let cols = SyncOutbox.decodeCols(colsJson) {
                for field in cols.keys { try FieldVersion.set(db, entity, pk, field, hlc) }
            }
            try db.execute(
                sql: "INSERT OR IGNORE INTO synced_ops (op_id, device, applied_at) VALUES (?, ?, ?)",
                arguments: [opId, dev, now])
        }
        return staged.count
    }
}
