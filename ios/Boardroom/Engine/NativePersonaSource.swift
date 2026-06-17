import Foundation
import GRDB
import BoardroomEngine
import BoardroomStorage
import BoardroomSearch

/// On-device witness for `PersonaEventSource` — the native counterpart of the
/// server SSE persona build. Mints a jobId, runs the engine's streaming 7-phase
/// `PersonaBuilder.buildFullStreaming` in a cancellable Task, maps each engine
/// `PersonaBuildEvent` onto the app's `PersonaEvent` (so the existing
/// `PersonaBuildView` UI renders identically), buffers events until the model's
/// stream attaches (hello-style hydration), and finishes by inserting the agent
/// row from the cached `BuiltPersona` on `savePersona`. Web research is wired to
/// `BoardroomSearch.WebSearch` + the active on-device search credential.
final class NativePersonaSource: PersonaEventSource, @unchecked Sendable {
    static let shared = NativePersonaSource()
    private init() {}

    private final class Job {
        let description: String
        var task: Task<Void, Never>?
        var buffer: [PersonaEvent] = []
        var continuation: AsyncStream<PersonaEvent>.Continuation?
        var built: PersonaBuilder.BuiltPersona?
        init(description: String) { self.description = description }
    }
    private let lock = NSLock()
    private var jobs: [String: Job] = [:]

    private var host: NativeEngineHost? { NativeEngineHost.shared }

    // MARK: PersonaEventSource

    func generatePersona(_ description: String, locale: String) async throws -> String {
        pruneStale()                                  // reclaim abandoned completed builds
        let jobId = UUID().uuidString
        let job = Job(description: description)
        lock.lock(); jobs[jobId] = job; lock.unlock()
        let task = Task { [weak self] in
            guard let self else { return }
            await self.runBuild(jobId: jobId, description: description)
        }
        lock.lock(); job.task = task; lock.unlock()
        return jobId
    }

    func personaEvents(_ jobId: String) -> AsyncStream<PersonaEvent> {
        AsyncStream { cont in
            lock.lock()
            guard let job = jobs[jobId] else { lock.unlock(); cont.finish(); return }
            for ev in job.buffer { cont.yield(ev) }                  // replay (hydration)
            if job.buffer.last?.isTerminal == true { lock.unlock(); cont.finish(); return }
            job.continuation = cont
            lock.unlock()
            cont.onTermination = { [weak self] _ in
                self?.lock.lock(); self?.jobs[jobId]?.continuation = nil; self?.lock.unlock()
            }
        }
    }

    func abortPersona(_ jobId: String) async throws {
        lock.lock(); let t = jobs[jobId]?.task; jobs[jobId] = nil; lock.unlock()   // user gave up · reclaim
        t?.cancel()
    }

    /// Drop completed-but-abandoned builds (the consumer detached without saving,
    /// so their continuation is gone and the cached BuiltPersona is dead weight).
    private func pruneStale() {
        lock.lock()
        for (id, job) in jobs where job.continuation == nil && job.built != nil { jobs[id] = nil }
        lock.unlock()
    }

    @discardableResult
    func savePersona(jobId: String, name: String, role: String, bio: String,
                     instruction: String, modelV: String,
                     coverQuote: String?, ability: [String: Double]?,
                     avatarPath: String?, avatar3d: [String: Any]?) async throws -> Agent? {
        lock.lock(); let built = jobs[jobId]?.built; let desc = jobs[jobId]?.description ?? ""; lock.unlock()
        guard let built, let host else {
            throw NSError(domain: "persona", code: 2, userInfo: [NSLocalizedDescriptionKey: "Build result unavailable — try again."])
        }
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty else { throw NSError(domain: "persona", code: 3, userInfo: [NSLocalizedDescriptionKey: "Name required."]) }
        let roleTag = role.trimmingCharacters(in: .whitespaces).isEmpty ? "director" : role.trimmingCharacters(in: .whitespaces)
        let instr = instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? PersonaBuilder.synthesizeInstruction(built, name: n, roleTag: roleTag, description: desc)
            : instruction
        let bioFinal = bio.trimmingCharacters(in: .whitespaces).isEmpty ? (built.spec.contrarianTakes.first ?? "") : bio
        let cq = (coverQuote?.trimmingCharacters(in: .whitespaces)).flatMap { $0.isEmpty ? nil : $0 }
            ?? built.spec.contrarianTakes.first ?? ""
        let specJSON = PersonaBuilder.personaSpecJSONFull(built, description: desc, generatedAt: Self.isoNow())
        let model = modelV.isEmpty ? (host.router.defaultModelV()?.rawValue ?? "sonnet-4-6") : modelV
        let abilityJSON: String = ability.flatMap { try? JSONSerialization.data(withJSONObject: $0) }
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let av = (avatarPath?.isEmpty == false ? avatarPath! : "")
        let avatar3dJSON: String? = avatar3d.flatMap { try? JSONSerialization.data(withJSONObject: $0) }
            .flatMap { String(data: $0, encoding: .utf8) }
        let id = UUID().uuidString
        // Sanitize even the LLM-emitted handle (it lands in the UNIQUE handle
        // column; the model routinely violates "lowercase snake_case ≤16").
        var handle = Self.deriveHandle((built.name?.handle).flatMap { $0.isEmpty ? nil : $0 } ?? n)
        try await host.db.pool.write { conn in
            let base = handle; var suffix = 1
            while (try Int.fetchOne(conn, sql: "SELECT COUNT(*) FROM agents WHERE handle = ?", arguments: [handle]) ?? 0) > 0 {
                suffix += 1; handle = "\(base)\(suffix)"
            }
            let now = Int(Date().timeIntervalSince1970 * 1000)
            try conn.execute(sql: """
                INSERT INTO agents (id, name, handle, role_tag, role_kind, bio, cover_quote, instruction,
                                    model_v, avatar_path, persona_spec_json, ability_json, is_seed, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'director', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                """, arguments: [id, n, handle, roleTag, bioFinal, cq, instr, model, av, specJSON, abilityJSON, now, now])
            if let a3 = avatar3dJSON {
                try conn.execute(sql: "UPDATE agents SET avatar3d_json = ? WHERE id = ?", arguments: [a3, id])
            }
        }
        lock.lock(); jobs[jobId] = nil; lock.unlock()
        return nil   // NewDirectorView reloads the roster from GRDB; no echo needed
    }

    // MARK: Build driver

    private func runBuild(jobId: String, description: String) async {
        guard let host else {
            emit(jobId, .error("Engine unavailable. Set an LLM key in Settings → API keys."))
            return
        }
        let webSearch = makeWebSearch()
        let built = await PersonaBuilder.buildFullStreaming(
            router: host.router, description: description, webSearch: webSearch,
            onEvent: { [weak self] e in self?.mapAndEmit(jobId, e) })
        if let built {
            lock.lock(); jobs[jobId]?.built = built; lock.unlock()
            emit(jobId, .final(Self.finalPayload(built, description: description)))
        } else if Task.isCancelled {
            emit(jobId, .aborted)
        } else {
            emit(jobId, .error("Couldn't draft the persona — check your model key in Settings."))
        }
    }

    /// Map an engine progress frame onto the app's PersonaEvent(s).
    private func mapAndEmit(_ jobId: String, _ e: PersonaBuilder.PersonaBuildEvent) {
        switch e {
        case let .phaseStart(phase, label, eta, pct):
            emit(jobId, .phaseStart(phase: phase, label: label, etaSec: eta))
            emit(jobId, .phaseProgress(phase: phase, detail: "", progressPct: pct, partial: nil))
        case let .phaseProgress(phase, detail, pct):
            emit(jobId, .phaseProgress(phase: phase, detail: detail, progressPct: pct, partial: nil))
        case let .phaseEnd(phase, pct, sources, rules, voice, checks):
            emit(jobId, .phaseEnd(phase: phase, progressPct: pct,
                                  partial: Self.partial(sources: sources, rules: rules, voice: voice, checks: checks)))
        case let .dimensionPlan(dims):
            emit(jobId, .dimensionPlan(dims.map { PersonaDimension(dimension: $0.dimension, query: $0.query, why: $0.why) }))
        case let .searchRound(round, query, rc, pr, dim):
            emit(jobId, .searchRound(PersonaSearchRound(round: round, query: query, resultsCount: rc, pagesRead: pr, dimension: dim)))
        }
    }

    private func emit(_ jobId: String, _ ev: PersonaEvent) {
        lock.lock()
        guard let job = jobs[jobId] else { lock.unlock(); return }
        job.buffer.append(ev)
        let cont = job.continuation
        lock.unlock()
        cont?.yield(ev)
        if ev.isTerminal {
            cont?.finish()
            // .error/.aborted need no save → reclaim now. .final stays until
            // savePersona reads the cached build (or pruneStale reclaims it).
            if case .final = ev {} else { lock.lock(); jobs[jobId] = nil; lock.unlock() }
        }
    }

    // MARK: Web search wiring

    private func makeWebSearch() -> PersonaBuilder.PersonaWebSearch {
        guard let host, let (backend, key) = activeSearchCredential(host.db) else { return .disabled }
        let ws = WebSearch()
        return .init(enabled: true, search: { query in
            guard let results = await ws.run(backend, apiKey: key, query: query), !results.isEmpty else { return nil }
            return (context: WebSearch.formatResults(query: query, results: results),
                    resultsCount: results.count, pagesRead: results.count)
        })
    }

    private func activeSearchCredential(_ db: BoardroomDB) -> (SearchBackend, String)? {
        let row: (String, String)? = (try? db.pool.read { conn -> (String, String)? in
            guard let id = try String.fetchOne(conn, sql: "SELECT active_search_credential_id FROM prefs WHERE id = 1"),
                  let provider = try String.fetchOne(conn, sql: "SELECT provider FROM search_credentials WHERE id = ?", arguments: [id])
            else { return nil }
            return (id, provider)
        }) ?? nil
        guard let (id, provider) = row, let backend = SearchBackend(rawValue: provider),
              let key = KeychainCredentialStore().key(.search, id: id) else { return nil }
        return (backend, key)
    }

    // MARK: Final payload + helpers

    private static func finalPayload(_ built: PersonaBuilder.BuiltPersona, description: String) -> PersonaFinal {
        let name = built.name?.name ?? ""
        let instruction = PersonaBuilder.synthesizeInstruction(
            built, name: name.isEmpty ? "this director" : name, roleTag: "director", description: description)
        let bio = built.spec.contrarianTakes.first ?? built.spec.loadBearingConcepts.first ?? String(description.prefix(160))
        let coverQuote = built.spec.contrarianTakes.first ?? built.spec.loadBearingConcepts.first
        let abilityText = [bio, description,
                           built.spec.contrarianTakes.joined(separator: " "),
                           built.spec.loadBearingConcepts.joined(separator: " "),
                           built.spec.failureModes.joined(separator: " ")].joined(separator: " ")
        return PersonaFinal(instruction: instruction, bio: bio, coverQuote: coverQuote,
                            guessName: built.name?.name, guessRoleTag: nil, ability: synthesizeAbility(abilityText))
    }

    /// Keyword-heuristic ability radar (port of the desktop `synthesizeAbility`) ·
    /// 6 axes 0–10, with damped weak points + a guaranteed peak so the radar is
    /// never flat. No LLM call.
    private static func synthesizeAbility(_ text: String) -> [String: Double] {
        let t = text.lowercased()
        let axes = ["dissent", "pattern_recall", "rigor", "empathy", "narrative", "decisiveness"]
        let matches: [String: [String]] = [
            "dissent": ["skeptic", "challenge", "push back", "contrar", "devil", "question", "interrogat", "refus", "disagree"],
            "pattern_recall": ["history", "pattern", "precedent", "analogue", "analog", "case stud", "track record", "memory", "historic", "horizon", "long.?cycle", "investor"],
            "rigor": ["rigor", "precise", "first principle", "physic", "logic", "evidence", "proof", "quantit", "math", "scientif", "numerical"],
            "empathy": ["empath", "user", "customer", "human", "story", "care", "experience", "persona", "emotion", "stakeholder", "absent"],
            "narrative": ["story", "narrativ", "scenario", "arc", "vision", "imagin", "metaphor", "journey", "craft", "writer"],
            "decisiveness": ["decid", "decisive", "commit", "cut", "force a call", "executive", "operator", "ship", "priorit", "act"],
        ]
        func hits(_ pats: [String]) -> Int { pats.reduce(0) { $0 + (t.range(of: $1, options: .regularExpression) != nil ? 1 : 0) } }
        var out: [String: Double] = [:]
        for axis in axes {
            let h = hits(matches[axis] ?? [])
            out[axis] = h >= 3 ? 9 : (h == 2 ? 8 : (h == 1 ? 7 : 5))
        }
        var damped = 0
        for axis in axes.sorted(by: { (out[$0] ?? 0) < (out[$1] ?? 0) }) {
            if damped >= 2 { break }
            if out[axis] == 5 { out[axis] = 3; damped += 1 }
        }
        if (out.values.max() ?? 0) <= 5 { out[axes[text.count % axes.count]] = 8 }
        return out
    }

    /// Synthesize a `PersonaPartial` carrying just the counts the live stats grid
    /// reads (the UI only uses array LENGTHS).
    private static func partial(sources: Int, rules: Int, voice: Int, checks: Int) -> PersonaPartial {
        PersonaPartial(
            knowledge: .init(keyThinkers: Array(repeating: .init(), count: max(0, sources)),
                             foundationalWorks: nil, recentDevelopments: nil, contestedClaims: nil),
            rules: Array(repeating: .init(), count: max(0, rules)),
            fewShot: Array(repeating: .init(), count: max(0, voice)),
            reflectionChecklist: Array(repeating: "", count: max(0, checks)))
    }

    private static func deriveHandle(_ name: String) -> String {
        let slug = name.lowercased().unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "_" }
        var h = String(slug).replacingOccurrences(of: "__+", with: "_", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        if h.count > 16 { h = String(h.prefix(16)) }
        return h.isEmpty ? "director" : h
    }
    private static func isoNow() -> String { ISO8601DateFormatter().string(from: Date()) }
}

/// `EngineSearch` (#10) over `BoardroomSearch.WebSearch` + the active search
/// credential, resolved LIVE from the DB + keychain on every call so a Brave /
/// Tavily key configured after launch takes effect without a restart (same
/// pattern as the TTS adapter). Returns nil on no-key / no-results / failure —
/// the engine never strands a turn on a search miss. Lives here (vs its own file)
/// because this file already imports the full module set the adapter needs and
/// is registered in the Xcode project's compile sources.
struct SearchEngineAdapter: EngineSearch {
    let db: BoardroomDB

    var hasKey: Bool { Self.activeCredential(db) != nil }

    func run(_ query: String) async -> EngineSearchOutput? {
        guard let (backend, key) = Self.activeCredential(db),
              let results = await WebSearch().run(backend, apiKey: key, query: query),
              !results.isEmpty else { return nil }
        let materials = WebSearch.formatResults(query: query, results: results)
        let sources = results.map { EngineSearchSource(title: $0.title, url: $0.url, description: $0.description) }
        return EngineSearchOutput(materials: materials, sources: sources)
    }

    /// (backend, apiKey) for the user's active search credential, or nil when none
    /// configured / key missing. nonisolated sync read — safe off the engine actor.
    static func activeCredential(_ db: BoardroomDB) -> (SearchBackend, String)? {
        let row: (String, String)? = (try? db.pool.read { conn -> (String, String)? in
            guard let id = try String.fetchOne(conn, sql:
                    "SELECT active_search_credential_id FROM prefs WHERE id = 1"),
                  let provider = try String.fetchOne(conn, sql:
                    "SELECT provider FROM search_credentials WHERE id = ?", arguments: [id])
            else { return nil }
            return (id, provider)
        }) ?? nil
        guard let (id, provider) = row, let backend = SearchBackend(rawValue: provider),
              let key = KeychainCredentialStore().key(.search, id: id) else { return nil }
        return (backend, key)
    }
}
