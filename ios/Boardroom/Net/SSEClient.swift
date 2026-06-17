import Foundation

/// Server-Sent-Events client using a `URLSessionDataDelegate` for *incremental*
/// byte delivery.
///
/// `URLSession.bytes(for:).lines` buffers the SSE stream on a real iOS device —
/// the connection opens (status 200) but not a single line is ever yielded, so
/// the room appears frozen and only updates on re-entry (re-snapshot). The
/// delegate callback `urlSession(_:dataTask:didReceive:)` fires as each chunk
/// lands on the wire, which is the reliable streaming path on-device. We also
/// request `Accept-Encoding: identity` so the server never gzips the stream (a
/// compressed body gets buffered by the decoder until it has enough bytes).
///
/// Exposed as an ordered `AsyncStream<Event>`; auto-reconnects with
/// `Last-Event-ID` replay so a dropped connection doesn't lose turns.
final class SSEClient: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    struct Event: Sendable { let name: String; let data: String; let id: String? }

    private let url: URL
    private let authToken: String?

    /// All mutable state below is touched ONLY on this serial queue (the
    /// delegate queue dispatches into it too), so no locks are needed.
    private let q = DispatchQueue(label: "boardroom.sse")
    private var lastEventID: String?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var continuation: AsyncStream<Event>.Continuation?
    private var stopped = false

    // SSE line-parse state
    private var buffer = Data()
    private var evName = "message"
    private var dataLines: [String] = []
    private var idBuf: String?

    init(url: URL, authToken: String?) {
        self.url = url
        self.authToken = authToken
        super.init()
    }

    /// Ordered event stream. Finishes when `stop()` is called or the consumer
    /// cancels.
    func events() -> AsyncStream<Event> {
        AsyncStream { cont in
            self.q.async {
                self.continuation = cont
                self.stopped = false
            }
            cont.onTermination = { [weak self] _ in self?.stop() }
            self.connect()
        }
    }

    func stop() {
        q.async {
            self.stopped = true
            self.task?.cancel(); self.task = nil
            self.session?.invalidateAndCancel(); self.session = nil
            self.continuation?.finish(); self.continuation = nil
        }
    }

    private func connect() {
        q.async {
            guard !self.stopped else { return }
            var req = URLRequest(url: self.url, timeoutInterval: 600)   // NOT .infinity — iOS rejects it
            req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
            req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")   // no gzip — stream uncompressed so chunks arrive live
            if let id = self.lastEventID { req.setValue(id, forHTTPHeaderField: "Last-Event-ID") }
            if let token = self.authToken { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

            let cfg = URLSessionConfiguration.default
            cfg.timeoutIntervalForRequest = 600
            cfg.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            cfg.urlCache = nil
            let dq = OperationQueue(); dq.maxConcurrentOperationCount = 1
            let s = URLSession(configuration: cfg, delegate: self, delegateQueue: dq)
            self.session = s
            let t = s.dataTask(with: req)
            self.task = t
            t.resume()
        }
    }

    // MARK: URLSessionDataDelegate (on `dq`, hopped onto `q`)

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let code = (response as? HTTPURLResponse)?.statusCode ?? -1
        completionHandler(code >= 200 && code < 300 ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        q.async {
            self.buffer.append(data)
            self.drain()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        q.async {
            guard !self.stopped else { return }
            self.session?.invalidateAndCancel(); self.session = nil; self.task = nil
            self.buffer.removeAll(keepingCapacity: true)
            self.evName = "message"; self.dataLines = []; self.idBuf = nil
            self.q.asyncAfter(deadline: .now() + 1.5) { self.connect() }
        }
    }

    // MARK: SSE parsing (on `q`)

    private func drain() {
        while let nl = buffer.firstIndex(of: 0x0A) {            // split on "\n"
            let lineData = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            var line = String(decoding: lineData, as: UTF8.self)
            if line.hasSuffix("\r") { line.removeLast() }       // tolerate CRLF
            consume(line)
        }
    }

    private func consume(_ line: String) {
        if line.isEmpty {                                       // blank line ⇒ dispatch
            if !dataLines.isEmpty || evName != "message" {
                if let idBuf { lastEventID = idBuf }
                continuation?.yield(Event(name: evName, data: dataLines.joined(separator: "\n"), id: idBuf))
            }
            evName = "message"; dataLines = []; idBuf = nil
            return
        }
        if line.hasPrefix(":") { return }                       // comment / heartbeat
        if line.hasPrefix("event:") { evName = Self.field(line, "event:") }
        else if line.hasPrefix("data:") { dataLines.append(Self.field(line, "data:")) }
        else if line.hasPrefix("id:") { idBuf = Self.field(line, "id:") }
    }

    private static func field(_ line: String, _ prefix: String) -> String {
        var v = String(line.dropFirst(prefix.count))
        if v.hasPrefix(" ") { v.removeFirst() }                 // spec: strip one leading space
        return v
    }
}
