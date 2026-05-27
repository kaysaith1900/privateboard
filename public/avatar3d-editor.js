/* ═══════════════════════════════════════════
   3D AVATAR EDITOR (捏 avatar) · profile overlay
   ───────────────────────────────────────────
   Opened from the director profile's ⋯ menu (data-ap-menu-action=
   "edit-avatar3d") via window.openAvatar3DEditor(slug). Left pane is a
   three.js stage; right pane is the customizer panel. On Save it renders a
   PNG portrait and PATCHes { avatarPath: png, avatar3d: config } so the 2D
   avatar everywhere updates AND the voice room can rebuild the 3D figure.

   three.js is imported lazily on first open so it doesn't cost every page
   load. Mirrors the room-settings overlay open/close/dismiss conventions.
   ═══════════════════════════════════════════ */
(function () {
  // ── DOM (built once) ──────────────────────────────────────────────
  let overlay = null, modal = null, stageEl = null, panelBody = null;
  let statusEl = null, saveBtn = null;

  // ── three.js + scene (loaded lazily, kept across opens) ───────────
  let THREE = null, av = null, OrbitControls = null, RoomEnvironment = null;
  let renderer = null, scene = null, camera = null, controls = null;
  let pmrem = null, ground = null, group = null, ro = null;
  let booted = false;        // scene built
  let raf = null;

  // ── per-open state ────────────────────────────────────────────────
  // target · who we're editing. { type:"agent", slug } saves to the agent
  // record; { type:"user" } saves to the user's prefs.
  let target = null;
  let buildSeed = "editor";  // seed passed to buildAvatar3D (deterministic look)
  let sel = null;            // { model, hairStyle, outfitStyle, accessory, skin, hair, brow, outfit }
  let saving = false;

  const FULL_CAM = { pos: [0.7, 1.45, 2.7], target: [0, 0.9, 0] };
  const AVATAR_HEIGHT = 1.6;

  function setStatus(msg) { if (statusEl) statusEl.textContent = msg || ""; }

  /* ── DOM scaffold ────────────────────────────────────────────────── */
  function buildDom() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "avatar3d-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div class="avatar3d-modal" role="dialog" aria-modal="true" aria-label="3D avatar editor">
        <div class="av3d-stage">
          <div class="av3d-hint">拖动旋转 · 滚轮缩放</div>
          <div class="av3d-status"></div>
        </div>
        <div class="av3d-panel">
          <div class="av3d-head">
            <h2 class="av3d-kicker">捏 avatar</h2>
            <button type="button" class="av3d-close" data-av3d-close aria-label="Close">✕</button>
          </div>
          <div class="av3d-body">
            <div class="av3d-grp"><div class="av3d-lab">发型 Hair</div><div class="av3d-sw is-pill" data-row="hairStyle"></div></div>
            <div class="av3d-grp"><div class="av3d-lab">眼眉 Brow</div><div class="av3d-sw is-pill" data-row="browStyle"></div></div>
            <div class="av3d-grp"><div class="av3d-lab">衣服款式 Outfit</div><div class="av3d-sw is-pill" data-row="outfitStyle"></div></div>
            <div class="av3d-grp"><div class="av3d-lab">领带 Tie</div><div class="av3d-sw is-pill" data-row="tieStyle"></div></div>
            <div class="av3d-grp"><div class="av3d-lab">装饰 Accessory</div><div class="av3d-sw is-pill" data-row="accessory"></div></div>
            <div class="av3d-grp"><div class="av3d-lab">肤色 Skin</div><div class="av3d-sw is-color" data-row="skin"></div></div>
            <div class="av3d-grp"><div class="av3d-lab">发色 Hair</div><div class="av3d-sw is-color" data-row="hair"></div></div>
            <div class="av3d-grp"><div class="av3d-lab">眉色 Brow</div><div class="av3d-sw is-color" data-row="brow"></div></div>
            <div class="av3d-grp"><div class="av3d-lab">瞳色 Eye</div><div class="av3d-sw is-color" data-row="eye"></div></div>
            <div class="av3d-grp"><div class="av3d-lab">衣色 Outfit color</div><div class="av3d-sw is-color" data-row="outfit"></div></div>
            <div class="av3d-grp"><div class="av3d-lab">颈饰色 Tie/Bow</div><div class="av3d-sw is-color" data-row="tie"></div></div>
          </div>
          <div class="av3d-foot">
            <button type="button" class="av3d-btn-rand" data-av3d-rand title="随机">🎲</button>
            <button type="button" class="av3d-btn-cancel" data-av3d-close>取消</button>
            <button type="button" class="av3d-btn-save" data-av3d-save>保存</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    modal = overlay.querySelector(".avatar3d-modal");
    stageEl = overlay.querySelector(".av3d-stage");
    panelBody = overlay.querySelector(".av3d-body");
    statusEl = overlay.querySelector(".av3d-status");
    saveBtn = overlay.querySelector("[data-av3d-save]");

    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll("[data-av3d-close]").forEach((b) =>
      b.addEventListener("click", (e) => { e.preventDefault(); close(); }));
    overlay.querySelector("[data-av3d-rand]").addEventListener("click", (e) => { e.preventDefault(); randomize(); });
    saveBtn.addEventListener("click", (e) => { e.preventDefault(); void save(); });
    // Escape closes the editor only (stop it from also closing the profile,
    // which listens in capture phase).
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.classList.contains("open")) {
        e.stopImmediatePropagation();
        close();
      }
    }, true);
  }

  /* ── three.js scene · built once on first open ───────────────────── */
  async function ensureScene() {
    if (booted) return;
    THREE = await import("/vendor/three.module.min.js");
    ({ OrbitControls } = await import("/vendor/OrbitControls.js"));
    ({ RoomEnvironment } = await import("/vendor/RoomEnvironment.js"));
    av = await import("/avatar-3d.js");

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.7;
    renderer.setClearColor(0x000000, 0); // transparent · CSS gradient shows through
    stageEl.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.1;
    controls.minDistance = 1.4; controls.maxDistance = 5;
    controls.enablePan = false;

    pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.35;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x33384a, 0.18));
    const key = new THREE.DirectionalLight(0xffffff, 0.7);
    key.position.set(3, 6, 4); key.castShadow = true; scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd4ff, 0.3);
    rim.position.set(-4, 3, -3); scene.add(rim);
    ground = new THREE.Mesh(
      new THREE.CircleGeometry(2.0, 48),
      new THREE.MeshStandardMaterial({ color: 0x20232a, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

    applyCamera(FULL_CAM);
    ro = new ResizeObserver(() => resize());
    ro.observe(stageEl);
    raf = renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
    booted = true;
  }

  function applyCamera({ pos, target }) {
    camera.position.set(pos[0], pos[1], pos[2]);
    controls.target.set(target[0], target[1], target[2]);
    controls.update();
  }

  function resize() {
    if (!renderer || !stageEl) return;
    const w = stageEl.clientWidth || 1, h = stageEl.clientHeight || 1;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + "px";
    renderer.domElement.style.height = h + "px";
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /* ── build / recolour the avatar from `sel` ──────────────────────── */
  function rebuild() {
    if (group) { scene.remove(group); group = null; }
    group = av.buildAvatar3D(buildSeed || "editor", {
      model: sel.model, hairStyle: sel.hairStyle, outfitStyle: sel.outfitStyle,
      browStyle: sel.browStyle, tieStyle: sel.tieStyle,
      accessory: sel.accessory, height: AVATAR_HEIGHT,
      skin: sel.skin, hair: sel.hair, brow: sel.brow, outfit: sel.outfit, tie: sel.tie, eye: sel.eye,
    });
    if (group) scene.add(group);
  }

  /* ── panel population ────────────────────────────────────────────── */
  // Body style ("model") is intentionally NOT user-selectable — it's fixed by
  // the saved/derived config; the user shapes the look via hair / outfit /
  // accessory / colours instead.
  const PILL_LISTS = () => ({
    hairStyle: av.HAIR_STYLES,
    browStyle: av.BROW_STYLES,
    outfitStyle: av.OUTFIT_STYLES,
    tieStyle: av.TIE_STYLES,
    accessory: av.ACCESSORY_STYLES,
  });
  const COLOR_LISTS = () => ({
    skin: av.AVATAR_PALETTES.skin,
    hair: av.AVATAR_PALETTES.hair,
    brow: av.AVATAR_PALETTES.brow,
    eye: av.AVATAR_PALETTES.eye,
    outfit: av.AVATAR_PALETTES.outfit,
    tie: av.AVATAR_PALETTES.tie,
  });

  function buildPanel() {
    const pills = PILL_LISTS();
    for (const role of Object.keys(pills)) {
      const c = panelBody.querySelector(`[data-row="${role}"]`);
      c.innerHTML = "";
      pills[role].forEach((opt) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = opt.label;
        if (opt.id === sel[role]) b.classList.add("on");
        b.addEventListener("click", () => {
          if (sel[role] === opt.id) return;
          sel[role] = opt.id;
          markOn(c, b);
          rebuild(); // hair / outfit / accessory all overlay from preloaded models
        });
        c.appendChild(b);
      });
    }
    const colors = COLOR_LISTS();
    for (const role of Object.keys(colors)) {
      const c = panelBody.querySelector(`[data-row="${role}"]`);
      c.innerHTML = "";
      colors[role].forEach((hex) => {
        const b = document.createElement("button");
        b.type = "button";
        b.style.background = hex;
        b.title = hex;
        if (String(sel[role]).toLowerCase() === hex.toLowerCase()) b.classList.add("on");
        b.addEventListener("click", () => {
          sel[role] = hex;
          markOn(c, b);
          av.recolorAvatar(group, { [role]: hex }); // instant, no rebuild
        });
        c.appendChild(b);
      });
    }
  }

  function markOn(container, btn) {
    container.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    btn.classList.add("on");
  }

  function randomize() {
    const P = av.AVATAR_PALETTES;
    const r = (a) => a[Math.floor(Math.random() * a.length)];
    sel.skin = r(P.skin); sel.hair = r(P.hair); sel.brow = r(P.brow); sel.outfit = r(P.outfit); sel.tie = r(P.tie); sel.eye = r(P.eye);
    av.recolorAvatar(group, sel);
    // re-mark the colour swatches
    for (const role of ["skin", "hair", "brow", "outfit", "tie", "eye"]) {
      const c = panelBody.querySelector(`[data-row="${role}"]`);
      c.querySelectorAll("button").forEach((x) =>
        x.classList.toggle("on", x.title.toLowerCase() === String(sel[role]).toLowerCase()));
    }
  }

  /* ── config normalization · saved blob → editor sel ──────────────── */
  function normalizeConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return null;
    const need = ["model", "hairStyle", "outfitStyle", "accessory", "skin", "hair", "brow", "outfit"];
    for (const k of need) if (typeof cfg[k] !== "string" || !cfg[k]) return null;
    const out = { ...cfg };
    // Newer dimensions · default when absent (configs saved before they existed).
    if (typeof out.browStyle !== "string" || !out.browStyle) out.browStyle = "default";
    if (typeof out.tieStyle !== "string" || !out.tieStyle) out.tieStyle = "none";
    if (typeof out.tie !== "string" || !out.tie) out.tie = (av.AVATAR_PALETTES.tie || ["#3b5b78"])[0];
    if (typeof out.eye !== "string" || !out.eye) out.eye = (av.AVATAR_PALETTES.eye || ["#0d0d0d"])[0];
    return out;
  }

  // World-space bounding box of the avatar's FACE features (eyes / brow /
  // mouth / teeth). Stable across hairstyles + accessories, so it's a reliable
  // anchor for consistent portrait framing. Null if no face meshes are found.
  // NOTE: "eyewhite" is intentionally excluded — some models name their white
  // SHOES "White", which resolveRole tags as eyewhite, dragging the box to the
  // feet. Eye/brow/mouth/teeth are reliably head-only.
  const FACE_ROLES = ["eye", "brow", "mouth", "teeth"];
  function getFaceBox(g) {
    if (!g) return null;
    g.updateMatrixWorld(true);
    const box = new THREE.Box3();
    let any = false;
    g.traverse((o) => {
      if (o.isMesh && o.visible && o.userData && FACE_ROLES.includes(o.userData.avatarRole)) {
        box.expandByObject(o);
        any = true;
      }
    });
    return any ? box : null;
  }

  // Position `cam` for a consistent head-and-shoulders portrait of `g`, anchored
  // on its face box so head size is uniform across hairstyles / accessories
  // (the avatar's total height — incl. hats/crowns — varies, but the face
  // doesn't). Multipliers in units of face height; verified across all looks.
  function applyFaceFraming(cam, g) {
    const face = getFaceBox(g);
    if (face) {
      const fc = face.getCenter(new THREE.Vector3());
      const faceH = Math.max(face.max.y - face.min.y, 1e-3);
      const TOP = 2.0, BOTTOM = 1.5;
      const topY = fc.y + TOP * faceH, botY = fc.y - BOTTOM * faceH;
      const lookY = (topY + botY) / 2, spanY = topY - botY;
      const dist = (spanY / 2) / Math.tan((cam.fov * Math.PI / 180) / 2);
      cam.position.set(fc.x, lookY, fc.z + dist);
      cam.lookAt(fc.x, lookY, fc.z);
    } else {
      cam.position.set(0, 1.4, 1.6);
      cam.lookAt(0, 1.22, 0);
    }
    cam.updateProjectionMatrix();
  }

  /* ── render a square head/shoulders PNG portrait ─────────────────── */
  function capturePng(size = 384) {
    const prevPos = camera.position.clone();
    const prevTarget = controls.target.clone();
    const prevAspect = camera.aspect;
    const prevW = stageEl.clientWidth || size, prevH = stageEl.clientHeight || size;
    const prevPR = renderer.getPixelRatio();
    const groundVisible = ground.visible;

    ground.visible = false;
    renderer.setPixelRatio(1);
    renderer.setSize(size, size, false);
    camera.aspect = 1;
    camera.up.set(0, 1, 0);

    // Consistent head-and-shoulders framing · anchored on the face (shared).
    applyFaceFraming(camera, group);
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL("image/png");

    // restore live view
    ground.visible = groundVisible;
    renderer.setPixelRatio(prevPR);
    renderer.setSize(prevW, prevH, false);
    camera.aspect = prevAspect;
    camera.position.copy(prevPos);
    camera.updateProjectionMatrix();
    controls.target.copy(prevTarget);
    controls.update();
    return url;
  }

  /* ── save · capture PNG + config, persist to the target ──────────── */
  async function save() {
    if (saving || !group || !target) return;
    saving = true; saveBtn.disabled = true; setStatus("保存中…");
    try {
      const png = capturePng();
      const cfg = { ...sel };
      if (target.type === "user") await saveUser(png, cfg);
      else await saveAgent(target.slug, png, cfg);
      close();
    } catch (e) {
      console.error("[avatar3d-editor] save failed", e);
      setStatus("保存失败：" + (e && e.message ? e.message : e));
    } finally {
      saving = false; saveBtn.disabled = false;
    }
  }

  // Director · PATCH /api/agents/:id, then refresh roster + repaint profile.
  async function saveAgent(slug, png, cfg) {
    const live = window.app && window.app.agentsById ? window.app.agentsById[slug] : null;
    const res = await fetch("/api/agents/" + encodeURIComponent(slug), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ avatarPath: png, avatar3d: cfg }),
    });
    if (!res.ok) throw new Error("save failed (" + res.status + ")");
    const updated = await res.json();
    if (live) { live.avatarPath = updated.avatarPath || png; live.avatar3d = updated.avatar3d || cfg; }
    if (window.app && typeof window.app.refreshAgents === "function") await window.app.refreshAgents();
    else if (window.app && typeof window.app.renderSidebarAgents === "function") window.app.renderSidebarAgents();
    if (typeof window.openAgentProfile === "function") window.openAgentProfile(slug);
  }

  // User (host) · PUT /api/prefs, then repaint sidebar foot + settings frame.
  async function saveUser(png, cfg) {
    const res = await fetch("/api/prefs", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ avatar3d: cfg, avatarUrl: png }),
    });
    if (!res.ok) throw new Error("save failed (" + res.status + ")");
    const prefs = await res.json();
    if (window.app) {
      window.app.prefs = { ...(window.app.prefs || {}), avatar3d: prefs.avatar3d, avatarUrl: prefs.avatarUrl };
      if (typeof window.app.renderUserBlock === "function") window.app.renderUserBlock();
    }
    // Let the user-settings pane repaint its avatar frame if it's open.
    window.dispatchEvent(new CustomEvent("pb:user-avatar-updated", { detail: { avatarUrl: prefs.avatarUrl } }));
  }

  /* ── open / close ────────────────────────────────────────────────── */
  // `arg` is an agent slug (string) or { kind: "user" }.
  async function open(arg) {
    if (arg && arg.kind === "user") {
      target = { type: "user" };
    } else if (typeof arg === "string" && arg) {
      target = { type: "agent", slug: arg };
    } else {
      return;
    }
    buildDom();
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    setStatus("加载中…");
    try {
      await ensureScene();
      resize();
      await Promise.all(av.AVATAR_MODELS.map((m) => av.loadAvatar3D(m.id)));
      if (target.type === "user") {
        const u = (window.app && window.app.prefs) || {};
        buildSeed = u.avatarSeed || "user";
        sel = normalizeConfig(u.avatar3d) || av.deriveDefaultAvatarConfig(buildSeed);
      } else {
        const live = window.app && window.app.agentsById ? window.app.agentsById[target.slug] : null;
        buildSeed = target.slug;
        sel = normalizeConfig(live && live.avatar3d) || av.deriveDefaultAvatarConfig(target.slug);
      }
      buildPanel();
      rebuild();
      applyCamera(FULL_CAM);
      setStatus("");
    } catch (e) {
      console.error("[avatar3d-editor] open failed", e);
      setStatus("加载失败：" + (e && e.message ? e.message : e));
    }
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  /* ── Standalone portrait render ───────────────────────────────────
     Render an avatar3d `config` to a head-and-shoulders PNG using a throwaway
     offscreen renderer — same framing + lighting as the editor's capture, but
     without opening the overlay. Used to give newly-created directors a 3D
     screenshot avatar. Returns a PNG data URL (or null on failure). */
  async function renderAvatar3DPortrait(config, size = 384) {
    if (!THREE) THREE = await import("/vendor/three.module.min.js");
    if (!RoomEnvironment) ({ RoomEnvironment } = await import("/vendor/RoomEnvironment.js"));
    if (!av) av = await import("/avatar-3d.js");
    await Promise.all(av.AVATAR_MODELS.map((m) => av.loadAvatar3D(m.id)));
    const cfg = config || av.deriveDefaultAvatarConfig("portrait");
    const cv = document.createElement("canvas"); cv.width = size; cv.height = size;
    const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1); r.setSize(size, size, false); r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.7;
    const sc = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(r);
    sc.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    sc.environmentIntensity = 0.35;
    sc.add(new THREE.HemisphereLight(0xffffff, 0x33384a, 0.18));
    const key = new THREE.DirectionalLight(0xffffff, 0.7); key.position.set(3, 6, 4); sc.add(key);
    const rim = new THREE.DirectionalLight(0xbfd4ff, 0.3); rim.position.set(-4, 3, -3); sc.add(rim);
    let url = null;
    try {
      const g = av.buildAvatar3D("portrait", {
        model: cfg.model, hairStyle: cfg.hairStyle, outfitStyle: cfg.outfitStyle,
        browStyle: cfg.browStyle, tieStyle: cfg.tieStyle, accessory: cfg.accessory, height: AVATAR_HEIGHT,
        skin: cfg.skin, hair: cfg.hair, brow: cfg.brow, outfit: cfg.outfit, tie: cfg.tie, eye: cfg.eye,
      });
      if (g) {
        sc.add(g);
        const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 100); cam.up.set(0, 1, 0);
        applyFaceFraming(cam, g);
        r.render(sc, cam);
        url = cv.toDataURL("image/png");
      }
    } finally {
      // Dispose the renderer (frees this context). Do NOT dispose geometry —
      // it's shared with the cached templates.
      try { pmrem.dispose(); } catch (_) {}
      try { r.forceContextLoss(); } catch (_) {}
      try { r.dispose(); } catch (_) {}
    }
    return url;
  }

  window.openAvatar3DEditor = open;
  window.closeAvatar3DEditor = close;
  window.renderAvatar3DPortrait = renderAvatar3DPortrait;
})();
