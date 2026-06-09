import Foundation
import BoardroomCore
import BoardroomAI

/// Domain types + injected seams for the orchestration engine. The seams
/// (`EngineLLM`, `RoomStore`) let `RoomActor`'s state machine be driven by stubs
/// in tests and by the real `LLMAdapter` + GRDB store in the app.

public enum RoomStatus: String, Sendable { case live, paused, adjourned }

public enum RoundKind: String, Sendable {
    case opening      // first round · all directors react to the user's question
    case reactive     // subsequent round · directors react to the prior turn
    case resume       // continue after a round-end
    case force        // single @-mentioned speaker
}

public struct DirectorRef: Sendable, Equatable {
    public let id: String
    public let name: String
    public let modelV: ModelV
    public let handle: String        // @handle (byline + history prefix)
    public let roleTag: String       // e.g. "skeptic" (cast list)
    public let instruction: String   // the agent's system-prompt identity
    public let bio: String           // short blurb · pickNextSpeaker / pickDirectors roster
    public let ability: [String: Int]      // lens axis → 0..10 · pickDirectors lens coverage
    public let contrarianTakes: [String]   // persona spec · dissent-gap roster annotations
    public let failureModes: [String]      // persona spec · dissent-gap negative signal
    public let fewShot: [PersonaBuilder.PersonaFewShot]  // persona spec · voice examples (#12)
    public let reflectionChecklist: [String]             // persona spec · silent self-check (#12)
    public let userRules: [String]         // user-authored NON-NEGOTIABLE directives (tail block)
    public let webSearchEnabled: Bool      // per-director web-search opt-in (#10 gating)
    public init(id: String, name: String, modelV: ModelV,
                handle: String = "", roleTag: String = "", instruction: String = "",
                bio: String = "", ability: [String: Int] = [:],
                contrarianTakes: [String] = [], failureModes: [String] = [],
                fewShot: [PersonaBuilder.PersonaFewShot] = [], reflectionChecklist: [String] = [],
                userRules: [String] = [], webSearchEnabled: Bool = false) {
        self.id = id; self.name = name; self.modelV = modelV
        self.handle = handle; self.roleTag = roleTag; self.instruction = instruction
        self.bio = bio; self.ability = ability
        self.contrarianTakes = contrarianTakes; self.failureModes = failureModes
        self.fewShot = fewShot; self.reflectionChecklist = reflectionChecklist
        self.userRules = userRules; self.webSearchEnabled = webSearchEnabled
    }
}

/// Room-level context the prompt builders need (subject / tone / intensity /
/// user name). The Swift counterpart of the `room` + `prefs` fields the desktop
/// prompt builders read.
public struct RoomMeta: Sendable, Equatable {
    public let subject: String
    public let mode: String
    public let intensity: String
    public let userName: String
    public let deliveryVoice: Bool
    public let parentRoomId: String?   // follow-up rooms · the prior session this continues (#11)
    public init(subject: String, mode: String, intensity: String, userName: String,
                deliveryVoice: Bool = false, parentRoomId: String? = nil) {
        self.subject = subject; self.mode = mode; self.intensity = intensity
        self.userName = userName; self.deliveryVoice = deliveryVoice; self.parentRoomId = parentRoomId
    }
}

/// Prior-session context for a follow-up room (the data `buildFollowUpPriorContext`
/// renders) · the parent room's number + subject and its latest filed brief.
/// Native briefs don't persist per-director `assets_json` signals, so the signals
/// section degrades to brief-markdown-only (a faithful desktop fallback path).
public struct PriorContextData: Sendable, Equatable {
    public let parentNumber: Int
    public let parentSubject: String
    public let briefTitle: String?
    public let briefBodyMd: String?
    public init(parentNumber: Int, parentSubject: String, briefTitle: String?, briefBodyMd: String?) {
        self.parentNumber = parentNumber; self.parentSubject = parentSubject
        self.briefTitle = briefTitle; self.briefBodyMd = briefBodyMd
    }
}

/// A persisted message (the engine's view; the GRDB store maps it to `messages`).
public struct EngineMessage: Sendable, Equatable {
    public var id: String
    public var roomId: String
    public var authorKind: String        // "agent" | "user" | "system"
    public var authorId: String?
    public var body: String
    public var roundNum: Int
    public var streaming: Bool
    public var kind: String?             // chair kinds: "clarify" | "round-end" | "tool-use" | …
    // Web search · set on the chair's tool-use card (kind == "tool-use"); director
    // sources are written post-finalize via `setMessageSearch`.
    public var tool: String?             // "web-search"
    public var toolStatus: String?       // "done"
    public var searchQuery: String?
    public var sources: [EngineSearchSource]?
    public init(id: String, roomId: String, authorKind: String, authorId: String?,
                body: String, roundNum: Int, streaming: Bool, kind: String? = nil,
                tool: String? = nil, toolStatus: String? = nil,
                searchQuery: String? = nil, sources: [EngineSearchSource]? = nil) {
        self.id = id; self.roomId = roomId; self.authorKind = authorKind; self.authorId = authorId
        self.body = body; self.roundNum = roundNum; self.streaming = streaming; self.kind = kind
        self.tool = tool; self.toolStatus = toolStatus; self.searchQuery = searchQuery; self.sources = sources
    }
}

/// LLM streaming seam — `LLMAdapter` conforms in the app; a scripted stub drives
/// tests. `purpose` lets the prompt builder + stubs distinguish call sites.
public enum LLMPurpose: String, Sendable { case clarify, director, roundEnd }

public protocol EngineLLM: Sendable {
    func stream(_ messages: [LLMMessage], modelV: ModelV, maxTokens: Int?, purpose: LLMPurpose)
        -> AsyncThrowingStream<LLMStreamChunk, Error>
}

/// Router/utility-model seam · the foundation for every Phase-4 background LLM
/// subsystem (speaker pickers, frame-break, convergence-LLM, summarize, memory,
/// dream, brief). Mirrors the desktop `utilityModelFor()` / `effectiveDefaultModel()`
/// + the `callLLM()` drain-stream-to-string helper. The app implements it over
/// `LLMAdapter` + `Availability` + the active LLM credential; tests inject a
/// scripted router. `utilityModelV`/`defaultModelV` return nil when the user has
/// no reachable model — the universal "skip the LLM step" gate in every picker.
public protocol EngineRouter: Sendable {
    /// Cheap/fast utility model under the active carrier (haiku tier), or nil.
    func utilityModelV() -> ModelV?
    /// The user's default/fast model under the active carrier (consequential picks).
    func defaultModelV() -> ModelV?
    /// Reachable model set under the active carrier.
    func reachableModelVs() -> Set<ModelV>
    /// One-shot call · drains the streamed text into one string. Throws on stream
    /// error (the native `LLMError`, e.g. `.noKey`), mirroring desktop `callLLM`.
    func call(_ messages: [LLMMessage], modelV: ModelV, temperature: Double?, maxTokens: Int?) async throws -> String
}

public extension EngineRouter {
    /// `effectiveDefaultModel() ?? utilityModelFor()` — the consequential-pick
    /// resolver used by the director picker.
    func pickerModelV() -> ModelV? { defaultModelV() ?? utilityModelV() }
}

/// TTS seam · synthesize one turn's spoken audio, sentence-by-sentence. The app
/// implements this over `BoardroomVoice.TTSService` (reading the agent's voice
/// profile); tests use a stub. Yields one `(seg, text, base64MP3)` per sentence
/// AS IT FINISHES — so the engine emits each `voice-chunk` incrementally and the
/// native `VoicePlayer` can start playing sentence 0 while sentence 1 is still
/// synthesizing (desktop parity). Critically this lets the engine emit
/// `message-final` BEFORE synthesis (the text is done the moment the LLM stream
/// ends), so the thinking cue stops immediately instead of looping under the
/// full multi-sentence synth. An empty stream (no voice key / TTS failure) is
/// fine — the engine emits `voice-final` anyway so the room never strands.
public protocol EngineTTS: Sendable {
    /// Synthesize `text` for `agentId`, yielding `(seg, segmentText, base64MP3)`
    /// per sentence in order (seg = 0,1,2… over sentences that produced audio).
    func synthesizeStream(_ text: String, agentId: String) -> AsyncStream<(seg: Int, text: String, audioBase64: String)>
}

/// Web-search seam (#10) · the app implements this over `BoardroomSearch.WebSearch`
/// + the active search credential (keychain). RoomActor runs it per-turn when the
/// turn warrants fresh info (research mode / per-director opt-in / chair clarify).
/// nil app-side = no search; tests pass nil. `hasKey` gates the cheap per-turn
/// query-router so no routing call is made when no provider key is configured.
public protocol EngineSearch: Sendable {
    var hasKey: Bool { get }
    /// Run `query`; returns the formatted SHARED MATERIALS block + sources, or nil
    /// on no-key / no-results / failure. MUST NOT throw — a turn must never strand
    /// on a search failure; the speaker just answers without the block.
    func run(_ query: String) async -> EngineSearchOutput?
}

public struct EngineSearchSource: Sendable, Equatable {
    public let title: String, url: String, description: String
    public init(title: String, url: String, description: String) {
        self.title = title; self.url = url; self.description = description
    }
}
public struct EngineSearchOutput: Sendable, Equatable {
    public let materials: String                 // formatted SHARED MATERIALS block
    public let sources: [EngineSearchSource]
    public init(materials: String, sources: [EngineSearchSource]) {
        self.materials = materials; self.sources = sources
    }
}

/// Persistence seam — only the ops the MVP loop needs. The GRDB-backed impl
/// (Phase 3 wiring) and the in-memory test stub both conform.
public protocol RoomStore: Sendable {
    func directors(_ roomId: String) async -> [DirectorRef]
    func chair(_ roomId: String) async -> DirectorRef?
    func roomMeta(_ roomId: String) async -> RoomMeta?
    func nextRoundNum(_ roomId: String) async -> Int
    func insertMessage(_ m: EngineMessage) async
    func finalizeMessage(_ id: String, body: String) async
    func recentMessages(_ roomId: String, limit: Int) async -> [EngineMessage]
    func insertKeyPoints(_ roomId: String, roundNum: Int, points: [String]) async -> [ConfigEvent.KeyPoint]
    func setKeyPointVote(_ kpId: String, vote: String?) async
    func setStatus(_ roomId: String, _ status: RoomStatus) async
    func setAwaitingClarify(_ roomId: String, _ v: Bool) async
    func setAwaitingContinue(_ roomId: String, _ v: Bool) async
    /// Hard-delete a message row (chairInterrupt drops the aborted partial bubble).
    /// Default no-op so existing stub stores don't need to implement it.
    func deleteMessage(_ id: String) async
    /// Persisted room phase · lets a freshly-created `RoomActor` (re-entry / app
    /// relaunch) restore its gating flags + round instead of starting fresh.
    /// Default nil so stub stores keep their in-memory behaviour.
    func roomState(_ roomId: String) async -> RoomState?
    /// Round-end key points the user has VOTED on across the whole room (vote
    /// up/down only), in chronological order (port of `listKeyPointsForRoom` →
    /// the `keyPoints` feed into buildDirectorMessages). Drives the director's
    /// "USER SIGNAL · WEIGHT THIS" interest block. Default [] for stub stores.
    func votedKeyPoints(_ roomId: String) async -> [ConfigEvent.KeyPoint]
    /// Prior-session context for a follow-up room (port of the room.ts:1885 fetch)
    /// · parent room number + subject + its latest brief. nil when the parent is
    /// missing (orphan follow-up). Default nil for stub stores.
    func priorContext(parentRoomId: String) async -> PriorContextData?
    /// Bill `tokens` to `agentId` after a turn's LLM stream reports usage · port of
    /// `incrementAgentTokens` (agents.ts:857): bumps `agents.tokens_consumed` and
    /// UPSERTs the per-day `usage_daily` row (model_v snapshotted from the agent),
    /// the two tables the Usage panel aggregates. Default no-op for stub stores.
    func recordUsage(agentId: String, tokens: Int) async
    /// Attach web-search query + sources to a director message's meta AFTER it
    /// finalizes (the search result isn't known when the streaming row is inserted).
    /// Merges into the existing meta_json so reload re-renders the sources badge.
    /// Default no-op for stub stores.
    func setMessageSearch(_ id: String, query: String?, sources: [EngineSearchSource]) async
}

/// The persisted gating state the actor hydrates on re-entry (status + awaiting
/// flags + the highest round number seen so far).
public struct RoomState: Sendable, Equatable {
    public let status: RoomStatus
    public let awaitingClarify: Bool
    public let awaitingContinue: Bool
    public let maxRound: Int
    public init(status: RoomStatus, awaitingClarify: Bool, awaitingContinue: Bool, maxRound: Int) {
        self.status = status; self.awaitingClarify = awaitingClarify
        self.awaitingContinue = awaitingContinue; self.maxRound = maxRound
    }
}

public extension RoomStore {
    func deleteMessage(_ id: String) async { }
    func roomState(_ roomId: String) async -> RoomState? { nil }
    func votedKeyPoints(_ roomId: String) async -> [ConfigEvent.KeyPoint] { [] }
    func priorContext(parentRoomId: String) async -> PriorContextData? { nil }
    func recordUsage(agentId: String, tokens: Int) async { }
    func setMessageSearch(_ id: String, query: String?, sources: [EngineSearchSource]) async { }
}
