import XCTest
import GRDB
import BoardroomAI
import BoardroomCore
import BoardroomStorage
@testable import BoardroomEngine

/// L1/L2 summary store round-trip (real GRDB) + the summarizer's pure helpers.
final class SummarizeTests: XCTestCase {
    private func freshDB() throws -> BoardroomDB {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return try BoardroomDB(path: dir.appendingPathComponent("t.sqlite").path)
    }
    private func seedRoom(_ db: BoardroomDB) throws {
        try db.pool.write { conn in
            try conn.execute(sql: "INSERT INTO rooms (id, number, name, subject, mode, intensity, delivery_mode, status, created_at) VALUES ('r',1,'n','s','constructive','sharp','text','live',0)")
        }
    }

    func testL1L2StoreRoundTrip() async throws {
        let db = try freshDB(); try seedRoom(db)
        let store = GRDBRoomStore(db: db)
        // L1 upsert + get + list
        await store.upsertL1Summary(roomId: "r", roundNum: 1, body: "round one", modelV: "haiku-4-5", sourceHash: "h1")
        await store.upsertL1Summary(roomId: "r", roundNum: 2, body: "round two", modelV: "haiku-4-5", sourceHash: "h2")
        let got = await store.getL1Summary(roomId: "r", roundNum: 1)
        XCTAssertEqual(got, "round one")
        // upsert replaces (unique on room/level/round)
        await store.upsertL1Summary(roomId: "r", roundNum: 1, body: "round one v2", modelV: "haiku-4-5", sourceHash: "h1b")
        let v2 = await store.getL1Summary(roomId: "r", roundNum: 1)
        XCTAssertEqual(v2, "round one v2")
        let list = await store.listL1Summaries(roomId: "r")
        XCTAssertEqual(list.map(\.roundNum), [1, 2])
        // delete
        await store.deleteL1Summary(roomId: "r", roundNum: 1)
        let afterDelete = await store.getL1Summary(roomId: "r", roundNum: 1)
        XCTAssertNil(afterDelete)
        // L2 single-row replace
        await store.upsertL2Summary(roomId: "r", startRound: 1, endRound: 5, body: "narr", modelV: "haiku-4-5", sourceHash: "x")
        await store.upsertL2Summary(roomId: "r", startRound: 1, endRound: 9, body: "narr2", modelV: "haiku-4-5", sourceHash: "y")
        let l2 = await store.getL2Summary(roomId: "r")
        XCTAssertEqual(l2?.endRound, 9)
        XCTAssertEqual(l2?.body, "narr2")
    }

    func testHashOfDeterministic() {
        XCTAssertEqual(Summarize.hashOf("abc"), Summarize.hashOf("abc"))
        XCTAssertNotEqual(Summarize.hashOf("abc"), Summarize.hashOf("abd"))
    }

    func testRenderTranscriptSkipsMarkers() {
        let cast = [DirectorRef(id: "d1", name: "Hypatia", modelV: .haiku_4_5)]
        let msgs = [
            EngineMessage(id: "1", roomId: "r", authorKind: "user", authorId: nil, body: "hi", roundNum: 1, streaming: false),
            EngineMessage(id: "2", roomId: "r", authorKind: "agent", authorId: "d1", body: "point", roundNum: 1, streaming: false),
            EngineMessage(id: "3", roomId: "r", authorKind: "agent", authorId: "c", body: "marker", roundNum: 1, streaming: false, kind: "round-open"),
            EngineMessage(id: "4", roomId: "r", authorKind: "system", authorId: nil, body: "sys", roundNum: 1, streaming: false),
        ]
        let t = Summarize.renderTranscript(msgs, cast: cast, chair: nil, userName: "You")
        XCTAssertEqual(t, "You: hi\n\nHypatia: point")   // marker + system dropped
    }
}
