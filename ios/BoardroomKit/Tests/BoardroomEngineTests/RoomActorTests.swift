import XCTest
import BoardroomCore
import BoardroomAI
@testable import BoardroomEngine

// MARK: - Stubs

/// Scripted LLM: returns canned text per purpose, advancing through the list and
/// repeating the last entry. Each response streams as a few text-deltas + done.
final class ScriptedLLM: EngineLLM, @unchecked Sendable {
    private let lock = NSLock()
    private var clarify: [String], director: [String], roundEnd: [String]
    private var ci = 0, di = 0, ri = 0
    var emitDone = true   // toggle to test the "no explicit done" finalize path

    init(clarify: [String], director: [String], roundEnd: [String]) {
        self.clarify = clarify; self.director = director; self.roundEnd = roundEnd
    }

    func stream(_ messages: [LLMMessage], modelV: String, maxTokens: Int?, purpose: LLMPurpose)
        -> AsyncThrowingStream<LLMStreamChunk, Error> {
        let text: String = {
            lock.lock(); defer { lock.unlock() }
            switch purpose {
            case .clarify:  let v = clarify[min(ci, clarify.count - 1)]; ci += 1; return v
            case .director: let v = director[min(di, director.count - 1)]; di += 1; return v
            case .roundEnd: let v = roundEnd[min(ri, roundEnd.count - 1)]; ri += 1; return v
            }
        }()
        let done = emitDone
        return AsyncThrowingStream { cont in
            for word in text.split(separator: " ", omittingEmptySubsequences: false) {
                cont.yield(.textDelta(String(word) + " "))
            }
            if done { cont.yield(.done(finishReason: "stop")) }
            cont.finish()
        }
    }
}

/// LLM that throws immediately (error-path test).
struct ThrowingLLM: EngineLLM {
    func stream(_ messages: [LLMMessage], modelV: String, maxTokens: Int?, purpose: LLMPurpose)
        -> AsyncThrowingStream<LLMStreamChunk, Error> {
        AsyncThrowingStream { $0.finish(throwing: LLMError.upstream("boom")) }
    }
}

actor InMemoryStore: RoomStore {
    private var messages: [EngineMessage] = []
    private let dirs: [DirectorRef]
    private let chairRef: DirectorRef?
    private(set) var status: RoomStatus = .live
    private(set) var awaitingClarify = false
    private(set) var awaitingContinue = false
    private var kpSeq = 0

    private var meta: RoomMeta?
    private var stateSeed: RoomState?
    init(directors: [DirectorRef], chair: DirectorRef?, meta: RoomMeta? = nil, stateSeed: RoomState? = nil) {
        dirs = directors; chairRef = chair; self.meta = meta; self.stateSeed = stateSeed
        if let s = stateSeed { status = s.status; awaitingClarify = s.awaitingClarify; awaitingContinue = s.awaitingContinue }
    }
    // Re-entry hydration source · returns the seeded persisted phase (nil → the
    // actor keeps its in-memory defaults, matching the scripted-LLM tests).
    func roomState(_ roomId: String) -> RoomState? { stateSeed }

    func directors(_ roomId: String) -> [DirectorRef] { dirs }
    func chair(_ roomId: String) -> DirectorRef? { chairRef }
    // nil → RoomActor uses the deterministic tagged stub prompt, so the
    // scripted-LLM tests stay independent of prompt content. A non-nil meta
    // switches in the real prompt builders (the scripted LLM ignores content).
    func roomMeta(_ roomId: String) -> RoomMeta? { meta }
    private(set) var deletedIds: [String] = []
    func deleteMessage(_ id: String) { deletedIds.append(id); messages.removeAll { $0.id == id } }
    func messageKinds(authoredBy authorId: String) -> [String] {
        messages.filter { $0.authorId == authorId }.map { $0.kind ?? "" }
    }
    func nextRoundNum(_ roomId: String) -> Int { (messages.map(\.roundNum).max() ?? 0) + 1 }
    func insertMessage(_ m: EngineMessage) { messages.append(m) }
    func finalizeMessage(_ id: String, body: String) {
        if let i = messages.firstIndex(where: { $0.id == id }) { messages[i].body = body; messages[i].streaming = false }
    }
    func recentMessages(_ roomId: String, limit: Int) -> [EngineMessage] { Array(messages.suffix(limit)) }
    func insertKeyPoints(_ roomId: String, roundNum: Int, points: [String]) -> [ConfigEvent.KeyPoint] {
        let kps = points.enumerated().map { i, p -> ConfigEvent.KeyPoint in kpSeq += 1; return ConfigEvent.KeyPoint(id: "kp\(kpSeq)", body: p, position: i, vote: nil) }
        keyPoints.append(contentsOf: kps); return kps
    }
    private(set) var keyPoints: [ConfigEvent.KeyPoint] = []
    private(set) var votes: [String: String] = [:]
    func setKeyPointVote(_ kpId: String, vote: String?) { if let v = vote { votes[kpId] = v } else { votes[kpId] = nil } }
    func setStatus(_ roomId: String, _ s: RoomStatus) { status = s }
    func setAwaitingClarify(_ roomId: String, _ v: Bool) { awaitingClarify = v }
    func setAwaitingContinue(_ roomId: String, _ v: Bool) { awaitingContinue = v }

    var streamingCount: Int { messages.filter(\.streaming).count }
    var agentMessageCount: Int { messages.filter { $0.authorKind == "agent" }.count }
}

// MARK: - Tests

final class RoomActorTests: XCTestCase {
    private func makeActor(_ llm: EngineLLM) async -> (RoomActor, EventBus, InMemoryStore) {
        let bus = EventBus()
        let store = InMemoryStore(
            directors: [DirectorRef(id: "d1", name: "Alice", modelV: .opus_4_7),
                        DirectorRef(id: "d2", name: "Bob", modelV: .sonnet_4_6)],
            chair: DirectorRef(id: "chair", name: "Chair", modelV: .haiku_4_5))
        let actor = RoomActor(roomId: "r1", bus: bus, store: store, llm: llm)
        return (actor, bus, store)
    }

    private func kinds(_ events: [RoomEvent]) -> [String] {
        events.compactMap { if case .configEvent(let c) = $0 { return c.kind } else { return nil } }
    }

    func testClarifyAsksThenReleasesOnReady() async {
        let llm = ScriptedLLM(clarify: ["What is your budget?", "READY"],
                              director: ["My view."],
                              roundEnd: ["Done.\nPOINTS:\n- alpha\n- beta"])
        let (actor, bus, store) = await makeActor(llm)

        await actor.convene()                              // chair asks (no READY)
        var aw = await actor.isAwaitingClarify
        XCTAssertTrue(aw, "should await clarify after the chair asks")
        let k1 = await kinds(bus.snapshot("r1"))
        XCTAssertTrue(k1.contains("clarify-ready"))

        await actor.submitUserMessage("$10k")              // → clarify turn 2 → READY → opening round
        aw = await actor.isAwaitingClarify
        XCTAssertFalse(aw, "READY should release directors")
        let awc = await actor.isAwaitingContinue
        XCTAssertTrue(awc, "round drains → round-ended → awaiting continue")

        let evKinds = await kinds(bus.snapshot("r1"))
        XCTAssertTrue(evKinds.contains("round-ended"))
        // Two directors spoke this round.
        let agentMsgs = await store.agentMessageCount
        XCTAssertGreaterThanOrEqual(agentMsgs, 3)          // 2 directors + ≥1 chair turn
        // No message left streaming.
        let streaming = await store.streamingCount
        XCTAssertEqual(streaming, 0)
    }

    func testRoundEndSpokenStripsStructuralTokens() {
        let body = """
        We converged on pricing but split on timing.

        POINTS:
        - Anchor on willingness-to-pay, not cost
        - Ship the pilot before Q3
        - The moat is distribution, not the model

        MODE-SHIFT: debate
        BECAUSE: the room is circling on opinion
        """
        let spoken = RoomActor.roundEndSpoken(body)
        XCTAssertFalse(spoken.localizedCaseInsensitiveContains("POINTS"))
        XCTAssertFalse(spoken.localizedCaseInsensitiveContains("MODE-SHIFT"))
        XCTAssertFalse(spoken.localizedCaseInsensitiveContains("BECAUSE"))
        XCTAssertFalse(spoken.contains("- "))                       // dash bullets gone
        XCTAssertTrue(spoken.contains("converged on pricing"))      // ping kept
        XCTAssertTrue(spoken.contains("willingness-to-pay"))        // point content kept as prose
        XCTAssertFalse(spoken.contains("debate"))                   // tone tail dropped
    }

    func testLooksLikeMetaSilenceCatchesAbstentions() {
        // CJK silence parens + phrases.
        XCTAssertTrue(RoomActor.looksLikeMetaSilence("（沉默）"))
        XCTAssertTrue(RoomActor.looksLikeMetaSilence("(silent)"))
        XCTAssertTrue(RoomActor.looksLikeMetaSilence("我没有更多要补充的"))
        XCTAssertTrue(RoomActor.looksLikeMetaSilence("本轮跳过"))
        XCTAssertTrue(RoomActor.looksLikeMetaSilence("我选择沉默"))
        // English abstentions.
        XCTAssertTrue(RoomActor.looksLikeMetaSilence("I have nothing more to add."))
        XCTAssertTrue(RoomActor.looksLikeMetaSilence("Passing this round."))
        XCTAssertTrue(RoomActor.looksLikeMetaSilence("nothing to contribute"))
        // Pure punctuation / whitespace = silence.
        XCTAssertTrue(RoomActor.looksLikeMetaSilence("…"))
        XCTAssertTrue(RoomActor.looksLikeMetaSilence("（ — ）"))
        // Real contributions are NOT silence.
        XCTAssertFalse(RoomActor.looksLikeMetaSilence("Anchor on willingness-to-pay, not cost."))
        XCTAssertFalse(RoomActor.looksLikeMetaSilence("我认为我们应该先做小规模试点再决定。"))
        // >60 chars short-circuits to NOT silence even if it mentions 沉默.
        XCTAssertFalse(RoomActor.looksLikeMetaSilence(String(repeating: "沉默的螺旋是一个值得讨论的现象，", count: 6)))
    }

    func testStripUserAcknowledgmentPrefaceDropsEchoLead() {
        // Expected values are GROUND-TRUTH from running desktop's JS
        // stripUserAcknowledgmentPreface verbatim — the native port must match
        // byte-for-byte, including the quirk below.
        //
        // ZH echo lead, paragraph-separated → first sentence dropped, substance kept
        // (the `。\n` is what the terminator matches).
        XCTAssertEqual(
            RoomActor.stripUserAcknowledgmentPreface("既然你坚持要量化，那我先给一个粗略的区间。\n核心风险在于客户流失。"),
            "核心风险在于客户流失。")
        // Optional "name，" prefix before the echo lead.
        XCTAssertEqual(
            RoomActor.stripUserAcknowledgmentPreface("Kaysaith，既然你提到成本，我补充一点。\n利润才是关键。"),
            "利润才是关键。")
        // EN echo lead — ". " (period-space) is the terminator.
        XCTAssertEqual(
            RoomActor.stripUserAcknowledgmentPreface("Since you asked about margins, here goes. The real lever is distribution."),
            "The real lever is distribution.")
        // DESKTOP QUIRK (must mirror) · inline Chinese with NO space/newline after 。
        // — the terminator `[。.](?:\s|$|\n)` skips the mid-sentence 。 (followed by a
        // CJK char) and matches only the final 。 at EOL, stripping everything → "".
        XCTAssertEqual(
            RoomActor.stripUserAcknowledgmentPreface("既然你坚持要量化，那我先给一个粗略的区间。核心风险在于客户流失。"),
            "")
        // No echo lead → body untouched.
        let plain = "Distribution is the moat, not the model."
        XCTAssertEqual(RoomActor.stripUserAcknowledgmentPreface(plain), plain)
        // Echo lead but no terminator within window → left alone (don't truncate).
        let noTerm = "Since you asked " + String(repeating: "and so on ", count: 40)
        XCTAssertEqual(RoomActor.stripUserAcknowledgmentPreface(noTerm), noTerm)
    }

    func testConveningBuilderNamesTheCast() {
        let ctx = ChairPromptBuilder.Context(
            chairInstruction: "You are the Chair.", subject: "Should we raise a Series A?",
            mode: "constructive", intensity: "sharp",
            directors: [], userName: "Kai")
        let picks = [
            ChairPromptBuilder.ConveningPick(name: "Hypatia", handle: "@hypatia", roleTag: "first-principles", bio: "reasons from unit economics"),
            ChairPromptBuilder.ConveningPick(name: "Diogenes", handle: "@diogenes", roleTag: "contrarian", bio: "attacks the premise"),
        ]
        let msgs = ChairPromptBuilder.convening(ctx, picks: picks)
        let sys = msgs.first { $0.role == .system }?.content ?? ""
        XCTAssertTrue(sys.contains("INTRODUCE THE CAST"))
        XCTAssertTrue(sys.contains("**Hypatia** · **Diogenes**"))   // bold-joined enumeration
        XCTAssertTrue(sys.contains("reasons from unit economics"))  // bio drives the angle
        XCTAssertTrue(sys.contains("Should we raise a Series A?"))   // subject
    }

    func testHydrateRestoresAwaitingContinueOnReEntry() async {
        // A fresh actor for a room that previously ended round 2 awaiting Continue.
        // Without hydration `continueRound` would no-op (awaitingContinue defaults
        // false); with it the round resumes — directors react with prior context.
        let llm = ScriptedLLM(clarify: ["READY"], director: ["building on the last round"],
                              roundEnd: ["wrap\nPOINTS:\n- a"])
        let store = InMemoryStore(
            directors: [DirectorRef(id: "d1", name: "Alice", modelV: .opus_4_7)],
            chair: DirectorRef(id: "chair", name: "Chair", modelV: .haiku_4_5),
            stateSeed: RoomState(status: .live, awaitingClarify: false, awaitingContinue: true, maxRound: 2))
        // Prior discussion exists (rounds 1-2) so the next round is 3.
        await store.insertMessage(EngineMessage(id: "u0", roomId: "r1", authorKind: "user", authorId: nil, body: "kickoff", roundNum: 1, streaming: false))
        await store.insertMessage(EngineMessage(id: "a2", roomId: "r1", authorKind: "agent", authorId: "d1", body: "round 2 take", roundNum: 2, streaming: false))
        let actor = RoomActor(roomId: "r1", bus: EventBus(), store: store, llm: llm)
        let before = await store.agentMessageCount
        await actor.continueRound()
        let after = await store.agentMessageCount
        XCTAssertGreaterThan(after, before, "the round resumed (new turns) instead of no-op")
        let round = await actor.currentRound
        XCTAssertGreaterThanOrEqual(round, 3, "resumed at the next round, not round 1")
    }

    // MARK: resumeIfLive · re-entry into an interrupted live room

    private func liveStore(status: RoomStatus, awaitingContinue: Bool) async -> InMemoryStore {
        let store = InMemoryStore(
            directors: [DirectorRef(id: "d1", name: "Alice", modelV: .opus_4_7)],
            chair: DirectorRef(id: "chair", name: "Chair", modelV: .haiku_4_5),
            stateSeed: RoomState(status: status, awaitingClarify: false, awaitingContinue: awaitingContinue, maxRound: 2))
        await store.insertMessage(EngineMessage(id: "u0", roomId: "r1", authorKind: "user", authorId: nil, body: "kickoff", roundNum: 1, streaming: false))
        await store.insertMessage(EngineMessage(id: "a2", roomId: "r1", authorKind: "agent", authorId: "d1", body: "round 2 take", roundNum: 2, streaming: false))
        return store
    }

    func testResumeIfLiveContinuesInterruptedRound() async {
        // Live, not awaiting (mid-round, interrupted) → continue with a fresh round.
        let llm = ScriptedLLM(clarify: ["READY"], director: ["continuing the discussion"],
                              roundEnd: ["wrap\nPOINTS:\n- a"])
        let store = await liveStore(status: .live, awaitingContinue: false)
        let actor = RoomActor(roomId: "r1", bus: EventBus(), store: store, llm: llm)
        let before = await store.agentMessageCount
        await actor.resumeIfLive()
        let after = await store.agentMessageCount
        XCTAssertGreaterThan(after, before, "interrupted live room resumed (new turns)")
        let round = await actor.currentRound
        XCTAssertGreaterThanOrEqual(round, 3, "resumed at the next round")
    }

    func testResumeIfLiveNoOpWhenAwaitingContinue() async {
        // Round ended (awaiting Continue) → wait for the user's button, no auto-resume.
        let llm = ScriptedLLM(clarify: ["READY"], director: ["should not speak"], roundEnd: ["x"])
        let store = await liveStore(status: .live, awaitingContinue: true)
        let actor = RoomActor(roomId: "r1", bus: EventBus(), store: store, llm: llm)
        let before = await store.agentMessageCount
        await actor.resumeIfLive()
        let after = await store.agentMessageCount
        XCTAssertEqual(after, before, "awaiting-Continue waits for the user")
    }

    func testResumeIfLiveNoOpWhenPaused() async {
        // Paused → wait for the play button, never auto-start.
        let llm = ScriptedLLM(clarify: ["READY"], director: ["should not speak"], roundEnd: ["x"])
        let store = await liveStore(status: .paused, awaitingContinue: false)
        let actor = RoomActor(roomId: "r1", bus: EventBus(), store: store, llm: llm)
        let before = await store.agentMessageCount
        await actor.resumeIfLive()
        let after = await store.agentMessageCount
        XCTAssertEqual(after, before, "paused room never auto-starts")
    }

    func testMessageIdsUniqueAcrossActorSessions() async {
        // Re-entry / relaunch creates a FRESH actor. Its message ids MUST NOT collide
        // with the prior session's — messages.id is the PK, so a per-actor counter
        // (m1,m2,…) would re-emit colliding ids; the dropped INSERT + finalize/delete
        // then clobbers the OLD message and the transcript is lost. UUID ids prevent it.
        let store = InMemoryStore(
            directors: [DirectorRef(id: "d1", name: "Alice", modelV: .opus_4_7)],
            chair: DirectorRef(id: "chair", name: "Chair", modelV: .haiku_4_5))
        func runSession() async {
            let llm = ScriptedLLM(clarify: ["READY"], director: ["a substantive take on the roadmap, building on prior points"],
                                  roundEnd: ["wrap\nPOINTS:\n- a"])
            let actor = RoomActor(roomId: "r1", bus: EventBus(), store: store, llm: llm)
            await actor.submitUserMessage("let's discuss the roadmap")
        }
        await runSession()
        await runSession()   // a second, fresh actor on the same store (re-entry)
        let ids = (await store.recentMessages("r1", limit: 1000)).map(\.id)
        XCTAssertGreaterThan(ids.count, 2, "both sessions produced messages")
        XCTAssertEqual(Set(ids).count, ids.count, "message ids must be globally unique across actor sessions")
    }

    func testChairInterruptRunsChairDirect() async {
        // After the opening round drains (awaiting continue, not processing), an
        // @chair message routes to runChairDirect → a chair-direct turn appears.
        let llm = ScriptedLLM(clarify: ["READY"], director: ["v"],
                              roundEnd: ["w\nPOINTS:\n- a", "Meta: directors converged on X; Y unresolved."])
        let bus = EventBus()
        let store = InMemoryStore(
            directors: [DirectorRef(id: "d1", name: "Alice", modelV: .opus_4_7)],
            chair: DirectorRef(id: "chair", name: "Chair", modelV: .haiku_4_5, handle: "@chair"),
            meta: RoomMeta(subject: "S", mode: "constructive", intensity: "medium", userName: "Kai"))
        let actor = RoomActor(roomId: "r1", bus: bus, store: store, llm: llm)
        await actor.convene()                                  // opening round → round-ended → awaiting continue
        let beforeAgent = await store.agentMessageCount
        await actor.submitUserMessage("@chair what's the state of the room?")
        let afterAgent = await store.agentMessageCount
        XCTAssertGreaterThan(afterAgent, beforeAgent, "chair-direct adds an agent turn")
        let chairKinds = await store.messageKinds(authoredBy: "chair")
        XCTAssertTrue(chairKinds.contains("chair-direct"), "a chair-direct turn was emitted")
        let streaming = await store.streamingCount
        XCTAssertEqual(streaming, 0)                            // chair-direct finalized cleanly
    }

    func testRoundEndedCarriesKeyPoints() async {
        let llm = ScriptedLLM(clarify: ["READY"], director: ["v"],
                              roundEnd: ["Wrap.\nPOINTS:\n- alpha\n- beta\n- gamma"])
        let (actor, bus, _) = await makeActor(llm)
        await actor.convene()                              // READY immediately → opening round → round-ended
        let events = await bus.snapshot("r1")
        let roundEnded = events.compactMap { e -> ConfigEvent? in
            if case .configEvent(let c) = e, c.kind == "round-ended" { return c }; return nil
        }.first
        XCTAssertEqual(roundEnded?.payload?.keyPoints?.map(\.body), ["alpha", "beta", "gamma"])
    }

    func testContinueRunsAnotherRound() async {
        let llm = ScriptedLLM(clarify: ["READY"], director: ["v"], roundEnd: ["w\nPOINTS:\n- a"])
        let (actor, _, store) = await makeActor(llm)
        await actor.convene()
        let c1 = await actor.isAwaitingContinue
        XCTAssertTrue(c1)
        let before = await store.agentMessageCount
        await actor.continueRound()
        let c2 = await actor.isAwaitingContinue
        XCTAssertTrue(c2)                                   // next round also ended
        let after = await store.agentMessageCount
        XCTAssertGreaterThan(after, before)                 // more turns happened
    }

    func testAdjourn() async {
        let llm = ScriptedLLM(clarify: ["READY"], director: ["v"], roundEnd: ["w\nPOINTS:\n- a"])
        let (actor, bus, store) = await makeActor(llm)
        await actor.convene()
        await actor.adjourn()
        let st = await actor.currentStatus
        XCTAssertEqual(st, .adjourned)
        let storeSt = await store.status
        XCTAssertEqual(storeSt, .adjourned)
        let k = await kinds(bus.snapshot("r1"))
        XCTAssertTrue(k.contains("room-adjourned"))
    }

    func testFinalizeInvariantOnErrorPath() async {
        let (actor, bus, store) = await makeActor(ThrowingLLM())
        await actor.convene()                               // chair clarify throws
        let streaming = await store.streamingCount
        XCTAssertEqual(streaming, 0, "errored turn must still finalize (streaming:false)")
        // The error is surfaced as a visible ⚠️ hint token (not a silent
        // message-error), so the user can see + act on it.
        let hint = await bus.snapshot("r1").contains {
            if case .messageToken(let t) = $0 { return (t.delta ?? "").contains("⚠️") } else { return false }
        }
        XCTAssertTrue(hint)
    }

    func testFinalizeWhenNoExplicitDone() async {
        let llm = ScriptedLLM(clarify: ["READY"], director: ["v"], roundEnd: ["w\nPOINTS:\n- a"])
        llm.emitDone = false                                 // stream ends without a .done chunk
        let (actor, _, store) = await makeActor(llm)
        await actor.convene()
        let streaming = await store.streamingCount
        XCTAssertEqual(streaming, 0)                          // finalize still ran
    }

    func testParseRoundEndOutput() {
        let a = RoomActor.parseRoundEndOutput("Nice round.\nPOINTS:\n- one\n- two\n- three\n- four")
        XCTAssertEqual(a.ping, "Nice round.")
        XCTAssertEqual(a.points, ["one", "two", "three"])   // capped at 3
        XCTAssertNil(a.modeShift)

        // Numbered bullets + missing header still parse.
        let b = RoomActor.parseRoundEndOutput("1. alpha\n2) beta")
        XCTAssertEqual(b.points, ["alpha", "beta"])

        // MODE-SHIFT proposal with a valid tone is captured + bounded.
        let c = RoomActor.parseRoundEndOutput("wrap\nPOINTS:\n- p1\nMODE-SHIFT: debate\nBECAUSE: they keep agreeing")
        XCTAssertEqual(c.points, ["p1"])
        XCTAssertEqual(c.modeShift?.to, "debate")
        XCTAssertEqual(c.modeShift?.because, "they keep agreeing")

        // Invalid tone → no proposal.
        let d = RoomActor.parseRoundEndOutput("x\nPOINTS:\n- p\nMODE-SHIFT: spicy\nBECAUSE: nope")
        XCTAssertNil(d.modeShift)
    }

    // MARK: chair-pending "working" signals (no blank stage during silent engine ops)

    /// Ordered (kind, phase) pairs of the config events on the bus.
    private func configPairs(_ events: [RoomEvent]) -> [(kind: String?, phase: String?)] {
        events.compactMap { if case .configEvent(let c) = $0 { return (c.kind, c.payload?.phase) } else { return nil } }
    }

    func testRoundEndEmitsVoteSummaryPendingBeforeRoundEnded() async {
        // The chair summarizes the round (pickRoundWrap + streamed round-end) with no
        // streamed output until the round-end message · a chair-pending("vote-summary")
        // must precede the round-ended event so the stage shows the chair working.
        let llm = ScriptedLLM(clarify: ["READY"], director: ["v"],
                              roundEnd: ["wrap\nPOINTS:\n- a"])
        let (actor, bus, _) = await makeActor(llm)
        await actor.convene()                              // opening round → round-end
        let pairs = await configPairs(bus.snapshot("r1"))
        let pendingIdx = pairs.firstIndex { $0.kind == "chair-pending" && $0.phase == "vote-summary" }
        let endedIdx = pairs.firstIndex { $0.kind == "round-ended" }
        XCTAssertNotNil(pendingIdx, "a vote-summary chair-pending should be emitted")
        XCTAssertNotNil(endedIdx)
        if let p = pendingIdx, let e = endedIdx { XCTAssertLessThan(p, e, "pending precedes round-ended") }
    }

    func testResumeEmitsCatchingUpPendingFirst() async {
        // Cold re-entry into an interrupted live room · the chair-pending("catching-up")
        // must be the FIRST event so the user sees the chair working the instant they
        // re-enter, before the (heavy) first director prompt builds.
        let llm = ScriptedLLM(clarify: ["READY"], director: ["continuing"],
                              roundEnd: ["wrap\nPOINTS:\n- a"])
        let store = await liveStore(status: .live, awaitingContinue: false)
        let bus = EventBus()
        let actor = RoomActor(roomId: "r1", bus: bus, store: store, llm: llm)
        await actor.resumeIfLive()
        let pairs = await configPairs(bus.snapshot("r1"))
        let firstPending = pairs.first { $0.kind == "chair-pending" }
        XCTAssertEqual(firstPending?.phase, "catching-up", "resume signals catching-up before any turn")
    }

    func testRoundEndedCarriesModeShift() async {
        let llm = ScriptedLLM(clarify: ["READY"], director: ["v"],
                              roundEnd: ["wrap\nPOINTS:\n- a\nMODE-SHIFT: critique\nBECAUSE: too soft"])
        let (actor, bus, _) = await makeActor(llm)
        await actor.convene()
        let events = await bus.snapshot("r1")
        let roundEnded = events.compactMap { e -> ConfigEvent? in
            if case .configEvent(let c) = e, c.kind == "round-ended" { return c }; return nil }.first
        XCTAssertEqual(roundEnded?.payload?.modeShiftProposal?.to, "critique")
        XCTAssertEqual(roundEnded?.payload?.modeShiftProposal?.because, "too soft")
    }
}
