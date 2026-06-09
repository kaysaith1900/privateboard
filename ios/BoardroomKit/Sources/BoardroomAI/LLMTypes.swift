import Foundation

/// LLM call types — the Swift counterpart of `LLMMessage` / `LLMRequest` /
/// `LLMStreamChunk` from `src/ai/adapter.ts`. The actual streaming call
/// (`LLMAdapter`, URLSession + per-provider request shaping + SSE decode) lands
/// in the next increment; these are the shared shapes the orchestrator + adapter
/// agree on.

public struct LLMMessage: Sendable, Equatable {
    public enum Role: String, Sendable { case system, user, assistant }
    public let role: Role
    public let content: String
    public init(role: Role, content: String) { self.role = role; self.content = content }
}

public struct TokenUsage: Sendable, Equatable {
    public let prompt: Int
    public let completion: Int
    public let total: Int
    public init(prompt: Int, completion: Int, total: Int) {
        self.prompt = prompt; self.completion = completion; self.total = total
    }
}

public struct LLMRequest: Sendable {
    public let modelV: ModelV
    public let messages: [LLMMessage]
    public var temperature: Double?
    public var maxTokens: Int?
    /// Override the active carrier for this single call (e.g. a director pinned
    /// to a specific provider bucket). nil = use the active LLM credential.
    public var carrierOverride: LLMCarrier?
    public init(modelV: ModelV, messages: [LLMMessage], temperature: Double? = nil,
                maxTokens: Int? = nil, carrierOverride: LLMCarrier? = nil) {
        self.modelV = modelV; self.messages = messages; self.temperature = temperature
        self.maxTokens = maxTokens; self.carrierOverride = carrierOverride
    }
}

/// One chunk yielded by the streaming adapter. Mirrors adapter.ts's
/// `{text-delta | served | usage | done}`; the `.error` case is surfaced by the
/// stream throwing instead of a value.
public enum LLMStreamChunk: Sendable, Equatable {
    case served(model: String, provider: String)   // which carrier/model actually served (catches OR reroutes)
    case textDelta(String)
    case usage(TokenUsage)
    case done(finishReason: String)                 // "stop" | "length" | "content_filter" | "tool_use" | "aborted"
}
