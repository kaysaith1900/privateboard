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
  };

  function isOpen() {
    return !!STATE.overlay;
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
    STATE.playlist = [];
    STATE.prefetched = new Map();
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
        <button type="button" class="vr-close" data-vr-close aria-label="Close">✕</button>
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
    el.addEventListener("click", (ev) => {
      const target = ev.target;
      if (!target || !(target instanceof Element)) return;
      if (target.closest("[data-vr-close]")) { ev.preventDefault(); close(); return; }
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
    if (!STATE.paused) {
      try { await STATE.audio.play(); }
      catch (e) {
        // Autoplay block · pause and let the user click resume.
        STATE.paused = true;
        renderPlayer();
      }
    }
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
    // Exposed for testing.
    _internals: { buildPlaylist, PROCEDURAL_KINDS },
  };
})(typeof window !== "undefined" ? window : globalThis);
