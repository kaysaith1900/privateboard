import XCTest
import BoardroomCore
import BoardroomAI
@testable import BoardroomEngine

/// Director-turn LLM that invokes a hook after emitting its first delta (before
/// `.done`) on the FIRST director turn only. The hook runs on the producer task
/// while the actor is suspended consuming the stream — a clean reentrant point to
/// call `pause()` and prove the soft-pause flag is honoured after the current
/// speaker, without cross-task gate juggling (which deadlocked).
final class HookDirectorLLM: EngineLLM, @unchecked Sendable {
    private let lock = NSLock()
    private var directorCalls = 0
    let onFirstDirector: @Sendable () async -> Void
    init(onFirstDirector: @escaping @Sendable () async -> Void) { self.onFirstDirector = onFirstDirector }

    func stream(_ messages: [LLMMessage], modelV: String, maxTokens: Int?, purpose: LLMPurpose)
        -> AsyncThrowingStream<LLMStreamChunk, Error> {
        switch purpose {
        case .clarify:  return Self.instant("READY")
        case .roundEnd: return Self.instant("wrap\nPOINTS:\n- a")
        case .director:
            let isFirst: Bool = { lock.lock(); defer { lock.unlock() }; directorCalls += 1; return directorCalls == 1 }()
            let hook = onFirstDirector
            return AsyncThrowingStream { cont in
                let t = Task {
                    cont.yield(.textDelta("view"))
                    if isFirst { await hook() }     // ← reentrant pause() lands here
                    cont.yield(.done(finishReason: "stop"))
                    cont.finish()
                }
                cont.onTermination = { _ in t.cancel() }
            }
        }
    }
    private static func instant(_ text: String) -> AsyncThrowingStream<LLMStreamChunk, Error> {
        AsyncThrowingStream { cont in cont.yield(.textDelta(text)); cont.yield(.done(finishReason: "stop")); cont.finish() }
    }
}

final class SoftPauseTests: XCTestCase {
    func testSoftPauseHonouredAfterCurrentSpeaker() async {
        let bus = EventBus()
        let store = InMemoryStore(
            directors: [DirectorRef(id: "d1", name: "A", modelV: .opus_4_7),
                        DirectorRef(id: "d2", name: "B", modelV: .sonnet_4_6)],
            chair: DirectorRef(id: "chair", name: "C", modelV: .haiku_4_5))
        // Box the actor so the hook can reach it (set before convene runs).
        final class Box: @unchecked Sendable { var actor: RoomActor? }
        let box = Box()
        let llm = HookDirectorLLM { if let a = box.actor { await a.pause() } }
        let actor = RoomActor(roomId: "r1", bus: bus, store: store, llm: llm)
        box.actor = actor

        await actor.convene()      // clarify READY → opening round → d1 streams, hook pauses, pump stops

        let status = await actor.currentStatus
        XCTAssertEqual(status, .paused, "soft pause stops the round after the current speaker")
        let agents = await store.agentMessageCount
        XCTAssertEqual(agents, 2, "chair clarify + d1 only — d2 deferred by the pause")
        let kinds = await bus.snapshot("r1").compactMap { e -> String? in
            if case .configEvent(let c) = e { return c.kind } else { return nil } }
        XCTAssertTrue(kinds.contains("room-paused"))
        XCTAssertFalse(kinds.contains("round-ended"), "round must NOT end while paused")
        let streaming = await store.streamingCount
        XCTAssertEqual(streaming, 0, "d1's turn still finalized despite the pause")

        // Resume → d2 runs, the round ends.
        await actor.resume()
        let resumedStatus = await actor.currentStatus
        XCTAssertEqual(resumedStatus, .live)
        let agentsAfter = await store.agentMessageCount
        XCTAssertGreaterThan(agentsAfter, 2)
        let awaitingContinue = await actor.isAwaitingContinue
        XCTAssertTrue(awaitingContinue, "round-end fires after resume drains the queue")
    }

    /// Regression · pausing MID-TURN must persist `.paused` to the store immediately,
    /// not defer it to the pump's soft-pause block (which waits on the current
    /// speaker's playback gate — a paused clip never releases it until the 90s
    /// timeout). If the store stays `live` in that window, leaving + re-entering the
    /// room reads `live` and auto-plays a room the user explicitly paused.
    func testPausePersistsToStoreImmediatelyMidTurn() async {
        let store = InMemoryStore(
            directors: [DirectorRef(id: "d1", name: "A", modelV: .opus_4_7),
                        DirectorRef(id: "d2", name: "B", modelV: .sonnet_4_6)],
            chair: DirectorRef(id: "chair", name: "C", modelV: .haiku_4_5))
        final class Box: @unchecked Sendable { var actor: RoomActor?; var storeStatusAtPause: RoomStatus? }
        let box = Box()
        let s = store
        let llm = HookDirectorLLM {
            if let a = box.actor { await a.pause(); box.storeStatusAtPause = await s.status }
        }
        let actor = RoomActor(roomId: "r1", bus: EventBus(), store: store, llm: llm)
        box.actor = actor
        await actor.convene()
        XCTAssertEqual(box.storeStatusAtPause, .paused,
                       "pause() must write .paused to the store the instant it's called, even mid-turn")
    }
}
