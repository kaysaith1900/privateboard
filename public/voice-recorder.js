/* ═══════════════════════════════════════════════════════════════════
   voice-recorder.js · meeting capture for the voice room.
   ═══════════════════════════════════════════════════════════════════

   What it does
   ────────────
   One-click record / stop of the active voice room. Captures:
     · the visible `[data-roundtable-stage]` region (3D canvas + DOM
       overlay nameplates / bubbles / status panel / subtitle)
     · all director TTS audio (HTMLAudioElement instances created
       per message in app.js _createVoiceStream + voice-replay)

   Architecture
   ────────────
     1. Acquire whole-window MediaStream via Electron `desktopCapturer`
        (chromeMediaSourceId routed through main process IPC) · web
        fallback via getDisplayMedia.
     2. Pipe that stream into a hidden <video>, then every RAF tick
        drawImage(video, stageRect.x, stageRect.y, ...) into a
        composite <canvas> sized to the stage region. Composite
        canvas.captureStream(30) → recorder video track. This crops
        sidebar / input bar out for free and is robust to any DOM
        rebuild inside the stage (chair handoff, 3D↔2D toggle).
     3. AudioContext + MediaStreamAudioDestinationNode. Each TTS
        <audio> element gets `createMediaElementSource` + connect to
        both ctx.destination (so the user still hears) and to the
        recorder destination. WeakSet de-dupes.
     4. MediaRecorder(video+audio, video/webm;codecs=vp9,opus) → blob.
     5. Stop → blob → browser download via <a download>.

   Public API · `window.BoardroomRecorder`
   ───────────────────────────────────────
     start(roomId, roomTitle):   Promise<void>
     stop():                     Promise<Blob | null>
     stopAndDownload():          Promise<Blob | null>   convenience
     isRecording():              boolean
     getElapsedMs():             number
     attachAudioElement(audio):  void                   (no-op when idle)
     onStateChange(cb):          () => void             unsubscribe

   The recorder is a singleton; only one room can record at a time. */

(function () {
  // Version stamp · helps catch stale cached JS during recorder
  // debugging. Bump on each significant pipeline change.
  console.log("[recorder] voice-recorder.js v0.3 loaded");

  // ── State ─────────────────────────────────────────────────────
  let _recorder = null;
  let _chunks = [];
  // AudioContext kept alive across start/stop sessions · once we
  // call `createMediaElementSource(audio)` the source is bound to
  // that context forever. Disposing the context would orphan every
  // previously-attached <audio>; the next start() would have to
  // re-attach but the binding is one-shot. Persist instead.
  let _audioCtx = null;
  let _audioDest = null;
  const _attachedAudios = new WeakSet();
  // Tracks node-source pairs so we can disconnect / reconnect to a
  // fresh destination on the next start without orphaning sources.
  const _audioSourceNodes = new WeakMap(); // audioElement → MediaElementAudioSourceNode
  // typing-sfx tap node (separate from per-element sources).
  let _typingSfxTapped = false;

  let _videoEl = null;
  let _windowStream = null;
  let _compositeCanvas = null;
  let _compositeCtx = null;
  let _compositeRafId = 0;
  let _compositeStream = null;
  let _stageEl = null;
  let _compositeDpr = 1;

  let _startedAt = 0;
  let _roomId = null;
  let _roomTitle = "";
  const _listeners = new Set();
  let _stopBlobResolve = null;
  let _stopBlobPromise = null;

  function emit(state) {
    for (const cb of _listeners) {
      try { cb(state); } catch (e) { console.warn("[recorder] listener", e); }
    }
  }

  function isElectron() {
    return !!(typeof window !== "undefined"
      && window.privateboard
      && typeof window.privateboard.invoke === "function");
  }

  /** Acquire a window-region MediaStream.
   *
   *  Both Electron and web use the same modern `getDisplayMedia()`
   *  call · the difference is the picker UX:
   *    · Electron · main process installed a
   *      `session.setDisplayMediaRequestHandler` that auto-picks the
   *      app's own BrowserWindow, so `getDisplayMedia()` resolves
   *      silently with no native picker.
   *    · Web · the browser shows its native "share window" picker
   *      and the user selects the PrivateBoard tab/window. */
  async function acquireVideoStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error("Screen capture not supported in this environment");
    }
    console.log("[recorder] calling getDisplayMedia · constraints={video:true,audio:false}");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      console.log("[recorder] getDisplayMedia resolved · tracks=", stream.getVideoTracks().length);
      return stream;
    } catch (e1) {
      console.warn("[recorder] getDisplayMedia({video:true}) rejected:", e1 && e1.name, e1 && e1.message);
      // Fallback 1 · empty constraint object (some Chromium builds
      // demand a constraint dictionary, not boolean).
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: {} });
        console.log("[recorder] getDisplayMedia({video:{}}) resolved");
        return stream;
      } catch (e2) {
        console.warn("[recorder] getDisplayMedia({video:{}}) rejected:", e2 && e2.name, e2 && e2.message);
        // Final fallback · explicit displaySurface constraint that
        // matches what the Chromium native picker would send.
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "window" },
          audio: false,
        });
        return stream;
      }
    }
  }

  /** Spin up the composite canvas + per-frame crop loop. Returns the
   *  captured video track for the recorder. The composite canvas
   *  size is locked at start() time; if the stage resizes the crop
   *  rect updates (content stretches into a stable frame size). */
  function startComposite() {
    const rect = _stageEl.getBoundingClientRect();
    const w = Math.max(2, Math.round(rect.width * _compositeDpr));
    const h = Math.max(2, Math.round(rect.height * _compositeDpr));
    _compositeCanvas = document.createElement("canvas");
    _compositeCanvas.width = w;
    _compositeCanvas.height = h;
    _compositeCtx = _compositeCanvas.getContext("2d");

    const tick = () => {
      _compositeRafId = requestAnimationFrame(tick);
      if (!_videoEl || _videoEl.readyState < 2) return;
      const r = _stageEl ? _stageEl.getBoundingClientRect() : null;
      if (!r || r.width <= 0 || r.height <= 0) return;
      const sx = Math.max(0, Math.round(r.left * _compositeDpr));
      const sy = Math.max(0, Math.round(r.top * _compositeDpr));
      const sw = Math.max(1, Math.round(r.width * _compositeDpr));
      const sh = Math.max(1, Math.round(r.height * _compositeDpr));
      try {
        _compositeCtx.drawImage(_videoEl, sx, sy, sw, sh, 0, 0, w, h);
      } catch (_) { /* video not ready · skip frame */ }
    };
    _compositeRafId = requestAnimationFrame(tick);
    _compositeStream = _compositeCanvas.captureStream(30);
    return _compositeStream.getVideoTracks()[0];
  }

  /** Lazy-create the AudioContext + destination, attach all
   *  currently-existing TTS audio elements + typing-sfx, return
   *  the recorder audio track. */
  function buildAudioTrack() {
    if (!_audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      _audioCtx = new Ctor();
      _audioDest = _audioCtx.createMediaStreamDestination();
    }
    // Walk every <audio> currently parked in the off-screen host
    // (voice-replay's STATE.audio also lives there once playCurrent
    // dispatches; see voice-replay.js HOST id).
    const host = document.getElementById("boardroom-voice-audio-host");
    if (host) {
      const audios = host.querySelectorAll("audio");
      for (const audio of audios) attachAudioElement(audio);
    }
    // voice-replay's STATE.audio may not be attached to the host —
    // it's created with `new Audio(dataUrl)` but only some paths
    // appendChild. Walk any <audio> document-wide as a safety net
    // (cheap; usually 1-3 elements total).
    for (const audio of document.querySelectorAll("audio")) {
      attachAudioElement(audio);
    }
    // typing-sfx tap · its AudioContext is separate; expose its
    // destination upstream so we can fan into our recorder dest.
    if (!_typingSfxTapped
        && window.boardroomTypingSfx
        && typeof window.boardroomTypingSfx.connectRecorderDestination === "function") {
      try {
        window.boardroomTypingSfx.connectRecorderDestination(_audioDest);
        _typingSfxTapped = true;
      } catch (e) { console.warn("[recorder] sfx tap failed", e); }
    }
    return _audioDest.stream.getAudioTracks()[0] || null;
  }

  /** Pipe one HTMLAudioElement into the recorder's audio destination
   *  AND keep playback to ctx.destination. Safe to call when no
   *  recording is in progress (no-op until first start()). */
  function attachAudioElement(audio) {
    if (!audio) return;
    if (!_audioCtx || !_audioDest) return; // not recording / not started yet
    if (_attachedAudios.has(audio)) return;
    try {
      const src = _audioCtx.createMediaElementSource(audio);
      src.connect(_audioCtx.destination);
      src.connect(_audioDest);
      _audioSourceNodes.set(audio, src);
      _attachedAudios.add(audio);
    } catch (e) {
      // createMediaElementSource throws InvalidStateError when the
      // element was already wired to a different AudioContext (rare;
      // we own the only context). Mark it attached so we don't keep
      // retrying every frame.
      _attachedAudios.add(audio);
      console.warn("[recorder] attachAudioElement failed", e && e.message);
    }
  }

  function safeFilename(s) {
    return String(s || "meeting")
      .replace(/[\/\\:*?"<>| -]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "meeting";
  }

  function tsStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
  }

  /** Wrap an awaitable so an exception carries a "[step] " prefix —
   *  the resulting message lets the UI alert show exactly which
   *  phase of start() failed (permission deny / IPC missing / mime
   *  unsupported / etc) without needing to re-instrument every
   *  call site. */
  async function _trace(step, fn) {
    try { return await fn(); }
    catch (e) {
      const msg = (e && (e.message || e.name)) || String(e);
      throw new Error(`[${step}] ${msg}`);
    }
  }

  async function start(roomId, roomTitle) {
    if (_recorder) return; // already recording · idempotent
    _roomId = roomId || "";
    _roomTitle = roomTitle || "Meeting";
    _chunks = [];

    _stageEl = document.querySelector("[data-roundtable-stage]");
    if (!_stageEl) throw new Error("[stage-lookup] No voice room stage to record");

    _windowStream = await _trace("acquire-video", () => acquireVideoStream());

    await _trace("attach-video-element", async () => {
      _videoEl = document.createElement("video");
      _videoEl.muted = true;
      _videoEl.autoplay = true;
      _videoEl.playsInline = true;
      _videoEl.srcObject = _windowStream;
      _videoEl.style.cssText =
        "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none;";
      document.body.appendChild(_videoEl);
      try { await _videoEl.play(); } catch (_) { /* autoplay handled by muted */ }
    });

    _compositeDpr = Math.min(window.devicePixelRatio || 1, 2);
    const videoTrack = await _trace("composite-canvas", () => startComposite());
    const audioTrack = await _trace("build-audio", () => buildAudioTrack());

    const tracks = audioTrack ? [videoTrack, audioTrack] : [videoTrack];
    const stream = await _trace("build-stream", () => new MediaStream(tracks));

    // Codec fallback chain · vp9 is the highest-quality MediaRecorder
    // codec in Chromium; vp8 ships universally; bare webm is the
    // last resort that always works but lets the browser pick.
    const preferredMimes = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    let mime = "";
    for (const m of preferredMimes) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) { mime = m; break; }
    }
    if (!mime) throw new Error("[mime] MediaRecorder webm support missing");

    _recorder = await _trace("recorder-construct", () => new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 4_000_000,
      audioBitsPerSecond: 128_000,
    }));
    _recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) _chunks.push(e.data);
    };
    _recorder.onerror = (e) => {
      console.error("[recorder] error", e);
      // Auto-stop and try to surface what we have.
      void stop().catch(() => {});
      emit({ kind: "error", error: e && e.error });
    };
    _stopBlobPromise = new Promise((resolve) => { _stopBlobResolve = resolve; });
    _recorder.onstop = () => {
      const blob = new Blob(_chunks, { type: "video/webm" });
      const r = _stopBlobResolve;
      teardown();
      if (r) r(blob);
    };
    await _trace("recorder-start", () => _recorder.start(1000)); // 1s timeslice
    _startedAt = performance.now();
    emit({ kind: "started", roomId: _roomId, roomTitle: _roomTitle });
  }

  async function stop() {
    if (!_recorder) return null;
    const promise = _stopBlobPromise;
    try { _recorder.stop(); } catch (e) { console.warn("[recorder] stop", e); }
    emit({ kind: "stopping" });
    const blob = await promise;
    emit({ kind: "stopped", blob });
    return blob;
  }

  /** Stop + auto-download. Convenience for UI single-click stop. */
  async function stopAndDownload() {
    const blob = await stop();
    if (!blob || blob.size === 0) return blob;
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `PrivateBoard — ${safeFilename(_roomTitle)} — ${tsStamp()}.webm`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      console.error("[recorder] download", e);
    }
    return blob;
  }

  function teardown() {
    if (_compositeRafId) {
      cancelAnimationFrame(_compositeRafId);
      _compositeRafId = 0;
    }
    if (_compositeStream) {
      try { _compositeStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      _compositeStream = null;
    }
    if (_windowStream) {
      try { _windowStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      _windowStream = null;
    }
    if (_videoEl) {
      try { _videoEl.pause(); _videoEl.srcObject = null; _videoEl.remove(); } catch (_) {}
      _videoEl = null;
    }
    _compositeCanvas = null;
    _compositeCtx = null;
    _recorder = null;
    _stopBlobResolve = null;
    _stopBlobPromise = null;
    _stageEl = null;
    _startedAt = 0;
    // _audioCtx + _audioDest + _attachedAudios are KEPT for the
    // reason in their declaration comment (one-shot binding).
  }

  function isRecording() {
    return !!_recorder && _recorder.state !== "inactive";
  }

  function getElapsedMs() {
    if (!_startedAt) return 0;
    return performance.now() - _startedAt;
  }

  function onStateChange(cb) {
    if (typeof cb !== "function") return () => {};
    _listeners.add(cb);
    return () => _listeners.delete(cb);
  }

  /** Meeting recording is Electron-only · the browser path could
   *  technically work (getDisplayMedia + browser-native picker) but
   *  the picker reliability + UX of "user picks the wrong window"
   *  isn't worth supporting today. Web visitors see no Record
   *  button (renderHeader gates on this) and any direct start()
   *  call rejects early with a clear message. */
  function isAvailable() {
    return isElectron();
  }

  window.BoardroomRecorder = {
    start: async (roomId, roomTitle) => {
      if (!isAvailable()) throw new Error("Recording is only available in the desktop app");
      return start(roomId, roomTitle);
    },
    stop,
    stopAndDownload,
    isRecording,
    isAvailable,
    getElapsedMs,
    attachAudioElement,
    onStateChange,
  };
})();
