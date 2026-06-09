import XCTest
import GRDB
@testable import BoardroomStorage

final class AgentSeedTests: XCTestCase {
    private func freshDB() throws -> BoardroomDB {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return try BoardroomDB(path: dir.appendingPathComponent("t.sqlite").path)
    }

    func testCatalogLoadsFromBundle() throws {
        let cat = try XCTUnwrap(AgentSeed.catalog(), "seed.json must be bundled (gen-ios-seed.mjs)")
        XCTAssertEqual(cat.chair.id, "chair")
        XCTAssertEqual(cat.chair.roleKind, "moderator")
        XCTAssertEqual(cat.directors.count, 7)
        XCTAssertTrue(cat.directors.contains { $0.id == "socrates" })
        XCTAssertFalse(cat.chair.instruction.isEmpty)
    }

    func testSeedInsertsChairPlusDirectors() throws {
        let db = try freshDB()
        let n = try AgentSeed.seed(into: db)
        XCTAssertEqual(n, 8)   // 1 chair + 7 directors
        try db.pool.read { conn in
            XCTAssertEqual(try Int.fetchOne(conn, sql: "SELECT count(*) FROM agents WHERE role_kind='moderator'"), 1)
            XCTAssertEqual(try Int.fetchOne(conn, sql: "SELECT count(*) FROM agents WHERE role_kind='director'"), 7)
            // Real instruction persisted (not a stub).
            let chairInstr = try String.fetchOne(conn, sql: "SELECT instruction FROM agents WHERE id='chair'") ?? ""
            XCTAssertTrue(chairInstr.contains("Meeting Host"))
            // avatar3d persisted (so the 3D stage can render seats).
            let chairAvatar = try String.fetchOne(conn, sql: "SELECT avatar3d_json FROM agents WHERE id='chair'")
            XCTAssertNotNil(chairAvatar)
            XCTAssertTrue(chairAvatar?.contains("\"model\"") ?? false)
            let withAvatar = try Int.fetchOne(conn, sql: "SELECT count(*) FROM agents WHERE avatar3d_json IS NOT NULL") ?? 0
            XCTAssertEqual(withAvatar, 8)   // chair + 7 directors
        }
    }

    func testSeedIsIdempotent() throws {
        let db = try freshDB()
        _ = try AgentSeed.seed(into: db)
        let second = try AgentSeed.seed(into: db)
        XCTAssertEqual(second, 0)   // nothing re-inserted
        let total = try db.pool.read { try Int.fetchOne($0, sql: "SELECT count(*) FROM agents") }
        XCTAssertEqual(total, 8)
    }

    func testChairReinsertedIfDeleted() throws {
        let db = try freshDB()
        _ = try AgentSeed.seed(into: db)
        try db.pool.write { try $0.execute(sql: "DELETE FROM agents WHERE id='chair'") }
        let n = try AgentSeed.seed(into: db)   // chair ensured; directors already present → not re-seeded
        XCTAssertEqual(n, 1)
        let hasChair = try db.pool.read { try Bool.fetchOne($0, sql: "SELECT count(*)>0 FROM agents WHERE id='chair'") }
        XCTAssertEqual(hasChair, true)
    }
}
