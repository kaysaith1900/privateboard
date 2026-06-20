import Foundation
import GRDB
import BoardroomCore
import BoardroomAI
import BoardroomStorage

/// GRDB-backed `RoomStore` — bridges the engine's persistence seam to the real
/// on-device schema (`BoardroomDB`). Column names match the ported migrations
/// (001_init + 005 key_points/awaiting_continue + 006 awaiting_clarify + 033
/// room_members.removed_at). The streaming flag + chair `kind` live in
/// `messages.meta_json` (same JSON-blob convention as the desktop).
public struct GRDBRoomStore: RoomStore, BriefStore {
    let db: BoardroomDB
    public init(db: BoardroomDB) { self.db = db }

    private func now() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

    private static let agentCols = "a.id AS id, a.name AS name, a.model_v AS model_v, a.handle AS handle, a.role_tag AS role_tag, a.instruction AS instruction, a.bio AS bio, a.ability_json AS ability_json, a.persona_spec_json AS persona_spec_json, a.user_rules_json AS user_rules_json, a.web_search_enabled AS web_search_enabled"

    /// All seeded directors as DirectorRefs (the auto-pick catalog) · mirrors the
    /// desktop `listAgents` filtered to directors, ordered by creation.
    public func directorCatalog() async -> [DirectorRef] {
        (try? await db.pool.read { conn in
            try Row.fetchAll(conn, sql:
                "SELECT \(Self.agentCols.replacingOccurrences(of: "a.", with: "")) FROM agents WHERE role_kind = 'director' ORDER BY created_at")
                .map(Self.director)
        }) ?? []
    }

    public func directors(_ roomId: String) async -> [DirectorRef] {
        (try? await db.pool.read { conn in
            try Row.fetchAll(conn, sql: """
                SELECT \(Self.agentCols)
                FROM room_members m JOIN agents a ON a.id = m.agent_id
                WHERE m.room_id = ? AND m.removed_at IS NULL AND a.role_kind = 'director'
                ORDER BY m.position
                """, arguments: [roomId]).map(Self.director)
        }) ?? []
    }

    public func chair(_ roomId: String) async -> DirectorRef? {
        try? await db.pool.read { conn in
            try Row.fetchOne(conn, sql:
                "SELECT \(Self.agentCols.replacingOccurrences(of: "a.", with: "")) FROM agents WHERE role_kind = 'moderator' LIMIT 1")
                .map(Self.director)
        } ?? nil
    }

    public func roomMeta(_ roomId: String) async -> RoomMeta? {
        try? await db.pool.read { conn in
            guard let row = try Row.fetchOne(conn, sql:
                "SELECT subject, mode, intensity, delivery_mode, parent_room_id, vote_trigger FROM rooms WHERE id = ?", arguments: [roomId])
            else { return nil }
            let userName = (try? String.fetchOne(conn, sql: "SELECT name FROM prefs WHERE id = 1")) ?? nil
            return RoomMeta(
                subject: row["subject"] ?? "",
                mode: row["mode"] ?? "constructive",
                intensity: row["intensity"] ?? "sharp",
                userName: (userName?.isEmpty == false ? userName! : "You"),
                deliveryVoice: (row["delivery_mode"] as String?) == "voice",
                parentRoomId: row["parent_room_id"],
                voteTrigger: (row["vote_trigger"] as String?) ?? "auto")
        } ?? nil
    }

    public func priorContext(parentRoomId: String) async -> PriorContextData? {
        try? await db.pool.read { conn -> PriorContextData? in
            guard let room = try Row.fetchOne(conn, sql:
                "SELECT number, subject FROM rooms WHERE id = ?", arguments: [parentRoomId])
            else { return nil }
            // Latest filed brief of the parent room (the "settled judgement").
            let brief = try Row.fetchOne(conn, sql:
                "SELECT title, body_md FROM briefs WHERE room_id = ? ORDER BY created_at DESC LIMIT 1",
                arguments: [parentRoomId])
            return PriorContextData(
                parentNumber: room["number"] ?? 0,
                parentSubject: room["subject"] ?? "",
                briefTitle: brief?["title"],
                briefBodyMd: brief?["body_md"])
        } ?? nil
    }

    public func roomState(_ roomId: String) async -> RoomState? {
        try? await db.pool.read { conn -> RoomState? in
            guard let row = try Row.fetchOne(conn, sql:
                "SELECT status, awaiting_clarify, awaiting_continue FROM rooms WHERE id = ?", arguments: [roomId])
            else { return nil }
            let maxRound = try Int.fetchOne(conn, sql:
                "SELECT COALESCE(MAX(round_num), 0) FROM messages WHERE room_id = ?", arguments: [roomId]) ?? 0
            let statusRaw: String = row["status"] ?? "live"
            return RoomState(
                status: RoomStatus(rawValue: statusRaw) ?? .live,
                awaitingClarify: (row["awaiting_clarify"] as Int? ?? 0) == 1,
                awaitingContinue: (row["awaiting_continue"] as Int? ?? 0) == 1,
                maxRound: maxRound)
        } ?? nil
    }

    public func nextRoundNum(_ roomId: String) async -> Int {
        (try? await db.pool.read { conn in
            (try Int.fetchOne(conn, sql:
                "SELECT COALESCE(MAX(round_num), 0) FROM messages WHERE room_id = ?",
                arguments: [roomId]) ?? 0) + 1
        }) ?? 1
    }

    public func insertMessage(_ m: EngineMessage) async {
        let meta = Self.metaJSON(streaming: m.streaming, kind: m.kind, tool: m.tool,
                                 toolStatus: m.toolStatus, searchQuery: m.searchQuery, sources: m.sources)
        try? await db.pool.write { conn in
            try conn.execute(sql: """
                INSERT INTO messages (id, room_id, author_kind, author_id, body, meta_json, round_num, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, arguments: [m.id, m.roomId, m.authorKind, m.authorId, m.body, meta, m.roundNum, now()])
        }
    }

    public func setMessageSearch(_ id: String, query: String?, sources: [EngineSearchSource]) async {
        guard !sources.isEmpty else { return }
        try? await db.pool.write { conn in
            // Merge sources into the (already-finalized) meta so reload re-renders
            // the director's "🔍 N sources" badge without re-searching.
            let existing = try String.fetchOne(conn, sql: "SELECT meta_json FROM messages WHERE id = ?", arguments: [id])
            var obj = Self.meta(existing) ?? [:]
            if let query { obj["searchQuery"] = query }
            obj["sources"] = Self.sourcesJSON(sources)
            let json = (try? String(decoding: JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), as: UTF8.self)) ?? (existing ?? "{}")
            try conn.execute(sql: "UPDATE messages SET meta_json = ? WHERE id = ?", arguments: [json, id])
        }
    }

    public func recordMessageTokens(_ id: String, tokens: Int, modelV: String) async {
        guard tokens > 0 else { return }
        try? await db.pool.write { conn in
            // Merge into the (already-finalized) meta — finalizeMessage rewrites
            // meta_json to {streaming,kind}, so this must run AFTER it (like
            // setMessageSearch) or the tokens get clobbered.
            let existing = try String.fetchOne(conn, sql: "SELECT meta_json FROM messages WHERE id = ?", arguments: [id])
            var obj = Self.meta(existing) ?? [:]
            obj["tokens"] = tokens
            obj["modelV"] = modelV
            let json = (try? String(decoding: JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), as: UTF8.self)) ?? (existing ?? "{}")
            try conn.execute(sql: "UPDATE messages SET meta_json = ? WHERE id = ?", arguments: [json, id])
        }
    }

    public func finalizeMessage(_ id: String, body: String) async {
        try? await db.pool.write { conn in
            // Preserve the chair `kind` if present; flip streaming off.
            let prevKind = try String.fetchOne(conn, sql: "SELECT meta_json FROM messages WHERE id = ?", arguments: [id])
                .flatMap { Self.kind(fromMeta: $0) }
            try conn.execute(sql: "UPDATE messages SET body = ?, meta_json = ? WHERE id = ?",
                             arguments: [body, Self.metaJSON(streaming: false, kind: prevKind), id])
        }
    }

    public func deleteMessage(_ id: String) async {
        try? await db.pool.write { conn in
            try conn.execute(sql: "DELETE FROM messages WHERE id = ?", arguments: [id])
        }
    }

    public func recordUsage(agentId: String, tokens: Int) async {
        guard tokens > 0 else { return }
        let day = Self.localDay()
        try? await db.pool.write { conn in
            // Snapshot model_v from the billed agent so a later model reassignment
            // doesn't retroactively rewrite the day bucket (desktop agents.ts:864).
            guard let modelV = try String.fetchOne(conn, sql: "SELECT model_v FROM agents WHERE id = ?", arguments: [agentId])
            else { return }   // agent deleted between turn-finish and bill-write
            try conn.execute(sql: "UPDATE agents SET tokens_consumed = tokens_consumed + ? WHERE id = ?",
                             arguments: [tokens, agentId])
            try conn.execute(sql: """
                INSERT INTO usage_daily (day, agent_id, model_v, tokens) VALUES (?, ?, ?, ?)
                ON CONFLICT(day, agent_id, model_v) DO UPDATE SET tokens = tokens + excluded.tokens
                """, arguments: [day, agentId, modelV, tokens])
        }
    }

    /// `YYYY-MM-DD` in the device's local timezone (desktop `formatLocalDay`) so
    /// "today" matches the user's wall clock — the Usage panel's day buckets.
    static func localDay(_ date: Date = Date()) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }

    public func recentMessages(_ roomId: String, limit: Int) async -> [EngineMessage] {
        (try? await db.pool.read { conn in
            let rows = try Row.fetchAll(conn, sql: """
                SELECT id, room_id, author_kind, author_id, body, meta_json, round_num
                FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?
                """, arguments: [roomId, limit])
            return rows.reversed().map { row in
                EngineMessage(
                    id: row["id"], roomId: row["room_id"], authorKind: row["author_kind"],
                    authorId: row["author_id"], body: row["body"] ?? "", roundNum: row["round_num"] ?? 1,
                    streaming: Self.streaming(fromMeta: row["meta_json"]),
                    kind: Self.kind(fromMeta: row["meta_json"]))
            }
        }) ?? []
    }

    public func insertKeyPoints(_ roomId: String, roundNum: Int, points: [String]) async -> [ConfigEvent.KeyPoint] {
        let stamp = now()
        let rows = points.enumerated().map { (i, p) in (id: UUID().uuidString, body: p, pos: i) }
        try? await db.pool.write { conn in
            for r in rows {
                try conn.execute(sql: """
                    INSERT INTO key_points (id, room_id, message_id, round_num, body, vote, position, created_at)
                    VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)
                    """, arguments: [r.id, roomId, roundNum, r.body, r.pos, stamp])
            }
        }
        return rows.map { ConfigEvent.KeyPoint(id: $0.id, body: $0.body, position: $0.pos, vote: nil) }
    }

    // MARK: BriefStore

    public func insertBrief(roomId: String, title: String, markdown: String, render: BriefRender?) async -> String {
        let id = UUID().uuidString
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let spine = render?.spine ?? "boardroom-dark"
        let components = render?.componentsJSON ?? "[]"
        let houseStyle = render?.houseStyle ?? "boardroom-default"
        let style = render?.style ?? "auto"
        let bodyJSON = render?.bodyJSON
        try? await db.pool.write { conn in
            try conn.execute(sql: """
                INSERT INTO briefs (id, room_id, style, title, body_md, body_json, spine, components_json,
                                    composer_rationale, subject_type, house_style, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, arguments: [id, roomId, style, title, markdown, bodyJSON, spine, components,
                                 render?.rationale, render?.subjectType, houseStyle, now])
        }
        return id
    }

    public func latestBriefMarkdown(roomId: String) async -> String? {
        (try? await db.pool.read { conn in
            try String.fetchOne(conn, sql:
                "SELECT body_md FROM briefs WHERE room_id = ? ORDER BY created_at DESC LIMIT 1", arguments: [roomId])
        }) ?? nil
    }

    public func setKeyPointVote(_ kpId: String, vote: String?) async {
        let votedAt = vote == nil ? nil : Int(Date().timeIntervalSince1970 * 1000)
        try? await db.pool.write { conn in
            try conn.execute(sql: "UPDATE key_points SET vote = ?, voted_at = ? WHERE id = ?",
                             arguments: [vote, votedAt, kpId])
        }
    }

    public func votedKeyPoints(_ roomId: String) async -> [ConfigEvent.KeyPoint] {
        (try? await db.pool.read { conn in
            try Row.fetchAll(conn, sql: """
                SELECT id, body, position, vote FROM key_points
                WHERE room_id = ? AND vote IN ('up', 'down')
                ORDER BY round_num ASC, position ASC
                """, arguments: [roomId]).map { row in
                ConfigEvent.KeyPoint(id: row["id"], body: row["body"], position: row["position"], vote: row["vote"])
            }
        }) ?? []
    }

    public func setStatus(_ roomId: String, _ status: RoomStatus) async {
        let stamp = status == .adjourned ? now() : nil
        try? await db.pool.write { conn in
            try conn.execute(sql: "UPDATE rooms SET status = ?, adjourned_at = COALESCE(?, adjourned_at) WHERE id = ?",
                             arguments: [status.rawValue, stamp, roomId])
        }
    }

    public func setAwaitingClarify(_ roomId: String, _ v: Bool) async {
        try? await db.pool.write { try $0.execute(sql: "UPDATE rooms SET awaiting_clarify = ? WHERE id = ?", arguments: [v ? 1 : 0, roomId]) }
    }
    public func setAwaitingContinue(_ roomId: String, _ v: Bool) async {
        try? await db.pool.write { try $0.execute(sql: "UPDATE rooms SET awaiting_continue = ? WHERE id = ?", arguments: [v ? 1 : 0, roomId]) }
    }

    // MARK: Boot recovery (ports of recoverStuckClarifyRooms / cleanupOrphanedStreams)

    /// Clear `awaiting_clarify` on rooms where the chair never actually posted a
    /// message (a clarify loop killed mid-stream leaves the flag stuck, locking
    /// the input bar forever). Returns the number of rooms recovered.
    @discardableResult
    public func recoverStuckClarifyRooms() async -> Int {
        (try? await db.pool.write { conn in
            try conn.execute(sql: """
                UPDATE rooms SET awaiting_clarify = 0
                WHERE awaiting_clarify = 1
                  AND id NOT IN (
                    SELECT DISTINCT m.room_id FROM messages m
                    JOIN agents a ON a.id = m.author_id
                    WHERE a.role_kind = 'moderator')
                """)
            return conn.changesCount
        }) ?? 0
    }

    /// Re-seat directors into MAIN rooms that have none in `room_members` — auto-pick
    /// rooms whose picker returned empty (LLM down at create), or synced rooms whose
    /// member rows lagged/never arrived. Such a room is unopenable (looks empty / like
    /// a new room). Cast is chosen DETERMINISTICALLY so two devices converge (the
    /// surrogate id = room_id:agent_id dedupes via sync): the directors who actually
    /// spoke (from the transcript), else the first 3 directors by id. Returns the
    /// number of rooms re-seated. Mirrors desktop `recoverRoomsMissingDirectors`.
    @discardableResult
    public func recoverRoomsMissingDirectors() async -> Int {
        (try? await db.pool.write { conn in
            let roomIds = try String.fetchAll(conn, sql: """
                SELECT id FROM rooms r
                WHERE r.room_kind = 'main'
                  AND NOT EXISTS (
                    SELECT 1 FROM room_members m JOIN agents a ON a.id = m.agent_id
                     WHERE m.room_id = r.id AND m.removed_at IS NULL AND a.role_kind = 'director')
                """)
            guard !roomIds.isEmpty else { return 0 }
            let defaultCast = try String.fetchAll(conn, sql:
                "SELECT id FROM agents WHERE role_kind = 'director' ORDER BY id LIMIT 3")
            let now = Int(Date().timeIntervalSince1970 * 1000)
            var fixed = 0
            for rid in roomIds {
                var dirIds = try String.fetchAll(conn, sql: """
                    SELECT DISTINCT m.author_id AS aid FROM messages m
                    JOIN agents a ON a.id = m.author_id
                    WHERE m.room_id = ? AND m.author_kind = 'agent' AND a.role_kind = 'director'
                    ORDER BY a.id
                    """, arguments: [rid])
                if dirIds.isEmpty { dirIds = defaultCast }
                if dirIds.isEmpty { continue }   // no directors exist at all
                for (idx, aid) in dirIds.enumerated() {
                    // id = room_id:agent_id · deterministic sync surrogate (migration 062).
                    try conn.execute(sql:
                        "INSERT OR IGNORE INTO room_members (room_id, agent_id, position, joined_at, id) VALUES (?,?,?,?,?)",
                        arguments: [rid, aid, idx, now, "\(rid):\(aid)"])
                }
                fixed += 1
            }
            return fixed
        }) ?? 0
    }

    /// Finalize messages stranded `streaming:true` by a crash/kill: delete empty
    /// placeholders, flip the rest to `streaming:false`. The runtime source of
    /// truth is `finalizeMessage`; this is the boot-time safety net. Returns the
    /// number of messages touched.
    @discardableResult
    public func cleanupOrphanedStreams() async -> Int {
        (try? await db.pool.write { conn in
            try conn.execute(sql:
                "DELETE FROM messages WHERE meta_json LIKE '%\"streaming\":true%' AND (body IS NULL OR body = '')")
            var n = conn.changesCount
            try conn.execute(sql: """
                UPDATE messages
                SET meta_json = replace(replace(meta_json, '"streaming":true', '"streaming":false'),
                                        '"speakerStatus":"streaming"', '"speakerStatus":"final"')
                WHERE meta_json LIKE '%"streaming":true%'
                """)
            n += conn.changesCount
            return n
        }) ?? 0
    }

    // MARK: row mapping

    private static func director(_ row: Row) -> DirectorRef {
        let spec = parsePersonaSpec(row["persona_spec_json"])
        // Carry the stored id VERBATIM — a DYNAMIC model id has no `ModelV` case and
        // must NOT be parsed-and-dropped to a default (that silently reverted the
        // user's pick on every load). Only an empty value falls back to the default.
        let storedModel = (row["model_v"] as String?) ?? ""
        return DirectorRef(id: row["id"], name: row["name"],
                    modelV: storedModel.isEmpty ? ModelV.sonnet_4_6.rawValue : storedModel,
                    handle: row["handle"] ?? "", roleTag: row["role_tag"] ?? "",
                    instruction: row["instruction"] ?? "", bio: row["bio"] ?? "",
                    ability: parseAbility(row["ability_json"]),
                    contrarianTakes: spec.contrarian, failureModes: spec.failures,
                    fewShot: spec.fewShot, reflectionChecklist: spec.reflection,
                    userRules: parseUserRules(row["user_rules_json"]),
                    webSearchEnabled: (row["web_search_enabled"] as Int?).map { $0 != 0 } ?? false)
    }

    /// `ability_json` → lens-axis dict (e.g. {"dissent":8,"rigor":7}). Tolerant of
    /// int or float values; empty/malformed → [:].
    private static func parseAbility(_ raw: String?) -> [String: Int] {
        guard let raw, let d = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        var out: [String: Int] = [:]
        for (k, v) in obj {
            if let n = v as? Int { out[k] = n }
            else if let n = v as? Double { out[k] = Int(n) }
            else if let n = (v as? NSNumber)?.intValue { out[k] = n }
        }
        return out
    }

    /// `persona_spec_json` → the slices the director prompt + dissent picker read:
    /// `spec.contrarianTakes` / `spec.failureModes` (picker) and the top-level
    /// `fewShot` / `reflectionChecklist` arrays (persona blocks #12). All empty
    /// when no persona spec (Signal-mode / seed directors).
    private static func parsePersonaSpec(_ raw: String?)
        -> (contrarian: [String], failures: [String], fewShot: [PersonaBuilder.PersonaFewShot], reflection: [String]) {
        guard let raw, let d = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
        else { return ([], [], [], []) }
        let spec = obj["spec"] as? [String: Any] ?? [:]
        let c = (spec["contrarianTakes"] as? [Any])?.compactMap { $0 as? String } ?? []
        let f = (spec["failureModes"] as? [Any])?.compactMap { $0 as? String } ?? []
        // fewShot / reflectionChecklist live at the TOP level of the blob (written
        // by personaSpecJSONFull), not under `spec`.
        let fs = (obj["fewShot"] as? [Any])?.compactMap { e -> PersonaBuilder.PersonaFewShot? in
            guard let m = e as? [String: Any] else { return nil }
            return PersonaBuilder.PersonaFewShot(
                scenario: (m["scenario"] as? String) ?? "",
                genericResponse: (m["genericResponse"] as? String) ?? "",
                personaResponse: (m["personaResponse"] as? String) ?? "",
                rationale: (m["rationale"] as? String) ?? "")
        } ?? []
        let refl = (obj["reflectionChecklist"] as? [Any])?.compactMap { $0 as? String }
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } ?? []
        return (c, f, fs, refl)
    }

    /// `user_rules_json` → trimmed non-empty strings, capped 12 (port of
    /// `parseUserRules`). The user-authored NON-NEGOTIABLE directives.
    private static func parseUserRules(_ raw: String?) -> [String] {
        guard let raw, let d = raw.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: d) as? [Any] else { return [] }
        return arr.compactMap { $0 as? String }.map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }.prefix(12).map { $0 }
    }
    private static func metaJSON(streaming: Bool, kind: String?,
                                 tool: String? = nil, toolStatus: String? = nil,
                                 searchQuery: String? = nil, sources: [EngineSearchSource]? = nil) -> String {
        var obj: [String: Any] = ["streaming": streaming, "speakerStatus": streaming ? "streaming" : "final"]
        if let kind { obj["kind"] = kind }
        if let tool { obj["tool"] = tool }
        if let toolStatus { obj["toolStatus"] = toolStatus }
        if let searchQuery { obj["searchQuery"] = searchQuery }
        if let sources, !sources.isEmpty {
            obj["sources"] = sources.map { ["title": $0.title, "url": $0.url, "description": $0.description] }
        }
        return (try? String(decoding: JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), as: UTF8.self)) ?? "{}"
    }
    /// Serialise just the web-search sources array (used by `setMessageSearch`).
    private static func sourcesJSON(_ sources: [EngineSearchSource]) -> [[String: String]] {
        sources.map { ["title": $0.title, "url": $0.url, "description": $0.description] }
    }
    private static func meta(_ s: String?) -> [String: Any]? {
        guard let s, let d = s.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
    }
    private static func streaming(fromMeta s: String?) -> Bool { (meta(s)?["streaming"] as? Bool) ?? false }
    private static func kind(fromMeta s: String?) -> String? { meta(s)?["kind"] as? String }
}
