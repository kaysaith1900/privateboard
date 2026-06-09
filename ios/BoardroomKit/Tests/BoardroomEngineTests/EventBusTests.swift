import XCTest
import BoardroomCore
@testable import BoardroomEngine

final class EventBusTests: XCTestCase {
    private func token(_ id: String, _ delta: String) -> RoomEvent {
        .messageToken(MessageToken(messageId: id, delta: delta))
    }

    func testEmitAssignsMonotonicIds() async {
        let bus = EventBus()
        let a = await bus.emit("r1", token("m", "a"))
        let b = await bus.emit("r1", token("m", "b"))
        XCTAssertEqual(a, 1); XCTAssertEqual(b, 2)
        // ids are per-room.
        let c = await bus.emit("r2", token("m", "c"))
        XCTAssertEqual(c, 1)
    }

    func testReplayThenLive() async {
        let bus = EventBus()
        _ = await bus.emit("r", token("m", "1"))
        _ = await bus.emit("r", token("m", "2"))
        let stream = await bus.subscribe("r")            // replays 1,2
        _ = await bus.emit("r", token("m", "3"))         // live

        var deltas: [String] = []
        for await s in stream {
            if case .messageToken(let t) = s.event, let d = t.delta { deltas.append(d) }
            if deltas.count == 3 { break }
        }
        XCTAssertEqual(deltas, ["1", "2", "3"])
    }

    func testReplayAfterLastEventID() async {
        let bus = EventBus()
        _ = await bus.emit("r", token("m", "1"))
        let id2 = await bus.emit("r", token("m", "2"))
        _ = await bus.emit("r", token("m", "3"))
        let stream = await bus.subscribe("r", after: id2)   // only id > 2

        var deltas: [String] = []
        for await s in stream {
            if case .messageToken(let t) = s.event, let d = t.delta { deltas.append(d) }
            break   // first replayed event
        }
        XCTAssertEqual(deltas, ["3"])
    }

    func testRingCapacityDropsOldest() async {
        let bus = EventBus(ringCapacity: 2)
        _ = await bus.emit("r", token("m", "1"))
        _ = await bus.emit("r", token("m", "2"))
        _ = await bus.emit("r", token("m", "3"))   // evicts "1"
        let stream = await bus.subscribe("r")

        var deltas: [String] = []
        for await s in stream {
            if case .messageToken(let t) = s.event, let d = t.delta { deltas.append(d) }
            if deltas.count == 2 { break }
        }
        XCTAssertEqual(deltas, ["2", "3"])
    }

    func testMultipleSubscribersBothGetLive() async {
        let bus = EventBus()
        let s1 = await bus.subscribe("r")
        let s2 = await bus.subscribe("r")
        let count = await bus.subscriberCount("r")
        XCTAssertEqual(count, 2)
        _ = await bus.emit("r", token("m", "x"))

        func first(_ stream: AsyncStream<EventBus.Stamped>) async -> String? {
            for await s in stream { if case .messageToken(let t) = s.event { return t.delta } }
            return nil
        }
        async let a = first(s1)
        async let b = first(s2)
        let (ra, rb) = await (a, b)
        XCTAssertEqual(ra, "x"); XCTAssertEqual(rb, "x")
    }
}

final class VoicePlaybackGateTests: XCTestCase {
    func testSignalBeforeWaitReturnsImmediately() async {
        let gate = VoicePlaybackGate()
        await gate.signalDone("m1")
        await gate.wait(for: "m1")   // must not hang
    }

    func testWaitThenSignal() async {
        let gate = VoicePlaybackGate()
        let waiter = Task { await gate.wait(for: "m2") }
        await gate.signalDone("m2")
        await waiter.value          // resolves
    }

    func testTimeoutReleases() async {
        let gate = VoicePlaybackGate()
        // No signal ever; the timeout must release the wait.
        await gate.wait(for: "never", timeout: 0.05)
    }
}
