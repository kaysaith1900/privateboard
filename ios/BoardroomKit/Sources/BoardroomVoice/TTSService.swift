import Foundation

/// Synthesizes one clip of speech for a sentence — the Swift counterpart of
/// `synthesizeSpeech` (`tts.ts`). Single-shot per sentence (the orchestrator
/// drives sentence-by-sentence playback). Throws `TtsBillingError` on
/// insufficient balance so the caller can emit `voice-error` + an upgrade
/// overlay rather than stranding the room in silence.
///
/// ⚠️ Network is verified on-device; request building + response parsing are
/// unit-tested in `TTSWire`.
public struct TTSService: Sendable {
    let credentials: VoiceCredentialSource
    let session: URLSession
    public init(credentials: VoiceCredentialSource, session: URLSession = .shared) {
        self.credentials = credentials; self.session = session
    }

    public func synthesize(_ text: String, profile: VoiceProfile) async throws -> TtsChunk {
        switch profile.provider {
        case .minimax:    return try await minimax(text, profile)
        case .openai:     return try await binary(text, profile, provider: "openai")
        case .elevenlabs: return try await binary(text, profile, provider: "elevenlabs")
        case .browser:    return browserFallback(text, profile)
        }
    }

    private func minimax(_ text: String, _ profile: VoiceProfile) async throws -> TtsChunk {
        guard let key = credentials.voiceKey(.minimax) else { return browserFallback(text, profile) }
        let region = credentials.minimaxRegion
        let req = try TTSWire.minimaxRequest(text: text, profile: profile, apiKey: key, region: region)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode == 402 { throw TTSWire.minimaxBilling(region: region) }
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let body = String(decoding: data, as: UTF8.self)
            if TTSWire.isBalanceMessage(body) { throw TTSWire.minimaxBilling(region: region) }
            throw TTSError.badResponse("MiniMax HTTP \(http.statusCode): \(body.prefix(300))")
        }
        return try TTSWire.parseMiniMax(data, profile: profile, text: text, region: region)   // also catches 200+status_code billing
    }

    private func binary(_ text: String, _ profile: VoiceProfile, provider: String) async throws -> TtsChunk {
        let kind: VoiceProviderKind = provider == "openai" ? .openai : .elevenlabs
        guard let key = credentials.voiceKey(kind) else { return browserFallback(text, profile) }
        let req = provider == "openai"
            ? try TTSWire.openAIRequest(text: text, profile: profile, apiKey: key)
            : try TTSWire.elevenLabsRequest(text: text, profile: profile, apiKey: key)
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let body = String(decoding: data, as: UTF8.self)
            if provider == "elevenlabs", http.statusCode == 402 || TTSWire.isElevenLabsCreditError(body) {
                throw TTSWire.elevenLabsBilling()
            }
            throw TTSError.badResponse("\(provider) HTTP \(http.statusCode): \(body.prefix(300))")
        }
        let model = profile.model.isEmpty ? (provider == "openai" ? "gpt-4o-mini-tts" : "eleven_multilingual_v2") : profile.model
        return TtsChunk(provider: provider, model: model, voiceId: profile.voiceId, text: text,
                        mimeType: "audio/mpeg", audioBase64: data.base64EncodedString())
    }

    private func browserFallback(_ text: String, _ profile: VoiceProfile) -> TtsChunk {
        TtsChunk(provider: "browser", model: "speechSynthesis", voiceId: "system-default", text: text)
    }
}
