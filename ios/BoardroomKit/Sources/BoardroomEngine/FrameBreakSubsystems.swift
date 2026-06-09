import Foundation
import BoardroomCore
import BoardroomAI

/// Layer 3.1 · topic-tree tagger (`topic-tagger.ts` `tagMessageBranch`). Tags a
/// director turn as EXTEND-an-existing-branch or OPEN-a-new-branch via one cheap
/// call, persisting to the topic tree. Fire-and-forget — the room proceeds
/// untagged on any failure. Returns the branch id used (or nil).
public enum TopicTagger {
    @discardableResult
    public static func tagMessageBranch(router: EngineRouter, store: FrameBreakStore, roomId: String,
                                        messageId: String, speakerId: String, body: String,
                                        roomSubject: String) async -> String? {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let model = router.utilityModelV() else { return nil }
        let existing = await store.listBranches(roomId)
        let branchList: String = existing.isEmpty
            ? "(none yet — this is the first branch)"
            : existing.enumerated().map { "\($0.offset + 1). id=\($0.element.id) · \"\($0.element.label)\" · \($0.element.turnCount) turn(s)" }.joined(separator: "\n")
        let clippedBody = trimmed.count > 1200 ? String(trimmed.prefix(1200)) + "…" : trimmed
        let prompt = """
You are tagging a director's turn in a multi-director brainstorm with the topic branch it belongs to. Branches are short noun-phrase angles the room has been exploring (e.g. "audit responsibility", "informal-economy workers", "ritualised handoff").

Room subject: "\(roomSubject)"

Existing branches in this room:
\(branchList)

Director's turn to tag (verbatim):
\(clippedBody)

Decide ONE of:
  (A) This turn primarily EXTENDS existing branch X. Output: EXTEND <branch-id>
  (B) This turn primarily OPENS a NEW branch. Output: NEW <short-label-≤-8-words>

Rules:
  · A turn that mostly adds detail / sub-angle to an existing branch is EXTEND.
  · A turn that introduces a genuinely fresh lens / domain / stakeholder is NEW.
  · When the turn could plausibly go either way, prefer NEW · the room benefits from more branches.
  · The label should be a CONCRETE noun phrase, not a question or full sentence.
  · Match the language of the turn for new-branch labels.
  · Output ONLY the directive · no explanation, no JSON, no preamble.
"""
        guard let raw = try? await router.call([LLMMessage(role: .user, content: prompt)],
                                               modelV: model, temperature: 0.1, maxTokens: 40) else { return nil }
        let txt = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if txt.isEmpty { return nil }
        if let m = txt.range(of: "^EXTEND\\s+(\\S+)", options: [.regularExpression, .caseInsensitive]) {
            let branchId = String(txt[m]).replacingOccurrences(of: "^EXTEND\\s+", with: "", options: [.regularExpression, .caseInsensitive])
            if existing.contains(where: { $0.id == branchId }) {
                await store.tagMessageWithBranch(messageId: messageId, branchId: branchId, isOpener: false, speakerId: speakerId)
                return branchId
            }
            // fabricated id → fall through to NEW
        }
        var label: String
        if let m = txt.range(of: "^NEW\\s+(.+)$", options: [.regularExpression, .caseInsensitive]) {
            label = String(txt[m]).replacingOccurrences(of: "^NEW\\s+", with: "", options: [.regularExpression, .caseInsensitive])
        } else {
            label = txt.count < 80 ? txt : ""
        }
        label = label.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "^[\"'`]+", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[\"'`]+$", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[。.!?]+$", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty, label.count <= 80 else { return nil }
        let id = await store.createBranch(roomId: roomId, label: label, openerSpeakerId: speakerId)
        await store.tagMessageWithBranch(messageId: messageId, branchId: id, isOpener: true, speakerId: speakerId)
        return id
    }
}

/// Layer 3.2 · negative-space extractor (`negative-space-extract.ts`). After a
/// round, names 1-3 angles the round did NOT touch but should have. Returns the
/// angle strings (caller persists via `insertNegativeSpaceAngles`). [] on any
/// failure / too few turns / NONE.
public enum NegativeSpace {
    public static func extractNegativeSpace(router: EngineRouter, roundMessages: [EngineMessage],
                                            roomSubject: String) async -> [String] {
        let excluded: Set<String> = ["round-open", "settings", "round-prompt"]
        let turns = roundMessages.filter { $0.authorKind == "agent" && $0.kind == nil }
        guard turns.count >= 2 else { return [] }
        let transcript = turns.compactMap { m -> String? in
            if let k = m.kind, excluded.contains(k) { return nil }
            let b = m.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if b.isEmpty { return nil }
            return b.count > 500 ? String(b.prefix(500)) + "…" : b
        }.joined(separator: "\n---\n")
        guard !transcript.isEmpty else { return [] }
        guard let model = router.utilityModelV() else { return [] }
        let prompt = """
You are protecting the divergence of a multi-director brainstorm. The room's subject is: "\(roomSubject)". A round of director turns just ended. Read those turns below and identify 1-3 ANGLES the round did NOT touch but plausibly SHOULD have, given the room's subject. An "angle" is a short noun phrase ≤ 8 words — a stakeholder type, a time horizon, a domain analogy, a technical layer, a cultural / regulatory context, a material constraint, a hidden user, a counter-population.

RULES
  · Each angle is a NEW direction the room could explore next, not a critique of what was said.
  · Each angle is a CONCRETE noun phrase, not a question. ("informal-economy workers" yes; "what about workers?" no.)
  · Each angle is genuinely fresh — NOT a paraphrase of what the round already discussed.
  · Match the language of the transcript.
  · Return ONLY a newline-separated list (max 3 lines). No bullets, no numbering, no preamble.
  · If the round was already genuinely diverse and no obvious angle is missing, return the literal token NONE.

Round transcript:
\(transcript)

Unexplored angles (newline-separated, or NONE):
"""
        guard let raw = try? await router.call([LLMMessage(role: .user, content: prompt)],
                                               modelV: model, temperature: 0.4, maxTokens: 120) else { return [] }
        let txt = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if txt.isEmpty { return [] }
        if txt.range(of: "^none\\b", options: [.regularExpression, .caseInsensitive]) != nil { return [] }
        if txt.range(of: "^无$", options: .regularExpression) != nil { return [] }
        return txt.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            line.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "^[-·•*\\d.)\\s]+", with: "", options: .regularExpression)
                .replacingOccurrences(of: "[。.]+$", with: "", options: .regularExpression)
        }.filter { !$0.isEmpty && $0.count < 200 }.prefix(3).map { $0 }
    }
}

/// Question-dimension scorer (`qd-scorer.ts` `scoreAndArchive`). Rates a turn on
/// abstraction / time / stakeholder (each 0–1) via one cheap call and archives
/// it for report coverage. Fire-and-forget; no-op on <40-char body / no model /
/// parse failure.
public enum QDScorer {
    public static func scoreAndArchive(router: EngineRouter, store: FrameBreakStore,
                                       roomId: String, messageId: String, body: String) async {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 40 else { return }
        guard let model = router.utilityModelV() else { return }
        let clipped = trimmed.count > 1200 ? String(trimmed.prefix(1200)) + "…" : trimmed
        let prompt = """
Rate the director turn below on THREE behavioral dimensions. Each rating is a single floating-point number 0.00-1.00.

Dimension A · Abstraction level
  · 0.00 = concrete example (specific named user, specific product, specific scenario)
  · 0.33 = case / use-case (representative pattern, named domain)
  · 0.66 = mechanism / structural argument (how-it-works, conditions)
  · 1.00 = abstract principle (timeless / cross-domain / first-principles)

Dimension B · Time scale
  · 0.00 = this quarter / immediate (months)
  · 0.33 = product cycle (1-3 years)
  · 0.66 = strategic / generational (5-20 years)
  · 1.00 = civilizational / long-horizon (50+ years, structural)

Dimension C · Stakeholder scope
  · 0.00 = individual user / single role
  · 0.33 = team / org
  · 0.66 = industry / market
  · 1.00 = society / civilization

OUTPUT · exactly three lines, one float per line, in order A B C. No labels, no JSON, no commentary.

Turn:
\(clipped)

Three scores (one per line, A then B then C):
"""
        guard let raw = try? await router.call([LLMMessage(role: .user, content: prompt)],
                                               modelV: model, temperature: 0.0, maxTokens: 30) else { return }
        let lines = raw.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard lines.count >= 3,
              let a = parseScore(lines[0]), let t = parseScore(lines[1]), let s = parseScore(lines[2]) else { return }
        await store.upsertQDScore(messageId: messageId, roomId: roomId, abstraction: a, time: t, stakeholder: s)
    }

    static func parseScore(_ line: String) -> Double? {
        guard let m = line.range(of: "(\\d+\\.\\d+|\\d+)", options: .regularExpression) else { return nil }
        guard var n = Double(line[m]) else { return nil }
        if n > 1.0 && n <= 10 { n = n / 10 }
        if n > 1.0 && n <= 100 { n = n / 100 }
        return max(0, min(1, n))
    }
}
