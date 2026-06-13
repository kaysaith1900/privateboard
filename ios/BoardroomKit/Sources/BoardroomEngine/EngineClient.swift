import Foundation
import BoardroomCore

/// The app-facing facade over the in-process `Engine` — the on-device sibling of
/// the REST `APIClient`. Conforms to `RoomEventSource` so `RoomSession` consumes
/// `roomEvents(_:lastEventID:)` identically whether the backend is the SSE server
/// or this engine (the "preserve the seam" principle). Control methods route to
/// the room's actor.
///
/// The remaining `BackendClient` surface (room/agent/brief CRUD) folds in as the
/// engine grows; this is the live-room slice the UI needs first.
public struct EngineClient: RoomEventSource {
    let engine: Engine
    public init(engine: Engine) { self.engine = engine }

    public func roomEvents(_ roomId: String, lastEventID: String?) -> AsyncStream<RoomEvent> {
        let after = lastEventID.flatMap { Int($0) }
        return AsyncStream { continuation in
            let task = Task {
                let sub = await engine.subscribe(roomId, after: after)
                for await stamped in sub {
                    if Task.isCancelled { break }
                    continuation.yield(stamped.event)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: Control (mirrors the APIClient method names the app already calls)

    public func convene(_ roomId: String) async { await engine.convene(roomId) }
    public func sendMessage(_ roomId: String, body: String) async { await engine.submitUserMessage(roomId, body) }
    public func continueRoom(_ roomId: String) async { await engine.continueRoom(roomId) }
    public func requestRoundEnd(_ roomId: String, mode: String) async { await engine.requestRoundEnd(roomId, mode: mode) }
    public func resumeLiveRoom(_ roomId: String) async { await engine.resumeLiveRoom(roomId) }
    public func pauseRoom(_ roomId: String) async { await engine.pauseRoom(roomId) }
    public func resumeRoom(_ roomId: String) async { await engine.resumeRoom(roomId) }
    public func voteKeyPoint(_ kpId: String, vote: String?) async { await engine.voteKeyPoint(kpId, vote: vote) }
    public func voiceDone(_ roomId: String, _ messageId: String) async { await engine.voiceDone(roomId, messageId) }
    public func synthesize(text: String, agentId: String) async -> Data? { await engine.synthesize(text: text, agentId: agentId) }
    public func generateBrief(_ roomId: String, supplement: String? = nil) async throws -> String { try await engine.generateBrief(roomId, supplement: supplement) }
    public func generateBrief(_ roomId: String, supplement: String? = nil, mode: BriefGenerator.Mode) async throws -> String { try await engine.generateBrief(roomId, supplement: supplement, mode: mode) }
    public func latestBriefMarkdown(_ roomId: String) async -> String? { await engine.latestBriefMarkdown(roomId) }
    public func adjournRoom(_ roomId: String) async { await engine.adjourn(roomId) }
}
