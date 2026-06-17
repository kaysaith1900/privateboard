import Foundation
import BoardroomCore
import BoardroomAI

/// Brief Stage 1 · per-director asset extraction (`brief-stages.ts`). Each
/// director re-reads its OWN turns and emits a 9-field structured asset bundle
/// (claims / evidence / tensions / assumptions / risks / opportunities / actions
/// / quotes / openQuestions), lens-tagged + source-cited. `assetsToSignals`
/// flattens it to the legacy `{text, lens}` signal shape the writer consumes.
/// Faithful port of the types, ASSET_CAPS, EXTRACT_SYSTEM, parser, and flatten.
public enum BriefAssets {
    static let evidenceLenses: Set<String> = ["data", "dissent", "narrative", "structural", "first-principle"]
    static let caps = (claims: 6, evidence: 6, tensions: 4, assumptions: 4, risks: 4,
                       opportunities: 3, actions: 4, quotes: 3, openQuestions: 4)

    public struct Claim: Sendable, Equatable { public var text: String; public var lens: String; public var sources: [Int]; public var confidence: String? }
    public struct Evidence: Sendable, Equatable { public var text: String; public var kind: String; public var sources: [Int] }
    public struct Tension: Sendable, Equatable { public var text: String; public var with: [String]; public var sources: [Int] }
    public struct Assumption: Sendable, Equatable { public var text: String; public var falsifier: String?; public var sources: [Int] }
    public struct Risk: Sendable, Equatable { public var text: String; public var severity: String?; public var sources: [Int] }
    public struct Opportunity: Sendable, Equatable { public var text: String; public var sources: [Int] }
    public struct Action: Sendable, Equatable { public var text: String; public var owner: String?; public var horizon: String?; public var sources: [Int] }
    public struct Quote: Sendable, Equatable { public var text: String; public var sources: [Int] }
    public struct OpenQuestion: Sendable, Equatable { public var text: String; public var priority: String; public var sources: [Int] }

    public struct DirectorAssets: Sendable, Equatable {
        public var directorId: String
        public var directorName: String
        public var claims: [Claim]
        public var evidence: [Evidence]
        public var tensions: [Tension]
        public var assumptions: [Assumption]
        public var risks: [Risk]
        public var opportunities: [Opportunity]
        public var actions: [Action]
        public var quotes: [Quote]
        public var openQuestions: [OpenQuestion]
    }

    public struct ExtractedSignal: Sendable, Equatable { public var text: String; public var lens: String; public var sources: [Int] }
    public struct DirectorSignals: Sendable, Equatable { public var directorId: String; public var directorName: String; public var signals: [ExtractedSignal] }

    public static func countAssets(_ a: DirectorAssets) -> Int {
        a.claims.count + a.evidence.count + a.tensions.count + a.assumptions.count + a.risks.count
            + a.opportunities.count + a.actions.count + a.quotes.count + a.openQuestions.count
    }

    /// Flatten to the writer's `DirectorSignals` (asset kind encoded as a bracket
    /// prefix in the text; stable field order for reproducible `directorId#N`).
    public static func assetsToSignals(_ a: DirectorAssets) -> DirectorSignals {
        var s: [ExtractedSignal] = []
        for c in a.claims { s.append(.init(text: "[claim] \(c.text)", lens: c.lens, sources: c.sources)) }
        for e in a.evidence {
            let lens = e.kind == "data" ? "data" : "narrative"
            s.append(.init(text: "[evidence·\(e.kind)] \(e.text)", lens: lens, sources: e.sources))
        }
        for t in a.tensions {
            let withTag = t.with.isEmpty ? "" : " w/ \(t.with.joined(separator: "+"))"
            s.append(.init(text: "[tension\(withTag)] \(t.text)", lens: "dissent", sources: t.sources))
        }
        for u in a.assumptions {
            let f = u.falsifier.map { " · falsifier: \($0)" } ?? ""
            s.append(.init(text: "[assumption\(f)] \(u.text)", lens: "structural", sources: u.sources))
        }
        for r in a.risks {
            let sev = r.severity.map { "·\($0)" } ?? ""
            s.append(.init(text: "[risk\(sev)] \(r.text)", lens: "structural", sources: r.sources))
        }
        for o in a.opportunities { s.append(.init(text: "[opportunity] \(o.text)", lens: "structural", sources: o.sources)) }
        for ac in a.actions {
            let ot = ac.owner.map { "·\($0)" } ?? ""; let ht = ac.horizon.map { "·\($0)" } ?? ""
            s.append(.init(text: "[action\(ot)\(ht)] \(ac.text)", lens: "structural", sources: ac.sources))
        }
        for q in a.quotes { s.append(.init(text: "[quote] \(q.text)", lens: "narrative", sources: q.sources)) }
        for oq in a.openQuestions { s.append(.init(text: "[open-q·\(oq.priority)] \(oq.text)", lens: "first-principle", sources: oq.sources)) }
        return DirectorSignals(directorId: a.directorId, directorName: a.directorName, signals: s)
    }

    // MARK: parse (port of parseDirectorAssets · each field independent + capped)

    public static func parse(_ raw: String, directorId: String, directorName: String) -> DirectorAssets {
        let empty = DirectorAssets(directorId: directorId, directorName: directorName, claims: [], evidence: [],
                                   tensions: [], assumptions: [], risks: [], opportunities: [], actions: [],
                                   quotes: [], openQuestions: [])
        guard let o = PickerSupport.dict(PickerSupport.extractJson(raw)) else { return empty }
        return DirectorAssets(
            directorId: directorId, directorName: directorName,
            claims: parseClaims(o["claims"]), evidence: parseEvidence(o["evidence"]),
            tensions: parseTensions(o["tensions"]), assumptions: parseAssumptions(o["assumptions"]),
            risks: parseRisks(o["risks"]), opportunities: parseOpportunities(o["opportunities"]),
            actions: parseActions(o["actions"]), quotes: parseQuotes(o["quotes"]),
            openQuestions: parseOpenQuestions(o["openQuestions"]))
    }

    private static func sourcesOf(_ v: Any?) -> [Int] {
        guard let arr = v as? [Any] else { return [] }
        return arr.compactMap { n -> Int? in
            if let i = n as? Int, i >= 0 { return i }
            if let d = n as? Double, d.isFinite, d >= 0 { return Int(d) }
            return nil
        }
    }
    private static func text(_ o: [String: Any]) -> String { (o["text"] as? String)?.trimmingCharacters(in: .whitespaces) ?? "" }
    private static func objs(_ v: Any?) -> [[String: Any]] { (v as? [Any])?.compactMap { $0 as? [String: Any] } ?? [] }

    private static func parseClaims(_ v: Any?) -> [Claim] {
        var out: [Claim] = []
        for o in objs(v) {
            let t = text(o); let lens = (o["lens"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
            let src = sourcesOf(o["sources"])
            guard !t.isEmpty, evidenceLenses.contains(lens), !src.isEmpty else { continue }
            let c = (o["confidence"] as? String)?.trimmingCharacters(in: .whitespaces)
            out.append(Claim(text: t, lens: lens, sources: src, confidence: ["high","medium","low"].contains(c ?? "") ? c : nil))
            if out.count >= caps.claims { break }
        }
        return out
    }
    private static func parseEvidence(_ v: Any?) -> [Evidence] {
        var out: [Evidence] = []
        for o in objs(v) {
            let t = text(o); let src = sourcesOf(o["sources"]); guard !t.isEmpty, !src.isEmpty else { continue }
            let k = (o["kind"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
            out.append(Evidence(text: t, kind: ["data","case","quote"].contains(k) ? k : "case", sources: src))
            if out.count >= caps.evidence { break }
        }
        return out
    }
    private static func parseTensions(_ v: Any?) -> [Tension] {
        var out: [Tension] = []
        for o in objs(v) {
            let t = text(o); let src = sourcesOf(o["sources"]); guard !t.isEmpty, !src.isEmpty else { continue }
            let w = (o["with"] as? [Any])?.compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } ?? []
            out.append(Tension(text: t, with: w, sources: src))
            if out.count >= caps.tensions { break }
        }
        return out
    }
    private static func parseAssumptions(_ v: Any?) -> [Assumption] {
        var out: [Assumption] = []
        for o in objs(v) {
            let t = text(o); let src = sourcesOf(o["sources"]); guard !t.isEmpty, !src.isEmpty else { continue }
            let f = (o["falsifier"] as? String)?.trimmingCharacters(in: .whitespaces)
            out.append(Assumption(text: t, falsifier: (f?.isEmpty == false) ? f : nil, sources: src))
            if out.count >= caps.assumptions { break }
        }
        return out
    }
    private static func parseRisks(_ v: Any?) -> [Risk] {
        var out: [Risk] = []
        for o in objs(v) {
            let t = text(o); let src = sourcesOf(o["sources"]); guard !t.isEmpty, !src.isEmpty else { continue }
            let s = (o["severity"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
            out.append(Risk(text: t, severity: ["high","medium","low"].contains(s) ? s : nil, sources: src))
            if out.count >= caps.risks { break }
        }
        return out
    }
    private static func parseOpportunities(_ v: Any?) -> [Opportunity] {
        var out: [Opportunity] = []
        for o in objs(v) {
            let t = text(o); let src = sourcesOf(o["sources"]); guard !t.isEmpty, !src.isEmpty else { continue }
            out.append(Opportunity(text: t, sources: src)); if out.count >= caps.opportunities { break }
        }
        return out
    }
    private static func parseActions(_ v: Any?) -> [Action] {
        var out: [Action] = []
        for o in objs(v) {
            let t = text(o); let src = sourcesOf(o["sources"]); guard !t.isEmpty, !src.isEmpty else { continue }
            let owner = (o["owner"] as? String)?.trimmingCharacters(in: .whitespaces)
            let horizon = (o["horizon"] as? String)?.trimmingCharacters(in: .whitespaces)
            out.append(Action(text: t, owner: (owner?.isEmpty == false) ? owner : nil,
                              horizon: (horizon?.isEmpty == false) ? horizon : nil, sources: src))
            if out.count >= caps.actions { break }
        }
        return out
    }
    private static func parseQuotes(_ v: Any?) -> [Quote] {
        var out: [Quote] = []
        for o in objs(v) {
            let t = text(o); let src = sourcesOf(o["sources"]); guard !t.isEmpty, !src.isEmpty else { continue }
            out.append(Quote(text: t, sources: src)); if out.count >= caps.quotes { break }
        }
        return out
    }
    private static func parseOpenQuestions(_ v: Any?) -> [OpenQuestion] {
        var out: [OpenQuestion] = []
        for o in objs(v) {
            let t = text(o); let src = sourcesOf(o["sources"]); guard !t.isEmpty, !src.isEmpty else { continue }
            let p = (o["priority"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
            out.append(OpenQuestion(text: t, priority: ["P0","P1","P2"].contains(p) ? p : "P1", sources: src))
            if out.count >= caps.openQuestions { break }
        }
        return out
    }
}
