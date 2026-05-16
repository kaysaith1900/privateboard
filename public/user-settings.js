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

  const PROVIDERS = [
    { id: "openrouter", label: "OpenRouter",  hint: "default · routes any model · sk-or-…",         placeholder: "sk-or-v1-…",  group: "llm" },
    { id: "anthropic",  label: "Anthropic",   hint: "Claude · Sonnet 4.6, Opus 4.7, Haiku 4.5",      placeholder: "sk-ant-…",     group: "llm" },
    { id: "openai",     label: "OpenAI",      hint: "GPT · gpt-5, gpt-5 mini, gpt-4o",                placeholder: "sk-…",         group: "llm" },
    { id: "google",     label: "Google",      hint: "Gemini · 2.5 Pro, 2.5 Flash",                    placeholder: "AIza…",        group: "llm" },
    { id: "xai",        label: "xAI",         hint: "Grok · grok-4.3, grok-4.1 fast",                  placeholder: "xai-…",        group: "llm" },
    { id: "minimax",    label: "MiniMax",     hint: "speech · T2A voices, cloning, streaming audio",   placeholder: "mm-…",         group: "voice" },
    { id: "elevenlabs", label: "ElevenLabs",  hint: "text-to-speech · pricing & docs at elevenlabs.io",  placeholder: "xi-…",         group: "voice" },
    // ── Skill Services (not LLM providers, but the same encrypted key store) ──
    { id: "brave",      label: "Brave Search", hint: "powers the Web Search system skill · ≈ $5 / 1000 queries · privacy-respecting",
      placeholder: "BSA…",         group: "skill" },
    { id: "tavily",     label: "Tavily Search", hint: "alternate Web Search backend · billed per Tavily credits · LLM-focused results",
      placeholder: "tvly-…",        group: "skill" },
  ];

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

  // LLM-provider IDs only (excludes Skill Services like Brave — those
  // live in their own pinned subgroup and aren't subject to the
  // "+ add provider" flow).
  const LLM_PROVIDER_IDS = PROVIDERS.filter((p) => p.group === "llm").map((p) => p.id);
  const SKILL_PROVIDER_IDS = PROVIDERS.filter((p) => p.group === "skill").map((p) => p.id);
  const VOICE_PROVIDER_IDS = PROVIDERS.filter((p) => p.group === "voice").map((p) => p.id);

  function ensureActiveProviders() {
    if (activeProviders === null) {
      // Only show rows for providers the user has actually configured.
      // Unconfigured providers (incl. OpenRouter) live behind the
      // "+ add provider" chips so the panel reflects what's really
      // wired up rather than projecting an empty OpenRouter row onto
      // a user who never picked it during onboarding.
      activeProviders = LLM_PROVIDER_IDS.filter(
        (k) => _keysMeta[k] && _keysMeta[k].configured,
      );
    }
  }

  function renderKeyRow(p, removable) {
    const meta = _keysMeta[p.id];
    const has = !!(meta && meta.configured);
    // The server never returns plaintext, but it does return a 4+4
    // masked preview of the stored key (e.g. "sk-or…YjNH"). Surfacing
    // it as the placeholder lets the user verify which key is in which
    // slot — a real failure mode we hit when the OpenRouter slot
    // silently held a Brave key. When configured we show the preview
    // alone (no "paste to replace" hint — the row is clearly populated
    // and pasting overwrites by default); when empty we show the
    // provider's normal hint.
    const preview = has && meta.preview ? meta.preview : null;
    const placeholder = has
      ? (preview || "••••••••")
      : p.placeholder;
    // Default-model selection lives entirely in the dedicated
    // "Default Model" sidebar pane. The previous in-row "default"
    // badge + "set as default" button on each LLM provider was a
    // duplicate UX that also competed with the bottom-of-pane
    // "Default model" picker · all three controls did the same
    // thing. The single source of truth is now the sidebar pane.
    return `
      <div class="us-key-row" data-provider="${p.id}">
        <div class="us-key-head">
          <div class="us-key-label">${escape(p.label)}</div>
          <div class="us-key-status ${has ? "on" : "off"}" data-status>${has ? "● configured" : "○ not set"}</div>
          ${(() => {
            if (!removable) return "";
            // Last-LLM guardrail · matches the server's DELETE check.
            // Block removal of the ONE configured LLM key so the boardroom
            // never lands in "no usable carrier" state. Unconfigured rows
            // (or non-LLM providers) bypass the lock — removing them
            // doesn't reduce working-key count.
            const isLLM = p.group === "llm";
            const isConfigured = !!(_keysMeta[p.id] && _keysMeta[p.id].configured);
            const llmConfiguredCount = LLM_PROVIDER_IDS.filter(
              (id) => _keysMeta[id] && _keysMeta[id].configured,
            ).length;
            const lock = isLLM && isConfigured && llmConfiguredCount <= 1;
            return lock
              ? `<button type="button" class="us-key-remove is-locked" disabled title="Add another LLM key first — at least one must remain configured.">✕</button>`
              : `<button type="button" class="us-key-remove" data-remove-provider="${p.id}" title="Remove">✕</button>`;
          })()}
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

  function minimaxRegionPrefHTML() {
    const minimaxOk = !!(_keysMeta.minimax && _keysMeta.minimax.configured);
    if (!minimaxOk) return "";
    const region = (_prefsCache && _prefsCache.minimaxRegion) || "cn";
    return `
        <div class="us-key-group us-key-group-minimax-region" data-us-minimax-region-wrap>
          <div class="us-key-group-tag">MiniMax API region</div>
          <div class="us-key-group-deck">Select the region matching your API key source.</div>
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
    ensureActiveProviders();
    // Anthropic is temporarily excluded from the "+ add provider"
    // chips · only sonnet-4-6 is direct-routable on the Anthropic SDK
    // right now (opus / haiku are openrouterOnly), so adding an
    // Anthropic key alone unlocks just one model — confusing UX. Once
    // the registry has ≥ 2 direct-routable Claude models, drop the
    // exclusion. Existing users who already configured Anthropic still
    // see their row (activeProviders preserves them). */
    const HIDDEN_FROM_ADD = new Set(["anthropic"]);
    const addable = PROVIDERS.filter(
      (p) => p.group === "llm" && !HIDDEN_FROM_ADD.has(p.id) && !activeProviders.includes(p.id),
    );
    const skillProviders = PROVIDERS.filter((p) => p.group === "skill");
    const voiceProviders = PROVIDERS.filter((p) => p.group === "voice");

    return `
      <div class="us-pane-head">
        <div class="us-pane-tag">${tr("us_keys_tag")}</div>
        <div class="us-pane-deck">${tr("us_keys_deck")}</div>
      </div>

      <div class="us-pane-body">

        <div class="us-key-group">
          <div class="us-key-group-tag">${tr("us_keys_group_llm")}</div>
          ${activeProviders.map((id) => {
            const p = PROVIDERS.find((x) => x.id === id);
            if (!p) return "";
            return renderKeyRow(p, true);
          }).join("")}
          ${addable.length > 0 ? `
            <div class="us-key-add">
              <span class="us-key-add-label">${tr("us_keys_add_label")}</span>
              <div class="us-key-add-chips">
                ${addable.map((p) => `
                  <button type="button" class="us-key-add-chip" data-add-provider="${p.id}">${escape(p.label)}</button>
                `).join("")}
              </div>
            </div>
          ` : ""}
        </div>

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

        ${minimaxRegionPrefHTML()}

        <div data-models-summary>${modelsSummaryHTML()}</div>

      </div>
    `;
  }

  /* ── Available models · summary + default picker ─────────────
     Lives at the bottom of the API Key section. Hidden when the
     user has no keys configured. Re-fetched after every key
     write so the route badges and reachable count stay accurate. */
  const PROVIDER_ORDER = ["anthropic", "openai", "google", "xai", "deepseek", "openrouter"];
  const PROVIDER_LABEL = {
    anthropic: "Anthropic",
    openai:    "OpenAI",
    google:    "Google",
    xai:       "xAI",
    deepseek:  "DeepSeek",
    openrouter:"OpenRouter",
  };
  function providerLabel(p) { return PROVIDER_LABEL[p] || p; }

  function routeBadgeHTML(m) {
    const d = !!(m.routes && m.routes.direct);
    const o = !!(m.routes && m.routes.openrouter);
    if (d && o) return `<span class="us-models-route">direct · OR</span>`;
    if (d) return `<span class="us-models-route">direct</span>`;
    if (o) return `<span class="us-models-route">OR</span>`;
    return "";
  }

  function modelsSummaryHTML() {
    const cache = modelsSnapshot();
    if (!cache) {
      return `<div class="us-key-group us-key-group-models">
        <div class="us-key-group-tag">Available models</div>
        <div class="us-models-loading">measuring reach…</div>
      </div>`;
    }
    if (!cache.hasAnyKey) return "";
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
                ${routeBadgeHTML(m)}
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }).join("");

    // Default-model selection moved to the sidebar's "Default Model"
    // pane · the previous bottom-of-pane select duplicated that flow.
    // The Available Models block is now read-only (which models are
    // reachable + how they route), nothing else.
    return `
      <div class="us-key-group us-key-group-models">
        <div class="us-key-group-tag">Available models</div>
        <div class="us-key-group-deck">${reachable.length} model${reachable.length === 1 ? "" : "s"} reachable across ${providers.length} provider${providers.length === 1 ? "" : "s"}. <code>direct</code> uses the provider key, <code>OR</code> routes through OpenRouter.</div>
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
    if (!cache || !cache.hasAnyKey) {
      return `
        <div class="us-pane-head">
          <div class="us-pane-tag">▸ Default Model</div>
          <div class="us-pane-deck">no LLM key configured yet — add one in <a href="#" data-jump-keys class="us-link">API Key</a> first, then come back to pick a default.</div>
        </div>
      `;
    }
    const reachable = cache.reachable || [];
    if (reachable.length === 0) {
      return `
        <div class="us-pane-head">
          <div class="us-pane-tag">▸ Default Model</div>
          <div class="us-pane-deck">your configured keys don't reach any model right now. Check the key values, or add another carrier in <a href="#" data-jump-keys class="us-link">API Key</a>.</div>
        </div>
      `;
    }

    // Group reachable models by provider, ordered by PROVIDER_ORDER
    // (anthropic / openai / google / xai / deepseek / openrouter).
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
            ${routeBadgeHTML(m)}
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
  let activeProviders = null; // populated lazily from saved keys; reset on each open

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

    // Add a provider row
    paneEl.querySelectorAll("[data-add-provider]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const id = btn.dataset.addProvider;
        if (!activeProviders.includes(id)) activeProviders.push(id);
        rerenderKeysSection();
      });
    });

    // Remove a provider row (server-side delete clears its key too).
    paneEl.querySelectorAll("[data-remove-provider]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        const id = btn.dataset.removeProvider;
        activeProviders = activeProviders.filter((p) => p !== id);
        await setProviderKey(id, ""); // clears server-side
        await refreshModels();
        rerenderKeysSection();
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
    function persistRow(row) {
      const provider = row.dataset.provider;
      const input = row.querySelector("[data-key-input]");
      const v = input.value;
      const trimmed = v.trim();

      // No-op on empty · never DELETE via the input field. The ✕ button
      // is the only path that clears a key. This protects against
      // autofill races + accidental select-all+delete.
      if (!trimmed) return;

      // Optimistic local UI update on non-empty input.
      const status = row.querySelector("[data-status]");
      status.classList.add("on");
      status.classList.remove("off");
      status.textContent = "● configured";

      // Debounced server write
      const prev = debounceMap.get(row);
      if (prev) clearTimeout(prev);
      const timer = setTimeout(async () => {
        await setProviderKey(provider, v);
        await refreshModels();
        refreshModelsSummary();
        syncWsBackendPicker();
      }, 220);
      debounceMap.set(row, timer);
    }

    paneEl.querySelectorAll(".us-key-row").forEach((row) => {
      const input = row.querySelector("[data-key-input]");
      if (!input) return;
      input.addEventListener("input", () => persistRow(row));
      // Paste handler — input fires after paste too, but this is explicit
      // and lets us snap-update the status pill on the same tick.
      input.addEventListener("paste", () => {
        // paste mutates value asynchronously; defer one tick
        setTimeout(() => persistRow(row), 0);
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
    fetchKeyMeta().then(() => {
      if (currentSection !== "keys") return;

      // After-onboarding sync · the bootstrap fetchKeyMeta ran before
      // the user wrote their first key (during onboarding). When the
      // user opens settings without a page refresh, _keysMeta was
      // empty at first render, so activeProviders was derived without
      // the just-configured provider — and the keys tab paints with
      // no row for it (e.g. "no OpenRouter section visible until
      // refresh"). Detect that drift here and rebuild the section
      // when a configured provider is missing its row. Inline pill
      // refresh below handles the simpler case where the row already
      // exists and only its `● configured` state needs flipping.
      const missingActive = LLM_PROVIDER_IDS.filter(
        (id) => _keysMeta[id] && _keysMeta[id].configured && !activeProviders.includes(id),
      );
      if (missingActive.length > 0) {
        activeProviders = null;
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
    activeProviders = null; // re-derive from saved keys on next render
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
