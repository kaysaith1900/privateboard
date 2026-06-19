import XCTest
import GRDB
@testable import BoardroomStorage

final class MigrationsTests: XCTestCase {
    private func tempDBPath() -> String {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("boardroom.sqlite").path
    }

    func testRegistryHas61Migrations() {
        XCTAssertEqual(SchemaMigrations.all.count, 61)
        XCTAssertEqual(SchemaMigrations.all.first?.name, "001_init.sql")
        XCTAssertEqual(SchemaMigrations.all.last?.name, "061_sync_capture_triggers_v2.sql")
    }

    func testAllMigrationsApplyToHead() throws {
        let path = tempDBPath()
        try FileManager.default.createDirectory(
            at: URL(fileURLToPath: path).deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let db = try BoardroomDB(path: path)

        // All 61 recorded as applied.
        XCTAssertEqual(try db.appliedMigrations().count, 61)

        try db.pool.read { conn in
            // Core tables exist.
            for table in ["rooms", "agents", "messages", "config_events",
                          "room_members", "key_points", "briefs", "prefs",
                          "llm_credentials", "voice_credentials", "search_credentials"] {
                let exists = try Bool.fetchOne(conn, sql:
                    "SELECT count(*) > 0 FROM sqlite_master WHERE type='table' AND name=?",
                    arguments: [table]) ?? false
                XCTAssertTrue(exists, "missing table \(table)")
            }
            // Late-migration columns present → proves we ran to head, not just 001.
            XCTAssertTrue(try columnExists(conn, table: "agents", column: "avatar3d_json"))   // 057
            XCTAssertTrue(try columnExists(conn, table: "prefs", column: "avatar_url"))        // 058
            XCTAssertTrue(try columnExists(conn, table: "rooms", column: "room_kind"))         // 053

            // Foreign keys enforced.
            XCTAssertEqual(try Int.fetchOne(conn, sql: "PRAGMA foreign_keys"), 1)

            // The 001 seed prefs row round-trips.
            let name = try String.fetchOne(conn, sql: "SELECT name FROM prefs WHERE id=1")
            XCTAssertEqual(name, "You")

            // 022 transform: no legacy 'brutal' intensity survives the rename.
            let brutal = try Int.fetchOne(conn, sql:
                "SELECT count(*) FROM rooms WHERE intensity='brutal'") ?? -1
            XCTAssertEqual(brutal, 0)
        }
    }

    func testReopeningIsIdempotent() throws {
        let path = tempDBPath()
        try FileManager.default.createDirectory(
            at: URL(fileURLToPath: path).deletingLastPathComponent(),
            withIntermediateDirectories: true)
        _ = try BoardroomDB(path: path)
        // Second open re-runs the migrator → no-op, no throw, still 61 applied.
        let db2 = try BoardroomDB(path: path)
        XCTAssertEqual(try db2.appliedMigrations().count, 61)
    }

    func testRoundTripWrite() throws {
        let path = tempDBPath()
        try FileManager.default.createDirectory(
            at: URL(fileURLToPath: path).deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let db = try BoardroomDB(path: path)
        try db.pool.write { conn in
            try conn.execute(sql:
                "UPDATE prefs SET name = ? WHERE id = 1", arguments: ["Kay"])
        }
        let name = try db.pool.read { try String.fetchOne($0, sql: "SELECT name FROM prefs WHERE id=1") }
        XCTAssertEqual(name, "Kay")
        try db.checkpoint()   // WAL checkpoint must not throw
    }

    private func columnExists(_ db: Database, table: String, column: String) throws -> Bool {
        try Row.fetchAll(db, sql: "PRAGMA table_info(\(table))")
            .contains { ($0["name"] as String?) == column }
    }
}

private extension URL {
    init(fileURLToPath path: String) { self = URL(fileURLWithPath: path) }
}
