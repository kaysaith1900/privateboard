import Foundation
import BoardroomCore

/// OpenAI-compatible `/chat/completions` wire — covers OpenRouter, B.AI,
/// Moonshot, and Zhipu (all expose the same protocol at different base URLs).
/// Mirrors what `createOpenAICompatible(...).chatModel(id)` produced on the
/// desktop (`adapter.ts`), including OpenRouter's referer/title headers and the
/// `stream_options.include_usage` opt-in so we get a usage tally.
public struct OpenAICompatibleWire: LLMWire {
    public let baseURL: String          // e.g. "https://openrouter.ai/api/v1"
    public let extraHeaders: [String: String]
    public init(baseURL: String, extraHeaders: [String: String] = [:]) {
        self.baseURL = baseURL; self.extraHeaders = extraHeaders
    }

    /// OpenRouter pins the exact model (no silent reroute) and tags the app.
    public static func openRouter() -> OpenAICompatibleWire {
        OpenAICompatibleWire(baseURL: "https://openrouter.ai/api/v1",
                             extraHeaders: ["HTTP-Referer": "https://boardroom.local",
                                            "X-OpenRouter-Title": "Boardroom"])
    }
    public static func bai() -> OpenAICompatibleWire { .init(baseURL: "https://api.b.ai/v1") }
    public static func moonshot() -> OpenAICompatibleWire { .init(baseURL: "https://api.moonshot.cn/v1") }
    public static func zhipu() -> OpenAICompatibleWire { .init(baseURL: "https://open.bigmodel.cn/api/paas/v4") }

    public func buildRequest(wireId: String, apiKey: String, messages: [LLMMessage],
                             temperature: Double?, maxTokens: Int?) throws -> URLRequest {
        guard let url = URL(string: baseURL + "/chat/completions") else { throw WireError.badBaseURL }
        var body: [String: Any] = [
            "model": wireId,
            "messages": messages.map { ["role": $0.role.rawValue, "content": $0.content] },
            "stream": true,
            "stream_options": ["include_usage": true],
        ]
        if let temperature { body["temperature"] = temperature }
        if let maxTokens { body["max_tokens"] = maxTokens }
        // OpenRouter's allow_fallbacks=false (pin the requested model).
        if baseURL.contains("openrouter.ai") {
            body["provider"] = ["allow_fallbacks": false]
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")  // ← device-SSE: don't gzip the stream
        for (k, v) in extraHeaders { req.setValue(v, forHTTPHeaderField: k) }
        req.httpBody = try jsonBody(body)
        return req
    }

    public func makeDecoder() -> LLMStreamDecoder { Decoder() }

    final class Decoder: LLMStreamDecoder {
        private var servedEmitted = false
        func decode(_ frame: SSELineParser.Frame) -> [LLMStreamChunk] {
            let data = frame.data.trimmingCharacters(in: .whitespaces)
            if data == "[DONE]" { return [.done(finishReason: "stop")] }
            guard let json = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any]
            else { return [] }

            var out: [LLMStreamChunk] = []
            if !servedEmitted, let model = json["model"] as? String, !model.isEmpty {
                servedEmitted = true
                out.append(.served(model: model, provider: "openai-compatible"))
            }
            if let choices = json["choices"] as? [[String: Any]], let first = choices.first {
                if let delta = first["delta"] as? [String: Any],
                   let content = delta["content"] as? String, !content.isEmpty {
                    out.append(.textDelta(content))
                }
                if let reason = first["finish_reason"] as? String { out.append(.done(finishReason: reason)) }
            }
            if let usage = json["usage"] as? [String: Any] {
                let p = (usage["prompt_tokens"] as? Int) ?? 0
                let c = (usage["completion_tokens"] as? Int) ?? 0
                let t = (usage["total_tokens"] as? Int) ?? (p + c)
                if t > 0 { out.append(.usage(TokenUsage(prompt: p, completion: c, total: t))) }
            }
            return out
        }
    }
}
