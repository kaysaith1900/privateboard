/* ────────────────────────────────────────────────────────────────
   agent-build-bgm.js · INTERMITTENT 8-bit scanner pings played
   during agent-creation flows (Signal-mode `_runAgentSpecGeneration`
   AND Full-persona `personaJob` builds). Reads as "a small robot
   is scanning a human brain" · a discrete ping every ~3 seconds,
   silent between pings, so it never crosses the line into BGM
   territory and never becomes background drone.

   Earlier versions tried sustained palettes (sweep-radar drone,
   then a chiptune arpeggio loop) · both felt continuous which
   made the brain treat them as noise rather than as scanner
   feedback. This version fires a single brief sweep every ~3 s,
   complete silence between, so each ping is heard as a discrete
   event that confirms "the scanner is working."

   Public surface · window.boardroomAgentBuildBgm:
     · start()    · idempotent · install scheduler + first ping
     · stop()     · idempotent · fade out + tear down
     · isPlaying()· boolean state for diagnostics

   Sound design (per scan ping, ~1 second):
     · Rising sweep   · square wave exponential 220 Hz → 2000 Hz
                        over 0.45 s · the canonical 8-bit "scan
                        rising" gesture. Square at this pitch range
                        sounds unmistakably "8-bit retro lab".
     · Apex lock-on   · 0.10 s hold at 2000 Hz with a 14 Hz square
                        vibrato modulating ±40 Hz · the brief
                        "scanner has locked onto a frequency band"
                        moment. Without this the up/down sweep
                        sounds like a generic siren.
     · Falling sweep  · 2000 Hz → 600 Hz over 0.25 s · the return
                        leg of the scan, mirroring radar/sonar
                        "ping returning" feel.
     · Noise crackle  · filtered noise (bandpass Q 10) whose centre
                        frequency tracks the sweep (400 → 3500 →
                        800 Hz) · sits ~⅓ the level of the square ·
                        adds the "electromagnetic" texture without
                        becoming hissy.
     · Short delay    · 0.32 s with 0.42 feedback, 1.8 kHz LPF on
                        the feedback chain · the ping decays into
                        2-3 fainter echoes (full silence again by
                        ~2 s in), giving the "radar return"
                        ambience. Echoes fully decay before the
                        next scan fires.
     · Master low-pass· 4 kHz lowpass tames the square's high
                        harmonics so the ping reads as "lab
                        scanner" rather than "buzzer".

   Cadence:
     · First ping fires ~50 ms after start() (lets the master
       fade-in begin first so the very first ping rides up with
       the master gain · feels like the scanner powering on).
     · Subsequent pings every 3.0-3.4 s (slight jitter so a long
       build doesn't feel metronome-rigid).
     · Scans are scheduled ahead by ~6 s via setInterval(2000) so
       the queue stays warm without bloating the AudioParam event
       list.

   Gating · the SAME global toggle as `typing-sfx.js`
   (`boardroom.sfx.typing`, surfaced as "Sound effects" in User
   Settings). When that's OFF, this BGM is silent regardless of
   call frequency.

   Gesture gate · same pattern as typing-sfx.js: AudioContext is
   created lazily on the first `start()` call that follows a user
   gesture. If `start()` is called pre-gesture, the start is
   deferred via the gesture listener.

   Defensive shell · EVERY external entry point (start, stop,
   isPlaying, markGesture) is wrapped in an outer try/catch so a
   broken audio pipeline can never propagate up to the caller's
   click handler. The persona-build click handler synchronously
   triggers `_syncAgentBuildBgm` → `start()`; if a hostile audio
   environment threw an unhandled error here, the caller's flow
   would die mid-click. The catches below make that impossible.
   ──────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  /* ─── State ─── */
  let _ctx = null;
  let _ctxFailed = false;
  let _hadGesture = false;
  let _pendingStart = false;
  let _running = false;
  let _moduleBroken = false;   // sticky kill-switch · set if anything
                               // in start/stop/buildGraph throws hard
                               // enough to escape an inner try. Once
                               // set, all entry points become no-ops.
  /** Audio graph references kept alive while playing · cleared in
   *  stop() so the GC can reclaim the nodes. */
  let _nodes = null;

  /* ─── Timing constants ─── */
  const SCAN_PERIOD_MIN = 3.0;
  const SCAN_PERIOD_MAX = 3.4;
  const SCHED_HORIZON_S = 6.0;
  const SCHED_TICK_MS = 2000;

  function readGlobalSfxEnabled() {
    try {
      if (typeof window.boardroomTypingSfx?.isEnabled === "function") {
        return window.boardroomTypingSfx.isEnabled();
      }
    } catch { /* fall through */ }
    return true;
  }

  function markGesture() {
    // Outer guard · this fires on every pointerdown / keydown /
    // touchstart in the document (capture phase). ANY exception
    // here would silently break event dispatch for downstream
    // listeners on the same event in some browsers, so we triple-
    // belt it. The _moduleBroken sentinel makes this a no-op if
    // start() has already poisoned the module.
    try {
      if (_moduleBroken) return;
      _hadGesture = true;
      if (_ctx && _ctx.state === "suspended") {
        try { _ctx.resume().catch(() => { /* swallow */ }); } catch { /* */ }
      }
      if (_pendingStart && readGlobalSfxEnabled()) {
        _pendingStart = false;
        start();
      }
    } catch { _moduleBroken = true; }
  }
  try {
    ["pointerdown", "keydown", "touchstart"].forEach((ev) => {
      window.addEventListener(ev, markGesture, { passive: true, capture: true });
    });
  } catch { _moduleBroken = true; }

  function ensureContext() {
    if (_ctxFailed) return null;
    if (_ctx) {
      if (_ctx.state === "suspended") {
        try { _ctx.resume().catch(() => { /* */ }); } catch { /* */ }
      }
      return _ctx;
    }
    if (!_hadGesture) return null;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { _ctxFailed = true; return null; }
      _ctx = new Ctx();
      if (_ctx.state === "suspended") {
        try { _ctx.resume().catch(() => { /* */ }); } catch { /* */ }
      }
      return _ctx;
    } catch {
      _ctxFailed = true;
      return null;
    }
  }

  /* ─── One scan ping ─── built per-event so oscillators auto-clean
   *  via their scheduled .stop(). Nothing is retained on _nodes.
   *  Each invocation is wrapped in try/catch in the caller; this
   *  helper assumes the inputs are valid (the caller already
   *  verified ctx exists). */
  function fireScan(ctx, dry, wet, startAt) {
    /* ── Voice 1: Square wave swept up, held, swept down ── */
    const sweepOsc = ctx.createOscillator();
    sweepOsc.type = "square";
    sweepOsc.frequency.setValueAtTime(220, startAt);
    sweepOsc.frequency.exponentialRampToValueAtTime(2000, startAt + 0.45);
    sweepOsc.frequency.setValueAtTime(2000, startAt + 0.55);
    sweepOsc.frequency.exponentialRampToValueAtTime(600, startAt + 0.80);
    sweepOsc.frequency.exponentialRampToValueAtTime(220, startAt + 0.95);

    const sweepGain = ctx.createGain();
    sweepGain.gain.setValueAtTime(0.0001, startAt);
    sweepGain.gain.exponentialRampToValueAtTime(0.10, startAt + 0.01);
    sweepGain.gain.setValueAtTime(0.10, startAt + 0.55);
    sweepGain.gain.exponentialRampToValueAtTime(0.08, startAt + 0.80);
    sweepGain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.95);
    sweepOsc.connect(sweepGain);
    sweepGain.connect(dry);
    sweepGain.connect(wet);

    /* ── Vibrato LFO · only active during the apex hold ── */
    const vibLfo = ctx.createOscillator();
    vibLfo.type = "square";
    vibLfo.frequency.value = 14;
    const vibDepth = ctx.createGain();
    vibDepth.gain.setValueAtTime(0, startAt);
    vibDepth.gain.setValueAtTime(0, startAt + 0.42);
    vibDepth.gain.linearRampToValueAtTime(40, startAt + 0.50);
    vibDepth.gain.setValueAtTime(40, startAt + 0.55);
    vibDepth.gain.linearRampToValueAtTime(0, startAt + 0.62);
    vibLfo.connect(vibDepth).connect(sweepOsc.frequency);

    /* ── Voice 2: Bandpass-tracked noise crackle ── */
    const noiseLen = Math.floor(ctx.sampleRate * 1.0);
    const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const noiseData = noiseBuf.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) {
      noiseData[i] = (Math.random() * 2 - 1) * 0.4;
    }
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = noiseBuf;

    const noiseBp = ctx.createBiquadFilter();
    noiseBp.type = "bandpass";
    noiseBp.Q.value = 10;
    noiseBp.frequency.setValueAtTime(400, startAt);
    noiseBp.frequency.exponentialRampToValueAtTime(3500, startAt + 0.45);
    noiseBp.frequency.setValueAtTime(3500, startAt + 0.55);
    noiseBp.frequency.exponentialRampToValueAtTime(800, startAt + 0.80);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, startAt);
    noiseGain.gain.exponentialRampToValueAtTime(0.035, startAt + 0.02);
    noiseGain.gain.setValueAtTime(0.035, startAt + 0.55);
    noiseGain.gain.exponentialRampToValueAtTime(0.025, startAt + 0.80);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.92);

    noiseSrc.connect(noiseBp).connect(noiseGain);
    noiseGain.connect(dry);
    noiseGain.connect(wet);

    sweepOsc.start(startAt);
    sweepOsc.stop(startAt + 1.1);
    vibLfo.start(startAt);
    vibLfo.stop(startAt + 1.1);
    noiseSrc.start(startAt);
    noiseSrc.stop(startAt + 1.0);
  }

  /* ─── Build the persistent part of the audio graph ─── */
  function buildGraph(ctx) {
    const t0 = ctx.currentTime;

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t0);
    master.connect(ctx.destination);

    const masterLp = ctx.createBiquadFilter();
    masterLp.type = "lowpass";
    masterLp.frequency.value = 4000;
    masterLp.Q.value = 0.5;
    masterLp.connect(master);

    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = 0.32;
    const delayFb = ctx.createGain();
    delayFb.gain.value = 0.42;
    const delayLp = ctx.createBiquadFilter();
    delayLp.type = "lowpass";
    delayLp.frequency.value = 1800;
    delayLp.Q.value = 0.5;
    delay.connect(delayLp).connect(delayFb).connect(delay);
    delay.connect(masterLp);

    let nextScan = t0 + 0.05;
    function pushScans() {
      try {
        if (_moduleBroken) return;
        if (!_ctx || _ctx.state === "closed") return;
        const horizon = ctx.currentTime + SCHED_HORIZON_S;
        let safetyHops = 32;   // can't loop more than this many scans
                               // per tick; bounds the work if currentTime
                               // ever jumps wildly (e.g. tab-restore).
        while (nextScan < horizon && safetyHops-- > 0) {
          fireScan(ctx, masterLp, delay, nextScan);
          nextScan += SCAN_PERIOD_MIN +
                      Math.random() * (SCAN_PERIOD_MAX - SCAN_PERIOD_MIN);
        }
      } catch { /* graph torn down · ignore */ }
    }
    pushScans();
    const scanTimer = setInterval(pushScans, SCHED_TICK_MS);

    return {
      master, masterLp,
      delay, delayFb, delayLp,
      scanTimer,
    };
  }

  function teardownGraph(nodes, ctx) {
    if (!nodes) return;
    try { if (nodes.scanTimer) clearInterval(nodes.scanTimer); } catch { /* */ }
    for (const key of Object.keys(nodes)) {
      const n = nodes[key];
      try { n?.disconnect?.(); } catch { /* */ }
    }
  }

  /* ─── Public API ─── */
  function start() {
    // Outer guard · this is called synchronously from the persona
    // confirm-button click handler (via `_syncAgentBuildBgm`). The
    // caller already wraps in try/catch, but a hard belt-and-braces
    // layer here ensures the click can NEVER be blocked by audio
    // graph weirdness. _moduleBroken sticks once tripped so we
    // don't keep retrying a broken pipeline.
    try {
      if (_moduleBroken) return;
      if (_running) return;
      if (!readGlobalSfxEnabled()) return;
      const ctx = ensureContext();
      if (!ctx) {
        _pendingStart = true;
        return;
      }
      try {
        _nodes = buildGraph(ctx);
        const t = ctx.currentTime;
        const targetGain = 0.10;
        _nodes.master.gain.exponentialRampToValueAtTime(targetGain, t + 1.0);
        _running = true;
      } catch {
        try { teardownGraph(_nodes, ctx); } catch { /* */ }
        _nodes = null;
        _running = false;
      }
    } catch {
      _moduleBroken = true;
    }
  }

  function stop() {
    try {
      _pendingStart = false;
      if (_moduleBroken) return;
      if (!_running || !_ctx || !_nodes) {
        _pendingStart = false;
        return;
      }
      const ctx = _ctx;
      const stale = _nodes;
      _nodes = null;
      _running = false;
      try { if (stale.scanTimer) clearInterval(stale.scanTimer); } catch { /* */ }
      try {
        const t = ctx.currentTime;
        stale.master.gain.cancelScheduledValues(t);
        stale.master.gain.setValueAtTime(stale.master.gain.value, t);
        stale.master.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
      } catch { /* */ }
      setTimeout(() => {
        try { teardownGraph(stale, ctx); } catch { /* */ }
      }, 1000);
    } catch {
      _moduleBroken = true;
    }
  }

  function isPlaying() {
    try { return _running && !_moduleBroken; } catch { return false; }
  }

  window.boardroomAgentBuildBgm = { start, stop, isPlaying };
})();
