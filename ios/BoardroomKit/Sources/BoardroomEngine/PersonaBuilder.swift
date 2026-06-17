import Foundation
import BoardroomCore
import BoardroomAI

/// On-device persona builder — Phase 1/3 (the intellectual PROFILE pass) of
/// `persona-builder.ts`. Produces the `PersonaSpecCore` (intellectual lineage /
/// load-bearing concepts / referent set / failure modes / contrarian takes) that
/// the live loop consumes: the dissent-gap picker (P4-4) and the director prompt's
/// lens reminder (P4-5) both read `contrarianTakes` / `failureModes`. The full
/// 7-phase build (ReAct knowledge → rules → few-shot → reflection → eval → name,
/// + streaming job table + save/UI) lands in later sub-phases; this is the slice
/// that makes on-device-created directors as rich as seeded ones.
public enum PersonaBuilder {

    // MARK: Types (ports of AgentProfile + PersonaSpecCore)

    public struct AgentProfile: Sendable, Equatable, Codable {
        public struct Lineage: Sendable, Equatable, Codable { public var influencedBy: [String]; public var opposedTo: [String] }
        public struct Concept: Sendable, Equatable, Codable { public var name: String; public var gloss: String }
        public struct Referent: Sendable, Equatable, Codable { public var ref: String; public var why: String }
        public var intellectualLineage: Lineage
        public var loadBearingConcepts: [Concept]
        public var referentSet: [Referent]
        public var failureModes: [String]
        public var contrarianTakes: [String]
    }

    // Phase 4-7 artifact types.
    public struct PersonaRule: Sendable, Equatable { public var kind: String; public var rule: String }
    public struct PersonaFewShot: Sendable, Equatable {
        public var scenario: String; public var genericResponse: String; public var personaResponse: String; public var rationale: String
    }
    public struct PersonaEvalEntry: Sendable, Equatable { public var prompt: String; public var expectedSignature: String }
    public struct PersonaName: Sendable, Equatable { public var name: String; public var handle: String }

    /// The full multi-phase build result (sans ReAct knowledge + streaming).
    public struct BuiltPersona: Sendable {
        public var spec: PersonaSpecCore
        public var rules: [PersonaRule]
        public var fewShot: [PersonaFewShot]
        public var reflectionChecklist: [String]
        public var evalSet: [PersonaEvalEntry]
        public var name: PersonaName?
    }

    /// Flattened, persisted shape (`PersonaSpecCore`) — string arrays, the form
    /// `agents.persona_spec_json.spec` carries and `GRDBRoomStore.parsePersonaSpec`
    /// reads back into `DirectorRef`.
    public struct PersonaSpecCore: Codable, Sendable, Equatable {
        public var intellectualLineage: [String]
        public var loadBearingConcepts: [String]
        public var referentSet: [String]
        public var failureModes: [String]
        public var contrarianTakes: [String]
    }

    // MARK: Profile pass

    /// Run the profile pass · PROFILE_SYSTEM + the user description (optional web
    /// context), parse the JSON, return the AgentProfile (nil on no-model / empty).
    public static func buildProfile(router: EngineRouter, description: String,
                                    webContext: String? = nil) async -> AgentProfile? {
        guard let model = router.defaultModelV() ?? router.utilityModelV() else { return nil }
        var userBody = ["User description of the director they want:", "", description.trimmingCharacters(in: .whitespacesAndNewlines)]
        if let web = webContext?.trimmingCharacters(in: .whitespacesAndNewlines), !web.isEmpty {
            userBody += ["", "Reference material from the web (use to ground NAMED references — do not quote verbatim, distill into the profile fields):", "", web]
        }
        userBody += ["", "Now produce the profile JSON object as specified — ```json fenced block, exact camelCase field names, no prose before or after."]
        guard let raw = try? await router.call(
            [LLMMessage(role: .system, content: profileSystem), LLMMessage(role: .user, content: userBody.joined(separator: "\n"))],
            modelV: model, temperature: 0.6, maxTokens: 4096) else { return nil }
        return parseAgentProfile(raw)
    }

    /// Flatten AgentProfile → PersonaSpecCore (port of `toCore`).
    public static func toCore(_ p: AgentProfile) -> PersonaSpecCore {
        var lineage: [String] = []
        lineage += p.intellectualLineage.influencedBy.map { "Influenced by: \($0)" }
        lineage += p.intellectualLineage.opposedTo.map { "Opposed to: \($0)" }
        let concepts = p.loadBearingConcepts.map { $0.gloss.isEmpty ? $0.name : "\($0.name): \($0.gloss)" }
        let referents = p.referentSet.map { $0.why.isEmpty ? $0.ref : "\($0.ref) — \($0.why)" }
        return PersonaSpecCore(intellectualLineage: lineage, loadBearingConcepts: concepts,
                               referentSet: referents, failureModes: p.failureModes, contrarianTakes: p.contrarianTakes)
    }

    /// The `agents.persona_spec_json` blob · `{ version, generatedAt, description,
    /// spec }`. `GRDBRoomStore.parsePersonaSpec` reads `.spec.contrarianTakes` /
    /// `.failureModes`; the director prompt + dissent picker consume those.
    public static func personaSpecJSON(core: PersonaSpecCore, description: String, generatedAt: String) -> String? {
        let specObj: [String: Any] = [
            "intellectualLineage": core.intellectualLineage,
            "loadBearingConcepts": core.loadBearingConcepts,
            "referentSet": core.referentSet,
            "failureModes": core.failureModes,
            "contrarianTakes": core.contrarianTakes,
        ]
        let blob: [String: Any] = ["version": 1, "generatedAt": generatedAt, "description": description, "spec": specObj]
        guard let data = try? JSONSerialization.data(withJSONObject: blob) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: Parser (port of parseAgentProfile — lenient, alias-tolerant)

    public static func parseAgentProfile(_ raw: String) -> AgentProfile? {
        guard let parsed = PickerSupport.dict(PickerSupport.extractJson(raw)) else { return nil }
        let lineage = pickObject(parsed, ["intellectualLineage", "intellectual_lineage", "lineage"])
        let influencedBy = pickArray(lineage, ["influencedBy", "influenced_by", "influences", "influenced"])
            .compactMap { $0 as? String }.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            .map { PickerSupport.clip($0, 200) }.prefix(5)
        let opposedTo = pickArray(lineage, ["opposedTo", "opposed_to", "opposes", "against"])
            .compactMap { $0 as? String }.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            .map { PickerSupport.clip($0, 200) }.prefix(4)

        let concepts = pickArray(parsed, ["loadBearingConcepts", "load_bearing_concepts", "concepts", "frames", "mentalTools", "mental_tools"])
            .map(coerceConcept).filter { !$0.name.isEmpty }.prefix(6)
        let referents = pickArray(parsed, ["referentSet", "referent_set", "referents", "anchors", "references", "citations"])
            .map(coerceReferent).filter { !$0.ref.isEmpty }.prefix(6)
        let failureModes = pickArray(parsed, ["failureModes", "failure_modes", "blindSpots", "blind_spots"])
            .compactMap { $0 as? String }.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            .map { PickerSupport.clip($0, 220) }.prefix(4)
        let contrarianTakes = pickArray(parsed, ["contrarianTakes", "contrarian_takes", "contrarianViews", "contrarian_views", "takes"])
            .compactMap { $0 as? String }.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            .map { PickerSupport.clip($0, 220) }.prefix(4)

        let anyPopulated = !concepts.isEmpty || !referents.isEmpty || !influencedBy.isEmpty
            || !opposedTo.isEmpty || !failureModes.isEmpty || !contrarianTakes.isEmpty
        guard anyPopulated else { return nil }
        return AgentProfile(
            intellectualLineage: .init(influencedBy: Array(influencedBy), opposedTo: Array(opposedTo)),
            loadBearingConcepts: Array(concepts), referentSet: Array(referents),
            failureModes: Array(failureModes), contrarianTakes: Array(contrarianTakes))
    }

    // MARK: Coerce helpers (port of coerceConceptEntry / coerceReferentEntry)

    private static let splitRe = #"^(.+?)\s*[·:\-—]\s*(.+)$"#

    static func coerceConcept(_ c: Any) -> AgentProfile.Concept {
        if let s = c as? String {
            let t = s.trimmingCharacters(in: .whitespaces)
            if let (a, b) = split(t) { return .init(name: PickerSupport.clip(a, 80), gloss: PickerSupport.clip(b, 200)) }
            return .init(name: PickerSupport.clip(t, 80), gloss: "")
        }
        guard let o = c as? [String: Any] else { return .init(name: "", gloss: "") }
        let name = firstString(o, ["name", "concept", "title", "handle", "term"])
        let gloss = firstString(o, ["gloss", "description", "desc", "detail", "explanation", "summary"])
        return .init(name: name.map { PickerSupport.clip($0, 80) } ?? "", gloss: gloss.map { PickerSupport.clip($0, 200) } ?? "")
    }

    static func coerceReferent(_ r: Any) -> AgentProfile.Referent {
        if let s = r as? String {
            let t = s.trimmingCharacters(in: .whitespaces)
            if let (a, b) = split(t) { return .init(ref: PickerSupport.clip(a, 80), why: PickerSupport.clip(b, 200)) }
            return .init(ref: PickerSupport.clip(t, 80), why: "")
        }
        guard let o = r as? [String: Any] else { return .init(ref: "", why: "") }
        let ref = firstString(o, ["ref", "name", "reference", "anchor", "title", "case"])
        let why = firstString(o, ["why", "reason", "relevance", "gloss", "description", "note"])
        return .init(ref: ref.map { PickerSupport.clip($0, 80) } ?? "", why: why.map { PickerSupport.clip($0, 200) } ?? "")
    }

    private static func split(_ s: String) -> (String, String)? {
        guard let m = s.range(of: splitRe, options: .regularExpression) else { return nil }
        _ = m
        // Re-run with NSRegularExpression to capture both groups.
        guard let re = try? NSRegularExpression(pattern: splitRe) else { return nil }
        let r = NSRange(s.startIndex..., in: s)
        guard let match = re.firstMatch(in: s, range: r), match.numberOfRanges > 2,
              let g1 = Range(match.range(at: 1), in: s), let g2 = Range(match.range(at: 2), in: s) else { return nil }
        return (String(s[g1]).trimmingCharacters(in: .whitespaces), String(s[g2]).trimmingCharacters(in: .whitespaces))
    }

    private static func firstString(_ o: [String: Any], _ keys: [String]) -> String? {
        for k in keys { if let v = o[k] as? String, !v.trimmingCharacters(in: .whitespaces).isEmpty { return v.trimmingCharacters(in: .whitespaces) } }
        return nil
    }
    private static func pickArray(_ o: [String: Any], _ aliases: [String]) -> [Any] {
        for k in aliases { if let v = o[k] as? [Any] { return v } }
        return []
    }
    private static func pickObject(_ o: [String: Any], _ aliases: [String]) -> [String: Any] {
        for k in aliases { if let v = o[k] as? [String: Any] { return v } }
        return [:]
    }
}
