import Foundation
import AVFoundation

/// Sequential clip player for adjourned-room replay. `play(_:)` is async and
/// returns when the clip finishes (or can't start), so the replay loop can
/// await each beat; `progress()` feeds caption karaoke. Separate from the live
/// `VoicePlayer` (which is a serialized queue).
@MainActor
final class ReplayPlayer: NSObject {
    private var player: AVAudioPlayer?
    private var continuation: CheckedContinuation<Void, Never>?
    private var rate: Float = 1

    /// Change playback speed · applies live to the current clip and to the next.
    func setRate(_ r: Float) {
        rate = r
        if let p = player { p.enableRate = true; p.rate = r }
    }

    /// Play a clip and suspend until it ends (or returns immediately if unplayable).
    func play(_ data: Data, rate: Float) async {
        stop()
        self.rate = rate
        activateSession()                          // the stage WKWebView can reset the app's audio session → re-assert (else silent)
        guard let p = try? AVAudioPlayer(data: data) else { return }
        p.delegate = self
        p.enableRate = true; p.rate = rate
        p.prepareToPlay()
        player = p
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            continuation = c
            if !p.play() {
                activateSession()                  // session contended · re-assert + retry once
                if !p.play() { finish() }
            }
        }
    }

    /// Re-assert the playback session · same config the live VoicePlayer uses.
    /// Without this, replay can be silent (the embedded stage WebView may have
    /// left the session inactive / on the wrong category).
    private func activateSession() {
        #if os(iOS)
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .spokenAudio)   // plays through the silent switch + on lock
        try? s.setActive(true)
        #endif
    }

    func progress() -> (time: Double, duration: Double)? {
        guard let p = player else { return nil }
        return (p.currentTime, p.duration)
    }

    func stop() { player?.stop(); player = nil; finish() }

    /// Pause / resume the current clip WITHOUT ending the beat — the replay loop
    /// stays parked on its `play(...)` await (which only resolves on finish), so
    /// resuming continues the same clip. Drives the lock-screen play/pause.
    var isPaused: Bool { player?.isPlaying == false && player != nil }
    func setPaused(_ paused: Bool) {
        guard let p = player else { return }
        if paused { p.pause() } else { p.play() }
    }

    private func finish() {
        let c = continuation
        continuation = nil
        c?.resume()
    }
}

extension ReplayPlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in self?.stop() }
    }
}
