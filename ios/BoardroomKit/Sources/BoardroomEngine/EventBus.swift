import Foundation
import BoardroomCore

/// Per-room event fan-out + replay — the in-process port of `roomBus`
/// (`src/orchestrator/stream.ts`). Each room has a ring buffer (last N events,
/// monotonic id) and a set of live subscribers. A new subscriber replays the
/// buffered tail after its `lastEventID` (mirrors SSE `Last-Event-ID`), then
/// receives live events. This is the single seam the UI consumes: `EngineClient`
/// adapts `subscribe` into `RoomEventSource.roomEvents`.
public actor EventBus {
    /// An emitted event paired with its monotonic per-room id.
    public struct Stamped: Sendable { public let id: Int; public let event: RoomEvent }

    private struct Channel {
        var ring: [Stamped] = []
        var subscribers: [UUID: AsyncStream<Stamped>.Continuation] = [:]
        var seq = 0
    }

    private var channels: [String: Channel] = [:]
    private let ringCapacity: Int

    public init(ringCapacity: Int = 100) { self.ringCapacity = ringCapacity }

    /// Append to the room's ring (assigning the next id) and fan out to live
    /// subscribers. Returns the assigned id.
    @discardableResult
    public func emit(_ roomId: String, _ event: RoomEvent) -> Int {
        var ch = channels[roomId] ?? Channel()
        ch.seq += 1
        let stamped = Stamped(id: ch.seq, event: event)
        ch.ring.append(stamped)
        if ch.ring.count > ringCapacity { ch.ring.removeFirst(ch.ring.count - ringCapacity) }
        for (_, cont) in ch.subscribers { cont.yield(stamped) }
        channels[roomId] = ch
        return ch.seq
    }

    /// Subscribe to a room. Replays buffered events with id > `lastEventID`
    /// (pass nil for all buffered), then streams live events. Terminating the
    /// returned stream (task cancellation / break) unregisters the subscriber.
    public func subscribe(_ roomId: String, after lastEventID: Int? = nil) -> AsyncStream<Stamped> {
        let id = UUID()
        var ch = channels[roomId] ?? Channel()
        let backlog = ch.ring.filter { lastEventID == nil || $0.id > lastEventID! }

        let stream = AsyncStream<Stamped> { continuation in
            for entry in backlog { continuation.yield(entry) }
            ch.subscribers[id] = continuation
            channels[roomId] = ch
            continuation.onTermination = { [weak self] _ in
                Task { await self?.unregister(roomId, id) }
            }
        }
        return stream
    }

    /// Drop a room's ring + subscribers (room closed / evicted).
    public func clear(_ roomId: String) {
        if let ch = channels[roomId] { for (_, c) in ch.subscribers { c.finish() } }
        channels[roomId] = nil
    }

    public func subscriberCount(_ roomId: String) -> Int { channels[roomId]?.subscribers.count ?? 0 }

    /// Snapshot the room's buffered events in order (diagnostics / tests).
    public func snapshot(_ roomId: String) -> [RoomEvent] { (channels[roomId]?.ring ?? []).map(\.event) }

    private func unregister(_ roomId: String, _ id: UUID) {
        channels[roomId]?.subscribers[id] = nil
    }
}
