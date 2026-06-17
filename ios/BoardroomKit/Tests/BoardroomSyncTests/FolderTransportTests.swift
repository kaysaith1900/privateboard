// P2 · FolderTransport — proves the on-disk JSONL oplog format converges two
// devices through a shared folder (a local temp dir stands in for the iCloud
// ubiquity container; the read/append/cursor logic is identical).

import XCTest
import GRDB
import BoardroomStorage
@testable import BoardroomSync

private let REG: Registry = [
    "t_lww": EntitySpec(entity: "t_lww", table: "t_lww", pk: "id", mode: .lww),
    "t_app": EntitySpec(entity: "t_app", table: "t_app", pk: "id", mode: .append),
]

final class FolderTransportTests: XCTestCase {
    var dir: URL!
    var cloud: URL!
    var dbA: BoardroomDB!
    var dbB: BoardroomDB!
    var engA: SyncEngine!
    var engB: SyncEngine!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("ft-\(UUID().uuidString)")
        cloud = dir.appendingPathComponent("cloud")
        try FileManager.default.createDirectory(at: cloud, withIntermediateDirectories: true)
        dbA = try BoardroomDB(path: dir.appendingPathComponent("a.sqlite").path)
        dbB = try BoardroomDB(path: dir.appendingPathComponent("b.sqlite").path)
        for db in [dbA!, dbB!] {
            try await db.pool.write { d in
                try d.execute(sql: "CREATE TABLE t_lww (id TEXT PRIMARY KEY, a TEXT, b TEXT)")
                try d.execute(sql: "CREATE TABLE t_app (id TEXT PRIMARY KEY, body TEXT)")
            }
        }
        // Each "device" has its own transport pointing at the SAME shared folder.
        engA = try await SyncEngine(pool: dbA.pool, transport: FolderTransport(root: cloud), registry: REG)
        engB = try await SyncEngine(pool: dbB.pool, transport: FolderTransport(root: cloud), registry: REG)
    }
    override func tearDown() async throws {
        dbA = nil; dbB = nil
        try? FileManager.default.removeItem(at: dir)
    }

    func putLww(_ db: BoardroomDB, _ pk: String, _ cols: [String: String]) throws {
        try db.pool.write { d in
            let keys = cols.keys.sorted()
            let idents = (["id"] + keys).joined(separator: ", ")
            let ph = (["id"] + keys).map { _ in "?" }.joined(separator: ", ")
            let set = keys.map { "\($0)=excluded.\($0)" }.joined(separator: ", ")
            var args: [DatabaseValue] = [pk.databaseValue]
            for k in keys { args.append(cols[k]!.databaseValue) }
            try d.execute(sql: "INSERT INTO t_lww (\(idents)) VALUES (\(ph)) ON CONFLICT(id) DO UPDATE SET \(set)",
                          arguments: StatementArguments(args))
            var sv: [String: SyncValue] = [:]; for (k, v) in cols { sv[k] = .text(v) }
            try SyncOutbox.recordUpsert(d, REG, "t_lww", pk, sv)
        }
    }
    func appendMsg(_ db: BoardroomDB, _ pk: String, _ body: String) throws {
        try db.pool.write { d in
            try d.execute(sql: "INSERT INTO t_app (id, body) VALUES (?, ?)", arguments: [pk, body])
            try SyncOutbox.recordUpsert(d, REG, "t_app", pk, ["body": .text(body)])
        }
    }
    func rowLww(_ db: BoardroomDB, _ pk: String) throws -> (a: String?, b: String?)? {
        try db.pool.read { d in
            guard let r = try Row.fetchOne(d, sql: "SELECT a, b FROM t_lww WHERE id = ?", arguments: [pk]) else { return nil }
            return (r["a"], r["b"])
        }
    }
    func appIds(_ db: BoardroomDB) throws -> [String] {
        try db.pool.read { d in try String.fetchAll(d, sql: "SELECT id FROM t_app ORDER BY id") }
    }
    func syncBoth() async throws {
        _ = try await engA.sync(); _ = try await engB.sync()
        _ = try await engA.sync(); _ = try await engB.sync()
    }

    func testOnDiskConvergence() async throws {
        try putLww(dbA, "x", ["a": "a1", "b": "b1"])
        try appendMsg(dbA, "m1", "hi")
        try appendMsg(dbB, "m2", "yo")
        try putLww(dbB, "x", ["b": "b2"]) // concurrent different-field edit (lands after a1/b1 sync)
        try await syncBoth()

        // The oplog file physically exists on disk for each device.
        let aFile = cloud.appendingPathComponent("devices/\(engA.device)/ops.jsonl")
        XCTAssertTrue(FileManager.default.fileExists(atPath: aFile.path))

        // Both converge: per-field LWW + append union over the real JSONL format.
        XCTAssertEqual(try rowLww(dbA, "x")?.a, "a1")
        XCTAssertEqual(try rowLww(dbB, "x")?.a, "a1")
        XCTAssertEqual(try rowLww(dbA, "x")?.b, "b2")
        XCTAssertEqual(try rowLww(dbB, "x")?.b, "b2")
        XCTAssertEqual(try appIds(dbA), ["m1", "m2"])
        XCTAssertEqual(try appIds(dbB), ["m1", "m2"])
    }

    func testCursorsPersistAcrossReopen() async throws {
        try appendMsg(dbA, "m1", "hi")
        try await syncBoth()
        XCTAssertEqual(try appIds(dbB), ["m1"])
        // A fresh engine on the same db + folder must NOT re-apply (cursors +
        // synced_ops persisted in sync_state) — idempotent across process restart.
        let engB2 = try await SyncEngine(pool: dbB.pool, transport: FolderTransport(root: cloud), registry: REG)
        let applied = try await engB2.pull()
        XCTAssertEqual(applied, 0)
        XCTAssertEqual(try appIds(dbB), ["m1"])
    }
}
