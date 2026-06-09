import Foundation
import GRDB
import Swifter
import BoardroomStorage
import BoardroomAI
import BoardroomVoice

/// Tiny 127.0.0.1 HTTP server for the on-device 3D stage (and, later, the report
/// renderer). `stage-embed.html` is loaded from this origin so its same-origin
/// imports (`/mobile/voice-3d-mobile.js`, `/vendor/three…`, `/avatars/models/*.glb`)
/// and its `fetch("/api/rooms/:id")` all resolve with NO real server — the plan's
/// option (a). Static files come from the bundled `web/` folder; `/api/rooms/:id`
/// + `/api/agents` are served from the engine's GRDB. Binds an ephemeral port
/// (never hardcoded) so multiple instances don't clash.
final class LoopbackServer {
    private let server = HttpServer()
    let db: BoardroomDB   // `internal` · the CredentialReconcile extension (separate file) reads it
    private let webRoot: URL
    private(set) var port: in_port_t = 0
    // MiniMax voice catalog cache (5-min TTL) · the picker re-opens shouldn't
    // re-hit /v1/get_voice every time. Identity = region + FULL-key hash, NOT a
    // key prefix: MiniMax keys are JWTs that all share the same `eyJhbGci…`
    // header, so a prefix collides across the china/global keys → switching keys
    // would keep serving the prior region's stale list (and previews then 404).
    private let voicesLock = NSLock()
    private var minimaxVoiceCache: (identity: String, at: Date, voices: [[String: Any]])?

    /// `http://127.0.0.1:<port>` once started, else nil.
    var baseURL: URL? { port == 0 ? nil : URL(string: "http://127.0.0.1:\(port)") }

    init?(db: BoardroomDB) {
        self.db = db
        // The folder reference lands at <bundle>/web.
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("web", isDirectory: true) else { return nil }
        webRoot = root
        routes()
    }

    func start() {
        guard port == 0 else { return }
        // Try an ephemeral port; Swifter picks the bound port via `self.port`.
        do {
            try server.start(0, forceIPv4: true)   // 0 → OS assigns a free port
            port = in_port_t((try? server.port()) ?? 0)
        } catch { port = 0 }
    }

    func stop() { server.stop(); port = 0 }

    /// Re-bind the listening socket. iOS closes the server's socket while the app
    /// is suspended; on resume `accept()` is dead and EVERY loopback request fails
    /// — the symptom is all director avatars going blank AND the API-keys list
    /// reading empty (both are loopback-served) until an app restart. Prefers the
    /// prior port so `app.backend`'s baseURL stays valid; falls back to a fresh
    /// ephemeral port if that one's momentarily still held (the caller re-points
    /// the backend in that case).
    func restart() {
        let prev = port
        server.stop(); port = 0
        func bind(_ p: in_port_t) -> Bool {
            do { try server.start(p, forceIPv4: true); port = in_port_t((try? server.port()) ?? 0); return port != 0 }
            catch { return false }
        }
        if prev != 0, bind(prev) { return }
        _ = bind(0)
    }

    /// Quick liveness probe · a short GET to a known route. `false` ⇒ the socket
    /// is dead and `restart()` is needed. Runs off any context (URLSession).
    func isHealthy() async -> Bool {
        guard let url = baseURL?.appendingPathComponent("api/agents") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1.5
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            return (resp as? HTTPURLResponse)?.statusCode == 200
        } catch { return false }
    }

    // MARK: routes

    private func routes() {
        // API routes FIRST (literal segments) so they aren't shadowed by the
        // generic static wildcards below.
        // GET /api/rooms/:id → room snapshot the stage self-boots from.
        server.GET["/api/rooms/:id"] = { [weak self] req in
            guard let self, let id = req.params[":id"] else { return .notFound }
            return Self.jsonResponse(self.roomSnapshot(id))
        }
        // PATCH /api/rooms/:id → tone / intensity / delivery edits (RoomSettings).
        server.PATCH["/api/rooms/:id"] = { [weak self] req in
            guard let self, let id = req.params[":id"] else { return .notFound }
            return self.patchRoom(id, req)
        }
        // PATCH /api/rooms/:id/members → set the director cast (diff add/remove).
        server.PATCH["/api/rooms/:id/members"] = { [weak self] req in
            guard let self, let id = req.params[":id"] else { return .notFound }
            return self.patchRoomMembers(id, req)
        }
        // DELETE /api/rooms/:id → drop the room. Foreign keys are ON, so the row
        // delete cascades to room_members / messages / key_points / briefs (all
        // ON DELETE CASCADE). Without this route api.deleteRoom 404s and the room
        // only vanishes from the in-memory list — it returns on next launch.
        server.DELETE["/api/rooms/:id"] = { [weak self] req in
            guard let self, let id = req.params[":id"] else { return .notFound }
            try? self.db.pool.write { conn in
                try conn.execute(sql: "DELETE FROM rooms WHERE id = ?", arguments: [id])
            }
            return Self.jsonResponse(["ok": true])
        }
        // GET /api/agents → { chair } fallback the embed uses when no member is the chair.
        server.GET["/api/agents"] = { [weak self] _ in
            guard let self else { return .notFound }
            var obj: [String: Any] = [:]
            if let chair = self.chairDict() { obj["chair"] = chair }
            return Self.jsonResponse(obj)
        }
        // POST /api/agents → create a director (new-director flow).
        server.POST["/api/agents"] = { [weak self] req in self?.createAgent(req) ?? .notFound }
        // GET /api/briefs/:id → the closing brief report.html renders by spine.
        server.GET["/api/briefs/:id"] = { [weak self] req in
            guard let self, let id = req.params[":id"] else { return .notFound }
            return Self.jsonResponse(self.briefSnapshot(id))
        }

        // Credential families · the API-key hub (ApiKeysView / AddKeyView) is
        // reused verbatim and hits these against the on-device GRDB + Keychain.
        // (provider/label/active metadata in GRDB; the raw key in the Keychain.)
        credentialRoutes("/api/credentials", .llm, "llm_credentials", "active_llm_credential_id")
        credentialRoutes("/api/voice-credentials", .voice, "voice_credentials", "active_voice_credential_id")
        credentialRoutes("/api/search-credentials", .search, "search_credentials", "active_search_credential_id")

        // Model catalog · the director model picker (AgentProfileView / NewRoom)
        // reads reachability under the active LLM carrier (e.g. B.AI).
        server.GET["/api/models"] = { [weak self] _ in
            guard let self else { return .notFound }
            return Self.jsonResponse(self.modelsResponse())
        }

        // GET /api/usage/summary → cumulative LLM-call accounting (1:1 port of
        // src/routes/usage.ts · getUsageSummary + getDailyUsage). Aggregated from
        // agents.tokens_consumed + usage_daily + retired_token_usage in GRDB.
        server.GET["/api/usage/summary"] = { [weak self] _ in
            guard let self else { return .notFound }
            return Self.jsonResponse(self.usageSummary())
        }

        // Director profile · view / stats / memories / edit / delete (GRDB).
        server.GET["/api/agents/:id"] = { [weak self] req in
            guard let self, let id = req.params[":id"], let a = self.agentJSON(id) else { return .notFound }
            return Self.jsonResponse(a)
        }
        server.GET["/api/agents/:id/stats"] = { [weak self] req in
            guard let self, let id = req.params[":id"] else { return .notFound }
            return Self.jsonResponse(self.agentStats(id))
        }
        server.GET["/api/agents/:id/memories"] = { [weak self] req in
            guard let self, let id = req.params[":id"] else { return .notFound }
            return Self.jsonResponse(["memories": self.listMemories(id)])
        }
        server.POST["/api/agents/:id/memories"] = { [weak self] req in
            guard let self, let id = req.params[":id"] else { return .notFound }
            return self.addMemory(id, req)
        }
        server.DELETE["/api/agents/:id/memories/:mid"] = { [weak self] req in
            guard let self, let mid = req.params[":mid"] else { return .notFound }
            try? self.db.pool.write { try $0.execute(sql: "DELETE FROM agent_memories WHERE id = ?", arguments: [mid]) }
            return Self.jsonResponse(["ok": true])
        }
        server.PATCH["/api/agents/:id"] = { [weak self] req in
            guard let self, let id = req.params[":id"] else { return .notFound }
            return self.patchAgent(id, req)
        }
        server.DELETE["/api/agents/:id"] = { [weak self] req in
            guard let self, let id = req.params[":id"] else { return .notFound }
            try? self.db.pool.write { conn in
                try conn.execute(sql: "DELETE FROM room_members WHERE agent_id = ?", arguments: [id])
                try conn.execute(sql: "DELETE FROM agents WHERE id = ?", arguments: [id])
            }
            return Self.jsonResponse(["ok": true])
        }

        // GET /api/voices → the active provider's system-voice catalog (ported
        // from src/voice/registry.ts · MiniMax / ElevenLabs / OpenAI seed lists).
        // Preview (POST /api/voices/preview) is not served on-device yet, so the
        // picker lists voices but auditioning is a no-op until that lands.
        server.GET["/api/voices"] = { [weak self] _ in
            guard let self else { return .notFound }
            let provider: String? = (try? self.db.pool.read { conn -> String? in
                guard let cid = try String.fetchOne(conn, sql: "SELECT active_voice_credential_id FROM prefs WHERE id = 1") else { return nil }
                return try String.fetchOne(conn, sql: "SELECT provider FROM voice_credentials WHERE id = ?", arguments: [cid])
            }) ?? nil
            // MiniMax · pull the FULL live catalog with the active key (system +
            // cloned + generated), like the desktop /v1/get_voice fetch. Others
            // use the static seed lists. Failure falls back to the seed set.
            let voices: [[String: Any]]
            if provider == "minimax", let key = self.activeVoiceKey() {
                voices = self.miniMaxVoices(key: key)
            } else {
                voices = Self.voiceCatalog(provider)
            }
            return Self.jsonResponse(["voices": voices, "provider": provider as Any, "configured": !voices.isEmpty])
        }
        // POST /api/voices/preview → synthesize a short sample with the active key.
        server.POST["/api/voices/preview"] = { [weak self] req in self?.voicePreview(req) ?? .notFound }
        // POST /api/voice-clone → clone the director's voice from an audio sample
        // (MiniMax / ElevenLabs), patch the agent's voice, return the new voiceId.
        server.POST["/api/voice-clone"] = { [weak self] req in self?.voiceClone(req) ?? .notFound }

        // Static files via the not-found handler · NOT generic `/:p1/:p2/…`
        // wildcard routes: those SHADOW the `/api/*` literal routes above (Swifter
        // matched `/api/rooms/<id>` against `/:p1/:p2/:p3` → 404, so the stage's
        // fetch returned no members → only floor + table rendered, no avatars).
        // With the not-found handler the literal `/api` routes win and everything
        // else (js / glb / html) falls through to the static server.
        server.notFoundHandler = { [weak self] req in self?.staticHandler(req) ?? .notFound }
    }

    private static func jsonResponse(_ obj: Any) -> HttpResponse {
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return .internalServerError }
        return .raw(200, "OK", ["Content-Type": "application/json"]) { try $0.write(data) }
    }

    private func staticHandler(_ req: HttpRequest) -> HttpResponse {
        // Reconstruct the path under webRoot from the matched components.
        let rel = req.path.split(separator: "?").first.map(String.init) ?? req.path
        let fileURL = webRoot.appendingPathComponent(rel.hasPrefix("/") ? String(rel.dropFirst()) : rel)
        guard let data = try? Data(contentsOf: fileURL) else { return .notFound }
        let mime = Self.mime(for: fileURL.pathExtension)
        return .raw(200, "OK", ["Content-Type": mime]) { try $0.write(data) }
    }

    // MARK: Credential families (LLM / voice / search)

    /// Register GET (list) · POST (create+activate) · PUT /active · DELETE /:id
    /// for one credential family, mirroring the desktop `CRED_API` JSON so the
    /// reused `ApiKeysView` needs no changes.
    private func credentialRoutes(_ base: String, _ kind: CredentialKind, _ table: String, _ prefsCol: String) {
        server.GET[base] = { [weak self] _ in
            guard let self else { return .notFound }
            return Self.jsonResponse(self.listCreds(table, prefsCol, kind))
        }
        server.POST[base] = { [weak self] req in
            self?.createCred(req, table, prefsCol, kind) ?? .notFound
        }
        server.PUT[base + "/active"] = { [weak self] req in
            self?.setActiveCred(req, prefsCol, kind) ?? .notFound
        }
        server.DELETE[base + "/:id"] = { [weak self] req in
            self?.deleteCred(req, table, prefsCol, kind) ?? .notFound
        }
    }

    private func listCreds(_ table: String, _ prefsCol: String, _ kind: CredentialKind) -> [String: Any] {
        let ks = KeychainCredentialStore()
        let active: String? = (try? db.pool.read { try String.fetchOne($0, sql: "SELECT \(prefsCol) FROM prefs WHERE id = 1") }) ?? nil
        let rows: [[String: Any]] = (try? db.pool.read { conn in
            try Row.fetchAll(conn, sql: "SELECT id, provider, label FROM \(table) ORDER BY created_at").map { r -> [String: Any] in
                let id = r["id"] as String? ?? ""
                return [
                    "id": id,
                    "provider": r["provider"] as String? ?? "",
                    "label": r["label"] as String? as Any,
                    "preview": ks.key(kind, id: id).map(Self.mask) ?? "•••",
                    "isActive": id == active,
                ]
            }
        }) ?? []
        return ["credentials": rows, "activeId": active as Any]
    }

    private func createCred(_ req: HttpRequest, _ table: String, _ prefsCol: String, _ kind: CredentialKind) -> HttpResponse {
        guard let body = try? JSONSerialization.jsonObject(with: Data(req.body)) as? [String: Any],
              let provider = (body["provider"] as? String), !provider.isEmpty,
              let key = (body["key"] as? String)?.trimmingCharacters(in: .whitespaces), !key.isEmpty
        else { return .badRequest(nil) }
        let label = (body["label"] as? String)?.trimmingCharacters(in: .whitespaces)
        let id = UUID().uuidString
        let now = Int(Date().timeIntervalSince1970 * 1000)
        var becameActive = false
        do {
            try db.pool.write { conn in
                try conn.execute(sql: "INSERT INTO \(table) (id, provider, label, key_blob, created_at, updated_at) VALUES (?,?,?,x'',?,?)",
                                 arguments: [id, provider, (label?.isEmpty == false ? label! : provider), now, now])
                // SIM-swap parity (desktop) · only the FIRST key of a family auto-
                // activates. Later keys are added but require an explicit set-active
                // to switch — that switch is what snapshots + restores the buckets.
                let hadActive = ((try String.fetchOne(conn, sql: "SELECT \(prefsCol) FROM prefs WHERE id = 1")) ?? nil) != nil
                if !hadActive {
                    try conn.execute(sql: "UPDATE prefs SET \(prefsCol) = ? WHERE id = 1", arguments: [id])
                    becameActive = true
                }
                // MiniMax · persist the chosen host region globally (cn → api.minimaxi.com,
                // intl → api.minimax.io) so TTS + the voice catalog hit the right host.
                if provider == "minimax", let region = body["region"] as? String, region == "cn" || region == "intl" {
                    try conn.execute(sql: "UPDATE prefs SET minimax_region = ? WHERE id = 1", arguments: [region])
                }
            }
            try KeychainCredentialStore().set(kind, id: id, key: key)
        } catch { return .internalServerError }
        // First key just became active · seed the buckets + reachable picks.
        if becameActive {
            switch kind {
            case .llm:   reconcileAgentModels(priorCarrier: nil)
            case .voice: reconcileAgentVoices(reason: .firstKey, priorProvider: nil)
            case .search: break
            }
        }
        return Self.jsonResponse(["ok": true, "id": id, "active": becameActive])
    }

    private func setActiveCred(_ req: HttpRequest, _ prefsCol: String, _ kind: CredentialKind) -> HttpResponse {
        guard let body = try? JSONSerialization.jsonObject(with: Data(req.body)) as? [String: Any],
              let id = body["id"] as? String else { return .badRequest(nil) }
        // SIM-swap memory · capture the prior active carrier / voice provider BEFORE
        // flipping prefs so the reconcile can snapshot every agent's current config
        // into bucket[prior] before restoring bucket[new].
        let priorCarrier = (kind == .llm) ? activeLLMCarrier() : nil
        let priorVoice = (kind == .voice) ? activeVoiceProviderString() : nil
        do { try db.pool.write { try $0.execute(sql: "UPDATE prefs SET \(prefsCol) = ? WHERE id = 1", arguments: [id]) } }
        catch { return .internalServerError }
        switch kind {
        case .llm:
            reconcileAgentModels(priorCarrier: priorCarrier)
        case .voice:
            // Same-provider key rotation doesn't reshuffle voices (ids are stable).
            if priorVoice != activeVoiceProviderString() {
                reconcileAgentVoices(reason: .providerSwitch, priorProvider: priorVoice)
            }
        case .search:
            break
        }
        return Self.jsonResponse(["ok": true])
    }

    private func deleteCred(_ req: HttpRequest, _ table: String, _ prefsCol: String, _ kind: CredentialKind) -> HttpResponse {
        guard let id = req.params[":id"] else { return .badRequest(nil) }
        var rotated = false
        var priorProvider: String?    // the removed (was-active) provider · the bucket key to snapshot into
        do {
            try db.pool.write { conn in
                let wasActive = ((try String.fetchOne(conn, sql: "SELECT \(prefsCol) FROM prefs WHERE id = 1")) ?? nil) == id
                if wasActive {
                    priorProvider = (try String.fetchOne(conn, sql: "SELECT provider FROM \(table) WHERE id = ?", arguments: [id])) ?? nil
                }
                try conn.execute(sql: "DELETE FROM \(table) WHERE id = ?", arguments: [id])
                if wasActive {
                    // Rotate to the next surviving key of this family (oldest first);
                    // nil → clears active (reconcile-to-none). Then reconcile so agent
                    // configs snapshot into the removed provider's bucket + restore.
                    let next = (try String.fetchOne(conn, sql: "SELECT id FROM \(table) ORDER BY created_at LIMIT 1")) ?? nil
                    try conn.execute(sql: "UPDATE prefs SET \(prefsCol) = ? WHERE id = 1", arguments: [next])
                    rotated = true
                }
            }
            try? KeychainCredentialStore().delete(kind, id: id)
        } catch { return .internalServerError }
        if rotated {
            switch kind {
            case .llm:   reconcileAgentModels(priorCarrier: priorProvider.flatMap(LLMCarrier.init(rawValue:)))
            case .voice: reconcileAgentVoices(reason: .providerSwitch, priorProvider: priorProvider)
            case .search: break
            }
        }
        return Self.jsonResponse(["ok": true])
    }

    private static func mask(_ k: String) -> String {
        let t = k.trimmingCharacters(in: .whitespaces)
        guard t.count > 9 else { return "•••" }
        return "\(t.prefix(5))…\(t.suffix(4))"
    }

    // MARK: Models + agents

    /// `{ models:[{modelV,displayName,provider,deck,reachable}], hasAnyKey }` ·
    /// reachability resolved under the active LLM carrier (Registry + Availability).
    private func modelsResponse() -> [String: Any] {
        let providerStr: String? = (try? db.pool.read { conn -> String? in
            guard let cid = try String.fetchOne(conn, sql: "SELECT active_llm_credential_id FROM prefs WHERE id = 1") else { return nil }
            return try String.fetchOne(conn, sql: "SELECT provider FROM llm_credentials WHERE id = ?", arguments: [cid])
        }) ?? nil
        let carrier = providerStr.flatMap(LLMCarrier.init(rawValue:))
        let models = Availability.all(active: carrier).map { m -> [String: Any] in
            ["modelV": m.modelV.rawValue, "displayName": m.displayName,
             "provider": m.provider.rawValue, "deck": m.deck, "reachable": m.reachable]
        }
        let hasAnyKey = (try? db.pool.read { try Int.fetchOne($0, sql: "SELECT COUNT(*) FROM llm_credentials") }) ?? 0
        return ["models": models, "hasAnyKey": (hasAnyKey ?? 0) > 0]
    }

    // MARK: Usage accounting (port of src/routes/usage.ts)

    /// displayName + provider for a `modelV`, falling back to the raw id +
    /// "unknown" for retired / dropped model slugs (so they stay visible).
    private static func modelDisplay(_ modelV: String) -> (displayName: String, provider: String) {
        if let m = Registry.meta(id: modelV) { return (m.displayName, m.provider.rawValue) }
        return (modelV, "unknown")
    }

    /// `{ totalTokens, agentCount, byModel[], byAgent[], retired{}, daily[] }` —
    /// live agents (agents.tokens_consumed) + retired rollup, merged by model,
    /// plus the rolling 14-day window. Mirrors `getUsageSummary()`.
    private func usageSummary() -> [String: Any] {
        let empty: [String: Any] = ["totalTokens": 0, "agentCount": 0, "byModel": [], "byAgent": [],
                                    "retired": ["tokens": 0, "agents": 0, "byModel": []], "daily": []]
        return (try? db.pool.read { conn -> [String: Any] in
            let agentRows = try Row.fetchAll(conn, sql: """
                SELECT id, name, handle, model_v, role_kind, tokens_consumed
                FROM agents ORDER BY tokens_consumed DESC, created_at ASC
                """)
            var liveTokens = 0
            var modelLive: [String: (tokens: Int, agents: Int)] = [:]
            var byAgent: [[String: Any]] = []
            for r in agentRows {
                let tokens = r["tokens_consumed"] as Int? ?? 0
                let modelV = r["model_v"] as String? ?? ""
                liveTokens += tokens
                var cur = modelLive[modelV] ?? (0, 0); cur.tokens += tokens; cur.agents += 1; modelLive[modelV] = cur
                let d = Self.modelDisplay(modelV)
                byAgent.append([
                    "id": r["id"] as String? ?? "", "name": r["name"] as String? ?? "",
                    "handle": r["handle"] as String? ?? "", "modelV": modelV,
                    "roleKind": (r["role_kind"] as String? == "moderator") ? "moderator" : "director",
                    "tokens": tokens, "displayName": d.displayName, "provider": d.provider,
                ])
            }
            // Retired rollup · folds into byModel totals; never back into byAgent.
            var merged = modelLive
            var retiredTokens = 0, retiredAgents = 0
            var retiredRaw: [(modelV: String, tokens: Int, agents: Int)] = []
            for r in try Row.fetchAll(conn, sql: "SELECT model_v, tokens, agents FROM retired_token_usage") {
                let tokens = r["tokens"] as Int? ?? 0
                guard tokens > 0 else { continue }
                let modelV = r["model_v"] as String? ?? ""
                let agents = r["agents"] as Int? ?? 0
                retiredTokens += tokens; retiredAgents += agents
                retiredRaw.append((modelV, tokens, agents))
                var cur = merged[modelV] ?? (0, 0); cur.tokens += tokens; cur.agents += agents; merged[modelV] = cur
            }
            func enrichModel(_ modelV: String, _ tokens: Int, _ agents: Int) -> [String: Any] {
                let d = Self.modelDisplay(modelV)
                return ["modelV": modelV, "tokens": tokens, "agents": agents, "displayName": d.displayName, "provider": d.provider]
            }
            let byModel = merged.map { ($0.key, $0.value) }.sorted { $0.1.tokens > $1.1.tokens }
                .map { enrichModel($0.0, $0.1.tokens, $0.1.agents) }
            let retiredByModel = retiredRaw.sorted { $0.tokens > $1.tokens }.map { enrichModel($0.modelV, $0.tokens, $0.agents) }
            return [
                "totalTokens": liveTokens + retiredTokens,
                "agentCount": agentRows.count,
                "byModel": byModel,
                "byAgent": byAgent,
                "retired": ["tokens": retiredTokens, "agents": retiredAgents, "byModel": retiredByModel],
                "daily": self.dailyUsage(conn, days: 14),
            ]
        }) ?? empty
    }

    /// Rolling N-day window from `usage_daily`, zero-filled, oldest → newest, with
    /// per-day model + agent rollups. Mirrors `getDailyUsage(days)`.
    private func dailyUsage(_ conn: Database, days: Int) -> [[String: Any]] {
        let cal = Calendar.current
        let fmt = DateFormatter()
        fmt.calendar = cal; fmt.locale = Locale(identifier: "en_US_POSIX"); fmt.timeZone = cal.timeZone
        fmt.dateFormat = "yyyy-MM-dd"
        let today = Date()
        var order: [String] = []
        for i in stride(from: days - 1, through: 0, by: -1) {
            if let d = cal.date(byAdding: .day, value: -i, to: today) { order.append(fmt.string(from: d)) }
        }
        guard let earliest = order.first else { return [] }
        let orderSet = Set(order)
        var modelBuckets: [String: [String: (tokens: Int, agents: Set<String>)]] = [:]
        var agentBuckets: [String: [String: (name: String, handle: String, modelV: String, roleKind: String, tokens: Int)]] = [:]
        let rows = (try? Row.fetchAll(conn, sql: """
            SELECT u.day AS day, u.agent_id AS agentId, u.model_v AS modelV, u.tokens AS tokens,
                   a.name AS name, a.handle AS handle, a.role_kind AS roleKind
            FROM usage_daily u LEFT JOIN agents a ON a.id = u.agent_id
            WHERE u.day >= ? ORDER BY u.day ASC
            """, arguments: [earliest])) ?? []
        for r in rows {
            let day = r["day"] as String? ?? ""
            guard orderSet.contains(day) else { continue }
            let modelV = r["modelV"] as String? ?? ""
            let agentId = r["agentId"] as String? ?? ""
            let tokens = r["tokens"] as Int? ?? 0
            var mb = modelBuckets[day] ?? [:]
            var me = mb[modelV] ?? (0, Set<String>()); me.tokens += tokens; me.agents.insert(agentId); mb[modelV] = me; modelBuckets[day] = mb
            var ab = agentBuckets[day] ?? [:]
            var ae = ab[agentId] ?? (r["name"] as String? ?? "(retired)", r["handle"] as String? ?? "",
                                     modelV, (r["roleKind"] as String? == "moderator") ? "moderator" : "director", 0)
            ae.tokens += tokens; ab[agentId] = ae; agentBuckets[day] = ab
        }
        return order.map { day -> [String: Any] in
            var byModel: [[String: Any]] = []
            var total = 0
            if let mb = modelBuckets[day] {
                byModel = mb.map { ($0.key, $0.value) }.sorted { $0.1.tokens > $1.1.tokens }.map { e -> [String: Any] in
                    let d = Self.modelDisplay(e.0)
                    return ["modelV": e.0, "tokens": e.1.tokens, "agents": e.1.agents.count, "displayName": d.displayName, "provider": d.provider]
                }
                total = byModel.reduce(0) { $0 + (($1["tokens"] as? Int) ?? 0) }
            }
            var byAgent: [[String: Any]] = []
            if let ab = agentBuckets[day] {
                byAgent = ab.map { ($0.key, $0.value) }.sorted { $0.1.tokens > $1.1.tokens }.map { e -> [String: Any] in
                    let d = Self.modelDisplay(e.1.modelV)
                    return ["id": e.0, "name": e.1.name, "handle": e.1.handle, "modelV": e.1.modelV,
                            "roleKind": e.1.roleKind, "tokens": e.1.tokens, "displayName": d.displayName, "provider": d.provider]
                }
            }
            return ["day": day, "totalTokens": total, "byModel": byModel, "byAgent": byAgent]
        }
    }

    /// Full agent record for the profile route (tolerant decode on the client).
    private func agentJSON(_ id: String) -> [String: Any]? {
        try? db.pool.read { conn -> [String: Any]? in
            guard let r = try Row.fetchOne(conn, sql: """
                SELECT id, name, bio, avatar_path, role_tag, role_kind, instruction, model_v, handle,
                       cover_quote, web_search_enabled, user_rules_json, avatar3d_json, voice_json, persona_spec_json,
                       ability_json, is_seed
                FROM agents WHERE id = ?
                """, arguments: [id]) else { return nil }
            var d: [String: Any] = [
                "id": r["id"] as String? ?? id,
                "name": r["name"] as String? ?? "",
                "bio": r["bio"] as String? as Any,
                "avatarPath": r["avatar_path"] as String? as Any,
                "roleTag": r["role_tag"] as String? as Any,
                "roleKind": r["role_kind"] as String? as Any,
                "instruction": r["instruction"] as String? as Any,
                "modelV": r["model_v"] as String? as Any,
                "handle": r["handle"] as String? as Any,
                "coverQuote": r["cover_quote"] as String? as Any,
                "webSearchEnabled": (r["web_search_enabled"] as Int? ?? 1) != 0,
            ]
            if let rules: String = r["user_rules_json"], let data = rules.data(using: .utf8),
               let arr = try? JSONSerialization.jsonObject(with: data) as? [String] { d["userRules"] = arr }
            if let a3: String = r["avatar3d_json"], let data = a3.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) { d["avatar3d"] = obj }
            if let vj: String = r["voice_json"], let data = vj.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { d["voice"] = obj }
            // Full-persona dossier · parse the stored spec blob so the profile can
            // render the Persona dossier module (signal/seed directors have NULL here).
            if let ps: String = r["persona_spec_json"], let data = ps.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { d["personaSpec"] = obj }
            // Ability radar · the profile chart decodes `ability` into a per-axis
            // dict. Without this the iOS radar fell back to a flat 5/all and every
            // director looked identical (the data was in `ability_json` all along).
            if let ab: String = r["ability_json"], let data = ab.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], !obj.isEmpty {
                d["ability"] = obj
            }
            // is_seed · the profile gates rename (built-in directors keep their name).
            d["isSeed"] = (r["is_seed"] as Int? ?? 1) != 0
            return d
        } ?? nil
    }

    /// `{ roomsJoined, roundsSpoken, tokensConsumed }` · rooms from membership;
    /// rounds/tokens best-effort (0 when the column/shape isn't present).
    private func agentStats(_ id: String) -> [String: Any] {
        let rooms = (try? db.pool.read { try Int.fetchOne($0, sql:
            "SELECT COUNT(DISTINCT room_id) FROM room_members WHERE agent_id = ?", arguments: [id]) }) ?? 0
        let rounds = (try? db.pool.read { try Int.fetchOne($0, sql:
            "SELECT COUNT(DISTINCT round_num) FROM messages WHERE author_id = ?", arguments: [id]) }) ?? 0
        return ["roomsJoined": rooms ?? 0, "roundsSpoken": rounds ?? 0, "tokensConsumed": 0]
    }

    private func listMemories(_ agentId: String) -> [[String: Any]] {
        (try? db.pool.read { conn in
            try Row.fetchAll(conn, sql:
                "SELECT id, content, pinned FROM agent_memories WHERE agent_id = ? ORDER BY pinned DESC, created_at DESC",
                arguments: [agentId]).map { r -> [String: Any] in
                ["id": r["id"] as String? ?? "", "content": r["content"] as String? ?? "",
                 "pinned": (r["pinned"] as Int? ?? 0) != 0]
            }
        }) ?? []
    }

    private func addMemory(_ agentId: String, _ req: HttpRequest) -> HttpResponse {
        guard let body = try? JSONSerialization.jsonObject(with: Data(req.body)) as? [String: Any],
              let content = (body["content"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !content.isEmpty
        else { return .badRequest(nil) }
        let id = UUID().uuidString
        let kind = (body["kind"] as? String) ?? "fact"
        let now = Int(Date().timeIntervalSince1970 * 1000)
        do {
            try db.pool.write { conn in
                try conn.execute(sql: """
                    INSERT INTO agent_memories (id, agent_id, content, kind, source, confidence, pinned, created_at, updated_at)
                    VALUES (?, ?, ?, ?, 'user_added', 0.9, 0, ?, ?)
                    """, arguments: [id, agentId, content, kind, now, now])
            }
        } catch { return .internalServerError }
        return Self.jsonResponse(["id": id, "content": content, "pinned": false])
    }

    private func patchAgent(_ id: String, _ req: HttpRequest) -> HttpResponse {
        guard let body = try? JSONSerialization.jsonObject(with: Data(req.body)) as? [String: Any] else { return .badRequest(nil) }
        // JSON key → column whitelist (only columns we know exist in the schema).
        let map: [(String, String)] = [
            ("name", "name"), ("bio", "bio"), ("roleTag", "role_tag"), ("instruction", "instruction"),
            ("modelV", "model_v"), ("coverQuote", "cover_quote"), ("avatarPath", "avatar_path"),
        ]
        var sets: [String] = [], args: [DatabaseValueConvertible] = []
        for (k, col) in map where body[k] is String {
            sets.append("\(col) = ?"); args.append(body[k] as! String)
        }
        if let ws = body["webSearchEnabled"] as? Bool { sets.append("web_search_enabled = ?"); args.append(ws ? 1 : 0) }
        if let rules = body["userRules"] as? [String], let data = try? JSONSerialization.data(withJSONObject: rules) {
            sets.append("user_rules_json = ?"); args.append(String(data: data, encoding: .utf8) ?? "[]")
        }
        if let a3 = body["avatar3d"], let data = try? JSONSerialization.data(withJSONObject: a3) {
            sets.append("avatar3d_json = ?"); args.append(String(data: data, encoding: .utf8) ?? "")
        }
        if let v = body["voice"] as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: v) {
            sets.append("voice_json = ?"); args.append(String(data: data, encoding: .utf8) ?? "")
        }
        if !sets.isEmpty {
            sets.append("updated_at = ?"); args.append(Int(Date().timeIntervalSince1970 * 1000))
            args.append(id)
            try? db.pool.write { try $0.execute(sql: "UPDATE agents SET \(sets.joined(separator: ", ")) WHERE id = ?", arguments: StatementArguments(args)) }
        }
        // SIM-swap memory · mirror the user's manual pick into the per-provider
        // bucket (model keyed by the active LLM carrier · voice by its own provider)
        // so a later credential switch restores it instead of blanking.
        if let mv = body["modelV"] as? String, !mv.isEmpty, let carrier = activeLLMCarrier() {
            try? db.pool.write { conn in try writeModelBucketEntry(conn, id, carrier, mv) }
        }
        if let v = body["voice"] as? [String: Any], let prov = v["provider"] as? String,
           prov == "minimax" || prov == "elevenlabs" {
            try? db.pool.write { conn in try writeVoiceBucketEntry(conn, id, prov, v) }
        }
        return Self.jsonResponse(agentJSON(id) ?? ["id": id])
    }

    /// Insert a new director (new-director flow · POST /api/agents).
    private func createAgent(_ req: HttpRequest) -> HttpResponse {
        guard let body = try? JSONSerialization.jsonObject(with: Data(req.body)) as? [String: Any],
              let name = (body["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty
        else { return .badRequest(nil) }
        let id = UUID().uuidString
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let modelV = (body["modelV"] as? String) ?? "sonnet-4-6"
        let roleTag = (body["roleTag"] as? String) ?? ""
        let bio = (body["bio"] as? String) ?? ""
        let instruction = (body["instruction"] as? String) ?? ""
        let avatarPath = (body["avatarPath"] as? String) ?? ""
        do {
            try db.pool.write { conn in
                let handle = try Self.uniqueHandle(conn, from: name)
                try conn.execute(sql: """
                    INSERT INTO agents (id, name, handle, role_tag, bio, cover_quote, instruction, model_v, avatar_path,
                                        role_kind, is_pinned, is_seed, created_at, updated_at)
                    VALUES (?,?,?,?,?,NULL,?,?,?, 'director', 0, 0, ?, ?)
                    """, arguments: [id, name, handle, roleTag, bio, instruction, modelV, avatarPath, now, now])
                if let a3 = body["avatar3d"], let data = try? JSONSerialization.data(withJSONObject: a3),
                   let s = String(data: data, encoding: .utf8) {
                    try conn.execute(sql: "UPDATE agents SET avatar3d_json = ? WHERE id = ?", arguments: [s, id])
                }
            }
        } catch { return .internalServerError }
        return Self.jsonResponse(["id": id])
    }

    /// A unique `@handle` from a display name (lowercased, alnum only) · appends a
    /// numeric suffix on collision (the column is UNIQUE NOT NULL).
    private static func uniqueHandle(_ conn: Database, from name: String) throws -> String {
        let base = name.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(String.init).joined()
        let stem = base.isEmpty ? "director" : base
        var handle = stem, n = 1
        while (try Int.fetchOne(conn, sql: "SELECT COUNT(*) FROM agents WHERE handle = ?", arguments: [handle]) ?? 0) > 0 {
            n += 1; handle = "\(stem)\(n)"
        }
        return handle
    }

    /// System-voice catalog for the active provider (port of registry.ts seed
    /// lists). `configured: true` since the picker only shows the active key's
    /// provider. Empty when no voice key is set.
    static func voiceCatalog(_ provider: String?) -> [[String: Any]] {
        func v(_ p: String, _ model: String, _ id: String, _ label: String, _ lang: String?) -> [String: Any] {
            var d: [String: Any] = ["provider": p, "model": model, "voiceId": id, "label": label, "configured": true]
            if let lang { d["language"] = lang }
            return d
        }
        switch provider {
        case "minimax":
            return [
                v("minimax", "speech-2.8-hd", "male-qn-qingse", "青涩青年", "zh"),
                v("minimax", "speech-2.8-hd", "female-shaonv", "少女", "zh"),
                v("minimax", "speech-2.8-hd", "female-yujie", "御姐", "zh"),
                v("minimax", "speech-2.8-hd", "male-qn-jingying", "精英青年", "zh"),
                v("minimax", "speech-2.8-hd", "female-chengshu", "成熟女性", "zh"),
                v("minimax", "speech-2.8-hd", "female-tianmei", "甜美女性", "zh"),
            ]
        case "elevenlabs":
            return [
                v("elevenlabs", "eleven_multilingual_v2", "21m00Tcm4TlvDq8ikWAM", "Rachel", "en"),
                v("elevenlabs", "eleven_multilingual_v2", "JBFqnCBsd6RMkjVDRZzb", "George", "en"),
            ]
        case "openai":
            return ["marin", "cedar", "alloy", "nova", "onyx", "shimmer"].map {
                v("openai", "gpt-4o-mini-tts", $0, $0.capitalized, nil)
            }
        default:
            return []
        }
    }

    /// Raw key for the active voice credential (Keychain).
    private func activeVoiceKey() -> String? {
        guard let id = (try? db.pool.read { try String.fetchOne($0, sql:
            "SELECT active_voice_credential_id FROM prefs WHERE id = 1") }) ?? nil else { return nil }
        return KeychainCredentialStore().key(.voice, id: id)
    }

    /// Live MiniMax catalog (cached 5 min) · falls back to the seed list.
    private func miniMaxVoices(key: String) -> [[String: Any]] {
        // Read region FIRST so it's part of the cache identity · the catalog is
        // region-specific (different endpoints) and the key alone doesn't capture
        // a cn↔intl switch on the same key.
        let region = (try? db.pool.read { try String.fetchOne($0, sql: "SELECT minimax_region FROM prefs WHERE id = 1") }).flatMap { $0 } ?? "cn"
        let identity = "\(region)|\(key.hashValue)"   // full-key hash, not a JWT-colliding prefix
        voicesLock.lock()
        if let c = minimaxVoiceCache, c.identity == identity, Date().timeIntervalSince(c.at) < 300 {
            let v = c.voices; voicesLock.unlock(); return v
        }
        voicesLock.unlock()
        let voices = fetchMiniMaxVoicesSync(key: key, region: region) ?? Self.voiceCatalog("minimax")
        voicesLock.lock(); minimaxVoiceCache = (identity, Date(), voices); voicesLock.unlock()
        return voices
    }

    /// Synchronous POST /v1/get_voice (the handler runs off the main thread, so
    /// blocking is fine). Mirrors `fetchAllMiniMaxVoices` in registry.ts.
    private func fetchMiniMaxVoicesSync(key: String, region: String) -> [[String: Any]]? {
        let base = region == "intl" ? "https://api.minimax.io" : "https://api.minimaxi.com"
        guard let url = URL(string: base + "/v1/get_voice") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 8)
        req.httpMethod = "POST"
        req.setValue("Bearer \(key)", forHTTPHeaderField: "authorization")
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["voice_type": "all"])
        var result: [[String: Any]]?
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            defer { sem.signal() }
            guard let data, let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            var rows: [[String: Any]] = []
            for (groupKey, kind) in [("voice_cloning", "clone"), ("system_voice", "system"), ("voice_generation", "generated")] {
                guard let arr = json[groupKey] as? [[String: Any]] else { continue }
                for item in arr {
                    guard let vid = item["voice_id"] as? String, !vid.isEmpty else { continue }
                    let name = (item["voice_name"] as? String)?.trimmingCharacters(in: .whitespaces)
                    rows.append(["provider": "minimax", "model": "speech-2.8-hd", "voiceId": vid,
                                 "label": (name?.isEmpty == false ? name! : vid), "language": kind, "configured": true])
                }
            }
            result = rows.isEmpty ? nil : rows
        }.resume()
        _ = sem.wait(timeout: .now() + 10)
        return result
    }

    /// POST /api/voices/preview · synthesize a short sample with the active voice
    /// key so the picker's play button auditions the chosen voice.
    private func voicePreview(_ req: HttpRequest) -> HttpResponse {
        guard let body = try? JSONSerialization.jsonObject(with: Data(req.body)) as? [String: Any],
              let providerStr = body["provider"] as? String, let kind = VoiceProviderKind(rawValue: providerStr),
              let voiceId = body["voiceId"] as? String, !voiceId.isEmpty
        else { return .badRequest(nil) }
        let model = (body["model"] as? String) ?? "speech-2.8-hd"
        let emotion = (body["emotion"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let text = (body["text"] as? String)?.trimmingCharacters(in: .whitespaces).isEmpty == false
            ? (body["text"] as! String) : "你好，我是你的董事会成员。"
        let service = TTSService(credentials: EngineCredentialSource(db: db, keychain: KeychainCredentialStore()))
        let profile = VoiceProfile(provider: kind, model: model, voiceId: voiceId, emotion: emotion)
        var out: (b64: String, mime: String)?
        let sem = DispatchSemaphore(value: 0)
        Task {
            defer { sem.signal() }
            if let chunk = try? await service.synthesize(text, profile: profile), let b = chunk.audioBase64 {
                out = (b, chunk.mimeType ?? "audio/mpeg")
            }
        }
        _ = sem.wait(timeout: .now() + 20)
        guard let out else { return Self.jsonResponse(["error": "synth_failed"]) }
        return Self.jsonResponse(["audioBase64": out.b64, "mimeType": out.mime])
    }

    /// POST /api/voice-clone · clone the active provider's voice from an audio
    /// sample, then PATCH the agent's `voice_json` with the new voiceId (keeping
    /// any prior emotion). Body: { agentId, audioBase64, filename?, label?,
    /// groupId? }. Mirrors the desktop `/api/voice-clone/*` flow, collapsed to a
    /// single synchronous call (the sheet drives stage progress client-side).
    private func voiceClone(_ req: HttpRequest) -> HttpResponse {
        guard let body = try? JSONSerialization.jsonObject(with: Data(req.body)) as? [String: Any],
              let agentId = body["agentId"] as? String, !agentId.isEmpty,
              let b64 = body["audioBase64"] as? String, let audio = Data(base64Encoded: b64)
        else { return .badRequest(nil) }
        // Resolve the active voice provider + key + region.
        let providerStr: String? = (try? db.pool.read { conn -> String? in
            guard let cid = try String.fetchOne(conn, sql: "SELECT active_voice_credential_id FROM prefs WHERE id = 1") else { return nil }
            return try String.fetchOne(conn, sql: "SELECT provider FROM voice_credentials WHERE id = ?", arguments: [cid])
        }) ?? nil
        guard let providerStr, let kind = VoiceProviderKind(rawValue: providerStr),
              kind == .minimax || kind == .elevenlabs, let key = activeVoiceKey()
        else { return Self.jsonResponse(["error": "unsupported_provider"]) }
        let region = (try? db.pool.read { try String.fetchOne($0, sql: "SELECT minimax_region FROM prefs WHERE id = 1") }).flatMap { $0 } ?? "cn"
        let filename = (body["filename"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "sample.m4a"
        let label = (body["label"] as? String)?.trimmingCharacters(in: .whitespaces)
        let groupId = (body["groupId"] as? String)?.trimmingCharacters(in: .whitespaces)

        let service = VoiceCloneService()
        var result: Result<VoiceCloneResult, VoiceCloneError>?
        let sem = DispatchSemaphore(value: 0)
        Task {
            defer { sem.signal() }
            do {
                let r = try await service.clone(provider: kind, apiKey: key, region: region,
                                                audio: audio, filename: filename, agentId: agentId,
                                                label: (label?.isEmpty == false ? label : nil),
                                                groupId: (groupId?.isEmpty == false ? groupId : nil))
                result = .success(r)
            } catch let e as VoiceCloneError {
                result = .failure(e)
            } catch {
                result = .failure(.providerUnknown(error.localizedDescription))
            }
        }
        _ = sem.wait(timeout: .now() + 150)
        guard let result else { return Self.jsonResponse(["error": "provider_unknown", "message": "timed out"]) }
        switch result {
        case .failure(let e):
            return Self.jsonResponse(["error": e.code])
        case .success(let r):
            let model = kind == .minimax ? "speech-2.8-hd" : "eleven_multilingual_v2"
            // Preserve any prior emotion tuning on the agent's voice.
            let priorEmotion: String? = (try? db.pool.read { conn -> String? in
                guard let vj = try String.fetchOne(conn, sql: "SELECT voice_json FROM agents WHERE id = ?", arguments: [agentId]),
                      let data = vj.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
                return obj["emotion"] as? String
            }) ?? nil
            var voice: [String: Any] = ["provider": providerStr, "model": model, "voiceId": r.voiceId]
            if let e = priorEmotion, !e.isEmpty { voice["emotion"] = e }
            if let data = try? JSONSerialization.data(withJSONObject: voice), let s = String(data: data, encoding: .utf8) {
                try? db.pool.write { try $0.execute(sql: "UPDATE agents SET voice_json = ?, updated_at = ? WHERE id = ?",
                                                    arguments: [s, Int(Date().timeIntervalSince1970 * 1000), agentId]) }
            }
            // Drop the MiniMax catalog cache so the new clone shows up in the picker.
            voicesLock.lock(); minimaxVoiceCache = nil; voicesLock.unlock()
            return Self.jsonResponse(["ok": true, "voiceId": r.voiceId, "provider": providerStr,
                                      "model": model, "label": r.label])
        }
    }

    // MARK: Room settings + cast

    /// Room row as the `{ room: {...} }` envelope `updateRoomSettings` decodes.
    private func roomJSON(_ id: String) -> [String: Any]? {
        try? db.pool.read { conn -> [String: Any]? in
            guard let r = try Row.fetchOne(conn, sql: """
                SELECT id, name, subject, mode, intensity, delivery_mode, status, created_at
                FROM rooms WHERE id = ?
                """, arguments: [id]) else { return nil }
            return [
                "id": r["id"] as String? ?? id,
                "name": r["name"] as String? as Any,
                "subject": r["subject"] as String? as Any,
                "mode": r["mode"] as String? as Any,
                "intensity": r["intensity"] as String? as Any,
                "deliveryMode": r["delivery_mode"] as String? as Any,
                "status": r["status"] as String? ?? "live",
                "createdAt": r["created_at"] as Int? as Any,
            ]
        } ?? nil
    }

    private func patchRoom(_ id: String, _ req: HttpRequest) -> HttpResponse {
        guard let body = try? JSONSerialization.jsonObject(with: Data(req.body)) as? [String: Any] else { return .badRequest(nil) }
        let map: [(String, String)] = [
            ("mode", "mode"), ("intensity", "intensity"), ("deliveryMode", "delivery_mode"), ("briefStyle", "brief_style"),
        ]
        var sets: [String] = [], args: [DatabaseValueConvertible] = []
        for (k, col) in map where body[k] is String { sets.append("\(col) = ?"); args.append(body[k] as! String) }
        if !sets.isEmpty {
            args.append(id)
            try? db.pool.write { try $0.execute(sql: "UPDATE rooms SET \(sets.joined(separator: ", ")) WHERE id = ?", arguments: StatementArguments(args)) }
        }
        return Self.jsonResponse(["room": roomJSON(id) ?? ["id": id]])
    }

    private func patchRoomMembers(_ id: String, _ req: HttpRequest) -> HttpResponse {
        guard let body = try? JSONSerialization.jsonObject(with: Data(req.body)) as? [String: Any],
              let want = body["agentIds"] as? [String], !want.isEmpty else { return .badRequest(nil) }
        let now = Int(Date().timeIntervalSince1970 * 1000)
        do {
            try db.pool.write { conn in
                let current = try String.fetchAll(conn, sql: "SELECT agent_id FROM room_members WHERE room_id = ? AND removed_at IS NULL", arguments: [id])
                let cur = Set(current), wantSet = Set(want)
                for gone in cur.subtracting(wantSet) {
                    try conn.execute(sql: "DELETE FROM room_members WHERE room_id = ? AND agent_id = ?", arguments: [id, gone])
                }
                var pos = (try Int.fetchOne(conn, sql: "SELECT COALESCE(MAX(position),-1)+1 FROM room_members WHERE room_id = ?", arguments: [id])) ?? 0
                for add in want where !cur.contains(add) {
                    try conn.execute(sql: "INSERT INTO room_members (room_id, agent_id, position, joined_at) VALUES (?,?,?,?)",
                                     arguments: [id, add, pos, now])
                    pos += 1
                }
            }
        } catch { return .internalServerError }
        return Self.jsonResponse(["ok": true])
    }

    // MARK: GRDB → embed-shaped JSON

    private func roomSnapshot(_ roomId: String) -> [String: Any] {
        let members: [[String: Any]] = (try? db.pool.read { conn in
            try Row.fetchAll(conn, sql: """
                SELECT a.id AS id, a.name AS name, a.avatar_path AS avatar_path,
                       a.role_kind AS role_kind, a.avatar3d_json AS avatar3d_json
                FROM room_members m JOIN agents a ON a.id = m.agent_id
                WHERE m.room_id = ? AND m.removed_at IS NULL
                ORDER BY m.position
                """, arguments: [roomId]).map(Self.memberDict)
        }) ?? []
        // Prepend the chair (a global moderator, not a room_member) so the
        // stage-embed finds it via `raw.find(moderator)` — its primary path —
        // instead of depending on a second /api/agents fetch. Without this the
        // chair seat never appears on the 3D stage.
        var all = members
        if let chair = chairDict() { all.insert(chair, at: 0) }
        // The host user takes a seat too (once they've customised an avatar) so their
        // 3D figure sits around the table next to the directors.
        if let user = userMemberDict() { all.append(user) }
        // `subject` is read by report.html's masthead (harmless to the 3D stage).
        let subject: String? = (try? db.pool.read { try String.fetchOne($0, sql: "SELECT subject FROM rooms WHERE id = ?", arguments: [roomId]) }) ?? nil
        // Message history · RoomSession.applySnapshot rebuilds the transcript from
        // this on (re-)entry. Without it, re-opening a room that had discussion
        // showed a blank chat (and felt like the room had been wiped). Skip
        // still-streaming placeholders + system markers (round-open) — they'd
        // render as empty bubbles.
        let messages: [[String: Any]] = (try? db.pool.read { conn in
            try Row.fetchAll(conn, sql: """
                SELECT id, body, author_id, author_kind, round_num, created_at, meta_json
                FROM messages WHERE room_id = ? ORDER BY created_at ASC
                """, arguments: [roomId]).compactMap { r -> [String: Any]? in
                let body = (r["body"] as String? ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let kind = r["author_kind"] as String? ?? ""
                guard !body.isEmpty, kind != "system" else { return nil }
                return [
                    "id": r["id"] as String? ?? "",
                    "body": body,
                    "authorId": r["author_id"] as String? as Any,
                    "authorKind": kind,
                    "roundNum": r["round_num"] as Int? as Any,
                    "createdAt": r["created_at"] as Int? as Any,
                ]
            }
        }) ?? []
        return ["members": all, "chair": chairDict() as Any, "subject": subject as Any, "messages": messages]
    }

    /// GET /api/briefs/:id → the brief row the renderer reads. report.html uses
    /// bodyMd + spine + composer fields; the structured templates (magazine /
    /// newspaper / ppt) parse bodyJson. style routes which page NativeBriefView opens.
    private func briefSnapshot(_ id: String) -> [String: Any] {
        ((try? db.pool.read { conn -> [String: Any]? in
            guard let r = try Row.fetchOne(conn, sql: """
                SELECT id, title, body_md, body_json, style, spine, components_json,
                       composer_rationale, subject_type, house_style, created_at
                FROM briefs WHERE id = ?
                """, arguments: [id]) else { return nil }
            // body_json is a JSON string column · parse it so the renderer gets an
            // object at `brief.bodyJson` (magazine.html reads it directly).
            var bodyJson: Any = NSNull()
            if let s = r["body_json"] as String?, let d = s.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: d) { bodyJson = obj }
            var components: Any = NSNull()
            if let s = r["components_json"] as String?, let d = s.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: d) { components = obj }
            // The native schema has no `mode` column — the structured-mode slug lives
            // in `style`. magazine/newspaper/ppt.html bail early unless `brief.mode`
            // matches, so derive + emit it (else those pages show "not a magazine").
            let style = r["style"] as String? ?? "auto"
            let mode: String
            switch style {
            case "magazine", "newspaper", "ppt": mode = style
            default: mode = "research-note"
            }
            return [
                "id": r["id"] as String? ?? "",
                "title": r["title"] as String? as Any,
                "bodyMd": r["body_md"] as String? ?? "",
                "bodyJson": bodyJson,
                "style": style,
                "mode": mode,
                "spine": r["spine"] as String? as Any,
                "components": components,
                "composerRationale": r["composer_rationale"] as String? as Any,
                "subjectType": r["subject_type"] as String? as Any,
                "houseStyle": r["house_style"] as String? as Any,
                "createdAt": r["created_at"] as Int? as Any,
            ]
        }) ?? nil) ?? [:]
    }

    private func chairDict() -> [String: Any]? {
        try? db.pool.read { conn in
            try Row.fetchOne(conn, sql: """
                SELECT id, name, avatar_path, role_kind, avatar3d_json
                FROM agents WHERE role_kind = 'moderator' LIMIT 1
                """).map(Self.memberDict)
        } ?? nil
    }

    /// The host user as a `__isUser` seat for the 3D stage · ONLY once they've
    /// customised an avatar (`prefs.avatar3d_json` set), so an un-customised user
    /// never injects a stray voxel seat / changes existing rooms. The stage already
    /// handles `__isUser` seats (wait-mark, spoke-bubble, 3D figure from avatar3d).
    private func userMemberDict() -> [String: Any]? {
        try? db.pool.read { conn -> [String: Any]? in
            guard let raw = try String.fetchOne(conn, sql: "SELECT avatar3d_json FROM prefs WHERE id = 1"),
                  let data = raw.data(using: .utf8),
                  var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
            if let hs = obj["hairStyle"] as? String, !Self.validHairStyles.contains(hs) { obj.removeValue(forKey: "hairStyle") }
            let name = (try String.fetchOne(conn, sql: "SELECT name FROM prefs WHERE id = 1")) ?? "You"
            var d: [String: Any] = ["id": "__user__", "name": name ?? "You", "roleKind": "user",
                                    "__isUser": true, "avatar3d": obj]
            if let url = try String.fetchOne(conn, sql: "SELECT avatar_url FROM prefs WHERE id = 1"), !url.isEmpty {
                d["avatarPath"] = url
            }
            return d
        } ?? nil
    }

    /// Valid `hairStyle` ids the 3D stage's `swapHair` understands (the HAIR_STYLES
    /// set in avatar-3d.js, plus the model ids usable as cross-model hair sources).
    private static let validHairStyles: Set<String> = [
        "none", "glasses", "casual", "street", "royal", "xmas",
        "style6", "style7", "style8", "style9", "style10",
    ]

    private static func memberDict(_ r: Row) -> [String: Any] {
        var d: [String: Any] = [
            "id": r["id"] as String? ?? "",
            "name": r["name"] as String? ?? "",
            "avatarPath": r["avatar_path"] as String? ?? "",
            "roleKind": r["role_kind"] as String? ?? "director",
        ]
        // Pass avatar3d through. The seed's pre-v0.1.44 model ids ("classic")
        // resolve gracefully for the BODY (resolveModel falls back to the first
        // model), but an invalid `hairStyle` like "classic" is NOT graceful:
        // swapHair hides the body's own hair, then resolveModel("classic") falls
        // back to the first model — which equals the body — so it early-returns
        // WITHOUT adding hair → the director renders BALD (e.g. Historian). Drop
        // any unknown hairStyle so buildAvatar3D keeps the body model's own hair.
        if let raw: String = r["avatar3d_json"], let data = raw.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) {
            if var obj = parsed as? [String: Any] {
                if let hs = obj["hairStyle"] as? String, !validHairStyles.contains(hs) {
                    obj.removeValue(forKey: "hairStyle")
                }
                d["avatar3d"] = obj
            } else {
                d["avatar3d"] = parsed
            }
        }
        return d
    }

    private static func mime(for ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js":   return "text/javascript; charset=utf-8"
        case "json": return "application/json"
        case "glb":  return "model/gltf-binary"
        case "wasm": return "application/wasm"
        case "css":  return "text/css"
        case "png":  return "image/png"
        case "webp": return "image/webp"
        default:     return "application/octet-stream"
        }
    }
}
