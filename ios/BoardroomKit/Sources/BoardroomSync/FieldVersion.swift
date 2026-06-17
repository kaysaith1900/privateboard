// iCloud sync · per-field HLC clock + tombstones in `sync_field_version`.
// Port of `src/sync/fieldver.ts`.

import GRDB

public enum FieldVersion {
    public static func get(_ db: Database, _ entity: String, _ pk: String, _ field: String) throws -> HLC? {
        try String.fetchOne(
            db,
            sql: "SELECT hlc FROM sync_field_version WHERE entity = ? AND pk = ? AND field = ?",
            arguments: [entity, pk, field])
    }

    public static func set(_ db: Database, _ entity: String, _ pk: String, _ field: String, _ hlc: HLC) throws {
        try db.execute(
            sql: """
            INSERT INTO sync_field_version (entity, pk, field, hlc) VALUES (?, ?, ?, ?)
            ON CONFLICT(entity, pk, field) DO UPDATE SET hlc = excluded.hlc
            """,
            arguments: [entity, pk, field, hlc])
    }

    public static func tombstone(_ db: Database, _ entity: String, _ pk: String) throws -> HLC? {
        try get(db, entity, pk, ROW_TOMBSTONE)
    }

    /// Record a delete tombstone and drop the row's per-field clocks.
    public static func setTombstone(_ db: Database, _ entity: String, _ pk: String, _ hlc: HLC) throws {
        try db.execute(
            sql: "DELETE FROM sync_field_version WHERE entity = ? AND pk = ? AND field != ?",
            arguments: [entity, pk, ROW_TOMBSTONE])
        try set(db, entity, pk, ROW_TOMBSTONE, hlc)
    }
}
