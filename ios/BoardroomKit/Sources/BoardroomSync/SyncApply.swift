// iCloud sync · the merge core. Port of `src/sync/apply.ts`. Per-field LWW for
// `lww` entities, union for `append`, delete tombstones that survive a stale
// upsert, idempotency via `synced_ops`. Each op applies in its own savepoint so
// one bad op never poisons the batch (it's left unmarked and retried next pull).

import Foundation
import GRDB

public enum SyncApply {

    static func quoteIdent(_ name: String) throws -> String {
        var first = true
        for ch in name.unicodeScalars {
            let ok = CharacterSet.alphanumerics.contains(ch) || ch == "_"
            let okFirst = (ch == "_" || CharacterSet.letters.contains(ch))
            if first { if !okFirst { throw SyncError.unsafeIdentifier(name) } }
            else if !ok { throw SyncError.unsafeIdentifier(name) }
            first = false
        }
        if name.isEmpty { throw SyncError.unsafeIdentifier(name) }
        return "\"\(name)\""
    }


    static func alreadyApplied(_ db: Database, _ opId: String) throws -> Bool {
        try Bool.fetchOne(db, sql: "SELECT 1 FROM synced_ops WHERE op_id = ?", arguments: [opId]) ?? false
    }

    static func markApplied(_ db: Database, _ op: SyncOp) throws {
        try db.execute(
            sql: "INSERT OR IGNORE INTO synced_ops (op_id, device, applied_at) VALUES (?, ?, ?)",
            arguments: [op.op_id, op.device, op.ts])
    }

    static func rowExists(_ db: Database, _ table: String, _ pkCol: String, _ pk: String) throws -> Bool {
        let sql = "SELECT 1 FROM \(try quoteIdent(table)) WHERE \(try quoteIdent(pkCol)) = ?"
        return try Bool.fetchOne(db, sql: sql, arguments: [pk]) ?? false
    }

    /// Apply a batch of remote ops. Returns how many were newly applied.
    @discardableResult
    public static func applyOps(_ db: Database, _ ops: [SyncOp], _ registry: Registry) throws -> Int {
        var applied = 0
        let ordered = ops.sorted { $0.hlc < $1.hlc }
        // Suppress trigger capture for the whole merge so applying a remote op
        // never re-stages it (echo loop). Cleared even on throw.
        try SyncCapture.setSuppressed(db, true)
        defer { try? SyncCapture.setSuppressed(db, false) }
        for op in ordered {
            if try alreadyApplied(db, op.op_id) { continue }
            guard let spec = registry[op.entity] else { continue } // forward-compat: unknown entity
            do {
                try db.inSavepoint {
                    try SyncState.observe(db, op.hlc)
                    switch op.op {
                    case .delete: try applyDelete(db, spec, op)
                    case .upsert:
                        if spec.mode == .append { try applyAppend(db, spec, op) }
                        else { try applyLww(db, spec, op) }
                    }
                    try markApplied(db, op)
                    return .commit
                }
                applied += 1
            } catch {
                // Leave unmarked so a later pull retries (e.g. once an out-of-order
                // insert lands); never poison the whole batch on one bad op.
                FileHandle.standardError.write(
                    Data("[sync] apply skipped op \(op.op_id) (\(op.entity)/\(op.pk)): \(error)\n".utf8))
            }
        }
        return applied
    }

    static func applyDelete(_ db: Database, _ spec: EntitySpec, _ op: SyncOp) throws {
        let tomb = try FieldVersion.tombstone(db, op.entity, op.pk)
        if !SyncState.greater(op.hlc, tomb) { return }
        try FieldVersion.setTombstone(db, op.entity, op.pk, op.hlc)
        try db.execute(
            sql: "DELETE FROM \(try quoteIdent(spec.table)) WHERE \(try quoteIdent(spec.pk)) = ?",
            arguments: [op.pk])
    }

    static func applyAppend(_ db: Database, _ spec: EntitySpec, _ op: SyncOp) throws {
        if let tomb = try FieldVersion.tombstone(db, op.entity, op.pk), !SyncState.greater(op.hlc, tomb) { return }
        if try rowExists(db, spec.table, spec.pk, op.pk) { return } // immutable · first write wins
        try insertRow(db, spec.table, spec.pk, op.pk, op.cols ?? [:], spec.insertDefaults)
    }

    static func applyLww(_ db: Database, _ spec: EntitySpec, _ op: SyncOp) throws {
        if let tomb = try FieldVersion.tombstone(db, op.entity, op.pk), !SyncState.greater(op.hlc, tomb) { return }
        let cols = op.cols ?? [:]
        var winners: [String: SyncValue] = [:]
        for (field, val) in cols {
            let cur = try FieldVersion.get(db, op.entity, op.pk, field)
            if SyncState.greater(op.hlc, cur) { winners[field] = val }
        }
        if winners.isEmpty { return }
        if try rowExists(db, spec.table, spec.pk, op.pk) {
            try updateRow(db, spec.table, spec.pk, op.pk, winners)
        } else {
            try insertRow(db, spec.table, spec.pk, op.pk, cols, spec.insertDefaults) // genesis/insert carries the full row
        }
        for field in winners.keys { try FieldVersion.set(db, op.entity, op.pk, field, op.hlc) }
    }

    static func insertRow(_ db: Database, _ table: String, _ pkCol: String, _ pk: String,
                          _ cols: [String: SyncValue], _ insertDefaults: [String: String] = [:]) throws {
        let names = cols.keys.filter { $0 != pkCol }.sorted()
        // Device-local NOT-NULL columns absent from the op get a registry-supplied
        // SQL expression (trusted, inlined — e.g. rooms.number = local MAX()+1).
        let defaults = insertDefaults.keys.filter { $0 != pkCol && cols[$0] == nil }.sorted()
        var identParts: [String] = []
        for n in ([pkCol] + names + defaults) { identParts.append(try quoteIdent(n)) }
        let idents = identParts.joined(separator: ", ")
        let valueSql = (([pkCol] + names).map { _ in "?" } + defaults.map { insertDefaults[$0]! }).joined(separator: ", ")
        var values: [DatabaseValue] = [pk.databaseValue]
        for n in names { values.append((cols[n] ?? .null).dbValue) }
        let sql = "INSERT INTO \(try quoteIdent(table)) (\(idents)) VALUES (\(valueSql)) ON CONFLICT(\(try quoteIdent(pkCol))) DO NOTHING"
        try db.execute(sql: sql, arguments: StatementArguments(values))
    }

    static func updateRow(_ db: Database, _ table: String, _ pkCol: String, _ pk: String, _ cols: [String: SyncValue]) throws {
        let names = cols.keys.filter { $0 != pkCol }.sorted()
        if names.isEmpty { return }
        let setClause = try names.map { "\(try quoteIdent($0)) = ?" }.joined(separator: ", ")
        var values: [DatabaseValue] = names.map { (cols[$0] ?? .null).dbValue }
        values.append(pk.databaseValue)
        let sql = "UPDATE \(try quoteIdent(table)) SET \(setClause) WHERE \(try quoteIdent(pkCol)) = ?"
        try db.execute(sql: sql, arguments: StatementArguments(values))
    }
}
