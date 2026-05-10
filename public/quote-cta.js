/* ═══════════════════════════════════════════
   QUOTE CTA · selection-driven follow-up
   ═══════════════════════════════════════════
   When the user selects text inside a director's message bubble,
   a small floating bar appears above the selection with three
   actions:

     ✎ Probe / 追问     →  opens an overlay; user types a question;
                          submits a user message that quotes the
                          selection (markdown blockquote) above the
                          question. Routes through the existing send
                          path: idle → send, mid-turn → interrupt-or-
                          queue choice modal, paused → server queues
                          for next round.

     ★ Second / 附议    →  one-click; submits the same shape with a
                          fixed parliamentary "Seconded." line below
                          the quote, signalling the user co-signs the
                          director's point. Same routing.

     ⌖ Save / 收藏     →  one-click; bookmarks the selection to the
                          chairman's notes (POST /api/notes). No room
                          message is created — this is a personal
                          collection, not a room interaction. Works
                          even in adjourned rooms (re-reading a
                          finished session is a primary use-case).
                          Keyboard shortcut: `S` (when a director
                          selection is live).

   Director scope · selection only counts when both ends sit inside
   the same `article.msg` whose class is neither `user` nor `chair`.

   Probe / Second ride existing /api/rooms/:id/messages. Save POSTs
   to /api/notes with quote + sentence-based context + char offsets
   (computed against the bubble's textContent so the in-room overlay
   can re-wrap the same span on next render).
*/
(function () {
  let cta = null;             // floating button bar
  let lastSelection = null;   // { text, directorId, directorName } — captured on showCTA

  // ── Selection scope · is the selection inside a director bubble? ──
  function getDirectorContext() {
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString().trim();
    if (text.length < 4) return null;
    const range = sel.getRangeAt(0);
    const anchor = sel.anchorNode;
    const focus = sel.focusNode;
    if (!anchor || !focus) return null;
    const elFor = (n) => (n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement);
    const anchorEl = elFor(anchor);
    const focusEl = elFor(focus);
    if (!anchorEl || !focusEl) return null;
    const bubble = anchorEl.closest(".msg-bubble");
    if (!bubble) return null;
    const article = bubble.closest("article.msg");
    if (!article) return null;
    // Reject user / chair messages — feature is director-only.
    if (article.classList.contains("user") || article.classList.contains("chair")) return null;
    // Both ends must be in the same message · cross-message selections
    // make no sense for "quote this passage from director X".
    if (focusEl.closest("article.msg") !== article) return null;

    // Director identity · the article carries data-author-id for
    // director bubbles (added in app.js messageHtml). Name comes from
    // the visible .msg-name span in the same message header.
    const directorId = article.dataset.authorId || "";
    const messageId = article.dataset.messageId || "";
    const nameEl = article.querySelector(".msg-name");
    const directorName = nameEl ? nameEl.textContent.trim() : "";
    // Adjourned rooms · the room is closed for new replies (Probe /
    // Second are disabled), but the user can still save notes from
    // it — re-reading a finished session is a primary use case.
    const app = window.app;
    const adjourned = !!(app && app.currentRoom && app.currentRoom.status === "adjourned");

    // Char offsets relative to bubble.textContent · let the in-room
    // overlay (Step 5) wrap the same span on next render. Computed
    // once here so save can fire on either the button click or the
    // `S` keyboard shortcut without re-walking the DOM.
    const offsets = computeOffsets(bubble, range);

    return {
      article, bubble, range, text, messageId,
      directorId, directorName, adjourned,
      charOffsetStart: offsets.start,
      charOffsetEnd: offsets.end,
      bubbleText: offsets.bubbleText,
    };
  }

  // Compute the char offset of a Range's start / end relative to a
  // container's textContent. Uses Range.toString().length on a
  // synthetic range that spans [container start → selection point],
  // which honours rendered text the same way textContent does (skips
  // markup, preserves visible characters). Returns -1 / -1 if the
  // walk fails (renderer falls back to no overlay).
  function computeOffsets(container, range) {
    const bubbleText = container.textContent || "";
    try {
      const before = document.createRange();
      before.setStart(container, 0);
      before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length;
      const inner = document.createRange();
      inner.setStart(range.startContainer, range.startOffset);
      inner.setEnd(range.endContainer, range.endOffset);
      const end = start + inner.toString().length;
      return { start, end, bubbleText };
    } catch {
      return { start: -1, end: -1, bubbleText };
    }
  }

  // Sentence-based context expansion · grabs ~1–2 sentences on each
  // side of the quote (capped at MAX_CHARS). Honours both ASCII
  // (.!?) and CJK (。！？) sentence terminators. Falls back to the
  // char cap if no boundary is found within the cap window.
  function expandContext(fullText, quoteStart, quoteEnd) {
    if (!fullText || quoteStart < 0 || quoteEnd < quoteStart) {
      return { before: "", after: "" };
    }
    const MAX_CHARS = 200;
    const SENTENCE_END = /[.!?。！？]/;
    let beforeStart = Math.max(0, quoteStart - MAX_CHARS);
    for (let i = quoteStart - 1; i >= beforeStart; i--) {
      if (SENTENCE_END.test(fullText[i])) {
        beforeStart = Math.min(i + 1, quoteStart);
        break;
      }
    }
    let afterEnd = Math.min(fullText.length, quoteEnd + MAX_CHARS);
    for (let i = quoteEnd; i < afterEnd; i++) {
      if (SENTENCE_END.test(fullText[i])) {
        afterEnd = Math.min(i + 1, fullText.length);
        break;
      }
    }
    return {
      before: fullText.slice(beforeStart, quoteStart),
      after: fullText.slice(quoteEnd, afterEnd),
    };
  }

  function lang() {
    try {
      if (window.app && typeof window.app.composerLanguage === "function") {
        return window.app.composerLanguage();
      }
    } catch { /* */ }
    return "en";
  }

  // ── Floating CTA bar ─────────────────────────────────────────
  function ensureCTA() {
    if (cta) return cta;
    cta = document.createElement("div");
    cta.className = "qcta";
    cta.setAttribute("role", "toolbar");
    const t = lang() === "zh"
      ? { ask: "追问", love: "附议", save: "收藏" }
      : { ask: "Probe", love: "Second", save: "Save" };
    // Inline chat-bubble SVG · uses currentColor so it inherits the
    // hover lime / base text colour like the ★ glyph does.
    const askIcon = `
      <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="miter" stroke-linecap="square" aria-hidden="true">
        <path d="M2 3 H12 V9 H6.5 L4 11 L4 9 H2 Z"/>
      </svg>
    `;
    // Bookmark glyph · matches the All Notes sidebar entry's icon
    // semantics (this action lands in that view).
    const saveIcon = `
      <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="miter" stroke-linecap="square" aria-hidden="true">
        <path d="M3.5 1.5 H10.5 V12.5 L7 9.5 L3.5 12.5 Z"/>
      </svg>
    `;
    cta.innerHTML = `
      <button type="button" class="qcta-btn" data-qcta="ask">
        <span class="ico">${askIcon}</span><span>${t.ask}</span>
      </button>
      <button type="button" class="qcta-btn" data-qcta="second">
        <span class="ico">★</span><span>${t.love}</span>
      </button>
      <button type="button" class="qcta-btn qcta-btn-save" data-qcta="save" title="Save to Notes · S">
        <span class="ico">${saveIcon}</span><span>${t.save}</span>
      </button>
      <span class="qcta-hint" data-qcta-hint></span>
    `;
    // Prevent the bar's mousedown from collapsing the selection BEFORE
    // the click reaches us — Chrome/Safari clear the selection on a
    // click outside the active range, which would defeat the bar.
    cta.addEventListener("mousedown", (e) => e.preventDefault());
    cta.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-qcta]");
      if (!btn) return;
      const action = btn.getAttribute("data-qcta");
      // Read-only state (adjourned rooms) blocks Probe / Second since
      // they post messages to a closed room. Save is exempt — the
      // user is bookmarking for personal review, not interacting.
      if (cta.classList.contains("qcta-readonly") && action !== "save") return;
      const sel = lastSelection;
      hideCTA();
      if (!sel || !sel.text) return;
      if (action === "ask") openAskOverlay(sel);
      else if (action === "second") submitSecond(sel);
      else if (action === "save") submitSave(sel);
    });
    document.body.appendChild(cta);
    return cta;
  }

  function showCTA(ctx) {
    const bar = ensureCTA();
    lastSelection = {
      text: ctx.text,
      directorId: ctx.directorId,
      directorName: ctx.directorName,
      messageId: ctx.messageId,
      charOffsetStart: ctx.charOffsetStart,
      charOffsetEnd: ctx.charOffsetEnd,
      bubbleText: ctx.bubbleText,
    };
    // Read-only state · adjourned room. Hide Probe / Second (they
    // post to a closed room); Save stays available — review-mode
    // bookmarking is a primary use case for adjourned sessions.
    bar.classList.toggle("qcta-readonly", !!ctx.adjourned);
    const hint = bar.querySelector("[data-qcta-hint]");
    if (hint) {
      hint.textContent = ctx.adjourned
        ? (lang() === "zh" ? "// 已结束的房间 · 只读" : "// adjourned · read-only")
        : "";
    }
    const rect = ctx.range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    // Render first so we can measure width.
    bar.classList.add("open");
    const barWidth = bar.offsetWidth;
    const barHeight = bar.offsetHeight;
    let top = window.scrollY + rect.top - barHeight - 8;
    if (top < window.scrollY + 4) {
      // Not enough room above · drop below the selection.
      top = window.scrollY + rect.bottom + 8;
    }
    let left = window.scrollX + rect.left + rect.width / 2 - barWidth / 2;
    left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + window.innerWidth - barWidth - 8));
    bar.style.top = top + "px";
    bar.style.left = left + "px";
  }

  function hideCTA() {
    if (cta) cta.classList.remove("open");
  }

  function refresh() {
    // Skip when the ask overlay is open — don't stack a CTA on top
    // of the modal's own selection.
    if (document.getElementById("qask-overlay")) { hideCTA(); return; }
    const ctx = getDirectorContext();
    if (!ctx) { hideCTA(); return; }
    showCTA(ctx);
  }

  // Show only AFTER the user finishes selecting · hide as soon as a
  // new mousedown begins so the bar doesn't track mid-drag. Skip the
  // mousedown-hide when the click originates inside the CTA itself
  // (otherwise clicking a button hides the bar before the click
  // handler can read the action).
  document.addEventListener("mousedown", (e) => {
    if (cta && cta.contains(e.target)) return;
    hideCTA();
  });
  document.addEventListener("mouseup", () => {
    // Defer one tick so the browser has finished updating the
    // selection before we measure it.
    requestAnimationFrame(refresh);
  });

  // Hide on scroll · the absolute-positioned bar would otherwise
  // float in stale coords as the chat pane scrolls.
  window.addEventListener("scroll", hideCTA, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideCTA();

    // `S` shortcut · save current selection to Notes. Only fires
    // when (a) a director-scoped selection is live, (b) no modifier
    // keys are pressed (Cmd/Ctrl/Alt would clobber browser
    // shortcuts), (c) the user isn't typing into an input. Skipping
    // when an input/textarea is focused avoids hijacking the `s`
    // key during composer typing — the qcta bar wouldn't have
    // shown for a non-director selection anyway.
    if ((e.key === "s" || e.key === "S")
        && !e.metaKey && !e.ctrlKey && !e.altKey
        && !isEditableTarget(e.target)
        && lastSelection
        && lastSelection.text
        && cta && cta.classList.contains("open")) {
      e.preventDefault();
      const sel = lastSelection;
      hideCTA();
      submitSave(sel);
    }
  });

  function isEditableTarget(node) {
    if (!node) return false;
    const tag = (node.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return true;
    if (node.isContentEditable) return true;
    return false;
  }

  // ── Ask-follow-up overlay ────────────────────────────────────
  function openAskOverlay(sel) {
    closeAskOverlay();
    const dirName = sel.directorName || "director";
    const t = lang() === "zh"
      ? {
          tag: "▸ 追问",
          quoteTag: "// 引自 " + dirName,
          placeholder: "把你想问的写在这里 · 回车发送，Shift+Enter 换行",
          send: "发送",
          cancel: "取消",
          status: "选区追问 · " + dirName,
        }
      : {
          tag: "▸ Probe",
          quoteTag: "// quoting " + dirName,
          placeholder: "Type your follow-up · Enter to send, Shift+Enter for newline",
          send: "Send",
          cancel: "Cancel",
          status: "selection · probing " + dirName,
        };
    const overlay = document.createElement("div");
    overlay.className = "qask-overlay";
    overlay.id = "qask-overlay";
    overlay.innerHTML = `
      <div class="qask-modal" role="dialog" aria-modal="true">
        <div class="qask-classification">
          <span><span class="dot">●</span> ${t.status}</span>
          <span class="right">${t.tag}</span>
        </div>
        <div class="qask-body">
          <div class="qask-quote">
            <div class="qask-quote-tag">${t.quoteTag}</div>
            <div class="qask-quote-body" data-qask-quote></div>
          </div>
          <div class="qask-input-wrap">
            <textarea class="qask-input" data-qask-input rows="3" placeholder="${escapeAttr(t.placeholder)}"></textarea>
          </div>
        </div>
        <div class="qask-foot">
          <button type="button" class="qask-btn" data-qask-cancel>${t.cancel}</button>
          <button type="button" class="qask-btn primary" data-qask-send disabled>${t.send}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector("[data-qask-quote]").textContent = sel.text;
    const input = overlay.querySelector("[data-qask-input]");
    const sendBtn = overlay.querySelector("[data-qask-send]");
    setTimeout(() => input.focus(), 30);
    input.addEventListener("input", () => {
      sendBtn.disabled = input.value.trim().length === 0;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !isImeComposing(e)) {
        e.preventDefault();
        if (!sendBtn.disabled) sendBtn.click();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeAskOverlay();
      }
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeAskOverlay();
    });
    overlay.querySelector("[data-qask-cancel]").addEventListener("click", closeAskOverlay);
    sendBtn.addEventListener("click", () => {
      const text = input.value.trim();
      if (!text) return;
      closeAskOverlay();
      submitProbe(sel, text);
    });
  }

  function closeAskOverlay() {
    const el = document.getElementById("qask-overlay");
    if (el) el.remove();
  }

  function isImeComposing(e) {
    return !!(e.isComposing || (e.nativeEvent && e.nativeEvent.isComposing) || e.keyCode === 229);
  }

  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ── Submit ──────────────────────────────────────────────────
  // Quote prefix · markdown blockquote, one "> " per line so multi-
  // line selections stay inside the quote when rendered by app.js's
  // markdown-ish renderBody. The attribution line (`> — @Director`)
  // sits inside the same blockquote so chair / readers see at a
  // glance who the user is quoting.
  function quoteBlock(text, directorName) {
    const lines = text.split(/\r?\n/).map((line) => "> " + line);
    if (directorName) lines.push("> — @" + directorName);
    return lines.join("\n");
  }

  function submitSecond(sel) {
    // Parliamentary acknowledgement · "I second this." · short and
    // ceremonial, matches the boardroom motif. No mentions array — a
    // second is a passive signal, not a question; the room continues
    // its normal cadence rather than forcing the seconded director
    // to immediately speak again.
    const reaction = lang() === "zh" ? "附议。" : "Seconded.";
    const body = quoteBlock(sel.text, sel.directorName) + "\n\n" + reaction;
    routeSend(body, []);
  }

  function submitProbe(sel, userText) {
    // Probe targets the quoted director · putting their id first in
    // mentions makes them the forced speaker for the next tick (per
    // tickRoom in src/orchestrator/room.ts), so the user's follow-up
    // gets answered by the right voice, not whoever's next in the
    // round-robin.
    const body = quoteBlock(sel.text, sel.directorName) + "\n\n" + userText;
    const mentions = sel.directorId ? [sel.directorId] : [];
    routeSend(body, mentions);
  }

  // ── Save to Notes ─────────────────────────────────────────────
  // POST /api/notes with quote + sentence-based context + char
  // offsets. No room interaction — this is a personal bookmark.
  async function submitSave(sel) {
    const app = window.app;
    const room = app && app.currentRoom;
    if (!room || !room.id) {
      toast(lang() === "zh" ? "无法保存：未打开房间" : "Can't save: no room open", "error");
      return;
    }
    if (!sel.messageId) {
      toast(lang() === "zh" ? "无法保存：未识别原文位置" : "Can't save: source not identified", "error");
      return;
    }
    const ctx = expandContext(
      sel.bubbleText || "",
      typeof sel.charOffsetStart === "number" ? sel.charOffsetStart : -1,
      typeof sel.charOffsetEnd === "number" ? sel.charOffsetEnd : -1,
    );
    const payload = {
      roomId: room.id,
      messageId: sel.messageId,
      quoteText: sel.text,
      contextBefore: ctx.before,
      contextAfter: ctx.after,
      charOffsetStart: sel.charOffsetStart,
      charOffsetEnd: sel.charOffsetEnd,
      authorName: sel.directorName,
    };
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || ("HTTP " + res.status));
      }
      const note = await res.json();
      toast(lang() === "zh" ? "已收藏到笔记" : "Saved to Notes", "ok");

      // Tell the rest of the app a note was created · sidebar badge
      // refreshes its count, in-room overlay (Step 5) wraps the
      // saved span. Listeners that don't exist yet are no-ops.
      try {
        document.dispatchEvent(new CustomEvent("note:created", { detail: { note } }));
      } catch { /* */ }
    } catch (err) {
      toast(
        (lang() === "zh" ? "保存失败：" : "Save failed: ") + (err && err.message ? err.message : err),
        "error",
      );
    }
  }

  // Lightweight toast · the app already has `app.notify(...)` in
  // some paths but not all; using a self-contained one keeps this
  // module independent. Lime for ok, red-tinted for error. Auto-
  // dismisses after 1.8s; click to dismiss early.
  //
  // Horizontal anchor · the toast sits over the CHAT COLUMN, not
  // the viewport center. Centering on the viewport pulls the
  // toast right of the chat (the sidebar eats ~280px on the left)
  // and reads as visually skewed. Recomputed every show so the
  // toast tracks sidebar collapse / window resize.
  let toastEl = null;
  let toastTimer = null;
  function positionToast() {
    if (!toastEl) return;
    const chat = document.querySelector(".chat-col") || document.querySelector('[data-main-view="room"]');
    if (!chat) {
      // Fallback · centre on viewport when the chat column isn't
      // mounted (e.g. notes page · toast still useful but anchor
      // missing). Same behaviour as before this fix.
      toastEl.style.left = "50%";
      return;
    }
    const r = chat.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    toastEl.style.left = cx + "px";
  }
  function toast(msg, kind) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "qcta-toast";
      toastEl.addEventListener("click", () => toastEl.classList.remove("open"));
      document.body.appendChild(toastEl);
    }
    toastEl.classList.remove("kind-ok", "kind-error");
    toastEl.classList.add("kind-" + (kind === "error" ? "error" : "ok"));
    toastEl.textContent = msg;
    positionToast();
    toastEl.classList.add("open");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.classList.remove("open");
    }, 1800);
  }

  /** Routing matrix:
   *    paused                 → auto-resume the room first, then send
   *    live + agent mid-turn  → open the interrupt-or-queue modal
   *    live + idle            → send straight through
   *
   *  Auto-resume on paused matches the user intent: they wrote a
   *  follow-up, they expect it to land. The server rejects POST
   *  /messages on paused rooms (409 "room is not live"), so without
   *  this the probe button silently fails on every paused room. */
  async function routeSend(body, mentions) {
    const app = window.app;
    if (!app || typeof app.sendMessage !== "function") return;
    const ms = Array.isArray(mentions) ? mentions : [];
    const status = app.currentRoom && app.currentRoom.status;
    try {
      if (status === "paused" && typeof app.resumeRoom === "function") {
        await app.resumeRoom();
      }
    } catch (err) {
      alert("Couldn't resume the room: " + (err && err.message ? err.message : err));
      return;
    }
    if (typeof app.isAgentSpeaking === "function" && app.isAgentSpeaking() && !app.pendingUserMessage) {
      if (typeof app.openSendChoiceModal === "function") {
        // openSendChoiceModal currently doesn't carry a mentions array
        // — the existing modal was built for the plain composer where
        // mentions are inferred from "@" tokens in the text. Our
        // attributed body already contains "@Director" inline, so the
        // server's text-based @mention path will catch it.
        app.openSendChoiceModal(body);
        return;
      }
    }
    app.sendMessage(body, ms).catch((err) => {
      alert("Send failed: " + (err && err.message ? err.message : err));
    });
  }
})();
