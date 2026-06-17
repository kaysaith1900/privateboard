import Foundation
import BoardroomCore
import BoardroomAI

/// Streaming, 7-phase on-device full-persona build — the engine half of the
/// native counterpart to the desktop `runPipeline` SSE job. Runs Phase 1 profile
/// → Phase 2 web research (planDimensions + per-dimension search via an injected
/// closure) → Phase 3 web-grounded profile → 4 rules → 5 few-shot → 6 reflection
/// → 7 eval + name, emitting a `PersonaBuildEvent` at every boundary so the app's
/// `NativePersonaSource` can map them onto the existing `PersonaBuildView` UI.
/// Web search is INJECTED (the app owns `BoardroomSearch` + the credential), so
/// this package needs no search dependency. Cooperative `Task.isCancelled` checks
/// at each phase boundary let the UI's ABORT button cancel mid-build.
extension PersonaBuilder {

    /// Progress frames mapped 1:1 onto the UI's 7-phase quest checklist.
    public enum PersonaBuildEvent: Sendable {
        public struct Dimension: Sendable { public let dimension: String; public let query: String; public let why: String? }
        case phaseStart(phase: Int, label: String, etaSec: Double, progressPct: Double)
        case phaseProgress(phase: Int, detail: String, progressPct: Double)
        case phaseEnd(phase: Int, progressPct: Double, sources: Int, rules: Int, voice: Int, checks: Int)
        case dimensionPlan([Dimension])
        case searchRound(round: Int, query: String, resultsCount: Int, pagesRead: Int, dimension: String?)
    }

    /// Injected web-search seam · the app wires this to `BoardroomSearch.WebSearch`
    /// + the active search credential. `search(query)` returns a formatted context
    /// block + counts, or nil (no key / failure → the build proceeds model-only).
    public struct PersonaWebSearch: Sendable {
        public let enabled: Bool
        public let search: @Sendable (_ query: String) async -> (context: String, resultsCount: Int, pagesRead: Int)?
        public init(enabled: Bool,
                    search: @escaping @Sendable (_ query: String) async -> (context: String, resultsCount: Int, pagesRead: Int)?) {
            self.enabled = enabled; self.search = search
        }
        public static let disabled = PersonaWebSearch(enabled: false, search: { _ in nil })
    }

    /// Wall-clock ETA weights per phase (match `PersonaBuildView` exactly).
    private static let phaseEtas: [Double] = [30, 280, 30, 45, 90, 30, 60]

    /// The streaming build. Returns the assembled `BuiltPersona`, or nil on
    /// load-bearing-profile failure / cancellation (the caller maps nil-after-
    /// cancel → aborted, nil-otherwise → error).
    public static func buildFullStreaming(
        router: EngineRouter,
        description: String,
        webSearch: PersonaWebSearch,
        onEvent: @Sendable (PersonaBuildEvent) async -> Void
    ) async -> BuiltPersona? {
        let total = phaseEtas.reduce(0, +)
        // progress % at the START of a 1-based phase (cumulative ETA fraction).
        func cum(_ phase: Int) -> Double { phaseEtas.prefix(max(0, phase - 1)).reduce(0, +) / total * 100 }
        func cancelled() -> Bool { Task.isCancelled }

        // ── Phase 1 · profile v1 (load-bearing) ─────────────────────────────
        await onEvent(.phaseStart(phase: 1, label: "Persona spec", etaSec: phaseEtas[0], progressPct: cum(1)))
        guard let v1 = await buildProfile(router: router, description: description) else { return nil }
        if cancelled() { return nil }
        var profile = v1
        var core = toCore(v1)
        await onEvent(.phaseEnd(phase: 1, progressPct: cum(2), sources: 0, rules: 0, voice: 0, checks: 0))

        // ── Phase 2 · web research (dimension plan → search rounds) ─────────
        await onEvent(.phaseStart(phase: 2, label: "Knowledge context", etaSec: phaseEtas[1], progressPct: cum(2)))
        var webContext = ""
        var sources = 0
        if webSearch.enabled, let model = router.pickerModelV() {
            await onEvent(.phaseProgress(phase: 2, detail: "planning research dimensions", progressPct: cum(2)))
            let dims = await planDimensions(router: router, model: model, description: description, profile: v1)
            if !dims.isEmpty {
                await onEvent(.dimensionPlan(dims.map { .init(dimension: $0.dimension, query: $0.query, why: $0.why) }))
                var round = 0
                for d in dims {
                    if cancelled() { return nil }
                    round += 1
                    await onEvent(.phaseProgress(phase: 2, detail: "researching · \(d.dimension)", progressPct: cum(2)))
                    let res = await webSearch.search(d.query)
                    let rc = res?.resultsCount ?? 0
                    let pr = res?.pagesRead ?? 0
                    if let ctx = res?.context, !ctx.isEmpty {
                        webContext += (webContext.isEmpty ? "" : "\n\n") + ctx
                        sources += rc
                    }
                    await onEvent(.searchRound(round: round, query: d.query, resultsCount: rc, pagesRead: pr, dimension: d.dimension))
                }
            }
        }
        await onEvent(.phaseEnd(phase: 2, progressPct: cum(3), sources: sources, rules: 0, voice: 0, checks: 0))
        if cancelled() { return nil }

        // ── Phase 3 · web-grounded profile v2 (only when we gathered context) ─
        await onEvent(.phaseStart(phase: 3, label: "Persona spec (refined)", etaSec: phaseEtas[2], progressPct: cum(3)))
        if !webContext.isEmpty, let v2 = await buildProfile(router: router, description: description, webContext: webContext) {
            profile = v2
            core = toCore(v2)
        }
        await onEvent(.phaseEnd(phase: 3, progressPct: cum(4), sources: sources, rules: 0, voice: 0, checks: 0))
        if cancelled() { return nil }

        let knowledgeSummary = webContext.isEmpty ? "" : personaTruncate(webContext, 6000)

        // ── Phase 4 · behavioural rules ─────────────────────────────────────
        await onEvent(.phaseStart(phase: 4, label: "Behavioural rules", etaSec: phaseEtas[3], progressPct: cum(4)))
        let rules = await buildRules(router: router, description: description, profile: profile, knowledgeSummary: knowledgeSummary)
        if cancelled() { return nil }
        await onEvent(.phaseEnd(phase: 4, progressPct: cum(5), sources: sources, rules: rules.count, voice: 0, checks: 0))

        // ── Phase 5 · few-shot examples ─────────────────────────────────────
        await onEvent(.phaseStart(phase: 5, label: "Few-shot examples", etaSec: phaseEtas[4], progressPct: cum(5)))
        let fewShot = await buildFewShot(router: router, description: description, profile: profile, rules: rules)
        if cancelled() { return nil }
        await onEvent(.phaseEnd(phase: 5, progressPct: cum(6), sources: sources, rules: rules.count, voice: fewShot.count, checks: 0))

        // ── Phase 6 · reflection checklist ──────────────────────────────────
        await onEvent(.phaseStart(phase: 6, label: "Reflection checklist", etaSec: phaseEtas[5], progressPct: cum(6)))
        let reflection = await buildReflection(router: router, description: description, profile: profile, fewShotCount: fewShot.count)
        if cancelled() { return nil }
        await onEvent(.phaseEnd(phase: 6, progressPct: cum(7), sources: sources, rules: rules.count, voice: fewShot.count, checks: reflection.count))

        // ── Phase 7 · eval set + name ───────────────────────────────────────
        await onEvent(.phaseStart(phase: 7, label: "Eval set + name", etaSec: phaseEtas[6], progressPct: cum(7)))
        let evalSet = await buildEval(router: router, description: description, profile: profile)
        if cancelled() { return nil }
        let name = await buildName(router: router, description: description, profile: profile)
        await onEvent(.phaseEnd(phase: 7, progressPct: 100, sources: sources, rules: rules.count, voice: fewShot.count, checks: reflection.count))

        return BuiltPersona(spec: core, rules: rules, fewShot: fewShot,
                            reflectionChecklist: reflection, evalSet: evalSet, name: name)
    }

    // MARK: Phase 2a · dimension planner

    struct PlannedDimension: Sendable { let dimension: String; let query: String; let why: String? }

    static func planDimensions(router: EngineRouter, model: ModelV, description: String, profile: AgentProfile) async -> [PlannedDimension] {
        let user = [
            "User description of the director:", "", description.trimmingCharacters(in: .whitespaces), "",
            "First-pass profile (for grounding the angles):", "", "```json", profileJSON(profile), "```", "",
            "Now produce the research dimensions JSON as specified.",
        ].joined(separator: "\n")
        guard let raw = try? await router.call(
            [LLMMessage(role: .system, content: dimensionSystem), LLMMessage(role: .user, content: user)],
            modelV: model, temperature: 0.4, maxTokens: 900) else { return [] }
        guard let obj = PickerSupport.dict(PickerSupport.extractJson(raw)), let arr = obj["dimensions"] as? [Any] else { return [] }
        let seed = description.lowercased().trimmingCharacters(in: .whitespaces)
        var out: [PlannedDimension] = []
        var seen = Set<String>()       // unique queries
        var seenDims = Set<String>()   // unique dimension labels — the UI keys ID + checkmarks off these
        for e in arr {
            guard let d = e as? [String: Any],
                  let query = (d["query"] as? String)?.trimmingCharacters(in: .whitespaces),
                  query.split(whereSeparator: { $0 == " " }).count >= 3,
                  query.lowercased() != seed else { continue }
            guard seen.insert(query.lowercased()).inserted else { continue }
            let raw = (d["dimension"] as? String)?.trimmingCharacters(in: .whitespaces)
            let label = (raw?.isEmpty == false ? raw! : "angle \(out.count + 1)")
            guard seenDims.insert(label.lowercased()).inserted else { continue }   // distinct labels (no ForEach ID clash)
            out.append(PlannedDimension(dimension: label, query: PickerSupport.clip(query, 160),
                                        why: (d["why"] as? String)?.trimmingCharacters(in: .whitespaces)))
            if out.count >= 6 { break }
        }
        return out
    }
}
