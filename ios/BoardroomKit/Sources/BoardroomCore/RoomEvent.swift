import Foundation

/// The canonical room event — the in-process counterpart of one SSE `event:`
/// frame from `src/orchestrator/stream.ts`. The SwiftUI app consumes a stream
/// of these instead of decoding SSE JSON by hand, so the same `RoomSession`
/// switch drives both the REST/SSE backend (today) and the on-device engine
/// (later): the engine just yields `RoomEvent`s onto an `AsyncStream`.
public enum RoomEvent: Sendable {
    case messageAppended(MessageAppended)
    case messageToken(MessageToken)
    case messageFinal(MessageFinal)
    case voiceChunk(VoiceChunk)
    case voiceFinal(VoiceFinal)
    case voiceError(VoiceFinal)         // TTS failed · carries the messageId so the turn can advance
    case configEvent(ConfigEvent)
    case messageError(messageId: String?)
    case messageRemoved(messageId: String, reason: String?)   // chairInterrupt drops the aborted partial bubble
    case unknown(name: String)          // forward-compatible · the app default-breaks

    /// The message this event pertains to, if any (message + voice events). nil for
    /// config-events / unknowns. Lets the client dedup replayed events per message.
    public var messageId: String? {
        switch self {
        case .messageAppended(let d): return d.messageId
        case .messageToken(let d): return d.messageId
        case .messageFinal(let d): return d.messageId
        case .voiceChunk(let d): return d.messageId
        case .voiceFinal(let d): return d.messageId
        case .voiceError(let d): return d.messageId
        case .messageError(let id): return id
        case .messageRemoved(let id, _): return id
        case .configEvent, .unknown: return nil
        }
    }

    /// Decode one SSE frame (event name + `data:` JSON bytes) into a `RoomEvent`.
    /// Returns `nil` when a *known* event's payload fails to decode — matching the
    /// app's prior `if let d = try? decode { … }` behaviour (silently skip a
    /// malformed frame). Unrecognised names decode to `.unknown` (skipped, not
    /// dropped, so the source can log them).
    public static func parse(name: String, data: Data) -> RoomEvent? {
        let dec = JSONDecoder()
        switch name {
        case "message-appended":
            return (try? dec.decode(MessageAppended.self, from: data)).map(RoomEvent.messageAppended)
        case "message-token":
            return (try? dec.decode(MessageToken.self, from: data)).map(RoomEvent.messageToken)
        case "message-final":
            return (try? dec.decode(MessageFinal.self, from: data)).map(RoomEvent.messageFinal)
        case "voice-chunk":
            return (try? dec.decode(VoiceChunk.self, from: data)).map(RoomEvent.voiceChunk)
        case "voice-final":
            return (try? dec.decode(VoiceFinal.self, from: data)).map(RoomEvent.voiceFinal)
        case "voice-error":
            // Treated like voice-final by the client (advance the turn instead of
            // stranding the room in silence); only the messageId is needed.
            return (try? dec.decode(VoiceFinal.self, from: data)).map(RoomEvent.voiceError)
        case "config-event":
            return (try? dec.decode(ConfigEvent.self, from: data)).map(RoomEvent.configEvent)
        case "message-error":
            struct Err: Decodable { let messageId: String? }
            return .messageError(messageId: (try? dec.decode(Err.self, from: data))?.messageId)
        case "message-removed":
            struct Rem: Decodable { let messageId: String; let reason: String? }
            guard let r = try? dec.decode(Rem.self, from: data) else { return nil }
            return .messageRemoved(messageId: r.messageId, reason: r.reason)
        default:
            return .unknown(name: name)
        }
    }
}
