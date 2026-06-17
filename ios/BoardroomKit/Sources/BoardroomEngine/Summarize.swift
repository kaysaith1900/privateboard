import Foundation
import BoardroomCore
import BoardroomAI

/// Round-end summarization (`summarize.ts`) — the L0/L1/L2 ladder that keeps long
/// rooms' divergence alive. After round N: generate the L1 for round N-4 (when it
/// drops out of the L0 window), and fold round N-9's L1 into the rolling L2.
/// Fire-and-forget; utility model; prompts engineered to PROTECT divergence (never
/// "consensus emerged"). Re-inserted into the director prompt as `summaryPreamble`.
public enum Summarize {
    public static let l0Keep = 5
    public static let l1Back = 10
    /// Soft token cap for the assembled director-history segment (port of
    /// HISTORY_TOKEN_CAP). Past this, buildDirectorHistory trims the oldest
    /// non-anchor messages so long rooms don't balloon into context rot.
    public static let historyTokenCap = 16_000
    /// Tighter cap for the FIRST director turn after a COLD re-entry (fresh actor ·
    /// app relaunch). A full 16k-token prompt is what makes re-opening an existing
    /// room feel slow (high time-to-first-token) vs a new room. The trimmed-away
    /// older rounds survive as L1/L2 summaries in the preamble, so context isn't
    /// lost — only this one turn leans more on the summary. Subsequent turns in the
    /// resumed round revert to historyTokenCap.
    public static let resumeHistoryTokenCap = 6_000

    public static func runRoundEnd(router: EngineRouter, store: RoomStore, summary: SummaryStore,
                                   roomId: String, roundJustEnded: Int) async {
        let l1Target = roundJustEnded - l0Keep + 1
        guard l1Target >= 1 else { return }
        if await summary.getL1Summary(roomId: roomId, roundNum: l1Target) == nil {
            await generateL1(router: router, store: store, summary: summary, roomId: roomId, roundNum: l1Target)
        }
        let l2Target = roundJustEnded - l1Back + 1
        guard l2Target >= 1 else { return }
        if let l1 = await summary.getL1Summary(roomId: roomId, roundNum: l2Target) {
            await foldL2(router: router, summary: summary, roomId: roomId, newRoundNum: l2Target, newL1Body: l1)
            await summary.deleteL1Summary(roomId: roomId, roundNum: l2Target)
        }
    }

    static func generateL1(router: EngineRouter, store: RoomStore, summary: SummaryStore,
                           roomId: String, roundNum: Int) async {
        let all = await store.recentMessages(roomId, limit: 400)
        let inRound = all.filter { $0.roundNum == roundNum }
        guard !inRound.isEmpty else { return }
        let cast = await store.directors(roomId)
        let chair = await store.chair(roomId)
        let userName = (await store.roomMeta(roomId))?.userName ?? "User"
        let transcript = renderTranscript(inRound, cast: cast, chair: chair, userName: userName)
        guard !transcript.isEmpty else { return }
        let kps = await summary.keyPointBodiesForRound(roomId: roomId, roundNum: roundNum)
        let keyPointsBlock = kps.isEmpty ? "" :
            "\n\nChair's key points from this round:\n" + kps.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        guard let model = router.utilityModelV() else { return }
        let prompt = """
Summarise round \(roundNum) of a multi-director boardroom discussion in 4-7 short sentences. Your PRIMARY job is to **protect divergence** — preserve angles the room raised but did not develop, so future rounds know what's still open. Capture, in this order:
(a) **New variables / lenses** any director introduced (even if the room ignored them) — list each by name. These are the room's unspent fuel.
(b) **What was waved past** — angles mentioned in one sentence then abandoned. Name them explicitly.
(c) **What was notably ABSENT** — if the round all discussed X, name 1-2 obvious dimensions (time scale, stakeholder type, geographic context, technical layer, cultural angle) that the round did NOT touch but should have.
(d) **Tensions** — where directors took different positions (not "they all agreed on X"; that erases the divergence we want to preserve).
(e) Only AFTER (a)-(d), 1-2 sentences on the substantive claims that emerged.Do NOT restate the original question. Do NOT add commentary. Do NOT use phrases like "directors converged" or "consensus emerged" — those distill out exactly the divergence we want to keep. Plain prose, third person, present tense.

--- Round \(roundNum) transcript ---
\(transcript)\(keyPointsBlock)
"""
        guard let raw = try? await router.call([LLMMessage(role: .user, content: prompt)],
                                               modelV: model, temperature: 0.3, maxTokens: 650) else { return }
        let body = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        await summary.upsertL1Summary(roomId: roomId, roundNum: roundNum, body: body,
                                      modelV: model.rawValue, sourceHash: hashOf(transcript + keyPointsBlock))
    }

    static func foldL2(router: EngineRouter, summary: SummaryStore, roomId: String,
                       newRoundNum: Int, newL1Body: String) async {
        let existing = await summary.getL2Summary(roomId: roomId)
        let startRound = existing?.startRound ?? newRoundNum
        let endRound = newRoundNum
        guard let model = router.utilityModelV() else { return }
        let previousBlock = (existing?.body.isEmpty == false)
            ? "Previous narrative covering rounds \(existing!.startRound)-\(existing!.endRound):\n\(existing!.body)\n\n"
            : ""
        let prompt = """
You maintain a rolling consolidated narrative of an ongoing multi-director boardroom discussion. A new round just dropped out of the recent window and needs to be folded in. Produce a single narrative of 6-10 sentences covering rounds \(startRound) through \(endRound).

Your PRIMARY job is to **protect divergence over time** — long rooms drift toward a single thread, and your narrative is what the next 10 rounds will use to remember the room. Maintain:
(a) **A running list of "still-open angles"** — variables / lenses that were raised in any round and not deeply developed. Carry these forward across folds; do NOT prune them when a new round dominates a different track.
(b) **Each director's distinctive lens** — what makes their contribution NOT interchangeable with the others. Avoid "all directors agreed on X" framings.
(c) **Major pivots** — points where the room genuinely shifted direction (versus just deepened an existing track).
(d) **Tensions that remain unresolved** — disagreements that haven't been settled. Preserve them; do NOT smooth them into consensus.
Drop: minor exchanges, micro-clarifications, repeated points. Plain prose, third person. Do NOT use phrases like "directors converged" or "consensus emerged" — they erase exactly the divergence we want to preserve.

\(previousBlock)New round \(newRoundNum) (just demoted from L1):
\(newL1Body)
"""
        guard let raw = try? await router.call([LLMMessage(role: .user, content: prompt)],
                                               modelV: model, temperature: 0.3, maxTokens: 900) else { return }
        let body = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        await summary.upsertL2Summary(roomId: roomId, startRound: startRound, endRound: endRound, body: body,
                                      modelV: model.rawValue, sourceHash: hashOf((existing?.body ?? "") + newL1Body))
    }

    /// Transcript for summarization · skip system + chair-marker turns; "name: body".
    static func renderTranscript(_ messages: [EngineMessage], cast: [DirectorRef], chair: DirectorRef?, userName: String) -> String {
        let excluded: Set<String> = ["round-open", "settings", "round-prompt"]
        var names: [String: String] = [:]
        for d in cast { names[d.id] = d.name }
        if let chair { names[chair.id] = chair.name }
        return messages.compactMap { m -> String? in
            let body = m.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if body.isEmpty { return nil }
            switch m.authorKind {
            case "system": return nil
            case "user": return "\(userName): \(body)"
            default:
                if let k = m.kind, excluded.contains(k) { return nil }
                let name = m.authorId.flatMap { names[$0] } ?? "Director"
                return "\(name): \(body)"
            }
        }.joined(separator: "\n\n")
    }

    /// djb2 (32-bit signed accumulate, unsigned hex) · the source_hash invalidation key.
    static func hashOf(_ s: String) -> String {
        var h: Int32 = 5381
        for b in s.unicodeScalars { h = (h &<< 5) &+ h &+ Int32(truncatingIfNeeded: b.value) }
        return String(UInt32(bitPattern: h), radix: 16)
    }
}
