import Foundation
import BoardroomCore
import BoardroomAI

/// Brief Stage 2 (scaffold) + Stage 3 (write) runners. The two giant SYSTEM
/// prompts (SCAFFOLD_SYSTEM ~32k chars · WRITE_SYSTEM ~63k chars) are codegen'd
/// byte-identical from `brief-stages.ts` into `brief-prompts.json`
/// (`scripts/gen-ios-brief-prompts.mjs`); the user-message builders are ported
/// here. Stage 2 clusters per-director signals into a `BriefScaffold`; Stage 3
/// streams the McKinsey-grade markdown (with kami-chart fenced blocks) from it.
/// The optional exhibit/Gartner/visual sections are skipped in v1 (the core
/// scaffold carries the load-bearing sections).
public enum BriefStages {

    /// Codegen'd prompt catalog (`brief-prompts.json`).
    struct Catalog: Decodable { let scaffold: String; let write: String; let magazine: String; let newspaper: String; let ppt: String; let composer: String }
    static let catalog: Catalog? = {
        guard let url = Bundle.module.url(forResource: "brief-prompts", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Catalog.self, from: data)
    }()

    public struct Member: Sendable { public let id: String; public let name: String; public let handle: String; public let roleTag: String
        public init(id: String, name: String, handle: String, roleTag: String) { self.id = id; self.name = name; self.handle = handle; self.roleTag = roleTag } }

    // MARK: Stage 2 · scaffold

    public static func runStage2(router: EngineRouter, subject: String, roomName: String, members: [Member],
                                 signals: [BriefAssets.DirectorSignals]) async -> BriefScaffold.Scaffold? {
        guard let sys = catalog?.scaffold, let model = router.defaultModelV() ?? router.utilityModelV() else { return nil }
        let lang = PickerSupport.languageLockBlock(PickerSupport.detectRoomLang(subject))
        let user = scaffoldUser(subject: subject, roomName: roomName, members: members, signals: signals)
        let msgs = [LLMMessage(role: .system, content: sys + "\n\n" + lang), LLMMessage(role: .user, content: user)]
        let fallbackTitle = roomName.isEmpty ? (subject.isEmpty ? "Closing Brief" : String(subject.prefix(60))) : roomName
        // Up to STAGE_2_RETRIES (2) attempts · temperatures [0.2, 0.5].
        for temp in [0.2, 0.5] {
            guard let raw = try? await router.call(msgs, modelV: model, temperature: temp, maxTokens: 16000) else { continue }
            if let s = BriefScaffold.parse(raw, fallbackTitle: fallbackTitle, fallbackOriginalQuestion: subject) { return s }
        }
        return nil
    }

    static func scaffoldUser(subject: String, roomName: String, members: [Member], signals: [BriefAssets.DirectorSignals]) -> String {
        let memberList = members.map { "\($0.id) · \($0.name) (\($0.handle)) — \($0.roleTag)" }.joined(separator: "\n  · ")
        let signalsBlock = signals.map { d -> String in
            if d.signals.isEmpty { return "[\(d.directorId)] \(d.directorName) — (no signals)" }
            let lines = d.signals.enumerated().map { "  · \(d.directorId)#\($0.offset) [\($0.element.lens)] \($0.element.text)" }.joined(separator: "\n")
            return "[\(d.directorId)] \(d.directorName)\n\(lines)"
        }.joined(separator: "\n\n")
        return [
            "ROOM · \(roomName.isEmpty ? subject : roomName)",
            "Subject: \(subject)",
            "",
            "Directors:",
            "  · \(memberList)",
            "",
            "─── SIGNALS ───",
            "",
            signalsBlock.isEmpty ? "(no signals extracted)" : signalsBlock,
            "",
            "─── END SIGNALS ───",
            "",
            "Produce the scaffold now. JSON only.",
        ].joined(separator: "\n")
    }

    // MARK: Stage 3 · write

    /// Stream the final markdown from the scaffold. Returns the body (also emitted
    /// chunk-by-chunk via `onDelta` if provided).
    public static func runStage3(router: EngineRouter, subject: String, members: [Member],
                                 scaffold: BriefScaffold.Scaffold, signals: [BriefAssets.DirectorSignals],
                                 onDelta: ((String) -> Void)? = nil) async -> String? {
        guard let sys = catalog?.write, let model = router.defaultModelV() ?? router.utilityModelV() else { return nil }
        let lang = PickerSupport.languageLockBlock(PickerSupport.detectRoomLang(subject))
        let user = writeUser(subject: subject, members: members, scaffold: scaffold, signals: signals)
        var body = ""
        let stream = (try? await router.call([LLMMessage(role: .system, content: sys + "\n\n" + lang), LLMMessage(role: .user, content: user)],
                                             modelV: model, temperature: 0.4, maxTokens: 20000))
        // router.call returns the whole string (drained). For incremental UI use
        // the streaming adapter; here we get the final body in one shot.
        if let raw = stream { body = raw; onDelta?(raw) }
        let md = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return md.isEmpty ? nil : md
    }

    static func nameOf(_ id: String, _ members: [Member]) -> String { members.first(where: { $0.id == id })?.name ?? id }

    /// Resolve a `directorId#N` ref → the signal text (port of renderSignalRef).
    static func renderSignalRef(_ ref: String, _ signals: [BriefAssets.DirectorSignals]) -> String {
        guard let hash = ref.firstIndex(of: "#") else { return ref }
        let did = String(ref[..<hash]); let idxStr = String(ref[ref.index(after: hash)...])
        guard let idx = Int(idxStr), let d = signals.first(where: { $0.directorId == did }), idx >= 0, idx < d.signals.count else { return ref }
        return d.signals[idx].text
    }

    static func writeUser(subject: String, members: [Member], scaffold s: BriefScaffold.Scaffold, signals: [BriefAssets.DirectorSignals]) -> String {
        func nm(_ id: String) -> String { nameOf(id, members) }
        func refLines(_ refs: [String], indent: String) -> String {
            refs.isEmpty ? "\(indent)· (no evidence refs)" : refs.map { "\(indent)· \(renderSignalRef($0, signals))" }.joined(separator: "\n")
        }
        var parts: [String] = []
        parts.append("ROOM SUBJECT: \(subject)")
        parts.append("\nMembers:\n  · " + members.map { "\($0.id) · \($0.name)" }.joined(separator: "\n  · "))

        // Anchor (one of bottomLine / thesis / workingHypothesis).
        if let t = s.thesis {
            parts.append("\n── THESIS (anchor) ──\n  Claim: \(t.claim)\n  Reasoning: \(t.reasoning)")
        } else if let w = s.workingHypothesis {
            parts.append("\n── WORKING HYPOTHESIS (anchor) ──\n  Hypothesis: \(w.hypothesis)\n  Reasons it may be wrong:\n" + w.reasonsItMayBeWrong.map { "    · \($0)" }.joined(separator: "\n"))
        } else {
            parts.append("\n── BOTTOM LINE ──\n  Judgement: \(s.bottomLine.judgement)\n  Confidence: \(s.bottomLine.confidence)\n  Rationale: \(s.bottomLine.rationale.isEmpty ? "(none)" : s.bottomLine.rationale)")
        }

        parts.append("\n── FRAME SHIFT ──\n  Shifted: \(s.frameShift.shifted)\n  Original framing: \(s.frameShift.original)\n  Reframed: \(s.frameShift.reframed.isEmpty ? "(n/a — frame held)" : s.frameShift.reframed)\n  Trigger: \(s.frameShift.trigger.isEmpty ? "(none)" : s.frameShift.trigger)")

        // Findings (headlineFindings or bigIdeas).
        if let big = s.bigIdeas {
            let lines = big.map { "  \($0.number). \($0.claim)\n     Why: \($0.why)\n     Evidence:\n" + refLines($0.evidenceRefs, indent: "       ") }.joined(separator: "\n\n")
            parts.append("\n── BIG IDEAS ──\n\(lines)")
        } else {
            let lines = s.headlineFindings.enumerated().map { (i, f) -> String in
                let sub = f.supporting.enumerated().map { (si, sf) in "    Sub-finding \(si + 1): \(sf.text)\n    Evidence:\n" + refLines(sf.evidenceRefs, indent: "      ") }.joined(separator: "\n\n")
                let tension = f.tension.map { "\n    Tension: \($0)" } ?? ""
                let counter = f.counterEvidence.map { "\n    Counter-evidence: \($0)" } ?? ""
                let impl = f.strategicImplication.map { "\n    Strategic implication: \($0)" } ?? ""
                return "  ### Finding \(i + 1): \(f.title)\n    Claim: \(f.claim)\n    Confidence: \(f.confidence)\n    Supporters: \(f.supporters.map(nm).joined(separator: ", "))\n    Challengers: \(f.challengers.isEmpty ? "(none — full alignment)" : f.challengers.map(nm).joined(separator: ", "))\n    Lenses present: \(f.lensesPresent.joined(separator: " + "))\(tension)\(counter)\(impl)\n    Supporting:\n\(sub)"
            }.joined(separator: "\n\n")
            parts.append("\n── HEADLINE FINDINGS ──\n\(lines)")
        }

        if !s.convergence.isEmpty {
            let lines = s.convergence.enumerated().map { (i, c) in "  Convergence \(i + 1): \(c.point)\n    Independent paths:\n" + c.paths.map { "      · \(nm($0.directorId)) via [\($0.lens)]: \($0.reasoning)" }.joined(separator: "\n") }.joined(separator: "\n\n")
            parts.append("\n── CONVERGENCE ──\n\(lines)")
        }
        if let d = s.divergence {
            let rows = d.rows.map { "    · \(nm($0.directorId)) | \($0.stance) | confidence: \($0.confidence) | cost-of-being-wrong: \($0.costOfBeingWrong) | note: \($0.note)" }.joined(separator: "\n")
            let res = d.resolutionRequirements.isEmpty ? "    · (none)" : d.resolutionRequirements.map { "    · \($0)" }.joined(separator: "\n")
            parts.append("\n── DIVERGENCE ──\n  Statement: \(d.statement)\n  Per-director stances:\n\(rows)\n  Resolution requirements:\n\(res)")
        }
        if !s.positions.isEmpty {
            let lines = s.positions.enumerated().map { (i, p) in "  ### Camp \(i + 1): \(p.label)\n    Claim: \(p.claim)\n    Directors: \(p.directors.map(nm).joined(separator: ", "))\n    Evidence:\n" + refLines(p.evidenceRefs, indent: "      ") }.joined(separator: "\n\n")
            parts.append("\n── POSITIONS ──\n\(lines)")
        }

        // Action (recommendations / theBet / considerations).
        if let bet = s.theBet {
            let cond = bet.conditions.map { "    · \($0.condition) — \($0.why)" }.joined(separator: "\n")
            parts.append("\n── THE BET ──\n  If backed: \(bet.ifBacked)\n  Conditions:\n\(cond)\n  Kill criteria: \(bet.killCriteria)")
        } else {
            let recs = (s.considerations ?? s.recommendations)
            if !recs.isEmpty {
                let lines = recs.map { "  [\($0.priority)] \($0.action)\n    Rationale: \($0.rationale)\n    Owner: \($0.ownerType) · Horizon: \($0.horizon)\n    Success metric: \($0.successMetric)\n    Risk if skipped: \($0.riskIfSkipped)" }.joined(separator: "\n\n")
                parts.append("\n── \(s.considerations != nil ? "CONSIDERATIONS" : "RECOMMENDATIONS") ──\n\(lines)")
            }
        }
        if !s.newQuestions.isEmpty {
            parts.append("\n── NEW QUESTIONS ──\n" + s.newQuestions.map { "  · \($0.question) — why: \($0.whyItMatters) (\(nm($0.surfacedByDirectorId)))" }.joined(separator: "\n"))
        }
        if let pa = s.planningAssumption {
            parts.append("\n── PLANNING ASSUMPTION ──\n  \(pa.statement) (\(pa.probability)%)\n  Trigger: \(pa.trigger)\n  Falsification: \(pa.falsificationTest)")
        }
        if !s.openQuestions.isEmpty {
            parts.append("\n── OPEN QUESTIONS ──\n" + s.openQuestions.map { "  · [\($0.priority)] \($0.text)" }.joined(separator: "\n"))
        }

        parts.append("\nWrite the final report now in Markdown — McKinsey-grade research note, in the room's language. Render the sections in the order given above; replace director ids with their display names; use the fenced structured blocks (```kami-chart, ```metric-strip, ```views-compared, callouts) where the spec calls for them. No preamble, no 'In conclusion'.")
        return parts.joined(separator: "\n")
    }
}
