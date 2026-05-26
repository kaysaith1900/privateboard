/* voice-clone.js · Global singleton driving the director voice-
 * cloning UX:
 *
 *   · `boardroomVoiceClone.open({ agentId, agentName, onApplied })`
 *     mounts the overlay (source picker → confirm → progress).
 *   · `boardroomVoiceClone.minimize()` hides the overlay and shows
 *     a right-bottom pill with live progress.
 *   · `boardroomVoiceClone.restore()` reverses it. The SSE channel
 *     stays live across minimize/restore so progress doesn't reset.
 *
 * One job per process; the backend enforces this and the UI mirrors
 * that constraint by short-circuiting open() when a job is active.
 *
 * SSE consumes events emitted by /api/voice-clone/:id/stream. Two
 * event kinds: `snapshot` (initial state on connect, lets the
 * pill re-attach to a long-running job after a page reload) and
 * `progress` (per-update). `end` is the terminal marker.
 */
(function (root) {
  "use strict";

  // ── State ──────────────────────────────────────────────────────
  const STATE = {
    overlay: null,
    pill: null,
    agentId: null,
    agentName: "",
    onApplied: null,
    sourceMode: "upload",     // "upload" | "record"
    selectedFile: null,       // File object · audio or video (or recorded Blob)
    selectedFileName: "",     // display
    selectedIsVideo: false,   // true when the picked file is video/*
    decodedAudio: null,       // AudioBuffer · null until decode succeeds
    trimStart: 0,             // seconds · start of selection
    trimEnd: 0,               // seconds · end of selection
    // Recording mode
    recorder: null,           // MediaRecorder instance
    recorderStream: null,     // MediaStream · stopped on tear-down
    recordChunks: [],         // Blob chunks coming in from ondataavailable
    recordBlob: null,         // finished recording, ready to clone-confirm
    recordStartedAt: 0,       // performance.now() when recording began
    recordTimerId: 0,         // setInterval handle for the running counter
    recordLevelAudio: null,   // AudioContext + AnalyserNode bookkeeping
    recordPreviewAudio: null, // HTMLAudioElement for play-back of the take
    label: "",                // optional voice label
    miniMaxGroupId: "",       // optional MiniMax Group ID override
    clonedVoiceId: "",        // voice_id of the just-finished clone (success stage)
    clonedProvider: "",       // provider that did the clone
    terminalHandled: false,   // idempotent guard · onTerminal fires twice (progress done + SSE end)
    previewAudio: null,       // HTMLAudioElement · success-stage preview
    previewBusy: false,       // throttle preview button while a request is in flight
    jobId: null,
    stage: "fetch",
    pct: 0,
    status: null,             // null | "running" | "done" | "failed" | "cancelled"
    errorCode: null,
    errorMessage: null,
    eventSource: null,
    inProgress: false,
  };

  // ── i18n helper · falls back to provided defaults ─────────────
  function tx(key, vars, fallback) {
    try {
      const I = root.I18n;
      if (I && typeof I.t === "function") {
        const out = I.t(key, vars || {});
        if (out && out !== key) return out;
      }
    } catch { /* */ }
    let s = fallback || key;
    if (vars) for (const k of Object.keys(vars)) s = s.replace(new RegExp("\\{" + k + "\\}", "g"), String(vars[k]));
    return s;
  }

  function escape(s) {
    return String(s == null ? "" : s)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
  }

  // ── Public API ────────────────────────────────────────────────
  function open(opts) {
    opts = opts || {};
    if (STATE.inProgress) {
      // A job is already running. Restore the overlay (it might
      // already be the same agent's job) so the user can manage it.
      restore();
      return;
    }
    STATE.agentId = String(opts.agentId || "");
    STATE.agentName = String(opts.agentName || "");
    STATE.onApplied = typeof opts.onApplied === "function" ? opts.onApplied : null;
    STATE.selectedFile = null;
    STATE.selectedFileName = "";
    STATE.selectedIsVideo = false;
    STATE.sourceMode = "upload";
    STATE.decodedAudio = null;
    STATE.trimStart = 0;
    STATE.trimEnd = 0;
    tearDownRecorder();
    STATE.recordBlob = null;
    STATE.label = "";
    STATE.miniMaxGroupId = "";
    STATE.clonedVoiceId = "";
    STATE.clonedProvider = "";
    STATE.terminalHandled = false;
    if (STATE.previewAudio) { try { STATE.previewAudio.pause(); } catch { /* */ } STATE.previewAudio = null; }
    STATE.previewBusy = false;
    STATE.jobId = null;
    STATE.stage = "fetch";
    STATE.pct = 0;
    STATE.status = null;
    STATE.errorCode = null;
    STATE.errorMessage = null;
    mountOverlay();
    document.addEventListener("keydown", onKeyDown);
  }

  function close() {
    document.removeEventListener("keydown", onKeyDown);
    if (STATE.eventSource) { try { STATE.eventSource.close(); } catch { /* */ } STATE.eventSource = null; }
    tearDownRecorder();
    if (STATE.previewAudio) { try { STATE.previewAudio.pause(); } catch { /* */ } STATE.previewAudio = null; }
    if (STATE.overlay) { STATE.overlay.remove(); STATE.overlay = null; }
    if (STATE.pill) { STATE.pill.remove(); STATE.pill = null; }
    STATE.inProgress = false;
  }

  function minimize() {
    if (!STATE.overlay) return;
    STATE.overlay.classList.add("is-collapsed");
    mountPill();
  }

  function restore() {
    if (!STATE.overlay) {
      // Edge · job is in-flight but overlay was destroyed (page
      // reload). Mount a progress-stage overlay attached to the
      // existing job id.
      if (STATE.jobId) {
        mountOverlay(/* directlyShowProgress */ true);
      }
      return;
    }
    STATE.overlay.classList.remove("is-collapsed");
    if (STATE.pill) { STATE.pill.remove(); STATE.pill = null; }
  }

  function cancel() {
    if (!STATE.jobId) {
      close();
      return;
    }
    void fetch(`/api/voice-clone/${encodeURIComponent(STATE.jobId)}`, { method: "DELETE" }).catch(() => {});
    // The SSE channel will receive a `cancelled` event and run the
    // terminal-state path. As a UX fallback, also close immediately
    // since cancel is an intentional dismissal.
    setTimeout(close, 200);
  }

  function onKeyDown(e) {
    if (e.key !== "Escape") return;
    if (STATE.inProgress) { minimize(); return; }
    close();
  }

  // ── Overlay DOM ───────────────────────────────────────────────
  function mountOverlay(showProgressOnly) {
    if (STATE.overlay) STATE.overlay.remove();
    const title = tx("voice_clone_modal_title", { name: STATE.agentName }, `Clone voice · ${STATE.agentName}`);
    const labelPlaceholder = tx("voice_clone_label_placeholder", null, "Cloned voice name (optional)");
    const filePick = tx("voice_clone_file_pick", null, "Choose an audio or video file");
    const hint = tx(
      "voice_clone_hint",
      null,
      "Use a clean 10s-3min sample of the target voice. <strong>One voice cloning runs at a time.</strong>",
    );

    const root = document.createElement("div");
    root.className = "vc-overlay is-open";
    root.innerHTML = `
      <div class="vc-backdrop" data-vc-backdrop></div>
      <div class="vc-panel" role="dialog" aria-modal="true">
        <div class="vc-classification">
          <span>${escape(tx("voice_clone_classification_left", null, "// VOICE CLONE · CLASSIFIED"))}</span>
          <span class="right">${escape(tx("voice_clone_classification_right", null, "private board"))}</span>
        </div>
        <div class="vc-head">
          <div class="vc-title-wrap">
            <div class="meta">${escape(tx("voice_clone_head_meta", null, "// CLONE · ACTIVE"))}</div>
            <div class="title">${escape(title)}</div>
          </div>
          <div class="vc-head-controls">
            <button type="button" class="vc-head-btn" data-vc-minimize aria-label="${escape(tx("voice_clone_minimize", null, "Minimize"))}" title="${escape(tx("voice_clone_minimize", null, "Minimize"))}"></button>
            <button type="button" class="vc-head-btn" data-vc-close aria-label="${escape(tx("voice_clone_close", null, "Close"))}" title="${escape(tx("voice_clone_close", null, "Close"))}"></button>
          </div>
        </div>
        <div class="vc-body" data-vc-body${showProgressOnly ? " hidden" : ""}>
          <p class="vc-section-label">${escape(tx("voice_clone_source_label", null, "Voice source"))}</p>
          <div class="vc-source-modes" role="tablist">
            <button type="button" class="vc-source-mode is-active" data-vc-source-mode="upload" role="tab" aria-selected="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <span>${escape(tx("voice_clone_mode_upload", null, "Upload file"))}</span>
            </button>
            <button type="button" class="vc-source-mode" data-vc-source-mode="record" role="tab" aria-selected="false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
              <span>${escape(tx("voice_clone_mode_record", null, "Record voice"))}</span>
            </button>
          </div>

          <div class="vc-source-input" data-vc-mode-pane="upload">
            <label class="vc-file-pick" data-vc-file-pick>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <span class="vc-file-name" data-vc-file-name>${escape(filePick)}</span>
              <input type="file" accept="audio/*,video/*,.mp3,.m4a,.wav,.webm,.ogg,.mp4,.mov,.mkv" hidden data-vc-file-input>
            </label>
            <p class="vc-file-hint">${escape(tx("voice_clone_file_hint", null, "Audio: mp3 / m4a / wav · Video: mp4 / mov / webm — we'll pull the audio track in your browser."))}</p>
            <div class="vc-trim" data-vc-file-trim hidden>
              <div class="vc-trim-status" data-vc-trim-status>${escape(tx("voice_clone_trim_decoding", null, "Decoding audio…"))}</div>
              <div class="vc-trim-track" data-vc-trim-track hidden>
                <div class="vc-trim-track-fill" data-vc-trim-fill></div>
                <input type="range" class="vc-trim-range vc-trim-range-start" data-vc-trim-start min="0" max="100" step="0.1" value="0">
                <input type="range" class="vc-trim-range vc-trim-range-end" data-vc-trim-end min="0" max="100" step="0.1" value="100">
              </div>
              <div class="vc-trim-meta" data-vc-trim-meta hidden>
                <span data-vc-trim-start-label>0:00</span>
                <span class="vc-trim-meta-sep">→</span>
                <span data-vc-trim-end-label>0:00</span>
                <span class="vc-trim-meta-dur" data-vc-trim-dur-label></span>
              </div>
            </div>
          </div>

          <div class="vc-source-input" data-vc-mode-pane="record" hidden>
            <p class="vc-record-script">${escape(tx("voice_clone_record_script", null, "Read this aloud — it covers a wide phoneme range so the clone captures your timbre well:"))}</p>
            <blockquote class="vc-record-script-text">${escape(tx("voice_clone_record_script_text", null, "The quick brown fox jumps over the lazy dog. She sells seashells by the seashore. How vexingly quick daft zebras jump! Sphinx of black quartz, judge my vow."))}</blockquote>
            <div class="vc-record-stage">
              <button type="button" class="vc-record-btn" data-vc-record-toggle aria-label="${escape(tx("voice_clone_record_start", null, "Start recording"))}">
                <span class="vc-record-glyph" data-vc-record-glyph>●</span>
                <span class="vc-record-ring" aria-hidden="true"></span>
              </button>
              <div class="vc-record-meta">
                <span class="vc-record-time" data-vc-record-time>0:00</span>
                <span class="vc-record-state" data-vc-record-state>${escape(tx("voice_clone_record_idle", null, "Tap to record"))}</span>
              </div>
              <div class="vc-record-level" aria-hidden="true">
                <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
              </div>
            </div>
            <div class="vc-record-actions" data-vc-record-actions hidden>
              <button type="button" class="vc-btn" data-vc-record-play>${escape(tx("voice_clone_record_play", null, "Play back"))}</button>
              <button type="button" class="vc-btn" data-vc-record-redo>${escape(tx("voice_clone_record_redo", null, "Re-record"))}</button>
            </div>
          </div>
          <p class="vc-section-label" style="margin-top: 14px;">${escape(tx("voice_clone_label_label", null, "Label (optional)"))}</p>
          <div class="vc-label-input">
            <input type="text" placeholder="${escape(labelPlaceholder)}" data-vc-label maxlength="60">
          </div>
          <p class="vc-section-label" style="margin-top: 14px;" data-vc-mm-group-label>${escape(tx("voice_clone_minimax_group_label", null, "MiniMax Group ID"))}</p>
          <div class="vc-label-input" data-vc-mm-group-wrap>
            <input type="text" placeholder="${escape(tx("voice_clone_minimax_group_placeholder", null, "e.g. 1838xxxxxx · required if your key isn't a JWT"))}" data-vc-mm-group maxlength="64" autocomplete="off" spellcheck="false">
          </div>
          <p class="vc-hint">${hint}</p>
        </div>
        <div class="vc-progress" data-vc-progress${showProgressOnly ? "" : " hidden"}>
          ${progressInnerHtml()}
        </div>
        <div class="vc-success" data-vc-success hidden>
          ${successInnerHtml()}
        </div>
        <div class="vc-foot" data-vc-foot>
          ${footHtml(/* showCancel */ false)}
        </div>
      </div>
    `;
    document.body.appendChild(root);
    STATE.overlay = root;
    wireOverlay(root);

    if (showProgressOnly && STATE.jobId) {
      // Re-attach to running job: open SSE, update progress UI.
      ensureSse(STATE.jobId);
      updateProgressDom();
      updateFootForRunning();
    }
  }

  function progressInnerHtml() {
    const stages = [
      { key: "fetch", label: tx("voice_clone_stage_fetch", null, "Fetch audio") },
      { key: "upload", label: tx("voice_clone_stage_upload", null, "Upload to provider") },
      { key: "clone", label: tx("voice_clone_stage_train", null, "Wait for clone") },
    ];
    return `
      <div class="vc-stage-row">
        ${stages.map((s, i) => `
          <div class="vc-step" data-vc-step="${s.key}">
            <span class="vc-step-num">${i + 1}</span>
            <span class="vc-step-label">${escape(s.label)}</span>
            <span class="vc-step-pct" data-vc-step-pct="${s.key}">0%</span>
            <div class="vc-step-bar"><div class="vc-step-bar-fill" data-vc-step-fill="${s.key}"></div></div>
          </div>
        `).join("")}
      </div>
      <p class="vc-stage-text" data-vc-stage-text></p>
    `;
  }

  function successInnerHtml() {
    const samplePlaceholder = tx("voice_clone_preview_sample_placeholder", null, "Sample line for preview");
    return `
      <div class="vc-success-head">
        <div class="vc-success-kicker">${escape(tx("voice_clone_success_kicker", null, "// CLONED"))}</div>
        <div class="vc-success-title" data-vc-success-title></div>
      </div>
      <button type="button" class="vc-preview-btn" data-vc-preview aria-label="${escape(tx("voice_clone_preview_btn_aria", null, "Preview cloned voice"))}">
        <span class="vc-preview-glyph" data-vc-preview-glyph>▶</span>
        <span class="vc-preview-dots" aria-hidden="true"><i></i><i></i><i></i></span>
      </button>
      <textarea
        class="vc-preview-text"
        data-vc-preview-text
        rows="3"
        maxlength="240"
        placeholder="${escape(samplePlaceholder)}"
      ></textarea>
      <p class="vc-preview-hint">${escape(tx("voice_clone_preview_hint", null, "Edit the line above, then tap the play button to hear the cloned voice."))}</p>
    `;
  }

  function footHtml(showRunning) {
    if (showRunning) {
      return `
        <button type="button" class="vc-btn" data-vc-cancel>${escape(tx("voice_clone_cancel", null, "Cancel"))}</button>
        <button type="button" class="vc-btn vc-btn-primary" data-vc-minimize-btn>${escape(tx("voice_clone_minimize_btn", null, "Run in background"))}</button>
      `;
    }
    return `
      <button type="button" class="vc-btn" data-vc-dismiss>${escape(tx("voice_clone_dismiss", null, "Cancel"))}</button>
      <button type="button" class="vc-btn vc-btn-primary" data-vc-confirm disabled>${escape(tx("voice_clone_confirm", null, "Start cloning"))}</button>
    `;
  }

  function footTerminalHtml(isDone) {
    if (isDone) {
      return `
        <button type="button" class="vc-btn vc-btn-primary" data-vc-close>${escape(tx("voice_clone_apply_close_btn", null, "Apply and close"))}</button>
      `;
    }
    return `
      <button type="button" class="vc-btn" data-vc-close>${escape(tx("voice_clone_dismiss", null, "Cancel"))}</button>
      <button type="button" class="vc-btn vc-btn-primary" data-vc-retry>${escape(tx("voice_clone_retry", null, "Retry"))}</button>
    `;
  }

  function wireOverlay(root) {
    root.querySelector("[data-vc-backdrop]").addEventListener("click", () => {
      if (STATE.inProgress) minimize();
      else close();
    });
    root.querySelector("[data-vc-minimize]").addEventListener("click", minimize);
    root.querySelector("[data-vc-close]").addEventListener("click", () => {
      if (STATE.inProgress) { minimize(); return; }
      close();
    });

    // Mode switcher · upload vs record. Switching tears down any
    // open mic stream so we don't keep an active capture while the
    // user is fiddling with the file picker.
    const modeBtns = root.querySelectorAll("[data-vc-source-mode]");
    modeBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-vc-source-mode");
        if (mode === STATE.sourceMode) return;
        switchSourceMode(root, mode);
      });
    });

    // Record-mode controls
    const recordBtn = root.querySelector("[data-vc-record-toggle]");
    const recordPlay = root.querySelector("[data-vc-record-play]");
    const recordRedo = root.querySelector("[data-vc-record-redo]");
    if (recordBtn) recordBtn.addEventListener("click", toggleRecording);
    if (recordPlay) recordPlay.addEventListener("click", playRecording);
    if (recordRedo) recordRedo.addEventListener("click", () => {
      tearDownRecorder();
      STATE.recordBlob = null;
      STATE.selectedFile = null;
      STATE.decodedAudio = null;
      hydrateTrimPanel(root, null);
      const actions = root.querySelector("[data-vc-record-actions]");
      if (actions) actions.hidden = true;
      const stateLabel = root.querySelector("[data-vc-record-state]");
      if (stateLabel) stateLabel.textContent = tx("voice_clone_record_idle", null, "Tap to record");
      const timeEl = root.querySelector("[data-vc-record-time]");
      if (timeEl) timeEl.textContent = "0:00";
      refreshConfirmState();
    });

    // File input · on pick we decode via Web Audio API so the user
    // can preview the duration and pick a trim window. Works for
    // both audio (mp3 / m4a / wav / webm) and video (mp4 / mov /
    // webm) containers — the browser's `decodeAudioData` pulls the
    // audio track out of the video file for us.
    const fileInput = root.querySelector("[data-vc-file-input]");
    const filePick = root.querySelector("[data-vc-file-pick]");
    const fileNameEl = root.querySelector("[data-vc-file-name]");
    fileInput.addEventListener("change", () => {
      const f = fileInput.files && fileInput.files[0];
      STATE.selectedFile = f || null;
      STATE.selectedFileName = f ? f.name : "";
      STATE.selectedIsVideo = !!(f && f.type && f.type.startsWith("video/"));
      STATE.decodedAudio = null;
      STATE.trimStart = 0;
      STATE.trimEnd = 0;
      fileNameEl.textContent = f ? f.name : tx("voice_clone_file_pick", null, "Choose an audio or video file");
      filePick.classList.toggle("has-file", !!f);
      hydrateTrimPanel(root, f);
      refreshConfirmState();
    });

    // Label · required, used as the cloned voice's display name in
    // the picker. The Confirm button stays disabled until both file
    // and label are present (see refreshConfirmState).
    const labelInput = root.querySelector("[data-vc-label]");
    labelInput.addEventListener("input", () => {
      STATE.label = labelInput.value;
      refreshConfirmState();
    });

    // MiniMax Group ID · pre-fill from localStorage so the user only
    // ever has to type it once. Persisted on confirm; cleared on
    // explicit user blank-out.
    const groupInput = root.querySelector("[data-vc-mm-group]");
    if (groupInput) {
      try {
        const remembered = localStorage.getItem("pb.voice-clone.minimax-group-id") || "";
        if (remembered) {
          groupInput.value = remembered;
          STATE.miniMaxGroupId = remembered;
        }
      } catch { /* */ }
      groupInput.addEventListener("input", () => {
        STATE.miniMaxGroupId = groupInput.value.trim();
      });
    }

    wireFoot();
  }

  function wireFoot() {
    const root = STATE.overlay;
    if (!root) return;
    const foot = root.querySelector("[data-vc-foot]");
    foot.querySelectorAll("[data-vc-confirm]").forEach((b) => b.addEventListener("click", confirmStart));
    foot.querySelectorAll("[data-vc-dismiss]").forEach((b) => b.addEventListener("click", close));
    foot.querySelectorAll("[data-vc-cancel]").forEach((b) => b.addEventListener("click", cancel));
    foot.querySelectorAll("[data-vc-minimize-btn]").forEach((b) => b.addEventListener("click", minimize));
    foot.querySelectorAll("[data-vc-retry]").forEach((b) => b.addEventListener("click", retry));
    foot.querySelectorAll("[data-vc-close]").forEach((b) => b.addEventListener("click", close));
  }

  // ── Recording helpers ────────────────────────────────────────
  function switchSourceMode(root, mode) {
    STATE.sourceMode = mode;
    root.querySelectorAll("[data-vc-source-mode]").forEach((b) => {
      const active = b.getAttribute("data-vc-source-mode") === mode;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    root.querySelectorAll("[data-vc-mode-pane]").forEach((p) => {
      p.hidden = p.getAttribute("data-vc-mode-pane") !== mode;
    });
    // Wipe inputs on switch so confirm state matches the visible mode.
    if (mode === "upload") {
      // Free the mic stream when leaving record mode.
      tearDownRecorder();
      STATE.recordBlob = null;
    } else {
      STATE.selectedFile = null;
      STATE.selectedFileName = "";
      STATE.decodedAudio = null;
      const fileInput = root.querySelector("[data-vc-file-input]");
      if (fileInput) fileInput.value = "";
      const fileNameEl = root.querySelector("[data-vc-file-name]");
      if (fileNameEl) fileNameEl.textContent = tx("voice_clone_file_pick", null, "Choose an audio or video file");
      const filePick = root.querySelector("[data-vc-file-pick]");
      if (filePick) filePick.classList.remove("has-file");
      hydrateTrimPanel(root, null);
    }
    refreshConfirmState();
  }

  async function toggleRecording() {
    const root = STATE.overlay;
    if (!root) return;
    // If we're currently recording, stop.
    if (STATE.recorder && STATE.recorder.state === "recording") {
      try { STATE.recorder.stop(); } catch { /* */ }
      return;
    }
    // Re-recording · clear last take.
    STATE.recordBlob = null;
    STATE.selectedFile = null;
    STATE.decodedAudio = null;
    const actions = root.querySelector("[data-vc-record-actions]");
    if (actions) actions.hidden = true;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      alert(tx("voice_clone_record_mic_err", { msg: e?.message || String(e) }, `Microphone access denied: ${e?.message || e}`));
      return;
    }
    STATE.recorderStream = stream;

    const mime = pickRecorderMime();
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      alert(tx("voice_clone_record_init_err", { msg: e?.message || String(e) }, `Recorder init failed: ${e?.message || e}`));
      return;
    }
    STATE.recorder = recorder;
    STATE.recordChunks = [];
    STATE.recordStartedAt = performance.now();

    recorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0) STATE.recordChunks.push(e.data);
    });
    recorder.addEventListener("stop", () => onRecordingStopped(root));
    recorder.start();

    // UI state
    const btn = root.querySelector("[data-vc-record-toggle]");
    const glyph = root.querySelector("[data-vc-record-glyph]");
    const stateLabel = root.querySelector("[data-vc-record-state]");
    if (btn) btn.classList.add("is-recording");
    if (glyph) glyph.textContent = "■";
    if (stateLabel) stateLabel.textContent = tx("voice_clone_record_recording", null, "Recording… tap to stop");

    // Running counter + level meter
    if (STATE.recordTimerId) clearInterval(STATE.recordTimerId);
    STATE.recordTimerId = window.setInterval(() => {
      const elapsed = Math.floor((performance.now() - STATE.recordStartedAt) / 1000);
      const timeEl = root.querySelector("[data-vc-record-time]");
      if (timeEl) timeEl.textContent = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
      // Hard cap at 3 min to keep within MiniMax/ElevenLabs limits.
      if (elapsed >= 180) toggleRecording();
    }, 250);

    startLevelMeter(stream, root);
  }

  function onRecordingStopped(root) {
    if (STATE.recordTimerId) { clearInterval(STATE.recordTimerId); STATE.recordTimerId = 0; }
    stopLevelMeter();
    const chunks = STATE.recordChunks || [];
    const mime = (STATE.recorder && STATE.recorder.mimeType) || "audio/webm";
    if (chunks.length === 0) {
      tearDownRecorder();
      const stateLabel = root.querySelector("[data-vc-record-state]");
      if (stateLabel) stateLabel.textContent = tx("voice_clone_record_empty", null, "No audio captured. Try again.");
      return;
    }
    const blob = new Blob(chunks, { type: mime });
    STATE.recordBlob = blob;
    // Treat the recording as the selected source. The same code path
    // that handles file-mode trim + WAV encode kicks in next.
    STATE.selectedFile = new File([blob], `recording.${mime.includes("webm") ? "webm" : "audio"}`, { type: mime });
    STATE.selectedFileName = STATE.selectedFile.name;
    STATE.selectedIsVideo = false;

    // Stop the mic stream now that we've captured chunks.
    if (STATE.recorderStream) {
      STATE.recorderStream.getTracks().forEach((t) => t.stop());
      STATE.recorderStream = null;
    }
    STATE.recorder = null;

    // UI state · idle, show post-record actions.
    const btn = root.querySelector("[data-vc-record-toggle]");
    const glyph = root.querySelector("[data-vc-record-glyph]");
    const stateLabel = root.querySelector("[data-vc-record-state]");
    if (btn) btn.classList.remove("is-recording");
    if (glyph) glyph.textContent = "●";
    if (stateLabel) stateLabel.textContent = tx("voice_clone_record_ready", null, "Recording ready. Confirm to clone.");
    const actions = root.querySelector("[data-vc-record-actions]");
    if (actions) actions.hidden = false;

    // Run through the same decode + trim pipeline as a file upload —
    // the trim slider can still chop off head/tail silence even on a
    // self-recording. If decode fails (unusual codec) we'll just
    // upload the raw bytes.
    hydrateTrimPanel(root, STATE.selectedFile);
    refreshConfirmState();
  }

  function pickRecorderMime() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
    ];
    for (const m of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
    }
    return "";
  }

  function startLevelMeter(stream, root) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const bars = root.querySelectorAll(".vc-record-level i");
      STATE.recordLevelAudio = { ctx, src, analyser, raf: 0 };
      const tick = () => {
        if (!STATE.recordLevelAudio) return;
        analyser.getByteFrequencyData(data);
        // Aggregate into N bins to match bar count.
        const N = bars.length || 12;
        const step = Math.floor(data.length / N);
        for (let i = 0; i < N; i++) {
          let sum = 0;
          for (let j = 0; j < step; j++) sum += data[i * step + j];
          const avg = sum / step;
          const h = Math.min(100, Math.max(8, (avg / 200) * 100));
          if (bars[i]) bars[i].style.height = `${h}%`;
        }
        STATE.recordLevelAudio.raf = requestAnimationFrame(tick);
      };
      STATE.recordLevelAudio.raf = requestAnimationFrame(tick);
    } catch { /* level meter is decorative · ignore errors */ }
  }

  function stopLevelMeter() {
    const m = STATE.recordLevelAudio;
    if (!m) return;
    if (m.raf) cancelAnimationFrame(m.raf);
    try { m.src.disconnect(); } catch { /* */ }
    try { m.ctx.close(); } catch { /* */ }
    STATE.recordLevelAudio = null;
    // Decay the bars to baseline.
    const bars = STATE.overlay ? STATE.overlay.querySelectorAll(".vc-record-level i") : [];
    bars.forEach((b) => { b.style.height = "12%"; });
  }

  function tearDownRecorder() {
    if (STATE.recordTimerId) { clearInterval(STATE.recordTimerId); STATE.recordTimerId = 0; }
    stopLevelMeter();
    if (STATE.recorder && STATE.recorder.state === "recording") {
      try { STATE.recorder.stop(); } catch { /* */ }
    }
    if (STATE.recorderStream) {
      STATE.recorderStream.getTracks().forEach((t) => t.stop());
      STATE.recorderStream = null;
    }
    STATE.recorder = null;
    STATE.recordChunks = [];
    if (STATE.recordPreviewAudio) {
      try { STATE.recordPreviewAudio.pause(); } catch { /* */ }
      STATE.recordPreviewAudio = null;
    }
  }

  function playRecording() {
    if (!STATE.recordBlob) return;
    if (STATE.recordPreviewAudio) {
      try { STATE.recordPreviewAudio.pause(); } catch { /* */ }
      STATE.recordPreviewAudio = null;
    }
    const url = URL.createObjectURL(STATE.recordBlob);
    const audio = new Audio(url);
    STATE.recordPreviewAudio = audio;
    audio.addEventListener("ended", () => {
      try { URL.revokeObjectURL(url); } catch { /* */ }
      STATE.recordPreviewAudio = null;
    });
    audio.play().catch(() => { /* */ });
  }

  // ── Trim helpers ─────────────────────────────────────────────
  function formatMmSs(secs) {
    const s = Math.max(0, Math.floor(secs || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  async function hydrateTrimPanel(root, file) {
    const wrap = root.querySelector("[data-vc-file-trim]");
    const status = root.querySelector("[data-vc-trim-status]");
    const track = root.querySelector("[data-vc-trim-track]");
    const meta = root.querySelector("[data-vc-trim-meta]");
    if (!wrap || !status || !track || !meta) return;
    if (!file) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    track.hidden = true;
    meta.hidden = true;
    status.textContent = tx("voice_clone_trim_decoding", null, "Decoding audio…");

    try {
      const buf = await file.arrayBuffer();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error("Web Audio API unavailable");
      const ctx = new Ctx();
      const audio = await new Promise((resolve, reject) => {
        ctx.decodeAudioData(buf.slice(0), resolve, reject);
      });
      try { ctx.close(); } catch { /* */ }
      STATE.decodedAudio = audio;
      const duration = audio.duration;
      STATE.trimStart = 0;
      // Default selection · first 90 s (or full file if shorter), the
      // sweet spot for MiniMax / ElevenLabs voice cloning.
      STATE.trimEnd = Math.min(duration, 90);

      const startEl = root.querySelector("[data-vc-trim-start]");
      const endEl = root.querySelector("[data-vc-trim-end]");
      startEl.min = "0";
      startEl.max = String(duration);
      startEl.step = duration > 300 ? "1" : "0.1";
      startEl.value = "0";
      endEl.min = "0";
      endEl.max = String(duration);
      endEl.step = duration > 300 ? "1" : "0.1";
      endEl.value = String(STATE.trimEnd);

      const onSlide = () => {
        let s = parseFloat(startEl.value);
        let e = parseFloat(endEl.value);
        if (!Number.isFinite(s)) s = 0;
        if (!Number.isFinite(e)) e = duration;
        // Maintain ≥3s window so the user can't drag the handles
        // past each other into nothingness.
        const MIN_WIN = 3;
        if (e - s < MIN_WIN) {
          if (document.activeElement === startEl) s = Math.max(0, e - MIN_WIN);
          else e = Math.min(duration, s + MIN_WIN);
          startEl.value = String(s);
          endEl.value = String(e);
        }
        STATE.trimStart = s;
        STATE.trimEnd = e;
        repaintTrimMeta(root, duration);
      };
      startEl.addEventListener("input", onSlide);
      endEl.addEventListener("input", onSlide);

      status.textContent = "";
      status.hidden = true;
      track.hidden = false;
      meta.hidden = false;
      repaintTrimMeta(root, duration);
    } catch (e) {
      // Decode failed. For video files this means the browser
      // couldn't read the audio track out of the container (rare —
      // mp4 / mov / webm with AAC or Opus audio normally work in
      // Chromium and Safari; .mkv or unusual codecs are the most
      // common offenders). Block confirm rather than upload a video
      // file the provider APIs would reject.
      track.hidden = true;
      meta.hidden = true;
      if (STATE.selectedIsVideo) {
        status.textContent = tx(
          "voice_clone_trim_video_unsupported",
          null,
          "Couldn't extract audio from this video. Re-export it as mp4/mov (AAC) or convert to a plain audio file (mp3 / m4a / wav) and try again.",
        );
        // Force the user to re-pick · we cannot ship the raw video bytes.
        STATE.selectedFile = null;
        STATE.selectedFileName = "";
        refreshConfirmState();
      } else {
        status.textContent = tx(
          "voice_clone_trim_unsupported",
          null,
          "Can't preview this format; the file will be uploaded as-is.",
        );
      }
    }
  }

  function repaintTrimMeta(root, duration) {
    const startLab = root.querySelector("[data-vc-trim-start-label]");
    const endLab = root.querySelector("[data-vc-trim-end-label]");
    const durLab = root.querySelector("[data-vc-trim-dur-label]");
    const fill = root.querySelector("[data-vc-trim-fill]");
    if (startLab) startLab.textContent = formatMmSs(STATE.trimStart);
    if (endLab) endLab.textContent = formatMmSs(STATE.trimEnd);
    if (durLab) {
      const sel = Math.max(0, STATE.trimEnd - STATE.trimStart);
      durLab.textContent = tx("voice_clone_trim_selected", { sel: formatMmSs(sel), total: formatMmSs(duration) }, `· ${formatMmSs(sel)} of ${formatMmSs(duration)}`);
    }
    if (fill && duration > 0) {
      const startPct = (STATE.trimStart / duration) * 100;
      const endPct = (STATE.trimEnd / duration) * 100;
      fill.style.left = `${startPct}%`;
      fill.style.right = `${100 - endPct}%`;
    }
  }

  // PCM16 WAV encoder · no external deps. Used to ship the trimmed
  // AudioBuffer to /api/voice-clone/upload as `audio/wav`. MiniMax
  // and ElevenLabs both accept WAV cleanly.
  function encodeWavPcm16(audioBuffer) {
    const numCh = audioBuffer.numberOfChannels;
    const sr = audioBuffer.sampleRate;
    const numFrames = audioBuffer.length;
    const dataLen = numFrames * numCh * 2;
    const buffer = new ArrayBuffer(44 + dataLen);
    const view = new DataView(buffer);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataLen, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);              // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * numCh * 2, true); // byte rate
    view.setUint16(32, numCh * 2, true);       // block align
    view.setUint16(34, 16, true);              // bits per sample
    writeStr(36, "data");
    view.setUint32(40, dataLen, true);
    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(audioBuffer.getChannelData(c));
    let off = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let c = 0; c < numCh; c++) {
        let sample = channels[c][i];
        sample = Math.max(-1, Math.min(1, sample));
        view.setInt16(off, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        off += 2;
      }
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  async function trimToWavBlob(audioBuffer, startSec, endSec) {
    const sr = audioBuffer.sampleRate;
    const numCh = audioBuffer.numberOfChannels;
    const durSec = Math.max(0.5, endSec - startSec);
    const numFrames = Math.floor(durSec * sr);
    const OffCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OffCtx(numCh, numFrames, sr);
    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(ctx.destination);
    src.start(0, startSec, durSec);
    const trimmed = await ctx.startRendering();
    return encodeWavPcm16(trimmed);
  }

  function refreshConfirmState() {
    const root = STATE.overlay;
    if (!root) return;
    const confirmBtn = root.querySelector("[data-vc-confirm]");
    if (!confirmBtn) return;
    const hasFile = !!STATE.selectedFile;
    const hasLabel = !!(STATE.label && STATE.label.trim());
    confirmBtn.disabled = !(hasFile && hasLabel);
  }

  // ── Start / progress flow ─────────────────────────────────────
  async function confirmStart() {
    const root = STATE.overlay;
    if (!root) return;
    const confirmBtn = root.querySelector("[data-vc-confirm]");
    if (confirmBtn) confirmBtn.disabled = true;

    // Switch to progress view eagerly so the user sees feedback
    // even before the network round-trip resolves.
    root.querySelector("[data-vc-body]").hidden = true;
    root.querySelector("[data-vc-progress]").hidden = false;
    updateFootForRunning();

    try {
      // Upload local file (audio or video; if video, the browser
      // already decoded its audio track into STATE.decodedAudio and
      // we ship a trimmed WAV instead of the original container).
      setStageText(tx("voice_clone_uploading_file", null, "Uploading file…"));
      let blob, name;
      if (STATE.decodedAudio) {
        // Trim selection to a WAV blob in the browser before upload.
        // For video inputs this is also our audio-extract step —
        // OfflineAudioContext renders just the audio track out, no
        // video data leaves the browser. Keeps the payload small
        // (~5MB per minute @ 44.1k mono) so it stays under MiniMax
        // 20MB / ElevenLabs 10MB caps even when the source was a
        // 30-minute lecture or screen recording.
        setStageText(tx("voice_clone_trimming", null, "Trimming selection…"));
        blob = await trimToWavBlob(STATE.decodedAudio, STATE.trimStart, STATE.trimEnd);
        name = (STATE.selectedFileName || "source").replace(/\.[^.]+$/, "") + "-trim.wav";
        setStageText(tx("voice_clone_uploading_file", null, "Uploading file…"));
      } else {
        // Decoder failed earlier · just upload the original bytes.
        blob = STATE.selectedFile;
        name = STATE.selectedFile.name;
      }
      const fd = new FormData();
      fd.append("file", blob, name);
      const upRes = await fetch("/api/voice-clone/upload", { method: "POST", body: fd });
      if (!upRes.ok) throw new Error("upload failed");
      const upJson = await upRes.json();
      const source = { kind: "file", filePath: upJson.filePath };

      // Persist the Group ID so the next clone doesn't ask again.
      try {
        if (STATE.miniMaxGroupId) localStorage.setItem("pb.voice-clone.minimax-group-id", STATE.miniMaxGroupId);
      } catch { /* */ }

      const startRes = await fetch("/api/voice-clone/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: STATE.agentId,
          source,
          label: STATE.label,
          miniMaxGroupId: STATE.miniMaxGroupId || undefined,
        }),
      });
      if (!startRes.ok) {
        const err = await startRes.json().catch(() => ({ error: "unknown" }));
        throw new Error(String(err.error || `HTTP ${startRes.status}`));
      }
      const { jobId } = await startRes.json();
      STATE.jobId = jobId;
      STATE.inProgress = true;
      ensureSse(jobId);
    } catch (e) {
      setStageText(String(e && e.message || e), true);
      updateFootForTerminal(false);
    }
  }

  function ensureSse(jobId) {
    if (STATE.eventSource) { try { STATE.eventSource.close(); } catch { /* */ } STATE.eventSource = null; }
    const es = new EventSource(`/api/voice-clone/${encodeURIComponent(jobId)}/stream`);
    es.addEventListener("snapshot", (ev) => onProgressEvent(JSON.parse(ev.data)));
    es.addEventListener("progress", (ev) => onProgressEvent(JSON.parse(ev.data)));
    es.addEventListener("end", (ev) => {
      try { es.close(); } catch { /* */ }
      STATE.eventSource = null;
      onTerminal(JSON.parse(ev.data));
    });
    es.onerror = () => {
      // Transient errors trigger an auto-reconnect by EventSource;
      // we don't need to do anything here. Only act on `end`.
    };
    STATE.eventSource = es;
  }

  function onProgressEvent(ev) {
    STATE.jobId = ev.jobId;
    STATE.stage = ev.stage;
    STATE.pct = typeof ev.pct === "number" ? ev.pct : 0;
    STATE.status = ev.status;
    if (ev.message) setStageText(ev.message);
    if (ev.status === "running" || ev.status === "queued") STATE.inProgress = true;
    updateProgressDom();
    updatePillDom();
    if (ev.status === "done") onTerminal({ jobId: ev.jobId, status: "done", voiceId: ev.voiceId, label: ev.message, provider: ev.provider });
    if (ev.status === "failed" || ev.status === "cancelled") {
      STATE.errorCode = ev.errorCode || null;
      STATE.errorMessage = ev.errorMessage || null;
      onTerminal({ jobId: ev.jobId, status: ev.status });
    }
  }

  function onTerminal(payload) {
    STATE.inProgress = false;
    STATE.status = payload.status;
    if (payload.status === "done") {
      // CRITICAL · onTerminal fires TWICE on done · once from the
      // `progress` SSE event (full payload with voiceId/provider),
      // once again from the `end` SSE event (server side emits only
      // `{ jobId, status }` there). Only update STATE when the
      // payload actually carries a value · the previous code wrote
      // `STATE.clonedVoiceId = payload.voiceId || ""` which the end
      // event quietly cleared, so by the time the user pressed the
      // preview button STATE.clonedVoiceId was empty and the
      // playPreview short-circuit fired before a single byte of
      // audio left the browser. Same defensive pattern for provider.
      if (payload.voiceId) STATE.clonedVoiceId = payload.voiceId;
      if (payload.provider) STATE.clonedProvider = payload.provider;
      else if (!STATE.clonedProvider) STATE.clonedProvider = "minimax";
      // Idempotent guard · onTerminal can fire twice on `done`
      // (progress event + SSE end event). Run the one-shot side
      // effects (onApplied, success view hydrate, pill auto-close)
      // only the first time so we don't double-inject picker rows
      // or re-wire the preview button listener.
      if (!STATE.terminalHandled) {
        STATE.terminalHandled = true;
        // The friendly name is persisted on the server side in the
        // `voice_labels` table (see routes/voice-clone.ts →
        // setVoiceLabel) so it survives localStorage clears +
        // multi-device. We pass it forward to `onApplied` along
        // with the new voice_id so the caller can optimistically
        // inject a picker row (the upstream `/v1/get_voice`
        // catalogue typically takes 10-30s to reflect a brand-new
        // clone, so without injection the dropdown looks empty
        // until that propagation lands).
        if (STATE.onApplied) {
          try {
            STATE.onApplied({
              voiceId: STATE.clonedVoiceId,
              label: STATE.label || (payload.label || ""),
              provider: STATE.clonedProvider,
            });
          } catch { /* */ }
        }
      }
    }
    updateProgressDom();
    updatePillDom();
    updateFootForTerminal(payload.status === "done");
    if (payload.status === "done") {
      // Swap progress view for the success-with-preview view. Both
      // are idempotent — `hydrateSuccessView` checks the wired-once
      // flag, the hidden swap is no-op on the second pass.
      const root = STATE.overlay;
      if (root) {
        const prog = root.querySelector("[data-vc-progress]");
        const succ = root.querySelector("[data-vc-success]");
        if (prog) prog.hidden = true;
        if (succ) {
          succ.hidden = false;
          hydrateSuccessView(root);
        }
      }
    }
  }

  /** Populate the success view's title + sample line + wire preview
   *  button to /api/voices/preview. Idempotent · uses a data-attr
   *  marker so onTerminal firing twice doesn't double-bind the
   *  click handler (which would cause two parallel TTS requests on
   *  every tap). */
  function hydrateSuccessView(root) {
    const titleEl = root.querySelector("[data-vc-success-title]");
    const sampleEl = root.querySelector("[data-vc-preview-text]");
    const playBtn = root.querySelector("[data-vc-preview]");
    if (!titleEl || !sampleEl || !playBtn) return;
    const name = (STATE.label && STATE.label.trim()) || tx("voice_clone_preview_default_name", null, "this voice");
    titleEl.textContent = tx("voice_clone_success_title", { name }, `Cloned · ${name}`);
    if (!sampleEl.dataset.hydrated) {
      sampleEl.value = tx("voice_clone_preview_default_text", { name }, `I'm ${name}, a member of your private boardroom. Looking forward to working with you.`);
      sampleEl.dataset.hydrated = "1";
    }
    if (!playBtn.dataset.wired) {
      playBtn.addEventListener("click", playPreview);
      playBtn.dataset.wired = "1";
    }
  }

  async function playPreview() {
    const root = STATE.overlay;
    if (!root) return;
    // Second tap while playing or loading → stop and reset.
    if (STATE.previewBusy) {
      if (STATE.previewAudio) {
        try { STATE.previewAudio.pause(); } catch { /* */ }
        STATE.previewAudio = null;
      }
      STATE.previewBusy = false;
      setPreviewBtnState("idle");
      setPreviewStatus("");
      return;
    }
    const sample = root.querySelector("[data-vc-preview-text]");
    const text = (sample?.value || "").trim();
    if (!text) return;
    if (!STATE.clonedVoiceId) {
      setPreviewStatus(tx("voice_clone_preview_missing_voice", null, "No voice_id captured — re-open the clone modal."), true);
      return;
    }
    STATE.previewBusy = true;
    setPreviewBtnState("loading");
    setPreviewStatus("");
    try {
      const provider = STATE.clonedProvider || "minimax";
      const reqBody = {
        text,
        provider,
        model: provider === "elevenlabs" ? "eleven_multilingual_v2" : "speech-2.8-hd",
        voiceId: STATE.clonedVoiceId,
      };
      console.log("[voice-clone] preview request", reqBody);
      const res = await fetch("/api/voices/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      if (!res.ok) {
        let err = {};
        try { err = await res.json(); } catch { /* */ }
        const errMsg = err && err.error ? String(err.error) : `HTTP ${res.status}`;
        console.error("[voice-clone] preview HTTP error", res.status, err);
        throw new Error(errMsg);
      }
      // Endpoint returns `{ audioBase64, mimeType }` JSON. Decode the
      // base64 into a Blob and serve it through an object URL · a
      // `data:` URL of the same payload sometimes failed to play on
      // larger samples (Chrome's media element has a generous but
      // not unlimited buffer for data URLs) and surfaced as silent
      // playback with no error event.
      const json = await res.json();
      if (!json || !json.audioBase64) {
        console.error("[voice-clone] preview missing audio", json);
        throw new Error(json && json.error ? json.error : "no audio in response");
      }
      const mime = json.mimeType || "audio/mpeg";
      const bytes = base64ToBytes(json.audioBase64);
      const blob = new Blob([bytes], { type: mime });
      const url = URL.createObjectURL(blob);
      console.log("[voice-clone] preview audio", { mime, bytes: bytes.length, url });
      const audio = new Audio(url);
      audio.preload = "auto";
      STATE.previewAudio = audio;
      audio.addEventListener("ended", () => {
        STATE.previewBusy = false;
        STATE.previewAudio = null;
        try { URL.revokeObjectURL(url); } catch { /* */ }
        setPreviewBtnState("idle");
      });
      audio.addEventListener("error", (ev) => {
        console.error("[voice-clone] audio error", ev, audio.error);
        STATE.previewBusy = false;
        STATE.previewAudio = null;
        try { URL.revokeObjectURL(url); } catch { /* */ }
        setPreviewBtnState("idle");
        setPreviewStatus(tx("voice_clone_preview_audio_err", null, "Browser couldn't decode the audio. Try a different sample line."), true);
      });
      try {
        await audio.play();
        setPreviewBtnState("playing");
      } catch (e) {
        console.error("[voice-clone] audio.play() rejected", e);
        STATE.previewBusy = false;
        STATE.previewAudio = null;
        try { URL.revokeObjectURL(url); } catch { /* */ }
        setPreviewBtnState("idle");
        setPreviewStatus(String(e?.message || e), true);
      }
    } catch (e) {
      console.error("[voice-clone] preview failed", e);
      STATE.previewBusy = false;
      setPreviewBtnState("idle");
      setPreviewStatus(tx("voice_clone_preview_err", { msg: e?.message || String(e) }, `Preview failed: ${e?.message || e}`), true);
    }
  }

  /** base64 → Uint8Array · MiniMax returns audio as a base64 string
   *  (NOT a hex-encoded buffer like the streaming endpoint). We use
   *  `atob` then walk the binary string into a Uint8Array so the
   *  Blob constructor gets actual bytes rather than a re-encoded
   *  utf-8 view. */
  function base64ToBytes(b64) {
    const bin = atob(String(b64 || ""));
    const len = bin.length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Write a one-line status note under the preview button. Replaces
   *  the previous alert() flow so the user can read the error in
   *  place + we can show transient propagation hints. */
  function setPreviewStatus(text, isError) {
    const root = STATE.overlay;
    if (!root) return;
    let el = root.querySelector("[data-vc-preview-status]");
    if (!el) {
      el = document.createElement("p");
      el.setAttribute("data-vc-preview-status", "");
      el.className = "vc-preview-status";
      const hint = root.querySelector(".vc-preview-hint");
      hint?.parentNode?.insertBefore(el, hint.nextSibling);
    }
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
    el.style.display = text ? "" : "none";
  }

  function setPreviewBtnState(state) {
    const btn = STATE.overlay && STATE.overlay.querySelector("[data-vc-preview]");
    if (!btn) return;
    btn.classList.remove("is-loading", "is-playing");
    if (state === "loading") btn.classList.add("is-loading");
    else if (state === "playing") btn.classList.add("is-playing");
    const glyph = btn.querySelector("[data-vc-preview-glyph]");
    if (glyph) glyph.textContent = state === "playing" ? "■" : "▶";
  }

  // ── DOM updates ───────────────────────────────────────────────
  function updateProgressDom() {
    const root = STATE.overlay;
    if (!root) return;
    const order = ["fetch", "upload", "clone"];
    const activeIdx = order.indexOf(STATE.stage);
    for (let i = 0; i < order.length; i++) {
      const key = order[i];
      const step = root.querySelector(`[data-vc-step="${key}"]`);
      if (!step) continue;
      step.classList.remove("is-active", "is-done");
      if (i < activeIdx) step.classList.add("is-done");
      else if (i === activeIdx) {
        if (STATE.status === "done") step.classList.add("is-done");
        else step.classList.add("is-active");
      }
      const pctEl = root.querySelector(`[data-vc-step-pct="${key}"]`);
      const fillEl = root.querySelector(`[data-vc-step-fill="${key}"]`);
      const localPct = i < activeIdx ? 100
        : i === activeIdx ? Math.round(((STATE.pct - i * (100 / 3)) * 3))
        : 0;
      const clamped = Math.max(0, Math.min(100, localPct));
      if (pctEl) pctEl.textContent = `${clamped}%`;
      if (fillEl) fillEl.style.width = `${clamped}%`;
    }
  }

  function setStageText(text, isError) {
    const root = STATE.overlay;
    if (!root) return;
    const el = root.querySelector("[data-vc-stage-text]");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function updateFootForRunning() {
    const root = STATE.overlay;
    if (!root) return;
    const foot = root.querySelector("[data-vc-foot]");
    foot.innerHTML = footHtml(true);
    wireFoot();
  }

  function updateFootForTerminal(isDone) {
    const root = STATE.overlay;
    if (!root) return;
    const foot = root.querySelector("[data-vc-foot]");
    foot.innerHTML = footTerminalHtml(isDone);
    wireFoot();
    if (!isDone) {
      const msg = STATE.errorMessage || tx("voice_clone_failed", null, "Clone failed.");
      setStageText(msg, true);
    } else {
      setStageText(tx("voice_clone_success", null, "Voice cloned and applied to the director."));
    }
  }

  // ── Pill ──────────────────────────────────────────────────────
  function mountPill() {
    if (STATE.pill) STATE.pill.remove();
    const pill = document.createElement("aside");
    pill.className = "vc-pill";
    pill.setAttribute("role", "button");
    pill.setAttribute("tabindex", "0");
    pill.setAttribute("aria-label", tx("voice_clone_pill_aria", null, "Open voice cloning panel"));
    pill.innerHTML = `
      <span class="vc-pill-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
      </span>
      <span class="vc-pill-label" data-vc-pill-label>${escape(tx("voice_clone_pill_label", { pct: STATE.pct }, "Cloning"))}</span>
      <span class="vc-pill-pct" data-vc-pill-pct>${STATE.pct}%</span>
      <span class="vc-pill-progress"><span class="vc-pill-progress-fill" data-vc-pill-fill style="width: ${STATE.pct}%"></span></span>
    `;
    pill.addEventListener("click", restore);
    pill.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); restore(); } });
    document.body.appendChild(pill);
    STATE.pill = pill;
    updatePillDom();
  }

  function updatePillDom() {
    const pill = STATE.pill;
    if (!pill) return;
    pill.classList.toggle("is-failed", STATE.status === "failed" || STATE.status === "cancelled");
    pill.classList.toggle("is-done", STATE.status === "done");
    const labelEl = pill.querySelector("[data-vc-pill-label]");
    const pctEl = pill.querySelector("[data-vc-pill-pct]");
    const fillEl = pill.querySelector("[data-vc-pill-fill]");
    if (labelEl) {
      labelEl.textContent = STATE.status === "done"
        ? tx("voice_clone_pill_done", null, "Cloned")
        : STATE.status === "failed"
          ? tx("voice_clone_pill_failed", null, "Clone failed")
          : tx("voice_clone_pill_label_short", null, "Cloning");
    }
    if (pctEl) pctEl.textContent = STATE.status === "done" ? "✓" : `${STATE.pct}%`;
    if (fillEl) fillEl.style.width = `${STATE.pct}%`;
  }

  function retry() {
    // Reset state, keep agentId + source if available.
    const agentId = STATE.agentId;
    const agentName = STATE.agentName;
    const onApplied = STATE.onApplied;
    close();
    open({ agentId, agentName, onApplied });
  }

  // ── Boot · check for an active job and re-attach if present ───
  async function bootCheck() {
    try {
      const res = await fetch("/api/voice-clone/active", { cache: "no-store" });
      if (!res.ok) return;
      const j = (await res.json()).job;
      if (!j) return;
      STATE.agentId = j.agentId;
      STATE.jobId = j.id;
      STATE.stage = j.currentStage;
      STATE.pct = j.pct;
      STATE.status = j.status;
      STATE.inProgress = j.status === "running" || j.status === "queued";
      if (!STATE.inProgress) return;
      // Try to lift the agent name from window.app's cache.
      try {
        const a = root.app && root.app.agentsById && root.app.agentsById[j.agentId];
        if (a) STATE.agentName = a.name || "";
      } catch { /* */ }
      ensureSse(j.id);
      mountPill();
    } catch { /* */ }
  }

  // ── Public ────────────────────────────────────────────────────
  root.boardroomVoiceClone = { open, close, minimize, restore };

  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(bootCheck, 600);
  else document.addEventListener("DOMContentLoaded", () => setTimeout(bootCheck, 600));
})(typeof window !== "undefined" ? window : this);
