// P2 · capture bridge on the REAL schema (Swift) — mirrors tests/sync-capture.test.ts.
// Trigger → flushStaged → oplog → apply, using the default SyncRegistry over the
// real agents/rooms tables, through the in-memory transport (no iCloud).

import XCTest
import GRDB
import BoardroomStorage
@testable import BoardroomSync

final class CaptureBridgeTests: XCTestCase {
    var dir: URL!
    var dbA: BoardroomDB!
    var dbB: BoardroomDB!
    var A: SyncEngine!
    var B: SyncEngine!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("cap-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        dbA = try BoardroomDB(path: dir.appendingPathComponent("a.sqlite").path)
        dbB = try BoardroomDB(path: dir.appendingPathComponent("b.sqlite").path)
        let t = InMemoryTransport()
        A = try await SyncEngine(pool: dbA.pool, transport: t)   // default real registry
        B = try await SyncEngine(pool: dbB.pool, transport: t)
    }
    override func tearDown() async throws {
        dbA = nil; dbB = nil
        try? FileManager.default.removeItem(at: dir)
    }

    func insertAgent(_ db: BoardroomDB, _ id: String, _ name: String, _ handle: String, _ model: String = "sonnet-4-6") throws {
        try db.pool.write { d in
            try d.execute(sql: """
                INSERT INTO agents (id,name,handle,instruction,model_v,avatar_path,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?)
                """, arguments: [id, name, handle, "inst", model, "avatar",
                                 Int64(Date().timeIntervalSince1970 * 1000),
                                 Int64(Date().timeIntervalSince1970 * 1000)])
        }
    }
    func insertRoom(_ db: BoardroomDB, _ id: String, _ number: Int, _ name: String) throws {
        try db.pool.write { d in
            try d.execute(sql: """
                INSERT INTO rooms (id,number,name,subject,mode,status,created_at,intensity,
                  awaiting_continue,awaiting_clarify,incognito,delivery_mode,vote_trigger,name_auto,room_kind)
                VALUES (?,?,?,?, 'constructive','live',?, 'sharp', 0,0,0,'text','auto',1,'main')
                """, arguments: [id, number, name, "subj", Int64(Date().timeIntervalSince1970 * 1000)])
        }
    }
    func agentName(_ db: BoardroomDB, _ id: String) throws -> String? {
        try db.pool.read { d in try String.fetchOne(d, sql: "SELECT name FROM agents WHERE id = ?", arguments: [id]) }
    }
    func agentModel(_ db: BoardroomDB, _ id: String) throws -> String? {
        try db.pool.read { d in try String.fetchOne(d, sql: "SELECT model_v FROM agents WHERE id = ?", arguments: [id]) }
    }
    func roomNumberName(_ db: BoardroomDB, _ id: String) throws -> (Int, String)? {
        try db.pool.read { d in
            guard let r = try Row.fetchOne(d, sql: "SELECT number, name FROM rooms WHERE id = ?", arguments: [id]) else { return nil }
            return (r["number"], r["name"])
        }
    }
    func outboxCount(_ db: BoardroomDB) throws -> Int {
        try db.pool.read { d in try Int.fetchOne(d, sql: "SELECT COUNT(*) FROM sync_outbox") ?? 0 }
    }
    func syncBoth() async throws {
        _ = try await A.sync(); _ = try await B.sync(); _ = try await A.sync(); _ = try await B.sync()
    }

    func testDirectorPropagates() async throws {
        try insertAgent(dbA, "ag1", "Maya", "@maya")
        try await syncBoth()
        XCTAssertEqual(try agentName(dbB, "ag1"), "Maya")
    }

    func testDirectorEditPropagates() async throws {
        try insertAgent(dbA, "ag1", "Maya", "@maya", "sonnet-4-6")
        try await syncBoth()
        try await dbA.pool.write { d in try d.execute(sql: "UPDATE agents SET model_v = ? WHERE id = ?", arguments: ["opus-4-8", "ag1"]) }
        try await syncBoth()
        XCTAssertEqual(try agentModel(dbB, "ag1"), "opus-4-8")
    }

    func testRoomNumberRemintedLocally() async throws {
        try insertRoom(dbA, "rm1", 7, "Strategy")
        try insertRoom(dbB, "rmX", 1, "Existing")
        try await syncBoth()
        let r = try roomNumberName(dbB, "rm1")
        XCTAssertEqual(r?.1, "Strategy")
        XCTAssertNotEqual(r?.0, 7)
        XCTAssertGreaterThan(r?.0 ?? 0, 0)
    }

    func testDeletePropagates() async throws {
        try insertAgent(dbA, "ag1", "Maya", "@maya")
        try await syncBoth()
        XCTAssertNotNil(try agentName(dbB, "ag1"))
        try await dbA.pool.write { d in try d.execute(sql: "DELETE FROM agents WHERE id = ?", arguments: ["ag1"]) }
        try await syncBoth()
        XCTAssertNil(try agentName(dbB, "ag1"))
    }

    func testNoEchoLoop() async throws {
        try insertAgent(dbA, "ag1", "Maya", "@maya")
        try await syncBoth()
        XCTAssertEqual(try outboxCount(dbB), 0)   // B received by apply, not a local write
        let applied = try await B.pull()
        XCTAssertEqual(applied, 0)
        XCTAssertEqual(try outboxCount(dbB), 0)
    }
}
