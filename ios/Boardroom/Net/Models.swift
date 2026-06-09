import Foundation
import BoardroomCore

// Decodable mirrors of the server's JSON. Decode-only (we never encode these
// back). Field names match the keys the web client reads in api.js /
// normalizeRoom, so the same backend serves both clients unchanged.

/// `createdAt` arrives as either epoch-ms (Double) or an ISO-8601 string
/// depending on the route — accept both, expose a `Date?`.
struct FlexibleTime: Decodable, Hashable {
    let date: Date?
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let ms = try? c.decode(Double.self) {
            // Heuristic: > 1e12 ⇒ milliseconds, else seconds.
            self.date = Date(timeIntervalSince1970: ms > 1_000_000_000_000 ? ms / 1000 : ms)
        } else if let s = try? c.decode(String.self) {
            self.date = ISO8601DateFormatter().date(from: s)
        } else {
            self.date = nil
        }
    }
}

/// Three real room states. Anything unrecognised folds into `.adjourned`
/// (mirrors the web grouping); a *missing* status is treated as `.live` by the
/// `bucket` accessor below.
enum RoomStatus: String, Decodable, Hashable {
    case live, paused, adjourned
    init(from decoder: Decoder) throws {
        let s = try decoder.singleValueContainer().decode(String.self)
        self = RoomStatus(rawValue: s) ?? .adjourned
    }
}

struct Room: Decodable, Identifiable, Hashable {
    let id: String
    let name: String?
    let subject: String?
    let mode: String?            // tone: constructive / brainstorm / ...
    let intensity: String?
    var status: RoomStatus?      // var · the list can apply the session's known
                                 // status on return (pause/resume/adjourn) without
                                 // racing the engine's async DB write

    let deliveryMode: String?    // "voice" | "text"
    let createdAt: FlexibleTime?
    let kind: String?
    let awaitingClarify: Bool?
    let awaitingContinue: Bool?
    let briefStyle: String?
    let directorIds: [String]?

    var displayName: String { name ?? subject ?? "Untitled" }
    /// The list card shows the user's RAW opening query (not the AI-distilled
    /// `name`), clamped to 3 lines — matches the web `.vr-rc-subject`.
    var rawQuery: String { subject ?? name ?? "Untitled" }
    var isVoice: Bool { (deliveryMode ?? "voice") == "voice" }
    /// Status for grouping · missing ⇒ live (matches web `status || "live"`).
    var bucket: RoomStatus { status ?? .live }
    var isThread: Bool { kind == "thread" }
}

struct Agent: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let bio: String?
    let avatarPath: String?
    let roleTag: String?
    let roleKind: String?
    // Fuller fields · present on GET /api/agents/:id (profile), absent in the list.
    let instruction: String?
    let ability: String?      // (server may send this as an object; decoded soft → nil)
    let coverQuote: String?
    let modelV: String?
    // Profile-only · present on GET /api/agents/:id, absent in the list.
    let handle: String?
    let webSearchEnabled: Bool?
    let abilityRadar: [String: Double]?   // the `ability` radar object, decoded soft
    let userRules: [String]?              // editable operating constraints (max 5)
    let voice: AgentVoice?                // current TTS voice profile
    let avatar3d: Avatar3DConfig?         // 捏脸 config (profile route) · seeds the avatar editor
    let personaSpec: PersonaSpec?         // full-persona 7-phase build dossier · nil for signal/seed directors
    let createdAt: Double?                // epoch-ms · drives the Directors list "by creation time" sort
    let isSeed: Bool?                     // true = built-in seed director/chair (rename disabled); false = user-created

    init(id: String, name: String, bio: String? = nil, avatarPath: String? = nil,
         roleTag: String? = nil, roleKind: String? = nil, instruction: String? = nil,
         ability: String? = nil, coverQuote: String? = nil, modelV: String? = nil,
         handle: String? = nil, webSearchEnabled: Bool? = nil, abilityRadar: [String: Double]? = nil,
         userRules: [String]? = nil, voice: AgentVoice? = nil, avatar3d: Avatar3DConfig? = nil,
         personaSpec: PersonaSpec? = nil, createdAt: Double? = nil, isSeed: Bool? = nil) {
        self.id = id; self.name = name; self.bio = bio; self.avatarPath = avatarPath
        self.roleTag = roleTag; self.roleKind = roleKind; self.instruction = instruction
        self.ability = ability; self.coverQuote = coverQuote; self.modelV = modelV
        self.handle = handle; self.webSearchEnabled = webSearchEnabled; self.abilityRadar = abilityRadar
        self.userRules = userRules; self.voice = voice; self.avatar3d = avatar3d
        self.personaSpec = personaSpec; self.createdAt = createdAt; self.isSeed = isSeed
    }

    enum CodingKeys: String, CodingKey {
        case id, name, bio, avatarPath, roleTag, roleKind, instruction, ability, coverQuote, modelV, handle, webSearchEnabled, userRules, voice, avatar3d, personaSpec, createdAt, isSeed
    }

    /// Tolerant decode · the server sends some of these fields as objects/arrays
    /// (e.g. `ability` is the radar). A strict String decode would throw and
    /// blank the ENTIRE roster — so each soft field is decoded with `try?`,
    /// yielding nil on a type mismatch instead of failing the whole agent.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? id
        func str(_ k: CodingKeys) -> String? { (try? c.decodeIfPresent(String.self, forKey: k)) ?? nil }
        bio = str(.bio); avatarPath = str(.avatarPath); roleTag = str(.roleTag); roleKind = str(.roleKind)
        instruction = str(.instruction); ability = str(.ability); coverQuote = str(.coverQuote); modelV = str(.modelV)
        handle = str(.handle)
        webSearchEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .webSearchEnabled)) ?? nil
        // `ability` is a radar object on the profile route · decode it softly into a dict.
        abilityRadar = (try? c.decodeIfPresent([String: Double].self, forKey: .ability)) ?? nil
        userRules = (try? c.decodeIfPresent([String].self, forKey: .userRules)) ?? nil
        voice = (try? c.decodeIfPresent(AgentVoice.self, forKey: .voice)) ?? nil
        avatar3d = (try? c.decodeIfPresent(Avatar3DConfig.self, forKey: .avatar3d)) ?? nil
        personaSpec = (try? c.decodeIfPresent(PersonaSpec.self, forKey: .personaSpec)) ?? nil
        // createdAt arrives as epoch-ms or ISO-8601 (route-dependent) · reuse
        // FlexibleTime, then expose as epoch-ms for a stable numeric sort.
        let ft = (try? c.decodeIfPresent(FlexibleTime.self, forKey: .createdAt)) ?? nil
        createdAt = ft?.date.map { $0.timeIntervalSince1970 * 1000 }
        isSeed = (try? c.decodeIfPresent(Bool.self, forKey: .isSeed)) ?? nil
    }
}

/// The full-persona deep-build dossier · the 7-phase `PersonaBuilder` output
/// (`personaSpecJSONFull`) stored in `agents.persona_spec_json` and surfaced on
/// GET /api/agents/:id as `personaSpec`. Every field is optional so an older or
/// partial blob still decodes (the native build emits spec / rules / fewShot /
/// reflectionChecklist / evalSet; knowledge + divergence aren't produced yet).
struct PersonaSpec: Decodable, Hashable {
    let generatedAt: String?
    let description: String?
    let spec: Core?
    let rules: [Rule]?
    let fewShot: [FewShot]?
    let reflectionChecklist: [String]?
    let evalSet: [Eval]?

    struct Core: Decodable, Hashable {
        let intellectualLineage: [String]?
        let loadBearingConcepts: [String]?
        let referentSet: [String]?
        let failureModes: [String]?
        let contrarianTakes: [String]?
    }
    struct Rule: Decodable, Hashable { let kind: String?; let rule: String? }
    struct FewShot: Decodable, Hashable {
        let scenario: String?; let genericResponse: String?; let personaResponse: String?; let rationale: String?
    }
    struct Eval: Decodable, Hashable { let prompt: String?; let expectedSignature: String?; let divergenceScore: Double? }

    /// True when the blob carries at least one renderable section — guards the
    /// profile from showing an empty dossier card for a malformed/old row.
    var hasContent: Bool {
        let s = spec
        let specCount = (s?.intellectualLineage?.count ?? 0) + (s?.loadBearingConcepts?.count ?? 0)
            + (s?.referentSet?.count ?? 0) + (s?.failureModes?.count ?? 0) + (s?.contrarianTakes?.count ?? 0)
        return specCount + (rules?.count ?? 0) + (fewShot?.count ?? 0)
            + (reflectionChecklist?.count ?? 0) + (evalSet?.count ?? 0) > 0
    }
}

// MARK: - Usage accounting

/// GET /api/usage/summary · cumulative LLM-call token accounting. Mirrors the
/// mobile web `USAGE` shape. All counts are token totals (no cost/pricing).
struct UsageSummary: Decodable {
    let totalTokens: Int
    let agentCount: Int
    let byModel: [UsageModelRow]
    let byAgent: [UsageAgentRow]
    let retired: RetiredUsage
    let daily: [UsageDayRow]
}
struct UsageModelRow: Decodable, Hashable {
    let modelV: String
    let tokens: Int
    let agents: Int
    let displayName: String
    let provider: String
}
struct UsageAgentRow: Decodable, Hashable {
    let id: String
    let name: String
    let handle: String
    let modelV: String
    let tokens: Int
    let roleKind: String        // "moderator" | "director"
    let displayName: String
    let provider: String
}
struct RetiredUsage: Decodable {
    let tokens: Int
    let agents: Int
    let byModel: [UsageModelRow]
}
struct UsageDayRow: Decodable, Identifiable {
    let day: String             // "YYYY-MM-DD" (local time)
    let totalTokens: Int
    let byModel: [UsageModelRow]
    let byAgent: [UsageAgentRow]
    var id: String { day }
}

/// An agent's TTS voice profile (subset · the fields the native picker reads
/// and writes). PATCH /api/agents/:id requires provider + model + voiceId.
struct AgentVoice: Decodable, Hashable {
    let provider: String?
    let model: String?
    let voiceId: String?
    let emotion: String?
}

/// One selectable voice from GET /api/voices.
struct VoiceOption: Decodable, Identifiable, Hashable {
    let provider: String?
    let model: String?
    let voiceId: String
    let label: String?
    let language: String?
    let configured: Bool?
    var id: String { "\(provider ?? "")/\(voiceId)" }
    var name: String { label ?? voiceId }
}
struct VoicesResponse: Decodable {
    let voices: [VoiceOption]
    let provider: String?
    let configured: Bool?
    let error: String?
}

/// Per-director usage stats · GET /api/agents/:id/stats. Tolerant to number- or
/// string-typed values so a serializer change never blanks the panel.
struct AgentStats: Decodable {
    let rooms: Int?
    let rounds: Int?
    let tokens: Int?
    // Server keys · getAgentStats() returns roomsJoined / roundsSpoken / tokensConsumed.
    enum CodingKeys: String, CodingKey { case roomsJoined, roundsSpoken, tokensConsumed }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func intv(_ k: CodingKeys) -> Int? {
            if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
            if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d) }
            if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s.filter(\.isNumber)) }
            return nil
        }
        rooms = intv(.roomsJoined); rounds = intv(.roundsSpoken); tokens = intv(.tokensConsumed)
    }
}

/// A carried memory note · GET /api/agents/:id/memories. `id` may arrive as a
/// string or a number — decoded tolerant so one odd row never blanks the list.
struct AgentMemory: Decodable, Identifiable, Hashable {
    let id: String
    let content: String
    let pinned: Bool
    init(id: String = UUID().uuidString, content: String, pinned: Bool = false) {
        self.id = id; self.content = content; self.pinned = pinned
    }
    enum CodingKeys: String, CodingKey { case id, content, pinned }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .id) { id = s }
        else if let i = try? c.decode(Int.self, forKey: .id) { id = String(i) }
        else { id = UUID().uuidString }
        content = (try? c.decode(String.self, forKey: .content)) ?? ""
        pinned = ((try? c.decodeIfPresent(Bool.self, forKey: .pinned)) ?? nil) ?? false
    }
}

struct Member: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let avatarPath: String?
    let roleKind: String?
    var roleTag: String? = nil   // present on snapshot members (full Agent objects)
    var modelV: String? = nil
}

extension Agent {
    /// Build a lightweight Agent from a room member (for room-card avatars).
    init(member m: Member) {
        self.init(id: m.id, name: m.name, avatarPath: m.avatarPath, roleKind: m.roleKind)
    }
}

/// A generated report. We only need enough to decide readiness + build the
/// spine URL; the rich body (`bodyJson`) is rendered by the report HTML itself.
struct Brief: Decodable, Identifiable {
    let id: String
    let mode: String?
    let title: String?
    let isGenerating: Bool?
    let createdAt: Double?
    let bodyMd: String?
    let hasBodyJson: Bool

    /// Ready to view · not still generating and has a markdown OR structured body.
    var isReady: Bool { (isGenerating != true) && ((bodyMd?.isEmpty == false) || hasBodyJson) }

    enum CodingKeys: String, CodingKey { case id, mode, title, isGenerating, createdAt, bodyMd, bodyJson }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        mode = try c.decodeIfPresent(String.self, forKey: .mode)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        isGenerating = try c.decodeIfPresent(Bool.self, forKey: .isGenerating)
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt)
        bodyMd = try c.decodeIfPresent(String.self, forKey: .bodyMd)
        hasBodyJson = c.contains(.bodyJson) && ((try? c.decodeNil(forKey: .bodyJson)) == false)
    }
}

// ── Response envelopes ─────────────────────────────────────────────
struct RoomsResponse: Decodable { let rooms: [Room] }
struct AgentsResponse: Decodable { let agents: [Agent]; let chair: Agent? }
struct RoomBriefsResponse: Decodable { let briefs: [Brief] }
struct MemoriesResponse: Decodable { let memories: [AgentMemory] }
struct CreateRoomResponse: Decodable { let room: Room }

/// `GET /api/rooms/:id` · the slices the room view consumes. Unknown keys
/// (events / queue / round shape) are simply ignored by Decodable.
struct RoomSnapshot: Decodable {
    let room: Room?
    let members: [Member]?
    let chair: Member?               // moderator · returned separately (NOT in `members`, which is directors-only)
    let messages: [SnapshotMessage]?
}

struct SnapshotMessage: Decodable {
    let id: String?
    let body: String?
    let authorId: String?
    let authorKind: String?
    let roundNum: Int?
    let createdAt: FlexibleTime?
    // Web search · the chair tool-use card (kind == "tool-use") + director sources.
    let kind: String?
    let tool: String?
    let toolStatus: String?
    let searchQuery: String?
    let sources: [SearchSource]?
}

// MARK: - Provider credentials (API keys)

/// One stored API-key credential. Plaintext never leaves the server — only a
/// masked `preview` (e.g. "sk-or…YjNH"). Shape matches GET /api/credentials.
struct Credential: Decodable, Identifiable, Hashable {
    let id: String
    let provider: String
    let label: String?
    let preview: String?
    let isActive: Bool?
}

/// `{ credentials: [...], activeId }` — the same envelope for LLM, voice and
/// search credential endpoints.
struct CredentialsResponse: Decodable {
    let credentials: [Credential]
    let activeId: String?
}

// MARK: - Director generation (new director)

/// `POST /api/agents/generate-spec` → `{ spec }`. The drafted director the
/// form pre-fills (the user can edit every field before saving).
struct GeneratedSpec: Decodable {
    let name: String?
    let role: String?
    let roleTag: String?
    let bio: String?
    let instruction: String?
    let modelV: String?
    let coverQuote: String?
    var roleLabel: String? { roleTag ?? role }
}
struct GenerateSpecResponse: Decodable { let spec: GeneratedSpec? }

/// `GET /api/models` → reachable model catalog for the director model picker.
struct ModelInfo: Decodable, Identifiable, Hashable {
    let modelV: String
    let displayName: String?
    let provider: String?
    let deck: String?
    let reachable: Bool?
    var id: String { modelV }
    var label: String { displayName ?? modelV }
}
struct ModelsResponse: Decodable { let models: [ModelInfo]; let hasAnyKey: Bool? }
