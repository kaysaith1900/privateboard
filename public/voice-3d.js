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
   Gated by `localStorage["boardroom.stage3d"]` ("on" | "off",
   default "on"). When off the legacy 2D SVG renders instead · same
   code path that shipped before this module existed.

   Why a separate file
   ───────────────────
   three.js is 356 KB · we don't want to inflate the cold app.js boot.
   This module loads as a separate `<script type="module">` and only
   imports three when actually used. The 2D fallback path doesn't
   touch this file at all. */

import * as THREE from "/vendor/three.module.min.js";
import { OrbitControls } from "/vendor/OrbitControls.js";

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
  let visible = true;          // Pause RAF when stage is hidden.

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
  const CHAIR_BACK_H = 1.15;
  const CHAIR_BACK_T = 0.15;

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
    constructive: "#2A2C32",
    research:     "#C8B89A",
    debate:       "#3A2F26",
    critique:     "#5C3033",
  };

  /** Tone → wall palette · 5 boardroom styles paired to each floor.
   *  Goal is "complement, don't clash" — light floor gets darker
   *  panelled walls, dark floor gets warm contrast trim.
   *    · brainstorm   · sky-blue garden walls (open / outdoor)
   *    · constructive · graphite glass partitions (modern corporate)
   *    · research     · light-oak library walls
   *    · debate       · dark-oak wainscot (forum / chamber)
   *    · critique     · mahogany executive panel
   *  Each entry: { wall, trim (baseboard), rail (chair-rail accent) }. */
  const WALL_PALETTE_BY_TONE = {
    brainstorm:   { wall: 0xA3B8C4, trim: 0x5F7A8A, rail: 0x7B97A8 },
    constructive: { wall: 0x4D525C, trim: 0x2A2C32, rail: 0x3A3F47 },
    research:     { wall: 0xD9CBAD, trim: 0x8B7355, rail: 0xB29874 },
    debate:       { wall: 0x4E3A2A, trim: 0x231811, rail: 0x382821 },
    critique:     { wall: 0x6B3F2F, trim: 0x2A1612, rail: 0x4A2A20 },
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
   *  texture (brainstorm → 山水) where a horizontal trim band would
   *  slice the painting. */
  let wallTrimGroup = null;
  /** Lazy procedural CanvasTexture · pixel-art 山水 (Chinese
   *  landscape) painted into a 1024×512 canvas. Built on first use
   *  and re-used across mounts. */
  let brainstormWallTexture = null;

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

  /** (Removed) cylindrical billboard registry · with the head now a
   *  voxel sculpture (eyes/glasses/mustache as voxel features), the
   *  chair-aligned rotation already lands the head's front-face
   *  features toward the camera. Sprite-head era needed this so the
   *  texture stayed visible; voxel head doesn't. */

  /* ── Public API ─────────────────────────────────────────────── */
  function isSupported() {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch (_) {
      return false;
    }
  }

  function mount(host) {
    if (!host || !isSupported()) return false;
    if (stageEl === host && renderer) return true; // idempotent
    if (stageEl) unmount();
    stageEl = host;

    // Mark the stage so CSS can hide the legacy 2D children
    // (the `<svg.rt-table>`, the `[data-rt-seats]` grid, etc) without
    // removing them from the DOM — keeping them around means the
    // 2D fallback path can take over instantly if we ever unmount.
    stageEl.classList.add("is-3d");

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
      antialias: false,    // pixel-art register · sharper without AA
      alpha: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);

    scene = new THREE.Scene();

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
    const camR = 18;
    const camTheta = Math.PI / 2;             // 90° → camera on +Z axis (frontal)
    const camPhi = (90 - 30) * Math.PI / 180; // 30° above horizon
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
    camera.lookAt(0, 0.5, 0);
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
    controls.target.set(0, 0.5, 0);
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
    const key = new THREE.DirectionalLight(0xffe9c8, 0.85);
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

    // Resize handling · the stage is inside a flex chat-col, so its
    // pixel dimensions change as the user resizes the window or
    // collapses/expands the sidebar. ResizeObserver fires whenever
    // the stage box's size changes and we re-snap the renderer +
    // camera aspect.
    resizeRenderer();
    resizeObserver = new ResizeObserver(() => resizeRenderer());
    resizeObserver.observe(stageEl);

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

    // RAF loop · animations + render each frame.
    startRaf();

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
    stopRaf();
    if (resizeObserver) {
      try { resizeObserver.disconnect(); } catch (_) {}
      resizeObserver = null;
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
    floorMesh = null;
    tableGroup = null;
    // Wall materials are shared across all wall / trim / rail
    // meshes (created lazily in buildBoardroomWalls) · the meshes
    // themselves get cleaned up as scene children are GC'd, but
    // the shared materials need explicit disposal + null-out so
    // the next mount allocates fresh ones.
    if (wallMat) { try { wallMat.dispose(); } catch (_) {} wallMat = null; }
    if (trimMat) { try { trimMat.dispose(); } catch (_) {} trimMat = null; }
    if (railMat) { try { railMat.dispose(); } catch (_) {} railMat = null; }
    wallTrimGroup = null;
    if (brainstormWallTexture) {
      try { brainstormWallTexture.dispose(); } catch (_) {}
      brainstormWallTexture = null;
    }
    if (stageEl) {
      stageEl.classList.remove("is-3d");
      stageEl = null;
    }
    // Drop the texture cache so a future mount doesn't hold stale
    // GPU-side textures (members may have changed their avatars).
    for (const tex of texCache.values()) {
      try { tex.dispose(); } catch (_) {}
    }
    texCache.clear();
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
    const mode = (state && state.mode) || "constructive";
    rebuildFloor(mode);
    refreshWallColors(mode);
    rebuildSeats(state && state.positions ? state.positions : []);
    activeSpeakerId = (state && state.speakerId) || null;
    activeSpeakerState = (state && state.speakerState) || null;
    activeUserWait = !!(state && state.userWait);
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

    if (mode === "brainstorm") {
      if (!brainstormWallTexture) brainstormWallTexture = buildBrainstormWallTexture();
      if (wallMat.map !== brainstormWallTexture) {
        wallMat.map = brainstormWallTexture;
        wallMat.needsUpdate = true;
      }
      // White color so the texture renders un-tinted under Lambert
      // shading. Lambert multiplies color × map per pixel.
      wallMat.color.setHex(0xFFFFFF);
      if (wallTrimGroup) wallTrimGroup.visible = false;
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
  }

  /** Procedural pixel-art brick wall painted into a canvas, returned
   *  as a NearestFilter CanvasTexture so the chunky aesthetic of the
   *  rest of the scene carries through. Matches `public/icons/wall.png`
   *  — running-bond red bricks with deep mortar lines, irregular
   *  grey stone bands top + bottom, and green moss clusters scattered
   *  along the mortar / stone seams. */
  function buildBrainstormWallTexture() {
    const W = 1024, H = 512;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    // Mortar base · dark warm grey fills the whole canvas so any
    // gaps between bricks / stones read as mortar lines instead of
    // background bleed-through.
    ctx.fillStyle = "#3A302B";
    ctx.fillRect(0, 0, W, H);

    // Stone bands · irregular grey block strips along the top and
    // bottom edges, mirroring the reference's framing detail.
    const stoneBandH = 38;
    drawStoneBand(ctx, W, 0, stoneBandH, mulberry32(101));
    drawStoneBand(ctx, W, H - stoneBandH, stoneBandH, mulberry32(211));

    // Brick courses · running-bond pattern between the two stone
    // bands. Each brick gets a slight per-block colour wobble + a
    // top-edge highlight + bottom-edge shadow to suggest stacked
    // clay courses.
    const brickW = 46;
    const brickH = 16;
    const mortar = 3;
    const brickPalette = [
      "#A03A2A", "#B24535", "#92322A", "#BC5040",
      "#8B3025", "#A8413A", "#9F3B2E", "#B54838",
    ];
    const brickHighlight = "#D26E5C";
    const brickShadow = "#5E2017";
    const rand = mulberry32(7);

    const courseTop = stoneBandH;
    const courseBottom = H - stoneBandH;
    let row = 0;
    for (let y = courseTop; y < courseBottom; y += brickH) {
      const stagger = (row % 2 === 0) ? 0 : -Math.floor(brickW / 2);
      for (let i = -1; i < Math.ceil(W / brickW) + 2; i++) {
        const bx = i * brickW + stagger;
        const color = brickPalette[Math.floor(rand() * brickPalette.length)];
        const x0 = bx + Math.floor(mortar / 2);
        const y0 = y + Math.floor(mortar / 2);
        const w = brickW - mortar;
        const h = brickH - mortar;
        ctx.fillStyle = color;
        ctx.fillRect(x0, y0, w, h);
        ctx.fillStyle = brickHighlight;
        ctx.fillRect(x0, y0, w, 1);
        ctx.fillStyle = brickShadow;
        ctx.fillRect(x0, y0 + h - 1, w, 1);
      }
      row += 1;
    }

    // Moss patches · scatter green clusters along brick seams + at
    // the stone-band boundaries. Drawn after bricks so they overlap
    // and read as growth on the wall, not under it.
    const mossPalette = ["#5E7A3A", "#6E8E48", "#82A656", "#476830"];
    const mossRand = mulberry32(53);
    for (let n = 0; n < 56; n++) {
      const mx = Math.floor(mossRand() * W);
      // Bias moss toward the stone-band edges + scattered through
      // the brick field. ~1/3 hugging the top band, ~1/6 hugging
      // the bottom, the rest spread through the brick field.
      const zone = mossRand();
      let my;
      if (zone < 0.33) {
        my = stoneBandH - 6 + Math.floor(mossRand() * 18);
      } else if (zone < 0.50) {
        my = H - stoneBandH - 8 + Math.floor(mossRand() * 14);
      } else {
        my = stoneBandH + Math.floor(mossRand() * (H - stoneBandH * 2));
      }
      drawMossBlob(ctx, mx, my, mossPalette, mossRand);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Irregular grey stone band · packs variable-width stone blocks
   *  along a horizontal strip with thin mortar gaps. Each stone
   *  picks a grey tone + gets a 1px top highlight / bottom shadow
   *  so the band reads as cobbled masonry instead of one flat slab. */
  function drawStoneBand(ctx, W, yStart, height, rand) {
    const palette = ["#5C5650", "#6E6862", "#4A4540", "#7A746E", "#635B54"];
    const highlight = "#8A847C";
    const shadow = "#2E2823";
    let x = 0;
    while (x < W) {
      const w = 18 + Math.floor(rand() * 42);
      const color = palette[Math.floor(rand() * palette.length)];
      ctx.fillStyle = color;
      ctx.fillRect(x, yStart + 1, w, height - 2);
      ctx.fillStyle = highlight;
      ctx.fillRect(x, yStart + 1, w, 1);
      ctx.fillStyle = shadow;
      ctx.fillRect(x, yStart + height - 2, w, 1);
      x += w + 2; // 2px mortar gap between stones
    }
  }

  /** Moss blob · small irregular cluster of green pixels, roughly
   *  diamond-shaped so it reads as a growth patch instead of a
   *  rectangle. Picks a tone per blob from the supplied palette. */
  function drawMossBlob(ctx, cx, cy, palette, rand) {
    const color = palette[Math.floor(rand() * palette.length)];
    const w = 10 + Math.floor(rand() * 18);
    const h = 5 + Math.floor(rand() * 7);
    ctx.fillStyle = color;
    for (let py = 0; py < h; py++) {
      const taper = Math.floor(Math.abs(py - h / 2) * 1.6);
      const rowW = Math.max(2, w - taper);
      const offset = Math.floor((w - rowW) / 2);
      ctx.fillRect(cx + offset, cy + py, rowW, 1);
    }
    const hi = palette[Math.min(palette.length - 1, Math.floor(rand() * palette.length))];
    ctx.fillStyle = hi;
    ctx.fillRect(cx + Math.floor(w * 0.3), cy, 2, 1);
    ctx.fillRect(cx + Math.floor(w * 0.6), cy + 1, 2, 1);
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

    return g;
  }

  /** Voxel props that sit on the table top · books, coffee cup, two
   *  microphones. Mirrors the 2D SVG `.rt-prop-*` set under the
   *  table SVG: same composition, same colour family, voxel-ised
   *  for 3D consistency. Positioned in TABLE-LOCAL coords (x and
   *  z are table-relative; y is on top of the table top slab). */
  function buildTableProps() {
    const g = new THREE.Group();
    // Table top slab top y · matches the buildTable() math:
    // bodyH (0.9) + topH (0.35) = 1.25
    const TOP_Y = 1.25;

    // Stack of two books · left third of the table.
    // Bottom book · red spine
    const bookBot = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.08, 0.20),
      new THREE.MeshLambertMaterial({ color: 0x9E4A3A }),
    );
    bookBot.position.set(-2.0, TOP_Y + 0.04, 0);
    g.add(bookBot);
    // Bottom book highlight band along the long edge
    const bookBotHi = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.015, 0.04),
      new THREE.MeshLambertMaterial({ color: 0xBF6B5C }),
    );
    bookBotHi.position.set(-2.0, TOP_Y + 0.08, 0.085);
    g.add(bookBotHi);
    // Top book · navy spine, offset right & up
    const bookTop = new THREE.Mesh(
      new THREE.BoxGeometry(0.48, 0.07, 0.18),
      new THREE.MeshLambertMaterial({ color: 0x2A3E5C }),
    );
    bookTop.position.set(-1.9, TOP_Y + 0.115, -0.02);
    g.add(bookTop);
    const bookTopHi = new THREE.Mesh(
      new THREE.BoxGeometry(0.48, 0.012, 0.04),
      new THREE.MeshLambertMaterial({ color: 0x4A6390 }),
    );
    bookTopHi.position.set(-1.9, TOP_Y + 0.148, 0.06);
    g.add(bookTopHi);

    // Coffee cup · short white cylinder with a handle, sits to the
    // right of the books.
    const cupBody = new THREE.Mesh(
      new THREE.CylinderGeometry(0.10, 0.08, 0.18, 16),
      new THREE.MeshLambertMaterial({ color: 0xF0EDE6 }),
    );
    cupBody.position.set(-1.10, TOP_Y + 0.09, 0);
    g.add(cupBody);
    const cupRim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.10, 0.10, 0.015, 16),
      new THREE.MeshLambertMaterial({ color: 0xC9C5BE }),
    );
    cupRim.position.set(-1.10, TOP_Y + 0.182, 0);
    g.add(cupRim);
    // Cup handle · small torus on the side
    const cupHandle = new THREE.Mesh(
      new THREE.TorusGeometry(0.05, 0.012, 6, 16),
      new THREE.MeshLambertMaterial({ color: 0xF0EDE6 }),
    );
    cupHandle.position.set(-1.00, TOP_Y + 0.09, 0);
    cupHandle.rotation.y = Math.PI / 2;
    g.add(cupHandle);
    // Saucer under the cup
    const saucer = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 0.015, 20),
      new THREE.MeshLambertMaterial({ color: 0xDED9D0 }),
    );
    saucer.position.set(-1.10, TOP_Y + 0.0075, 0);
    g.add(saucer);

    // Two microphones · front-facing (toward chair) and back-facing
    // (toward top-row directors). Each = base disc + thin stand +
    // mic head capsule.
    const buildMic = (x, z, faceForward) => {
      const mg = new THREE.Group();
      // Base
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.10, 0.10, 0.025, 16),
        new THREE.MeshLambertMaterial({ color: 0x2A2A2A }),
      );
      base.position.set(0, TOP_Y + 0.012, 0);
      mg.add(base);
      // Stand
      const stand = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, 0.38, 8),
        new THREE.MeshLambertMaterial({ color: 0x3A3A3A }),
      );
      stand.position.set(0, TOP_Y + 0.215, 0);
      mg.add(stand);
      // Head · tilted slightly toward the speaker the mic faces
      const head = new THREE.Mesh(
        new THREE.BoxGeometry(0.13, 0.16, 0.10),
        new THREE.MeshLambertMaterial({ color: 0x1A1A1A }),
      );
      head.position.set(0, TOP_Y + 0.45, faceForward ? 0.03 : -0.03);
      head.rotation.x = faceForward ? -0.20 : 0.20;
      mg.add(head);
      // Grille highlight strip
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
    g.add(buildMic(0.4, 0.4, true));     // facing the chair (front row)
    g.add(buildMic(0.4, -0.4, false));    // facing the back-row directors

    return g;
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

    // Body (mid wood) · sits with its top at y=topH baseline so chairs
    // can tuck under naturally.
    const bodyGeo = new THREE.BoxGeometry(tableW, bodyH, tableD);
    const bodyMat = new THREE.MeshLambertMaterial({ color: WOOD.mid });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = bodyH / 2;
    g.add(body);

    // Top slab (rim wood, slightly lighter) · sits flush above body
    // for the chunky "two-layer" pixel-art read.
    const topGeo = new THREE.BoxGeometry(tableW + 0.1, topH, tableD + 0.1);
    const topMat = new THREE.MeshLambertMaterial({ color: WOOD.hi });
    const top = new THREE.Mesh(topGeo, topMat);
    top.position.y = bodyH + topH / 2;
    g.add(top);

    // Bottom shadow slab (dark wood) · a thin dark strip under the body
    // grounds the table to the floor like the SVG's `.rt-table-floor`
    // ellipse does in 2D.
    const shadeGeo = new THREE.BoxGeometry(tableW + 0.05, 0.08, tableD + 0.05);
    const shadeMat = new THREE.MeshLambertMaterial({ color: WOOD.shade });
    const shade = new THREE.Mesh(shadeGeo, shadeMat);
    shade.position.y = 0.04;
    g.add(shade);

    return g;
  }

  function buildChair() {
    // Voxel chair · mirrors the existing 2D chair sprite anatomy
    // (4 legs + seat slab + back rail + 2 finials at the top
    // corners of the back).
    const g = new THREE.Group();

    // 4 legs · thin voxel posts at the seat's four corners.
    // Heights up to the seat's underside (CHAIR_SEAT_H - seat-slab-half).
    const legH = CHAIR_SEAT_H - 0.06; // seat slab is 0.12 tall, half = 0.06
    const legGeo = new THREE.BoxGeometry(0.12, legH, 0.12);
    const legMat = new THREE.MeshLambertMaterial({ color: 0x5A3A22 });
    const legOffsetX = CHAIR_WIDTH / 2 - 0.08;
    const legOffsetZ = CHAIR_DEPTH / 2 - 0.08;
    for (const [sx, sz] of [[-1, -1], [+1, -1], [-1, +1], [+1, +1]]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(sx * legOffsetX, legH / 2, sz * legOffsetZ);
      g.add(leg);
    }

    // Seat slab
    const seatGeo = new THREE.BoxGeometry(CHAIR_WIDTH, 0.12, CHAIR_DEPTH);
    const seatMat = new THREE.MeshLambertMaterial({ color: 0x8B5E3B }); // chair-seat
    const seat = new THREE.Mesh(seatGeo, seatMat);
    seat.position.y = CHAIR_SEAT_H;
    g.add(seat);

    // Back rail (the upright part)
    const backGeo = new THREE.BoxGeometry(CHAIR_WIDTH, CHAIR_BACK_H, CHAIR_BACK_T);
    const backMat = new THREE.MeshLambertMaterial({ color: 0xC8A877 }); // chair-back
    const back = new THREE.Mesh(backGeo, backMat);
    back.position.set(0, CHAIR_SEAT_H + CHAIR_BACK_H / 2, -CHAIR_DEPTH / 2 + CHAIR_BACK_T / 2);
    g.add(back);

    // Back shaded inner panel
    const backShadeGeo = new THREE.BoxGeometry(CHAIR_WIDTH * 0.82, CHAIR_BACK_H * 0.78, 0.02);
    const backShadeMat = new THREE.MeshLambertMaterial({ color: 0xA0814F }); // chair-back-shade
    const backShade = new THREE.Mesh(backShadeGeo, backShadeMat);
    backShade.position.set(0, CHAIR_SEAT_H + CHAIR_BACK_H / 2, -CHAIR_DEPTH / 2 + CHAIR_BACK_T + 0.01);
    g.add(backShade);

    // Finials · two small cubes capping the top corners of the back.
    const finialGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
    const finialMat = new THREE.MeshLambertMaterial({ color: 0x5A3A22 });
    const finialL = new THREE.Mesh(finialGeo, finialMat);
    finialL.position.set(-CHAIR_WIDTH / 2 + 0.07, CHAIR_SEAT_H + CHAIR_BACK_H + 0.05, -CHAIR_DEPTH / 2 + CHAIR_BACK_T / 2);
    g.add(finialL);
    const finialR = new THREE.Mesh(finialGeo, finialMat);
    finialR.position.set(CHAIR_WIDTH / 2 - 0.07, CHAIR_SEAT_H + CHAIR_BACK_H + 0.05, -CHAIR_DEPTH / 2 + CHAIR_BACK_T / 2);
    g.add(finialR);

    return g;
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

  /** Resolve a member to an avatar URL the sprite can texture:
   *   · directors / chair · `member.avatarPath` (SVG under /avatars/
   *     or a custom data: URL on the live record).
   *   · user seat · synthesised on demand from `member.__seed` via
   *     `AvatarSkill.generateDataUrl` so the user's pixel-art
   *     portrait (same one shown in chat + sidebar) appears in the
   *     3D scene too.
   *  Returns `null` when neither path resolves · caller renders
   *  the voxel-cube fallback. */
  function resolveAvatarPath(member) {
    if (!member) return null;
    if (member.avatarPath) return member.avatarPath;
    if (member.__isUser && member.__seed
        && window.AvatarSkill
        && typeof window.AvatarSkill.generateDataUrl === "function") {
      try {
        return window.AvatarSkill.generateDataUrl(member.__seed);
      } catch (_) {
        return null;
      }
    }
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

  function rebuildSeats(positions) {
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
      // Each child is now a `THREE.Group` (body + arms + tie + head).
      // Walk its descendants and dispose materials + geometries. Heads
      // use a per-face material ARRAY (one per BoxGeometry face) so
      // unwrap the array before calling dispose on each.
      child.traverse((node) => {
        if (node.material) {
          if (Array.isArray(node.material)) {
            for (const m of node.material) { try { m.dispose(); } catch (_) {} }
          } else {
            try { node.material.dispose(); } catch (_) {}
          }
        }
        if (node.geometry) {
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
      const chair = buildChair();
      chair.position.set(wx, 0, wz);
      chairGroup.add(chair);

      // Director figure · a sprite billboard inside the chair.
      // `THREE.Sprite` self-orients toward the camera every frame,
      // so no rotation needed regardless of chair / fig pose.
      const fig = buildDirectorFigure(m);
      fig.position.set(wx, 0, wz);
      avatarGroup.add(fig);

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
        namePlate.className = "rt-name";
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
          // 3D refs · the figure group (for idle-bob position
          // animation) + the floor glow ring (for speaker halo).
          fig,
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
      // `.rt-seat-speaking .rt-name { display: none }` rule).
      seat.namePlate.style.display = isSpeaking ? "none" : "";
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
  function tickEntryAnimation() {
    if (!entryActive || !camera || !cameraRestPos) return;
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const dt = now - entryStartTime;
    // Camera dolly · ease out cubic from a position 1.6× further
    // back (along the rest direction from target) into resting.
    const tCam = Math.max(0, Math.min(1, dt / ENTRY_DURATION_MS));
    const easeCam = 1 - Math.pow(1 - tCam, 3);
    // Start = rest + (rest - target) * 0.6  (i.e. 60% further out)
    const tx = 0, ty = 0.5, tz = 0;
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
   *   · Active speaker · figure pinned at base y (no bob); the floor
   *     glow ring's opacity pulses instead, so the user's eye gets
   *     drawn to the right seat.
   *  Cheap: one sin + a couple of property writes per seat. */
  function tickSeatAnimations() {
    if (!overlaySeats.length) return;
    const t = (typeof performance !== "undefined" ? performance.now() : Date.now()) * 0.001;
    for (const seat of overlaySeats) {
      const isSpeaking = activeSpeakerId && seat.id === activeSpeakerId;
      // Idle bob · ±2.5 cm at ~0.4 Hz, suspended for the speaker.
      if (seat.fig) {
        seat.fig.position.y = isSpeaking
          ? 0
          : Math.sin(t * 2.6 + seat.bobPhase) * 0.025;
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

  function startRaf() {
    stopRaf();
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (!visible || !renderer || !scene || !camera) return;
      // Animations BEFORE render so the frame shows the latest
      // positions / glow-ring opacity; projection AFTER render so
      // the overlay DOM transforms align with what was just drawn.
      tickEntryAnimation();
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
