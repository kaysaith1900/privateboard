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
    "opus-4-6":         { name: "Claude Opus 4.6",       provider: "Anthropic" },
    "opus-4-6-fast":    { name: "Claude Opus 4.6 Fast",  provider: "Anthropic" },
    "haiku-4-5":        { name: "Claude Haiku 4.5",      provider: "Anthropic" },
    "gpt-5-5":          { name: "GPT-5.5",                provider: "OpenAI"    },
    "gpt-5-4":          { name: "GPT-5.4",                provider: "OpenAI"    },
    "gpt-5-4-mini":     { name: "GPT-5.4 Mini",           provider: "OpenAI"    },
    "gpt-5-5-pro":      { name: "GPT-5.5 Pro",            provider: "OpenAI"    },
    "codex-5-4":        { name: "ChatGPT Codex 5.4",      provider: "OpenAI"    },
    "gemini-3-1":       { name: "Gemini 3.1 Pro",         provider: "Google"    },
    "gemini-3-flash":   { name: "Gemini 3 Flash",         provider: "Google"    },
    "gemini-3-1-flash": { name: "Gemini 3.1 Flash Lite",  provider: "Google"    },
    "grok-4-3":         { name: "Grok 4.3",                provider: "xAI"       },
    "grok-4-1-fast":    { name: "Grok 4.1 Fast",           provider: "xAI"       },
    "grok-4-3":         { name: "Grok 4.3",                provider: "xAI"       },
    "grok-4-20":        { name: "Grok 4.20",               provider: "xAI"       },
    "deepseek-v4-pro":  { name: "DeepSeek V4 Pro",         provider: "DeepSeek"  },
  };

  const AGENT_CATALOG = {
    "socrates": {
      name: "Socrates",
      role: "The Skeptic",
      handle: "/socrates",
      avatar: "avatars/socrates.svg",
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
      handle: "/first_p",
      avatar: "avatars/first-principles.svg",
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
      handle: "/value_inv",
      avatar: "avatars/value-investor.svg",
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
      handle: "/user_emp",
      avatar: "avatars/user-empathy.svg",
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
      handle: "/long_h",
      avatar: "avatars/long-horizon.svg",
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
      handle: "/phen",
      avatar: "avatars/phenomenologist.svg",
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

  const OVERLAY_HTML = `
    <div class="agent-overlay" id="agent-overlay" role="dialog" aria-modal="true" aria-hidden="true">
      <div class="agent-card" role="document">
        <div class="agent-classification">
          <span><span class="dot">●</span> agent · personnel file</span>
          <span class="right">// classified</span>
        </div>
        <header class="agent-card-head">
          <img class="agent-card-avatar" src="" alt="">
          <div class="agent-card-id">
            <div class="name"></div>
            <div class="role"></div>
            <div class="handle"></div>
          </div>
          <button type="button" class="agent-card-close" aria-label="Close">✕</button>
        </header>
        <div class="agent-card-body">

          <div class="agent-block">
            <div class="agent-block-label">Lens</div>
            <p class="agent-lens"></p>
          </div>

          <div class="agent-block agent-model-block">
            <div class="agent-block-label">Model</div>
            <div class="agent-model-display">
              <span class="agent-model-name"></span>
              <span class="agent-model-provider"></span>
            </div>
          </div>

          <div class="agent-block">
            <div class="agent-block-label">Style</div>
            <div class="agent-traits"></div>
          </div>

          <div class="agent-block private-only">
            <div class="agent-block-label">
              In-Room Memory
              <span class="badge">this room</span>
            </div>
            <div class="agent-memory-list" data-agent-room-notes></div>
          </div>

          <div class="agent-block private-only">
            <div class="agent-block-label">Track Record</div>
            <div class="agent-stats"></div>
          </div>

          <div class="agent-block public-only">
            <div class="agent-block-label">
              In-Room Memory
              <span class="badge locked-badge">⊘ classified</span>
            </div>
            <div class="agent-locked">
              <div class="lock-icon">▰</div>
              <div class="lock-text">
                in-room notes are private to each thinker.
                <a href="/" class="lock-link">sign in →</a>
                to see what they have said and where their stance shifted.
              </div>
            </div>
          </div>

        </div>
        <footer class="agent-card-foot">
          <div class="meta private-only">tenure · <span class="lime agent-tenure"></span></div>
          <div class="meta public-only">first room · <span class="lime">free</span></div>
          <a href="/#convene" class="agent-card-cta private-only">[ ◆ Convene with them ]</a>
          <a href="/#convene" class="agent-card-cta public-only">[ → Sign in to convene ]</a>
        </footer>
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
    const overlayEl = document.getElementById("agent-overlay");
    if (isPublic) overlayEl.classList.add("public");

    autoTagAvatars();
    // Re-run after short delay in case other scripts mutate the DOM
    setTimeout(autoTagAvatars, 50);

    const overlay = document.getElementById("agent-overlay");
    const card = overlay.querySelector(".agent-card");
    const closeBtn = overlay.querySelector(".agent-card-close");

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
    bindScrollAutoHide(card);
    bindScrollAutoHide(card.querySelector(".agent-memory-list"));

    /** Build a card from a live /api/agents record (custom directors).
     *  These agents don't ship traits / memory / stats / signature
     *  scripts, so those sections collapse via the empty-array hiding
     *  below — only Lens (= bio) is filled. */
    function buildLiveAgentCard(live) {
      return {
        name: live.name,
        role: live.roleTag || "Director",
        handle: live.handle || ("/" + live.id),
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
      card.querySelector(".agent-card-id .role").textContent = a.role;
      card.querySelector(".agent-card-id .handle").textContent = a.handle;
      card.querySelector(".agent-lens").textContent = a.lens;

      // Model · resolved from the live record (catalog entries don't
      // ship a modelV). Fall back to displaying the raw id if we don't
      // have a friendly label for it yet.
      const modelV = live ? live.modelV : null;
      const modelMeta = modelV ? MODEL_LABELS[modelV] : null;
      const modelBlock = card.querySelector(".agent-model-block");
      const modelNameEl = card.querySelector(".agent-model-name");
      const modelProvEl = card.querySelector(".agent-model-provider");
      if (modelMeta) {
        modelNameEl.textContent = modelMeta.name;
        modelProvEl.textContent = modelMeta.provider;
        modelBlock.style.display = "";
      } else if (modelV) {
        modelNameEl.textContent = modelV;
        modelProvEl.textContent = "";
        modelBlock.style.display = "";
      } else {
        modelBlock.style.display = "none";
      }

      card.querySelector(".agent-traits").innerHTML = (a.traits || [])
        .map((t) => `<span class="agent-trait">${t}</span>`).join("");

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
            <div class="lock-text">no live room. open a room to see this director's in-room notes.</div>
          </div>
        `;
        return;
      }
      if (notes.length === 0) {
        list.innerHTML = `
          <div class="agent-memory-empty">
            <div class="lock-icon">○</div>
            <div class="lock-text">no turns yet — once they speak, claims and stance shifts land here.</div>
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
            <div class="agent-note-time">${escape(formatTime(n.ts))}</div>
            <div class="agent-note-body">
              <span class="agent-note-tag t-${escape(n.tag)}">${escape(tagLabel)}</span>
              ${escape(n.body)}
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
        <div class="agent-stat"><div class="v" data-stat-v="rooms">—</div><div class="l">rooms</div></div>
        <div class="agent-stat"><div class="v" data-stat-v="rounds">—</div><div class="l">rounds</div></div>
        <div class="agent-stat"><div class="v" data-stat-v="tokens">—</div><div class="l">tokens</div></div>
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
      overlay.classList.remove("open");
      overlay.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
    }

    function escape(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[c]));
    }

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
