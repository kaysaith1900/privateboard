import Foundation

/// The live-event seam. Whoever drives a room — the REST/SSE `APIClient` today,
/// the in-process `EngineClient` later — vends an ordered `AsyncStream` of
/// `RoomEvent`s. `RoomSession` depends only on this, never on `SSEClient` or the
/// engine directly.
///
/// `lastEventID` mirrors SSE `Last-Event-ID`: on resubscribe (e.g. foregrounding)
/// the source replays buffered events newer than that id, then goes live. Pass
/// `nil` for a fresh subscription.
///
/// This is the first slice of the full `BackendClient` facade; the remaining
/// REST surface (room controls, agents, briefs) folds into this protocol in
/// Phase 3, once the engine and shared models exist.
public protocol RoomEventSource: Sendable {
    func roomEvents(_ roomId: String, lastEventID: String?) -> AsyncStream<RoomEvent>
}

public extension RoomEventSource {
    func roomEvents(_ roomId: String) -> AsyncStream<RoomEvent> {
        roomEvents(roomId, lastEventID: nil)
    }
}
