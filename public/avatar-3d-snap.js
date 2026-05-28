/* ═══════════════════════════════════════════════════════════════════
   avatar-3d-snap.js · shared 3D head-and-shoulders snapshot helper.

   ── Why it exists ──────────────────────────────────────────────────
   Replaces the retired AvatarSkill (8-bit SVG generator). Every
   surface that used to call AvatarSkill.generateDataUrl / .generate /
   .randomSeed now lives on this module. The portrait is the SAME
   3D voxel render the agent-profile capture / voice room / home
   page / new-agent celebrity card all use — single source of
   truth, no more 2D/3D split.

   ── API surface ─────────────────────────────────────────────────────
   window.Avatar3DSnap = {
     randomSeed() → string                              · 8-char hex
     generate(seed, opts?) → Promise<string>            · dataURL PNG
     hydrateImg(imgOrSpan, seed, opts?) → Promise<void> · async paint
     cacheGet(seed) → string | null                     · sync hot read
   }

   `seed` is any string · same input always yields the same face
   (deterministic via avatar-3d.js → deriveDefaultAvatarConfig).

   Caches per-seed dataURLs in-memory · safe to call thousands of
   times from re-render loops. Lazy-loads three.js + avatar-3d.js
   on first generate() call; subsequent calls reuse the module.
   Falls back to no-op (resolves with empty string) on no-WebGL —
   callers should keep their initial-letter / placeholder fallback
   in the DOM for those visitors.
   ═══════════════════════════════════════════════════════════════════ */
(function (root) {
  if (root.Avatar3DSnap) return;

  const cache = new Map();   // Map<seed, dataUrl>
  const inflight = new Map(); // Map<seed, Promise<dataUrl>>
  let mods = null;             // { THREE, av } once loaded
  let modsPromise = null;

  function hasWebGL() {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch (_) { return false; }
  }

  function randomSeed() {
    const r = (n) => Math.floor(Math.random() * n).toString(16);
    return r(0xffff).padStart(4, "0") + r(0xffff).padStart(4, "0");
  }

  function cacheGet(seed) {
    return cache.has(seed) ? cache.get(seed) : null;
  }

  async function loadDeps() {
    if (mods) return mods;
    if (modsPromise) return modsPromise;
    modsPromise = (async () => {
      try {
        const [THREE, av] = await Promise.all([
          import("/vendor/three.module.min.js"),
          import("/avatar-3d.js"),
        ]);
        mods = { THREE, av };
        return mods;
      } catch (e) {
        try { console.warn("[avatar-3d-snap] dep load failed", e); } catch (_) {}
        modsPromise = null;
        return null;
      }
    })();
    return modsPromise;
  }

  /** Render a head-and-shoulders portrait for `seed` and cache the
   *  resulting dataURL. Concurrent calls for the same seed share the
   *  in-flight promise so the renderer never builds two figures with
   *  identical inputs. Returns "" when WebGL is unavailable. */
  async function generate(seed, opts) {
    if (!seed) return "";
    if (cache.has(seed)) return cache.get(seed);
    if (inflight.has(seed)) return inflight.get(seed);
    if (!hasWebGL()) return "";
    const p = (async () => {
      const m = await loadDeps();
      if (!m) return "";
      const { THREE, av } = m;
      // Preload required GLB models · cross-model swaps need source
      // GLBs cached before buildAvatar3D walks skeletons.
      const cfg = av.deriveDefaultAvatarConfig(seed);
      const modelIds = new Set([cfg.model]);
      if (cfg.hairStyle && cfg.hairStyle !== "none") modelIds.add(cfg.hairStyle);
      if (cfg.outfitStyle) modelIds.add(cfg.outfitStyle);
      try {
        await Promise.all(Array.from(modelIds).map((id) => av.loadAvatar3D(id).catch(() => null)));
      } catch (_) { /* */ }

      // Per-call renderer · the work is small (one frame) and tearing
      // down each time avoids leaking GPU buffers across many seeds.
      const SIZE = (opts && opts.size) || 128;
      const offCanvas = document.createElement("canvas");
      offCanvas.width = SIZE * 2;
      offCanvas.height = SIZE * 2;
      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas: offCanvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      } catch (e) {
        try { console.warn("[avatar-3d-snap] renderer init failed", e); } catch (_) {}
        return "";
      }
      renderer.setSize(SIZE * 2, SIZE * 2, false);
      renderer.setClearColor(0x000000, 0);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3140, 0.5));
      const key = new THREE.DirectionalLight(0xffffff, 1.2);
      key.position.set(2, 3, 2.5);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0xbfd4ff, 0.4);
      rim.position.set(-2, 2, -2);
      scene.add(rim);

      // Camera FOV matches avatar3d-editor's capturePng so face-
      // framing produces the same crop the agent-profile portrait
      // ships with.
      const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 20);

      let figure = null;
      try {
        figure = av.buildAvatar3D(seed, {
          model: cfg.model,
          hairStyle: cfg.hairStyle,
          outfitStyle: cfg.outfitStyle,
          accessory: cfg.accessory,
          height: 1.7,
          skin: cfg.skin, hair: cfg.hair, brow: cfg.brow, outfit: cfg.outfit,
          browStyle: cfg.browStyle, tieStyle: cfg.tieStyle,
          tie: cfg.tie, eye: cfg.eye,
        });
      } catch (e) {
        try { console.warn("[avatar-3d-snap] buildAvatar3D failed for seed", seed, e); } catch (_) {}
        figure = null;
      }
      if (!figure) {
        try { renderer.dispose(); } catch (_) {}
        return "";
      }
      figure.rotation.y = -0.18;
      scene.add(figure);
      try {
        if (typeof av.applyFaceFraming === "function") av.applyFaceFraming(camera, figure);
      } catch (_) { /* */ }
      renderer.render(scene, camera);
      const dataUrl = renderer.domElement.toDataURL("image/png");
      figure.traverse((n) => {
        if (n.material) {
          const ms = Array.isArray(n.material) ? n.material : [n.material];
          for (const mat of ms) { try { mat.dispose(); } catch (_) {} }
        }
        if (n.geometry) { try { n.geometry.dispose(); } catch (_) {} }
      });
      try { renderer.dispose(); } catch (_) {}
      cache.set(seed, dataUrl);
      return dataUrl;
    })().finally(() => { inflight.delete(seed); });
    inflight.set(seed, p);
    return p;
  }

  /** Async paint a portrait into an existing `<img>` or fallback
   *  `<span>` node. The first attempt uses the cache (synchronous);
   *  if no cache, an async render kicks off and updates the node
   *  when it lands. Use when the call site can't await — it pulls
   *  the placeholder out of the DOM and replaces it with an `<img>`
   *  carrying the rendered portrait. */
  async function hydrateImg(target, seed, opts) {
    if (!target || !seed) return;
    const cached = cacheGet(seed);
    if (cached) {
      paint(target, cached);
      return;
    }
    const dataUrl = await generate(seed, opts);
    if (dataUrl) paint(target, dataUrl);
  }

  function paint(target, dataUrl) {
    if (!target) return;
    if (target.tagName === "IMG") {
      target.src = dataUrl;
      return;
    }
    const img = document.createElement("img");
    img.src = dataUrl;
    img.alt = "";
    // Preserve any classes the placeholder carried so existing CSS
    // sizing rules continue to apply.
    if (target.className) img.className = target.className;
    if (target.parentNode) target.parentNode.replaceChild(img, target);
  }

  root.Avatar3DSnap = { randomSeed, generate, hydrateImg, cacheGet };
})(typeof window !== "undefined" ? window : globalThis);
