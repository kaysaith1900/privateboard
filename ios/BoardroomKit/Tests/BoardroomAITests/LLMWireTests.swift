import XCTest
import BoardroomCore
@testable import BoardroomAI

final class OpenAICompatibleWireTests: XCTestCase {
    private let msgs = [LLMMessage(role: .system, content: "be terse"),
                        LLMMessage(role: .user, content: "hi")]

    private func bodyDict(_ req: URLRequest) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any])
    }

    func testRequestShape() throws {
        let wire = OpenAICompatibleWire.openRouter()
        let req = try wire.buildRequest(wireId: "anthropic/claude-opus-4.7", apiKey: "sk-or",
                                        messages: msgs, temperature: 0.7, maxTokens: 1000)
        XCTAssertEqual(req.url?.absoluteString, "https://openrouter.ai/api/v1/chat/completions")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer sk-or")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Accept-Encoding"), "identity")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-OpenRouter-Title"), "Boardroom")
        let body = try bodyDict(req)
        XCTAssertEqual(body["model"] as? String, "anthropic/claude-opus-4.7")
        XCTAssertEqual(body["stream"] as? Bool, true)
        XCTAssertEqual(body["temperature"] as? Double, 0.7)
        XCTAssertEqual(body["max_tokens"] as? Int, 1000)
        XCTAssertEqual((body["stream_options"] as? [String: Any])?["include_usage"] as? Bool, true)
        XCTAssertEqual((body["provider"] as? [String: Any])?["allow_fallbacks"] as? Bool, false)
        let messages = try XCTUnwrap(body["messages"] as? [[String: String]])
        XCTAssertEqual(messages, [["role": "system", "content": "be terse"], ["role": "user", "content": "hi"]])
    }

    func testTemperatureOmittedWhenNil() throws {
        let req = try OpenAICompatibleWire.bai().buildRequest(
            wireId: "claude-opus-4.7", apiKey: "k", messages: msgs, temperature: nil, maxTokens: nil)
        let body = try bodyDict(req)
        XCTAssertNil(body["temperature"])
        XCTAssertNil(body["max_tokens"])
        XCTAssertNil(body["provider"])   // only OpenRouter pins fallbacks
    }

    func testDecodeStream() {
        let d = OpenAICompatibleWire(baseURL: "https://x").makeDecoder()
        let f1: [LLMStreamChunk] = d.decode(SSELineParser.Frame(event: "message", data: #"{"model":"x","choices":[{"delta":{"content":"Hel"}}]}"#, id: nil))
        XCTAssertEqual(f1, [LLMStreamChunk.served(model: "x", provider: "openai-compatible"), .textDelta("Hel")])
        let f2: [LLMStreamChunk] = d.decode(SSELineParser.Frame(event: "message", data: #"{"choices":[{"delta":{"content":"lo"}}]}"#, id: nil))
        XCTAssertEqual(f2, [LLMStreamChunk.textDelta("lo")])   // served only emitted once
        let f3: [LLMStreamChunk] = d.decode(SSELineParser.Frame(event: "message", data: #"{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}"#, id: nil))
        XCTAssertEqual(f3, [LLMStreamChunk.done(finishReason: "stop"), .usage(TokenUsage(prompt: 10, completion: 5, total: 15))])
        let done: [LLMStreamChunk] = d.decode(SSELineParser.Frame(event: "message", data: "[DONE]", id: nil))
        XCTAssertEqual(done, [LLMStreamChunk.done(finishReason: "stop")])
    }
}

final class AnthropicWireTests: XCTestCase {
    func testRequestHoistsSystemAndDefaultsMaxTokens() throws {
        let wire = AnthropicWire()
        let req = try wire.buildRequest(
            wireId: "claude-opus-4-7", apiKey: "sk-ant",
            messages: [.init(role: .system, content: "rule A"), .init(role: .system, content: "rule B"),
                       .init(role: .user, content: "q")],
            temperature: nil, maxTokens: nil)
        XCTAssertEqual(req.url?.absoluteString, "https://api.anthropic.com/v1/messages")
        XCTAssertEqual(req.value(forHTTPHeaderField: "x-api-key"), "sk-ant")
        XCTAssertEqual(req.value(forHTTPHeaderField: "anthropic-version"), "2023-06-01")
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any])
        XCTAssertEqual(body["system"] as? String, "rule A\n\nrule B")
        XCTAssertEqual(body["max_tokens"] as? Int, 4096)   // default when nil
        XCTAssertNil(body["temperature"])                  // omitted (noTemperature path)
        let messages = try XCTUnwrap(body["messages"] as? [[String: String]])
        XCTAssertEqual(messages, [["role": "user", "content": "q"]])   // system hoisted out
    }

    func testDecodeStream() {
        let d = AnthropicWire().makeDecoder()
        _ = d.decode(SSELineParser.Frame(event: "message_start", data: #"{"type":"message_start","message":{"model":"claude-opus-4-7","usage":{"input_tokens":42}}}"#, id: nil))
        let t: [LLMStreamChunk] = d.decode(SSELineParser.Frame(event: "content_block_delta", data: #"{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}"#, id: nil))
        XCTAssertEqual(t, [LLMStreamChunk.textDelta("Hi")])
        let end: [LLMStreamChunk] = d.decode(SSELineParser.Frame(event: "message_delta", data: #"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}"#, id: nil))
        XCTAssertEqual(end, [LLMStreamChunk.usage(TokenUsage(prompt: 42, completion: 8, total: 50)), .done(finishReason: "stop")])
    }

    func testMaxTokensStopMapsToLength() {
        let d = AnthropicWire().makeDecoder()
        _ = d.decode(SSELineParser.Frame(event: "message_start", data: #"{"type":"message_start","message":{"usage":{"input_tokens":1}}}"#, id: nil))
        let end = d.decode(SSELineParser.Frame(event: "message_delta", data: #"{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":1}}"#, id: nil))
        XCTAssertTrue(end.contains(.done(finishReason: "length")))
    }
}

final class RetryTests: XCTestCase {
    func testTransientClassification() {
        for s in ["HTTP 503", "503 Service Unavailable", "no instances available",
                  "Rate limit exceeded", "429 too many requests", "ECONNRESET",
                  "fetch failed", "upstream timeout", "model is overloaded"] {
            XCTAssertTrue(Retry.isTransient(s), "should be transient: \(s)")
        }
        for s in ["HTTP 401 unauthorized", "model not found", "insufficient_quota",
                  "invalid api key", "HTTP 400 bad request", ""] {
            XCTAssertFalse(Retry.isTransient(s), "should NOT be transient: \(s)")
        }
    }

    func testBackoffBase() {
        XCTAssertEqual(Retry.baseDelayMs(retryNumber: 1), 800)
        XCTAssertEqual(Retry.baseDelayMs(retryNumber: 2), 2400)
        // jittered stays within ±20% of base.
        for _ in 0..<50 {
            let d = Retry.jitteredDelayMs(retryNumber: 1)
            XCTAssertTrue(d >= 720 && d <= 880, "jitter out of range: \(d)")
        }
    }
}
