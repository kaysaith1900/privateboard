import Foundation
import BoardroomCore
import BoardroomAI

/// Layer 1.4 of the divergence stack — `frame-break.ts` `extractDominantTerms`.
/// Inspects the recent director turns for SIGNS OF CONVERGENCE (the room's
/// recurring fixation) via one cheap utility-model call, and returns the
/// noun-phrase cluster (≤5 terms). Empty → the room is still diverse (or no model
/// / too few turns). Caller flips the next-speaker picker into dissent-gap mode
/// when terms come back, and injects them into the director prompt (P4-5).
public enum FrameBreak {
    /// Default window matches the desktop (last 15 messages).
    public static func extractDominantTerms(router: EngineRouter, messages: [EngineMessage],
                                            windowSize: Int = 15) async -> [String] {
        let recent = messages.suffix(windowSize)
        // Director turns only (agent + no chair kind). <4 → not enough to cluster.
        let directorTurns = recent.filter { $0.authorKind == "agent" && $0.kind == nil }
        guard directorTurns.count >= 4 else { return [] }
        guard let model = router.utilityModelV() else { return [] }
        let transcript = renderForExtraction(Array(directorTurns))
        guard !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }

        let prompt = """
You are inspecting a multi-director brainstorm for SIGNS OF CONVERGENCE. Read the recent director turns below and identify the noun phrases / concepts that have become the room's recurring fixation — terms mentioned by multiple directors across multiple turns that are now functioning as the room's gravitational center.

RULES
  · Return ONLY a comma-separated list (no preamble, no JSON, no explanation).
  · 3-5 terms maximum. Each term ≤ 4 words.
  · Prefer the highest-content noun phrases (e.g. "audit responsibility", "compliance burden") over generic words ("AI", "tool", "user").
  · If the conversation is genuinely diverse and no single fixation has emerged, return the literal token NONE (no list).
  · Match the language of the transcript (Chinese in, Chinese terms out).

Recent director turns:
\(transcript)

Recurring fixation terms (comma-separated, or NONE):
"""
        guard let raw = try? await router.call(
            [LLMMessage(role: .user, content: prompt)], modelV: model, temperature: 0.1, maxTokens: 80)
        else { return [] }
        return parse(raw)
    }

    /// Render director turns for the extractor · drop named kinds + empties, cap
    /// each body at 360 chars with an ellipsis, join with "\n---\n".
    static func renderForExtraction(_ messages: [EngineMessage], maxBodyChars: Int = 360) -> String {
        let excluded: Set<String> = ["round-open", "settings", "round-prompt"]
        return messages.compactMap { m -> String? in
            guard m.authorKind == "agent" else { return nil }
            if let k = m.kind, excluded.contains(k) { return nil }
            let body = m.body.trimmingCharacters(in: .whitespacesAndNewlines)
            if body.isEmpty { return nil }
            return body.count > maxBodyChars ? String(body.prefix(maxBodyChars)) + "…" : body
        }.joined(separator: "\n---\n")
    }

    /// Parse the comma-separated fixation list · faithful port of the desktop
    /// parser (NONE/无 sentinel, ASCII/fullwidth/ideographic comma split, quote +
    /// trailing-period strip, ≤60 chars, no structure-leak chars, cap 5).
    static func parse(_ raw: String) -> [String] {
        let txt = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if txt.isEmpty { return [] }
        if txt.range(of: "^none\\b", options: [.regularExpression, .caseInsensitive]) != nil { return [] }
        if txt.range(of: "^无$", options: .regularExpression) != nil { return [] }
        var out: [String] = []
        for r in txt.components(separatedBy: CharacterSet(charactersIn: ",，、")) {
            var t = r.trimmingCharacters(in: .whitespacesAndNewlines)
            t = t.replacingOccurrences(of: "^[\"'“”‘’]+", with: "", options: .regularExpression)
            t = t.replacingOccurrences(of: "[\"'“”‘’.。]+$", with: "", options: .regularExpression)
            if t.isEmpty { continue }
            if t.count > 60 { continue }
            if t.range(of: "[\\n:：]", options: .regularExpression) != nil { continue }
            out.append(t)
            if out.count >= 5 { break }
        }
        return out
    }
}
