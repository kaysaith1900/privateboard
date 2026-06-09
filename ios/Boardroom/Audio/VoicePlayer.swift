import Foundation
import AVFoundation

/// Native TTS playback — the Swift port of the web shell's voice queue
/// (`enqueueVoiceChunk` / `maybePlayNext` / `playVoice` / `finishVoice`).
///
/// The server streams base64 MP3 chunks per message and serialises turns: it
/// parks at `waitForVoicePlayback` until the client POSTs `/voice-done`. So we:
///   • accumulate a message's chunks, play them as one clip once `voice-final`,
///   • POST `/voice-progress` every 5s while playing (keeps the server waiter
///     alive — long clips never trip the 60s fallback),
///   • POST `/voice-done` when the clip ends → the next director starts,
///   • pause/resume the clip *immediately* on tap (server "soft" pause only
///     stops AFTER the turn), and
///   • on leave, ack every owed turn so the room isn't stranded.
///
/// `@MainActor` so its state + the AVAudioPlayer delegate callbacks are all on
/// the main actor (the callbacks `onChange`/`onProgress`/`onDone` are too).
@MainActor
final class VoicePlayer: NSObject {
    var onChange: (() -> Void)?            // playing message started or stopped
    var onProgress: ((String) -> Void)?    // heartbeat tick → POST /voice-progress
    var onDone: ((String) -> Void)?        // finished or abandoned → POST /voice-done

    /// One director/chair turn. The server streams the turn sentence-by-sentence:
    /// every `emitVoiceText` call is one self-contained MP3 whose chunks share a
    /// `seg` index, and the next sentence's chunks only start AFTER the previous
    /// sentence's are all sent. So a segment is COMPLETE the moment a higher `seg`
    /// appears (or `voice-final` lands). We play each completed segment at once
    /// instead of waiting for the whole message — that wait was the latency the
    /// user felt ("等整段读完才读").
    private struct Item {
        var segData: [Int: Data] = [:]      // seg → concatenated MP3 bytes
        var segText: [Int: String] = [:]    // seg → spoken sentence (caption karaoke)
        var seenSeqs: Set<Int> = []         // de-dup retransmits
        var maxSeg = -1                     // highest seg seen → seals lower segs
        var playCursor = 0                  // next seg index to consider playing
        var final = false                   // voice-final (or fallback) → all segs sealed
        var textFinal = false
        var author: String?
        var done = false
        let order: Int
        var fallback: Timer?
    }

    private var items: [String: Item] = [:]
    private var counter = 0
    private(set) var playingId: String?     // message currently audible (spans its segments)
    private(set) var playingAuthor: String?
    private var playingSeg: Int?            // segment currently on the player
    private(set) var isPaused = false
    private var rate: Float = 1

    /// Playback-speed cycler (1× / 1.25× / …) applied to the live clip.
    func setRate(_ r: Float) { rate = r; if let p = player { p.enableRate = true; p.rate = r } }
    private var player: AVAudioPlayer?
    private var heartbeat: Timer?

    // MARK: Inbound events

    func enqueueChunk(messageId: String, base64: String, mime: String?, seq: Int?, seg: Int?, text: String?, author: String?) {
        guard let data = Data(base64Encoded: base64) else { return }
        let s = seg ?? 0
        var it = items[messageId] ?? newItem(author: author)
        if it.author == nil { it.author = author }
        if let seq {
            if it.seenSeqs.contains(seq) { items[messageId] = it; return }   // de-dup retransmits
            it.seenSeqs.insert(seq)
        }
        it.segData[s, default: Data()].append(data)
        if let text, it.segText[s] == nil { it.segText[s] = text }
        if s > it.maxSeg { it.maxSeg = s }
        items[messageId] = it
        NSLog("🔊VOICE enqueue mid=\(messageId) seg=\(s) bytes=\(data.count) playing=\(playingId ?? "nil") paused=\(isPaused)")
        pump()
    }

    /// Text stream finished · arm a fallback so a missing `voice-final` (no TTS
    /// credential, chair template, …) never strands the stage.
    func markTextFinal(messageId: String, author: String?) {
        var it = items[messageId] ?? newItem(author: author)
        it.textFinal = true
        if let author { it.author = author }
        guard !it.done else { items[messageId] = it; return }
        it.fallback?.invalidate()
        it.fallback = Timer.scheduledTimer(withTimeInterval: 9, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if var x = self.items[messageId] { x.final = true; self.items[messageId] = x }
                self.pump()
                // Nothing playable + nothing playing → close it out so the
                // orchestrator's voice-done waiter isn't left hanging.
                if self.playingId == nil, self.items[messageId]?.done == false { self.finish(messageId) }
            }
        }
        items[messageId] = it
    }

    func voiceFinal(messageId: String, author: String?) {
        var it = items[messageId] ?? newItem(author: author)
        it.final = true
        if it.author == nil { it.author = author }
        items[messageId] = it
        pump()
    }

    // MARK: Playback scheduling

    /// Advance the queue · play the next ready segment of the head message, or
    /// finish the head once it's fully drained. No-op while a clip is mid-play
    /// or the room is paused.
    private func pump() {
        guard player == nil, !isPaused else { return }
        let ordered = items.filter { !$0.value.done }.sorted { $0.value.order < $1.value.order }
        guard let (id, it) = ordered.first else { return }
        if let seg = nextReadySeg(it) {
            playSegment(id, seg)
        } else if it.final {
            finish(id)                               // final + nothing left → close it, move on
        }
        // else · head still synthesizing this sentence (not sealed yet) → wait.
    }

    /// The next segment of `it` that carries audio and is ready to play. Each seg
    /// IS a complete one-sentence MP3 (the engine's `synthesizeSentenceEmit` emits
    /// one voice-chunk per sentence with its own seg index), so a seg is playable
    /// the instant its data lands — no need to wait for the NEXT seg to "seal" it.
    /// Play-on-arrival is what lets audio start the moment sentence 1 synthesizes
    /// (right as the text finishes streaming) instead of one whole synth-cycle later;
    /// it adds no extra `AVAudioPlayer.play()` starts (still one per seg) — it only
    /// stops DELAYING each one. (The earlier "seal before play" guard was a misfire
    /// from chasing a silence bug that was actually a stale voice credential.)
    /// A missing seg below a higher one (or final) was silent/skipped → advance past
    /// it; a missing cursor seg with nothing newer is still synthesizing → wait.
    private func nextReadySeg(_ it: Item) -> Int? {
        var c = it.playCursor
        while c <= it.maxSeg {
            if it.segData[c] != nil { return c }     // complete MP3 present → play now
            if c < it.maxSeg || it.final { c += 1; continue }   // silent/skipped seg → advance
            return nil                               // cursor's sentence still synthesizing → wait
        }
        return nil
    }

    private func playSegment(_ id: String, _ seg: Int) {
        guard let it = items[id], let blob = it.segData[seg] else { NSLog("🔊VOICE playSegment NO BLOB id=\(id) seg=\(seg)"); return }
        activateSession()
        let firstOfMessage = (playingId != id)
        do {
            let p = try AVAudioPlayer(data: blob)
            p.delegate = self
            p.enableRate = true
            p.rate = rate
            p.volume = 1.0
            p.prepareToPlay()
            player = p
            playingSeg = seg
            NSLog("🔊VOICE playSegment id=\(id) seg=\(seg) bytes=\(blob.count) rate=\(rate) dur=\(p.duration)")
            if firstOfMessage {
                var x = it; x.fallback?.invalidate(); x.fallback = nil; items[id] = x
                playingId = id
                playingAuthor = it.author
                isPaused = false
                heartbeat?.invalidate()
                heartbeat = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated {
                        guard let self, let pid = self.playingId else { return }
                        self.onProgress?(pid)
                    }
                }
                onProgress?(id)        // immediate first heartbeat
                onChange?()            // caption resync · new speaker took the stage
            }
            let ok1 = p.play()
            if !ok1 {
                // Failed to start (audio-session contention from the stage
                // WebView). Re-assert + retry once; if it STILL won't start, skip
                // this sentence so the turn keeps moving instead of stranding.
                activateSession()
                let ok2 = p.play()
                NSLog("🔊VOICE play() ok1=false retry ok2=\(ok2)")
                if !ok2 { segmentFinished(id, seg) ; return }
            } else {
                NSLog("🔊VOICE play() ok1=true (started)")
            }
        } catch {
            NSLog("🔊VOICE AVAudioPlayer init FAILED: \(error)")
            segmentFinished(id, seg)                 // bad MP3 for this sentence · skip it
        }
    }

    /// A segment's clip ended (or was unplayable). Advance the cursor and pump
    /// the next sentence; when the message is final and drained, close it out.
    private func segmentFinished(_ id: String, _ seg: Int) {
        player = nil
        playingSeg = nil
        if var it = items[id] {
            it.playCursor = max(it.playCursor, seg + 1)
            items[id] = it
            if it.final, nextReadySeg(it) == nil { finish(id); return }
        }
        pump()
    }

    private func finish(_ id: String) {
        let wasPlaying = (playingId == id)
        if var it = items[id] { it.done = true; it.fallback?.invalidate(); it.fallback = nil; items[id] = it }
        if wasPlaying {
            heartbeat?.invalidate(); heartbeat = nil
            player = nil; playingId = nil; playingAuthor = nil; playingSeg = nil; isPaused = false
        }
        onDone?(id)
        if wasPlaying { onChange?() }                // caption clear / hand off to next speaker
        pump()
    }

    /// Stop / resume the current clip at once (so a pause tap is silent mid-
    /// sentence). The heartbeat keeps ticking while paused → the server waiter
    /// stays alive and resume continues the same turn.
    func setPaused(_ paused: Bool) {
        isPaused = paused
        if let player {
            if paused { player.pause() } else { player.play() }
        } else if !paused {
            pump()                                   // unpaused between sentences → resume the queue
        }
    }

    // MARK: Caption karaoke (cumulative across the message's sentences)

    /// The spoken text of the playing message, sentences in order. Caption source
    /// — matches the audio exactly (labels the TTS skipped are absent here).
    var captionFull: String {
        guard let id = playingId, let it = items[id] else { return "" }
        return it.segText.keys.sorted().compactMap { it.segText[$0] }.joined()
    }

    /// How many chars of `captionFull` have been voiced · completed sentences in
    /// full plus the current sentence scaled by the live clip's progress.
    var captionRevealed: Int {
        guard let id = playingId, let it = items[id] else { return 0 }
        var chars = 0
        for s in it.segText.keys.sorted() {
            if let cur = playingSeg, s == cur {
                if let t = it.segText[s], let p = player, p.duration > 0 {
                    chars += Int(Double(t.count) * min(1, max(0, p.currentTime / p.duration)))
                }
                break
            }
            if let cur = playingSeg, s > cur { break }
            chars += it.segText[s]?.count ?? 0       // already-voiced sentence
        }
        return chars
    }

    /// Per-sentence karaoke source · each voice-chunk is exactly ONE sentence with
    /// its OWN clip, so the live caption is just the sentence on the player now,
    /// revealed char-by-char by that clip's progress — the robust equivalent of
    /// the web's `captionFollowAudio` (no fragile join-then-resplit, which fails
    /// for CJK sentences that carry no inter-sentence whitespace). Returns the
    /// current sentence + how many of its leading chars have been voiced; nil
    /// between segments (brief gap) so the caption holds its last frame.
    var captionSegment: (text: String, revealed: Int)? {
        guard let id = playingId, let it = items[id], let seg = playingSeg,
              let t = it.segText[seg], !t.isEmpty else { return nil }
        let frac: Double = (player?.duration ?? 0) > 0
            ? min(1, max(0, (player!.currentTime) / player!.duration)) : 1
        return (text: t, revealed: Int((Double(t.count) * frac).rounded()))
    }

    /// Leaving mid-turn: ack everything we still owe so the orchestrator advances
    /// immediately instead of waiting out its 60s heartbeat fallback.
    func releaseAndReset() {
        var ids = Set<String>()
        if let playingId { ids.insert(playingId) }
        for (id, it) in items where !it.done { ids.insert(id) }
        ids.forEach { onDone?($0) }
        reset()
    }

    func reset() {
        player?.stop(); player = nil
        heartbeat?.invalidate(); heartbeat = nil
        items.values.forEach { $0.fallback?.invalidate() }
        items.removeAll()
        playingId = nil; playingAuthor = nil; playingSeg = nil; isPaused = false
    }

    // MARK: Helpers

    private func newItem(author: String?) -> Item {
        defer { counter += 1 }
        return Item(author: author, order: counter)
    }

    private func activateSession() {
        #if os(iOS)
        // Re-assert on EVERY clip · the stage WKWebView (voice rooms only) can
        // quietly reset the app's audio session when it loads, which would leave
        // our TTS muted. setCategory/setActive are cheap + idempotent.
        let s = AVAudioSession.sharedInstance()
        do { try s.setCategory(.playback, mode: .spokenAudio) }   // plays through the silent switch + on lock
        catch { NSLog("🔊VOICE activateSession setCategory FAILED: \(error)") }
        do { try s.setActive(true) }
        catch { NSLog("🔊VOICE activateSession setActive FAILED: \(error)") }
        NSLog("🔊VOICE session: cat=\(s.category.rawValue) outVol=\(s.outputVolume) route=\(s.currentRoute.outputs.map(\.portType.rawValue))")
        #endif
    }
}

extension VoicePlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self, let id = self.playingId, let seg = self.playingSeg else { return }
            self.segmentFinished(id, seg)
        }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [weak self] in
            guard let self, let id = self.playingId, let seg = self.playingSeg else { return }
            self.segmentFinished(id, seg)
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  ThinkingSfx · the Swift port of the web shell's "thinking pulse"
//  (typing-sfx.js · setThinking). While a director is framing their reply we
//  loop a soft two-blip cue (G5 784 Hz → B5 988 Hz, ~60 ms apart) on a 1.1 s
//  contemplative cadence — a synthesised in-memory WAV, no bundled asset.
// ════════════════════════════════════════════════════════════════════════════
@MainActor
final class ThinkingSfx {
    private var timer: Timer?
    private var warmup: Timer?
    private static let clip: Data = ThinkingSfx.makePairWav()
    /// ONE prepared player, reused for every blip · creating a fresh
    /// `AVAudioPlayer` per blip raced the audio thread + occasionally returned a
    /// player whose `play()` no-opped, so the cue was silent. A single prepared
    /// instance is the reliable pattern — BUT it can go stale after the stage
    /// WKWebView resets the session on load (the chair's first cue fires exactly
    /// then), so `fire()` rebuilds it on a failed play.
    private static func makePlayer() -> AVAudioPlayer? {
        guard let p = try? AVAudioPlayer(data: Self.clip) else { return nil }
        p.volume = 1.0
        p.prepareToPlay()
        return p
    }
    private lazy var player: AVAudioPlayer? = Self.makePlayer()

    /// Begin looping the cue (idempotent).
    func start() {
        guard timer == nil else { return }
        activateSession()
        fire()
        let t = Timer(timeInterval: 1.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.fire() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        // Warm-up · the chair's FIRST "thinking" cue (on room create / open) fires
        // while the 3D stage WKWebView is loading, which repeatedly resets the app's
        // audio session — so the early blips land silent. Re-ASSERT the session
        // (without playing) every 0.35 s for ~3 s so the 1.1 s blips above land into
        // a live session through the load window. fire() rebuilds a stale player.
        var ticks = 0
        let w = Timer(timeInterval: 0.35, repeats: true) { [weak self] t in
            MainActor.assumeIsolated {
                guard let self else { t.invalidate(); return }
                self.activateSession()
                ticks += 1
                if ticks >= 9 { t.invalidate(); self.warmup = nil }   // ~3 s of coverage
            }
        }
        RunLoop.main.add(w, forMode: .common)
        warmup = w
    }

    func stop() {
        timer?.invalidate(); timer = nil
        warmup?.invalidate(); warmup = nil
        // Don't hard-cut an in-flight blip · the prepared player finishes its
        // clip on its own. A pre-warmed turn can flip thinking on→off within a
        // few ms; hard-stopping here would kill the cue before any audio renders.
    }

    private func activateSession() {
        #if os(iOS)
        // Re-assert the playback session · the stage WKWebView (voice rooms) can
        // reset the app's audio session when it loads, which would otherwise
        // silence the cue. Cheap + idempotent; same config the TTS player uses.
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .spokenAudio)
        try? s.setActive(true)
        #endif
    }

    private func fire() {
        activateSession()
        if player == nil { player = Self.makePlayer() }
        guard let p = player else { return }
        p.currentTime = 0
        if !p.play() {
            // The stage WKWebView's load reset the session AND left this prepared
            // player stale (play() silently no-ops) — exactly the chair's first-cue
            // window. Re-assert the session, rebuild the player, and retry.
            activateSession()
            player = Self.makePlayer()
            _ = player?.play()
        }
    }

    // MARK: Synthesis

    /// Two soft sine blips with a fast attack + exponential decay, rendered to a
    /// 16-bit mono WAV (44.1 kHz). Sine (vs the web's low-passed square) is
    /// already gentle, so it sits under the room ambience without an extra LPF.
    private static func makePairWav() -> Data {
        let sr = 44_100.0
        let n = Int(sr * 0.26)
        var samples = [Int16](repeating: 0, count: n)
        let blips: [(freq: Double, start: Double)] = [(784, 0.0), (988, 0.075)]
        let dur = 0.11, attack = 0.005
        for b in blips {
            let s0 = Int(b.start * sr)
            let len = Int(dur * sr)
            for i in 0..<len {
                let idx = s0 + i
                if idx >= n { break }
                let t = Double(i) / sr
                // Slower decay (22 vs the old 38) so each blip rings + is clearly
                // heard; amplitude 0.7 @ player volume 1.0 — the old 0.28 @ 0.5
                // was ~-17 dB and easy to miss entirely.
                let env = t < attack ? (t / attack) : exp(-(t - attack) * 22.0)
                let v = sin(2.0 * .pi * b.freq * t) * 0.7 * env
                let mixed = Double(samples[idx]) / 32767.0 + v
                samples[idx] = Int16(max(-1.0, min(1.0, mixed)) * 32767.0)
            }
        }
        return makeWav(samples, sampleRate: Int(sr))
    }
}

/// Build a 16-bit mono PCM WAV from samples · shared by ThinkingSfx + RoomSfx.
fileprivate func makeWav(_ samples: [Int16], sampleRate: Int) -> Data {
    func u32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
    func u16(_ v: UInt16) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
    let dataSize = samples.count * 2
    var d = Data()
    d.append(Data("RIFF".utf8)); d.append(u32(UInt32(36 + dataSize))); d.append(Data("WAVE".utf8))
    d.append(Data("fmt ".utf8)); d.append(u32(16)); d.append(u16(1)); d.append(u16(1))
    d.append(u32(UInt32(sampleRate))); d.append(u32(UInt32(sampleRate * 2))); d.append(u16(2)); d.append(u16(16))
    d.append(Data("data".utf8)); d.append(u32(UInt32(dataSize)))
    for s in samples { d.append(u16(UInt16(bitPattern: s))) }
    return d
}

// ════════════════════════════════════════════════════════════════════════════
//  SilentKeepAlive · a continuous, inaudible looping clip that holds the
//  background-audio assertion through the SILENT gaps between director turns.
//  Background audio only keeps the app running WHILE audio is rendering; the
//  thinking cue is intermittent blips (≈0.85 s of silence between), which iOS can
//  treat as "audio stopped" and start throttling/suspending the app on the lock
//  screen — so the NEXT director's LLM+TTS never completes until the user unlocks.
//  Running this volume-0 loop for the whole live/replay session keeps the app fully
//  alive across gaps so the pump + next turn proceed locked. It mixes silently
//  under the real TTS.
// ════════════════════════════════════════════════════════════════════════════
@MainActor
final class SilentKeepAlive {
    private var player: AVAudioPlayer?
    private static let clip: Data = makeWav([Int16](repeating: 0, count: 22_050), sampleRate: 44_100)  // 0.5 s silence

    func start() {
        guard player == nil else { return }
        #if os(iOS)
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .spokenAudio)
        try? s.setActive(true)
        #endif
        guard let p = try? AVAudioPlayer(data: Self.clip) else { return }
        p.numberOfLoops = -1          // loop forever → continuous output, no silent gap
        p.volume = 0
        p.prepareToPlay()
        p.play()
        player = p
    }

    func stop() { player?.stop(); player = nil }
}

// ════════════════════════════════════════════════════════════════════════════
//  RoomSfx · the rest of the web shell's SFX palette (typing-sfx.js), ported to
//  in-memory synthesised WAVs. Desktop fires these for the room's audio texture;
//  the native port previously had only the thinking-blip loop, so director
//  hand-offs felt flat and the chair had no signature when it took the floor.
//    · gavel()         · two wooden strikes · the CHAIR's "knock-knock" when its
//                        audio starts (clarify / convene / round-end / direct).
//    · speakerChange() · a soft 660→990 Hz triangle swoop · a DIRECTOR taking the
//                        floor (scene-cut chime, distinct from the chair's gavel).
//    · tick()          · a 40 ms keyboard click on each streamed token (throttled).
//  Pre-rendered once, reused via prepared `AVAudioPlayer`s (same reliable pattern
//  as ThinkingSfx — fresh players per blip occasionally no-op'd).
// ════════════════════════════════════════════════════════════════════════════
@MainActor
final class RoomSfx {
    private static let gavelClip = RoomSfx.makeGavelWav()
    private static let speakerClip = RoomSfx.makeSpeakerChangeWav()
    private static let tickClip = RoomSfx.makeTickWav()

    private lazy var gavelPlayer = Self.prepared(Self.gavelClip)
    private lazy var speakerPlayer = Self.prepared(Self.speakerClip)
    // The typing tick fires up to ~12×/s · a tiny round-robin of prepared players
    // so a still-ringing click doesn't get cut off when the next one fires.
    private lazy var tickPlayers: [AVAudioPlayer?] = (0..<3).map { _ in Self.prepared(Self.tickClip) }
    private var tickIdx = 0
    private var lastTickAt: CFTimeInterval = 0

    private static func prepared(_ data: Data) -> AVAudioPlayer? {
        guard let p = try? AVAudioPlayer(data: data) else { return nil }
        p.volume = 1.0; p.prepareToPlay(); return p
    }
    private func activateSession() {
        #if os(iOS)
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .spokenAudio)
        try? s.setActive(true)
        #endif
    }
    private func play(_ player: AVAudioPlayer?) {
        activateSession()
        guard let p = player else { return }
        p.currentTime = 0
        if !p.play() { activateSession(); p.play() }
    }

    /// The chair took the floor · fires once when the chair's audio starts.
    func gavel() { play(gavelPlayer) }
    /// A director took the floor · fires once when a director's audio starts.
    func speakerChange() { play(speakerPlayer) }
    /// A streamed token landed · throttled to ≥80 ms apart (desktop MIN_TICK).
    func tick() {
        let now = CACurrentMediaTime()
        guard now - lastTickAt >= 0.08 else { return }
        lastTickAt = now
        let p = tickPlayers[tickIdx]; tickIdx = (tickIdx + 1) % tickPlayers.count
        play(p)
    }

    // MARK: Synthesis (ports of the typing-sfx.js WebAudio graphs → PCM)

    /// 2-pole bandpass (constant-skirt-gain biquad · RBJ cookbook) over a sample
    /// buffer · shapes the gavel/tick noise bursts the way the web's BiquadFilter
    /// does (wooden tap ≈ 3.2 kHz, keyboard click ≈ 2 kHz).
    private static func bandpass(_ x: [Double], f0: Double, q: Double, sr: Double) -> [Double] {
        let w0 = 2.0 * .pi * f0 / sr
        let alpha = sin(w0) / (2.0 * q)
        let b0 = alpha, b1 = 0.0, b2 = -alpha
        let a0 = 1.0 + alpha, a1 = -2.0 * cos(w0), a2 = 1.0 - alpha
        var y = [Double](repeating: 0, count: x.count)
        var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
        for i in 0..<x.count {
            let out = (b0 / a0) * x[i] + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2
            y[i] = out; x2 = x1; x1 = x[i]; y2 = y1; y1 = out
        }
        return y
    }

    private static func toInt16(_ buf: [Double]) -> [Int16] {
        buf.map { Int16(max(-1.0, min(1.0, $0)) * 32767.0) }
    }

    /// Two wooden strikes 160 ms apart · each = a 220→140 Hz sine body (fat 0.005 s
    /// attack, ~0.22 s decay) + a 30 ms band-passed (~3.2 kHz) noise transient.
    private static func makeGavelWav() -> Data {
        let sr = 44_100.0, n = Int(sr * 0.46)
        var buf = [Double](repeating: 0, count: n)
        for offset in [0.0, 0.16] {
            let s0 = Int(offset * sr)
            // body · swept sine via incremental phase
            var phase = 0.0
            let bodyLen = Int(0.25 * sr)
            for i in 0..<bodyLen {
                let idx = s0 + i; if idx >= n { break }
                let t = Double(i) / sr
                let f = 220.0 * pow(140.0 / 220.0, min(1.0, t / 0.18))
                phase += 2.0 * .pi * f / sr
                let env = t < 0.005 ? (t / 0.005) : exp(-(t - 0.005) * 18.0)   // ~0.22 s decay
                buf[idx] += sin(phase) * 0.6 * env
            }
            // transient · band-passed noise burst
            let nLen = Int(0.035 * sr)
            var noise = [Double](repeating: 0, count: nLen)
            for i in 0..<nLen { noise[i] = (Double.random(in: -1...1)) * (1.0 - Double(i) / Double(nLen)) }
            let shaped = bandpass(noise, f0: 3200, q: 0.8, sr: sr)
            for i in 0..<nLen {
                let idx = s0 + i; if idx >= n { break }
                let t = Double(i) / sr
                let env = t < 0.003 ? (t / 0.003) : exp(-(t - 0.003) * 90.0)
                buf[idx] += shaped[i] * 0.4 * env
            }
        }
        return makeWav(toInt16(buf), sampleRate: Int(sr))
    }

    /// Soft triangle swoop 660→990 Hz over 70 ms, then hold while a ~0.22 s gain
    /// envelope fades · the director scene-cut chime.
    private static func makeSpeakerChangeWav() -> Data {
        let sr = 44_100.0, dur = 0.22, n = Int(sr * dur)
        var buf = [Double](repeating: 0, count: n)
        var phase = 0.0
        for i in 0..<n {
            let t = Double(i) / sr
            let f = t < 0.07 ? 660.0 * pow(990.0 / 660.0, t / 0.07) : 990.0
            phase += 2.0 * .pi * f / sr
            let tri = 2.0 / .pi * asin(sin(phase))                       // triangle
            let env = t < 0.01 ? (t / 0.01) : exp(-(t - 0.01) * 16.0)
            buf[i] = tri * 0.42 * env
        }
        return makeWav(toInt16(buf), sampleRate: Int(sr))
    }

    /// 40 ms band-passed (~2 kHz) white-noise click · the keyboard tap on a token.
    private static func makeTickWav() -> Data {
        let sr = 44_100.0, n = Int(sr * 0.06)
        var noise = [Double](repeating: 0, count: n)
        for i in 0..<n { noise[i] = (Double.random(in: -1...1)) * (1.0 - Double(i) / Double(n)) }
        var buf = bandpass(noise, f0: 2000, q: 1.4, sr: sr)
        for i in 0..<n {
            let t = Double(i) / sr
            let env = t < 0.002 ? (t / 0.002) : exp(-(t - 0.002) * 70.0)
            buf[i] *= 0.3 * env
        }
        return makeWav(toInt16(buf), sampleRate: Int(sr))
    }
}
