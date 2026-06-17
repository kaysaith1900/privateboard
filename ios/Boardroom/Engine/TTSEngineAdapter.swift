import Foundation
import BoardroomEngine
import BoardroomVoice

/// Bridges `BoardroomVoice.TTSService` to the engine's `EngineTTS` seam: cleans
/// the text for speech, splits into sentences, synthesizes each, and returns the
/// base64 MP3 segments the engine emits as `voice-chunk`s. The active voice
/// provider is resolved LIVE (so configuring a voice key after launch takes
/// effect); the voice profile is a per-provider default (per-director voice
/// customization is a later port). Failures degrade to no audio (the engine
/// still emits voice-final → the gate releases, room never strands).
struct TTSEngineAdapter: EngineTTS {
    let service: TTSService
    let resolveProvider: @Sendable () -> VoiceProviderKind?   // nil = no key → silent
    var resolveVoice: @Sendable (String) -> VoiceProfile? = { _ in nil }   // per-agent saved voice (voice_json)

    func synthesizeStream(_ text: String, agentId: String) -> AsyncStream<(seg: Int, text: String, audioBase64: String)> {
        AsyncStream { continuation in
            let task = Task {
                guard let provider = resolveProvider() else {
                    NSLog("🔊TTS synthesizeStream NO PROVIDER (no active voice credential) agent=\(agentId)")
                    continuation.finish(); return
                }
                let cleaned = Speech.cleanForSpeech(Speech.stripSpokenLabels(text))
                let sentences = SentenceSplitter.split(cleaned)
                NSLog("🔊TTS synthesizeStream provider=\(provider.rawValue) sentences=\(sentences.count) textLen=\(cleaned.count) agent=\(agentId)")
                guard !sentences.isEmpty else { continuation.finish(); return }
                // The director's chosen voice (voice_json) when it matches the
                // active provider's key; else the provider default.
                let saved = resolveVoice(agentId)
                let profile = (saved?.provider == provider ? saved : nil) ?? Self.defaultProfile(provider)
                var seg = 0
                for s in sentences {
                    if Task.isCancelled { break }
                    // One TTS call per sentence; yield the moment it lands so the
                    // engine emits its voice-chunk and the player can begin while
                    // the next sentence synthesizes. Skip silent/failed sentences
                    // (seg only advances on real audio → contiguous seg indices).
                    do {
                        let chunk = try await service.synthesize(s, profile: profile)
                        guard let b64 = chunk.audioBase64 else {
                            NSLog("🔊TTS synth seg=\(seg) NO audioBase64 (provider=\(chunk.provider) browser-fallback?) sentence=\"\(s.prefix(30))\"")
                            continue
                        }
                        NSLog("🔊TTS synth seg=\(seg) OK b64len=\(b64.count)")
                        continuation.yield((seg: seg, text: s, audioBase64: b64))
                        seg += 1
                    } catch {
                        NSLog("🔊TTS synth seg=\(seg) FAILED: \(error)")
                        if let billing = error as? TtsBillingError {
                            // Insufficient balance / credits · every remaining sentence
                            // would fail the same way → stop and surface ONE alert.
                            await VoiceBillingAlert.post(billing)
                            break
                        }
                        if let auth = error as? TtsAuthError {
                            // Invalid / wrong-region key · would fail every sentence →
                            // surface ONE "key rejected" alert instead of silent muting.
                            await VoiceBillingAlert.postKeyError(auth)
                            break
                        }
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Surfaces a TTS billing failure (insufficient balance / credits) to the UI ·
    /// a DEBOUNCED NotificationCenter post (the engine fires one synth per sentence,
    /// each failing the same way, so without the debounce the alert would re-raise
    /// dozens of times). The app root observes `didFail` and raises one alert.
    @MainActor
    enum VoiceBillingAlert {
        static let didFail = Notification.Name("bb.voice.billing")
        static let didFailKey = Notification.Name("bb.voice.keyerror")   // invalid / wrong-region key
        private static var lastPost = Date.distantPast
        private static var lastKeyPost = Date.distantPast
        static func post(_ e: TtsBillingError) {
            guard Date().timeIntervalSince(lastPost) > 30 else { return }
            lastPost = Date()
            NotificationCenter.default.post(name: didFail, object: nil,
                userInfo: ["provider": e.provider, "message": e.message, "upgradeUrl": e.upgradeUrl])
        }
        static func postKeyError(_ e: TtsAuthError) {
            guard Date().timeIntervalSince(lastKeyPost) > 30 else { return }
            lastKeyPost = Date()
            NotificationCenter.default.post(name: didFailKey, object: nil,
                userInfo: ["provider": e.provider, "message": e.message])
        }
    }

    /// Sensible default voice per provider (per-director customization later).
    static func defaultProfile(_ provider: VoiceProviderKind) -> VoiceProfile {
        switch provider {
        case .minimax:    return VoiceProfile(provider: .minimax, model: "speech-2.8-hd", voiceId: "male-qn-qingse")
        case .elevenlabs: return VoiceProfile(provider: .elevenlabs, model: "eleven_multilingual_v2", voiceId: "21m00Tcm4TlvDq8ikWAM")
        case .openai:     return VoiceProfile(provider: .openai, model: "gpt-4o-mini-tts", voiceId: "marin")
        case .browser:    return VoiceProfile(provider: .browser, model: "", voiceId: "")
        }
    }
}
