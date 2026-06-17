import Foundation

/// In-process replacement for the desktop's `waitForVoicePlayback` (which was a
/// server-side promise resolved by client HTTP heartbeats). On-device the audio
/// plays in the same process, so the pump simply `await`s this gate between
/// speakers and the native `VoicePlayer` calls `signalDone` when a clip
/// finishes — the whole HTTP round-trip vanishes (see the plan's biggest
/// simplification).
///
/// `wait(for:)` returns immediately if the clip already finished (the done
/// signal can race ahead of the waiter). A `timeout` guards against a clip that
/// never reports done (e.g. TTS error swallowed) so the room never strands.
public actor VoicePlaybackGate {
    private var done: Set<String> = []
    private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]

    public init() {}

    /// Mark a message's audio as finished — resumes any waiter. Idempotent.
    public func signalDone(_ messageId: String) {
        done.insert(messageId)
        if let conts = waiters.removeValue(forKey: messageId) {
            for c in conts { c.resume() }
        }
    }

    /// Await until `messageId`'s audio is done. Returns immediately if already
    /// signalled. Optional timeout (seconds) resolves the wait regardless so the
    /// pump advances even if a done signal is lost.
    public func wait(for messageId: String, timeout: TimeInterval? = nil) async {
        if done.contains(messageId) { return }
        if let timeout {
            await withTaskGroup(of: Void.self) { group in
                group.addTask { await self.park(messageId) }
                group.addTask {
                    try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                    await self.signalDone(messageId)   // force-release on timeout
                }
                await group.next()         // whichever finishes first
                group.cancelAll()
            }
        } else {
            await park(messageId)
        }
    }

    /// Reset a message's state (e.g. re-speak on resume).
    public func reset(_ messageId: String) {
        done.remove(messageId)
        waiters[messageId] = nil
    }

    private func park(_ messageId: String) async {
        if done.contains(messageId) { return }
        await withCheckedContinuation { cont in
            waiters[messageId, default: []].append(cont)
        }
    }
}
