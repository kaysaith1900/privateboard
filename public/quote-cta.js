/* ═══════════════════════════════════════════
   QUOTE CTA · selection-driven follow-up
   ═══════════════════════════════════════════
   When the user selects text inside a director's message bubble,
   a small floating bar appears above the selection with two
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

   Director scope · selection only counts when both ends sit inside
   the same `article.msg` whose class is neither `user` nor `chair`.

   No backend changes · everything rides on existing /api/rooms/:id/
   messages POST and the markdown blockquote renderer in app.js.
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
    const nameEl = article.querySelector(".msg-name");
    const directorName = nameEl ? nameEl.textContent.trim() : "";
    // Adjourned rooms · CTA still shows but in a read-only state with
    // a hint instead of buttons. Surfacing the bar (rather than
    // silently doing nothing) tells the user "your selection was
    // detected" and explains why probe / second aren't available.
    const app = window.app;
    const adjourned = !!(app && app.currentRoom && app.currentRoom.status === "adjourned");
    return { article, bubble, range, text, directorId, directorName, adjourned };
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
      ? { ask: "追问", love: "附议" }
      : { ask: "Probe", love: "Second" };
    // Inline chat-bubble SVG · uses currentColor so it inherits the
    // hover lime / base text colour like the ★ glyph does.
    const askIcon = `
      <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="miter" stroke-linecap="square" aria-hidden="true">
        <path d="M2 3 H12 V9 H6.5 L4 11 L4 9 H2 Z"/>
      </svg>
    `;
    cta.innerHTML = `
      <button type="button" class="qcta-btn" data-qcta="ask">
        <span class="ico">${askIcon}</span><span>${t.ask}</span>
      </button>
      <button type="button" class="qcta-btn" data-qcta="second">
        <span class="ico">★</span><span>${t.love}</span>
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
      // Read-only state · the bar shows a hint about why instead of
      // doing anything. Bail before hideCTA so the user can keep
      // reading the hint while their selection stays.
      if (cta.classList.contains("qcta-readonly")) return;
      const action = btn.getAttribute("data-qcta");
      const sel = lastSelection;
      hideCTA();
      if (!sel || !sel.text) return;
      if (action === "ask") openAskOverlay(sel);
      else if (action === "second") submitSecond(sel);
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
    };
    // Read-only state · adjourned room. Hide buttons, show hint text
    // so the user knows the selection was detected but the room is
    // closed for new replies.
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
  });

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
