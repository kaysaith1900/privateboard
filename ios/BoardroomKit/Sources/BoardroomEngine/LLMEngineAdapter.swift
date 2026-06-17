import Foundation
import BoardroomAI

/// Bridges the real `LLMAdapter` (BoardroomAI) to the engine's `EngineLLM` seam.
/// `purpose` is a test-stub discriminator only; the real adapter ignores it and
/// routes by the active credential. Temperature is left to the adapter (it nils
/// it for `noTemperature` models). The app builds this with a Keychain-backed
/// `LLMCredentialSource`; tests use `ScriptedLLM` instead.
public struct LLMEngineAdapter: EngineLLM {
    let adapter: LLMAdapter
    public init(adapter: LLMAdapter) { self.adapter = adapter }

    public func stream(_ messages: [LLMMessage], modelV: String, maxTokens: Int?, purpose: LLMPurpose)
        -> AsyncThrowingStream<LLMStreamChunk, Error> {
        adapter.stream(LLMRequest(modelV: modelV, messages: messages, maxTokens: maxTokens))
    }
}
