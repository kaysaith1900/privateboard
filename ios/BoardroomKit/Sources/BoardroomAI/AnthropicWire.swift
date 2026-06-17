import Foundation
import BoardroomCore

/// Anthropic `/v1/messages` wire (direct Anthropic key). System messages are
/// hoisted into the top-level `system` field (Anthropic doesn't accept a
/// system role in `messages`); `max_tokens` is required so we default it when
/// the caller didn't cap. SSE: `message_start` (input usage) → `content_block_delta`
/// (text) → `message_delta` (output usage + stop_reason) → `message_stop`.
public struct AnthropicWire: LLMWire {
    public let baseURL: String
    public let version: String
    public let defaultMaxTokens: Int
    public init(baseURL: String = "https://api.anthropic.com/v1",
                version: String = "2023-06-01", defaultMaxTokens: Int = 4096) {
        self.baseURL = baseURL; self.version = version; self.defaultMaxTokens = defaultMaxTokens
    }

    public func buildRequest(wireId: String, apiKey: String, messages: [LLMMessage],
                             temperature: Double?, maxTokens: Int?) throws -> URLRequest {
        guard let url = URL(string: baseURL + "/messages") else { throw WireError.badBaseURL }
        let systemText = messages.filter { $0.role == .system }
            .map(\.content).joined(separator: "\n\n")
        let convo = messages.filter { $0.role != .system }
            .map { ["role": $0.role.rawValue, "content": $0.content] }

        var body: [String: Any] = [
            "model": wireId,
            "messages": convo,
            "stream": true,
            "max_tokens": maxTokens ?? defaultMaxTokens,
        ]
        if !systemText.isEmpty { body["system"] = systemText }
        if let temperature { body["temperature"] = temperature }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        req.setValue(version, forHTTPHeaderField: "anthropic-version")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        req.httpBody = try jsonBody(body)
        return req
    }

    public func makeDecoder() -> LLMStreamDecoder { Decoder() }

    final class Decoder: LLMStreamDecoder {
        private var promptTokens = 0
        private var completionTokens = 0
        private var servedEmitted = false

        func decode(_ frame: SSELineParser.Frame) -> [LLMStreamChunk] {
            guard let json = try? JSONSerialization.jsonObject(with: Data(frame.data.utf8)) as? [String: Any]
            else { return [] }
            let type = (json["type"] as? String) ?? frame.event
            var out: [LLMStreamChunk] = []
            switch type {
            case "message_start":
                if let msg = json["message"] as? [String: Any] {
                    if !servedEmitted, let model = msg["model"] as? String {
                        servedEmitted = true
                        out.append(.served(model: model, provider: "anthropic"))
                    }
                    if let usage = msg["usage"] as? [String: Any] {
                        promptTokens = (usage["input_tokens"] as? Int) ?? 0
                    }
                }
            case "content_block_delta":
                if let delta = json["delta"] as? [String: Any], let text = delta["text"] as? String, !text.isEmpty {
                    out.append(.textDelta(text))
                }
            case "message_delta":
                if let usage = json["usage"] as? [String: Any] {
                    completionTokens = (usage["output_tokens"] as? Int) ?? completionTokens
                }
                if let delta = json["delta"] as? [String: Any], let stop = delta["stop_reason"] as? String {
                    let total = promptTokens + completionTokens
                    if total > 0 { out.append(.usage(TokenUsage(prompt: promptTokens, completion: completionTokens, total: total))) }
                    out.append(.done(finishReason: mapStop(stop)))
                }
            default:
                break  // message_stop / ping / content_block_start|stop — nothing to surface
            }
            return out
        }

        /// Map Anthropic stop reasons onto the shared vocabulary the caller uses.
        private func mapStop(_ s: String) -> String {
            switch s {
            case "end_turn", "stop_sequence": return "stop"
            case "max_tokens": return "length"
            default: return s
            }
        }
    }
}
