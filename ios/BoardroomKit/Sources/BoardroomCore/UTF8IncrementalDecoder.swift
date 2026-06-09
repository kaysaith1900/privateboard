import Foundation

/// Decodes a byte stream to text incrementally, carrying over an incomplete
/// trailing UTF-8 sequence between chunks. Network Data chunks split at
/// arbitrary byte offsets — mid-codepoint — and this app's token deltas are
/// frequently CJK (multi-byte), so naïvely `String(decoding: chunk)` per chunk
/// would corrupt characters straddling a chunk boundary into replacement marks.
/// Feed each `Data` chunk to `push`; it returns the longest valid-UTF-8 prefix
/// and holds the rest for the next chunk.
public struct UTF8IncrementalDecoder: Sendable {
    private var carry: [UInt8] = []
    public init() {}

    public mutating func push(_ data: Data) -> String {
        if data.isEmpty && carry.isEmpty { return "" }
        var bytes = carry
        bytes.append(contentsOf: data)
        let split = Self.completeBoundary(bytes)
        let head = bytes[..<split]
        carry = Array(bytes[split...])
        return String(decoding: head, as: UTF8.self)
    }

    /// Flush any remaining bytes at end of stream (decoding as-is — replacement
    /// chars if genuinely truncated).
    public mutating func flush() -> String {
        defer { carry = [] }
        return carry.isEmpty ? "" : String(decoding: carry, as: UTF8.self)
    }

    /// Index that splits `b` into a complete-UTF-8 prefix and an incomplete
    /// trailing sequence (to carry). Returns `b.count` when the tail is complete.
    static func completeBoundary(_ b: [UInt8]) -> Int {
        if b.isEmpty { return 0 }
        var i = b.count - 1
        var continuation = 0
        while i >= 0 && (b[i] & 0xC0) == 0x80 { i -= 1; continuation += 1 }   // walk back over 10xxxxxx
        if i < 0 { return b.count }                                          // no lead byte found → let decoder cope
        let lead = b[i]
        let len: Int
        if lead & 0x80 == 0 { len = 1 }            // 0xxxxxxx
        else if lead & 0xE0 == 0xC0 { len = 2 }    // 110xxxxx
        else if lead & 0xF0 == 0xE0 { len = 3 }    // 1110xxxx
        else if lead & 0xF8 == 0xF0 { len = 4 }    // 11110xxx
        else { return b.count }                    // malformed lead → don't carry
        return (continuation + 1) >= len ? b.count : i   // complete → keep all; else carry from lead
    }
}
