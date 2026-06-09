import Foundation
import BoardroomCore

/// Google Gemini `/v1beta/models/{model}:streamGenerateContent?alt=sse` wire.
/// `thinkingConfig.thinkingBudget = 0` disables the built-in reasoning trace
/// (which otherwise eats the `maxOutputTokens` budget before visible text — the
/// same problem the desktop solved). Roles map user→"user", assistant→"model";
/// system messages become `systemInstruction`. Auth via `x-goog-api-key`.
public struct GeminiWire: LLMWire {
    public let baseURL: String
    public init(baseURL: String = "https://generativelanguage.googleapis.com/v1beta") {
        self.baseURL = baseURL
    }

    public func buildRequest(wireId: String, apiKey: String, messages: [LLMMessage],
                             temperature: Double?, maxTokens: Int?) throws -> URLRequest {
        guard let url = URL(string: "\(baseURL)/models/\(wireId):streamGenerateContent?alt=sse")
        else { throw WireError.badBaseURL }
        let systemText = messages.filter { $0.role == .system }.map(\.content).joined(separator: "\n\n")
        let contents = messages.filter { $0.role != .system }.map { msg in
            ["role": msg.role == .assistant ? "model" : "user", "parts": [["text": msg.content]]] as [String: Any]
        }
        var generationConfig: [String: Any] = ["thinkingConfig": ["thinkingBudget": 0]]
        if let maxTokens { generationConfig["maxOutputTokens"] = maxTokens }
        if let temperature { generationConfig["temperature"] = temperature }

        var body: [String: Any] = ["contents": contents, "generationConfig": generationConfig]
        if !systemText.isEmpty { body["systemInstruction"] = ["parts": [["text": systemText]]] }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        req.httpBody = try jsonBody(body)
        return req
    }

    public func makeDecoder() -> LLMStreamDecoder { Decoder() }

    final class Decoder: LLMStreamDecoder {
        private var servedEmitted = false
        func decode(_ frame: SSELineParser.Frame) -> [LLMStreamChunk] {
            guard let json = try? JSONSerialization.jsonObject(with: Data(frame.data.utf8)) as? [String: Any]
            else { return [] }
            var out: [LLMStreamChunk] = []
            if !servedEmitted, let model = json["modelVersion"] as? String {
                servedEmitted = true
                out.append(.served(model: model, provider: "google"))
            }
            if let candidates = json["candidates"] as? [[String: Any]], let first = candidates.first {
                if let content = first["content"] as? [String: Any],
                   let parts = content["parts"] as? [[String: Any]] {
                    let text = parts.compactMap { $0["text"] as? String }.joined()
                    if !text.isEmpty { out.append(.textDelta(text)) }
                }
                if let reason = first["finishReason"] as? String, !reason.isEmpty {
                    if let usage = json["usageMetadata"] as? [String: Any] {
                        let p = (usage["promptTokenCount"] as? Int) ?? 0
                        let c = (usage["candidatesTokenCount"] as? Int) ?? 0
                        let t = (usage["totalTokenCount"] as? Int) ?? (p + c)
                        if t > 0 { out.append(.usage(TokenUsage(prompt: p, completion: c, total: t))) }
                    }
                    out.append(.done(finishReason: mapReason(reason)))
                }
            }
            return out
        }
        private func mapReason(_ r: String) -> String {
            switch r {
            case "STOP": return "stop"
            case "MAX_TOKENS": return "length"
            case "SAFETY", "RECITATION": return "content_filter"
            default: return r.lowercased()
            }
        }
    }
}
