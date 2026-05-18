/* ═══════════════════════════════════════════
   IN-ROOM @ MENTION PICKER
   ═══════════════════════════════════════════
   Hooks the room's input bar textarea (`.ib-textarea[data-send-input]`).
   Typing `@` (at start of text or after whitespace) opens a floating
   checkbox menu above the input listing the directors currently in the
   room (chair + active members). Behaviour is "tick = insert /
   untick = remove" · every checkbox toggle rewrites the picker-owned
   text zone immediately, so the user sees the @handle land in the
   textarea as they click. No separate Enter/commit step.

   Region model
   ────────────
   When the picker opens we remember `trigger.start` (the position of
   the `@` glyph) and `zoneEnd` (the end of the picker-managed
   substring). On every check toggle we rebuild that range from the
   current `selectedOrder`, splice it into the textarea, and bump
   `zoneEnd`. When nothing is selected we restore the original
   `@<query>` so the user can keep typing to refine the filter.

   On close (Esc / click outside / Enter / next room nav) we push the
   final `selectedOrder` onto `pending` · `submitFromComposer()` reads
   it via `window.MentionPicker.consumePendingMentions(text)` and
   filters by handle-still-present-in-body so backspaced-out handles
   drop out cleanly.
*/
(function () {
  /* ── State ───────────────────────────────────────────────── */
  const state = {
    open: false,
    trigger: null,          // { start, end, query } at open time (start is fixed)
    zoneEnd: -1,            // dynamic end of picker-managed region in textarea
    query: "",              // current filter; refinable only while selection empty
    selected: new Set(),    // agent ids currently checked (multi)
    selectedOrder: [],      // [id, ...] in insertion order, for stable text rebuild
    filtered: [],
    activeIdx: -1,          // keyboard cursor
    pending: [],            // [{ id, handle }] persisted across opens until send
  };
  let pickerEl = null;
  let textarea = null;
  let _suppressClose = false;
  const HIDE_DEBOUNCE_MS = 60;

  /* ── Styles ──────────────────────────────────────────────── */
  function ensureStyles() {
    if (document.getElementById("mention-picker-styles")) return;
    const css = `
      .mention-picker {
        position: absolute;
        bottom: calc(100% + 6px);
        left: 8px;
        z-index: 40;
        width: 320px;
        max-height: 300px;
        padding: 6px;
        border: 1px solid var(--line-strong);
        border-radius: 12px;
        background: color-mix(in srgb, color-mix(in srgb, var(--panel-3) 78%, var(--bg) 22%) 92%, transparent);
        backdrop-filter: blur(24px) saturate(180%);
        -webkit-backdrop-filter: blur(24px) saturate(180%);
        box-shadow: 0 6px 28px rgba(0,0,0,0.28);
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-family: var(--sans, system-ui), sans-serif;
        font-size: 13px;
        color: var(--text);
      }
      .mention-picker[hidden] { display: none; }
      .mention-picker-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        padding: 4px 8px 2px;
        color: var(--text-soft);
        font-size: 11px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .mention-picker-list {
        list-style: none;
        margin: 0;
        padding: 0;
        overflow-y: auto;
        max-height: 220px;
      }
      .mention-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 8px;
        cursor: pointer;
        user-select: none;
      }
      .mention-row:hover,
      .mention-row[data-active="true"] {
        background: color-mix(in srgb, var(--lime) 12%, transparent);
      }
      .mention-row-cb {
        flex: 0 0 auto;
        width: 14px;
        height: 14px;
        margin: 0;
        accent-color: var(--lime);
        pointer-events: none;
      }
      .mention-row-av {
        flex: 0 0 auto;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        object-fit: cover;
        background: color-mix(in srgb, var(--panel-2) 60%, transparent);
      }
      .mention-row-name {
        flex: 1 1 auto;
        font-weight: 500;
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mention-row-handle {
        flex: 0 0 auto;
        color: var(--text-soft);
        font-size: 11px;
        font-family: var(--mono, ui-monospace), monospace;
      }
      .mention-row-empty {
        padding: 10px 12px;
        color: var(--text-soft);
        font-size: 12px;
        font-style: italic;
      }
      .mention-picker-foot {
        padding: 4px 8px 2px;
        color: var(--text-soft);
        font-size: 11px;
        letter-spacing: 0.06em;
        display: flex;
        justify-content: space-between;
      }
      .input-bar:has(.mention-picker) { position: relative; }
    `;
    const style = document.createElement("style");
    style.id = "mention-picker-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ── DOM helpers ─────────────────────────────────────────── */
  function ensurePicker(input) {
    const bar = input.closest(".input-bar");
    if (!bar) return null;
    let el = bar.querySelector("[data-mention-picker]");
    if (el) return el;
    ensureStyles();
    el = document.createElement("div");
    el.className = "mention-picker";
    el.setAttribute("data-mention-picker", "");
    el.setAttribute("role", "listbox");
    el.setAttribute("aria-label", "Mention a director");
    el.hidden = true;
    el.innerHTML = `
      <div class="mention-picker-head">
        <span>@ Mention</span>
        <span data-mention-count></span>
      </div>
      <ul class="mention-picker-list" data-mention-list></ul>
      <div class="mention-picker-foot">
        <span>↑↓ navigate · Space / click toggle</span>
        <span>Enter / Esc close</span>
      </div>
    `;
    bar.appendChild(el);
    return el;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /* ── Data ────────────────────────────────────────────────── */
  function getDirectors() {
    const app = window.app;
    if (!app) return [];
    const members = Array.isArray(app.currentMembers) ? app.currentMembers : [];
    const chair = app.currentChair || null;
    const seen = new Set();
    const out = [];
    if (chair && chair.id) {
      seen.add(chair.id);
      out.push(normalizeDirector(chair, true));
    }
    for (const m of members) {
      if (!m || !m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(normalizeDirector(m, false));
    }
    return out.filter((d) => !!d.handle);
  }

  function normalizeDirector(a, isChair) {
    const rawHandle = a.handle || a.slug || a.id || "";
    const handle = String(rawHandle).replace(/^[@/]/, "").trim();
    return {
      id: a.id,
      name: a.name || handle || a.id,
      handle,
      avatar: a.avatarPath || a.avatar || a.avatar_url || "",
      isChair,
    };
  }

  function directorById(id) {
    return getDirectors().find((d) => d.id === id) || null;
  }

  /* ── Trigger detection ───────────────────────────────────── */
  function findActiveMention(ta) {
    const value = ta.value;
    const caret = ta.selectionStart;
    if (typeof caret !== "number") return null;
    for (let i = caret - 1; i >= 0; i--) {
      const ch = value[i];
      if (ch === "@") {
        const before = i === 0 ? "" : value[i - 1];
        if (before === "" || /\s/.test(before)) {
          const query = value.substring(i + 1, caret);
          if (/\s/.test(query)) return null;
          return { start: i, end: caret, query };
        }
        return null;
      }
      if (/\s/.test(ch)) return null;
    }
    return null;
  }

  /* ── Filter + render ─────────────────────────────────────── */
  function applyFilter() {
    const q = (state.query || "").toLowerCase();
    const all = getDirectors();
    if (!q) {
      state.filtered = all;
      return;
    }
    state.filtered = all.filter((d) =>
      d.handle.toLowerCase().includes(q) ||
      d.name.toLowerCase().includes(q),
    );
  }

  function render() {
    if (!pickerEl) return;
    const list = pickerEl.querySelector("[data-mention-list]");
    const count = pickerEl.querySelector("[data-mention-count]");
    const selCount = state.selected.size;
    count.textContent = selCount ? `${selCount} picked` : "";
    if (!state.filtered.length) {
      list.innerHTML = `<li class="mention-row-empty">No matching director</li>`;
      return;
    }
    list.innerHTML = state.filtered.map((d, i) => {
      const checked = state.selected.has(d.id) ? "checked" : "";
      const active = i === state.activeIdx ? "true" : "false";
      const avHTML = d.avatar
        ? `<img class="mention-row-av" src="${escapeHtml(d.avatar)}" alt="">`
        : `<span class="mention-row-av"></span>`;
      const handleSuffix = d.isChair ? " · chair" : "";
      return `
        <li class="mention-row" data-mention-row data-agent-id="${escapeHtml(d.id)}"
            data-handle="${escapeHtml(d.handle)}" data-active="${active}" data-idx="${i}">
          <input type="checkbox" class="mention-row-cb" ${checked} tabindex="-1">
          ${avHTML}
          <span class="mention-row-name">${escapeHtml(d.name)}</span>
          <span class="mention-row-handle">@${escapeHtml(d.handle)}${handleSuffix}</span>
        </li>
      `;
    }).join("");
  }

  /* ── Textarea region rewrite ──────────────────────────────
     The picker owns the substring `[trigger.start, zoneEnd)`. Every
     check toggle calls this to materialise the current selection as
     `@h1 @h2 ` (with trailing space when non-empty) or the original
     `@<query>` (when empty). Setting textarea.value programmatically
     would normally fire our input handler and reopen / close the
     picker · we sidestep by NOT dispatching the input event and
     instead calling autosize directly. */
  function rebuildZone() {
    if (!textarea || !state.trigger) return;
    const inserts = state.selectedOrder
      .map((id) => directorById(id))
      .filter(Boolean);
    const insertText = inserts.length
      ? inserts.map((d) => `@${d.handle}`).join(" ") + " "
      : "@" + (state.query || "");
    const before = textarea.value.substring(0, state.trigger.start);
    const after = textarea.value.substring(state.zoneEnd);
    textarea.value = before + insertText + after;
    state.zoneEnd = state.trigger.start + insertText.length;
    textarea.setSelectionRange(state.zoneEnd, state.zoneEnd);
    // Autosize manually since we skipped dispatching `input`.
    if (window.app && typeof window.app.autosizeRoomInputTextarea === "function") {
      window.app.autosizeRoomInputTextarea();
    }
    textarea.focus();
  }

  /* ── Open / close / toggle ───────────────────────────────── */
  function open(ta, trigger) {
    textarea = ta;
    pickerEl = ensurePicker(ta);
    if (!pickerEl) return;
    state.open = true;
    state.trigger = { start: trigger.start, end: trigger.end, query: trigger.query };
    state.zoneEnd = trigger.end;
    state.query = trigger.query || "";
    state.selected = new Set();
    state.selectedOrder = [];
    state.activeIdx = 0;
    applyFilter();
    pickerEl.hidden = false;
    render();
  }

  function close() {
    if (!state.open) return;
    // Persist any inserted handles for the next send. consumePendingMentions
    // will dedupe against the textarea body so backspaced-out ones drop.
    for (const id of state.selectedOrder) {
      const d = directorById(id);
      if (d) state.pending.push({ id: d.id, handle: d.handle });
    }
    state.open = false;
    state.trigger = null;
    state.zoneEnd = -1;
    state.query = "";
    state.selected = new Set();
    state.selectedOrder = [];
    state.activeIdx = -1;
    if (pickerEl) pickerEl.hidden = true;
  }

  function toggleSelected(id) {
    if (!state.open) return;
    if (state.selected.has(id)) {
      state.selected.delete(id);
      state.selectedOrder = state.selectedOrder.filter((x) => x !== id);
    } else {
      state.selected.add(id);
      state.selectedOrder.push(id);
    }
    rebuildZone();
    render();
  }

  function moveActive(delta) {
    if (!state.filtered.length) return;
    const n = state.filtered.length;
    const next = (state.activeIdx + delta + n) % n;
    state.activeIdx = next;
    render();
    const row = pickerEl && pickerEl.querySelector(`.mention-row[data-idx="${next}"]`);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
  }

  function toggleActive() {
    if (state.activeIdx < 0 || state.activeIdx >= state.filtered.length) return;
    const d = state.filtered[state.activeIdx];
    if (d) toggleSelected(d.id);
  }

  /* ── Event wiring ────────────────────────────────────────── */
  // Input · detect new @ trigger, OR refine query while picker open
  // (query refinement only allowed before first selection).
  document.addEventListener("input", (e) => {
    const ta = e.target;
    if (!ta || !ta.matches || !ta.matches(".ib-textarea[data-send-input]")) return;
    if (state.open) {
      // Picker owns the input-bar region. Query refinement is only
      // meaningful before any selection · once the user has checked
      // anyone, the zone holds `@h1 @h2 ` (not `@<query>`) and free
      // typing would corrupt the layout. Lock to selection-empty.
      if (state.selectedOrder.length === 0) {
        const trigger = findActiveMention(ta);
        if (trigger && trigger.start === state.trigger.start) {
          state.trigger = { start: trigger.start, end: trigger.end, query: trigger.query };
          state.zoneEnd = trigger.end;
          state.query = trigger.query || "";
          applyFilter();
          if (state.activeIdx >= state.filtered.length) state.activeIdx = Math.max(0, state.filtered.length - 1);
          render();
        } else {
          close();
        }
      }
      return;
    }
    const trigger = findActiveMention(ta);
    if (trigger) open(ta, trigger);
  });

  // Keydown · arrow nav / Space toggle / Enter close / Esc close.
  // Capture phase so we intercept BEFORE the global Enter→submit
  // handler in app.js.
  document.addEventListener("keydown", (e) => {
    if (!state.open) return;
    const ta = e.target;
    if (!ta || !ta.matches || !ta.matches(".ib-textarea[data-send-input]")) return;
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // Enter always closes the picker · the host's submit handler
      // gets a clean keystroke right after (we don't preventDefault
      // when there's no selection, so a plain @-then-Enter sends
      // the message as expected).
      if (state.selectedOrder.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else {
        close();
      }
      return;
    }
    if (e.key === " " || e.code === "Space") {
      // Space toggles the active row · keeps multi-pick ergonomic
      // without breaking out of the picker.
      e.preventDefault();
      e.stopPropagation();
      toggleActive();
      return;
    }
  }, true);

  // Click row · toggle that director.
  document.addEventListener("click", (e) => {
    const row = e.target.closest && e.target.closest(".mention-row[data-agent-id]");
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    const id = row.getAttribute("data-agent-id");
    if (id) toggleSelected(id);
  });

  // Click outside menu · dismiss. Any click landing outside the
  // picker's own DOM closes it · including clicks back into the
  // textarea (user spec: blur from menu area = auto-dismiss). The
  // setTimeout lets row-click handlers run to completion before the
  // picker hides itself.
  document.addEventListener("mousedown", (e) => {
    if (!state.open) return;
    if (_suppressClose) return;
    if (e.target.closest && e.target.closest("[data-mention-picker]")) return;
    setTimeout(close, HIDE_DEBOUNCE_MS);
  });

  // Keyboard blur · Tab / programmatic focus-shift off the textarea
  // also dismisses the picker. focusout bubbles, so a single document
  // listener works. Defer with a microtask so a row-click's refocus
  // path (toggleSelected → rebuildZone → textarea.focus) wins the
  // race when the click happens to flicker focus.
  document.addEventListener("focusout", (e) => {
    if (!state.open) return;
    if (!textarea || e.target !== textarea) return;
    setTimeout(() => {
      if (!state.open) return;
      // Focus returned to the textarea (likely a row click that ran
      // textarea.focus()) · don't close.
      if (document.activeElement === textarea) return;
      // Focus moved into the picker itself (shouldn't happen since
      // rows aren't focusable, but defensive) · don't close.
      if (document.activeElement && document.activeElement.closest && document.activeElement.closest("[data-mention-picker]")) return;
      close();
    }, HIDE_DEBOUNCE_MS);
  });

  // Send button · drain selection before host submits.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest("[data-send-button]");
    if (!btn) return;
    if (state.open) close();
  });

  /* ── Public API ──────────────────────────────────────────── */
  window.MentionPicker = {
    consumePendingMentions(text) {
      // If the picker is still open (user hit Enter to submit
      // directly), flush its selection into pending first.
      if (state.open) close();
      if (!state.pending.length) return [];
      const body = String(text || "");
      const seen = new Set();
      const out = [];
      for (const p of state.pending) {
        if (seen.has(p.id)) continue;
        if (!body.includes(`@${p.handle}`)) continue;
        seen.add(p.id);
        out.push(p.id);
      }
      state.pending = [];
      return out;
    },
    close() { close(); },
  };
})();
