import Foundation
import GRDB
import BoardroomCore

/// Long-term USER memory sanctuary (`user-long-memory.ts`). Tag-shaped
/// abstractions about the user ("founder", "anti-jargon", "long-horizon-bias")
/// live here and only get displaced on direct contradiction — the per-agent
/// dream metabolism never touches them. Written by the dream cycle's chair-only
/// Step 6 harvest (P4-7c); read on every chair prompt build + the chair-profile
/// UI. Single user per install → no user_id; single conceptual owner (the
/// chair-relationship) → no agent_id.
public struct UserLongRow: Sendable, Equatable {
    public let id: String
    public let label: String
    public let claim: String
    public let confidence: Double
    public let provenanceRooms: Int
    public init(id: String, label: String, claim: String, confidence: Double, provenanceRooms: Int) {
        self.id = id; self.label = label; self.claim = claim
        self.confidence = confidence; self.provenanceRooms = provenanceRooms
    }
}

public protocol UserLongMemoryStore: Sendable {
    /// Active (non-superseded) rows · most-reinforced first.
    func listActiveUserLong() async -> [UserLongRow]
    func getUserLong(_ id: String) async -> UserLongRow?
    func countActiveUserLong() async -> Int
    /// Insert a new tag · returns its id, or nil if label/claim were empty.
    func insertUserLong(label: String, claim: String, confidence: Double, provenanceRooms: Int) async -> String?
    /// Bump provenance + stamp last_reinforced_at (existing tag re-confirmed).
    func bumpUserLongProvenance(_ id: String) async
    /// Mark an old tag superseded by a newer one (direct contradiction only).
    func markUserLongSuperseded(oldId: String, newId: String) async
    /// Cap-N safety prune · drop the lowest-scoring active rows. Returns count dropped.
    func pruneActiveUserLongToCap(_ cap: Int) async -> Int
}

/// Dream-cycle audit + boot-sweep enumeration (`recordDream` / boot sweep in
/// `boot.ts`). Stub stores don't conform → graceful no-op (BriefStore pattern).
public struct DreamSweepAgent: Sendable, Equatable {
    public let id: String
    public let isChair: Bool
    public init(id: String, isChair: Bool) { self.id = id; self.isChair = isChair }
}

public protocol DreamAuditStore: Sendable {
    func recordDream(agentId: String, startedAt: Int, finishedAt: Int, beforeCount: Int, afterCount: Int,
                     decayed: Int, merged: Int, promoted: Int, superseded: Int, notes: String?) async
    /// All agents (id + isChair) for the boot-time over-ceiling sweep.
    func agentsForSweep() async -> [DreamSweepAgent]
    /// User display name from prefs (mirrors `getPrefs().name`), "the user" fallback.
    func userDisplayName() async -> String
}

extension GRDBRoomStore: UserLongMemoryStore {
    private static let ulCols = "id, label, claim, confidence, provenance_rooms"
    private func ulNow() -> Int { Int(Date().timeIntervalSince1970 * 1000) }
    private static let ulLabelMax = 32
    private static let ulClaimMax = 240

    public func listActiveUserLong() async -> [UserLongRow] {
        (try? await db.pool.read { conn in
            try Row.fetchAll(conn, sql: """
                SELECT \(Self.ulCols) FROM user_long_memory
                WHERE superseded_by IS NULL
                ORDER BY provenance_rooms DESC, last_reinforced_at DESC, created_at DESC
                """).map(Self.mapUL)
        }) ?? []
    }

    public func getUserLong(_ id: String) async -> UserLongRow? {
        (try? await db.pool.read { conn in
            try Row.fetchOne(conn, sql: "SELECT \(Self.ulCols) FROM user_long_memory WHERE id = ?", arguments: [id]).map(Self.mapUL)
        }) ?? nil
    }

    public func countActiveUserLong() async -> Int {
        (try? await db.pool.read { conn in
            try Int.fetchOne(conn, sql: "SELECT COUNT(*) FROM user_long_memory WHERE superseded_by IS NULL")
        }) ?? 0
    }

    public func insertUserLong(label: String, claim: String, confidence: Double, provenanceRooms: Int) async -> String? {
        let l = String(label.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.ulLabelMax))
        let c = String(claim.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.ulClaimMax))
        guard !l.isEmpty, !c.isEmpty else { return nil }
        let conf = max(0, min(1, confidence.isFinite ? confidence : 0.7))
        let prov = max(1, provenanceRooms)
        let id = UUID().uuidString
        let now = ulNow()
        do {
            try await db.pool.write { conn in
                try conn.execute(sql: """
                    INSERT INTO user_long_memory
                    (id, label, claim, confidence, provenance_rooms, last_reinforced_at, superseded_by, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
                    """, arguments: [id, l, c, conf, prov, now, now])
            }
            return id
        } catch { return nil }
    }

    public func bumpUserLongProvenance(_ id: String) async {
        let now = ulNow()
        try? await db.pool.write { conn in
            try conn.execute(sql: """
                UPDATE user_long_memory
                SET provenance_rooms = provenance_rooms + 1, last_reinforced_at = ?, updated_at = ?
                WHERE id = ?
                """, arguments: [now, now, id])
        }
    }

    public func markUserLongSuperseded(oldId: String, newId: String) async {
        try? await db.pool.write { conn in
            try conn.execute(sql: "UPDATE user_long_memory SET superseded_by = ?, updated_at = ? WHERE id = ?",
                             arguments: [newId, self.ulNow(), oldId])
        }
    }

    public func pruneActiveUserLongToCap(_ cap: Int) async -> Int {
        (try? await db.pool.write { conn -> Int in
            let rows = try Row.fetchAll(conn, sql: """
                SELECT id FROM user_long_memory WHERE superseded_by IS NULL
                ORDER BY (confidence + (provenance_rooms / 10.0)) ASC, last_reinforced_at ASC, created_at ASC
                """)
            let over = rows.count - cap
            guard over > 0 else { return 0 }
            for r in rows.prefix(over) {
                let id: String = r["id"] ?? ""
                try conn.execute(sql: "DELETE FROM user_long_memory WHERE id = ?", arguments: [id])
            }
            return over
        }) ?? 0
    }

    private static func mapUL(_ r: Row) -> UserLongRow {
        UserLongRow(id: r["id"] ?? "", label: r["label"] ?? "", claim: r["claim"] ?? "",
                    confidence: r["confidence"] ?? 0.7, provenanceRooms: r["provenance_rooms"] ?? 1)
    }
}

extension GRDBRoomStore: DreamAuditStore {
    public func recordDream(agentId: String, startedAt: Int, finishedAt: Int, beforeCount: Int, afterCount: Int,
                            decayed: Int, merged: Int, promoted: Int, superseded: Int, notes: String?) async {
        let id = UUID().uuidString
        try? await db.pool.write { conn in
            try conn.execute(sql: """
                INSERT INTO agent_dreams
                (id, agent_id, started_at, finished_at, before_count, after_count, decayed, merged, promoted, superseded, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, arguments: [id, agentId, startedAt, finishedAt, beforeCount, afterCount,
                                 decayed, merged, promoted, superseded, notes])
        }
    }

    public func agentsForSweep() async -> [DreamSweepAgent] {
        (try? await db.pool.read { conn in
            try Row.fetchAll(conn, sql: "SELECT id, role_kind FROM agents").map {
                DreamSweepAgent(id: $0["id"] ?? "", isChair: ($0["role_kind"] ?? "") == "moderator")
            }
        }) ?? []
    }

    public func userDisplayName() async -> String {
        let name = (try? await db.pool.read { conn in
            try String.fetchOne(conn, sql: "SELECT name FROM prefs WHERE id = 1")
        }) ?? nil
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "the user" : trimmed
    }
}
