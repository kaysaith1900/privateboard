/* ═══════════════════════════════════════════════════════════════════
   voice-room-shell.js · mobile-native shell + offline driver for the
   voice-room prototype. Mounts the adapted 3D engine
   (voice-3d-mobile.js → window.MobileVoiceStage3D), then runs a scripted
   discussion (session-script.js), sequencing thinking → speaking → next
   and feeding the 3D stage, the caption band, the cast rail and the
   transcript sheet. No backend.
   ═══════════════════════════════════════════════════════════════════ */
import { api, openRoomStream, openPersonaStream } from "/mobile/api.js";
import { loadDraft, saveDraft, clearDraft } from "/mobile/store.js";
// Offline sim retired · session-model.js + room-state.js are no longer
// imported (the real backend drives rooms). PHASE remains only as a local
// constant for the unused legacy driver functions below (never executed).
const PHASE = { CLARIFY: "clarify", LIVE: "live", VOTING: "voting", ROUND_END: "round-end", ADJOURNED: "adjourned" };
import { t, currentLocale, setLocale, LOCALES, onLocaleChange } from "/mobile/i18n-mobile.js";

/* ── Live cast · populated from the real backend (GET /api/agents) at
   boot. Replaces the seeded session-script CAST. CHAIR/ROSTER/AGENTS_META
   are derived in applyAgents(). ─────────────────────────────────────── */
let CAST = [];
/* Map a real backend Agent → the shell's AGENTS_META shape. ability uses
   the desktop lowercase axes; the radar maps them via RADAR_FROM_AB. */
function metaFromAgent(a) {
  const ab = a.ability && typeof a.ability === "object" ? a.ability : {};
  const cap = {};
  for (const [k, ax] of Object.entries(RADAR_FROM_AB || {})) { const v = ab[ax]; if (typeof v === "number") cap[k] = v; }
  return {
    handle: a.handle || ("@" + a.id), roleTag: a.roleTag || (a.roleKind === "moderator" ? "Moderator" : "Director"),
    voice: (a.voice && a.voice.voiceId) ? a.voice.voiceId : "—",
    bio: a.bio || "", instruction: a.instruction || "",
    ab: Object.keys(cap).length ? cap : { Dissent: 5, Rigor: 5, Empathy: 5, Pattern: 5, Narrative: 5, Decisiveness: 5 },
    modelV: a.modelV, isSeed: !!a.isSeed,
    userRules: Array.isArray(a.userRules) ? a.userRules.slice() : [],
    coverQuote: a.coverQuote || "", webSearchEnabled: !!a.webSearchEnabled,
    personaSpec: a.personaSpec || null,   // full-persona build artifact (null for seeded/Signal)
  };
}
/* Install the real agents into CAST/CHAIR/ROSTER + AGENTS_META + the
   per-agent model map. Chair is returned as a sibling field. */
function applyAgents(data) {
  const agents = (data && Array.isArray(data.agents)) ? data.agents : [];
  const chair = (data && data.chair) || null;
  const all = chair ? [chair, ...agents] : agents.slice();
  CAST = all.map((a) => ({ id: a.id, name: a.name, avatarPath: a.avatarPath || "", roleKind: a.roleKind === "moderator" ? "chair" : "director", avatar3d: a.avatar3d || null }));
  CHAIR = CAST.find((c) => c.roleKind === "chair") || null;
  ROSTER = CAST.filter((c) => c.roleKind === "director").map((c) => ({ ...c, active: false }));
  for (const a of all) { AGENTS_META[a.id] = metaFromAgent(a); if (a.modelV) modelSel[a.id] = a.modelV; }
}

/* ── Pure seat-position calculator · copied verbatim from
   home-3d-mock.js (which copied app.js) so the ring matches the
   in-app scene. ───────────────────────────────────────────────── */
function computeSeatPositions(members) {
  if (!members || !members.length) return [];
  const cx = 50, cy = 50;
  const rx = 42, ry = 23;
  const chairRy = 15;
  const SEAT_SCALE = 1.10;
  const out = [];
  const chair = members[0];
  const user = members.find((m) => m && m.__isUser);
  const directors = members.filter((m, i) => i > 0 && !(m && m.__isUser));
  const chairY = cy + chairRy;   // 65% · front row
  // Chair · front row. Shifts left to x:43 when the user is seated
  // alongside so the two pair up at the head of the table (mirrors the
  // desktop round-table); centred at x:50 when the user isn't seated.
  out.push({ member: chair, x: user ? 43 : cx, y: chairY, scaleHint: SEAT_SCALE, kind: "chair", thetaDeg: 90 });
  // Directors · fan across the back arc.
  const dc = directors.length;
  if (dc > 0) {
    const arcDeg = dc === 2 ? 60 : 180;
    const arcStart = dc === 2 ? 240 : 180;
    const stepDeg = dc === 1 ? 0 : arcDeg / dc;
    for (let i = 0; i < dc; i++) {
      const t = dc === 1 ? 270 : arcStart + (i + 0.5) * stepDeg;
      const theta = (t * Math.PI) / 180;
      out.push({ member: directors[i], x: cx + rx * Math.cos(theta), y: cy + ry * Math.sin(theta), scaleHint: SEAT_SCALE, kind: "director", thetaDeg: t });
    }
  }
  // User · paired with the chair on the front row (x:57), same y so the
  // pair reads as the head of the table and stays inside the
  // establishing frame (desktop seats the user this way too).
  if (user) out.push({ member: user, x: 57, y: chairY, scaleHint: SEAT_SCALE, kind: "user", thetaDeg: 90 });
  return out;
}

const $ = (sel) => document.querySelector(sel);
const byId = (m) => CAST.find((c) => c.id === m) || null;

/* ── Tiny inline-SVG icon set (no emoji per project rule). ──────── */
const ICON = {
  hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2a8 8 0 0 1-7.4-5L3 19"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  cast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>',
  replay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
  adjourn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  // Back · left chevron, heavier stroke to match the other top-bar icons (the
  // thin list-row chev read as too light in the 38px glass button).
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3l1.5 1.5-2 2 2 2-2.5 2.5-2-2-2.6 2.6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  model: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></svg>',
  regen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>',
  spark: '<svg viewBox="0 0 16 16" fill="currentColor" stroke="none"><path d="M8 0 L9 7 L16 8 L9 9 L8 16 L7 9 L0 8 L7 7 Z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6"/><rect x="12" y="6" width="3" height="11"/><rect x="17" y="13" width="3" height="4"/></svg>',
  rooms: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4 21 12 3.4 3.6 3 10l12 2-12 2z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  bubble: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>',
  // Round-table (voice/stage) glyph · mirrors the desktop rt-toggle: a central
  // circle ringed by 5 seated dots. Used to switch BACK to the 3D stage.
  stage: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><circle cx="8" cy="8" r="4.6"/><circle cx="8" cy="2" r="1.3" fill="currentColor" stroke="none"/><circle cx="13.5" cy="6.2" r="1.3" fill="currentColor" stroke="none"/><circle cx="11.4" cy="13.4" r="1.3" fill="currentColor" stroke="none"/><circle cx="4.6" cy="13.4" r="1.3" fill="currentColor" stroke="none"/><circle cx="2.5" cy="6.2" r="1.3" fill="currentColor" stroke="none"/></svg>',
};

async function boot() {
  // Decorate CAST with canonical seeded looks (PB_CORE_AVATARS from
  // /core-avatars.js, loaded before this module by the HTML).
  if (window.PB_CORE_AVATARS) {
    for (const m of CAST) {
      const cfg = window.PB_CORE_AVATARS[m.id];
      if (cfg && !m.avatar3d) m.avatar3d = cfg;
    }
  }
  // Get the engine reference (the IIFE set window.MobileVoiceStage3D on import).
  await import("/mobile/voice-3d-mobile.js");
  MV = window.MobileVoiceStage3D;

  // Wire the persistent controls ONCE — their elements live in the DOM the
  // whole time (just hidden with the room view). The driver/engine are
  // (re)created per room in enterRoom().
  wireTabs(); wireDock(); wireFocusSync(); wireMenu(); wireNav(); wireComposer();
  armAudioUnlock();   // warm HTMLAudio on first gesture so voice TTS can autoplay
  wirePageLifecycle();   // stop voice on page close (NOT on tab/space switch)

  applyStaticChrome();     // localise the static HTML chrome
  showView("home");
  try { await loadBackend(); } catch (_) { backendReady = false; }   // real agents + rooms + credential gate
  renderRooms();
  initRouter();
  restoreFromHash();       // reopen the room / tab the URL points at
  // Re-localise everything when the user switches language.
  onLocaleChange(() => {
    applyStaticChrome();
    renderRooms();
    if (homeTab === "directors") renderDirectors();
    if (modalStack.length) renderModal();
  });
}

/* ════ Enter / leave a room ════ */
/* ── Real room runtime · fetches the snapshot, renders existing
   messages, and opens the SSE stream; live events drive the existing
   stage / caption / transcript / queue paints. (Offline `startDriver`
   below is retained as dead code, no longer called.) ───────────────── */
let roomES = null;           // current room EventSource
const msgBody = new Map();   // messageId → accumulated streamed body
const msgAuthor = new Map(); // messageId → authorId (for correct per-message attribution)
let curRound = 1;
let activeSpeaker = null;
let lastBriefId = null;
let roomPaused = false;          // backend pause state (soft pause)
let awaitingContinue = false;    // a round ended · waiting to continue the next round (server flag mirror)
let roundEndMsgId = null;        // the chair's round-end message · drives the round-end card without waiting on the voice-gated round-ended config-event
let roundEndRec = null;          // chair's recommendation {kind:"end"|"continue"} · highlights the suggested button on the card
let roundEndKind = null;         // "round-prompt" (light wrap · can still Open-vote) | "round-end" (formal · already voted)
let roundKeyPoints = [];         // [{id,body,position,vote}] · chair's key points (from the round-ended config-event) · drives the vote panel
let roundModeShift = null;       // {to,because}|null · chair's tone-shift proposal · swaps the vote-panel CTAs to switch/keep/adjourn
let roundVoteResolved = false;   // the round-ended config-event has landed (key points are final) · gates drafting-skeleton vs degraded card
let pausePending = false;        // soft-pause requested · server is finishing the current turn before it actually pauses (mirrors desktop's "pause-pending")
let pillHint = "";               // "" | "pausing" | "resuming" · transient status-pill feedback while a pause/resume request is in flight
let resumeHintTimer = 0;         // safety · clears a stuck "resuming" hint if no director turn follows
let roomAwaitingClarify = false; // chair asked a question · user reply routes to chair
let playRate = 1;                // UI playback-rate cycler · drives voice replay (live LLM pace is unaffected)
/* Rate control · shared by the dock (live) and the adjourned bar (replay).
   Cycling updates every [data-act=rate] label AND the currently-playing
   replay clip so the speed change is heard immediately. */
const RATE_STEPS = [1, 1.25, 1.5, 2, 0.75];   // cycle order · wraps 0.75 → 1
function rateLabel() { return String(playRate) + "×"; }
function applyRate() {
  const lbl = rateLabel();
  document.querySelectorAll("[data-act=rate]").forEach((b) => { b.textContent = lbl; });
  if (replayAudio) { try { replayAudio.playbackRate = playRate || 1; } catch (_) { /* */ } }
}
function cycleRate() { const i = RATE_STEPS.indexOf(playRate); playRate = RATE_STEPS[(i + 1) % RATE_STEPS.length]; applyRate(); }
let viewAsText = false;          // voice room shown in the text/chat STYLE (presentation toggle · not the room's delivery)
const roomIsText = () => roomDelivery === "text" || viewAsText;   // render target: chat bubbles vs 3D stage
const roomIsVoiceDelivery = () => roomDelivery === "voice";       // TTS / voice cadence is keyed on delivery, not view

async function enterRoom(room) {
  currentRoom = room;
  roomMode = room.tone; roomIntensity = room.intensity; roomStatus = room.status;
  roomDelivery = room.delivery || "voice";
  viewAsText = false;   // always enter a voice room in stage style
  lastSpeakerId = null; lastSpeakerState = null; pendingUserBubble = null;
  recordedTranscript = []; curRound = 1; activeSpeaker = null; msgBody.clear(); lastBriefId = null;
  roomPaused = room.status === "paused"; roomAwaitingClarify = !!room.awaitingClarify; playRate = 1;
  pausePending = false; pillHint = ""; if (resumeHintTimer) { clearTimeout(resumeHintTimer); resumeHintTimer = 0; }
  awaitingContinue = false; roundEndMsgId = null; roundEndRec = null; roundEndKind = null; roundKeyPoints = []; roundModeShift = null; roundVoteResolved = false;
  document.body.classList.remove("is-pause-pending");
  reportStep = "pick"; reportMode = "report"; stopRoomStream(); stopReplay();   // a prior room's replay never leaks into the next
  reportBrief = null; reportErr = null; reportLoading = false; reportTriedRoomId = null; clearTimeout(reportPollTimer);

  showView("room");
  if (!_routing) setHash("#/room/" + encodeURIComponent(room.id));
  document.body.classList.toggle("is-text", roomDelivery === "text");
  document.body.classList.remove("is-composing", "is-voting", "is-vtext", "is-dock-collapsed");   // enter expanded · first turn auto-folds
  document.body.classList.toggle("is-adjourned", roomStatus === "adjourned");
  buildTopBar();
  setStatusPill();
  $("[data-act=playpause]").innerHTML = roomPaused ? ICON.play : ICON.pause;   // paused room → ▶ (resume); live → ⏸
  applyRate();   // reset every rate button (dock + adjourned bar) to 1×
  const vd = $("[data-vote-dot]"); if (vd) vd.hidden = true;

  // Mount the 3D stage (voice) or clear the chat (text).
  if (!roomIsText()) {
    const stageEl = $("[data-mobile-stage]");
    stageEl.setAttribute("data-floor", roomMode);
    if (!MV || !MV.isSupported || !MV.isSupported()) stageEl.innerHTML = '<div class="vr-nowebgl">' + esc(t("m_no_webgl")) + "</div>";
    else { MV.mount(stageEl, { camera: { distance: 11, elevationDeg: 24, lookAtY: 0.5 }, loadingLabel: t("m_loading_room") }); }   // built-in loading veil covers the WebGL+GLB init gap (no black flash)
  } else { const chat = $("[data-chat]"); if (chat) chat.innerHTML = ""; }

  // Fetch the real room snapshot (members + messages + queue + round).
  let snap = null;
  try { snap = await api.getRoom(room.id); }
  catch (_) { toast(t("m_room_load_fail")); exitRoom(); return; }
  if (!currentRoom || currentRoom.id !== room.id) return;   // navigated away mid-fetch
  // Sync the title from the authoritative snapshot · the AI titler may have
  // renamed the room (raw query → distilled phrase) while the cached list
  // entry was stale, so the in-room title shows the latest name on open.
  if (snap && snap.room) {
    if (snap.room.name) { currentRoom.name = snap.room.name; const rm = ROOMS.find((r) => r.id === room.id); if (rm) rm.name = snap.room.name; }
    if (snap.room.subject) currentRoom.subject = snap.room.subject;
  }
  applyRoomMembers(snap);
  if (!roomIsText() && MV && MV.isSupported && MV.isSupported()) { rebuildCast(); }
  renderSnapshot(snap);
  if (roomStatus === "adjourned" && roomIsText()) maybeRenderTextEndCards(snap);
  buildTopBar();
  if (roomStatus !== "adjourned") startRoomStream(room.id);
  else if (!roomIsText()) paintStage(null, null);
  // Re-entered a room that ended a round and is still waiting to continue ·
  // restore the Continue / Adjourn affordance + auto-continue clock. Recover
  // the chair's key points + tone-shift from the last round-ended config event
  // so the re-opened sheet lands on the full vote panel, not a bare prompt.
  if (roomStatus === "live" && snap && snap.room && snap.room.awaitingContinue) {
    try {
      const evs = (snap.events || []).filter((e) => e && e.kind === "round-ended");
      const last = evs.length ? evs[evs.length - 1] : null;
      const p = last && last.payload;
      if (p) {
        if (Array.isArray(p.keyPoints)) roundKeyPoints = p.keyPoints.map((k) => ({ id: k.id, body: k.body, position: k.position, vote: k.vote || null }));
        roundModeShift = p.modeShiftProposal || null;
        roundVoteResolved = true;
        roundEndKind = "round-end";
      }
    } catch (_) { /* */ }
    onRoundEnded();
  }
}

function exitRoom() {
  releasePendingVoice();   // ack any in-flight turn so the orchestrator isn't stranded
  clearContinue();         // drop any pending auto-continue countdown
  stopRoomStream();
  stopReplay();
  { const s = sfx(); if (s) s.setThinking(false); }
  if (MV && roomDelivery !== "text") { try { MV.unmount(); } catch (_) { /* */ } }
  closeModal();
  document.body.classList.remove("is-adjourned", "is-composing", "is-text", "is-voting", "is-vtext", "is-dock-collapsed");
  captionHide();
  viewAsText = false;
  currentRoom = null; recordedTranscript = []; activeSpeaker = null; msgBody.clear();
  if (!_routing) setHash("#/");
  renderRooms();
  showView("home");
}

/* ── Voice ⇄ text presentation toggle · switches a voice room between the
   3D stage style and the text-room chat style (no transcript drawer). The
   conversation re-renders as chat bubbles from the recorded transcript;
   audio + voice cadence keep running underneath in the hidden stage. ───── */
function renderChatFromTranscript() {
  const w = $("[data-chat]"); if (!w) return;
  w.innerHTML = "";
  for (const ln of recordedTranscript) {
    const isUser = ln.speakerId === "__user";
    addTranscriptLine(isUser ? { name: "You" } : (byId(ln.speakerId) || { name: ln.name }), ln.text, isUser);
  }
  // Rebuilding the transcript wiped the chat · re-append the end cards so an
  // adjourned VOICE room shows analysis + report when toggled to text view
  // (mirrors desktop, where adjourned rooms surface these on the transcript).
  if (roomStatus === "adjourned") maybeRenderTextEndCards();
}
function applyDeliveryView() {
  document.body.classList.toggle("is-vtext", viewAsText && roomDelivery === "voice");
  if (roomIsText()) renderChatFromTranscript();                       // → chat bubbles
  else if (MV && roomDelivery === "voice" && MV.isSupported && MV.isSupported()) repaintStage();   // → 3D stage
  setViewToggleIcon();
}
function toggleViewAsText() {
  if (roomDelivery !== "voice") return;   // text-delivery rooms are already chat-style
  viewAsText = !viewAsText;
  applyDeliveryView();
}
function setViewToggleIcon() {
  // stage view → offer "text" (chat bubble); text view → offer "voice" (the
  // desktop round-table glyph). Lives on its own [data-act=viewtext] button
  // in both the dock (live) and the adjourned bar.
  const ic = viewAsText ? ICON.stage : ICON.bubble;
  document.querySelectorAll("[data-act=viewtext]").forEach((b) => { b.innerHTML = ic; });
}

/* Seat the room's real members; mark ROSTER active + backfill CAST for
   any member not already present (historical / edge agents). */
function applyRoomMembers(snap) {
  const members = (snap && snap.members) || [];
  for (const m of members) {
    if (!CAST.find((c) => c.id === m.id)) {
      const rec = { id: m.id, name: m.name, avatarPath: m.avatarPath || "", roleKind: "director", avatar3d: m.avatar3d || null };
      CAST.push(rec); ROSTER.push({ ...rec, active: false });
    }
    if (!AGENTS_META[m.id]) AGENTS_META[m.id] = metaFromAgent(m);
  }
  const ids = new Set(members.map((m) => m.id));
  for (const r of ROSTER) r.active = ids.has(r.id);
}

/* Render the snapshot's existing messages into the transcript / chat. */
function renderSnapshot(snap) {
  const tr = $("[data-transcript]"); if (tr) tr.innerHTML = "";
  const ch = $("[data-chat]"); if (ch) ch.innerHTML = "";
  recordedTranscript = []; curRound = 1;
  for (const msg of (snap.messages || [])) {
    const body = String(msg.body || "").trim();
    if (!body) continue;
    if (msg.authorKind === "system") continue;   // skip procedural system rows
    const isUser = msg.authorKind === "user";
    if (!isUser && msg.authorId) msgAuthor.set(msg.id, msg.authorId);   // seed author map · resumed rooms re-stream voice for these pre-existing messages
    const who = isUser ? { name: "You" } : (byId(msg.authorId) || { name: msg.authorId || "—" });
    addTranscriptLine(who, body, isUser);
    recordedTranscript.push({ speakerId: isUser ? "__user" : msg.authorId, name: who.name, text: body });
    if (typeof msg.roundNum === "number") curRound = Math.max(curRound, msg.roundNum);
  }
  setRoundChip();
}
/* Append one finished line to the transcript (voice) / chat (text). */
function addTranscriptLine(who, text, isUser) {
  if (roomIsText()) {
    if (isUser) { appendChatUser(text); return; }
    const w = $("[data-chat]"); if (!w) return;
    const row = document.createElement("div"); row.className = "vr-msg vr-msg-them";
    row.innerHTML = `${avatarThumb(who, 30)}<div class="vr-msg-body"><div class="vr-msg-who">${esc(who.name)}</div><div class="vr-msg-text vr-md">${mdToHtml(text)}</div></div>`;
    w.appendChild(row); chatScroll();
  } else {
    appendTranscript(isUser ? { name: "You" } : who, text);
  }
}
/* Render the user's own appended message (echoed by the server over SSE,
   mirroring app.js — we do NOT optimistically paint on send). Text rooms
   get a chat bubble; voice rooms get a transcript line + a speech bubble
   over the "You" seat for ~6s. */
function renderUserMessage(text) {
  const body = String(text || "").trim(); if (!body) return;
  recordedTranscript.push({ speakerId: "__user", name: "You", text: body });
  if (roomIsText()) { appendChatUser(body); return; }
  appendTranscript({ name: "You" }, body);
  pendingUserBubble = { text: body, progress: 1 };
  if (MV) MV.focusSeat(null);                       // wide shot so the front "You" seat is framed
  paintStage(lastSpeakerId, lastSpeakerState);      // re-paint with the bubble overlaid
  setTimeout(() => { if (!currentRoom || roomIsText()) return; pendingUserBubble = null; paintStage(lastSpeakerId, lastSpeakerState); }, 6000);
}
function startRoomStream(roomId) {
  stopRoomStream();
  roomES = openRoomStream(roomId, {
    "message-appended": (d) => {
      if (!d || roomStatus === "adjourned") return;   // ignore straggler turns after adjourn
      msgBody.set(d.messageId, d.body || "");
      if (typeof d.roundNum === "number" && d.roundNum > curRound) { curRound = d.roundNum; setRoundChip(); }
      // Clarify tracking · a chair clarify question raises the flag; any
      // other append (user reply, director turn) lowers it.
      const isClarify = d.authorKind === "agent" && CHAIR && d.authorId === CHAIR.id && (d.meta || {}).kind === "clarify";
      roomAwaitingClarify = isClarify;
      if (d.authorKind === "user") { renderUserMessage(d.body || ""); return; }
      if (d.authorKind === "system") return;
      if ((d.meta || {}).kind === "round-open") return;   // chair round-marker · not a spoken bubble
      // Round wrap · the chair's end-of-round message. The NATURAL/auto path
      // (announceRoundPrompt) posts `round-prompt` (with a recommendation) and
      // never emits the voice-gated `round-ended` config-event; the manual
      // `/round-end` path posts `round-end`. Either one means "round over" — its
      // body is complete at append-time (templated, not streamed), so raise the
      // Continue/Adjourn card NOW (the chair still speaks the prompt over it).
      const _mk = (d.meta || {}).kind;
      if (_mk === "round-prompt" || _mk === "round-end") {
        // Mark it · the card is raised when the chair FINISHES delivering this
        // (voice: on audio-end via finishVoice · text: on message-final), so it
        // never covers the chair's live subtitle. Carry the recommendation +
        // kind (round-prompt → can still Open-vote; round-end → already voted).
        roundEndMsgId = d.messageId;
        roundEndRec = (d.meta && d.meta.recommendation) || null;
        roundEndKind = _mk;
      }
      if (pillHint) clearPillHint();   // a real director/chair turn is starting · drop the "resuming" feedback
      msgAuthor.set(d.messageId, d.authorId);
      const who = byId(d.authorId) || { name: d.authorId || "—" };
      if (roomIsText()) {
        activeSpeaker = d.authorId; lastSpeakerId = d.authorId; lastSpeakerState = "thinking";
        textEnsureBubble(d.messageId, who);
        const s = sfx(); if (s) { s.speakerChange(); s.setThinking(true); }
        return;
      }
      // Voice stage · own the audio queue up front so `order` = turn order and
      // the author is authoritative (not the global activeSpeaker). The STAGE
      // follows the serialized audio player (voiceHeadId), NOT this text event:
      // the backend pre-warms the NEXT director's text+TTS while the current one
      // is still audible, so its message-appended arrives early — we only buffer
      // it here; the stage flips to it when its audio actually plays (playVoice).
      const q = ensureVQ(d.messageId, roomId); q.author = d.authorId;
      if (d.messageId === voiceHeadId()) {
        activeSpeaker = d.authorId; lastSpeakerId = d.authorId; lastSpeakerState = "thinking";
        paintStage(d.authorId, "thinking"); if (MV) MV.focusSeat(d.authorId); captionThinking(who.name); setRailActive(d.authorId);
        const s = sfx(); if (s) { s.speakerChange(); s.setThinking(true); }
      }
    },
    "message-token": (d) => {
      if (!d || roomStatus === "adjourned") return;
      const prev = msgBody.get(d.messageId) || "";
      const body = prev + (d.delta || ""); msgBody.set(d.messageId, body);
      if (roomIsText()) {
        const authorId = msgAuthor.get(d.messageId) || activeSpeaker;
        const who = byId(authorId) || { name: authorId || "—" };
        textRevealMsg(d.messageId, body, who); const s = sfx(); if (s) s.tick(); return;
      }
      // Voice stage · the text only ACCUMULATES here (msgBody, above). The
      // director stays on "thinking" until THEIR audio actually starts —
      // playVoice() then flips to speaking and captionFollowAudio reveals the
      // words in sync with the voice. So the subtitle never appears (and the
      // stage never "speaks") before they really speak.
    },
    "message-final": (d) => {
      const s = sfx(); if (s) s.setThinking(false);
      if (!d || roomStatus === "adjourned") return;
      // Text rooms have no audio · raise the round-end card when the chair's
      // round-wrap TEXT finishes. (Voice rooms raise it on audio-end — see
      // finishVoice — so the card doesn't cover the chair's live subtitle.)
      if (roomIsText() && d.messageId === roundEndMsgId) onRoundEnded();
      const body = String(msgBody.get(d.messageId) || "").trim();
      const authorId = msgAuthor.get(d.messageId) || activeSpeaker;
      const who = byId(authorId) || { name: authorId || "—" };
      // Keep msgAuthor[messageId] for the room session · the audio for this
      // message plays AFTER its text finalizes, so playVoice still needs to
      // resolve the author. (Cleared per-room in stopRoomStream.)
      if (roomIsText()) {
        textFinalMsg(d.messageId, body, who);   // reveal or drop (empty markers)
        if (body) recordedTranscript.push({ speakerId: authorId, name: who.name, text: body });
        // A voice-delivery room shown in text style still needs the voice
        // cadence (TTS playback + /voice-done) so the discussion advances.
        if (roomIsVoiceDelivery()) markVoiceTextFinal(d.messageId, authorId);
        return;
      }
      // Voice room · keep the speaker on stage while their TTS plays; the
      // voice player clears the stage on voice-done (audio end).
      if (body) { addTranscriptLine(who, body, false); recordedTranscript.push({ speakerId: authorId, name: who.name, text: body }); }
      markVoiceTextFinal(d.messageId, authorId);
    },
    "message-error": () => { const s = sfx(); if (s) s.setThinking(false); activeSpeaker = null; lastSpeakerId = null; lastSpeakerState = null; if (!roomIsText()) { captionHide(); paintStage(null, null); } },
    "config-event": (d) => { if (d) handleConfigEvent(d); },
    "voice-chunk": (d) => { if (d && roomStatus !== "adjourned") enqueueVoiceChunk(roomId, d); },
    "voice-final": (d) => { if (d && roomStatus !== "adjourned") onVoiceFinal(roomId, d.messageId); },
    "voice-error": (d) => handleVoiceError(d),
    error: () => { /* EventSource auto-reconnects; server ring-buffers for replay */ },
  });
}

/* ── Voice (real TTS) · buffered-blob player, serialized per message ───
   Each director's MP3 chunks (base64) are collected until voice-final,
   then played as one Blob (robust on iOS Safari, where MSE audio is
   unreliable). The speaker stays "speaking" on the 3D stage through
   playback; the stage clears on audio end. /voice-progress heartbeats
   keep the orchestrator's wait alive; /voice-done advances to the next
   speaker. Autoplay-blocked devices still advance (graceful finish). */
const voiceQ = new Map();    // messageId → {chunks,seqs,final,textFinal,mime,roomId,author,done,order,fbTimer}
let voicePlaying = null;     // messageId whose audio is currently playing
let voiceAudio = null;       // current HTMLAudioElement
let voiceProgTimer = 0;      // /voice-progress heartbeat interval
let voiceUnlocked = false;   // iOS audio unlocked by a user gesture
let voicePaused = false;     // pause GATE · blocks the queue from advancing while paused
function voiceReset() {
  if (voiceAudio) { try { voiceAudio.pause(); voiceAudio.removeAttribute("src"); voiceAudio.load(); } catch (_) { /* */ } voiceAudio = null; }
  if (voiceProgTimer) { clearInterval(voiceProgTimer); voiceProgTimer = 0; }
  for (const q of voiceQ.values()) { if (q.fbTimer) clearTimeout(q.fbTimer); }
  voiceQ.clear(); voicePlaying = null; voicePaused = false;
}
function ensureVQ(messageId, roomId) {
  let q = voiceQ.get(messageId);
  if (!q) { q = { chunks: [], cap: [], seqs: new Set(), final: false, textFinal: false, mime: "audio/mpeg", roomId, author: null, done: false, order: voiceQ.size, fbTimer: 0 }; voiceQ.set(messageId, q); }
  return q;
}
function enqueueVoiceChunk(roomId, d) {
  if (!d || !d.messageId || !d.audioBase64) return;
  const q = ensureVQ(d.messageId, roomId);
  if (!q.author) q.author = msgAuthor.get(d.messageId) || activeSpeaker;   // owned by THIS message's author, not whoever is currently audible
  if (d.mimeType) q.mime = d.mimeType;
  if (typeof d.seq === "number") { if (q.seqs.has(d.seq)) return; q.seqs.add(d.seq); }
  // Keep each chunk's spoken text alongside its audio bytes (1:1 with q.chunks)
  // so the caption can track the ACTUAL audio segment, not a flat char rate.
  // The backend repeats the whole sentence text on every audio chunk of that
  // sentence (tts.ts) — captionFollowAudio collapses runs of equal text.
  try { const bin = atob(d.audioBase64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); q.chunks.push(bytes); q.cap.push({ text: typeof d.text === "string" ? d.text : "", bytes: bytes.length }); } catch (_) { /* */ }
  maybePlayNext();
}
/* Text stream for this message finished · keep the speaker on stage and
   arm a fallback so a missing voice-final never strands the stage (e.g.
   no voice credential, or a chair template with no TTS). */
function markVoiceTextFinal(messageId, author) {
  const q = ensureVQ(messageId, currentRoom ? currentRoom.id : null);
  q.textFinal = true; if (author) q.author = author;
  if (q.done) return;
  if (q.fbTimer) clearTimeout(q.fbTimer);
  q.fbTimer = setTimeout(() => { q.final = true; maybePlayNext(); if (!voicePlaying && !q.done) finishVoice(messageId); }, 9000);
}
function onVoiceFinal(roomId, messageId) {
  const q = ensureVQ(messageId, roomId); q.final = true; if (!q.author) q.author = msgAuthor.get(messageId) || activeSpeaker;
  maybePlayNext();
}
/* The earliest not-done message in the queue · the speaker who is (or is next)
   on the 3D stage. The stage follows THIS, so a pre-warmed later director never
   takes the stage while an earlier one is still active/audible. */
function voiceHeadId() {
  let head = null, min = Infinity;
  for (const [id, q] of voiceQ) { if (q.done) continue; if (q.order < min) { min = q.order; head = id; } }
  return head;
}
/* Play the earliest message whose audio is fully in (voice-final), one at
   a time. voice-final is the authoritative "ready" signal — the text is
   always fully streamed by the time it fires, so we don't gate on it. */
function maybePlayNext() {
  if (voicePaused || voicePlaying) return;   // paused → never start the next queued clip
  const entries = [...voiceQ.entries()].filter(([, q]) => !q.done).sort((a, b) => a[1].order - b[1].order);
  for (const [id, q] of entries) {
    if (!q.final) {                                      // head's audio not complete → preserve order, wait
      // Show this (correct) next speaker thinking so the stage isn't blank
      // between turns. Don't override a speaker already on stage (idempotent).
      if (!roomIsText() && q.author && lastSpeakerId !== q.author) {
        activeSpeaker = q.author; lastSpeakerId = q.author; lastSpeakerState = "thinking";
        const w = byId(q.author) || {}; paintStage(q.author, "thinking"); if (MV) MV.focusSeat(q.author); captionThinking(w.name || ""); setRailActive(q.author);
        const s = sfx(); if (s) s.setThinking(true);
      }
      return;
    }
    if (!q.chunks.length) { finishVoice(id); return; }   // no audio → advance immediately
    playVoice(id, q); return;
  }
}
function playVoice(messageId, q) {
  voicePlaying = messageId;
  if (q.fbTimer) { clearTimeout(q.fbTimer); q.fbTimer = 0; }
  let url = null;
  try { url = URL.createObjectURL(new Blob(q.chunks, { type: q.mime || "audio/mpeg" })); } catch (_) { finishVoice(messageId); return; }
  const audio = new Audio(); voiceAudio = audio; audio.src = url;
  try { audio.playbackRate = playRate || 1; } catch (_) { /* */ }
  const end = () => { try { URL.revokeObjectURL(url); } catch (_) { /* */ } if (voicePlaying === messageId) finishVoice(messageId); };
  audio.addEventListener("ended", end, { once: true });
  audio.addEventListener("error", end, { once: true });
  if (voiceProgTimer) clearInterval(voiceProgTimer);
  voiceProgTimer = setInterval(() => { if (currentRoom) api.voiceProgress(q.roomId, messageId); }, 5000);
  if (currentRoom) api.voiceProgress(q.roomId, messageId);
  const p = audio.play();
  if (p && p.catch) p.catch(() => { end(); });   // autoplay blocked → finish so the room still advances
  // Stage follows the audio · flip to THIS speaker exactly when their (possibly
  // pre-buffered) clip starts — this is what makes the A→B handoff land at the
  // audio boundary instead of when B's text pre-warmed. Karaoke: the text
  // already streamed ahead via tokens, so re-sync the subtitle to the audio
  // from the top so the words on screen match what's being spoken + lip-sync.
  if (!roomIsText()) {
    // Authoritative author for the PLAYING clip · prefer the per-message map
    // (set by message-appended + seeded from the room snapshot on enter) over
    // q.author, which can be a stale activeSpeaker if the queue entry was
    // created by an early voice-chunk / voice-final before its message-appended
    // (common on resume + with the backend's pre-warm). Keeps the stage — name,
    // seat focus, rail, lip-sync — locked to whoever is actually audible.
    const author = msgAuthor.get(messageId) || q.author;
    q.author = author;
    const who = byId(author) || {};
    activeSpeaker = author; lastSpeakerId = author; lastSpeakerState = "speaking";
    paintStage(author, "speaking"); if (MV) MV.focusSeat(author); setRailActive(author);
    const s = sfx(); if (s) s.setThinking(false);
    if (who.name) captionSpeak(who.name);
    captionFollowAudio(String(msgBody.get(messageId) || ""), audio, q.cap);
  }
}
function finishVoice(messageId) {
  const q = voiceQ.get(messageId);
  if (q) { q.done = true; if (q.fbTimer) { clearTimeout(q.fbTimer); q.fbTimer = 0; } }
  if (voiceProgTimer) { clearInterval(voiceProgTimer); voiceProgTimer = 0; }
  if (voicePlaying === messageId) { voiceAudio = null; voicePlaying = null; }
  if (q && currentRoom) api.voiceDone(q.roomId || currentRoom.id, messageId);
  // Serialized · once this speaker's audio ends and nothing else is
  // playing, clear the stage (the next director only appends after the
  // orchestrator receives our /voice-done).
  if (!roomIsText() && !voicePlaying) {
    captionHide(); paintStage(null, null);
    activeSpeaker = null; lastSpeakerId = null; lastSpeakerState = null;
    const s = sfx(); if (s) s.setThinking(false);
  }
  maybePlayNext();
  // The chair's round-wrap clip just finished · raise the Continue/Adjourn card
  // NOW (after the chair stops speaking → caption already cleared, so the card
  // never covers the live subtitle). Voice rooms only; text rooms use message-final.
  if (!roomIsText() && !voicePlaying && messageId === roundEndMsgId) onRoundEnded();
}
function handleVoiceError(d) {
  const s = sfx(); if (s) s.setThinking(false);
  toast(t("m_voice_error"));
  // Don't strand the stage · let the turn's message-final fallback clear it.
}
/* Halt / resume the currently-playing TTS clip immediately. Used by HARD pause
   only (a director was aborted mid-stream): the caption (reads audio.currentTime)
   and mouth lip-sync (gated on !audio.paused) freeze with it. SOFT pause does
   NOT call this — like desktop, the current speaker finishes their sentence and
   the orchestrator pauses after the turn (see doSoftPause). The serial player
   won't advance while voicePlaying stays set + the clip is paused (not ended). */
function setVoicePlaybackPaused(p) {
  voicePaused = !!p;                       // gate maybePlayNext (queued clips)
  if (p) {
    // Pause the current clip AND silence anything already loaded.
    if (voiceAudio) { try { voiceAudio.pause(); } catch (_) { /* */ } }
  } else {
    // Resume · continue the current clip, or kick the queue if we were
    // paused between clips.
    if (voiceAudio && voiceAudio.paused) { try { const pr = voiceAudio.play(); if (pr && pr.catch) pr.catch(() => { /* */ }); } catch (_) { /* */ } }
    else maybePlayNext();
  }
}
/* ── Pause / resume · mirrors the desktop contract ───────────────────
   SOFT PAUSE is a *pending* operation server-side: if a director is
   mid-stream the server keeps them talking and only flips to paused
   once their turn finishes (it returns {pending:true} + emits the
   room-paused SSE later). So — like desktop — we do NOT stop the audio
   mid-sentence; we show a "pausing after this turn" hint and let the
   room-paused event land the real state. RESUME is optimistic + shows a
   "resuming" thinking beat so the gap before the next director (LLM +
   TTS latency) isn't dead air with no feedback. */
function clearPillHint() { if (resumeHintTimer) { clearTimeout(resumeHintTimer); resumeHintTimer = 0; } if (pillHint) { pillHint = ""; setStatusPill(); } }
function beginResumeHint() {
  pillHint = "resuming"; setStatusPill();
  if (!roomIsText()) { captionThinking(t("m_status_resuming")); const s = sfx(); if (s) s.setThinking(true); }
  if (resumeHintTimer) clearTimeout(resumeHintTimer);
  // Safety · if no director turn follows (e.g. resumed with an empty queue),
  // don't leave the hint spinning forever.
  resumeHintTimer = setTimeout(() => { resumeHintTimer = 0; if (pillHint === "resuming") { pillHint = ""; setStatusPill(); const s = sfx(); if (s) s.setThinking(false); if (!roomIsText()) captionHide(); } }, 22000);
}
function setPlayPauseIcon() { const b = $("[data-act=playpause]"); if (b) b.innerHTML = (roomPaused || pausePending) ? ICON.play : ICON.pause; }
async function doSoftPause() {
  // HARD pause · flips the room to "paused" on the server IMMEDIATELY (and
  // persists it) so the state survives a reload. A soft pause would stay
  // "live" on the backend until the current turn ends, so a refresh during
  // that window reverted the room to live — the bug this fixes.
  pausePending = true; pillHint = "pausing";
  document.body.classList.add("is-pause-pending");
  setPlayPauseIcon(); setStatusPill();
  let res;
  try { res = await api.pauseRoom(currentRoom.id, "hard"); }
  catch (e) {
    pausePending = false; pillHint = "";
    document.body.classList.remove("is-pause-pending");
    setPlayPauseIcon(); setStatusPill();
    toast((e && e.message) || t("m_send_fail")); return;
  }
  if (res && res.pending) return;   // room-paused SSE will flip roomPaused + clear the hint
  // Paused immediately (no active speaker) · land it now.
  pausePending = false; pillHint = "";
  roomPaused = true; roomStatus = currentRoom.status = "paused";
  document.body.classList.remove("is-pause-pending");
  setPlayPauseIcon(); setStatusPill();
  toast(t("m_toast_paused"));
}
async function doResume() {
  roomPaused = false; pausePending = false; roomStatus = currentRoom.status = "live";
  document.body.classList.remove("is-pause-pending");
  setPlayPauseIcon();
  beginResumeHint();                 // "resuming" pill + thinking beat as immediate feedback
  setVoicePlaybackPaused(false);     // re-arm any clip the live player still owns (no-op if none)
  try { await api.resumeRoom(currentRoom.id); }
  catch (e) {
    clearPillHint();
    roomPaused = true; roomStatus = currentRoom.status = "paused";
    setPlayPauseIcon(); setStatusPill();
    if (!roomIsText()) captionHide(); const s = sfx(); if (s) s.setThinking(false);
    toast((e && e.message) || t("m_send_fail")); return;
  }
  toast(t("m_toast_resumed"));
}
async function togglePlayPause() {
  if (!currentRoom || roomStatus === "adjourned") return;
  if (pausePending) return;          // soft-pause already in flight · ignore taps until it lands
  if (roomPaused) await doResume();
  else await doSoftPause();
}
/* Leaving a live voice room mid-turn: the orchestrator is parked at
   waitForVoicePlayback on whatever we were playing (or about to play),
   advancing only once we POST /voice-done. Unlike the desktop app — which
   keeps a background SSE alive to keep draining + acking — this prototype
   just tears the stream down, so abandoning the turn silently strands the
   room for up to the server's 60s heartbeat fallback. On re-entry it then
   looks frozen / stuck "playing" and won't advance. Release every turn we
   still owe so the orchestrator moves on at once (the server treats an
   unknown / already-done id harmlessly). MUST run before stopRoomStream(),
   which clears voiceQ / voicePlaying / msgAuthor. */
function releasePendingVoice() {
  if (!currentRoom || roomStatus === "adjourned" || !roomIsVoiceDelivery()) return;
  const rid = currentRoom.id;
  const ids = new Set();
  if (voicePlaying) ids.add(voicePlaying);
  for (const [id, q] of voiceQ.entries()) { if (!q.done) ids.add(id); }
  for (const id of msgAuthor.keys()) ids.add(id);
  for (const id of ids) api.voiceDone(rid, id);
}
/* The 3D engine probes window.app.isSpeakerAudible(seatId) every frame to gate
   mouth lip-sync on REAL audio. Without it the engine falls back to the stage
   "speaking" flag — which is raised by the text stream BEFORE the TTS clip
   starts, so mouths flap silently through the text→audio gap. Mirror the
   desktop app's contract: audible only while this author's clip is genuinely
   running (live serial player OR replay karaoke clip). */
if (typeof window !== "undefined") {
  window.app = window.app || {};
  window.app.isSpeakerAudible = function (id) {
    if (!id) return false;
    // Live · the serialized voice player has this author's clip playing.
    if (voicePlaying && voiceAudio && !voiceAudio.paused && !voiceAudio.ended && voiceAudio.currentTime > 0) {
      const q = voiceQ.get(voicePlaying);
      if (q && q.author === id) return true;
    }
    // Replay · the karaoke clip for the current line is playing.
    const ln = replayList && replayList[replayIdx];
    if (ln && ln.speakerId === id && replayAudio && !replayAudio.paused && !replayAudio.ended && replayAudio.currentTime > 0) return true;
    return false;
  };
}
/* iOS unlock · the first user gesture warms an Audio element so later
   programmatic play() (after voice-final) is permitted. */
function armAudioUnlock() {
  const unlock = () => {
    if (voiceUnlocked) return;
    voiceUnlocked = true;
    try { const a = new Audio(); a.muted = true; const p = a.play(); if (p && p.catch) p.catch(() => { /* */ }); setTimeout(() => { try { a.pause(); } catch (_) { /* */ } }, 30); } catch (_) { /* */ }
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("touchend", unlock, { passive: true });
}
/* Stop voice only on a REAL teardown (tab close / navigation away). We do
   NOT touch `visibilitychange` — switching browser tabs or macOS spaces hides
   the page but should keep the TTS playing, like a media player. */
function wirePageLifecycle() {
  window.addEventListener("pagehide", () => {
    try { voiceReset(); } catch (_) { /* */ }
    try { stopRoomStream(); } catch (_) { /* */ }
  });
}
function stopRoomStream() {
  if (roomES) { try { roomES.close(); } catch (_) { /* */ } roomES = null; }
  msgBody.clear(); msgAuthor.clear(); textBubbles.clear();
  voiceReset();
  const s = sfx(); if (s) s.setThinking(false);
}
/* Resolve a message's author from the live transcript record (fallback). */
function currentMessageAuthor() { return activeSpeaker; }

function handleConfigEvent(d) {
  const kind = d.kind;
  if (kind === "member-added" || kind === "members-changed" || kind === "auto-pick-complete") { refreshRoomMembers(); }
  else if (kind === "room-paused") {
    // Soft pause completed (the speaker finished their turn) OR a hard pause.
    // Only hard pause needs to silence audio — soft already ended naturally.
    roomStatus = "paused"; roomPaused = true; pausePending = false;
    if (currentRoom) currentRoom.status = "paused";   // keep the ROOMS entry (home list) in sync
    clearPillHint(); document.body.classList.remove("is-pause-pending");
    setPlayPauseIcon(); setStatusPill();
    if ((d.payload || {}).mode === "hard") setVoicePlaybackPaused(true);
    const s = sfx(); if (s) s.setThinking(false);
  }
  else if (kind === "room-resumed") {
    // Keep the "resuming" hint up until the first director turn actually
    // streams in (message-appended clears it) so the wait shows feedback.
    roomStatus = "live"; roomPaused = false; pausePending = false;
    if (currentRoom) currentRoom.status = "live";   // keep the ROOMS entry (home list) in sync
    document.body.classList.remove("is-pause-pending");
    setPlayPauseIcon(); setStatusPill();
  }
  else if (kind === "settings-changed") {
    // AI title distillation · the server renames the room from the raw query to
    // a short phrase shortly after the room gets going, pushing the new name
    // here. Patch the IN-ROOM title live; the home list keeps showing the raw
    // subject, so only the cached `name` is refreshed (for the next entry).
    const ch = d.payload && d.payload.changes;
    const newName = ch && ch.name && ch.name.to;
    if (newName) {
      if (currentRoom) { currentRoom.name = newName; buildTopBar(); }
      const rm = currentRoom && ROOMS.find((r) => r.id === currentRoom.id);
      if (rm) rm.name = newName;
    }
    /* other mode/intensity tweaks · re-read on next snapshot */
  }
  else if (kind === "round-ended") {
    // The chair's FORMAL round-end · carries the persisted key points +
    // the optional tone-shift proposal. Capture both so the vote panel
    // can render real rows (swapping out the drafting skeleton), then
    // raise / re-render the round-end sheet.
    const p = d.payload || {};
    if (Array.isArray(p.keyPoints)) roundKeyPoints = p.keyPoints.map((k) => ({ id: k.id, body: k.body, position: k.position, vote: k.vote || null }));
    roundModeShift = p.modeShiftProposal || null;
    roundVoteResolved = true;
    roundEndKind = "round-end";
    onRoundEnded();
    // If the vote sheet is already open (the user tapped 发起投票), swap the
    // drafting skeleton for the real key-point rows in place.
    if (modalStack[modalStack.length - 1] === "vote") renderModal();
  }
  else if (kind === "round-resumed") { clearContinue(); }   // a Continue (auto or manual / via user message) landed · drop the round-end affordance
  else if (kind === "brief-final") { lastBriefId = (d.payload && (d.payload.briefId || d.payload.id)) || lastBriefId; onBriefFinal(); }
}

/* Round wrapped · the chair summary streamed + (in voice rooms) is still being
   spoken. Raise the round-end sheet and LEAVE IT UP until the user decides —
   no auto-continue. (A countdown that closes a full-screen decision sheet on
   its own reads as "it vanished before I could choose", so the board waits.) */
function onRoundEnded() {
  if (roomStatus === "adjourned" || awaitingContinue) return;   // idempotent · message-driven + config-event both call this
  awaitingContinue = true;
  showVoteDot();
  setRoundChip();   // top-bar chip flips to "本轮结束 ›" so the sheet is always re-openable
  // Raise the round-end sheet · only auto-open when no modal is in the way
  // (don't clobber an open menu / report / vote view). If the round-end or
  // vote sheet is already showing, re-render it from the new state.
  const top = modalStack[modalStack.length - 1];
  if ($("[data-modal]").hidden) openModal(roundEntryView());
  else if (top === "roundend" || top === "vote") renderModal();
}
/* Which round-end sheet view to land on · once a formal round-end exists (or
   key points are in), the sheet IS the vote panel; otherwise it's the light
   Continue / Open-vote / Adjourn prompt. */
function roundEntryView() { return (roundEndKind === "round-end" || roundKeyPoints.length) ? "vote" : "roundend"; }
/* Close the round-end sheet only if it's the one on top (never yank away an
   unrelated modal the user opened). */
function closeRoundModal() { const v = modalStack[modalStack.length - 1]; if (v === "roundend" || v === "vote") closeModal(); }
async function refreshRoomMembers() {
  if (!currentRoom) return;
  try { const snap = await api.getRoom(currentRoom.id); applyRoomMembers(snap); if (!roomIsText() && MV && MV.isSupported && MV.isSupported()) rebuildCast(); } catch (_) { /* */ }
}
/* Tear down the round-end affordance + countdown (continued, adjourned, or left). */
function clearContinue() {
  awaitingContinue = false; roundEndMsgId = null; roundEndRec = null; roundEndKind = null;
  roundKeyPoints = []; roundModeShift = null; roundVoteResolved = false;
  document.body.classList.remove("is-voting");
  const d = $("[data-vote-dot]"); if (d) d.hidden = true;
  closeRoundModal();   // dismiss the round-end / vote sheet if it's showing
  setRoundChip();      // hide the "本轮结束 ›" chip
}
/* Continue into the next reactive round · POST /continue (NOT /resume — the
   room is still "live" with awaitingContinue, so /resume 409s). If the user
   parked it paused, resume first, like desktop. */
async function doContinue() {
  if (!currentRoom || roomStatus === "adjourned") return;
  closeRoundModal();
  clearContinue();
  // Immediate feedback · NO empty gap while the next round generates (LLM
  // latency). Show the chair thinking right away; the first real director's
  // turn repaints to that director when it appends (head-gated). On the 3D
  // stage that's a focused seat + "thinking" caption; nothing blank.
  if (!roomIsText() && CHAIR) {
    activeSpeaker = CHAIR.id; lastSpeakerId = CHAIR.id; lastSpeakerState = "thinking";
    paintStage(CHAIR.id, "thinking"); if (MV) MV.focusSeat(CHAIR.id); captionThinking(CHAIR.name || ""); setRailActive(CHAIR.id);
    const s = sfx(); if (s) { s.speakerChange(); s.setThinking(true); }
  }
  try {
    if (roomPaused) { await api.resumeRoom(currentRoom.id); roomPaused = false; roomStatus = currentRoom.status = "live"; setPlayPauseIcon(); setStatusPill(); }
    await api.continueRoom(currentRoom.id);
  } catch (e) {
    if (!roomIsText()) { captionHide(); paintStage(null, null); const s = sfx(); if (s) s.setThinking(false); }
    toast((e && e.message) || t("m_send_fail"));
  }
}
/* 发起投票 · escalate the light round-prompt to a FORMAL round-end (desktop's
   "Open vote") · POST /round-end → the chair delivers a formal key-point
   summary, then the round-end card re-raises (now Continue + Adjourn). */
async function doVote() {
  if (!currentRoom || roomStatus === "adjourned") return;
  // Stay in the sheet · switch to the vote panel (drafting skeleton until the
  // round-ended config-event lands with the chair's key points). Don't
  // clearContinue — that would tear the sheet down.
  if (modalStack[modalStack.length - 1] === "roundend") pushModal("vote");
  else if (modalStack[modalStack.length - 1] !== "vote") openModal("vote");
  // Immediate feedback on the stage behind the sheet · the chair is about to
  // summarize (no empty gap if the user dismisses the sheet).
  if (!roomIsText() && CHAIR) {
    activeSpeaker = CHAIR.id; lastSpeakerId = CHAIR.id; lastSpeakerState = "thinking";
    paintStage(CHAIR.id, "thinking"); if (MV) MV.focusSeat(CHAIR.id); captionThinking(CHAIR.name || ""); setRailActive(CHAIR.id);
    const s = sfx(); if (s) { s.speakerChange(); s.setThinking(true); }
  }
  try {
    if (roomPaused) { await api.resumeRoom(currentRoom.id); roomPaused = false; roomStatus = currentRoom.status = "live"; setPlayPauseIcon(); setStatusPill(); }
    await api.roundEnd(currentRoom.id, "now");
  } catch (e) {
    if (!roomIsText()) { captionHide(); paintStage(null, null); const s = sfx(); if (s) s.setThinking(false); }
    toast((e && e.message) || t("m_send_fail"));
  }
}
/* Vote on a chair key point · ▲ 跟进 / ▼ 舍去. Optimistic toggle (same vote
   twice clears it), repaint the vote sheet from the data, POST, revert on
   failure. Mirrors desktop voteKeyPoint. */
async function voteKp(kpId, requested) {
  if (!currentRoom || !kpId) return;
  const kp = roundKeyPoints.find((p) => p.id === kpId); if (!kp) return;
  const prev = kp.vote;
  const vote = prev === requested ? null : requested;
  kp.vote = vote;
  if (modalStack[modalStack.length - 1] === "vote") renderModal();   // chips repaint from the data layer (no class-toggle race)
  try { await api.voteKeyPoint(currentRoom.id, kpId, vote); }
  catch (e) {
    kp.vote = prev;
    if (modalStack[modalStack.length - 1] === "vote") renderModal();
    toast(t("kp_vote_fail"));
  }
}
/* Accept the chair's tone-shift proposal · PATCH the room mode, then continue
   into the next round (the mode marker cues the next director sweep). */
async function doSwitchMode(to) {
  if (!currentRoom || !to || roomStatus === "adjourned") return;
  try { await api.patchRoom(currentRoom.id, { mode: to }); roomMode = to; }
  catch (e) { toast((e && e.message) || t("m_send_fail")); return; }
  doContinue();
}
/* Round-end title · "第 N 轮 · 本轮结束" (the modal title bar carries it). */
function roundEndTitle() { return (curRound ? t("m_q_round", { n: curRound }) + " · " : "") + String(t("m_round_done")).replace(/[.。]\s*$/, ""); }
/* ─ Round-end sheet · view 1 · the light prompt. Mirrors desktop's round-prompt
   card: Continue (gold, with the auto-continue ring) + 发起投票 (Open vote ·
   POST /round-end → the chair's formal key-point summary, switches THIS sheet
   to the vote panel) + 闭会并归档 (Adjourn). Once it's a formal round-END
   (already voted) the vote button drops. The chair's recommendation highlights
   the suggested button. */
function renderRoundEnd() {
  const recEnd = roundEndRec && roundEndRec.kind === "end";
  const recCont = roundEndRec && roundEndRec.kind === "continue";
  const showVote = roundEndKind !== "round-end";   // light prompt → offer Open-vote; formal round-end already voted
  const html = `<div class="vr-rc-card">
    <button type="button" class="vr-rc-continue${recCont ? " is-rec" : ""}" data-cont>
      <span class="vr-rc-clabel">${esc(t("m_continue"))}</span>
    </button>
    ${showVote ? `<button type="button" class="vr-rc-end${recEnd ? " is-rec" : ""}" data-vote>${esc(t("m_vote_adjourn"))}</button>` : ""}
    <button type="button" class="vr-rc-end vr-rc-adjourn-btn${(recEnd && !showVote) ? " is-rec" : ""}" data-adj>${esc(t("m_adjourn_file"))}</button>
  </div>`;
  return { title: roundEndTitle(), html, mount(b) {
    const cont = b.querySelector("[data-cont]"); if (cont) cont.addEventListener("click", () => doContinue());
    const vote = b.querySelector("[data-vote]"); if (vote) vote.addEventListener("click", () => doVote());
    const adj = b.querySelector("[data-adj]"); if (adj) adj.addEventListener("click", () => doAdjourn());
  } };
}
/* ─ Round-end sheet · view 2 · the key-point VOTE panel. Mirrors desktop's
   roundEndCardHtml: an eyebrow, the chair's key points each with ▲ 跟进 / ▼ 舍去
   chips, an optional tone-shift callout, and the Continue / Adjourn CTAs (or
   Switch / Keep / Adjourn when a shift is proposed). While the round-ended
   event is still in flight the rows show a drafting skeleton. */
function renderVote() {
  const pts = roundKeyPoints.slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  const eyebrow = pts.length ? t("kp_eyebrow_vote") : (roundVoteResolved ? t("kp_eyebrow_degraded") : t("kp_eyebrow_drafting"));
  let rows;
  if (pts.length) {
    rows = pts.map((p) => `
      <div class="vr-kp-row" data-kp-id="${esc(p.id)}">
        <div class="vr-kp-body">${esc(p.body)}</div>
        <div class="vr-kp-actions">
          <button type="button" class="vr-kp-vote up${p.vote === "up" ? " is-active" : ""}" data-kp-vote="up" data-kp-id="${esc(p.id)}" aria-label="${esc(t("kp_vote_aria_up"))}"><span class="vr-kp-arrow">▲</span><span>${esc(t("kp_vote_more"))}</span></button>
          <button type="button" class="vr-kp-vote down${p.vote === "down" ? " is-active" : ""}" data-kp-vote="down" data-kp-id="${esc(p.id)}" aria-label="${esc(t("kp_vote_aria_down"))}"><span class="vr-kp-arrow">▼</span><span>${esc(t("kp_vote_drop"))}</span></button>
        </div>
      </div>`).join("");
  } else if (!roundVoteResolved) {
    rows = `<div class="vr-kp-row is-skeleton" aria-hidden="true"><div class="vr-kp-skel-bar"></div></div>
      <div class="vr-kp-row is-skeleton" aria-hidden="true"><div class="vr-kp-skel-bar short"></div></div>
      <div class="vr-kp-row is-skeleton" aria-hidden="true"><div class="vr-kp-skel-bar"></div></div>`;
  } else { rows = ""; }   // degraded · streaming finished, no points parsed → just CTAs
  const shift = roundModeShift;
  const shiftHtml = shift
    ? `<div class="vr-kp-shift"><div class="vr-kp-shift-eyebrow">${esc(t("kp_shift_prefix"))}<strong>${esc(shift.to)}</strong></div><div class="vr-kp-shift-why">${esc(shift.because)}</div></div>`
    : "";
  const modeKeep = (roomMode || "").toLowerCase() || t("kp_mode_current");
  let ctas;
  if (shift) {
    ctas = `<div class="vr-kp-ctas">
      <button type="button" class="vr-rc-continue" data-shift-accept data-shift-to="${esc(shift.to)}"><span class="vr-rc-clabel">${esc(t("kp_switch_to", { mode: shift.to }))}</span></button>
      <button type="button" class="vr-rc-end" data-cont>${esc(t("kp_keep_mode", { mode: modeKeep }))}</button>
      <button type="button" class="vr-rc-end vr-rc-adjourn-btn" data-adj>${esc(t("kp_btn_adjourn"))}</button>
    </div>`;
  } else {
    ctas = `<div class="vr-kp-ctas">
      <button type="button" class="vr-rc-continue" data-cont><span class="vr-rc-clabel">${esc(t("m_continue"))}</span></button>
      <button type="button" class="vr-rc-end vr-rc-adjourn-btn" data-adj>${esc(t("m_adjourn_file"))}</button>
    </div>`;
  }
  const html = `<div class="vr-kp-card">
    <div class="vr-kp-eyebrow">${esc(eyebrow)}</div>
    <div class="vr-kp-list">${rows}</div>
    ${shiftHtml}
    ${ctas}
  </div>`;
  return { title: roundEndTitle(), html, mount(b) {
    b.querySelectorAll("[data-kp-vote]").forEach((btn) => btn.addEventListener("click", () => voteKp(btn.dataset.kpId, btn.dataset.kpVote)));
    const sa = b.querySelector("[data-shift-accept]"); if (sa) sa.addEventListener("click", () => doSwitchMode(sa.dataset.shiftTo));
    const cont = b.querySelector("[data-cont]"); if (cont) cont.addEventListener("click", () => doContinue());
    const adj = b.querySelector("[data-adj]"); if (adj) adj.addEventListener("click", () => doAdjourn());
  } };
}
async function doAdjourn() {
  if (!currentRoom || roomStatus === "adjourned") return;
  clearContinue();   // cancel any auto-continue countdown · the user is ending the meeting
  { const s = sfx(); if (s) s.gavel(); }
  let briefFailed = false;
  try { await api.adjournRoom(currentRoom.id, {}); }
  catch (e) {
    // The /adjourn route flips the room to `adjourned` BEFORE kicking off the
    // brief, so a brief-kickoff failure (500) — or an already-adjourned race
    // (409) — still means the room IS adjourned. Reconcile to the adjourned UI
    // instead of leaving the user stuck on the round-end card with a scary
    // "failed" toast; the report can be regenerated from the report view.
    const st = (e && e.status) || 0;
    if (st !== 500 && st !== 409) { toast((e && e.message) || t("m_room_load_fail")); return; }
    briefFailed = st === 500;
  }
  roomStatus = "adjourned"; currentRoom.status = "adjourned"; setStatusPill();
  document.body.classList.add("is-adjourned");
  document.body.classList.remove("is-voting", "is-composing");
  clearPendingTurn();   // adjourn aborts any mid-stream turn · drop its loading bubble
  maybeRenderTextEndCards();
  closeModal();
  toast(briefFailed ? t("m_brief_fail") : t("m_toast_adjourned"));
  // On success the brief generates server-side → brief-final → onBriefFinal.
}
/* Drop any in-flight "thinking" turn · used on adjourn (the orchestrator
   aborts the current turn, so its placeholder never resolves). */
function clearPendingTurn() {
  document.querySelectorAll("[data-chat] .vr-msg-them.is-typing").forEach((el) => el.remove());
  textBubbles.clear();
  voiceReset();
  if (!roomIsText()) { captionHide(); paintStage(null, null); }
  activeSpeaker = null; lastSpeakerId = null; lastSpeakerState = null;
  const s = sfx(); if (s) s.setThinking(false);
}
function onBriefFinal() {
  roomStatus = "adjourned";
  if (currentRoom) currentRoom.status = "adjourned";
  setStatusPill();
  document.body.classList.add("is-adjourned");
  document.body.classList.remove("is-voting");
  toast(t("m_brief_ready"));
  maybeRenderTextEndCards();
}

/* ── Top bar ─────────────────────────────────────────────────── */
function buildTopBar() {
  $("[data-vr-title]").textContent = currentRoom ? (currentRoom.name || currentRoom.subject) : "Voice Room";
  setRoundChip();
}
/* Top-bar chip · for LIVE rooms the round number ("R7") is noise → hidden.
   For ADJOURNED rooms the same slot becomes the voice-replay toggle: tap to
   start (label "Replay") · while playing it reads "Exit Replay". */
function setRoundChip() {
  const el = $("[data-vr-round]"); if (!el) return;
  if (roomStatus === "adjourned") {
    const replaying = document.body.classList.contains("is-replay");
    el.hidden = false;
    el.classList.add("is-replay-btn");
    el.classList.remove("is-roundend-btn");
    el.classList.toggle("is-active", replaying);
    el.setAttribute("role", "button");
    el.textContent = replaying ? t("m_replay_exit") : t("m_replay_start");
  } else if (awaitingContinue) {
    // Live room waiting on a round-end decision · the chip becomes the
    // re-open affordance for the (dismissible) round-end / vote sheet.
    el.hidden = false;
    el.classList.remove("is-replay-btn", "is-active");
    el.classList.add("is-roundend-btn");
    el.setAttribute("role", "button");
    el.textContent = String(t("m_round_done")).replace(/[.。]\s*$/, "") + " ›";
  } else {
    el.hidden = true;
    el.classList.remove("is-replay-btn", "is-active", "is-roundend-btn");
    el.removeAttribute("role");
  }
}

/* ── Cast rail (avatar chips) ────────────────────────────────── */
let railChips = new Map();
function buildRail() {
  const rail = $("[data-rail]");
  rail.innerHTML = "";
  railChips = new Map();
  for (const m of MEMBERS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "vr-chip";
    chip.dataset.id = m.id;
    const short = m.id === "chair" ? "Chair" : m.name.split(" ")[0];
    // PNG portrait when there is one; monogram for freshly-created agents.
    const face = m.avatarPath
      ? `<img src="${m.avatarPath}" alt="" draggable="false">`
      : `<span class="vr-chip-mono">${(m.name || "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}</span>`;
    chip.innerHTML = `${face}<span>${short}</span>`;
    chip.addEventListener("click", () => {
      if (window.MobileVoiceStage3D) window.MobileVoiceStage3D.focusSeat(m.id);
      setRailActive(m.id);
      if (!m.__isUser) openAgentProfile(m.id);   // also open the tapped director's profile
    });
    rail.appendChild(chip);
    railChips.set(m.id, chip);
  }
}
function setRailActive(id) {
  for (const [cid, el] of railChips) el.classList.toggle("is-active", cid === id);
  // keep the active chip scrolled into view
  const el = railChips.get(id);
  if (el && el.scrollIntoView) el.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
}

/* ── Caption band ────────────────────────────────────────────── */
let capRaf = 0;
const capNow = () => (window.performance && performance.now) ? performance.now() : Date.now();
function stopCaptionTick() { if (capRaf) { cancelAnimationFrame(capRaf); capRaf = 0; } }
/* Split a turn into sentences (each keeps its ender). Lets the caption show
   only the CURRENT sentence instead of the whole growing paragraph. */
function captionSentences(text) {
  const s = String(text || ""); const out = []; let last = 0;
  const re = /[.!?。！？…]+["'”’)\]]?(?:\s+|$)/g; let m;
  while ((m = re.exec(s))) { const end = m.index + m[0].length; out.push({ start: last, end, text: s.slice(last, end) }); last = end; if (re.lastIndex <= m.index) re.lastIndex = m.index + 1; }
  if (last < s.length) out.push({ start: last, end: s.length, text: s.slice(last) });
  return out.length ? out : [{ start: 0, end: s.length, text: s }];
}
/* Render only the sentence the reveal cursor sits in, sliced to the revealed
   portion · a single-sentence rolling subtitle that never buries the stage. */
function renderCaptionWindow(fullText, revealedChars) {
  const el = $("[data-cap-text]"); if (!el) return;
  const full = String(fullText || "");
  const n = Math.max(0, Math.min(full.length, revealedChars | 0));
  const sents = captionSentences(full);
  let cur = sents[sents.length - 1];
  for (const sg of sents) { if (n <= sg.end) { cur = sg; break; } }
  const local = Math.max(0, Math.min(cur.text.length, n - cur.start));
  el.textContent = cur.text.slice(0, local).replace(/^\s+/, "");
  el.scrollTop = el.scrollHeight;   // keep the newest line in view if it wraps
}
function captionThinking(name) {
  stopCaptionTick();
  autoCollapseDock();   // a turn is starting · fold the rail + dock for a clean caption
  const band = $("[data-caption]");
  band.classList.remove("is-hidden");
  band.classList.add("is-thinking");
  $("[data-cap-kicker]").textContent = name;
  $("[data-cap-text]").textContent = "";
}
function captionSpeak(name) {
  autoCollapseDock();   // covers turns that skip the thinking beat (e.g. replay)
  const band = $("[data-caption]");
  band.classList.remove("is-hidden", "is-thinking");
  $("[data-cap-kicker]").textContent = name;
}
/* Back-compat · callers passing accumulated text (live SSE tokens, the
   offline driver's growing slice) get the current-sentence window. */
function captionReveal(textSoFar) { stopCaptionTick(); renderCaptionWindow(textSoFar, String(textSoFar || "").length); }
function captionHide() { stopCaptionTick(); $("[data-caption]").classList.add("is-hidden"); }
/* Karaoke caption synced to the playing clip. The naive "reveal = currentTime
   / duration × totalChars" races AHEAD of the voice: it keeps revealing during
   a sentence's trailing pause (silence), so the caption jumps into the next
   sentence before it's spoken. Instead we map audio progress onto the ACTUAL
   per-sentence audio spans: each voice-chunk repeats its sentence text + carries
   its own audio bytes, so collapsing runs of equal text gives one segment per
   sentence whose byte share ≈ its time share. The reveal then holds at a
   sentence's end through its pause and only advances when that sentence's audio
   bytes are actually consumed. `caps` absent (replay / no per-chunk text) →
   fall back to the linear map over `fullText`. */
function captionFollowAudio(fullText, audio, caps) {
  stopCaptionTick();
  // Collapse consecutive same-text chunks into per-sentence segments and build
  // a joined text with byte+char offsets (only when we actually have text).
  let segs = null, joined = String(fullText || ""), totBytes = 0, total = joined.length;
  if (Array.isArray(caps) && caps.length) {
    const grouped = [];
    for (const c of caps) {
      const txt = (c && typeof c.text === "string") ? c.text.trim() : "";
      const by = (c && c.bytes) ? c.bytes : 0;
      const last = grouped[grouped.length - 1];
      if (last && last.text === txt) { last.bytes += by; } else { grouped.push({ text: txt, bytes: by }); }
    }
    if (grouped.some((g) => g.text.length)) {
      segs = []; joined = ""; let bAcc = 0;
      for (const g of grouped) {
        if (joined && g.text) joined += " ";
        const cStart = joined.length; joined += g.text;
        segs.push({ cStart, cLen: g.text.length, bStart: bAcc, bytes: g.bytes });
        bAcc += g.bytes;
      }
      totBytes = bAcc; total = joined.length;
    }
  }
  const tick = () => {
    capRaf = 0;
    if (!audio || audio.ended) { renderCaptionWindow(joined, total); return; }
    const dur = (audio.duration && isFinite(audio.duration) && audio.duration > 0) ? audio.duration : 0;
    let chars;
    if (segs && totBytes > 0 && dur > 0) {
      const playedB = (audio.currentTime / dur) * totBytes;
      let s = segs[segs.length - 1];
      for (const sg of segs) { if (playedB < sg.bStart + sg.bytes) { s = sg; break; } }
      const within = s.bytes > 0 ? Math.max(0, Math.min(1, (playedB - s.bStart) / s.bytes)) : 1;
      chars = s.cStart + Math.round(within * s.cLen);
    } else {
      chars = dur > 0 ? Math.round((audio.currentTime / dur) * total) : Math.min(total, Math.round(audio.currentTime * 14));
    }
    renderCaptionWindow(joined, chars);
    capRaf = requestAnimationFrame(tick);
  };
  tick();
}
function captionFollowTimed(fullText, ms) {
  stopCaptionTick();
  const total = String(fullText || "").length; const start = capNow(); const dur = Math.max(1, ms);
  const tick = () => {
    capRaf = 0;
    const p = Math.min(1, (capNow() - start) / dur);
    renderCaptionWindow(fullText, Math.round(p * total));
    if (p < 1) capRaf = requestAnimationFrame(tick);
  };
  tick();
}

/* ── Transcript sheet ────────────────────────────────────────── */
function appendTranscript(member, text) {
  const list = $("[data-transcript]");
  if (!list) return;   // transcript view removed · live transcript renders to chat instead
  const row = document.createElement("div");
  row.className = "vr-tr-row";
  const av = member && member.avatarPath ? `<img class="vr-tr-av" src="${member.avatarPath}" alt="" draggable="false">` : "";
  const name = member && member.name ? member.name : "—";
  row.innerHTML = `${av}<div class="vr-tr-body"><div class="vr-tr-who">${name}</div><div class="vr-tr-text">${text}</div></div>`;
  list.appendChild(row);
  const panel = document.querySelector('[data-panel="transcript"]');
  if (panel) panel.scrollTop = panel.scrollHeight;
}

/* ── Chat (text-delivery rooms) ──────────────────────────────── */
let _textBubble = null;   // legacy single-slot (offline driver · dead)
function chatScroll() { const w = $("[data-chat]"); if (w) w.scrollTop = w.scrollHeight; }
/* ── Text-room chat bubbles · keyed PER messageId so interleaved speakers
   (chair + director) never share or orphan a bubble. Every bubble is
   resolved on message-final (revealed, or removed if it carried no body —
   e.g. a chair round-marker). ─────────────────────────────────────────── */
const textBubbles = new Map();   // messageId → chat row element
function textEnsureBubble(messageId, m) {
  let row = textBubbles.get(messageId);
  if (row) return row;
  const wrap = $("[data-chat]"); if (!wrap) return null;
  row = document.createElement("div");
  row.className = "vr-msg vr-msg-them is-typing";
  row.innerHTML = `${avatarThumb(m, 30)}<div class="vr-msg-body"><div class="vr-msg-who">${esc(m && m.name ? m.name : "—")}</div><div class="vr-msg-text vr-md"><span class="vr-typing"><i></i><i></i><i></i></span></div></div>`;
  wrap.appendChild(row); chatScroll();
  textBubbles.set(messageId, row);
  return row;
}
/* Live streaming · plain text (markdown is applied once at message-final to
   avoid rendering half-open ** / ## mid-stream). */
function textRevealMsg(messageId, body, who) {
  const row = textBubbles.get(messageId) || textEnsureBubble(messageId, who);
  if (!row) return;
  row.classList.remove("is-typing");
  const txt = row.querySelector(".vr-msg-text"); if (txt) txt.textContent = body;
  chatScroll();
}
/* Finalise a director message · render its markdown, or drop the row entirely
   when it carried nothing (round markers, procedural pings). */
function textFinalMsg(messageId, body, who) {
  const clean = String(body || "").trim();
  if (!clean) { const row = textBubbles.get(messageId); if (row) row.remove(); textBubbles.delete(messageId); return; }
  const row = textBubbles.get(messageId) || textEnsureBubble(messageId, who);
  if (row) { row.classList.remove("is-typing"); const txt = row.querySelector(".vr-msg-text"); if (txt) txt.innerHTML = mdToHtml(clean); chatScroll(); }
  textBubbles.delete(messageId);   // settled · no longer a live streaming target
}
function appendChatUser(text) {
  const wrap = $("[data-chat]"); if (!wrap) return;
  const row = document.createElement("div");
  row.className = "vr-msg vr-msg-me";
  row.innerHTML = `<div class="vr-msg-text">${esc(text)}</div>`;
  wrap.appendChild(row); chatScroll();
}
function fillChatAll() {
  const wrap = $("[data-chat]"); if (!wrap) return;
  wrap.innerHTML = "";
  ensureSession();
  (recordedTranscript.length ? recordedTranscript : flattenSession(currentSession)).forEach((t) => {
    const m = byId(t.speakerId) || { name: t.speakerId };
    const row = document.createElement("div");
    row.className = "vr-msg vr-msg-them";
    row.innerHTML = `${avatarThumb(m, 30)}<div class="vr-msg-body"><div class="vr-msg-who">${m.name}</div><div class="vr-msg-text">${esc(t.text)}</div></div>`;
    wrap.appendChild(row);
  });
  chatScroll();
}

/* ── Composer · user asks the board (both modes) ─────────────────────
   Interject model (desktop parity): while a director is mid-speak the
   user chooses to INTERRUPT now or QUEUE after the current speaker; in
   the clarify phase the reply routes to the chair. The board's reply is
   composed from the responder's lens + the user's own words — never a
   fixed canned line. ─────────────────────────────────────────────── */
let pendingInterject = null;   // text queued to flush at the next beat boundary
function cancelCompose() {
  document.body.classList.remove("is-composing");
  const input = $("[data-composer-input]"); if (input) { input.value = ""; input.blur(); }
}
function wireComposer() {
  const send = $("[data-composer-send]"); if (send) { send.innerHTML = ICON.send; send.addEventListener("click", submitComposer); }
  const cancel = $("[data-composer-cancel]"); if (cancel) { cancel.innerHTML = ICON.x; cancel.addEventListener("click", cancelCompose); }
  const input = $("[data-composer-input]");
  if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { if (e.isComposing || e.keyCode === 229) return; e.preventDefault(); submitComposer(); } else if (e.key === "Escape") { cancelCompose(); } });
}
function submitComposer() {
  const input = $("[data-composer-input]"); if (!input) return;
  const text = input.value.trim(); if (!text || roomStatus === "adjourned") return;
  input.value = "";
  sendUserMessage(text);
}
function sendUserMessage(text) {
  document.body.classList.remove("is-composing");
  const body = String(text || "").trim(); if (!body || !currentRoom) return;
  if (awaitingContinue) clearContinue();   // a user message ends the round-wait server-side · drop the countdown + bar
  // Mid-stream a director is actively speaking → offer interrupt-now vs
  // queue-after-speaker (the backend's two message modes).
  const speakingId = activeSpeaker;
  const directorSpeaking = speakingId && speakingId !== "chair" && speakingId !== (CHAIR && CHAIR.id);
  if (directorSpeaking) {
    const who = (byId(speakingId) || {}).name || "the speaker";
    showAsk(t("m_ask_q", { who }), [
      { label: t("m_ask_interrupt"), primary: true, on: () => postUserMessage(body, "now") },
      { label: t("m_ask_after", { who: who.split(" ")[0] }), on: () => postUserMessage(body, "after-speaker") },
      { label: t("m_ask_cancel"), on: () => { /* dismissed */ } },
    ]);
    return;
  }
  // Clarify phase or a gap → deliver immediately (the chair answers during clarify).
  postUserMessage(body, "now");
}
/* POST the user's message · the server creates it + echoes it back over
   SSE (message-appended, authorKind:user), so we never render optimistically. */
function postUserMessage(body, mode) {
  if (!currentRoom) return;
  if (mode === "after-speaker") toast(t("m_toast_queued"));
  api.sendMessage(currentRoom.id, { body, mode: mode === "after-speaker" ? "after-speaker" : "now" })
    .catch((e) => { toast((e && e.message) || t("m_send_fail")); });
}

/* Pick who answers the user · the chair during clarify, otherwise the
   active director whose lens best matches the user's words. */
function pickResponder(text) {
  if (roomState && roomState.phase === PHASE.CLARIFY) return (CHAIR && CHAIR.id) || "chair";
  const active = ROSTER.filter((r) => r.active);
  if (!active.length) return (CHAIR && CHAIR.id) || "chair";
  const d = (text || "").toLowerCase();
  const arch = ROLE_ARCHETYPES.find((a) => a.kw.some((k) => d.includes(k)));
  if (arch) {
    const key = arch.role.toLowerCase().split(" ")[0];
    const hit = active.find((r) => ((AGENTS_META[r.id] || {}).roleTag || "").toLowerCase().includes(key)
      || (r.name || "").toLowerCase().includes(key));
    if (hit) return hit.id;
  }
  // else rotate by the message so it isn't always the same director
  return active[hashStr(text) % active.length].id;
}
/* Short, cleaned fragment of the user's message for the reply to echo. */
function userFrag(text) {
  let s = String(text || "").trim().replace(/[?？.。!！]+$/g, "");
  if (s.length > 52) s = s.slice(0, 49).trim() + "…";
  return s;
}
/* Topical reply · echoes the user's point + the responder's character. */
function composeReply(text, respId) {
  const frag = userFrag(text);
  if (respId === ((CHAIR && CHAIR.id) || "chair")) return `Good — “${frag}”. Let me put that to the board.`;
  const meta = AGENTS_META[respId] || {};
  const leads = [`On “${frag}” — let me take the harder case.`, `“${frag}” is the right thing to push on. Here's where I land:`, `Let me reframe “${frag}”:`];
  const lead = leads[hashStr(text + respId) % leads.length];
  const stance = meta.bio ? meta.bio.replace(/\.$/, "") + "." : "the real question underneath is whether the cost is reversible.";
  return `${lead} ${stance}`;
}
/* Play one user→board exchange (bubble/chat + countdown + reply), then
   call onDone. The driver gates this behind a non-advancing phase so the
   round clock never overlaps it. */
function doInterject(text, onDone) {
  const respId = pickResponder(text);
  const m = byId(respId) || CHAIR || { name: "Chair" };
  const reply = composeReply(text, respId);
  recordedTranscript.push({ speakerId: "__user", name: "You", text });
  if (roomDelivery === "text") {
    appendChatUser(text);
    textThinking(m);
    setTimeout(() => { textSpeakStart(m); textReveal(reply); recordedTranscript.push({ speakerId: respId, name: m.name, text: reply }); }, 900);
    setTimeout(() => { if (onDone) onDone(); }, 2600);
    return;
  }
  appendTranscript({ name: "You" }, text);
  pendingUserBubble = { text, progress: 1 };
  if (MV) MV.focusSeat(null);                    // wide shot so the front "You" seat is in frame
  paintStage(lastSpeakerId, lastSpeakerState);   // shows the user bubble (CSS countdown starts)
  setTimeout(() => { if (MV) MV.focusSeat(respId); captionSpeak(m.name); captionReveal(reply); appendTranscript(m, reply); setRailActive(respId); recordedTranscript.push({ speakerId: respId, name: m.name, text: reply }); }, 1100);
  setTimeout(() => { pendingUserBubble = null; paintStage(lastSpeakerId, lastSpeakerState); if (onDone) onDone(); }, 6000);
}

/* Lightweight action sheet (interrupt vs queue). */
function showAsk(prompt, options) {
  const el = $("[data-ask]");
  if (!el) { const o = options[0]; if (o && o.on) o.on(); return; }
  el.innerHTML = `<div class="vr-ask-card"><div class="vr-ask-q">${esc(prompt)}</div><div class="vr-ask-opts">${options.map((o, i) => `<button type="button" class="vr-ask-opt${o.primary ? " primary" : ""}" data-ask-i="${i}">${esc(o.label)}</button>`).join("")}</div></div>`;
  el.querySelectorAll("[data-ask-i]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); hideAsk(); const o = options[Number(b.dataset.askI)]; if (o && o.on) o.on(); }));
  el.onclick = (e) => { if (e.target === el) hideAsk(); };
  document.body.classList.add("is-asking");
}
function hideAsk() { document.body.classList.remove("is-asking"); }

/* Director picker · bottom-sheet overlay stacked over the new-room form.
   Tapping a director toggles draft.directorIds (min 2 enforced); Done /
   scrim-tap closes and re-renders the form so its count reflects the pick. */
function openDirectorPicker() { renderDirectorPicker(); document.body.classList.add("is-dpick"); }
function closeDirectorPicker() { document.body.classList.remove("is-dpick"); renderModal(); }
function renderDirectorPicker() {
  const el = $("[data-dpick]"); if (!el || !draft) return;
  // The director rows ALWAYS reflect draft.directorIds membership. When
  // Auto-pick is on, the list carries .is-auto which just dims them (the
  // manual picks are kept, ready if you switch). So toggling never needs a
  // full re-render — auto↔manual is a class flip, picks are row updates.
  const castMark = (on) => `<span class="vr-cast-btn${on ? " is-remove" : ""}" aria-hidden="true">${on ? ICON.check : ICON.plus}</span>`;
  const rowHtml = (r) => {
    const on = draft.directorIds.includes(r.id);
    return `<div class="vr-cast-row${on ? " is-on" : ""}" data-dcast="${r.id}" role="button" tabindex="0" aria-pressed="${on}"><img src="${r.avatarPath}" alt="" draggable="false"><span class="vr-cast-name">${esc(r.name)}</span>${castMark(on)}</div>`;
  };
  const autoRow = `<div class="vr-cast-row vr-auto-row${draft.autoPick ? " is-on" : ""}" data-auto role="button" tabindex="0" aria-pressed="${!!draft.autoPick}"><span class="vr-auto-ic">${ICON.spark}</span><span class="vr-cast-name vr-auto-name"><b>${esc(t("m_nr_auto"))}</b><em>${esc(t("m_nr_auto_hint"))}</em></span>${castMark(!!draft.autoPick)}</div>`;
  el.innerHTML = `<div class="vr-dpick-card"><div class="vr-dpick-head"><button type="button" class="vr-dpick-back" data-dpickback aria-label="Back">${ICON.back}</button><h3 class="vr-dpick-title" data-dpicktitle>${esc(t("m_nr_board"))}</h3><button type="button" class="vr-dpick-done" data-dpickdone>${esc(t("m_dpick_done"))}</button></div><div class="vr-dpick-list${draft.autoPick ? " is-auto" : ""}" data-dpicklist>${autoRow}<div class="vr-dpick-sep">${esc(t("m_nr_or_choose"))}</div>${ROSTER.map(rowHtml).join("")}</div></div>`;
  const listEl = el.querySelector("[data-dpicklist]");
  const autoEl = el.querySelector("[data-auto]");
  const syncAuto = () => { autoEl.classList.toggle("is-on", !!draft.autoPick); autoEl.setAttribute("aria-pressed", String(!!draft.autoPick)); const m = autoEl.querySelector(".vr-cast-btn"); if (m) { m.classList.toggle("is-remove", !!draft.autoPick); m.innerHTML = draft.autoPick ? ICON.check : ICON.plus; } listEl.classList.toggle("is-auto", !!draft.autoPick); };
  autoEl.addEventListener("click", (e) => { e.stopPropagation(); draft.autoPick = true; syncAuto(); });
  el.querySelectorAll("[data-dcast]").forEach((row) => row.addEventListener("click", (e) => {
    e.stopPropagation();
    const id = row.dataset.dcast, i = draft.directorIds.indexOf(id);
    if (i >= 0) { if (draft.directorIds.length <= 2) { toast(t("m_toast_pick_two")); return; } draft.directorIds.splice(i, 1); }
    else draft.directorIds.push(id);
    draft.autoPick = false;            // picking a director switches to manual
    const on = draft.directorIds.includes(id);
    row.classList.toggle("is-on", on); row.setAttribute("aria-pressed", String(on));
    const mark = row.querySelector(".vr-cast-btn");
    if (mark) { mark.classList.toggle("is-remove", on); mark.innerHTML = on ? ICON.check : ICON.plus; }
    syncAuto();                        // un-dim the list + clear the auto row
  }));
  el.querySelector("[data-dpickdone]").addEventListener("click", (e) => { e.stopPropagation(); closeDirectorPicker(); });
  el.querySelector("[data-dpickback]").addEventListener("click", (e) => { e.stopPropagation(); closeDirectorPicker(); });
  el.onclick = (e) => { if (e.target === el) closeDirectorPicker(); };
}

/* ── Control dock ────────────────────────────────────────────── */
let driver = null; // set by startDriver
let currentSession = null;   // per-room arc (buildSession) · null until built
let roomState = null;        // phase state machine (createRoomState)
let recordedTranscript = []; // [{speakerId,name,text}] actually played this room
let lastReport = null;       // report data filed on adjourn (rendered in task 5)
const ARCHIVES = {};         // roomId → { transcript, report } for adjourned rooms
const sessionDirectors = () => ROSTER.filter((r) => r.active);

/* ── Offline persistence (store.js) ──────────────────────────────────
   Persist user-created rooms, created directors, and adjourned-room
   archives so a reload keeps the user's work. modelSel / rulesSel /
   memSel already persist under their own keys. */
function createdAgents() {
  // Created directors are the CAST entries beyond the seeded set (ids
  // start with "a" + timestamp; seeded ids are slugs).
  return CAST.filter((c) => /^a\d/.test(c.id)).map((c) => ({
    id: c.id, name: c.name, roleKind: c.roleKind || "director",
    avatarPath: c.avatarPath || "", avatar3d: c.avatar3d || { model: "casual" },
    meta: AGENTS_META[c.id] || null,
  }));
}
function persistState() {
  saveStore({ rooms: ROOMS, agents: createdAgents(), archives: ARCHIVES });
}
function hydrateState() {
  const s = loadStore();
  if (!s) return;
  if (Array.isArray(s.rooms) && s.rooms.length) { ROOMS.length = 0; ROOMS.push(...s.rooms); }
  if (Array.isArray(s.agents)) {
    for (const a of s.agents) {
      if (!a || !a.id || CAST.find((c) => c.id === a.id)) continue;
      const rec = { id: a.id, name: a.name, roleKind: a.roleKind || "director", avatarPath: a.avatarPath || "", avatar3d: a.avatar3d || { model: "casual" } };
      CAST.push(rec);
      if (rec.roleKind === "director") ROSTER.push({ ...rec, active: false });
      if (a.meta) AGENTS_META[a.id] = a.meta;
    }
  }
  if (s.archives && typeof s.archives === "object") Object.assign(ARCHIVES, s.archives);
}

/* ── Minimal hash router · reflects the current view so refresh
   restores it, and the browser/Android back button closes a modal /
   exits a room instead of leaving the app. */
let _routing = false;
function setHash(h) { try { if (location.hash !== h) history.pushState(null, "", h); } catch (_) { /* */ } }
function initRouter() {
  try { if (!location.hash) history.replaceState(null, "", "#/"); } catch (_) { /* */ }
  window.addEventListener("popstate", () => {
    _routing = true;
    // A modal is open → back closes it (whole modal, any depth).
    if (modalStack.length) { closeModal(); _routing = false; return; }
    // Otherwise reconcile room vs home from the (now-popped) hash.
    let h = ""; try { h = location.hash || ""; } catch (_) { /* */ }
    const m = /^#\/room\/(.+)$/.exec(h);
    if (m) {
      const wantId = decodeURIComponent(m[1]);
      if (!currentRoom || currentRoom.id !== wantId) { const r = ROOMS.find((x) => x.id === wantId); if (r) enterRoom(r); }
    } else if (currentRoom) {
      // Leaving while the room is actively PLAYING (back gesture / back button) ·
      // confirm, then PAUSE the room on the way out so it doesn't keep running.
      // Paused / voting / adjourned all skip the prompt. On cancel, re-push the
      // room hash so we stay put.
      if (roomStatus === "live" && !roomPaused) {
        if (!window.confirm(t("m_room_leave_confirm"))) {
          try { history.pushState(null, "", "#/room/" + encodeURIComponent(currentRoom.id)); } catch (_) { /* */ }
          _routing = false; return;
        }
        // Confirmed · pause the room (persisted on the server) + reflect it in
        // the home list immediately, then leave.
        const rid = currentRoom.id;
        const rec = ROOMS.find((x) => x.id === rid); if (rec) rec.status = "paused";
        api.pauseRoom(rid, "hard").catch(() => { /* best-effort · we're leaving */ });
      }
      exitRoom();
    }
    _routing = false;
  });
}
function restoreFromHash() {
  let h = "";
  try { h = location.hash || ""; } catch (_) { /* */ }
  const m = /^#\/room\/(.+)$/.exec(h);
  if (m) {
    const room = ROOMS.find((r) => r.id === decodeURIComponent(m[1]));
    if (room) {
      // Seed a home entry BENEATH the room so the back button exits to
      // home, then enter without enterRoom pushing its own duplicate.
      try { history.replaceState(null, "", "#/"); } catch (_) { /* */ }
      _routing = true; enterRoom(room); _routing = false;
      try { history.pushState(null, "", "#/room/" + encodeURIComponent(room.id)); } catch (_) { /* */ }
      return true;
    }
  }
  if (h === "#/directors") { switchHomeTab("directors"); return true; }
  return false;
}
/* Retired · the offline session sim is gone (the real backend drives rooms).
   These stubs keep the unused legacy driver functions below well-formed
   without re-introducing the session-model / room-state dependency. */
function ensureSession() { /* no-op · offline session retired */ }
function flattenSession() { return []; }
/** The current round flattened to playable beats · [clarify?, …turns]. */
function roundBeats(roundIdx) {
  if (!currentSession) return [];
  const r = currentSession.rounds[roundIdx];
  if (!r) return [];
  const beats = [];
  if (r.clarify) beats.push({ ...r.clarify, kind: "clarify" });
  for (const t of r.turns) beats.push({ ...t, kind: "turn" });
  return beats;
}
function wireDock() {
  $("[data-act=interject]").innerHTML = ICON.hand;
  $("[data-act=playpause]").innerHTML = ICON.pause;

  $("[data-act=interject]").addEventListener("click", () => {
    // Reveal the composer to ask the board · the discussion keeps playing
    // while you compose (only pauses on send, for the board's reply).
    const on = document.body.classList.toggle("is-composing");
    if (on) {
      const i = $("[data-composer-input]");
      if (i) { i.placeholder = roomAwaitingClarify ? t("m_composer_clarify") : t("m_composer_ask"); i.focus(); }
    }
  });
  $("[data-act=playpause]").addEventListener("click", () => { void togglePlayPause(); });
  document.querySelectorAll("[data-act=rate]").forEach((b) => b.addEventListener("click", cycleRate));
  applyRate();
  // Text-view toggle · its own button in the dock + adjourned bar.
  document.querySelectorAll("[data-act=viewtext]").forEach((b) => b.addEventListener("click", () => toggleViewAsText()));
  setViewToggleIcon();
  // Collapse toggle · fold the rail + dock away (and back) during playback.
  const dtog = $("[data-dock-toggle]");
  if (dtog) { dtog.innerHTML = ICON.chev; dtog.addEventListener("click", () => setDockCollapsed(!document.body.classList.contains("is-dock-collapsed"))); }
}
/* Collapse / expand the bottom controls (cast rail + dock / adjourned bar).
   Folded, the caption owns the bottom and isn't crowded; the toggle button
   stays put (it rides the right edge) so the controls are one tap away. */
function setDockCollapsed(c) {
  document.body.classList.toggle("is-dock-collapsed", !!c);
  const b = $("[data-dock-toggle]");
  if (b) b.setAttribute("aria-label", c ? t("m_dock_expand_aria") : t("m_dock_collapse_aria"));
}
/* Auto-fold when a live turn begins so the speaking subtitle reads cleanly.
   Fires at most once per turn (from caption thinking/speak), so a manual
   expand mid-turn sticks until the next speaker. Live stage only — adjourned
   replay + text views keep their controls. */
function autoCollapseDock() {
  if (roomStatus === "adjourned" || roomIsText()) return;
  setDockCollapsed(true);
}

let toastTimer = 0;
function toast(msg) {
  const t = $("[data-toast]");
  t.textContent = msg;
  t.classList.add("is-shown");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-shown"), 2600);
}

/* ── Tabs · Transcript / Queue / Vote ────────────────────────── */
function wireTabs() {
  const tabs = Array.from(document.querySelectorAll(".vr-tab"));
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle("is-active", t === tab));
      document.querySelectorAll(".vr-panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === name));
    });
  });
}

/* ── Queue panel · the CURRENT round's speaking order, rebuilt each
   round; status updated live per beat ─────────────────────────────── */
function buildQueue(beats) {
  const order = $("[data-order]");
  if (!order) return;
  order.innerHTML = "";
  const list = beats || [];
  list.forEach((beat, i) => {
    const m = byId(beat.speakerId);
    const row = document.createElement("div");
    row.className = "vr-order-row is-up";
    row.dataset.qrow = String(i);
    const tag = beat.kind === "clarify" ? t("m_q_framing") : t("m_q_up_next");
    row.innerHTML = `<span class="vr-order-n">${String(i + 1).padStart(2, "0")}</span><span>${esc(m ? m.name : beat.speakerId)}</span><span class="vr-order-status">${esc(tag)}</span>`;
    order.appendChild(row);
  });
}
function markQueue(curIdx) {
  const order = $("[data-order]");
  if (!order) return;
  order.querySelectorAll(".vr-order-row").forEach((row) => {
    const i = Number(row.dataset.qrow);
    row.classList.toggle("is-done", i < curIdx);
    row.classList.toggle("is-current", i === curIdx);
    row.classList.toggle("is-up", i > curIdx);
    const st = row.querySelector(".vr-order-status");
    if (st) st.textContent = i < curIdx ? t("m_q_spoke") : i === curIdx ? t("m_q_speaking") : t("m_q_up_next");
  });
}
function showVoteDot() { const d = $("[data-vote-dot]"); if (d) d.hidden = false; }

/* ── Canvas-tap → rail sync ──────────────────────────────────── */
function wireFocusSync() {
  document.addEventListener("mvoice:focus", (e) => {
    if (e && e.detail && e.detail.id) setRailActive(e.detail.id);
  });
}

/* ── The driver · plays ONE round's beats (clarify? + director turns)
   on a rAF clock, then hands off to the vote. `nextRound()` (called
   after a "continue" vote) reloads the clock for the next round. ───── */
function startDriver() {
  ensureSession();
  const speakDurOf = (t) => Math.max(1800, Math.min(7000, t.text.length * 42));
  const GAP_MS = 1200;
  let beats = [];
  let idx = 0, phase = "think", phaseStart = 0, playT = 0, lastTs = 0;
  let paused = false, rate = 1, revealed = -1, speakDur = 0, raf = 0;
  const isText = () => roomDelivery === "text";

  function loadRound() {
    beats = roundBeats(roomState.roundIdx);
    buildQueue(beats);
    setRoundChip();
    roomState[(beats[0] && beats[0].kind === "clarify") ? "toClarify" : "toLive"]();
    setStatusPill();
    beginBeat(0);
  }
  function beginBeat(i) {
    idx = i; phase = "think"; phaseStart = playT; revealed = -1;
    const t = beats[i]; if (!t) return;
    // The clarify beat holds CLARIFY; the first director turn flips to LIVE.
    if (t.kind === "turn" && roomState.phase === PHASE.CLARIFY) { roomState.toLive(); setStatusPill(); }
    const m = byId(t.speakerId);
    if (isText()) {
      textThinking(m || { name: t.speakerId });
    } else {
      paintStage(t.speakerId, "thinking");
      if (MV) MV.focusSeat(t.speakerId);
      captionThinking(m ? m.name : t.speakerId);
      setRailActive(t.speakerId);
    }
    markQueue(i);
    const s = sfx(); if (s) { s.speakerChange(); s.setThinking(true); }   // cut cue + thinking pulse
  }
  function startSpeak() {
    const t = beats[idx], m = byId(t.speakerId);
    phase = "speak"; phaseStart = playT; revealed = -1; speakDur = speakDurOf(t);
    const s = sfx(); if (s) s.setThinking(false);                          // thinking → speaking
    if (isText()) {
      textSpeakStart(m || { name: t.speakerId });
    } else {
      paintStage(t.speakerId, "speaking");
      captionSpeak(m ? m.name : t.speakerId);
      appendTranscript(m || { name: t.speakerId }, t.text);
    }
    recordedTranscript.push({ speakerId: t.speakerId, name: m ? m.name : t.speakerId, text: t.text });
  }
  function continueAfter(next) {
    if (next >= beats.length) { phase = "roundgap"; phaseStart = playT; if (!isText()) { paintStage(null, null); captionHide(); } }
    else beginBeat(next);
  }
  function afterBeat() {
    const next = idx + 1;
    // A queued ("after current") interject flushes here, before the next
    // beat; the interject phase freezes the round clock until it resolves.
    if (pendingInterject) {
      const txt = pendingInterject; pendingInterject = null;
      phase = "interject";
      doInterject(txt, () => continueAfter(next));
      return;
    }
    continueAfter(next);
  }
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!lastTs) lastTs = ts;
    let dt = ts - lastTs; lastTs = ts;
    if (dt > 100) dt = 100;
    if (!paused) playT += dt * rate;
    const t = beats[idx];
    const elapsed = playT - phaseStart;
    if (phase === "think") {
      if (t && elapsed >= t.thinkMs) startSpeak();
    } else if (phase === "speak") {
      const chars = Math.min(t.text.length, Math.floor((elapsed / speakDur) * t.text.length));
      if (chars !== revealed) { revealed = chars; isText() ? textReveal(t.text.slice(0, chars)) : captionReveal(t.text.slice(0, chars)); const s = sfx(); if (s) s.tick(); }
      if (elapsed >= speakDur) afterBeat();
    } else if (phase === "roundgap") {
      if (elapsed >= GAP_MS) { phase = "idle"; if (raf) cancelAnimationFrame(raf); raf = 0; onRoundComplete(); }
    }
  }

  loadRound();
  raf = requestAnimationFrame(frame);

  driver = {
    togglePause() { paused = !paused; return paused; },
    setPaused(p) { paused = !!p; },
    cycleRate() { rate = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1; return rate; },
    nextRound() { phase = "think"; playT = 0; phaseStart = 0; lastTs = 0; paused = false; revealed = -1; if (!raf) raf = requestAnimationFrame(frame); loadRound(); },
    /** Interrupt now · play the exchange immediately, then continue to
     *  the next beat (the current speaker is cut short). */
    interject(text) {
      const next = idx + 1;
      phase = "interject";
      doInterject(text, () => continueAfter(next));
    },
    /** The currently-speaking beat (mode-agnostic), or null. */
    speaking() { return phase === "speak" && beats[idx] ? { id: beats[idx].speakerId, kind: beats[idx].kind } : null; },
    stop() { if (raf) cancelAnimationFrame(raf); raf = 0; const s = sfx(); if (s) s.setThinking(false); },
    isText,
  };
}

/* ── Round wrap → vote → continue / adjourn ───────────────────── */
function onRoundComplete() {
  if (!roomState || !currentSession) return;
  roomState.toRoundEnd();
  setStatusPill();
  const round = currentSession.rounds[roomState.roundIdx];
  if (!round || !round.vote) { adjournWithReport(null); return; }
  if (roomDelivery !== "text") { captionSpeak((CHAIR && CHAIR.name) || "Chair"); captionReveal(t("m_round_wrap")); }
  openVote(round);
}
function openVote(round) {
  roomState.toVoting();
  setStatusPill();
  showVoteDot();
  document.body.classList.add("is-voting");
  renderVoteBar(round.vote);
  renderVoteTab(round.vote, null);
}
function renderVoteBar(vote) {
  const bar = $("[data-votebar]"); if (!bar) return;
  const opts = vote.options.map((o) => `<button type="button" class="vr-vote-opt${o.primary ? " primary" : ""}" data-vopt="${o.id}">${esc(o.label)}</button>`).join("");
  bar.innerHTML = `<div class="vr-votebar-q">${esc(vote.question)}</div><div class="vr-votebar-opts">${opts}</div>`;
  bar.querySelectorAll("[data-vopt]").forEach((b) => b.addEventListener("click", () => castVote(b.dataset.vopt)));
}
function renderVoteTab(vote, chosenId) {
  const panel = document.querySelector('[data-panel="vote"]'); if (!panel || !roomState) return;
  const round = currentSession.rounds[roomState.roundIdx] || {};
  const kp = (round.keyPoints || []).map((k) => `<li>${esc(k)}</li>`).join("");
  const result = chosenId ? `<div class="vr-vote-result">${esc(t("m_voted", { label: ((vote.options || []).find((o) => o.id === chosenId) || {}).label || chosenId }))}</div>` : "";
  panel.innerHTML = `<div class="vr-vote-kicker">— R${roomState.roundNumber()} · ${esc(chosenId ? t("m_vote_result") : t("m_vote_open"))}</div>
    ${kp ? `<ul class="vr-vote-kp">${kp}</ul>` : ""}
    <div class="vr-vote"><p>${esc(vote.question)}</p>${result}</div>`;
}
function castVote(optId) {
  if (!roomState || roomState.phase !== PHASE.VOTING) return;
  const round = currentSession.rounds[roomState.roundIdx];
  roomState.recordVote(optId);
  document.body.classList.remove("is-voting");
  renderVoteTab(round.vote, optId);
  const opt = (round.vote.options || []).find((o) => o.id === optId) || {};
  const advance = !roomState.isLastRound() && !!opt.advance;
  if (advance) {
    roomState.advanceRound();   // bump to the next round BEFORE the driver reloads
    toast(t("m_toast_continuing"));
    if (driver) driver.nextRound();
  } else {
    adjournWithReport(optId);
  }
}

/* Filed when the meeting ends · the full report renderer is task 5. */
function buildReportData(voteId) {
  const rec = currentSession && currentSession.recommendationByVote ? (currentSession.recommendationByVote[voteId] || "") : "";
  return {
    subject: currentRoom ? currentRoom.subject : "",
    tone: roomMode,
    voteId, recommendation: rec,
    keyPoints: collectKeyPoints(),
    transcript: recordedTranscript.slice(),
  };
}
function collectKeyPoints() {
  if (!currentSession) return [];
  const out = [];
  const upto = roomState ? roomState.roundIdx : 0;
  for (let i = 0; i <= upto; i++) { const r = currentSession.rounds[i]; if (r) out.push(...(r.keyPoints || [])); }
  return out;
}
function adjournWithReport(voteId) {
  ensureSession();
  roomState.toAdjourned();
  roomStatus = "adjourned";
  if (currentRoom) currentRoom.status = "adjourned";
  if (driver) driver.stop();
  document.body.classList.remove("is-voting", "is-composing");
  document.body.classList.add("is-adjourned");
  paintStage(null, null); captionHide(); setStatusPill(); setRoundChip();   // top-bar chip flips R# → Replay
  { const s = sfx(); if (s) s.gavel(); }                // gavel on adjourn
  closeModal();
  lastReport = buildReportData(voteId);
  reportStep = "pick"; reportMode = "report";       // fresh brief picker on View report
  if (currentRoom) ARCHIVES[currentRoom.id] = { transcript: recordedTranscript.slice(), report: lastReport };
  persistState();                                   // survive reload (status + archive)
  toast(t("m_toast_adjourned"));
}

/* ════════════════════════════════════════════════════════════════
   Room state · mutable for the prototype (cast / tone / status).
   ════════════════════════════════════════════════════════════════ */
let MV = null;
let CHAIR = null;            // set by applyAgents() from GET /api/agents
let ROSTER = [];             // [{...director, active}]  · set by applyAgents()
let MEMBERS = [];
let POSITIONS = [];
let roomMode = "constructive";
let roomIntensity = "sharp";
let roomStatus = "live";
let roomDelivery = "voice";   // "voice" (3D stage) | "text" (chat)
const USER_MEMBER = { id: "__user", name: "You", __isUser: true, avatar3d: { model: "casual" } };
let pendingUserBubble = null; // {text, progress} shown over the user's seat (voice)
/* Localised 3D-overlay status labels (recomputed per paint so a locale
   switch mid-session takes effect). */
const labelMap = () => ({ thinking: t("m_lbl_thinking"), speaking: t("m_lbl_speaking") });
/* Web-Audio SFX accessor · null until /typing-sfx.js loads (self-gates
   on its own enabled flag + first user gesture). */
const sfx = () => (typeof window !== "undefined" && window.boardroomTypingSfx) || null;
let lastSpeakerId = null, lastSpeakerState = null;

const SV = (p, fill) => `<svg viewBox="0 0 24 24" fill="${fill ? "currentColor" : "none"}" stroke="${fill ? "none" : "currentColor"}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const TONES = [
  { id: "brainstorm",   name: "Brainstorm",   note: "Warm, generative — diverge first, prune later.", icon: SV('<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.1 14c.2-1 .6-1.7 1.4-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.8.8 1.2 1.5 1.4 2.5"/>') },
  { id: "constructive", name: "Constructive", note: "Default — build on each other's points.",       icon: SV('<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>') },
  { id: "research",     name: "Research",     note: "Evidence-led; cite as you go.",                  icon: SV('<path d="M9 3h6"/><path d="M10 3v6L5 19a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 19l-5-10V3"/><path d="M7.5 14h9"/>') },
  { id: "debate",       name: "Debate",       note: "Adversarial — argue both sides hard.",           icon: SV('<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>') },
  { id: "critique",     name: "Critique",     note: "Stress-test the proposal for failure.",          icon: SV('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>') },
];
const INTENSITIES = [
  { id: "calm",  name: "Calm",  note: "Measured and patient.", icon: SV('<path d="M3 12c3-5 6-5 9 0s6 5 9 0"/>') },
  { id: "sharp", name: "Sharp", note: "Direct, no filler.",    icon: SV('<path d="M13 2 4 13h6l-1 9 9-12h-6l1-8z"/>', true) },
  { id: "terse", name: "Terse", note: "Blunt and minimal.",    icon: SV('<path d="M4 7h16M4 12h11M4 17h6"/>') },
];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const inRoomCount = () => ROSTER.filter((r) => r.active).length;
/* Localised tone / intensity names + notes (TONES/INTENSITIES keep only id + icon). */
const toneName = (id) => t("m_tone_" + id);
const toneNote = (id) => t("m_tone_" + id + "_note");
const intName = (id) => t("m_int_" + id);
const intNote = (id) => t("m_int_" + id + "_note");

/* Set the static HTML chrome (labels / placeholders / aria) for the
   current locale · called at boot and on every locale change. */
function applyStaticChrome() {
  const setText = (sel, key) => { const e = $(sel); if (e) e.textContent = t(key); };
  const setAria = (sel, key) => { const e = $(sel); if (e) e.setAttribute("aria-label", t(key)); };
  // Home dock tabs (icon is prepended separately; the <span> holds the label)
  const roomsTab = document.querySelector('[data-htab="rooms"] span'); if (roomsTab) roomsTab.textContent = t("m_home_rooms");
  const dirTab = document.querySelector('[data-htab="directors"] span'); if (dirTab) dirTab.textContent = t("m_home_directors");
  setHomeTitle();   // header title follows the active tab + locale
  setAria('[data-act="prefs"]', "m_home_settings_aria");
  setAria('[data-act="new"]', "m_home_create_aria");
  setAria('[data-act="back"]', "m_room_back_aria");
  setAria('[data-act="menu"]', "m_room_menu_aria");
  setAria(".vr-live", "m_rc_live");
  setAria("[data-composer-send]", "m_composer_send_aria");
  setAria("[data-composer-cancel]", "m_composer_cancel_aria");
  setAria('[data-act="interject"]', "m_dock_interject_aria");
  setAria('[data-act="playpause"]', "m_dock_playpause_aria");
  setAria('[data-act="rate"]', "m_dock_rate_aria");
  setAria("[data-adj-report]", "m_adj_view_report");   // icon button now
  setAria("[data-adj-followup]", "m_adj_followup");
  const ci = $("[data-composer-input]"); if (ci && !document.body.classList.contains("is-composing")) ci.placeholder = t("m_composer_ph");
}

function activeMembers() { return [CHAIR, ...ROSTER.filter((r) => r.active), USER_MEMBER]; }
function paintStage(speakerId, speakerState) {
  lastSpeakerId = speakerId; lastSpeakerState = speakerState;
  if (MV) MV.update({ mode: roomMode, positions: POSITIONS, speakerId, speakerState, userWait: false, labels: labelMap(), votePop: "", userBubble: pendingUserBubble });
}
function repaintStage() { paintStage(lastSpeakerId, lastSpeakerState); }
function rebuildCast() {
  MEMBERS = activeMembers();
  POSITIONS = computeSeatPositions(MEMBERS);
  buildRail();
  repaintStage();
}
function setTone(id) {
  roomMode = id;
  if (currentRoom) currentRoom.tone = id;
  const st = $("[data-mobile-stage]");
  if (st) st.setAttribute("data-floor", id);
  repaintStage(); // re-render floor + wall/chair palette for the new tone
}

/* ════ Status · live ↔ adjourned ════ */
function setStatusPill() {
  const pill = $(".vr-live");
  if (!pill) return;
  const adjourned = roomStatus === "adjourned";
  const paused = roomStatus === "paused";
  // pillHint ("pausing" / "resuming") is a transient in-flight state · it
  // reads as the amber pending tone with a pulsing dot so a pause/resume tap
  // gives feedback the moment it's pressed, before the SSE state lands.
  pill.classList.toggle("is-done", adjourned);
  pill.classList.toggle("is-paused", (paused && !pillHint) || pillHint === "pausing");
  pill.classList.toggle("is-pending", !!pillHint);
  // live → blinking red dot + LIVE · paused → PAUSED · pending → PAUSING/RESUMING
  // (amber dot) · adjourned → hidden (CSS).
  if (adjourned) { pill.innerHTML = ""; pill.setAttribute("aria-label", "Adjourned"); return; }
  if (pillHint) {
    const label = pillHint === "pausing" ? t("m_status_pausing") : t("m_status_resuming");
    pill.innerHTML = `<span class="vr-live-dot"></span><span class="vr-live-tx">${esc(label)}</span>`;
    pill.setAttribute("aria-label", label); return;
  }
  pill.innerHTML = paused ? `<span class="vr-live-tx">${esc(t("m_status_paused"))}</span>`
    : `<span class="vr-live-dot"></span><span class="vr-live-tx">${esc(t("m_status_live"))}</span>`;
  pill.setAttribute("aria-label", paused ? "Paused" : "Live");
}
/* Manual adjourn from the room menu · ends without a final vote. */
function adjournRoom() {
  if (roomStatus === "adjourned") return;
  doAdjourn();
}
/* Replay · re-plays an adjourned room. Voice rooms play the directors'
   REAL recorded voices — persisted MP3 first (the live stream was saved
   server-side · zero re-synth cost), synth-on-demand fallback — with seat
   focus + caption on the 3D stage; text rooms re-show the chat silently.
   Stays adjourned (playback, not a fresh run). Tap replay again to stop. */
let replayTimer = 0;
let replayEpoch = 0;          // bumped on every start/stop · gates async fetches + timers
let replayAudio = null;       // current HTMLAudioElement
let replayList = null;        // [{id,speakerId,name,text,voiced}]
let replayIdx = 0;
const replayClips = new Map();   // messageId → Promise<objectURL | null>
function replayRevoke(url) { if (url) { try { URL.revokeObjectURL(url); } catch (_) { /* */ } } }
function stopReplay() {
  replayEpoch++;
  if (replayTimer) { clearTimeout(replayTimer); replayTimer = 0; }
  if (replayAudio) { try { replayAudio.pause(); replayAudio.removeAttribute("src"); replayAudio.load(); } catch (_) { /* */ } replayAudio = null; }
  for (const p of replayClips.values()) { Promise.resolve(p).then(replayRevoke).catch(() => { /* */ }); }
  replayClips.clear(); replayList = null; replayIdx = 0;
  if (document.body.classList.contains("is-replay")) {
    document.body.classList.remove("is-replay");
    if (!roomIsText()) { captionHide(); paintStage(null, null); if (MV) MV.focusSeat(null); }
  }
  if (roomStatus === "adjourned") setRoundChip();
}
/* Fetch a message's MP3 → object URL. Persisted clip first; on miss,
   synthesize on demand (cached server-side). Memoised so the prefetch of
   beat N+1 and the playback of beat N share a single fetch. */
function replayClip(messageId) {
  if (!messageId) return Promise.resolve(null);
  if (replayClips.has(messageId)) return replayClips.get(messageId);
  const p = (async () => {
    try {
      const r = await fetch("/api/voices/message/" + encodeURIComponent(messageId) + "/audio");
      if (r.ok) { const buf = await r.arrayBuffer(); if (buf && buf.byteLength) return URL.createObjectURL(new Blob([buf], { type: r.headers.get("Content-Type") || "audio/mpeg" })); }
    } catch (_) { /* persisted miss → synth */ }
    try {
      const r = await fetch("/api/voices/by-message/" + encodeURIComponent(messageId), { method: "POST" });
      if (r.ok) { const j = await r.json(); if (j && j.audioBase64) { const bin = atob(j.audioBase64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return URL.createObjectURL(new Blob([bytes], { type: j.mimeType || "audio/mpeg" })); } }
    } catch (_) { /* */ }
    return null;
  })();
  replayClips.set(messageId, p);
  return p;
}
function replayBeatMs(text) { return Math.max(1500, Math.min(5200, (text || "").length * 36)); }
async function replayRoom() {
  if (document.body.classList.contains("is-replay")) { stopReplay(); return; }   // toggle off
  stopReplay();
  const epoch = ++replayEpoch;
  // Authoritative ordered messages (with ids → fetchable audio) from the
  // snapshot; fall back to the in-memory transcript (silent · no ids).
  let list = [];
  try {
    const snap = currentRoom ? await api.getRoom(currentRoom.id) : null;
    if (epoch !== replayEpoch) return;
    for (const msg of ((snap && snap.messages) || [])) {
      const body = String(msg.body || "").trim(); if (!body) continue;
      if (msg.authorKind === "system") continue;
      const isUser = msg.authorKind === "user";
      const who = isUser ? { name: "You" } : (byId(msg.authorId) || { name: msg.authorId || "—" });
      list.push({ id: msg.id, speakerId: isUser ? "__user" : msg.authorId, name: who.name, text: body, voiced: !isUser, round: typeof msg.roundNum === "number" ? msg.roundNum : 1 });
    }
  } catch (_) { if (epoch !== replayEpoch) return; }
  if (!list.length) list = recordedTranscript.map((ln) => ({ id: null, speakerId: ln.speakerId, name: ln.name, text: ln.text, voiced: ln.speakerId !== "__user", round: ln.round || 1 }));
  if (!list.length) { toast(t("m_replay_empty")); return; }
  replayList = list; replayIdx = 0;
  document.body.classList.add("is-replay");
  setRoundChip();   // top-bar toggle flips to "Exit Replay"
  const isText = roomDelivery === "text";
  const host = isText ? $("[data-chat]") : $("[data-transcript]"); if (host) host.innerHTML = "";
  replayStep(epoch);
}
function replayStep(epoch) {
  if (epoch !== replayEpoch || !replayList) return;
  if (replayIdx >= replayList.length) { stopReplay(); return; }
  const ln = replayList[replayIdx];
  const m = byId(ln.speakerId) || { name: ln.name };
  const advance = () => { if (epoch !== replayEpoch) return; replayIdx++; replayStep(epoch); };
  // Text rooms · silent re-show of the chat thread.
  if (roomDelivery === "text") {
    if (ln.speakerId === "__user") appendChatUser(ln.text);
    else { const w = $("[data-chat]"); if (w) { const row = document.createElement("div"); row.className = "vr-msg vr-msg-them"; row.innerHTML = `${avatarThumb(m, 30)}<div class="vr-msg-body"><div class="vr-msg-who">${esc(m.name)}</div><div class="vr-msg-text">${esc(ln.text)}</div></div>`; w.appendChild(row); chatScroll(); } }
    replayTimer = setTimeout(advance, replayBeatMs(ln.text));
    return;
  }
  // User turn · brief silent wide-shot beat (no TTS audio for the user).
  if (ln.speakerId === "__user") {
    paintStage(null, null); if (MV) MV.focusSeat(null);
    captionSpeak(ln.name); captionFollowTimed(ln.text, replayBeatMs(ln.text)); appendTranscript({ name: "You" }, ln.text);
    replayTimer = setTimeout(advance, replayBeatMs(ln.text));
    return;
  }
  // Director / chair · "thinking" while the clip loads, then speak WITH audio.
  paintStage(ln.speakerId, "thinking"); if (MV) MV.focusSeat(ln.speakerId); setRailActive(ln.speakerId); captionThinking(ln.name);
  const nxt = replayList[replayIdx + 1]; if (nxt && nxt.voiced && nxt.id) replayClip(nxt.id);   // prefetch N+1
  const speak = () => { if (epoch !== replayEpoch) return; paintStage(ln.speakerId, "speaking"); captionSpeak(ln.name); appendTranscript(m, ln.text); };
  if (!ln.id) { speak(); captionFollowTimed(ln.text, replayBeatMs(ln.text)); replayTimer = setTimeout(advance, replayBeatMs(ln.text)); return; }
  replayClip(ln.id).then((url) => {
    if (epoch !== replayEpoch) { replayRevoke(url); return; }
    speak();
    if (!url) { captionFollowTimed(ln.text, replayBeatMs(ln.text)); replayTimer = setTimeout(advance, replayBeatMs(ln.text)); return; }   // no audio → timed beat
    const audio = new Audio(); replayAudio = audio; audio.src = url;
    try { audio.playbackRate = playRate || 1; } catch (_) { /* */ }
    const cleanup = () => { replayRevoke(url); replayClips.delete(ln.id); if (replayAudio === audio) replayAudio = null; };
    audio.addEventListener("ended", () => { cleanup(); advance(); }, { once: true });
    audio.addEventListener("error", () => { cleanup(); if (epoch === replayEpoch) { captionFollowTimed(ln.text, replayBeatMs(ln.text)); replayTimer = setTimeout(advance, replayBeatMs(ln.text)); } }, { once: true });
    const pr = audio.play();
    if (pr && pr.catch) pr.catch(() => { cleanup(); if (epoch === replayEpoch) { captionFollowTimed(ln.text, replayBeatMs(ln.text)); replayTimer = setTimeout(advance, replayBeatMs(ln.text)); } });   // autoplay blocked → timed
    captionFollowAudio(ln.text, audio);   // karaoke · reveal synced to the clip
  });
}

/* ════════════════════════════════════════════════════════════════
   Modal · Room menu → Settings / Manage cast / Report (+ Adjourn).
   ════════════════════════════════════════════════════════════════ */
let modalStack = [];
let _lastModalView = null;
function openModal(view) { modalStack = [view]; $("[data-modal]").hidden = false; document.body.classList.add("is-modal"); if (!_routing) { try { history.pushState(null, "", location.hash || "#/"); } catch (_) { /* */ } } renderModal(); }
function pushModal(view) { modalStack.push(view); renderModal(); }
function popModal() { modalStack.pop(); if (!modalStack.length) closeModal(); else renderModal(); }
function closeModal() {
  if (genTimer) { clearInterval(genTimer); genTimer = null; }
  stopPersonaES();   // drop any live persona-build stream
  // A generation interrupted by closing rolls back to the describe step
  // so reopening doesn't land on a frozen progress screen.
  if (agentDraft && agentDraft.step === "generating") agentDraft.step = "describe";
  modalStack = []; _lastModalView = null; const card = $("[data-modal-card]"); if (card) card.classList.remove("is-expanded"); const m = $("[data-modal]"); if (m) m.hidden = true; document.body.classList.remove("is-modal");
}
function renderModal() {
  const view = modalStack[modalStack.length - 1];
  const r = (VIEWS[view] || (() => ({ title: "", html: "" })))();
  $("[data-modal-title]").textContent = r.title;
  $("[data-modal-back]").hidden = modalStack.length <= 1;
  const body = $("[data-modal-body]");
  const sameView = view === _lastModalView;
  const keepScroll = sameView ? body.scrollTop : 0; // preserve on in-place re-render
  body.innerHTML = r.html;
  if (r.mount) r.mount(body);
  body.scrollTop = keepScroll;
  // Fresh page lands at the top → collapse to the 80% sheet; an in-place
  // re-render keeps whatever expand state the scroll latched. EXCEPT the
  // full-fidelity report view: its content is an <iframe> that owns its own
  // scroll, so the body's scroll-to-expand latch never fires — force the sheet
  // to fullscreen on open so the report fills the screen like every other view
  // ends up doing once you scroll it.
  if (view === "reportview") { const card = $("[data-modal-card]"); if (card) card.classList.add("is-expanded"); }
  else if (sameView) syncModalExpand();
  else { const card = $("[data-modal-card]"); if (card) card.classList.remove("is-expanded"); }
  _lastModalView = view;
}
/* Bottom-sheet scroll-to-expand · once the modal body scrolls off its top the
   card grows to fill the screen; back at the top it collapses to the 80% sheet. */
function syncModalExpand() {
  // Latch · once the body scrolls off its top the sheet grows to fullscreen and
  // STAYS there. Never collapse on scroll: content that overflows at 80% but
  // fits at 100% gets its scrollTop clamped back to 0 on expand, and a toggle
  // would oscillate (the in-place flicker). Collapse only on a new page / close.
  const card = $("[data-modal-card]"); const body = $("[data-modal-body]");
  if (card && body && body.scrollTop > 4) card.classList.add("is-expanded");
}

function renderMenu() {
  const rows = [
    { go: "settings", icon: ICON.gear, label: t("m_menu_settings"), sub: t("m_menu_settings_sub", { tone: toneName(roomMode), intensity: intName(roomIntensity) }) },
    { go: "cast",     icon: ICON.cast, label: t("m_menu_cast"),     sub: t("m_menu_cast_sub", { n: inRoomCount() }) },
  ];
  // Pause / Resume · available in both text + voice rooms (the voice dock's
  // play/pause is hidden in text rooms, so the menu is the universal control).
  const pauseRow = roomStatus !== "adjourned"
    ? `<button class="vr-act-row" data-go="pause">${roomPaused ? ICON.play : ICON.pause}<span class="vr-act-label">${esc(roomPaused ? t("m_menu_resume") : t("m_menu_pause"))}<em>${esc(roomPaused ? t("m_menu_resume_sub") : t("m_menu_pause_sub"))}</em></span></button>`
    : "";
  const html = `<div class="vr-menu">
    ${rows.map((r) => `<button class="vr-act-row" data-go="${r.go}">${r.icon}<span class="vr-act-label">${esc(r.label)}<em>${esc(r.sub)}</em></span><span class="vr-act-chev">${ICON.chev}</span></button>`).join("")}
    ${pauseRow}
    ${roomStatus === "adjourned"
      ? `<button class="vr-act-row" data-go="genreport">${ICON.doc}<span class="vr-act-label">${esc(t("m_menu_genreport"))}<em>${esc(t("m_menu_genreport_sub"))}</em></span><span class="vr-act-chev">${ICON.chev}</span></button>`
      : `<button class="vr-act-row is-danger" data-go="adjourn">${ICON.adjourn}<span class="vr-act-label">${esc(t("m_menu_adjourn"))}<em>${esc(t("m_menu_adjourn_sub"))}</em></span><span class="vr-act-chev">${ICON.chev}</span></button>`}
    <button class="vr-act-row is-danger" data-go="delete">${ICON.trash}<span class="vr-act-label">${esc(t("m_menu_delete"))}<em>${esc(t("m_menu_delete_sub"))}</em></span></button>
  </div>`;
  return { title: t("m_menu_title"), html, mount(b) {
    b.querySelectorAll("[data-go]").forEach((btn) => btn.addEventListener("click", () => {
      const go = btn.dataset.go;
      if (go === "adjourn") openReportGen("adjourn");
      else if (go === "genreport") openReportGen("generate");
      else if (go === "delete") confirmDeleteRoom();
      else if (go === "pause") togglePauseRoom();
      else pushModal(go);
    }));
  } };
}
/* Toggle room pause · soft-pause stops the orchestrator after the current
   turn; resume re-arms it. Works in text + voice. The SSE room-paused /
   room-resumed config-events also keep the pill + dock icon in sync. */
async function togglePauseRoom() {
  if (!currentRoom || roomStatus === "adjourned" || pausePending) return;
  closeModal();
  // Same desktop-aligned soft-pause / resume flow as the dock button.
  if (roomPaused) await doResume();
  else await doSoftPause();
}
/* Delete the room · native confirm (the menu modal sits above the ask
   sheet, so use the system dialog), then DELETE /api/rooms/:id + drop it. */
function confirmDeleteRoom() {
  if (!currentRoom) return;
  const ok = window.confirm(t("m_delete_confirm", { subject: (currentRoom.subject || "").slice(0, 40) }));
  if (ok) doDeleteRoom();
}
async function doDeleteRoom() {
  const room = currentRoom; if (!room) return;
  try { await api.deleteRoom(room.id); }
  catch (e) { toast((e && e.message) || t("m_room_load_fail")); return; }
  ROOMS = ROOMS.filter((r) => r.id !== room.id);
  delete roomDirectorCache[room.id];
  closeModal();
  exitRoom();             // back to home (re-renders the list without this room)
  toast(t("m_toast_deleted"));
}

function renderSettings() {
  const tiles = (arr, kind, cur) => arr.map((o) =>
    `<button class="vr-tile${o.id === cur ? " is-checked" : ""}" data-opt="${kind}:${o.id}">${o.icon}<span>${esc(kind === "tone" ? toneName(o.id) : intName(o.id))}</span></button>`).join("");
  const html = `
    <div class="vr-set-group">
      <h4>${esc(t("m_set_tone"))}</h4>
      <div class="vr-tile-grid">${tiles(TONES, "tone", roomMode)}</div>
      <p class="vr-set-hint">${esc(toneNote(roomMode))}</p>
    </div>
    <div class="vr-set-group">
      <h4>${esc(t("m_set_intensity"))}</h4>
      <div class="vr-tile-grid">${tiles(INTENSITIES, "intensity", roomIntensity)}</div>
      <p class="vr-set-hint">${esc(intNote(roomIntensity))}</p>
    </div>`;
  return { title: t("m_menu_settings"), html, mount(b) {
    b.querySelectorAll("[data-opt]").forEach((btn) => btn.addEventListener("click", () => {
      const [kind, id] = btn.dataset.opt.split(":");
      if (kind === "tone") { setTone(id); }
      else { roomIntensity = id; if (currentRoom) currentRoom.intensity = id; }
      // Persist so the change survives a reload (the room list reloads from
      // the backend on refresh; without this the tone/intensity reverted).
      if (currentRoom) api.patchRoom(currentRoom.id, kind === "tone" ? { mode: id } : { intensity: id }).catch(() => { /* best-effort */ });
      renderModal();
    }));
  } };
}

function renderCast() {
  const inRoom = ROSTER.filter((r) => r.active);
  const avail = ROSTER.filter((r) => !r.active);
  const row = (r, active) => `<div class="vr-cast-row"><img src="${r.avatarPath}" alt="" draggable="false"><span class="vr-cast-name">${esc(r.name)}</span><button class="vr-cast-btn${active ? " is-remove" : ""}" data-toggle="${r.id}" aria-label="${active ? esc(t("m_cast_remove_aria")) : esc(t("m_cast_add_aria"))}">${active ? ICON.minus : ICON.plus}</button></div>`;
  const html = `
    <div class="vr-cast-group"><h4>${esc(t("m_cast_in"))} · ${inRoom.length}</h4><div class="vr-set-list">${inRoom.map((r) => row(r, true)).join("")}</div></div>
    ${avail.length ? `<div class="vr-cast-group"><h4>${esc(t("m_cast_available"))}</h4><div class="vr-set-list">${avail.map((r) => row(r, false)).join("")}</div></div>` : ""}`;
  return { title: t("m_cast_title"), html, mount(b) {
    b.querySelectorAll("[data-toggle]").forEach((btn) => btn.addEventListener("click", () => {
      const r = ROSTER.find((x) => x.id === btn.dataset.toggle);
      if (!r) return;
      if (r.active && inRoomCount() <= 2) { toast(t("m_toast_min_two")); return; }
      r.active = !r.active;
      const agentIds = ROSTER.filter((x) => x.active).map((x) => x.id);
      if (currentRoom) {
        currentRoom.directorIds = agentIds;
        // Persist the cast change · the room list reloads from the backend on
        // refresh, so without this the added/removed director reverted.
        api.patchMembers(currentRoom.id, agentIds).catch((e) => toast((e && e.message) || t("m_send_fail")));
      }
      rebuildCast();   // live: stage seats + cast rail update immediately
      renderModal();
    }));
  } };
}

/* ── Report · pick brief mode → generation animation → rendered brief
   synthesised from this session's transcript / positions / vote ────── */
const BRIEF_MODES = [
  { id: "report", label: "Report", deck: "Long-form brief" },
  { id: "bento", label: "Bento", deck: "Grid of cards" },
  { id: "magazine", label: "Magazine", deck: "Editorial spread" },
  { id: "newspaper", label: "Newspaper", deck: "Broadsheet columns" },
];
const OUTCOME_IDS = new Set(["explore", "commit", "yes", "no", "revisit"]);
const voteOutcome = (voteId) => t("m_out_" + (OUTCOME_IDS.has(voteId) ? voteId : "adjourned"));
let reportStep = "pick";   // pick | gen | done  (offline · retired)
let reportMode = "report";
let reportViewUrl = null;  // spine URL for the full-fidelity iframe report view
// ── Real brief state · fetched from the backend (generated server-side on adjourn). ──
let reportBrief = null; let reportLoading = false; let reportErr = null; let reportPollTimer = 0; let reportTriedRoomId = null;
// Live generation pipeline · the server runs a multi-stage brief pipeline and
// exposes its progress at /api/briefs/:id/status (see desktop checkBriefHealth).
// reportGenStages mirrors `state.stages` (key → { status, detail, progress });
// reportGenStartedAt anchors the elapsed-time readout. Both reset per open.
let reportGenStages = null; let reportGenStartedAt = 0;
const briefModeLabel = (id) => t("m_rep_mode_" + ((BRIEF_MODES.find((b) => b.id === id) || BRIEF_MODES[0]).id));
const briefModeDeck = (id) => t("m_rep_deck_" + ((BRIEF_MODES.find((b) => b.id === id) || BRIEF_MODES[0]).id));

function reportData() {
  const r = lastReport || buildReportData(null);
  const byDir = new Map();
  for (const t of (r.transcript || [])) {
    if (t.speakerId === "chair" || t.speakerId === "__user") continue;
    if (!byDir.has(t.speakerId)) byDir.set(t.speakerId, []);
    byDir.get(t.speakerId).push(t.text);
  }
  const positions = [...byDir.entries()].map(([id, lines]) => ({ name: (byId(id) || {}).name || id, line: lines[lines.length - 1] }));
  return {
    subject: r.subject || (currentRoom ? currentRoom.subject : t("m_rep_brief")),
    recommendation: r.recommendation || "The board did not reach a firm recommendation this session.",
    keyPoints: r.keyPoints || [],
    positions,
    outcome: voteOutcome(r.voteId),
    directors: ROSTER.filter((x) => x.active).map((x) => x.name).join(" · "),
  };
}

/* Open the report · reset state + fetch the room's latest brief. */
/* ── Report generation config · the "Adjourn & file report" (live) and
   "Generate report" (adjourned) page. Mirrors the desktop adjourn overlay
   (openAdjournOverlay · adjourn vs generate-brief): pick a format, pick its
   style (spine + house-style for the report; template variant for magazine /
   newspaper / slides — strictly the desktop option set), optionally add
   guidance, then adjourn-and-file or POST a post-hoc brief. Guidance maps to
   the backend `supplement`; the style picks map to `renderPrefs`. ────────── */
const REPORT_FMTS = ["research-note", "magazine", "newspaper", "ppt"];
// Structured-mode template variants · hardcoded to match the desktop overlay.
const REPORT_VARIANTS = { magazine: [["gq", "GQ"], ["vogue", "Vogue"]], newspaper: [["times", "Times"], ["post", "Post"]], ppt: [["keynote", "Keynote"], ["anthropic", "Anthropic"]] };
// research-note spine + house-style · fallback list (mirrors the server catalog
// + desktop RENDER_CATALOG_FALLBACK) used until /api/render-catalog lands.
const RENDER_CATALOG_FB = {
  spines: ["boardroom-dark", "a16z-thesis", "anthropic-essay", "gartner-note", "mckinsey-deck", "openai-paper"],
  houseStyles: [
    { id: "boardroom-default", label: "Boardroom (default)" },
    { id: "sequoia-memo", label: "Sequoia memo" },
    { id: "a16z-thesis", label: "a16z thesis" },
    { id: "anthropic", label: "Anthropic essay" },
    { id: "bcg-strategy", label: "BCG strategy memo" },
    { id: "first-round-essay", label: "First Round Review essay" },
    { id: "gartner-research", label: "Gartner research note" },
  ],
};
let renderCatalog = null;   // {spines, houseStyles} from GET /api/render-catalog (lazy)
let reportGenMode = "generate";   // "adjourn" (live → end + file) | "generate" (adjourned → post-hoc brief)
let reportGenFmt = "research-note";
let reportGenPrompt = "";
let reportStyle = { spine: "", house: "", magazine: "", newspaper: "", ppt: "" };   // "" = Auto
function openReportGen(mode) {
  reportGenMode = mode === "adjourn" ? "adjourn" : "generate";
  reportGenFmt = "research-note";
  reportGenPrompt = "";
  reportStyle = { spine: "", house: "", magazine: "", newspaper: "", ppt: "" };
  if (modalStack.length) pushModal("reportcfg"); else openModal("reportcfg");
}
async function ensureRenderCatalog() {
  if (renderCatalog) return;
  try {
    const c = await api.renderCatalog();
    renderCatalog = (c && (Array.isArray(c.spines) || Array.isArray(c.houseStyles)))
      ? { spines: c.spines || [], houseStyles: c.houseStyles || [] } : RENDER_CATALOG_FB;
  } catch (_) { renderCatalog = RENDER_CATALOG_FB; }
}
/* Style picker for the current format · spine + house-style chips for the
   report; a single variant row for magazine / newspaper / slides. */
function reportStylePicker() {
  const auto = t("m_repcfg_auto");
  const chip = (key, val, label, cur) => `<button type="button" class="vr-style-chip${val === cur ? " is-checked" : ""}" data-rstyle="${key}:${esc(val)}">${esc(label)}</button>`;
  if (reportGenFmt === "research-note") {
    const cat = renderCatalog || RENDER_CATALOG_FB;
    const spineChips = [chip("spine", "", auto, reportStyle.spine)].concat((cat.spines || []).map((s) => chip("spine", String(s), String(s), reportStyle.spine))).join("");
    const houseChips = [chip("house", "", auto, reportStyle.house)].concat((cat.houseStyles || []).map((h) => chip("house", String(h.id), String(h.label || h.id), reportStyle.house))).join("");
    return `<div class="vr-set-group"><h4>${esc(t("m_repcfg_spine"))}</h4><div class="vr-style-grid">${spineChips}</div></div>
      <div class="vr-set-group"><h4>${esc(t("m_repcfg_house"))}</h4><div class="vr-style-grid">${houseChips}</div></div>`;
  }
  const vs = REPORT_VARIANTS[reportGenFmt];
  if (!vs) return "";
  const chips = [chip(reportGenFmt, "", auto, reportStyle[reportGenFmt])].concat(vs.map(([v, l]) => chip(reportGenFmt, v, l, reportStyle[reportGenFmt]))).join("");
  return `<div class="vr-set-group"><h4>${esc(t("m_repcfg_look"))}</h4><div class="vr-style-grid">${chips}</div></div>`;
}
/* Map format + style picks to the backend renderPrefs shape · identical keys
   to the desktop collectRenderPrefs. Returns null when everything is Auto. */
function reportRenderPrefs() {
  const p = {};
  if (reportGenFmt === "research-note") {
    if (reportStyle.spine) p.reportSpine = reportStyle.spine;
    if (reportStyle.house) p.reportHouseStyle = reportStyle.house;
  } else if (reportGenFmt === "magazine") { if (reportStyle.magazine) p.magazineVariant = reportStyle.magazine; }
  else if (reportGenFmt === "newspaper") { if (reportStyle.newspaper) p.newspaperVariant = reportStyle.newspaper; }
  else if (reportGenFmt === "ppt") { if (reportStyle.ppt) p.pptVariant = reportStyle.ppt; }
  return Object.keys(p).length ? p : null;
}
function renderReportConfig() {
  const isGen = reportGenMode === "generate";
  const tiles = REPORT_FMTS.map((id) => `<button type="button" class="vr-tile${id === reportGenFmt ? " is-checked" : ""}" data-rfmt="${id}"><span>${esc(realModeLabel(id))}</span></button>`).join("");
  const html = `
    <div class="vr-set-group"><h4>${esc(t("m_rep_format"))}</h4><div class="vr-tile-grid">${tiles}</div></div>
    ${reportStylePicker()}
    <div class="vr-set-group"><h4>${esc(t("m_repcfg_prompt"))}</h4>
      <textarea class="vr-input vr-textarea tall" data-rprompt placeholder="${esc(t("m_repcfg_prompt_ph"))}">${esc(reportGenPrompt || "")}</textarea>
      <p class="vr-set-hint">${esc(t("m_repcfg_prompt_hint"))}</p></div>
    <button type="button" class="vr-convene" data-rgo>${esc(isGen ? t("m_repcfg_go_gen") : t("m_repcfg_go_file"))}</button>
    ${isGen ? "" : `<button type="button" class="vr-na-manual" data-rskip>${esc(t("m_repcfg_skip"))}</button>`}`;
  return { title: isGen ? t("m_menu_genreport") : t("m_rep_file_title"), html, mount(b) {
    // research-note · lazy-load the real spine / house-style catalog, then re-render.
    if (reportGenFmt === "research-note" && !renderCatalog) ensureRenderCatalog().then(() => { if (modalStack[modalStack.length - 1] === "reportcfg") renderModal(); });
    b.querySelectorAll("[data-rfmt]").forEach((btn) => btn.addEventListener("click", () => { reportGenFmt = btn.dataset.rfmt; renderModal(); }));
    b.querySelectorAll("[data-rstyle]").forEach((btn) => btn.addEventListener("click", () => { const i = btn.dataset.rstyle.indexOf(":"); reportStyle[btn.dataset.rstyle.slice(0, i)] = btn.dataset.rstyle.slice(i + 1); renderModal(); }));
    const pt = b.querySelector("[data-rprompt]"); if (pt) pt.addEventListener("input", (e) => { reportGenPrompt = e.target.value; });
    const go = b.querySelector("[data-rgo]"); if (go) go.addEventListener("click", () => submitReportGen(false));
    const sk = b.querySelector("[data-rskip]"); if (sk) sk.addEventListener("click", () => submitReportGen(true));
  } };
}
async function submitReportGen(skip) {
  if (!currentRoom) return;
  if (needsKey && !skip) { toast(t("m_gate_key_t")); return; }
  const id = currentRoom.id;
  const mode = reportGenFmt;
  const supplement = (reportGenPrompt || "").trim();
  const renderPrefs = reportRenderPrefs();
  const go = $("[data-rgo]");
  const goLabel = reportGenMode === "generate" ? t("m_repcfg_go_gen") : t("m_repcfg_go_file");
  if (go) { go.classList.add("is-dim"); go.textContent = t("m_repcfg_busy"); }
  try {
    if (reportGenMode === "generate") {
      const body = { mode }; if (supplement) body.supplement = supplement; if (renderPrefs) body.renderPrefs = renderPrefs;
      await api.generateBrief(id, body);
    } else {
      // Live · /adjourn can't carry a prompt, so when one is given we skip the
      // auto-brief and post-hoc it (with the same style) instead.
      { const s = sfx(); if (s) s.gavel(); }
      if (skip) await api.adjournRoom(id, { skipBrief: true });
      else if (!supplement) { const body = { mode }; if (renderPrefs) body.renderPrefs = renderPrefs; await api.adjournRoom(id, body); }
      else { await api.adjournRoom(id, { skipBrief: true }); const body = { mode, supplement }; if (renderPrefs) body.renderPrefs = renderPrefs; await api.generateBrief(id, body); }
      roomStatus = "adjourned"; currentRoom.status = "adjourned";
      document.body.classList.add("is-adjourned");
      document.body.classList.remove("is-voting", "is-composing");
      clearPendingTurn(); setStatusPill(); setRoundChip();
      maybeRenderTextEndCards();
    }
  } catch (e) {
    if (go) { go.classList.remove("is-dim"); go.textContent = goLabel; }
    toast((e && e.message) || t("m_room_load_fail"));
    return;
  }
  if (skip) { closeModal(); toast(t("m_toast_adjourned")); return; }
  openReportModal();   // resets the stack to the report view + polls the generating brief
}

/* ── Adjourned text-room end cards · mirrors the desktop session-analytics +
   brief card. When a text room ends we append two cards to the bottom of the
   chat: an ANALYSIS card (tokens / messages / rounds / duration + per-model
   split + user-contribution chips) and a REPORT card (the filed brief, with a
   View-report button — or a Generate-report CTA when none was filed). ─────── */
function fmtDur(ms) {
  if (!(ms > 0)) return "—";
  const min = Math.round(ms / 60000);
  if (min < 1) return "<1m";
  if (min < 60) return min + "m";
  const h = Math.floor(min / 60), mm = min % 60;
  return mm ? h + "h " + mm + "m" : h + "h";
}
/* Mirror of the desktop computeSessionStats · derives the headline numbers from
   the raw snapshot messages (which carry meta.tokens / meta.modelV). */
function computeSessionStats(messages, room) {
  let totalTokens = 0;
  const modelTokens = new Map();
  let roundCount = 0, messageCount = 0, secondCount = 0, probeCount = 0;
  const skip = new Set(["round-open", "round-prompt", "settings"]);
  for (const m of (messages || [])) {
    const meta = m.meta || {};
    const tk = meta.tokens;
    if (tk) {
      const tt = Number(tk.total) || 0;
      totalTokens += tt;
      const mv = meta.modelV;
      if (mv && tt > 0) modelTokens.set(mv, (modelTokens.get(mv) || 0) + tt);
    }
    const rn = (typeof m.roundNum === "number") ? m.roundNum : (typeof meta.roundNum === "number" ? meta.roundNum : 0);
    if (rn > roundCount) roundCount = rn;
    if (m.authorKind === "system") continue;
    if (meta.kind && skip.has(meta.kind)) continue;
    messageCount++;
    if (m.authorKind === "user") {
      const b = m.body || "";
      if (/^>\s/m.test(b)) { if (/(^|\n)\s*(Seconded\.|附议。)\s*$/.test(b)) secondCount++; else probeCount++; }
    }
  }
  const modelBreakdown = [...modelTokens.entries()]
    .map(([modelV, tokens]) => ({ modelV, tokens, pct: totalTokens > 0 ? tokens / totalTokens : 0 }))
    .sort((a, b) => b.tokens - a.tokens);
  const adj = (room && room.adjournedAt) || 0, cr = (room && room.createdAt) || 0;
  const durationMs = (adj && cr && adj > cr) ? adj - cr : 0;
  return { totalTokens, modelBreakdown, roundCount, messageCount, secondCount, probeCount, durationMs };
}
const END_PALETTE = ["#C9A46B", "#6A9B97", "#8E7CC3", "#C0795B", "#7C9A6A", "#B98AA0"];
function endAnalysisCardHtml(s) {
  const metric = (num, lab) => `<div class="vr-end-metric"><span class="vr-end-metric-num">${esc(num)}</span><span class="vr-end-metric-lab">${esc(lab)}</span></div>`;
  const metrics = [
    metric(fmtTokens(s.totalTokens), t("m_end_tokens")),
    metric(String(s.messageCount), t("m_end_messages")),
    metric(String(s.roundCount || 1), t("m_end_rounds")),
    metric(fmtDur(s.durationMs), t("m_end_duration")),
  ].join("");
  let bar = "", legend = "";
  if (s.modelBreakdown.length) {
    bar = `<div class="vr-use-bar vr-end-bar">${s.modelBreakdown.map((m, i) => `<span style="width:${(m.pct * 100).toFixed(2)}%;background:${END_PALETTE[i % END_PALETTE.length]}"></span>`).join("")}</div>`;
    legend = `<div class="vr-end-legend">${s.modelBreakdown.map((m, i) => `<span class="vr-end-leg"><i style="background:${END_PALETTE[i % END_PALETTE.length]}"></i>${esc(m.modelV)} · ${esc(fmtTokens(m.tokens))}</span>`).join("")}</div>`;
  }
  const chips = [];
  if (s.secondCount > 0) chips.push(`<span class="vr-end-chip">${s.secondCount} ${esc(t("m_end_seconded"))}</span>`);
  if (s.probeCount > 0) chips.push(`<span class="vr-end-chip">${s.probeCount} ${esc(t("m_end_probed"))}</span>`);
  const chipRow = chips.length ? `<div class="vr-end-chips">${chips.join("")}</div>` : "";
  return `<div class="vr-end-card vr-end-analysis">
    <div class="vr-end-kicker">${esc(t("m_end_analysis"))}</div>
    <div class="vr-end-metrics">${metrics}</div>
    ${bar}${legend}${chipRow}
  </div>`;
}
function endReportCardHtml(b) {
  let body;
  const ready = b && ((b.bodyMd && b.bodyMd.length) || b.bodyJson);
  if (ready) {
    const styleBadge = b.style ? `<span class="vr-rep-badge is-soft">${esc(b.style)}</span>` : "";
    body = `<div class="vr-rep-meta"><span class="vr-rep-badge">${esc(realModeLabel(b.mode))}</span>${styleBadge}</div>
      <h3 class="vr-end-report-title">${esc(b.title || (currentRoom ? currentRoom.subject : ""))}</h3>
      <button type="button" class="vr-rep-view-btn" data-end-view>${ICON.doc || ""}<span>${esc(t("m_rep_view_full"))}</span></button>`;
  } else if (b && b.isGenerating) {
    body = `<div class="vr-end-filing"><span class="vr-end-spin"></span>${esc(t("m_rep_generating"))}</div>`;
  } else {
    body = `<div class="vr-end-filing">${esc(t("m_end_no_report"))}</div>
      <button type="button" class="vr-rep-view-btn" data-end-gen>${ICON.doc || ""}<span>${esc(t("m_menu_genreport"))}</span></button>`;
  }
  return `<div class="vr-end-card vr-end-report"><div class="vr-end-kicker">${esc(t("m_rep_title"))}</div>${body}</div>`;
}
let _endCardsBusy = false;
/* Render (or refresh) the end cards at the bottom of the chat. Idempotent ·
   drops any existing cards first. No-op unless we are in an adjourned text room.
   `snap` (the room snapshot) is reused when the caller already has one. */
async function maybeRenderTextEndCards(snap) {
  const chat = $("[data-chat]");
  if (chat) chat.querySelectorAll(".vr-end-card").forEach((el) => el.remove());
  if (!currentRoom || !roomIsText() || roomStatus !== "adjourned") return;
  if (_endCardsBusy) return;
  _endCardsBusy = true;
  const roomId = currentRoom.id;
  try {
    let s = snap;
    if (!s || !s.messages) { try { s = await api.getRoom(roomId); } catch (_) { s = null; } }
    if (!currentRoom || currentRoom.id !== roomId || roomStatus !== "adjourned" || !roomIsText()) return;
    const stats = computeSessionStats((s && s.messages) || [], (s && s.room) || currentRoom);
    let brief = null;
    try {
      const r = await api.roomBriefs(roomId);
      const list = ((r && r.briefs) || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      brief = list[0] || null;
    } catch (_) { /* */ }
    if (!currentRoom || currentRoom.id !== roomId || roomStatus !== "adjourned" || !roomIsText()) return;
    const c2 = $("[data-chat]");
    if (!c2) return;
    c2.querySelectorAll(".vr-end-card").forEach((el) => el.remove());
    const wrap = document.createElement("div");
    wrap.innerHTML = endAnalysisCardHtml(stats) + endReportCardHtml(brief);
    while (wrap.firstChild) c2.appendChild(wrap.firstChild);
    const vb = c2.querySelector("[data-end-view]");
    if (vb) vb.addEventListener("click", () => { const u = briefSpineUrl(brief); if (u) openReportView(u); });
    const gb = c2.querySelector("[data-end-gen]");
    if (gb) gb.addEventListener("click", () => openReportGen("generate"));
    chatScroll();
    // Brief still cooking · refresh once it lands (brief-final SSE also re-fires this).
    const stillCooking = brief && (brief.isGenerating || !((brief.bodyMd && brief.bodyMd.length) || brief.bodyJson));
    if (stillCooking) setTimeout(() => { if (currentRoom && currentRoom.id === roomId && roomStatus === "adjourned" && roomIsText()) maybeRenderTextEndCards(); }, 2500);
  } finally { _endCardsBusy = false; }
}

function openReportModal() {
  reportBrief = null; reportErr = null; reportLoading = true; reportTriedRoomId = null;
  reportGenStages = null; reportGenStartedAt = 0;
  clearTimeout(reportPollTimer);
  openModal("report");
  loadReport();
}
async function loadReport() {
  if (!currentRoom) { reportLoading = false; renderModal(); return; }
  reportLoading = true; reportErr = null; reportTriedRoomId = currentRoom.id;
  try {
    const res = await api.roomBriefs(currentRoom.id);
    const list = ((res && res.briefs) || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    reportLoading = false;
    reportBrief = list[0] || null;
    renderModal();
    if (reportBrief) {
      const empty = !((reportBrief.bodyMd && reportBrief.bodyMd.length) || reportBrief.bodyJson);
      if (reportBrief.isGenerating || empty) pollReport(reportBrief.id);
    }
  } catch (e) { reportLoading = false; reportErr = (e && e.message) || t("m_rep_load_fail"); renderModal(); }
}
/* Poll a still-generating brief until its body lands (server fills it async).
   Drives off /api/briefs/:id/status — the same live stage snapshot the desktop
   uses — so reportGenView() can show the real pipeline stages (Reading what
   each director said → … → Writing the report) instead of a blank spinner.
   Falls back to the plain getBrief probe if the status endpoint is unavailable. */
function pollReport(briefId) {
  clearTimeout(reportPollTimer);
  if (!reportGenStartedAt) reportGenStartedAt = Date.now();
  const open = () => modalStack[modalStack.length - 1] === "report";
  let tries = 0;
  const tick = async () => {
    tries++;
    let st = null;
    try { st = await api.briefStatus(briefId); } catch (_) { /* */ }
    if (st && typeof st.generating === "boolean") {
      if (st.generating === false && st.hasBody) {
        // Done · pull the full body + flip into the finished brief view.
        let full = null;
        try { full = await api.getBrief(briefId); } catch (_) { /* */ }
        if (full) reportBrief = full;
        reportGenStages = null;
        if (open()) renderModal();
        return;
      }
      if (st.generating === false && !st.hasBody) {
        // Orphan · pipeline died without filing a body. Surface the error UI.
        reportErr = t("m_rep_load_fail"); reportGenStages = null;
        if (open()) renderModal();
        return;
      }
      // Still running · refresh the stage rail.
      reportGenStages = (st.state && st.state.stages) || reportGenStages;
      if (open()) renderModal();
    } else {
      // Status endpoint unavailable · fall back to the legacy getBrief probe.
      let full = null;
      try { full = await api.getBrief(briefId); } catch (_) { /* */ }
      const ready = full && !full.isGenerating && ((full.bodyMd && full.bodyMd.length) || full.bodyJson);
      if (ready) { reportBrief = full; reportGenStages = null; if (open()) renderModal(); return; }
    }
    if (tries < 60 && open()) reportPollTimer = setTimeout(tick, 2000);
  };
  reportPollTimer = setTimeout(tick, 2000);
}
function renderReport() {
  if (reportLoading) return reportStatusView(t("m_rep_loading"), false);
  if (reportErr) return reportStatusView(reportErr, true);
  if (!reportBrief) {
    // Opened without openReportModal (router restore) · lazy-load once per room.
    return { title: t("m_rep_title"), html: `<div class="vr-rep-status"><p>${esc(t("m_rep_none"))}</p></div>`,
      mount() { if (currentRoom && reportTriedRoomId !== currentRoom.id && !reportLoading) loadReport(); } };
  }
  const b = reportBrief;
  const ready = (b.bodyMd && b.bodyMd.length) || b.bodyJson;
  if (b.isGenerating && !ready) return reportGenView();
  return reportBriefView(b);
}
function renderReportDone() {
  const data = reportData();
  const tabs = BRIEF_MODES.map((b) => `<button type="button" class="vr-rep-tab${b.id === reportMode ? " is-active" : ""}" data-rmode="${b.id}">${esc(briefModeLabel(b.id))}</button>`).join("");
  const html = `<div class="vr-rep-tabs">${tabs}</div>${renderReportBody(reportMode, data)}`;
  return { title: t("m_rep_title"), html, mount(b) {
    b.querySelectorAll("[data-rmode]").forEach((btn) => btn.addEventListener("click", () => { reportMode = btn.dataset.rmode; renderModal(); }));
  } };
}
function renderReportPick() {
  const tiles = BRIEF_MODES.map((b) => `<button type="button" class="vr-tile${b.id === reportMode ? " is-checked" : ""}" data-bmode="${b.id}"><span>${esc(briefModeLabel(b.id))}</span></button>`).join("");
  const html = `<div class="vr-set-group"><h4>${esc(t("m_rep_format"))}</h4><div class="vr-tile-grid">${tiles}</div>
      <p class="vr-set-hint">${esc(briefModeDeck(reportMode))}</p></div>
    <button type="button" class="vr-convene" data-bgen>${esc(t("m_rep_file_btn", { label: briefModeLabel(reportMode) }))}</button>`;
  return { title: t("m_rep_file_title"), html, mount(b) {
    b.querySelectorAll("[data-bmode]").forEach((btn) => btn.addEventListener("click", () => { reportMode = btn.dataset.bmode; renderModal(); }));
    b.querySelector("[data-bgen]").addEventListener("click", () => { reportStep = "gen"; renderModal(); });
  } };
}
function renderReportGen() {
  const phases = ["Reading the transcript", "Extracting each position", "Synthesising key points", "Weighing the vote", "Composing the " + briefModeLabel(reportMode).toLowerCase()];
  const steps = phases.map((p, i) => `<li class="vr-gen-tl-step" data-gen-phase="${i}"><span class="vr-gen-tl-node" data-step-state="${i}"></span><div class="vr-gen-tl-body"><div class="vr-gen-tl-name">${esc(p)}</div></div></li>`).join("");
  const html = `<div class="vr-gen vr-gen-full">
      <div class="vr-gen-dial"><svg class="vr-gen-dial-svg" viewBox="0 0 120 120" aria-hidden="true"><circle class="vr-gen-dial-track" cx="60" cy="60" r="52"/><circle class="vr-gen-dial-fill" data-gen-dial cx="60" cy="60" r="52"/></svg><div class="vr-gen-dial-c"><span class="vr-gen-pct"><span data-gen-pct>0</span><i>%</i></span><span class="vr-gen-dial-sub" data-gen-phaseno>step 1 / ${phases.length}</span></div></div>
      <div class="vr-gen-elapsed"><span data-gen-elapsed>0.0s</span> · ${esc(t("m_rep_filing_sub"))}</div>
      <ol class="vr-gen-tl">${steps}</ol></div>`;
  return { title: t("m_rep_filing"), html, mount(b) {
    if (genTimer) { clearInterval(genTimer); genTimer = null; }
    const C = 326.7, total = 6500, n = phases.length, t0 = Date.now();
    const tick = () => {
      const el = Date.now() - t0;
      const pct = Math.min(100, Math.round((el / total) * 100));
      const idx = Math.min(n - 1, Math.floor((el / total) * n));
      const dial = b.querySelector("[data-gen-dial]"); if (dial) dial.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(1);
      const pe = b.querySelector("[data-gen-pct]"); if (pe) pe.textContent = pct;
      const ee = b.querySelector("[data-gen-elapsed]"); if (ee) ee.textContent = (el / 1000).toFixed(1) + "s";
      const pn = b.querySelector("[data-gen-phaseno]"); if (pn) pn.textContent = `step ${Math.min(n, idx + 1)} / ${n}`;
      b.querySelectorAll("[data-gen-phase]").forEach((li, i) => { const done = i < idx, active = i === idx; li.classList.toggle("is-done", done); li.classList.toggle("is-active", active); const node = li.querySelector(`[data-step-state="${i}"]`); if (node) node.innerHTML = done ? ICON.check : ""; });
      if (el >= total) { clearInterval(genTimer); genTimer = null; reportStep = "done"; renderModal(); }
    };
    genTimer = setInterval(tick, 120); tick();
  } };
}
/* Four distinct layouts off the same data (Report / Bento / Magazine /
   Newspaper). No border-left callouts — recommendation uses a top-rule
   card; no shadow animation. */
function renderReportBody(mode, d) {
  const kp = (d.keyPoints || []).map((k) => `<li>${esc(k)}</li>`).join("");
  const pos = (d.positions || []);
  const K = { q: esc(t("m_rep_question")), rec: esc(t("m_rep_recommendation")), out: esc(t("m_rep_outcome", { x: d.outcome })).replace(/ · .*$/, ""), kp: esc(t("m_rep_keypoints")), pos: esc(t("m_rep_positions")), brief: esc(t("m_rep_brief")) };
  const outFoot = esc(t("m_rep_outcome", { x: d.outcome }));
  if (mode === "bento") {
    const posCells = pos.map((p) => `<div class="vr-bento-cell"><div class="vr-rep-kicker">${esc(p.name)}</div><p>${esc(p.line)}</p></div>`).join("");
    return `<article class="vr-rep vr-rep-bento"><div class="vr-bento">
      <div class="vr-bento-cell vr-bento-q"><div class="vr-rep-kicker">${K.q}</div><h3>${esc(d.subject)}</h3></div>
      <div class="vr-bento-cell vr-bento-rec"><div class="vr-rep-kicker">${K.rec}</div><p>${esc(d.recommendation)}</p></div>
      <div class="vr-bento-cell vr-bento-out"><div class="vr-rep-kicker">${K.out}</div><div class="vr-bento-big">${esc(d.outcome)}</div></div>
      <div class="vr-bento-cell vr-bento-kp"><div class="vr-rep-kicker">${K.kp}</div><ul class="vr-rep-list">${kp}</ul></div>
      ${posCells}
    </div></article>`;
  }
  if (mode === "magazine") {
    const arts = pos.map((p) => `<div class="vr-mag-art"><div class="vr-mag-art-h">${esc(p.name)}</div><p>${esc(p.line)}</p></div>`).join("");
    const rec = esc(d.recommendation);
    return `<article class="vr-rep vr-rep-magazine">
      <div class="vr-rep-kicker">— ${esc(t("m_rep_mag_kicker"))}</div>
      <h3 class="vr-mag-h">${esc(d.subject)}</h3>
      <p class="vr-mag-lede"><span class="vr-mag-drop">${rec.charAt(0)}</span>${rec.slice(1)}</p>
      <div class="vr-mag-body">${arts}</div>
      <div class="vr-rep-card"><div class="vr-rep-card-k">${K.kp}</div><ul class="vr-rep-list">${kp}</ul></div>
      <div class="vr-rep-foot"><span>${outFoot}</span><span>${esc(d.directors)}</span></div>
    </article>`;
  }
  if (mode === "newspaper") {
    const body = pos.map((p) => `<p><b>${esc(p.name)}.</b> ${esc(p.line)}</p>`).join("")
      + (d.keyPoints || []).map((k) => `<p class="vr-news-kp">— ${esc(k)}</p>`).join("");
    return `<article class="vr-rep vr-rep-newspaper">
      <div class="vr-news-mast">THE BOARDROOM</div>
      <div class="vr-news-sub">${esc(t("m_rep_mast_sub", { x: d.outcome }))}</div>
      <h3 class="vr-news-h">${esc(d.subject)}</h3>
      <div class="vr-news-cols"><p class="vr-news-lede">${esc(d.recommendation)}</p>${body}</div>
      <div class="vr-rep-foot"><span>${esc(d.directors)}</span></div>
    </article>`;
  }
  // report · long-form (default)
  const posRows = pos.map((p) => `<div class="vr-rep-pos-row"><span class="vr-rep-pos-name">${esc(p.name)}</span><span class="vr-rep-pos-line">${esc(p.line)}</span></div>`).join("");
  return `<article class="vr-rep vr-rep-report">
    <div class="vr-rep-kicker">— ${K.brief}</div>
    <h3 class="vr-rep-h">${esc(d.subject)}</h3>
    <div class="vr-rep-card"><div class="vr-rep-card-k">${K.rec}</div><p>${esc(d.recommendation)}</p></div>
    <div class="vr-rep-kicker">${K.kp}</div>
    <ul class="vr-rep-list">${kp}</ul>
    <div class="vr-rep-kicker">${K.pos}</div>
    <div class="vr-rep-pos">${posRows}</div>
    <div class="vr-rep-foot"><span>${outFoot}</span><span>${esc(d.directors)}</span></div>
  </article>`;
}

/* ── Real-brief rendering helpers ──────────────────────────────────── */
function reportStatusView(msg, isErr) {
  return { title: t("m_rep_title"), html: `<div class="vr-rep-status${isErr ? " is-err" : ""}"><p>${esc(msg)}</p></div>` };
}
/* Live report-generation view · real-stage timeline (mirrors the desktop
   renderBriefStages pipeline) driven by reportGenStages from /briefs/:id/status.
   research-note runs 7 stages, structured modes (magazine/newspaper/ppt) run 2.
   Status per stage comes from the server when present, else is inferred from the
   active index. Progress % is the honest done-stage ratio (no faked timer). The
   shared brief_stage_* labels resolve through window.I18n. */
function reportGenView() {
  const b = reportBrief || {};
  const isStruct = b.mode === "magazine" || b.mode === "newspaper" || b.mode === "ppt";
  const order = isStruct
    ? ["extract", "write"]
    : ["extract", "compose", "scaffold-anchor", "scaffold-findings", "scaffold-cluster", "scaffold-actions", "write"];
  const stages = reportGenStages || {};
  const labelFor = (k) => (isStruct && k === "write")
    ? t(`brief_stage_${b.mode}_write_label`)
    : t(`brief_stage_${k.replace(/-/g, "_")}_label`);
  // Active index · first server-marked "active", else first pending, else last.
  let activeIdx = order.findIndex((k) => stages[k] && stages[k].status === "active");
  if (activeIdx < 0) activeIdx = order.findIndex((k) => !stages[k] || !stages[k].status || stages[k].status === "pending");
  if (activeIdx < 0) activeIdx = order.length - 1;
  const statusOf = (k, i) => {
    const s = stages[k] && stages[k].status;
    if (s === "done" || s === "active" || s === "pending") return s;
    return i < activeIdx ? "done" : i === activeIdx ? "active" : "pending";   // infer when the server hasn't said
  };
  const activeDetail = (k) => {
    const st = stages[k]; if (!st) return "";
    if (k === "extract" && st.progress && st.progress.total) return `${st.progress.current || 0} / ${st.progress.total}`;
    return st.detail || "";
  };
  const doneCount = order.reduce((n, k, i) => n + (statusOf(k, i) === "done" ? 1 : 0), 0);
  const hasActive = order.some((k, i) => statusOf(k, i) === "active");
  const pct = Math.min(99, Math.round(((doneCount + (hasActive ? 0.5 : 0)) / order.length) * 100));
  const C = 326.7;
  const steps = order.map((k, i) => {
    const st = statusOf(k, i);
    const cls = st === "done" ? " is-done" : st === "active" ? " is-active" : "";
    const det = st === "active" ? activeDetail(k) : "";
    const expand = det
      ? `<div class="vr-gen-tl-expand"><div class="vr-gen-tl-subs"><div class="vr-gen-tl-sub is-done">${esc(det)}</div></div></div>`
      : "";
    return `<li class="vr-gen-tl-step${cls}"><span class="vr-gen-tl-node">${st === "done" ? ICON.check : ""}</span><div class="vr-gen-tl-body"><div class="vr-gen-tl-name">${esc(labelFor(k))}</div>${expand}</div></li>`;
  }).join("");
  const phaseNo = t("m_rep_gen_step", { i: Math.min(order.length, activeIdx + 1), n: order.length });
  const html = `<div class="vr-gen vr-gen-full">
      <div class="vr-gen-dial"><svg class="vr-gen-dial-svg" viewBox="0 0 120 120" aria-hidden="true"><circle class="vr-gen-dial-track" cx="60" cy="60" r="52"/><circle class="vr-gen-dial-fill" cx="60" cy="60" r="52" style="stroke-dashoffset:${(C * (1 - pct / 100)).toFixed(1)}"/></svg><div class="vr-gen-dial-c"><span class="vr-gen-pct"><span>${pct}</span><i>%</i></span><span class="vr-gen-dial-sub">${esc(phaseNo)}</span></div></div>
      <div class="vr-gen-elapsed"><span data-gen-elapsed>0.0s</span> · ${esc(t("m_rep_filing_sub"))}</div>
      <ol class="vr-gen-tl">${steps}</ol></div>`;
  return { title: t("m_rep_filing"), html, mount(bd) {
    // Live elapsed readout · the body is recreated on every 2s poll re-render,
    // so (re)start the ticker here and let it self-stop when its node detaches.
    if (genTimer) { clearInterval(genTimer); genTimer = null; }
    const t0 = reportGenStartedAt || (reportGenStartedAt = Date.now());
    const ee = bd.querySelector("[data-gen-elapsed]");
    const tickEl = () => {
      if (!ee || !ee.isConnected) { if (genTimer) { clearInterval(genTimer); genTimer = null; } return; }
      ee.textContent = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    };
    tickEl(); genTimer = setInterval(tickEl, 100);
  } };
}
function realModeLabel(mode) {
  const k = ({ "research-note": "report", report: "report", bento: "bento", magazine: "magazine", newspaper: "newspaper", ppt: "deck" })[mode] || "report";
  return t("m_rep_mode_" + k);
}
/* Minimal, safe markdown → HTML · headings / bold / italic / code / lists /
   blockquote. Escapes first; no border-left treatments (project rule). */
function mdToHtml(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const inline = (s) => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  const out = []; let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { closeList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { closeList(); const lvl = Math.min(4, m[1].length); out.push(`<h${lvl} class="vr-md-h${lvl}">${inline(m[2])}</h${lvl}>`); continue; }
    if ((m = line.match(/^>\s?(.*)$/))) { closeList(); out.push(`<blockquote class="vr-md-quote">${inline(m[1])}</blockquote>`); continue; }
    if ((m = line.match(/^[-*]\s+(.*)$/))) { if (list !== "ul") { closeList(); list = "ul"; out.push(`<ul class="vr-md-ul">`); } out.push(`<li>${inline(m[1])}</li>`); continue; }
    if ((m = line.match(/^\d+\.\s+(.*)$/))) { if (list !== "ol") { closeList(); list = "ol"; out.push(`<ol class="vr-md-ol">`); } out.push(`<li>${inline(m[1])}</li>`); continue; }
    closeList(); out.push(`<p class="vr-md-p">${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}
/* Render a brief · markdown (research-note) or structured bodyJson. */
function reportBriefView(b) {
  const title = b.title || (currentRoom ? currentRoom.subject : t("m_rep_brief"));
  const ready = (b.bodyMd && b.bodyMd.length) || b.bodyJson;
  const spineUrl = ready ? briefSpineUrl(b) : null;
  let body;
  if (b.bodyMd && b.bodyMd.length) body = `<div class="vr-md">${mdToHtml(b.bodyMd)}</div>`;
  else if (b.bodyJson) body = renderBriefJson(b.bodyJson);
  else body = `<div class="vr-rep-status"><p>${esc(t("m_rep_empty"))}</p></div>`;
  // Open the brief's real spine renderer (full fidelity · ppt / magazine /
  // newspaper / research-note) over the flattened mobile preview below.
  const viewBtn = spineUrl
    ? `<button type="button" class="vr-rep-view-btn" data-rep-view>${ICON.doc || ""}<span>${esc(t("m_rep_view_full"))}</span></button>`
    : "";
  const html = `<div class="vr-rep-meta"><span class="vr-rep-badge">${esc(realModeLabel(b.mode))}</span>${b.style ? `<span class="vr-rep-badge is-soft">${esc(b.style)}</span>` : ""}</div>
    <h3 class="vr-rep-title">${esc(title)}</h3>${viewBtn}${body}`;
  return { title: t("m_rep_title"), html, mount(bd) {
    const vb = bd.querySelector("[data-rep-view]");
    if (vb && spineUrl) vb.addEventListener("click", () => openReportView(spineUrl));
  } };
}
/* Structured bodyJson (magazine / newspaper / ppt) · kicker · source ·
   milestones · talking points · conclusion. No border-left callouts. */
function renderBriefJson(j) {
  const parts = [];
  if (j.kicker) parts.push(`<p class="vr-rep-kicker-line">${esc(j.kicker)}</p>`);
  if (j.source) parts.push(`<div class="vr-rep-source">${esc(j.source)}</div>`);
  const ms = Array.isArray(j.milestones) ? j.milestones : [];
  if (ms.length) parts.push(`<div class="vr-rep-miles">${ms.map((m) => `<div class="vr-rep-mile"><div class="vr-rep-mile-k">${esc(m.period || "")}</div><div class="vr-rep-mile-t">${esc(m.title || "")}</div>${m.body ? `<p class="vr-rep-mile-b">${esc(m.body)}</p>` : ""}${m.callout ? `<div class="vr-rep-mile-c">${esc(m.callout)}</div>` : ""}</div>`).join("")}</div>`);
  const tp = Array.isArray(j.talkingPoints) ? j.talkingPoints : [];
  if (tp.length) parts.push(`<div class="vr-rep-kicker">${esc(t("m_rep_talking"))}</div><ul class="vr-md-ul">${tp.map((x) => `<li>${esc(typeof x === "string" ? x : (x.point || x.text || ""))}</li>`).join("")}</ul>`);
  if (j.conclusion) { const c = typeof j.conclusion === "string" ? j.conclusion : (j.conclusion.text || j.conclusion.body || ""); if (c) parts.push(`<div class="vr-rep-kicker">${esc(t("m_rep_conclusion"))}</div><p class="vr-md-p">${esc(c)}</p>`); }
  return `<div class="vr-rep-json">${parts.join("") || `<div class="vr-rep-status"><p>${esc(t("m_rep_empty"))}</p></div>`}</div>`;
}

/* Real report viewing · open the brief's own spine renderer (the same
   full-fidelity HTML the desktop uses) so ppt / magazine / newspaper /
   research-note all render properly, not just the flattened mobile preview.
   Mirrors app.js · briefViewerHref: mode → spine URL with ?b=<briefId>. */
function briefSpineUrl(b) {
  if (!b || !b.id) return null;
  const id = encodeURIComponent(b.id);
  if (b.mode === "magazine") return "/magazine.html?b=" + id;
  if (b.mode === "newspaper") return "/newspaper.html?b=" + id;
  if (b.mode === "ppt") return "/ppt.html?b=" + id;
  const r = currentRoom ? "&r=" + encodeURIComponent(currentRoom.id) : "";
  return "/report.html?b=" + id + r; // research-note / bento / default
}
function openReportView(url) { if (!url) return; reportViewUrl = url; if (modalStack.length) pushModal("reportview"); else openModal("reportview"); }
function renderReportView() {
  const url = reportViewUrl;
  if (!url) return { title: t("m_rep_view_title"), html: `<div class="vr-rep-status"><p>${esc(t("m_rep_none"))}</p></div>` };
  // Full-fidelity spine in an iframe (full-bleed over the modal body) +
  // an "open in a new tab" escape for a full-window read.
  const html = `<div class="vr-rep-view">
      <iframe class="vr-rep-frame" src="${esc(url)}" title="${esc(t("m_rep_view_title"))}" loading="eager"></iframe>
      <a class="vr-rep-open-ext" href="${esc(url)}" target="_blank" rel="noopener">${esc(t("m_rep_open_tab"))}</a>
    </div>`;
  return { title: t("m_rep_view_title"), html };
}

const VIEWS = { roundend: renderRoundEnd, vote: renderVote, menu: renderMenu, settings: renderSettings, cast: renderCast, report: renderReport, reportview: renderReportView, reportcfg: renderReportConfig, new: renderNewRoom, prefs: renderPrefs, keys: renderApiKeys, addkey: renderAddKey, usage: renderUsage, language: renderLanguage, agent: renderAgentProfile, model: renderModelPicker, voicesetup: renderVoiceSetup, voicepick: renderVoicePicker, voiceemotion: renderVoiceEmotion, newagent: renderNewAgent, amodel: renderNewAgentModel, dossier: renderDossier };

function wireMenu() {
  const menuBtn = $("[data-act=menu]");
  if (menuBtn) { menuBtn.innerHTML = ICON.menu; menuBtn.addEventListener("click", () => openModal("menu")); }
  const close = $("[data-modal-close]"); if (close) { close.innerHTML = ICON.x; close.addEventListener("click", () => { try { history.back(); } catch (_) { closeModal(); } }); }
  const back = $("[data-modal-back]"); if (back) { back.innerHTML = ICON.back; back.addEventListener("click", popModal); }
  const scrim = $("[data-modal-scrim]"); if (scrim) scrim.addEventListener("click", () => { try { history.back(); } catch (_) { closeModal(); } });
  // Scrollbar · reveal only while the modal body is actively scrolling,
  // then fade it back out after a short idle. The body element persists
  // across view re-renders, so this one listener covers every modal page.
  const mbody = $("[data-modal-body]");
  if (mbody) {
    let scrollIdle = null;
    mbody.addEventListener("scroll", () => {
      mbody.classList.add("is-scrolling");
      if (scrollIdle) clearTimeout(scrollIdle);
      scrollIdle = setTimeout(() => mbody.classList.remove("is-scrolling"), 650);
      syncModalExpand();   // grow the sheet to fullscreen as the body scrolls off its top
    }, { passive: true });
  }
  // Voice-replay toggle lives in the top-bar chip (the round-number slot,
  // repurposed for adjourned rooms · see setRoundChip).
  const rchip = $("[data-vr-round]"); if (rchip) rchip.addEventListener("click", () => {
    if (roomStatus === "adjourned") replayRoom();
    else if (awaitingContinue) openModal(roundEntryView());   // re-open the round-end / vote sheet
  });
  // Report / follow-up just open a modal OVER the room · they must NOT stop
  // an in-progress replay. Replay is only stopped by leaving the room
  // (enterRoom/exitRoom), the manual Exit-Replay chip, or playing to the end.
  const adjReport = $("[data-adj-report]"); if (adjReport) { adjReport.innerHTML = ICON.doc; adjReport.addEventListener("click", () => openReportModal()); }
  const adjFollow = $("[data-adj-followup]"); if (adjFollow) { adjFollow.innerHTML = ICON.plus; adjFollow.addEventListener("click", () => openFollowUpRoom()); }
}

/* ════════════════════════════════════════════════════════════════
   Home · rooms list + New Room.
   ════════════════════════════════════════════════════════════════ */
let ROOMS = [];   // populated from GET /api/rooms (normalised to the shell's shape)
let currentRoom = null;
let backendReady = false;   // false until loadBackend() succeeds (gates the UI)
let needsKey = false;       // no active LLM credential → show the configure-a-key gate

/* Relative "x ago" from an epoch-ms timestamp. */
function relTime(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 50) return "now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}
/* Normalise a backend Room → the shell's room shape (tone←mode, delivery←deliveryMode). */
function normalizeRoom(r) {
  return {
    // `name` is the AI-distilled display title (the backend titler renames the
    // room from the raw query to a short phrase ~after round 1, pushed live via
    // the settings-changed SSE). `subject` keeps the full raw opening query for
    // report / follow-up / delete references. Title surfaces use `name`.
    id: r.id, name: r.name || r.subject || "Untitled", subject: r.subject || r.name || "Untitled", tone: r.mode || "constructive",
    intensity: r.intensity || "sharp", status: r.status || "live", delivery: r.deliveryMode || "voice",
    round: 1, ago: relTime(r.createdAt), createdAt: r.createdAt,
    awaitingClarify: !!r.awaitingClarify, awaitingContinue: !!r.awaitingContinue, briefStyle: r.briefStyle || "auto",
    directorIds: [],
  };
}
/* Load real agents + rooms + credential status. Full-real mode: on
   failure the gate shows an error rather than an offline sim. */
async function loadBackend() {
  const credsP = loadCredsReal();   // real credentials → CREDS + needsKey (concurrent)
  const [agentsRes, roomsRes, modelsRes] = await Promise.allSettled([api.listAgents(), api.listRooms(), api.listModels()]);
  if (agentsRes.status === "fulfilled") applyAgents(agentsRes.value);
  if (roomsRes.status === "fulfilled") {
    const list = (roomsRes.value && roomsRes.value.rooms) || [];
    ROOMS = list.filter((r) => r.kind !== "thread").map(normalizeRoom);
  }
  // Real model catalog · reachable models the active credential can route.
  if (modelsRes.status === "fulfilled") {
    const ms = (modelsRes.value && modelsRes.value.models) || [];
    const reach = ms.filter((m) => m.reachable !== false);
    MODEL_LIST = (reach.length ? reach : ms).map((m) => ({ id: m.modelV, name: m.displayName || m.modelV, deck: m.provider || "" }));
  }
  try { await credsP; } catch (_) { /* gate falls back to needsKey=false default */ }
  backendReady = agentsRes.status === "fulfilled" && roomsRes.status === "fulfilled";
}
let draft = null;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function showView(name) {
  document.querySelectorAll("[data-view]").forEach((v) => { v.hidden = v.dataset.view !== name; });
}

/* Per-room director list · the /api/rooms list carries no members, so we
   hydrate them lazily (see hydrateRoomDirectors) and cache by roomId.
   Falls back to any directorIds already on the room. */
const roomDirectorCache = {};   // roomId → [{id,name,avatarPath}]
function roomDirectors(r) {
  if (roomDirectorCache[r.id]) return roomDirectorCache[r.id];
  return (r.directorIds || []).map((id) => CAST.find((c) => c.id === id)).filter(Boolean);
}
function roomCardAvs(dirs) {
  return dirs.slice(0, 5).map((d) => d.avatarPath
    ? `<img src="${esc(d.avatarPath)}" alt="" draggable="false">`
    : `<span class="vr-rc-av-mono">${esc((d.name || "?").trim().charAt(0).toUpperCase())}</span>`).join("");
}
function roomCardMeta(r, dirs) {
  const deliv = r.delivery === "text" ? t("m_rc_text") : t("m_rc_voice");
  return dirs.length ? t("m_rc_meta", { delivery: deliv, n: dirs.length, ago: r.ago }) : `${deliv} · ${r.ago}`;
}
/* Three room states, in list order · live → paused → adjourned. Anything that
   isn't explicitly live/paused (incl. legacy / unknown) folds into adjourned. */
const ROOM_STATUS_ORDER = ["live", "paused", "adjourned"];
function roomStatusKind(r) {
  return r.status === "live" ? "live" : r.status === "paused" ? "paused" : "adjourned";
}
function roomStatusClass(kind) {
  return kind === "live" ? "is-live" : kind === "paused" ? "is-paused" : "is-done";
}
function roomStatusLabel(kind) {
  return kind === "live" ? t("m_rc_live") : kind === "paused" ? t("m_rc_paused") : t("m_rc_adjourned");
}
function roomCard(r) {
  const tone = TONES.find((x) => x.id === r.tone) || {};
  const dirs = roomDirectors(r);
  // Status now lives in the section header (see renderRooms) so the card head
  // carries only the tone — no per-card status chip to repeat the group label.
  return `<button type="button" class="vr-roomcard" data-room="${r.id}">
    <div class="vr-rc-head">
      <span class="vr-rc-tone">${tone.icon || ""}<span>${esc(toneName(r.tone))}</span></span>
    </div>
    <div class="vr-rc-subject">${esc(r.subject)}</div>
    <div class="vr-rc-foot">
      <div class="vr-rc-avs">${roomCardAvs(dirs)}</div>
      <span class="vr-rc-meta">${esc(roomCardMeta(r, dirs))}</span>
    </div>
  </button>`;
}
/* Lazily fetch each room's members (concurrency-limited) so the cards can
   show their director avatars · the list endpoint omits members. Cached, so
   re-renders (locale switch, room exit) never re-fetch. */
let _hydratingDirs = false;
async function hydrateRoomDirectors() {
  if (_hydratingDirs || !backendReady) return;
  const todo = ROOMS.filter((r) => !roomDirectorCache[r.id]);
  if (!todo.length) return;
  _hydratingDirs = true;
  let idx = 0;
  const worker = async () => {
    while (idx < todo.length) {
      const r = todo[idx++];
      if (roomDirectorCache[r.id]) continue;
      try {
        const snap = await api.getRoom(r.id);
        const dirs = ((snap && snap.members) || [])
          .filter((m) => m.roleKind !== "moderator")
          .map((m) => ({ id: m.id, name: m.name, avatarPath: m.avatarPath || "" }));
        roomDirectorCache[r.id] = dirs;
        r.directorIds = dirs.map((d) => d.id);
        updateRoomCardDirectors(r);
      } catch (_) { roomDirectorCache[r.id] = []; }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker)); }
  finally { _hydratingDirs = false; }
}
/* Patch one card's avatar strip + meta in place (preserves its click wiring). */
function updateRoomCardDirectors(r) {
  const card = [...document.querySelectorAll("[data-room]")].find((el) => el.dataset.room === r.id);
  if (!card) return;
  const dirs = roomDirectors(r);
  const avs = card.querySelector(".vr-rc-avs"); if (avs) avs.innerHTML = roomCardAvs(dirs);
  const meta = card.querySelector(".vr-rc-meta"); if (meta) meta.textContent = roomCardMeta(r, dirs);
}
function renderRooms() {
  const wrap = $("[data-rooms]");
  if (!wrap) return;
  if (!backendReady) {
    wrap.innerHTML = `<div class="vr-gate"><div class="vr-gate-t">${esc(t("m_gate_offline_t"))}</div><p>${esc(t("m_gate_offline_b"))}</p></div>`;
    return;
  }
  const banner = needsKey ? `<div class="vr-gate vr-gate-key"><div class="vr-gate-t">${esc(t("m_gate_key_t"))}</div><p>${esc(t("m_gate_key_b"))}</p><button type="button" class="vr-convene" data-act="prefs">${esc(t("m_prefs_keys"))}</button></div>` : "";
  let body;
  if (!ROOMS.length) {
    body = `<div class="vr-gate"><p>${esc(t("m_rooms_empty"))}</p></div>`;
  } else {
    // Bucket into live / paused / adjourned, preserving each bucket's recency
    // order, then render one mono-kicker header per non-empty group.
    const groups = { live: [], paused: [], adjourned: [] };
    ROOMS.forEach((r) => groups[roomStatusKind(r)].push(r));
    body = ROOM_STATUS_ORDER.filter((k) => groups[k].length).map((k) => {
      const head = `<div class="vr-rooms-grp ${roomStatusClass(k)}"><span class="vr-rooms-grp-dot"></span><span class="vr-rooms-grp-label">${esc(roomStatusLabel(k))}</span><span class="vr-rooms-grp-n">${groups[k].length}</span></div>`;
      return head + groups[k].map(roomCard).join("");
    }).join("");
  }
  wrap.innerHTML = banner + body;
  wrap.querySelectorAll("[data-room]").forEach((el) => el.addEventListener("click", () => {
    const room = ROOMS.find((r) => r.id === el.dataset.room);
    if (room) enterRoom(room);
  }));
  const gk = wrap.querySelector(".vr-gate-key [data-act=prefs]");
  if (gk) gk.addEventListener("click", () => openModal("prefs"));
  hydrateRoomDirectors();   // fill in director avatars (cached · only fetches missing)
}

/* Adjourned rooms open with the full transcript already filed. */
function fillTranscriptAll() {
  const tr = $("[data-transcript]"); if (tr) tr.innerHTML = "";
  ensureSession();
  const rows = recordedTranscript.length ? recordedTranscript : flattenSession(currentSession);
  rows.forEach((t) => appendTranscript(byId(t.speakerId) || { name: t.speakerId }, t.text));
  buildQueue(roundBeats(roomState ? roomState.roundIdx : 0));
  markQueue(999);
  showVoteDot();
}

/* New Room · a draft edited in the modal, then convened into a live room. */
function renderNewRoom() {
  if (!draft) draft = { subject: loadDraft("room_subject"), tone: "brainstorm", intensity: "sharp", delivery: "voice", autoPick: true, directorIds: ROSTER.slice(0, 4).map((r) => r.id) };
  const tiles = TONES.map((o) => `<button class="vr-tile${o.id === draft.tone ? " is-checked" : ""}" data-dtone="${o.id}">${o.icon}<span>${esc(toneName(o.id))}</span></button>`).join("");
  const fmt = [{ id: "voice", label: t("m_rc_voice"), icon: ICON.mic }, { id: "text", label: t("m_rc_text"), icon: ICON.bubble }]
    .map((o) => `<button class="vr-tile${o.id === draft.delivery ? " is-checked" : ""}" data-ddel="${o.id}">${o.icon}<span>${esc(o.label)}</span></button>`).join("");
  // Board · ONE tappable field that opens the picker. Auto-pick shows a
  // sparkle row; manual shows the picked directors as an avatar stack. The
  // auto-vs-manual choice itself lives inside the picker.
  const selDirs = draft.directorIds.map((id) => ROSTER.find((r) => r.id === id)).filter(Boolean);
  const boardField = draft.autoPick
    ? `<button type="button" class="vr-board-field is-auto" data-dpickopen>
        <span class="vr-board-ic">${ICON.spark}</span>
        <span class="vr-board-tx"><b>${esc(t("m_nr_auto"))}</b><em>${esc(t("m_nr_auto_hint"))}</em></span>
        ${ICON.chev}</button>`
    : `<button type="button" class="vr-board-field" data-dpickopen>
        <span class="vr-dirsum-avs">${selDirs.slice(0, 7).map((r) => r.avatarPath ? `<img src="${esc(r.avatarPath)}" alt="" draggable="false">` : `<span class="vr-dirsum-mono">${esc((r.name || "?").trim().slice(0, 1).toUpperCase())}</span>`).join("")}${selDirs.length > 7 ? `<span class="vr-dirsum-more">+${selDirs.length - 7}</span>` : ""}</span>
        <span class="vr-board-count">${selDirs.length}</span>${ICON.chev}</button>`;
  const html = `
    ${draft.parentRoomId ? `<div class="vr-followup-note">${esc(t("m_nr_followup_note", { subject: draft.parentSubject || "" }))}</div>` : ""}
    <div class="vr-set-group"><h4>${esc(t("m_nr_subject"))}</h4><textarea class="vr-input vr-textarea" data-dsubject placeholder="${esc(t("m_nr_subject_ph"))}">${esc(draft.subject)}</textarea></div>
    <div class="vr-set-group"><h4>${esc(t("m_nr_format"))}</h4><div class="vr-tile-grid">${fmt}</div></div>
    <div class="vr-set-group"><h4>${esc(t("m_nr_tone"))}</h4><div class="vr-tile-grid">${tiles}</div></div>
    <div class="vr-set-group">
      <h4>${esc(t("m_nr_board"))}</h4>
      ${boardField}
    </div>
    <button type="button" class="vr-convene" data-convene>${esc(t("m_nr_convene"))}</button>`;
  return { title: t("m_nr_title"), html, mount(b) {
    b.querySelector("[data-dsubject]").addEventListener("input", (e) => { draft.subject = e.target.value; saveDraft("room_subject", e.target.value); });
    b.querySelectorAll("[data-ddel]").forEach((btn) => btn.addEventListener("click", () => { draft.delivery = btn.dataset.ddel; renderModal(); }));
    b.querySelectorAll("[data-dtone]").forEach((btn) => btn.addEventListener("click", () => { draft.tone = btn.dataset.dtone; renderModal(); }));
    const po = b.querySelector("[data-dpickopen]"); if (po) po.addEventListener("click", openDirectorPicker);   // the board field opens the picker
    b.querySelector("[data-convene]").addEventListener("click", createRoom);
  } };
}
async function createRoom() {
  if (needsKey) { toast(t("m_gate_key_t")); return; }
  const subject = (draft.subject || "").trim();
  if (!subject) { toast(t("m_nr_subject_ph")); return; }
  const body = {
    subject, mode: draft.tone, intensity: draft.intensity || "sharp",
    deliveryMode: draft.delivery || "voice", briefStyle: draft.briefStyle || "auto",
  };
  // Follow-up · link the new room to its parent so the backend prepends the
  // parent brief + Stage-1 signals to the directors (mirrors desktop).
  if (draft.parentRoomId) body.parentRoomId = draft.parentRoomId;
  if (draft.autoPick) {
    body.autoPick = true;   // backend assembles the board from the registry by subject
  } else {
    const agentIds = (draft.directorIds || []).slice();
    if (agentIds.length < 2) { toast(t("m_toast_pick_two")); return; }
    body.agentIds = agentIds; body.autoPick = false;
  }
  const btn = document.querySelector("[data-convene]");
  if (btn) { btn.classList.add("is-dim"); btn.textContent = t("m_nr_convening"); }
  let res;
  try {
    res = await api.createRoom(body);
  } catch (e) {
    if (btn) { btn.classList.remove("is-dim"); btn.textContent = t("m_nr_convene"); }
    toast((e && e.message) || t("m_room_create_fail")); return;
  }
  const room = normalizeRoom(res.room);
  ROOMS.unshift(room);
  draft = null;
  clearDraft("room_subject");
  closeModal();
  enterRoom(room);
}
/* Create a follow-up room from the adjourned room · seed the new-room form
   with the parent's tone / intensity / delivery + same cast, linked via
   parentRoomId (the user just writes the next question). Mirrors the desktop
   follow-up overlay's "keep going" defaults. */
function openFollowUpRoom() {
  if (!currentRoom) return;
  const dirs = (currentRoom.directorIds && currentRoom.directorIds.length)
    ? currentRoom.directorIds.slice()
    : ROSTER.filter((r) => r.active).map((r) => r.id);
  draft = {
    subject: "",
    tone: roomMode || "constructive",
    intensity: roomIntensity || "sharp",
    delivery: roomDelivery || "voice",
    autoPick: dirs.length < 2,                 // keep the parent cast when we have it
    directorIds: dirs.length ? dirs : ROSTER.slice(0, 4).map((r) => r.id),
    parentRoomId: currentRoom.id,
    parentSubject: currentRoom.subject || "",
  };
  openModal("new");
}

let homeTab = "rooms";
function switchHomeTab(name) {
  homeTab = name;
  document.querySelectorAll("[data-hpanel]").forEach((p) => { p.hidden = p.dataset.hpanel !== name; });
  document.querySelectorAll("[data-htab]").forEach((b) => b.classList.toggle("is-active", b.dataset.htab === name));
  setHomeTitle();
  if (name === "directors") renderDirectors();
}
/* Home header title · reflects the active tab (Rooms / Directors) instead of
   the brand, mirroring the tab label so the header and tab never disagree. */
function setHomeTitle() {
  const el = $(".vr-home-brand"); if (!el) return;
  el.textContent = homeTab === "directors" ? t("m_home_directors") : t("m_home_rooms");
}
function wireNav() {
  const nb = $("[data-act=new]"); if (nb) { nb.innerHTML = ICON.plus; nb.addEventListener("click", () => { if (homeTab === "rooms") { draft = null; openModal("new"); } else { agentDraft = null; openModal("newagent"); } }); }
  const pb = $("[data-act=prefs]"); if (pb) { pb.innerHTML = ICON.gear; pb.addEventListener("click", () => openModal("prefs")); }
  const back = $("[data-act=back]"); if (back) { back.innerHTML = ICON.back; back.addEventListener("click", () => { try { history.back(); } catch (_) { exitRoom(); } }); }
  document.querySelectorAll("[data-htab]").forEach((b) => {
    b.insertAdjacentHTML("afterbegin", b.dataset.ti === "cast" ? ICON.cast : ICON.rooms);
    b.addEventListener("click", () => switchHomeTab(b.dataset.htab));
  });
}

/* ════════════════════════════════════════════════════════════════
   App settings · API keys + usage (prototype · localStorage only).
   ════════════════════════════════════════════════════════════════ */
/* ── Provider catalog · mirrors the desktop taxonomy
   (src/ai/providers.ts). LLM providers split into multi-model
   CARRIERS (one key → many model families · openrouter / bai) and
   single-model DIRECT providers (one key → one family). Voice (TTS)
   and web-search keys are their own categories with their own
   single-active pointer. ─────────────────────────────────────────── */
const PROVIDER_CATALOG = {
  openrouter: { name: "OpenRouter", cat: "llm",    kind: "multi",  hint: "sk-or-v1-…", note: "One key routes every model family." },
  bai:        { name: "B.AI",       cat: "llm",    kind: "multi",  hint: "bai-…",      note: "One key routes every model family." },
  anthropic:  { name: "Anthropic",  cat: "llm",    kind: "single", hint: "sk-ant-…",   note: "Claude family, direct." },
  openai:     { name: "OpenAI",     cat: "llm",    kind: "single", hint: "sk-…",       note: "GPT family, direct." },
  google:     { name: "Google",     cat: "llm",    kind: "single", hint: "AIza…",      note: "Gemini family, direct." },
  xai:        { name: "xAI",        cat: "llm",    kind: "single", hint: "xai-…",      note: "Grok family, direct." },
  moonshot:   { name: "Moonshot",   cat: "llm",    kind: "single", hint: "sk-…",       note: "Kimi family, direct." },
  zhipu:      { name: "Zhipu",      cat: "llm",    kind: "single", hint: "…",          note: "GLM family, direct." },
  minimax:    { name: "MiniMax",    cat: "voice",                  hint: "…",          note: "TTS · live voice rooms." },
  elevenlabs: { name: "ElevenLabs", cat: "voice",                  hint: "…",          note: "TTS · live voice rooms." },
  brave:      { name: "Brave",      cat: "search",                 hint: "BSA…",       note: "Web-search skill source." },
  tavily:     { name: "Tavily",     cat: "search",                 hint: "tvly-…",     note: "Web-search skill source." },
};
const CRED_CATS = [
  { id: "llm",    title: "LLM provider", hint: "Pick one provider the board routes every turn through. Carriers reach many model families from a single key; direct keys reach one family." },
  { id: "voice",  title: "Voice · TTS",  hint: "Spoken voice for live voice rooms — the active key drives every director's speech." },
  { id: "search", title: "Web search",   hint: "Lets directors cite live sources during research-tone rooms." },
];
const provName = (id) => (PROVIDER_CATALOG[id] || {}).name || id;
const provCat  = (id) => (PROVIDER_CATALOG[id] || {}).cat || "llm";

/* Credential store · multi-instance with one active per category,
   mirroring the desktop /api/credentials model. Raw keys live
   on-device only (localStorage · prototype); the UI shows a masked
   preview and NEVER re-renders plaintext after a key is saved. */
/* Real credential layer · llm → /api/credentials, voice → /api/voice-credentials,
   search → /api/search-credentials. The server holds raw keys + returns a
   masked `preview` + single-active pointer; the mobile UI never sees plaintext
   after save. */
const CREDS = { llm: { items: [], activeId: null }, voice: { items: [], activeId: null }, search: { items: [], activeId: null } };
let keyDraft = null;
let credsLoaded = false;
const CRED_API = {
  llm:    { list: () => api.listCredentials(),       create: (p, l, k) => api.createCredential(p, l, k),       active: (id) => api.setActiveCredential(id),       del: (id) => api.deleteCredential(id) },
  voice:  { list: () => api.listVoiceCredentials(),  create: (p, l, k) => api.createVoiceCredential(p, l, k),  active: (id) => api.setActiveVoiceCredential(id),  del: (id) => api.deleteVoiceCredential(id) },
  search: { list: () => api.listSearchCredentials(), create: (p, l, k) => api.createSearchCredential(p, l, k), active: (id) => api.setActiveSearchCredential(id), del: (id) => api.deleteSearchCredential(id) },
};
function applyCredList(cat, res) {
  const arr = (res && res.credentials) || [];
  CREDS[cat].items = arr.map((c) => ({ id: c.id, provider: c.provider, label: c.label || "", preview: c.preview || "" }));
  CREDS[cat].activeId = (res && res.activeId) || (arr.find((c) => c.isActive) || {}).id || null;
}
async function loadCredsReal() {
  const cats = ["llm", "voice", "search"];
  const results = await Promise.allSettled(cats.map((c) => CRED_API[c].list()));
  results.forEach((r, i) => { if (r.status === "fulfilled") applyCredList(cats[i], r.value); });
  credsLoaded = true;
  needsKey = !CREDS.llm.activeId;   // keep the boot gate in sync with live state
}
async function reloadCred(cat) { try { applyCredList(cat, await CRED_API[cat].list()); if (cat === "llm") needsKey = !CREDS.llm.activeId; } catch (_) { /* */ } }
async function addCred(provider, label, key) {
  const cat = provCat(provider);
  try { await CRED_API[cat].create(provider, label, key); await reloadCred(cat); toast(t("m_toast_connected", { name: provName(provider) })); return true; }
  catch (e) { toast((e && e.message) || t("m_send_fail")); return false; }
}
async function removeCred(cat, id) { try { await CRED_API[cat].del(id); await reloadCred(cat); } catch (e) { toast((e && e.message) || t("m_send_fail")); } }
async function setActiveCred(cat, id) { try { await CRED_API[cat].active(id); await reloadCred(cat); } catch (e) { toast((e && e.message) || t("m_send_fail")); } }
function activeCred(cat) { return CREDS[cat].items.find((c) => c.id === CREDS[cat].activeId) || null; }
function credCount() { return CREDS.llm.items.length + CREDS.voice.items.length + CREDS.search.items.length; }

const PROVIDER_COLOR = { anthropic: "#C9A46B", openai: "#6A9B97", openrouter: "#8E7CC3", bai: "#C0795B", google: "#6A9B97", deepseek: "#8E7CC3", unknown: "#5C5A52" };
/* Real usage · GET /api/usage/summary → { totalTokens, agentCount, byModel,
   byAgent, retired, daily }. Tolerant of 404 → stays empty. Mirrors the
   desktop Usage panel (user-settings.js). */
let USAGE = { total: 0, totalTokens: 0, agentCount: 0, byModel: [], byAgent: [], daily: [], retired: { tokens: 0, agents: 0 } };
let usageLoaded = false;
async function loadUsageReal() {
  usageLoaded = true;
  let u = null;
  try { u = await api.getUsage(); } catch (_) { u = null; }
  if (u && typeof u === "object" && (u.totalTokens || Array.isArray(u.byModel))) {
    USAGE = {
      total: u.totalTokens || 0, totalTokens: u.totalTokens || 0, agentCount: u.agentCount || 0,
      byModel: Array.isArray(u.byModel) ? u.byModel : [],
      byAgent: Array.isArray(u.byAgent) ? u.byAgent : [],
      daily: Array.isArray(u.daily) ? u.daily : [],
      retired: u.retired || { tokens: 0, agents: 0 },
    };
  } else { USAGE = { total: 0, totalTokens: 0, agentCount: 0, byModel: [], byAgent: [], daily: [], retired: { tokens: 0, agents: 0 } }; }
}
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n));

function renderPrefs() {
  const llm = activeCred("llm");
  const total = credCount();
  const keySub = llm
    ? t("m_prefs_keys_active", { name: provName(llm.provider) })
    : (total ? t("m_prefs_keys_stored", { n: total }) : t("m_prefs_keys_none"));
  const curLang = (LOCALES.find((l) => l.id === currentLocale()) || LOCALES[0]).label;
  const rows = [
    { go: "keys",  icon: ICON.key,   label: t("m_prefs_keys"),     sub: keySub },
    { go: "usage", icon: ICON.chart, label: t("m_prefs_usage"),    sub: t("m_prefs_usage_sub", { tokens: fmtTokens(USAGE.total) }) },
    { go: "language", icon: ICON.globe, label: t("m_prefs_language"), sub: curLang },
  ];
  const soundOn = sfx() ? sfx().isEnabled() : true;
  const html = `<div class="vr-menu">${rows.map((r) =>
    `<button class="vr-act-row" data-go="${r.go}">${r.icon}<span class="vr-act-label">${esc(r.label)}<em>${esc(r.sub)}</em></span><span class="vr-act-chev">${ICON.chev}</span></button>`).join("")}
    <button class="vr-act-row" data-sound-toggle aria-pressed="${soundOn}">${ICON.sound}<span class="vr-act-label">${esc(t("m_sound"))}<em>${esc(soundOn ? t("m_sound_on") : t("m_sound_off"))}</em></span><span class="vr-switch${soundOn ? " is-on" : ""}" aria-hidden="true"></span></button>
  </div>`;
  return { title: t("m_prefs_title"), html, mount(b) {
    // Usage subtitle shows a token total · lazy-load it so the row is correct on
    // first open (was 0 until you entered the Usage page and came back).
    if (!usageLoaded) loadUsageReal().then(() => { if (modalStack[modalStack.length - 1] === "prefs") renderModal(); });
    b.querySelectorAll("[data-go]").forEach((btn) => btn.addEventListener("click", () => pushModal(btn.dataset.go)));
    const st = b.querySelector("[data-sound-toggle]");
    if (st) st.addEventListener("click", () => { const s = sfx(); if (s) s.setEnabled(!s.isEnabled()); renderModal(); });
  } };
}

function renderLanguage() {
  const cur = currentLocale();
  const rows = LOCALES.map((l) => `<div class="vr-cred-row${l.id === cur ? " is-active" : ""}" data-lang="${l.id}">
    <button type="button" class="vr-cred-pick" aria-label="${l.id === cur ? "Active" : "Select"}">${l.id === cur ? ICON.check : ""}</button>
    <span class="vr-cred-body"><span class="vr-cred-name">${esc(l.label)}</span></span>
  </div>`).join("");
  const html = `<div class="vr-set-group"><h4>${esc(t("m_lang_title"))}</h4><div class="vr-set-list">${rows}</div>
    <p class="vr-set-hint">${esc(t("m_lang_hint"))}</p></div>`;
  return { title: t("m_prefs_language"), html, mount(b) {
    b.querySelectorAll("[data-lang]").forEach((row) => row.addEventListener("click", () => { setLocale(row.dataset.lang); renderModal(); }));
  } };
}

function renderApiKeys() {
  const sections = CRED_CATS.map((cat) => {
    const list = CREDS[cat.id];
    const rows = list.items.length
      ? list.items.map((c) => {
          const active = c.id === list.activeId;
          const meta = (c.label ? esc(c.label) + " · " : "") + `<span class="vr-cred-key">${esc(c.preview)}</span>`;
          return `<div class="vr-cred-row${active ? " is-active" : ""}" data-cred="${c.id}" data-cat="${cat.id}">
            <button type="button" class="vr-cred-pick" data-pick aria-label="${active ? "Active" : "Set active"}">${active ? ICON.check : ""}</button>
            <span class="vr-cred-body"><span class="vr-cred-name">${provName(c.provider)}</span><span class="vr-cred-meta">${meta}</span></span>
            <button type="button" class="vr-cred-del" data-del aria-label="${esc(t("m_cast_remove_aria"))}">${ICON.x}</button>
          </div>`;
        }).join("")
      : `<div class="vr-cred-empty">${esc(t("m_keys_none"))}</div>`;
    return `<div class="vr-set-group">
      <h4>${esc(t("m_cat_" + cat.id))}</h4>
      <div class="vr-set-list">${rows}</div>
      <button type="button" class="vr-cred-add" data-add="${cat.id}">${ICON.plus}<span>${esc(t("m_keys_add"))}</span></button>
      <p class="vr-set-hint">${esc(t("m_cat_" + cat.id + "_hint"))}</p>
    </div>`;
  }).join("");
  const html = sections
    + `<p class="vr-set-hint">${esc(t("m_keys_foot"))}</p>`;
  return { title: t("m_keys_title"), html, mount(b) {
    // Refresh from the backend on open (covers a failed boot-time load).
    if (!credsLoaded) loadCredsReal().then(() => { if (modalStack[modalStack.length - 1] === "keys") renderModal(); });
    b.querySelectorAll("[data-add]").forEach((btn) => btn.addEventListener("click", () => {
      const cat = btn.dataset.add;
      const firstProv = Object.keys(PROVIDER_CATALOG).find((p) => provCat(p) === cat);
      keyDraft = { cat, provider: firstProv, label: "", key: "" };
      pushModal("addkey");
    }));
    b.querySelectorAll("[data-pick]").forEach((btn) => btn.addEventListener("click", async (e) => {
      const row = e.target.closest("[data-cred]"); if (!row) return;
      await setActiveCred(row.dataset.cat, row.dataset.cred); renderModal();
    }));
    b.querySelectorAll("[data-del]").forEach((btn) => btn.addEventListener("click", async (e) => {
      const row = e.target.closest("[data-cred]"); if (!row) return;
      await removeCred(row.dataset.cat, row.dataset.cred); renderModal();
    }));
  } };
}

function renderAddKey() {
  if (!keyDraft) keyDraft = { cat: "llm", provider: "openrouter", label: "", key: "" };
  const cat = keyDraft.cat;
  const catMeta = CRED_CATS.find((c) => c.id === cat) || {};
  const provsIn = (kind) => Object.keys(PROVIDER_CATALOG)
    .filter((p) => provCat(p) === cat && (!kind || PROVIDER_CATALOG[p].kind === kind));
  const tile = (p) => `<button type="button" class="vr-tile${keyDraft.provider === p ? " is-checked" : ""}" data-prov="${p}"><span>${provName(p)}</span></button>`;
  const picker = cat === "llm"
    ? `<div class="vr-set-group"><h4>${esc(t("m_addkey_carriers"))}</h4><div class="vr-tile-grid">${provsIn("multi").map(tile).join("")}</div></div>
       <div class="vr-set-group"><h4>${esc(t("m_addkey_direct"))}</h4><div class="vr-tile-grid">${provsIn("single").map(tile).join("")}</div></div>`
    : `<div class="vr-set-group"><h4>${esc(t("m_addkey_provider"))}</h4><div class="vr-tile-grid">${provsIn().map(tile).join("")}</div></div>`;
  const meta = PROVIDER_CATALOG[keyDraft.provider] || {};
  const html = picker
    + `<div class="vr-set-group"><h4>${esc(t("m_addkey_label"))}</h4><input class="vr-input" data-klabel placeholder="${esc(t("m_addkey_label_ph"))}" value="${esc(keyDraft.label)}"></div>`
    + `<div class="vr-set-group"><h4>${esc(t("m_addkey_key"))}</h4>
        <div class="vr-keyfield"><input class="vr-input vr-keyfield-input" data-kkey type="password" placeholder="${esc(meta.hint || "Paste key")}" value="${esc(keyDraft.key)}" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="button" class="vr-key-eye" data-eye aria-label="${esc(t("m_addkey_eye_aria"))}">${ICON.eye}</button></div>
        <p class="vr-set-hint">${esc(meta.note || "")}</p></div>`
    + `<button type="button" class="vr-convene" data-save>${esc(t("m_addkey_save"))}</button>`;
  return { title: t("m_cat_" + cat), html, mount(b) {
    b.querySelectorAll("[data-prov]").forEach((btn) => btn.addEventListener("click", () => { keyDraft.provider = btn.dataset.prov; renderModal(); }));
    const labelEl = b.querySelector("[data-klabel]"); if (labelEl) labelEl.addEventListener("input", (e) => { keyDraft.label = e.target.value; });
    const keyEl = b.querySelector("[data-kkey]"); if (keyEl) keyEl.addEventListener("input", (e) => { keyDraft.key = e.target.value; });
    const eye = b.querySelector("[data-eye]");
    if (eye && keyEl) eye.addEventListener("click", () => {
      keyEl.type = keyEl.type === "password" ? "text" : "password";
      eye.classList.toggle("is-on", keyEl.type === "text");
    });
    b.querySelector("[data-save]").addEventListener("click", async (e) => {
      const k = (keyDraft.key || "").trim();
      if (!k) { toast(t("m_toast_paste_key")); return; }
      const btn = e.currentTarget; btn.classList.add("is-dim"); btn.textContent = t("m_nr_convening");
      const ok = await addCred(keyDraft.provider, keyDraft.label, k);
      if (!ok) { btn.classList.remove("is-dim"); btn.textContent = t("m_addkey_save"); return; }
      keyDraft = null;
      popModal();   // back to the keys list (re-rendered with the new credential)
    });
  } };
}

let usageDay = null;   // null = cumulative · else "YYYY-MM-DD" drill-down
const usageColor = (p) => PROVIDER_COLOR[p] || PROVIDER_COLOR.unknown;
function usageDayShort(s) { const p = String(s).split("-"); return parseInt(p[1], 10) + "·" + parseInt(p[2], 10); }
function usageDayLong(s) {
  const d = new Date(s + "T00:00:00");
  if (isNaN(d.getTime())) return s;
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return M[d.getMonth()] + " " + d.getDate();
}
/* Usage · cumulative LLM accounting · mirrors the desktop Usage panel: a
   14-day stacked bar chart (provider-coloured, tap a bar to drill into one
   day), a by-model breakdown, and the top token-consuming directors. */
function renderUsage() {
  if (!usageLoaded) {
    return { title: t("m_usage_title"), html: `<div class="vr-cred-empty">${esc(t("m_usage_loading"))}</div>`,
      mount() { loadUsageReal().then(() => { if (modalStack[modalStack.length - 1] === "usage") renderModal(); }); } };
  }
  if (!USAGE.totalTokens) {
    return { title: t("m_usage_title"), html: `<div class="vr-use-empty"><div class="vr-use-empty-num">0</div><div class="vr-use-empty-text">${esc(t("m_usage_none"))}</div></div>` };
  }
  const html = `${usageDayPicker()}${usageChart()}<div class="vr-use-detail">${usageDetail()}</div>`;
  return { title: t("m_usage_title"), html, mount(b) {
    b.querySelectorAll("[data-uday]").forEach((el) => el.addEventListener("click", () => {
      const v = el.dataset.uday; usageDay = v === "all" ? null : v; renderModal();
    }));
  } };
}
function usageDayPicker() {
  const allCls = usageDay === null ? " is-on" : "";
  const dayPill = usageDay !== null ? `<button type="button" class="vr-use-pill is-on" data-uday="${esc(usageDay)}">${esc(usageDayLong(usageDay))}</button>` : "";
  return `<div class="vr-use-days"><button type="button" class="vr-use-pill${allCls}" data-uday="all">${esc(t("m_usage_all"))}</button>${dayPill}</div>`;
}
function usageChart() {
  const days = USAGE.daily || [];
  if (!days.length) return "";
  const max = days.reduce((m, d) => Math.max(m, d.totalTokens || 0), 0);
  const last14 = days.reduce((s, d) => s + (d.totalTokens || 0), 0);
  const todayKey = days[days.length - 1] && days[days.length - 1].day;
  const bars = days.map((d) => {
    const total = d.totalTokens || 0;
    const hPct = max > 0 ? (total > 0 ? Math.max((total / max) * 100, 2) : 0) : 0;
    const seg = new Map();
    for (const m of (d.byModel || [])) seg.set(m.provider, (seg.get(m.provider) || 0) + m.tokens);
    const segs = [...seg.entries()].map(([p, tok]) => `<span style="height:${total > 0 ? ((tok / total) * 100).toFixed(2) : 0}%;background:${usageColor(p)}"></span>`).join("");
    const cls = ["vr-use-cbar"];
    if (d.day === todayKey) cls.push("is-today");
    if (usageDay === d.day) cls.push("is-on");
    if (total === 0) cls.push("is-empty");
    return `<button type="button" class="${cls.join(" ")}" data-uday="${esc(d.day)}" aria-label="${esc(usageDayLong(d.day))} · ${total > 0 ? esc(fmtTokens(total)) : "—"}"><span class="vr-use-cstack" style="height:${hPct.toFixed(2)}%">${segs}</span><span class="vr-use-ctick">${esc(usageDayShort(d.day))}</span></button>`;
  }).join("");
  return `<div class="vr-use-chart"><div class="vr-use-chart-meta"><span>${esc(t("m_usage_last14"))}</span><span class="vr-use-chart-tot">${esc(fmtTokens(last14))}</span></div><div class="vr-use-cbars">${bars}</div></div>`;
}
function usageDetail() {
  if (usageDay === null) {
    return usageDetailBody({ total: USAGE.totalTokens, byModel: USAGE.byModel, byAgent: USAGE.byAgent, agentCount: USAGE.agentCount, retired: USAGE.retired || { tokens: 0, agents: 0 }, scope: t("m_usage_cum") });
  }
  const d = (USAGE.daily || []).find((x) => x.day === usageDay);
  if (!d || !d.totalTokens) return `<div class="vr-use-dayempty">${esc(usageDayLong(usageDay))} · ${esc(t("m_usage_day_none"))}</div>`;
  return usageDetailBody({ total: d.totalTokens, byModel: d.byModel, byAgent: d.byAgent, agentCount: (d.byAgent || []).length, retired: { tokens: 0, agents: 0 }, scope: usageDayLong(usageDay) });
}
function usageDetailBody(o) {
  const total = o.total || 1;
  const byModel = o.byModel || []; const byAgent = o.byAgent || [];
  const segs = byModel.map((m) => `<span style="width:${((m.tokens / total) * 100).toFixed(2)}%;background:${usageColor(m.provider)}"></span>`).join("");
  const modelRows = byModel.map((m) => {
    const pct = (m.tokens / total) * 100;
    return `<div class="vr-use-row"><span class="vr-use-dot" style="background:${usageColor(m.provider)}"></span><span class="vr-use-name">${esc(m.displayName || m.modelV)}<em>${esc(m.provider || "")}</em></span><span class="vr-use-tok">${fmtTokens(m.tokens)}</span><span class="vr-use-pct">${pct.toFixed(pct < 10 ? 1 : 0)}%</span></div>`;
  }).join("");
  const top = byAgent.filter((a) => a.tokens > 0).slice(0, 6);
  const agentRows = top.map((a) => {
    const pct = Math.max((a.tokens / total) * 100, 1);
    const col = usageColor(a.provider);
    const role = a.roleKind === "moderator" ? t("m_usage_chair") : t("m_usage_director");
    return `<div class="vr-use-arow"><div class="vr-use-aname">${esc(a.name)}<em>${esc(role)}</em></div><div class="vr-use-abar"><span style="width:${pct.toFixed(2)}%;background:${col}"></span></div><div class="vr-use-atok">${fmtTokens(a.tokens)}</div></div>`;
  }).join("");
  const silent = byAgent.length - top.length;
  const silentNote = silent > 0 ? `<div class="vr-use-silent">${esc(t("m_usage_silent", { n: silent }))}</div>` : "";
  const retiredNote = (o.retired && o.retired.tokens > 0) ? `<div class="vr-use-retired">${esc(t("m_usage_retired", { agents: o.retired.agents, tokens: fmtTokens(o.retired.tokens) }))}</div>` : "";
  return `
    <div class="vr-use-head">
      <div class="vr-use-total"><div class="vr-use-scope">${esc(o.scope)}</div><div class="vr-use-total-num">${fmtTokens(o.total)}</div><div class="vr-use-total-raw">${Number(o.total).toLocaleString()} ${esc(t("m_usage_unit"))}</div></div>
      <div class="vr-use-meta">
        <div class="vr-use-meta-row"><span>${esc(t("m_usage_meta_models"))}</span><b>${byModel.length}</b></div>
        <div class="vr-use-meta-row"><span>${esc(t("m_usage_meta_agents"))}</span><b>${o.agentCount || 0}</b></div>
        <div class="vr-use-meta-row"><span>${esc(t("m_usage_meta_active"))}</span><b>${byAgent.filter((a) => a.tokens > 0).length}</b></div>
      </div>
    </div>
    <div class="vr-use-bar">${segs}</div>
    <div class="vr-set-group"><h4>${esc(t("m_usage_by_model"))}</h4><div class="vr-use-list">${modelRows}</div></div>
    ${top.length ? `<div class="vr-set-group"><h4>${esc(t("m_usage_top"))}</h4><div class="vr-use-alist">${agentRows}</div>${silentNote}</div>` : ""}
    ${retiredNote}`;
}

/* ════════════════════════════════════════════════════════════════
   Directors · list, profile, new agent.
   ════════════════════════════════════════════════════════════════ */
const AGENTS_META = {
  chair:             { handle: "@chair",    roleTag: "Moderator",    voice: "Calm contralto", bio: "Runs the room — opens rounds, calls votes, keeps the board honest and on-question.", ab: { Dissent: 4, Rigor: 7, Empathy: 7, Pattern: 6, Narrative: 6, Decisiveness: 8 } },
  socrates:          { handle: "@socrates", roleTag: "Skeptic",      voice: "Dry, probing",   bio: "Defines the question before answering it. Distrusts the obvious; surfaces the assumption everyone skipped.", ab: { Dissent: 9, Rigor: 8, Empathy: 4, Pattern: 4, Narrative: 5, Decisiveness: 4 } },
  "first-principles":{ handle: "@firstp",   roleTag: "Physicist",    voice: "Precise, flat",  bio: "Strips a problem to fundamentals and rebuilds from observables. Allergic to analogy used as proof.", ab: { Dissent: 6, Rigor: 9, Empathy: 3, Pattern: 5, Narrative: 4, Decisiveness: 6 } },
  "value-investor":  { handle: "@valueinv", roleTag: "Long-pattern", voice: "Measured, plain", bio: "Reads the question against thirty years of category history. Distrusts novelty until base rates agree.", ab: { Dissent: 5, Rigor: 6, Empathy: 4, Pattern: 9, Narrative: 6, Decisiveness: 7 } },
  "user-empathy":    { handle: "@usere",    roleTag: "Advocate",     voice: "Warm, vivid",    bio: "Reasons from one named user at the moment of friction. Refuses vendor-side rationalisation.", ab: { Dissent: 5, Rigor: 5, Empathy: 9, Pattern: 4, Narrative: 8, Decisiveness: 5 } },
  "long-horizon":    { handle: "@longh",    roleTag: "Strategist",   voice: "Patient, low",   bio: "Plays the move three to five years out. Names the second-order cost of today's win.", ab: { Dissent: 5, Rigor: 7, Empathy: 4, Pattern: 7, Narrative: 6, Decisiveness: 5 } },
  phenomenologist:   { handle: "@phenom",   roleTag: "Observer",     voice: "Soft, attentive", bio: "Watches the room itself — who agreed too fast, what got skipped. The meta-witness.", ab: { Dissent: 7, Rigor: 4, Empathy: 8, Pattern: 4, Narrative: 6, Decisiveness: 2 } },
};

/* ── Ability radar · mirrors the desktop agent-profile radar
   (public/agent-profile.js · SKILL_AXES + renderRadar). Six axes,
   0–10, drawn as inline SVG: a faint neutral baseline (flat 5) under
   the director's filled personality polygon. The mobile `ab` map uses
   capitalised keys (Dissent / Pattern / …); RADAR_FROM_AB maps them to
   the desktop's lowercase axes so both seeded and custom directors
   render. ─────────────────────────────────────────────────────────── */
const RADAR_AXES = ["dissent", "pattern_recall", "rigor", "empathy", "narrative", "decisiveness"];
const RADAR_LABEL = { dissent: "DISSENT", pattern_recall: "RECALL", rigor: "RIGOR", empathy: "EMPATHY", narrative: "NARRATIVE", decisiveness: "DECIDE" };
const RADAR_FROM_AB = { Dissent: "dissent", Rigor: "rigor", Empathy: "empathy", Pattern: "pattern_recall", Narrative: "narrative", Decisiveness: "decisiveness" };
const RADAR_MAX = 10;
function abilityFor(id) {
  const out = {}; for (const a of RADAR_AXES) out[a] = 5;   // flat-5 default (custom directors)
  const meta = AGENTS_META[id];
  if (meta && meta.ab) for (const [k, v] of Object.entries(meta.ab)) {
    const ax = RADAR_FROM_AB[k];
    if (ax && Number.isFinite(v)) out[ax] = Math.max(0, Math.min(RADAR_MAX, v));
  }
  return out;
}
function renderRadarSvg(ability) {
  const cx = 150, cy = 105, r = 78, vbW = 300, vbH = 210;
  const n = RADAR_AXES.length;
  const ang = RADAR_AXES.map((_, i) => (-Math.PI / 2) + (2 * Math.PI * i) / n);
  const clamp = (v) => Math.max(0, Math.min(RADAR_MAX, Number.isFinite(v) ? v : 5));
  const pt = (v, i) => { const ratio = clamp(v) / RADAR_MAX; return [cx + Math.cos(ang[i]) * r * ratio, cy + Math.sin(ang[i]) * r * ratio]; };
  const ring = (ratio) => RADAR_AXES.map((_, i) => `${(cx + Math.cos(ang[i]) * r * ratio).toFixed(1)},${(cy + Math.sin(ang[i]) * r * ratio).toFixed(1)}`).join(" ");
  const basePoly = RADAR_AXES.map((_, i) => pt(5, i).map((x) => x.toFixed(1)).join(",")).join(" ");
  const curPoly = RADAR_AXES.map((a, i) => pt(ability[a], i).map((x) => x.toFixed(1)).join(",")).join(" ");
  const rings = [0.33, 0.66, 1].map((ratio) => `<polygon points="${ring(ratio)}" class="vr-radar-grid"/>`).join("");
  const spokes = RADAR_AXES.map((_, i) => { const [x, y] = pt(RADAR_MAX, i); return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="vr-radar-spoke"/>`; }).join("");
  const labels = RADAR_AXES.map((a, i) => {
    const lr = r + 15, lx = cx + Math.cos(ang[i]) * lr, ly = cy + Math.sin(ang[i]) * lr;
    let anchor = "middle";
    if (Math.abs(Math.cos(ang[i])) > 0.4) anchor = Math.cos(ang[i]) > 0 ? "start" : "end";
    return `<text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="${anchor}" class="vr-radar-label">${RADAR_LABEL[a]}</text>`;
  }).join("");
  return `<svg class="vr-radar" viewBox="0 0 ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg" aria-label="Ability radar">${rings}${spokes}<polygon points="${basePoly}" class="vr-radar-base"/><polygon points="${curPoly}" class="vr-radar-current"/>${labels}</svg>`;
}

/* Per-director activity + loadout · believable static seed (offline
   prototype). Mirrors the desktop profile's metrics grid + skill slots. */
const PROFILE_METRICS = {
  chair:             { rooms: 48, rounds: 612, model: "Opus 4.7",   tokens: "1.2M" },
  socrates:          { rooms: 31, rounds: 274, model: "Sonnet 4.6", tokens: "486K" },
  "first-principles":{ rooms: 27, rounds: 233, model: "Opus 4.7",   tokens: "521K" },
  "value-investor":  { rooms: 24, rounds: 198, model: "Sonnet 4.6", tokens: "402K" },
  "user-empathy":    { rooms: 22, rounds: 187, model: "GPT-5.1",    tokens: "356K" },
  "long-horizon":    { rooms: 19, rounds: 161, model: "Gemini 3",   tokens: "298K" },
  phenomenologist:   { rooms: 14, rounds: 122, model: "Haiku 4.5",  tokens: "143K" },
};
const SKILL_CATALOG = [
  { v: "search",  icon: "⌕", name: "Web Search" },
  { v: "pdf",     icon: "▤", name: "PDF Parse" },
  { v: "shell",   icon: "⌨", name: "Shell" },
  { v: "browser", icon: "◍", name: "Browser" },
  { v: "code",    icon: "▶", name: "Code Exec" },
  { v: "tables",  icon: "▦", name: "Tables" },
  { v: "memory",  icon: "✎", name: "Memory" },
  { v: "urls",    icon: "↗", name: "URL Fetch" },
];
const SEEDED_SKILLS = {
  socrates: ["memory", "urls"],
  "first-principles": ["code", "tables"],
  "value-investor": ["tables", "search", "urls"],
  "user-empathy": ["search", "browser"],
  "long-horizon": ["pdf", "search", "memory"],
  phenomenologist: ["memory", "browser"],
  chair: ["memory"],
};
const skillByV = (v) => SKILL_CATALOG.find((s) => s.v === v);
const PROFILE_BOUNDARIES = {
  chair: "Never argues a position — only sequences the room, surfaces the live tension, and forces the vote.",
  socrates: "Won't supply a conclusion until the question is defined; refuses to accept an unexamined premise.",
  "first-principles": "Rejects analogy used as proof; won't reason from authority or precedent alone.",
  "value-investor": "Won't endorse novelty until base rates agree; flags survivorship bias before excitement.",
  "user-empathy": "Refuses vendor-side rationalisation; always argues from one named user at a moment of friction.",
  "long-horizon": "Won't optimise the quarter at the expense of the decade; names the second-order cost.",
  phenomenologist: "Doesn't take a side — reports what the room did, who agreed too fast, what got skipped.",
};

/* Model catalog · subset of the desktop registry (MODEL_LABELS in
   agent-profile.js). Each director's model is selectable from the
   profile and persisted on-device (prototype). */
const MODEL_CATALOG = [
  { id: "opus-4-7",   name: "Opus 4.7",       deck: "deep reasoning" },
  { id: "sonnet-4-6", name: "Sonnet 4.6",     deck: "balanced · default" },
  { id: "haiku-4-5",  name: "Haiku 4.5",      deck: "fast · low-cost" },
  { id: "gpt-5-5",    name: "GPT-5.5",        deck: "flagship · 1M ctx" },
  { id: "gemini-3-1", name: "Gemini 3.1 Pro", deck: "flagship · 1M ctx" },
  { id: "glm-5-1",    name: "GLM 5.1",        deck: "Zhipu · 200k ctx" },
  { id: "kimi-k2-6",  name: "Kimi K2.6",      deck: "Moonshot · long-ctx" },
];
const DEFAULT_MODEL = {
  chair: "opus-4-7", socrates: "sonnet-4-6", "first-principles": "opus-4-7",
  "value-investor": "sonnet-4-6", "user-empathy": "gpt-5-5", "long-horizon": "gemini-3-1",
  phenomenologist: "haiku-4-5",
};
let modelSel = {};          // agent id → modelV · seeded from real agents in applyAgents()
let MODEL_LIST = [];        // real reachable models · {id:modelV, name:displayName, deck:provider} · filled by loadBackend()
const modelCatalog = () => (MODEL_LIST.length ? MODEL_LIST : MODEL_CATALOG);
function modelIdFor(id) { return modelSel[id] || (AGENTS_META[id] && AGENTS_META[id].modelV) || "sonnet-4-6"; }
function modelFor(id) { const mid = modelIdFor(id); return modelCatalog().find((m) => m.id === mid) || { id: mid, name: mid, deck: "" }; }
/* Persist a director's model to the backend (PATCH modelV) + mirror locally. */
function setModelFor(id, modelId) {
  modelSel[id] = modelId;
  if (AGENTS_META[id]) AGENTS_META[id].modelV = modelId;
  api.patchAgent(id, { modelV: modelId }).catch((e) => toast((e && e.message) || t("m_send_fail")));
}
/* ── Per-agent async extras (memories + stats) · fetched lazily when the
   profile opens, cached, and re-rendered on arrival. ─────────────────── */
const agentExtras = {};     // id → {memLoaded, memories:[{id,content,pinned}], statLoaded, stats:{rooms,rounds,tokens}}
function extrasFor(id) { return agentExtras[id] || (agentExtras[id] = {}); }
async function loadAgentMemories(id) {
  const ex = extrasFor(id);
  try { const r = await api.listMemories(id); ex.memories = (r.memories || []).map((m) => ({ id: m.id, content: m.content, pinned: !!m.pinned })); }
  catch (_) { ex.memories = []; }
  ex.memLoaded = true;
}
async function loadAgentStats(id) {
  const ex = extrasFor(id);
  try { const s = await api.agentStats(id); ex.stats = { rooms: s.roomsJoined || 0, rounds: s.roundsSpoken || 0, tokens: fmtTokens(s.tokensConsumed || 0) }; }
  catch (_) { ex.stats = null; }
  ex.statLoaded = true;
}

/* ── Rules · per-agent operating constraints (mirrors the desktop
   profile's editable rules block · max 5). Seeded with a couple of
   believable rules each; edits + adds + removes persist on-device. ── */
const RULES_MAX = 5;
const SEEDED_RULES = {
  chair: ["Open each round by restating the live question in one line.", "Never let two directors agree without naming what they skipped."],
  socrates: ["Never preface — lead with the assumption being challenged.", "Close on a sharper question, not an answer."],
  "first-principles": ["Cite the load-bearing observable, not the analogy.", "Reject any claim that can't be derived from fundamentals."],
  "value-investor": ["Quote a base rate before reacting to novelty.", "Name the thirty-year analogue for the bet."],
  "user-empathy": ["Name one real user at the moment of friction.", "Refuse vendor-side framing — argue from their side."],
  "long-horizon": ["State the second-order cost before endorsing the quick win.", "Project the move three-to-five years out."],
  phenomenologist: ["Report who agreed too fast — don't take a side.", "Surface the thing the room skipped."],
};
let rulesSel = {};          // edit buffer · id → string[] (seeded from the agent's real userRules)
let _ruleSaveTimer = 0; let _ruleSaveId = null;
/* Real rules · the agent's userRules array, with an in-flight edit buffer. */
function rulesFor(id) { return rulesSel[id] ? rulesSel[id] : (((AGENTS_META[id] && AGENTS_META[id].userRules) || []).slice()); }
function setRules(id, arr) {
  const clean = arr.map((s) => String(s)).slice(0, RULES_MAX);
  rulesSel[id] = clean;
  if (AGENTS_META[id]) AGENTS_META[id].userRules = clean.slice();
  _ruleSaveId = id; clearTimeout(_ruleSaveTimer);
  _ruleSaveTimer = setTimeout(() => saveRules(id), 600);   // debounce → PATCH userRules
}
/* Flush the rules buffer to the backend (drops blank rows). */
function saveRules(id) {
  const arr = (rulesSel[id] || []).map((s) => String(s).trim()).filter(Boolean).slice(0, RULES_MAX);
  api.patchAgent(id, { userRules: arr }).catch((e) => toast((e && e.message) || t("m_send_fail")));
}

/* ── Memory · the chair holds a long-term "about you" dossier; each
   director carries notes abstracted across rooms (mirrors the desktop
   memory section). Director note removals persist. ─────────────────── */
const CHAIR_MEMORY = {
  headline: "You decide fast, then look for reasons — so I hold the first ten minutes open.",
  summary: [
    "Across your rooms you reliably push for a decision before the board has surfaced its strongest objection. The brief comes out sharper when the vote waits one round longer.",
    "You weight a vivid user story heavily and base rates lightly — the productive friction you keep having with Value Investor.",
  ],
  traits: ["Bias to action", "Narrative-led", "Trusts small senior teams"],
  blindSpots: ["Anchors on the first framing", "Under-weights base rates", "Skips the second-order cost"],
  relationship: { tenure: "7 months", rooms: 48, lastSeen: "today" },
};
const DIRECTOR_MEMORY = {
  socrates: ["This board resists defining terms — restating the question lands better than challenging it head-on.", "‘Ship fast’ rooms reward one sharp counter-question early, before momentum sets."],
  "first-principles": ["Teardown-to-a-number arguments persuade here; analogy-based ones stall.", "The user accepts cost reasoning when it ends in a unit economics figure."],
  "value-investor": ["Novelty excites this room — leading with a base rate gets heard better than leading with caution.", "The 2014 analogue keeps recurring; worth retiring it for a fresher one."],
  "user-empathy": ["Naming a single user by situation moves this board more than aggregate metrics.", "The room discounts support tickets — pair them with a revenue line."],
  "long-horizon": ["Second-order costs land only when tied to a named team or quarter.", "This board over-indexes on the launch; the maintenance tail is where I add most."],
  phenomenologist: ["The room agrees fastest right after the chair speaks — worth a beat of silence.", "Quiet directors carry the unspoken objection; I flag who didn't weigh in."],
};
/* Real memories · [{id,content,pinned}] from agentExtras (fetched on open). */
function notesFor(id) { const ex = agentExtras[id]; return (ex && Array.isArray(ex.memories)) ? ex.memories : []; }
function removeNote(id, i) {
  const ex = extrasFor(id); const arr = ex.memories || []; const m = arr[i]; if (!m) return;
  arr.splice(i, 1);                                          // optimistic
  if (m.id) api.deleteMemory(id, m.id).catch((e) => toast((e && e.message) || t("m_send_fail")));
}

let profileAgentId = null;
let profileEditField = null;   // null | "bio" | "instruction" · which brief field is in inline-edit
let profileMemAdd = false;     // chair memory · add-note form open
let agentDraft = null;
let genTimer = null;
const agentMeta = (id) => AGENTS_META[id] || { handle: "@" + id, roleTag: "Director", voice: "—", bio: "", ab: {} };
/* Open a director's profile · resets the transient inline-edit state so a
   half-open editor from a previous agent never leaks into the next. */
function openAgentProfile(id) { profileAgentId = id; profileEditField = null; profileMemAdd = false; openModal("agent"); }
/* Persist a single editable agent field · optimistic local write + PATCH.
   Mirrors setRules: update AGENTS_META so every re-render reads the new value,
   then sync to the backend (toast on failure). patchAgent accepts bio /
   instruction / webSearchEnabled (same fields the desktop profile edits). */
function patchAgentField(id, field, val) {
  if (AGENTS_META[id]) AGENTS_META[id][field] = val;
  api.patchAgent(id, { [field]: val }).catch((e) => toast((e && e.message) || t("m_send_fail")));
}
/* Chair memory · append a manual note (optimistic), persist via addMemory. */
function addAgentNote(id, content) {
  const body = String(content || "").trim();
  if (!body) return;
  const ex = extrasFor(id); if (!Array.isArray(ex.memories)) ex.memories = [];
  ex.memories.unshift({ id: null, content: body, pinned: false });   // optimistic · server fills the real id
  api.addMemory(id, { content: body, kind: "fact" })
    .then((m) => { if (m && m.id && ex.memories[0]) ex.memories[0].id = m.id; })
    .catch((e) => toast((e && e.message) || t("m_send_fail")));
}
/* Delete a director · confirm, then DELETE + drop from the local roster and
   re-render whatever surface is showing it. The chair can't be deleted. */
function confirmDeleteAgent(id) {
  const a = CAST.find((c) => c.id === id) || ROSTER.find((r) => r.id === id); if (!a) return;
  if (!window.confirm(t("m_ap_del_confirm", { name: a.name }))) return;
  api.deleteAgent(id).catch((e) => toast((e && e.message) || t("m_send_fail")));
  // Optimistic local removal.
  const drop = (arr) => { const i = arr.findIndex((x) => x.id === id); if (i >= 0) arr.splice(i, 1); };
  drop(CAST); drop(ROSTER);
  delete AGENTS_META[id];
  closeModal();
  toast(t("m_ap_del_done", { name: a.name }));
  if (homeTab === "directors") renderDirectors();
}
/** Derive an @handle from a display name · lowercase, non-alnum → "_". */
function deriveHandle(name) {
  const slug = (name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 16);
  return "@" + (slug || "new_agent");
}
function avatarThumb(a, size) {
  if (a && a.avatarPath) return `<img class="vr-ag-av" style="width:${size}px;height:${size}px" src="${a.avatarPath}" alt="" draggable="false">`;
  const initials = (a && a.name ? a.name : "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return `<span class="vr-ag-av vr-ag-mono" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.34)}px">${initials}</span>`;
}

/* Cast-gallery card · avatar (chair gets a gold ring) + role kicker + name
   + handle + a one-line bio + a six-bar ability "fingerprint" (each
   director's stat silhouette is distinct). All children are phrasing
   content so they stay valid inside the <button>. `i` drives the staggered
   entrance animation. */
/* Identity card · avatar (chair gets a gold ring) + role kicker + name +
   handle + a one-line bio. All children are phrasing content so they stay
   valid inside the <button>. `i` drives the staggered entrance animation. */
function agentRow(a, i) {
  const m = agentMeta(a.id);
  const isChair = a.roleKind === "chair";
  const kicker = esc(m.roleTag || (isChair ? t("m_ap_moderator") : t("m_ap_title")));
  const bio = esc((m.bio || "").trim());
  return `<button type="button" class="vr-dcard${isChair ? " is-chair" : ""}" data-agent="${a.id}" style="--i:${i}">
    <span class="vr-dcard-top">
      <span class="vr-dcard-av">${avatarThumb(a, 54)}</span>
      <span class="vr-dcard-id">
        <span class="vr-dcard-kicker">${kicker}</span>
        <span class="vr-dcard-name">${esc(a.name)}</span>
        <span class="vr-dcard-handle">${esc(m.handle)}</span>
      </span>
      <span class="vr-dcard-chev">${ICON.chev}</span>
    </span>
    ${bio ? `<span class="vr-dcard-bio">${bio}</span>` : ""}
  </button>`;
}
/* How "used" a director is · real room participation, floored by the seeded
   PROFILE_METRICS baseline so seeded directors always rank with sensible,
   populated numbers (the prototype has no live usage counter). */
function directorUsage(id) {
  let n = 0;
  for (const r of ROOMS) if ((r.directorIds || []).includes(id)) n++;
  const pm = PROFILE_METRICS[id];
  if (pm && typeof pm.rooms === "number") n = Math.max(n, pm.rooms);
  return n;
}
/* Featured "most used" card · a podium tile in the horizontal strip. */
function featuredCard(d, rank, n) {
  const m = agentMeta(d.id);
  const kicker = esc(m.roleTag || t("m_ap_title"));
  return `<button type="button" class="vr-feat${rank === 1 ? " is-top" : ""}" data-agent="${d.id}" style="--i:${rank - 1}">
    <span class="vr-feat-rank">${String(rank).padStart(2, "0")}</span>
    <span class="vr-feat-av">${avatarThumb(d, 64)}</span>
    <span class="vr-feat-name">${esc(d.name)}</span>
    <span class="vr-feat-kicker">${kicker}</span>
    <span class="vr-feat-stat"><b>${n}</b>${esc(t("m_dir_rooms"))}</span>
  </button>`;
}
function renderDirectors() {
  const wrap = $("[data-agents]"); if (!wrap) return;
  // Top-3 most-used directors (chair excluded · ROSTER is directors only).
  const top = ROSTER.map((d) => ({ d, n: directorUsage(d.id) })).sort((a, b) => b.n - a.n).slice(0, 3).filter((x) => x.n > 0);
  // Full roster · chair leads, its profile is reachable here too.
  const list = CHAIR ? [CHAIR, ...ROSTER] : ROSTER.slice();
  let html = "";
  if (top.length) {
    html += `<span class="vr-dir-kicker">${esc(t("m_dir_most_used"))}</span>`;
    html += `<div class="vr-feat-strip">${top.map((x, k) => featuredCard(x.d, k + 1, x.n)).join("")}</div>`;
    html += `<span class="vr-dir-kicker is-sec">${esc(t("m_dir_all"))}</span>`;
  }
  html += `<div class="vr-dir-list">${list.map((a, i) => agentRow(a, i)).join("")}</div>`;
  wrap.innerHTML = html;
  wrap.querySelectorAll("[data-agent]").forEach((el) => el.addEventListener("click", () => openAgentProfile(el.dataset.agent)));
}

/* Collapse long text blocks (instruction / bio / memory notes) to 3 lines
   with a tap-to-expand toggle · only attaches the toggle when the content
   actually overflows the clamp. */
function wireClamps(root) {
  root.querySelectorAll("[data-clamp]").forEach((el) => {
    if (el.dataset.clampWired) return; el.dataset.clampWired = "1";
    requestAnimationFrame(() => {
      if (el.scrollHeight - el.clientHeight <= 2) return;   // fits within 3 lines · no toggle
      el.classList.add("is-clampable");
      const more = document.createElement("button");
      more.type = "button"; more.className = "vr-clamp-more"; more.textContent = t("m_more");
      more.addEventListener("click", (e) => {
        e.stopPropagation(); e.preventDefault();
        const open = el.classList.toggle("is-open");
        more.textContent = open ? t("m_less") : t("m_more");
      });
      el.insertAdjacentElement("afterend", more);
    });
  });
}

function relDate(iso) { try { return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch (_) { return ""; } }
/* Persona dossier card · the full-mode build artifact (7-phase deep build),
   gamified as a character-sheet: a divergence dial (filled arc), a stat grid
   of the structured artifacts, and a CTA. Tapping opens the full dossier
   (persona.md). Returns "" for seeded / Signal agents (no spec). */
function renderPersonaCard(spec, agentId) {
  if (!spec) return "";
  const raw = typeof spec.differentiationScore === "number" ? Math.max(0, Math.min(1, spec.differentiationScore)) : null;
  const scoreNum = raw == null ? "—" : Math.round(raw * 100);
  const C = 163.4;   // 2π·26 · dial circumference
  const off = raw == null ? C : (C * (1 - raw)).toFixed(1);
  const k = spec.knowledge || {};
  const sources = (k.keyThinkers || []).length + (k.foundationalWorks || []).length + (k.recentDevelopments || []).length + (k.contestedClaims || []).length;
  const cell = (v, l) => `<div class="vr-persona-stat"><div class="vr-persona-stat-v">${v}</div><div class="vr-persona-stat-l">${esc(l)}</div></div>`;
  const built = spec.generatedAt ? relDate(spec.generatedAt) : "";
  return `<div class="vr-set-group"><h4>${esc(t("m_ap_persona"))}</h4>
    <button type="button" class="vr-persona-card" data-open-dossier="${esc(agentId)}">
      <div class="vr-persona-head">
        <div class="vr-persona-dial">
          <svg viewBox="0 0 64 64" aria-hidden="true"><circle class="vr-persona-dial-track" cx="32" cy="32" r="26"/><circle class="vr-persona-dial-fill" cx="32" cy="32" r="26" style="stroke-dashoffset:${off}"/></svg>
          <div class="vr-persona-dial-c"><span class="vr-persona-dial-v">${scoreNum}<i>%</i></span></div>
        </div>
        <div class="vr-persona-id">
          <div class="vr-persona-kicker">${esc(t("m_ap_persona_kicker"))}</div>
          <div class="vr-persona-divlabel">${esc(t("m_ap_persona_divergence"))}</div>
          ${built ? `<div class="vr-persona-built">${esc(t("m_ap_persona_built", { date: built }))}</div>` : ""}
        </div>
      </div>
      <div class="vr-persona-grid">
        ${cell(sources, t("m_ap_persona_sources"))}
        ${cell((k.searchQueries || []).length, t("m_ap_persona_searches"))}
        ${cell((spec.fewShot || []).length, t("m_ap_persona_voice"))}
        ${cell((spec.rules || []).length, t("m_ap_persona_rules"))}
        ${cell((spec.reflectionChecklist || []).length, t("m_ap_persona_checks"))}
        ${cell((spec.evalSet || []).length, t("m_ap_persona_evals"))}
      </div>
      <div class="vr-persona-cta"><span class="vr-persona-cta-label">▸ ${esc(t("m_ap_persona_open"))}</span><span class="vr-persona-cta-hint">${esc(t("m_ap_persona_open_hint"))}</span></div>
    </button></div>`;
}

/* ── Persona dossier overlay · previews the full persona.md (markdown). ── */
let dossierAgentId = null; let dossierMd = null; let dossierLoading = false; let dossierErr = null;
function openDossier(agentId) {
  dossierAgentId = agentId; dossierMd = null; dossierErr = null; dossierLoading = true;
  pushModal("dossier");
  api.personaMd(agentId)
    .then((md) => { if (dossierAgentId !== agentId) return; dossierMd = typeof md === "string" ? md : (md && md.markdown) || ""; dossierLoading = false; if (modalStack[modalStack.length - 1] === "dossier") renderModal(); })
    .catch((e) => { if (dossierAgentId !== agentId) return; dossierLoading = false; dossierErr = (e && e.message) || t("m_send_fail"); if (modalStack[modalStack.length - 1] === "dossier") renderModal(); });
}
function renderDossier() {
  const a = CAST.find((c) => c.id === dossierAgentId) || { name: t("m_ap_persona") };
  let body;
  if (dossierLoading) body = `<div class="vr-rep-status"><p>${esc(t("m_ap_dossier_loading"))}</p></div>`;
  else if (dossierErr) body = `<div class="vr-rep-status is-err"><p>${esc(dossierErr)}</p></div>`;
  else if (dossierMd) body = `<div class="vr-md">${mdToHtml(dossierMd)}</div>
    <a class="vr-dossier-dl" href="/api/agents/${encodeURIComponent(dossierAgentId)}/persona.md" download>${esc(t("m_ap_dossier_dl"))}</a>`;
  else body = `<div class="vr-rep-status"><p>${esc(t("m_rep_empty"))}</p></div>`;
  return { title: t("m_ap_dossier_title", { name: a.name }), html: body };
}

function renderAgentProfile() {
  const a = CAST.find((c) => c.id === profileAgentId) || ROSTER.find((r) => r.id === profileAgentId);
  if (!a) return { title: t("m_ap_title"), html: "" };
  const m = agentMeta(a.id);
  const isChair = !!(CHAIR && a.id === CHAIR.id) || a.roleKind === "chair";
  const inRoom = !!ROSTER.find((r) => r.id === a.id && r.active);
  const statusTag = isChair ? t("m_ap_moderator") : (inRoom ? t("m_ap_in_room") : t("m_ap_available"));
  const statusCls = isChair || inRoom ? " is-active" : "";

  // Ability radar + numeric breakdown (both off the same axis map).
  const ability = abilityFor(a.id);
  const bars = RADAR_AXES.map((ax) => {
    const v = ability[ax];
    return `<div class="vr-ab"><span class="vr-ab-k">${RADAR_LABEL[ax]}</span><span class="vr-ab-bar"><i style="width:${v * 10}%"></i></span><span class="vr-ab-v">${v}</span></div>`;
  }).join("");

  // Skills · web-search is the one capability the backend exposes as a toggle.
  // Render it as an interactive switch (PATCH webSearchEnabled) — the desktop
  // profile toggles it the same way — rather than a static "installed" chip.
  const installed = m.webSearchEnabled ? [{ name: "Web Search" }] : [];
  const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
  const skillsHtml = `<button type="button" class="vr-act-row" data-ws-toggle role="switch" aria-checked="${m.webSearchEnabled ? "true" : "false"}">${ICON_SEARCH}<span class="vr-act-label">${esc(t("m_ap_websearch"))}<em>${esc(t("m_ap_websearch_sub"))}</em></span><span class="vr-switch${m.webSearchEnabled ? " is-on" : ""}" aria-hidden="true"></span></button>`;

  // Activity stat grid · real stats (async · "—" until loaded). Model below.
  const ex = extrasFor(a.id);
  const mt = ex.stats || { rooms: "—", rounds: "—", tokens: "—" };
  const model = modelFor(a.id);
  const cell = (lbl, val, unit) => `<div class="vr-stat"><div class="vr-stat-k">${esc(lbl)}</div><div class="vr-stat-v">${val}${unit ? `<span>${esc(unit)}</span>` : ""}</div></div>`;
  const metrics = `<div class="vr-stat-grid">${cell(t("m_ap_stat_rooms"), mt.rooms, t("m_ap_unit_rooms"))}${cell(t("m_ap_stat_rounds"), mt.rounds, t("m_ap_unit_turns"))}${cell(t("m_ap_stat_tokens"), esc(String(mt.tokens)))}${cell(t("m_ap_stat_skills"), installed.length, "")}</div>`;

  // Operating brief · role (read-only) + instruction (inline-editable). The bio
  // has its own editable INTEL block up top, so it's dropped here (it was the
  // "objective" row) to avoid showing the same field twice.
  const editBox = (field, val, max, ph) => `<div class="vr-edit"><textarea class="vr-input vr-textarea" data-edit-input maxlength="${max}" placeholder="${esc(ph)}">${esc(val)}</textarea><div class="vr-edit-acts"><button type="button" class="vr-edit-cancel" data-edit-cancel>${esc(t("m_ap_cancel"))}</button><button type="button" class="vr-edit-save" data-edit-save="${field}">${esc(t("m_ap_save"))}</button></div></div>`;
  const editChip = (field) => `<button type="button" class="vr-edit-btn" data-edit-open="${field}">${esc(t("m_ap_edit"))}</button>`;
  const doc =
    `<div class="vr-doc-row"><div class="vr-doc-k">${esc(t("m_ap_role"))}</div><div class="vr-doc-v vr-clamp" data-clamp>${esc(m.roleTag)}</div></div>`
    + `<div class="vr-doc-row"><div class="vr-doc-k">${esc(t("m_ap_instruction"))}${profileEditField === "instruction" ? "" : editChip("instruction")}</div>${profileEditField === "instruction" ? editBox("instruction", m.instruction, 2000, t("m_ap_instr_ph")) : `<div class="vr-doc-v vr-clamp" data-clamp>${m.instruction ? esc(m.instruction) : esc(t("m_ap_instr_empty"))}</div>`}</div>`;

  // Memory · ONLY the chair surfaces memory (the "about you" dossier the
  // chair keeps across rooms). Directors' internal memories are not shown.
  let memoryHtml = "";
  if (isChair) {
    if (!ex.memLoaded) {
      memoryHtml = `<div class="vr-cred-empty">${esc(t("m_ap_mem_loading"))}</div>`;
    } else {
      const notes = notesFor(a.id);
      const rows = notes.length
        ? notes.map((n, i) => `<div class="vr-note"><div class="vr-note-col"><span class="vr-note-text vr-clamp" data-clamp>${esc(n.content)}</span></div><button type="button" class="vr-cred-del" data-note-rm="${i}" aria-label="${esc(t("m_ap_forget_aria"))}">${ICON.x}</button></div>`).join("")
        : `<div class="vr-cred-empty">${esc(t("m_ap_notes_none"))}</div>`;
      const addForm = profileMemAdd
        ? `<div class="vr-edit vr-mem-add"><textarea class="vr-input vr-textarea" data-mem-input maxlength="280" placeholder="${esc(t("m_ap_note_ph"))}"></textarea><div class="vr-edit-acts"><button type="button" class="vr-edit-cancel" data-mem-cancel>${esc(t("m_ap_cancel"))}</button><button type="button" class="vr-edit-save" data-mem-save>${esc(t("m_ap_save"))}</button></div></div>`
        : `<button type="button" class="vr-cred-add" data-mem-add>${ICON.plus}<span>${esc(t("m_ap_note_add"))}</span></button>`;
      memoryHtml = `<div class="vr-set-list vr-note-list">${rows}</div>${addForm}<p class="vr-set-hint">${esc(t("m_ap_notes_hint"))}</p>`;
    }
  }

  // Persona dossier · full-mode build artifact (custom / full-persona directors).
  const personaHtml = renderPersonaCard(m.personaSpec, a.id);

  // Rules · editable operating constraints (max 5).
  const rules = rulesFor(a.id);
  const atCap = rules.length >= RULES_MAX;
  const ruleRows = rules.length
    ? rules.map((body, i) => `<li class="vr-rule"><span class="vr-rule-num">${i + 1}</span><input type="text" class="vr-rule-input" data-rule="${i}" maxlength="120" value="${esc(body)}" placeholder="never preface · cite the load-bearing claim · …"><button type="button" class="vr-rule-rm" data-rule-rm="${i}" aria-label="${esc(t("m_cast_remove_aria"))}">${ICON.x}</button></li>`).join("")
    : `<li class="vr-rule-empty">${esc(t("m_ap_rules_none"))}</li>`;
  const rulesHtml = `<ol class="vr-rules">${ruleRows}</ol><button type="button" class="vr-cred-add" data-rule-add ${atCap ? "disabled" : ""}>${ICON.plus}<span>${atCap ? esc(t("m_ap_rule_max", { n: RULES_MAX })) : esc(t("m_ap_rule_add"))}</span></button>`;

  const html = `
    <div class="vr-prof-head">
      ${avatarThumb(a, 84)}
      <div class="vr-prof-id">
        <div class="vr-prof-name">${esc(a.name)}</div>
        <div class="vr-prof-role">${esc(m.roleTag)} · ${esc(m.handle)}</div>
        <span class="vr-prof-status${statusCls}">${esc(statusTag)}</span>
      </div>
    </div>
    ${profileEditField === "bio" ? editBox("bio", m.bio, 1200, t("m_ap_bio_ph")) : `<div class="vr-prof-bio-row"><p class="vr-prof-bio vr-clamp" data-clamp>${m.bio ? esc(m.bio) : esc(t("m_ap_bio_empty"))}</p>${editChip("bio")}</div>`}
    <div class="vr-set-group"><h4>${esc(t("m_ap_radar"))}</h4><div class="vr-radar-wrap">${renderRadarSvg(ability)}</div><div class="vr-ab-list">${bars}</div></div>
    <div class="vr-set-group"><h4>${esc(t("m_ap_model"))}</h4>
      <button type="button" class="vr-act-row" data-pick-model>${ICON.model}<span class="vr-act-label">${esc(model.name)}<em>${esc(model.deck)}</em></span><span class="vr-act-chev">${ICON.chev}</span></button>
    </div>
    <div class="vr-set-group"><h4>${esc(t("m_ap_voice"))}</h4>
      <button type="button" class="vr-act-row" data-pick-voice>${ICON.mic}<span class="vr-act-label">${(m.voice && m.voice !== "—") ? esc(m.voice) : esc(t("m_ap_voice_tap_setup"))}<em>${esc(t("m_ap_voice_setup"))}</em></span><span class="vr-act-chev">${ICON.chev}</span></button>
    </div>
    <div class="vr-set-group"><h4>${esc(t("m_ap_activity"))}</h4>${metrics}</div>
    <div class="vr-set-group"><h4>${esc(t("m_ap_skills", { n: installed.length }))}</h4>${skillsHtml}</div>
    <div class="vr-set-group"><h4>${esc(t("m_ap_brief"))}</h4><div class="vr-doc">${doc}</div></div>
    ${personaHtml}
    ${isChair ? `<div class="vr-set-group"><h4>${esc(t("m_ap_mem_chair"))}</h4>${memoryHtml}</div>` : ""}
    <div class="vr-set-group"><h4>${esc(t("m_ap_rules", { n: rules.length, max: RULES_MAX }))}</h4>${rulesHtml}</div>
    ${currentRoom && !isChair ? `<button type="button" class="vr-convene${inRoom ? " is-ghost" : ""}" data-prof-toggle>${inRoom ? esc(t("m_ap_remove_room")) : esc(t("m_ap_add_room"))}</button>` : ""}
    ${!isChair ? `<button type="button" class="vr-prof-del" data-prof-del>${ICON.trash}<span>${esc(t("m_ap_del_dir"))}</span></button>` : ""}`;
  return { title: t("m_ap_title"), html, mount(b) {
    wireClamps(b);   // instruction / bio / memory · clamp to 3 lines + expand
    // Async real data · fetch memories + stats once, re-render when they land
    // (only if still on this agent's profile).
    const stillHere = () => profileAgentId === a.id && modalStack[modalStack.length - 1] === "agent";
    if (isChair && !ex.memLoaded) loadAgentMemories(a.id).then(() => { if (stillHere()) renderModal(); });   // memory · chair only
    if (!ex.statLoaded) loadAgentStats(a.id).then(() => { if (stillHere()) renderModal(); });
    const mp = b.querySelector("[data-pick-model]");
    if (mp) mp.addEventListener("click", () => pushModal("model"));
    const vp = b.querySelector("[data-pick-voice]");
    if (vp) vp.addEventListener("click", () => pushModal("voicesetup"));
    const dossier = b.querySelector("[data-open-dossier]");
    if (dossier) dossier.addEventListener("click", () => openDossier(dossier.dataset.openDossier));
    // Inline edit · bio + instruction. Open → swap to a textarea (auto-focused);
    // save → optimistic PATCH; cancel → discard.
    b.querySelectorAll("[data-edit-open]").forEach((btn) => btn.addEventListener("click", () => {
      profileEditField = btn.dataset.editOpen; renderModal();
      const ta = document.querySelector("[data-modal-body] [data-edit-input]");
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    }));
    const editCancel = b.querySelector("[data-edit-cancel]");
    if (editCancel) editCancel.addEventListener("click", () => { profileEditField = null; renderModal(); });
    const editSave = b.querySelector("[data-edit-save]");
    if (editSave) editSave.addEventListener("click", () => {
      const ta = b.querySelector("[data-edit-input]");
      patchAgentField(a.id, editSave.dataset.editSave, ta ? ta.value.trim() : "");
      profileEditField = null; renderModal();
    });
    // Web-search · the one toggleable capability.
    const ws = b.querySelector("[data-ws-toggle]");
    if (ws) ws.addEventListener("click", () => { patchAgentField(a.id, "webSearchEnabled", !m.webSearchEnabled); renderModal(); });
    // Memory · add a manual note (chair).
    const memAdd = b.querySelector("[data-mem-add]");
    if (memAdd) memAdd.addEventListener("click", () => { profileMemAdd = true; renderModal(); const ta = document.querySelector("[data-modal-body] [data-mem-input]"); if (ta) ta.focus(); });
    const memCancel = b.querySelector("[data-mem-cancel]");
    if (memCancel) memCancel.addEventListener("click", () => { profileMemAdd = false; renderModal(); });
    const memSave = b.querySelector("[data-mem-save]");
    if (memSave) memSave.addEventListener("click", () => { const ta = b.querySelector("[data-mem-input]"); addAgentNote(a.id, ta ? ta.value : ""); profileMemAdd = false; renderModal(); });
    // Delete this director.
    const del = b.querySelector("[data-prof-del]");
    if (del) del.addEventListener("click", () => confirmDeleteAgent(a.id));
    // Rules · per-keystroke persist (no re-render → keep focus); add /
    // remove re-render the profile.
    b.querySelectorAll("[data-rule]").forEach((inp) => inp.addEventListener("input", () => {
      const cur = rulesFor(a.id).slice();
      cur[Number(inp.dataset.rule)] = inp.value;
      setRules(a.id, cur);
    }));
    b.querySelectorAll("[data-rule-rm]").forEach((btn) => btn.addEventListener("click", () => {
      const cur = rulesFor(a.id).slice();
      cur.splice(Number(btn.dataset.ruleRm), 1);
      setRules(a.id, cur);
      renderModal();
    }));
    const addRule = b.querySelector("[data-rule-add]");
    if (addRule) addRule.addEventListener("click", () => {
      const cur = rulesFor(a.id).slice();
      if (cur.length >= RULES_MAX) return;
      cur.push("");
      setRules(a.id, cur);
      renderModal();
      const inputs = document.querySelectorAll("[data-modal-body] [data-rule]");
      const last = inputs[inputs.length - 1]; if (last) last.focus();
    });
    // Memory · forget a carried note (directors only).
    b.querySelectorAll("[data-note-rm]").forEach((btn) => btn.addEventListener("click", () => {
      removeNote(a.id, Number(btn.dataset.noteRm));
      renderModal();
    }));
    const toggleBtn = b.querySelector("[data-prof-toggle]");
    if (toggleBtn) toggleBtn.addEventListener("click", () => {
      const r = ROSTER.find((x) => x.id === a.id); if (!r || !currentRoom) return;
      if (r.active && inRoomCount() <= 2) { toast(t("m_toast_min_two")); return; }
      r.active = !r.active;
      const agentIds = ROSTER.filter((x) => x.active).map((x) => x.id);
      currentRoom.directorIds = agentIds;
      rebuildCast();
      // Persist the membership change · SSE member events re-sync the cast.
      api.patchMembers(currentRoom.id, agentIds).catch((e) => toast((e && e.message) || t("m_send_fail")));
      closeModal();
    });
  } };
}

function renderModelPicker() {
  const id = profileAgentId;
  const a = CAST.find((c) => c.id === id) || ROSTER.find((r) => r.id === id);
  const curId = modelIdFor(id);
  const rows = modelCatalog().map((mo) => {
    const active = mo.id === curId;
    return `<div class="vr-cred-row${active ? " is-active" : ""}" data-model="${mo.id}">
      <button type="button" class="vr-cred-pick" data-pick aria-label="${active ? "Active" : "Select"}">${active ? ICON.check : ""}</button>
      <span class="vr-cred-body"><span class="vr-cred-name">${esc(mo.name)}</span><span class="vr-cred-meta">${esc(mo.deck)}</span></span>
    </div>`;
  }).join("");
  const html = `<div class="vr-set-group"><h4>${esc(t("m_model_for", { name: a ? a.name : t("m_ap_title") }))}</h4><div class="vr-set-list">${rows}</div></div>
    <p class="vr-set-hint">${esc(t("m_model_hint"))}</p>`;
  return { title: t("m_model_title"), html, mount(b) {
    b.querySelectorAll("[data-model]").forEach((row) => row.addEventListener("click", () => {
      setModelFor(id, row.dataset.model);
      toast(t("m_toast_model_set", { name: modelFor(id).name }));
      popModal();
    }));
  } };
}

/* ════════════════════════════════════════════════════════════════
   Voice setup · per-director TTS voice config, porting the full
   desktop agent-profile voice block (public/agent-profile.js ·
   renderVoiceBlock): pick a voice from the provider catalog, choose an
   emotion, fine-tune speed/pitch/timbre, preview the result, and clone a
   custom voice. The trimmed CAST agents don't carry the full voice
   OBJECT, so we lazily fetch it via getAgent and cache in `voiceSel`;
   saving is PATCH /api/agents/:id { voice }. Reuses the desktop
   `ap_voice_*` i18n keys (the shared I18n.STR is loaded on this page).
   ════════════════════════════════════════════════════════════════ */
let voiceSel = {};            // id → full voice obj {voiceId,provider,model,emotion,speed,...}
const voiceLoaded = {};       // id → true once getAgent populated voiceSel[id]
let voicePager = { voices: [], cursor: null, hasMore: true, loading: false, initialised: false, configured: false, provider: null, error: null };
// Full catalog voiceId→label map · a saved director voice only stores the
// voiceId (no label), so the paged picker (first page only) can't always
// resolve its friendly name. One full-catalog fetch gives every label.
let voiceLabelMap = null;     // { voiceId: label } | null (not loaded)
let _voiceLabelLoading = false, _voiceLabelWaiters = [];

const VOICE_EMOTIONS = ["", "happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm", "fluent"];
const VOICE_TUNES = [
  { key: "speed",           min: 0.5,  max: 2,   step: 0.1, def: 1, fmt: (v) => v.toFixed(1) + "×" },
  { key: "pitch",           min: -12,  max: 12,  step: 1,   def: 0, fmt: (v) => (v > 0 ? "+" : "") + v },
  { key: "modifyPitch",     min: -100, max: 100, step: 5,   def: 0, fmt: (v) => (v > 0 ? "+" : "") + v },
  { key: "modifyIntensity", min: -100, max: 100, step: 5,   def: 0, fmt: (v) => (v > 0 ? "+" : "") + v },
  { key: "modifyTimbre",    min: -100, max: 100, step: 5,   def: 0, fmt: (v) => (v > 0 ? "+" : "") + v },
];
const VOICE_TUNE_LABEL = { speed: "ap_voice_speed", pitch: "ap_voice_pitch", modifyPitch: "ap_voice_modify_pitch", modifyIntensity: "ap_voice_modify_intensity", modifyTimbre: "ap_voice_modify_timbre" };

function voiceFor(id) { return voiceSel[id] || null; }
function emotionLabel(slug) {
  const s = slug == null ? "" : String(slug);
  const key = s ? "ap_voice_emotion_" + s : "ap_voice_emotion_auto";
  const txt = t(key);
  return txt === key ? (s || "auto") : txt;
}
function voiceLabel(v) {
  if (!v || !v.voiceId) return "";
  if (v.label) return v.label;
  if (voiceLabelMap && voiceLabelMap[v.voiceId]) return voiceLabelMap[v.voiceId];
  const hit = voicePager.voices.find((x) => x.voiceId === v.voiceId && (!v.provider || x.provider === v.provider));
  if (hit && hit.label && hit.label !== hit.voiceId) return hit.label;
  return v.voiceId;
}
/* Fetch the FULL voice catalog once → voiceId→label map, so a saved voice
   resolves to its friendly name even if it's not on a loaded picker page. */
function ensureVoiceLabels(cb) {
  if (voiceLabelMap) { if (cb) cb(); return; }
  if (cb) _voiceLabelWaiters.push(cb);
  if (_voiceLabelLoading) return;
  _voiceLabelLoading = true;
  api.listAllVoices().then((r) => {
    const map = {};
    for (const v of ((r && r.voices) || [])) { if (v.voiceId && v.label && v.label !== v.voiceId) map[v.voiceId] = v.label; }
    voiceLabelMap = map;
  }).catch(() => { voiceLabelMap = voiceLabelMap || {}; }).then(() => {
    _voiceLabelLoading = false;
    const ws = _voiceLabelWaiters; _voiceLabelWaiters = [];
    for (const w of ws) { try { w(); } catch (_) { /* */ } }
  });
}
/* Persist a director's voice (PATCH voice) + mirror local caches. */
function setVoiceFor(id, voice) {
  voiceSel[id] = voice;
  if (AGENTS_META[id]) AGENTS_META[id].voice = (voice && voice.voiceId) ? voice.voiceId : "—";
  api.patchAgent(id, { voice }).catch((e) => toast((e && e.message) || t("m_send_fail")));
}
/* Lazily fetch the full agent so voiceSel[id] holds the real voice object. */
function ensureVoiceLoaded(id, cb) {
  if (voiceLoaded[id]) { if (cb) cb(); return; }
  api.getAgent(id).then((a) => {
    voiceLoaded[id] = true;
    voiceSel[id] = (a && a.voice && typeof a.voice === "object") ? a.voice : {};
    if (cb) cb();
  }).catch(() => { voiceLoaded[id] = true; voiceSel[id] = voiceSel[id] || {}; if (cb) cb(); });
}
/* Load the next page of the voice catalog (also sets the `configured`
   gate from the first response). Callbacks QUEUE as waiters and flush
   once on settle — never synchronously while a fetch is in flight (a
   sync cb would re-enter the not-ready render and spin into a loop). */
let _voiceWaiters = [];
function _flushVoiceWaiters() { const ws = _voiceWaiters; _voiceWaiters = []; for (const w of ws) { try { w(); } catch (_) { /* */ } } }
function loadVoicePage(cb) {
  if (cb) _voiceWaiters.push(cb);
  if (voicePager.loading) return;                                  // in flight · cb queued, flushed on settle
  if (voicePager.initialised && !voicePager.hasMore) { _flushVoiceWaiters(); return; }
  voicePager.loading = true;
  api.listVoices(voicePager.cursor, 30).then((r) => {
    voicePager.loading = false; voicePager.initialised = true;
    voicePager.configured = !!(r && r.configured);
    voicePager.provider = (r && r.provider) || voicePager.provider;
    voicePager.error = (r && r.error) || null;
    const seen = new Set(voicePager.voices.map((v) => v.provider + "|" + (v.model || "") + "|" + (v.voiceId || "")));
    for (const v of ((r && r.voices) || [])) {
      const k = v.provider + "|" + (v.model || "") + "|" + (v.voiceId || "");
      if (!seen.has(k)) { seen.add(k); voicePager.voices.push(v); }
    }
    voicePager.cursor = (r && r.nextCursor) || null;
    voicePager.hasMore = !!(r && r.hasMore);
    _flushVoiceWaiters();
  }).catch((e) => {
    voicePager.loading = false; voicePager.initialised = true;
    voicePager.error = { message: (e && e.message) || "fetch failed" };
    _flushVoiceWaiters();
  });
}
function ensureVoices(cb) { if (voicePager.initialised && !voicePager.loading) { if (cb) cb(); return; } loadVoicePage(cb); }
function atVoiceView(view, id) { return profileAgentId === id && modalStack[modalStack.length - 1] === view; }

/* Play a TTS preview of the director's current voice. */
function previewVoiceFor(id, btn) {
  const v = voiceFor(id) || {};
  if (!v.voiceId) { toast(t("m_ap_voice_pick_first")); return; }
  if (btn) btn.classList.add("is-playing");
  const done = () => { if (btn) btn.classList.remove("is-playing"); };
  const sample = t("ap_voice_preview_sample");
  api.previewVoice({
    text: (sample && sample !== "ap_voice_preview_sample") ? sample : "Hello — this is how I sound in the room.",
    provider: v.provider, model: v.model, voiceId: v.voiceId,
    speed: v.speed, pitch: v.pitch, emotion: v.emotion || "",
    modifyPitch: v.modifyPitch, modifyIntensity: v.modifyIntensity, modifyTimbre: v.modifyTimbre,
  }).then((r) => {
    if (!r || !r.audioBase64) { done(); toast(t("m_ap_voice_preview_fail")); return; }
    try {
      const audio = new Audio("data:" + (r.mimeType || "audio/mpeg") + ";base64," + r.audioBase64);
      audio.addEventListener("ended", done); audio.addEventListener("error", done);
      audio.play().catch(done);
    } catch (_) { done(); }
  }).catch((e) => { done(); const b = e && e.body; toast((b && b.error) || (e && e.message) || t("m_ap_voice_preview_fail")); });
}

/* Open the desktop voice-clone singleton overlay (loaded on this page). */
function openVoiceClone(id, name) {
  const vc = window.boardroomVoiceClone;
  if (!vc || typeof vc.open !== "function") { toast(t("m_voice_clone_unavailable")); return; }
  try {
    vc.open({
      agentId: id, agentName: name,
      onApplied: (applied) => {
        if (!applied) return;
        const c = voiceFor(id) || {};
        setVoiceFor(id, { ...c, voiceId: applied.voiceId, provider: applied.provider || c.provider, label: applied.label });
        // Drop the catalog cache so the fresh clone shows in the picker +
        // its name resolves in the label map.
        voicePager = { voices: [], cursor: null, hasMore: true, loading: false, initialised: false, configured: voicePager.configured, provider: voicePager.provider, error: null };
        voiceLabelMap = null;
        if (atVoiceView("voicesetup", id)) renderModal();
      },
    });
  } catch (e) { toast((e && e.message) || t("m_voice_clone_unavailable")); }
}

/* ── Voice setup screen · current voice + emotion + tuning + clone. ── */
function renderVoiceSetup() {
  const id = profileAgentId;
  const a = CAST.find((c) => c.id === id) || ROSTER.find((r) => r.id === id);
  const name = a ? a.name : t("m_ap_title");
  if (!(voiceLoaded[id] && voicePager.initialised)) {
    return { title: t("m_ap_voice_setup"), html: `<div class="vr-cred-empty">${esc(t("m_voice_loading"))}</div>`, mount() {
      // Render once BOTH the agent voice + the catalog are ready · ensureX
      // can fire its cb synchronously (already-loaded) so guarding on both
      // + a done flag avoids a re-render loop while one side is still in flight.
      let done = false;
      const check = () => { if (done) return; if (voiceLoaded[id] && voicePager.initialised) { done = true; if (atVoiceView("voicesetup", id)) renderModal(); } };
      ensureVoiceLoaded(id, check); ensureVoices(check);
    } };
  }
  if (!voicePager.configured) {
    const html = `<div class="vr-set-group"><h4>${esc(t("m_ap_voice_setup"))}</h4>
      <div class="vr-voice-locked">
        <div class="vr-voice-locked-title">${esc(t("ap_voice_locked_title"))}</div>
        <button type="button" class="vr-convene" data-voice-keys>${esc(t("ap_voice_locked_cta"))}</button>
      </div></div>`;
    return { title: t("m_ap_voice_setup"), html, mount(b) {
      const k = b.querySelector("[data-voice-keys]"); if (k) k.addEventListener("click", () => pushModal("keys"));
    } };
  }
  const v = voiceFor(id) || {};
  const vLabel = voiceLabel(v) || t("m_ap_voice_choose");
  const provider = v.provider || voicePager.provider || "";
  const tunes = VOICE_TUNES.map((tn) => {
    const val = (typeof v[tn.key] === "number") ? v[tn.key] : tn.def;
    return `<div class="vr-slider"><span class="vr-slider-k">${esc(t(VOICE_TUNE_LABEL[tn.key]))}</span>
      <input type="range" min="${tn.min}" max="${tn.max}" step="${tn.step}" value="${val}" data-tune="${tn.key}">
      <span class="vr-slider-v" data-tune-v="${tn.key}">${esc(tn.fmt(val))}</span></div>`;
  }).join("");
  const html = `
    <div class="vr-set-group"><h4>${esc(t("ap_voice_section_voice"))}</h4>
      <div class="vr-voice-pick-row">
        <button type="button" class="vr-pick-open" data-pick-voice><span>${esc(provider ? provider + " · " + vLabel : vLabel)}</span>${ICON.chev}</button>
        <button type="button" class="vr-voice-preview" data-voice-preview aria-label="${esc(t("m_ap_voice_preview_btn"))}">▶</button>
      </div>
    </div>
    <div class="vr-set-group"><h4>${esc(t("ap_voice_section_emotion"))}</h4>
      <button type="button" class="vr-pick-open" data-pick-emotion><span>${esc(emotionLabel(v.emotion))}</span>${ICON.chev}</button>
      <p class="vr-set-hint">${esc(t("ap_voice_emotion_hint"))}</p>
    </div>
    <div class="vr-set-group"><h4>${esc(t("ap_voice_advanced"))}</h4><div class="vr-voice-tunes">${tunes}</div></div>
    <div class="vr-set-group">
      <button type="button" class="vr-act-row" data-voice-clone>${ICON.mic}<span class="vr-act-label">${esc(t("voice_clone_btn"))}<em>${esc(t("voice_clone_btn_hint"))}</em></span><span class="vr-act-chev">${ICON.chev}</span></button>
    </div>`;
  return { title: t("m_ap_voice_setup"), html, mount(b) {
    // Resolve the saved voice's friendly name (it stores only a voiceId) ·
    // load the full-catalog label map once, then re-render so the current
    // voice shows its name instead of the raw id.
    if (!voiceLabelMap) ensureVoiceLabels(() => { if (atVoiceView("voicesetup", id)) renderModal(); });
    const pv = b.querySelector("[data-pick-voice]"); if (pv) pv.addEventListener("click", () => pushModal("voicepick"));
    const pe = b.querySelector("[data-pick-emotion]"); if (pe) pe.addEventListener("click", () => pushModal("voiceemotion"));
    const pr = b.querySelector("[data-voice-preview]"); if (pr) pr.addEventListener("click", () => previewVoiceFor(id, pr));
    b.querySelectorAll("[data-tune]").forEach((inp) => {
      const tn = VOICE_TUNES.find((x) => x.key === inp.dataset.tune);
      const out = b.querySelector(`[data-tune-v="${inp.dataset.tune}"]`);
      inp.addEventListener("input", () => { if (out && tn) out.textContent = tn.fmt(parseFloat(inp.value)); });
      inp.addEventListener("change", () => setVoiceFor(id, { ...(voiceFor(id) || {}), [inp.dataset.tune]: parseFloat(inp.value) }));
    });
    const cl = b.querySelector("[data-voice-clone]"); if (cl) cl.addEventListener("click", () => openVoiceClone(id, name));
  } };
}

/* ── Voice picker · the provider catalog (paged). ── */
function renderVoicePicker() {
  const id = profileAgentId;
  const cur = voiceFor(id) || {};
  if (!voicePager.initialised) {
    return { title: t("ap_voice_section_voice"), html: `<div class="vr-cred-empty">${esc(t("m_voice_loading"))}</div>`, mount() {
      ensureVoices(() => { if (atVoiceView("voicepick", id)) renderModal(); });
    } };
  }
  if (voicePager.error) {
    return { title: t("ap_voice_section_voice"), html: `<div class="vr-cred-empty">${esc(voicePager.error.message || t("m_voice_none"))}</div>` };
  }
  const rows = voicePager.voices.map((vo) => {
    const active = vo.voiceId === cur.voiceId && (!cur.provider || vo.provider === cur.provider);
    const lbl = (vo.label && vo.label !== vo.voiceId) ? vo.label : vo.voiceId;
    const cloned = vo.language === "clone" || vo.language === "cloned" || vo.language === "professional";
    const meta = [vo.provider, cloned ? t("m_voice_cloned") : (vo.language || "")].filter(Boolean).join(" · ");
    return `<div class="vr-cred-row${active ? " is-active" : ""}" data-voice-pick="${esc(vo.provider + "|" + (vo.model || "") + "|" + (vo.voiceId || ""))}">
      <button type="button" class="vr-cred-pick" data-pick aria-label="${active ? "Active" : "Select"}">${active ? ICON.check : ""}</button>
      <span class="vr-cred-body"><span class="vr-cred-name">${esc(lbl)}</span><span class="vr-cred-meta">${esc(meta)}</span></span>
    </div>`;
  }).join("");
  const more = voicePager.hasMore
    ? `<button type="button" class="vr-cred-add" data-voice-more ${voicePager.loading ? "disabled" : ""}>${ICON.plus}<span>${voicePager.loading ? esc(t("m_voice_loading")) : esc(t("m_voice_more"))}</span></button>`
    : "";
  const html = `<div class="vr-set-group"><h4>${esc(t("ap_voice_section_voice"))}</h4>
    <div class="vr-set-list">${rows || `<div class="vr-cred-empty">${esc(t("m_voice_none"))}</div>`}</div>${more}</div>`;
  return { title: t("ap_voice_section_voice"), html, mount(b) {
    b.querySelectorAll("[data-voice-pick]").forEach((row) => row.addEventListener("click", () => {
      const parts = row.dataset.voicePick.split("|");
      const c = voiceFor(id) || {};
      setVoiceFor(id, { ...c, provider: parts[0], model: parts[1], voiceId: parts[2], label: undefined });
      popModal();
    }));
    const mb = b.querySelector("[data-voice-more]");
    if (mb) mb.addEventListener("click", () => { loadVoicePage(() => { if (atVoiceView("voicepick", id)) renderModal(); }); renderModal(); });
  } };
}

/* ── Emotion picker. ── */
function renderVoiceEmotion() {
  const id = profileAgentId;
  const cur = voiceFor(id) || {};
  const curE = cur.emotion == null ? "" : String(cur.emotion);
  const rows = VOICE_EMOTIONS.map((slug) => {
    const active = slug === curE;
    return `<div class="vr-cred-row${active ? " is-active" : ""}" data-emotion="${esc(slug)}">
      <button type="button" class="vr-cred-pick" data-pick>${active ? ICON.check : ""}</button>
      <span class="vr-cred-body"><span class="vr-cred-name">${esc(emotionLabel(slug))}</span></span>
    </div>`;
  }).join("");
  const html = `<div class="vr-set-group"><h4>${esc(t("ap_voice_section_emotion"))}</h4><div class="vr-set-list">${rows}</div><p class="vr-set-hint">${esc(t("ap_voice_emotion_hint"))}</p></div>`;
  return { title: t("ap_voice_section_emotion"), html, mount(b) {
    b.querySelectorAll("[data-emotion]").forEach((row) => row.addEventListener("click", () => {
      setVoiceFor(id, { ...(voiceFor(id) || {}), emotion: row.dataset.emotion });
      popModal();
    }));
  } };
}

/* ════════════════════════════════════════════════════════════════
   New director · describe → (Signal / Full-persona) generate with an
   animation → pre-filled Director form to confirm or edit. Mirrors the
   desktop agent composer (app.js): a quick "Signal" draft vs the deep
   "Full persona" 7-phase build. Offline · the spec is synthesised from
   the description by heuristic (no AI call). agentDraft.step drives
   which surface renders: "describe" | "generating" | "form".
   ════════════════════════════════════════════════════════════════ */
function loadAgentMode() { try { return localStorage.getItem("pb_proto_agentmode") === "full" ? "full" : "signal"; } catch (_) { return "signal"; } }
function saveAgentMode(m) { try { localStorage.setItem("pb_proto_agentmode", m === "full" ? "full" : "signal"); } catch (_) { /* */ } }

const SIGNAL_PHASES = ["Drafting the profile", "Naming the director", "Writing the bio", "Composing the instruction", "Picking the model voice", "Polishing"];
const FULL_PHASES = ["Persona spec · v1", "Researching context", "Persona spec · refined", "Behavioural rules", "Few-shot examples", "Reflection checklist", "Eval set + report"];
/* Full-persona build · each phase expands to show its sub-tasks ticking
   off; the research phase streams a live "sources distilled" feed. This
   is the gamified surface that sets Full apart from Signal's quick bar. */
const FULL_PHASE_DETAIL = [
  { name: "Persona spec · v1",        subs: ["seeding archetype", "mapping influences", "naming opposed traditions"] },
  { name: "Researching context",      subs: ["planning dimensions", "scanning sources", "distilling evidence"], research: true },
  { name: "Persona spec · refined",   subs: ["folding research in", "sharpening the lens"] },
  { name: "Behavioural rules",        subs: ["deriving constraints", "ranking by load"] },
  { name: "Few-shot examples",        subs: ["drafting exchanges", "checking the voice"] },
  { name: "Reflection checklist",     subs: ["self-critique pass", "naming failure modes"] },
  { name: "Eval set + report",        subs: ["scoring rubric", "compiling build report"] },
];
const RESEARCH_SOURCES = ["base-rate priors", "category history · 1998–2024", "adjacent failure cases", "expert heuristics", "strongest counter-arguments", "primary definitions"];

/* Heuristic spec synthesis · maps description keywords to a role
   archetype (preset ability profile), picks a name deterministically,
   and templates a bio + instruction. Full mode writes a richer brief. */
const ROLE_ARCHETYPES = [
  { kw: ["data", "number", "metric", "quant", "statist", "evidence"],        role: "Quant",             bio: "Reasons from the numbers — distrusts any claim a dataset can't back.",      ab: { Dissent: 6, Rigor: 9, Empathy: 3, Pattern: 8, Narrative: 4, Decisiveness: 6 } },
  { kw: ["user", "customer", "empath", "human", "experience", "ux"],          role: "User Advocate",     bio: "Argues from one real user at the moment of friction.",                       ab: { Dissent: 5, Rigor: 5, Empathy: 9, Pattern: 4, Narrative: 8, Decisiveness: 5 } },
  { kw: ["risk", "legal", "complian", "safety", "threat", "downside"],         role: "Risk Officer",      bio: "Names the failure mode before anyone celebrates the upside.",                ab: { Dissent: 8, Rigor: 8, Empathy: 4, Pattern: 6, Narrative: 4, Decisiveness: 6 } },
  { kw: ["design", "product", "craft", "taste", "aesthetic"],                  role: "Product Lead",      bio: "Holds the bar on craft and what actually ships, not just what's possible.",  ab: { Dissent: 5, Rigor: 6, Empathy: 7, Pattern: 6, Narrative: 7, Decisiveness: 7 } },
  { kw: ["ethic", "moral", "fair", "justice", "value"],                        role: "Ethicist",          bio: "Asks who bears the cost and whether the trade is fair.",                     ab: { Dissent: 7, Rigor: 7, Empathy: 8, Pattern: 5, Narrative: 6, Decisiveness: 4 } },
  { kw: ["market", "growth", "revenue", "business", "gtm", "sales", "pricing"], role: "Growth Strategist", bio: "Reads every move against the market and the money.",                         ab: { Dissent: 5, Rigor: 6, Empathy: 4, Pattern: 7, Narrative: 7, Decisiveness: 8 } },
  { kw: ["skeptic", "challenge", "devil", "contrar", "debate", "question"],     role: "Contrarian",        bio: "Distrusts the obvious; surfaces the assumption everyone skipped.",            ab: { Dissent: 9, Rigor: 8, Empathy: 4, Pattern: 5, Narrative: 5, Decisiveness: 5 } },
  { kw: ["future", "long", "strateg", "vision", "horizon"],                     role: "Strategist",        bio: "Plays the move three-to-five years out; names the second-order cost.",       ab: { Dissent: 5, Rigor: 7, Empathy: 4, Pattern: 8, Narrative: 6, Decisiveness: 6 } },
];
const NAME_POOL = ["Atlas", "Vega", "Sable", "Orin", "Lyra", "Cassian", "Mira", "Dorian", "Quill", "Nova", "Reyes", "Iris", "Soren", "Wren", "Cyrus"];
function hashStr(s) { let h = 0; const str = String(s || "x"); for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; } return Math.abs(h); }
function synthesizeSpec(desc, mode) {
  const d = (desc || "").toLowerCase();
  const arch = ROLE_ARCHETYPES.find((a) => a.kw.some((k) => d.includes(k)))
    || { role: "Director", bio: "Brings an independent, rigorous lens to the question.", ab: { Dissent: 6, Rigor: 7, Empathy: 5, Pattern: 6, Narrative: 5, Decisiveness: 6 } };
  const name = NAME_POOL[hashStr(desc) % NAME_POOL.length];
  const firstLine = (desc || "").trim().split("\n")[0].slice(0, 140);
  const obj = firstLine || arch.bio;
  const instruction = mode === "full"
    ? `Role · ${arch.role}.\nObjective · ${obj}\nMethod · interrogate the question through the ${arch.role.toLowerCase()} lens; cite the load-bearing claim; build on others before you dissent.\nVoice · direct, specific, no filler.\nBoundaries · refuse hand-wavy consensus; name what the room skipped.`
    : `Role · ${arch.role}.\nObjective · ${obj}\nVoice · direct and specific.`;
  return { name, role: arch.role, bio: arch.bio, instruction, ab: { ...arch.ab }, modelId: mode === "full" ? "opus-4-7" : "sonnet-4-6", seed: (window.Avatar3DSnap ? window.Avatar3DSnap.randomSeed() : null) };
}
function abAxesFromCaps(ab) {
  const out = {}; for (const a of RADAR_AXES) out[a] = 5;
  if (ab) for (const [k, v] of Object.entries(ab)) { const ax = RADAR_FROM_AB[k]; if (ax) out[ax] = v; }
  return out;
}

function newAgentInitials(name) {
  return ((name || "").trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("") || "N").toUpperCase();
}
function paintDraftAvatar(b) {
  const host = b.querySelector(".vr-na-face");
  const snap = window.Avatar3DSnap;
  if (!host || !snap || !agentDraft || !agentDraft.seed) return;
  // hydrateImg paints into an <img> (sets src) or replaces a <span>
  // placeholder with a rendered <img>, preserving its className — so
  // `.vr-na-face` keeps matching either node across regenerates.
  snap.hydrateImg(host, agentDraft.seed);
}
function renderNewAgent() {
  if (!agentDraft) agentDraft = { step: "describe", mode: loadAgentMode(), desc: loadDraft("agent_desc"), name: "", role: "", bio: "", instruction: "", modelId: "sonnet-4-6", seed: null, ab: null };
  if (agentDraft.step === "generating") return renderNAGenerating();
  if (agentDraft.step === "form") return renderNAForm();
  return renderNADescribe();
}

/* Step 1 · describe + mode toggle. */
function renderNADescribe() {
  const mode = agentDraft.mode || "signal";
  const descOk = (agentDraft.desc || "").trim().length >= 4;
  const modeTile = (id, title, deck) => `<button type="button" class="vr-na-mode${mode === id ? " is-on" : ""}" data-na-mode="${id}">
    <span class="vr-na-mode-t">${id === "full" ? `<span class="vr-na-spark">${ICON.spark}</span>` : ""}${title}</span>
    <span class="vr-na-mode-d">${deck}</span></button>`;
  const html = `
    <div class="vr-set-group"><h4>${esc(t("m_na_desc_label"))}</h4><textarea class="vr-input vr-textarea tall" data-na-desc placeholder="${esc(t("m_na_desc_ph"))}">${esc(agentDraft.desc || "")}</textarea></div>
    <div class="vr-set-group"><h4>${esc(t("m_na_build_mode"))}</h4><div class="vr-na-modes">
      ${modeTile("signal", esc(t("m_na_signal")), esc(t("m_na_signal_deck")))}
      ${modeTile("full", esc(t("m_na_full")), esc(t("m_na_full_deck")))}
    </div></div>
    <button type="button" class="vr-convene${descOk ? "" : " is-dim"}" data-na-generate>${esc(mode === "full" ? t("m_na_build_full") : t("m_na_generate"))}</button>
    <button type="button" class="vr-na-manual" data-na-manual>${esc(t("m_na_manual"))}</button>`;
  return { title: t("m_na_title"), html, mount(b) {
    const ta = b.querySelector("[data-na-desc]");
    ta.addEventListener("input", (e) => {
      agentDraft.desc = e.target.value;
      saveDraft("agent_desc", e.target.value);
      const g = b.querySelector("[data-na-generate]"); if (g) g.classList.toggle("is-dim", e.target.value.trim().length < 4);
    });
    b.querySelectorAll("[data-na-mode]").forEach((btn) => btn.addEventListener("click", () => {
      agentDraft.mode = btn.dataset.naMode; saveAgentMode(agentDraft.mode); renderModal();
    }));
    b.querySelector("[data-na-generate]").addEventListener("click", () => {
      if ((agentDraft.desc || "").trim().length < 4) { toast(t("m_toast_describe_first")); return; }
      startAgentGen();
    });
    b.querySelector("[data-na-manual]").addEventListener("click", () => {
      agentDraft.step = "form"; agentDraft.ab = null;
      if (!agentDraft.seed && window.Avatar3DSnap) agentDraft.seed = window.Avatar3DSnap.randomSeed();
      renderModal();
    });
  } };
}

/* Step 2 · generation animation · advances phases on a clock, then
   synthesises the spec and flips to the form. */
/* ── Real generation · Signal = one /generate-spec call behind the quick
   animation; Full = a /generate-persona job whose SSE drives the 7-phase
   timeline. The offline `synthesizeSpec` heuristic is retired. ───────── */
function startAgentGen() {
  if (genTimer) { clearInterval(genTimer); genTimer = null; }
  agentDraft.genStart = Date.now();
  agentDraft.genError = null;
  agentDraft.pct = 0; agentDraft.curPhase = 1; agentDraft.donePhases = []; agentDraft.feed = []; agentDraft.phaseLabel = "";
  agentDraft.step = "generating";
  renderModal();
  if (agentDraft.mode === "full") startPersonaGen(); else startSignalGen();
}
function renderNAGenerating() {
  if (agentDraft.genError) return renderGenError();
  return agentDraft.mode === "full" ? renderNAGeneratingFull() : renderNAGeneratingSignal();
}
function genActive() { return !!agentDraft && agentDraft.step === "generating"; }
/* Map a spec's lowercase ability axes → the radar's capitalised keys. */
function abFromLowercase(ability) {
  const out = {};
  for (const [cap, low] of Object.entries(RADAR_FROM_AB)) { const v = ability && ability[low]; out[cap] = Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : 5; }
  return out;
}
/* Inverse · the radar's capitalised keys → lowercase axes for the API. */
function abToLowercase(ab) {
  const out = {};
  for (const [cap, low] of Object.entries(RADAR_FROM_AB)) { const v = ab && ab[cap]; if (Number.isFinite(v)) out[low] = v; }
  return Object.keys(out).length ? out : null;
}
/* Signal-spec result → confirm/edit form. */
function applySpecToDraft(spec) {
  if (genTimer) { clearInterval(genTimer); genTimer = null; }
  Object.assign(agentDraft, {
    name: spec.name || agentDraft.name || "",
    role: spec.roleTag || spec.role || "Director",
    bio: spec.bio || "",
    instruction: spec.instruction || "",
    modelId: (typeof spec.modelV === "string" && spec.modelV) ? spec.modelV : (agentDraft.modelId || "sonnet-4-6"),
    coverQuote: spec.coverQuote || "",
    ab: abFromLowercase(spec.ability),
    seed: agentDraft.seed || (window.Avatar3DSnap ? window.Avatar3DSnap.randomSeed() : null),
    jobId: null,          // Signal saves via POST /api/agents
    step: "form",
  });
  if (agentDraft.seed && window.Avatar3DSnap) { try { window.Avatar3DSnap.generate(agentDraft.seed); } catch (_) { /* */ } }
  renderModal();
}
function startSignalGen() {
  api.generateSpec(agentDraft.desc, false).then((res) => {
    if (!genActive()) return;
    const spec = res && res.spec;
    if (!spec) { agentDraft.genError = t("m_na_gen_fail"); renderModal(); return; }
    applySpecToDraft(spec);
  }).catch((e) => { if (!genActive()) return; agentDraft.genError = (e && e.message) || t("m_na_gen_fail"); renderModal(); });
}
let personaES = null;
function stopPersonaES() { if (personaES) { try { personaES.close(); } catch (_) { /* */ } personaES = null; } }
function startPersonaGen() {
  const locale = (window.I18n && I18n.getLocale && I18n.getLocale()) || "en";
  api.generatePersona(agentDraft.desc, locale).then((res) => {
    if (!genActive()) return;
    const jobId = res && res.jobId;
    if (!jobId) { agentDraft.genError = t("m_na_gen_fail"); renderModal(); return; }
    agentDraft.jobId = jobId;
    openPersonaSSE(jobId);
  }).catch((e) => { if (!genActive()) return; agentDraft.genError = (e && e.message) || t("m_na_gen_fail"); renderModal(); });
}
function openPersonaSSE(jobId) {
  stopPersonaES();
  personaES = openPersonaStream(jobId, {
    "hello": (d) => { if (!d) return; if (d.progressPct != null) agentDraft.pct = d.progressPct; if (d.currentPhase) agentDraft.curPhase = d.currentPhase; paintPersonaProgress(); },
    "persona-phase-start": (d) => { if (!d) return; agentDraft.curPhase = d.phase; if (d.label) agentDraft.phaseLabel = d.label; paintPersonaProgress(); },
    "persona-phase-progress": (d) => { if (!d) return; if (d.progressPct != null) agentDraft.pct = d.progressPct; if (d.detail) agentDraft.phaseLabel = d.detail; paintPersonaProgress(); },
    "persona-phase-end": (d) => { if (!d) return; if (d.progressPct != null) agentDraft.pct = d.progressPct; if (!agentDraft.donePhases.includes(d.phase)) agentDraft.donePhases.push(d.phase); paintPersonaProgress(); },
    "persona-dimension-plan": (d) => { if (d && Array.isArray(d.dimensions)) { d.dimensions.forEach((x) => agentDraft.feed.push(x.dimension || x.query || "")); trimFeed(); paintPersonaProgress(); } },
    "persona-search-round": (d) => { if (d && d.query) { agentDraft.feed.push(d.query); trimFeed(); paintPersonaProgress(); } },
    "persona-final": (d) => { stopPersonaES(); if (genActive()) applyPersonaFinal(d); },
    "persona-error": (d) => { stopPersonaES(); if (genActive()) { agentDraft.genError = (d && d.message) || t("m_na_gen_fail"); renderModal(); } },
    "persona-aborted": () => { stopPersonaES(); },
    error: () => { /* EventSource auto-reconnects; terminal events close it */ },
  });
}
function trimFeed() { while (agentDraft.feed.length > 8) agentDraft.feed.shift(); }
function applyPersonaFinal(d) {
  if (genTimer) { clearInterval(genTimer); genTimer = null; }
  if (!d) { agentDraft.genError = t("m_na_gen_fail"); renderModal(); return; }
  Object.assign(agentDraft, {
    name: d.guessName || agentDraft.name || "",
    role: d.guessRoleTag || "director",
    bio: d.bio || "",
    instruction: d.instruction || "",
    coverQuote: d.coverQuote || "",
    ab: abFromLowercase(d.ability),
    modelId: agentDraft.modelId || "opus-4-7",
    seed: agentDraft.seed || (window.Avatar3DSnap ? window.Avatar3DSnap.randomSeed() : null),
    // jobId retained → createAgent() finalises via /generate-persona/:jobId/save
    step: "form",
  });
  if (agentDraft.seed && window.Avatar3DSnap) { try { window.Avatar3DSnap.generate(agentDraft.seed); } catch (_) { /* */ } }
  renderModal();
}
/* Targeted DOM patch of the Full timeline (avoids full re-render churn
   during the frequent search-round events · keeps the dial smooth). */
function paintPersonaProgress() {
  if (!genActive() || agentDraft.mode !== "full") return;
  const root = $("[data-modal-body]"); if (!root) return;
  const C = 326.7;
  const pct = Math.max(0, Math.min(100, agentDraft.pct || 0));
  const dial = root.querySelector("[data-gen-dial]"); if (dial) dial.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(1);
  const pctEl = root.querySelector("[data-gen-pct]"); if (pctEl) pctEl.textContent = Math.round(pct);
  const n = FULL_PHASE_DETAIL.length;
  const cur = agentDraft.curPhase || 1;
  const pno = root.querySelector("[data-gen-phaseno]"); if (pno) pno.textContent = `phase ${Math.min(n, cur)} / ${n}`;
  const lbl = root.querySelector("[data-gen-elabel]"); if (lbl && agentDraft.phaseLabel) lbl.textContent = agentDraft.phaseLabel;
  root.querySelectorAll("[data-gen-phase]").forEach((li, i) => {
    const phaseNum = i + 1;
    const done = (agentDraft.donePhases || []).includes(phaseNum) || phaseNum < cur;
    const active = phaseNum === cur && !done;
    li.classList.toggle("is-done", done);
    li.classList.toggle("is-active", active);
    const node = li.querySelector(`[data-step-state="${i}"]`); if (node) node.innerHTML = done ? ICON.check : "";
  });
  const feed = root.querySelector("[data-feed]");
  if (feed) feed.innerHTML = (agentDraft.feed || []).map((q) => `<div class="vr-gen-feedline">${esc(q)}</div>`).join("");
}
/* Generation failed · message + retry / manual fallbacks. */
function renderGenError() {
  const html = `<div class="vr-gen vr-gen-err">
    <div class="vr-gen-title">${esc(t("m_na_gen_failed"))}</div>
    <p class="vr-set-hint">${esc(agentDraft.genError || t("m_na_gen_fail"))}</p>
    <button type="button" class="vr-convene" data-gen-retry>${esc(t("m_na_gen_retry"))}</button>
    <button type="button" class="vr-na-manual" data-gen-manual>${esc(t("m_na_manual"))}</button>
  </div>`;
  return { title: t("m_na_title"), html, mount(b) {
    b.querySelector("[data-gen-retry]").addEventListener("click", () => { agentDraft.genError = null; startAgentGen(); });
    b.querySelector("[data-gen-manual]").addEventListener("click", () => { agentDraft.genError = null; agentDraft.step = "form"; agentDraft.ab = null; if (!agentDraft.seed && window.Avatar3DSnap) agentDraft.seed = window.Avatar3DSnap.randomSeed(); renderModal(); });
  } };
}

/* Signal · the quick, lightweight bar + phase list. */
function renderNAGeneratingSignal() {
  const phases = SIGNAL_PHASES;
  const rows = phases.map((p, i) => `<li class="vr-gen-phase" data-gen-phase="${i}"><span class="vr-gen-dot"></span><span class="vr-gen-ptext">${esc(p)}</span></li>`).join("");
  const html = `
    <div class="vr-gen">
      <div class="vr-gen-orb"><span class="vr-gen-ring"></span><span class="vr-gen-core">${ICON.model}</span></div>
      <div class="vr-gen-title" data-gen-title>${esc(phases[0])}</div>
      <div class="vr-gen-sub" data-gen-sub>Signal build · step 1 of ${phases.length}</div>
      <div class="vr-gen-bar"><i data-gen-bar style="width:0%"></i></div>
      <ol class="vr-gen-phases">${rows}</ol>
    </div>`;
  return { title: "Generating", html, mount(b) {
    if (genTimer) { clearInterval(genTimer); genTimer = null; }
    // Cosmetic only · eases toward 95% and holds. The REAL /generate-spec
    // promise (startSignalGen) flips to the form when it resolves — this
    // clock never calls finish, so a slow model just keeps the bar warm.
    const tick = () => {
      const el = Date.now() - (agentDraft.genStart || Date.now());
      const pct = Math.min(95, Math.round(100 * (1 - Math.exp(-el / 4200))));
      const idx = Math.min(phases.length - 1, Math.floor((pct / 100) * phases.length));
      const bar = b.querySelector("[data-gen-bar]"); if (bar) bar.style.width = pct + "%";
      b.querySelectorAll("[data-gen-phase]").forEach((li, i) => {
        li.classList.toggle("is-done", i < idx);
        li.classList.toggle("is-active", i === idx);
      });
      const title = b.querySelector("[data-gen-title]"); if (title) title.textContent = phases[idx];
      const sub = b.querySelector("[data-gen-sub]"); if (sub) sub.textContent = `Signal build · step ${idx + 1} of ${phases.length}`;
    };
    genTimer = setInterval(tick, 140);
    tick();
  } };
}

/* Full persona · refined deep build · a gold circular progress dial
 *  (percent centred) over a vertical timeline. The active phase expands
 *  to tick off its sub-tasks; the research phase streams mono source
 *  lines. Distinct from Signal's quick bar. */
function renderNAGeneratingFull() {
  const C = 326.7; // 2π·52 · dial circumference
  const steps = FULL_PHASE_DETAIL.map((p, i) => `
    <li class="vr-gen-tl-step" data-gen-phase="${i}">
      <span class="vr-gen-tl-node" data-step-state="${i}"></span>
      <div class="vr-gen-tl-body">
        <div class="vr-gen-tl-name">${esc(p.name)}</div>
        <div class="vr-gen-tl-expand">
          <div class="vr-gen-tl-subs">${p.subs.map((s, j) => `<div class="vr-gen-tl-sub" data-sub="${i}-${j}">${esc(s)}</div>`).join("")}</div>
          ${p.research ? `<div class="vr-gen-feed" data-feed></div>` : ""}
        </div>
      </div>
    </li>`).join("");
  const html = `
    <div class="vr-gen vr-gen-full">
      <div class="vr-gen-dial">
        <svg class="vr-gen-dial-svg" viewBox="0 0 120 120" aria-hidden="true">
          <circle class="vr-gen-dial-track" cx="60" cy="60" r="52"/>
          <circle class="vr-gen-dial-fill" data-gen-dial cx="60" cy="60" r="52"/>
        </svg>
        <div class="vr-gen-dial-c"><span class="vr-gen-pct"><span data-gen-pct>0</span><i>%</i></span><span class="vr-gen-dial-sub" data-gen-phaseno>phase 1 / ${FULL_PHASE_DETAIL.length}</span></div>
      </div>
      <div class="vr-gen-elapsed"><span data-gen-elapsed>0.0s</span> · <span data-gen-elabel>${esc(t("m_na_full_running"))}</span></div>
      <ol class="vr-gen-tl">${steps}</ol>
    </div>`;
  return { title: "Building persona", html, mount(b) {
    if (genTimer) { clearInterval(genTimer); genTimer = null; }
    // Real-data driven · the dial / phases / feed are painted by
    // paintPersonaProgress() from live SSE events. This ticker only keeps
    // the elapsed clock moving so the build feels alive between events.
    genTimer = setInterval(() => {
      const el = Date.now() - (agentDraft.genStart || Date.now());
      const elapsed = b.querySelector("[data-gen-elapsed]"); if (elapsed) elapsed.textContent = (el / 1000).toFixed(1) + "s";
    }, 200);
    paintPersonaProgress();
  } };
}

/* Step 3 · pre-filled Director form · confirm or edit, then create. */
function renderNAForm() {
  const generated = !!agentDraft.ab;
  const model = modelCatalog().find((mo) => mo.id === agentDraft.modelId) || modelCatalog()[0] || { name: agentDraft.modelId || "—", deck: "" };
  const handle = deriveHandle(agentDraft.name);
  const canCreate = !!(agentDraft.name || "").trim();
  const radar = generated ? `<div class="vr-radar-wrap vr-na-radar">${renderRadarSvg(abAxesFromCaps(agentDraft.ab))}</div>` : "";
  const head = generated
    ? `<div class="vr-na-kicker"><span>${esc(agentDraft.mode === "full" ? t("m_na_kicker_full") : t("m_na_kicker_signal"))}</span><button type="button" class="vr-na-startover" data-na-startover>${esc(t("m_na_startover"))}</button></div>`
    : "";
  const html = `
    ${head}
    <div class="vr-na-avatar">
      <div class="vr-na-portrait"><span class="vr-na-face">${newAgentInitials(agentDraft.name)}</span></div>
      <button type="button" class="vr-na-regen" data-na-regen>${ICON.regen}<span>${esc(t("m_na_regenerate"))}</span></button>
    </div>
    ${radar}
    <button type="button" class="vr-act-row" data-pick-amodel>${ICON.model}<span class="vr-act-label">${esc(model.name)}<em>${esc(model.deck)}</em></span><span class="vr-act-chev">${ICON.chev}</span></button>
    <div class="vr-set-group"><h4>${esc(t("m_na_name"))} <span class="vr-na-count" data-count-name>${(agentDraft.name || "").length}/32</span></h4>
      <input class="vr-input" data-aname maxlength="32" placeholder="${esc(t("m_na_name"))}" value="${esc(agentDraft.name)}">
      <p class="vr-set-hint">${esc(t("m_na_handle"))} <span class="vr-na-handle">${esc(handle)}</span></p></div>
    <div class="vr-set-group"><h4>${esc(t("m_na_role"))}</h4><input class="vr-input" data-arole maxlength="24" placeholder="${esc(t("m_na_role_ph"))}" value="${esc(agentDraft.role)}"></div>
    <div class="vr-set-group"><h4>${esc(t("m_na_intro"))} <span class="vr-na-count" data-count-bio>${(agentDraft.bio || "").length}/280</span></h4>
      <textarea class="vr-input vr-textarea" data-abio maxlength="280" placeholder="${esc(t("m_na_intro_ph"))}">${esc(agentDraft.bio)}</textarea></div>
    <div class="vr-set-group"><h4>${esc(t("m_na_instruction"))}</h4>
      <textarea class="vr-input vr-textarea tall" data-ainstr placeholder="${esc(t("m_na_instr_ph"))}">${esc(agentDraft.instruction)}</textarea>
      <p class="vr-set-hint">${esc(t("m_na_instr_hint"))}</p></div>
    <button type="button" class="vr-convene${canCreate ? "" : " is-dim"}" data-create-agent>${esc(t("m_na_create"))}</button>`;
  return { title: t("m_na_title"), html, mount(b) {
    paintDraftAvatar(b);
    const so = b.querySelector("[data-na-startover]");
    if (so) so.addEventListener("click", () => { agentDraft.step = "describe"; agentDraft.ab = null; renderModal(); });
    const regen = b.querySelector("[data-na-regen]");
    if (regen) regen.addEventListener("click", () => {
      if (!window.Avatar3DSnap) { toast(t("m_toast_webgl")); return; }
      agentDraft.seed = window.Avatar3DSnap.randomSeed();
      paintDraftAvatar(b);
    });
    const pm = b.querySelector("[data-pick-amodel]");
    if (pm) pm.addEventListener("click", () => pushModal("amodel"));
    const nameEl = b.querySelector("[data-aname]");
    nameEl.addEventListener("input", (e) => {
      agentDraft.name = e.target.value;
      const h = b.querySelector(".vr-na-handle"); if (h) h.textContent = deriveHandle(agentDraft.name);
      const c = b.querySelector("[data-count-name]"); if (c) c.textContent = `${agentDraft.name.length}/32`;
      const cb = b.querySelector("[data-create-agent]"); if (cb) cb.classList.toggle("is-dim", !agentDraft.name.trim());
    });
    b.querySelector("[data-arole]").addEventListener("input", (e) => { agentDraft.role = e.target.value; });
    const bioEl = b.querySelector("[data-abio]");
    bioEl.addEventListener("input", (e) => {
      agentDraft.bio = e.target.value;
      const c = b.querySelector("[data-count-bio]"); if (c) c.textContent = `${agentDraft.bio.length}/280`;
    });
    b.querySelector("[data-ainstr]").addEventListener("input", (e) => { agentDraft.instruction = e.target.value; });
    b.querySelector("[data-create-agent]").addEventListener("click", createAgent);
  } };
}
function renderNewAgentModel() {
  const cur = (agentDraft && agentDraft.modelId) || "sonnet-4-6";
  const rows = modelCatalog().map((mo) => {
    const active = mo.id === cur;
    return `<div class="vr-cred-row${active ? " is-active" : ""}" data-amodel="${mo.id}">
      <button type="button" class="vr-cred-pick" aria-label="${active ? "Active" : "Select"}">${active ? ICON.check : ""}</button>
      <span class="vr-cred-body"><span class="vr-cred-name">${esc(mo.name)}</span><span class="vr-cred-meta">${esc(mo.deck)}</span></span>
    </div>`;
  }).join("");
  return { title: t("m_model_title"), html: `<div class="vr-set-group"><h4>${esc(t("m_model_director"))}</h4><div class="vr-set-list">${rows}</div></div>
    <p class="vr-set-hint">${esc(t("m_model_director_hint"))}</p>`, mount(b) {
    b.querySelectorAll("[data-amodel]").forEach((row) => row.addEventListener("click", () => {
      if (agentDraft) agentDraft.modelId = row.dataset.amodel;
      popModal();
    }));
  } };
}
/* Install a backend-created agent into the live roster (mirrors metaFromAgent). */
function installCreatedAgent(a) {
  if (!a || !a.id) return;
  const rec = { id: a.id, name: a.name, avatarPath: a.avatarPath || "", roleKind: a.roleKind === "moderator" ? "chair" : "director", avatar3d: a.avatar3d || null };
  if (!CAST.find((c) => c.id === a.id)) CAST.push(rec);
  if (rec.roleKind === "director" && !ROSTER.find((r) => r.id === a.id)) ROSTER.push({ ...rec, active: false });
  AGENTS_META[a.id] = metaFromAgent(a);
  if (a.modelV) modelSel[a.id] = a.modelV;
}
async function createAgent() {
  const name = (agentDraft.name || "").trim();
  if (name.length < 2) { toast(t("m_toast_name_director")); return; }
  const bio = (agentDraft.bio || "").trim();
  const instruction = (agentDraft.instruction || "").trim();
  const roleTag = (agentDraft.role || "").trim();
  // Build the avatar from the seed · portrait data-URL + 3D config.
  let avatar3d = null, avatarPath = "";
  if (agentDraft.seed) {
    try { const av = await import("/avatar-3d.js"); avatar3d = av.deriveDefaultAvatarConfig(agentDraft.seed); } catch (_) { /* */ }
    if (window.Avatar3DSnap) {
      avatarPath = window.Avatar3DSnap.cacheGet(agentDraft.seed) || "";
      if (!avatarPath) { try { avatarPath = (await window.Avatar3DSnap.generate(agentDraft.seed)) || ""; } catch (_) { /* */ } }
    }
  }
  const btn = document.querySelector("[data-create-agent]");
  if (btn) { btn.classList.add("is-dim"); btn.textContent = t("m_na_creating"); }
  let created;
  try {
    if (agentDraft.jobId) {
      // Full persona · finalise the build into a saved agent.
      created = await api.savePersona(agentDraft.jobId, {
        name, bio, instruction,
        roleTag: roleTag || "director",
        modelV: agentDraft.modelId || "opus-4-7",
        coverQuote: agentDraft.coverQuote || "",
        avatarPath: avatarPath || undefined,
      });
    } else {
      // Signal / manual · create directly (bio must be ≥ 8 chars server-side).
      if (bio.length < 8) { if (btn) { btn.classList.remove("is-dim"); btn.textContent = t("m_na_create"); } toast(t("m_na_bio_short")); return; }
      created = await api.createAgent({
        name, bio, instruction,
        modelV: agentDraft.modelId || "sonnet-4-6",
        roleTag: roleTag || undefined,
        ability: abToLowercase(agentDraft.ab) || undefined,
        coverQuote: agentDraft.coverQuote || undefined,
        avatarPath: avatarPath || undefined,
        avatar3d: avatar3d || undefined,
      });
    }
  } catch (e) {
    if (btn) { btn.classList.remove("is-dim"); btn.textContent = t("m_na_create"); }
    toast((e && e.message) || t("m_room_create_fail")); return;
  }
  installCreatedAgent(created);
  agentDraft = null;
  clearDraft("agent_desc");
  closeModal();
  if (homeTab === "directors") renderDirectors();
  toast(t("m_toast_director_added", { name: (created && created.name) || name }));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
