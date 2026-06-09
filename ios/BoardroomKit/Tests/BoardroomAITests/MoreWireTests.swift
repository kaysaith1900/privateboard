import XCTest
import BoardroomCore
@testable import BoardroomAI

final class OpenAIResponsesWireTests: XCTestCase {
    func testRequestShape() throws {
        let req = try OpenAIResponsesWire.openAI().buildRequest(
            wireId: "gpt-5.5", apiKey: "sk",
            messages: [.init(role: .system, content: "sys"), .init(role: .user, content: "hi")],
            temperature: nil, maxTokens: 4000)
        XCTAssertEqual(req.url?.absoluteString, "https://api.openai.com/v1/responses")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any])
        XCTAssertEqual(body["model"] as? String, "gpt-5.5")
        XCTAssertEqual(body["instructions"] as? String, "sys")
        XCTAssertEqual((body["reasoning"] as? [String: Any])?["effort"] as? String, "none")
        XCTAssertEqual(body["max_output_tokens"] as? Int, 4000)
        let input = try XCTUnwrap(body["input"] as? [[String: String]])
        XCTAssertEqual(input, [["role": "user", "content": "hi"]])
    }

    func testXaiOmitsReasoning() throws {
        let req = try OpenAIResponsesWire.xai().buildRequest(
            wireId: "grok", apiKey: "k", messages: [.init(role: .user, content: "x")],
            temperature: nil, maxTokens: nil)
        XCTAssertEqual(req.url?.host, "api.x.ai")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any])
        XCTAssertNil(body["reasoning"])
    }

    func testDecode() {
        let d = OpenAIResponsesWire.openAI().makeDecoder()
        let t: [LLMStreamChunk] = d.decode(SSELineParser.Frame(event: "response.output_text.delta", data: #"{"delta":"Hi"}"#, id: nil))
        XCTAssertEqual(t, [LLMStreamChunk.textDelta("Hi")])
        let end: [LLMStreamChunk] = d.decode(SSELineParser.Frame(event: "response.completed", data: #"{"response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}"#, id: nil))
        XCTAssertEqual(end, [LLMStreamChunk.usage(TokenUsage(prompt: 3, completion: 2, total: 5)), .done(finishReason: "stop")])
        // unrelated event types produce nothing.
        XCTAssertTrue(d.decode(SSELineParser.Frame(event: "response.created", data: "{}", id: nil)).isEmpty)
    }
}

final class GeminiWireTests: XCTestCase {
    func testRequestShape() throws {
        let req = try GeminiWire().buildRequest(
            wireId: "gemini-3.1-pro-preview", apiKey: "gk",
            messages: [.init(role: .system, content: "sys"), .init(role: .user, content: "u"),
                       .init(role: .assistant, content: "a")],
            temperature: 0.5, maxTokens: 2000)
        XCTAssertTrue(req.url?.absoluteString.hasSuffix("/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse") ?? false)
        XCTAssertEqual(req.value(forHTTPHeaderField: "x-goog-api-key"), "gk")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any])
        let gen = try XCTUnwrap(body["generationConfig"] as? [String: Any])
        XCTAssertEqual((gen["thinkingConfig"] as? [String: Any])?["thinkingBudget"] as? Int, 0)
        XCTAssertEqual(gen["maxOutputTokens"] as? Int, 2000)
        XCTAssertEqual(gen["temperature"] as? Double, 0.5)
        let sys = try XCTUnwrap(body["systemInstruction"] as? [String: Any])
        let sysParts = try XCTUnwrap(sys["parts"] as? [[String: String]])
        XCTAssertEqual(sysParts.first?["text"], "sys")
        // assistant role maps to "model".
        let contents = try XCTUnwrap(body["contents"] as? [[String: Any]])
        XCTAssertEqual(contents.map { $0["role"] as? String }, ["user", "model"])
    }

    func testDecode() {
        let d = GeminiWire().makeDecoder()
        let t: [LLMStreamChunk] = d.decode(SSELineParser.Frame(event: "message",
            data: #"{"candidates":[{"content":{"parts":[{"text":"Hi"}]}}],"modelVersion":"gemini-3.1-pro"}"#, id: nil))
        XCTAssertEqual(t, [LLMStreamChunk.served(model: "gemini-3.1-pro", provider: "google"), .textDelta("Hi")])
        let end: [LLMStreamChunk] = d.decode(SSELineParser.Frame(event: "message",
            data: #"{"candidates":[{"content":{"parts":[{"text":"."}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":6,"totalTokenCount":10}}"#, id: nil))
        XCTAssertEqual(end, [LLMStreamChunk.textDelta("."), .usage(TokenUsage(prompt: 4, completion: 6, total: 10)), .done(finishReason: "length")])
    }
}

final class WireResolverTests: XCTestCase {
    func testResolveAnthropicDirect() {
        let r = WireResolver.resolve(.opus_4_7, carrier: .anthropic)
        XCTAssertEqual(r?.wireId, "claude-opus-4-7")
        XCTAssertTrue(r?.wire is AnthropicWire)
    }
    func testResolveOpenRouter() {
        let r = WireResolver.resolve(.kimi_k2_6, carrier: .openrouter)
        XCTAssertEqual(r?.wireId, "moonshotai/kimi-k2.6")
        XCTAssertTrue(r?.wire is OpenAICompatibleWire)
    }
    func testResolveBaiGapIsUnreachable() {
        XCTAssertNil(WireResolver.resolve(.opus_4_6_fast, carrier: .bai))   // no baiId
    }
    func testResolveCrossFamilyUnreachable() {
        XCTAssertNil(WireResolver.resolve(.gpt_5_5, carrier: .anthropic))   // wrong direct family
    }
    func testResolveOpenAIResponses() {
        let r = WireResolver.resolve(.gpt_5_5, carrier: .openai)
        XCTAssertEqual(r?.wireId, "gpt-5.5")
        XCTAssertTrue(r?.wire is OpenAIResponsesWire)
    }
}
