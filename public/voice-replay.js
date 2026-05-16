/**
 * Voice Replay · adjourned-room transcript playback.
 *
 * Public API · `window.boardroomVoiceReplay`:
 *   open({ roomId, messages, members, chair })
 *   close()
 *   isOpen()
 *
 * Flow on `open`:
 *   1. Key gate · GET /api/voices · if no usable provider beyond
 *      `browser` is configured, swap into the key-prompt mode
 *      (small CTA that deep-links to user-settings).
 *   2. Build playlist · filter messages to chair + directors (and
 *      optionally user, off by default), drop system / procedural
 *      markers. Earliest first.
 *   3. Mount the floating overlay · controls + speaker card +
 *      progress + per-message preview.
 *   4. Synthesise + play sequentially via a single `<audio>`
 *      element, pre-fetching N+1 while N plays for gapless
 *      handoff. Each message is highlighted + smooth-scrolled
 *      into view in the chat as it begins.
 *
 * Skipped always: system messages, round-open / round-prompt /
 * settings / no-brief / convening / chair-pick / web-search status
 * markers (anything where `meta.kind` is one of the procedural
 * kinds the chat renders as inline cards rather than spoken text).
 */
(function (root) {
  "use strict";

  /** Procedural meta kinds that carry no speakable content · the
   *  chat renders these as cards (round dividers, milestones,
   *  status updates) so reading them aloud just adds noise. */
  const PROCEDURAL_KINDS = new Set([
    "round-open",
    "round-prompt",
    "settings",
    "no-brief",
    "convening",
    "chair-pick",
    "web-search",
    "web-search-result",
    "tool-use",
  ]);

  /** Phase labels rotated through the loading state while the
   *  first message synthesises. Same vocabulary as the rest of
   *  the app's voice surface. */
  const STATE = {
    overlay: null,
    audio: null,
    playlist: [],
    members: [],
    chair: null,
    idx: 0,
    paused: false,
    speed: 1,
    skipUser: true,
    abortCtrl: null,
    prefetched: new Map(), // idx → { audioBase64, mimeType }
    /** Currently-active replay item · what the round-table stage
     *  reads via getActive() to drive seat highlights, the rt-bubble,
     *  and the subtitle bar. `state` flips to "thinking" while the
     *  next message is being fetched / synthesised, then "speaking"
     *  once audio.play resolves. Cleared on close + on playlist end. */
    active: null, // { messageId, authorId, kind, state, body }
    /** Room id the replay belongs to · captured from `open()` so
     *  the floating mini-player can jump back to the source room
     *  and so cross-room navigation knows whose audio is playing.
     *  Null when no replay is active. */
    roomId: null,
  };

  function isOpen() {
    return !!STATE.overlay;
  }

  function getActive() {
    return STATE.active;
  }

  /** Expose the live audio element so the round-table stage's
   *  subtitle bar can sync with playback time (currentTime /
   *  duration) when replay is active. The replay's audio is a
   *  single full-message clip (not a chunked stream), so the
   *  subtitle has to interpolate sentence position from the
   *  playhead — there's no per-chunk timing metadata available. */
  function getActiveAudio() {
    return STATE.audio || null;
  }

  function getRoomId() {
    return STATE.roomId || null;
  }

  /** Fire a "boardroom:replay-state" event so listeners (the cross-
   *  room mini-player in app.js) can sync the play/pause glyph
   *  without polling the audio element. Composed bubbling event so
   *  doc-level listeners catch it. */
  function emitStateChanged() {
    try {
      document.dispatchEvent(new CustomEvent("boardroom:replay-state", {
        detail: {
          open: isOpen(),
          paused: !!(STATE.audio && STATE.audio.paused),
          roomId: STATE.roomId || null,
        },
        bubbles: true,
      }));
    } catch { /* old browsers · noop */ }
  }

  /** Fire a DOM event so listeners (the room view's renderRoundTable
   *  + renderRoundTableHud) can repaint without each having to
   *  poll. Bubble + composed so a subtree listener catches it. */
  function emitActiveChanged() {
    try {
      const ev = new CustomEvent("boardroom:replay-active", {
        detail: STATE.active ? { ...STATE.active } : null,
        bubbles: true,
      });
      document.dispatchEvent(ev);
    } catch { /* IE-style envs · CustomEvent missing → noop */ }
  }

  function setActive(next) {
    STATE.active = next;
    emitActiveChanged();
  }

  /** Build the ordered playlist · keep chronological order, drop
   *  procedural / system messages, optionally drop user messages.
   *  Each entry carries everything the playback loop and the UI
   *  preview need so we don't re-derive on every step. */
  function buildPlaylist(messages, opts) {
    const skipUser = opts && opts.skipUser !== false; // default true
    const members = (opts && opts.members) || [];
    const chair = (opts && opts.chair) || null;
    const byId = new Map(members.map((a) => [a.id, a]));
    if (chair) byId.set(chair.id, chair);
    const out = [];
    for (const m of messages) {
      if (!m || !m.body || !m.body.trim()) continue;
      if (m.authorKind === "system") continue;
      const kind = m.meta && typeof m.meta.kind === "string" ? m.meta.kind : null;
      if (kind && PROCEDURAL_KINDS.has(kind)) continue;
      // Skip the streaming placeholder that hasn't finalized yet
      // (its body is empty or its meta marks it as in-flight).
      if (m.meta && m.meta.streaming === true) continue;
      const isUser = m.authorKind === "user";
      if (isUser && skipUser) continue;
      const agent = m.authorId ? byId.get(m.authorId) : null;
      out.push({
        messageId: m.id,
        kind: isUser ? "user" : (agent && agent.roleKind === "moderator" ? "chair" : "director"),
        authorId: m.authorId || null,
        authorName: agent
          ? agent.name
          : isUser
            ? "you"
            : (m.authorKind === "agent" ? "Director" : ""),
        authorRole: agent && agent.roleTag ? agent.roleTag : "",
        authorAvatar: agent && agent.avatarPath ? agent.avatarPath : null,
        body: m.body.trim(),
      });
    }
    return out;
  }

  // ─── Key gate ────────────────────────────────────────────────
  async function checkUsableTtsKey() {
    try {
      const r = await fetch("/api/voices");
      if (!r.ok) return false;
      const j = await r.json();
      const list = Array.isArray(j.voices) ? j.voices : [];
      // browser provider is the always-on no-cost fallback; for a
      // satisfying replay experience we want a real TTS key.
      return list.some((v) => v && v.provider !== "browser" && v.configured);
    } catch {
      return false;
    }
  }

  // ─── Open / close ────────────────────────────────────────────
  async function open(opts) {
    if (isOpen()) close();
    const messages = (opts && opts.messages) || [];
    const members = (opts && opts.members) || [];
    const chair = (opts && opts.chair) || null;
    STATE.members = members;
    STATE.chair = chair;
    STATE.roomId = (opts && opts.roomId) || null;
    STATE.skipUser = true;
    STATE.speed = 1;
    STATE.paused = false;
    STATE.idx = 0;
    STATE.prefetched = new Map();

    // Mount overlay shell first so the user gets immediate feedback
    // (loading state) while the key check + playlist build run.
    STATE.overlay = mountOverlay();
    setBusy(true, "Checking voice configuration…");

    const usable = await checkUsableTtsKey();
    if (!usable) {
      renderKeyPrompt();
      return;
    }

    const playlist = buildPlaylist(messages, { members, chair, skipUser: STATE.skipUser });
    if (playlist.length === 0) {
      renderEmpty();
      return;
    }
    STATE.playlist = playlist;
    setBusy(false);
    renderPlayer();
    void playCurrent();
  }

  function close() {
    if (STATE.audio) {
      try { STATE.audio.pause(); } catch { /* noop */ }
      STATE.audio.src = "";
      STATE.audio = null;
    }
    if (STATE.abortCtrl) {
      try { STATE.abortCtrl.abort(); } catch { /* noop */ }
      STATE.abortCtrl = null;
    }
    if (STATE.overlay) {
      try { STATE.overlay.remove(); } catch { /* noop */ }
      STATE.overlay = null;
    }
    clearActiveHighlight();
    removeInlineExpand(); // any inline pill in the input-bar drops too
    STATE.playlist = [];
    STATE.prefetched = new Map();
    STATE.roomId = null;
    setActive(null); // round-table stage clears its replay seat / subtitle
    emitStateChanged(); // cross-room mini-player drops too
  }

  // ─── Mount + render ──────────────────────────────────────────
  function mountOverlay() {
    const el = document.createElement("div");
    el.className = "voice-replay-overlay";
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", "Voice replay");
    el.innerHTML = `
      <div class="vr-head">
        <span class="vr-kicker"><span class="vr-kicker-glyph">♪</span> voice replay</span>
        <div class="vr-head-actions">
          <button type="button" class="vr-collapse" data-vr-collapse aria-label="Collapse" title="Collapse">_</button>
          <button type="button" class="vr-close" data-vr-close aria-label="Close">✕</button>
        </div>
      </div>
      <div class="vr-body" data-vr-body>
        <div class="vr-spinner-row">
          <span class="vr-spinner-dots">
            <span class="vr-spinner-dot"></span>
            <span class="vr-spinner-dot"></span>
            <span class="vr-spinner-dot"></span>
          </span>
          <span class="vr-spinner-text" data-vr-spinner-text>Loading…</span>
        </div>
      </div>
    `;
    document.body.appendChild(el);
    // Every fresh `open()` starts with the floating panel
    // expanded — collapse is a per-session preference, not a
    // sticky one. The previous version persisted `voice-replay.
    // collapsed` to localStorage so a re-open would mount
    // already-collapsed; that confused users who clicked the
    // bottom-bar Voice Replay button and saw the inline group
    // appear without the floating panel ever showing. The bug
    // looked like "Voice Replay morphs into Pause/Next/Stop
    // /Expand instead of opening the player." Solve by NOT
    // restoring the collapsed flag on cold open. Also clear any
    // legacy "1" left in storage from earlier builds so users
    // upgrading from those don't keep getting the same bug for
    // one more session before re-toggling.
    try { localStorage.removeItem("voice-replay.collapsed"); } catch { /* noop */ }
    el.addEventListener("click", (ev) => {
      const target = ev.target;
      if (!target || !(target instanceof Element)) return;
      if (target.closest("[data-vr-close]")) { ev.preventDefault(); close(); return; }
      if (target.closest("[data-vr-collapse]")) { ev.preventDefault(); toggleCollapsed(); return; }
      if (target.closest("[data-vr-pause]")) { ev.preventDefault(); togglePause(); return; }
      if (target.closest("[data-vr-skip]")) { ev.preventDefault(); skipCurrent(); return; }
      if (target.closest("[data-vr-speed]")) { ev.preventDefault(); cycleSpeed(); return; }
      if (target.closest("[data-vr-include-user]")) { ev.preventDefault(); toggleIncludeUser(); return; }
      if (target.closest("[data-vr-config]")) {
        ev.preventDefault();
        // Dismiss the replay overlay first · without this the
        // user-settings panel mounts on top while the replay
        // overlay's key-prompt is still visible behind it,
        // reading as two stacked dialogs. The user came here
        // to configure a key — voice replay has nothing more to
        // do until they come back and re-trigger it.
        close();
        if (typeof root.openUserSettings === "function") {
          root.openUserSettings({ section: "keys", focusProvider: "minimax" });
        }
        return;
      }
    });
    return el;
  }

  /** Doc-level handler for the inline replay control group in the
   *  input-bar's left cluster — those buttons are mounted OUTSIDE
   *  the overlay so the overlay-scoped click delegate above can't
   *  see them.
   *  Bound once per page lifetime; safe even when no replay is
   *  active (the buttons simply aren't in the DOM until
   *  toggleCollapsed mounts them). */
  if (!root.__vrInlineExpandBound && typeof document !== "undefined"
      && typeof document.addEventListener === "function") {
    root.__vrInlineExpandBound = true;
    document.addEventListener("click", (ev) => {
      const target = ev.target;
      if (!target || !(target instanceof Element)) return;
      if (target.closest("[data-vr-inline-next]")) {
        ev.preventDefault();
        skipCurrent();
        return;
      }
      if (target.closest("[data-vr-inline-pause]")) {
        ev.preventDefault();
        togglePause();
        return;
      }
      if (target.closest("[data-vr-inline-stop]")) {
        ev.preventDefault();
        close();
        return;
      }
      if (target.closest("[data-vr-inline-expand]")) {
        ev.preventDefault();
        toggleCollapsed();
        return;
      }
    });
  }

  /** Collapse the player by hiding the floating overlay entirely +
   *  surfacing the inline replay control group in the input-bar's
   *  left cluster, right after the Voice Replay icon. Audio
   *  keeps playing in the background; the user's content is no
   *  longer blocked.
   *
   *  The collapsed posture is per-session only. We deliberately
   *  do NOT persist to localStorage — restoring a collapsed flag
   *  on cold open would make a fresh `open()` look like the panel
   *  never appeared (it'd mount already-collapsed and hide the
   *  floating overlay), confusing users who expect the player to
   *  show every time they click Voice Replay. */
  function toggleCollapsed() {
    if (!STATE.overlay) return;
    const collapsed = STATE.overlay.classList.toggle("is-collapsed");
    if (collapsed) mountInlineExpand();
    else removeInlineExpand();
  }

  /** Slot the inline replay control group into the bottom-bar
   *  action group right after the existing Voice Replay anchor.
   *  Three buttons: Next (skip current message), Pause/Resume
   *  (toggles audio playback), Expand (re-opens the panel). The
   *  group reads as a sibling of Export / Voice Replay / Convene
   *  Follow-up via `.ghost-btn` chrome. Idempotent · re-mount is
   *  a no-op when the group is already present. */
  function mountInlineExpand() {
    if (document.querySelector("[data-vr-inline-group]")) return;
    const replayBtn = document.querySelector("[data-room-replay]");
    if (!replayBtn) return;
    const group = document.createElement("span");
    group.className = "vr-inline-group";
    group.setAttribute("data-vr-inline-group", "1");
    // Inline-SVG icons · all `currentColor` so they inherit
    // `.ghost-btn`'s text + lime-on-hover treatment. Standard
    // media-player vocabulary: filled triangles for play/skip,
    // filled bars for pause, stroked corner-out arrows for expand.
    // 14×14 viewBox sized down to 12px so the buttons stay tight.
    // Hover / aria-label carry the action text.
    const NEXT_SVG = `
      <svg class="vib-icon" viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
        <path d="M2 2 L7.5 7 L2 12 Z" fill="currentColor"/>
        <path d="M7 2 L12.5 7 L7 12 Z" fill="currentColor"/>
      </svg>
    `;
    const PAUSE_SVG = `
      <svg class="vib-icon" viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
        <rect x="3.5" y="2.5" width="2.5" height="9" rx="0.6" fill="currentColor"/>
        <rect x="8" y="2.5" width="2.5" height="9" rx="0.6" fill="currentColor"/>
      </svg>
    `;
    const PLAY_SVG = `
      <svg class="vib-icon" viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
        <path d="M3.5 2 L12 7 L3.5 12 Z" fill="currentColor"/>
      </svg>
    `;
    // Stash the play SVG on the constructor so refreshInlinePauseButton
    // can swap between Pause / Play without re-wiring the markup.
    group.dataset.vrPlaySvg = PLAY_SVG.trim();
    group.dataset.vrPauseSvg = PAUSE_SVG.trim();
    const STOP_SVG = `
      <svg class="vib-icon" viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
        <rect x="3" y="3" width="8" height="8" rx="0.6" fill="currentColor"/>
      </svg>
    `;
    const EXPAND_SVG = `
      <svg class="vib-icon" viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
        <!-- Top-right corner out -->
        <polyline points="8.5,3 11,3 11,5.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="11" y1="3" x2="7.5" y2="6.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        <!-- Bottom-left corner out -->
        <polyline points="5.5,11 3,11 3,8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="3" y1="11" x2="6.5" y2="7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
    `;
    group.innerHTML = `
      <button type="button" class="ib-action vr-inline-btn" data-vr-inline-next aria-label="Next message" title="Next message">${NEXT_SVG}</button>
      <button type="button" class="ib-action vr-inline-btn" data-vr-inline-pause aria-label="Pause" title="Pause"><span data-vib-pause-mark>${PAUSE_SVG}</span></button>
      <button type="button" class="ib-action vr-inline-btn" data-vr-inline-stop aria-label="Stop replay" title="Stop replay">${STOP_SVG}</button>
      <button type="button" class="ib-action vr-inline-btn vr-inline-expand" data-vr-inline-expand aria-label="Expand voice replay" title="Expand voice replay">${EXPAND_SVG}<span class="vie-pulse" aria-hidden="true"></span></button>
    `;
    replayBtn.insertAdjacentElement("afterend", group);
    // Hide the original Voice Replay anchor while the inline group
    // is showing — its job (open the player) is supplanted by the
    // inline Expand button. Stash the previous display so we can
    // restore it cleanly on remove.
    replayBtn.dataset.vrPrevDisplay = replayBtn.style.display || "";
    replayBtn.style.display = "none";
    refreshInlinePauseButton();
  }

  function removeInlineExpand() {
    const group = document.querySelector("[data-vr-inline-group]");
    if (group) group.remove();
    // Restore the original Voice Replay anchor in the bottom bar
    // so the user can re-trigger the player. We stashed the prior
    // inline display when we hid it; restore it (empty string ==
    // CSS default).
    const replayBtn = document.querySelector("[data-room-replay]");
    if (replayBtn) {
      const prev = replayBtn.dataset.vrPrevDisplay;
      replayBtn.style.display = (prev === undefined || prev === null) ? "" : prev;
      delete replayBtn.dataset.vrPrevDisplay;
    }
  }

  /** Sync the inline pause/resume button with the live STATE.paused
   *  flag. Called from mount, togglePause, and on advance so the
   *  glyph + label always read the current state. No-op when the
   *  inline group isn't mounted. */
  function refreshInlinePauseButton() {
    const mark = document.querySelector("[data-vib-pause-mark]");
    if (!mark) return;
    const group = document.querySelector("[data-vr-inline-group]");
    if (!group) return;
    const playing = STATE.audio && !STATE.paused && !STATE.audio.paused;
    // Pull the cached SVG sources stashed at mount time. innerHTML
    // assignment is fine — SVG strings are author-controlled
    // constants, not user input.
    mark.innerHTML = playing ? group.dataset.vrPauseSvg : group.dataset.vrPlaySvg;
    const btn = mark.closest("[data-vr-inline-pause]");
    if (btn) {
      const label = playing ? "Pause" : "Resume";
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
    }
  }

  function setBusy(busy, msg) {
    if (!STATE.overlay) return;
    const t = STATE.overlay.querySelector("[data-vr-spinner-text]");
    if (t && busy) t.textContent = msg || "Working…";
  }

  function renderKeyPrompt() {
    if (!STATE.overlay) return;
    const body = STATE.overlay.querySelector("[data-vr-body]");
    if (!body) return;
    body.innerHTML = `
      <div class="vr-key-prompt">
        <div class="vr-key-icon">♪</div>
        <div class="vr-key-text">
          <div class="vr-key-title">No TTS key configured</div>
          <div class="vr-key-deck">Voice replay needs a TTS provider · MiniMax, ElevenLabs, or OpenAI. Add one in settings, then come back.</div>
        </div>
        <div class="vr-key-actions">
          <button type="button" class="vr-cta" data-vr-config>[ Configure ]</button>
          <button type="button" class="vr-ghost" data-vr-close>Dismiss</button>
        </div>
      </div>
    `;
  }

  function renderEmpty() {
    if (!STATE.overlay) return;
    const body = STATE.overlay.querySelector("[data-vr-body]");
    if (!body) return;
    body.innerHTML = `
      <div class="vr-key-prompt">
        <div class="vr-key-icon">○</div>
        <div class="vr-key-text">
          <div class="vr-key-title">Nothing to replay</div>
          <div class="vr-key-deck">This room has no playable messages — the directors haven't spoken yet, or every message was a system marker.</div>
        </div>
        <div class="vr-key-actions">
          <button type="button" class="vr-ghost" data-vr-close>Dismiss</button>
        </div>
      </div>
    `;
  }

  function renderPlayer() {
    if (!STATE.overlay) return;
    const body = STATE.overlay.querySelector("[data-vr-body]");
    if (!body) return;
    const cur = STATE.playlist[STATE.idx];
    if (!cur) return;
    const total = STATE.playlist.length;
    const pct = Math.round(((STATE.idx) / total) * 100);
    const avatarHtml = cur.authorAvatar
      ? `<img class="vr-avatar" src="${escapeAttr(cur.authorAvatar)}" alt="${escapeAttr(cur.authorName)}">`
      : `<div class="vr-avatar vr-avatar-placeholder">${escapeText((cur.authorName || "?").charAt(0).toUpperCase())}</div>`;
    const roleLine = cur.authorRole
      ? `<span class="vr-author-role"> · ${escapeText(cur.authorRole)}</span>`
      : "";
    body.innerHTML = `
      <div class="vr-speaker">
        ${avatarHtml}
        <div class="vr-speaker-text">
          <div class="vr-speaker-name">${escapeText(cur.authorName || "—")}${roleLine}</div>
          <div class="vr-speaker-kind">${escapeText(cur.kind)}</div>
        </div>
      </div>
      <div class="vr-preview" data-vr-preview>${escapeText(truncatePreview(cur.body))}</div>
      <div class="vr-progress-row">
        <span class="vr-progress-counter">${STATE.idx + 1} / ${total}</span>
        <div class="vr-progress-bar"><div class="vr-progress-fill" style="width: ${pct}%"></div></div>
        <span class="vr-progress-pct">${pct}%</span>
      </div>
      <div class="vr-controls">
        <button type="button" class="vr-btn" data-vr-pause>${STATE.paused ? "▶ Resume" : "❚❚ Pause"}</button>
        <button type="button" class="vr-btn" data-vr-skip>⏭ Skip</button>
        <button type="button" class="vr-btn vr-btn-speed" data-vr-speed>${STATE.speed}×</button>
        <label class="vr-toggle">
          <input type="checkbox" data-vr-include-user${STATE.skipUser ? "" : " checked"} aria-label="Include my interjections">
          <span>include me</span>
        </label>
      </div>
    `;
  }

  // ─── Playback loop ───────────────────────────────────────────
  async function playCurrent() {
    if (!STATE.overlay) return;
    const cur = STATE.playlist[STATE.idx];
    if (!cur) { close(); return; }
    renderPlayer();
    highlightActive(cur.messageId);
    // Mark the seat as "thinking" while we fetch + synthesise. The
    // round-table stage reads this via getActive() and lights the
    // seat with a thinking bubble. Body is included so the stage
    // subtitle can preview the line that's about to be spoken.
    setActive({
      messageId: cur.messageId,
      authorId: cur.authorId,
      kind: cur.kind,
      state: "thinking",
      body: cur.body || "",
    });
    let payload;
    try {
      payload = await fetchAudio(STATE.idx);
    } catch (e) {
      // Surface error inline · don't crash the whole player.
      const body = STATE.overlay && STATE.overlay.querySelector("[data-vr-body]");
      if (body) {
        body.insertAdjacentHTML("beforeend", `
          <div class="vr-error">${escapeText(e && e.message ? e.message : String(e))}</div>
        `);
      }
      return;
    }
    if (!STATE.overlay) return;
    if (!payload || !payload.audioBase64) {
      // Skip silently to next message (e.g. browser-provider fallback).
      advance();
      return;
    }
    if (STATE.audio) { try { STATE.audio.pause(); } catch { /* noop */ } }
    STATE.audio = new Audio(`data:${payload.mimeType || "audio/mp3"};base64,${payload.audioBase64}`);
    STATE.audio.playbackRate = STATE.speed;
    STATE.audio.addEventListener("ended", () => advance());
    STATE.audio.addEventListener("error", () => advance());
    // Cross-room mini-player sync · its play/pause glyph keys off
    // audio.paused. A new Audio is created per message so listeners
    // must re-attach on every playCurrent. Also fires on the FIRST
    // attached state so the mini-player surfaces immediately.
    STATE.audio.addEventListener("play",  () => emitStateChanged());
    STATE.audio.addEventListener("pause", () => emitStateChanged());
    // Tick out a DOM event on every timeupdate (~4 Hz) so the
    // round-table stage's subtitle bar can poll currentTime /
    // duration and interpolate which sentence is being read. We
    // can't capture per-sentence timing for replay (the audio is
    // a single base64-decoded clip, not a chunked stream), so the
    // subtitle has to estimate · firing the event keeps the
    // cadence consistent without coupling the modules.
    STATE.audio.addEventListener("timeupdate", () => {
      try {
        const ev = new CustomEvent("boardroom:replay-tick", { bubbles: true });
        document.dispatchEvent(ev);
      } catch { /* old browsers · noop */ }
    });
    if (!STATE.paused) {
      try {
        await STATE.audio.play();
        // Audio is running · flip seat from "thinking" → "speaking".
        setActive({
          messageId: cur.messageId,
          authorId: cur.authorId,
          kind: cur.kind,
          state: "speaking",
          body: cur.body || "",
        });
      }
      catch (e) {
        // Autoplay block · pause and let the user click resume.
        STATE.paused = true;
        renderPlayer();
      }
    }
    // Sync the inline (collapsed) pause button so its glyph
    // tracks the live playback state across message handoffs.
    refreshInlinePauseButton();
    // Pre-fetch the next message while this one plays so the
    // handoff is gapless. Single in-flight pre-fetch.
    void prefetch(STATE.idx + 1);
  }

  function advance() {
    clearActiveHighlight();
    STATE.idx += 1;
    if (STATE.idx >= STATE.playlist.length) {
      // Playback complete · keep the overlay open with a "done"
      // message so the user can dismiss explicitly.
      setActive(null);
      const body = STATE.overlay && STATE.overlay.querySelector("[data-vr-body]");
      if (body) {
        body.innerHTML = `
          <div class="vr-key-prompt">
            <div class="vr-key-icon vr-key-icon-done">✓</div>
            <div class="vr-key-text">
              <div class="vr-key-title">Replay complete</div>
              <div class="vr-key-deck">Every message in this room has played back. Close to return to the chat.</div>
            </div>
            <div class="vr-key-actions">
              <button type="button" class="vr-ghost" data-vr-close>Close</button>
            </div>
          </div>
        `;
      }
      return;
    }
    void playCurrent();
  }

  async function fetchAudio(idx) {
    if (idx < 0 || idx >= STATE.playlist.length) return null;
    if (STATE.prefetched.has(idx)) {
      const cached = STATE.prefetched.get(idx);
      STATE.prefetched.delete(idx);
      return cached;
    }
    const item = STATE.playlist[idx];
    const r = await fetch("/api/voices/by-message/" + encodeURIComponent(item.messageId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asUser: item.kind === "user" }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const code = j && j.code ? j.code : "tts-error";
      const msg = (j && j.error) || ("HTTP " + r.status);
      // Tag the error so callers can route to the key-prompt if
      // the failure was provider-key related.
      const err = new Error(msg);
      err.code = code;
      throw err;
    }
    return r.json();
  }

  async function prefetch(idx) {
    if (idx < 0 || idx >= STATE.playlist.length) return;
    if (STATE.prefetched.has(idx)) return;
    try {
      const payload = await fetchAudio(idx);
      if (payload) STATE.prefetched.set(idx, payload);
    } catch { /* swallow · the real fetch on advance will re-error */ }
  }

  // ─── Controls ────────────────────────────────────────────────
  function togglePause() {
    if (!STATE.audio) {
      STATE.paused = !STATE.paused;
      renderPlayer();
      refreshInlinePauseButton();
      return;
    }
    if (STATE.audio.paused) {
      try { void STATE.audio.play(); } catch { /* noop */ }
      STATE.paused = false;
    } else {
      try { STATE.audio.pause(); } catch { /* noop */ }
      STATE.paused = true;
    }
    renderPlayer();
    refreshInlinePauseButton();
  }

  function skipCurrent() {
    if (STATE.audio) { try { STATE.audio.pause(); } catch { /* noop */ } }
    advance();
  }

  function cycleSpeed() {
    const order = [1, 1.25, 1.5, 2];
    const i = order.indexOf(STATE.speed);
    STATE.speed = order[(i + 1) % order.length];
    if (STATE.audio) STATE.audio.playbackRate = STATE.speed;
    renderPlayer();
  }

  function toggleIncludeUser() {
    STATE.skipUser = !STATE.skipUser;
    // Rebuild playlist from scratch · we kept the original state
    // on the calling side via app.currentMessages / members /
    // chair. Re-derive from the live app state.
    const app = root.app;
    if (!app) { renderPlayer(); return; }
    const newPlaylist = buildPlaylist(
      Array.isArray(app.currentMessages) ? app.currentMessages.slice() : [],
      { members: STATE.members, chair: STATE.chair, skipUser: STATE.skipUser },
    );
    if (newPlaylist.length === 0) { renderEmpty(); return; }
    // Try to keep the user near the same speaker · find the
    // playlist entry whose messageId matches the currently-playing
    // one; if the toggle removed that message, snap to the closest
    // surviving index.
    const curId = STATE.playlist[STATE.idx]?.messageId;
    let nextIdx = newPlaylist.findIndex((p) => p.messageId === curId);
    if (nextIdx < 0) {
      // Closest survivor · binary-style scan forward from curIdx.
      const oldIdx = STATE.idx;
      for (let i = oldIdx; i < STATE.playlist.length; i += 1) {
        const id = STATE.playlist[i]?.messageId;
        const found = newPlaylist.findIndex((p) => p.messageId === id);
        if (found >= 0) { nextIdx = found; break; }
      }
      if (nextIdx < 0) nextIdx = Math.min(oldIdx, newPlaylist.length - 1);
    }
    STATE.playlist = newPlaylist;
    STATE.idx = Math.max(0, nextIdx);
    STATE.prefetched = new Map();
    if (STATE.audio) { try { STATE.audio.pause(); } catch { /* noop */ } }
    void playCurrent();
  }

  // ─── Chat highlight / scroll-into-view ───────────────────────
  function highlightActive(messageId) {
    clearActiveHighlight();
    if (!messageId) return;
    const el = document.querySelector(`[data-message-id="${cssAttrEscape(messageId)}"]`);
    if (!el) return;
    el.classList.add("is-replay-active");
    // Inject the floating "▶ SPEAKING" chip · pinned absolute
    // so it doesn't disturb the bubble's flow. The dot inside
    // pulses to make the audio activity visceral. Removed in
    // clearActiveHighlight on advance / close.
    const chip = document.createElement("div");
    chip.className = "vr-now-playing";
    chip.setAttribute("data-vr-now-playing", "1");
    chip.innerHTML =
      '<span class="vr-np-mark">▶</span>' +
      '<span class="vr-np-dot" aria-hidden="true"></span>' +
      '<span class="vr-np-text">speaking</span>';
    el.appendChild(chip);
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch { /* noop */ }
  }
  function clearActiveHighlight() {
    document.querySelectorAll(".is-replay-active").forEach((n) => n.classList.remove("is-replay-active"));
    document.querySelectorAll('[data-vr-now-playing="1"]').forEach((n) => n.remove());
  }

  // ─── Helpers ─────────────────────────────────────────────────
  function escapeText(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeText(s).replace(/'/g, "&#39;");
  }
  function cssAttrEscape(s) {
    return String(s == null ? "" : s).replace(/(["\\])/g, "\\$1");
  }
  function truncatePreview(body) {
    const flat = String(body || "").replace(/\s+/g, " ").trim();
    return flat.length > 240 ? flat.slice(0, 237) + "…" : flat;
  }

  // Public API.
  root.boardroomVoiceReplay = {
    open: open,
    close: close,
    isOpen: isOpen,
    getActive: getActive,
    getActiveAudio: getActiveAudio,
    getRoomId: getRoomId,
    togglePause: togglePause,
    // Exposed for testing.
    _internals: { buildPlaylist, PROCEDURAL_KINDS },
  };
})(typeof window !== "undefined" ? window : globalThis);
