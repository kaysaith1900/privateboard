import Foundation
import BoardroomCore
import BoardroomAI

/// Dream cycle (`dream.ts`) — periodic memory metabolism. After enough adjourns
/// for an agent, consolidate its short-tier memories: heuristic decay → LLM
/// cluster near-duplicates → merge each cluster to one canonical memory →
/// resolve contradictions (newer supersedes older) → promote durable memories
/// short→long. All LLM steps use the cheap utility model + degrade gracefully
/// (a failed step is skipped). The chair-only `user_long_memory` harvest (Step 6)
/// is a later sub-phase (P4-7c).
public enum Dream {
    static let clusterMinSize = 6
    static let clusterMaxSize = 60
    static let promoteMinProvenance = 3
    static let promoteMinAgeMs = 7 * 24 * 60 * 60 * 1000
    static let promoteMinConfidence = 0.6

    // Step-6 (chair-only) user_long_memory harvest gate constants.
    static let userLongHarvestMinLong = 2
    static let userLongHarvestMinNewPromoted = 1
    static let userLongHarvestMinShortHigh = 6
    static let userLongShortConfFloor = 0.6
    static let userLongHarvestInputCap = 40
    static let userLongCap = 30

    /// Run one dream cycle for a single agent. decay → cluster → merge →
    /// conflict-resolve → promote, plus (chair only) Step 6 user_long harvest +
    /// the `agent_dreams` audit row. Counts are tracked for the audit; LLM steps
    /// degrade gracefully when no utility model is reachable (decay + promote
    /// still run, mirroring dream.ts).
    public static func runCycle(router: EngineRouter, store: MemoryStore, agentId: String,
                                isChair: Bool = false, userName: String, nowMs: Int,
                                userLong: UserLongMemoryStore? = nil, audit: DreamAuditStore? = nil) async {
        let startedAt = nowMs
        let beforeCount = await store.countMemoriesForAgent(agentId)

        // Step 1 · heuristic decay (no LLM).
        let decayed = await store.decayShortTermMemories(agentId: agentId)
        var shortPool = (await store.listTier(agentId: agentId, tier: "short")).filter { !$0.pinned }
        var merged = 0
        var supersededCount = 0
        var promoted = 0
        let utility = router.utilityModelV()

        // Step 2/3 · cluster + merge.
        if let utility, shortPool.count >= clusterMinSize, shortPool.count <= clusterMaxSize {
            let known = Set(shortPool.map(\.id))
            if let raw = try? await router.call(clusterPrompt(shortPool, userName: userName),
                                                modelV: utility, temperature: 0.2, maxTokens: 600) {
                let clusters = parseClusterOutput(raw, known: known)
                let byId = Dictionary(uniqueKeysWithValues: shortPool.map { ($0.id, $0) })
                for cluster in clusters {
                    let sources = cluster.compactMap { byId[$0] }
                    guard sources.count >= 2 else { continue }
                    guard let mergeRaw = try? await router.call(mergePrompt(sources, userName: userName),
                                                                modelV: utility, temperature: 0.2, maxTokens: 200),
                          let mergeOut = parseMergeOutput(mergeRaw) else { continue }
                    let conf = sources.map(\.confidence).max() ?? 0.7
                    let prov = sources.reduce(0) { $0 + $1.provenanceRooms }
                    let tier = sources.contains(where: { $0.tier == "long" }) ? "long" : "short"
                    let created = sources.map(\.createdAt).max() ?? nowMs
                    let id = await store.insertConsolidatedMemory(
                        agentId: agentId, content: mergeOut.content, kind: mergeOut.kind,
                        confidence: conf, provenanceRooms: prov, tier: tier, createdAt: created,
                        consolidatedFrom: sources.map(\.id))
                    supersededCount += await store.markSuperseded(sources.map(\.id), by: id)
                    merged += 1
                }
            }
            shortPool = (await store.listTier(agentId: agentId, tier: "short")).filter { !$0.pinned }
        }

        // Step 4 · conflict resolve.
        if let utility, shortPool.count >= 2, shortPool.count <= clusterMaxSize {
            let known = Set(shortPool.map(\.id))
            if let raw = try? await router.call(conflictPrompt(shortPool, userName: userName),
                                                modelV: utility, temperature: 0.2, maxTokens: 400) {
                for pair in parseConflictOutput(raw, known: known) {
                    supersededCount += await store.markSuperseded([pair.older], by: pair.newer)
                }
            }
        }

        // Step 5 · promote durable short memories to long (no LLM).
        let fresh = (await store.listTier(agentId: agentId, tier: "short")).filter { !$0.pinned }
        let ageCutoff = nowMs - promoteMinAgeMs
        let promote = fresh.filter { $0.provenanceRooms >= promoteMinProvenance && $0.createdAt <= ageCutoff && $0.confidence >= promoteMinConfidence }
        if !promote.isEmpty { promoted = await store.promoteToLong(promote.map(\.id)) }

        // Step 6 · chair-only harvest into the user_long_memory sanctuary.
        if isChair, let utility, let userLong {
            await harvestUserLong(router: router, store: store, userLong: userLong, utility: utility,
                                  agentId: agentId, userName: userName, promoted: promoted)
        }

        // Audit row (`recordDream`). resetAdjournCounter is handled by the
        // DreamCounter caller / boot sweep, not here.
        let afterCount = await store.countMemoriesForAgent(agentId)
        await audit?.recordDream(agentId: agentId, startedAt: startedAt, finishedAt: nowMs,
                                 beforeCount: beforeCount, afterCount: afterCount,
                                 decayed: decayed, merged: merged, promoted: promoted,
                                 superseded: supersededCount,
                                 notes: utility != nil ? "utility=\(utility!.rawValue)" : "no-utility-model · LLM steps skipped")
    }

    // MARK: Step 6 · chair-only user_long_memory harvest (port of dream.ts §Step 6)

    static func harvestUserLong(router: EngineRouter, store: MemoryStore, userLong: UserLongMemoryStore,
                                utility: ModelV, agentId: String, userName: String, promoted: Int) async {
        let chairLong = await store.listTier(agentId: agentId, tier: "long")
        // Cold-start fallback pool · high-confidence short-tier chair memories.
        let chairShortHigh = (await store.listTier(agentId: agentId, tier: "short"))
            .filter { $0.confidence >= userLongShortConfFloor && !$0.pinned }
        let eligible = chairLong.count >= userLongHarvestMinLong
            || promoted >= userLongHarvestMinNewPromoted
            || chairShortHigh.count >= userLongHarvestMinShortHigh
        guard eligible else { return }

        let existing = await userLong.listActiveUserLong()
        let pool = Array((chairLong + chairShortHigh.sorted { $0.confidence > $1.confidence })
            .prefix(userLongHarvestInputCap))
        guard let raw = try? await router.call(
            [LLMMessage(role: .user, content: harvestPrompt(userName: userName, chairLong: pool, existing: existing))],
            modelV: utility, temperature: 0.4, maxTokens: 1200) else { return }
        let harvest = parseHarvestOutput(raw)

        for t in harvest.newTags {
            _ = await userLong.insertUserLong(label: t.label, claim: t.claim, confidence: t.confidence, provenanceRooms: t.provenanceRooms)
        }
        for r in harvest.reinforce where await userLong.getUserLong(r) != nil {
            await userLong.bumpUserLongProvenance(r)
        }
        for s in harvest.supersede {
            guard await userLong.getUserLong(s.oldId) != nil else { continue }
            if let freshId = await userLong.insertUserLong(label: s.newTag.label, claim: s.newTag.claim,
                                                           confidence: s.newTag.confidence, provenanceRooms: s.newTag.provenanceRooms) {
                await userLong.markUserLongSuperseded(oldId: s.oldId, newId: freshId)
            }
        }
        if await userLong.countActiveUserLong() > userLongCap {
            _ = await userLong.pruneActiveUserLongToCap(userLongCap)
        }
    }

    struct HarvestTag { let label: String; let claim: String; let confidence: Double; let provenanceRooms: Int }
    struct HarvestSupersede { let oldId: String; let newTag: HarvestTag }
    struct HarvestResult { var newTags: [HarvestTag]; var reinforce: [String]; var supersede: [HarvestSupersede] }

    static func harvestPrompt(userName: String, chairLong: [MemoryRow], existing: [UserLongRow]) -> String {
        let existingBlock = existing.isEmpty
            ? "(no existing tags yet)"
            : existing.map { "[\($0.id)] \($0.label) · \($0.claim) · provenance=\($0.provenanceRooms)" }.joined(separator: "\n")
        let chairBlock = chairLong.isEmpty
            ? "(no chair memories yet)"
            : chairLong.map { "· (\($0.kind), conf=\(String(format: "%.2f", $0.confidence)), rooms=\($0.provenanceRooms), tier=\($0.tier)) \($0.content)" }.joined(separator: "\n")
        return [
            "You are reviewing the chair's high-conviction memories about \(userName) to extract durable, tag-shaped abstractions that should live in a separate sanctuary table (never decayed, only displaced on direct contradiction).",
            "",
            "## Existing user-long-memory tags",
            existingBlock,
            "",
            "## Chair memories about \(userName) (mixed pool · prefer long-tier or high-confidence short-tier entries when proposing tags)",
            chairBlock,
            "",
            "## Output",
            "Return ONE JSON object with exactly three arrays, nothing else (no prose, no fences):",
            "{",
            "  \"newTags\": [",
            "    { \"label\": \"short-1-to-3-words\", \"claim\": \"short sentence ≤240 chars\", \"confidence\": 0.0-1.0, \"provenanceRooms\": int>=1 }",
            "  ],",
            "  \"reinforce\": [",
            "    { \"id\": \"existing-tag-id-from-the-list-above\" }",
            "  ],",
            "  \"supersede\": [",
            "    { \"oldId\": \"existing-tag-id\", \"newTag\": { \"label\": \"...\", \"claim\": \"...\", \"confidence\": 0.0-1.0, \"provenanceRooms\": int>=1 } }",
            "  ]",
            "}",
            "",
            "## Rules",
            "· newTags · only propose tags representing abstract, durable patterns about \(userName) that aren't already covered by an existing tag. Each tag must be supported by at least TWO chair memories. Label is short (1-3 words, lowercase-hyphenated), claim is a complete sentence the chair could use as a working hypothesis (\"User is a founder who reasons from first principles and refuses corporate vocabulary\").",
            "· reinforce · only when an existing tag's claim is clearly supported by NEW chair memories (memories that weren't already counted toward its provenance).",
            "· supersede · ONLY on direct contradiction. The existing tag's claim must be NEGATED by evidence in the chair memories. Partial overlap, refinement, or different framing is NOT contradiction — leave those alone.",
            "· Output empty arrays if nothing applies. Conservative is better than chatty — these tags persist forever unless contradicted.",
        ].joined(separator: "\n")
    }

    static func parseHarvestTag(_ raw: Any?) -> HarvestTag? {
        guard let o = raw as? [String: Any] else { return nil }
        let label = (o["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let claim = (o["claim"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !label.isEmpty, !claim.isEmpty, label.count <= 32, claim.count <= 240 else { return nil }
        var confidence = 0.7
        if let c = o["confidence"] as? Double, c.isFinite { confidence = max(0, min(1, c)) }
        else if let c = (o["confidence"] as? NSNumber)?.doubleValue, c.isFinite { confidence = max(0, min(1, c)) }
        var prov = 1
        if let p = o["provenanceRooms"] as? Int { prov = max(1, p) }
        else if let p = (o["provenanceRooms"] as? NSNumber)?.intValue { prov = max(1, p) }
        return HarvestTag(label: label, claim: claim, confidence: confidence, provenanceRooms: prov)
    }

    static func parseHarvestOutput(_ raw: String) -> HarvestResult {
        var out = HarvestResult(newTags: [], reinforce: [], supersede: [])
        let s = stripFence(raw)
        guard !s.isEmpty, let d = s.data(using: .utf8),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return out }
        if let arr = j["newTags"] as? [Any] { for r in arr { if let t = parseHarvestTag(r) { out.newTags.append(t) } } }
        if let arr = j["reinforce"] as? [Any] {
            for r in arr {
                guard let o = r as? [String: Any], let id = (o["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty else { continue }
                out.reinforce.append(id)
            }
        }
        if let arr = j["supersede"] as? [Any] {
            for r in arr {
                guard let o = r as? [String: Any],
                      let oldId = (o["oldId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !oldId.isEmpty,
                      let newTag = parseHarvestTag(o["newTag"]) else { continue }
                out.supersede.append(HarvestSupersede(oldId: oldId, newTag: newTag))
            }
        }
        return out
    }

    // MARK: prompts (verbatim · dream-prompts.ts) + parsers

    static func fmt(_ m: MemoryRow) -> String {
        let flag = m.tier == "long" ? " [stable]" : ""
        return "\(m.id)\(flag) (\(m.kind), conf=\(String(format: "%.2f", m.confidence))): \(m.content)"
    }

    static func clusterPrompt(_ memories: [MemoryRow], userName: String) -> [LLMMessage] {
        let lines = memories.map(fmt).joined(separator: "\n")
        let system = """
You are processing one agent's accumulated long-term memories about \(userName).
Your job NOW is to find near-duplicates — memories that, if collapsed into one, would lose no information.

Output STRICT JSON · a 2-D array of memory ids forming clusters. Singletons MUST NOT appear (any id you don't list is implicitly its own cluster).

Examples:
Input lines · two are near-duplicates ("prefers concise" + "dislikes long lists"), one stands alone.
Output: [["m1","m2"]]

Input lines · all distinct.
Output: []

Hard rules:
· Cluster only when BOTH would lose nothing if collapsed. Same theme but different granularity (e.g. "uses Python" vs "prefers typed Python over dynamic JS") are NOT a cluster.
· Output ONLY a JSON array. No prose, no code fence, no explanation.
· Empty array `[]` is a valid + correct answer when nothing duplicates.
"""
        let user = "─── \(memories.count) MEMORIES ───\n\(lines)\n\n─── YOUR CLUSTERS (JSON) ───"
        return [LLMMessage(role: .system, content: system), LLMMessage(role: .user, content: user)]
    }

    static func mergePrompt(_ cluster: [MemoryRow], userName: String) -> [LLMMessage] {
        let lines = cluster.map(fmt).joined(separator: "\n")
        let system = """
You are collapsing \(cluster.count) near-duplicate memories about \(userName) into ONE canonical memory.

Output STRICT JSON · a single object: {"content": "<sentence in the same first-person assertion style>", "kind": "<one of: fact|observation|preference|goal>"}

Examples:
Input: two memories saying "user prefers concise output" + "user dislikes long lists with bullet padding"
Output: {"content": "\(userName) prefers concise output, never padded lists", "kind": "preference"}

Hard rules:
· The merged sentence must preserve every distinct claim across the sources — pick wording that includes both, don't average them.
· Match the language the source memories were written in (English, Chinese, etc.).
· Output ONLY the JSON object. No prose, no code fence.
· Maximum 200 characters in `content`.
"""
        let user = "─── CLUSTER (\(cluster.count) memories) ───\n\(lines)\n\n─── YOUR MERGED MEMORY (JSON) ───"
        return [LLMMessage(role: .system, content: system), LLMMessage(role: .user, content: user)]
    }

    static func conflictPrompt(_ memories: [MemoryRow], userName: String) -> [LLMMessage] {
        let fmtDate: (Int) -> String = { ms in
            let d = Date(timeIntervalSince1970: Double(ms) / 1000)
            let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC"); f.dateFormat = "yyyy-MM-dd"
            return f.string(from: d)
        }
        let lines = memories.map { "\($0.id) (\(fmtDate($0.createdAt))): \($0.content)" }.joined(separator: "\n")
        let system = """
You are looking for direct contradictions among \(userName)'s long-term memories.
A "contradiction" is a pair where the newer memory makes a claim that's incompatible with what the older one said — i.e., \(userName)'s view evolved.

Output STRICT JSON · array of {"older": "<id>", "newer": "<id>", "why": "<brief reason>"}.

Examples:
Two memories · old "user is exploring crypto" + newer "user has decided crypto isn't relevant".
Output: [{"older": "m3", "newer": "m9", "why": "exploration → rejected"}]

Two memories · "user is in fintech" + "user prefers concise output". Different topics — NOT a contradiction.
Output: []

Hard rules:
· Only pair memories that make incompatible claims about the SAME thing. Different topics ≠ contradiction.
· Newer always wins — older goes in "older", newer in "newer". Use the date stamps to determine ordering.
· Output ONLY a JSON array. No prose, no code fence.
· Empty array `[]` is the correct answer when nothing contradicts.
"""
        let user = "─── \(memories.count) MEMORIES (id, date, content) ───\n\(lines)\n\n─── YOUR CONTRADICTIONS (JSON) ───"
        return [LLMMessage(role: .system, content: system), LLMMessage(role: .user, content: user)]
    }

    private static func stripFence(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        s = s.replacingOccurrences(of: "^```(?:json)?\\s*", with: "", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "```\\s*$", with: "", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func parseClusterOutput(_ raw: String, known: Set<String>) -> [[String]] {
        let s = stripFence(raw); guard !s.isEmpty, let d = s.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: d) as? [Any] else { return [] }
        var out: [[String]] = []
        for c in arr {
            guard let ids = c as? [Any] else { continue }
            let valid = Array(Set(ids.compactMap { $0 as? String }.filter { known.contains($0) }))
            if valid.count >= 2 { out.append(valid) }
        }
        return out
    }

    static func parseMergeOutput(_ raw: String) -> (content: String, kind: String)? {
        let s = stripFence(raw); guard !s.isEmpty, let d = s.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        let content = (o["content"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !content.isEmpty, content.count <= 200 else { return nil }
        let kindRaw = (o["kind"] as? String) ?? "fact"
        let kind = ["fact", "observation", "preference", "goal"].contains(kindRaw) ? kindRaw : "fact"
        return (content, kind)
    }

    static func parseConflictOutput(_ raw: String, known: Set<String>) -> [(older: String, newer: String)] {
        let s = stripFence(raw); guard !s.isEmpty, let d = s.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: d) as? [Any] else { return [] }
        var out: [(older: String, newer: String)] = []
        for item in arr {
            guard let o = item as? [String: Any],
                  let older = o["older"] as? String, let newer = o["newer"] as? String,
                  !older.isEmpty, !newer.isEmpty, older != newer,
                  known.contains(older), known.contains(newer) else { continue }
            out.append((older: older, newer: newer))
        }
        return out
    }
}

/// Process-local per-agent adjourn counter (port of dream.ts `adjournCounter`).
/// Reset on process restart; the boot sweep (over-ceiling agents) is the safety
/// net. Threshold: director 5, chair (moderator) 3.
public actor DreamCounter {
    public static let shared = DreamCounter()
    private var counts: [String: Int] = [:]

    /// Increment + return true when the agent crossed its trigger threshold.
    public func bump(agentId: String, isChair: Bool) -> Bool {
        let next = (counts[agentId] ?? 0) + 1
        counts[agentId] = next
        return next >= (isChair ? 3 : 5)
    }
    public func reset(agentId: String) { counts[agentId] = 0 }
}
