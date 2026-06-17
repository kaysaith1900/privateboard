import Foundation

/// Per-provider TTS request builders + response parsers, ported from the
/// single-shot synth paths in `src/voice/tts.ts` (MiniMax `t2a_v2` stream:false,
/// OpenAI `audio/speech`, ElevenLabs `text-to-speech`). Builders + parsers are
/// pure (unit-tested); the network round-trip lives in `TTSService` and is
/// verified on-device.
public enum TTSWire {
    // MARK: MiniMax (JSON, hex-encoded MP3)

    public static func minimaxBaseURL(region: String) -> String {
        region == "cn" ? "https://api.minimaxi.com" : "https://api.minimax.io"
    }

    public static func minimaxRequest(text: String, profile: VoiceProfile, apiKey: String, region: String) throws -> URLRequest {
        guard let url = URL(string: minimaxBaseURL(region: region) + "/v1/t2a_v2") else { throw TTSError.badURL }
        var voiceSetting: [String: Any] = [
            "voice_id": profile.voiceId, "speed": profile.speed,
            "vol": profile.volume, "pitch": profile.pitch,
        ]
        if let e = profile.emotion, !e.isEmpty { voiceSetting["emotion"] = e }
        var body: [String: Any] = [
            "model": profile.model.isEmpty ? "speech-2.8-hd" : profile.model,
            "text": text, "stream": false, "language_boost": "auto",
            "voice_setting": voiceSetting,
            "audio_setting": ["sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1],
        ]
        var modify: [String: Any] = [:]
        if let v = profile.modifyPitch { modify["pitch"] = v }
        if let v = profile.modifyIntensity { modify["intensity"] = v }
        if let v = profile.modifyTimbre { modify["timbre"] = v }
        if !modify.isEmpty { body["voice_modify"] = modify }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return req
    }

    /// Parse MiniMax's JSON response → TtsChunk. MiniMax returns HTTP 200 with a
    /// non-zero `base_resp.status_code` on logical failures (insufficient balance
    /// surfaces here as 1008, not HTTP 402).
    public static func parseMiniMax(_ data: Data, profile: VoiceProfile, text: String, region: String) throws -> TtsChunk {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TTSError.badResponse("MiniMax: non-JSON response")
        }
        let baseResp = json["base_resp"] as? [String: Any]
        let status = (baseResp?["status_code"] as? Int) ?? 0
        let statusMsg = (baseResp?["status_msg"] as? String) ?? ""
        if status != 0, status == 1008 || isBalanceMessage(statusMsg) {
            throw minimaxBilling(region: region)
        }
        // Invalid / wrong-region key · MiniMax returns this as a non-zero status
        // (1004 auth-fail, 2049 invalid key, …) in a 200 body. Surface it as an
        // auth error so the user is TOLD the key is wrong (e.g. an intl key entered
        // under the China region), instead of the room going silently mute.
        if status != 0, status == 1004 || status == 1001 || status == 2049 || isAuthMessage(statusMsg) {
            throw TtsAuthError(provider: "minimax", message: statusMsg.isEmpty ? "invalid API key" : statusMsg)
        }
        let hex = ((json["data"] as? [String: Any])?["audio"] as? String) ?? (json["audio"] as? String) ?? ""
        guard !hex.isEmpty, let bytes = Data(hexString: hex) else {
            if status != 0, !statusMsg.isEmpty { throw TTSError.badResponse("MiniMax (\(status)): \(statusMsg)") }
            throw TTSError.badResponse("MiniMax returned no audio")
        }
        let model = profile.model.isEmpty ? "speech-2.8-hd" : profile.model
        return TtsChunk(provider: "minimax", model: model, voiceId: profile.voiceId, text: text,
                        mimeType: "audio/mpeg", audioBase64: bytes.base64EncodedString())
    }

    public static func minimaxBilling(region: String) -> TtsBillingError {
        TtsBillingError(provider: "minimax", message: "insufficient balance",
                        upgradeUrl: region == "cn"
                            ? "https://platform.minimaxi.com/user-center/payment/balance"
                            : "https://platform.minimax.io/user-center/payment/balance")
    }

    // MARK: OpenAI (binary MP3)

    public static func openAIRequest(text: String, profile: VoiceProfile, apiKey: String) throws -> URLRequest {
        guard let url = URL(string: "https://api.openai.com/v1/audio/speech") else { throw TTSError.badURL }
        let body: [String: Any] = [
            "model": profile.model.isEmpty ? "gpt-4o-mini-tts" : profile.model,
            "input": text,
            "voice": profile.voiceId.isEmpty ? "marin" : profile.voiceId,
            "response_format": "mp3",
            "speed": min(4, max(0.25, profile.speed)),   // OpenAI's documented window
        ]
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return req
    }

    // MARK: ElevenLabs (binary MP3)

    public static func elevenLabsRequest(text: String, profile: VoiceProfile, apiKey: String) throws -> URLRequest {
        let voice = profile.voiceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? profile.voiceId
        guard let url = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(voice)?output_format=mp3_44100_128")
        else { throw TTSError.badURL }
        let body: [String: Any] = ["text": text,
                                   "model_id": profile.model.isEmpty ? "eleven_multilingual_v2" : profile.model]
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(apiKey, forHTTPHeaderField: "xi-api-key")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return req
    }

    public static func elevenLabsBilling() -> TtsBillingError {
        TtsBillingError(provider: "elevenlabs", message: "insufficient credits",
                        upgradeUrl: "https://elevenlabs.io/pricing")
    }

    public static func isElevenLabsCreditError(_ text: String) -> Bool {
        text.range(of: #"(?i)quota_exceeded|insufficient_credit|out of credits|paid_plan_required|library voices"#,
                   options: .regularExpression) != nil
    }

    public static func isBalanceMessage(_ s: String) -> Bool {
        s.range(of: #"(?i)insufficient[ _-]?(balance|quota|credit|fund)|余额不足"#, options: .regularExpression) != nil
    }

    /// An invalid / unauthorized / wrong-region API-key message (any provider).
    public static func isAuthMessage(_ s: String) -> Bool {
        s.range(of: #"(?i)invalid.*(api.?key|token)|unauthor|authenticat|api.?key.*invalid|forbidden|鉴权|无效.*(密钥|key)|密钥.*无效|token.*invalid"#,
                options: .regularExpression) != nil
    }
}

public enum TTSError: Error, Equatable { case badURL, badResponse(String), noKey }

extension Data {
    /// Decode a hex string ("4d50…") to bytes — MiniMax returns audio as hex.
    init?(hexString: String) {
        let chars = Array(hexString)
        guard chars.count % 2 == 0 else { return nil }
        var bytes = [UInt8](); bytes.reserveCapacity(chars.count / 2)
        var i = 0
        while i < chars.count {
            guard let hi = chars[i].hexDigitValue, let lo = chars[i + 1].hexDigitValue else { return nil }
            bytes.append(UInt8(hi << 4 | lo)); i += 2
        }
        self = Data(bytes)
    }
}
