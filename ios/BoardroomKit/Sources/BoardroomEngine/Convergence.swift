import Foundation

/// Convergence detection — Layer 2.3 of the divergence stack (port of
/// `convergence.ts`). Measures how tightly the room's recent director turns
/// cluster around one frame; when tight, the orchestrator switches the
/// next-speaker picker into dissent-gap mode + the chair injects a curveball.
///
/// The TF-IDF cosine path here is fully deterministic (unit-tested). The
/// preferred LLM-scored path is injected by the caller (it needs a live model);
/// `detect` takes an optional async scorer and falls back to TF-IDF when it's
/// absent or returns nil — exactly the desktop's two-strategy layering.
public enum Convergence {
    public struct Signal: Sendable, Equatable {
        public let converging: Bool
        public let score: Double
        public let source: Source
        public let note: String
        public enum Source: String, Sendable { case llm, tfidf, skip }
    }

    static let llmThreshold = 0.78
    static let tfidfThreshold = 0.62
    static let minTurnsForDetection = 4

    /// `turns` = the recent substantive director-turn bodies (caller filters out
    /// system / round-open / round-prompt markers). `llmScore`, when provided,
    /// returns a 0–1 cluster-tightness score + note, or nil to fall back.
    public static func detect(
        turns: [String],
        llmScore: ((_ transcript: [String]) async -> (score: Double, note: String)?)? = nil
    ) async -> Signal {
        let bodies = turns.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if bodies.count < minTurnsForDetection {
            return Signal(converging: false, score: 0, source: .skip, note: "")
        }
        if let llmScore, let r = await llmScore(bodies) {
            let s = max(0, min(1, r.score))
            return Signal(converging: s >= llmThreshold, score: s, source: .llm, note: r.note)
        }
        let s = tfidfScore(bodies)
        return Signal(converging: s >= tfidfThreshold, score: s, source: .tfidf, note: "")
    }

    /// Mean pairwise TF-IDF cosine similarity over the turns. 0 when <2 turns.
    public static func tfidfScore(_ turns: [String]) -> Double {
        let bodies = turns.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard bodies.count >= 2 else { return 0 }
        let vecs = tfidfVectors(bodies)
        var sum = 0.0, pairs = 0
        for i in 0..<vecs.count {
            for j in (i + 1)..<vecs.count { sum += cosine(vecs[i], vecs[j]); pairs += 1 }
        }
        return pairs == 0 ? 0 : sum / Double(pairs)
    }

    // MARK: TF-IDF internals (verbatim port)

    static let stopwords: Set<String> = [
        "the","and","or","but","if","with","for","from","into","this","that",
        "these","those","is","are","was","were","be","been","being","to","of",
        "in","on","at","as","an","a","by","it","its","they","them","their",
        "we","our","you","your","i","my","me","he","she","his","her","him",
        "not","no","so","do","does","did","have","has","had","will","would",
        "could","should","can","may","might","must","shall","what","which",
        "who","whom","when","where","why","how",
    ]

    /// Tokenize: English on whitespace/punct (drop stopwords + single chars);
    /// each CJK ideograph is its own token. Mirrors `tokenize` in convergence.ts.
    static func tokenize(_ text: String) -> [String] {
        var tokens: [String] = []
        var buf = ""
        func flush() {
            if buf.count > 1 && !stopwords.contains(buf) { tokens.append(buf) }
            buf = ""
        }
        for scalar in text.lowercased().unicodeScalars {
            let v = scalar.value
            let isCJK = v >= 0x4e00 && v <= 0x9fff
            let isAlnum = (v >= 0x30 && v <= 0x39) || (v >= 0x41 && v <= 0x5a) || (v >= 0x61 && v <= 0x7a)
            if isAlnum {
                buf.unicodeScalars.append(scalar)
            } else {
                flush()
                if isCJK { tokens.append(String(scalar)) }
            }
        }
        flush()
        return tokens
    }

    static func tfidfVectors(_ turns: [String]) -> [[String: Double]] {
        let docTokenSets = turns.map { Set(tokenize($0)) }
        var df: [String: Int] = [:]
        for set in docTokenSets { for t in set { df[t, default: 0] += 1 } }
        let n = Double(turns.count)
        return turns.map { turn in
            var tf: [String: Int] = [:]
            for t in tokenize(turn) { tf[t, default: 0] += 1 }
            let maxTf = Double(max(1, tf.values.max() ?? 1))
            var vec: [String: Double] = [:]
            for (term, count) in tf {
                let idf = log((n + 1) / (Double(df[term] ?? 0) + 1))
                vec[term] = (Double(count) / maxTf) * idf
            }
            return vec
        }
    }

    static func cosine(_ a: [String: Double], _ b: [String: Double]) -> Double {
        var dot = 0.0, na = 0.0, nb = 0.0
        for (k, v) in a { na += v * v; if let bv = b[k] { dot += v * bv } }
        for v in b.values { nb += v * v }
        if na == 0 || nb == 0 { return 0 }
        return dot / (na.squareRoot() * nb.squareRoot())
    }
}
