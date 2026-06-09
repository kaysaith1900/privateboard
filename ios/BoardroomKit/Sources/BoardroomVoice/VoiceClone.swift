import Foundation

/// MiniMax + ElevenLabs voice-cloning REST adapters · the Swift port of
/// `src/voice/clone.ts`. Both providers take a short audio sample (10s–3min) +
/// a label and return a `voice_id` that plugs straight back into the t2a_v2 /
/// text-to-speech pipelines (the same `VoiceProfile.voiceId` the engine reads).
///
///  · MiniMax · two-step: upload to `/v1/files/upload`, then `/v1/voice_clone`
///    with the returned `file_id`. Group ID is read from the JWT key's `GroupID`
///    claim, or supplied explicitly when the key is the legacy `ApiKey` form.
///  · ElevenLabs · single-step IVC via multipart POST to `/v1/voices/add`. PVC
///    is intentionally unsupported (needs a 30-min sample + web verification).
public enum VoiceCloneError: Error, Equatable {
    case audioTooShort
    case audioTooLong
    case missingGroupId
    case providerAuth
    case providerQuota
    case providerInvalidVoiceId
    case unsupportedProvider
    case providerUnknown(String)

    /// Stable code string · mirrors `CloneErrorCode` so the UI can map messages.
    public var code: String {
        switch self {
        case .audioTooShort: return "audio_too_short"
        case .audioTooLong: return "audio_too_long"
        case .missingGroupId: return "missing_group_id"
        case .providerAuth: return "provider_auth"
        case .providerQuota: return "provider_quota"
        case .providerInvalidVoiceId: return "provider_invalid_voice_id"
        case .unsupportedProvider: return "unsupported_provider"
        case .providerUnknown: return "provider_unknown"
        }
    }
}

public struct VoiceCloneResult: Sendable, Equatable {
    public let voiceId: String
    public let label: String
    public init(voiceId: String, label: String) { self.voiceId = voiceId; self.label = label }
}

public struct VoiceCloneService: Sendable {
    private static let maxBytes = 20 * 1024 * 1024  // 20MB cap (both providers)
    private static let minBytes = 32 * 1024         // 32KB · catches near-empty files

    let session: URLSession
    public init(session: URLSession = .shared) { self.session = session }

    /// Try to read the MiniMax `GroupID` claim out of a JWT. Returns nil if the
    /// key isn't a JWT or carries no claim (caller raises `missingGroupId`).
    public static func extractMiniMaxGroupId(_ jwt: String) -> String? {
        let parts = jwt.split(separator: ".")
        guard parts.count == 3 else { return nil }
        // base64url → base64 (pad + swap -_ for +/)
        var b64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        for k in ["GroupID", "group_id", "groupId", "g"] {
            if let v = json[k] as? String, !v.trimmingCharacters(in: .whitespaces).isEmpty {
                return v.trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }

    public func clone(provider: VoiceProviderKind, apiKey: String, region: String,
                      audio: Data, filename: String, agentId: String,
                      label: String?, groupId: String?) async throws -> VoiceCloneResult {
        guard audio.count >= Self.minBytes else { throw VoiceCloneError.audioTooShort }
        guard audio.count <= Self.maxBytes else { throw VoiceCloneError.audioTooLong }
        switch provider {
        case .minimax: return try await cloneMiniMax(apiKey: apiKey, region: region, audio: audio,
                                                     filename: filename, agentId: agentId, label: label, groupId: groupId)
        case .elevenlabs: return try await cloneElevenLabs(apiKey: apiKey, audio: audio,
                                                           filename: filename, agentId: agentId, label: label)
        default: throw VoiceCloneError.unsupportedProvider
        }
    }

    // MARK: MiniMax

    private func cloneMiniMax(apiKey: String, region: String, audio: Data, filename: String,
                             agentId: String, label: String?, groupId: String?) async throws -> VoiceCloneResult {
        let gid = (groupId?.trimmingCharacters(in: .whitespaces).isEmpty == false ? groupId!.trimmingCharacters(in: .whitespaces) : nil)
            ?? Self.extractMiniMaxGroupId(apiKey)
        guard let groupId = gid else { throw VoiceCloneError.missingGroupId }
        let base = TTSWire.minimaxBaseURL(region: region)
        let gidEnc = groupId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? groupId

        // Step 1 · upload the sample → file_id
        guard let upURL = URL(string: "\(base)/v1/files/upload?GroupId=\(gidEnc)") else {
            throw VoiceCloneError.providerUnknown("bad upload URL")
        }
        let (body, contentType) = Self.multipart(fields: ["purpose": "voice_clone"],
                                                 fileField: "file", filename: filename,
                                                 mime: Self.mime(for: filename), bytes: audio)
        var upReq = URLRequest(url: upURL, timeoutInterval: 120)
        upReq.httpMethod = "POST"
        upReq.setValue("Bearer \(apiKey)", forHTTPHeaderField: "authorization")
        upReq.setValue(contentType, forHTTPHeaderField: "content-type")
        upReq.httpBody = body
        let (upData, upResp) = try await session.data(for: upReq)
        try Self.checkMiniMaxHTTP(upResp, upData)
        guard let upJson = try? JSONSerialization.jsonObject(with: upData) as? [String: Any],
              let file = upJson["file"] as? [String: Any] else {
            throw VoiceCloneError.providerUnknown("MiniMax upload returned no file")
        }
        // file_id may be a number or string
        let fileId: Any
        if let n = file["file_id"] as? NSNumber { fileId = n }
        else if let s = file["file_id"] as? String, !s.isEmpty { fileId = s }
        else { throw VoiceCloneError.providerUnknown("MiniMax upload returned no file_id") }

        // Step 2 · clone with a client-supplied voice_id (≥8 chars, [A-Za-z0-9_-])
        let voiceId = Self.buildMiniMaxVoiceId(agentId: agentId, label: label)
        guard let cloneURL = URL(string: "\(base)/v1/voice_clone?GroupId=\(gidEnc)") else {
            throw VoiceCloneError.providerUnknown("bad clone URL")
        }
        var cloneReq = URLRequest(url: cloneURL, timeoutInterval: 120)
        cloneReq.httpMethod = "POST"
        cloneReq.setValue("Bearer \(apiKey)", forHTTPHeaderField: "authorization")
        cloneReq.setValue("application/json", forHTTPHeaderField: "content-type")
        cloneReq.httpBody = try? JSONSerialization.data(withJSONObject: [
            "file_id": fileId,
            "voice_id": voiceId,
            "need_noise_reduction": true,
            "need_volume_normalization": true,
        ])
        let (clData, clResp) = try await session.data(for: cloneReq)
        try Self.checkMiniMaxHTTP(clResp, clData)
        let clJson = (try? JSONSerialization.jsonObject(with: clData) as? [String: Any]) ?? [:]
        let baseResp = clJson["base_resp"] as? [String: Any]
        let status = (baseResp?["status_code"] as? NSNumber)?.intValue ?? 0
        if status != 0 {
            let msg = (baseResp?["status_msg"] as? String) ?? "unknown error"
            if status == 1008 || msg.range(of: "insufficient", options: .caseInsensitive) != nil {
                throw VoiceCloneError.providerQuota
            }
            if msg.range(of: "voice[_ ]?id", options: .regularExpression) != nil {
                throw VoiceCloneError.providerInvalidVoiceId
            }
            throw VoiceCloneError.providerUnknown("MiniMax voice_clone failed (\(status)): \(msg)")
        }
        let finalLabel = (label?.trimmingCharacters(in: .whitespaces).isEmpty == false) ? label!.trimmingCharacters(in: .whitespaces) : "Cloned · \(voiceId)"
        return VoiceCloneResult(voiceId: voiceId, label: finalLabel)
    }

    private static func checkMiniMaxHTTP(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse else { return }
        if (200..<300).contains(http.statusCode) { return }
        let text = String(data: data, encoding: .utf8) ?? ""
        if http.statusCode == 401 || http.statusCode == 403 { throw VoiceCloneError.providerAuth }
        if http.statusCode == 402 || text.range(of: "insufficient", options: .caseInsensitive) != nil { throw VoiceCloneError.providerQuota }
        throw VoiceCloneError.providerUnknown("MiniMax HTTP \(http.statusCode)")
    }

    private static func buildMiniMaxVoiceId(agentId: String, label: String?) -> String {
        let ts = String(Int(Date().timeIntervalSince1970 * 1000), radix: 36)
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        let sanitized = String((label ?? "").unicodeScalars.filter { allowed.contains($0) }.map(Character.init).prefix(16))
        if sanitized.count >= 2 { return "\(sanitized)_\(ts)" }
        let alnum = CharacterSet.alphanumerics
        let safeAgent = String(agentId.unicodeScalars.filter { alnum.contains($0) }.map(Character.init).prefix(8))
        return "pb_\(safeAgent.isEmpty ? "director" : safeAgent)_\(ts)"
    }

    // MARK: ElevenLabs (IVC)

    private func cloneElevenLabs(apiKey: String, audio: Data, filename: String,
                                agentId: String, label: String?) async throws -> VoiceCloneResult {
        let name = (label?.trimmingCharacters(in: .whitespaces).isEmpty == false) ? label!.trimmingCharacters(in: .whitespaces) : "Cloned · \(String(agentId.prefix(8)))"
        guard let url = URL(string: "https://api.elevenlabs.io/v1/voices/add") else {
            throw VoiceCloneError.providerUnknown("bad URL")
        }
        let (body, contentType) = Self.multipart(fields: ["name": name],
                                                 fileField: "files", filename: filename,
                                                 mime: Self.mime(for: filename), bytes: audio)
        var req = URLRequest(url: url, timeoutInterval: 120)
        req.httpMethod = "POST"
        req.setValue(apiKey, forHTTPHeaderField: "xi-api-key")
        req.setValue(contentType, forHTTPHeaderField: "content-type")
        req.httpBody = body
        let (data, resp) = try await session.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let text = String(data: data, encoding: .utf8) ?? ""
            if http.statusCode == 401 { throw VoiceCloneError.providerAuth }
            if http.statusCode == 402 || text.range(of: "paid_plan_required|quota_exceeded|insufficient", options: .regularExpression) != nil {
                throw VoiceCloneError.providerQuota
            }
            throw VoiceCloneError.providerUnknown("ElevenLabs HTTP \(http.statusCode)")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let voiceId = json["voice_id"] as? String, !voiceId.isEmpty else {
            throw VoiceCloneError.providerUnknown("ElevenLabs returned no voice_id")
        }
        return VoiceCloneResult(voiceId: voiceId, label: name)
    }

    // MARK: Multipart

    /// Build a `multipart/form-data` body (one file + text fields). Returns the
    /// body bytes and the matching `Content-Type` header value.
    private static func multipart(fields: [String: String], fileField: String, filename: String,
                                  mime: String, bytes: Data) -> (Data, String) {
        let boundary = "----pb-vc-\(UUID().uuidString)"
        var body = Data()
        let crlf = "\r\n"
        func append(_ s: String) { body.append(s.data(using: .utf8)!) }
        for (k, v) in fields {
            append("--\(boundary)\(crlf)")
            append("Content-Disposition: form-data; name=\"\(k)\"\(crlf)\(crlf)")
            append("\(v)\(crlf)")
        }
        append("--\(boundary)\(crlf)")
        append("Content-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(filename)\"\(crlf)")
        append("Content-Type: \(mime)\(crlf)\(crlf)")
        body.append(bytes)
        append(crlf)
        append("--\(boundary)--\(crlf)")
        return (body, "multipart/form-data; boundary=\(boundary)")
    }

    private static func mime(for name: String) -> String {
        let lower = name.lowercased()
        if lower.hasSuffix(".mp3") { return "audio/mpeg" }
        if lower.hasSuffix(".m4a") { return "audio/mp4" }
        if lower.hasSuffix(".wav") { return "audio/wav" }
        if lower.hasSuffix(".caf") { return "audio/x-caf" }
        if lower.hasSuffix(".webm") { return "audio/webm" }
        if lower.hasSuffix(".ogg") { return "audio/ogg" }
        return "application/octet-stream"
    }
}
