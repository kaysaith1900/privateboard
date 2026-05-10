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
    if (_ctx) return _ctx;
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

  function setEnabled(on) {
    _enabled = !!on;
    writeEnabled(_enabled);
    // No-op when disabling · live AudioContext stays alive cheaply
    // (a few KB) and an outright close() leaves us re-paying the
    // creation cost if the user toggles back on within the session.
  }

  function isEnabled() { return _enabled; }

  // Public surface · attached to window so app.js (and the
  // user-settings toggle) can reach it without an import.
  window.boardroomTypingSfx = { tick, speakerChange, setEnabled, isEnabled };
})();
