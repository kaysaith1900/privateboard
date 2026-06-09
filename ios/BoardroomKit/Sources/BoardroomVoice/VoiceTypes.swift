import Foundation

public enum VoiceProviderKind: String, Sendable, Equatable {
    case minimax, elevenlabs, openai, browser
}

/// Per-director voice config (the Swift counterpart of `AgentVoiceProfile`).
public struct VoiceProfile: Sendable, Equatable {
    public var provider: VoiceProviderKind
    public var model: String
    public var voiceId: String
    public var speed: Double
    public var pitch: Double
    public var volume: Double
    public var emotion: String?
    public var modifyPitch: Int?
    public var modifyIntensity: Int?
    public var modifyTimbre: Int?
    public init(provider: VoiceProviderKind, model: String, voiceId: String,
                speed: Double = 1, pitch: Double = 0, volume: Double = 1,
                emotion: String? = nil, modifyPitch: Int? = nil,
                modifyIntensity: Int? = nil, modifyTimbre: Int? = nil) {
        self.provider = provider; self.model = model; self.voiceId = voiceId
        self.speed = speed; self.pitch = pitch; self.volume = volume; self.emotion = emotion
        self.modifyPitch = modifyPitch; self.modifyIntensity = modifyIntensity; self.modifyTimbre = modifyTimbre
    }
}

/// One synthesized clip — maps to the `voice-chunk` event's audio payload
/// (base64 MP3 per sentence). `provider == "browser"` is the no-key fallback.
public struct TtsChunk: Sendable, Equatable {
    public let provider: String
    public let model: String
    public let voiceId: String
    public let text: String
    public let mimeType: String?
    public let audioBase64: String?
    public init(provider: String, model: String, voiceId: String, text: String,
                mimeType: String? = nil, audioBase64: String? = nil) {
        self.provider = provider; self.model = model; self.voiceId = voiceId
        self.text = text; self.mimeType = mimeType; self.audioBase64 = audioBase64
    }
}

/// Billing failure (insufficient balance / credits) → the UI routes to an
/// upgrade overlay. Mirrors `TtsBillingError` from tts.ts.
public struct TtsBillingError: Error, Equatable {
    public let provider: String
    public let message: String
    public let upgradeUrl: String
}

/// Supplies voice API keys + region at synth time (Keychain-backed in the app).
public protocol VoiceCredentialSource: Sendable {
    func voiceKey(_ provider: VoiceProviderKind) -> String?
    /// "cn" → api.minimaxi.com · "intl" → api.minimax.io
    var minimaxRegion: String { get }
}
