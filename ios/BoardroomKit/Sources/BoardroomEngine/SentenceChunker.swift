import Foundation
import BoardroomVoice

/// Incremental sentence chunker for streaming TTS (port of the desktop
/// `SentenceChunker` used in room.ts's streaming loop). `push(delta)` appends the
/// new tokens and returns any sentences that COMPLETED with this delta (a
/// terminator was reached); the trailing partial stays buffered. `flush()` returns
/// the remaining tail at stream end.
///
/// Boundary rules are delegated to `SentenceSplitter` so the live (interleaved)
/// path splits IDENTICALLY to the pre-warm path — which feeds the full body through
/// the TTS adapter, which also calls `SentenceSplitter`. Same seg boundaries → the
/// two paths sound the same.
struct SentenceChunker {
    private var buffer = ""
    private static let terminators: Set<Character> = [".", "!", "?", "。", "！", "？", "…", "\n"]

    /// Append `delta`; return the sentences that are now COMPLETE (everything up to
    /// and including the last terminator). The trailing partial is kept for the next
    /// push / flush.
    mutating func push(_ delta: String) -> [String] {
        buffer += delta
        guard let lastTerm = buffer.lastIndex(where: { Self.terminators.contains($0) }) else { return [] }
        let complete = String(buffer[...lastTerm])
        buffer = String(buffer[buffer.index(after: lastTerm)...])
        return SentenceSplitter.split(complete)
    }

    /// Drain the trailing partial (the last sentence with no terminator).
    mutating func flush() -> [String] {
        let rest = buffer
        buffer = ""
        return SentenceSplitter.split(rest)
    }
}
