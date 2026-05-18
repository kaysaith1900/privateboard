/* ────────────────────────────────────────────────────────────────
   typing-sfx.js · Subtle keyboard-click sound effect played as
   directors / chair / brief writer stream their text into the
   chat. Pure synthesised audio · no asset to ship, no autoplay
   policy violations until the user has clicked something.

   Wire-up:
     · public/index.html loads this before public/app.js.
     · app.js calls window.boardroomTypingSfx.tick() on every
       `message-token` and `brief-token` SSE chunk.
     · The user-settings overlay's User pane carries an enable /
       disable toggle that persists in localStorage.

   Design choices the comments below justify:
     · Synthesised, not file-based · removes a network round-trip
       and keeps the install slim. The synth is a 40ms decaying
       white-noise burst routed through a bandpass at ~1.8kHz with
       slight per-tick frequency jitter so the cadence doesn't
       fatigue the ear like a metronome.
     · Lazily-created AudioContext · Chrome / Safari refuse to
       resume a context until the page has received a real user
       gesture. We hold off creation until tick() is first called
       AFTER the first interaction; otherwise the first audible
       tick would be a console warning instead of a sound.
     · Throttled to ~12 ticks/sec · token rates of 30-60/s would
       otherwise produce a continuous hiss instead of a typewriter
       cadence. The throttle stays steady regardless of token rate,
       which is the right behaviour: the sound is a presence cue,
       not a literal mapping to byte arrival.
     · Muted while the tab is backgrounded · browsers throttle audio
       there anyway, but explicit muting avoids the rare case where
       a queued AudioBufferSourceNode plays right when the tab
       refocuses.
   ──────────────────────────────────────────────────────────────── */

(function () {
  const STORAGE_KEY = "boardroom.sfx.typing";
  // Default ON · the user explicitly asked for this feature. They
  // can disable it via the Preference → User pane toggle.
  const DEFAULT_ENABLED = true;
  // Minimum gap between ticks. Set the tick rate; lower = busier.
  // 80ms ≈ 12.5 Hz — fast typist cadence, not a chattering buzz.
  const MIN_TICK_INTERVAL_MS = 80;

  let _ctx = null;
  let _ctxFailed = false;
  let _hadGesture = false;
  let _enabled = readEnabled();
  let _lastTickAt = 0;

  function readEnabled() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === "on") return true;
      if (raw === "off") return false;
    } catch { /* private mode etc · default-on still applies */ }
    return DEFAULT_ENABLED;
  }

  function writeEnabled(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? "on" : "off"); }
    catch { /* swallow · localStorage may be locked */ }
  }

  /** Mark that the user has interacted with the page · only after
   *  this fires can we safely create / resume an AudioContext.
   *  Listeners are passive + once-per-event-type for cheapness. */
  function markGesture() {
    _hadGesture = true;
    // If a context was created pre-gesture (some browsers allow it
    // but leave it suspended), nudge it now.
    if (_ctx && _ctx.state === "suspended") {
      _ctx.resume().catch(() => { /* swallow · keep silent rather than throw */ });
    }
  }
  ["pointerdown", "keydown", "touchstart"].forEach((ev) => {
    window.addEventListener(ev, markGesture, { passive: true, capture: true });
  });

  function ensureContext() {
    if (_ctxFailed) return null;
    if (_ctx) {
      // Resume on EVERY call when suspended · we proactively suspend
      // the context between SFX bursts (see `releaseContextSoon`) to
      // release the audio session for the HTMLAudioElement TTS path.
      // Without this re-check, a context suspended for TTS would
      // stay silent on the next tick/blip/gavel.
      if (_ctx.state === "suspended") {
        _ctx.resume().catch(() => { /* swallow */ });
      }
      return _ctx;
    }
    if (!_hadGesture) return null; // refuse to create until gestured
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { _ctxFailed = true; return null; }
      _ctx = new Ctx();
      // If autoplay policy left it suspended even after gesture,
      // resume explicitly · safe to call multiple times.
      if (_ctx.state === "suspended") {
        _ctx.resume().catch(() => { /* swallow */ });
      }
      return _ctx;
    } catch {
      _ctxFailed = true;
      return null;
    }
  }

  /** Suspend the AudioContext shortly after `setThinking(false)` so
   *  the system audio session is released for the HTMLAudioElement
   *  TTS path. Browsers (Safari / iOS especially) treat a "running"
   *  AudioContext as the active audio source; an `<audio>` element
   *  starting `play()` against that state can be blocked or silently
   *  routed away.
   *
   *  We don't suspend instantly · a small grace lets the thinking
   *  fade-out finish without click. */
  let _releaseTimer = null;
  function releaseContextSoon() {
    if (!_ctx) return;
    if (_releaseTimer) { clearTimeout(_releaseTimer); _releaseTimer = null; }
    _releaseTimer = setTimeout(() => {
      _releaseTimer = null;
      // Only suspend when nothing has restarted the loop in the
      // meantime · belt-and-suspenders against rapid toggle races.
      if (!_thinkingInterval && _ctx && _ctx.state === "running") {
        _ctx.suspend().catch(() => { /* swallow */ });
      }
    }, 200);
  }

  function cancelRelease() {
    if (_releaseTimer) { clearTimeout(_releaseTimer); _releaseTimer = null; }
  }

  function tick() {
    if (!_enabled) return;
    if (document.visibilityState !== "visible") return; // background tab
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (now - _lastTickAt < MIN_TICK_INTERVAL_MS) return;
    const ctx = ensureContext();
    if (!ctx) return;
    _lastTickAt = now;

    const t0 = ctx.currentTime;
    // 40ms of decaying white noise · the click texture comes from
    // the noise burst itself, the bandpass below shapes its colour.
    const dur = 0.04;
    const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      // Linear amplitude decay across the buffer · gives the click
      // a natural "tap then fade" envelope before the gain node's
      // own envelope fine-tunes the start.
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;

    // Bandpass · keyboard-tap colour is mostly 1.5-3kHz. Jitter the
    // centre frequency a little per tick so consecutive clicks
    // don't sound mechanically identical.
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1700 + Math.random() * 800;
    bp.Q.value = 1.4;

    // Master envelope · 2ms attack, exponential 50ms decay. Quiet
    // peak (gain ~0.06) so the cue stays under the user's voice
    // floor instead of becoming the loudest thing on screen.
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.06, t0 + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);

    noise.connect(bp).connect(gain).connect(ctx.destination);
    noise.start(t0);
    noise.stop(t0 + 0.06);
  }

  /** Speaker-change cue · fires once when the round-table stage flips
   *  to a new speaker (idle → A, A → B). A short triangle-wave swoop
   *  at ~660 → 990 Hz, decaying over ~220ms — distinct from the
   *  keyboard-click texture of `tick()` so the ear reads it as a
   *  scene transition rather than typing. Same enabled-flag and
   *  AudioContext as tick · the user-settings toggle controls both. */
  function speakerChange() {
    if (!_enabled) return;
    if (document.visibilityState !== "visible") return;
    const ctx = ensureContext();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const dur = 0.22;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    // Brief upward sweep · 660Hz → 990Hz across the first 70ms, then
    // hold while the gain envelope fades. Triangle waveform reads as
    // softer / more "chime"-like than sine for this register.
    osc.frequency.setValueAtTime(660, t0);
    osc.frequency.exponentialRampToValueAtTime(990, t0 + 0.07);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.085, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur);
  }

  /** Director thinking cue · loops the original 8-bit "blip-blip"
   *  pair while a voice-room seat shows the thought-bubble. Each
   *  cycle: two pulse-wave blips spaced 60 ms apart (G5 → B5, a
   *  minor third up · reads as "thought lifting"), each blip about
   *  60 ms long with a fast attack and exponential decay. Cycles
   *  repeat every ~1100 ms — generous silence between pairs so the
   *  rhythm feels like classic NES dialog blips, not an alarm.
   *
   *  Per-blip oscillator creation is recreated on each tick · the
   *  earlier TTS conflict turned out to be a missing TTS provider
   *  key, not AudioContext churn, so we can safely use setInterval
   *  for the loop. */
  let _thinkingInterval = null;
  let _thinkingPhase = 0;

  function _playThinkingPair() {
    if (!_enabled) { setThinking(false); return; }
    if (document.visibilityState !== "visible") return;
    const ctx = ensureContext();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    // Two blips · G5 (784 Hz) then B5 (988 Hz). 60 ms gap between
    // blip starts so the ear hears them as a pair, not a chord.
    // Phase-flip every cycle (B5→G5 alternation across cycles)
    // adds slight melodic interest, like a thinker switching gears.
    const ascending = _thinkingPhase % 2 === 0;
    _thinkingPhase = (_thinkingPhase + 1) % 1024;
    const blips = ascending
      ? [{ freq: 784, start: 0.000 }, { freq: 988, start: 0.060 }]
      : [{ freq: 988, start: 0.000 }, { freq: 784, start: 0.060 }];
    for (const b of blips) {
      const t = t0 + b.start;
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = b.freq;
      // Low-pass softens the harsh square edges so the blip sits
      // in the room ambience rather than slicing through it.
      const lpf = ctx.createBiquadFilter();
      lpf.type = "lowpass";
      lpf.frequency.value = 4500;
      lpf.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.05, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      osc.connect(lpf).connect(gain).connect(ctx.destination);
      osc.start(t);
      const stopAt = t + 0.08;
      osc.stop(stopAt);
      // Cleanup · disconnect after stop so GainNodes aren't retained
      // across hundreds of blips on a long thinking phase.
      osc.onended = () => {
        try { osc.disconnect(); } catch { /* ignore */ }
        try { lpf.disconnect(); } catch { /* ignore */ }
        try { gain.disconnect(); } catch { /* ignore */ }
      };
    }
  }

  function setThinking(on) {
    if (on) {
      cancelRelease();
      if (_thinkingInterval) return;       // already looping · idempotent
      if (!_enabled) return;
      // First pair immediately so the user hears feedback the moment
      // the bubble appears; subsequent pairs on a ~1100 ms cadence.
      // 1100 ms (~0.9 Hz) is intentionally slow — earlier 700 ms /
      // 1.4 Hz read as an alarm tempo; this sits closer to a
      // contemplative NES dialog cadence.
      _thinkingPhase = 0;
      _playThinkingPair();
      _thinkingInterval = setInterval(_playThinkingPair, 1100);
    } else {
      if (!_thinkingInterval) return;
      clearInterval(_thinkingInterval);
      _thinkingInterval = null;
      _thinkingPhase = 0;
      // Suspend the AudioContext after a brief grace so the audio
      // session is fully released for any HTMLAudioElement TTS that
      // might be about to play. ensureContext resumes automatically
      // on the next SFX call.
      releaseContextSoon();
    }
  }

  /** Chair gavel cue · fires before chair voice playback begins in
   *  voice mode. Two-strike wooden knock that reads as "court is in
   *  session — listen up." Designed by ear:
   *    · Layer 1 · low sine ~190 Hz, 1ms attack + 220ms decay,
   *      gives the bass "thunk" of wood on wood.
   *    · Layer 2 · filtered noise burst at ~3.2 kHz, 30ms total,
   *      provides the sharp percussive transient.
   *    · Two strikes 160ms apart so the ear hears a deliberate
   *      "knock-knock" pattern (single strike read as a glitch /
   *      typewriter chime in early prototyping). */
  function gavel() {
    if (!_enabled) return;
    if (document.visibilityState !== "visible") return;
    const ctx = ensureContext();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const strikes = [0, 0.16];
    for (const offset of strikes) {
      const t = t0 + offset;
      // Body resonance · low sine, fat envelope.
      const body = ctx.createOscillator();
      body.type = "sine";
      body.frequency.setValueAtTime(220, t);
      body.frequency.exponentialRampToValueAtTime(140, t + 0.18);
      const bodyGain = ctx.createGain();
      bodyGain.gain.setValueAtTime(0.0001, t);
      bodyGain.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      body.connect(bodyGain).connect(ctx.destination);
      body.start(t);
      body.stop(t + 0.25);
      // Transient click · 30ms filtered noise burst.
      const noiseBuf = ctx.createBuffer(
        1,
        Math.max(1, Math.floor(ctx.sampleRate * 0.03)),
        ctx.sampleRate,
      );
      const noiseData = noiseBuf.getChannelData(0);
      for (let i = 0; i < noiseData.length; i++) {
        noiseData[i] = (Math.random() * 2 - 1) * (1 - i / noiseData.length);
      }
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 3200;
      bp.Q.value = 0.8;
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.0001, t);
      noiseGain.gain.exponentialRampToValueAtTime(0.10, t + 0.003);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
      noise.connect(bp).connect(noiseGain).connect(ctx.destination);
      noise.start(t);
      noise.stop(t + 0.05);
    }
  }

  /** Continue / vote auto-fire countdown beep · fires once per second
   *  on the 10 → 1 visible tick so the user feels the timer urgency
   *  audibly, not just visually. Two tiers:
   *    · seconds 10-4 · low square-wave (~600 Hz), 50 ms, quiet — a
   *      steady "metronome" tick that's clearly background.
   *    · seconds 3-1  · higher square-wave (~880 Hz), 80 ms, louder —
   *      the "3-2-1!" alarm register that signals imminent fire.
   *  Second 0 is skipped here; the auto-continue action that fires
   *  on hit-zero has its own UX (the room moves on). Low-pass keeps
   *  the square edges from slicing through, same approach as the
   *  thinking-blip pair. */
  function countdownTick(secondsLeft) {
    if (!_enabled) return;
    if (document.visibilityState !== "visible") return;
    if (typeof secondsLeft !== "number" || secondsLeft <= 0) return;
    const ctx = ensureContext();
    if (!ctx) return;

    const urgent = secondsLeft <= 3;
    const freq = urgent ? 880 : 600;
    const dur = urgent ? 0.08 : 0.05;
    const peak = urgent ? 0.075 : 0.045;

    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = freq;
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 4000;
    lpf.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(lpf).connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    osc.onended = () => {
      try { osc.disconnect(); } catch { /* ignore */ }
      try { lpf.disconnect(); } catch { /* ignore */ }
      try { gain.disconnect(); } catch { /* ignore */ }
    };
  }

  function setEnabled(on) {
    _enabled = !!on;
    writeEnabled(_enabled);
    // Stop any in-flight thinking loop when SFX gets disabled · we
    // don't want a stale setInterval ticking silently and resuming
    // audio the moment the user toggles back on inside the same
    // thinking phase. Re-entry happens cleanly via the next
    // `setThinking(true)` call from the render loop.
    if (!_enabled) setThinking(false);
    // No-op for AudioContext when disabling · stays alive cheaply
    // (a few KB) and an outright close() leaves us re-paying the
    // creation cost if the user toggles back on within the session.
  }

  function isEnabled() { return _enabled; }

  // Public surface · attached to window so app.js (and the
  // user-settings toggle) can reach it without an import.
  window.boardroomTypingSfx = { tick, speakerChange, setThinking, gavel, countdownTick, setEnabled, isEnabled };
})();
