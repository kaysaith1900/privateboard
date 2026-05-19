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
   (line ~15965) so `window.VoiceStage3D` is available by the time
   onboarding renders. The mock driver (`home-3d-mock.js`) is
   imported dynamically here — small (~3 KB), lazy-loads only when
   the banner actually mounts.

   Public surface:
     `window.mountVoice3dBanner(host)` → `() => void` | `null`
     Mounts the brainstorm-tone scene with the marketing camera
     overrides. Returns a stop fn the caller calls on unmount /
     step change. Returns `null` if WebGL isn't supported or the
     mount fails (caller falls back to a static poster img). */

(function () {
  /* Brainstorm-tone floor · same CSS values as
     `index.html:.roundtable-stage[data-floor="brainstorm"]` (line
     8671). Inlined here so the host DOM doesn't need any data
     attribute or app CSS · we just write the CSS vars directly
     onto the mount element and `voice-3d.js:rebuildFloor` reads
     them via `getComputedStyle(host)`. */
  const BRAINSTORM_FLOOR_BG = "#5E6B47";
  const BRAINSTORM_FLOOR_IMAGE = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128' shape-rendering='crispEdges'><rect width='128' height='128' fill='%235E6B47'/><rect x='0' y='8' width='20' height='16' fill='%234F5C3D'/><rect x='104' y='20' width='20' height='20' fill='%234F5C3D'/><rect x='88' y='64' width='24' height='16' fill='%234F5C3D'/><rect x='0' y='64' width='12' height='20' fill='%234F5C3D'/><rect x='44' y='64' width='16' height='8' fill='%234F5C3D'/><rect x='72' y='8' width='12' height='8' fill='%236E7A52'/><rect x='120' y='80' width='8' height='12' fill='%236E7A52'/><rect x='48' y='84' width='8' height='8' fill='%236E7A52'/><rect x='48' y='24' width='32' height='32' fill='%235C4838'/><rect x='44' y='28' width='4' height='24' fill='%235C4838'/><rect x='80' y='28' width='4' height='24' fill='%235C4838'/><rect x='52' y='20' width='24' height='4' fill='%235C4838'/><rect x='52' y='56' width='20' height='4' fill='%235C4838'/><rect x='56' y='16' width='12' height='4' fill='%235C4838'/><rect x='56' y='32' width='8' height='8' fill='%234A3A28'/><rect x='68' y='40' width='4' height='8' fill='%234A3A28'/><rect x='60' y='24' width='4' height='4' fill='%236E5A48'/><rect x='68' y='48' width='4' height='4' fill='%236E5A48'/><rect x='58' y='44' width='2' height='2' fill='%236B6258'/><rect x='72' y='32' width='2' height='2' fill='%236B6258'/><rect x='50' y='38' width='2' height='2' fill='%236B6258'/><rect x='16' y='96' width='24' height='20' fill='%235C4838'/><rect x='12' y='100' width='4' height='12' fill='%235C4838'/><rect x='40' y='100' width='4' height='12' fill='%235C4838'/><rect x='20' y='92' width='16' height='4' fill='%235C4838'/><rect x='22' y='104' width='8' height='4' fill='%234A3A28'/><rect x='20' y='100' width='4' height='4' fill='%236E5A48'/><rect x='24' y='108' width='2' height='2' fill='%236B6258'/><rect x='32' y='98' width='2' height='2' fill='%236B6258'/><rect x='8' y='40' width='1' height='2' fill='%238FA068'/><rect x='24' y='72' width='1' height='2' fill='%238FA068'/><rect x='104' y='56' width='1' height='2' fill='%238FA068'/><rect x='120' y='104' width='1' height='2' fill='%238FA068'/><rect x='88' y='44' width='1' height='2' fill='%238FA068'/><rect x='4' y='88' width='1' height='2' fill='%238FA068'/><rect x='64' y='88' width='1' height='2' fill='%238FA068'/><rect x='92' y='24' width='1' height='2' fill='%238FA068'/><rect x='44' y='62' width='1' height='2' fill='%238FA068'/><rect x='80' y='120' width='1' height='2' fill='%238FA068'/><rect x='12' y='12' width='1' height='2' fill='%238FA068'/><rect x='112' y='60' width='1' height='2' fill='%238FA068'/></svg>\")";

  /* Marketing camera framing · matches `home-3d-loader.js` so the
     in-app banner reads as the same scene the homepage shows.
     Closer pull + softer top-down lean than the app's voice-room
     view (which uses defaults 18-unit / 30°). */
  const CAMERA_OPTS = {
    distance: 13,
    elevationDeg: 24,
    lookAtY: 0.75,
  };

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
      // the poster fallback if so.
      if (!VS3D.mount(host, { camera: CAMERA_OPTS })) return null;
    } catch (_) {
      return null;
    }

    // Mock driver · provides the 6-director cast + rotates the
    // speaking seat every 4 s so the scene visibly breathes.
    // Imported lazily because home-3d-mock.js is an ES module and
    // we want it parse-deferred until a banner actually opens.
    let stopMockDriver = null;
    import("/home-3d-mock.js")
      .then((mod) => {
        if (mod && typeof mod.startMockDriver === "function") {
          stopMockDriver = mod.startMockDriver();
        }
      })
      .catch((e) => {
        try { console.warn("[voice-3d-banner] mock driver import failed:", e); } catch (_) {}
      });

    return function unmount() {
      if (stopMockDriver) { try { stopMockDriver(); } catch (_) {} stopMockDriver = null; }
      try { VS3D.unmount(); } catch (_) {}
      try {
        host.style.removeProperty("--floor-bg");
        host.style.removeProperty("--floor-image");
      } catch (_) {}
    };
  };
})();
