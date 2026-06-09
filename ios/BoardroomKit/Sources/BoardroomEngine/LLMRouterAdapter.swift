import Foundation
import BoardroomAI

/// Concrete `EngineRouter` over the real `LLMAdapter` + `Availability`. Resolves
/// the utility/default model from the ACTIVE LLM credential's carrier (mirroring
/// the desktop `utilityModelFor` / `effectiveDefaultModel`, which read the active
/// carrier) and runs one-shot calls by draining `adapter.stream` into a string
/// (the desktop `callLLM`). The app builds this with a Keychain-backed
/// `LLMCredentialSource`; tests use a `ScriptedRouter` stub instead.
public struct LLMRouter: EngineRouter {
    let adapter: LLMAdapter
    let credentials: LLMCredentialSource
    public init(adapter: LLMAdapter, credentials: LLMCredentialSource) {
        self.adapter = adapter; self.credentials = credentials
    }

    private var activeCarrier: LLMCarrier? { credentials.activeLLMCredential()?.carrier }

    public func utilityModelV() -> ModelV? { Availability.utilityModel(active: activeCarrier) }
    public func defaultModelV() -> ModelV? { Availability.defaultModel(active: activeCarrier) }
    public func reachableModelVs() -> Set<ModelV> {
        Set(Availability.reachable(active: activeCarrier).map(\.modelV))
    }

    public func call(_ messages: [LLMMessage], modelV: ModelV,
                     temperature: Double?, maxTokens: Int?) async throws -> String {
        var out = ""
        let stream = adapter.stream(LLMRequest(modelV: modelV, messages: messages,
                                               temperature: temperature, maxTokens: maxTokens))
        for try await chunk in stream {
            if case .textDelta(let d) = chunk { out += d }
        }
        return out
    }
}
