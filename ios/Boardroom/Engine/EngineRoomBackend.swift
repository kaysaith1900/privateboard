import Foundation
import GRDB
import BoardroomCore
import BoardroomEngine
import BoardroomStorage

/// `RoomBackend` backed by the in-process native engine — the no-server sibling
/// of `APIClient` for a live room. Control verbs route to `EngineClient`; the
/// read path (`getRoom` / `getAgent`) reads the engine's GRDB and decodes a
/// server-shaped JSON payload into the existing app models (no new inits, fully
/// decoupled). Voice / vote / settings are no-ops in this text-room MVP (the
/// engine doesn't yet drive TTS or key-point votes); they're stubbed so the
/// `RoomSession` UI runs without stranding.
struct EngineRoomBackend: RoomBackend {
    let client: EngineClient
    let db: BoardroomDB

    init(host: NativeEngineHost) { self.client = host.client; self.db = host.db }

    // MARK: events + control

    func roomEvents(_ roomId: String, lastEventID: String?) -> AsyncStream<RoomEvent> {
        client.roomEvents(roomId, lastEventID: lastEventID)
    }
    func sendMessage(_ id: String, body: String, mode: String) async { await client.sendMessage(id, body: body) }
    func continueRoom(_ id: String) async { await client.continueRoom(id) }
    func resumeRoom(_ id: String) async { await client.resumeRoom(id) }
    func pauseRoom(_ id: String, mode: String) async { await client.pauseRoom(id) }

    func voteKeyPoint(_ id: String, _ kpId: String, vote: String?) async { await client.voteKeyPoint(kpId, vote: vote) }
    // Force round-end ("End round & vote") · wraps the round NOW (chair round-end
    // → votable key points). Used by manual vote-trigger and the auto-mode "Open
    // vote" escalation. The engine wraps after the current speaker's turn.
    func roundEnd(_ id: String, mode: String) async { await client.requestRoundEnd(id, mode: mode) }
    /// Persist tone / intensity / delivery / brief-style edits to the rooms row so
    /// they SURVIVE re-entry (accepting the chair's tone-shift vote, or RoomSettings
    /// edits). Previously a no-op stub → the change reverted on reopen. The running
    /// actor re-reads `roomMeta` each round, so the next round picks up the new tone.
    @discardableResult
    func updateRoomSettings(_ id: String, mode: String?, intensity: String?, deliveryMode: String?,
                            briefStyle: String?, voteTrigger: String?) async -> Room {
        try? await db.pool.write { conn in
            if let mode { try conn.execute(sql: "UPDATE rooms SET mode = ? WHERE id = ?", arguments: [mode, id]) }
            if let intensity { try conn.execute(sql: "UPDATE rooms SET intensity = ? WHERE id = ?", arguments: [intensity, id]) }
            if let deliveryMode { try conn.execute(sql: "UPDATE rooms SET delivery_mode = ? WHERE id = ?", arguments: [deliveryMode, id]) }
            if let briefStyle { try conn.execute(sql: "UPDATE rooms SET brief_style = ? WHERE id = ?", arguments: [briefStyle, id]) }
            if let voteTrigger { try conn.execute(sql: "UPDATE rooms SET vote_trigger = ? WHERE id = ?", arguments: [voteTrigger, id]) }
        }
        return (try? await getRoom(id))?.room ?? Room.placeholder(id: id)
    }
    // Audio plays in-process · voiceDone releases the pump's gate so the next
    // speaker fires only after this clip finished. voiceProgress is a heartbeat
    // (no server timeout to bump on-device) → no-op.
    func voiceProgress(_ id: String, _ messageId: String) async {}
    func voiceDone(_ id: String, _ messageId: String) async { await client.voiceDone(id, messageId) }
    // The engine streams voice live but doesn't persist per-message clips, so
    // there's nothing to re-fetch — adjourned-room replay re-synthesizes instead.
    func messageAudio(_ messageId: String) async -> Data? { nil }
    /// Re-synthesize a message's audio on demand (replay) · read its body + author
    /// from GRDB, then run the engine TTS in that director's voice.
    func synthMessageAudio(_ messageId: String) async -> Data? {
        let pair: (body: String, author: String)? = try? await db.pool.read { conn in
            guard let r = try Row.fetchOne(conn, sql: "SELECT body, author_id FROM messages WHERE id = ?", arguments: [messageId]),
                  let b = r["body"] as String?, !b.isEmpty, let a = r["author_id"] as String? else { return nil }
            return (b, a)
        } ?? nil
        guard let pair else { return nil }
        return await client.synthesize(text: pair.body, agentId: pair.author)
    }

    // MARK: read path · GRDB → server-shaped JSON → app models

    func getRoom(_ id: String) async throws -> RoomSnapshot {
        let payload: [String: Any] = try await db.pool.read { conn in
            var out: [String: Any] = [:]
            if let r = try Row.fetchOne(conn, sql: """
                SELECT id, name, subject, mode, intensity, delivery_mode, status, created_at, vote_trigger, adjourned_at FROM rooms WHERE id = ?
                """, arguments: [id]) {
                out["room"] = [
                    "id": r["id"] as String? ?? id,
                    "name": r["name"] as String? as Any,
                    "subject": r["subject"] as String? as Any,
                    "mode": r["mode"] as String? as Any,
                    "intensity": r["intensity"] as String? as Any,
                    "deliveryMode": r["delivery_mode"] as String? as Any,
                    "status": r["status"] as String? ?? "live",
                    "createdAt": r["created_at"] as Int? as Any,
                    "voteTrigger": r["vote_trigger"] as String? ?? "auto",
                    "adjournedAt": r["adjourned_at"] as Int? as Any,
                ]
            }
            // Members (directors) + chair, joined to agents for byline fields.
            let memberRows = try Row.fetchAll(conn, sql: """
                SELECT a.id AS id, a.name AS name, a.avatar_path AS avatar_path, a.role_kind AS role_kind,
                       a.role_tag AS role_tag, a.model_v AS model_v
                FROM room_members m JOIN agents a ON a.id = m.agent_id
                WHERE m.room_id = ? AND m.removed_at IS NULL AND a.role_kind = 'director'
                ORDER BY m.position
                """, arguments: [id])
            out["members"] = memberRows.map(Self.memberDict)
            if let chair = try Row.fetchOne(conn, sql: """
                SELECT id, name, avatar_path, role_kind, role_tag, model_v
                FROM agents WHERE role_kind = 'moderator' LIMIT 1
                """) { out["chair"] = Self.memberDict(chair) }
            // Messages in order. meta_json carries kind + web-search (tool-use card
            // + director sources) so reload re-renders the search modules.
            let msgRows = try Row.fetchAll(conn, sql: """
                SELECT id, body, author_id, author_kind, round_num, created_at, meta_json
                FROM messages WHERE room_id = ? ORDER BY created_at
                """, arguments: [id])
            out["messages"] = msgRows.map { m -> [String: Any] in
                var d: [String: Any] = [
                    "id": m["id"] as String? as Any,
                    "body": m["body"] as String? as Any,
                    "authorId": m["author_id"] as String? as Any,
                    "authorKind": m["author_kind"] as String? as Any,
                    "roundNum": m["round_num"] as Int? as Any,
                    "createdAt": m["created_at"] as Int? as Any,
                ]
                if let raw: String = m["meta_json"], let data = raw.data(using: .utf8),
                   let meta = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                    if let k = meta["kind"] as? String { d["kind"] = k }
                    if let t = meta["tool"] as? String { d["tool"] = t }
                    if let ts = meta["toolStatus"] as? String { d["toolStatus"] = ts }
                    if let q = meta["searchQuery"] as? String { d["searchQuery"] = q }
                    if let s = meta["sources"] { d["sources"] = s }
                    if let tk = meta["tokens"] as? Int { d["tokens"] = tk }          // session analytics · per-turn token count
                    if let mv = meta["modelV"] as? String { d["modelV"] = mv }       // session analytics · model that produced this turn
                }
                return d
            }
            // Key points (with votes) · drives the adjourned-room "what you valued"
            // analytics section. Ordered by round then position.
            let kpRows = try Row.fetchAll(conn, sql: """
                SELECT id, body, vote, position, round_num FROM key_points
                WHERE room_id = ? ORDER BY round_num, position
                """, arguments: [id])
            out["keyPoints"] = kpRows.map { k -> [String: Any] in
                [
                    "id": k["id"] as String? as Any,
                    "body": k["body"] as String? as Any,
                    "vote": k["vote"] as String? as Any,
                    "position": k["position"] as Int? as Any,
                    "roundNum": k["round_num"] as Int? as Any,
                ]
            }
            return out
        }
        return try Self.decode(RoomSnapshot.self, from: payload)
    }

    func getAgent(_ id: String) async throws -> Agent {
        let payload: [String: Any] = try await db.pool.read { conn in
            guard let r = try Row.fetchOne(conn, sql:
                "SELECT id, name, avatar_path, role_kind, role_tag, model_v FROM agents WHERE id = ?", arguments: [id])
            else { return [:] }
            return Self.memberDict(r)
        }
        return try Self.decode(Agent.self, from: payload)
    }

    private static func memberDict(_ r: Row) -> [String: Any] {
        [
            "id": r["id"] as String? ?? "",
            "name": r["name"] as String? ?? "",
            "avatarPath": r["avatar_path"] as String? as Any,
            "roleKind": r["role_kind"] as String? as Any,
            "roleTag": r["role_tag"] as String? as Any,
            "modelV": r["model_v"] as String? as Any,
        ]
    }

    private static func decode<T: Decodable>(_ type: T.Type, from dict: [String: Any]) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: dict.compactMapValues { $0 is NSNull ? nil : $0 })
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private extension Room {
    /// Minimal stand-in when an engine read can't produce a full room (settings
    /// no-op return). Decoded from a tiny payload so no memberwise init is needed.
    static func placeholder(id: String) -> Room {
        let data = try! JSONSerialization.data(withJSONObject: ["id": id, "status": "live"])
        return try! JSONDecoder().decode(Room.self, from: data)
    }
}
