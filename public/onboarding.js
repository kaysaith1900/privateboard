/* ═══════════════════════════════════════════
   ONBOARDING · first-run storyline (v2)
   ═══════════════════════════════════════════
   Four short story beats, then we hand the user to the composer.

     0  welcome / name        — sit down
     1  what is this          — a meeting, not a chatbot
     2  api key               — hand over a key
     3  cast preview          — your board

   After step 3 the overlay dismisses and a one-shot tooltip appears
   over the composer pointing at the subject input. The user opens
   their first room themselves — onboarding teaches; the user does.

   Each step persists what it touches immediately
   (PUT /api/prefs · PUT /api/keys/{provider}).
*/
(function () {
  const ONBOARDED_KEY = "boardroom.onboarded";
  const FIRST_HINT_KEY = "boardroom.onb.firstHint";

  /** Sample of the bench shown on step 3. Avatar files live in
   *  public/avatars/<slug>.svg — only slugs that have a real SVG
   *  there should appear, otherwise the broken-image glyph shows
   *  through. chair leads (always first), then five directors. */
  const CAST_PREVIEW = [
    { slug: "chair",            name: "Chair",            role: "host" },
    { slug: "socrates",         name: "Socrates",         role: "skeptic" },
    { slug: "value-investor",   name: "Value Investor",   role: "long memory" },
    { slug: "first-principles", name: "First Principles", role: "causal reasoner" },
    { slug: "long-horizon",     name: "Long Horizon",     role: "patient mind" },
    { slug: "user-empathy",     name: "User-Empathy",     role: "field empath" },
  ];

  /** EN-locked fallback for every onb_v2_* key — used when window.I18n
   *  hasn't booted yet, or the active locale is missing the key. Mirrors
   *  the EN block in i18n.js exactly; keep these in sync if you edit the
   *  strings there. */
  const EN_FALLBACK = {
    onb_v2_classification_left: "first run · welcome",
    onb_v2_classification_right: "// local · ~60 seconds",
    onb_v2_back: "[ ◂ Back ]",
    onb_v2_next: "[ Next ▸ ]",
    onb_v2_continue: "[ Continue ▸ ]",
    onb_v2_ready: "[ I'm ready ▸ ]",
    onb_v2_enter: "[ Step in ▸ ]",
    onb_v2_name_kicker: "00 — Sit down",
    onb_v2_name_title: "How should the room call you?",
    onb_v2_name_sub: "From here on, this is your room.",
    onb_v2_name_placeholder: "e.g. Kay",
    onb_v2_what_kicker: "01 — A meeting, not a chatbot",
    onb_v2_what_title: "You convene stubborn advisors and let them argue, in front of you, over a question that matters.",
    onb_v2_what_body: "Three acts · convene · sharpen · adjourn. You sit as chair, the directors take sides, and on adjourn you walk away with a brief in hand.",
    onb_v2_what_note: "Not a chatbot. The directors don't agree with you — they pressure-test the question until it sharpens.",
    onb_v2_key_kicker: "02 — Hand over a key",
    onb_v2_key_title: "Pick one brain — or pick many.",
    onb_v2_key_body: "Your key stays on this machine. We never upload it.",
    onb_v2_key_recommend_badge: "// recommended",
    onb_v2_key_recommend_openrouter_name: "OpenRouter · one key, every model",
    onb_v2_key_recommend_openrouter_body: "Each director can run on a different model — Claude as the skeptic, GPT as the pattern hunter, Gemini as the long-horizon strategist. The chair routes each turn to the right brain.",
    onb_v2_key_recommend_bai_name: "B.AI · one key, every model",
    onb_v2_key_recommend_bai_body: "A second universal aggregator with its own pricing and access channels. Pick whichever has the credits or regional pricing that suits you, or use it as a fallback when an OpenRouter route is throttled.",
    onb_v2_key_or: "or — a direct provider",
    onb_v2_key_or_body: "Same model for every director. Personas stay distinct, but they all share one brain underneath.",
    onb_v2_voice_kicker: "03 — Give them a voice  ·  optional",
    onb_v2_voice_title: "Want them to speak aloud?",
    onb_v2_voice_body: "Add a TTS key and the boardroom turns into a round table. Directors take seats, raise their head when speaking, fade back when listening.",
    onb_v2_voice_pitch: "It plays like a slow strategy game — you watch your bench think, debate, and challenge each other in real voices. Each director gets a distinct voice on first key. Skip if you'd rather stay text-only; you can flip this on anytime in Settings.",
    onb_v2_voice_skip: "[ Skip for now ]",
    onb_v2_voice_skip_cta: "[ Skip → ]",
    onb_v2_cast_kicker: "04 — Your board",
    onb_v2_cast_title: "Chair runs the room. Directors disagree. The brief closes the loop.",
    onb_v2_cast_body: "By default the chair picks three directors for you; you can also pick your own. That choice — and your question — happens in the composer next.",
    onb_v2_cast_lineup: "// preview only · pick later in the composer",
    onb_v2_cast_next_kicker: "// next  ·  in the composer",
    onb_v2_cast_next_step_1: "Write your question",
    onb_v2_cast_next_step_2: "Chair picks 3 directors",
    onb_v2_cast_next_step_3: "Hit Convene",
    onb_v2_hint_kicker: "// your seat",
    onb_v2_hint_body: "Write the question that's been sitting on your mind — then press Convene.",
    onb_v2_hint_dismiss: "Got it",
  };

  function t(key) {
    try {
      if (window.I18n && typeof window.I18n.t === "function") {
        const v = window.I18n.t(key);
        if (typeof v === "string" && v && v !== key) return v;
      }
    } catch (e) { /* fall through */ }
    return EN_FALLBACK[key] || key;
  }

  function escape(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // ── Provider catalogue ─────────────────────────────────
  // Model providers shown on step 2. Two-tier card grid:
  //  · MULTI_MODEL_CARDS on top · one key reaches every flagship model
  //    family (Claude / GPT / Gemini / Kimi / DeepSeek / MiniMax / GLM).
  //  · SINGLE_MODEL_CARDS below · one key reaches one model family.
  //
  // Under the single-active-LLM-provider invariant, picking one card
  // and saving its key atomically replaces whatever the user had before
  // (backend handles the swap in one transaction). The frontend used to
  // chase parity by client-side-deleting every other LLM row after each
  // save — that path is gone now, atomic on the server.
  //
  // xAI is in SINGLE_MODEL_CARDS but its registry has no Grok rows as
  // of 2026-05-17; the renderer filters it out when /api/models reports
  // zero reachable models for it (auto-hides until a Grok entry returns).
  //
  // `slug` matches /api/keys/{slug} on the backend.
  const MULTI_MODEL_CARDS = [
    {
      slug: "openrouter",
      label: "OpenRouter",
      sub: "universal aggregator · Claude · GPT · Gemini · Kimi · DeepSeek",
      placeholder: "sk-or-v1-…",
      help: "openrouter.ai/keys",
      helpUrl: "https://openrouter.ai/keys",
    },
    {
      slug: "bai",
      label: "B.AI",
      sub: "universal aggregator · same catalog · CN pricing channel",
      placeholder: "sk-…",
      help: "b.ai",
      helpUrl: "https://b.ai/",
    },
  ];

  const SINGLE_MODEL_CARDS = [
    {
      slug: "anthropic",
      label: "Claude",
      sub: "Anthropic direct",
      placeholder: "sk-ant-…",
      help: "console.anthropic.com",
      helpUrl: "https://console.anthropic.com/settings/keys",
    },
    {
      slug: "openai",
      label: "ChatGPT",
      sub: "OpenAI direct",
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
    {
      slug: "xai",
      label: "Grok",
      sub: "xAI direct",
      placeholder: "xai-…",
      help: "console.x.ai",
      helpUrl: "https://console.x.ai/team",
    },
  ];

  // Legacy alias · existing callsites that iterate every LLM provider
  // for status painting still work via the flat union. New code should
  // branch on MULTI_MODEL_CARDS vs SINGLE_MODEL_CARDS directly.
  const KEY_PROVIDERS = [...MULTI_MODEL_CARDS, ...SINGLE_MODEL_CARDS];

  /** TTS providers offered on step 3 (optional). MiniMax leads because
   *  it ships a richer roster of localised Chinese voices and an
   *  affordable starter tier; ElevenLabs is the premium English-leaning
   *  alternative. Unlike LLM providers (single-active invariant) both
   *  can be configured side-by-side — backend keeps voices from each
   *  carrier in one registry. */
  const VOICE_PROVIDERS = [
    {
      slug: "minimax",
      label: "MiniMax",
      sub: "speech · CN/EN voices, cloning",
      placeholder: "mm-…",
      help: "minimax.io",
      helpUrl: "https://www.minimax.io/platform/user-center/basic-information/interface-key",
    },
    {
      slug: "elevenlabs",
      label: "ElevenLabs",
      sub: "speech · premium EN voices",
      placeholder: "xi-…",
      help: "elevenlabs.io",
      helpUrl: "https://elevenlabs.io/app/settings/api-keys",
    },
  ];

  /** Themes shown in the voice-room preview banner on step 3. Each
   *  key matches a `<article data-preview-theme=…>` in the
   *  `<template id="vonb-themes">` block in index.html (which the
   *  marketing voice-onboarding overlay also clones from). */
  const VOICE_PREVIEW_THEMES = ["eastwood", "regent", "atrium", "nintendo"];

  const STEP_COUNT = 5;

  // ── State ──────────────────────────────────────────────
  let currentStep = 0;
  let prefsCache = { name: "", intro: "" };
  let providerConfigured = {
    openrouter: false,
    bai: false,
    anthropic: false,
    openai: false,
    google: false,
    xai: false,
  };
  let voiceProviderConfigured = {
    minimax: false,
    elevenlabs: false,
  };
  let activeProvider = "openrouter";
  let activeVoiceProvider = "minimax";
  /** Theme key chosen for the step-3 room preview · picked once per
   *  session (when the modal mounts) so re-rendering the step doesn't
   *  flicker the visual. Cycled via VOICE_PREVIEW_THEMES round-robin
   *  on each fresh show() to keep replay feeling alive. */
  let voicePreviewTheme = "regent";
  let overlay = null;

  function anyKeyConfigured() {
    return Object.values(providerConfigured).some(Boolean);
  }

  function anyVoiceKeyConfigured() {
    return Object.values(voiceProviderConfigured).some(Boolean);
  }

  // ── Persistence ────────────────────────────────────────
  async function loadInitial() {
    try {
      // /api/keys still covers voice (minimax, elevenlabs) + skill
      // (brave, tavily). LLM providers moved to /api/credentials —
      // multi-instance now, so we mark a provider "configured" if
      // ANY credential of that provider exists.
      const [prefsRes, keysRes, credsRes] = await Promise.all([
        fetch("/api/prefs"),
        fetch("/api/keys"),
        fetch("/api/credentials"),
      ]);
      if (prefsRes.ok) {
        const p = await prefsRes.json();
        prefsCache = { name: p.name === "You" ? "" : (p.name || ""), intro: p.intro || "" };
      }
      for (const slug of Object.keys(providerConfigured)) {
        providerConfigured[slug] = false;
      }
      for (const slug of Object.keys(voiceProviderConfigured)) {
        voiceProviderConfigured[slug] = false;
      }
      if (keysRes.ok) {
        const k = await keysRes.json();
        for (const row of (k.keys || [])) {
          if (!row || typeof row.provider !== "string") continue;
          if (row.provider in voiceProviderConfigured) {
            voiceProviderConfigured[row.provider] = !!row.configured;
          }
        }
        const firstVoiceConfigured = VOICE_PROVIDERS.find((p) => voiceProviderConfigured[p.slug]);
        if (firstVoiceConfigured) activeVoiceProvider = firstVoiceConfigured.slug;
      }
      if (credsRes.ok) {
        const cr = await credsRes.json();
        for (const row of (cr.credentials || [])) {
          if (!row || typeof row.provider !== "string") continue;
          if (row.provider in providerConfigured) {
            providerConfigured[row.provider] = true;
          }
        }
        const firstConfigured = KEY_PROVIDERS.find((p) => providerConfigured[p.slug]);
        if (firstConfigured) activeProvider = firstConfigured.slug;
      }
    } catch (e) { /* keep defaults */ }
  }

  async function shouldShow() {
    await loadInitial();
    if (!anyKeyConfigured()) {
      return true;
    }
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

  /** Save an LLM provider key as a new credential. POST /api/credentials
   *  creates the row (auto-labelled with the provider's display name +
   *  numeric suffix when duplicates exist) and auto-activates it. The
   *  same provider can now have multiple credentials on file, so this
   *  no longer needs the "wipe sibling LLM keys" client-side dance. */
  async function deleteProviderKey() {
    // No-op under the credentials model · onboarding never needs to
    // delete anything; users can manage credentials in Settings later.
    return;
  }

  async function saveProviderKey(provider, value) {
    const trimmed = (value || "").trim();
    if (!trimmed) return false;
    try {
      const r = await fetch("/api/credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, key: trimmed, label: null }),
      });
      if (!r.ok) return false;
      const data = await r.json();
      const ok = !!(data && data.id);
      providerConfigured[provider] = ok;
      return ok;
    } catch (e) {
      return false;
    }
  }

  /** Save a voice / TTS provider key (MiniMax · ElevenLabs).
   *  Unlike LLM providers, voice providers coexist — the backend
   *  registry lets both carriers serve voices side-by-side — so we
   *  do NOT pass `makeDefault` and do NOT retire siblings. The
   *  backend's first-voice-key 0→1 transition still triggers
   *  per-agent voice auto-assignment server-side. */
  async function saveVoiceKey(provider, value) {
    const trimmed = (value || "").trim();
    if (!trimmed) return false;
    try {
      const r = await fetch("/api/keys/" + encodeURIComponent(provider), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: trimmed }),
      });
      if (!r.ok) return false;
      const data = await r.json();
      const ok = !!data.configured;
      voiceProviderConfigured[provider] = ok;
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ── Render ─────────────────────────────────────────────
  function modalHTML() {
    const dots = Array.from({ length: STEP_COUNT }, (_, i) =>
      `<div class="onb-dot${i === 0 ? " active" : ""}"></div>`
    ).join("");
    return `
      <div class="onb-overlay" id="onb-overlay" role="dialog" aria-modal="true">
        <div class="onb-modal onb-modal-v2" role="document">
          <div class="onb-classification">
            <span><span class="dot">●</span> ${escape(t("onb_v2_classification_left"))}</span>
            <span class="right">${escape(t("onb_v2_classification_right"))}</span>
          </div>

          <div class="onb-progress" data-onb-progress>${dots}</div>

          <div class="onb-head" data-onb-head></div>
          <div class="onb-body" data-onb-body></div>

          <footer class="onb-foot">
            <div class="onb-foot-left">
              <button type="button" class="onb-btn" data-onb-back>${escape(t("onb_v2_back"))}</button>
            </div>
            <div class="onb-foot-right" data-onb-actions></div>
          </footer>
        </div>
      </div>
    `;
  }

  /** Tear down the live 3D banner if one is currently mounted in
   *  step 3. Called at the top of every renderStep so leaving the
   *  step (back / next / close) frees WebGL resources cleanly. */
  let _voice3dBannerStop = null;
  function unmountVoiceBannerScene() {
    if (_voice3dBannerStop) {
      try { _voice3dBannerStop(); } catch (_) {}
      _voice3dBannerStop = null;
    }
  }

  function renderStep() {
    // Always clean up any prior 3D mount before rebuilding step DOM.
    unmountVoiceBannerScene();
    const head = overlay.querySelector("[data-onb-head]");
    const body = overlay.querySelector("[data-onb-body]");
    const back = overlay.querySelector("[data-onb-back]");
    const actions = overlay.querySelector("[data-onb-actions]");

    const dots = overlay.querySelectorAll(".onb-dot");
    dots.forEach((d, i) => {
      d.classList.toggle("active", i === currentStep);
      d.classList.toggle("done", i < currentStep);
    });

    back.style.visibility = currentStep === 0 ? "hidden" : "visible";

    if (currentStep === 0) {
      head.innerHTML = `
        <div class="onb-tag">${escape(t("onb_v2_name_kicker"))}</div>
        <div class="onb-title onb-title-serif">${escape(t("onb_v2_name_title"))}</div>
        <div class="onb-deck">${escape(t("onb_v2_name_sub"))}</div>
      `;
      body.innerHTML = `
        <div class="onb-field onb-v2-name-field">
          <div class="onb-input-wrap">
            <input class="onb-input onb-input-serif" data-onb-name maxlength="32" placeholder="${escape(t("onb_v2_name_placeholder"))}" value="${escape(prefsCache.name || "")}" autofocus>
          </div>
        </div>
      `;
      actions.innerHTML = `<button type="button" class="onb-btn primary" data-onb-next>${escape(t("onb_v2_enter"))}</button>`;
    }

    else if (currentStep === 1) {
      head.innerHTML = `
        <div class="onb-tag">${escape(t("onb_v2_what_kicker"))}</div>
        <div class="onb-title onb-title-serif">${escape(t("onb_v2_what_title"))}</div>
      `;
      body.innerHTML = `
        <div class="onb-narrative">
          <p class="onb-narrative-p">${escape(t("onb_v2_what_body"))}</p>
          <p class="onb-narrative-note">${escape(t("onb_v2_what_note"))}</p>
        </div>
      `;
      actions.innerHTML = `<button type="button" class="onb-btn primary" data-onb-next>${escape(t("onb_v2_continue"))}</button>`;
    }

    else if (currentStep === 2) {
      const active = KEY_PROVIDERS.find((p) => p.slug === activeProvider) || KEY_PROVIDERS[0];

      // Multi-model cards · one key reaches every flagship model
      // family. Reuses the legacy `.onb-key-recommend` class for visual
      // continuity (big card shape) — paintProviderConfigured() keys
      // off that class to decide where to plant the configured dot.
      const multiCards = MULTI_MODEL_CARDS.map((p) => {
        const isActive = p.slug === active.slug;
        const isConfigured = providerConfigured[p.slug];
        const nameText = t(`onb_v2_multi_pitch_${p.slug}_name`);
        const bodyText = t(`onb_v2_multi_pitch_${p.slug}_body`);
        return `
          <button type="button"
                  class="onb-key-recommend${isActive ? " active" : ""}${isConfigured ? " configured" : ""}"
                  data-onb-provider="${escape(p.slug)}">
            <div class="onb-key-recommend-head">
              <span class="onb-key-recommend-name">${escape(nameText)}</span>
              ${isConfigured ? `<span class="onb-key-recommend-dot" title="configured">●</span>` : ""}
            </div>
            <div class="onb-key-recommend-body">${escape(bodyText)}</div>
          </button>
        `;
      }).join("");

      // Single-model cards · one key reaches one model family. xAI
      // auto-hides when the /api/models cache reports zero reachable
      // models for it (registry currently has no Grok rows; cards
      // re-appear automatically once a Grok entry returns). Reuses
      // the legacy `.onb-key-direct` class for visual continuity.
      const cache = (typeof window !== "undefined" && typeof window.boardroomModels === "function")
        ? window.boardroomModels() : null;
      const allModels = (cache && Array.isArray(cache.models)) ? cache.models : [];
      const singleCards = SINGLE_MODEL_CARDS.filter((p) => {
        // Hide the card when the registry has no models for that
        // provider AND the cache is loaded (avoids race · pre-cache
        // we show every card and let post-cache re-render filter).
        if (!cache) return true;
        return allModels.some((m) => m && m.provider === p.slug);
      }).map((p) => {
        const isActive = p.slug === active.slug;
        const isConfigured = providerConfigured[p.slug];
        return `
          <button type="button"
                  class="onb-key-direct${isActive ? " active" : ""}${isConfigured ? " configured" : ""}"
                  data-onb-provider="${escape(p.slug)}">
            <span class="onb-key-direct-label">${escape(p.label)}</span>
            ${isConfigured ? `<span class="onb-key-direct-dot" title="configured">●</span>` : ""}
          </button>
        `;
      }).join("");

      const status = providerConfigured[active.slug]
        ? `<div class="onb-key-status ok">● ${escape(active.label)} key configured</div>`
        : "";

      head.innerHTML = `
        <div class="onb-tag">${escape(t("onb_v2_key_kicker"))}</div>
        <div class="onb-title onb-title-serif">${escape(t("onb_v2_key_title"))}</div>
        <div class="onb-deck">${escape(t("onb_v2_key_body"))}</div>
      `;
      body.innerHTML = `
        <div class="onb-key-frame">
          <div class="onb-key-section-deck">${escape(t("onb_v2_multi_pitch_intro"))}</div>
          ${multiCards}
          <div class="onb-key-or">
            <span class="onb-key-or-line"></span>
            <span class="onb-key-or-text">${escape(t("onb_v2_key_or"))}</span>
            <span class="onb-key-or-line"></span>
          </div>
          <div class="onb-key-or-body">${escape(t("onb_v2_single_pitch_intro"))}</div>
          <div class="onb-key-directs">${singleCards}</div>
          <div class="onb-field">
            <div class="onb-field-label" data-onb-field-label>${escape(active.label)} API key</div>
            <div class="onb-input-wrap">
              <input class="onb-input" data-onb-key type="password" placeholder="${escape(active.placeholder)}" autocomplete="one-time-code" data-lpignore="true" data-1p-ignore="true" data-form-type="other" spellcheck="false" value="">
              <button type="button" class="onb-input-reveal" data-onb-reveal aria-label="Show key" aria-pressed="false">show</button>
            </div>
            ${status}
            <div class="onb-field-hint">
              <a href="${escape(active.helpUrl)}" target="_blank" rel="noopener" data-onb-help-link>${escape(active.help)} →</a>
            </div>
          </div>
        </div>
      `;
      const enableNext = anyKeyConfigured();
      actions.innerHTML = `<button type="button" class="onb-btn primary" data-onb-next ${enableNext ? "" : "disabled"}>${escape(t("onb_v2_continue"))}</button>`;
    }

    else if (currentStep === 3) {
      // Voice / TTS · OPTIONAL. Skippable for users who want to stay
      // text-only. Reuses the `<template id="vonb-themes">` voice-room
      // preview (also used by the marketing voice-onboarding overlay)
      // for the banner image — the styles ship in voice-onboarding.css
      // scoped under `.vonb-banner`, which we mirror here.
      const activeVoice = VOICE_PROVIDERS.find((p) => p.slug === activeVoiceProvider) || VOICE_PROVIDERS[0];

      const voiceChips = VOICE_PROVIDERS.map((p) => {
        const isActive = p.slug === activeVoice.slug;
        const isConfigured = voiceProviderConfigured[p.slug];
        return `
          <button type="button"
                  class="onb-key-direct${isActive ? " active" : ""}${isConfigured ? " configured" : ""}"
                  data-onb-voice-provider="${escape(p.slug)}">
            <span class="onb-key-direct-label">${escape(p.label)}</span>
            ${isConfigured ? `<span class="onb-key-direct-dot" title="configured">●</span>` : ""}
          </button>
        `;
      }).join("");

      const voiceStatus = voiceProviderConfigured[activeVoice.slug]
        ? `<div class="onb-key-status ok">● ${escape(activeVoice.label)} key configured</div>`
        : "";

      head.innerHTML = `
        <div class="onb-tag">${escape(t("onb_v2_voice_kicker"))}</div>
        <div class="onb-title onb-title-serif">${escape(t("onb_v2_voice_title"))}</div>
        <div class="onb-deck">${escape(t("onb_v2_voice_body"))}</div>
      `;
      body.innerHTML = `
        <div class="onb-voice">
          <div class="vonb-banner onb-voice-banner" data-onb-voice-banner></div>
          <p class="onb-voice-pitch">${escape(t("onb_v2_voice_pitch"))}</p>
          <div class="onb-key-directs onb-voice-providers">${voiceChips}</div>
          <div class="onb-field onb-voice-field">
            <div class="onb-field-label" data-onb-voice-field-label>${escape(activeVoice.label)} API key</div>
            <div class="onb-input-wrap">
              <input class="onb-input" data-onb-voice-key type="password" placeholder="${escape(activeVoice.placeholder)}" autocomplete="one-time-code" data-lpignore="true" data-1p-ignore="true" data-form-type="other" spellcheck="false" value="">
              <button type="button" class="onb-input-reveal" data-onb-voice-reveal aria-label="Show key" aria-pressed="false">show</button>
            </div>
            ${voiceStatus}
            <div class="onb-field-hint">
              <a href="${escape(activeVoice.helpUrl)}" target="_blank" rel="noopener" data-onb-voice-help-link>${escape(activeVoice.help)} →</a>
            </div>
          </div>
        </div>
      `;
      // Mount the room preview by cloning the chosen theme from the
      // shared template. Cycle the theme on each fresh render so a
      // user who Back-and-forwards sees variety.
      mountVoiceBanner();
      // Skip is always available; Continue mirrors it for users who
      // typed a key (style-emphasises completion). Both advance to
      // the cast step.
      const hasVoice = anyVoiceKeyConfigured();
      actions.innerHTML = `
        <button type="button" class="onb-btn" data-onb-action="voice-skip">${escape(t("onb_v2_voice_skip"))}</button>
        <button type="button" class="onb-btn primary" data-onb-action="voice-continue">${escape(hasVoice ? t("onb_v2_continue") : t("onb_v2_voice_skip_cta"))}</button>
      `;
    }

    else if (currentStep === 4) {
      head.innerHTML = `
        <div class="onb-tag">${escape(t("onb_v2_cast_kicker"))}</div>
        <div class="onb-title onb-title-serif">${escape(t("onb_v2_cast_title"))}</div>
        <div class="onb-deck">${escape(t("onb_v2_cast_body"))}</div>
      `;
      const cells = CAST_PREVIEW.map((c) => `
        <span class="onb-cast-cell" title="${escape(c.name)} · ${escape(c.role)}">
          <img class="onb-cast-av" src="avatars/${escape(c.slug)}.svg" alt="${escape(c.name)}">
          <span class="onb-cast-name">${escape(c.name)}</span>
          <span class="onb-cast-role">${escape(c.role)}</span>
        </span>
      `).join("");
      // Three-stage microflow connecting "cast preview" → what the
      // user does next at the composer. Disambiguates the otherwise-
      // floating CTA: pressing "I'm ready" lands them on an empty
      // composer where these three steps actually happen.
      const nextSteps = [1, 2, 3].map((n) => `
        <div class="onb-cast-next-step">
          <span class="onb-cast-next-num">0${n}</span>
          <span class="onb-cast-next-label">${escape(t("onb_v2_cast_next_step_" + n))}</span>
        </div>
      `).join(`<span class="onb-cast-next-arrow" aria-hidden="true">→</span>`);
      body.innerHTML = `
        <div class="onb-cast">
          <div class="onb-cast-kicker">${escape(t("onb_v2_cast_lineup"))}</div>
          <div class="onb-cast-grid" data-no-agent-overlay>${cells}</div>
          <div class="onb-cast-next">
            <div class="onb-cast-next-kicker">${escape(t("onb_v2_cast_next_kicker"))}</div>
            <div class="onb-cast-next-flow">${nextSteps}</div>
          </div>
        </div>
      `;
      actions.innerHTML = `<button type="button" class="onb-btn primary" data-onb-action="finish">${escape(t("onb_v2_ready"))}</button>`;
    }
  }

  /** Paint the step-3 voice banner. Two-stage progressive enhancement:
   *  1. Try the LIVE Three.js scene via `window.mountVoice3dBanner`
   *     · same scene as the marketing homepage hero, brainstorm
   *     tone (red brick + soil/grass floor + plants). User can
   *     drag-orbit the camera; speaker rotates every 4 s.
   *  2. If WebGL isn't available / `prefers-reduced-motion: reduce`
   *     / module import fails → fall back to the static 3D poster
   *     image (`home-3d-poster.webp`). Same artwork, no
   *     interactivity.
   *  3. If the poster file 404s too → JS `onerror` hides the broken
   *     icon and the `.onb-voice-banner-missing` gradient
   *     placeholder shows — still legible chrome, just un-illustrated.
   *
   *  Caller stashes the unmount fn in `_voice3dBannerStop` so the
   *  next `renderStep()` tears down WebGL cleanly. */
  function mountVoiceBanner() {
    const slot = overlay && overlay.querySelector("[data-onb-voice-banner]");
    if (!slot) return;
    slot.innerHTML = `<div class="onb-voice-banner-stage" data-onb-voice-banner-stage></div>`;
    const stage = slot.querySelector("[data-onb-voice-banner-stage]");
    if (stage && typeof window.mountVoice3dBanner === "function") {
      const stop = window.mountVoice3dBanner(stage);
      if (stop) {
        _voice3dBannerStop = stop;
        return;
      }
    }
    // Fallback · static poster image, then gradient placeholder if
    // the poster file isn't deployed yet.
    slot.innerHTML = `
      <picture class="onb-voice-banner-pic">
        <source srcset="home-3d-poster.webp" type="image/webp">
        <img src="home-3d-poster.jpg"
             alt=""
             loading="lazy" decoding="async"
             onerror="this.style.display='none'; this.parentElement.parentElement.classList.add('onb-voice-banner-missing');">
      </picture>
    `;
  }

  // ── Actions ────────────────────────────────────────────
  function next() {
    if (currentStep === 0) {
      const v = overlay.querySelector("[data-onb-name]").value;
      void saveName(v);
    } else if (currentStep === 2) {
      // Gated · MUST have at least one provider key configured to advance.
      if (!anyKeyConfigured()) return;
    }
    currentStep = Math.min(currentStep + 1, STEP_COUNT - 1);
    renderStep();
  }
  function back() {
    currentStep = Math.max(currentStep - 1, 0);
    renderStep();
  }

  /** Paint the "configured" green dot on whatever element represents
   *  `slug` on step 2. The recommended OpenRouter card uses
   *  `.onb-key-recommend-dot` (anchored inside the head row); direct
   *  provider chips use `.onb-key-direct-dot` (trailing the label).
   *  Abstracts the structural difference so the single-provider
   *  invariant + initial render share one helper. */
  function paintProviderConfigured(slug, isConfigured) {
    const el = overlay && overlay.querySelector(`[data-onb-provider="${slug}"]`);
    if (!el) return;
    el.classList.toggle("configured", isConfigured);
    el.querySelectorAll(".onb-key-recommend-dot, .onb-key-direct-dot").forEach((d) => d.remove());
    if (!isConfigured) return;
    if (el.classList.contains("onb-key-recommend")) {
      const head = el.querySelector(".onb-key-recommend-head") || el;
      head.insertAdjacentHTML("beforeend", `<span class="onb-key-recommend-dot" title="configured">●</span>`);
    } else {
      el.insertAdjacentHTML("beforeend", `<span class="onb-key-direct-dot" title="configured">●</span>`);
    }
  }

  function selectProvider(slug) {
    if (!(slug in providerConfigured)) return;
    if (activeProvider === slug) return;
    activeProvider = slug;

    const active = KEY_PROVIDERS.find((p) => p.slug === slug) || KEY_PROVIDERS[0];

    // Toggle active on every provider-bearing element (the recommend
    // card + the direct chips share the same data-attr so the same
    // query covers both).
    overlay.querySelectorAll("[data-onb-provider]").forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-onb-provider") === slug);
    });

    const fieldLabel = overlay.querySelector("[data-onb-field-label]");
    if (fieldLabel) fieldLabel.textContent = `${active.label} API key`;

    const input = overlay.querySelector("[data-onb-key]");
    if (input) input.setAttribute("placeholder", active.placeholder);

    const helpLink = overlay.querySelector("[data-onb-help-link]");
    if (helpLink) {
      helpLink.setAttribute("href", active.helpUrl);
      helpLink.textContent = `${active.help} →`;
    }

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

  /** Repaint the inline status row (warn / ok / error) under the
   *  active LLM key field. `mode` is "warn" | "error" | "ok". The
   *  caller passes the rendered text; we own the DOM swap so the
   *  validation + checking + saved flows share one slot. */
  function setKeyStatus(mode, text) {
    if (!overlay) return;
    const wrap = overlay.querySelector("[data-onb-key]")?.closest(".onb-field");
    if (!wrap) return;
    const existing = wrap.querySelector(".onb-key-status");
    const cls = mode === "ok" ? "ok" : mode === "error" ? "error" : "warn";
    const glyph = mode === "ok" ? "●" : mode === "error" ? "✗" : "○";
    const html = `<div class="onb-key-status ${cls}">${glyph} ${escape(text)}</div>`;
    if (existing) existing.outerHTML = html;
    else {
      const inputWrap = wrap.querySelector(".onb-input-wrap");
      if (inputWrap) inputWrap.insertAdjacentHTML("afterend", html);
    }
  }

  function setKeyInputInvalid(invalid) {
    if (!overlay) return;
    const input = overlay.querySelector("[data-onb-key]");
    if (input) input.classList.toggle("onb-input-invalid", !!invalid);
  }

  async function trySaveKey(value) {
    const provider = activeProvider;
    const label = (KEY_PROVIDERS.find((p) => p.slug === provider) || {}).label || provider;
    const nextBtn = overlay.querySelector("[data-onb-next]");

    // ── Static format check · skip the round-trip when the pasted
    //    value is obviously not a real key (typos, "123", wrong
    //    provider slot). The validator is loaded as a separate
    //    script; if it hasn't landed yet we degrade to the prior
    //    pass-through behaviour.
    const validator = window.boardroomKeyValidator;
    if (validator) {
      const result = validator.validate(provider, value);
      if (result.code === "empty") {
        // User cleared the field · drop any stale warning + status
        // (but keep the green "configured" pill if a prior save
        // landed; that's still true on the server).
        if (!providerConfigured[provider]) {
          const existing = overlay.querySelector("[data-onb-key]")?.closest(".onb-field")?.querySelector(".onb-key-status");
          if (existing) existing.remove();
        }
        setKeyInputInvalid(false);
        return;
      }
      if (!result.ok) {
        setKeyInputInvalid(true);
        setKeyStatus("warn", validator.describe(result));
        if (nextBtn) nextBtn.disabled = !anyKeyConfigured();
        return;
      }
    }
    setKeyInputInvalid(false);

    setKeyStatus("warn", "checking…");
    const ok = await saveProviderKey(provider, value);
    const fresh = overlay.querySelector(".onb-key-status, [class^=onb-key-status]");
    if (ok) {
      // Backend now enforces single-active-LLM-provider atomically
      // (setActiveLlmKey in src/storage/keys.ts wipes every other LLM
      // row in the same transaction). No client-side DELETE loop
      // needed; just re-paint the sibling dots from the fresh meta.
      for (const slug of Object.keys(providerConfigured)) {
        if (slug === provider) continue;
        if (providerConfigured[slug]) {
          providerConfigured[slug] = false;
          paintProviderConfigured(slug, false);
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
      paintProviderConfigured(provider, true);
      if (nextBtn) nextBtn.disabled = false;
    } else {
      if (fresh) fresh.outerHTML = `<div class="onb-key-status error">✗ not saved</div>`;
      if (nextBtn) nextBtn.disabled = !anyKeyConfigured();
    }
  }

  /** Toggle the active voice chip (MiniMax · ElevenLabs) on step 3
   *  and swap the input affordances (label / placeholder / help link
   *  / status pill) without re-rendering the step. Mirrors
   *  selectProvider() but for the voice-only chip group. */
  function selectVoiceProvider(slug) {
    if (!(slug in voiceProviderConfigured)) return;
    if (activeVoiceProvider === slug) return;
    activeVoiceProvider = slug;
    const active = VOICE_PROVIDERS.find((p) => p.slug === slug) || VOICE_PROVIDERS[0];

    overlay.querySelectorAll("[data-onb-voice-provider]").forEach((el) => {
      el.classList.toggle("active", el.getAttribute("data-onb-voice-provider") === slug);
    });

    const fieldLabel = overlay.querySelector("[data-onb-voice-field-label]");
    if (fieldLabel) fieldLabel.textContent = `${active.label} API key`;

    const input = overlay.querySelector("[data-onb-voice-key]");
    if (input) input.setAttribute("placeholder", active.placeholder);

    const helpLink = overlay.querySelector("[data-onb-voice-help-link]");
    if (helpLink) {
      helpLink.setAttribute("href", active.helpUrl);
      helpLink.textContent = `${active.help} →`;
    }

    const wrap = input ? input.closest(".onb-field") : null;
    const existing = wrap ? wrap.querySelector(".onb-key-status") : null;
    if (existing) existing.remove();
    if (voiceProviderConfigured[slug] && wrap) {
      wrap.querySelector(".onb-input-wrap").insertAdjacentHTML(
        "afterend",
        `<div class="onb-key-status ok">● ${escape(active.label)} key configured</div>`,
      );
    }
  }

  /** Paint the "configured" green dot on a voice-provider chip. Voice
   *  chips are always `.onb-key-direct` so this is simpler than the
   *  LLM equivalent. */
  function paintVoiceProviderConfigured(slug, isConfigured) {
    const el = overlay && overlay.querySelector(`[data-onb-voice-provider="${slug}"]`);
    if (!el) return;
    el.classList.toggle("configured", isConfigured);
    el.querySelectorAll(".onb-key-direct-dot").forEach((d) => d.remove());
    if (isConfigured) {
      el.insertAdjacentHTML("beforeend", `<span class="onb-key-direct-dot" title="configured">●</span>`);
    }
  }

  function setVoiceKeyStatus(mode, text) {
    if (!overlay) return;
    const wrap = overlay.querySelector("[data-onb-voice-key]")?.closest(".onb-field");
    if (!wrap) return;
    const existing = wrap.querySelector(".onb-key-status");
    const cls = mode === "ok" ? "ok" : mode === "error" ? "error" : "warn";
    const glyph = mode === "ok" ? "●" : mode === "error" ? "✗" : "○";
    const html = `<div class="onb-key-status ${cls}">${glyph} ${escape(text)}</div>`;
    if (existing) existing.outerHTML = html;
    else {
      const inputWrap = wrap.querySelector(".onb-input-wrap");
      if (inputWrap) inputWrap.insertAdjacentHTML("afterend", html);
    }
  }

  function setVoiceKeyInputInvalid(invalid) {
    if (!overlay) return;
    const input = overlay.querySelector("[data-onb-voice-key]");
    if (input) input.classList.toggle("onb-input-invalid", !!invalid);
  }

  async function trySaveVoiceKey(value) {
    const provider = activeVoiceProvider;
    const label = (VOICE_PROVIDERS.find((p) => p.slug === provider) || {}).label || provider;

    // Static format check · same gate as the LLM key field. Voice
    // keys are optional (step 3 is skippable) so we still suppress
    // the warning when the value is blank — typing nothing is a
    // valid choice here, not an error.
    const validator = window.boardroomKeyValidator;
    if (validator) {
      const result = validator.validate(provider, value);
      if (result.code === "empty") {
        if (!voiceProviderConfigured[provider]) {
          const wrap = overlay.querySelector("[data-onb-voice-key]")?.closest(".onb-field");
          const existing = wrap && wrap.querySelector(".onb-key-status");
          if (existing) existing.remove();
        }
        setVoiceKeyInputInvalid(false);
        return;
      }
      if (!result.ok) {
        setVoiceKeyInputInvalid(true);
        setVoiceKeyStatus("warn", validator.describe(result));
        return;
      }
    }
    setVoiceKeyInputInvalid(false);

    setVoiceKeyStatus("warn", "checking…");
    const ok = await saveVoiceKey(provider, value);
    const wrap = overlay.querySelector("[data-onb-voice-key]")?.closest(".onb-field");
    const fresh = wrap && wrap.querySelector(".onb-key-status");
    if (ok) {
      if (fresh) fresh.outerHTML = `<div class="onb-key-status ok">● ${escape(label)} key configured</div>`;
      else if (wrap) wrap.querySelector(".onb-input-wrap").insertAdjacentHTML(
        "afterend",
        `<div class="onb-key-status ok">● ${escape(label)} key configured</div>`,
      );
      paintVoiceProviderConfigured(provider, true);
      // Update the continue button label · "Skip for now" → "Continue".
      const cont = overlay.querySelector("[data-onb-action='voice-continue']");
      if (cont) cont.textContent = t("onb_v2_continue");
    } else {
      if (fresh) fresh.outerHTML = `<div class="onb-key-status error">✗ not saved</div>`;
    }
  }

  /** rAF with a setTimeout fallback for environments without
   *  requestAnimationFrame (test harnesses, very old browsers). */
  const raf = (cb) => (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function")
    ? window.requestAnimationFrame(cb)
    : setTimeout(cb, 16);

  /** Mount the once-only composer-hint tooltip. Polls briefly for the
   *  composer textarea since app.js renders it after onboarding closes,
   *  on the next animation frame. Bails after ~3 seconds if it never
   *  appears (e.g., user navigated elsewhere). */
  function installFirstComposerHint() {
    try {
      if (localStorage.getItem(FIRST_HINT_KEY) === "seen") return;
    } catch (e) { /* */ }

    const deadline = Date.now() + 3000;
    const tryMount = () => {
      const ta = document.querySelector("[data-composer-subject]");
      if (!ta) {
        if (Date.now() > deadline) return;
        raf(tryMount);
        return;
      }

      const hint = document.createElement("div");
      hint.className = "onb-composer-hint";
      hint.setAttribute("role", "tooltip");
      hint.innerHTML = `
        <div class="onb-composer-hint-arrow"></div>
        <div class="onb-composer-hint-kicker">${escape(t("onb_v2_hint_kicker"))}</div>
        <div class="onb-composer-hint-body">${escape(t("onb_v2_hint_body"))}</div>
        <button type="button" class="onb-composer-hint-dismiss" data-onb-hint-dismiss>${escape(t("onb_v2_hint_dismiss"))}</button>
      `;
      document.body.appendChild(hint);

      const position = () => {
        const rect = ta.getBoundingClientRect();
        // Anchor below the textarea, horizontally centered to it.
        // viewportClamped — keep within 12px of edges.
        const hintRect = hint.getBoundingClientRect();
        const targetCenter = rect.left + rect.width / 2;
        const half = hintRect.width / 2;
        const minLeft = 12;
        const maxLeft = window.innerWidth - hintRect.width - 12;
        const left = Math.max(minLeft, Math.min(maxLeft, targetCenter - half));
        const top = rect.bottom + 14;
        hint.style.left = `${Math.round(left)}px`;
        hint.style.top = `${Math.round(top)}px`;
        // Arrow horizontal offset relative to hint, so it stays pointed
        // at the textarea even when the hint is clamped.
        const arrowLeft = targetCenter - left;
        const arrow = hint.querySelector(".onb-composer-hint-arrow");
        if (arrow) arrow.style.left = `${Math.round(arrowLeft)}px`;
      };

      // Two-pass: paint once for size, then position.
      raf(() => {
        position();
        hint.classList.add("open");
      });

      let dismissed = false;
      const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        try { localStorage.setItem(FIRST_HINT_KEY, "seen"); } catch (e) {}
        hint.classList.remove("open");
        window.removeEventListener("resize", position);
        window.removeEventListener("scroll", position, true);
        document.removeEventListener("click", onAnyClick, true);
        document.removeEventListener("keydown", onAnyKey, true);
        setTimeout(() => { hint.remove(); }, 200);
      };
      const onAnyClick = (e) => {
        // Let the dismiss button work normally; otherwise any click
        // anywhere dismisses (including typing into the composer).
        dismiss();
      };
      const onAnyKey = () => dismiss();

      window.addEventListener("resize", position);
      window.addEventListener("scroll", position, true);
      // Slight delay so the click that closed the onboarding modal
      // doesn't immediately register as "click anywhere".
      setTimeout(() => {
        document.addEventListener("click", onAnyClick, true);
        document.addEventListener("keydown", onAnyKey, true);
      }, 120);
    };
    raf(tryMount);
  }

  function complete() {
    try { localStorage.setItem(ONBOARDED_KEY, "true"); } catch (e) {}
    document.body.classList.remove("onb-locked");
    overlay.classList.remove("open");
    setTimeout(() => {
      if (overlay) overlay.remove();
      overlay = null;
    }, 220);

    // Sync caches the server mutated during key save.
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
    Promise.all(refreshes).finally(() => {
      // Pin composer mode to "room" so we don't land on agent composer
      // after a boot-race with refreshAgents.
      if (window.app && typeof window.app.setComposerMode === "function") {
        try { window.app.setComposerMode("room"); } catch (e) { /* */ }
      }
      installFirstComposerHint();
    });
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
      const providerChoice = t.closest("[data-onb-provider]");
      if (providerChoice) {
        e.preventDefault();
        const slug = providerChoice.getAttribute("data-onb-provider");
        if (slug) selectProvider(slug);
        return;
      }
      const voiceChoice = t.closest("[data-onb-voice-provider]");
      if (voiceChoice) {
        e.preventDefault();
        const slug = voiceChoice.getAttribute("data-onb-voice-provider");
        if (slug) selectVoiceProvider(slug);
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
      const voiceReveal = t.closest("[data-onb-voice-reveal]");
      if (voiceReveal) {
        e.preventDefault();
        const input = overlay.querySelector("[data-onb-voice-key]");
        if (!input) return;
        const showing = input.getAttribute("type") === "text";
        input.setAttribute("type", showing ? "password" : "text");
        voiceReveal.setAttribute("aria-pressed", showing ? "false" : "true");
        voiceReveal.setAttribute("aria-label", showing ? "Show key" : "Hide key");
        voiceReveal.textContent = showing ? "show" : "hide";
        return;
      }
      const action = t.closest("[data-onb-action]");
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        const a = action.getAttribute("data-onb-action");
        if (a === "finish") {
          complete();
        } else if (a === "voice-skip" || a === "voice-continue") {
          // Both buttons advance — Skip is the soft path, Continue is
          // styled as primary once a key landed. The user's typed-but-
          // unsaved key is discarded by design (the debounce already
          // saved any complete key); we don't force-finalize on advance.
          currentStep = Math.min(currentStep + 1, STEP_COUNT - 1);
          renderStep();
        }
        return;
      }
    });

    overlay.addEventListener("input", (e) => {
      const t = e.target;
      if (t.matches("[data-onb-name]")) {
        prefsCache.name = t.value;
      } else if (t.matches("[data-onb-key]")) {
        clearTimeout(t.__onbTimer);
        t.__onbTimer = setTimeout(() => trySaveKey(t.value), 280);
      } else if (t.matches("[data-onb-voice-key]")) {
        clearTimeout(t.__onbTimer);
        t.__onbTimer = setTimeout(() => trySaveVoiceKey(t.value), 280);
      }
    });

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
    // Claim the dashboard sub-state so the restore tick doesn't race
    // refreshAgents and land the user on a stale agent profile.
    // (See feedback_substate_restore_race.)
    try {
      localStorage.setItem("boardroom.sidebar.tab", "rooms");
      localStorage.setItem("boardroom.sidebar.agents", "new");
    } catch (e) {}
    // Cycle the step-3 voice-room preview theme each open so replay
    // feels alive. Persists across sessions through localStorage.
    try {
      const raw = localStorage.getItem("boardroom.onb.voiceThemeIdx");
      const idx = raw == null ? 0 : (parseInt(raw, 10) || 0);
      const n = VOICE_PREVIEW_THEMES.length;
      const cur = ((idx % n) + n) % n;
      voicePreviewTheme = VOICE_PREVIEW_THEMES[cur] || "regent";
      localStorage.setItem("boardroom.onb.voiceThemeIdx", String((cur + 1) % n));
    } catch (e) { voicePreviewTheme = "regent"; }
    const wrap = document.createElement("div");
    wrap.innerHTML = modalHTML().trim();
    document.body.appendChild(wrap.firstChild);
    overlay = document.getElementById("onb-overlay");
    overlay.classList.add("open");
    document.body.classList.add("onb-locked");
    renderStep();
    wire();

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

  /** Replay entry point · used by user-settings "replay onboarding"
   *  row for users who already onboarded once and want to revisit
   *  the story. Resets per-run state (currentStep, provider cache)
   *  and the once-only composer-hint flag so the full flow plays
   *  again. Does NOT clear the user's saved name / theme / keys —
   *  those are surfaced by loadInitial() and rendered as-is, so the
   *  user sees their existing config rather than a blank slate. */
  async function replay() {
    try { localStorage.removeItem(FIRST_HINT_KEY); } catch (e) {}
    currentStep = 0;
    // Reload prefs + keys so step 2 reflects the user's CURRENT
    // provider state (they may have added or removed keys since the
    // first run).
    try { await loadInitial(); } catch (e) {}
    if (document.getElementById("onb-overlay")) return;
    show();
  }

  window.boardroomShowOnboarding = show; // exposed for testing
  window.boardroomReplayOnboarding = replay;
})();
