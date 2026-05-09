/* ═══════════════════════════════════════════
   ROOM SETTINGS OVERLAY
   ═══════════════════════════════════════════
   - Members section shows EVERY available director inline so the user
     can scroll the list and toggle add/remove in place. The old
     agent-picker sub-overlay was removed at the user's request.
   - Two-click confirm on member removal.
   - Every config change is logged to ROOM_STATE.history, surfaced in
     a "History" section inside the modal, AND emitted as a divider
     strip in the chat transcript.
*/
(function () {
  /** Tone tooltips · keep in lockstep with app.js. */
  const TONE_TIPS = {
    brainstorm:
      "Co-creator. Directors stand with you and push the idea outward — yes-and a contribution, name a concrete adjacent variant (\"what if we instead…\"), borrow pieces from another director's turn into new combinations. May end with one curious question, never a defense-demanding one.",
    constructive:
      "Sympathetic interrogator. They want you to win, but only via the strongest version. Each turn picks ONE load-bearing assumption and proposes the candidate stronger version that would stand. Disagreement is allowed, but every objection comes packaged with a forward path.",
    research:
      "Collaborative inquiry. The room mines the materials in front of it (your brief, web-search results, prior turns) for what's actually there. Each turn must cite a specific source piece, label it OBSERVATION / INFERENCE / SPECULATION, then extract the insight your lens makes salient. Defaults web search ON when a Brave key is configured.",
    debate:
      "Peer reviewer. Each turn opens by steelmanning your strongest claim (\"the strongest read of your point is…\") and only then attacks THAT version — naming a specific risk, demanding evidence, exposing the trade-off you're hiding. Sharp but professional. Skipping the steelman is a protocol violation.",
    critique:
      "Review board. The room audits a finished deliverable systematically — each turn names the dimension being audited (logic / evidence / scope / risk / etc.), surfaces 2–3 specific flaws labelled BLOCKER · MAJOR · MINOR, points at the load-bearing piece, and indicates the direction a fix would lie. At least one BLOCKER or MAJOR per turn is mandatory.",
  };

  /** Intensity tooltips · what each pick does to the directors' default
   *  speaking register. Surfaced via the per-chip info icon. */
  const INTENSITY_TIPS = {
    calm:
      "Long-form thinking aloud. Directors take the room slowly — pause to think, surface caveats, sit with ambiguity rather than rushing to resolve. Best for novel / ambiguous problems where premature conclusions cost more than slow ones.",
    sharp:
      "No hedging. Directors land each turn on a load-bearing claim and back it with the load-bearing reason. They cut the qualifying language (\"perhaps,\" \"could be,\" \"in some cases\") in favour of clear, falsifiable statements. Default for most rooms.",
    terse:
      "Telegraphic. One paragraph, often one sentence. Directors cut every warm-up, every diplomatic packaging, every \"I think\" — they state the conclusion and only justify if pressed. NOTE · this is the LENGTH dial, not the harshness dial. Whether a director pushes back hard or builds with you is set by Tone (brainstorm vs critique etc); Terse only decides how long they take saying it.",
  };

  /** Generic info popover · single floating element, hover-driven.
   *  Reads the tip text from the trigger's `data-info-body` attribute
   *  and the title from `data-info-title`. Dismissed on mouseleave
   *  (with a small grace window) or Esc. Replaces the tone-only
   *  popover with a kind-agnostic one used by both tone + intensity. */
  let infoPopHideTimer = null;
  function openInfoPopover(triggerEl) {
    if (infoPopHideTimer) { clearTimeout(infoPopHideTimer); infoPopHideTimer = null; }
    const title = triggerEl.getAttribute("data-info-title") || "";
    const body  = triggerEl.getAttribute("data-info-body") || "";
    if (!body) return;
    let pop = document.getElementById("rs-info-popover");
    if (!pop) {
      pop = document.createElement("div");
      pop.id = "rs-info-popover";
      pop.className = "rs-info-popover";
      document.body.appendChild(pop);
      // Stay open while the cursor is on the popover itself.
      pop.addEventListener("mouseenter", () => {
        if (infoPopHideTimer) { clearTimeout(infoPopHideTimer); infoPopHideTimer = null; }
      });
      pop.addEventListener("mouseleave", () => scheduleClosePopover());
    }
    pop.innerHTML = `
      ${title ? `<div class="rs-info-popover-head">${escape(title)}</div>` : ""}
      <div class="rs-info-popover-body">${escape(body)}</div>
    `;
    const r = triggerEl.getBoundingClientRect();
    const popH = pop.offsetHeight;
    const popW = pop.offsetWidth;
    let top = r.bottom + 6;
    if (top + popH > window.innerHeight - 12) top = r.top - popH - 6;
    let left = r.left + r.width / 2 - popW / 2;
    if (left + popW > window.innerWidth - 12) left = window.innerWidth - popW - 12;
    if (left < 12) left = 12;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(left)}px`;
  }
  function scheduleClosePopover() {
    if (infoPopHideTimer) clearTimeout(infoPopHideTimer);
    infoPopHideTimer = setTimeout(closeInfoPopover, 80);
  }
  function closeInfoPopover() {
    const el = document.getElementById("rs-info-popover");
    if (el) el.remove();
    if (infoPopHideTimer) { clearTimeout(infoPopHideTimer); infoPopHideTimer = null; }
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeInfoPopover();
  });

  // Standalone-preview fallback · used only when window.app.agents
  // isn't available (e.g. opening this file directly in the browser
  // without the boardroom server). Live data takes precedence.
  const FALLBACK_DIRECTORS = [
    { slug: "socrates",         name: "Socrates",         role: "Skeptic" },
    { slug: "first-principles", name: "First Principles", role: "Causal Reasoning" },
    { slug: "value-investor",   name: "Value Investor",   role: "Pattern Recognition" },
    { slug: "user-empathy",     name: "User-Empathy",     role: "Empathy Lens" },
    { slug: "long-horizon",     name: "Long Horizon",     role: "Historical Lens" },
    { slug: "phenomenologist",  name: "Phenomenologist",  role: "Intern · trial" }
  ];

  /** Return the full director catalog — live agents from window.app
   *  when present, otherwise the standalone fallback. Each entry has
   *  { slug, name, role, avatar } where avatar is the agent's stored
   *  avatarPath (data: URL for custom agents, /avatars/*.svg for seeds). */
  function getAvailableAgents() {
    const live = (window.app && Array.isArray(window.app.agents)) ? window.app.agents : null;
    if (live && live.length > 0) {
      return live
        .filter((a) => a.roleKind === "director")
        .map((a) => ({
          slug: a.id,
          name: a.name,
          role: a.roleTag || "Director",
          avatar: a.avatarPath || `avatars/${a.id}.svg`,
          modelV: a.modelV || "",
        }));
    }
    return FALLBACK_DIRECTORS.map((d) => ({ ...d, avatar: `avatars/${d.slug}.svg`, modelV: "" }));
  }

  /** Friendly labels for the modelV strings · same shape as the
   *  composer-pick row's model badge. Falls back to the raw modelV
   *  string when the agent's model isn't in the table (e.g. a brand-
   *  new model the catalog doesn't know about yet). */
  const MODEL_LABELS = {
    "sonnet-4-6":     "Sonnet 4.6",
    "opus-4-7":       "Opus 4.7",
    "opus-4-6":       "Opus 4.6",
    "opus-4-6-fast":  "Opus 4.6 Fast",
    "haiku-4-5":      "Haiku 4.5",
    "gpt-5-5":        "GPT-5.5",
    "gpt-5-4":        "GPT-5.4",
    "gpt-5-4-mini":   "GPT-5.4 Mini",
    "gpt-5-5-pro":    "GPT-5.5 Pro",
    "codex-5-4":      "ChatGPT Codex 5.4",
    "gemini-3-1":       "Gemini 3.1 Pro",
    "gemini-3-flash":   "Gemini 3 Flash",
    "gemini-3-1-flash": "Gemini 3.1 Flash Lite",
    "grok-4-3":       "Grok 4.3",
    "grok-4-1-fast":  "Grok 4.1 Fast",
    "grok-4-3":       "Grok 4.3",
    "grok-4-20":      "Grok 4.20",
    "deepseek-v4-pro": "DeepSeek V4 Pro",
  };
  function modelLabelFor(v) {
    if (!v) return "";
    return MODEL_LABELS[v] || v;
  }

  const NAMES = {};

  // Baseline state — synced from window.app.currentRoom each time the
  // overlay opens. The fallback values keep the page usable in standalone
  // preview (where window.app is absent).
  const ROOM_STATE = {
    title: "the minimum viable structure of a data flywheel",
    topic: "I want to build an AI assistant for enterprise HR teams — automated resume screening + interview guides. Does this idea hold up under three-director scrutiny?",
    number: 47,
    status: "live",
    turns: 5,
    elapsed: "04:32",
    opened: "Apr 28",
    members: ["socrates", "first-principles", "value-investor"],
    mode: "constructive",
    intensity: "sharp",
    style: "auto",
    incognito: false,
    history: [
      { ts: "Apr 28 · 21:08", who: "system", kind: "open",   label: "room opened" }
    ]
  };

  // Staged changes layered on top of ROOM_STATE — committed only when
  // the user clicks Confirm. The shape mirrors the room config keys.
  let STAGED = { mode: null, intensity: null, incognito: null };
  // Snapshot of ROOM_STATE.members at overlay-open time. The members
  // array itself is mutated optimistically by add/removeMember; this
  // baseline lets us detect "dirty" by diffing and lets us roll back
  // on Cancel.
  let MEMBERS_BASELINE = [];

  function effective(field) {
    return STAGED[field] !== null ? STAGED[field] : ROOM_STATE[field];
  }
  function membersDirty() {
    if (ROOM_STATE.members.length !== MEMBERS_BASELINE.length) return true;
    const baseSet = new Set(MEMBERS_BASELINE);
    for (const m of ROOM_STATE.members) {
      if (!baseSet.has(m)) return true;
    }
    return false;
  }
  function isDirty() {
    return (
      STAGED.mode !== null ||
      STAGED.intensity !== null ||
      STAGED.incognito !== null ||
      membersDirty()
    );
  }
  function resetStaged() {
    STAGED = { mode: null, intensity: null, incognito: null };
  }

  const MODES = [
    { v: "brainstorm",   label: "Brainstorm",   desc: "yes-and" },
    { v: "constructive", label: "Constructive", desc: "push & sharpen" },
    { v: "research",     label: "Research",     desc: "mine the material" },
    { v: "debate",       label: "Debate",       desc: "find holes" },
    { v: "critique",     label: "Critique",     desc: "audit the deliverable" }
  ];


  function escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function nowStamp() {
    const d = new Date();
    const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${month} ${d.getDate()} · ${hh}:${mm}`;
  }
  function clockOnly() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  /* ─── Markup builders ─── */

  /** Flat row mirroring the new-room composer's `.composer-pick-row` ·
   *  checkbox · avatar · name + role · model badge · info button. The
   *  whole row is clickable; toggles staged membership. Avatar + info
   *  click separately to open the agent profile. The footer's
   *  [Confirm] / [Cancel] commits the staged changes — no per-row
   *  two-click confirm any more. */
  function memberRowHTML(d, isActive) {
    const modelLabel = modelLabelFor(d.modelV);
    const modelHtml = modelLabel
      ? `<span class="rs-member-model" title="${escape(modelLabel)}">${escape(modelLabel)}</span>`
      : "";
    return `
      <div class="rs-member${isActive ? " on" : ""}" data-slug="${d.slug}" data-rs-toggle role="button" tabindex="0">
        <input type="checkbox" class="rs-member-check" data-slug="${d.slug}"${isActive ? " checked" : ""}>
        <div class="rs-member-img" data-agent-link="${d.slug}">
          <img class="rs-member-av" src="${escape(d.avatar)}" alt="${escape(d.name)}" data-agent-link="${d.slug}">
        </div>
        <div class="rs-member-main">
          <span class="rs-member-name">${escape(d.name)}</span>
          <span class="rs-member-tag">${escape(d.role)}</span>
        </div>
        ${modelHtml}
        <button type="button" class="rs-member-info" data-agent-link="${d.slug}" aria-label="Open ${escape(d.name)} profile">i</button>
      </div>
    `;
  }

  function historyRowHTML(h) {
    let icon = "·";
    let cls = "h-misc";
    if (h.kind === "member-add")    { icon = "+"; cls = "h-add"; }
    if (h.kind === "member-remove") { icon = "−"; cls = "h-remove"; }
    if (h.kind === "mode")          { icon = "↔"; cls = "h-config"; }
    if (h.kind === "style")         { icon = "↔"; cls = "h-config"; }
    if (h.kind === "intensity")     { icon = "↔"; cls = "h-config"; }
    if (h.kind === "open")          { icon = "▸"; cls = "h-system"; }
    return `
      <li class="rs-history-row ${cls}">
        <span class="h-time">${escape(h.ts)}</span>
        <span class="h-icon">${icon}</span>
        <span class="h-label">${escape(h.label)}</span>
        <span class="h-who">${escape(h.who)}</span>
      </li>
    `;
  }

  function modalHTML() {
    return `
      <div class="room-settings-overlay" id="room-settings-overlay" role="dialog" aria-modal="true" aria-hidden="true">
        <div class="room-settings-modal" role="document">

          <div class="rs-classification">
            <span><span class="dot">●</span> room · settings</span>
            <span class="right">// private</span>
          </div>

          <header class="rs-head">
            <div class="rs-head-text">
              <div class="meta">// room #<span class="rs-number">${ROOM_STATE.number}</span> · <span class="live">${ROOM_STATE.status}</span> · <span class="rs-turns">${ROOM_STATE.turns}</span> turns</div>
              <div class="rs-title-wrap">
                <div class="title rs-title is-clamped" data-rs-title>${escape(ROOM_STATE.title)}</div>
                <button type="button" class="rs-title-toggle" data-rs-title-toggle hidden>Show more</button>
              </div>
            </div>
            <button type="button" class="close-btn" aria-label="Close">✕</button>
          </header>

          <!-- Single-page spec sheet · four compact rows. Members
               opens a director picker popover (mirrors the new-room
               composer's pattern); tone / intensity are inline chip
               rows; memory is a single toggle. -->
          <div class="rs-body">
            <div class="rs-config-list">

              <div class="rs-config-row">
                <div class="rs-config-row-label">
                  <span class="rs-config-row-name">Directors</span>
                  <span class="rs-config-row-hint">at this table</span>
                </div>
                <div class="rs-cast-wrap">
                  <button type="button" class="rs-cast-btn" data-rs-cast-trigger>
                    <span class="rs-cast-stack" data-rs-cast-stack></span>
                    <span class="rs-cast-count" data-rs-cast-count>—</span>
                    <span class="rs-cast-chevron">▾</span>
                  </button>
                </div>
              </div>

              <div class="rs-config-row">
                <div class="rs-config-row-label">
                  <span class="rs-config-row-name">Tone</span>
                  <span class="rs-config-row-hint">how hard they push</span>
                </div>
                <div class="rs-mode-grid rs-mode-row"></div>
              </div>

              <div class="rs-config-row">
                <div class="rs-config-row-label">
                  <span class="rs-config-row-name">Intensity</span>
                  <span class="rs-config-row-hint" data-rs-intensity-hint>currently: sharp</span>
                </div>
                <div class="rs-intensity-chips">
                  <button type="button" class="rs-chip rs-chip-mini" data-rs-intensity-pick="calm">
                    <span class="rs-chip-label">Calm</span>
                    <span class="rs-chip-info rs-info-trigger" data-info-title="Calm" data-info-body="${escape(INTENSITY_TIPS.calm)}" tabindex="-1" aria-label="What 'Calm' means">i</span>
                  </button>
                  <button type="button" class="rs-chip rs-chip-mini" data-rs-intensity-pick="sharp">
                    <span class="rs-chip-label">Sharp</span>
                    <span class="rs-chip-info rs-info-trigger" data-info-title="Sharp" data-info-body="${escape(INTENSITY_TIPS.sharp)}" tabindex="-1" aria-label="What 'Sharp' means">i</span>
                  </button>
                  <button type="button" class="rs-chip rs-chip-mini" data-rs-intensity-pick="terse">
                    <span class="rs-chip-label">Terse</span>
                    <span class="rs-chip-info rs-info-trigger" data-info-title="Terse" data-info-body="${escape(INTENSITY_TIPS.terse)}" tabindex="-1" aria-label="What 'Terse' means">i</span>
                  </button>
                </div>
              </div>

              <div class="rs-config-row">
                <div class="rs-config-row-label">
                  <span class="rs-config-row-name">Memory</span>
                  <span class="rs-config-row-hint">long-term learning about you</span>
                </div>
                <label class="rs-toggle-row" data-rs-incognito-label>
                  <input type="checkbox" class="rs-incognito-check" data-rs-incognito-check>
                  <span class="rs-toggle-label">Incognito — don't extract memory from this room</span>
                </label>
              </div>

            </div>
          </div>

          <footer class="rs-foot">
            <div class="saved" data-rs-status>no pending changes</div>
            <div style="display: flex; gap: 6px;">
              <button type="button" class="rs-action rs-cancel" data-rs-cancel>[ Cancel ]</button>
              <button type="button" class="rs-action rs-done" data-rs-confirm>[ Confirm ]</button>
            </div>
          </footer>

        </div>
      </div>
    `;
  }

  let overlay, modal;
  let confirmTimers = new Map(); // slug → timeout id (for two-click confirm reset)

  /* ─── Renderers ─── */

  /** Refresh the agent-name cache (used by history labels / shortHandle). */
  function refreshAgentCache() {
    for (const d of getAvailableAgents()) NAMES[d.slug] = d.name;
  }

  /** Compact "Directors" trigger button · stacks the first ~5 active
   *  avatars with a +N overflow chip and the count. Mirrors the new-
   *  room composer's `.cmp-cast-btn`. Click opens the picker popover. */
  function renderMembers() {
    refreshAgentCache();
    const active = ROOM_STATE.members;
    const all = getAvailableAgents();
    const activeAgents = active.map((slug) => all.find((a) => a.slug === slug)).filter(Boolean);

    const stack = modal.querySelector("[data-rs-cast-stack]");
    const countEl = modal.querySelector("[data-rs-cast-count]");
    if (!stack || !countEl) return;

    const SHOW = 5;
    const shown = activeAgents.slice(0, SHOW);
    const overflow = Math.max(0, activeAgents.length - SHOW);
    stack.innerHTML = shown.map((a) =>
      `<img class="rs-cast-av" src="${escape(a.avatar)}" alt="${escape(a.name)}" title="${escape(a.name)}">`
    ).join("") + (overflow > 0 ? `<span class="rs-cast-more">+${overflow}</span>` : "");
    countEl.textContent = `${activeAgents.length} ${activeAgents.length === 1 ? "director" : "directors"}`;

    // Picker popover · re-render rows when membership changes so the
    // open popover (if any) reflects the staged state immediately.
    renderCastPickerRows();
  }

  function renderCastPickerRows() {
    const pop = document.getElementById("rs-cast-pop");
    if (!pop) return;
    const list = pop.querySelector("[data-rs-cast-list]");
    if (!list) return;
    const active = ROOM_STATE.members;
    const all = getAvailableAgents();
    if (all.length === 0) {
      list.innerHTML = `<div class="rs-cast-empty">No directors yet — create one in the Agents tab.</div>`;
      return;
    }
    const activeRows = all.filter((d) => active.includes(d.slug));
    const inactiveRows = all.filter((d) => !active.includes(d.slug));
    list.innerHTML =
      activeRows.map((d) => memberRowHTML(d, true)).join("") +
      inactiveRows.map((d) => memberRowHTML(d, false)).join("");
  }

  /** Open the directors picker popover anchored under the trigger
   *  button. Mirrors the new-room composer's `.composer-pick-pop`
   *  pattern. Idempotent — calling toggle while open closes it. */
  function toggleCastPicker(triggerBtn) {
    const existing = document.getElementById("rs-cast-pop");
    if (existing) {
      closeCastPicker();
      return;
    }
    const pop = document.createElement("div");
    pop.id = "rs-cast-pop";
    pop.className = "rs-cast-pop";
    pop.innerHTML = `
      <div class="rs-cast-head">
        <span class="rs-cast-title">// directors at this table</span>
        <span class="rs-cast-hint">click a row to toggle</span>
      </div>
      <div class="rs-cast-list" data-rs-cast-list></div>
    `;
    document.body.appendChild(pop);
    renderCastPickerRows();
    // Row click → toggle staged membership (or open agent profile when
    // the avatar / info button is the click target). The popover lives
    // outside .room-settings-modal so the modal-level click handler
    // doesn't catch these — wire them directly here.
    pop.addEventListener("click", (ev) => {
      const profileLink = ev.target.closest("[data-agent-link]");
      if (profileLink && (ev.target.closest(".rs-member-img") || ev.target.closest(".rs-member-info"))) {
        ev.preventDefault();
        ev.stopPropagation();
        const slug = profileLink.getAttribute("data-agent-link");
        if (typeof window.openAgentOverlay === "function" && slug) window.openAgentOverlay(slug);
        return;
      }
      const row = ev.target.closest("[data-rs-toggle]");
      if (!row) return;
      ev.preventDefault();
      ev.stopPropagation();
      const slug = row.getAttribute("data-slug");
      if (!slug) return;
      if (ROOM_STATE.members.includes(slug)) removeMember(slug);
      else                                    addMember(slug);
    });
    // Position under the trigger, right-aligned to it for breathing
    // room from the modal's left edge.
    const r = triggerBtn.getBoundingClientRect();
    const popW = 360;
    let left = r.right - popW;
    if (left < 12) left = Math.max(12, r.left);
    pop.style.left = left + "px";
    pop.style.top  = (r.bottom + 6) + "px";
    pop.style.width = popW + "px";
    triggerBtn.classList.add("on");

    // Outside-click + Esc to close. Stored on closures so closeCastPicker
    // can detach them. Click is exempt when:
    //   · inside the picker popover itself
    //   · on the trigger button (handled by its own toggle)
    //   · anywhere inside the agent intro overlay — opening + closing
    //     an agent profile from inside the picker should leave the
    //     picker open so the user can keep browsing directors
    castPickerOutside = (ev) => {
      if (
        !pop.contains(ev.target)
        && !ev.target.closest("[data-rs-cast-trigger]")
        && !ev.target.closest(".agent-overlay")
      ) {
        closeCastPicker();
      }
    };
    castPickerEsc = (ev) => {
      if (ev.key === "Escape") closeCastPicker();
    };
    setTimeout(() => {
      document.addEventListener("click", castPickerOutside, true);
      document.addEventListener("keydown", castPickerEsc, true);
    }, 0);
  }
  let castPickerOutside = null;
  let castPickerEsc = null;
  function closeCastPicker() {
    const pop = document.getElementById("rs-cast-pop");
    if (pop) pop.remove();
    document.querySelectorAll("[data-rs-cast-trigger].on").forEach((b) => b.classList.remove("on"));
    if (castPickerOutside) document.removeEventListener("click", castPickerOutside, true);
    if (castPickerEsc) document.removeEventListener("keydown", castPickerEsc, true);
    castPickerOutside = null;
    castPickerEsc = null;
  }

  function renderModes() {
    const grid = modal.querySelector(".rs-mode-row");
    const cur = effective("mode");
    // Each chip pairs a tight label + a small `i` icon · hovering the
    // icon opens a description popover (TONE_TIPS lookup). Sharp-edge,
    // no border-radius, no second line.
    grid.innerHTML = MODES.map((m) => {
      const tip = TONE_TIPS[m.v] || m.desc || "";
      return `<button type="button" class="rs-chip rs-chip-mini${m.v === cur ? " active" : ""}" data-mode="${m.v}">
        <span class="rs-chip-label">${escape(m.label)}</span>
        <span class="rs-chip-info rs-info-trigger" data-info-title="${escape(m.label)}" data-info-body="${escape(tip)}" tabindex="-1" aria-label="What '${escape(m.label)}' means">i</span>
      </button>`;
    }).join("");
  }

  function renderIncognito() {
    const checkbox = modal.querySelector("[data-rs-incognito-check]");
    if (!checkbox) return;
    const effective = STAGED.incognito !== null ? STAGED.incognito : ROOM_STATE.incognito;
    checkbox.checked = !!effective;
  }

  function renderIntensity() {
    // Intensity is now a 3-chip row (Calm / Sharp / Terse) instead of
    // a slider · highlight the active chip. The hint line above shows
    // "currently: <value>" so the picked state stays self-evident.
    const cur = effective("intensity");
    modal.querySelectorAll("[data-rs-intensity-pick]").forEach((el) => {
      el.classList.toggle("active", el.dataset.rsIntensityPick === cur);
    });
    const intensityHint = modal.querySelector('[data-rs-intensity-hint]');
    if (intensityHint) intensityHint.textContent = `currently: ${cur}`;
  }

  function renderConfirmState() {
    const status = modal.querySelector("[data-rs-status]");
    const btn = modal.querySelector("[data-rs-confirm]");
    if (!status || !btn) return;
    status.classList.remove("error");
    if (isDirty()) {
      const parts = [];
      if (STAGED.mode !== null)      parts.push("tone");
      if (STAGED.intensity !== null) parts.push("intensity");
      if (membersDirty())            parts.push("members");
      status.textContent = `pending: ${parts.join(", ")} — click Confirm to apply`;
      status.classList.add("pending");
      btn.classList.add("dirty");
      btn.disabled = false;
    } else {
      status.textContent = "no pending changes";
      status.classList.remove("pending");
      btn.classList.remove("dirty");
      btn.disabled = false;
    }
  }

  function renderHistory() {
    // History pane removed from the overlay UI · keep the function as
    // a no-op so callers (init / logEvent) don't need to coordinate.
    // ROOM_STATE.history is still populated for backend correlation.
    const list = modal.querySelector(".rs-history-list");
    if (!list) return;
    const recent = ROOM_STATE.history.slice().reverse();
    list.innerHTML = recent.map(historyRowHTML).join("");
  }

  /* ─── Open/close ─── */

  /** Pull baseline state from the live app (or fall back to demo state). */
  function syncBaseline() {
    const app = window.app;
    const room = app?.currentRoom;
    if (!room) return;
    ROOM_STATE.title    = room.subject || ROOM_STATE.title;
    ROOM_STATE.topic    = room.subject || ROOM_STATE.topic;
    ROOM_STATE.number   = typeof room.number === "number" ? room.number : ROOM_STATE.number;
    ROOM_STATE.status   = room.status || ROOM_STATE.status;
    ROOM_STATE.mode     = room.mode || "constructive";
    ROOM_STATE.intensity = room.intensity || "sharp";
    ROOM_STATE.incognito = room.incognito === true;
    if (Array.isArray(app.currentMembers) && app.currentMembers.length) {
      ROOM_STATE.members = app.currentMembers.map((a) => a.id);
    }
    // Snapshot baseline AFTER syncing so dirty-detection compares against
    // the server's authoritative member set, not the previous open's.
    MEMBERS_BASELINE = ROOM_STATE.members.slice();
    // Refresh title surfaces inside the modal that snapshot strings.
    const num = modal.querySelector(".rs-number");
    if (num) num.textContent = ROOM_STATE.number;
    const ttl = modal.querySelector(".rs-title");
    if (ttl) ttl.textContent = ROOM_STATE.title;
  }

  function open() {
    if (!overlay) return;
    resetStaged();
    syncBaseline();
    // Re-render the members list every open · window.app.agents may have
    // grown (a new custom agent was just created in the Agents tab) since
    // the modal was last mounted, and the inactive-member catalog needs
    // to reflect that without requiring a page reload.
    renderMembers();
    renderModes();
    renderIntensity();
    renderIncognito();
    renderConfirmState();
    closeCastPicker();
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    // Title clamp · run AFTER the overlay becomes visible so the
    // title element has real dimensions to measure. Resets to clamped
    // every open (a previously-expanded title shouldn't stick across
    // close + reopen). Double-rAF gives layout + line-clamp a beat to
    // settle on cold opens (Safari can return stale scrollHeight on a
    // single rAF after a display switch).
    applyTitleClamp();
  }

  function applyTitleClamp() {
    const titleEl = modal.querySelector("[data-rs-title]");
    const titleBtn = modal.querySelector("[data-rs-title-toggle]");
    if (!titleEl || !titleBtn) return;
    titleEl.classList.add("is-clamped");
    titleBtn.textContent = "Show more";
    titleBtn.hidden = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (titleEl.scrollHeight > titleEl.clientHeight + 1) {
          titleBtn.hidden = false;
        }
      });
    });
  }
  function close() {
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    // Reset any pending confirms (member removal two-step)
    confirmTimers.forEach((id) => clearTimeout(id));
    confirmTimers.clear();
    closeCastPicker();
    // Drop any unconfirmed config changes — they were never persisted.
    resetStaged();
    // Roll back optimistic member edits to the baseline taken on open.
    ROOM_STATE.members = MEMBERS_BASELINE.slice();
  }

  /* ─── Mutations + history logging ─── */

  function logEvent(evt) {
    // History pane removed from the overlay UI · keep the in-memory
    // log for backend-event correlation but no DOM render. The chair
    // settings-change announcement still surfaces inline in chat.
    const stamped = Object.assign({ ts: nowStamp(), who: "you" }, evt);
    ROOM_STATE.history.push(stamped);
  }

  function addMember(slug) {
    if (ROOM_STATE.members.includes(slug)) return;
    ROOM_STATE.members.push(slug);
    renderMembers();
    logEvent({
      kind: "member-add",
      payload: slug,
      label: `added @${shortHandle(slug)}`
    });
  }

  function removeMember(slug) {
    const idx = ROOM_STATE.members.indexOf(slug);
    if (idx < 0) return;
    if (ROOM_STATE.members.length <= 1) return; // floor at 1
    ROOM_STATE.members.splice(idx, 1);
    renderMembers();
    logEvent({
      kind: "member-remove",
      payload: slug,
      label: `removed @${shortHandle(slug)}`
    });
  }

  function shortHandle(slug) {
    const map = {
      "socrates": "socrates",
      "first-principles": "first_p",
      "value-investor": "value_inv",
      "user-empathy": "user_emp",
      "long-horizon": "long_h",
      "phenomenologist": "phen"
    };
    return map[slug] || slug;
  }

  // Staging — chip clicks only set STAGED.* and re-render the chip rows.
  // The change is committed when the user clicks Confirm (see commit()).
  function stageMode(next) {
    STAGED.mode = next === ROOM_STATE.mode ? null : next;
    renderModes();
    renderConfirmState();
  }
  function stageIntensity(next) {
    // Accept legacy `brutal` from any code path that still emits it
    // (cached HTML, third-party clients) and normalize to `terse`.
    if (next === "brutal") next = "terse";
    if (!["calm", "sharp", "terse"].includes(next)) return;
    STAGED.intensity = next === ROOM_STATE.intensity ? null : next;
    renderIntensity();
    renderConfirmState();
  }
  function stageIncognito(next) {
    STAGED.incognito = !!next === ROOM_STATE.incognito ? null : !!next;
    renderIncognito();
    renderConfirmState();
  }

  /** Push staged config + member changes to the backend. */
  async function commit() {
    if (!isDirty()) { close(); return; }

    // Build the settings patch (mode / intensity / incognito).
    const patch = {};
    if (STAGED.mode !== null)      patch.mode = STAGED.mode;
    if (STAGED.intensity !== null) patch.intensity = STAGED.intensity;
    if (STAGED.incognito !== null) patch.incognito = STAGED.incognito;

    const btn = modal.querySelector("[data-rs-confirm]");
    const status = modal.querySelector("[data-rs-status]");
    if (btn) { btn.disabled = true; btn.textContent = "[ Applying… ]"; }

    try {
      if (Object.keys(patch).length > 0 && window.app && typeof window.app.updateRoomSettings === "function") {
        await window.app.updateRoomSettings(patch);
      }
      // Members PATCH · only fire when the membership actually changed.
      // Server diffs against current and runs the chair announcement +
      // queue injection. We don't await SSE — the chair message and
      // speaker turns flow in via the existing room stream.
      if (membersDirty() && window.app?.currentRoomId) {
        const r = await fetch(
          "/api/rooms/" + encodeURIComponent(window.app.currentRoomId) + "/members",
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agentIds: ROOM_STATE.members }),
          },
        );
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || ("members update failed: HTTP " + r.status));
        }
        const j = await r.json();
        // Refresh the app's authoritative member list so sidebars / chips
        // re-render against the new roster on the next paint.
        if (Array.isArray(j.members) && window.app) {
          // Resolve each member id to the full agent record we already have.
          const byId = {};
          for (const a of (window.app.agents || [])) byId[a.id] = a;
          window.app.currentMembers = j.members
            .map((m) => byId[m.agentId])
            .filter(Boolean);
        }
        MEMBERS_BASELINE = ROOM_STATE.members.slice();
      }
      // Snapshot the previous values BEFORE we overwrite, so the chat
      // markers can show "before → after" honestly.
      const before = {
        mode: ROOM_STATE.mode,
        intensity: ROOM_STATE.intensity,
        incognito: ROOM_STATE.incognito,
      };
      const after = {
        mode: patch.mode ?? ROOM_STATE.mode,
        intensity: patch.intensity ?? ROOM_STATE.intensity,
        incognito: typeof patch.incognito === "boolean" ? patch.incognito : ROOM_STATE.incognito,
      };
      Object.assign(ROOM_STATE, after);
      if (STAGED.mode !== null) {
        logEvent({ kind: "mode", before: before.mode, after: after.mode,
          label: `tone: ${before.mode} → ${after.mode}` });
      }
      if (STAGED.intensity !== null) {
        logEvent({ kind: "intensity", before: before.intensity, after: after.intensity,
          label: `intensity: ${before.intensity} → ${after.intensity}` });
      }
      if (STAGED.incognito !== null) {
        logEvent({ kind: "incognito", before: before.incognito, after: after.incognito,
          label: `memory: ${before.incognito ? "incognito" : "default"} → ${after.incognito ? "incognito" : "default"}` });
      }
      resetStaged();
      if (btn) { btn.disabled = false; btn.textContent = "[ Confirm ]"; }
      close();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "[ Confirm ]"; }
      if (status) {
        status.textContent = `failed: ${e && e.message ? e.message : e}`;
        status.classList.add("error");
      }
    }
  }

  /* ─── Chat marker injection ─── */

  function injectChatMarker(evt) {
    const chat = document.querySelector(".chat");
    if (!chat) return;

    const wrap = document.createElement("div");
    wrap.className = "config-marker";
    wrap.dataset.kind = evt.kind;

    let symbol = "·";
    if (evt.kind === "member-add")    symbol = "+";
    if (evt.kind === "member-remove") symbol = "−";
    if (evt.kind === "mode" || evt.kind === "style" || evt.kind === "intensity") symbol = "↔";

    wrap.innerHTML = `
      <span class="cm-line"></span>
      <span class="cm-body">
        <span class="cm-time">${escape(clockOnly())}</span>
        <span class="cm-icon">${symbol}</span>
        <span class="cm-label">${escape(evt.label)}</span>
        <span class="cm-who">${escape(evt.who || "you")}</span>
      </span>
      <span class="cm-line"></span>
    `;

    // Insert at the end of the chat (latest activity)
    chat.appendChild(wrap);
    // Auto-scroll if user is near bottom
    if (chat.scrollHeight - chat.scrollTop - chat.clientHeight < 200) {
      chat.scrollTop = chat.scrollHeight;
    }
  }

  /* ─── Click handler with two-step confirm ─── */

  function handleRemoveClick(button) {
    const slug = button.dataset.slug;
    const state = button.dataset.state || "idle";

    if (state === "idle") {
      // First click: arm the confirm state
      button.dataset.state = "confirm";
      const t = setTimeout(() => {
        if (button.dataset.state === "confirm") button.dataset.state = "idle";
        confirmTimers.delete(slug);
      }, 4000);
      // Cancel any prior timer for this slug
      if (confirmTimers.has(slug)) clearTimeout(confirmTimers.get(slug));
      confirmTimers.set(slug, t);
      return;
    }

    if (state === "confirm") {
      // Second click within window: actually remove
      if (confirmTimers.has(slug)) {
        clearTimeout(confirmTimers.get(slug));
        confirmTimers.delete(slug);
      }
      removeMember(slug);
    }
  }

  /* ─── Init ─── */

  function init() {
    if (document.getElementById("room-settings-overlay")) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = modalHTML().trim();
    document.body.appendChild(wrap.firstChild);

    overlay = document.getElementById("room-settings-overlay");
    modal = overlay.querySelector(".room-settings-modal");

    renderMembers();
    renderModes();
    renderIntensity();
    renderIncognito();
    renderHistory();
    renderConfirmState();

    // Close (X) — discards staged changes via close().
    overlay.querySelector(".close-btn").addEventListener("click", close);

    // Title clamp · click handler attaches once at init and persists
    // across opens (the toggle button DOM node is reused). The actual
    // overflow measurement happens inside open() via applyTitleClamp,
    // because at init time the overlay is `display: none` so the
    // title element has 0×0 dimensions and scrollHeight is meaningless.
    const titleBtn = modal.querySelector("[data-rs-title-toggle]");
    if (titleBtn) {
      titleBtn.addEventListener("click", (e) => {
        e.preventDefault();
        const titleEl = modal.querySelector("[data-rs-title]");
        if (!titleEl) return;
        const expanded = titleEl.classList.toggle("is-clamped") === false;
        titleBtn.textContent = expanded ? "Show less" : "Show more";
      });
    }
    // Confirm — push staged changes to the backend then close.
    modal.querySelector("[data-rs-confirm]").addEventListener("click", (e) => {
      e.preventDefault();
      void commit();
    });
    // Cancel — discards staged changes (close() resets) and closes the modal.
    const cancelBtn = modal.querySelector("[data-rs-cancel]");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", (e) => { e.preventDefault(); close(); });
    }
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.classList.contains("open")) {
        e.stopImmediatePropagation();
        close();
      }
    });

    // Triggers anywhere
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-room-settings-trigger]")) {
        e.preventDefault();
        open();
      }
    });

    // Hover the info icon → open the description popover · close on
    // mouseleave with a small grace window (handled inside
    // openInfoPopover / scheduleClosePopover).
    modal.addEventListener("mouseover", (e) => {
      const info = e.target.closest(".rs-info-trigger");
      if (info) openInfoPopover(info);
    });
    modal.addEventListener("mouseout", (e) => {
      if (e.target.closest(".rs-info-trigger")) scheduleClosePopover();
    });

    // Capture-phase modal interactions
    modal.addEventListener("click", (e) => {
      // ─── Directors trigger · open / toggle the picker popover ──
      const castTrigger = e.target.closest("[data-rs-cast-trigger]");
      if (castTrigger) {
        e.preventDefault();
        e.stopPropagation();
        toggleCastPicker(castTrigger);
        return;
      }
      // Avatar / info button → open the agent's profile overlay.
      const profileLink = e.target.closest("[data-agent-link]");
      if (profileLink && (e.target.closest(".rs-member-av") || e.target.closest(".rs-member-img") || e.target.closest(".rs-member-info"))) {
        e.preventDefault();
        e.stopPropagation();
        const slug = profileLink.getAttribute("data-agent-link");
        if (typeof window.openAgentOverlay === "function" && slug) {
          window.openAgentOverlay(slug);
        }
        return;
      }
      // Row click anywhere else → toggle staged membership. The footer's
      // [Confirm] / [Cancel] commits / discards the change.
      const memberRow = e.target.closest("[data-rs-toggle]");
      if (memberRow) {
        e.preventDefault();
        e.stopPropagation();
        const slug = memberRow.getAttribute("data-slug");
        if (!slug) return;
        if (ROOM_STATE.members.includes(slug)) {
          removeMember(slug);
        } else {
          addMember(slug);
        }
        return;
      }
      // The `i` glyph on a chip is hover-driven (see mouseover wiring
      // below) — clicking it should swallow the event so it doesn't
      // also stage the chip's tone/intensity.
      if (e.target.closest(".rs-info-trigger")) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Mode chip — stage only, commit on Confirm. Picks up clicks on
      // the .rs-chip-label too via .closest.
      const mc = e.target.closest("[data-mode]");
      if (mc) {
        e.preventDefault();
        e.stopPropagation();
        stageMode(mc.dataset.mode);
        return;
      }
      // Intensity slider · click handled by pointer events (below) so drag
      // can begin on the same gesture. Capture-phase clicks are no-ops.
      if (e.target.closest(".rs-temp-bar")) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const ip = e.target.closest("[data-rs-intensity-pick]");
      if (ip) {
        e.preventDefault();
        e.stopPropagation();
        stageIntensity(ip.dataset.rsIntensityPick);
        return;
      }
      // Incognito · checkbox toggles the room's per-room memory
      // opt-out. Native click on the input fires this — capture-phase
      // is fine because we don't preventDefault (let the checkbox
      // visually flip), we just stage the new value.
      const incBox = e.target.closest("[data-rs-incognito-check]");
      if (incBox) {
        // Don't stop propagation · the native checkbox click event
        // continues, then we read its checked state on next tick.
        setTimeout(() => stageIncognito(incBox.checked), 0);
        return;
      }
    }, true);

    // Pointer-driven drag for the intensity slider (mouse + touch + stylus).
    const bar = modal.querySelector(".rs-temp-bar");
    if (bar) {
      const valueAt = (clientX) => {
        const rect = bar.getBoundingClientRect();
        if (rect.width <= 0) return "sharp";
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return ratio < 0.33 ? "calm" : ratio < 0.67 ? "sharp" : "terse";
      };
      bar.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        bar.setPointerCapture(e.pointerId);
        bar.dataset.dragging = "1";
        stageIntensity(valueAt(e.clientX));
      });
      bar.addEventListener("pointermove", (e) => {
        if (bar.dataset.dragging !== "1") return;
        stageIntensity(valueAt(e.clientX));
      });
      const end = (e) => {
        if (bar.dataset.dragging !== "1") return;
        bar.dataset.dragging = "0";
        try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
      };
      bar.addEventListener("pointerup", end);
      bar.addEventListener("pointercancel", end);
    }
  }

  // Public API
  window.openRoomSettings  = function () { if (!overlay) init(); open(); };
  window.closeRoomSettings = close;
  // Expose mutations so the picker can hand off (it imports addMember).
  window.RoomSettings = {
    addMember: addMember,
    removeMember: removeMember,
    getMembers: () => ROOM_STATE.members.slice(),
    getState: () => ROOM_STATE
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
