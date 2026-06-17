import Foundation

/// Sentence-paged subtitle — the Swift port of desktop's `renderRtSubtitle`
/// caption picker. The audio cursor (`revealedChars`) only LOCATES which
/// sentence is being spoken; we return that sentence IN FULL so the caption
/// pages one whole sentence at a time (both lines replaced as a unit) and swaps
/// to the next when the audio advances — never a line-2-only churn.
enum Caption {
    private static let enders: Set<Character> = [".", "!", "?", "。", "！", "？", "…"]
    private static let closers: Set<Character> = ["\"", "'", ")", "]", "”", "’"]

    static func currentSentence(_ full: String, revealedChars: Int) -> String {
        let chars = Array(full)
        let total = chars.count
        let n = max(0, min(total, revealedChars))

        // Sentence boundaries = exclusive end index after an ender run (+ a
        // trailing closer) that's followed by whitespace or end-of-string.
        var bounds: [Int] = []
        var i = 0
        while i < total {
            if enders.contains(chars[i]) {
                var j = i + 1
                while j < total && enders.contains(chars[j]) { j += 1 }
                if j < total && closers.contains(chars[j]) { j += 1 }
                if j >= total || chars[j].isWhitespace {
                    bounds.append(j)
                    i = j
                    continue
                }
            }
            i += 1
        }

        // Locate the sentence the cursor sits in.
        var start = 0
        var end = total
        var prev = 0
        for b in bounds {
            if n <= b { start = prev; end = b; break }
            prev = b
            start = prev
            end = total
        }

        // Return the WHOLE sentence the cursor sits in (not sliced to `n`) — the
        // page swaps as a unit when the cursor crosses into the next sentence.
        guard end > start else { return "" }
        return String(chars[start..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
