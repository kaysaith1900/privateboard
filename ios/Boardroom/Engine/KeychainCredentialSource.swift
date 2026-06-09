import Foundation
import GRDB
import BoardroomAI
import BoardroomVoice
import BoardroomStorage

/// Resolves the single active LLM / voice credential at call time — the on-device
/// `LLMCredentialSource` + `VoiceCredentialSource`. Non-secret metadata
/// (`prefs.active_llm_credential_id` → `llm_credentials.provider`) lives in the
/// GRDB DB; the raw API key lives in the Keychain (`CredentialStore`), keyed by
/// the credential id. Mirrors the desktop single-active-credential invariant
/// (availability.ts `getProviderKeyState`) — minus the desktop's AES-from-username
/// blob, which doesn't survive to iOS.
struct EngineCredentialSource: LLMCredentialSource, VoiceCredentialSource {
    let db: BoardroomDB
    let keychain: CredentialStore

    // MARK: LLM

    func activeLLMCredential() -> (carrier: LLMCarrier, apiKey: String)? {
        guard let (id, provider) = activeCredential(prefsColumn: "active_llm_credential_id", table: "llm_credentials"),
              let carrier = LLMCarrier(rawValue: provider),
              let key = keychain.key(.llm, id: id) else { return nil }
        return (carrier, key)
    }

    // MARK: Voice

    func voiceKey(_ provider: VoiceProviderKind) -> String? {
        // Prefer the active voice credential when it matches the requested provider.
        if let (id, prov) = activeCredential(prefsColumn: "active_voice_credential_id", table: "voice_credentials"),
           prov == provider.rawValue, let key = keychain.key(.voice, id: id) {
            return key
        }
        // Fallback · the active pointer is unset / dangling / points at a different
        // provider (common right after the user REPLACES a key). Use the newest stored
        // credential for THIS provider so the room isn't silent while the credential
        // exists in the keychain (and the preview, reading it directly, works).
        let id: String? = (try? db.pool.read { conn in
            try String.fetchOne(conn, sql:
                "SELECT id FROM voice_credentials WHERE provider = ? ORDER BY updated_at DESC LIMIT 1",
                arguments: [provider.rawValue])
        }) ?? nil
        guard let cid = id else { return nil }
        return keychain.key(.voice, id: cid)
    }

    var minimaxRegion: String {
        (try? db.pool.read { try String.fetchOne($0, sql: "SELECT minimax_region FROM prefs WHERE id = 1") }) .flatMap { $0 } ?? "cn"
    }

    // MARK: shared resolution

    /// (credentialId, provider) for the active credential in `table`, per the
    /// `prefs.<prefsColumn>` pointer. nil when unset / dangling.
    private func activeCredential(prefsColumn: String, table: String) -> (id: String, provider: String)? {
        try? db.pool.read { conn in
            guard let id = try String.fetchOne(conn, sql: "SELECT \(prefsColumn) FROM prefs WHERE id = 1"),
                  let provider = try String.fetchOne(conn, sql: "SELECT provider FROM \(table) WHERE id = ?", arguments: [id])
            else { return nil }
            return (id, provider)
        } ?? nil
    }
}
