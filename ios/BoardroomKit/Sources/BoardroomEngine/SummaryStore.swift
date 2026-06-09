import Foundation
import GRDB
import BoardroomCore

/// Persistence seam for the L1/L2 round summaries (`room_summaries`) + a key-point
/// read the summarizer needs. Separate from `RoomStore` (the BriefStore pattern);
/// `RoomActor` uses it via `store as? SummaryStore` — absent → summaries no-op.
public protocol SummaryStore: Sendable {
    func upsertL1Summary(roomId: String, roundNum: Int, body: String, modelV: String, sourceHash: String) async
    func getL1Summary(roomId: String, roundNum: Int) async -> String?
    func listL1Summaries(roomId: String) async -> [(roundNum: Int, body: String)]
    func deleteL1Summary(roomId: String, roundNum: Int) async
    func upsertL2Summary(roomId: String, startRound: Int, endRound: Int, body: String, modelV: String, sourceHash: String) async
    func getL2Summary(roomId: String) async -> (startRound: Int, endRound: Int, body: String)?
    func keyPointBodiesForRound(roomId: String, roundNum: Int) async -> [String]
}

extension GRDBRoomStore: SummaryStore {
    private func summaryNow() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

    public func upsertL1Summary(roomId: String, roundNum: Int, body: String, modelV: String, sourceHash: String) async {
        let now = summaryNow()
        try? await db.pool.write { conn in
            try conn.execute(sql: "DELETE FROM room_summaries WHERE room_id = ? AND level = 1 AND round_num = ?",
                             arguments: [roomId, roundNum])
            try conn.execute(sql: """
                INSERT INTO room_summaries (room_id, level, round_num, start_round, end_round, body, model_v, source_hash, created_at)
                VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
                """, arguments: [roomId, roundNum, roundNum, roundNum, body, modelV, sourceHash, now])
        }
    }

    public func getL1Summary(roomId: String, roundNum: Int) async -> String? {
        (try? await db.pool.read { conn in
            try String.fetchOne(conn, sql: "SELECT body FROM room_summaries WHERE room_id = ? AND level = 1 AND round_num = ?",
                                arguments: [roomId, roundNum])
        }) ?? nil
    }

    public func listL1Summaries(roomId: String) async -> [(roundNum: Int, body: String)] {
        (try? await db.pool.read { conn in
            try Row.fetchAll(conn, sql: "SELECT round_num, body FROM room_summaries WHERE room_id = ? AND level = 1 ORDER BY round_num ASC",
                             arguments: [roomId]).map { (roundNum: $0["round_num"] as Int? ?? 0, body: $0["body"] as String? ?? "") }
        }) ?? []
    }

    public func deleteL1Summary(roomId: String, roundNum: Int) async {
        try? await db.pool.write { conn in
            try conn.execute(sql: "DELETE FROM room_summaries WHERE room_id = ? AND level = 1 AND round_num = ?",
                             arguments: [roomId, roundNum])
        }
    }

    public func upsertL2Summary(roomId: String, startRound: Int, endRound: Int, body: String, modelV: String, sourceHash: String) async {
        let now = summaryNow()
        try? await db.pool.write { conn in
            try conn.execute(sql: "DELETE FROM room_summaries WHERE room_id = ? AND level = 2", arguments: [roomId])
            try conn.execute(sql: """
                INSERT INTO room_summaries (room_id, level, round_num, start_round, end_round, body, model_v, source_hash, created_at)
                VALUES (?, 2, NULL, ?, ?, ?, ?, ?, ?)
                """, arguments: [roomId, startRound, endRound, body, modelV, sourceHash, now])
        }
    }

    public func getL2Summary(roomId: String) async -> (startRound: Int, endRound: Int, body: String)? {
        (try? await db.pool.read { conn in
            try Row.fetchOne(conn, sql: "SELECT start_round, end_round, body FROM room_summaries WHERE room_id = ? AND level = 2",
                             arguments: [roomId]).map {
                (startRound: $0["start_round"] as Int? ?? 0, endRound: $0["end_round"] as Int? ?? 0, body: $0["body"] as String? ?? "")
            }
        }) ?? nil
    }

    public func keyPointBodiesForRound(roomId: String, roundNum: Int) async -> [String] {
        (try? await db.pool.read { conn in
            try String.fetchAll(conn, sql: "SELECT body FROM key_points WHERE room_id = ? AND round_num = ? ORDER BY position ASC",
                                arguments: [roomId, roundNum])
        }) ?? []
    }
}
