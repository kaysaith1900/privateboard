import Foundation

/// Incremental Server-Sent-Events frame parser. Feed it chunks as they arrive
/// off the wire (they split mid-line / mid-frame arbitrarily) and it returns
/// any complete frames. Reused for BOTH directions on-device:
///   · inbound LLM/TTS provider streams (the `LLMAdapter` / `TTSService`), where
///     `URLSession.bytes.lines` buffers on a real device — see the project's
///     device-SSE lesson (`SSEClient.swift`), so we parse raw chunks ourselves.
///   · the 127.0.0.1 loopback server's outbound room stream (Phase 3).
///
/// Implements the parts of the SSE grammar this codebase uses: `event:`,
/// `data:` (multiple lines joined with "\n"), `id:`, comment lines (`:` prefix,
/// ignored), CRLF or LF terminators, blank-line dispatch. `id` is sticky across
/// frames (mirrors `Last-Event-ID`).
public struct SSELineParser: Sendable {
    public struct Frame: Sendable, Equatable {
        public let event: String
        public let data: String
        public let id: String?
        public init(event: String, data: String, id: String?) {
            self.event = event; self.data = data; self.id = id
        }
    }

    private var pending = ""          // bytes after the last newline (incomplete line)
    private var eventName = "message"
    private var dataLines: [String] = []
    private var lastId: String?

    public init() {}

    /// Feed a decoded text chunk; returns the frames it completed.
    public mutating func push(_ chunk: String) -> [Frame] {
        pending += chunk
        var frames: [Frame] = []
        // Normalise CRLF → LF, then peel complete lines (everything up to each \n).
        pending = pending.replacingOccurrences(of: "\r\n", with: "\n")
                         .replacingOccurrences(of: "\r", with: "\n")
        while let nl = pending.firstIndex(of: "\n") {
            let line = String(pending[pending.startIndex..<nl])
            pending.removeSubrange(pending.startIndex...nl)
            if let frame = consume(line) { frames.append(frame) }
        }
        return frames
    }

    private mutating func consume(_ line: String) -> Frame? {
        if line.isEmpty {                       // blank line → dispatch
            defer { eventName = "message"; dataLines = [] }
            guard !dataLines.isEmpty else { return nil }
            return Frame(event: eventName, data: dataLines.joined(separator: "\n"), id: lastId)
        }
        if line.hasPrefix(":") { return nil }   // comment

        let field: Substring, rawValue: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[line.startIndex..<colon]
            var v = line[line.index(after: colon)...]
            if v.first == " " { v = v.dropFirst() }   // strip a single leading space
            rawValue = v
        } else {
            field = Substring(line)             // field with no colon → empty value
            rawValue = ""
        }

        switch field {
        case "event": eventName = String(rawValue)
        case "data":  dataLines.append(String(rawValue))
        case "id":    lastId = rawValue.isEmpty ? nil : String(rawValue)
        default: break                          // ignore unknown fields (e.g. retry)
        }
        return nil
    }
}
