import Foundation
import BoardroomCore
import BoardroomAI

/// The per-room orchestrator — the MVP port of `room.ts` + the clarify/round-end
/// halves of `chair.ts`. An `actor` so all turns for one room serialize (the
/// "single-threaded" guarantee `pumpQueue` relies on is free), while different
/// rooms run concurrently. Emits the SAME `RoomEvent`s the SSE path produced, so
/// the existing `RoomSession` UI is unchanged.
///
/// Re-entrancy discipline (the plan's #1 risk): every gating flag
/// (`status` / `awaitingContinue` / `awaitingClarify`) and `queue` is actor
/// state, re-read at the top of each pump iteration — never cached across an
/// `await` suspension point, so a `pause`/`adjourn`/user-message that interleaves
/// between speakers is honoured on the next iteration.
public actor RoomActor {
    public let roomId: String
    private let bus: EventBus
    private let store: RoomStore
    private let llm: EngineLLM
    private let tts: EngineTTS?
    private let router: EngineRouter?
    private let search: EngineSearch?     // web-search seam (#10) · nil = no search
    private let voiceGate = VoicePlaybackGate()
    private var deliveryVoice = false
    private var roundIsReactive = false   // reactive/continue round → run the next-speaker picker between turns

    private var status: RoomStatus = .live
    private var awaitingClarify = false
    private var awaitingContinue = false
    private var roundNum = 0
    /// A fresh actor (room re-entry / app relaunch) starts with default gating
    /// flags. `hydrateIfNeeded` loads the persisted phase from the DB on first use
    /// so resume (Continue button, mid-clarify answer, correct round number) works
    /// instead of the room appearing to start over.
    private var hydrated = false
    private var queue: [DirectorRef] = []
    private var savedQueue: [DirectorRef] = []
    private var pauseAfterCurrent = false
    private var clarifyTurns = 0
    /// Re-entrancy guard · only one pump drains the queue at a time (port of
    /// room.ts `state.processing`). Without it a mid-round user message could
    /// spawn a second concurrent pump over the same queue.
    private var processing = false
    /// A user interjected mid-round · the pump finishes the current speaker, then
    /// replans a fresh reactive round around the new message (soft interrupt).
    private var pendingUserReplan = false

    /// Per-turn LLM stream cancellation surface (P4-8b) · the in-flight audible
    /// turn's stream-consumption Task + its partial output. Two watchdogs (first-
    /// token 60s / hard-cap 120s) and a hard chairInterrupt all cancel this Task;
    /// `turnTimedOutKind` records WHY so the catch can emit the right auto-skip.
    /// Only one audible turn streams at a time (the `processing` pump guard), so a
    /// single set of properties is safe — prewarm uses its own path.
    private var inflightStreamTask: Task<Void, Error>?
    private var inflightBody = ""
    private var inflightFirstToken = false
    private var turnTimedOutKind: String?          // "first-token" | "hard-cap" | "interrupt" | nil
    /// Streaming-TTS interleave state (the live/miss path) · the token loop pushes
    /// completed sentences to `inflightSentenceCont`; a concurrent synthesis pump
    /// consumes them and emits voice-chunks with a running `inflightSeg`, so the
    /// FIRST director of a round (always a pre-warm miss) starts audio on sentence 1
    /// instead of after the whole text — desktop parity (room.ts SentenceChunker
    /// loop). The pump runs as an actor-isolated Task, so it interleaves with the
    /// token loop at await points WITHOUT racing this shared state.
    private var inflightChunker = SentenceChunker()
    private var inflightSentenceCont: AsyncStream<String>.Continuation?
    private var inflightSeg = 0
    private var inflightEmittedAudio = false
    /// Completed sentences held until the body passes the meta-silence ceiling
    /// (60 chars) · once `inflightBody.count > 60` the turn can NEVER be meta-silence
    /// (`looksLikeMetaSilence` is false past 60), so it's safe to start speaking.
    /// Below the ceiling we buffer, so a "（沉默）" turn is never read aloud.
    private var inflightPending: [String] = []
    /// Per-turn meta-silence ceiling for the synth pump · directors use 60 (a turn
    /// can still resolve to "（沉默）" below that), but the CHAIR never meta-silences
    /// (its turns are structured), so chair turns gate at 0 → the first sentence is
    /// synthesized the instant it forms, no 60-char wait. Set per turn in streamMessage.
    private var inflightSynthGate = 60
    /// Total tokens the in-flight turn's LLM stream reported (the `.usage` chunk,
    /// emitted once near stream end). Billed to the turn's author at finalize via
    /// `store.recordUsage` so the Usage panel's tables populate (port of room.ts:2290
    /// `incrementAgentTokens(speaker.id, chunk.totalTokens)`). Reset per turn.
    private var inflightUsageTokens = 0
    /// The in-flight turn's message id · lets a hard chairInterrupt identify the
    /// partial bubble to drop + end its playback gate.
    private var currentTurnMessageId: String?
    /// Set when a hard chairInterrupt aborted the current turn — the pump drops the
    /// partial bubble + the chair takes the floor instead of finalizing the turn.
    private var interruptedTurnMessageId: String?
    /// The user @mentioned the chair · the pump runs a chair direct-response turn
    /// after the current speaker is aborted/finishes, then restores the queue.
    private var pendingChairInterrupt = false

    /// Depth-1 pre-warm · the NEXT director's LLM body + TTS segments computed in
    /// the background while the CURRENT speaker's audio plays (voice rooms only).
    /// Mirrors room.ts `state.preWarmed` — consumed when the pump reaches the
    /// matching agent, cleared (task cancelled) on replan / pause / adjourn.
    private var preWarmed: PreWarm?
    private struct PreWarm { let agentId: String; let task: Task<PreWarmResult, Never> }
    private struct PreSeg: Sendable { let seg: Int; let text: String; let audioBase64: String }
    private struct PreWarmResult: Sendable { let body: String; let segs: [PreSeg]; var search: SearchHit? = nil }

    /// A completed web search · the formatted SHARED MATERIALS block (injected into
    /// the prompt) plus the query + sources surfaced to the client as a card/badge.
    struct SearchHit: Sendable, Equatable {
        let materials: String
        let query: String
        let sources: [EngineSearchSource]
    }
    /// Chair clarify search materials, run in `runClarify` and consumed by
    /// `buildPrompt(.clarify)` (so the visible tool-use card is emitted BEFORE the
    /// chair's clarify bubble). Single-use, clarify-phase only — no prewarm race.
    private var pendingChairMaterials: String?

    /// Chair web-search SHARED MATERIALS, kept DURABLE for the directors. Directors
    /// don't run their own search on native, so without this the round only SEES a
    /// "Searched 'q'" card (no result content) and complains it "can't see the
    /// results". Injected into every director prompt until a fresh chair search
    /// replaces it. (`pendingChairMaterials` above is the single-use clarify copy.)
    private var chairSearchMaterials: String?

    /// Divergence stack state (Layer 1.4 / 2.2) · the room's detected convergent
    /// terms for this round (fed to the director prompt in P4-5) and the rotating
    /// frame-breaker assignment. Recomputed each reactive pick; reset each round.
    private var pendingFrameBreakTerms: [String] = []
    private var pendingFrameBreakerRole: (agentId: String, frame: String)?
    private var lastFrameBreakerAgentId: String?
    /// The next-speaker picker's one-line rationale for the director it chose,
    /// surfaced as a private CHAIR'S BRIEF in that director's prompt (consumed once).
    private var pendingChairPick: (agentId: String, rationale: String)?

    private static let maxClarifyTurns = 3
    /// Hard ceiling for the per-turn web-search picker + search combined (#10).
    /// The search itself has a 6s URLSession timeout; the picker is a cheap haiku
    /// call. Past this we drop SHARED MATERIALS so a stalled LLM/network call can
    /// never hang the chair/director turn (the symptom: chair "stuck loading").
    private static let webSearchTimeout: Double = 12

    public init(roomId: String, bus: EventBus, store: RoomStore, llm: EngineLLM,
                tts: EngineTTS? = nil, router: EngineRouter? = nil, search: EngineSearch? = nil) {
        self.roomId = roomId; self.bus = bus; self.store = store; self.llm = llm
        self.tts = tts; self.router = router; self.search = search
    }

    /// Native `VoicePlayer` reports a clip finished → release the pump's wait.
    public func signalVoiceDone(_ messageId: String) async { await voiceGate.signalDone(messageId) }

    // Test/inspection accessors.
    public var currentStatus: RoomStatus { status }
    public var isAwaitingClarify: Bool { awaitingClarify }
    public var isAwaitingContinue: Bool { awaitingContinue }
    public var currentRound: Int { roundNum }

    /// Globally-unique message id. MUST NOT be a per-actor counter: a fresh actor
    /// (room re-entry / app relaunch) resets such a counter to 0 and re-emits
    /// m1,m2,… — which collide with the PRIOR session's persisted message ids
    /// (messages.id is the PK). The colliding INSERT is silently swallowed and the
    /// subsequent finalize/delete then UPDATEs/DELETEs the OLD message by that id,
    /// corrupting / erasing the existing transcript ("聊天记录丢失"). UUID is unique
    /// across sessions, so no collision is possible.
    private func newId() -> String { UUID().uuidString }

    // MARK: Lifecycle

    /// Open the room. The chair-clarify GATE (pickChairClarifyDecision) decides
    /// whether a clarifying question is worth the momentum cost — if the subject
    /// is already self-sufficient (or in brainstorm mode), skip straight to the
    /// directors. Default-to-ASK on any picker failure, and when no router is
    /// injected (tests) the legacy always-clarify path runs.
    /// Load the persisted room phase once (status / awaiting flags / round) so a
    /// freshly-created actor resumes where the room left off. No-op for stub stores
    /// (roomState defaults to nil) so the deterministic actor tests are unaffected.
    private func hydrateIfNeeded() async {
        guard !hydrated else { return }
        hydrated = true
        guard let s = await store.roomState(roomId) else { return }
        status = s.status
        awaitingClarify = s.awaitingClarify
        awaitingContinue = s.awaitingContinue
        roundNum = max(roundNum, s.maxRound)
    }

    public func convene() async {
        await hydrateIfNeeded()
        let meta = await store.roomMeta(roomId)
        deliveryVoice = meta?.deliveryVoice ?? false
        // Chair convening speech · introduce the seated cast in the chair's voice
        // before anything else (port of runChairConvening). Fresh room only — the
        // conveneIfNeeded gate already keeps this off re-entry.
        await runConvening(meta: meta)
        // Pre-gate chair web-search · run BEFORE the clarify-skip decision so a
        // self-sufficient question (gate says "don't ask") still gets grounded —
        // otherwise search would only ever fire inside runClarify, which the gate
        // skips for most clear initial questions (desktop chair.ts:1002 hoists it
        // for exactly this reason). Deduped, so the runClarify() call below is a
        // no-op on the non-skip path.
        await maybeRunChairSearch()
        if let router {
            let history = await store.recentMessages(roomId, limit: 30)
            let decision = await SpeakerPicker.pickChairClarifyDecision(
                router: router, history: history, mode: meta?.mode)
            if !decision.shouldAsk {
                await bus.emit(roomId, .configEvent(ConfigEvent(kind: "auto-skipped", payload: nil)))
                await releaseDirectors()
                return
            }
        }
        await runClarify()
    }

    /// User sends a message. During clarify it routes to the chair; otherwise it
    /// opens the next reactive round.
    public func submitUserMessage(_ text: String) async {
        await hydrateIfNeeded()
        let rn = awaitingClarify ? max(roundNum, 1) : await store.nextRoundNum(roomId)
        let uid = newId()
        await store.insertMessage(EngineMessage(id: uid, roomId: roomId, authorKind: "user",
                                                authorId: nil, body: text, roundNum: rn, streaming: false))
        await bus.emit(roomId, .messageAppended(MessageAppended(
            messageId: uid, body: text, authorId: nil, authorKind: "user", roundNum: rn, meta: nil)))
        if awaitingClarify { await runClarify(); return }
        // Hard chair interrupt (P4-8b · port of room.ts chairInterrupt) · the user
        // @mentioned the chair to ask a meta question. Takes priority over the soft
        // replan: abort the in-flight director, run the chair's direct response,
        // restore the queue. Only when the room is live + has a chair.
        if status == .live, await isChairMention(text) {
            if processing {
                await beginChairInterrupt()   // pump runs chair-direct + restores
            } else {
                await runChairDirect()        // no active turn · answer directly
            }
            return
        }
        // Mid-round interjection · a pump is draining the queue. Don't start a
        // second pump (double-pump bug); flag a replan the running pump honours
        // AFTER the current speaker, then re-rounds around this message.
        if processing {
            pendingUserReplan = true
            invalidatePrewarm()
            return
        }
        if awaitingContinue { await setAwaitingContinue(false) }
        await tick(kind: .reactive)
    }

    /// Advance after a round-end (Continue button).
    public func continueRound() async {
        await hydrateIfNeeded()
        guard awaitingContinue, status == .live else { return }
        await setAwaitingContinue(false)
        await tick(kind: .resume)
    }

    /// Re-entry into a LIVE room that was interrupted mid-round (the user left or
    /// the app relaunched before the round finished) · continue the discussion with
    /// a fresh reactive round so the room doesn't sit silent ("没有进入发言流程"). A
    /// reactive round builds on the existing transcript — it CONTINUES, not restarts
    /// (re-convening is what felt like a restart, and is gated out separately).
    /// No-op when paused / adjourned, when waiting on the user (Continue / clarify),
    /// or when a pump is already draining the queue (same-session re-entry).
    public func resumeIfLive() async {
        await hydrateIfNeeded()
        guard status == .live, !awaitingContinue, !awaitingClarify, !processing else { return }
        await tick(kind: .reactive)
    }

    public func adjourn() async {
        invalidatePrewarm()
        status = .adjourned
        await store.setStatus(roomId, .adjourned)
        await bus.emit(roomId, .configEvent(ConfigEvent(kind: "room-adjourned", payload: nil)))
        // Fire-and-forget · each agent extracts durable notes about the user from
        // this room (port of extractMemoriesAfterAdjourn) for future rooms.
        if let router, let mem = memStore {
            let store = self.store
            let roomId = self.roomId
            Task { await Memory.extractAfterAdjourn(router: router, store: store, mem: mem, roomId: roomId) }
        }
    }

    /// Pause · soft (after the current speaker) when the director pump is running,
    /// immediate otherwise. The pump's soft-pause block (which snapshots the queue
    /// + persists `.paused`) only runs INSIDE `pumpQueue`; during clarify /
    /// convening / awaiting / between-rounds — or if a turn stalls — it never fires.
    /// So when we're not actively pumping, persist `.paused` here directly,
    /// otherwise the DB stays `live` and re-entry shows the room un-paused.
    public func pause() async {
        await hydrateIfNeeded()
        guard status == .live else { return }
        if processing {
            pauseAfterCurrent = true   // mid director turn · honoured after this speaker
        } else {
            status = .paused
            await store.setStatus(roomId, .paused)
            await bus.emit(roomId, .configEvent(ConfigEvent(kind: "room-paused", payload: nil)))
        }
    }

    public func resume() async {
        await hydrateIfNeeded()
        guard status == .paused else { return }
        status = .live
        await store.setStatus(roomId, .live)
        await bus.emit(roomId, .configEvent(ConfigEvent(kind: "room-resumed", payload: nil)))
        if savedQueue.isEmpty {
            // Re-entry dropped the in-memory savedQueue (it isn't persisted). Don't
            // pump an empty queue — that would immediately round-end the room. Start
            // a fresh reactive round so the discussion CONTINUES with the prior
            // transcript as context, instead of abruptly wrapping with no speakers.
            await tick(kind: .reactive)
        } else {
            queue = savedQueue
            savedQueue = []
            await pumpQueue()
        }
    }

    // MARK: Clarify (chair opening Q&A)

    private func runClarify() async {
        clarifyTurns += 1
        if clarifyTurns > Self.maxClarifyTurns { await releaseDirectors(); return }
        guard let chair = await store.chair(roomId) else { await releaseDirectors(); return }

        // Chair web-search · runs + surfaces a visible tool-use card before the
        // clarify bubble, stashing materials for buildPrompt(.clarify). Deduped, so
        // calling it again here after the `convene()` pre-gate run is a no-op within
        // the same user turn. (Re-fires on a fresh follow-up clarify message.)
        await maybeRunChairSearch()

        let body = await streamMessage(author: chair, kind: "clarify", purpose: .clarify).body
        // Bare READY/SKIP or an ack ending in READY → directors are released.
        if body.localizedCaseInsensitiveContains("READY") || body.localizedCaseInsensitiveContains("SKIP") {
            await releaseDirectors()
        } else {
            await setAwaitingClarify(true)
            await bus.emit(roomId, .configEvent(ConfigEvent(kind: "clarify-ready", payload: nil)))
        }
    }

    private func releaseDirectors() async {
        await setAwaitingClarify(false)
        await tick(kind: .opening)
    }

    /// Chair web-search (#10) · the Swift port of desktop `runChairWebSearchTool`.
    /// Gate is the SEARCH KEY ALONE — NOT the chair's per-agent `webSearchEnabled`
    /// (matching chair.ts: "disabling search for the chair would make every
    /// time-sensitive question fail silently"). The per-agent flag only ever kept
    /// specific DIRECTORS out of search, and directors don't search on native.
    ///
    /// Runs the cheap picker → search → emits the visible tool-use card → stashes
    /// SHARED MATERIALS for `buildPrompt(.clarify)`. Deduped: if a web-search
    /// tool-use already ran after the latest user message, it's a no-op (so the
    /// `convene()` pre-gate call + the `runClarify()` call don't double-search).
    private func maybeRunChairSearch() async {
        guard let search, search.hasKey, let router else {
            NSLog("🔎SEARCH chair skip · hasSearch=\(search != nil) hasKey=\(search?.hasKey ?? false) hasRouter=\(router != nil)")
            return
        }
        let hist = await store.recentMessages(roomId, limit: 30)
        if Self.chairSearchedSinceLastUser(hist) { return }   // already ran this user turn
        let subject = (await store.roomMeta(roomId))?.subject ?? ""   // opening query lives here, not in messages
        let hit = await Self.boundedSearch(Self.webSearchTimeout) { () -> SearchHit? in
            guard let q = await WebSearchPicker.pickChairQuery(router: router, history: hist, subject: subject) else {
                NSLog("🔎SEARCH chair · picker returned no query (not time-sensitive)"); return nil
            }
            guard let out = await search.run(q) else {
                NSLog("🔎SEARCH chair · query=\"\(q)\" but run() returned nil (no results / key fail)"); return nil
            }
            NSLog("🔎SEARCH chair · query=\"\(q)\" sources=\(out.sources.count)")
            return SearchHit(materials: out.materials, query: q, sources: out.sources)
        }
        if let hit {
            pendingChairMaterials = hit.materials   // single-use · chair clarify prompt
            chairSearchMaterials = hit.materials     // durable · every director prompt this question
            await emitChairSearchCard(query: hit.query, sources: hit.sources)
        }
    }

    /// Dedup helper · true if a `tool-use` (web-search) row already landed after the
    /// latest user message — mirrors chair.ts's per-user-turn search dedup.
    private static func chairSearchedSinceLastUser(_ hist: [EngineMessage]) -> Bool {
        if let lastUser = hist.lastIndex(where: { $0.authorKind == "user" && !$0.body.isEmpty }) {
            return hist[(lastUser + 1)...].contains { $0.kind == "tool-use" }
        }
        // No user message yet (opening pass · query lives in rooms.subject) · dedup
        // against ANY recent tool-use so convene()'s pre-gate run and the runClarify()
        // run don't both fire on the same opening.
        return hist.contains { $0.kind == "tool-use" }
    }

    // MARK: Round / pump

    private func tick(kind: RoundKind) async {
        guard status == .live else { return }
        invalidatePrewarm()   // a fresh round replans the queue · drop any stale pre-warm
        pendingFrameBreakTerms = []
        pendingFrameBreakerRole = nil
        deliveryVoice = (await store.roomMeta(roomId))?.deliveryVoice ?? false
        // Opening round = directors react to the user's question in queue order
        // (parallel · no prior turn to react to). Every other round is reactive →
        // run the next-speaker picker between turns.
        roundIsReactive = (kind != .opening)
        roundNum = await store.nextRoundNum(roomId)
        queue = await store.directors(roomId)
        await emitQueue()
        await pumpQueue()
    }

    private func pumpQueue() async {
        if processing { return }   // a pump already owns the queue (re-entrancy guard)
        processing = true
        defer { processing = false }
        var spokeThisRound = 0
        while true {
            // Re-read gating flags + queue fresh each iteration (post-await safe).
            if status != .live { invalidatePrewarm(); return }
            if awaitingContinue || awaitingClarify { invalidatePrewarm(); return }
            guard !queue.isEmpty else { break }
            // Pre-warm hit · schedulePrewarm already picked + reordered + started
            // this director's LLM+TTS in the background. Skip the inline picker.
            let hit = preWarmed != nil && preWarmed!.agentId == queue.first?.id
            // Inline next-speaker discipline (MISS path only) · reorder + chair
            // intervention. Skipped on the opening round, the first reactive
            // speaker, single-candidate queues, and pre-warm hits.
            if !hit, roundIsReactive, spokeThisRound >= 1, queue.count >= 2, router != nil {
                await runNextSpeakerDiscipline()
                if status != .live || awaitingContinue || awaitingClarify { invalidatePrewarm(); return }
            }
            let speaker = queue.removeFirst()
            await emitQueue()
            let mid: String
            let emittedAudio: Bool
            let turnBody: String
            // The pre-warm for the NEXT speaker after THIS one — scheduled the moment
            // THIS turn's text is ready (fresh path) or right after it's emitted
            // (cached path), so the next LLM+TTS overlap THIS turn's TTS + playback.
            let spokeAfterThis = spokeThisRound + 1
            let kickPrewarm: () -> Void = { [weak self] in
                Task { await self?.kickPrewarmIfNeeded(spokeThisRound: spokeAfterThis) }
            }
            if hit, let pw = preWarmed, pw.agentId == speaker.id {
                // Consume the pre-warmed turn · its LLM+TTS already ran during the
                // prior speaker's playback, so this emits instantly (zero gap).
                preWarmed = nil
                let r = await pw.task.value
                (mid, emittedAudio) = await emitCachedTurn(author: speaker, body: r.body, segs: r.segs, search: r.search)
                turnBody = r.body
                kickPrewarm()   // cached turn emitted instantly → start the next one now
            } else {
                invalidatePrewarm()   // stale pre-warm for a different agent → discard
                // onTextFinal fires kickPrewarm the moment A's TEXT is done — B then
                // runs through A's whole TTS synthesis + playback (desktop parity).
                let res = await streamMessage(author: speaker, kind: nil, purpose: .director,
                                              gatePlayback: false, onTextFinal: kickPrewarm)
                mid = res.id; emittedAudio = res.emittedAudio; turnBody = res.body
            }
            currentTurnMessageId = mid   // so a chairInterrupt during playback ends THIS gate
            // A hard chairInterrupt may have aborted this turn mid-stream — handle it
            // before the gate (the partial bubble was finalized as an interrupt no-op).
            if pendingChairInterrupt && interruptedTurnMessageId == mid {
                pendingChairInterrupt = false
                invalidatePrewarm()
                await store.deleteMessage(mid)
                await bus.emit(roomId, .messageRemoved(messageId: mid, reason: "chair-interrupt"))
                interruptedTurnMessageId = nil
                queue.insert(speaker, at: 0)
                await emitQueue()
                await runChairDirect()
                continue
            }
            spokeThisRound += 1
            // Fire-and-forget · topic-branch tag (Layer 3.1) + QD score.
            scheduleEnrichment(messageId: mid, speakerId: speaker.id, body: turnBody)
            // (The next speaker's pre-warm was already kicked above — at A's text-done
            // for the fresh path, or right after the cached emit — so it overlaps THIS
            // turn's TTS synthesis + playback, not just the leftover playback.)
            // Gate on THIS turn's playback · the pre-warm Task runs concurrently
            // during the wait (actor reentrancy: it only reads, never mutates
            // gating state, so it's safe to interleave with this suspension).
            if emittedAudio { await voiceGate.wait(for: mid, timeout: 90) }
            // Soft pause is honoured here — AFTER the current speaker. Snapshot the
            // rest so resume() continues the same round instead of replanning.
            if pauseAfterCurrent {
                pauseAfterCurrent = false
                invalidatePrewarm()
                savedQueue = queue
                queue = []
                status = .paused
                await store.setStatus(roomId, .paused)
                await bus.emit(roomId, .configEvent(ConfigEvent(kind: "room-paused", payload: nil)))
                return
            }
            // Hard chair interrupt during PLAYBACK (P4-8b) · the @chair mention
            // landed after this turn finished streaming (the mid-stream case is
            // handled above, before the gate). The turn's bubble is intact; the
            // chair just takes the floor with a direct meta response, then the
            // round continues with the remaining queue.
            if pendingChairInterrupt {
                pendingChairInterrupt = false
                invalidatePrewarm()
                interruptedTurnMessageId = nil
                await runChairDirect()
                continue
            }
            // Mid-round interjection · the user sent a message while this speaker
            // was talking. Replan a fresh reactive round around it IN-LINE (no
            // nested pump · the guard would no-op it anyway) so directors react to
            // the new message instead of finishing the stale queue.
            if pendingUserReplan {
                pendingUserReplan = false
                invalidatePrewarm()
                pendingFrameBreakTerms = []
                pendingFrameBreakerRole = nil
                roundIsReactive = true
                roundNum = await store.nextRoundNum(roomId)
                queue = await store.directors(roomId)
                spokeThisRound = 0
                await emitQueue()
                continue
            }
        }
        // Queue drained → chair wraps the round + posts the vote.
        if status == .live { await runRoundEnd() }
    }

    /// Pick the next reactive speaker and reorder the queue to put them at the
    /// head. Shared by the inline discipline (miss path) and schedulePrewarm.
    /// Returns the pick so the caller decides whether to announce an intervention.
    @discardableResult
    private func pickAndReorder(emitPending: Bool) async -> SpeakerPicker.NextSpeakerPick {
        let none = SpeakerPicker.NextSpeakerPick(agentId: nil, rationale: "", intervention: nil)
        guard let router, queue.count >= 2 else { return none }
        let recent = await store.recentMessages(roomId, limit: 30)
        let subject = (await store.roomMeta(roomId))?.subject
        // Divergence stack (Layer 1.4 → 3.1 → 2.1) · detect the room's recurring
        // fixation (text extractor) AND merge in the dominant topic-branch labels;
        // if anything converges, flip the picker into dissent-gap mode and stash
        // the terms for the director prompt (P4-5).
        var convergentTerms = await FrameBreak.extractDominantTerms(router: router, messages: recent)
        let branches = await fbStore?.dominantBranches(roomId, limit: 3) ?? []
        if !branches.isEmpty {
            var seen = Set(convergentTerms.map { $0.lowercased() })
            for b in branches where b.turnCount >= 2 && !seen.contains(b.label.lowercased()) {
                convergentTerms.append(b.label); seen.insert(b.label.lowercased())
            }
        }
        let useDissent = !convergentTerms.isEmpty
        if useDissent { pendingFrameBreakTerms = convergentTerms }
        // Layer 3.1 → 2.1 · front-load "underexposed" directors (not yet tagged on
        // the dominant branches) so the picker's recency bias works FOR divergence.
        var pickerCandidates = queue
        if useDissent, let fb = fbStore, !branches.isEmpty {
            let exposed = await fb.speakersOnBranches(roomId, branchIds: branches.map(\.id))
            let under = queue.filter { !exposed.contains($0.id) }
            let over = queue.filter { exposed.contains($0.id) }
            if !under.isEmpty && !over.isEmpty { pickerCandidates = under + over }
        }
        if emitPending { await bus.emit(roomId, .configEvent(ConfigEvent(kind: "chair-pending", payload: nil))) }
        // Bound the picker · a hung utility call falls back to round-robin (the
        // picker is ~2-3s typical) instead of stalling the room. Auto-skip tells
        // the client a fallback happened (port of emitAutoSkipped "picker").
        let mode: SpeakerPicker.NextSpeakerMode = useDissent ? .dissentGap : .lensGap
        let terms = useDissent ? convergentTerms : []
        let candidatesForPick = pickerCandidates   // immutable copy for the @Sendable closure
        let timed = await withTimeout(seconds: 15) { [router] in
            await SpeakerPicker.pickNextSpeaker(
                router: router, candidates: candidatesForPick, history: recent, roomSubject: subject,
                mode: mode, convergentTerms: terms)
        }
        let pick: SpeakerPicker.NextSpeakerPick
        if let p = timed {
            pick = p
        } else {
            pick = none
            await bus.emit(roomId, .configEvent(ConfigEvent(kind: "auto-skipped", payload: nil)))
        }
        if let pid = pick.agentId, pid != queue.first?.id,
           let idx = queue.firstIndex(where: { $0.id == pid }), idx > 0 {
            let picked = queue.remove(at: idx)
            queue.insert(picked, at: 0)
            await emitQueue()
            // Stash the chair's rationale so the director's prompt carries it as a
            // private CHAIR'S BRIEF (consumed once in directorPrompt).
            let r = pick.rationale.trimmingCharacters(in: .whitespacesAndNewlines)
            if !r.isEmpty { pendingChairPick = (agentId: pid, rationale: r) }
        }
        // Frame-breaker rotation (Layer 2.2) · designate ONE director per
        // converging round to do the structural frame-break, preferring NOT the
        // most-recent breaker. Consumed by the director prompt in P4-5.
        if useDissent, let frame = convergentTerms.first {
            let chosenId = pick.agentId ?? queue.first?.id
            var breakerId: String? = nil
            if let chosenId, chosenId != lastFrameBreakerAgentId {
                breakerId = chosenId
            } else if let alt = queue.first(where: { $0.id != lastFrameBreakerAgentId && $0.id != chosenId }) {
                breakerId = alt.id
            }
            if let breakerId { pendingFrameBreakerRole = (agentId: breakerId, frame: String(frame.prefix(60))) }
        }
        return pick
    }

    /// Inline next-speaker discipline (MISS path) · reorder + a chair intervention
    /// when the picker flags a misalignment (port of the pumpQueue next-speaker
    /// block). lens-gap mode for now; dissent-gap + frame-break terms arrive in P4-4.
    private func runNextSpeakerDiscipline() async {
        let pick = await pickAndReorder(emitPending: true)
        if let note = pick.intervention {
            await postFinalChairNote(note, kind: "intervention", rationale: pick.rationale)
        }
    }

    /// Start the next director's pre-warm: pick (reactive) so we warm the RIGHT
    /// one, then compute its LLM body + TTS segments in a background Task that
    /// interleaves with the current turn's playback gate. The prewarm picker is
    /// lightweight — it reorders but does NOT announce interventions (those stay
    /// on the inline miss path, matching desktop runPickerThenPrewarm).
    /// Gate + run the next speaker's pre-warm (the fresh/cached `onTextFinal` hook).
    /// Actor-isolated so the fire-and-forget closure can read the gating flags.
    private func kickPrewarmIfNeeded(spokeThisRound: Int) async {
        guard deliveryVoice, status == .live, !awaitingContinue, !awaitingClarify, !queue.isEmpty else { return }
        await schedulePrewarm(spokeThisRound: spokeThisRound)
    }

    private func schedulePrewarm(spokeThisRound: Int) async {
        invalidatePrewarm()
        if roundIsReactive, spokeThisRound >= 1, queue.count >= 2, router != nil {
            _ = await pickAndReorder(emitPending: false)
        }
        guard status == .live, let speaker = queue.first else { return }
        preWarmed = PreWarm(agentId: speaker.id, task: Task { [weak self] in
            await self?.computePrewarm(speaker) ?? PreWarmResult(body: "", segs: [])
        })
    }

    private func invalidatePrewarm() {
        preWarmed?.task.cancel()
        preWarmed = nil
    }

    /// The Layer-2 persistence seam, when the store supports it (GRDB does; test
    /// stubs don't → enrichment cleanly no-ops).
    private var fbStore: FrameBreakStore? { store as? FrameBreakStore }
    /// The L1/L2 summary seam (GRDB conforms; test stubs don't).
    private var summaryStore: SummaryStore? { store as? SummaryStore }
    /// The per-agent long-term memory seam (GRDB conforms; test stubs don't).
    private var memStore: MemoryStore? { store as? MemoryStore }
    /// The chair-only user_long_memory sanctuary seam (GRDB conforms; stubs don't).
    private var userLongStore: UserLongMemoryStore? { store as? UserLongMemoryStore }

    /// Director context history (port of `buildDirectorContext`) · L0 (last
    /// `L0_KEEP` rounds, raw) + ANCHORS (every user message from older rounds, so
    /// the user's pivots are never summarized away), in chronological order.
    private func buildDirectorHistory() async -> [EngineMessage] {
        // Wide window (was 300) so very old anchors in long rooms survive the fetch;
        // the token cap below does the real trimming. Desktop reads ALL messages.
        let all = await store.recentMessages(roomId, limit: 1000)
        guard !all.isEmpty else { return [] }
        let l0Cutoff = max(1, roundNum - Summarize.l0Keep + 1)
        // ANCHORS (kept regardless of age · context.ts): every user message (the
        // user's pivots) AND the chair's convening cast-introduction. Plus L0 = the
        // last l0Keep rounds raw. `all` is chronological (oldest first).
        func isAnchor(_ m: EngineMessage) -> Bool {
            m.roundNum < l0Cutoff && (m.authorKind == "user" || m.kind == "convening")
        }
        var kept = all.filter { $0.roundNum >= l0Cutoff || isAnchor($0) }
        // HISTORY_TOKEN_CAP (≈ chars/4) · trim the OLDEST NON-ANCHOR messages until
        // under cap (port of context.ts's aggressive trim). Anchors never dropped.
        func estTokens(_ ms: [EngineMessage]) -> Int { ms.reduce(0) { $0 + $1.body.count } / 4 }
        if estTokens(kept) > Summarize.historyTokenCap {
            var i = 0
            while estTokens(kept) > Summarize.historyTokenCap, i < kept.count {
                if isAnchor(kept[i]) { i += 1; continue }
                kept.remove(at: i)
            }
        }
        return kept
    }

    /// L1/L2 narrative preamble (port of `buildSummaryPreamble`) · the ROOM SUBJECT
    /// anchor (re-stated here for recency, exactly like context.ts — desktop puts
    /// it in BOTH ROOM CONTEXT and the preamble) + consolidated older rounds,
    /// injected as its own system block so the director remembers the room's
    /// still-open angles + the original question. "" only when subject is empty.
    private func buildSummaryPreamble(subject: String) async -> String {
        var sections: [String] = []
        let s = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty {
            sections.append("// ROOM SUBJECT (anchor · the original question)\n\(s)")
        }
        if let summary = summaryStore {
            let l0Cutoff = max(1, roundNum - Summarize.l0Keep + 1)
            if let l2 = await summary.getL2Summary(roomId: roomId), !l2.body.isEmpty {
                sections.append("// EARLIER IN THIS ROOM · rounds \(l2.startRound)-\(l2.endRound) (consolidated)\n\(l2.body)")
            }
            let l1s = await summary.listL1Summaries(roomId: roomId).filter { $0.roundNum < l0Cutoff }
            if !l1s.isEmpty {
                let lines = l1s.map { "· round \($0.roundNum): \($0.body)" }.joined(separator: "\n")
                sections.append("// RECENT ROUNDS · per-round summaries\n\(lines)")
            }
        }
        guard !sections.isEmpty else { return "" }
        return "\n═══ context · earlier in this room ═══\n" + sections.joined(separator: "\n\n") + "\n═══ end context · live transcript follows ═══\n"
    }

    /// Fire-and-forget per-turn enrichment · topic-branch tag (Layer 3.1) + QD
    /// score (coverage archive). Never blocks the pump; failures are swallowed.
    private func scheduleEnrichment(messageId: String, speakerId: String, body: String) {
        guard let router, let fb = fbStore else { return }
        let store = self.store
        let roomId = self.roomId
        Task {
            let subject = (await store.roomMeta(roomId))?.subject ?? ""
            await TopicTagger.tagMessageBranch(router: router, store: fb, roomId: roomId,
                                               messageId: messageId, speakerId: speakerId,
                                               body: body, roomSubject: subject)
        }
        Task {
            await QDScorer.scoreAndArchive(router: router, store: fb, roomId: roomId,
                                           messageId: messageId, body: body)
        }
    }

    /// Compute (no bus emits) the next director's full body + TTS segments. Runs
    /// on the actor but only between awaits, so it interleaves with the current
    /// turn's `voiceGate.wait`. Honours cancellation (invalidatePrewarm).
    private func computePrewarm(_ speaker: DirectorRef) async -> PreWarmResult {
        let (body, search) = await runDirectorLLM(speaker)
        if Task.isCancelled { return PreWarmResult(body: body, segs: [], search: search) }
        var segs: [PreSeg] = []
        if deliveryVoice, let tts, !body.isEmpty {
            for await s in tts.synthesizeStream(body, agentId: speaker.id) {
                if Task.isCancelled { break }
                segs.append(PreSeg(seg: s.seg, text: s.text, audioBase64: s.audioBase64))
            }
        }
        return PreWarmResult(body: body, segs: segs, search: search)
    }

    /// Run a director's LLM turn into a string with NO bus emits (used only by the
    /// pre-warm path). Mirrors streamMessage's LLM loop + errorHint-on-throw.
    private func runDirectorLLM(_ speaker: DirectorRef) async -> (body: String, search: SearchHit?) {
        var body = ""
        var hit: SearchHit? = nil
        do {
            let history = await store.recentMessages(roomId, limit: 30)
            let (messages, search) = await buildPrompt(author: speaker, purpose: .director, history: history)
            hit = search
            for try await chunk in llm.stream(messages, modelV: speaker.modelV, maxTokens: 4000, purpose: .director) {
                if Task.isCancelled { break }
                if case .textDelta(let d) = chunk { body += d }
            }
        } catch {
            if body.isEmpty { body = Self.errorHint(error) }
        }
        return (body, hit)
    }

    /// Emit a pre-warmed turn from cache · placeholder → body (one token) → final
    /// → cached voice-chunks → voice-final. NO gate (the pump gates afterward).
    /// The bubble appears complete (not char-streamed) for pre-warmed turns — in a
    /// voice room the caption is audio-driven, so this is invisible to the user.
    private func emitCachedTurn(author: DirectorRef, body: String, segs: [PreSeg], search: SearchHit? = nil) async -> (id: String, emittedAudio: Bool) {
        let mid = newId()
        // Meta-silence / empty pre-warmed turn · don't emit a bubble or audio at all;
        // the pump advances (same drop the fresh path does). Avoids the cached "（沉默）"
        // turn being shown + read aloud.
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || Self.looksLikeMetaSilence(trimmed) { return (mid, false) }
        await store.insertMessage(EngineMessage(id: mid, roomId: roomId, authorKind: "agent",
                                                authorId: author.id, body: "", roundNum: roundNum,
                                                streaming: true, kind: nil))
        await bus.emit(roomId, .messageAppended(MessageAppended(
            messageId: mid, body: "", authorId: author.id, authorKind: "agent", roundNum: roundNum, meta: nil)))
        // Text-room thinking beat · a pre-warmed turn's text is already in hand, so
        // without this the empty "thinking" row (director avatar + TypingDots) is
        // overwritten by the body in the same event burst and the loading state never
        // renders. Hold briefly so the director visibly "thinks" before speaking —
        // matching the fresh-stream path's natural LLM latency + the desktop text room.
        // Voice rooms drive the thinking pose via the stage during the prior turn's
        // audio playback, so they need no artificial gap here.
        if !deliveryVoice { try? await Task.sleep(nanoseconds: 700_000_000) }
        if !body.isEmpty {
            await bus.emit(roomId, .messageToken(MessageToken(messageId: mid, delta: body)))
        }
        await store.finalizeMessage(mid, body: body)
        await emitDirectorSearchFinal(mid: mid, search: search)
        var emittedAudio = false
        if deliveryVoice {
            for s in segs {
                await bus.emit(roomId, .voiceChunk(VoiceChunk(
                    messageId: mid, audioBase64: s.audioBase64, mimeType: "audio/mpeg",
                    seq: s.seg, seg: s.seg, text: s.text)))
                emittedAudio = true
            }
            await bus.emit(roomId, .voiceFinal(VoiceFinal(messageId: mid)))
        }
        return (mid, emittedAudio)
    }

    /// Emit a director turn's message-final, carrying any web-search sources (live
    /// "🔍 N sources" badge) and persisting them to the message meta (so reload
    /// re-renders without re-searching). A plain message-final when no sources.
    private func emitDirectorSearchFinal(mid: String, search: SearchHit?) async {
        if let s = search, !s.sources.isEmpty {
            await store.setMessageSearch(mid, query: s.query, sources: s.sources)
            await bus.emit(roomId, .messageFinal(MessageFinal(messageId: mid,
                searchQuery: s.query, sources: Self.mapSources(s.sources))))
        } else {
            await bus.emit(roomId, .messageFinal(MessageFinal(messageId: mid)))
        }
    }

    /// Engine sources → the Core payload shape carried on events.
    static func mapSources(_ s: [EngineSearchSource]) -> [SearchSource] {
        s.map { SearchSource(title: $0.title, url: $0.url, description: $0.description) }
    }

    /// Emit the chair's web-search as a visible tool-use CARD message (the desktop
    /// "// web-search · Searched 'q'" row) BEFORE the chair's clarify bubble, and
    /// persist it. Silent (no TTS). Sources known up front → meta set at insert.
    private func emitChairSearchCard(query: String, sources: [EngineSearchSource]) async {
        guard let chair = await store.chair(roomId), !sources.isEmpty else { return }
        let mid = newId()
        let body = "Searched \"\(query)\""
        await store.insertMessage(EngineMessage(id: mid, roomId: roomId, authorKind: "agent",
                                                authorId: chair.id, body: body, roundNum: roundNum,
                                                streaming: false, kind: "tool-use",
                                                tool: "web-search", toolStatus: "done",
                                                searchQuery: query, sources: sources))
        await bus.emit(roomId, .messageAppended(MessageAppended(
            messageId: mid, body: body, authorId: chair.id, authorKind: "agent", roundNum: roundNum,
            meta: MessageAppended.Meta(kind: "tool-use", tool: "web-search", toolStatus: "done",
                                       searchQuery: query, sources: Self.mapSources(sources)))))
        await bus.emit(roomId, .messageFinal(MessageFinal(messageId: mid)))
    }

    /// Post a complete (non-streamed) chair note — interventions, hints — with
    /// the same voice tail as a director turn (chunks → final → voice-final, gated
    /// on playback in voice mode). Port of `announceIntervention`.
    private func postFinalChairNote(_ body: String, kind: String, rationale: String = "") async {
        guard let chair = await store.chair(roomId) else { return }
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let mid = newId()
        // Emit an EMPTY append first (then a text-room thinking beat, then the body)
        // so the chair visibly "thinks" before this note lands — same shape as a
        // streamed turn / the pre-warmed director path. A single non-empty append
        // would pop the note in with no thinking placeholder.
        await store.insertMessage(EngineMessage(id: mid, roomId: roomId, authorKind: "agent",
                                                authorId: chair.id, body: "", roundNum: roundNum,
                                                streaming: true, kind: kind))
        await bus.emit(roomId, .messageAppended(MessageAppended(
            messageId: mid, body: "", authorId: chair.id, authorKind: "agent",
            roundNum: roundNum, meta: MessageAppended.Meta(kind: kind))))
        if !deliveryVoice { try? await Task.sleep(nanoseconds: 700_000_000) }
        await bus.emit(roomId, .messageToken(MessageToken(messageId: mid, delta: text)))
        await store.finalizeMessage(mid, body: text)
        await bus.emit(roomId, .messageFinal(MessageFinal(messageId: mid)))
        var emittedAudio = false
        if deliveryVoice, let tts {
            for await seg in tts.synthesizeStream(text, agentId: chair.id) {
                await bus.emit(roomId, .voiceChunk(VoiceChunk(
                    messageId: mid, audioBase64: seg.audioBase64, mimeType: "audio/mpeg",
                    seq: seg.seg, seg: seg.seg, text: seg.text)))
                emittedAudio = true
            }
        }
        if deliveryVoice {
            await bus.emit(roomId, .voiceFinal(VoiceFinal(messageId: mid)))
            if emittedAudio { await voiceGate.wait(for: mid, timeout: 90) }
        }
    }

    private func emitQueue() async {
        // The ordered directors still to speak THIS round (the head of `queue` is up
        // next). Sent to the client so the voice room's queue sheet can show the
        // speaking order; the current speaker is already removed from `queue`, so the
        // client pairs this with the on-stage speaker for the full picture.
        let entries = queue.map { QueueUpdate.Entry(agentId: $0.id, status: "up") }
        await bus.emit(roomId, .configEvent(ConfigEvent(kind: "queue-update",
            payload: ConfigEvent.Payload(agentId: nil, changes: nil, queue: entries))))
    }

    // MARK: Round-end (chair wrap + key points)

    // MARK: Hard chair interrupt (P4-8b · port of room.ts chairInterrupt)

    /// True when the user's message summons the chair directly · literal `@chair`
    /// or the chair's own `@handle`. Skipped for rooms with no chair.
    private func isChairMention(_ text: String) async -> Bool {
        guard let chair = await store.chair(roomId) else { return false }
        let lower = text.lowercased()
        if lower.range(of: "(^|\\s)@chair\\b", options: .regularExpression) != nil { return true }
        let h = chair.handle.lowercased()
        if !h.isEmpty {
            let needle = h.hasPrefix("@") ? h : "@\(h)"
            if lower.contains(needle) { return true }
        }
        return false
    }

    /// Abort the in-flight audible turn so the pump hands the floor to the chair.
    /// Sets `pendingChairInterrupt`; the pump runs `runChairDirect` + re-queues the
    /// interrupted speaker. If the turn already finished streaming (in playback),
    /// end its gate so the pump advances promptly.
    private func beginChairInterrupt() async {
        pendingChairInterrupt = true
        invalidatePrewarm()
        if let t = inflightStreamTask, !t.isCancelled {
            turnTimedOutKind = "interrupt"
            interruptedTurnMessageId = currentTurnMessageId
            t.cancel()
        } else if let mid = currentTurnMessageId {
            await voiceGate.signalDone(mid)
        }
    }

    /// Stream the chair's direct meta-response (`buildChairDirectMessages`) as a
    /// one-off `chair-direct` turn. Reuses `streamMessage` (watchdogs + voice gate)
    /// with a prebuilt prompt so it bypasses the purpose→prompt switch.
    private func runChairDirect() async {
        guard let meta = await store.roomMeta(roomId), let chair = await store.chair(roomId) else { return }
        let cast = await store.directors(roomId)
        let history = await store.recentMessages(roomId, limit: 30)
        let ctx = await chairContext(meta: meta, chair: chair, cast: cast, history: history)
        let msgs = ChairPromptBuilder.direct(ctx)
        _ = await streamMessage(author: chair, kind: "chair-direct", purpose: .roundEnd, prebuiltMessages: msgs)
    }

    /// The chair's convening speech · introduces the seated cast before clarify
    /// (port of runChairConvening). Skipped when there's no router / meta / cast,
    /// or when this room already opened (a prior agent message exists) so re-runs
    /// never double-introduce. The per-director "picker note" is omitted (the
    /// native picker doesn't surface a reason); the bio carries the angle.
    private func runConvening(meta: RoomMeta?) async {
        guard router != nil, let meta, let chair = await store.chair(roomId) else { return }
        let cast = await store.directors(roomId)
        guard !cast.isEmpty else { return }
        // Don't re-introduce a room that already has discussion.
        let existing = await store.recentMessages(roomId, limit: 1)
        guard !existing.contains(where: { $0.authorKind == "agent" }) else { return }
        let ctx = await chairContext(meta: meta, chair: chair, cast: cast, history: [])
        let picks = cast.map { ChairPromptBuilder.ConveningPick(name: $0.name, handle: $0.handle, roleTag: $0.roleTag, bio: $0.bio) }
        let msgs = ChairPromptBuilder.convening(ctx, picks: picks)
        _ = await streamMessage(author: chair, kind: "convening", purpose: .clarify, prebuiltMessages: msgs)
    }

    private func runRoundEnd() async {
        guard let chair = await store.chair(roomId) else { return }
        // Round-wrap recommendation (End vs Continue) · best-effort, drives which
        // button the round-end sheet highlights. Default-to-CONTINUE on failure.
        var recommendation: String? = nil
        if let router {
            let recent = await store.recentMessages(roomId, limit: 30)
            let subject = (await store.roomMeta(roomId))?.subject
            recommendation = await SpeakerPicker.pickRoundWrap(
                router: router, history: recent, roundNum: roundNum, roomSubject: subject).recommendation
        }
        let body = await streamMessage(author: chair, kind: "round-end", purpose: .roundEnd).body
        let parsed = Self.parseRoundEndOutput(body)
        let kps = await store.insertKeyPoints(roomId, roundNum: roundNum, points: parsed.points)
        let shift = parsed.modeShift.map { ConfigEvent.ModeShift(to: $0.to, because: $0.because) }
        await bus.emit(roomId, .configEvent(ConfigEvent(
            kind: "round-ended",
            payload: ConfigEvent.Payload(agentId: nil, changes: nil, keyPoints: kps,
                                         modeShiftProposal: shift, recommendation: recommendation))))
        await setAwaitingContinue(true)
        // Layer 3.2 · fire-and-forget · extract this round's unexplored angles and
        // persist them for next round's director prompt (consumed in P4-5).
        if let router, let fb = fbStore {
            let store = self.store
            let roomId = self.roomId
            let rn = roundNum
            Task {
                let roundMsgs = await store.recentMessages(roomId, limit: 60).filter { $0.roundNum == rn }
                let subject = (await store.roomMeta(roomId))?.subject ?? ""
                let angles = await NegativeSpace.extractNegativeSpace(
                    router: router, roundMessages: roundMsgs, roomSubject: subject)
                if !angles.isEmpty { await fb.insertNegativeSpaceAngles(roomId, roundNum: rn, angles: angles) }
            }
        }
        // Layer · fire-and-forget round-end summarization (L1 for round N-4, fold
        // N-9's L1 into L2) so long-room divergence survives the L0 window.
        if let router, let summary = summaryStore {
            let store = self.store
            let roomId = self.roomId
            let rn = roundNum
            Task { await Summarize.runRoundEnd(router: router, store: store, summary: summary, roomId: roomId, roundJustEnded: rn) }
        }
    }

    /// Valid tones the chair may propose switching to (mirrors VALID_PROPOSAL_TONES).
    static let validProposalTones: Set<String> = ["brainstorm", "constructive", "research", "debate", "critique"]

    /// Parse the chair's round-end output — `ping`, up to 3 `POINTS:` bullets, and
    /// an optional `MODE-SHIFT:`/`BECAUSE:` proposal. Faithful port of
    /// `parseRoundEndOutput` (prompt.ts): tolerant of ASCII/fullwidth colon,
    /// dash/asterisk/middot/numbered bullets, and a missing `POINTS:` header.
    static func parseRoundEndOutput(_ text: String) -> (ping: String, points: [String], modeShift: (to: String, because: String)?) {
        // MODE-SHIFT block (matches anywhere).
        var modeShift: (to: String, because: String)? = nil
        if let m = text.range(of: #"MODE-SHIFT\s*:\s*([^\n]+)\s*\n\s*BECAUSE\s*:\s*([^\n]+)"#,
                              options: [.regularExpression, .caseInsensitive]) {
            let block = String(text[m])
            let toRaw = capture(block, #"MODE-SHIFT\s*:\s*([^\n]+)"#)?
                .lowercased().replacingOccurrences(of: #"[`*_]"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces) ?? ""
            let becauseRaw = capture(block, #"BECAUSE\s*:\s*([^\n]+)"#)?.trimmingCharacters(in: .whitespaces) ?? ""
            if validProposalTones.contains(toRaw), !becauseRaw.isEmpty {
                modeShift = (to: toRaw, because: String(becauseRaw.prefix(240)))
            }
        }

        // POINTS block.
        let headerRe = #"POINTS\s*[:：]"#
        var ping = ""
        var scanFrom = text
        if let header = text.range(of: headerRe, options: [.regularExpression, .caseInsensitive]) {
            ping = String(text[..<header.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
            scanFrom = String(text[header.upperBound...])
        }
        var points: [String] = []
        for line in scanFrom.split(separator: "\n", omittingEmptySubsequences: false) {
            let s = String(line)
            if s.range(of: #"^\s*(MODE-SHIFT|BECAUSE)\s*[:：]"#, options: [.regularExpression, .caseInsensitive]) != nil { break }
            if let p = capture(s, #"^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$"#), !p.isEmpty { points.append(p) }
            if points.count >= 3 { break }
        }
        return (ping, points, modeShift)
    }

    /// First capture group of `pattern` in `s` (case-insensitive), or nil.
    private static func capture(_ s: String, _ pattern: String) -> String? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let r = NSRange(s.startIndex..., in: s)
        guard let m = re.firstMatch(in: s, range: r), m.numberOfRanges > 1,
              let g = Range(m.range(at: 1), in: s) else { return nil }
        return String(s[g])
    }

    // MARK: Streaming a single turn (the finalize invariant lives here)

    /// Stream one author's turn: placeholder → tokens → final. Guarantees the
    /// message is finalized (`streaming:false`) on EVERY exit path (success,
    /// empty, error) so no placeholder is ever left "thinking" forever —
    /// `finalizeStreamingMessage` invariant. Returns the message id + final body.
    @discardableResult
    /// Actor-isolated stream consumer (P4-8b) · accumulates the partial body into
    /// `inflightBody` + emits each token, so a watchdog/interrupt that cancels the
    /// wrapping Task preserves whatever streamed so far. Cancellation-cooperative:
    /// `checkCancellation` between chunks + the AsyncThrowingStream's own
    /// cancellation tears down the socket while suspended on a stalled provider.
    private func consumeTurnStream(mid: String, messages: [LLMMessage], modelV: ModelV, purpose: LLMPurpose) async throws {
        for try await chunk in llm.stream(messages, modelV: modelV, maxTokens: 4000, purpose: purpose) {
            try Task.checkCancellation()
            if case .textDelta(let d) = chunk {
                inflightBody += d
                if !inflightFirstToken { inflightFirstToken = true }
                NSLog("📝ENG emit mid=\(mid) deltaLen=\(d.count) total=\(inflightBody.count)")
                await bus.emit(roomId, .messageToken(MessageToken(messageId: mid, delta: d)))
                // Interleaved TTS · feed completed sentences to the synthesis pump,
                // but only once the body is past the meta-silence ceiling (so a short
                // "（沉默）" turn is never synthesized). The token loop stays full-speed
                // — yielding never blocks — so the pre-warm window for the NEXT
                // director (kicked at onTextFinal) is preserved.
                if inflightSentenceCont != nil {
                    inflightPending.append(contentsOf: inflightChunker.push(d))
                    if inflightBody.count > inflightSynthGate {
                        for s in inflightPending { inflightSentenceCont?.yield(s) }
                        inflightPending.removeAll()
                    }
                }
            } else if case .usage(let u) = chunk {
                // Token accounting · the wire reports usage once near stream end.
                // Accumulate (defensive against >1) → billed to the author at finalize.
                inflightUsageTokens += u.total
            }
        }
    }

    /// Synthesize ONE sentence and emit its voice-chunks with the running global
    /// `inflightSeg` (the interleaved live path). Reuses the per-sentence TTS seam;
    /// each yielded fragment becomes the next contiguous seg the VoicePlayer groups
    /// by. Runs inside the actor-isolated synthesis pump.
    private func synthesizeSentenceEmit(_ sentence: String, mid: String, agentId: String) async {
        guard let tts else { return }
        for await s in tts.synthesizeStream(sentence, agentId: agentId) {
            await bus.emit(roomId, .voiceChunk(VoiceChunk(
                messageId: mid, audioBase64: s.audioBase64, mimeType: "audio/mpeg",
                seq: inflightSeg, seg: inflightSeg, text: s.text)))
            inflightSeg += 1
            inflightEmittedAudio = true
        }
    }

    /// 60s first-token watchdog · cancel the turn if no text token has arrived.
    private func fireFirstTokenWatchdog() {
        guard !inflightFirstToken, let t = inflightStreamTask, !t.isCancelled, turnTimedOutKind == nil else { return }
        turnTimedOutKind = "first-token"
        t.cancel()
    }
    /// 120s hard-cap watchdog · absolute ceiling on the whole stream.
    private func fireHardCapWatchdog() {
        guard let t = inflightStreamTask, !t.isCancelled, turnTimedOutKind == nil else { return }
        turnTimedOutKind = "hard-cap"
        t.cancel()
    }

    private func streamMessage(author: DirectorRef, kind: String?, purpose: LLMPurpose,
                              gatePlayback: Bool = true,
                              prebuiltMessages: [LLMMessage]? = nil,
                              onTextFinal: (() -> Void)? = nil) async -> (id: String, body: String, emittedAudio: Bool) {
        let mid = newId()
        currentTurnMessageId = mid
        await store.insertMessage(EngineMessage(id: mid, roomId: roomId, authorKind: "agent",
                                                authorId: author.id, body: "", roundNum: roundNum,
                                                streaming: true, kind: kind))
        await bus.emit(roomId, .messageAppended(MessageAppended(
            messageId: mid, body: "", authorId: author.id, authorKind: "agent",
            roundNum: roundNum, meta: kind.map { MessageAppended.Meta(kind: $0) })))

        // Finalize exactly once on every exit path (success / error) — the
        // `finalizeStreamingMessage` invariant. Straight-line (no nested closure)
        // to stay clear of Swift's actor-capture data-race checks.
        //
        // Per-turn watchdogs (P4-8b · port of room.ts firstTokenTimer/hardCapTimer):
        // the stream is consumed inside a cancellable Task held in actor state;
        // two timer Tasks cancel it (60s if no first token / 120s absolute) and a
        // hard chairInterrupt cancels it too. AsyncThrowingStream is cancellation-
        // cooperative, so cancelling tears down the underlying socket.
        var body = ""
        var errored = false
        inflightBody = ""; inflightFirstToken = false; turnTimedOutKind = nil
        inflightSeg = 0; inflightEmittedAudio = false; inflightChunker = SentenceChunker(); inflightPending = []
        inflightUsageTokens = 0
        let messages: [LLMMessage]
        var directorHit: SearchHit? = nil
        if let prebuiltMessages {
            messages = prebuiltMessages
        } else {
            let history = await store.recentMessages(roomId, limit: 30)
            let built = await buildPrompt(author: author, purpose: purpose, history: history)
            messages = built.messages
            directorHit = built.search   // nil for chair turns
        }
        // Interleave TTS during the stream for ALL voice turns (directors AND the
        // chair's clarify / convening), so audio starts on sentence 1 instead of
        // after the whole text. Round-end is the ONE exclusion — its synthBody strips
        // structural tokens (POINTS:/MODE-SHIFT:) that only resolve once the whole
        // body is in, so it stays on the post-stream path. A concurrent, actor-
        // isolated pump synthesizes completed sentences. The chair never meta-silences,
        // so it gates at 0 (first sentence speaks immediately); directors keep the
        // 60-char meta-silence ceiling before the pump may start.
        let interleaveVoice = deliveryVoice && tts != nil && kind != "round-end"
        inflightSynthGate = purpose == .director ? 60 : 0
        var synthPump: Task<Void, Never>?
        if interleaveVoice {
            let (sentences, cont) = AsyncStream<String>.makeStream()
            inflightSentenceCont = cont
            let aid = author.id
            synthPump = Task { [weak self] in
                for await sentence in sentences { await self?.synthesizeSentenceEmit(sentence, mid: mid, agentId: aid) }
            }
        }
        let consume = Task { [author, purpose] in
            try await self.consumeTurnStream(mid: mid, messages: messages, modelV: author.modelV, purpose: purpose)
        }
        inflightStreamTask = consume
        // NB · a cancelled `Task.sleep` THROWS (returns immediately) — without the
        // `isCancelled` guard the fire method would run on every turn-end cancel and
        // spuriously abort the NEXT turn's stream (shared inflight* state). Guard it.
        let firstWatch = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 60 * 1_000_000_000)
            if Task.isCancelled { return }
            await self?.fireFirstTokenWatchdog()
        }
        let hardWatch = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 120 * 1_000_000_000)
            if Task.isCancelled { return }
            await self?.fireHardCapWatchdog()
        }
        do {
            try await consume.value
            body = inflightBody
        } catch {
            body = inflightBody
            let kind = turnTimedOutKind
            // Surface the failure as visible text (else the turn is a silent
            // empty bubble — the user can't tell e.g. "no LLM key configured").
            // Watchdog timeouts emit auto-skipped so the client toast is tagged.
            if kind == "first-token" || kind == "hard-cap" {
                errored = true
                if body.isEmpty {
                    body = kind == "first-token"
                        ? "⚠️ LLM 60s 内未产出任何 token，已自动跳过。"
                        : "⚠️ LLM 流超过 120s 上限，已自动跳过。"
                    await bus.emit(roomId, .messageToken(MessageToken(messageId: mid, delta: body)))
                }
                await bus.emit(roomId, .messageError(messageId: mid))
                await bus.emit(roomId, .configEvent(ConfigEvent(kind: "auto-skipped", payload: nil)))
            } else if kind == "interrupt" {
                // Hard chairInterrupt · leave body as-is; the interrupt handler
                // already removed the bubble + will run the chair direct response.
            } else if body.isEmpty {
                errored = true
                body = Self.errorHint(error)
                await bus.emit(roomId, .messageToken(MessageToken(messageId: mid, delta: body)))
            } else {
                errored = true
                await bus.emit(roomId, .messageError(messageId: mid))
            }
        }
        firstWatch.cancel(); hardWatch.cancel()
        inflightStreamTask = nil
        // Token accounting · bill whatever the stream reported to this turn's author,
        // BEFORE any drop decision below (meta-silence / interrupt still spent the
        // tokens). Populates agents.tokens_consumed + usage_daily — the tables the
        // Usage panel aggregates (desktop room.ts:2290 / chair.ts:831).
        if inflightUsageTokens > 0 { await store.recordUsage(agentId: author.id, tokens: inflightUsageTokens) }
        // Hard-interrupt path · the turn was aborted to hand the floor to the
        // chair. Don't finalize a bubble or synthesize — the interrupt handler
        // owns the cleanup. Release any gate waiter + bail.
        if turnTimedOutKind == "interrupt" {
            inflightSentenceCont?.finish(); inflightSentenceCont = nil; synthPump?.cancel()
            await voiceGate.signalDone(mid)
            return (mid, body, false)
        }
        // Meta-silence / empty DIRECTOR turn · drop the placeholder + advance instead
        // of finalizing an empty / "（沉默）" bubble (voice rooms would even read it
        // aloud). Errored turns are KEPT (they carry the ⚠️ text). Port of the
        // hasContent guard in room.ts streamSpeakerTurn. Chair turns (clarify/round-
        // end/convening) are structured, never meta-silence — only gate directors.
        if purpose == .director, !errored {
            let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || Self.looksLikeMetaSilence(trimmed) {
                // Meta-silence ⟹ body ≤ 60 chars ⟹ nothing was ever yielded to the
                // pump (the >60 gate never opened), so cancel it · no silence audio.
                inflightSentenceCont?.finish(); inflightSentenceCont = nil; synthPump?.cancel()
                await store.deleteMessage(mid)
                await bus.emit(roomId, .messageRemoved(messageId: mid, reason: trimmed.isEmpty ? "empty" : "meta-silence"))
                await voiceGate.signalDone(mid)
                return (mid, "", false)
            }
        }
        // Text is fully streamed → finalize + emit message-final NOW, BEFORE any
        // synthesis. The native VoicePlayer's `markTextFinal` arms a 9s fallback
        // and waits for voice-chunks; the client's thinking cue is keyed off
        // `message-final`, so deferring it (the old order: synthesize the WHOLE
        // body first) looped the cue under the entire multi-sentence synth and,
        // for long director turns, blew past the 9s fallback before any audio
        // landed → "director shows text but never speaks, thinking never stops."
        await store.finalizeMessage(mid, body: body)
        await emitDirectorSearchFinal(mid: mid, search: directorHit)

        // A's TEXT is done — kick off the NEXT speaker's pre-warm NOW (desktop's
        // `onMessageFinal` hook), so B's LLM+TTS run during A's TTS synthesis AND
        // playback (the full window), not just A's leftover playback. Fire-and-
        // forget on the caller's side, so this never delays A's own synthesis below.
        onTextFinal?()

        // Voice mode · synthesize sentence-by-sentence and emit each voice-chunk
        // as it lands, so playback of sentence 0 starts (first chunk well within
        // the 9s fallback) while later sentences are still synthesizing — desktop
        // parity. Always emit voice-final after (even on no audio / TTS failure)
        // so the gate releases, never stranding the room.
        var emittedAudio = false
        NSLog("🔊ENG turn mid=\(mid) deliveryVoice=\(deliveryVoice) tts=\(tts != nil) interleave=\(interleaveVoice) kind=\(kind ?? "nil") bodyLen=\(body.count)")
        if interleaveVoice {
            // Director voice turn · most sentences already synthesized DURING the
            // stream (audio started on sentence 1). Flush the held pending sentences
            // + the trailing partial, close the channel, and drain the pump.
            if let cont = inflightSentenceCont {
                for s in inflightPending { cont.yield(s) }
                inflightPending.removeAll()
                for s in inflightChunker.flush() { cont.yield(s) }
                cont.finish()
            }
            inflightSentenceCont = nil
            await synthPump?.value
            emittedAudio = inflightEmittedAudio
        } else {
            // Round-end / chair turns · structural tokens (POINTS: / dash bullets /
            // MODE-SHIFT: / BECAUSE: / tone name) drive the UI vote chips + tone-switch
            // affordance but sound mechanical read aloud, so synthBody strips them for
            // TTS only (the finalized `body` keeps the markers). Non-director turns
            // synthesize the whole (possibly stripped) body in one pass.
            let synthBody = kind == "round-end" ? Self.roundEndSpoken(body) : body
            if deliveryVoice, let tts, !synthBody.isEmpty {
                for await seg in tts.synthesizeStream(synthBody, agentId: author.id) {
                    await bus.emit(roomId, .voiceChunk(VoiceChunk(
                        messageId: mid, audioBase64: seg.audioBase64, mimeType: "audio/mpeg",
                        seq: seg.seg, seg: seg.seg, text: seg.text)))
                    emittedAudio = true
                }
            }
        }
        if deliveryVoice {
            await bus.emit(roomId, .voiceFinal(VoiceFinal(messageId: mid)))
            // Gate every voiced turn (chair included) so the next speaker doesn't
            // start until this clip finished playing — the native VoicePlayer
            // signals done via signalVoiceDone. ONLY wait when audio was actually
            // emitted: with no voice key there are no chunks, the player never
            // fires done, and we'd stall the full 90s per turn. No audio → flow on.
            // `gatePlayback: false` · the director pump gates AFTER scheduling the
            // next turn's pre-warm, so B's LLM+TTS run during A's playback.
            if emittedAudio && gatePlayback { await voiceGate.wait(for: mid, timeout: 90) }
        }
        return (mid, body, emittedAudio)
    }

    /// The spoken form of a round-end body · keeps the ping + key-point content as
    /// flat sentences but drops the structural tokens the desktop's round-end voice
    /// gating also strips: the `POINTS:` marker, dash bullets (→ sentence breaks),
    /// the optional `MODE-SHIFT:` tail (a UI affordance), and a stray `BECAUSE:`.
    static func roundEndSpoken(_ body: String) -> String {
        var s = body
        // Drop the optional MODE-SHIFT tail entirely (tone-switch proposal · UI only).
        if let r = s.range(of: "MODE[-\\s]?SHIFT\\s*:", options: [.regularExpression, .caseInsensitive]) {
            s = String(s[..<r.lowerBound])
        }
        s = s.replacingOccurrences(of: "POINTS\\s*:", with: "", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "(^|\\n)\\s*[-*]\\s*", with: ". ", options: .regularExpression)
        s = s.replacingOccurrences(of: "\\bBECAUSE\\s*:\\s*", with: "", options: [.regularExpression, .caseInsensitive])
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Detect "meta-silence" — a short director completion that narrates abstention
    /// ("（沉默）" / "(silent)" / "I have nothing to add" / "pass this round") instead
    /// of returning empty. These read as bugs + (voice rooms) get spoken aloud, so the
    /// caller drops them like a true-empty turn. Verbatim port of room.ts
    /// `looksLikeMetaSilence` (≤60 chars + the same three abstention pattern groups).
    static func looksLikeMetaSilence(_ body: String) -> Bool {
        let stripped = body.replacingOccurrences(of: "[\\s\\p{P}]", with: "", options: .regularExpression)
        if stripped.isEmpty { return true }
        if body.count > 60 { return false }
        let patterns = [
            "^[\\s\\p{P}]*[（(]\\s*(?:沉默|silent|silence|skip|pass|abstain|abstention|noop|no\\s*op|—)\\s*[)）][\\s\\p{P}]*$",
            "(沉默|无新|无补充|无更多|没有(?:更多|新)的?(?:观点|要(?:补充|说|加))|跳过(?:这|本)?(?:轮|回合)|本轮(?:跳过|沉默)|这轮(?:跳过|沉默)|我(?:选择)?(?:沉默|跳过|不发言|不说话))",
            "\\b(?:I\\s+(?:have\\s+)?nothing\\s+(?:more|further|to\\s+add)|nothing\\s+(?:more|new|to\\s+add|further)|pass(?:ing)?\\s+(?:this|on\\s+this)\\s+round|skip(?:ping)?\\s+(?:this|my)\\s+turn|abstain(?:ing)?(?:\\s+this\\s+(?:round|turn))?|no\\s+(?:new\\s+)?point\\s+(?:to\\s+add|here)|nothing\\s+to\\s+contribute)\\b",
        ]
        for p in patterns where body.range(of: p, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        return false
    }

    /// Race `op` against a hard timeout · returns op's result if it finishes within
    /// `seconds`, else nil (op is cancelled). Bounds the best-effort web-search
    /// picker + search so a stalled LLM / network call can never hang a turn — the
    /// speaker just answers without SHARED MATERIALS. op MUST be cancellable (the
    /// URLSession-backed picker/search are); on timeout we cancel + return nil.
    /// nonisolated/static so the racing tasks run off the actor.
    static func boundedSearch<T: Sendable>(_ seconds: Double, _ op: @escaping @Sendable () async -> T?) async -> T? {
        await withTaskGroup(of: T?.self) { group in
            group.addTask { await op() }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /// Human-facing one-liner for a turn that errored — shown in the bubble so the
    /// user can act (most commonly: configure the on-device LLM key).
    static func errorHint(_ error: Error) -> String {
        guard let e = error as? LLMError else { return "⚠️ \(error)" }
        switch e {
        case .noKey:
            return "⚠️ 未配置 LLM key — 请在「设置 → API 密钥」里添加后重试。"
        case .modelNotReachable(let m, let c):
            return "⚠️ 模型 \(m.rawValue) 在当前 provider（\(c.rawValue)）不可达。"
        case .upstream(let m):
            return "⚠️ 上游错误：\(m)"
        case .exhausted(let m):
            return "⚠️ 多次重试失败：\(m)"
        }
    }

    /// Assemble the LLM prompt for a turn. Chair turns (clarify / round-end) use
    /// the faithfully-ported `ChairPromptBuilder`; director turns use a real
    /// system prompt built from the agent's own instruction + room context (the
    /// full `buildDirectorMessages` port — context/memory/skill layers — is still
    /// pending, marked TODO). Falls back to a tagged stub when room meta is
    /// unavailable (test stores without meta), so the existing actor tests that
    /// key off `purpose` keep working.
    /// Returns the assembled prompt + (for director turns) the web SearchHit so the
    /// caller can surface sources on the message. Chair clarify search is run + made
    /// visible in `runClarify` (a tool-use card BEFORE the clarify bubble), so here
    /// the clarify case just consumes the materials it stashed.
    private func buildPrompt(author: DirectorRef, purpose: LLMPurpose, history: [EngineMessage]) async -> (messages: [LLMMessage], search: SearchHit?) {
        guard let meta = await store.roomMeta(roomId) else {
            return (Self.stubPrompt(author: author, purpose: purpose, history: history), nil)
        }
        let cast = await store.directors(roomId)
        switch purpose {
        case .clarify:
            let chairMaterials = pendingChairMaterials ?? ""
            pendingChairMaterials = nil
            let ctx = await chairContext(meta: meta, chair: author, cast: cast, history: history,
                                         sharedMaterials: chairMaterials)
            let turn = (try? await currentClarifyTurn()) ?? clarifyTurns
            return (ChairPromptBuilder.clarify(ctx, turnNumber: max(1, turn), maxTurns: Self.maxClarifyTurns), nil)
        case .roundEnd:
            let ctx = await chairContext(meta: meta, chair: author, cast: cast, history: history)
            return (ChairPromptBuilder.roundEnd(ctx), nil)
        case .director:
            return await directorPrompt(author: author, meta: meta, cast: cast, history: history)
        }
    }

    private func currentClarifyTurn() async throws -> Int { clarifyTurns }

    private func chairContext(meta: RoomMeta, chair: DirectorRef, cast: [DirectorRef],
                              history: [EngineMessage], sharedMaterials: String = "") async -> ChairPromptBuilder.Context {
        // Chair-only durable USER profile (P4-7c) · the user_long_memory sanctuary
        // ABOVE the chair's own per-agent memory, mirroring prompt.ts ordering.
        var userLongBlock = ""
        if let ul = userLongStore {
            let tags = await ul.listActiveUserLong()
            userLongBlock = ChairPromptBuilder.renderUserLongBlock(userName: meta.userName, tags: tags)
        }
        var memoryBlock = ""
        if let mem = memStore {
            let mems = await mem.memoriesForContext(agentId: chair.id)
            if !mems.isEmpty {
                memoryBlock = DirectorPromptBlocks.memoryBlock(userName: meta.userName, memories: mems)
                await mem.bumpUsage(mems.map(\.id))
            }
        }
        return ChairPromptBuilder.Context(
            chairInstruction: chair.instruction.isEmpty ? "You are the Chair — the meeting host." : chair.instruction,
            subject: meta.subject, mode: meta.mode, intensity: meta.intensity,
            directors: cast.map { .init(name: $0.name, handle: $0.handle, roleTag: $0.roleTag) },
            userName: meta.userName, deliveryVoice: meta.deliveryVoice,
            history: mapHistory(history, cast: cast),
            userLongBlock: userLongBlock, memoryBlock: memoryBlock,
            sharedMaterials: sharedMaterials)
    }

    /// Director system prompt · the agent's identity + room context + the verbatim
    /// SHARED_ROOM_PROTOCOL + tone + intensity guidance (the load-bearing blocks
    /// from `buildDirectorMessages`, via `DirectorPrompts`). TODO(port): L0/L1/L2
    /// context layering, memory injection, skill routing, chair-brief cue.
    /// The full director system prompt — faithful port of `buildDirectorMessages`:
    /// identity → room context → SHARED_ROOM_PROTOCOL → tone → intensity → round
    /// mode → chair brief → language → [voice delivery] → how-the-room-works →
    /// house rules → frame-break guidance → unexplored angles → frame-breaker role
    /// → persona-lens reminder → LANGUAGE LOCK. Consumes P4-4's divergence stash
    /// (frame-break terms / frame-breaker role) + P4-4's negative-space angles.
    private func directorPrompt(author: DirectorRef, meta: RoomMeta, cast: [DirectorRef],
                                history rawHistory: [EngineMessage]) async -> (messages: [LLMMessage], search: SearchHit?) {
        let voice = meta.deliveryVoice
        // Layered context (P4-6) · anchored L0 history + L1/L2 narrative preamble,
        // replacing the flat recent-30 slice so long-room pivots survive.
        let history = await buildDirectorHistory()
        let summaryPreamble = await buildSummaryPreamble(subject: meta.subject)
        let others = cast.filter { $0.id != author.id }
        let othersSummary = others.isEmpty ? "(no other directors — solo room)"
            : others.map { "\($0.name) (\($0.handle)) — \($0.roleTag): \($0.bio)" }.joined(separator: "\n  · ")

        // Opening detection · walk back; a chair round-end summary before a user
        // message means a Continue cycle happened (past the opening sweep) → this is
        // a REACTIVE round, so peer turns become visible and directors cross-talk.
        // The chair's round wrap is persisted with kind "round-end" on-device;
        // "round-prompt" is the desktop's name for the same marker (kept for parity /
        // any legacy rows). Matching only "round-prompt" left `opening` permanently
        // true → peers always stripped → directors never referenced each other.
        var opening = true
        for m in history.reversed() {
            if m.authorKind == "agent", m.kind == "round-end" || m.kind == "round-prompt" { opening = false; break }
            if m.authorKind == "user" { break }
        }

        // Chair brief · consume the next-speaker rationale stashed for this director.
        var chairBriefBlock = ""
        if let cp = pendingChairPick, cp.agentId == author.id {
            chairBriefBlock = DirectorPromptBlocks.chairBrief(cp.rationale)
            pendingChairPick = nil
        }
        // Frame-breaker role (Layer 2.2) · consume if it's this director's turn.
        var frameBreakerBlock = ""
        if let role = pendingFrameBreakerRole, role.agentId == author.id {
            frameBreakerBlock = DirectorPromptBlocks.frameBreakerRole(role.frame)
            lastFrameBreakerAgentId = author.id
            pendingFrameBreakerRole = nil
        }
        // Long-term memory (P4-7) · what THIS director remembers about the user
        // across prior rooms (pinned + stable + recent). bumpUsage feeds decay.
        var memoryBlock = ""
        if let mem = memStore {
            let mems = await mem.memoriesForContext(agentId: author.id)
            if !mems.isEmpty {
                memoryBlock = DirectorPromptBlocks.memoryBlock(userName: meta.userName, memories: mems)
                await mem.bumpUsage(mems.map(\.id))
            }
        }
        // User-interest signals · the user's up/down votes on the chair's round-end
        // key points, surfaced as explicit priority weights for THIS turn (#6).
        let interestBlock = DirectorPromptBlocks.interestLines(await store.votedKeyPoints(roomId))
        // Persona blocks (#12) · few-shot voice examples + reflection checklist +
        // user-authored absolute rules. Non-empty only for Full-mode directors /
        // directors with user rules; zero cost for Signal-mode + seed directors.
        let fewShotBlock = DirectorPromptBlocks.personaFewShot(name: author.name, deliveryVoice: voice, examples: author.fewShot)
        let reflectionBlock = DirectorPromptBlocks.personaReflection(author.reflectionChecklist)
        let userRulesBlock = DirectorPromptBlocks.userRules(author.userRules)
        // Web search is CHAIR-only now (it grounds the room's time-sensitive initial
        // question). Directors don't run per-turn search, but they DO read the chair's
        // findings: inject the chair's SHARED MATERIALS so the round can actually use
        // the results (without this they only see the "Searched 'q'" card and say they
        // "can't see the results"). No per-director sources badge — those stay on the
        // chair's tool-use card.
        let sharedMaterials = chairSearchMaterials ?? ""
        let directorSearch: SearchHit? = nil
        // Follow-up prior context (#11) · for a room continuing a prior session,
        // inject the parent's settled judgement so the room builds on it.
        var priorContextBlock = ""
        if let parent = meta.parentRoomId, !parent.isEmpty,
           let pc = await store.priorContext(parentRoomId: parent) {
            priorContextBlock = DirectorPromptBlocks.followUpPriorContext(
                parentNumber: pc.parentNumber, parentSubject: pc.parentSubject,
                briefTitle: pc.briefTitle, briefBodyMd: pc.briefBodyMd,
                isZh: PickerSupport.detectRoomLang(pc.parentSubject) == .zh)
        }
        // Unexplored angles (Layer 3.2) · pull + consume the prior round's record.
        var unexplored: [String] = []
        if !opening, let fb = fbStore {
            let rows = await fb.recentUnexploredAngles(roomId, limit: 3)
            if !rows.isEmpty {
                unexplored = rows.map(\.angle)
                await fb.markAnglesConsumed(rows.map(\.id))
            }
        }

        let tone = meta.mode.lowercased()
        var blocks: [String] = [
            author.instruction.isEmpty ? "You are \(author.name), a director on this board." : author.instruction,
            "",
            "─── ROOM CONTEXT ───",
            "Room subject: \(meta.subject)",
            "Other directors at the table:",
            "  · \(othersSummary)",
            "\nABOUT THE USER:\nName: \(meta.userName)\n",
        ]
        if !memoryBlock.isEmpty { blocks.append(memoryBlock) }
        // USER SIGNAL · sits after memory, before SHARED_ROOM_PROTOCOL (desktop order).
        if !interestBlock.isEmpty { blocks.append(interestBlock) }
        // Follow-up prior context · between interest signals and SHARED_ROOM_PROTOCOL.
        if !priorContextBlock.isEmpty { blocks.append(priorContextBlock) }
        blocks.append(contentsOf: ["", DirectorPrompts.sharedRoomProtocol])
        // Persona few-shot (#12) · between the cross-tone protocol and the TONE block
        // so persona scaffolding is read BEFORE tone specialisation (desktop order).
        if !fewShotBlock.isEmpty { blocks.append(fewShotBlock) }
        blocks.append(contentsOf: [
            "",
            "─── TONE · \(tone.uppercased()) ───",
            DirectorPrompts.toneGuidance(meta.mode),
            "",
            "─── INTENSITY · \(meta.intensity.uppercased()) ───",
            DirectorPrompts.intensityGuidance(meta.intensity),
            "",
            "─── ROUND MODE · \(opening ? "OPENING (PARALLEL)" : "REACTIVE") ───",
            opening ? DirectorPromptBlocks.openingBlock : DirectorPromptBlocks.reactiveBlock,
        ])
        if !chairBriefBlock.isEmpty { blocks.append(chairBriefBlock) }
        // SHARED MATERIALS (#10) · between chair brief and LANGUAGE (desktop order).
        if !sharedMaterials.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            blocks.append(""); blocks.append(sharedMaterials)
        }
        blocks.append(contentsOf: [
            "",
            "─── LANGUAGE ───",
            "Reply in the SAME LANGUAGE as the conversation. If the user wrote the room subject and their messages in Chinese, reply in Chinese. If English, reply in English. Match whatever language the most recent human message uses. Never switch languages mid-thread.",
        ])
        if voice { blocks.append(DirectorPromptBlocks.voiceDelivery) }
        blocks.append(contentsOf: [
            "",
            DirectorPromptBlocks.howTheRoomWorks(userName: meta.userName),
            "",
            DirectorPromptBlocks.houseRules(speakerName: author.name,
                                            otherName: others.first?.name ?? "Socrates",
                                            tone: tone, voice: voice),
        ])
        // Persona reflection (#12) · after HOUSE RULES — the freshest self-check
        // before generation, tuned to THIS director's failure modes.
        if !reflectionBlock.isEmpty { blocks.append(reflectionBlock) }
        let fb = DirectorPromptBlocks.frameBreakGuidance(pendingFrameBreakTerms)
        if !fb.isEmpty { blocks.append(fb) }
        let ua = DirectorPromptBlocks.unexploredAngles(unexplored)
        if !ua.isEmpty { blocks.append(ua) }
        if !frameBreakerBlock.isEmpty { blocks.append(frameBreakerBlock) }
        let lens = DirectorPromptBlocks.personaLensReminder(
            name: author.name, contrarianTakes: author.contrarianTakes, failureModes: author.failureModes)
        if !lens.isEmpty { blocks.append(lens) }
        // ABSOLUTE RULES (user-authored, NON-NEGOTIABLE) · tail block, just before
        // the language lock, so it survives voice brevity + tone overrides.
        if !userRulesBlock.isEmpty { blocks.append(userRulesBlock) }
        blocks.append(PickerSupport.languageLockBlock(PickerSupport.detectRoomLang(meta.subject)))

        let system = blocks.joined(separator: "\n")
        var messages = [LLMMessage(role: .system, content: system)]
        if !summaryPreamble.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            messages.append(LLMMessage(role: .system, content: summaryPreamble.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
        messages += renderHistoryForDirector(history, speaker: author, cast: cast,
                                             opening: opening, userName: meta.userName)
        messages.append(LLMMessage(role: .user, content: "Your turn — contribute from your lens, per the room protocol and tone, in the room's language."))
        return (messages, directorSearch)
    }

    /// Director-specific history renderer (port of `renderHistoryForDirector`,
    /// prompt.ts:1228-1272). The speaker's OWN prior turns become `role: .assistant`
    /// (with acknowledgment-preface stripping) so the model sees its own voice as a
    /// continuous output stream, not as a user message it must respond to — without
    /// this it loses self-continuity and re-acknowledges the user every turn. Every
    /// other turn (the user, peer directors, the chair) is `role: .user` with
    /// attribution. Opening-sweep blindness · during the OPENING round, peer
    /// directors' messages are hidden so the speaker can't anchor on whoever spoke
    /// first (the native pump emits the opening sweep sequentially, so without this
    /// director 2 would see director 1's turn). Chair messages always pass through
    /// (they're shared context, not peer drafts).
    private func renderHistoryForDirector(_ history: [EngineMessage], speaker: DirectorRef,
                                          cast: [DirectorRef], opening: Bool, userName: String) -> [LLMMessage] {
        let directorIds = Set(cast.map(\.id))
        let who = userName.isEmpty ? "You" : userName
        var out: [LLMMessage] = []
        for m in history where !m.body.isEmpty {
            switch m.authorKind {
            case "system":
                out.append(LLMMessage(role: .user, content: "[system note] \(m.body)"))
            case "user":
                out.append(LLMMessage(role: .user, content: "[\(who)] \(m.body)"))
            default: // agent — the speaker's own turn, a peer director, or the chair
                if m.authorId == speaker.id {
                    out.append(LLMMessage(role: .assistant, content: Self.stripUserAcknowledgmentPreface(m.body)))
                    continue
                }
                if opening, let aid = m.authorId, directorIds.contains(aid) { continue }
                let agent = cast.first { $0.id == m.authorId }
                let name = agent?.name ?? "Director"
                let handle = agent?.handle ?? "@director"
                out.append(LLMMessage(role: .user,
                                      content: "[\(name) · \(handle)] \(Self.stripUserAcknowledgmentPreface(m.body))"))
            }
        }
        // Collapse consecutive same-role turns (providers reject repeated roles).
        var collapsed: [LLMMessage] = []
        for m in out {
            if let last = collapsed.last, last.role == m.role {
                collapsed[collapsed.count - 1] = LLMMessage(role: last.role, content: last.content + "\n\n" + m.content)
            } else { collapsed.append(m) }
        }
        return collapsed
    }

    /// Port of `stripUserAcknowledgmentPreface` (prompt.ts:850). Drops a leading
    /// "既然你… / Since you asked… / 按你说的…" acknowledgment sentence from a
    /// director turn before re-feeding it as history, so the model doesn't learn a
    /// "every turn re-acknowledges the user" precedent and loop it forever. Only the
    /// FIRST sentence is dropped, and only when an echo lead matches within the first
    /// 240 chars AND a sentence terminator exists within 280 — otherwise the body is
    /// returned untouched (never risk truncating substantive content mid-sentence).
    static func stripUserAcknowledgmentPreface(_ body: String) -> String {
        if body.isEmpty { return body }
        let trimmed = String(body.drop(while: { $0.isWhitespace }))
        let head = String(trimmed.prefix(240))
        let headRange = NSRange(location: 0, length: (head as NSString).length)
        guard echoLeadRegex.firstMatch(in: head, range: headRange) != nil else { return body }
        // Mirror JS `slice(0, 280)`: search a real prefix substring so `$` anchors
        // to the window end (NSRegularExpression's `$` ignores the supplied range).
        let ns = trimmed as NSString
        let window = ns.substring(to: min(280, ns.length))
        let winRange = NSRange(location: 0, length: (window as NSString).length)
        guard let m = prefaceTerminatorRegex.firstMatch(in: window, range: winRange) else { return body }
        let rest = ns.substring(from: m.range.location + 1)
        return String(rest.drop(while: { $0.isWhitespace }))
    }

    /// The "既然你 … / Since you asked … / 按你说的 …" acknowledgment lead-ins, with an
    /// optional "name，" prefix — the signature openers that mark a re-acknowledgment.
    private static let echoLeadRegex = try! NSRegularExpression(
        pattern: "^(?:[A-Za-z一-鿿/@_-]+[，,][\\s]*)?(?:既然(?:你|[A-Za-z一-鿿]+)|Since you (?:asked|insist|insisted|stated|claimed|said|noted|requested)|As you (?:asked|stated|noted|said|requested)|按你(?:说的|的要求)|你既然(?:已经|说|提到|要求))")
    /// First sentence terminator (full-width 。 or half-width . then space / EOL).
    private static let prefaceTerminatorRegex = try! NSRegularExpression(pattern: "[。.](?:\\s|$|\\n)")

    private func mapHistory(_ history: [EngineMessage], cast: [DirectorRef]) -> [ChairPromptBuilder.HistoryTurn] {
        history.filter { !$0.body.isEmpty }.map { m in
            switch m.authorKind {
            case "user": return .init(kind: .user, body: m.body)
            case "system": return .init(kind: .system, body: m.body)
            default:
                let who = cast.first { $0.id == m.authorId }
                return .init(kind: .agent, name: who?.name, handle: who?.handle, body: m.body)
            }
        }
    }

    /// Tagged stub used only when no room meta is available (test stores). Keeps
    /// the `purpose`-keyed scripted-LLM tests deterministic.
    static func stubPrompt(author: DirectorRef, purpose: LLMPurpose, history: [EngineMessage]) -> [LLMMessage] {
        let system: String
        switch purpose {
        case .clarify:  system = "ROLE: CHAIR-CLARIFY. Ask a clarifying question, or reply READY."
        case .director: system = "ROLE: DIRECTOR \(author.name). React to the discussion."
        case .roundEnd: system = "ROLE: CHAIR-ROUNDEND. Wrap the round and list key points after POINTS:."
        }
        var msgs = [LLMMessage(role: .system, content: system)]
        for m in history.suffix(30) {
            msgs.append(LLMMessage(role: m.authorKind == "user" ? .user : .assistant, content: m.body))
        }
        return msgs
    }

    // MARK: Flag setters (persist + mirror in-actor)

    private func setAwaitingClarify(_ v: Bool) async { awaitingClarify = v; await store.setAwaitingClarify(roomId, v) }
    private func setAwaitingContinue(_ v: Bool) async { awaitingContinue = v; await store.setAwaitingContinue(roomId, v) }
}
