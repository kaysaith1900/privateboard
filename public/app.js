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
    "opus-4-6":         "Opus 4.6",
    "opus-4-6-fast":    "Opus 4.6 Fast",
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
    { v: "opus-4-7",         label: "Claude Opus 4.7",      provider: "Anthropic", deck: "deep reasoning" },
    { v: "sonnet-4-6",       label: "Claude Sonnet 4.6",    provider: "Anthropic", deck: "balanced · default" },
    { v: "opus-4-6",         label: "Claude Opus 4.6",      provider: "Anthropic", deck: "prior-gen flagship" },
    { v: "opus-4-6-fast",    label: "Claude Opus 4.6 Fast", provider: "Anthropic", deck: "faster 4.6 · same intelligence" },
    { v: "haiku-4-5",        label: "Claude Haiku 4.5",     provider: "Anthropic", deck: "fast · low-cost" },
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
    /** Error state for the agent composer · { kind: "timeout"|"failed", message }
     *  Rendered as a recovery card with a Retry CTA when set. The
     *  earlier `alert()` UX vanished as soon as it was dismissed; the
     *  card stays so the user can read the error AND retry without
     *  re-typing their description. Cleared by retry / discard / start
     *  of a fresh submission. */
    agentSpecError: null,
    /** AbortController for the in-flight /generate-spec fetch. Used so
     *  the 5-minute hard timeout can cancel both the network request
     *  and the server-side LLM work (the route honours
     *  c.req.raw.signal → propagates to callLLM). */
    _agentGenAbort: null,
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
      // Convene-opener "Show more / less" toggle · doc-level delegate
      // since the opener is re-rendered on every chat repaint and we
      // don't want to re-bind per render. Just flips an `.expanded`
      // class on the .convene-opener parent and swaps the label.
      document.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-convene-toggle]");
        if (!btn) return;
        e.preventDefault();
        const card = btn.closest(".convene-opener");
        if (!card) return;
        const expanded = card.classList.toggle("expanded");
        const label = expanded
          ? (btn.getAttribute("data-less") || "Show less")
          : (btn.getAttribute("data-more") || "Show more");
        btn.textContent = label;
      });
      window.addEventListener("hashchange", () => this.handleRoute());
      this.handleRoute();

      // Sidebar count badges · refresh on boot.
      // Notes: also refreshed on every note:created / note:deleted
      // (handlers below). Reports: refreshed when a brief lands or
      // is deleted (see SSE brief-final / brief-deleted handlers).
      this.refreshNotesCount();
      this.refreshReportsCount();
      document.addEventListener("note:created", (e) => {
        this.refreshNotesCount();
        // Live-update currentNotes for the active room so the new
        // span gets its highlight without waiting for a navigation.
        const note = e && e.detail && e.detail.note;
        if (note && note.roomId === this.currentRoomId) {
          if (!this.currentNotes) this.currentNotes = new Map();
          const arr = this.currentNotes.get(note.messageId) || [];
          arr.push(note);
          this.currentNotes.set(note.messageId, arr);
          this.applyNoteHighlightsForMessage(note.messageId);
        }
      });
      document.addEventListener("note:deleted", (e) => {
        this.refreshNotesCount();
        const detail = e && e.detail;
        if (detail && detail.noteId && this.currentNotes) {
          for (const [mid, arr] of this.currentNotes) {
            const next = arr.filter((n) => n.id !== detail.noteId);
            if (next.length !== arr.length) {
              this.currentNotes.set(mid, next);
              this.applyNoteHighlightsForMessage(mid);
              break;
            }
          }
        }
      });

      // Hover tooltip on `.note-highlight` spans · the native browser
      // `title` attr has a 1–2s delay that feels broken; this custom
      // pop appears immediately. mouseover/mouseout bubble (unlike
      // mouseenter/leave) so a single document-level delegation
      // covers every saved span across every message.
      document.addEventListener("mouseover", (e) => {
        const span = e.target && e.target.closest && e.target.closest(".note-highlight");
        if (!span) return;
        this.showNoteTooltip(span);
      });
      document.addEventListener("mouseout", (e) => {
        const span = e.target && e.target.closest && e.target.closest(".note-highlight");
        if (!span) return;
        // If the pointer is leaving the span entirely (not into a
        // child of the same span), hide.
        const related = e.relatedTarget;
        if (related && span.contains(related)) return;
        this.hideNoteTooltip();
      });
      // Hide on scroll · the tooltip is absolute-positioned, so any
      // scroll would leave it floating in stale coords.
      window.addEventListener("scroll", () => this.hideNoteTooltip(), true);
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
      const hash = location.hash || "";
      const m = hash.match(/^#\/r\/([a-z0-9]+)/i);
      if (m && m[1]) {
        // `?note=<id>` segment in the hash · "jump to this note"
        // payload from the All-Notes view. Parsed BEFORE openRoom so
        // loadRoomNotes can pick it up off `_pendingNoteScroll` once
        // the overlay is painted (see scrollToNote).
        const noteMatch = hash.match(/[?&]note=([a-z0-9]+)/i);
        this._pendingNoteScroll = noteMatch ? noteMatch[1] : null;
        if (this.currentRoomId !== m[1]) {
          this.openRoom(m[1]);
        } else if (this._pendingNoteScroll) {
          // Already in this room · loadRoomNotes wouldn't re-fire
          // for a same-room navigation, so the overlay-paint→scroll
          // path doesn't trigger. Try the scroll directly. If it
          // misses (rare race · notes still mid-paint), keep the
          // flag armed and retry once on a short timer; only clear
          // the flag once the scroll lands a real target.
          const id = this._pendingNoteScroll;
          const ok = this.scrollToNote(id);
          if (ok) {
            this._pendingNoteScroll = null;
          } else {
            setTimeout(() => {
              if (this._pendingNoteScroll === id) {
                this.scrollToNote(id);
                this._pendingNoteScroll = null;
              }
            }, 500);
          }
        }
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
      // All Notes — same pattern as reports. Distinct hash + sidebar
      // active state preserved across refresh.
      if (/^#\/notes$/i.test(location.hash || "")) {
        this.openAllNotes();
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

      // Capture whether this open came from a note jump · this LOCAL
      // is what gates the bottom-of-chat auto-scroll at the bottom
      // of openRoom, NOT the live `_pendingNoteScroll` field. The
      // field gets cleared by applyAllNoteHighlights inside renderRoom
      // when scrollToNote successfully lands on the saved span; if
      // we read the field after renderRoom, it's already null and
      // the guard fails open — the force-scroll-to-bottom fires and
      // snaps the chat to the tail right after the note jump landed.
      // Reading once up front and stashing in a local guarantees the
      // guard reflects intent at entry, not lifecycle state.
      const isNoteJump = !!this._pendingNoteScroll;

      // If a note jump is queued, lock out non-forced auto-scrolls
      // for the entire room-open lifecycle (~4s covers room fetch +
      // notes fetch + chat render + grace). SSE events that arrive
      // on connect — message-token streams, queue-update fan-outs,
      // key-point round-end re-renders — each call scrollChatToBottom()
      // (no force); without this upfront lock, any of them can snap
      // the chat to bottom and override the user's intended jump.
      // Forced scrolls (force=true · the user sending a message)
      // still bypass the lock so user-initiated actions remain immediate.
      if (isNoteJump) {
        this._suppressBottomScrollUntil = Date.now() + 4000;
        // Hide the chat (opacity 0) until scrollToNote lands. Without
        // this, the user sees a brief "stale chat → repaint → scroll
        // to position" transition as a flicker — the previous room's
        // content is still in the DOM when the room view becomes
        // visible, and renderChat + the scroll only finalise after
        // loadRoomNotes resolves. scrollToNote removes the class on
        // success; the 1.2s timer is the safety net so a failed jump
        // never leaves the chat permanently invisible.
        document.body.classList.add("note-jump-loading");
        if (this._noteJumpRevealTimer) clearTimeout(this._noteJumpRevealTimer);
        this._noteJumpRevealTimer = setTimeout(() => {
          document.body.classList.remove("note-jump-loading");
        }, 1200);
      }

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
      const notesView = document.querySelector('[data-main-view="notes"]');
      const roomView = document.querySelector('[data-main-view="room"]');
      const agentView = document.querySelector('[data-main-view="agent"]');
      if (reportsView) reportsView.setAttribute("hidden", "");
      if (notesView)   notesView.setAttribute("hidden", "");
      if (agentView && !agentView.hasAttribute("hidden")) {
        agentView.setAttribute("hidden", "");
        agentView.innerHTML = "";
      }
      if (roomView)    roomView.removeAttribute("hidden");
      document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-notes-trigger].active").forEach((el) => el.classList.remove("active"));

      // Drop conveneState if it belongs to a different room — protects
      // against stale "preparing…" leaking into a sibling room when
      // the user navigates mid-convening.
      if (this.conveneState && this.conveneState.roomId !== roomId) {
        this.conveneState = null;
      }
      // Same protection for the chair-pending placeholder · it's
      // injected directly into [data-chat-messages] which gets rebuilt
      // by renderChat below, but the safety timer would fire later
      // and scan the new room's chat. Cancel timer + drop the node now.
      this.hideChairPending();
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
      // Chairman's notes for this room · fetched in parallel-ish
      // with the room body so the in-room highlight overlay can
      // wrap saved spans on first paint. Stored as a Map keyed by
      // messageId. Failure is silent (the chat still renders, just
      // without highlights).
      //
      // Two paths:
      //   · No pending note jump · fire-and-forget. Chat renders
      //     immediately; highlights paint when notes arrive.
      //   · Pending note jump · AWAIT the load. Without this, the
      //     chat renders at the top, then later jumps to the note —
      //     a visible flicker. Awaiting means renderChat below has
      //     access to the notes map AND can scroll synchronously to
      //     the saved span before the browser paints, so the user
      //     only ever sees the final position.
      this.currentNotes = new Map();
      if (this._pendingNoteScroll) {
        await this.loadRoomNotes(roomId);
      } else {
        this.loadRoomNotes(roomId);
      }
      // Follow-up tree fragment · parent ref (when this room is a
      // continuation) + child rooms (follow-ups other rooms started
      // off of THIS room). Both come from the server's snapshot;
      // empty/null when the room is a standalone session.
      this.currentParentRef = data.parentRef || null;
      this.currentFollowUps = Array.isArray(data.followUps) ? data.followUps : [];
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
        // Walk every brief whose state needs verifying — two cases:
        //   · placeholders (no body / seed title) → could be a zombie
        //     left behind by a server crash mid-stream. checkBriefHealth
        //     flips it into the Retry error UI.
        //   · in-flight (server-stamped `isGenerating: true`) → pipeline
        //     is still running. checkBriefHealth fetches the live stage
        //     snapshot so the loading UI (current stage, ETA, elapsed)
        //     resumes exactly where the previous browser session was.
        // Without the in-flight branch, a mid-stream refresh would land
        // on a partial body + interim title and the card would flip to
        // FILED while tokens were still streaming under it.
        const needsHealth = this.currentBriefs.filter(
          (b) => b && (this.isBriefPlaceholder(b, data.room) || b.isGenerating === true),
        );
        if (needsHealth.length > 0) {
          await Promise.all(needsHealth.map((b) => this.checkBriefHealth(b)));
        }
      }

      document.documentElement.setAttribute("data-status", data.room.status);

      this.renderRoom();
      this.markActiveRoom(roomId);
      this.connectSSE(roomId);
      // Fresh room · force-scroll to the latest message and start
      // the scroll watcher so subsequent auto-scrolls respect the
      // user. Exception: when this open came from a note jump, the
      // saved span is the user's intended target — auto-scrolling
      // to bottom here would land RIGHT AFTER scrollToNote already
      // positioned the chat at the span, snapping it back to the
      // chat tail. We use the captured `isNoteJump` local instead of
      // the live `_pendingNoteScroll` field because applyAllNote-
      // Highlights inside renderRoom above already cleared the field
      // when its scrollToNote succeeded — checking the field here
      // would always pass and the bottom-scroll would fire.
      this.chatStuckToBottom = true;
      if (!isNoteJump) {
        this.scrollChatToBottom(true);
      }
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
      this.currentParentRef = null;
      this.currentFollowUps = [];
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
          // Chair-pending placeholder · clear the moment ANY agent
          // message lands (chair OR director). The placeholder is a
          // stand-in while the chair did silent server-side work
          // (haiku gates, picker, tools, LLM startup); whichever
          // bubble shows up next is the right replacement. We used to
          // gate on `authorId === currentChair.id`, but the next-
          // speaker picker case ends with EITHER a chair intervention
          // OR a director turn — only the chair-restricted clear left
          // the placeholder lingering when the picker decided no
          // intervention was needed.
          if (data.authorKind === "agent") {
            this.hideChairPending();
          }
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
          // Drop any in-flight chair-pending placeholder · the chair's
          // pipeline failed (typically chair-llm-failed) so no bubble
          // is coming to replace it.
          this.hideChairPending();
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
          // Refetch the full room state so the session-analytics card
          // sees up-to-date per-message meta (especially `tokens`,
          // which is mutated server-side during streaming but never
          // re-sent over SSE). Without this, the in-memory
          // `currentMessages` retains the streaming-time meta — no
          // tokens field — so the analytics totals always read 0
          // until a hard refresh. Refetch + renderRoom() also paints
          // the analytics card itself (renderHeader alone doesn't).
          const rid = this.currentRoomId;
          if (rid) {
            (async () => {
              try {
                const r = await fetch("/api/rooms/" + encodeURIComponent(rid));
                if (r.ok) {
                  const data = await r.json();
                  if (this.currentRoomId === rid) {
                    this.currentMessages = data.messages || this.currentMessages;
                    if (data.room) this.currentRoom = data.room;
                    this.renderRoom();
                  }
                }
              } catch (e) { /* analytics card just stays empty · non-fatal */ }
            })();
          }
        } else if (kind === "brief-started") {
          this.markBriefEvent();
          const newBrief = {
            id: payload.briefId,
            title: "Generating…",
            bodyMd: "",
            style: payload.style || "mckinsey",
            // Carry the supplement so the tab strip can render the
            // in-progress brief with its supplement label ("xxx 视角")
            // immediately, instead of waiting for brief-final to
            // refetch and label it.
            supplement: typeof payload.supplement === "string" && payload.supplement.trim()
              ? payload.supplement.trim()
              : "",
            // Chair name + language carried for the generating-state kicker
            // ("{Chair} is preparing the minutes…") and stage labels. The
            // language is inferred server-side from the room subject.
            chairName: payload.chairName || (this.currentChair?.name) || "Chair",
            language: payload.language === "zh" ? "zh" : "en",
            pipelineStartedAt: Date.now(),
            createdAt: Date.now(),
            // Stage checklist · seeded with all seven stages in pending
            // state (extract / compose / 4 scaffold sub-stages / write).
            // brief-stage events flip them active → done as the pipeline
            // progresses. startedAt is captured when each stage first
            // becomes active so the UI can display elapsed time
            // alongside the ETA range.
            stages: {
              extract:             { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              compose:             { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              "scaffold-anchor":   { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              "scaffold-findings": { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              "scaffold-cluster":  { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              "scaffold-actions":  { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              write:               { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
            },
          };
          this.currentBrief = newBrief;
          // Insert the in-progress brief into currentBriefs so the tab
          // strip renders it alongside any prior reports. Without this,
          // a user regenerating from a 2-brief room would see only the
          // two old tabs (none active, since the new in-progress brief
          // had no tab entry of its own) — reading as "the existing
          // reports disappeared". Replacing-by-id keeps idempotency
          // when SSE events redeliver.
          if (!Array.isArray(this.currentBriefs)) this.currentBriefs = [];
          const dupIdx = this.currentBriefs.findIndex((b) => b && b.id === newBrief.id);
          if (dupIdx >= 0) this.currentBriefs[dupIdx] = newBrief;
          else this.currentBriefs.push(newBrief);
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
          // Target the brief by id, NOT by `currentBrief`. The user
          // may have switched tabs to a finished brief while a
          // different one is still streaming — without id-targeting,
          // every brief-* event gets misapplied to whichever brief
          // happens to be currently viewed.
          const target = this._briefById(payload.briefId);
          if (target) {
            const st = target.stages || (target.stages = {
              extract:             { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              compose:             { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              "scaffold-anchor":   { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              "scaffold-findings": { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              "scaffold-cluster":  { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              "scaffold-actions":  { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              write:               { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
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
            // Re-render only when the user is actually viewing this
            // brief's tab; otherwise the stage update lands silently on
            // the off-tab brief and shows up if the user switches back.
            if (this.currentBrief && this.currentBrief.id === target.id) {
              this.renderBrief();
            }
            // Stage tick keeps running regardless of which tab is
            // visible — it's a global animation driver.
            this.ensureBriefStageTick();
          }
        } else if (kind === "brief-extract-harvest") {
          // One per director · the orchestrator fires this when the
          // extract stage completes for a single director, carrying
          // the parsed signal counts. The stat row uses the harvest
          // to render real chips ("Marie Curie · 7 · top: risk")
          // instead of placeholder name-only chips. Stored on the
          // brief object so renderBriefStages can pull it on each
          // tick without re-fetching.
          this.markBriefEvent();
          const target = this._briefById(payload.briefId);
          if (target) {
            const list = target.extractHarvest || (target.extractHarvest = []);
            // Replace any existing entry for this director (idempotent
            // under retries) rather than duplicate.
            const idx = list.findIndex((h) => h.directorId === payload.directorId);
            const entry = {
              directorId: payload.directorId,
              directorName: payload.directorName,
              total: payload.total | 0,
              byKind: payload.byKind || {},
              topKind: payload.topKind || null,
            };
            if (idx >= 0) list[idx] = entry;
            else list.push(entry);
            if (this.currentBrief && this.currentBrief.id === target.id) {
              this.renderBrief();
            }
          }
        } else if (kind === "brief-token") {
          this.markBriefEvent();
          // Append tokens to the brief identified by payload.briefId,
          // NEVER blindly to currentBrief. The bug this prevents:
          // user has brief A (completed) + brief B (in-flight),
          // switches tab to A while B is still streaming, and B's
          // tokens get appended to A's bodyMd — making A look like
          // it's generating too. The id-targeted path keeps each
          // brief's body isolated regardless of which tab is open.
          const target = this._briefById(payload.briefId);
          if (target) {
            target.bodyMd = (target.bodyMd || "") + (payload.delta || "");
            // Throttle re-renders to once per ~250ms so the writing-
            // stage word count animates without thrashing on every
            // chunk. Skip render entirely when the streaming brief
            // isn't the active tab — its body still updates in
            // memory; the visible card just doesn't repaint.
            if (this.currentBrief && this.currentBrief.id === target.id) {
              const now = Date.now();
              if (!this._briefTokenLastRender || (now - this._briefTokenLastRender) > 250) {
                this._briefTokenLastRender = now;
                this.renderBrief();
              }
            }
          }
        } else if (kind === "brief-final") {
          this.markBriefEvent();
          const target = this._briefById(payload.briefId);
          if (target) {
            target.title = payload.title || target.title;
            // Pipeline is done · clear the in-flight flag so the card
            // flips to FILED immediately. The follow-up /briefs refetch
            // would also bring this back as false (server-stamped), but
            // setting it now avoids a one-frame "still generating" flash
            // between this re-render and the refetch landing.
            target.isGenerating = false;
          }
          this.stopBriefStageTick();
          this.stopBriefStallWatch();
          // Re-render only the active tab; the off-tab brief just
          // updates state. The /api/rooms/:id/briefs refetch below
          // is the source of truth either way.
          if (this.currentBrief && target && this.currentBrief.id === target.id) {
            this.renderBrief();
          }
          this.renderHeader();
          // A new brief just landed → bump the All Reports badge.
          this.refreshReportsCount();
          // Refresh the FULL brief list so the tab strip picks up the
          // newly filed brief (including any "add a perspective"
          // regenerations). Active brief = the just-finalised one.
          if (this.currentRoomId) {
            fetch("/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/briefs")
              .then((r) => (r.ok ? r.json() : null))
              .then((j) => {
                if (j && Array.isArray(j.briefs)) {
                  // MERGE — don't clobber. Server briefs carry persisted
                  // fields (title, bodyMd, supplement, components, …) but
                  // not the UI-only `stages` field (which is streamed via
                  // `brief-stage` SSE events and lives only in memory).
                  // A naive `currentBriefs = j.briefs` wipes the loading
                  // state of any brief still mid-pipeline — the user
                  // bug "switch tabs and the stage display resets to
                  // stage 1" happens when a refetch lands while brief
                  // #2 is in scaffold + brief #1 just finalised. We
                  // merge by id, preferring the server's persisted
                  // fields and the in-memory UI-only fields.
                  const existing = new Map((this.currentBriefs || []).map((b) => [b.id, b]));
                  this.currentBriefs = j.briefs.map((sb) => {
                    const prev = existing.get(sb.id);
                    if (!prev) return sb;
                    // bodyMd: prefer in-memory when it's longer (the
                    // server may not have flushed the latest token batch
                    // yet, and we don't want to truncate the streaming
                    // body just because the refetch landed mid-stream).
                    const memBody = prev.bodyMd || "";
                    const srvBody = sb.bodyMd || "";
                    const bodyMd = memBody.length > srvBody.length ? memBody : srvBody;
                    return {
                      ...sb,
                      bodyMd,
                      // UI-only state — preserve in-memory.
                      stages: prev.stages,
                      error: prev.error,
                      interrupted: prev.interrupted,
                      timedOut: prev.timedOut,
                      language: sb.language || prev.language,
                      chairName: sb.chairName || prev.chairName,
                      pipelineStartedAt: prev.pipelineStartedAt,
                    };
                  });
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
          // Same id-targeting rule · the failure attaches to the brief
          // it actually belongs to, not to whichever brief the user
          // happens to be looking at.
          const target = this._briefById(payload.briefId);
          if (target) {
            target.error = payload.message;
            target.isGenerating = false;
          }
          this.stopBriefStageTick();
          this.stopBriefStallWatch();
          if (this.currentBrief && target && this.currentBrief.id === target.id) {
            this.renderBrief();
          }
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
              // Mirror the chair's tone-shift proposal onto the message
              // meta so roundEndCardHtml can render the callout. Without
              // this the data only lives in the SSE payload and the
              // callout never appears until a page reload.
              if (payload.modeShiftProposal) {
                m.meta.modeShiftProposal = payload.modeShiftProposal;
              }
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
          // Skip-clarify path: chair decided no question needed and
          // released directors. No chair bubble is coming, so clear any
          // pending placeholder ourselves.
          this.hideChairPending();
        } else if (kind === "chair-pending") {
          // Chair is preparing (silent phase: haiku gate, pre-tools,
          // LLM startup). Show a transient placeholder so the user has
          // visible feedback until the real chair bubble arrives.
          this.showChairPending(payload?.phase || "");
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

    /* ─── Convene Follow-up · overlay + submit ─────────────────────
     *
     *  Opens a modal that takes the user's new question for a
     *  follow-up room and starts it via POST /api/rooms with
     *  parentRoomId / parentBriefId set. Defaults are tuned to "the
     *  user wants to keep going" — same cast as the parent, same
     *  tone + intensity. Both are overrideable via the form.
     *
     *  After successful create, navigates to the new room. The new
     *  room's chair clarify + first tick fire server-side; the
     *  follow-up's directors get the parent brief + Stage-1 signals
     *  prepended to their system prompts (see room.ts orchestrator). */
    openFollowUpOverlay() {
      if (!this.currentRoomId || !this.currentRoom) return;
      if (this.currentRoom.status !== "adjourned") return;
      this.closeFollowUpOverlay();

      const lang = this.composerLanguage();
      const t = lang === "zh"
        ? {
            classify: "follow-up · 跟进会议",
            classifyRight: "// continuing",
            title: "开一场跟进会议",
            metaPrefix: "// following up",
            placeholder: "在上一场判断之上，下一个要追问的问题是什么？",
            contextNote: "上一场的议题、最终判断（brief）和每位 director 的关键观察会作为这场 follow-up 房间的上下文交给新一组 director —— 他们可以直接在已成型的判断上推进，不会从零开始。",
            castLabel: "Directors",
            castHint: "建议 2-4 位",
            castSame: "沿用上一场的 cast",
            pickerLabel: "选择董事",
            autoLabel: "directors",
            autoVal: "自动挑选",
            countersDirectors: (n) => `${n} 位董事`,
            toneLabel: "Tone",
            intensityLabel: "Intensity",
            cancel: "[ Cancel ]",
            confirm: "[ Convene → ]",
            confirmBusy: "[ Convening… ]",
            adjournedAtPrefix: "adjourned",
            briefsCount: (n) => `${n} ${n === 1 ? "brief" : "briefs"} filed`,
            noBrief: "no brief filed",
          }
        : {
            classify: "follow-up · continuation room",
            classifyRight: "// continuing",
            title: "Convene a follow-up",
            metaPrefix: "// following up",
            placeholder: "What's the next question to chase, given what the prior session settled?",
            contextNote: "The prior subject, the filed brief (room's settled judgement), and each director's load-bearing observations are bundled as context for this follow-up — the new cast picks up where the prior session left off rather than starting from scratch.",
            castLabel: "Directors",
            castHint: "2–4 recommended",
            castSame: "Same cast as last session",
            pickerLabel: "Pick directors",
            autoLabel: "directors",
            autoVal: "auto-pick",
            countersDirectors: (n) => `${n} director${n === 1 ? "" : "s"}`,
            toneLabel: "Tone",
            intensityLabel: "Intensity",
            cancel: "[ Cancel ]",
            confirm: "[ Convene → ]",
            confirmBusy: "[ Convening… ]",
            adjournedAtPrefix: "adjourned",
            briefsCount: (n) => `${n} ${n === 1 ? "brief" : "briefs"} filed`,
            noBrief: "no brief filed",
          };

      const room = this.currentRoom;
      const briefCount = Array.isArray(this.currentBriefs) ? this.currentBriefs.length : 0;
      const briefLine = briefCount > 0 ? t.briefsCount(briefCount) : t.noBrief;
      const adjournedLine = room.adjournedAt
        ? `${t.adjournedAtPrefix} ${this.timeFmt(room.adjournedAt)}`
        : "";
      const subjectShort = (room.subject || "(no subject)").slice(0, 140);

      // Tone + intensity inherit from parent. Trigger uses the same
      // `.cmp-dd` markup as the new-room composer's toolbar buttons —
      // option list, popover, and styling are all shared via the
      // existing `data-cmp-dropdown` machinery. The follow-up flow
      // simply scopes writes to the trigger itself (see global click
      // handler) instead of the composerState used by the inline
      // composer.
      const inheritedMode = (room.mode || "constructive").toLowerCase();
      const inheritedIntensity = (room.intensity || "sharp").toLowerCase();

      // Default cast · same as parent. We freeze the parent member ids
      // here so subsequent room state changes (which shouldn't happen
      // since parent is adjourned) don't leak in.
      const parentDirectorIds = (this.currentMembers || [])
        .filter((m) => m && m.id)
        .map((m) => m.id);
      const parentBriefId = this.currentBrief?.id || "";

      // Cast state for THIS overlay session · scoped to the app
      // object so the picker popover (which lives outside the overlay
      // DOM) and the cast-button refresh helpers can share state.
      // Default mirrors the inline new-room composer: auto-pick on,
      // no manual picks. The "Same cast" checkbox is its own gate
      // that supersedes both when enabled.
      this._followupCastState = {
        sameAsLast: false,
        directorIds: [],
        autoPick: true,
        parentDirectorIds: parentDirectorIds.slice(),
        lang,
      };

      const html = `
        <div class="supplement-overlay" id="followup-overlay" role="dialog" aria-modal="true">
          <div class="supplement-backdrop" data-followup-close></div>
          <div class="supplement-modal followup-modal" role="document">
            <div class="supplement-classification">
              <span><span class="dot">●</span> ${this.escape(t.classify)}</span>
              <span class="right">${this.escape(t.classifyRight)}</span>
            </div>
            <header class="supplement-head">
              <div>
                <div class="meta">${this.escape(t.metaPrefix)} · <span>Room #${this.escape(String(room.number))}</span></div>
                <div class="title">${this.escape(t.title)}</div>
              </div>
              <button type="button" class="supplement-close" data-followup-close aria-label="Close">✕</button>
            </header>
            <div class="supplement-body">
              <div class="followup-parent-card">
                <div class="followup-parent-subject">${this.escape(subjectShort)}</div>
                <div class="followup-parent-meta">${this.escape(adjournedLine)}${adjournedLine && briefLine ? " · " : ""}${this.escape(briefLine)}</div>
                <div class="followup-parent-note">${this.escape(t.contextNote)}</div>
              </div>

              <label class="followup-field">
                <span class="followup-field-label">// new question</span>
                <textarea
                  class="supplement-input"
                  data-followup-subject
                  rows="3"
                  placeholder="${this.escape(t.placeholder)}"></textarea>
              </label>

              <div class="followup-field">
                <div class="followup-cast-row cmp-tune">
                  <button
                    type="button"
                    class="cmp-cast-btn cmp-cast-btn-auto followup-cast-btn"
                    data-followup-cast-btn
                    title="${this.escape(t.pickerLabel)}"
                  >
                    <span class="cmp-cast-stack cmp-cast-stack-auto">
                      <span class="cmp-cast-auto-mark">✦</span>
                    </span>
                    <span class="cmp-cast-count cmp-cast-auto-label">
                      <span class="cmp-cast-auto-key">${this.escape(t.autoLabel)}</span>
                      <span class="cmp-cast-auto-val">${this.escape(t.autoVal)}</span>
                    </span>
                  </button>
                  <span class="followup-cast-row-sep" aria-hidden="true"></span>
                  <button type="button" class="cmp-dd" data-cmp-dropdown="tone" title="${this.escape(t.toneLabel)}">
                    <span class="cmp-dd-label">tone</span>
                    <span class="cmp-dd-value" data-cmp-dd-value="tone">${this.escape(inheritedMode)}</span>
                    <span class="cmp-dd-chevron">▾</span>
                  </button>
                  <button type="button" class="cmp-dd" data-cmp-dropdown="intensity" title="${this.escape(t.intensityLabel)}">
                    <span class="cmp-dd-label">intensity</span>
                    <span class="cmp-dd-value" data-cmp-dd-value="intensity">${this.escape(inheritedIntensity)}</span>
                    <span class="cmp-dd-chevron">▾</span>
                  </button>
                </div>
                <label class="followup-checkbox">
                  <input type="checkbox" data-followup-same-cast${parentDirectorIds.length === 0 ? " disabled" : ""}>
                  <span>${this.escape(t.castSame)}</span>
                </label>
              </div>
            </div>
            <footer class="supplement-foot">
              <button type="button" class="supplement-cancel" data-followup-close>${this.escape(t.cancel)}</button>
              <button
                type="button"
                class="supplement-confirm"
                data-followup-confirm
                data-busy-label="${this.escape(t.confirmBusy)}"
                data-parent-room-id="${this.escape(this.currentRoomId)}"
                data-parent-brief-id="${this.escape(parentBriefId)}"
                data-parent-director-ids="${this.escape(parentDirectorIds.join(","))}"
              >${this.escape(t.confirm)}</button>
            </footer>
          </div>
        </div>
      `;

      const wrap = document.createElement("div");
      wrap.innerHTML = html.trim();
      document.body.appendChild(wrap.firstChild);
      document.body.style.overflow = "hidden";

      // "Same cast as last session" checkbox · supersedes the picker
      // when checked. Toggle disables the cast button and stamps
      // visual state via [data-locked]. Scoped to the overlay element
      // so listeners are GC'd when the modal is removed.
      const overlayEl = document.getElementById("followup-overlay");
      if (overlayEl) {
        const sameCheckbox = overlayEl.querySelector("[data-followup-same-cast]");
        const castBtn = overlayEl.querySelector("[data-followup-cast-btn]");
        if (sameCheckbox && castBtn) {
          sameCheckbox.addEventListener("change", () => {
            const checked = !!sameCheckbox.checked;
            this._followupCastState.sameAsLast = checked;
            if (checked) {
              castBtn.setAttribute("disabled", "");
              castBtn.setAttribute("data-locked", "same-cast");
              this.closeFollowUpCastPicker();
            } else {
              castBtn.removeAttribute("disabled");
              castBtn.removeAttribute("data-locked");
            }
            this.refreshFollowUpCastButton();
          });
        }
      }

      this._followupEsc = (ev) => {
        if (ev.key === "Escape") {
          ev.stopImmediatePropagation();
          this.closeFollowUpOverlay();
        }
      };
      document.addEventListener("keydown", this._followupEsc, true);
      // Cmd/Ctrl-Enter submits the form from the textarea.
      this._followupSubmit = (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
          const overlay = document.getElementById("followup-overlay");
          if (!overlay) return;
          ev.preventDefault();
          this.submitFollowUp();
        }
      };
      document.addEventListener("keydown", this._followupSubmit, true);
      setTimeout(() => {
        const input = document.querySelector("[data-followup-subject]");
        if (input) input.focus();
      }, 30);
    },

    closeFollowUpOverlay() {
      const el = document.getElementById("followup-overlay");
      if (el) el.remove();
      document.body.style.overflow = "";
      if (this._followupEsc) {
        document.removeEventListener("keydown", this._followupEsc, true);
        this._followupEsc = null;
      }
      if (this._followupSubmit) {
        document.removeEventListener("keydown", this._followupSubmit, true);
        this._followupSubmit = null;
      }
      this.closeFollowUpCastPicker();
      this._followupCastState = null;
    },

    /** Cast button refresher · re-renders the inner content of the
     *  follow-up overlay's `.cmp-cast-btn` based on current state.
     *  Mirrors the inline new-room composer's cast-button pattern:
     *  auto-pick chip when no manual picks AND not "same as last",
     *  avatar stack + count when manually picked, "same cast" chip
     *  when the checkbox is on (the button is also disabled in that
     *  case · see the change handler). */
    refreshFollowUpCastButton() {
      const btn = document.querySelector("[data-followup-cast-btn]");
      if (!btn || !this._followupCastState) return;
      const state = this._followupCastState;
      const lang = state.lang || "en";

      btn.classList.remove("cmp-cast-btn-auto");
      btn.removeAttribute("data-cast-mode");

      if (state.sameAsLast) {
        // "Same cast as last session" · show parent's avatar stack,
        // disabled appearance. The button stays click-blocked via
        // the `disabled` attribute set in the checkbox change handler.
        const parents = state.parentDirectorIds
          .map((id) => this.agentsById?.[id])
          .filter(Boolean);
        const visible = parents.slice(0, 4);
        const overflow = Math.max(0, parents.length - 4);
        const avatars = visible.map((a) =>
          `<img class="cmp-cast-av" src="${this.escape(a.avatarPath || "")}" alt="${this.escape(a.name || "")}" title="${this.escape(a.name || "")}">`,
        ).join("");
        const count = lang === "zh"
          ? `${parents.length} 位 · 沿用上一场`
          : `${parents.length} · same as last`;
        btn.innerHTML =
          `<span class="cmp-cast-stack">${avatars}${overflow > 0 ? `<span class="cmp-cast-more">+${overflow}</span>` : ""}</span>` +
          `<span class="cmp-cast-count">${this.escape(count)}</span>`;
        btn.setAttribute("data-cast-mode", "same-as-last");
        return;
      }

      const picked = state.directorIds
        .map((id) => this.agentsById?.[id])
        .filter(Boolean);

      if (picked.length === 0) {
        // Auto-pick · default
        btn.classList.add("cmp-cast-btn-auto");
        btn.setAttribute("data-cast-mode", "auto");
        const autoKey = lang === "zh" ? "directors" : "directors";
        const autoVal = lang === "zh" ? "自动挑选" : "auto-pick";
        btn.innerHTML =
          `<span class="cmp-cast-stack cmp-cast-stack-auto"><span class="cmp-cast-auto-mark">✦</span></span>` +
          `<span class="cmp-cast-count cmp-cast-auto-label">` +
            `<span class="cmp-cast-auto-key">${this.escape(autoKey)}</span>` +
            `<span class="cmp-cast-auto-val">${this.escape(autoVal)}</span>` +
          `</span>`;
        return;
      }

      const visible = picked.slice(0, 4);
      const overflow = Math.max(0, picked.length - 4);
      const avatars = visible.map((a) =>
        `<img class="cmp-cast-av" src="${this.escape(a.avatarPath || "")}" alt="${this.escape(a.name || "")}" title="${this.escape(a.name || "")}">`,
      ).join("");
      const countText = lang === "zh"
        ? `${picked.length} 位董事`
        : `${picked.length} director${picked.length === 1 ? "" : "s"}`;
      btn.setAttribute("data-cast-mode", "manual");
      btn.innerHTML =
        `<span class="cmp-cast-stack">${avatars}${overflow > 0 ? `<span class="cmp-cast-more">+${overflow}</span>` : ""}<span class="cmp-cast-add" aria-hidden="true">+</span></span>` +
        `<span class="cmp-cast-count">${this.escape(countText)}</span>`;
    },

    /** Open the director picker for the follow-up overlay. Mirrors
     *  the inline composer's `openComposerDirectorPicker` visually
     *  (`composer-pick-pop` + `composer-pick-row`) but reads / writes
     *  through `_followupCastState` instead of composerState. */
    openFollowUpCastPicker(anchorBtn) {
      this.closeFollowUpCastPicker();
      if (!anchorBtn || !this._followupCastState) return;
      if (this._followupCastState.sameAsLast) return;   // disabled when "same cast" is on
      const state = this._followupCastState;
      const lang = state.lang || "en";
      const dirs = (this.agents || [])
        .filter((a) => a.roleKind !== "moderator")
        .slice()
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      const t = lang === "zh"
        ? { title: "选择董事", hint: "建议 2-4 位", info: "查看资料" }
        : { title: "Pick directors", hint: "2-4 recommended", info: "View profile" };
      const rows = dirs.map((a) => {
        const checked = state.directorIds.includes(a.id);
        return `
          <label class="composer-pick-row${checked ? " on" : ""}" data-followup-pick-id="${this.escape(a.id)}">
            <input type="checkbox" ${checked ? "checked" : ""}>
            <img class="composer-pick-av" src="${this.escape(a.avatarPath || "")}" alt="${this.escape(a.name || "")}">
            <span class="composer-pick-main">
              <span class="composer-pick-name">${this.escape(a.name || "")}</span>
              <span class="composer-pick-tag">${this.escape(a.roleTag || "")}</span>
            </span>
          </label>
        `;
      }).join("");
      const pop = document.createElement("div");
      pop.id = "followup-pick-pop";
      pop.className = "composer-pick-pop";
      pop.innerHTML = `
        <div class="composer-pick-head">
          <span class="composer-pick-title">${this.escape(t.title)}</span>
          <span class="composer-pick-hint">${this.escape(t.hint)}</span>
        </div>
        <div class="composer-pick-list">${rows || `<div class="composer-pick-empty">no directors</div>`}</div>
      `;
      document.body.appendChild(pop);
      const r = anchorBtn.getBoundingClientRect();
      pop.style.left = Math.max(8, r.left) + "px";
      pop.style.top = (r.bottom + 6) + "px";
      // Outside-click + Esc dismiss · same pattern as the inline
      // composer's picker.
      this._followupPickEsc = (ev) => {
        if (ev.key === "Escape") {
          ev.stopImmediatePropagation();
          this.closeFollowUpCastPicker();
        }
      };
      this._followupPickOutside = (ev) => {
        if (
          !pop.contains(ev.target)
          && !ev.target.closest("[data-followup-cast-btn]")
        ) {
          this.closeFollowUpCastPicker();
        }
      };
      document.addEventListener("keydown", this._followupPickEsc, true);
      setTimeout(() => document.addEventListener("click", this._followupPickOutside, true), 0);
    },

    closeFollowUpCastPicker() {
      const el = document.getElementById("followup-pick-pop");
      if (el) el.remove();
      if (this._followupPickEsc) {
        document.removeEventListener("keydown", this._followupPickEsc, true);
        this._followupPickEsc = null;
      }
      if (this._followupPickOutside) {
        document.removeEventListener("click", this._followupPickOutside, true);
        this._followupPickOutside = null;
      }
    },

    /** Toggle a director in / out of the follow-up overlay's manual
     *  pick list. Updates state, refreshes the picker row visual,
     *  and re-renders the cast button. */
    toggleFollowUpCastDirector(id) {
      if (!this._followupCastState) return;
      const state = this._followupCastState;
      const i = state.directorIds.indexOf(id);
      if (i >= 0) state.directorIds.splice(i, 1);
      else state.directorIds.push(id);
      state.autoPick = state.directorIds.length === 0;
      // Update the row in the picker.
      const row = document.querySelector(`[data-followup-pick-id="${CSS.escape(id)}"]`);
      if (row) {
        const cb = row.querySelector("input[type=checkbox]");
        const on = state.directorIds.includes(id);
        if (cb) cb.checked = on;
        row.classList.toggle("on", on);
      }
      this.refreshFollowUpCastButton();
    },

    async submitFollowUp() {
      const overlay = document.getElementById("followup-overlay");
      if (!overlay) return;
      const subjectInput = overlay.querySelector("[data-followup-subject]");
      const subject = subjectInput ? (subjectInput.value || "").trim() : "";
      if (!subject) {
        if (subjectInput) subjectInput.focus();
        return;
      }
      const btn = overlay.querySelector("[data-followup-confirm]");
      const origLabel = btn ? btn.textContent : "";
      const busyLabel = btn ? btn.getAttribute("data-busy-label") || origLabel : "";
      if (btn) { btn.disabled = true; btn.textContent = busyLabel; }

      const parentRoomId = btn ? btn.getAttribute("data-parent-room-id") : "";
      const parentBriefId = btn ? btn.getAttribute("data-parent-brief-id") : "";

      // Tone + intensity now live as `.cmp-dd` triggers · the canonical
      // value is the value-span text content (lowercase keyword).
      const toneText = overlay.querySelector('[data-cmp-dd-value="tone"]')?.textContent;
      const intensityText = overlay.querySelector('[data-cmp-dd-value="intensity"]')?.textContent;
      const tone = (toneText || "constructive").trim().toLowerCase();
      const intensity = (intensityText || "sharp").trim().toLowerCase();

      const castState = this._followupCastState || { sameAsLast: false, directorIds: [], parentDirectorIds: [] };
      const payload = {
        subject,
        mode: tone,
        intensity,
        parentRoomId,
        parentBriefId: parentBriefId || undefined,
      };
      if (castState.sameAsLast && castState.parentDirectorIds.length > 0) {
        // "Same cast as last session" · use parent's directors verbatim.
        payload.agentIds = castState.parentDirectorIds.slice();
        payload.autoPick = false;
      } else if (castState.directorIds.length > 0) {
        // Manual picks via the popover.
        payload.agentIds = castState.directorIds.slice();
        payload.autoPick = false;
      } else {
        // No same-cast lock + no manual picks · fall through to auto-pick.
        payload.autoPick = true;
        payload.agentIds = [];
      }

      try {
        if (!(await this.requireModelKey())) {
          if (btn) { btn.disabled = false; btn.textContent = origLabel; }
          return;
        }
        const r = await fetch("/api/rooms", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || ("HTTP " + r.status));
        }
        const j = await r.json();
        const newRoomId = j.room?.id;
        this.closeFollowUpOverlay();
        if (newRoomId) {
          // Refresh the sidebar so the new room shows up immediately,
          // then navigate.
          await this.refreshRoomsList?.();
          this.navigateToRoom(newRoomId);
        }
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = origLabel; }
        alert("Convene failed: " + (e && e.message ? e.message : e));
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
      // Frontend in-flight guard · without this, a slow server roundtrip
      // gives the user time to click confirm twice (or to close+reopen
      // the overlay and click again). Each click was firing its own POST,
      // and the server was happily creating multiple parallel briefs —
      // the symptom was a tab strip with two-or-three "Generating…" tiles
      // for what should have been a single regeneration.
      if (this._supplementInFlight) return;
      this._supplementInFlight = true;
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
        // DO NOT mutate the existing currentBrief — the route ALWAYS
        // inserts a new brief row, so wiping the prior brief's bodyMd
        // and title in-place corrupts a perfectly good finished brief
        // into a "Generating…" zombie (its tab stays stuck on loading
        // forever because no SSE will ever update that id). The
        // brief-started SSE for the NEW brief id arrives shortly and
        // appends it via the dedup path; the previous brief stays
        // visible as a finished tab next to the new generating one.
        this.closeSupplementOverlay();
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = orig; }
        alert("Regenerate failed: " + (e && e.message ? e.message : e));
      } finally {
        this._supplementInFlight = false;
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

    /** Find a brief object by id across both `currentBrief` and
     *  `currentBriefs[]`. Used by the SSE handlers (brief-stage /
     *  brief-token / brief-final / brief-error) so streamed updates
     *  land on the correct brief regardless of which tab the user
     *  is currently viewing — without this targeting, switching to
     *  a finished tab while another brief is mid-generation would
     *  pipe the in-flight tokens into the finished brief's body
     *  and make it look like it's generating too. */
    _briefById(briefId) {
      if (!briefId) return null;
      if (this.currentBrief && this.currentBrief.id === briefId) return this.currentBrief;
      if (Array.isArray(this.currentBriefs)) {
        return this.currentBriefs.find((b) => b && b.id === briefId) || null;
      }
      return null;
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
      // Seed all seven stages in pending state (extract / compose /
      // 4 scaffold sub-stages / write — the order rendered by
      // renderBriefStages), then overlay whichever ones the server
      // already advanced.
      const seed = () => ({ status: "pending", detail: "", progress: null, startedAt: null, etaSec: null, finishedAt: null });
      const stages = brief.stages || (brief.stages = {
        extract:             seed(),
        compose:             seed(),
        "scaffold-anchor":   seed(),
        "scaffold-findings": seed(),
        "scaffold-cluster":  seed(),
        "scaffold-actions":  seed(),
        write:               seed(),
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
      // If the target brief is still being generated, the confirmation
      // copy is sharper · the user is also cancelling an in-flight
      // pipeline (LLM calls actively burning tokens), not just removing
      // a finished row. Server aborts the upstream fetches when we DELETE.
      const isStillGenerating = !!(target && (!target.bodyMd || !target.bodyMd.trim()));
      const confirmText = lang === "zh"
        ? (isStillGenerating
            ? "这份报告还在生成中。删除会立即停止生成并删除这份报告，此操作不可恢复。"
            : (target?.supplement
                ? `删除这份"${target.supplement.trim().slice(0, 20)}${target.supplement.length > 20 ? "…" : ""}"补充视角的报告？此操作不可恢复。`
                : "删除这份报告？此操作不可恢复。"))
        : (isStillGenerating
            ? "This report is still generating. Deleting will stop the generation and remove the report. This can't be undone."
            : (target?.supplement
                ? `Delete the "${target.supplement.trim().slice(0, 20)}${target.supplement.length > 20 ? "…" : ""}" version? This can't be undone.`
                : "Delete this report? This can't be undone."));
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
      this.refreshReportsCount();
    },

    /** Retry handler for the orphaned-brief recovery UI. Drops the
     *  failed brief row, then posts to the brief endpoint to kick off a
     *  fresh generation. The new brief takes the failed one's slot in
     *  the version tab strip — without the upfront delete, the brief
     *  index is positioned by createdAt and the regenerated brief
     *  always lands one slot AFTER the failed row (e.g. "Report 2
     *  failed → Report 3 appears" instead of "Report 2 regenerates"). */
    async retryBriefGeneration(overrideTargetId) {
      if (!this.currentRoomId) return;
      // overrideTargetId · the salvage-path banner passes the failed
      // brief's id explicitly because currentBrief was swapped to the
      // prior good one for rendering. Without this override, the retry
      // would try to delete the GOOD brief instead of the failed one.
      let failed = null;
      if (overrideTargetId) {
        failed = (this.currentBriefs || []).find((b) => b && b.id === overrideTargetId) || null;
      } else {
        failed = this.currentBrief;
      }
      const failedId = failed && (failed.error || failed.interrupted || failed.timedOut)
        ? failed.id
        : null;
      try {
        if (failedId) {
          // Best-effort delete · if it fails (already gone, network blip)
          // we still proceed with the regenerate. Worst case: an extra
          // failed-brief tab survives and the user can dismiss it via
          // the per-tab × button.
          try {
            await fetch("/api/briefs/" + encodeURIComponent(failedId), { method: "DELETE" });
            if (Array.isArray(this.currentBriefs)) {
              this.currentBriefs = this.currentBriefs.filter((b) => b && b.id !== failedId);
            }
          } catch { /* swallow */ }
        }
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
        // Flip the on-screen card from error → generating immediately so
        // the click has visible feedback before brief-started SSE lands
        // and replaces currentBrief with the real new placeholder.
        if (this.currentBrief && this.currentBrief.id === failedId) {
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
        // 409 "room is not live" · benign race · the user clicked
        // Pause at a moment when the room had already auto-transitioned
        // out of `live` (e.g. the auto-continue countdown fired and
        // started a director turn just before the click landed, or the
        // room was already paused by another tab). The user's INTENT —
        // "don't run another round automatically" — is already
        // satisfied, so no alert / no throw. Leave the UI as-is and
        // return silently; the next SSE will reconcile the visible
        // state.
        if (r.status === 409 && /not live|already.*paused/i.test(e.error || "")) {
          return;
        }
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
     *  the room isn't idle; shows the countdown when active.
     *
     *  Each chair vote creates a fresh `.round-prompt-card` with its
     *  own `[data-continue-auto]` button — and the old cards stay in
     *  the chat (messages are append-only). On the SECOND vote, the
     *  DOM has 2+ matching buttons; `document.querySelector` returns
     *  the FIRST (oldest) one. Without scoping, the countdown
     *  animation paints the stale button while the new button — the
     *  one the user is looking at — stays blank, even though the
     *  timer interval is firing. Pick the LAST match (= most recent
     *  card) and clear stale styles off any prior buttons. */
    refreshContinueButton() {
      const btns = document.querySelectorAll("[data-continue-auto]");
      if (!btns.length) return;
      const btn = btns[btns.length - 1];
      // Clear stale state on every prior button — they're attached to
      // already-resolved round-prompt cards and shouldn't carry the
      // `counting` class or a non-zero progress var from a past run.
      for (let i = 0; i < btns.length - 1; i++) {
        const old = btns[i];
        old.classList.remove("counting");
        old.style.setProperty("--qc-progress", "0%");
        const oldTimer = old.querySelector("[data-continue-timer]");
        if (oldTimer) oldTimer.textContent = "";
      }
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

    /** Accept the chair's tone-shift proposal: PATCH the room mode,
     *  then resume directors. The mode change fires the existing
     *  settings-marker → tone-shift detector path on the backend, so
     *  the next director sweep reads the new tone with an explicit
     *  "tone just changed" cue in their system prompt (anti-RLHF-drift).
     */
    async acceptModeShiftAndContinue(toMode) {
      if (!this.currentRoomId) return;
      if (!(await this.requireModelKey())) return;
      // PATCH first so the new mode is persisted before continue fires.
      // updateRoomSettings emits its own SSE settings-changed; the
      // tone-shift detector picks up the marker on the next director
      // turn whether or not the user paused between PATCH and continue.
      await this.updateRoomSettings({ mode: toMode });
      await this.continueRoom();
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
        // 409 "room is not live" / "already paused" / "already adjourned"
        // is a benign race — the user (or another tab) transitioned the
        // room off `live` between when the Continue button surfaced and
        // when the request landed. Auto-fire from the countdown timer
        // is the most visible offender: timer ticks to zero after the
        // user has already paused / adjourned, the API returns 409, and
        // the alert pops up unprompted ("莫名其妙的提出来一个 alert").
        // Same swallow pattern as `pauseRoom` for the pause-vs-continue
        // race (see the 409 handling around line 2740). All other 4xx /
        // 5xx still alert.
        const benignRace = r.status === 409 && /not\s*live|already\s*(paused|adjourned)/i.test(e.error || "");
        if (!benignRace) {
          alert("Continue failed: " + (e.error || r.statusText));
        }
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
        // Layout: a wrapper holds the anchor + the delete button as
        // siblings. Putting the <button> inside the <a> is invalid HTML
        // and some browsers route the click to the link, swallowing the
        // delete action — moving it out fixes that.
        // No `title` attr · the native browser tooltip popping the full
        // subject on hover competes with the row's own subtitle line
        // and felt redundant. The subtitle already shows the subject;
        // truncated names are rare and the user can click in to see
        // the full thing if needed.
        return `
          <div class="session-row-shell" data-room-id="${this.escape(r.id)}" data-status="${this.escape(r.status)}">
            <a href="#/r/${this.escape(r.id)}" class="session-row">
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
      // The All Reports / All Notes views are their own destinations ·
      // navigating to a room or to a composer always clears their
      // highlights so only the new focus reads as active.
      document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-notes-trigger].active").forEach((el) => el.classList.remove("active"));
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
      // The All-Reports / All-Notes trigger highlights + URL hash both
      // belong to separate destinations. Drop them when an agent
      // profile takes focus so refresh on the profile doesn't bounce
      // back to /reports or /notes.
      document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-notes-trigger].active").forEach((el) => el.classList.remove("active"));
      if (/^#\/(reports|notes)$/i.test(location.hash || "")) {
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
      this.renderFollowUpFragments();
      this.renderSessionAnalytics();
    },

    /** Render the follow-up tree fragments around the current room:
     *
     *    · parentBanner · prepended to [data-chat-messages] when this
     *      room is itself a follow-up. Reads as "// following up
     *      Room #N · {subject}" with a click target back to the
     *      parent.
     *    · childrenList · appended after [data-brief-card] when this
     *      room has spawned follow-ups. Each tile is a click target
     *      to the child room.
     *
     *  Idempotent · re-rendering removes previous fragments before
     *  inserting fresh ones. Both render conditionally — empty / null
     *  produces nothing in the DOM. */
    renderFollowUpFragments() {
      const lang = this.composerLanguage();
      // 1 · parent banner (this room is a follow-up)
      const chat = document.querySelector("[data-chat-messages]");
      const existingBanner = document.querySelector(".followup-parent-banner");
      if (existingBanner) existingBanner.remove();
      const parent = this.currentParentRef;
      if (chat && parent && parent.id) {
        const labelText = lang === "zh" ? "// 跟进自" : "// following up";
        const subject = (parent.subject || "(no subject)").trim();
        const banner = document.createElement("a");
        banner.href = "#";
        banner.className = "followup-parent-banner";
        banner.setAttribute("data-followup-parent-id", parent.id);
        banner.innerHTML =
          `<span class="label">${this.escape(labelText)}</span>` +
          `<span class="room-num">Room #${this.escape(String(parent.number))}</span>` +
          `<span class="subject">${this.escape(subject)}</span>` +
          `<span class="arrow">↗</span>`;
        chat.parentNode.insertBefore(banner, chat);
      }

      // 2 · children list (this room has spawned follow-ups)
      const briefCard = document.querySelector("[data-brief-card]");
      const existingChildren = document.querySelector(".followup-children");
      if (existingChildren) existingChildren.remove();
      const kids = Array.isArray(this.currentFollowUps) ? this.currentFollowUps : [];
      if (briefCard && kids.length > 0) {
        const headLabel = lang === "zh"
          ? `跟进会议 · ${kids.length}`
          : `Follow-up rooms · ${kids.length}`;
        const block = document.createElement("div");
        block.className = "followup-children";
        block.innerHTML = [
          `<div class="followup-children-head">${this.escape(headLabel)}</div>`,
          `<div class="followup-children-list">`,
          ...kids.map((k, i) => {
            const num = String(i + 1).padStart(2, "0");
            const subj = (k.subject || "(no subject)").trim();
            const status = (k.status || "").toLowerCase();
            const statusLabel = status || "—";
            return `
              <a href="#" class="followup-child-tile" data-followup-room-id="${this.escape(k.id)}">
                <span class="num">${this.escape(num)}</span>
                <span class="subject">${this.escape(subj)}</span>
                <span class="meta ${this.escape(status)}">${this.escape(statusLabel)}</span>
              </a>
            `;
          }),
          `</div>`,
        ].join("");
        briefCard.parentNode.insertBefore(block, briefCard.nextSibling);
      }
    },

    /** Aggregate post-adjourn session metrics from the in-memory room
     *  state. All inputs already loaded by openRoom · no additional
     *  fetches needed. Returns null when the room isn't adjourned (the
     *  card only ships at end-of-session). */
    computeSessionStats() {
      const room = this.currentRoom;
      if (!room || room.status !== "adjourned") return null;
      const messages = this.currentMessages || [];

      let totalTokens = 0, promptTokens = 0, completionTokens = 0;
      const modelTokens = new Map(); // modelV → cumulative tokens
      for (const m of messages) {
        const tokens = m.meta && m.meta.tokens;
        if (!tokens) continue;
        const t = Number(tokens.total) || 0;
        const p = Number(tokens.prompt) || 0;
        const c = Number(tokens.completion) || 0;
        totalTokens += t;
        promptTokens += p;
        completionTokens += c;
        const mv = m.meta && m.meta.modelV;
        if (mv && t > 0) modelTokens.set(mv, (modelTokens.get(mv) || 0) + t);
      }

      // Round count = highest round_num seen (rounds are 1-indexed).
      let roundCount = 0;
      for (const m of messages) {
        if (typeof m.roundNum === "number" && m.roundNum > roundCount) roundCount = m.roundNum;
      }

      // Visible-message count · skip system noise + procedural chair
      // markers (round-open, round-prompt, settings) so the headline
      // reflects what the user would call a "message".
      const skipKinds = new Set(["round-open", "round-prompt", "settings"]);
      const messageCount = messages.filter((m) => {
        if (m.authorKind === "system") return false;
        const kind = m.meta && m.meta.kind;
        if (kind && skipKinds.has(kind)) return false;
        return true;
      }).length;

      const durationMs = (room.adjournedAt && room.createdAt && room.adjournedAt > room.createdAt)
        ? room.adjournedAt - room.createdAt
        : 0;

      // User-value highlights · key points the chair surfaced that the
      // user voted ▲ on. These are the points the user weighted as
      // worth chasing — the strongest "what stuck" signal we have.
      const upvotedPoints = (this.currentKeyPoints || []).filter((p) => p.vote === "up");

      // User contribution mix · plain messages vs probe / second
      // (quote-CTA-driven user messages, recognised by leading `> `
      // blockquote + the canonical reaction line).
      const userMessages = messages.filter((m) => m.authorKind === "user");
      let secondCount = 0, probeCount = 0;
      for (const m of userMessages) {
        const body = m.body || "";
        if (!/^>\s/m.test(body)) continue;
        if (/(^|\n)Seconded\.\s*$|(^|\n)附议。\s*$/.test(body)) secondCount++;
        else probeCount++;
      }

      const modelBreakdown = Array.from(modelTokens.entries())
        .map(([modelV, tokens]) => ({
          modelV,
          tokens,
          pct: totalTokens > 0 ? tokens / totalTokens : 0,
        }))
        .sort((a, b) => b.tokens - a.tokens);

      return {
        totalTokens, promptTokens, completionTokens,
        modelBreakdown,
        roundCount,
        messageCount,
        userMessageCount: userMessages.length,
        secondCount, probeCount,
        durationMs,
        upvotedPoints,
        upvotedCount: upvotedPoints.length,
      };
    },

    /** "Session analytics" card · ceremonial post-adjourn summary that
     *  surfaces totals (tokens / messages / rounds / duration), the
     *  model usage split as a stacked bar, and the user-value
     *  highlights (▲-voted key points, second / probe counts).
     *  Inserted right ABOVE the brief card so the post-adjourn
     *  reading order is analytics → brief → follow-ups. Idempotent:
     *  re-renders by removing the prior card first. */
    renderSessionAnalytics() {
      const existing = document.querySelector(".session-analytics");
      if (existing) existing.remove();
      const stats = this.computeSessionStats();
      if (!stats) return;
      const briefCard = document.querySelector("[data-brief-card]");
      if (!briefCard) return;

      const isZh = this.composerLanguage() === "zh";
      const t = isZh
        ? {
            head: "// 会议数据",
            stamp: "已结束",
            tokens: "tokens",
            messages: "条消息",
            rounds: "轮讨论",
            minutes: "分钟",
            modelHead: "模型用量",
            valueHead: "你认为有价值的",
            valueEmpty: "本次没有 ▲ key point 投票，也没有用 probe / second。",
            voted: "▲ 投票",
            seconded: "附议",
            probed: "追问",
          }
        : {
            head: "// session analytics",
            stamp: "closed",
            tokens: "tokens",
            messages: "msgs",
            rounds: "rounds",
            minutes: "min",
            modelHead: "Model usage",
            valueHead: "What you valued",
            valueEmpty: "No ▲ key-point votes, probes, or seconds in this session.",
            voted: "▲ voted",
            seconded: "★ seconded",
            probed: "✎ probed",
          };

      const fmtTokens = (n) => {
        if (!Number.isFinite(n) || n <= 0) return "0";
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2) + "M";
        if (n >= 1_000)     return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + "k";
        return String(Math.round(n));
      };
      const fmtDuration = (ms) => {
        if (!Number.isFinite(ms) || ms <= 0) return "—";
        const totalMin = Math.round(ms / 60_000);
        if (totalMin < 60) return `${totalMin} ${t.minutes}`;
        const h = Math.floor(totalMin / 60);
        const mm = totalMin % 60;
        return mm === 0 ? `${h} h` : `${h} h ${mm} ${t.minutes}`;
      };

      // Model → provider lookup via the cached models snapshot. Falls
      // back to "unknown" when the registry hasn't been fetched yet
      // (e.g. cold start) — provider colour just defaults to neutral.
      const modelsCache = (typeof window.boardroomModels === "function") ? window.boardroomModels() : null;
      const reachable = (modelsCache && Array.isArray(modelsCache.reachable)) ? modelsCache.reachable : [];
      const PROVIDER_COLOR_VAR = {
        anthropic: "--lime",
        openai:    "--cyan",
        google:    "--amber",
        xai:       "--magenta",
        deepseek:  "--red",
        unknown:   "--text-soft",
      };
      // Per-provider shade ordering · flagship first (deepest tint),
      // then progressively lighter variants. The first entry takes the
      // raw provider colour; subsequent entries blend in increasing
      // amounts of white via `color-mix()` so two Anthropic models
      // (Opus + Sonnet) read as different shades of lime instead of
      // an identical lime block. Models not listed fall back to the
      // base provider colour. Append-only — adding a new variant just
      // requires its modelV at the appropriate position.
      const MODEL_SHADE_ORDER = {
        anthropic: ["opus-4-7", "sonnet-4-6", "haiku-4-5"],
        openai:    ["gpt-5-5", "gpt-5-4-mini", "codex-5-4"],
        google:    ["gemini-3-1", "gemini-3-flash", "gemini-3-1-flash"],
        xai:       ["grok-4", "grok-4-3", "grok-4-mini"],
        deepseek:  ["deepseek-v4-pro", "deepseek-v4"],
      };
      const providerOf = (modelV) => {
        const hit = reachable.find((m) => m.modelV === modelV);
        return hit && hit.provider ? hit.provider : "unknown";
      };
      /** Produce a CSS colour value for a given modelV · base provider
       *  colour for the flagship, mixed with an increasing amount of
       *  white for cheaper / faster variants. Idempotent for unknown
       *  models — they get the base provider colour (or `--text-soft`
       *  when the provider itself is unknown). */
      const colorForModel = (modelV) => {
        const provider = providerOf(modelV);
        const baseVar = PROVIDER_COLOR_VAR[provider] || PROVIDER_COLOR_VAR.unknown;
        const order = MODEL_SHADE_ORDER[provider] || [];
        const idx = order.indexOf(modelV);
        if (idx <= 0) return `var(${baseVar})`;
        // Each step blends 20% more white into the base · cap at 55%
        // so the lightest variant still carries enough chroma to read
        // as the family colour, not as washed-out white.
        const pct = Math.min(idx * 20, 55);
        return `color-mix(in oklab, var(${baseVar}), white ${pct}%)`;
      };
      const modelLabel = (modelV) => MODEL_LABELS[modelV] || modelV;

      // Stacked bar · one segment per model, width = pct. Each segment
      // tinted with its model-specific shade so two variants from the
      // same provider read as different shades of the same family.
      const barSegments = stats.modelBreakdown.map((row) => {
        const color = colorForModel(row.modelV);
        const widthPct = (row.pct * 100).toFixed(2);
        return `<span class="sa-bar-seg" style="width: ${widthPct}%; background: ${color};" title="${this.escape(modelLabel(row.modelV) + " · " + fmtTokens(row.tokens) + " tokens")}"></span>`;
      }).join("");
      const barHtml = stats.modelBreakdown.length > 0
        ? `<div class="sa-bar" role="img" aria-label="${this.escape(t.modelHead)}">${barSegments}</div>`
        : "";

      const modelLegend = stats.modelBreakdown.map((row) => {
        const color = colorForModel(row.modelV);
        const pctTxt = (row.pct * 100).toFixed(row.pct < 0.1 ? 1 : 0) + "%";
        return `
          <li class="sa-legend-row">
            <span class="sa-legend-swatch" style="background: ${color};"></span>
            <span class="sa-legend-name">${this.escape(modelLabel(row.modelV))}</span>
            <span class="sa-legend-pct">${this.escape(pctTxt)}</span>
            <span class="sa-legend-tokens">${this.escape(fmtTokens(row.tokens))}</span>
          </li>
        `;
      }).join("");

      const valueChips = [
        stats.upvotedCount > 0 ? `<span class="sa-chip"><span class="sa-chip-mark">▲</span>${stats.upvotedCount} ${this.escape(t.voted)}</span>` : "",
        stats.secondCount > 0  ? `<span class="sa-chip"><span class="sa-chip-mark">★</span>${stats.secondCount} ${this.escape(t.seconded)}</span>` : "",
        stats.probeCount > 0   ? `<span class="sa-chip"><span class="sa-chip-mark">✎</span>${stats.probeCount} ${this.escape(t.probed)}</span>` : "",
      ].filter(Boolean).join("");

      // Cap default-visible upvoted points at 2 · the rest collapse
      // behind a [+ N more] toggle. Long lists were dominating the
      // analytics tile; capping keeps the section as a tight strip
      // and lets the user opt in.
      const VALUE_PREVIEW_CAP = 2;
      const moreLabel = (n) => isZh ? `[ + 展开剩余 ${n} 条 ]` : `[ + show ${n} more ]`;
      const lessLabel = isZh ? "[ 收起 ]" : "[ collapse ]";
      const upvotedHtml = stats.upvotedPoints.length > 0
        ? (() => {
            const items = stats.upvotedPoints.map((p, i) => {
              const cls = i >= VALUE_PREVIEW_CAP ? "sa-point sa-point-extra" : "sa-point";
              return `<li class="${cls}"><span class="sa-point-mark">▲</span><span class="sa-point-body">${this.escape(p.body)}</span></li>`;
            }).join("");
            const overflow = stats.upvotedPoints.length - VALUE_PREVIEW_CAP;
            const toggle = overflow > 0
              ? `<button type="button" class="sa-points-toggle" data-sa-toggle aria-expanded="false" data-more-label="${this.escape(moreLabel(overflow))}" data-less-label="${this.escape(lessLabel)}">${this.escape(moreLabel(overflow))}</button>`
              : "";
            return `<ul class="sa-points" data-sa-points>${items}</ul>${toggle}`;
          })()
        : "";
      const valueBlock = (valueChips || upvotedHtml)
        ? `
          <div class="sa-section">
            <div class="sa-section-head">${this.escape(t.valueHead)}</div>
            ${valueChips ? `<div class="sa-chips">${valueChips}</div>` : ""}
            ${upvotedHtml}
          </div>
        `
        : `
          <div class="sa-section sa-section-empty">
            <div class="sa-section-head">${this.escape(t.valueHead)}</div>
            <div class="sa-empty">${this.escape(t.valueEmpty)}</div>
          </div>
        `;

      const block = document.createElement("div");
      block.className = "session-analytics";
      block.innerHTML = `
        <div class="sa-banner">
          <span class="sa-banner-tag">${this.escape(t.head)}</span>
          <span class="sa-banner-stamp">${this.escape(t.stamp)}</span>
        </div>
        <div class="sa-body">
          <div class="sa-headline">
            <div class="sa-metric sa-metric-hero">
              <div class="sa-metric-value">${this.escape(fmtTokens(stats.totalTokens))}</div>
              <div class="sa-metric-label">${this.escape(t.tokens)}</div>
            </div>
            <div class="sa-metric">
              <div class="sa-metric-value">${stats.messageCount}</div>
              <div class="sa-metric-label">${this.escape(t.messages)}</div>
            </div>
            <div class="sa-metric">
              <div class="sa-metric-value">${stats.roundCount}</div>
              <div class="sa-metric-label">${this.escape(t.rounds)}</div>
            </div>
            <div class="sa-metric">
              <div class="sa-metric-value">${this.escape(fmtDuration(stats.durationMs))}</div>
              <div class="sa-metric-label">${this.escape(t.minutes)}</div>
            </div>
          </div>
          ${stats.modelBreakdown.length > 0 ? `
            <div class="sa-section">
              <div class="sa-section-head">${this.escape(t.modelHead)}</div>
              ${barHtml}
              <ul class="sa-legend">${modelLegend}</ul>
            </div>
          ` : ""}
          ${valueBlock}
        </div>
      `;

      // Insert ABOVE the brief card BUT BELOW the `▼ session output ▼`
      // divider, so the ceremonial header still frames everything in
      // the post-adjourn section. Layout inside [data-brief-card]:
      //
      //   <header.ending-block-head> (the divider)
      //   ← analytics tile inserted here
      //   <div.brief-card>           (the report)
      //   <footer.ending-block-foot>
      //
      // Falls back to inserting above the entire [data-brief-card]
      // container when the divider isn't present (e.g. error state
      // before renderBrief has populated the container).
      const dividerHead = briefCard.querySelector(":scope > .ending-block-head");
      const briefInner = briefCard.querySelector(":scope > .brief-card");
      if (dividerHead && briefInner) {
        briefCard.insertBefore(block, briefInner);
      } else {
        briefCard.parentNode.insertBefore(block, briefCard);
      }

      // Wire the [+ show N more] toggle for the upvoted points list.
      const toggleBtn = block.querySelector("[data-sa-toggle]");
      if (toggleBtn) {
        const list = block.querySelector("[data-sa-points]");
        toggleBtn.addEventListener("click", () => {
          const expanded = toggleBtn.getAttribute("aria-expanded") === "true";
          const next = !expanded;
          toggleBtn.setAttribute("aria-expanded", String(next));
          if (list) list.classList.toggle("sa-points-expanded", next);
          toggleBtn.textContent = next
            ? toggleBtn.dataset.lessLabel
            : toggleBtn.dataset.moreLabel;
        });
      }
    },

    renderPausedBar() {
      const bar = document.querySelector(".paused-bar");
      if (!bar || !this.currentRoom) return;
      // Next director that would speak when discussion resumes · the
      // only other piece of info still useful here. The "last input"
      // line was dropped as redundant — the user's last message is
      // visible right above the bar.
      const nextSpeaker = this.currentQueue[0]
        ? this.agentsById[this.currentQueue[0].agentId]
        : this.currentMembers[0];
      const nextHandle = nextSpeaker
        ? this.escape(nextSpeaker.handle.replace(/^\//, ""))
        : "";

      const lang = this.composerLanguage();
      const addInputLabel = lang === "zh" ? "[ + 补充观点 ]" : "[ + Add input ]";
      const adjournLabel  = lang === "zh" ? "[ ▸ 结束并存档 ]" : "[ ▸ Adjourn & File Brief ]";
      const resumeLabel   = lang === "zh" ? "[ ▶ 恢复讨论 ]"   : "[ ▶ Resume Discussion ]";
      const pausedLabel   = lang === "zh" ? "已暂停" : "paused";
      const nextLabel     = lang === "zh" ? "下一位" : "next";
      const nextChunk = nextHandle
        ? ` · ${nextLabel} → <span class="lime">${nextHandle}</span>`
        : "";
      bar.innerHTML = `
        <div class="paused-bar-text">
          <strong>// ${pausedLabel}</strong>${nextChunk}
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

      // Strip stale follow-up fragments inserted by renderFollowUp-
      // Fragments() when a follow-up room was previously open. These
      // live as SIBLINGS of [data-chat-messages] / [data-brief-card]
      // (not inside them), so closeRoom's `chat.innerHTML = ""` doesn't
      // touch them — without this cleanup the "// following up Room #N"
      // banner and "Follow-up rooms · N" tile list bleed into the new-
      // room and new-agent empty states.
      document.querySelectorAll(".followup-parent-banner, .followup-children").forEach((el) => el.remove());

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
      // Each fresh open of the All Reports view starts at page 1 (20
      // items). Without this reset, navigating away and back inherits
      // a stale paginated state — e.g. user scrolled to "120 visible",
      // navigated to a room, came back, would see 120 rows again.
      this._reportsVisibleCount = 20;
      if (this._reportsLoadObserver) {
        try { this._reportsLoadObserver.disconnect(); } catch { /* noop */ }
        this._reportsLoadObserver = null;
      }
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
      // Hide room/agent/notes main-views, show reports.
      const room = document.querySelector('[data-main-view="room"]');
      const agent = document.querySelector('[data-main-view="agent"]');
      const reports = document.querySelector('[data-main-view="reports"]');
      const notes = document.querySelector('[data-main-view="notes"]');
      if (room) room.setAttribute("hidden", "");
      if (agent) agent.setAttribute("hidden", "");
      if (notes) notes.setAttribute("hidden", "");
      if (reports) reports.removeAttribute("hidden");
      // Mark the sidebar trigger active. All sibling tab highlights
      // (new-room, new-agent, all-notes) get cleared so only
      // "All Reports" reads as the current focus.
      this.composerMode = "room"; // logical fallback when leaving reports
      document.querySelectorAll("[data-convene-trigger], [data-agent-composer-trigger]").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll(".session-row-shell.active, .agent-row.active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-notes-trigger].active").forEach((el) => el.classList.remove("active"));
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

      // Pagination · default 20 visible, IntersectionObserver appends
      // 20 more when the user scrolls past the bottom sentinel. Avoids
      // rendering hundreds of report rows up-front (slow first paint
      // + heavy DOM) on long-lived archives. Reset to 20 on filter
      // change so each window starts at the top.
      if (typeof this._reportsVisibleCount !== "number") {
        this._reportsVisibleCount = 20;
      }
      const visibleCount = Math.min(this._reportsVisibleCount, filtered.length);
      const visibleFiltered = filtered.slice(0, visibleCount);
      const hasMore = visibleCount < filtered.length;

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
      // Iterates the *visible* slice; the load-more sentinel below
      // tops the list up by 20 each time it crosses the viewport.
      const groups = [];
      const yesterdayStart = todayStart - 86400_000;
      let currentGroup = null;
      const groupLabelFor = (ts) => {
        if (ts >= todayStart)      return "Today";
        if (ts >= yesterdayStart)  return "Yesterday";
        if (ts >= weekStart)       return "This week";
        return "Earlier";
      };
      for (const b of visibleFiltered) {
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

      // Bottom sentinel · IntersectionObserver target. Renders only
      // when there's more to load. The "+ N more" hint doubles as a
      // click target if the user prefers explicit paging over scroll.
      const remaining = filtered.length - visibleCount;
      const sentinelHtml = hasMore
        ? `
          <div class="reports-load-sentinel" data-reports-load-sentinel>
            <button type="button" class="reports-load-more" data-reports-load-more>
              <span class="reports-load-more-arrow">▾</span>
              <span class="reports-load-more-text">Load ${Math.min(20, remaining)} more · ${remaining} remaining</span>
            </button>
          </div>
        `
        : "";

      page.innerHTML = `
        <div class="reports-page-head">
          <div>
            <div class="reports-page-kicker">// archive</div>
            <h1 class="reports-page-title">All Reports</h1>
          </div>
          <div class="reports-page-meta">${total} ${total === 1 ? "report" : "reports"} · ${distinctRooms} ${distinctRooms === 1 ? "room" : "rooms"}${hasMore ? ` · showing ${visibleCount}` : ""}</div>
        </div>

        <div class="reports-filters" role="tablist" aria-label="Filter reports by recency">
          ${filterChip("all", "All", total)}
          ${filterChip("today", "Today", todayCount)}
          ${filterChip("week", "This week", weekCount)}
          ${filterChip("earlier", "Earlier", earlierCount)}
        </div>

        <div class="reports-list-wrap">${groupsHtml}${sentinelHtml}</div>
      `;

      // Wire the load-more sentinel after the DOM is in place. Observer
      // is scoped to this view; we tear it down on the next render to
      // avoid leaks. Click handler covers explicit-tap users; the
      // observer covers scroll users — both bump the visible count
      // and re-render in place.
      this._wireReportsLoadMore(filtered);
    },

    /** Wire pagination on the All Reports view · IntersectionObserver
     *  on the bottom sentinel + click on the explicit "Load more"
     *  button. Both bump `_reportsVisibleCount` by 20 and re-render. */
    _wireReportsLoadMore(filteredList) {
      // Tear down a stale observer from a prior render before mounting
      // a fresh one — without this, scrolling fires N old observers
      // and re-renders churn the list.
      if (this._reportsLoadObserver) {
        try { this._reportsLoadObserver.disconnect(); } catch { /* noop */ }
        this._reportsLoadObserver = null;
      }
      const sentinel = document.querySelector("[data-reports-load-sentinel]");
      if (!sentinel) return;

      const bumpVisible = () => {
        const next = (this._reportsVisibleCount || 20) + 20;
        if (next >= filteredList.length) {
          this._reportsVisibleCount = filteredList.length;
        } else {
          this._reportsVisibleCount = next;
        }
        // Re-render with the cached dataset · cheap (no fetch).
        if (Array.isArray(this._reportsCache)) {
          this.renderReportsPage(this._reportsCache);
        }
      };

      // Click path · explicit tap on the button.
      const btn = sentinel.querySelector("[data-reports-load-more]");
      if (btn) {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          bumpVisible();
        });
      }

      // Scroll path · IntersectionObserver fires when the sentinel
      // crosses the viewport. `rootMargin: 200px` triggers slightly
      // before the actual edge so the next batch is rendered before
      // the user reaches the bottom — feels seamless rather than
      // chunked.
      try {
        this._reportsLoadObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                bumpVisible();
                break;
              }
            }
          },
          { rootMargin: "200px 0px 200px 0px", threshold: 0.01 },
        );
        this._reportsLoadObserver.observe(sentinel);
      } catch { /* IntersectionObserver unavailable · click path remains */ }
    },

    /** Switch the active recency filter without a re-fetch — uses the
     *  cached dataset captured by renderReportsPage. Resets the
     *  visible page size to 20 so each filtered window starts at the
     *  top instead of inheriting the prior filter's scroll position. */
    setReportsFilter(key) {
      this._reportsFilter = key;
      this._reportsVisibleCount = 20;
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

    // ── All Notes view · chairman's notes index ───────────────
    /** Open the All Notes page · cross-room saved-excerpt index in
     *  the same main-view-replacement pattern as openAllReports.
     *  Pulls the live list and renders three time-bucket sections
     *  (Today / This Week / Earlier). */
    async openAllNotes() {
      // Same view-leaving routine as openAllReports.
      if (this.currentRoomId) {
        this.disconnectSSE?.();
        this.currentRoomId = null;
        this.currentRoom = null;
        this.currentMessages = [];
        this.currentMembers = [];
        this.currentQueue = [];
        this.currentBrief = null;
        if (/^#\/r\//.test(location.hash)) {
          history.replaceState(null, "", location.pathname + location.search);
        }
      }
      if (typeof window.closeAgentProfile === "function") {
        try { window.closeAgentProfile(); } catch { /* ignore */ }
      }
      const room = document.querySelector('[data-main-view="room"]');
      const agent = document.querySelector('[data-main-view="agent"]');
      const reports = document.querySelector('[data-main-view="reports"]');
      const notes = document.querySelector('[data-main-view="notes"]');
      if (room) room.setAttribute("hidden", "");
      if (agent) agent.setAttribute("hidden", "");
      if (reports) reports.setAttribute("hidden", "");
      if (notes) notes.removeAttribute("hidden");

      this.composerMode = "room";
      document.querySelectorAll("[data-convene-trigger], [data-agent-composer-trigger]").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll(".session-row-shell.active, .agent-row.active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-notes-trigger]").forEach((el) => el.classList.add("active"));

      if (location.hash !== "#/notes") {
        try { history.replaceState(null, "", "#/notes"); } catch { /* ignore */ }
      }

      const page = document.querySelector("[data-notes-page]");
      if (page) {
        page.innerHTML = `
          <div class="notes-page-head">
            <div>
              <div class="notes-page-kicker">// chairman · saved excerpts</div>
              <h1 class="notes-page-title">All Notes</h1>
            </div>
            <div class="notes-page-meta">loading…</div>
          </div>
          <div class="notes-skeleton">
            ${Array.from({ length: 3 }, () => `<div class="notes-skeleton-card"></div>`).join("")}
          </div>
        `;
      }

      let notesList = [];
      try {
        const r = await fetch("/api/notes");
        if (r.ok) {
          const j = await r.json();
          notesList = Array.isArray(j.notes) ? j.notes : [];
        }
      } catch { /* keep empty → empty-state */ }

      this.renderNotesPage(notesList);
    },

    /** Render the All Notes timeline · same filter-strip + date-
     *  group rhythm as the All Reports page so the two cross-room
     *  destinations behave identically. The chip strip lives below
     *  the head; clicks re-render in place via setNotesFilter using
     *  the cached dataset (no /api/notes round trip per chip).
     *
     *  Bucket boundaries mirror the reports filter exactly:
     *    today    · createdAt >= start-of-today
     *    week     · createdAt >= start-of-today − 6d (7-day rolling
     *               window INCLUDING today)
     *    earlier  · createdAt <  weekStart
     */
    renderNotesPage(notesList) {
      const page = document.querySelector("[data-notes-page]");
      if (!page) return;
      const total = notesList.length;

      // Cache so chip clicks can re-render without re-fetching.
      this._notesCache = notesList;
      const activeFilter = this._notesFilter || "all";

      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const todayStart = startOfToday.getTime();
      const weekStart = todayStart - 6 * 86400_000;
      const todayCount = notesList.filter((n) => (n.createdAt || 0) >= todayStart).length;
      const weekCount = notesList.filter((n) => (n.createdAt || 0) >= weekStart).length;
      const earlierCount = notesList.filter((n) => (n.createdAt || 0) < weekStart).length;
      const distinctRooms = new Set(notesList.map((n) => n.roomId)).size;

      const filterChip = (key, label, count) => {
        const on = key === activeFilter ? " on" : "";
        return `
          <button type="button" class="notes-filter-chip${on}" data-notes-filter="${key}">
            <span class="notes-filter-label">${this.escape(label)}</span>
            <span class="notes-filter-count">${count}</span>
          </button>
        `;
      };
      const filtersHtml = `
        <div class="notes-filters" role="tablist" aria-label="Filter notes by recency">
          ${filterChip("all", "All", total)}
          ${filterChip("today", "Today", todayCount)}
          ${filterChip("week", "This week", weekCount)}
          ${filterChip("earlier", "Earlier", earlierCount)}
        </div>
      `;

      // Cold empty state · no saved notes at all. Distinct from
      // "filter window empty" (chip click into a slot with 0 hits)
      // which keeps the chips visible and offers a back-to-All CTA.
      if (total === 0) {
        page.innerHTML = `
          <div class="notes-page-head">
            <div>
              <div class="notes-page-kicker">// chairman · saved excerpts</div>
              <h1 class="notes-page-title">All Notes</h1>
            </div>
            <div class="notes-page-meta">0 notes</div>
          </div>
          ${filtersHtml}
          <div class="notes-list-empty">
            <div class="notes-empty-mark">○</div>
            <div class="notes-empty-title">no saved notes yet</div>
            <div class="notes-empty-deck">
              While reading a director's reply, select an interesting passage and hit
              <span class="kbd">S</span> or click <span class="kbd">⌖ Save</span>
              on the floating bar to bookmark it here.
            </div>
          </div>
        `;
        return;
      }

      const filtered = notesList.filter((n) => {
        const ts = n.createdAt || 0;
        if (activeFilter === "today")   return ts >= todayStart;
        if (activeFilter === "week")    return ts >= weekStart;
        if (activeFilter === "earlier") return ts < weekStart;
        return true;
      });

      // Group filtered items by date label so even an "All" view has
      // visual rhythm. When a recency filter narrows to a single
      // bucket, only that bucket's section renders — no empty headers.
      const groupLabelFor = (ts) => {
        if (ts >= todayStart) return "Today";
        if (ts >= weekStart)  return "This week";
        return "Earlier";
      };
      const groups = [];
      let currentGroup = null;
      for (const n of filtered) {
        const label = groupLabelFor(n.createdAt || 0);
        if (!currentGroup || currentGroup.label !== label) {
          currentGroup = { label, items: [] };
          groups.push(currentGroup);
        }
        currentGroup.items.push(n);
      }

      const filterLabels = { all: "the archive", today: "Today", week: "This week", earlier: "Earlier" };
      const groupsHtml = groups.length === 0
        ? `
          <div class="notes-list-empty">
            <div class="notes-empty-mark">○</div>
            <div class="notes-empty-title">No notes in ${this.escape(filterLabels[activeFilter] || "this window")}</div>
            <div class="notes-empty-deck">Pick a different filter, or jump back to the full archive.</div>
            ${activeFilter !== "all" ? `
              <button type="button" class="notes-empty-cta" data-notes-filter="all">
                <span class="notes-empty-cta-arrow">←</span>
                <span>Show all notes</span>
              </button>
            ` : ""}
          </div>
        `
        : groups.map((g) => `
          <section class="notes-group">
            <div class="notes-group-head">
              <span class="notes-group-label">${this.escape(g.label)}</span>
              <span class="notes-group-count">${g.items.length}</span>
            </div>
            <ul class="notes-list">
              ${g.items.map((n) => this.renderNoteItemHtml(n)).join("")}
            </ul>
          </section>
        `).join("");

      const totalLabel = `${total} ${total === 1 ? "note" : "notes"}`;
      const roomLabel = distinctRooms > 0
        ? ` · ${distinctRooms} ${distinctRooms === 1 ? "room" : "rooms"}`
        : "";

      page.innerHTML = `
        <div class="notes-page-head">
          <div>
            <div class="notes-page-kicker">// chairman · saved excerpts</div>
            <h1 class="notes-page-title">All Notes</h1>
          </div>
          <div class="notes-page-meta">${this.escape(totalLabel)}${this.escape(roomLabel)}</div>
        </div>
        ${filtersHtml}
        <div class="notes-list-wrap">${groupsHtml}</div>
      `;
    },

    /** Switch the active recency filter without a re-fetch — uses
     *  the cached dataset captured by renderNotesPage. */
    setNotesFilter(key) {
      this._notesFilter = key;
      if (Array.isArray(this._notesCache)) {
        this.renderNotesPage(this._notesCache);
      }
    },

    /** A single note card · meta line + faded-context-around-quote
     *  reading block + jump-to-source action. Quote is rendered with
     *  the dotted-underline overlay treatment that also appears
     *  in-room (see the .note-highlight rule). */
    renderNoteItemHtml(n) {
      const time = this.relTime(n.createdAt) || "";
      const roomNum = n.roomNumber != null ? `#${String(n.roomNumber).padStart(3, "0")}` : "";
      const roomSubject = (n.roomSubject || "").slice(0, 100);
      const author = n.authorName || "Director";
      // The jump link uses the room's hash route + the note id as a
      // fragment-style query so openRoom can scroll to + flash the
      // matching span (Step 5 wires the receiver). For now the link
      // just navigates · the in-room overlay step adds the scroll.
      const href = `#/r/${this.escape(n.roomId)}?note=${this.escape(n.id)}`;
      return `
        <li class="notes-item" data-note-id="${this.escape(n.id)}">
          <a class="notes-item-link" href="${href}" data-note-jump="${this.escape(n.id)}" data-note-room="${this.escape(n.roomId)}">
            <div class="notes-item-meta">
              <span class="notes-item-room">ROOM ${this.escape(roomNum)}</span>
              ${roomSubject ? `<span class="notes-item-sep">·</span><span class="notes-item-subject">${this.escape(roomSubject)}</span>` : ""}
              <span class="notes-item-sep">·</span>
              <span class="notes-item-director">${this.escape(author)}</span>
              <span class="notes-item-time">${this.escape(time)}</span>
            </div>
            <p class="notes-item-passage">${
              n.contextBefore ? `<span class="note-context note-context-before">${this.escape(n.contextBefore)}</span>` : ""
            }<span class="note-quote">${this.escape(n.quoteText)}</span>${
              n.contextAfter ? `<span class="note-context note-context-after">${this.escape(n.contextAfter)}</span>` : ""
            }</p>
          </a>
        </li>
      `;
    },

    /** Refresh the sidebar count badge · called on boot, after
     *  every successful save (note:created event), and after a
     *  delete. Hits /api/notes/count which is cheap (one COUNT query),
     *  so we don't need to debounce.
     *
     *  When count is 0 the badge is hidden (the `hidden` attr stays
     *  on); otherwise the count renders. The CSS bumps the colour to
     *  lime on hover/active so the badge tracks the link's cascade. */
    async refreshNotesCount() {
      try {
        const r = await fetch("/api/notes/count");
        if (!r.ok) return;
        const j = await r.json();
        const total = typeof j.total === "number" ? j.total : 0;
        const badge = document.querySelector("[data-notes-count]");
        if (!badge) return;
        if (total > 0) {
          badge.textContent = String(total);
          badge.removeAttribute("hidden");
        } else {
          badge.textContent = "";
          badge.setAttribute("hidden", "");
        }
      } catch { /* fail closed — leave badge as-is */ }
    },

    /** Mirror of refreshNotesCount for the All Reports sidebar badge.
     *  Hits /api/briefs/count (cheap COUNT, excludes empty placeholder
     *  rows). Called on boot and whenever a brief is filed / deleted
     *  so the badge stays in sync with the All Reports list. */
    async refreshReportsCount() {
      try {
        const r = await fetch("/api/briefs/count");
        if (!r.ok) return;
        const j = await r.json();
        const total = typeof j.total === "number" ? j.total : 0;
        const badge = document.querySelector("[data-reports-count]");
        if (!badge) return;
        if (total > 0) {
          badge.textContent = String(total);
          badge.removeAttribute("hidden");
        } else {
          badge.textContent = "";
          badge.setAttribute("hidden", "");
        }
      } catch { /* fail closed */ }
    },

    // ── In-room note highlight overlay ────────────────────────
    /** Fetch every note for the currently-open room and store as a
     *  Map<messageId, Note[]>. Re-runs the full-room highlight pass
     *  when the data arrives so a just-loaded room paints highlights
     *  even though renderChat already ran from openRoom. Silent on
     *  failure — the chat is still useful without highlights. */
    async loadRoomNotes(roomId) {
      try {
        const r = await fetch("/api/notes/by-room/" + encodeURIComponent(roomId));
        if (!r.ok) return;
        const j = await r.json();
        const list = Array.isArray(j.notes) ? j.notes : [];
        // Race guard · the user may have clicked another room while
        // /api/notes/by-room was in flight. Drop the response if it
        // no longer matches the active room.
        if (this.currentRoomId !== roomId) return;
        const map = new Map();
        for (const n of list) {
          const arr = map.get(n.messageId) || [];
          arr.push(n);
          map.set(n.messageId, arr);
        }
        this.currentNotes = map;
        // applyAllNoteHighlights consumes `_pendingNoteScroll` itself
        // — we just trigger it. Whichever runs last (this call or
        // renderChat's at-the-end call) lands the scroll once the
        // articles are actually in the DOM.
        this.applyAllNoteHighlights();
      } catch { /* silent */ }
    },

    /** Walk every director article in the chat and apply highlights
     *  for whichever notes match. Called by renderChat after a full
     *  re-render and by loadRoomNotes when notes land late.
     *
     *  Also consumes a pending `?note=<id>` jump request once the
     *  highlight is actually in the DOM · avoids the race where
     *  loadRoomNotes resolves BEFORE renderChat (chat empty, span
     *  doesn't exist yet, scrollToNote silently misses). The scroll
     *  request stays armed until the span exists, so whichever path
     *  lands later (notes-fetch-after-chat-render, or chat-render-
     *  after-notes-fetch) succeeds. */
    applyAllNoteHighlights() {
      if (this.currentNotes && this.currentNotes.size > 0) {
        for (const messageId of this.currentNotes.keys()) {
          this.applyNoteHighlightsForMessage(messageId);
        }
      }
      if (this._pendingNoteScroll) {
        const ok = this.scrollToNote(this._pendingNoteScroll);
        if (ok) this._pendingNoteScroll = null;
      }
    },

    /** Inject `<span class="note-highlight">` over each saved char
     *  range in this message's bubble. Skip if the article isn't in
     *  the DOM yet (mid-stream / not-yet-appended) — the next render
     *  pass will catch it. */
    applyNoteHighlightsForMessage(messageId) {
      if (!messageId) return;
      const notes = this.currentNotes && this.currentNotes.get(messageId);
      if (!notes || notes.length === 0) return;
      const article = document.querySelector(`article[data-message-id="${messageId}"]`);
      if (!article) return;
      // Custom chair cards have their own body container · same
      // resolution order as updateMessageBodyDom so highlights find
      // the right element regardless of message kind.
      const bubble =
        article.querySelector(".cd-body") ||
        article.querySelector(".ci-body") ||
        article.querySelector(".msg-bubble");
      if (!bubble) return;
      // De-dupe: clear any pre-existing highlights inside this bubble
      // before re-applying. Otherwise a re-render that runs before
      // the note count changes would double-wrap.
      bubble.querySelectorAll(".note-highlight").forEach((el) => {
        // Replace the span with its child nodes (preserve text). The
        // ordering matters: collect children first, then swap, so we
        // don't lose nodes mid-iteration.
        const parent = el.parentNode;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      });
      // Re-merge adjacent text nodes that prior wrap/unwrap cycles
      // left fragmented · keeps the char-offset walker's `pos`
      // accumulation aligned with the source text on every pass.
      bubble.normalize();
      // Apply newest-last so overlapping ranges paint in a stable order.
      // Sort ascending by start offset so we wrap from beginning to end
      // (wrapping a later range first would shift earlier offsets).
      const sorted = notes.slice().sort((a, b) => a.charOffsetStart - b.charOffsetStart);
      for (const note of sorted) {
        this._wrapRangeAsNoteHighlight(bubble, note);
      }
    },

    /** Wrap [note.charOffsetStart, note.charOffsetEnd) inside the
     *  given container with `<span class="note-highlight">` markers.
     *
     *  Per-text-node wrapping (NOT a single big range) · saved
     *  selections often cross inline-element boundaries (e.g. a span
     *  that runs from plain text into `<strong>`/`<code>` and back).
     *  A single Range across those would fail `surroundContents` and
     *  the natural fallback — `extractContents()` + `insertNode` —
     *  splits the enclosing block element when the range starts or
     *  ends near its boundary. For `<li>`/`<p>` that means the
     *  saved span gets sandwiched between two empty siblings (the
     *  "phantom bullets" bug). Wrapping each text node's slice in
     *  its own span sidesteps that entirely: every sub-range is
     *  text-only, so `surroundContents` always succeeds and the
     *  document structure stays intact. The visual underline reads
     *  continuous because all spans share the same class. */
    _wrapRangeAsNoteHighlight(container, note) {
      const start = note.charOffsetStart;
      const end = note.charOffsetEnd;
      if (!(end > start) || start < 0) return;

      // Collect every text node that contributes to the range,
      // along with the slice [from, to) within that node, BEFORE
      // any DOM mutation. Walker references stay valid because we
      // wrap one slice at a time and only mutate within its own
      // text node — the others keep their pre-mutation identities.
      const slices = [];
      let pos = 0;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const len = node.nodeValue.length;
        const nodeStart = pos;
        const nodeEnd = pos + len;
        pos = nodeEnd;
        if (nodeEnd <= start) continue;     // entirely before · skip
        if (nodeStart >= end) break;        // entirely after · done
        const sliceStart = Math.max(0, start - nodeStart);
        const sliceEnd = Math.min(len, end - nodeStart);
        if (sliceEnd > sliceStart) {
          slices.push({ node, sliceStart, sliceEnd });
        }
      }
      if (slices.length === 0) return;

      for (const s of slices) {
        const range = document.createRange();
        try {
          range.setStart(s.node, s.sliceStart);
          range.setEnd(s.node, s.sliceEnd);
        } catch { continue; }
        const span = document.createElement("span");
        span.className = "note-highlight";
        span.dataset.noteId = note.id;
        // aria-label (not `title`) · we don't want the native browser
        // tooltip's 1–2s delay competing with the custom `.note-tip`
        // popover wired up in init(); aria-label still surfaces the
        // affordance for screen readers.
        span.setAttribute("aria-label", "Saved to Notes");
        // Text-only ranges always satisfy surroundContents' "no
        // partial non-Text node" precondition · the catch is just
        // a safety belt for browsers that surprise us.
        try { range.surroundContents(span); }
        catch { /* skip this slice · others may still succeed */ }
      }
    },

    // ── Hover tooltip on .note-highlight spans ────────────────
    /** Lazy-create the singleton tooltip element. Lives on
     *  document.body so it can position absolutely above any chat
     *  message regardless of the bubble's overflow chain. */
    _ensureNoteTip() {
      if (this._noteTip) return this._noteTip;
      const el = document.createElement("div");
      el.className = "note-tip";
      el.setAttribute("role", "tooltip");
      document.body.appendChild(el);
      this._noteTip = el;
      return el;
    },

    showNoteTooltip(span) {
      if (!span) return;
      const tip = this._ensureNoteTip();
      const noteId = span.dataset.noteId;
      // Resolve note metadata from currentNotes · used for the time
      // stamp. If the lookup fails (rare race: tip fired between
      // openRoom and loadRoomNotes completing), we just show the
      // bare label without the time.
      let note = null;
      if (this.currentNotes && noteId) {
        for (const list of this.currentNotes.values()) {
          const found = list.find((n) => n.id === noteId);
          if (found) { note = found; break; }
        }
      }
      const time = note ? this.relTime(note.createdAt) : "";
      tip.innerHTML = `
        <span class="note-tip-mark">✓</span>
        <span class="note-tip-label">Saved to Notes</span>
        ${time ? `<span class="note-tip-sep">·</span><span class="note-tip-meta">${this.escape(time)}</span>` : ""}
      `;
      const rect = span.getBoundingClientRect();
      // Render the tooltip BEFORE measuring · width/height are 0
      // until the `.open` class flips display to inline-flex.
      tip.classList.add("open");
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      let top = window.scrollY + rect.top - tipH - 6;
      if (rect.top - tipH - 6 < 4) {
        top = window.scrollY + rect.bottom + 6;
      }
      let left = window.scrollX + rect.left + rect.width / 2 - tipW / 2;
      left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + window.innerWidth - tipW - 8));
      tip.style.top = top + "px";
      tip.style.left = left + "px";
    },

    hideNoteTooltip() {
      if (this._noteTip) this._noteTip.classList.remove("open");
    },

    /** Scroll the chat to the given note's highlight span and flash
     *  it briefly. Used by the All-Notes "Jump to source" path: when
     *  the URL hash carries `?note=<id>`, openRoom + loadRoomNotes
     *  populate the overlay, then we land here.
     *
     *  Returns true when a target was found and scrolled to; false
     *  when neither the highlight span nor the source message article
     *  exists yet (caller should re-arm and try again on the next
     *  render pass — see applyAllNoteHighlights). The flash is a
     *  class toggle; CSS animates a soft lime backdrop → fade.
     *
     *  Fallback: when the highlight span isn't in the DOM (e.g.
     *  notes loaded before the chat rendered, or the saved offsets
     *  don't align with the current text), we still scroll to the
     *  source message article so the user lands in the right region
     *  rather than at the top of the chat. */
    scrollToNote(noteId) {
      if (!noteId) return false;
      const span = document.querySelector(`.note-highlight[data-note-id="${noteId}"]`);
      if (span) {
        try {
          // Instant jump (not smooth) · the smooth animation visibly
          // slides from current position (usually the top of the
          // chat right after innerHTML replacement) to the saved
          // span, which reads as a flicker on initial room open.
          // The lime flash animation kicks in immediately afterward
          // and is enough visual cue that the saved span is "the
          // thing the user came here for" — no need for a slide.
          span.scrollIntoView({ behavior: "auto", block: "center" });
        } catch { /* old browsers · no-op */ }
        // Reveal the chat now that the scroll has landed · openRoom
        // hid it (opacity 0 via body.note-jump-loading) so the user
        // doesn't see the "stale content → repaint → scroll" frame.
        // The CSS transition fades the chat in over ~180ms.
        document.body.classList.remove("note-jump-loading");
        if (this._noteJumpRevealTimer) {
          clearTimeout(this._noteJumpRevealTimer);
          this._noteJumpRevealTimer = null;
        }
        span.classList.add("note-highlight-flash");
        setTimeout(() => span.classList.remove("note-highlight-flash"), 1600);
        // Lock out non-forced auto-scrolls for a grace window so
        // SSE token streams, queue updates, or key-point round-end
        // re-renders that fire during the same render cycle can't
        // snap the chat back to bottom and override the user's
        // intended jump. Forced scrolls (the user sending a
        // message) still fire — those are explicit user actions
        // and should win.
        this.chatStuckToBottom = false;
        this._suppressBottomScrollUntil = Date.now() + 2000;
        // Belt-and-braces · one delayed re-snap covers any path that
        // somehow bypassed the suppression check. Idempotent — if
        // the chat is already at the span, scrollIntoView is a no-op.
        setTimeout(() => {
          const s = document.querySelector(`.note-highlight[data-note-id="${noteId}"]`);
          if (s) {
            try { s.scrollIntoView({ behavior: "auto", block: "center" }); } catch { /* */ }
            this.chatStuckToBottom = false;
          }
        }, 600);
        return true;
      }
      // Span isn't there yet · fall back to the source message article
      // if we know it (look it up in currentNotes). The article is in
      // the DOM as soon as renderChat has run; if even that's missing,
      // bail and let the next render pass retry.
      let messageId = null;
      if (this.currentNotes) {
        for (const list of this.currentNotes.values()) {
          const found = list.find((n) => n.id === noteId);
          if (found) { messageId = found.messageId; break; }
        }
      }
      if (!messageId) return false;
      const article = document.querySelector(`article[data-message-id="${messageId}"]`);
      if (!article) return false;
      try {
        article.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch { /* */ }
      // Return false so the caller keeps `_pendingNoteScroll` armed —
      // when the highlight span eventually paints (next applyAllNote-
      // Highlights cycle), we want to re-trigger the precise scroll +
      // flash, not stop at "good enough."
      return false;
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
      const notesView   = document.querySelector('[data-main-view="notes"]');
      const roomView    = document.querySelector('[data-main-view="room"]');
      if (reportsView) reportsView.setAttribute("hidden", "");
      if (notesView)   notesView.setAttribute("hidden", "");
      if (roomView)    roomView.removeAttribute("hidden");
      // Drop the All-Reports / All-Notes trigger highlights regardless
      // of which composer we're switching to.
      document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-notes-trigger].active").forEach((el) => el.classList.remove("active"));
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
      const MIN = 84;
      const MAX = 360;
      // Quick path · skip the auto-cycle when content already fits.
      // See autosizeAgentComposerTextarea for the why.
      const explicitH = parseInt(ta.style.height, 10) || MIN;
      if (ta.scrollHeight <= explicitH) return;
      ta.style.height = "auto";
      const h = Math.min(MAX, Math.max(MIN, ta.scrollHeight));
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

    /** True when the global Brave Search key is configured · gates the
     *  websearch toggle's "on" state. Reads through window.boardroomKeys
     *  (cached on boot, refetched after any /api/keys mutation), so the
     *  composer reflects the current key state without its own fetch. */
    agentComposerBraveConfigured() {
      try {
        if (typeof window.boardroomKeys !== "function") return false;
        const k = window.boardroomKeys();
        return !!(k && k.brave);
      } catch { return false; }
    },

    /** Read the user's last websearch toggle preference. Defaults TRUE
     *  when the key is configured (the user opted into the feature by
     *  configuring the key, no reason to default OFF) and FALSE when
     *  not configured (no point pretending it's on). */
    loadAgentComposerWebSearch() {
      const configured = this.agentComposerBraveConfigured();
      if (!configured) return false;
      try {
        const raw = localStorage.getItem("boardroom.composer.agent.websearch");
        if (raw === "0") return false;
        if (raw === "1") return true;
      } catch { /* ignore */ }
      return true;
    },

    saveAgentComposerWebSearch(on) {
      try {
        localStorage.setItem("boardroom.composer.agent.websearch", on ? "1" : "0");
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
    AGENT_GEN_STAGES_EN_BASE: [
      { key: "lineage",     label: "Drafting the intellectual profile", startSec: 0,  sub: ["mapping influences", "naming opposed traditions", "picking concrete referents"] },
      { key: "imagine",     label: "Imagining the role",                startSec: 8,  sub: ["sketching tone", "deciding posture", "framing the lens"] },
      { key: "name",        label: "Naming the director",               startSec: 11, sub: ["trying short names", "checking handle slugs"] },
      { key: "bio",         label: "Drafting the bio",                  startSec: 14, sub: ["one or two sentences", "naming the method"] },
      { key: "quote",       label: "Sketching the cover quote",         startSec: 17, sub: ["the opening question they'd ask"] },
      { key: "instruction", label: "Composing the instruction",         startSec: 20, sub: ["lineage + concepts", "method + referent set", "voice + boundaries", "failure modes"] },
      { key: "voice",       label: "Picking the model voice",           startSec: 28, sub: ["matching depth to role"] },
      { key: "polish",      label: "Polishing",                         startSec: 31, sub: ["clamping lengths", "final tightening"] },
    ],
    AGENT_GEN_STAGES_ZH_BASE: [
      { key: "lineage",     label: "勾画智识画像",   startSec: 0,  sub: ["梳理思想脉络", "标记反对的传统", "挑出具体引用"] },
      { key: "imagine",     label: "构思角色",       startSec: 8,  sub: ["勾画语气", "拟定立场", "确定视角"] },
      { key: "name",        label: "起名 + handle",  startSec: 11, sub: ["试几个短名", "排查 handle 重名"] },
      { key: "bio",         label: "起草 bio",       startSec: 14, sub: ["一两句话", "点明方法"] },
      { key: "quote",       label: "写一句开场问",   startSec: 17, sub: ["这位董事每次会议会先问什么"] },
      { key: "instruction", label: "撰写 instruction", startSec: 20, sub: ["脉络 + 概念", "method + 引用集", "语气 + 边界", "失效模式"] },
      { key: "voice",       label: "挑选模型嗓音",   startSec: 28, sub: ["按角色深度匹配 model"] },
      { key: "polish",      label: "收尾打磨",       startSec: 31, sub: ["长度修剪", "最后一遍"] },
    ],
    /** Web-search prefix · prepended to the base list when the user
     *  opted into web search this run. Adds ~5s to the perceived
     *  pipeline; downstream startSecs are shifted in agentGenStagesFor. */
    AGENT_GEN_STAGES_WS_EN: { key: "search", label: "Searching the web for context", startSec: 0, sub: ["refining the query", "scanning Brave results", "distilling 5–6 named sources"] },
    AGENT_GEN_STAGES_WS_ZH: { key: "search", label: "联网检索领域上下文",         startSec: 0, sub: ["精炼查询", "扫描 Brave 结果", "提炼 5–6 条具名来源"] },

    /** Build the active stage list for THIS generation. When web search
     *  is on, prepend the search stage and shift everything else later. */
    agentGenStagesFor(lang) {
      const base = lang === "zh" ? this.AGENT_GEN_STAGES_ZH_BASE : this.AGENT_GEN_STAGES_EN_BASE;
      const useWs = !!this._agentGenUsingWebSearch;
      if (!useWs) return base;
      const wsEntry = lang === "zh" ? this.AGENT_GEN_STAGES_WS_ZH : this.AGENT_GEN_STAGES_WS_EN;
      const SHIFT = 5;
      const shifted = base.map((s) => ({ ...s, startSec: s.startSec + SHIFT }));
      return [wsEntry, ...shifted];
    },

    /** Back-compat shims · existing references read these names directly.
     *  Resolved at call-time so the web-search variant is picked when
     *  the flag is set. */
    get AGENT_GEN_STAGES_EN() { return this.agentGenStagesFor("en"); },
    get AGENT_GEN_STAGES_ZH() { return this.agentGenStagesFor("zh"); },

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
      // If the last attempt failed (timeout or other), render the
      // recovery card with [Retry] / [Discard] · keeps the description
      // around so retry doesn't need a re-type.
      if (this.agentSpecError) {
        return this.renderAgentSpecErrorHtml(this.agentSpecError, lang);
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
              ${(() => {
                // Reuses the agent-profile websearch toggle vocabulary
                // (track + knob + text) so both surfaces feel like the
                // same control. Class set: `ap-skill-row-toggle` +
                // `on` / `off` / `needs-key` modifiers, mirroring the
                // skill row at agent-profile.js:1411.
                const configured = this.agentComposerBraveConfigured();
                const on = configured && this.loadAgentComposerWebSearch();
                const stateLabel = !configured
                  ? (lang === "zh" ? "未配置" : "needs key")
                  : on
                    ? (lang === "zh" ? "已开启" : "enabled")
                    : (lang === "zh" ? "已关闭" : "disabled");
                const titleText = !configured
                  ? (lang === "zh"
                    ? "联网搜索需要 Brave Search API key · 点击配置"
                    : "Web search needs a Brave Search API key · click to configure")
                  : on
                    ? (lang === "zh"
                      ? "生成时联网检索领域真实案例 · 点击关闭"
                      : "Search the web for real domain references during generation · click to disable")
                    : (lang === "zh"
                      ? "生成时不联网 · 点击开启"
                      : "Generation runs offline · click to enable web search");
                const wsLabel = lang === "zh" ? "联网搜索" : "web search";
                const cls = [
                  "ap-skill-row-toggle",
                  "cmp-ws-toggle",
                  on ? "on" : "off",
                  configured ? "" : "needs-key",
                ].filter(Boolean).join(" ");
                return `
                  <button type="button" class="${cls}"
                    data-agent-composer-ws-toggle
                    data-configured="${configured ? "1" : "0"}"
                    data-on="${on ? "1" : "0"}"
                    aria-pressed="${on ? "true" : "false"}"
                    title="${this.escape(titleText)}">
                    <span class="ap-skill-row-toggle-track"><span class="ap-skill-row-toggle-knob"></span></span>
                    <span class="ap-skill-row-toggle-text">${this.escape(wsLabel)} · ${this.escape(stateLabel)}</span>
                  </button>
                `;
              })()}
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

    /** Recovery card · shown when /generate-spec aborted (5-min
     *  timeout) or returned an error. Carries [Retry] (re-runs with
     *  the same stashed description) and [Discard] (clears the
     *  composer back to its input state). The description text is
     *  surfaced read-only so the user can copy it before discard. */
    renderAgentSpecErrorHtml(err, lang) {
      const t = lang === "zh"
        ? {
            kicker: err.kind === "timeout" ? "// 生成超时" : "// 生成失败",
            title: err.kind === "timeout" ? "生成超过 5 分钟仍未完成" : "生成失败",
            hintTimeout: "可能是模型回应过慢、网络波动，或后端 LLM 流水线卡住了。点击重试再来一次。",
            hintFailed: "请确认 API key 配置正确、模型可达。重试通常能解决临时性失败。",
            descLabel: "你的描述（重试时会复用）",
            retry: "重试",
            discard: "放弃",
          }
        : {
            kicker: err.kind === "timeout" ? "// generation timed out" : "// generation failed",
            title: err.kind === "timeout" ? "Generation didn't complete after 5 minutes" : "Generation failed",
            hintTimeout: "The model may be slow, the network flaky, or the backend pipeline stalled. Click retry to start a fresh run.",
            hintFailed: "Check your API key configuration and model reachability. Retry often clears transient failures.",
            descLabel: "Your description (re-used on retry)",
            retry: "Retry",
            discard: "Discard",
          };
      const desc = this._agentComposerLastDesc || "";
      const hint = err.kind === "timeout" ? t.hintTimeout : t.hintFailed;
      const detail = err.message ? `<div class="ag-gen-error-detail">${this.escape(err.message)}</div>` : "";
      return `
        <section class="cmp ag-cmp">
          <header class="cmp-hero">
            <div class="cmp-greet">${this.escape(this.composerGreeting(lang, (this.prefs?.name || "you").trim() || "you"))}</div>
            <h1 class="cmp-prompt">${this.escape(lang === "zh" ? "想招一位什么样的董事？" : "What kind of director do you want?")}</h1>
          </header>
          <div class="ag-gen-error-card">
            <div class="ag-gen-error-kicker">${this.escape(t.kicker)}</div>
            <h2 class="ag-gen-error-title">${this.escape(t.title)}</h2>
            <p class="ag-gen-error-hint">${this.escape(hint)}</p>
            ${detail}
            ${desc ? `
              <div class="ag-gen-error-desc">
                <div class="ag-gen-error-desc-label">${this.escape(t.descLabel)}</div>
                <div class="ag-gen-error-desc-body">${this.escape(desc)}</div>
              </div>
            ` : ""}
            <div class="ag-gen-error-actions">
              <button type="button" class="ag-gen-error-retry" data-agent-spec-retry>
                <span class="ag-gen-error-retry-mark">↻</span>
                <span>${this.escape(t.retry)}</span>
              </button>
              <button type="button" class="ag-gen-error-discard" data-agent-spec-error-discard>
                ${this.escape(t.discard)}
              </button>
            </div>
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
      const MIN = 84;
      const MAX = 360;
      // Quick path · if content fits within the current explicit
      // height (or the min when no explicit height has been set yet),
      // skip the auto-cycle entirely. Without this, every keystroke
      // ran style.height = "auto" → measure → restore, which made the
      // textarea visibly twitch on each input — even when the height
      // wasn't going to change. After the change, short content (any
      // input that fits in the placeholder-sized slot) is a no-op.
      const explicitH = parseInt(ta.style.height, 10) || MIN;
      if (ta.scrollHeight <= explicitH) return;
      // Grow path · content overflowed; reset to auto so scrollHeight
      // reflects the natural content height and resize up.
      ta.style.height = "auto";
      const h = Math.min(MAX, Math.max(MIN, ta.scrollHeight));
      ta.style.height = h + "px";
    },

    /** Hard timeout for /generate-spec · 5 min covers normal multi-stage
     *  generation (Brave search + Stage A profile + Stage B spec) with
     *  generous headroom on slow providers. Past this we abort the
     *  fetch (and server-side LLM work via the propagated signal) and
     *  surface a retry card. */
    AGENT_GEN_TIMEOUT_MS: 5 * 60_000,

    async submitAgentComposer() {
      const ta = document.querySelector("[data-agent-composer-desc]");
      const description = ta ? ta.value.trim() : "";
      if (description.length < 4) {
        if (ta) ta.focus();
        return;
      }
      // Stash the description so "regenerate" / discard / retry can
      // re-use it.
      this._agentComposerLastDesc = description;
      await this._runAgentSpecGeneration(description);
    },

    /** Shared generator · used by submit, redo, and the error-card
     *  retry button. Runs the /generate-spec POST with a 5-minute
     *  AbortController; surfaces success → preview, timeout / failure
     *  → error card (the previous alert() UX cleared on dismiss; this
     *  one stays put so retry doesn't need a re-type). */
    async _runAgentSpecGeneration(description) {
      this.agentSpec = null;
      this.agentSpecError = null;
      this.agentSpecGenerating = true;
      // Snapshot websearch state for THIS run · drives the stage list
      // (whether the "searching the web" prefix shows) and the POST
      // body. Snapshotted up-front so a mid-run toggle change doesn't
      // half-rewrite the visible stages while generation is in flight.
      this._agentGenUsingWebSearch = this.loadAgentComposerWebSearch();
      this.renderEmptyState();
      this.startAgentGenTick();

      // AbortController · used to enforce the 5-min hard timeout AND
      // to clean up cleanly if the user discards mid-flight.
      const ctrl = new AbortController();
      this._agentGenAbort = ctrl;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { ctrl.abort(); } catch { /* ignore */ }
      }, this.AGENT_GEN_TIMEOUT_MS);

      try {
        const r = await fetch("/api/agents/generate-spec", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ description, webSearch: this._agentGenUsingWebSearch }),
          signal: ctrl.signal,
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
        this.agentSpecError = null;
      } catch (e) {
        const isAbort = (e && (e.name === "AbortError" || /aborted/i.test(String(e.message))));
        const lang = this.composerLanguage();
        if (timedOut || isAbort) {
          this.agentSpecError = {
            kind: "timeout",
            message: lang === "zh"
              ? "生成超过 5 分钟仍未完成 · 模型回应慢、网络波动，或后端流水线卡住了。"
              : "Generation took longer than 5 minutes · the model may be slow, the network flaky, or the backend stuck.",
          };
        } else {
          this.agentSpecError = {
            kind: "failed",
            message: (e && e.message ? e.message : String(e)),
          };
        }
      } finally {
        clearTimeout(timer);
        this._agentGenAbort = null;
        this.stopAgentGenTick();
        this.agentSpecGenerating = false;
        this.renderEmptyState();
      }
    },

    /** Retry the last attempt · same description, fresh fetch. Wired
     *  to the [Retry] button on the agent-spec error card. */
    retryAgentSpec() {
      const desc = this._agentComposerLastDesc;
      if (!desc) {
        this.discardAgentSpec();
        return;
      }
      this._runAgentSpecGeneration(desc);
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
      // Cancel any in-flight generation when the user backs out · stops
      // the fetch (and the server-side LLM work via the propagated
      // signal) so we don't keep burning tokens for output the user
      // already discarded.
      if (this._agentGenAbort) {
        try { this._agentGenAbort.abort(); } catch { /* ignore */ }
        this._agentGenAbort = null;
      }
      this.agentSpec = null;
      this.agentSpecAvatarSeed = null;
      this.agentSpecGenerating = false;
      this.agentSpecError = null;
      this.renderEmptyState();
    },

    redoAgentSpec() {
      // Reuse the previous description to generate a fresh spec.
      const desc = this._agentComposerLastDesc;
      if (!desc) {
        this.discardAgentSpec();
        return;
      }
      this._runAgentSpecGeneration(desc);
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

    /** Brief picker · popover anchored under the [View Report] button
     *  on rooms with multiple briefs. Each row is a plain anchor to
     *  /report.html?r=<roomId>&b=<briefId> so middle-click and
     *  cmd-click work as expected; left-click closes the picker after
     *  letting the navigation happen. Closes on outside click / Esc. */
    toggleBriefPicker(anchorBtn) {
      if (document.getElementById("brief-picker-pop")) {
        this.closeBriefPicker();
        return;
      }
      this.openBriefPicker(anchorBtn);
    },
    openBriefPicker(anchorBtn) {
      this.closeBriefPicker();
      const roomId = this.currentRoomId;
      const briefs = Array.isArray(this.currentBriefs) ? this.currentBriefs.slice() : [];
      if (!roomId || briefs.length === 0) return;
      // Sort newest-first · the most recently filed brief is the one a
      // returning user most likely wants to re-open.
      briefs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const lang = (this.currentRoom?.subject && /[一-鿿]/.test(this.currentRoom.subject)) ? "zh" : "en";
      const t = lang === "zh"
        ? { title: "选择一份报告打开", supplementPrefix: "补充视角：", initial: "初版", filed: "已归档" }
        : { title: "Open a report", supplementPrefix: "Supplement: ", initial: "Initial", filed: "filed" };
      const initialIdx = briefs.length - 1; // oldest is "Initial"
      const rows = briefs.map((b, i) => {
        // The numbering is stable across renders: oldest = 01, newest
        // = N. We have to compute the position from the original
        // (createdAt-ascending) order, not the sorted-newest-first
        // index `i`.
        const posFromOldest = briefs.length - i;
        const isInitial = posFromOldest === 1;
        const num = String(posFromOldest).padStart(2, "0");
        const supplementSnippet = b.supplement && b.supplement.trim()
          ? b.supplement.trim().slice(0, 64) + (b.supplement.trim().length > 64 ? "…" : "")
          : "";
        const subtitle = isInitial ? t.initial : (supplementSnippet ? `${t.supplementPrefix}${supplementSnippet}` : "");
        const filedLabel = b.createdAt
          ? new Date(b.createdAt).toLocaleString(lang === "zh" ? "zh-CN" : undefined, {
              year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
            })
          : "";
        const href = `/report.html?r=${encodeURIComponent(roomId)}&b=${encodeURIComponent(b.id)}`;
        return `
          <a class="brief-picker-row" href="${this.escape(href)}" target="_blank" rel="noopener" data-brief-picker-row data-brief-id="${this.escape(b.id)}">
            <span class="brief-picker-num">${this.escape(num)}</span>
            <span class="brief-picker-main">
              <span class="brief-picker-title">${this.escape(b.title || "(untitled)")}</span>
              ${subtitle ? `<span class="brief-picker-sub">${this.escape(subtitle)}</span>` : ""}
            </span>
            ${filedLabel ? `<span class="brief-picker-time">${this.escape(filedLabel)}</span>` : ""}
            <span class="brief-picker-arrow">↗</span>
          </a>
        `;
      }).join("");
      const pop = document.createElement("div");
      pop.id = "brief-picker-pop";
      pop.className = "brief-picker-pop";
      pop.innerHTML = `
        <div class="brief-picker-head">
          <span class="brief-picker-title-head">${this.escape(t.title)}</span>
          <span class="brief-picker-count">${briefs.length}</span>
        </div>
        <div class="brief-picker-list">${rows}</div>
      `;
      document.body.appendChild(pop);
      // Position with viewport collision detection · same pattern as
      // the composer director picker. Anchor under the button by
      // default; flip above when below would clip.
      const r = anchorBtn.getBoundingClientRect();
      const buffer = 16;
      const gap = 6;
      const viewH = window.innerHeight;
      const viewW = window.innerWidth;
      pop.style.position = "fixed";
      const popRect = pop.getBoundingClientRect();
      // Horizontal · right-align to the button (the View Report sits
      // on the right edge of the room header) so the popover anchors
      // visually beneath it.
      const desiredRight = Math.max(buffer, viewW - r.right);
      pop.style.right = desiredRight + "px";
      pop.style.left = "auto";
      // Vertical · prefer below; flip up if it doesn't fit.
      const spaceBelow = viewH - r.bottom - buffer;
      const spaceAbove = r.top - buffer;
      if (spaceBelow >= popRect.height + gap || spaceBelow >= spaceAbove) {
        pop.style.top = (r.bottom + gap) + "px";
        pop.style.bottom = "";
        pop.style.maxHeight = Math.max(160, spaceBelow - gap) + "px";
      } else {
        pop.style.top = "";
        pop.style.bottom = (viewH - r.top + gap) + "px";
        pop.style.maxHeight = Math.max(160, spaceAbove - gap) + "px";
      }
      // Close handlers
      this._briefPickerEsc = (ev) => {
        if (ev.key === "Escape") {
          ev.stopImmediatePropagation();
          this.closeBriefPicker();
        }
      };
      this._briefPickerOutside = (ev) => {
        if (!pop.contains(ev.target) && !ev.target.closest("[data-view-report-trigger]")) {
          this.closeBriefPicker();
        }
      };
      document.addEventListener("keydown", this._briefPickerEsc, true);
      setTimeout(() => document.addEventListener("click", this._briefPickerOutside, true), 0);
    },
    closeBriefPicker() {
      const el = document.getElementById("brief-picker-pop");
      if (el) el.remove();
      if (this._briefPickerEsc) {
        document.removeEventListener("keydown", this._briefPickerEsc, true);
        this._briefPickerEsc = null;
      }
      if (this._briefPickerOutside) {
        document.removeEventListener("click", this._briefPickerOutside, true);
        this._briefPickerOutside = null;
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
      // Position with viewport collision detection. Generous buffer
      // (24px from viewport edges + 8px from the anchor) so the
      // popover never sits flush with the screen edge, and max-height
      // honours the ACTUAL space on the chosen side — no synthetic
      // floor that would otherwise overflow when room is tight (the
      // prior `Math.max(160, cap)` did exactly that and pushed rows
      // off-screen). Decision: prefer the side where the natural
      // popover fits; tie → side with more space; when neither side
      // fits, pick the larger and let internal scroll handle it.
      const r = anchorBtn.getBoundingClientRect();
      const buffer = 24;
      const gap = 8;
      const viewH = window.innerHeight || document.documentElement.clientHeight;
      const spaceBelow = Math.max(0, viewH - r.bottom - buffer);
      const spaceAbove = Math.max(0, r.top - buffer);
      const naturalH = pop.offsetHeight;
      let placeBelow;
      if (naturalH <= spaceBelow) placeBelow = true;
      else if (naturalH <= spaceAbove) placeBelow = false;
      else placeBelow = spaceBelow >= spaceAbove;
      const cap = placeBelow ? spaceBelow : spaceAbove;
      pop.style.maxHeight = cap + "px";
      pop.style.left = Math.max(8, r.left) + "px";
      if (placeBelow) {
        pop.style.top = (r.bottom + gap) + "px";
        pop.style.bottom = "";
      } else {
        pop.style.top = "";
        pop.style.bottom = (viewH - r.top + gap) + "px";
      }
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
      // Detect follow-up context · same `.cmp-dd` markup, but the
      // trigger lives inside the follow-up overlay, so the active
      // state is read off the trigger itself (and writes go back to
      // the trigger on pick — see global click handler) rather than
      // composerState used by the inline new-room composer.
      const followUpScope = triggerBtn.closest("#followup-overlay");
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
        if (followUpScope) {
          const valSpan = triggerBtn.querySelector("[data-cmp-dd-value]");
          current = valSpan ? (valSpan.textContent || "").trim().toLowerCase() : "";
        } else {
          current = state.mode;
        }
      } else if (kind === "intensity") {
        // Hints describe the LENGTH outcome, not adversarial intent —
        // the third value (terse) is a cadence dial, not a harshness
        // dial. The earlier "no prisoners" / "直击痛点" copy pulled
        // users into thinking it controlled tone.
        opts = lang === "zh"
          ? [
              { v: "calm",  label: "Calm",  hint: "慢慢说" },
              { v: "sharp", label: "Sharp", hint: "不绕弯" },
              { v: "terse", label: "Terse", hint: "一句话" },
            ]
          : [
              { v: "calm",  label: "Calm",  hint: "let them think" },
              { v: "sharp", label: "Sharp", hint: "no hedging" },
              { v: "terse", label: "Terse", hint: "telegraphic" },
            ];
        if (followUpScope) {
          const valSpan = triggerBtn.querySelector("[data-cmp-dd-value]");
          current = valSpan ? (valSpan.textContent || "").trim().toLowerCase() : "";
        } else {
          current = state.intensity;
        }
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
      // Leading expand button — naked CSS-glyph (▸ from ::before),
      // matching the .sidebar-collapse-btn vocabulary. Visible only
      // when body.sidebar-collapsed (CSS-gated). Always rendered so
      // the DOM stays stable; the collapsed state flips room-head's
      // grid template to a 3-track layout so this button takes the
      // leading auto-track slot.
      head.innerHTML = `
        <button type="button" class="room-head-expand" data-sidebar-expand title="Expand sidebar" aria-label="Expand sidebar"></button>
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
            ? (() => {
                // Multiple briefs · render the View Report button as a
                // popover trigger (the current brief still wins as the
                // default if the user middle-clicks / opens in new tab,
                // since the href is preserved). The click handler at
                // [data-view-report-trigger] cancels navigation and
                // opens the picker.
                const briefs = Array.isArray(this.currentBriefs) ? this.currentBriefs : [];
                const multi = briefs.length > 1;
                const directHref = `/report.html?r=${this.escape(r.id)}${this.currentBrief.id ? `&b=${this.escape(this.currentBrief.id)}` : ""}`;
                if (!multi) {
                  return `<a href="${directHref}" target="_blank" rel="noopener" class="view-report-btn" data-view-report>[ View Report ]</a>`;
                }
                return `<a href="${directHref}" target="_blank" rel="noopener" class="view-report-btn" data-view-report data-view-report-trigger title="${this.escape(this.composerLanguage() === "zh" ? `${briefs.length} 份报告 · 点击选择` : `${briefs.length} reports · click to choose`)}">[ View Report <span class="vr-count">· ${briefs.length}</span> ▾ ]</a>`;
              })()
            : (r.status === "adjourned"
              ? `<a href="#" class="view-report-btn generate-report" data-generate-brief title="${this.escape(this.composerLanguage() === "zh" ? "为这次会议补出一份报告" : "File a brief from this session")}"><span class="vr-mark">▸</span> ${this.escape(this.composerLanguage() === "zh" ? "生成报告" : "Generate Report")}</a>`
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
      // Apply chairman's-notes highlights for every message in the
      // freshly-rendered chat. Single pass over this.currentNotes
      // since the full DOM was just replaced.
      this.applyAllNoteHighlights();
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
      // Apply highlights for the newly-appended message · cheap
      // (single message, single map lookup) and keeps brand-new
      // bubbles consistent with the rest of the chat.
      this.applyNoteHighlightsForMessage(msg.id);
    },

    /** "Thinking…" bouncing-dots placeholder shown before the first token. */
    thinkingHtml() {
      return '<span class="thinking-dots"><span></span><span></span><span></span></span>';
    },

    /** Show a transient "Chair is preparing…" placeholder card at the
     *  bottom of the chat. Bridges silent server-side phases (haiku
     *  discipline gate, pre-fetch tools, LLM startup) where the user
     *  would otherwise see nothing happening between submitting their
     *  question and the chair's streaming bubble appearing. Cleared on
     *  any chair message-appended, on clarify-ready, on room-paused,
     *  or after a 60s safety timeout. Idempotent — repeated calls
     *  refresh the existing card rather than stacking duplicates. */
    showChairPending(phase) {
      const chat = document.querySelector("[data-chat-messages]");
      if (!chat) return;
      const existing = chat.querySelector("[data-chair-pending]");
      const isCjk = /[一-鿿]/.test(this.currentRoom?.subject || "");
      const chairName = (this.currentChair?.name) || (isCjk ? "主席" : "Chair");
      const labelMap = isCjk
        ? { clarify: "正在整理你的问题", "chair-direct": "正在准备回应", "round-end": "正在收束这一轮", convening: "正在召集会议", "next-speaker": "正在判断接下来的发言", chair: "正在准备" }
        : { clarify: "is reading your question", "chair-direct": "is preparing a response", "round-end": "is wrapping up the round", convening: "is convening the room", "next-speaker": "is reading the room", chair: "is preparing" };
      const phraseRaw = labelMap[phase] || labelMap.chair;
      const phrase = `${chairName} ${phraseRaw}…`;
      if (existing) {
        const span = existing.querySelector(".cp-text");
        if (span) span.textContent = phrase;
        return;
      }
      const node = document.createElement("div");
      node.className = "chair-pending";
      node.setAttribute("data-chair-pending", "");
      node.innerHTML = `
        <div class="cp-rule" aria-hidden="true"></div>
        <div class="cp-kicker">▸ ${this.escape(isCjk ? "主席" : "chair")}</div>
        <div class="cp-body">
          <span class="cp-text">${this.escape(phrase)}</span>
          <span class="thinking-dots"><span></span><span></span><span></span></span>
        </div>
      `;
      chat.appendChild(node);
      this.scrollChatToBottom(false);
      // Safety timeout · if no chair message and no clear event arrives
      // within 60s the placeholder lingers forever otherwise.
      if (this._chairPendingTimer) clearTimeout(this._chairPendingTimer);
      this._chairPendingTimer = setTimeout(() => this.hideChairPending(), 60_000);
    },

    /** Remove the chair-pending placeholder if present. Safe to call
     *  when no placeholder exists. */
    hideChairPending() {
      if (this._chairPendingTimer) {
        clearTimeout(this._chairPendingTimer);
        this._chairPendingTimer = null;
      }
      const chat = document.querySelector("[data-chat-messages]");
      if (!chat) return;
      const existing = chat.querySelector("[data-chair-pending]");
      if (existing) existing.remove();
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
        // Re-apply chairman's-notes highlights · the bubble's
        // innerHTML rewrite above wipes any previously-injected
        // .note-highlight spans. Skip mid-stream (offsets won't match
        // partial text) and reapply once streaming finishes.
        if (!streaming) {
          this.applyNoteHighlightsForMessage(messageId);
        }
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
        // Skeleton ONLY while actively streaming. If streaming has
        // finished but points are still empty (parser couldn't extract
        // any from the chair's body — rare, but happens when the model
        // drops the format), render a DEGRADED card with continue /
        // adjourn but no vote chips. The earlier failure mode here
        // was an indefinite "drafting key points…" lock-up because the
        // skeleton kept rendering after streaming ended.
        if (isStreaming) {
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
                <span class="kp-pending-text">Chair is drafting key points…</span>
              </div>
            </div>
          `;
        }
        // Degraded card · streaming finished, points empty. Show
        // continue/adjourn so the user can still progress the room.
        const ctasDegraded = awaiting
          ? `
            <div class="kp-ctas">
              <button type="button" class="kp-cta primary" data-continue>[ ▶ Continue · next round ]</button>
              <button type="button" class="kp-cta ghost" data-adjourn-from-chair>[ ⊘ Adjourn &amp; file brief ]</button>
            </div>
          `
          : `<div class="kp-ctas-spent">// continued</div>`;
        return `
          <div class="round-end-card" data-round-end-card="${this.escape(messageId)}">
            <div class="kp-eyebrow kp-eyebrow-degraded">▸ key points · couldn't be parsed from this round</div>
            ${ctasDegraded}
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
      // Tone-shift proposal · the chair's optional MODE-SHIFT/BECAUSE
      // pair, parsed server-side and surfaced on this card. When
      // present, the standard [Continue] button is replaced with two
      // explicit branches so the user sees the alternatives clearly.
      // Disappears once the round is resumed (kp-ctas-spent path).
      const shift = msg && msg.meta && msg.meta.modeShiftProposal;
      const shiftCallout = (shift && awaiting)
        ? `
          <div class="kp-mode-shift">
            <div class="kp-shift-eyebrow">▸ chair suggests · switch tone to <strong>${this.escape(shift.to)}</strong></div>
            <div class="kp-shift-because">${this.escape(shift.because)}</div>
          </div>
        `
        : "";
      let ctas;
      if (!awaiting) {
        ctas = `<div class="kp-ctas-spent">// continued</div>`;
      } else if (shift) {
        // 3-button layout · primary takes ~50% of the row, the two
        // secondaries split the rest. Without `kp-ctas-shift`, three
        // `flex: 1` buttons squeeze each label to ~33% width and the
        // longer "switch to constructive" label wraps to two lines.
        // Labels stripped of "& continue" — the action is implicit
        // in this round-end context.
        const currentMode = (this.currentRoom?.mode || "").toLowerCase();
        ctas = `
          <div class="kp-ctas kp-ctas-shift">
            <button type="button" class="kp-cta primary" data-shift-accept data-shift-to="${this.escape(shift.to)}">[ ↻ switch to ${this.escape(shift.to)} ]</button>
            <button type="button" class="kp-cta ghost" data-continue>[ keep ${this.escape(currentMode || "current")} ]</button>
            <button type="button" class="kp-cta ghost" data-adjourn-from-chair>[ ⊘ adjourn ]</button>
          </div>
        `;
      } else {
        ctas = `
          <div class="kp-ctas">
            <button type="button" class="kp-cta primary" data-continue>[ ▶ Continue · next round ]</button>
            <button type="button" class="kp-cta ghost" data-adjourn-from-chair>[ ⊘ Adjourn &amp; file brief ]</button>
          </div>
        `;
      }
      return `
        <div class="round-end-card" data-round-end-card="${this.escape(messageId)}">
          <div class="kp-eyebrow">▸ key points · vote what you want pursued</div>
          <div class="kp-list">${items}</div>
          ${shiftCallout}
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
        // Long openers (the user wrote more than a couple of sentences
        // of context) get clamped behind a fade with a "Show more"
        // toggle so the card doesn't dominate the viewport. Clamp is
        // tight (~4 lines of body text) so even mid-length openers
        // collapse — the user can always one-click to read the full
        // text. Toggle handler lives at doc level (see init).
        const isLongOpener = (m.body || "").length > 100;
        // Follow-up rooms get an "origin" row above the question that
        // names the parent room (number + subject) and links back to
        // it via the hash route. Without this, a follow-up looks
        // identical to a fresh room — there's no signal that the cast
        // is treating it as continuation. Lookup uses the sidebar's
        // rooms list since it's already loaded; if the parent isn't
        // there yet (rare race) we fall back to a reference-only line.
        const parentId = this.currentRoom?.parentRoomId;
        let originHtml = "";
        if (parentId) {
          const parent = (this.rooms || []).find((r) => r.id === parentId);
          const parentNum = parent?.number ?? "?";
          const parentSubject = (parent?.subject || "").trim();
          const truncated = parentSubject.length > 70
            ? parentSubject.slice(0, 70) + "…"
            : parentSubject;
          const isZh = /[一-鿿]/.test(this.currentRoom?.subject || "");
          const label = isZh ? "继续自" : "Following up on";
          const roomTag = isZh ? "Room #" : "Room #";
          const subjectChunk = truncated
            ? `<span class="convene-origin-sep">·</span><span class="convene-origin-subject">${this.escape(truncated)}</span>`
            : "";
          originHtml = `
            <a class="convene-origin" href="#/r/${this.escape(parentId)}" data-parent-room-id="${this.escape(parentId)}" title="${this.escape((isZh ? "返回上一场会议 · " : "Open the prior session · ") + (parentSubject || parentId))}">
              <span class="convene-origin-arrow">↩</span>
              <span class="convene-origin-label">${this.escape(label)}</span>
              <span class="convene-origin-room">${this.escape(roomTag)}${this.escape(String(parentNum))}</span>
              ${subjectChunk}
            </a>
          `;
        }
        const articleCls = [
          "convene-opener",
          parentId ? "convene-opener-followup" : "",
          isLongOpener ? "convene-opener-clamped" : "",
        ].filter(Boolean).join(" ");
        const isZhLang = /[一-鿿]/.test(m.body || "") || /[一-鿿]/.test(this.currentRoom?.subject || "");
        const moreLabel = isZhLang ? "展开全文 ↓" : "Show more ↓";
        const lessLabel = isZhLang ? "收起 ↑" : "Show less ↑";
        const toggleHtml = isLongOpener
          ? `<button type="button" class="convene-toggle" data-convene-toggle data-more="${this.escape(moreLabel)}" data-less="${this.escape(lessLabel)}">${moreLabel}</button>`
          : "";
        return `
          <article class="${articleCls}" data-message-id="${this.escape(m.id)}">
            <div class="convene-eyebrow">▸ Convene · Initial Question</div>
            ${originHtml}
            <h2 class="convene-body">${this.renderBody(m.body)}</h2>
            ${toggleHtml}
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
      //
      // CTA · "Generate report now" button surfaces when the room is
      // adjourned + no brief exists yet. The user can change their
      // mind without opening a follow-up room. Hidden once a brief
      // has been filed (currentBrief !== null) — the card then reads
      // as a historical marker only.
      if (isChair && metaKind === "no-brief") {
        const ts = this.timeFmt(m.createdAt);
        const isZh = this.composerLanguage() === "zh";
        const hasBrief = !!this.currentBrief;
        const cta = hasBrief
          ? ""
          : `
            <div class="nb-actions">
              <button type="button" class="nb-cta" data-generate-brief>
                <span class="nb-cta-mark">▸</span>
                <span class="nb-cta-text">${isZh ? "生成报告" : "Generate report now"}</span>
              </button>
            </div>
          `;
        return `
          <div class="no-brief-card" data-message-id="${this.escape(m.id)}">
            <span class="nb-chip">
              <span class="nb-mark">⊘</span>
              <span class="nb-eyebrow">adjourned · no brief filed</span>
            </span>
            <div class="nb-body">
              <strong>${this.escape(this.prefs?.name || "The chair")}</strong> ${isZh ? "在结束时跳过了报告。" : "declared no report is needed for this session."}
            </div>
            ${cta}
            <div class="nb-meta">${this.escape(ts)}</div>
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

    /** Word / character count for a finished brief body. Returns a
     *  formatted label (e.g. "3,247 words" or "约 4,500 字") or null
     *  when the body is empty / mid-stream. Stripping markdown
     *  decoration before counting keeps the figure honest — without
     *  it, every `**` and `## ` would inflate an EN count and every
     *  Chinese fenced kicker would distort the ZH char total. */
    _briefWordCount(brief) {
      const md = (brief && brief.bodyMd) || "";
      if (!md.trim()) return null;
      const stripped = md
        .replace(/```[\s\S]*?```/g, "")            // fenced code blocks
        .replace(/`[^`\n]*`/g, "")                  // inline code
        .replace(/!\[[^\]]*\]\([^)]+\)/g, "")       // images
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")    // links → label only
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")         // ATX headings
        .replace(/^\s*>\s?/gm, "")                  // blockquote markers
        .replace(/^\s*[-*+]\s+/gm, "")              // unordered list markers
        .replace(/^\s*\d+[.)]\s+/gm, "")            // ordered list markers
        .replace(/\*\*|__|\*|_|~~/g, "")            // emphasis decoration
        .replace(/\|/g, " ")                        // table column dividers
        .replace(/<[^>]+>/g, " ")                   // raw HTML tags
        .replace(/&[a-z]+;/gi, " ");                // HTML entities
      const cjk = stripped.match(/[一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ]/g);
      const cjkCount = cjk ? cjk.length : 0;
      const isCjk = cjkCount >= stripped.length * 0.3 && cjkCount > 80;
      let count;
      let label;
      if (isCjk) {
        count = cjkCount;
        label = `~${count.toLocaleString("en-US")} 字`;
      } else {
        const words = stripped.trim().split(/\s+/).filter((w) => w.length > 0);
        count = words.length;
        if (count === 0) return null;
        label = count === 1 ? "1 word" : `${count.toLocaleString("en-US")} words`;
      }
      // Tone-aware sweet band · brainstorm recaps run lean (concrete
      // ideas, not deep analysis); standard rooms (constructive /
      // debate) land in the middle; research / critique rooms shoulder
      // a denser shape (assumptions + scenarios + indicators + threats
      // to validity all naturally lengthen the body).
      const tone = (this.currentRoom?.mode || "constructive").toLowerCase();
      const bandKind = tone === "brainstorm"
        ? "lean"
        : (tone === "research" || tone === "critique" ? "dense" : "standard");
      // Brainstorm `lean` was originally 600-1500 zh / 400-1000 en —
      // calibrated against "quick recap" briefs with 1-2 directors.
      // That undercounted real brainstorm rooms: 3-4 directors × 2-3
      // rounds × 2-3 ideas-per-turn easily produces 12-20 ideas, each
      // worth 80-150 words (concept + why-it-matters + what-it-opens).
      // 1500-2200 words / 2000-3000 字 is a healthy, idea-dense
      // brainstorm — bumping the band so that lands in `sweet`, not
      // `dense`. Standard / dense bands unchanged.
      const bands = isCjk
        ? ({
            lean:     { sweetLo: 1000, sweetHi: 2200, denseHi: 3800, longHi: 5500 },
            standard: { sweetLo: 1500, sweetHi: 2800, denseHi: 4500, longHi: 6500 },
            dense:    { sweetLo: 2500, sweetHi: 4500, denseHi: 6500, longHi: 8000 },
          })[bandKind]
        : ({
            lean:     { sweetLo: 800,  sweetHi: 1600, denseHi: 2800, longHi: 4000 },
            standard: { sweetLo: 1000, sweetHi: 1800, denseHi: 3000, longHi: 4500 },
            dense:    { sweetLo: 1800, sweetHi: 3000, denseHi: 4500, longHi: 5500 },
          })[bandKind];
      let tier;
      if (count < bands.sweetLo)        tier = "thin";
      else if (count <= bands.sweetHi)  tier = "sweet";
      else if (count <= bands.denseHi)  tier = "dense";
      else if (count <= bands.longHi)   tier = "long";
      else                              tier = "too-long";
      return { label, tier, count, isCjk, tone, bands };
    },

    /** Tooltip explaining what the brief-card word-count chip's colour
     *  means · tone-aware so the user understands why a 2,500-word
     *  brainstorm recap reads "dense" while the same length in a
     *  research note reads "sweet." */
    _briefWordCountTip(wc) {
      if (!wc) return "";
      const isZh = wc.isCjk;
      const toneLabel = ({
        brainstorm:   isZh ? "脑暴" : "brainstorm",
        constructive: isZh ? "构建" : "constructive",
        debate:       isZh ? "辩论" : "debate",
        research:     isZh ? "研究" : "research",
        critique:     isZh ? "评审" : "critique",
      })[wc.tone] || wc.tone;
      const range = `${wc.bands.sweetLo.toLocaleString("en-US")}-${wc.bands.sweetHi.toLocaleString("en-US")}`;
      const unit = isZh ? "字" : "words";
      const copy = isZh
        ? {
            "thin":     `偏短 · ${toneLabel} 模式甜点区约 ${range} ${unit}`,
            "sweet":    `甜点区 · ${toneLabel} 模式正合适`,
            "dense":    `偏密集 · 已超出 ${toneLabel} 模式甜点区，但仍可读`,
            "long":     `偏长 · 接近"会被存档而非阅读"的临界`,
            "too-long": `过长 · 大概率会被快速跳读`,
          }
        : {
            "thin":     `Lean · ${toneLabel} sweet zone is ${range} ${unit}`,
            "sweet":    `Sweet zone for ${toneLabel} · most read-through-able length`,
            "dense":    `Dense · past the ${toneLabel} sweet zone, still readable`,
            "long":     `Long · approaching "filed instead of read"`,
            "too-long": `Too long · likely to be skimmed, not read`,
          };
      return copy[wc.tier] || "";
    },

    /** Render the brief version tab strip · shared by both the error
     *  and success paths in renderBrief. Earlier the error path
     *  rendered no tabs at all — selecting a failed-brief tab left
     *  the user with only the retry card and no path back to the good
     *  briefs. Returns "" when there are <2 briefs (no tab strip). */
    _renderBriefTabsHtml(activeBrief) {
      const briefs = Array.isArray(this.currentBriefs) ? this.currentBriefs : [];
      if (briefs.length < 2) return "";
      const sortedBriefs = briefs.slice().sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
      const lang = (activeBrief && activeBrief.language === "zh")
        || (this.currentRoom?.subject && /[一-鿿]/.test(this.currentRoom.subject))
        ? "zh" : "en";
      return `
        <div class="brief-versions">
          ${sortedBriefs.map((bf, i) => {
            const isActive = activeBrief && bf.id === activeBrief.id;
            const num = String(i + 1).padStart(2, "0");
            const isInitial = i === 0;
            const supp = bf.supplement && bf.supplement.trim()
              ? bf.supplement.trim()
              : (isInitial ? (lang === "zh" ? "初版" : "Initial") : "");
            const tooltip = isInitial
              ? (lang === "zh" ? `初版报告 · 由会议本身生成` : `Initial brief · generated from the session`)
              : `${lang === "zh" ? "补充视角：" : "Supplement: "}${supp || "—"}`;
            const closeTitle = lang === "zh" ? "删除这份报告" : "Delete this report";
            // Errored / interrupted / timed-out tabs get a small
            // visual marker so the user can spot which one needs
            // attention without entering it. The full retry UI is
            // still gated on selecting the tab (bypassSalvage path).
            const stateMark = (bf.error || bf.interrupted || bf.timedOut)
              ? `<span class="brief-version-state" aria-hidden="true">!</span>`
              : "";
            return `
              <span class="brief-version-tab-wrap${isActive ? " active" : ""}">
                <button type="button" class="brief-version-tab${isActive ? " active" : ""}" data-brief-tab data-brief-id="${this.escape(bf.id)}" title="${this.escape(tooltip)}">
                  <span class="brief-version-num">${num}</span>
                  ${stateMark}
                  ${isInitial
                    ? `<span class="brief-version-label">${lang === "zh" ? "初版" : "Initial"}</span>`
                    : `<span class="brief-version-label">${this.escape((supp || "").slice(0, 20))}${(supp || "").length > 20 ? "…" : ""}</span>`}
                </button>
                <button type="button" class="brief-version-close" data-brief-delete data-brief-id="${this.escape(bf.id)}" title="${this.escape(closeTitle)}" aria-label="${this.escape(closeTitle)}">×</button>
              </span>
            `;
          }).join("")}
        </div>
      `;
    },

    renderBrief(opts) {
      // bypassSalvage · when true, render the failed brief's full
      // error UI instead of falling back to the prior good brief.
      // Used by the tab-click handler so the user can explicitly
      // navigate INTO a failed brief to read its error details +
      // retry from the standard error card. Without this bypass, the
      // salvage path captured every error render, including the
      // user's own click — clicking the failed tab simply re-rendered
      // the good brief, making the failed tab feel un-clickable.
      const bypassSalvage = !!(opts && opts.bypassSalvage);
      const card = document.querySelector("[data-brief-card]");
      if (!card) return;
      if (!this.currentBrief) {
        card.innerHTML = "";
        card.classList.remove("ending-block");
        // Even with no brief yet (e.g. just-adjourned, generation
        // hasn't started), analytics should still show for an
        // adjourned room. Call out so the fallback "outside the
        // brief container" insertion path runs.
        this.renderSessionAnalytics();
        return;
      }
      card.classList.add("ending-block");
      const b = this.currentBrief;

      // Tab strip · computed up-front so BOTH the error path and the
      // success path can mount it. Earlier the error path wiped the
      // tabs entirely (only the retry card rendered) — selecting a
      // failed-brief tab would leave no way back to the good briefs.
      // The helper sees `currentBrief` to mark the active tab.
      const tabsStripHtml = this._renderBriefTabsHtml(b);

      // Error path: a compact error card with a retry button. Three
      // sub-cases:
      //   · timedOut (no completion after 5 min wall-clock) → "took
      //     too long" copy with the elapsed-time reason inline
      //   · interrupted (zombie placeholder from a refresh / restart) →
      //     specific copy + Regenerate CTA
      //   · generic LLM failure → original "needs an API key" hint
      //
      // Salvage path · if a PRIOR brief was filed successfully, don't
      // bury it behind the failed brief's error card. Render the good
      // brief in full and overlay a compact retry banner above it so
      // the user keeps reading the previous report while seeing that
      // the regeneration didn't take. Only the standalone failure
      // (no prior good brief) gets the full-card error treatment.
      if (b.error) {
        // Skip salvage when the caller explicitly asked for the full
        // error UI (typically a user-initiated tab click). Otherwise
        // a failed-brief tab becomes unreachable — clicking it just
        // re-renders whichever good brief the salvage path picks.
        const goodBrief = bypassSalvage ? null : (this.currentBriefs || []).find(
          (x) => x && x.id !== b.id && !x.error && x.bodyMd && x.bodyMd.trim().length > 0,
        );
        if (goodBrief) {
          const failed = b;
          const prevCurrent = this.currentBrief;
          this.currentBrief = goodBrief;
          try { this.renderBrief(); }
          finally { this.currentBrief = prevCurrent; }
          // Prepend the compact retry banner to the rendered card so
          // the existing report stays fully visible below it.
          const lang = (failed.language === "zh" || (this.currentRoom?.subject && /[一-鿿]/.test(this.currentRoom.subject))) ? "zh" : "en";
          const detail = failed.timedOut
            ? (lang === "zh" ? "重新生成超时" : "regeneration timed out")
            : failed.interrupted
              ? (lang === "zh" ? "重新生成被中断" : "regeneration interrupted")
              : (failed.error || (lang === "zh" ? "重新生成失败" : "regeneration failed"));
          const cta = lang === "zh" ? "重试" : "Retry";
          const dismiss = lang === "zh" ? "关闭" : "Dismiss";
          card.insertAdjacentHTML("afterbegin", `
            <div class="brief-retry-banner" data-brief-retry-banner data-failed-brief-id="${this.escape(failed.id)}">
              <span class="brb-mark">⚠</span>
              <span class="brb-text">${this.escape(detail)}</span>
              <button type="button" class="brb-retry" data-brief-retry data-target-brief-id="${this.escape(failed.id)}">
                <span class="brb-retry-mark">↻</span>
                <span>${this.escape(cta)}</span>
              </button>
              <button type="button" class="brb-dismiss" data-brief-banner-dismiss aria-label="${this.escape(dismiss)}" title="${this.escape(dismiss)}">✕</button>
            </div>
          `);
          return;
        }
        const lang = (b.language === "zh" || (this.currentRoom?.subject && /[一-鿿]/.test(this.currentRoom.subject))) ? "zh" : "en";
        const copy = b.timedOut
          ? (lang === "zh"
            ? {
                stamp: "timed out",
                kicker: "// 报告生成超时",
                detail: "已超过 8 分钟仍未收到完成信号 · 可能是模型回应过慢、网络中断，或后端流水线卡住了。点击下方按钮重试，或检查 LLM key 与网络后再试。",
                hint: "",
                cta: "重试",
              }
            : {
                stamp: "timed out",
                kicker: "// generation timed out",
                detail: "No completion signal after 8 minutes — the model may be slow, the connection dropped, or the pipeline stalled. Click below to start a fresh run.",
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
            ${tabsStripHtml}
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
        // Re-anchor analytics here too · error path also wipes innerHTML.
        this.renderSessionAnalytics();
        return;
      }

      const generating = b.isGenerating === true || !b.bodyMd || b.title === "Generating…";
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

      // Tab strip — already computed at the top of renderBrief as
      // `tabsStripHtml` so both error and success paths can mount it.
      const tabsHtml = tabsStripHtml;

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
              : (() => {
                  const wc = this._briefWordCount(b);
                  const tip = this._briefWordCountTip(wc);
                  return `<div class="brief-info">
                    <div class="brief-kicker">// filed by ${this.escape(this.currentChair?.name || "the chair")}</div>
                    <h2 class="brief-title" data-brief-title>${this.escape(b.title || "(untitled)")}</h2>
                    <div class="brief-meta-row">
                      <span class="brief-meta-line">${this.currentMembers.length} authors</span>
                      ${wc ? `<span class="brief-meta-sep" aria-hidden="true">·</span><span class="brief-meta-line brief-meta-words is-${this.escape(wc.tier)}" title="${this.escape(tip)}">${this.escape(wc.label)}</span>` : ""}
                      <div class="brief-signed">
                        <div class="brief-signed-avatars">${signed}</div>
                      </div>
                    </div>
                  </div>`;
                })()
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
      // Re-anchor the session-analytics tile after every brief
      // re-render. Analytics is inserted INSIDE [data-brief-card]
      // (between the divider header and the brief card itself), and
      // setting card.innerHTML above wipes it. Without this call,
      // analytics would flicker into existence after the initial
      // adjourn refetch and then vanish on the very next brief
      // SSE event (brief-started / brief-token / brief-final). The
      // re-render is idempotent and cheap (small DOM, no fetch).
      this.renderSessionAnalytics();
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
      extract:             { eta: [5, 15] },
      compose:             { eta: [1, 4] },
      "scaffold-anchor":   { eta: [3, 8] },
      "scaffold-findings": { eta: [4, 12] },
      "scaffold-cluster":  { eta: [3, 8] },
      "scaffold-actions":  { eta: [4, 12] },
      write:               { eta: [30, 90] },
    },
    BRIEF_SUBSTAGES: {
      en: {
        extract: [
          "Re-reading each director's contributions",
          "Tagging signals by lens (data / dissent / narrative / structural / first-principle)",
          "Tightening to 2–4 signals per director",
        ],
        compose: [
          "Picking the spine for this brief",
          "Choosing which component blocks fit",
          "Sizing density and rhythm",
        ],
        "scaffold-anchor": [
          "Reading the takeaway",
          "Sizing the confidence call",
          "Setting the working hypothesis",
        ],
        "scaffold-findings": [
          "Pulling out the headline findings",
          "Cross-checking each finding to the anchor",
          "Tightening 3 → 2 if a finding wobbles",
        ],
        "scaffold-cluster": [
          "Mapping where the directors converged",
          "Surfacing the central tension",
          "Spotting positions that didn't quite resolve",
        ],
        "scaffold-actions": [
          "Drafting recommendations",
          "Mapping the pre-mortem",
          "Surfacing the new questions the room opened",
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
        compose: [
          "选定本份报告的 spine 风格",
          "决定要纳入哪些组件块",
          "估算密度与节奏",
        ],
        "scaffold-anchor": [
          "读出 takeaway",
          "校准 confidence",
          "落定 working hypothesis",
        ],
        "scaffold-findings": [
          "提炼 3 条 headline findings",
          "复核每条是否撑住 anchor",
          "如有勉强，3 → 2 收敛",
        ],
        "scaffold-cluster": [
          "定位董事们达成共识的地方",
          "标记核心张力",
          "辨认未消化的立场",
        ],
        "scaffold-actions": [
          "起草 recommendations",
          "推演 pre-mortem",
          "梳理会议长出的新问题",
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
        const generating = b.isGenerating === true || !b.bodyMd || b.title === "Generating…";
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
    // Bumped 5 → 8 min · large rooms with many directors + dense
    // material legitimately take 5+ min through stage 1 (parallel
    // extracts) + stage 2 (scaffold, sometimes retried) + stage 3
    // (long streaming). The earlier 5-min ceiling was triggering
    // even on healthy generation. Server-side stage-2 retries are
    // also reduced from 3 → 2 to keep total comfortably under this.
    BRIEF_HARD_TIMEOUT_MS: 8 * 60_000,
    BRIEF_WATCH_INTERVAL_MS: 10_000,

    markBriefEvent() {
      this._lastBriefEventAt = Date.now();
    },

    ensureBriefStallWatch() {
      if (this._briefStallWatchTimer) return;
      const b = this.currentBrief;
      if (!b || !b.id || b.error) return;
      const generating = b.isGenerating === true || !b.bodyMd || b.title === "Generating…";
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
      const generating = b.isGenerating === true || !b.bodyMd || b.title === "Generating…";
      if (!generating) { this.stopBriefStallWatch(); return; }

      const now = Date.now();
      const startedAt = b.pipelineStartedAt || this._lastBriefEventAt || now;

      // Hard ceiling · regardless of server state, flip the card to
      // a timed-out error so the user always has a way out.
      if (now - startedAt > this.BRIEF_HARD_TIMEOUT_MS) {
        b.error = b.language === "zh"
          ? "报告生成超时（超过 8 分钟仍未完成）。"
          : "Brief generation timed out (no completion after 8 minutes).";
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

    /** Render the multi-stage progress shown while the brief is generating.
     *
     *  Layout · single tall "active card" carrying the full visual weight
     *  of the current stage, with a horizontal pip rail underneath that
     *  shows where we are in the overall sequence. Past stages collapse
     *  into ticked pips; future stages are ghost outlines. The card has
     *  a thin lime progress line along its bottom that fills with elapsed
     *  / ETA (capped at 95% past upper-bound, so it never lies about
     *  being done). The kicker line on top carries the cumulative ETA so
     *  the user can answer "how much longer" in one glance.
     *
     *  Container is N-stage-ready · adding a stage = append to STAGE_DEFS
     *  (and emit the matching brief-stage events server-side). The pip
     *  rail and total-ETA scale automatically. */
    renderBriefStages(b) {
      const stages = b.stages || {
        extract:             { status: "active",  detail: "", progress: null, startedAt: null },
        compose:             { status: "pending", detail: "", progress: null, startedAt: null },
        "scaffold-anchor":   { status: "pending", detail: "", progress: null, startedAt: null },
        "scaffold-findings": { status: "pending", detail: "", progress: null, startedAt: null },
        "scaffold-cluster":  { status: "pending", detail: "", progress: null, startedAt: null },
        "scaffold-actions":  { status: "pending", detail: "", progress: null, startedAt: null },
        write:               { status: "pending", detail: "", progress: null, startedAt: null },
      };
      const lang = b.language === "zh" ? "zh" : "en";
      const chairName = b.chairName || this.currentChair?.name || (lang === "zh" ? "主席" : "Chair");

      const wordCount = b.bodyMd
        ? (b.bodyMd.trim().match(/\S+/g) || []).length
        : 0;

      // Stage definitions · 7 ordered cells. Must align with the wire
      // format emitted by emitStage() in src/orchestrator/brief.ts:
      //
      //   extract → compose → scaffold-{anchor,findings,cluster,actions} → write
      //
      // The 4 scaffold sub-stages are driven by JSON-key arrival in the
      // Stage 2 streaming buffer (see runStage2 / SCAFFOLD_TRIGGERS in
      // brief.ts), so each pip transition reflects a real moment in the
      // model's output — not a synthetic timer.
      const STAGE_DEFS = lang === "zh"
        ? [
            { key: "extract",            label: "读完房间里每个人的发言", pipShort: "听" },
            { key: "compose",            label: "选定报告骨架与组件",    pipShort: "选" },
            { key: "scaffold-anchor",    label: "敲定核心判断 (anchor)",  pipShort: "锚" },
            { key: "scaffold-findings",  label: "勾勒主张与发现",       pipShort: "见" },
            { key: "scaffold-cluster",   label: "梳理共识与分歧",       pipShort: "辨" },
            { key: "scaffold-actions",   label: "拟动作 · 推演风险",     pipShort: "拟" },
            { key: "write",              label: "撰写最终报告",         pipShort: "写" },
          ]
        : [
            { key: "extract",            label: "Reading what each director said", pipShort: "read" },
            { key: "compose",            label: "Picking the report shape",        pipShort: "pick" },
            { key: "scaffold-anchor",    label: "Setting the anchor",              pipShort: "anchor" },
            { key: "scaffold-findings",  label: "Sketching findings",              pipShort: "find" },
            { key: "scaffold-cluster",   label: "Mapping consensus + dissent",     pipShort: "split" },
            { key: "scaffold-actions",   label: "Drafting actions + risks",        pipShort: "act" },
            { key: "write",              label: "Writing the report",              pipShort: "write" },
          ];

      const meta = this.BRIEF_STAGE_META;
      const substages = (this.BRIEF_SUBSTAGES[lang] || this.BRIEF_SUBSTAGES.en);
      const stageEta = (key) => {
        const st = stages[key];
        if (st?.etaSec && typeof st.etaSec.lo === "number") return [st.etaSec.lo, st.etaSec.hi];
        return meta[key]?.eta || [5, 15];
      };
      const elapsedFor = (key) => {
        const st = stages[key];
        if (!st || !st.startedAt) return 0;
        const endRef = (st.status === "done" && st.finishedAt) ? st.finishedAt : Date.now();
        return Math.max(0, Math.floor((endRef - st.startedAt) / 1000));
      };

      // Find the active stage. Fallback chain: first pending, then last
      // stage. When everything is done the wider brief renderer switches
      // to the finished card, so this fallback only handles the brief
      // moment between SSE events.
      let activeIdx = STAGE_DEFS.findIndex((d) => stages[d.key]?.status === "active");
      if (activeIdx < 0) activeIdx = STAGE_DEFS.findIndex((d) => stages[d.key]?.status === "pending");
      if (activeIdx < 0) activeIdx = STAGE_DEFS.length - 1;

      const activeDef = STAGE_DEFS[activeIdx];
      const activeStage = stages[activeDef.key] || { status: "active" };
      const activeStatus = activeStage.status || "active";
      const activeEta = stageEta(activeDef.key);
      const activeElapsed = elapsedFor(activeDef.key);

      // Total elapsed + remaining-ETA range across all stages. Done
      // stages contribute their actual elapsed; the active stage
      // contributes elapsed-so-far AND its remaining lo/hi; pending
      // stages contribute their full lo/hi.
      let totalLo = 0, totalHi = 0, totalElapsed = 0;
      for (const def of STAGE_DEFS) {
        const st = stages[def.key];
        const status = st?.status || "pending";
        const [lo, hi] = stageEta(def.key);
        if (status === "done") {
          totalElapsed += elapsedFor(def.key);
        } else if (status === "active") {
          totalElapsed += activeElapsed;
          totalLo += Math.max(0, lo - activeElapsed);
          totalHi += Math.max(0, hi - activeElapsed);
        } else {
          totalLo += lo;
          totalHi += hi;
        }
      }

      // Rotating sub-line · advances every 3s within the active stage.
      let substageText = "";
      if (activeStatus === "active" && substages[activeDef.key]?.length) {
        const list = substages[activeDef.key];
        substageText = list[Math.floor(activeElapsed / 3) % list.length];
      }

      // Detail · cur/total directors during extract, word count during
      // write, otherwise the server-supplied detail string.
      const detailParts = [];
      if (activeDef.key === "extract" && activeStage.progress?.total) {
        const cur = activeStage.progress.current;
        const tot = activeStage.progress.total;
        detailParts.push(lang === "zh" ? `${cur}/${tot} 位董事` : `${cur}/${tot} director${tot === 1 ? "" : "s"}`);
      } else if (activeStage.detail) {
        detailParts.push(activeStage.detail);
      }
      if (activeDef.key === "write" && activeStatus === "active" && wordCount > 0) {
        detailParts.push(lang === "zh" ? `${wordCount} 字` : `${wordCount} word${wordCount === 1 ? "" : "s"}`);
      }
      const detailLine = detailParts.join(" · ");

      // Timing for active stage · ETA range while in-band, elapsed once over.
      let timing = "";
      if (activeStatus === "active") {
        if (activeElapsed <= activeEta[1]) {
          timing = activeElapsed > 0
            ? `${activeElapsed}s · ~${activeEta[0]}–${activeEta[1]}s`
            : `~${activeEta[0]}–${activeEta[1]}s`;
        } else {
          timing = lang === "zh" ? `已耗时 ${activeElapsed}s` : `${activeElapsed}s elapsed`;
        }
      }

      // Active-card progress line · in-band 0→95% linear, then a Zeno
      // asymptote past upper bound that creeps from 95 toward 99 over
      // many minutes. Never reaches 100 until status flips done. This
      // is honest signaling — when we've gone past the estimate, we
      // tell the eye "we're past the estimate" without lying about how
      // close we are to finishing.
      let pct = 0;
      if (activeStatus === "active") {
        const etaMid = (activeEta[0] + activeEta[1]) / 2;
        if (activeElapsed <= activeEta[1]) {
          pct = Math.min(95, Math.round((activeElapsed / Math.max(0.5, etaMid)) * 100));
        } else {
          // Zeno crawl · 95% + (1 - e^(-over/90)) * 4. At 30s past:
          // 95 + 1.2% ≈ 96.2%. At 5min past: 95 + 3.8% ≈ 98.8%. Never 100.
          const over = activeElapsed - activeEta[1];
          pct = Math.min(99, 95 + (1 - Math.exp(-over / 90)) * 4);
        }
      } else if (activeStatus === "done") {
        pct = 100;
      }

      // Pip rail · one pip per stage + 1px connector between. Track
      // first-time-done transitions across renders via a per-brief Set
      // so the "settle" spring animation runs ONCE on flip, not on
      // every 1-second re-render. Without this gate, recreating the
      // DOM each tick would re-trigger the keyframe and the dot would
      // jitter every second.
      this._briefSeenDoneKeys = this._briefSeenDoneKeys || {};
      const seenDone = this._briefSeenDoneKeys[b.id] = this._briefSeenDoneKeys[b.id] || new Set();
      const pipHtml = STAGE_DEFS.map((def, i) => {
        const st = stages[def.key];
        const status = st?.status || "pending";
        const isFreshDone = status === "done" && !seenDone.has(def.key);
        if (status === "done") seenDone.add(def.key);
        const dot = `<span class="brief-pip-dot"></span>`;
        const label = `<span class="brief-pip-label">${this.escape(def.pipShort)}</span>`;
        const cls = `is-${status}` + (isFreshDone ? " is-fresh-done" : "");
        const pip = `<div class="brief-pip ${cls}">${dot}${label}</div>`;
        const connector = (i < STAGE_DEFS.length - 1)
          ? `<div class="brief-pip-line is-${status === "done" ? "done" : "pending"}"></div>`
          : "";
        return pip + connector;
      }).join("");

      // Total ETA formatting · "1m 12s · ~3-5m left" / "已 1m 12s · 还需约 3–5 分钟"
      const fmtSec = (s) => {
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        const r = s % 60;
        return r === 0 ? `${m}m` : `${m}m ${r}s`;
      };
      const fmtRange = (lo, hi) => {
        if (hi < 60) return lang === "zh" ? `约 ${lo}–${hi}s` : `~${lo}–${hi}s`;
        const loM = Math.max(1, Math.round(lo / 60));
        const hiM = Math.max(loM, Math.round(hi / 60));
        return lang === "zh" ? `约 ${loM}–${hiM} 分钟` : `~${loM}-${hiM}m`;
      };

      const totalText = lang === "zh"
        ? `已 ${fmtSec(totalElapsed)} · 还需${fmtRange(totalLo, totalHi)}`
        : `${fmtSec(totalElapsed)} elapsed · ${fmtRange(totalLo, totalHi)} left`;

      const kickerCore = lang === "zh"
        ? `// ${chairName} 正在整理纪要 · ${totalText}`
        : `// ${chairName} is preparing the minutes · ${totalText}`;

      const metaHtml = (detailLine || timing)
        ? `<span class="brief-active-meta">` +
            (detailLine ? `<span class="meta-detail">${this.escape(detailLine)}</span>` : "") +
            (timing ? `<span class="meta-timing">${this.escape(timing)}</span>` : "") +
          `</span>`
        : "";

      // Stat row · accumulates as stages complete. Each completed stage
      // can deposit one or more chips/strings here. The row exists only
      // when there's at least one fragment to show, so it doesn't
      // occupy vertical space on the very first render.
      const stats = [];
      const composeDone = stages.compose?.status === "done";
      const writeActive = stages.write?.status === "active";

      // Director chips · per-director harvest carried by the
      // brief-extract-harvest SSE event. Each chip shows the
      // director's name + total signal count. The kind taxonomy
      // ("top: risk" etc) lives in the title attribute so a hover
      // surfaces it without bloating the chip text.
      //
      // Flicker fix · `_briefSeenHarvestKeys[briefId]` tracks which
      // chips have already been rendered for this brief. Without it,
      // every 1-second renderBrief tick recreates the DOM and the CSS
      // animation re-runs, making the chips visibly fade in over and
      // over. With it, the entrance animation only runs once per
      // chip's first appearance.
      this._briefSeenHarvestKeys = this._briefSeenHarvestKeys || {};
      const seenH = this._briefSeenHarvestKeys[b.id] = this._briefSeenHarvestKeys[b.id] || new Set();
      const harvest = Array.isArray(b.extractHarvest) ? b.extractHarvest : [];
      const kindLabels = lang === "zh"
        ? { claims: "判断", evidence: "证据", tensions: "分歧", assumptions: "假设", risks: "风险", opportunities: "机会", actions: "动作", quotes: "原话", openQuestions: "悬而未决" }
        : { claims: "claims", evidence: "evidence", tensions: "tensions", assumptions: "assumptions", risks: "risks", opportunities: "opportunities", actions: "actions", quotes: "quotes", openQuestions: "open-q" };
      if (harvest.length) {
        const chips = harvest.map((h) => {
          const isFresh = !seenH.has(h.directorId);
          if (isFresh) seenH.add(h.directorId);
          const name = this.escape(h.directorName || h.directorId || "");
          const breakdown = Object.entries(h.byKind || {})
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${kindLabels[k] || k}:${n}`)
            .join(" · ");
          const topLabel = h.topKind ? (kindLabels[h.topKind] || h.topKind) : "";
          const tagSuffix = h.topKind && h.byKind?.[h.topKind] >= 2
            ? ` <span class="brief-stat-chip-tag">${this.escape(topLabel)}</span>`
            : "";
          return `<span class="brief-stat-chip${isFresh ? " is-fresh" : ""}" title="${this.escape(breakdown)}">${name} · ${h.total | 0}${tagSuffix}</span>`;
        }).join("");
        stats.push(`<div class="brief-stat-roster">${chips}</div>`);
      }
      // Compose's detail string · usually "{spine} · {N} components".
      if (composeDone && stages.compose?.detail) {
        stats.push(`<span class="brief-stat-fact">${this.escape(stages.compose.detail)}</span>`);
      }
      // Live word count during write — large and visible since it's the
      // most engaging signal during the long write stage.
      if (writeActive && wordCount > 0) {
        const w = lang === "zh" ? `${wordCount} 字 · 还在落笔` : `${wordCount} word${wordCount === 1 ? "" : "s"} · still writing`;
        stats.push(`<span class="brief-stat-fact brief-stat-live">${this.escape(w)}</span>`);
      }
      const statsHtml = stats.length
        ? `<div class="brief-stats-row">${stats.join("")}</div>`
        : "";

      return `
        <div class="brief-kicker brief-kicker-pulse">${this.escape(kickerCore)}<span class="brief-typing-dots"><i></i><i></i><i></i></span></div>
        <div class="brief-progress">
          <div class="brief-active-card brief-active-${activeStatus}">
            <div class="brief-active-head">
              <span class="brief-active-label">${this.escape(activeDef.label)}</span>
              ${metaHtml}
            </div>
            <div class="brief-active-substage">${substageText ? this.escape(substageText) : "&nbsp;"}</div>
            <div class="brief-active-progressline" style="width: ${pct}%"></div>
          </div>
          <div class="brief-pip-rail">${pipHtml}</div>
          ${statsHtml}
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
     *  fires when the user is already following the live feed.
     *
     *  Also gated by a short-lived suppression window (`_suppress-
     *  BottomScrollUntil`) that scrollToNote sets after a successful
     *  note jump. Without this gate, an SSE token or queue-update
     *  event landing during the smooth scroll-to-span would call
     *  scrollChatToBottom() and snap the chat back to bottom, undoing
     *  the user's intended jump. Forced scrolls (`force === true`)
     *  bypass the lock so user-initiated actions still work. */
    scrollChatToBottom(force) {
      const chat = document.querySelector(".chat");
      if (!chat) return;
      if (!force && !this.chatStuckToBottom) return;
      if (!force && this._suppressBottomScrollUntil && Date.now() < this._suppressBottomScrollUntil) return;
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
    // View Report trigger · multi-brief room. Anchor a popover under
    // the button listing every brief so the user can pick which one
    // to open. Plain link clicks (single-brief case, middle-click,
    // ctrl/cmd-click) bypass this and follow the href as normal —
    // the trigger attribute is only present when there are 2+
    // briefs, AND we don't intercept modified clicks.
    const reportTrigger = e.target.closest("[data-view-report-trigger]");
    if (reportTrigger && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      app.toggleBriefPicker(reportTrigger);
      return;
    }
    // Brief picker · clicking a row opens that brief's report in a
    // new tab. Plain links so middle-click / cmd-click work too;
    // we just close the picker on a normal click.
    if (e.target.closest("[data-brief-picker-row]")) {
      app.closeBriefPicker();
      // Don't preventDefault · let the anchor's target=_blank handle navigation.
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
    // Convene Follow-up · adjourned-bar action. Opens the follow-up
    // overlay with parent reference + form for the new question.
    if (e.target.closest("[data-room-followup]")) {
      e.preventDefault();
      app.openFollowUpOverlay();
      return;
    }
    if (e.target.closest("[data-followup-close]")) {
      e.preventDefault();
      app.closeFollowUpOverlay();
      return;
    }
    if (e.target.closest("[data-followup-confirm]")) {
      e.preventDefault();
      app.submitFollowUp();
      return;
    }
    // Follow-up overlay · cast button → open / toggle picker
    const followupCastBtn = e.target.closest("[data-followup-cast-btn]");
    if (followupCastBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (followupCastBtn.hasAttribute("disabled")) return;
      // Toggle: clicking the trigger while picker open closes it.
      if (document.getElementById("followup-pick-pop")) {
        app.closeFollowUpCastPicker();
      } else {
        app.openFollowUpCastPicker(followupCastBtn);
      }
      return;
    }
    // Follow-up picker · row click is handled via the `change` event
    // on the inner checkbox (registered separately below), mirroring
    // the inline composer's pattern. The earlier `preventDefault` +
    // direct toggle approach left the checkbox's visual state stuck:
    // preventDefault cancelled the native toggle but the programmatic
    // `cb.checked = on` raced with the bubble in a way that didn't
    // visually re-mark the checkbox. The change-event flow lets the
    // browser draw the check, then syncs state from the new cb state.
    // Click on a follow-up tile in the parent room's "Follow-up rooms"
    // strip · navigate to the child. Click on the parent banner of a
    // follow-up room · navigate up.
    const followUpTile = e.target.closest("[data-followup-room-id]");
    if (followUpTile) {
      e.preventDefault();
      const id = followUpTile.getAttribute("data-followup-room-id");
      if (id) app.navigateToRoom(id);
      return;
    }
    const parentBanner = e.target.closest("[data-followup-parent-id]");
    if (parentBanner) {
      e.preventDefault();
      const id = parentBanner.getAttribute("data-followup-parent-id");
      if (id) app.navigateToRoom(id);
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
    // Generate report now · escape hatch for users who adjourned with
    // skipBrief and later want a brief filed. Two surfaces share this
    // hook: (a) the chat's no-brief milestone card, (b) the header
    // [ ▸ Generate Report ] link that replaces the old [ ⊘ No Report ]
    // static text. Both carry data-generate-brief; click → POST
    // /api/rooms/:id/brief → existing brief-* SSE handlers render the
    // in-progress + final brief bubbles in the brief slot. After
    // success, currentBrief flips non-null → next renderHeader/Chat
    // swaps the button to [ View Report ] automatically.
    const genBriefBtn = e.target.closest("[data-generate-brief]");
    if (genBriefBtn) {
      e.preventDefault();
      if (genBriefBtn.getAttribute("data-pending") === "1") return;
      genBriefBtn.setAttribute("data-pending", "1");
      if ("disabled" in genBriefBtn) genBriefBtn.disabled = true;

      const isZh = app.composerLanguage() === "zh";
      const generatingText = isZh ? "正在生成…" : "generating…";
      const originalHtml = genBriefBtn.innerHTML;

      // Swap to a "generating…" state. The two button shapes both
      // contain a small ▸ mark + text label; flip the mark to · and
      // replace the label with the generating phrase. We save the
      // original innerHTML so a failure can roll back cleanly.
      const textEl = genBriefBtn.querySelector(".nb-cta-text");
      const markEl = genBriefBtn.querySelector(".nb-cta-mark, .vr-mark");
      if (textEl) {
        textEl.textContent = generatingText;
        if (markEl) markEl.textContent = "·";
      } else {
        // Header anchor · text lives as a sibling text node next to
        // the mark span. Easiest to re-emit the whole inner content.
        const markCls = markEl ? markEl.className : "vr-mark";
        genBriefBtn.innerHTML = `<span class="${app.escape(markCls)}">·</span> ${app.escape(generatingText)}`;
      }

      app.generateBriefForAdjournedRoom().catch((err) => {
        genBriefBtn.removeAttribute("data-pending");
        if ("disabled" in genBriefBtn) genBriefBtn.disabled = false;
        genBriefBtn.innerHTML = originalHtml;
        alert((isZh ? "生成失败：" : "Brief generation failed: ") + (err && err.message ? err.message : err));
      });
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
    // The salvage-path banner attaches `data-target-brief-id` so the
    // retry targets the FAILED brief id, not whichever brief the user
    // is currently looking at (which is the prior good one in the
    // salvage path). Falls back to currentBrief when the attribute is
    // absent (the original full-error card path).
    const retryBtn = e.target.closest("[data-brief-retry]");
    if (retryBtn) {
      e.preventDefault();
      const targetId = retryBtn.getAttribute("data-target-brief-id") || null;
      app.retryBriefGeneration(targetId);
      return;
    }
    // Salvage banner · dismiss button. Just removes the banner DOM —
    // the failed brief stays in currentBriefs so the user can still
    // retry from a brief tab if they change their mind.
    const dismissBtn = e.target.closest("[data-brief-banner-dismiss]");
    if (dismissBtn) {
      e.preventDefault();
      const banner = dismissBtn.closest("[data-brief-retry-banner]");
      if (banner) banner.remove();
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
    // Passes `bypassSalvage` so renderBrief renders the picked brief
    // as-is — including its full error UI when it's a failed brief.
    // The salvage path only auto-fires for renders that didn't come
    // from a deliberate user navigation (SSE-driven re-renders, etc.),
    // so the user can always navigate INTO a failing tab to inspect
    // it. Earlier the failed tab felt un-clickable because every
    // render was being salvaged back to a good brief.
    const briefTab = e.target.closest("[data-brief-tab]");
    if (briefTab) {
      e.preventDefault();
      const id = briefTab.getAttribute("data-brief-id");
      const next = (app.currentBriefs || []).find((b) => b.id === id);
      if (next) {
        app.currentBrief = next;
        app.renderBrief({ bypassSalvage: true });
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
    // Switch & continue · accept the chair's MODE-SHIFT proposal,
    // PATCH the room mode, then resume directors. Same exit path as
    // [data-continue] but with the tone change wired in front of it.
    const shiftBtn = e.target.closest("[data-shift-accept]");
    if (shiftBtn) {
      e.preventDefault();
      const to = shiftBtn.getAttribute("data-shift-to");
      if (!to) return;
      app.cancelContinueCountdown();
      app.acceptModeShiftAndContinue(to).catch((err) => alert("Switch failed: " + err.message));
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
    // ─── All Notes · filter chip click (mirrors the reports strip)
    const notesFilterChip = e.target.closest("[data-notes-filter]");
    if (notesFilterChip) {
      e.preventDefault();
      const key = notesFilterChip.getAttribute("data-notes-filter");
      app.setNotesFilter(key);
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
    // ─── Agent composer · websearch toggle. Three paths:
    //   · unconfigured → confirm + open Preferences → Brave row
    //   · on  → save off + flip toggle in place
    //   · off → save on + flip toggle in place
    // Done with in-place class / text mutation rather than a full
    // renderEmptyState() repaint — repaint blew the textarea away
    // and caused a visible page flash on every click.
    const wsToggle = e.target.closest("[data-agent-composer-ws-toggle]");
    if (wsToggle) {
      e.preventDefault();
      // Always re-read the live key state on click — the toggle's
      // `data-configured` attribute is set at render time and goes
      // stale the moment the user opens user-settings, pastes a Brave
      // key, and comes back. Without this re-read the toggle still
      // shows "configure key" forever even though the cache already
      // has it. boardroomKeys() reads through the shared _keysMeta
      // map, which user-settings.js patches in place after every
      // setProviderKey, so we get fresh truth here.
      const configured = !!(app.agentComposerBraveConfigured && app.agentComposerBraveConfigured());
      const isZh = (app.composerLanguage && app.composerLanguage()) === "zh";
      if (!configured) {
        const ok = confirm(isZh
          ? "联网搜索需要 Brave Search API key。\n\nBrave Search · 约 $5 / 1000 次查询 · 注重隐私\n\n现在去 Preferences 配置吗？"
          : "Web Search needs a Brave Search API key.\n\nBrave Search · ≈ $5 per 1000 queries · privacy-respecting\n\nOpen Preferences to paste your key now?");
        if (ok && typeof window.openUserSettings === "function") {
          window.openUserSettings({ section: "keys", focusProvider: "brave" });
        }
        return;
      }
      // Live state says configured. Sync the toggle's stale attributes
      // + class set so the next click acts as a flip rather than as
      // another "configure" prompt. Idempotent when already in sync.
      if (wsToggle.getAttribute("data-configured") !== "1") {
        wsToggle.setAttribute("data-configured", "1");
        wsToggle.classList.remove("needs-key");
      }
      const wasOn = wsToggle.getAttribute("data-on") === "1";
      const next = !wasOn;
      app.saveAgentComposerWebSearch(next);
      wsToggle.classList.toggle("on", next);
      wsToggle.classList.toggle("off", !next);
      wsToggle.setAttribute("data-on", next ? "1" : "0");
      wsToggle.setAttribute("aria-pressed", next ? "true" : "false");
      const txt = wsToggle.querySelector(".ap-skill-row-toggle-text");
      if (txt) {
        const wsLabel = isZh ? "联网搜索" : "web search";
        const stateLabel = next
          ? (isZh ? "已开启" : "enabled")
          : (isZh ? "已关闭" : "disabled");
        txt.textContent = `${wsLabel} · ${stateLabel}`;
      }
      wsToggle.title = next
        ? (isZh
          ? "生成时联网检索领域真实案例 · 点击关闭"
          : "Search the web for real domain references during generation · click to disable")
        : (isZh
          ? "生成时不联网 · 点击开启"
          : "Generation runs offline · click to enable web search");
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
    if (e.target.closest("[data-agent-spec-retry]")) {
      e.preventDefault();
      app.retryAgentSpec();
      return;
    }
    if (e.target.closest("[data-agent-spec-error-discard]")) {
      e.preventDefault();
      app.discardAgentSpec();
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
    // Dropdown option pick. Two contexts share this handler:
    //
    //   · new-room composer (inline) · writes to composerState, the
    //     value span re-renders next paint
    //   · follow-up overlay · same `.cmp-dd` markup, but composerState
    //     would clobber whatever the user had typed for a brand-new
    //     room. Detect overlay context via the in-flight trigger
    //     (stashed on app._cmpDdTrigger by openComposerDropdown) and
    //     write directly to the trigger's value span instead.
    const ddPick = e.target.closest("[data-cmp-dd-pick]");
    if (ddPick) {
      e.preventDefault();
      const kind = ddPick.getAttribute("data-cmp-dd-kind");
      const v = ddPick.getAttribute("data-cmp-dd-pick");
      const trigger = app._cmpDdTrigger;
      const inFollowUp = !!(trigger && trigger.closest("#followup-overlay"));
      if (inFollowUp && (kind === "tone" || kind === "intensity")) {
        const valSpan = trigger.querySelector("[data-cmp-dd-value]");
        if (valSpan) valSpan.textContent = v;
      } else {
        if (kind === "tone") app.setComposerTone(v);
        else if (kind === "intensity") app.setComposerIntensity(v);
        else if (kind === "agent-model") app.setAgentComposerModel(v);
      }
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
  // Follow-up overlay's director picker · same pattern as the inline
  // composer above. Listen for `change` on the inner checkbox so the
  // browser draws the check first, then sync `_followupCastState`
  // from the post-toggle state. Was previously click + preventDefault,
  // which left the checkbox visually unticked.
  document.addEventListener("change", (e) => {
    const cb = e.target;
    if (!cb || !cb.matches || !cb.matches('[data-followup-pick-id] input[type="checkbox"]')) return;
    const row = cb.closest("[data-followup-pick-id]");
    const id = row && row.getAttribute("data-followup-pick-id");
    if (id) app.toggleFollowUpCastDirector(id);
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
