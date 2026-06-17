import Foundation
import BoardroomCore

/// The backend surface a `RoomSession` needs — exactly the methods it calls.
/// `APIClient` (REST/server) and `EngineRoomBackend` (in-process native engine)
/// both conform, so `RoomSession` is driven identically by either: the
/// "preserve the seam" principle, now covering the full live-room surface, not
/// just the event stream.
///
/// Extends `RoomEventSource` (the `roomEvents` stream). Signatures mirror
/// `APIClient` exactly so its conformance is a no-op extension.
protocol RoomBackend: RoomEventSource {
    func getRoom(_ id: String) async throws -> RoomSnapshot
    func getAgent(_ id: String) async throws -> Agent
    func sendMessage(_ id: String, body: String, mode: String) async throws
    func pauseRoom(_ id: String, mode: String) async throws
    func resumeRoom(_ id: String) async throws
    func continueRoom(_ id: String) async throws
    func roundEnd(_ id: String, mode: String) async throws
    func voteKeyPoint(_ id: String, _ kpId: String, vote: String?) async throws
    @discardableResult
    func updateRoomSettings(_ id: String, mode: String?, intensity: String?, deliveryMode: String?,
                            briefStyle: String?, voteTrigger: String?) async throws -> Room
    func voiceProgress(_ id: String, _ messageId: String) async
    func voiceDone(_ id: String, _ messageId: String) async
    func messageAudio(_ messageId: String) async -> Data?
    func synthMessageAudio(_ messageId: String) async -> Data?
}

/// The REST client already implements every method (with matching signatures,
/// some carrying default args — a valid witness), so conformance is empty.
extension APIClient: RoomBackend {}
