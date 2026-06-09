import Foundation
import BoardroomCore

/// Root coordinator — owns the `EventBus` and one `RoomActor` per active room,
/// over a shared `RoomStore` + `EngineLLM`. The in-process replacement for the
/// desktop server's room registry. `EngineClient` is the thin app-facing facade
/// over this.
public actor Engine {
    let bus: EventBus
    private let store: RoomStore
    private let llm: EngineLLM
    private let tts: EngineTTS?
    private let router: EngineRouter?
    private let search: EngineSearch?
    private var actors: [String: RoomActor] = [:]

    public init(store: RoomStore, llm: EngineLLM, tts: EngineTTS? = nil,
                router: EngineRouter? = nil, search: EngineSearch? = nil, bus: EventBus = EventBus()) {
        self.store = store; self.llm = llm; self.tts = tts; self.router = router
        self.search = search; self.bus = bus
    }

    private func actor(_ roomId: String) -> RoomActor {
        if let a = actors[roomId] { return a }
        let a = RoomActor(roomId: roomId, bus: bus, store: store, llm: llm, tts: tts, router: router, search: search)
        actors[roomId] = a
        return a
    }

    // MARK: Control surface (routed to the room's actor)

    public func convene(_ roomId: String) async { await actor(roomId).convene() }
    public func submitUserMessage(_ roomId: String, _ text: String) async { await actor(roomId).submitUserMessage(text) }
    public func continueRoom(_ roomId: String) async { await actor(roomId).continueRound() }
    public func resumeLiveRoom(_ roomId: String) async { await actor(roomId).resumeIfLive() }
    public func pauseRoom(_ roomId: String) async { await actor(roomId).pause() }
    public func resumeRoom(_ roomId: String) async { await actor(roomId).resume() }
    public func voteKeyPoint(_ kpId: String, vote: String?) async { await store.setKeyPointVote(kpId, vote: vote) }
    public func voiceDone(_ roomId: String, _ messageId: String) async { await actor(roomId).signalVoiceDone(messageId) }

    /// Synthesize `text` (in `agentId`'s voice) into ONE concatenated MP3 ·
    /// on-demand audio for adjourned-room replay (the engine streams voice live
    /// but doesn't persist per-message clips). Returns nil with no TTS configured
    /// or an empty stream (no voice key). MP3 frames concatenate playably — the
    /// same way the live player joins a sentence's chunks.
    public func synthesize(text: String, agentId: String) async -> Data? {
        guard let tts, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        var out = Data()
        for await s in tts.synthesizeStream(text, agentId: agentId) {
            if let d = Data(base64Encoded: s.audioBase64) { out.append(d) }
        }
        return out.isEmpty ? nil : out
    }

    /// Generate + persist the closing brief (single-call MVP). Returns markdown.
    /// Requires the store to also be a `BriefStore`.
    public func generateBrief(_ roomId: String, supplement: String? = nil,
                              mode: BriefGenerator.Mode = .researchNote) async throws -> String {
        guard let briefStore = store as? BriefStore else { throw BriefError.empty }
        let gen = BriefGenerator(store: store, llm: llm, router: router)
        return try await gen.generate(roomId: roomId, briefStore: briefStore, supplement: supplement, mode: mode).markdown
    }

    public func latestBriefMarkdown(_ roomId: String) async -> String? {
        guard let briefStore = store as? BriefStore else { return nil }
        return await briefStore.latestBriefMarkdown(roomId: roomId)
    }
    public func adjourn(_ roomId: String) async { await actor(roomId).adjourn() }

    // MARK: Event subscription (forwarded to the bus)

    func subscribe(_ roomId: String, after lastEventID: Int?) -> AsyncStream<EventBus.Stamped> {
        // `bus.subscribe` is itself an actor call; await it then forward. Built as
        // a fresh stream so the caller's signature stays synchronous.
        let bus = self.bus
        return AsyncStream { continuation in
            let task = Task {
                let sub = await bus.subscribe(roomId, after: lastEventID)
                for await stamped in sub {
                    if Task.isCancelled { break }
                    continuation.yield(stamped)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
