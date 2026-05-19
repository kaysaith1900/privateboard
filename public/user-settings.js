/* ═══════════════════════════════════════════
   USER SETTINGS OVERLAY · 2-column layout
   ═══════════════════════════════════════════
   Left rail: User · API Key · Default Model · Usage · Other settings
   Right panel: section content for the selected rail item
   Triggered by any element with [data-user-settings-trigger].

   Persistence:
     appearance  → localStorage  (dark / light / system · resolved by
                    the FOUC bootstrap in index.html + home.html; this
                    overlay just writes the chosen value, the bootstrap
                    listens to the `storage` event and re-applies)
     user (name/intro/avatarSeed) → /api/prefs (SQLite-backed)
     api keys    → server-encrypted via keys-store.js

   The keys object is exposed on window.boardroomKeys() so other modules
   (new-agent.js) can show provider configuration status next to model rows.
*/
(function () {
  // Appearance preference owned by the FOUC bootstrap. We only read /
  // write it here; the data-theme attribute is the bootstrap's job.
  const APPEARANCE_KEY = "boardroom.appearance";
  const APPEARANCE_MODES = ["dark", "light", "system"];

  // /api/prefs is async; cache the latest value at module bootstrap so the
  // synchronous render code below stays simple. saveUser writes through.
  let _prefsCache = { name: "You", intro: "", avatarSeed: null, webSearchProvider: "brave", minimaxRegion: "cn" };

  // ── Voice + skill providers (LLM rows moved to the active-provider
  // card grid above the legacy renderKeyRow loop; see
  // activeLlmSectionHTML below). Voice / skill keys remain multi-key
  // by design — independent storage rows, no swap behaviour. ──
  const PROVIDERS = [
    { id: "minimax",    label: "MiniMax",     hint: "speech · T2A voices, cloning, streaming audio",   placeholder: "mm-…",         group: "voice" },
    { id: "elevenlabs", label: "ElevenLabs",  hint: "text-to-speech · pricing & docs at elevenlabs.io",  placeholder: "xi-…",         group: "voice" },
    { id: "brave",      label: "Brave Search", hint: "powers the Web Search system skill · ≈ $5 / 1000 queries · privacy-respecting",
      placeholder: "BSA…",         group: "skill" },
    { id: "tavily",     label: "Tavily Search", hint: "alternate Web Search backend · billed per Tavily credits · LLM-focused results",
      placeholder: "tvly-…",        group: "skill" },
  ];

  // Single source of truth for the LLM card grid — mirrors the
  // backend taxonomy at src/ai/providers.ts via the keys-store.js
  // export. Cards carry their own pitch copy + placeholder + help link.
  // xAI auto-hides when /api/models reports zero models for it.
  // MIRROR: src/ai/providers.ts — kept local to this IIFE so the
  // renderer can branch on multi-vs-single classification without
  // reaching into window.keysStore (which loads as a module and may
  // not be ready during the first paint).
  const MULTI_MODEL_LLM_PROVIDERS = ["openrouter", "bai"];
  // (SINGLE_MODEL_LLM_PROVIDERS derivable as anything in ALL_LLM_CARDS
  // that's not in the multi set; we use it implicitly via
  // LLM_CARDS_SINGLE.)

  const LLM_CARDS_MULTI = [
    {
      id: "openrouter",
      label: "OpenRouter",
      tagline: "universal aggregator · Claude · GPT · Gemini · Kimi · DeepSeek",
      placeholder: "sk-or-v1-…",
      helpUrl: "https://openrouter.ai/keys",
      helpLabel: "openrouter.ai/keys",
    },
    {
      id: "bai",
      label: "B.AI",
      tagline: "universal aggregator · same catalog · CN pricing channel",
      placeholder: "sk-…",
      helpUrl: "https://b.ai/",
      helpLabel: "b.ai",
    },
  ];
  const LLM_CARDS_SINGLE = [
    { id: "anthropic", label: "Claude",  tagline: "Anthropic direct",     placeholder: "sk-ant-…", helpUrl: "https://console.anthropic.com/settings/keys", helpLabel: "console.anthropic.com" },
    { id: "openai",    label: "ChatGPT", tagline: "OpenAI direct",        placeholder: "sk-…",     helpUrl: "https://platform.openai.com/api-keys",        helpLabel: "platform.openai.com" },
    { id: "google",    label: "Gemini",  tagline: "Google AI Studio",     placeholder: "AIza…",    helpUrl: "https://aistudio.google.com/apikey",          helpLabel: "aistudio.google.com" },
    { id: "xai",       label: "Grok",    tagline: "xAI direct",           placeholder: "xai-…",    helpUrl: "https://console.x.ai/team",                   helpLabel: "console.x.ai" },
  ];
  const ALL_LLM_CARDS = [...LLM_CARDS_MULTI, ...LLM_CARDS_SINGLE];

  function escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function tr(key, vars) {
    return (window.I18n && window.I18n.t(key, vars)) || key;
  }

  /* ── Storage helpers ───────────────────────────────────────── */
  function getAppearance() {
    try {
      const v = localStorage.getItem(APPEARANCE_KEY);
      // Default · "dark" (not "system"). Matches the FOUC bootstrap in
      // index.html / home.html so the segmented control reflects the
      // same fresh-install default the page just applied.
      return APPEARANCE_MODES.indexOf(v) >= 0 ? v : "dark";
    } catch (e) { return "dark"; }
  }
  function setAppearance(mode) {
    const next = APPEARANCE_MODES.indexOf(mode) >= 0 ? mode : "dark";
    try { localStorage.setItem(APPEARANCE_KEY, next); } catch (e) {}
    // The FOUC bootstrap subscribes to `storage` events for cross-tab
    // sync, but same-tab writes don't fire that event. Resolve and
    // apply data-theme directly so the swap is instant on this tab too.
    let resolved = next;
    if (next === "system") {
      try { resolved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
      catch (e) { resolved = "dark"; }
    }
    document.documentElement.setAttribute("data-theme", resolved);
    // Electron-only · push the USER PREFERENCE (not the resolved value)
    // so the macOS window vibrancy follows the same light/dark/system
    // choice as the in-app surfaces.
    try { window.privateboard && window.privateboard.setThemeSource && window.privateboard.setThemeSource(next); } catch (e) {}
  }

  async function fetchPrefs() {
    try {
      const r = await fetch("/api/prefs");
      if (!r.ok) return;
      const data = await r.json();
      _prefsCache = {
        name: typeof data.name === "string" ? data.name : "You",
        intro: typeof data.intro === "string" ? data.intro : "",
        avatarSeed: data.avatarSeed ?? null,
        webSearchProvider: data.webSearchProvider === "tavily" ? "tavily" : "brave",
        minimaxRegion: data.minimaxRegion === "intl" ? "intl" : "cn",
      };
    } catch (e) {
      // Network or server hiccup — fall back to whatever's already cached.
    }
  }

  // Sync read from cache (populated at bootstrap below).
  function getUser() { return _prefsCache; }

  // Write-through: update cache immediately, persist to server in background.
  // We don't await — the UI doesn't block on the round-trip.
  function saveUser(u) {
    _prefsCache = { ...(_prefsCache || {}), ...u };
    fetch("/api/prefs", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: u.name,
        intro: u.intro,
        avatarSeed: u.avatarSeed
      })
    }).catch(() => { /* offline → cache stays, retry on next edit */ });
  }

  // Provider keys · canonical state lives in keys-store.js (loaded as a
  // module script before this file). All reads/writes go through that store;
  // _keysMeta is a live accessor so the rest of this file needs no changes.
  const _keysMeta = new Proxy({}, {
    get(_, k) { return window.keysStore ? window.keysStore.keysMeta[k] : undefined; },
    set(_, k, v) { if (window.keysStore) window.keysStore.keysMeta[k] = v; return true; },
    ownKeys() { return window.keysStore ? Object.keys(window.keysStore.keysMeta) : []; },
    has(_, k) { return window.keysStore ? k in window.keysStore.keysMeta : false; },
    getOwnPropertyDescriptor(_, k) {
      const v = window.keysStore ? window.keysStore.keysMeta[k] : undefined;
      return v !== undefined ? { value: v, writable: true, enumerable: true, configurable: true } : undefined;
    },
  });

  function fetchKeyMeta() {
    return window.keysStore ? window.keysStore.fetchKeyMeta() : Promise.resolve();
  }

  function fetchLlmCredentials() {
    return window.keysStore && typeof window.keysStore.fetchLlmCredentials === "function"
      ? window.keysStore.fetchLlmCredentials()
      : Promise.resolve();
  }
  function listLlmCredentials() {
    return window.keysStore ? (window.keysStore.llmCredentials || []) : [];
  }
  function activeLlmCredentialId() {
    return window.keysStore ? window.keysStore.activeLlmCredentialId : null;
  }

  // Sync read used by new-agent.js: returns a map { provider: truthy } where
  // 'truthy' is the meta object so existence-check (`if (keys[p])`) still works.
  function getKeys() {
    return window.keysStore ? window.keysStore.getConfiguredKeys() : {};
  }

  // Available-models snapshot · shape from /api/models. We don't keep
  // a private copy any more — the singleton in models-cache.js owns
  // the canonical state. Local read goes through the global, so all
  // pickers (composer / agent profile / new-agent / this default
  // selector) stay in sync after a key write.
  function modelsSnapshot() {
    return (typeof window.boardroomModels === "function") ? window.boardroomModels() : null;
  }
  function refreshModels() {
    if (typeof window.boardroomModelsRefresh === "function") return window.boardroomModelsRefresh();
    return Promise.resolve(null);
  }

  async function saveDefaultModel(modelV) {
    try {
      await fetch("/api/prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ defaultModelV: modelV }),
      });
      // Patch the shared cache in place so the next read sees the
      // user's choice without round-tripping. Other tabs / pickers
      // pick it up on their next refresh.
      const snap = modelsSnapshot();
      if (snap) snap.defaultModelV = modelV;
    } catch (e) { /* swallow · UI is optimistic */ }
  }

  // Provider→primary-model helpers (`primaryModelForProvider`,
  // `currentDefaultProvider`, `setProviderAsDefault`) lived here to
  // power the per-row "set as default" button on the API Key pane.
  // That button + its companion bottom-of-pane Default Model picker
  // were removed in favour of the dedicated "Default Model" sidebar
  // pane (single source of truth). Helpers deleted as dead code.

  // Set / clear a single provider key — delegated to keys-store.js.
  function setProviderKey(provider, value) {
    return window.keysStore ? window.keysStore.setProviderKey(provider, value) : Promise.resolve(null);
  }

  // Public — other modules read provider configuration via this
  window.boardroomKeys = getKeys;
  // Appearance is applied by the inline FOUC bootstrap in index.html /
  // home.html before this script loads; no init pass needed here.

  /* ── Section content renderers ────────────────────────────── */
  function userSectionHTML() {
    const u = getUser();
    return `
      <div class="us-pane-head">
        <div class="us-pane-tag">${tr("us_user_tag")}</div>
        <div class="us-pane-deck">${tr("us_user_deck")}</div>
      </div>

      <div class="us-pane-body">
        <div class="us-row">
          <div class="us-row-label">${tr("us_avatar")}</div>
          <div class="us-row-field us-avatar-row">
            <div class="us-avatar-frame" data-us-avatar></div>
            <button type="button" class="us-mini-btn" data-us-regen-avatar>
              <span class="us-mini-btn-mark">◆</span>
              <span>${tr("us_regen_avatar")}</span>
            </button>
          </div>
        </div>

        <div class="us-row">
          <div class="us-row-label">${tr("us_name")}</div>
          <div class="us-row-field">
            <div class="us-input-wrap">
              <input type="text" class="us-input" data-us-name placeholder="Kay" maxlength="32" value="${escape(u.name || "")}">
            </div>
          </div>
        </div>

        <div class="us-row">
          <div class="us-row-label">${tr("us_about")}</div>
          <div class="us-row-field">
            <div class="us-input-wrap tall">
              <textarea class="us-input" data-us-intro maxlength="320" placeholder="${escape(tr("us_intro_ph"))}">${escape(u.intro || "")}</textarea>
            </div>
            <div class="us-row-meta"><span data-us-intro-count>0</span><span>${tr("us_intro_meta_rest")}</span></div>
          </div>
        </div>

      </div>
    `;
  }

  /* ── Other settings · misc per-user toggles that don't fit a
        dedicated section. Appearance · interface language · typing-
        sound effect; natural home for future small ambient / UX prefs. */
  function appearanceSegmentsHTML() {
    const cur = getAppearance();
    return APPEARANCE_MODES.map((mode) => {
      const label = tr(`us_appearance_${mode}`);
      const cls = "us-seg-btn" + (mode === cur ? " active" : "");
      return `<button type="button" class="${cls}" data-appearance="${mode}" role="radio" aria-checked="${mode === cur ? "true" : "false"}">${escape(label)}</button>`;
    }).join("");
  }

  /* ── Room style toggle (3D voxel boardroom vs 2D flat round-table)
        Persists to `localStorage["boardroom.stage3d"]` ("on" | "off")
        — same key voice-3d.js and renderRoundTable already gate on.
        Default "on" matches the existing implicit default. */
  const STAGE3D_KEY = "boardroom.stage3d";
  function getStage3d() {
    try { return localStorage.getItem(STAGE3D_KEY) !== "off"; }
    catch (_) { return true; }
  }
  function setStage3d(on) {
    try { localStorage.setItem(STAGE3D_KEY, on ? "on" : "off"); } catch (_) {}
  }
  function stageStyleSegmentsHTML() {
    const cur = getStage3d() ? "3d" : "2d";
    const items = [
      { key: "3d", labelKey: "us_stage_3d" },
      { key: "2d", labelKey: "us_stage_2d" },
    ];
    return items.map(({ key, labelKey }) => {
      const label = tr(labelKey);
      const cls = "us-seg-btn" + (key === cur ? " active" : "");
      return `<button type="button" class="${cls}" data-stage="${key}" role="radio" aria-checked="${key === cur ? "true" : "false"}">${escape(label)}</button>`;
    }).join("");
  }

  function otherSettingsSectionHTML() {
    return `
      <div class="us-pane-head">
        <div class="us-pane-tag">${tr("us_other_tag")}</div>
        <div class="us-pane-deck">${tr("us_other_deck")}</div>
      </div>

      <div class="us-pane-body">
        <div class="us-row">
          <div class="us-row-label">${tr("us_appearance_label")}</div>
          <div class="us-row-field">
            <div class="us-seg" role="radiogroup" aria-label="${escape(tr("us_appearance_label"))}" data-us-appearance>
              ${appearanceSegmentsHTML()}
            </div>
            <p class="us-locale-deck">${escape(tr("us_appearance_deck"))}</p>
          </div>
        </div>

        <div class="us-row">
          <div class="us-row-label">${tr("us_stage_label")}</div>
          <div class="us-row-field">
            <div class="us-seg" role="radiogroup" aria-label="${escape(tr("us_stage_label"))}" data-us-stage>
              ${stageStyleSegmentsHTML()}
            </div>
            <p class="us-locale-deck">${escape(tr("us_stage_deck"))}</p>
          </div>
        </div>

        <div class="us-row">
          <div class="us-row-label">${tr("us_locale_label")}</div>
          <div class="us-row-field">
            <button type="button" class="cmp-dd" data-cmp-dropdown="locale" title="${escape(tr("us_locale_label"))}" data-i18n-aria="aria_language" aria-label="">
              <span class="cmp-dd-label" data-i18n="us_locale_label">${escape(tr("us_locale_label"))}</span>
              <span class="cmp-dd-value" data-cmp-dd-value="locale">${escape(tr(`locale_${(window.I18n && window.I18n.getLocale && window.I18n.getLocale()) || "en"}`))}</span>
              <span class="cmp-dd-chevron">▾</span>
            </button>
            <p class="us-locale-deck">${escape(tr("us_locale_deck"))}</p>
          </div>
        </div>

        <div class="us-row">
          <div class="us-row-label">Typing sound</div>
          <div class="us-row-field">
            <div class="us-toggle-row">
              <button type="button" class="us-switch" data-us-sfx-typing role="switch" aria-checked="false">
                <span class="us-switch-track" aria-hidden="true">
                  <span class="us-switch-thumb"></span>
                </span>
                <span class="us-switch-label" data-us-sfx-typing-label>off</span>
              </button>
              <span class="us-toggle-deck">a soft keyboard click as directors stream their replies in chat. Brief generation stays silent regardless of this setting.</span>
            </div>
          </div>
        </div>

        <div class="us-row">
          <div class="us-row-label">${escape(tr("us_replay_onb_label"))}</div>
          <div class="us-row-field">
            <div class="us-toggle-row">
              <button type="button" class="us-btn-ghost" data-us-replay-onb>${escape(tr("us_replay_onb_btn"))}</button>
              <span class="us-toggle-deck">${escape(tr("us_replay_onb_deck"))}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function wireOtherSettingsSection() {
    if (!paneEl) return;
    if (window.I18n && typeof window.I18n.applyDom === "function") {
      window.I18n.applyDom(paneEl);
    }
    if (window.I18n && typeof window.I18n.syncLocaleControls === "function") {
      window.I18n.syncLocaleControls();
    }

    // Appearance segmented control · dark / light / system. setAppearance
    // writes the localStorage key AND applies data-theme immediately so
    // the swap is instant; the FOUC bootstrap continues to handle live
    // OS-level changes when "system" is selected.
    const apGroup = paneEl.querySelector("[data-us-appearance]");
    if (apGroup) {
      apGroup.addEventListener("click", (e) => {
        const btn = e.target.closest(".us-seg-btn[data-appearance]");
        if (!btn) return;
        const next = btn.dataset.appearance;
        setAppearance(next);
        apGroup.querySelectorAll(".us-seg-btn").forEach((el) => {
          const on = el.dataset.appearance === next;
          el.classList.toggle("active", on);
          el.setAttribute("aria-checked", on ? "true" : "false");
        });
      });
    }

    // Room style segmented control · 3D / 2D. Writes the
    // localStorage key the voice-3d gate already reads, then asks
    // the app to re-render the current round-table so the swap is
    // visible immediately for anyone currently sitting in a voice
    // room (instead of "have to leave + re-enter to see it").
    const stGroup = paneEl.querySelector("[data-us-stage]");
    if (stGroup) {
      stGroup.addEventListener("click", (e) => {
        const btn = e.target.closest(".us-seg-btn[data-stage]");
        if (!btn) return;
        const next = btn.dataset.stage; // "3d" | "2d"
        setStage3d(next === "3d");
        stGroup.querySelectorAll(".us-seg-btn").forEach((el) => {
          const on = el.dataset.stage === next;
          el.classList.toggle("active", on);
          el.setAttribute("aria-checked", on ? "true" : "false");
        });
        try {
          if (window.app && typeof window.app.renderRoundTable === "function") {
            window.app.renderRoundTable();
          }
        } catch (_) { /* room may not be a voice room · ignore */ }
      });
    }
    // Typing-sound toggle · the persistence + audio context lives in
    // window.boardroomTypingSfx (typing-sfx.js); this row only mirrors
    // the current state and proxies clicks. Reading inside wire-up
    // (not at HTML build time) means the pill always reflects the
    // LATEST stored state when the section re-mounts.
    const sfxBtn = paneEl.querySelector("[data-us-sfx-typing]");
    const sfxLabel = paneEl.querySelector("[data-us-sfx-typing-label]");
    if (sfxBtn && sfxLabel && window.boardroomTypingSfx) {
      const paint = () => {
        const on = window.boardroomTypingSfx.isEnabled();
        sfxBtn.classList.toggle("on", on);
        // role="switch" wants `aria-checked`, not `aria-pressed`.
        sfxBtn.setAttribute("aria-checked", on ? "true" : "false");
        sfxLabel.textContent = on ? "on" : "off";
      };
      paint();
      sfxBtn.addEventListener("click", () => {
        const next = !window.boardroomTypingSfx.isEnabled();
        window.boardroomTypingSfx.setEnabled(next);
        paint();
        // Audible confirmation when turning ON · the click that just
        // toggled also serves as the gesture the AudioContext needs,
        // so this tick is actually heard.
        if (next) window.boardroomTypingSfx.tick();
        // Re-evaluate the agent-build ambient · this toggle is the
        // master gate. Flipping OFF silences any active build BGM;
        // flipping ON resumes it if a build is currently running on
        // the user's foreground composer.
        try { window.app?._syncAgentBuildBgm?.(); } catch { /* ignore */ }
      });
    }

    // Replay onboarding · close the settings overlay first so the user
    // lands on a clean dashboard, then trigger the storyline overlay.
    // The replay helper in onboarding.js handles step reset + the
    // once-only composer-hint flag.
    const replayBtn = paneEl.querySelector("[data-us-replay-onb]");
    if (replayBtn) {
      replayBtn.addEventListener("click", () => {
        try { if (typeof window.closeUserSettings === "function") window.closeUserSettings(); } catch { /* ignore */ }
        // Settings overlay teardown sets up a 220ms close animation
        // (see modal close handler); kick off onboarding after that so
        // the two overlays don't briefly stack.
        setTimeout(() => {
          if (typeof window.boardroomReplayOnboarding === "function") {
            window.boardroomReplayOnboarding();
          } else if (typeof window.boardroomShowOnboarding === "function") {
            window.boardroomShowOnboarding();
          }
        }, 240);
      });
    }
  }

  /* ── Usage section ────────────────────────────────────────── */
  // Provider → CSS-variable color slot. Lets each model bar/swatch
  // pick up the right accent from the active theme without baking
  // color values here.
  const PROVIDER_COLOR_VAR = {
    anthropic: "--lime",
    openai:    "--cyan",
    google:    "--amber",
    xai:       "--magenta",
    deepseek:  "--red",
    unknown:   "--text-soft",
  };

  function fmtTokens(n) {
    if (!Number.isFinite(n) || n <= 0) return "0";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2) + "M";
    if (n >= 1_000)     return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + "k";
    return String(Math.round(n));
  }

  function usageSectionHTML() {
    return `
      <div class="us-pane-head">
        <div class="us-pane-tag">${tr("us_usage_tag")}</div>
        <div class="us-pane-deck">${tr("us_usage_deck")}</div>
      </div>

      <div class="us-pane-body">
        <div class="us-usage" data-usage-pane>
          <div class="us-usage-loading">${tr("us_usage_loading")}</div>
        </div>
      </div>
    `;
  }

  /* Usage-pane state · the cumulative summary fetched from /api/usage/summary
   *  + the currently-selected day for the drill-down panel. `null` selection
   *  means "All · cumulative" (the legacy view, default on open). */
  let _usageSummary = null;
  let _selectedDay = null;

  function fmtDayLabel(dayStr) {
    // 'YYYY-MM-DD' → 'M·D' for the bar's x-axis tick label.
    const [, m, d] = dayStr.split("-");
    return `${parseInt(m, 10)}·${parseInt(d, 10)}`;
  }
  function fmtDayLong(dayStr) {
    // 'YYYY-MM-DD' → 'Apr 25' style for the drill-down header.
    const d = new Date(dayStr + "T00:00:00");
    if (isNaN(d.getTime())) return dayStr;
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[d.getMonth()]} ${d.getDate()}`;
  }

  function renderUsagePane(s) {
    const pane = paneEl.querySelector("[data-usage-pane]");
    if (!pane) return;
    _usageSummary = s;
    if (!s || s.totalTokens === 0) {
      pane.innerHTML = `
        <div class="us-usage-empty">
          <div class="us-usage-empty-num">0</div>
          <div class="us-usage-empty-text">${tr("us_usage_empty")}</div>
        </div>
      `;
      return;
    }
    pane.innerHTML = `
      ${renderDayPicker(s)}
      ${renderUsageChart(s)}
      <div data-usage-detail>${renderUsageDetail(s, null)}</div>
    `;
  }

  /* ─── Day picker · pill toggle above the chart ────────────────
     Two pills: [All · cumulative] always present; the second appears
     only when a specific day is selected and shows "May 8" (or the
     localised date). Clicking either pill or any chart bar swaps
     the detail body below. */
  function renderDayPicker(s) {
    const day = _selectedDay;
    const allActive = day === null ? " active" : "";
    const dayActive = day !== null ? " active" : "";
    const dayPill = day !== null
      ? `<button type="button" class="us-day-pill${dayActive}" data-usage-day="${escape(day)}">${escape(fmtDayLong(day))}</button>`
      : "";
    return `
      <div class="us-day-picker">
        <button type="button" class="us-day-pill${allActive}" data-usage-day="all">All · cumulative</button>
        ${dayPill}
      </div>
    `;
  }

  /* ─── 14-day stacked bar chart · provider-coloured ───────────
     Each bar is a vertical column flexing to fill the available
     width; segments inside it stack by provider colour, weighted by
     each provider's share of THAT day's tokens. Bar heights are
     linear-scaled to the 14-day window's max — empty days render
     as a 1px baseline tick that's still clickable so the user can
     drill into "no usage on this day" without a separate empty
     state. Today's bar carries an outline marker. */
  function renderUsageChart(s) {
    const days = Array.isArray(s.daily) ? s.daily : [];
    if (days.length === 0) return "";
    const max = days.reduce((m, d) => Math.max(m, d.totalTokens || 0), 0);
    const last14Total = days.reduce((sum, d) => sum + (d.totalTokens || 0), 0);
    const todayKey = days[days.length - 1]?.day;
    const bars = days.map((d) => {
      const total = d.totalTokens || 0;
      // Linear height scaled to 14-day max. Below 1% of max we still
      // give a 1px tick so empty days are clickable.
      const heightPct = max > 0 ? Math.max(total > 0 ? (total / max) * 100 : 0, total > 0 ? 2 : 0) : 0;
      // Provider sub-segments inside the bar · stacked bottom → top.
      const segs = (d.byModel || [])
        .reduce((map, m) => {
          // Collapse models within the same provider into one stack
          // segment · bar resolution stays per-provider; per-model
          // detail lives in the drill-down below.
          const cur = map.get(m.provider) || { tokens: 0, names: [] };
          cur.tokens += m.tokens;
          cur.names.push(`${m.displayName} ${fmtTokens(m.tokens)}`);
          map.set(m.provider, cur);
          return map;
        }, new Map());
      const segHtml = Array.from(segs.entries()).map(([provider, v]) => {
        const segPct = total > 0 ? (v.tokens / total) * 100 : 0;
        const color = PROVIDER_COLOR_VAR[provider] || PROVIDER_COLOR_VAR.unknown;
        return `<span class="us-chart-seg" style="height:${segPct.toFixed(2)}%;background:var(${color})" title="${escape(v.names.join(' · '))}"></span>`;
      }).join("");
      const isToday = d.day === todayKey;
      const isSelected = _selectedDay === d.day;
      const cls = ["us-chart-bar"];
      if (isToday) cls.push("today");
      if (isSelected) cls.push("active");
      if (total === 0) cls.push("empty");
      // Custom hover tooltip · two lines (day + token count) rendered
      // via CSS `::before` from `data-tip-day` / `data-tip-num`. We
      // use `aria-label` (not `title`) so screen readers still get
      // the info but the native browser tooltip with its ~500ms
      // delay doesn't fight with the instant custom one.
      const dayLabel = fmtDayLong(d.day);
      const numLabel = total > 0 ? `${fmtTokens(total)} tokens` : "no usage";
      const aria = `${dayLabel} · ${numLabel}`;
      return `
        <button type="button" class="${cls.join(' ')}"
          data-usage-day="${escape(d.day)}"
          data-tip-day="${escape(dayLabel)}"
          data-tip-num="${escape(numLabel)}"
          aria-label="${escape(aria)}">
          <span class="us-chart-stack" style="height:${heightPct.toFixed(2)}%">${segHtml}</span>
          <span class="us-chart-tick">${escape(fmtDayLabel(d.day))}</span>
        </button>
      `;
    }).join("");
    return `
      <div class="us-chart-wrap" aria-label="14-day token usage">
        <div class="us-chart-meta">
          <span class="us-chart-meta-label">Last 14 days</span>
          <span class="us-chart-meta-value">${fmtTokens(last14Total)}</span>
        </div>
        <div class="us-chart-bars">${bars}</div>
      </div>
    `;
  }

  /* ─── Detail · the original "by model / top consumers" body,
     parameterised on either the cumulative summary `s` (when
     `dayKey === null`) or one day's rollup pulled from `s.daily`
     (when `dayKey` matches a day). ────────────────────────────── */
  function renderUsageDetail(s, dayKey) {
    if (dayKey === null) {
      return renderDetailBody({
        total: s.totalTokens,
        byModel: s.byModel,
        byAgent: s.byAgent,
        agentCount: s.agentCount,
        retired: s.retired || { tokens: 0, agents: 0 },
        scopeLabel: "Cumulative since install",
      });
    }
    const d = (s.daily || []).find((x) => x.day === dayKey);
    if (!d || d.totalTokens === 0) {
      return `
        <div class="us-day-empty">
          <div class="us-day-empty-tag">${escape(fmtDayLong(dayKey))}</div>
          <div class="us-day-empty-text">no usage on this day.</div>
        </div>
      `;
    }
    return renderDetailBody({
      total: d.totalTokens,
      byModel: d.byModel,
      byAgent: d.byAgent,
      agentCount: d.byAgent.length,
      retired: { tokens: 0, agents: 0 },
      scopeLabel: fmtDayLong(dayKey),
    });
  }

  function renderDetailBody({ total, byModel, byAgent, agentCount, retired, scopeLabel }) {
    const segments = byModel.map((m) => {
      const pct = (m.tokens / total) * 100;
      const color = PROVIDER_COLOR_VAR[m.provider] || PROVIDER_COLOR_VAR.unknown;
      return `<span class="us-usage-seg" style="width:${pct.toFixed(2)}%;background:var(${color})" title="${escape(m.displayName)} · ${fmtTokens(m.tokens)}"></span>`;
    }).join("");

    const modelRows = byModel.map((m) => {
      const pct = (m.tokens / total) * 100;
      const color = PROVIDER_COLOR_VAR[m.provider] || PROVIDER_COLOR_VAR.unknown;
      return `
        <div class="us-model-row">
          <div class="us-model-info">
            <span class="us-model-dot" style="background:var(${color})"></span>
            <span class="us-model-name">${escape(m.displayName)}</span>
            <span class="us-model-provider">${escape(m.provider)}</span>
          </div>
          <div class="us-model-bar">
            <span style="width:${pct.toFixed(2)}%;background:var(${color})"></span>
          </div>
          <div class="us-model-stats">
            <span class="us-model-tokens">${fmtTokens(m.tokens)}</span>
            <span class="us-model-pct">${pct.toFixed(1)}%</span>
            <span class="us-model-agents">${tr("us_usage_agents", { n: m.agents })}</span>
          </div>
        </div>
      `;
    }).join("");

    const topAgents = byAgent.filter((a) => a.tokens > 0).slice(0, 6);
    const agentRows = topAgents.map((a) => {
      const pct = (a.tokens / total) * 100;
      const color = PROVIDER_COLOR_VAR[a.provider] || PROVIDER_COLOR_VAR.unknown;
      const role = a.roleKind === "moderator" ? tr("us_usage_chair") : tr("us_usage_director");
      return `
        <div class="us-agent-row">
          <div class="us-agent-name-col">
            <span class="us-agent-name">${escape(a.name)}</span>
            <span class="us-agent-role">${role}</span>
          </div>
          <div class="us-agent-model" style="color:var(${color})">${escape(a.displayName)}</div>
          <div class="us-agent-bar">
            <span style="width:${Math.max(pct, 1).toFixed(2)}%;background:var(${color})"></span>
          </div>
          <div class="us-agent-tokens">${fmtTokens(a.tokens)}</div>
        </div>
      `;
    }).join("");

    const silentCount = byAgent.length - topAgents.length;
    const silentNote = silentCount > 0
      ? `<div class="us-agent-silent">${tr("us_usage_silent", { n: silentCount })}</div>`
      : "";

    const retiredNote = retired.tokens > 0
      ? `
        <div class="us-usage-retired">
          <span class="us-usage-retired-mark">↓</span>
          <span class="us-usage-retired-text">
            <strong>${retired.agents}</strong> retired
            agent${retired.agents === 1 ? "" : "s"} ·
            <strong>${fmtTokens(retired.tokens)}</strong> tokens preserved across deletions and folded into the model totals above.
          </span>
        </div>
      `
      : "";

    return `
      <div class="us-usage-head">
        <div class="us-usage-total">
          <div class="us-usage-total-scope">${escape(scopeLabel)}</div>
          <div class="us-usage-total-num">${fmtTokens(total)}</div>
          <div class="us-usage-total-raw">${total.toLocaleString()} tokens</div>
        </div>
        <div class="us-usage-meta">
          <div class="us-usage-meta-row">
            <span class="us-usage-meta-label">Models</span>
            <span class="us-usage-meta-value">${byModel.length}</span>
          </div>
          <div class="us-usage-meta-row">
            <span class="us-usage-meta-label">Agents</span>
            <span class="us-usage-meta-value">${agentCount}</span>
          </div>
          <div class="us-usage-meta-row">
            <span class="us-usage-meta-label">Active</span>
            <span class="us-usage-meta-value">${byAgent.filter((a) => a.tokens > 0).length}</span>
          </div>
        </div>
      </div>

      <div class="us-usage-bar" aria-label="Token distribution by model">${segments}</div>

      <div class="us-usage-section">
        <div class="us-usage-section-tag">By model</div>
        <div class="us-model-list">${modelRows}</div>
      </div>

      ${topAgents.length ? `
        <div class="us-usage-section">
          <div class="us-usage-section-tag">Top consumers</div>
          <div class="us-agent-list">${agentRows}</div>
          ${silentNote}
        </div>
      ` : ""}

      ${retiredNote}
    `;
  }

  /** Click handler · delegated on the pane. Bar OR pill click flips
   *  `_selectedDay` and re-renders chart + drill-down in place. We
   *  re-render the WHOLE pane (cheap; it's a small DOM) so the active-
   *  state classes on bars and pills both stay in sync. */
  function onUsageClick(e) {
    const trigger = e.target.closest("[data-usage-day]");
    if (!trigger) return;
    if (!_usageSummary) return;
    const next = trigger.dataset.usageDay;
    _selectedDay = (next === "all") ? null : next;
    renderUsagePane(_usageSummary);
  }

  async function wireUsageSection() {
    const pane = paneEl.querySelector("[data-usage-pane]");
    if (pane && !pane.dataset.usageBound) {
      pane.addEventListener("click", onUsageClick);
      pane.dataset.usageBound = "1";
    }
    try {
      const r = await fetch("/api/usage/summary");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const s = await r.json();
      _selectedDay = null; // reset to "All" on each pane open
      renderUsagePane(s);
    } catch (e) {
      if (pane) pane.innerHTML = `<div class="us-usage-empty"><div class="us-usage-empty-text">couldn't fetch usage stats. ${escape(String(e && e.message || e))}</div></div>`;
    }
  }

  const SKILL_PROVIDER_IDS = PROVIDERS.filter((p) => p.group === "skill").map((p) => p.id);
  const VOICE_PROVIDER_IDS = PROVIDERS.filter((p) => p.group === "voice").map((p) => p.id);

  /** Add-provider transient UI state · null = closed, an object = open.
   *  Keys: `step` ("pick" | "key"), `provider` (selected provider id
   *  when step==="key"). Lives outside the wireKeysSection closure so
   *  a re-render preserves the in-progress state. */
  let _addState = null;

  /** Active credential lookup helpers (credential-based, not
   *  provider-based — same provider can have multiple credentials). */
  function activeCredential() {
    const id = activeLlmCredentialId();
    if (!id) return null;
    return listLlmCredentials().find((c) => c.id === id) || null;
  }
  function activeLlmProvider() {
    const c = activeCredential();
    return c ? c.provider : null;
  }

  function renderKeyRow(p, removable) {
    const meta = _keysMeta[p.id];
    const has = !!(meta && meta.configured);
    // The server never returns plaintext, but it does return a 4+4
    // masked preview of the stored key (e.g. "sk-or…YjNH"). Surfacing
    // it as the placeholder lets the user verify which key is in which
    // slot — a real failure mode we hit when the OpenRouter slot
    // silently held a Brave key. When configured we show the preview
    // alone (no "paste to replace" hint); when empty we show the
    // provider's normal hint.
    const preview = has && meta.preview ? meta.preview : null;
    const placeholder = has
      ? (preview || "••••••••")
      : p.placeholder;
    // LLM rows no longer flow through this function — the active-LLM
    // card grid (renderLlmCard) is their entry point. This renderer
    // now exclusively handles voice + skill, both of which are
    // multi-key by design and never carry the lock guard the LLM rows
    // used to need.
    // Per-provider extras · MiniMax needs an API-region selector
    // (the same key works against two different host URLs — China
    // vs international). Sits inside the row so it's visually
    // attached to the key it modifies.
    const extras = p.id === "minimax" && has
      ? minimaxRegionRowHTML()
      : "";

    return `
      <div class="us-key-row" data-provider="${p.id}">
        <div class="us-key-head">
          <div class="us-key-label">${escape(p.label)}</div>
          <div class="us-key-status ${has ? "on" : "off"}" data-status>${has ? "● configured" : "○ not set"}</div>
          ${removable
            ? `<button type="button" class="us-key-remove" data-remove-provider="${p.id}" title="Remove">✕</button>`
            : ""}
        </div>
        <div class="us-key-hint">${escape(p.hint)}</div>
        <div class="us-input-wrap">
          <input
            type="text"
            class="us-input us-input-masked${has ? " has-preview" : ""}"
            data-key-input
            name="bk-${p.id}"
            placeholder="${escape(placeholder)}"
            value=""
            autocomplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            data-form-type="other"
            spellcheck="false">
          <button type="button" class="us-key-eye" data-key-eye title="Show / hide">◉</button>
        </div>
        ${extras}
      </div>
    `;
  }

  /** Resolve the rendering source for an LLM card by provider id. */
  function llmCardByProvider(id) {
    return ALL_LLM_CARDS.find((c) => c.id === id) || null;
  }

  /** Compress the server's length-preserving mask so long keys don't
   *  overflow the hero / row containers. Server emits e.g.
   *  `sk-or••••(56 dots)••••YjNH` (60 chars total). For the UI we
   *  keep the head + tail real characters intact and collapse the
   *  middle bullet run to a fixed-length 24 — giving roughly 32-char
   *  previews like `sk-or••••••••••••••••••••••••YjNH`. Short masks
   *  (already ≤ 24 bullets in the middle) are passed through untouched. */
  function compactMask(preview) {
    if (!preview || typeof preview !== "string") return preview || "";
    return preview.replace(/[•]{25,}/g, "••••••••••••••••••••••••");
  }

  /** Hero · "Currently using" panel. Names the active credential's
   *  label (e.g. "B.AI" or "OpenRouter 2") + provider + masked
   *  preview. When no credential is configured, renders an
   *  invite-to-add empty state. */
  function activeLlmHeroHTML() {
    const cred = activeCredential();
    if (!cred) {
      return `
        <div class="us-llm-hero is-empty">
          <div class="us-llm-hero-head">
            <div class="us-llm-hero-title">${escape(tr("us_active_llm_hero_empty_title") || "No active LLM provider")}</div>
            <div class="us-llm-hero-pill is-empty">○ ${escape(tr("us_active_llm_hero_empty_pill") || "no provider")}</div>
          </div>
          <div class="us-llm-hero-deck">${escape(tr("us_active_llm_hero_empty_deck") || "Add a provider below to power every director.")}</div>
        </div>
      `;
    }
    const card = llmCardByProvider(cred.provider);
    const classification = MULTI_MODEL_LLM_PROVIDERS.indexOf(cred.provider) >= 0 ? "multi" : "single";
    const pitch = tr(`us_active_llm_${classification}_pitch_${cred.provider}`) || (card ? card.tagline : "");
    const providerName = card ? card.label : cred.provider;
    return `
      <div class="us-llm-hero is-active" data-llm-hero data-credential-id="${escape(cred.id)}">
        <div class="us-llm-hero-head">
          <div class="us-llm-hero-titleblock">
            <div class="us-llm-hero-title">${escape(cred.label)}</div>
            <div class="us-llm-hero-provider">${escape(providerName)}</div>
          </div>
          <div class="us-llm-hero-pill">● ${escape(tr("us_active_llm_hero_pill") || "ACTIVE")}</div>
        </div>
        <div class="us-llm-hero-deck">${escape(pitch)}</div>
        ${cred.preview ? `<div class="us-llm-hero-preview">${escape(compactMask(cred.preview))}</div>` : ""}
      </div>
    `;
  }

  /** "Added providers" list · every configured credential, sorted by
   *  createdAt. ✓ on the active row. Tap a non-active row to switch.
   *  ✕ removes — server auto-rotates active when needed. */
  function addedLlmListHTML() {
    const creds = listLlmCredentials();
    if (creds.length === 0) return "";
    const activeId = activeLlmCredentialId();
    const rows = creds.map((c) => {
      const isActive = c.id === activeId;
      const tapHint = tr("us_active_llm_tap_to_switch") || "tap to switch";
      const card = llmCardByProvider(c.provider);
      const providerName = card ? card.label : c.provider;
      return `
        <div class="us-llm-row${isActive ? " is-active" : ""}" data-llm-row data-credential-id="${escape(c.id)}" tabindex="0" role="button" aria-label="${escape(c.label)}">
          <div class="us-llm-row-head">
            <div class="us-llm-row-titleblock">
              <span class="us-llm-row-label">${escape(c.label)}</span>
              <span class="us-llm-row-provider">${escape(providerName)}</span>
            </div>
            <div class="us-llm-row-trailing">
              ${isActive
                ? `<span class="us-llm-row-mark">✓</span>`
                : `<span class="us-llm-row-hint">${escape(tapHint)}</span>`}
              <button type="button" class="us-key-remove" data-remove-credential="${escape(c.id)}" title="${escape(tr("us_active_llm_remove_tip") || "Remove")}">✕</button>
            </div>
          </div>
          <div class="us-input-wrap us-llm-row-keywrap">
            <div class="us-input us-llm-row-preview">${escape(compactMask(c.preview || ""))}</div>
          </div>
        </div>
      `;
    }).join("");
    return `
      <div class="us-llm-added">
        <div class="us-llm-added-header">
          <span>${escape(tr("us_active_llm_added_header") || "Added providers")}</span>
          <span class="us-llm-added-count">${creds.length}</span>
        </div>
        <div class="us-llm-added-list">${rows}</div>
      </div>
    `;
  }

  /** Add-provider entry block · the closed state shows a single "+"
   *  button. The open state has two steps:
   *
   *    step "pick"  · grid of every supported provider with tagline.
   *                   Clicking one transitions to "key".
   *    step "key"   · selected provider's pitch + optional label
   *                   input + key paste + Save button. ← back to picker.
   *
   *  The same provider can be added multiple times — picker doesn't
   *  filter out providers that already have a credential. xAI still
   *  auto-hides when the registry has no Grok rows. */
  function addProviderBlockHTML() {
    if (!_addState) {
      return `
        <div class="us-llm-add">
          <button type="button" class="us-llm-add-trigger" data-llm-add-open>
            <span class="us-llm-add-glyph">+</span>
            <span>${escape(tr("us_active_llm_add_btn") || "Add provider")}</span>
          </button>
        </div>
      `;
    }
    if (_addState.step === "pick") {
      const cache = modelsSnapshot();
      const allModels = (cache && Array.isArray(cache.models)) ? cache.models : [];
      const visibleSingle = LLM_CARDS_SINGLE.filter((c) => {
        if (!cache) return true;
        return allModels.some((m) => m && m.provider === c.id);
      });
      const renderPick = (card, classification) => {
        const pitch = tr(`us_active_llm_${classification}_pitch_${card.id}`) || card.tagline || "";
        return `
          <button type="button" class="us-llm-pick us-llm-pick-${classification}" data-llm-pick="${escape(card.id)}">
            <div class="us-llm-pick-head">
              <div class="us-llm-pick-label">${escape(card.label)}</div>
            </div>
            <div class="us-llm-pick-tag">${escape(pitch)}</div>
          </button>
        `;
      };
      return `
        <div class="us-llm-add is-open" data-llm-add-block>
          <div class="us-llm-add-head">
            <div class="us-llm-add-title">${escape(tr("us_active_llm_picker_title") || "Choose a provider")}</div>
            <button type="button" class="us-llm-add-close" data-llm-add-cancel aria-label="Cancel">✕</button>
          </div>
          <div class="us-llm-add-body">
            <div class="us-llm-multi-header">${escape(tr("us_active_llm_multi_header"))}</div>
            <div class="us-llm-picks-row us-llm-picks-multi">
              ${LLM_CARDS_MULTI.map((c) => renderPick(c, "multi")).join("")}
            </div>
            ${visibleSingle.length > 0 ? `
              <div class="us-llm-single-header">${escape(tr("us_active_llm_single_header"))}</div>
              <div class="us-llm-picks-row us-llm-picks-single">
                ${visibleSingle.map((c) => renderPick(c, "single")).join("")}
              </div>
            ` : ""}
          </div>
        </div>
      `;
    }
    // step === "key"
    const card = llmCardByProvider(_addState.provider);
    if (!card) {
      // Provider id went stale — fall back to picker.
      _addState = { step: "pick" };
      return addProviderBlockHTML();
    }
    const classification = MULTI_MODEL_LLM_PROVIDERS.indexOf(card.id) >= 0 ? "multi" : "single";
    const pitch = tr(`us_active_llm_${classification}_pitch_${card.id}`) || card.tagline || "";
    return `
      <div class="us-llm-add is-open" data-llm-add-block>
        <div class="us-llm-add-head">
          <button type="button" class="us-llm-add-back" data-llm-add-back aria-label="Back">◂</button>
          <div class="us-llm-add-title">${escape(card.label)}</div>
          <button type="button" class="us-llm-add-close" data-llm-add-cancel aria-label="Cancel">✕</button>
        </div>
        <div class="us-llm-add-body" data-llm-add-form data-provider="${escape(card.id)}">
          <div class="us-llm-add-tag">${escape(pitch)}</div>
          <div class="us-llm-add-field">
            <div class="us-llm-add-field-label">${escape(tr("us_active_llm_label_field_label") || "Name (optional)")}</div>
            <input
              type="text"
              class="us-input"
              data-llm-add-label
              placeholder="${escape(card.label)}"
              maxlength="48"
              autocomplete="off">
            <div class="us-llm-add-field-hint">${escape(tr("us_active_llm_label_field_hint") || "Leave blank to use the provider's name; duplicates get a numeric suffix.")}</div>
          </div>
          <div class="us-llm-add-field">
            <div class="us-llm-add-field-label">${escape(tr("us_active_llm_key_field_label") || "API key")}</div>
            <div class="us-input-wrap">
              <input
                type="text"
                class="us-input us-input-masked"
                data-llm-add-key
                placeholder="${escape(card.placeholder)}"
                autocomplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                data-form-type="other"
                spellcheck="false">
              <button type="button" class="us-key-eye" data-key-eye title="Show / hide">◉</button>
            </div>
            <div class="us-llm-add-field-hint">
              <a href="${escape(card.helpUrl)}" target="_blank" rel="noopener" class="us-llm-card-help">${escape(card.helpLabel)} →</a>
            </div>
          </div>
          <div class="us-llm-add-actions">
            <button type="button" class="us-btn us-btn-ghost" data-llm-add-cancel>${escape(tr("us_active_llm_cancel_btn") || "Cancel")}</button>
            <button type="button" class="us-btn us-btn-primary" data-llm-add-save>${escape(tr("us_active_llm_save_btn") || "Save & activate")}</button>
          </div>
        </div>
      </div>
    `;
  }

  /** Compose the three multi-SIM regions: hero, added list, add-block. */
  function activeLlmSectionHTML() {
    return `
      <div class="us-key-group us-key-group-llm-active">
        <div class="us-key-group-tag">${tr("us_active_llm_tag")}</div>
        <div class="us-key-group-deck">${tr("us_active_llm_deck")}</div>
        ${activeLlmHeroHTML()}
        ${addedLlmListHTML()}
        ${addProviderBlockHTML()}
      </div>
    `;
  }

  /** Shown only when BOTH Brave Search and Tavily keys are configured. */
  function webSearchBackendPrefHTML() {
    const braveOk = !!(_keysMeta.brave && _keysMeta.brave.configured);
    const tavilyOk = !!(_keysMeta.tavily && _keysMeta.tavily.configured);
    const visible = braveOk && tavilyOk;
    const pref = _prefsCache.webSearchProvider === "tavily" ? "tavily" : "brave";
    return `
        <div class="us-key-group us-key-group-ws-backend" data-us-ws-backend-wrap ${visible ? "" : "hidden"}>
          <div class="us-key-group-tag">${tr("us_ws_backend_tag")}</div>
          <div class="us-key-group-deck">${tr("us_ws_backend_deck")}</div>
          <div class="us-ws-backend-radios">
            <label class="us-ws-backend-label">
              <input type="radio" name="us-ws-backend" value="brave" ${pref === "brave" ? "checked" : ""}>
              <span>${tr("us_ws_backend_brave")}</span>
            </label>
            <label class="us-ws-backend-label">
              <input type="radio" name="us-ws-backend" value="tavily" ${pref === "tavily" ? "checked" : ""}>
              <span>${tr("us_ws_backend_tavily")}</span>
            </label>
          </div>
        </div>
    `;
  }

  /** MiniMax region picker · rendered INSIDE the minimax row so it
   *  sits next to the API key it modifies. Returns "" when no minimax
   *  key is configured (row is still rendered, just without this
   *  sub-control). */
  function minimaxRegionRowHTML() {
    const minimaxOk = !!(_keysMeta.minimax && _keysMeta.minimax.configured);
    if (!minimaxOk) return "";
    const region = (_prefsCache && _prefsCache.minimaxRegion) || "cn";
    return `
      <div class="us-key-subrow" data-us-minimax-region-wrap>
        <div class="us-key-subrow-label">MiniMax API region</div>
        <div class="us-ws-backend-radios">
          <label class="us-ws-backend-label">
            <input type="radio" name="us-minimax-region" value="cn" ${region === "cn" ? "checked" : ""}>
            <span>China (api.minimaxi.com)</span>
          </label>
          <label class="us-ws-backend-label">
            <input type="radio" name="us-minimax-region" value="intl" ${region === "intl" ? "checked" : ""}>
            <span>International (api.minimax.io)</span>
          </label>
        </div>
      </div>
    `;
  }

  function keysSectionHTML() {
    const skillProviders = PROVIDERS.filter((p) => p.group === "skill");
    const voiceProviders = PROVIDERS.filter((p) => p.group === "voice");

    return `
      <div class="us-pane-head">
        <div class="us-pane-tag">${tr("us_keys_tag")}</div>
        <div class="us-pane-deck">${tr("us_keys_deck")}</div>
      </div>

      <div class="us-pane-body">

        ${activeLlmSectionHTML()}

        ${skillProviders.length > 0 ? `
          <div class="us-key-group us-key-group-skill">
            <div class="us-key-group-tag">${tr("us_keys_group_skill")}</div>
            <div class="us-key-group-deck">${tr("us_keys_skill_deck")}</div>
            ${skillProviders.map((p) => renderKeyRow(p, !!(_keysMeta[p.id] && _keysMeta[p.id].configured))).join("")}
          </div>
        ` : ""}

        ${webSearchBackendPrefHTML()}

        ${voiceProviders.length > 0 ? `
          <div class="us-key-group us-key-group-voice">
            <div class="us-key-group-tag">Voice providers</div>
            <div class="us-key-group-deck">Used for voice meetings and per-director speech synthesis.</div>
            ${voiceProviders.map((p) => renderKeyRow(p, !!(_keysMeta[p.id] && _keysMeta[p.id].configured))).join("")}
          </div>
        ` : ""}

        <div data-models-summary>${modelsSummaryHTML()}</div>

      </div>
    `;
  }

  /* ── Available models · summary + default picker ─────────────
     Lives at the bottom of the API Key section. Hidden when the
     user has no keys configured. Re-fetched after every key
     write so the route badges and reachable count stay accurate. */
  const PROVIDER_ORDER = ["anthropic", "openai", "google", "xai", "deepseek", "zhipu", "moonshot", "openrouter", "bai"];
  const PROVIDER_LABEL = {
    anthropic: "Anthropic",
    openai:    "OpenAI",
    google:    "Google",
    xai:       "xAI",
    deepseek:  "DeepSeek",
    zhipu:     "Zhipu",
    moonshot:  "Moonshot",
    openrouter:"OpenRouter",
    bai:       "B.AI",
  };
  function providerLabel(p) { return PROVIDER_LABEL[p] || p; }

  function modelsSummaryHTML() {
    const cache = modelsSnapshot();
    if (!cache) {
      return `<div class="us-key-group us-key-group-models">
        <div class="us-key-group-tag">Available models</div>
        <div class="us-models-loading">measuring reach…</div>
      </div>`;
    }
    // Defensive · trust `reachable.length` over `hasAnyKey`. See the
    // same pattern in `defaultModelSectionHTML` · keeps the block
    // visible when the server reports a stale `hasAnyKey: false` but
    // ships a populated reachable list (B.AI-only users on an
    // un-restarted backend hit exactly this case).
    const reachable = (cache.reachable || []);
    if (reachable.length === 0) return "";

    const byProvider = new Map();
    for (const m of reachable) {
      if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
      byProvider.get(m.provider).push(m);
    }
    const providers = Array.from(byProvider.keys()).sort((a, b) => {
      const ai = PROVIDER_ORDER.indexOf(a), bi = PROVIDER_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    const blocks = providers.map((p) => {
      const models = byProvider.get(p);
      return `
        <div class="us-models-provider">
          <div class="us-models-provider-tag">${escape(providerLabel(p))}</div>
          <div class="us-models-rows">
            ${models.map((m) => `
              <div class="us-models-row">
                <span class="us-models-name">${escape(m.displayName)}</span>
                <span class="us-models-deck">${escape(m.deck || "")}</span>
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }).join("");

    // Under the single-active-LLM-provider invariant, every reachable
    // model arrives through the same active carrier. The deck reads
    // "via {provider}" once at the section head instead of a per-row
    // badge — same information, much quieter visual.
    const activeProv = cache.activeLlmProvider;
    const viaLabel = activeProv ? providerLabel(activeProv) : "";
    return `
      <div class="us-key-group us-key-group-models">
        <div class="us-key-group-tag">Available models</div>
        <div class="us-key-group-deck">${reachable.length} model${reachable.length === 1 ? "" : "s"} reachable${viaLabel ? ` via ${escape(viaLabel)}` : ""}.</div>
        <div class="us-models-list">${blocks}</div>
      </div>
    `;
  }

  /* ── Default Model section ────────────────────────────────────
     A dedicated rail tab for picking the default model the rest of
     the system inherits (new agents, fallback for unreachable
     stale-modelV agents, brief flagship tier). The same dropdown
     also lives at the bottom of the API Key section as a quick
     toggle, but here it gets a focused page with grouping by
     provider + a deck per model row + the active route badge. */
  function defaultModelSectionHTML() {
    const cache = modelsSnapshot();
    // Defensive gating · the picker should render whenever at least
    // one model is reachable. We deliberately do NOT short-circuit on
    // `!cache.hasAnyKey` alone: an older server (pre-B.AI-fix to
    // `hasAnyModelKey()`) can report `hasAnyKey: false` for a user
    // whose only key is B.AI, even though every `reachable[i]` arrives
    // populated with a working bai route. Trust `reachable.length` as
    // the real signal · cache absent or empty → loading / no-key copy;
    // cache present + reachable empty → key-but-no-route copy.
    if (!cache) {
      return `
        <div class="us-pane-head">
          <div class="us-pane-tag">▸ Default Model</div>
          <div class="us-pane-deck">measuring reach…</div>
        </div>
      `;
    }
    const reachable = cache.reachable || [];
    if (reachable.length === 0) {
      const noKey = !cache.hasAnyKey;
      return `
        <div class="us-pane-head">
          <div class="us-pane-tag">▸ Default Model</div>
          <div class="us-pane-deck">${noKey
            ? `no LLM key configured yet — add one in <a href="#" data-jump-keys class="us-link">API Key</a> first, then come back to pick a default.`
            : `your configured keys don't reach any model right now. Check the key values, or add another carrier in <a href="#" data-jump-keys class="us-link">API Key</a>.`}</div>
        </div>
      `;
    }

    // Group reachable models by provider, ordered by PROVIDER_ORDER
    // (anthropic / openai / google / xai / deepseek / zhipu / moonshot / openrouter / bai).
    const byProvider = new Map();
    for (const m of reachable) {
      if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
      byProvider.get(m.provider).push(m);
    }
    const providers = Array.from(byProvider.keys()).sort((a, b) => {
      const ai = PROVIDER_ORDER.indexOf(a), bi = PROVIDER_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    const def = cache.defaultModelV;

    const blocks = providers.map((p) => {
      const models = byProvider.get(p);
      const rows = models.map((m) => {
        const isActive = m.modelV === def;
        return `
          <button type="button"
                  class="us-default-row${isActive ? " active" : ""}"
                  data-default-pick="${escape(m.modelV)}">
            <span class="us-default-row-mark">${isActive ? "●" : "○"}</span>
            <span class="us-default-row-text">
              <span class="us-default-row-name">${escape(m.displayName)}</span>
              <span class="us-default-row-deck">${escape(m.deck || "")}</span>
            </span>
          </button>
        `;
      }).join("");
      return `
        <div class="us-default-provider">
          <div class="us-default-provider-tag">${escape(providerLabel(p))}</div>
          <div class="us-default-rows">${rows}</div>
        </div>
      `;
    }).join("");

    return `
      <div class="us-pane-head">
        <div class="us-pane-tag">${tr("us_default_tag")}</div>
        <div class="us-pane-deck">${tr("us_default_deck_long")}</div>
      </div>

      <div class="us-pane-body">
        <div class="us-default-list">${blocks}</div>
      </div>
    `;
  }

  function wireDefaultModelSection() {
    if (!paneEl) return;
    // Jump links to the API Key section when the user has no keys.
    paneEl.querySelectorAll("[data-jump-keys]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        renderSection("keys");
      });
    });
    // Click a row · save defaultModelV, repaint the section so the
    // active-row marker moves. Refresh the shared models cache too so
    // every other picker (composer / agent profile) picks up the new
    // value on its next read.
    paneEl.querySelectorAll("[data-default-pick]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        const v = btn.getAttribute("data-default-pick");
        if (!v) return;
        await saveDefaultModel(v);
        await refreshModels();
        if (currentSection === "default") renderSection("default");
      });
    });
  }

  function refreshModelsSummary() {
    if (!paneEl) return;
    const slot = paneEl.querySelector("[data-models-summary]");
    if (!slot) return;
    slot.innerHTML = modelsSummaryHTML();
    // Default-model state lives in the sidebar's "Default Model"
    // pane · this refresh used to also patch each LLM row's
    // badge / "set as default" button, but those controls were
    // removed to eliminate the duplicate flow.
  }

  /* Avatar generation · same flow as the agent profile's regenerate
     button (see agent-profile.js / regenerateProfileAvatar): each
     click pulls a fresh seed from AvatarSkill.randomSeed(), saves it
     to the user prefs (`avatarSeed`), and re-paints. The SVG is
     rendered from that seed via AvatarSkill.generate(). */
  function generateAvatar(seed) {
    return window.AvatarSkill.generate(seed);
  }

  /* ── Modal shell ──────────────────────────────────────────── */
  function modalHTML() {
    return `
      <div class="user-settings-overlay" id="user-settings-overlay" role="dialog" aria-modal="true" aria-hidden="true">
        <div class="user-settings-modal" role="document">

          <div class="us-classification">
            <span><span class="dot">●</span> <span data-i18n="us_modal_kicker_left"></span></span>
            <span class="right" data-i18n="us_modal_kicker_right"></span>
          </div>

          <button type="button" class="us-close" data-i18n-aria="us_close" aria-label="Close">✕</button>

          <div class="us-frame">
            <nav class="us-nav" role="tablist">
              <a href="#" class="us-nav-item active" data-section="user"    role="tab" aria-selected="true" data-i18n="us_nav_user"></a>
              <a href="#" class="us-nav-item"        data-section="usage"   role="tab" aria-selected="false" data-i18n="us_nav_usage"></a>
              <a href="#" class="us-nav-item"        data-section="keys"    role="tab" aria-selected="false" data-i18n="us_nav_api_key"></a>
              <a href="#" class="us-nav-item"        data-section="default" role="tab" aria-selected="false" data-i18n="us_default_model_title"></a>
              <a href="#" class="us-nav-item"        data-section="other"   role="tab" aria-selected="false" data-i18n="us_nav_other_settings"></a>
              <div class="us-nav-foot" data-us-version aria-label="App version">
                <span class="us-nav-foot-label">version</span>
                <span class="us-nav-foot-value" data-us-version-value>·</span>
              </div>
            </nav>

            <div class="us-pane" data-us-pane></div>
          </div>

          <footer class="us-foot">
            <span class="saved" data-i18n="us_foot_saved"></span>
            <div class="us-foot-right">
              <a class="us-website" href="/home.html" target="_blank" rel="noopener" data-i18n="us_foot_website"></a>
              <button type="button" class="us-done" data-i18n="us_done"></button>
            </div>
          </footer>

        </div>
      </div>
    `;
  }

  let overlay, modal, paneEl, currentSection = "user";

  function renderSection(id) {
    currentSection = id;
    if (id === "user")        paneEl.innerHTML = userSectionHTML();
    else if (id === "usage")  paneEl.innerHTML = usageSectionHTML();
    else if (id === "keys")   paneEl.innerHTML = keysSectionHTML();
    else if (id === "default") paneEl.innerHTML = defaultModelSectionHTML();
    else if (id === "other")  paneEl.innerHTML = otherSettingsSectionHTML();

    // Section-specific wiring
    if (id === "user")    wireUserSection();
    if (id === "keys")    wireKeysSection();
    if (id === "usage")   wireUsageSection();
    if (id === "default") wireDefaultModelSection();
    if (id === "other")   wireOtherSettingsSection();

    // Active rail item
    modal.querySelectorAll(".us-nav-item").forEach((el) => {
      const on = el.dataset.section === id;
      el.classList.toggle("active", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  function paintUserAvatar() {
    const frame = paneEl.querySelector("[data-us-avatar]");
    if (!frame) return;
    const u = getUser();
    // Mirror the agent profile flow · the avatar is whatever seed is
    // saved on the user prefs. If none has ever been generated, mint
    // one now so the avatar is stable across reloads.
    let seed = u.avatarSeed;
    if (!seed && window.AvatarSkill) {
      seed = window.AvatarSkill.randomSeed();
      saveUser({ avatarSeed: seed });
      // Cascade the freshly-minted seed to app.prefs so the sidebar
      // foot picks it up on the same paint.
      if (window.app) {
        window.app.prefs = { ...(window.app.prefs || {}), avatarSeed: seed };
        if (typeof window.app.renderUserBlock === "function") window.app.renderUserBlock();
      }
    }
    frame.innerHTML = generateAvatar(seed || "default");
  }

  function wireUserSection() {
    const nameInput  = paneEl.querySelector("[data-us-name]");
    const introInput = paneEl.querySelector("[data-us-intro]");
    const introCount = paneEl.querySelector("[data-us-intro-count]");

    function persist() {
      const u = { name: nameInput.value.trim() || "Kay", intro: introInput.value };
      saveUser(u);
      // Refresh app state + redraw sidebar foot via the central renderer.
      if (window.app) {
        window.app.prefs = { ...(window.app.prefs || {}), ...u };
        if (typeof window.app.renderUserBlock === "function") window.app.renderUserBlock();
      } else {
        document.querySelectorAll(".sidebar-foot .user-name").forEach((el) => { el.textContent = (u.name || "Kay").toUpperCase(); });
      }
    }

    nameInput.addEventListener("input", persist);
    introInput.addEventListener("input", () => {
      introCount.textContent = introInput.value.length;
      persist();
    });
    introCount.textContent = introInput.value.length;

    // Regenerate avatar · same pattern as agent-profile's
    // regenerateProfileAvatar: pull a fresh randomSeed, persist it to
    // the user prefs, repaint. No counter, no name/intro composition —
    // the seed is the only thing that determines the avatar.
    paneEl.querySelector("[data-us-regen-avatar]").addEventListener("click", (e) => {
      e.preventDefault();
      if (!window.AvatarSkill) return;
      const seed = window.AvatarSkill.randomSeed();
      saveUser({ avatarSeed: seed });
      paintUserAvatar();
      // Push the new seed into app.prefs so the sidebar foot's user
      // avatar repaints with the same SVG. Without this, the settings
      // overlay shows the new face but the sidebar keeps the old one
      // until the next reload.
      if (window.app) {
        window.app.prefs = { ...(window.app.prefs || {}), avatarSeed: seed };
        if (typeof window.app.renderUserBlock === "function") window.app.renderUserBlock();
      }
    });

    paintUserAvatar();
  }

  function rerenderKeysSection() {
    paneEl.innerHTML = keysSectionHTML();
    wireKeysSection();
  }

  function wireKeysSection() {
    // Show/hide toggle · the input is permanently `type="text"` so
    // browsers don't trigger their "Save password?" popup when the
    // user navigates away from a typed-in key (e.g., clicking another
    // sidebar tab in user prefs). Masking is done via the CSS
    // `-webkit-text-security: disc` rule on `.us-input-masked` —
    // visually identical to a password input but invisible to
    // password managers. Toggle = add/remove the masking class.
    paneEl.querySelectorAll("[data-key-eye]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const input = btn.parentElement.querySelector("input");
        if (input) input.classList.toggle("us-input-masked");
      });
    });

    // ✕ on voice / skill rows · server-side DELETE, then re-render.
    paneEl.querySelectorAll(".us-key-remove[data-remove-provider]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
        const id = btn.dataset.removeProvider;
        if (!id) return;
        await setProviderKey(id, "");
        await refreshModels();
        rerenderKeysSection();
      });
    });

    // ✕ on credential rows · DELETE /api/credentials/:id. If the
    // credential is the currently active one, pop a confirm() first
    // (matches the user's explicit ask: "删除后将无法正常使用").
    paneEl.querySelectorAll(".us-key-remove[data-remove-credential]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
        const id = btn.dataset.removeCredential;
        if (!id) return;
        const isActive = id === activeLlmCredentialId();
        if (isActive) {
          const msg = tr("us_active_llm_delete_active_confirm")
            || "Removing the active provider — the boardroom will fall back to the next added provider, or stop working until you add a new one. Continue?";
          if (!window.confirm(msg)) return;
        }
        const ok = window.keysStore && typeof window.keysStore.deleteLlmCredentialRequest === "function"
          ? await window.keysStore.deleteLlmCredentialRequest(id)
          : false;
        if (!ok) return;
        await fetchLlmCredentials();
        await refreshModels();
        rerenderKeysSection();
      });
    });

    // Credential row tap · switch which credential is active. Clicks
    // on the inner ✕ are caught + stopPropagation'd by the remove
    // handler above, so this handler only fires on the body.
    paneEl.querySelectorAll("[data-llm-row]").forEach((row) => {
      const handler = async (e) => {
        if (e.target && e.target.closest && e.target.closest("button")) return;
        if (row.classList.contains("is-active")) return;
        const id = row.dataset.credentialId;
        if (!id) return;
        // Confirm switch · agents reconcile to the new provider's
        // fast-pool, so the visible cast of director model badges
        // changes. Showing a confirm keeps the swap intentional.
        const target = listLlmCredentials().find((c) => c.id === id);
        const targetLabel = target ? target.label : "";
        const tmpl = tr("us_active_llm_switch_confirm")
          || "Switch active LLM provider to {label}? Every director will be reassigned to the new provider's models.";
        const msg = tmpl.replace("{label}", targetLabel);
        if (!window.confirm(msg)) return;
        const ok = window.keysStore && typeof window.keysStore.setActiveLlmCredentialRequest === "function"
          ? await window.keysStore.setActiveLlmCredentialRequest(id)
          : false;
        if (!ok) return;
        await fetchLlmCredentials();
        await refreshModels();
        rerenderKeysSection();
      };
      row.addEventListener("click", handler);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handler(e);
        }
      });
    });

    // Add-provider block · "+ Add" trigger.
    paneEl.querySelectorAll("[data-llm-add-open]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        _addState = { step: "pick" };
        rerenderKeysSection();
      });
    });

    // Picker → key step.
    paneEl.querySelectorAll("[data-llm-pick]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const provider = btn.dataset.llmPick;
        if (!provider) return;
        _addState = { step: "key", provider };
        rerenderKeysSection();
        // Auto-focus the key input after re-render.
        setTimeout(() => {
          const input = paneEl.querySelector("[data-llm-add-key]");
          if (input) input.focus();
        }, 0);
      });
    });

    // Back to picker (key step → pick step).
    paneEl.querySelectorAll("[data-llm-add-back]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        _addState = { step: "pick" };
        rerenderKeysSection();
      });
    });

    // Cancel the whole add-provider flow.
    paneEl.querySelectorAll("[data-llm-add-cancel]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        _addState = null;
        rerenderKeysSection();
      });
    });

    // Save the key from the key-step form. Server creates a new
    // credential + auto-activates; on success we clear add-state and
    // re-render so the new row shows in the list with ✓ and the hero
    // card flips to the new credential.
    paneEl.querySelectorAll("[data-llm-add-save]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        const form = paneEl.querySelector("[data-llm-add-form]");
        if (!form) return;
        const provider = form.dataset.provider;
        const labelInput = form.querySelector("[data-llm-add-label]");
        const keyInput = form.querySelector("[data-llm-add-key]");
        const label = labelInput ? labelInput.value.trim() : "";
        const key = keyInput ? keyInput.value.trim() : "";
        if (!provider || !key) {
          if (keyInput) keyInput.focus();
          return;
        }
        btn.disabled = true;
        const created = window.keysStore && typeof window.keysStore.createLlmCredentialRequest === "function"
          ? await window.keysStore.createLlmCredentialRequest(provider, label, key)
          : null;
        btn.disabled = false;
        if (!created) {
          alert(tr("us_active_llm_save_failed") || "Could not save the credential — check the key and try again.");
          return;
        }
        _addState = null;
        await fetchLlmCredentials();
        await refreshModels();
        rerenderKeysSection();
      });
    });

    // Enter inside the key input triggers save (parity with the
    // onboarding paste UX).
    paneEl.querySelectorAll("[data-llm-add-key]").forEach((input) => {
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const saveBtn = paneEl.querySelector("[data-llm-add-save]");
        if (saveBtn) saveBtn.click();
      });
    });

    // Default-model controls live in the sidebar's "Default Model"
    // pane only · the previous in-row "set as default" button and
    // the bottom-of-pane Default Model picker were removed because
    // they duplicated that flow.

    // Auto-save: every keystroke / paste persists immediately, no Save button.
    // We debounce slightly so we don't fire a server PUT on every character —
    // 220ms after the user stops typing. Empty value is a no-op (NOT a
    // delete) — browser autofill / blur events occasionally fire `input`
    // with v="", and we never want that to wipe a real key. Explicit
    // removal goes through the ✕ button.
    const debounceMap = new WeakMap();
    function persistRow(wrap) {
      const provider = wrap.dataset.provider;
      const input = wrap.querySelector("[data-key-input]");
      if (!provider || !input) return;
      const v = input.value;
      const trimmed = v.trim();

      // No-op on empty · never DELETE via the input field. The ✕ button
      // is the only path that clears a key.
      if (!trimmed) return;

      // Optimistic status pill update (only voice / skill rows carry
      // [data-status] — LLM add-cards re-render after the save lands,
      // so they don't need the inline tweak).
      const status = wrap.querySelector("[data-status]");
      if (status) {
        status.classList.add("on");
        status.classList.remove("off");
        status.textContent = "● configured";
      }

      const prev = debounceMap.get(wrap);
      if (prev) clearTimeout(prev);
      const timer = setTimeout(async () => {
        await setProviderKey(provider, v);
        await refreshModels();
        // For LLM provider keys the server also flips
        // `prefs.active_llm_provider` to this provider (paste = use).
        // Re-render moves the just-pasted card into the "Added
        // providers" list with ✓ and updates the hero card.
        rerenderKeysSection();
      }, 220);
      debounceMap.set(wrap, timer);
    }

    // Bind voice / skill rows · LLM keys flow through the dedicated
    // two-step add-provider block above (POST /api/credentials), not
    // through this debounced PUT path.
    paneEl.querySelectorAll(".us-key-row").forEach((wrap) => {
      const input = wrap.querySelector("[data-key-input]");
      if (!input) return;
      input.addEventListener("input", () => persistRow(wrap));
      input.addEventListener("paste", () => {
        setTimeout(() => persistRow(wrap), 0);
      });
    });

    function syncWsBackendPicker() {
      const wrap = paneEl.querySelector("[data-us-ws-backend-wrap]");
      if (!wrap) return;
      const braveOk = !!(_keysMeta.brave && _keysMeta.brave.configured);
      const tavilyOk = !!(_keysMeta.tavily && _keysMeta.tavily.configured);
      wrap.hidden = !(braveOk && tavilyOk);
      const pref = _prefsCache.webSearchProvider === "tavily" ? "tavily" : "brave";
      wrap.querySelectorAll("input[name=\"us-ws-backend\"]").forEach((inp) => {
        inp.checked = inp.value === pref;
      });
    }

    paneEl.querySelectorAll("input[name=us-ws-backend]").forEach((input) => {
      input.addEventListener("change", async () => {
        if (!input.checked) return;
        const v = input.value === "tavily" ? "tavily" : "brave";
        _prefsCache = { ..._prefsCache, webSearchProvider: v };
        try {
          await fetch("/api/prefs", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ webSearchProvider: v }),
          });
        } catch (_) { /* offline · prefs stay in _prefsCache */ }
      });
    });

    paneEl.querySelectorAll("input[name=us-minimax-region]").forEach((input) => {
      input.addEventListener("change", async () => {
        if (!input.checked) return;
        const v = input.value === "intl" ? "intl" : "cn";
        _prefsCache = { ..._prefsCache, minimaxRegion: v };
        try {
          await fetch("/api/prefs", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ minimaxRegion: v }),
          });
        } catch (_) { /* offline */ }
      });
    });

    syncWsBackendPicker();

    // First render of the section · the shared cache may already
    // have a snapshot (models-cache.js fetches at module load). If
    // not, kick off a refresh and update the summary when it lands.
    // Either way, subsequent key-write paths refresh the cache, and
    // the inline pill refresh below picks up the new state.
    if (!modelsSnapshot()) {
      refreshModels().then(refreshModelsSummary);
    }

    // Always re-fetch /api/keys on every keys-tab open. The bootstrap
    // fetchKeyMeta runs once at page load, but the user can land on
    // settings before that resolves, OR can open settings a long time
    // after — either way `_keysMeta` may be empty / stale and the
    // status pills come up "○ not set" even when the server has a key.
    // The cheap GET keeps this tab honest. We update the pills + the
    // input placeholder INLINE (no full rerender) so the user's
    // typing-in-progress isn't disturbed and so we don't loop through
    // wireKeysSection again.
    // Fetch both surfaces in parallel · keysMeta covers voice / skill,
    // llmCredentials covers the multi-instance LLM list. Either being
    // stale after onboarding causes the same "no row shown" symptom.
    Promise.all([fetchKeyMeta(), fetchLlmCredentials()]).then(() => {
      if (currentSection !== "keys") return;

      // After-onboarding sync · if the credential set has shifted
      // since render time, rebuild the section so the hero +
      // added-list reflect the truth.
      const heroEl = paneEl.querySelector("[data-llm-hero]");
      const renderedCredId = heroEl ? heroEl.dataset.credentialId : null;
      if (renderedCredId !== activeLlmCredentialId()) {
        rerenderKeysSection();
        return;
      }

      paneEl.querySelectorAll(".us-key-row").forEach((row) => {
        const provider = row.dataset.provider;
        const meta = _keysMeta[provider];
        const has = !!(meta && meta.configured);
        const status = row.querySelector("[data-status]");
        if (!status) return;
        if (has) {
          status.classList.add("on");
          status.classList.remove("off");
          status.textContent = "● configured";
        } else {
          status.classList.add("off");
          status.classList.remove("on");
          status.textContent = "○ not set";
        }
        // Refresh placeholder using the masked preview · "sk-or…YjNH ·
        // paste to replace" when configured, the provider's hint when
        // not. Skip if user has typed something so we don't clobber
        // their in-progress edit. Toggle the .has-preview class so the
        // placeholder picks up the "real-value" colour rather than the
        // dim hint colour — the user reads it as their stored key,
        // not as missing text.
        const input = row.querySelector("[data-key-input]");
        if (input && !input.value) {
          const provDef = PROVIDERS.find((p) => p.id === provider);
          const preview = has && meta.preview ? meta.preview : null;
          input.placeholder = has
            ? (preview || "••••••••")
            : (provDef ? provDef.placeholder : "");
          input.classList.toggle("has-preview", has);
        }
      });
      syncWsBackendPicker();
    });
  }

  /* ── Open / close ─────────────────────────────────────────── */
  function open() {
    if (!overlay) return;
    renderSection(currentSection || "user");
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    // Lazy-fetch the version string on each open. Cheap (one tiny
    // request, no DB hit) and the user expects the foot to reflect
    // the running server, not a baked-in client constant — if they
    // upgrade the npm package and a tab is still open, the next
    // overlay open shows the new version.
    fetchAppVersion();
  }

  async function fetchAppVersion() {
    const slot = overlay && overlay.querySelector("[data-us-version-value]");
    if (!slot) return;
    // No cache · every overlay open hits /api/version so a dev-server
    // restart (npm version bump + new build) reflects immediately
    // in the foot without requiring a hard reload. The call is one
    // tiny round-trip with no DB hit, so it's cheap to repeat.
    try {
      const r = await fetch("/api/version", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      if (j && typeof j.version === "string") {
        slot.textContent = `v${j.version}`;
      }
    } catch { /* swallow · the foot just stays at "·" if offline */ }
  }
  async function close() {
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    // Sync app.keys + app.agentsById with whatever the user just
    // configured · the requireModelKey gate, hasAnyVoiceKey, and the
    // agent profile's voice block all read from these caches. Both
    // refreshes must complete BEFORE we fire refreshAgentProfileSkills
    // — otherwise the re-render reads stale state and the locked
    // voice card persists until the next page reload, and any voices
    // auto-assigned server-side on a 0→1 voice-key transition won't
    // surface until then either. Run the two fetches in parallel.
    const ops = [];
    if (window.app && typeof window.app.refreshKeys === "function") {
      ops.push(window.app.refreshKeys());
    }
    if (window.app && typeof window.app.refreshAgents === "function") {
      ops.push(window.app.refreshAgents());
    }
    try { await Promise.all(ops); } catch { /* swallow · stale state is recoverable */ }

    // If an agent profile is open, its skill rows have data-key-
    // configured cached from first paint and the voice section may
    // be showing the locked card. Re-fetch / re-render so both the
    // web-search toggle and the voice picker reflect the new state
    // immediately, no manual refresh required.
    if (typeof window.refreshAgentProfileSkills === "function") {
      window.refreshAgentProfileSkills();
    }
  }

  function init() {
    if (document.getElementById("user-settings-overlay")) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = modalHTML().trim();
    document.body.appendChild(wrap.firstChild);
    overlay = document.getElementById("user-settings-overlay");
    modal   = overlay.querySelector(".user-settings-modal");
    paneEl  = modal.querySelector("[data-us-pane]");
    if (window.I18n && typeof window.I18n.applyDom === "function") {
      window.I18n.applyDom(overlay);
    }

    document.addEventListener("boardroom:locale", () => {
      if (overlay && window.I18n && typeof window.I18n.applyDom === "function") {
        window.I18n.applyDom(overlay);
      }
      if (overlay && overlay.classList.contains("open")) renderSection(currentSection);
    });
    overlay.querySelector(".us-close").addEventListener("click", close);
    modal.querySelector(".us-done").addEventListener("click", (e) => { e.preventDefault(); close(); });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.classList.contains("open")) {
        e.stopImmediatePropagation();
        close();
      }
    });

    // Trigger anywhere on the page
    document.addEventListener("click", (e) => {
      if (e.target.closest("[data-user-settings-trigger]")) {
        e.preventDefault();
        open();
      }
    });

    // Rail nav
    modal.addEventListener("click", (e) => {
      const item = e.target.closest(".us-nav-item");
      if (!item) return;
      e.preventDefault();
      renderSection(item.dataset.section);
    });

    // Cross-tab sync for the appearance segmented control · the
    // FOUC bootstrap in index.html / home.html re-applies data-theme on
    // a `storage` event already; this listener only refreshes the
    // segmented-control's active state when the "Other settings" pane
    // happens to be open.
    window.addEventListener("storage", (e) => {
      if (e.key !== APPEARANCE_KEY || !e.newValue) return;
      if (!paneEl || currentSection !== "other") return;
      const group = paneEl.querySelector("[data-us-appearance]");
      if (!group) return;
      group.querySelectorAll(".us-seg-btn").forEach((el) => {
        const on = el.dataset.appearance === e.newValue;
        el.classList.toggle("active", on);
        el.setAttribute("aria-checked", on ? "true" : "false");
      });
    });

    // Initial pane
    renderSection("user");
  }

  // Public
  window.openUserSettings  = function (opts) {
    if (!overlay) init();
    open();
    // Optional deep-link · jump to a section + focus a key row.
    // Used by agent-profile's "Configure key" link on the web-search row.
    if (opts && typeof opts === "object") {
      if (typeof opts.section === "string") {
        renderSection(opts.section);
        if (opts.section === "keys" && typeof opts.focusProvider === "string") {
          // Defer one frame so the section's DOM is in place.
          setTimeout(() => {
            const row = paneEl.querySelector(`.us-key-row[data-provider="${opts.focusProvider}"]`);
            if (!row) return;
            row.scrollIntoView({ behavior: "smooth", block: "center" });
            row.classList.add("us-key-row-flash");
            setTimeout(() => row.classList.remove("us-key-row-flash"), 1500);
            const input = row.querySelector("input[data-key-input]");
            if (input) input.focus();
          }, 60);
        }
      }
    }
  };
  window.closeUserSettings = close;

  // Bootstrap: prefetch prefs and key meta so the first render has real
  // values, then init.
  async function bootstrap() {
    await Promise.all([fetchPrefs(), fetchKeyMeta()]);
    init();
    // Mirror name into sidebar foot once we know it.
    document.querySelectorAll(".sidebar-foot .user-name").forEach((el) => {
      el.textContent = (_prefsCache.name || "You").toUpperCase();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
