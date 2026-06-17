import Foundation
import GRDB
import BoardroomCore

/// Per-agent long-term memory seam (`agent_memories`). Each director accumulates
/// private notes about the user across rooms; injected into their prompt next
/// time. Separate from `RoomStore` (BriefStore pattern); `RoomActor` uses it via
/// `store as? MemoryStore`.
public protocol MemoryStore: Sendable {
    func insertMemory(agentId: String, content: String, kind: String, sourceRoom: String?, confidence: Double) async
    /// Context selection (port of `memoriesForContext`) · ALL pinned + ALL
    /// long-tier + the 5 most-recent short-tier non-pinned, in that order.
    func memoriesForContext(agentId: String) async -> [MemoryItem]
    func bumpUsage(_ ids: [String]) async
    /// Heuristic decay (no LLM) · cull stale, low-confidence, unused short-tier
    /// notes so the store doesn't grow unbounded across rooms. Returns rows culled.
    @discardableResult
    func decayShortTermMemories(agentId: String) async -> Int

    // MARK: Dream metabolism (P4-7b) · the LLM consolidation seam.
    /// Non-superseded memories of a tier ("short"|"long"), newest first, with the
    /// fields the dream prompts + promote heuristic need.
    func listTier(agentId: String, tier: String) async -> [MemoryRow]
    /// Insert a merged memory · conf/provenance/tier/createdAt derived from sources.
    func insertConsolidatedMemory(agentId: String, content: String, kind: String,
                                  confidence: Double, provenanceRooms: Int, tier: String,
                                  createdAt: Int, consolidatedFrom: [String]) async -> String
    /// Mark `ids` superseded by `supersedingId` (skips pinned + the superseder).
    /// Returns the number of rows actually changed.
    @discardableResult
    func markSuperseded(_ ids: [String], by supersedingId: String) async -> Int
    /// Promote short→long for ids that still qualify; returns rows changed.
    func promoteToLong(_ ids: [String]) async -> Int
    /// Count non-superseded memories (drives the boot-sweep ceiling).
    func countMemoriesForAgent(_ agentId: String) async -> Int
}

public struct MemoryRow: Sendable, Equatable {
    public let id: String
    public let content: String
    public let kind: String
    public let tier: String
    public let confidence: Double
    public let createdAt: Int
    public let provenanceRooms: Int
    public let pinned: Bool
}

public struct MemoryItem: Sendable, Equatable {
    public let id: String
    public let content: String
    public let kind: String
    public let tier: String      // "short" | "long"
    public let pinned: Bool
}

extension GRDBRoomStore: MemoryStore {
    private func memNow() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

    public func insertMemory(agentId: String, content: String, kind: String, sourceRoom: String?, confidence: Double) async {
        let now = memNow()
        try? await db.pool.write { conn in
            // tier / usage_count / provenance_rooms fall to their column defaults
            // (short / 0 / 1) — the desktop insert relies on the same defaults.
            try conn.execute(sql: """
                INSERT INTO agent_memories (id, agent_id, content, kind, source, source_room, confidence, pinned, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'extracted', ?, ?, 0, ?, ?)
                """, arguments: [UUID().uuidString, agentId, content, kind, sourceRoom, confidence, now, now])
        }
    }

    public func memoriesForContext(agentId: String) async -> [MemoryItem] {
        let all: [MemoryItem] = (try? await db.pool.read { conn in
            try Row.fetchAll(conn, sql: """
                SELECT id, content, kind, COALESCE(tier,'short') AS tier, pinned
                FROM agent_memories WHERE agent_id = ? AND superseded_by IS NULL
                ORDER BY created_at DESC
                """, arguments: [agentId]).map {
                MemoryItem(id: $0["id"] ?? "", content: $0["content"] ?? "", kind: $0["kind"] ?? "fact",
                           tier: $0["tier"] ?? "short", pinned: ($0["pinned"] as Int? ?? 0) == 1)
            }
        }) ?? []
        let pinned = all.filter { $0.pinned }
        let longTier = all.filter { !$0.pinned && $0.tier == "long" }
        let shortTier = all.filter { !$0.pinned && $0.tier == "short" }.prefix(5)
        return pinned + longTier + Array(shortTier)
    }

    public func bumpUsage(_ ids: [String]) async {
        guard !ids.isEmpty else { return }
        let now = memNow()
        try? await db.pool.write { conn in
            for id in ids {
                try conn.execute(sql: "UPDATE agent_memories SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?",
                                 arguments: [now, id])
            }
        }
    }

    @discardableResult
    public func decayShortTermMemories(agentId: String) async -> Int {
        let cutoff = memNow() - 30 * 24 * 60 * 60 * 1000   // 30 days
        return (try? await db.pool.write { conn -> Int in
            try conn.execute(sql: """
                DELETE FROM agent_memories
                WHERE agent_id = ? AND tier = 'short' AND pinned = 0
                  AND created_at < ? AND confidence < 0.5 AND usage_count <= 0
                """, arguments: [agentId, cutoff])
            return conn.changesCount
        }) ?? 0
    }

    public func listTier(agentId: String, tier: String) async -> [MemoryRow] {
        (try? await db.pool.read { conn in
            try Row.fetchAll(conn, sql: """
                SELECT id, content, kind, COALESCE(tier,'short') AS tier, confidence, created_at,
                       COALESCE(provenance_rooms,1) AS prov, pinned
                FROM agent_memories
                WHERE agent_id = ? AND COALESCE(tier,'short') = ? AND superseded_by IS NULL
                ORDER BY created_at DESC
                """, arguments: [agentId, tier]).map {
                MemoryRow(id: $0["id"] ?? "", content: $0["content"] ?? "", kind: $0["kind"] ?? "fact",
                          tier: $0["tier"] ?? "short", confidence: $0["confidence"] ?? 0.7,
                          createdAt: $0["created_at"] ?? 0, provenanceRooms: $0["prov"] ?? 1,
                          pinned: ($0["pinned"] as Int? ?? 0) == 1)
            }
        }) ?? []
    }

    public func insertConsolidatedMemory(agentId: String, content: String, kind: String,
                                         confidence: Double, provenanceRooms: Int, tier: String,
                                         createdAt: Int, consolidatedFrom: [String]) async -> String {
        let id = UUID().uuidString
        let now = memNow()
        let cf = (try? JSONSerialization.data(withJSONObject: consolidatedFrom)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        try? await db.pool.write { conn in
            try conn.execute(sql: """
                INSERT INTO agent_memories (id, agent_id, content, kind, source, source_room, confidence, pinned,
                                            created_at, updated_at, tier, provenance_rooms, consolidated_from)
                VALUES (?, ?, ?, ?, 'extracted', NULL, ?, 0, ?, ?, ?, ?, ?)
                """, arguments: [id, agentId, content, kind, confidence, createdAt, now, tier, provenanceRooms, cf])
        }
        return id
    }

    @discardableResult
    public func markSuperseded(_ ids: [String], by supersedingId: String) async -> Int {
        guard !ids.isEmpty else { return 0 }
        return (try? await db.pool.write { conn -> Int in
            var changed = 0
            for id in ids where id != supersedingId {
                try conn.execute(sql: "UPDATE agent_memories SET superseded_by = ?, updated_at = ? WHERE id = ? AND pinned = 0",
                                 arguments: [supersedingId, self.memNow(), id])
                changed += conn.changesCount
            }
            return changed
        }) ?? 0
    }

    public func promoteToLong(_ ids: [String]) async -> Int {
        guard !ids.isEmpty else { return 0 }
        return (try? await db.pool.write { conn -> Int in
            var changed = 0
            for id in ids {
                try conn.execute(sql: "UPDATE agent_memories SET tier = 'long', updated_at = ? WHERE id = ? AND tier = 'short' AND superseded_by IS NULL",
                                 arguments: [memNow(), id])
                changed += conn.changesCount
            }
            return changed
        }) ?? 0
    }

    public func countMemoriesForAgent(_ agentId: String) async -> Int {
        (try? await db.pool.read { conn in
            try Int.fetchOne(conn, sql: "SELECT COUNT(*) FROM agent_memories WHERE agent_id = ? AND superseded_by IS NULL", arguments: [agentId])
        }) ?? 0 ?? 0
    }
}
