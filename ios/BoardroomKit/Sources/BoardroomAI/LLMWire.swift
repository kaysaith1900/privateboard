import Foundation
import BoardroomCore

/// A provider "wire" knows how to build the HTTP request for one provider's
/// native API and how to decode that provider's SSE frames into our typed
/// `LLMStreamChunk`s. The Vercel AI SDK did this on the desktop (`adapter.ts`);
/// on-device we construct the wire formats ourselves.
///
/// `temperature` arrives already resolved (the adapter passes `nil` for
/// `noTemperature` models — Claude 4.7 rejects the field), so a wire just omits
/// it when nil. `maxTokens` likewise omitted when nil, except where a provider
/// requires it (Anthropic), where the wire supplies a default.
public protocol LLMWire: Sendable {
    func buildRequest(wireId: String, apiKey: String, messages: [LLMMessage],
                      temperature: Double?, maxTokens: Int?) throws -> URLRequest
    /// A fresh stateful decoder for one streaming response.
    func makeDecoder() -> LLMStreamDecoder
}

/// Stateful per-response SSE decoder. Fed one parsed SSE frame at a time;
/// returns the typed chunks that frame produced (usually 0 or 1).
public protocol LLMStreamDecoder: AnyObject {
    func decode(_ frame: SSELineParser.Frame) -> [LLMStreamChunk]
}

enum WireError: Error { case encodeFailed, badBaseURL }

/// Serialize a `[String: Any]` body to JSON `Data` with stable key ordering
/// (sorted) so request-body tests are deterministic.
func jsonBody(_ dict: [String: Any]) throws -> Data {
    guard JSONSerialization.isValidJSONObject(dict) else { throw WireError.encodeFailed }
    return try JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys])
}
