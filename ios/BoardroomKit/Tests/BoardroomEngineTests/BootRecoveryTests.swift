import XCTest
import GRDB
import BoardroomStorage
@testable import BoardroomEngine

final class BootRecoveryTests: XCTestCase {
    private func freshDB() throws -> BoardroomDB {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return try BoardroomDB(path: dir.appendingPathComponent("t.sqlite").path)
    }

    func testRecoverStuckClarifyRooms() async throws {
        let db = try freshDB()
        try await db.pool.write { conn in
            try conn.execute(sql: """
                INSERT INTO agents (id,name,handle,instruction,model_v,avatar_path,role_kind,created_at,updated_at)
                VALUES ('chair','C','@c','i','haiku-4-5','/a','moderator',1,1)
                """)
            // Room A: stuck (awaiting_clarify=1, no chair message) → should recover.
            try conn.execute(sql: "INSERT INTO rooms (id,number,name,subject,created_at,awaiting_clarify) VALUES ('A',1,'a','s',1,1)")
            // Room B: awaiting_clarify=1 but the chair DID post → must stay set.
            try conn.execute(sql: "INSERT INTO rooms (id,number,name,subject,created_at,awaiting_clarify) VALUES ('B',2,'b','s',1,1)")
            try conn.execute(sql: """
                INSERT INTO messages (id,room_id,author_kind,author_id,body,round_num,created_at)
                VALUES ('m1','B','agent','chair','hello',1,1)
                """)
        }
        let store = GRDBRoomStore(db: db)
        let recovered = await store.recoverStuckClarifyRooms()
        XCTAssertEqual(recovered, 1)
        try await db.pool.read { conn in
            XCTAssertEqual(try Int.fetchOne(conn, sql: "SELECT awaiting_clarify FROM rooms WHERE id='A'"), 0)
            XCTAssertEqual(try Int.fetchOne(conn, sql: "SELECT awaiting_clarify FROM rooms WHERE id='B'"), 1)
        }
    }

    func testCleanupOrphanedStreams() async throws {
        let db = try freshDB()
        try await db.pool.write { conn in
            try conn.execute(sql: "INSERT INTO rooms (id,number,name,subject,created_at) VALUES ('A',1,'a','s',1)")
            // streaming with body → should be finalized (kept, flipped to false).
            try conn.execute(sql: """
                INSERT INTO messages (id,room_id,author_kind,author_id,body,meta_json,round_num,created_at)
                VALUES ('m1','A','agent','d1','partial text','{"speakerStatus":"streaming","streaming":true}',1,1)
                """)
            // streaming with empty body → should be deleted.
            try conn.execute(sql: """
                INSERT INTO messages (id,room_id,author_kind,author_id,body,meta_json,round_num,created_at)
                VALUES ('m2','A','agent','d2','','{"streaming":true}',1,2)
                """)
            // already final → untouched.
            try conn.execute(sql: """
                INSERT INTO messages (id,room_id,author_kind,author_id,body,meta_json,round_num,created_at)
                VALUES ('m3','A','agent','d3','done','{"streaming":false}',1,3)
                """)
        }
        let store = GRDBRoomStore(db: db)
        let touched = await store.cleanupOrphanedStreams()
        XCTAssertEqual(touched, 2)   // 1 deleted + 1 flipped
        try await db.pool.read { conn in
            XCTAssertNil(try String.fetchOne(conn, sql: "SELECT id FROM messages WHERE id='m2'"))   // deleted
            let m1 = try String.fetchOne(conn, sql: "SELECT meta_json FROM messages WHERE id='m1'") ?? ""
            XCTAssertTrue(m1.contains("\"streaming\":false"))
            XCTAssertFalse(m1.contains("\"streaming\":true"))
            XCTAssertTrue(m1.contains("\"speakerStatus\":\"final\""))
            // total surviving messages = m1 + m3.
            XCTAssertEqual(try Int.fetchOne(conn, sql: "SELECT count(*) FROM messages"), 2)
        }
    }
}
