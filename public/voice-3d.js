/* ═══════════════════════════════════════════════════════════════════
   voice-3d.js · Phase 1 · voxel pixel-art round-table renderer.
   ═══════════════════════════════════════════════════════════════════

   What this does
   ──────────────
   Replaces the 2D pixel-art SVG round-table inside `.roundtable-stage`
   with a three.js WebGL scene: voxel wood table at the centre, voxel
   chairs ringed around it on the existing seat-position math (see
   `app.computeSeatPositions`), and director avatars rendered as plane
   billboards textured from the live agent record's `avatarPath`.

   What this does NOT do (Phase 1)
   ───────────────────────────────
   · No interactions (no hover, no click, no orbit controls).
   · No state animations (no idle bob, no thinking float, no speaking glow).
   · No name plate or speech bubble. Those will come back via CSS2DRenderer
     in Phase 2 / 3 once the scene reads right.
   · The outer `.ib-stack` (input bar / queue strip / subtitle) is
     untouched. Only the stage interior swaps.

   Public surface
   ──────────────
   `window.VoiceStage3D = { isSupported, mount, update, unmount }`.
   The caller (app.js renderRoundTable) checks the toggle, calls
   `mount` once per room open, then `update` on every state change
   (same cadence the 2D path re-renders the seats grid).

   Toggle
   ──────
   Retired (2026-05). The voice room is 3D-only · `app.js`
   `renderRoundTable` always calls into VS3D when WebGL is available.
   The old `localStorage["boardroom.stage3d"]` key is no longer
   consulted; any cached value is inert.

   Why a separate file
   ───────────────────
   three.js is 356 KB · we don't want to inflate the cold app.js boot.
   This module loads as a separate `<script type="module">` and only
   imports three when actually used. The 2D fallback path doesn't
   touch this file at all. */

import * as THREE from "/vendor/three.module.min.js";
import { OrbitControls } from "/vendor/OrbitControls.js";
import { RoomEnvironment } from "/vendor/RoomEnvironment.js";
import { loadAvatar3D, buildAvatar3D, isAvatar3DReady, deriveDefaultAvatarConfig, AVATAR_MODELS } from "/avatar-3d.js";

(function () {
  /* ── State held across mount lifecycle ─────────────────────── */
  let stageEl = null;          // The `.roundtable-stage` host element.
  let canvasEl = null;         // The injected WebGL canvas.
  let renderer = null;         // THREE.WebGLRenderer
  let scene = null;            // THREE.Scene
  let camera = null;           // THREE.PerspectiveCamera
  let controls = null;         // OrbitControls · damped orbit + zoom + pan.
  let resizeObserver = null;   // For canvas auto-resize on stage resize.
  let rafId = 0;               // requestAnimationFrame handle.
  let visible = true;          // Pause RAF when document.visibilitychange
                               // fires hidden (tab in background).
  let elementVisible = true;   // Pause RAF when the stage element itself
                               // is off-screen / display:none (user
                               // switched away from the voice room view).
                               // Without this, RAF + WebGL keep ticking
                               // on a hidden canvas — measurable CPU/GPU
                               // burn on low-end machines.
  let intersectionObserver = null;

  /* ── Loading overlay state ──────────────────────────────────
     Shown synchronously inside mount() BEFORE WebGL init so the
     user sees a "something is loading" cue instead of a black
     box during the ~200-800 ms gap until the first frame paints
     with avatar textures. Three surfaces benefit: marketing home
     hero, in-app round-table on room open (mobile + desktop),
     and the onboarding voice banner. Hidden on the first
     `update()` call (which is when the populated scene is about
     to paint) with a safety-net timeout in case `update()` is
     never reached. */
  let loadingEl = null;
  let loadingHideTimer = 0;
  let loadingFirstUpdateSeen = false;

  /** Voxel pixel resolution · how many world units per "voxel cell".
   *  Drives the visual chunkiness — bigger value = chunkier blocks. */
  const VOXEL = 0.18;

  /** Stage extents in world units · the existing seat math gives
   *  positions in % (x: 0..100, y: 0..100). We map that strip into a
   *  centered XZ rectangle of these half-extents (`x` left/right,
   *  `z` near/far). Tuned tight against table+chair gap so side
   *  directors visually hug the table edge (matches the 2D layout
   *  where chairs sit at the table boundary, not stranded mid-stage):
   *    · side directors at y ≈ 38% → wz ≈ ±1.38 (HALF_Z=6) ≈ table half-D + chair + small gap
   *    · side directors at x ≈ 86% → wx ≈ ±4.00 (HALF_X=5.5) ≈ table half-W + chair + small gap
   *    · top director  at y ≈ 27% → wz ≈ ±2.76 (further back, natural arc)
   *    · chair / user  at y = 65% → wz ≈ ±1.80 (in front, full gap to table) */
  const STAGE_HALF_X = 5.5;
  const STAGE_HALF_Z = 6.0;

  /** Per-seat world units · 0.6 wide, 1.6 tall (head clearance), depth 0.6.
   *  Same proportions as the 2D `.rt-seat` 88×110 px box. */
  const CHAIR_WIDTH = 0.8;
  const CHAIR_DEPTH = 0.8;
  const CHAIR_SEAT_H = 0.45;

  /** Director sprite · the rasterised SVG canvas is 1:1 (256×256),
   *  so the sprite MUST also be 1:1 — otherwise nearest-neighbour
   *  sampling stretches pixels non-uniformly and the character
   *  reads as "shattered" / pixel-distorted. SPRITE_W and SPRITE_H
   *  are kept equal; size + centre tuned so the character sits
   *  inside the chair (feet just above the seat slab, head crest
   *  near the chair-back top). */
  const SPRITE_W = 1.05;
  const SPRITE_H = 1.05;
  const SPRITE_CENTER_Y = 1.05;

  /** Tone → floor palette · matches the 2D `.roundtable-stage[data-floor=...]`
   *  rules in index.html so the 3D scene's ambient colour reads as the
   *  same room mood (brainstorm green / constructive graphite / etc).
   *  These are the floor BG colour from the existing CSS — the more
   *  textured pixel pattern there is a 128×128 SVG tile; in Phase 1 we
   *  just pick the dominant fill, Phase 4 will add the tile texture. */
  const FLOOR_COLOR_BY_TONE = {
    brainstorm:   "#5E6B47",
    constructive: "#4D4136",
    research:     "#C8B89A",
    debate:       "#3A2F26",
    critique:     "#3E362C",
  };

  /** Tone → wall palette · 5 boardroom styles paired to each floor.
   *  Goal is "complement, don't clash" — light floor gets darker
   *  panelled walls, dark floor gets warm contrast trim.
   *    · brainstorm   · sky-blue garden walls (open / outdoor)
   *    · constructive · graphite glass partitions (modern corporate)
   *    · research     · light-oak library walls
   *    · debate       · warm oak wainscot (forum / chamber)
   *    · critique     · mahogany executive panel
   *  Each entry: { wall, trim (baseboard), rail (chair-rail accent) }.
   *  NOTE · brainstorm / constructive / critique entries are LEGACY
   *  fallbacks · refreshWallColors swaps in procedural textures
   *  (red brick / mossy stone / sandstone) for those tones. The
   *  palette stays around so any client that hits the painted-
   *  material branch (texture build failure, future reduced-detail
   *  mode) still gets a coherent fallback colour. debate uses the
   *  flat painted-wall path · the bright warm-oak tone reads as a
   *  lit forum panel without needing a procedural texture. */
  const WALL_PALETTE_BY_TONE = {
    brainstorm:   { wall: 0xA3B8C4, trim: 0x5F7A8A, rail: 0x7B97A8 },
    constructive: { wall: 0x6E7480, trim: 0x42454D, rail: 0x575C66 },
    research:     { wall: 0xD9CBAD, trim: 0x8B7355, rail: 0xB29874 },
    // Bumped from 0x4E3A2A · the prior tone read as nearly black under
    // the scene's ambient + key lighting, making the debate room feel
    // closed and lightless. 0x856444 is a clear step up the warm-oak
    // ladder: still distinctly darker than research's light oak, but
    // bright enough that walls + trim + rail all register as wood
    // colour rather than silhouette. Trim and rail nudged in
    // proportion so the contrast ratio between layers stays consistent.
    debate:       { wall: 0x856444, trim: 0x4A3422, rail: 0x6B4F36 },
    critique:     { wall: 0x6B3F2F, trim: 0x2A1612, rail: 0x4A2A20 },
  };

  /** Per-tone table finish · the shared table materials are retinted
   *  (refreshTable) to echo each room without re-modelling the table.
   *  `body` = mid slab, `top` = upper rim, `shade` = floor shadow strip.
   *  constructive flips the top to a translucent GLASS slab over a steel
   *  body (the one room that reads as a different material, not just a
   *  different wood). Tones track the room's walls / floor so the table
   *  belongs to the room rather than floating as a neutral default. */
  const TABLE_PALETTE_BY_TONE = {
    brainstorm:   { body: 0x3E6B4A, top: 0x4F8460, shade: 0x264A32, material: "plastic" }, // deep forest-green plastic
    debate:       { body: 0x6E4F33, top: 0x9E7A4E, shade: 0x3F2C1B, material: "wood" },    // deep chamber oak · matches the debate wall planks
    research:     { body: 0x9A7C50, top: 0xC2A06A, shade: 0x5A4530, material: "wood" },    // light library oak
    constructive: { body: 0x4A525C, top: 0x9FB4C2, shade: 0x2E333A, material: "glass" },   // steel frame + glass top
    critique:     { body: 0x4A2A20, top: 0x6B3F2F, shade: 0x2A1612, material: "wood" },    // dark mahogany
  };

  /** Per-tone velvet for the sheen armchair (buildSheenChair) · every
   *  room uses the upholstered chair, dressed in its own fabric so the
   *  seating belongs to the room. `body` = cushions/back, `lit` = the
   *  lighter sheen-catch panel, `shade` = arms/shell, `leg` = splayed
   *  legs, `specular` = the Phong sheen highlight.
   *    brainstorm   · warm ochre on walnut    (forest-green/cream room)
   *    constructive · cool slate-blue, charcoal metal legs (steel/glass)
   *    debate       · oxblood club velvet on dark walnut (deep oak chamber)
   *    research     · bottle-green reading velvet on oak  (warm library)
   *    critique     · graphite velvet on brass legs (dark mahogany + brass) */
  const SHEEN_PALETTE_BY_TONE = {
    brainstorm:   { body: 0xBE8A3C, lit: 0xD8A856, shade: 0x9C6F2E, leg: 0x4A3526, specular: 0x4A3A1E },
    constructive: { body: 0x55677A, lit: 0x86A0B6, shade: 0x3C4A59, leg: 0x33373D, specular: 0x2E3942 },
    debate:       { body: 0x8A4038, lit: 0xA85A4E, shade: 0x5E2A24, leg: 0x3A2418, specular: 0x3A201A },
    research:     { body: 0x3D5A45, lit: 0x577E63, shade: 0x274033, leg: 0x6B4A2C, specular: 0x223A2C },
    critique:     { body: 0x3C3C42, lit: 0x5C5C64, shade: 0x28282E, leg: 0x8A6A2E, specular: 0x3A3A40 },
  };

  /** Wood palette for the table · matches `.rt-table-*` CSS tokens
   *  (rim / mid / hi / shadow). The 2D table is a flat SVG; the 3D
   *  version uses these for top-face, side-face, and edge-highlight
   *  materials so the wood reads with the same family of browns. */
  const WOOD = {
    rim:   0x3A2410,
    mid:   0x7A5230,
    hi:    0xB8884E,
    shade: 0x4A2E18,
  };

  /** Texture cache · avatars share textures across re-renders so we
   *  don't spam the loader on every seat repaint. Keyed by avatarPath. */
  const texCache = new Map();
  const textureLoader = new THREE.TextureLoader();

  /** Avatar sprites currently in the scene · keyed by agentId. We
   *  diff on update() so adding / removing a director doesn't
   *  recreate every sprite. */
  let chairGroup = null;
  let avatarGroup = null;
  let floorMesh = null;
  let tableGroup = null;
  // 3D-avatar integration · the rigged GLB figures replace the sprite
  // billboards on the chairs. Models load async; until ready,
  // buildDirectorFigure falls back to the sprite. `_lastPositions` /
  // `_lastMode` are stashed each update() so the preload completion can
  // re-fire a full rebuild and swap sprites → 3D in one pass.
  let avatar3dReady = false;
  let avatar3dPreloadStarted = false;
  let _lastPositions = null;
  let _lastMode = null;
  const AVATAR_FIG_HEIGHT = 1.55; // feet at y=0; head clears the chair back
  const AVATAR_SEAT_LIFT = 0.4;   // raise 3D figures so the body clears the seat cushion
  const MOUTH_OPEN = 0.062;       // mouth-overlay max height (fully open) while talking
  const MOUTH_MIN = 0.014;        // mouth-overlay min height (closed-mouth line) while talking
  /** Table materials · created fresh in buildTable() each mount and
   *  retinted per tone by refreshTable(). Module-scope so refreshTable
   *  can reach them; nulled on unmount (rebuilt next mount). */
  let tableBodyMat = null;
  let tableTopMat = null;
  let tableShadeMat = null;
  /** Grayscale surface-grain texture for the table · multiplies the
   *  per-tone material colour (white base = colour unchanged, darker
   *  streaks = subtle grain) so one neutral texture works for every
   *  wood / plastic / steel tint. Built lazily in refreshTable, applied
   *  as `.map` to the opaque body / top (skipped on translucent glass /
   *  acrylic tops so see-through surfaces stay clean). */
  let tableGrainTex = null;
  /** Per-room 3D furniture · real box meshes against the back wall (NOT
   *  painted into the wall texture) so each room has a signature piece
   *  with real depth at a scale that matches the table — brainstorm a
   *  chest + sofa, debate a lectern, research a bookcase, constructive a
   *  steel credenza, critique a mahogany credenza + globe. Rebuilt by
   *  refreshFurniture() only when the tone changes; `roomFurnitureMode`
   *  tracks what's currently built so an unchanged tone is a no-op. */
  let roomFurniture = null;
  let roomFurnitureMode = null;
  /** Wall materials · shared across all wall / trim / rail meshes
   *  so a single colour swap (in refreshWallColors) repaints the
   *  whole room when the tone changes. Lazily created in
   *  buildBoardroomWalls() so the THREE import is guaranteed
   *  resolved by the time we construct materials. */
  let wallMat = null;
  let trimMat = null;
  let railMat = null;
  /** Sub-group holding baseboard + chair-rail meshes · split out so
   *  we can hide it as a unit when a tone swaps in a painted wall
   *  texture (brainstorm → brick, constructive → stone) where a
   *  horizontal trim band would slice the painting. */
  let wallTrimGroup = null;
  /** Lazy procedural CanvasTextures · painted on first use, re-used
   *  across mounts. brainstorm → red brick, constructive → cool
   *  stone block with moss vines (modelled after icons/wall1.png),
   *  critique → warm sandstone / amber brick (modelled after
   *  icons/wall2.png). */
  let brainstormWallTexture = null;
  let constructiveWallTexture = null;
  let critiqueWallTexture = null;
  // debate → warm-oak forum/chamber paneling with tall daylight
  // windows (mullions + sills), a chair rail, and frame-and-panel
  // wainscot painted in. Same lazy module-singleton lifecycle as the
  // other three; the texture supplies its own rail/baseboard so the
  // debate branch hides `wallTrimGroup` like the other textured tones.
  let debateWallTexture = null;
  // research → light-oak library · built-in bookcases (rows of varied
  // book spines with gilt titles), oak shelf boards + case uprights, a
  // crown, and a cabinet plinth. Scholarly, warm-neutral. Same lazy
  // module-singleton lifecycle; supplies its own trim so the research
  // branch hides `wallTrimGroup`.
  let researchWallTexture = null;
  /** Procedural plant-baseboard texture · dense foliage band that
   *  hugs the wall-floor seam in the constructive room (replaces a
   *  cold sterile cove with a "boardroom is lived-in" green band).
   *  Lazy + cached, same lifetime as the wall textures. */
  let plantBaseboardTexture = null;
  /** Shared material + group for the 3 plant-baseboard plane meshes
   *  (back / left / right). Toggled via group.visible from
   *  refreshWallColors. */
  let plantBaseboardMat = null;
  let plantBaseboardGroup = null;
  /** Wooden baseboard variant · same lifecycle as plant baseboard
   *  but a solid walnut-plank trim band (no transparency). Shown
   *  under the critique stone wall to anchor the sandstone visually
   *  to a warm wood floor edge. */
  let woodBaseboardTexture = null;
  let woodBaseboardMat = null;
  let woodBaseboardGroup = null;

  /** DOM overlay layer · sits ABOVE the WebGL canvas as a sibling
   *  of it inside the stage. Hosts name-plates and speaker bubbles
   *  positioned via per-frame 3D→screen projection. Reusing the
   *  legacy `.rt-name` / `.rt-bubble` CSS classes keeps the visual
   *  vocabulary identical to the 2D round-table and means future
   *  CSS polish lands in one place. */
  let overlayEl = null;
  /** Per-seat overlay records · one entry per seated member built in
   *  rebuildSeats. Each carries the head world position (THREE.Vector3)
   *  that the RAF tick projects to screen coords on every frame. */
  let overlaySeats = [];
  /** Current speaker state · driven by the caller via update().
   *  Used to (a) pick which seat shows a bubble, (b) decide bubble
   *  text + styling (thinking vs speaking). */
  let activeSpeakerId = null;
  let activeSpeakerState = null; // "thinking" | "speaking" | null
  let activeSpeakerLabels = { thinking: "thinking", speaking: "speaking" };
  /** Reusable projection vec3 · avoids per-frame allocations inside
   *  the billboard / position-update loop. */
  const projVec = (typeof THREE !== "undefined") ? new THREE.Vector3() : null;

  /** Reduced-motion · honour the OS setting by holding the figure at
   *  full height (no squash-blink). Read once at load; matches the 2D
   *  path's `@media (prefers-reduced-motion: reduce)` blink opt-out. */
  const prefersReducedMotion = (typeof matchMedia === "function")
    && matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Picking · click anywhere on a director sprite to open the
   *  agent overlay (same modal the 2D head-cast avatar opens via
   *  document delegation). One Raycaster + one Vector2 reused across
   *  all events so click handling is allocation-free.
   *  `clickStart` tracks the mousedown position so we can tell a
   *  click apart from a drag (OrbitControls owns drag; we only
   *  trigger the overlay if the cursor barely moved). */
  const raycaster = (typeof THREE !== "undefined") ? new THREE.Raycaster() : null;
  const pickerVec = (typeof THREE !== "undefined") ? new THREE.Vector2() : null;
  let clickStart = null;
  let clickHandlersBound = false;

  /** Chair vote pop overlay · separate from per-seat overlays because
   *  it's a single DOM card (not per-seat) and needs pointer-events
   *  enabled (the user clicks the End-round / Continue / Adjourn
   *  buttons inside it). Anchored to the chair seat's world position
   *  (set in rebuildSeats when the chair seat is encountered) and
   *  projected each frame like other overlays. */
  let chairVotePopEl = null;
  let chairAnchorWorld = null;
  let lastVotePopHtml = "";

  /** User-spoke bubble · driven by `state.userBubble` in update().
   *  When non-null the user seat shows their just-typed message as
   *  a bubble (mirrors the 2D `data-rt-user-bubble` element). Null
   *  means hide; the shape is `{ text, progress }`. */
  let activeUserBubble = null;

  /** User wait-mark state · driven by `state.userWait` in update().
   *  When true and the user has typed a message that's queued
   *  behind the current speaker, the user seat shows a "⌛ WAIT"
   *  pill so they know their input is parked. */
  let activeUserWait = false;

  /** Entry animation · played ONCE on mount (or whenever the stage
   *  is freshly opened after an unmount). Camera dollies from a
   *  zoom-out start position to the resting view over ~0.6s and
   *  each chair / figure pops in (scale 0 → 1) with a slight
   *  bounce, staggered by seat index. After the duration ends the
   *  animation state goes idle and the per-frame tick early-outs. */
  const ENTRY_DURATION_MS = 700;
  const ENTRY_STAGGER_MS = 70;
  let entryStartTime = 0;
  let entryActive = false;
  /** Resting camera position the entry animation lerps TO · captured
   *  in mount() after the resting camera is positioned. */
  let cameraRestPos = null;

  /** ── Speaker-change camera pulse ──────────────────────────────
   *  Every time `activeSpeakerId` flips while the new speaker is
   *  actively `speaking`, the camera does one quick cinematic move:
   *  dollies + lifts toward the new speaker's seat, peaks at ~45%
   *  of the duration, then eases back to the resting position. Reads
   *  as a "cut to the next director" scene swap.
   *
   *  · Disabled when the entry animation is still running (the entry
   *    sequence owns the camera fully for its first 700-1100ms).
   *  · OrbitControls is muted for the pulse window so the user's
   *    manual orbit doesn't fight the lerp; restored on completion.
   *  · Skipped when the new speaker is the user (`isUser`) — the
   *    user has no seat figure worth focusing on. */
  const CAMERA_PULSE_DURATION_MS = 1200;
  const CAMERA_PULSE_FORWARD = 5.0; // world units shifted toward the seat
  const CAMERA_PULSE_LIFT = 1.4;    // world units the camera rises mid-pulse
  let cameraPulseActive = false;
  let cameraPulseStart = 0;
  let cameraPulseDirX = 0;
  let cameraPulseDirZ = 0;
  /** Tracks the speaker id we last triggered a pulse for so that
   *  repeated `update()` calls inside the same turn don't re-fire
   *  the animation every frame. Initialised to `undefined` so the
   *  FIRST recognised speaker (post-mount entry) DOES skip the pulse
   *  — entry animation already provides the cinematic arrival. */
  let lastPulseSpeakerId = undefined;
  /** Camera params resolved at mount() time · default to the legacy
   *  app values (18 unit distance, 30° elevation, lookAt y = 0.5)
   *  unless `mount(host, { camera: { ... } })` overrides them. The
   *  marketing homepage uses lower elevation + closer pull so the
   *  table fills the 21/9 letterbox frame. */
  let _mountCamDistance = 18;
  let _mountCamElevDeg = 30;
  let _mountCamLookY = 0.5;

  /** (Removed) cylindrical billboard registry · with the head now a
   *  voxel sculpture (eyes/glasses/mustache as voxel features), the
   *  chair-aligned rotation already lands the head's front-face
   *  features toward the camera. Sprite-head era needed this so the
   *  texture stayed visible; voxel head doesn't. */

  /* ── Loading overlay ───────────────────────────────────────────
     Painted into `host` synchronously from mount() so the user
     sees a pulsing indicator instead of a black box while WebGL
     warms up and avatar SVGs decode. Hidden when the first
     `update()` call lands (scene is about to populate) with a
     safety-net auto-hide at 2.5 s in case update() never fires
     (e.g. caller mounts then immediately unmounts). */
  function ensureLoadingStyle() {
    if (document.getElementById("voice-3d-loading-style")) return;
    const st = document.createElement("style");
    st.id = "voice-3d-loading-style";
    st.textContent = `
      [data-rt-3d-loading] {
        position: absolute; inset: 0; z-index: 3;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0, 0, 0, 0.42);
        pointer-events: none;
        opacity: 1; transition: opacity 320ms ease;
        font-family: ui-monospace, SFMono-Regular, Menlo, "JetBrains Mono", monospace;
      }
      [data-rt-3d-loading].is-hiding { opacity: 0; }
      [data-rt-3d-loading-inner] {
        display: inline-flex; flex-direction: column; align-items: center; gap: 12px;
      }
      [data-rt-3d-loading-bar] {
        display: inline-flex; gap: 5px; image-rendering: pixelated;
      }
      [data-rt-3d-loading-bar] i {
        width: 8px; height: 8px;
        background: rgba(255, 255, 255, 0.92);
        display: inline-block;
        animation: rt3d-load-pulse 1.05s ease-in-out infinite;
      }
      [data-rt-3d-loading-bar] i:nth-child(2) { animation-delay: 0.14s; }
      [data-rt-3d-loading-bar] i:nth-child(3) { animation-delay: 0.28s; }
      [data-rt-3d-loading-label] {
        font-size: 10px;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.78);
      }
      @keyframes rt3d-load-pulse {
        0%, 70%, 100% { opacity: 0.22; transform: translateY(0); }
        35%          { opacity: 1;    transform: translateY(-4px); }
      }
    `;
    document.head.appendChild(st);
  }

  function showLoadingOverlay(host, label) {
    ensureLoadingStyle();
    const el = document.createElement("div");
    el.setAttribute("data-rt-3d-loading", "");
    // Use textContent for the label · caller-supplied string, must
    // not interpolate as HTML. The 8-bit dot trio is fixed markup.
    const inner = document.createElement("span");
    inner.setAttribute("data-rt-3d-loading-inner", "");
    inner.innerHTML = `<span data-rt-3d-loading-bar><i></i><i></i><i></i></span>`;
    if (label) {
      const cap = document.createElement("span");
      cap.setAttribute("data-rt-3d-loading-label", "");
      cap.textContent = String(label);
      inner.appendChild(cap);
    }
    el.appendChild(inner);
    host.appendChild(el);
    return el;
  }

  function hideLoadingOverlay() {
    if (loadingHideTimer) {
      clearTimeout(loadingHideTimer);
      loadingHideTimer = 0;
    }
    const el = loadingEl;
    loadingEl = null;
    if (!el) return;
    el.classList.add("is-hiding");
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 380);
  }

  /* ── Public API ─────────────────────────────────────────────── */
  /** WebGL availability cache · the test creates a throw-away canvas
   *  + GL context, both of which count against Chrome's per-tab WebGL
   *  context cap (~16). With this called once per renderRoundTable,
   *  a chair-handoff SSE burst (dozens of renders in quick succession)
   *  pushes the cap, makes `getContext("webgl")` momentarily return
   *  null → `use3d` evaluates false → 3D unmounts and the room
   *  visibly flips to the 2D fallback for a few seconds until the
   *  throw-away canvases get GC'd. Caching the first definitive
   *  answer makes subsequent checks free and removes the flicker.
   *  Availability doesn't change at runtime so the cache is safe. */
  let _isSupportedCache = null;
  function isSupported() {
    if (_isSupportedCache !== null) return _isSupportedCache;
    try {
      const c = document.createElement("canvas");
      _isSupportedCache = !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch (_) {
      _isSupportedCache = false;
    }
    return _isSupportedCache;
  }

  function mount(host, opts) {
    if (!host || !isSupported()) return false;
    if (stageEl === host && renderer) return true; // idempotent
    if (stageEl) unmount();
    stageEl = host;
    // Optional camera overrides · the marketing homepage uses these
    // to crop the view in tighter and drop the elevation a touch.
    // The app passes nothing → defaults match the legacy 30°/18-unit
    // view. Stored on closure-level state so the entry animation
    // (which lerps INTO the resting camera) reads the same values.
    const camOpts = (opts && opts.camera) || {};
    if (typeof camOpts.distance === "number" && camOpts.distance > 0) _mountCamDistance = camOpts.distance;
    else _mountCamDistance = 18;
    if (typeof camOpts.elevationDeg === "number") _mountCamElevDeg = camOpts.elevationDeg;
    else _mountCamElevDeg = 30;
    if (typeof camOpts.lookAtY === "number") _mountCamLookY = camOpts.lookAtY;
    else _mountCamLookY = 0.5;

    // Mark the stage so CSS can hide the legacy 2D children
    // (the `<svg.rt-table>`, the `[data-rt-seats]` grid, etc) without
    // removing them from the DOM — keeping them around means the
    // 2D fallback path can take over instantly if we ever unmount.
    stageEl.classList.add("is-3d");

    // Loading overlay · drop in BEFORE we touch WebGL so the user
    // never sees a black void during the shader-compile + avatar-
    // fetch gap. Optional `opts.loadingLabel` lets callers stamp a
    // context-appropriate caption (e.g. "Convening" on onboarding).
    // Set `opts.loading: false` to suppress entirely · the marketing
    // home uses this because the poster img already covers the gap
    // (overlaying a darkening veil on the poster would just dim it).
    loadingFirstUpdateSeen = false;
    const wantsLoading = !(opts && opts.loading === false);
    if (wantsLoading) {
      const loadingLabel = (opts && typeof opts.loadingLabel === "string") ? opts.loadingLabel : "";
      loadingEl = showLoadingOverlay(stageEl, loadingLabel);
      // Safety net · if the caller mounts but never calls update()
      // (e.g. they unmount in the same tick due to a race), the
      // overlay would linger forever. Auto-hide after 2.5 s.
      loadingHideTimer = setTimeout(() => hideLoadingOverlay(), 2500);
    }

    // DOM overlay layer · created BEFORE the canvas so the canvas
    // ends up the first child of the stage (background). The overlay
    // hosts every per-seat HTML element (nameplate, bubble) that we
    // position by projecting world coords to screen coords each
    // frame. pointer-events:none so it stays click-through to the
    // chrome / WebGL canvas underneath.
    overlayEl = document.createElement("div");
    overlayEl.setAttribute("data-rt-3d-overlay", "");
    overlayEl.style.cssText = [
      "position: absolute",
      "inset: 0",
      "pointer-events: none",
      "z-index: 1",
      "overflow: visible",
    ].join("; ");

    // Canvas host · sits underneath the stage's HUD / subtitle / vote
    // pop overlays so the existing DOM affordances still float on top
    // of the 3D scene. position absolute + inset 0 = full bleed.
    canvasEl = document.createElement("canvas");
    canvasEl.setAttribute("data-rt-3d-canvas", "");
    canvasEl.style.cssText = [
      "position: absolute",
      "inset: 0",
      "width: 100%",
      "height: 100%",
      "display: block",
      // Pointer-events enabled so OrbitControls can pick up drag /
      // wheel events. The DOM overlay layer (sibling, sits ABOVE in
      // DOM order) is `pointer-events: none` so it stays click-
      // through to the canvas underneath; interactive bits inside
      // the overlay (the vote pop card) re-enable pointer-events
      // on themselves.
      "pointer-events: auto",
      // Don't show the i-beam cursor over the canvas · grab cursor
      // reads as "I can drag this".
      "cursor: grab",
    ].join("; ");
    // Insert as the FIRST child of the stage so everything else paints
    // above it (subtitle, HUD log, vote pop, etc). Overlay goes right
    // after so it stacks on top of the canvas but still below the
    // existing in-stage UI like subtitle / vote pop / toast tray.
    if (stageEl.firstChild) stageEl.insertBefore(canvasEl, stageEl.firstChild);
    else stageEl.appendChild(canvasEl);
    canvasEl.parentNode.insertBefore(overlayEl, canvasEl.nextSibling);

    // Chair vote pop · single DOM card anchored over the chair's
    // head. Unlike the seat overlays this one needs pointer-events
    // enabled (user clicks the End-round / Continue / Adjourn
    // buttons inside it). Sits ABOVE the per-seat overlay in DOM
    // order so its click rect wins when overlapping a nameplate.
    chairVotePopEl = document.createElement("div");
    chairVotePopEl.setAttribute("data-rt-3d-vote-pop", "");
    chairVotePopEl.style.cssText = [
      "position: absolute",
      "top: 0", "left: 0",
      "transform: translate(-50%, -100%)",
      "pointer-events: auto",
      "display: none",
      "z-index: 2",
    ].join("; ");
    overlayEl.appendChild(chairVotePopEl);

    // ── three.js core ──
    renderer = new THREE.WebGLRenderer({
      canvas: canvasEl,
      // Smooth rigged-GLB avatars sit on the chairs now · antialias on
      // softens the voxel chairs/table slightly but the character edges
      // benefit far more than the props lose.
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    // ACES tone mapping · the avatar materials (MeshStandard + env map)
    // are authored for it. Exposure slightly above the customizer's 0.7
    // to partly compensate for ACES darkening the existing voxel props.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;

    scene = new THREE.Scene();
    // Image-based lighting · a PMREM-filtered RoomEnvironment gives the
    // avatars' skin/hair their gloss. Lambert/Phong props ignore env maps,
    // so the env contribution lands almost entirely on the avatars — kept
    // modest so it lifts them without washing out.
    {
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.25;
    }

    // Camera · matches the 2D view's orientation. The 2D layout is
    // a top-down rectangle with the long table edge running screen-
    // horizontal; this 3D camera sits on the +Z axis (frontal) at
    // 30° elevation so the table's X-axis long edge maps to the
    // screen's horizontal axis · directors land at the screen's
    // upper half (behind the table) and the chair / user land at
    // the lower half (in front). FOV 28 is narrow (telephoto) which
    // flattens depth and approximates an orthographic look without
    // losing the parallax that gives the scene its weight.
    camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    const camR = _mountCamDistance;
    const camTheta = Math.PI / 2;                                // 90° → camera on +Z axis (frontal)
    const camPhi = (90 - _mountCamElevDeg) * Math.PI / 180;      // elevation above horizon
    camera.position.set(
      camR * Math.sin(camPhi) * Math.cos(camTheta),
      camR * Math.cos(camPhi),
      camR * Math.sin(camPhi) * Math.sin(camTheta),
    );
    // Look at the table-zone height so the table sits visually
    // centred in the viewport · 0.5 is just above the floor, which
    // puts the table top + seated heads + chair backs roughly
    // around the viewport's vertical middle. (Was briefly 2.5
    // while the window experiment needed the upper wall in view ·
    // that experiment was reverted so we go back to table-centred.)
    camera.lookAt(0, _mountCamLookY, 0);
    // Stash the resting camera position so the entry animation
    // (kicked off at the end of mount) can lerp INTO this view.
    cameraRestPos = camera.position.clone();

    // OrbitControls · user-driven camera orbit + zoom. Damped for
    // a smooth glide feel (rather than 1:1 jittery follow). Clamps:
    //   · polarAngle ∈ [0.25, 1.35] rad · keeps camera above
    //     horizon (no flipping under the floor) and below straight-
    //     overhead (top-down view loses the 3D character).
    //   · distance ∈ [10, 28] · prevents zooming into the table or
    //     so far out the scene becomes a dot.
    //   · enablePan: false · panning the target away from the
    //     table breaks the "you're looking at the table" framing.
    controls = new OrbitControls(camera, canvasEl);
    controls.enableDamping = true;
    controls.dampingFactor = 0.10;
    controls.enablePan = false;
    controls.target.set(0, _mountCamLookY, 0);
    controls.minDistance = 10;
    controls.maxDistance = 28;
    controls.minPolarAngle = 0.25;     // ~14° from straight up (very high overhead)
    controls.maxPolarAngle = 1.35;     // ~77° from straight up (just above floor)
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 0.8;
    // Reflect drag state in the cursor.
    controls.addEventListener("start", () => { if (canvasEl) canvasEl.style.cursor = "grabbing"; });
    controls.addEventListener("end",   () => { if (canvasEl) canvasEl.style.cursor = "grab"; });

    // Lighting · warm key from front-top + cool fill from back-low +
    // ambient to lift shadow pits. Keeps the chunky voxel surfaces
    // legible without losing the "indoor lamp" mood.
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffe9c8, 0.92);
    key.position.set(4, 8, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x9ec0ff, 0.25);
    fill.position.set(-3, 3, -4);
    scene.add(fill);

    // Groups · each on its own so update() can clear+rebuild them
    // selectively without touching the static scene chrome.
    floorMesh = null;     // Built in update(state.mode).
    // Boardroom walls · static room shell. Built before the table /
    // chairs so they paint farther in depth order (irrelevant with
    // depth-testing on, but tidier and means transparent overlays
    // composite over a known background).
    scene.add(buildBoardroomWalls());
    tableGroup = buildTable();
    scene.add(tableGroup);
    // Table props · books, coffee cup, two mics on top of the
    // table. Added as a sibling group rather than a child of
    // tableGroup so future code that scales / moves the table by
    // itself doesn't drag the props out of place.
    scene.add(buildTableProps());
    chairGroup = new THREE.Group();
    scene.add(chairGroup);
    avatarGroup = new THREE.Group();
    scene.add(avatarGroup);

    // Decorative voxel plants · two corners. plant-1 (bushy philo)
    // back-right, plant-2 (snake-plant spears) front-left. Pulled
    // INWARD from the stage edge (0.95 → 0.70 ratio) so neither
    // plant hugs the viewport corner — the front-left plant in
    // particular sat too close to the sidebar boundary and read as
    // "clipped by the panel". Closer-to-centre positions keep both
    // plants fully on stage at every realistic chat-col width.
    scene.add(buildBushyPlant(STAGE_HALF_X * 0.78, STAGE_HALF_Z * -0.75));
    scene.add(buildSnakePlant(STAGE_HALF_X * -0.65, STAGE_HALF_Z * 0.60));

    // Per-room 3D furniture is built lazily by refreshFurniture() on the
    // first update() (once the tone is known) and rebuilt on tone change.

    // Resize handling · the stage is inside a flex chat-col, so its
    // pixel dimensions change as the user resizes the window or
    // collapses/expands the sidebar. ResizeObserver fires whenever
    // the stage box's size changes and we re-snap the renderer +
    // camera aspect.
    resizeRenderer();
    // Debounced resize · Electron window-drag fires ResizeObserver
    // dozens of times per second. Each `renderer.setSize()`
    // re-allocates the WebGL drawingBuffer, and the brief gap
    // between teardown and the next rAF render painted black on
    // top of the live scene, producing a strobe / flicker for the
    // duration of the drag. We coalesce trailing resizes on a 100 ms
    // timer so during a drag the canvas's CSS scales the existing
    // buffer (slightly stretched but stable) and only commits the
    // final size once the user stops resizing.
    resizeObserver = new ResizeObserver(() => scheduleResize());
    resizeObserver.observe(stageEl);

    // Pause the RAF render loop when the stage element scrolls out
    // of the viewport / is display:none (user navigated to a
    // different view). Without this the canvas keeps repainting
    // 60×/s on top of a hidden DOM node — measurable CPU + GPU
    // load that surfaces as the "I'm leaving the voice room, the
    // app pauses for a couple seconds" hitch on low-end machines.
    // We stopRaf entirely (instead of just skipping render inside
    // the tick) so the rAF callback itself isn't queued.
    elementVisible = true;
    if (typeof IntersectionObserver !== "undefined") {
      intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.target !== stageEl) continue;
          const wasVisible = elementVisible;
          elementVisible = entry.isIntersecting;
          if (elementVisible && !wasVisible) {
            // Becoming visible · resume the loop. Belt-and-braces
            // null-check `renderer` since a teardown could race.
            if (renderer && scene && camera) startRaf();
          } else if (!elementVisible && wasVisible) {
            // Going hidden · cut the loop.
            stopRaf();
          }
        }
      }, { root: null, threshold: 0 });
      intersectionObserver.observe(stageEl);
    }

    // Kick off the entry animation · camera dollies in + chairs /
    // figures scale up from 0. Drives off `entryStartTime` in the
    // RAF tick. Reset BEFORE startRaf so the first frame already
    // sees the start-of-animation state (camera pulled back).
    entryStartTime = (typeof performance !== "undefined" ? performance.now() : Date.now());
    entryActive = true;

    // Picking listeners · mousedown captures start position, click
    // does the actual raycast. Using `click` (rather than mouseup)
    // means the browser already filtered out drags for us — the
    // event only fires if mousedown + mouseup landed on the same
    // element with minimal movement. Belt-and-braces with our own
    // distance check, but click event is the primary gate.
    if (!clickHandlersBound) {
      canvasEl.addEventListener("mousedown", onCanvasMouseDown);
      canvasEl.addEventListener("click", onCanvasClick);
      console.log("[voice-3d] click handlers bound to canvas");
      clickHandlersBound = true;
    }

    // Safety net · if the GL context is ever lost (driver reset,
    // tab backgrounded too long, sibling page exceeded the context
    // cap before our forceContextLoss landed) tear everything down
    // so the very next renderRoundTable rebuilds against a fresh
    // context instead of rendering a black frame onto a dead one.
    // preventDefault() tells the browser we'll handle recovery
    // ourselves (no default "context restored" auto-rebind, which
    // we don't trust three.js to recover from cleanly).
    canvasEl.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      console.warn("[voice-3d] WebGL context lost · unmounting; next render will rebuild");
      try { unmount(); } catch (_) {}
    });

    // Pre-warm the WebGL pipeline · the first WebGLRenderer created
    // after an Electron / browser restart pays a one-time cost to
    // initialise the GL context, compile shaders, and upload mesh /
    // material buffers to the GPU. If the first rAF tick fires while
    // any of that is still happening, `renderer.render()` silently
    // produces an empty (pure black) frame and the user sees nothing
    // until something nudges another render — which in practice means
    // the user closes the overlay and reopens it. Forcing a synchronous
    // `compile()` + `render()` here means the warm-up cost is paid
    // BEFORE startRaf, and the very first rAF tick produces a real
    // frame. Wrapped in try/catch so a WebGL hiccup doesn't abort
    // mount · the rAF tick would retry the render anyway. The follow-
    // up render produces output even when the scene has only the
    // static chrome (walls / table / plants) because no chairs /
    // avatars have been added yet · those land via the first
    // VS3D.update() call after mount returns. */
    try {
      renderer.compile(scene, camera);
      renderer.render(scene, camera);
    } catch (_) { /* warm-up best-effort */ }

    // RAF loop · animations + render each frame.
    startRaf();

    // Preload the avatar GLB templates (best-effort, non-blocking). Until
    // they resolve, seats render the sprite fallback; once ready we re-fire
    // the last rebuild so the directors swap to their 3D figures.
    if (!avatar3dPreloadStarted) {
      avatar3dPreloadStarted = true;
      Promise.all(AVATAR_MODELS.map((m) => loadAvatar3D(m.id)))
        .then(() => {
          avatar3dReady = true;
          if (avatarGroup && _lastPositions) rebuildSeats(_lastPositions, _lastMode);
        })
        .catch((e) => { console.warn("[voice-3d] avatar3d preload failed; keeping sprites", e); });
    }

    return true;
  }

  function onCanvasMouseDown(e) {
    clickStart = { x: e.clientX, y: e.clientY };
    console.log("[voice-3d] mousedown at", e.clientX, e.clientY);
  }

  function onCanvasClick(e) {
    console.log("[voice-3d] click event fired", e.clientX, e.clientY,
      "· clickStart?", clickStart);
    if (!canvasEl || !raycaster || !pickerVec || !camera || !avatarGroup) {
      console.log("[voice-3d] click skipped · missing refs",
        { canvas: !!canvasEl, raycaster: !!raycaster, pickerVec: !!pickerVec, camera: !!camera, avatarGroup: !!avatarGroup });
      return;
    }
    // If we have a mousedown reference, check drag distance · the
    // browser already filters huge drags away from `click`, but for
    // borderline cases (3-8 px wobbles after a slow drag start) we
    // ALSO want to skip. If no mousedown was recorded, trust the
    // browser's click filter.
    if (clickStart) {
      const dx = e.clientX - clickStart.x;
      const dy = e.clientY - clickStart.y;
      if (dx * dx + dy * dy > 100) {
        console.log("[voice-3d] click skipped · drag move", dx, dy);
        clickStart = null;
        return;
      }
    }
    clickStart = null;
    // Raycast against the avatar group only · clicking the table,
    // chairs, walls, plants, etc shouldn't open anything.
    const rect = canvasEl.getBoundingClientRect();
    pickerVec.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pickerVec.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pickerVec, camera);
    const hits = raycaster.intersectObjects(avatarGroup.children, true);
    console.log("[voice-3d] raycast · NDC", pickerVec.x.toFixed(2), pickerVec.y.toFixed(2),
      "· hits", hits.length,
      "· avatarGroup children", avatarGroup.children.length);
    if (!hits.length) return;
    let node = hits[0].object;
    while (node && node.parent !== avatarGroup) node = node.parent;
    console.log("[voice-3d] hit type", hits[0].object.type,
      "· walked up to fig?", !!node);
    if (!node) return;
    const seat = overlaySeats.find((s) => s.fig === node);
    console.log("[voice-3d] resolved seat", seat ? seat.id : "(none)", "isUser?", seat && seat.isUser);
    if (!seat) return;
    if (seat.isUser) return;
    if (typeof window.openAgentOverlay === "function") {
      console.log("[voice-3d] opening agent overlay for", seat.id);
      window.openAgentOverlay(seat.id);
    } else {
      console.warn("[voice-3d] window.openAgentOverlay not defined");
    }
  }

  function unmount() {
    // Loading overlay cleanup · if we're unmounting before the
    // overlay had a chance to fade, yank it now so it doesn't
    // outlive the stage (the host's child list survives unmount
    // for the 2D fallback path; a stranded overlay would sit on
    // top of the 2D pixel art).
    if (loadingHideTimer) {
      clearTimeout(loadingHideTimer);
      loadingHideTimer = 0;
    }
    if (loadingEl && loadingEl.parentNode) {
      try { loadingEl.parentNode.removeChild(loadingEl); } catch (_) {}
    }
    loadingEl = null;
    loadingFirstUpdateSeen = false;
    stopRaf();
    if (resizeObserver) {
      try { resizeObserver.disconnect(); } catch (_) {}
      resizeObserver = null;
    }
    if (_resizeTimer) {
      clearTimeout(_resizeTimer);
      _resizeTimer = null;
    }
    if (controls) {
      try { controls.dispose(); } catch (_) {}
      controls = null;
    }
    if (renderer) {
      // `renderer.dispose()` releases JS-side resources but does NOT
      // free the underlying WebGL context. Chrome caps concurrent
      // contexts at ~16 · without forceContextLoss(), quickly
      // switching rooms accumulates contexts until the cap evicts
      // older ones, at which point the new room mounts onto an
      // already-lost context and renders black. Force-losing before
      // dispose makes the context release immediately so the next
      // mount always gets a fresh one.
      try { renderer.forceContextLoss(); } catch (_) {}
      try { renderer.dispose(); } catch (_) {}
      renderer = null;
    }
    if (canvasEl) {
      if (clickHandlersBound) {
        canvasEl.removeEventListener("mousedown", onCanvasMouseDown);
        canvasEl.removeEventListener("click", onCanvasClick);
        clickHandlersBound = false;
      }
      if (canvasEl.parentNode) canvasEl.parentNode.removeChild(canvasEl);
    }
    canvasEl = null;
    clickStart = null;
    if (overlayEl && overlayEl.parentNode) {
      overlayEl.parentNode.removeChild(overlayEl);
    }
    overlayEl = null;
    overlaySeats = [];
    activeSpeakerId = null;
    activeSpeakerState = null;
    chairVotePopEl = null;
    chairAnchorWorld = null;
    lastVotePopHtml = "";
    scene = null;
    camera = null;
    chairGroup = null;
    avatarGroup = null;
    // Reset the per-mount preload trigger + stashed render args (the GLB
    // templates themselves stay cached in avatar-3d.js across mounts). On
    // remount the preload block re-runs and re-fires a rebuild once ready.
    avatar3dPreloadStarted = false;
    _lastPositions = null;
    _lastMode = null;
    floorMesh = null;
    tableGroup = null;
    tableBodyMat = null;
    tableTopMat = null;
    tableShadeMat = null;
    if (tableGrainTex) { try { tableGrainTex.dispose(); } catch (_) {} tableGrainTex = null; }
    roomFurniture = null;
    roomFurnitureMode = null;
    // Wall / trim / rail materials are shared module-scope
    // singletons (lazy-created in buildBoardroomWalls). We KEEP
    // them alive across unmount cycles so a room swap doesn't
    // re-allocate the materials AND re-upload their currently-bound
    // procedural texture to the GPU. Mesh refs go away with the
    // scene; the materials get re-attached to new meshes on the
    // next mount and re-configured by refreshWallColors().
    wallTrimGroup = null;
    // Plant + wood baseboard groups carry per-mount mesh references
    // (3 planes each, scene-attached) so the group ref must be
    // dropped between mounts. The MATERIAL on those groups is the
    // shared module-scope plantBaseboardMat / woodBaseboardMat —
    // those stay alive (see comment below) so the next mount reuses
    // them without re-uploading the texture.
    plantBaseboardGroup = null;
    woodBaseboardGroup = null;
    if (stageEl) {
      stageEl.classList.remove("is-3d");
      stageEl = null;
    }
    if (intersectionObserver) {
      try { intersectionObserver.disconnect(); } catch (_) {}
      intersectionObserver = null;
    }
    elementVisible = true;
    // ── Caches preserved across mounts ────────────────────────
    // The following module-scope resources are EXPENSIVE to rebuild
    // (procedural textures = thousands of fillRect calls on a
    // 1024×512 canvas, avatar textures = SVG decode + canvas paint)
    // and they are SAFE to reuse:
    //   · brainstorm/constructive/critique wall textures · pure
    //     procedural output, identical bytes across mounts
    //   · plant + wood baseboard textures · same as above
    //   · avatar texCache · keyed by avatarPath; SVG content for a
    //     given path is stable
    //   · wallMat / trimMat / railMat · shared materials,
    //     auto-reused by the next buildBoardroomWalls() (lazy
    //     `if (!wallMat)` gate already in place)
    //   · plantBaseboardMat / woodBaseboardMat · same lazy gate
    // Disposing them on every unmount made a chair-handoff SSE
    // burst (which can re-mount the stage many times) repaint
    // hundreds of thousands of pixels per cycle and pegged the CPU
    // on low-end machines. Page unload (full app teardown) is the
    // only correct dispose site, and the browser handles that for
    // us when the window closes.
  }

  /** Re-render the scene from app state.
   *  @param {{
   *    members:    Array<{ id, name, avatarPath, __isUser?, roleKind? }>,
   *    positions:  Array<{ member, x, y, kind, thetaDeg, scaleHint }>,
   *    mode:       string,
   *    speakerId?: string | null,
   *    speakerState?: "thinking" | "speaking" | null,
   *    labels?: { thinking?: string, speaking?: string },
   *    votePop?:   string,  // HTML for chair vote pop · "" to hide
   *  }} state */
  function update(state) {
    if (!scene) return;
    // First update after mount = scene is about to populate (seats,
    // avatars, speaker indicator). Schedule the loading overlay to
    // fade out shortly after so the first populated frame has a
    // chance to paint underneath. 320 ms covers the CSS transition
    // duration; the overlay sits on z-index 3 (above the canvas /
    // DOM overlay) so it veils the scene crisply during the gap.
    if (loadingEl && !loadingFirstUpdateSeen) {
      loadingFirstUpdateSeen = true;
      setTimeout(() => hideLoadingOverlay(), 320);
    }
    const mode = (state && state.mode) || "constructive";
    rebuildFloor(mode);
    refreshWallColors(mode);
    refreshTable(mode);
    refreshFurniture(mode);
    _lastPositions = state && state.positions ? state.positions : [];
    _lastMode = mode;
    rebuildSeats(_lastPositions, mode);
    const prevSpeakerIdSnapshot = activeSpeakerId;
    activeSpeakerId = (state && state.speakerId) || null;
    activeSpeakerState = (state && state.speakerState) || null;
    // Trigger the "scene-cut to new director" camera pulse when the
    // speaker actually changed AND the new turn is in `speaking`
    // (not just `thinking` — thinking phase is transient and a
    // pulse there would feel like camera jitter when the bubble
    // flips text without an audible audio swap).
    if (
      activeSpeakerId
      && activeSpeakerId !== prevSpeakerIdSnapshot
      && activeSpeakerState === "speaking"
    ) {
      maybeTriggerSpeakerCameraPulse(activeSpeakerId);
    }
    activeUserWait = !!(state && state.userWait);
    activeUserBubble = (state && state.userBubble && typeof state.userBubble === "object"
      && typeof state.userBubble.text === "string" && state.userBubble.text.trim())
      ? { text: state.userBubble.text, progress: Number(state.userBubble.progress) || 0 }
      : null;
    if (state && state.labels) {
      if (typeof state.labels.thinking === "string") activeSpeakerLabels.thinking = state.labels.thinking;
      if (typeof state.labels.speaking === "string") activeSpeakerLabels.speaking = state.labels.speaking;
    }
    refreshSpeakerOverlay();
    // Chair vote pop · only swap innerHTML when it actually changed,
    // so the existing buttons keep their hover state and we don't
    // tear down any pseudo-focus or popover state mid-interaction.
    const newVotePop = (state && typeof state.votePop === "string") ? state.votePop : "";
    if (chairVotePopEl) {
      if (newVotePop !== lastVotePopHtml) {
        chairVotePopEl.innerHTML = newVotePop;
        lastVotePopHtml = newVotePop;
      }
      chairVotePopEl.style.display = newVotePop ? "" : "none";
    }
  }

  /* ── Build helpers ──────────────────────────────────────────── */

  /** Apply the tone-keyed wall palette to the shared wall materials.
   *  Idempotent · safe to call every update() tick. No-op until the
   *  walls have been built (materials don't exist yet).
   *
   *  Brainstorm tone gets special treatment · the flat sky-blue paint
   *  was the weakest of the five rooms, so we swap in a procedural
   *  pixel-art 山水 (Chinese landscape) painted into a canvas. Trim +
   *  rail meshes hide for that mode so a baseboard / chair-rail band
   *  doesn't slice across the painting. Other tones restore the
   *  flat-paint look. */
  function refreshWallColors(mode) {
    if (!wallMat || !trimMat || !railMat) return;
    const palette = WALL_PALETTE_BY_TONE[mode] || WALL_PALETTE_BY_TONE.constructive;

    // Default · walls are lit by the room lights only. The brainstorm
    // nature-vista opts into self-illumination below (emissive map) so
    // its daylight reads bright in the dim room; reset emissive here so
    // every OTHER tone stays normally lit.
    if (wallMat.emissiveMap || (wallMat.emissive && wallMat.emissive.getHex() !== 0x000000)) {
      wallMat.emissive.setHex(0x000000);
      wallMat.emissiveMap = null;
      wallMat.needsUpdate = true;
    }

    if (mode === "brainstorm") {
      if (!brainstormWallTexture) brainstormWallTexture = buildBrainstormWallTexture();
      if (wallMat.map !== brainstormWallTexture) {
        wallMat.map = brainstormWallTexture;
        wallMat.needsUpdate = true;
      }
      // Gentle self-illumination · the same texture as an emissive map
      // lifts the cozy interior so it reads in the dim room without
      // flattening the baked furniture shading. Kept VERY LOW (0.10) —
      // the cream field is large and even 0.22 still self-glowed enough
      // to read as glaring on the voice-room stage. The room lights
      // (ambient + key) carry the base wall brightness; this is just a
      // faint lift on top so the daylight window doesn't go flat.
      wallMat.emissive.setHex(0xFFFFFF);
      wallMat.emissiveMap = brainstormWallTexture;
      wallMat.emissiveIntensity = 0.10;
      wallMat.needsUpdate = true;
      // White color so the texture renders un-tinted under Lambert
      // shading. Lambert multiplies color × map per pixel.
      wallMat.color.setHex(0xFFFFFF);
      if (wallTrimGroup) wallTrimGroup.visible = false;
      if (plantBaseboardGroup) plantBaseboardGroup.visible = false;
      if (woodBaseboardGroup) woodBaseboardGroup.visible = false;
      return;
    }

    if (mode === "constructive") {
      if (!constructiveWallTexture) constructiveWallTexture = buildConstructiveWallTexture();
      if (wallMat.map !== constructiveWallTexture) {
        // Tile the elevation twice across the wide wall so its features
        // read at ~half the table width, not a single oversized print.
        constructiveWallTexture.wrapS = THREE.RepeatWrapping;
        constructiveWallTexture.repeat.x = 2;
        wallMat.map = constructiveWallTexture;
        wallMat.needsUpdate = true;
      }
      wallMat.color.setHex(0xFFFFFF);
      // Glass curtain wall paints its own steel/concrete spandrel base,
      // so hide both the flat-paint trim band AND the foliage band (a
      // planter at the foot of a glass partition would clash).
      if (wallTrimGroup) wallTrimGroup.visible = false;
      if (plantBaseboardGroup) plantBaseboardGroup.visible = false;
      if (woodBaseboardGroup) woodBaseboardGroup.visible = false;
      return;
    }

    if (mode === "critique") {
      if (!critiqueWallTexture) critiqueWallTexture = buildCritiqueWallTexture();
      if (wallMat.map !== critiqueWallTexture) {
        critiqueWallTexture.wrapS = THREE.RepeatWrapping;
        critiqueWallTexture.repeat.x = 2;
        wallMat.map = critiqueWallTexture;
        wallMat.needsUpdate = true;
      }
      wallMat.color.setHex(0xFFFFFF);
      // Mahogany panelling paints its own chair-rail + plinth, so hide
      // every trim band (the old sandstone wall needed the wood
      // baseboard; the panelled wall does not).
      if (wallTrimGroup) wallTrimGroup.visible = false;
      if (plantBaseboardGroup) plantBaseboardGroup.visible = false;
      if (woodBaseboardGroup) woodBaseboardGroup.visible = false;
      return;
    }

    if (mode === "debate") {
      if (!debateWallTexture) debateWallTexture = buildDebateWallTexture();
      if (wallMat.map !== debateWallTexture) {
        debateWallTexture.wrapS = THREE.RepeatWrapping;
        debateWallTexture.repeat.x = 2;
        wallMat.map = debateWallTexture;
        wallMat.needsUpdate = true;
      }
      wallMat.color.setHex(0xFFFFFF);
      // The texture paints its own chair-rail + wainscot + baseboard,
      // so hide the flat-paint trim band (a horizontal rail strip would
      // otherwise slice across the windows / wainscot panels).
      if (wallTrimGroup) wallTrimGroup.visible = false;
      if (plantBaseboardGroup) plantBaseboardGroup.visible = false;
      if (woodBaseboardGroup) woodBaseboardGroup.visible = false;
      return;
    }

    if (mode === "research") {
      if (!researchWallTexture) researchWallTexture = buildResearchWallTexture();
      if (wallMat.map !== researchWallTexture) {
        // No horizontal tiling for the bookcase · repeat.x=2 squeezed the
        // spines into thin slivers (~0.12–0.29 world units wide) that read
        // as too-narrow next to the 0.8-wide directors. At repeat.x=1 the
        // 3 bays span the full 26-unit back wall and book widths land in a
        // believable range against the seated figures.
        researchWallTexture.wrapS = THREE.ClampToEdgeWrapping;
        researchWallTexture.repeat.x = 1;
        wallMat.map = researchWallTexture;
        wallMat.needsUpdate = true;
      }
      wallMat.color.setHex(0xFFFFFF);
      // Bookcases + crown + plinth are painted into the texture; hide
      // the flat-paint trim band so it doesn't cut across the shelves.
      if (wallTrimGroup) wallTrimGroup.visible = false;
      if (plantBaseboardGroup) plantBaseboardGroup.visible = false;
      if (woodBaseboardGroup) woodBaseboardGroup.visible = false;
      return;
    }

    if (wallMat.map !== null) {
      wallMat.map = null;
      wallMat.needsUpdate = true;
    }
    wallMat.color.setHex(palette.wall);
    trimMat.color.setHex(palette.trim);
    railMat.color.setHex(palette.rail);
    if (wallTrimGroup) wallTrimGroup.visible = true;
    if (plantBaseboardGroup) plantBaseboardGroup.visible = false;
    if (woodBaseboardGroup) woodBaseboardGroup.visible = false;
  }

  /** Procedural pixel-art COZY MODERN INTERIOR · a warm low-poly room
   *  modelled on the three.js skinning-IK example's furnished scene:
   *  cream walls, a daylight window, a wooden chest of drawers, a sage
   *  sofa with framed art above it, and a leafy floor plant. The same
   *  texture wraps all three walls so the directors sit in a furnished
   *  lounge. Palette locked with the user · sage #8CA07E sofa, cream
   *  #E4DAC8 walls, oak #B08A5A wood. refreshWallColors() gives the wall
   *  a gentle emissive lift so the room reads bright. */
  function buildBrainstormWallTexture() {
    const W = 1024, H = 512;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    const P = {
      // Softer, deeper cream than the original #E4DAC8 — the brighter
      // cream read as glaring on the voice-room stage once the wall
      // self-illuminates. This is a muted, gentler warm tone.
      WALL: "#CEC2AB", WALL_HI: "#DACFBB", WALL_SH: "#BEB298",
      BASE: "#C9BB9E", BASE_DK: "#AE9F82",
      WOOD: "#B08A5A", WOOD_HI: "#C8A472", WOOD_DK: "#8A6A3E",
    };
    const FLOOR = 498; // wall meets floor / furniture baseline

    // Wall · warm cream, lifted near the ceiling, gently shaded toward
    // the floor so the room has soft ambient depth.
    ctx.fillStyle = P.WALL; ctx.fillRect(0, 0, W, H);
    const topLight = ctx.createLinearGradient(0, 0, 0, 130);
    topLight.addColorStop(0, "rgba(255,250,240,0.18)");
    topLight.addColorStop(1, "rgba(255,250,240,0)");
    ctx.fillStyle = topLight; ctx.fillRect(0, 0, W, 130);
    const floorShade = ctx.createLinearGradient(0, H * 0.45, 0, FLOOR);
    floorShade.addColorStop(0, "rgba(150,135,105,0)");
    floorShade.addColorStop(1, "rgba(150,135,105,0.16)");
    ctx.fillStyle = floorShade; ctx.fillRect(0, Math.round(H * 0.45), W, FLOOR - Math.round(H * 0.45));

    // Baseboard · behind the furniture, where wall meets floor.
    ctx.fillStyle = P.BASE; ctx.fillRect(0, FLOOR, W, H - FLOOR);
    ctx.fillStyle = P.BASE_DK; ctx.fillRect(0, FLOOR, W, 2);

    // Wall backdrop · two glass windows (wood frame + clean glass, no
    // painted view) + framed art on the cream wall. The chest / sofa /
    // plant are NOT painted here — they're real 3D furniture meshes in
    // the room (buildRoomFurniture) so they have actual depth and a scale
    // that matches the table, instead of a flat wallpaper print.
    // Windows + art sit in the wall's LOWER band · the camera frames the
    // table and only the lower strip of the back wall is in view at init,
    // so anything up near y=60 would be cropped off-screen. Dropping them
    // to ~y=248 puts a window in the opening shot.
    drawWindowGlass(ctx, 96, 248, 232, 190, P);
    drawWallArt(ctx, 430, 285, 164, 116, P);
    drawWindowGlass(ctx, 696, 248, 232, 190, P);

    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Glass window · warm-oak frame + sill around clean glass — no
   *  painted sky / landscape, just a pale cool pane with soft diagonal
   *  reflection sheen so it reads as transparent glass rather than a
   *  sealed board. A wood mullion cross splits it into four panes. */
  function drawWindowGlass(ctx, x, y, w, h, P) {
    const fr = 8;
    // Outer oak frame · dark edge, mid face, lit top, shaded bottom.
    ctx.fillStyle = P.WOOD_DK; ctx.fillRect(x - fr, y - fr, w + fr * 2, h + fr * 2);
    ctx.fillStyle = P.WOOD;    ctx.fillRect(x - fr + 2, y - fr + 2, w + fr * 2 - 4, h + fr * 2 - 4);
    ctx.fillStyle = P.WOOD_HI; ctx.fillRect(x - fr + 2, y - fr + 2, w + fr * 2 - 4, 2);
    ctx.fillStyle = P.WOOD_DK; ctx.fillRect(x - fr + 2, y + h + fr - 4, w + fr * 2 - 4, 2);

    // Glass pane · pale cool gradient, NOT a sky view.
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, "#CAD6D8");
    g.addColorStop(1, "#E3E9E6");
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    // Inner shadow just under the head jamb so the glass sits recessed.
    ctx.fillStyle = "rgba(70,82,82,0.18)"; ctx.fillRect(x, y, w, 4);

    // Reflection sheen · two soft slanted light streaks across the pane.
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    const streak = (ox, sw) => {
      ctx.beginPath();
      ctx.moveTo(x + ox, y);
      ctx.lineTo(x + ox + sw, y);
      ctx.lineTo(x + ox + sw - h * 0.55, y + h);
      ctx.lineTo(x + ox - h * 0.55, y + h);
      ctx.closePath(); ctx.fill();
    };
    streak(w * 0.16, 20);
    streak(w * 0.44, 10);
    ctx.restore();

    // Wood mullion cross → four panes, lit on the upper/left face.
    const cx = x + Math.round(w / 2);
    const cy = y + Math.round(h / 2);
    ctx.fillStyle = P.WOOD;    ctx.fillRect(cx - 4, y, 8, h); ctx.fillRect(x, cy - 4, w, 8);
    ctx.fillStyle = P.WOOD_HI; ctx.fillRect(cx - 4, y, 2, h); ctx.fillRect(x, cy - 4, w, 2);

    // Sill · a proud wood ledge under the window.
    ctx.fillStyle = P.WOOD;    ctx.fillRect(x - fr - 4, y + h + fr, w + fr * 2 + 8, 8);
    ctx.fillStyle = P.WOOD_HI; ctx.fillRect(x - fr - 4, y + h + fr, w + fr * 2 + 8, 2);
  }

  /** Framed wall art · oak frame + a soft warm abstract that echoes the
   *  room palette (a sage block + a terracotta accent over a cream field). */
  function drawWallArt(ctx, x, y, w, h, P) {
    ctx.fillStyle = P.WOOD_DK; ctx.fillRect(x - 4, y - 4, w + 8, h + 8);
    ctx.fillStyle = P.WOOD; ctx.fillRect(x - 4, y - 4, w + 8, 2);
    ctx.fillStyle = "#E8E0D2"; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#C9B79A"; ctx.fillRect(x, y + Math.round(h * 0.55), w, Math.round(h * 0.45));
    ctx.fillStyle = "#A9B89A"; ctx.fillRect(x + Math.round(w * 0.15), y + Math.round(h * 0.30), Math.round(w * 0.4), Math.round(h * 0.3));
    ctx.fillStyle = "#C58A5E"; ctx.fillRect(x + Math.round(w * 0.62), y + Math.round(h * 0.18), Math.round(w * 0.22), Math.round(h * 0.5));
    ctx.fillStyle = "#8A7A60"; ctx.fillRect(x, y + Math.round(h * 0.55), w, 1);
  }

  /** Procedural pixel-art stone wall · modelled after
   *  `public/icons/wall1.png`. Irregular rounded stone blocks in a
   *  cool grey-blue palette with a few warm-rust accent stones,
   *  dark mortar between blocks, top-edge highlights / bottom-edge
   *  shadows on each block, and green moss patches scattered along
   *  the seams with falling vine strands. Used for the constructive
   *  tone in place of the flat-paint wall material. */
  function buildConstructiveWallTexture() {
    const W = 1024, H = 512;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    // ── Modern corporate CURTAIN WALL · steel mullions + cool dusk
    // glass. Replaces the old stone-and-moss surface. Glass is painted
    // in discrete colour bands (pixel-art, not a smooth gradient) so
    // the chunky NearestFilter read carries through; distant warm dots
    // in the lower panes suggest a city at dusk behind the glazing. ──
    const STEEL_DEEP = "#23272E", STEEL = "#3A424C", STEEL_HI = "#6E7A88";
    const SPANDREL = "#2C3138";
    const GLASS = ["#7C8DA0", "#6A7C90", "#586A7E", "#48596C", "#3A4858"];
    const SHEEN = "rgba(200,220,235,0.18)";
    const CITY_LIGHT = ["#C9A86A", "#D8C088", "#9FB4C2"];
    const rand = mulberry32(13);

    // Backdrop · deep steel shows in any gap behind the glazing.
    ctx.fillStyle = STEEL_DEEP;
    ctx.fillRect(0, 0, W, H);

    // Header beam · top steel rail.
    ctx.fillStyle = STEEL; ctx.fillRect(0, 0, W, 20);
    ctx.fillStyle = STEEL_HI; ctx.fillRect(0, 0, W, 2);
    ctx.fillStyle = STEEL_DEEP; ctx.fillRect(0, 20, W, 3);

    // Glazing · 5 bays × 4 rows of panes between header and spandrel.
    const glassTop = 23, glassBot = 470;
    const cols = 5, rows = 4;
    const mull = 8;
    const bayW = (W - mull) / cols;
    const paneRowH = (glassBot - glassTop - mull) / rows;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const px = Math.round(mull + c * bayW);
        const py = Math.round(glassTop + mull + r * paneRowH);
        const pw = Math.round(bayW - mull);
        const ph = Math.round(paneRowH - mull);
        drawGlassPane(ctx, px, py, pw, ph, r, rows, GLASS, SHEEN, CITY_LIGHT, rand);
      }
    }

    // Mullions · steel bars over the grid seams (vertical + horizontal).
    for (let c = 0; c <= cols; c++) {
      const mx = Math.round(c * bayW);
      ctx.fillStyle = STEEL; ctx.fillRect(mx, glassTop, mull, glassBot - glassTop);
      ctx.fillStyle = STEEL_HI; ctx.fillRect(mx, glassTop, 1, glassBot - glassTop);
      ctx.fillStyle = STEEL_DEEP; ctx.fillRect(mx + mull - 1, glassTop, 1, glassBot - glassTop);
    }
    for (let r = 0; r <= rows; r++) {
      const my = Math.round(glassTop + r * paneRowH);
      ctx.fillStyle = STEEL; ctx.fillRect(0, my, W, mull);
      ctx.fillStyle = STEEL_HI; ctx.fillRect(0, my, W, 1);
      ctx.fillStyle = STEEL_DEEP; ctx.fillRect(0, my + mull - 1, W, 1);
    }

    // Spandrel base · opaque steel / concrete panel at the floor seam,
    // with vertical seams aligned to the mullions above.
    ctx.fillStyle = SPANDREL; ctx.fillRect(0, glassBot, W, H - glassBot);
    ctx.fillStyle = STEEL_HI; ctx.fillRect(0, glassBot, W, 2);
    ctx.fillStyle = STEEL_DEEP; ctx.fillRect(0, H - 8, W, 8);
    for (let c = 1; c < cols; c++) {
      ctx.fillStyle = STEEL_DEEP;
      ctx.fillRect(Math.round(c * bayW + mull / 2) - 1, glassBot + 4, 2, H - glassBot - 12);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** One curtain-wall glass pane · cool dusk colour in discrete bands
   *  (pixel-art, no smooth gradient), a diagonal reflective sheen on
   *  ~60% of panes, distant warm city-light dots in the lower rows,
   *  and a thin recessed shadow on the right + bottom edges. `rowIdx`
   *  grades the colour so upper rows read as sky, lower rows as deep
   *  glass. */
  function drawGlassPane(ctx, x, y, w, h, rowIdx, rowCount, glass, sheen, lights, rand) {
    const bands = glass.length;
    const bandH = Math.ceil(h / bands);
    const startBand = Math.min(bands - 1,
      Math.round((rowIdx / Math.max(1, rowCount)) * (bands - 1)));
    for (let i = 0; i < bands; i++) {
      const bi = Math.min(bands - 1, startBand + Math.floor(i * 0.6));
      ctx.fillStyle = glass[bi];
      ctx.fillRect(x, y + i * bandH, w, bandH);
    }
    // Distant city lights · only the lower rows, a few warm dots.
    if (rowIdx >= rowCount - 2) {
      const n = 2 + Math.floor(rand() * 4);
      for (let k = 0; k < n; k++) {
        ctx.fillStyle = lights[Math.floor(rand() * lights.length)];
        const lx = x + 3 + Math.floor(rand() * Math.max(1, w - 6));
        const ly = y + Math.floor(h * 0.45) + Math.floor(rand() * Math.max(1, h * 0.45));
        ctx.fillRect(lx, ly, 1 + Math.floor(rand() * 2), 1);
      }
    }
    // Diagonal reflective sheen.
    if (rand() < 0.6) {
      ctx.fillStyle = sheen;
      const sx = x + Math.floor(rand() * w * 0.5);
      for (let s = 0; s < h; s++) {
        const xx = sx + Math.floor(s * 0.5);
        if (xx >= x && xx < x + w) ctx.fillRect(xx, y + s, 3, 1);
      }
    }
    // Recessed edge shadow (right + bottom) so the pane reads as glass
    // set behind its steel frame.
    ctx.fillStyle = "rgba(10,14,20,0.35)";
    ctx.fillRect(x + w - 1, y, 1, h);
    ctx.fillRect(x, y + h - 1, w, 1);
  }

  /** Procedural pixel-art CRITIQUE wall · a dark MAHOGANY EXECUTIVE
   *  PANEL room. Top-down: a dentil cornice capped with brass → a row
   *  of tall raised mahogany panels (brass pin accents) → a brass
   *  chair-rail datum → a row of shorter dado panels → a dark plinth
   *  with a brass reveal. Formal + scrutinising — the boardroom that
   *  finds the holes. Pairs with the brass-on-gunmetal metal-weave
   *  floor. Same NearestFilter canvas-texture recipe as the others. */
  function buildCritiqueWallTexture() {
    const W = 1024, H = 512;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    const MAH = "#6B3F2F", MAH_HI = "#8A5038", MAH_DK = "#341A12", STILE = "#4A2A20";
    const BRASS = "#C9A85A", BRASS_HI = "#E6CC8E", BRASS_SH = "#94774A";

    // Deep mahogany ground · panel gaps / reveals read as shadow.
    ctx.fillStyle = MAH_DK; ctx.fillRect(0, 0, W, H);

    // Crown · cornice with a row of dentils + a brass reveal line.
    ctx.fillStyle = STILE; ctx.fillRect(0, 0, W, 18);
    ctx.fillStyle = MAH_HI; ctx.fillRect(0, 0, W, 1);
    ctx.fillStyle = MAH_DK; for (let dx = 4; dx < W; dx += 22) ctx.fillRect(dx, 12, 12, 6); // dentils
    ctx.fillStyle = BRASS_SH; ctx.fillRect(0, 24, W, 1);
    ctx.fillStyle = BRASS; ctx.fillRect(0, 22, W, 2);
    ctx.fillStyle = BRASS_HI; ctx.fillRect(0, 22, W, 1);

    const panels = 5, pw = W / panels;

    // Upper field · tall raised panels with brass pin accents.
    const upTop = 34, upBot = 300;
    for (let i = 0; i < panels; i++) {
      const x = Math.round(i * pw) + 6;
      drawRaisedPanel(ctx, x, upTop, Math.round(pw) - 12, upBot - upTop, MAH, MAH_HI, MAH_DK);
      ctx.fillStyle = BRASS;
      ctx.fillRect(x + 6, upTop + 8, 2, 2);
      ctx.fillRect(x + Math.round(pw) - 20, upTop + 8, 2, 2);
    }

    // Chair-rail datum · a brass line over a dark reveal.
    ctx.fillStyle = STILE; ctx.fillRect(0, 300, W, 12);
    ctx.fillStyle = BRASS_SH; ctx.fillRect(0, 310, W, 1);
    ctx.fillStyle = BRASS; ctx.fillRect(0, 302, W, 2);
    ctx.fillStyle = BRASS_HI; ctx.fillRect(0, 302, W, 1);

    // Lower dado · shorter raised panels.
    const loTop = 318, loBot = 486;
    for (let i = 0; i < panels; i++) {
      drawRaisedPanel(ctx, Math.round(i * pw) + 6, loTop, Math.round(pw) - 12, loBot - loTop, MAH, MAH_HI, MAH_DK);
    }

    // Plinth · dark base band with a brass top reveal.
    ctx.fillStyle = STILE; ctx.fillRect(0, loBot, W, H - loBot);
    ctx.fillStyle = BRASS; ctx.fillRect(0, loBot, W, 2);
    ctx.fillStyle = BRASS_HI; ctx.fillRect(0, loBot, W, 1);

    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** A RAISED frame-and-panel rectangle · light top/left, dark
   *  bottom/right bevels so the panel face reads as proud of the
   *  surrounding stiles. Used for the critique mahogany wall. */
  function drawRaisedPanel(ctx, x, y, w, h, face, hi, lo) {
    ctx.fillStyle = lo; ctx.fillRect(x, y, w, h);                  // stile / recess border
    ctx.fillStyle = face; ctx.fillRect(x + 4, y + 4, w - 8, h - 8); // raised face
    ctx.fillStyle = hi; ctx.fillRect(x + 4, y + 4, w - 8, 2);      // top bevel light
    ctx.fillStyle = hi; ctx.fillRect(x + 4, y + 4, 2, h - 8);      // left bevel light
    ctx.fillStyle = lo; ctx.fillRect(x + 4, y + h - 6, w - 8, 2);  // bottom bevel shade
    ctx.fillStyle = lo; ctx.fillRect(x + w - 6, y + 4, 2, h - 8);  // right bevel shade
  }

  /** Procedural pixel-art DEBATE wall · a warm-oak forum / chamber.
   *  Top-down the texture reads: crown molding → upper field with
   *  three tall daylight windows (wood mullions, sill, a faint sun
   *  glow) → chair rail → frame-and-panel wainscot → baseboard. Cool
   *  daylight in the windows plays against the warm wood + the warm
   *  debate floor so the room reads "lit from outside". Same chunky
   *  NearestFilter canvas-texture recipe as the brick / stone tones. */
  function buildDebateWallTexture() {
    const W = 1024, H = 512;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    // Warm-oak palette.
    const OAK_DEEP = "#3F2C1B";
    const OAK_DARK = "#5A3F28";
    const OAK_MID = "#6E4F33";
    const OAK_BASE = "#80603E";
    const OAK_HI = "#9E7A4E";
    const OAK_HI2 = "#B58F5E";

    const grain = mulberry32(57);

    // ── Wall field · vertical plank paneling with grain + seams. ──
    ctx.fillStyle = OAK_MID;
    ctx.fillRect(0, 0, W, H);
    const plankW = 64;
    for (let x = 0; x < W; x += plankW) {
      const tone = [OAK_MID, OAK_BASE, OAK_DARK][Math.floor(grain() * 3)];
      ctx.fillStyle = tone;
      ctx.fillRect(x, 0, plankW, H);
      // Faint vertical grain streaks.
      for (let s = 0; s < 6; s++) {
        const gx = x + 4 + Math.floor(grain() * (plankW - 8));
        const gy = Math.floor(grain() * H);
        const gh = 30 + Math.floor(grain() * 120);
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = grain() < 0.5 ? OAK_DEEP : OAK_HI;
        ctx.fillRect(gx, gy, 1, gh);
        ctx.globalAlpha = 1;
      }
      // Plank seam · dark right edge + soft highlight on the left.
      ctx.fillStyle = OAK_DEEP;
      ctx.fillRect(x + plankW - 1, 0, 1, H);
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = OAK_HI;
      ctx.fillRect(x, 0, 1, H);
      ctx.globalAlpha = 1;
    }

    // ── Crown molding · top band. ──
    ctx.fillStyle = OAK_DEEP; ctx.fillRect(0, 0, W, 22);
    ctx.fillStyle = OAK_HI2; ctx.fillRect(0, 20, W, 2);
    ctx.fillStyle = OAK_DARK; ctx.fillRect(0, 22, W, 4);

    // ── Windows · three arched daylight openings set LOW on the wall so
    // they land inside the camera's initial framing (it frames the back
    // wall's lower band behind the seated directors). Sill sits ~1 world
    // unit off the floor. The tall wainscot that used to fill this band —
    // and hide the glass — is gone; just a baseboard grounds the floor. ──
    const winTop = 292, winH = 178, winW = 150;
    for (const frac of [0.2, 0.5, 0.8]) {
      drawDebateWindow(ctx, Math.round(W * frac - winW / 2), winTop, winW, winH, grain);
    }

    // ── Baseboard · dark band at the floor seam (below the window sills). ──
    const baseTop = 490;
    ctx.fillStyle = OAK_DEEP; ctx.fillRect(0, baseTop, W, H - baseTop);
    ctx.fillStyle = OAK_HI; ctx.fillRect(0, baseTop, W, 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** One tall daylight window for the debate wall · wood frame + sill,
   *  a banded cool-daylight sky, a faint sun glow, and a 3×4 mullion
   *  grid. `x,y` is the top-left of the glass opening. */
  function drawDebateWindow(ctx, x, y, w, h, rand) {
    const FRAME = "#3F2C1B", FRAME_HI = "#7A5836", SILL = "#5A3F28";
    const fr = 10;
    // Outer wood frame + top/left bevel highlight.
    ctx.fillStyle = FRAME;
    ctx.fillRect(x - fr, y - fr, w + fr * 2, h + fr * 2);
    ctx.fillStyle = FRAME_HI;
    ctx.fillRect(x - fr, y - fr, w + fr * 2, 2);
    ctx.fillRect(x - fr, y - fr, 2, h + fr * 2);

    // Sky · vertical daylight bands (pale blue → warm horizon).
    const sky = ["#A6C0D2", "#B4CBD9", "#C3D6E0", "#D3E1E8", "#E0EAEC"];
    const bandH = Math.ceil(h / sky.length);
    for (let i = 0; i < sky.length; i++) {
      ctx.fillStyle = sky[i];
      ctx.fillRect(x, y + i * bandH, w, bandH);
    }
    // Warm horizon glow near the bottom of the glass.
    ctx.fillStyle = "#ECDDC4";
    ctx.fillRect(x, y + h - 16, w, 16);
    // Faint sun disc · upper-left pane.
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = "#FFF6E2";
    ctx.fillRect(x + 14, y + 16, 12, 12);
    ctx.globalAlpha = 1;

    // Mullions · 2 vertical + 3 horizontal wood bars → 3×4 panes.
    const bar = 6;
    ctx.fillStyle = FRAME;
    for (let c = 1; c < 3; c++) {
      ctx.fillRect(x + Math.round((w * c) / 3) - bar / 2, y, bar, h);
    }
    for (let r = 1; r < 4; r++) {
      ctx.fillRect(x, y + Math.round((h * r) / 4) - bar / 2, w, bar);
    }

    // Sill · wood ledge jutting below the frame.
    ctx.fillStyle = SILL;
    ctx.fillRect(x - fr - 4, y + h + fr, w + fr * 2 + 8, 8);
    ctx.fillStyle = FRAME_HI;
    ctx.fillRect(x - fr - 4, y + h + fr, w + fr * 2 + 8, 2);
    void rand;
  }

  /** Lighten / darken a #rrggbb hex toward white / black · shared by
   *  the library book-spine shading below. Returns an `rgb()` string. */
  function tintHex(hex, d) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, ((n >> 16) & 0xff) + d));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + d));
    const b = Math.max(0, Math.min(255, (n & 0xff) + d));
    return `rgb(${r},${g},${b})`;
  }

  /** Procedural pixel-art RESEARCH wall · a light-oak library. Top-down:
   *  crown molding → built-in bookcases (oak shelf boards + case
   *  uprights framing three bays, each shelf packed with varied book
   *  spines — gilt titles, the odd horizontal stack, a potted plant for
   *  warmth) → oak cabinet plinth + baseboard. Scholarly + warm-neutral
   *  against the library's pale-marble floor. Same NearestFilter
   *  canvas-texture recipe as the other tones. */
  function buildResearchWallTexture() {
    const W = 1024, H = 512;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    const OAK_DEEP = "#5A4326", OAK_DARK = "#6E5430", OAK_MID = "#8A6E44",
      OAK_HI = "#B0905A", OAK_HI2 = "#C8AC72", RECESS = "#352A1B";
    const SPINES = [
      "#7C3A33", "#3E6B4A", "#3A567A", "#A6814A", "#B5953F", "#5A4636",
      "#7A3050", "#356E6A", "#8A4A2E", "#4A4458", "#9C8A5A", "#6A8C46",
    ];
    const GILT = "#C9A85A";
    const rand = mulberry32(91);

    // Dark recess behind the shelves.
    ctx.fillStyle = RECESS;
    ctx.fillRect(0, 0, W, H);

    // Crown molding.
    ctx.fillStyle = OAK_DEEP; ctx.fillRect(0, 0, W, 22);
    ctx.fillStyle = OAK_HI2; ctx.fillRect(0, 20, W, 2);
    ctx.fillStyle = OAK_DARK; ctx.fillRect(0, 22, W, 4);

    // Bookcase field · 3 bays × a fixed shelf COUNT filling top→plinth.
    // Using a count (not a fixed row height) guarantees the rows reach
    // the plinth, so the lowest books land in the camera's initial
    // framing instead of bunching high and leaving the visible lower
    // band empty (the prior fixed 74px rows stopped ~70px short).
    const top = 30, bot = 486;
    const board = 9;             // shelf-board thickness
    // 8 shelves (was 6) · shorter rows shrink the book heights from
    // ~1.15–1.5 world units (nearly as tall as a seated director) down
    // to ~0.7–1.0, so the shelving reads at a believable scale against
    // the figures and the table instead of looking oversized.
    const shelves = 8;
    const rowH = (bot - top) / shelves;
    const bays = [
      [6, Math.round(W / 3) - 6],
      [Math.round(W / 3) + 6, Math.round((2 * W) / 3) - 6],
      [Math.round((2 * W) / 3) + 6, W - 6],
    ];
    let plantPlaced = false;
    for (let s = 0; s < shelves; s++) {
      const yTop = Math.round(top + s * rowH);
      const gapH = Math.round(rowH) - board;
      for (const [bx0, bx1] of bays) {
        // Occasionally make ONE shelf in a bay a decorative niche
        // (potted plant) instead of books — once per texture, for warmth.
        if (!plantPlaced && rand() < 0.12) {
          drawShelfPlant(ctx, Math.round((bx0 + bx1) / 2), yTop + gapH);
          plantPlaced = true;
        } else {
          drawBookRow(ctx, bx0, bx1, yTop, gapH, SPINES, GILT, rand);
        }
      }
      // Shelf board spanning the full width under this row.
      const by = yTop + gapH;
      ctx.fillStyle = OAK_MID; ctx.fillRect(0, by, W, board);
      ctx.fillStyle = OAK_HI; ctx.fillRect(0, by, W, 2);          // lit front edge
      ctx.fillStyle = OAK_DEEP; ctx.fillRect(0, by + board - 1, W, 1); // under-shadow
    }

    // Case uprights · vertical oak posts framing the 3 bays.
    const posts = [0, Math.round(W / 3), Math.round((2 * W) / 3), W - 12];
    for (const px of posts) {
      ctx.fillStyle = OAK_DARK; ctx.fillRect(px, 24, 12, bot - 24);
      ctx.fillStyle = OAK_HI; ctx.fillRect(px, 24, 2, bot - 24);       // left highlight
      ctx.fillStyle = OAK_DEEP; ctx.fillRect(px + 10, 24, 2, bot - 24); // right shadow
    }

    // Cabinet plinth + baseboard.
    ctx.fillStyle = OAK_MID; ctx.fillRect(0, bot, W, H - bot);
    ctx.fillStyle = OAK_HI; ctx.fillRect(0, bot, W, 2);          // top edge catch-light
    ctx.fillStyle = OAK_DEEP; ctx.fillRect(0, H - 10, W, 10);    // dark plinth foot
    ctx.fillStyle = OAK_HI; ctx.fillRect(0, H - 10, W, 1);

    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Fill one shelf gap (x0..x1, sitting on the board at yTop+gapH) with
   *  a packed row of varied book spines · widths / heights / colours
   *  vary, ~35% get a gilt title band, occasional horizontal stacks and
   *  small gaps break the rhythm so it reads hand-shelved, not tiled. */
  function drawBookRow(ctx, x0, x1, yTop, gapH, spines, gilt, rand) {
    const floorY = yTop + gapH; // book bottoms sit here (on the board)
    let x = x0 + 2;
    while (x < x1 - 6) {
      const r = rand();
      if (r < 0.06) { x += 4 + Math.floor(rand() * 9); continue; } // gap
      if (r < 0.14 && x1 - x > 44) {
        // Horizontal stack of a few books laid flat.
        const sw = 26 + Math.floor(rand() * 16);
        let sy = floorY;
        const stk = 2 + Math.floor(rand() * 3);
        for (let k = 0; k < stk; k++) {
          const sh = 6 + Math.floor(rand() * 4);
          sy -= sh + 1;
          if (sy < yTop + 2) break;
          const c = spines[Math.floor(rand() * spines.length)];
          ctx.fillStyle = c; ctx.fillRect(x, sy, sw, sh);
          ctx.fillStyle = tintHex(c, -28); ctx.fillRect(x, sy + sh - 1, sw, 1);
          ctx.fillStyle = tintHex(c, 26); ctx.fillRect(x, sy, sw, 1);
        }
        x += sw + 3;
        continue;
      }
      // Upright spine.
      const sw = 9 + Math.floor(rand() * 14);
      const sh = gapH - 2 - Math.floor(rand() * 16);
      const sy = floorY - sh;
      const c = spines[Math.floor(rand() * spines.length)];
      ctx.fillStyle = c; ctx.fillRect(x, sy, sw, sh);
      ctx.fillStyle = tintHex(c, 24); ctx.fillRect(x, sy, 1, sh);          // left catch-light
      ctx.fillStyle = tintHex(c, -30); ctx.fillRect(x + sw - 1, sy, 1, sh); // right shadow
      ctx.fillStyle = tintHex(c, -34); ctx.fillRect(x, sy, sw, 1);          // top cap shadow
      if (rand() < 0.35 && sh > 26 && sw > 11) {
        ctx.fillStyle = gilt;
        const gy = sy + 7 + Math.floor(rand() * (sh - 20));
        ctx.fillRect(x + 2, gy, sw - 4, 1);
        if (rand() < 0.5) ctx.fillRect(x + 2, gy + 3, sw - 4, 1);
      }
      x += sw + 2;
    }
  }

  /** A small potted plant sitting on a library shelf · terracotta pot +
   *  a clump of leaves. `cx` is the pot centre, `baseY` the shelf-board
   *  top the pot rests on. Pure decoration to warm the bookcase. */
  function drawShelfPlant(ctx, cx, baseY) {
    const POT = "#A85A38", POT_HI = "#C47A50", POT_DK = "#7A3E24";
    const LEAF = ["#4E7A3A", "#5E8E46", "#3E6830"];
    const potW = 16, potH = 14;
    const px = cx - potW / 2, py = baseY - potH;
    // Pot · tapered (narrower at the base).
    ctx.fillStyle = POT; ctx.fillRect(px, py, potW, potH);
    ctx.fillStyle = POT_DK; ctx.fillRect(px + 2, py + potH - 1, potW - 4, 1);
    ctx.fillStyle = POT_HI; ctx.fillRect(px, py, potW, 2);   // rim catch-light
    ctx.fillStyle = POT_DK; ctx.fillRect(px + potW - 1, py, 1, potH); // right shade
    // Foliage · a few stacked leaf blobs above the rim.
    let lx = cx - 12, ly = py - 2;
    for (let i = 0; i < 14; i++) {
      const c = LEAF[i % LEAF.length];
      ctx.fillStyle = c;
      const bw = 3 + (i % 3);
      const bh = 3 + ((i + 1) % 3);
      const ox = (i * 7) % 22 - 10;
      const oy = -((i * 5) % 16);
      ctx.fillRect(cx + ox, py - 4 + oy, bw, bh);
    }
    void lx; void ly;
  }

  /** Tiny deterministic PRNG (Mulberry32). Same seed → same sequence,
   *  used so mountain silhouettes stay stable across rebuilds. */
  function mulberry32(a) {
    return function () {
      let t = (a += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Boardroom walls · 3 plain plane walls (back + left + right)
   *  + a darker baseboard trim where each meets the floor. No front
   *  wall · the camera lives where the front wall would be, so a
   *  fourth wall would either be invisible or block the view.
   *  Single solid colour for now (warm taupe + darker trim) ·
   *  Phase-2 could swap to tone-keyed materials matching the floor
   *  palette, but the static neutral reads as a generic conference
   *  room regardless of tone, which is the right baseline. */
  function buildBoardroomWalls() {
    const g = new THREE.Group();
    // Shared module-scope materials · created once, recoloured on
    // tone change via refreshWallColors(). Initial colour doesn't
    // matter — refreshWallColors runs during update() right after
    // mount so the first frame already has the correct palette.
    if (!wallMat) {
      wallMat = new THREE.MeshLambertMaterial({ color: 0xFFFFFF, side: THREE.DoubleSide });
      trimMat = new THREE.MeshLambertMaterial({ color: 0xFFFFFF, side: THREE.DoubleSide });
      railMat = new THREE.MeshLambertMaterial({ color: 0xFFFFFF, side: THREE.DoubleSide });
    }

    const wallH = 12;          // 12 world units · tall enough to fill viewport
    const wallY = wallH / 2;    // centre at half-height

    // Span: each wall extends well past the seat ring + plants on
    // its side so neither viewport edge shows a wall edge.
    const widthLR = STAGE_HALF_Z * 4 + 4; // depth dimension of room (front-back)
    const widthBack = STAGE_HALF_X * 4 + 4; // x dimension of room (left-right)
    const offsetX = STAGE_HALF_X * 1.45;
    const offsetZ = STAGE_HALF_Z * 1.45;

    // ── 3 plain plane walls (back + left + right) with baseboard
    // + chair-rail accent on each. No windows · the curtain-wall
    // experiment was reverted; this is the calm painted-room
    // baseline that complements the tone-keyed floor.

    // Back wall · sits behind the back-row directors, facing the camera.
    const back = new THREE.Mesh(new THREE.PlaneGeometry(widthBack, wallH), wallMat);
    back.position.set(0, wallY, -offsetZ);
    g.add(back);

    // Left wall · faces +X (toward stage centre).
    const left = new THREE.Mesh(new THREE.PlaneGeometry(widthLR, wallH), wallMat);
    left.position.set(-offsetX, wallY, 0);
    left.rotation.y = Math.PI / 2;
    g.add(left);

    // Right wall · faces -X.
    const right = new THREE.Mesh(new THREE.PlaneGeometry(widthLR, wallH), wallMat);
    right.position.set(offsetX, wallY, 0);
    right.rotation.y = -Math.PI / 2;
    g.add(right);

    // Baseboards + chair-rail live in a dedicated sub-group · this
    // lets refreshWallColors() hide the entire trim band as a unit
    // for tones (brainstorm) that swap a full-wall painted texture
    // in place of the flat paint. Without this, a horizontal trim
    // strip slices across the painting.
    wallTrimGroup = new THREE.Group();
    g.add(wallTrimGroup);

    // Baseboards · darker strip where each wall meets the floor.
    // 0.05 inset from the wall surface keeps depth-buffer precision
    // clean at oblique viewing angles (smaller insets shimmer).
    const trimH = 0.25;
    const trimY = trimH / 2;
    const inset = 0.05;
    const baseB = new THREE.Mesh(new THREE.PlaneGeometry(widthBack, trimH), trimMat);
    baseB.position.set(0, trimY, -offsetZ + inset);
    wallTrimGroup.add(baseB);
    const baseL = new THREE.Mesh(new THREE.PlaneGeometry(widthLR, trimH), trimMat);
    baseL.position.set(-offsetX + inset, trimY, 0);
    baseL.rotation.y = Math.PI / 2;
    wallTrimGroup.add(baseL);
    const baseR = new THREE.Mesh(new THREE.PlaneGeometry(widthLR, trimH), trimMat);
    baseR.position.set(offsetX - inset, trimY, 0);
    baseR.rotation.y = -Math.PI / 2;
    wallTrimGroup.add(baseR);

    // Chair-rail · thin accent strip at ~chair-back height. Gives
    // the wall a wainscot read instead of a flat slab.
    const railH = 0.10;
    const railY = 1.85;
    const railB = new THREE.Mesh(new THREE.PlaneGeometry(widthBack, railH), railMat);
    railB.position.set(0, railY, -offsetZ + inset);
    wallTrimGroup.add(railB);
    const railL = new THREE.Mesh(new THREE.PlaneGeometry(widthLR, railH), railMat);
    railL.position.set(-offsetX + inset, railY, 0);
    railL.rotation.y = Math.PI / 2;
    wallTrimGroup.add(railL);
    const railR = new THREE.Mesh(new THREE.PlaneGeometry(widthLR, railH), railMat);
    railR.position.set(offsetX - inset, railY, 0);
    railR.rotation.y = -Math.PI / 2;
    wallTrimGroup.add(railR);

    // Plant baseboard · dense foliage band hugging the wall-floor
    // seam. Shared procedural texture (lazy) painted to a wide
    // canvas, applied with `transparent: true` so the scalloped top
    // edge shows the wall behind. 3 plane meshes (back / left /
    // right) sit on a sub-group toggled per-tone via
    // refreshWallColors · default hidden so non-constructive tones
    // keep their clean baseboard.
    if (!plantBaseboardTexture) plantBaseboardTexture = buildPlantBaseboardTexture();
    if (!plantBaseboardMat) {
      plantBaseboardMat = new THREE.MeshLambertMaterial({
        map: plantBaseboardTexture,
        transparent: true,
        alphaTest: 0.4,    // crisp scalloped edge instead of a fuzzy halo
        side: THREE.DoubleSide,
      });
    }
    plantBaseboardGroup = new THREE.Group();
    plantBaseboardGroup.visible = false;
    g.add(plantBaseboardGroup);

    // Foliage band geometry · 0.75 world-units tall, centred so the
    // bottom sits at y=0 (floor level) and top reaches ~0.75. Sits
    // 0.02 in front of the wall surface so the texture's transparent
    // pixels show wall, not z-fighting.
    const plantH = 0.75;
    const plantY = plantH / 2;
    const plantInset = 0.02;
    const plantBack = new THREE.Mesh(
      new THREE.PlaneGeometry(widthBack, plantH),
      plantBaseboardMat,
    );
    plantBack.position.set(0, plantY, -offsetZ + plantInset);
    plantBaseboardGroup.add(plantBack);
    const plantLeft = new THREE.Mesh(
      new THREE.PlaneGeometry(widthLR, plantH),
      plantBaseboardMat,
    );
    plantLeft.position.set(-offsetX + plantInset, plantY, 0);
    plantLeft.rotation.y = Math.PI / 2;
    plantBaseboardGroup.add(plantLeft);
    const plantRight = new THREE.Mesh(
      new THREE.PlaneGeometry(widthLR, plantH),
      plantBaseboardMat,
    );
    plantRight.position.set(offsetX - plantInset, plantY, 0);
    plantRight.rotation.y = -Math.PI / 2;
    plantBaseboardGroup.add(plantRight);

    // Wooden baseboard variant · slimmer (0.28h) solid walnut trim
    // sitting at the wall-floor seam. Same 3-mesh layout as the
    // plant baseboard but uses the wood-grain texture · shown under
    // the critique sandstone wall to give the warm stone a wood
    // anchor at floor level. Hidden by default; refreshWallColors
    // flips it on per tone.
    if (!woodBaseboardTexture) woodBaseboardTexture = buildWoodBaseboardTexture();
    if (!woodBaseboardMat) {
      woodBaseboardMat = new THREE.MeshLambertMaterial({
        map: woodBaseboardTexture,
        side: THREE.DoubleSide,
      });
    }
    woodBaseboardGroup = new THREE.Group();
    woodBaseboardGroup.visible = false;
    g.add(woodBaseboardGroup);

    const woodH = 0.50;
    const woodY = woodH / 2;
    const woodInset = 0.025;
    const woodBack = new THREE.Mesh(
      new THREE.PlaneGeometry(widthBack, woodH),
      woodBaseboardMat,
    );
    woodBack.position.set(0, woodY, -offsetZ + woodInset);
    woodBaseboardGroup.add(woodBack);
    const woodLeft = new THREE.Mesh(
      new THREE.PlaneGeometry(widthLR, woodH),
      woodBaseboardMat,
    );
    woodLeft.position.set(-offsetX + woodInset, woodY, 0);
    woodLeft.rotation.y = Math.PI / 2;
    woodBaseboardGroup.add(woodLeft);
    const woodRight = new THREE.Mesh(
      new THREE.PlaneGeometry(widthLR, woodH),
      woodBaseboardMat,
    );
    woodRight.position.set(offsetX - woodInset, woodY, 0);
    woodRight.rotation.y = -Math.PI / 2;
    woodBaseboardGroup.add(woodRight);

    return g;
  }

  /** Procedural wood-baseboard texture · solid walnut plank with
   *  subtle grain stripes + top highlight + bottom shadow + a few
   *  vertical seams that read as butt-jointed boards. 1024×96
   *  (wide-thin) so it stretches naturally across all three wall
   *  lengths. Used as a regular (non-transparent) Lambert material. */
  function buildWoodBaseboardTexture() {
    const W = 1024, H = 96;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    // Plank body · deep warm walnut to anchor the warm critique room.
    ctx.fillStyle = "#5A3A22";
    ctx.fillRect(0, 0, W, H);

    // Subtle grain stripes · horizontal bands of slightly darker
    // walnut, irregular spacing so the wood doesn't look striped.
    const grainRand = mulberry32(91);
    for (let n = 0; n < 28; n++) {
      const gy = Math.floor(grainRand() * (H - 6)) + 3;
      const gw = 60 + Math.floor(grainRand() * 200);
      const gx = Math.floor(grainRand() * (W - gw));
      ctx.fillStyle = grainRand() < 0.5 ? "#4A2E18" : "#6B4528";
      ctx.fillRect(gx, gy, gw, 1);
    }

    // Top highlight · 2px brighter walnut at the upper edge so the
    // baseboard catches a soft cove light.
    ctx.fillStyle = "#8B6940";
    ctx.fillRect(0, 0, W, 1);
    ctx.fillStyle = "#7A5A38";
    ctx.fillRect(0, 1, W, 1);

    // Bottom shadow · 2px deep walnut so the baseboard reads as
    // resting on the floor, not floating.
    ctx.fillStyle = "#3A2410";
    ctx.fillRect(0, H - 1, W, 1);
    ctx.fillStyle = "#241408";
    ctx.fillRect(0, H - 2, W, 1);

    // Butt joints · 4-5 vertical seams across the canvas so the
    // baseboard reads as discrete boards joined end-to-end, not
    // one impossibly-long plank.
    const seamCount = 5;
    for (let i = 1; i < seamCount; i++) {
      const sx = Math.floor((W / seamCount) * i + (grainRand() - 0.5) * 30);
      ctx.fillStyle = "#2A1808";
      ctx.fillRect(sx, 2, 1, H - 4);
      ctx.fillStyle = "#3F2614";
      ctx.fillRect(sx + 1, 2, 1, H - 4);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Procedural plant-baseboard texture · dense foliage band
   *  designed to hug the wall-floor seam. Drawn into a wide
   *  1024×192 canvas with:
   *   · transparent background above the scalloped top edge
   *   · multi-tone green leaf clusters stacked from the bottom up
   *   · taller fern-like fronds at irregular intervals
   *   · a handful of tiny yellow flower speckles
   *  Used as a `transparent + alphaTest` MeshLambertMaterial so
   *  the silhouette is crisp against the stone wall behind. */
  function buildPlantBaseboardTexture() {
    const W = 1024, H = 192;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    // Start fully transparent · only leaf pixels stay opaque, so
    // the scalloped top edge of the band shows the wall texture
    // behind instead of a hard rectangle.
    ctx.clearRect(0, 0, W, H);

    const leafPalette = [
      "#4A6630", "#5E7A3A", "#6E8E48", "#82A656",
      "#476830", "#3F5F2A", "#7C9A48", "#62844A",
    ];
    const shadowPalette = ["#2F4322", "#37501F", "#283A18"];
    const flowerPalette = ["#F2E36A", "#E8C84A", "#F0F0E0"];
    const rand = mulberry32(37);

    // Dense base · the bottom 60% is mostly opaque foliage so the
    // band reads as a thick hedge resting on the floor, not as a
    // sparse smattering of leaves.
    const baseTop = Math.floor(H * 0.42);  // foliage solid below here
    for (let y = baseTop; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = (y - baseTop) / (H - baseTop);
        const pickShadow = rand() < (0.18 - t * 0.10);
        const palette = pickShadow ? shadowPalette : leafPalette;
        ctx.fillStyle = palette[Math.floor(rand() * palette.length)];
        ctx.fillRect(x, y, 1, 1);
      }
    }

    // Top scallop · cluster mounds of leaves above the solid base
    // for an organic silhouette. Each mound is an irregular dome of
    // leaf pixels picked from the palette.
    const moundsPerSpan = 60;
    for (let n = 0; n < moundsPerSpan; n++) {
      const cx = Math.floor(rand() * W);
      const r = 8 + Math.floor(rand() * 14);      // mound radius
      const cy = baseTop - Math.floor(rand() * 8);
      const tone = leafPalette[Math.floor(rand() * leafPalette.length)];
      ctx.fillStyle = tone;
      for (let py = -r; py <= 0; py++) {
        const w = Math.floor(Math.sqrt(Math.max(0, r * r - py * py)));
        // Wobble the edge by ±1 so it doesn't read as a perfect arc.
        const wobble = (rand() < 0.5 ? 0 : 1);
        ctx.fillRect(cx - w + wobble, cy + py, w * 2, 1);
      }
      // Highlight speckles on top of the mound.
      ctx.fillStyle = leafPalette[Math.floor(rand() * leafPalette.length)];
      ctx.fillRect(cx - 1, cy - r + 1, 2, 1);
      ctx.fillRect(cx + Math.floor(r * 0.4), cy - Math.floor(r * 0.7), 2, 1);
    }

    // Tall fronds · vertical stems rising above the scallop on a
    // handful of spots, with a small leaf cluster at the top.
    const fronds = 16;
    for (let n = 0; n < fronds; n++) {
      const fx = Math.floor(rand() * W);
      const fh = 22 + Math.floor(rand() * 30);
      const stemTone = shadowPalette[Math.floor(rand() * shadowPalette.length)];
      ctx.fillStyle = stemTone;
      for (let py = 0; py < fh; py++) {
        const wobble = Math.sin(py * 0.3 + n) > 0 ? 1 : 0;
        ctx.fillRect(fx + wobble, baseTop - py, 1, 1);
      }
      // Top leaf cluster · 3 small leaves around the stem tip.
      const leafTone = leafPalette[Math.floor(rand() * leafPalette.length)];
      ctx.fillStyle = leafTone;
      const tipY = baseTop - fh;
      ctx.fillRect(fx - 2, tipY - 1, 5, 1);
      ctx.fillRect(fx - 1, tipY - 2, 3, 1);
      ctx.fillRect(fx, tipY - 3, 1, 1);
    }

    // Flower speckles · tiny 2×2 yellow / cream dots scattered
    // across the foliage for a hint of bloom.
    for (let n = 0; n < 24; n++) {
      const fx = Math.floor(rand() * W);
      const fy = baseTop + 4 + Math.floor(rand() * (H - baseTop - 6));
      const tone = flowerPalette[Math.floor(rand() * flowerPalette.length)];
      ctx.fillStyle = tone;
      ctx.fillRect(fx, fy, 2, 2);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Voxel props that sit on the table top.
   *
   *  Layout has two registers:
   *    · MICS are fixed (front-facing toward chair + back-facing
   *      toward top-row directors). The 2 microphones are the room's
   *      anchor; they never move so the user always sees a stable
   *      audio register.
   *    · OTHER PROPS are randomised every mount · the pool includes
   *      books, coffee cup, laptop, phone, marker, sticky notes,
   *      water bottle. 4-5 props are picked at random from the pool
   *      and dropped into 4-5 (randomly shuffled) slot positions
   *      with a small jitter + rotation, so each room visit feels
   *      lived-in instead of a static set dressing.
   *
   *  Positions are TABLE-LOCAL coords (x and z relative to table
   *  centre; y is on top of the table top slab at TOP_Y = 1.25). */
  function buildTableProps() {
    const g = new THREE.Group();
    // Table top slab top y · matches the buildTable() math:
    // bodyH (0.9) + topH (0.35) = 1.25
    const TOP_Y = 1.25;

    // ── Mics · fixed positions ───────────────────────────────
    const buildMic = (x, z, faceForward) => {
      const mg = new THREE.Group();
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.10, 0.10, 0.025, 16),
        new THREE.MeshLambertMaterial({ color: 0x2A2A2A }),
      );
      base.position.set(0, TOP_Y + 0.012, 0);
      mg.add(base);
      const stand = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 0.38, 8),
        new THREE.MeshLambertMaterial({ color: 0x3A3A3A }),
      );
      stand.position.set(0, TOP_Y + 0.215, 0);
      mg.add(stand);
      const head = new THREE.Mesh(
        new THREE.BoxGeometry(0.13, 0.16, 0.10),
        new THREE.MeshLambertMaterial({ color: 0x1A1A1A }),
      );
      head.position.set(0, TOP_Y + 0.45, faceForward ? 0.03 : -0.03);
      head.rotation.x = faceForward ? -0.20 : 0.20;
      mg.add(head);
      const grille = new THREE.Mesh(
        new THREE.BoxGeometry(0.105, 0.10, 0.012),
        new THREE.MeshLambertMaterial({ color: 0x6B6B6B }),
      );
      const grilleZ = faceForward ? 0.083 : -0.083;
      grille.position.set(0, TOP_Y + 0.45, grilleZ);
      grille.rotation.x = faceForward ? -0.20 : 0.20;
      mg.add(grille);
      mg.position.set(x, 0, z);
      return mg;
    };
    g.add(buildMic(0.4, 0.4, true));
    g.add(buildMic(0.4, -0.4, false));

    // ── Random prop pool · each builder returns a group anchored
    // at (0, 0, 0) so slot placement + rotation are uniform across
    // prop types. ────────────────────────────────────────────────
    function buildBookStackGroup() {
      const pg = new THREE.Group();
      const bookBot = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.08, 0.20),
        new THREE.MeshLambertMaterial({ color: 0x9E4A3A }),
      );
      bookBot.position.set(0, TOP_Y + 0.04, 0);
      pg.add(bookBot);
      const bookBotHi = new THREE.Mesh(
        new THREE.BoxGeometry(0.55, 0.015, 0.04),
        new THREE.MeshLambertMaterial({ color: 0xBF6B5C }),
      );
      bookBotHi.position.set(0, TOP_Y + 0.08, 0.085);
      pg.add(bookBotHi);
      const bookTop = new THREE.Mesh(
        new THREE.BoxGeometry(0.48, 0.07, 0.18),
        new THREE.MeshLambertMaterial({ color: 0x2A3E5C }),
      );
      bookTop.position.set(0.05, TOP_Y + 0.115, -0.015);
      pg.add(bookTop);
      const bookTopHi = new THREE.Mesh(
        new THREE.BoxGeometry(0.48, 0.012, 0.04),
        new THREE.MeshLambertMaterial({ color: 0x4A6390 }),
      );
      bookTopHi.position.set(0.05, TOP_Y + 0.148, 0.05);
      pg.add(bookTopHi);
      return pg;
    }

    function buildCoffeeCupGroup() {
      const pg = new THREE.Group();
      const saucer = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.16, 0.015, 20),
        new THREE.MeshLambertMaterial({ color: 0xDED9D0 }),
      );
      saucer.position.set(0, TOP_Y + 0.0075, 0);
      pg.add(saucer);
      const cupBody = new THREE.Mesh(
        new THREE.CylinderGeometry(0.10, 0.08, 0.18, 16),
        new THREE.MeshLambertMaterial({ color: 0xF0EDE6 }),
      );
      cupBody.position.set(0, TOP_Y + 0.09, 0);
      pg.add(cupBody);
      const cupRim = new THREE.Mesh(
        new THREE.CylinderGeometry(0.10, 0.10, 0.015, 16),
        new THREE.MeshLambertMaterial({ color: 0xC9C5BE }),
      );
      cupRim.position.set(0, TOP_Y + 0.182, 0);
      pg.add(cupRim);
      const cupHandle = new THREE.Mesh(
        new THREE.TorusGeometry(0.05, 0.012, 6, 16),
        new THREE.MeshLambertMaterial({ color: 0xF0EDE6 }),
      );
      cupHandle.position.set(0.10, TOP_Y + 0.09, 0);
      cupHandle.rotation.y = Math.PI / 2;
      pg.add(cupHandle);
      return pg;
    }

    function buildLaptopGroup() {
      const pg = new THREE.Group();
      // Keyboard base (slim slab)
      const base = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.025, 0.30),
        new THREE.MeshLambertMaterial({ color: 0x6B6B6B }),
      );
      base.position.set(0, TOP_Y + 0.013, 0);
      pg.add(base);
      // Lid (tilted back ~75° so the screen catches camera light)
      const lidTilt = -Math.PI * 0.42;
      const lid = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.025, 0.28),
        new THREE.MeshLambertMaterial({ color: 0x4A4A4A }),
      );
      lid.rotation.x = lidTilt;
      lid.position.set(0, TOP_Y + 0.14, -0.13);
      pg.add(lid);
      // Screen face (slightly in front of lid)
      const screen = new THREE.Mesh(
        new THREE.BoxGeometry(0.40, 0.24, 0.01),
        new THREE.MeshLambertMaterial({ color: 0x6BA8D8 }),
      );
      screen.rotation.x = lidTilt;
      screen.position.set(0, TOP_Y + 0.14, -0.118);
      pg.add(screen);
      return pg;
    }

    function buildPhoneGroup() {
      const pg = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.02, 0.24),
        new THREE.MeshLambertMaterial({ color: 0x1F1F1F }),
      );
      body.position.set(0, TOP_Y + 0.01, 0);
      pg.add(body);
      const screen = new THREE.Mesh(
        new THREE.BoxGeometry(0.10, 0.005, 0.21),
        new THREE.MeshLambertMaterial({ color: 0x3A4A60 }),
      );
      screen.position.set(0, TOP_Y + 0.0225, 0);
      pg.add(screen);
      return pg;
    }

    function buildMarkerGroup() {
      const pg = new THREE.Group();
      // Body lies flat along the x axis (rotation Z brings cylinder
      // from upright to horizontal).
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.018, 0.26, 8),
        new THREE.MeshLambertMaterial({ color: 0x1A1A1A }),
      );
      body.rotation.z = Math.PI / 2;
      body.position.set(0, TOP_Y + 0.018, 0);
      pg.add(body);
      // Cap on one end · accent colour for a pop of red.
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.020, 0.020, 0.05, 8),
        new THREE.MeshLambertMaterial({ color: 0xC04A3A }),
      );
      cap.rotation.z = Math.PI / 2;
      cap.position.set(-0.13, TOP_Y + 0.018, 0);
      pg.add(cap);
      return pg;
    }

    function buildStickyNotesGroup() {
      const pg = new THREE.Group();
      const pad = new THREE.Mesh(
        new THREE.BoxGeometry(0.26, 0.04, 0.26),
        new THREE.MeshLambertMaterial({ color: 0xE8D858 }),
      );
      pad.position.set(0, TOP_Y + 0.02, 0);
      pg.add(pad);
      // Brighter top sheet (most recent sticky note).
      const top = new THREE.Mesh(
        new THREE.BoxGeometry(0.26, 0.006, 0.26),
        new THREE.MeshLambertMaterial({ color: 0xF7E97A }),
      );
      top.position.set(0, TOP_Y + 0.0432, 0);
      pg.add(top);
      return pg;
    }

    function buildWaterBottleGroup() {
      const pg = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.055, 0.055, 0.30, 12),
        new THREE.MeshLambertMaterial({ color: 0xA8C8E0 }),
      );
      body.position.y = TOP_Y + 0.15;
      pg.add(body);
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.038, 0.038, 0.05, 12),
        new THREE.MeshLambertMaterial({ color: 0x2A4D70 }),
      );
      cap.position.y = TOP_Y + 0.325;
      pg.add(cap);
      return pg;
    }

    // ── Slot positions · mic-free zones around the table top.
    // Chosen so the minimum distance from any slot centre to either
    // mic (0.4, ±0.4) is > 0.6 world-units even after jitter, so
    // randomly-rotated props don't clip into the mic stands.
    const slots = [
      { x: -2.2, z: -0.40 },
      { x: -1.8, z:  0.42 },
      { x: -1.05, z: -0.42 },
      { x: -1.05, z:  0.42 },
      { x:  1.6, z: -0.42 },
      { x:  1.6, z:  0.42 },
      { x:  2.3, z:  0.00 },
      { x: -0.20, z:  0.00 },
    ];
    const pool = [
      buildBookStackGroup,
      buildCoffeeCupGroup,
      buildLaptopGroup,
      buildPhoneGroup,
      buildMarkerGroup,
      buildStickyNotesGroup,
      buildWaterBottleGroup,
    ];

    // Shuffle slots + pick 4-5 of them; for each pick a random prop
    // and apply small jitter + rotation so the table reads as
    // "freshly used" rather than a perfectly aligned set.
    const shuffled = slots.slice().sort(() => Math.random() - 0.5);
    const propCount = 4 + Math.floor(Math.random() * 2);
    for (let i = 0; i < propCount && i < shuffled.length; i++) {
      const slot = shuffled[i];
      const builder = pool[Math.floor(Math.random() * pool.length)];
      const propGroup = builder();
      const jitterX = (Math.random() - 0.5) * 0.20;
      const jitterZ = (Math.random() - 0.5) * 0.14;
      const rotY = (Math.random() - 0.5) * 0.7;
      propGroup.position.set(slot.x + jitterX, 0, slot.z + jitterZ);
      propGroup.rotation.y = rotY;
      g.add(propGroup);
    }

    return g;
  }

  /** Procedural grayscale grain · horizontal streaks (run along the
   *  table length) over a near-white base, with a few darker knots and
   *  fine per-row noise. Used as `.map` so it MODULATES the per-tone
   *  colour rather than replacing it · white→colour as-is, the ~0.82
   *  streaks darken slightly to read as wood / moulded grain. */
  function buildTableGrainTexture() {
    const W = 512, H = 128;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const rand = mulberry32(73);
    // Near-white base · keeps the material colour intact between streaks.
    ctx.fillStyle = "#FAFAFA"; ctx.fillRect(0, 0, W, H);
    // Long horizontal grain streaks · slightly darker greys, varied
    // length / opacity so the grain reads organic, not striped.
    for (let i = 0; i < 90; i++) {
      const y = Math.floor(rand() * H);
      const len = 80 + Math.floor(rand() * (W - 80));
      const x = Math.floor(rand() * (W - len));
      const g = 200 + Math.floor(rand() * 38);          // 0xC8..0xEE
      const a = 0.10 + rand() * 0.22;
      ctx.fillStyle = `rgba(${g - 40},${g - 46},${g - 54},${a.toFixed(3)})`;
      ctx.fillRect(x, y, len, 1);
    }
    // A handful of darker knots / figure swirls.
    for (let i = 0; i < 6; i++) {
      const cx = Math.floor(rand() * W);
      const cy = Math.floor(rand() * H);
      const r = 3 + Math.floor(rand() * 6);
      ctx.fillStyle = `rgba(120,108,92,${(0.10 + rand() * 0.12).toFixed(3)})`;
      ctx.beginPath(); ctx.ellipse(cx, cy, r, Math.max(1, r * 0.4), 0, 0, Math.PI * 2); ctx.fill();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 1); // denser grain along the long axis
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  function buildTable() {
    // Stacked-box voxel table · centre of the stage. Dimensions
    // tuned tight against the seat ring · side directors at
    // |wz|≈1.38 sit just outside table half-depth 0.75 + chair half
    // 0.4 + tiny visual gap. Long narrow profile (W:D ≈ 4.3:1)
    // matches the 2D SVG table's 100:30 aspect.
    const g = new THREE.Group();
    const tableW = 6.5;
    const tableD = 1.5;
    const topH = 0.35;
    const bodyH = 0.9;

    // Materials are module-scope · refreshTable() retints them per tone
    // right after mount (and on every mode change), so the initial WOOD
    // colours here are just a placeholder until the first refresh.
    tableBodyMat = new THREE.MeshLambertMaterial({ color: WOOD.mid });
    tableTopMat = new THREE.MeshLambertMaterial({ color: WOOD.hi });
    tableShadeMat = new THREE.MeshLambertMaterial({ color: WOOD.shade });

    // Body (mid wood) · sits with its top at y=topH baseline so chairs
    // can tuck under naturally.
    const body = new THREE.Mesh(new THREE.BoxGeometry(tableW, bodyH, tableD), tableBodyMat);
    body.position.y = bodyH / 2;
    g.add(body);

    // Top slab (rim wood, slightly lighter) · sits flush above body
    // for the chunky "two-layer" pixel-art read. constructive turns this
    // translucent (glass) via refreshTable.
    const top = new THREE.Mesh(new THREE.BoxGeometry(tableW + 0.1, topH, tableD + 0.1), tableTopMat);
    top.position.y = bodyH + topH / 2;
    g.add(top);

    // Bottom shadow slab (dark wood) · a thin dark strip under the body
    // grounds the table to the floor like the SVG's `.rt-table-floor`
    // ellipse does in 2D.
    const shade = new THREE.Mesh(new THREE.BoxGeometry(tableW + 0.05, 0.08, tableD + 0.05), tableShadeMat);
    shade.position.y = 0.04;
    g.add(shade);

    return g;
  }

  /** Retint the shared table materials to the active tone + apply its
   *  material finish · "wood" (opaque matte), "glass" (translucent top
   *  over a steel body · constructive), "acrylic" (whole table
   *  translucent), or "plastic" (opaque, vivid, with a small emissive
   *  lift so the bright colour reads glossy · brainstorm). Cheap +
   *  idempotent, safe every update() tick; mirrors refreshWallColors. */
  function refreshTable(mode) {
    if (!tableBodyMat || !tableTopMat || !tableShadeMat) return;
    if (!tableGrainTex) tableGrainTex = buildTableGrainTexture();
    const p = TABLE_PALETTE_BY_TONE[mode] || TABLE_PALETTE_BY_TONE.debate;
    const finish = p.material || "wood";
    tableBodyMat.color.setHex(p.body);
    tableShadeMat.color.setHex(p.shade);
    tableTopMat.color.setHex(p.top);
    const applyFinish = (mat, translucent, opacity) => {
      if (mat.transparent !== translucent) { mat.transparent = translucent; mat.needsUpdate = true; }
      mat.opacity = translucent ? opacity : 1;
    };
    // acrylic · body + top translucent; glass · only the top; else opaque.
    const bodyTranslucent = finish === "acrylic";
    const topTranslucent = finish === "acrylic" || finish === "glass";
    applyFinish(tableBodyMat, bodyTranslucent, 0.5);
    applyFinish(tableTopMat, topTranslucent, 0.55);
    applyFinish(tableShadeMat, finish === "acrylic", 0.4); // soften the floor shadow under see-through tables
    // Grain map · only on the OPAQUE faces. See-through glass / acrylic
    // surfaces stay clean (a texture on translucent glass reads as dirt).
    const setMap = (mat, on) => {
      const want = on ? tableGrainTex : null;
      if (mat.map !== want) { mat.map = want; mat.needsUpdate = true; }
    };
    setMap(tableBodyMat, !bodyTranslucent);
    setMap(tableTopMat, !topTranslucent);
    // plastic · a small emissive of the body/top colour so the vivid hue
    // reads as glossy moulded plastic, not flat matte wood. Kept low so
    // the table doesn't self-glow and wash the room out. Other finishes
    // reset emissive to black (no glow).
    const plastic = finish === "plastic";
    tableBodyMat.emissive.setHex(plastic ? p.body : 0x000000);
    tableTopMat.emissive.setHex(plastic ? p.top : 0x000000);
    tableBodyMat.emissiveIntensity = 0.10;
    tableTopMat.emissiveIntensity = 0.10;
  }

  /** Brainstorm-only 3D furniture group · a chest of drawers + a low
   *  sofa as box meshes against the back wall, scaled to harmonise with
   *  the 6.5×1.25 table. Lit by the room lights (no emissive) so they
   *  read with real box-shaded depth — the user's "3D feel". */
  function buildRoomFurniture(mode) {
    const g = new THREE.Group();
    const backZ = -STAGE_HALF_Z * 1.45;        // back wall plane (≈ -8.7)
    if (mode === "brainstorm") {
      const chest = buildChestOfDrawers();
      chest.position.set(-3.4, 0, backZ + 0.36);
      g.add(chest);
      const sofa = buildLowSofa();
      sofa.position.set(2.9, 0, backZ + 0.6);
      g.add(sofa);
    } else if (mode === "debate") {
      const lectern = buildLectern();        // forum rostrum
      lectern.position.set(3.0, 0, backZ + 0.6);
      g.add(lectern);
      const sideboard = buildChestOfDrawers({ body: 0x7A5230, top: 0xB8884E, dk: 0x4A2E18, knob: 0x3A2410 });
      sideboard.position.set(-3.3, 0, backZ + 0.36);
      g.add(sideboard);
    } else if (mode === "research") {
      // The wall is already floor-to-ceiling bookcases, so no 3D shelf
      // here (it would just double up) — a floor globe is plenty.
      const globe = buildGlobe();
      globe.position.set(3.0, 0, backZ + 0.7);
      g.add(globe);
    } else if (mode === "constructive") {
      const credenza = buildChestOfDrawers({ body: 0x3A424C, top: 0x4A525C, dk: 0x23272E, knob: 0x8A929C });
      credenza.position.set(-3.3, 0, backZ + 0.36);  // sleek steel credenza
      g.add(credenza);
    } else if (mode === "critique") {
      const credenza = buildChestOfDrawers({ body: 0x4A2A20, top: 0x6B3F2F, dk: 0x2A1612, knob: 0xC9A85A });
      credenza.position.set(-3.3, 0, backZ + 0.36);  // mahogany + brass
      g.add(credenza);
      const globe = buildGlobe();
      globe.position.set(3.2, 0, backZ + 0.7);
      g.add(globe);
    }
    return g;
  }

  /** Swap the back-wall furniture to the active tone · rebuilds only on
   *  a tone change (disposing the previous group's geometry + materials)
   *  so an unchanged tone is a no-op every update() tick. */
  function refreshFurniture(mode) {
    if (!scene) return;
    if (mode === roomFurnitureMode && roomFurniture) return;
    if (roomFurniture) {
      scene.remove(roomFurniture);
      roomFurniture.traverse((o) => {
        if (o.geometry) { try { o.geometry.dispose(); } catch (_) { /* */ } }
        if (o.material) { try { o.material.dispose(); } catch (_) { /* */ } }
      });
    }
    roomFurniture = buildRoomFurniture(mode);
    roomFurnitureMode = mode;
    scene.add(roomFurniture);
  }

  /** Mid-century chest of drawers / credenza · box body on splayed legs,
   *  three drawer fronts proud of the face with paired knobs, a lighter
   *  top slab. ~2.2w × 1.22h × 0.55d (top lands a touch below the table
   *  top at y≈1.25). `pal` recolours it into a sideboard / steel credenza
   *  / mahogany credenza; the default (no `pal`) is the warm-oak
   *  brainstorm chest, which also gets a cozy vase + sprig on top. */
  function buildChestOfDrawers(pal) {
    const g = new THREE.Group();
    const W = 2.2, D = 0.55, legH = 0.2, bodyH = 0.92, topH = 0.1;
    const OAK = pal ? pal.body : 0xB08A5A;
    const OAK_HI = pal ? pal.top : 0xC8A472;
    const OAK_DK = pal ? pal.dk : 0x6E5230;
    const KNOB = pal ? pal.knob : 0x4A3422;
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const legGeo = new THREE.BoxGeometry(0.1, legH, 0.1);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(legGeo, mat(OAK_DK));
      leg.position.set(sx * (W / 2 - 0.16), legH / 2, sz * (D / 2 - 0.12));
      g.add(leg);
    }
    const body = new THREE.Mesh(new THREE.BoxGeometry(W, bodyH, D), mat(OAK));
    body.position.set(0, legH + bodyH / 2, 0);
    g.add(body);
    const top = new THREE.Mesh(new THREE.BoxGeometry(W + 0.08, topH, D + 0.08), mat(OAK_HI));
    top.position.set(0, legH + bodyH + topH / 2, 0);
    g.add(top);
    const dn = 3, gap = 0.04, dh = (bodyH - gap * (dn + 1)) / dn, frontZ = D / 2 + 0.015;
    for (let i = 0; i < dn; i++) {
      const dy = legH + gap + dh / 2 + i * (dh + gap);
      const front = new THREE.Mesh(new THREE.BoxGeometry(W - 0.12, dh, 0.03), mat(OAK_HI));
      front.position.set(0, dy, frontZ);
      g.add(front);
      const knobGeo = new THREE.BoxGeometry(0.07, 0.07, 0.05);
      for (const kx of [-W * 0.2, W * 0.2]) {
        const knob = new THREE.Mesh(knobGeo, mat(KNOB));
        knob.position.set(kx, dy, frontZ + 0.03);
        g.add(knob);
      }
    }
    if (!pal) { // cozy vase + sprig only on the default oak chest
      const vase = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.2, 0.14), mat(0xC7B6A0));
      vase.position.set(-W * 0.28, legH + bodyH + topH + 0.1, 0);
      g.add(vase);
      const sprig = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.22, 0.04), mat(0x5E8A52));
      sprig.position.set(-W * 0.28, legH + bodyH + topH + 0.3, 0);
      g.add(sprig);
    }
    return g;
  }

  /** Low sage sofa · seat base + backrest + two arms + cushions + wood
   *  legs, all boxes. ~2.7w × 0.94h × 0.95d, faces +z (toward camera). */
  function buildLowSofa() {
    const g = new THREE.Group();
    const W = 2.7, D = 0.95, legH = 0.16, seatH = 0.28, backH = 0.5, armW = 0.26;
    const SAGE = 0x8CA07E, SAGE_HI = 0xA4B695, SAGE_DK = 0x6E835E, LEG = 0x6E5230;
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const legGeo = new THREE.BoxGeometry(0.1, legH, 0.1);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(legGeo, mat(LEG));
      leg.position.set(sx * (W / 2 - 0.14), legH / 2, sz * (D / 2 - 0.12));
      g.add(leg);
    }
    const seat = new THREE.Mesh(new THREE.BoxGeometry(W, seatH, D), mat(SAGE_DK));
    seat.position.set(0, legH + seatH / 2, 0);
    g.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(W, backH, 0.2), mat(SAGE));
    back.position.set(0, legH + seatH + backH / 2, -D / 2 + 0.1);
    g.add(back);
    const armGeo = new THREE.BoxGeometry(armW, seatH + 0.18, D);
    for (const sx of [-1, 1]) {
      const arm = new THREE.Mesh(armGeo, mat(SAGE_DK));
      arm.position.set(sx * (W / 2 - armW / 2), legH + (seatH + 0.18) / 2, 0);
      g.add(arm);
    }
    const innerW = W - armW * 2;
    const scN = 2, scW = innerW / scN;
    for (let i = 0; i < scN; i++) {
      const cush = new THREE.Mesh(new THREE.BoxGeometry(scW - 0.06, 0.12, D - 0.18), mat(SAGE_HI));
      cush.position.set(-innerW / 2 + scW * (i + 0.5), legH + seatH + 0.06, 0.04);
      g.add(cush);
    }
    const bcN = 3, bcW = innerW / bcN;
    for (let i = 0; i < bcN; i++) {
      const cush = new THREE.Mesh(new THREE.BoxGeometry(bcW - 0.06, backH - 0.1, 0.12), mat(SAGE_HI));
      cush.position.set(-innerW / 2 + bcW * (i + 0.5), legH + seatH + backH / 2, -D / 2 + 0.22);
      g.add(cush);
    }
    return g;
  }

  /** Forum lectern (debate) · an oak column on a base with a slanted
   *  reading top + a front lip. ~0.7w × 1.5h. */
  function buildLectern() {
    const g = new THREE.Group();
    const OAK = 0x7A5230, OAK_HI = 0xB8884E, OAK_DK = 0x4A2E18;
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.5), mat(OAK_DK)); base.position.set(0, 0.05, 0); g.add(base);
    const col = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.0, 0.34), mat(OAK)); col.position.set(0, 0.6, 0); g.add(col);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.4, 0.5), mat(OAK)); head.position.set(0, 1.3, 0); head.rotation.x = -0.35; g.add(head);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.06, 0.08), mat(OAK_HI)); lip.position.set(0, 1.16, 0.22); g.add(lip);
    return g;
  }

  /** Floor globe (research / critique) · a blue sphere with a faint land
   *  overlay on a brass post + dark stand. ~1.1h. */
  function buildGlobe() {
    const g = new THREE.Group();
    const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.1, 0.32), mat(0x4A3422)); stand.position.set(0, 0.05, 0); g.add(stand);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.42, 0.06), mat(0xC9A85A)); post.position.set(0, 0.3, 0); g.add(post);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), mat(0x3A6B8A)); ball.position.set(0, 0.8, 0); g.add(ball);
    const land = new THREE.Mesh(new THREE.SphereGeometry(0.325, 10, 8),
      new THREE.MeshLambertMaterial({ color: 0x6E9A5A, transparent: true, opacity: 0.45 }));
    land.position.copy(ball.position); g.add(land);
    return g;
  }

  /* ── Sheen armchair (brainstorm) ───────────────────────────────
     A cozy mid-century upholstered armchair, echoing three.js'
     `webgl_loader_gltf_sheen` SheenChair silhouette · splayed slim
     wooden legs, a plump velvet seat cushion, a leaned-back padded
     backrest with a lighter "sheen catch" inner panel, and two arm
     bolsters. The original is a smooth PBR velvet GLB; we keep the
     scene's box aesthetic but use MeshPhongMaterial on the cushions
     so a soft specular reads as velvet sheen under the room lights.
     Footprint stays within CHAIR_WIDTH so side seats don't collide.

     Palette is tone-keyed (SHEEN_PALETTE_BY_TONE) so the same model
     dresses each room in its own fabric · warm ochre velvet for the
     forest-green/cream brainstorm room (green × ochre, the classic
     mid-century pairing), cool slate-blue velvet on charcoal metal
     legs for the steel-and-glass constructive room. */
  function buildSheenChair(pal) {
    const p = pal || SHEEN_PALETTE_BY_TONE.brainstorm;
    const g = new THREE.Group();

    const VELVET      = p.body;    // velvet body
    const VELVET_LIT  = p.lit;     // sheen catch · lighter panel
    const VELVET_DK   = p.shade;   // arm + side shade
    const WALNUT      = p.leg;      // splayed legs

    const velvet = (c) => new THREE.MeshPhongMaterial({
      color: c, specular: p.specular, shininess: 10,
    });

    // Splayed slim wooden legs · tapered cylinders tilted outward
    // (mid-century hallmark). Top meets the cushion underside.
    const legLen = 0.44;
    const legGeo = new THREE.CylinderGeometry(0.032, 0.022, legLen, 10);
    const legMat = new THREE.MeshLambertMaterial({ color: WALNUT });
    const legX = CHAIR_WIDTH / 2 - 0.16;
    const legZ = CHAIR_DEPTH / 2 - 0.16;
    const splay = 0.16;
    for (const [sx, sz] of [[-1, -1], [+1, -1], [-1, +1], [+1, +1]]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(sx * legX, legLen / 2, sz * legZ);
      leg.rotation.z = -sx * splay;
      leg.rotation.x = sz * splay;
      g.add(leg);
    }

    // Upholstered shell · the rounded under-seat body the cushion
    // nests in. Sits just below the cushion top.
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(CHAIR_WIDTH, 0.2, CHAIR_DEPTH * 0.92),
      velvet(VELVET_DK),
    );
    shell.position.y = CHAIR_SEAT_H - 0.06;
    g.add(shell);

    // Seat cushion · plump velvet box on top of the shell.
    const cushion = new THREE.Mesh(
      new THREE.BoxGeometry(CHAIR_WIDTH * 0.86, 0.16, CHAIR_DEPTH * 0.8),
      velvet(VELVET),
    );
    cushion.position.y = CHAIR_SEAT_H + 0.07;
    g.add(cushion);

    // Backrest · padded, leaned back ~10°. Pivot at the cushion's
    // rear edge so the lean swings the top backward, not the base.
    const backH = 0.92;
    const backGroup = new THREE.Group();
    backGroup.position.set(0, CHAIR_SEAT_H + 0.06, -CHAIR_DEPTH / 2 + 0.16);
    // Recline · negative tilts the top AWAY from the camera (+z is
    // toward the viewer). A positive angle would lean the back
    // forward over the seat and clip through the director sprite.
    backGroup.rotation.x = -0.17;
    g.add(backGroup);

    const back = new THREE.Mesh(
      new THREE.BoxGeometry(CHAIR_WIDTH * 0.9, backH, 0.16),
      velvet(VELVET),
    );
    back.position.y = backH / 2;
    backGroup.add(back);

    // Sheen catch · a lighter velvet inner panel, the highlight the
    // SheenChair is named for. Slightly proud of the back face.
    const catchPanel = new THREE.Mesh(
      new THREE.BoxGeometry(CHAIR_WIDTH * 0.66, backH * 0.78, 0.03),
      velvet(VELVET_LIT),
    );
    catchPanel.position.set(0, backH / 2, 0.09);
    backGroup.add(catchPanel);

    // Arm bolsters · two padded rolls along the sides, fronts rounded
    // by a capping cylinder. Kept thin so total width stays in budget.
    const armH = 0.2;
    const armY = CHAIR_SEAT_H + 0.18;
    const armDepth = CHAIR_DEPTH * 0.72;
    for (const sx of [-1, +1]) {
      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, armH, armDepth),
        velvet(VELVET_DK),
      );
      arm.position.set(sx * (CHAIR_WIDTH / 2 - 0.02), armY, -0.04);
      g.add(arm);
      // Rounded front cap.
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(armH / 2, armH / 2, 0.12, 12),
        velvet(VELVET_DK),
      );
      cap.rotation.z = Math.PI / 2;
      cap.position.set(sx * (CHAIR_WIDTH / 2 - 0.02), armY, -0.04 + armDepth / 2);
      g.add(cap);
    }

    return g;
  }

  /** Every seat is the upholstered sheen armchair now · the old voxel
   *  chair was retired. Dressed in the room's velvet palette, falling
   *  back to the brainstorm ochre for any unmapped tone. */
  function buildChair(mode) {
    return buildSheenChair(SHEEN_PALETTE_BY_TONE[mode]);
  }

  /* ── Plants ────────────────────────────────────────────────
     Voxel translations of the two 2D corner SVG plants. Palette
     is taken verbatim from `.rt-plant-*` (deep green silhouette,
     mid green body, light green highlight, terracotta pot, dark
     soil). Both share `buildPot` so a future palette tweak stays
     consistent across them. */

  const PLANT = {
    leafDeep:    0x2A4F1D,
    leafMid:     0x3D6E2F,
    leafLight:   0x6BAA48,
    leafShade:   0x1F3A14,
    soil:        0x3D2418,
    potBody:     0x8C4A2F,
    potHi:       0xA86348,
    potShade:    0x5A2D14,
  };

  function buildPot() {
    // 3-tier voxel pot · narrow base, wider rim, dark soil cap on
    // top so the plant's stem appears to sit IN the pot. Built at
    // origin · caller sets group.position.
    const g = new THREE.Group();
    // Body (trapezoidal feel via two stacked boxes)
    const bodyBot = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.35, 0.55),
      new THREE.MeshLambertMaterial({ color: PLANT.potBody }),
    );
    bodyBot.position.y = 0.175;
    g.add(bodyBot);
    const bodyTop = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.35, 0.7),
      new THREE.MeshLambertMaterial({ color: PLANT.potHi }),
    );
    bodyTop.position.y = 0.525;
    g.add(bodyTop);
    // Soil cap · dark brown slab inset by 0.05 on each side so the
    // pot rim wraps it.
    const soil = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.08, 0.6),
      new THREE.MeshLambertMaterial({ color: PLANT.soil }),
    );
    soil.position.y = 0.74;
    g.add(soil);
    // Rim shadow band · thin dark slice under the soil to give the
    // pot opening a recessed lip read.
    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(0.72, 0.06, 0.72),
      new THREE.MeshLambertMaterial({ color: PLANT.potShade }),
    );
    rim.position.y = 0.69;
    g.add(rim);
    return g;
  }

  function buildBushyPlant(x, z) {
    // Bushy plant · pot + a cluster of overlapping leaf boxes that
    // approximates the 2D oval silhouette. Three depth layers:
    // dark back, mid main, light highlight specks.
    const g = new THREE.Group();
    g.add(buildPot());

    // Stem · short brown box between soil and leaf base.
    const stem = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.18, 0.1),
      new THREE.MeshLambertMaterial({ color: 0x5A3A1F }),
    );
    stem.position.y = 0.85;
    g.add(stem);

    // Leaf cluster · 7 boxes of varying sizes at slightly different
    // positions + rotations, in 3 colour layers.
    const cluster = new THREE.Group();
    cluster.position.y = 1.05;
    // Back layer (dark silhouette · largest, sits behind)
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.55, 0.9),
      new THREE.MeshLambertMaterial({ color: PLANT.leafDeep }),
    );
    back.position.y = 0.28;
    cluster.add(back);
    // Mid layer (main body · slightly smaller, offset forward)
    const mid = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.45, 0.75),
      new THREE.MeshLambertMaterial({ color: PLANT.leafMid }),
    );
    mid.position.set(0, 0.22, 0.05);
    cluster.add(mid);
    // Front highlight specks · small light-green boxes
    const specs = [
      { x: -0.2, y: 0.30, z: 0.35, s: 0.20 },
      { x: +0.15, y: 0.42, z: 0.30, s: 0.18 },
      { x: -0.05, y: 0.10, z: 0.38, s: 0.16 },
      { x: +0.30, y: 0.18, z: 0.25, s: 0.14 },
    ];
    for (const s of specs) {
      const spec = new THREE.Mesh(
        new THREE.BoxGeometry(s.s, s.s, s.s),
        new THREE.MeshLambertMaterial({ color: PLANT.leafLight }),
      );
      spec.position.set(s.x, s.y, s.z);
      cluster.add(spec);
    }
    // Bottom shade band · thin darker slab below the cluster bottom
    const shade = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, 0.06, 0.78),
      new THREE.MeshLambertMaterial({ color: PLANT.leafShade }),
    );
    shade.position.y = -0.02;
    cluster.add(shade);
    g.add(cluster);

    g.position.set(x, 0, z);
    return g;
  }

  function buildSnakePlant(x, z) {
    // Snake plant · pot + 3 tall thin leaves with light-green tiger-
    // stripe insets. Spears tilt slightly outward for organic feel.
    const g = new THREE.Group();
    g.add(buildPot());

    // 3 spear leaves · centred over the pot
    const spears = [
      { x: -0.18, h: 1.40, tilt: -0.18, w: 0.10, d: 0.18 },
      { x:  0.00, h: 1.70, tilt:  0.00, w: 0.12, d: 0.20 },
      { x: +0.18, h: 1.45, tilt: +0.16, w: 0.10, d: 0.18 },
    ];
    for (const s of spears) {
      const leaf = new THREE.Group();
      // Dark silhouette behind
      const back = new THREE.Mesh(
        new THREE.BoxGeometry(s.w, s.h, s.d),
        new THREE.MeshLambertMaterial({ color: PLANT.leafDeep }),
      );
      back.position.y = s.h / 2;
      leaf.add(back);
      // Mid green front face (slightly thinner + offset forward)
      const front = new THREE.Mesh(
        new THREE.BoxGeometry(s.w * 0.7, s.h * 0.92, 0.04),
        new THREE.MeshLambertMaterial({ color: PLANT.leafMid }),
      );
      front.position.set(0, s.h * 0.46, s.d / 2 + 0.02);
      leaf.add(front);
      // Light tiger stripe (one small box mid-leaf)
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(s.w * 0.5, s.h * 0.15, 0.05),
        new THREE.MeshLambertMaterial({ color: PLANT.leafLight }),
      );
      stripe.position.set(0, s.h * 0.55, s.d / 2 + 0.04);
      leaf.add(stripe);
      leaf.position.set(s.x, 0.78, 0); // sit on top of soil
      leaf.rotation.z = s.tilt;
      g.add(leaf);
    }

    g.position.set(x, 0, z);
    return g;
  }

  function buildDirectorFigure(member) {
    // 3D avatar · every seat (directors + chair) gets a rigged GLB
    // figure from the saved avatar3d config (or a deterministic
    // per-id default when un-customized). The chair was previously
    // excluded — moderator stayed a flat sprite — which left it
    // hovering on a different vertical axis than the voxel directors
    // sitting next to it. Including the chair makes every seat share
    // the same `AVATAR_SEAT_LIFT` so thigh-up clears the cushion
    // consistently. The user seat still falls back to a sprite when
    // they haven't customised one yet (no per-id default for the user).
    if (avatar3dReady && member && member.id) {
      const cfg = (member.avatar3d && typeof member.avatar3d === "object")
        ? member.avatar3d
        : (member.__isUser ? null : deriveDefaultAvatarConfig(member.id));
      if (cfg && isAvatar3DReady(cfg.model)) {
        try {
          const a = buildAvatar3D(member.id, {
            model: cfg.model, hairStyle: cfg.hairStyle, outfitStyle: cfg.outfitStyle,
            browStyle: cfg.browStyle, tieStyle: cfg.tieStyle, eyeStyle: cfg.eyeStyle,
            accessory: cfg.accessory, height: AVATAR_FIG_HEIGHT,
            skin: cfg.skin, hair: cfg.hair, brow: cfg.brow, outfit: cfg.outfit, tie: cfg.tie, eye: cfg.eye,
          });
          if (a) { a.userData.isAvatar3d = true; return a; }
        } catch (e) {
          console.warn("[voice-3d] avatar build failed; sprite fallback", e);
        }
      }
      // models not ready / build failed → fall through to the sprite
    }

    // Single sprite billboard · the existing 8-bit director SVG
    // (head + face features + body + accessories all baked in)
    // sits inside the 3D chair as a 2D plane that always faces
    // the camera. Reuses the per-director artwork shipped under
    // /avatars/*.svg so the cast reads identically to the 2D
    // round-table view — no second source of truth, no voxel
    // sculpting per director.
    const g = new THREE.Group();
    const avatarPath = resolveAvatarPath(member);
    if (avatarPath) {
      const tex = loadAvatarTexture(avatarPath);
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: 0xFFFFFF,
        transparent: true,
        depthWrite: false,
        depthTest: true,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(SPRITE_W, SPRITE_H, 1);
      sprite.position.y = SPRITE_CENTER_Y;
      g.add(sprite);
    } else {
      // Last-resort fallback · a neutral skin-tone voxel cube where
      // the head would be. Only kicks in when the member has neither
      // an `avatarPath` (custom / seeded director) nor an avatar
      // seed (user without a generated pixel-art portrait).
      const head = new THREE.Mesh(
        new THREE.BoxGeometry(0.50, 0.50, 0.50),
        new THREE.MeshLambertMaterial({ color: 0xD4A574 }),
      );
      head.position.y = 1.30;
      g.add(head);
    }
    return g;
  }

  /** Resolve a member to an avatar URL the sprite can texture.
   *  Returns whatever `member.avatarPath` carries (PNG portrait /
   *  data URL / SVG file under /avatars/) or `null` to let the
   *  caller fall back to the voxel-cube fallback. The legacy
   *  AvatarSkill on-the-fly 8-bit SVG generation was retired in
   *  favour of the 3D portrait pipeline (avatar-3d-snap.js); the
   *  user seat is expected to either be a captured PNG (stored in
   *  prefs.avatarUrl by the customizer) or have no avatarPath, in
   *  which case the cube fallback renders. */
  function resolveAvatarPath(member) {
    if (!member) return null;
    if (member.avatarPath) return member.avatarPath;
    return null;
  }

  function loadAvatarTexture(avatarPath) {
    if (!avatarPath) return null;
    if (texCache.has(avatarPath)) return texCache.get(avatarPath);
    // SVG → CanvasTexture pipeline. Going through TextureLoader
    // directly with an SVG URL is unreliable across browser/GPU
    // combos · the `<img>` loads fine (naturalWidth/Height non-zero,
    // complete=true) but the upload to GPU often samples as
    // all-transparent, leaving sprites invisible. Rasterising the
    // SVG to a fixed-size 2D canvas first, then wrapping that canvas
    // in a CanvasTexture, sidesteps the problem entirely.
    const canvasSize = 256;
    const canvas = document.createElement("canvas");
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    const tex = new THREE.CanvasTexture(canvas);
    // Pixel-art register · nearest-neighbour sampling keeps the
    // 8-bit edges sharp at every zoom.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    // Load the SVG into an `<img>`, draw it onto the canvas, and
    // mark the texture needsUpdate so the GPU re-uploads.
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        ctx.clearRect(0, 0, canvasSize, canvasSize);
        ctx.drawImage(img, 0, 0, canvasSize, canvasSize);
        tex.needsUpdate = true;
        if (renderer && scene && camera) renderer.render(scene, camera);
      } catch (e) {
        console.warn("[voice-3d] canvas-rasterize avatar failed:", avatarPath, e);
      }
    };
    img.onerror = (e) => {
      console.warn("[voice-3d] avatar SVG fetch failed:", avatarPath, e);
    };
    img.src = avatarPath;
    texCache.set(avatarPath, tex);
    return tex;
  }

  /** Cache of per-tone floor textures · the source-of-truth for the
   *  pixel-art tile patterns lives in the existing CSS
   *  (`.roundtable-stage[data-floor=...] { --floor-image: url(...) }`
   *  in index.html). We pluck the URL out at runtime via
   *  getComputedStyle so the 5 tones don't need to be duplicated
   *  in this file · whatever ships in CSS shows up here too. */
  const floorTexCache = new Map();

  function rebuildFloor(mode) {
    if (!scene) return;
    // Read both pieces of the floor spec from the stage's resolved
    // CSS · the stage's `data-floor` attribute (set by the caller
    // BEFORE invoking update / VS3D.mount) drives which CSS rule
    // wins, so `getComputedStyle` returns the right values for the
    // current tone with no string-matching here.
    const computed = stageEl ? getComputedStyle(stageEl) : null;
    let bgColorStr = computed ? computed.getPropertyValue("--floor-bg").trim() : "";
    if (!bgColorStr) bgColorStr = FLOOR_COLOR_BY_TONE[mode] || FLOOR_COLOR_BY_TONE.constructive;
    const bgColor = new THREE.Color(bgColorStr);
    const floorImageProp = computed ? computed.getPropertyValue("--floor-image").trim() : "";
    // Strip the `url(...)` wrapper. The inner URL is a data:image/svg+xml
    // string that contains SVG attribute quotes (' and ") · we MUST NOT
    // stop at those · only the outer ) ends the URL. Try double-quoted
    // first, then single-quoted, then bare.
    const floorUrl = (() => {
      let m = floorImageProp.match(/^url\(\s*"([\s\S]+?)"\s*\)$/);
      if (m) return m[1];
      m = floorImageProp.match(/^url\(\s*'([\s\S]+?)'\s*\)$/);
      if (m) return m[1];
      m = floorImageProp.match(/^url\(\s*([\s\S]+?)\s*\)$/);
      return m ? m[1] : null;
    })();

    if (!floorMesh) {
      const floorGeo = new THREE.PlaneGeometry(STAGE_HALF_X * 4, STAGE_HALF_Z * 4);
      floorGeo.rotateX(-Math.PI / 2);
      const floorMat = new THREE.MeshLambertMaterial({ color: bgColor });
      floorMesh = new THREE.Mesh(floorGeo, floorMat);
      floorMesh.position.y = 0;
      scene.add(floorMesh);
    }

    if (floorUrl) {
      let tex = floorTexCache.get(floorUrl);
      if (!tex) {
        tex = textureLoader.load(
          floorUrl,
          () => {
            // Force a render so the tile appears immediately on
            // load rather than on the next idle-bob frame.
            if (renderer && scene && camera) renderer.render(scene, camera);
          },
          undefined,
          (err) => {
            console.warn("[voice-3d] floor texture failed for tone", mode, "·", err);
          },
        );
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        // Pixel-art register · nearest-neighbour sampling keeps the
        // 8-bit edges sharp instead of bilinear-blurring them into
        // mush at oblique camera angles.
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        // Tile period · ~2 world units per tile so the floor reads
        // as patterned without becoming a moiré field.
        const periodWorld = 2.0;
        const tilesX = (STAGE_HALF_X * 4) / periodWorld;
        const tilesZ = (STAGE_HALF_Z * 4) / periodWorld;
        tex.repeat.set(tilesX, tilesZ);
        floorTexCache.set(floorUrl, tex);
      }
      floorMesh.material.map = tex;
      // When a texture is present we want it to drive the colour ·
      // multiplying by the bg colour would tint the tile palette.
      floorMesh.material.color.setHex(0xffffff);
      floorMesh.material.needsUpdate = true;
    } else {
      // Fallback · no texture URL extracted, use flat tone colour.
      // Surfaces as a warning so we notice if CSS parsing breaks.
      console.warn("[voice-3d] no --floor-image url extracted for tone", mode,
        "· raw value:", floorImageProp.slice(0, 80));
      floorMesh.material.map = null;
      floorMesh.material.color.copy(bgColor);
      floorMesh.material.needsUpdate = true;
    }
  }

  function rebuildSeats(positions, mode) {
    if (!chairGroup || !avatarGroup) return;
    // Clear + rebuild · in Phase 1 we don't diff. Seat count changes
    // are infrequent (member add / remove) and the per-frame cost
    // of building ~5 chairs is trivial.
    while (chairGroup.children.length) chairGroup.remove(chairGroup.children[0]);
    // Tear down old overlay DOM seats (nameplate + bubble + container).
    // The chair vote pop is preserved across rebuilds — we re-attach
    // it AFTER clearing the overlay so its DOM ref survives, but its
    // anchor world position is reset (set again when the chair seat
    // is encountered in the loop below).
    if (overlayEl) {
      while (overlayEl.firstChild) overlayEl.removeChild(overlayEl.firstChild);
      if (chairVotePopEl) overlayEl.appendChild(chairVotePopEl);
    }
    overlaySeats = [];
    chairAnchorWorld = null;
    while (avatarGroup.children.length) {
      const child = avatarGroup.children[0];
      avatarGroup.remove(child);
      // A 3D avatar figure (buildAvatar3D group) SHARES its geometry with
      // the cached model template — only its materials are per-instance
      // clones. Disposing that shared geometry would corrupt the template
      // and break every later build, so for avatar groups we dispose the
      // (cloned) materials only and leave geometry alone. Sprite / voxel
      // figures own their geometry outright and dispose it normally.
      const isAvatar3d = child.name === "avatar3d" || (child.userData && child.userData.isAvatar3d);
      child.traverse((node) => {
        if (node.material) {
          if (Array.isArray(node.material)) {
            for (const m of node.material) { try { m.dispose(); } catch (_) {} }
          } else {
            try { node.material.dispose(); } catch (_) {}
          }
        }
        // Skip shared template geometry under avatar3d groups, EXCEPT the
        // mouth overlay (its SphereGeometry is per-instance, not shared).
        if (node.geometry && (!isAvatar3d || (node.userData && node.userData.isMouthOverlay))) {
          try { node.geometry.dispose(); } catch (_) {}
        }
      });
    }
    for (const pos of positions) {
      const m = pos.member;
      if (!m) continue;
      // Map % coords (x:0..100, y:0..100) into the world XZ plane.
      // x → world x (left/right), y → world z (near/far).
      // Subtract 50 so the centre of the stage is the origin.
      const wx = ((pos.x - 50) / 50) * STAGE_HALF_X;
      const wz = ((pos.y - 50) / 50) * STAGE_HALF_Z;

      // Chair orientation · ALL seats face the camera (rotation.y = 0).
      // The chair model is built with its back at local -Z, and the
      // camera sits on the world +Z axis — so a zero rotation lands
      // the back away from the camera and the seat facing toward it
      // for every position. Side-row chairs (wx != 0) lose the
      // "tilted toward the table centre" cue this way, but the
      // tradeoff is worth it: every occupant is square-on to the
      // viewer, no awkward side-profile chibis, no asymmetric
      // hand-of-cards arrangement.
      const chair = buildChair(mode);
      chair.position.set(wx, 0, wz);
      chairGroup.add(chair);

      // Director figure · a sprite billboard inside the chair.
      // `THREE.Sprite` self-orients toward the camera every frame,
      // so no rotation needed regardless of chair / fig pose.
      const fig = buildDirectorFigure(m);
      // 3D avatars are standing chibis · with feet at the floor (y=0) the seat
      // cushion (top ~0.60) buries the lower body to mid-thigh. Lift them so
      // more of the body clears the cushion (feet stay hidden behind it). The
      // sprite billboards keep y=0 (they're already framed for the floor).
      const figBaseY = (fig.userData && fig.userData.isAvatar3d) ? AVATAR_SEAT_LIFT : 0;
      fig.position.set(wx, figBaseY, wz);
      avatarGroup.add(fig);

      // Talking-mouth overlay (3D avatars only) · the avatars have a baked
      // smile + fixed lips and no jaw bone, so the mouth can't actually open
      // (dropping the teeth just hides them behind the lower lip). Instead we
      // overlay a dark ellipsoid just IN FRONT of the lips and grow/shrink it
      // while the seat speaks — a clearly-visible open/close talking mouth.
      let mouthOverlay = null;
      if (fig.userData && fig.userData.isAvatar3d) {
        fig.updateMatrixWorld(true);
        const mb = new THREE.Box3();
        let found = false;
        fig.traverse((o) => {
          if (o.isMesh && o.userData && (o.userData.avatarRole === "mouth" || o.userData.avatarRole === "teeth")) {
            mb.expandByObject(o); found = true;
          }
        });
        if (found) {
          const mc = mb.getCenter(new THREE.Vector3());
          const msz = mb.getSize(new THREE.Vector3());
          const ov = new THREE.Mesh(
            new THREE.SphereGeometry(1, 18, 12),
            new THREE.MeshStandardMaterial({ color: 0x3a1418, roughness: 0.55, metalness: 0 }),
          );
          ov.userData.isMouthOverlay = true;
          // Local position within fig (no rotation, unit scale) + a small
          // forward nudge so it sits in front of the lips, not inside the head.
          const local = fig.worldToLocal(mc.clone());
          ov.position.set(local.x, local.y, local.z + msz.z * 0.5 + 0.03);
          ov.scale.set(msz.x * 0.34, 0.001, 0.05); // (width, closed-height, depth)
          ov.visible = false;
          fig.add(ov);
          mouthOverlay = ov;
        }
      }

      // ── Floor glow ring · sits flat just above the floor under
      // the chair. Hidden by default; refreshSpeakerOverlay flips
      // it on with a lime (speaking) / amber (thinking) tint when
      // this seat is the active speaker. Additive blending +
      // per-frame opacity pulse in the RAF tick gives it the
      // "breathing halo" read.
      const glowRing = buildFloorGlowRing();
      glowRing.position.set(wx, 0.015, wz);
      glowRing.visible = false;
      chairGroup.add(glowRing);

      // Chair seat · save its world anchor so the vote pop overlay
      // (mounted ONCE in mount(), persists across rebuilds) can
      // project to its head position each frame. Y = above the
      // chair-back top + small gap so the card floats clear.
      if (pos.kind === "chair") {
        chairAnchorWorld = new THREE.Vector3(wx, 2.8, wz);
      }

      // ── DOM overlay seat · nameplate + bubble. The nameplate
      // shows the member's display name above the head; the bubble
      // is hidden by default and only revealed when this member is
      // the active speaker. CSS classes are the legacy 2D rules
      // (`.rt-name`, `.rt-bubble`, `.rt-bubble-name`, `.rt-bubble-
      // status`, `.rt-bubble-dots`) so visual styling is shared with
      // the non-3D round-table — single source of truth.
      if (overlayEl) {
        const wrapper = document.createElement("div");
        wrapper.style.cssText = [
          "position: absolute",
          // The wrapper's transform is updated per-frame; translate
          // the element so its CENTRE lands on the projected screen
          // point above the head. Top/left start at 0 so transform
          // alone drives positioning · cheaper than re-flowing
          // `top/left` properties every tick.
          "top: 0",
          "left: 0",
          "transform: translate(-50%, -100%)",
          "pointer-events: none",
          "white-space: nowrap",
        ].join("; ");

        // Nameplate · the existing `.rt-name` CSS gives mono caps,
        // dark plate background, light text · works as-is for the
        // 3D overlay. text-align centre keeps multi-word names
        // visually centred over the head.
        const namePlate = document.createElement("div");
        // Mark director vs chair on the plate so the marketing
        // homepage (and any narrow viewport) can hide director name
        // plates without affecting the chair plate · director plates
        // overlap badly when the entire round table is squeezed into
        // a phone-width frame.
        namePlate.className = "rt-name " + (pos.kind === "chair"
          ? "rt-name-chair"
          : "rt-name-director");
        namePlate.style.cssText = [
          "position: static",   // override the .rt-name absolute
          "top: auto", "left: auto",
          "transform: none",    // we transform the wrapper
        ].join("; ");
        namePlate.textContent = m.name || "—";
        wrapper.appendChild(namePlate);

        // Bubble · hidden by default. refreshSpeakerOverlay() fills
        // it in when this member is the active speaker.
        const bubble = document.createElement("div");
        bubble.className = "rt-bubble";
        bubble.style.cssText = [
          "position: static",
          "top: auto", "left: auto",
          "transform: none",
          "margin-top: 4px",
          "display: none",
        ].join("; ");
        wrapper.appendChild(bubble);

        // Wait mark · only mounted for the user seat. Hidden until
        // `activeUserWait` flips true (user typed a message that's
        // parked behind the current speaker). Reuses the legacy
        // `.rt-seat-wait-mark` CSS so its pill shape + amber pulse
        // animation come for free.
        let waitMark = null;
        let userBubbleEl = null;
        if (m.__isUser) {
          waitMark = document.createElement("div");
          waitMark.className = "rt-seat-wait-mark";
          waitMark.style.cssText = [
            "position: static",
            "top: auto", "left: auto",
            "transform: none",
            "margin-top: 4px",
            "display: none",
          ].join("; ");
          waitMark.innerHTML = "⌛&nbsp;WAIT";
          wrapper.appendChild(waitMark);

          // User-spoke bubble · separate element from the speaker
          // bubble (which is keyed on _resolveStageSpeaker, which
          // never returns the user). Reuses the legacy
          // `data-rt-user-bubble` attribute so any conic-gradient
          // countdown CSS from the 2D path applies for free.
          userBubbleEl = document.createElement("div");
          userBubbleEl.className = "rt-bubble rt-bubble-user";
          userBubbleEl.setAttribute("data-rt-user-bubble", "");
          userBubbleEl.style.cssText = [
            "position: static",
            "top: auto", "left: auto",
            "transform: none",
            "margin-top: 4px",
            "display: none",
          ].join("; ");
          wrapper.appendChild(userBubbleEl);
        }

        overlayEl.appendChild(wrapper);

        // World position for projection · slightly above the head so
        // the overlay anchor sits at the seat's "top". Y = chair-back
        // top + small margin.
        const headTopY = 1.70;
        const worldPos = new THREE.Vector3(wx, headTopY, wz);

        overlaySeats.push({
          id: m.id,
          name: m.name || "—",
          isUser: !!m.__isUser,
          isChair: pos.kind === "chair",
          worldPos,
          wrapper,
          namePlate,
          bubble,
          waitMark,
          userBubbleEl,
          // 3D refs · the figure group (for idle-bob position
          // animation) + the floor glow ring (for speaker halo).
          fig,
          figBaseY,
          mouthOverlay,
          glowRing,
          // Stagger the idle-bob phase per seat so the cast looks
          // alive instead of metronome-synchronized. 0.7 rad apart
          // ≈ ~40° offset on the sin curve.
          bobPhase: overlaySeats.length * 0.7,
        });
      }
    }

    // Initial fill of speaker bubble state (after seats exist).
    refreshSpeakerOverlay();
    // Force a projection NOW so the wrappers land at their projected
    // positions before the first paint instead of flashing from the
    // default (-50%, -100%) origin. Without this, the nameplates /
    // bubbles were stuck off-screen until the user changed the tone
    // (which re-fired rebuildSeats + projection together).
    projectOverlay();
  }

  /** Floor glow ring · transparent disc that lights up under the
   *  active speaker. AdditiveBlending makes it read as a glow
   *  rather than a flat coloured plate. Default opacity is set
   *  here, but the RAF tick pulses it between 0.35 and 0.75 so
   *  the halo "breathes" while visible. */
  function buildFloorGlowRing() {
    const geo = new THREE.CircleGeometry(0.65, 32);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x6FB572,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return new THREE.Mesh(geo, mat);
  }

  /** Show / hide / re-fill the speaker bubble for whichever overlay
   *  seat matches `activeSpeakerId`. Called from update() when the
   *  caller passes new speaker info, AND from rebuildSeats() right
   *  after the seats are first created. */
  function refreshSpeakerOverlay() {
    if (!overlaySeats.length) return;
    const state = activeSpeakerState;
    const id = activeSpeakerId;
    const labelThinking = activeSpeakerLabels.thinking;
    const labelSpeaking = activeSpeakerLabels.speaking;
    for (const seat of overlaySeats) {
      const isSpeaking = id && seat.id === id;
      // Wait mark · only on the user seat. Visible when the user
      // queued a message that's still parked behind the current
      // speaker. Independent of the speaker bubble (they CAN co-
      // occur if the user happens to be speaking — but only one
      // wait-mark per user seat anyway).
      if (seat.waitMark) {
        seat.waitMark.style.display = (activeUserWait && seat.isUser) ? "" : "none";
      }
      // User-spoke bubble · only on the user seat. Shows the user's
      // most recent message text with a countdown progress var so
      // the existing 2D `.rt-bubble-user` CSS countdown ring (driven
      // by `--rt-bubble-user-progress`) animates for free. Hides the
      // user nameplate while visible so the head doesn't carry two
      // stacked elements.
      if (seat.isUser && seat.userBubbleEl) {
        if (activeUserBubble) {
          seat.userBubbleEl.style.display = "";
          seat.userBubbleEl.style.setProperty(
            "--rt-bubble-user-progress",
            activeUserBubble.progress.toFixed(3),
          );
          seat.userBubbleEl.innerHTML =
            `<span class="rt-bubble-name">YOU</span>` +
            `<span class="rt-bubble-status">${escapeHtml(activeUserBubble.text)}</span>`;
          if (seat.namePlate) seat.namePlate.style.display = "none";
        } else {
          seat.userBubbleEl.style.display = "none";
        }
      }
      // Floor glow ring · visible only for the active speaker; tint
      // tracks the state (lime / amber). Per-frame pulse handled
      // in the RAF tick — here we just toggle visibility + colour.
      if (seat.glowRing) {
        seat.glowRing.visible = !!isSpeaking;
        if (isSpeaking) {
          seat.glowRing.material.color.setHex(
            state === "thinking" ? 0xB59560 : 0x6FB572,
          );
        }
      }
      // Nameplate · always visible UNLESS this seat is the speaker
      // (then the bubble takes its place, same logic as the 2D
      // `.rt-seat-speaking .rt-name { display: none }` rule) OR the
      // user seat has an active user-spoke bubble (which takes the
      // nameplate's slot for its TTL window).
      const userBubbleActive = seat.isUser && !!activeUserBubble;
      seat.namePlate.style.display = (isSpeaking || userBubbleActive) ? "none" : "";
      if (!isSpeaking) {
        seat.bubble.style.display = "none";
        continue;
      }
      // Bubble visible · build the same inner structure the 2D
      // bubble uses (name + status + 3 animated dots). The CSS
      // class `.is-thinking` toggles thinking palette / slower
      // dot rhythm via existing rules in index.html.
      seat.bubble.classList.toggle("is-thinking", state === "thinking");
      const statusWord = state === "thinking" ? labelThinking : labelSpeaking;
      seat.bubble.innerHTML =
        `<span class="rt-bubble-name">${escapeHtml(seat.name)}</span>` +
        `<span class="rt-bubble-status">${escapeHtml(statusWord)}</span>` +
        `<span class="rt-bubble-dots"><i></i><i></i><i></i></span>`;
      seat.bubble.style.display = "";
    }
  }

  /** Entry-animation tick · runs from mount + for ENTRY_DURATION_MS.
   *   · Camera: pull-back start → resting position via ease-out.
   *   · Per chair: scale 0 → 1 with overshoot bounce, staggered by
   *     position index so the cast pops in left-to-right rather
   *     than all at once. Same stagger applied to figures so a
   *     chair and its occupant land in sync.
   *  Self-deactivates after the duration; subsequent ticks return
   *  fast and the scene is in its resting state. */
  /** Kick off the speaker-change pulse · resolves the new speaker's
   *  seat (if any), captures the dolly direction, and flips the
   *  active flag. No-op when the entry animation is still running
   *  (entry owns the camera) or when the new speaker is the user
   *  (no seat figure to focus on). */
  function maybeTriggerSpeakerCameraPulse(speakerId) {
    if (entryActive) {
      lastPulseSpeakerId = speakerId; // skip but record so we don't re-pulse later
      return;
    }
    if (!camera || !cameraRestPos) return;
    if (lastPulseSpeakerId === undefined) {
      // First recognised speaker after mount · let entry animation
      // be the cinematic arrival; record so the SECOND speaker is
      // the first pulse target.
      lastPulseSpeakerId = speakerId;
      return;
    }
    if (lastPulseSpeakerId === speakerId) return;
    const seat = (overlaySeats || []).find((s) => s.id === speakerId);
    if (!seat || seat.isUser || !seat.worldPos) {
      // User taking a turn / unknown seat · skip the pulse but
      // remember the id so we don't keep retrying on every frame.
      lastPulseSpeakerId = speakerId;
      return;
    }
    // Direction from rest position toward the speaker's seat on
    // the XZ plane (no vertical component · we add lift separately).
    const dx = seat.worldPos.x - cameraRestPos.x;
    const dz = seat.worldPos.z - cameraRestPos.z;
    const mag = Math.hypot(dx, dz);
    if (mag < 0.0001) {
      // Seat is directly under the rest camera point — vanishingly
      // rare, but bail to avoid NaN.
      lastPulseSpeakerId = speakerId;
      return;
    }
    cameraPulseDirX = dx / mag;
    cameraPulseDirZ = dz / mag;
    cameraPulseStart = (typeof performance !== "undefined" ? performance.now() : Date.now());
    cameraPulseActive = true;
    lastPulseSpeakerId = speakerId;
    // Hand camera off from OrbitControls for the pulse window so
    // the user's drag-orbit doesn't fight the lerp · restored in
    // tickSpeakerCameraPulse() when the pulse completes.
    if (controls) controls.enabled = false;
  }

  function tickSpeakerCameraPulse() {
    if (!cameraPulseActive || !camera || !cameraRestPos) return;
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const t = Math.max(0, Math.min(1, (now - cameraPulseStart) / CAMERA_PULSE_DURATION_MS));
    // Bell curve: 0 at t=0, peaks at t=0.5, back to 0 at t=1.
    // sin(πt) keeps the camera anchored at rest at both ends so
    // there's no discontinuity when the pulse begins or ends.
    const bell = Math.sin(Math.PI * t);
    camera.position.set(
      cameraRestPos.x + cameraPulseDirX * CAMERA_PULSE_FORWARD * bell,
      cameraRestPos.y + CAMERA_PULSE_LIFT * bell,
      cameraRestPos.z + cameraPulseDirZ * CAMERA_PULSE_FORWARD * bell,
    );
    camera.lookAt(0, _mountCamLookY, 0);
    if (t >= 1) {
      // Snap exactly back to rest and hand control back.
      camera.position.copy(cameraRestPos);
      camera.lookAt(0, _mountCamLookY, 0);
      cameraPulseActive = false;
      if (controls) {
        controls.enabled = true;
        // Re-anchor OrbitControls' internal target spherical so the
        // next user drag starts from the rest pose, not from the
        // mid-pulse pose we never let it observe.
        if (controls.target) controls.target.set(0, _mountCamLookY, 0);
        try { controls.update(); } catch (_) { /* */ }
      }
    }
  }

  function tickEntryAnimation() {
    if (!entryActive || !camera || !cameraRestPos) return;
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const dt = now - entryStartTime;
    // Camera dolly · ease out cubic from a position 1.6× further
    // back (along the rest direction from target) into resting.
    const tCam = Math.max(0, Math.min(1, dt / ENTRY_DURATION_MS));
    const easeCam = 1 - Math.pow(1 - tCam, 3);
    // Start = rest + (rest - target) * 0.6  (i.e. 60% further out)
    const tx = 0, ty = _mountCamLookY, tz = 0;
    const startX = cameraRestPos.x + (cameraRestPos.x - tx) * 0.6;
    const startY = cameraRestPos.y + (cameraRestPos.y - ty) * 0.6;
    const startZ = cameraRestPos.z + (cameraRestPos.z - tz) * 0.6;
    camera.position.set(
      startX + (cameraRestPos.x - startX) * easeCam,
      startY + (cameraRestPos.y - startY) * easeCam,
      startZ + (cameraRestPos.z - startZ) * easeCam,
    );
    camera.lookAt(tx, ty, tz);
    // Per-seat scale-in · each chair/figure starts at scale 0 and
    // grows to 1 with a tiny overshoot bounce, staggered by index.
    const chairKids = chairGroup ? chairGroup.children : [];
    const figKids = avatarGroup ? avatarGroup.children : [];
    const maxKids = Math.max(chairKids.length, figKids.length);
    for (let i = 0; i < maxKids; i++) {
      const seatStart = i * ENTRY_STAGGER_MS;
      const tSeat = Math.max(0, Math.min(1, (dt - seatStart) / 320));
      // Overshoot ease (back-out) · y(t) = 1 + c3*(t-1)^3 + c1*(t-1)^2
      const c1 = 1.70158;
      const c3 = c1 + 1;
      const t1 = tSeat - 1;
      const s = 1 + c3 * t1 * t1 * t1 + c1 * t1 * t1;
      // The glow ring lives in chairGroup too · we want the chair
      // to scale but NOT the glow ring (it has its own pulse). The
      // ring's `.visible = false` for non-speakers means it's a no-
      // op anyway, but if a speaker mounts mid-entry we still want
      // the ring to behave. Skip rings by checking material kind.
      const chair = chairKids[i];
      if (chair) {
        // Only voxel chair Groups have multiple children · the floor
        // ring is a flat Mesh with material.transparent. We
        // identify chairs as Groups (have .children with length>0)
        // and rings as Meshes (no children).
        if (chair.isGroup && chair.children && chair.children.length) {
          chair.scale.setScalar(s);
        }
      }
      const fig = figKids[i];
      if (fig) fig.scale.setScalar(s);
    }
    if (dt > ENTRY_DURATION_MS + ENTRY_STAGGER_MS * maxKids + 320) {
      // Done · snap final state + deactivate.
      camera.position.copy(cameraRestPos);
      camera.lookAt(tx, ty, tz);
      for (const c of chairKids) if (c.isGroup && c.children.length) c.scale.setScalar(1);
      for (const f of figKids) f.scale.setScalar(1);
      entryActive = false;
    }
  }

  /** Per-frame animation tick for seats:
   *   · Non-speaker figures · gentle y-bob to look alive.
   *   · Active speaker · figure pinned at base y (no bob), with an
   *     occasional quick scaleY squash that reads as a blink (the
   *     billboard's eyes are baked into the texture, so a vertical
   *     squash is the cheapest "alive while talking" cue); the floor
   *     glow ring's opacity pulses too so the eye gets drawn to the
   *     right seat.
   *  Cheap: one sin + a couple of property writes per seat. */
  // Squash-blink envelope · most of the period the figure is full
  // height; a short dip near the start of each period reads as a
  // blink. Per-seat phase offset (bobPhase) desyncs the cast so they
  // never blink in unison.
  const BLINK_PERIOD = 4.2; // seconds between blinks
  const BLINK_DUR    = 0.18; // seconds the close+open takes
  const BLINK_DEPTH  = 0.12; // peak scaleY reduction (1 → 0.88)
  function tickSeatAnimations() {
    if (!overlaySeats.length) return;
    const t = (typeof performance !== "undefined" ? performance.now() : Date.now()) * 0.001;
    const app = (typeof window !== "undefined") ? window.app : null;
    const canCheckAudio = !!(app && typeof app.isSpeakerAudible === "function");
    for (const seat of overlaySeats) {
      const isActive = activeSpeakerId && seat.id === activeSpeakerId;
      // The mouth only moves while actually SPEAKING — and synced to the real
      // TTS audio when we can read it (the "speaking" stage state can start
      // before the audio does, which made mouths move silently). Fall back to
      // the stage state when no audio probe is available (e.g. older app).
      const isTalking = isActive && (canCheckAudio
        ? app.isSpeakerAudible(seat.id)
        : activeSpeakerState === "speaking");
      const isSpeaking = isActive; // kept for the idle-bob suspension below
      // Idle bob · ±2.5 cm at ~0.4 Hz, suspended for the speaker. Relative to
      // the seat's base Y (3D avatars are lifted onto the cushion).
      if (seat.fig) {
        const baseY = seat.figBaseY || 0;
        seat.fig.position.y = baseY + (isSpeaking ? 0 : Math.sin(t * 2.6 + seat.bobPhase) * 0.025);

        const is3d = !!(seat.fig.userData && seat.fig.userData.isAvatar3d);
        if (is3d) {
          // 3D avatars · animate the REAL mouth (the overlay opening/closing)
          // while speaking, NOT a body squash. Keep the body scale at 1.
          if (seat.fig.scale.y !== 1) seat.fig.scale.y = 1;
          const ov = seat.mouthOverlay;
          if (ov) {
            if (isTalking && !prefersReducedMotion) {
              // Open/close at ~2.7 Hz with a mild wobble · reads as talking.
              const o = 0.5 + 0.5 * Math.sin(t * 17 + seat.bobPhase * 3);
              const wobble = 0.85 + 0.15 * Math.sin(t * 9.1 + seat.bobPhase);
              ov.scale.y = MOUTH_MIN + (MOUTH_OPEN - MOUTH_MIN) * o * wobble;
              ov.visible = true;
            } else {
              ov.visible = false; // thinking / silent · show the baked smile
            }
          }
        } else {
          // Sprite / voxel fallback · the legacy speaking squash-blink (no
          // mouth meshes to animate). Only while SPEAKING (not thinking);
          // non-speakers + reduced-motion hold at 1.
          let sy = 1;
          if (isTalking && !prefersReducedMotion) {
            const phase = (t + seat.bobPhase) % BLINK_PERIOD;
            if (phase < BLINK_DUR) {
              sy = 1 - BLINK_DEPTH * Math.sin((phase / BLINK_DUR) * Math.PI);
            }
          }
          if (seat.fig.scale.y !== sy) seat.fig.scale.y = sy;
        }
      }
      // Speaker halo pulse · 0.35 ↔ 0.75 at ~0.8 Hz (matches the
      // 2D `.rt-seat-speaking::before` glow rhythm).
      if (seat.glowRing && seat.glowRing.visible) {
        const pulse = 0.55 + 0.20 * Math.sin(t * 5.0);
        seat.glowRing.material.opacity = pulse;
      }
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /** Project each overlay seat's world position to screen coords and
   *  update its wrapper transform. Called once per RAF tick from the
   *  scene render loop. Cheap: one matrix-vec multiply + one CSS
   *  transform write per seat. */
  function projectOverlay() {
    if (!overlayEl || !camera || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    for (const seat of overlaySeats) {
      projVec.copy(seat.worldPos).project(camera);
      // NDC → pixel (relative to the overlay container which IS the
      // canvas's parent + same size). x∈[-1,1] → [0, width].
      const x = (projVec.x * 0.5 + 0.5) * rect.width;
      const y = (1 - (projVec.y * 0.5 + 0.5)) * rect.height;
      // Z behind camera (clip) · hide the wrapper.
      if (projVec.z > 1) {
        seat.wrapper.style.opacity = "0";
        continue;
      }
      seat.wrapper.style.opacity = "1";
      // Round to integer pixels so the DOM text doesn't sub-pixel
      // shimmer as the camera nudges.
      seat.wrapper.style.transform =
        `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
    }
    // Chair vote pop · same projection but anchored on a separate
    // worldPos (above the chair's head). Skipped entirely when the
    // pop is hidden so we don't waste a matrix multiply.
    if (chairVotePopEl && chairAnchorWorld && chairVotePopEl.style.display !== "none") {
      projVec.copy(chairAnchorWorld).project(camera);
      if (projVec.z > 1) {
        chairVotePopEl.style.opacity = "0";
      } else {
        chairVotePopEl.style.opacity = "1";
        const cx = (projVec.x * 0.5 + 0.5) * rect.width;
        const cy = (1 - (projVec.y * 0.5 + 0.5)) * rect.height;
        chairVotePopEl.style.transform =
          `translate(${Math.round(cx)}px, ${Math.round(cy)}px) translate(-50%, -100%)`;
      }
    }
  }

  function resizeRenderer() {
    if (!renderer || !canvasEl || !stageEl || !camera) return;
    const rect = stageEl.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Stage just changed size · re-project the overlay so name-
    // plates / bubbles land at the new pixel positions immediately
    // (without this, the wrappers stayed in their old transform
    // until the next RAF tick · visible as a flash when the stage
    // first becomes visible from a 0×0 hidden state).
    projectOverlay();
  }

  /** Trailing-debounce wrapper around `resizeRenderer` · ResizeObserver
   *  fires once per layout pass, but a window drag triggers ~60 of
   *  those a second. Each `renderer.setSize` re-allocates the
   *  drawingBuffer and the inter-allocation gap shows as a black
   *  frame · debouncing 100 ms lets the CSS-stretched canvas hold
   *  the last good frame during the drag and only commits one final
   *  resize when the user pauses. */
  let _resizeTimer = null;
  function scheduleResize() {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      _resizeTimer = null;
      resizeRenderer();
    }, 100);
  }

  function startRaf() {
    stopRaf();
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (!visible || !elementVisible || !renderer || !scene || !camera) return;
      // Animations BEFORE render so the frame shows the latest
      // positions / glow-ring opacity; projection AFTER render so
      // the overlay DOM transforms align with what was just drawn.
      tickEntryAnimation();
      // Speaker-change pulse runs AFTER entry but BEFORE seat /
      // controls update · entry owns the camera fully when active,
      // then the pulse lerps freely (controls.enabled=false during
      // the window), then controls take back over once the pulse
      // settles. Seat animations don't touch the camera so order
      // between them is interchangeable.
      tickSpeakerCameraPulse();
      tickSeatAnimations();
      if (controls) controls.update();
      renderer.render(scene, camera);
      projectOverlay();
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopRaf() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  // Pause the RAF loop when the page tab is hidden so we don't burn
  // CPU drawing a scene nobody can see.
  document.addEventListener("visibilitychange", () => {
    visible = !document.hidden;
  });

  /* ── Export ────────────────────────────────────────────────── */
  window.VoiceStage3D = {
    isSupported,
    mount,
    update,
    unmount,
  };
  // DIAGNOSTIC · expose internals so the user can inspect from
  // DevTools without having to instrument the source. Remove
  // before Phase-5 polish.
  window.__voice3d = {
    THREE,
    get scene() { return scene; },
    get camera() { return camera; },
    get chairGroup() { return chairGroup; },
    get avatarGroup() { return avatarGroup; },
    get overlaySeats() { return overlaySeats; },
    get renderer() { return renderer; },
  };
})();
