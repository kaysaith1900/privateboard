import Foundation
import GRDB
import BoardroomCore

/// Persistence seam for the Layer-2 divergence subsystems (topic tree /
/// negative-space / QD archive). Separate from `RoomStore` so the core loop +
/// test stubs don't carry it; `RoomActor` uses it via `store as? FrameBreakStore`
/// (the `BriefStore` pattern) — when absent the enrichment cleanly no-ops.
public protocol FrameBreakStore: Sendable {
    // Topic tree (Layer 3.1)
    func listBranches(_ roomId: String) async -> [TopicBranch]
    func createBranch(roomId: String, label: String, openerSpeakerId: String?) async -> String
    func tagMessageWithBranch(messageId: String, branchId: String, isOpener: Bool, speakerId: String?) async
    func dominantBranches(_ roomId: String, limit: Int) async -> [TopicBranch]
    func speakersOnBranches(_ roomId: String, branchIds: [String]) async -> Set<String>
    // Negative space (Layer 3.2)
    func insertNegativeSpaceAngles(_ roomId: String, roundNum: Int, angles: [String]) async
    func recentUnexploredAngles(_ roomId: String, limit: Int) async -> [(id: String, angle: String)]
    func markAnglesConsumed(_ ids: [String]) async
    // QD archive (Layer · question-dimension coverage)
    func upsertQDScore(messageId: String, roomId: String, abstraction: Double, time: Double, stakeholder: Double) async
}

public struct TopicBranch: Sendable, Equatable {
    public let id: String
    public let label: String
    public let turnCount: Int
    public let lastSpeakerId: String?
}

extension GRDBRoomStore: FrameBreakStore {
    private func newId() -> String { UUID().uuidString }
    private func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

    public func listBranches(_ roomId: String) async -> [TopicBranch] {
        (try? await db.pool.read { conn in
            try Row.fetchAll(conn, sql:
                "SELECT id, label, turn_count, last_speaker_id FROM topic_branches WHERE room_id = ? ORDER BY opened_at ASC",
                arguments: [roomId]).map(Self.branch)
        }) ?? []
    }

    public func createBranch(roomId: String, label: String, openerSpeakerId: String?) async -> String {
        let id = newId()
        let clipped = String(label.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        let now = nowMs()
        try? await db.pool.write { conn in
            // turn_count seeded to 1 at creation (the opener counts here).
            try conn.execute(sql:
                "INSERT INTO topic_branches (id, room_id, label, parent_id, opened_at, turn_count, last_speaker_id) VALUES (?,?,?,NULL,?,1,?)",
                arguments: [id, roomId, clipped, now, openerSpeakerId])
        }
        return id
    }

    public func tagMessageWithBranch(messageId: String, branchId: String, isOpener: Bool, speakerId: String?) async {
        let now = nowMs()
        try? await db.pool.write { conn in
            try conn.execute(sql:
                "INSERT OR REPLACE INTO message_branches (message_id, branch_id, is_opener, tagged_at) VALUES (?,?,?,?)",
                arguments: [messageId, branchId, isOpener ? 1 : 0, now])
            if !isOpener {
                try conn.execute(sql:
                    "UPDATE topic_branches SET turn_count = turn_count + 1, last_speaker_id = COALESCE(?, last_speaker_id) WHERE id = ?",
                    arguments: [speakerId, branchId])
            } else if let speakerId {
                try conn.execute(sql: "UPDATE topic_branches SET last_speaker_id = ? WHERE id = ?",
                                 arguments: [speakerId, branchId])
            }
        }
    }

    public func dominantBranches(_ roomId: String, limit: Int) async -> [TopicBranch] {
        (try? await db.pool.read { conn in
            try Row.fetchAll(conn, sql:
                "SELECT id, label, turn_count, last_speaker_id FROM topic_branches WHERE room_id = ? ORDER BY turn_count DESC, opened_at DESC LIMIT ?",
                arguments: [roomId, max(1, limit)]).map(Self.branch)
        }) ?? []
    }

    public func speakersOnBranches(_ roomId: String, branchIds: [String]) async -> Set<String> {
        guard !branchIds.isEmpty else { return [] }
        let placeholders = branchIds.map { _ in "?" }.joined(separator: ",")
        let rows: [String] = (try? await db.pool.read { conn in
            try String.fetchAll(conn, sql: """
                SELECT DISTINCT m.author_id FROM messages m
                JOIN message_branches mb ON mb.message_id = m.id
                WHERE m.room_id = ? AND mb.branch_id IN (\(placeholders))
                  AND m.author_kind = 'agent' AND m.author_id IS NOT NULL
                """, arguments: StatementArguments([roomId] + branchIds))
        }) ?? []
        return Set(rows)
    }

    public func insertNegativeSpaceAngles(_ roomId: String, roundNum: Int, angles: [String]) async {
        let now = nowMs()
        try? await db.pool.write { conn in
            for a in angles {
                let t = a.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !t.isEmpty, t.count < 280 else { continue }
                try conn.execute(sql:
                    "INSERT INTO negative_space (id, room_id, round_num, angle, created_at, consumed) VALUES (?,?,?,?,?,0)",
                    arguments: [UUID().uuidString, roomId, roundNum, t, now])
            }
        }
    }

    public func recentUnexploredAngles(_ roomId: String, limit: Int) async -> [(id: String, angle: String)] {
        (try? await db.pool.read { conn in
            try Row.fetchAll(conn, sql:
                "SELECT id, angle FROM negative_space WHERE room_id = ? AND consumed = 0 ORDER BY created_at DESC LIMIT ?",
                arguments: [roomId, max(1, limit)]).map { (id: $0["id"] as String? ?? "", angle: $0["angle"] as String? ?? "") }
        }) ?? []
    }

    public func markAnglesConsumed(_ ids: [String]) async {
        guard !ids.isEmpty else { return }
        try? await db.pool.write { conn in
            for id in ids { try conn.execute(sql: "UPDATE negative_space SET consumed = 1 WHERE id = ?", arguments: [id]) }
        }
    }

    public func upsertQDScore(messageId: String, roomId: String, abstraction: Double, time: Double, stakeholder: Double) async {
        let now = nowMs()
        let (ab, tb, sb) = (Self.qdBucket(abstraction), Self.qdBucket(time), Self.qdBucket(stakeholder))
        try? await db.pool.write { conn in
            try conn.execute(sql: """
                INSERT OR REPLACE INTO qd_archive
                (message_id, room_id, abstraction_score, abstraction_bucket, time_score, time_bucket, stakeholder_score, stakeholder_bucket, scored_at)
                VALUES (?,?,?,?,?,?,?,?,?)
                """, arguments: [messageId, roomId, abstraction, ab, time, tb, stakeholder, sb, now])
        }
    }

    /// 4-bucket quantizer · floor(clamp(s)·4), with the right-edge clamp so 1.0
    /// lands in bucket 3 (not a non-existent 5th).
    private static func qdBucket(_ s: Double) -> Int {
        let b = Int((max(0, min(1, s)) * 4).rounded(.down)); return b == 4 ? 3 : b
    }

    private static func branch(_ r: Row) -> TopicBranch {
        TopicBranch(id: r["id"] ?? "", label: r["label"] ?? "",
                    turnCount: r["turn_count"] ?? 0, lastSpeakerId: r["last_speaker_id"])
    }
}
