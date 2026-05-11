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
    "deepseek-v4-flash": "DeepSeek Lite",
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
    { v: "haiku-4-5",        label: "Claude Haiku 4.5",     provider: "Anthropic", deck: "fast · low-cost" },    { v: "gpt-5-5-pro",      label: "GPT-5.5 Pro",       provider: "OpenAI",    deck: "flagship · 1M ctx" },
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
    { v: "deepseek-v4-flash", label: "DeepSeek Lite",   provider: "DeepSeek",  deck: "V4 Flash · fast · 1M ctx" },
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
    /** Voice-options label cache · keyed by `<provider>:<voiceId>` →
     *  friendly label (e.g. "minimax:male-qn-qingse" → "青涩青年").
     *  Populated by a one-shot /api/voices prefetch in loadInitial.
     *  Sidebar's agent-row subtitle reads from this synchronously; a
     *  miss falls back to the raw voiceId so the row never blocks on
     *  the fetch. */
    voiceLabels: {},
    /** Interest-driven topic recommendations · the home composer's
     *  "找你可能感兴趣的话题" tray. Always exactly 6 items (or
     *  fewer if no batch has been generated yet) — every fresh
     *  generation wipes the previous batch server-side, so
     *  there's no pagination or history. `loaded` flips true
     *  after the first `/api/topic-recs` fetch so first-paint
     *  can show a sensible empty state. `job` is the live
     *  generation job (id + phase + pct + detail) or null when
     *  idle. */
    topicRecs: {
      items: [],
      loaded: false,
      job: null, // { id, phase, label, pct, detail, eventSource }
    },
    rooms: [],
    currentRoomId: null,
    currentRoom: null,
    currentMessages: [],
    currentMembers: [],            // directors only (chair excluded) · ACTIVE roster
    // Every director who's ever been in this room, including those
    // the chair has soft-excused. Each carries `removedAt` (null =
    // active, timestamp = excused). Used for chat-history speaker
    // resolution + voice replay so excused directors' past messages
    // still render their name / avatar / voice profile.
    currentHistoricalMembers: [],
    currentChair: null,            // chair agent for the current room
    currentQueue: [],
    voiceQueues: {},
    /** Round progress from the orchestrator: how many directors have
     *  spoken in the current round vs. the cap (= cast size). */
    currentRound: { spoken: 0, total: 0 },
    currentKeyPoints: [],          // chair-generated key points for the current room
    /** Persistent chair-ops log surfaced in the round-table HUD ·
     *  parallel to the ephemeral .rt-toast-tray. Each entry:
     *  { kind: "add"|"remove"|"settings"|"round"|"vote", glyph,
     *    htmlText (already-escaped, may contain <em>), at }.
     *  Newest-first; capped at 6 entries. Reset on room close. */
    rtChairLog: [],
    /** Voice-mode playback rate · multiplier applied to every voice
     *  stream's HTMLAudioElement. Cycled by the HUD's RATE button
     *  through `VOICE_RATE_PRESETS` and persisted to localStorage so
     *  a reload / room reopen restores the user's last choice. Lazy-
     *  loaded by `voicePlaybackRate()` so init ordering doesn't
     *  matter. */
    _voicePlaybackRate: null,
    /** Round-table HUD collapsed flag · when true, only the header
     *  strip (LED + STATUS + state pill + toggle) is visible, with
     *  the stats grid + rate control + chair-ops log hidden. Toggled
     *  by the `−` / `+` button in the HUD header; persisted to
     *  localStorage so a reload / room reopen restores the user's
     *  choice. Lazy-loaded by `hudCollapsed()`. */
    _hudCollapsed: null,
    /** User-seat presence in the round-table stage · flips true the
     *  moment the user sends their first message in this room and
     *  stays true for the rest of the session. Re-derived from
     *  message history on room load so a re-open after the user
     *  spoke earlier brings the seat back without persistence
     *  storage. Reset on room close. */
    userSeatVisible: false,
    /** Ephemeral speech bubble on the user seat · shows the latest
     *  typed message with a 10s auto-dismiss countdown. The seat
     *  stays after the bubble dismisses; only this object resets.
     *  `dismissed: true` means no bubble is showing right now. */
    userBubble: { text: "", deadline: 0, intervalId: null, dismissed: true },
    /** Ephemeral question bubble pinned to the CHAIR seat when the
     *  chair drops a clarifying question in voice mode. Mirrors the
     *  userBubble shape exactly so the render / tick / dismiss
     *  surfaces stay parallel. 10s border countdown. */
    chairBubble: { text: "", deadline: 0, intervalId: null, dismissed: true },
    /** Set of chair messageIds whose voice synthesis hasn't started yet.
     *  Bridges the gap between message-appended (the chair's round-prompt
     *  / round-end placeholder lands instantly) and the first voice-chunk
     *  arriving from the server's TTS pipeline (~0.5-2s later). Without
     *  this, isChairBusy briefly returns false in that window and the
     *  vote popover flashes onto the chair seat before the chair has
     *  even started speaking — then hides again as audio kicks in, then
     *  re-appears after audio ends. Cleared when the first voice-chunk
     *  arrives (or after a 12s safety timeout if TTS never delivers). */
    _chairVoiceAwaiting: null,
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

    /* ─── Full-persona builder state · the deep 5-10 min build ───
     *  Lives alongside the Signal-mode state. Signal flow is
     *  unchanged; selecting "Full persona" via the composer toggle
     *  switches the submit handler to the Full pipeline.
     *
     *  `personaJob` holds everything the UI needs to render the SSE-
     *  driven progress block + the eventual save card. Null when
     *  idle. The fields:
     *    · jobId · the server-side job id (also drives the SSE URL)
     *    · status · "running" | "done" | "failed" | "aborted"
     *    · currentPhase · 1..7 · drives which row is "active" in the
     *                     phase list
     *    · progressPct · 0..100 · drives the overall progress bar
     *    · phaseDetail · sub-text under the active phase row
     *    · searchRounds · audit log of ReAct queries (Phase 2)
     *    · partial · accumulated phase outputs · used to render the
     *                save preview when status flips to "done"
     *    · finalSpec · set when the build completes successfully
     *    · errorMessage · user-facing error · set on failure */
    personaJob: null,
    /** Active EventSource for the in-flight build · closed on
     *  terminal events and on cancel / discard. */
    _personaSse: null,
    /** Wall-clock start (ms) for the elapsed-time display. */
    _personaStartedAt: 0,
    /** Repaint tick · the SSE handlers update state but the elapsed
     *  counter needs its own ~1Hz tick so the seconds advance even
     *  when no event has arrived. */
    _personaTick: null,

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
          ? (btn.getAttribute("data-less") || this._t("convene_show_less"))
          : (btn.getAttribute("data-more") || this._t("convene_show_more"));
        btn.textContent = label;
      });
      document.addEventListener("boardroom:locale", () => {
        this.renderSidebarRooms();
        this.renderSidebarAgents();
        this.renderSidebarCounts();
        this.renderUserBlock();
        if (this.currentRoomId) this.renderRoom();
        else this.renderEmptyState();
        if (Array.isArray(this._reportsCache)) this.renderReportsPage(this._reportsCache);
        if (Array.isArray(this._notesCache)) this.renderNotesPage(this._notesCache);
      });
      // Voice replay drives the round-table stage in adjourned rooms ·
      // every replay state transition (item start, thinking → speaking,
      // playlist end, close) emits `boardroom:replay-active` so the
      // stage repaints the speaking seat / bubble / subtitle and the
      // HUD's REPLAY pill stays in sync. Cheap to call · renderRound-
      // Table bails fast when the stage isn't currently visible.
      document.addEventListener("boardroom:replay-active", () => {
        if (!this.currentRoomId) return;
        this.renderRoundTable();
      });
      // Replay drives playback of pre-rendered audio clips (not the
      // chunk-streamed pipeline), so it has its own timeupdate event
      // that fires on every audio tick. We hook it here to drive the
      // subtitle's sentence-of-the-cursor sync · cheap DOM update,
      // safe to fire ~4 Hz.
      document.addEventListener("boardroom:replay-tick", () => {
        if (!this.currentRoomId) return;
        this.renderRtSubtitle();
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

      const count = fresh.length;
      const names = fresh.map((m) => m.name).join(", ");
      const bodyKey = count === 1 ? "migrate_body_one" : "migrate_body";
      const copy = {
        head: this._t("migrate_head"),
        body: this._t(bodyKey, { count }),        tooltip: names,
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
      // CRITICAL fetches block the dashboard's first paint — only the
      // four queries below have data the initial render NEEDS. The
      // `/api/voices` route is intentionally NOT in this Promise.all:
      // its server handler can synchronously hit MiniMax + ElevenLabs
      // cloud APIs (1-2s each), and putting it here used to delay the
      // ENTIRE UI by the slowest of those calls. Voice labels are a
      // sidebar-row sweetener — `voiceLabelFor()` already falls back
      // to raw voice IDs on cache miss — so we fetch them in the
      // background and re-render the sidebar once they arrive.
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
      // Fire-and-forget the voice-labels prefetch · the initial paint
      // already finished by the time this resolves. Re-renders the
      // agents sidebar so the friendly label ("青涩青年") swaps in for
      // any raw voiceId rows that already mounted. Safe to discard on
      // failure (sidebar keeps the raw id fallback).
      void this._prefetchVoiceLabels();
    },

    /** Background prefetch for /api/voices · runs after the initial
     *  load completes so the dashboard's first paint isn't held up by
     *  the MiniMax / ElevenLabs cloud-API round-trips inside the
     *  server's `listAvailableVoices`. Triggers a sidebar re-render
     *  when labels arrive so the friendly names replace the raw voice
     *  IDs in-place. Idempotent · safe to call multiple times. */
    async _prefetchVoiceLabels() {
      try {
        const res = await fetch("/api/voices");
        if (!res || !res.ok) return;
        const j = await res.json();
        const list = Array.isArray(j.voices) ? j.voices : [];
        const map = {};
        for (const v of list) {
          if (v && typeof v.provider === "string" && typeof v.voiceId === "string") {
            const label = typeof v.label === "string" && v.label.trim() ? v.label.trim() : v.voiceId;
            map[`${v.provider}:${v.voiceId}`] = label;
          }
        }
        this.voiceLabels = map;
        // Re-render the agents sidebar so any rows currently showing
        // a raw voice id (e.g. "male-qn-qingse") swap to the prettier
        // label ("青涩青年"). Cheap idempotent paint.
        if (typeof this.renderSidebarAgents === "function") {
          this.renderSidebarAgents();
        }
      } catch { /* keep empty map · sidebar falls back to voiceId */ }
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
        // `?m=<id>` segment · "jump to this message" payload from
        // the Search view. Cleared the moment the message scrolls
        // + flashes (handled inside renderChat / scrollToMessage).
        // `?q=<term>` (optional) carries the search keyword so the
        // room can highlight the matched substring inside the
        // message body, not just flash the article.
        const msgMatch = hash.match(/[?&]m=([a-z0-9]+)/i);
        this._pendingMessageScroll = msgMatch ? msgMatch[1] : (this._pendingMessageScroll || null);
        const qMatch = hash.match(/[?&]q=([^&]+)/i);
        if (qMatch) {
          try { this._pendingMessageQuery = decodeURIComponent(qMatch[1]); }
          catch { this._pendingMessageQuery = qMatch[1]; }
        }
        if (this.currentRoomId !== m[1]) {
          this.openRoom(m[1]);
        } else if (this._pendingMessageScroll) {
          // Already in this room · try the message scroll directly.
          const mid = this._pendingMessageScroll;
          const ok = this.scrollToMessage(mid);
          if (ok) {
            this._pendingMessageScroll = null;
            this._pendingMessageQuery = null;
          } else {
            setTimeout(() => {
              if (this._pendingMessageScroll === mid) {
                this.scrollToMessage(mid);
                this._pendingMessageScroll = null;
                this._pendingMessageQuery = null;
              }
            }, 500);
          }
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
      // Search view · same hash-restore pattern as reports / notes.
      if (/^#\/search$/i.test(location.hash || "")) {
        this.openSearch();
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
      // renderEmptyState. The sidebar persistence layer in index.html
      // (boardroom.sidebar.* keys + restore() on DOMContentLoaded)
      // takes over from here · if the user's last sidebar selection
      // was a specific room / reports / notes, that fires AFTER
      // app.init and overrides this composer landing.
      this.closeRoom();
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
      const isMsgJump  = !!this._pendingMessageScroll;
      const isJump     = isNoteJump || isMsgJump;

      // If a note OR search-result jump is queued, lock out non-forced
      // auto-scrolls for the entire room-open lifecycle (~4s covers
      // room fetch + notes fetch + chat render + grace). SSE events
      // that arrive on connect — message-token streams, queue-update
      // fan-outs, key-point round-end re-renders — each call
      // scrollChatToBottom() (no force); without this upfront lock,
      // any of them can snap the chat to the tail and override the
      // user's intended jump. Forced scrolls (force=true · user
      // sending a message) still bypass the lock so user-initiated
      // actions remain immediate.
      if (isJump) {
        this._suppressBottomScrollUntil = Date.now() + 4000;
        // Hide the chat (opacity 0) until scrollToNote / scroll-
        // ToMessage lands. Without this, the user sees a brief
        // "stale chat → repaint → scroll to position" transition
        // as a flicker — the previous room's content is still in
        // the DOM when the room view becomes visible, and renderChat
        // + the scroll only finalise after loadRoomNotes resolves.
        // The 1.2s timer is the safety net so a failed jump never
        // leaves the chat permanently invisible.
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
      const searchView = document.querySelector('[data-main-view="search"]');
      const roomView = document.querySelector('[data-main-view="room"]');
      const agentView = document.querySelector('[data-main-view="agent"]');
      if (reportsView) reportsView.setAttribute("hidden", "");
      if (notesView)   notesView.setAttribute("hidden", "");
      if (searchView)  searchView.setAttribute("hidden", "");
      if (agentView && !agentView.hasAttribute("hidden")) {
        agentView.setAttribute("hidden", "");
        agentView.innerHTML = "";
      }
      if (roomView)    roomView.removeAttribute("hidden");
      document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-notes-trigger].active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-search-trigger].active").forEach((el) => el.classList.remove("active"));

      // Defensive composer-state reset · we're entering an actual room,
      // so any "+ New agent" / "+ New room" Signal-mode composer that
      // was pending is irrelevant. Clearing here prevents bleed-through
      // into the room view's chat content area when an indirect
      // renderEmptyState (locale change, sidebar restore tick) fires
      // while composerMode is still "agent".
      //
      // IMPORTANT · `personaJob` is NOT reset here. A Full-mode build
      // is a long-running SSE-driven job with server state; nulling it
      // when the user briefly opens a room destroys the in-flight
      // build screen and the user can no longer return to it (the
      // jobId is gone from local memory). The persona builder's own
      // render gate (`_personaUiActive()` checks `!currentRoomId`)
      // already prevents the build screen from painting over an open
      // room, so bleed-through is impossible without this null.
      this.composerMode = "room";
      this.agentSpec = null;
      this.agentSpecGenerating = false;
      this.agentSpecError = null;

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
      // Full historical roster · falls back to active members for
      // older servers that don't ship `historicalMembers` yet.
      this.currentHistoricalMembers = Array.isArray(data.historicalMembers)
        ? data.historicalMembers
        : (data.members || []).map((m) => ({ ...m, removedAt: null }));
      this.currentChair = data.chair || null;
      this.currentQueue = data.queue || [];
      this.currentRound = data.round || { spoken: 0, total: 0 };
      this.currentKeyPoints = data.keyPoints || [];
      // Reset the round-table HUD log when (re)opening a room. Past
      // chair-op events would still be visible in the chat transcript;
      // the HUD log is meant as a "what just happened" running tally
      // for the current viewing session, not historical archeology.
      this.rtChairLog = [];
      // User-seat presence · re-derive from message history. The seat
      // appears on first user speech and persists through the room
      // session, including across reloads (because we recompute here).
      // The bubble itself is ephemeral — we reset it so a re-open
      // doesn't auto-show a stale historical message.
      this.userSeatVisible = (this.currentMessages || []).some(
        (msg) => msg && msg.authorKind === "user"
      );
      if (this.userBubble && this.userBubble.intervalId) {
        clearInterval(this.userBubble.intervalId);
      }
      this.userBubble = { text: "", deadline: 0, intervalId: null, dismissed: true };
      if (this.chairBubble && this.chairBubble.intervalId) {
        clearInterval(this.chairBubble.intervalId);
      }
      this.chairBubble = { text: "", deadline: 0, intervalId: null, dismissed: true };
      // Drop any leftover voice-await IDs from a prior room · timeouts
      // that fire later will harmlessly no-op (their messageId isn't
      // in the set anymore).
      if (this._chairVoiceAwaiting) this._chairVoiceAwaiting.clear();
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

      // Wrap the render path so a future error in any sub-render
      // (renderHeader / renderChat / renderQueue / renderBrief /
      // renderPausedBar / renderFollowUpFragments / renderSession-
      // Analytics) doesn't halt openRoom and leave the user with a
      // header but an empty body — the exact symptom seen on an
      // adjourned voice room. Each sub-render is supposed to be
      // defensive on its own (early-return when data isn't there),
      // but any future change that throws would silently blank the
      // content area. Logging the error gives us a fingerprint to
      // chase next time.
      try {
        this.renderRoom();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[openRoom] renderRoom failed:", err);
      }
      this.markActiveRoom(roomId);
      // Round-table stage · paint + decide whether the .chat or
      // .roundtable-stage should be visible for this room. Runs
      // AFTER renderRoom so the DOM exists and currentRoom /
      // currentMembers / currentChair are all in place. Belt-and-
      // suspenders: also re-fire on the next animation frame so
      // any layout-dependent measurements (fresh-room path with
      // conveneState card mounted, html.no-room class transitions)
      // resolve cleanly. Without the rAF backup the toggle button
      // and stage occasionally stayed hidden on the first entry to
      // a freshly-created voice-mode room — the user would have to
      // refresh the page to see them.
      // Each room gets its own dismiss state for the voice-mode vote
      // overlay · the previous room's "user dismissed it" flag must
      // not bleed in here.
      this._rtVoteOverlayDismissed = false;
      try {
        this.applyRoundTableVisibility(roomId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[openRoom] applyRoundTableVisibility failed:", err);
        // Fall back to chat view so the user at least sees the
        // transcript even if the stage logic blew up.
        const stage = document.querySelector("[data-roundtable-stage]");
        const chat  = document.querySelector(".chat-col > .chat");
        if (stage) stage.hidden = true;
        if (chat)  chat.hidden = false;
      }
      requestAnimationFrame(() => {
        if (this.currentRoomId === roomId) {
          try { this.applyRoundTableVisibility(roomId); }
          catch (err) {
            // eslint-disable-next-line no-console
            console.error("[openRoom rAF] applyRoundTableVisibility failed:", err);
          }
        }
      });
      this.connectSSE(roomId);
      // Fresh room · force-scroll to the latest message and start
      // the scroll watcher so subsequent auto-scrolls respect the
      // user. Exception: when this open came from a note OR
      // search-result jump, the saved span / message is the user's
      // intended target — auto-scrolling to bottom here would land
      // RIGHT AFTER scrollToNote / scrollToMessage already
      // positioned the chat at the target, snapping it back to the
      // chat tail. We use the captured `isJump` local (not the
      // live `_pending*Scroll` fields) because applyAllNote-
      // Highlights inside renderRoom above already cleared those
      // fields when their scroll succeeded — checking them here
      // would always pass and the bottom-scroll would fire.
      this.chatStuckToBottom = true;
      if (!isJump) {
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
      this.currentHistoricalMembers = [];
      // `currentChair` is NOT reset · the chair is a structural
      // singleton (one moderator agent in the catalog, same across
      // every room), and the sidebar's Chair section keys off it
      // whether or not a room is loaded. Earlier this line read
      // `this.currentChair = null;`, which dropped the Chair row
      // from the Agents tab any time the user landed on the no-
      // room state — the chair would re-appear the moment a room
      // re-opened (since `openRoom` re-sets it from data.chair),
      // but the empty + composer states looked broken.
      this.currentQueue = [];
      this.currentRound = { spoken: 0, total: 0 };
      this.currentKeyPoints = [];
      this.rtChairLog = [];
      // User-seat / bubble · reset on room close. Stop any in-flight
      // countdown interval so we don't leak a timer when the user
      // navigates away mid-bubble.
      this.userSeatVisible = false;
      if (this.userBubble && this.userBubble.intervalId) {
        clearInterval(this.userBubble.intervalId);
      }
      this.userBubble = { text: "", deadline: 0, intervalId: null, dismissed: true };
      if (this.chairBubble && this.chairBubble.intervalId) {
        clearInterval(this.chairBubble.intervalId);
      }
      this.chairBubble = { text: "", deadline: 0, intervalId: null, dismissed: true };
      // Drop any leftover voice-await IDs from a prior room · timeouts
      // that fire later will harmlessly no-op (their messageId isn't
      // in the set anymore).
      if (this._chairVoiceAwaiting) this._chairVoiceAwaiting.clear();
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
      // Reset the chat panel + round-table stage visibility · in
      // voice mode, applyRoundTableVisibility sets `chat.hidden =
      // true` to expose the stage. closeRoom needs to flip this
      // back so the next renderEmptyState (composer / persona
      // builder / agent picker) paints into a visible container.
      // Without this, leaving a voice room for "+ New agent" or
      // the persona Building row produces a blank view because
      // `[data-chat-messages]` is inside a hidden parent.
      const chatPanel = document.querySelector(".chat-col > .chat");
      if (chatPanel) chatPanel.hidden = false;
      const rtStage = document.querySelector("[data-roundtable-stage]");
      if (rtStage) rtStage.hidden = true;
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

      this.sse.addEventListener("hello", () => {
        // SSE connection established · re-evaluate the round-table
        // stage visibility so the toggle button + stage land on
        // the correct state even if the initial openRoom paint
        // fired before currentRoom was fully populated. Idempotent
        // when the prior call already settled the right state.
        this.applyRoundTableVisibility(roomId);
      });

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
          // Chair vote-trigger message · register it as awaiting voice
          // so the vote popover stays suppressed through the gap
          // between message-appended and the first voice-chunk. Scoped
          // to round-prompt + round-end (the two kinds that surface the
          // chair-seat popover) so unrelated chair pings don't gate
          // anything. Voice-mode only · text mode has no such gap.
          if (
            data.authorKind === "agent"
            && this.currentChair && data.authorId === this.currentChair.id
            && data.meta && (data.meta.kind === "round-prompt" || data.meta.kind === "round-end")
            && this.currentRoom && this.currentRoom.deliveryMode === "voice"
          ) {
            this._chairVoiceAwaiting = this._chairVoiceAwaiting || new Set();
            this._chairVoiceAwaiting.add(data.messageId);
            const mid = data.messageId;
            // Safety net · 12s ceiling in case TTS never delivers
            // (network drop, server failure). Triggers a repaint so the
            // panel can finally surface without the user being stuck.
            setTimeout(() => {
              if (this._chairVoiceAwaiting && this._chairVoiceAwaiting.delete(mid)) {
                this.renderRoundTable();
              }
            }, 12000);
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

          // Round-table stage · a new streaming message is the most
          // robust "speaker started" signal we have for the chair
          // (whose clarify / intro turns never enter the director
          // queue). Repaint the seats so the bubble lands on the
          // correct agent immediately. Cheap when stage is hidden.
          if (data.authorKind === "agent") this.renderRoundTable();
          // User-seat presence · the moment the user sends a message
          // their seat appears next to the chair (if not already
          // visible) and a 10s speech bubble shows their typed text.
          // showUserBubble itself triggers a renderRoundTable so we
          // don't need a separate paint here. The seat persists for
          // the rest of the room session even after the bubble auto-
          // dismisses.
          if (data.authorKind === "user") {
            this.userSeatVisible = true;
            this.showUserBubble(data.body || "");
          }
          // Chair clarify bubble · drop it the moment ANY new message
          // arrives that isn't another chair clarify (a user reply, a
          // director turn, or the chair moving past the clarify
          // phase). Without this the 10s timer alone leaves the
          // question hovering over the chair seat while the user's
          // own reply bubble or the next speaker's turn already
          // owns the stage — visually confusing.
          if (this.chairBubble && !this.chairBubble.dismissed) {
            const isAnotherClarify =
              data.authorKind === "agent" &&
              this.currentChair &&
              data.authorId === this.currentChair.id &&
              (data.meta || {}).kind === "clarify";
            if (!isAnotherClarify) this.dismissChairBubble();
          }
          // Round-table toasts · gamified surface for chair-emitted
          // template messages (round-open marker, etc.) that the
          // chat normally renders as system cards. Only toast for
          // markers, not actual chair-spoken messages (those have
          // their own bubble + audio).
          {
            const meta = data.meta || {};
            const kind = meta.kind;
            if (kind === "round-open") {
              const round = data.roundNum || meta.roundNum || "—";
              this.showRoundTableToast({
                kind: "round",
                glyph: "▶",
                htmlText: `Round <em>${this.escape(String(round))}</em> begins`,
              });
            }
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
            // Voice-mode auto-vote · the chair just dropped its
            // round-prompt at round wrap. In stage view there's no
            // visible Open-vote / Continue / Adjourn button, so mount
            // the centered overlay (the same one used for the post-
            // round-end vote phase) with the round-prompt card
            // embedded · gives the user a clear way to advance the
            // round without leaving the stage.
            this._rtVoteOverlayDismissed = false;
            this.refreshRtVoteOverlay();
          } else if (!isChairSettings) {
            this.cancelContinueCountdown();
            this.repaintAllRoundPrompts();
            // Any non-prompt message arriving means the round has
            // moved on · drop the overlay if it was showing a now-
            // spent prompt.
            this.refreshRtVoteOverlay();
          }
        }
      });

      this.sse.addEventListener("message-token", (e) => {
        const data = JSON.parse(e.data);
        const msg = this.currentMessages.find((m) => m.id === data.messageId);
        if (!msg) return;
        const wasEmpty = !String(msg.body || "").trim();
        msg.body += data.delta;
        this.updateMessageBodyDom(data.messageId, msg.body, true);
        this.scrollChatToBottom();
        // Round-table stage · the very first token transitions the
        // bubble from "thinking" (amber) to "speaking" (lime). Only
        // repaint on that boundary; subsequent tokens don't change
        // the stage state, so we skip the repaint to keep the SSE
        // hot path cheap.
        if (wasEmpty) this.renderRoundTable();
        // Subtitle · cheap DOM-only update on every token so the
        // tail of the speaker's text scrolls live at the bottom of
        // the stage. Bails fast when no speaker is mid-stream.
        this.renderRtSubtitle();
        // Typing-SFX presence cue · the module throttles internally,
        // mutes when the tab is backgrounded, and respects the user's
        // toggle in Preference → User. Safe to call on every chunk.
        window.boardroomTypingSfx && window.boardroomTypingSfx.tick();
      });

      this.sse.addEventListener("message-final", (e) => {
        const data = JSON.parse(e.data);
        const msg = this.currentMessages.find((m) => m.id === data.messageId);
        if (msg) {
          msg.meta = msg.meta || {};
          msg.meta.streaming = false;
          msg.meta.speakerStatus = "final";
        }
        // Chair clarify · in voice mode, the chair's clarifying
        // question just finished streaming. Pin the question text to
        // the chair seat as a 10s countdown bubble (border-progress
        // ring, same mechanic as the user bubble). Voice-mode only ·
        // text mode users read the question inline in the scroll, so
        // a duplicate bubble would just clutter the stage.
        if (
          msg && msg.authorKind === "agent"
          && this.currentChair && msg.authorId === this.currentChair.id
          && msg.meta && msg.meta.kind === "clarify"
          && this.currentRoom && this.currentRoom.deliveryMode === "voice"
          && this.currentRoom.status !== "adjourned"
        ) {
          this.showChairBubble(msg.body);
        }
        // Round-table stage · the speaker just finished, so the
        // bubble should drop. Repaint the seats so the lime ring
        // / bubble migrate to whoever's next (director queue head)
        // or fade entirely if no one else is queued.
        this.renderRoundTable();
        // Subtitle · stream finished. In voice mode the subtitle
        // stays up until the voice queue drains (handled by
        // renderRtSubtitle's fallback branch); in text mode it
        // hides immediately since no voice clip is queued.
        this.renderRtSubtitle();
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
        // Stop any voice playback for this message (e.g. READY control token)
        const vq = this.voiceQueues[data.messageId];
        if (vq) {
          if (vq.audio) { try { vq.audio.pause(); } catch(_) {} }
          delete this.voiceQueues[data.messageId];
        }
        // Drop the empty placeholder bubble.
        this.currentMessages = this.currentMessages.filter((m) => m.id !== data.messageId);
        const article = document.querySelector(`[data-message-id="${data.messageId}"]`);
        if (article) article.remove();
      });

      this.sse.addEventListener("voice-chunk", (e) => {
        const data = JSON.parse(e.data);
        // First chunk for a new messageId means audio playback is
        // starting for that message · repaint the round-table so
        // the bubble appears on the speaking seat. Catches chair
        // templated announcements that emit voice without setting
        // meta.streaming. Skipping when a queue already exists keeps
        // the SSE hot path cheap (we don't repaint per chunk).
        const fresh = !this.voiceQueues[data.messageId];
        // Voice has actually arrived for this messageId · clear it
        // from the awaiting-voice set so isChairBusy hands off to the
        // voiceQueues check (which keeps the panel suppressed until
        // _fireVoiceDone removes the queue at audio end).
        if (fresh && this._chairVoiceAwaiting) {
          this._chairVoiceAwaiting.delete(data.messageId);
        }
        // Chair gavel SFX · fire ONCE when fresh chair voice starts
        // streaming, so the user hears the courtroom "knock-knock"
        // calling for attention before the chair speaks. Detection:
        // pull the message from currentMessages by id, check author
        // is the chair. Fires before enqueueVoiceChunk schedules the
        // first audio buffer, so the gavel overlaps only the audio
        // header / chunker startup (~50-100ms of inaudible buffer),
        // not the chair's first spoken word. Same enabled-flag as
        // typing/speaker-change · respects user-settings sound toggle.
        if (fresh && this.currentChair && window.boardroomTypingSfx
            && typeof window.boardroomTypingSfx.gavel === "function") {
          const msg = (this.currentMessages || []).find((m) => m.id === data.messageId);
          if (msg && msg.authorKind === "agent" && msg.authorId === this.currentChair.id) {
            window.boardroomTypingSfx.gavel();
          }
        }
        this.enqueueVoiceChunk(roomId, data);
        if (fresh) {
          this.renderRoundTable();
          // Subtitle · fresh voice playback starting. For chair
          // templated voice (no streaming flag), this is the only
          // moment renderRtSubtitle gets called — pin the caption.
          this.renderRtSubtitle();
          // Auto-continue countdown · the round-prompt's message-
          // appended fired BEFORE its first voice-chunk arrived (the
          // server inserts the message, then synthesises audio), so
          // the countdown started prematurely while the voice queue
          // wasn't created yet. Now that voice playback is starting,
          // cancel any premature countdown · _fireVoiceDone restarts
          // it cleanly when audio actually finishes. Without this,
          // the timer ate ~half its window behind the hidden popover
          // and the panel surfaced with only 2-3s left.
          this.maybeStartContinueCountdown();
        }
      });

      this.sse.addEventListener("voice-final", (e) => {
        const data = JSON.parse(e.data);
        const q = this.voiceQueues[data.messageId] || (this.voiceQueues[data.messageId] = { chunks: [], final: false, scheduled: false, roomId, messageId: data.messageId });
        q.final = true;
        q.messageId = data.messageId;
        q.roomId = roomId;
        this.drainVoiceQueue(roomId, data.messageId);
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
          // Hard pause: stop audio immediately (speaker was aborted mid-stream).
          // Soft pause: let current audio finish naturally (speaker completed their turn).
          if (payload.mode === "hard") {
            this.stopVoicePlayback();
          }
          document.documentElement.classList.remove("pause-pending");
          document.documentElement.setAttribute("data-status", "paused");
          this.renderHeader();
          this.renderPausedBar();
          // Toggle button has TWO twins (one in input-bar, now hidden
          // by display:none, and one in paused-bar that just got
          // (re)rendered). Sync glyph/aria/hidden on both so the
          // user keeps the voice/transcript switch while paused.
          this.applyRoundTableVisibility(this.currentRoomId);
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
          // Resume · the input-bar's toggle is now visible again
          // (paused-bar went display:none). Re-sync both twins so
          // glyph/aria/hidden land correctly on the live one.
          this.applyRoundTableVisibility(this.currentRoomId);
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
          // Adjourning from the round-end vote overlay's "Adjourn &
          // file" path skips round-resumed — drop the overlay here
          // so it doesn't linger over the brief-loading screen.
          this._rtVoteOverlayDismissed = false;
          this.closeRtVoteOverlay();
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
          // Mode determines BOTH the seeded stage map and which pip
          // rail renderBriefStages picks. Bento, magazine, and
          // newspaper modes each emit only 2 stage events (extract
          // + write), so seeding the 7-stage layout for a
          // structured-mode brief leaves the 5 middle pips forever
          // pending — the rail then renders with a row of dead
          // black pips between extract and write. Read mode from
          // the payload (server includes it on brief-started for
          // exactly this reason) and seed accordingly.
          const isStructured = this.isStructuredBriefMode(payload.mode);
          const briefMode = isStructured ? payload.mode : "research-note";
          const seededStages = isStructured
            ? {
                extract: { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
                write:   { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              }
            : {
                extract:             { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
                compose:             { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
                "scaffold-anchor":   { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
                "scaffold-findings": { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
                "scaffold-cluster":  { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
                "scaffold-actions":  { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
                write:               { status: "pending", detail: "", progress: null, startedAt: null, etaSec: null },
              };
          const newBrief = {
            id: payload.briefId,
            title: "Generating…",
            bodyMd: "",
            style: payload.style || "mckinsey",
            mode: briefMode,
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
            stages: seededStages,
            llmLogs: [],
            llmLogOpen: false,
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
        } else if (kind === "brief-llm-start") {
          this.markBriefEvent();
          const target = this._briefById(payload.briefId);
          if (target && payload.log) {
            const logs = target.llmLogs || (target.llmLogs = []);
            const idx = logs.findIndex((l) => l.id === payload.log.id);
            const log = { ...payload.log, text: payload.log.text || "" };
            if (idx >= 0) logs[idx] = log;
            else logs.push(log);
            if (this.currentBrief && this.currentBrief.id === target.id) this.renderBrief();
          }
        } else if (kind === "brief-llm-token") {
          this.markBriefEvent();
          const target = this._briefById(payload.briefId);
          if (target && payload.logId) {
            const logs = target.llmLogs || (target.llmLogs = []);
            const log = logs.find((l) => l.id === payload.logId);
            if (log) {
              const limit = 6000;
              if ((log.text || "").length < limit) {
                log.text = ((log.text || "") + (payload.delta || "")).slice(0, limit);
              }
              if (this.currentBrief && this.currentBrief.id === target.id && target.llmLogOpen) {
                const now = Date.now();
                if (!this._briefLlmLastRender || (now - this._briefLlmLastRender) > 500) {
                  this._briefLlmLastRender = now;
                  this.renderBrief();
                }
              }
            }
          }
        } else if (kind === "brief-llm-end") {
          this.markBriefEvent();
          const target = this._briefById(payload.briefId);
          if (target && payload.logId) {
            const logs = target.llmLogs || (target.llmLogs = []);
            const log = logs.find((l) => l.id === payload.logId);
            if (log) {
              log.status = payload.status || log.status;
              log.finishedAt = typeof payload.finishedAt === "number" ? payload.finishedAt : Date.now();
              if (typeof payload.totalTokens === "number") log.totalTokens = payload.totalTokens;
              if (typeof payload.error === "string") log.error = payload.error;
              if (this.currentBrief && this.currentBrief.id === target.id) this.renderBrief();
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
          // No typing-SFX during the brief writer's Stage 3 stream.
          // The write phase is a long, off-screen streaming pass (the
          // user is usually reading prior content or doing something
          // else while the report builds) — a continuous click track
          // for tens of seconds reads as background noise, not a
          // presence cue. Director / chair turns still tick because
          // those land in the active conversation the user is
          // following.
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
            if (ch.deliveryMode) this.currentRoom.deliveryMode = ch.deliveryMode.to;
            if (ch.voteTrigger) this.currentRoom.voteTrigger = ch.voteTrigger.to;
          }
          this.renderHeader();
          syncSidebar({
            mode: this.currentRoom?.mode,
            intensity: this.currentRoom?.intensity,
            briefStyle: this.currentRoom?.briefStyle,
          });
          // Server-driven deliveryMode flip · sync the round-table
          // stage's visibility so the user's view matches reality
          // even when the change came from another tab / device.
          if (ch.deliveryMode) this.applyRoundTableVisibility(this.currentRoomId);
          // Server-driven voteTrigger flip · show/hide the bottom-
          // bar manual button immediately.
          if (ch.voteTrigger) this.refreshManualVoteButton();
          // Round-table toasts · gamified surface for room-state
          // changes that the chat would render as system messages.
          // No-op when the stage isn't visible (chat view handles).
          for (const k of ["mode", "intensity", "briefStyle", "deliveryMode", "voteTrigger"]) {
            if (ch[k]) {
              const txt = this._roundTableSettingToast(k, ch[k].from, ch[k].to);
              if (txt) this.showRoundTableToast({ kind: "settings", glyph: "↗", htmlText: txt });
            }
          }
        } else if (kind === "members-changed") {
          // Patch currentMembers in place from the server's add/remove
          // diff. Avoids a refetch round-trip and keeps the chat header,
          // brief stamps, and roster strip in sync as soon as the chair's
          // welcome message lands.
          const added = Array.isArray(payload.added) ? payload.added : [];
          const removed = Array.isArray(payload.removed) ? payload.removed : [];
          const byId = {};
          for (const a of (this.agents || [])) byId[a.id] = a;
          // Snapshot names BEFORE patching so removed-agent names are
          // still resolvable for the toast. After the splice they're
          // gone from currentMembers.
          const removedNames = removed.map((id) => {
            const live = (this.currentMembers || []).find((m) => m.id === id) || byId[id];
            return live?.name || id;
          });
          if (removed.length > 0) {
            this.currentMembers = this.currentMembers.filter((m) => !removed.includes(m.id));
          }
          for (const aid of added) {
            if (byId[aid] && !this.currentMembers.find((m) => m.id === aid)) {
              this.currentMembers.push(byId[aid]);
            }
          }
          // Mirror the diff into historicalMembers so excused
          // directors stay queryable for chat-history + voice
          // replay lookups. Removal flips `removedAt` to now;
          // re-adding clears it back to null. New additions
          // append the snapshot from the global agents catalog.
          if (!Array.isArray(this.currentHistoricalMembers)) {
            this.currentHistoricalMembers = [];
          }
          if (removed.length > 0) {
            const ts = Date.now();
            for (const id of removed) {
              const entry = this.currentHistoricalMembers.find((m) => m.id === id);
              if (entry) entry.removedAt = ts;
              else if (byId[id]) this.currentHistoricalMembers.push({ ...byId[id], removedAt: ts });
            }
          }
          for (const aid of added) {
            const entry = this.currentHistoricalMembers.find((m) => m.id === aid);
            if (entry) entry.removedAt = null;
            else if (byId[aid]) this.currentHistoricalMembers.push({ ...byId[aid], removedAt: null });
          }
          this.renderHeader();
          this.renderQueue();
          // Round-table toasts · one chip per added / removed agent.
          for (const aid of added) {
            const a = byId[aid];
            const name = a?.name || aid;
            this.showRoundTableToast({
              kind: "add",
              glyph: "+",
              htmlText: `<em>${this.escape(name)}</em> joined the room`,
            });
          }
          for (let i = 0; i < removed.length; i++) {
            this.showRoundTableToast({
              kind: "remove",
              glyph: "−",
              htmlText: `<em>${this.escape(removedNames[i])}</em> left the room`,
            });
          }
        } else if (kind === "round-ended") {
          // Chair finished a round-end summary. Persist the parsed key
          // points + flip the room into awaiting-continue so the input
          // bar and round-end card know to surface Continue / Adjourn.
          if (this.currentRoom) {
            this.currentRoom.awaitingContinue = true;
            // The deferred-vote queue (manual trigger after current
            // speaker) is honored once round-ended fires — clear the
            // local "queued" hint so the button drops its queued
            // state and refreshManualVoteButton's gates apply.
            this.currentRoom.voteQueued = false;
          }
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
          // Round-table stage · the chair has just finished round-end
          // and entered the vote phase. Repaint so the floating
          // vote popover lands on the chair seat.
          this.renderRoundTable();
          // Voice mode · auto-mount the centered vote overlay so the
          // user can vote on key-points + pick Continue / Adjourn.
          // Reset the manual-dismiss flag for this fresh round so the
          // overlay opens even if the user dismissed the previous
          // round's overlay.
          this._rtVoteOverlayDismissed = false;
          this.refreshRtVoteOverlay();
          // Replace the skeleton round-end card (mounted earlier when
          // the chair placeholder message-appended fired) with the
          // full card now that key-points are persisted. repaint
          // iterates ALL matching cards · so the chat + the overlay's
          // embedded card both update.
          if (payload.messageId) this.repaintRoundEndCard(payload.messageId);
        } else if (kind === "key-point-voted") {
          const p = this.currentKeyPoints.find((x) => x.id === payload.keyPointId);
          if (p) {
            p.vote = payload.vote;
            this.repaintRoundEndCard(p.messageId);
            // Server-driven vote update · sync the HUD's VOTES counter.
            this.renderRoundTableHud();
          }
        } else if (kind === "round-resumed") {
          if (this.currentRoom) this.currentRoom.awaitingContinue = false;
          // Strip the [Continue / Adjourn] CTAs from the rendered chat;
          // the round-end card stays as a historical artefact.
          document.querySelectorAll(".round-end-card .kp-ctas").forEach((el) => {
            el.outerHTML = `<div class="kp-ctas-spent">// continued</div>`;
          });
          // Round-table stage · vote phase has ended (user resumed),
          // drop the floating vote popover from the chair seat.
          this.renderRoundTable();
          // Voice-mode vote overlay · auto-close when the user has
          // resumed (server-driven). Clear the dismissed flag so the
          // next round's vote overlay can mount fresh.
          this._rtVoteOverlayDismissed = false;
          this.closeRtVoteOverlay();
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
    async createRoom({ subject, agentIds, mode, intensity, briefStyle, autoPick, deliveryMode, seedContext }) {
      const r = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject,
          agentIds,
          mode: mode || "constructive",
          intensity: intensity || "sharp",
          briefStyle: briefStyle || "auto",
          deliveryMode: deliveryMode === "voice" ? "voice" : "text",
          ...(autoPick ? { autoPick: true } : {}),
          // seedContext · attached when the user opened this room
          // from a topic-rec card. Backend writes it to the
          // opening message's meta so the chair grounds clarify
          // in the actual source snippets.
          ...(seedContext ? { seedContext } : {}),
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

    /** Has the brief got its body content yet? Mode-aware check ·
     *  research-note briefs land their content in `bodyMd`; bento
     *  briefs land theirs in `bodyJson` and leave bodyMd empty. The
     *  card-rendering / placeholder-detection / generating-check
     *  logic uses this everywhere so a bento brief doesn't stay
     *  stuck in "generating…" state after the BentoScaffold has
     *  actually been persisted.
     *
     *  Without this helper, a successful bento generation followed
     *  by a page refresh hid the View Report button forever (the
     *  card thought it was still generating because bodyMd was empty
     *  — which is the steady-state shape for bento, not an
     *  in-flight signal). */
    /** True for any structured-output mode — magazine, newspaper,
     *  ppt — that persists to body_json instead of body_md and
     *  runs the single-pass chair-LLM pipeline (extract + write
     *  only, no Stage 2/3 scaffold/write). Centralised so future
     *  modes touch one place. */
    isStructuredBriefMode(mode) {
      return mode === "magazine" || mode === "newspaper" || mode === "ppt";
    },

    briefHasBody(b) {
      if (!b) return false;
      if (this.isStructuredBriefMode(b.mode)) {
        // Magazine, newspaper + ppt all populate bodyJson with the
        // structured scaffold. An empty object isn't a body; check
        // for at least a title field.
        const j = b.bodyJson;
        return !!(j && typeof j === "object" && (j.title || j.milestones));
      }
      // Default research-note · body lives in markdown.
      return !!(b.bodyMd && b.bodyMd.trim());
    },

    /** Build the right viewer URL for a brief based on its mode.
     *  · 'research-note' (default · or unknown) → `/report.html?r=R&b=B`
     *  · 'magazine' → `/magazine.html?b=B`
     *  · 'newspaper' → `/newspaper.html?b=B`
     *  · 'ppt' → `/ppt.html?b=B`
     *
     *  Structured renderers don't need the room context · the brief
     *  is self-contained. Used by the View Report button, the
     *  brief-picker popover, the open-report link in the brief card,
     *  and the All Reports page — one helper so a future renderer
     *  route change touches one place. */
    briefViewerHref(b, roomId) {
      if (!b || !b.id) return null;
      const id = encodeURIComponent(b.id);
      if (b.mode === "magazine") return `/magazine.html?b=${id}`;
      if (b.mode === "newspaper") return `/newspaper.html?b=${id}`;
      if (b.mode === "ppt") return `/ppt.html?b=${id}`;
      const r = roomId ? encodeURIComponent(roomId) : "";
      return r ? `/report.html?r=${r}&b=${id}` : `/report.html?b=${id}`;
    },

    /** Human-readable label for a brief's mode · used in the brief-card
     *  banner so the user sees which renderer the report will use
     *  before they open it.
     *
     *  IMPORTANT · the user-facing label for `research-note` is
     *  "Report", NOT "Research Note". The internal mode key stays as
     *  `research-note` (storage column, API value, picker option id),
     *  but every user-facing surface — the mode picker (`renderBrief-
     *  ModePicker` line ~1662 in this file), the report viewer's
     *  header, etc. — calls it "Report". Keep this map in sync with
     *  the picker labels rather than inventing a fresh user-facing
     *  vocabulary.
     *
     *  Legacy rows without an explicit `mode` default to "Report" by
     *  the same backfill the storage layer applies. */
    briefModeLabel(b) {
      const mode = (b && b.mode) || "research-note";
      switch (mode) {
        case "magazine":  return "Magazine";
        case "newspaper": return "Newspaper";
        case "ppt":       return "Slides";
        default:          return "Report";
      }
    },

    /** Render the report-mode picker · four icon-tile cards that let
     *  the user pick between research-note, magazine, newspaper, and
     *  ppt (slides). Each tile shows a custom monoline SVG that
     *  visually mirrors that mode's layout — research-note as a memo,
     *  magazine as a masthead + numeral block + small cards,
     *  newspaper as a banner + 3-column text grid, ppt as a slide
     *  rectangle with bullet lines. The native radio is visually
     *  hidden (kept in the DOM for a11y / keyboard nav).
     *
     *  Used by both the adjourn overlay (filing the report at
     *  adjourn-time / generate-brief flow) AND the supplement
     *  overlay (regenerating with an extra perspective). The picker
     *  reads its selected option via `input[name="brief-mode"]:checked`
     *  from inside whatever overlay it lives in · the click-to-toggle
     *  handler scopes to the `.adjourn-mode-options` container so it
     *  works for any overlay embedding the picker. */
    renderBriefModePicker(defaultMode) {
      const safe = this.isStructuredBriefMode(defaultMode) ? defaultMode : "research-note";
      // Icon SVGs · `currentColor` lets each tile pick up its hover /
      // selected accent from the parent `.adjourn-mode-icon { color }`
      // rule. Stroke hierarchy is deliberate · main outlines at 1.0,
      // a single emphasis rule at 1.2 (newspaper headline + magazine
      // masthead bar), body details at 0.8. Filled blocks soften to
      // currentColor at 0.5 opacity so the lime selected-state reads
      // as a tint rather than a slab. The 24-unit viewBox renders at
      // 36px on screen → 1.5× scale, so stroke-1.0 is a clean 1.5px.
      const ICONS = {
        "research-note": `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 3h9l4 4v14H6z"/>
            <path d="M15 3v4h4"/>
            <line x1="9" y1="12" x2="16" y2="12"/>
            <line x1="9" y1="15" x2="16" y2="15"/>
            <line x1="9" y1="18" x2="14" y2="18"/>
          </svg>`,
        "magazine": `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="3" y1="4" x2="21" y2="4" stroke-width="1.2"/>
            <rect x="3" y="7" width="6" height="9" rx="1.2"/>
            <rect x="11" y="7" width="4.5" height="4" rx="1.2"/>
            <rect x="16.5" y="7" width="4.5" height="4" rx="1.2"/>
            <rect x="11" y="12" width="4.5" height="4" rx="1.2"/>
            <rect x="16.5" y="12" width="4.5" height="4" rx="1.2"/>
            <rect x="3" y="18" width="18" height="3" rx="1" fill="currentColor" fill-opacity="0.45" stroke="none"/>
          </svg>`,
        "newspaper": `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="2.5" fill="currentColor" fill-opacity="0.85" stroke="none"/>
            <line x1="7" y1="8" x2="17" y2="8" stroke-width="1.2"/>
            <line x1="4" y1="11.5" x2="8" y2="11.5" stroke-width="0.8"/>
            <line x1="4" y1="13.5" x2="8" y2="13.5" stroke-width="0.8"/>
            <line x1="4" y1="15.5" x2="6.5" y2="15.5" stroke-width="0.8"/>
            <line x1="10" y1="11.5" x2="14" y2="11.5" stroke-width="0.8"/>
            <line x1="10" y1="13.5" x2="14" y2="13.5" stroke-width="0.8"/>
            <line x1="10" y1="15.5" x2="12.5" y2="15.5" stroke-width="0.8"/>
            <line x1="16" y1="11.5" x2="20" y2="11.5" stroke-width="0.8"/>
            <line x1="16" y1="13.5" x2="20" y2="13.5" stroke-width="0.8"/>
            <line x1="16" y1="15.5" x2="18.5" y2="15.5" stroke-width="0.8"/>
            <line x1="3" y1="18.5" x2="21" y2="18.5" stroke-width="0.9"/>
          </svg>`,
        "ppt": `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="13" rx="1"/>
            <line x1="7" y1="9" x2="14" y2="9" stroke-width="1.2"/>
            <line x1="7" y1="12" x2="17" y2="12" stroke-width="0.8"/>
            <line x1="7" y1="14" x2="15" y2="14" stroke-width="0.8"/>
            <circle cx="5.5" cy="12" r="0.6" fill="currentColor" stroke="none"/>
            <circle cx="5.5" cy="14" r="0.6" fill="currentColor" stroke="none"/>
            <line x1="10" y1="20" x2="14" y2="20" stroke-width="1"/>
            <line x1="12" y1="17" x2="12" y2="20" stroke-width="0.6"/>
          </svg>`,
      };
      const opt = (value, title, deck, primary) => `
            <label class="adjourn-mode-option${primary ? " adjourn-mode-option-primary" : ""}${safe === value ? " on" : ""}">
              <input type="radio" name="brief-mode" value="${value}"${safe === value ? " checked" : ""}>
              <div class="adjourn-mode-icon">${ICONS[value] || ""}</div>
              <div class="adjourn-mode-body">
                <div class="adjourn-mode-title">${title}</div>
                <div class="adjourn-mode-deck">${deck}</div>
              </div>
            </label>`;
      return `
        <div class="adjourn-mode-picker" data-mode-picker>
          <div class="adjourn-mode-label">// report format</div>
          <div class="adjourn-mode-options adjourn-mode-options-4">
            ${opt("research-note", "Report", "Long-form markdown · bottom line, findings, recommendations.", true)}
            ${opt("magazine", "Magazine", "Editorial spread · cover line, 5 cards, dark closer.")}
            ${opt("newspaper", "Newspaper", "Broadsheet · banner masthead, 3-column editorial.")}
            ${opt("ppt", "Slides", "Slide deck · 7-9 slides, arrow-key navigation, present mode.")}
          </div>
        </div>`;
    },

    /** Read the user's last-picked report mode from localStorage so the
     *  picker defaults to their previous choice. Falls back to
     *  'research-note' on first run / private mode. */
    lastBriefMode() {
      try {
        const v = localStorage.getItem("pb.briefMode");
        return this.isStructuredBriefMode(v) ? v : "research-note";
      } catch { return "research-note"; }
    },
    saveLastBriefMode(mode) {
      try {
        const safe = this.isStructuredBriefMode(mode) ? mode : "research-note";
        localStorage.setItem("pb.briefMode", safe);
      } catch { /* private-mode etc. — silently ignore */ }
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

    /** Pure cache read · true when at least one voice provider
     *  (MiniMax / ElevenLabs) is configured. The composer's voice
     *  toggle calls this before flipping ON; if false, we redirect
     *  the user to the keys panel rather than silently enabling a
     *  feature that has no provider behind it. */
    hasAnyVoiceKey() {
      const VOICE_PROVIDERS = ["minimax", "elevenlabs"];
      const keys = this.keys || {};
      return VOICE_PROVIDERS.some((p) => keys[p] && keys[p].configured);
    },

    /** Secondary hint under a failed brief · the legacy copy always blamed
     *  missing keys even when stage-2 scaffolding failed after successful
     *  LLM calls. Route hints by substring of the server's `brief-error`
     *  message (`NoKeyError` vs scaffold failures vs everything else). */
    _briefSecondaryHintHtml(errorText) {
      const s = String(errorText || "").toLowerCase();
      if (/no key configured|no openrouter fallback|add a key in preference/i.test(s)) {
        return this._t("brief_err_hint_failed_html");
      }
      if (
        /couldn't structure|report writer couldn't|json scaffold|repeat(ed)? attempts|retries failed|parse scaffold|\[brief\.stage2\]|stage 2/i.test(s)
      ) {
        return this._t("brief_err_hint_scaffold_html");
      }
      return this._t("brief_err_hint_generic_html");
    },

    /** Modal that fires when an AI action is attempted but no model
     *  provider key is configured. Two CTAs · open settings (preferred)
     *  or dismiss. Same chrome family as openSendChoiceModal so the
     *  visual treatment stays consistent. */
    openNoKeyModal() {
      this.closeNoKeyModal();
      const t = {
        title: this._t("nk_title"),
        deck: this._t("nk_deck"),
        primary: this._t("nk_primary"),
        dismiss: this._t("nk_dismiss"),
        classification: this._t("nk_classification"),
        tag: this._t("nk_tag"),
        primaryDeck: this._t("nk_primary_deck"),
        gate: this._t("nk_frontend_gate"),      };
      const html = `
        <div id="no-key-overlay" class="pc-overlay" data-no-key-overlay>
          <div class="pc-modal">
            <div class="pc-classification">
              <span><span class="dot">●</span> ${this.escape(t.classification)}</span>
              <span class="right">${this.escape(t.gate)}</span>
            </div>
            <div class="pc-head">
              <div class="pc-tag">${this.escape(t.tag)}</div>
              <h2 class="pc-title">${this.escape(t.title)}</h2>
              <p class="pc-deck">${this.escape(t.deck)}</p>
            </div>
            <div class="pc-body">
              <button type="button" class="pc-choice primary" data-no-key-open-settings>
                <div class="pc-choice-mark">${this.escape(t.primary)}</div>
                <div class="pc-choice-deck">${this.escape(t.primaryDeck)}</div>              </button>
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
      const speakerName = speaker ? speaker.name : this._t("sc_speaker_fallback");
      const speakerLabel = this.escape(speakerName);
      const html = `
        <div id="send-choice-overlay" class="pc-overlay">
          <div class="pc-modal">
            <div class="pc-classification">
              <span><span class="dot">●</span> ${this.escape(this._t("sc_send_class"))}</span>
              <span class="right">${this.escape(this._t("sc_send_right", { name: speakerName }))}</span>
            </div>
            <div class="pc-head">
              <div class="pc-tag">${this.escape(this._t("sc_send_tag"))}</div>
              <h2 class="pc-title">${this.escape(this._t("sc_send_title", { name: speakerName }))}</h2>
              <p class="pc-deck">${this.escape(this._t("sc_send_deck"))}</p>
            </div>
            <div class="pc-body">
              <button type="button" class="pc-choice" data-send-choice="interrupt">
                <div class="pc-choice-mark">${this.escape(this._t("sc_interrupt_mark"))}</div>
                <div class="pc-choice-deck">${this.escape(this._t("sc_interrupt_deck", { name: speakerName }))}</div>
              </button>
              <button type="button" class="pc-choice primary" data-send-choice="queue">
                <div class="pc-choice-mark">${this.escape(this._t("sc_queue_mark", { name: speakerName }))}</div>
                <div class="pc-choice-deck">${this.escape(this._t("sc_queue_deck"))}</div>
              </button>
              <button type="button" class="pc-choice ghost" data-send-choice="cancel">
                <div class="pc-choice-mark">${this.escape(this._t("sc_cancel_mark"))}</div>
                <div class="pc-choice-deck">${this.escape(this._t("sc_cancel_deck"))}</div>
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
        // know the message is parked. Also paints a "WAIT" marker on
        // the user seat in the round-table stage (renderRoundTable
        // reads `pendingUserMessage` to gate the marker).
        this.pendingUserMessage = text;
        this.pendingForSpeakerId = speakerId;
        this.renderQueue();
        this.renderRoundTable();
        // Server-side coordination: orchestrator drains this between
        // turns, AFTER current speaker finishes and BEFORE the next
        // speaker starts. The placeholder clears when the
        // message-appended SSE comes back.
        this.sendMessage(text, [], "after-speaker").catch((err) => {
          alert("Queue failed: " + err.message);
          this.pendingUserMessage = null;
          this.pendingForSpeakerId = null;
          this.renderQueue();
          this.renderRoundTable();
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
      // Drop the user-seat WAIT marker now that the queued message
      // has actually landed.
      this.renderRoundTable();
    },

    /** Adjourn the room. `opts.skipBrief = true` flips the server into
     *  no-report mode (room is still terminal, but no LLM call is
     *  fired and the briefs panel stays empty). */
    async adjournRoom(opts) {
      if (!this.currentRoomId) return;
      const skipBrief = !!(opts && opts.skipBrief);
      const mode = opts && this.isStructuredBriefMode(opts.mode)
        ? opts.mode
        : "research-note";
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
          body: JSON.stringify(skipBrief ? { skipBrief: true } : { mode }),
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
      const titleTxt = isGen ? this._t("adj_title_generate") : this._t("adj_title_file");
      const classifyTxt = isGen ? this._t("adj_classify_generate") : this._t("adj_classify_adjourn");
      const classifyRight = isGen ? this._t("adj_classify_right_posthoc") : this._t("adj_classify_right_terminal");
      const confirmTxt = isGen ? this._t("adj_confirm_generate") : this._t("adj_confirm_file");
      const subjectTxt = room.subject || room.name || "—";
      const memberCount = (this.currentMembers || []).length;
      const statusLabel = this._t(
        status === "paused" ? "adj_meta_status_paused"
        : status === "adjourned" ? "adj_meta_status_adjourned"
        : "adj_meta_status_live",
      );
      const roomKicker = this._t("adj_meta_room_kicker");
      const metaSep = this._t("adj_meta_sep");
      const metaTurns = this._t("adj_meta_turns", { n: turns });
      const noteTxt = isGen ? this._t("adj_note_generate") : this._t("adj_note_adjourn");
      const defaultMode = this.lastBriefMode();
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
                <div class="meta">${this.escape(roomKicker)}<span>${this.escape(String(room.number ?? "—"))}</span>${this.escape(metaSep)}<span class="${status === "live" ? "live" : "status"}">${this.escape(statusLabel)}</span>${this.escape(metaSep)}${this.escape(metaTurns)}</div>
                <div class="title">${this.escape(titleTxt)}</div>
              </div>
              <button type="button" class="adjourn-close" data-adjourn-close aria-label="${this.escape(this._t("adj_close_aria"))}">✕</button>
            </header>

            <div class="adjourn-body">
              <div class="adjourn-summary">
<div class="adjourn-summary-row adjourn-summary-row-subject">
                  <span class="adjourn-summary-key">${this.escape(this._t("adj_key_subject"))}</span>
                  <div class="adjourn-summary-val adjourn-subject-wrap">
                    <span class="adjourn-subject-text is-clamped" data-adjourn-subject>${this.escape(subjectTxt)}</span>
                    <button type="button" class="adjourn-subject-toggle" data-adjourn-subject-toggle hidden>Show more</button>
                  </div>
                </div>
                <div class="adjourn-summary-row">
                  <span class="adjourn-summary-key">${this.escape(this._t("adj_key_authors"))}</span>
                  <span class="adjourn-summary-val">${this.escape(this._t("adj_agents_count", { n: memberCount }))}</span>
                </div>
                <div class="adjourn-summary-row">
                  <span class="adjourn-summary-key">${this.escape(this._t("adj_key_turns"))}</span>
                  <span class="adjourn-summary-val">${turns}</span>
                </div>
              </div>
              <p class="adjourn-summary-note">
                ${this.escape(noteTxt)}
              </p>

              ${this.renderBriefModePicker(defaultMode)}
            </div>

            <footer class="adjourn-foot">
              ${isGen ? `<span class="adjourn-skip-spacer"></span>` : `
              <button type="button" class="adjourn-skip-btn" data-adjourn-skip>
                <span class="adjourn-skip-mark">⊘</span>
                <span>${this.escape(this._t("adj_skip"))}</span>
              </button>`}
              <div class="adjourn-foot-actions">
                <button type="button" class="adjourn-cancel" data-adjourn-close>${this.escape(this._t("adj_cancel"))}</button>
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
      // Subject clamp · the subject value is clamped to 3 lines by
      // default (a long room title shouldn't crowd the rest of the
      // overlay). After mount, measure whether the text actually
      // overflows the clamp — only then reveal the Show more / less
      // toggle. rAF lets the browser settle the initial layout so
      // scrollHeight is meaningful.
      requestAnimationFrame(() => {
        const subjEl = document.querySelector("[data-adjourn-subject]");
        const subjBtn = document.querySelector("[data-adjourn-subject-toggle]");
        if (subjEl && subjBtn && subjEl.scrollHeight > subjEl.clientHeight + 1) {
          subjBtn.hidden = false;
        }
      });
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
      // System UI · always English. Supplement-overlay chrome.
      const t = {
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
      // Default the picker to the user's last picked mode — same
      // behaviour as the adjourn (Generate) flow, so the picker reads
      // consistently across both surfaces. The parent brief's mode is
      // available if needed, but the user's most recent explicit
      // choice wins.
      const defaultMode = this.lastBriefMode();
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
              ${this.renderBriefModePicker(defaultMode)}
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
      // System UI · always English. Paused-supplement overlay chrome.
      const t = {
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
      const subject = (this.currentRoom.subject || "").trim() || "(no subject)";
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
      const subjectFull = room.subject || "(no subject)";

      // Tone + intensity inherit from parent. Trigger uses the same
      // `.cmp-dd` markup as the new-room composer's toolbar buttons —
      // option list, popover, and styling are all shared via the
      // existing `data-cmp-dropdown` machinery. The follow-up flow
      // simply scopes writes to the trigger itself (see global click
      // handler) instead of the composerState used by the inline
      // composer.
      const inheritedMode = (room.mode || "constructive").toLowerCase();
      const inheritedIntensity = (room.intensity || "sharp").toLowerCase();
      // Delivery mode silently inherits from the parent room — no user
      // toggle in this panel. A voice-mode parent produces a voice
      // follow-up only when a voice key is still configured; otherwise
      // it falls back to text so we don't ship a broken voice room.
      const voiceConfigured = this.hasAnyVoiceKey ? this.hasAnyVoiceKey() : false;
      const inheritedDeliveryMode = (room.deliveryMode === "voice" && voiceConfigured) ? "voice" : "text";

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
                <div class="followup-parent-subject is-clamped" data-followup-subject-text>${this.escape(subjectFull)}</div>
                <div class="followup-parent-meta-row">
                  <button type="button" class="followup-parent-subject-toggle" data-followup-subject-toggle hidden>Show more</button>
                  <div class="followup-parent-meta">${this.escape(adjournedLine)}${adjournedLine && briefLine ? " · " : ""}${this.escape(briefLine)}</div>
                </div>
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
                  <button type="button" class="cmp-dd" data-cmp-dropdown="tone" title="${this.escape(this._t("cmp_tone_label"))}">
                    <span class="cmp-dd-label">${this.escape(this._t("cmp_tone_label"))}</span>
                    <span class="cmp-dd-value" data-cmp-dd-value="tone">${this.escape(inheritedMode)}</span>
                    <span class="cmp-dd-chevron">▾</span>
                  </button>
                  <button type="button" class="cmp-dd" data-cmp-dropdown="intensity" title="${this.escape(this._t("cmp_intensity_label"))}">
                    <span class="cmp-dd-label">${this.escape(this._t("cmp_intensity_label"))}</span>
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
                data-parent-delivery-mode="${this.escape(inheritedDeliveryMode)}"
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
        // Subject clamp · long parent-room subjects clamp to 2 lines
        // by default. Post-mount measurement reveals the Show more /
        // less toggle only when the text actually overflows. rAF
        // settles initial layout so scrollHeight is meaningful.
        const subjEl = overlayEl.querySelector("[data-followup-subject-text]");
        const subjBtn = overlayEl.querySelector("[data-followup-subject-toggle]");
        if (subjEl && subjBtn) {
          requestAnimationFrame(() => {
            if (subjEl.scrollHeight > subjEl.clientHeight + 1) {
              subjBtn.hidden = false;
            }
          });
          subjBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            const expanded = subjEl.classList.toggle("is-clamped") === false;
            subjBtn.textContent = expanded ? "Show less" : "Show more";
          });
        }
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
        // System UI · always English (cast button chrome).
        const count = `${parents.length} · same as last`;
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
        // System UI · always English (cast button chrome).
        const autoKey = "directors";
        const autoVal = "auto-pick";
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
      // System UI · always English (cast button chrome count).
      const countText = `${picked.length} director${picked.length === 1 ? "" : "s"}`;
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
      const dirs = (this.agents || [])
        .filter((a) => a.roleKind !== "moderator")
        .slice()
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      // System UI · always English (director picker chrome).
      const t = { title: "Pick directors", hint: "2-4 recommended", info: "View profile" };
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
        <div class="composer-pick-list">${rows || `<div class="composer-pick-empty">${this.escape(this._t("picker_no_directors"))}</div>`}</div>
      `;
      document.body.appendChild(pop);
      // Position to fit the viewport · the follow-up overlay is
      // centered, and the cast button often sits near the bottom
      // of the modal · a naive `r.bottom + 6` puts the popover
      // off-screen and clips the director list. Pick the side
      // (above / below the button) with more room, then cap the
      // popover's max-height to that available space (minus a
      // small margin) so the inner list scrolls within view
      // instead of overflowing the viewport.
      const r = anchorBtn.getBoundingClientRect();
      const MARGIN = 8;
      const GAP = 6;
      const popW = Math.min(340, window.innerWidth - MARGIN * 2);
      const spaceBelow = window.innerHeight - r.bottom - GAP - MARGIN;
      const spaceAbove = r.top - GAP - MARGIN;
      const openAbove = spaceAbove > spaceBelow;
      const maxHeight = Math.max(120, openAbove ? spaceAbove : spaceBelow);
      pop.style.width = popW + "px";
      // Left-align to the anchor; clamp into viewport if the
      // anchor is near the right edge so we don't blow past
      // the right side either.
      const left = Math.min(
        Math.max(MARGIN, r.left),
        window.innerWidth - popW - MARGIN,
      );
      pop.style.left = left + "px";
      pop.style.maxHeight = maxHeight + "px";
      pop.style.top = openAbove
        ? (r.top - GAP - Math.min(pop.scrollHeight || maxHeight, maxHeight)) + "px"
        : (r.bottom + GAP) + "px";
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
      // Delivery mode silently inherits from the parent room (no
      // toggle in this panel). Without an explicit deliveryMode the
      // server defaults to "text", so a voice-mode parent's follow-up
      // would lose the round-table + voice/transcript toggle.
      const followupDeliveryMode = btn?.getAttribute("data-parent-delivery-mode") === "voice"
        ? "voice"
        : "text";
      const payload = {
        subject,
        mode: tone,
        intensity,
        deliveryMode: followupDeliveryMode,
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
      // Read the report-mode picker (research-note / bento). The
      // overlay defaults the picker to the existing brief's mode, so a
      // plain "regenerate with this perspective" keeps the same
      // format. Persisting the choice keeps the picker stable next
      // time. Server-side the same `/api/rooms/:id/brief` route reads
      // `mode` regardless of whether the call came from supplement or
      // generate-brief, so no backend change is needed.
      const briefModeInput = overlay.querySelector('input[name="brief-mode"]:checked');
      const v = briefModeInput && briefModeInput.value;
      const briefMode = this.isStructuredBriefMode(v) ? v : "research-note";
      this.saveLastBriefMode(briefMode);
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
            body: JSON.stringify({ supplement: text, mode: briefMode }),
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
      if (this.briefHasBody(brief)) return false;
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
      if (Array.isArray(state.llmLogs)) {
        brief.llmLogs = state.llmLogs.map((l) => ({
          id: String(l.id || ""),
          stage: String(l.stage || ""),
          label: String(l.label || ""),
          modelV: String(l.modelV || ""),
          status: l.status === "done" || l.status === "failed" ? l.status : "running",
          startedAt: typeof l.startedAt === "number" ? l.startedAt : Date.now(),
          finishedAt: typeof l.finishedAt === "number" ? l.finishedAt : null,
          text: String(l.text || ""),
          totalTokens: typeof l.totalTokens === "number" ? l.totalTokens : null,
          error: typeof l.error === "string" ? l.error : null,
        })).filter((l) => l.id);
      }
    },

    /** Delete a single brief from this room's history. Asks for
     *  confirmation, then DELETE /api/briefs/:id, then patches local
     *  state. If the active brief is removed, switch to the newest
     *  remaining brief; if none remain, clear the card entirely. */
    async deleteBriefAt(briefId) {
      if (!briefId) return;
      const target = (this.currentBriefs || []).find((b) => b.id === briefId);
      // System UI · always English. Confirm + alert dialogs are app
      // chrome and stay fixed-string regardless of brief language.
      const isStillGenerating = !!(target && !this.briefHasBody(target));
      const confirmText = isStillGenerating
        ? "This report is still generating. Deleting will stop the generation and remove the report. This can't be undone."
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
        alert("Delete failed: " + (e && e.message ? e.message : e));
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
        // Preserve the failed brief's mode on retry · without this
        // the POST defaulted back to `research-note` regardless of
        // whether the user originally picked Magazine / Newspaper /
        // Slides. Same goes for the supplement string (regenerate-
        // with-perspective flow). Anything else (style etc) is
        // re-derived server-side from the room's stored config.
        const retryBody = {};
        if (failed && this.isStructuredBriefMode(failed.mode)) {
          retryBody.mode = failed.mode;
        }
        if (failed && typeof failed.supplement === "string" && failed.supplement.trim()) {
          retryBody.supplement = failed.supplement;
        }
        const r = await fetch(
          "/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/brief",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(retryBody),
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
      // Read the report-mode picker (research-note / bento). Persist the
      // choice so the picker defaults to the same option next time.
      const briefModeInput = overlay.querySelector('input[name="brief-mode"]:checked');
      const v = briefModeInput && briefModeInput.value;
      const briefMode = this.isStructuredBriefMode(v) ? v : "research-note";
      this.saveLastBriefMode(briefMode);
      const btn = overlay.querySelector("[data-adjourn-confirm]");
      const origLabel = isGen ? this._t("adj_confirm_generate") : this._t("adj_confirm_file");
      const busyLabel = isGen ? this._t("adj_busy_generate") : this._t("adj_busy_adjourn");
      if (btn) { btn.disabled = true; btn.textContent = busyLabel; }
      try {
        // Voice rooms · auto-switch to transcript view on adjourn so
        // the user lands on the chat scroll where the brief renders
        // and the closing chair message is visible. The round-table
        // stage stays available behind the toggle (eligible includes
        // adjourned), but the default view-on-end is transcript.
        // Skip for `isGen` — that path runs against an already-
        // adjourned room and shouldn't override the user's current
        // view choice.
        if (!isGen && this.currentRoomId && this.currentRoom?.deliveryMode === "voice") {
          try { localStorage.setItem("rt-view-" + this.currentRoomId, "chat"); }
          catch { /* private mode etc · silently ignored */ }
          this.applyRoundTableVisibility(this.currentRoomId);
        }
        if (isGen) {
          await this.generateBriefForAdjournedRoom(briefMode);
        } else if (skipPicked) {
          await this.adjournRoom({ skipBrief: true });
        } else {
          await this.adjournRoom({ mode: briefMode });
        }
        this.closeAdjournOverlay();
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = origLabel; }
        alert((isGen ? this._t("adj_err_generate") : this._t("adj_err_adjourn")) + (e && e.message ? e.message : e));
      }
    },

    /** POST /api/rooms/:id/brief · post-hoc brief for an adjourned room
     *  whose user originally skipped the brief. Server emits the same
     *  brief-started / brief-token / brief-final SSE events as a normal
     *  adjourn, so the existing handlers in connectSSE handle the rest. */
    async generateBriefForAdjournedRoom(mode) {
      if (!this.currentRoomId) return;
      const briefMode = this.isStructuredBriefMode(mode) ? mode : "research-note";
      // Pre-flight · the brief writer is a 3-stage LLM pipeline (per-
      // director extract → composer → final write). All require a key.
      if (!(await this.requireModelKey())) return;
      const r = await fetch(
        "/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/brief",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: briefMode }),
        },
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "brief generation failed");
      }
    },

    async toggleDeliveryMode() {
      if (!this.currentRoomId || !this.currentRoom) return;
      const next = this.currentRoom.deliveryMode === "voice" ? "text" : "voice";
      // Unlock audio if switching to voice
      if (next === "voice") this.unlockAudioPlayback();
      try {
        const r = await fetch(
          "/api/rooms/" + encodeURIComponent(this.currentRoomId),
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deliveryMode: next }),
          },
        );
        if (r.ok) {
          this.currentRoom.deliveryMode = next;
          this.renderHeader();
          // Voice mode just toggled · sync the round-table stage's
          // visibility immediately. Without this, flipping voice OFF
          // on a live room would leave the stage visible.
          this.applyRoundTableVisibility(this.currentRoomId);
        }
      } catch (_) { /* offline */ }
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
      const speakerName = speaker ? speaker.name : this._t("sc_speaker_fallback");
      const speakerLabel = this.escape(speakerName);
      const html = `
        <div id="pause-choice-overlay" class="pc-overlay">
          <div class="pc-modal">
            <div class="pc-classification">
              <span><span class="dot">●</span> ${this.escape(this._t("pause_class"))}</span>
              <span class="right">${this.escape(this._t("pause_right"))}</span>
            </div>
            <div class="pc-head">
              <div class="pc-tag">${this.escape(this._t("pause_tag"))}</div>
              <h2 class="pc-title">${this.escape(this._t("pause_title", { name: speakerName }))}</h2>
              <p class="pc-deck">${this.escape(this._t("pause_deck"))}</p>
            </div>
            <div class="pc-body">
              <button type="button" class="pc-choice danger" data-pause-choice="hard">
                <div class="pc-choice-mark">${this.escape(this._t("pause_hard_mark"))}</div>
                <div class="pc-choice-deck">${this.escape(this._t("pause_hard_deck"))}</div>
              </button>
              <button type="button" class="pc-choice primary" data-pause-choice="soft">
                <div class="pc-choice-mark">${this.escape(this._t("pause_soft_mark"))}</div>
                <div class="pc-choice-deck">${this.escape(this._t("pause_soft_deck", { name: speakerName }))}</div>
              </button>
              <button type="button" class="pc-choice ghost" data-pause-choice="cancel">
                <div class="pc-choice-mark">${this.escape(this._t("pause_cancel_mark"))}</div>
                <div class="pc-choice-deck">${this.escape(this._t("pause_cancel_deck"))}</div>
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
      // Iterate ALL matching cards · the round-end card now lives in
      // up to TWO surfaces simultaneously (chat scroll + voice-mode
      // vote overlay). Single-card querySelector + replaceWith would
      // only refresh whichever happened to be first in the DOM.
      const cards = document.querySelectorAll(`.round-end-card[data-round-end-card="${messageId}"]`);
      if (cards.length === 0) return;
      const html = this.roundEndCardHtml(messageId);
      if (!html) return;
      cards.forEach((card) => {
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        const next = tmp.firstElementChild;
        if (next) card.replaceWith(next.cloneNode(true));
      });
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
      // Sync the round-table HUD's VOTES counter immediately · the
      // HUD reads the count from currentKeyPoints, so the optimistic
      // edit above is enough; no separate state mutation needed.
      this.renderRoundTableHud();
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
        this.renderRoundTableHud();
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
      if (!this.activeRoundPromptId()) return false;
      // Don't start the 10s auto-continue countdown while the chair
      // is still mid-presenting (streaming text or playing voice
      // for the round-prompt). The chair-prompt voice runs ~5-10s;
      // starting the countdown the moment message-appended fires
      // burned through most of the timer behind a hidden popover,
      // so by the time the chair stopped talking and the popover
      // surfaced, only 2-3s remained on the clock — felt like the
      // panel disappeared in seconds. The countdown is restarted
      // from `_fireVoiceDone` once playback ends, giving the user
      // the full 10s window with the popover visible.
      const msgs = this.currentMessages || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m || m.authorKind !== "agent") continue;
        if (m.meta && m.meta.streaming === true) return false;
        if (this.voiceQueues && this.voiceQueues[m.id]) return false;
        break;
      }
      if (this.chairPending === true) return false;
      return true;
    },

    /** Spin up the countdown if conditions are met; otherwise cancel. */
    maybeStartContinueCountdown() {
      if (!this.canAutoContinue()) {
        this.cancelContinueCountdown();
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
      // Two surfaces can carry the active continue button:
      //   · The latest .round-prompt-card in the chat (older cards
      //     are stale artefacts from prior rounds).
      //   · The .rt-vote-pop floating popover on the chair seat in
      //     the round-table view (only mounted while
      //     awaitingContinue === true).
      // Both should paint the same active countdown state so the
      // user sees correct UI no matter which surface they're on.
      const targets = new Set();
      const popBtn = document.querySelector(".rt-vote-pop [data-continue-auto]");
      if (popBtn) targets.add(popBtn);
      const cardBtns = document.querySelectorAll(".round-prompt-card [data-continue-auto]");
      if (cardBtns.length) targets.add(cardBtns[cardBtns.length - 1]);

      const idle = this.canAutoContinue();
      const total = this.AUTO_CONTINUE_SECONDS;
      const left = this.continueCountdown.secondsLeft;
      const counting = this.continueCountdown.interval && idle;
      const pct = Math.max(0, Math.min(100, ((total - left) / total) * 100));

      for (const btn of btns) {
        const isTarget = targets.has(btn);
        const timer = btn.querySelector("[data-continue-timer]");
        if (!isTarget) {
          // Stale (old chat card from a prior round) · clear active
          // styles so it reads as historical, not counting down.
          btn.classList.remove("counting");
          btn.style.setProperty("--qc-progress", "0%");
          if (timer) timer.textContent = "";
          continue;
        }
        btn.disabled = !idle;
        if (counting) {
          if (timer) timer.textContent = `· ${left}s`;
          btn.classList.add("counting");
          btn.style.setProperty("--qc-progress", `${pct}%`);
        } else {
          if (timer) timer.textContent = "";
          btn.classList.remove("counting");
          btn.style.setProperty("--qc-progress", `0%`);
        }
      }
    },

    /** Manually wrap the current round and ask the chair to file the
     *  key-point vote. Triggered from the queue-strip button. */
    async requestRoundEnd(mode) {
      if (!this.currentRoomId) return;
      // Pre-flight · the chair runs a streamed LLM call to generate
      // key points, so a model key is required.
      if (!(await this.requireModelKey())) return;
      // Mode resolution · "now" interrupts the in-flight director and
      // dispatches the chair immediately. "after-speaker" defers the
      // dispatch until the current turn finishes (server returns
      // {deferred:true} and pumpQueue drains the flag between turns).
      // Default "now" preserves the legacy chat round-prompt path.
      const m = mode === "after-speaker" ? "after-speaker" : "now";

      // Optimistic local lock for the now-path · stops a second click
      // from firing while the chair spins up. We DON'T set this for
      // the deferred path because the chair stream may not actually
      // start until the in-flight speaker drains — awaitingContinue
      // should track the real chair dispatch, which arrives via SSE.
      if (m === "now" && this.currentRoom) this.currentRoom.awaitingContinue = true;
      this.refreshRoundEndButton();
      this.refreshContinueButton();
      this.renderQueue();
      let res;
      try {
        res = await fetch(
          "/api/rooms/" + encodeURIComponent(this.currentRoomId) + "/round-end",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: m }),
          },
        );
      } catch (err) {
        if (m === "now" && this.currentRoom) this.currentRoom.awaitingContinue = false;
        this.refreshRoundEndButton();
        alert("Couldn't wrap the round: " + (err && err.message ? err.message : err));
        return;
      }
      if (!res.ok) {
        if (m === "now" && this.currentRoom) this.currentRoom.awaitingContinue = false;
        this.refreshRoundEndButton();
        const e = await res.json().catch(() => ({}));
        alert("Couldn't wrap the round: " + (e.error || res.statusText));
        return;
      }
      // Deferred path · server stashed the request and will fire the
      // chair after the current speaker finalises. Surface a light UI
      // hint (voteQueued) so the bottom-bar button can show a queued
      // state. Cleared on the SSE awaitingContinue=true flip.
      const data = await res.json().catch(() => ({}));
      if (data && data.deferred && this.currentRoom) {
        this.currentRoom.voteQueued = true;
        this.refreshManualVoteButton();
        this.refreshRoundEndButton();
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
      // Paused-room handling · the chair's vote popover stays mounted
      // through pause (the user can park the room mid-vote to think),
      // so its Continue / Switch / Keep buttons must still work. The
      // /continue endpoint requires `status === "live"`, so resume
      // first when the room is paused — without this, the POST 409s
      // and benignRace silently swallows the error, leaving the user
      // clicking a dead button. The shift-accept flow funnels through
      // here too via acceptModeShiftAndContinue, so this single hop
      // covers both buttons.
      if (this.currentRoom && this.currentRoom.status === "paused") {
        try {
          await this.resumeRoom();
        } catch (err) {
          alert("Resume failed: " + (err && err.message ? err.message : err));
          return;
        }
      }
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
        this.currentHistoricalMembers = [];
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
        const pausedLbl = this._t("sidebar_paused");
        const status =
          r.status === "paused"
            ? `<span class="row-status paused">❚❚ ${this.escape(pausedLbl)}</span>`
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
                </div>
                <div class="row-subtitle">${status}${this.escape(r.subject || "")}</div>
              </div>
            </a>
            <button type="button" class="row-delete" data-room-delete title="${this.escape(this._t("sidebar_delete_room"))}">✕</button>
          </div>
        `;
      };

      const html = `
        ${live.length > 0 ? `
          <div class="section-header live">
            <span>${this.escape(this._t("sidebar_section_live"))}</span>
            <span class="line"></span>
            <span class="badge">${live.length}</span>
          </div>
          ${live.map(renderRow).join("")}
        ` : ""}

        ${paused.length > 0 ? `
          <div class="section-header paused">
            <span>${this.escape(this._t("sidebar_section_paused"))}</span>
            <span class="line"></span>
            <span class="badge">${paused.length}</span>
          </div>
          ${paused.map(renderRow).join("")}
        ` : ""}

        <div class="section-header adjourned">
          <span>${this.escape(this._t("sidebar_section_adjourned"))}</span>
          <span class="line"></span>
          <span class="badge" data-adjourned-count>${adj.length}</span>
        </div>
        <div class="adjourned-list" data-adjourned-list>
          ${adj.map(renderRow).join("")}
        </div>
        <div class="adjourned-empty" data-adjourned-empty ${adj.length > 0 ? "hidden" : ""}>
          <div class="adjourned-empty-mark">○</div>
          <div class="adjourned-empty-title">${this.escape(this._t("sidebar_no_adjourned_title"))}</div>
          <div class="adjourned-empty-deck">${this.escape(this._t("sidebar_no_adjourned_deck"))}</div>
        </div>
      `;

      // SSE handlers (room.updated / message.appended / brief.appended)
      // call renderSidebarRooms unconditionally; many of those events
      // don't actually change anything visible in the sidebar. A no-op
      // innerHTML rewrite still tears down + recreates every anchor,
      // which kills any in-flight click whose mousedown/mouseup
      // straddle the wipe — symptom: "I clicked a room and nothing
      // happened, had to refresh." Skip the write when the rendered
      // string is identical to last time.
      if (this._sidebarRoomsHtml !== html) {
        this._sidebarRoomsHtml = html;
        list.innerHTML = html;
      }

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
      // selected; both clear when a room IS selected. When agent-mode
      // is showing the in-flight Full-mode build (personaJob set),
      // the Building row in the sidebar IS the selected entry, not
      // the "+ New agent" trigger — so the trigger clears and the
      // pb-row picks up `.active`.
      const noRoom = roomId === null;
      const isAgentMode = noRoom && this.composerMode === "agent";
      const personaBuilderActive = isAgentMode && !!this.personaJob;
      const agentComposerActive = isAgentMode && !this.personaJob;
      document.querySelectorAll("[data-convene-trigger]").forEach((el) => {
        el.classList.toggle("active", noRoom && !isAgentMode);
      });
      document.querySelectorAll("[data-agent-composer-trigger]").forEach((el) => {
        el.classList.toggle("active", agentComposerActive);
      });
      // Persona Building row · only one ever exists (one job at a
      // time). The shell + the inner anchor both carry `.active` to
      // mirror how session rows + agent-profile rows are marked
      // (CSS targets either selector). When the user enters a room
      // or any non-agent-mode view, the row clears.
      document.querySelectorAll("[data-persona-row]").forEach((el) => {
        el.classList.toggle("active", personaBuilderActive);
      });
      document.querySelectorAll(".pb-row").forEach((el) => {
        el.classList.toggle("active", personaBuilderActive);
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

    /** Toggle the `isPinned` flag for an agent · the sidebar pin
     *  button calls this. Persists to the server (PATCH /api/agents/:id
     *  { isPinned }), updates local state in place, then re-renders
     *  the sidebar so the row moves between the Pinned / Custom /
     *  Core buckets. Optimistic with rollback on failure: we flip the
     *  flag locally + repaint immediately, then revert if the PATCH
     *  fails — no waiting on the round-trip for visible feedback. */
    async togglePinAgent(agentId) {
      if (!agentId) return;
      const idx = (this.agents || []).findIndex((a) => a && a.id === agentId);
      if (idx < 0) return;
      const agent = this.agents[idx];
      const prev = !!agent.isPinned;
      const next = !prev;
      // Optimistic flip · render immediately so the click feels instant.
      agent.isPinned = next;
      this.agentsById[agent.id] = agent;
      this.renderSidebarAgents();
      try {
        const r = await fetch("/api/agents/" + encodeURIComponent(agentId), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ isPinned: next }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        // Server returns the updated row · merge the canonical fields
        // back in so any side-effect updates (updated_at, etc.) land.
        const updated = await r.json();
        if (updated && updated.id) {
          this.agents[idx] = updated;
          this.agentsById[updated.id] = updated;
        }
      } catch (e) {
        // Rollback · keep the UI honest about persistence failure.
        agent.isPinned = prev;
        this.agentsById[agent.id] = agent;
        this.renderSidebarAgents();
        alert((e && e.message ? e.message : "pin failed") + " — try again.");
      }
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
        const pinBtn = `
          <button type="button" class="pin-toggle" title="${this.escape(a.isPinned ? this._t("sidebar_unpin") : this._t("sidebar_pin"))}" data-pin-toggle>${PIN_GLYPH}</button>
        `;
        // Subtitle · model name + (optional) voice character.
        // Replaces the prior "{roleTag} · Active" pattern which carried
        // no information beyond what the section header already
        // conveyed. Model is the practical "what's this agent" tell;
        // voice (when set) tells the user which TTS voice they'll hear
        // in voice rooms.
        const modelLabel = this.modelLabel(a.modelV);
        const voiceLabel = this.voiceLabelFor(a);
        const subParts = [];
        if (modelLabel) {
          subParts.push(`<span class="agent-row-model">${this.escape(modelLabel)}</span>`);
        }
        if (voiceLabel) {
          if (subParts.length > 0) {
            subParts.push(`<span class="agent-row-sep">·</span>`);
          }
          subParts.push(`<span class="agent-row-voice">${this.escape(voiceLabel)}</span>`);
        }
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
                  ${pinBtn}
                </div>
                <div class="agent-row-subtitle">${subParts.join("")}</div>
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
              <span class="agent-row-chair-badge" title="${this.escape(this._t("sidebar_chair_badge_title"))}">${this.escape(this._t("sidebar_chair_badge"))}</span>
            </div>
            <div class="agent-row-subtitle">
              <span class="agent-row-chair-role">${this.escape((a.roleTag && String(a.roleTag).toLowerCase() === "moderator") ? this._t("agent_role_tag_moderator") : (a.roleTag || this._t("sidebar_chair_role_fallback")))}</span>
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
        parts.push(sectionHeader(this._t("sidebar_sec_chair"), 1, "chair"));
        parts.push(renderChairRow(this.currentChair));
      }
      // Building section · placeholder row for the in-flight Full
      // persona build · lets the user navigate away and come back.
      // Shows for running / starting / done states (pre-save); the
      // row click routes to the agent composer where the build UI
      // (or the inline "open confirmation" callout) is rendered.
      // Aborted / failed builds don't surface here — the inline
      // recovery card is the recovery path.
      const job = this.personaJob;
      if (job && (job.status === "running" || job.status === "starting" || job.status === "done")) {
        // Section title kept simple, English-only to match the
        // other section headers (Chair / Pinned / Custom / Core).
        // "Generating" reads as the active verb form ·
        // unambiguously means "this director is being created
        // right now". The earlier i18n key fallback to "Building"
        // tested as confusing.
        const headerLabel = job.status === "done" ? "Ready to save" : "Generating";
        parts.push(`<div class="agents-section-header building"><span>${this.escape(headerLabel)}</span><span class="line"></span><span class="badge">1</span></div>`);
        parts.push(this._renderPersonaBuildingRow(job));
      }
      if (pinned.length) {
        parts.push(sectionHeader(this._t("sidebar_sec_pinned"), pinned.length, "pinned"));
        parts.push(pinned.map((a) => renderRow(a)).join(""));
      }
      if (custom.length) {
        parts.push(sectionHeader(this._t("sidebar_sec_custom"), custom.length));
        parts.push(custom.map((a) => renderRow(a)).join(""));
      }
      if (core.length) {
        parts.push(sectionHeader(this._t("sidebar_sec_core"), core.length));
        parts.push(core.map((a) => renderRow(a)).join(""));
      }
      // Same idempotency guard as renderSidebarRooms · skip the
      // innerHTML wipe when nothing has actually changed, so a
      // background SSE re-render doesn't drop in-flight clicks on
      // agent rows.
      const html = parts.join("");
      if (this._sidebarAgentsHtml !== html) {
        this._sidebarAgentsHtml = html;
        list.innerHTML = html;
      }
    },

    /** Sidebar placeholder row for the in-flight Full persona
     *  build. Surfaces in the "Building" section while the job is
     *  running / done-pre-save so the user can navigate away (into
     *  a room, agent profile, etc.) and come back to the build by
     *  clicking the row. The row's subtitle reflects the current
     *  phase + progress · re-rendered as those update.
     *
     *  Click handler in the document delegate routes
     *  `[data-persona-row-trigger]` to setComposerMode("agent")
     *  which paints the persona builder (build progress UI or
     *  done-state callout) into the chat panel via the standard
     *  renderEmptyState path. */
    _renderPersonaBuildingRow(job) {
      const opLabels = this.PERSONA_PHASE_OP_LABELS || [];
      const isDone = job.status === "done";
      // Title: prefer the user's typed-in description's leading
      // words (so the row reads as "what they're building"),
      // fall back to the server-side guessName.
      const desc = (job.description || "").trim();
      const fromDesc = desc.split(/\s+/).slice(0, 4).join(" ").slice(0, 28);
      const title = fromDesc || (job.finalGuessName || "").trim() || "Director";
      const phaseNum = Math.max(1, Math.min(opLabels.length, job.currentPhase || 1));
      const phaseLabel = opLabels[phaseNum - 1] || "running";
      const pct = Math.round(job.progressPct || 0);
      const subtitle = isDone
        ? "READY · REVIEW AND SAVE"
        : `${this.escape(phaseLabel)} · ${pct}%`;
      const stateClass = isDone ? "ready" : "running";
      // Bake `.active` into the HTML so SSE-driven re-renders preserve
      // the highlight. The row is "selected" when the user is on the
      // agent composer with no room loaded — i.e. the persona builder
      // surface IS the main view. `markActiveRoom` toggles the same
      // class on transitions that don't repaint the sidebar.
      const isActiveView = this.composerMode === "agent" && !this.currentRoomId;
      const activeCls = isActiveView ? " active" : "";
      return `
        <div class="agent-row-shell${activeCls}" data-persona-row>
          <a href="#" class="agent-row pb-row pb-row-${stateClass}${activeCls}" data-persona-row-trigger>
            <div class="agent-row-av pb-row-av">
              <span class="pb-row-pulse" aria-hidden="true"></span>
              <span class="pb-row-glyph" aria-hidden="true">${isDone ? "✓" : "▣"}</span>
            </div>
            <div class="agent-row-content">
              <div class="agent-row-top-line">
                <span class="agent-row-title">${this.escape(title)}</span>
                <span class="pb-row-tag">${isDone ? "READY" : "BUILD"}</span>
              </div>
              <div class="agent-row-subtitle">
                <span>${subtitle}</span>
              </div>
            </div>
          </a>
        </div>
      `;
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
        meta = this._t("sidebar_host");
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

      const r = document.querySelector('[data-sidebar-tab-count="rooms"]');
      if (r) r.textContent = String(roomsCount);
      const a = document.querySelector('[data-sidebar-tab-count="agents"]');
      if (a) a.textContent = String(agentsCount);
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
        // System UI · always English (banner chrome on the follow-up parent link).
        const labelText = "// following up";
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
        // System UI · always English (sidebar / brief-card chrome head).
        const headLabel = `Follow-up rooms · ${kids.length}`;
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

      const t = {
        head: this._t("sa_head"),
        stamp: this._t("sa_stamp"),
        tokens: this._t("sa_tokens"),
        messages: this._t("sa_messages"),
        rounds: this._t("sa_rounds"),
        minutes: this._t("sa_minutes"),
        modelHead: this._t("sa_model_head"),
        valueHead: this._t("sa_value_head"),
        valueEmpty: this._t("sa_value_empty"),
        voted: this._t("sa_voted"),
        seconded: this._t("sa_seconded"),
        probed: this._t("sa_probed"),      };

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
        anthropic: ["opus-4-7", "opus-4-6", "sonnet-4-6", "haiku-4-5"],
        openai:    ["gpt-5-5", "gpt-5-4-mini", "codex-5-4"],
        google:    ["gemini-3-1", "gemini-3-flash", "gemini-3-1-flash"],
        xai:       ["grok-4", "grok-4-3", "grok-4-mini"],
        deepseek:  ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4"],
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
        return `<span class="sa-bar-seg" style="width: ${widthPct}%; background: ${color};" title="${this.escape(this._t("sa_seg_title", { model: modelLabel(row.modelV), tokens: fmtTokens(row.tokens) }))}"></span>`;
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
      // System UI · always English (the surrounding tile content can
      // still localize via `t`, but toggle chrome is fixed-string).
      const moreLabel = (n) => `[ + show ${n} more ]`;
      const lessLabel = "[ collapse ]";
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

      const addInputLabel = this._t("pause_bar_add_input");
      const adjournLabel  = this._t("pause_bar_adjourn");
      const resumeLabel   = this._t("pause_bar_resume");
      const pausedLabel   = this._t("pause_bar_paused");
      const nextLabel     = this._t("pause_bar_next");
      const nextChunk = nextHandle
        ? ` · ${nextLabel} → <span class="lime">${nextHandle}</span>`
        : "";
      bar.innerHTML = `
        <button type="button" class="head-rt-toggle" data-room-rt-toggle aria-pressed="false" hidden></button>
        <div class="paused-bar-text">
          <strong>// ${pausedLabel}</strong>${nextChunk}
        </div>
        <div class="paused-bar-actions">
          <a href="#" class="ghost-btn" data-paused-supplement>${this.escape(addInputLabel)}</a>
          <a href="#" class="ghost-btn" data-adjourn>${this.escape(adjournLabel)}</a>
          <a href="#" class="resume-btn-lg" data-resume>${this.escape(resumeLabel)}</a>
        </div>
      `;
      // The innerHTML write just blew away our static toggle button ·
      // re-paint it so the user keeps the voice/transcript switch
      // available while paused. Idempotent · no-ops in non-voice rooms.
      this.applyRoundTableVisibility(this.currentRoomId);
    },

    /** Composer state · persisted to localStorage so each new-room
     *  session opens with the user's last config. Hydrated lazily on
     *  first renderEmptyState. */
    composerState: null,

    DEFAULT_COMPOSER: {
      directorIds: [],   // populated lazily from the chair's roster
      mode: "constructive",
      intensity: "sharp",
      deliveryMode: "text",
    },

    loadComposerState() {
      if (this.composerState) return this.composerState;
      let saved = null;
      try {
        const raw = localStorage.getItem("boardroom.composer");
        if (raw) saved = JSON.parse(raw);
      } catch { /* ignore */ }
      // seedContext · pre-fetched web snippets the user attached
      // by clicking a topic-rec card on the home composer. Round-
      // tripped through localStorage so a page refresh between
      // pick and convene doesn't lose the attached source
      // material. Shape: { topicRecId?: string, snippets?: [] }.
      const savedSeed = saved && typeof saved.seedContext === "object" && saved.seedContext
        ? saved.seedContext
        : null;
      this.composerState = {
        ...this.DEFAULT_COMPOSER,
        ...(saved || {}),
        subject: (saved && typeof saved.subject === "string") ? saved.subject : "",
        seedContext: savedSeed,
      };
      return this.composerState;
    },

    saveComposerState() {
      if (!this.composerState) return;
      try {
        const { directorIds, mode, intensity, deliveryMode, autoPickDirectors, subject, seedContext } = this.composerState;
        localStorage.setItem(
          "boardroom.composer",
          JSON.stringify({ directorIds, mode, intensity, deliveryMode, autoPickDirectors, subject, seedContext: seedContext || null }),
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
      // One-shot lazy fetch · the composer's "or try a starter"
      // tray renders the latest topic recommendations when any
      // exist (replacing the legacy hardcoded starters). Skipping
      // when already loaded keeps re-renders cheap; the trigger
      // button's SSE path explicitly refreshes after a successful
      // generation so the list lands without polling.
      if (!this.topicRecs.loaded) {
        void this.refreshTopicRecs();
      }

      // Strip stale follow-up fragments inserted by renderFollowUp-
      // Fragments() when a follow-up room was previously open. These
      // live as SIBLINGS of [data-chat-messages] / [data-brief-card]
      // (not inside them), so closeRoom's `chat.innerHTML = ""` doesn't
      // touch them — without this cleanup the "// following up Room #N"
      // banner and "Follow-up rooms · N" tile list bleed into the new-
      // room and new-agent empty states.
      //
      // `.session-analytics` is the same shape · `renderSessionAnalytics`
      // inserts it as a sibling of `[data-brief-card]` when the brief
      // card lacks an `.ending-block-head` divider (typical for
      // transcript-style adjourned rooms). Without including it in
      // this sweep, the previous room's analytics tile (totals /
      // models / upvoted points) bleeds through into the new-room
      // composer.
      document.querySelectorAll(".followup-parent-banner, .followup-children, .session-analytics").forEach((el) => el.remove());

      const chat = document.querySelector("[data-chat-messages]");
      if (chat) {
        if (this.composerMode === "agent") {
          chat.innerHTML = this.renderAgentComposerHtml();
          // Focus the description textarea unless we're showing a preview.
          setTimeout(() => {
            const ta = chat.querySelector("[data-agent-composer-desc]");
            if (ta) {
              // Set the multi-line placeholder via DOM property · the
              // HTML attribute path strips newlines in some parsers,
              // so the second line of the pitch wouldn't render. The
              // DOM `placeholder` property reflects `\n` as a literal
              // line break in the textarea's empty state, which is
              // exactly what we want.
              ta.placeholder = this._t("ag_cmp_placeholder");
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
            if (ta) {
              // Same multi-line placeholder pattern as the agent
              // composer above · DOM property preserves the `\n` the
              // HTML attribute path can drop.
              ta.placeholder = this._composerSubjectPlaceholder();
              ta.focus();
            }
            this.autosizeComposerTextarea();
          }, 30);
        }
      }

      const queue = document.querySelector("[data-queue-list]");
      if (queue) queue.innerHTML = "";
      const brief = document.querySelector("[data-brief-card]");
      if (brief) brief.innerHTML = "";

      const chatScroller = document.querySelector(".chat");
      if (chatScroller) {
        chatScroller.scrollTop = 0;
        // Mark the chat as hosting a composer so the CSS rule
        // `.chat.chat--composer` flips it to a grid with
        // `align-content: center` — vertically centring the
        // composer when it fits the viewport. When .cmp's natural
        // height > .chat height we also add `.chat--composer-overflow`
        // (via updateComposerOverflow) which switches to a layout
        // where the .cmp-fold (hero + input) is min-height: 100% of
        // the chat with content centred inside, and .cmp-starters
        // flow below as scrollable extras. Removed in renderChat()
        // when real chat messages take over.
        chatScroller.classList.add("chat--composer");
        this.updateComposerOverflow();
      }
    },

    /** Toggle `.chat--composer-overflow` on the chat scroller based on
     *  whether the composer's natural height exceeds 70% of the
     *  visible chat area. In overflow mode the hero pins to a fixed
     *  120px top offset (`.cmp` `padding-top: 120px`) and the
     *  starters tray flows below; without overflow, the parent's
     *  `align-content: center` keeps the whole composer block
     *  centred. Called after composer render and on window resize.
     *
     *  The 0.7 threshold (was "strictly > viewport") catches the
     *  in-between case where the input + ~6 topic-rec cards fit
     *  vertically but only just — centred layout would visually
     *  cram the hero against the top edge. Flipping to overflow
     *  mode at 70% gives the hero comfortable breathing room
     *  before any actual scroll is needed. */
    updateComposerOverflow() {
      const chat = document.querySelector(".chat.chat--composer");
      if (!chat) return;
      const cmp = chat.querySelector(".cmp");
      if (!cmp) return;
      requestAnimationFrame(() => {
        chat.classList.remove("chat--composer-overflow");
        const overflows = cmp.scrollHeight > chat.clientHeight * 0.7;
        chat.classList.toggle("chat--composer-overflow", overflows);
      });
      if (!this._composerResizeAttached) {
        this._composerResizeAttached = true;
        window.addEventListener("resize", () => this.updateComposerOverflow());
      }
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
      // The floating sidebar-expand button is gated on `html.no-room`.
      // Without setting it here, a user who collapses the sidebar
      // while on All Reports loses access to the expand control —
      // they have to navigate back to a room view to recover. Same
      // reasoning for openAllNotes / openAgentProfile.
      document.documentElement.classList.add("no-room");
      // If we're inside a room or on the agent profile, leave them.
      if (this.currentRoomId) {
        this.disconnectSSE?.();
        this.currentRoomId = null;
        this.currentRoom = null;
        this.currentMessages = [];
        this.currentMembers = [];
        this.currentHistoricalMembers = [];
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
      const search = document.querySelector('[data-main-view="search"]');
      if (room) room.setAttribute("hidden", "");
      if (agent) agent.setAttribute("hidden", "");
      if (notes) notes.setAttribute("hidden", "");
      if (search) search.setAttribute("hidden", "");
      if (reports) reports.removeAttribute("hidden");
      // Mark the sidebar trigger active. All sibling tab highlights
      // (new-room, new-agent, all-notes) get cleared so only
      // "All Reports" reads as the current focus.
      this.composerMode = "room"; // logical fallback when leaving reports
      document.querySelectorAll("[data-convene-trigger], [data-agent-composer-trigger]").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll(".session-row-shell.active, .agent-row.active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-notes-trigger].active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-search-trigger].active").forEach((el) => el.classList.remove("active"));
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
        const filterLabels = {
          all: this._t("rep_filter_archive_label"),
          today: this._t("rep_filter_today"),
          week: this._t("rep_filter_week"),
          earlier: this._t("rep_filter_earlier"),
        };

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
        const cardKicker = isAll ? this._t("rep_empty_kicker_archive") : this._t("rep_empty_kicker_window");
        const cardTitle = isAll
          ? this._t("rep_empty_title_none")
          : this._t("rep_empty_title_window", { window: filterLabels[activeFilter] });
        const cardDeck = isAll
          ? this._t("rep_empty_deck_all")
          : this._t("rep_empty_deck_window");
        const cardCtaHtml = isAll
          ? `
            <button type="button" class="reports-list-empty-cta" data-convene-trigger>
              <span class="reports-list-empty-cta-arrow">→</span>
              <span>${this.escape(this._t("rep_cta_convene"))}</span>
            </button>`
          : `
            <button type="button" class="reports-list-empty-cta" data-reports-filter="all">
              <span class="reports-list-empty-cta-arrow">←</span>
              <span>${this.escape(this._t("rep_cta_show_all"))}</span>
            </button>`;

        page.innerHTML = `
          <div class="reports-page-head">
            <div>
              <div class="reports-page-kicker">${this.escape(this._t("rep_kicker"))}</div>
              <h1 class="reports-page-title">${this.escape(this._t("rep_title"))}</h1>
            </div>
            <div class="reports-page-meta">${this.escape(this._t("rep_meta", { n: 0 }))}</div>
          </div>

          <div class="reports-filters" role="tablist" aria-label="${this.escape(this._t("rep_aria_filters"))}">
            ${emptyChip("all", this._t("rep_filter_all"))}
            ${emptyChip("today", this._t("rep_filter_today"))}
            ${emptyChip("week", this._t("rep_filter_week"))}
            ${emptyChip("earlier", this._t("rep_filter_earlier"))}
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
        if (ts >= todayStart)      return this._t("rep_group_today");
        if (ts >= yesterdayStart)  return this._t("rep_group_yesterday");
        if (ts >= weekStart)       return this._t("rep_group_week");
        return this._t("rep_group_earlier");
      };
      for (const b of visibleFiltered) {
        const label = groupLabelFor(b.createdAt);
        if (!currentGroup || currentGroup.label !== label) {
          currentGroup = { label, items: [] };
          groups.push(currentGroup);
        }
        currentGroup.items.push(b);
      }

      const filterLabels = {
        all: this._t("rep_filter_archive_label"),
        today: this._t("rep_filter_today"),
        week: this._t("rep_filter_week"),
        earlier: this._t("rep_filter_earlier"),
      };
      const filterCopyTitle = filterLabels[activeFilter] || filterLabels.all;
      const groupsHtml = groups.length === 0        ? `
          <div class="reports-list-empty">
            <!-- Notice text · explains the empty window. -->
            <div class="reports-list-empty-text">
              <div class="reports-list-empty-kicker">${this.escape(this._t("rep_empty_kicker_window"))}</div>
              <h3 class="reports-list-empty-title">${this.escape(this._t("rep_empty_title_window", { window: filterCopyTitle }))}</h3>
              <p class="reports-list-empty-deck">${this.escape(this._t("rep_empty_deck_filter"))}</p>
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
                <span>${this.escape(this._t("rep_cta_show_all"))}</span>
              </button>
            ` : ""}
          </div>
        `
        : `
            <ul class="reports-list">
              ${visibleFiltered.map((b) => this.renderReportItemHtml(b)).join("")}
            </ul>
          `;

      // Bottom sentinel · IntersectionObserver target. Renders only
      // when there's more to load. The "+ N more" hint doubles as a
      // click target if the user prefers explicit paging over scroll.
      const remaining = filtered.length - visibleCount;
      const loadN = Math.min(20, remaining);
      const reportsMetaLine =
        (total === 1 ? this._t("rep_total_one") : this._t("rep_total_n", { n: total })) +
        (distinctRooms > 0
          ? (distinctRooms === 1
            ? this._t("rep_meta_room_one")
            : this._t("rep_meta_room_n", { n: distinctRooms }))
          : "") +
        (hasMore ? this._t("rep_showing", { n: visibleCount }) : "");
      const sentinelHtml = hasMore
        ? `
          <div class="reports-load-sentinel" data-reports-load-sentinel>
            <button type="button" class="reports-load-more" data-reports-load-more>
              <span class="reports-load-more-arrow">▾</span>
              <span class="reports-load-more-text">${this.escape(this._t("rep_load_more", { load: loadN, remaining }))}</span>
            </button>
          </div>
        `
        : "";

      page.innerHTML = `
        <div class="reports-page-head">
          <div>
            <div class="reports-page-kicker">${this.escape(this._t("rep_kicker"))}</div>
            <h1 class="reports-page-title">${this.escape(this._t("rep_title"))}</h1>
          </div>
          <div class="reports-page-meta">${this.escape(reportsMetaLine)}</div>
        </div>

        <div class="reports-filters" role="tablist" aria-label="${this.escape(this._t("rep_aria_filters"))}">
          ${filterChip("all", this._t("rep_filter_all"), total)}
          ${filterChip("today", this._t("rep_filter_today"), todayCount)}
          ${filterChip("week", this._t("rep_filter_week"), weekCount)}
          ${filterChip("earlier", this._t("rep_filter_earlier"), earlierCount)}
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
      // crosses the viewport. The All Reports view uses an inner
      // scroll container (`.main-view[data-main-view="reports"]` has
      // `overflow-y: auto`), so the document viewport itself never
      // scrolls. The observer's `root` MUST point at the inner
      // scroller — otherwise the sentinel never intersects and
      // infinite scroll silently does nothing. `rootMargin: 200px`
      // triggers slightly before the actual edge so the next batch
      // is rendered before the user reaches the bottom.
      try {
        const scrollRoot = document.querySelector('.main-view[data-main-view="reports"]') || null;
        this._reportsLoadObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                bumpVisible();
                break;
              }
            }
          },
          { root: scrollRoot, rootMargin: "200px 0px 200px 0px", threshold: 0.01 },
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

    /** Single reading-list row · room kicker, title, subtitle excerpt,
     *  meta tail. No card chrome — entries are separated by a hairline
     *  inside the list.
     *
     *  Subtitle source by mode:
     *    · Report     → bodyJson.bottomLine.judgement
     *    · Magazine   → bodyJson.kicker
     *    · Newspaper  → bodyJson.kicker
     *  All three fall back to a cleaned-up first content paragraph
     *  from bodyMd if the structured field is missing. */
    renderReportItemHtml(b) {
      const json = b.bodyJson || {};
      const bottomLine = json.bottomLine || {};
      // Pull the right subtitle for this mode. Magazine / newspaper
      // carry their deck/lede text in `kicker`; Report carries it
      // in `bottomLine.judgement`. Either may be missing on legacy
      // / partial briefs — fall back to the first prose paragraph
      // from bodyMd.
      const subtitle = (
        (bottomLine.judgement || "").trim() ||
        (json.kicker || "").trim() ||
        this._extractBriefExcerpt(b.bodyMd) ||
        ""
      );
      const time = this.relTime(b.createdAt) || "";
      const roomLabel = b.roomName || b.roomSubject || "—";
      const roomNumLabel = b.roomNumber != null ? `#${String(b.roomNumber).padStart(3, "0")}` : "";
      const typeLabel = this.briefModeLabel(b);
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
              <span class="reports-item-sep">·</span>
              <span class="reports-item-type" data-mode="${this.escape(((b && b.mode) || "research-note").toLowerCase())}">${this.escape(typeLabel)}</span>
              <span class="reports-item-time">${this.escape(time)}</span>
            </div>
            <h3 class="reports-item-title">${this.escape(b.title || "Untitled brief")}</h3>
            ${subtitle ? `<p class="reports-item-judgement">${this.escape(subtitle)}</p>` : ""}
            ${metaHtml}
          </a>
        </li>
      `;
    },

    /** Pull the first prose paragraph from a brief's bodyMd as a
     *  subtitle fallback. Skips markdown headers, code fences, table
     *  rows, list markers, blockquotes — finds the first content line
     *  that reads as prose. Strips inline markdown (bold/italic/code/
     *  link syntax) so the excerpt reads as plain text. */
    _extractBriefExcerpt(md) {
      if (!md || typeof md !== "string") return "";
      const lines = md.split("\n");
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        if (t.startsWith("#")) continue;       // markdown heading
        if (t.startsWith("```")) continue;     // code fence
        if (t.startsWith("|") || /^[-=]{3,}$/.test(t)) continue; // table / hr
        if (t.startsWith("> ")) continue;      // blockquote
        if (/^[-*+]\s/.test(t)) continue;      // list item
        if (/^\d+\.\s/.test(t)) continue;      // ordered list item
        const cleaned = t
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/\*([^*]+)\*/g, "$1")
          .replace(/`([^`]+)`/g, "$1")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
        if (cleaned.length >= 12) return cleaned.slice(0, 240);
      }
      return md.slice(0, 240).replace(/\s+/g, " ").trim();
    },

    // ── All Notes view · chairman's notes index ───────────────
    /** Open the All Notes page · cross-room saved-excerpt index in
     *  the same main-view-replacement pattern as openAllReports.
     *  Pulls the live list and renders three time-bucket sections
     *  (Today / This Week / Earlier). */
    async openAllNotes() {
      // Set the no-room flag for the same reason openAllReports does
      // — the floating sidebar-expand button is gated on this class.
      document.documentElement.classList.add("no-room");
      // Same view-leaving routine as openAllReports.
      if (this.currentRoomId) {
        this.disconnectSSE?.();
        this.currentRoomId = null;
        this.currentRoom = null;
        this.currentMessages = [];
        this.currentMembers = [];
        this.currentHistoricalMembers = [];
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
      const search = document.querySelector('[data-main-view="search"]');
      if (room) room.setAttribute("hidden", "");
      if (agent) agent.setAttribute("hidden", "");
      if (reports) reports.setAttribute("hidden", "");
      if (search) search.setAttribute("hidden", "");
      if (notes) notes.removeAttribute("hidden");

      this.composerMode = "room";
      document.querySelectorAll("[data-convene-trigger], [data-agent-composer-trigger]").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll(".session-row-shell.active, .agent-row.active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-search-trigger].active").forEach((el) => el.classList.remove("active"));
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

    // ── Search view · cross-room keyword search ────────────────
    /** Open the Search page · same main-view-replacement pattern as
     *  openAllReports / openAllNotes. Mounts a search input + an
     *  empty results panel; user-typed input triggers debounced
     *  /api/search calls (see runSearch). Result rows route back
     *  into rooms with `?q=<term>&m=<msgId>` so the message gets
     *  scrolled into view + flashed on arrival. */
    openSearch() {
      document.documentElement.classList.add("no-room");
      if (this.currentRoomId) {
        this.disconnectSSE?.();
        this.currentRoomId = null;
        this.currentRoom = null;
        this.currentMessages = [];
        this.currentMembers = [];
        this.currentHistoricalMembers = [];
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
      const search = document.querySelector('[data-main-view="search"]');
      if (room) room.setAttribute("hidden", "");
      if (agent) agent.setAttribute("hidden", "");
      if (reports) reports.setAttribute("hidden", "");
      if (notes) notes.setAttribute("hidden", "");
      if (search) search.removeAttribute("hidden");

      this.composerMode = "room";
      document.querySelectorAll("[data-convene-trigger], [data-agent-composer-trigger]").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll(".session-row-shell.active, .agent-row.active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-notes-trigger].active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-search-trigger]").forEach((el) => el.classList.add("active"));

      if (location.hash !== "#/search") {
        try { history.replaceState(null, "", "#/search"); } catch { /* ignore */ }
      }

      const page = document.querySelector("[data-search-page]");
      if (!page) return;
      // Initial paint · Google-style two-state markup. Both the
      // hero (kicker / wordmark / caption) and the head row (input
      // + result-count meta) live in the DOM together so the
      // `.is-initial` ↔ `.has-results` flip is purely a CSS class
      // change — the input element stays put so its value / focus
      // / cursor survive the swap. The doc-level `[data-search-
      // input]` listener (~line 15486) calls `runSearch(value)` on
      // every input event; the clear button (~line 14577) routes
      // back through `runSearch("")`.
      const lastQuery = this._searchLastQuery || "";
      const startsInResults = lastQuery.length > 0;
      page.className = "search-page " + (startsInResults ? "has-results" : "is-initial");
      // Perplexity-style hero · calm conversational tagline above
      // a substantial card-style input with an internal footer
      // toolbar (mono hint left, lime send button right). Starter
      // chips below give one-click into common queries. The same
      // input element serves both states; `.is-initial` styles
      // make the wrapping `.search-card` look like a standalone
      // card, while `.has-results` strips the card chrome and
      // collapses input + meta into a compact head row.
      // 8-bit ambient deco · scattered pixel constellation that
      // gives the page texture without competing with the hero.
      // All coordinates picked by hand to avoid the "regular
      // grid" feel · varied densities + 3 lime accents land
      // the eye softly. CSS masks the bottom edge to a fade so
      // it never crowds the card. Static · no animation,
      // pointer-events: none, aria-hidden.
      const BG_DECO_SVG = `
        <svg viewBox="0 0 800 280" preserveAspectRatio="xMidYMin slice"
             shape-rendering="crispEdges" aria-hidden="true">
          <!-- Faint pixel dots · scattered, mostly 2×2. -->
          <g fill="var(--line-bright, #2A2A26)">
            <rect x="32"  y="38"  width="2" height="2"/>
            <rect x="78"  y="22"  width="2" height="2"/>
            <rect x="118" y="62"  width="2" height="2"/>
            <rect x="156" y="30"  width="2" height="2"/>
            <rect x="206" y="78"  width="2" height="2"/>
            <rect x="254" y="44"  width="2" height="2"/>
            <rect x="298" y="92"  width="2" height="2"/>
            <rect x="342" y="26"  width="2" height="2"/>
            <rect x="388" y="68"  width="2" height="2"/>
            <rect x="436" y="38"  width="2" height="2"/>
            <rect x="486" y="86"  width="2" height="2"/>
            <rect x="528" y="50"  width="2" height="2"/>
            <rect x="572" y="22"  width="2" height="2"/>
            <rect x="618" y="74"  width="2" height="2"/>
            <rect x="664" y="42"  width="2" height="2"/>
            <rect x="708" y="88"  width="2" height="2"/>
            <rect x="752" y="32"  width="2" height="2"/>
            <rect x="60"  y="118" width="2" height="2"/>
            <rect x="146" y="142" width="2" height="2"/>
            <rect x="222" y="116" width="2" height="2"/>
            <rect x="316" y="148" width="2" height="2"/>
            <rect x="402" y="124" width="2" height="2"/>
            <rect x="488" y="158" width="2" height="2"/>
            <rect x="572" y="118" width="2" height="2"/>
            <rect x="654" y="146" width="2" height="2"/>
            <rect x="734" y="124" width="2" height="2"/>
            <rect x="92"  y="180" width="2" height="2"/>
            <rect x="186" y="206" width="2" height="2"/>
            <rect x="278" y="186" width="2" height="2"/>
            <rect x="370" y="216" width="2" height="2"/>
            <rect x="462" y="194" width="2" height="2"/>
            <rect x="554" y="222" width="2" height="2"/>
            <rect x="646" y="198" width="2" height="2"/>
            <rect x="724" y="226" width="2" height="2"/>
          </g>
          <!-- Mid accents · 4×4 squares, lime-dim. -->
          <g fill="var(--lime-dim, #2D5532)">
            <rect x="226" y="46"  width="4" height="4"/>
            <rect x="514" y="100" width="4" height="4"/>
            <rect x="694" y="170" width="4" height="4"/>
          </g>
          <!-- Pixel "plus" accents · evoke the 8-bit
               star/sparkle vocabulary. Lime-dim. -->
          <g fill="var(--lime-dim, #2D5532)">
            <!-- top-left plus -->
            <rect x="98"  y="78"  width="6" height="2"/>
            <rect x="100" y="76"  width="2" height="6"/>
            <!-- mid-right plus -->
            <rect x="640" y="62"  width="6" height="2"/>
            <rect x="642" y="60"  width="2" height="6"/>
            <!-- lower-left plus -->
            <rect x="354" y="178" width="6" height="2"/>
            <rect x="356" y="176" width="2" height="6"/>
          </g>
          <!-- Bright accents · sparse, lime. Catch-the-eye
               points scattered at the visual rule-of-thirds. -->
          <g fill="var(--lime, #6FB572)">
            <rect x="170" y="98"  width="3" height="3"/>
            <rect x="540" y="38"  width="3" height="3"/>
            <rect x="416" y="170" width="3" height="3"/>
          </g>
          <!-- Pixel "frame" segments · short hairline brackets at
               the very top corners · evoke a CRT scanlines feel
               without a full grid. -->
          <g fill="var(--line-bright, #2A2A26)">
            <rect x="14"  y="14"  width="20" height="2"/>
            <rect x="14"  y="14"  width="2"  height="20"/>
            <rect x="766" y="14"  width="20" height="2"/>
            <rect x="784" y="14"  width="2"  height="20"/>
          </g>
        </svg>
      `;
      // Results-only deco · second 8-bit layer that mounts on
      // top of the constellation when .has-results is active.
      // Adds proper "search station" character: pixel antennas
      // anchoring the corners, scattered "+" sparkles between
      // them, denser dot field, and a horizon-tick floor at
      // the bottom of the band. CSS scanlines (declared in
      // index.html) sit underneath via background-image.
      const RESULTS_DECO_SVG = `
        <svg viewBox="0 0 800 130" preserveAspectRatio="xMidYMin slice"
             shape-rendering="crispEdges" aria-hidden="true">
          <!-- Left antenna · vertical mast + 2 crossbars +
               base tile. Reads as a pixel radio tower. -->
          <g fill="var(--line-bright, #2A2A26)">
            <rect x="22"  y="40"  width="2"  height="74"/>
            <rect x="18"  y="56"  width="10" height="2"/>
            <rect x="20"  y="74"  width="6"  height="2"/>
            <rect x="14"  y="114" width="18" height="3"/>
          </g>
          <!-- Left antenna blink tip · static lime accent. -->
          <rect x="22"  y="36"  width="2" height="2" fill="var(--lime, #6FB572)"/>
          <!-- Right antenna · mirror of the left. -->
          <g fill="var(--line-bright, #2A2A26)">
            <rect x="776" y="44"  width="2"  height="70"/>
            <rect x="772" y="60"  width="10" height="2"/>
            <rect x="774" y="78"  width="6"  height="2"/>
            <rect x="768" y="114" width="18" height="3"/>
          </g>
          <rect x="776" y="40"  width="2" height="2" fill="var(--lime, #6FB572)"/>
          <!-- Pixel "+" sparkles · scattered in the central
               band between the antennas. Reads as scanner
               pings. -->
          <g fill="var(--lime-dim, #2D5532)">
            <rect x="138" y="44"  width="6" height="2"/>
            <rect x="140" y="42"  width="2" height="6"/>
            <rect x="324" y="68"  width="6" height="2"/>
            <rect x="326" y="66"  width="2" height="6"/>
            <rect x="498" y="34"  width="6" height="2"/>
            <rect x="500" y="32"  width="2" height="6"/>
            <rect x="612" y="86"  width="6" height="2"/>
            <rect x="614" y="84"  width="2" height="6"/>
            <rect x="220" y="92"  width="6" height="2"/>
            <rect x="222" y="90"  width="2" height="6"/>
            <rect x="700" y="50"  width="6" height="2"/>
            <rect x="702" y="48"  width="2" height="6"/>
          </g>
          <!-- Dense pixel-dot field · layered on top of the
               existing constellation to thicken the header. -->
          <g fill="var(--line-bright, #2A2A26)">
            <rect x="62"  y="28"  width="2" height="2"/>
            <rect x="106" y="78"  width="2" height="2"/>
            <rect x="170" y="34"  width="2" height="2"/>
            <rect x="248" y="56"  width="2" height="2"/>
            <rect x="288" y="22"  width="2" height="2"/>
            <rect x="370" y="50"  width="2" height="2"/>
            <rect x="412" y="92"  width="2" height="2"/>
            <rect x="468" y="68"  width="2" height="2"/>
            <rect x="544" y="84"  width="2" height="2"/>
            <rect x="588" y="44"  width="2" height="2"/>
            <rect x="668" y="76"  width="2" height="2"/>
            <rect x="722" y="32"  width="2" height="2"/>
            <rect x="84"  y="98"  width="2" height="2"/>
            <rect x="262" y="100" width="2" height="2"/>
          </g>
          <!-- Bright lime accent dots · 2 only, at rule-of-
               thirds positions. Catches the eye. -->
          <g fill="var(--lime, #6FB572)">
            <rect x="266" y="40"  width="3" height="3"/>
            <rect x="566" y="74"  width="3" height="3"/>
          </g>
          <!-- Horizon ticks · faint dashed pixel line near
               the bottom edge of the band. Acts as visual
               "floor" the antennas plant on. -->
          <g fill="var(--line, #1A1A18)">
            <rect x="40"  y="122" width="6" height="1"/>
            <rect x="60"  y="122" width="2" height="1"/>
            <rect x="76"  y="122" width="6" height="1"/>
            <rect x="96"  y="122" width="2" height="1"/>
            <rect x="112" y="122" width="6" height="1"/>
            <rect x="132" y="122" width="2" height="1"/>
            <rect x="148" y="122" width="6" height="1"/>
            <rect x="168" y="122" width="2" height="1"/>
            <rect x="184" y="122" width="6" height="1"/>
            <rect x="204" y="122" width="2" height="1"/>
            <rect x="220" y="122" width="6" height="1"/>
            <rect x="240" y="122" width="2" height="1"/>
            <rect x="256" y="122" width="6" height="1"/>
            <rect x="276" y="122" width="2" height="1"/>
            <rect x="292" y="122" width="6" height="1"/>
            <rect x="312" y="122" width="2" height="1"/>
            <rect x="328" y="122" width="6" height="1"/>
            <rect x="348" y="122" width="2" height="1"/>
            <rect x="364" y="122" width="6" height="1"/>
            <rect x="384" y="122" width="2" height="1"/>
            <rect x="400" y="122" width="6" height="1"/>
            <rect x="420" y="122" width="2" height="1"/>
            <rect x="436" y="122" width="6" height="1"/>
            <rect x="456" y="122" width="2" height="1"/>
            <rect x="472" y="122" width="6" height="1"/>
            <rect x="492" y="122" width="2" height="1"/>
            <rect x="508" y="122" width="6" height="1"/>
            <rect x="528" y="122" width="2" height="1"/>
            <rect x="544" y="122" width="6" height="1"/>
            <rect x="564" y="122" width="2" height="1"/>
            <rect x="580" y="122" width="6" height="1"/>
            <rect x="600" y="122" width="2" height="1"/>
            <rect x="616" y="122" width="6" height="1"/>
            <rect x="636" y="122" width="2" height="1"/>
            <rect x="652" y="122" width="6" height="1"/>
            <rect x="672" y="122" width="2" height="1"/>
            <rect x="688" y="122" width="6" height="1"/>
            <rect x="708" y="122" width="2" height="1"/>
            <rect x="724" y="122" width="6" height="1"/>
            <rect x="744" y="122" width="2" height="1"/>
            <rect x="760" y="122" width="6" height="1"/>
          </g>
        </svg>
      `;
      page.innerHTML = `
        <!-- 8-bit ambient deco · top-of-page background overlay
             for the is-initial state. Stays visible (dimmer)
             in has-results as the base atmosphere layer. -->
        <div class="search-bg-deco">${BG_DECO_SVG}</div>
        <!-- Results-only deco · second layer with antennas +
             sparkles + horizon ticks + CSS scanlines (in CSS).
             Hidden in is-initial via opacity. -->
        <div class="search-results-deco">${RESULTS_DECO_SVG}</div>
        <!-- Hero · longer wordmark + mono subline. Only visible
             in .is-initial · faded + collapsed via CSS once
             .has-results lands. -->
        <div class="search-hero">
          <h1 class="search-hero-title">Search every conversation</h1>
          <p class="search-hero-sub">across every room · keyword · message body · room name</p>
        </div>
        <!-- Card · is-initial = standalone framed input with
             internal toolbar; has-results = flex row with the
             meta beside it, toolbar hidden. -->
        <div class="search-card${lastQuery ? "" : " is-empty"}" data-search-card>
          <div class="search-input-wrap">
            <span class="search-input-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
                <circle cx="7" cy="7" r="4.5"/>
                <line x1="10.3" y1="10.3" x2="13.5" y2="13.5"/>
              </svg>
            </span>
            <input type="text" class="search-input" data-search-input
                   placeholder="Find a keyword, decision, or name across rooms"
                   value="${this.escape(lastQuery)}"
                   spellcheck="false"
                   autocomplete="off">
            <button type="button" class="search-input-clear" data-search-clear aria-label="Clear" title="Clear">✕</button>
          </div>
          <!-- Sort filter · only visible in .has-results. Toggle
               between newest-first (default) and oldest-first.
               Click handler in the doc-level delegate updates
               app._searchSort and re-renders from the cached
               result list (no re-fetch). -->
          <div class="search-results-sort" data-search-sort>
            <span class="srs-label">sort</span>
            <button type="button" data-search-sort-by="newest" class="active">Newest</button>
            <button type="button" data-search-sort-by="oldest">Oldest</button>
          </div>
          <span class="search-results-meta" data-search-results-meta></span>
          <div class="search-input-toolbar">
            <span class="search-toolbar-hint">keyword · message body · room name</span>
          </div>
        </div>
        <!-- Static starter chips · one click pre-fills the input
             and triggers the search. Hidden once the user types
             anything (.has-results). System UI English-only. -->
        <div class="search-starters" data-search-starters>
          <span class="search-starters-label">try</span>
          <button type="button" class="search-starter" data-search-starter="decision">decision</button>
          <button type="button" class="search-starter" data-search-starter="next step">next step</button>
          <button type="button" class="search-starter" data-search-starter="risk">risk</button>
          <button type="button" class="search-starter" data-search-starter="ship">ship</button>
        </div>
        <div class="search-results" data-search-results></div>
      `;
      // Initialise the sort default · defaults to "newest"
      // (most recent matches first). The chip group reads from
      // this on every render to set the active state.
      if (this._searchSort !== "oldest") this._searchSort = "newest";
      this._refreshSortChips();
      const inputEl = page.querySelector("[data-search-input]");
      if (inputEl) {
        // Defer focus so the layout settles + view is visible.
        setTimeout(() => inputEl.focus(), 50);
        if (lastQuery) {
          // Re-run last search on re-open so the user sees their
          // prior results without retyping.
          this.runSearch(lastQuery);
        }
      }
    },

    /** Flip the page-level state class. `is-initial` mounts the
     *  vertical-centre hero; `has-results` collapses the hero and
     *  shrinks the input into a head row beside the meta. Called
     *  from runSearch whenever the query crosses the empty
     *  threshold (and on cold mount in renderSearchPage). */
    _setSearchPageState(state) {
      const page = document.querySelector("[data-search-page]");
      if (!page) return;
      page.classList.toggle("is-initial", state === "initial");
      page.classList.toggle("has-results", state !== "initial");
    },

    /** Debounced search · 200ms after last keystroke we hit
     *  /api/search and re-render the results panel. Re-entrancy is
     *  guarded by a sequence number so a slow earlier request
     *  doesn't clobber a faster newer one. */
    runSearch(query) {
      const q = (query || "").trim();
      this._searchLastQuery = q;
      if (this._searchDebounceTimer) {
        clearTimeout(this._searchDebounceTimer);
        this._searchDebounceTimer = null;
      }
      const seq = (this._searchSeq = (this._searchSeq || 0) + 1);
      const target = document.querySelector("[data-search-results]");
      const metaEl = document.querySelector("[data-search-results-meta]");
      // Keep the card's empty-state class in sync with the live
      // query · the CSS class hides the trailing ✕ when the
      // input is genuinely empty so the hero's right edge stays
      // clean before the user has typed anything.
      const card = document.querySelector("[data-search-card]");
      if (card) card.classList.toggle("is-empty", q.length === 0);
      if (!target) return;
      if (q.length === 0) {
        // Empty query · snap back to the hero (initial state),
        // clear the results list + meta. The CSS hides both via
        // `.is-initial`; we still wipe innerHTML so a later
        // .has-results flip doesn't briefly show stale rows.
        this._setSearchPageState("initial");
        target.innerHTML = "";
        if (metaEl) metaEl.textContent = "";
        return;
      }
      // Non-empty query · flip to results state (CSS fades the
      // hero out, shrinks the input into the head row) and show
      // a small "searching…" placeholder while the fetch is in
      // flight. The meta line takes a beat to populate.
      this._setSearchPageState("results");
      target.innerHTML = `<div class="search-empty"><span class="search-empty-kicker">// searching</span><div class="search-empty-msg">…</div></div>`;
      if (metaEl) metaEl.textContent = "";
      this._searchDebounceTimer = setTimeout(async () => {
        try {
          const r = await fetch("/api/search?q=" + encodeURIComponent(q));
          if (!r.ok) throw new Error("HTTP " + r.status);
          const j = await r.json();
          if (seq !== this._searchSeq) return; // stale
          this.renderSearchResults(j.results || [], q);
        } catch (e) {
          if (seq !== this._searchSeq) return;
          target.innerHTML = `<div class="search-empty"><span class="search-empty-kicker">// error</span><div class="search-empty-msg">${this.escape(String(e && e.message ? e.message : e))}</div></div>`;
        }
      }, 200);
    },

    /** Render the search results list · flat ordered list with
     *  Google-style 3-line rows (mono source breadcrumb → sans
     *  link title → sans snippet body). Per-row chrome is defined
     *  in `renderSearchResultRow`. The sort order ("newest" /
     *  "oldest") is read from `app._searchSort` (default
     *  "newest") and re-applied client-side by `_applySearchSort`
     *  whenever the user clicks a sort chip — no re-fetch. */
    renderSearchResults(results, query) {
      const target = document.querySelector("[data-search-results]");
      const metaEl = document.querySelector("[data-search-results-meta]");
      if (!target) return;
      // Cache the raw response so the sort chip click can re-
      // render without hitting the server again. Also store the
      // query so the row builder knows what to highlight.
      this._searchLastResults = Array.isArray(results) ? results.slice() : [];
      this._searchLastQueryRendered = query || "";
      if (!results || results.length === 0) {
        if (metaEl) metaEl.textContent = `0 matches`;
        target.innerHTML = `<div class="search-empty"><span class="search-empty-kicker">// no matches</span><div class="search-empty-msg">No messages match "${this.escape(query)}". Try a shorter or different term.</div></div>`;
        return;
      }
      const sorted = this._applySearchSort(results);
      const roomSet = new Set(sorted.map((r) => r.roomId));
      if (metaEl) {
        metaEl.textContent =
          `${sorted.length} match${sorted.length === 1 ? "" : "es"} · ` +
          `${roomSet.size} room${roomSet.size === 1 ? "" : "s"}`;
      }
      const rows = sorted.map((hit) => this.renderSearchResultRow(hit, query)).join("");
      target.innerHTML = `<ul class="search-results-list">${rows}</ul>`;
    },

    /** Sort a results array by createdAt according to the current
     *  `app._searchSort` setting. Returns a NEW array so the
     *  cached `_searchLastResults` stays in original order. */
    _applySearchSort(results) {
      const order = this._searchSort === "oldest" ? "oldest" : "newest";
      const sorted = (results || []).slice();
      sorted.sort((a, b) => {
        const aT = (a && a.createdAt) || 0;
        const bT = (b && b.createdAt) || 0;
        return order === "oldest" ? aT - bT : bT - aT;
      });
      return sorted;
    },

    /** Sync the active state on the sort chips so the lit button
     *  reflects `app._searchSort`. Called from the chip click
     *  handler + on initial mount. */
    _refreshSortChips() {
      const order = this._searchSort === "oldest" ? "oldest" : "newest";
      document.querySelectorAll("[data-search-sort-by]").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-search-sort-by") === order);
      });
    },

    /** Build one Google-style result row · three stacked text
     *  lines:
     *    1. Source breadcrumb (mono caption, faint) · author name
     *       + time-ago — the "URL row" equivalent.
     *    2. Title (sans link, lime on hover) · the room subject
     *       (truncated). Clicking jumps to `#/r/<id>?m=<mid>&q=
     *       <q>` exactly like the previous flat-list row.
     *    3. Snippet (sans body, soft tone) · 2-line clamp of the
     *       message context with `<mark>` highlight on the
     *       matched keyword.
     *  Snippet window (~110 lead, ~180 trail) is unchanged from
     *  the prior implementation — the change is purely visual. */
    renderSearchResultRow(hit, query) {
      const body = hit.body || "";
      const offset = Math.max(0, hit.matchOffset || 0);
      const ql = (query || "").length;
      const LEAD = 110, TRAIL = 180;
      const start = Math.max(0, offset - LEAD);
      const end = Math.min(body.length, offset + ql + TRAIL);
      const prefix = start > 0 ? "…" : "";
      const suffix = end < body.length ? "…" : "";
      const before = body.slice(start, offset);
      const matched = body.slice(offset, offset + ql);
      const after = body.slice(offset + ql, end);
      const flat = (s) => s.replace(/\s+/g, " ");
      const snippet =
        this.escape(prefix + flat(before)) +
        `<mark>${this.escape(flat(matched))}</mark>` +
        this.escape(flat(after) + suffix);
      const roomTitle = (hit.roomTitle || "Untitled room").trim() || "Untitled room";
      const author = (hit.authorName || "").trim() || "Director";
      const timeAgo = hit.createdAt ? this.relTime(hit.createdAt) : "";
      const qParam = query ? `&q=${encodeURIComponent(query)}` : "";
      // Source breadcrumb · author + relative time. No "from"
      // label · room title is now the prominent title line (where
      // the user navigates to), so the breadcrumb only needs to
      // identify the speaker + when.
      const sourceLine =
        `<span class="sr-source-author">${this.escape(author)}</span>` +
        (timeAgo
          ? `<span class="sr-source-sep">·</span><span class="sr-source-time">${this.escape(timeAgo)}</span>`
          : "");
      return `
        <li>
          <a href="#/r/${this.escape(hit.roomId)}?m=${this.escape(hit.messageId)}${qParam}"
             class="sr-row"
             data-search-jump-room="${this.escape(hit.roomId)}"
             data-search-jump-msg="${this.escape(hit.messageId)}"
             data-search-jump-q="${this.escape(query || "")}">
            <div class="sr-source">${sourceLine}</div>
            <div class="sr-title">${this.escape(roomTitle)}</div>
            <div class="sr-snippet">${snippet}</div>
          </a>
        </li>
      `;
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
        <div class="notes-filters" role="tablist" aria-label="${this.escape(this._t("notes_aria_filters"))}">
          ${filterChip("all", this._t("notes_filter_all"), total)}
          ${filterChip("today", this._t("rep_filter_today"), todayCount)}
          ${filterChip("week", this._t("rep_filter_week"), weekCount)}
          ${filterChip("earlier", this._t("rep_filter_earlier"), earlierCount)}
        </div>
      `;

      // Cold empty state · no saved notes at all. Distinct from
      // "filter window empty" (chip click into a slot with 0 hits)
      // which keeps the chips visible and offers a back-to-All CTA.
      if (total === 0) {
        page.innerHTML = `
          <div class="notes-page-head">
            <div>
              <div class="notes-page-kicker">${this.escape(this._t("notes_kicker"))}</div>
              <h1 class="notes-page-title">${this.escape(this._t("notes_title"))}</h1>
            </div>
            <div class="notes-page-meta">${this.escape(this._t("notes_meta", { n: 0 }))}</div>
          </div>
          ${filtersHtml}
          <div class="notes-list-empty">
            <div class="notes-empty-mark">○</div>
            <div class="notes-empty-title">${this.escape(this._t("notes_empty_title"))}</div>
            <div class="notes-empty-deck">
              ${this._t("notes_empty_deck")}            </div>
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
        if (ts >= todayStart) return this._t("rep_group_today");
        if (ts >= weekStart)  return this._t("rep_group_week");
        return this._t("rep_group_earlier");
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

      const filterLabels = {
        all: this._t("rep_filter_archive_label"),
        today: this._t("rep_filter_today"),
        week: this._t("rep_filter_week"),
        earlier: this._t("rep_filter_earlier"),
      };
      const groupsHtml = groups.length === 0        ? `
          <div class="notes-list-empty">
            <div class="notes-empty-mark">○</div>
            <div class="notes-empty-title">${this.escape(this._t("notes_empty_window", { window: filterLabels[activeFilter] || filterLabels.all }))}</div>
            <div class="notes-empty-deck">${this.escape(this._t("notes_empty_filter_deck"))}</div>
            ${activeFilter !== "all" ? `
              <button type="button" class="notes-empty-cta" data-notes-filter="all">
                <span class="notes-empty-cta-arrow">←</span>
                <span>${this.escape(this._t("notes_cta_show_all"))}</span>
              </button>
            ` : ""}
          </div>
        `
        : `
          <ul class="notes-list">
            ${filtered.map((n) => this.renderNoteItemHtml(n)).join("")}
          </ul>
        `;

      const totalLabel =
        total === 1 ? this._t("notes_one") : this._t("notes_many", { n: total });
      const roomLabel = distinctRooms > 0
        ? (distinctRooms === 1 ? this._t("rooms_one") : this._t("rooms_many", { n: distinctRooms }))
        : "";

      page.innerHTML = `
        <div class="notes-page-head">
          <div>
            <div class="notes-page-kicker">${this.escape(this._t("notes_kicker"))}</div>
            <h1 class="notes-page-title">${this.escape(this._t("notes_title"))}</h1>
          </div>
          <div class="notes-page-meta">${this.escape(totalLabel)}${roomLabel ? this.escape(" · " + roomLabel) : ""}</div>
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
      const author = n.authorName || this._t("notes_director_fallback");
      // The jump link uses the room's hash route + the note id as a
      // fragment-style query so openRoom can scroll to + flash the
      // matching span. The action buttons sit as siblings of the
      // anchor (inside the .notes-item) so their clicks never bubble
      // through the navigation link — same pattern as session-row
      // delete in the rooms sidebar.
      const href = `#/r/${this.escape(n.roomId)}?note=${this.escape(n.id)}`;
      return `
        <li class="notes-item" data-note-id="${this.escape(n.id)}">
          <a class="notes-item-link" href="${href}" data-note-jump="${this.escape(n.id)}" data-note-room="${this.escape(n.roomId)}">
            <div class="notes-item-meta">
              <span class="notes-item-room">${this.escape(this._t("notes_item_room"))} ${this.escape(roomNum)}</span>
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
          <div class="notes-item-actions">
            <button type="button" class="notes-item-action notes-item-share" data-note-share aria-label="Share this note">
              <span class="notes-action-glyph" aria-hidden="true">↗</span>
              <span class="notes-action-label">Share</span>
            </button>
            <button type="button" class="notes-item-action notes-item-unfav" data-note-delete aria-label="Remove this note from your saved list">
              <span class="notes-action-glyph" aria-hidden="true">✕</span>
              <span class="notes-action-label">Unfavorite</span>
            </button>
          </div>
        </li>
      `;
    },

    /** Share-card overlay · mounts a modal with multiple card
     *  templates rendering the selected note as a shareable image.
     *  Templates live in CSS (data-share-template attribute swaps
     *  the visual register without re-rendering markup). PNG export
     *  reuses the html-to-image CDN loader pattern from
     *  `public/magazine.html` · lazy-loaded on first download so
     *  the All Notes page doesn't pay the network cost upfront.
     *
     *  Each template is fixed at 540×675 (4:5 portrait) — a sweet
     *  spot for IG / Weibo / WeChat moments / Twitter portrait. PNG
     *  export uses pixelRatio: 2 so the saved file is 1080×1350. */
    SHARE_CARD_TEMPLATES: ["boardroom", "editorial", "terminal", "magazine"],
    DEFAULT_SHARE_CARD_TEMPLATE: "boardroom",

    /** Open the share-card overlay for a given note id. Resolves the
     *  note from the in-memory cache (`_notesCache`) so no network
     *  round-trip is needed; the cache is populated by the All Notes
     *  fetch and stays fresh through SSE note:created events. */
    openShareCard(noteId) {
      const note = (this._notesCache || []).find((n) => n && n.id === noteId);
      if (!note) {
        alert("Couldn't find that note — try reloading the page.");
        return;
      }
      // Tear down any prior overlay first · prevents stacking when
      // the user click-spams Share across different notes.
      this.closeShareCard();
      this._shareCardNote = note;
      this._shareCardTemplate = this.DEFAULT_SHARE_CARD_TEMPLATE;

      // Share-card overlay reuses the room-settings overlay chrome
      // (`.room-settings-overlay` + `.room-settings-modal` + lime
      // corner brackets + `.rs-classification` strip + `.rs-head`
      // header + `.rs-body` scroll area + `.rs-foot` footer) so the
      // app's overlays share a single visual register. Inner content
      // (template chips + preview + download button) is local to
      // this feature.
      const roomNum = note.roomNumber != null
        ? `#${String(note.roomNumber).padStart(3, "0")}` : "—";
      const author = note.authorName || "Director";
      const overlay = document.createElement("div");
      overlay.className = "room-settings-overlay open";
      overlay.id = "share-card-overlay";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "Share this note");
      overlay.innerHTML = `
        <div class="room-settings-modal" role="document">
          <div class="rs-classification">
            <span><span class="dot">●</span> share · note</span>
            <span class="right">// privateboard.ai</span>
          </div>
          <header class="rs-head">
            <div class="rs-head-text">
              <div class="meta">// from room ${this.escape(roomNum)} · ${this.escape(author)}</div>
              <div class="rs-title-wrap">
                <div class="title rs-title">Share this note as a card</div>
              </div>
            </div>
            <button type="button" class="close-btn" data-share-card-close aria-label="Close">✕</button>
          </header>
          <div class="rs-body">
            <div class="share-card-templates" role="tablist" aria-label="Card template">
              ${this.SHARE_CARD_TEMPLATES.map((t) => `
                <button type="button"
                        class="share-card-template-chip${t === this._shareCardTemplate ? " active" : ""}"
                        data-share-card-template="${t}"
                        role="tab"
                        aria-selected="${t === this._shareCardTemplate ? "true" : "false"}"
                >${this.escape(t)}</button>
              `).join("")}
            </div>
            <div class="share-card-preview" data-share-card-preview>
              <div class="share-card-preview-inner" data-share-card-preview-inner>
                ${this.renderShareCardHtml(note, this._shareCardTemplate)}
              </div>
            </div>
          </div>
          <footer class="rs-foot">
            <span class="share-card-hint">// 1080 × 1350 png</span>
            <button type="button" class="rs-action dirty" data-share-card-download>
              ↓ Download PNG
            </button>
          </footer>
        </div>
      `;
      document.body.appendChild(overlay);

      // Fit the 540×800 preview into whatever container the viewport
      // gives us. CSS caps both width (max-width: 540) AND height
      // (max-height: calc(100vh - 260px)) so on short viewports the
      // preview shrinks proportionally — scaling must read whichever
      // dimension landed smaller so the inner 540×800 native render
      // fits cleanly without any scrollbars on the modal body.
      const fitPreview = () => {
        const preview = overlay.querySelector("[data-share-card-preview]");
        const inner = overlay.querySelector("[data-share-card-preview-inner]");
        if (!preview || !inner) return;
        const rect = preview.getBoundingClientRect();
        const w = rect.width || 540;
        const h = rect.height || 800;
        const scale = Math.min(1, w / 540, h / 800);
        inner.style.setProperty("--share-card-scale", scale.toFixed(4));
      };
      fitPreview();
      this._shareCardResize = fitPreview;
      window.addEventListener("resize", this._shareCardResize);

      // Esc closes · same shortcut family as other overlays.
      this._shareCardEsc = (ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          this.closeShareCard();
        }
      };
      document.addEventListener("keydown", this._shareCardEsc, true);

      // Pre-warm html-to-image so the first Download click doesn't
      // pay the ~50KB CDN fetch latency. Best-effort; if the network
      // is slow the download path awaits its own ensure() anyway.
      this.ensureShareCardHtmlToImage().catch(() => { /* swallow */ });
    },

    closeShareCard() {
      const el = document.getElementById("share-card-overlay");
      if (el) el.remove();
      if (this._shareCardEsc) {
        document.removeEventListener("keydown", this._shareCardEsc, true);
        this._shareCardEsc = null;
      }
      if (this._shareCardResize) {
        window.removeEventListener("resize", this._shareCardResize);
        this._shareCardResize = null;
      }
      this._shareCardNote = null;
      this._shareCardTemplate = null;
    },

    /** Swap the active template · re-renders only the preview's
     *  inner block (keeps the chip row + modal chrome stable). The
     *  data-share-template attribute on `.share-card` is what every
     *  template's CSS keys off, so the visual change is purely a
     *  class swap — markup is identical across templates. */
    setShareCardTemplate(key) {
      if (!this.SHARE_CARD_TEMPLATES.includes(key)) return;
      this._shareCardTemplate = key;
      const overlay = document.getElementById("share-card-overlay");
      if (!overlay) return;
      overlay.querySelectorAll("[data-share-card-template]").forEach((btn) => {
        const active = btn.getAttribute("data-share-card-template") === key;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
      });
      const inner = overlay.querySelector("[data-share-card-preview-inner]");
      if (inner && this._shareCardNote) {
        inner.innerHTML = this.renderShareCardHtml(this._shareCardNote, key);
      }
    },

    /** Length-based font-size step-down for share-card quotes.
     *  Quotes never get truncated — instead the font shrinks so the
     *  full passage fits. Returns the font-size in px for a given
     *  template at the supplied character count. Tiers were tuned
     *  empirically against each template's content area: the
     *  boardroom bubble is the smallest box (≈424 × 200), magazine
     *  and editorial have the most real estate.
     *
     *  Length tiers are deliberately coarse — 5-6 buckets keep the
     *  output predictable and avoid the "text snaps a pixel smaller
     *  every keystroke" feel a continuous formula would produce. */
    shareCardQuoteSize(template, len) {
      const TIERS = {
        boardroom: [
          { max: 40,  size: 24 },
          { max: 70,  size: 21 },
          { max: 100, size: 19 },
          { max: 140, size: 16 },
          { max: 170, size: 14 },
          { max: 200, size: 13 },
        ],
        editorial: [
          { max: 40,  size: 32 },
          { max: 70,  size: 28 },
          { max: 100, size: 25 },
          { max: 140, size: 21 },
          { max: 170, size: 18 },
          { max: 200, size: 16 },
        ],
        terminal: [
          { max: 40,  size: 22 },
          { max: 70,  size: 19 },
          { max: 100, size: 17 },
          { max: 140, size: 15 },
          { max: 170, size: 13 },
          { max: 200, size: 12 },
        ],
        magazine: [
          { max: 40,  size: 34 },
          { max: 70,  size: 30 },
          { max: 100, size: 26 },
          { max: 140, size: 22 },
          { max: 170, size: 19 },
          { max: 200, size: 17 },
        ],
      };
      const fallback = { max: 200, size: 14 };
      const tiers = TIERS[template] || TIERS.boardroom;
      for (const t of tiers) {
        if (len <= t.max) return t.size;
      }
      // > 200 chars · take the smallest tier and shave 2px so the
      // text still has a chance to fit. Caller can also pre-trim
      // to 200 if they want a hard cap.
      return Math.max(10, tiers[tiers.length - 1].size - 2);
    },

    /** Wrap CJK runs in `<span class="cjk">…</span>` so per-script
     *  font + weight rules apply: CJK switches to PingFang at bold
     *  weight (no italic-skew), Latin keeps the surrounding serif
     *  italic. Always called AFTER `escape()` so the regex only
     *  matches CJK glyphs and never sees raw `<` / `>` / `&`. */
    wrapCjk(text) {
      if (!text) return "";
      return String(text).replace(
        /([　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿＀-￯]+)/g,
        '<span class="cjk">$1</span>',
      );
    },

    /** Render the 540×800 card HTML for a given note + template key.
     *  All four templates share the SAME inner data slots — kicker,
     *  quote, byline, watermark, stamp — so this single function
     *  works for all of them; CSS handles the visual divergence. */
    renderShareCardHtml(n, templateKey) {
      const tpl = templateKey || this.DEFAULT_SHARE_CARD_TEMPLATE;
      const quote = String(n.quoteText || "").trim();
      const author = (n.authorName || "Director").trim();
      const roomNum = n.roomNumber != null ? `#${String(n.roomNumber).padStart(3, "0")}` : "";
      const stampDate = n.createdAt
        ? new Date(n.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
        : "";
      const esc = (s) => this.escape(String(s || ""));

      // Template-specific markup · each template needs a slightly
      // different DOM (8-bit scene for "boardroom", quotation
      // glyph for "editorial", ASCII frame for "terminal", top
      // stripe for "magazine"). Watermark on every template is
      // the domain `Privateboard.ai` (lowercased / capitalised
      // by the template's text-transform).
      const DOMAIN = "Privateboard.ai";

      // Quote font-size · scaled by char count so long quotes (up
      // to 200 chars) shrink to fit rather than getting truncated.
      const qLen = quote.length;
      const qFont = this.shareCardQuoteSize(tpl, qLen);
      const qStyle = `font-size: ${qFont}px;`;

      if (tpl === "boardroom") {
        // 8-bit Dribbble-style card · striped sunset sky (painted by
        // CSS) wrapped on every side by an inline-SVG decoration
        // layer (pixel moon, scattered stars, drifting clouds,
        // floating balloons). The meeting table + chairs are
        // intentionally absent — the composition reads as a sunset
        // poster + system message in a chunky pixel-art dialog box.
        // Every rect carries an explicit fill so the html-to-image
        // export keeps colours stable across browsers.
        const star = (x, y, c = "#FFF6D9") => `<rect x="${x}" y="${y}" width="2" height="2" fill="${c}"/>`;
        const tinyStar = (x, y, c = "#FFE8A8") => `<rect x="${x}" y="${y}" width="1" height="1" fill="${c}"/>`;
        // Pixel cloud · 1px-thinner cap row on top + main row +
        // 1-row peach underbelly shadow. Sky-bands only.
        const cloud = (x, y) => `
          <rect x="${x + 4}" y="${y - 2}" width="10" height="2" fill="#FFF6D9"/>
          <rect x="${x}"     y="${y}"     width="18" height="4" fill="#FFF6D9"/>
          <rect x="${x + 2}" y="${y + 4}" width="14" height="2" fill="#F4C078"/>
        `;
        const bigCloud = (x, y) => `
          <rect x="${x + 6}"  y="${y - 4}" width="14" height="2" fill="#FFF6D9"/>
          <rect x="${x + 2}"  y="${y - 2}" width="22" height="2" fill="#FFF6D9"/>
          <rect x="${x}"      y="${y}"     width="26" height="4" fill="#FFF6D9"/>
          <rect x="${x + 2}"  y="${y + 4}" width="22" height="2" fill="#F4C078"/>
        `;
        // Pixel grass tuft · 7-blade upgraded tuft in two greens
        // with deeper roots, taller blades, and a wider ground-line.
        // Roughly 13×8 — about 2× the previous tuft.
        const grass = (x, y) => `
          <rect x="${x + 2}"  y="${y - 4}" width="1" height="4" fill="#2A4F1D"/>
          <rect x="${x}"      y="${y - 1}" width="2" height="3" fill="#3D6E2F"/>
          <rect x="${x + 3}"  y="${y - 5}" width="1" height="5" fill="#2A4F1D"/>
          <rect x="${x + 5}"  y="${y - 3}" width="1" height="3" fill="#3D6E2F"/>
          <rect x="${x + 4}"  y="${y}"     width="2" height="3" fill="#3D6E2F"/>
          <rect x="${x + 7}"  y="${y - 4}" width="1" height="4" fill="#2A4F1D"/>
          <rect x="${x + 8}"  y="${y - 1}" width="2" height="3" fill="#3D6E2F"/>
          <rect x="${x + 10}" y="${y - 3}" width="1" height="3" fill="#2A4F1D"/>
          <rect x="${x + 12}" y="${y - 2}" width="1" height="2" fill="#3D6E2F"/>
          <rect x="${x + 1}"  y="${y + 3}" width="11" height="1" fill="#6BAA48"/>
        `;
        // Wider grass patch · 14-blade tuft for "tall grass clumps"
        // along the river bank. Reads as a thicker, denser growth.
        const grassWide = (x, y) => `
          <rect x="${x + 2}"  y="${y - 5}" width="1" height="5" fill="#2A4F1D"/>
          <rect x="${x}"      y="${y - 1}" width="2" height="3" fill="#3D6E2F"/>
          <rect x="${x + 3}"  y="${y - 6}" width="1" height="6" fill="#2A4F1D"/>
          <rect x="${x + 5}"  y="${y - 4}" width="1" height="4" fill="#3D6E2F"/>
          <rect x="${x + 4}"  y="${y - 1}" width="2" height="3" fill="#3D6E2F"/>
          <rect x="${x + 7}"  y="${y - 5}" width="1" height="5" fill="#2A4F1D"/>
          <rect x="${x + 8}"  y="${y - 2}" width="2" height="4" fill="#3D6E2F"/>
          <rect x="${x + 10}" y="${y - 4}" width="1" height="4" fill="#2A4F1D"/>
          <rect x="${x + 12}" y="${y - 1}" width="2" height="3" fill="#3D6E2F"/>
          <rect x="${x + 14}" y="${y - 3}" width="1" height="3" fill="#2A4F1D"/>
          <rect x="${x + 16}" y="${y - 2}" width="1" height="2" fill="#3D6E2F"/>
          <rect x="${x + 17}" y="${y - 4}" width="1" height="4" fill="#2A4F1D"/>
          <rect x="${x + 1}"  y="${y + 3}" width="17" height="1" fill="#6BAA48"/>
        `;
        // Pixel dirt patch · bare earth showing through the grass.
        // Four-tone (light top / mid body / shadow bottom / specks)
        // gives the patch readable 8-bit texture at small sizes.
        const dirtPatch = (x, y) => `
          <rect x="${x}"      y="${y}"     width="14" height="1" fill="#8A6A48"/>
          <rect x="${x}"      y="${y + 1}" width="16" height="2" fill="#6A4A2C"/>
          <rect x="${x}"      y="${y + 3}" width="14" height="2" fill="#5A3A22"/>
          <rect x="${x + 2}"  y="${y + 5}" width="10" height="1" fill="#4A2E18"/>
          <rect x="${x + 4}"  y="${y + 1}" width="2"  height="1" fill="#A0814F"/>
          <rect x="${x + 9}"  y="${y + 2}" width="2"  height="1" fill="#A0814F"/>
        `;
        const dirtPatchBig = (x, y) => `
          <rect x="${x + 1}"  y="${y}"     width="22" height="1" fill="#8A6A48"/>
          <rect x="${x}"      y="${y + 1}" width="26" height="2" fill="#6A4A2C"/>
          <rect x="${x}"      y="${y + 3}" width="26" height="2" fill="#5A3A22"/>
          <rect x="${x + 2}"  y="${y + 5}" width="22" height="2" fill="#4A2E18"/>
          <rect x="${x + 4}"  y="${y + 7}" width="18" height="1" fill="#3A2410"/>
          <rect x="${x + 5}"  y="${y + 1}" width="3"  height="1" fill="#A0814F"/>
          <rect x="${x + 14}" y="${y + 2}" width="2"  height="1" fill="#A0814F"/>
          <rect x="${x + 20}" y="${y + 4}" width="2"  height="1" fill="#A0814F"/>
          <rect x="${x + 8}"  y="${y + 4}" width="1"  height="1" fill="#8A6A48"/>
        `;
        // Top-down pixel stones · much bigger than before, with
        // a round-blob silhouette (stepped rows that wrap around
        // a domed body), brighter centre (sun catching the top
        // of the rounded stone), darker rim along the bottom
        // edge, and a soft ground drop-shadow that reads as
        // "looking straight down at a chunky rock". Three sizes.
        const stoneSmall = (x, y) => `
          <!-- Shadow beneath -->
          <rect x="${x + 2}" y="${y + 14}" width="16" height="2" fill="#1B0A35" opacity="0.28"/>
          <!-- Mid-tone body (round-blob silhouette) -->
          <rect x="${x + 4}" y="${y}"      width="12" height="2" fill="#7A6F62"/>
          <rect x="${x + 2}" y="${y + 2}"  width="16" height="2" fill="#7A6F62"/>
          <rect x="${x}"     y="${y + 4}"  width="20" height="6" fill="#7A6F62"/>
          <rect x="${x + 2}" y="${y + 10}" width="16" height="2" fill="#7A6F62"/>
          <rect x="${x + 4}" y="${y + 12}" width="12" height="2" fill="#7A6F62"/>
          <!-- Lighter top-center (sun catches dome) -->
          <rect x="${x + 6}"  y="${y + 2}" width="8"  height="2" fill="#9F9388"/>
          <rect x="${x + 4}"  y="${y + 4}" width="12" height="4" fill="#9F9388"/>
          <rect x="${x + 6}"  y="${y + 8}" width="8"  height="2" fill="#9F9388"/>
          <!-- Brightest specular spot -->
          <rect x="${x + 7}"  y="${y + 4}" width="4" height="2" fill="#B5A998"/>
          <!-- Bottom rim shadow -->
          <rect x="${x + 4}"  y="${y + 12}" width="12" height="1" fill="#4A4038"/>
        `;
        const stoneMed = (x, y) => `
          <!-- Shadow beneath -->
          <rect x="${x + 4}" y="${y + 20}" width="24" height="2" fill="#1B0A35" opacity="0.30"/>
          <rect x="${x + 6}" y="${y + 22}" width="20" height="1" fill="#1B0A35" opacity="0.18"/>
          <!-- Mid-tone body -->
          <rect x="${x + 6}"  y="${y}"      width="20" height="2" fill="#7A6F62"/>
          <rect x="${x + 3}"  y="${y + 2}"  width="26" height="2" fill="#7A6F62"/>
          <rect x="${x + 1}"  y="${y + 4}"  width="30" height="2" fill="#7A6F62"/>
          <rect x="${x}"      y="${y + 6}"  width="32" height="8" fill="#7A6F62"/>
          <rect x="${x + 1}"  y="${y + 14}" width="30" height="2" fill="#7A6F62"/>
          <rect x="${x + 3}"  y="${y + 16}" width="26" height="2" fill="#7A6F62"/>
          <rect x="${x + 6}"  y="${y + 18}" width="20" height="2" fill="#7A6F62"/>
          <!-- Lighter top-centre dome -->
          <rect x="${x + 9}"  y="${y + 2}"  width="14" height="2" fill="#9F9388"/>
          <rect x="${x + 6}"  y="${y + 4}"  width="20" height="2" fill="#9F9388"/>
          <rect x="${x + 4}"  y="${y + 6}"  width="24" height="4" fill="#9F9388"/>
          <rect x="${x + 6}"  y="${y + 10}" width="20" height="2" fill="#9F9388"/>
          <!-- Brightest specular spot (sun) -->
          <rect x="${x + 11}" y="${y + 5}"  width="10" height="3" fill="#B5A998"/>
          <!-- Bottom rim shadow -->
          <rect x="${x + 4}"  y="${y + 16}" width="24" height="1" fill="#5A5048"/>
          <rect x="${x + 7}"  y="${y + 18}" width="18" height="1" fill="#4A4038"/>
        `;
        const stoneLarge = (x, y) => `
          <!-- Shadow beneath (wider for the bigger stone) -->
          <rect x="${x + 6}" y="${y + 28}" width="36" height="2" fill="#1B0A35" opacity="0.32"/>
          <rect x="${x + 8}" y="${y + 30}" width="32" height="1" fill="#1B0A35" opacity="0.20"/>
          <!-- Mid-tone body (round-blob silhouette, ~46×30) -->
          <rect x="${x + 10}" y="${y}"      width="26" height="2" fill="#7A6F62"/>
          <rect x="${x + 6}"  y="${y + 2}"  width="34" height="2" fill="#7A6F62"/>
          <rect x="${x + 3}"  y="${y + 4}"  width="40" height="2" fill="#7A6F62"/>
          <rect x="${x + 1}"  y="${y + 6}"  width="44" height="2" fill="#7A6F62"/>
          <rect x="${x}"      y="${y + 8}"  width="46" height="10" fill="#7A6F62"/>
          <rect x="${x + 1}"  y="${y + 18}" width="44" height="2" fill="#7A6F62"/>
          <rect x="${x + 3}"  y="${y + 20}" width="40" height="2" fill="#7A6F62"/>
          <rect x="${x + 6}"  y="${y + 22}" width="34" height="2" fill="#7A6F62"/>
          <rect x="${x + 10}" y="${y + 24}" width="26" height="2" fill="#7A6F62"/>
          <!-- Lighter top-centre dome (sun catches the round top) -->
          <rect x="${x + 14}" y="${y + 2}"  width="18" height="2" fill="#9F9388"/>
          <rect x="${x + 10}" y="${y + 4}"  width="26" height="2" fill="#9F9388"/>
          <rect x="${x + 6}"  y="${y + 6}"  width="34" height="2" fill="#9F9388"/>
          <rect x="${x + 4}"  y="${y + 8}"  width="38" height="6" fill="#9F9388"/>
          <rect x="${x + 6}"  y="${y + 14}" width="34" height="2" fill="#9F9388"/>
          <!-- Brightest specular spot -->
          <rect x="${x + 16}" y="${y + 6}"  width="14" height="4" fill="#B5A998"/>
          <rect x="${x + 18}" y="${y + 10}" width="10" height="2" fill="#C7BDB0"/>
          <!-- Bottom rim shadow (gives the stone weight) -->
          <rect x="${x + 6}"  y="${y + 20}" width="34" height="1" fill="#5A5048"/>
          <rect x="${x + 10}" y="${y + 22}" width="26" height="1" fill="#4A4038"/>
          <rect x="${x + 14}" y="${y + 24}" width="18" height="1" fill="#3A302A"/>
        `;
        // Top-down meandering river · a wide cyan ribbon that
        // S-curves across the bottom band. Coordinates tuned for
        // the 540×750 card (cream ground starts ≈ y=428): river
        // body spans roughly y=660-715. Width varies 30-44px at
        // different points to mimic a real meandering stream.
        const meanderingRiver = `
          <!-- Body · solid cyan. The whole scene group (river +
               stones + grass + dirt) was bumped 100px up from
               the previous layout so the watermark / stamp at
               the bottom have a generous cream footer above them. -->
          <path d="M -10 583
                   C 80 571, 180 603, 260 583
                   C 340 563, 420 595, 550 575
                   L 550 619
                   C 420 631, 340 607, 260 627
                   C 180 647, 80 621, -10 629 Z"
                fill="#5BC0EB" shape-rendering="geometricPrecision"/>
          <!-- Top edge highlight (lighter ripple) -->
          <path d="M -10 585
                   C 80 573, 180 605, 260 585
                   C 340 565, 420 597, 550 577"
                stroke="#9ADEFA" stroke-width="2" fill="none"
                shape-rendering="geometricPrecision"/>
          <!-- Bottom edge shadow (darker rim) -->
          <path d="M -10 627
                   C 80 619, 180 645, 260 625
                   C 340 605, 420 629, 550 617"
                stroke="#2A6FA5" stroke-width="2" fill="none"
                shape-rendering="geometricPrecision"/>
          <!-- Sparkle pixels on the water surface -->
          <rect x="44"  y="595" width="3" height="1" fill="#FFFFFF"/>
          <rect x="116" y="605" width="2" height="1" fill="#FFFFFF"/>
          <rect x="184" y="599" width="3" height="1" fill="#FFFFFF"/>
          <rect x="244" y="607" width="2" height="1" fill="#FFFFFF"/>
          <rect x="312" y="591" width="3" height="1" fill="#FFFFFF"/>
          <rect x="368" y="593" width="2" height="1" fill="#FFFFFF"/>
          <rect x="436" y="587" width="3" height="1" fill="#FFFFFF"/>
          <rect x="496" y="595" width="2" height="1" fill="#FFFFFF"/>
          <rect x="72"  y="615" width="2" height="1" fill="#FFFFFF"/>
          <rect x="160" y="619" width="3" height="1" fill="#FFFFFF"/>
          <rect x="284" y="615" width="2" height="1" fill="#FFFFFF"/>
          <rect x="396" y="611" width="3" height="1" fill="#FFFFFF"/>
        `;
        // Sky decoration layer · fills the full 540×800 card so
        // pixel atmosphere wraps the bubble on every side. Sky
        // half holds the moon + stars + clouds; ground (cream)
        // half holds pixel stones + grass + dirt + a meandering
        // river.
        const skyDeco = `
          <!-- Pixel moon · 8-bit circle in upper-right, ~y=78 so
               it clears the top-right "Privateboard.ai" header
               text (which lives at y=22-34). 5 stepped rows of
               pixel pairs form the round silhouette; three
               crater highlights in a warmer cream add character. -->
          <g transform="translate(440 78)">
            <rect x="8"  y="0"  width="20" height="4" fill="#FFF6D9"/>
            <rect x="4"  y="4"  width="28" height="4" fill="#FFF6D9"/>
            <rect x="0"  y="8"  width="36" height="14" fill="#FFF6D9"/>
            <rect x="4"  y="22" width="28" height="4" fill="#FFF6D9"/>
            <rect x="8"  y="26" width="20" height="4" fill="#FFF6D9"/>
            <rect x="14" y="10" width="3" height="3" fill="#F4D898"/>
            <rect x="22" y="14" width="2" height="2" fill="#F4D898"/>
            <rect x="10" y="18" width="2" height="2" fill="#F4D898"/>
          </g>
          <!-- Star field · denser in deep purple bands, thinning
               as the sky warms. Mix of 2×2 cream pixels and 1×1
               amber pixels for depth. Stars near the top-right
               text bounds (y≈22-34, x≈400-512) were moved down
               so they don't print on the "Privateboard.ai" label. -->
          ${star(40, 50)}${star(112, 58)}${star(180, 38)}${star(252, 30)}${star(304, 10)}${star(212, 64)}
          ${star(72, 90)}${star(160, 84)}${star(220, 110)}${star(316, 64)}${star(376, 116)}${star(36, 98)}
          ${star(140, 116)}${star(264, 102)}${star(420, 132)}${star(196, 138)}${star(348, 142)}
          ${tinyStar(60, 40)}${tinyStar(168, 22)}${tinyStar(232, 50)}${tinyStar(340, 50)}${tinyStar(414, 116)}
          ${tinyStar(96, 76)}${tinyStar(204, 104)}${tinyStar(280, 130)}${tinyStar(388, 124)}
          ${tinyStar(56, 156)}${tinyStar(132, 168)}${tinyStar(420, 178)}
          <!-- Clouds · sky bands only (rose / coral around y≈170).
               The two clouds that previously sat at y=232 / y=244
               were dropped — after the scene group was shifted up,
               the bubble's top edge (y=200) covered them entirely. -->
          ${bigCloud(48, 168)}
          ${cloud(372, 158)}
          ${cloud(212, 178)}
          <!-- Ground · meandering top-down river curving across
               the warm cream band, plus chunky stones on both
               banks, denser grass tufts (mix of regular + wide),
               and scattered dirt patches breaking up the grass.
               The whole scene group was shifted 100px UP from
               the previous layout so the watermark + stamp at
               the bottom of the card have a clean cream "footer"
               above them. -->
          ${meanderingRiver}
          <!-- Stones · spread across both banks. -->
          ${stoneLarge(20,  535)}
          ${stoneMed(232, 568)}
          ${stoneSmall(376, 572)}
          ${stoneMed(444, 633)}
          ${stoneSmall(96,  639)}
          ${stoneSmall(312, 639)}
          <!-- Grass on the upper bank, woven between the stones. -->
          ${grass(76,  562)}
          ${grass(140, 566)}
          ${grass(296, 570)}
          ${grass(420, 572)}
          ${grass(496, 566)}
          ${grass(180, 578)}
          <!-- Grass on the lower bank just below the river. -->
          ${grass(40,  649)}
          ${grass(180, 651)}
          ${grass(220, 651)}
          ${grass(360, 653)}
          ${grass(500, 651)}
          <!-- Bigger grass clumps + dirt patches in the strip
               just below the lower-bank stones. -->
          ${dirtPatchBig(58,  658)}
          ${dirtPatch(190, 662)}
          ${dirtPatch(330, 660)}
          ${dirtPatchBig(402, 658)}
          ${grassWide(140, 666)}
          ${grassWide(290, 666)}
          ${grassWide(430, 666)}
          <!-- Extra dirt patches scattered on the upper bank. -->
          ${dirtPatch(180, 584)}
          ${dirtPatch(326, 578)}
        `;
        return `
          <div class="share-card" data-share-template="boardroom">
            <div class="sc-header">
              <span>◆ PRIVATEBOARD<span class="sc-heart">♥</span></span>
              <span class="sc-header-right">${esc(DOMAIN)}</span>
            </div>
            <svg class="sc-sky-deco" viewBox="0 0 540 800" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              ${skyDeco}
            </svg>
            <div class="sc-bubble">
              <span class="sc-nail tl" aria-hidden="true"></span>
              <span class="sc-nail tr" aria-hidden="true"></span>
              <span class="sc-nail bl" aria-hidden="true"></span>
              <span class="sc-nail br" aria-hidden="true"></span>
              ${n.roomSubject ? `<div class="sc-bubble-meta">// re: ${this.wrapCjk(esc(String(n.roomSubject).trim()))}</div>` : ""}
              <p class="sc-bubble-text" style="${qStyle}">${this.wrapCjk(esc(quote))}</p>
            </div>
            <div class="sc-byline">${this.wrapCjk(esc(`被蒸馏的 ${author}`))}</div>
            <div class="share-card-watermark">${esc(DOMAIN)}</div>
            <div class="share-card-stamp">${esc(stampDate)}</div>
          </div>
        `;
      }
      if (tpl === "editorial") {
        return `
          <div class="share-card" data-share-template="editorial">
            <div>
              <div class="sc-quotemark">&ldquo;</div>
              <p class="sc-quote" style="${qStyle}">${this.wrapCjk(esc(quote))}</p>
            </div>
            <div class="sc-byline">— <strong>${this.wrapCjk(esc(author))}</strong>${roomNum ? ` · room ${esc(roomNum)}` : ""}</div>
            <div class="share-card-watermark">${esc(DOMAIN)}</div>
            <div class="share-card-stamp">${esc(stampDate)}</div>
          </div>
        `;
      }
      if (tpl === "terminal") {
        return `
          <div class="share-card" data-share-template="terminal">
            <div class="sc-frame">
              <div class="sc-prompt">$ cat note.txt</div>
              <p class="sc-quote" style="${qStyle}">${this.wrapCjk(esc(quote))}</p>
              <div class="sc-byline">> attributed to: <strong>${this.wrapCjk(esc(author))}</strong>${roomNum ? ` <span class="sc-byline-dim">[room ${esc(roomNum)}]</span>` : ""}</div>
            </div>
            <div class="share-card-watermark">${esc(DOMAIN)}</div>
            <div class="share-card-stamp">${esc(stampDate)}</div>
          </div>
        `;
      }
      // magazine (default fallthrough)
      return `
        <div class="share-card" data-share-template="magazine">
          <div class="sc-stripe"></div>
          <div class="sc-kicker">From the boardroom</div>
          <p class="sc-quote" style="${qStyle}">${this.wrapCjk(esc(quote))}</p>
          <div class="sc-byline">
            <span><strong>${this.wrapCjk(esc(author))}</strong></span>
            <span>${roomNum ? `room ${esc(roomNum)}` : ""}${stampDate ? (roomNum ? " · " : "") + esc(stampDate) : ""}</span>
          </div>
          <div class="share-card-watermark">${esc(DOMAIN)}</div>
        </div>
      `;
    },

    /** Lazy-load html-to-image from CDN. Same loader pattern as
     *  `public/magazine.html`'s `ensureHtmlToImage` so the All Notes
     *  page doesn't ship the lib unless the user actually exports. */
    _h2iLoaded: null,
    async ensureShareCardHtmlToImage() {
      if (window.htmlToImage) return;
      if (!this._h2iLoaded) {
        this._h2iLoaded = new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/dist/html-to-image.min.js";
          s.onload = res;
          s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      await this._h2iLoaded;
    },

    /** Capture the current preview at native 540×675 and save it as
     *  a 1080×1350 PNG. The visible preview is scaled down for fit;
     *  we capture the un-scaled inner card so the export resolution
     *  is independent of viewport width. Errors surface as a soft
     *  alert + console.warn — same pattern as magazine/ppt exports. */
    async downloadShareCard() {
      if (!this._shareCardNote) return;
      const btn = document.querySelector("[data-share-card-download]");
      const overlay = document.getElementById("share-card-overlay");
      if (!overlay) return;
      try {
        if (btn) { btn.disabled = true; btn.textContent = "rendering…"; }
        await this.ensureShareCardHtmlToImage();
        if (document.fonts && document.fonts.ready) {
          try { await document.fonts.ready; } catch { /* best-effort */ }
        }
        // Find the live card element (the inner-most .share-card div
        // inside the preview, NOT the scaling wrapper). Capturing the
        // 540×750 card directly at pixelRatio: 2 gives a 1080×1500
        // PNG that ignores the cosmetic scale applied to the preview.
        const card = overlay.querySelector(".share-card");
        if (!card) throw new Error("share card not mounted");
        const dataUrl = await window.htmlToImage.toPng(card, {
          pixelRatio: 2,
          cacheBust: true,
          width: 540,
          height: 800,
          canvasWidth: 540,
          canvasHeight: 800,
          style: { transform: "none", margin: "0", width: "540px", height: "800px" },
        });
        const slug = (this._shareCardNote.authorName || "note")
          .toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "note";
        const a = document.createElement("a");
        a.download = `privateboard-${slug}-${(this._shareCardNote.id || "").slice(0, 6)}.png`;
        a.href = dataUrl;
        a.click();
      } catch (e) {
        console.warn("[share-card] PNG export failed:", e);
        alert("PNG export failed — check the browser console for details.");
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = `<span aria-hidden="true">↓</span><span>Download PNG</span>`;
        }
      }
    },

    /** DELETE /api/notes/:id · drops a saved excerpt from the index.
     *  Confirmation is light because the action is reversible only by
     *  re-saving the same passage; we keep the prompt as a single
     *  click-confirm rather than a full overlay. */
    async deleteNoteAt(id) {
      if (!id) return;
      if (!confirm("Remove this note from your saved list? You can re-save it any time by highlighting the same passage in the room.")) return;
      try {
        const r = await fetch("/api/notes/" + encodeURIComponent(id), { method: "DELETE" });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          alert("Delete failed: " + (j.error || r.statusText));
          return;
        }
      } catch (e) {
        alert("Delete failed: " + (e && e.message ? e.message : e));
        return;
      }
      // Patch local cache so the immediate re-render reflects the
      // delete without a refetch round-trip. The sidebar count badge
      // re-fetches via the /count endpoint.
      if (Array.isArray(this._notesCache)) {
        this._notesCache = this._notesCache.filter((n) => n && n.id !== id);
        this.renderNotesPage(this._notesCache);
      }
      this.refreshNotesCount();
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
      // Search-jump consumer · same race as note-jump (the message
      // article may not be painted yet when handleRoute fires).
      // Stays armed until the article exists, so whichever paint
      // pass lands later catches it.
      if (this._pendingMessageScroll) {
        const ok = this.scrollToMessage(this._pendingMessageScroll);
        if (ok) {
          this._pendingMessageScroll = null;
          this._pendingMessageQuery = null;
        }
      }
      // Re-apply the search flash · an SSE-driven re-render might
      // have just rebuilt the message article + wiped the outline
      // class and the keyword wrap. We re-apply on every paint
      // pass until the flash window closes (`_searchFlashState`
      // self-clears once Date.now() crosses `until`).
      if (this._searchFlashState) {
        this._applySearchFlashState();
      }
    },

    /** Scroll-to-message · used by the Search view to land on the
     *  exact match after the user clicks a result. Wraps the first
     *  occurrence of the search keyword inside the message body in
     *  a `.search-keyword-flash` span (~3s lime entry-pulse + steady
     *  highlight, then unwrap
     *  to keep the DOM clean). Without this, the user lands on the
     *  message but the keyword visually disappears into the prose.
     *  Returns true when the article was found + scrolled · the
     *  caller uses this to know whether to keep the pending flag
     *  armed. */
    scrollToMessage(messageId) {
      if (!messageId) return false;
      const article = document.querySelector(`article[data-message-id="${messageId}"]`);
      if (!article) return false;
      try {
        article.scrollIntoView({ behavior: "auto", block: "center" });
      } catch { /* */ }
      const query = (this._pendingMessageQuery || "").trim();
      // Arm a flash window · `_searchFlashState` carries the
      // messageId + query + an absolute deadline. Every subsequent
      // renderChat (via applyAllNoteHighlights) re-applies the
      // outline class + keyword wrap until the deadline elapses.
      // Without this, an SSE-driven re-render that fires DURING
      // the 3s animation wipes the article + span and the user
      // sees a fragmentary flash. Note-highlight uses the same
      // re-apply-on-render pattern.
      this._searchFlashState = {
        messageId,
        query,
        until: Date.now() + 3200,
      };
      this._applySearchFlashState({ initial: true });
      // Reveal the chat now that the scroll has landed.
      document.body.classList.remove("note-jump-loading");
      if (this._noteJumpRevealTimer) {
        clearTimeout(this._noteJumpRevealTimer);
        this._noteJumpRevealTimer = null;
      }
      this.chatStuckToBottom = false;
      this._suppressBottomScrollUntil = Date.now() + 2000;
      return true;
    },

    /** Re-apply (or first-apply) the search-result flash to the
     *  message in `_searchFlashState`. Idempotent · finds the
     *  current article + bubble (which may have been re-mounted
     *  by an SSE-driven renderChat since the prior pass), restarts
     *  the outline animation via class-remove/reflow/class-add, and
     *  wraps the keyword if no live wrap is present.
     *
     *  Called from:
     *    · `scrollToMessage` (initial trigger) — `opts.initial`
     *    · `applyAllNoteHighlights` (after every renderChat) —
     *      throws away stale state once the deadline passes. */
    _applySearchFlashState(opts) {
      const state = this._searchFlashState;
      if (!state) return;
      if (Date.now() >= state.until) {
        this._searchFlashState = null;
        return;
      }
      const article = document.querySelector(`article[data-message-id="${state.messageId}"]`);
      if (!article) return;
      // Restart the CSS animation reliably · removing then re-adding
      // the class without a reflow is a no-op (same animation,
      // already applied). `void article.offsetWidth` forces layout
      // to flush so the next add fires a fresh run.
      if (article.classList.contains("search-hit-flash")) {
        article.classList.remove("search-hit-flash");
        void article.offsetWidth;
      }
      article.classList.add("search-hit-flash");
      // Keyword wrap · only re-wrap if the prior wrap is gone (the
      // unwrap timeout ran, OR the bubble got rebuilt by SSE). The
      // wrap auto-unwraps after 3.2s so we don't pile up spans.
      const query = (state.query || "").trim();
      if (query.length > 0 && !article.querySelector(".search-keyword-flash")) {
        const bubble =
          article.querySelector(".cd-body") ||
          article.querySelector(".ci-body") ||
          article.querySelector(".msg-bubble");
        if (bubble) this._flashKeywordIn(bubble, query);
      }
      // On the initial application, schedule one final cleanup at
      // the deadline so a quiet chat (no SSE re-renders to drive
      // applyAllNoteHighlights) still drops the class.
      if (opts && opts.initial) {
        if (this._searchFlashTimer) clearTimeout(this._searchFlashTimer);
        const remaining = Math.max(0, state.until - Date.now());
        this._searchFlashTimer = setTimeout(() => {
          this._searchFlashTimer = null;
          this._searchFlashState = null;
          const a = document.querySelector(`article[data-message-id="${state.messageId}"]`);
          if (a) a.classList.remove("search-hit-flash");
        }, remaining + 80);
      }
    },

    /** Wrap the first case-insensitive occurrence of `query` inside
     *  `bubble` (a message-body container) with a `.search-keyword-
     *  flash` span. The span carries a 3s lime entry-pulse animation
     *  via CSS, after which we unwrap the span so the DOM matches
     *  the source content again. Walks text nodes only · won't
     *  reach inside `<code>` / `<pre>` / `<a>` (which is fine ·
     *  matches inside those are rare and the article-level outline
     *  glow still cues the right card). */
    _flashKeywordIn(bubble, query) {
      const ql = query.length;
      const qLow = query.toLowerCase();
      const walker = document.createTreeWalker(
        bubble,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            // Skip text inside elements we don't want to mutate.
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            const tag = p.tagName;
            if (tag === "CODE" || tag === "PRE" || tag === "SCRIPT" || tag === "STYLE") {
              return NodeFilter.FILTER_REJECT;
            }
            return node.nodeValue && node.nodeValue.length >= ql
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          },
        },
      );
      let textNode;
      while ((textNode = walker.nextNode())) {
        const text = textNode.nodeValue;
        const idx = text.toLowerCase().indexOf(qLow);
        if (idx < 0) continue;
        // Split the text node so we can wrap just the matched
        // slice without disturbing surrounding markup.
        const before = text.slice(0, idx);
        const match = text.slice(idx, idx + ql);
        const after = text.slice(idx + ql);
        const span = document.createElement("span");
        span.className = "search-keyword-flash";
        span.textContent = match;
        const frag = document.createDocumentFragment();
        if (before) frag.appendChild(document.createTextNode(before));
        frag.appendChild(span);
        if (after) frag.appendChild(document.createTextNode(after));
        textNode.parentNode.replaceChild(frag, textNode);
        // Auto-unwrap after the full animation lifetime so the DOM
        // doesn't keep an inert highlight span lying around (would
        // break note-highlight char offsets if the user later
        // saves a note). 3.2s = animation duration (3s) + a
        // small grace so the unwrap doesn't race the final paint.
        setTimeout(() => {
          if (!span.parentNode) return;
          const parent = span.parentNode;
          while (span.firstChild) parent.insertBefore(span.firstChild, span);
          parent.removeChild(span);
          parent.normalize();
        }, 3200);
        return;
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
        span.setAttribute("aria-label", this._t("note_saved"));
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
        <span class="note-tip-label">${this.escape(this._t("note_saved"))}</span>
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
      const searchView  = document.querySelector('[data-main-view="search"]');
      const roomView    = document.querySelector('[data-main-view="room"]');
      if (reportsView) reportsView.setAttribute("hidden", "");
      if (notesView)   notesView.setAttribute("hidden", "");
      if (searchView)  searchView.setAttribute("hidden", "");
      if (roomView)    roomView.removeAttribute("hidden");
      // Drop the All-Reports / All-Notes / Search trigger highlights
      // regardless of which composer we're switching to.
      document.querySelectorAll("[data-reports-trigger].active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-notes-trigger].active").forEach((el) => el.classList.remove("active"));
      document.querySelectorAll("[data-search-trigger].active").forEach((el) => el.classList.remove("active"));
      // If the URL still carries an All-Reports / All-Notes / Search
      // hash from a prior navigation, drop it — otherwise refresh
      // would bounce the user back to that view (handleRoute matches
      // the hash on boot and beats the sidebar-restore path that
      // would otherwise honour ROOMS_KEY="new").
      if (/^#\/(reports|notes|search)$/i.test(location.hash || "")) {
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
        // Chat panel can be left `hidden=true` by a prior voice
        // room exit that didn't go through closeRoom (e.g., user
        // jumped from the voice room into Reports, then clicked
        // the persona Building row to come back here). Reset both
        // chat + stage so the composer paints into a visible
        // container instead of a blank one. Same defense as the
        // closeRoom path.
        const chatPanel = document.querySelector(".chat-col > .chat");
        if (chatPanel) chatPanel.hidden = false;
        const rtStage = document.querySelector("[data-roundtable-stage]");
        if (rtStage) rtStage.hidden = true;
        this.renderEmptyState();
        this.markActiveRoom(null);
      }
    },

    /** Pitch copy for the new-room composer's textarea placeholder.
     *  Centralised so renderComposerHtml AND the post-render DOM
     *  `.placeholder` set in renderEmptyState share one source. The
     *  DOM property path is the load-bearing one — setting it via
     *  the HTML attribute strips the `\n` in some parsers, so a
     *  multi-line pitch never renders the second line. The earlier
     *  trailing "Drop in what's on your mind in a sentence or two."
     *  was retired at the user's request — it was a CTA-style nudge
     *  redundant with the heading question above the textarea. */
    _composerSubjectPlaceholder() {
      return "Convening a room can stress-test a thesis, force a decision you've been avoiding, or surface the angle nobody on your real team brings.";
    },

    /** Build the composer HTML. Centred hero composition · Claude /
     *  ChatGPT-style new-chat landing, but tuned to our boardroom
     *  language. The single input block IS the focal point — cast +
     *  tune live as a slim toolbar inside its bottom edge so the page
     *  has one clear gravitational centre, not three competing form
     *  fields. */
    /** 8-bit ambient backdrop · same vocabulary as the Search page's
     *  `.search-bg-deco` (crispEdges pixel motifs, lime accents) but
     *  scene-tuned for each composer:
     *    · room  → mini boardroom (pixel table + 4 chair silhouettes)
     *    · agent → row of pixel character heads w/ speech bubbles
     *  Constellation dots + corner brackets are shared. Returns plain
     *  SVG markup ready to drop into `.cmp-bg-deco`. */
    composerBgDecoSvg(scene) {
      // Helper · stagger animation-delays so siblings don't pulse in
      // lockstep. Returns a string like `style="animation-delay: 1.2s"`.
      // The pseudo-random offset is index-based so it's deterministic
      // (no flicker between renders).
      const _delay = (i, base) => `style="animation-delay: ${(((i * 137) % 100) / 100 * base).toFixed(2)}s"`;
      // Constellation dots + lime accents + corner brackets · shared
      // ambient "8-bit sky" the user singled out as the visual goal.
      // Each dot animates with `deco-twinkle` keyframes for a slow
      // opacity blink, staggered by index so the field shimmers
      // organically instead of pulsing as a single beat.
      const scatterDots = [
        [32, 38], [78, 22], [118, 62], [156, 30], [206, 78], [254, 44],
        [298, 92], [342, 26], [388, 68], [436, 38], [486, 86], [528, 50],
        [572, 22], [618, 74], [664, 42], [708, 88], [752, 32], [60, 200],
        [186, 216], [278, 196], [554, 222], [646, 198], [734, 226],
      ];
      const limeAccents = [
        // Dropped the centre-lower lime dot (416, 170) — it sat
        // directly behind the H1 prompt and read as a typo.
        [170, 98], [540, 38],
      ];
      const scatter = `
        <g fill="var(--line-bright, #2A2A26)">
          ${scatterDots.map(([x, y], i) =>
            `<rect class="deco-twinkle" ${_delay(i, 4.5)} x="${x}" y="${y}" width="2" height="2"/>`
          ).join("")}
        </g>
        <g fill="var(--lime, #6FB572)">
          ${limeAccents.map(([x, y], i) =>
            `<rect class="deco-shine" ${_delay(i + 7, 2.8)} x="${x}" y="${y}" width="3" height="3"/>`
          ).join("")}
        </g>
        <g fill="var(--line-bright, #2A2A26)">
          <rect x="14"  y="14"  width="20" height="2"/>
          <rect x="14"  y="14"  width="2"  height="20"/>
          <rect x="766" y="14"  width="20" height="2"/>
          <rect x="784" y="14"  width="2"  height="20"/>
        </g>
      `;
      // Scene-specific MINI motifs · small scattered 8-bit glyphs that
      // theme the constellation without occupying the centre stage.
      // Replaces the previous big centred tableau (table + chairs /
      // row of character heads) — the user wanted ambient dots /
      // sparkles tinted with each composer's flavour, not a literal
      // scene in the hero band. Each motif is ≤ 14×14 px so the band
      // still reads as scatter, not a feature illustration.
      let motif = "";
      if (scene === "room") {
        // Room scene · tiny pixel chairs + mics + plus-sparkles + a
        // few pixel "speech-mark" pairs (boardroom vocabulary). All
        // in the warm wood / cyan moderator palette so the scatter
        // tints toward "meeting" without ever forming a tableau.
        // Each group carries an animation class · `deco-bob` for
        // chairs, `deco-spark` for "+" glyphs, `deco-twinkle` for
        // quote dots. Inline animation-delays stagger across siblings
        // so the field never pulses in lockstep.
        // Center-lower zone (roughly x ∈ [280, 520], y > 140) is
        // where the H1 "What's on your mind today?" prompt lands.
        // Cleared of motif elements so the chairs / mics / sparks /
        // quote dots never collide with the title text · the deco
        // stays visible only at the periphery + along the top band.
        // Same hygiene pass as the agent composer's motif.
        const chairs = [
          { x: 108, y: 138, fill: "#7A5230" },
          { x: 372, y: 46,  fill: "#7A5230" },
          { x: 678, y: 148, fill: "#7A5230" },
        ];
        const sparks = [
          [98, 78], [640, 62], [588, 156],
        ];
        const quotes = [
          [148, 110], [152, 110], [716, 98], [720, 98],
        ];
        motif = `
          <g shape-rendering="crispEdges">
            <!-- Mini chair silhouettes (3 wood + 1 cyan moderator) -->
            ${chairs.map((c, i) => `
              <g class="deco-bob" ${_delay(i + 3, 3.2)} fill="${c.fill}">
                <rect x="${c.x}" y="${c.y + 10}" width="6" height="2"/>
                <rect x="${c.x}" y="${c.y}"      width="2" height="10"/>
                <rect x="${c.x + 6}" y="${c.y}"  width="2" height="10"/>
              </g>
            `).join("")}
            <!-- Tiny microphones · static (small, would feel busy).
                 Removed the (296, 206) centre-lower mic and the
                 (244, 216) cyan moderator chair — both sat in the
                 title's footprint and read as typos behind the
                 prompt. -->
            <g fill="#8E8B83">
              <rect x="226" y="46"  width="3" height="2"/>
              <rect x="227" y="42"  width="1" height="4"/>
              <rect x="514" y="100" width="3" height="2"/>
              <rect x="515" y="96"  width="1" height="4"/>
            </g>
            <!-- Wood-tone "+" sparkles · scale-pulse animation -->
            ${sparks.map(([x, y], i) => `
              <g class="deco-spark" ${_delay(i + 11, 2.4)} fill="var(--amber-dim, #5C3A1F)">
                <rect x="${x}"     y="${y + 2}" width="6" height="2"/>
                <rect x="${x + 2}" y="${y}"     width="2" height="6"/>
              </g>
            `).join("")}
            <!-- Pixel "quote marks" · 2-dot pairs, twinkle in sync -->
            ${quotes.map(([x, y], i) =>
              `<rect class="deco-twinkle" ${_delay(i + 17, 3.5)} x="${x}" y="${y}" width="2" height="2" fill="var(--lime-dim, #2D5532)"/>`
            ).join("")}
          </g>
        `;
      } else if (scene === "agent") {
        // Agent scene · tiny pixel character heads (4×4) + mini
        // speech bubbles (5×3) + lime sparkles · evokes "cast / new
        // persona" without ever forming a centre tableau. Heads are
        // small enough to read as constellation, not as portraits.
        // Heads bob, bubbles blink in / out, sparkles pulse.
        // Center-lower zone (roughly x ∈ [280, 520], y > 140) is
        // where the H1 "What do you want to build?" prompt lands.
        // Cleared of motif elements so the heads / bubbles / sparks
        // never collide with the title text · the deco stays
        // visible only at the periphery + along the top band.
        const heads = [
          [124, 48], [498, 64], [676, 178], [218, 200],
        ];
        const bubbles = [
          [170, 68], [362, 92], [552, 46], [612, 206],
        ];
        const ideaSparks = [
          [68, 118], [724, 138], [84, 186],
        ];
        motif = `
          <g shape-rendering="crispEdges">
            <!-- Mini character heads · 4×4 face + 1px hat band -->
            ${heads.map(([x, y], i) => `
              <g class="deco-bob" ${_delay(i + 21, 3.0)}>
                <rect x="${x}" y="${y}" width="4" height="4" fill="#D8A878"/>
                <rect x="${x}" y="${y}" width="4" height="1" fill="#5C3A1F"/>
              </g>
            `).join("")}
            <!-- Tiny speech bubbles · 10×6 pill with 1-pixel tail · blink -->
            ${bubbles.map(([x, y], i) => `
              <g class="deco-blink" ${_delay(i + 27, 4.0)}>
                <rect x="${x}"     y="${y}"     width="10" height="6" fill="var(--panel-3, #1A1A18)"/>
                <rect x="${x}"     y="${y}"     width="10" height="1" fill="var(--lime-dim, #2D5532)"/>
                <rect x="${x}"     y="${y + 5}" width="10" height="1" fill="var(--lime-dim, #2D5532)"/>
                <rect x="${x}"     y="${y}"     width="1"  height="6" fill="var(--lime-dim, #2D5532)"/>
                <rect x="${x + 9}" y="${y}"     width="1"  height="6" fill="var(--lime-dim, #2D5532)"/>
                <rect x="${x + 2}" y="${y + 6}" width="2"  height="1" fill="var(--lime-dim, #2D5532)"/>
              </g>
            `).join("")}
            <!-- Idea sparkles · "+" glyphs in lime-dim · scale pulse -->
            ${ideaSparks.map(([x, y], i) => `
              <g class="deco-spark" ${_delay(i + 33, 2.6)} fill="var(--lime-dim, #2D5532)">
                <rect x="${x}"     y="${y + 2}" width="6" height="2"/>
                <rect x="${x + 2}" y="${y}"     width="2" height="6"/>
              </g>
            `).join("")}
          </g>
        `;
      }
      return `
        <svg viewBox="0 0 800 280" preserveAspectRatio="xMidYMin slice"
             shape-rendering="crispEdges" aria-hidden="true">
          ${scatter}
          ${motif}
        </svg>
      `;
    },

    renderComposerHtml(state) {
      const userName = (this.prefs?.name || "you").trim() || "you";
      const lang = this.composerLanguage();
      const greeting = this.composerGreeting(lang, userName);
      // System UI · always English. Composer chrome (prompt /
      // placeholder / button labels) doesn't follow the brief
      // language. The brief content + chair/director output still
      // honours the user's input language; only the app shell is
      // fixed-string.
      const t = {
        greet: greeting,
        prompt: "What's on your mind today?",
        placeholder: this._composerSubjectPlaceholder(),
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
        // System UI · always English (auto-pick chip tooltip).
        const autoTip = "Chair picks 3 directors based on your subject when you Convene · click to pick manually";
        castInner = `
          <span class="cmp-cast-stack cmp-cast-stack-auto" data-cast-auto title="${this.escape(autoTip)}">
            <span class="cmp-cast-auto-mark">✦</span>
          </span>
          <span class="cmp-cast-count cmp-cast-auto-label" title="${this.escape(autoTip)}">
            <span class="cmp-cast-auto-key">directors</span>
            <span class="cmp-cast-auto-val">auto-pick</span>
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
          : `<span class="cmp-cast-count cmp-cast-empty">no directors</span>`;
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
      const toneLbl = this._t("cmp_tone_label");
      const intensityLbl = this._t("cmp_intensity_label");
      // Starter grid · 2-col responsive cards. Two parallel
      // pools render in the same `.cmp-starters-grid`:
      //   1. Topic recommendations (newest-first, paged, visible
      //      list, capped at the 6 the server keeps). Each card
      //      carries a synthesiser-generated tag (e.g.
      //      "strategy") in the left column. Clicking populates
      //      the composer with the rec's subject + attaches its
      //      seedContext snippets so the room opens grounded in
      //      the source material.
      //   2. Legacy hardcoded starters from window.BOARDROOM_STARTERS.
      //      Show only when there are no recommendations yet (or
      //      when recs are still loading on first paint) so a
      //      brand-new user sees something useful in the tray.
      // Server keeps at most 6 rows — defensive slice covers
      // any stale cache that pre-dates the "always 6" rule.
      const recs = (this.topicRecs.items || []).slice(0, 6);
      // Card markup lives in `topicRecCardHtml` so the
      // initial render path and any later append paths can't
      // drift in shape / attributes.
      const recCards = recs.map((rec) => this.topicRecCardHtml(rec)).join("");

      const showLegacyStarters = recs.length === 0;
      const starters = showLegacyStarters && Array.isArray(window.BOARDROOM_STARTERS)
        ? window.BOARDROOM_STARTERS
        : [];
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
      // Trigger card · disguised as the first row in the
      // starters grid, so the "recommend" action lives in the
      // same visual rhythm as the suggestions it produces. The
      // card has TWO states wired through the same DOM hooks
      // ([data-trec-label] / [data-trec-detail] / [data-trec-pct]
      // / [data-trec-bar]) so the SSE handler can patch them
      // in place without re-rendering the whole composer:
      //   · IDLE (no job) · tag = "✦ discover", text = the
      //     bilingual label, arrow = "+". Looks like a starter
      //     but with a lime accent + dashed bottom rule.
      //   · BUSY (job live) · tag = phase label, text =
      //     animated dots + phase detail, arrow = "N%". A
      //     thin lime progress bar lives along the bottom edge
      //     and fills as the pipeline ticks.
      const job = this.topicRecs.job;
      const triggerBusy = !!job;
      const triggerCard = `
        <button type="button"
          class="cmp-starter cmp-recs-trigger-card${triggerBusy ? " is-busy" : ""}"
          data-cmp-recs-trigger
          data-topic-rec-progress
          ${triggerBusy ? "disabled" : ""}
          title="${this.escape("找你可能感兴趣的话题")}">
          <div class="cmp-starter-tag" data-trec-label>${this.escape(triggerBusy ? (job.label || "starting…") : "✦ discover")}</div>
          <div class="cmp-starter-text">
            ${triggerBusy
              ? `<span class="cmp-recs-trigger-dots" aria-hidden="true"><i></i><i></i><i></i></span><span data-trec-detail>${this.escape(job.detail || "")}</span>`
              : `<span>找你可能感兴趣的话题</span>`}
          </div>
          <div class="cmp-starter-arrow" data-trec-pct>${this.escape(triggerBusy ? (job.pct ? `${job.pct}%` : "·") : "+")}</div>
          <div class="cmp-recs-trigger-bar" aria-hidden="true"><div class="cmp-recs-trigger-fill" data-trec-bar style="width: ${triggerBusy ? (job.pct || 0) : 0}%"></div></div>
        </button>
      `;

      // Trigger card always leads; suggestions (or legacy
      // starters as empty-state fallback) follow.
      const trayCards = triggerCard + (recs.length > 0 ? recCards : starterCards);
      // Pagination is intentionally OFF — the server keeps only
      // the latest batch (6 rows). Every fresh generation wipes
      // the previous batch, so there's never "older" data to
      // page back to. The "+ N more" surface is gone.

      return `
        <section class="cmp">
          <div class="cmp-bg-deco" aria-hidden="true">${this.composerBgDecoSvg("room")}</div>
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
                ${(() => {
                  // Reuse the same toggle vocabulary as the new-agent
                  // composer's web-search toggle: `.ap-skill-row-toggle`
                  // (track + knob + text) plus `.cmp-ws-toggle` for
                  // toolbar fitting. `needs-key` modifier renders the
                  // dashed "configure first" treatment when no voice
                  // provider is set, matching the WS toggle pattern
                  // exactly. Class set: `on` / `off` / `needs-key`.
                  const voiceConfigured = this.hasAnyVoiceKey();
                  const voiceOn = voiceConfigured && state.deliveryMode === "voice";
                  const voiceLabel = this._t("cmp_voice_label");
                  const voiceTitle = !voiceConfigured
                    ? "Configure a voice provider to enable voice mode"
                    : (voiceOn
                      ? "Voice mode on · directors speak aloud during the room"
                      : "Voice mode off · click to enable");
                  const voiceCls = [
                    "ap-skill-row-toggle",
                    "cmp-ws-toggle",
                    voiceOn ? "on" : "off",
                    voiceConfigured ? "" : "needs-key",
                  ].filter(Boolean).join(" ");
                  return `
                    <button type="button" class="${voiceCls}"
                      data-composer-voice-toggle
                      data-configured="${voiceConfigured ? "1" : "0"}"
                      data-on="${voiceOn ? "1" : "0"}"
                      aria-pressed="${voiceOn ? "true" : "false"}"
                      title="${this.escape(voiceTitle)}">
                      <span class="ap-skill-row-toggle-track"><span class="ap-skill-row-toggle-knob"></span></span>
                      <span class="ap-skill-row-toggle-text">${this.escape(voiceLabel)}</span>
                    </button>
                  `;
                })()}
              </div>

              <button type="button" class="cmp-go" data-composer-go title="${this.escape(t.convene)} (⏎)">
                <svg class="cmp-go-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M5 12h14"/>
                  <path d="m13 5 7 7-7 7"/>
                </svg>
              </button>
            </div>
          </div>

          <div class="cmp-starters">
            <div class="cmp-starters-rule">
              <span class="cmp-starters-rule-line"></span>
              <span class="cmp-starters-rule-label">${this.escape(t.starterCaption)}</span>
              <span class="cmp-starters-rule-line"></span>
            </div>
            <div class="cmp-starters-grid">${trayCards}</div>
          </div>
        </section>
      `;
    },

    /** Time-of-day greeting like "// good evening, Kay" / "// 晚上好，Kay". */
    composerGreeting(lang, name) {
      // Follows composer chrome locale (`lang` · en or zh via I18n).
      const h = new Date().getHours();
      const isZh = lang === "zh";
      let key;
      if (isZh) {
        if (h < 5) key = "greet_zh_0";
        else if (h < 12) key = "greet_zh_1";
        else if (h < 14) key = "greet_zh_2";
        else if (h < 18) key = "greet_zh_3";
        else if (h < 23) key = "greet_zh_4";
        else key = "greet_zh_5";
      } else if (h < 5) key = "greet_en_0";
      else if (h < 12) key = "greet_en_1";
      else if (h < 18) key = "greet_en_2";
      else key = "greet_en_3";
      return this._t(key, { name });    },

    composerLanguage() {
      try {
        if (window.I18n && typeof window.I18n.getLocale === "function") {
          return window.I18n.getLocale() === "zh" ? "zh" : "en";
        }
      } catch { /* ignore */ }
      try {
        const lang = (navigator.language || "").toLowerCase();
        if (lang.startsWith("zh") || lang.includes("cn") || lang.includes("hans") || lang.includes("hant")) {
          return "zh";
        }
      } catch { /* ignore */ }
      return "en";
    },

    /** UI copy from i18n.js · falls back to key if I18n not loaded. */
    _t(key, vars) {
      return (window.I18n && window.I18n.t(key, vars)) || key;
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

    /** True when a Web Search backend key is configured · gates the
     *  websearch toggle's "on" state (Brave Search and/or Tavily). Reads
     *  through window.boardroomKeys · refetched after /api/keys mutations. */
    agentComposerWebSearchConfigured() {
      try {
        if (typeof window.boardroomKeys !== "function") return false;
        const k = window.boardroomKeys();
        return !!(k && (k.brave || k.tavily));
      } catch { return false; }
    },

    /** Read the user's last websearch toggle preference. Defaults TRUE
     *  when the key is configured (the user opted into the feature by
     *  configuring the key, no reason to default OFF) and FALSE when
     *  not configured (no point pretending it's on). */
    loadAgentComposerWebSearch() {
      const configured = this.agentComposerWebSearchConfigured();
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

    /** Public lookup for the human-friendly label of a model id.
     *  Mirrors `MODEL_LABELS[modelV] || modelV`, exposed so callers
     *  outside this IIFE (e.g. new-agent.js's overlay) don't have to
     *  reach into module-scoped state. */
    modelLabel(modelV) {
      if (!modelV) return "";
      return MODEL_LABELS[modelV] || modelV;
    },

    /** Friendly label for an agent's voice profile. Returns "" when
     *  the agent has no voice set, so callers can omit a voice chip
     *  entirely. Looks up the prefetched `voiceLabels` map (populated
     *  by loadInitial) and falls back to the raw voiceId when the
     *  prefetch missed (e.g. /api/voices failed, or the agent uses
     *  a fresh cloned voice that wasn't in the snapshot). */
    voiceLabelFor(agent) {
      const v = agent && agent.voice;
      if (!v || !v.provider || !v.voiceId) return "";
      const key = `${v.provider}:${v.voiceId}`;
      const cached = this.voiceLabels && this.voiceLabels[key];
      return cached || v.voiceId;
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
      // Update every dropdown trigger label in place. There can be
      // more than one mounted at once (the AI composer's toolbar
      // chip + the manual new-agent overlay's foot chip), and they
      // share the same model state, so all instances should reflect
      // the new pick. Picking one out via querySelector() updated
      // only the first; querySelectorAll keeps them in sync.
      const label = MODEL_LABELS[modelV] || modelV;
      document.querySelectorAll('[data-cmp-dd-value="agent-model"]').forEach((v) => {
        v.textContent = label;
      });
    },

    /** Click handler for the agent-composer starter list. Drops the
     *  starter's text into the textarea, focuses it, autosizes. The
     *  user can edit before submitting. */
    applyAgentStarter(idx) {
      const lang = this.composerLanguage();
      const list = this.AGENT_STARTERS_EN;
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
    /** Web-search prefix · prepended to the base list when the user
     *  opted into web search this run. Adds ~5s to the perceived
     *  pipeline; downstream startSecs are shifted in agentGenStagesFor.
     *  System UI · English-only. */
    AGENT_GEN_STAGES_WS_EN: { key: "search", label: "Searching the web for context", startSec: 0, sub: ["refining the query", "scanning Brave results", "distilling 5–6 named sources"] },

    /** Build the active stage list for THIS generation. When web search
     *  is on, prepend the search stage and shift everything else later.
     *  System UI · English-only regardless of `lang`. */
    agentGenStagesFor(_lang) {
      const base = this.AGENT_GEN_STAGES_EN_BASE;
      const useWs = !!this._agentGenUsingWebSearch;
      if (!useWs) return base;
      const SHIFT = 5;
      const shifted = base.map((s) => ({ ...s, startSec: s.startSec + SHIFT }));
      return [this.AGENT_GEN_STAGES_WS_EN, ...shifted];
    },

    /** Back-compat shims · existing references read these names directly. */
    get AGENT_GEN_STAGES_EN() { return this.agentGenStagesFor("en"); },
    get AGENT_GEN_STAGES_ZH() { return this.agentGenStagesFor("en"); },

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
        const stages = this.AGENT_GEN_STAGES_EN;
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
      // System UI · always English. Agent-generation stage panel is
      // app chrome around the LLM call.
      const stages = this.AGENT_GEN_STAGES_EN;
      const active = this.agentGenStageIndex;
      const elapsed = Math.max(0, (Date.now() - this.agentGenStartedAt) / 1000);
      const elapsedLabel = this._t("ag_gen_elapsed", { n: Math.round(elapsed) });
      const headerLabel = this._t("ag_gen_header");
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
          <button type="button" class="ag-gen-stop" data-agent-spec-stop title="Stop generating">[ Stop ]</button>
        </div>
        <div class="ag-gen-stage-area">
          <div class="ag-gen-sigil" aria-hidden="true">${sigilSvg}</div>
          <div class="ag-gen-active-block">
            <div class="ag-gen-active-kicker">${this.escape(this._t("ag_gen_step", { current: active + 1, total: stages.length }))}</div>
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
    /** Legacy ZH list · kept as an alias of EN so any external caller
     *  reading the property still resolves. System UI is English-only
     *  per the global rule (the brief language doesn't change app
     *  chrome). New code should reference AGENT_STARTERS_EN directly. */
    get AGENT_STARTERS_ZH() { return this.AGENT_STARTERS_EN; },

    /** Persisted toggle · "signal" (current quick path) or "full"
     *  (the deep 5-10 min persona builder). Defaults to signal so
     *  existing users see no behaviour change. */
    loadAgentBuilderMode() {
      try {
        const v = localStorage.getItem("boardroom.agentBuilder.mode");
        return v === "full" ? "full" : "signal";
      } catch { return "signal"; }
    },
    saveAgentBuilderMode(mode) {
      try { localStorage.setItem("boardroom.agentBuilder.mode", mode === "full" ? "full" : "signal"); }
      catch { /* swallow · localStorage may be locked */ }
    },

    renderAgentComposerHtml() {
      const userName = (this.prefs?.name || "you").trim() || "you";
      const lang = this.composerLanguage();
      const greeting = this.composerGreeting(lang, userName);
      const t = {
        greet: greeting,
        prompt: this._t("ag_cmp_prompt"),
        placeholder: this._t("ag_cmp_placeholder"),
        cta: this._t("ag_cmp_cta"),
        ctaHint: this._t("ag_cmp_cta_hint"),
        manual: this._t("ag_cmp_manual"),
        generating: this._t("ag_cmp_generating"),
        starterCaption: this._t("ag_cmp_starter_caption"),      };
      // Full-mode build in flight or finished · separate render path.
      // Returns a different surface (SSE progress block or save card)
      // that hides the textarea + starters · the user is committed to
      // this build until they save / cancel / discard.
      if (this.personaJob) {
        return this.renderPersonaBuilderHtml();
      }
      // Signal-mode post-generation no longer renders an inline
      // preview card · `openSignalSpecOverlay()` in
      // `_runAgentSpecGeneration` opens the SAME floating overlay
      // (`window.openNewAgent`) that Full-mode uses, so the underlying
      // view here goes back to the empty composer / placeholder while
      // the modal floats on top. `agentSpec` stays in memory only as
      // the data source the overlay's onSubmit reads from.
      // If the last attempt failed (timeout or other), render the
      // recovery card with [Retry] / [Discard] · keeps the description
      // around so retry doesn't need a re-type.
      if (this.agentSpecError) {
        return this.renderAgentSpecErrorHtml(this.agentSpecError, lang);
      }
      const generating = this.agentSpecGenerating;
      const builderMode = this.loadAgentBuilderMode();
      // CTA + placeholder pick up Full-mode copy when toggle is on.
      // Signal-mode keeps the existing i18n strings · no regression.
      const ctaLabel = builderMode === "full"
        ? "[ ✦ Build full persona ]"
        : t.cta;
      const ctaHint = builderMode === "full"
        ? "5–10 min · ReAct research + 7-phase build"
        : t.ctaHint;
      const starters = this.AGENT_STARTERS_EN;
      const starterCards = starters.map((q, idx) => `
        <button type="button" class="cmp-starter" data-agent-starter="${idx}">
          <div class="cmp-starter-tag">${this.escape(q.tag)}</div>
          <div class="cmp-starter-text">${this.escape(q.text)}</div>
          <div class="cmp-starter-arrow">→</div>
        </button>
      `).join("");
      return `
        <section class="cmp ag-cmp">
          <div class="cmp-bg-deco" aria-hidden="true">${this.composerBgDecoSvg("agent")}</div>
          <header class="cmp-hero">
            <div class="cmp-greet">${this.escape(t.greet)}</div>
            <h1 class="cmp-prompt">${this.escape(t.prompt)}</h1>
          </header>

          <div class="cmp-input-frame ${generating ? "is-generating" : ""}">
            <textarea class="cmp-input" data-agent-composer-desc rows="1" placeholder="${this.escape(t.placeholder)}" ${generating ? "disabled" : ""}>${this.escape(this.loadAgentComposerDraft())}</textarea>

            <div class="cmp-toolbar">
              <!-- Build-mode picker · Signal vs Full persona. Reuses
                   the canonical .cmp-dd dropdown vocabulary so this
                   toolbar stays visually consistent with the new-room
                   composer's tone/intensity dropdowns. Sits first so
                   the user picks the build flow before model / web
                   search / submit. Options + dispatch live in
                   openComposerDropdown / dd-pick handler under the
                   "agent-builder-mode" kind. -->
              <button type="button" class="cmp-dd cmp-dd-mode" data-cmp-dropdown="agent-builder-mode" title="Build mode · Signal (~10s) or Full persona (5–10min)">
                <span class="cmp-dd-label">build</span>
                <span class="cmp-dd-value" data-cmp-dd-value="agent-builder-mode">${this.escape(builderMode === "full" ? "FULL PERSONA" : "SIGNAL")}</span>
                <span class="cmp-dd-chevron">▾</span>
              </button>
              <!-- Model selection lives downstream now: the post-
                   generation spec preview card has a model <select>
                   (renderAgentSpecPreviewHtml), the manual new-agent
                   overlay has its own model picker (new-agent.js), and
                   the agent profile page can change the model at any
                   time. Putting it in the composer toolbar too was
                   redundant and made the bar visually noisy. -->
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
                const configured = this.agentComposerWebSearchConfigured();
                const on = configured && this.loadAgentComposerWebSearch();
                const stateLabel = !configured
                  ? this._t("ag_ws_needs_key")
                  : on
                    ? this._t("ag_ws_enabled")
                    : this._t("ag_ws_disabled");
                const titleText = !configured
                  ? this._t("ag_ws_title_needs")
                  : on
                    ? this._t("ag_ws_title_on")
                    : this._t("ag_ws_title_off");
                const wsLabel = this._t("ag_ws_label");
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
              <button type="button" class="cmp-go ${generating ? "busy" : ""}" data-agent-composer-go title="${this.escape(ctaLabel)} · ${this.escape(ctaHint)} (⏎)" ${generating ? "disabled" : ""}>
                ${generating
                  ? `<span class="cmp-go-arrow">…</span>`
                  : `<svg class="cmp-go-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M5 12h14"/>
                      <path d="m13 5 7 7-7 7"/>
                    </svg>`}
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
    renderAgentSpecPreviewHtml(spec) {      const seed = this.agentSpecAvatarSeed;
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
          <div class="ag-prev-kicker">${this.escape(this._t("ag_preview_kicker"))}</div>

          <div class="ag-prev-card">
            <header class="ag-prev-head">
              <div class="ag-prev-identity">
                <button type="button" class="ag-prev-av" data-agent-spec-reroll title="${this.escape(this._t("ag_preview_reroll"))}">
                  <div class="ag-prev-av-frame">${avatarSvg}</div>
                  <span class="ag-prev-av-reroll-mark">↻</span>
                </button>
                <div class="ag-prev-id-fields">
                  <input type="text" class="ag-prev-name" data-agent-spec-field="name" maxlength="32" value="${this.escape(spec.name)}" placeholder="${this.escape(this._t("ag_preview_name"))}">
                  <div class="ag-prev-id-meta">
                    <input type="text" class="ag-prev-roletag" data-agent-spec-field="roleTag" maxlength="32" value="${this.escape(spec.roleTag)}" placeholder="${this.escape(this._t("ag_preview_role"))}">
                    <span class="ag-prev-meta-sep">·</span>
                    <select class="ag-prev-model" data-agent-spec-field="modelV">${modelOpts}</select>
                  </div>
                </div>
              </div>
              <div class="ag-prev-radar" aria-hidden="true">${abilitySvg}</div>
            </header>

            <div class="ag-prev-body">
              <label class="ag-prev-field">
                <span class="ag-prev-label">${this.escape(this._t("ag_preview_bio"))}</span>
                <textarea class="ag-prev-input ag-prev-textarea" data-agent-spec-field="bio" maxlength="280" rows="2">${this.escape(spec.bio)}</textarea>
              </label>

              <label class="ag-prev-field">
                <span class="ag-prev-label">${this.escape(this._t("ag_preview_quote"))}</span>
                <textarea class="ag-prev-input ag-prev-textarea" data-agent-spec-field="coverQuote" maxlength="200" rows="2">${this.escape(spec.coverQuote || "")}</textarea>
              </label>

              <label class="ag-prev-field">
                <span class="ag-prev-label">${this.escape(this._t("ag_preview_instruction"))}</span>
                <textarea class="ag-prev-input ag-prev-textarea ag-prev-instr" data-agent-spec-field="instruction" maxlength="4000" rows="10">${this.escape(spec.instruction)}</textarea>
              </label>
            </div>

            <footer class="ag-prev-foot">
              <button type="button" class="ag-prev-discard" data-agent-spec-discard>${this.escape(this._t("ag_preview_discard"))}</button>
              <button type="button" class="ag-prev-redo" data-agent-spec-redo>↻ ${this.escape(this._t("ag_preview_redo"))}</button>
              <button type="button" class="ag-prev-save" data-agent-spec-save>
                <span class="ag-prev-save-mark">◆</span>
                <span>${this.escape(this._t("ag_preview_save"))}</span>
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
      const kicker = err.kind === "timeout" ? this._t("ag_err_kicker_timeout") : this._t("ag_err_kicker_fail");
      const title = err.kind === "timeout" ? this._t("ag_err_title_timeout") : this._t("ag_err_title_fail");
      const hint = err.kind === "timeout" ? this._t("ag_err_hint_timeout") : this._t("ag_err_hint_fail");
      const desc = this._agentComposerLastDesc || "";
      const detail = err.message ? `<div class="ag-gen-error-detail">${this.escape(err.message)}</div>` : "";
      return `
        <section class="cmp ag-cmp">
          <header class="cmp-hero">
            <div class="cmp-greet">${this.escape(this.composerGreeting(lang, (this.prefs?.name || "you").trim() || "you"))}</div>
            <h1 class="cmp-prompt">${this.escape(this._t("ag_err_prompt"))}</h1>
          </header>
          <div class="ag-gen-error-card">
            <div class="ag-gen-error-kicker">${this.escape(kicker)}</div>
            <h2 class="ag-gen-error-title">${this.escape(title)}</h2>
            <p class="ag-gen-error-hint">${this.escape(hint)}</p>
            ${detail}
            ${desc ? `
              <div class="ag-gen-error-desc">
                <div class="ag-gen-error-desc-label">${this.escape(this._t("ag_err_desc"))}</div>
                <div class="ag-gen-error-desc-body">${this.escape(desc)}</div>
              </div>
            ` : ""}
            <div class="ag-gen-error-actions">
              <button type="button" class="ag-gen-error-retry" data-agent-spec-retry>
                <span class="ag-gen-error-retry-mark">↻</span>
                <span>${this.escape(this._t("ag_err_retry"))}</span>
              </button>
              <button type="button" class="ag-gen-error-discard" data-agent-spec-error-discard>
                ${this.escape(this._t("ag_err_discard"))}
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
        <svg class="ag-prev-radar-svg" viewBox="0 0 ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg" aria-label="${this.escape(this._t("ag_preview_radar_aria"))}">
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
      // re-use it after a failure.
      this._agentComposerLastDesc = description;
      // Once the user commits, the input is consumed — clear both the
      // live textarea and the persisted draft so the next visit to the
      // new-agent view (incl. any mid-build re-render) starts empty.
      // Recovery from a failed build still works via _agentComposerLastDesc.
      if (ta) ta.value = "";
      this.clearAgentComposerDraft();
      const mode = this.loadAgentBuilderMode();
      if (mode === "full") {
        await this.startFullPersonaBuild(description);
      } else {
        await this._runAgentSpecGeneration(description);
      }
    },

    /** Switch the build mode toggle. Persists + repaints the composer
     *  so the pills + CTA copy reflect the choice immediately. Called
     *  by the [data-agent-builder-mode] click delegate. */
    setAgentBuilderMode(mode) {
      this.saveAgentBuilderMode(mode);
      this.renderEmptyState();
    },

    /* ─── Full-persona builder · client-side orchestration ─── */

    /** Phase labels mirror the server-side `phaseLabels` in
     *  `persona-builder.ts`. The list drives the progress block's
     *  ordered seven rows; each row's state is derived from
     *  `personaJob.currentPhase` (1..7). */
    PERSONA_PHASE_LABELS: [
      "Persona spec (v1)",
      "Knowledge context (research)",
      "Persona spec (refined)",
      "Behavioural rules",
      "Few-shot examples",
      "Reflection checklist",
      "Eval set + build report",
    ],

    /** Kick a new Full-mode build. Posts to /generate-persona, opens
     *  the SSE stream, sets up the elapsed-time tick, and renders the
     *  progress block. Errors here surface as a fail-state in the
     *  builder UI (no separate `agentSpecError` path · the persona
     *  job state carries its own error message). */
    async startFullPersonaBuild(description) {
      // Reset prior persona state so a second build starts clean.
      this.cancelPersonaBuild({ silent: true });
      // The auto-open guard is per-build · clear so a fresh build's
      // persona-final reopens the confirmation overlay.
      this._personaOverlayShown = false;
      this.personaJob = {
        jobId: null,
        status: "starting",
        currentPhase: 0,
        progressPct: 0,
        phaseDetail: "starting…",
        searchRounds: [],
        // Phase 2a · the dimension planner emits this once before the
        // parallel batch. Each entry's `status` flips from "pending" →
        // "done" as `persona-search-round` events arrive carrying the
        // matching `dimension` tag. UI renders this as a checklist
        // under the active Phase 2 row in the dossier.
        dimensions: [],
        partial: null,
        finalSpec: null,
        errorMessage: null,
        description,
      };
      this._personaStartedAt = Date.now();
      this.renderEmptyState();
      try {
        const r = await fetch("/api/agents/generate-persona", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ description }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error || ("HTTP " + r.status));
        }
        const j = await r.json();
        if (!j || !j.jobId) throw new Error("server returned no jobId");
        this.personaJob.jobId = j.jobId;
        this.personaJob.status = "running";
        this._openPersonaSse(j.jobId);
        this._startPersonaTick();
        // Same gating as the SSE handlers · if the user navigated
        // into a room between POST and response, don't repaint.
        this._personaRender();
        // Sidebar placeholder row · the user can navigate away
        // (into a room, agent profile, etc.) and come back via
        // this row.
        this.renderSidebarAgents();
      } catch (e) {
        this.personaJob.status = "failed";
        this.personaJob.errorMessage = (e && e.message) ? e.message : String(e);
        this._personaRender();
        this.renderSidebarAgents();
      }
    },

    /** Subscribe to the SSE stream + dispatch events into state.
     *  Called both on initial start AND on reconnect (the persona
     *  state survives an EventSource drop · we just open a new one
     *  pointed at the same jobId and the server replays the latest
     *  partial via the `hello` event). */
    _openPersonaSse(jobId) {
      try { this._personaSse?.close?.(); } catch { /* ignore */ }
      const sse = new EventSource(`/api/agents/generate-persona/${encodeURIComponent(jobId)}/stream`);
      this._personaSse = sse;

      const onMsg = (handler) => (ev) => {
        try { handler(JSON.parse(ev.data)); }
        catch { /* malformed event · skip */ }
      };

      sse.addEventListener("hello", onMsg((data) => {
        if (data && data.partial) {
          this.personaJob.partial = data.partial;
        }
        if (data && typeof data.currentPhase === "number") {
          this.personaJob.currentPhase = data.currentPhase;
        }
        if (data && typeof data.progressPct === "number") {
          this.personaJob.progressPct = data.progressPct;
        }
        this._personaRender();
      }));

      sse.addEventListener("persona-phase-start", onMsg((data) => {
        this.personaJob.currentPhase = data.phase;
        this.personaJob.phaseDetail = `starting · ${data.label}`;
        this._personaRender();
        // Sidebar placeholder row's subtitle reflects the active
        // phase · refresh on phase transitions so the user can
        // see progress from anywhere in the app.
        this.renderSidebarAgents();
      }));
      sse.addEventListener("persona-phase-progress", onMsg((data) => {
        this.personaJob.currentPhase = data.phase;
        this.personaJob.phaseDetail = data.detail || "";
        this.personaJob.progressPct = data.progressPct;
        this._personaRender();
      }));
      sse.addEventListener("persona-phase-end", onMsg((data) => {
        this.personaJob.partial = data.partial || this.personaJob.partial;
        this.personaJob.progressPct = data.progressPct;
        this._personaRender();
        this.renderSidebarAgents();
      }));
      sse.addEventListener("persona-dimension-plan", onMsg((data) => {
        // Phase 2a · planner picked the angles. Each entry starts as
        // "pending"; persona-search-round events flip them to "done".
        const list = Array.isArray(data && data.dimensions) ? data.dimensions : [];
        this.personaJob.dimensions = list.map((d) => ({
          dimension: String(d.dimension || ""),
          query: String(d.query || ""),
          why: String(d.why || ""),
          status: "pending",
          resultsCount: 0,
          pagesRead: 0,
        }));
        this._personaRender();
      }));
      sse.addEventListener("persona-search-round", onMsg((data) => {
        const dimension = typeof data.dimension === "string" ? data.dimension : "";
        const phase = typeof data.phase === "string" ? data.phase : "";
        this.personaJob.searchRounds.push({
          round: data.round,
          query: data.query,
          resultsCount: data.resultsCount,
          pagesRead: data.pagesRead,
          dimension: dimension || undefined,
          phase: phase || undefined,
        });
        // Cap the search log length so a chatty loop doesn't unbounded-grow.
        if (this.personaJob.searchRounds.length > 30) {
          this.personaJob.searchRounds = this.personaJob.searchRounds.slice(-30);
        }
        // Flip the matching dimension entry to "done". Lazy-create
        // the entry if a round arrives whose dimension wasn't in the
        // plan event (race · plan event arrived after the first round
        // for some reason, or planner used a tag we didn't pre-list).
        if (dimension) {
          const list = Array.isArray(this.personaJob.dimensions) ? this.personaJob.dimensions : [];
          let entry = list.find((d) => d.dimension === dimension);
          if (!entry) {
            entry = {
              dimension,
              query: data.query || "",
              why: "",
              status: "pending",
              resultsCount: 0,
              pagesRead: 0,
            };
            list.push(entry);
            this.personaJob.dimensions = list;
          }
          entry.status = "done";
          entry.resultsCount = data.resultsCount || 0;
          entry.pagesRead = data.pagesRead || 0;
        }
        this._personaRender();
      }));
      sse.addEventListener("persona-final", onMsg((data) => {
        this.personaJob.status = "done";
        this.personaJob.progressPct = 100;
        this.personaJob.finalSpec = data.spec || null;
        this.personaJob.partial = data.spec || this.personaJob.partial;
        // Augmented presentation fields the route layer adds so the
        // save card can mirror Signal-mode's preview shell. The
        // user edits these in the form; defaults are server-side
        // synthesized from the spec.
        this.personaJob.finalInstruction = data.instruction || "";
        this.personaJob.finalBio = data.bio || "";
        this.personaJob.finalCoverQuote = data.coverQuote || "";
        this.personaJob.finalAbility = data.ability || {};
        this.personaJob.finalGuessName = data.guessName || "";
        this.personaJob.finalGuessRoleTag = data.guessRoleTag || "director";
        // Avatar seed · matches Signal-mode's pattern. Random per
        // build, user can re-roll on the save card.
        this.personaJob.avatarSeed = (window.AvatarSkill && window.AvatarSkill.randomSeed)
          ? window.AvatarSkill.randomSeed()
          : null;
        this._closePersonaSse();
        this._stopPersonaTick();
        this._personaRender();
        // Sidebar row flips from "BUILD · phase X · Y%" to "READY"
        // so the user can spot it from anywhere.
        this.renderSidebarAgents();
        // Auto-open the manual-config overlay one-shot · only when
        // the user is actually on the agent composer (no room
        // loaded). If they navigated into a room mid-build, opening
        // a save dialog over the room is intrusive · defer until
        // they return (the inline "Open confirmation" callout
        // surfaces there and lets them re-open then; the sidebar
        // "READY" row also routes back via setComposerMode("agent")
        // in the click delegate).
        if (!this._personaOverlayShown && this._personaUiActive()) {
          this._personaOverlayShown = true;
          this.openPersonaConfirmOverlay();
        }
      }));
      sse.addEventListener("persona-error", onMsg((data) => {
        this.personaJob.status = "failed";
        this.personaJob.errorMessage = data.message || "build failed";
        this._closePersonaSse();
        this._stopPersonaTick();
        this._personaRender();
        // Failed/aborted rows are removed from the sidebar · the
        // user recovers via the inline error card on the agent
        // composer view.
        this.renderSidebarAgents();
      }));
      sse.addEventListener("persona-aborted", onMsg(() => {
        this.personaJob.status = "aborted";
        this._closePersonaSse();
        this._stopPersonaTick();
        this._personaRender();
        this.renderSidebarAgents();
      }));

      sse.onerror = () => {
        // Transport drop · the server may still be running. Try one
        // reconnect after a brief delay; if THAT also drops the user
        // sees a "connection lost" UI (rendered in the progress
        // block) and can manually retry.
        if (this.personaJob && this.personaJob.status === "running") {
          setTimeout(() => {
            if (this.personaJob && this.personaJob.status === "running") {
              this._openPersonaSse(this.personaJob.jobId);
            }
          }, 2000);
        }
      };
    },

    _closePersonaSse() {
      try { this._personaSse?.close?.(); } catch { /* ignore */ }
      this._personaSse = null;
    },

    _startPersonaTick() {
      this._stopPersonaTick();
      this._personaTick = setInterval(() => {
        if (!this.personaJob || this.personaJob.status !== "running") {
          this._stopPersonaTick();
          return;
        }
        // 1 Hz · only the clock changes per tick. Avoid a full
        // renderEmptyState() (the section height + DOM tree
        // would re-mount and the user would see a one-pixel
        // jolt every second). Patch just the elapsed / eta /
        // progress numbers in place.
        const elapsed = Math.max(0, (Date.now() - this._personaStartedAt) / 1000);
        const elapsedLabel = this._fmtMmSs(elapsed);
        const totalEta = this.PERSONA_PHASE_ETAS.reduce((a, b) => a + b, 0);
        const etaRemaining = Math.max(15, totalEta - elapsed);
        const etaLabel = "~" + this._fmtMmSs(etaRemaining);
        const elEl = document.querySelector("[data-pb-elapsed]");
        if (elEl) elEl.textContent = elapsedLabel;
        const etaEl = document.querySelector("[data-pb-eta]");
        if (etaEl) etaEl.textContent = etaLabel;
      }, 1000);
    },
    _stopPersonaTick() {
      if (this._personaTick) {
        clearInterval(this._personaTick);
        this._personaTick = null;
      }
    },

    /** User clicked Cancel during the build. Best-effort POST to
     *  abort upstream; the SSE handler picks up the `persona-aborted`
     *  event when the server flushes it. */
    cancelPersonaBuild(opts) {
      const silent = !!(opts && opts.silent);
      const job = this.personaJob;
      if (!job || !job.jobId) {
        if (!silent) this.discardPersonaBuild();
        return;
      }
      if (job.status === "running") {
        try {
          fetch(`/api/agents/generate-persona/${encodeURIComponent(job.jobId)}/abort`, { method: "POST" });
        } catch { /* swallow · the SSE will close anyway when the job hits its abort path */ }
      }
      this._closePersonaSse();
      this._stopPersonaTick();
      if (silent) {
        this.personaJob = null;
      }
    },

    /** User clicked Discard from the failed / aborted card. Drops
     *  all client state and returns to the composer textarea. */
    discardPersonaBuild() {
      this._closePersonaSse();
      this._stopPersonaTick();
      this.personaJob = null;
      this._personaOverlayShown = false;
      // Close the manual overlay if it's still open · the user
      // explicitly discarded, no need to leave a stale form.
      if (typeof window.closeNewAgent === "function") {
        try { window.closeNewAgent(); } catch (_) { /* */ }
      }
      // Cleared in case a prior code path hydrated them on the
      // shared preview shell.
      this.agentSpec = null;
      this.agentSpecAvatarSeed = null;
      this.renderEmptyState();
      // Drop the sidebar "Building" row alongside the discard.
      this.renderSidebarAgents();
    },

    /** User clicked Retry from the failed / aborted card. Re-runs
     *  the build with the same description (preserved on the job
     *  state). */
    retryPersonaBuild() {
      const desc = this.personaJob?.description || this._agentComposerLastDesc || "";
      this.discardPersonaBuild();
      if (desc) this.startFullPersonaBuild(desc);
    },

    // Note · `savePersonaBuild` was retired when the Full-mode
    // confirmation moved into the manual-config overlay (see
    // `openPersonaConfirmOverlay`). The overlay's onSubmit handles
    // the POST to /generate-persona/:jobId/save inline.

    /** Render the entire builder surface · branches by status:
     *    · running → 7-phase progress block
     *    · done    → save card with build report
     *    · failed / aborted → recovery card with retry / discard */
    /** Game-themed labels for the 7 phases · sit alongside the
     *  internal PERSONA_PHASE_LABELS (which match server names).
     *  This array is what the user sees on the build stage; the
     *  internal ones still drive logic / save card etc. */
    PERSONA_PHASE_OP_LABELS: [
      "FORGING IDENTITY",
      "INTERCEPTING KNOWLEDGE",
      "SHARPENING THE LENS",
      "DRAFTING PLAYBOOK",
      "CAPTURING VOICE",
      "SETTING SELF-CHECKS",
      "RUNNING TRIALS",
    ],
    /** Estimated wall-clock per phase · seconds. Used to compute
     *  ETA on the stage header. Mirror of the server `phaseEtas`
     *  in persona-builder.ts so client + server tell the user the
     *  same story. */
    PERSONA_PHASE_ETAS: [30, 280, 30, 45, 90, 30, 60],

    renderPersonaBuilderHtml() {
      const job = this.personaJob;
      if (!job) return "";
      const elapsed = Math.max(0, (Date.now() - this._personaStartedAt) / 1000);
      const elapsedLabel = this._fmtMmSs(elapsed);
      if (job.status === "done" && job.finalSpec) {
        return this.renderPersonaSaveCardHtml(job.finalSpec, elapsedLabel);
      }
      if (job.status === "failed" || job.status === "aborted") {
        return this.renderPersonaErrorCardHtml(job, elapsedLabel);
      }
      // running (or starting) · gamified DOSSIER ASSEMBLY stage.
      const phases = this.PERSONA_PHASE_OP_LABELS;
      const active = Math.max(1, Math.min(phases.length, job.currentPhase || 1));
      const pct = Math.round(job.progressPct || 0);
      // ETA · sum of remaining phase budgets minus elapsed-in-active.
      // Cheap heuristic, but it gives the user a sense of "minutes
      // to go" instead of an unbounded spinner.
      const totalEta = this.PERSONA_PHASE_ETAS.reduce((a, b) => a + b, 0);
      const etaRemaining = Math.max(15, totalEta - elapsed);
      const etaLabel = "~" + this._fmtMmSs(etaRemaining);

      // Operative codename · derived from the jobId so it's stable
      // across SSE reconnects and feels distinct per build.
      const codename = "OPERATIVE-" + (job.jobId || "XXXXXX").slice(0, 4).toUpperCase();

      // Live counters. Pulled from spec partials when available;
      // the ReAct loop's per-round events drive sources/searches/
      // pages while running.
      const partial = job.partial || {};
      const knowledge = partial.knowledge || {};
      const sourcesCount = ((knowledge.keyThinkers || []).length
        + (knowledge.foundationalWorks || []).length
        + (knowledge.recentDevelopments || []).length
        + (knowledge.contestedClaims || []).length);
      const searchesCount = (job.searchRounds || []).length;
      const pagesCount = (job.searchRounds || []).reduce((a, r) => a + (r.pagesRead || 0), 0);
      const rulesCount = (partial.rules || []).length;
      const fewShotCount = (partial.fewShot || []).length;
      const checksCount = (partial.reflectionChecklist || []).length;

      // 20-segment progress bar · reads as a console "HP bar"
      // rather than a smooth gradient.
      const SEGMENTS = 20;
      const filled = Math.max(0, Math.min(SEGMENTS, Math.round((pct / 100) * SEGMENTS)));
      const segments = Array.from({ length: SEGMENTS }, (_, i) => {
        const cls = i < filled ? "pb-seg-fill" : "pb-seg-empty";
        return `<span class="pb-seg ${cls}" aria-hidden="true"></span>`;
      }).join("");

      // Phase 2's counter prefers `M/N angles` when the dimension
      // planner has emitted, otherwise falls back to the legacy
      // searches/pages line.
      const dimsTotal = (job.dimensions || []).length;
      const dimsDone = (job.dimensions || []).filter((d) => d.status === "done").length;
      const phase2Counter = dimsTotal > 0
        ? `${dimsDone}/${dimsTotal} angles${pagesCount > 0 ? ` · ${pagesCount} pages` : ""}`
        : (searchesCount > 0 ? `${searchesCount} searches · ${pagesCount} pages` : "");
      const phaseDescriptors = [
        { hint: "Stage-A profile · lineage / concepts / referents", counter: "" },
        { hint: "Multi-angle parallel research · synthesis", counter: phase2Counter },
        { hint: "Critique pass · spec re-derived with live knowledge", counter: "" },
        { hint: "Always / Never / When-X-do-Y rules", counter: rulesCount > 0 ? `${rulesCount} rules` : "" },
        { hint: "Worked input → output examples · runtime injection", counter: fewShotCount > 0 ? `${fewShotCount} examples` : "" },
        { hint: "Per-turn silent self-check questions", counter: checksCount > 0 ? `${checksCount} checks` : "" },
        { hint: "Eval prompts + lexical differentiation probes", counter: "" },
      ];
      // Phase-2 dimension checklist · the parallel research angles.
      // Renders inside the Phase 2 row when dimensions exist (visible
      // during 2b/2c, persists faded after Phase 2 completes).
      const dimensions = Array.isArray(job.dimensions) ? job.dimensions : [];
      const dimChecklistHtml = dimensions.length === 0
        ? ""
        : `
          <ul class="pb-dim-list">
            ${dimensions.map((d) => {
              const st = d.status === "done" ? "done" : "pending";
              const icon = st === "done" ? "✓" : "○";
              const meta = st === "done"
                ? `${d.resultsCount || 0} results · ${d.pagesRead || 0} pages`
                : "queued";
              const truncQuery = (d.query || "").length > 64
                ? (d.query || "").slice(0, 64) + "…"
                : (d.query || "");
              return `
                <li class="pb-dim pb-dim-${st}">
                  <span class="pb-dim-icon">${icon}</span>
                  <span class="pb-dim-tag">${this.escape(d.dimension || "")}</span>
                  <span class="pb-dim-query" title="${this.escape(d.query || "")}">${this.escape(truncQuery)}</span>
                  <span class="pb-dim-meta">${this.escape(meta)}</span>
                </li>
              `;
            }).join("")}
          </ul>
        `;
      const phaseRows = phases.map((label, i) => {
        const phaseNum = i + 1;
        const status = phaseNum < active ? "done" : phaseNum === active ? "active" : "pending";
        const icon = status === "done" ? "✓" : status === "active" ? "▣" : "▢";
        const desc = phaseDescriptors[i] || { hint: "", counter: "" };
        const detail = (status === "active" && job.phaseDetail)
          ? `<div class="pb-phase-detail">${this.escape(job.phaseDetail)}</div>`
          : "";
        // Phase 2's row gets the dimension checklist appended once
        // the planner has emitted its angles.
        const dimList = (phaseNum === 2 && dimChecklistHtml) ? dimChecklistHtml : "";
        const counter = desc.counter
          ? `<span class="pb-phase-counter">${this.escape(desc.counter)}</span>`
          : "";
        return `
          <li class="pb-phase pb-phase-${status}">
            <span class="pb-phase-num">0${phaseNum}</span>
            <span class="pb-phase-icon">${icon}</span>
            <span class="pb-phase-content">
              <span class="pb-phase-label">${this.escape(label)}</span>
              <span class="pb-phase-hint">${this.escape(desc.hint)}</span>
              ${detail}
              ${dimList}
            </span>
            ${counter}
          </li>
        `;
      }).join("");

      // Intel feed · synthesise from the phases + searchRounds.
      // Most recent first. Phase transitions become decorative
      // entries; per-round entries show the actual search activity.
      const feedItems = [];
      const activeOpLabel = phases[active - 1] || "running";
      feedItems.push({
        kind: "phase-active",
        text: `[ phase 0${active} · ${activeOpLabel.toLowerCase()} ] ${job.phaseDetail || "running…"}`,
      });
      const rounds = (job.searchRounds || []).slice().reverse();
      for (const r of rounds) {
        const tag = r.dimension ? `[${r.dimension}] ` : (r.phase === "topup" ? "[top-up] " : "");
        feedItems.push({
          kind: "round",
          text: `⟶ ${tag}search · "${(r.query || "").slice(0, 80)}"`,
          meta: `${r.resultsCount || 0} results · ${r.pagesRead || 0} pages read`,
        });
      }
      for (let i = active - 2; i >= 0; i--) {
        feedItems.push({
          kind: "phase-done",
          text: `✓ phase 0${i + 1} · ${phases[i].toLowerCase()} complete`,
        });
      }
      const feedRows = feedItems.slice(0, 14).map((it, i) => {
        const meta = it.meta ? `<span class="pb-feed-meta">${this.escape(it.meta)}</span>` : "";
        return `
          <li class="pb-feed-line pb-feed-${it.kind}" style="--pb-feed-idx: ${i};">
            <span class="pb-feed-text">${this.escape(it.text)}</span>
            ${meta}
          </li>
        `;
      }).join("");

      const subjectLine = job.description.length > 120
        ? job.description.slice(0, 120) + "…"
        : job.description;

      return `
        <section class="cmp ag-cmp pb-stage">
          <header class="pb-stage-head">
            <div class="pb-stage-title">
              <div class="pb-stage-kicker">// operation · deep persona replication</div>
              <h1 class="pb-stage-subject">"${this.escape(subjectLine)}"</h1>
            </div>
            <div class="pb-stage-meta">
              <div class="pb-meta-row"><span class="pb-meta-l">elapsed</span><span class="pb-meta-v" data-pb-elapsed>${this.escape(elapsedLabel)}</span></div>
              <div class="pb-meta-row"><span class="pb-meta-l">eta</span><span class="pb-meta-v" data-pb-eta>${this.escape(etaLabel)}</span></div>
              <div class="pb-meta-row pb-meta-pct"><span class="pb-meta-l">progress</span><span class="pb-meta-v">${pct}%</span></div>
            </div>
          </header>

          <div class="pb-segbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
            ${segments}
          </div>

          <div class="pb-grid">
            <div class="pb-dossier">
              <div class="pb-dossier-frame">
                <div class="pb-dossier-corner pb-dossier-tl"></div>
                <div class="pb-dossier-corner pb-dossier-tr"></div>
                <div class="pb-dossier-corner pb-dossier-bl"></div>
                <div class="pb-dossier-corner pb-dossier-br"></div>

                <div class="pb-dossier-head">
                  <div class="pb-dossier-tag">┌── OPERATIVE DOSSIER ──</div>
                  <div class="pb-dossier-id">
                    <span class="pb-dossier-codename">${this.escape(codename)}</span>
                    <span class="pb-dossier-status"><span class="pb-dossier-pulse"></span> ASSEMBLING</span>
                  </div>
                </div>

                <ul class="pb-phase-list">
                  ${phaseRows}
                </ul>

                <div class="pb-stats">
                  <div class="pb-stat"><span class="pb-stat-v">${sourcesCount}</span><span class="pb-stat-l">SOURCES</span></div>
                  <div class="pb-stat"><span class="pb-stat-v">${searchesCount}</span><span class="pb-stat-l">SEARCHES</span></div>
                  <div class="pb-stat"><span class="pb-stat-v">${pagesCount}</span><span class="pb-stat-l">PAGES</span></div>
                  <div class="pb-stat"><span class="pb-stat-v">${rulesCount}</span><span class="pb-stat-l">RULES</span></div>
                  <div class="pb-stat"><span class="pb-stat-v">${fewShotCount}</span><span class="pb-stat-l">VOICE EX.</span></div>
                  <div class="pb-stat"><span class="pb-stat-v">${checksCount}</span><span class="pb-stat-l">CHECKS</span></div>
                </div>
              </div>
            </div>

            <div class="pb-feed">
              <div class="pb-feed-head">
                <span class="pb-feed-tag">// intel feed</span>
                <span class="pb-feed-cursor">▶_</span>
              </div>
              <ul class="pb-feed-list">
                ${feedRows || `<li class="pb-feed-line pb-feed-empty"><span class="pb-feed-text">awaiting first signal…</span></li>`}
              </ul>
            </div>
          </div>

          <footer class="pb-stage-foot">
            <button type="button" class="pb-cancel" data-persona-cancel>
              <span class="pb-cancel-mark">⏻</span>
              <span>ABORT OPERATION</span>
            </button>
            <span class="pb-foot-hint">accumulated tokens absorbed · no agent will be saved</span>
          </footer>
        </section>
      `;
    },

    /** Persona build is running in the background but the user
     *  navigated to a room (or another composer mode) · the SSE
     *  handlers must not paint the persona builder over the
     *  current view. Active = on the agent composer with no room
     *  loaded. */
    _personaUiActive() {
      return this.composerMode === "agent" && !this.currentRoomId;
    },

    /** Repaint the empty state ONLY when the persona builder UI is
     *  what the user is currently looking at. SSE-driven path uses
     *  this instead of `renderEmptyState` directly · without the
     *  guard, a phase event mid-room-view would clobber the chat
     *  panel with the persona dossier. */
    _personaRender() {
      if (this._personaUiActive()) this.renderEmptyState();
    },

    /** Format seconds as MM:SS. Used by the build-stage header for
     *  elapsed + ETA. */
    _fmtMmSs(secs) {
      const s = Math.max(0, Math.round(secs || 0));
      const m = Math.floor(s / 60);
      const r = s - m * 60;
      return m + ":" + (r < 10 ? "0" + r : r);
    },

    renderPersonaErrorCardHtml(job, elapsedLabel) {
      const isAborted = job.status === "aborted";
      const heading = isAborted ? "Build cancelled" : "Build failed";
      const detail = isAborted
        ? "You cancelled the build · partial state has been discarded."
        : (job.errorMessage || "Something went wrong.");
      return `
        <section class="cmp ag-cmp ag-persona-builder">
          <header class="cmp-hero">
            <div class="cmp-greet">// ${this.escape(isAborted ? "cancelled" : "failed")}</div>
            <h1 class="cmp-prompt">${this.escape(heading)}</h1>
          </header>
          <div class="ag-persona-error-card">
            <div class="ag-persona-error-detail">${this.escape(detail)}</div>
            <div class="ag-persona-error-meta">elapsed · ${this.escape(elapsedLabel)}</div>
            <div class="ag-persona-error-actions">
              <button type="button" class="ag-persona-retry" data-persona-retry>[ ↻ Retry ]</button>
              <button type="button" class="ag-persona-discard" data-persona-discard>[ Discard ]</button>
            </div>
          </div>
        </section>
      `;
    },

    renderPersonaSaveCardHtml(spec, elapsedLabel) {
      // The actual confirmation lives in the manual-config
      // overlay (window.openNewAgent) · the build's persona-final
      // SSE handler opens it one-shot. This inline view is a
      // small fallback callout that re-opens the overlay if the
      // user dismissed it (so we don't lose the 5-10 min build).
      // Renders below it: the build report (differentiation
      // score + eval breakdown) since that's persona-only signal
      // and shouldn't clutter the shared overlay's chrome.
      const score = typeof spec.differentiationScore === "number"
        ? `${(spec.differentiationScore * 100).toFixed(1)}%`
        : "—";
      const sortedEval = (spec.evalSet || []).slice().sort((a, b) => (b.divergenceScore || 0) - (a.divergenceScore || 0));
      const top = sortedEval.slice(0, 3);
      const bottom = sortedEval.slice(-2).reverse();
      const evalRow = (e) => {
        const s = typeof e.divergenceScore === "number" ? `${(e.divergenceScore * 100).toFixed(0)}%` : "—";
        return `<li><span class="ag-persona-eval-q">${this.escape(e.prompt.slice(0, 80))}${e.prompt.length > 80 ? "…" : ""}</span><span class="ag-persona-eval-score">${s}</span></li>`;
      };
      return `
        <section class="cmp ag-cmp pb-done">
          <div class="pb-done-card">
            <div class="pb-done-kicker">// build complete · ${this.escape(elapsedLabel)}</div>
            <h1 class="pb-done-title">Operative ready · awaiting confirmation</h1>
            <p class="pb-done-sub">The persona is fully assembled. Open the confirmation overlay to review the name, instruction, model, and avatar before saving the director.</p>
            <div class="pb-done-actions">
              <button type="button" class="pb-done-discard" data-persona-discard-build>[ Discard build ]</button>
              <button type="button" class="pb-done-open" data-persona-open-confirm>
                <span class="pb-done-open-mark">▸</span>
                <span>Open confirmation</span>
              </button>
            </div>
          </div>

          <div class="ag-persona-report">
            <div class="ag-persona-report-head">
              <span class="ag-persona-report-tag">// build report · differentiation (lexical)</span>
              <span class="ag-persona-report-score">${score}</span>
            </div>
            ${top.length ? `<div class="ag-persona-report-section">
              <div class="ag-persona-report-section-tag">strongest divergence</div>
              <ol class="ag-persona-eval-list">${top.map(evalRow).join("")}</ol>
            </div>` : ""}
            ${bottom.length ? `<div class="ag-persona-report-section">
              <div class="ag-persona-report-section-tag">weakest divergence</div>
              <ol class="ag-persona-eval-list">${bottom.map(evalRow).join("")}</ol>
            </div>` : ""}
            <div class="ag-persona-report-deck">
              The eval set ran each prompt through a cheap probe model with the persona vs a generic baseline; lexical (Jaccard) distance scored how distinct the responses were. Higher = more differentiated. Save proceeds regardless · this is informative, not gating.
            </div>
          </div>
        </section>
      `;
    },

    /** Open the manual-config overlay (`window.openNewAgent`) with
     *  the persona build's prefill + a custom submit handler that
     *  POSTs to /generate-persona/:jobId/save instead of the
     *  default /api/agents. The user sees identical chrome to a
     *  Signal manual create · only the network destination
     *  differs. Cancel preserves the build (the inline "Open
     *  confirmation" callout re-opens this overlay). */
    openPersonaConfirmOverlay() {
      const job = this.personaJob;
      if (!job || job.status !== "done" || !job.finalSpec) return;
      if (typeof window.openNewAgent !== "function") return;
      const spec = job.finalSpec;
      const prefill = {
        name: (job.finalGuessName || "").trim()
          || ((spec.description || "").trim().split(/\s+/).slice(0, 3).join(" ") || "Director"),
        // Bio prefers the server-synthesized intro (1-3 sentences in
        // the seed-bio register, derived from the spec's contrarian
        // takes / failure modes / load-bearing concepts). Falls back
        // to the user's typed description if synthesis returned
        // empty (rare · degenerate spec).
        bio: ((job.finalBio || "").trim() || (spec.description || "").trim().slice(0, 280)),
        instruction: (job.finalInstruction || "").trim(),
        modelV: this.loadAgentComposerModel() || "opus-4-7",
        avatarSeed: job.avatarSeed,
      };
      const score = typeof spec.differentiationScore === "number"
        ? `${(spec.differentiationScore * 100).toFixed(0)}%`
        : null;
      const footMeta = score
        ? `Full-mode build · differentiation ${score} · review and confirm`
        : `Full-mode build · review and confirm`;
      window.openNewAgent({
        prefill,
        classificationLeft: "DIRECTOR · FULL-MODE BUILD",
        footMeta,
        createLabel: "Save director",
        onSubmit: async (data, helpers) => {
          // POST the user-edited fields to the persona save
          // endpoint · server re-synthesizes instruction if the
          // user blanked it, otherwise honours the override.
          const handle = "/" + (data.name || "director").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 16);
          const ability = (job.finalAbility && Object.keys(job.finalAbility).length > 0)
            ? job.finalAbility
            : null;
          const r = await fetch(`/api/agents/generate-persona/${encodeURIComponent(job.jobId)}/save`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: data.name,
              handle,
              roleTag: (job.finalGuessRoleTag || "director").trim() || "director",
              bio: data.bio,
              coverQuote: (job.finalCoverQuote || "").trim(),
              instruction: data.instruction,
              modelV: data.modelV,
              avatarPath: data.avatarPath,
              ...(ability ? { ability } : {}),
            }),
          });
          if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            throw new Error(e.error || ("HTTP " + r.status));
          }
          // Sync local state to mirror successful save. Null
          // `personaJob` BEFORE refreshAgents so the sidebar
          // re-render inside refreshAgents drops the Building
          // placeholder row (its visibility is gated on
          // `personaJob`).
          this.personaJob = null;
          this._personaOverlayShown = false;
          await this.refreshAgents?.();
          this.composerMode = "room";
          this.setComposerMode?.("room");
          this.renderEmptyState();
        },
        onCancel: () => {
          // User dismissed without saving · keep the persona job
          // around so they can re-open via the inline callout.
          // Reset the one-shot guard so the overlay opens again
          // if a fresh persona-final somehow re-fires (resume path).
          this._personaOverlayShown = false;
          this.renderEmptyState();
        },
      });
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
        if (timedOut || isAbort) {
          // System UI · always English (error message text).
          this.agentSpecError = {
            kind: "timeout",
            message: "Generation took longer than 5 minutes · the model may be slow, the network flaky, or the backend stuck.",
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
        // Successful fetch path · open the floating save overlay (same
        // component Full-mode uses) once the underlying empty composer
        // has painted. Skipped on the error path · the inline error
        // card stays on screen with retry / discard buttons.
        if (this.agentSpec && !this.agentSpecError) {
          this.openSignalSpecOverlay();
        }
      }
    },

    /** Open the shared `window.openNewAgent` overlay with the freshly
     *  generated Signal-mode spec prefilled. Same overlay component
     *  that `openPersonaConfirmOverlay` uses for Full-mode saves —
     *  `prefill` populates name / bio / instruction / model / avatar,
     *  `onSubmit` POSTs to `/api/agents` with the user-edited fields
     *  + the spec's ability axes + the rolled avatar, and `onCancel`
     *  discards the in-memory spec so the underlying empty composer
     *  is the user's natural next step. */
    openSignalSpecOverlay() {
      const spec = this.agentSpec;
      if (!spec) return;
      if (typeof window.openNewAgent !== "function") return;
      const prefill = {
        name: (spec.name || "").trim(),
        bio: (spec.bio || "").trim(),
        instruction: (spec.instruction || "").trim(),
        modelV: spec.modelV || this.loadAgentComposerModel() || "opus-4-7",
        avatarSeed: this.agentSpecAvatarSeed,
      };
      const usedSearch = !!this._agentGenUsingWebSearch;
      const footMeta = usedSearch
        ? "Signal-mode build · web-search grounded · review and confirm"
        : "Signal-mode build · review and confirm";
      window.openNewAgent({
        prefill,
        classificationLeft: "DIRECTOR · SIGNAL-MODE BUILD",
        footMeta,
        createLabel: "Save director",
        onSubmit: async (data) => {
          // Mirror the existing /api/agents POST body the inline
          // preview's `saveAgentSpec` was using · plus the user-edited
          // fields the overlay returns. Server validates + clamps the
          // ability map; we forward whatever the spec produced.
          const ability = (spec.ability && Object.keys(spec.ability).length > 0)
            ? spec.ability
            : null;
          const r = await fetch("/api/agents", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: data.name,
              roleTag: (spec.roleTag || "director").trim() || "director",
              bio: data.bio,
              coverQuote: (spec.coverQuote || "").trim(),
              instruction: data.instruction,
              modelV: data.modelV,
              avatarPath: data.avatarPath,
              ...(ability ? { ability } : {}),
            }),
          });
          if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            throw new Error(e.error || ("HTTP " + r.status));
          }
          const j = await r.json();
          await this.refreshAgents?.();
          this.agentSpec = null;
          this.agentSpecAvatarSeed = null;
          this.clearAgentComposerDraft();
          this.composerMode = "room";
          const newId = j && (j.id || (j.agent && j.agent.id));
          // Land on the new agent's full profile (mirrors the prior
          // inline-preview save flow's post-success navigation).
          if (newId && typeof window.boardroomFocusAgent === "function") {
            setTimeout(() => window.boardroomFocusAgent(newId), 50);
          } else if (newId && window.openAgentProfile) {
            setTimeout(() => window.openAgentProfile(newId), 50);
          } else {
            this.renderEmptyState();
            this.markActiveRoom(null);
          }
        },
        onCancel: () => {
          // Same effect as the prior inline [Discard] · drop the spec
          // so the next composer paint is the fresh-input form.
          this.agentSpec = null;
          this.agentSpecAvatarSeed = null;
          this.renderEmptyState();
        },
      });
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

    /** Read inline-edited values from the Signal preview card and
     *  POST to /api/agents. Persona-mode save is a separate path
     *  (`openPersonaConfirmOverlay` → manual-config overlay → its
     *  own onSubmit), so this handler is now Signal-only. */
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
      // System UI · always English. Brief picker chrome (popover
      // title, row labels) doesn't follow the brief language.
      const t = { title: "Open a report", supplementPrefix: "Supplement: ", initial: "Initial", filed: "filed" };
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
          ? new Date(b.createdAt).toLocaleString(undefined, {
              year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
            })
          : "";
        const href = this.briefViewerHref(b, roomId);
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
      // System UI · always English (composer director picker chrome).
      const t = { title: "Pick directors", hint: "2-4 recommended", done: "Done", info: "View profile" };
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
        <div class="composer-pick-list">${rows || `<div class="composer-pick-empty">${this.escape(this._t("picker_no_directors"))}</div>`}</div>
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
        // System UI · always English (auto-pick chip tooltip).
        const autoTip = "Chair picks 3 directors based on your subject when you Convene · click to pick manually";
        btn.title = autoTip;
        btn.innerHTML = `
          <span class="cmp-cast-stack cmp-cast-stack-auto" data-cast-auto>
            <span class="cmp-cast-auto-mark">✦</span>
          </span>
          <span class="cmp-cast-count cmp-cast-auto-label">
            <span class="cmp-cast-auto-key">directors</span>
            <span class="cmp-cast-auto-val">auto-pick</span>
          </span>
        `;
        return;
      }
      const visible = dirObjs.slice(0, 4);
      const overflow = Math.max(0, dirObjs.length - 4);
      const avs = visible.map((a) => `<img class="cmp-cast-av" src="${this.escape(a.avatarPath)}" alt="${this.escape(a.name)}" title="${this.escape(a.name)}">`).join("");
      // System UI · always English (cast button count chrome).
      const countText = dirObjs.length
        ? `${dirObjs.length} director${dirObjs.length === 1 ? "" : "s"}`
        : "no directors";
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

    setComposerDeliveryMode(deliveryMode) {
      const state = this.loadComposerState();
      state.deliveryMode = deliveryMode === "voice" ? "voice" : "text";
      this.saveComposerState();
      // Sync the button-style toggle's classes / aria / data attrs /
      // visible text. Was a checkbox previously (cb.checked = ...);
      // the new register uses .ap-skill-row-toggle so we mirror what
      // the click handler does for the in-place mutation case.
      const btn = document.querySelector("[data-composer-voice-toggle]");
      if (btn) {
        const on = state.deliveryMode === "voice";
        btn.classList.toggle("on", on);
        btn.classList.toggle("off", !on);
        btn.setAttribute("data-on", on ? "1" : "0");
        btn.setAttribute("aria-pressed", on ? "true" : "false");
        const txt = btn.querySelector(".ap-skill-row-toggle-text");
        if (txt) txt.textContent = this._t("cmp_voice_label");
      }
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
        // System UI · always English (tune dropdown options).
        opts = [
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
        // System UI · always English (intensity dropdown options).
        opts = [
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
      } else if (kind === "delivery") {
        opts = lang === "zh"
          ? [
              { v: "text", label: "Text", hint: "最快的文字会议" },
              { v: "voice", label: "Voice", hint: "口语化 · 逐位播放" },
            ]
          : [
              { v: "text", label: "Text", hint: "fast written meeting" },
              { v: "voice", label: "Voice", hint: "spoken · paced turns" },
            ];
        current = state.deliveryMode === "voice" ? "voice" : "text";
      } else if (kind === "locale") {
        // Interface language picker · routes through the shared
        // .cmp-dd dropdown vocabulary so the User-settings pane
        // doesn't ship a separate two-button toggle. Hints describe
        // what the locale switch affects so the user knows it's the
        // chrome language, not the brief language.
        opts = [
          { v: "en", label: "EN",   hint: "interface in english" },
          { v: "zh", label: "中文", hint: "界面语言切到中文" },
        ];
        current = (window.I18n && window.I18n.getLocale && window.I18n.getLocale()) || "en";
      } else if (kind === "agent-builder-mode") {
        // Build-mode picker · Signal vs Full persona. Same `.cmp-dd`
        // vocabulary as tone/intensity so the agent composer's
        // toolbar reads as one consistent control bar instead of
        // three different button shapes (was: pill toggle above the
        // textarea + manual button + ws toggle).
        //
        // The `info` field is rendered as a per-row ⓘ icon · click
        // opens a floating tooltip explaining the mode in detail.
        // Lets the user understand the tradeoff without inflating
        // the dropdown row's visible hint.
        opts = [
          {
            v: "signal",
            label: "Signal",
            hint: "~10 sec · single-pass spec",
            info: "Quick build · one prompt to the LLM, one optional Brave search, one parsed spec back. Good when you need a director in the room fast and don't need to differentiate them from other directors under heavy debate. Same path as before this feature was added.",
          },
          {
            v: "full",
            label: "Full persona",
            hint: "5–10 min · ReAct + 7-phase build",
            info: "Deep build · seven phases over 5–10 min. (1) Persona spec v1. (2) ReAct knowledge loop · LLM proposes search queries iteratively, reads top results, decides next query (5 rounds max). (3) Spec v2 critique · re-runs the spec with retrieved knowledge folded in. (4) Behavioural rules. (5) Few-shot examples · 3-5 worked input → output pairs that distill voice. (6) Reflection checklist · 5-8 self-check questions injected before every turn. (7) Eval set + build-time differentiation score. Few-shot + checklist get injected into the per-turn director prompt at runtime — that's what keeps voices distinct in multi-agent rooms.",
          },
        ];
        current = this.loadAgentBuilderMode();
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
        // Each row may include an optional ⓘ info button when the
        // option carries an `info` field (currently used by the
        // agent-builder-mode picker · Signal vs Full persona). The
        // info button is a SIBLING of the picker (`.cmp-dd-opt`),
        // not a child · nested buttons are invalid HTML and the
        // delegated `[data-cmp-dd-pick]` handler would fire even
        // when the user clicked the info glyph. Wrapping in
        // `.cmp-dd-row` lets us keep the picker's full-width hover
        // affordance while the info button hugs the right edge.
        rows = opts.map((o) => {
          const infoBtn = o.info ? `
            <button type="button" class="cmp-dd-opt-info" data-cmp-dd-info="${this.escape(o.v)}" data-cmp-dd-info-kind="${this.escape(kind)}" aria-label="What this means" title="What this means">ⓘ</button>
          ` : "";
          return `
            <div class="cmp-dd-row${o.info ? " has-info" : ""}">
              <button type="button" class="cmp-dd-opt${o.v === current ? " active" : ""}" data-cmp-dd-pick="${this.escape(o.v)}" data-cmp-dd-kind="${this.escape(kind)}">
                <span class="cmp-dd-opt-label">${this.escape(o.label)}</span>
                <span class="cmp-dd-opt-hint">${this.escape(o.hint)}</span>
              </button>
              ${infoBtn}
            </div>
          `;
        }).join("");
      }
      // Stash this kind's options on the app instance so the
      // delegated info-icon click handler can look up the row's
      // `info` text without re-deriving it. Keyed by kind so
      // multiple dropdown vocabularies can coexist if ever needed.
      this._cmpDdOpts = this._cmpDdOpts || {};
      this._cmpDdOpts[kind] = opts;
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
        // The info-icon tooltip (`.cmp-dd-info-pop`) lives in
        // document.body so it can escape the dropdown's overflow
        // clipping; without this guard, clicking inside the
        // tooltip would close the dropdown out from under it.
        if (
          !pop.contains(ev.target) &&
          !ev.target.closest("[data-cmp-dropdown]") &&
          !ev.target.closest(".cmp-dd-info-pop")
        ) {
          this.closeComposerDropdown();
        }
      };
      document.addEventListener("keydown", this._cmpDdEsc, true);
      setTimeout(() => document.addEventListener("click", this._cmpDdOutside, true), 0);
    },

    closeComposerDropdown() {
      const el = document.getElementById("cmp-dd-pop");
      if (el) el.remove();
      // The per-row info tooltip is detached from the dropdown
      // popup (lives in document.body for fixed-positioning), so
      // it doesn't get cleaned up by removing #cmp-dd-pop alone.
      this.closeCmpDdInfoPop();
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

    /** Toggle the floating ⓘ tooltip for an option row. Anchored
     *  under the icon, body-attached so it escapes the dropdown
     *  overflow. Clicking the same icon again closes it; clicking
     *  outside the dropdown closes both via the dropdown's own
     *  outside handler. */
    openCmpDdInfoPop(iconBtn, text) {
      this.closeCmpDdInfoPop();
      const pop = document.createElement("div");
      pop.className = "cmp-dd-info-pop";
      pop.id = "cmp-dd-info-pop";
      pop.textContent = text;
      document.body.appendChild(pop);
      const r = iconBtn.getBoundingClientRect();
      const popW = Math.min(320, window.innerWidth - 24);
      let left = r.right - popW;
      if (left < 12) left = 12;
      pop.style.left = left + "px";
      pop.style.top = (r.bottom + 6) + "px";
      pop.style.width = popW + "px";
      this._cmpDdInfoFor = iconBtn;
    },

    closeCmpDdInfoPop() {
      const el = document.getElementById("cmp-dd-info-pop");
      if (el) el.remove();
      this._cmpDdInfoFor = null;
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
      // Unlock audio playback on this user gesture — required by
      // browser autoplay policies before we can play TTS audio later.
      if (state.deliveryMode === "voice") {
        this.unlockAudioPlayback();
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
        alert("Pick at least one director before convening");
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
          deliveryMode: state.deliveryMode,
          autoPick: useAutoPick,
          seedContext: state.seedContext || null,
        });
        // Clear the saved draft now that the room is convened — next
        // visit to "+ New Room" should land on a fresh textarea, not
        // re-show the just-submitted subject. Also drop the attached
        // seedContext — the snippets travelled into the room's
        // opening message; we don't want them piggy-backing on the
        // NEXT room the user opens.
        state.subject = "";
        state.seedContext = null;
        this.saveComposerState();
      } catch (e) {
        if (btn) btn.classList.remove("busy");
        alert("Couldn't convene: " + (e && e.message ? e.message : e));
      }
    },

    /** Fetch the (single) page of topic recommendations · the
     *  server keeps only the latest batch (6 rows), so one
     *  request is the whole story. Idempotent — safe to call
     *  from renderEmptyState() boot AND after a generation job
     *  completes. Sets `topicRecs.loaded` so first-paint can
     *  fall back to legacy hardcoded starters until this
     *  resolves. */
    async refreshTopicRecs() {
      try {
        const r = await fetch("/api/topic-recs?limit=6");
        if (!r.ok) {
          this.topicRecs.loaded = true;
          this.renderEmptyState();
          return;
        }
        const j = await r.json();
        this.topicRecs.items = Array.isArray(j.items) ? j.items : [];
        this.topicRecs.loaded = true;
        // Re-render only when the user is still on the empty
        // (composer) state · openRoom paths have already moved
        // on and an unsolicited re-render would steal focus.
        if (!this.currentRoomId) this.renderEmptyState();
      } catch { /* network error · keep stale list, surface nothing */ }
    },

    /** Derive a short tag from a subject string · used as the
     *  client-side fallback when a rec row has no `tag` field
     *  (legacy rows from before migration 035, or the rare
     *  case where the LLM forgot to include one and the
     *  orchestrator's safety-net path also fired). Mirrors the
     *  orchestrator's `deriveTagFromSubject` logic so the
     *  vocabulary stays consistent across paths. */
    _deriveTagFromSubject(subject) {
      const STOP = new Set([
        "the", "and", "for", "are", "you", "your", "what", "how",
        "why", "when", "with", "from", "this", "that", "should",
        "could", "would", "have", "has", "will", "into", "about",
      ]);
      const words = (subject || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w));
      return words.slice(0, 2).join(" ").slice(0, 28) || "topic";
    },

    /** Build the HTML for a single topic-rec card. Used both by
     *  `renderComposerHtml` (initial render) and `loadMoreTopicRecs`
     *  (in-place append). Keeping the markup in one helper means
     *  the two paths can't drift in shape or attributes. */
    topicRecCardHtml(rec) {
      // Tag priority: synthesiser-produced category > derive
      // from subject. We NEVER fall back to "web" / "memory"
      // as the visible tag — those are data-provenance tokens,
      // not topic categories. The `data-source` attribute still
      // carries the provenance for CSS to colour-tint with.
      const tag = (typeof rec.tag === "string" && rec.tag.trim().length > 0)
        ? rec.tag
        : this._deriveTagFromSubject(rec.subject);
      const hint = rec.rationale || "";
      return `
        <button type="button" class="cmp-starter cmp-rec" data-cmp-rec="${this.escape(rec.id)}" data-source="${this.escape(rec.source)}">
          <div class="cmp-starter-tag">${this.escape(tag)}</div>
          <div class="cmp-starter-text">${this.escape(rec.subject || "")}</div>
          ${hint ? `<div class="cmp-rec-hint">${this.escape(hint)}</div>` : ""}
          <div class="cmp-starter-arrow">→</div>
        </button>
      `;
    },

    // (no `loadMoreTopicRecs` — see comments at the
    //  pagination-removed render block above.)

    /** Kick off a new topic-recommendation generation job and
     *  attach an SSE stream so the composer's progress strip
     *  ticks through phases live. On `topic-final` we refresh
     *  the tray from the API; on error we surface the message
     *  inline so the user understands why nothing landed. */
    async startTopicRecJob() {
      if (this.topicRecs.job) return; // already running · idempotent click
      // Pre-flight · API gate requires a model key. Surface the
      // same prompt as Convene so the user fixes it once.
      if (!(await this.requireModelKey())) return;
      try {
        const r = await fetch("/api/topic-recs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          alert("Couldn't start: " + (j.error || r.statusText));
          return;
        }
        const { jobId } = await r.json();
        this.topicRecs.job = {
          id: jobId,
          phase: 0,
          label: "starting…",
          pct: 0,
          detail: "",
          es: null,
          error: null,
        };
        if (!this.currentRoomId) this.renderEmptyState();
        this._attachTopicRecJobSSE(jobId);
      } catch (e) {
        alert("Couldn't start: " + (e && e.message ? e.message : e));
      }
    },

    /** Internal · attach the EventSource for a running job and
     *  wire each event type to the in-memory job state. */
    _attachTopicRecJobSSE(jobId) {
      const url = `/api/topic-recs/jobs/${encodeURIComponent(jobId)}/stream`;
      const es = new EventSource(url);
      this.topicRecs.job.es = es;
      const updateStrip = () => {
        const el = document.querySelector("[data-topic-rec-progress]");
        if (!el || !this.topicRecs.job) return;
        const j = this.topicRecs.job;
        const labelEl = el.querySelector("[data-trec-label]");
        if (labelEl) labelEl.textContent = j.label || "";
        const detailEl = el.querySelector("[data-trec-detail]");
        if (detailEl) detailEl.textContent = j.detail || "";
        const pctEl = el.querySelector("[data-trec-pct]");
        if (pctEl) pctEl.textContent = j.pct ? `${j.pct}%` : "·";
        const bar = el.querySelector("[data-trec-bar]");
        if (bar) bar.style.width = `${j.pct || 0}%`;
      };
      const terminate = () => {
        try { es.close(); } catch { /* noop */ }
        this.topicRecs.job = null;
        if (!this.currentRoomId) this.renderEmptyState();
      };
      es.addEventListener("hello", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (this.topicRecs.job) {
            this.topicRecs.job.phase = data.currentPhase || 0;
            this.topicRecs.job.pct = data.progressPct || 0;
          }
          updateStrip();
        } catch { /* noop */ }
      });
      es.addEventListener("topic-phase-start", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (this.topicRecs.job) {
            this.topicRecs.job.phase = data.phase;
            this.topicRecs.job.label = data.label;
            this.topicRecs.job.detail = "";
          }
          updateStrip();
        } catch { /* noop */ }
      });
      es.addEventListener("topic-phase-progress", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (this.topicRecs.job) {
            this.topicRecs.job.phase = data.phase;
            this.topicRecs.job.detail = data.detail || "";
            this.topicRecs.job.pct = data.progressPct || this.topicRecs.job.pct;
          }
          updateStrip();
        } catch { /* noop */ }
      });
      es.addEventListener("topic-phase-end", (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (this.topicRecs.job) {
            this.topicRecs.job.pct = data.progressPct || this.topicRecs.job.pct;
          }
          updateStrip();
        } catch { /* noop */ }
      });
      es.addEventListener("topic-final", () => {
        // Pull the freshest first page so the new cards land
        // immediately; closing the EventSource is on the same
        // tick so the next click doesn't see a stale job.
        terminate();
        void this.refreshTopicRecs();
      });
      es.addEventListener("topic-error", (ev) => {
        let msg = "generation failed";
        try { msg = (JSON.parse(ev.data).message) || msg; } catch { /* noop */ }
        alert("Topic generation failed: " + msg);
        terminate();
      });
      es.addEventListener("topic-aborted", () => {
        terminate();
      });
      es.onerror = () => {
        // Transport hiccup · treat as terminal so the UI doesn't
        // stay stuck on a phantom progress strip.
        if (this.topicRecs.job) terminate();
      };
    },

    /** Click handler on a recommendation card · fetches the
     *  full row (to recover seedContext) then applies it to the
     *  composer state so the next Convene carries the snippets
     *  through to the opening message's meta. */
    async applyTopicRec(id) {
      if (!id) return;
      try {
        const r = await fetch(`/api/topic-recs/${encodeURIComponent(id)}`);
        if (!r.ok) return;
        const row = await r.json();
        if (!row || typeof row.subject !== "string") return;
        const state = this.loadComposerState();
        state.subject = row.subject;
        state.seedContext = {
          topicRecId: row.id,
          // Rationale is the "why this fits you" line the
          // synthesiser produced · it's hidden from the card
          // UI but forwarded as background context so the
          // chair's clarify prompt can ground its first turn
          // in the same reasoning the recommendation was
          // built on.
          rationale: typeof row.rationale === "string" ? row.rationale : "",
          snippets: Array.isArray(row.seedContext) ? row.seedContext : [],
        };
        this.saveComposerState();
        this.renderEmptyState();
        setTimeout(() => {
          const ta = document.querySelector("[data-composer-subject]");
          if (ta) {
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
            this.autosizeComposerTextarea?.();
          }
        }, 50);
      } catch { /* noop */ }
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

    /** Tone hover copy · i18n keyed by mode, falls back to TONE_TIPS. */
    toneTipFor(mode) {
      const m = mode || "";
      const k = "tone_tip_" + m;
      const tr = this._t(k);
      if (tr !== k) return tr;
      return TONE_TIPS[m] || "";
    },

    /** Truncate the room-header subject to N code points + ellipsis ·
     *  the full subject still rides in the `title` attribute for
     *  hover. `Array.from` counts user-perceived characters (CJK is
     *  one apiece, surrogate-pair emoji collapses to one) so the
     *  cap reads consistently across English and Chinese sessions. */
    _truncateRoomSubject(s, max) {
      const txt = String(s == null ? "" : s);
      const chars = Array.from(txt);
      if (chars.length <= max) return txt;
      return chars.slice(0, max).join("") + "…";
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
      const castTitle =
        castCount <= 1
          ? this._t("room_cast_title_1")
          : this._t("room_cast_n", { n: castCount });
      const castHtml = castImgs +
        (castCount > 0
          ? `<span class="cast-count" title="${this.escape(castTitle)}">${castCount}</span>`
          : "");

      const tone = r.mode || "constructive";
      const intensity = r.intensity || "sharp";
      const briefStyle =
        typeof r.briefStyle === "string" && r.briefStyle.trim()
          ? r.briefStyle.trim()
          : "auto";

      // Status timestamp — what was on the right (paused-stamp / stamp) now
      // lives inline in the meta row.
      let stamp = "";
      if (r.status === "paused" && r.pausedAt) {
        stamp = this._t("room_stamp_paused", { ago: this.relTime(r.pausedAt) });
      } else if (r.status === "adjourned" && r.adjournedAt) {
        stamp = this._t("room_stamp_adjourned", { ago: this.relTime(r.adjournedAt) });
      } else if (r.status === "live" && r.createdAt) {
        stamp = this._t("room_stamp_opened", { ago: this.relTime(r.createdAt) });
      }
      const toneTip = this.toneTipFor(tone);

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
      //
      // Compact two-row layout: kicker (mono, all the meta) + subject.
      // Replaces the prior three-row stack (badge+id / subject /
      // tagged-meta-pills) — net height reduction ~150 → ~85px.
      // Tone / intensity / brief-style remain editable in the room
      // settings overlay; only their on-header surface is collapsed.
      // Compact two-row layout · kicker carries all the meta (room
      // number / tone / intensity / status) on a single mono line
      // above the subject. Replaces the prior three-row stack of
      // `.room-id` + subject + `.room-meta` tagged pills which the
      // CSS in index.html no longer styles. Tone / intensity stay
      // editable in the room-settings overlay.
      // System chrome is English-only per the project rule (only
      // user / LLM content follows query language), so the kicker
      // tokens are not routed through `_t()`.
      const statusWord = r.status !== "live" ? String(r.status).toUpperCase() : "";
      head.innerHTML = `
        <button type="button" class="room-head-expand" data-sidebar-expand title="${this.escape(this._t("sidebar_expand"))}" aria-label="${this.escape(this._t("sidebar_expand"))}"></button>
        <div class="room-info">
          <div class="room-kicker">
            <span class="kicker-num">// ROOM #${r.number}</span>
            <span class="kicker-sep">·</span>
            <span class="kicker-tone" data-tone-tip="${this.escape(toneTip)}">${this.escape(tone.toUpperCase())}</span>
            <span class="kicker-sep">·</span>
            <span class="kicker-intensity">${this.escape(intensity.toUpperCase())}</span>
            ${statusWord ? `<span class="kicker-sep">·</span><span class="kicker-status status-${this.escape(r.status)}">${statusWord}</span>` : ""}
          </div>
          <h1 class="room-subject" title="${this.escape(r.subject)}">${this.escape(this._truncateRoomSubject(r.subject, 30))}</h1>
        </div>
        <div class="head-actions">
          <div class="head-cast">${castHtml}</div>
          <a href="#" class="room-settings-trigger" data-room-settings-trigger title="${this.escape(this._t("room_settings"))}" aria-label="${this.escape(this._t("room_settings"))}">⚙</a>
          <a href="#" class="pause-btn" data-pause>[ <span class="pause-icon">❚❚</span> ${this.escape(this._t("room_pause_verb"))} ]</a>
          <a href="#" class="resume-btn" data-resume>[ ▶ ${this.escape(this._t("room_resume_verb"))} ]</a>
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
                const directHref = this.briefViewerHref(this.currentBrief, r.id) || `/report.html?r=${this.escape(r.id)}`;
                if (!multi) {
                  return `<a href="${directHref}" target="_blank" rel="noopener" class="view-report-btn" data-view-report>${this.escape(this._t("room_view_report"))}</a>`;
                }
                return `<a href="${directHref}" target="_blank" rel="noopener" class="view-report-btn" data-view-report data-view-report-trigger title="${this.escape(this._t("room_view_report_title_multi", { n: briefs.length }))}">${this.escape(this._t("room_view_report_multi", { n: briefs.length }))}</a>`;
              })()
            : (r.status === "adjourned"
              ? `<a href="#" class="view-report-btn generate-report" data-generate-brief title="${this.escape(this._t("room_generate_report_title"))}"><span class="vr-mark">▸</span> ${this.escape(this._t("room_generate_report"))}</a>`              : "")}
        </div>
      `;
      // Wire the tone-tag hover tip. Pure-CSS ::after tooltips were
      // attempted twice and lose the battle with the chat panel's
      // overflow:hidden chain (.main / .main-view both clip absolutely-
      // positioned descendants and CAN'T be relaxed without breaking
      // chat scroll). Body-attached fixed-position tooltip is the only
      // reliable approach. Anchor moved from the old .meta-tag pill to
      // .kicker-tone in the compact two-row header.
      const toneTag = head.querySelector(".kicker-tone[data-tone-tip]");
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
      // Strip the composer-centring class · real chat messages take
      // over `[data-chat-messages]` here, and chat-message mode wants
      // the default top-flow scroll (messages stack from the top).
      const chatScroller = chat.closest(".chat");
      if (chatScroller) {
        chatScroller.classList.remove("chat--composer");
        chatScroller.classList.remove("chat--composer-overflow");
      }
      const messages = this.currentMessages.slice();
      const r = this.currentRoom;
      const tBanner = this._t("chat_banner", {
        when: new Date(r.createdAt).toLocaleString(),
        n: this.currentMembers.length,
        mode: this.escape(r.mode),
      });
      const banner = r
        ? `<div class="chat-banner"><span class="chat-banner-chip"><span class="cb-mark">▸</span><span class="cb-text">${this.escape(tBanner)}</span></span></div>`
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
      // System UI · always English. Convening overlay (analyzing /
      // seating / preparing labels + decks) is app chrome.
      // Stages · auto-picked rooms run all three; manually-cast rooms
      // skip "analyzing" + "seating" because the cast is pre-set.
      const stageOrder = s.autoPicked
        ? ["analyzing", "seating", "preparing"]
        : ["preparing"];
      const STAGE_LABELS = {
        analyzing: {
          title: this._t("conv_stage_analyzing_title"),
          deck: this._t("conv_stage_analyzing_deck"),
        },
        seating: {
          title: this._t("conv_stage_seating_title"),
          deck: this._t("conv_stage_seating_deck"),
        },
        preparing: {
          title: this._t("conv_stage_preparing_title"),
          deck: this._t("conv_stage_preparing_deck"),
        },
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
          <div class="conv-seated-label">${this.escape(this._t("conv_seated_label"))} · ${s.seated.length}</div>          <div class="conv-seated-list">
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
          <div class="conv-eyebrow">${this.escape(this._t("conv_banner_convening"))}</div>          ${s.subject ? `<blockquote class="conv-subject">${this.escape(s.subject)}</blockquote>` : ""}
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
      // Round-table stage flag · drives a "thinking" bubble on the
      // chair seat during the silent prep phase (tools + LLM
      // startup). Without this the round-table view shows nothing
      // between user-input and the chair's first token, leaving the
      // user wondering what's happening. Mirrors the chat surface's
      // chair-pending placeholder card (which is hidden in voice mode
      // because the chat is hidden).
      this.chairPending = true;
      // Repaint the stage so the seat picks up the thinking state.
      // Cheap when stage is hidden (renderRoundTable bails fast).
      this.renderRoundTable();
      const chat = document.querySelector("[data-chat-messages]");
      if (!chat) return;
      const existing = chat.querySelector("[data-chair-pending]");
      const chairName = (this.currentChair?.name) || this._t("msg_chair_display_fallback");
      const phaseKeys = {
        clarify: "chair_pend_clarify",
        "chair-direct": "chair_pend_chair_direct",
        "round-end": "chair_pend_round_end",
        convening: "chair_pend_convening",
        "next-speaker": "chair_pend_next_speaker",
      };
      const pendKey = phaseKeys[phase] || "chair_pend_default";
      const phrase = this._t(pendKey, { name: chairName });
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
        <div class="cp-kicker">${this.escape(this._t("chair_pend_banner"))}</div>
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
      // Drop the round-table flag too · without this, the chair seat
      // would keep its "thinking" bubble after the real chair message
      // arrives (or after the chair released directors via clarify-
      // ready / room-paused / etc).
      const wasPending = this.chairPending === true;
      this.chairPending = false;
      const chat = document.querySelector("[data-chat-messages]");
      if (chat) {
        const existing = chat.querySelector("[data-chair-pending]");
        if (existing) existing.remove();
      }
      // Repaint only when the flag actually flipped · skip the
      // wasted re-render when hideChairPending is called pre-emptively
      // and there was nothing to clear.
      if (wasPending) this.renderRoundTable();
    },

    enqueueVoiceChunk(roomId, chunk) {
      if (!chunk || !chunk.messageId || !chunk.audioBase64 || !chunk.mimeType) return;
      let q = this.voiceQueues[chunk.messageId];
      if (!q) {
        // Serialize voice playback · only one TTS clip plays at a
        // time. When a new voice-chunk arrives for a NEW messageId,
        // tear down any currently-active voice queues so their audio
        // doesn't overlap the incoming chair / director's speech.
        // The most common overlap pattern was: round-prompt voice
        // still playing → user clicks [Open vote] → server fires
        // runChairRoundEnd → new voice chunks arrive → both audios
        // double up. Cancelling stale queues at this seam serializes
        // the voice timeline cleanly without changing the SSE shape.
        const stale = Object.keys(this.voiceQueues || {});
        for (const sid of stale) {
          if (sid === chunk.messageId) continue;
          const sq = this.voiceQueues[sid];
          if (!sq) continue;
          try { if (sq.audio) sq.audio.pause(); } catch (_) {}
          try { if (sq.audio && sq.audio.src) URL.revokeObjectURL(sq.audio.src); } catch (_) {}
          try {
            if (sq.mediaSource && sq.mediaSource.readyState === "open") {
              sq.mediaSource.endOfStream();
            }
          } catch (_) {}
          delete this.voiceQueues[sid];
        }
        q = this._createVoiceStream(roomId, chunk.messageId);
        this.voiceQueues[chunk.messageId] = q;
      }
      // Convert base64 to Uint8Array and append to the MSE SourceBuffer
      const binary = atob(chunk.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      q.pendingBuffers.push(bytes);
      // Caption sync · capture the EXACT text for this audio chunk and
      // its byte-length. The subtitle renderer maps `audio.currentTime`
      // to a chunk index using cumulative byte offsets (constant-
      // bitrate MP3, so byte-position ≈ time-position) and shows that
      // chunk's text. Without this we'd fall back to the body-string
      // fraction heuristic, which mis-matches whenever TTS pacing is
      // non-uniform across the message.
      if (!q.captions) q.captions = [];
      q.captions.push({
        text: typeof chunk.text === "string" ? chunk.text : "",
        bytes: bytes.length,
        // Filled in by the SourceBuffer's `updateend` handler once
        // this chunk's bytes have been parsed into the audio
        // timeline. `endTime` is the absolute playback time (in s)
        // at which this chunk finishes; subtitle sync compares
        // audio.currentTime against this to pick which chunk's
        // text to display.
        endTime: null,
      });
      this._flushVoiceBuffer(q);
    },

    /** Voice playback-rate presets · 5 discrete steps cycled by the
     *  HUD's RATE button. Browsers (Chrome / Firefox / Safari) all
     *  preserve pitch on HTMLAudioElement at these multipliers, so
     *  speech intelligibility holds at 0.75× and 2×. Keep the list
     *  in ascending order; cycleVoicePlaybackRate() relies on it. */
    VOICE_RATE_PRESETS: [0.75, 1.0, 1.25, 1.5, 2.0],

    /** Lazy getter · returns the user's stored playback rate or
     *  defaults to 1.0× on first access. localStorage failures
     *  (private mode, quota) silently fall back to in-memory state. */
    voicePlaybackRate() {
      if (this._voicePlaybackRate != null) return this._voicePlaybackRate;
      let v = 1.0;
      try {
        const raw = localStorage.getItem("pb.voiceRate");
        if (raw != null) {
          const n = parseFloat(raw);
          if (isFinite(n) && this.VOICE_RATE_PRESETS.includes(n)) v = n;
        }
      } catch (_) { /* private mode → fall through */ }
      this._voicePlaybackRate = v;
      return v;
    },

    /** Lazy getter · returns whether the round-table HUD is collapsed.
     *  Defaults to false (expanded) on first access; reads
     *  localStorage so the user's last choice persists across reloads
     *  / room reopens. localStorage failures fall back to in-memory. */
    hudCollapsed() {
      if (this._hudCollapsed != null) return this._hudCollapsed;
      let v = false;
      try {
        v = localStorage.getItem("pb.hudCollapsed") === "1";
      } catch (_) { /* private mode → fall through */ }
      this._hudCollapsed = v;
      return v;
    },

    /** Flip the HUD collapsed state · persists to localStorage and
     *  re-renders the HUD so the `is-collapsed` class flips
     *  immediately. Called from the `−` / `+` toggle button click
     *  handler. */
    toggleHudCollapsed() {
      const next = !this.hudCollapsed();
      this._hudCollapsed = next;
      try { localStorage.setItem("pb.hudCollapsed", next ? "1" : "0"); } catch (_) {}
      this.renderRoundTableHud();
    },

    /** Show / replace the user's speech bubble in the round-table.
     *  Each call rewrites `text` and resets the 10s `deadline`; if a
     *  prior interval is still ticking we reuse it (it reads the
     *  fresh deadline). Skipped when the room is adjourned (no new
     *  user speech is possible there). Modeled on the existing
     *  `continueCountdown` 1Hz tick pattern. */
    USER_BUBBLE_TTL_MS: 10000,
    showUserBubble(text) {
      const trimmed = String(text || "").trim();
      if (!trimmed) return;
      // Adjourned rooms · the seat persists from history but new
      // bubbles are noise (sending is gated elsewhere; this is a
      // belt-and-braces check).
      if (this.currentRoom && this.currentRoom.status === "adjourned") return;
      this.userBubble.text = trimmed;
      this.userBubble.deadline = Date.now() + this.USER_BUBBLE_TTL_MS;
      this.userBubble.dismissed = false;
      if (!this.userBubble.intervalId) {
        this.userBubble.intervalId = setInterval(() => this.tickUserBubble(), 1000);
      }
      this.renderRoundTable();
    },

    /** 1Hz tick · surgically updates the bubble's progress CSS
     *  variable (which drives the conic-gradient border ring) and
     *  auto-dismisses when the deadline elapses. Does NOT call
     *  `renderRoundTable()` — re-rendering the full seat list
     *  would rebuild the bubble DOM, kicking visible flicker.
     *  Surgical update is a no-op when the stage isn't mounted
     *  (chat view); the deadline still ticks down so the bubble
     *  auto-dismisses correctly even while hidden. */
    tickUserBubble() {
      if (this.userBubble.dismissed) return;
      const now = Date.now();
      if (now >= this.userBubble.deadline) {
        this.dismissUserBubble();
        return;
      }
      const bubbleEl = document.querySelector("[data-rt-user-bubble]");
      if (bubbleEl) {
        const elapsed = this.USER_BUBBLE_TTL_MS - (this.userBubble.deadline - now);
        const progress = Math.min(1, Math.max(0, elapsed / this.USER_BUBBLE_TTL_MS));
        bubbleEl.style.setProperty("--rt-bubble-user-progress", progress.toFixed(3));
      }
    },

    /** Dismiss the bubble · clears the interval and marks dismissed.
     *  The user seat itself stays. Re-renders once so the bubble
     *  vanishes immediately. Safe to call even when no bubble is
     *  active (idempotent). */
    dismissUserBubble() {
      if (this.userBubble.intervalId) {
        clearInterval(this.userBubble.intervalId);
        this.userBubble.intervalId = null;
      }
      this.userBubble.dismissed = true;
      this.userBubble.text = "";
      this.userBubble.deadline = 0;
      this.renderRoundTable();
    },

    /** Chair clarify bubble · parallel surface to the user bubble.
     *  Pins the chair's clarifying question to the chair seat with a
     *  10s border countdown (same conic-gradient mechanic as the
     *  user bubble). Voice-mode only · in text mode the question
     *  appears as a normal chat bubble and the user can read it
     *  inline. Calling again before timeout REPLACES the text and
     *  resets the deadline. */
    CHAIR_BUBBLE_TTL_MS: 10000,
    showChairBubble(text) {
      const trimmed = String(text || "").trim();
      if (!trimmed) return;
      if (this.currentRoom && this.currentRoom.status === "adjourned") return;
      this.chairBubble.text = trimmed;
      this.chairBubble.deadline = Date.now() + this.CHAIR_BUBBLE_TTL_MS;
      this.chairBubble.dismissed = false;
      if (!this.chairBubble.intervalId) {
        this.chairBubble.intervalId = setInterval(() => this.tickChairBubble(), 1000);
      }
      this.renderRoundTable();
    },

    /** 1Hz tick · surgical update of the border-progress CSS var.
     *  Mirrors tickUserBubble exactly · see that method for the
     *  full reasoning around surgical-vs-full rerender. */
    tickChairBubble() {
      if (this.chairBubble.dismissed) return;
      const now = Date.now();
      if (now >= this.chairBubble.deadline) {
        this.dismissChairBubble();
        return;
      }
      const bubbleEl = document.querySelector("[data-rt-chair-bubble]");
      if (bubbleEl) {
        const elapsed = this.CHAIR_BUBBLE_TTL_MS - (this.chairBubble.deadline - now);
        const progress = Math.min(1, Math.max(0, elapsed / this.CHAIR_BUBBLE_TTL_MS));
        bubbleEl.style.setProperty("--rt-bubble-chair-progress", progress.toFixed(3));
      }
    },

    dismissChairBubble() {
      if (this.chairBubble.intervalId) {
        clearInterval(this.chairBubble.intervalId);
        this.chairBubble.intervalId = null;
      }
      this.chairBubble.dismissed = true;
      this.chairBubble.text = "";
      this.chairBubble.deadline = 0;
      this.renderRoundTable();
    },

    /** Cycle to the next preset rate · wraps around at the top.
     *  Persists to localStorage and applies the new rate to every
     *  audio element currently playing in `voiceQueues`. The HUD
     *  re-renders to reflect the new value. Called from the HUD's
     *  RATE button click handler. */
    cycleVoicePlaybackRate() {
      const presets = this.VOICE_RATE_PRESETS;
      const cur = this.voicePlaybackRate();
      const idx = presets.indexOf(cur);
      const next = presets[(idx + 1) % presets.length];
      this._voicePlaybackRate = next;
      try { localStorage.setItem("pb.voiceRate", String(next)); } catch (_) {}
      // Apply to any already-mounted audio so the user hears the
      // change mid-turn rather than at the next speaker boundary.
      // Set BOTH `defaultPlaybackRate` and `playbackRate` since some
      // browsers' MSE implementations honour one but not the other,
      // and dump diagnostic state to console so the user can verify
      // the rate is reaching the live audio element.
      const queueKeys = Object.keys(this.voiceQueues || {});
      console.log(`[voice-rate] cycle → ${next}× · queues=${queueKeys.length}`);
      for (const messageId of queueKeys) {
        const q = this.voiceQueues[messageId];
        if (q && q.audio) {
          const before = q.audio.playbackRate;
          try { q.audio.defaultPlaybackRate = next; } catch (_) {}
          try { q.audio.playbackRate = next; } catch (_) {}
          const after = q.audio.playbackRate;
          console.log(`[voice-rate] msg=${messageId} ${before}× → ${after}× (paused=${q.audio.paused}, currentTime=${q.audio.currentTime.toFixed(2)})`);
        }
      }
      this.renderRoundTableHud();
    },

    /** Create a MediaSource-backed audio stream for one speaker's turn. */
    _createVoiceStream(roomId, messageId) {
      const audio = new Audio();
      // Read the rate fresh every call so the LATEST cached value
      // wins · the user may have cycled rate between chunks and we
      // want each application point to pick that up. Browsers
      // honour `playbackRate` with pitch correction by default, so
      // 0.75× / 2× still sound like the same voice.
      const applyRate = (label) => {
        const wanted = this.voicePlaybackRate();
        try { audio.defaultPlaybackRate = wanted; } catch (_) {}
        try { audio.playbackRate = wanted; } catch (_) {}
        if (label) {
          console.log(`[voice-rate] _createVoiceStream apply (${label}) msg=${messageId} → ${audio.playbackRate}× (wanted ${wanted}×)`);
        }
      };
      // Apply BEFORE src · honoured by some browsers as the initial
      // rate when the audio starts playing.
      applyRate("before-src");
      const ms = new MediaSource();
      audio.src = URL.createObjectURL(ms);
      // Apply AFTER src · the load triggered by attaching the
      // MediaSource can silently reset playbackRate to 1.0 in
      // Chrome / Safari, which was the bug that made the cycle
      // button only stick on whoever was speaking at click time.
      applyRate("after-src");
      // Re-apply on every lifecycle event that can reset the rate
      // mid-load. Each listener reads `voicePlaybackRate()` LIVE
      // so the latest cached value wins.
      audio.addEventListener("loadedmetadata", () => applyRate("loadedmetadata"));
      audio.addEventListener("canplay",        () => applyRate("canplay"));
      audio.addEventListener("play",           () => applyRate("play"));
      // Detect external resets · if the browser ever changes our
      // rate without us asking, log it so we can see exactly when
      // the silent reset happens.
      audio.addEventListener("ratechange", () => {
        const wanted = this.voicePlaybackRate();
        if (Math.abs(audio.playbackRate - wanted) > 0.001) {
          console.warn(`[voice-rate] external rate reset! msg=${messageId} now=${audio.playbackRate}× wanted=${wanted}× · re-applying`);
          try { audio.playbackRate = wanted; } catch (_) {}
        }
      });

      // Subtitle audio-sync · `timeupdate` fires ~4 Hz natively so
      // we can drive the subtitle's body-slice scroll cheaply
      // without a separate rAF loop. Without this, the caption
      // stops updating the moment the LLM stream finishes — even
      // though audio keeps playing for tens of seconds — because
      // body is final and message-token no longer fires. This
      // hook re-runs renderRtSubtitle so its progress-aware slice
      // (`body.slice(0, body.length * audio.currentTime/duration)`)
      // walks the caption forward in step with audio playback.
      // Also re-asserts the playback rate as a safety net · if any
      // browser internal pathway resets the rate during playback,
      // the next timeupdate (within ~250 ms) corrects it. This is
      // the bulletproof guarantee that the user's chosen rate
      // governs every director's audio globally, not just the one
      // mid-turn when they click. */
      audio.addEventListener("timeupdate", () => {
        this.renderRtSubtitle();
        // Re-assert without logging · fires ~4 Hz, would spam.
        applyRate();
      });

      const q = {
        roomId,
        messageId,
        audio,
        mediaSource: ms,
        sourceBuffer: null,
        pendingBuffers: [],
        final: false,
        doneSent: false,
        ready: false,
        // Caption timing · the index of the caption whose audio bytes
        // are currently being appended to the SourceBuffer. After
        // `updateend` we record `buffered.end(0)` as that caption's
        // endTime — the exact playback time at which its audio
        // finishes. Reading audio.currentTime against these ranges
        // gives accurate per-chunk caption sync (no CBR assumption).
        flushingIdx: -1,
      };

      ms.addEventListener("sourceopen", () => {
        try {
          q.sourceBuffer = ms.addSourceBuffer("audio/mpeg");
          q.sourceBuffer.addEventListener("updateend", () => {
            // Capture the playback-time range that was just appended
            // and assign it to the caption matching the appended
            // chunk. q.flushingIdx points at the chunk we just sent
            // through appendBuffer (set in _flushVoiceBuffer below).
            try {
              if (q.captions && q.flushingIdx >= 0 && q.captions[q.flushingIdx]) {
                if (q.sourceBuffer.buffered.length > 0) {
                  q.captions[q.flushingIdx].endTime = q.sourceBuffer.buffered.end(0);
                }
              }
            } catch (_) { /* buffered.end can throw mid-update · safe to ignore */ }
            this._flushVoiceBuffer(q);
          });
          q.ready = true;
          this._flushVoiceBuffer(q);
        } catch (e) {
          console.warn("[voice] addSourceBuffer failed:", e);
        }
      });

      // Start playing as soon as we have some data
      audio.play().catch(() => {});

      return q;
    },

    /** Flush pending buffers into the SourceBuffer one at a time. */
    _flushVoiceBuffer(q) {
      if (!q.ready || !q.sourceBuffer || q.sourceBuffer.updating) return;
      if (q.pendingBuffers.length > 0) {
        const buf = q.pendingBuffers.shift();
        // Track which caption the about-to-append buffer belongs to.
        // captions[] grows in step with pendingBuffers[] (both pushed
        // in enqueueVoiceChunk in lockstep), so the n-th appendBuffer
        // call corresponds to captions[n-1]. flushingIdx starts at -1
        // and increments to 0, 1, 2, ... as we drain. The updateend
        // listener reads this to record buffered.end() into the
        // matching caption's endTime.
        q.flushingIdx = (q.flushingIdx + 1);
        try {
          q.sourceBuffer.appendBuffer(buf);
        } catch (e) {
          console.warn("[voice] appendBuffer failed:", e);
        }
        return;
      }
      // No more pending buffers. If final, signal end of stream.
      if (q.final && !q.doneSent) {
        q.doneSent = true;
        try {
          if (q.mediaSource.readyState === "open") {
            q.mediaSource.endOfStream();
          }
        } catch (_) {}
        // Wait for audio to finish playing, then fire voice-done
        q.audio.addEventListener("ended", () => this._fireVoiceDone(q));
        // Safety timeout in case 'ended' doesn't fire (e.g. empty stream)
        const duration = q.audio.duration;
        const remaining = isFinite(duration) ? (duration - q.audio.currentTime) : 0;
        setTimeout(() => {
          if (!this.voiceQueues[q.messageId]) return; // already fired
          this._fireVoiceDone(q);
        }, (remaining * 1000) + 2000);
      }
    },

    _scheduleVoiceDone(q) {
      // Called from voice-final handler — trigger flush check which will
      // endOfStream + wait for playback to finish.
      this._flushVoiceBuffer(q);
    },

    _fireVoiceDone(q) {
      if (!this.voiceQueues[q.messageId]) return; // already fired
      delete this.voiceQueues[q.messageId];
      // Clean up audio element
      try { q.audio.pause(); } catch (_) {}
      try { URL.revokeObjectURL(q.audio.src); } catch (_) {}
      fetch(`/api/rooms/${encodeURIComponent(q.roomId)}/messages/${encodeURIComponent(q.messageId)}/voice-done`, {
        method: "POST",
      }).catch(() => {});
      // Round-table stage · audio just finished playing for this
      // message · repaint so the bubble drops off the speaking
      // seat (catches the chair templated-announce path where
      // meta.streaming was never set, so message-final alone
      // wouldn't trigger a repaint via the streaming check).
      this.renderRoundTable();
      // Subtitle · voice playback ended. If nobody else is mid-
      // stream / queued the panel hides itself.
      this.renderRtSubtitle();
      // Auto-continue countdown · canAutoContinue refuses to spin
      // up the timer while the chair's voice queue is still active,
      // so the round-prompt's ~5-10s read-aloud doesn't eat into
      // the user's 10s decision window. Now that playback is done,
      // re-evaluate and start the countdown if conditions are met.
      this.maybeStartContinueCountdown();
    },

    async drainVoiceQueue(roomId, messageId) {
      // Called from voice-final handler — mark final and flush
      const q = this.voiceQueues[messageId];
      if (!q) return;
      if (q.final && !q.doneSent) {
        this._flushVoiceBuffer(q);
      }
    },

    /** Immediately stop all voice playback and discard pending queues.
     *  Used on hard-pause to silence mid-stream audio. */
    stopVoicePlayback() {
      for (const messageId of Object.keys(this.voiceQueues)) {
        const q = this.voiceQueues[messageId];
        if (q && q.audio) {
          try { q.audio.pause(); } catch (_) {}
          try { URL.revokeObjectURL(q.audio.src); } catch (_) {}
        }
      }
      this.voiceQueues = {};
      this._voiceCurrentMessageId = null;
    },

    /** Unlock HTMLAudioElement autoplay policy.
     *  Must be called inside a user-gesture handler (click/keydown). */
    unlockAudioPlayback() {
      if (this._audioUnlocked) return;
      try {
        // Play a silent audio to satisfy autoplay policy
        const silence = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=");
        silence.volume = 0;
        const p = silence.play();
        if (p) p.then(() => silence.pause()).catch(() => {});
        this._audioUnlocked = true;
        console.log("[voice] audio playback unlocked via user gesture");
      } catch (e) {
        console.warn("[voice] unlock failed:", e);
      }
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
          ? `<span class="rp-spent-round">${this.escape(this._t("rp_spent_round", { n }))}</span><span class="rp-spent-sep">·</span>`
          : "";
        return `
          <div class="round-prompt-card spent" data-round-prompt-card="${this.escape(messageId)}">
            <span class="rp-spent-chip">
              <span class="rp-spent-mark">◇</span>
              ${prefix}
              <span class="rp-spent-label">${this.escape(this._t("rp_spent_label"))}</span>
            </span>
          </div>
        `;
      }
      // Adjourned-room guard · the spent path above suppresses the
      // chip when the room is adjourned, but `isRoundPromptSpent`
      // can return FALSE for a chair-prompt that's the literal last
      // message of a room that got adjourned without a subsequent
      // chair / user message. Without this guard the card renders
      // its End/Continue buttons on top of an adjourned room — the
      // user clicks Continue (UI hangs · server rejects state
      // change) or End (toast: "room is not live"). Hide the card
      // entirely; the room header + brief / no-brief markers
      // already convey the terminal state.
      if (this.currentRoom && this.currentRoom.status === "adjourned") {
        return "";
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
      const recIndicator = recKind
        ? `
          <div class="rp-rec-line rp-rec-line-${this.escape(recKind)}">
            <span class="rp-rec-arrow" aria-hidden="true">↑</span>
            <span class="rp-rec-text">${this.escape(this._t("rp_chair_recommends"))}</span>
          </div>
        `
        : "";
      return `
        <div class="round-prompt-card${recKind ? " has-recommendation" : ""}" data-round-prompt-card="${this.escape(messageId)}"${recKind ? ` data-chair-recommendation="${this.escape(recKind)}"` : ""}>
          <div class="rp-primary">
            <button type="button" class="rp-btn vote${endClass}" data-round-end>
              <span class="rp-mark">▣</span>
              <span class="rp-label">${this.escape(this._t("round_end_open_vote"))}</span>
            </button>
            <button type="button" class="rp-btn continue${contClass}" data-continue-auto>
              <span class="rp-mark">▶</span>
              <span class="rp-label">${this.escape(this._t("rp_continue_next"))}</span>
              <span class="rp-timer" data-continue-timer></span>
            </button>
          </div>
          ${recIndicator}
          <button type="button" class="rp-adjourn" data-adjourn-from-chair>
            ${this.escape(this._t("rp_adjourn_room_file"))}
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
      // Iterate ALL matching cards · the round-prompt may live in
      // up to two surfaces simultaneously (chat scroll + voice-mode
      // round-table vote overlay). querySelector + replaceWith would
      // only refresh whichever happened to be first in the DOM.
      const cards = document.querySelectorAll(`.round-prompt-card[data-round-prompt-card="${messageId}"]`);
      if (cards.length === 0) return;
      const html = this.roundPromptCardHtml(messageId);
      cards.forEach((card) => {
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        const next = tmp.firstElementChild;
        if (next) card.replaceWith(next.cloneNode(true));
      });
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
              <div class="kp-eyebrow kp-eyebrow-pending">${this.escape(this._t("kp_eyebrow_drafting"))}</div>
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
                <span class="kp-pending-text">${this.escape(this._t("kp_pending_drafting"))}</span>
              </div>
            </div>
          `;
        }
        // Degraded card · streaming finished, points empty. Show
        // continue/adjourn so the user can still progress the room.
        const ctasDegraded = awaiting
          ? `
            <div class="kp-ctas">
              <button type="button" class="kp-cta primary" data-continue>${this.escape(this._t("kp_btn_continue_next"))}</button>
              <button type="button" class="kp-cta ghost" data-adjourn-from-chair>${this.escape(this._t("kp_btn_adjourn_brief"))}</button>
            </div>
          `
          : `<div class="kp-ctas-spent">${this.escape(this._t("kp_ctas_spent"))}</div>`;
        return `
          <div class="round-end-card" data-round-end-card="${this.escape(messageId)}">
            <div class="kp-eyebrow kp-eyebrow-degraded">${this.escape(this._t("kp_eyebrow_degraded"))}</div>
            ${ctasDegraded}
          </div>
        `;
      }
      const items = points.map((p) => `
        <div class="kp-row" data-kp-id="${this.escape(p.id)}">
          <div class="kp-body">${this.escape(p.body)}</div>
          <div class="kp-actions">
            <button type="button" class="kp-vote up ${p.vote === "up" ? "active" : ""}" data-kp-vote="up" data-kp-id="${this.escape(p.id)}" aria-label="${this.escape(this._t("kp_vote_aria_up"))}">
              <span>▲</span><span>${this.escape(this._t("kp_vote_more"))}</span>
            </button>
            <button type="button" class="kp-vote down ${p.vote === "down" ? "active" : ""}" data-kp-vote="down" data-kp-id="${this.escape(p.id)}" aria-label="${this.escape(this._t("kp_vote_aria_down"))}">
              <span>▼</span><span>${this.escape(this._t("kp_vote_drop"))}</span>
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
            <div class="kp-shift-eyebrow">${this.escape(this._t("kp_shift_eyebrow_prefix"))}<strong>${this.escape(shift.to)}</strong></div>
            <div class="kp-shift-because">${this.escape(shift.because)}</div>
          </div>
        `
        : "";
      let ctas;
      const modeRaw = (this.currentRoom?.mode || "").toLowerCase();
      const modeKeep = modeRaw || this._t("kp_mode_current_fallback");
      if (!awaiting) {
        ctas = `<div class="kp-ctas-spent">${this.escape(this._t("kp_ctas_spent"))}</div>`;
      } else if (shift) {
        // 3-button layout · primary takes ~50% of the row, the two
        // secondaries split the rest. Without `kp-ctas-shift`, three
        // `flex: 1` buttons squeeze each label to ~33% width and the
        // longer "switch to constructive" label wraps to two lines.
        // Labels stripped of "& continue" — the action is implicit
        // in this round-end context.
        ctas = `
          <div class="kp-ctas kp-ctas-shift">
            <button type="button" class="kp-cta primary" data-shift-accept data-shift-to="${this.escape(shift.to)}">${this.escape(this._t("kp_switch_to", { mode: shift.to }))}</button>
            <button type="button" class="kp-cta ghost" data-continue>${this.escape(this._t("kp_keep_mode", { mode: modeKeep }))}</button>
            <button type="button" class="kp-cta ghost" data-adjourn-from-chair>${this.escape(this._t("kp_btn_adjourn"))}</button>
          </div>
        `;
      } else {
        ctas = `
          <div class="kp-ctas">
            <button type="button" class="kp-cta primary" data-continue>${this.escape(this._t("kp_btn_continue_next"))}</button>
            <button type="button" class="kp-cta ghost" data-adjourn-from-chair>${this.escape(this._t("kp_btn_adjourn_brief"))}</button>
          </div>
        `;
      }
      return `
        <div class="round-end-card" data-round-end-card="${this.escape(messageId)}">
          <div class="kp-eyebrow">${this.escape(this._t("kp_eyebrow_vote"))}</div>
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
        const isLongOpener = (m.body || "").length > 80;
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
          const label = this._t("convene_followup_label");
          const roomTag = this._t("convene_room_label");
          const parentTitle = this._t("convene_parent_session_title", { subject: parentSubject || parentId });
          const subjectChunk = truncated
            ? `<span class="convene-origin-sep">·</span><span class="convene-origin-subject">${this.escape(truncated)}</span>`
            : "";
          originHtml = `
            <a class="convene-origin" href="#/r/${this.escape(parentId)}" data-parent-room-id="${this.escape(parentId)}" title="${this.escape(parentTitle)}">
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
        const moreLabel = this._t("convene_show_more");
        const lessLabel = this._t("convene_show_less");
        const toggleHtml = isLongOpener
          ? `<button type="button" class="convene-toggle" data-convene-toggle data-more="${this.escape(moreLabel)}" data-less="${this.escape(lessLabel)}">${moreLabel}</button>`
          : "";
        return `
          <article class="${articleCls}" data-message-id="${this.escape(m.id)}">
            <div class="convene-eyebrow">${this.escape(this._t("convene_eyebrow"))}</div>
            ${originHtml}
            <h2 class="convene-body">${this.renderBody(m.body)}</h2>
            ${toggleHtml}
            <div class="convene-meta">
              <span class="convene-by">${who}</span>
              <span class="convene-time">· ${this.timeFmt(m.createdAt)}</span>
              <span class="convene-cast">· ${this.escape(this._t("convene_meta_to"))} ${this.currentMembers.map((a) => this.escape(a.handle)).join(" ")}</span>
            </div>
          </article>
        `;
      }
      const isUser = m.authorKind === "user";
      const author = isUser ? null : this.agentsById[m.authorId];
      const isChair = !isUser && author?.roleKind === "moderator";
      // Excused-from-room marker · the director is in this room's
      // historicalMembers with a non-null removedAt. Past messages
      // keep their name + role tag (so the chat transcript still
      // makes sense) and get a small "// excused" pill in the
      // header so the reader knows this seat is gone.
      const excusedMember = (!isUser && !isChair && m.authorId)
        ? (this.currentHistoricalMembers || []).find((hm) => hm.id === m.authorId && hm.removedAt != null)
        : null;
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
        const elapsedSecs = typeof meta.elapsedMs === "number" && status !== "running"
          ? this._t("msg_ws_secs", { n: (meta.elapsedMs / 1000).toFixed(1) })
          : "";
        const elapsedTail = elapsedSecs ? ` · ${elapsedSecs}` : "";
        const sources = Array.isArray(meta.sources) ? meta.sources : [];

        // web-search renders as a full-width card mirroring `.brief-card`
        // (banner kicker + body + optional sources block + bottom
        // expand button). Other tool-use rows (fetch-url) keep the
        // compact micro-strip below — they're inline status beats,
        // not standalone deliverable surfaces.
        if (tool === "web-search") {
          const hasSources = status === "done" && sources.length > 0;
          let stamp;
          if (status === "running") stamp = this._t("msg_ws_searching");
          else if (status === "done") {
            stamp = sources.length === 1
              ? this._t("msg_ws_done_one", { tail: elapsedTail })
              : this._t("msg_ws_done", { n: sources.length, tail: elapsedTail });
          } else {
            stamp = elapsedSecs
              ? this._t("msg_ws_failed_elapsed", { elapsed: elapsedSecs })
              : this._t("msg_ws_failed");
          }

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
              <button type="button" class="msg-tool-sources-expand" data-msg-ws-toggle data-message-id="${this.escape(m.id)}" aria-label="${this.escape(this._t("msg_ws_toggle"))}">
                <span class="msg-tool-sources-expand-icon" aria-hidden="true">▾</span>
                <span class="msg-tool-sources-expand-show">${this.escape(this._t("msg_ws_expand_show", { n: sources.length }))}</span>
                <span class="msg-tool-sources-expand-hide">${this.escape(this._t("msg_ws_expand_hide"))}</span>
              </button>`
            : "";

          const bodyToggleAttrs = hasSources
            ? ` data-msg-ws-toggle data-message-id="${this.escape(m.id)}" role="button" tabindex="0" aria-label="${this.escape(this._t("msg_ws_toggle"))}"`
            : "";
          const caret = hasSources ? `<span class="msg-tool-caret" aria-hidden="true">▸</span>` : "";

          return `
            <div class="msg-tool-card status-${this.escape(status)}" data-message-id="${this.escape(m.id)}">
              <div class="msg-tool-banner">
                <span class="msg-tool-banner-tag">${this.escape(this._t("msg_ws_banner"))}</span>
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
              ${elapsedSecs ? `<span class="msg-tool-elapsed">${this.escape(elapsedSecs)}</span>` : ""}
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
            <div class="cd-kicker">${this.escape(this._t("msg_chair_direct_kicker"))}</div>
            <div class="cd-body">${bodyHtml}</div>
            <div class="cd-meta">
              <span class="cd-author">${this.escape(this.currentChair?.name || this._t("msg_chair_display_fallback"))}</span>
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
            <div class="ci-kicker">${this.escape(this._t("msg_chair_intervention_kicker"))}</div>
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
            <div class="cb-kicker">${this.escape(this._t("msg_chair_billing_kicker"))}</div>
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
              <span class="ro-round">${this.escape(this._t("ro_round", { n: roundNum }))}</span>
              <span class="ro-sep">·</span>
              <span class="ro-mode">${this.escape(isOpening ? this._t("ro_mode_parallel") : this._t("ro_mode_reactive"))}</span>
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
        // System UI · always English (no-brief card chrome).
        const hasBrief = !!this.currentBrief;
        const chairName = (this.prefs?.name || "").trim() || this._t("nb_chair_fallback");
        const cta = hasBrief
          ? ""
          : `
            <div class="nb-actions">
              <button type="button" class="nb-cta" data-generate-brief>
                <span class="nb-cta-mark">▸</span>
                <span class="nb-cta-text">${this.escape(this._t("nb_cta"))}</span>
              </button>
            </div>
          `;
        return `
          <div class="no-brief-card" data-message-id="${this.escape(m.id)}">
            <span class="nb-chip">
              <span class="nb-mark">⊘</span>
              <span class="nb-eyebrow">${this.escape(this._t("nb_eyebrow"))}</span>
            </span>
            <div class="nb-body">
              <strong>${this.escape(chairName)}</strong> ${this.escape(this._t("nb_body"))}
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
        ? this._t("msg_tag_you")
        : isChair
          ? this._t("msg_tag_chair")
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
        ? `<span class="msg-context" title="${this.escape(this._t("msg_ctx_title", { n: ctxCount, name }))}">${this.escape(this._t("msg_ctx_inline", { n: ctxCount }))}</span>`
        : "";

      // Skills badge · the orchestrator's Pass-1 router stamps which
      // skills (if any) were applied for this turn into meta.skillsUsed.
      // Renders as a small pill next to the model so the user sees the
      // effect of installing a skill turn-by-turn.
      const skillsUsed = (m.meta && Array.isArray(m.meta.skillsUsed)) ? m.meta.skillsUsed : [];
      const skillsReason = (m.meta && typeof m.meta.skillsReason === "string") ? m.meta.skillsReason : "";
      const skillsBadge = skillsUsed.length > 0
        ? `<span class="msg-skills" title="${this.escape(skillsReason || this._t("msg_skills_used", { list: skillsUsed.join(", ") }))}">🛠 ${skillsUsed.map((s) => this.escape(s)).join(", ")}</span>`
        : "";

      // Web-search badge · meta is set by the orchestrator when the
      // Pass-1 router decided to run a Brave query and got results.
      // Renders next to the skills pill; clicking expands the source
      // list under the bubble.
      const webSearchUsed = !!(m.meta && m.meta.webSearchUsed);
      const webSearchQuery = (m.meta && typeof m.meta.webSearchQuery === "string") ? m.meta.webSearchQuery : "";
      const webSearchSources = (m.meta && Array.isArray(m.meta.webSearchSources)) ? m.meta.webSearchSources : [];
      const webSearchBadge = webSearchUsed
        ? (() => {
          const n = webSearchSources.length;
          const title = this.escape(this._t("msg_ws_title", { query: webSearchQuery, n }));
          const label = n === 1
            ? this.escape(this._t("msg_ws_btn_one"))
            : this.escape(this._t("msg_ws_btn", { n }));
          return `<button type="button" class="msg-web-search" data-msg-ws-toggle data-message-id="${this.escape(m.id)}" title="${title}">🔍 ${label}</button>`;
        })()
        : "";
      const webSearchSourcesPanel = webSearchUsed && webSearchSources.length > 0
        ? `<div class="msg-web-search-sources" data-msg-ws-sources data-message-id="${this.escape(m.id)}" hidden>
            <div class="msg-web-search-query"><span class="msg-web-search-query-label">${this.escape(this._t("msg_ws_query_label"))}</span><span class="msg-web-search-query-text">${this.escape(webSearchQuery)}</span></div>
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
        ? `<div class="msg-chair-pick" title="${this.escape(this._t("room_chair_pick_title", { name: this.escape(name) }))}">${this.escape(this._t("msg_chair_pick", { body: chairPick }))}</div>`
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
              ${modelLabel ? `<span class="msg-model" title="${this.escape(this._t("msg_model_title", { label: modelLabel }))}">${this.escape(modelLabel)}</span>` : ""}
              <span class="msg-tag">${tag}</span>
              ${excusedMember ? `<span class="msg-excused" title="Excused from this room by the chair">// excused</span>` : ""}
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
      // Bottom-bar manual-vote button is independent of the round-end
      // card · refresh it FIRST, before any early return below. The
      // [data-round-end] card lives in the chat (round-end summary
      // card) and only exists after the chair wraps a round, so the
      // early-return below would otherwise starve the manual button
      // forever in fresh rooms.
      this.refreshManualVoteButton();
      const btn = document.querySelector("button[data-round-end]");
      if (!btn) return;
      const ok = this.canRequestRoundEnd();
      btn.disabled = !ok;
      // Old queue strip used .qw-label; new in-chat card uses .rp-label.
      const label = btn.querySelector(".rp-label, .qw-label");
      if (label) {
        if (this.currentRoom?.awaitingContinue) label.textContent = this._t("round_end_vote_above");
        else if (this.currentRoom?.awaitingClarify) label.textContent = this._t("round_clarifying");
        else label.textContent = this._t("round_end_open_vote");
      }
    },

    /** Show / hide the bottom-bar manual vote-trigger button. The
     *  button is only meaningful when the room is configured for
     *  manual vote-phase entry; in auto mode the chair drops the
     *  prompt automatically and the button stays hidden. Disabled
     *  while clarify / vote-already-open / non-live so the user
     *  can't double-fire. */
    refreshManualVoteButton() {
      const btn = document.querySelector("[data-room-end-manual]");
      if (!btn) return;
      const room = this.currentRoom;
      const manual = !!(room && room.voteTrigger === "manual");
      btn.hidden = !manual;
      if (!manual) return;
      // The button stays clickable whenever the room is live and not
      // already in another phase — clicking opens the 3-option vote
      // overlay (interrupt now / after current speaker / cancel).
      // The overlay is responsible for the "wait for speaker" path,
      // so we don't gate on isRoundComplete() here. Disabled only
      // when there's nothing useful the overlay could do.
      const canOpen = !!(
        room &&
        room.status === "live" &&
        !room.awaitingClarify &&
        !room.awaitingContinue
      );
      btn.disabled = !canOpen;
      // Queued state · the user picked "After current speaker" and
      // the server stashed the request. Mark visually so the user
      // knows the click registered (the button still echoes the
      // tooltip on hover). Cleared on the SSE round-ended flip.
      const queued = !!(room && room.voteQueued);
      btn.classList.toggle("is-queued", queued);
      if (queued) {
        btn.setAttribute("data-tip", this._t("ib_vote_tip_queued"));
        btn.setAttribute("aria-label", this._t("ib_vote_label_queued"));
        btn.setAttribute("title", this._t("ib_vote_tip_queued"));
      } else {
        btn.setAttribute("data-tip", this._t("ib_vote_tip"));
        btn.setAttribute("aria-label", this._t("ib_vote_label"));
        btn.setAttribute("title", this._t("ib_vote_tip"));
      }
    },

    /** Open the bottom-bar manual-vote confirmation overlay. Three
     *  options: interrupt the current speaker and open the vote now,
     *  let the current speaker finish their turn first, or cancel.
     *  If no director is mid-stream, the "after-speaker" path is
     *  disabled (no one to wait for).
     *
     *  Visual chrome reuses the pause-choice modal (`.pc-overlay /
     *  .pc-modal / .pc-choice`) so the two confirmation surfaces
     *  feel like the same component to the user. */
    openVoteTriggerOverlay() {
      if (document.getElementById("vote-trigger-overlay")) return;
      this.cancelContinueCountdown();
      const speaking = this.isAgentSpeaking();
      const speakerName = (() => {
        if (!speaking) return "";
        const head = (this.currentQueue || [])[0];
        if (!head) return "";
        const a = this.agentsById[head.agentId];
        return a ? a.name : "";
      })();
      const titleTxt = this._t("vt_title");
      const introTxt = speaking
        ? this._t("vt_intro_speaking", { who: speakerName || this._t("vt_intro_speaking_fallback") })
        : this._t("vt_intro_idle");
      const nowLabel = this._t("vt_now_label");
      const nowDesc = speaking ? this._t("vt_now_desc_speaking") : this._t("vt_now_desc_idle");
      const afterLabel = this._t("vt_after_label");
      const afterDesc = speaking ? this._t("vt_after_desc_speaking") : this._t("vt_after_desc_idle");
      const cancelTxt = this._t("vt_cancel");
      const cancelDesc = this._t("vt_cancel_desc");
      const kickerTxt = this._t("vt_kicker");
      const html = `
        <div id="vote-trigger-overlay" class="pc-overlay" role="dialog" aria-modal="true">
          <div class="pc-modal" role="document">
            <div class="pc-classification">
              <span><span class="dot">●</span> ${this.escape(kickerTxt)}</span>
              <span class="right">vote</span>
            </div>
            <div class="pc-head">
              <div class="pc-tag">${this.escape(kickerTxt)}</div>
              <h2 class="pc-title">${this.escape(titleTxt)}</h2>
              <p class="pc-deck">${this.escape(introTxt)}</p>
            </div>
            <div class="pc-body">
              <button type="button" class="pc-choice danger" data-vt-mode="now">
                <div class="pc-choice-mark">${this.escape(nowLabel)}</div>
                <div class="pc-choice-deck">${this.escape(nowDesc)}</div>
              </button>
              <button type="button" class="pc-choice primary" data-vt-mode="after-speaker"${speaking ? "" : ' disabled aria-disabled="true"'}>
                <div class="pc-choice-mark">${this.escape(afterLabel)}</div>
                <div class="pc-choice-deck">${this.escape(afterDesc)}</div>
              </button>
              <button type="button" class="pc-choice ghost" data-vt-close>
                <div class="pc-choice-mark">${this.escape(cancelTxt)}</div>
                <div class="pc-choice-deck">${this.escape(cancelDesc)}</div>
              </button>
            </div>
          </div>
        </div>
      `;
      document.body.insertAdjacentHTML("beforeend", html.trim());
      this._voteTriggerEsc = (ev) => {
        if (ev.key === "Escape") {
          ev.stopImmediatePropagation();
          this.closeVoteTriggerOverlay();
        }
      };
      document.addEventListener("keydown", this._voteTriggerEsc, true);
    },

    closeVoteTriggerOverlay() {
      const el = document.getElementById("vote-trigger-overlay");
      if (el) el.remove();
      if (this._voteTriggerEsc) {
        document.removeEventListener("keydown", this._voteTriggerEsc, true);
        this._voteTriggerEsc = null;
      }
    },

    /** Voice-mode round-end vote overlay · auto-mounts when the chair
     *  has wrapped a round and the user is viewing the round-table
     *  stage. Wraps the same `roundEndCardHtml` content used in chat
     *  inside pc-overlay chrome, so the user sees the up/down vote on
     *  each key-point + Continue / Adjourn even when there's no chat
     *  scroll visible. The card's existing data attributes (data-kp-
     *  vote, data-continue, data-adjourn-from-chair) reach the same
     *  click handlers as the chat surface · no new wiring needed.
     *
     *  Idempotent · calling refreshRtVoteOverlay() opens / closes the
     *  overlay based on (deliveryMode === "voice") + awaitingContinue
     *  + stage visibility. Safe to call from any SSE handler. */
    refreshRtVoteOverlay() {
      // Voice-mode vote affordance lives entirely on the chair seat
      // popover now (rt-vote-pop · see renderRoundTableVotePop) — the
      // centered overlay duplicated the chair-head card and let the
      // user double-fire requestRoundEnd by clicking the still-active
      // [Open vote] in either surface. This function is kept for
      // back-compat with the SSE wiring · it just tears down any
      // stale overlay and bails out.
      const existing = document.getElementById("rt-vote-overlay");
      if (existing) this.closeRtVoteOverlay({ keepDismissed: false });
    },

    /** Close the round-end vote overlay. `keepDismissed` flags the
     *  user-driven dismissal (Esc / backdrop click) so refreshRtVote-
     *  Overlay won't immediately re-open on the next SSE tick. The
     *  flag clears when the room exits awaitingContinue (round-resumed
     *  or room-adjourned), letting the next round's overlay auto-mount
     *  fresh. */
    closeRtVoteOverlay(opts) {
      const el = document.getElementById("rt-vote-overlay");
      if (el) el.remove();
      if (this._rtVoteEsc) {
        document.removeEventListener("keydown", this._rtVoteEsc, true);
        this._rtVoteEsc = null;
      }
      if (opts && opts.keepDismissed) {
        this._rtVoteOverlayDismissed = true;
      }
    },

    /** Build the one-line summary shown in the collapsed speaking-queue
     *  strip. Mirrors the expanded queue: speaking, pending, or idle. */
    renderQueueCollapsed(items) {
      const slot = document.querySelector("[data-queue-collapsed]");
      if (!slot) return;
      if (!items || items.length === 0) {
        slot.innerHTML = `<span class="sum-marker">·</span><span class="sum-state">${this.escape(this._t("q_idle"))}</span>`;
        return;
      }
      const head = items[0];
      const a = this.agentsById[head.agentId];
      if (!a) { slot.innerHTML = ""; return; }
      const speaking = head.status === "speaking";
      const pending = head.status === "pending";
      const stateLabel = speaking
        ? this._t("q_speaking")
        : pending
          ? (this.currentRoom?.awaitingContinue
              ? this._t("q_pending_vote")
              : this._t("q_pending_chair"))
          : this._t("q_queued");
      const next = items[1] ? this.agentsById[items[1].agentId] : null;
      const rest = items.length > 2 ? this._t("q_more_queued", { n: items.length - 2 }) : "";

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
      // Round-table piggybacks on the same triggers as the
      // speaking-queue strip — every queue mutation re-paints both
      // the cue sheet and the seats around the oval. Cheap when
      // the stage is hidden (renderRoundTable bails fast).
      this.renderRoundTable();
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
                <span class="state">${this._t("q_user_queued", { preview: this.escape(preview) })}</span>
                <span class="actions">
                  <button type="button" class="user-queued-cancel" data-cancel-user-queued title="${this.escape(this._t("q_cancel"))}">✕</button>
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
            stateLabel = this._t("q_state_speaking", { n: ctxTotal });
          } else if (pending) {
            // Pending means "lined up, waiting on something off-queue".
            // Phrasing matches the room's current pause kind so the
            // user knows what they're waiting on.
            stateLabel = this.currentRoom?.awaitingContinue
              ? this._t("q_pending_your_vote")
              : this.currentRoom?.awaitingClarify
                ? this._t("q_pending_waits_chair")
                : this._t("q_pending_chair");
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

    /* ═════════════════════════════════════════════════════════════
       Round-table view · gamified voice-mode stage helpers.
       See plan: /Users/kaysaith/.claude/plans/merry-greeting-dongarra.md
       ═════════════════════════════════════════════════════════════ */

    /** Pure function · place N seats around an oval, with the chair
     *  pinned at the bottom-center and directors fanning across the
     *  top arc with a 60° gap centered on the chair so it never feels
     *  crowded. Returns stage-relative percentages (0-100) plus a
     *  scaleHint that simulates depth (front-row larger than back-
     *  row). The chair is always the FIRST entry in the input
     *  members array · caller is responsible for ordering.
     *
     *  Frame of reference: y-axis points DOWN (CSS convention), so
     *  θ = 90° = bottom of the ellipse. */
    computeSeatPositions(members) {
      const n = members.length;
      if (n === 0) return [];
      const cx = 50, cy = 50;        // stage-center percentages
      // Seat-ring semi-axes for the DIRECTOR ring · the table body
      // spans y = 36% .. 64% (height 28%) and x = 18% .. 82% (width
      // 64%). Tightened from (rx = 46, ry = 24) → (rx = 42, ry = 23)
      // so directors hug the table edge instead of stranding in
      // the corners. Side seats now sit ~0.2-1% from the table's
      // horizontal bound (vs ~3.5% before); top seats at y ≈ 27%
      // (~9% gap above the table top). The 4-person config has
      // its side seats lightly tuck under the table edge — reads
      // as "side chair pulled in to the table", not as a glitch.
      // Chair stays on chairRy below.
      const rx = 42, ry = 23;
      const chairRy = 15;            // chair at y = 65% (~1% gap)
      const out = [];
      const SEAT_SCALE = 1.10;
      // User-seat detection · appended last by `roundTableMembers`
      // when the user has typed at least once in this room. Pull
      // it out so director step math works only on actual director
      // count, then position chair + user as a paired bottom row.
      const userIdx = members.findIndex((m) => m && m.__isUser);
      const userMember = userIdx >= 0 ? members[userIdx] : null;
      const directorCount = userMember ? n - 2 : n - 1;
      // Chair · always at θ = 90° (bottom-centre when alone). When
      // the user is seated alongside, chair shifts left to x: 43
      // and the user lands at x: 57 — paired front-row at the head
      // of the table.
      const chairX = userMember ? 43 : cx + rx * Math.cos(Math.PI / 2);
      const chairY = cy + chairRy * Math.sin(Math.PI / 2);
      out.push({
        member: members[0],
        x: chairX,
        y: chairY,
        scaleHint: SEAT_SCALE,
        kind: "chair",
        thetaDeg: 90,
      });
      // Directors fan across the TOP HALF of the ellipse only
      // (θ ∈ [180°, 360°]). Restricting to the top arc puts the
      // leftmost / rightmost director seats at the table's vertical
      // centre (y ≈ 41%) — beside the table edge, like real
      // boardroom side chairs.
      if (directorCount > 0) {
        const arcDeg = 180;
        // Single director: stepDeg division-by-zero guard · place at
        // the arc midpoint (top-centre) when only one director is
        // seated.
        const stepDeg = directorCount === 1 ? 0 : arcDeg / directorCount;
        for (let i = 0; i < directorCount; i++) {
          // Director members live at indices 1 .. (1 + directorCount).
          // The user (if present) sits AFTER the directors in the
          // members array, so director iteration is always [1, 1+dC).
          const m = members[1 + i];
          const t = directorCount === 1
            ? 270
            : 180 + (i + 0.5) * stepDeg;
          const theta = (t * Math.PI) / 180;
          out.push({
            member: m,
            x: cx + rx * Math.cos(theta),
            y: cy + ry * Math.sin(theta),
            scaleHint: SEAT_SCALE,
            kind: "director",
            thetaDeg: t,
          });
        }
      }
      // User seat · paired with chair on the bottom row. Pushed last
      // so the renderer's z-order sort (by y) interleaves it with
      // any other y≈65 seats correctly.
      if (userMember) {
        out.push({
          member: userMember,
          x: 57,
          y: chairY,
          scaleHint: SEAT_SCALE,
          kind: "user",
          thetaDeg: 90,
        });
      }
      return out;
    },

    /** Inline pixel-art chair sprite · 32×40 viewBox, painted as 1×1
     *  rect cells in the same vocabulary as /public/avatars/chair.svg.
     *  `isModerator: true` adds two cyan side-rails + a cyan headrest
     *  gem to distinguish the chair's seat from the directors'. */
    renderRoundTableChairSvg(isModerator) {
      // Pixel grid · 32 cols × 40 rows. Each cell rendered as a
      // <rect width="1" height="1"> at integer coords.
      const back = (col, row, w, h, cls) => `<rect class="${cls}" x="${col}" y="${row}" width="${w}" height="${h}"/>`;
      // Back rail (top half · rows 4-22).
      const rails = [
        back(8,  4, 16, 4,  "rt-chair-back"),         // top crossbar
        back(7,  8, 18, 14, "rt-chair-back"),         // back panel
        back(7,  22, 18, 2, "rt-chair-back-shade"),   // shadow under back
        back(6,  4, 1,  20, "rt-chair-finial"),       // left side rail
        back(25, 4, 1,  20, "rt-chair-finial"),       // right side rail
        back(7,  4, 1,  20, "rt-chair-back-shade"),   // inside left shadow
        back(24, 4, 1,  20, "rt-chair-back-shade"),   // inside right shadow
      ].join("");
      // Seat · rows 22-30, slightly wider than the back to read as
      // a cushion overhang.
      const seat = [
        back(5,  22, 22, 8,  "rt-chair-seat"),
        back(5,  28, 22, 2,  "rt-chair-seat-shade"),
      ].join("");
      // Legs · two short stubs, rows 30-38.
      const legs = [
        back(7,  30, 2, 8, "rt-chair-finial"),
        back(23, 30, 2, 8, "rt-chair-finial"),
      ].join("");
      // Moderator dressing · cyan side rails + headrest gem.
      const mod = isModerator ? [
        back(5,  8,  1, 14, "rt-chair-mod-rail"),     // outer left rail
        back(26, 8,  1, 14, "rt-chair-mod-rail"),     // outer right rail
        back(15, 6,  2, 2,  "rt-chair-mod-gem"),      // gem
        back(15, 6,  1, 1,  "rt-chair-mod-gem-glow"), // gem highlight
      ].join("") : "";
      return `
        <svg class="rt-chair${isModerator ? " rt-chair--mod" : ""}" viewBox="0 0 32 40" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          ${rails}
          ${seat}
          ${legs}
          ${mod}
        </svg>
      `;
    },

    /** Build the seat list from current room state · chair first,
     *  then directors, with an optional SYNTHETIC user member
     *  appended when `userSeatVisible` is true. Members must be
     *  ordered consistently across re-renders so seat positions
     *  don't reshuffle on every queue update. The synthetic user
     *  member carries `__isUser: true` so render code can branch on
     *  avatar + bubble; `computeSeatPositions` recognises it and
     *  pairs it next to the chair on the bottom row. */
    roundTableMembers() {
      const members = [];
      if (this.currentChair) members.push(this.currentChair);
      const dirs = (this.currentMembers || [])
        .filter((a) => a && a.roleKind !== "moderator");
      // Stable sort by id so positions are deterministic across
      // queue-update events that may reorder currentMembers.
      const sorted = [...dirs].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      members.push(...sorted);
      // User seat · appears once the user has typed in this room.
      // Synthetic member carries enough fields for the render loop
      // (id / name / avatar seed) plus the `__isUser` flag that
      // `computeSeatPositions` and the seat-loop branch on. We
      // require a chair to exist (no chair, no paired bottom-row
      // layout makes sense).
      if (this.userSeatVisible && this.currentChair) {
        const prefs = this.prefs || {};
        members.push({
          id: "__user__",
          name: prefs.name || "You",
          avatarPath: null,
          __seed: prefs.avatarSeed || null,
          __isUser: true,
        });
      }
      return members;
    },

    /** Mount a pixel-art toast in the round-table stage · shown
     *  only when the stage is visible (voice mode + round-table
     *  view). When the chat surface is showing instead, callers
     *  no-op since the chat already renders system messages for
     *  these events. Toasts auto-dismiss after `lifetimeMs` (default
     *  4500ms) and are click-to-dismiss-early.
     *
     *  Variants drive the left-bar accent + glyph color:
     *    · "add"      — lime, "+"
     *    · "remove"   — amber, "−"
     *    · "settings" — cyan, "↗"
     *    · "round"    — lime, "▶"
     *
     *  `htmlText` may carry a single <em>...</em> wrap to highlight
     *  the load-bearing word (director name, new tone, etc.). */
    showRoundTableToast({ kind = "settings", glyph = "·", htmlText = "", lifetimeMs = 4500 } = {}) {
      // Append to the persistent HUD log regardless of stage
      // visibility · the HUD shows the running tally whenever the
      // user later opens the voice/round-table view, so we want the
      // log populated even if a chair-op fires while the user is in
      // chat view. Capped at 6 entries (oldest dropped first).
      if (!Array.isArray(this.rtChairLog)) this.rtChairLog = [];
      this.rtChairLog.unshift({ kind, glyph, htmlText, at: Date.now() });
      if (this.rtChairLog.length > 6) this.rtChairLog.length = 6;
      // Re-render the HUD if it's mounted · cheap idempotent paint
      // that picks up the new entry. No-op when the stage isn't in
      // the DOM yet.
      this.renderRoundTableHud();

      const tray = document.querySelector("[data-rt-toast-tray]");
      if (!tray) return;
      const stage = document.querySelector("[data-roundtable-stage]");
      // Only fire when the stage is visible · in chat view, the
      // existing system-message rendering already surfaces these
      // events, so doubling them as toasts is noisy.
      if (!stage || stage.hasAttribute("hidden")) return;

      const el = document.createElement("div");
      el.className = `rt-toast rt-toast-${kind}`;
      el.innerHTML = `
        <span class="rt-toast-glyph" aria-hidden="true">${this.escape(glyph)}</span>
        <span class="rt-toast-text">${htmlText}</span>
      `;
      tray.appendChild(el);

      const dismiss = () => {
        if (!el.isConnected) return;
        el.classList.add("is-leaving");
        setTimeout(() => { try { el.remove(); } catch (_) {} }, 320);
      };
      el.addEventListener("click", dismiss);
      setTimeout(dismiss, lifetimeMs);
      // Cap the queue · drop the oldest if the stage is being
      // spammed (e.g. bulk member-add diff with 5 directors).
      const all = tray.querySelectorAll(".rt-toast:not(.is-leaving)");
      if (all.length > 5) {
        const overflow = all.length - 5;
        for (let i = 0; i < overflow; i++) {
          const old = all[i];
          old.classList.add("is-leaving");
          setTimeout(() => { try { old.remove(); } catch (_) {} }, 320);
        }
      }
    },

    /** Build the toast text for a single setting change. The
     *  `<em>` wrap on the new value is the visual hook the user's
     *  eye lands on. Returns null for unsupported keys so callers
     *  can skip them silently. */
    _roundTableSettingToast(key, fromV, toV) {
      const titles = {
        mode: "Tone",
        intensity: "Intensity",
        briefStyle: "Report style",
        deliveryMode: "Delivery",
        voteTrigger: "Vote phase",
      };
      const t = titles[key];
      if (!t) return null;
      const fromS = String(fromV ?? "");
      const toS = String(toV ?? "");
      return `${this.escape(t)}: ${this.escape(fromS)} → <em>${this.escape(toS)}</em>`;
    },

    /** Floating vote popover on the chair seat · shown only when
     *  the room is in vote phase (awaitingContinue === true). Three
     *  buttons replicate the chat-card round-prompt CTAs with the
     *  same data attrs, so the existing click handlers fire and
     *  `refreshContinueButton` paints both surfaces in lock-step.
     *  Lives ABOVE the chair's bubble area; visually anchored to
     *  the chair sprite so it reads as "the chair is awaiting your
     *  vote." */
    renderRoundTableVotePop() {
      const t = this._t.bind(this);
      const room = this.currentRoom;
      // Round-end vote phase · embed the canonical `roundEndCardHtml`
      // (skeleton during streaming, full card with 3 key-points + ▲/▼
      // + Continue / Adjourn after round-ended fires). Same data
      // attrs mean the existing click handlers reach the same paths.
      if (room && room.awaitingContinue === true) {
        const msgs = this.currentMessages || [];
        let messageId = null;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m && m.meta && m.meta.kind === "round-end") { messageId = m.id; break; }
        }
        if (messageId) {
          const cardHtml = this.roundEndCardHtml(messageId);
          if (cardHtml) {
            return `<div class="rt-vote-pop rt-vote-pop-card" role="group" aria-label="${this.escape(t("rp_chair_recommends"))}">${cardHtml}</div>`;
          }
        }
        // Awaiting-continue is set optimistically the moment the user
        // clicks [Open vote], but the chair's round-end placeholder
        // message takes a few seconds to land (server runs URL fetch
        // + web search tools before inserting it). Without this
        // branch the popover would re-render with the SAME 3-button
        // picker the user just clicked — confusing UX. Render a
        // standalone skeleton with the existing shimmer keyframes
        // so the user immediately sees "the chair is drafting".
        // Once the placeholder lands, the next renderRoundTable
        // tick swaps the skeleton for the canonical card body
        // (which is itself a shimmer skeleton until tokens arrive,
        // then the full key-points list).
        const eyebrow = this._t("kp_eyebrow_drafting");
        const pending = this._t("kp_pending_drafting");
        return `
          <div class="rt-vote-pop rt-vote-pop-card" role="group" aria-label="${this.escape(t("rp_chair_recommends"))}">
            <div class="round-end-card pending">
              <div class="kp-eyebrow kp-eyebrow-pending">${this.escape(eyebrow)}</div>
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
                <span class="kp-pending-text">${this.escape(pending)}</span>
              </div>
            </div>
          </div>
        `;
      }
      // Round-prompt phase · the compact 3-button picker. Inlining the
      // chat's `roundPromptCardHtml` here looked off (the chat card's
      // `flex: 1` rp-btns ballooned to fill the popover and the chair-
      // pick recommendation strip + adjourn underline all stacked
      // awkwardly inside the cyan-bordered chip). The original buttons
      // — same data attrs, much smaller footprint — fit the popover
      // visual register cleanly.
      return `
        <div class="rt-vote-pop" role="group" aria-label="${this.escape(t("rp_chair_recommends"))}">
          <div class="rt-vote-pop-row">
            <button type="button" class="rt-vote-btn rt-vote-end" data-round-end>
              <span class="rt-vote-mark" aria-hidden="true">▣</span>
              <span class="rt-vote-label">${this.escape(t("round_end_open_vote"))}</span>
            </button>
            <button type="button" class="rt-vote-btn rt-vote-continue" data-continue-auto>
              <span class="rt-vote-mark" aria-hidden="true">▶</span>
              <span class="rt-vote-label">${this.escape(t("rp_continue_next"))}</span>
              <span class="rt-vote-timer" data-continue-timer></span>
            </button>
          </div>
          <button type="button" class="rt-vote-adjourn" data-adjourn-from-chair>
            ${this.escape(t("rp_adjourn_room_file"))}
          </button>
        </div>
      `;
    },

    /** Map agentId → queue position. Returns -1 for "not in queue,"
     *  0 for "currently speaking," 1+ for "queued at position N." */
    roundTableQueueIndex(agentId) {
      if (!Array.isArray(this.currentQueue)) return -1;
      for (let i = 0; i < this.currentQueue.length; i++) {
        if (this.currentQueue[i].agentId === agentId) return i;
      }
      return -1;
    },

    /** Paint the round-table stage. Idempotent · safe to call from
     *  every renderQueue() call site. Reads from app.currentChair /
     *  currentMembers / currentQueue · doesn't mutate state. */
    renderRoundTable() {
      const stage = document.querySelector("[data-roundtable-stage]");
      if (!stage) return;
      // Tone-keyed floor · the stage's `data-floor` attribute
      // selects one of five 8-bit pixel-art floor patterns
      // (mosaic / tile / marble / ancient stone / carpet) to match
      // the room's tone. Falls back to the constructive tile for
      // unknown / legacy modes (the rooms.ts read path already
      // maps legacy "no-mercy" to "debate"). Set on every render
      // so a server-driven mode change repaints the floor
      // immediately alongside the rest of the stage.
      const VALID_FLOORS = ["brainstorm", "constructive", "research", "debate", "critique"];
      const tone = String(this.currentRoom?.mode || "constructive").toLowerCase();
      stage.setAttribute("data-floor", VALID_FLOORS.includes(tone) ? tone : "constructive");
      const seatsHost = stage.querySelector("[data-rt-seats]");
      if (!seatsHost) return;
      const members = this.roundTableMembers();
      const positions = this.computeSeatPositions(members);

      // Build seat HTML. Z-order via inline style based on the y
      // coordinate so seats with larger y (front) paint last and
      // occlude back-row seats / the table edge.
      const seatsByZ = positions
        .map((seat, i) => ({ seat, i, zScore: Math.round(seat.y * 10) }))
        .sort((a, b) => a.zScore - b.zScore);

      // Determine the active speaker AND whether they're thinking
      // (warming up · no tokens yet) or actively speaking (tokens
      // flowing). Priority:
      //  1. Most recent streaming message → that author. State
      //     depends on body content: empty body = thinking,
      //     non-empty = speaking.
      //  2. Most recent message with an ACTIVE VOICE QUEUE (audio
      //     is being streamed/played for it). Catches chair
      //     templated announcements (announceRoundPrompt +
      //     announceIntervention) that emit voice-chunks without
      //     setting meta.streaming · the user hears them speaking,
      //     so the bubble must surface even though the streaming
      //     flag is false.
      //  3. currentQueue[0] when status === "speaking" → queue head
      //     just promoted, no message-appended yet → thinking.
      //  4. Otherwise null (idle).
      let speakingId = null;
      let speakerState = null; // "thinking" | "speaking"
      let replayBody = null;   // populated only during voice-replay
      // (0) Voice-replay override · when an adjourned room is playing
      //     back its transcript via the replay overlay, the live
      //     `streaming` / queue signals are absent (the room is
      //     done). Read the replay's active speaker so the seat
      //     lights up + the bubble + subtitle reflect the playback.
      //     The `body` field powers the subtitle bar at the foot of
      //     the stage (`renderRoundTableSubtitle`). Falls through to
      //     the live-detection paths below when replay isn't active.
      const replayActive = (typeof window !== "undefined"
        && window.boardroomVoiceReplay
        && typeof window.boardroomVoiceReplay.getActive === "function")
        ? window.boardroomVoiceReplay.getActive()
        : null;
      if (replayActive && replayActive.authorId) {
        speakingId = replayActive.authorId;
        speakerState = replayActive.state === "speaking" ? "speaking" : "thinking";
        replayBody = replayActive.body || "";
      }
      const msgs = this.currentMessages || [];
      if (!speakingId) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const mm = msgs[i];
          if (mm && mm.meta && mm.meta.streaming === true && mm.authorKind === "agent") {
            speakingId = mm.authorId;
            const body = String(mm.body || "").trim();
            speakerState = body.length > 0 ? "speaking" : "thinking";
            break;
          }
        }
      }
      if (!speakingId && this.voiceQueues) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const mm = msgs[i];
          if (!mm || mm.authorKind !== "agent") continue;
          if (this.voiceQueues[mm.id]) {
            speakingId = mm.authorId;
            speakerState = "speaking";
            break;
          }
        }
      }
      // (3) Chair preparing (silent prep phase between user input
      //     and the chair's message-appended) · without this hook
      //     the user has no visual signal during the seconds the
      //     chair spends on tools + LLM startup. Show the thinking
      //     bubble on the chair seat so they know the chair is
      //     working. Cleared the moment the chair's real message
      //     appends (hideChairPending fires).
      if (!speakingId && this.chairPending === true && this.currentChair) {
        speakingId = this.currentChair.id;
        speakerState = "thinking";
      }
      if (!speakingId && Array.isArray(this.currentQueue) && this.currentQueue[0] && this.currentQueue[0].status === "speaking") {
        speakingId = this.currentQueue[0].agentId;
        speakerState = "thinking";
      }

      // Speaker-change SFX · fire a soft chime when the active
      // speaker flips (idle → first speaker, or A → B). Skips
      // speaker → idle (no chime when the room goes quiet) and
      // skips repeated calls within the same speaker. Same toggle
      // gate as the typing tick · user-settings "sound" toggle.
      if (speakingId !== this._lastSpeakerId) {
        if (speakingId && window.boardroomTypingSfx
            && typeof window.boardroomTypingSfx.speakerChange === "function") {
          window.boardroomTypingSfx.speakerChange();
        }
        this._lastSpeakerId = speakingId;
      }

      const html = seatsByZ.map(({ seat, i }) => {
        const m = seat.member;
        const isChair = seat.kind === "chair";
        const isUser = !!m.__isUser;
        const qIdx = isUser ? -1 : this.roundTableQueueIndex(m.id);
        const isSpeaking = !isUser && m.id === speakingId;
        const isQueued   = qIdx >= 1; // anyone after the head

        // Chair sprite · user gets the plain (no-moderator-gem) chair
        // sprite; the seat reads as "joined the table" not "running it".
        const chairSvg = this.renderRoundTableChairSvg(isChair);
        // Avatar · user takes prefs.avatarSeed via AvatarSkill when
        // available, otherwise falls back to an initial-letter chip
        // (mirrors the sidebar pattern at app.js:4847). Directors /
        // chair use their stored avatarPath image.
        let avatar;
        if (isUser) {
          const seed = m.__seed;
          if (seed && window.AvatarSkill && typeof window.AvatarSkill.generate === "function") {
            avatar = `<div class="rt-avatar rt-avatar-user has-pixel-av">${window.AvatarSkill.generate(seed)}</div>`;
          } else {
            const initial = this.escape(((m.name || "?")[0] || "?").toUpperCase());
            avatar = `<div class="rt-avatar rt-avatar-user rt-avatar-initial">${initial}</div>`;
          }
        } else {
          avatar = `<img class="rt-avatar" src="${this.escape(m.avatarPath || "")}" alt="" aria-hidden="true">`;
        }
        // Name plate · adds a small "Chairman / 董事长" title beneath
        // the user's name so the user seat reads as the room owner /
        // chairman. Pulled from i18n (`rt_user_title`) so the label
        // follows the active UI locale: defaults to "Chairman" in
        // English, "董事长" in Chinese. Directors and the chair
        // render the plain single-line name.
        const name = isUser
          ? `<div class="rt-name">${this.escape(m.name || "")}<div class="rt-name-title">${this.escape(this._t("rt_user_title"))}</div></div>`
          : `<div class="rt-name">${this.escape(m.name || "")}</div>`;
        const bubbleState = isSpeaking ? speakerState : null;
        // Bubble carries the speaker's NAME so the user always knows
        // who's speaking — the name plate beneath/above the seat is
        // hidden during speaking (display:none in CSS), and without a
        // name on the bubble itself the user could only guess. Status
        // word ("thinking" / "speaking") is rendered as a smaller
        // mono kicker beneath the name. Color + dots animation still
        // distinguishes thinking (amber) from speaking (lime).
        const statusWord = bubbleState === "thinking"
          ? this._t("rt_thinking")
          : this._t("rt_speaking");
        const bubbleCls = bubbleState === "thinking"
          ? "rt-bubble is-thinking"
          : "rt-bubble";
        // User bubble · ephemeral, shows latest typed message plus
        // an `×` close button. Visible only when not dismissed and
        // the deadline hasn't elapsed. The 10s countdown is
        // rendered AS the bubble's border via a conic-gradient
        // driven by `--rt-bubble-user-progress` (0 → 1 over 10s);
        // the inline-text countdown digit was removed so prose
        // can use the bubble's full interior width.
        let bubble = "";
        if (isUser) {
          const ub = this.userBubble;
          if (ub && !ub.dismissed && ub.text && Date.now() < ub.deadline) {
            const elapsed = this.USER_BUBBLE_TTL_MS - (ub.deadline - Date.now());
            const progress = Math.min(1, Math.max(0, elapsed / this.USER_BUBBLE_TTL_MS));
            bubble = `<div class="rt-bubble rt-bubble-user" data-rt-user-bubble style="--rt-bubble-user-progress: ${progress.toFixed(3)}">` +
              `<span class="rt-bubble-user-text">${this.escape(ub.text)}</span>` +
              `<button type="button" class="rt-bubble-user-close" data-rt-user-bubble-close aria-label="Dismiss">✕</button>` +
              `</div>`;
          }
        } else if (isChair && this.chairBubble && !this.chairBubble.dismissed
            && this.chairBubble.text && Date.now() < this.chairBubble.deadline) {
          // Chair clarify question · pinned to the chair seat with
          // border countdown. Takes precedence over the "Speaking"
          // status bubble since the chair has already finished its
          // turn at this point (message-final flipped streaming off).
          const cb = this.chairBubble;
          const elapsed = this.CHAIR_BUBBLE_TTL_MS - (cb.deadline - Date.now());
          const progress = Math.min(1, Math.max(0, elapsed / this.CHAIR_BUBBLE_TTL_MS));
          bubble = `<div class="rt-bubble rt-bubble-chair-clarify" data-rt-chair-bubble style="--rt-bubble-chair-progress: ${progress.toFixed(3)}">` +
            `<span class="rt-bubble-chair-clarify-text">${this.escape(cb.text)}</span>` +
            `<button type="button" class="rt-bubble-chair-clarify-close" data-rt-chair-bubble-close aria-label="Dismiss">✕</button>` +
            `</div>`;
        } else if (isSpeaking) {
          bubble = `<div class="${bubbleCls}"><span class="rt-bubble-name">${this.escape(m.name || "")}</span><span class="rt-bubble-status">${this.escape(statusWord)}</span><span class="rt-bubble-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>`;
        }
        const badge = (isQueued && !isSpeaking)
          ? `<div class="rt-badge">${String(qIdx + 1).padStart(2, "0")}</div>`
          : "";

        // Vote popover on the chair seat · single voice-mode surface
        // for both phases of the vote flow:
        //   (A) round-prompt phase · chair has just prompted at round
        //       wrap; popover shows [Open vote] [Continue] [Adjourn].
        //   (B) round-end vote phase · awaitingContinue === true;
        //       popover shows the 3 key-points + Continue / Adjourn
        //       AFTER the chair has finished its TTS turn.
        // The popover is suppressed while the chair is mid-presenting
        // (preparing, streaming text, or audio still playing). The
        // user wants to hear the chair speak first, THEN see the
        // panel — without this gate the panel popped up under the
        // chair's voice and split the user's attention.
        const hasActivePrompt = (typeof this.activeRoundPromptId === "function")
          ? !!this.activeRoundPromptId()
          : false;
        const isChairBusy = (() => {
          if (this.chairPending === true) return true;
          // Chair message landed but voice synthesis hasn't reached
          // the client yet · the popover would otherwise flash for
          // 0.5-2s before audio kicks in. See `_chairVoiceAwaiting`
          // doc + the message-appended hook for the full reasoning.
          if (this._chairVoiceAwaiting && this._chairVoiceAwaiting.size > 0) return true;
          const allMsgs = this.currentMessages || [];
          for (let k = allMsgs.length - 1; k >= 0; k--) {
            const mm = allMsgs[k];
            if (!mm || mm.authorKind !== "agent") continue;
            // Most recent agent turn · streaming text OR active voice
            // playback counts as "busy". Voice queues stay live for
            // templated chair messages too (announceRoundPrompt), so
            // this catches round-prompt voice as well as the LLM
            // round-end stream.
            if (mm.meta && mm.meta.streaming === true) return true;
            if (this.voiceQueues && this.voiceQueues[mm.id]) return true;
            return false;
          }
          return false;
        })();
        const showVotePop = isChair && this.currentRoom
          && this.currentRoom.status !== "adjourned"
          && (this.currentRoom.awaitingContinue === true || hasActivePrompt)
          && !isChairBusy;
        const votePop = showVotePop ? this.renderRoundTableVotePop() : "";

        // Seats whose y is below the stage midline (chair + any
        // front-row directors) get `rt-seat-below`. CSS flips the
        // name plate to sit BELOW the chair sprite for these so
        // names of front-row seats don't land on the table surface
        // and obscure the props.
        const isBelow = seat.y > 50;
        const cls = [
          "rt-seat",
          isChair ? "rt-seat-chair" : (isUser ? "rt-seat-user" : "rt-seat-director"),
          isSpeaking ? "rt-seat-speaking" : "",
          isSpeaking && speakerState === "thinking" ? "rt-seat-thinking" : "",
          showVotePop ? "rt-seat-voting" : "",
          isBelow ? "rt-seat-below" : "",
        ].filter(Boolean).join(" ");

        // Inline style carries position + scaleHint + stagger index.
        const style = [
          `left: ${seat.x.toFixed(2)}%`,
          `top: ${seat.y.toFixed(2)}%`,
          `--rt-scale: ${seat.scaleHint.toFixed(3)}`,
          `--seat-i: ${i}`,
        ].join("; ");

        // Wait-marker · only on the user seat, only when the user
        // has picked "wait — flush after current speaker finishes"
        // (pendingUserMessage is set). Reads as a small pixel pill
        // anchored to the seat so a glance at the table answers
        // "is my queued message still parked?" — clears the moment
        // the message-appended SSE for the user's body lands.
        const waitMark = (isUser && this.pendingUserMessage)
          ? `<div class="rt-seat-wait-mark" aria-label="Waiting for current speaker to finish">⌛&nbsp;WAIT</div>`
          : "";

        return `
          <div class="${cls}" data-seat-index="${i}" data-agent-id="${this.escape(m.id)}" style="${style}">
            ${chairSvg}
            ${avatar}
            ${bubble}
            ${badge}
            ${waitMark}
            ${name}
            ${votePop}
          </div>
        `;
      }).join("");

      // Empty state · no directors yet.
      const empty = members.length <= 1
        ? `<div class="rt-empty"><span>// awaiting directors</span></div>`
        : "";

      seatsHost.innerHTML = html + empty;

      // Update aria-label to keep screen readers in sync with the
      // visual state · the speaking-queue strip below remains the
      // canonical accessible source of truth, this is just a hint.
      const speaker = members.find((m) => m.id === speakingId);
      const queuedNames = (this.currentQueue || [])
        .slice(1)
        .map((q) => (this.agentsById && this.agentsById[q.agentId]) ? this.agentsById[q.agentId].name : null)
        .filter(Boolean);
      const stageBase = this._t("rt_aria_stage");
      let aria = stageBase;
      if (speaker) {
        aria += " · " + this._t("rt_aria_speaking", { name: speaker.name });
      } else {
        aria += " · " + this._t("rt_aria_idle");
      }
      if (queuedNames.length) {
        aria += " · " + this._t("rt_aria_queue", { names: queuedNames.join(", ") });
      }
      stage.setAttribute("aria-label", aria);

      // Persistent HUD repaint · cheap (single template literal +
      // innerHTML write) and the data sources are the same room
      // state already consulted above. Always called on round-table
      // re-render so the stat block stays in sync with round /
      // member / vote changes that don't fire toasts.
      this.renderRoundTableHud();
      // Live subtitle · keep in sync with the same speaker-detection
      // signals the seats use. Repaints triggered from message-token
      // already call renderRtSubtitle directly to bypass the full
      // seat re-render cost; this call covers queue-update / config-
      // event / SSE hello cases that flow through renderRoundTable.
      this.renderRtSubtitle();
    },

    /** Paint the top-left HUD console · gamified RPG-style status
     *  window with pixel corner welds, a pulsing live LED, a colour-
     *  keyed state pill (LIVE / VOTE / PAUSE / WAIT / DONE), three
     *  glowing tabular-num stats (ROUND / VOTES / SEATS) each with a
     *  5-pip progress row underneath, and a rolling chair-ops log
     *  fed from showRoundTableToast.
     *  Idempotent and bail-fast: no-op when the HUD root isn't in
     *  the DOM (chat view, no room loaded). The HUD lives inside
     *  `.roundtable-stage`, so it's automatically hidden by the
     *  stage's `[hidden]` attribute when in chat view — no separate
     *  visibility gate needed. */
    /** Live subtitle · paints the speaker's name + the tail of their
     *  body text into the `[data-rt-subtitle]` panel pinned to the
     *  bottom of the round-table stage. Cheap DOM update only — no
     *  full re-render — so it's safe to call from the message-token
     *  hot path. Hides itself when no one is mid-stream and no voice
     *  queue is active. */
    renderRtSubtitle() {
      const slot = document.querySelector("[data-rt-subtitle]");
      if (!slot) return;
      const msgs = this.currentMessages || [];
      let speakerId = null;
      let body = "";
      let activeQueue = null;     // voice queue for the speaker, if any
      let isStreaming = false;
      // (0) Voice-replay override · adjourned-room transcript playback
      //     has no live `streaming` / voiceQueue signals (the room is
      //     done). When replay is active, surface its current message
      //     body as the subtitle source so the stage's caption bar
      //     tracks the playback. Falls through when replay is off.
      const replayActive = (typeof window !== "undefined"
        && window.boardroomVoiceReplay
        && typeof window.boardroomVoiceReplay.getActive === "function")
        ? window.boardroomVoiceReplay.getActive()
        : null;
      let replayAudio = null;
      if (replayActive && replayActive.authorId && replayActive.body) {
        speakerId = replayActive.authorId;
        body = replayActive.body;
        isStreaming = false;
        // Replay's audio is a single full-message clip · use its
        // currentTime / duration to interpolate the cursor inside
        // body so the subtitle picks the right sentence.
        if (typeof window.boardroomVoiceReplay.getActiveAudio === "function") {
          replayAudio = window.boardroomVoiceReplay.getActiveAudio() || null;
        }
      }
      // (1) Most recent streaming agent message · authoritative for
      //     text-mode and the streaming phase of voice-mode turns.
      if (!speakerId) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m && m.meta && m.meta.streaming === true && m.authorKind === "agent") {
            speakerId = m.authorId;
            body = m.body || "";
            isStreaming = true;
            if (this.voiceQueues && this.voiceQueues[m.id]) {
              activeQueue = this.voiceQueues[m.id];
            }
            break;
          }
        }
      }
      // (2) Fallback · stream finished but voice clip is still
      //     playing (voice queue not yet drained). Keep the caption
      //     up so the user reads while listening. Catches chair
      //     templated voice (announceRoundPrompt / announceIntervention)
      //     too — those emit voice without setting meta.streaming.
      if (!speakerId && this.voiceQueues) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (!m || m.authorKind !== "agent") continue;
          if (this.voiceQueues[m.id]) {
            speakerId = m.authorId;
            body = m.body || "";
            activeQueue = this.voiceQueues[m.id];
            break;
          }
        }
      }
      if (!speakerId) {
        slot.hidden = true;
        slot.innerHTML = "";
        return;
      }
      const speaker = this.agentsById[speakerId];
      if (!speaker) {
        slot.hidden = true;
        slot.innerHTML = "";
        return;
      }
      // Clean the body for plain-text caption · drop markdown
      // emphasis / leading hashes / list bullets so the user reads
      // the words, not the syntax. Then keep only the tail (the
      // most recent ~240 chars) so the line-clamp lands on the
      // freshest content.
      const text = String(body || "")
        .replace(/\*+/g, "")
        .replace(/^#+\s*/gm, "")
        .replace(/^[-*]\s+/gm, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) {
        slot.hidden = true;
        slot.innerHTML = "";
        return;
      }
      // Caption picker · use the EXACT playback-time range for each
      // chunk, captured by reading `SourceBuffer.buffered.end()` on
      // every `updateend`. Each caption's `endTime` is the absolute
      // playback second at which that chunk's audio finishes. So
      // the chunk currently playing is the FIRST one whose
      // `endTime > audio.currentTime`. This sidesteps every CBR /
      // bitrate-uniformity assumption from the previous byte-offset
      // approach — the times come from the actual decoded audio
      // timeline, not estimates.
      let visible = "";
      const captions = activeQueue && activeQueue.captions;
      const audio = activeQueue && activeQueue.audio;
      if (captions && captions.length > 0 && audio) {
        const t = audio.currentTime;
        let pickIdx = -1;
        for (let i = 0; i < captions.length; i++) {
          const end = captions[i].endTime;
          if (end !== null && end !== undefined && t < end) {
            pickIdx = i;
            break;
          }
        }
        if (pickIdx === -1) {
          // No chunk found whose endTime is ahead of currentTime ·
          // either we're past the last appended chunk's range (use
          // last chunk's text · audio is wrapping up its tail), or
          // no chunk has its endTime captured yet (audio just
          // started). Either way, fall back to the most recent
          // caption with text.
          for (let i = captions.length - 1; i >= 0; i--) {
            if (captions[i].text) { pickIdx = i; break; }
          }
        }
        if (pickIdx >= 0) {
          visible = (captions[pickIdx] && captions[pickIdx].text) || "";
        }
      }
      // Replay-mode picker · the replay player drives a single full-
      // message audio clip (no chunked stream), so we estimate the
      // text cursor from `audio.currentTime / audio.duration`.
      // Sentence containing that cursor is shown · TTS is roughly
      // uniform across a single message, so this approximation
      // tracks well enough for a caption to feel synced.
      if (!visible && replayAudio && isFinite(replayAudio.duration) && replayAudio.duration > 0) {
        const parts = [];
        const re = /[^。！？.!?；;\n]+[。！？.!?；;\n]?/g;
        let mtch;
        while ((mtch = re.exec(text)) !== null) {
          const s = mtch[0].trim();
          if (s) parts.push(s);
        }
        if (parts.length > 0) {
          const progress = Math.max(0, Math.min(1, replayAudio.currentTime / replayAudio.duration));
          const cursor = Math.floor(text.length * progress);
          let acc = 0;
          let pickIdx = parts.length - 1;
          for (let i = 0; i < parts.length; i++) {
            acc += parts[i].length;
            if (acc >= cursor) { pickIdx = i; break; }
          }
          visible = parts[pickIdx];
        } else {
          visible = text;
        }
      }
      // Streaming / text-only fallback · split body on sentence-
      // final punctuation, pick the last sentence we have so the
      // caption stays current as tokens arrive.
      if (!visible) {
        const parts = [];
        const re = /[^。！？.!?；;\n]+[。！？.!?；;\n]?/g;
        let mtch;
        while ((mtch = re.exec(text)) !== null) {
          const s = mtch[0].trim();
          if (s) parts.push(s);
        }
        visible = parts.length ? parts[parts.length - 1] : text;
      }
      slot.hidden = false;
      slot.innerHTML =
        `<span class="rt-sub-kicker">${this.escape(speaker.name || "")}</span>` +
        `<p class="rt-sub-text">${this.escape(visible.trim())}</p>`;
    },

    renderRoundTableHud() {
      const host = document.querySelector("[data-rt-hud]");
      if (!host) return;
      // Round number · highest roundNum seen in the transcript.
      // Falls back to 0 (rendered as "—") before any director has
      // spoken in round 1.
      let roundNum = 0;
      const msgs = this.currentMessages || [];
      for (const m of msgs) {
        if (typeof m.roundNum === "number" && m.roundNum > roundNum) roundNum = m.roundNum;
      }
      // Vote count · key points the user has cast a vote on. Toggling
      // off decrements; reflects current active votes.
      const voteCount = (this.currentKeyPoints || []).filter((p) => p && p.vote != null).length;
      // Seat count · directors + chair (matches the round-table
      // stage's actual seat ring).
      const seatCount = (this.roundTableMembers ? this.roundTableMembers().length : 0);

      // Room-state pill · key off the same flags that gate UI input
      // elsewhere so the HUD's phase reading never disagrees with
      // what the chat / queue surface is doing. Voice-replay wins
      // over the room status: when the user has the replay overlay
      // open, the HUD must read REPLAY so they understand the
      // animated speaking seat / subtitle is playback, not live
      // activity (the room is genuinely adjourned underneath).
      let stateLabel = "LIVE";
      let stateKind = "live";
      const r = this.currentRoom;
      if (r) {
        if (r.status === "paused")        { stateLabel = "PAUSE"; stateKind = "pause"; }
        else if (r.status === "adjourned"){ stateLabel = "DONE";  stateKind = "done";  }
        else if (r.awaitingClarify)       { stateLabel = "WAIT";  stateKind = "wait";  }
        else if (r.awaitingContinue)      { stateLabel = "VOTE";  stateKind = "vote";  }
      }
      const replayOn = !!(typeof window !== "undefined"
        && window.boardroomVoiceReplay
        && typeof window.boardroomVoiceReplay.isOpen === "function"
        && window.boardroomVoiceReplay.isOpen());
      if (replayOn) {
        stateLabel = "REPLAY";
        stateKind = "replay";
      }

      const fmt = (n) => (n > 0 ? String(n).padStart(2, "0") : "—");
      // 5-pip progress row · `n` pips lit (capped at 5). Used for
      // the JRPG HP/MP feel beneath each stat numeral.
      const pips = (n, max = 5) => {
        const filled = Math.min(Math.max(0, n), max);
        let s = "";
        for (let i = 0; i < max; i++) {
          s += `<span class="rt-hud-pip${i < filled ? " is-on" : ""}"></span>`;
        }
        return s;
      };

      const stats = `
        <div class="rt-hud-stats">
          <div class="rt-hud-stat">
            <span class="rt-hud-stat-label">Round</span>
            <span class="rt-hud-stat-value">${fmt(roundNum)}</span>
            <span class="rt-hud-pips" aria-hidden="true">${pips(roundNum)}</span>
          </div>
          <div class="rt-hud-stat">
            <span class="rt-hud-stat-label">Votes</span>
            <span class="rt-hud-stat-value">${fmt(voteCount)}</span>
            <span class="rt-hud-pips" aria-hidden="true">${pips(voteCount)}</span>
          </div>
          <div class="rt-hud-stat">
            <span class="rt-hud-stat-label">Seats</span>
            <span class="rt-hud-stat-value">${fmt(seatCount)}</span>
            <span class="rt-hud-pips" aria-hidden="true">${pips(Math.max(0, seatCount - 1))}</span>
          </div>
        </div>
      `;

      const log = (this.rtChairLog || []).slice(0, 6);
      const logHtml = log.length === 0
        ? `<div class="rt-hud-log-empty">// awaiting events</div>`
        : log.map((e) => `
            <div class="rt-hud-log-entry rt-hud-log-${this.escape(e.kind || "settings")}">
              <span class="rt-hud-log-glyph" aria-hidden="true">${this.escape(e.glyph || "·")}</span>
              <span class="rt-hud-log-text">${e.htmlText || ""}</span>
            </div>
          `).join("");

      // Voice-mode rate control · only renders when the room is
      // actually voice-mode (otherwise the button does nothing
      // useful). Reads the lazy state via voicePlaybackRate().
      const isVoice = !!(this.currentRoom && this.currentRoom.deliveryMode === "voice");
      const rate = this.voicePlaybackRate();
      const rateLabel = (rate === 1 ? "1.0" : String(rate)) + "X";
      const rateRow = isVoice
        ? `
          <div class="rt-hud-controls">
            <button type="button" class="rt-hud-rate-btn" data-rt-hud-rate
                title="Click to change voice playback speed">
              <span class="rt-hud-rate-label">Rate</span>
              <span class="rt-hud-rate-value">${this.escape(rateLabel)}</span>
            </button>
          </div>
        `
        : "";

      // Collapse state · `is-collapsed` modifier hides stats / rate /
      // log via CSS, leaving only the header strip. Toggle button in
      // the header reads `−` when expanded (action: collapse) and
      // `+` when collapsed (action: expand).
      const collapsed = this.hudCollapsed();
      host.classList.toggle("is-collapsed", collapsed);
      const toggleGlyph = collapsed ? "+" : "−";
      const toggleTitle = collapsed ? "Expand status panel" : "Collapse status panel";

      host.innerHTML = `
        <span class="rt-hud-corner rt-hud-corner-tl" aria-hidden="true"></span>
        <span class="rt-hud-corner rt-hud-corner-tr" aria-hidden="true"></span>
        <div class="rt-hud-head">
          <span class="rt-hud-led" aria-hidden="true"></span>
          <span class="rt-hud-title">Status</span>
          <span class="rt-hud-state rt-hud-state-${this.escape(stateKind)}">${this.escape(stateLabel)}</span>
          <button type="button" class="rt-hud-toggle-btn" data-rt-hud-toggle
              title="${this.escape(toggleTitle)}"
              aria-expanded="${collapsed ? "false" : "true"}"
              aria-label="${this.escape(toggleTitle)}">${toggleGlyph}</button>
        </div>
        ${stats}
        ${rateRow}
        <div class="rt-hud-log">${logHtml}</div>
      `;
    },

    /** Toggle .chat vs .roundtable-stage visibility based on:
     *    (a) room.deliveryMode === "voice"
     *    (b) room.status === "live"
     *    (c) the user hasn't toggled to transcript view this session.
     *  Both elements stay mounted; only [hidden] flips. The
     *  `applyTo` arg defaults to currentRoomId. Also re-paints the
     *  toggle button label since it reflects the current view. */
    applyRoundTableVisibility(applyTo) {
      const roomId = applyTo || this.currentRoomId;
      if (!roomId) return;
      const stage = document.querySelector("[data-roundtable-stage]");
      const chat  = document.querySelector(".chat-col > .chat");
      if (!stage || !chat) return;
      const room = this.currentRoom;
      // Eligibility · two paths:
      //   (A) voice-mode room (live / paused / adjourned) · the
      //       toggle flips between round-table stage and transcript.
      //   (B) text-mode room that's still active (live / paused) ·
      //       the toggle ENABLES voice mode (PATCHes deliveryMode).
      //       This was the user-flagged gap: rooms convened in text
      //       mode had no in-room affordance to switch to voice.
      // Both paths share the same `[data-room-rt-toggle]` button; the
      // click handler (toggleRoomViewMode) inspects deliveryMode and
      // dispatches accordingly.
      const isVoiceRoom = !!(
        room &&
        room.deliveryMode === "voice" &&
        (room.status === "live" || room.status === "paused" || room.status === "adjourned")
      );
      const canFlipToVoice = !!(
        room &&
        room.deliveryMode !== "voice" &&
        (room.status === "live" || room.status === "paused" || room.status === "adjourned")
      );
      const eligible = isVoiceRoom || canFlipToVoice;
      // View default depends on room status:
      //   · live / paused → STAGE by default. The user is mid-room
      //     and the gameified seats / live speaker bubble are the
      //     point of voice mode. Opt out by toggling to transcript
      //     (writes "chat" to localStorage).
      //   · adjourned → CHAT (transcript) by default. The room is
      //     done; the artifact is the conversation, not an empty
      //     stage with no live speaker. Opt INTO stage (writes
      //     "stage") if the user wants to see the seat snapshot.
      // This is a behavioural fix for "I open an adjourned voice
      // room and just see an empty wood-floor stage with no seats
      // / no transcript" — the user perceived an empty body. The
      // adjourn-on-voice flow already auto-writes "chat" via
      // `confirmAdjourn`, but pre-existing adjourned rooms (or any
      // room where localStorage was cleared) hit the old default.
      const stored = (() => {
        try { return localStorage.getItem("rt-view-" + roomId); }
        catch { return null; }
      })();
      const isAdjourned = !!(room && room.status === "adjourned");
      // Stage visibility is only meaningful for voice rooms · a text
      // room's button is a "switch to voice" affordance, the chat
      // stays visible until the user actually flips deliveryMode.
      const showStage = (() => {
        if (!isVoiceRoom) return false;
        if (isAdjourned) return stored === "stage"; // opt-in
        return stored !== "chat";                    // opt-out
      })();
      if (showStage) {
        stage.hidden = false;
        chat.hidden = true;
        // Repaint the stage now that it's visible so positions
        // are computed against the actual layout box.
        this.renderRoundTable();
      } else {
        stage.hidden = true;
        chat.hidden = false;
      }
      // Voice-mode round-end vote overlay tracks the stage's
      // visibility — open it when the user is on the stage AND the
      // room is in awaiting-continue, drop it otherwise. Safe to call
      // every visibility flip; the function is idempotent.
      this.refreshRtVoteOverlay();
      // Sync the toggle button if mounted. The button lives inline
      // in the input-bar (between session-control icons and the
      // input pill) and is gated by [hidden] when the room isn't
      // voice + live. innerHTML is the framed glyph slot + a hover
      // preview popover whose SVG diagram sketches the destination
      // view (round-table circle of dots / transcript stack of
      // lines). aria-pressed flips so the active-aura CSS engages.
      // Two static toggle buttons share `data-room-rt-toggle` ·
      // one in .input-bar (live state, .paused-bar is display:none),
      // one in .paused-bar (paused state, .input-bar is display:none).
      // Update BOTH via querySelectorAll so the user sees the right
      // toggle whichever bar is currently visible. Only one is ever
      // user-visible at a time (the other's parent is display:none).
      const btns = document.querySelectorAll("[data-room-rt-toggle]");
      btns.forEach((b) => { b.hidden = !eligible; });
      if (eligible) {
        const inStage = showStage;
        // Label semantics depend on whether we're in voice mode yet:
        //   · voice + stage visible → "Transcript" (clicking goes there)
        //   · voice + chat visible  → "Round table" (clicking goes there)
        //   · text mode             → "Voice mode" (clicking enables it)
        const destLabelKey = !isVoiceRoom
          ? "rt_toggle_enable_voice"
          : (inStage ? "rt_toggle_transcript" : "rt_toggle_roundtable");
        const destLabel = this._t(destLabelKey);
        // Inline-SVG glyphs · NO emoji. currentColor inherits the
        // lime accent from .ib-rt-glyph so a single rule themes both
        // states. Transcript = a page with folded top-right corner
        // and two text lines inside (reads as "written record /
        // document"; the previous 3-stacked-lines glyph was too
        // close to a hamburger-menu icon). Round-table = central
        // circle ringed by 5 dots (reads as a seated cast).
        const transcriptGlyphSvg =
          `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
          + `<path d="M3 2 H10 L13 5 V14 H3 Z" />`
          + `<path d="M10 2 V5 H13" />`
          + `<line x1="5.5" y1="8.5" x2="10.5" y2="8.5" />`
          + `<line x1="5.5" y1="11"  x2="9"    y2="11" />`
          + `</svg>`;
        const roundTableGlyphSvg =
          `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true">`
          + `<circle cx="8"    cy="8"    r="4.6" />`
          + `<circle cx="8"    cy="2"    r="1.3" fill="currentColor" stroke="none" />`
          + `<circle cx="13.5" cy="6.2"  r="1.3" fill="currentColor" stroke="none" />`
          + `<circle cx="11.4" cy="13.4" r="1.3" fill="currentColor" stroke="none" />`
          + `<circle cx="4.6"  cy="13.4" r="1.3" fill="currentColor" stroke="none" />`
          + `<circle cx="2.5"  cy="6.2"  r="1.3" fill="currentColor" stroke="none" />`
          + `</svg>`;
        // In text mode the destination is "voice / round-table" —
        // the icon should preview the round-table cast like the
        // chat-view-of-a-voice-room case. inStage being false in
        // that case (no stage to be in) gives the right glyph.
        const currentGlyphSvg = (isVoiceRoom && inStage) ? transcriptGlyphSvg : roundTableGlyphSvg;
        // Hover preview SVG · 5-dot circle for round-table,
        // page-with-folded-corner for transcript. These are the
        // DESTINATION sketches, not the current view's.
        const previewSvg = (isVoiceRoom && inStage)
          ? `<svg class="ib-rt-preview-svg" viewBox="0 0 60 30" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
            + `<path class="rt-prev-stroke" d="M20 4 H36 L42 10 V26 H20 Z" />`
            + `<path class="rt-prev-stroke" d="M36 4 V10 H42" />`
            + `<line class="rt-prev-stroke" x1="24" y1="14" x2="38" y2="14" />`
            + `<line class="rt-prev-stroke" x1="24" y1="18" x2="34" y2="18" />`
            + `<line class="rt-prev-stroke" x1="24" y1="22" x2="36" y2="22" />`
            + `</svg>`
          : `<svg class="ib-rt-preview-svg" viewBox="0 0 60 30" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
            + `<circle class="rt-prev-stroke" cx="30" cy="15" r="11" />`
            + `<circle class="rt-prev-fill"   cx="30" cy="4"  r="2.4" />`
            + `<circle class="rt-prev-fill"   cx="40.5" cy="10" r="2.4" />`
            + `<circle class="rt-prev-fill"   cx="36.5" cy="22" r="2.4" />`
            + `<circle class="rt-prev-fill"   cx="23.5" cy="22" r="2.4" />`
            + `<circle class="rt-prev-fill"   cx="19.5" cy="10" r="2.4" />`
            + `</svg>`;
        const innerHTML =
          `<span class="ib-rt-glyph" aria-hidden="true">${currentGlyphSvg}</span>` +
          `<div class="ib-rt-preview" role="tooltip" aria-hidden="true" data-rt-preview>` +
            `<div class="ib-rt-preview-kicker">// ${this.escape(destLabel)}</div>` +
            previewSvg +
            `<div class="ib-rt-preview-foot">press ▸</div>` +
          `</div>`;
        btns.forEach((btn) => {
          btn.innerHTML = innerHTML;
          // Aria-pressed reflects "round-table view active" not the
          // toggle's destination · `inStage` is the active state.
          btn.setAttribute("aria-pressed", inStage ? "true" : "false");
          btn.setAttribute("aria-label", destLabel);
          btn.setAttribute("title", "");
          // Bind hover handlers DIRECTLY to the button. We tried
          // document-level mouseover delegation first but it was
          // unreliable in this layout (CSS :hover wasn't engaging
          // either). mouseenter doesn't bubble, but firing direct
          // on the button with `getBoundingClientRect()` taken
          // inside the handler guarantees correct position +
          // visibility on every hover.
          const preview = btn.querySelector("[data-rt-preview]");
          if (!preview) return;
          const showPreview = () => {
            const r = btn.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            const previewW = preview.offsetWidth || 132;
            const previewH = preview.offsetHeight || 80;
            preview.style.left = `${Math.round(r.left + r.width / 2 - previewW / 2)}px`;
            preview.style.top = `${Math.round(r.top - previewH - 8)}px`;
            preview.style.bottom = "auto";
            preview.style.right = "auto";
            preview.style.opacity = "1";
            preview.style.visibility = "visible";
            preview.style.transform = "translateY(0)";
          };
          const hidePreview = () => {
            preview.style.opacity = "0";
            preview.style.visibility = "hidden";
            preview.style.transform = "translateY(6px)";
          };
          btn.addEventListener("mouseenter", showPreview);
          btn.addEventListener("mouseleave", hidePreview);
          btn.addEventListener("focus", showPreview);
          btn.addEventListener("blur", hidePreview);
        });
      }
    },

    /** Toggle handler · click of the [📝 transcript] / [♟ round-table]
     *  button in the room head. Behaviour depends on the current
     *  room's delivery mode:
     *    · text mode → flip to voice mode (PATCH deliveryMode), then
     *      land on the round-table stage (the user's clear intent
     *      when they pressed the toggle on a text room). If the
     *      user has no voice provider key, deep-link to user-
     *      settings → keys instead of silently failing.
     *    · voice mode → flip between round-table and transcript view
     *      (writes localStorage scoped by roomId so the user's last
     *      view sticks across reloads). Default-on-first-open is
     *      still round-table for live/paused, transcript for
     *      adjourned.
     */
    toggleRoomViewMode() {
      const roomId = this.currentRoomId;
      if (!roomId) return;
      const room = this.currentRoom;
      // Text-mode → enable voice mode. Calls toggleDeliveryMode()
      // regardless of room status; the PATCH route allows delivery-
      // Mode-only patches on adjourned rooms (every other field
      // change is still rejected with 409 to keep the archive
      // frozen). After the flip, applyRoundTableVisibility re-paints
      // with the stage available; no localStorage write needed
      // because the per-status default (stage for live/paused,
      // transcript for adjourned) matches user intent.
      if (room && room.deliveryMode !== "voice") {
        if (typeof this.hasAnyVoiceKey === "function" && !this.hasAnyVoiceKey()) {
          if (typeof window.openUserSettings === "function") {
            window.openUserSettings({ section: "keys", focusProvider: "minimax" });
          }
          return;
        }
        this.toggleDeliveryMode();
        return;
      }
      // The toggle inverts whatever's currently visible. We figure
      // out the next state by re-reading the same logic
      // applyRoundTableVisibility uses, then write the explicit
      // value ("chat" or "stage") so the next render picks the
      // user's choice regardless of the per-status default.
      const isAdjourned = !!(room && room.status === "adjourned");
      let stored;
      try { stored = localStorage.getItem("rt-view-" + roomId); }
      catch { stored = null; }
      const isStageNow = isAdjourned ? (stored === "stage") : (stored !== "chat");
      const next = isStageNow ? "chat" : "stage";
      try { localStorage.setItem("rt-view-" + roomId, next); }
      catch { /* private mode etc · silently ignored */ }
      this.applyRoundTableVisibility(roomId);
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
      // CJK-dominant docs: count chars (the "字数" the user reads off
      // a manuscript). The 30% threshold catches mixed zh-en docs
      // where the body is mostly Chinese with English brand names —
      // the natural unit there is still characters, not words.
      if (cjkCount >= stripped.length * 0.3 && cjkCount > 80) {
        const fmt = cjkCount.toLocaleString("en-US");
        return this._t("brief_wc_approx_chars", { n: fmt });
      }
      // English / Latin: whitespace-split, ignore empty tokens.
      const words = stripped.trim().split(/\s+/).filter((w) => w.length > 0);
      const n = words.length;
      if (n === 0) return null;
      const fmt = n.toLocaleString("en-US");
      return n === 1 ? this._t("brief_wc_one_word") : this._t("brief_wc_words", { n: fmt });
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
      // System UI · always English (brief-version tab strip chrome).
      return `
        <div class="brief-versions">
          ${sortedBriefs.map((bf, i) => {
            const isActive = activeBrief && bf.id === activeBrief.id;
            const num = String(i + 1).padStart(2, "0");
            const isInitial = i === 0;
            const supp = bf.supplement && bf.supplement.trim()
              ? bf.supplement.trim()
              : (isInitial ? this._t("brief_tab_initial") : "");
            const tooltip = isInitial
              ? this._t("brief_tab_tooltip_initial")
              : `${this._t("brief_tab_supplement_prefix")}${supp || "—"}`;
            const closeTitle = this._t("brief_tab_delete_title");
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
                    ? `<span class="brief-version-label">${this.escape(this._t("brief_tab_initial"))}</span>`
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
          (x) => x && x.id !== b.id && !x.error && this.briefHasBody(x),
        );
        if (goodBrief) {
          const failed = b;
          const prevCurrent = this.currentBrief;
          this.currentBrief = goodBrief;
          try { this.renderBrief(); }
          finally { this.currentBrief = prevCurrent; }
          // Prepend the compact retry banner to the rendered card so
          // the existing report stays fully visible below it.
          const detail = failed.timedOut
            ? this._t("brief_regen_timeout")
            : failed.interrupted
              ? this._t("brief_regen_interrupted")
              : (failed.error || this._t("brief_regen_failed"));
          const cta = this._t("brief_retry");
          const dismiss = this._t("brief_dismiss");
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
        const copy = b.timedOut
          ? {
              stamp: this._t("brief_err_stamp_timeout"),
              kicker: this._t("brief_err_kicker_timeout"),
              detail: this._t("brief_err_detail_timeout"),
              hint: "",
              cta: this._t("brief_retry"),
            }
          : b.interrupted
            ? {
                stamp: this._t("brief_err_stamp_interrupted"),
                kicker: this._t("brief_err_kicker_interrupted"),
                detail: this._t("brief_err_detail_interrupted"),
                hint: "",
                cta: this._t("brief_err_cta_regenerate"),
              }
            : {
                stamp: this._t("brief_err_stamp_failed"),
                kicker: this._t("brief_err_kicker_failed"),
                detail: this.escape(b.error || ""),
                hint: this._briefSecondaryHintHtml(b.error || ""),
                cta: this._t("brief_retry"),
              };
        card.innerHTML = `
          <div class="brief-card">
            ${tabsStripHtml}
            <div class="brief-body brief-body-error">
              <div class="brief-kicker" style="color: var(--red);">${this.escape(copy.kicker)} <span class="brief-kicker-sep" aria-hidden="true">·</span> ${this.escape(copy.stamp)} <span class="brief-kicker-sep" aria-hidden="true">·</span> <span class="brief-meta-type">${this.escape(this.briefModeLabel(b))}</span></div>
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

      const generating = b.isGenerating === true || !this.briefHasBody(b) || b.title === "Generating…";
      const signed = this.currentMembers
        .map((a) => `<img src="${this.escape(a.avatarPath)}" alt="${this.escape(a.name)}" title="${this.escape(a.name)}">`)
        .join("");

      const filedLabel = generating
        ? this._t("brief_filed_generating")
        : this._t("brief_filed_stamp", {
          when: b.createdAt ? this.timeFmt(b.createdAt) : this.timeFmt(Date.now()),
        });

      // Open Report URL · routes to /magazine.html or /newspaper.html
      // for the structured modes and /report.html for research-note
      // briefs (default). The structured renderers don't need the
      // room id so the URL is shorter for those modes. See
      // briefViewerHref for the routing table.
      const reportHref = this.briefViewerHref(b, this.currentRoomId)
        || (this.currentRoomId ? `/report.html?r=${encodeURIComponent(this.currentRoomId)}` : null);

      // Tab strip — already computed at the top of renderBrief as
      // `tabsStripHtml` so both error and success paths can mount it.
      const tabsHtml = tabsStripHtml;

      // Ceremonial wrapper · the deliverable hits the table inside an
      // ending-block frame.
      card.innerHTML = `
        <header class="ending-block-head">
          <span class="ending-block-line"></span>
          <span class="ending-block-label">${this.escape(this._t("brief_output_head"))}</span>
          <span class="ending-block-line"></span>
        </header>

        <div class="brief-card">
          ${tabsHtml}

          <div class="brief-body">
            ${generating
              ? `<div class="brief-info brief-info-generating">${this.renderBriefStages(b)}</div>`
              : (() => {
                  const wc = this._briefWordCount(b);
                  // Tucked the mode chip into the meta-row alongside
                  // authors / word count. The earlier `.brief-banner`
                  // strip (kicker + chip + stamp) was retired — the
                  // user found it ate too much vertical space for
                  // info that's already implied by the surrounding
                  // adjourned-room context.
                  const filedAgo = b.createdAt ? this.relTime(b.createdAt) : "";
                  const filedKicker = this._t("brief_filed_by", {
                    name: this.currentChair?.name ? this.escape(this.currentChair.name) : this._t("brief_chair_fallback"),
                  });
                  const kickerLine = filedAgo
                    ? `${filedKicker} <span class="brief-kicker-sep" aria-hidden="true">·</span> ${this.escape(filedAgo)}`
                    : filedKicker;
                  return `<div class="brief-info">
                    <div class="brief-kicker">${kickerLine}</div>
                    <h2 class="brief-title" data-brief-title>${this.escape(b.title || this._t("brief_untitled"))}</h2>
                    <div class="brief-meta-row">
                      <span class="brief-meta-line">${this.escape(this._t("brief_meta_authors", { n: this.currentMembers.length }))}</span>
                      ${wc ? `<span class="brief-meta-sep" aria-hidden="true">·</span><span class="brief-meta-line brief-meta-words">${this.escape(wc)}</span>` : ""}
                      <span class="brief-meta-sep" aria-hidden="true">·</span>
                      <span class="brief-meta-type">${this.escape(this.briefModeLabel(b))}</span>
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
                <span class="brief-open-label">${this.escape(this._t("brief_open_report"))}</span>
                <span class="brief-open-arrow">→</span>
              </a>
            ` : ""}
          </div>

          ${!generating ? `
            <div class="brief-supplement-row">
              <button type="button" class="brief-supplement-btn" data-brief-supplement>
                <span class="brief-supplement-mark">+</span>
                <span class="brief-supplement-label">${this.escape(this._t("brief_supplement_btn"))}</span>
              </button>
              <button type="button" class="brief-delete-btn" data-brief-delete data-brief-id="${this.escape(b.id)}" title="${this.escape(this._t("brief_tab_delete_title"))}">
                <span class="brief-delete-mark">⌫</span>
                <span class="brief-delete-label">${this.escape(this._t("brief_delete_label"))}</span>              </button>
            </div>
          ` : ""}
        </div>

        <footer class="ending-block-foot">
          <span class="ending-block-foot-line"></span>
          <span class="ending-block-foot-label">${this.escape(this._t("ending_session_foot"))}</span>
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
          "Surfacing New Questions",
          "Drafting the Strategic Planning Assumption",
          "Polishing the final pass",
        ],
        // Magazine mode · same single-pass chair-LLM call but the
        // emphasis is on editorial cover-line composition rather
        // than infographic compression. Keyed under `magazine-write`
        // and selected at render time when the brief's mode is
        // magazine.
        "magazine-write": [
          "Drafting the cover headline",
          "Writing the subdeck",
          "Picking the 5 numbered cards",
          "Sequencing the 3 setup steps",
          "Selecting why-this-matters reasons",
          "Stamping the masthead byline",
        ],
        // Newspaper mode · same single-pass chair-LLM call but voice
        // shifts to broadsheet front-page journalism. Keyed under
        // `newspaper-write` and selected at render time when the
        // brief's mode is newspaper.
        "newspaper-write": [
          "Setting the banner headline",
          "Writing the subdeck",
          "Filing the three column stories",
          "Drafting the bottom-line callout",
          "Stacking the more-headings sidebar",
          "Stamping the masthead date",
        ],
        // PPT mode · same single-pass chair-LLM call · biases toward
        // slide-friendly short claims and one-idea-per-slide content.
        // Keyed under `ppt-write` and selected at render time when
        // the brief's mode is ppt.
        "ppt-write": [
          "Drafting the cover slide",
          "Sketching the agenda",
          "Writing milestone slides",
          "Compressing recommendations to bullets",
          "Sizing the data callouts",
          "Stamping the closing takeaway",
        ],
      },
      // System UI · always English. The `zh` key is kept as an alias
      // of `en` so any caller indexing BRIEF_SUBSTAGES["zh"] still
      // resolves; brief language no longer changes the substage copy.
      get zh() { return this.en; },
    },

    renderBriefLlmTrace(b) {
      const logs = Array.isArray(b.llmLogs) ? b.llmLogs : [];
      const open = b.llmLogOpen === true;
      const running = logs.filter((l) => l.status === "running").length;
      const failed = logs.filter((l) => l.status === "failed").length;
      const label = open
        ? (b.language === "zh" ? "收起模型流水" : "Hide model stream")
        : (b.language === "zh" ? "查看模型流水" : "View model stream");
      const countText = logs.length
        ? `${logs.length} call${logs.length === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}${failed ? ` · ${failed} failed` : ""}`
        : (b.language === "zh" ? "等待首个调用" : "waiting for first call");
      const button = `
        <button type="button" class="brief-llm-toggle" data-brief-llm-toggle data-brief-id="${this.escape(b.id || "")}" aria-expanded="${open ? "true" : "false"}">
          <span class="brief-llm-toggle-mark">${open ? "−" : "+"}</span>
          <span>${this.escape(label)}</span>
          <span class="brief-llm-toggle-meta">${this.escape(countText)}</span>
        </button>
      `;
      if (!open) return `<div class="brief-llm-trace">${button}</div>`;
      const fmt = (ms) => {
        if (!ms || ms < 0) return "";
        const s = Math.round(ms / 1000);
        return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
      };
      const rows = logs.map((l) => {
        const elapsed = fmt((l.finishedAt || Date.now()) - (l.startedAt || Date.now()));
        const text = (l.text || "").trim();
        const preview = text
          ? this.escape(text)
          : `<span class="brief-llm-empty">${this.escape(b.language === "zh" ? "等待模型输出…" : "waiting for output…")}</span>`;
        const meta = [
          l.modelV || "",
          elapsed,
          typeof l.totalTokens === "number" ? `${l.totalTokens} tok` : "",
        ].filter(Boolean).join(" · ");
        return `
          <div class="brief-llm-row is-${this.escape(l.status || "running")}">
            <div class="brief-llm-row-head">
              <span class="brief-llm-row-title">${this.escape(l.label || l.stage || "LLM call")}</span>
              <span class="brief-llm-row-meta">${this.escape(meta)}</span>
            </div>
            ${l.error ? `<div class="brief-llm-error">${this.escape(l.error)}</div>` : ""}
            <pre class="brief-llm-output">${preview}</pre>
          </div>
        `;
      }).join("");
      return `<div class="brief-llm-trace">${button}<div class="brief-llm-panel">${rows || `<div class="brief-llm-empty">${this.escape(countText)}</div>`}</div></div>`;
    },

    _briefSubList(stageKey) {
      const sk = String(stageKey).replace(/-/g, "_");
      const list = [];
      for (let i = 0; i < 24; i++) {
        const k = `brief_sub_${sk}_${i}`;
        const s = this._t(k);
        if (s === k) break;
        list.push(s);
      }
      return list;
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
        const generating = b.isGenerating === true || !this.briefHasBody(b) || b.title === "Generating…";
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
      const generating = b.isGenerating === true || !this.briefHasBody(b) || b.title === "Generating…";
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
      const generating = b.isGenerating === true || !this.briefHasBody(b) || b.title === "Generating…";
      if (!generating) { this.stopBriefStallWatch(); return; }

      const now = Date.now();
      const startedAt = b.pipelineStartedAt || this._lastBriefEventAt || now;

      // Hard ceiling · regardless of server state, flip the card to
      // a timed-out error so the user always has a way out.
      if (now - startedAt > this.BRIEF_HARD_TIMEOUT_MS) {
        b.error = this._t("brief_hard_timeout_msg");
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
      // Mode-aware stage rail. The wire format emitted by emitStage()
      // in src/orchestrator/brief.ts depends on which pipeline ran:
      //
      //   research-note (default) · extract → compose →
      //     scaffold-{anchor,findings,cluster,actions} → write
      //     (7 stages · the 4 scaffold sub-stages are driven by
      //      JSON-key arrival in the streaming buffer)
      //
      //   magazine / newspaper / ppt · extract → write
      //     (2 stages · runBentoStage runs ONE chair-LLM call that
      //      produces the BentoScaffold; composer + scaffold sub-
      //      stages are skipped entirely. Each mode customises only
      //      the write label so the user sees what's actually
      //      being composed.)
      const isStructured = this.isStructuredBriefMode(b.mode);
      const STAGE_ORDER = isStructured
        ? ["extract", "write"]
        : ["extract", "compose", "scaffold-anchor", "scaffold-findings", "scaffold-cluster", "scaffold-actions", "write"];
      // For structured modes the write key swaps to a per-mode label
      // (`brief_stage_magazine_write_label`, etc) so the user reads
      // "Composing the magazine" instead of the generic "Writing the
      // report" copy that suits research-note's chapter-by-chapter
      // pipeline.
      const STAGE_DEFS = STAGE_ORDER.map((key) => {
        if (isStructured && key === "write") {
          return {
            key,
            label: this._t(`brief_stage_${b.mode}_write_label`),
            pipShort: this._t(`brief_stage_${b.mode}_write_pip`),
          };
        }
        const sk = key.replace(/-/g, "_");
        return {
          key,
          label: this._t(`brief_stage_${sk}_label`),
          pipShort: this._t(`brief_stage_${sk}_pip`),
        };
      });
      const wordCount = b.bodyMd
        ? (b.bodyMd.trim().match(/\S+/g) || []).length
        : 0;

      const chairDisp = (b.chairName || this.currentChair?.name)
        ? this.escape(b.chairName || this.currentChair.name)
        : this._t("brief_chair_fallback");
      const meta = this.BRIEF_STAGE_META;
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
      // Structured-mode write stages get their own rotator copy
      // (`magazine-write` / `newspaper-write`) since the work is
      // different from research-note's chapter-by-chapter write.
      // Falls through to the regular stage key for every other
      // stage / mode.
      let substageText = "";
      if (activeStatus === "active") {
        const list = this._briefSubList(activeDef.key);
        if (list.length) substageText = list[Math.floor(activeElapsed / 3) % list.length];      }

      // Detail · cur/total directors during extract, word count during
      // write, otherwise the server-supplied detail string.
      const detailParts = [];
      if (activeDef.key === "extract" && activeStage.progress?.total) {
        const cur = activeStage.progress.current;
        const tot = activeStage.progress.total;
        detailParts.push(this._t(tot === 1 ? "brief_prog_directors_one" : "brief_prog_directors", { cur, tot }));      } else if (activeStage.detail) {
        detailParts.push(activeStage.detail);
      }
      if (activeDef.key === "write" && activeStatus === "active" && wordCount > 0) {
        detailParts.push(this._t(wordCount === 1 ? "brief_prog_words_one" : "brief_prog_words", { n: wordCount }));      }
      const detailLine = detailParts.join(" · ");

      // Timing for active stage · ETA range while in-band, elapsed once over.
      let timing = "";
      if (activeStatus === "active") {
        if (activeElapsed <= activeEta[1]) {
          timing = activeElapsed > 0
            ? this._t("brief_timing_inband", { e: activeElapsed, lo: activeEta[0], hi: activeEta[1] })
            : this._t("brief_timing_eta", { lo: activeEta[0], hi: activeEta[1] });
        } else {
          timing = this._t("brief_timing_over", { n: activeElapsed });        }
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
        if (s < 60) return this._t("brief_fmt_sec", { n: s });
        const m = Math.floor(s / 60);
        const r = s % 60;
        return r === 0 ? this._t("brief_fmt_min", { n: m }) : this._t("brief_fmt_min_sec", { m, r });
      };
      const fmtRange = (lo, hi) => {
        if (hi < 60) return this._t("brief_range_sec", { lo, hi });
        const loM = Math.max(1, Math.round(lo / 60));
        const hiM = Math.max(loM, Math.round(hi / 60));
        return this._t("brief_range_min", { lo: loM, hi: hiM });
      };

      const totalText = this._t("brief_total_line", {
        elapsed: fmtSec(totalElapsed),
        range: fmtRange(totalLo, totalHi),
      });

      const kickerCore = this._t("brief_stage_kicker", { chair: chairDisp, total: totalText });
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
      const kindLabels = {
        claims: this._t("brief_harvest_claims"),
        evidence: this._t("brief_harvest_evidence"),
        tensions: this._t("brief_harvest_tensions"),
        assumptions: this._t("brief_harvest_assumptions"),
        risks: this._t("brief_harvest_risks"),
        opportunities: this._t("brief_harvest_opportunities"),
        actions: this._t("brief_harvest_actions"),
        quotes: this._t("brief_harvest_quotes"),
        openQuestions: this._t("brief_harvest_open_questions"),
      };
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
        const w = this._t("brief_stat_writing", { n: wordCount });
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
          ${this.renderBriefLlmTrace(b)}
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
      const k = "note_tag_" + String(tag || "").replace(/[^a-z0-9_]/g, "");
      const tr = this._t(k);
      return tr === k ? String(tag || "") : tr;
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

  // Round-table toggle hover · document-level delegation drives
  // BOTH the visibility transition AND the position. The CSS
  // :hover trigger was unreliable in this layout (the preview
  // would only surface on click via :focus-visible, never on
  // hover). Doing it explicitly in JS sidesteps every potential
  // CSS-cascade / pointer-events / containing-block edge case.
  // mouseover bubbles (mouseenter doesn't), so one document
  // listener catches every hover across the two static buttons.
  document.addEventListener("mouseover", (e) => {
    const btn = e.target.closest && e.target.closest("[data-room-rt-toggle]");
    if (!btn || btn.hidden) return;
    const preview = btn.querySelector("[data-rt-preview]");
    if (!preview) return;
    const r = btn.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const previewW = preview.offsetWidth || 132;
    const previewH = preview.offsetHeight || 80;
    preview.style.left = `${Math.round(r.left + r.width / 2 - previewW / 2)}px`;
    preview.style.top = `${Math.round(r.top - previewH - 8)}px`;
    preview.style.bottom = "auto";
    preview.style.right = "auto";
    // Force visible · CSS :hover wasn't engaging reliably.
    preview.style.opacity = "1";
    preview.style.visibility = "visible";
    preview.style.transform = "translateY(0)";
  });
  document.addEventListener("mouseout", (e) => {
    const btn = e.target.closest && e.target.closest("[data-room-rt-toggle]");
    if (!btn) return;
    // mouseout fires when the cursor leaves a child element too;
    // only hide when the cursor has really left the button.
    const related = e.relatedTarget;
    if (related && btn.contains(related)) return;
    const preview = btn.querySelector("[data-rt-preview]");
    if (!preview) return;
    preview.style.opacity = "0";
    preview.style.visibility = "hidden";
    preview.style.transform = "translateY(6px)";
  });

  document.addEventListener("click", (e) => {
    // Round-table HUD · RATE button cycles voice playback speed
    // through the 5-preset list. Lives in the top-left HUD panel of
    // the voice-mode round-table stage; click → next preset, wraps.
    const rateBtn = e.target.closest("[data-rt-hud-rate]");
    if (rateBtn) {
      e.preventDefault();
      app.cycleVoicePlaybackRate();
      return;
    }
    // Round-table HUD · `−` / `+` toggle button · collapses the
    // status panel down to the header strip (or expands it back).
    // Persisted across reloads via localStorage.
    const hudToggleBtn = e.target.closest("[data-rt-hud-toggle]");
    if (hudToggleBtn) {
      e.preventDefault();
      app.toggleHudCollapsed();
      return;
    }
    // Round-table user seat · `×` close button on the user's speech
    // bubble · dismisses the current bubble immediately. The seat
    // itself stays; the next user message will bubble up again with
    // a fresh 10s countdown.
    const userBubbleClose = e.target.closest("[data-rt-user-bubble-close]");
    if (userBubbleClose) {
      e.preventDefault();
      app.dismissUserBubble();
      return;
    }
    // Same `×` pattern on the chair clarify bubble.
    const chairBubbleClose = e.target.closest("[data-rt-chair-bubble-close]");
    if (chairBubbleClose) {
      e.preventDefault();
      app.dismissChairBubble();
      return;
    }
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
    // Round-table view toggle · swap between gamified stage and
    // chat scroll. Stored per-room in sessionStorage (resets on
    // tab reload — immersive default always wins on a fresh open).
    // The button gets a one-shot `is-flipping` class for the 320ms
    // rotateY animation; we also fire a single typing-sfx tick for
    // a tactile click-snap (subject to the user's preference, the
    // engine self-mutes when the tab is backgrounded).
    const rtToggle = e.target.closest("[data-room-rt-toggle]");
    if (rtToggle) {
      e.preventDefault();
      // Audio cue · pre-existing engine, throttles + mute-on-blur
      // safe; no-op if the user has typing-sfx disabled.
      if (window.boardroomTypingSfx && typeof window.boardroomTypingSfx.tick === "function") {
        try { window.boardroomTypingSfx.tick(); } catch { /* swallow */ }
      }
      // Flip class · removed when the CSS animation ends so the
      // next click can re-trigger it.
      rtToggle.classList.add("is-flipping");
      const onEnd = () => {
        rtToggle.classList.remove("is-flipping");
        rtToggle.removeEventListener("animationend", onEnd);
      };
      rtToggle.addEventListener("animationend", onEnd);
      app.toggleRoomViewMode();
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
    // Toggle voice/text delivery mode — REMOVED (mid-session switching
    // causes too many timing issues; delivery mode is set at room creation).
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
    // Voice Replay · adjourned-bar action. Plays the transcript
    // back via TTS in chronological order, each director in their
    // own voice. Routed through the standalone voice-replay module
    // so the playback state machine + overlay live in one place.
    if (e.target.closest("[data-room-replay]")) {
      e.preventDefault();
      if (!app.currentRoomId) return;
      if (window.boardroomVoiceReplay && typeof window.boardroomVoiceReplay.open === "function") {
        // Pass historicalMembers (includes excused directors) so
        // past messages from a director the chair has excused still
        // resolve to the speaker's name + voice profile. Falls back
        // to active members for legacy contexts where the historical
        // list isn't populated yet.
        const replayMembers = Array.isArray(app.currentHistoricalMembers) && app.currentHistoricalMembers.length > 0
          ? app.currentHistoricalMembers.slice()
          : (Array.isArray(app.currentMembers) ? app.currentMembers.slice() : []);
        window.boardroomVoiceReplay.open({
          roomId: app.currentRoomId,
          messages: Array.isArray(app.currentMessages) ? app.currentMessages.slice() : [],
          members: replayMembers,
          chair: app.currentChair || null,
        });
      }
      return;
    }
    // Search view · clear-input button (X) inside the input wrap.
    if (e.target.closest("[data-search-clear]")) {
      e.preventDefault();
      const input = document.querySelector("[data-search-input]");
      if (input) {
        input.value = "";
        input.focus();
        app.runSearch("");
      }
      return;
    }
    // Search view · starter chip click. Pre-fills the input with
    // the chip's keyword and triggers a search. Dispatching an
    // input event ensures the existing doc-level input listener
    // (which calls runSearch) fires too, so the debounced fetch
    // path stays canonical.
    const starter = e.target.closest("[data-search-starter]");
    if (starter) {
      e.preventDefault();
      const term = starter.getAttribute("data-search-starter") || "";
      const input = document.querySelector("[data-search-input]");
      if (input && term) {
        input.value = term;
        input.focus();
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
    // Search view · sort chip ("Newest" / "Oldest"). Updates the
    // sort key + re-renders the cached result list client-side.
    // No re-fetch · the API doesn't expose a sort param and the
    // dataset is small (≤ 200 hits per query) so an in-memory
    // sort is the right call.
    const sortChip = e.target.closest("[data-search-sort-by]");
    if (sortChip) {
      e.preventDefault();
      const next = sortChip.getAttribute("data-search-sort-by") === "oldest" ? "oldest" : "newest";
      if (app._searchSort === next) return; // already active
      app._searchSort = next;
      app._refreshSortChips();
      // Re-render from the cached results · skip the no-cache
      // path (search not yet run) since the chip group is hidden
      // in is-initial.
      const cached = Array.isArray(app._searchLastResults) ? app._searchLastResults : null;
      const cachedQuery = app._searchLastQueryRendered || app._searchLastQuery || "";
      if (cached && cached.length > 0) {
        app.renderSearchResults(cached, cachedQuery);
      }
      return;
    }
    // Search view · result row click. Anchor's href is
    // `#/r/<id>?m=<mid>&q=<query>`, which the hashchange route
    // handler picks up. We stash the pending message id + query
    // here too as a belt-and-braces in case the hash is consumed
    // by another listener before handleRoute runs.
    const searchJumpMsg = e.target.closest("[data-search-jump-msg]");
    if (searchJumpMsg) {
      const mid = searchJumpMsg.getAttribute("data-search-jump-msg");
      const qry = searchJumpMsg.getAttribute("data-search-jump-q") || "";
      if (mid) app._pendingMessageScroll = mid;
      app._pendingMessageQuery = qry;
      // Let the anchor navigate naturally (hash change → handleRoute
      // → openRoom). No `return` since the link's default action
      // does the navigation.
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

      // System UI · always English (generating-button chrome).
      const generatingText = "generating…";
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
        alert("Brief generation failed: " + (err && err.message ? err.message : err));
      });
      return;
    }
    // Brief-mode picker · clicking a label (or its radio) toggles the
    // .on class on that option AND off on the siblings. Used by both
    // the adjourn overlay and the supplement overlay. We scope to the
    // picker's `.adjourn-mode-options` container (set in
    // renderBriefModePicker) instead of a specific overlay id, so the
    // same handler works wherever the picker is embedded. The native
    // radio behaviour handles `:checked` state but we use a manual
    // class for visual styling (left accent stripe + tint) since we
    // can't `:has()` reliably on older browsers.
    const modeOpt = e.target.closest(".adjourn-mode-option");
    if (modeOpt) {
      const group = modeOpt.closest(".adjourn-mode-options");
      if (group) {
        group.querySelectorAll(".adjourn-mode-option").forEach((el) => el.classList.remove("on"));
        modeOpt.classList.add("on");
        const radio = modeOpt.querySelector('input[type="radio"]');
        if (radio) radio.checked = true;
      }
      // Don't preventDefault · let the label's native click behaviour
      // also tick the radio for keyboard / a11y users.
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
    // Adjourn overlay · subject Show more / less toggle. Flips the
    // `is-clamped` class on the value span and swaps the button label.
    const subjToggle = e.target.closest("[data-adjourn-subject-toggle]");
    if (subjToggle) {
      e.preventDefault();
      const subjEl = document.querySelector("[data-adjourn-subject]");
      if (subjEl) {
        const expanded = subjEl.classList.toggle("is-clamped") === false;
        subjToggle.textContent = expanded ? "Show less" : "Show more";
      }
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
    const llmToggle = e.target.closest("[data-brief-llm-toggle]");
    if (llmToggle) {
      e.preventDefault();
      const id = llmToggle.getAttribute("data-brief-id");
      const brief = id ? app._briefById(id) : app.currentBrief;
      if (brief) {
        brief.llmLogOpen = !brief.llmLogOpen;
        app.renderBrief();
      }
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
    {
      const cont = e.target.closest("[data-continue]");
      if (cont) {
        e.preventDefault();
        if (cont.disabled) return;
        // Anti-double-click · disable every button on the surface
        // until SSE re-renders this region.
        const surface = cont.closest(".rt-vote-pop, .round-prompt-card, .round-end-card");
        if (surface) {
          surface.querySelectorAll("button").forEach((b) => { b.disabled = true; });
        } else {
          cont.disabled = true;
        }
        app.cancelContinueCountdown();
        app.continueRoom().catch((err) => alert("Continue failed: " + err.message));
        return;
      }
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
      // Anti-double-click · the click triggers a server round-trip
      // (POST /round-end) and a chair LLM stream. Without a hard
      // guard, a fast multi-click queued multiple chair runs and
      // mounted multiple chair-head vote panels back-to-back. Disable
      // the button + every sibling action button on the same surface
      // so the user can't double-fire while the request is in
      // flight. The natural re-render that follows (chair message-
      // appended → renderRoundTable → fresh popover) replaces the
      // disabled buttons with the next-phase card, so we don't need
      // to re-enable manually.
      const surface = wrapBtn.closest(".rt-vote-pop, .round-prompt-card, .round-end-card");
      if (surface) {
        surface.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      } else {
        wrapBtn.disabled = true;
      }
      app.cancelContinueCountdown();
      app.requestRoundEnd().catch((err) => alert("Wrap failed: " + err.message));
      return;
    }
    // Bottom-bar manual vote-trigger · opens a 3-option overlay
    // (interrupt now · after current speaker · cancel) instead of
    // firing the chair immediately. The overlay paths through to
    // requestRoundEnd(mode) which posts {mode} to /round-end. The
    // chat round-prompt's "Open vote" button still uses the legacy
    // direct-fire path because at that point the round IS complete
    // and there's no in-flight speaker to disambiguate.
    const manualVoteBtn = e.target.closest("button[data-room-end-manual]");
    if (manualVoteBtn) {
      e.preventDefault();
      if (manualVoteBtn.disabled) return;
      app.openVoteTriggerOverlay();
      return;
    }
    // Vote-trigger overlay · close (cancel button + Esc).
    const vtClose = e.target.closest("[data-vt-close]");
    if (vtClose) {
      e.preventDefault();
      app.closeVoteTriggerOverlay();
      return;
    }
    // Click outside the vote-trigger modal closes it · mirrors the
    // pause-choice overlay's backdrop-dismiss behaviour.
    if (e.target.id === "vote-trigger-overlay") {
      app.closeVoteTriggerOverlay();
      return;
    }
    // Click outside the round-table vote overlay dismisses it · same
    // backdrop pattern. We pass keepDismissed:true so refreshRtVote-
    // Overlay won't immediately re-open on the next SSE tick (the
    // user clearly wanted the modal out of the way).
    if (e.target.id === "rt-vote-overlay") {
      app.closeRtVoteOverlay({ keepDismissed: true });
      return;
    }
    // Vote-trigger overlay · pick a mode and fire requestRoundEnd.
    // Disabled "after-speaker" buttons (no one mid-stream) are
    // ignored at the DOM level — the disabled attribute makes them
    // unclickable, but we belt-and-braces here too.
    const vtModeBtn = e.target.closest("[data-vt-mode]");
    if (vtModeBtn) {
      e.preventDefault();
      if (vtModeBtn.disabled) return;
      const mode = vtModeBtn.getAttribute("data-vt-mode");
      app.closeVoteTriggerOverlay();
      app.requestRoundEnd(mode).catch((err) => alert("Vote failed: " + err.message));
      return;
    }
    // Auto-continue button (queue strip) — same effect as the round-end
    // card's Continue, plus this is also the auto-fire target.
    const autoBtn = e.target.closest("[data-continue-auto]");
    if (autoBtn) {
      e.preventDefault();
      if (autoBtn.disabled) return;
      // Anti-double-click · same rationale as wrapBtn above. The
      // surface flips to the next phase via SSE, so we don't need
      // to re-enable manually.
      const surface = autoBtn.closest(".rt-vote-pop, .round-prompt-card, .round-end-card");
      if (surface) {
        surface.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      } else {
        autoBtn.disabled = true;
      }
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
    // ─── Persona build placeholder row (sidebar "Building" section) ──
    // Routes the user back to the agent composer view, where the
    // in-flight build's progress / done-state callout is painted.
    if (e.target.closest("[data-persona-row-trigger]")) {
      e.preventDefault();
      app.setComposerMode("agent");
      // If the build already finished while the user was elsewhere,
      // open the confirmation overlay one-shot · they came back
      // expecting to confirm.
      if (app.personaJob && app.personaJob.status === "done"
          && !app._personaOverlayShown) {
        app._personaOverlayShown = true;
        app.openPersonaConfirmOverlay();
      }
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
    // ─── Persona builder · cancel / discard / save / retry
    if (e.target.closest("[data-persona-cancel]")) {
      e.preventDefault();
      app.cancelPersonaBuild();
      return;
    }
    if (e.target.closest("[data-persona-retry]")) {
      e.preventDefault();
      app.retryPersonaBuild();
      return;
    }
    if (e.target.closest("[data-persona-open-confirm]")) {
      e.preventDefault();
      app.openPersonaConfirmOverlay();
      return;
    }
    if (e.target.closest("[data-persona-discard-build]")) {
      e.preventDefault();
      app.discardPersonaBuild();
      return;
    }
    // Note · `data-persona-save` / `data-persona-discard` /
    // `data-persona-spec-reroll` are no longer emitted · the
    // Full-mode save screen reuses Signal's `.ag-prev-card` shell,
    // and the shared `[data-agent-spec-*]` handlers branch on
    // `app.personaJob` to dispatch the persona-mode endpoints.
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
    // ─── New-room composer · voice-mode toggle. Same three paths
    //   as the websearch toggle just below: unconfigured → open
    //   keys panel; on → off; off → on. Done with in-place class /
    //   text mutation so the composer textarea isn't blown away by
    //   a full repaint on every click.

    const voiceToggle = e.target.closest("[data-composer-voice-toggle]");
    if (voiceToggle) {
      e.preventDefault();
      const configured = app.hasAnyVoiceKey();
      if (!configured) {
        // Stale `data-configured` may say 1 if the user added then
        // removed a key without a re-render; live cache wins.
        if (typeof window.openUserSettings === "function") {
          window.openUserSettings({ section: "keys", focusProvider: "minimax" });
        }
        return;
      }
      // Live cache says configured · sync the toggle's stale attrs
      // so the next click flips rather than re-prompts.
      if (voiceToggle.getAttribute("data-configured") !== "1") {
        voiceToggle.setAttribute("data-configured", "1");
        voiceToggle.classList.remove("needs-key");
      }
      const wasOn = voiceToggle.getAttribute("data-on") === "1";
      const next = !wasOn;
      app.setComposerDeliveryMode(next ? "voice" : "text");
      voiceToggle.classList.toggle("on", next);
      voiceToggle.classList.toggle("off", !next);
      voiceToggle.setAttribute("data-on", next ? "1" : "0");
      voiceToggle.setAttribute("aria-pressed", next ? "true" : "false");
      const txt = voiceToggle.querySelector(".ap-skill-row-toggle-text");
      if (txt) txt.textContent = app._t("cmp_voice_label");
      voiceToggle.title = next
        ? "Voice mode on · directors speak aloud during the room"
        : "Voice mode off · click to enable";
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
      const configured = !!(app.agentComposerWebSearchConfigured && app.agentComposerWebSearchConfigured());
      if (!configured) {
        const fallback =
          "Web Search needs Brave Search or Tavily API credentials.\n\nOpen Preferences now?";
        const ok = confirm(
          (window.I18n && typeof window.I18n.t === "function")
            ? window.I18n.t("ag_ws_need_key_confirm")
            : fallback,
        );
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
        // System UI · always English (web-search toggle chrome).
        const wsLabel = "web search";
        const stateLabel = next ? "enabled" : "disabled";
        txt.textContent = `${wsLabel} · ${stateLabel}`;
      }
      wsToggle.title = next
        ? "Search the web for real domain references during generation · click to disable"
        : "Generation runs offline · click to enable web search";
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
    if (e.target.closest("[data-agent-spec-stop]")) {
      // Stop · same effect as Discard while generation is in flight ·
      // aborts the AbortController, which propagates to the fetch
      // (cancels the LLM call server-side) and resets composer state.
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
    // ⓘ info icon · sibling of the picker button. Toggle the
    // floating tooltip with the option's `info` description (set
    // up in openComposerDropdown for kinds that opt in, e.g.
    // agent-builder-mode). Stop propagation so the click neither
    // bubbles to the picker handler below nor closes the dropdown.
    const ddInfo = e.target.closest("[data-cmp-dd-info]");
    if (ddInfo) {
      e.preventDefault();
      e.stopPropagation();
      // Click the same icon twice → close.
      if (app._cmpDdInfoFor === ddInfo) {
        app.closeCmpDdInfoPop();
        return;
      }
      const v = ddInfo.getAttribute("data-cmp-dd-info");
      const kind = ddInfo.getAttribute("data-cmp-dd-info-kind");
      const opts = (app._cmpDdOpts && app._cmpDdOpts[kind]) || [];
      const opt = opts.find((o) => String(o.v) === String(v));
      if (opt && opt.info) {
        app.openCmpDdInfoPop(ddInfo, opt.info);
      }
      return;
    }
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
        else if (kind === "delivery") app.setComposerDeliveryMode(v);
        else if (kind === "agent-model") app.setAgentComposerModel(v);
        else if (kind === "agent-builder-mode") app.setAgentBuilderMode(v);
        else if (kind === "locale") {
          // Interface language · runs through the shared I18n
          // setter so document.documentElement.lang, the persisted
          // boardroom.uiLocale storage entry, applyDom, and the
          // boardroom:locale event all fire as a unit. The trigger's
          // value span is updated explicitly because applyDom won't
          // touch a `data-cmp-dd-value` (it has no data-i18n key).
          if (window.I18n && typeof window.I18n.setLocale === "function") {
            window.I18n.setLocale(v);
          }
          if (trigger) {
            const valSpan = trigger.querySelector("[data-cmp-dd-value]");
            if (valSpan) {
              valSpan.textContent = v === "zh" ? "中文" : "EN";
            }
          }
        }
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
    // Topic-rec card → apply via /api/topic-recs/:id so the
    // full seedContext lands in composer state.
    const composerRec = e.target.closest("[data-cmp-rec]");
    if (composerRec) {
      e.preventDefault();
      const id = composerRec.getAttribute("data-cmp-rec");
      if (id) app.applyTopicRec(id);
      return;
    }
    // Topic-rec trigger button → start a fresh generation job.
    if (e.target.closest("[data-cmp-recs-trigger]")) {
      e.preventDefault();
      void app.startTopicRecJob();
      return;
    }
    // ("+ N more" pagination removed · tray now always shows
    //  the latest 6 recs and wipes on each fresh generation.)
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
    // Share a saved note · opens the share-card overlay.
    const noteShare = e.target.closest("[data-note-share]");
    if (noteShare) {
      e.preventDefault();
      e.stopPropagation();
      const item = noteShare.closest("[data-note-id]");
      const id = item?.dataset.noteId;
      if (id) app.openShareCard(id);
      return;
    }
    // Share-card overlay · template chip click swaps the visual.
    const shareTplBtn = e.target.closest("[data-share-card-template]");
    if (shareTplBtn) {
      e.preventDefault();
      const key = shareTplBtn.getAttribute("data-share-card-template");
      if (key) app.setShareCardTemplate(key);
      return;
    }
    // Share-card overlay · download.
    if (e.target.closest("[data-share-card-download]")) {
      e.preventDefault();
      app.downloadShareCard();
      return;
    }
    // Share-card overlay · close button.
    if (e.target.closest("[data-share-card-close]")) {
      e.preventDefault();
      app.closeShareCard();
      return;
    }
    // Share-card overlay · backdrop click dismisses (mirrors the
    // pause-choice / vote-trigger overlay convention).
    if (e.target.id === "share-card-overlay") {
      app.closeShareCard();
      return;
    }
    // Delete a saved note from the All Notes list. The button is a
    // sibling of the note's anchor (inside .notes-item) so its click
    // never bubbles through the navigation link — but we still
    // preventDefault + stopPropagation defensively to keep the row's
    // hover/focus state quiet.
    const noteDel = e.target.closest("[data-note-delete]");
    if (noteDel) {
      e.preventDefault();
      e.stopPropagation();
      const item = noteDel.closest("[data-note-id]");
      const id = item?.dataset.noteId;
      if (id) app.deleteNoteAt(id);
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
    } else if (e.target && e.target.matches && e.target.matches("[data-search-input]")) {
      app.runSearch(e.target.value);
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
    // Drop the user-seat WAIT marker · the queued message was
    // cancelled by the user before it could be flushed.
    app.renderRoundTable();
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

  // Global one-shot listener: unlock audio playback on first user
  // interaction so voice mode works regardless of which button was
  // clicked first.
  document.addEventListener("click", function _unlockAudio() {
    app.unlockAudioPlayback();
    document.removeEventListener("click", _unlockAudio);
  });
  document.addEventListener("keydown", function _unlockAudioKey() {
    app.unlockAudioPlayback();
    document.removeEventListener("keydown", _unlockAudioKey);
  });

  window.app = app;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => app.init());
  } else {
    app.init();
  }
})();
