/* ────────────────────────────────────────────────────────────────
   agent-build-bgm.js · Sci-fi SCANNING palette played during
   agent-creation flows (Signal-mode `_runAgentSpecGeneration` AND
   Full-persona `personaJob` builds). Reads as "the system is
   scanning the search space" — a slow radar/sonar sweep with deep
   echoey tail. Earlier meditative drone gave users a headache
   (gain LFO chopping + sustained pad layered too dense); this
   version trades the drone for movement, with quieter overall
   level and no rhythmic chopping.

   Public surface · window.boardroomAgentBuildBgm:
     · start()    · idempotent · build audio graph + fade in
     · stop()     · idempotent · fade out + tear down
     · isPlaying()· boolean state for diagnostics

   Sound design (scanning palette):
     · Sweep ping · sine carrier whose frequency rises from 400 Hz
                    to ~1200 Hz over each 2.5 s cycle then snaps
                    back · driven by a sawtooth LFO. Classic radar
                    sweep. The audible motion IS the audio.
     · Sub presence · sine 80 Hz at low volume, constant · gives
                      the scanner a "machine is online" foundation
                      without adding a drone the ear fixates on.
     · Counter sweep · a second sine that sweeps DOWN (1100 Hz →
                       350 Hz) in counter-phase with the main · the
                       two crossing pitches read as "two scanners
                       triangulating". Half the level of the main.
     · Long delay  · 0.55 s with 0.22 feedback, low-pass 2 kHz on
                     the feedback chain · the ping decays into
                     fainter echoes, creating spaciousness without
                     adding new tones.
     · Master gain · peak 0.035 (slightly quieter than the previous
                     0.04 drone). The pitch motion is more salient
                     than steady drone gain, so the same loudness
                     would read as too loud.
     · NO gain-LFO chopping. NO tremolo. NO shimmer layer. Those
       three together produced the "headache" report on v1 ·
       removed entirely here. Movement comes purely from the
       pitch sweep + the delay tail.

   Gating · the SAME global toggle as `typing-sfx.js`
   (`boardroom.sfx.typing`, surfaced as "Sound effects" in User
   Settings). When that's OFF, this BGM is silent regardless of
   call frequency. The caller (`_syncAgentBuildBgm` in app.js)
   decides WHEN to call start/stop based on composer state +
   build status; this module just plays / doesn't play.

   Gesture gate · same pattern as typing-sfx.js: AudioContext is
   created lazily on the first `start()` call that follows a user
   gesture. If `start()` is called pre-gesture, the start is
   deferred via the gesture listener.
   ──────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  /* ─── State ─── */
  let _ctx = null;
  let _ctxFailed = false;
  let _hadGesture = false;
  let _pendingStart = false;
  let _running = false;
  /** Audio graph references kept alive while playing · cleared in
   *  stop() so the GC can reclaim the nodes. */
  let _nodes = null;

  function readGlobalSfxEnabled() {
    try {
      if (typeof window.boardroomTypingSfx?.isEnabled === "function") {
        return window.boardroomTypingSfx.isEnabled();
      }
    } catch { /* fall through */ }
    // If the typing-sfx module hasn't loaded yet, default to ON ·
    // the caller already gated on a build being active, so this
    // is a soft permissive default. Once typing-sfx is around the
    // real toggle wins.
    return true;
  }

  function markGesture() {
    _hadGesture = true;
    if (_ctx && _ctx.state === "suspended") {
      _ctx.resume().catch(() => { /* swallow */ });
    }
    if (_pendingStart && readGlobalSfxEnabled()) {
      _pendingStart = false;
      start();
    }
  }
  ["pointerdown", "keydown", "touchstart"].forEach((ev) => {
    window.addEventListener(ev, markGesture, { passive: true, capture: true });
  });

  function ensureContext() {
    if (_ctxFailed) return null;
    if (_ctx) {
      if (_ctx.state === "suspended") {
        _ctx.resume().catch(() => { /* */ });
      }
      return _ctx;
    }
    if (!_hadGesture) return null;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { _ctxFailed = true; return null; }
      _ctx = new Ctx();
      if (_ctx.state === "suspended") {
        _ctx.resume().catch(() => { /* */ });
      }
      return _ctx;
    } catch {
      _ctxFailed = true;
      return null;
    }
  }

  /* ─── Build the audio graph ─── */
  function buildGraph(ctx) {
    const t0 = ctx.currentTime;

    /* Master gain · everything routes through here. Starts silent,
     * ramped up by start(). */
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t0);
    master.connect(ctx.destination);

    /* Long delay · feeds back its low-pass-filtered tail. The two
     * sweeps below send into this directly so each cycle leaves a
     * fainter echo decaying for a few seconds — classic radar / sonar
     * "ping returning from far away" feel. */
    const delay = ctx.createDelay(2.0);
    delay.delayTime.value = 0.55;
    const delayFb = ctx.createGain();
    delayFb.gain.value = 0.22;
    const delayFbFilter = ctx.createBiquadFilter();
    delayFbFilter.type = "lowpass";
    delayFbFilter.frequency.value = 2000;
    delayFbFilter.Q.value = 0.5;
    delay.connect(delayFbFilter).connect(delayFb).connect(delay);
    delay.connect(master);

    /* Sub presence · sine 80 Hz, constant low volume. Gives the
     * scanner an "online" hum without becoming a drone the ear
     * latches onto. Routed direct to master (no delay). */
    const subOsc = ctx.createOscillator();
    subOsc.type = "sine";
    subOsc.frequency.value = 80;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.06;
    subOsc.connect(subGain).connect(master);

    /* Main sweep · sine carrier swept upward by a sawtooth LFO.
     * Base 400 Hz, peak ~1200 Hz, 2.5-second cycle (LFO at 0.4 Hz).
     * Sawtooth gives a rising ramp that snaps back at the end of
     * each cycle — the canonical radar pattern. */
    const mainOsc = ctx.createOscillator();
    mainOsc.type = "sine";
    mainOsc.frequency.value = 400;
    const mainGain = ctx.createGain();
    mainGain.gain.value = 0.34;

    const mainLfo = ctx.createOscillator();
    mainLfo.type = "sawtooth";
    mainLfo.frequency.value = 0.4;
    const mainLfoGain = ctx.createGain();
    mainLfoGain.gain.value = 400;          // ±400 around 400 base
    mainLfo.connect(mainLfoGain);
    mainLfoGain.connect(mainOsc.frequency);

    /* Counter sweep · second sine that sweeps DOWN in counter-phase.
     * Base 1100 Hz, troughs around 350 Hz, half the level of the
     * main so the two crossing pitches feel like two scanners
     * triangulating rather than a single noisy ramp. Uses an
     * INVERTED sawtooth LFO (negative gain) so it ramps downward
     * while the main ramps upward. */
    const counterOsc = ctx.createOscillator();
    counterOsc.type = "sine";
    counterOsc.frequency.value = 1100;
    const counterGain = ctx.createGain();
    counterGain.gain.value = 0.17;

    const counterLfo = ctx.createOscillator();
    counterLfo.type = "sawtooth";
    counterLfo.frequency.value = 0.4;
    const counterLfoGain = ctx.createGain();
    counterLfoGain.gain.value = -375;       // negative · sweep DOWN
    counterLfo.connect(counterLfoGain);
    counterLfoGain.connect(counterOsc.frequency);

    /* Both sweeps go direct to master AND into the delay. The
     * direct path keeps the ping crisp; the delay path adds the
     * spacious decay trail without smearing the present audio. */
    mainOsc.connect(mainGain);
    counterOsc.connect(counterGain);
    mainGain.connect(master);
    counterGain.connect(master);
    mainGain.connect(delay);
    counterGain.connect(delay);

    /* Start everything · they run forever until stop() takes them
     * down. LFOs start out-of-phase by 1 ms so the two oscillators
     * don't lock to perfectly mirrored peaks. */
    subOsc.start(t0);
    mainOsc.start(t0);
    counterOsc.start(t0);
    mainLfo.start(t0);
    counterLfo.start(t0 + 0.001);

    return {
      master,
      delay, delayFb, delayFbFilter,
      subOsc, subGain,
      mainOsc, mainGain, mainLfo, mainLfoGain,
      counterOsc, counterGain, counterLfo, counterLfoGain,
    };
  }

  function teardownGraph(nodes, ctx) {
    if (!nodes) return;
    const oscs = [nodes.subOsc, nodes.mainOsc, nodes.counterOsc, nodes.mainLfo, nodes.counterLfo];
    for (const o of oscs) {
      try { o.stop(); } catch { /* already stopped */ }
    }
    // Disconnect every node we kept a reference to · loose
    // try/catch so a single failure doesn't strand others.
    for (const key of Object.keys(nodes)) {
      try { nodes[key]?.disconnect(); } catch { /* */ }
    }
  }

  /* ─── Public API ─── */
  function start() {
    if (_running) return;
    if (!readGlobalSfxEnabled()) return;
    const ctx = ensureContext();
    if (!ctx) {
      // No gesture yet · queue a deferred start. The gesture
      // listener (above) will retry when a real interaction lands.
      _pendingStart = true;
      return;
    }
    try {
      _nodes = buildGraph(ctx);
      // Ramp master gain in over 1 s. Exponential ramps need a
      // non-zero starting value; setValueAtTime(0.0001) at t0
      // happened in buildGraph already. 0.035 is slightly quieter
      // than the previous drone's 0.04 · pitch motion is more
      // salient than steady drone, so the same loudness reads as
      // too loud in this palette.
      const t = ctx.currentTime;
      const targetGain = 0.035;
      _nodes.master.gain.exponentialRampToValueAtTime(targetGain, t + 1.0);
      _running = true;
    } catch (e) {
      // Audio graph creation rarely fails, but if it does we tear
      // down anything that partially succeeded and stay silent.
      try { teardownGraph(_nodes, ctx); } catch { /* */ }
      _nodes = null;
      _running = false;
    }
  }

  function stop() {
    _pendingStart = false;
    if (!_running || !_ctx || !_nodes) {
      // Even if not playing, defensively kill any deferred start so
      // a later gesture doesn't resurrect a build the caller already
      // declared finished.
      _pendingStart = false;
      return;
    }
    const ctx = _ctx;
    const stale = _nodes;
    _nodes = null;
    _running = false;
    try {
      const t = ctx.currentTime;
      stale.master.gain.cancelScheduledValues(t);
      stale.master.gain.setValueAtTime(stale.master.gain.value, t);
      stale.master.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    } catch { /* ignore · setTimeout still tears down */ }
    setTimeout(() => {
      teardownGraph(stale, ctx);
    }, 1000);
  }

  function isPlaying() {
    return _running;
  }

  window.boardroomAgentBuildBgm = { start, stop, isPlaying };
})();
