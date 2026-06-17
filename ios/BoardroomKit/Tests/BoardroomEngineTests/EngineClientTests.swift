import XCTest
import BoardroomCore
@testable import BoardroomEngine

final class EngineClientTests: XCTestCase {
    private func makeEngine() -> Engine {
        let store = InMemoryStore(
            directors: [DirectorRef(id: "d1", name: "Alice", modelV: .opus_4_7),
                        DirectorRef(id: "d2", name: "Bob", modelV: .sonnet_4_6)],
            chair: DirectorRef(id: "chair", name: "Chair", modelV: .haiku_4_5))
        let llm = ScriptedLLM(clarify: ["READY"], director: ["view"], roundEnd: ["w\nPOINTS:\n- a\n- b"])
        return Engine(store: store, llm: llm)
    }

    func testRoomEventsAdaptsBusStream() async {
        let engine = makeEngine()
        let client = EngineClient(engine: engine)

        // Drive a full round then adjourn; the ring buffers every event.
        await engine.convene("r1")        // READY → opening round → round-ended
        await engine.adjourn("r1")

        // Subscribe via the client facade and drain the replayed backlog up to
        // the terminal marker.
        var events: [RoomEvent] = []
        for await e in client.roomEvents("r1", lastEventID: nil) {
            events.append(e)
            if case .configEvent(let c) = e, c.kind == "room-adjourned" { break }
        }

        // Saw director turns + the round-end + the adjourn, in order.
        let appendedAgents = events.contains { if case .messageAppended(let a) = $0 { return a.authorKind == "agent" } else { return false } }
        XCTAssertTrue(appendedAgents)
        let kinds = events.compactMap { e -> String? in if case .configEvent(let c) = e { return c.kind } else { return nil } }
        XCTAssertTrue(kinds.contains("round-ended"))
        XCTAssertEqual(kinds.last, "room-adjourned")

        // round-ended carried the chair's key points through the facade.
        let roundEnded = events.compactMap { e -> ConfigEvent? in
            if case .configEvent(let c) = e, c.kind == "round-ended" { return c }; return nil
        }.first
        XCTAssertEqual(roundEnded?.payload?.keyPoints?.map(\.body), ["a", "b"])
    }

    func testControlMethodsRoute() async {
        let engine = makeEngine()
        let client = EngineClient(engine: engine)
        await client.convene("r2")                 // → awaiting continue after the round ends
        await client.continueRoom("r2")            // routes to the actor → another round
        await client.adjournRoom("r2")

        var sawSecondRoundEnd = 0
        for await e in client.roomEvents("r2", lastEventID: nil) {
            if case .configEvent(let c) = e, c.kind == "round-ended" { sawSecondRoundEnd += 1 }
            if case .configEvent(let c) = e, c.kind == "room-adjourned" { break }
        }
        XCTAssertGreaterThanOrEqual(sawSecondRoundEnd, 2, "convene + continue each produced a round-ended")
    }

    func testLastEventIDSkipsReplayedPrefix() async {
        let engine = makeEngine()
        let client = EngineClient(engine: engine)
        await engine.convene("r3")
        await engine.adjourn("r3")

        func drain(_ lastEventID: String?) async -> Int {
            var n = 0
            for await e in client.roomEvents("r3", lastEventID: lastEventID) {
                n += 1
                if case .configEvent(let c) = e, c.kind == "room-adjourned" { break }
            }
            return n
        }
        let total = await drain(nil)
        let afterTwo = await drain("2")        // skip the first two emitted events
        XCTAssertGreaterThan(total, 0)
        XCTAssertEqual(afterTwo, total - 2, "lastEventID=2 replays everything after id 2")
    }
}
