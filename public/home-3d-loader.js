/* ═══════════════════════════════════════════════════════════════════
   home-3d-loader.js · capability-gated lazy mount for the homepage
   3D hero scene.

   Strategy · LCP-safe progressive enhancement:
   1. Page paints with the static poster image — `<picture
      class="hero-3d-poster">` inside `.hero-3d`.
   2. This script (deferred module, ~2KB) runs after parse.
   3. Probes WebGL + reduced-motion + save-data. If ANY check fails,
      we leave the poster as-is and never download three.js. Saves
      visitors on low-end devices / slow networks ~500KB of unused JS.
   4. On pass, IntersectionObserver waits for the hero to be 30%+
      visible (initial page-load hero is already visible so this
      fires immediately, but the observer guarantees we don't burn
      idle bandwidth on a fold the visitor scrolls past in 200ms).
   5. requestIdleCallback yields the main thread before kicking off
      the heavy import chain.
   6. Dynamic `import('/voice-3d.js')` triggers the three.js + voice-3d
      download. The module sets `window.VoiceStage3D` as a side effect
      (it's IIFE-wrapped, not ES-exported).
   7. `import('/home-3d-mock.js')` brings in the cast + speaker
      rotation driver.
   8. `VoiceStage3D.mount()` paints the WebGL canvas into the stage
      target; `startMockDriver()` populates the scene with the cast
      and rotating speaker.
   9. Mark `.hero-3d[data-mounted]` so the poster CSS-fades out and
      the "drag to look around" hint chip CSS-fades in (and fades
      out again after 3s — one-shot affordance).

   Any error in the import / mount chain falls back to the poster
   silently. The visitor still sees a polished hero, no broken UI. */

(function () {
  function shouldSkip3d() {
    // No WebGL → nothing to mount.
    if (typeof window === "undefined") return true;
    if (!window.WebGLRenderingContext) return true;
    // Respect the OS-level reduced-motion preference.
    try {
      if (window.matchMedia
          && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        return true;
      }
    } catch (_) { /* old browser · matchMedia not available */ }
    // Honour Save-Data when the browser exposes it. NetworkInformation
    // is Chromium-only as of writing; the absence is a non-signal,
    // not a positive Save-Data state.
    try {
      const c = navigator.connection;
      if (c && (c.saveData === true || c.effectiveType === "slow-2g" || c.effectiveType === "2g")) {
        return true;
      }
    } catch (_) { /* defensive · navigator.connection optional */ }
    return false;
  }

  function fadeInHint(hintEl) {
    if (!hintEl) return;
    hintEl.removeAttribute("hidden");
    requestAnimationFrame(() => hintEl.classList.add("is-visible"));
    setTimeout(() => hintEl.classList.remove("is-visible"), 3500);
  }

  async function mountHero3d(heroEl, stageEl, hintEl, loadingEl) {
    // Drop the loading veil on any non-mounted exit (capability bail,
    // mount failure, import throw) so it never spins forever. On the
    // success path the `[data-mounted]` CSS rule fades it instead.
    const hideLoading = () => { if (loadingEl) loadingEl.setAttribute("hidden", ""); };
    try {
      // Import voice-3d.js · its top-level `import` of three.module +
      // OrbitControls pulls those in too. The IIFE inside sets
      // `window.VoiceStage3D`. We don't read the module's namespace
      // export (there is none); we read off `window.VoiceStage3D`
      // after the import completes.
      await import("/voice-3d.js");
      const VS3D = window.VoiceStage3D;
      if (!VS3D || !VS3D.isSupported || !VS3D.isSupported()) { hideLoading(); return; }

      // The stage host must be visible (display: block, not [hidden])
      // before mount, otherwise WebGLRenderer reads a 0×0 canvas size
      // and the camera projection comes out NaN.
      stageEl.removeAttribute("hidden");
      // Marketing camera overrides · pull the camera in tighter and
      // ease the elevation so the table fills the 21:9 hero frame
      // with a soft top-down lean. App defaults stay 30°/18-unit if
      // no opts are passed (the app's renderRoundTable calls
      // VS3D.mount(stage) with no opts).
      if (!VS3D.mount(stageEl, {
        camera: {
          distance: 10,        // pulled to the OrbitControls minDistance · the
                               // closest comfortable framing where the long
                               // table still fits horizontally inside the
                               // 21:9 hero frame at FOV 28°.
          elevationDeg: 24,    // soft top-down lean (default 30 was steep, 18 too flat)
          lookAtY: 0.75,       // target slightly above the table top so seated heads centre
        },
        // Suppress the built-in loading veil · the marketing hero
        // already shows a static poster (`home-3d-poster.*`) which
        // covers the mount → first-frame gap. Layering the veil on
        // top of the poster would just darken it before the canvas
        // takes over.
        loading: false,
      })) { hideLoading(); return; }

      // Pull the cast + start the rotating-speaker driver. The mock
      // module is small (~3KB) so importing it after VS3D.mount keeps
      // the critical 3D code on the wire first.
      const mock = await import("/home-3d-mock.js");
      const stop = mock.startMockDriver();

      // Hand off to CSS · the poster fades out, the canvas fades in
      // (already visible · just sitting under the poster until now).
      heroEl.setAttribute("data-mounted", "");
      fadeInHint(hintEl);

      // Tear-down hook · the homepage is a single static page so the
      // visitor doesn't navigate away within this SPA, but if a future
      // section adds JS routing we'll want a way to stop the driver.
      window.__home3dStop = stop;
    } catch (e) {
      // Silently fall back to the poster. The visitor still sees a
      // polished hero, just without the live scene.
      hideLoading();
      try { console.warn("[home-3d] mount failed, poster fallback:", e); } catch (_) {}
    }
  }

  function init() {
    const heroEl = document.querySelector("[data-hero-3d]");
    if (!heroEl) return;
    const stageEl = heroEl.querySelector("[data-hero-3d-stage]");
    const hintEl  = heroEl.querySelector("[data-hero-3d-hint]");
    const loadingEl = heroEl.querySelector("[data-hero-3d-loading]");
    if (!stageEl) return;

    if (shouldSkip3d()) return; // keep poster, do nothing

    // IntersectionObserver triggers on first visibility threshold
    // hit. On initial page load the hero is already in view so the
    // callback fires near-immediately · the threshold is mainly a
    // safety net for the (rare) case where a visitor deep-links to
    // a fragment further down the page · don't pre-mount the scene
    // on a page they may never scroll back up to.
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.disconnect();
        // Commit to loading · reveal the loading veil NOW (before the
        // idle yield + ~500KB download) so the section shows a spinner
        // for the whole gap, not blank. Torn down on mount / failure
        // inside mountHero3d.
        if (loadingEl) loadingEl.removeAttribute("hidden");
        // Yield to the main thread so initial paint / hero font load
        // / hero CSS animations all finish before we kick off ~500KB
        // of JS download. requestIdleCallback is the right primitive
        // here; setTimeout(..., 0) fallback for Safari which still
        // lacks it as of 2026.
        const kick = () => mountHero3d(heroEl, stageEl, hintEl, loadingEl);
        if (typeof window.requestIdleCallback === "function") {
          window.requestIdleCallback(kick, { timeout: 1500 });
        } else {
          setTimeout(kick, 200);
        }
        break;
      }
    }, { threshold: 0.3 });
    observer.observe(heroEl);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
