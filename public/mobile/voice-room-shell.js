/* ═══════════════════════════════════════════════════════════════════
   voice-room-shell.js · mobile-native shell + offline driver for the
   voice-room prototype. Mounts the adapted 3D engine
   (voice-3d-mobile.js → window.MobileVoiceStage3D), then runs a scripted
   discussion (session-script.js), sequencing thinking → speaking → next
   and feeding the 3D stage, the caption band, the cast rail and the
   transcript sheet. No backend.
   ═══════════════════════════════════════════════════════════════════ */
import { CAST, SESSION } from "/mobile/session-script.js";

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
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3l1.5 1.5-2 2 2 2-2.5 2.5-2-2-2.6 2.6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>',
  model: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>',
  regen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6"/><rect x="12" y="6" width="3" height="11"/><rect x="17" y="13" width="3" height="4"/></svg>',
  rooms: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4 21 12 3.4 3.6 3 10l12 2-12 2z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  bubble: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>',
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
  wireTabs(); wireDock(); wireSheet(); wireFocusSync(); wireMenu(); wireNav(); wireComposer();

  loadCreds();
  loadModels();
  loadRules();
  loadMem();
  renderRooms();
  showView("home");
}

/* ════ Enter / leave a room ════ */
function enterRoom(room) {
  currentRoom = room;
  roomMode = room.tone; roomIntensity = room.intensity; roomStatus = room.status;
  roomDelivery = room.delivery || "voice";
  lastSpeakerId = null; lastSpeakerState = null; pendingUserBubble = null;   // fresh scene
  for (const r of ROSTER) r.active = room.directorIds.includes(r.id);

  showView("room");
  document.body.classList.toggle("is-text", roomDelivery === "text");
  document.body.classList.remove("is-composing");
  document.body.classList.toggle("is-adjourned", roomStatus === "adjourned");
  buildTopBar();
  setStatusPill();
  $("[data-act=playpause]").innerHTML = ICON.pause;
  $("[data-act=rate]").textContent = "1×";
  const vd = $("[data-vote-dot]"); if (vd) vd.hidden = true;

  if (roomDelivery === "text") {
    const chat = $("[data-chat]"); if (chat) chat.innerHTML = "";
    buildQueue();
    if (roomStatus === "adjourned") fillChatAll();
    else startDriver();
    return;
  }

  // voice room · 3D stage
  const stageEl = $("[data-mobile-stage]");
  stageEl.setAttribute("data-floor", roomMode);
  if (!MV || !MV.isSupported || !MV.isSupported()) {
    stageEl.innerHTML = '<div class="vr-nowebgl">This device can’t render the 3D stage (no WebGL).</div>';
    return;
  }
  MV.mount(stageEl, { camera: { distance: 16, elevationDeg: 24, lookAtY: 0.9 }, loading: false });
  rebuildCast();
  buildQueue();
  snapSheet("closed");
  if (roomStatus === "adjourned") { fillTranscriptAll(); paintStage(null, null); }
  else startDriver();
}

function exitRoom() {
  if (driver) { driver.stop(); driver = null; }
  if (MV && roomDelivery !== "text") { try { MV.unmount(); } catch (_) { /* */ } }
  closeModal();
  document.body.classList.remove("is-adjourned", "is-composing", "is-text");
  captionHide();
  currentRoom = null;
  renderRooms();
  showView("home");
}

/* ── Top bar ─────────────────────────────────────────────────── */
function buildTopBar() {
  $("[data-vr-title]").textContent = currentRoom ? currentRoom.subject : SESSION.title;
  $("[data-vr-round]").textContent = "R" + (currentRoom ? currentRoom.round : (SESSION.round || 1));
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
      window.MobileVoiceStage3D.focusSeat(m.id);
      setRailActive(m.id);
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
function captionThinking(name) {
  const band = $("[data-caption]");
  band.classList.remove("is-hidden");
  band.classList.add("is-thinking");
  $("[data-cap-kicker]").textContent = name;
  $("[data-cap-text]").textContent = "";
}
function captionSpeak(name) {
  const band = $("[data-caption]");
  band.classList.remove("is-hidden", "is-thinking");
  $("[data-cap-kicker]").textContent = name;
}
function captionReveal(textSoFar) { $("[data-cap-text]").textContent = textSoFar; }
function captionHide() { $("[data-caption]").classList.add("is-hidden"); }

/* ── Transcript sheet ────────────────────────────────────────── */
function appendTranscript(member, text) {
  const list = $("[data-transcript]");
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
let _textBubble = null;
function chatScroll() { const w = $("[data-chat]"); if (w) w.scrollTop = w.scrollHeight; }
function textThinking(m) {
  const wrap = $("[data-chat]"); if (!wrap) return;
  const row = document.createElement("div");
  row.className = "vr-msg vr-msg-them is-typing";
  row.innerHTML = `${avatarThumb(m, 30)}<div class="vr-msg-body"><div class="vr-msg-who">${m && m.name ? m.name : "—"}</div><div class="vr-msg-text"><span class="vr-typing"><i></i><i></i><i></i></span></div></div>`;
  wrap.appendChild(row); chatScroll();
  _textBubble = row;
}
function textSpeakStart() {
  if (!_textBubble) return;
  _textBubble.classList.remove("is-typing");
  const t = _textBubble.querySelector(".vr-msg-text"); if (t) t.textContent = "";
}
function textReveal(s) { if (_textBubble) { const t = _textBubble.querySelector(".vr-msg-text"); if (t) t.textContent = s; chatScroll(); } }
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
  SESSION.turns.forEach((t) => {
    const m = byId(t.speakerId) || { name: t.speakerId };
    const row = document.createElement("div");
    row.className = "vr-msg vr-msg-them";
    row.innerHTML = `${avatarThumb(m, 30)}<div class="vr-msg-body"><div class="vr-msg-who">${m.name}</div><div class="vr-msg-text">${esc(t.text)}</div></div>`;
    wrap.appendChild(row);
  });
  chatScroll();
}

/* ── Composer · user asks the board (both modes) ─────────────── */
const REPLIES = [
  "Good question — the honest answer is it depends on the constraint you're optimising for. Let me take the harder case.",
  "Let me push back on the premise for a second, then answer it directly.",
  "I'd reframe that: the real question underneath is whether the cost is reversible.",
  "Fair point. Here's where I'd land — and where I'm still genuinely unsure.",
];
function pickReply(t) { return REPLIES[t.length % REPLIES.length]; }
function cancelCompose() {
  // Just close the composer · the discussion was never paused while composing.
  document.body.classList.remove("is-composing");
  const input = $("[data-composer-input]"); if (input) { input.value = ""; input.blur(); }
}
function wireComposer() {
  const send = $("[data-composer-send]"); if (send) { send.innerHTML = ICON.send; send.addEventListener("click", submitComposer); }
  const cancel = $("[data-composer-cancel]"); if (cancel) { cancel.innerHTML = ICON.x; cancel.addEventListener("click", cancelCompose); }
  const input = $("[data-composer-input]");
  if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitComposer(); } else if (e.key === "Escape") { cancelCompose(); } });
}
function submitComposer() {
  const input = $("[data-composer-input]"); if (!input) return;
  const text = input.value.trim(); if (!text || roomStatus === "adjourned") return;
  input.value = "";
  sendUserMessage(text);
}
function sendUserMessage(text) {
  const responder = ROSTER.find((r) => r.active) || CHAIR;
  const m = byId(responder.id) || responder;
  const reply = pickReply(text);

  if (roomDelivery === "text") {
    appendChatUser(text);
    if (driver) driver.setPaused(true);          // hold the chat while the board replies
    textThinking(m);
    setTimeout(() => { textSpeakStart(); textReveal(reply); if (driver) driver.setPaused(false); }, 950);
    return;
  }

  // Voice · show a speech bubble + countdown over the user's own 3D seat
  // (desktop parity), then a director responds. Pause the discussion only
  // NOW (on send) — composing didn't pause it.
  document.body.classList.remove("is-composing");
  appendTranscript({ name: "You" }, text);
  if (driver) driver.setPaused(true);
  pendingUserBubble = { text, progress: 1 };
  if (MV) MV.focusSeat(null);                    // wide shot so the front "You" seat is in frame
  paintStage(lastSpeakerId, lastSpeakerState);   // shows the user bubble (CSS countdown starts)
  // Director responds via caption + camera only — NO stage rebuild, so the
  // bubble's countdown animation isn't restarted.
  setTimeout(() => { if (MV) MV.focusSeat(responder.id); captionSpeak(m.name); captionReveal(reply); appendTranscript(m, reply); setRailActive(responder.id); }, 1100);
  setTimeout(() => { pendingUserBubble = null; paintStage(lastSpeakerId, lastSpeakerState); if (driver) driver.setPaused(false); }, 6000);
}

/* ── Control dock ────────────────────────────────────────────── */
let driver = null; // set by startDriver
function wireDock() {
  $("[data-act=interject]").innerHTML = ICON.hand;
  $("[data-act=playpause]").innerHTML = ICON.pause;
  $("[data-act=sheet]").innerHTML = ICON.list;

  $("[data-act=interject]").addEventListener("click", () => {
    // Reveal the composer to ask the board · the discussion keeps playing
    // while you compose (only pauses on send, for the board's reply).
    const on = document.body.classList.toggle("is-composing");
    if (on) { const i = $("[data-composer-input]"); if (i) i.focus(); }
  });
  $("[data-act=playpause]").addEventListener("click", (e) => {
    if (!driver) return;
    const paused = driver.togglePause();
    e.currentTarget.innerHTML = paused ? ICON.play : ICON.pause;
  });
  $("[data-act=rate]").addEventListener("click", (e) => {
    if (!driver) return;
    e.currentTarget.textContent = driver.cycleRate() + "×";
  });
  $("[data-act=rate]").textContent = "1×";
  $("[data-act=sheet]").addEventListener("click", () => snapSheet(sheetSnap === "closed" ? "half" : "closed"));
}

let toastTimer = 0;
function toast(msg) {
  const t = $("[data-toast]");
  t.textContent = msg;
  t.classList.add("is-shown");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("is-shown"), 2600);
}

/* ── Bottom sheet (drag + snap) ──────────────────────────────── */
let sheetSnap = "closed";
// Closed = fully off-screen (NOT a peek) so it never overlaps / blocks the
// control dock. Opened via the dock's transcript button; dragged via the
// handle once open.
function sheetClosedY() { return $("[data-sheet]").offsetHeight + 2; }
function snapSheet(state) {
  const sheet = $("[data-sheet]");
  sheetSnap = state;
  const h = sheet.offsetHeight;
  const y = state === "full" ? 0 : state === "half" ? Math.round(h * 0.45) : sheetClosedY();
  sheet.style.transition = "transform 0.28s cubic-bezier(.22,.61,.36,1)";
  sheet.style.transform = `translateY(${y}px)`;
}
function wireSheet() {
  const sheet = $("[data-sheet]");
  const handle = $("[data-sheet-handle]");
  // Start hidden. The dock opens it to HALF; scrolling the content then
  // promotes it to (near-)full — iOS medium→large detent behaviour.
  requestAnimationFrame(() => snapSheet("closed"));
  document.querySelectorAll(".vr-panel").forEach((p) => {
    p.addEventListener("scroll", () => {
      if (sheetSnap === "half" && p.scrollTop > 6) snapSheet("full");
    }, { passive: true });
  });
  let startY = 0, startT = 0, dragging = false;
  const cur = () => {
    const m = /translateY\(([-0-9.]+)px\)/.exec(sheet.style.transform || "");
    return m ? parseFloat(m[1]) : sheetClosedY();
  };
  handle.addEventListener("pointerdown", (e) => {
    dragging = true; startY = e.clientY; startT = cur();
    sheet.style.transition = "none";
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const y = Math.max(0, Math.min(sheetClosedY(), startT + (e.clientY - startY)));
    sheet.style.transform = `translateY(${y}px)`;
  });
  handle.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    const y = cur(), h = sheet.offsetHeight;
    // snap to nearest of full(0) / half(.45h) / closed
    const targets = [["full", 0], ["half", h * 0.45], ["closed", sheetClosedY()]];
    let best = targets[0];
    for (const t of targets) if (Math.abs(t[1] - y) < Math.abs(best[1] - y)) best = t;
    snapSheet(best[0]);
  });
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

/* ── Queue panel · built once, status updated live per turn ──── */
function buildQueue() {
  const order = $("[data-order]");
  if (!order) return;
  order.innerHTML = "";
  SESSION.turns.forEach((t, i) => {
    const m = byId(t.speakerId);
    const row = document.createElement("div");
    row.className = "vr-order-row is-up";
    row.dataset.qrow = String(i);
    row.innerHTML = `<span class="vr-order-n">${String(i + 1).padStart(2, "0")}</span><span>${m ? m.name : t.speakerId}</span><span class="vr-order-status">up next</span>`;
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
    if (st) st.textContent = i < curIdx ? "spoke" : i === curIdx ? "speaking" : "up next";
  });
}
function showVoteDot() { const d = $("[data-vote-dot]"); if (d) d.hidden = false; }

/* ── Canvas-tap → rail sync ──────────────────────────────────── */
function wireFocusSync() {
  document.addEventListener("mvoice:focus", (e) => {
    if (e && e.detail && e.detail.id) setRailActive(e.detail.id);
  });
}

/* ── The driver · rAF play-clock state machine ───────────────── */
function startDriver() {
  const turns = SESSION.turns;
  const speakDurOf = (t) => Math.max(1800, Math.min(7000, t.text.length * 42));
  const GAP_MS = 1400;

  let idx = 0, phase = "think", phaseStart = 0, playT = 0, lastTs = 0;
  let paused = false, rate = 1, revealed = -1, speakDur = 0, raf = 0;

  const isText = () => roomDelivery === "text";
  function beginTurn(i) {
    idx = i; phase = "think"; phaseStart = playT; revealed = -1;
    const t = turns[i], m = byId(t.speakerId);
    if (isText()) {
      textThinking(m || { name: t.speakerId });
    } else {
      paintStage(t.speakerId, "thinking");
      if (MV) MV.focusSeat(t.speakerId);  // close-up (engine's own detection misfires post-thinking)
      captionThinking(m ? m.name : t.speakerId);
      setRailActive(t.speakerId);
    }
    markQueue(i);
    if (i === turns.length - 1) showVoteDot();
  }
  function startSpeak() {
    const t = turns[idx], m = byId(t.speakerId);
    phase = "speak"; phaseStart = playT; revealed = -1; speakDur = speakDurOf(t);
    if (isText()) {
      textSpeakStart(m || { name: t.speakerId });
    } else {
      paintStage(t.speakerId, "speaking");
      captionSpeak(m ? m.name : t.speakerId);
      appendTranscript(m || { name: t.speakerId }, t.text);
    }
  }
  function afterSpeak() {
    const next = idx + 1;
    if (next >= turns.length) {
      if (isText()) { phase = "done"; if (raf) cancelAnimationFrame(raf); raf = 0; return; } // chat plays once
      phase = "gap"; phaseStart = playT; paintStage(null, null); captionHide();
    } else beginTurn(next);
  }
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (!lastTs) lastTs = ts;
    let dt = ts - lastTs; lastTs = ts;
    if (dt > 100) dt = 100;
    if (!paused) playT += dt * rate;
    const t = turns[idx];
    const elapsed = playT - phaseStart;
    if (phase === "think") {
      if (elapsed >= t.thinkMs) startSpeak();
    } else if (phase === "speak") {
      const chars = Math.min(t.text.length, Math.floor((elapsed / speakDur) * t.text.length));
      if (chars !== revealed) { revealed = chars; isText() ? textReveal(t.text.slice(0, chars)) : captionReveal(t.text.slice(0, chars)); }
      if (elapsed >= speakDur) afterSpeak();
    } else if (phase === "gap") {
      if (elapsed >= GAP_MS) beginTurn(0);
    }
  }

  beginTurn(0);
  raf = requestAnimationFrame(frame);

  driver = {
    togglePause() { paused = !paused; return paused; },
    setPaused(p) { paused = !!p; },
    cycleRate() { rate = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1; return rate; },
    restart() { idx = 0; playT = 0; phaseStart = 0; lastTs = 0; paused = false; const tr = $("[data-transcript]"); if (tr) tr.innerHTML = ""; const ch = $("[data-chat]"); if (ch) ch.innerHTML = ""; if (!raf) raf = requestAnimationFrame(frame); beginTurn(0); },
    stop() { if (raf) cancelAnimationFrame(raf); raf = 0; },
  };
}

/* ════════════════════════════════════════════════════════════════
   Room state · mutable for the prototype (cast / tone / status).
   ════════════════════════════════════════════════════════════════ */
let MV = null;
const CHAIR = CAST.find((c) => c.roleKind === "chair");
const ROSTER = CAST.filter((c) => c.roleKind === "director").map((c) => ({ ...c, active: true }));
let MEMBERS = [];
let POSITIONS = [];
let roomMode = SESSION.mode;
let roomIntensity = "sharp";
let roomStatus = "live";
let roomDelivery = "voice";   // "voice" (3D stage) | "text" (chat)
const USER_MEMBER = { id: "__user", name: "You", __isUser: true, avatar3d: { model: "casual" } };
let pendingUserBubble = null; // {text, progress} shown over the user's seat (voice)
const LABELS = { thinking: "thinking", speaking: "speaking" };
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

function activeMembers() { return [CHAIR, ...ROSTER.filter((r) => r.active), USER_MEMBER]; }
function paintStage(speakerId, speakerState) {
  lastSpeakerId = speakerId; lastSpeakerState = speakerState;
  if (MV) MV.update({ mode: roomMode, positions: POSITIONS, speakerId, speakerState, userWait: false, labels: LABELS, votePop: "", userBubble: pendingUserBubble });
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
  pill.classList.toggle("is-done", roomStatus === "adjourned");
  pill.setAttribute("aria-label", roomStatus === "adjourned" ? "Adjourned" : "Live");
}
function adjournRoom() {
  if (roomStatus === "adjourned") return;
  roomStatus = "adjourned";
  if (currentRoom) currentRoom.status = "adjourned";
  if (driver) driver.stop();
  paintStage(null, null);                  // wide establishing shot, no speaker
  captionHide();
  setStatusPill();
  document.body.classList.add("is-adjourned"); // CSS swaps dock → adjourned bar
  closeModal();
  toast("Meeting adjourned · report filed.");
}
function replayRoom() {
  roomStatus = "live";
  if (currentRoom) currentRoom.status = "live";
  setStatusPill();
  document.body.classList.remove("is-adjourned");
  const d = $("[data-vote-dot]"); if (d) d.hidden = true;
  if (driver) driver.restart();
}

/* ════════════════════════════════════════════════════════════════
   Modal · Room menu → Settings / Manage cast / Report (+ Adjourn).
   ════════════════════════════════════════════════════════════════ */
let modalStack = [];
let _lastModalView = null;
function openModal(view) { modalStack = [view]; $("[data-modal]").hidden = false; document.body.classList.add("is-modal"); renderModal(); }
function pushModal(view) { modalStack.push(view); renderModal(); }
function popModal() { modalStack.pop(); if (!modalStack.length) closeModal(); else renderModal(); }
function closeModal() { modalStack = []; _lastModalView = null; const m = $("[data-modal]"); if (m) m.hidden = true; document.body.classList.remove("is-modal"); }
function renderModal() {
  const view = modalStack[modalStack.length - 1];
  const r = (VIEWS[view] || (() => ({ title: "", html: "" })))();
  $("[data-modal-title]").textContent = r.title;
  $("[data-modal-back]").hidden = modalStack.length <= 1;
  const body = $("[data-modal-body]");
  const keepScroll = view === _lastModalView ? body.scrollTop : 0; // preserve on in-place re-render
  body.innerHTML = r.html;
  if (r.mount) r.mount(body);
  body.scrollTop = keepScroll;
  _lastModalView = view;
}

function renderMenu() {
  const rows = [
    { go: "settings", icon: ICON.gear, label: "Room settings", sub: `${cap(roomMode)} · ${cap(roomIntensity)}` },
    { go: "cast",     icon: ICON.cast, label: "Manage cast",   sub: `${inRoomCount()} directors` },
  ];
  const html = `<div class="vr-menu">
    ${rows.map((r) => `<button class="vr-act-row" data-go="${r.go}">${r.icon}<span class="vr-act-label">${r.label}<em>${r.sub}</em></span><span class="vr-act-chev">${ICON.chev}</span></button>`).join("")}
    <button class="vr-act-row is-danger" data-go="adjourn">${ICON.adjourn}<span class="vr-act-label">Adjourn &amp; file report<em>End the meeting, generate the brief</em></span></button>
  </div>`;
  return { title: "Room", html, mount(b) {
    b.querySelectorAll("[data-go]").forEach((btn) => btn.addEventListener("click", () => {
      const go = btn.dataset.go;
      if (go === "adjourn") adjournRoom(); else pushModal(go);
    }));
  } };
}

function renderSettings() {
  const toneNote = (TONES.find((t) => t.id === roomMode) || {}).note || "";
  const intNote = (INTENSITIES.find((t) => t.id === roomIntensity) || {}).note || "";
  const tiles = (arr, kind, cur) => arr.map((o) =>
    `<button class="vr-tile${o.id === cur ? " is-checked" : ""}" data-opt="${kind}:${o.id}">${o.icon}<span>${o.name}</span></button>`).join("");
  const html = `
    <div class="vr-set-group">
      <h4>Tone</h4>
      <div class="vr-tile-grid">${tiles(TONES, "tone", roomMode)}</div>
      <p class="vr-set-hint">${toneNote}</p>
    </div>
    <div class="vr-set-group">
      <h4>Intensity</h4>
      <div class="vr-tile-grid">${tiles(INTENSITIES, "intensity", roomIntensity)}</div>
      <p class="vr-set-hint">${intNote}</p>
    </div>`;
  return { title: "Room settings", html, mount(b) {
    b.querySelectorAll("[data-opt]").forEach((btn) => btn.addEventListener("click", () => {
      const [kind, id] = btn.dataset.opt.split(":");
      if (kind === "tone") { setTone(id); }
      else { roomIntensity = id; if (currentRoom) currentRoom.intensity = id; }
      renderModal();
    }));
  } };
}

function renderCast() {
  const inRoom = ROSTER.filter((r) => r.active);
  const avail = ROSTER.filter((r) => !r.active);
  const row = (r, active) => `<div class="vr-cast-row"><img src="${r.avatarPath}" alt="" draggable="false"><span class="vr-cast-name">${r.name}</span><button class="vr-cast-btn${active ? " is-remove" : ""}" data-toggle="${r.id}" aria-label="${active ? "Remove" : "Add"}">${active ? ICON.minus : ICON.plus}</button></div>`;
  const html = `
    <div class="vr-cast-group"><h4>In the room · ${inRoom.length}</h4><div class="vr-set-list">${inRoom.map((r) => row(r, true)).join("")}</div></div>
    ${avail.length ? `<div class="vr-cast-group"><h4>Available</h4><div class="vr-set-list">${avail.map((r) => row(r, false)).join("")}</div></div>` : ""}`;
  return { title: "Manage cast", html, mount(b) {
    b.querySelectorAll("[data-toggle]").forEach((btn) => btn.addEventListener("click", () => {
      const r = ROSTER.find((x) => x.id === btn.dataset.toggle);
      if (!r) return;
      if (r.active && inRoomCount() <= 2) { toast("Keep at least two directors."); return; }
      r.active = !r.active;
      if (currentRoom) currentRoom.directorIds = ROSTER.filter((x) => x.active).map((x) => x.id);
      rebuildCast();   // live: stage seats + cast rail update immediately
      renderModal();
    }));
  } };
}

function renderReport() {
  const dirs = ROSTER.filter((r) => r.active).map((r) => r.name).join(" · ");
  const html = `<article class="vr-report">
    <div class="vr-rep-kicker">— Brief · Round ${SESSION.round || 1}</div>
    <h3>${SESSION.title}</h3>
    <p class="vr-rep-lede">After taking the “responsive wrapper” path seriously, the room is less confident in it than it began. The native voice room is the defensible bet — but only if a phone prototype proves the stage can feel native.</p>
    <div class="vr-rep-kicker">Key points</div>
    <ul class="vr-rep-list">
      <li>A wrapper ships sooner but inherits its constraints for ~2 years.</li>
      <li>First-run friction (captions not tracking the speaker) is make-or-break.</li>
      <li>Base rate favours the team that goes native second, not first.</li>
      <li>Open question: can a voice room feel native on a phone at all?</li>
    </ul>
    <div class="vr-rep-kicker">Decision</div>
    <p class="vr-rep-decision">Prototype the voice stage first; commit the quarter only if it lands.</p>
    <div class="vr-rep-foot">Directors · ${dirs}</div>
  </article>`;
  return { title: "Report", html };
}

const VIEWS = { menu: renderMenu, settings: renderSettings, cast: renderCast, report: renderReport, new: renderNewRoom, prefs: renderPrefs, keys: renderApiKeys, addkey: renderAddKey, usage: renderUsage, agent: renderAgentProfile, model: renderModelPicker, newagent: renderNewAgent, amodel: renderNewAgentModel };

function wireMenu() {
  const menuBtn = $("[data-act=menu]");
  if (menuBtn) { menuBtn.innerHTML = ICON.menu; menuBtn.addEventListener("click", () => openModal("menu")); }
  const close = $("[data-modal-close]"); if (close) { close.innerHTML = ICON.x; close.addEventListener("click", closeModal); }
  const back = $("[data-modal-back]"); if (back) { back.innerHTML = ICON.chev; back.addEventListener("click", popModal); }
  const scrim = $("[data-modal-scrim]"); if (scrim) scrim.addEventListener("click", closeModal);
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
    }, { passive: true });
  }
  const replay = $("[data-act=replay]"); if (replay) { replay.innerHTML = ICON.replay; replay.addEventListener("click", replayRoom); }
  const adjReport = $("[data-adj-report]"); if (adjReport) adjReport.addEventListener("click", () => openModal("report"));
}

/* ════════════════════════════════════════════════════════════════
   Home · rooms list + New Room.
   ════════════════════════════════════════════════════════════════ */
const ROOMS = [
  { id: "r-mobile",  subject: "Ship mobile now, or hold for the native voice room?", tone: "brainstorm",   intensity: "sharp", status: "live",      delivery: "voice", round: 2, ago: "now",     directorIds: ["socrates", "first-principles", "value-investor", "user-empathy", "long-horizon", "phenomenologist"] },
  { id: "r-pricing", subject: "Pricing for the v2 launch — seat-based or usage-based?", tone: "constructive", intensity: "sharp", status: "adjourned", delivery: "voice", round: 5, ago: "2h ago",  directorIds: ["value-investor", "long-horizon", "first-principles", "phenomenologist"] },
  { id: "r-hiring",  subject: "Hire one senior, or two juniors, this quarter?",     tone: "debate",       intensity: "terse", status: "live",      delivery: "text",  round: 1, ago: "18m ago", directorIds: ["socrates", "value-investor", "user-empathy"] },
];
let currentRoom = null;
let draft = null;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function showView(name) {
  document.querySelectorAll("[data-view]").forEach((v) => { v.hidden = v.dataset.view !== name; });
}

function roomCard(r) {
  const tone = TONES.find((t) => t.id === r.tone) || {};
  const dirs = r.directorIds.map((id) => CAST.find((c) => c.id === id)).filter(Boolean);
  const avs = dirs.slice(0, 5).map((d) => `<img src="${d.avatarPath}" alt="" draggable="false">`).join("");
  const live = r.status === "live";
  return `<button type="button" class="vr-roomcard" data-room="${r.id}">
    <div class="vr-rc-head">
      <span class="vr-rc-status ${live ? "is-live" : "is-done"}">${live ? "Live" : "Adjourned"}</span>
      <span class="vr-rc-tone">${tone.icon || ""}<span>${tone.name || cap(r.tone)}</span></span>
    </div>
    <div class="vr-rc-subject">${esc(r.subject)}</div>
    <div class="vr-rc-foot">
      <div class="vr-rc-avs">${avs}</div>
      <span class="vr-rc-meta">${r.delivery === "text" ? "Text" : "Voice"} · ${dirs.length} directors · ${esc(r.ago)}</span>
    </div>
  </button>`;
}
function renderRooms() {
  const wrap = $("[data-rooms]");
  if (!wrap) return;
  wrap.innerHTML = ROOMS.map(roomCard).join("");
  wrap.querySelectorAll("[data-room]").forEach((el) => el.addEventListener("click", () => {
    const room = ROOMS.find((r) => r.id === el.dataset.room);
    if (room) enterRoom(room);
  }));
}

/* Adjourned rooms open with the full transcript already filed. */
function fillTranscriptAll() {
  const tr = $("[data-transcript]"); if (tr) tr.innerHTML = "";
  SESSION.turns.forEach((t) => appendTranscript(byId(t.speakerId) || { name: t.speakerId }, t.text));
  markQueue(SESSION.turns.length);
  showVoteDot();
}

/* New Room · a draft edited in the modal, then convened into a live room. */
function renderNewRoom() {
  if (!draft) draft = { subject: "", tone: "constructive", intensity: "sharp", delivery: "voice", directorIds: ROSTER.slice(0, 4).map((r) => r.id) };
  const tiles = TONES.map((o) => `<button class="vr-tile${o.id === draft.tone ? " is-checked" : ""}" data-dtone="${o.id}">${o.icon}<span>${o.name}</span></button>`).join("");
  const fmt = [{ id: "voice", name: "Voice", icon: ICON.mic }, { id: "text", name: "Text", icon: ICON.bubble }]
    .map((o) => `<button class="vr-tile${o.id === draft.delivery ? " is-checked" : ""}" data-ddel="${o.id}">${o.icon}<span>${o.name}</span></button>`).join("");
  const rows = ROSTER.map((r) => {
    const on = draft.directorIds.includes(r.id);
    return `<div class="vr-cast-row"><img src="${r.avatarPath}" alt="" draggable="false"><span class="vr-cast-name">${r.name}</span><button class="vr-cast-btn${on ? " is-remove" : ""}" data-dcast="${r.id}" aria-label="${on ? "Remove" : "Add"}">${on ? ICON.check : ICON.plus}</button></div>`;
  }).join("");
  const html = `
    <div class="vr-set-group"><h4>Subject</h4><input class="vr-input" data-dsubject placeholder="What should the board decide?" value="${esc(draft.subject)}"></div>
    <div class="vr-set-group"><h4>Format</h4><div class="vr-tile-grid">${fmt}</div></div>
    <div class="vr-set-group"><h4>Tone</h4><div class="vr-tile-grid">${tiles}</div></div>
    <div class="vr-set-group"><h4>Directors · ${draft.directorIds.length}</h4><div class="vr-set-list">${rows}</div></div>
    <button type="button" class="vr-convene" data-convene>Convene room</button>`;
  return { title: "New room", html, mount(b) {
    b.querySelector("[data-dsubject]").addEventListener("input", (e) => { draft.subject = e.target.value; });
    b.querySelectorAll("[data-ddel]").forEach((btn) => btn.addEventListener("click", () => { draft.delivery = btn.dataset.ddel; renderModal(); }));
    b.querySelectorAll("[data-dtone]").forEach((btn) => btn.addEventListener("click", () => { draft.tone = btn.dataset.dtone; renderModal(); }));
    b.querySelectorAll("[data-dcast]").forEach((btn) => btn.addEventListener("click", () => {
      const id = btn.dataset.dcast, i = draft.directorIds.indexOf(id);
      if (i >= 0) { if (draft.directorIds.length <= 2) { toast("Pick at least two directors."); return; } draft.directorIds.splice(i, 1); }
      else draft.directorIds.push(id);
      renderModal();
    }));
    b.querySelector("[data-convene]").addEventListener("click", createRoom);
  } };
}
function createRoom() {
  const subject = (draft.subject || "").trim() || "Untitled discussion";
  const room = { id: "r" + Math.floor(Date.now()), subject, tone: draft.tone, intensity: draft.intensity, status: "live", delivery: draft.delivery || "voice", round: 1, ago: "now", directorIds: draft.directorIds.slice() };
  ROOMS.unshift(room);
  draft = null;
  closeModal();
  enterRoom(room);
}

let homeTab = "rooms";
function switchHomeTab(name) {
  homeTab = name;
  document.querySelectorAll("[data-hpanel]").forEach((p) => { p.hidden = p.dataset.hpanel !== name; });
  document.querySelectorAll("[data-htab]").forEach((b) => b.classList.toggle("is-active", b.dataset.htab === name));
  if (name === "directors") renderDirectors();
}
function wireNav() {
  const nb = $("[data-act=new]"); if (nb) { nb.innerHTML = ICON.plus; nb.addEventListener("click", () => { if (homeTab === "rooms") { draft = null; openModal("new"); } else { agentDraft = null; openModal("newagent"); } }); }
  const pb = $("[data-act=prefs]"); if (pb) { pb.innerHTML = ICON.gear; pb.addEventListener("click", () => openModal("prefs")); }
  const back = $("[data-act=back]"); if (back) { back.innerHTML = ICON.chev; back.addEventListener("click", exitRoom); }
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
const CREDS = { llm: { items: [], activeId: null }, voice: { items: [], activeId: null }, search: { items: [], activeId: null } };
let keyDraft = null;

function loadCreds() {
  try {
    const s = localStorage.getItem("pb_proto_creds");
    if (s) {
      const parsed = JSON.parse(s) || {};
      for (const cat of ["llm", "voice", "search"]) {
        if (parsed[cat]) {
          CREDS[cat].items = Array.isArray(parsed[cat].items) ? parsed[cat].items : [];
          CREDS[cat].activeId = parsed[cat].activeId || null;
        }
      }
    } else {
      migrateLegacyKeys();   // fold any v1 flat-key store into credentials
    }
  } catch (_) { /* */ }
}
function persistCreds() { try { localStorage.setItem("pb_proto_creds", JSON.stringify(CREDS)); } catch (_) { /* */ } }
/* One-time upgrade · the first prototype stored a flat { provider: key }
   map under `pb_proto_keys`. Fold each entry into a credential so older
   testers don't lose their pasted keys. */
function migrateLegacyKeys() {
  try {
    const s = localStorage.getItem("pb_proto_keys"); if (!s) return;
    const old = JSON.parse(s) || {};
    for (const [provider, key] of Object.entries(old)) {
      if (!key || !String(key).trim() || !PROVIDER_CATALOG[provider]) continue;
      addCred(provider, "", String(key), { silent: true });
    }
    localStorage.removeItem("pb_proto_keys");
  } catch (_) { /* */ }
}
/* 4+4 mask · the only representation of a key the UI ever shows after
   save. Short keys collapse to bullets so length isn't leaked either. */
function maskKey(k) {
  const s = String(k || "").trim();
  if (!s) return "";
  if (s.length <= 8) return "•".repeat(Math.max(s.length, 3));
  return s.slice(0, 4) + "…" + s.slice(-4);
}
function credId() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function addCred(provider, label, key, opts) {
  const cat = provCat(provider);
  const item = { id: credId(), provider, label: (label || "").trim(), preview: maskKey(key), key: String(key), createdAt: Date.now() };
  CREDS[cat].items.push(item);
  CREDS[cat].activeId = item.id;   // newest connected becomes active (single-active per category)
  persistCreds();
  if (!(opts && opts.silent)) toast(`${provName(provider)} connected.`);
  return item;
}
function removeCred(cat, id) {
  const list = CREDS[cat];
  const i = list.items.findIndex((c) => c.id === id);
  if (i < 0) return;
  const wasActive = list.activeId === id;
  list.items.splice(i, 1);
  if (wasActive) list.activeId = list.items.length ? list.items[0].id : null;   // promote next, or clear
  persistCreds();
}
function setActiveCred(cat, id) { CREDS[cat].activeId = id; persistCreds(); }
function activeCred(cat) { return CREDS[cat].items.find((c) => c.id === CREDS[cat].activeId) || null; }
function credCount() { return CREDS.llm.items.length + CREDS.voice.items.length + CREDS.search.items.length; }

const PROVIDER_COLOR = { anthropic: "#C9A46B", openai: "#6A9B97", openrouter: "#8E7CC3", bai: "#C0795B", unknown: "#5C5A52" };
const USAGE = {
  total: 1804000,
  byModel: [
    { model: "opus-4-7",   provider: "anthropic", tokens: 1180000 },
    { model: "sonnet-4-6", provider: "anthropic", tokens: 420000 },
    { model: "gpt-5.1",    provider: "openai",    tokens: 150000 },
    { model: "haiku-4-5",  provider: "anthropic", tokens: 54000 },
  ],
};
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n));

function renderPrefs() {
  const llm = activeCred("llm");
  const total = credCount();
  const keySub = llm
    ? `${provName(llm.provider)} active`
    : (total ? `${total} stored · none active` : "Not configured");
  const rows = [
    { go: "keys",  icon: ICON.key,   label: "API keys", sub: keySub },
    { go: "usage", icon: ICON.chart, label: "Usage",    sub: `${fmtTokens(USAGE.total)} tokens · this month` },
  ];
  const html = `<div class="vr-menu">${rows.map((r) =>
    `<button class="vr-act-row" data-go="${r.go}">${r.icon}<span class="vr-act-label">${r.label}<em>${r.sub}</em></span><span class="vr-act-chev">${ICON.chev}</span></button>`).join("")}</div>`;
  return { title: "Settings", html, mount(b) {
    b.querySelectorAll("[data-go]").forEach((btn) => btn.addEventListener("click", () => pushModal(btn.dataset.go)));
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
            <button type="button" class="vr-cred-del" data-del aria-label="Remove">${ICON.x}</button>
          </div>`;
        }).join("")
      : `<div class="vr-cred-empty">No keys yet.</div>`;
    return `<div class="vr-set-group">
      <h4>${cat.title}</h4>
      <div class="vr-set-list">${rows}</div>
      <button type="button" class="vr-cred-add" data-add="${cat.id}">${ICON.plus}<span>Add key</span></button>
      <p class="vr-set-hint">${cat.hint}</p>
    </div>`;
  }).join("");
  const html = sections
    + `<p class="vr-set-hint">Stored on this device only (prototype · localStorage). Plaintext keys are never shown again after saving — only a masked preview. Tap a key to make it the active one for that category.</p>`;
  return { title: "API keys", html, mount(b) {
    b.querySelectorAll("[data-add]").forEach((btn) => btn.addEventListener("click", () => {
      const cat = btn.dataset.add;
      const firstProv = Object.keys(PROVIDER_CATALOG).find((p) => provCat(p) === cat);
      keyDraft = { cat, provider: firstProv, label: "", key: "" };
      pushModal("addkey");
    }));
    b.querySelectorAll("[data-pick]").forEach((btn) => btn.addEventListener("click", (e) => {
      const row = e.target.closest("[data-cred]"); if (!row) return;
      setActiveCred(row.dataset.cat, row.dataset.cred); renderModal();
    }));
    b.querySelectorAll("[data-del]").forEach((btn) => btn.addEventListener("click", (e) => {
      const row = e.target.closest("[data-cred]"); if (!row) return;
      removeCred(row.dataset.cat, row.dataset.cred); renderModal();
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
    ? `<div class="vr-set-group"><h4>Carriers · one key, many models</h4><div class="vr-tile-grid">${provsIn("multi").map(tile).join("")}</div></div>
       <div class="vr-set-group"><h4>Direct providers</h4><div class="vr-tile-grid">${provsIn("single").map(tile).join("")}</div></div>`
    : `<div class="vr-set-group"><h4>Provider</h4><div class="vr-tile-grid">${provsIn().map(tile).join("")}</div></div>`;
  const meta = PROVIDER_CATALOG[keyDraft.provider] || {};
  const html = picker
    + `<div class="vr-set-group"><h4>Label · optional</h4><input class="vr-input" data-klabel placeholder="e.g. Personal, Work" value="${esc(keyDraft.label)}"></div>`
    + `<div class="vr-set-group"><h4>API key</h4>
        <div class="vr-keyfield"><input class="vr-input vr-keyfield-input" data-kkey type="password" placeholder="${esc(meta.hint || "Paste key")}" value="${esc(keyDraft.key)}" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="button" class="vr-key-eye" data-eye aria-label="Show or hide key">${ICON.eye}</button></div>
        <p class="vr-set-hint">${esc(meta.note || "")}</p></div>`
    + `<button type="button" class="vr-convene" data-save>Save key</button>`;
  return { title: catMeta.title || "Add key", html, mount(b) {
    b.querySelectorAll("[data-prov]").forEach((btn) => btn.addEventListener("click", () => { keyDraft.provider = btn.dataset.prov; renderModal(); }));
    const labelEl = b.querySelector("[data-klabel]"); if (labelEl) labelEl.addEventListener("input", (e) => { keyDraft.label = e.target.value; });
    const keyEl = b.querySelector("[data-kkey]"); if (keyEl) keyEl.addEventListener("input", (e) => { keyDraft.key = e.target.value; });
    const eye = b.querySelector("[data-eye]");
    if (eye && keyEl) eye.addEventListener("click", () => {
      keyEl.type = keyEl.type === "password" ? "text" : "password";
      eye.classList.toggle("is-on", keyEl.type === "text");
    });
    b.querySelector("[data-save]").addEventListener("click", () => {
      const k = (keyDraft.key || "").trim();
      if (!k) { toast("Paste an API key first."); return; }
      addCred(keyDraft.provider, keyDraft.label, k);
      keyDraft = null;
      popModal();
    });
  } };
}

function renderUsage() {
  const total = USAGE.total;
  const col = (p) => PROVIDER_COLOR[p] || PROVIDER_COLOR.unknown;
  const segs = USAGE.byModel.map((m) => `<span style="width:${(m.tokens / total * 100).toFixed(1)}%;background:${col(m.provider)}"></span>`).join("");
  const rows = USAGE.byModel.map((m) => `<div class="vr-use-row"><span class="vr-use-dot" style="background:${col(m.provider)}"></span><span class="vr-use-name">${m.model}<em>${m.provider}</em></span><span class="vr-use-tok">${fmtTokens(m.tokens)}</span><span class="vr-use-pct">${Math.round(m.tokens / total * 100)}%</span></div>`).join("");
  const html = `
    <div class="vr-use-total"><div class="vr-use-total-num">${fmtTokens(total)}</div><div class="vr-use-total-sub">tokens · this month</div></div>
    <div class="vr-use-bar">${segs}</div>
    <div class="vr-set-group"><h4>By model</h4><div class="vr-set-list">${rows}</div></div>`;
  return { title: "Usage", html };
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
const AGENT_MODELS = [{ id: "classic", name: "Classic" }, { id: "glasses", name: "Glasses" }, { id: "casual", name: "Casual" }];
const AB_KEYS = ["Dissent", "Rigor", "Empathy", "Pattern", "Narrative", "Decisiveness"];

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
let modelSel = {};
function loadModels() { try { const s = localStorage.getItem("pb_proto_models"); if (s) modelSel = JSON.parse(s) || {}; } catch (_) { /* */ } }
function persistModels() { try { localStorage.setItem("pb_proto_models", JSON.stringify(modelSel)); } catch (_) { /* */ } }
function modelIdFor(id) { return modelSel[id] || DEFAULT_MODEL[id] || "sonnet-4-6"; }
function modelFor(id) { return MODEL_CATALOG.find((m) => m.id === modelIdFor(id)) || MODEL_CATALOG[1]; }
function setModelFor(id, modelId) { modelSel[id] = modelId; persistModels(); }

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
let rulesSel = {};
function loadRules() { try { const s = localStorage.getItem("pb_proto_rules"); if (s) rulesSel = JSON.parse(s) || {}; } catch (_) { /* */ } }
function persistRules() { try { localStorage.setItem("pb_proto_rules", JSON.stringify(rulesSel)); } catch (_) { /* */ } }
function rulesFor(id) { return rulesSel[id] ? rulesSel[id] : (SEEDED_RULES[id] || []).slice(); }
function setRules(id, arr) { rulesSel[id] = arr.map((s) => String(s)).slice(0, RULES_MAX); persistRules(); }

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
let memSel = {};
function loadMem() { try { const s = localStorage.getItem("pb_proto_mem"); if (s) memSel = JSON.parse(s) || {}; } catch (_) { /* */ } }
function persistMem() { try { localStorage.setItem("pb_proto_mem", JSON.stringify(memSel)); } catch (_) { /* */ } }
function notesFor(id) { return memSel[id] ? memSel[id] : (DIRECTOR_MEMORY[id] || []).slice(); }
function removeNote(id, i) { const cur = notesFor(id).slice(); cur.splice(i, 1); memSel[id] = cur; persistMem(); }

let profileAgentId = null;
let agentDraft = null;
const agentMeta = (id) => AGENTS_META[id] || { handle: "@" + id, roleTag: "Director", voice: "—", bio: "", ab: {} };
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

function agentRow(a) {
  const m = agentMeta(a.id);
  return `<button type="button" class="vr-agentrow" data-agent="${a.id}">${avatarThumb(a, 46)}<span class="vr-ag-body"><span class="vr-ag-name">${a.name}</span><span class="vr-ag-role">${m.roleTag} · ${m.handle}</span></span><span class="vr-act-chev">${ICON.chev}</span></button>`;
}
function renderDirectors() {
  const wrap = $("[data-agents]"); if (!wrap) return;
  // Chair leads the roster · its profile is reachable here too.
  const list = CHAIR ? [CHAIR, ...ROSTER] : ROSTER.slice();
  wrap.innerHTML = list.map(agentRow).join("");
  wrap.querySelectorAll("[data-agent]").forEach((el) => el.addEventListener("click", () => { profileAgentId = el.dataset.agent; openModal("agent"); }));
}

function renderAgentProfile() {
  const a = CAST.find((c) => c.id === profileAgentId) || ROSTER.find((r) => r.id === profileAgentId);
  if (!a) return { title: "Director", html: "" };
  const m = agentMeta(a.id);
  const isChair = a.id === "chair";
  const inRoom = !!ROSTER.find((r) => r.id === a.id && r.active);
  const statusTag = isChair ? "Moderator" : (inRoom ? "In this room" : "Available");
  const statusCls = isChair || inRoom ? " is-active" : "";

  // Ability radar + numeric breakdown (both off the same axis map).
  const ability = abilityFor(a.id);
  const bars = RADAR_AXES.map((ax) => {
    const v = ability[ax];
    return `<div class="vr-ab"><span class="vr-ab-k">${RADAR_LABEL[ax]}</span><span class="vr-ab-bar"><i style="width:${v * 10}%"></i></span><span class="vr-ab-v">${v}</span></div>`;
  }).join("");

  // Skill inventory · read-only loadout (the create flow installs them).
  const installed = (SEEDED_SKILLS[a.id] || []).map(skillByV).filter(Boolean);
  const slots = installed.length
    ? installed.map((s) => `<div class="vr-skill"><span class="vr-skill-icon">${s.icon}</span><span class="vr-skill-name">${s.name}</span></div>`).join("")
    : `<div class="vr-skill is-empty"><span class="vr-skill-icon">+</span><span class="vr-skill-name">None installed</span></div>`;

  // Activity stat grid + the active model (selectable below).
  const mt = PROFILE_METRICS[a.id] || { rooms: 0, rounds: 0, tokens: "—" };
  const model = modelFor(a.id);
  const cell = (lbl, val, unit) => `<div class="vr-stat"><div class="vr-stat-k">${lbl}</div><div class="vr-stat-v">${val}${unit ? `<span>${unit}</span>` : ""}</div></div>`;
  const metrics = `<div class="vr-stat-grid">${cell("Boardrooms", mt.rooms, "rooms")}${cell("Rounds spoken", mt.rounds, "turns")}${cell("Tokens", esc(mt.tokens))}${cell("Skills", installed.length, "/ 8")}</div>`;

  // Operating brief · role / objective / voice / boundaries.
  const doc = [
    ["Role", m.roleTag],
    ["Objective", m.bio],
    m.instruction ? ["Instruction", m.instruction] : null,
    ["Voice", m.voice],
    ["Boundaries", PROFILE_BOUNDARIES[a.id] || "Stays in lane; defers to the chair on sequencing."],
  ].filter(Boolean).map(([k, v]) => `<div class="vr-doc-row"><div class="vr-doc-k">${k}</div><div class="vr-doc-v">${esc(v)}</div></div>`).join("");

  // Memory · chair holds an "about you" dossier; directors carry notes.
  let memoryHtml;
  if (isChair) {
    const cm = CHAIR_MEMORY;
    memoryHtml = `<div class="vr-mem-card">
      <div class="vr-mem-headline">${esc(cm.headline)}</div>
      ${cm.summary.map((p) => `<p class="vr-mem-p">${esc(p)}</p>`).join("")}
      <div class="vr-mem-cols">
        <div class="vr-mem-col"><div class="vr-mem-lbl">Your patterns</div><ul>${cm.traits.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>
        <div class="vr-mem-col"><div class="vr-mem-lbl">Your blind spots</div><ul>${cm.blindSpots.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>
      </div>
      <div class="vr-mem-rel">
        <div class="vr-mem-cell"><span>Tenure</span><b>${esc(cm.relationship.tenure)}</b></div>
        <div class="vr-mem-cell"><span>Rooms together</span><b>${cm.relationship.rooms}</b></div>
        <div class="vr-mem-cell"><span>Last seen</span><b>${esc(cm.relationship.lastSeen)}</b></div>
      </div>
    </div>`;
  } else {
    const notes = notesFor(a.id);
    const rows = notes.length
      ? notes.map((n, i) => `<div class="vr-note"><span class="vr-note-text">${esc(n)}</span><button type="button" class="vr-cred-del" data-note-rm="${i}" aria-label="Forget">${ICON.x}</button></div>`).join("")
      : `<div class="vr-cred-empty">No notes yet.</div>`;
    memoryHtml = `<div class="vr-set-list vr-note-list">${rows}</div><p class="vr-set-hint">Carried across rooms · accumulates automatically after each session.</p>`;
  }
  const memTitle = isChair ? "Memory · about you" : "Memory · carried notes";

  // Rules · editable operating constraints (max 5).
  const rules = rulesFor(a.id);
  const atCap = rules.length >= RULES_MAX;
  const ruleRows = rules.length
    ? rules.map((body, i) => `<li class="vr-rule"><span class="vr-rule-num">${i + 1}</span><input type="text" class="vr-rule-input" data-rule="${i}" maxlength="120" value="${esc(body)}" placeholder="never preface · cite the load-bearing claim · …"><button type="button" class="vr-rule-rm" data-rule-rm="${i}" aria-label="Remove">${ICON.x}</button></li>`).join("")
    : `<li class="vr-rule-empty">No rules yet.</li>`;
  const rulesHtml = `<ol class="vr-rules">${ruleRows}</ol><button type="button" class="vr-cred-add" data-rule-add ${atCap ? "disabled" : ""}>${ICON.plus}<span>${atCap ? `Max ${RULES_MAX} rules` : "Add rule"}</span></button>`;

  const html = `
    <div class="vr-prof-head">
      ${avatarThumb(a, 84)}
      <div class="vr-prof-id">
        <div class="vr-prof-name">${esc(a.name)}</div>
        <div class="vr-prof-role">${m.roleTag} · ${m.handle}</div>
        <span class="vr-prof-status${statusCls}">${statusTag}</span>
      </div>
    </div>
    <p class="vr-prof-bio">${esc(m.bio)}</p>
    <div class="vr-set-group"><h4>Ability radar</h4><div class="vr-radar-wrap">${renderRadarSvg(ability)}</div><div class="vr-ab-list">${bars}</div></div>
    <div class="vr-set-group"><h4>Model</h4>
      <button type="button" class="vr-act-row" data-pick-model>${ICON.model}<span class="vr-act-label">${esc(model.name)}<em>${esc(model.deck)}</em></span><span class="vr-act-chev">${ICON.chev}</span></button>
    </div>
    <div class="vr-set-group"><h4>Activity</h4>${metrics}</div>
    <div class="vr-set-group"><h4>Skills · ${installed.length}/8</h4><div class="vr-skill-grid">${slots}</div></div>
    <div class="vr-set-group"><h4>Operating brief</h4><div class="vr-doc">${doc}</div></div>
    <div class="vr-set-group"><h4>${memTitle}</h4>${memoryHtml}</div>
    <div class="vr-set-group"><h4>Rules · ${rules.length}/${RULES_MAX}</h4>${rulesHtml}</div>
    ${currentRoom && !isChair ? `<button type="button" class="vr-convene${inRoom ? " is-ghost" : ""}" data-prof-toggle>${inRoom ? "Remove from this room" : "Add to this room"}</button>` : ""}`;
  return { title: "Director", html, mount(b) {
    const mp = b.querySelector("[data-pick-model]");
    if (mp) mp.addEventListener("click", () => pushModal("model"));
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
    const t = b.querySelector("[data-prof-toggle]");
    if (t) t.addEventListener("click", () => {
      const r = ROSTER.find((x) => x.id === a.id); if (!r) return;
      if (r.active && inRoomCount() <= 2) { toast("Keep at least two directors."); return; }
      r.active = !r.active;
      if (currentRoom) currentRoom.directorIds = ROSTER.filter((x) => x.active).map((x) => x.id);
      rebuildCast();
      closeModal();
    });
  } };
}

function renderModelPicker() {
  const id = profileAgentId;
  const a = CAST.find((c) => c.id === id) || ROSTER.find((r) => r.id === id);
  const curId = modelIdFor(id);
  const rows = MODEL_CATALOG.map((mo) => {
    const active = mo.id === curId;
    return `<div class="vr-cred-row${active ? " is-active" : ""}" data-model="${mo.id}">
      <button type="button" class="vr-cred-pick" data-pick aria-label="${active ? "Active" : "Select"}">${active ? ICON.check : ""}</button>
      <span class="vr-cred-body"><span class="vr-cred-name">${esc(mo.name)}</span><span class="vr-cred-meta">${esc(mo.deck)}</span></span>
    </div>`;
  }).join("");
  const html = `<div class="vr-set-group"><h4>Model · ${esc(a ? a.name : "Director")}</h4><div class="vr-set-list">${rows}</div></div>
    <p class="vr-set-hint">Drives this director's turns. Switching takes effect on the next round.</p>`;
  return { title: "Model", html, mount(b) {
    b.querySelectorAll("[data-model]").forEach((row) => row.addEventListener("click", () => {
      setModelFor(id, row.dataset.model);
      toast(`Model set · ${modelFor(id).name}.`);
      popModal();
    }));
  } };
}

/* New director · slimmed creation form mirroring the desktop
   new-agent modal: 3D portrait (regenerate) + model + name (→ handle)
   + intro + instruction. Rules / skills / model-change live in the
   profile after creation (already built). */
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
  if (!agentDraft) agentDraft = {
    name: "", role: "", bio: "", instruction: "", modelId: "sonnet-4-6",
    seed: (window.Avatar3DSnap ? window.Avatar3DSnap.randomSeed() : null),
  };
  const model = MODEL_CATALOG.find((mo) => mo.id === agentDraft.modelId) || MODEL_CATALOG[1];
  const handle = deriveHandle(agentDraft.name);
  const canCreate = !!(agentDraft.name || "").trim();
  const html = `
    <div class="vr-na-avatar">
      <div class="vr-na-portrait"><span class="vr-na-face">${newAgentInitials(agentDraft.name)}</span></div>
      <button type="button" class="vr-na-regen" data-na-regen>${ICON.regen}<span>Regenerate</span></button>
    </div>
    <button type="button" class="vr-act-row" data-pick-amodel>${ICON.model}<span class="vr-act-label">${esc(model.name)}<em>${esc(model.deck)}</em></span><span class="vr-act-chev">${ICON.chev}</span></button>
    <div class="vr-set-group"><h4>Name <span class="vr-na-count" data-count-name>${(agentDraft.name || "").length}/32</span></h4>
      <input class="vr-input" data-aname maxlength="32" placeholder="e.g. Contrarian" value="${esc(agentDraft.name)}">
      <p class="vr-set-hint">Handle · <span class="vr-na-handle">${esc(handle)}</span></p></div>
    <div class="vr-set-group"><h4>Role tag</h4><input class="vr-input" data-arole maxlength="24" placeholder="e.g. Devil's advocate" value="${esc(agentDraft.role)}"></div>
    <div class="vr-set-group"><h4>Intro <span class="vr-na-count" data-count-bio>${(agentDraft.bio || "").length}/280</span></h4>
      <textarea class="vr-input vr-textarea" data-abio maxlength="280" placeholder="One line on how they think">${esc(agentDraft.bio)}</textarea></div>
    <div class="vr-set-group"><h4>Instruction</h4>
      <textarea class="vr-input vr-textarea tall" data-ainstr placeholder="Role · objectives · voice · boundaries the director should follow">${esc(agentDraft.instruction)}</textarea>
      <p class="vr-set-hint">Sets how this director reasons and what it refuses. Editable later from the profile.</p></div>
    <button type="button" class="vr-convene" data-create-agent ${canCreate ? "" : "disabled"}>Create director</button>`;
  return { title: "New director", html, mount(b) {
    paintDraftAvatar(b);
    const regen = b.querySelector("[data-na-regen]");
    if (regen) regen.addEventListener("click", () => {
      if (!window.Avatar3DSnap) { toast("3D portraits need WebGL."); return; }
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
      const cb = b.querySelector("[data-create-agent]"); if (cb) cb.disabled = !agentDraft.name.trim();
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
  const rows = MODEL_CATALOG.map((mo) => {
    const active = mo.id === cur;
    return `<div class="vr-cred-row${active ? " is-active" : ""}" data-amodel="${mo.id}">
      <button type="button" class="vr-cred-pick" aria-label="${active ? "Active" : "Select"}">${active ? ICON.check : ""}</button>
      <span class="vr-cred-body"><span class="vr-cred-name">${esc(mo.name)}</span><span class="vr-cred-meta">${esc(mo.deck)}</span></span>
    </div>`;
  }).join("");
  return { title: "Model", html: `<div class="vr-set-group"><h4>Director model</h4><div class="vr-set-list">${rows}</div></div>
    <p class="vr-set-hint">The LLM that powers this director's turns.</p>`, mount(b) {
    b.querySelectorAll("[data-amodel]").forEach((row) => row.addEventListener("click", () => {
      if (agentDraft) agentDraft.modelId = row.dataset.amodel;
      popModal();
    }));
  } };
}
async function createAgent() {
  const name = (agentDraft.name || "").trim();
  if (!name) { toast("Give your director a name."); return; }
  const id = "a" + Math.floor(Date.now());
  let avatar3d = { model: "casual" };
  let avatarPath = "";
  if (agentDraft.seed) {
    try { const av = await import("/avatar-3d.js"); avatar3d = av.deriveDefaultAvatarConfig(agentDraft.seed); } catch (_) { /* keep fallback */ }
    if (window.Avatar3DSnap) {
      avatarPath = window.Avatar3DSnap.cacheGet(agentDraft.seed) || "";
      if (!avatarPath) { try { avatarPath = (await window.Avatar3DSnap.generate(agentDraft.seed)) || ""; } catch (_) { /* */ } }
    }
  }
  const agent = { id, name, roleKind: "director", avatarPath, avatar3d };
  CAST.push(agent);
  ROSTER.push({ ...agent, active: false });
  AGENTS_META[id] = {
    handle: deriveHandle(name),
    roleTag: (agentDraft.role || "").trim() || "Director",
    voice: "—",
    bio: (agentDraft.bio || "").trim(),
    instruction: (agentDraft.instruction || "").trim(),
    ab: { Dissent: 5, Rigor: 5, Empathy: 5, Pattern: 5, Narrative: 5, Decisiveness: 5 },
  };
  setModelFor(id, agentDraft.modelId || "sonnet-4-6");
  agentDraft = null;
  closeModal();
  if (homeTab === "directors") renderDirectors();
  toast(name + " added to your directors.");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
