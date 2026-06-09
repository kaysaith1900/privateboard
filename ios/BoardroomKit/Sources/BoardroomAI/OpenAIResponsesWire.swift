import Foundation
import BoardroomCore

/// OpenAI / xAI `/v1/responses` wire. The desktop routed direct OpenAI through
/// the Responses API (`createOpenAI().responses(id)`) with `reasoningEffort:
/// "none"` (the GPT-5.x family otherwise burns the token budget on internal
/// reasoning before any visible text). xAI Grok 4.x uses the SAME shape at a
/// different base URL but WITHOUT the reasoning knob (xAI toggles reasoning via
/// a model-id suffix instead). System messages become the top-level
/// `instructions`; the rest go in `input`.
public struct OpenAIResponsesWire: LLMWire {
    public let baseURL: String
    public let includeReasoning: Bool
    public init(baseURL: String, includeReasoning: Bool) {
        self.baseURL = baseURL; self.includeReasoning = includeReasoning
    }
    public static func openAI() -> OpenAIResponsesWire { .init(baseURL: "https://api.openai.com/v1", includeReasoning: true) }
    public static func xai() -> OpenAIResponsesWire { .init(baseURL: "https://api.x.ai/v1", includeReasoning: false) }

    public func buildRequest(wireId: String, apiKey: String, messages: [LLMMessage],
                             temperature: Double?, maxTokens: Int?) throws -> URLRequest {
        guard let url = URL(string: baseURL + "/responses") else { throw WireError.badBaseURL }
        let instructions = messages.filter { $0.role == .system }.map(\.content).joined(separator: "\n\n")
        let input = messages.filter { $0.role != .system }.map { ["role": $0.role.rawValue, "content": $0.content] }

        var body: [String: Any] = ["model": wireId, "input": input, "stream": true]
        if !instructions.isEmpty { body["instructions"] = instructions }
        if includeReasoning { body["reasoning"] = ["effort": "none"] }
        if let maxTokens { body["max_output_tokens"] = maxTokens }
        if let temperature { body["temperature"] = temperature }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        req.httpBody = try jsonBody(body)
        return req
    }

    public func makeDecoder() -> LLMStreamDecoder { Decoder() }

    final class Decoder: LLMStreamDecoder {
        func decode(_ frame: SSELineParser.Frame) -> [LLMStreamChunk] {
            // Responses API uses NAMED SSE events.
            guard let json = try? JSONSerialization.jsonObject(with: Data(frame.data.utf8)) as? [String: Any]
            else { return [] }
            switch frame.event {
            case "response.output_text.delta":
                if let delta = json["delta"] as? String, !delta.isEmpty { return [.textDelta(delta)] }
            case "response.completed", "response.incomplete":
                var out: [LLMStreamChunk] = []
                if let resp = json["response"] as? [String: Any], let usage = resp["usage"] as? [String: Any] {
                    let p = (usage["input_tokens"] as? Int) ?? 0
                    let c = (usage["output_tokens"] as? Int) ?? 0
                    let t = (usage["total_tokens"] as? Int) ?? (p + c)
                    if t > 0 { out.append(.usage(TokenUsage(prompt: p, completion: c, total: t))) }
                }
                out.append(.done(finishReason: frame.event == "response.incomplete" ? "length" : "stop"))
                return out
            default:
                break
            }
            return []
        }
    }
}
