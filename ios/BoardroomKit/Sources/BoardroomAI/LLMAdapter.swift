import Foundation
import BoardroomCore

/// Supplies the active LLM credential at call time. Implemented by the app/engine
/// over prefs + Keychain (`active_llm_credential_id` → provider + key); injected
/// so `BoardroomAI` stays free of a storage dependency.
public protocol LLMCredentialSource: Sendable {
    func activeLLMCredential() -> (carrier: LLMCarrier, apiKey: String)?
}

public enum LLMError: Error, Equatable {
    case noKey
    case modelNotReachable(ModelV, LLMCarrier)
    case upstream(String)
    case exhausted(lastError: String)
}

/// Resolve which wire + wire-id to use for a model under the active carrier.
/// Mirrors `resolveModel` (`adapter.ts`): the single active credential picks the
/// carrier; the model must be reachable on it. `carrierOverride` is intentionally
/// ignored — under the single-active invariant there's no other carrier to use.
public enum WireResolver {
    public static func wire(for carrier: LLMCarrier) -> LLMWire {
        switch carrier {
        case .openrouter: return OpenAICompatibleWire.openRouter()
        case .bai:        return OpenAICompatibleWire.bai()
        case .moonshot:   return OpenAICompatibleWire.moonshot()
        case .zhipu:      return OpenAICompatibleWire.zhipu()
        case .anthropic:  return AnthropicWire()
        case .openai:     return OpenAIResponsesWire.openAI()
        case .xai:        return OpenAIResponsesWire.xai()
        case .google:     return GeminiWire()
        // deepseek/minimax have no direct LLM SDK path (viaUniversalOnly) → never
        // reachable as a direct carrier, so resolve() returns nil before this is used.
        case .deepseek, .minimax: return OpenAICompatibleWire.bai()
        }
    }

    /// (wire, wireId) for `modelV` under `carrier`, or nil if unreachable.
    public static func resolve(_ modelV: ModelV, carrier: LLMCarrier) -> (wire: LLMWire, wireId: String)? {
        guard let meta = Registry.meta(modelV) else { return nil }
        let avail = Availability.availability(meta, active: carrier)
        guard avail.reachable, let route = avail.preferredRoute,
              let id = Availability.wireId(meta, route: route) else { return nil }
        return (wire(for: carrier), id)
    }
}

/// Streams a single LLM response as typed chunks — the Swift counterpart of
/// `callLLMStream` (`adapter.ts`). Resolve carrier+wire → POST → read the body
/// via a `URLSessionDataDelegate` (NOT `.bytes.lines`, which buffers on a real
/// device — the project's SSE lesson) → incremental-UTF-8 → `SSELineParser` →
/// the wire's decoder → yield. Retries transient failures up to
/// `Retry.maxAttempts`, but only before the first text-delta.
///
/// ⚠️ Network connectivity + on-device SSE buffering are verified on a real
/// device; the request building, UTF-8 reassembly, and SSE/wire decoding are
/// unit-tested in isolation.
public struct LLMAdapter: Sendable {
    let credentials: LLMCredentialSource
    let requestTimeout: TimeInterval

    public init(credentials: LLMCredentialSource, requestTimeout: TimeInterval = 600) {
        self.credentials = credentials
        self.requestTimeout = requestTimeout
    }

    public func stream(_ req: LLMRequest) -> AsyncThrowingStream<LLMStreamChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task { await run(req, continuation) }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func run(_ req: LLMRequest, _ cont: AsyncThrowingStream<LLMStreamChunk, Error>.Continuation) async {
        guard let active = credentials.activeLLMCredential() else {
            cont.finish(throwing: LLMError.noKey); return
        }
        guard let (wire, wireId) = WireResolver.resolve(req.modelV, carrier: active.carrier) else {
            cont.finish(throwing: LLMError.modelNotReachable(req.modelV, active.carrier)); return
        }
        // Claude 4.7 family rejects temperature on every carrier.
        let temperature = (Registry.meta(req.modelV)?.noTemperature ?? false) ? nil : req.temperature

        var attempt = 0
        var lastError = ""
        var yieldedText = false

        while attempt < Retry.maxAttempts {
            attempt += 1
            if Task.isCancelled { cont.finish(throwing: CancellationError()); return }
            if attempt > 1 {
                try? await Task.sleep(nanoseconds: UInt64(Retry.jitteredDelayMs(retryNumber: attempt - 1)) * 1_000_000)
                if Task.isCancelled { cont.finish(throwing: CancellationError()); return }
            }

            let request: URLRequest
            do {
                request = try wire.buildRequest(wireId: wireId, apiKey: active.apiKey,
                                                messages: req.messages, temperature: temperature,
                                                maxTokens: req.maxTokens)
            } catch { cont.finish(throwing: LLMError.upstream("\(error)")); return }

            let outcome = await attemptStream(request, wire: wire, yieldedText: &yieldedText, cont: cont)
            switch outcome {
            case .completed:
                cont.finish(); return
            case .cancelled:
                cont.finish(throwing: CancellationError()); return
            case .retriable(let msg):
                lastError = msg; continue
            case .terminal(let msg):
                cont.finish(throwing: LLMError.upstream(msg)); return
            }
        }
        cont.finish(throwing: LLMError.exhausted(lastError: lastError))
    }

    private enum Outcome { case completed, cancelled, retriable(String), terminal(String) }

    private func attemptStream(_ request: URLRequest, wire: LLMWire, yieldedText: inout Bool,
                               cont: AsyncThrowingStream<LLMStreamChunk, Error>.Continuation) async -> Outcome {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = requestTimeout       // finite — .infinity is rejected on-device
        let delegate = ByteStreamDelegate()
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        let task = session.dataTask(with: request)
        defer { task.cancel(); session.finishTasksAndInvalidate() }
        task.resume()

        let decoder = wire.makeDecoder()
        var utf8 = UTF8IncrementalDecoder()
        var parser = SSELineParser()
        var status: Int?
        var errBody = ""
        var sawDone = false

        do {
            for try await ev in delegate.stream {
                if Task.isCancelled { return .cancelled }
                switch ev {
                case .status(let code):
                    status = code
                case .data(let data):
                    if let s = status, !(200..<300).contains(s) {
                        errBody += String(decoding: data, as: UTF8.self)
                        continue
                    }
                    for frame in parser.push(utf8.push(data)) {
                        for chunk in decoder.decode(frame) {
                            if case .textDelta = chunk { yieldedText = true }
                            if case .done = chunk { sawDone = true }
                            cont.yield(chunk)
                        }
                    }
                }
            }
        } catch {
            return classify("\(error)", yieldedText: yieldedText)
        }

        if let s = status, !(200..<300).contains(s) {
            return classify("HTTP \(s)\(errBody.isEmpty ? "" : ": \(errBody.prefix(800))")", yieldedText: yieldedText)
        }
        if !sawDone { cont.yield(.done(finishReason: "stop")) }   // stream closed cleanly without an explicit done
        return .completed
    }

    private func classify(_ msg: String, yieldedText: Bool) -> Outcome {
        if !yieldedText && Retry.isTransient(msg) { return .retriable(msg) }
        return .terminal(msg)
    }
}

/// Bridges a streaming `URLSessionDataTask` to an `AsyncThrowingStream` of
/// status + incremental data chunks. Uses the delegate callbacks (not
/// `URLSession.bytes`) so chunks arrive incrementally on a real device.
final class ByteStreamDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    enum Event: Sendable { case status(Int); case data(Data) }
    let stream: AsyncThrowingStream<Event, Error>
    private let cont: AsyncThrowingStream<Event, Error>.Continuation

    override init() {
        var c: AsyncThrowingStream<Event, Error>.Continuation!
        stream = AsyncThrowingStream { c = $0 }
        cont = c
        super.init()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        cont.yield(.status((response as? HTTPURLResponse)?.statusCode ?? 0))
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        cont.yield(.data(data))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { cont.finish(throwing: error) } else { cont.finish() }
    }
}
