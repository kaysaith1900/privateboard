import Foundation
import BoardroomCore

/// Brief Stage 2 · the `BriefScaffold` structured skeleton (`brief-stages.ts`).
/// The chair clusters the per-director signals into a McKinsey-grade research-note
/// skeleton that Stage 3 renders. This ports the CORE + substitute-group sections
/// (anchor: bottomLine/thesis/workingHypothesis · findings: headlineFindings/
/// bigIdeas · action: recommendations/theBet/considerations · frameShift /
/// convergence / divergence / positions / newQuestions / planningAssumption /
/// openQuestions). The optional exhibit / Gartner-density / visual blocks are
/// `nil` in v1 (they're `?: null` in the source — a brief without them is valid).
public enum BriefScaffold {
    public typealias Confidence = String   // "high" | "medium" | "low"

    public struct BottomLine: Sendable, Equatable { public var judgement: String; public var confidence: Confidence; public var rationale: String }
    public struct FrameShift: Sendable, Equatable { public var shifted: Bool; public var original: String; public var reframed: String; public var trigger: String }
    public struct SubFinding: Sendable, Equatable { public var text: String; public var evidenceRefs: [String] }
    public struct HeadlineFinding: Sendable, Equatable {
        public var title: String; public var claim: String; public var confidence: Confidence
        public var supporters: [String]; public var challengers: [String]; public var supporting: [SubFinding]
        public var lensesPresent: [String]; public var tension: String?; public var counterEvidence: String?; public var strategicImplication: String?
    }
    public struct ConvergencePath: Sendable, Equatable { public var directorId: String; public var lens: String; public var reasoning: String }
    public struct ConvergencePoint: Sendable, Equatable { public var point: String; public var paths: [ConvergencePath] }
    public struct DivergenceRow: Sendable, Equatable { public var directorId: String; public var stance: String; public var confidence: Confidence; public var costOfBeingWrong: String; public var note: String }
    public struct Divergence: Sendable, Equatable { public var statement: String; public var rows: [DivergenceRow]; public var resolutionRequirements: [String] }
    public struct PositionCamp: Sendable, Equatable { public var label: String; public var claim: String; public var directors: [String]; public var evidenceRefs: [String] }
    public struct Recommendation: Sendable, Equatable {
        public var priority: String; public var action: String; public var rationale: String; public var ownerType: String
        public var horizon: String; public var successMetric: String; public var riskIfSkipped: String
        public var criticalDependency: String?; public var expectedBenefit: String?
    }
    public struct NewQuestion: Sendable, Equatable { public var question: String; public var whyItMatters: String; public var surfacedByDirectorId: String }
    public struct PlanningAssumption: Sendable, Equatable { public var statement: String; public var probability: Int; public var trigger: String; public var falsificationTest: String }
    public struct OpenQuestion: Sendable, Equatable { public var text: String; public var priority: String }
    public struct Thesis: Sendable, Equatable { public var claim: String; public var reasoning: String }
    public struct BigIdea: Sendable, Equatable { public var number: Int; public var claim: String; public var why: String; public var evidenceRefs: [String] }
    public struct TheBetCondition: Sendable, Equatable { public var condition: String; public var why: String }
    public struct TheBet: Sendable, Equatable { public var ifBacked: String; public var conditions: [TheBetCondition]; public var killCriteria: String }
    public struct WorkingHypothesis: Sendable, Equatable { public var hypothesis: String; public var reasonsItMayBeWrong: [String] }

    public struct Scaffold: Sendable, Equatable {
        public var title: String
        public var bottomLine: BottomLine
        public var thesis: Thesis?
        public var workingHypothesis: WorkingHypothesis?
        public var frameShift: FrameShift
        public var headlineFindings: [HeadlineFinding]
        public var bigIdeas: [BigIdea]?
        public var convergence: [ConvergencePoint]
        public var divergence: Divergence?
        public var positions: [PositionCamp]
        public var recommendations: [Recommendation]
        public var theBet: TheBet?
        public var considerations: [Recommendation]?
        public var newQuestions: [NewQuestion]
        public var planningAssumption: PlanningAssumption?
        public var openQuestions: [OpenQuestion]
    }

    // MARK: parse (port of parseScaffold · anchor + findings gates, tolerant per-field)

    public static func parse(_ raw: String, fallbackTitle: String, fallbackOriginalQuestion: String) -> Scaffold? {
        guard let p = PickerSupport.dict(PickerSupport.extractJson(raw)) else { return nil }
        let title = (p["title"] as? String)?.trimmingCharacters(in: .whitespaces).nonEmpty ?? fallbackTitle

        let bottomLine = parseBottomLine(p["bottomLine"], title: title)
        let thesis = parseThesis(p["thesis"])
        let workingHypothesis = parseWorkingHypothesis(p["workingHypothesis"])
        let hasAnchor = !bottomLine.judgement.trimmingCharacters(in: .whitespaces).isEmpty
            || (thesis.map { !$0.claim.isEmpty } ?? false)
            || (workingHypothesis.map { !$0.hypothesis.isEmpty } ?? false)
        guard hasAnchor else { return nil }

        var headlineFindings: [HeadlineFinding] = []
        for f in objs(p["headlineFindings"]) { if let h = parseHeadlineFinding(f) { headlineFindings.append(h) }; if headlineFindings.count >= 3 { break } }
        let bigIdeas = parseBigIdeas(p["bigIdeas"])
        guard headlineFindings.count >= 1 || bigIdeas != nil else { return nil }

        let considerations = parseRecommendations(p["considerations"])
        return Scaffold(
            title: title, bottomLine: bottomLine, thesis: thesis, workingHypothesis: workingHypothesis,
            frameShift: parseFrameShift(p["frameShift"], fallbackOriginal: fallbackOriginalQuestion),
            headlineFindings: headlineFindings, bigIdeas: bigIdeas,
            convergence: parseConvergence(p["convergence"]), divergence: parseDivergence(p["divergence"]),
            positions: parsePositions(p["positions"]), recommendations: parseRecommendations(p["recommendations"]),
            theBet: parseTheBet(p["theBet"]), considerations: considerations.isEmpty ? nil : considerations,
            newQuestions: parseNewQuestions(p["newQuestions"]), planningAssumption: parsePlanningAssumption(p["planningAssumption"]),
            openQuestions: parseOpenQuestions(p["openQuestions"]))
    }

    // MARK: per-field parsers (tolerant)

    static func objs(_ v: Any?) -> [[String: Any]] { (v as? [Any])?.compactMap { $0 as? [String: Any] } ?? [] }
    static func str(_ o: [String: Any], _ k: String) -> String { (o[k] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }
    static func strArr(_ v: Any?) -> [String] { (v as? [Any])?.compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } ?? [] }
    static func conf(_ v: Any?) -> Confidence { let s = (v as? String) ?? ""; return ["high","medium","low"].contains(s) ? s : "medium" }
    static func opt(_ o: [String: Any], _ k: String) -> String? { let s = str(o, k); return s.isEmpty ? nil : s }

    static func parseBottomLine(_ v: Any?, title: String) -> BottomLine {
        let o = v as? [String: Any] ?? [:]
        let j = str(o, "judgement")
        return BottomLine(judgement: j.isEmpty ? "" : j, confidence: conf(o["confidence"]), rationale: str(o, "rationale"))
    }
    static func parseThesis(_ v: Any?) -> Thesis? {
        guard let o = v as? [String: Any] else { return nil }
        let claim = str(o, "claim"); guard !claim.isEmpty else { return nil }
        return Thesis(claim: claim, reasoning: str(o, "reasoning"))
    }
    static func parseWorkingHypothesis(_ v: Any?) -> WorkingHypothesis? {
        guard let o = v as? [String: Any] else { return nil }
        let h = str(o, "hypothesis"); guard !h.isEmpty else { return nil }
        return WorkingHypothesis(hypothesis: h, reasonsItMayBeWrong: strArr(o["reasonsItMayBeWrong"]))
    }
    static func parseFrameShift(_ v: Any?, fallbackOriginal: String) -> FrameShift {
        let o = v as? [String: Any] ?? [:]
        let original = str(o, "original").nonEmpty ?? fallbackOriginal
        return FrameShift(shifted: (o["shifted"] as? Bool) ?? false, original: original, reframed: str(o, "reframed"), trigger: str(o, "trigger"))
    }
    static func parseHeadlineFinding(_ o: [String: Any]) -> HeadlineFinding? {
        let title = str(o, "title"); let claim = str(o, "claim")
        guard !title.isEmpty, !claim.isEmpty else { return nil }
        let supporting = objs(o["supporting"]).compactMap { sf -> SubFinding? in
            let t = str(sf, "text"); return t.isEmpty ? nil : SubFinding(text: t, evidenceRefs: strArr(sf["evidenceRefs"]))
        }
        return HeadlineFinding(title: title, claim: claim, confidence: conf(o["confidence"]),
                               supporters: strArr(o["supporters"]), challengers: strArr(o["challengers"]),
                               supporting: supporting, lensesPresent: strArr(o["lensesPresent"]),
                               tension: opt(o, "tension"), counterEvidence: opt(o, "counterEvidence"),
                               strategicImplication: opt(o, "strategicImplication"))
    }
    static func parseBigIdeas(_ v: Any?) -> [BigIdea]? {
        let arr = objs(v); guard !arr.isEmpty else { return nil }
        var out: [BigIdea] = []
        for o in arr {
            let claim = str(o, "claim"); guard !claim.isEmpty else { continue }
            let n = (o["number"] as? Int) ?? (out.count + 1)
            out.append(BigIdea(number: n, claim: claim, why: str(o, "why"), evidenceRefs: strArr(o["evidenceRefs"])))
            if out.count >= 3 { break }
        }
        return out.isEmpty ? nil : out
    }
    static func parseConvergence(_ v: Any?) -> [ConvergencePoint] {
        objs(v).compactMap { o -> ConvergencePoint? in
            let point = str(o, "point"); guard !point.isEmpty else { return nil }
            let paths = objs(o["paths"]).compactMap { pp -> ConvergencePath? in
                let did = str(pp, "directorId"); guard !did.isEmpty else { return nil }
                return ConvergencePath(directorId: did, lens: str(pp, "lens"), reasoning: str(pp, "reasoning"))
            }
            return ConvergencePoint(point: point, paths: paths)
        }
    }
    static func parseDivergence(_ v: Any?) -> Divergence? {
        guard let o = v as? [String: Any] else { return nil }
        let statement = str(o, "statement"); guard !statement.isEmpty else { return nil }
        let rows = objs(o["rows"]).compactMap { r -> DivergenceRow? in
            let did = str(r, "directorId"); guard !did.isEmpty else { return nil }
            let stance = (r["stance"] as? String) ?? ""
            return DivergenceRow(directorId: did, stance: ["for","against","nuanced"].contains(stance) ? stance : "nuanced",
                                 confidence: conf(r["confidence"]), costOfBeingWrong: str(r, "costOfBeingWrong"), note: str(r, "note"))
        }
        return Divergence(statement: statement, rows: rows, resolutionRequirements: strArr(o["resolutionRequirements"]))
    }
    static func parsePositions(_ v: Any?) -> [PositionCamp] {
        objs(v).compactMap { o -> PositionCamp? in
            let label = str(o, "label"); let claim = str(o, "claim")
            guard !label.isEmpty || !claim.isEmpty else { return nil }
            return PositionCamp(label: label, claim: claim, directors: strArr(o["directors"]), evidenceRefs: strArr(o["evidenceRefs"]))
        }
    }
    static func parseRecommendations(_ v: Any?) -> [Recommendation] {
        objs(v).compactMap { o -> Recommendation? in
            let action = str(o, "action"); guard !action.isEmpty else { return nil }
            let pr = (o["priority"] as? String) ?? ""
            return Recommendation(priority: ["P0","P1","P2"].contains(pr) ? pr : "P1", action: action,
                                  rationale: str(o, "rationale"), ownerType: str(o, "ownerType"), horizon: str(o, "horizon"),
                                  successMetric: str(o, "successMetric"), riskIfSkipped: str(o, "riskIfSkipped"),
                                  criticalDependency: opt(o, "criticalDependency"), expectedBenefit: opt(o, "expectedBenefit"))
        }
    }
    static func parseTheBet(_ v: Any?) -> TheBet? {
        guard let o = v as? [String: Any] else { return nil }
        let ifBacked = str(o, "ifBacked"); guard !ifBacked.isEmpty else { return nil }
        let conditions = objs(o["conditions"]).compactMap { c -> TheBetCondition? in
            let cond = str(c, "condition"); return cond.isEmpty ? nil : TheBetCondition(condition: cond, why: str(c, "why"))
        }
        return TheBet(ifBacked: ifBacked, conditions: conditions, killCriteria: str(o, "killCriteria"))
    }
    static func parseNewQuestions(_ v: Any?) -> [NewQuestion] {
        objs(v).compactMap { o -> NewQuestion? in
            let q = str(o, "question"); guard !q.isEmpty else { return nil }
            return NewQuestion(question: q, whyItMatters: str(o, "whyItMatters"), surfacedByDirectorId: str(o, "surfacedByDirectorId"))
        }
    }
    static func parsePlanningAssumption(_ v: Any?) -> PlanningAssumption? {
        guard let o = v as? [String: Any] else { return nil }
        let s = str(o, "statement"); guard !s.isEmpty else { return nil }
        let prob = (o["probability"] as? Int) ?? Int((o["probability"] as? Double) ?? 50)
        return PlanningAssumption(statement: s, probability: max(0, min(100, prob)), trigger: str(o, "trigger"), falsificationTest: str(o, "falsificationTest"))
    }
    static func parseOpenQuestions(_ v: Any?) -> [OpenQuestion] {
        objs(v).compactMap { o -> OpenQuestion? in
            let t = str(o, "text"); guard !t.isEmpty else { return nil }
            let p = (o["priority"] as? String) ?? ""
            return OpenQuestion(text: t, priority: ["P0","P1"].contains(p) ? p : "P1")
        }
    }
}

private extension String { var nonEmpty: String? { isEmpty ? nil : self } }
