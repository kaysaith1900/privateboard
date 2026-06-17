import Foundation
import BoardroomAI

/// Brief Stage 1.5 · the report composer (`composer.ts` + `runComposer` in
/// brief.ts). A cheap utility-model call picks (a) the house style, (b) the
/// spine, and (c) a subset of components for THIS room from the per-director
/// assets. The picked **spine** drives the native report.html render (loopback
/// serves it; report.html swaps in `report/spines/<spine>.css`), so the
/// composition is what makes the same room read as a different document.
/// Faithful port: verbatim SYSTEM_PROMPT (codegen'd into `brief-prompts.json`),
/// the asset-budget / tone / coverage user block, `parseComposerOutput`,
/// `validatePicks`, `defaultComposition`, and the prefs merge.
public enum BriefComposer {
    // MARK: catalogues (verbatim from composer.ts / house-styles.ts)

    static let spines: Set<String> = ["boardroom-dark", "a16z-thesis", "anthropic-essay",
                                      "gartner-note", "mckinsey-deck", "openai-paper"]
    static let componentKinds = ["bottom-line", "thesis", "working-hypothesis", "headline-findings",
        "big-ideas", "recommendations", "the-bet", "considerations", "frame-shift", "convergence",
        "divergence", "positions", "visuals", "two-paths", "why-now", "new-questions",
        "planning-assumption", "open-questions", "strategic-outlook", "critical-assumptions",
        "scenario-tree", "leading-indicators", "threats-to-validity", "metric-strip",
        "risk-register", "decision-options", "path-comparison"]
    static let kindSet = Set(componentKinds)
    static let anchorSet: Set<String> = ["bottom-line", "thesis", "working-hypothesis"]
    static let findingsSet: Set<String> = ["headline-findings", "big-ideas"]
    static let actionSet: Set<String> = ["recommendations", "the-bet", "considerations"]
    static let houseStyleIds: Set<String> = ["boardroom-default", "sequoia-memo", "a16z-thesis",
        "anthropic", "bcg-strategy", "first-round-essay", "gartner-research"]
    static let allowedSubjectTypes: Set<String> = ["investment-judgement", "option-comparison",
        "strategic-decision", "philosophical", "operational", "market-forecast", "retro", "other"]
    /// house-style id → its default spine (resolveHouseStyle(...).spine).
    static let houseStyleSpine: [String: String] = [
        "boardroom-default": "boardroom-dark", "sequoia-memo": "a16z-thesis", "a16z-thesis": "a16z-thesis",
        "anthropic": "anthropic-essay", "bcg-strategy": "mckinsey-deck", "first-round-essay": "anthropic-essay",
        "gartner-research": "gartner-note"]
    /// tone → (preferred, avoid) house-style ids (houseStylesForTone).
    static let toneHouseStyles: [String: (prefer: [String], avoid: [String])] = [
        "brainstorm": (["anthropic", "first-round-essay"], ["sequoia-memo", "a16z-thesis", "bcg-strategy", "gartner-research"]),
        "constructive": (["sequoia-memo", "a16z-thesis", "bcg-strategy", "gartner-research"], []),
        "debate": (["sequoia-memo", "a16z-thesis", "bcg-strategy"], ["anthropic", "first-round-essay"]),
        "research": (["anthropic", "first-round-essay", "gartner-research"], ["sequoia-memo", "a16z-thesis"]),
        "critique": (["bcg-strategy", "gartner-research"], ["a16z-thesis", "anthropic", "first-round-essay"])]
    /// The default 12-section preset (safety net).
    static let defaultPreset: [(kind: String, order: Int)] = [
        ("bottom-line", 1), ("metric-strip", 2), ("frame-shift", 3), ("headline-findings", 4),
        ("convergence", 5), ("divergence", 6), ("positions", 7), ("visuals", 8),
        ("risk-register", 9), ("new-questions", 10), ("open-questions", 11), ("recommendations", 12)]

    public struct Composition: Sendable, Equatable {
        public var spine: String
        public var components: [Component]
        public var rationale: String
        public var subjectType: String?
        public var houseStyle: String
        public var fromComposer: Bool
        public struct Component: Sendable, Equatable { public var kind: String; public var order: Int }
        /// components_json blob (matches the desktop `[{kind,order}]` shape).
        public var componentsJSON: String {
            let arr = components.map { ["kind": $0.kind, "order": $0.order] as [String: Any] }
            return (try? JSONSerialization.data(withJSONObject: arr)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        }
    }

    public static func defaultComposition(_ reason: String) -> Composition {
        Composition(spine: "boardroom-dark",
                    components: defaultPreset.map { .init(kind: $0.kind, order: $0.order) },
                    rationale: reason, subjectType: nil, houseStyle: "boardroom-default", fromComposer: false)
    }

    struct Coverage { var tensions = 0; var risks = 0; var openQuestions = 0; var actions = 0; var dataAvailable = 0 }

    // MARK: run (port of runComposer + mergeReportRenderPrefs)

    /// Pick the composition for a room. Falls back to `defaultComposition` on no
    /// assets / LLM failure / parse failure / validation failure. `prefsSpine` /
    /// `prefsHouseStyle` are the user's explicit overrides (prefs.reportSpine).
    public static func run(router: EngineRouter, subject: String, roomNumber: Int, roomName: String,
                           mode: String, intensity: String, members: [BriefStages.Member],
                           assets: [BriefAssets.DirectorAssets], language: String,
                           supplement: String? = nil, prefsSpine: String? = nil,
                           prefsHouseStyle: String? = nil) async -> Composition {
        let total = assets.reduce(0) { $0 + BriefAssets.countAssets($1) }
        guard total > 0 else { return merge(defaultComposition("no assets — fallback preset"), prefsSpine: prefsSpine, prefsHouseStyle: prefsHouseStyle) }
        guard let sys = BriefStages.catalog?.composer,
              let model = router.utilityModelV() ?? router.defaultModelV() else {
            return merge(defaultComposition("no utility model — fallback preset"), prefsSpine: prefsSpine, prefsHouseStyle: prefsHouseStyle)
        }
        let cov = Coverage(
            tensions: assets.reduce(0) { $0 + $1.tensions.count },
            risks: assets.reduce(0) { $0 + $1.risks.count },
            openQuestions: assets.reduce(0) { $0 + $1.openQuestions.count },
            actions: assets.reduce(0) { $0 + $1.actions.count },
            dataAvailable: assets.reduce(0) { $0 + $1.claims.filter { $0.lens == "data" }.count + $1.evidence.filter { $0.kind == "data" }.count })
        let langLine = language == "zh"
            ? "## Output language\n本次会议的 Initial Question 是中文。`rationale` 字段请用**简体中文**。其它字段（`spine`, `kind`, `subject_type`）保留英文枚举值不变。"
            : "## Output language\nThis room's Initial Question was in English. Produce the `rationale` field in English. The `spine`, `kind`, and `subject_type` fields are literal enum strings — never translate them."
        let user = buildUser(subject: subject, roomNumber: roomNumber, roomName: roomName, mode: mode,
                             intensity: intensity, members: members, assets: assets, total: total,
                             cov: cov, supplement: supplement)
        let msgs = [LLMMessage(role: .system, content: sys + "\n\n" + langLine), LLMMessage(role: .user, content: user)]
        guard let raw = try? await router.call(msgs, modelV: model, temperature: 0.2, maxTokens: 800),
              let parsed = parse(raw, coverage: cov) else {
            return merge(defaultComposition("composer failed — fallback preset"), prefsSpine: prefsSpine, prefsHouseStyle: prefsHouseStyle)
        }
        return merge(parsed, prefsSpine: prefsSpine, prefsHouseStyle: prefsHouseStyle)
    }

    /// Apply the user's explicit spine / house-style overrides (prefs).
    static func merge(_ c: Composition, prefsSpine: String?, prefsHouseStyle: String?) -> Composition {
        var out = c
        if let s = prefsSpine?.trimmingCharacters(in: .whitespaces), spines.contains(s) { out.spine = s }
        if let h = prefsHouseStyle?.trimmingCharacters(in: .whitespaces), houseStyleIds.contains(h) { out.houseStyle = h }
        return out
    }

    // MARK: parse + validate (port of parseComposerOutput / validatePicks)

    static func parse(_ raw: String, coverage cov: Coverage) -> Composition? {
        guard let obj = PickerSupport.extractJson(raw) as? [String: Any] else { return nil }
        let houseStyleRaw = ((obj["house_style"] as? String) ?? (obj["houseStyle"] as? String) ?? "")
            .trimmingCharacters(in: .whitespaces)
        let houseStyle = houseStyleIds.contains(houseStyleRaw) ? houseStyleRaw : "boardroom-default"
        let spineRaw = (obj["spine"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        let spine = spines.contains(spineRaw) ? spineRaw : (houseStyleSpine[houseStyle] ?? "boardroom-dark")

        guard let rawComponents = obj["components"] as? [Any] else { return nil }
        var seen = Set<String>()
        var picks: [Composition.Component] = []
        for entry in rawComponents {
            guard let e = entry as? [String: Any] else { continue }
            let kind = (e["kind"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
            guard kindSet.contains(kind), !seen.contains(kind) else { continue }
            let order: Int
            if let o = e["order"] as? Int { order = o }
            else if let o = (e["order"] as? NSNumber)?.intValue { order = o }
            else { order = picks.count }
            picks.append(.init(kind: kind, order: order)); seen.insert(kind)
        }
        if validate(picks, coverage: cov) != nil { return nil }
        // Stable order: ascending order, ties by catalogue order; then renumber.
        picks.sort { a, b in
            if a.order != b.order { return a.order < b.order }
            return (componentKinds.firstIndex(of: a.kind) ?? 0) < (componentKinds.firstIndex(of: b.kind) ?? 0)
        }
        for i in picks.indices { picks[i].order = i + 1 }
        let rationale = String(((obj["rationale"] as? String) ?? "").trimmingCharacters(in: .whitespaces).prefix(240))
        let subjectTypeRaw = ((obj["subject_type"] as? String) ?? (obj["subjectType"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
        let subjectType = allowedSubjectTypes.contains(subjectTypeRaw) ? subjectTypeRaw : nil
        return Composition(spine: spine, components: picks, rationale: rationale,
                           subjectType: subjectType, houseStyle: houseStyle, fromComposer: true)
    }

    /// Returns a problem reason (non-nil ⇒ reject), else nil.
    static func validate(_ picks: [Composition.Component], coverage cov: Coverage) -> String? {
        if picks.count < 5 { return "too few components (\(picks.count) < 5)" }
        if picks.count > 12 { return "too many components (\(picks.count) > 12)" }
        let kinds = Set(picks.map(\.kind))
        if kinds.filter(anchorSet.contains).count != 1 { return "expected exactly 1 anchor" }
        if kinds.filter(findingsSet.contains).count != 1 { return "expected exactly 1 findings" }
        if kinds.filter(actionSet.contains).count != 1 { return "expected exactly 1 action" }
        if cov.tensions > 0, !kinds.contains("divergence"), !kinds.contains("positions") {
            return "tensions surfaced; need divergence or positions"
        }
        if cov.risks > 0, !kinds.contains("risk-register"), !kinds.contains("threats-to-validity") {
            return "risks surfaced; need risk-register or threats-to-validity"
        }
        if cov.openQuestions > 0, !kinds.contains("open-questions"), !kinds.contains("new-questions") {
            return "open questions surfaced; need open-questions or new-questions"
        }
        if cov.actions >= 2, kinds.contains("considerations") {
            return "actions surfaced; action should be recommendations or the-bet, not considerations"
        }
        if cov.dataAvailable >= 3, !kinds.contains("metric-strip"), !kinds.contains("visuals") {
            return "data-shaped entries available; need metric-strip or visuals"
        }
        return nil
    }

    // MARK: user message (port of buildComposerMessages' user content)

    static func buildUser(subject: String, roomNumber: Int, roomName: String, mode: String,
                          intensity: String, members: [BriefStages.Member], assets: [BriefAssets.DirectorAssets],
                          total: Int, cov: Coverage, supplement: String?) -> String {
        let directors = members.map { "\($0.id) · \($0.name) (\($0.handle)) — \($0.roleTag)" }.joined(separator: "\n  · ")
        var c = (claims: 0, evidence: 0, tensions: 0, assumptions: 0, risks: 0, opportunities: 0, actions: 0, quotes: 0, openQuestions: 0)
        var lens = ["data": 0, "dissent": 0, "narrative": 0, "structural": 0, "first-principle": 0]
        var evidenceData = 0, evidenceQuote = 0
        for d in assets {
            c.claims += d.claims.count; c.evidence += d.evidence.count; c.tensions += d.tensions.count
            c.assumptions += d.assumptions.count; c.risks += d.risks.count; c.opportunities += d.opportunities.count
            c.actions += d.actions.count; c.quotes += d.quotes.count; c.openQuestions += d.openQuestions.count
            for cl in d.claims where lens[cl.lens] != nil { lens[cl.lens]! += 1 }
            for e in d.evidence { if e.kind == "data" { evidenceData += 1 }; if e.kind == "quote" { evidenceQuote += 1 } }
        }
        let dataAvailable = cov.dataAvailable
        let lensRow = ["data", "dissent", "narrative", "structural", "first-principle"]
            .map { "\($0) \(lens[$0] ?? 0)" }.joined(separator: " · ")

        let assetsBlock = assets.map { d -> String in
            let n = BriefAssets.countAssets(d)
            if n == 0 { return "[\(d.directorId)] \(d.directorName) — (no assets)" }
            var lines: [String] = []
            for (i, cl) in d.claims.enumerated() { lines.append("  · claim:\(i) [\(cl.lens)\(cl.confidence.map { " · \($0)" } ?? "")] \(cl.text)") }
            for (i, e) in d.evidence.enumerated() { lines.append("  · evidence:\(i) [\(e.kind)] \(e.text)") }
            for (i, t) in d.tensions.enumerated() { lines.append("  · tension:\(i)\(t.with.isEmpty ? "" : " w/ \(t.with.joined(separator: "+"))") \(t.text)") }
            for (i, u) in d.assumptions.enumerated() { lines.append("  · assumption:\(i)\(u.falsifier.map { " · falsifier: \($0)" } ?? "") \(u.text)") }
            for (i, r) in d.risks.enumerated() { lines.append("  · risk:\(i)\(r.severity.map { "·\($0)" } ?? "") \(r.text)") }
            for (i, o) in d.opportunities.enumerated() { lines.append("  · opportunity:\(i) \(o.text)") }
            for (i, a) in d.actions.enumerated() { lines.append("  · action:\(i)\(a.owner.map { "·\($0)" } ?? "")\(a.horizon.map { "·\($0)" } ?? "") \(a.text)") }
            for (i, q) in d.quotes.enumerated() { lines.append("  · quote:\(i) \"\(q.text)\"") }
            for (i, oq) in d.openQuestions.enumerated() { lines.append("  · openQuestion:\(i)·\(oq.priority) \(oq.text)") }
            return "[\(d.directorId)] \(d.directorName)\n\(lines.joined(separator: "\n"))"
        }.joined(separator: "\n\n")

        var triggers: [String] = []
        if c.tensions > 0 { triggers.append("· \(c.tensions) tension\(c.tensions == 1 ? "" : "s") surfaced → MUST include `divergence` OR `positions` (don't bury tensions inside generic findings).") }
        if c.risks > 0 { triggers.append("· \(c.risks) risk\(c.risks == 1 ? "" : "s") surfaced → MUST include `risk-register` OR `threats-to-validity`.") }
        if c.openQuestions > 0 { triggers.append("· \(c.openQuestions) open question\(c.openQuestions == 1 ? "" : "s") surfaced → MUST include `open-questions` OR `new-questions`.") }
        if c.actions >= 2 { triggers.append("· \(c.actions) concrete actions surfaced → action component should be `recommendations` or `the-bet` (NOT `considerations` — the room produced imperatives, not hedges).") }
        if dataAvailable >= 3 { triggers.append("· \(dataAvailable) data-shaped entries (data-lens claims + data-kind evidence) → MUST include `metric-strip` OR a `visuals` block. Numbers buried in prose lose force.") }

        let cap = total <= 12 ? "≤ 8 components" : (total <= 24 ? "≤ 10 components" : "≤ 12 components")
        var budget: [String] = [
            "─── ASSET BUDGET ───",
            "Total entries: \(total)",
            "Field counts: claims \(c.claims) · evidence \(c.evidence) · tensions \(c.tensions) · assumptions \(c.assumptions) · risks \(c.risks) · opportunities \(c.opportunities) · actions \(c.actions) · quotes \(c.quotes) · openQuestions \(c.openQuestions)",
            "Claim-lens distribution: \(lensRow)",
            "Evidence kinds: data \(evidenceData) · case \(c.evidence - evidenceData - evidenceQuote) · quote \(evidenceQuote)",
            "Component cap by total entries: \(cap) — pick fewer than the cap when the room's material doesn't fill them substantively.",
            dataAvailable == 0
                ? "Lens-fit constraint: zero data-lens claims AND zero data-kind evidence → DO NOT pick `metric-strip`. The writer would have to fabricate numbers."
                : "Lens-fit: \(dataAvailable) data-shaped entries — `metric-strip` is fittable.",
        ]
        if !triggers.isEmpty { budget.append(""); budget.append("Coverage triggers (validatePicks rejects missing):"); budget.append(contentsOf: triggers) }
        budget.append("─── END BUDGET ───")

        let tone = mode.isEmpty ? "constructive" : mode.lowercased()
        let intens = intensity.isEmpty ? "sharp" : intensity.lowercased()
        let ths = toneHouseStyles[tone] ?? (prefer: [], avoid: [])
        let toneBlock = [
            "─── ROOM TONE (HIGHEST-PRIORITY STEER) ───",
            "Mode: \(tone)",
            "Intensity: \(intens)",
            ths.prefer.isEmpty
                ? "House styles that fit this tone: (none specifically — `boardroom-default` is the safe fallback)"
                : "House styles that fit this tone: \(ths.prefer.map { "`\($0)`" }.joined(separator: ", "))",
            ths.avoid.isEmpty
                ? "House styles to AVOID for this tone: (none — any preset is fittable)"
                : "House styles to AVOID for this tone: \(ths.avoid.map { "`\($0)`" }.joined(separator: ", ")). Picking one of these requires a justification in `rationale` for why the material overrides the tone fit.",
            "─── END ROOM TONE ───",
        ].joined(separator: "\n")

        let supp = supplement?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let supplementBlock = supp.isEmpty ? "" : [
            "", "─── SUPPLEMENTARY PERSPECTIVE FROM USER ───", "",
            "The user has asked the regenerated brief to address this angle. Let it influence both the spine and the components. The user mentioning a specific framing (e.g. 'as a Gartner research note', 'as an investment thesis') is a strong steer — follow it.",
            "", supp, "", "─── END SUPPLEMENT ───",
        ].joined(separator: "\n")

        return [
            "ROOM #\(roomNumber) · \(roomName)",
            "Subject: \(subject)",
            "",
            toneBlock,
            "",
            "Directors:",
            "  · \(directors.isEmpty ? "(none)" : directors)",
            "",
            budget.joined(separator: "\n"),
            "",
            "─── ASSETS ───",
            "",
            assetsBlock.isEmpty ? "(no assets extracted)" : assetsBlock,
            "",
            "─── END ASSETS ───",
            supplementBlock,
            "",
            "Pick the spine and components now. JSON only.",
        ].joined(separator: "\n")
    }
}
