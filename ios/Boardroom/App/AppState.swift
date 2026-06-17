import SwiftUI
import Observation
import BoardroomAI
import BoardroomStorage
import BoardroomEngine

/// In-flight report (closing brief) generation · owned by `AppState` so it
/// SURVIVES minimising the report overlay. A global floating "generating" badge
/// observes it and reopens the report when tapped / when it's ready.
@MainActor @Observable
final class BriefJob: Identifiable {
    let id = UUID()
    let roomId: String
    let roomTitle: String
    var mode: BriefGenerator.Mode
    let supplement: String
    var style: String
    enum Status: Equatable { case generating, ready, failed }
    var status: Status = .generating
    var briefId: String?
    var error: String?
    var startedAt = Date()
    var forceGenerate = false        // regenerate (mode change) always writes a fresh brief
    init(roomId: String, roomTitle: String, mode: BriefGenerator.Mode, supplement: String, style: String) {
        self.roomId = roomId; self.roomTitle = roomTitle; self.mode = mode
        self.supplement = supplement; self.style = style
    }
}

/// Single source of truth for the shell · the chosen backend + the rooms list.
/// Grows into the room/agent stores as later phases land. `@MainActor` so view
/// mutations are always on the main thread; `@Observable` drives SwiftUI.
@MainActor
@Observable
final class AppState {
    enum Phase: Equatable {
        case needsBackend          // no server configured yet → ConnectView
        case loading
        case ready
        case error(String)
    }

    private(set) var backend: Backend?
    private(set) var phase: Phase
    var rooms: [Room] = []
    var agents: [Agent] = []      // directors (chair excluded)
    var chair: Agent?             // the moderator, listed first in the directors tab
    var agentsError: String?      // surfaced on the Directors tab when /api/agents fails
    /// Settings red-dot · set at launch/resume when a director is on a model the
    /// active key can no longer reach (drives the gear badge → 支持模型列表 → 一键重置).
    var modelsNeedAttention = false
    var roomDirectorCache: [String: [Agent]] = [:]   // roomId → directors (hydrated from members)
    /// In-flight full-persona director build · owned here (not the new-director
    /// sheet) so it SURVIVES closing the overlay: the Directors "+" shows a
    /// spinner while it runs and tapping it reopens the live build screen.
    var directorBuild: PersonaBuildModel?
    var directorBuilding: Bool { directorBuild?.status == .running }
    /// A voice room left mid-playback · its `RoomSession` is handed here on exit so
    /// the SSE stream + TTS keep running (the session owns those tasks, not the
    /// view). A floating mini-player shows it on Home and taps back into the room;
    /// closing it stops playback. Nil = nothing playing in the background.
    var nowPlaying: RoomSession?
    /// Mini-player tap → HomeView observes this and pushes the room onto its path.
    var pendingOpenRoom: Room?
    /// Stop + drop the background player (the mini-player's ✕).
    func stopNowPlaying() { nowPlaying?.leave(); nowPlaying = nil }
    /// In-flight report generation · owned here so it survives minimising the
    /// report overlay (the generation Task is detached from the view). A global
    /// floating badge shows while it runs and reopens the report on tap.
    var briefJob: BriefJob?
    @ObservationIgnored private var briefTask: Task<Void, Never>?

    /// Start (or reuse) a background report generation for `roomId` in `mode`. The
    /// async engine call runs in a Task held HERE, so closing the overlay doesn't
    /// cancel it. Idempotent: an existing non-failed job for the same room+mode is
    /// reused; a different mode restarts it.
    func startBriefJob(roomId: String, roomTitle: String, mode: BriefGenerator.Mode,
                       supplement: String, style: String, force: Bool = false) {
        if let j = briefJob, j.roomId == roomId, j.mode == mode, j.status != .failed {
            j.style = style; return            // already running / ready · just track the chosen style
        }
        let job = BriefJob(roomId: roomId, roomTitle: roomTitle, mode: mode, supplement: supplement, style: style)
        job.forceGenerate = force
        briefJob = job
        briefTask?.cancel()
        briefTask = Task {
            await Self.runBriefJob(job)
            if job.status == .ready { reportRoomIds.insert(job.roomId) }   // badge the room card right away
        }
    }

    /// Detached generation · NOT tied to any view. Writes the brief (only if none
    /// exists, or a mode regenerate forced it) then flips the job to `.ready`.
    private static func runBriefJob(_ job: BriefJob) async {
        guard let host = NativeEngineHost.shared else {
            job.error = "Engine unavailable."; job.status = .failed; return
        }
        if host.latestBriefId(job.roomId) == nil || job.forceGenerate {
            do { _ = try await host.generateBrief(job.roomId, supplement: job.supplement.isEmpty ? nil : job.supplement, mode: job.mode) }
            catch { job.error = "\(error)"; job.status = .failed; return }
        }
        job.briefId = host.latestBriefId(job.roomId)
        job.status = job.briefId == nil ? .failed : .ready
    }

    /// Drop the job + its badge (user dismissed the report after viewing).
    func clearBriefJob() { briefTask?.cancel(); briefTask = nil; briefJob = nil }
    private(set) var isDemo = false   // "Explore a demo" · sample data, no network
    private(set) var isNative = false // on-device engine · no server

    /// Load bundled sample data and show the app (no backend).
    func enterDemo() {
        isDemo = true
        rooms = DemoData.rooms
        agents = DemoData.agents
        phase = .ready
    }

    /// Enter the app on the on-device engine — no server. Seeds + loads the
    /// native roster (chair + directors) and any native rooms from the engine's
    /// GRDB so the creation picker and list reflect them.
    func enterNative() {
        isDemo = false; isNative = true
        FeatureFlag.nativeEngine = true
        let host = NativeEngineHost.shared
        // Point `app.api` at the in-process loopback server so the REST-shaped
        // views we reuse verbatim (API keys, avatar/stage assets, room-card
        // snapshot hydration) resolve against the on-device engine — no external
        // server, no ConnectView.
        if let url = host?.stageBaseURL { self.backend = Backend(baseURL: url, authToken: nil) }
        Task { await host?.recoverOnBoot(); await MainActor.run { self.loadNativeRoster() } }
        loadNativeRoster()
        rooms = host?.listRooms() ?? []
        phase = .ready
    }

    private func loadNativeRoster() {
        guard let host = NativeEngineHost.shared else { return }
        agents = host.listDirectors()
        chair = host.chairAgent()
    }

    /// True when an active LLM credential is configured (on-device engine). The UI
    /// gates room / director creation on this and prompts to set a key otherwise.
    var hasLLMKey: Bool {
        guard isNative else { return api != nil }
        guard let host = NativeEngineHost.shared else { return false }
        return EngineCredentialSource(db: host.db, keychain: KeychainCredentialStore()).activeLLMCredential() != nil
    }

    /// True when a voice/TTS credential is configured (any provider). The room
    /// gates switching to a voice room on this — no key ⇒ the directors would be
    /// silent, so prompt the user to add a TTS key first.
    var hasVoiceKey: Bool {
        guard isNative else { return false }
        return NativeEngineHost.shared?.activeVoiceProviderName() != nil
    }

    /// User display name (`prefs.name`) · set in onboarding, read by the chair.
    var userName: String { NativeEngineHost.shared?.userName() ?? "You" }
    func setUserName(_ name: String) { NativeEngineHost.shared?.setUserName(name) }

    /// Bumped when first-run onboarding finishes · HomeView watches it to lead the
    /// user straight into the starter-plays overlay (→ room composer).
    private(set) var starterPlaysNonce = 0
    func requestStarterPlays() { starterPlaysNonce += 1 }

    /// Insert a freshly-created room at the top of the list (native create).
    func addRoom(_ room: Room) { rooms.insert(room, at: 0) }

    /// Draft a director spec · native engine LLM (one-shot completion against the
    /// active LLM key) when on-device, else the REST server. The full 7-phase
    /// persona build stays server-only; native uses this quick signal draft.
    func generateSpec(_ description: String, webSearch: Bool) async throws -> GeneratedSpec {
        if isNative { return try await nativeGenerateSpec(description) }
        guard let api else { throw APIClient.APIError.badURL }
        return try await api.generateSpec(description, webSearch: webSearch)
    }

    private func nativeGenerateSpec(_ description: String) async throws -> GeneratedSpec {
        guard let host = NativeEngineHost.shared else { throw APIClient.APIError.badURL }
        let creds = EngineCredentialSource(db: host.db, keychain: KeychainCredentialStore())
        guard let active = creds.activeLLMCredential() else {
            throw APIClient.APIError.http(0, Loc.t("m_na_gen_fail"))
        }
        guard let modelV = Availability.utilityModel(active: active.carrier)
                ?? Availability.defaultModel(active: active.carrier) else {
            throw APIClient.APIError.http(0, Loc.t("m_na_gen_fail"))
        }
        let sys = """
        You draft a boardroom director profile from a short description. Output STRICT JSON only — \
        no prose, no code fence: {"name":"…","roleTag":"…(2-3 word title)","bio":"…(one or two sentences \
        on how they think)","instruction":"…(role · objectives · voice · boundaries, 3-6 sentences)"}. \
        Match the language of the description.
        """
        let req = LLMRequest(modelV: modelV.rawValue,
                             messages: [LLMMessage(role: .system, content: sys),
                                        LLMMessage(role: .user, content: "Description:\n\(description)")],
                             maxTokens: 700)
        var text = ""
        for try await chunk in LLMAdapter(credentials: creds).stream(req) {
            if case .textDelta(let d) = chunk { text += d }
        }
        guard let spec = Self.decodeSpec(text, fallbackModel: modelV.rawValue) else {
            throw APIClient.APIError.http(200, Loc.t("m_na_gen_fail"))
        }
        return spec
    }

    /// Pull the JSON object out of the LLM's reply and decode it · pin `modelV`
    /// to a reachable native model so the saved director isn't stuck on an
    /// unreachable default.
    private static func decodeSpec(_ raw: String, fallbackModel: String) -> GeneratedSpec? {
        guard let s = raw.firstIndex(of: "{"), let e = raw.lastIndex(of: "}"), s < e else { return nil }
        guard var obj = (try? JSONSerialization.jsonObject(with: Data(raw[s...e].utf8))) as? [String: Any] else { return nil }
        if (obj["modelV"] as? String)?.isEmpty != false { obj["modelV"] = fallbackModel }
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
        return try? JSONDecoder().decode(GeneratedSpec.self, from: data)
    }

    /// In-memory draft of the New Room composer · so accidentally dismissing the
    /// sheet (swipe-down) and reopening preserves the typed subject + selections
    /// instead of resetting. Cleared once a room is actually created. Default-flow
    /// only — scenario / follow-up rooms seed their own fields.
    struct NewRoomDraft {
        var subject = ""
        var tone = "brainstorm"
        var intensity = "sharp"
        var delivery = "voice"
        var autoPick = true
        var selected: Set<String> = []
        /// A pristine draft (nothing typed, all defaults) isn't worth keeping.
        var isPristine: Bool {
            subject.trimmingCharacters(in: .whitespaces).isEmpty && autoPick
                && selected.isEmpty && tone == "brainstorm" && delivery == "voice" && intensity == "sharp"
        }
    }
    var newRoomDraft: NewRoomDraft?

    /// Create a room through the active backend — native engine or REST server.
    /// One injection point so `NewRoomView` is backend-agnostic.
    func createRoom(subject: String, mode: String, intensity: String, deliveryMode: String,
                    autoPick: Bool, agentIds: [String], parentRoomId: String?) async throws -> Room {
        if isNative, let host = NativeEngineHost.shared {
            let id = try await host.createRoom(subject: subject, mode: mode, intensity: intensity,
                                               deliveryMode: deliveryMode, agentIds: autoPick ? [] : agentIds,
                                               parentRoomId: parentRoomId)
            guard let room = try await host.backend.getRoom(id).room else {
                throw NSError(domain: "native", code: 1)
            }
            return room
        }
        guard let api else { throw APIClient.APIError.badURL }
        return try await api.createRoom(subject: subject, mode: mode, intensity: intensity,
                                        deliveryMode: deliveryMode, autoPick: autoPick,
                                        agentIds: agentIds, parentRoomId: parentRoomId)
    }

    /// Adjourn a room (live → adjourned). The closing report, when wanted, is
    /// generated lazily by `NativeBriefView` (with the user's supplement) so the
    /// adjourn overlay never blocks on the brief LLM call.
    func adjournRoom(_ roomId: String) async {
        if isNative { await NativeEngineHost.shared?.adjourn(roomId); return }
        try? await api?.adjournRoom(roomId)
    }

    init() {
        // Launch into the demo when BB_DEMO=1 (used for headless screenshots).
        if ProcessInfo.processInfo.environment["BB_DEMO"] == "1" {
            self.backend = nil
            self.isDemo = true
            self.rooms = DemoData.rooms
            self.agents = DemoData.agents
            self.phase = .ready
            return
        }
        // Native-only · the on-device engine is the sole backend. No saved server,
        // no ConnectView — boot straight into the engine.
        self.phase = .loading
        enterNative()
    }

    var api: APIClient? { backend.map { APIClient(backend: $0) } }

    /// Set (or change) the backend, persist it, and load.
    func connect(_ backend: Backend) {
        self.backend = backend
        BackendStore.save(backend)
        Task { await refresh() }
    }

    func removeRoom(_ id: String) { rooms.removeAll { $0.id == id } }

    /// Reflect a profile edit back into the roster so the Directors list reads
    /// the new bio / role / model immediately.
    func replaceAgent(_ a: Agent) {
        if chair?.id == a.id { chair = a }
        if let i = agents.firstIndex(where: { $0.id == a.id }) { agents[i] = a }
    }

    /// Apply a room's known status to the cached list (pause / resume / adjourn).
    /// Called on return from a room so the card flips immediately — the engine's
    /// status write is async and can land after `reloadRooms` reads the DB, so the
    /// session's in-hand status is the authoritative override.
    func setRoomStatus(_ id: String, _ status: RoomStatus) {
        if let i = rooms.firstIndex(where: { $0.id == id }), rooms[i].status != status {
            rooms[i].status = status
        }
    }

    /// Drop a deleted director from the roster.
    func dropAgent(_ id: String) {
        agents.removeAll { $0.id == id }
        if chair?.id == id { chair = nil }
    }

    /// The directors tab roster · chair first, then the directors.
    var roster: [Agent] { (chair.map { [$0] } ?? []) + agents }

    /// Directors shown on a room card · hydrated members (real rooms) first,
    /// else the room's directorIds resolved against the roster (demo / when the
    /// list endpoint already carries ids).
    func directors(for room: Room) -> [Agent] {
        if let cached = roomDirectorCache[room.id], !cached.isEmpty { return cached }
        guard let ids = room.directorIds, !ids.isEmpty else { return [] }
        let byId = Dictionary(roster.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return ids.compactMap { byId[$0] }
    }

    /// Load the roster if it isn't loaded yet (Directors tab entry point).
    func ensureAgentsLoaded() async {
        if isNative { if agents.isEmpty { loadNativeRoster() }; return }
        guard !isDemo, agents.isEmpty, let api else { return }
        await loadAgents(api)
    }

    /// Force-refresh the roster (after creating / editing a director).
    func reloadAgents() async {
        if isNative { loadNativeRoster(); return }
        guard !isDemo, let api else { return }
        await loadAgents(api)
    }

    private func loadAgents(_ api: APIClient) async {
        do {
            let res = try await api.listAgents()
            agents = res.agents; chair = res.chair; agentsError = nil
        } catch {
            agentsError = (error as? APIClient.APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Fill in each room's directors from its member list (the `/api/rooms`
    /// list endpoint omits members). Cached so re-renders never re-fetch.
    func hydrateRoomDirectors() async {
        guard let api else { return }
        for room in rooms where roomDirectorCache[room.id] == nil {
            guard let snap = try? await api.getRoom(room.id) else { continue }
            let dirs = (snap.members ?? [])
                .filter { $0.roleKind != "moderator" && $0.roleKind != "chair" }
                .map { Agent(member: $0) }
            roomDirectorCache[room.id] = dirs
        }
    }

    func forgetBackend() {
        backend = nil
        BackendStore.save(nil)
        rooms = []
        phase = .needsBackend
    }

    /// App returned to foreground from background · the loopback socket may have
    /// been reclaimed by iOS while suspended (symptom: every director avatar goes
    /// blank AND the configured API keys read empty — both are loopback-served —
    /// until an app restart). Revive the socket, re-point the backend if the port
    /// changed, then reload rooms + roster so blank views repaint.
    /// Bumped on every foreground recovery · avatar (and any loopback-served image)
    /// views fold this into their URL to force `AsyncImage` to RE-fetch after a
    /// socket restart. Needed because a restart on the SAME port leaves `baseURL`
    /// unchanged, so nothing else would invalidate the cached (failed) loads.
    private(set) var assetReloadToken = 0

    func handleForeground() {
        guard isNative else { return }
        Task {
            if let host = NativeEngineHost.shared {
                if let url = await host.ensureLoopbackAlive() {
                    if backend?.baseURL != url { backend = Backend(baseURL: url, authToken: nil) }
                } else {
                    // Socket still dead after a rebind attempt → tell the user instead
                    // of silently degrading to blank avatars + an empty API-keys list.
                    AppNotice.post(kind: .reconnect, message: Loc.t("m_reconnect_msg"))
                }
            }
            assetReloadToken += 1     // force avatar/image views to re-fetch from the (possibly same-port) revived socket
            await refresh()
        }
    }

    /// Lightweight rooms-only reload · re-reads the room rows (incl. `status`) so
    /// the home list reflects pause / resume / adjourn the moment the user navigates
    /// back from a room — without it the list stayed `live` until an app restart.
    /// The director-avatar cache (`roomDirectorCache`) is keyed by room id and
    /// survives the array replacement, so cards don't flicker. Skips the roster /
    /// phase churn that the heavier `refresh()` does.
    /// Room ids that have a generated report (closing brief) · room cards badge it.
    /// Native-only (REST mode has no native brief store here).
    var reportRoomIds: Set<String> = []

    func reloadRooms() async {
        if isNative {
            if let host = NativeEngineHost.shared { rooms = host.listRooms(); reportRoomIds = host.roomsWithBriefs() }
            return
        }
        guard let api else { return }
        if let fresh = try? await api.listRooms() { rooms = fresh }
    }

    /// A sync just merged peers' changes into the local DB · re-read rooms + roster
    /// and bump the asset token so director avatars re-fetch. Lets iCloud updates
    /// appear live instead of only after an app restart.
    func applySyncedChanges() {
        guard isNative else { return }
        assetReloadToken += 1
        Task { await refresh() }
    }

    func refresh() async {
        // Native engine · rooms + roster come from the in-process GRDB, not REST.
        if isNative {
            rooms = NativeEngineHost.shared?.listRooms() ?? []
            reportRoomIds = NativeEngineHost.shared?.roomsWithBriefs() ?? []
            loadNativeRoster()
            phase = .ready
            Task { await hydrateRoomDirectors() }
            Task { await checkStaleModels() }       // refresh the Settings model badge
            return
        }
        guard let api else { phase = .needsBackend; return }
        if rooms.isEmpty { phase = .loading }
        do {
            rooms = try await api.listRooms()
            await loadAgents(api)               // captures agentsError; doesn't fail the screen
            phase = .ready
            Task { await hydrateRoomDirectors() }   // fill room-card avatars in the background
            Task { await checkStaleModels() }
        } catch {
            let msg = (error as? APIClient.APIError)?.errorDescription ?? error.localizedDescription
            phase = .error(msg)
        }
    }

    /// Launch / resume check · flag the Settings badge when any director is on a
    /// model the active key can no longer reach. Purely a read (the loopback's
    /// `/api/models` resolves stale agents with the SAME predicate routing uses),
    /// so it's safe to run on every refresh; the badge clears once the user resets.
    func checkStaleModels() async {
        guard hasLLMKey, let catalog = try? await api?.modelCatalog() else {
            modelsNeedAttention = false; return
        }
        modelsNeedAttention = !(catalog.staleAgents ?? []).isEmpty
    }

    /// Rooms grouped into Live → Paused → Adjourned, empty groups dropped,
    /// recency order preserved within each — mirrors the web list grouping.
    var groupedRooms: [(status: RoomStatus, rooms: [Room])] {
        let order: [RoomStatus] = [.live, .paused, .adjourned]
        return order.compactMap { status in
            let items = rooms.filter { $0.bucket == status }
            return items.isEmpty ? nil : (status, items)
        }
    }
}
