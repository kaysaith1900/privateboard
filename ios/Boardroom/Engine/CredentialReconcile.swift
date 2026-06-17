import Foundation
import GRDB
import BoardroomStorage
import BoardroomAI

/// SIM-swap credential memory · the Swift port of the desktop `reconcile-models.ts`
/// + `reconcile-voices.ts` + the per-agent provider buckets in `storage/agents.ts`.
///
/// Each agent carries two JSON maps (migration 050, already on iOS but previously
/// unused): `model_by_provider_json` = { LLM carrier → modelV } and
/// `voice_by_provider_json` = { voice provider → voice profile }. When the active
/// LLM or voice key switches, we snapshot every agent's CURRENT config into
/// `bucket[priorProvider]` then RESTORE from `bucket[newProvider]` — so returning
/// to a key brings back exactly the models/voices the user had set under it.
extension LoopbackServer {

    enum VoiceReconcileReason { case firstKey, providerSwitch }

    // MARK: Active-credential lookups

    func activeLLMCarrier() -> LLMCarrier? {
        let prov: String? = (try? db.pool.read { conn -> String? in
            guard let cid = try String.fetchOne(conn, sql: "SELECT active_llm_credential_id FROM prefs WHERE id = 1") else { return nil }
            return try String.fetchOne(conn, sql: "SELECT provider FROM llm_credentials WHERE id = ?", arguments: [cid])
        }) ?? nil
        return prov.flatMap(LLMCarrier.init(rawValue:))
    }

    func activeVoiceProviderString() -> String? {
        (try? db.pool.read { conn -> String? in
            guard let cid = try String.fetchOne(conn, sql: "SELECT active_voice_credential_id FROM prefs WHERE id = 1") else { return nil }
            return try String.fetchOne(conn, sql: "SELECT provider FROM voice_credentials WHERE id = ?", arguments: [cid])
        }) ?? nil
    }

    // MARK: Model bucket  ({ carrier → modelV })

    func modelBucket(_ conn: Database, _ id: String) -> [String: String] {
        let raw = (try? String.fetchOne(conn, sql: "SELECT model_by_provider_json FROM agents WHERE id = ?", arguments: [id])) ?? nil
        guard let raw, let d = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        for (k, v) in obj {
            guard LLMCarrier(rawValue: k) != nil, let s = (v as? String)?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { continue }
            out[k] = s
        }
        return out
    }

    func writeModelBucketEntry(_ conn: Database, _ id: String, _ carrier: LLMCarrier, _ modelV: String) throws {
        let v = modelV.trimmingCharacters(in: .whitespaces)
        guard !v.isEmpty else { return }
        var b = modelBucket(conn, id)
        if b[carrier.rawValue] == v { return }   // idempotent self-write guard
        b[carrier.rawValue] = v
        try setModelBucket(conn, id, b)
    }

    func deleteModelBucketEntry(_ conn: Database, _ id: String, _ carrier: LLMCarrier) throws {
        var b = modelBucket(conn, id)
        guard b[carrier.rawValue] != nil else { return }
        b.removeValue(forKey: carrier.rawValue)
        try setModelBucket(conn, id, b)
    }

    private func setModelBucket(_ conn: Database, _ id: String, _ b: [String: String]) throws {
        let json: String? = b.isEmpty ? nil : String(data: try JSONSerialization.data(withJSONObject: b), encoding: .utf8)
        try conn.execute(sql: "UPDATE agents SET model_by_provider_json = ?, updated_at = ? WHERE id = ?",
                         arguments: [json, Int(Date().timeIntervalSince1970 * 1000), id])
    }

    // MARK: Voice bucket  ({ provider → profile })

    func voiceBucket(_ conn: Database, _ id: String) -> [String: [String: Any]] {
        let raw = (try? String.fetchOne(conn, sql: "SELECT voice_by_provider_json FROM agents WHERE id = ?", arguments: [id])) ?? nil
        guard let raw, let d = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return [:] }
        var out: [String: [String: Any]] = [:]
        for (k, v) in obj {
            guard k == "minimax" || k == "elevenlabs", let prof = v as? [String: Any],
                  (prof["provider"] as? String) == k, !((prof["voiceId"] as? String) ?? "").isEmpty else { continue }
            out[k] = prof
        }
        return out
    }

    func writeVoiceBucketEntry(_ conn: Database, _ id: String, _ provider: String, _ voice: [String: Any]) throws {
        guard provider == "minimax" || provider == "elevenlabs",
              (voice["provider"] as? String) == provider,
              !((voice["voiceId"] as? String) ?? "").isEmpty else { return }
        var b = voiceBucket(conn, id)
        b[provider] = voice
        try setVoiceBucket(conn, id, b)
    }

    func deleteVoiceBucketEntry(_ conn: Database, _ id: String, _ provider: String) throws {
        var b = voiceBucket(conn, id)
        guard b[provider] != nil else { return }
        b.removeValue(forKey: provider)
        try setVoiceBucket(conn, id, b)
    }

    private func setVoiceBucket(_ conn: Database, _ id: String, _ b: [String: [String: Any]]) throws {
        let json: String? = b.isEmpty ? nil : String(data: try JSONSerialization.data(withJSONObject: b), encoding: .utf8)
        try conn.execute(sql: "UPDATE agents SET voice_by_provider_json = ?, updated_at = ? WHERE id = ?",
                         arguments: [json, Int(Date().timeIntervalSince1970 * 1000), id])
    }

    // MARK: Reconcile · models

    /// Snapshot each agent's current model into `bucket[priorCarrier]`, then
    /// restore `bucket[newCarrier]` (reachability-checked; stale entries dropped)
    /// or fall back to the carrier's default model. Clears models when no carrier.
    func reconcileAgentModels(priorCarrier: LLMCarrier?) {
        let carrier = activeLLMCarrier()
        let reachable = Set(Availability.reachable(active: carrier).map { $0.modelV.rawValue })
        let primary = Availability.defaultModel(active: carrier)?.rawValue
        let now = Int(Date().timeIntervalSince1970 * 1000)
        // A DYNAMIC model id (fetched from an aggregator catalog) has no `ModelV`
        // case, so it's absent from `reachable` — but an aggregator carrier
        // (openrouter / bai) routes any string, so it IS usable. Treat such ids as
        // reachable here, otherwise Phase 2 would reroll the user's pick to a fast
        // default on the next reconcile (the "works once then reverts" bug).
        func modelReachable(_ v: String) -> Bool {
            if reachable.contains(v) { return true }
            guard let c = carrier, c.route != .direct, !v.isEmpty else { return false }
            return Registry.meta(id: v) == nil
        }
        try? db.pool.write { conn in
            let rows = try Row.fetchAll(conn, sql: "SELECT id, model_v FROM agents")
            for r in rows {
                let aid = r["id"] as String? ?? ""
                guard !aid.isEmpty else { continue }
                let v = (r["model_v"] as String? ?? "").trimmingCharacters(in: .whitespaces)

                // Phase 1 · snapshot the prior carrier's pick before overwriting.
                if let pc = priorCarrier, !v.isEmpty, pc != carrier {
                    try writeModelBucketEntry(conn, aid, pc, v)
                }

                // Phase 2 · restore from the bucket, else the carrier default.
                if let primary, let carrier {
                    let bucket = modelBucket(conn, aid)
                    let memorised = bucket[carrier.rawValue]
                    let target: String
                    if !v.isEmpty, carrier.route != .direct, Registry.meta(id: v) == nil {
                        // Current pick is a DYNAMIC model the aggregator can route ·
                        // preserve it verbatim, never reroll.
                        target = v
                    } else if let m = memorised, modelReachable(m) {
                        target = m
                    } else {
                        if memorised != nil { try deleteModelBucketEntry(conn, aid, carrier) }
                        // Fresh seat on this carrier · spread the board across the
                        // carrier's FAST pool instead of putting every director +
                        // chair on the single flagship/default. Each seat rolls
                        // independently, so a freshly-configured OpenRouter / B.AI
                        // board reads as a mix (haiku / gpt-mini / gemini-flash …),
                        // not a wall of one model. The pick is memorised below, so
                        // later reconciles restore it rather than reroll. Direct
                        // providers have no pool → keep the `primary` default.
                        target = Availability.pickRandomFastModel(active: carrier)?.rawValue ?? primary
                    }
                    if v == target {
                        if bucket[carrier.rawValue] != target { try writeModelBucketEntry(conn, aid, carrier, target) }
                        continue
                    }
                    try conn.execute(sql: "UPDATE agents SET model_v = ?, updated_at = ? WHERE id = ?", arguments: [target, now, aid])
                    try writeModelBucketEntry(conn, aid, carrier, target)
                } else if !v.isEmpty {
                    // No carrier reachable · clear (Phase 1 already snapshotted).
                    try conn.execute(sql: "UPDATE agents SET model_v = '', updated_at = ? WHERE id = ?", arguments: [now, aid])
                }
            }
            // Keep the user's default model coherent with the active carrier.
            if let primary {
                let curDefault = (try String.fetchOne(conn, sql: "SELECT default_model_v FROM prefs WHERE id = 1")) ?? nil
                if curDefault == nil || !reachable.contains(curDefault!) {
                    try conn.execute(sql: "UPDATE prefs SET default_model_v = ? WHERE id = 1", arguments: [primary])
                }
            }
        }
    }

    // MARK: Reconcile · voices

    /// Snapshot each agent's current voice into `bucket[priorProvider]`, then
    /// restore `bucket[newProvider]` (merging any newer user-tuned dials) or fall
    /// back to a shuffled seed voice. Clears voices when no active provider.
    func reconcileAgentVoices(reason: VoiceReconcileReason, priorProvider: String?) {
        let target = activeVoiceProviderString()
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let dialKeys = ["speed", "pitch", "volume", "emotion"]
        try? db.pool.write { conn in
            let rows = try Row.fetchAll(conn, sql: "SELECT id, voice_json FROM agents")

            // No active provider · snapshot prior, then clear every voice.
            guard let target else {
                for r in rows {
                    let aid = r["id"] as String? ?? ""
                    guard !aid.isEmpty else { continue }
                    let cur = Self.parseVoiceJSON(r["voice_json"] as String?)
                    try self.snapshotPriorVoice(conn, aid, cur, priorProvider, nil)
                    if cur != nil {
                        try conn.execute(sql: "UPDATE agents SET voice_json = NULL, updated_at = ? WHERE id = ?", arguments: [now, aid])
                    }
                }
                return
            }

            // Static seed pool for the new provider (NOT the live MiniMax fetch).
            var pool = LoopbackServer.voiceCatalog(target)
            guard !pool.isEmpty else { return }
            pool.shuffle()

            for (i, r) in rows.enumerated() {
                let aid = r["id"] as String? ?? ""
                guard !aid.isEmpty else { continue }
                let cur = Self.parseVoiceJSON(r["voice_json"] as String?)

                // Phase 1 · snapshot the prior provider's voice before overwriting.
                try self.snapshotPriorVoice(conn, aid, cur, priorProvider, target)

                // Phase 2 · restore.
                let bucket = voiceBucket(conn, aid)
                if let mem = bucket[target] {
                    var profile = mem
                    if let cur { for k in dialKeys where cur[k] != nil { profile[k] = cur[k] } }
                    try self.writeVoiceJSON(conn, aid, profile, now)
                    try writeVoiceBucketEntry(conn, aid, target, profile)
                } else if reason == .firstKey, let cur, (cur["provider"] as? String) == target {
                    // Pre-SIM-swap setup · keep the existing pick, seed the bucket.
                    if bucket[target] == nil { try writeVoiceBucketEntry(conn, aid, target, cur) }
                    continue
                } else {
                    let pick = pool[i % pool.count]
                    var profile: [String: Any] = [
                        "provider": pick["provider"] as? String ?? target,
                        "model": pick["model"] as? String ?? "",
                        "voiceId": pick["voiceId"] as? String ?? "",
                    ]
                    if let cur { for k in dialKeys where cur[k] != nil { profile[k] = cur[k] } }
                    try self.writeVoiceJSON(conn, aid, profile, now)
                    try writeVoiceBucketEntry(conn, aid, target, profile)
                }
            }
        }
    }

    private func snapshotPriorVoice(_ conn: Database, _ id: String, _ cur: [String: Any]?, _ priorProvider: String?, _ target: String?) throws {
        guard let priorProvider, priorProvider != target, let cur,
              (cur["provider"] as? String) == priorProvider,
              priorProvider == "minimax" || priorProvider == "elevenlabs" else { return }
        try writeVoiceBucketEntry(conn, id, priorProvider, cur)
    }

    private func writeVoiceJSON(_ conn: Database, _ id: String, _ profile: [String: Any], _ now: Int) throws {
        let json = String(data: try JSONSerialization.data(withJSONObject: profile), encoding: .utf8)
        try conn.execute(sql: "UPDATE agents SET voice_json = ?, updated_at = ? WHERE id = ?", arguments: [json, now, id])
    }

    private static func parseVoiceJSON(_ raw: String?) -> [String: Any]? {
        guard let raw, let d = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              !((obj["provider"] as? String) ?? "").isEmpty else { return nil }
        return obj
    }
}
