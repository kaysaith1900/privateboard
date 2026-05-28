/* ═══════════════════════════════════════════════════════════════════
   voice-3d-banner.js · helper that mounts the live Three.js round-
   table scene into any DOM container.

   Used by two in-app surfaces:
     1. `onboarding.js` step 3 — "Want them to speak aloud?"
        banner shows the actual 3D room so the user knows what
        they're about to configure a voice key for.
     2. `voice-onboarding.js` — the popup that fires when the user
        clicks the voice toggle in a new room without having a TTS
        key configured. Same banner concept, same scene.

   Both used to clone a static SVG preview from `<template id="vonb-
   themes">`. Replacing that with a real 3D mount keeps the visual
   consistent with the marketing homepage and gives the surface the
   same "convene around the table" weight as the actual voice room.

   `voice-3d.js` is already loaded by index.html as an ES module
   (line ~16100) so `window.VoiceStage3D` is available by the time
   onboarding renders.

   The full cast + seat math is INLINED below (copied from
   `home-3d-mock.js`) so the banner paints a complete, populated
   scene SYNCHRONOUSLY after `VS3D.mount` returns. Earlier versions
   deferred this to a dynamic `import("/home-3d-mock.js")` and the
   ~100-500 ms network/resolution gap on first visit made the canvas
   read as empty / black until the mock driver landed. Inlining the
   data removes the gap entirely — first visit is identical to
   second visit. The marketing homepage keeps using
   `home-3d-mock.js` independently (it's still that page's driver).

   Public surface:
     `window.mountVoice3dBanner(host)` → `() => void` | `null`
     Mounts the brainstorm-tone scene with the marketing camera
     overrides. Returns a stop fn the caller calls on unmount /
     step change. Returns `null` if WebGL isn't supported or the
     mount fails (caller falls back to a static poster img). */

(function () {
  /* Brainstorm-tone floor · MUST stay in sync with
     `index.html:.roundtable-stage[data-floor="brainstorm"]` (warm-
     oak plank, ~line 8367). Inlined here so the host DOM doesn't
     need any data attribute or app CSS · we just write the CSS vars
     directly onto the mount element and `voice-3d.js:rebuildFloor`
     reads them via `getComputedStyle(host)`. The earlier soil +
     grass + flower tile was stale (brainstorm was redesigned to a
     cozy warm-oak interior); the banner was still showing the old
     ground while the actual room had switched. */
  const BRAINSTORM_FLOOR_BG = "#B0976E";
  const BRAINSTORM_FLOOR_IMAGE = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='128' height='64' shape-rendering='crispEdges'><rect width='128' height='64' fill='%23B0976E'/><rect y='16' width='128' height='16' fill='%23A68C62'/><rect y='48' width='128' height='16' fill='%23A68C62'/><rect y='0' width='128' height='1' fill='%23C2A87E'/><rect y='16' width='128' height='1' fill='%23C2A87E'/><rect y='32' width='128' height='1' fill='%23C2A87E'/><rect y='48' width='128' height='1' fill='%23C2A87E'/><rect y='15' width='128' height='1' fill='%23877045'/><rect y='31' width='128' height='1' fill='%23877045'/><rect y='47' width='128' height='1' fill='%23877045'/><rect y='63' width='128' height='1' fill='%23877045'/><rect x='40' y='0' width='1' height='16' fill='%23877045'/><rect x='96' y='16' width='1' height='16' fill='%23877045'/><rect x='20' y='32' width='1' height='16' fill='%23877045'/><rect x='72' y='48' width='1' height='16' fill='%23877045'/><rect x='10' y='6' width='14' height='1' fill='%23A38755'/><rect x='60' y='22' width='18' height='1' fill='%23A38755'/><rect x='100' y='40' width='14' height='1' fill='%23A38755'/><rect x='30' y='56' width='16' height='1' fill='%23A38755'/></svg>\")";

  /* Marketing camera framing · matches `home-3d-loader.js` so the
     in-app banner reads as the same scene the homepage shows.
     Closer pull + softer top-down lean than the app's voice-room
     view (which uses defaults 18-unit / 30°). */
  const CAMERA_OPTS = {
    distance: 13,
    elevationDeg: 24,
    lookAtY: 0.75,
  };

  /* Cast · chair + 6 directors. Mirrors `home-3d-mock.js`'s CAST
     array exactly so the banner's roster matches the marketing
     homepage. Inlined (vs dynamic-imported) so the first paint
     after mount is fully populated · the prior version waited for
     /home-3d-mock.js to resolve, leaving the scene visibly empty
     for ~100-500 ms on first visit. */
  const CAST = [
    { id: "chair",            name: "Chair",            avatarPath: "/avatars/3d/chair.png",             roleKind: "chair" },
    { id: "socrates",         name: "Socrates",         avatarPath: "/avatars/3d/socrates.png",          roleKind: "director" },
    { id: "first-principles", name: "First Principles", avatarPath: "/avatars/3d/first-principles.png",  roleKind: "director" },
    { id: "value-investor",   name: "Value Investor",   avatarPath: "/avatars/3d/value-investor.png",    roleKind: "director" },
    { id: "user-empathy",     name: "User-Empathy",     avatarPath: "/avatars/3d/user-empathy.png",      roleKind: "director" },
    { id: "long-horizon",     name: "Long Horizon",     avatarPath: "/avatars/3d/long-horizon.png",      roleKind: "director" },
    { id: "phenomenologist",  name: "Phenomenologist",  avatarPath: "/avatars/3d/phenomenologist.png",   roleKind: "director" },
  ];
  const DEFAULT_MODE = "brainstorm";
  /* Director rotation cadence · matches home-3d-mock.js. Long enough
     for the eye to register the speaker pulse + name plate change
     without feeling busy. */
  const SPEAKER_ROTATION_MS = 4000;

  /** Pure seat-position calculator · matches `home-3d-mock.js`'s
   *  `computeSeatPositions` exactly so the banner's ring reads
   *  identical to the marketing homepage. */
  function computeSeatPositions(members) {
    const n = members.length;
    if (n === 0) return [];
    const cx = 50, cy = 50;
    const rx = 42, ry = 23;
    const chairRy = 15;
    const SEAT_SCALE = 1.10;
    const out = [];

    // Chair · bottom-centre of the ellipse.
    out.push({
      member: members[0],
      x: cx + rx * Math.cos(Math.PI / 2),
      y: cy + chairRy * Math.sin(Math.PI / 2),
      scaleHint: SEAT_SCALE,
      kind: "chair",
      thetaDeg: 90,
    });

    // Directors fan across the top arc (180° → 360°).
    const directorCount = n - 1;
    if (directorCount > 0) {
      const arcDeg   = directorCount === 2 ? 60  : 180;
      const arcStart = directorCount === 2 ? 240 : 180;
      const stepDeg = directorCount === 1 ? 0 : arcDeg / directorCount;
      for (let i = 0; i < directorCount; i++) {
        const t = directorCount === 1 ? 270 : arcStart + (i + 0.5) * stepDeg;
        const theta = (t * Math.PI) / 180;
        out.push({
          member: members[1 + i],
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

  /** Mount the brainstorm round-table scene into `host`. Returns
   *  a cleanup function on success, `null` on failure. Caller
   *  should swap to a static poster image when this returns null. */
  window.mountVoice3dBanner = function mountVoice3dBanner(host) {
    if (!host) return null;
    const VS3D = window.VoiceStage3D;
    if (!VS3D || typeof VS3D.isSupported !== "function") return null;
    if (!VS3D.isSupported()) return null;

    // Honour reduced-motion · idle camera lerp + chair pop-in
    // would feel wrong, and the user opted out of motion at OS
    // level. Caller falls back to poster.
    try {
      if (window.matchMedia
          && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        return null;
      }
    } catch (_) { /* old browser · matchMedia missing */ }

    try {
      // Write brainstorm floor vars onto the host element so
      // voice-3d.js's getComputedStyle read picks them up. Without
      // this the floor falls back to flat-color (`#5E6B47`) instead
      // of the soil + grass + flower pixel-art tile.
      host.style.setProperty("--floor-bg", BRAINSTORM_FLOOR_BG);
      host.style.setProperty("--floor-image", BRAINSTORM_FLOOR_IMAGE);

      // VS3D.mount returns false on WebGL init failure. Bail to
      // the poster fallback if so. `loading: false` suppresses the
      // built-in dark "rgba(0,0,0,0.42)" loading overlay · the
      // caller (onboarding.js / voice-onboarding.js) paints its
      // own brainstorm-themed placeholder that fades on mount, so
      // we don't want voice-3d.js's overlay stacking on top of it
      // (the result was an opaque-looking black box during the
      // first ~300 ms).
      if (!VS3D.mount(host, { camera: CAMERA_OPTS, loading: false })) return null;
    } catch (_) {
      return null;
    }

    // Paint the complete scene SYNCHRONOUSLY · floor + walls +
    // chair + 6 directors + first speaker highlight. No await on a
    // dynamic import means the first frame after mount already shows
    // a populated room. Inline data is the deliberate cost · the
    // marketing-homepage driver (home-3d-mock.js) stays its own copy
    // because it's loaded by a different surface, but this banner
    // can't afford the load-then-paint gap on first visit.
    // Decorate CAST with canonical avatar3d configs · without this
    // the chair + directors render as RNG-drawn random faces instead
    // of the seeded looks from src/seed/*.ts. Source: window.PB_CORE_AVATARS
    // (public/core-avatars.js, loaded by index.html before this file).
    // Idempotent · we re-walk on every mount in case PB_CORE_AVATARS
    // landed after first CAST construction.
    if (window.PB_CORE_AVATARS) {
      for (const m of CAST) {
        const cfg = window.PB_CORE_AVATARS[m.id];
        if (cfg && !m.avatar3d) m.avatar3d = cfg;
      }
    }
    const positions = computeSeatPositions(CAST);
    const directorIds = CAST
      .filter((m) => m.roleKind === "director")
      .map((m) => m.id);
    let speakerCursor = 0;
    const paint = () => {
      try {
        VS3D.update({
          mode: DEFAULT_MODE,
          positions,
          speakerId: directorIds[speakerCursor % directorIds.length],
          speakerState: "speaking",
          userWait: false,
          labels: { speaking: "speaking", thinking: "thinking" },
          votePop: "",
        });
      } catch (e) {
        try { console.warn("[voice-3d-banner] VS3D.update failed:", e); } catch (_) {}
      }
    };
    paint();

    // Rotate the speaking director every 4 s so the scene visibly
    // breathes (matches home-3d-mock.js's cadence). Cleared by the
    // unmount fn below.
    const rotationTimer = setInterval(() => {
      speakerCursor = (speakerCursor + 1) % directorIds.length;
      paint();
    }, SPEAKER_ROTATION_MS);

    return function unmount() {
      clearInterval(rotationTimer);
      try { VS3D.unmount(); } catch (_) {}
      try {
        host.style.removeProperty("--floor-bg");
        host.style.removeProperty("--floor-image");
      } catch (_) {}
    };
  };
})();
