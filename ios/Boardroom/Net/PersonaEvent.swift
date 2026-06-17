import Foundation

/// Wire events from the full-persona deep-build SSE stream
/// (`GET /api/agents/generate-persona/:jobId/stream`). 1:1 with the desktop's
/// `_openPersonaSse` frame set. Decoded off the `SSEClient` (event name + JSON
/// data) by `PersonaEvent.parse`, then folded into `PersonaBuildModel`.
enum PersonaEvent: Sendable {
    case hello(phase: Int, progressPct: Double, partial: PersonaPartial?)
    case phaseStart(phase: Int, label: String, etaSec: Double?)
    case phaseProgress(phase: Int, detail: String, progressPct: Double?, partial: PersonaPartial?)
    case phaseEnd(phase: Int, progressPct: Double?, partial: PersonaPartial?)
    case dimensionPlan([PersonaDimension])
    case searchRound(PersonaSearchRound)
    case final(PersonaFinal)
    case error(String)
    case aborted

    /// A terminal event closes the stream · the consumer breaks its loop so the
    /// `SSEClient` auto-reconnect doesn't refire after done / aborted / failed.
    var isTerminal: Bool {
        switch self {
        case .final, .error, .aborted: return true
        default: return false
        }
    }
}

/// One Phase-2 research angle (the planner emits 4–6 of these up front).
struct PersonaDimension: Decodable, Identifiable, Hashable, Sendable {
    let dimension: String
    let query: String
    let why: String?
    var id: String { dimension }
}

/// One ReAct search round · drives the intel feed + dimension checkmarks.
struct PersonaSearchRound: Decodable, Hashable, Sendable {
    let round: Int
    let query: String
    let resultsCount: Int
    let pagesRead: Int
    let dimension: String?
}

/// Tolerant decode of the accumulating `PersonaSpec` · only the array lengths
/// that feed the live stats grid (sources / rules / voice examples / checks).
/// Everything is optional so a half-built partial never fails to decode.
struct PersonaPartial: Decodable, Hashable, Sendable {
    struct Blank: Decodable, Hashable, Sendable {}
    struct Knowledge: Decodable, Hashable, Sendable {
        let keyThinkers: [Blank]?
        let foundationalWorks: [Blank]?
        let recentDevelopments: [Blank]?
        let contestedClaims: [Blank]?
        var sources: Int {
            (keyThinkers?.count ?? 0) + (foundationalWorks?.count ?? 0)
                + (recentDevelopments?.count ?? 0) + (contestedClaims?.count ?? 0)
        }
    }
    let knowledge: Knowledge?
    let rules: [Blank]?
    let fewShot: [Blank]?
    let reflectionChecklist: [String]?

    var sources: Int { knowledge?.sources ?? 0 }
    var ruleCount: Int { rules?.count ?? 0 }
    var voiceCount: Int { fewShot?.count ?? 0 }
    var checkCount: Int { reflectionChecklist?.count ?? 0 }
}

/// The `persona-final` payload · the drafted fields the save form pre-fills. The
/// full spec lives server-side on the job (the save re-reads it), so the client
/// only needs the editable surface + the ability radar.
struct PersonaFinal: Decodable, Sendable {
    let instruction: String?
    let bio: String?
    let coverQuote: String?
    let guessName: String?
    let guessRoleTag: String?
    let ability: [String: Double]?
}

/// Backend-agnostic seam for the full-persona build (the persona twin of
/// `RoomEventSource`): the server REST client (`APIClient`) and the on-device
/// engine witness (`NativePersonaSource`) both vend it, so `PersonaBuildModel` /
/// `NewDirectorView` drive the streaming build + save identically either way.
protocol PersonaEventSource: Sendable {
    /// Kick the build · returns a jobId the stream + abort + save key off.
    func generatePersona(_ description: String, locale: String) async throws -> String
    /// Ordered progress events; the consumer breaks on `isTerminal`.
    func personaEvents(_ jobId: String) -> AsyncStream<PersonaEvent>
    /// Cancel an in-flight build.
    func abortPersona(_ jobId: String) async throws
    /// Materialize the built persona into a saved director (edited surface).
    @discardableResult
    func savePersona(jobId: String, name: String, role: String, bio: String,
                     instruction: String, modelV: String,
                     coverQuote: String?, ability: [String: Double]?,
                     avatarPath: String?, avatar3d: [String: Any]?) async throws -> Agent?
}

/// `APIClient` already implements every requirement (server SSE path) — a no-op
/// conformance, exactly like `extension APIClient: RoomBackend {}`.
extension APIClient: PersonaEventSource {}

extension PersonaEvent {
    static func parse(name: String, data: Data) -> PersonaEvent? {
        let dec = JSONDecoder()
        switch name {
        case "hello":
            struct P: Decodable { let currentPhase: Int?; let progressPct: Double?; let partial: PersonaPartial? }
            guard let p = try? dec.decode(P.self, from: data) else { return nil }
            return .hello(phase: p.currentPhase ?? 1, progressPct: p.progressPct ?? 0, partial: p.partial)
        case "persona-phase-start":
            struct P: Decodable { let phase: Int; let label: String?; let etaSec: Double? }
            guard let p = try? dec.decode(P.self, from: data) else { return nil }
            return .phaseStart(phase: p.phase, label: p.label ?? "", etaSec: p.etaSec)
        case "persona-phase-progress":
            struct P: Decodable { let phase: Int; let detail: String?; let progressPct: Double?; let partial: PersonaPartial? }
            guard let p = try? dec.decode(P.self, from: data) else { return nil }
            return .phaseProgress(phase: p.phase, detail: p.detail ?? "", progressPct: p.progressPct, partial: p.partial)
        case "persona-phase-end":
            struct P: Decodable { let phase: Int; let progressPct: Double?; let partial: PersonaPartial? }
            guard let p = try? dec.decode(P.self, from: data) else { return nil }
            return .phaseEnd(phase: p.phase, progressPct: p.progressPct, partial: p.partial)
        case "persona-dimension-plan":
            struct P: Decodable { let dimensions: [PersonaDimension]? }
            guard let p = try? dec.decode(P.self, from: data) else { return nil }
            return .dimensionPlan(p.dimensions ?? [])
        case "persona-search-round":
            guard let r = try? dec.decode(PersonaSearchRound.self, from: data) else { return nil }
            return .searchRound(r)
        case "persona-final":
            guard let f = try? dec.decode(PersonaFinal.self, from: data) else { return nil }
            return .final(f)
        case "persona-error":
            struct P: Decodable { let message: String? }
            return .error((try? dec.decode(P.self, from: data))?.message ?? "Persona build failed.")
        case "persona-aborted":
            return .aborted
        default:
            return nil
        }
    }
}
