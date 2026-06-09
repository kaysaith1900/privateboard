import Foundation

// Decodable payloads for the room event stream — one per event name in the
// backend's `ROOM_EVENTS` (api.js / src/orchestrator/stream.ts). Field names
// match the SSE `data:` JSON the web shell reads, so the on-device engine and
// the REST/SSE path produce byte-compatible payloads.
//
// These were moved verbatim out of the app's `Net/Events.swift` so the future
// in-process engine (a separate module) can construct + emit them too. Each is
// `public` + `Sendable` and carries an explicit memberwise init for that
// engine-side construction (Decodable still drives the SSE/loopback path).

/// A web-search result source · rides on a message's meta (chair tool-use card +
/// director sources badge). Mirrors the desktop `webSearchSources` shape.
public struct SearchSource: Codable, Sendable, Equatable, Hashable {
    public let title: String?
    public let url: String?
    public let description: String?
    public init(title: String?, url: String?, description: String?) {
        self.title = title; self.url = url; self.description = description
    }
}

public struct MessageAppended: Decodable, Sendable {
    public let messageId: String
    public let body: String?
    public let authorId: String?
    public let authorKind: String?      // "agent" | "user" | "system"
    public let roundNum: Int?
    public let meta: Meta?
    public struct Meta: Decodable, Sendable {
        public let kind: String?         // e.g. "round-open", "clarify", "round-prompt", "tool-use"
        public let recommendation: Recommendation?   // round-prompt · chair's End-vs-Continue call
        // Web search · chair tool-use card (kind == "tool-use") + director badge.
        public let tool: String?         // "web-search"
        public let toolStatus: String?   // "done"
        public let searchQuery: String?
        public let sources: [SearchSource]?
        public struct Recommendation: Decodable, Sendable {
            public let kind: String?     // "end" | "continue"
            public init(kind: String?) { self.kind = kind }
        }
        public init(kind: String?, recommendation: Recommendation? = nil,
                    tool: String? = nil, toolStatus: String? = nil,
                    searchQuery: String? = nil, sources: [SearchSource]? = nil) {
            self.kind = kind; self.recommendation = recommendation
            self.tool = tool; self.toolStatus = toolStatus
            self.searchQuery = searchQuery; self.sources = sources
        }
    }
    public init(messageId: String, body: String?, authorId: String?,
                authorKind: String?, roundNum: Int?, meta: Meta?) {
        self.messageId = messageId; self.body = body; self.authorId = authorId
        self.authorKind = authorKind; self.roundNum = roundNum; self.meta = meta
    }
}

public struct MessageToken: Decodable, Sendable {
    public let messageId: String
    public let delta: String?
    public init(messageId: String, delta: String?) {
        self.messageId = messageId; self.delta = delta
    }
}

public struct MessageFinal: Decodable, Sendable {
    public let messageId: String
    // Web search · a director's sources land on finalize (the search runs during
    // prompt assembly, after the streaming row was already appended).
    public let searchQuery: String?
    public let sources: [SearchSource]?
    public init(messageId: String, searchQuery: String? = nil, sources: [SearchSource]? = nil) {
        self.messageId = messageId; self.searchQuery = searchQuery; self.sources = sources
    }
}

public struct VoiceChunk: Decodable, Sendable {
    public let messageId: String
    public let audioBase64: String?
    public let mimeType: String?
    public let seq: Int?
    public let seg: Int?            // per-sentence index · groups chunks into one playable MP3
    public let text: String?       // the sentence being synthesized · drives caption karaoke
    public init(messageId: String, audioBase64: String?, mimeType: String?,
                seq: Int?, seg: Int?, text: String?) {
        self.messageId = messageId; self.audioBase64 = audioBase64; self.mimeType = mimeType
        self.seq = seq; self.seg = seg; self.text = text
    }
}

public struct VoiceFinal: Decodable, Sendable {
    public let messageId: String
    public init(messageId: String) { self.messageId = messageId }
}

public struct ConfigEvent: Decodable, Sendable {
    public let kind: String?            // "room-paused" | "room-resumed" | "round-ended" | "member-added" | "member-removed" | "settings-changed" | ...
    public let payload: Payload?
    public struct Payload: Decodable, Sendable {
        public let agentId: String?     // member-added / member-removed carry the seated director's id
        public let changes: Changes?    // settings-changed carries before/after for each edited field
        public let keyPoints: [KeyPoint]?            // round-ended · chair's votable key points
        public let modeShiftProposal: ModeShift?     // round-ended · chair's tone-shift advisory
        public let recommendation: String?           // round-ended · pickRoundWrap "end" | "continue"
        public let queue: [QueueUpdate.Entry]?       // queue-update · ordered directors still to speak this round
        public init(agentId: String?, changes: Changes?,
                    keyPoints: [KeyPoint]? = nil, modeShiftProposal: ModeShift? = nil,
                    recommendation: String? = nil, queue: [QueueUpdate.Entry]? = nil) {
            self.agentId = agentId; self.changes = changes
            self.keyPoints = keyPoints; self.modeShiftProposal = modeShiftProposal
            self.recommendation = recommendation; self.queue = queue
        }
    }
    public struct KeyPoint: Decodable, Sendable {
        public let id: String
        public let body: String
        public let position: Int?
        public let vote: String?        // "up" | "down" | null
        public init(id: String, body: String, position: Int?, vote: String?) {
            self.id = id; self.body = body; self.position = position; self.vote = vote
        }
    }
    public struct ModeShift: Decodable, Sendable {
        public let to: String?
        public let because: String?
        public init(to: String?, because: String?) { self.to = to; self.because = because }
    }
    public struct Changes: Decodable, Sendable {
        public let mode: Change?
        public let intensity: Change?
        public let deliveryMode: Change?    // voice ↔ text · drives live TTS on/off
        public struct Change: Decodable, Sendable {
            public let from: String?
            public let to: String?
            public init(from: String?, to: String?) { self.from = from; self.to = to }
        }
        public init(mode: Change?, intensity: Change?, deliveryMode: Change? = nil) {
            self.mode = mode; self.intensity = intensity; self.deliveryMode = deliveryMode
        }
    }
    public init(kind: String?, payload: Payload?) { self.kind = kind; self.payload = payload }
}

public struct QueueUpdate: Decodable, Sendable {
    public let queue: [Entry]?
    public struct Entry: Decodable, Sendable {
        public let agentId: String
        public let status: String?      // "speaking" | "thinking" | "up"
        public init(agentId: String, status: String?) { self.agentId = agentId; self.status = status }
    }
    public init(queue: [Entry]?) { self.queue = queue }
}
