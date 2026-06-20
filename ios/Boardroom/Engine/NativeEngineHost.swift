import Foundation
import GRDB
import BoardroomEngine
import BoardroomAI
import BoardroomStorage
import BoardroomVoice

/// Assembles the on-device engine stack: GRDB DB → `GRDBRoomStore` →
/// `LLMAdapter` (Keychain creds) → `Engine` → `EngineClient`. One instance per
/// app session, built lazily when `FeatureFlag.nativeEngine` is on. The app's
/// `RoomSession` consumes `client.roomEvents(...)` exactly as it does the REST
/// client (the `RoomEventSource` seam) — that runtime swap is the real-device
/// step; this host is the in-process backend it points at.
@MainActor
final class NativeEngineHost {
    let db: BoardroomDB
    let store: GRDBRoomStore
    let engine: Engine
    let client: EngineClient
    let router: LLMRouter
    let loopback: LoopbackServer?

    /// Origin the 3D stage WebView loads from (loopback server), or nil.
    var stageBaseURL: URL? { loopback?.baseURL }

    /// The user's display name from `prefs.name` (chair addresses the user by it).
    func userName() -> String {
        ((try? db.pool.read { try String.fetchOne($0, sql: "SELECT name FROM prefs WHERE id = 1") }) ?? nil) ?? "You"
    }

    /// Persist the user's display name into `prefs.name` (onboarding name step).
    /// The engine reads it for the chair's "you" line + long-term memory header.
    func setUserName(_ name: String) {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        try? db.pool.write { try $0.execute(sql: "UPDATE prefs SET name = ?, updated_at = ? WHERE id = 1",
                                            arguments: [n.isEmpty ? "You" : n, Int(Date().timeIntervalSince1970 * 1000)]) }
    }

    /// The host user's own 3D-avatar config from `prefs.avatar3d_json` (the user
    /// seat in the room renders this; the settings editor seeds from it). Returned
    /// as a raw JSON object so the caller maps it to `Avatar3DConfig`. nil = unset.
    func userAvatar3d() -> [String: Any]? {
        let raw: String? = (try? db.pool.read { try String.fetchOne($0, sql: "SELECT avatar3d_json FROM prefs WHERE id = 1") }) ?? nil
        guard let raw, let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }

    /// The host user's rendered portrait (`prefs.avatar_url`) · nil = unset.
    func userAvatarUrl() -> String? {
        ((try? db.pool.read { try String.fetchOne($0, sql: "SELECT avatar_url FROM prefs WHERE id = 1") }) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Persist the host user's 3D avatar (`prefs.avatar3d_json`) + its rendered
    /// portrait (`prefs.avatar_url`). Mirrors the desktop `PUT /api/prefs` write.
    func setUserAvatar3d(_ config: [String: Any], avatarUrl: String?) {
        let json = (try? JSONSerialization.data(withJSONObject: config)).flatMap { String(data: $0, encoding: .utf8) }
        try? db.pool.write { conn in
            try conn.execute(sql: "UPDATE prefs SET avatar3d_json = ?, updated_at = ? WHERE id = 1",
                             arguments: [json, Int(Date().timeIntervalSince1970 * 1000)])
            if let avatarUrl, !avatarUrl.isEmpty {
                try conn.execute(sql: "UPDATE prefs SET avatar_url = ? WHERE id = 1", arguments: [avatarUrl])
            }
        }
    }

    /// The full stored API key for a credential id (read from the Keychain) · so the
    /// API-keys detail screen can reveal what's configured. On-device only.
    func credentialKey(_ kind: CredentialKind, id: String) -> String? {
        KeychainCredentialStore().key(kind, id: id)
    }

    /// The configured MiniMax host region ("cn" | "intl"), for the credential detail.
    func minimaxRegion() -> String {
        ((try? db.pool.read { try String.fetchOne($0, sql: "SELECT minimax_region FROM prefs WHERE id = 1") }) ?? nil) ?? "cn"
    }

    /// The active (or newest) voice credential's full key · used to check whether a
    /// MiniMax key's JWT already embeds the GroupID before prompting for one.
    func activeVoiceKey() -> String? {
        let id: String? = (try? db.pool.read { conn -> String? in
            if let id = try String.fetchOne(conn, sql: "SELECT active_voice_credential_id FROM prefs WHERE id = 1"),
               (try String.fetchOne(conn, sql: "SELECT id FROM voice_credentials WHERE id = ?", arguments: [id])) != nil {
                return id
            }
            return try String.fetchOne(conn, sql: "SELECT id FROM voice_credentials ORDER BY updated_at DESC LIMIT 1")
        }) ?? nil
        guard let id else { return nil }
        return KeychainCredentialStore().key(.voice, id: id)
    }

    /// Ensure the loopback is serving — rebind if iOS reclaimed the socket while
    /// the app was suspended. Returns the current base URL (possibly a NEW port,
    /// so the caller must re-point any cached baseURL). nil when there's no
    /// loopback. Called on foreground resume.
    func ensureLoopbackAlive() async -> URL? {
        guard let lb = loopback else { return nil }
        if await lb.isHealthy() { return lb.baseURL }
        lb.restart()
        // Re-probe · nil signals a PERSISTENT failure (socket still dead after the
        // rebind) so the caller can surface a reconnect prompt instead of silently
        // re-pointing at a dead URL.
        return await lb.isHealthy() ? lb.baseURL : nil
    }

    /// Session-wide singleton (lazy). The native engine + its DB live for the
    /// app's lifetime; `RoomView` / native create resolve the same instance.
    static let shared: NativeEngineHost? = try? NativeEngineHost()

    init() throws {
        db = try BoardroomDB()                       // Application Support/Boardroom/boardroom.sqlite
        store = GRDBRoomStore(db: db)
        let creds = EngineCredentialSource(db: db, keychain: KeychainCredentialStore())
        let adapter = LLMAdapter(credentials: creds)
        let llm = LLMEngineAdapter(adapter: adapter)
        // Router · shares the adapter; resolves utility/default models for the
        // speaker pickers + (later) frame-break/summarize/memory/brief.
        router = LLMRouter(adapter: adapter, credentials: creds)
        // TTS · resolves the active voice provider LIVE from the DB (sync read,
        // off the main actor) so a voice key set after launch takes effect.
        let dbRef = db
        let tts = TTSEngineAdapter(service: TTSService(credentials: creds),
                                   resolveProvider: { NativeEngineHost.activeVoiceProvider(dbRef) },
                                   resolveVoice: { agentId in NativeEngineHost.voiceProfile(dbRef, agentId) })
        // Web-search seam (#10) · resolves the active Brave/Tavily credential live
        // from the DB + keychain per call; nil result when no key → no SHARED MATERIALS.
        let search = SearchEngineAdapter(db: db)
        engine = Engine(store: store, llm: llm, tts: tts, router: router, search: search)
        client = EngineClient(engine: engine)
        // Loopback server for the 3D stage WebView (bundled assets + /api/rooms).
        loopback = LoopbackServer(db: db)
        loopback?.start()
    }

    /// Active voice provider from the DB (sync, nonisolated — safe to call from
    /// the engine's actors). nil when no voice key is configured.
    nonisolated static func activeVoiceProvider(_ db: BoardroomDB) -> VoiceProviderKind? {
        let provider: String? = (try? db.pool.read { conn -> String? in
            // Prefer the active pointer; but if it's unset OR dangling (e.g. the user
            // REPLACED the voice key and the old credential row was deleted without
            // re-pointing prefs), fall back to the newest stored voice credential so
            // the ROOM doesn't go silent while the voice-setup PREVIEW — which reads a
            // credential directly — still works.
            if let id = try String.fetchOne(conn, sql: "SELECT active_voice_credential_id FROM prefs WHERE id = 1"),
               let p = try String.fetchOne(conn, sql: "SELECT provider FROM voice_credentials WHERE id = ?", arguments: [id]) {
                return p
            }
            return try String.fetchOne(conn, sql: "SELECT provider FROM voice_credentials ORDER BY updated_at DESC LIMIT 1")
        }) ?? nil
        return provider.flatMap(VoiceProviderKind.init(rawValue:))
    }

    /// The director's saved voice (`agents.voice_json`) as a `VoiceProfile`, or
    /// nil when unset / unparseable (→ provider default). nonisolated · the TTS
    /// adapter resolves it off the main actor per turn.
    nonisolated static func voiceProfile(_ db: BoardroomDB, _ agentId: String) -> VoiceProfile? {
        guard let raw = (try? db.pool.read { conn in
            try String.fetchOne(conn, sql: "SELECT voice_json FROM agents WHERE id = ?", arguments: [agentId])
        }) ?? nil, let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let providerStr = obj["provider"] as? String, let kind = VoiceProviderKind(rawValue: providerStr),
              let voiceId = obj["voiceId"] as? String, !voiceId.isEmpty else { return nil }
        let model = (obj["model"] as? String) ?? "speech-2.8-hd"
        let emotion = (obj["emotion"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return VoiceProfile(provider: kind, model: model, voiceId: voiceId, emotion: emotion)
    }

    /// `RoomBackend` over this host (the no-server live-room driver).
    var backend: EngineRoomBackend { EngineRoomBackend(host: self) }

    /// All native rooms (newest first) as app `Room` models — for the rooms list.
    func listRooms() -> [Room] {
        let dicts: [[String: Any]] = (try? db.pool.read { conn in
            // Director ids per room (chair excluded), in seat order · the room-list
            // card resolves these against the roster to show director avatars. Synced
            // rooms are never opened on this device, so without this their cards have
            // no directorIds → `app.directors(for:)` returns [] → no avatars.
            var directorsByRoom: [String: [String]] = [:]
            let memberRows = try Row.fetchAll(conn, sql: """
                SELECT m.room_id AS rid, m.agent_id AS aid
                FROM room_members m JOIN agents a ON a.id = m.agent_id
                WHERE m.removed_at IS NULL AND a.role_kind = 'director'
                ORDER BY m.room_id, m.position
                """)
            for mr in memberRows {
                guard let rid = mr["rid"] as String?, let aid = mr["aid"] as String? else { continue }
                directorsByRoom[rid, default: []].append(aid)
            }
            return try Row.fetchAll(conn, sql: """
                SELECT id, name, subject, mode, intensity, delivery_mode, status, created_at
                FROM rooms ORDER BY created_at DESC
                """).map { r -> [String: Any] in
                let rid = r["id"] as String? ?? ""
                return [
                    "id": rid,
                    "name": r["name"] as String? as Any,
                    "subject": r["subject"] as String? as Any,
                    "mode": r["mode"] as String? as Any,
                    "intensity": r["intensity"] as String? as Any,
                    "deliveryMode": r["delivery_mode"] as String? as Any,
                    "status": r["status"] as String? ?? "live",
                    "createdAt": r["created_at"] as Int? as Any,
                    "directorIds": directorsByRoom[rid] ?? [],
                ]
            }
        }) ?? []
        return dicts.compactMap {
            (try? JSONSerialization.data(withJSONObject: $0.compactMapValues { $0 is NSNull ? nil : $0 }))
                .flatMap { try? JSONDecoder().decode(Room.self, from: $0) }
        }
    }

    private var convened: Set<String> = []
    /// Convene a room exactly once · ONLY the first time it opens with no
    /// discussion yet. `convene` re-runs the chair clarify + an opening round, so
    /// re-running it on an existing room (re-entry, app relaunch — the in-memory
    /// `convened` set is empty after a cold start) made the discussion appear to
    /// restart. Gate on the DB: a room that already has an agent (chair/director)
    /// message was convened before → skip it; the user resumes via Continue or a
    /// new message (the actor hydrates its persisted phase from the DB).
    func conveneIfNeeded(_ roomId: String) async {
        guard convened.insert(roomId).inserted else { return }
        if !roomHasDiscussion(roomId) {
            await client.convene(roomId)
            return
        }
        // Already has discussion · never re-convene (that felt like a restart). But
        // a LIVE room not waiting on the user (mid-round, interrupted by leaving /
        // relaunch) must CONTINUE so it doesn't sit silent. Paused / adjourned /
        // awaiting-Continue / awaiting-clarify rooms wait for the user's action.
        if liveAndNotAwaiting(roomId) {
            await client.resumeLiveRoom(roomId)
        }
    }

    /// True when the room is `live` AND not blocked on a user action (no
    /// awaiting_continue / awaiting_clarify) — i.e. it was actively mid-round.
    private func liveAndNotAwaiting(_ roomId: String) -> Bool {
        (try? db.pool.read { conn -> Bool in
            guard let row = try Row.fetchOne(conn, sql:
                "SELECT status, awaiting_continue, awaiting_clarify FROM rooms WHERE id = ?", arguments: [roomId])
            else { return false }
            let status: String = row["status"] ?? ""
            let cont = (row["awaiting_continue"] as Int?) ?? 0
            let clar = (row["awaiting_clarify"] as Int?) ?? 0
            return status == "live" && cont == 0 && clar == 0
        }) ?? false
    }

    /// True when the room already has at least one agent message (chair or
    /// director) — i.e. it was convened on a prior open.
    private func roomHasDiscussion(_ roomId: String) -> Bool {
        ((try? db.pool.read { conn in
            try Int.fetchOne(conn, sql:
                "SELECT 1 FROM messages WHERE room_id = ? AND author_kind = 'agent' LIMIT 1", arguments: [roomId])
        }) ?? nil) != nil
    }

    /// Adjourn a live room (status → adjourned in GRDB).
    func adjourn(_ roomId: String) async { await client.adjournRoom(roomId) }

    /// Generate + persist the closing brief; `supplement` is the user's custom
    /// angle/focus prompt from the adjourn overlay (empty → standard brief).
    @discardableResult
    func generateBrief(_ roomId: String, supplement: String? = nil, mode: BriefGenerator.Mode = .researchNote) async throws -> String {
        try await client.generateBrief(roomId, supplement: supplement, mode: mode)
    }

    /// The newest brief id for a room (for the render URL), or nil.
    func latestBriefId(_ roomId: String) -> String? {
        (try? db.pool.read { conn in
            try String.fetchOne(conn, sql: "SELECT id FROM briefs WHERE room_id = ? ORDER BY created_at DESC LIMIT 1", arguments: [roomId])
        }) ?? nil
    }

    /// Room ids that have at least one generated brief · one query for the whole
    /// list so the room cards can badge "REPORT" without a per-card DB hit.
    func roomsWithBriefs() -> Set<String> {
        let rows: [String] = (try? db.pool.read { conn in
            try String.fetchAll(conn, sql: "SELECT DISTINCT room_id FROM briefs")
        }) ?? []
        return Set(rows)
    }

    /// The brief's `style` ("auto" research-note · "magazine"/"newspaper"/"ppt").
    func briefStyle(_ briefId: String) -> String {
        ((try? db.pool.read { conn in
            try String.fetchOne(conn, sql: "SELECT style FROM briefs WHERE id = ?", arguments: [briefId])
        }) ?? nil) ?? "auto"
    }

    /// Loopback URL the brief renders from · report.html for research-note (spine
    /// system + charts), else the structured template (magazine/newspaper/ppt.html)
    /// which reads the brief's body_json. All four fetch /api/briefs/:id.
    func reportURL(briefId: String, roomId: String, style: String? = nil) -> URL? {
        guard let base = loopback?.baseURL else { return nil }
        let page: String
        var styleParam = ""   // report.html reads ?spine= · magazine/newspaper read ?v=
        switch briefStyle(briefId) {
        case "magazine": page = "magazine.html"
        case "newspaper": page = "newspaper.html"
        case "ppt": page = "ppt.html"
        default: page = "report.html"
        }
        if let s = style, !s.isEmpty {
            let key = (page == "report.html") ? "spine" : "v"
            let enc = s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s
            styleParam = "&\(key)=\(enc)"
        }
        return URL(string: "\(page)?b=\(briefId)&r=\(roomId)\(styleParam)", relativeTo: base)
    }

    /// Create a native room: ensure seeded, resolve the cast, insert the room +
    /// seat directors. `agentIds` empty → AUTO-PICK a 3-director cast via
    /// `pickDirectors` (lens coverage + recency variety + diversity guardrail);
    /// falls back to the first-3 / catalog when no model is reachable. Returns the
    /// engine room id (opens in the real `RoomView` via `EngineRoomBackend`).
    func createRoom(subject: String, mode: String = "constructive",
                    intensity: String = "sharp", deliveryMode: String = "text",
                    agentIds: [String] = [], parentRoomId: String? = nil) async throws -> String {
        try? AgentSeed.seed(into: db)
        let roomId = UUID().uuidString
        // Resolve seats BEFORE the write (the picker is an async LLM call).
        var seats: [String]
        if !agentIds.isEmpty {
            seats = agentIds
        } else {
            let catalog = await store.directorCatalog()
            if catalog.count <= 3 {
                seats = catalog.map(\.id)
            } else {
                let pick = await SpeakerPicker.pickDirectors(router: router, subject: subject, candidates: catalog)
                seats = pick.picks.map(\.agentId)
            }
            // Fallback · the picker can return an empty cast when the LLM is
            // unreachable (e.g. the carrier is down) — that used to create a room
            // with NO directors (chair-only), which then can't be opened (it looks
            // like an empty/new room and, once synced, shows no cast on other
            // devices). Never ship an empty cast: fall back to the first 3 of the
            // catalog (deterministic id order) so the room is always usable.
            if seats.isEmpty {
                seats = Array(catalog.sorted { $0.id < $1.id }.map(\.id).prefix(3))
            }
        }
        try await db.pool.write { conn in
            let n = (try Int.fetchOne(conn, sql: "SELECT COALESCE(MAX(number),0)+1 FROM rooms")) ?? 1
            let now = Int(Date().timeIntervalSince1970 * 1000)
            // parent_room_id links a follow-up room to the prior session it
            // continues (migration 020) · the director prompt loads the parent's
            // settled judgement as priorContext (#11). NULL for standalone rooms.
            try conn.execute(sql: """
                INSERT INTO rooms (id, number, name, subject, mode, intensity, delivery_mode, status, parent_room_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?, ?)
                """, arguments: [roomId, n, subject, subject, mode, intensity, deliveryMode,
                                 parentRoomId?.isEmpty == false ? parentRoomId : nil, now])
            for (pos, aid) in seats.enumerated() {
                // id = room_id:agent_id · deterministic sync surrogate (migration 062).
                try conn.execute(sql: "INSERT INTO room_members (room_id, agent_id, position, joined_at, id) VALUES (?,?,?,?,?)",
                                 arguments: [roomId, aid, pos, now, "\(roomId):\(aid)"])
            }
        }
        titleRoom(roomId, subject: subject)   // fire-and-forget AI title (in-room header)
        return roomId
    }

    /// Distill the subject into a short, AI-refined room title (the in-room
    /// header; the LIST keeps showing the user's raw query/subject). Fire-and-
    /// forget · writes `rooms.name` when the LLM lands; failure leaves name=subject.
    func titleRoom(_ roomId: String, subject: String) {
        let subj = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !subj.isEmpty else { return }
        let dbRef = db
        Task.detached {
            let creds = EngineCredentialSource(db: dbRef, keychain: KeychainCredentialStore())
            guard let active = creds.activeLLMCredential(),
                  let modelV = Availability.utilityModel(active: active.carrier) ?? Availability.defaultModel(active: active.carrier)
            else { return }
            let sys = "Distill the user's discussion subject into a SHORT title — 3 to 6 words, in the subject's own language. Output ONLY the title: no surrounding quotes, no trailing punctuation, no preamble."
            let req = LLMRequest(modelV: modelV.rawValue,
                                 messages: [LLMMessage(role: .system, content: sys), LLMMessage(role: .user, content: subj)],
                                 maxTokens: 40)
            var out = ""
            do { for try await c in LLMAdapter(credentials: creds).stream(req) { if case .textDelta(let d) = c { out += d } } }
            catch { return }
            let title = out.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "“", with: "").replacingOccurrences(of: "”", with: "")
            guard !title.isEmpty, title.count <= 80 else { return }
            try? await dbRef.pool.write { try $0.execute(sql: "UPDATE rooms SET name = ? WHERE id = ?", arguments: [title, roomId]) }
        }
    }

    /// Build a NEW director on-device via the multi-phase persona builder
    /// (profile → rules → few-shot → reflection → eval → name) and persist it as
    /// a real `agents` row carrying `persona_spec_json` — so the new director
    /// drives the dissent-gap picker (P4-4) + lens reminder (P4-5) exactly like a
    /// seeded one. Returns the new agent id. (ReAct web knowledge + streaming
    /// progress are later sub-phases; this is the synchronous build + save.)
    func buildAndSaveDirector(description: String, roleTag: String = "director") async throws -> String {
        try? AgentSeed.seed(into: db)
        guard let built = await PersonaBuilder.buildFull(router: router, description: description) else {
            throw NSError(domain: "persona", code: 1, userInfo: [NSLocalizedDescriptionKey: "persona build failed (no model / unparseable)"])
        }
        let name = built.name?.name ?? "New Director"
        var handle = (built.name?.handle).flatMap { $0.isEmpty ? nil : $0 } ?? Self.deriveHandle(name)
        let instruction = PersonaBuilder.synthesizeInstruction(built, name: name, roleTag: roleTag, description: description)
        let bio = built.spec.contrarianTakes.first ?? String(description.prefix(200))
        let specJSON = PersonaBuilder.personaSpecJSONFull(built, description: description, generatedAt: Self.isoNow())
        let modelV = router.defaultModelV()?.rawValue ?? "sonnet-4-6"
        let id = UUID().uuidString
        try await db.pool.write { conn in
            // Uniquify the handle (the roster + history-prefix expect distinct @handles).
            if let n = try Int.fetchOne(conn, sql: "SELECT COUNT(*) FROM agents WHERE handle = ?", arguments: [handle]), n > 0 {
                handle = "\(handle)_\(id.prefix(4))"
            }
            let now = Int(Date().timeIntervalSince1970 * 1000)
            try conn.execute(sql: """
                INSERT INTO agents (id, name, handle, role_tag, role_kind, bio, cover_quote, instruction,
                                    model_v, avatar_path, persona_spec_json, is_seed, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'director', ?, '', ?, ?, '', ?, 0, ?, ?)
                """, arguments: [id, name, handle, roleTag, bio, instruction, modelV, specJSON, now, now])
        }
        return id
    }

    private static func deriveHandle(_ name: String) -> String {
        let slug = name.lowercased().unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "_" }
        var h = String(slug).replacingOccurrences(of: "__+", with: "_", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        if h.count > 16 { h = String(h.prefix(16)) }
        return h.isEmpty ? "director" : h
    }
    private static func isoNow() -> String {
        let f = ISO8601DateFormatter(); return f.string(from: Date())
    }

    /// Seeded directors as app `Agent`s (for the room-creation picker).
    func listDirectors() -> [Agent] {
        (try? db.pool.read { conn in
            try Row.fetchAll(conn, sql: """
                SELECT id, name, bio, avatar_path, role_tag, role_kind, instruction, model_v, handle, created_at, is_seed, avatar3d_json
                FROM agents WHERE role_kind = 'director' ORDER BY created_at
                """).map(Self.agent)
        }) ?? []
    }

    func chairAgent() -> Agent? {
        try? db.pool.read { conn in
            try Row.fetchOne(conn, sql: """
                SELECT id, name, bio, avatar_path, role_tag, role_kind, instruction, model_v, handle, created_at, is_seed, avatar3d_json
                FROM agents WHERE role_kind = 'moderator' LIMIT 1
                """).map(Self.agent)
        } ?? nil
    }

    private static func agent(_ r: Row) -> Agent {
        // The 捏脸 editor seeds from `avatar3d` · include it here so it's present the
        // moment the profile opens (not only after the detail fetch), and so seed
        // directors' editor matches their portrait.
        var avatar3d: Avatar3DConfig?
        if let raw: String = r["avatar3d_json"], let data = raw.data(using: .utf8) {
            avatar3d = try? JSONDecoder().decode(Avatar3DConfig.self, from: data)
        }
        return Agent(id: r["id"], name: r["name"], bio: r["bio"], avatarPath: r["avatar_path"],
              roleTag: r["role_tag"], roleKind: r["role_kind"], instruction: r["instruction"],
              modelV: r["model_v"], handle: r["handle"], avatar3d: avatar3d,
              createdAt: (r["created_at"] as Int?).map(Double.init),
              isSeed: (r["is_seed"] as Int?).map { $0 != 0 })
    }

    /// Store an LLM key for the native engine: a `llm_credentials` row + the
    /// `prefs.active_llm_credential_id` pointer (metadata in GRDB) and the raw
    /// key in the Keychain. `EngineCredentialSource` reads exactly this.
    func setLLMKey(provider: String, key: String) throws {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let id = "native-\(provider)"
        try db.pool.write { conn in
            try conn.execute(sql: """
                INSERT INTO llm_credentials (id, provider, label, key_blob, created_at, updated_at)
                VALUES (?, ?, ?, x'', ?, ?)
                ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
                """, arguments: [id, provider, provider, now, now])
            try conn.execute(sql: "UPDATE prefs SET active_llm_credential_id = ? WHERE id = 1", arguments: [id])
        }
        try KeychainCredentialStore().set(.llm, id: id, key: key)
    }

    /// The active LLM provider in the native DB, if configured (for display).
    func activeLLMProvider() -> String? {
        (try? db.pool.read { conn -> String? in
            guard let id = try String.fetchOne(conn, sql: "SELECT active_llm_credential_id FROM prefs WHERE id = 1") else { return nil }
            return try String.fetchOne(conn, sql: "SELECT provider FROM llm_credentials WHERE id = ?", arguments: [id])
        }) ?? nil
    }

    /// Store a voice (TTS) key · `voice_credentials` row + active pointer + Keychain.
    /// `EngineCredentialSource.voiceKey` reads this; voice rooms then speak.
    func setVoiceKey(provider: String, key: String) throws {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let id = "native-voice-\(provider)"
        try db.pool.write { conn in
            try conn.execute(sql: """
                INSERT INTO voice_credentials (id, provider, label, key_blob, created_at, updated_at)
                VALUES (?, ?, ?, x'', ?, ?)
                ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
                """, arguments: [id, provider, provider, now, now])
            try conn.execute(sql: "UPDATE prefs SET active_voice_credential_id = ? WHERE id = 1", arguments: [id])
        }
        try KeychainCredentialStore().set(.voice, id: id, key: key)
    }

    func activeVoiceProviderName() -> String? { Self.activeVoiceProvider(db)?.rawValue }

    /// Boot-time recovery — clears stuck clarify flags + finalizes orphaned
    /// streams left by a crash/kill (ports of recoverStuckClarifyRooms /
    /// cleanupOrphanedStreams). Call once on launch when the flag is on.
    func recoverOnBoot() async {
        // First-run seed · chair + director catalog (idempotent). Without this
        // the on-device GRDB is empty and the engine can't convene a room.
        try? AgentSeed.seed(into: db)
        _ = await store.recoverStuckClarifyRooms()
        _ = await store.cleanupOrphanedStreams()
        _ = await store.recoverRoomsMissingDirectors()   // re-seat director-less rooms (empty auto-pick / unsynced members)

        // Dream sweep (port of boot.ts) · per-agent adjourn counters reset on
        // restart, so an agent whose memory pile overflowed mid-cycle (process
        // crashed during a previous dream) never gets caught by the post-adjourn
        // trigger. Force-fire a dream for anyone over the role ceiling.
        let userName = await store.userDisplayName()
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        let agents = await store.agentsForSweep()
        for a in agents {
            let ceiling = a.isChair ? 50 : 80   // DREAM_BOOT_FORCE_CEILING chair/director
            if await store.countMemoriesForAgent(a.id) > ceiling {
                await Dream.runCycle(router: router, store: store, agentId: a.id, isChair: a.isChair,
                                     userName: userName, nowMs: nowMs, userLong: store, audit: store)
                await DreamCounter.shared.reset(agentId: a.id)
            }
        }
    }
}
