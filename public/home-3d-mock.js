/* ═══════════════════════════════════════════════════════════════════
   home-3d-mock.js · marketing-page driver for VoiceStage3D.

   The 3D voice room (`voice-3d.js`) was built for the app · it reads
   live state pumped from the orchestrator (member list, seat
   positions, current speaker, vote-pop, etc.) via `VS3D.update()`.
   For the public homepage we don't have orchestrator state · we
   fabricate it.

   This module:
   1. Provides a fixed cast that mirrors the homepage hero's 6 SVG
      portrait grid · same agents, same SVG assets, no Frankenstein.
   2. Re-implements `computeSeatPositions` as a pure function (the
      app's version lives on the global app object and depends on
      it). The math is copied directly from
      `public/app.js · computeSeatPositions` so the seat ring reads
      identically to the in-app 3D scene.
   3. Starts a tiny 4-second interval that rotates `speakerId`
      through the directors so visitors see the speaker pulse
      animation on the chairs and the "[ speaking ]" pill above
      heads · the scene visibly breathes instead of sitting still.
   4. Exports `startMockDriver(stageEl)` for the loader to call
      after `VoiceStage3D.mount()` succeeds. Returns a `stop()`
      handle so the loader can tear down cleanly if the page navs
      away mid-demo.

   No external deps · pure browser JS, deferred-load safe. */

/* The cast — chair + 6 directors. Matches the homepage hero's
   right-column SVG grid (socrates / first-principles /
   value-investor / user-empathy / long-horizon / phenomenologist)
   with the moderator chair as the bottom-row anchor. 7 seats total
   fills the ring without empty arcs. */
const CAST = [
  { id: "chair",           name: "Chair",          avatarPath: "/avatars/3d/chair.png",            roleKind: "chair" },
  { id: "socrates",        name: "Socrates",       avatarPath: "/avatars/3d/socrates.png",         roleKind: "director" },
  { id: "first-principles", name: "First Principles", avatarPath: "/avatars/3d/first-principles.png", roleKind: "director" },
  { id: "value-investor",  name: "Value Investor", avatarPath: "/avatars/3d/value-investor.png",   roleKind: "director" },
  { id: "user-empathy",    name: "User-Empathy",   avatarPath: "/avatars/3d/user-empathy.png",     roleKind: "director" },
  { id: "long-horizon",    name: "Long Horizon",   avatarPath: "/avatars/3d/long-horizon.png",     roleKind: "director" },
  { id: "phenomenologist", name: "Phenomenologist", avatarPath: "/avatars/3d/phenomenologist.png", roleKind: "director" },
];

/* Which of the five tone-keyed rooms (voice-3d.js) the homepage hero
   shows. This is the FINAL homepage scene · "brainstorm" — the cozy
   modern interior (daylight windows + framed art on cream walls, a real
   3D oak chest + sage sofa) on the warm-oak plank floor (set on
   `.hero-3d-stage` in home.html). All five rooms were redesigned +
   signed off; brainstorm is the one we showcase here. */
const DEFAULT_MODE = "brainstorm";

/* Director rotation cadence. Long enough for the eye to register
   the speaker pulse + name plate change without feeling busy;
   short enough that a hovering visitor sees at least 2-3 director
   turns before they move on. */
const SPEAKER_ROTATION_MS = 4000;

/** Pure seat-position calculator · matches
 *  `public/app.js:computeSeatPositions` exactly so the mock ring
 *  reads identical to the in-app scene. Input is the cast array
 *  (chair first, directors after, user optional · marketing has
 *  no user). Output is an array of `{ member, x, y, kind,
 *  thetaDeg, scaleHint }` records keyed in % of stage. */
function computeSeatPositions(members) {
  const n = members.length;
  if (n === 0) return [];
  const cx = 50, cy = 50;
  // Stage-relative ring radii · larger ellipse than the chair's row
  // so directors occupy the back / sides of the table and the
  // chair anchors the front-centre.
  const rx = 42, ry = 23;
  const chairRy = 15;
  const SEAT_SCALE = 1.10;
  const out = [];

  // members[0] is always the chair. Bottom-centre of the ellipse.
  const chairX = cx + rx * Math.cos(Math.PI / 2); // → 50 (centre)
  const chairY = cy + chairRy * Math.sin(Math.PI / 2);
  out.push({
    member: members[0],
    x: chairX,
    y: chairY,
    scaleHint: SEAT_SCALE,
    kind: "chair",
    thetaDeg: 90,
  });

  // Directors fan across the top arc of the ellipse (θ ∈ [180°, 360°])
  // so the side seats land beside the table edge, not in the corners.
  const directorCount = n - 1; // no user seat on marketing page
  if (directorCount > 0) {
    const arcDeg   = directorCount === 2 ? 60  : 180;
    const arcStart = directorCount === 2 ? 240 : 180;
    const stepDeg = directorCount === 1 ? 0 : arcDeg / directorCount;
    for (let i = 0; i < directorCount; i++) {
      const m = members[1 + i];
      const t = directorCount === 1
        ? 270
        : arcStart + (i + 0.5) * stepDeg;
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
  return out;
}

/** Start the demo driver. Calls `VS3D.update()` once immediately
 *  (so the scene paints with the cast and a starting speaker), then
 *  rotates the speaker every SPEAKER_ROTATION_MS. Returns a `stop()`
 *  function so the caller can clear the interval if needed.
 *
 *  Requires `window.VoiceStage3D` to be available (the loader
 *  imports `voice-3d.js` BEFORE calling startMockDriver). */
export function startMockDriver() {
  const VS3D = window.VoiceStage3D;
  if (!VS3D || typeof VS3D.update !== "function") return () => {};

  // Decorate CAST with the canonical avatar3d configs · without this
  // the chair + directors render as RNG-drawn random faces instead of
  // the seeded looks the user sees in the in-app voice room. Source:
  // window.PB_CORE_AVATARS (public/core-avatars.js, loaded by home.html
  // before this driver). Idempotent · re-walks on every driver start.
  if (window.PB_CORE_AVATARS) {
    for (const m of CAST) {
      const cfg = window.PB_CORE_AVATARS[m.id];
      if (cfg && !m.avatar3d) m.avatar3d = cfg;
    }
  }

  const positions = computeSeatPositions(CAST);
  // Director ids only · the chair never speaks in this rotation
  // (chairs in the real app intervene at round boundaries; the
  // marketing scene shows steady director conversation).
  const directorIds = CAST.filter((m) => m.roleKind === "director").map((m) => m.id);
  let cursor = 0;

  const paint = () => {
    VS3D.update({
      mode: DEFAULT_MODE,
      positions,
      speakerId: directorIds[cursor % directorIds.length],
      speakerState: "speaking",
      userWait: false,
      labels: { speaking: "speaking", thinking: "thinking" },
      votePop: "",
    });
  };
  paint();
  const timer = setInterval(() => {
    cursor = (cursor + 1) % directorIds.length;
    paint();
  }, SPEAKER_ROTATION_MS);

  return function stop() {
    clearInterval(timer);
  };
}
