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
        composite <canvas> sized to the stage region (capped to
        1920×1080 for H.264 hardware encoder compatibility).
        Composite canvas.captureStream(30) → recorder video track.
        Cropping sidebar / input bar out for free and robust to any
        DOM rebuild inside the stage (chair handoff, 3D↔2D toggle).
     3. AudioContext + MediaStreamAudioDestinationNode. Each TTS
        <audio> element gets `createMediaElementSource` + connect to
        both ctx.destination (so the user still hears) and to the
        recorder destination. WeakSet de-dupes.
     4. WebCodecs pipeline · MediaStreamTrackProcessor reads VideoFrame
        and AudioData from the composite / audio tracks. VideoEncoder
        emits H.264 (avc1 High 4.0, VideoToolbox-accelerated on Mac).
        AudioEncoder emits AAC-LC. Mp4Muxer (vendored UMD) wraps the
        chunks into an mp4 container with `fastStart: 'in-memory'`
        so the moov box lands at the head and the file plays as soon
        as it downloads.
     5. Stop → flush encoders → muxer.finalize() → Blob('video/mp4')
        → browser download via <a download>.

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
  console.log("[recorder] voice-recorder.js v0.9 loaded · mp4/h264+aac · sfx bridge");

  // Diagnostic counters · refreshed at start(), inspected on stop().
  // We use these to detect "started OK but produced 0 chunks" — a
  // common encoder-failure-mode where the .error callback fires but
  // the recording UI looks fine. Without these we'd silently
  // produce 0-byte mp4 blobs and skip the download.
  let _videoChunkCount = 0;
  let _audioChunkCount = 0;
  let _audioFrameCount = 0; // AudioData chunks read from the track (pre-encode)
  let _attachedAudioCount = 0;
  let _attachedAudioFailures = 0;
  let _lastEncoderError = null;
  // ScriptProcessorNode-based audio capture · we tee audio into this
  // node from every attached <audio>, and onaudioprocess builds
  // AudioData chunks straight into the AudioEncoder. More reliable
  // than MediaStreamTrackProcessor on AudioContext destination
  // tracks (Chromium often emits silent frames in that path).
  // Persisted across start/stop because each MediaElementAudioSource
  // is one-shot · once attached, audios keep their wiring to it.
  let _scriptCaptureNode = null;
  let _silentSink = null;
  let _audioCaptureActive = false;
  let _audioPtsFrames = 0; // running sample-frame counter for AudioData.timestamp

  // ── State ─────────────────────────────────────────────────────
  // WebCodecs pipeline · muxer + encoders + track-processor readers.
  // _muxer also serves as the "session active" marker (replaces the
  // previous _recorder MediaRecorder reference).
  let _muxer = null;
  let _videoEncoder = null;
  let _audioEncoder = null;
  let _videoTrackProcessor = null;
  let _audioTrackProcessor = null;
  let _videoReader = null;
  let _audioReader = null;
  let _videoPumpPromise = null;
  let _audioPumpPromise = null;
  let _frameCount = 0;
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
   *  rect updates (content stretches into a stable frame size).
   *
   *  Resolution is capped to fit inside a 1920×1080 box (preserving
   *  aspect ratio). H.264 Level 4.0's macroblock budget is 8192 ≈
   *  1920×1088 · capping ONE dimension lets the other one (e.g. a
   *  4:3-ish stage at 1920×1410) blow past the budget and the
   *  hardware encoder bails with "no codec supported". Even
   *  dimensions enforced (H.264 requires multiples of 2). */
  function startComposite() {
    const rect = _stageEl.getBoundingClientRect();
    let w = Math.max(2, Math.round(rect.width * _compositeDpr));
    let h = Math.max(2, Math.round(rect.height * _compositeDpr));
    const MAX_W = 1920;
    const MAX_H = 1080;
    const k = Math.min(MAX_W / w, MAX_H / h, 1);
    if (k < 1) { w = Math.round(w * k); h = Math.round(h * k); }
    w = w & ~1; h = h & ~1;
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

  /** Lazy-create the AudioContext + capture chain, attach all
   *  currently-existing TTS audio elements + typing-sfx, and return
   *  a sentinel signalling whether we have an audio path (true) or
   *  not (null). The actual encoding is driven by the ScriptProcessor
   *  node's onaudioprocess callback installed in start(). */
  async function buildAudioTrack() {
    if (!_audioCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      _audioCtx = new Ctor();
      _audioDest = _audioCtx.createMediaStreamDestination();
    }
    // Resume the AudioContext explicitly · Chromium creates new
    // contexts in 'suspended' state since v70. A suspended context
    // emits silence frames into every downstream node, so the
    // captured Float32Array would be all zeros. Resume forces the
    // graph to start processing.
    if (_audioCtx.state === "suspended") {
      try { await _audioCtx.resume(); }
      catch (e) { console.warn("[recorder] AudioContext.resume failed", e && e.message); }
    }
    // ScriptProcessor capture node · taps every attached <audio>
    // via createMediaElementSource → source.connect(_scriptCaptureNode).
    // Buffer size 2048 emits onaudioprocess every ~42 ms at 48 kHz
    // and is large enough to feed AAC's 1024-frame encoder windows
    // efficiently. ScriptProcessorNode is deprecated but still works
    // reliably in Chromium · AudioWorkletNode would be the modern
    // path but requires a separate worklet script load.
    if (!_scriptCaptureNode) {
      _scriptCaptureNode = _audioCtx.createScriptProcessor(2048, 2, 2);
      // Silent sink · ScriptProcessor only fires onaudioprocess when
      // downstream pulls its output. We route to a gain=0 sink so
      // the node stays active without re-playing audio through the
      // speakers (each source already connects to ctx.destination
      // directly for the user-monitoring path).
      _silentSink = _audioCtx.createGain();
      _silentSink.gain.value = 0;
      _scriptCaptureNode.connect(_silentSink);
      _silentSink.connect(_audioCtx.destination);
    }
    console.log("[recorder] AudioContext · state=" + _audioCtx.state
      + " sampleRate=" + _audioCtx.sampleRate
      + " bufferSize=" + _scriptCaptureNode.bufferSize);

    // Walk every <audio> currently parked in the off-screen host
    // (voice-replay's STATE.audio also lives there once playCurrent
    // dispatches; see voice-replay.js HOST id).
    const host = document.getElementById("boardroom-voice-audio-host");
    let walked = 0;
    if (host) {
      const audios = host.querySelectorAll("audio");
      for (const audio of audios) { attachAudioElement(audio); walked++; }
    }
    // voice-replay's STATE.audio may not be attached to the host —
    // it's created with `new Audio(dataUrl)` but only some paths
    // appendChild. Walk any <audio> document-wide as a safety net
    // (cheap; usually 1-3 elements total).
    for (const audio of document.querySelectorAll("audio")) {
      attachAudioElement(audio); walked++;
    }
    // Voice replay constructs its current clip via `new Audio(dataUrl)`
    // and never appends to the DOM, so the document walk above misses
    // it. Pull the live element directly from voice-replay's public API
    // so a mid-replay record start still captures the first director.
    try {
      const vr = (typeof window !== "undefined") ? window.boardroomVoiceReplay : null;
      const a = vr && typeof vr.getActiveAudio === "function" ? vr.getActiveAudio() : null;
      if (a) { attachAudioElement(a); walked++; }
    } catch (_) { /* api missing · web build · noop */ }
    console.log("[recorder] audio attach pass · walked=" + walked
      + " attached=" + _attachedAudioCount + " failed=" + _attachedAudioFailures);

    // typing-sfx bridge · typing-sfx runs in its own AudioContext,
    // and Web Audio nodes cannot connect across contexts. We bridge
    // via MediaStream: typing-sfx exposes `_outputNode` → its own
    // MediaStreamAudioDestinationNode (`.stream` returned by
    // `getRecorderStream()`), and we mount that stream as a
    // MediaStreamAudioSourceNode in OUR context, then connect to
    // the script capture node alongside the TTS sources.
    if (!_typingSfxTapped
        && window.boardroomTypingSfx
        && typeof window.boardroomTypingSfx.getRecorderStream === "function") {
      try {
        const sfxStream = window.boardroomTypingSfx.getRecorderStream();
        if (sfxStream) {
          const sfxSrc = _audioCtx.createMediaStreamSource(sfxStream);
          sfxSrc.connect(_scriptCaptureNode);
          _typingSfxTapped = true;
          console.log("[recorder] typing-sfx bridged · " + sfxStream.getAudioTracks().length + " track(s)");
        } else {
          console.log("[recorder] typing-sfx getRecorderStream returned null (no gesture / no ctx)");
        }
      } catch (e) { console.warn("[recorder] sfx bridge failed", e && e.message); }
    }
    // Sentinel · audio path is ready; the encoder is driven by the
    // onaudioprocess handler installed in start(). Returning a
    // truthy value keeps start()'s "if (audioTrack)" branches live.
    return _scriptCaptureNode || null;
  }

  /** Pipe one HTMLAudioElement into the recorder's capture chain
   *  AND keep playback to ctx.destination. Safe to call when no
   *  recording is in progress (no-op until first start()). */
  function attachAudioElement(audio) {
    if (!audio) return;
    if (!_audioCtx || !_scriptCaptureNode) return; // not recording / not started yet
    if (_attachedAudios.has(audio)) return;
    try {
      const src = _audioCtx.createMediaElementSource(audio);
      src.connect(_audioCtx.destination);  // user-monitoring path
      src.connect(_scriptCaptureNode);      // recorder capture path
      // Legacy fan-in for typing-sfx.connectRecorderDestination · the
      // MediaStreamDestination is still wired so SFX can attempt its
      // own cross-context tap (currently a no-op but cheap to keep).
      if (_audioDest) {
        try { src.connect(_audioDest); } catch (_) {}
      }
      _audioSourceNodes.set(audio, src);
      _attachedAudios.add(audio);
      _attachedAudioCount++;
    } catch (e) {
      // createMediaElementSource throws InvalidStateError when the
      // element was already wired to a different AudioContext (rare;
      // we own the only context). Mark it attached so we don't keep
      // retrying every frame.
      _attachedAudios.add(audio);
      _attachedAudioFailures++;
      console.warn("[recorder] attachAudioElement failed",
        e && e.message, "src=" + (audio.src || "").slice(0, 80));
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
    if (_muxer) return; // already recording · idempotent
    _roomId = roomId || "";
    _roomTitle = roomTitle || "Meeting";

    _stageEl = document.querySelector("[data-roundtable-stage]");
    if (!_stageEl) throw new Error("[stage-lookup] No voice room stage to record");

    // Pre-flight · the mp4 pipeline needs the vendored muxer + the
    // WebCodecs / Insertable-Streams APIs. All four ship in Chromium
    // 100+, but feature-detect anyway so a missing <script> tag
    // surfaces a clear error instead of a quiet TypeError later.
    if (!window.Mp4Muxer || !window.VideoEncoder
        || !window.AudioEncoder || !window.MediaStreamTrackProcessor) {
      throw new Error("[mp4-pipeline] vendored mp4-muxer / WebCodecs missing");
    }

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

    const cw = _compositeCanvas.width;
    const ch = _compositeCanvas.height;
    // AudioContext sample rate is locked at first construction (44.1k
    // or 48k depending on platform). ScriptProcessorNode emits frames
    // at that same rate · feed straight into the encoder, no resample.
    const sampleRate = (audioTrack && _audioCtx) ? _audioCtx.sampleRate : 48000;
    const numChannels = 2;
    _videoChunkCount = 0;
    _audioChunkCount = 0;
    _audioFrameCount = 0;
    _attachedAudioCount = 0;
    _attachedAudioFailures = 0;
    _lastEncoderError = null;

    console.log("[recorder] start · composite=" + cw + "×" + ch
      + " sr=" + sampleRate + " ch=" + numChannels
      + " hasAudio=" + !!audioTrack);

    // Codec negotiation · isConfigSupported lets the encoder
    // tell us *before* configure() whether it accepts the params.
    // Fall back from High → Main → Constrained Baseline. Without
    // this the encoder may accept configure() but enter 'closed'
    // state asynchronously, killing every encode silently.
    const codecCandidates = [
      "avc1.640028", // High @ 4.0
      "avc1.4d4028", // Main @ 4.0
      "avc1.42e028", // Baseline @ 4.0
      "avc1.42e01f", // Baseline @ 3.1
    ];
    let videoCodec = null;
    for (const codec of codecCandidates) {
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec, width: cw, height: ch,
          bitrate: 4_000_000, framerate: 30,
          avc: { format: "avc" },
        });
        if (support && support.supported) {
          videoCodec = (support.config && support.config.codec) || codec;
          console.log("[recorder] video codec picked:", videoCodec,
            "hw=", support.config && support.config.hardwareAcceleration);
          break;
        }
      } catch (e) { /* try next */ }
    }
    if (!videoCodec) throw new Error("[video-codec] no avc1 profile supported at " + cw + "×" + ch);

    let audioCodec = null;
    if (audioTrack) {
      for (const codec of ["mp4a.40.2", "mp4a.40.5"]) { // AAC-LC, HE-AAC
        try {
          const support = await AudioEncoder.isConfigSupported({
            codec, sampleRate, numberOfChannels: numChannels, bitrate: 128_000,
          });
          if (support && support.supported) {
            audioCodec = (support.config && support.config.codec) || codec;
            console.log("[recorder] audio codec picked:", audioCodec);
            break;
          }
        } catch (e) { /* try next */ }
      }
    }

    _muxer = await _trace("muxer-init", () => new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: "avc", width: cw, height: ch, frameRate: 30 },
      audio: (audioTrack && audioCodec)
        ? { codec: "aac", numberOfChannels: numChannels, sampleRate }
        : undefined,
      // fastStart 'in-memory' writes the moov box at the head of the
      // file once finalized · plays + scrubs immediately in QuickTime
      // / browser tabs / Finder preview without needing to download
      // the whole thing first. Cost: peak RAM = ~size of recording.
      fastStart: "in-memory",
    }));

    _videoEncoder = await _trace("video-encoder", () => new VideoEncoder({
      output: (chunk, meta) => {
        try {
          if (_muxer) _muxer.addVideoChunk(chunk, meta);
          _videoChunkCount++;
        } catch (e) { console.warn("[recorder] mux video", e); }
      },
      error: (e) => {
        _lastEncoderError = e;
        console.error("[recorder] VideoEncoder.error", e && (e.message || e));
        // Don't emit('error') · the app.js handler treats that as
        // 'ended' and unmounts the rec pill, even though we may still
        // be capturing usable audio. The stop() path surfaces the
        // failure via an alert when finalize produces no chunks.
      },
    }));
    _videoEncoder.configure({
      codec: videoCodec,
      width: cw,
      height: ch,
      bitrate: 4_000_000,
      framerate: 30,
      // `format: 'avc'` makes the encoder emit length-prefixed AVCC
      // NAL units (+ avcC description in chunk metadata), which is
      // exactly what mp4-muxer wants. Without this it emits Annex-B
      // byte stream and the muxer can't write a playable mp4.
      avc: { format: "avc" },
    });

    if (audioTrack && audioCodec) {
      _audioEncoder = await _trace("audio-encoder", () => new AudioEncoder({
        output: (chunk, meta) => {
          try {
            if (_muxer) _muxer.addAudioChunk(chunk, meta);
            _audioChunkCount++;
          } catch (e) { console.warn("[recorder] mux audio", e); }
        },
        error: (e) => {
          _lastEncoderError = e;
          console.error("[recorder] AudioEncoder.error", e && (e.message || e));
        },
      }));
      _audioEncoder.configure({
        codec: audioCodec,
        sampleRate,
        numberOfChannels: numChannels,
        bitrate: 128_000,
      });
    }

    // Pump · MediaStreamTrackProcessor exposes a ReadableStream of
    // VideoFrame / AudioData drawn from the live track. We read in
    // a loop, hand each chunk to the encoder, and close() to release
    // GPU/CPU buffers (skipping close leaks memory fast on canvas
    // capture). The stop() path cancels these readers, which surfaces
    // as `done: true` and exits the loop cleanly.
    _frameCount = 0;
    _videoTrackProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
    _videoReader = _videoTrackProcessor.readable.getReader();
    _videoPumpPromise = (async () => {
      try {
        while (true) {
          const { value: frame, done } = await _videoReader.read();
          if (done) break;
          if (!frame) continue;
          try {
            if (_videoEncoder && _videoEncoder.state === "configured") {
              // Keyframe every 60 frames = ~2s GOP at 30fps · keeps
              // scrubbing snappy and the avcC description fresh.
              const keyFrame = (_frameCount % 60) === 0;
              _videoEncoder.encode(frame, { keyFrame });
              _frameCount++;
            }
          } finally { frame.close(); }
        }
      } catch (e) { console.warn("[recorder] video pump", e); }
    })();

    if (audioTrack && _scriptCaptureNode) {
      // ScriptProcessor onaudioprocess fires for every bufferSize
      // samples · we read the inputBuffer (Float32 per channel),
      // pack into f32-planar, build AudioData, and encode. Running
      // sample-frame counter generates monotonic per-call timestamps
      // in microseconds (WebCodecs uses µs for AudioData.timestamp).
      _audioPtsFrames = 0;
      _audioCaptureActive = true;
      let loggedFirst = false;
      _scriptCaptureNode.onaudioprocess = (event) => {
        if (!_audioCaptureActive) return;
        if (!_audioEncoder || _audioEncoder.state !== "configured") return;
        const inputBuffer = event.inputBuffer;
        const chCount = Math.min(inputBuffer.numberOfChannels, numChannels);
        const frames = inputBuffer.length;
        const sr = _audioCtx.sampleRate;
        // Build f32-planar buffer · [ch0_samples..., ch1_samples...]
        const planar = new Float32Array(chCount * frames);
        for (let ch = 0; ch < chCount; ch++) {
          planar.set(inputBuffer.getChannelData(ch), ch * frames);
        }
        const tsMicros = Math.round((_audioPtsFrames * 1_000_000) / sr);
        try {
          const audioData = new AudioData({
            format: "f32-planar",
            sampleRate: sr,
            numberOfFrames: frames,
            numberOfChannels: chCount,
            timestamp: tsMicros,
            data: planar,
          });
          if (!loggedFirst) {
            loggedFirst = true;
            console.log("[recorder] first onaudioprocess · sr=" + sr
              + " frames=" + frames + " ch=" + chCount
              + " tsMicros=" + tsMicros);
          }
          _audioFrameCount++;
          _audioEncoder.encode(audioData);
          audioData.close();
        } catch (e) { console.warn("[recorder] audio capture", e); }
        _audioPtsFrames += frames;
      };
    }

    _startedAt = performance.now();
    emit({ kind: "started", roomId: _roomId, roomTitle: _roomTitle });
  }

  async function stop() {
    if (!_muxer) return null;
    emit({ kind: "stopping" });
    // Halt audio capture FIRST · sets the flag the onaudioprocess
    // callback checks. After this, no new AudioData lands at the
    // encoder, so the flush below sees only what's already queued.
    _audioCaptureActive = false;
    // Cancel video reader · pump loop sees `done: true` next tick
    // and exits. Await before flushing so every queued frame
    // reaches the encoder.
    try { if (_videoReader) await _videoReader.cancel(); } catch (_) {}
    try { if (_videoPumpPromise) await _videoPumpPromise; } catch (_) {}
    // Flush · push any encoder-queued chunks through to the muxer.
    try { if (_videoEncoder) await _videoEncoder.flush(); }
    catch (e) { console.warn("[recorder] video flush", e); }
    try { if (_audioEncoder) await _audioEncoder.flush(); }
    catch (e) { console.warn("[recorder] audio flush", e); }
    console.log("[recorder] stop · videoChunks=" + _videoChunkCount
      + " audioChunks=" + _audioChunkCount
      + " audioFrames=" + _audioFrameCount
      + " attachedAudios=" + _attachedAudioCount
      + " attachFailures=" + _attachedAudioFailures
      + " ctxState=" + (_audioCtx && _audioCtx.state)
      + " lastErr=" + (_lastEncoderError ? (_lastEncoderError.message || _lastEncoderError) : "none"));
    let blob = null;
    // Empty-video guard · finalize() throws when no chunks ever landed
    // (mp4-muxer enforces at least 1 video sample). Surface this
    // visibly so the user knows the encoder failed instead of getting
    // a silent no-download.
    if (_videoChunkCount === 0) {
      const reason = _lastEncoderError
        ? (_lastEncoderError.message || String(_lastEncoderError))
        : "video encoder produced no chunks";
      console.error("[recorder] zero video chunks — " + reason);
      try { alert("录制失败 · 视频编码器无输出。\n\n" + reason); } catch (_) {}
      teardown();
      emit({ kind: "stopped", blob: null });
      return null;
    }
    try {
      _muxer.finalize();
      const buffer = _muxer.target && _muxer.target.buffer;
      if (buffer) blob = new Blob([buffer], { type: "video/mp4" });
    } catch (e) {
      console.error("[recorder] finalize", e);
      try { alert("录制收尾失败：" + (e && e.message || e)); } catch (_) {}
    }
    teardown();
    emit({ kind: "stopped", blob });
    return blob;
  }

  /** Stop + auto-download. Convenience for UI single-click stop. */
  async function stopAndDownload() {
    const blob = await stop();
    if (!blob || blob.size === 0) {
      console.warn("[recorder] stopAndDownload · empty blob, skipping download");
      return blob;
    }
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `PrivateBoard — ${safeFilename(_roomTitle)} — ${tsStamp()}.mp4`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      console.log("[recorder] download triggered · " + a.download + " · " + blob.size + " bytes");
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
    try { if (_videoEncoder && _videoEncoder.state !== "closed") _videoEncoder.close(); } catch (_) {}
    try { if (_audioEncoder && _audioEncoder.state !== "closed") _audioEncoder.close(); } catch (_) {}
    // Unhook the onaudioprocess callback · the node + sink stay
    // wired so the next start() reuses them (audios are bound
    // one-shot to this script node via createMediaElementSource).
    _audioCaptureActive = false;
    if (_scriptCaptureNode) {
      try { _scriptCaptureNode.onaudioprocess = null; } catch (_) {}
    }
    _compositeCanvas = null;
    _compositeCtx = null;
    _videoEncoder = null;
    _audioEncoder = null;
    _videoTrackProcessor = null;
    _audioTrackProcessor = null;
    _videoReader = null;
    _audioReader = null;
    _videoPumpPromise = null;
    _audioPumpPromise = null;
    _muxer = null;
    _frameCount = 0;
    _stageEl = null;
    _startedAt = 0;
    // _audioCtx + _audioDest + _scriptCaptureNode + _silentSink +
    // _attachedAudios are KEPT · MediaElementAudioSourceNode binding
    // is one-shot per element, so re-attaching across sessions
    // requires the original context + capture node to stay alive.
  }

  function isRecording() {
    return !!_muxer;
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
