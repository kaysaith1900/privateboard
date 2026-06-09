import Foundation

/// Split speech-cleaned text into sentences for sentence-by-sentence TTS (the
/// orchestrator synthesizes + plays one sentence at a time so the next speaker
/// can pre-warm). Handles both Latin (. ! ?) and CJK (。！？…) terminators plus
/// hard newlines, keeping terminal punctuation attached. Very short trailing
/// fragments merge into the previous sentence so a lone "Yes." isn't its own
/// micro-clip.
public enum SentenceSplitter {
    public static func split(_ text: String, minLength: Int = 2) -> [String] {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return [] }

        var sentences: [String] = []
        var current = ""
        let terminators: Set<Character> = [".", "!", "?", "。", "！", "？", "…", "\n"]

        for ch in cleaned {
            if ch == "\n" {
                flush(&current, into: &sentences)
                continue
            }
            current.append(ch)
            if terminators.contains(ch) {
                // Don't break inside an ellipsis run "..." — wait for a non-dot.
                flush(&current, into: &sentences)
            }
        }
        flush(&current, into: &sentences)

        // Merge fragments shorter than minLength into the previous sentence.
        var merged: [String] = []
        for s in sentences {
            if let last = merged.last, s.count < minLength {
                merged[merged.count - 1] = (last + " " + s)
            } else {
                merged.append(s)
            }
        }
        return merged
    }

    private static func flush(_ current: inout String, into out: inout [String]) {
        let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { out.append(trimmed) }
        current = ""
    }
}
