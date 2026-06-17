// P2 · Swift sync engine — deterministic two-device convergence over the
// in-memory transport (mirrors tests/sync-engine.test.ts). No iCloud.

import XCTest
import GRDB
import BoardroomStorage
@testable import BoardroomSync

private let REG: Registry = [
    "t_lww": EntitySpec(entity: "t_lww", table: "t_lww", pk: "id", mode: .lww),
    "t_app": EntitySpec(entity: "t_app", table: "t_app", pk: "id", mode: .append),
]

final class SyncEngineTests: XCTestCase {
    var dir: URL!
    var dbA: BoardroomDB!
    var dbB: BoardroomDB!
    var transport: InMemoryTransport!
    var engA: SyncEngine!
    var engB: SyncEngine!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("sync-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        dbA = try BoardroomDB(path: dir.appendingPathComponent("a.sqlite").path)
        dbB = try BoardroomDB(path: dir.appendingPathComponent("b.sqlite").path)
        for db in [dbA!, dbB!] {
            try await db.pool.write { d in
                try d.execute(sql: "CREATE TABLE t_lww (id TEXT PRIMARY KEY, a TEXT, b TEXT)")
                try d.execute(sql: "CREATE TABLE t_app (id TEXT PRIMARY KEY, body TEXT)")
            }
        }
        transport = InMemoryTransport()
        engA = try await SyncEngine(pool: dbA.pool, transport: transport, registry: REG)
        engB = try await SyncEngine(pool: dbB.pool, transport: transport, registry: REG)
    }

    override func tearDown() async throws {
        dbA = nil; dbB = nil
        try? FileManager.default.removeItem(at: dir)
    }

    // ── helpers (simulate the app's storage write + the capture hook) ──
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
            var sv: [String: SyncValue] = [:]
            for (k, v) in cols { sv[k] = .text(v) }
            try SyncOutbox.recordUpsert(d, REG, "t_lww", pk, sv)
        }
    }
    func appendMsg(_ db: BoardroomDB, _ pk: String, _ body: String) throws {
        try db.pool.write { d in
            try d.execute(sql: "INSERT INTO t_app (id, body) VALUES (?, ?)", arguments: [pk, body])
            try SyncOutbox.recordUpsert(d, REG, "t_app", pk, ["body": .text(body)])
        }
    }
    func del(_ db: BoardroomDB, _ entity: String, _ table: String, _ pk: String) throws {
        try db.pool.write { d in
            try d.execute(sql: "DELETE FROM \(table) WHERE id = ?", arguments: [pk])
            try SyncOutbox.recordDelete(d, REG, entity, pk)
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

    // ── scenarios ──
    func testPropagatesNewRow() async throws {
        try putLww(dbA, "x", ["a": "a1", "b": "b1"])
        try await syncBoth()
        let r = try rowLww(dbB, "x")
        XCTAssertEqual(r?.a, "a1"); XCTAssertEqual(r?.b, "b1")
    }

    func testPerFieldLWWConcurrentDifferentFields() async throws {
        try putLww(dbA, "x", ["a": "a1", "b": "b1"]); try await syncBoth()
        try putLww(dbA, "x", ["a": "a2"])
        try putLww(dbB, "x", ["b": "b2"])
        try await syncBoth()
        let ra = try rowLww(dbA, "x"); let rb = try rowLww(dbB, "x")
        XCTAssertEqual(ra?.a, "a2"); XCTAssertEqual(ra?.b, "b2")
        XCTAssertEqual(rb?.a, "a2"); XCTAssertEqual(rb?.b, "b2")
    }

    func testSameFieldConflictConverges() async throws {
        try putLww(dbA, "x", ["a": "a0", "b": "b0"]); try await syncBoth()
        try putLww(dbB, "x", ["a": "fromB"])
        try await Task.sleep(nanoseconds: 2_000_000)
        try putLww(dbA, "x", ["a": "fromA"])
        try await syncBoth()
        XCTAssertEqual(try rowLww(dbA, "x")?.a, "fromA")
        XCTAssertEqual(try rowLww(dbB, "x")?.a, "fromA")
    }

    func testAppendUnion() async throws {
        try appendMsg(dbA, "m1", "hi"); try appendMsg(dbA, "m2", "there"); try appendMsg(dbB, "m3", "yo")
        try await syncBoth()
        XCTAssertEqual(try appIds(dbA), ["m1", "m2", "m3"])
        XCTAssertEqual(try appIds(dbB), ["m1", "m2", "m3"])
    }

    func testDeleteTombstoneNoResurrect() async throws {
        try putLww(dbA, "x", ["a": "a1", "b": "b1"]); try await syncBoth()
        try putLww(dbB, "x", ["a": "zombie"])
        try await Task.sleep(nanoseconds: 2_000_000)
        try del(dbA, "t_lww", "t_lww", "x")
        try await syncBoth()
        XCTAssertNil(try rowLww(dbA, "x"))
        XCTAssertNil(try rowLww(dbB, "x"))
    }

    func testIdempotentRepull() async throws {
        try putLww(dbA, "x", ["a": "a1", "b": "b1"]); try appendMsg(dbA, "m1", "hi")
        try await syncBoth()
        let again = try await engB.pull()
        XCTAssertEqual(again, 0)
        XCTAssertEqual(try appIds(dbB), ["m1"])
    }

    func testNoEchoOfOwnOps() async throws {
        try putLww(dbA, "x", ["a": "a1", "b": "b1"])
        _ = try await engA.sync()
        let reapplied = try await engA.pull()
        XCTAssertEqual(reapplied, 0)
        XCTAssertEqual(try rowLww(dbA, "x")?.a, "a1")
    }
}
