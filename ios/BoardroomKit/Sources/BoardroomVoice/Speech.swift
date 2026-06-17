import Foundation

/// Text → speech-ready text. Ports `stripSpokenLabels` + `cleanForSpeech` from
/// `src/voice/tts.ts` verbatim (regex-for-regex) so TTS reads natural prose, not
/// markdown / code / 【labels】. Order matters — fences + inline code first.
public enum Speech {
    /// Drop 【label】 section headers (visual prefixes; reading them aloud makes
    /// every turn open the same way). Bounded to ≤40-char, newline-free inner
    /// content so a mid-sentence 【…】 quote doesn't swallow surrounding prose.
    public static func stripSpokenLabels(_ text: String) -> String {
        if text.isEmpty { return "" }
        var s = text
        s = rx(s, #"【[^】\n]{1,40}】[ \t]*"#, "")
        s = rx(s, #"[ \t]+\n"#, "\n")
        s = rx(s, #"\n{3,}"#, "\n\n")
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Strip markdown / code / urls / table syntax, keep the prose + sentence
    /// structure (newlines preserved so the splitter still sees paragraph breaks).
    public static func cleanForSpeech(_ md: String) -> String {
        if md.isEmpty { return "" }
        var out = md
        out = rx(out, #"```[\s\S]*?```"#, " ")                  // fenced code → drop
        out = rx(out, #"【[^】\n]{1,40}】[ \t]*"#, " ")            // 【label】 → drop
        out = rx(out, #"`([^`\n]+)`"#, "$1")                     // inline code → keep content
        out = rx(out, #"!\[[^\]]*\]\([^)]+\)"#, " ")             // images → drop
        out = rx(out, #"\[([^\]]+)\]\([^)]+\)"#, "$1")           // links → keep label
        out = rx(out, #"https?://\S+"#, "link", caseInsensitive: true)  // bare URLs → "link"
        out = rx(out, #"(?m)^\s{0,3}#{1,6}\s+"#, "")             // headings → drop hashes
        out = rx(out, #"(?m)^\s{0,3}>\s?"#, "")                  // blockquote → drop >
        out = rx(out, #"(?m)^\s*[-*+]\s+"#, "")                  // ul markers
        out = rx(out, #"(?m)^\s*\d+[.)]\s+"#, "")                // ol markers
        out = rx(out, #"(?m)^\s*\|[\s:|-]+\|\s*$"#, " ")         // table separator rows
        out = rx(out, #"\|"#, ", ")                              // pipes → commas
        out = rx(out, #"(\*\*|__)(.+?)\1"#, "$2")                // bold
        out = rx(out, #"(?<!\w)([*_])([^*_\n]+)\1(?!\w)"#, "$2") // italic/em
        out = rx(out, #"~~(.+?)~~"#, "$1")                       // strike
        out = rx(out, #"<[^>]+>"#, " ")                          // raw HTML tags
        out = out.replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&nbsp;", with: " ")
        out = rx(out, #"[ \t]+"#, " ")
        out = rx(out, #"\n[ \t]+"#, "\n")
        out = rx(out, #"\n{3,}"#, "\n\n")
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func rx(_ s: String, _ pattern: String, _ template: String,
                           caseInsensitive: Bool = false) -> String {
        let p = caseInsensitive ? "(?i)" + pattern : pattern
        return s.replacingOccurrences(of: p, with: template, options: .regularExpression)
    }
}
