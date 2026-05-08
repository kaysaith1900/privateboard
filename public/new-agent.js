/* ═══════════════════════════════════════════
   NEW AGENT OVERLAY
   ═══════════════════════════════════════════
   Public API: window.openNewAgent()
   Triggered by clicks on [data-new-agent] (the sidebar's
   `New agent` button in the Agents tab).
*/
(function () {
  const MODEL_GROUPS = [
    { provider: "anthropic", models: [
      { v: "sonnet-4-6",    name: "Sonnet 4.6",    deck: "balanced · default" },
      { v: "opus-4-7",      name: "Opus 4.7",      deck: "deep reasoning" },
      { v: "opus-4-6",      name: "Opus 4.6",      deck: "prior-gen flagship" },
      { v: "opus-4-6-fast", name: "Opus 4.6 Fast", deck: "faster 4.6 · same intelligence" },
      { v: "haiku-4-5",     name: "Haiku 4.5",     deck: "fast · low-cost" }
    ]},
    { provider: "openai", models: [
      { v: "gpt-5-5",      name: "GPT-5.5",      deck: "flagship · 1M ctx" },
      { v: "gpt-5-4",      name: "GPT-5.4",      deck: "general · 1M ctx" },
      { v: "gpt-5-4-mini", name: "GPT-5.4 Mini", deck: "fast · 400k ctx" }
    ]},
    { provider: "google", models: [
      { v: "gemini-3-1",       name: "Gemini 3.1 Pro",        deck: "flagship · 1M ctx" },
      { v: "gemini-3-flash",   name: "Gemini 3 Flash",        deck: "frontier flash · 1M ctx" },
      { v: "gemini-3-1-flash", name: "Gemini 3.1 Flash Lite", deck: "fast · 1M ctx" }
    ]},
    { provider: "xai", models: [
      { v: "grok-4-3",      name: "Grok 4.3",      deck: "flagship · 1M ctx" },
      { v: "grok-4-1-fast", name: "Grok 4.1 Fast", deck: "fast · 256k ctx" }
    ]}
  ];
  const ALL_MODELS = MODEL_GROUPS.flatMap((g) => g.models);

  /* ─── Skill catalog ─────────────────────────────────
     Installable abilities — slot-grid analog of an RPG
     equipment ring. v1 is visual only (the LLM adapter
     doesn't yet wire tool-use), but the UI shows the
     vocabulary so users can shape the director's
     intended capability surface. */
  const SKILL_CATALOG = [
    { v: "search",  icon: "⌕",  name: "Web Search",  deck: "real-time fetch" },
    { v: "pdf",     icon: "▤",  name: "PDF Parse",   deck: "extract from PDFs" },
    { v: "shell",   icon: "⌨",  name: "Shell",       deck: "execute commands" },
    { v: "browser", icon: "◍",  name: "Browser",     deck: "navigate the web" },
    { v: "code",    icon: "▶",  name: "Code Exec",   deck: "run python / node" },
    { v: "tables",  icon: "▦",  name: "Tables",      deck: "csv · xlsx" },
    { v: "memory",  icon: "✎",  name: "Memory",      deck: "long-term notes" },
    { v: "urls",    icon: "↗",  name: "URL Fetch",   deck: "grab pages" },
  ];
  const SKILL_SLOTS = 8;

  function escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  /* ───── 8-bit avatar generator ─────
     Pure function: same seed → same avatar.
     placeholder=true returns a neutral grey silhouette.
  */
  const PALETTES = {
    hair:  ["#7B4F2A","#3A2418","#D4A347","#5A3D8F","#B53D3D","#1F1F1F","#8B7355","#A05A2C","#2D5532","#C46A2C"],
    skin:  ["#F4C99B","#E8B589","#D9A077","#C68863","#A86B47","#8B5A3C"],
    shirt: ["#6FB572","#6A9B97","#B5706A","#B59E6A","#9B7BB5","#5470A8","#7B5A8A","#C46A2C"],
    eye:   ["#1A1A1A","#3D2817","#1F3A5E","#2D2618"]
  };
  const FACE_MASK = [
    "........XXXXXXXX........",
    "......XXXXXXXXXXXX......",
    ".....XXXXXXXXXXXXXX.....",
    "....XXXXXXXXXXXXXXXX....",
    "....XXXXXXXXXXXXXXXX....",
    "...XXXXXXXXXXXXXXXXXX...",
    "...XXXXXXXXXXXXXXXXXX...",
    "...XXXXXXXXXXXXXXXXXX...",
    "...XXXXXXXXXXXXXXXXXX...",
    "...XXXXXXXXXXXXXXXXXX...",
    "...XXXXXXXXXXXXXXXXXX...",
    "...XXXXXXXXXXXXXXXXXX...",
    "...XXXXXXXXXXXXXXXXXX...",
    "...XXXXXXXXXXXXXXXXXX...",
    "...XXXXXXXXXXXXXXXXXX...",
    "....XXXXXXXXXXXXXXXX....",
    "....XXXXXXXXXXXXXXXX....",
    ".....XXXXXXXXXXXXXX.....",
    "......XXXXXXXXXXXX......"
  ];
  function makeRng(seed) {
    let h = 2166136261 >>> 0;
    const s = String(seed || "agent");
    for (let i = 0; i < s.length; i++) {
      h = (h ^ s.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    }
    let st = h || 1;
    return () => {
      st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
      return st / 4294967296;
    };
  }
  function pickFrom(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function shortHash(seed) {
    const rng = makeRng(seed);
    return [0,0,0,0].map(() => Math.floor(rng() * 16).toString(16)).join("");
  }
  // Avatar generation delegates to the shared AvatarSkill
  // (see public/avatar-skill.js). One source of truth for the
  // 8-bit pixel-art look used here, in user settings, and anywhere
  // else that wants a director-style avatar.
  function generateAvatar(seed, opts) {
    return window.AvatarSkill.generate(seed, opts);
  }

  function modalHTML() {
    // Slimmed form (per user brief): only name, bio, avatar, and
    // instruction. Rules/skills/model/knowledge live in the agent
    // profile after creation. Chrome aligns with the global overlay
    // pattern (mirrors .convene-modal): backdrop blur, corner
    // brackets, classification + head + body + foot.
    return `
      <div class="new-agent-overlay" id="new-agent-overlay" role="dialog" aria-modal="true" aria-hidden="true">
        <div class="new-agent-modal" role="document">
          <div class="na-classification">
            <span><span class="dot">●</span> directors · new</span>
            <span class="right">// shape the role</span>
          </div>

          <header class="na-head">
            <div>
              <div class="na-step-num">// new <span class="hl">director</span> · manual setup</div>
              <div class="na-step-title">shape the role</div>
            </div>
            <button type="button" class="na-close" aria-label="Close">✕</button>
          </header>

          <div class="na-body">
            <div class="na-stack">

              <div class="na-avatar-block">
                <div class="na-portrait">
                  <div data-na-avatar class="na-avatar-frame"></div>
                </div>
                <button type="button" class="na-avatar-regen" data-na-regen>
                  <span class="na-avatar-regen-mark">◆</span>
                  <span class="na-avatar-regen-label">generate 8-bit avatar</span>
                </button>
                <div class="na-avatar-vibe" data-na-vibe></div>
              </div>

              <div class="na-fields">

                <div class="na-field">
                  <label class="na-field-label">
                    <span>Name</span>
                    <span class="na-field-meta"><span class="na-name-count">0</span>/32</span>
                  </label>
                  <div class="na-input-wrap na-name-wrap">
                    <input type="text" class="na-name-input" placeholder="Aurelia · The Long-Cycle Strategist" maxlength="32">
                  </div>
                  <div class="na-field-hint">handle: <span class="na-handle-preview">/new_agent</span></div>
                </div>

                <div class="na-field">
                  <label class="na-field-label">
                    <span>Intro</span>
                    <span class="na-field-meta"><span class="na-desc-count">0</span>/280</span>
                  </label>
                  <div class="na-textarea-wrap intro">
                    <textarea class="na-desc-input" placeholder="One or two sentences · how this director shows up in a room. Reads everything on a hundred-year scale. Knows which patterns repeat and which never do." maxlength="280"></textarea>
                  </div>
                  <div class="na-field-hint">becomes their public bio</div>
                </div>

                <div class="na-field">
                  <label class="na-field-label">
                    <span>Instruction</span>
                    <span class="na-field-meta"><span class="na-instr-count">0</span> chars · markdown</span>
                  </label>
                  <div class="na-textarea-wrap tall">
                    <textarea class="na-instr-input" spellcheck="false" placeholder="### Role
You are __, the room's __. Your job is to ___.

### Voice
Demand ___. Don't ___. Cite ___ when ___.

### Boundaries
When the room ___, raise an objection."></textarea>
                  </div>
                  <div class="na-field-hint">applies to every room they join · skills, rules and model are configured later in the profile</div>
                </div>

              </div>
            </div>
          </div>

          <footer class="na-foot">
            <div class="na-foot-meta">configure skills · rules · model after creation</div>
            <div class="na-foot-actions">
              <button type="button" class="na-cancel">cancel</button>
              <button type="button" class="na-create" disabled>
                <span class="na-create-mark">◆</span>
                <span>create director</span>
              </button>
            </div>
          </footer>

        </div>
      </div>
    `;
  }

  let overlay, modal;
  // Synthetic knowledge state (visual only — no real upload).
  let knowState = [];
  // Rules state — array of strings, max 5. Visual-only in v1; not yet
  // submitted to the backend.
  let rulesState = [];
  const RULES_MAX = 5;
  // Skills state — array of skill ids (e.g. "search","pdf"). Visual
  // only in v1.
  let skillsState = [];
  // Avatar state: placeholder until user clicks regenerate.
  let avatarState = { placeholder: true, seed: null, roll: 0 };

  /* ─── Rules ───────────────────────────── */
  function renderRules() {
    const list = modal && modal.querySelector("[data-na-rules]");
    const addBtn = modal && modal.querySelector("[data-na-rule-add]");
    if (!list) return;
    if (rulesState.length === 0) {
      list.innerHTML = `<li class="na-rule-empty">no rules yet · directors will follow only their instruction</li>`;
    } else {
      list.innerHTML = rulesState.map((body, i) => `
        <li class="na-rule" data-rule-idx="${i}">
          <span class="na-rule-num">${i + 1}</span>
          <input type="text" class="na-rule-input" placeholder="never preface · cite the load-bearing claim with **bold** · ..." maxlength="120" value="${escape(body)}">
          <button type="button" class="na-rule-rm" data-na-rule-rm="${i}" title="Remove">✕</button>
        </li>
      `).join("");
    }
    if (addBtn) {
      const atCap = rulesState.length >= RULES_MAX;
      addBtn.disabled = atCap;
      addBtn.classList.toggle("at-cap", atCap);
    }
  }
  function addRule() {
    if (rulesState.length >= RULES_MAX) return;
    rulesState.push("");
    renderRules();
    // Focus the freshly-added input.
    const inputs = modal.querySelectorAll(".na-rule-input");
    const last = inputs[inputs.length - 1];
    if (last) last.focus();
  }
  function removeRule(idx) {
    if (idx < 0 || idx >= rulesState.length) return;
    rulesState.splice(idx, 1);
    renderRules();
  }
  function setRule(idx, body) {
    if (idx < 0 || idx >= rulesState.length) return;
    rulesState[idx] = body;
  }

  /* ─── Skills ──────────────────────────── */
  function renderSkills() {
    const grid = modal && modal.querySelector("[data-na-skill-grid]");
    const countEl = modal && modal.querySelector(".na-skill-count");
    if (!grid) return;
    const slots = [];
    for (let i = 0; i < SKILL_SLOTS; i++) {
      const v = skillsState[i];
      const s = v ? SKILL_CATALOG.find((x) => x.v === v) : null;
      if (s) {
        slots.push(`
          <button type="button" class="na-skill-slot filled" data-na-skill-slot="${i}" title="${escape(s.name)} · click to remove">
            <span class="na-skill-icon">${escape(s.icon)}</span>
            <span class="na-skill-name">${escape(s.name)}</span>
          </button>
        `);
      } else {
        slots.push(`
          <button type="button" class="na-skill-slot empty" data-na-skill-slot="${i}" title="Install ability">
            <span class="na-skill-icon">+</span>
            <span class="na-skill-name">empty</span>
          </button>
        `);
      }
    }
    grid.innerHTML = slots.join("");
    if (countEl) countEl.textContent = String(skillsState.length);
  }

  /** Open a tiny inline picker beneath the slot — shows abilities the
   *  director doesn't already have. Click one to install it into the
   *  given slot (or the next empty if slot is null). */
  function openSkillPicker(anchor, targetSlot) {
    closeSkillPicker();
    const installed = new Set(skillsState);
    const available = SKILL_CATALOG.filter((s) => !installed.has(s.v));
    if (available.length === 0) return;

    const pop = document.createElement("div");
    pop.className = "na-skill-picker";
    pop.id = "na-skill-picker";
    pop.innerHTML = available.map((s) => `
      <button type="button" class="na-skill-pick" data-skill-pick="${escape(s.v)}">
        <span class="na-skill-pick-icon">${escape(s.icon)}</span>
        <span class="na-skill-pick-body">
          <span class="na-skill-pick-name">${escape(s.name)}</span>
          <span class="na-skill-pick-deck">${escape(s.deck)}</span>
        </span>
      </button>
    `).join("");
    document.body.appendChild(pop);

    // Position below the anchor button.
    const r = anchor.getBoundingClientRect();
    const margin = 6;
    pop.style.left = Math.max(margin, Math.min(r.left, window.innerWidth - 260 - margin)) + "px";
    pop.style.top = (r.bottom + 4) + "px";

    // Stash target slot index for the install handler.
    pop.dataset.targetSlot = String(targetSlot ?? "");

    // Dismiss on outside click.
    setTimeout(() => {
      const off = (e) => {
        if (e.target.closest("#na-skill-picker")) return;
        closeSkillPicker();
        document.removeEventListener("click", off, true);
      };
      document.addEventListener("click", off, true);
    }, 0);
  }
  function closeSkillPicker() {
    const pop = document.getElementById("na-skill-picker");
    if (pop) pop.remove();
  }
  function installSkill(slotIdx, skillV) {
    if (!SKILL_CATALOG.some((s) => s.v === skillV)) return;
    if (skillsState.includes(skillV)) return;
    // If slotIdx is provided and that slot is empty, place there.
    // Otherwise append to first available position.
    if (slotIdx !== null && slotIdx >= 0 && slotIdx < SKILL_SLOTS && !skillsState[slotIdx]) {
      skillsState[slotIdx] = skillV;
    } else {
      for (let i = 0; i < SKILL_SLOTS; i++) {
        if (!skillsState[i]) { skillsState[i] = skillV; break; }
      }
    }
    renderSkills();
  }
  function uninstallSkill(slotIdx) {
    if (slotIdx < 0 || slotIdx >= SKILL_SLOTS) return;
    skillsState[slotIdx] = undefined;
    // Compact array so empty slots are at the end visually.
    skillsState = skillsState.filter(Boolean);
    renderSkills();
  }

  function getProviderStatus(provider) {
    const keys = (typeof window.boardroomKeys === "function" ? window.boardroomKeys() : {}) || {};
    if (keys[provider])    return { label: "direct",          cls: "direct" };
    if (keys.openrouter)   return { label: "via openrouter",  cls: "via" };
    return                       { label: "no key",            cls: "none" };
  }

  function refreshProviderStatus() {
    if (!modal) return;
    modal.querySelectorAll(".na-model-grp[data-provider]").forEach((grp) => {
      const provider = grp.dataset.provider;
      const s = getProviderStatus(provider);
      const badge = grp.querySelector(".na-model-grp-status");
      if (!badge) return;
      badge.textContent = "· " + s.label;
      badge.classList.remove("direct", "via", "none");
      badge.classList.add(s.cls);
    });
  }

  function open() {
    if (!overlay) return;
    // Reset form to a clean slate every time.
    modal.querySelector(".na-name-input").value = "";
    modal.querySelector(".na-desc-input").value = "";
    modal.querySelector(".na-instr-input").value = "";
    avatarState = { placeholder: true, seed: null, roll: 0 };
    paintAvatar();
    refreshAll();

    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    setTimeout(() => modal.querySelector(".na-name-input").focus(), 80);
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  function slugify(s) {
    return String(s)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 14) || "new_agent";
  }

  function activeModelInfo() {
    const c = modal.querySelector(".na-model-opt.active");
    const fallback = { name: "—", provider: "—", deck: "—" };
    if (!c) return fallback;
    const v = c.dataset.model;
    const m = ALL_MODELS.find((x) => x.v === v);
    if (!m) return fallback;
    let prov = "—";
    for (const g of MODEL_GROUPS) {
      if (g.models.some((x) => x.v === v)) { prov = g.provider; break; }
    }
    return { name: m.name, provider: prov, deck: m.deck };
  }

  function paintAvatar() {
    const frame = modal.querySelector("[data-na-avatar]");
    const seedEl = modal.querySelector("[data-na-seed]");
    const rollEl = modal.querySelector("[data-na-roll]");
    if (!frame) return;
    if (avatarState.placeholder) {
      frame.classList.add("placeholder");
      frame.innerHTML = generateAvatar("__placeholder__", { placeholder: true });
      if (seedEl) seedEl.textContent = "—";
      if (rollEl) rollEl.textContent = "";
    } else {
      frame.classList.remove("placeholder");
      const seedKey = avatarState.seed + "::" + avatarState.roll;
      frame.innerHTML = generateAvatar(seedKey);
      if (seedEl) seedEl.textContent = shortHash(avatarState.seed);
      if (rollEl) rollEl.textContent = " · #" + avatarState.roll;
    }
  }

  function positionDropdown() {
    if (!modal) return;
    const select = modal.querySelector("[data-na-model-select]");
    const trigger = modal.querySelector("[data-na-trigger]");
    const dropdown = modal.querySelector("[data-na-dropdown]");
    if (!select || !trigger || !dropdown) return;
    if (select.dataset.open !== "true") return;

    const rect = trigger.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const margin = 8;
    const gap = 4;
    const spaceBelow = vh - rect.bottom - margin;
    const spaceAbove = rect.top - margin;

    // Reset previous run
    dropdown.style.top = "";
    dropdown.style.bottom = "";
    dropdown.style.maxHeight = "";

    // Width matches the trigger; clamp to viewport horizontally
    const left = Math.max(margin, Math.min(rect.left, vw - rect.width - margin));
    dropdown.style.left = left + "px";
    dropdown.style.width = rect.width + "px";

    const minPreferred = 220;
    const flipUp = spaceBelow < minPreferred && spaceAbove > spaceBelow;

    if (flipUp) {
      dropdown.style.bottom = (vh - rect.top + gap) + "px";
      dropdown.style.maxHeight = Math.max(140, spaceAbove - gap) + "px";
      select.dataset.flip = "up";
    } else {
      dropdown.style.top = (rect.bottom + gap) + "px";
      dropdown.style.maxHeight = Math.max(140, spaceBelow - gap) + "px";
      select.dataset.flip = "down";
    }
  }

  /** Regenerate the avatar by asking the LLM for a "vibe seed" derived
   *  from the director's name + bio, then painting the SVG via the
   *  shared AvatarSkill. Falls back to a local random seed if the
   *  endpoint errors (no key, network, etc.) so the button always
   *  produces a fresh face. */
  async function regenerateAvatar() {
    const name = modal.querySelector(".na-name-input").value.trim();
    const desc = modal.querySelector(".na-desc-input").value.trim();
    const btn = modal.querySelector("[data-na-regen]");
    const labelEl = btn?.querySelector(".na-avatar-regen-label");
    const vibeEl = modal.querySelector("[data-na-vibe]");

    avatarState.placeholder = false;
    avatarState.roll = (avatarState.roll || 0) + 1;

    // Without a name, just produce a random seed locally — no point
    // burning an LLM call on an empty form.
    if (!name) {
      avatarState.seed = (window.AvatarSkill?.randomSeed?.() || ("anon|" + Date.now()));
      if (vibeEl) vibeEl.textContent = "";
      paintAvatar();
      return;
    }

    if (btn) btn.disabled = true;
    const originalLabel = labelEl?.textContent || "generate 8-bit avatar";
    if (labelEl) labelEl.textContent = "thinking…";

    try {
      const res = await fetch("/api/avatar/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, bio: desc }),
      });
      if (!res.ok) throw new Error("avatar gen failed");
      const j = await res.json();
      avatarState.seed = j.seed + "::" + avatarState.roll;
      if (vibeEl) vibeEl.textContent = j.vibe || "";
    } catch (_) {
      avatarState.seed = (name + "|" + desc + "|" + avatarState.roll);
      if (vibeEl) vibeEl.textContent = "";
    } finally {
      if (btn) btn.disabled = false;
      if (labelEl) labelEl.textContent = originalLabel;
      paintAvatar();
    }
  }

  function refreshAll() {
    const name = modal.querySelector(".na-name-input").value;
    const desc = modal.querySelector(".na-desc-input").value;
    const instr = modal.querySelector(".na-instr-input").value;

    const handle = "/" + slugify(name);
    modal.querySelector(".na-handle-preview").textContent = handle;
    modal.querySelector(".na-name-count").textContent = name.length;
    modal.querySelector(".na-desc-count").textContent = desc.length;
    modal.querySelector(".na-instr-count").textContent = instr.length;

    // Create button enabled when name + bio are present.
    const create = modal.querySelector(".na-create");
    const ready = name.trim().length >= 2 && desc.trim().length >= 8;
    create.disabled = !ready;
  }

  function init() {
    if (document.getElementById("new-agent-overlay")) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = modalHTML().trim();
    document.body.appendChild(wrap.firstChild);

    overlay = document.getElementById("new-agent-overlay");
    modal = overlay.querySelector(".new-agent-modal");

    // Close
    modal.querySelector(".na-close").addEventListener("click", close);
    modal.querySelector(".na-cancel").addEventListener("click", close);
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
      if (e.target.closest("[data-new-agent]")) {
        e.preventDefault();
        open();
      }
    });

    // Live updates
    modal.querySelector(".na-name-input").addEventListener("input", refreshAll);
    modal.querySelector(".na-desc-input").addEventListener("input", refreshAll);
    modal.querySelector(".na-instr-input").addEventListener("input", refreshAll);

    // Avatar regenerate
    modal.querySelector("[data-na-regen]").addEventListener("click", (e) => {
      e.preventDefault();
      regenerateAvatar();
    });

    // Initial paint of placeholder
    paintAvatar();

    // Create — POST to /api/agents and refresh the sidebar's agents list.
    modal.querySelector(".na-create").addEventListener("click", async () => {
      const create = modal.querySelector(".na-create");
      if (create.disabled) return;

      const name = modal.querySelector(".na-name-input").value.trim();
      const bio = modal.querySelector(".na-desc-input").value.trim();
      const instruction = modal.querySelector(".na-instr-input").value.trim();
      // Default model · resolved from the user's current key set via
      // the shared /api/models cache (`defaultModelV` field). Without
      // this, new agents were always born with `opus-4-7` even when
      // the user only had a direct OpenAI key — the agent would then
      // hit `NoKeyError` on every turn until the user manually
      // changed its model. The cache may not have loaded yet (very
      // first interaction); we fall back to `opus-4-7` only as a
      // last resort and leave the runtime resolver to fix it up.
      let modelV = "opus-4-7";
      const cache = (typeof window.boardroomModels === "function") ? window.boardroomModels() : null;
      if (cache && typeof cache.defaultModelV === "string" && cache.defaultModelV) {
        modelV = cache.defaultModelV;
      } else if (cache && Array.isArray(cache.reachable) && cache.reachable.length > 0) {
        modelV = cache.reachable[0].modelV;
      }

      // Avatar → data URL. If the user never clicked "regenerate", we
      // build one off the form values now so the agent has a real face.
      let avatarSeed = avatarState.seed;
      let avatarRoll = avatarState.roll || 1;
      if (avatarState.placeholder) {
        avatarSeed = (name + "|" + bio) || "anon";
        avatarRoll = 1;
      }
      const svg = generateAvatar(avatarSeed + "::" + avatarRoll);
      const avatarPath = "data:image/svg+xml;utf8," + encodeURIComponent(svg);

      // Lock the button while the request is in flight.
      const orig = create.textContent;
      create.disabled = true;
      create.textContent = "[ creating… ]";

      try {
        const res = await fetch("/api/agents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, bio, instruction, modelV, avatarPath }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || res.statusText);
        }
        const created = await res.json();
        // Refresh app.agents so the sidebar + agentsById register the
        // new director immediately. Falls back gracefully if app isn't
        // booted (shouldn't happen in normal flows).
        if (window.app && typeof window.app.refreshAgents === "function") {
          await window.app.refreshAgents();
        }
        // Hand the new agent's id to anyone watching for the event.
        try {
          window.dispatchEvent(new CustomEvent("boardroom:agent-created", { detail: created }));
        } catch (_) { /* */ }
        close();
      } catch (e) {
        alert("Couldn't create the director: " + (e && e.message ? e.message : e));
        create.disabled = false;
        create.textContent = orig;
      }
    });
  }

  // Public API
  window.openNewAgent  = function () { if (!overlay) init(); open(); };
  window.closeNewAgent = close;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
