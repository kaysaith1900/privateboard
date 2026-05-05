/* ═══════════════════════════════════════════
   ONBOARDING · first-run wizard
   ═══════════════════════════════════════════
   Boots before app.init: detects first-run state, blocks the dashboard
   until the user has a name + a configured key. After completion, marks
   localStorage["boardroom.onboarded"] so subsequent boots skip.

   Steps:
     0  welcome / name
     1  theme
     2  api key (OpenRouter, the simplest path)
     3  done · choose to seed a demo room or convene fresh

   Each step persists immediately (PUT /api/prefs · PUT /api/keys/openrouter).
*/
(function () {
  const ONBOARDED_KEY = "boardroom.onboarded";

  const THEMES = [
    { slug: "regent",      name: "Regent",      desc: "warm gold on dark · default",
      swatches: ["#0A0A0A","#131312","#C9A46B","#9A7B40","#A57843","#B5706A","#6A9B97","#C8C5BE"] },
    { slug: "eastwood",    name: "Eastwood",    desc: "calm forest green",
      swatches: ["#0A0A0A","#131312","#6FB572","#427A48","#B59560","#B5706A","#6A9B97","#C8C5BE"] },
    { slug: "atrium",      name: "Atrium",      desc: "warm paper · daylight",
      swatches: ["#FBFBF7","#F4F2EC","#2E7D32","#1B5E20","#A86C2A","#A8403D","#2E7D7A","#1F1E1A"] },
    { slug: "pinterest",   name: "Pinterest",   desc: "clean white · red accent",
      swatches: ["#FFFFFF","#FAFAFA","#E60023","#AD081B","#F4A100","#E60023","#2E7D7A","#111111"] },
    { slug: "apple",       name: "Apple",       desc: "pure white · system blue",
      swatches: ["#FFFFFF","#F5F5F7","#0071E3","#0051A8","#FF9500","#FF3B30","#5AC8FA","#1D1D1F"] },
    { slug: "alanpeabody", name: "Alan Peabody", desc: "cool blue · git-green accents",
      swatches: ["#0E1419","#131A21","#6BAFE0","#3F7AAA","#C8A463","#D67373","#6FB5A8","#C8D0DA"] },
    { slug: "amuse",       name: "Amuse",       desc: "magenta + cyan · playful",
      swatches: ["#1A0E14","#21121A","#D67BC0","#9C4884","#DCBE5D","#E07F84","#6FBFC2","#DECBD2"] },
    { slug: "jtriley",     name: "JTriley",     desc: "bright lime + yellow",
      swatches: ["#0A0F0A","#131914","#B5DA40","#6E8E27","#F0CC4E","#D67762","#6FBE9A","#C8D6BE"] },
    { slug: "nebirhos",    name: "Nebirhos",    desc: "teal · warm orange",
      swatches: ["#0A1414","#11201F","#5EB1A6","#357770","#DD9258","#D87060","#6FBEC2","#B8D4D0"] },
    { slug: "wedisagree",  name: "We Disagree", desc: "argumentative orange",
      swatches: ["#14110E","#1F1A14","#DD7B40","#A8521E","#E6B872","#E26060","#6FB28A","#D8CBBC"] }
  ];

  const DEMO_AGENTS = ["socrates", "first-principles", "value-investor"];
  const NAMES = {
    "socrates": "Socrates",
    "first-principles": "First Principles",
    "value-investor": "Value Investor",
    "user-empathy": "User-Empathy",
    "long-horizon": "Long Horizon",
    "phenomenologist": "Phenomenologist",
  };
  // Recommended seed questions for first-run users. Concrete, current
  // 2026-shaped scenarios — the kind of decision a builder/operator
  // actually loses sleep over — so the boardroom's value (three lenses
  // pressuring one decision) lands in the first turn. Each cast is
  // hand-picked so the lenses fit the question.
  const STARTER_QUESTIONS = [
    {
      tag: "// ai-startup",
      text: "OpenAI and Anthropic keep launching everything — does my AI startup still have a real shot in 2026?",
      hint: "skeptic + pattern hunter + causal reasoner stress-test the moat thesis",
      tone: "debate",
      intensity: "sharp",
      briefStyle: "auto",
      agents: ["socrates", "value-investor", "first-principles"],
    },
    {
      tag: "// quit-tech",
      text: "$300K saved, senior eng job at a Big Tech — quit now to build, or wait two more years?",
      hint: "long-horizon vs. value-investor on a real fork in your career",
      tone: "constructive",
      intensity: "calm",
      briefStyle: "auto",
      agents: ["long-horizon", "value-investor", "socrates"],
    },
    {
      tag: "// pricing",
      text: "$49/mo B2B SaaS with sticky enterprise users — are we leaving 5–10x on the table by not raising to $499?",
      hint: "is your unit economics actually consumer-priced for an enterprise problem?",
      tone: "debate",
      intensity: "sharp",
      briefStyle: "auto",
      agents: ["value-investor", "user-empathy", "socrates"],
    },
    {
      tag: "// pivot",
      text: "Six months of runway, real users but flat MRR — pivot the product, hold the line, or shut it down?",
      hint: "no-mercy room: force the load-bearing claim into the open",
      tone: "no-mercy",
      intensity: "brutal",
      briefStyle: "auto",
      agents: ["socrates", "first-principles", "long-horizon"],
    },
    {
      tag: "// agent-stack",
      text: "Cursor + Claude Code + ChatGPT — am I overpaying for overlap, or is this the right mix for 2026?",
      hint: "first-principles + user-empathy figure out what each tool actually buys you",
      tone: "constructive",
      intensity: "sharp",
      briefStyle: "auto",
      agents: ["first-principles", "user-empathy", "value-investor"],
    },
  ];
  // Make available for app.js's empty-state.
  try { window.BOARDROOM_STARTERS = STARTER_QUESTIONS; } catch (e) {}

  function escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // ── Provider catalogue ─────────────────────────────────
  // Model providers shown on step 2. OpenRouter leads — it's the
  // universal router that unlocks every model from a single key, so
  // it's the lowest-friction first stop for new users. Anthropic
  // (Claude) is temporarily withheld; bring it back when the
  // direct-Anthropic flow is ready.
  // `slug` matches /api/keys/{slug} on the backend.
  const KEY_PROVIDERS = [
    {
      slug: "openrouter",
      label: "OpenRouter",
      sub: "all-in-one router",
      placeholder: "sk-or-v1-…",
      help: "openrouter.ai/keys",
      helpUrl: "https://openrouter.ai/keys",
    },
    {
      slug: "openai",
      label: "ChatGPT",
      sub: "OpenAI",
      placeholder: "sk-…",
      help: "platform.openai.com",
      helpUrl: "https://platform.openai.com/api-keys",
    },
    {
      slug: "google",
      label: "Gemini",
      sub: "Google AI Studio",
      placeholder: "AIza…",
      help: "aistudio.google.com",
      helpUrl: "https://aistudio.google.com/apikey",
    },
  ];

  // ── State ──────────────────────────────────────────────
  let currentStep = 0;
  let prefsCache = { name: "", intro: "", theme: "regent" };
  /** Per-provider configured flag · true when /api/keys reports the
   *  provider's row as configured. Drives the green dot on each tab
   *  and the Next-button enable state. */
  let providerConfigured = {
    openrouter: false,
    openai: false,
    google: false,
  };
  /** Currently-selected provider tab on step 2. Defaults to the first
   *  configured provider (sticky after partial completion) or to
   *  OpenRouter for fresh users — the lowest-friction starting point. */
  let activeProvider = "openrouter";
  let overlay = null;

  /** True when ANY model provider has a key. Replaces the legacy
   *  single-provider flag; downstream callers that just need to know
   *  "can the user use the product?" use this. */
  function anyKeyConfigured() {
    return Object.values(providerConfigured).some(Boolean);
  }

  // ── Persistence ────────────────────────────────────────
  async function loadInitial() {
    try {
      const [prefsRes, keysRes] = await Promise.all([
        fetch("/api/prefs"),
        fetch("/api/keys"),
      ]);
      if (prefsRes.ok) {
        const p = await prefsRes.json();
        prefsCache = { name: p.name === "You" ? "" : (p.name || ""), intro: p.intro || "", theme: p.theme || "regent" };
      }
      if (keysRes.ok) {
        const k = await keysRes.json();
        // Reset then patch by row · the API returns one row per
        // configured provider, with the `provider` slug + `configured`
        // boolean. Unknown providers (e.g. brave) get ignored.
        for (const slug of Object.keys(providerConfigured)) {
          providerConfigured[slug] = false;
        }
        for (const row of (k.keys || [])) {
          if (row && typeof row.provider === "string" && row.provider in providerConfigured) {
            providerConfigured[row.provider] = !!row.configured;
          }
        }
        // Sticky default · land on the first provider that's already
        // configured so re-entering onboarding feels continuous.
        const firstConfigured = KEY_PROVIDERS.find((p) => providerConfigured[p.slug]);
        if (firstConfigured) activeProvider = firstConfigured.slug;
      }
    } catch (e) { /* keep defaults */ }
  }

  async function shouldShow() {
    // Server is authoritative · localStorage is just an optimization
    // marker. If the server reports no key configured, we MUST show
    // onboarding even when localStorage thinks we've onboarded — the
    // most common reason for the mismatch is a DB wipe / fresh install
    // on a browser that previously onboarded a different DB.
    await loadInitial();
    if (!anyKeyConfigured()) {
      return true;
    }
    // Has at least one key. Mark localStorage so we skip the server
    // roundtrip on subsequent boots that don't change key state.
    try { localStorage.setItem(ONBOARDED_KEY, "true"); } catch (e) {}
    return false;
  }

  async function saveName(name) {
    const v = (name || "").trim();
    prefsCache.name = v;
    try {
      await fetch("/api/prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: v || "You" }),
      });
    } catch (e) { /* */ }
  }

  function applyThemeImmediate(slug) {
    const theme = slug || "regent";
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("boardroom.theme", theme); } catch (e) {}
    prefsCache.theme = theme;
  }

  async function saveTheme(slug) {
    applyThemeImmediate(slug);
    try {
      await fetch("/api/prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme: slug }),
      });
    } catch (e) { /* */ }
  }

  /** Save a key for a given provider. Backend endpoint is consistent:
   *  PUT /api/keys/{provider} with { key: "...", makeDefault: true }.
   *  The `makeDefault` flag tells the server "the user just picked
   *  this provider as their primary in onboarding" — it flips
   *  prefs.defaultModelV to the new provider's flagship and force-
   *  switches every existing agent to that primary, even ones that
   *  were still reachable on a different carrier. Without it, a
   *  user who had OpenRouter configured before and now picks Gemini
   *  in onboarding would see the chair stay on opus-4-7 (reachable
   *  via OR) instead of swinging to gemini-3-flash.
   *
   *  Empty input doesn't fire a request — it's a no-op (DELETE flow
   *  lives in user-settings, not in onboarding). */
  async function deleteProviderKey(provider) {
    try {
      await fetch("/api/keys/" + encodeURIComponent(provider), { method: "DELETE" });
    } catch (e) { /* */ }
    providerConfigured[provider] = false;
  }

  async function saveProviderKey(provider, value) {
    const trimmed = (value || "").trim();
    if (!trimmed) return false;
    try {
      const r = await fetch("/api/keys/" + encodeURIComponent(provider), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: trimmed, makeDefault: true }),
      });
      if (!r.ok) return false;
      const data = await r.json();
      const ok = !!data.configured;
      providerConfigured[provider] = ok;
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ── Render ─────────────────────────────────────────────
  function modalHTML() {
    return `
      <div class="onb-overlay" id="onb-overlay" role="dialog" aria-modal="true">
        <div class="onb-modal" role="document">
          <div class="onb-classification">
            <span><span class="dot">●</span> first run · setup</span>
            <span class="right">// local · ~30 seconds</span>
          </div>

          <div class="onb-progress" data-onb-progress>
            <div class="onb-dot active"></div>
            <div class="onb-dot"></div>
            <div class="onb-dot"></div>
            <div class="onb-dot"></div>
          </div>

          <div class="onb-head" data-onb-head></div>
          <div class="onb-body" data-onb-body></div>

          <footer class="onb-foot">
            <div class="onb-foot-left">
              <button type="button" class="onb-btn" data-onb-back>[ ◂ Back ]</button>
            </div>
            <div class="onb-foot-right" data-onb-actions></div>
          </footer>
        </div>
      </div>
    `;
  }

  function renderStep() {
    const head = overlay.querySelector("[data-onb-head]");
    const body = overlay.querySelector("[data-onb-body]");
    const back = overlay.querySelector("[data-onb-back]");
    const actions = overlay.querySelector("[data-onb-actions]");

    // Update progress dots
    const dots = overlay.querySelectorAll(".onb-dot");
    dots.forEach((d, i) => {
      d.classList.toggle("active", i === currentStep);
      d.classList.toggle("done", i < currentStep);
    });

    back.style.visibility = currentStep === 0 ? "hidden" : "visible";

    if (currentStep === 0) {
      head.innerHTML = `
        <div class="onb-tag">▸ welcome</div>
        <div class="onb-title">A private boardroom for you.</div>
        <div class="onb-deck">A board of stubborn advisors for the questions you take seriously. Not a chatbot. Three quick steps and you're in.</div>
      `;
      body.innerHTML = `
        <div class="onb-field">
          <div class="onb-field-label">What should the room call you?</div>
          <div class="onb-input-wrap">
            <input class="onb-input" data-onb-name maxlength="32" placeholder="e.g. Kay" value="${escape(prefsCache.name || "")}" autofocus>
          </div>
          <div class="onb-field-hint">Used in the directors' system context. You can change it later in Preference.</div>
        </div>
      `;
      actions.innerHTML = `<button type="button" class="onb-btn primary" data-onb-next>[ Next ▸ ]</button>`;
    }

    else if (currentStep === 1) {
      head.innerHTML = `
        <div class="onb-tag">▸ theme</div>
        <div class="onb-title">Pick a palette.</div>
        <div class="onb-deck">Applied instantly. You can change it any time in Preference → Theme.</div>
      `;
      const swatches = (cs) => cs.map((c) => `<span style="background:${c}"></span>`).join("");
      body.innerHTML = `
        <div class="onb-theme-grid">
          ${THEMES.map((t) => `
            <a href="#" class="onb-theme${t.slug === prefsCache.theme ? " active" : ""}" data-onb-theme="${t.slug}">
              <span class="onb-theme-swatch">${swatches(t.swatches)}</span>
              <span>
                <span class="onb-theme-name">${escape(t.name)}</span>
                <div class="onb-theme-desc">${escape(t.desc)}</div>
              </span>
              <span></span>
            </a>
          `).join("")}
        </div>
      `;
      actions.innerHTML = `<button type="button" class="onb-btn primary" data-onb-next>[ Next ▸ ]</button>`;
    }

    else if (currentStep === 2) {
      const active = KEY_PROVIDERS.find((p) => p.slug === activeProvider) || KEY_PROVIDERS[0];
      const tabs = KEY_PROVIDERS.map((p) => {
        const isActive = p.slug === active.slug;
        const isConfigured = providerConfigured[p.slug];
        return `
          <button type="button"
                  class="onb-key-tab${isActive ? " active" : ""}${isConfigured ? " configured" : ""}"
                  data-onb-provider="${escape(p.slug)}">
            <span class="onb-key-tab-label">${escape(p.label)}</span>
            <span class="onb-key-tab-sub">${escape(p.sub)}</span>
            ${isConfigured ? `<span class="onb-key-tab-dot" title="configured">●</span>` : ""}
          </button>
        `;
      }).join("");

      const inputValue = ""; // never echo back the saved key
      const status = providerConfigured[active.slug]
        ? `<div class="onb-key-status ok">● ${escape(active.label)} key configured</div>`
        : "";

      head.innerHTML = `
        <div class="onb-tag">▸ api key</div>
        <div class="onb-title">Bring your own key.</div>
        <div class="onb-deck">Boardroom runs against your model provider. Pick one below — any single key is enough to get started. Stored locally on this machine, never uploaded.</div>
      `;
      body.innerHTML = `
        <div class="onb-key-tabs">${tabs}</div>
        <div class="onb-field">
          <div class="onb-field-label" data-onb-field-label>${escape(active.label)} API key</div>
          <div class="onb-input-wrap">
            <input class="onb-input" data-onb-key type="password" placeholder="${escape(active.placeholder)}" autocomplete="off" spellcheck="false" value="${escape(inputValue)}">
            <button type="button" class="onb-input-reveal" data-onb-reveal aria-label="Show key" aria-pressed="false">show</button>
          </div>
          ${status}
          <div class="onb-field-hint">
            Don't have one? <a href="${escape(active.helpUrl)}" target="_blank" rel="noopener" data-onb-help-link>Generate at ${escape(active.help)} →</a>
            <br>
            You can add or change provider keys later in Preferences.
          </div>
        </div>
      `;
      const enableNext = anyKeyConfigured();
      actions.innerHTML = `<button type="button" class="onb-btn primary" data-onb-next ${enableNext ? "" : "disabled"}>[ Next ▸ ]</button>`;
    }

    else if (currentStep === 3) {
      head.innerHTML = `
        <div class="onb-tag">▸ done · pick a starting question</div>
        <div class="onb-title">${prefsCache.name ? escape(prefsCache.name) + ", y" : "Y"}our boardroom is open.</div>
        <div class="onb-deck">Pick a starter to take one full journey: convene a room, watch three directors stress-test the question, then file the brief. Or convene your own from scratch.</div>
      `;
      const cards = STARTER_QUESTIONS.map((q, idx) => {
        const cast = (q.agents || []).map((slug) => `
          <span class="onb-starter-agent" title="${escape(NAMES[slug] || slug)}">
            <img class="onb-starter-av" src="avatars/${escape(slug)}.svg" alt="${escape(NAMES[slug] || slug)}">
            <span class="onb-starter-name">${escape(NAMES[slug] || slug)}</span>
          </span>
        `).join("");
        return `
          <div class="onb-starter" data-onb-action="starter" data-onb-starter-idx="${idx}">
            <div class="onb-starter-tag">${escape(q.tag)}</div>
            <div class="onb-starter-main">
              <div class="onb-starter-text">${escape(q.text)}</div>
              <div class="onb-starter-hint">${escape(q.hint)}</div>
              <div class="onb-starter-meta">
                <span class="meta-tag tag-tone"><span class="k">tone</span><span class="v">${escape(q.tone)}</span></span>
                <span class="meta-tag tag-intensity"><span class="k">intensity</span><span class="v">${escape(q.intensity)}</span></span>
              </div>
            </div>
            <!-- data-no-agent-overlay · these avatars are decorative
                 cast indicators, not profile triggers. agent-overlay.js
                 honours this attribute on autotag + click. -->
            <div class="onb-starter-cast" data-no-agent-overlay>${cast}</div>
            <button type="button" class="onb-starter-start" data-onb-action="starter" data-onb-starter-idx="${idx}">
              <span class="onb-starter-start-arrow">▶</span>
              <span class="onb-starter-start-label">Start</span>
            </button>
          </div>
        `;
      }).join("");
      body.innerHTML = `
        <div class="onb-starters">${cards}</div>
        <div class="onb-final-divider"><span>or</span></div>
        <div class="onb-final">
          <button type="button" class="onb-final-card" data-onb-action="convene">
            <div class="onb-final-mark">▸ CONVENE</div>
            <div class="onb-final-title">Convene your own</div>
            <div class="onb-final-deck">Pick directors, write your own question, start the room.</div>
          </button>
        </div>
      `;
      actions.innerHTML = `<button type="button" class="onb-btn" data-onb-action="skip">[ I'll explore on my own ]</button>`;
    }
  }

  // ── Actions ────────────────────────────────────────────
  function next() {
    if (currentStep === 0) {
      const v = overlay.querySelector("[data-onb-name]").value;
      void saveName(v);
    } else if (currentStep === 2) {
      // Gated · the user must have AT LEAST ONE provider key
      // configured (any of OpenRouter / OpenAI / Google) before
      // they can proceed to the starter screen.
      if (!anyKeyConfigured()) return;
    }
    currentStep = Math.min(currentStep + 1, 3);
    renderStep();
  }
  function back() {
    currentStep = Math.max(currentStep - 1, 0);
    renderStep();
  }

  /** Switch the active provider tab on step 2. Inline DOM update —
   *  NOT a full re-render — so the single input element survives the
   *  switch and whatever the user has typed stays in the field. The
   *  tabs above are just a label declaring what the input is for. */
  function selectProvider(slug) {
    if (!(slug in providerConfigured)) return;
    if (activeProvider === slug) return;
    activeProvider = slug;

    const active = KEY_PROVIDERS.find((p) => p.slug === slug) || KEY_PROVIDERS[0];

    overlay.querySelectorAll(".onb-key-tab").forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-onb-provider") === slug);
    });

    const fieldLabel = overlay.querySelector("[data-onb-field-label]");
    if (fieldLabel) fieldLabel.textContent = `${active.label} API key`;

    const input = overlay.querySelector("[data-onb-key]");
    if (input) input.setAttribute("placeholder", active.placeholder);

    const helpLink = overlay.querySelector("[data-onb-help-link]");
    if (helpLink) {
      helpLink.setAttribute("href", active.helpUrl);
      helpLink.textContent = `Generate at ${active.help} →`;
    }

    // Status pill reflects the now-active provider's saved state.
    const wrap = input ? input.closest(".onb-field") : null;
    const existing = wrap ? wrap.querySelector(".onb-key-status") : null;
    if (existing) existing.remove();
    if (providerConfigured[slug] && wrap) {
      wrap.querySelector(".onb-input-wrap").insertAdjacentHTML(
        "afterend",
        `<div class="onb-key-status ok">● ${escape(active.label)} key configured</div>`,
      );
    }
  }

  async function trySaveKey(value) {
    const provider = activeProvider;
    const label = (KEY_PROVIDERS.find((p) => p.slug === provider) || {}).label || provider;
    const status = overlay.querySelector(".onb-key-status");
    const nextBtn = overlay.querySelector("[data-onb-next]");
    if (status) status.outerHTML = `<div class="onb-key-status warn">○ checking…</div>`;
    const ok = await saveProviderKey(provider, value);
    const fresh = overlay.querySelector(".onb-key-status, [class^=onb-key-status]");
    if (ok) {
      // Single-provider invariant · the onboarding step has one input;
      // the tabs above only declare which provider that input is for.
      // After a successful save, retire any other provider keys so the
      // user leaves onboarding with exactly one configured carrier.
      for (const slug of Object.keys(providerConfigured)) {
        if (slug === provider || !providerConfigured[slug]) continue;
        await deleteProviderKey(slug);
        const otherTab = overlay.querySelector(`.onb-key-tab[data-onb-provider="${slug}"]`);
        if (otherTab) {
          otherTab.classList.remove("configured");
          otherTab.querySelector(".onb-key-tab-dot")?.remove();
        }
      }
      if (fresh) fresh.outerHTML = `<div class="onb-key-status ok">● ${escape(label)} key configured</div>`;
      else {
        const wrap = overlay.querySelector("[data-onb-key]")?.closest(".onb-field");
        if (wrap) wrap.querySelector(".onb-input-wrap").insertAdjacentHTML(
          "afterend",
          `<div class="onb-key-status ok">● ${escape(label)} key configured</div>`,
        );
      }
      // Update the matching tab's "configured" state inline rather
      // than re-rendering the whole step (would steal input focus).
      const tab = overlay.querySelector(`.onb-key-tab[data-onb-provider="${provider}"]`);
      if (tab && !tab.classList.contains("configured")) {
        tab.classList.add("configured");
        tab.insertAdjacentHTML("beforeend", `<span class="onb-key-tab-dot" title="configured">●</span>`);
      }
      if (nextBtn) nextBtn.disabled = false;
    } else {
      if (fresh) fresh.outerHTML = `<div class="onb-key-status error">✗ not saved</div>`;
      if (nextBtn) nextBtn.disabled = !anyKeyConfigured();
    }
  }

  function complete(then) {
    try { localStorage.setItem(ONBOARDED_KEY, "true"); } catch (e) {}
    document.body.classList.remove("onb-locked");
    overlay.classList.remove("open");
    setTimeout(() => {
      overlay.remove();
      overlay = null;
    }, 220);
    // Sync every client-side cache the server just mutated. The PUT
    // /api/keys/:provider call with `makeDefault:true` did three
    // server-side writes: the key row, prefs.defaultModelV (flipped
    // to the new carrier's primary), and every agent's modelV (via
    // reconcile). Each of those has its own client cache · refresh
    // them all so user-settings, sidebar, and pickers reflect the
    // new state immediately, no full reload needed. Wait on all
    // three before running the continuation so any post-onboarding
    // action (createRoom, open convene) sees fresh state.
    const continuation = typeof then === "function" ? then : null;
    const refreshes = [];
    if (window.app && typeof window.app.refreshKeys === "function") {
      refreshes.push(Promise.resolve(window.app.refreshKeys()).catch(() => {}));
    }
    if (window.app && typeof window.app.refreshAgents === "function") {
      refreshes.push(Promise.resolve(window.app.refreshAgents()).catch(() => {}));
    }
    if (typeof window.boardroomModelsRefresh === "function") {
      refreshes.push(Promise.resolve(window.boardroomModelsRefresh()).catch(() => {}));
    }
    Promise.all(refreshes).finally(() => { if (continuation) continuation(); });
  }

  async function createDemoRoom(spec) {
    if (!window.app || typeof window.app.createRoom !== "function") {
      // app hasn't booted yet — wait briefly then retry once.
      await new Promise((r) => setTimeout(r, 200));
    }
    // Accept either a full starter spec object (preferred), a plain subject
    // string (legacy), or nothing (default to the first starter).
    let s = spec;
    if (!s) s = STARTER_QUESTIONS[0];
    else if (typeof s === "string") {
      const text = s.trim();
      s = STARTER_QUESTIONS.find((q) => q.text === text) || { text };
    }
    try {
      await window.app.createRoom({
        subject: s.text,
        agentIds: s.agents && s.agents.length >= 2 ? s.agents : DEMO_AGENTS,
        mode: s.tone || "constructive",
        intensity: s.intensity || "sharp",
        briefStyle: s.briefStyle || "auto",
      });
    } catch (e) {
      alert("Couldn't create a starter room: " + (e && e.message ? e.message : e));
    }
  }

  function openConveneAfter() {
    setTimeout(() => {
      // Convene-overlay was retired in favour of the inline composer.
      // Fall back to closing the active room so the composer shows; if
      // app.closeRoom isn't ready yet, no-op (the user is on the
      // dashboard already and will see it on next interaction).
      try {
        if (window.app && typeof window.app.closeRoom === "function") {
          window.app.closeRoom();
        } else if (typeof window.openConveneOverlay === "function") {
          window.openConveneOverlay();
        }
      } catch { /* ignore */ }
    }, 250);
  }

  // ── Wiring ─────────────────────────────────────────────
  function wire() {
    overlay.addEventListener("click", async (e) => {
      const t = e.target;

      if (t.closest("[data-onb-next]")) {
        e.preventDefault();
        next();
        return;
      }
      if (t.closest("[data-onb-back]")) {
        e.preventDefault();
        back();
        return;
      }
      const themeChoice = t.closest("[data-onb-theme]");
      if (themeChoice) {
        e.preventDefault();
        const slug = themeChoice.getAttribute("data-onb-theme");
        overlay.querySelectorAll(".onb-theme").forEach((el) => el.classList.remove("active"));
        themeChoice.classList.add("active");
        void saveTheme(slug);
        return;
      }
      const providerChoice = t.closest("[data-onb-provider]");
      if (providerChoice) {
        e.preventDefault();
        const slug = providerChoice.getAttribute("data-onb-provider");
        if (slug) selectProvider(slug);
        return;
      }
      const reveal = t.closest("[data-onb-reveal]");
      if (reveal) {
        e.preventDefault();
        const input = overlay.querySelector("[data-onb-key]");
        if (!input) return;
        const showing = input.getAttribute("type") === "text";
        input.setAttribute("type", showing ? "password" : "text");
        reveal.setAttribute("aria-pressed", showing ? "false" : "true");
        reveal.setAttribute("aria-label", showing ? "Show key" : "Hide key");
        reveal.textContent = showing ? "show" : "hide";
        return;
      }
      const action = t.closest("[data-onb-action]");
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        const a = action.getAttribute("data-onb-action");
        if (a === "starter") {
          const idx = parseInt(action.getAttribute("data-onb-starter-idx") || "-1", 10);
          const spec = Number.isFinite(idx) ? STARTER_QUESTIONS[idx] : null;
          complete(() => { void createDemoRoom(spec); });
        } else if (a === "demo") {
          complete(() => { void createDemoRoom(); });
        } else if (a === "convene") {
          complete(() => openConveneAfter());
        } else if (a === "skip") {
          complete();
        }
        return;
      }
    });

    // Live updates for the API key field — debounce, validate, save.
    overlay.addEventListener("input", (e) => {
      const t = e.target;
      if (t.matches("[data-onb-name]")) {
        prefsCache.name = t.value;
      } else if (t.matches("[data-onb-key]")) {
        clearTimeout(t.__onbTimer);
        t.__onbTimer = setTimeout(() => trySaveKey(t.value), 280);
      }
    });

    // Enter on name → next
    overlay.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (e.target.matches("[data-onb-name]")) {
        e.preventDefault();
        next();
      }
    });
  }

  function show() {
    if (document.getElementById("onb-overlay")) return;
    // Claim the dashboard sub-state · prototype-dashboard.html runs a
    // restore tick (~2.5s of 250ms retries) that re-opens whatever
    // agent profile the user last viewed once refreshAgents mounts the
    // sidebar rows. Onboarding always lands the user on a fresh room
    // (or the composer), so claim "rooms" + clear the saved agent id
    // up-front. Without this, finishing onboarding fast enough races
    // the tick and the user occasionally lands on a stale agent
    // profile instead of the room they just convened.
    try {
      localStorage.setItem("boardroom.sidebar.tab", "rooms");
      localStorage.setItem("boardroom.sidebar.agents", "new");
    } catch (e) {}
    const wrap = document.createElement("div");
    wrap.innerHTML = modalHTML().trim();
    document.body.appendChild(wrap.firstChild);
    overlay = document.getElementById("onb-overlay");
    overlay.classList.add("open");
    document.body.classList.add("onb-locked");
    renderStep();
    wire();

    // First-run: for the user-settings.js bootstrap, suppress ⚙ click
    // while overlay is open by capture-phase guard.
    document.addEventListener("click", guardSettingsTrigger, true);
  }

  function guardSettingsTrigger(e) {
    if (!overlay || !overlay.classList.contains("open")) {
      document.removeEventListener("click", guardSettingsTrigger, true);
      return;
    }
    if (e.target.closest("[data-user-settings-trigger]")) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  async function init() {
    if (await shouldShow()) {
      show();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.boardroomShowOnboarding = show; // exposed for testing
})();
