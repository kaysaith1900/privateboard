import Foundation
import BoardroomCore

/// Thin async REST client — the Swift counterpart of `public/mobile/api.js`.
/// Every call resolves its path against `backend.baseURL` and injects the
/// bearer token when one is set (cloud mode). CORS is irrelevant here: a native
/// URLSession is not a browser, so the local server needs no CORS changes —
/// it only has to listen on the LAN (`boardroom --host 0.0.0.0`).
struct APIClient {
    let backend: Backend
    private var session: URLSession { .shared }

    enum APIError: Error, LocalizedError {
        case badURL
        case network(Error)
        case http(Int, String?)
        case decode(Error)

        var errorDescription: String? {
            switch self {
            case .badURL: return "Invalid server address."
            case .network(let e): return "Can't reach the server — \(e.localizedDescription)"
            case .http(let code, let body): return "Server error \(code)\(body.map { ": \($0)" } ?? "")"
            case .decode: return "Unexpected response from the server."
            }
        }
    }

    // MARK: Core

    /// Default request timeout · fine for plain CRUD. LLM-backed endpoints
    /// (`generate-spec`, persona drafting) routinely run far longer — they pass
    /// an explicit larger `timeout` so a slow draft isn't misreported as
    /// "can't reach the server".
    private static let defaultTimeout: TimeInterval = 20

    private func makeRequest(_ method: String, _ path: String, body: Data? = nil,
                             timeout: TimeInterval = APIClient.defaultTimeout) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: backend.baseURL) else { throw APIError.badURL }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = method
        if let token = backend.authToken { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    @discardableResult
    private func send(_ method: String, _ path: String, body: Data? = nil,
                      timeout: TimeInterval = APIClient.defaultTimeout) async throws -> Data {
        let req = try makeRequest(method, path, body: body, timeout: timeout)
        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.data(for: req) }
        catch { throw APIError.network(error) }
        guard let http = resp as? HTTPURLResponse else { throw APIError.http(-1, nil) }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(http.statusCode, String(data: data, encoding: .utf8))
        }
        return data
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let data = try await send("GET", path)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.decode(error) }
    }

    // MARK: Endpoints (Phase 1 subset · grows alongside the UI)

    func health() async throws { _ = try await send("GET", "/api/health") }

    func listRooms() async throws -> [Room] {
        let r: RoomsResponse = try await get("/api/rooms")
        return r.rooms.filter { !$0.isThread }
    }

    func getRoom(_ id: String) async throws -> RoomSnapshot {
        try await get("/api/rooms/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)")
    }

    func listAgents() async throws -> AgentsResponse {
        try await get("/api/agents")
    }

    func getAgent(_ id: String) async throws -> Agent {
        try await get("/api/agents/\(enc(id))")
    }

    /// Edit an agent · bio / instruction / webSearchEnabled (same fields the
    /// web profile patches). Returns the updated record when the server echoes
    /// it back, else nil (the caller keeps its optimistic local copy).
    @discardableResult
    func patchAgent(_ id: String, _ fields: [String: Any]) async throws -> Agent? {
        let data = try await send("PATCH", "/api/agents/\(enc(id))", body: Self.jsonBody(fields))
        return try? JSONDecoder().decode(Agent.self, from: data)
    }

    func deleteAgent(_ id: String) async throws {
        _ = try await send("DELETE", "/api/agents/\(enc(id))")
    }

    func agentStats(_ id: String) async throws -> AgentStats {
        try await get("/api/agents/\(enc(id))/stats")
    }

    func listMemories(_ id: String) async throws -> [AgentMemory] {
        let r: MemoriesResponse = try await get("/api/agents/\(enc(id))/memories")
        return r.memories
    }

    @discardableResult
    func addMemory(_ id: String, content: String) async throws -> AgentMemory? {
        let data = try await send("POST", "/api/agents/\(enc(id))/memories",
                                  body: Self.jsonBody(["content": content, "kind": "fact"]))
        return try? JSONDecoder().decode(AgentMemory.self, from: data)
    }

    func deleteMemory(_ id: String, _ memId: String) async throws {
        _ = try await send("DELETE", "/api/agents/\(enc(id))/memories/\(enc(memId))")
    }

    // ── Voice (profile picker + preview) ───────────────────────────

    func listVoices() async throws -> [VoiceOption] {
        let r: VoicesResponse = try await get("/api/voices")
        return r.voices
    }

    /// Like `listVoices` but keeps the envelope (carries the active `provider`,
    /// needed to decide whether voice cloning is offered + which fields to show).
    func listVoicesFull() async throws -> VoicesResponse {
        try await get("/api/voices")
    }

    /// Audition a voice config · returns decoded MP3 bytes (nil on failure).
    func previewVoice(provider: String, model: String, voiceId: String,
                      emotion: String? = nil, text: String? = nil) async -> Data? {
        var body: [String: Any] = ["provider": provider, "model": model, "voiceId": voiceId]
        if let emotion, !emotion.isEmpty { body["emotion"] = emotion }
        if let text, !text.isEmpty { body["text"] = text }
        guard let d = try? await send("POST", "/api/voices/preview", body: Self.jsonBody(body)) else { return nil }
        struct R: Decodable { let audioBase64: String?; let mimeType: String? }
        guard let r = try? JSONDecoder().decode(R.self, from: d), let b = r.audioBase64 else { return nil }
        return Data(base64Encoded: b)
    }

    /// Clone a director's voice from an audio sample → the new provider voiceId.
    /// Mirrors the desktop `/api/voice-clone` flow; throws `APIError`/decodes the
    /// `{ error: code }` body on provider failure so the sheet can show a message.
    struct CloneResult: Decodable { let ok: Bool?; let voiceId: String?; let provider: String?; let model: String?; let label: String?; let error: String? }
    func cloneVoice(agentId: String, audio: Data, filename: String,
                    label: String?, groupId: String?) async throws -> CloneResult {
        var body: [String: Any] = ["agentId": agentId, "audioBase64": audio.base64EncodedString(), "filename": filename]
        if let label, !label.isEmpty { body["label"] = label }
        if let groupId, !groupId.isEmpty { body["groupId"] = groupId }
        // Cloning runs the full upload+train round-trip · allow well past the 20s default.
        let data = try await send("POST", "/api/voice-clone", body: Self.jsonBody(body), timeout: 180)
        return try JSONDecoder().decode(CloneResult.self, from: data)
    }

    func adjournRoom(_ id: String) async throws {
        _ = try await send("POST", "/api/rooms/\(enc(id))/adjourn", body: Self.jsonBody([:]))
    }

    func deleteRoom(_ id: String) async throws {
        _ = try await send("DELETE", "/api/rooms/\(enc(id))")
    }

    // ── Room controls + live (Phase 2) ─────────────────────────────

    func roomStreamURL(_ id: String) -> URL? {
        URL(string: "/api/rooms/\(enc(id))/stream", relativeTo: backend.baseURL)?.absoluteURL
    }

    /// Live room events as an ordered `AsyncStream<RoomEvent>` — the seam
    /// `RoomSession` consumes, decoupled from the SSE wire format. Backs onto
    /// `SSEClient` (which auto-reconnects + replays via `Last-Event-ID`) and maps
    /// each frame through `RoomEvent.parse`. Cancelling the consuming task tears
    /// down the underlying SSE connection. The on-device engine will vend this
    /// same stream from its in-process `EventBus`.
    func roomEvents(_ id: String, lastEventID: String? = nil) -> AsyncStream<RoomEvent> {
        AsyncStream { continuation in
            guard let url = roomStreamURL(id) else { continuation.finish(); return }
            let client = SSEClient(url: url, authToken: backend.authToken)
            let task = Task {
                for await ev in client.events() {
                    if let event = RoomEvent.parse(name: ev.name, data: Data(ev.data.utf8)) {
                        continuation.yield(event)
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel(); client.stop() }
        }
    }

    func sendMessage(_ id: String, body: String, mode: String) async throws {
        _ = try await send("POST", "/api/rooms/\(enc(id))/messages",
                           body: Self.jsonBody(["body": body, "mode": mode]))
    }

    func pauseRoom(_ id: String, mode: String = "soft") async throws {
        _ = try await send("POST", "/api/rooms/\(enc(id))/pause", body: Self.jsonBody(["mode": mode]))
    }

    func resumeRoom(_ id: String) async throws {
        _ = try await send("POST", "/api/rooms/\(enc(id))/resume")
    }

    /// Advance to the next reactive round after a round-end.
    func continueRoom(_ id: String) async throws {
        _ = try await send("POST", "/api/rooms/\(enc(id))/continue")
    }

    /// Escalate the light round-prompt to a FORMAL round-end (desktop "Open
    /// vote") · the chair streams a key-point summary, then the `round-ended`
    /// config event lands with the votable points.
    func roundEnd(_ id: String, mode: String = "now") async throws {
        _ = try await send("POST", "/api/rooms/\(enc(id))/round-end", body: Self.jsonBody(["mode": mode]))
    }

    /// Vote a chair key point up / down (`"up"` | `"down"` | `nil` to clear).
    func voteKeyPoint(_ id: String, _ kpId: String, vote: String?) async throws {
        _ = try await send("POST", "/api/rooms/\(enc(id))/keypoints/\(enc(kpId))/vote",
                           body: Self.jsonBody(["vote": vote ?? NSNull()]))
    }

    /// Persisted TTS clip for a message (adjourned replay). nil if none saved.
    func messageAudio(_ messageId: String) async -> Data? {
        let d = try? await send("GET", "/api/voices/message/\(enc(messageId))/audio")
        return (d?.isEmpty == false) ? d : nil
    }

    /// Synth-on-demand clip for a message (replay fallback). Returns MP3 bytes.
    func synthMessageAudio(_ messageId: String) async -> Data? {
        guard let d = try? await send("POST", "/api/voices/by-message/\(enc(messageId))") else { return nil }
        struct R: Decodable { let audioBase64: String?; let mimeType: String? }
        guard let r = try? JSONDecoder().decode(R.self, from: d), let b = r.audioBase64 else { return nil }
        return Data(base64Encoded: b)
    }

    /// Heartbeat + completion acks · best-effort, never throw (mirror api.js).
    func voiceProgress(_ id: String, _ messageId: String) async {
        _ = try? await send("POST", "/api/rooms/\(enc(id))/messages/\(enc(messageId))/voice-progress")
    }
    func voiceDone(_ id: String, _ messageId: String) async {
        _ = try? await send("POST", "/api/rooms/\(enc(id))/messages/\(enc(messageId))/voice-done")
    }

    // ── Create + reports (Phase 4) ─────────────────────────────────

    func createRoom(subject: String, mode: String, intensity: String,
                    deliveryMode: String, autoPick: Bool, agentIds: [String],
                    parentRoomId: String? = nil) async throws -> Room {
        var body: [String: Any] = [
            "subject": subject, "mode": mode, "intensity": intensity,
            "deliveryMode": deliveryMode, "briefStyle": "auto", "autoPick": autoPick,
        ]
        if !autoPick { body["agentIds"] = agentIds }
        if let parentRoomId { body["parentRoomId"] = parentRoomId }   // follow-up linkage
        let data = try await send("POST", "/api/rooms", body: Self.jsonBody(body))
        do { return try JSONDecoder().decode(CreateRoomResponse.self, from: data).room }
        catch { throw APIError.decode(error) }
    }

    /// PATCH room settings · tone (`mode`) / `intensity` / `deliveryMode` / etc.
    /// Only the supplied fields are sent. Returns the updated room. Adjourned
    /// rooms reject everything except `deliveryMode` (409).
    @discardableResult
    func updateRoomSettings(_ id: String, mode: String? = nil, intensity: String? = nil,
                            deliveryMode: String? = nil, briefStyle: String? = nil,
                            voteTrigger: String? = nil) async throws -> Room {
        var body: [String: Any] = [:]
        if let mode { body["mode"] = mode }
        if let intensity { body["intensity"] = intensity }
        if let deliveryMode { body["deliveryMode"] = deliveryMode }
        if let briefStyle { body["briefStyle"] = briefStyle }
        if let voteTrigger { body["voteTrigger"] = voteTrigger }
        let data = try await send("PATCH", "/api/rooms/\(enc(id))", body: Self.jsonBody(body))
        do { return try JSONDecoder().decode(CreateRoomResponse.self, from: data).room }
        catch { throw APIError.decode(error) }
    }

    /// PATCH the room's director cast · `agentIds` is the FULL desired set; the
    /// server diffs adds/removes, keeps the chair seated, and refuses an empty
    /// cast (400) or an adjourned room (409). We refresh the live cast locally
    /// from the picker, so the response body isn't needed.
    func updateRoomMembers(_ id: String, agentIds: [String]) async throws {
        _ = try await send("PATCH", "/api/rooms/\(enc(id))/members", body: Self.jsonBody(["agentIds": agentIds]))
    }

    func roomBriefs(_ id: String) async throws -> [Brief] {
        let r: RoomBriefsResponse = try await get("/api/rooms/\(enc(id))/briefs")
        return r.briefs.sorted { ($0.createdAt ?? 0) > ($1.createdAt ?? 0) }   // newest first
    }

    func getBrief(_ id: String) async throws -> Brief {
        try await get("/api/briefs/\(enc(id))")
    }

    func generateBrief(_ id: String, mode: String? = nil) async throws {
        var body: [String: Any] = [:]
        if let mode { body["mode"] = mode }
        _ = try await send("POST", "/api/rooms/\(enc(id))/brief", body: Self.jsonBody(body))
    }

    /// Full-fidelity report spine URL for a brief (mirrors the web `briefSpineUrl`).
    func reportURL(brief: Brief, roomId: String) -> URL? {
        let bid = enc(brief.id)
        let rid = enc(roomId)
        let path: String
        switch brief.mode {
        case "magazine":  path = "/magazine.html?b=\(bid)"
        case "newspaper": path = "/newspaper.html?b=\(bid)"
        case "ppt":       path = "/ppt.html?b=\(bid)"
        default:          path = "/report.html?b=\(bid)&r=\(rid)"
        }
        return assetURL(path)
    }

    // MARK: Helpers

    private func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }

    private static func jsonBody(_ dict: [String: Any]) -> Data? {
        try? JSONSerialization.data(withJSONObject: dict)
    }

    /// Absolute URL for a server-relative asset path (avatars, report, stage).
    /// Handles absolute URLs, leading-slash and bare relative paths.
    func assetURL(_ path: String) -> URL? {
        let p = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { return nil }
        if p.hasPrefix("data:") { return URL(string: p) }   // inline portrait · don't host-resolve
        if p.hasPrefix("http://") || p.hasPrefix("https://") { return URL(string: p) }
        let rel = p.hasPrefix("/") ? p : "/" + p
        return URL(string: rel, relativeTo: backend.baseURL)?.absoluteURL
    }
}

// The REST client is the first `RoomEventSource`; the on-device `EngineClient`
// will be the second. `roomEvents(_:lastEventID:)` above satisfies it.
extension APIClient: RoomEventSource {}

// MARK: - Provider credentials (API keys) · LLM / Voice / Search

/// The three credential families, each a parallel multi-instance endpoint set
/// (mirrors the web `CRED_API`). One credential per family is "active".
enum CredCategory: String, CaseIterable, Identifiable, Hashable {
    case llm, voice, search
    var id: String { rawValue }
    var basePath: String {
        switch self {
        case .llm:    return "/api/credentials"
        case .voice:  return "/api/voice-credentials"
        case .search: return "/api/search-credentials"
        }
    }
}

extension APIClient {
    func listCredentials(_ cat: CredCategory) async throws -> CredentialsResponse {
        try await get(cat.basePath)
    }
    func createCredential(_ cat: CredCategory, provider: String, label: String?, key: String,
                          region: String? = nil) async throws {
        var body: [String: Any] = ["provider": provider, "key": key]
        if let label, !label.trimmingCharacters(in: .whitespaces).isEmpty { body["label"] = label }
        // MiniMax host region ("cn" | "intl") · stored as the global minimax_region
        // pref so synthesis + catalog fetch hit the right host (api.minimaxi.com vs
        // api.minimax.io). Mirrors the desktop region pref.
        if let region, !region.isEmpty { body["region"] = region }
        _ = try await send("POST", cat.basePath, body: Self.jsonBody(body))
    }
    func setActiveCredential(_ cat: CredCategory, id: String) async throws {
        _ = try await send("PUT", cat.basePath + "/active", body: Self.jsonBody(["id": id]))
    }
    /// Cumulative token accounting · GET /api/usage/summary. Tolerates a 404
    /// (older backends without the route) → nil, like the mobile web client.
    func getUsage() async throws -> UsageSummary? {
        do { return try await get("/api/usage/summary") }
        catch let APIError.http(code, _) where code == 404 { return nil }
    }
    func deleteCredential(_ cat: CredCategory, id: String) async throws {
        _ = try await send("DELETE", cat.basePath + "/\(enc(id))")
    }
}

// MARK: - Directors · generate + create

extension APIClient {
    /// Draft a director spec from a free-text description. `webSearch` grounds the
    /// draft in live sources (Full-persona path); off = quick Signal draft.
    func generateSpec(_ description: String, webSearch: Bool = false) async throws -> GeneratedSpec {
        // LLM draft · the signal path is "fast" but cold-start / routing latency
        // can still blow past the 20 s default, and the `full`/webSearch path is
        // slower still. 120 s mirrors the web client's effectively-unbounded fetch
        // so a working server is never misreported as unreachable.
        let data = try await send("POST", "/api/agents/generate-spec",
                                  body: Self.jsonBody(["description": description, "webSearch": webSearch]),
                                  timeout: 120)
        guard let spec = (try? JSONDecoder().decode(GenerateSpecResponse.self, from: data))?.spec else {
            throw APIError.http(200, "Couldn't draft the director — try a more concrete description.")
        }
        return spec
    }

    /// Create a director. Body mirrors the web `createAgent`. `avatarPath` is a
    /// `data:image/png` URL from the 3D-avatar renderer; omitted → server default.
    func createAgent(name: String, role: String, bio: String, instruction: String,
                     modelV: String, avatarPath: String? = nil, avatar3d: [String: Any]? = nil) async throws {
        var body: [String: Any] = ["name": name, "modelV": modelV]
        let role = role.trimmingCharacters(in: .whitespaces)
        let bio = bio.trimmingCharacters(in: .whitespaces)
        let instr = instruction.trimmingCharacters(in: .whitespaces)
        if !role.isEmpty { body["roleTag"] = role }
        if !bio.isEmpty { body["bio"] = bio }
        if !instr.isEmpty { body["instruction"] = instr }
        if let avatarPath, !avatarPath.isEmpty { body["avatarPath"] = avatarPath }
        if let avatar3d { body["avatar3d"] = avatar3d }
        _ = try await send("POST", "/api/agents", body: Self.jsonBody(body))
    }

    /// Reachable model catalog (for the director model picker).
    func listModels() async throws -> [ModelInfo] {
        let r: ModelsResponse = try await get("/api/models")
        return r.models
    }

    /// Full catalog response · models + the stale-agent list (for the support view).
    func modelCatalog() async throws -> ModelsResponse {
        try await get("/api/models")
    }

    /// Reassign every director whose model is unreachable to a random fast model.
    func resetStaleModels() async throws -> ResetStaleResponse {
        let data = try await send("POST", "/api/models/reset-stale", timeout: 15)
        do { return try JSONDecoder().decode(ResetStaleResponse.self, from: data) }
        catch { throw APIError.decode(error) }
    }

    /// Pull the active aggregator carrier's latest models and add the new ones as
    /// dynamic (usable) models. Longer timeout · this does a live network fetch.
    func refreshModels() async throws -> RefreshModelsResponse {
        let data = try await send("POST", "/api/models/refresh", timeout: 30)
        do { return try JSONDecoder().decode(RefreshModelsResponse.self, from: data) }
        catch { throw APIError.decode(error) }
    }
}

// MARK: - Directors · full-persona deep build (7-phase SSE job)

extension APIClient {
    /// Kick off the deep persona build · returns the jobId to stream. The
    /// pipeline runs server-side; the kickoff itself returns fast.
    func generatePersona(_ description: String, locale: String) async throws -> String {
        let data = try await send("POST", "/api/agents/generate-persona",
                                  body: Self.jsonBody(["description": description, "locale": locale]),
                                  timeout: 30)
        struct R: Decodable { let jobId: String }
        guard let r = try? JSONDecoder().decode(R.self, from: data) else {
            throw APIError.http(200, "Couldn't start the persona build.")
        }
        return r.jobId
    }

    func personaStreamURL(_ jobId: String) -> URL? {
        URL(string: "/api/agents/generate-persona/\(enc(jobId))/stream", relativeTo: backend.baseURL)?.absoluteURL
    }

    /// Persona-build progress as an ordered `AsyncStream<PersonaEvent>`. Backs
    /// onto `SSEClient` (same device-safe delegate path the room stream uses);
    /// the consumer breaks on a terminal event, tearing the connection down so
    /// the auto-reconnect doesn't refire once the build is done/aborted/failed.
    func personaEvents(_ jobId: String) -> AsyncStream<PersonaEvent> {
        AsyncStream { continuation in
            guard let url = personaStreamURL(jobId) else { continuation.finish(); return }
            let client = SSEClient(url: url, authToken: backend.authToken)
            let task = Task {
                for await ev in client.events() {
                    if let event = PersonaEvent.parse(name: ev.name, data: Data(ev.data.utf8)) {
                        continuation.yield(event)
                        if event.isTerminal { break }
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel(); client.stop() }
        }
    }

    /// Cancel an in-flight build (aborts upstream LLM calls + fetches).
    func abortPersona(_ jobId: String) async throws {
        _ = try await send("POST", "/api/agents/generate-persona/\(enc(jobId))/abort")
    }

    /// Materialize the built persona into a saved director. The server re-reads
    /// the full spec from the (done) job; the client supplies only the editable
    /// surface. Returns the created agent when the server echoes it.
    @discardableResult
    func savePersona(jobId: String, name: String, role: String, bio: String,
                     instruction: String, modelV: String,
                     coverQuote: String?, ability: [String: Double]?,
                     avatarPath: String? = nil, avatar3d: [String: Any]? = nil) async throws -> Agent? {
        var body: [String: Any] = ["name": name, "modelV": modelV]
        let role = role.trimmingCharacters(in: .whitespaces)
        let bio = bio.trimmingCharacters(in: .whitespaces)
        let instr = instruction.trimmingCharacters(in: .whitespaces)
        if !role.isEmpty { body["roleTag"] = role }
        if !bio.isEmpty { body["bio"] = bio }
        if !instr.isEmpty { body["instruction"] = instr }
        if let cq = coverQuote?.trimmingCharacters(in: .whitespaces), !cq.isEmpty { body["coverQuote"] = cq }
        if let ability, !ability.isEmpty { body["ability"] = ability }
        if let avatarPath, !avatarPath.isEmpty { body["avatarPath"] = avatarPath }
        if let avatar3d { body["avatar3d"] = avatar3d }
        let data = try await send("POST", "/api/agents/generate-persona/\(enc(jobId))/save",
                                  body: Self.jsonBody(body), timeout: 30)
        return try? JSONDecoder().decode(Agent.self, from: data)
    }
}
