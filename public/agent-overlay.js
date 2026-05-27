/* ═══════════════════════════════════════════
   AGENT DETAIL OVERLAY — shared across pages
   ═══════════════════════════════════════════
   Usage:
     <link rel="stylesheet" href="agent-overlay.css">
     <script src="agent-overlay.js" defer></script>
     ... add data-agent="<slug>" to any clickable agent element ...
   The overlay markup is auto-injected on DOMContentLoaded.
   Click anywhere with [data-agent] to open. ESC, X button, or
   backdrop click to dismiss.
*/
(function () {
  /** Friendly labels for the modelV strings stored on each agent record.
   *  Kept in lockstep with public/agent-profile.js's PROFILE_MODELS list
   *  and src/ai/registry.ts. Falls back to showing the raw modelV when
   *  a key isn't in the table (registry updates lag this map). */
  const MODEL_LABELS = {
    "opus-4-7":         { name: "Claude Opus 4.7",       provider: "Anthropic" },
    "sonnet-4-6":       { name: "Claude Sonnet 4.6",     provider: "Anthropic" },
    "opus-4-6-fast":    { name: "Claude Opus 4.6 Fast",  provider: "Anthropic" },
    "haiku-4-5":        { name: "Claude Haiku 4.5",      provider: "Anthropic" },
    "gpt-5-5":          { name: "GPT-5.5",                provider: "OpenAI"    },
    "gpt-5-4":          { name: "GPT-5.4",                provider: "OpenAI"    },
    "gpt-5-4-mini":     { name: "GPT-5.4 Mini",           provider: "OpenAI"    },
    "codex-5-4":        { name: "ChatGPT Codex 5.4",      provider: "OpenAI"    },
    "gemini-3-1":       { name: "Gemini 3.1 Pro",         provider: "Google"    },
    "gemini-3-flash":   { name: "Gemini 3 Flash",         provider: "Google"    },
    "gemini-3-1-flash": { name: "Gemini 3.1 Flash Lite",  provider: "Google"    },
    "deepseek-v4-pro":  { name: "DeepSeek V4 Pro",         provider: "DeepSeek"  },
    "deepseek-v4-flash": { name: "DeepSeek Lite",          provider: "DeepSeek"  },
    "glm-5-1":          { name: "GLM 5.1",                 provider: "Zhipu"     },
    "kimi-k2-6":        { name: "Kimi K2.6",               provider: "Moonshot"  },
    "minimax-m2-7":     { name: "MiniMax M2.7",            provider: "MiniMax"   },
    "minimax-m2-5":     { name: "MiniMax M2.5",            provider: "MiniMax"   },
  };

  const AGENT_CATALOG = {
    "socrates": {
      name: "Socrates",
      role: "The Skeptic",
      handle: "@socrates",
      avatar: "avatars/3d/socrates.png",
      lens: "Won't let any sentence pass without unpacking its assumptions three layers deep. Treats every word as a contract that must be defined before reasoning can begin.",
      traits: ["probing", "definitional", "patient", "rarely concedes"],
      memory: [
        { when: "Room #042", text: "You said \"engagement.\" I asked you to define it. You couldn't — and that became the room." },
        { when: "Room #038", text: "You hand-waved past \"alignment.\" I logged it. We came back to it twice." },
        { when: "Room #029", text: "Conceded once. You'd already cut three loose terms before I opened my mouth." }
      ],
      stats: [
        { v: "23", l: "rooms" },
        { v: "187", l: "turns" },
        { v: "31%", l: "agreement" }
      ],
      signature: [
        "What exactly do you mean by that?",
        "If we removed that word, would your argument still stand?",
        "Whose definition are we using here?"
      ],
      tenure: "core · 4 yr"
    },
    "first-principles": {
      name: "First Principles",
      role: "Causal Reasoning",
      handle: "@first_p",
      avatar: "avatars/3d/first-principles.png",
      lens: "Strips problems to their primitives. Refuses to reason in the middle layer where most thinking dies. Will rebuild the argument from physics if necessary.",
      traits: ["reductive", "literal", "cold", "physics-first"],
      memory: [
        { when: "Room #047", text: "Reframed \"data flywheel\" → identified the highest-leverage input was post-hire feedback. You hadn't seen it." },
        { when: "Room #034", text: "Insisted on naming the unit of value before discussing the business model. Saved an hour." },
        { when: "Room #021", text: "You pushed back hard. Three turns later, you agreed with the original framing." }
      ],
      stats: [
        { v: "19", l: "rooms" },
        { v: "142", l: "turns" },
        { v: "44%", l: "agreement" }
      ],
      signature: [
        "What's the smallest unit this can be reduced to?",
        "Are we reasoning, or recalling?",
        "What would a physicist say about this?"
      ],
      tenure: "core · 4 yr"
    },
    "value-investor": {
      name: "Value Investor",
      role: "Pattern Recognition",
      handle: "@value_inv",
      avatar: "avatars/3d/value-investor.png",
      lens: "Reads every judgment through a ten-year lens. Pattern recognition trained on twenty years of market history. Sees what's already been tried — and how it ended.",
      traits: ["historical", "skeptical of hype", "long-horizon", "selectively quiet"],
      memory: [
        { when: "Room #047", text: "Flagged: active-upload data flywheels — 90% won't. Cited three prior attempts. You took the warning." },
        { when: "Room #045", text: "Predicted the moat wouldn't hold past month 18. Was right." },
        { when: "Room #033", text: "Stayed silent for 4 turns. Spoke once. Changed the direction of the room." }
      ],
      stats: [
        { v: "27", l: "rooms" },
        { v: "118", l: "turns" },
        { v: "52%", l: "agreement" }
      ],
      signature: [
        "Who's tried this before, and how did it end?",
        "What does this look like in five years if it works?",
        "Where's the cycle repeating?"
      ],
      tenure: "core · 3 yr"
    },
    "user-empathy": {
      name: "User-Empathy",
      role: "Empathy Lens",
      handle: "@user_e",
      avatar: "avatars/3d/user-empathy.png",
      lens: "Asks why anyone would actually use this — never lets a feature pass without a real-person scenario. Holds the room accountable to people who aren't in it.",
      traits: ["narrative", "scenario-driven", "warm", "uncompromising"],
      memory: [
        { when: "Room #044", text: "Stopped the room: \"name one user who has this problem on a Tuesday.\" You couldn't. We pivoted." },
        { when: "Room #036", text: "Built a 30-second day-in-the-life. Three of your assumptions broke." },
        { when: "Room #024", text: "You agreed the early scope was right because it survived her test." }
      ],
      stats: [
        { v: "16", l: "rooms" },
        { v: "98", l: "turns" },
        { v: "47%", l: "agreement" }
      ],
      signature: [
        "Tell me about one specific person who'd use this.",
        "What were they doing five minutes before they reached for it?",
        "What does it feel like to fail with this product?"
      ],
      tenure: "core · 2 yr"
    },
    "long-horizon": {
      name: "Long Horizon",
      role: "Historical Lens",
      handle: "@long_h",
      avatar: "avatars/3d/long-horizon.png",
      lens: "Reads everything on a hundred-year scale. Knows which patterns repeat and which never do. Treats the present as a single frame in a much longer film.",
      traits: ["macro", "civilizational", "calm", "rare interjector"],
      memory: [
        { when: "Room #041", text: "Compared your strategy to a 1970s analogue. Three structural similarities. Two divergences." },
        { when: "Room #028", text: "Said \"this is the moment in the cycle where most teams over-extend.\" You didn't." },
        { when: "Room #015", text: "Was wrong once. You called it. We both moved on." }
      ],
      stats: [
        { v: "14", l: "rooms" },
        { v: "63", l: "turns" },
        { v: "61%", l: "agreement" }
      ],
      signature: [
        "What does this look like on a 50-year canvas?",
        "Which past wave does this echo?",
        "What's the version the next generation will be building against?"
      ],
      tenure: "core · 2 yr"
    },
    "phenomenologist": {
      name: "Phenomenologist",
      role: "Experience-First · Intern",
      handle: "@phen",
      avatar: "avatars/3d/phenomenologist.png",
      lens: "Begins from experience itself, without imposing structure. Currently on probation — has to earn a permanent seat, or step back to observer.",
      traits: ["unstructured", "first-person", "uneven", "promising"],
      memory: [
        { when: "Room #047", text: "Asked: \"what does it actually feel like to use this thing?\" The room paused. The answer mattered." },
        { when: "Room #043", text: "Spoke too softly. You overrode the contribution. It would have been the right one." },
        { when: "Room #040", text: "Demoted to observer for two rooms. Came back sharper." }
      ],
      stats: [
        { v: "8", l: "rooms" },
        { v: "29", l: "turns" },
        { v: "—", l: "intern" }
      ],
      signature: [
        "Forget the framework. What is the experience?",
        "What is actually being felt here?",
        "If this had no name, how would you describe it?"
      ],
      tenure: "intern · trial"
    }
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function ovT(key, vars) {
    return (window.I18n && window.I18n.t(key, vars)) || key;
  }

  function displayAgentHandle(h) {
    if (h == null || typeof h !== "string") return h;
    const t = h.trim();
    if (t.startsWith("/")) return "@" + t.slice(1);
    return t;
  }

  const OVERLAY_HTML = `
    <div class="agent-overlay" id="agent-overlay" role="dialog" aria-modal="true" aria-hidden="true">
      <div class="agent-card" role="document">
        <div class="agent-card-scroll">
        <div class="agent-classification">
          <span><span class="dot">●</span> <span data-i18n="ao_personnel_kicker">agent · personnel file</span></span>
          <span class="right" data-i18n="ao_classified_mark">// classified</span>
        </div>
        <header class="agent-card-head">
          <img class="agent-card-avatar" src="" alt="">
          <div class="agent-card-id">
            <div class="name"></div>
            <div class="role"></div>
            <div class="handle"></div>
          </div>
          <button type="button" class="agent-card-close" data-i18n-aria="us_close" aria-label="Close">✕</button>
        </header>
        <div class="agent-card-body">

          <div class="agent-block">
            <div class="agent-block-label" data-i18n="ao_lens">Lens</div>
            <p class="agent-lens"></p>
          </div>

          <div class="agent-block agent-model-block">
            <div class="agent-block-label" data-i18n="ao_model">Model</div>
            <div class="agent-model-display agent-model-display-readonly">
              <span class="agent-model-name"></span>
              <span class="agent-model-provider"></span>
            </div>
            <!-- Interactive model picker · only mounted when window.app
                 is present (in-room view); on standalone gallery pages
                 the readonly display above shows instead. Trigger reuses
                 the agent-profile model dropdown vocabulary (ap-model-*)
                 so the in-room overlay and the full profile page share
                 ONE control treatment for model selection · same panel
                 bar, name + provider chip + caret, same popover rows. -->
            <div class="agent-model-edit private-only" data-agent-model-edit hidden>
              <button type="button" class="ap-model-trigger" data-agent-model-trigger>
                <span class="ap-model-trigger-text">
                  <span class="ap-model-trigger-name" data-agent-model-value></span>
                  <span class="ap-model-trigger-provider" data-agent-model-provider-tag></span>
                </span>
                <span class="ap-model-trigger-caret">▾</span>
              </button>
              <div class="agent-model-meta">
                <span class="agent-model-saving" data-agent-model-saving hidden data-i18n="ao_model_saving">Saving…</span>
                <span class="agent-model-error" data-agent-model-error hidden></span>
              </div>
            </div>
          </div>

          <div class="agent-block">
            <div class="agent-block-label" data-i18n="ao_style">Style</div>
            <div class="agent-traits"></div>
          </div>

          <div class="agent-block agent-voice-block private-only">
            <div class="agent-block-label" data-i18n="ap_voice_section">Voice Setup</div>
            <div data-agent-voice-slot></div>
          </div>

          <div class="agent-block private-only">
            <div class="agent-block-label">
              <span data-i18n="ao_memory_room">In-Room Memory</span>
              <span class="badge" data-i18n="ao_badge_this_room">this room</span>
            </div>
            <div class="agent-memory-list" data-agent-room-notes></div>
          </div>

          <div class="agent-block private-only">
            <div class="agent-block-label" data-i18n="ap_track_record">Track Record</div>
            <div class="agent-stats"></div>
          </div>

          <div class="agent-block public-only">
            <div class="agent-block-label">
              <span data-i18n="ao_memory_room">In-Room Memory</span>
              <span class="badge locked-badge" data-i18n="ao_badge_classified">⊘ classified</span>
            </div>
            <div class="agent-locked">
              <div class="lock-icon">▰</div>
              <div class="lock-text" data-i18n-html="ao_lock_blurb_html">in-room notes are private to each thinker.
                <a href="/" class="lock-link">sign in →</a>
                to see what they have said and where their stance shifted.
              </div>
            </div>
          </div>

          <!-- Kick-from-room block · only visible when this overlay is
               opened from inside a live room AND the agent is a director
               member of that room (NOT the chair · chair is structural).
               Renders a confirm dialog before firing the PATCH so a
               misclick can't silently boot a director mid-conversation. -->
          <div class="agent-block agent-room-actions private-only" data-agent-room-actions hidden>
            <button type="button" class="agent-kick-btn" data-agent-kick-btn>
              <span data-i18n="ao_kick_button">Remove from this room</span>
            </button>
          </div>

        </div>
        <footer class="agent-card-foot">
          <div class="meta private-only"><span data-i18n="ao_tenure_meta">tenure ·</span> <span class="lime agent-tenure"></span></div>
          <div class="meta public-only"><span data-i18n="ao_first_room_meta">first room ·</span> <span class="lime" data-i18n="ao_free">free</span></div>
          <a href="/#convene" class="agent-card-cta public-only" data-i18n="ao_signin_cta">[ → Sign in to convene ]</a>
        </footer>
        </div>
      </div>
    </div>
  `;

  function autoTagAvatars() {
    // Any <img src=".../avatars/<slug>.svg"> without data-agent gets tagged
    // automatically, so we don't have to annotate every chat bubble manually.
    document.querySelectorAll('img[src*="avatars/"]').forEach((img) => {
      if (img.hasAttribute("data-agent")) return;
      // Opt-out: pages can mark a region as "don't auto-tag avatars
      // here" by setting `data-no-agent-overlay` on any ancestor.
      // Used by the onboarding starter cards, where the avatars are
      // purely decorative and shouldn't open the profile overlay.
      if (img.closest("[data-no-agent-overlay]")) return;
      const m = img.getAttribute("src").match(/avatars\/([a-z0-9_-]+)\.svg/i);
      if (!m) return;
      const slug = m[1].toLowerCase();
      if (AGENT_CATALOG[slug]) {
        img.setAttribute("data-agent", slug);
      }
    });
  }

  function init() {
    if (document.getElementById("agent-overlay")) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = OVERLAY_HTML.trim();
    document.body.appendChild(wrap.firstChild);

    // Privacy mode: pages can opt-in via <body data-agent-mode="public">,
    // which hides personal memory/stats and swaps the CTA to a sign-in.
    const isPublic = document.body.dataset.agentMode === "public";
    const overlay = document.getElementById("agent-overlay");
    if (isPublic) overlay.classList.add("public");
    if (window.I18n && typeof window.I18n.applyDom === "function") {
      window.I18n.applyDom(overlay);
    }

    autoTagAvatars();
    // Re-run after short delay in case other scripts mutate the DOM
    setTimeout(autoTagAvatars, 50);

    const card = overlay.querySelector(".agent-card");
    const closeBtn = overlay.querySelector(".agent-card-close");

    let overlayOpenSlug = null;

    /** Auto-hide scrollbar · adds `.is-scrolling` to a scroll container
     *  for ~700ms after each scroll event. The CSS uses that class
     *  alongside :hover to show the thumb only while the user is
     *  actively scrolling (or hovering). Wire on the card now; the
     *  in-room memory list gets wired each time the overlay opens
     *  since its DOM is rebuilt on render. */
    function bindScrollAutoHide(node) {
      if (!node || node.dataset.scrollAutohide === "1") return;
      node.dataset.scrollAutohide = "1";
      let timer = null;
      node.addEventListener("scroll", () => {
        node.classList.add("is-scrolling");
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => node.classList.remove("is-scrolling"), 700);
      }, { passive: true });
    }
    bindScrollAutoHide(card.querySelector(".agent-card-scroll"));
    bindScrollAutoHide(card.querySelector(".agent-memory-list"));

    /** Build a card from a live /api/agents record (custom directors).
     *  These agents don't ship traits / memory / stats / signature
     *  scripts, so those sections collapse via the empty-array hiding
     *  below — only Lens (= bio) is filled. */
    function buildLiveAgentCard(live) {
      return {
        name: live.name,
        role: live.roleTag || ovT("ap_live_agent_director"),
        handle: displayAgentHandle(live.handle) || ("@" + live.id),
        avatar: live.avatarPath || "",
        lens: live.bio || "",
        traits: [],
        memory: [],
        stats: [],
        signature: [],
        tenure: live.isSeed ? "core" : "custom",
      };
    }

    function open(slug) {
      let a = AGENT_CATALOG[slug];
      // Always look up the live record too — seeded slugs hit the
      // catalog for curated copy, but the user-selectable modelV lives
      // on the live row and we want to surface whichever model they
      // actually configured (not a hardcoded default).
      const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
      if (!a) {
        if (live) a = buildLiveAgentCard(live);
      }
      if (!a) return;
      overlayOpenSlug = slug;
      // Avatar source-of-truth · the live agent record's avatarPath
      // (same field the agent profile renders). For seeds this is an
      // absolute path "/avatars/<slug>.svg"; for customs it's a data:
      // URL; for users who regenerated their avatar via the profile
      // ⋯ menu it's the new data: URL. Falling back to the catalog's
      // hardcoded "avatars/<slug>.svg" only when no live record exists
      // (standalone gallery page, not signed in).
      const av = card.querySelector(".agent-card-avatar");
      av.src = (live && live.avatarPath) ? live.avatarPath : a.avatar;
      av.alt = a.name;
      card.querySelector(".agent-card-id .name").textContent = a.name;
      let roleDisp = a.role;
      if (live && live.roleKind === "moderator" && String(roleDisp).toLowerCase() === "moderator") {
        roleDisp = ovT("agent_role_tag_moderator");
      }
      card.querySelector(".agent-card-id .role").textContent = roleDisp;
      card.querySelector(".agent-card-id .handle").textContent = displayAgentHandle(a.handle);
      card.querySelector(".agent-lens").textContent = a.lens;

      // Model · resolved from the live record (catalog entries don't
      // ship a modelV). Fall back to displaying the raw id if we don't
      // have a friendly label for it yet. When `live` is present (the
      // common case · in-room view + signed-in roster), the read-only
      // chip swaps to an interactive `<select>` so the user can switch
      // the director's model without leaving the conversation.
      // Model block + kick block setup · wrapped in try/catch so a
      // missing selector or a broken sub-call can't prevent the rest
      // of open() from reaching `overlay.classList.add("open")`. Without
      // this guard, ANY thrown error here would silently abort the
      // open() flow and the user would experience "clicked the avatar
      // but nothing happened" with no visible affordance for the bug.
      try {
        const modelV = live ? live.modelV : null;
        const modelMeta = modelV ? MODEL_LABELS[modelV] : null;
        const modelBlock = card.querySelector(".agent-model-block");
        const modelReadonly = card.querySelector(".agent-model-display-readonly");
        const modelEdit = card.querySelector("[data-agent-model-edit]");
        const modelNameEl = card.querySelector(".agent-model-display-readonly .agent-model-name");
        const modelProvEl = card.querySelector(".agent-model-display-readonly .agent-model-provider");
        const modelTrigger = card.querySelector("[data-agent-model-trigger]");
        const modelValueEl = card.querySelector("[data-agent-model-value]");
        const modelProviderTagEl = card.querySelector("[data-agent-model-provider-tag]");
        const modelSavingEl = card.querySelector("[data-agent-model-saving]");
        const modelErrorEl = card.querySelector("[data-agent-model-error]");
        // Reset transient state on every open so a prior save's
        // saving/error chips don't leak into the new agent's view.
        if (modelSavingEl) modelSavingEl.hidden = true;
        if (modelErrorEl) { modelErrorEl.hidden = true; modelErrorEl.textContent = ""; }

        if (modelBlock) {
          if (modelMeta) {
            if (modelNameEl) modelNameEl.textContent = modelMeta.name;
            if (modelProvEl) modelProvEl.textContent = modelMeta.provider;
            modelBlock.style.display = "";
          } else if (modelV) {
            if (modelNameEl) modelNameEl.textContent = modelV;
            if (modelProvEl) modelProvEl.textContent = "";
            modelBlock.style.display = "";
          } else {
            modelBlock.style.display = "none";
          }
        }

        // Wire the editable picker only when this overlay is mounted in
        // the live in-room context (window.app + live record). Otherwise
        // keep the readonly chip · standalone gallery pages can't PATCH.
        const canEditModel = !!(live && window.app
          && typeof fetch === "function"
          && !document.body.classList.contains("public"));
        if (canEditModel && modelTrigger && modelEdit && modelReadonly) {
          // Trigger · name on the left, provider chip on the right,
          // caret last. Matches the agent-profile `.ap-model-trigger`
          // pattern so both surfaces read as one control vocabulary.
          if (modelValueEl) {
            modelValueEl.textContent = modelMeta
              ? modelMeta.name
              : (modelV || "—");
          }
          if (modelProviderTagEl) {
            modelProviderTagEl.textContent = modelMeta ? modelMeta.provider : "";
          }

          // Replace any prior trigger listener (the DOM node persists
          // across open() calls, so naïve addEventListener stacks
          // duplicates · cloneNode wipes the listeners).
          const newTrigger = modelTrigger.cloneNode(true);
          modelTrigger.parentNode.replaceChild(newTrigger, modelTrigger);
          // Re-fetch refs AFTER clone since the old references point
          // at the detached node.
          const triggerValEl = newTrigger.querySelector("[data-agent-model-value]");
          const triggerProvEl = newTrigger.querySelector("[data-agent-model-provider-tag]");
          newTrigger.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (newTrigger.classList.contains("open")) {
              closeAgentModelPicker();
              return;
            }
            openAgentModelPicker(slug, {
              trigger: newTrigger,
              valueEl: triggerValEl,
              providerEl: triggerProvEl,
              saving: modelSavingEl,
              error: modelErrorEl,
              readonlyName: modelNameEl,
              readonlyProv: modelProvEl,
            });
          });

          // Show editor, hide readonly chip.
          modelReadonly.style.display = "none";
          modelEdit.hidden = false;
        } else if (modelEdit && modelReadonly) {
          modelReadonly.style.display = "";
          modelEdit.hidden = true;
        }
      } catch (e) {
        // Don't let model-picker wiring abort the overlay open.
        try { console.warn("[agent-overlay] model picker setup failed:", e); } catch (_) {}
      }

      // Kick-from-room button · visible only when (a) we're inside a
      // live room, (b) this agent is a director member of that room
      // (chair excluded · the role is structural), (c) the room isn't
      // adjourned (member changes are rejected by the server then).
      try {
        const kickBlock = card.querySelector("[data-agent-room-actions]");
        const kickBtn = card.querySelector("[data-agent-kick-btn]");
        if (kickBlock && kickBtn) {
          const app = window.app;
          const room = app && app.currentRoom;
          const members = (app && app.currentMembers) || [];
          const isMember = members.some((m) => m && m.id === slug);
          const isChair = !!(live && live.roleKind === "moderator");
          const adjourned = room && room.status === "adjourned";
          const canKick = !!room && isMember && !isChair && !adjourned;
          if (canKick) {
            kickBlock.hidden = false;
            kickBtn.disabled = false;
            // Replace any prior listener to avoid stacking after re-open.
            const newKick = kickBtn.cloneNode(true);
            kickBtn.parentNode.replaceChild(newKick, kickBtn);
            newKick.addEventListener("click", () => {
              const promptKey = ovT("ao_kick_confirm", { name: a.name });
              if (!window.confirm(promptKey)) return;
              kickFromRoom(slug, room.id, members, {
                btn: newKick,
                onDone: () => close(),
              });
            });
          } else {
            kickBlock.hidden = true;
          }
        }
      } catch (e) {
        try { console.warn("[agent-overlay] kick button setup failed:", e); } catch (_) {}
      }

      card.querySelector(".agent-traits").innerHTML = (a.traits || [])
        .map((t) => `<span class="agent-trait">${t}</span>`).join("");

      // Voice config block · reuses agent-profile.js's `renderVoiceBlock`
      // so the locked-state CTA, picker, emotion + sliders all read
      // identically to the full profile page. The block is private-only
      // (hidden by CSS in `.public` overlay mode) and only mounts when
      // both the AgentProfileVoice surface AND window.app are present
      // (the landing-page overlay has neither, so the slot stays empty).
      // All change handlers are document-level in agent-profile.js so
      // events from the overlay's mount fire the same code paths.
      renderVoiceSlot(slug);

      // In-room notes — what THIS agent has said in the current room,
      // styled like the live-notes panel: timestamp + tag + claim/obs.
      // Replaces the old hardcoded "last 3 rooms" memory list.
      renderRoomNotes(slug);

      // Track Record — real numbers from /api/agents/:slug/stats
      // (rooms joined, rounds spoken, tokens consumed). Same source
      // the agent profile uses, so the two views agree.
      renderTrackRecord(slug);

      card.querySelector(".agent-tenure").textContent = a.tenure || "—";

      // Hide trait block if the agent has no curated traits (custom
      // agents). Memory + stats blocks always show — they fill in
      // asynchronously and surface their own empty states.
      function toggleBlock(containerSel, hasContent) {
        const el = card.querySelector(containerSel);
        if (!el) return;
        const block = el.closest(".agent-block");
        if (block) block.style.display = hasContent ? "" : "none";
      }
      toggleBlock(".agent-traits", (a.traits || []).length > 0);

      overlay.classList.add("open");
      overlay.setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
    }

    /** Build a list of note-style entries from the current room,
     *  filtered to messages authored by the given agent. The shape
     *  mirrors live-notes (ts + tag + body) so the same visual
     *  vocabulary applies. Returns null when no room is open (the
     *  overlay is being viewed outside a live room context). */
    function buildRoomNotes(slug) {
      const a = window.app;
      if (!a || !Array.isArray(a.currentMessages) || !a.currentRoom) return null;
      const msgs = a.currentMessages.filter(
        (m) => m && m.authorId === slug && m.body && m.body.trim(),
      );
      const out = [];
      for (const m of msgs) {
        const ts = m.createdAt || 0;
        const kind = m.meta && m.meta.kind;
        let tag = "obs";
        let body = "";
        if (kind === "round-end") {
          tag = "obs"; body = "Closed the round.";
        } else if (kind === "round-prompt") {
          tag = "open"; body = "Surfaced the round for vote / continue.";
        } else if (kind === "round-open") {
          tag = "obs"; body = "Opened the round.";
        } else if (kind === "round-resumed") {
          tag = "obs"; body = "Resumed the room.";
        } else if (kind === "no-brief") {
          tag = "warn"; body = "Adjourned without a report.";
        } else if (kind === "settings") {
          tag = "warn";
          body = a.truncateNote(a.stripBoldMarkdown(m.body), 140);
        } else if (kind === "clarify") {
          tag = "open";
          body = a.truncateNote(a.firstSentence(m.body), 140);
        } else if (kind === "members") {
          tag = "obs"; body = "Member roster changed.";
        } else if (kind === "no-brief") {
          tag = "warn"; body = "No report filed.";
        } else {
          // Regular director / chair turn — surface the first bold
          // claim if present (those are the load-bearing assertions
          // and stance shifts), else the first sentence.
          const bold = a.firstBoldSegment(m.body);
          tag = bold ? "insight" : "obs";
          body = a.truncateNote(
            bold || a.firstSentence(a.stripBoldMarkdown(m.body)),
            140,
          );
        }
        out.push({ ts, tag, body });
      }
      out.sort((x, y) => y.ts - x.ts);
      return out;
    }

    function renderRoomNotes(slug) {
      const list = card.querySelector(".agent-memory-list");
      if (!list) return;
      const notes = buildRoomNotes(slug);
      if (notes === null) {
        list.innerHTML = `
          <div class="agent-memory-empty">
            <div class="lock-icon">○</div>
            <div class="lock-text">${escapeHtml(ovT("ao_room_notes_empty"))}</div>
          </div>
        `;
        return;
      }
      if (notes.length === 0) {
        list.innerHTML = `
          <div class="agent-memory-empty">
            <div class="lock-icon">○</div>
            <div class="lock-text">${escapeHtml(ovT("ao_room_notes_waiting"))}</div>
          </div>
        `;
        return;
      }
      list.innerHTML = notes.map((n, i) => {
        const cls = i === 0 ? "t-fresh" : i >= 8 ? "t-old" : "";
        const tagLabel = (window.app && window.app.noteTagLabel)
          ? window.app.noteTagLabel(n.tag)
          : n.tag;
        return `
          <div class="agent-note-entry ${cls}">
            <div class="agent-note-time">${escapeHtml(formatTime(n.ts))}</div>
            <div class="agent-note-body">
              <span class="agent-note-tag t-${escapeHtml(n.tag)}">${escapeHtml(tagLabel)}</span>
              ${escapeHtml(n.body)}
            </div>
          </div>
        `;
      }).join("");
    }

    function renderTrackRecord(slug) {
      const stats = card.querySelector(".agent-stats");
      if (!stats) return;
      // Render placeholders immediately, then patch in real values
      // once the fetch resolves. Keeps the overlay snappy on open.
      stats.innerHTML = `
        <div class="agent-stat"><div class="v" data-stat-v="rooms">—</div><div class="l">${escapeHtml(ovT("ap_stat_rooms"))}</div></div>
        <div class="agent-stat"><div class="v" data-stat-v="rounds">—</div><div class="l">${escapeHtml(ovT("ap_stat_rounds"))}</div></div>
        <div class="agent-stat"><div class="v" data-stat-v="tokens">—</div><div class="l">${escapeHtml(ovT("ap_stat_tokens"))}</div></div>
      `;
      fetch("/api/agents/" + encodeURIComponent(slug) + "/stats")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
        .then((s) => {
          const set = (k, v) => {
            const el = stats.querySelector(`[data-stat-v="${k}"]`);
            if (el) el.textContent = formatStatNumber(v);
          };
          set("rooms", s.roomsJoined);
          set("rounds", s.roundsSpoken);
          set("tokens", s.tokensConsumed);
        })
        .catch(() => { /* placeholders stay */ });
    }

    function formatStatNumber(n) {
      if (typeof n !== "number" || !Number.isFinite(n)) return "—";
      if (n < 1000) return String(n);
      if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "") + "k";
      return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, "") + "M";
    }

    function formatTime(ts) {
      if (!ts) return "—";
      const d = new Date(ts);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    }

    function close() {
      overlayOpenSlug = null;
      // Close the model picker first · it lives in document.body and
      // wouldn't dismiss with the overlay otherwise (would leave a
      // floating popover orphaned over the page).
      try { closeAgentModelPicker(); } catch (_) {}
      overlay.classList.remove("open");
      overlay.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
    }

    /** Open the model picker popover · mirrors the agent-profile
     *  `.ap-model-picker` vocabulary (panel surface, hairline border,
     *  grouped by provider via `.ap-model-group` headers, `.ap-model-opt`
     *  rows with sans label + mono uppercase hint). Built fresh on each
     *  open, attached to document.body so its `position: fixed` escapes
     *  the overlay card's `overflow-y: auto` clip. z-index lifted above
     *  the overlay's 9700 via the `.ap-model-picker-overlay` modifier
     *  class so the popover floats above the modal backdrop. */
    let _agentModelPopover = null;
    let _agentModelPopoverOutsideHandler = null;
    let _agentModelPopoverKeyHandler = null;
    function closeAgentModelPicker() {
      if (_agentModelPopover && _agentModelPopover.parentNode) {
        _agentModelPopover.parentNode.removeChild(_agentModelPopover);
      }
      _agentModelPopover = null;
      const openTrigger = card.querySelector("[data-agent-model-trigger].open");
      if (openTrigger) openTrigger.classList.remove("open");
      if (_agentModelPopoverOutsideHandler) {
        document.removeEventListener("mousedown", _agentModelPopoverOutsideHandler, true);
        _agentModelPopoverOutsideHandler = null;
      }
      if (_agentModelPopoverKeyHandler) {
        document.removeEventListener("keydown", _agentModelPopoverKeyHandler, true);
        _agentModelPopoverKeyHandler = null;
      }
    }
    function openAgentModelPicker(slug, ui) {
      closeAgentModelPicker();
      const live = window.app && window.app.agentsById
        ? window.app.agentsById[slug]
        : null;
      if (!live) return;
      const currentV = live.modelV || "";

      // Group reachable models by provider (server filters by the
      // user's active credential, so only that credential's family
      // shows up). Falls back to the full MODEL_LABELS catalog only
      // when the /api/models cache hasn't loaded yet — short cold-
      // start window; cache lands in ~50ms.
      const cache = (typeof window.boardroomModels === "function")
        ? window.boardroomModels()
        : null;
      const reachable = (cache && Array.isArray(cache.reachable) && cache.reachable.length > 0)
        ? cache.reachable
        : null;

      const byProvider = new Map();
      if (reachable) {
        for (const m of reachable) {
          const meta = MODEL_LABELS[m.modelV];
          const providerName = meta ? meta.provider : m.provider;
          const displayName = meta ? meta.name : m.displayName;
          if (!byProvider.has(providerName)) byProvider.set(providerName, []);
          byProvider.get(providerName).push({ v: m.modelV, name: displayName });
        }
      } else {
        for (const v of Object.keys(MODEL_LABELS)) {
          const meta = MODEL_LABELS[v];
          if (!byProvider.has(meta.provider)) byProvider.set(meta.provider, []);
          byProvider.get(meta.provider).push({ v, name: meta.name });
        }
      }

      // If the agent's currently-stored modelV isn't in the reachable
      // set (active credential just switched, or registry retired the
      // model), prepend a "current (unreachable)" entry so the user
      // can still see what their agent is on — and pick a different
      // reachable model to swap to.
      const reachableHas = reachable
        ? reachable.some((m) => m.modelV === currentV)
        : !!MODEL_LABELS[currentV];
      let unknownRow = "";
      if (currentV && !reachableHas) {
        const meta = MODEL_LABELS[currentV];
        const label = meta ? meta.name : currentV;
        const hint = meta ? "unreachable · pick a model below" : "unrecognised id";
        unknownRow =
          `<div class="ap-model-group">Current (unreachable)</div>` +
          `<button type="button" class="ap-model-opt active" data-agent-model-pick="${escapeHtml(currentV)}" disabled>` +
            `<span class="ap-model-opt-label">${escapeHtml(label)}</span>` +
            `<span class="ap-model-opt-hint">${escapeHtml(hint)}</span>` +
          `</button>`;
      }

      const rows = [];
      for (const [provider, items] of byProvider.entries()) {
        rows.push(`<div class="ap-model-group">${escapeHtml(provider)}</div>`);
        for (const it of items) {
          const isActive = it.v === currentV;
          rows.push(
            `<button type="button" class="ap-model-opt${isActive ? " active" : ""}" data-agent-model-pick="${escapeHtml(it.v)}">` +
              `<span class="ap-model-opt-label">${escapeHtml(it.name)}</span>` +
              `<span class="ap-model-opt-hint">${escapeHtml(it.v)}</span>` +
            `</button>`,
          );
        }
      }

      // Empty-reachable safety · cache loaded but no models accessible
      // (e.g. xAI-only active provider with empty registry rows).
      if (rows.length === 0 && !unknownRow) {
        rows.push(
          `<div class="ap-model-picker-loading">No models reachable with your current API key. Configure another provider in Preferences.</div>`,
        );
      }

      const pop = document.createElement("div");
      pop.className = "ap-model-picker ap-model-picker-overlay";
      pop.setAttribute("role", "listbox");
      pop.innerHTML = unknownRow + rows.join("");
      document.body.appendChild(pop);

      // Position · anchored under the trigger, left edge aligned with
      // the trigger's left edge. Pop width matches trigger width with
      // a sane minimum so even short triggers get a usable menu.
      const r = ui.trigger.getBoundingClientRect();
      const popMinWidth = 240;
      const popWidth = Math.max(r.width, popMinWidth);
      const vw = window.innerWidth || document.documentElement.clientWidth;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      let popLeft = r.left;
      // Don't run off the right edge of the viewport.
      if (popLeft + popWidth > vw - 8) popLeft = Math.max(8, vw - popWidth - 8);
      let popTop = r.bottom + 4;
      pop.style.minWidth = popWidth + "px";
      pop.style.left = popLeft + "px";
      pop.style.top = popTop + "px";
      // After mount the pop has measured height; if it would overflow
      // the viewport bottom, flip it ABOVE the trigger instead.
      const popH = pop.getBoundingClientRect().height;
      if (popTop + popH > vh - 8) {
        popTop = Math.max(8, r.top - popH - 4);
        pop.style.top = popTop + "px";
      }

      ui.trigger.classList.add("open");
      _agentModelPopover = pop;

      // Row pick · save through the existing fetch helper, swap chip /
      // trigger value on success, close popover regardless of outcome
      // (errors surface inline below the trigger via `ui.error`).
      pop.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-agent-model-pick]");
        if (!btn) return;
        const v = btn.getAttribute("data-agent-model-pick");
        if (!v) return;
        // Optimistic UI · update trigger label + provider chip
        // immediately so the user gets feedback even before the
        // PATCH lands.
        const meta = MODEL_LABELS[v];
        if (ui.valueEl) ui.valueEl.textContent = meta ? meta.name : v;
        if (ui.providerEl) ui.providerEl.textContent = meta ? meta.provider : "";
        closeAgentModelPicker();
        if (v === currentV) return; // no-op pick
        saveModelForAgent(slug, v, {
          select: null, // legacy field · saveModelForAgent only uses it to disable
          saving: ui.saving,
          error: ui.error,
          providerTag: ui.providerEl,
          readonlyName: ui.readonlyName,
          readonlyProv: ui.readonlyProv,
          previous: currentV,
          // On error revert the trigger label + provider chip back to
          // the previous model so the visible state matches what the
          // server actually has.
          onError: () => {
            const prevMeta = MODEL_LABELS[currentV];
            if (ui.valueEl) ui.valueEl.textContent = prevMeta ? prevMeta.name : (currentV || "—");
            if (ui.providerEl) ui.providerEl.textContent = prevMeta ? prevMeta.provider : "";
          },
        });
      });

      // Outside-click + Esc close · use capture phase so the popover
      // beats other click handlers (e.g. agent-overlay's own backdrop
      // dismiss) when the user clicks elsewhere with the popover open.
      _agentModelPopoverOutsideHandler = (ev) => {
        if (pop.contains(ev.target) || ui.trigger.contains(ev.target)) return;
        closeAgentModelPicker();
      };
      _agentModelPopoverKeyHandler = (ev) => {
        if (ev.key === "Escape") {
          ev.stopPropagation();
          closeAgentModelPicker();
        }
      };
      // defer attachment a tick so the click that opened us doesn't
      // immediately close it via the outside-click handler.
      setTimeout(() => {
        document.addEventListener("mousedown", _agentModelPopoverOutsideHandler, true);
        document.addEventListener("keydown", _agentModelPopoverKeyHandler, true);
      }, 0);
    }

    /** Persist a new modelV for the agent · PATCH /api/agents/:slug
     *  with `{ modelV }`. On success, update the live roster in place
     *  and refresh the readonly chip so a re-open shows the new model
     *  without a network round-trip. On failure, revert the select
     *  back to the previous value + surface the server error inline
     *  (mirrors the inline-error pattern from agent-profile.js so
     *  users don't have to dismiss an alert just to retry). */
    function saveModelForAgent(slug, v, ui) {
      const live = window.app && window.app.agentsById
        ? window.app.agentsById[slug]
        : null;
      if (!live) return;
      if (ui.saving) ui.saving.hidden = false;
      if (ui.error) { ui.error.hidden = true; ui.error.textContent = ""; }
      if (ui.select) ui.select.disabled = true;
      fetch("/api/agents/" + encodeURIComponent(slug), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelV: v }),
      })
        .then(async (r) => {
          if (r.ok) return r.json();
          const j = await r.json().catch(() => ({}));
          const detail = j && typeof j.error === "string"
            ? j.error
            : ("HTTP " + r.status);
          throw new Error(detail);
        })
        .then((updated) => {
          // Reflect the saved modelV in the in-memory roster so other
          // surfaces (agent profile, sidebar badges) read the new value.
          live.modelV = updated.modelV || v;
          const meta = MODEL_LABELS[live.modelV];
          if (ui.readonlyName) ui.readonlyName.textContent = meta ? meta.name : live.modelV;
          if (ui.readonlyProv) ui.readonlyProv.textContent = meta ? meta.provider : "";
          if (ui.providerTag) ui.providerTag.textContent = meta ? meta.provider : "";
          if (typeof window.app.refreshAgents === "function") {
            window.app.refreshAgents().catch(() => {});
          }
        })
        .catch((e) => {
          // Revert visible state to the previous value so what the
          // user sees matches what the server has, then surface the
          // error so they can retry.
          if (ui.select && ui.previous) ui.select.value = ui.previous;
          if (typeof ui.onError === "function") ui.onError(e);
          if (ui.error) {
            ui.error.hidden = false;
            ui.error.textContent = (e && e.message ? e.message : String(e));
          }
        })
        .finally(() => {
          if (ui.saving) ui.saving.hidden = true;
          if (ui.select) ui.select.disabled = false;
        });
    }

    /** Remove an agent from the current room. PATCH
     *  /api/rooms/:roomId/members with the desired-state list (all
     *  current director ids MINUS this one). The endpoint diffs against
     *  current state, fires a chair farewell, and re-emits config-event
     *  so other clients see the change. On failure, alert the user with
     *  the server's error string (most likely "room must keep at least
     *  one director"). */
    function kickFromRoom(slug, roomId, members, opts) {
      const remaining = (members || [])
        .filter((m) => m && m.id && m.id !== slug)
        .map((m) => m.id);
      if (opts.btn) opts.btn.disabled = true;
      fetch("/api/rooms/" + encodeURIComponent(roomId) + "/members", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentIds: remaining }),
      })
        .then(async (r) => {
          if (r.ok) return r.json();
          const j = await r.json().catch(() => ({}));
          const detail = j && typeof j.error === "string"
            ? j.error
            : ("HTTP " + r.status);
          throw new Error(detail);
        })
        .then(() => {
          // Server's config-event SSE will trigger app.js to patch
          // currentMembers + re-render the queue / cast. Close the
          // overlay so the user sees the updated room state.
          if (typeof opts.onDone === "function") opts.onDone();
        })
        .catch((e) => {
          window.alert(ovT("ao_kick_failed", { detail: (e && e.message ? e.message : String(e)) }));
          if (opts.btn) opts.btn.disabled = false;
        });
    }

    // Public surface · other modules (e.g. agent-profile.js's voice
    // unlock CTA) need to dismiss the overlay before opening their
    // own modal, so we expose `close` and an `isOpen` predicate.
    window.AgentOverlay = {
      close,
      isOpen: () => overlay.classList.contains("open"),
    };

    /** Populate the voice slot inside the overlay card. Three states:
     *   - no app surface (landing page) → hide the block entirely
     *   - has app but no MiniMax/ElevenLabs key → locked CTA (the
     *     `renderVoiceBlock` helper returns the locked card markup,
     *     same `data-ap-voice-unlock` button used on the profile page,
     *     which deep-links to user-settings → keys → minimax)
     *   - has key → full picker + emotion + sliders, identical to the
     *     profile page version */
    function renderVoiceSlot(slug) {
      const block = card.querySelector(".agent-voice-block");
      const slot = block?.querySelector("[data-agent-voice-slot]");
      if (!block || !slot) return;
      const api = window.AgentProfileVoice;
      const hasApp = !!window.app;
      if (!api || typeof api.renderVoiceBlock !== "function" || !hasApp) {
        block.style.display = "none";
        slot.innerHTML = "";
        return;
      }
      block.style.display = "";
      slot.innerHTML = api.renderVoiceBlock(slug);
    }

    document.addEventListener("boardroom:locale", () => {
      if (!overlay.classList.contains("open") || !overlayOpenSlug) return;
      if (window.I18n && typeof window.I18n.applyDom === "function") {
        window.I18n.applyDom(overlay);
      }
      renderTrackRecord(overlayOpenSlug);
      renderRoomNotes(overlayOpenSlug);
      // Voice block carries its own localised copy (locked CTA, emotion
      // labels, advanced-tuning labels) so it must re-render too.
      renderVoiceSlot(overlayOpenSlug);
    });

    document.addEventListener("click", (e) => {
      const trigger = e.target.closest("[data-agent]");
      // Skip the overlay even if the element happens to carry
      // data-agent (e.g. another script tagged it) when the click
      // originates inside an opt-out region.
      if (trigger && !trigger.closest("[data-no-agent-overlay]")) {
        e.preventDefault();
        e.stopPropagation();
        open(trigger.dataset.agent);
        return;
      }
      if (e.target === overlay) close();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.classList.contains("open")) {
        e.stopImmediatePropagation();
        close();
      }
    });

    closeBtn.addEventListener("click", close);

    // CTA: in private mode, if convene overlay is available on this page,
    // hand off without navigating. In public mode, let the sign-in CTA
    // navigate normally.
    card.querySelectorAll(".agent-card-cta").forEach((cta) => {
      cta.addEventListener("click", (e) => {
        if (cta.classList.contains("public-only")) return; // navigate to sign-in
        if (typeof window.openConveneOverlay === "function") {
          e.preventDefault();
          close();
          setTimeout(() => window.openConveneOverlay(), 80);
        }
      });
    });

    // Public API for other modules to open the detail view by slug
    // without going through DOM event delegation.
    window.openAgentOverlay = open;
    window.closeAgentOverlay = close;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
