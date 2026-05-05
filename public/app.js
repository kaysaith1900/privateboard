/* ═══════════════════════════════════════════
   APP CONTROLLER · single-page boardroom dashboard
   ═══════════════════════════════════════════
   Drives the entire dashboard against the backend:

     ─ initial fetch:   /api/prefs · /api/agents · /api/rooms · /api/keys
     ─ hash routing:    #/r/<roomId>
     ─ SSE per room:    /api/rooms/:id/stream
     ─ actions:         createRoom · sendMessage · adjournRoom

   Designed in vanilla JS (no framework) to match the rest of the frontend.
   Renders into named DOM containers; non-list parts (chrome / overlays) keep
   their existing handlers.
*/
(function () {
  /** Display labels for the registry's modelV ids · used to print
   *  "Opus 4.7" next to a director's name in the chat header. Mirror
   *  of src/ai/registry.ts's displayName field. */
  const MODEL_LABELS = {
    "sonnet-4-6":       "Sonnet 4.6",
    "opus-4-7":         "Opus 4.7",
    "haiku-4-5":        "Haiku 4.5",
    "gpt-5-5":          "GPT-5.5",
    "gpt-5-4":          "GPT-5.4",
    "gpt-5-4-mini":     "GPT-5.4 Mini",
    "gpt-5-5-pro":      "GPT-5.5 Pro",
    "codex-5-4":        "ChatGPT Codex 5.4",
    "gemini-3-1":       "Gemini 3.1 Pro",
    "gemini-3-flash":   "Gemini 3 Flash",
    "gemini-3-1-flash": "Gemini 3.1 Flash Lite",
    "grok-4-3":         "Grok 4.3",
    "grok-4-1-fast":    "Grok 4.1 Fast",
    "grok-4-20":        "Grok 4.20",
    "deepseek-v4-pro":  "DeepSeek V4 Pro",
  };

  /** Full model catalog for the new-agent composer dropdown. Mirrors
   *  PROFILE_MODELS in agent-profile.js so users can pick any model at
   *  creation time — not just the three Anthropic tiers. Order is
   *  Anthropic → OpenAI → Google → xAI → DeepSeek; each row carries
   *  enough context (label · provider · short deck) to choose at a
   *  glance. */
  const AGENT_COMPOSER_MODELS = [
    { v: "opus-4-7",         label: "Claude Opus 4.7",   provider: "Anthropic", deck: "deep reasoning" },
    { v: "sonnet-4-6",       label: "Claude Sonnet 4.6", provider: "Anthropic", deck: "balanced · default" },
    { v: "haiku-4-5",        label: "Claude Haiku 4.5",  provider: "Anthropic", deck: "fast · low-cost" },
    { v: "gpt-5-5-pro",      label: "GPT-5.5 Pro",       provider: "OpenAI",    deck: "flagship · 1M ctx" },
    { v: "gpt-5-5",          label: "GPT-5.5",           provider: "OpenAI",    deck: "1M ctx" },
    { v: "gpt-5-4",          label: "GPT-5.4",           provider: "OpenAI",    deck: "general · 1M ctx" },
    { v: "gpt-5-4-mini",     label: "GPT-5.4 Mini",      provider: "OpenAI",    deck: "fast · 400k ctx" },
    { v: "codex-5-4",        label: "ChatGPT Codex 5.4", provider: "OpenAI",    deck: "code · agents" },
    { v: "gemini-3-1",       label: "Gemini 3.1 Pro",        provider: "Google",    deck: "flagship · 1M ctx" },
    { v: "gemini-3-flash",   label: "Gemini 3 Flash",        provider: "Google",    deck: "frontier flash · 1M ctx" },
    { v: "gemini-3-1-flash", label: "Gemini 3.1 Flash Lite", provider: "Google",    deck: "fast · 1M ctx" },
    { v: "grok-4-3",         label: "Grok 4.3",          provider: "xAI",       deck: "flagship · 1M ctx" },
    { v: "grok-4-1-fast",    label: "Grok 4.1 Fast",     provider: "xAI",       deck: "fast · 256k ctx" },
    { v: "grok-4-20",        label: "Grok 4.20",         provider: "xAI",       deck: "2M ctx · big context" },
    { v: "deepseek-v4-pro",  label: "DeepSeek V4 Pro",   provider: "DeepSeek",  deck: "reasoning · open weights" },
  ];

  /** Tone tooltips · short, user-readable summary of how each tone
   *  changes director behaviour. Drives the hover tip on the room
   *  header's `tone` tag. The convene + room-settings overlays
   *  duplicate the same map; if you tweak one, sync the others
   *  (low-frequency edit, low-cost duplication). */
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

  const app = {
    // ── State ─────────────────────────────────────────────────
    prefs: null,
    keys: {},
    agents: [],
    agentsById: {},
    rooms: [],
    currentRoomId: null,
    currentRoom: null,
    currentMessages: [],
    currentMembers: [],            // directors only (chair excluded)
    currentChair: null,            // chair agent for the current room
    currentQueue: [],
    /** Round progress from the orchestrator: how many directors have
     *  spoken in the current round vs. the cap (= cast size). */
    currentRound: { spoken: 0, total: 0 },
    currentKeyPoints: [],          // chair-generated key points for the current room
    currentBrief: null,
    /** All briefs filed for the current room · newest first. */
    currentBriefs: [],
    /** Convening card state · populated when a fresh room is opening
     *  (auto-pick / seating / chair preparing). Cleared when the
     *  chair's convening message lands or when the user navigates
     *  away. Null when the room is past the opening beat. */
    conveneState: null,
    /** Composer mode shown when no room is active. "room" = new-room
     *  composer (default), "agent" = new-agent composer. Toggled by the
     *  sidebar's "+ New room" / "+ New agent" buttons. */
    composerMode: "room",
    /** Generated agent spec preview shown in agent composer mode after
     *  /generate-spec returns. null while idle / generating. */
    agentSpec: null,
    agentSpecAvatarSeed: null,
    agentSpecGenerating: false,
    /** User's last-picked model for new agents · persisted via the
     *  agent composer state and applied as the default `modelV` on
     *  every newly generated spec. */
    agentComposerModel: null,
    /** Stage index for the agent-generation animation. -1 = idle.
     *  Advanced by a setInterval while agentSpecGenerating is true. */
    agentGenStageIndex: -1,
    agentGenStartedAt: 0,
    agentGenSubstageIndex: 0,
    sse: null,

    // ── Send-flow state ──────────────────────────────────────
    /** Timestamp of last sendMessage call · used to throttle rapid
     *  Enter-key / button-click bursts. */
    lastSendAt: 0,
    /** Throttle window (ms). Two send attempts within this window
     *  collapse into a single send. */
    SEND_THROTTLE_MS: 700,
    /** True while a sendMessage POST is in flight. Blocks parallel
     *  sends so the user can't double-submit by mashing Enter. */
    sendInFlight: false,
    /** Pending user message queued behind the current speaker. The
     *  user picked "wait" in the interrupt-or-queue modal; we'll
     *  flush this as soon as the current speaker emits message-final. */
    pendingUserMessage: null,
    /** Agent id of the speaker we're waiting on for the pending
     *  message; lets the queue-update logic know when to flush. */
    pendingForSpeakerId: null,

    // ── Init ──────────────────────────────────────────────────
    async init() {
      try {
        await this.loadInitial();
      } catch (e) {
        console.error("[app] initial load failed", e);
      }
      this.renderSidebarRooms();
      this.renderSidebarAgents();
      this.renderUserBlock();
      // Show a friendly "storage upgraded" banner if migrations have
      // been applied since the user last opened the app. Fire-and-forget
      // so a slow / failed call doesn't block the dashboard rendering.
      void this.checkMigrationNotice();
      window.addEventListener("hashchange", () => this.handleRoute());
      this.handleRoute();
    },

    /** Surface a one-line "storage was upgraded" notice when the user
     *  opens a build that ran new schema migrations against their
     *  existing DB. Compares the latest applied migration in the DB
     *  against the last-acknowledged name in localStorage; a fresh-
     *  install user sees nothing (no last-seen → first visit → write
     *  current latest, no banner). Dismiss writes the latest name so
     *  the banner doesn't re-show until truly-new migrations land. */
    async checkMigrationNotice() {
      const banner = document.querySelector("[data-sys-notice]");
      if (!banner) return;
      const textEl = banner.querySelector("[data-sys-notice-text]");
      const closeBtn = banner.querySelector("[data-sys-notice-close]");
      if (!textEl || !closeBtn) return;

      let migrations = [];
      try {
        const r = await fetch("/api/system/migrations");
        if (!r.ok) return;
        const j = await r.json();
        migrations = Array.isArray(j.migrations) ? j.migrations : [];
      } catch { return; }
      if (migrations.length === 0) return;

      const latest = migrations[migrations.length - 1].name;
      const KEY = "boardroom.lastSeenMigration";
      let lastSeen = null;
      try { lastSeen = localStorage.getItem(KEY); } catch { /* */ }

      // Fresh-install (no last-seen recorded) · seed quietly with the
      // current latest, no banner. The user hasn't been here before;
      // showing "storage upgraded" makes no sense on first launch.
      if (!lastSeen) {
        try { localStorage.setItem(KEY, latest); } catch { /* */ }
        return;
      }
      if (lastSeen === latest) return;

      // Find migrations newer than lastSeen — by index in the list,
      // since order is applied_at ASC.
      const lastIdx = migrations.findIndex((m) => m.name === lastSeen);
      const fresh = lastIdx >= 0 ? migrations.slice(lastIdx + 1) : migrations;
      if (fresh.length === 0) {
        try { localStorage.setItem(KEY, latest); } catch { /* */ }
        return;
      }

      const lang = (this.composerLanguage && this.composerLanguage()) || "en";
      const count = fresh.length;
      const names = fresh.map((m) => m.name).join(", ");
      const copy = lang === "zh"
        ? {
            head: `存储结构已升级`,
            body: `已应用 ${count} 个新迁移 · 你已有的房间、董事、报告、设置都已保留。`,
            tooltip: names,
          }
        : {
            head: `Storage upgraded`,
            body: `${count} new migration${count > 1 ? "s" : ""} applied · your existing rooms, agents, briefs, and settings were preserved.`,
            tooltip: names,
          };
      textEl.innerHTML =
        `<span class="sys-notice-strong">${this.escape(copy.head)}</span> · ${this.escape(copy.body)}`;
      banner.title = copy.tooltip;
      banner.removeAttribute("hidden");

      const dismiss = () => {
        try { localStorage.setItem(KEY, latest); } catch { /* */ }
        banner.setAttribute("hidden", "");
      };
      closeBtn.addEventListener("click", dismiss, { once: true });
    },

    /** Refetch /api/keys and update the local cache. Called by
     *  user-settings on close so the requireModelKey gate sees the
     *  user's just-configured keys without a full page reload. */
    async refreshKeys() {
      try {
        const r = await fetch("/api/keys");
        if (!r.ok) return;
        const j = await r.json();
        this.keys = Object.fromEntries((j.keys || []).map((k) => [k.provider, k]));
      } catch (e) { /* ignore */ }
    },

    /** Refetch /api/agents and re-render the sidebar. Called after a
     *  user creates a new director via the new-agent overlay. */
    async refreshAgents() {
      try {
        const r = await fetch("/api/agents");
        if (!r.ok) return;
        const j = await r.json();
        this.agents = j.agents || [];
        this.agentsById = Object.fromEntries(this.agents.map((a) => [a.id, a]));
        // /api/agents returns the chair as a sibling field. Keep it on
        // currentChair so the sidebar can surface it even when no room
        // is loaded; chat resolution still flips it on room load.
        if (j.chair) this.currentChair = j.chair;
        if (this.currentChair) this.agentsById[this.currentChair.id] = this.currentChair;
        this.renderSidebarAgents();
        this.renderSidebarCounts();
      } catch (e) { /* ignore */ }
    },

    async loadInitial() {
      const [prefsRes, keysRes, agentsRes, roomsRes] = await Promise.all([
        fetch("/api/prefs"),
        fetch("/api/keys"),
        fetch("/api/agents"),
        fetch("/api/rooms"),
      ]);
      if (prefsRes.ok)  this.prefs  = await prefsRes.json();
      if (keysRes.ok)   {
        const j = await keysRes.json();
        this.keys = Object.fromEntries((j.keys || []).map((k) => [k.provider, k]));
      }
      if (agentsRes.ok) {
        const j = await agentsRes.json();
        this.agents = j.agents || [];
        this.agentsById = Object.fromEntries(this.agents.map((a) => [a.id, a]));
        if (j.chair) {
          this.currentChair = j.chair;
          this.agentsById[j.chair.id] = j.chair;
        }
      }
      if (roomsRes.ok)  {
        const j = await roomsRes.json();
        this.rooms = j.rooms || [];
      }
    },

    // ── Routing ───────────────────────────────────────────────
    handleRoute() {
      const m = (location.hash || "").match(/^#\/r\/([a-z0-9]+)/i);
      if (m && m[1]) {
        if (this.currentRoomId !== m[1]) this.openRoom(m[1]);
        return;
      }
      // All Reports has its own hash so refresh / back-button preserve
      // the view + sidebar selection. Without this, refresh on the
      // reports page falls through to closeRoom and the New Room
      // composer takes over the highlight.
      if (/^#\/reports$/i.test(location.hash || "")) {
        this.openAllReports();
        return;
      }
      // No explicit room in the hash — land on the new-room composer
      // (ChatGPT / Claude style: default = fresh, existing rooms live
      // in the sidebar). The composer renders inside closeRoom →
      // renderEmptyState. Previously we auto-opened the first selectable
      // room; that's been retired so users always start on the composer
      // unless they explicitly navigate to a room.
      this.closeRoom();
    },

    /** Choose a sensible default room when none is in the URL hash. */
    firstSelectableRoom() {
      if (!this.rooms || !this.rooms.length) return null;
      const rank = (status) => (status === "live" ? 0 : status === "paused" ? 1 : 2);
      const sorted = this.rooms.slice().sort((a, b) => {
        const dr = rank(a.status) - rank(b.status);
        if (dr !== 0) return dr;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
      return sorted[0] || null;
    },

    navigateToRoom(roomId) {
      location.hash = "#/r/" + roomId;
    },

    // ── Room lifecycle ────────────────────────────────────────
    async openRoom(roomId) {
      this.disconnectSSE();

      let data;
      try {
        const r = await fetch("/api/rooms/" + encodeURIComponent(roomId));
        if (!r.ok) {
          this.closeRoom();
          return;
        }
        data = await r.json();
      } catch (e) {
        this.closeRoom();
        return;
      }

      // We may be coming from the All Reports view OR an agent profile
      // — make sure the room main view is the visible one and the
      // others are hidden. The agent-view hide is what stops a stale
      // profile (left visible by the dashboard's restore-on-load tick
      // when a saved agent id resolves mid-navigation) from sitting
      // on top of the room the user just opened.
      const reportsView = document.querySelector('[data-main-view="reports"]');
      const roomView = document.querySelector('[data-main-view="room"]');
      const agentView = document.querySelector('[data-main-view="agent"]');
      if (reportsView) reportsView.setAttribute("hidden", "");
      if (agentView && !agentView.hasAttribute("hidden")) {
        agentView.setAttribute("hidden", "");
        agentView.innerHTML = "";
      }
      if (roomView)    roomView.removeAttribute("hidden");
      document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));

      // Drop conveneState if it belongs to a different room — protects
      // against stale "preparing…" leaking into a sibling room when
      // the user navigates mid-convening.
      if (this.conveneState && this.conveneState.roomId !== roomId) {
        this.conveneState = null;
      }
      // Also drop conveneState when opening a room that ALREADY has a
      // chair message (we're re-loading an in-progress or established
      // room — convening is past).
      if (this.conveneState && (data.messages || []).some((m) =>
        m.authorKind === "agent" && data.chair && m.authorId === data.chair.id
      )) {
        this.conveneState = null;
      }

      this.currentRoomId = roomId;
      this.currentRoom = data.room;
      this.currentMessages = data.messages || [];
      this.currentMembers = data.members || [];
      this.currentChair = data.chair || null;
      this.currentQueue = data.queue || [];
      this.currentRound = data.round || { spoken: 0, total: 0 };
      this.currentKeyPoints = data.keyPoints || [];
      // The chair isn't in /api/agents (filtered to directors), but the
      // chat resolver needs it for messages with authorId = chair.id.
      if (this.currentChair) this.agentsById[this.currentChair.id] = this.currentChair;
      // pause-pending is a transient UI state belonging to a single room;
      // clear it whenever we navigate.
      document.documentElement.classList.remove("pause-pending");
      // We have a real room loaded — drop the empty-state flag so the
      // input bar, speaking queue, and footer chrome reappear.
      document.documentElement.classList.remove("no-room");

      // Briefs · for adjourned rooms, fetch every brief that's been
      // filed (initial + any "add perspective" regenerations). Default
      // active to the newest. The full list drives the tab strip in
      // the brief card when length > 1.
      this.currentBrief = null;
      this.currentBriefs = [];
      if (data.room.status === "adjourned") {
        try {
          const br = await fetch("/api/rooms/" + encodeURIComponent(roomId) + "/briefs");
          if (br.ok) {
            const j = await br.json();
            this.currentBriefs = Array.isArray(j.briefs) ? j.briefs : [];
            this.currentBrief = this.currentBriefs[0] || null;
          }
        } catch (e) { /* ignore */ }
        // Zombie detection · if the active brief looks like an
        // un-streamed placeholder (empty body) AND the server is no
        // longer generating it, the previous browser session was
        // killed mid-generation. Surface a clear failure with a
        // retry CTA instead of leaving the user stuck on "loading".
        if (this.currentBrief && this.isBriefPlaceholder(this.currentBrief, data.room)) {
          await this.checkBriefHealth(this.currentBrief);
        }
      }

      document.documentElement.setAttribute("data-status", data.room.status);

      this.renderRoom();
      this.markActiveRoom(roomId);
      this.connectSSE(roomId);
      // Fresh room · force-scroll to the latest message and start the
      // scroll watcher so subsequent auto-scrolls respect the user.
      this.chatStuckToBottom = true;
      this.scrollChatToBottom(true);
      this.bindChatScrollWatch();
    },

    closeRoom() {
      this.disconnectSSE();
      this.cancelContinueCountdown();
      this.currentRoomId = null;
      this.currentRoom = null;
      this.currentMessages = [];
      this.currentMembers = [];
      this.currentChair = null;
      this.currentQueue = [];
      this.currentRound = { spoken: 0, total: 0 };
      this.currentKeyPoints = [];
      this.currentBrief = null;
      this.currentBriefs = [];
      // Drop any in-flight convening card so a stale "preparing…"
      // doesn't bleed into the next room or back to the empty state.
      this.conveneState = null;
      // If the URL still carries a room hash (e.g. user clicked
      // "+ New room" while a room was open), clear it via
      // replaceState so subsequent clicks on the SAME room id in the
      // sidebar fire hashchange and re-open it. Without this, the URL
      // stays at #/r/<id>, hash already matches the link target, and
      // the link click is a no-op.
      if (/^#\/r\//.test(location.hash || "")) {
        try {
          history.replaceState(null, "", location.pathname + location.search);
        } catch { /* ignore */ }
      }
      document.documentElement.classList.remove("pause-pending");
      document.documentElement.setAttribute("data-status", "live");
      // No room loaded — flag the page so CSS can hide chat affordances
      // (input bar, speaking queue, paused/adjourned bars) that don't
      // belong on the starter / empty state.
      document.documentElement.classList.add("no-room");
      this.renderEmptyState();
      this.markActiveRoom(null);
    },

    // ── SSE ───────────────────────────────────────────────────
    connectSSE(roomId) {
      try {
        this.sse = new EventSource("/api/rooms/" + encodeURIComponent(roomId) + "/stream");
      } catch (e) {
        return;
      }

      this.sse.addEventListener("hello", () => {});

      this.sse.addEventListener("message-appended", (e) => {
        const data = JSON.parse(e.data);
        if (data.messageId && !this.currentMessages.some((m) => m.id === data.messageId)) {
          this.currentMessages.push({
            id: data.messageId,
            roomId: roomId,
            authorKind: data.authorKind,
            authorId: data.authorId,
            replyToId: data.replyToId || null,
            body: data.body || "",
            meta: data.meta || {},
            roundNum: data.roundNum || 1,
            createdAt: data.createdAt,
          });
          // Convening card · clear the moment any chair message lands
          // (convening speech, clarify, anything). The card has done
          // its job; the chair is taking over from here. We re-render
          // the whole chat below so the card's slot is replaced by
          // the chair bubble cleanly. Without the full repaint, the
          // card would linger because appendMessageDom only adds the
          // new bubble — it doesn't remove the convening node.
          let dropConveneCard = false;
          if (
            this.conveneState &&
            data.authorKind === "agent" &&
            this.currentChair &&
            data.authorId === this.currentChair.id
          ) {
            this.conveneState = null;
            dropConveneCard = true;
          }
          if (dropConveneCard) {
            this.renderChat();
          } else {
            this.appendMessageDom(this.currentMessages[this.currentMessages.length - 1]);
          }

          // The user's own message always force-scrolls (they want to
          // see what they just sent). Director / chair appends only
          // auto-scroll if the user was already following the bottom.
          this.scrollChatToBottom(data.authorKind === "user");

          // If this is the user message we deferred via the queue
          // modal, the orchestrator just delivered it — clear the
          // placeholder row in the speaking queue.
          this.clearPendingUserPlaceholder(this.currentMessages[this.currentMessages.length - 1]);

          // Triage by message kind:
          //   · round-prompt — new chair prompt, start the countdown
          //   · chair settings ping — informational, leave countdown alone
          //   · anything else — interruption: cancel countdown + flip
          //     any prior round-prompts to "spent" since the room moved on.
          const meta = data.meta || {};
          const isRoundPrompt = meta.kind === "round-prompt";
          const isChairSettings =
            data.authorKind === "agent" &&
            data.authorId === this.currentChair?.id &&
            meta.kind === "settings";
          if (isRoundPrompt) {
            this.maybeStartContinueCountdown();
          } else if (!isChairSettings) {
            this.cancelContinueCountdown();
            this.repaintAllRoundPrompts();
          }
        }
      });

      this.sse.addEventListener("message-token", (e) => {
        const data = JSON.parse(e.data);
        const msg = this.currentMessages.find((m) => m.id === data.messageId);
        if (!msg) return;
        msg.body += data.delta;
        this.updateMessageBodyDom(data.messageId, msg.body, true);
        this.scrollChatToBottom();
      });

      this.sse.addEventListener("message-final", (e) => {
        const data = JSON.parse(e.data);
        const msg = this.currentMessages.find((m) => m.id === data.messageId);
        if (msg) {
          msg.meta = msg.meta || {};
          msg.meta.streaming = false;
          msg.meta.speakerStatus = "final";
        }
        this.updateMessageBodyDom(data.messageId, msg ? msg.body : "", false);
        // A director just stopped streaming → the manual round-end
        // button may have flipped from disabled to enabled, and the
        // auto-continue countdown may now be eligible to start.
        this.refreshRoundEndButton();
        this.maybeStartContinueCountdown();
      });

      this.sse.addEventListener("message-error", (e) => {
        const data = JSON.parse(e.data);
        const msg = this.currentMessages.find((m) => m.id === data.messageId);
        if (msg) msg.meta = { ...(msg.meta || {}), error: data.message };
        this.updateMessageBodyDom(data.messageId, msg ? msg.body : `[error: ${data.message}]`, false);
      });

      this.sse.addEventListener("message-removed", (e) => {
        const data = JSON.parse(e.data);
        // Drop the empty placeholder bubble.
        this.currentMessages = this.currentMessages.filter((m) => m.id !== data.messageId);
        const article = document.querySelector(`[data-message-id="${data.messageId}"]`);
        if (article) article.remove();
      });

      // Full body+meta replacement · used by tool-use rows whose
      // status flips running → done|failed once the side-effect
      // (URL fetch) completes. We re-render the affected message in
      // place so the row's body, meta-driven status glyph, and
      // streaming flag all sync.
      this.sse.addEventListener("message-updated", (e) => {
        const data = JSON.parse(e.data);
        const msg = this.currentMessages.find((m) => m.id === data.messageId);
        if (msg) {
          msg.body = data.body;
          msg.meta = data.meta || {};
        }
        // Re-render via a chat repaint · the tool-use renderer is
        // selected by meta.kind so it rebuilds with the new status.
        this.renderChat();
      });

      this.sse.addEventListener("queue-update", (e) => {
        const data = JSON.parse(e.data);
        this.currentQueue = data.queue || [];
        if (data.round) this.currentRound = data.round;
        this.renderQueue();
      });

      this.sse.addEventListener("config-event", (e) => {
        const data = JSON.parse(e.data);
        const kind = data.kind;
        const payload = data.payload || {};

        // Helper · keep sidebar in sync with the current room's status changes.
        const syncSidebar = (patch) => {
          const inList = this.rooms.find((r) => r.id === this.currentRoomId);
          if (inList) Object.assign(inList, patch);
          this.renderSidebarRooms();
        };

        if (kind === "room-paused") {
          const ts = payload.pausedAt || Date.now();
          if (this.currentRoom) {
            this.currentRoom.status = "paused";
            this.currentRoom.pausedAt = ts;
          }
          document.documentElement.classList.remove("pause-pending");
          document.documentElement.setAttribute("data-status", "paused");
          this.renderHeader();
          this.renderPausedBar();
          syncSidebar({ status: "paused", pausedAt: ts });
        } else if (kind === "room-resumed") {
          if (this.currentRoom) {
            this.currentRoom.status = "live";
            this.currentRoom.pausedAt = null;
          }
          document.documentElement.setAttribute("data-status", "live");
          this.renderHeader();
          syncSidebar({ status: "live", pausedAt: null });
          // Drop any paused-supplement overlay · the supplement endpoint
          // 409s once the room is live, so leaving the modal up is just
          // a confusing no-op for the user.
          this.closePausedSupplementOverlay?.();
        } else if (kind === "room-adjourned") {
          const ts = payload.adjournedAt || Date.now();
          if (this.currentRoom) {
            this.currentRoom.status = "adjourned";
            this.currentRoom.adjournedAt = ts;
          }
          document.documentElement.setAttribute("data-status", "adjourned");
          this.renderHeader();
          syncSidebar({ status: "adjourned", adjournedAt: ts });
        } else if (kind === "brief-started") {
          this.markBriefEvent();
          this.currentBrief = {
            id: payload.briefId,
            title: "Generating…",
            bodyMd: "",
            style: payload.style || "mckinsey",
            // Chair name + language carried for the generating-state kicker
            // ("{Chair} is preparing the minutes…") and stage labels. The
            // language is inferred server-side from the room subject.
            chairName: payload.chairName || (this.currentChair?.name) || "Chair",
            language: payload.language === "zh" ? "zh" : "en",
            pipelineStartedAt: Date.now(),
            // Stage checklist · seeded with all three stages in pending
            // state. brief-stage events flip them active → done as the
            // pipeline progresses. startedAt is captured when each
            // stage first becomes active so the UI can display elapsed
            // time alongside the ETA range.
            stages: {
              extract:  { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              compose:  { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              scaffold: { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              write:    { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
            },
          };
          this.renderBrief();
          // Start the per-second tick driving elapsed/substage animation.
          this.ensureBriefStageTick();
          // Heartbeat watcher — surfaces Retry on stall / timeout.
          this.ensureBriefStallWatch();
          // Surface the View Report button + hide the no-brief CTA.
          this.renderHeader();
          this.renderChat();
          // Pull the user's eye onto the freshly-mounted card so the
          // click that triggered generation has visible feedback.
          this.scrollToBriefCard();
        } else if (kind === "brief-stage") {
          this.markBriefEvent();
          if (this.currentBrief) {
            const st = this.currentBrief.stages || (this.currentBrief.stages = {
              extract:  { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              compose:  { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              scaffold: { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              write:    { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
            });
            const key = payload.stage;
            if (key && st[key]) {
              const newStatus = payload.status || "active";
              // Capture start time when the stage first becomes active.
              if (newStatus === "active" && st[key].status !== "active") {
                st[key].startedAt = Date.now();
              }
              // Capture finish time when the stage transitions to done
              // so the displayed elapsed freezes at completion. Without
              // this, the per-stage timer kept ticking off Date.now()
              // forever — the user couldn't read each stage's actual
              // duration at a glance.
              if (newStatus === "done" && st[key].status !== "done" && !st[key].finishedAt) {
                st[key].finishedAt = Date.now();
              }
              st[key].status = newStatus;
              st[key].detail = payload.detail || "";
              st[key].progress = payload.progress || null;
              // Server-computed ETA range (token-based estimate). Stored on
              // the stage so renderBriefStages prefers it over the static
              // BRIEF_STAGE_META defaults.
              if (payload.etaSec && typeof payload.etaSec.lo === "number") {
                st[key].etaSec = payload.etaSec;
              }
            }
            this.renderBrief();
            // Start a 1s tick that re-renders the stages while at least one
            // is active. Drives the elapsed counter + rotating substage
            // descriptors so the UI never feels frozen during long stages.
            this.ensureBriefStageTick();
          }
        } else if (kind === "brief-token") {
          this.markBriefEvent();
          // Accumulate the body. Throttle the re-render to once per ~250ms
          // so the writing-stage word count animates without thrashing on
          // every chunk.
          if (!this.currentBrief) this.currentBrief = { id: payload.briefId, title: "", bodyMd: "" };
          this.currentBrief.bodyMd += (payload.delta || "");
          const now = Date.now();
          if (!this._briefTokenLastRender || (now - this._briefTokenLastRender) > 250) {
            this._briefTokenLastRender = now;
            this.renderBrief();
          }
        } else if (kind === "brief-final") {
          this.markBriefEvent();
          if (this.currentBrief) {
            this.currentBrief.title = payload.title || this.currentBrief.title;
          }
          this.stopBriefStageTick();
          this.stopBriefStallWatch();
          this.renderBrief();
          this.renderHeader();
          // Refresh the FULL brief list so the tab strip picks up the
          // newly filed brief (including any "add a perspective"
          // regenerations). Active brief = the just-finalised one.
          if (this.currentRoomId) {
            fetch("/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/briefs")
              .then((r) => (r.ok ? r.json() : null))
              .then((j) => {
                if (j && Array.isArray(j.briefs)) {
                  this.currentBriefs = j.briefs;
                  // Match by id so the tab the user is viewing stays the
                  // same brief — defaulting to the just-finalised one.
                  const justFiledId = payload.briefId;
                  const match = this.currentBriefs.find((b) => b.id === justFiledId);
                  this.currentBrief = match || this.currentBriefs[0] || null;
                  this.renderBrief();
                  this.renderHeader();
                }
              })
              .catch(() => {});
          }
        } else if (kind === "brief-error") {
          this.markBriefEvent();
          if (this.currentBrief) this.currentBrief.error = payload.message;
          this.stopBriefStageTick();
          this.stopBriefStallWatch();
          this.renderBrief();
        } else if (kind === "settings-changed") {
          const ch = payload.changes || {};
          if (this.currentRoom) {
            if (ch.mode) this.currentRoom.mode = ch.mode.to;
            if (ch.intensity) this.currentRoom.intensity = ch.intensity.to;
            if (ch.briefStyle) this.currentRoom.briefStyle = ch.briefStyle.to;
          }
          this.renderHeader();
          syncSidebar({
            mode: this.currentRoom?.mode,
            intensity: this.currentRoom?.intensity,
            briefStyle: this.currentRoom?.briefStyle,
          });
        } else if (kind === "members-changed") {
          // Patch currentMembers in place from the server's add/remove
          // diff. Avoids a refetch round-trip and keeps the chat header,
          // brief stamps, and roster strip in sync as soon as the chair's
          // welcome message lands.
          const added = Array.isArray(payload.added) ? payload.added : [];
          const removed = Array.isArray(payload.removed) ? payload.removed : [];
          const byId = {};
          for (const a of (this.agents || [])) byId[a.id] = a;
          if (removed.length > 0) {
            this.currentMembers = this.currentMembers.filter((m) => !removed.includes(m.id));
          }
          for (const aid of added) {
            if (byId[aid] && !this.currentMembers.find((m) => m.id === aid)) {
              this.currentMembers.push(byId[aid]);
            }
          }
          this.renderHeader();
          this.renderQueue();
        } else if (kind === "round-ended") {
          // Chair finished a round-end summary. Persist the parsed key
          // points + flip the room into awaiting-continue so the input
          // bar and round-end card know to surface Continue / Adjourn.
          if (this.currentRoom) this.currentRoom.awaitingContinue = true;
          // The server emits round-ended from inside the chair's
          // onComplete — by definition the message has finished
          // streaming, even though the message-final SSE arrives a
          // tick later. Flip the local meta now so the immediate
          // renderChat call below renders the round-end card (which
          // is gated on `!streaming`).
          if (payload.messageId) {
            const m = this.currentMessages.find((x) => x.id === payload.messageId);
            if (m) {
              m.meta = m.meta || {};
              m.meta.streaming = false;
              m.meta.speakerStatus = "final";
            }
          }
          const points = Array.isArray(payload.keyPoints) ? payload.keyPoints : [];
          for (const p of points) {
            // Drop any prior placeholder points for the same message id.
            this.currentKeyPoints = this.currentKeyPoints.filter((x) => x.id !== p.id);
            this.currentKeyPoints.push({
              id: p.id,
              messageId: payload.messageId,
              roundNum: payload.roundNum,
              body: p.body,
              vote: p.vote ?? null,
              position: p.position,
            });
          }
          // Re-render the chat so the round-end card appears under the
          // chair's message.
          this.renderChat();
          this.scrollChatToBottom();
          this.refreshRoundEndButton();
          this.refreshContinueButton();
        } else if (kind === "key-point-voted") {
          const p = this.currentKeyPoints.find((x) => x.id === payload.keyPointId);
          if (p) {
            p.vote = payload.vote;
            this.repaintRoundEndCard(p.messageId);
          }
        } else if (kind === "round-resumed") {
          if (this.currentRoom) this.currentRoom.awaitingContinue = false;
          // Strip the [Continue / Adjourn] CTAs from the rendered chat;
          // the round-end card stays as a historical artefact.
          document.querySelectorAll(".round-end-card .kp-ctas").forEach((el) => {
            el.outerHTML = `<div class="kp-ctas-spent">// continued</div>`;
          });
        } else if (kind === "clarify-ready") {
          // Chair signaled READY (or hit the turn cap) — directors are
          // about to take over. Drop the clarify flag so the queue
          // preview gives way to the real queue and the round-end /
          // continue gates don't stay locked.
          if (this.currentRoom) this.currentRoom.awaitingClarify = false;
          this.renderQueue();
          this.refreshRoundEndButton();
          this.refreshContinueButton();
        } else if (kind === "room-opened") {
          // no-op: we already have full state
        } else if (kind === "auto-pick-started") {
          // Show "analyzing topic" stage on the convening card. The
          // card was seeded by createRoom so it's already on screen;
          // we just confirm the stage in case SSE arrived before the
          // card was rendered.
          if (this.conveneState) {
            this.conveneState.stage = "analyzing";
            this.renderChat();
          }
        } else if (kind === "member-added" && payload?.autoPicked) {
          // Director seated by the auto-picker · patch currentMembers
          // in place so the room header / cast picker / chat
          // resolver pick up the new agent. No chat re-render here ·
          // the chair's convening message will land via
          // message-appended below.
          const agent = (this.agents || []).find((a) => a.id === payload.agentId);
          if (agent) {
            if (!this.currentMembers.find((m) => m.id === agent.id)) {
              this.currentMembers.push(agent);
            }
            this.renderHeader();
            this.renderQueue();
            // Convening card · advance to "seating" and append the
            // newly-seated director's avatar so the user watches the
            // cast assemble in real time.
            if (this.conveneState) {
              this.conveneState.stage = "seating";
              if (!this.conveneState.seated.find((a) => a.id === agent.id)) {
                this.conveneState.seated.push(agent);
              }
              this.renderChat();
            }
          }
        } else if (kind === "auto-pick-complete") {
          // Cast is fully seated. Advance the convening card to
          // "preparing" — chair's about to start streaming.
          if (this.conveneState) {
            this.conveneState.stage = "preparing";
            this.renderChat();
          }
        }
      });

      this.sse.onerror = () => {
        // EventSource will auto-reconnect; nothing to do.
      };
    },

    disconnectSSE() {
      if (this.sse) {
        try { this.sse.close(); } catch (e) { /* */ }
        this.sse = null;
      }
      // Drop the brief watcher · the brief belongs to a room and the
      // watcher would otherwise keep ticking against a stale id.
      this.stopBriefStallWatch();
    },

    // ── Actions ───────────────────────────────────────────────
    async createRoom({ subject, agentIds, mode, intensity, briefStyle, autoPick }) {
      const r = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject,
          agentIds,
          mode: mode || "constructive",
          intensity: intensity || "sharp",
          briefStyle: briefStyle || "auto",
          ...(autoPick ? { autoPick: true } : {}),
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "failed to create room");
      }
      const data = await r.json();
      // Optimistic insert + sync from server so the sidebar reflects everything
      // (auto-inserted opening message bumped updatedAt etc.).
      this.rooms = [data.room, ...this.rooms.filter((x) => x.id !== data.room.id)];
      this.renderSidebarRooms();
      void this.refreshRoomsList(); // background reconcile
      // Seed the convening card immediately so the chat doesn't sit
      // blank during the ~10s of auto-pick + chair speech generation.
      // Initial stage depends on autoPick: when the user manually
      // picked their cast, we skip "analyzing"/"seating" and head
      // straight to "preparing". When auto-picked, all three stages run.
      // roomId is tagged so openRoom can detect a mismatch and drop
      // a stale state if the user navigates to a different room
      // mid-convening.
      this.conveneState = {
        roomId: data.room.id,
        subject: subject || "",
        stage: autoPick ? "analyzing" : "preparing",
        seated: autoPick ? [] : (agentIds || []).map((id) => this.agentsById[id]).filter(Boolean),
        autoPicked: !!autoPick,
        startedAt: Date.now(),
      };
      this.navigateToRoom(data.room.id);
      return data.room;
    },

    async refreshRoomsList() {
      try {
        const r = await fetch("/api/rooms");
        if (!r.ok) return;
        const j = await r.json();
        this.rooms = j.rooms || [];
        this.renderSidebarRooms();
      } catch (e) { /* ignore — sidebar keeps last known state */ }
    },

    async sendMessage(text, mentions, mode) {
      if (!this.currentRoomId) return;
      const trimmed = (text || "").trim();
      if (!trimmed) return;
      // Pre-flight · sending a message triggers director responses or
      // chair clarify · both need a model key. Block and prompt the
      // user to configure one when missing.
      if (!(await this.requireModelKey())) return;
      // Rapid-fire guard · ignore re-entrant or near-instant repeats so
      // a fast Enter-key burst or a frantic Send-button mash collapses
      // into one POST.
      if (this.sendInFlight) return;
      const now = Date.now();
      if (now - this.lastSendAt < this.SEND_THROTTLE_MS) return;
      this.lastSendAt = now;
      this.sendInFlight = true;
      try {
        const payload = { body: trimmed, mentions: mentions || [] };
        if (mode === "after-speaker") payload.mode = "after-speaker";
        const r = await fetch(
          "/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/messages",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || "send failed");
        }
        // SSE will push the message-appended; nothing to do locally.
      } finally {
        this.sendInFlight = false;
      }
    },

    /** Single entry point for the input bar. Reads the input, decides
     *  whether to send immediately, prompt for interrupt-or-queue, or
     *  bail entirely. Used by both the Enter-key and Send-button
     *  handlers so debounce / queue logic lives in exactly one place.
     *
     *  Returns true if the input was consumed (cleared / queued / sent),
     *  false if nothing happened (e.g. blank input). */
    submitFromComposer(input) {
      if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) return false;
      const text = input.value;
      if (!text || !text.trim()) return false;
      // Already in-flight or just sent · swallow this attempt so the
      // burst doesn't double-fire.
      if (this.sendInFlight) return false;
      if (Date.now() - this.lastSendAt < this.SEND_THROTTLE_MS) return false;
      // If a director is mid-turn AND we don't already have a queued
      // message, ask the user how to proceed.
      if (this.isAgentSpeaking() && !this.pendingUserMessage) {
        this.openSendChoiceModal(text);
        return true;
      }
      input.value = "";
      this.sendMessage(text).catch((err) => alert("Send failed: " + err.message));
      return true;
    },

    /** Pre-flight gate · returns true when at least one MODEL provider
     *  (anthropic / openai / google / xai / deepseek / openrouter) is
     *  configured. When none are, opens a modal asking the user to
     *  configure a key + returns false. Brave is search, not a model
     *  provider, so it's intentionally excluded.
     *
     *  Async + self-correcting: if the local cache reports no key, we
     *  refetch /api/keys once before deciding. This protects against
     *  the cache going stale right after onboarding saves a key — the
     *  cache was loaded at app.init time, BEFORE the user entered
     *  anything. Without this re-check the gate would pop "configure
     *  API key" immediately after the user configured one.
     *
     *  Wire this in front of any AI-triggering action (convene a room,
     *  send a message, end round, continue, adjourn, post-hoc brief)
     *  so the user gets a clear redirect to settings instead of a
     *  silent backend failure. Callers must `await`. */
    async requireModelKey() {
      if (this.hasAnyModelKey()) return true;
      // Cache miss · the local copy might be stale. Refresh once
      // before showing the modal.
      await this.refreshKeys();
      if (this.hasAnyModelKey()) return true;
      this.openNoKeyModal();
      return false;
    },

    /** Pure cache read · returns true when the local app.keys map
     *  reports any model provider as configured. Used by the gate
     *  and (via wrappers) anywhere downstream UI needs the answer
     *  cheaply. */
    hasAnyModelKey() {
      const MODEL_PROVIDERS = ["anthropic", "openai", "google", "xai", "deepseek", "openrouter"];
      const keys = this.keys || {};
      return MODEL_PROVIDERS.some((p) => keys[p] && keys[p].configured);
    },

    /** Modal that fires when an AI action is attempted but no model
     *  provider key is configured. Two CTAs · open settings (preferred)
     *  or dismiss. Same chrome family as openSendChoiceModal so the
     *  visual treatment stays consistent. */
    openNoKeyModal() {
      this.closeNoKeyModal();
      const lang = (this.prefs && /[一-鿿]/.test(this.prefs.name || this.prefs.intro || "")) ? "zh" : "en";
      const t = lang === "zh"
        ? {
            title: "需要配置模型 API key",
            deck: "Boardroom 的董事和主席都依赖大模型。请先配置一个模型供应商的 API key（Anthropic / OpenAI / Google / xAI / DeepSeek / OpenRouter），任意一个即可。",
            primary: "[ 打开设置 ▸ ]",
            dismiss: "[ 取消 ]",
            classification: "● ai · 缺少模型 key",
            tag: "▸ 配置 API key",
          }
        : {
            title: "Configure a model API key",
            deck: "The chair and directors run on a large language model. Configure at least one provider key (Anthropic / OpenAI / Google / xAI / DeepSeek / OpenRouter) before AI features will work.",
            primary: "[ Open settings ▸ ]",
            dismiss: "[ Dismiss ]",
            classification: "● ai · no model key",
            tag: "▸ Configure API key",
          };
      const html = `
        <div id="no-key-overlay" class="pc-overlay" data-no-key-overlay>
          <div class="pc-modal">
            <div class="pc-classification">
              <span><span class="dot">●</span> ${this.escape(t.classification.replace(/^●\s*/, ""))}</span>
              <span class="right">// frontend gate</span>
            </div>
            <div class="pc-head">
              <div class="pc-tag">${this.escape(t.tag)}</div>
              <h2 class="pc-title">${this.escape(t.title)}</h2>
              <p class="pc-deck">${this.escape(t.deck)}</p>
            </div>
            <div class="pc-body">
              <button type="button" class="pc-choice primary" data-no-key-open-settings>
                <div class="pc-choice-mark">${this.escape(t.primary)}</div>
                <div class="pc-choice-deck">${lang === "zh" ? "进入 Preferences → API Key 配置任意一个模型供应商。" : "Jump to Preferences → API Key. Paste any one provider's key to unlock the room."}</div>
              </button>
              <button type="button" class="pc-choice ghost" data-no-key-dismiss>
                <div class="pc-choice-mark">${this.escape(t.dismiss)}</div>
              </button>
            </div>
          </div>
        </div>
      `;
      const wrap = document.createElement("div");
      wrap.innerHTML = html.trim();
      document.body.appendChild(wrap.firstChild);
    },
    closeNoKeyModal() {
      const el = document.getElementById("no-key-overlay");
      if (el) el.remove();
    },

    /** Modal · "an agent is speaking · interrupt or wait?". Mirrors the
     *  pause-choice overlay's chrome (.pc-overlay / .pc-modal) so the
     *  visual treatment is consistent across modal prompts. */
    openSendChoiceModal(text) {
      this.closeSendChoiceModal();
      const speaker = this.currentQueue[0]
        ? this.agentsById[this.currentQueue[0].agentId]
        : null;
      const speakerLabel = speaker ? this.escape(speaker.name) : "a director";
      const html = `
        <div id="send-choice-overlay" class="pc-overlay">
          <div class="pc-modal">
            <div class="pc-classification">
              <span><span class="dot">●</span> send · choose</span>
              <span class="right">// ${speakerLabel} is speaking</span>
            </div>
            <div class="pc-head">
              <div class="pc-tag">▸ Send while mid-turn</div>
              <h2 class="pc-title">${speakerLabel} is in the middle of a turn.</h2>
              <p class="pc-deck">Cut in now, or queue your message until they finish?</p>
            </div>
            <div class="pc-body">
              <button type="button" class="pc-choice" data-send-choice="interrupt">
                <div class="pc-choice-mark">▸ Interrupt and send now</div>
                <div class="pc-choice-deck">Drops into the room immediately. ${speakerLabel} keeps going on top of your message.</div>
              </button>
              <button type="button" class="pc-choice primary" data-send-choice="queue">
                <div class="pc-choice-mark">→ Wait until ${speakerLabel} finishes</div>
                <div class="pc-choice-deck">Your message lines up after the current turn and posts as soon as it ends.</div>
              </button>
              <button type="button" class="pc-choice ghost" data-send-choice="cancel">
                <div class="pc-choice-mark">✕ Cancel</div>
                <div class="pc-choice-deck">Keep typing and decide later.</div>
              </button>
            </div>
          </div>
        </div>
      `;
      const wrap = document.createElement("div");
      wrap.innerHTML = html.trim();
      document.body.appendChild(wrap.firstChild);
      // Stash the pending text so the choice handler can use it.
      this._sendChoiceText = text;
      this._sendChoiceSpeakerId = this.currentQueue[0]?.agentId || null;
    },
    closeSendChoiceModal() {
      const el = document.getElementById("send-choice-overlay");
      if (el) el.remove();
      this._sendChoiceText = null;
      this._sendChoiceSpeakerId = null;
    },
    handleSendChoice(choice) {
      const text = this._sendChoiceText || "";
      const speakerId = this._sendChoiceSpeakerId;
      const input = document.querySelector('.input-bar input, [data-send-input]');
      this.closeSendChoiceModal();
      if (choice === "cancel" || !text.trim()) return;
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
        input.value = "";
      }
      if (choice === "interrupt") {
        this.sendMessage(text).catch((err) => alert("Send failed: " + err.message));
        return;
      }
      if (choice === "queue") {
        // Show the user a placeholder row in the speaking queue so they
        // know the message is parked.
        this.pendingUserMessage = text;
        this.pendingForSpeakerId = speakerId;
        this.renderQueue();
        // Server-side coordination: orchestrator drains this between
        // turns, AFTER current speaker finishes and BEFORE the next
        // speaker starts. The placeholder clears when the
        // message-appended SSE comes back.
        this.sendMessage(text, [], "after-speaker").catch((err) => {
          alert("Queue failed: " + err.message);
          this.pendingUserMessage = null;
          this.pendingForSpeakerId = null;
          this.renderQueue();
        });
        return;
      }
    },

    /** When the deferred user message lands in the chat, clear our
     *  client-side placeholder row in the speaking queue. Called from
     *  the message-appended SSE handler when the appended message is
     *  authored by the user and matches our queued text. */
    clearPendingUserPlaceholder(message) {
      if (!this.pendingUserMessage) return;
      if (!message || message.authorKind !== "user") return;
      // Match by exact body since multiple queued messages aren't
      // supported (the modal only opens when no pending exists).
      if ((message.body || "").trim() !== (this.pendingUserMessage || "").trim()) return;
      this.pendingUserMessage = null;
      this.pendingForSpeakerId = null;
      this.renderQueue();
    },

    /** Adjourn the room. `opts.skipBrief = true` flips the server into
     *  no-report mode (room is still terminal, but no LLM call is
     *  fired and the briefs panel stays empty). */
    async adjournRoom(opts) {
      if (!this.currentRoomId) return;
      const skipBrief = !!(opts && opts.skipBrief);
      // Pre-flight · adjourn-with-brief triggers the brief writer
      // pipeline (3 LLM stages). When skipBrief=true the chair just
      // posts the no-brief marker without LLM calls, so we let it
      // through even without a key.
      if (!skipBrief && !(await this.requireModelKey())) return;
      const r = await fetch(
        "/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/adjourn",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(skipBrief ? { skipBrief: true } : {}),
        },
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "adjourn failed");
      }
      // SSE will push room-adjourned + brief-* events.
    },

    /* ─── Adjourn overlay ────────────────────────────────────────
       Triggered from the paused-footer Adjourn link, the chair's
       round-end card "Adjourn & file brief" CTA, and the round-prompt
       Adjourn link. Confirms the user wants to terminate the room and
       file a standard report — or opts out entirely with "End without
       report". No format picker; the report is one standard layout. */

    openAdjournOverlay(opts) {
      if (!this.currentRoomId) return;
      this.closeAdjournOverlay();
      // mode · "adjourn" (default) wraps up the room AND files a brief.
      //        "generate-brief" runs against an already-adjourned room
      //        whose user originally skipped the brief but now wants one.
      const mode = (opts && opts.mode === "generate-brief") ? "generate-brief" : "adjourn";
      const isGen = mode === "generate-brief";
      const room = this.currentRoom || {};
      const turns = (this.currentMessages || []).filter((m) => m.body && m.body.trim()).length;
      const status = room.status || "live";
      const titleTxt = isGen ? "Generate the report" : "File the report?";
      const classifyTxt = isGen ? "room · generate report" : "room · adjourn";
      const classifyRight = isGen ? "// post-hoc" : "// terminal";
      const confirmTxt = isGen ? "[ Generate ]" : "[ Adjourn & file ]";
      const subjectTxt = room.subject || room.name || "—";
      const memberCount = (this.currentMembers || []).length;
      const html = `
        <div class="adjourn-overlay" id="adjourn-overlay" role="dialog" aria-modal="true" data-adjourn-mode="${this.escape(mode)}">
          <div class="adjourn-backdrop" data-adjourn-close></div>
          <div class="adjourn-modal" role="document">

            <div class="adjourn-classification">
              <span><span class="dot">●</span> ${this.escape(classifyTxt)}</span>
              <span class="right">${this.escape(classifyRight)}</span>
            </div>

            <header class="adjourn-head">
              <div>
                <div class="meta">// room #<span>${this.escape(String(room.number ?? "—"))}</span> · <span class="${status === "live" ? "live" : "status"}">${this.escape(status)}</span> · <span>${turns}</span> turns</div>
                <div class="title">${this.escape(titleTxt)}</div>
              </div>
              <button type="button" class="adjourn-close" data-adjourn-close aria-label="Close">✕</button>
            </header>

            <div class="adjourn-body">
              <div class="adjourn-summary">
                <div class="adjourn-summary-row">
                  <span class="adjourn-summary-key">// subject</span>
                  <span class="adjourn-summary-val">${this.escape(subjectTxt)}</span>
                </div>
                <div class="adjourn-summary-row">
                  <span class="adjourn-summary-key">// authors</span>
                  <span class="adjourn-summary-val">${memberCount} agents</span>
                </div>
                <div class="adjourn-summary-row">
                  <span class="adjourn-summary-key">// turns</span>
                  <span class="adjourn-summary-val">${turns}</span>
                </div>
              </div>
              <p class="adjourn-summary-note">
                The chair compiles a standard report from the room's transcript —
                situation, key findings, and implications. The room is marked
                adjourned and the report is filed in the chat.
              </p>
            </div>

            <footer class="adjourn-foot">
              ${isGen ? `<span class="adjourn-skip-spacer"></span>` : `
              <button type="button" class="adjourn-skip-btn" data-adjourn-skip>
                <span class="adjourn-skip-mark">⊘</span>
                <span>End without report</span>
              </button>`}
              <div class="adjourn-foot-actions">
                <button type="button" class="adjourn-cancel" data-adjourn-close>[ Cancel ]</button>
                <button type="button" class="adjourn-confirm" data-adjourn-confirm>${this.escape(confirmTxt)}</button>
              </div>
            </footer>
          </div>
        </div>
      `;
      const wrap = document.createElement("div");
      wrap.innerHTML = html.trim();
      document.body.appendChild(wrap.firstChild);
      document.body.style.overflow = "hidden";
      // Esc closes the overlay. Listener auto-detaches on close so
      // we don't accumulate handlers across opens.
      this._adjournEsc = (ev) => {
        if (ev.key === "Escape") {
          ev.stopImmediatePropagation();
          this.closeAdjournOverlay();
        }
      };
      document.addEventListener("keydown", this._adjournEsc, true);
    },

    closeAdjournOverlay() {
      const el = document.getElementById("adjourn-overlay");
      if (el) el.remove();
      document.body.style.overflow = "";
      if (this._adjournEsc) {
        document.removeEventListener("keydown", this._adjournEsc, true);
        this._adjournEsc = null;
      }
    },

    /** Open the "Add perspective" overlay · gives the user a textarea to
     *  describe an angle the chair should weave into a regenerated
     *  report. Confirm → POST /api/rooms/:id/brief with { supplement }. */
    openSupplementOverlay() {
      if (!this.currentRoomId || !this.currentBrief) return;
      this.closeSupplementOverlay();
      const lang = this.currentBrief?.language === "zh" ? "zh" : "en";
      const t = lang === "zh"
        ? {
            classify: "report · 补充视角再生成",
            classifyRight: "// regenerate",
            title: "补充一个视角",
            metaPrefix: "// 当前报告",
            placeholder: "请描述这次想让 chair 额外考虑的角度。例如：\n· 加入一个商业可行性的视角\n· 重点关注女性用户的体验\n· 把时间窗口拉长到 5 年看",
            hint: "这个视角会被织入现有的 Findings、Recommendations、New Questions 等段落，不会单独成节。",
            cancel: "[ Cancel ]",
            confirm: "[ Regenerate ]",
            confirmBusy: "[ Regenerating… ]",
          }
        : {
            classify: "report · regenerate with supplement",
            classifyRight: "// regenerate",
            title: "Add a perspective",
            metaPrefix: "// Current report",
            placeholder: "Describe an angle you want the chair to additionally consider. For example:\n· Bring in a commercial-viability lens\n· Center the experience of women users\n· Stretch the time window to 5 years",
            hint: "The new perspective will be woven through the existing Findings, Recommendations, and New Questions sections — not added as a separate section.",
            cancel: "[ Cancel ]",
            confirm: "[ Regenerate ]",
            confirmBusy: "[ Regenerating… ]",
          };
      const html = `
        <div class="supplement-overlay" id="supplement-overlay" role="dialog" aria-modal="true">
          <div class="supplement-backdrop" data-supplement-close></div>
          <div class="supplement-modal" role="document">
            <div class="supplement-classification">
              <span><span class="dot">●</span> ${this.escape(t.classify)}</span>
              <span class="right">${this.escape(t.classifyRight)}</span>
            </div>
            <header class="supplement-head">
              <div>
                <div class="meta">${this.escape(t.metaPrefix)} · <span>${this.escape(this.currentBrief.title || "(untitled)")}</span></div>
                <div class="title">${this.escape(t.title)}</div>
              </div>
              <button type="button" class="supplement-close" data-supplement-close aria-label="Close">✕</button>
            </header>
            <div class="supplement-body">
              <textarea class="supplement-input" data-supplement-input rows="6" placeholder="${this.escape(t.placeholder)}"></textarea>
              <p class="supplement-hint">${this.escape(t.hint)}</p>
            </div>
            <footer class="supplement-foot">
              <button type="button" class="supplement-cancel" data-supplement-close>${this.escape(t.cancel)}</button>
              <button type="button" class="supplement-confirm" data-supplement-confirm data-busy-label="${this.escape(t.confirmBusy)}">${this.escape(t.confirm)}</button>
            </footer>
          </div>
        </div>
      `;
      const wrap = document.createElement("div");
      wrap.innerHTML = html.trim();
      document.body.appendChild(wrap.firstChild);
      document.body.style.overflow = "hidden";
      // Esc closes.
      this._supplementEsc = (ev) => {
        if (ev.key === "Escape") {
          ev.stopImmediatePropagation();
          this.closeSupplementOverlay();
        }
      };
      document.addEventListener("keydown", this._supplementEsc, true);
      // Focus the input.
      setTimeout(() => {
        const input = document.querySelector("[data-supplement-input]");
        if (input) input.focus();
      }, 30);
    },

    closeSupplementOverlay() {
      const el = document.getElementById("supplement-overlay");
      if (el) el.remove();
      document.body.style.overflow = "";
      if (this._supplementEsc) {
        document.removeEventListener("keydown", this._supplementEsc, true);
        this._supplementEsc = null;
      }
    },

    /** Paused-supplement overlay · lets the user drop in an extra
     *  thought while the room is paused. The text is posted as a
     *  user message immediately (lands in the chat as the freshest
     *  user input) but the saved director queue is left untouched —
     *  so when they click Resume, the previously-paused director
     *  takes over with the supplement already in their context.
     *  Effectively the supplement plays "first" in the resumed
     *  flow, and the rest of the queue continues in order. Reuses
     *  the existing .supplement-* CSS classes for visual parity. */
    openPausedSupplementOverlay() {
      if (!this.currentRoomId || !this.currentRoom) return;
      if (this.currentRoom.status !== "paused") return;
      this.closePausedSupplementOverlay();
      const lang = this.composerLanguage();
      const t = lang === "zh"
        ? {
            classify: "room · 暂停时补充",
            classifyRight: "// queued first",
            title: "补充一个观点",
            metaPrefix: "// 当前房间",
            placeholder: "想补一个观点 · 一个想再追问的细节 · 一个让董事们重新考虑的角度。\n\n会立即作为你的发言进入对话；点击 [ Resume ] 后，董事们会先看到这条再继续。",
            hint: "暂停期间的补充会以你的身份立即出现在对话里，原本的发言队列不变；恢复后队首董事将带着这条补充开口。",
            cancel: "[ Cancel ]",
            confirm: "[ Add to chat ]",
            confirmBusy: "[ Posting… ]",
          }
        : {
            classify: "room · paused supplement",
            classifyRight: "// queued first",
            title: "Add a supplemental input",
            metaPrefix: "// Current room",
            placeholder: "Drop in an extra thought, a follow-up question, or an angle you'd like the board to take into account.\n\nIt lands in the chat as your message right now; when you hit [ Resume ], the next director picks up with this in front of them.",
            hint: "Posted while paused, the supplement lands as your message immediately; the saved speaker queue is untouched. After resume, the next director responds with the supplement first.",
            cancel: "[ Cancel ]",
            confirm: "[ Add to chat ]",
            confirmBusy: "[ Posting… ]",
          };
      const subject = (this.currentRoom.subject || "").trim() || (lang === "zh" ? "(无主题)" : "(no subject)");
      const html = `
        <div class="supplement-overlay" id="paused-supplement-overlay" role="dialog" aria-modal="true">
          <div class="supplement-backdrop" data-paused-supplement-close></div>
          <div class="supplement-modal" role="document">
            <div class="supplement-classification">
              <span><span class="dot">●</span> ${this.escape(t.classify)}</span>
              <span class="right">${this.escape(t.classifyRight)}</span>
            </div>
            <header class="supplement-head">
              <div>
                <div class="meta">${this.escape(t.metaPrefix)} · <span>${this.escape(subject)}</span></div>
                <div class="title">${this.escape(t.title)}</div>
              </div>
              <button type="button" class="supplement-close" data-paused-supplement-close aria-label="Close">✕</button>
            </header>
            <div class="supplement-body">
              <textarea class="supplement-input" data-paused-supplement-input rows="6" placeholder="${this.escape(t.placeholder)}"></textarea>
              <p class="supplement-hint">${this.escape(t.hint)}</p>
            </div>
            <footer class="supplement-foot">
              <button type="button" class="supplement-cancel" data-paused-supplement-close>${this.escape(t.cancel)}</button>
              <button type="button" class="supplement-confirm" data-paused-supplement-confirm data-busy-label="${this.escape(t.confirmBusy)}">${this.escape(t.confirm)}</button>
            </footer>
          </div>
        </div>
      `;
      const wrap = document.createElement("div");
      wrap.innerHTML = html.trim();
      document.body.appendChild(wrap.firstChild);
      document.body.style.overflow = "hidden";
      this._pausedSupplementEsc = (ev) => {
        if (ev.key === "Escape") {
          ev.stopImmediatePropagation();
          this.closePausedSupplementOverlay();
        }
      };
      document.addEventListener("keydown", this._pausedSupplementEsc, true);
      // Cmd/Ctrl-Enter submits — long-form textarea convention.
      this._pausedSupplementSubmit = (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
          const overlay = document.getElementById("paused-supplement-overlay");
          if (!overlay) return;
          ev.preventDefault();
          this.submitPausedSupplement();
        }
      };
      document.addEventListener("keydown", this._pausedSupplementSubmit, true);
      setTimeout(() => {
        const input = document.querySelector("[data-paused-supplement-input]");
        if (input) input.focus();
      }, 30);
    },

    closePausedSupplementOverlay() {
      const el = document.getElementById("paused-supplement-overlay");
      if (el) el.remove();
      document.body.style.overflow = "";
      if (this._pausedSupplementEsc) {
        document.removeEventListener("keydown", this._pausedSupplementEsc, true);
        this._pausedSupplementEsc = null;
      }
      if (this._pausedSupplementSubmit) {
        document.removeEventListener("keydown", this._pausedSupplementSubmit, true);
        this._pausedSupplementSubmit = null;
      }
    },

    async submitPausedSupplement() {
      const overlay = document.getElementById("paused-supplement-overlay");
      if (!overlay) return;
      const input = overlay.querySelector("[data-paused-supplement-input]");
      const btn = overlay.querySelector("[data-paused-supplement-confirm]");
      const text = input ? (input.value || "").trim() : "";
      if (!text) {
        if (input) input.focus();
        return;
      }
      if (!this.currentRoomId) return;
      const origLabel = btn ? btn.textContent : "";
      const busyLabel = btn ? btn.getAttribute("data-busy-label") || origLabel : "";
      if (btn) { btn.disabled = true; btn.textContent = busyLabel; }
      try {
        const r = await fetch(
          "/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/paused-input",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ body: text }),
          },
        );
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || ("HTTP " + r.status));
        }
        // SSE will push the message-appended event; chat updates itself.
        this.closePausedSupplementOverlay();
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = origLabel; }
        alert("Add input failed: " + (e && e.message ? e.message : e));
      }
    },

    /** Confirm-handler · grabs the textarea, posts to the brief endpoint,
     *  closes the overlay. Server emits brief-started + brief-* SSE
     *  events as for a normal generate; the existing handlers replace
     *  the in-place card with the regenerating state. */
    async submitSupplement() {
      const overlay = document.getElementById("supplement-overlay");
      if (!overlay) return;
      const input = overlay.querySelector("[data-supplement-input]");
      const text = input ? (input.value || "").trim() : "";
      if (!text) {
        if (input) input.focus();
        return;
      }
      const btn = overlay.querySelector("[data-supplement-confirm]");
      const orig = btn ? btn.textContent : "";
      const busy = btn ? btn.getAttribute("data-busy-label") : "";
      if (btn) { btn.disabled = true; btn.textContent = busy || "…"; }
      try {
        const r = await fetch(
          "/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/brief",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ supplement: text }),
          },
        );
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || ("HTTP " + r.status));
        }
        // Reset currentBrief to a fresh "generating" placeholder so the
        // brief-started SSE event lands cleanly. The SSE flow will fill
        // it back in.
        if (this.currentBrief) {
          this.currentBrief.bodyMd = "";
          this.currentBrief.title = "Generating…";
          this.currentBrief.error = null;
        }
        this.renderBrief();
        this.closeSupplementOverlay();
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
        alert("Regenerate failed: " + (e && e.message ? e.message : e));
      }
    },

    /** A brief is a "placeholder" when it has no body and its title
     *  still matches the seed (room subject). The orchestrator inserts
     *  this row up-front and streams body/title in. If we re-load the
     *  page mid-stream and find this state, we have to ask the server
     *  whether streaming is actually in flight. */
    isBriefPlaceholder(brief, room) {
      if (!brief) return false;
      if (brief.bodyMd && brief.bodyMd.trim()) return false;
      if (!room) return true;
      // Title matches the seed (room subject) → never got an updated title.
      // Or title is the literal "Generating…" placeholder.
      const seed = (room.subject || "").trim();
      const t = (brief.title || "").trim();
      return !t || t === seed || t === "Generating…";
    },

    /** Ask the server whether the placeholder brief is still being
     *  generated. Three branches:
     *
     *    1. `generating === false && !hasBody` · zombie. Server lost
     *       the pipeline (restart / crash / silent error). Flip the
     *       brief into the recovery UI with a retry button.
     *    2. `generating === true` · the pipeline is still running.
     *       The server hands back a `state` snapshot — which stage
     *       is active, when each stage started, the ETA window. We
     *       hydrate `currentBrief.stages` from it so the loading UI
     *       (with elapsed-second counter + ETA range) resumes
     *       exactly where the previous browser session was watching.
     *    3. `generating === false && hasBody` · already done. No
     *       loading state to restore — renderBrief will show the
     *       finished card from `currentBrief`. */
    async checkBriefHealth(brief) {
      if (!brief || !brief.id) return;
      try {
        const r = await fetch("/api/briefs/" + encodeURIComponent(brief.id) + "/status");
        if (!r.ok) return;
        const j = await r.json();
        if (j.generating === false && !j.hasBody) {
          // Orphan. Flip into the error UI which now carries a retry button.
          brief.error = "interrupted";
          brief.interrupted = true;
          this.stopBriefStallWatch();
          this.renderBrief();
          return;
        }
        if (j.generating === true && j.state) {
          this.hydrateBriefStagesFromState(brief, j.state);
          this.renderBrief();
          this.ensureBriefStageTick();
          this.ensureBriefStallWatch();
        }
      } catch { /* ignore — leave the loading state */ }
    },

    /** Restore `currentBrief.stages` from a server-side state
     *  snapshot. Called when the user lands mid-generation (page
     *  refresh, deep link). Maps the wire shape (`{ status,
     *  startedAt, finishedAt, detail, progress, etaSec }` per stage
     *  key) into the same client-side shape the SSE handlers
     *  produce, so renderBriefStages doesn't care which path
     *  populated it. */
    hydrateBriefStagesFromState(brief, state) {
      if (!brief || !state) return;
      // Carry the chair / language / style across so kicker copy
      // ("{Chair} is preparing…") matches the running pipeline.
      if (typeof state.chairName === "string" && state.chairName) brief.chairName = state.chairName;
      if (state.language === "zh" || state.language === "en") brief.language = state.language;
      if (typeof state.style === "string" && state.style) brief.style = state.style;
      if (typeof state.pipelineStartedAt === "number") brief.pipelineStartedAt = state.pipelineStartedAt;
      // Seed all four stages in pending state (extract / compose /
      // scaffold / write — the order rendered by renderBriefStages),
      // then overlay whichever ones the server already advanced.
      const seed = () => ({ status: "pending", detail: "", progress: null, startedAt: null, etaSec: null, finishedAt: null });
      const stages = brief.stages || (brief.stages = {
        extract:  seed(),
        compose:  seed(),
        scaffold: seed(),
        write:    seed(),
      });
      for (const key of Object.keys(state.stages || {})) {
        if (!stages[key]) stages[key] = seed();
        const incoming = state.stages[key] || {};
        const target = stages[key];
        target.status     = incoming.status === "done" ? "done"
                          : incoming.status === "active" ? "active"
                          : target.status;
        target.startedAt  = typeof incoming.startedAt === "number" ? incoming.startedAt : target.startedAt;
        target.finishedAt = typeof incoming.finishedAt === "number" ? incoming.finishedAt : target.finishedAt;
        target.detail     = typeof incoming.detail === "string" ? incoming.detail : target.detail;
        target.progress   = incoming.progress || target.progress;
        target.etaSec     = (incoming.etaSec && typeof incoming.etaSec.lo === "number") ? incoming.etaSec : target.etaSec;
      }
    },

    /** Delete a single brief from this room's history. Asks for
     *  confirmation, then DELETE /api/briefs/:id, then patches local
     *  state. If the active brief is removed, switch to the newest
     *  remaining brief; if none remain, clear the card entirely. */
    async deleteBriefAt(briefId) {
      if (!briefId) return;
      const target = (this.currentBriefs || []).find((b) => b.id === briefId);
      const lang = (this.currentBrief?.language === "zh" || (this.currentRoom?.subject && /[一-鿿]/.test(this.currentRoom.subject))) ? "zh" : "en";
      const confirmText = lang === "zh"
        ? (target?.supplement
            ? `删除这份"${target.supplement.trim().slice(0, 20)}${target.supplement.length > 20 ? "…" : ""}"补充视角的报告？此操作不可恢复。`
            : "删除这份报告？此操作不可恢复。")
        : (target?.supplement
            ? `Delete the "${target.supplement.trim().slice(0, 20)}${target.supplement.length > 20 ? "…" : ""}" version? This can't be undone.`
            : "Delete this report? This can't be undone.");
      if (!confirm(confirmText)) return;
      try {
        const r = await fetch("/api/briefs/" + encodeURIComponent(briefId), { method: "DELETE" });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || ("HTTP " + r.status));
        }
      } catch (e) {
        alert((lang === "zh" ? "删除失败：" : "Delete failed: ") + (e && e.message ? e.message : e));
        return;
      }
      // Patch local state · remove the deleted brief, refresh active.
      this.currentBriefs = (this.currentBriefs || []).filter((b) => b.id !== briefId);
      if (this.currentBrief && this.currentBrief.id === briefId) {
        this.currentBrief = this.currentBriefs[0] || null;
      }
      this.renderBrief();
    },

    /** Retry handler for the orphaned-brief recovery UI. Posts to the
     *  brief endpoint with no supplement, kicking off a fresh
     *  generation. The new brief replaces the orphan as currentBrief
     *  via the brief-started SSE event. */
    async retryBriefGeneration() {
      if (!this.currentRoomId) return;
      try {
        const r = await fetch(
          "/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/brief",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
        );
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || ("HTTP " + r.status));
        }
        // Optimistically clear the error so the card flips back to a
        // fresh "generating" state until brief-started arrives. The
        // server's brief-started event will replace currentBrief with
        // the real new placeholder.
        if (this.currentBrief) {
          this.currentBrief.error = null;
          this.currentBrief.interrupted = false;
          this.currentBrief.timedOut = false;
          this.currentBrief.bodyMd = "";
          this.currentBrief.title = "Generating…";
          this.currentBrief.pipelineStartedAt = Date.now();
        }
        this._lastBriefEventAt = Date.now();
        this._lastBriefHealthPollAt = 0;
        this.renderBrief();
        this.scrollToBriefCard();
      } catch (e) {
        alert("Regenerate failed: " + (e && e.message ? e.message : e));
      }
    },

    /** Confirm-button handler · dispatches the right API call.
     *  When the overlay was opened in "generate-brief" mode we hit the
     *  post-hoc brief endpoint instead of /adjourn. */
    async submitAdjourn() {
      const overlay = document.getElementById("adjourn-overlay");
      if (!overlay) return;
      const mode = overlay.getAttribute("data-adjourn-mode") || "adjourn";
      const isGen = mode === "generate-brief";
      const skipPicked = overlay.querySelector(".adjourn-skip-btn.picked") !== null;
      const btn = overlay.querySelector("[data-adjourn-confirm]");
      const origLabel = isGen ? "[ Generate ]" : "[ Adjourn & file ]";
      const busyLabel = isGen ? "[ Generating… ]" : "[ Adjourning… ]";
      if (btn) { btn.disabled = true; btn.textContent = busyLabel; }
      try {
        if (isGen) {
          await this.generateBriefForAdjournedRoom();
        } else if (skipPicked) {
          await this.adjournRoom({ skipBrief: true });
        } else {
          await this.adjournRoom({});
        }
        this.closeAdjournOverlay();
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = origLabel; }
        alert((isGen ? "Generate failed: " : "Adjourn failed: ") + (e && e.message ? e.message : e));
      }
    },

    /** POST /api/rooms/:id/brief · post-hoc brief for an adjourned room
     *  whose user originally skipped the brief. Server emits the same
     *  brief-started / brief-token / brief-final SSE events as a normal
     *  adjourn, so the existing handlers in connectSSE handle the rest. */
    async generateBriefForAdjournedRoom() {
      if (!this.currentRoomId) return;
      // Pre-flight · the brief writer is a 3-stage LLM pipeline (per-
      // director extract → composer → final write). All require a key.
      if (!(await this.requireModelKey())) return;
      const r = await fetch(
        "/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/brief",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "brief generation failed");
      }
    },

    async pauseRoom(mode) {
      if (!this.currentRoomId) return;
      // Soft pause: flip the input bar to a "pausing after current turn"
      // overlay immediately, even before the request resolves. The SSE
      // room-paused event will clear the class once the orchestrator
      // actually transitions the room.
      if (mode === "soft") {
        document.documentElement.classList.add("pause-pending");
      }
      let r;
      try {
        r = await fetch(
          "/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/pause",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: mode || "hard" }),
          },
        );
      } catch (err) {
        document.documentElement.classList.remove("pause-pending");
        throw err;
      }
      if (!r.ok) {
        document.documentElement.classList.remove("pause-pending");
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "pause failed");
      }
      const data = await r.json();
      // Soft pause is pending — the SSE room-paused event will flip the UI
      // when the current speaker actually finishes. Don't transition now.
      if (data.pending) return;
      // Server resolved synchronously (hard pause, or soft with no speaker).
      document.documentElement.classList.remove("pause-pending");
      if (data.room) {
        this.currentRoom = data.room;
        document.documentElement.setAttribute("data-status", "paused");
        this.renderHeader();
        this.renderPausedBar();
      }
    },

    /** True if a director is currently streaming (queue head is "speaking"). */
    isAgentSpeaking() {
      return this.currentQueue.length > 0 && this.currentQueue[0]?.status === "speaking";
    },

    openPauseChoiceModal() {
      this.closePauseChoiceModal();
      const speaker = this.currentQueue[0]
        ? this.agentsById[this.currentQueue[0].agentId]
        : null;
      const speakerLabel = speaker ? this.escape(speaker.name) : "a director";
      const html = `
        <div id="pause-choice-overlay" class="pc-overlay">
          <div class="pc-modal">
            <div class="pc-classification">
              <span><span class="dot">●</span> pause · choose</span>
              <span class="right">// the room is mid-turn</span>
            </div>
            <div class="pc-head">
              <div class="pc-tag">▸ Pause discussion</div>
              <h2 class="pc-title">${speakerLabel} is speaking right now.</h2>
              <p class="pc-deck">How would you like to pause?</p>
            </div>
            <div class="pc-body">
              <button type="button" class="pc-choice danger" data-pause-choice="hard">
                <div class="pc-choice-mark">▍ Stop immediately</div>
                <div class="pc-choice-deck">Cut their reply mid-sentence. The partial response is dropped.</div>
              </button>
              <button type="button" class="pc-choice primary" data-pause-choice="soft">
                <div class="pc-choice-mark">⌛ After they finish</div>
                <div class="pc-choice-deck">Let ${speakerLabel} complete this turn, then pause the queue.</div>
              </button>
              <button type="button" class="pc-choice ghost" data-pause-choice="cancel">
                <div class="pc-choice-mark">↩ Cancel</div>
                <div class="pc-choice-deck">Keep the discussion running.</div>
              </button>
            </div>
          </div>
        </div>
      `;
      document.body.insertAdjacentHTML("beforeend", html);
    },

    closePauseChoiceModal() {
      const el = document.getElementById("pause-choice-overlay");
      if (el) el.remove();
    },

    /**
     * Patch room settings (tone, intensity, report style). Pushes to the
     * backend, then mirrors the result back into local state. The SSE
     * `settings-changed` event also fires so other tabs / refreshed views
     * pick it up.
     */
    async updateRoomSettings(patch) {
      if (!this.currentRoomId) return;
      const r = await fetch(
        "/api/rooms/" + encodeURIComponent(this.currentRoomId),
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch || {}),
        },
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "settings update failed");
      }
      const data = await r.json();
      if (data.room) {
        this.currentRoom = data.room;
        // Mirror onto the sidebar entry too so the row reflects the change
        // immediately (subject doesn't change but tone/intensity might be
        // surfaced there in the future).
        const inList = this.rooms.find((x) => x.id === this.currentRoomId);
        if (inList) Object.assign(inList, data.room);
        this.renderHeader();
        this.renderSidebarRooms();
      }
      return data.room;
    },

    /** Repaint a single round-end card from the live currentKeyPoints
     *  data. Easier (and more reliable) than mutating individual button
     *  classList — anything that affects the card's appearance lives in
     *  one render path. */
    repaintRoundEndCard(messageId) {
      if (!messageId) return;
      const card = document.querySelector(`.round-end-card[data-round-end-card="${messageId}"]`);
      if (!card) return;
      const html = this.roundEndCardHtml(messageId);
      if (!html) return;
      // Wrap in a temp container so we can extract the new card element.
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      const next = tmp.firstElementChild;
      if (next) card.replaceWith(next);
    },

    /** Vote on a chair-generated key point. Toggles off if the same
     *  vote is already active. */
    async voteKeyPoint(kpId, requested) {
      if (!this.currentRoomId || !kpId) return;
      const existing = this.currentKeyPoints.find((p) => p.id === kpId);
      if (!existing) return;
      const prev = existing.vote;
      const vote = prev === requested ? null : requested;
      // Optimistic data update + repaint the whole card so the chip
      // styles come straight from the data layer (no class-toggle race).
      existing.vote = vote;
      this.repaintRoundEndCard(existing.messageId);
      try {
        const r = await fetch(
          `/api/rooms/${encodeURIComponent(this.currentRoomId)}/keypoints/${encodeURIComponent(kpId)}/vote`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ vote }),
          },
        );
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || "vote failed");
        }
      } catch (e) {
        // Revert local optimism on failure.
        existing.vote = prev;
        this.repaintRoundEndCard(existing.messageId);
        alert("Vote failed: " + (e && e.message ? e.message : e));
      }
    },

    /* ─── Auto-Continue countdown ───
       When the room is idle (queue drained, no speaker streaming, no
       chair-driven pause), the queue-strip Continue button runs a
       10-second countdown. On timeout it auto-fires; any user action
       cancels the countdown and the user can restart by waiting
       through another idle moment. */
    continueCountdown: { interval: null, deadline: 0, secondsLeft: 0, autoFiring: false },
    /** Total seconds the auto-continue waits before firing. */
    AUTO_CONTINUE_SECONDS: 10,

    /** True if the room is in the right shape for an auto-continue.
     *  Requires an active round-prompt in the chat — the in-chat
     *  Continue button is now the affordance (the queue strip's
     *  buttons were removed). */
    canAutoContinue() {
      const r = this.currentRoom;
      if (!r) return false;
      if (r.status !== "live") return false;
      if (r.awaitingClarify) return false;
      if (r.awaitingContinue) return false;
      if (!this.isRoundComplete()) return false;
      return !!this.activeRoundPromptId();
    },

    /** Spin up the countdown if conditions are met; otherwise cancel. */
    maybeStartContinueCountdown() {
      if (!this.canAutoContinue()) {
        this.cancelContinueCountdown("not-idle");
        this.refreshContinueButton();
        return;
      }
      // Already counting — leave alone.
      if (this.continueCountdown.interval) {
        this.refreshContinueButton();
        return;
      }
      const total = this.AUTO_CONTINUE_SECONDS;
      this.continueCountdown.deadline = Date.now() + total * 1000;
      this.continueCountdown.secondsLeft = total;
      this.continueCountdown.autoFiring = false;
      this.continueCountdown.interval = setInterval(() => this.tickContinueCountdown(), 1000);
      this.refreshContinueButton();
    },

    cancelContinueCountdown() {
      if (this.continueCountdown.interval) {
        clearInterval(this.continueCountdown.interval);
        this.continueCountdown.interval = null;
      }
      this.continueCountdown.secondsLeft = 0;
      this.continueCountdown.deadline = 0;
      this.refreshContinueButton();
    },

    tickContinueCountdown() {
      const left = Math.max(0, Math.ceil((this.continueCountdown.deadline - Date.now()) / 1000));
      this.continueCountdown.secondsLeft = left;
      this.refreshContinueButton();
      if (left <= 0 && !this.continueCountdown.autoFiring) {
        this.continueCountdown.autoFiring = true;
        clearInterval(this.continueCountdown.interval);
        this.continueCountdown.interval = null;
        // Auto-continue fires the same action as the manual click.
        this.continueRoom().catch((err) => {
          alert("Auto-continue failed: " + err.message);
        });
      }
    },

    /** Repaint the Continue button in the queue strip. Disabled when
     *  the room isn't idle; shows the countdown when active. */
    refreshContinueButton() {
      const btn = document.querySelector("[data-continue-auto]");
      if (!btn) return;
      const idle = this.canAutoContinue();
      btn.disabled = !idle;
      const timer = btn.querySelector("[data-continue-timer]");
      if (this.continueCountdown.interval && idle) {
        const total = this.AUTO_CONTINUE_SECONDS;
        const left = this.continueCountdown.secondsLeft;
        if (timer) timer.textContent = `· ${left}s`;
        btn.classList.add("counting");
        const pct = Math.max(0, Math.min(100, ((total - left) / total) * 100));
        btn.style.setProperty("--qc-progress", `${pct}%`);
      } else {
        if (timer) timer.textContent = "";
        btn.classList.remove("counting");
        btn.style.setProperty("--qc-progress", `0%`);
      }
    },

    /** Manually wrap the current round and ask the chair to file the
     *  key-point vote. Triggered from the queue-strip button. */
    async requestRoundEnd() {
      if (!this.currentRoomId) return;
      // Pre-flight · the chair runs a streamed LLM call to generate
      // key points, so a model key is required.
      if (!(await this.requireModelKey())) return;
      // Optimistic local lock so a second click can't fire while the
      // chair is being kicked off — the SSE round-ended event will
      // confirm shortly.
      if (this.currentRoom) this.currentRoom.awaitingContinue = true;
      this.refreshRoundEndButton();
      this.refreshContinueButton();
      this.renderQueue();
      let res;
      try {
        res = await fetch(
          "/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/round-end",
          { method: "POST" },
        );
      } catch (err) {
        // Network blip — back out the optimistic lock.
        if (this.currentRoom) this.currentRoom.awaitingContinue = false;
        this.refreshRoundEndButton();
        alert("Couldn't wrap the round: " + (err && err.message ? err.message : err));
        return;
      }
      if (!res.ok) {
        if (this.currentRoom) this.currentRoom.awaitingContinue = false;
        this.refreshRoundEndButton();
        const e = await res.json().catch(() => ({}));
        alert("Couldn't wrap the round: " + (e.error || res.statusText));
      }
    },

    /** Resume a chair-paused room — releases the next round of directors. */
    async continueRoom() {
      if (!this.currentRoomId) return;
      // Pre-flight · the next round will fire a fresh director queue,
      // each turn requiring a model key.
      if (!(await this.requireModelKey())) return;
      const r = await fetch(
        "/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/continue",
        { method: "POST" },
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        alert("Continue failed: " + (e.error || r.statusText));
        return;
      }
      const data = await r.json();
      if (data.room) {
        this.currentRoom = data.room;
      }
    },

    async resumeRoom() {
      if (!this.currentRoomId) return;
      const r = await fetch(
        "/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/resume",
        { method: "POST" },
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "resume failed");
      }
      const data = await r.json();
      if (data.room) {
        this.currentRoom = data.room;
        document.documentElement.setAttribute("data-status", "live");
        this.renderHeader();
      }
    },

    async deleteAgent(agentId) {
      const agent = (this.agents || []).find((a) => a.id === agentId);
      if (!agent) return;
      if (agent.isSeed) {
        alert("Seeded directors are core to the boardroom and can't be deleted.");
        return;
      }
      const ok = window.confirm(
        `Delete "${agent.name}"?\n\n` +
          "This permanently removes the director, their long-term memory, " +
          "their installed skills, and their seat in any rooms they're in. " +
          "Past transcripts keep the messages they wrote. " +
          "It can't be undone.",
      );
      if (!ok) return;

      let r;
      try {
        r = await fetch("/api/agents/" + encodeURIComponent(agentId), { method: "DELETE" });
      } catch (e) {
        alert("Could not delete: " + (e && e.message ? e.message : e));
        return;
      }
      if (!r.ok) {
        const detail = await r.json().catch(() => ({}));
        alert("Could not delete: " + (detail.error || r.statusText));
        return;
      }

      // If the deleted agent's profile is currently the main view,
      // close it back to the room composer so we don't leave a stale
      // page mounted.
      if (typeof window.closeAgentProfile === "function") {
        try { window.closeAgentProfile(); } catch { /* ignore */ }
      }
      // Drop from the local catalog and re-render the sidebar. Also
      // refresh from the server so any room rosters that referenced
      // this agent get cleaned up in agentsById.
      await this.refreshAgents?.();
      // If the user was viewing a room whose roster included the
      // deleted director, the in-memory currentMembers list still
      // holds that record. Re-fetch the room state on the next nav so
      // it stays consistent — for now just drop the agent from the
      // local agents array (refreshAgents already handled this).
    },

    async deleteRoom(roomId) {
      const room = this.rooms.find((r) => r.id === roomId);
      const label = room ? (room.name || room.subject) : "this room";
      const ok = window.confirm(
        `Delete "${label}"?\n\n` +
          "This permanently removes the transcript, brief, and any saved memory. " +
          "It can't be undone.",
      );
      if (!ok) return;

      let r;
      try {
        r = await fetch("/api/rooms/" + encodeURIComponent(roomId), { method: "DELETE" });
      } catch (e) {
        alert("Could not delete: " + (e && e.message ? e.message : e));
        return;
      }
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        alert("Could not delete: " + (detail || r.statusText));
        return;
      }

      this.rooms = this.rooms.filter((x) => x.id !== roomId);

      if (this.currentRoomId === roomId) {
        // We were viewing the deleted room — drop back to the empty state.
        this.disconnectSSE();
        this.currentRoomId = null;
        this.currentRoom = null;
        this.currentMessages = [];
        this.currentMembers = [];
        this.currentQueue = [];
        this.currentBrief = null;
        location.hash = "";
        document.documentElement.setAttribute("data-status", "live");
        this.renderEmptyState();
      }

      this.renderSidebarRooms();
    },

    // ── Helpers ───────────────────────────────────────────────
    escape(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      }[c]));
    },

    /** Pull a friendly hostname out of a URL string. Used by the
     *  web-search source list to show "nytimes.com" beside the title.
     *  Falls back to the raw input when parsing fails. */
    hostnameOf(url) {
      try {
        const u = new URL(url);
        return u.hostname.replace(/^www\./, "");
      } catch (e) {
        return String(url || "");
      }
    },

    /** Tiny markdown renderer — paragraphs, headings, bullets, tables,
     *  inline emphasis. Tables follow GFM: pipe-delimited rows with a
     *  `| --- |` separator on row 2 and optional `:` alignment markers. */
    renderBody(body) {
      if (!body) return "";
      const esc = this.escape(body);
      // Block-level passes: split on blank lines, classify each block.
      const blocks = esc.split(/\n\s*\n/);
      const out = [];

      const splitRow = (line) =>
        line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const isSeparatorRow = (line) => {
        const cells = splitRow(line);
        if (cells.length === 0) return false;
        return cells.every((c) => /^:?-{3,}:?$/.test(c));
      };
      const alignFromSep = (cell) => {
        const t = cell.trim();
        const left = t.startsWith(":");
        const right = t.endsWith(":");
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return null;
      };

      for (const raw of blocks) {
        const lines = raw.split("\n");
        // Heading? Single line starting with ##
        if (lines.length === 1) {
          const m = /^(#{2,4})\s+(.+)$/.exec(lines[0]);
          if (m) {
            const level = Math.min(m[1].length, 4);
            out.push(`<h${level}>${this.inline(m[2])}</h${level}>`);
            continue;
          }
        }
        // Markdown table · header row + `| --- |` separator + ≥0 body rows.
        // Detected before bullets so a "| - | - |" separator is never
        // mistaken for a bullet list.
        if (lines.length >= 2 && /\|/.test(lines[0]) && isSeparatorRow(lines[1])) {
          const headers = splitRow(lines[0]);
          const aligns = splitRow(lines[1]).map(alignFromSep);
          const rowCount = headers.length;
          const rows = lines.slice(2).map(splitRow);
          const styleFor = (i) => {
            const a = aligns[i];
            return a ? ` style="text-align:${a}"` : "";
          };
          const ths = headers
            .map((h, i) => `<th${styleFor(i)}>${this.inline(h)}</th>`)
            .join("");
          const trs = rows
            .filter((r) => r.length > 0 && r.some((c) => c.length > 0))
            .map((row) => {
              const cells = [];
              for (let i = 0; i < rowCount; i++) {
                cells.push(`<td${styleFor(i)}>${this.inline(row[i] ?? "")}</td>`);
              }
              return `<tr>${cells.join("")}</tr>`;
            })
            .join("");
          out.push(
            `<div class="msg-table-wrap"><table class="msg-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`,
          );
          continue;
        }
        // Bulleted list? All non-empty lines start with - or *
        if (lines.every((l) => /^\s*[-*]\s+/.test(l) || l.trim() === "")) {
          const items = lines
            .filter((l) => l.trim())
            .map((l) => `<li>${this.inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`);
          out.push(`<ul>${items.join("")}</ul>`);
          continue;
        }
        // Markdown blockquote · every non-empty line starts with `&gt; `
        // (escaped from `> `). The whole block becomes one <blockquote>;
        // styling lives in CSS (.msg-bubble blockquote · designed
        // quote-card with mono kicker + italic body, no left border).
        if (lines.every((l) => /^&gt;\s?/.test(l) || l.trim() === "")) {
          const inner = lines
            .filter((l) => l.trim())
            .map((l) => this.inline(l.replace(/^&gt;\s?/, "")))
            .join("<br>");
          out.push(`<blockquote class="msg-quote">${inner}</blockquote>`);
          continue;
        }
        // Otherwise: paragraph (preserve single newlines as <br>).
        out.push(`<p>${this.inline(lines.join("<br>"))}</p>`);
      }

      return out.join("");
    },

    inline(s) {
      let out = s
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");

      const reEscape = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // 1) Highlight references to the USER (the human in the room) first —
      //    these get a lime accent so they read as the addressee. Matches
      //    @Name / /Name where Name is the user's prefs.name (case-
      //    insensitive). We try the full name, then the first token, so
      //    "@Kay Smith" and "@Kay" both light up for a user named "Kay Smith".
      const userName = (this.prefs?.name || "").trim();
      if (userName) {
        const candidates = new Set();
        candidates.add(userName);
        const first = userName.split(/\s+/)[0];
        if (first && first !== userName) candidates.add(first);
        const alt = Array.from(candidates)
          .map(reEscape)
          .sort((a, b) => b.length - a.length)
          .join("|");
        const reUser = new RegExp(`(^|[^\\w/@])([@/])(${alt})\\b`, "gi");
        out = out.replace(reUser, (_, pre, sigil, name) => {
          return `${pre}<span class="msg-mention msg-mention-user">${sigil}${name}</span>`;
        });
      }

      // 2) Then linkify @handle / /handle references that match an agent
      //    in the current room — amber accent so it visually separates
      //    from the user mention above.
      if (this.currentMembers && this.currentMembers.length) {
        const handles = this.currentMembers
          .map((a) => (a.handle || "").replace(/^\//, ""))
          .filter(Boolean)
          .sort((a, b) => b.length - a.length);
        if (handles.length) {
          const re = new RegExp(`(^|[^\\w/@])([@/])(${handles.join("|")})\\b`, "g");
          out = out.replace(re, (_, pre, sigil, name) => {
            return `${pre}<span class="msg-mention msg-mention-agent" data-mention="${name}">${sigil}${name}</span>`;
          });
        }
      }

      // 3) Bare-name auto-wrap · every occurrence of the user's name,
      //    a director's name, or the chair's name gets wrapped in a
      //    subtle inline emphasis even when the writer (LLM or human)
      //    forgot the markdown bold. This is the safety net behind the
      //    convening prompt's `**Name**` rule. We only touch text
      //    segments — never HTML tag interiors — so already-wrapped
      //    names stay intact.
      const bareNames = [];
      if (userName) bareNames.push({ name: userName, kind: "user" });
      const allCast = (this.currentMembers || []).slice();
      if (this.currentChair) allCast.push(this.currentChair);
      for (const a of allCast) {
        if (a && typeof a.name === "string" && a.name.trim()) {
          bareNames.push({ name: a.name.trim(), kind: a.roleKind === "moderator" ? "chair" : "agent" });
        }
      }
      if (bareNames.length > 0) {
        // Sort longest-first so "First Principles" wins over "First".
        bareNames.sort((a, b) => b.name.length - a.name.length);
        const seen = new Set();
        const dedup = bareNames.filter((b) => {
          const k = b.name.toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        const alt = dedup.map((b) => reEscape(b.name)).join("|");
        // Match name with word boundaries · case-insensitive. ASCII
        // \b doesn't always do the right thing for CJK, so we also
        // accept a non-letter / non-digit bookend on either side.
        const reNames = new RegExp(`(^|[^\\p{L}\\p{N}_])(${alt})(?=$|[^\\p{L}\\p{N}_])`, "giu");
        // Walk html tag boundaries · only transform text segments.
        out = out.replace(/(<[^>]*>)|([^<]+)/g, (_full, tag, text) => {
          if (tag) return tag;
          return text.replace(reNames, (_m, pre, name) => {
            // Resolve which kind this name is (case-insensitive lookup).
            const hit = dedup.find((b) => b.name.toLowerCase() === name.toLowerCase());
            const cls = hit && hit.kind ? `msg-name-ref msg-name-ref-${hit.kind}` : "msg-name-ref";
            return `${pre}<strong class="${cls}">${name}</strong>`;
          });
        });
      }
      return out;
    },

    timeFmt(ms) {
      if (!ms) return "";
      const d = new Date(ms);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    },

    relTime(ms) {
      if (!ms) return "";
      const diff = Date.now() - ms;
      const m = Math.floor(diff / 60_000);
      if (m < 1) return "now";
      if (m < 60) return m + "m";
      const h = Math.floor(m / 60);
      if (h < 24) return h + "h";
      const d = Math.floor(h / 24);
      if (d < 7) return d + "d";
      const w = Math.floor(d / 7);
      if (w < 4) return w + "w";
      return Math.floor(d / 30) + "mo";
    },

    // ── Rendering · sidebar rooms ─────────────────────────────
    renderSidebarRooms() {
      this.renderSidebarCounts();
      const list = document.querySelector("[data-rooms-list]");
      if (!list) return;
      const live   = this.rooms.filter((r) => r.status === "live");
      const paused = this.rooms.filter((r) => r.status === "paused");
      const adj    = this.rooms.filter((r) => r.status === "adjourned");

      const renderRow = (r) => {
        const status =
          r.status === "paused"
            ? '<span class="row-status paused">❚❚ paused</span>'
            : "";
        const time =
          r.status === "paused"
            ? this.relTime(r.pausedAt || r.createdAt)
            : r.status === "adjourned"
              ? this.relTime(r.adjournedAt || r.createdAt)
              : this.relTime(r.createdAt);
        const fullTitle = r.name || r.subject || "";
        const tip = r.subject && r.subject !== fullTitle
          ? `${fullTitle}\n${r.subject}`
          : fullTitle;
        // Layout: a wrapper holds the anchor + the delete button as
        // siblings. Putting the <button> inside the <a> is invalid HTML
        // and some browsers route the click to the link, swallowing the
        // delete action — moving it out fixes that.
        return `
          <div class="session-row-shell" data-room-id="${this.escape(r.id)}" data-status="${this.escape(r.status)}">
            <a href="#/r/${this.escape(r.id)}" class="session-row" title="${this.escape(tip)}">
              <div class="row-content">
                <div class="row-top-line">
                  <span class="row-title">${this.escape(fullTitle)}</span>
                  <span class="row-time">${this.escape(time)}</span>
                </div>
                <div class="row-subtitle">${status}${this.escape(r.subject || "")}</div>
              </div>
            </a>
            <button type="button" class="row-delete" data-room-delete title="Delete room">✕</button>
          </div>
        `;
      };

      list.innerHTML = `
        ${live.length > 0 ? `
          <div class="section-header live">
            <span>Live</span>
            <span class="line"></span>
            <span class="badge">${live.length}</span>
          </div>
          ${live.map(renderRow).join("")}
        ` : ""}

        ${paused.length > 0 ? `
          <div class="section-header paused">
            <span>Paused</span>
            <span class="line"></span>
            <span class="badge">${paused.length}</span>
          </div>
          ${paused.map(renderRow).join("")}
        ` : ""}

        <div class="section-header adjourned">
          <span>Adjourned</span>
          <span class="line"></span>
          <span class="badge" data-adjourned-count>${adj.length}</span>
        </div>
        <div class="adjourned-list" data-adjourned-list>
          ${adj.map(renderRow).join("")}
        </div>
        <div class="adjourned-empty" data-adjourned-empty ${adj.length > 0 ? "hidden" : ""}>
          <div class="adjourned-empty-mark">○</div>
          <div class="adjourned-empty-title">no adjourned rooms</div>
          <div class="adjourned-empty-deck">conclude a discussion to file it here.</div>
        </div>
      `;

      this.markActiveRoom(this.currentRoomId);
    },

    markActiveRoom(roomId) {
      document.querySelectorAll(".session-row-shell").forEach((el) => {
        el.classList.toggle("active", roomId !== null && el.dataset.roomId === roomId);
      });
      // The All Reports view is its own destination · navigating to a
      // room or to a composer always clears its highlight.
      document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
      // Sidebar's "+ New room" / "+ New agent" entries · whichever
      // composer mode is active gets the highlight when no room is
      // selected; both clear when a room IS selected.
      const noRoom = roomId === null;
      const isAgentMode = noRoom && this.composerMode === "agent";
      document.querySelectorAll("[data-convene-trigger]").forEach((el) => {
        el.classList.toggle("active", noRoom && !isAgentMode);
      });
      document.querySelectorAll("[data-agent-composer-trigger]").forEach((el) => {
        el.classList.toggle("active", isAgentMode);
      });
      // An agent profile is its own focus — clear agent-row highlights
      // when a room (or composer) becomes the active view. The agent-
      // profile module re-applies its own highlight when it opens.
      if (roomId !== null || this.composerMode === "agent" || this.composerMode === "room") {
        // No-op here — markActiveAgent below clears these explicitly
        // when the agent profile takes focus, and otherwise the agent
        // rows shouldn't be highlighted at all.
      }
    },

    /** Sidebar focus when an agent profile takes the main view. The
     *  agent-profile module calls this after rendering so the new-room
     *  / new-agent / room-row highlights all clear and only the active
     *  agent's row stays marked. Composer mode resets to "room" so any
     *  later → New room flow lands cleanly. */
    markActiveAgent(slug) {
      // Clear the two composer-trigger highlights and any session row
      // that might still be marked from a previous nav.
      document.querySelectorAll("[data-convene-trigger], [data-agent-composer-trigger]").forEach((el) => {
        el.classList.remove("active");
      });
      document.querySelectorAll(".session-row-shell.active").forEach((el) => {
        el.classList.remove("active");
      });
      // The All-Reports trigger highlight + URL hash both belong to a
      // separate destination. Drop them when an agent profile takes
      // focus so refresh on the profile doesn't bounce to /reports.
      document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
      if (/^#\/reports$/i.test(location.hash || "")) {
        try { history.replaceState(null, "", location.pathname + location.search); } catch { /* ignore */ }
      }
      // Mark the agent row matching the active slug.
      document.querySelectorAll(".agent-row").forEach((r) => {
        r.classList.toggle("active", r.dataset.agentProfile === slug);
      });
      // Reset composer mode so subsequent transitions are clean — the
      // user is no longer "creating" anything.
      this.composerMode = "room";
    },

    /** Render the sidebar's Agents panel from the live agent catalog.
     *  Three buckets so the seeded directors keep their familiar
     *  groupings while user-created ones stack into a Custom section
     *  at the top: Pinned (any pinned agent) → Custom (isSeed=false)
     *  → Core (isSeed=true). Empty buckets render nothing. */
    renderSidebarAgents() {
      const list = document.querySelector("[data-agents-list]");
      if (!list) return;
      const all = (this.agents || []).slice();
      const pinned = all.filter((a) => a.isPinned);
      const custom = all.filter((a) => !a.isPinned && !a.isSeed);
      const core   = all.filter((a) => !a.isPinned && a.isSeed);

      const PIN_GLYPH = '<svg viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6h2v-6h5v-2l-2-2z"/></svg>';

      const renderRow = (a, opts = {}) => {
        const status = "active"; // every persisted director is active in v1
        const time = this.relTime(a.createdAt) || "—";
        const pinBtn = `
          <button type="button" class="pin-toggle" title="${a.isPinned ? "Unpin" : "Pin"}" data-pin-toggle>${PIN_GLYPH}</button>
        `;
        // Delete moved off the sidebar row · it now lives inside the
        // agent profile's ⋯ overflow menu where it's protected by the
        // standard ⋯ → confirm flow. The sidebar row is the navigate-
        // to-profile target only; no destructive actions on hover.
        return `
          <div class="agent-row-shell" data-agent-id="${this.escape(a.id)}">
            <a href="#" class="agent-row${a.isPinned ? " pinned" : ""}" data-agent-profile="${this.escape(a.id)}" data-status="${this.escape(status)}">
              <img class="agent-row-av" src="${this.escape(a.avatarPath)}" alt="${this.escape(a.name)}">
              <div class="agent-row-content">
                <div class="agent-row-top-line">
                  <span class="agent-row-title">${this.escape(a.name)}</span>
                  <span class="agent-row-time">${this.escape(time)}</span>
                  ${pinBtn}
                </div>
                <div class="agent-row-subtitle">
                  <span>${this.escape(a.roleTag || "director")}</span>
                  <span class="agent-row-sep">·</span>
                  <span class="agent-row-status">${this.escape(status)}</span>
                </div>
              </div>
            </a>
          </div>
        `;
      };

      /** Chair · structural moderator that lives across every room.
       *  Rendered with a separate row template so we can drop the pin
       *  button (chair can't be pinned/unpinned), swap the role tag
       *  for an emphasised "moderator" badge, and tag the row with
       *  `is-chair` for the cyan accent + immutability cues. */
      const renderChairRow = (a) => `
        <a href="#" class="agent-row is-chair" data-agent-profile="${this.escape(a.id)}" data-status="chair">
          <img class="agent-row-av chair-av" src="${this.escape(a.avatarPath)}" alt="${this.escape(a.name)}">
          <div class="agent-row-content">
            <div class="agent-row-top-line">
              <span class="agent-row-title">${this.escape(a.name)}</span>
              <span class="agent-row-chair-badge" title="Moderator · structural agent, not user-managed">CHAIR</span>
            </div>
            <div class="agent-row-subtitle">
              <span class="agent-row-chair-role">${this.escape(a.roleTag || "moderator")}</span>
              <span class="agent-row-sep">·</span>
              <span class="agent-row-chair-note">in every room</span>
            </div>
          </div>
        </a>
      `;

      const sectionHeader = (label, count, kind) => {
        const pinned = kind === "pinned";
        const chair = kind === "chair";
        const glyph = pinned
          ? `<svg class="pin-glyph" viewBox="0 0 24 24"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5v6h2v-6h5v-2l-2-2z"/></svg>`
          : "";
        const cls = "agents-section-header" + (pinned ? " pinned" : "") + (chair ? " chair" : "");
        return `
          <div class="${cls}">
            ${glyph}
            <span>${this.escape(label)}</span>
            <span class="line"></span>
            <span class="badge">${count}</span>
          </div>
        `;
      };

      const parts = [];
      // Chair sits at the top — single moderator that's structurally
      // present in every room. Lives outside Pinned/Custom/Core so the
      // user immediately sees the orchestrator, and so it can't get
      // grouped with directors they pin or create.
      if (this.currentChair) {
        parts.push(sectionHeader("Chair", 1, "chair"));
        parts.push(renderChairRow(this.currentChair));
      }
      if (pinned.length) {
        parts.push(sectionHeader("Pinned", pinned.length, "pinned"));
        parts.push(pinned.map((a) => renderRow(a)).join(""));
      }
      if (custom.length) {
        parts.push(sectionHeader("Custom", custom.length));
        parts.push(custom.map((a) => renderRow(a)).join(""));
      }
      if (core.length) {
        parts.push(sectionHeader("Core", core.length));
        parts.push(core.map((a) => renderRow(a)).join(""));
      }
      list.innerHTML = parts.join("");
    },

    renderUserBlock() {
      const name = (this.prefs?.name || "Host").trim() || "Host";
      const initial = name.charAt(0).toUpperCase() || "H";
      const intro = (this.prefs?.intro || "").trim();
      // Subtitle: first sentence of the intro (truncated), or a default tag.
      let meta;
      if (intro) {
        const firstLine = intro.split(/[\n.·]/)[0].trim();
        meta = firstLine.length > 32 ? firstLine.slice(0, 30) + "…" : firstLine;
      } else {
        meta = "// host";
      }

      // Avatar source-of-truth · prefs.avatarSeed (set by the
      // preference overlay's "regenerate avatar" button). When a seed
      // is present we render the AvatarSkill SVG so the sidebar foot
      // matches what the user picked in settings; otherwise fall back
      // to the initial-letter chip we shipped before AvatarSkill
      // existed.
      const av = document.querySelector("[data-user-avatar]");
      if (av) {
        const seed = this.prefs?.avatarSeed;
        if (seed && window.AvatarSkill && typeof window.AvatarSkill.generate === "function") {
          av.classList.add("has-pixel-av");
          av.innerHTML = window.AvatarSkill.generate(seed);
        } else {
          av.classList.remove("has-pixel-av");
          av.textContent = initial;
        }
      }
      const nm = document.querySelector("[data-user-name]");
      if (nm) nm.textContent = name;
      const mt = document.querySelector("[data-user-meta]");
      if (mt) mt.textContent = meta;
    },

    renderSidebarCounts() {
      const roomsCount = this.rooms.length;
      const agentsCount = this.agents.length;
      const liveCount = this.rooms.filter((r) => r.status === "live").length;

      const r = document.querySelector('[data-sidebar-tab-count="rooms"]');
      if (r) r.textContent = String(roomsCount);
      const a = document.querySelector('[data-sidebar-tab-count="agents"]');
      if (a) a.textContent = String(agentsCount);
      const sum = document.querySelector("[data-sidebar-summary]");
      if (sum) sum.textContent = `${liveCount} LIVE / ${agentsCount} AGENTS`;
    },

    // ── Rendering · main view ─────────────────────────────────
    renderRoom() {
      this.renderHeader();
      this.renderChat();
      this.renderQueue();
      this.renderBrief();
      this.renderPausedBar();
    },

    renderPausedBar() {
      const bar = document.querySelector(".paused-bar");
      if (!bar || !this.currentRoom) return;
      // Find the last user message + the next director that would speak.
      const lastUser = [...this.currentMessages]
        .reverse()
        .find((m) => m.authorKind === "user");
      const lastUserAt = lastUser ? this.timeFmt(lastUser.createdAt) : "—";
      const nextSpeaker = this.currentQueue[0]
        ? this.agentsById[this.currentQueue[0].agentId]
        : this.currentMembers[0];
      const nextHandle = nextSpeaker
        ? this.escape(nextSpeaker.handle.replace(/^\//, ""))
        : "—";

      const lang = this.composerLanguage();
      const addInputLabel = lang === "zh" ? "[ + 补充观点 ]" : "[ + Add input ]";
      const adjournLabel  = lang === "zh" ? "[ ▸ 结束并存档 ]" : "[ ▸ Adjourn & File Brief ]";
      const resumeLabel   = lang === "zh" ? "[ ▶ 恢复讨论 ]"   : "[ ▶ Resume Discussion ]";
      bar.innerHTML = `
        <div class="paused-bar-text">
          <strong>// discussion paused.</strong>
          last input · your message at ${lastUserAt}.
          next turn · <span class="lime">${nextHandle}</span>.
        </div>
        <div class="paused-bar-actions">
          <a href="#" class="ghost-btn" data-paused-supplement>${this.escape(addInputLabel)}</a>
          <a href="#" class="ghost-btn" data-adjourn>${this.escape(adjournLabel)}</a>
          <a href="#" class="resume-btn-lg" data-resume>${this.escape(resumeLabel)}</a>
        </div>
      `;
    },

    /** Composer state · persisted to localStorage so each new-room
     *  session opens with the user's last config. Hydrated lazily on
     *  first renderEmptyState. */
    composerState: null,

    DEFAULT_COMPOSER: {
      directorIds: [],   // populated lazily from the chair's roster
      mode: "constructive",
      intensity: "sharp",
    },

    loadComposerState() {
      if (this.composerState) return this.composerState;
      let saved = null;
      try {
        const raw = localStorage.getItem("boardroom.composer");
        if (raw) saved = JSON.parse(raw);
      } catch { /* ignore */ }
      this.composerState = {
        ...this.DEFAULT_COMPOSER,
        ...(saved || {}),
        subject: (saved && typeof saved.subject === "string") ? saved.subject : "",
      };
      return this.composerState;
    },

    saveComposerState() {
      if (!this.composerState) return;
      try {
        const { directorIds, mode, intensity, autoPickDirectors, subject } = this.composerState;
        localStorage.setItem(
          "boardroom.composer",
          JSON.stringify({ directorIds, mode, intensity, autoPickDirectors, subject }),
        );
      } catch { /* ignore */ }
    },

    /** Agent composer draft · the description textarea on "+ New Agent".
     *  Persisted independently of composerState so the two screens don't
     *  share fields (composerState is room-shaped). Survives view
     *  switches and full app reloads; cleared after a successful save. */
    loadAgentComposerDraft() {
      try {
        const raw = localStorage.getItem("boardroom.agent-composer.draft");
        return typeof raw === "string" ? raw : "";
      } catch { return ""; }
    },
    saveAgentComposerDraft(text) {
      try { localStorage.setItem("boardroom.agent-composer.draft", String(text || "")); }
      catch { /* ignore */ }
    },
    clearAgentComposerDraft() {
      try { localStorage.removeItem("boardroom.agent-composer.draft"); }
      catch { /* ignore */ }
    },

    /** Whether the composer is in auto-pick mode for the cast · default
     *  is true (chair picks 3 directors based on subject when the user
     *  hits Convene). Flips to false the moment the user manually
     *  adds a director, and flips back to true if they remove the
     *  last one. */
    isAutoPickActive() {
      const state = this.loadComposerState();
      // Backward compat: if the saved state has directors but no flag,
      // treat as user-overridden (flag=false). Fresh users get true.
      if (typeof state.autoPickDirectors === "boolean") return state.autoPickDirectors;
      return !state.directorIds || state.directorIds.length === 0;
    },

    renderEmptyState() {
      // Composer is always shown when no room is active. Subject input
      // is the focus; the rest is config + suggestion list. No more
      // overlay — typing in this view + Enter creates the room.
      const head = document.querySelector("[data-room-head]");
      if (head) head.innerHTML = "";  // CSS hides via html.no-room

      const chat = document.querySelector("[data-chat-messages]");
      if (chat) {
        if (this.composerMode === "agent") {
          chat.innerHTML = this.renderAgentComposerHtml();
          // Focus the description textarea unless we're showing a preview.
          setTimeout(() => {
            const ta = chat.querySelector("[data-agent-composer-desc]");
            if (ta) {
              ta.focus();
              this.autosizeAgentComposerTextarea();
            }
          }, 30);
        } else {
          const state = this.loadComposerState();
          // Default to auto-pick mode · the chair selects 3 directors
          // based on the subject after the user clicks Convene. The
          // user can still manually add directors via the picker
          // popover; doing so flips autoPickDirectors to false.
          if (typeof state.autoPickDirectors !== "boolean") {
            state.autoPickDirectors = !state.directorIds || state.directorIds.length === 0;
          }
          // Drop any stale director ids that no longer exist (deleted
          // since last session) so the picker doesn't blow up.
          state.directorIds = (state.directorIds || []).filter((id) => this.agentsById[id]);
          if (state.directorIds.length === 0) state.autoPickDirectors = true;
          this.saveComposerState();
          chat.innerHTML = this.renderComposerHtml(state);
          setTimeout(() => {
            const ta = chat.querySelector("[data-composer-subject]");
            if (ta) ta.focus();
            this.autosizeComposerTextarea();
          }, 30);
        }
      }

      const queue = document.querySelector("[data-queue-list]");
      if (queue) queue.innerHTML = "";
      const brief = document.querySelector("[data-brief-card]");
      if (brief) brief.innerHTML = "";

      const chatScroller = document.querySelector(".chat");
      if (chatScroller) chatScroller.scrollTop = 0;
    },

    /** Open the All Reports page · cross-room brief index in a card
     *  grid (Perplexity-Discover-style). Hides any other main-view,
     *  shows the dedicated reports view, fetches /api/briefs once and
     *  paints. Sidebar highlight matches the trigger button. */
    async openAllReports() {
      // If we're inside a room or on the agent profile, leave them.
      if (this.currentRoomId) {
        this.disconnectSSE?.();
        this.currentRoomId = null;
        this.currentRoom = null;
        this.currentMessages = [];
        this.currentMembers = [];
        this.currentQueue = [];
        this.currentBrief = null;
        // Clear the URL hash so re-clicking a room link works (same
        // pattern used in closeRoom).
        if (/^#\/r\//.test(location.hash)) {
          history.replaceState(null, "", location.pathname + location.search);
        }
      }
      if (typeof window.closeAgentProfile === "function") {
        try { window.closeAgentProfile(); } catch { /* ignore */ }
      }
      // Hide room/agent main-views, show reports.
      const room = document.querySelector('[data-main-view="room"]');
      const agent = document.querySelector('[data-main-view="agent"]');
      const reports = document.querySelector('[data-main-view="reports"]');
      if (room) room.setAttribute("hidden", "");
      if (agent) agent.setAttribute("hidden", "");
      if (reports) reports.removeAttribute("hidden");
      // Mark the sidebar trigger active. Both new-room + new-agent
      // highlights get cleared so only "All Reports" reads as the
      // current focus.
      this.composerMode = "room"; // logical fallback when leaving reports
      document.querySelectorAll("[data-convene-trigger], [data-agent-composer-trigger]").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll(".session-row-shell.active, .agent-row.active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-reports-trigger]").forEach((el) => el.classList.add("active"));

      // Persist the view via URL hash so refresh / back-button restore
      // both the page content AND the sidebar highlight. replaceState
      // (not assignment to location.hash) avoids firing a hashchange
      // and re-entering handleRoute → openAllReports recursion.
      if (location.hash !== "#/reports") {
        try { history.replaceState(null, "", "#/reports"); } catch { /* ignore */ }
      }

      // Render skeleton while we fetch.
      const page = document.querySelector("[data-reports-page]");
      if (page) {
        page.innerHTML = `
          <div class="reports-page-head">
            <div>
              <div class="reports-page-kicker">// archive · all rooms</div>
              <h1 class="reports-page-title">All Reports</h1>
            </div>
            <div class="reports-page-meta">loading…</div>
          </div>
          <div class="reports-skeleton">
            ${Array.from({ length: 4 }, () => `<div class="reports-skeleton-card"></div>`).join("")}
          </div>
        `;
      }

      let briefs = [];
      try {
        const r = await fetch("/api/briefs");
        if (r.ok) {
          const j = await r.json();
          briefs = Array.isArray(j.briefs) ? j.briefs : [];
        }
      } catch { /* keep briefs empty → empty-state */ }

      this.renderReportsPage(briefs);
    },

    /** Render the All Reports view as a clean vertical reading list ·
     *  one hairline-separated row per brief, no card chrome, no hero,
     *  no stats sidebar. A small filter strip at the top toggles the
     *  visible subset by recency in-place (no scroll-to-section). */
    renderReportsPage(briefs) {
      const page = document.querySelector("[data-reports-page]");
      if (!page) return;
      const total = briefs.length;

      if (total === 0) {
        // Empty state · keeps the same chrome as the populated list
        // (head + filter chips), and shows a single placeholder card
        // (`.reports-list-empty` — notice + 3-bar silhouette + CTA)
        // for the active filter. The All filter uses an "archive
        // empty" variant with a Convene-a-room CTA; the recency
        // filters use the same "window empty" card the populated
        // state shows when a filter has no matches, with a CTA back
        // to All.
        this._reportsCache = briefs;
        const activeFilter = this._reportsFilter || "all";
        const filterLabels = { all: "the archive", today: "Today", week: "This week", earlier: "Earlier" };

        const emptyChip = (key, label) => {
          const on = key === activeFilter ? " on" : "";
          return `
            <button type="button" class="reports-filter-chip${on}" data-reports-filter="${key}">
              <span class="reports-filter-label">${this.escape(label)}</span>
              <span class="reports-filter-count">0</span>
            </button>
          `;
        };

        const isAll = activeFilter === "all";
        const cardKicker = isAll ? "// archive empty" : "// window empty";
        const cardTitle = isAll
          ? "No reports filed yet"
          : `No reports in ${filterLabels[activeFilter]}`;
        const cardDeck = isAll
          ? "Run a session and adjourn — once the chair files, every brief across every room lands here."
          : "Run a session and adjourn — once the chair files, briefs in this window land here. Or jump back to the full archive.";
        const cardCtaHtml = isAll
          ? `
            <button type="button" class="reports-list-empty-cta" data-convene-trigger>
              <span class="reports-list-empty-cta-arrow">→</span>
              <span>Convene a new room</span>
            </button>`
          : `
            <button type="button" class="reports-list-empty-cta" data-reports-filter="all">
              <span class="reports-list-empty-cta-arrow">←</span>
              <span>Show all reports</span>
            </button>`;

        page.innerHTML = `
          <div class="reports-page-head">
            <div>
              <div class="reports-page-kicker">// archive</div>
              <h1 class="reports-page-title">All Reports</h1>
            </div>
            <div class="reports-page-meta">0 reports</div>
          </div>

          <div class="reports-filters" role="tablist" aria-label="Filter reports by recency">
            ${emptyChip("all", "All")}
            ${emptyChip("today", "Today")}
            ${emptyChip("week", "This week")}
            ${emptyChip("earlier", "Earlier")}
          </div>

          <div class="reports-list-wrap">
            <div class="reports-list-empty">
              <div class="reports-list-empty-text">
                <div class="reports-list-empty-kicker">${this.escape(cardKicker)}</div>
                <h3 class="reports-list-empty-title">${this.escape(cardTitle)}</h3>
                <p class="reports-list-empty-deck">${this.escape(cardDeck)}</p>
              </div>
              <div class="reports-list-empty-skel" aria-hidden="true">
                <span class="reports-list-empty-skel-bar reports-list-empty-skel-title"></span>
                <span class="reports-list-empty-skel-bar reports-list-empty-skel-judge"></span>
                <span class="reports-list-empty-skel-bar reports-list-empty-skel-meta"></span>
              </div>
              ${cardCtaHtml}
            </div>
          </div>
        `;
        return;
      }

      // Recency buckets · used for filter chip counts. The list itself
      // stays in time order regardless of which filter is active.
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const todayStart = startOfToday.getTime();
      const weekStart = todayStart - 6 * 86400_000;
      const todayCount = briefs.filter((b) => b.createdAt >= todayStart).length;
      const weekCount = briefs.filter((b) => b.createdAt >= weekStart).length;
      const earlierCount = briefs.filter((b) => b.createdAt < weekStart).length;
      const distinctRooms = new Set(briefs.map((b) => b.roomId)).size;

      // Cache the dataset on the app instance so the filter chip clicks
      // can re-render without another /api/briefs round trip.
      this._reportsCache = briefs;
      const activeFilter = this._reportsFilter || "all";

      const filtered = briefs.filter((b) => {
        if (activeFilter === "today")    return b.createdAt >= todayStart;
        if (activeFilter === "week")     return b.createdAt >= weekStart;
        if (activeFilter === "earlier")  return b.createdAt < weekStart;
        return true;
      });

      const filterChip = (key, label, count) => {
        const on = key === activeFilter ? " on" : "";
        return `
          <button type="button" class="reports-filter-chip${on}" data-reports-filter="${key}">
            <span class="reports-filter-label">${this.escape(label)}</span>
            <span class="reports-filter-count">${count}</span>
          </button>
        `;
      };

      // Group filtered items by date label (Today / Yesterday / This
      // week / Earlier) so the list still has rhythm without splitting
      // into multiple sections each with its own header chrome.
      const groups = [];
      const yesterdayStart = todayStart - 86400_000;
      let currentGroup = null;
      const groupLabelFor = (ts) => {
        if (ts >= todayStart)      return "Today";
        if (ts >= yesterdayStart)  return "Yesterday";
        if (ts >= weekStart)       return "This week";
        return "Earlier";
      };
      for (const b of filtered) {
        const label = groupLabelFor(b.createdAt);
        if (!currentGroup || currentGroup.label !== label) {
          currentGroup = { label, items: [] };
          groups.push(currentGroup);
        }
        currentGroup.items.push(b);
      }

      const filterLabels = { all: "the archive", today: "Today", week: "This week", earlier: "Earlier" };
      const filterCopyTitle = filterLabels[activeFilter] || "this window";
      const groupsHtml = groups.length === 0
        ? `
          <div class="reports-list-empty">
            <!-- Notice text · explains the empty window. -->
            <div class="reports-list-empty-text">
              <div class="reports-list-empty-kicker">// window empty</div>
              <h3 class="reports-list-empty-title">No reports in ${this.escape(filterCopyTitle)}</h3>
              <p class="reports-list-empty-deck">Pick a different filter, or jump back to the full archive.</p>
            </div>
            <!-- Static skeleton silhouette · three quiet bars
                 suggesting "title · judgement · meta," paired with
                 the message rather than driving it. -->
            <div class="reports-list-empty-skel" aria-hidden="true">
              <span class="reports-list-empty-skel-bar reports-list-empty-skel-title"></span>
              <span class="reports-list-empty-skel-bar reports-list-empty-skel-judge"></span>
              <span class="reports-list-empty-skel-bar reports-list-empty-skel-meta"></span>
            </div>
            ${activeFilter !== "all" ? `
              <button type="button" class="reports-list-empty-cta" data-reports-filter="all">
                <span class="reports-list-empty-cta-arrow">←</span>
                <span>Show all reports</span>
              </button>
            ` : ""}
          </div>
        `
        : groups.map((g) => `
            <div class="reports-group">
              <div class="reports-group-label">${this.escape(g.label)}</div>
              <ul class="reports-list">
                ${g.items.map((b) => this.renderReportItemHtml(b)).join("")}
              </ul>
            </div>
          `).join("");

      page.innerHTML = `
        <div class="reports-page-head">
          <div>
            <div class="reports-page-kicker">// archive</div>
            <h1 class="reports-page-title">All Reports</h1>
          </div>
          <div class="reports-page-meta">${total} ${total === 1 ? "report" : "reports"} · ${distinctRooms} ${distinctRooms === 1 ? "room" : "rooms"}</div>
        </div>

        <div class="reports-filters" role="tablist" aria-label="Filter reports by recency">
          ${filterChip("all", "All", total)}
          ${filterChip("today", "Today", todayCount)}
          ${filterChip("week", "This week", weekCount)}
          ${filterChip("earlier", "Earlier", earlierCount)}
        </div>

        <div class="reports-list-wrap">${groupsHtml}</div>
      `;
    },

    /** Switch the active recency filter without a re-fetch — uses the
     *  cached dataset captured by renderReportsPage. */
    setReportsFilter(key) {
      this._reportsFilter = key;
      if (Array.isArray(this._reportsCache)) {
        this.renderReportsPage(this._reportsCache);
      }
    },

    /** Single reading-list row · room kicker, title, judgement excerpt,
     *  meta tail. No card chrome — entries are separated by a hairline
     *  inside the list. */
    renderReportItemHtml(b) {
      const json = b.bodyJson || {};
      const bottomLine = json.bottomLine || {};
      const judgement = (bottomLine.judgement || "").trim() || (b.bodyMd || "").slice(0, 240);
      const time = this.relTime(b.createdAt) || "";
      const roomLabel = b.roomName || b.roomSubject || "—";
      const roomNumLabel = b.roomNumber != null ? `#${String(b.roomNumber).padStart(3, "0")}` : "";
      const findingsCount = Array.isArray(json.headlineFindings) ? json.headlineFindings.length : 0;
      const positionsCount = Array.isArray(json.positions) ? json.positions.length : 0;
      const metaParts = [];
      if (findingsCount > 0) metaParts.push(`${findingsCount} ${findingsCount === 1 ? "finding" : "findings"}`);
      if (positionsCount > 0) metaParts.push(`${positionsCount} ${positionsCount === 1 ? "position" : "positions"}`);
      if (b.supplement) metaParts.push("+ perspective");
      const metaHtml = metaParts.length
        ? `<div class="reports-item-meta">${metaParts.map((p) => `<span>${this.escape(p)}</span>`).join('<span class="reports-item-sep">·</span>')}</div>`
        : "";
      return `
        <li class="reports-item">
          <a href="#/r/${this.escape(b.roomId)}?brief=${this.escape(b.id)}" class="reports-item-link" data-report-card data-brief-id="${this.escape(b.id)}" data-room-id="${this.escape(b.roomId)}">
            <div class="reports-item-kicker">
              <span class="reports-item-num">${this.escape(roomNumLabel)}</span>
              <span class="reports-item-sep">·</span>
              <span class="reports-item-room">${this.escape(roomLabel)}</span>
              <span class="reports-item-time">${this.escape(time)}</span>
            </div>
            <h3 class="reports-item-title">${this.escape(b.title || "Untitled brief")}</h3>
            ${judgement ? `<p class="reports-item-judgement">${this.escape(judgement)}</p>` : ""}
            ${metaHtml}
          </a>
        </li>
      `;
    },

    /** Switch composer mode. Updates state + sidebar highlights, then
     *  re-renders the empty-state view.
     *
     *  Important: the agent-profile main view (Agents-tab auto-opens
     *  the first profile) covers the room main view, hiding our
     *  [data-chat-messages] target. Calling closeAgentProfile flips
     *  the main view back to "room" so renderEmptyState's output is
     *  visible. */
    setComposerMode(mode) {
      this.composerMode = mode === "agent" ? "agent" : "room";
      // Clear any in-flight agent spec when leaving agent mode.
      if (this.composerMode !== "agent") {
        this.agentSpec = null;
        this.agentSpecGenerating = false;
      }
      // Make sure the room main view is the visible one — otherwise
      // our composer would render into a hidden container. Three
      // possible "previous" states: agent profile, all-reports, or a
      // live room. Reset all of them so the composer always lands
      // cleanly in the room main-view.
      if (typeof window.closeAgentProfile === "function") {
        try { window.closeAgentProfile(); } catch { /* ignore */ }
      }
      const reportsView = document.querySelector('[data-main-view="reports"]');
      const roomView    = document.querySelector('[data-main-view="room"]');
      if (reportsView) reportsView.setAttribute("hidden", "");
      if (roomView)    roomView.removeAttribute("hidden");
      // Drop the All-Reports trigger highlight regardless of which
      // composer we're switching to.
      document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
      // If the URL still carries the All-Reports hash from a prior
      // navigation, drop it — otherwise refresh would bounce the user
      // back to the reports view.
      if (/^#\/reports$/i.test(location.hash || "")) {
        try { history.replaceState(null, "", location.pathname + location.search); } catch { /* ignore */ }
      }

      if (this.currentRoomId) {
        // We're inside a room view — switching to a composer means
        // closing the room first. closeRoom calls renderEmptyState
        // and adds the no-room flag for us.
        this.closeRoom();
      } else {
        // No room to close — but the room main-view's chat chrome
        // (input bar, speaking queue, paused/adjourned bars) is gated
        // by the no-room flag. closeRoom would set it; in this branch
        // (e.g. coming from All Reports or the agent profile) we must
        // set it ourselves or those affordances bleed into the
        // composer empty state.
        document.documentElement.classList.add("no-room");
        document.documentElement.setAttribute("data-status", "live");
        this.renderEmptyState();
        this.markActiveRoom(null);
      }
    },

    /** Build the composer HTML. Centred hero composition · Claude /
     *  ChatGPT-style new-chat landing, but tuned to our boardroom
     *  language. The single input block IS the focal point — cast +
     *  tune live as a slim toolbar inside its bottom edge so the page
     *  has one clear gravitational centre, not three competing form
     *  fields. */
    renderComposerHtml(state) {
      const userName = (this.prefs?.name || "you").trim() || "you";
      const lang = this.composerLanguage();
      const greeting = this.composerGreeting(lang, userName);
      const t = lang === "zh"
        ? {
            greet: greeting,
            prompt: "今天想和董事会聊点什么？",
            placeholder: "一个还没把握的想法 · 一个一直绕开的决定 · 一个想被压力测试的判断",
            convene: "Convene",
            tuneLabel: "tune",
            starterLabel: "starter",
            starterCaption: "或者试一个起手式",
            pickerLabel: "选择董事",
            directorsLabel: (n) => `${n} 位董事`,
            directorsAdd: "添加",
          }
        : {
            greet: greeting,
            prompt: "What's on your mind today?",
            placeholder: "an idea you're not sure about · a decision you keep avoiding · a thesis you want stress-tested",
            convene: "Convene",
            tuneLabel: "tune",
            starterLabel: "starter",
            starterCaption: "or try a starter",
            pickerLabel: "Pick directors",
            directorsLabel: (n) => `${n} director${n === 1 ? "" : "s"}`,
            directorsAdd: "add",
          };

      // Cast slot · two visual modes:
      //   1. Auto-pick (default · empty manual selection): chip
      //      reading "✦ Auto-pick · chair selects" — the chair will
      //      pick 3 directors based on the subject after the user
      //      clicks Convene. Adding any director manually flips this.
      //   2. Manual: avatar stack (up to 4 thumbs + "+N" overflow)
      //      and a count label. Clicking still opens the picker so
      //      the user can swap or add more.
      const dirObjs = state.directorIds.map((id) => this.agentsById[id]).filter(Boolean);
      const isAutoPick = state.autoPickDirectors === true && dirObjs.length === 0;
      let castInner;
      if (isAutoPick) {
        // Match the tone/intensity "label: value" pattern · keeps the
        // three toolbar items at the same width + reading rhythm.
        // Label uses "directors" (not "cast") so the chip's purpose
        // is unambiguous: it's the slot that picks the boardroom's
        // director agents. Tooltip carries the long-form explanation.
        const autoTip = lang === "zh"
          ? "Convene 时由 chair 根据主题挑选 3 位董事 · 点击手动选择"
          : "Chair picks 3 directors based on your subject when you Convene · click to pick manually";
        castInner = `
          <span class="cmp-cast-stack cmp-cast-stack-auto" data-cast-auto title="${this.escape(autoTip)}">
            <span class="cmp-cast-auto-mark">✦</span>
          </span>
          <span class="cmp-cast-count cmp-cast-auto-label" title="${this.escape(autoTip)}">
            <span class="cmp-cast-auto-key">${lang === "zh" ? "董事" : "directors"}</span>
            <span class="cmp-cast-auto-val">${lang === "zh" ? "自动挑选" : "auto-pick"}</span>
          </span>
        `;
      } else {
        const visible = dirObjs.slice(0, 4);
        const overflow = Math.max(0, dirObjs.length - 4);
        const dirAvatars = visible.map((a) => `
          <img class="cmp-cast-av" src="${this.escape(a.avatarPath)}" alt="${this.escape(a.name)}" title="${this.escape(a.name)}">
        `).join("");
        const dirCount = dirObjs.length
          ? `<span class="cmp-cast-count">${this.escape(t.directorsLabel(dirObjs.length))}</span>`
          : `<span class="cmp-cast-count cmp-cast-empty">${lang === "zh" ? "未选董事" : "no directors"}</span>`;
        castInner = `
          <span class="cmp-cast-stack">
            ${dirAvatars}
            ${overflow > 0 ? `<span class="cmp-cast-more">+${overflow}</span>` : ""}
            <span class="cmp-cast-add" aria-hidden="true">+</span>
          </span>
          ${dirCount}
        `;
      }

      // Tune dropdowns · two trigger buttons that open option popovers
      // on click. Discoverable (label + value + chevron pattern is
      // unmistakeably a select) without taking up visual real estate.
      const toneLbl = lang === "zh" ? "tone" : "tone";
      const intensityLbl = lang === "zh" ? "intensity" : "intensity";

      // Starter grid · 2-col responsive cards.
      const starters = Array.isArray(window.BOARDROOM_STARTERS) ? window.BOARDROOM_STARTERS : [];
      const starterCards = starters.map((q, idx) => {
        const tag = (q.tag || "").replace(/^\/\/\s*/, "");
        return `
          <button type="button" class="cmp-starter" data-composer-starter="${idx}">
            <div class="cmp-starter-tag">${this.escape(tag)}</div>
            <div class="cmp-starter-text">${this.escape(q.text || "")}</div>
            <div class="cmp-starter-arrow">→</div>
          </button>
        `;
      }).join("");

      return `
        <section class="cmp">
          <header class="cmp-hero">
            <div class="cmp-greet">${this.escape(t.greet)}</div>
            <h1 class="cmp-prompt">${this.escape(t.prompt)}</h1>
          </header>

          <div class="cmp-input-frame">
            <textarea class="cmp-input" data-composer-subject rows="1" placeholder="${this.escape(t.placeholder)}">${this.escape(state.subject || "")}</textarea>

            <div class="cmp-toolbar">
              <button type="button" class="cmp-cast-btn${isAutoPick ? " cmp-cast-btn-auto" : ""}" data-composer-dir-pick title="${this.escape(t.pickerLabel)}">
                ${castInner}
              </button>

              <div class="cmp-toolbar-sep"></div>

              <div class="cmp-tune">
                <button type="button" class="cmp-dd" data-cmp-dropdown="tone" title="${this.escape(toneLbl)}">
                  <span class="cmp-dd-label">${this.escape(toneLbl)}</span>
                  <span class="cmp-dd-value" data-cmp-dd-value="tone">${this.escape(state.mode)}</span>
                  <span class="cmp-dd-chevron">▾</span>
                </button>
                <button type="button" class="cmp-dd" data-cmp-dropdown="intensity" title="${this.escape(intensityLbl)}">
                  <span class="cmp-dd-label">${this.escape(intensityLbl)}</span>
                  <span class="cmp-dd-value" data-cmp-dd-value="intensity">${this.escape(state.intensity)}</span>
                  <span class="cmp-dd-chevron">▾</span>
                </button>
              </div>

              <button type="button" class="cmp-go" data-composer-go title="${this.escape(t.convene)} (⏎)">
                <span class="cmp-go-arrow">→</span>
              </button>
            </div>
          </div>

          ${starters.length ? `
            <div class="cmp-starters">
              <div class="cmp-starters-rule">
                <span class="cmp-starters-rule-line"></span>
                <span class="cmp-starters-rule-label">${this.escape(t.starterCaption)}</span>
                <span class="cmp-starters-rule-line"></span>
              </div>
              <div class="cmp-starters-grid">${starterCards}</div>
            </div>
          ` : ""}
        </section>
      `;
    },

    /** Time-of-day greeting like "// good evening, Kay" / "// 晚上好，Kay". */
    composerGreeting(lang, name) {
      const h = new Date().getHours();
      if (lang === "zh") {
        const part = h < 5 ? "凌晨好" : h < 12 ? "早上好" : h < 14 ? "中午好" : h < 18 ? "下午好" : h < 23 ? "晚上好" : "夜深了";
        return `// ${part}，${name}`;
      }
      const part = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
      return `// ${part}, ${name}`;
    },

    composerLanguage() {
      // Match interface language to user prefs / browser locale; CJK
      // browsers see Chinese composer copy.
      try {
        const lang = (this.prefs?.locale || navigator.language || "").toLowerCase();
        if (lang.startsWith("zh") || lang.includes("cn") || lang.includes("hans") || lang.includes("hant")) return "zh";
      } catch { /* ignore */ }
      return "en";
    },

    autosizeComposerTextarea() {
      const ta = document.querySelector("[data-composer-subject]");
      if (!ta) return;
      ta.style.height = "auto";
      const h = Math.min(360, Math.max(84, ta.scrollHeight));
      ta.style.height = h + "px";
    },

    /* ─────────── New-agent composer ────────────────────────────────
       Inline AI-first agent creation. User describes what kind of
       director they want; LLM generates name / role / bio / cover
       quote / instruction / model + an avatar seed. The preview card
       lets them edit each field inline + reroll the avatar before
       saving. The existing overlay (window.openNewAgent) is the
       manual escape hatch reachable from a link inside the composer. */

    /** Default model for newly composed agents. The dropdown in the
     *  composer toolbar lets the user override this; we persist their
     *  choice via the agent composer state. */
    DEFAULT_AGENT_MODEL: "opus-4-7",

    /** User-friendly provider name · "anthropic" → "Anthropic", etc. */
    providerLabel(p) {
      switch (p) {
        case "anthropic": return "Anthropic";
        case "openai":    return "OpenAI";
        case "google":    return "Google";
        case "xai":       return "xAI";
        case "deepseek":  return "DeepSeek";
        case "openrouter":return "OpenRouter";
        default:          return p || "?";
      }
    },

    /** Tiny route badge for a ModelAvailability row from /api/models.
     *  Returns "" when neither route works (caller shouldn't render
     *  this row anyway), "direct" / "OR" alone, or "direct · OR" when
     *  both are reachable. Mirrors the badges in user-settings.js
     *  Available-models block so the visual vocabulary stays consistent
     *  across pickers. */
    modelRouteBadge(m) {
      const d = !!(m && m.routes && m.routes.direct);
      const o = !!(m && m.routes && m.routes.openrouter);
      if (d && o) return "direct · OR";
      if (d) return "direct";
      if (o) return "OR";
      return "";
    },

    loadAgentComposerModel() {
      if (this.agentComposerModel) return this.agentComposerModel;
      // Read the user's last-picked composer model from localStorage,
      // but only honour it if the model is reachable RIGHT NOW. If
      // the user revoked the underlying key (or never had one), fall
      // through to the server-side `defaultModelV`. This prevents
      // the composer from boot-locking on an unreachable selection.
      const cache = (typeof window.boardroomModels === "function") ? window.boardroomModels() : null;
      const reachableSet = cache && Array.isArray(cache.reachable)
        ? new Set(cache.reachable.map((m) => m.modelV))
        : null;
      try {
        const raw = localStorage.getItem("boardroom.composer.agent");
        if (raw) {
          const j = JSON.parse(raw);
          if (j && typeof j.modelV === "string" && MODEL_LABELS[j.modelV]) {
            // If we have a reachability snapshot AND the stored
            // model isn't reachable, drop through to the default
            // resolver below. Without a snapshot we trust the stored
            // value (cache will refine on next read).
            if (!reachableSet || reachableSet.has(j.modelV)) {
              this.agentComposerModel = j.modelV;
              return this.agentComposerModel;
            }
          }
        }
      } catch { /* ignore */ }
      // Fallback chain · server default → first reachable → hardcoded.
      const fallback =
        (cache && cache.defaultModelV) ||
        (cache && Array.isArray(cache.reachable) && cache.reachable[0] && cache.reachable[0].modelV) ||
        this.DEFAULT_AGENT_MODEL;
      this.agentComposerModel = fallback;
      return this.agentComposerModel;
    },

    saveAgentComposerModel() {
      try {
        localStorage.setItem(
          "boardroom.composer.agent",
          JSON.stringify({ modelV: this.agentComposerModel || this.DEFAULT_AGENT_MODEL }),
        );
      } catch { /* ignore */ }
    },

    setAgentComposerModel(modelV) {
      if (!modelV) return;
      // Accept any modelV the registry knows about (MODEL_LABELS) so
      // the picker can offer fresh registry entries even if the user
      // hasn't refreshed the page since they were added. Reachability
      // is enforced by what the picker offers, not at this setter.
      if (!MODEL_LABELS[modelV]) return;
      this.agentComposerModel = modelV;
      this.saveAgentComposerModel();
      // Update the dropdown trigger label in place.
      const v = document.querySelector('[data-cmp-dd-value="agent-model"]');
      if (v) v.textContent = MODEL_LABELS[modelV] || modelV;
    },

    /** Click handler for the agent-composer starter list. Drops the
     *  starter's text into the textarea, focuses it, autosizes. The
     *  user can edit before submitting. */
    applyAgentStarter(idx) {
      const lang = this.composerLanguage();
      const list = lang === "zh" ? this.AGENT_STARTERS_ZH : this.AGENT_STARTERS_EN;
      const item = list[idx];
      if (!item) return;
      const ta = document.querySelector("[data-agent-composer-desc]");
      if (!ta) return;
      ta.value = item.text;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      this.autosizeAgentComposerTextarea();
    },

    /** Stages shown during agent generation · each ticks active → done
     *  on a timer so the user sees concrete progress instead of a
     *  single "Generating…" string. Cumulative timestamps in seconds
     *  define when each stage transitions to "active". When the real
     *  /generate-spec response returns, remaining stages fast-forward
     *  to done and the preview card crossfades in. */
    AGENT_GEN_STAGES_EN: [
      { key: "imagine",     label: "Imagining the role",        startSec: 0,  sub: ["sketching tone", "deciding posture", "framing the lens"] },
      { key: "name",        label: "Naming the director",       startSec: 2,  sub: ["trying short names", "checking handle slugs"] },
      { key: "bio",         label: "Drafting the bio",          startSec: 4,  sub: ["one or two sentences", "naming the method"] },
      { key: "quote",       label: "Sketching the cover quote", startSec: 7,  sub: ["the opening question they'd ask"] },
      { key: "instruction", label: "Composing the instruction", startSec: 9,  sub: ["numbered method", "voice rules", "boundaries"] },
      { key: "voice",       label: "Picking the model voice",   startSec: 13, sub: ["matching depth to role"] },
      { key: "polish",      label: "Polishing",                 startSec: 15, sub: ["clamping lengths", "final tightening"] },
    ],
    AGENT_GEN_STAGES_ZH: [
      { key: "imagine",     label: "构思角色",       startSec: 0,  sub: ["勾画语气", "拟定立场", "确定视角"] },
      { key: "name",        label: "起名 + handle",  startSec: 2,  sub: ["试几个短名", "排查 handle 重名"] },
      { key: "bio",         label: "起草 bio",       startSec: 4,  sub: ["一两句话", "点明方法"] },
      { key: "quote",       label: "写一句开场问",   startSec: 7,  sub: ["这位董事每次会议会先问什么"] },
      { key: "instruction", label: "撰写 instruction", startSec: 9, sub: ["编号 method", "语气规则", "边界条件"] },
      { key: "voice",       label: "挑选模型嗓音",   startSec: 13, sub: ["按角色深度匹配 model"] },
      { key: "polish",      label: "收尾打磨",       startSec: 15, sub: ["长度修剪", "最后一遍"] },
    ],

    /** Start the stage tick. Called when /generate-spec request fires.
     *  Idempotent — calling twice is safe. */
    startAgentGenTick() {
      this.stopAgentGenTick();
      this.agentGenStageIndex = 0;
      this.agentGenSubstageIndex = 0;
      this.agentGenStartedAt = Date.now();
      this._agentGenTick = setInterval(() => {
        if (!this.agentSpecGenerating) {
          this.stopAgentGenTick();
          return;
        }
        const elapsed = (Date.now() - this.agentGenStartedAt) / 1000;
        const lang = this.composerLanguage();
        const stages = lang === "zh" ? this.AGENT_GEN_STAGES_ZH : this.AGENT_GEN_STAGES_EN;
        // Find current stage index by elapsed time.
        let idx = 0;
        for (let i = 0; i < stages.length; i++) {
          if (elapsed >= stages[i].startSec) idx = i;
        }
        this.agentGenStageIndex = idx;
        // Rotate substage descriptor every ~2.4s within the active stage.
        this.agentGenSubstageIndex = Math.floor(elapsed / 2.4);
        // In-place patch — don't tear down the entire composer.
        this.refreshAgentGenStages();
      }, 600);
    },

    stopAgentGenTick() {
      if (this._agentGenTick) {
        clearInterval(this._agentGenTick);
        this._agentGenTick = null;
      }
    },

    /** In-place re-render of just the stage list during generation.
     *  Avoids re-rendering the whole composer (which would cause
     *  layout shifts and reset focus). */
    refreshAgentGenStages() {
      const wrap = document.querySelector("[data-agent-gen-stages]");
      if (!wrap) return;
      wrap.innerHTML = this.renderAgentGenStagesInner();
    },

    renderAgentGenStagesInner() {
      const lang = this.composerLanguage();
      const stages = lang === "zh" ? this.AGENT_GEN_STAGES_ZH : this.AGENT_GEN_STAGES_EN;
      const active = this.agentGenStageIndex;
      const elapsed = Math.max(0, (Date.now() - this.agentGenStartedAt) / 1000);
      const elapsedLabel = lang === "zh" ? `已耗时 ${Math.round(elapsed)} s` : `${Math.round(elapsed)} s elapsed`;
      const headerLabel = lang === "zh" ? "正在生成 director" : "Summoning director";
      const sigilSvg = this.renderAgentGenSigilSvg(stages, active, elapsed);
      // The active stage's headline pulse — lifted out from the list so
      // it reads as the focal "what's happening RIGHT NOW" line.
      const activeStage = stages[active] || stages[stages.length - 1];
      const activeSubList = (activeStage && activeStage.sub) || [];
      const activeSubText = activeSubList.length
        ? activeSubList[this.agentGenSubstageIndex % activeSubList.length]
        : "";
      return `
        <div class="ag-gen-head">
          <span class="ag-gen-mark"><span class="ag-gen-pulse"></span></span>
          <span class="ag-gen-title">${this.escape(headerLabel)}</span>
          <span class="ag-gen-elapsed">${this.escape(elapsedLabel)}</span>
        </div>
        <div class="ag-gen-stage-area">
          <div class="ag-gen-sigil" aria-hidden="true">${sigilSvg}</div>
          <div class="ag-gen-active-block">
            <div class="ag-gen-active-kicker">${this.escape(lang === "zh" ? `第 ${active + 1} / ${stages.length} 步` : `step ${active + 1} of ${stages.length}`)}</div>
            <div class="ag-gen-active-label">${this.escape(activeStage ? activeStage.label : "")}</div>
            ${activeSubText ? `<div class="ag-gen-active-sub">${this.escape(activeSubText)}</div>` : ""}
          </div>
        </div>
        <ol class="ag-gen-stages">
          ${stages.map((s, i) => {
            const status = i < active ? "done" : (i === active ? "active" : "pending");
            const mark = status === "done"
              ? `<span class="ag-gen-stage-mark done">✓</span>`
              : status === "active"
                ? `<span class="ag-gen-stage-mark active"><span class="ag-gen-stage-dot"></span></span>`
                : `<span class="ag-gen-stage-mark pending">·</span>`;
            return `
              <li class="ag-gen-stage ag-gen-${status}">
                ${mark}
                <span class="ag-gen-stage-content">
                  <span class="ag-gen-stage-label">${this.escape(s.label)}</span>
                </span>
              </li>
            `;
          }).join("")}
        </ol>
      `;
    },

    /** Central ceremony glyph · a heptagonal sigil with one node per
     *  stage. As stages complete, nodes light up (lime fill) and the
     *  chord from the previous node draws. A continuously rotating
     *  scanner line sweeps from center. The substage-rotating central
     *  glyph swaps each tick to feel like the system is "shaping" the
     *  director. Pure SVG — scales cleanly, theme-aware via CSS vars. */
    renderAgentGenSigilSvg(stages, active, elapsed) {
      const n = stages.length;
      const cx = 100, cy = 100, r = 64;
      // Nodes are placed at -π/2 + (2π * i / n), so the first node sits
      // at the top (12 o'clock) and they go clockwise.
      const angles = stages.map((_, i) => (-Math.PI / 2) + (2 * Math.PI * i) / n);
      const pts = angles.map((a) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      // Outer ring + dashed inner ring for ceremony texture.
      const rings = `
        <circle cx="${cx}" cy="${cy}" r="${r}" class="ag-gen-ring"/>
        <circle cx="${cx}" cy="${cy}" r="${r * 0.62}" class="ag-gen-ring-inner"/>
      `;
      // Chords: connect node i → node i+1 around the ring. A chord
      // becomes "done" when its right-side endpoint is done; "active"
      // when the right endpoint is the active node (it draws itself
      // from i to i+1 via stroke-dasharray animation).
      const chords = pts.map((p, i) => {
        const next = pts[(i + 1) % n];
        const status = (i + 1) < active ? "done" : ((i + 1) === active ? "active" : "pending");
        return `<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${next[0].toFixed(1)}" y2="${next[1].toFixed(1)}" class="ag-gen-chord ag-gen-chord-${status}"/>`;
      }).join("");
      // Nodes: a small ring + inner dot. Done = solid lime. Active =
      // pulsing lime. Pending = faint outline. A short tick mark
      // points outward from each node so the heptagon reads as a
      // "compass / ritual sigil" instead of a generic poly.
      const nodes = pts.map((p, i) => {
        const status = i < active ? "done" : (i === active ? "active" : "pending");
        const tickX = cx + Math.cos(angles[i]) * (r + 7);
        const tickY = cy + Math.sin(angles[i]) * (r + 7);
        return `
          <g class="ag-gen-node ag-gen-node-${status}">
            <line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${tickX.toFixed(1)}" y2="${tickY.toFixed(1)}" class="ag-gen-node-tick"/>
            <circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4.5" class="ag-gen-node-ring"/>
            <circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.2" class="ag-gen-node-dot"/>
          </g>
        `;
      }).join("");
      // Center scanner line — rotates continuously (CSS animation). The
      // angle attribute sets the start rotation; the animation handles
      // the rest. A separate cross-line gives it a "compass needle" feel.
      const scanner = `
        <g class="ag-gen-scanner" transform-origin="${cx} ${cy}">
          <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r}" class="ag-gen-scanner-line"/>
          <circle cx="${cx}" cy="${cy - r}" r="2.5" class="ag-gen-scanner-tip"/>
        </g>
      `;
      // Center glyph — a single mono character that swaps every tick.
      // Reads like the system is "imprinting" the director. The list of
      // glyphs stays small + symbolic (alchemy vibes) so it doesn't
      // distract from the surrounding sigil.
      const glyphs = ["◆", "◇", "✦", "✧", "✶", "❖", "✻", "✺"];
      const glyph = glyphs[Math.floor(elapsed * 1.4) % glyphs.length];
      const glyphEl = `<text x="${cx}" y="${cy + 5}" text-anchor="middle" class="ag-gen-center-glyph">${glyph}</text>`;
      // Cardinal tick marks (N/E/S/W) at the inner ring · structural
      // accents that stay through the whole animation so the sigil
      // doesn't feel empty between active nodes.
      const cardinals = [0, 90, 180, 270].map((deg) => {
        const a = (deg - 90) * Math.PI / 180;
        const r1 = r * 0.62 - 3;
        const r2 = r * 0.62 + 3;
        return `<line x1="${(cx + Math.cos(a) * r1).toFixed(1)}" y1="${(cy + Math.sin(a) * r1).toFixed(1)}" x2="${(cx + Math.cos(a) * r2).toFixed(1)}" y2="${(cy + Math.sin(a) * r2).toFixed(1)}" class="ag-gen-cardinal"/>`;
      }).join("");
      return `
        <svg viewBox="0 0 200 200" class="ag-gen-sigil-svg" xmlns="http://www.w3.org/2000/svg">
          ${rings}
          ${cardinals}
          ${chords}
          ${scanner}
          ${nodes}
          ${glyphEl}
        </svg>
      `;
    },

    /** Starter prompts for the agent composer · 6 archetypal director
     *  ideas that span the boardroom's style. Click → fills textarea. */
    AGENT_STARTERS_EN: [
      { tag: "long-horizon", text: "A strategist who plays four moves out — distinguishes 'right now' from 'right at the time horizon that matters'." },
      { tag: "user-empathy", text: "A product hand who reasons from the user's moment of friction. Refuses any argument that doesn't name what the user is doing right then." },
      { tag: "first-principles", text: "A physicist who strips problems to observables and causal chains. Refuses to import assumptions from analogy." },
      { tag: "value-investor", text: "A long-pattern reader who tests every novel idea against thirty years of category history before believing it." },
      { tag: "critique-reviewer", text: "A senior critic who audits any deliverable systematically — labels each flaw blocker / major / minor, points at the load-bearing piece, names the mechanism. Won't praise without finding at least one major issue." },
      { tag: "phenomenologist", text: "An observer who notices what the room ISN'T saying. Tracks tone, what got skipped, who agreed too fast." },
    ],
    AGENT_STARTERS_ZH: [
      { tag: "long-horizon", text: "一位向前看四步的战略家，区分『此刻』和『真正起作用的时间点』，逼问决策落到哪个 horizon 上。" },
      { tag: "user-empathy", text: "一位从用户摩擦时刻反推的产品老兵，反对任何不说清『用户那一刻在干嘛』的论点。" },
      { tag: "first-principles", text: "一位把问题拆到可观测、因果链上的物理学家，拒绝从类比里搬假设。" },
      { tag: "value-investor", text: "一位用三十年品类史做底的长周期读者，新点子要先和三个老案例对照才相信。" },
      { tag: "critique-reviewer", text: "一位资深评审，对任何交付物做系统性审稿——每个瑕疵打 blocker / major / minor 严重度，指向具体段落、说出失败机制。不挑出至少一条 major 不会放过。" },
      { tag: "phenomenologist", text: "一位观察者，捕捉房间里没说出来的东西：语气、被跳过的话题、太快达成的一致。" },
    ],

    renderAgentComposerHtml() {
      const userName = (this.prefs?.name || "you").trim() || "you";
      const lang = this.composerLanguage();
      const greeting = this.composerGreeting(lang, userName);
      const t = lang === "zh"
        ? {
            greet: greeting,
            prompt: "想招一位什么样的董事？",
            placeholder: "几句话描述这位董事的角色、方法、立场。比如：一位每件事都从用户视角出发的产品老兵，会反对任何不带『用户在那一刻干嘛』的论点。",
            cta: "Generate",
            ctaHint: "AI 会生成一份完整 spec，你可以再调",
            manual: "手动配置",
            generating: "生成中…",
            modelLabel: "model",
            starterCaption: "或者从一个 archetype 起手",
          }
        : {
            greet: greeting,
            prompt: "What kind of director do you want?",
            placeholder: "A few sentences on their role, method, stance. e.g. A seasoned product hand who reasons from the user's moment of friction. Will reject any argument that doesn't name what the user is doing right then.",
            cta: "Generate",
            ctaHint: "AI drafts the full spec — you'll edit before saving",
            manual: "Configure manually",
            generating: "Generating…",
            modelLabel: "model",
            starterCaption: "or start from an archetype",
          };
      // If we already have a spec preview, render that instead of the input.
      if (this.agentSpec) {
        return this.renderAgentSpecPreviewHtml(this.agentSpec, lang);
      }
      const generating = this.agentSpecGenerating;
      const currentModel = this.loadAgentComposerModel();
      const modelDisplay = MODEL_LABELS[currentModel] || currentModel;
      const starters = lang === "zh" ? this.AGENT_STARTERS_ZH : this.AGENT_STARTERS_EN;
      const starterCards = starters.map((q, idx) => `
        <button type="button" class="cmp-starter" data-agent-starter="${idx}">
          <div class="cmp-starter-tag">${this.escape(q.tag)}</div>
          <div class="cmp-starter-text">${this.escape(q.text)}</div>
          <div class="cmp-starter-arrow">→</div>
        </button>
      `).join("");
      return `
        <section class="cmp ag-cmp">
          <header class="cmp-hero">
            <div class="cmp-greet">${this.escape(t.greet)}</div>
            <h1 class="cmp-prompt">${this.escape(t.prompt)}</h1>
          </header>

          <div class="cmp-input-frame ${generating ? "is-generating" : ""}">
            <textarea class="cmp-input" data-agent-composer-desc rows="1" placeholder="${this.escape(t.placeholder)}" ${generating ? "disabled" : ""}>${this.escape(this.loadAgentComposerDraft())}</textarea>

            <div class="cmp-toolbar">
              <button type="button" class="cmp-dd" data-cmp-dropdown="agent-model" title="${this.escape(t.modelLabel)}">
                <span class="cmp-dd-label">${this.escape(t.modelLabel)}</span>
                <span class="cmp-dd-value" data-cmp-dd-value="agent-model">${this.escape(modelDisplay)}</span>
                <span class="cmp-dd-chevron">▾</span>
              </button>
              <button type="button" class="ag-cmp-manual" data-agent-composer-manual>
                <span class="ag-cmp-manual-mark">⚙</span>
                <span class="ag-cmp-manual-label">${this.escape(t.manual)}</span>
              </button>
              <button type="button" class="cmp-go ${generating ? "busy" : ""}" data-agent-composer-go title="${this.escape(t.cta)} (⏎)" ${generating ? "disabled" : ""}>
                <span class="cmp-go-arrow">${generating ? "…" : "→"}</span>
              </button>
            </div>
          </div>

          ${generating ? `
            <div class="ag-gen-card" data-agent-gen-stages>
              ${this.renderAgentGenStagesInner()}
            </div>
          ` : ""}

          ${!generating ? `
            <div class="cmp-starters">
              <div class="cmp-starters-rule">
                <span class="cmp-starters-rule-line"></span>
                <span class="cmp-starters-rule-label">${this.escape(t.starterCaption)}</span>
                <span class="cmp-starters-rule-line"></span>
              </div>
              <div class="cmp-starters-grid">${starterCards}</div>
            </div>
          ` : ""}
        </section>
      `;
    },

    /** Preview card · all generated fields editable inline. */
    renderAgentSpecPreviewHtml(spec, lang) {
      const t = lang === "zh"
        ? {
            kicker: "// 生成的 director · 编辑后保存",
            avatar: "头像",
            reroll: "换一个",
            name: "Name",
            handle: "Handle",
            role: "Role tag",
            bio: "Bio",
            quote: "Cover quote",
            instruction: "Instruction",
            model: "Model",
            save: "Save director",
            discard: "丢弃",
            redo: "重新生成",
          }
        : {
            kicker: "// generated director · edit and save",
            avatar: "Avatar",
            reroll: "Reroll",
            name: "Name",
            handle: "Handle",
            role: "Role tag",
            bio: "Bio",
            quote: "Cover quote",
            instruction: "Instruction",
            model: "Model",
            save: "Save director",
            discard: "Discard",
            redo: "Regenerate",
          };
      const seed = this.agentSpecAvatarSeed;
      const avatarSvg = (window.AvatarSkill && seed)
        ? window.AvatarSkill.generate(seed, { size: 96 })
        : `<div class="ag-prev-av-empty">—</div>`;
      // Ordered + grouped by provider · same set as the toolbar
      // dropdown so the user sees consistent picks pre/post generate.
      const modelGroups = AGENT_COMPOSER_MODELS.reduce((acc, m) => {
        const last = acc[acc.length - 1];
        if (!last || last.provider !== m.provider) {
          acc.push({ provider: m.provider, items: [m] });
        } else {
          last.items.push(m);
        }
        return acc;
      }, []);
      const modelOpts = modelGroups.map((g) => `
        <optgroup label="${this.escape(g.provider)}">
          ${g.items.map((m) => {
            const sel = m.v === spec.modelV ? " selected" : "";
            return `<option value="${this.escape(m.v)}"${sel}>${this.escape(m.label)}</option>`;
          }).join("")}
        </optgroup>
      `).join("");
      // Mini radar · 6-axis SVG rendered inline so the user can see the
      // generated personality shape at a glance. Same axes the agent
      // profile uses, miniaturized to ~120px.
      const abilitySvg = this.renderAgentSpecRadarSvg(spec.ability || {});
      return `
        <section class="cmp ag-cmp ag-prev-mode">
          <div class="ag-prev-kicker">${this.escape(t.kicker)}</div>

          <div class="ag-prev-card">
            <header class="ag-prev-head">
              <div class="ag-prev-identity">
                <button type="button" class="ag-prev-av" data-agent-spec-reroll title="${this.escape(t.reroll)}">
                  <div class="ag-prev-av-frame">${avatarSvg}</div>
                  <span class="ag-prev-av-reroll-mark">↻</span>
                </button>
                <div class="ag-prev-id-fields">
                  <input type="text" class="ag-prev-name" data-agent-spec-field="name" maxlength="32" value="${this.escape(spec.name)}" placeholder="${this.escape(t.name)}">
                  <div class="ag-prev-id-meta">
                    <input type="text" class="ag-prev-roletag" data-agent-spec-field="roleTag" maxlength="32" value="${this.escape(spec.roleTag)}" placeholder="${this.escape(t.role)}">
                    <span class="ag-prev-meta-sep">·</span>
                    <select class="ag-prev-model" data-agent-spec-field="modelV">${modelOpts}</select>
                  </div>
                </div>
              </div>
              <div class="ag-prev-radar" aria-hidden="true">${abilitySvg}</div>
            </header>

            <div class="ag-prev-body">
              <label class="ag-prev-field">
                <span class="ag-prev-label">${this.escape(t.bio)}</span>
                <textarea class="ag-prev-input ag-prev-textarea" data-agent-spec-field="bio" maxlength="280" rows="2">${this.escape(spec.bio)}</textarea>
              </label>

              <label class="ag-prev-field">
                <span class="ag-prev-label">${this.escape(t.quote)}</span>
                <textarea class="ag-prev-input ag-prev-textarea" data-agent-spec-field="coverQuote" maxlength="200" rows="2">${this.escape(spec.coverQuote || "")}</textarea>
              </label>

              <label class="ag-prev-field">
                <span class="ag-prev-label">${this.escape(t.instruction)}</span>
                <textarea class="ag-prev-input ag-prev-textarea ag-prev-instr" data-agent-spec-field="instruction" maxlength="4000" rows="10">${this.escape(spec.instruction)}</textarea>
              </label>
            </div>

            <footer class="ag-prev-foot">
              <button type="button" class="ag-prev-discard" data-agent-spec-discard>${this.escape(t.discard)}</button>
              <button type="button" class="ag-prev-redo" data-agent-spec-redo>↻ ${this.escape(t.redo)}</button>
              <button type="button" class="ag-prev-save" data-agent-spec-save>
                <span class="ag-prev-save-mark">◆</span>
                <span>${this.escape(t.save)}</span>
              </button>
            </footer>
          </div>
        </section>
      `;
    },

    /** Inline 6-axis radar for the spec preview · the same axes that
     *  drive the full agent profile radar, scaled down to ~140px so it
     *  fits beside the avatar/identity column. Visualizes the ability
     *  distribution generated from the user's description. */
    renderAgentSpecRadarSvg(ability) {
      const axes = ["dissent", "pattern_recall", "rigor", "empathy", "narrative", "decisiveness"];
      const labels = { dissent: "DISSENT", pattern_recall: "RECALL", rigor: "RIGOR", empathy: "EMPATHY", narrative: "NARRATIVE", decisiveness: "DECIDE" };
      const cx = 90, cy = 75, r = 48;
      const vbW = 180, vbH = 150;
      const max = 10;
      const angles = axes.map((_, i) => (-Math.PI / 2) + (2 * Math.PI * i) / axes.length);
      const point = (v, i) => {
        const ratio = Math.max(0, Math.min(max, Number.isFinite(v) ? v : 5)) / max;
        return [cx + Math.cos(angles[i]) * r * ratio, cy + Math.sin(angles[i]) * r * ratio];
      };
      const ring = (ratio) => axes.map((_, i) => {
        const x = cx + Math.cos(angles[i]) * r * ratio;
        const y = cy + Math.sin(angles[i]) * r * ratio;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      const curPoly = axes.map((a, i) => point(ability[a], i).map((n) => n.toFixed(1)).join(",")).join(" ");
      const spokes = axes.map((_, i) => {
        const [x, y] = [cx + Math.cos(angles[i]) * r, cy + Math.sin(angles[i]) * r];
        return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="ag-prev-radar-spoke"/>`;
      }).join("");
      const grid = [0.33, 0.66, 1].map((ratio) => `<polygon points="${ring(ratio)}" class="ag-prev-radar-grid"/>`).join("");
      const labelEls = axes.map((a, i) => {
        const lr = r + 11;
        const lx = cx + Math.cos(angles[i]) * lr;
        const ly = cy + Math.sin(angles[i]) * lr;
        let anchor = "middle";
        if (Math.abs(Math.cos(angles[i])) > 0.4) anchor = Math.cos(angles[i]) > 0 ? "start" : "end";
        return `<text x="${lx.toFixed(1)}" y="${(ly + 2.5).toFixed(1)}" text-anchor="${anchor}" class="ag-prev-radar-axis-label">${labels[a]}</text>`;
      }).join("");
      return `
        <svg class="ag-prev-radar-svg" viewBox="0 0 ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg" aria-label="Ability radar">
          ${grid}
          ${spokes}
          <polygon points="${curPoly}" class="ag-prev-radar-current"/>
          ${labelEls}
        </svg>
      `;
    },

    autosizeAgentComposerTextarea() {
      const ta = document.querySelector("[data-agent-composer-desc]");
      if (!ta) return;
      ta.style.height = "auto";
      const h = Math.min(360, Math.max(84, ta.scrollHeight));
      ta.style.height = h + "px";
    },

    async submitAgentComposer() {
      const ta = document.querySelector("[data-agent-composer-desc]");
      const description = ta ? ta.value.trim() : "";
      if (description.length < 4) {
        if (ta) ta.focus();
        return;
      }
      // Stash the description so "regenerate" / discard can re-use it.
      this._agentComposerLastDesc = description;
      this.agentSpec = null;
      this.agentSpecGenerating = true;
      this.renderEmptyState();
      this.startAgentGenTick();
      try {
        const r = await fetch("/api/agents/generate-spec", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ description }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || ("HTTP " + r.status));
        }
        const j = await r.json();
        this.agentSpec = j.spec || null;
        // Apply the user's preferred model from the dropdown (overrides
        // whatever modelV the LLM picked). The preview card still lets
        // them change it again per-spec.
        if (this.agentSpec) {
          const userModel = this.loadAgentComposerModel();
          if (userModel && MODEL_LABELS[userModel]) this.agentSpec.modelV = userModel;
        }
        this.agentSpecAvatarSeed = (window.AvatarSkill && window.AvatarSkill.randomSeed)
          ? window.AvatarSkill.randomSeed()
          : null;
        this.stopAgentGenTick();
        this.agentSpecGenerating = false;
        this.renderEmptyState();
      } catch (e) {
        this.stopAgentGenTick();
        this.agentSpecGenerating = false;
        this.renderEmptyState();
        alert("Generate failed: " + (e && e.message ? e.message : e));
      }
    },

    rerollAgentSpecAvatar() {
      if (!window.AvatarSkill || !window.AvatarSkill.randomSeed || !window.AvatarSkill.generate) return;
      this.agentSpecAvatarSeed = window.AvatarSkill.randomSeed();
      // In-place re-render of just the avatar frame. AvatarSkill exposes
      // `generate(seed, opts)` (returns SVG markup) — there's no
      // renderSeedSvg helper, hence the previous reroll silently
      // failed.
      const frame = document.querySelector(".ag-prev-av-frame");
      if (frame) frame.innerHTML = window.AvatarSkill.generate(this.agentSpecAvatarSeed, { size: 96 });
    },

    discardAgentSpec() {
      this.agentSpec = null;
      this.agentSpecAvatarSeed = null;
      this.agentSpecGenerating = false;
      this.renderEmptyState();
    },

    redoAgentSpec() {
      // Reuse the previous description to generate a fresh spec.
      const desc = this._agentComposerLastDesc;
      if (!desc) {
        this.discardAgentSpec();
        return;
      }
      this.agentSpec = null;
      this.agentSpecGenerating = true;
      this.renderEmptyState();
      this.startAgentGenTick();
      // Submit again with the same description.
      (async () => {
        try {
          const r = await fetch("/api/agents/generate-spec", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ description: desc }),
          });
          if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            throw new Error(e.error || ("HTTP " + r.status));
          }
          const j = await r.json();
          this.agentSpec = j.spec || null;
          if (this.agentSpec) {
            const userModel = this.loadAgentComposerModel();
            if (userModel && MODEL_LABELS[userModel]) this.agentSpec.modelV = userModel;
          }
          this.agentSpecAvatarSeed = (window.AvatarSkill && window.AvatarSkill.randomSeed)
            ? window.AvatarSkill.randomSeed()
            : null;
          this.stopAgentGenTick();
          this.agentSpecGenerating = false;
          this.renderEmptyState();
        } catch (e) {
          this.stopAgentGenTick();
          this.agentSpecGenerating = false;
          this.renderEmptyState();
          alert("Regenerate failed: " + (e && e.message ? e.message : e));
        }
      })();
    },

    /** Read inline-edited values from the preview card and POST to
     *  /api/agents. On success, switch back to room composer mode and
     *  optionally open the new agent's profile overlay. */
    async saveAgentSpec() {
      if (!this.agentSpec) return;
      const card = document.querySelector(".ag-prev-card");
      if (!card) return;
      const read = (field) => {
        const el = card.querySelector(`[data-agent-spec-field="${field}"]`);
        return el ? el.value : "";
      };
      const spec = {
        name: read("name").trim(),
        roleTag: read("roleTag").trim(),
        bio: read("bio").trim(),
        coverQuote: read("coverQuote").trim(),
        instruction: read("instruction").trim(),
        modelV: read("modelV").trim(),
      };
      // Avatar — generated SVG from current seed, embedded as data: URL.
      let avatarPath = null;
      if (window.AvatarSkill && this.agentSpecAvatarSeed && window.AvatarSkill.generateDataUrl) {
        avatarPath = window.AvatarSkill.generateDataUrl(this.agentSpecAvatarSeed);
      }
      // Ability axes · lifted from the spec produced by /api/agents/generate-spec.
      // The server validates + clamps + falls back to a heuristic if missing.
      const ability = (this.agentSpec && this.agentSpec.ability && Object.keys(this.agentSpec.ability).length > 0)
        ? this.agentSpec.ability
        : null;
      const btn = card.querySelector("[data-agent-spec-save]");
      if (btn) { btn.disabled = true; btn.classList.add("busy"); }
      try {
        const r = await fetch("/api/agents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...spec,
            ...(avatarPath ? { avatarPath } : {}),
            ...(ability ? { ability } : {}),
          }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || ("HTTP " + r.status));
        }
        const j = await r.json();
        // Refresh local agent catalog so the new director shows up
        // in pickers + sidebar immediately.
        await this.refreshAgents?.();
        this.agentSpec = null;
        this.agentSpecAvatarSeed = null;
        // Clear the saved description draft now that the agent exists —
        // a future visit to "+ New Agent" should land on a fresh textarea.
        this.clearAgentComposerDraft();
        this.composerMode = "room";
        // POST /api/agents returns the agent record directly (not wrapped).
        const newId = j && (j.id || (j.agent && j.agent.id));
        // Land the user on the new agent's full profile page · also
        // switches the sidebar to the Agents tab and persists the
        // sub-state so a refresh keeps them on the same agent.
        if (newId && typeof window.boardroomFocusAgent === "function") {
          // Wait a tick so refreshAgents has populated the sidebar
          // (which is needed for the agent row's `.active` highlight).
          setTimeout(() => window.boardroomFocusAgent(newId), 50);
        } else if (newId && window.openAgentProfile) {
          setTimeout(() => window.openAgentProfile(newId), 50);
        } else {
          // No profile opener available — fall back to clearing the
          // composer view so the user at least sees the new agent in
          // the sidebar.
          this.renderEmptyState();
          this.markActiveRoom(null);
        }
      } catch (e) {
        if (btn) { btn.disabled = false; btn.classList.remove("busy"); }
        alert("Save failed: " + (e && e.message ? e.message : e));
      }
    },

    /** Director picker · small popover anchored under the "+ pick"
     *  button. Lists every available director with: checkbox, avatar
     *  (clickable → agent profile overlay), name, model badge, info
     *  icon (also opens profile). Closes on outside click / Esc / Done. */
    openComposerDirectorPicker(anchorBtn) {
      this.closeComposerDirectorPicker();
      const state = this.loadComposerState();
      const dirs = (this.agents || [])
        .filter((a) => a.roleKind !== "moderator")
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      const lang = this.composerLanguage();
      const t = lang === "zh"
        ? { title: "选择董事", hint: "建议 2-4 位", done: "完成", info: "查看资料" }
        : { title: "Pick directors", hint: "2-4 recommended", done: "Done", info: "View profile" };
      const rows = dirs.map((a) => {
        const checked = state.directorIds.includes(a.id);
        const modelLabel = MODEL_LABELS[a.modelV] || a.modelV || "";
        // data-agent (not data-agent-profile) opens the lightweight
        // intro overlay (agent-overlay.js), not the full profile page.
        return `
          <label class="composer-pick-row${checked ? " on" : ""}" data-composer-pick-id="${this.escape(a.id)}">
            <input type="checkbox" ${checked ? "checked" : ""}>
            <img class="composer-pick-av" src="${this.escape(a.avatarPath)}" alt="${this.escape(a.name)}" data-agent="${this.escape(a.id)}" data-cmp-pick-profile title="${this.escape(t.info)}">
            <span class="composer-pick-main">
              <span class="composer-pick-name">${this.escape(a.name)}</span>
              <span class="composer-pick-tag">${this.escape(a.roleTag || "")}</span>
            </span>
            ${modelLabel ? `<span class="composer-pick-model">${this.escape(modelLabel)}</span>` : ""}
            <button type="button" class="composer-pick-info" data-agent="${this.escape(a.id)}" data-cmp-pick-profile aria-label="${this.escape(t.info)}" title="${this.escape(t.info)}">i</button>
          </label>
        `;
      }).join("");
      const pop = document.createElement("div");
      pop.id = "composer-pick-pop";
      pop.className = "composer-pick-pop";
      pop.innerHTML = `
        <div class="composer-pick-head">
          <span class="composer-pick-title">${this.escape(t.title)}</span>
          <span class="composer-pick-hint">${this.escape(t.hint)}</span>
        </div>
        <div class="composer-pick-list">${rows || `<div class="composer-pick-empty">no directors</div>`}</div>
        <div class="composer-pick-foot">
          <button type="button" class="composer-pick-done" data-composer-pick-done>${this.escape(t.done)}</button>
        </div>
      `;
      document.body.appendChild(pop);
      // Position
      const r = anchorBtn.getBoundingClientRect();
      pop.style.left = Math.max(8, r.left) + "px";
      pop.style.top = (r.bottom + 6) + "px";
      // Close handlers
      this._composerPickEsc = (ev) => {
        if (ev.key === "Escape") {
          ev.stopImmediatePropagation();
          this.closeComposerDirectorPicker();
        }
      };
      this._composerPickOutside = (ev) => {
        // Skip closing when:
        //   · click is inside the picker popover itself
        //   · click is on the "+ pick" trigger button (handled by its own toggle)
        //   · click is anywhere inside the agent intro overlay — opening
        //     and dismissing the overlay (close X, backdrop, agent card)
        //     should leave the picker open so the user can keep
        //     browsing directors after they peek at one's profile
        if (
          !pop.contains(ev.target)
          && !ev.target.closest("[data-composer-dir-pick]")
          && !ev.target.closest(".agent-overlay")
        ) {
          this.closeComposerDirectorPicker();
        }
      };
      document.addEventListener("keydown", this._composerPickEsc, true);
      setTimeout(() => document.addEventListener("click", this._composerPickOutside, true), 0);
    },

    closeComposerDirectorPicker() {
      const el = document.getElementById("composer-pick-pop");
      if (el) el.remove();
      if (this._composerPickEsc) {
        document.removeEventListener("keydown", this._composerPickEsc, true);
        this._composerPickEsc = null;
      }
      if (this._composerPickOutside) {
        document.removeEventListener("click", this._composerPickOutside, true);
        this._composerPickOutside = null;
      }
    },

    toggleComposerDirector(id) {
      const state = this.loadComposerState();
      const i = state.directorIds.indexOf(id);
      if (i >= 0) state.directorIds.splice(i, 1);
      else state.directorIds.push(id);
      // Auto-pick state follows the manual selection · adding any
      // director overrides auto-pick; removing the last one re-arms
      // it so the user can fall back to chair-pick by clearing.
      state.autoPickDirectors = state.directorIds.length === 0;
      this.saveComposerState();
      // Don't close the picker — let the user toggle multiple before Done.
      // But re-render the chip strip in the composer so the count updates.
      this.refreshComposerCast();
      // Update the picker row's visual state in place.
      const row = document.querySelector(`[data-composer-pick-id="${CSS.escape(id)}"]`);
      if (row) {
        const cb = row.querySelector("input[type=checkbox]");
        if (cb) cb.checked = state.directorIds.includes(id);
        row.classList.toggle("on", state.directorIds.includes(id));
      }
    },

    refreshComposerCast() {
      // Re-render just the cast button (avatar stack + count) inside the
      // toolbar. Keeps the rest of the input frame untouched so the
      // user's text + caret position aren't disturbed.
      const btn = document.querySelector(".cmp-cast-btn");
      if (!btn) return;
      const state = this.loadComposerState();
      const lang = this.composerLanguage();
      const dirObjs = state.directorIds.map((id) => this.agentsById[id]).filter(Boolean);
      const isAutoPick = state.autoPickDirectors === true && dirObjs.length === 0;
      btn.classList.toggle("cmp-cast-btn-auto", isAutoPick);
      if (isAutoPick) {
        const autoTip = lang === "zh"
          ? "Convene 时由 chair 根据主题挑选 3 位董事 · 点击手动选择"
          : "Chair picks 3 directors based on your subject when you Convene · click to pick manually";
        btn.title = autoTip;
        btn.innerHTML = `
          <span class="cmp-cast-stack cmp-cast-stack-auto" data-cast-auto>
            <span class="cmp-cast-auto-mark">✦</span>
          </span>
          <span class="cmp-cast-count cmp-cast-auto-label">
            <span class="cmp-cast-auto-key">${lang === "zh" ? "董事" : "directors"}</span>
            <span class="cmp-cast-auto-val">${lang === "zh" ? "自动挑选" : "auto-pick"}</span>
          </span>
        `;
        return;
      }
      const visible = dirObjs.slice(0, 4);
      const overflow = Math.max(0, dirObjs.length - 4);
      const avs = visible.map((a) => `<img class="cmp-cast-av" src="${this.escape(a.avatarPath)}" alt="${this.escape(a.name)}" title="${this.escape(a.name)}">`).join("");
      const countText = dirObjs.length
        ? (lang === "zh" ? `${dirObjs.length} 位董事` : `${dirObjs.length} director${dirObjs.length === 1 ? "" : "s"}`)
        : (lang === "zh" ? "未选董事" : "no directors");
      const countCls = dirObjs.length ? "cmp-cast-count" : "cmp-cast-count cmp-cast-empty";
      btn.innerHTML = `
        <span class="cmp-cast-stack">
          ${avs}
          ${overflow > 0 ? `<span class="cmp-cast-more">+${overflow}</span>` : ""}
          <span class="cmp-cast-add" aria-hidden="true">+</span>
        </span>
        <span class="${countCls}">${this.escape(countText)}</span>
      `;
    },

    setComposerTone(mode) {
      const state = this.loadComposerState();
      state.mode = mode;
      this.saveComposerState();
      const v = document.querySelector('[data-cmp-dd-value="tone"]');
      if (v) v.textContent = mode;
    },

    setComposerIntensity(intensity) {
      const state = this.loadComposerState();
      state.intensity = intensity;
      this.saveComposerState();
      const v = document.querySelector('[data-cmp-dd-value="intensity"]');
      if (v) v.textContent = intensity;
    },

    /** Generic option-list dropdown anchored under a tune trigger
     *  button. Used for both tone and intensity. Each option is a
     *  full-text row with a short hint (current/calmer/etc). Click an
     *  option → set state + close. Esc / outside-click close. */
    openComposerDropdown(triggerBtn) {
      this.closeComposerDropdown();
      const kind = triggerBtn.getAttribute("data-cmp-dropdown");
      const lang = this.composerLanguage();
      const state = this.loadComposerState();
      // Hints are kept short so the row stays on one line at the popover
      // width — same constraint the picker rows respect.
      let opts;
      let current;
      if (kind === "tone") {
        opts = lang === "zh"
          ? [
              { v: "brainstorm",   label: "Brainstorm",   hint: "共同发散" },
              { v: "constructive", label: "Constructive", hint: "推一把" },
              { v: "research",     label: "Research",     hint: "梳理材料找洞察" },
              { v: "debate",       label: "Debate",       hint: "找漏洞" },
              { v: "critique",     label: "Critique",     hint: "系统性挑毛病" },
            ]
          : [
              { v: "brainstorm",   label: "Brainstorm",   hint: "yes-and" },
              { v: "constructive", label: "Constructive", hint: "push & sharpen" },
              { v: "research",     label: "Research",     hint: "mine the material" },
              { v: "debate",       label: "Debate",       hint: "find the holes" },
              { v: "critique",     label: "Critique",     hint: "audit the deliverable" },
            ];
        current = state.mode;
      } else if (kind === "intensity") {
        opts = lang === "zh"
          ? [
              { v: "calm",   label: "Calm",   hint: "想清楚" },
              { v: "sharp",  label: "Sharp",  hint: "不绕弯" },
              { v: "brutal", label: "Brutal", hint: "直击痛点" },
            ]
          : [
              { v: "calm",   label: "Calm",   hint: "let them think" },
              { v: "sharp",  label: "Sharp",  hint: "no hedging" },
              { v: "brutal", label: "Brutal", hint: "no prisoners" },
            ];
        current = state.intensity;
      } else if (kind === "agent-model") {
        // Reachable-only model catalog · pulls from the shared
        // /api/models cache so the picker reflects the user's
        // current key set. Each row carries provider + deck + a
        // route badge ("direct" / "OR" / "direct · OR") so power
        // users can see how each model would route. When the cache
        // hasn't loaded yet we fall back to the registry mirror so
        // the picker isn't empty during first paint.
        const cache = (typeof window.boardroomModels === "function") ? window.boardroomModels() : null;
        if (cache && Array.isArray(cache.reachable) && cache.reachable.length > 0) {
          opts = cache.reachable.map((m) => ({
            v: m.modelV,
            label: m.displayName,
            hint: m.deck || "",
            provider: this.providerLabel(m.provider),
            badge: this.modelRouteBadge(m),
          }));
        } else {
          opts = AGENT_COMPOSER_MODELS.map((m) => ({
            v: m.v,
            label: m.label,
            hint: m.deck,
            provider: m.provider,
            badge: "",
          }));
          // Kick off a refresh in the background so the next open
          // shows reachable-only data. No re-render of the current
          // popover · the user already has options to pick from.
          if (typeof window.boardroomModelsRefresh === "function") {
            window.boardroomModelsRefresh();
          }
        }
        current = this.loadAgentComposerModel();
      } else {
        return;
      }
      // For the agent-model picker we group rows by provider with a
      // tiny header label between groups. Tone / intensity remain a
      // flat list (just 3-4 picks each — no grouping needed).
      let rows;
      if (kind === "agent-model") {
        const groups = [];
        let lastProv = null;
        for (const o of opts) {
          if (o.provider !== lastProv) {
            groups.push(`<div class="cmp-dd-group">${this.escape(o.provider)}</div>`);
            lastProv = o.provider;
          }
          const badge = o.badge
            ? `<span class="cmp-dd-opt-route">${this.escape(o.badge)}</span>`
            : "";
          groups.push(`
            <button type="button" class="cmp-dd-opt${o.v === current ? " active" : ""}" data-cmp-dd-pick="${this.escape(o.v)}" data-cmp-dd-kind="${this.escape(kind)}">
              <span class="cmp-dd-opt-label">${this.escape(o.label)}</span>
              <span class="cmp-dd-opt-hint">${this.escape(o.hint)}</span>
              ${badge}
            </button>
          `);
        }
        rows = groups.join("");
      } else {
        rows = opts.map((o) => `
          <button type="button" class="cmp-dd-opt${o.v === current ? " active" : ""}" data-cmp-dd-pick="${this.escape(o.v)}" data-cmp-dd-kind="${this.escape(kind)}">
            <span class="cmp-dd-opt-label">${this.escape(o.label)}</span>
            <span class="cmp-dd-opt-hint">${this.escape(o.hint)}</span>
          </button>
        `).join("");
      }
      const pop = document.createElement("div");
      pop.id = "cmp-dd-pop";
      pop.className = "cmp-dd-pop" + (kind === "agent-model" ? " cmp-dd-pop-tall" : "");
      pop.innerHTML = rows;
      document.body.appendChild(pop);
      // Position under the trigger, right-aligned to it.
      const r = triggerBtn.getBoundingClientRect();
      const popW = kind === "agent-model" ? 260 : 200;
      let left = r.right - popW;
      if (left < 8) left = Math.max(8, r.left);
      pop.style.left = left + "px";
      pop.style.top = (r.bottom + 4) + "px";
      pop.style.width = popW + "px";
      // Mark trigger as "open" so the chevron rotates.
      triggerBtn.classList.add("open");
      this._cmpDdTrigger = triggerBtn;
      // Close handlers
      this._cmpDdEsc = (ev) => {
        if (ev.key === "Escape") {
          ev.stopImmediatePropagation();
          this.closeComposerDropdown();
        }
      };
      this._cmpDdOutside = (ev) => {
        if (!pop.contains(ev.target) && !ev.target.closest("[data-cmp-dropdown]")) {
          this.closeComposerDropdown();
        }
      };
      document.addEventListener("keydown", this._cmpDdEsc, true);
      setTimeout(() => document.addEventListener("click", this._cmpDdOutside, true), 0);
    },

    closeComposerDropdown() {
      const el = document.getElementById("cmp-dd-pop");
      if (el) el.remove();
      if (this._cmpDdTrigger) {
        this._cmpDdTrigger.classList.remove("open");
        this._cmpDdTrigger = null;
      }
      if (this._cmpDdEsc) {
        document.removeEventListener("keydown", this._cmpDdEsc, true);
        this._cmpDdEsc = null;
      }
      if (this._cmpDdOutside) {
        document.removeEventListener("click", this._cmpDdOutside, true);
        this._cmpDdOutside = null;
      }
    },

    /** Submit handler · validate inputs, fire createRoom, navigate. */
    async submitComposer() {
      const ta = document.querySelector("[data-composer-subject]");
      const subject = ta ? ta.value.trim() : "";
      const state = this.loadComposerState();
      if (!subject) {
        if (ta) ta.focus();
        return;
      }
      // Pre-flight · convening triggers chair convening + auto-pick +
      // clarify, all of which need a model key. Bail early and prompt
      // the user to configure one if missing.
      if (!(await this.requireModelKey())) return;
      // Auto-pick path · no manual selection · let the chair pick the
      // cast after the room opens. When the user has manually picked
      // directors, send them as before.
      const useAutoPick = state.autoPickDirectors === true && state.directorIds.length === 0;
      if (!useAutoPick && !state.directorIds.length) {
        const lang = this.composerLanguage();
        alert(lang === "zh" ? "请至少选择一位董事再 convene" : "Pick at least one director before convening");
        return;
      }
      const btn = document.querySelector("[data-composer-go]");
      if (btn) btn.classList.add("busy");
      try {
        await this.createRoom({
          subject,
          agentIds: useAutoPick ? [] : state.directorIds.slice(),
          mode: state.mode,
          intensity: state.intensity,
          autoPick: useAutoPick,
        });
        // Clear the saved draft now that the room is convened — next
        // visit to "+ New Room" should land on a fresh textarea, not
        // re-show the just-submitted subject.
        state.subject = "";
        this.saveComposerState();
      } catch (e) {
        if (btn) btn.classList.remove("busy");
        alert("Couldn't convene: " + (e && e.message ? e.message : e));
      }
    },

    /** Apply a starter spec into the composer state — fills the
     *  textarea, swaps the cast / tone / intensity to the starter's
     *  presets, then re-renders. User can adjust before hitting Enter. */
    applyComposerStarter(idx) {
      const list = window.BOARDROOM_STARTERS || [];
      const q = list[idx];
      if (!q) return;
      const state = this.loadComposerState();
      // Map starter agent slugs to actual ids if necessary; the spec
      // already stores ids so just keep agents that exist.
      const want = (q.agents || []).filter((id) => this.agentsById[id]);
      if (want.length) state.directorIds = want;
      if (q.tone) state.mode = q.tone;
      if (q.intensity) state.intensity = q.intensity;
      // Write the starter text into the persisted draft so it survives
      // a navigation away and back, just like manual typing does.
      state.subject = q.text || "";
      this.saveComposerState();
      // Re-render to reflect the new selections; keep autofocus at end of subject.
      this.renderEmptyState();
      setTimeout(() => {
        const ta = document.querySelector("[data-composer-subject]");
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
          this.autosizeComposerTextarea();
        }
      }, 50);
    },

    /**
     * Render one starter card. The cast + config come from the starter spec
     * (window.BOARDROOM_STARTERS); each avatar is clickable to open the
     * agent profile, the card body fires the starter action, and a
     * [▶ Start] button appears on hover at the right.
     */
    starterCardHtml(q, idx) {
      const cast = (q.agents || [])
        .map((id) => this.agentsById[id])
        .filter(Boolean);
      const castHtml = cast.map((a) => `
        <span class="starter-agent" title="${this.escape(a.name)} · ${this.escape(a.roleTag || "")}" data-agent-profile="${this.escape(a.id)}">
          <img class="starter-av" src="${this.escape(a.avatarPath)}" alt="${this.escape(a.name)}" data-agent-profile="${this.escape(a.id)}">
          <span class="starter-name">${this.escape(a.name)}</span>
        </span>
      `).join("");
      return `
        <div class="starter-card" data-starter-idx="${idx}">
          <div class="starter-tag">${this.escape(q.tag)}</div>
          <div class="starter-main">
            <div class="starter-text">${this.escape(q.text)}</div>
            <div class="starter-hint">${this.escape(q.hint)}</div>
            <div class="starter-meta">
              <span class="meta-tag tag-tone"><span class="k">tone</span><span class="v">${this.escape(q.tone)}</span></span>
              <span class="meta-tag tag-intensity"><span class="k">intensity</span><span class="v">${this.escape(q.intensity)}</span></span>
            </div>
          </div>
          <div class="starter-cast" aria-label="${cast.length} directors">${castHtml}</div>
          <button type="button" class="starter-start" data-starter-go="${idx}" title="Start this room">
            <span class="starter-start-arrow">▶</span><span class="starter-start-label">Start</span>
          </button>
        </div>
      `;
    },

    /**
     * Create a room from a starter spec. The cast + tone + intensity come
     * from `window.BOARDROOM_STARTERS` (or the explicit subject string for
     * legacy callers). Falls back to the default trio if a referenced
     * agent isn't seeded.
     */
    async createStarterRoom(subjectOrSpec) {
      const starters = (typeof window !== "undefined" && Array.isArray(window.BOARDROOM_STARTERS))
        ? window.BOARDROOM_STARTERS : [];
      let spec = null;
      if (subjectOrSpec && typeof subjectOrSpec === "object") {
        spec = subjectOrSpec;
      } else if (typeof subjectOrSpec === "string") {
        const text = subjectOrSpec.trim();
        spec = starters.find((s) => s.text === text) || { text };
      }
      if (!spec || !spec.text) return;

      const have = new Set(this.agents.map((a) => a.id));
      let agentIds = (spec.agents || []).filter((id) => have.has(id));
      // Fallback to the canonical trio, then to any three seeded agents.
      if (agentIds.length < 2) {
        const trio = ["socrates", "first-principles", "value-investor"].filter((id) => have.has(id));
        agentIds = trio.length >= 2 ? trio : this.agents.slice(0, 3).map((a) => a.id);
      }
      if (agentIds.length === 0) {
        alert("No directors available — the agent catalog is empty.");
        return;
      }
      try {
        await this.createRoom({
          subject: spec.text,
          agentIds,
          mode: spec.tone || "constructive",
          intensity: spec.intensity || "sharp",
          briefStyle: spec.briefStyle || "auto",
        });
      } catch (e) {
        alert("Couldn't open the starter room: " + (e && e.message ? e.message : e));
      }
    },

    renderHeader() {
      const head = document.querySelector("[data-room-head]");
      if (!head || !this.currentRoom) return;
      const r = this.currentRoom;

      // Avatars cascade with a stacked count tile at the end so the cast
      // size is legible without adding chrome to the meta line.
      // data-agent makes each tile clickable via the shared agent-overlay.
      // Setting it explicitly (instead of relying on agent-overlay's
      // autoTagAvatars regex) is required for custom agents whose
      // avatarPath is a data: URL — the regex only matches /avatars/*.svg.
      const castImgs = this.currentMembers
        .map((a) => `<img data-agent="${this.escape(a.id)}" src="${this.escape(a.avatarPath)}" alt="${this.escape(a.name)}" title="${this.escape(a.name)}">`)
        .join("");
      const castCount = this.currentMembers.length;
      const castHtml = castImgs +
        (castCount > 0
          ? `<span class="cast-count" title="${castCount} director${castCount === 1 ? "" : "s"}">${castCount}</span>`
          : "");

      const tone = r.mode || "constructive";
      const intensity = r.intensity || "sharp";
      const style = r.briefStyle || "auto";

      // Status timestamp — what was on the right (paused-stamp / stamp) now
      // lives inline in the meta row.
      let stamp = "";
      if (r.status === "paused" && r.pausedAt) {
        stamp = `paused ${this.relTime(r.pausedAt)} ago`;
      } else if (r.status === "adjourned" && r.adjournedAt) {
        stamp = `adjourned ${this.relTime(r.adjournedAt)} ago`;
      } else if (r.status === "live" && r.createdAt) {
        stamp = `opened ${this.relTime(r.createdAt)} ago`;
      }

      // Three primary actions, one per state — CSS hides the wrong ones based
      // on html[data-status]. Per PRD §5.2.3:
      //   live      → [ ❚❚ Pause ]    (amber, secondary)
      //   paused    → [ ▶ Resume ]    (lime, primary)
      //   adjourned → [ View Report ] (lime, primary)
      head.innerHTML = `
        <div class="room-info">
          <div class="room-id">
            <span class="room-name">Meeting Room</span>
            <span class="session-num">// ROOM #${r.number} · ${this.escape(tone.toUpperCase())}</span>
          </div>
          <h1 class="room-subject" title="${this.escape(r.subject)}">${this.escape(r.subject)}</h1>
          <div class="room-meta" data-room-meta>
            <span class="meta-tag tag-tone" data-tone-tip="${this.escape(TONE_TIPS[tone] || "")}"><span class="k">tone</span><span class="v">${this.escape(tone)}</span></span>
            <span class="meta-tag tag-intensity"><span class="k">intensity</span><span class="v">${this.escape(intensity)}</span></span>
            <span class="meta-tag tag-report"><span class="k">report</span><span class="v">${this.escape(style)}</span></span>
            ${stamp ? `<span class="meta-stamp">${this.escape(stamp)}</span>` : ""}
          </div>
        </div>
        <div class="head-actions">
          <div class="head-cast">${castHtml}</div>
          <a href="#" class="room-settings-trigger" data-room-settings-trigger title="Room settings" aria-label="Room settings">⚙</a>
          <a href="#" class="pause-btn" data-pause>[ <span class="pause-icon">❚❚</span> Pause ]</a>
          <a href="#" class="resume-btn" data-resume>[ ▶ Resume ]</a>
          ${this.currentBrief
            ? `<a href="/report.html?r=${this.escape(r.id)}" target="_blank" rel="noopener" class="view-report-btn" data-view-report>[ View Report ]</a>`
            : (r.status === "adjourned"
              ? `<span class="view-report-btn no-report" data-no-report title="No report was filed for this room">[ ⊘ No Report ]</span>`
              : "")}
        </div>
      `;
      // Wire the tone-tag hover tip. Pure-CSS ::after tooltips were
      // attempted twice and lose the battle with the chat panel's
      // overflow:hidden chain (.main / .main-view both clip absolutely-
      // positioned descendants and CAN'T be relaxed without breaking
      // chat scroll). Body-attached fixed-position tooltip is the only
      // reliable approach.
      const toneTag = head.querySelector(".meta-tag.tag-tone[data-tone-tip]");
      if (toneTag) {
        toneTag.addEventListener("mouseenter", () => this.showToneTip(toneTag));
        toneTag.addEventListener("mouseleave", () => this.hideToneTip());
      }
    },

    /** Show the tone tooltip pinned under the tag. Uses position:fixed
     *  + getBoundingClientRect so it escapes any ancestor overflow.
     *  Re-flips above the tag if it would clip the viewport bottom. */
    showToneTip(tag) {
      this.hideToneTip();
      const tip = tag.getAttribute("data-tone-tip") || "";
      if (!tip) return;
      const tone = (this.currentRoom && this.currentRoom.mode) || "";
      const el = document.createElement("div");
      el.id = "tone-tag-tip";
      el.className = "tone-tag-tip";
      el.innerHTML = `${tone ? `<div class="tone-tag-tip-head">${this.escape(tone)}</div>` : ""}<div class="tone-tag-tip-body">${this.escape(tip)}</div>`;
      document.body.appendChild(el);
      const r = tag.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let top = r.bottom + 8;
      if (top + h > window.innerHeight - 12) top = r.top - h - 8;
      let left = r.left;
      if (left + w > window.innerWidth - 12) left = window.innerWidth - w - 12;
      if (left < 12) left = 12;
      el.style.top = `${Math.round(top)}px`;
      el.style.left = `${Math.round(left)}px`;
    },
    hideToneTip() {
      const el = document.getElementById("tone-tag-tip");
      if (el) el.remove();
    },

    /** ID of the first user message in the room, used to apply the convene-opener layout. */
    firstUserMessageId() {
      const m = this.currentMessages.find((x) => x.authorKind === "user");
      return m ? m.id : null;
    },

    renderChat() {
      const chat = document.querySelector("[data-chat-messages]");
      if (!chat) return;
      const messages = this.currentMessages.slice();
      const r = this.currentRoom;
      const banner = r
        ? `<div class="chat-banner"><span class="chat-banner-chip"><span class="cb-mark">▸</span><span class="cb-text">room opened · ${new Date(r.createdAt).toLocaleString()} · ${this.currentMembers.length} directors · ${this.escape(r.mode)}</span></span></div>`
        : "";
      const openerId = this.firstUserMessageId();
      // Convening card · appended at the tail of the chat while the
      // room is opening (auto-pick + chair preparing remarks). Cleared
      // when the chair's first message lands; see message-appended SSE.
      const conveneCard = this.conveneState ? this.conveningCardHtml() : "";
      chat.innerHTML =
        banner +
        messages.map((m) => this.messageHtml(m, m.id === openerId)).join("") +
        conveneCard;
    },

    /** Convening card · multi-stage placeholder rendered while a fresh
     *  room is opening. Reads conveneState (set by createRoom and
     *  updated by SSE) to drive the stage states + seated director list. */
    conveningCardHtml() {
      const s = this.conveneState;
      if (!s) return "";
      const lang = (s.subject && /[一-鿿]/.test(s.subject)) ? "zh" : "en";

      // Stages · auto-picked rooms run all three; manually-cast rooms
      // skip "analyzing" + "seating" because the cast is pre-set.
      const stageOrder = s.autoPicked
        ? ["analyzing", "seating", "preparing"]
        : ["preparing"];
      const STAGE_LABELS = {
        analyzing: lang === "zh"
          ? { title: "分析议题", deck: "haiku 路由器在拆解你提的话题" }
          : { title: "Analyzing topic", deck: "Routing your topic to the right perspectives" },
        seating: lang === "zh"
          ? { title: "邀请董事", deck: "依据议题匹配的董事正在入席" }
          : { title: "Seating directors", deck: "Picking the right perspectives for this question" },
        preparing: lang === "zh"
          ? { title: "主席组织开场陈词", deck: "主席正在准备介绍发言" }
          : { title: "Chair preparing remarks", deck: "Drafting the convening speech" },
      };

      const currentIdx = stageOrder.indexOf(s.stage);
      const statusOf = (idx) =>
        idx < currentIdx ? "done"
        : idx === currentIdx ? "active"
        : "pending";
      const markOf = (status) =>
        status === "done" ? "✓"
        : status === "active" ? "●"
        : "○";

      const stagesHtml = stageOrder.map((id, idx) => {
        const status = statusOf(idx);
        const labels = STAGE_LABELS[id];
        return `
          <li class="conv-stage conv-stage-${status}" data-conv-stage="${id}">
            <span class="conv-stage-mark">${markOf(status)}</span>
            <div class="conv-stage-text">
              <span class="conv-stage-title">${this.escape(labels.title)}</span>
              <span class="conv-stage-deck">${this.escape(labels.deck)}</span>
            </div>
          </li>
        `;
      }).join("");

      // Seated directors row · animates each avatar in as members arrive
      // via member-added SSE. Absent on manual-cast rooms (cast is
      // already in currentMembers; rendering it here would be redundant).
      const seatedRow = (s.autoPicked && s.seated.length > 0) ? `
        <div class="conv-seated">
          <div class="conv-seated-label">${lang === "zh" ? "已入席" : "seated"} · ${s.seated.length}</div>
          <div class="conv-seated-list">
            ${s.seated.map((a) => `
              <div class="conv-seated-item" data-agent-id="${this.escape(a.id)}">
                <img class="conv-seated-av" src="${this.escape(a.avatarPath)}" alt="${this.escape(a.name)}">
                <div class="conv-seated-meta">
                  <div class="conv-seated-name">${this.escape(a.name)}</div>
                  <div class="conv-seated-tag">${this.escape(a.roleTag || "")}</div>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      ` : "";

      return `
        <article class="convening-card" data-convene-card>
          <div class="conv-eyebrow">${lang === "zh" ? "▸ 召集中" : "▸ CONVENING"}</div>
          ${s.subject ? `<blockquote class="conv-subject">${this.escape(s.subject)}</blockquote>` : ""}
          <ul class="conv-stages">${stagesHtml}</ul>
          ${seatedRow}
        </article>
      `;
    },

    appendMessageDom(msg) {
      const chat = document.querySelector("[data-chat-messages]");
      if (!chat) return;
      // The very first user message in the room renders as the convene block.
      const isOpener = msg.id === this.firstUserMessageId();
      chat.insertAdjacentHTML("beforeend", this.messageHtml(msg, isOpener));
    },

    /** "Thinking…" bouncing-dots placeholder shown before the first token. */
    thinkingHtml() {
      return '<span class="thinking-dots"><span></span><span></span><span></span></span>';
    },

    updateMessageBodyDom(messageId, body, streaming) {
      const article = document.querySelector(`[data-message-id="${messageId}"]`);
      if (!article) return;
      // Custom-rendered chair messages (chair-direct, intervention) use
      // their own body container — they don't share the .msg-bubble
      // swimlane. Find whichever body element exists. Order matters:
      // custom selectors first so we don't accidentally pick a nested
      // .msg-bubble inside a custom card later.
      const bubble =
        article.querySelector(".cd-body") ||
        article.querySelector(".ci-body") ||
        article.querySelector(".msg-bubble");
      if (!bubble) return;
      // Chair round-end: hide the structured POINTS: block from the bubble
      // even mid-stream so the user doesn't watch raw markup scroll by.
      const kind = article.getAttribute("data-meta-kind") || article.getAttribute("data-kind") || "";
      const display = kind === "round-end" ? this.stripPointsBlock(body) : body;
      const empty = !display;
      // Chair custom cards (chair-direct, chair-intervention) toggle
      // `is-streaming`; standard article bubbles toggle `streaming`.
      // Toggle the right class based on which container we're in so
      // the streaming pulse animations stay correct on either path.
      const isChairCard =
        article.classList.contains("chair-direct") ||
        article.classList.contains("chair-intervention");
      if (empty && streaming) {
        bubble.innerHTML = this.thinkingHtml();
        article.classList.add("thinking");
        article.classList.add(isChairCard ? "is-streaming" : "streaming");
      } else {
        bubble.innerHTML = this.renderBody(display);
        article.classList.toggle("thinking", false);
        article.classList.toggle(isChairCard ? "is-streaming" : "streaming", !!streaming);
      }
    },

    /** Count of prior non-empty messages this speaker would see as context. */
    contextCountAt(messageId) {
      const idx = this.currentMessages.findIndex((m) => m.id === messageId);
      if (idx <= 0) return 0;
      let n = 0;
      for (let i = 0; i < idx; i++) {
        const m = this.currentMessages[i];
        if (m.body && m.body.trim().length > 0) n++;
      }
      return n;
    },

    /** Strip the POINTS: block from a chair round-end body so only the
     *  one-sentence ping renders in the bubble — the points themselves
     *  are surfaced as vote chips below the message. */
    stripPointsBlock(body) {
      if (!body) return body;
      const idx = body.search(/POINTS\s*:/i);
      return idx < 0 ? body : body.slice(0, idx).trim();
    },

    /** Return the key points that belong to a chair round-end message. */
    keyPointsForMessage(messageId) {
      return (this.currentKeyPoints || []).filter((p) => p.messageId === messageId);
    },

    /** A round-prompt is "spent" once anything happens after it — the
     *  user clicked End round (chair fired round-end), Continue (next
     *  round of directors), or interjected a message. Chair settings
     *  pings don't count, since they're informational. */
    isRoundPromptSpent(messageId) {
      const idx = this.currentMessages.findIndex((m) => m.id === messageId);
      if (idx < 0) return true;
      const chairId = this.currentChair?.id;
      for (let i = idx + 1; i < this.currentMessages.length; i++) {
        const m = this.currentMessages[i];
        if (m.authorKind === "agent" && m.authorId === chairId && m.meta?.kind === "settings") continue;
        return true;
      }
      return false;
    },

    /** In-chat round-prompt card: chair offers End-round (vote) or
     *  Continue. The Continue button is also the auto-fire target for
     *  the 10s countdown. */
    roundPromptCardHtml(messageId) {
      const spent = this.isRoundPromptSpent(messageId);
      if (spent) {
        // Suppress when the room itself is adjourned · the room
        // header already conveys the terminal state, so a
        // "round closed · room moved on" trailing card is redundant
        // and visually competes with the brief / no-brief closing
        // marker as the actual end-of-room beat.
        if (this.currentRoom && this.currentRoom.status === "adjourned") {
          return "";
        }
        // Suppress the spent card when the very next message is a
        // chair milestone marker (round-open after Continue, or
        // no-brief at adjourn). Two adjacent centred-chip markers
        // read as a layout bug; the next marker already conveys the
        // closure via its own copy. If the gap is broken by a user
        // message or other chair message, the spent card stays —
        // those breaks make the chronology legible on its own.
        const idx = this.currentMessages.findIndex((x) => x.id === messageId);
        const next = idx >= 0 ? this.currentMessages[idx + 1] : null;
        const chairId = this.currentChair?.id;
        if (
          next &&
          next.authorKind === "agent" &&
          next.authorId === chairId &&
          next.meta &&
          (next.meta.kind === "round-open" || next.meta.kind === "no-brief")
        ) {
          return "";
        }
        // Pull the round number off the chair's round-prompt message
        // meta (announceRoundPrompt sets meta.roundNum). Falls back to
        // an empty prefix if the meta is missing or the lookup fails —
        // the marker still reads cleanly without the number.
        const m = this.currentMessages.find((x) => x.id === messageId);
        const n = (m && m.meta && typeof m.meta.roundNum === "number") ? m.meta.roundNum : null;
        const prefix = n != null
          ? `<span class="rp-spent-round">round #${n}</span><span class="rp-spent-sep">·</span>`
          : "";
        return `
          <div class="round-prompt-card spent" data-round-prompt-card="${this.escape(messageId)}">
            <span class="rp-spent-chip">
              <span class="rp-spent-mark">◇</span>
              ${prefix}
              <span class="rp-spent-label">closed · room moved on</span>
            </span>
          </div>
        `;
      }
      // Synthesis primitive · the backend may have attached a chair
      // recommendation (end | continue) on the round-prompt's meta.
      // When present, mark the matching button with `.recommended` so
      // the filled-primary treatment swaps onto it; below the row, a
      // small "chair pick" indicator line points to the recommended
      // button. The rationale is already in the message body, so the
      // indicator is a one-word marker, not a duplicated explanation.
      // Absent meta → no highlight, both buttons read equally (current
      // behaviour).
      const promptMsg = this.currentMessages.find((x) => x.id === messageId);
      const rec = promptMsg && promptMsg.meta && promptMsg.meta.recommendation;
      const recKind = rec && (rec.kind === "end" || rec.kind === "continue") ? rec.kind : null;
      const endClass  = recKind === "end"      ? " recommended" : "";
      const contClass = recKind === "continue" ? " recommended" : "";
      // Detect language for the indicator label · Chinese rooms get
      // 中文 copy. Reads from the chair's prompt body which lands in
      // the message body when a recommendation is present.
      const lang = (promptMsg && promptMsg.body && /[一-鿿]/.test(promptMsg.body)) ? "zh" : "en";
      const recLabel = lang === "zh" ? "主席建议" : "chair recommends";
      const recIndicator = recKind
        ? `
          <div class="rp-rec-line rp-rec-line-${this.escape(recKind)}">
            <span class="rp-rec-arrow" aria-hidden="true">↑</span>
            <span class="rp-rec-text">${this.escape(recLabel)}</span>
          </div>
        `
        : "";
      return `
        <div class="round-prompt-card${recKind ? " has-recommendation" : ""}" data-round-prompt-card="${this.escape(messageId)}"${recKind ? ` data-chair-recommendation="${this.escape(recKind)}"` : ""}>
          <div class="rp-primary">
            <button type="button" class="rp-btn vote${endClass}" data-round-end>
              <span class="rp-mark">▣</span>
              <span class="rp-label">End round · open key-point vote</span>
            </button>
            <button type="button" class="rp-btn continue${contClass}" data-continue-auto>
              <span class="rp-mark">▶</span>
              <span class="rp-label">Continue · next round</span>
              <span class="rp-timer" data-continue-timer></span>
            </button>
          </div>
          ${recIndicator}
          <button type="button" class="rp-adjourn" data-adjourn-from-chair>
            ⊘ Adjourn the room &amp; file the brief
          </button>
        </div>
      `;
    },

    /** Find the latest round-prompt that's still active. Returns null
     *  if none. Used to gate the auto-continue countdown so it only
     *  runs when the in-chat Continue button is actually live. */
    activeRoundPromptId() {
      const chairId = this.currentChair?.id;
      for (let i = this.currentMessages.length - 1; i >= 0; i--) {
        const m = this.currentMessages[i];
        if (m.authorKind === "agent" && m.authorId === chairId && m.meta?.kind === "round-prompt") {
          return this.isRoundPromptSpent(m.id) ? null : m.id;
        }
      }
      return null;
    },

    /** Repaint a single round-prompt card from current state. Mirrors
     *  repaintRoundEndCard — used when state changes flip the card
     *  between active and spent. */
    repaintRoundPromptCard(messageId) {
      if (!messageId) return;
      const card = document.querySelector(`.round-prompt-card[data-round-prompt-card="${messageId}"]`);
      if (!card) return;
      const html = this.roundPromptCardHtml(messageId);
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      const next = tmp.firstElementChild;
      if (next) card.replaceWith(next);
    },

    /** Walk every round-prompt card in the chat and re-evaluate its
     *  active/spent state. Cheap; called whenever a non-prompt message
     *  arrives so older prompts collapse to their "spent" treatment. */
    repaintAllRoundPrompts() {
      document.querySelectorAll(".round-prompt-card").forEach((card) => {
        const id = card.getAttribute("data-round-prompt-card");
        if (id) this.repaintRoundPromptCard(id);
      });
    },

    /** Vote / Continue / Adjourn card rendered under a chair round-end message. */
    roundEndCardHtml(messageId) {
      const points = this.keyPointsForMessage(messageId).slice().sort((a, b) => a.position - b.position);
      const awaiting = this.currentRoom?.awaitingContinue;
      // Detect whether the chair is still streaming the round-end body.
      // While streaming, the POINTS: block isn't parsed yet so points
      // is empty — we render a skeleton instead of nothing so the user
      // knows the vote card is incoming. The skeleton swaps to the real
      // card on the round-ended SSE event (which triggers a renderChat).
      const msg = this.currentMessages.find((m) => m.id === messageId);
      const isStreaming = !!(msg && msg.meta && msg.meta.streaming);
      if (points.length === 0) {
        // Don't render a skeleton for messages that are clearly NOT
        // a chair round-end (defensive — shouldn't happen since the
        // caller gates on metaKind === "round-end", but extra paranoia
        // costs nothing).
        const isRoundEnd = msg && msg.meta && msg.meta.kind === "round-end";
        if (!isRoundEnd) return "";
        // Skeleton · 3 placeholder rows with shimmering bars + a quiet
        // status line. Re-uses .round-end-card so the swap to the real
        // card on round-ended is a clean replace, not a layout shift.
        return `
          <div class="round-end-card pending" data-round-end-card="${this.escape(messageId)}">
            <div class="kp-eyebrow kp-eyebrow-pending">▸ key points · drafting</div>
            <div class="kp-list">
              <div class="kp-row kp-skeleton" aria-hidden="true">
                <div class="kp-skeleton-bar"></div>
                <div class="kp-skeleton-actions"></div>
              </div>
              <div class="kp-row kp-skeleton" aria-hidden="true">
                <div class="kp-skeleton-bar short"></div>
                <div class="kp-skeleton-actions"></div>
              </div>
              <div class="kp-row kp-skeleton" aria-hidden="true">
                <div class="kp-skeleton-bar"></div>
                <div class="kp-skeleton-actions"></div>
              </div>
            </div>
            <div class="kp-ctas-pending">
              <span class="kp-pending-dot"></span>
              <span class="kp-pending-text">${isStreaming ? "Chair is drafting key points…" : "Loading vote card…"}</span>
            </div>
          </div>
        `;
      }
      const items = points.map((p) => `
        <div class="kp-row" data-kp-id="${this.escape(p.id)}">
          <div class="kp-body">${this.escape(p.body)}</div>
          <div class="kp-actions">
            <button type="button" class="kp-vote up ${p.vote === "up" ? "active" : ""}" data-kp-vote="up" data-kp-id="${this.escape(p.id)}" aria-label="Interested">
              <span>▲</span><span>more</span>
            </button>
            <button type="button" class="kp-vote down ${p.vote === "down" ? "active" : ""}" data-kp-vote="down" data-kp-id="${this.escape(p.id)}" aria-label="Not interested">
              <span>▼</span><span>drop</span>
            </button>
          </div>
        </div>
      `).join("");
      const ctas = awaiting
        ? `
          <div class="kp-ctas">
            <button type="button" class="kp-cta primary" data-continue>[ ▶ Continue · next round ]</button>
            <button type="button" class="kp-cta ghost" data-adjourn-from-chair>[ ⊘ Adjourn &amp; file brief ]</button>
          </div>
        `
        : `<div class="kp-ctas-spent">// continued</div>`;
      return `
        <div class="round-end-card" data-round-end-card="${this.escape(messageId)}">
          <div class="kp-eyebrow">▸ key points · vote what you want pursued</div>
          <div class="kp-list">${items}</div>
          ${ctas}
        </div>
      `;
    },

    messageHtml(m, isOpener) {
      if (m.authorKind === "system") {
        return `<div class="config-marker" data-message-id="${m.id}"><span class="cm-line"></span><span class="cm-body"><span class="cm-time">${this.timeFmt(m.createdAt)}</span><span class="cm-label">${this.escape(m.body)}</span></span><span class="cm-line"></span></div>`;
      }
      // Convene opener — the room's seed question, distinct from regular chat.
      if (isOpener && m.authorKind === "user") {
        const who = this.escape(this.prefs?.name || "You");
        return `
          <article class="convene-opener" data-message-id="${this.escape(m.id)}">
            <div class="convene-eyebrow">▸ Convene · Initial Question</div>
            <h2 class="convene-body">${this.renderBody(m.body)}</h2>
            <div class="convene-meta">
              <span class="convene-by">${who}</span>
              <span class="convene-time">· ${this.timeFmt(m.createdAt)}</span>
              <span class="convene-cast">·  to ${this.currentMembers.map((a) => this.escape(a.handle)).join(" ")}</span>
            </div>
          </article>
        `;
      }
      const isUser = m.authorKind === "user";
      const author = isUser ? null : this.agentsById[m.authorId];
      const isChair = !isUser && author?.roleKind === "moderator";
      const metaKind = m.meta && typeof m.meta.kind === "string" ? m.meta.kind : null;

      // Convening · the chair's spoken introduction of the auto-
      // picked cast. Renders as a normal chair speech bubble (no
      // early return) — the substance comes from the streamed body,
      // not from special chrome. `meta.kind === "convening"` is kept
      // on the meta so future code can identify it (e.g. for hover
      // tooltips on the cast stack), but visually it's just the
      // chair speaking.

      // Tool-use row · the agent invoked a side-effect tool
      // (currently only the chair's `fetch-url`). Rendered as a tight
      // mono micro-row with a status glyph rather than a normal speech
      // bubble — it's an action by the speaker, not a contribution to
      // the discussion. status: running | done | failed.
      if (metaKind === "tool-use") {
        const meta = m.meta || {};
        const status = meta.status === "done" || meta.status === "failed" ? meta.status : "running";
        const tool = (meta.tool || "tool").toString();
        const target = meta.target ? String(meta.target) : "";
        const elapsed = typeof meta.elapsedMs === "number" && status !== "running"
          ? `${(meta.elapsedMs / 1000).toFixed(1)}s`
          : "";
        const sources = Array.isArray(meta.sources) ? meta.sources : [];

        // web-search renders as a full-width card mirroring `.brief-card`
        // (banner kicker + body + optional sources block + bottom
        // expand button). Other tool-use rows (fetch-url) keep the
        // compact micro-strip below — they're inline status beats,
        // not standalone deliverable surfaces.
        if (tool === "web-search") {
          const hasSources = status === "done" && sources.length > 0;
          let stamp;
          if (status === "running") stamp = "searching…";
          else if (status === "done")
            stamp = `${sources.length} source${sources.length === 1 ? "" : "s"}${elapsed ? " · " + elapsed : ""}`;
          else stamp = elapsed ? `failed · ${elapsed}` : "failed";

          const mark = status === "running"
            ? `<span class="msg-tool-pulse"></span>`
            : status === "done" ? `✓` : `⚠`;

          const sourcesList = hasSources
            ? `
              <ol class="msg-tool-sources-list" data-msg-ws-sources data-message-id="${this.escape(m.id)}" hidden>
                ${sources.map((s, i) => {
                  const url = s && typeof s.url === "string" ? s.url : "";
                  const title = s && typeof s.title === "string" ? s.title : url;
                  const desc = s && typeof s.description === "string" ? s.description : "";
                  const host = this.hostnameOf(url);
                  const numStr = String(i + 1).padStart(2, "0");
                  return `
                    <li>
                      <span class="msg-tool-sources-num">${numStr}</span>
                      <a href="${this.escape(url)}" target="_blank" rel="noopener noreferrer" class="msg-tool-sources-title">
                        <span class="msg-tool-sources-title-text">${this.escape(title)}</span>
                        <span class="msg-tool-sources-ext" aria-hidden="true">↗</span>
                      </a>
                      <span class="msg-tool-sources-host">${this.escape(host)}</span>
                      ${desc ? `<span class="msg-tool-sources-desc">${this.escape(desc)}</span>` : ""}
                    </li>
                  `;
                }).join("")}
              </ol>
              <button type="button" class="msg-tool-sources-expand" data-msg-ws-toggle data-message-id="${this.escape(m.id)}" aria-label="toggle sources">
                <span class="msg-tool-sources-expand-icon" aria-hidden="true">▾</span>
                <span class="msg-tool-sources-expand-show">Show all ${sources.length} sources</span>
                <span class="msg-tool-sources-expand-hide">Collapse</span>
              </button>`
            : "";

          const bodyToggleAttrs = hasSources
            ? ` data-msg-ws-toggle data-message-id="${this.escape(m.id)}" role="button" tabindex="0" aria-label="toggle sources"`
            : "";
          const caret = hasSources ? `<span class="msg-tool-caret" aria-hidden="true">▸</span>` : "";

          return `
            <div class="msg-tool-card status-${this.escape(status)}" data-message-id="${this.escape(m.id)}">
              <div class="msg-tool-banner">
                <span class="msg-tool-banner-tag">// web-search</span>
                <span class="msg-tool-banner-stamp">${this.escape(stamp)}</span>
              </div>
              <div class="msg-tool-card-body${hasSources ? " is-toggle" : ""}"${bodyToggleAttrs}>
                <span class="msg-tool-mark" aria-hidden="true">${mark}</span>
                <span class="msg-tool-card-text">${this.escape(m.body || "")}</span>
                ${caret}
              </div>
              ${sourcesList}
            </div>
          `;
        }

        // Compact micro-row for non-web-search tool-use (fetch-url).
        const isUrlTarget = /^https?:\/\//i.test(target);
        return `
          <div class="msg-tool-wrap" data-message-id="${this.escape(m.id)}">
            <div class="msg-tool kind-tool-${this.escape(tool)} status-${this.escape(status)}">
              <span class="msg-tool-mark" aria-hidden="true">
                ${status === "running" ? `<span class="msg-tool-pulse"></span>`
                  : status === "done"  ? `✓`
                                       : `⚠`}
              </span>
              <span class="msg-tool-name">${this.escape(tool)}</span>
              <span class="msg-tool-sep">·</span>
              <span class="msg-tool-body">${this.escape(m.body || "")}</span>
              ${elapsed ? `<span class="msg-tool-elapsed">${this.escape(elapsed)}</span>` : ""}
              ${isUrlTarget ? `<a href="${this.escape(target)}" target="_blank" rel="noopener noreferrer" class="msg-tool-link" title="${this.escape(target)}">↗</a>` : ""}
            </div>
          </div>
        `;
      }

      // Round-open marker · chair posts at the start of each fresh
      // Chair direct response · the user @mentioned the chair to ask a
      // meta question and the chair is replying directly. Distinct from
      // a normal chair speech bubble because the user-facing semantics
      // are different — the chair is RESPONDING TO THEM, not addressing
      // the room. Rendered with a kicker that names the dynamic + a
      // thin gold rule so the user sees their interruption was honored.
      if (isChair && metaKind === "chair-direct") {
        const streaming = m.meta && m.meta.streaming === true;
        const empty = !m.body || !m.body.trim();
        const bodyHtml = (empty && streaming)
          ? this.thinkingHtml()
          : this.renderBody(m.body);
        return `
          <div class="chair-direct${streaming ? " is-streaming" : ""}" data-message-id="${this.escape(m.id)}">
            <div class="cd-rule" aria-hidden="true"></div>
            <div class="cd-kicker">▸ chair · responding to you</div>
            <div class="cd-body">${bodyHtml}</div>
            <div class="cd-meta">
              <span class="cd-author">${this.escape(this.currentChair?.name || "Chair")}</span>
              <span class="cd-time">· ${this.timeFmt(m.createdAt)}</span>
            </div>
          </div>
        `;
      }

      // Chair intervention · the moderator's mid-round frame note,
      // posted by the orchestrator when the next-speaker picker detects
      // talking-past, undefined load-bearing term, hidden trade-off, or
      // circling. Renders as a centred moderator card — distinct from
      // a director speech bubble (it's not a turn, it's a re-framing)
      // and distinct from the round-open chip (which has no body).
      // The body carries the substance; the chrome is a kicker + thin
      // gold rule above. No avatar swimlane — moderator notes don't
      // claim authorship in the discussion's voice.
      if (isChair && metaKind === "intervention") {
        return `
          <div class="chair-intervention" data-message-id="${this.escape(m.id)}">
            <div class="ci-rule" aria-hidden="true"></div>
            <div class="ci-kicker">▸ chair note</div>
            <div class="ci-body">${this.renderBody(m.body)}</div>
          </div>
        `;
      }

      // Billing / quota notice · the chair speaks up when an upstream
      // API rejected a director turn for insufficient credit. Visually
      // shares the chair-intervention frame but switches the accent to
      // amber so the user reads it as a warning, not just a moderator
      // re-frame.
      if (isChair && metaKind === "billing-notice") {
        return `
          <div class="chair-billing-notice" data-message-id="${this.escape(m.id)}">
            <div class="cb-rule" aria-hidden="true"></div>
            <div class="cb-kicker">▸ billing · attention needed</div>
            <div class="cb-body">${this.renderBody(m.body)}</div>
          </div>
        `;
      }

      // sweep so the user sees whether directors are speaking in
      // parallel (opening · independent perspectives) or reacting to
      // one another (reactive · cross-pollination after Continue).
      // Rendered as a centred chip + flanking lines, not a bubble.
      if (isChair && metaKind === "round-open") {
        const meta = m.meta || {};
        const isOpening = meta.opening !== false;
        const roundNum = typeof meta.roundNum === "number" ? meta.roundNum : "—";
        return `
          <div class="round-open-card ${isOpening ? "is-opening" : "is-reactive"}" data-message-id="${this.escape(m.id)}">
            <span class="ro-chip">
              <span class="ro-mark">${isOpening ? "◆" : "◇"}</span>
              <span class="ro-round">round #${this.escape(String(roundNum))}</span>
              <span class="ro-sep">·</span>
              <span class="ro-mode">${isOpening ? "parallel · independent perspectives" : "reactive · directors react to one another"}</span>
            </span>
          </div>
        `;
      }

      // No-brief closing marker · chair posts this when the user
      // adjourned with skipBrief. Rendered as a milestone card (chip +
      // flanking lines) instead of a chat bubble so the transcript
      // ends on a clear "no report filed" beat that doesn't read as
      // just another chair turn.
      if (isChair && metaKind === "no-brief") {
        const ts = this.timeFmt(m.createdAt);
        // CTA only shown when no brief currently exists. Once the user
        // generates one, currentBrief is populated and we hide the
        // button so the card reads as a stable historical marker.
        const briefExists = !!this.currentBrief;
        return `
          <div class="no-brief-card" data-message-id="${this.escape(m.id)}">
            <span class="nb-chip">
              <span class="nb-mark">⊘</span>
              <span class="nb-eyebrow">adjourned · no brief filed</span>
            </span>
            <div class="nb-body">
              <strong>${this.escape(this.prefs?.name || "The chair")}</strong> declared no report is needed for this session.
            </div>
            <div class="nb-meta">${this.escape(ts)}</div>
            ${briefExists ? "" : `
              <div class="nb-actions">
                <button type="button" class="nb-cta" data-generate-brief>[ ✎ Generate report now ]</button>
              </div>
            `}
          </div>
        `;
      }

      const baseCls = isUser
        ? "user"
        : isChair
          ? "chair"
          : (author ? this.escape(author.id) : "agent");
      const name = isUser ? (this.prefs?.name || "You") : (author?.name || "Agent");
      const tag = isUser
        ? "// you"
        : isChair
          ? "// chair"
          : (author ? `// ${author.roleTag}` : "");
      // Model badge · only shown for non-user messages. Falls back to
      // the raw modelV string if the registry lookup misses (e.g. a
      // newly-added model the client doesn't know about yet).
      const modelLabel = !isUser && author?.modelV
        ? (MODEL_LABELS[author.modelV] || author.modelV)
        : "";
      // Agent avatar carries data-agent so the global agent-overlay
      // click handler picks it up. Critical for custom agents whose
      // src is a `data:image/svg+xml;...` URL — agent-overlay's
      // autoTagAvatars() only scans /avatars/<slug>.svg paths and
      // misses inline data URLs, which is why "click avatar to view
      // profile" kept regressing for custom directors.
      const agentTag = !isUser && author ? ` data-agent="${this.escape(author.id)}"` : "";
      // User avatar mirrors the preference-overlay setting · when
      // prefs.avatarSeed is present we render the AvatarSkill SVG
      // (same seed as the sidebar foot's user-av), otherwise fall back
      // to the initial-letter chip we shipped before AvatarSkill
      // existed.
      let userAvHtml;
      if (isUser) {
        const seed = this.prefs?.avatarSeed;
        if (seed && window.AvatarSkill && typeof window.AvatarSkill.generate === "function") {
          userAvHtml = `<div class="msg-av msg-av-pixel">${window.AvatarSkill.generate(seed)}</div>`;
        } else {
          userAvHtml = `<div class="msg-av">${this.escape((this.prefs?.name || "Y").charAt(0).toUpperCase())}</div>`;
        }
      }
      const avatarHtml = isUser
        ? userAvHtml
        : `<img class="msg-av" src="${this.escape(author?.avatarPath || "/avatars/socrates.svg")}" alt=""${agentTag}>`;

      // Chair round-end: trim the POINTS: block from the bubble; the
      // vote card below the bubble surfaces the points as toggles.
      const displayBody = (isChair && metaKind === "round-end")
        ? this.stripPointsBlock(m.body)
        : m.body;

      const empty = !displayBody;
      const streaming = m.meta && m.meta.streaming === true;
      const stateCls = [];
      if (streaming) stateCls.push("streaming");
      if (empty && streaming && !isUser) stateCls.push("thinking");
      if (metaKind) stateCls.push(`kind-${metaKind}`);

      const bubbleHtml = (empty && streaming && !isUser)
        ? this.thinkingHtml()
        : this.renderBody(displayBody);

      // Director context indicator — not shown for the chair (their job
      // is procedural; ctx count would be misleading).
      const ctxCount = !isUser && !isChair ? this.contextCountAt(m.id) : 0;
      const ctxBadge = ctxCount > 0
        ? `<span class="msg-context" title="${ctxCount} prior turns sent as context to ${this.escape(name)}">· ${ctxCount} ctx</span>`
        : "";

      // Skills badge · the orchestrator's Pass-1 router stamps which
      // skills (if any) were applied for this turn into meta.skillsUsed.
      // Renders as a small pill next to the model so the user sees the
      // effect of installing a skill turn-by-turn.
      const skillsUsed = (m.meta && Array.isArray(m.meta.skillsUsed)) ? m.meta.skillsUsed : [];
      const skillsReason = (m.meta && typeof m.meta.skillsReason === "string") ? m.meta.skillsReason : "";
      const skillsBadge = skillsUsed.length > 0
        ? `<span class="msg-skills" title="${this.escape(skillsReason || ("skills used: " + skillsUsed.join(", ")))}">🛠 ${skillsUsed.map((s) => this.escape(s)).join(", ")}</span>`
        : "";

      // Web-search badge · meta is set by the orchestrator when the
      // Pass-1 router decided to run a Brave query and got results.
      // Renders next to the skills pill; clicking expands the source
      // list under the bubble.
      const webSearchUsed = !!(m.meta && m.meta.webSearchUsed);
      const webSearchQuery = (m.meta && typeof m.meta.webSearchQuery === "string") ? m.meta.webSearchQuery : "";
      const webSearchSources = (m.meta && Array.isArray(m.meta.webSearchSources)) ? m.meta.webSearchSources : [];
      const webSearchBadge = webSearchUsed
        ? `<button type="button" class="msg-web-search" data-msg-ws-toggle data-message-id="${this.escape(m.id)}" title="${this.escape(`web search: ${webSearchQuery} · ${webSearchSources.length} source${webSearchSources.length === 1 ? "" : "s"}`)}">🔍 web search · ${webSearchSources.length} source${webSearchSources.length === 1 ? "" : "s"}</button>`
        : "";
      const webSearchSourcesPanel = webSearchUsed && webSearchSources.length > 0
        ? `<div class="msg-web-search-sources" data-msg-ws-sources data-message-id="${this.escape(m.id)}" hidden>
            <div class="msg-web-search-query"><span class="msg-web-search-query-label">query</span><span class="msg-web-search-query-text">${this.escape(webSearchQuery)}</span></div>
            <ol class="msg-web-search-list">
              ${webSearchSources.map((s, i) => `
                <li>
                  <span class="msg-web-search-num">[${i + 1}]</span>
                  <a href="${this.escape(s.url)}" target="_blank" rel="noopener noreferrer" class="msg-web-search-title">${this.escape(s.title || s.url)}</a>
                  ${s.description ? `<span class="msg-web-search-desc">${this.escape(s.description)}</span>` : ""}
                  <span class="msg-web-search-host">${this.escape(this.hostnameOf(s.url))}</span>
                </li>
              `).join("")}
            </ol>
          </div>`
        : "";

      // Round-end card · render even DURING streaming so the user sees
      // a skeleton placeholder immediately after the chair's ping
      // bubble lands. Without it, the chat sits visibly idle for ~3-5s
      // between "chair speaks the ping" and "round-ended event fires
      // with parsed key points". The skeleton fills that gap with a
      // "drafting key points…" state that swaps to the real vote card
      // when round-ended arrives.
      const roundEndCard = (isChair && metaKind === "round-end")
        ? this.roundEndCardHtml(m.id)
        : "";
      // Chair's round-prompt: rendered as a sibling action card
      // beneath the message. Shows live action buttons or "spent"
      // depending on whether the room moved past it.
      const roundPromptCard = (isChair && metaKind === "round-prompt" && !streaming)
        ? this.roundPromptCardHtml(m.id)
        : "";

      // Same meta order for everyone: name · tag · ctx · time. The user's
      // own messages used to right-align the name; switching to the same
      // left-aligned order as agents puts every speaker's name in the
      // same column so the eye can scan the conversation faster.
      // Round-end / round-prompt cards render as TOP-LEVEL siblings of
      // the article so they can match the convene-opener's centered
      // 760px width without being constrained by the avatar+content grid.
      // Chair-pick kicker · the orchestrator stamps meta.chairPick on
      // a director's message when the haiku next-speaker picker chose
      // them over round-robin. Surfaces as a small mono kicker above
      // the bubble so the user reads the moderator's reasoning. Empty
      // string when this turn was round-robin (no chair pick).
      const chairPick = (m.meta && m.meta.chairPick && typeof m.meta.chairPick.rationale === "string")
        ? m.meta.chairPick.rationale.trim()
        : "";
      const chairPickKicker = (chairPick && !isUser && !isChair)
        ? `<div class="msg-chair-pick" title="Chair picked ${this.escape(name)} for this turn">▸ chair · ${this.escape(chairPick)}</div>`
        : "";

      // data-author-id is only attached for director messages (not user
       // / not chair) — read by quote-cta.js to credit the director when
       // the user probes / seconds a passage from this bubble.
      const authorIdAttr = (!isUser && !isChair && author?.id)
        ? ` data-author-id="${this.escape(author.id)}"`
        : "";
      return `
        <article class="msg ${baseCls}${stateCls.length ? " " + stateCls.join(" ") : ""}" data-message-id="${this.escape(m.id)}" data-meta-kind="${this.escape(metaKind || "")}"${authorIdAttr}>
          ${avatarHtml}
          <div class="msg-content">
            ${chairPickKicker}
            <div class="msg-meta">
              <span class="msg-name">${this.escape(name)}</span>
              ${modelLabel ? `<span class="msg-model" title="model · ${this.escape(modelLabel)}">${this.escape(modelLabel)}</span>` : ""}
              <span class="msg-tag">${tag}</span>
              ${skillsBadge}
              ${webSearchBadge}
              ${ctxBadge}
              <span class="msg-time">${this.timeFmt(m.createdAt)}</span>
            </div>
            <div class="msg-bubble">${bubbleHtml}</div>
            ${webSearchSourcesPanel}
          </div>
        </article>
        ${roundEndCard}
        ${roundPromptCard}
      `;
    },

    /** True only when ALL directors have spoken in the current round.
     *  The orchestrator emits {spoken,total} on every queue-update, so
     *  this gates correctly across rounds without any client-side
     *  bookkeeping. Total === 0 means a round hasn't started yet
     *  (e.g., during chair clarification). */
    isRoundComplete() {
      const r = this.currentRound;
      if (!r || !r.total) return false;
      if (r.spoken < r.total) return false;
      // Belt-and-braces: queue must be drained and no one mid-stream.
      if (this.currentQueue && this.currentQueue.length > 0) return false;
      if (this.isAgentSpeaking()) return false;
      return true;
    },

    /** Should the manual "End round" button be clickable right now?
     *  Mirrors canAutoContinue — both buttons live in the chair's
     *  round-prompt card and only one prompt is "live" at a time. */
    canRequestRoundEnd() {
      const r = this.currentRoom;
      if (!r) return false;
      if (r.status !== "live") return false;
      if (r.awaitingClarify) return false;
      if (r.awaitingContinue) return false;
      if (!this.isRoundComplete()) return false;
      return !!this.activeRoundPromptId();
    },

    /** Sync the in-chat End-round button's enabled state. */
    refreshRoundEndButton() {
      const btn = document.querySelector("button[data-round-end]");
      if (!btn) return;
      const ok = this.canRequestRoundEnd();
      btn.disabled = !ok;
      // Old queue strip used .qw-label; new in-chat card uses .rp-label.
      const label = btn.querySelector(".rp-label, .qw-label");
      if (label) {
        if (this.currentRoom?.awaitingContinue) label.textContent = "Round wrapped · vote above";
        else if (this.currentRoom?.awaitingClarify) label.textContent = "Clarifying — wait for chair";
        else label.textContent = "End round · open key-point vote";
      }
    },

    /** Build the one-line summary shown in the collapsed speaking-queue
     *  strip. Mirrors the expanded queue: speaking, pending, or idle. */
    renderQueueCollapsed(items) {
      const slot = document.querySelector("[data-queue-collapsed]");
      if (!slot) return;
      if (!items || items.length === 0) {
        slot.innerHTML = `<span class="sum-marker">·</span><span class="sum-state">queue idle</span>`;
        return;
      }
      const head = items[0];
      const a = this.agentsById[head.agentId];
      if (!a) { slot.innerHTML = ""; return; }
      const speaking = head.status === "speaking";
      const pending = head.status === "pending";
      const stateLabel = speaking
        ? "●●● speaking"
        : pending
          ? (this.currentRoom?.awaitingContinue
              ? "pending · waits for vote"
              : "pending · waits for chair")
          : "queued";
      const next = items[1] ? this.agentsById[items[1].agentId] : null;
      const rest = items.length > 2 ? `+${items.length - 2} queued` : "";

      const parts = [];
      parts.push(`<span class="sum-marker">${speaking ? "▶" : pending ? "◇" : "·"}</span>`);
      parts.push(`<img class="sum-av" src="${this.escape(a.avatarPath)}" alt="" data-agent="${this.escape(a.id)}">`);
      parts.push(`<span class="sum-who">${this.escape(a.name)}</span>`);
      parts.push(`<span class="sum-state">${this.escape(stateLabel)}</span>`);
      if (next) {
        parts.push(`<span class="sum-divider">·</span>`);
        parts.push(`<span class="sum-next-label">↪</span>`);
        parts.push(`<span class="sum-next">${this.escape(next.name)}</span>`);
      }
      if (rest) {
        parts.push(`<span class="sum-divider">·</span>`);
        parts.push(`<span class="sum-rest">${this.escape(rest)}</span>`);
      }
      slot.innerHTML = parts.join("");
    },

    renderQueue() {
      this.refreshRoundEndButton();
      // Idle? Spin up the countdown. Active? Cancel.
      this.maybeStartContinueCountdown();
      const list = document.querySelector("[data-queue-list]");
      if (!list) return;

      // Preview queue · the orchestrator drains its real queue between
      // turns. We surface the cast as a preview when:
      //   (a) the chair is clarifying — directors haven't been enqueued
      //       yet, but the user should see who's lined up
      //   (b) the chair just filed a round-end — vote is up, directors
      //       are pending the user's Continue / Adjourn decision
      // In both cases the first director is "pending"; the rest queue.
      const idleWithCast =
        this.currentRoom &&
        (this.currentRoom.awaitingClarify || this.currentRoom.awaitingContinue);
      const previewing = idleWithCast && this.currentQueue.length === 0;
      const renderItems = previewing
        ? this.currentMembers.map((a, i) => ({
            agentId: a.id,
            status: i === 0 ? "pending" : "queued",
            preview: true,
          }))
        : this.currentQueue.map((q) => ({ ...q, preview: false }));

      // Splice in a virtual "you" row right after the current speaker
      // when the user has queued a message behind them.
      if (this.pendingUserMessage && renderItems.length > 0) {
        const speakingIdx = renderItems.findIndex((q) => q.status === "speaking");
        if (speakingIdx >= 0) {
          renderItems.splice(speakingIdx + 1, 0, {
            agentId: "__user_pending__",
            status: "user-queued",
            preview: false,
            isUserPending: true,
            userPendingText: this.pendingUserMessage,
          });
        }
      }

      // Update the collapsed summary alongside the expanded list so the
      // collapsed strip never shows stale text.
      this.renderQueueCollapsed(renderItems);

      if (renderItems.length === 0) {
        list.innerHTML = "";
        return;
      }

      const POS = ["①", "②", "③", "④", "⑤", "⑥"];
      const ctxTotal = this.currentMessages.reduce(
        (n, m) => (m.body && m.body.trim().length > 0 ? n + 1 : n),
        0,
      );
      const firstSpeaking = renderItems[0]?.status === "speaking";
      list.innerHTML = renderItems
        .map((q, i) => {
          // Special row · user message queued behind the current speaker.
          if (q.isUserPending) {
            const userName = (window.app?.prefs?.name || "you");
            const preview = q.userPendingText.length > 64
              ? q.userPendingText.slice(0, 60).trim() + "…"
              : q.userPendingText;
            return `
              <li class="queue-row user-queued" data-user-queued>
                <span class="pos">↪</span>
                <span class="who">${this.escape(userName)}</span>
                <span class="state">queued · "${this.escape(preview)}"</span>
                <span class="actions">
                  <button type="button" class="user-queued-cancel" data-cancel-user-queued title="Cancel">✕</button>
                </span>
              </li>
            `;
          }
          const a = this.agentsById[q.agentId];
          if (!a) return "";
          const speaking = q.status === "speaking";
          const pending = q.status === "pending";
          const cls = speaking
            ? "speaking"
            : pending
              ? "pending"
              : (i === 0 ? "next" : "");
          const pos = speaking ? "▶" : (POS[i - (firstSpeaking ? 1 : 0)] || (i + 1));
          let stateLabel;
          if (speaking) {
            stateLabel = `speaking · reading ${ctxTotal} ${ctxTotal === 1 ? "turn" : "turns"}`;
          } else if (pending) {
            // Pending means "lined up, waiting on something off-queue".
            // Phrasing matches the room's current pause kind so the
            // user knows what they're waiting on.
            stateLabel = this.currentRoom?.awaitingContinue
              ? "pending · waits for your vote"
              : this.currentRoom?.awaitingClarify
                ? "pending · waits for chair"
                : "pending";
          } else {
            stateLabel = q.status;
          }
          return `
            <li class="queue-row ${cls}" data-slug="${this.escape(a.id)}">
              <span class="pos">${pos}</span>
              <img src="${this.escape(a.avatarPath)}" alt="" data-agent="${this.escape(a.id)}">
              <span class="who">${this.escape(a.name)}</span>
              <span class="state">${this.escape(stateLabel)}</span>
              <span class="actions"></span>
            </li>
          `;
        })
        .join("");
    },

    renderBrief() {
      const card = document.querySelector("[data-brief-card]");
      if (!card) return;
      if (!this.currentBrief) {
        card.innerHTML = "";
        card.classList.remove("ending-block");
        return;
      }
      card.classList.add("ending-block");
      const b = this.currentBrief;

      // Error path: a compact error card with a retry button. Three
      // sub-cases:
      //   · timedOut (no completion after 5 min wall-clock) → "took
      //     too long" copy with the elapsed-time reason inline
      //   · interrupted (zombie placeholder from a refresh / restart) →
      //     specific copy + Regenerate CTA
      //   · generic LLM failure → original "needs an API key" hint
      if (b.error) {
        const lang = (b.language === "zh" || (this.currentRoom?.subject && /[一-鿿]/.test(this.currentRoom.subject))) ? "zh" : "en";
        const copy = b.timedOut
          ? (lang === "zh"
            ? {
                stamp: "timed out",
                kicker: "// 报告生成超时",
                detail: "已超过 5 分钟仍未收到完成信号 · 可能是模型回应过慢、网络中断，或后端流水线卡住了。点击下方按钮重试，或检查 LLM key 与网络后再试。",
                hint: "",
                cta: "重试",
              }
            : {
                stamp: "timed out",
                kicker: "// generation timed out",
                detail: "No completion signal after 5 minutes — the model may be slow, the connection dropped, or the pipeline stalled. Click below to start a fresh run.",
                hint: "",
                cta: "Retry",
              })
          : b.interrupted
          ? (lang === "zh"
            ? {
                stamp: "interrupted",
                kicker: "// 报告生成被中断了",
                detail: "上一次生成在浏览器刷新或服务重启时中止了。点击下方按钮重新生成一份报告。",
                hint: "",
                cta: "重新生成报告",
              }
            : {
                stamp: "interrupted",
                kicker: "// generation interrupted",
                detail: "The previous generation was cut short — likely by a browser refresh or a server restart. Click below to start a fresh report.",
                hint: "",
                cta: "Regenerate report",
              })
          : (lang === "zh"
            ? {
                stamp: "failed",
                kicker: "// 报告生成失败",
                detail: this.escape(b.error || ""),
                hint: "Brief writer 需要一个 LLM key（OpenRouter，或 Anthropic / OpenAI / Google / xAI 直连）。在 <strong>Preference → API Key</strong> 中添加后再试。",
                cta: "重试",
              }
            : {
                stamp: "failed",
                kicker: "// brief generation failed",
                detail: this.escape(b.error || ""),
                hint: "The brief writer needs an LLM key (OpenRouter, or a direct Anthropic / OpenAI / Google / xAI key). Add one in <strong>Preference → API Key</strong> and try again.",
                cta: "Retry",
              });
        card.innerHTML = `
          <div class="brief-card">
            <div class="brief-banner">
              <span class="brief-banner-tag" style="color: var(--red);">// report</span>
              <span class="brief-banner-stamp" style="color: var(--red);">${this.escape(copy.stamp)}</span>
            </div>
            <div class="brief-body brief-body-error">
              <div class="brief-kicker" style="color: var(--red);">${this.escape(copy.kicker)}</div>
              <div class="brief-meta-line" style="color: var(--text-soft); text-transform: none; letter-spacing: 0;">
                ${(b.interrupted || b.timedOut) ? this.escape(copy.detail) : copy.detail}
              </div>
              ${copy.hint ? `<div class="brief-meta-line" style="margin-top: 14px; text-transform: none; letter-spacing: 0;">${copy.hint}</div>` : ""}
              <div class="brief-error-actions">
                <button type="button" class="brief-retry-btn" data-brief-retry>
                  <span class="brief-retry-mark">↻</span>
                  <span>${this.escape(copy.cta)}</span>
                </button>
              </div>
            </div>
          </div>
        `;
        return;
      }

      const generating = !b.bodyMd || b.title === "Generating…";
      const signed = this.currentMembers
        .map((a) => `<img src="${this.escape(a.avatarPath)}" alt="${this.escape(a.name)}" title="${this.escape(a.name)}">`)
        .join("");

      const filedLabel = generating
        ? "GENERATING…"
        : "FILED · " + (b.createdAt ? this.timeFmt(b.createdAt) : this.timeFmt(Date.now()));

      // Open Report links to /report.html with both r (room) and b
      // (brief id) — the viewer uses b when present so refining
      // shows the right version.
      const reportHref = this.currentRoomId && b.id
        ? `/report.html?r=${encodeURIComponent(this.currentRoomId)}&b=${encodeURIComponent(b.id)}`
        : (this.currentRoomId ? `/report.html?r=${encodeURIComponent(this.currentRoomId)}` : null);

      // Tab strip · only rendered when ≥ 2 briefs filed for this room.
      // Tabs are ordered oldest → newest so "01" reads as the original
      // and the latest sits on the right edge. Active tab = currently
      // shown brief. Each tab has a tooltip showing the supplement (if
      // any) so the user can recall what each regen was about.
      const briefs = Array.isArray(this.currentBriefs) ? this.currentBriefs : [];
      const sortedBriefs = briefs.slice().sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
      const showTabs = sortedBriefs.length > 1;
      const tabsHtml = showTabs ? `
        <div class="brief-versions">
          ${sortedBriefs.map((bf, i) => {
            const isActive = bf.id === b.id;
            const num = String(i + 1).padStart(2, "0");
            const isInitial = i === 0;
            const supp = bf.supplement && bf.supplement.trim()
              ? bf.supplement.trim()
              : (isInitial ? (b.language === "zh" ? "初版" : "Initial") : "");
            const tooltip = isInitial
              ? (b.language === "zh" ? `初版报告 · 由会议本身生成` : `Initial brief · generated from the session`)
              : `${b.language === "zh" ? "补充视角：" : "Supplement: "}${supp || "—"}`;
            const closeTitle = b.language === "zh" ? "删除这份报告" : "Delete this report";
            return `
              <span class="brief-version-tab-wrap${isActive ? " active" : ""}">
                <button type="button" class="brief-version-tab${isActive ? " active" : ""}" data-brief-tab data-brief-id="${this.escape(bf.id)}" title="${this.escape(tooltip)}">
                  <span class="brief-version-num">${num}</span>
                  ${isInitial
                    ? `<span class="brief-version-label">${b.language === "zh" ? "初版" : "Initial"}</span>`
                    : `<span class="brief-version-label">${this.escape((supp || "").slice(0, 20))}${(supp || "").length > 20 ? "…" : ""}</span>`}
                </button>
                <button type="button" class="brief-version-close" data-brief-delete data-brief-id="${this.escape(bf.id)}" title="${this.escape(closeTitle)}" aria-label="${this.escape(closeTitle)}">×</button>
              </span>
            `;
          }).join("")}
        </div>
      ` : "";

      // Ceremonial wrapper · the deliverable hits the table inside an
      // ending-block frame.
      card.innerHTML = `
        <header class="ending-block-head">
          <span class="ending-block-line"></span>
          <span class="ending-block-label">▼ session output ▼</span>
          <span class="ending-block-line"></span>
        </header>

        <div class="brief-card">
          ${tabsHtml}
          <div class="brief-banner">
            <span class="brief-banner-tag">// report</span>
            <span class="brief-banner-stamp">${filedLabel}</span>
          </div>

          <div class="brief-body">
            ${generating
              ? `<div class="brief-info brief-info-generating">${this.renderBriefStages(b)}</div>`
              : `<div class="brief-info">
                  <div class="brief-kicker">// filed by ${this.escape(this.currentChair?.name || "the chair")}</div>
                  <h2 class="brief-title" data-brief-title>${this.escape(b.title || "(untitled)")}</h2>
                  <div class="brief-meta-row">
                    <span class="brief-meta-line">${this.currentMembers.length} authors</span>
                    <div class="brief-signed">
                      <div class="brief-signed-avatars">${signed}</div>
                    </div>
                  </div>
                </div>`
            }

            ${reportHref && !generating ? `
              <a href="${reportHref}" class="brief-open" target="_blank" rel="noopener">
                <span class="brief-open-icon">▸</span>
                <span class="brief-open-label">open report</span>
                <span class="brief-open-arrow">→</span>
              </a>
            ` : ""}
          </div>

          ${!generating ? `
            <div class="brief-supplement-row">
              <button type="button" class="brief-supplement-btn" data-brief-supplement>
                <span class="brief-supplement-mark">+</span>
                <span class="brief-supplement-label">${(b.language === "zh" ? "补充视角，再生成一版报告" : "Add a perspective · regenerate")}</span>
              </button>
              <button type="button" class="brief-delete-btn" data-brief-delete data-brief-id="${this.escape(b.id)}" title="${(b.language === "zh" ? "删除这份报告" : "Delete this report")}">
                <span class="brief-delete-mark">⌫</span>
                <span class="brief-delete-label">${(b.language === "zh" ? "删除报告" : "Delete report")}</span>
              </button>
            </div>
          ` : ""}
        </div>

        <footer class="ending-block-foot">
          <span class="ending-block-foot-line"></span>
          <span class="ending-block-foot-label">// end of session</span>
          <span class="ending-block-foot-line"></span>
        </footer>
      `;
    },

    /** Per-stage ETA range (seconds) shown next to the active stage. Once
     *  elapsed exceeds the upper bound, the ETA is dropped and only
     *  elapsed shows — so we never lie about timing.
     *
     *  Rotating "substage" descriptors are cycled client-side every ~3 s
     *  while the stage is active. They never claim more progress than
     *  what's actually happening — they describe sub-actions that the
     *  pipeline genuinely performs. */
    BRIEF_STAGE_META: {
      extract:  { eta: [5, 15] },
      scaffold: { eta: [10, 30] },
      write:    { eta: [30, 90] },
    },
    BRIEF_SUBSTAGES: {
      en: {
        extract: [
          "Re-reading each director's contributions",
          "Tagging signals by lens (data / dissent / narrative / structural / first-principle)",
          "Tightening to 2–4 signals per director",
        ],
        scaffold: [
          "Clustering signals into theme camps",
          "Identifying the central tension (the crux)",
          "Looking for convergent independent reasoning",
          "Spotting questions that didn't exist when the room opened",
          "Drafting recommendations + pre-mortem",
          "Picking visuals if the structure warrants them",
          "Tightening into a research-note scaffold",
        ],
        write: [
          "Writing the Bottom Line",
          "Composing the Frame Shift section",
          "Writing the 3 Headline Findings",
          "Drafting Convergence + Divergence sections",
          "Composing Recommendations",
          "Writing the Pre-mortem",
          "Surfacing New Questions",
          "Drafting the Strategic Planning Assumption",
          "Polishing the final pass",
        ],
      },
      zh: {
        extract: [
          "重读每位董事的发言",
          "按视角标签（data / dissent / narrative / structural / first-principle）整理信号",
          "压缩到每位董事 2-4 条关键信号",
        ],
        scaffold: [
          "把信号聚类成主题阵营",
          "识别核心张力（the crux）",
          "寻找独立路径下的趋同点",
          "找出会议过程中『长出来』的新问题",
          "起草 Recommendations 和 Pre-mortem",
          "如果结构允许，选择合适的图表",
          "收敛成研究纪要骨架",
        ],
        write: [
          "撰写 Bottom Line",
          "撰写 Frame Shift 段落",
          "撰写 3 条 Headline Findings",
          "起草 Convergence 与 Divergence 段落",
          "撰写 Recommendations",
          "撰写 Pre-mortem",
          "梳理 New Questions",
          "起草 Strategic Planning Assumption",
          "通读润色，准备交稿",
        ],
      },
    },

    /** Set up a 1s tick that re-renders the brief stages while at least
     *  one stage is active OR the writing stage is still streaming.
     *  Idempotent — calling repeatedly is fine. */
    ensureBriefStageTick() {
      if (this._briefStageTick) return;
      this._briefStageTick = setInterval(() => {
        const b = this.currentBrief;
        if (!b || b.error) {
          this.stopBriefStageTick();
          return;
        }
        const stages = b.stages || {};
        const anyActive = Object.values(stages).some((s) => s && s.status === "active");
        const generating = !b.bodyMd || b.title === "Generating…";
        if (!anyActive && !generating) {
          this.stopBriefStageTick();
          return;
        }
        // Re-render the stages block in place. Cheaper than full
        // renderBrief() — but renderBrief is fine if needed.
        this.renderBrief();
      }, 1000);
    },

    stopBriefStageTick() {
      if (this._briefStageTick) {
        clearInterval(this._briefStageTick);
        this._briefStageTick = null;
      }
    },

    /* ─── Brief stall watcher ─────────────────────────────────────
       Surfaces the Retry CTA promptly when generation stalls or
       times out — the user no longer has to leave + re-enter the
       room to discover a dead pipeline. Two safety nets:

       · Stall poll · if no brief-* SSE event arrives for
         BRIEF_STALL_POLL_MS, ask /api/briefs/<id>/status. The
         server flips to !generating + !hasBody when the pipeline
         crashed mid-flight; checkBriefHealth (re-used) renders
         that as the existing "interrupted" error.

       · Hard timeout · after BRIEF_HARD_TIMEOUT_MS of total
         wall-clock with no brief-final, force a `timedOut` error
         locally so Retry appears regardless of server-side state
         (covers SSE drops + LLM black-holes alike). */
    BRIEF_STALL_POLL_MS: 60_000,
    BRIEF_HARD_TIMEOUT_MS: 5 * 60_000,
    BRIEF_WATCH_INTERVAL_MS: 10_000,

    markBriefEvent() {
      this._lastBriefEventAt = Date.now();
    },

    ensureBriefStallWatch() {
      if (this._briefStallWatchTimer) return;
      const b = this.currentBrief;
      if (!b || !b.id || b.error) return;
      const generating = !b.bodyMd || b.title === "Generating…";
      if (!generating) return;
      if (!this._lastBriefEventAt) this._lastBriefEventAt = Date.now();
      this._lastBriefHealthPollAt = 0;
      this._briefStallWatchTimer = setInterval(
        () => this.tickBriefStallWatch(),
        this.BRIEF_WATCH_INTERVAL_MS,
      );
    },

    stopBriefStallWatch() {
      if (this._briefStallWatchTimer) {
        clearInterval(this._briefStallWatchTimer);
        this._briefStallWatchTimer = null;
      }
    },

    async tickBriefStallWatch() {
      const b = this.currentBrief;
      if (!b || b.error) { this.stopBriefStallWatch(); return; }
      const generating = !b.bodyMd || b.title === "Generating…";
      if (!generating) { this.stopBriefStallWatch(); return; }

      const now = Date.now();
      const startedAt = b.pipelineStartedAt || this._lastBriefEventAt || now;

      // Hard ceiling · regardless of server state, flip the card to
      // a timed-out error so the user always has a way out.
      if (now - startedAt > this.BRIEF_HARD_TIMEOUT_MS) {
        b.error = b.language === "zh"
          ? "报告生成超时（超过 5 分钟仍未完成）。"
          : "Brief generation timed out (no completion after 5 minutes).";
        b.timedOut = true;
        this.stopBriefStageTick();
        this.stopBriefStallWatch();
        this.renderBrief();
        return;
      }

      // Soft stall · poll the server at most once per STALL_POLL_MS
      // while we're not hearing anything. checkBriefHealth flips the
      // card to "interrupted" if the server has already given up.
      const lastEvt = this._lastBriefEventAt || startedAt;
      const elapsedSinceEvt = now - lastEvt;
      const pollGap = now - (this._lastBriefHealthPollAt || 0);
      if (elapsedSinceEvt > this.BRIEF_STALL_POLL_MS && pollGap > this.BRIEF_STALL_POLL_MS) {
        this._lastBriefHealthPollAt = now;
        await this.checkBriefHealth(b);
      }
    },

    /** Render the 3-stage checklist shown while the brief is generating.
     *  Each row pulses while active, gets a check when done. The active
     *  row also shows:
     *    · ETA range (e.g. "~10–30 s") OR elapsed once over the upper bound
     *    · A rotating sub-action descriptor underneath the label
     *  These mean the user never sees a frozen frame. */
    renderBriefStages(b) {
      const stages = b.stages || {
        extract: { status: "active", detail: "", progress: null, startedAt: null },
        scaffold: { status: "pending", detail: "", progress: null, startedAt: null },
        write: { status: "pending", detail: "", progress: null, startedAt: null },
      };
      const lang = b.language === "zh" ? "zh" : "en";
      const chairName = b.chairName || this.currentChair?.name || (lang === "zh" ? "主席" : "Chair");

      const wordCount = b.bodyMd
        ? (b.bodyMd.trim().match(/\S+/g) || []).length
        : 0;

      const labels = lang === "zh"
        ? {
            extract:  "提取每位董事的关键信号",
            scaffold: "归并信号、构建报告骨架",
            write:    "撰写最终报告",
            wordUnit: (n) => `${n} 字`,
            directorUnit: (cur, total) => `${cur}/${total} 位董事`,
            etaPrefix: "预计",
            secUnit: "s",
            elapsedFormat: (s) => `已耗时 ${s} s`,
          }
        : {
            extract:  "Extracting signals from each director",
            scaffold: "Clustering signals into findings",
            write:    "Writing the report",
            wordUnit: (n) => `${n} word${n === 1 ? "" : "s"}`,
            directorUnit: (cur, total) => `${cur}/${total} director${total === 1 ? "" : "s"}`,
            etaPrefix: "ETA",
            secUnit: "s",
            elapsedFormat: (s) => `${s} s elapsed`,
          };

      const kickerText = lang === "zh"
        ? `// ${chairName} 正在帮你整理会议纪要并生成报告`
        : `// ${chairName} is preparing the minutes and writing the report`;

      const substages = (this.BRIEF_SUBSTAGES[lang] || this.BRIEF_SUBSTAGES.en);
      const meta = this.BRIEF_STAGE_META;

      const buildRow = (key) => {
        const st = stages[key] || { status: "pending" };
        const status = st.status || "pending";
        // Prefer server-computed ETA (token-based) over the static
        // fallback. The server estimates from system-prompt size +
        // signal/scaffold tokens × per-model tps, so it adapts to the
        // actual conversation rather than a one-size guess.
        const serverEta = st.etaSec && typeof st.etaSec.lo === "number"
          ? [st.etaSec.lo, st.etaSec.hi]
          : null;
        const eta = serverEta || meta[key]?.eta;
        const startedAt = st.startedAt;
        // Done stages freeze at finishedAt so the displayed duration
        // is the actual time the stage took, not "current time minus
        // when it started" (which would keep ticking after completion).
        // Active stages still use Date.now() so the counter animates.
        const endRef = (status === "done" && st.finishedAt) ? st.finishedAt : Date.now();
        const elapsedSec = startedAt ? Math.max(0, Math.floor((endRef - startedAt) / 1000)) : 0;

        // Detail line · numeric progress (extract counter, write word
        // count) takes priority. ETA / elapsed shown in a separate slot.
        const detailParts = [];
        if (key === "extract" && st.progress && st.progress.total) {
          detailParts.push(labels.directorUnit(st.progress.current, st.progress.total));
        } else if (st.detail) {
          detailParts.push(st.detail);
        }
        if (key === "write" && status === "active" && wordCount > 0) {
          detailParts.push(labels.wordUnit(wordCount));
        }
        const detail = detailParts.join(" · ");

        // Timing slot · ETA range while in-band, elapsed once over upper.
        let timing = "";
        if (status === "active" && eta) {
          if (elapsedSec <= eta[1]) {
            timing = `~${eta[0]}–${eta[1]} ${labels.secUnit}`;
            if (elapsedSec > 0) timing = `${elapsedSec} ${labels.secUnit} · ${timing}`;
          } else {
            timing = labels.elapsedFormat(elapsedSec);
          }
        } else if (status === "done" && eta && startedAt) {
          // Final elapsed for done stages — quiet, but useful.
          timing = `${elapsedSec} ${labels.secUnit}`;
        }

        // Substage descriptor · rotates every 3s while active.
        let substage = "";
        if (status === "active" && substages[key]?.length) {
          const list = substages[key];
          const idx = Math.floor(elapsedSec / 3) % list.length;
          substage = list[idx];
        }

        const mark = status === "done"
          ? `<span class="brief-stage-mark done">✓</span>`
          : status === "active"
          ? `<span class="brief-stage-mark active"><span class="brief-stage-pulse"></span></span>`
          : `<span class="brief-stage-mark pending">·</span>`;

        return `
          <div class="brief-stage-row brief-stage-${status}">
            ${mark}
            <div class="brief-stage-content">
              <div class="brief-stage-line">
                <span class="brief-stage-label">${this.escape(labels[key])}</span>
                ${detail ? `<span class="brief-stage-detail">${this.escape(detail)}</span>` : ""}
                ${timing ? `<span class="brief-stage-timing">${this.escape(timing)}</span>` : ""}
              </div>
              ${substage ? `<div class="brief-stage-substage">${this.escape(substage)}</div>` : ""}
            </div>
          </div>
        `;
      };

      return `
        <div class="brief-kicker brief-kicker-pulse">${this.escape(kickerText)}<span class="brief-typing-dots"><i></i><i></i><i></i></span></div>
        <div class="brief-stages">
          ${buildRow("extract")}
          ${buildRow("scaffold")}
          ${buildRow("write")}
        </div>
      `;
    },

    renderBriefBody() {
      // Streaming brief: just refresh the title + filed stamp + open-cta state
      // since the card no longer renders the full markdown body inline.
      // Cheapest path: re-render the whole card.
      this.renderBrief();
    },

    /* Sentence + markdown helpers — shared by the agent-overlay's
       in-room notes view (window.app.firstBoldSegment / firstSentence /
       stripBoldMarkdown / truncateNote / noteTagLabel). */

    firstBoldSegment(body) {
      const re = /\*\*([^*]+?)\*\*/;
      const m = re.exec(body || "");
      return m ? m[1].trim() : null;
    },

    firstSentence(body) {
      if (!body) return "";
      const trimmed = body.trim();
      // Try sentence-ending punctuation, including CJK 。!?
      const m = /^([^.!?。!?\n]{8,}?[.!?。!?])/.exec(trimmed);
      if (m) return m[1].trim();
      // Fallback to first non-empty line.
      const line = trimmed.split(/\n/).find((l) => l.trim().length > 0);
      return (line || trimmed).trim();
    },

    stripBoldMarkdown(body) {
      return (body || "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
    },

    truncateNote(s, n) {
      const t = (s || "").trim();
      if (t.length <= n) return t;
      return t.slice(0, n - 1).trimEnd() + "…";
    },

    /** Map internal tag id → short visible label. */
    noteTagLabel(tag) {
      return ({
        origin:  "input",
        obs:     "obs",
        insight: "claim",
        warn:    "drop",
        crux:    "crux",
        soln:    "pursue",
        open:    "ask",
      })[tag] || tag;
    },

    /** True when the user is "stuck to bottom" — within a small margin
     *  of the latest message. We only auto-scroll when this holds, so
     *  scrolling up to read history isn't interrupted by streaming
     *  tokens or new appends. */
    chatStuckToBottom: true,
    /** Threshold (px) below which the user is treated as following
     *  the live feed. Anything further up means they're reading. */
    CHAT_STICK_THRESHOLD: 96,

    /** Bind a scroll listener once · the listener flips chatStuckToBottom
     *  based on how far from the bottom the user has scrolled. Idempotent —
     *  re-bind is fine since we tag the element. */
    bindChatScrollWatch() {
      const chat = document.querySelector(".chat");
      if (!chat || chat.dataset.scrollWatch === "1") return;
      chat.dataset.scrollWatch = "1";
      const update = () => {
        const dist = chat.scrollHeight - chat.clientHeight - chat.scrollTop;
        this.chatStuckToBottom = dist <= this.CHAT_STICK_THRESHOLD;
      };
      chat.addEventListener("scroll", update, { passive: true });
      update();
    },

    /** Scroll the chat to the bottom. If `force` is omitted/false, the
     *  scroll is gated by chatStuckToBottom — i.e. the auto-scroll only
     *  fires when the user is already following the live feed. */
    scrollChatToBottom(force) {
      const chat = document.querySelector(".chat");
      if (!chat) return;
      if (!force && !this.chatStuckToBottom) return;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          chat.scrollTop = chat.scrollHeight;
          this.chatStuckToBottom = true;
        });
      });
    },

    /** Bring the brief card into view at the top of the chat panel.
     *  Called whenever the user has just triggered a generation
     *  (Adjourn → file brief, Regenerate, Retry, post-hoc generate)
     *  so they see the "Generating…" state appear immediately —
     *  without this, a user who scrolled up to re-read history sees
     *  no visible response to their click. Smooth-scrolls the .chat
     *  container ONLY (not the page), aligning the card's top a bit
     *  below the chat's top so the stage tracker is fully visible. */
    scrollToBriefCard() {
      // Two rAFs · let renderBrief paint + layout settle before measuring.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const chat = document.querySelector(".chat");
          const card = document.querySelector("[data-brief-card]");
          if (!chat || !card) return;
          // Skip the scroll if the card is already comfortably on
          // screen — no need to nudge a user who's looking right at it.
          const cardRect = card.getBoundingClientRect();
          const chatRect = chat.getBoundingClientRect();
          const alreadyVisible =
            cardRect.top >= chatRect.top &&
            cardRect.top <= chatRect.top + chat.clientHeight * 0.5;
          if (alreadyVisible) return;
          const offset = card.offsetTop - chat.offsetTop - 16;
          chat.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
          // Reading the latest content again counts as "following the
          // feed" for subsequent token-stream auto-scroll decisions.
          this.chatStuckToBottom = true;
        });
      });
    },
  };

  // ── DOM-level wiring (delegated; survives re-renders) ──────
  document.addEventListener("click", (e) => {
    // Web Search · click the badge to expand / collapse the source list
    // beneath the bubble.
    const wsBtn = e.target.closest("[data-msg-ws-toggle]");
    if (wsBtn) {
      e.preventDefault();
      const id = wsBtn.getAttribute("data-message-id");
      const panel = document.querySelector(`[data-msg-ws-sources][data-message-id="${id}"]`);
      if (panel) {
        const open = panel.hasAttribute("hidden");
        if (open) panel.removeAttribute("hidden"); else panel.setAttribute("hidden", "");
        wsBtn.classList.toggle("expanded", open);
      }
      return;
    }
    // Pause (live → paused). If a director is mid-stream, ask the user how
    // to pause: stop now / wait / cancel.
    if (e.target.closest("[data-pause]")) {
      e.preventDefault();
      if (app.isAgentSpeaking()) {
        app.openPauseChoiceModal();
      } else {
        app.pauseRoom("hard").catch((err) => alert("Pause failed: " + err.message));
      }
      return;
    }
    // Pause-choice modal buttons
    const choice = e.target.closest("[data-pause-choice]");
    if (choice) {
      e.preventDefault();
      const mode = choice.getAttribute("data-pause-choice");
      app.closePauseChoiceModal();
      if (mode === "cancel") return;
      app.pauseRoom(mode).catch((err) => alert("Pause failed: " + err.message));
      return;
    }
    // Click outside the choice modal closes it
    if (e.target.id === "pause-choice-overlay") {
      app.closePauseChoiceModal();
      return;
    }
    // Resume (paused → live)
    if (e.target.closest("[data-resume]")) {
      e.preventDefault();
      app.resumeRoom().catch((err) => alert("Resume failed: " + err.message));
      return;
    }
    // Export · adjourned-bar action. Browser handles the download
    // natively from the route's Content-Disposition header.
    if (e.target.closest("[data-room-export]")) {
      e.preventDefault();
      if (!app.currentRoomId) return;
      window.location.href = "/api/rooms/" + encodeURIComponent(app.currentRoomId) + "/export.md";
      return;
    }
    // Generate report (post-hoc) — fires from the no-brief card CTA
    // when the user originally skipped the brief but now wants one.
    // Reuses the adjourn overlay's gallery in "generate-brief" mode.
    if (e.target.closest("[data-generate-brief]")) {
      e.preventDefault();
      app.openAdjournOverlay({ mode: "generate-brief" });
      return;
    }
    // Adjourn — terminal state, reachable from the paused footer or
    // the chair's round-end card. Opens an overlay so the user picks
    // the brief format at adjourn-time (or opts out entirely).
    if (e.target.closest("[data-adjourn]") || e.target.closest("[data-adjourn-from-chair]")) {
      e.preventDefault();
      app.cancelContinueCountdown();
      app.openAdjournOverlay();
      return;
    }
    // Adjourn overlay · "skip report" footer button — clicking commits
    // immediately (mark picked + dispatch + close).
    if (e.target.closest("[data-adjourn-skip]")) {
      e.preventDefault();
      const overlay = document.getElementById("adjourn-overlay");
      if (!overlay) return;
      const skip = overlay.querySelector(".adjourn-skip-btn");
      if (skip) skip.classList.add("picked");
      app.submitAdjourn();
      return;
    }
    // Adjourn overlay · confirm.
    if (e.target.closest("[data-adjourn-confirm]")) {
      e.preventDefault();
      app.submitAdjourn();
      return;
    }
    // Adjourn overlay · close (X / cancel / backdrop).
    if (e.target.closest("[data-adjourn-close]")) {
      e.preventDefault();
      app.closeAdjournOverlay();
      return;
    }
    // Brief card · "Add a perspective" → opens the supplement overlay.
    if (e.target.closest("[data-brief-supplement]")) {
      e.preventDefault();
      app.openSupplementOverlay();
      return;
    }
    // Brief card · retry button (zombie / failed brief recovery).
    if (e.target.closest("[data-brief-retry]")) {
      e.preventDefault();
      app.retryBriefGeneration();
      return;
    }
    // Brief card · delete (× on tab, or "Delete report" button).
    const deleteBriefBtn = e.target.closest("[data-brief-delete]");
    if (deleteBriefBtn) {
      e.preventDefault();
      e.stopPropagation();  // don't bubble into the underlying tab-switch handler
      const id = deleteBriefBtn.getAttribute("data-brief-id");
      if (id) app.deleteBriefAt(id);
      return;
    }
    // Brief card · version tab · switch which brief is shown.
    const briefTab = e.target.closest("[data-brief-tab]");
    if (briefTab) {
      e.preventDefault();
      const id = briefTab.getAttribute("data-brief-id");
      const next = (app.currentBriefs || []).find((b) => b.id === id);
      if (next) {
        app.currentBrief = next;
        app.renderBrief();
      }
      return;
    }
    // Supplement overlay · close / cancel / backdrop.
    if (e.target.closest("[data-supplement-close]")) {
      e.preventDefault();
      app.closeSupplementOverlay();
      return;
    }
    // Supplement overlay · confirm.
    if (e.target.closest("[data-supplement-confirm]")) {
      e.preventDefault();
      app.submitSupplement();
      return;
    }
    // Paused-bar · open the supplement overlay (add a thought while paused).
    if (e.target.closest("[data-paused-supplement]")) {
      e.preventDefault();
      app.openPausedSupplementOverlay();
      return;
    }
    // Paused-supplement overlay · close / cancel / backdrop.
    if (e.target.closest("[data-paused-supplement-close]")) {
      e.preventDefault();
      app.closePausedSupplementOverlay();
      return;
    }
    // Paused-supplement overlay · confirm.
    if (e.target.closest("[data-paused-supplement-confirm]")) {
      e.preventDefault();
      app.submitPausedSupplement();
      return;
    }
    // Continue · resume the directors after a chair-driven round-end.
    if (e.target.closest("[data-continue]")) {
      e.preventDefault();
      app.cancelContinueCountdown();
      app.continueRoom().catch((err) => alert("Continue failed: " + err.message));
      return;
    }
    // Manual round-end · ask the chair to wrap and open a vote.
    // Selector is scoped to <button> so it can't accidentally match
    // the round-end-card div (which used to share the attribute name).
    const wrapBtn = e.target.closest("button[data-round-end]");
    if (wrapBtn) {
      e.preventDefault();
      if (wrapBtn.disabled) return;
      // User chose to vote instead of auto-continue — kill the timer.
      app.cancelContinueCountdown();
      app.requestRoundEnd().catch((err) => alert("Wrap failed: " + err.message));
      return;
    }
    // Auto-continue button (queue strip) — same effect as the round-end
    // card's Continue, plus this is also the auto-fire target.
    const autoBtn = e.target.closest("[data-continue-auto]");
    if (autoBtn) {
      e.preventDefault();
      if (autoBtn.disabled) return;
      app.cancelContinueCountdown();
      app.continueRoom().catch((err) => alert("Continue failed: " + err.message));
      return;
    }
    // Vote on a chair key point.
    const kpBtn = e.target.closest("[data-kp-vote]");
    if (kpBtn) {
      e.preventDefault();
      e.stopPropagation();
      const kpId = kpBtn.getAttribute("data-kp-id");
      const vote = kpBtn.getAttribute("data-kp-vote");
      if (kpId && (vote === "up" || vote === "down")) {
        app.cancelContinueCountdown();
        app.voteKeyPoint(kpId, vote);
      }
      return;
    }
    // View Report — link opens /report.html?r=<id> in a new tab; let the
    // anchor handle navigation. No preventDefault.
    // Starter card · empty-state quick-convene. Avatars opt out (their
    // own [data-agent-profile] handler runs via agent-profile.js capture
    // phase). Both the [▶ Start] button and a click anywhere else on the
    // card body fire the starter action.
    const starterAv = e.target.closest("[data-agent-profile]");
    if (starterAv && e.target.closest(".starter-card")) {
      // Let agent-profile.js handle this; don't also start the room.
      return;
    }
    const starterGo = e.target.closest("[data-starter-go]");
    if (starterGo) {
      e.preventDefault();
      const idx = parseInt(starterGo.getAttribute("data-starter-go"), 10);
      const list = window.BOARDROOM_STARTERS || [];
      if (Number.isFinite(idx) && list[idx]) app.createStarterRoom(list[idx]);
      return;
    }
    const starterCard = e.target.closest("[data-starter-idx]");
    if (starterCard) {
      e.preventDefault();
      const idx = parseInt(starterCard.getAttribute("data-starter-idx"), 10);
      const list = window.BOARDROOM_STARTERS || [];
      if (Number.isFinite(idx) && list[idx]) app.createStarterRoom(list[idx]);
      return;
    }
    // ─── New room trigger (sidebar "+ New room" button, etc.) ──────
    // Was bound to the overlay; now just closes any active room so the
    // composer empty state shows. setComposerMode also flips the main
    // view back to "room" if an agent profile is currently visible.
    if (e.target.closest("[data-convene-trigger]")) {
      e.preventDefault();
      app.setComposerMode("room");
      return;
    }
    // ─── New agent trigger (sidebar "+ New agent" button) ──────────
    // Switches to the inline agent composer (AI-first). The "configure
    // manually" link inside the composer opens the legacy overlay.
    if (e.target.closest("[data-agent-composer-trigger]")) {
      e.preventDefault();
      app.setComposerMode("agent");
      return;
    }
    // ─── All Reports · filter chip click (All / Today / This week / Earlier)
    const reportsFilterChip = e.target.closest("[data-reports-filter]");
    if (reportsFilterChip) {
      e.preventDefault();
      const key = reportsFilterChip.getAttribute("data-reports-filter");
      app.setReportsFilter(key);
      return;
    }
    // ─── Agent composer · submit
    if (e.target.closest("[data-agent-composer-go]")) {
      e.preventDefault();
      app.submitAgentComposer();
      return;
    }
    // ─── Agent composer · "configure manually" → open existing overlay
    if (e.target.closest("[data-agent-composer-manual]")) {
      e.preventDefault();
      if (typeof window.openNewAgent === "function") window.openNewAgent();
      return;
    }
    // ─── Agent spec preview · field actions
    if (e.target.closest("[data-agent-spec-reroll]")) {
      e.preventDefault();
      app.rerollAgentSpecAvatar();
      return;
    }
    if (e.target.closest("[data-agent-spec-discard]")) {
      e.preventDefault();
      app.discardAgentSpec();
      return;
    }
    if (e.target.closest("[data-agent-spec-redo]")) {
      e.preventDefault();
      app.redoAgentSpec();
      return;
    }
    if (e.target.closest("[data-agent-spec-save]")) {
      e.preventDefault();
      app.saveAgentSpec();
      return;
    }
    // ─── Composer (no-room landing view) ───────────────────────────
    // "+ pick" → open director popover
    const composerPick = e.target.closest("[data-composer-dir-pick]");
    if (composerPick) {
      e.preventDefault();
      e.stopPropagation();
      app.openComposerDirectorPicker(composerPick);
      return;
    }
    // Director chip × → remove from selection
    const composerDirX = e.target.closest("[data-composer-dir-remove]");
    if (composerDirX) {
      e.preventDefault();
      const id = composerDirX.getAttribute("data-composer-dir-remove");
      app.toggleComposerDirector(id);
      return;
    }
    // Picker rows are toggled via a separate `change` listener (see
    // below) — the checkbox change event fires on both direct
    // checkbox clicks and on label-area clicks (the browser
    // synthesises a checkbox click when the user clicks anywhere
    // inside the wrapping <label>). The click handler here used to
    // ALSO toggle on label clicks, but it skipped checkbox clicks,
    // which left direct-checkbox clicks dead. Owning toggling from
    // the change event is the simpler, correct path.
    if (e.target.closest("[data-composer-pick-done]")) {
      e.preventDefault();
      app.closeComposerDirectorPicker();
      return;
    }
    // Tune dropdown trigger (tone / intensity)
    const ddTrigger = e.target.closest("[data-cmp-dropdown]");
    if (ddTrigger) {
      e.preventDefault();
      e.stopPropagation();
      // Toggle: clicking the open trigger again closes.
      if (ddTrigger.classList.contains("open")) {
        app.closeComposerDropdown();
      } else {
        app.openComposerDropdown(ddTrigger);
      }
      return;
    }
    // Dropdown option pick
    const ddPick = e.target.closest("[data-cmp-dd-pick]");
    if (ddPick) {
      e.preventDefault();
      const kind = ddPick.getAttribute("data-cmp-dd-kind");
      const v = ddPick.getAttribute("data-cmp-dd-pick");
      if (kind === "tone") app.setComposerTone(v);
      else if (kind === "intensity") app.setComposerIntensity(v);
      else if (kind === "agent-model") app.setAgentComposerModel(v);
      app.closeComposerDropdown();
      return;
    }
    // ─── Agent composer · starter prompt → fill textarea
    const agStarter = e.target.closest("[data-agent-starter]");
    if (agStarter) {
      e.preventDefault();
      const idx = parseInt(agStarter.getAttribute("data-agent-starter"), 10);
      app.applyAgentStarter(idx);
      return;
    }
    // Convene button → submit
    if (e.target.closest("[data-composer-go]")) {
      e.preventDefault();
      app.submitComposer();
      return;
    }
    // Starter row → fill composer + scroll into view
    const composerStarter = e.target.closest("[data-composer-starter]");
    if (composerStarter) {
      e.preventDefault();
      const idx = parseInt(composerStarter.getAttribute("data-composer-starter"), 10);
      if (Number.isFinite(idx)) app.applyComposerStarter(idx);
      return;
    }
    // Delete a room (any state): confirm, then real DELETE on the backend.
    const del = e.target.closest("[data-room-delete]");
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      const shell = del.closest(".session-row-shell");
      const id = shell?.dataset.roomId;
      if (id) app.deleteRoom(id);
      return;
    }
    // Delete a custom agent · this used to live as an inline X button
    // on the sidebar row. It's been moved into the agent profile's
    // ⋯ overflow menu (see agent-profile.js → "delete" menu action),
    // so the sidebar handler is gone — the row only navigates now.
  });

  // Send via the input bar · both Enter and the Send button funnel
  // through app.submitFromComposer, which owns the throttle / in-flight
  // / interrupt-or-queue logic in one place.
  //
  // IME guard · while a Chinese / Japanese / Korean input method is
  // composing a character (the user is picking pinyin candidates),
  // Enter confirms the candidate. We must NOT treat that Enter as
  // submit. Browsers signal this via:
  //   · `e.isComposing === true` (standard, all modern browsers)
  //   · `e.keyCode === 229` (legacy fallback for old WebKit / Chromium)
  // Either of those means "this Enter belongs to the IME, leave it
  // alone." Without the guard, every pinyin confirmation accidentally
  // sends the message — a constant misclick for CJK users.
  function isImeComposing(ev) {
    return !!(ev && (ev.isComposing || ev.keyCode === 229));
  }
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    const isInput = target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement);
    // Composer (no-room) Enter → submit, Shift+Enter → newline.
    if (isInput && target.matches('[data-composer-subject]')) {
      if (e.key === "Enter" && !e.shiftKey && !isImeComposing(e)) {
        e.preventDefault();
        app.submitComposer();
      }
      return;
    }
    // Agent composer description Enter → submit, Shift+Enter → newline.
    if (isInput && target.matches('[data-agent-composer-desc]')) {
      if (e.key === "Enter" && !e.shiftKey && !isImeComposing(e)) {
        e.preventDefault();
        app.submitAgentComposer();
      }
      return;
    }
    // Any keypress while focus is on the room's input bar means the
    // user is actively engaging — kill the auto-continue countdown.
    if (isInput && target.matches('.input-bar input, [data-send-input]')) {
      app.cancelContinueCountdown();
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    if (isImeComposing(e)) return;
    if (!isInput) return;
    if (!target.matches('.input-bar input, [data-send-input]')) return;
    e.preventDefault();
    app.submitFromComposer(target);
  });
  // Autosize the composer textarea as the user types · also persist
  // the in-progress draft so switching to another view and coming back
  // restores the user's text instead of wiping it (each renderEmptyState
  // rebuilds the textarea node, so the DOM-level value vanishes; the
  // saved-state path is what survives the re-render).
  document.addEventListener("input", (e) => {
    if (e.target && e.target.matches && e.target.matches("[data-composer-subject]")) {
      const state = app.loadComposerState();
      state.subject = e.target.value;
      app.saveComposerState();
      app.autosizeComposerTextarea();
    } else if (e.target && e.target.matches && e.target.matches("[data-agent-composer-desc]")) {
      app.saveAgentComposerDraft(e.target.value);
      app.autosizeAgentComposerTextarea();
    }
  });
  // Keep agentSpec in sync as the user edits any preview field — guards
  // against partial re-renders dropping the user's pick (esp. modelV,
  // which is a <select> whose `selected` attr only sets the initial
  // option). Reads the field name → field key off the element.
  document.addEventListener("change", (e) => {
    const el = e.target && e.target.closest && e.target.closest("[data-agent-spec-field]");
    if (!el || !app.agentSpec) return;
    const key = el.getAttribute("data-agent-spec-field");
    if (!key) return;
    app.agentSpec[key] = el.value;
    if (key === "modelV" && typeof app.setAgentComposerModel === "function") {
      app.setAgentComposerModel(el.value);
    }
  });

  // Director picker · the checkbox state IS the source of truth. This
  // single change listener handles both interaction paths cleanly:
  //   · click on the checkbox → native toggle → change event
  //   · click on the row label → browser synthesises a checkbox
  //     click → checkbox toggles → change event
  // Either way we end up here once. The avatar and info-button inside
  // each row carry [data-cmp-pick-profile] / [data-agent], whose own
  // listeners stop propagation + prevent default — so clicking those
  // never reaches the label's synthetic-toggle path.
  document.addEventListener("change", (e) => {
    const cb = e.target;
    if (!cb || !cb.matches || !cb.matches('[data-composer-pick-id] input[type="checkbox"]')) return;
    const row = cb.closest("[data-composer-pick-id]");
    const id = row && row.getAttribute("data-composer-pick-id");
    if (id) app.toggleComposerDirector(id);
  });
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-send-button]");
    if (!btn) return;
    e.preventDefault();
    const input = document.querySelector('.input-bar input, [data-send-input]');
    if (!input) return;
    app.submitFromComposer(input);
  });

  // Cancel a queued user message · click ✕ in the speaking queue row.
  document.addEventListener("click", (e) => {
    const cancel = e.target.closest("[data-cancel-user-queued]");
    if (!cancel) return;
    e.preventDefault();
    e.stopPropagation();
    if (!app.pendingUserMessage) return;
    // Restore the text into the composer so the user can edit/resend.
    const input = document.querySelector('.input-bar input, [data-send-input]');
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      if (!input.value.trim()) input.value = app.pendingUserMessage;
    }
    app.pendingUserMessage = null;
    app.pendingForSpeakerId = null;
    app.renderQueue();
  });

  // Send-choice modal · option click + backdrop click + Esc.
  document.addEventListener("click", (e) => {
    const opt = e.target.closest("[data-send-choice]");
    if (opt) {
      e.preventDefault();
      app.handleSendChoice(opt.getAttribute("data-send-choice"));
      return;
    }
    if (e.target.id === "send-choice-overlay") {
      e.preventDefault();
      app.handleSendChoice("cancel");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.getElementById("send-choice-overlay")) {
      app.handleSendChoice("cancel");
    }
  });

  // No-key modal · the requireModelKey gate's "open settings" / "dismiss"
  // CTAs + backdrop click + Esc. Open-settings closes the modal first
  // so it doesn't sit behind the user-settings overlay.
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-no-key-open-settings]")) {
      e.preventDefault();
      app.closeNoKeyModal();
      if (typeof window.openUserSettings === "function") {
        window.openUserSettings({ section: "keys" });
      }
      return;
    }
    if (e.target.closest("[data-no-key-dismiss]")) {
      e.preventDefault();
      app.closeNoKeyModal();
      return;
    }
    if (e.target.id === "no-key-overlay") {
      e.preventDefault();
      app.closeNoKeyModal();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.getElementById("no-key-overlay")) {
      app.closeNoKeyModal();
    }
  });

  // When the tab becomes visible again, immediately probe a stalled
  // brief — the user may have switched away during a long generation
  // and the throttling sleeps held the watch back. The watcher itself
  // also keeps ticking on its 10s interval as a backstop.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (app && app.currentBrief && !app.currentBrief.error) {
      const generating = !app.currentBrief.bodyMd || app.currentBrief.title === "Generating…";
      if (generating) {
        app.ensureBriefStallWatch();
        app.tickBriefStallWatch();
      }
    }
  });

  window.app = app;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => app.init());
  } else {
    app.init();
  }
})();
