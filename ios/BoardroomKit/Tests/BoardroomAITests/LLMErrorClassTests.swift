import XCTest
@testable import BoardroomAI

/// Locks the user-prompt classification: billing / auth / network / upstream
/// against real-shaped provider error bodies (parity with src/ai/billing-error.ts).
final class LLMErrorClassTests: XCTestCase {

    func testBilling() {
        let cases = [
            "Error code: 402 - payment required",
            "Your credit balance is too low to access the Claude API",
            "insufficient_quota: You exceeded your current quota",
            "OpenRouter: insufficient credits",
            "余额不足，请充值",
            "this team doesn't have any credits or licenses yet",
        ]
        for m in cases {
            guard case .billing = LLMErrorClass.classify(message: m) else {
                return XCTFail("expected billing for: \(m)")
            }
        }
    }

    func testBillingProviderHint() {
        XCTAssertEqual(LLMErrorClass.classify(message: "openrouter: insufficient credits").provider, "OpenRouter")
        XCTAssertEqual(LLMErrorClass.classify(message: "anthropic: credit balance too low").provider, "Anthropic")
        // insufficient_quota is an OpenAI tell even without the word "openai".
        XCTAssertEqual(LLMErrorClass.classify(message: "insufficient_quota").provider, "OpenAI")
    }

    func testAuth() {
        for m in ["HTTP 401 Unauthorized", "invalid api key provided", "authentication_error"] {
            XCTAssertEqual(LLMErrorClass.classify(message: m), .auth, "expected auth for: \(m)")
        }
    }

    func testNetwork() {
        for m in ["HTTP 503 service unavailable", "rate-limit exceeded (429)", "fetch failed: ETIMEDOUT", "upstream timeout"] {
            XCTAssertEqual(LLMErrorClass.classify(message: m), .network, "expected network for: \(m)")
        }
    }

    func testUpstreamFallback() {
        XCTAssertEqual(LLMErrorClass.classify(message: "some weird unparseable thing"), .upstream)
    }

    func testEventKind() {
        XCTAssertEqual(LLMErrorClass.billing(provider: "OpenAI").eventKind, "billing")
        XCTAssertEqual(LLMErrorClass.auth.eventKind, "auth")
        XCTAssertEqual(LLMErrorClass.network.eventKind, "network")
        XCTAssertNil(LLMErrorClass.upstream.eventKind)
    }

    func testLLMErrorMapping() {
        XCTAssertEqual(LLMErrorClass.classify(LLMError.noKey), .auth)
        if case .billing = LLMErrorClass.classify(LLMError.upstream("insufficient_quota")) {} else {
            XCTFail("upstream billing message should classify as billing")
        }
    }
}
