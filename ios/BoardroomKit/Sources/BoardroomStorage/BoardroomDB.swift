import Foundation
import GRDB

/// The on-device SQLite store — the Swift counterpart of `src/storage/db.ts`.
///
/// A GRDB `DatabasePool` (WAL, concurrent reads + one writer) opened at a file
/// path under Application Support, migrated to head with the verbatim ported
/// schema (`SchemaMigrations.all`, generated from `src/storage/migrations/*.sql`).
/// Foreign keys are enforced (matching the desktop `PRAGMA foreign_keys = ON`).
///
/// Per the plan, the schema is kept byte-identical to the desktop DB; the
/// query surface (Rooms/Agents/Messages/… modules) grows on top of `pool`.
public final class BoardroomDB: Sendable {
    public let pool: DatabasePool

    /// Open (creating if needed) the store at `path` and migrate to head.
    public init(path: String) throws {
        var config = Configuration()
        config.foreignKeysEnabled = true            // ← PRAGMA foreign_keys = ON
        pool = try DatabasePool(path: path, configuration: config)   // WAL by default
        try Self.migrator.migrate(pool)
    }

    /// Default location: `Application Support/Boardroom/boardroom.sqlite`
    /// (mirrors the desktop `~/.boardroom/state.db`). Creates the directory.
    public static func defaultURL() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        ).appendingPathComponent("Boardroom", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("boardroom.sqlite")
    }

    public convenience init() throws {
        try self.init(path: Self.defaultURL().path)
    }

    /// The migration registry. Each entry's verbatim multi-statement SQL is run
    /// as one `execute` — exactly as `db.ts` runs `db.exec(m.sql)`. The file name
    /// is the migration identifier, so GRDB's applied-set matches the desktop's
    /// `_migrations` keys 1:1.
    public static let migrator: DatabaseMigrator = {
        var m = DatabaseMigrator()
        for entry in SchemaMigrations.all {
            m.registerMigration(entry.name) { db in
                try db.execute(sql: entry.sql)
            }
        }
        return m
    }()

    /// Identifiers of migrations recorded as applied (for diagnostics / tests).
    /// Read straight from GRDB's bookkeeping table — stable across GRDB versions.
    public func appliedMigrations() throws -> Set<String> {
        try pool.read { db in
            guard try db.tableExists("grdb_migrations") else { return [] }
            return try String.fetchSet(db, sql: "SELECT identifier FROM grdb_migrations")
        }
    }

    /// Checkpoint the WAL into the main db file. Call on scene background so a
    /// suspended/killed process doesn't leave recent writes stranded in the WAL
    /// (the desktop lesson — see CLAUDE.md "SQLite WAL must be checkpointed").
    public func checkpoint() throws {
        try pool.writeWithoutTransaction { db in
            _ = try db.checkpoint(.passive)
        }
    }
}
