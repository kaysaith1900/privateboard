/* ═══════════════════════════════════════════════════════════════════
   avatar-3d.js · dynamic 3D director avatars (three.js).

   Loads rigged GLB base models and produces real 3D avatar instances —
   one per director, recoloured per-seed (or explicitly by the customizer)
   so each reads distinct. Supports MULTIPLE base "styles" (each its own
   GLB); the customizer lets the user pick a style + tweak skin / hair /
   outfit colours + toggle the style's accessory (hat / glasses).

   ES module · imports the vendored three + loaders directly. Consumers:
     await loadAvatar3D(modelId?)          → caches + a model's GLB
     buildAvatar3D(seed, opts?)            → fresh THREE.Group instance
     recolorAvatar(group, {skin,hair,outfit})
     setAvatarPartVisible(group, 'hat'|'glasses', bool)
     isAvatar3DReady(modelId?) · AVATAR_MODELS · AVATAR_PALETTES

   `buildAvatar3D` returns a Group with its origin between the feet (feet
   at y=0, centred x/z) so callers drop it straight onto a seat position.
   ═══════════════════════════════════════════════════════════════════ */

import * as THREE from "/vendor/three.module.min.js";
import { GLTFLoader } from "/vendor/GLTFLoader.js";
import { clone as cloneSkeleton } from "/vendor/SkeletonUtils.js";

/* ── Base-model registry ─────────────────────────────────────────────
   Each style is its own rigged GLB. Material names in these exports are
   unreliable (skin/hair/outfit all ship as unnamed / "Color_"), so we map
   role by the material's BASE COLOUR (matched with tolerance) — reliable
   for curated assets. Named materials (Teeth / BlackShiny / White / Glass
   / Hat) are caught by name first. `accessory` is the toggleable extra
   that style carries. */
export const AVATAR_MODELS = [
  {
    id: "classic", label: "经典 · 帽子",
    url: "/icons/avatar_1779855104027.glb",
    accessory: "hat",
    colorRoles: [
      { c: [0.745, 0.413, 0.141], role: "skin" },
      { c: [0.025, 0.011, 0.009], role: "hair" },
      { c: [0.913, 0.913, 0.913], role: "outfit" },
    ],
  },
  {
    id: "glasses", label: "眼镜 · 丸子头",
    url: "/icons/new-style.glb",
    accessory: "glasses",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },
      { c: [0.565, 0.021, 0.021], role: "glasses" }, // red frame
      { c: [0.010, 0.181, 0.644], role: "outfit" },  // blue top
      { c: [0.913, 0.913, 0.913], role: "outfit" },  // white bottom
    ],
  },
  {
    id: "casual", label: "休闲 · 耳机",
    url: "/icons/new-style2.glb",
    accessory: "headphones",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },       // shaggy hair
      { c: [0.119, 0.119, 0.119], role: "headphones" }, // over-ear cans
      { c: [0.054, 0.054, 0.054], role: "outfit" },     // t-shirt
      { c: [0.913, 0.913, 0.913], role: "outfit" },     // shorts
    ],
  },
  {
    // Parts source only · supplies a baseball cap, hair, and a T-shirt+shorts
    // outfit. Not offered as a body style (partsOnly) — its cap, hair, and
    // clothing are mixed onto the other bodies via the swap dimensions.
    id: "street", label: "街头 · 鸭舌帽", partsOnly: true,
    url: "/icons/new-style3.glb",
    accessory: "cap",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },   // short hair
      { c: [0.054, 0.054, 0.054], role: "outfit" }, // black tee
      { c: [0.913, 0.913, 0.913], role: "outfit" }, // white shorts + shoes
    ],
    // The cap + shorts + shoes are all white, and the only textured mesh is
    // the "deal-with-it" sunglasses (NOT a hat). Tag by geometry/texture so
    // the cap is its own accessory role and the glasses aren't mistaken for a
    // hat. (Applied on load, before colour classification.)
    partTags: [
      { role: "glasses", textured: true },                      // pixel sunglasses
      { role: "cap", color: [0.913, 0.913, 0.913], minY: 1.4 }, // white cap (above head)
    ],
  },
  {
    // Parts source only · supplies a gold crown, mid-length hair, a tie, and
    // distinct (thicker) eyebrows. Not a standalone body (partsOnly).
    id: "royal", label: "皇室 · 王冠", partsOnly: true,
    url: "/icons/new-style4.glb",
    accessory: "crown",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },   // mid-length hair
      { c: [0.054, 0.054, 0.054], role: "outfit" }, // black tee
      { c: [0.913, 0.913, 0.913], role: "outfit" }, // white shorts + shoes
    ],
    // The crown (gold + orange) sits above the head; the tie is white and
    // collides with the white shorts/shoes, so split it out by its chest-level
    // band. (Eyebrows are tagged generically by tagEyebrows.)
    partTags: [
      { role: "crown", minY: 1.9 },                                 // crown caps (above head)
      { role: "tie", color: [0.913, 0.913, 0.913], minY: 0.7, maxY: 1.3 }, // white tie at chest
    ],
  },
  {
    // Parts source only · supplies a Santa hat, long hair, pixel sunglasses
    // ("墨镜"), a bow ("蝴蝶结"), and eyebrows. Not a standalone body.
    id: "xmas", label: "圣诞 · 圣诞帽", partsOnly: true,
    url: "/icons/new-style5.glb",
    accessory: "santa",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },   // long hair
      { c: [0.054, 0.054, 0.054], role: "outfit" }, // black tee
      { c: [0.913, 0.913, 0.913], role: "outfit" }, // white shorts + shoes
    ],
    // Santa hat = red body + white pom, both above the head; the white pom is
    // named "White" (would mis-tag as eyewhite) so split it out by height. The
    // bow is a unique teal — tag it as neckwear ("tie"). The textured mesh is
    // the pixel sunglasses ("shades"), not a hat.
    partTags: [
      { role: "shades", textured: true },                       // pixel sunglasses
      { role: "santa", minY: 1.9 },                             // red + white santa hat (above head)
      { role: "tie", color: [0.074, 0.631, 0.753] },            // teal bow (neckwear)
    ],
  },
  {
    // Parts source only · supplies a top hat ("礼帽"), a low-ponytail
    // hairstyle, distinct eyes, and a sleeveless dress. Not a standalone
    // body (partsOnly).
    id: "style6", label: "礼帽 · 背心裙", partsOnly: true,
    url: "/icons/new-style6.glb",
    accessory: "tophat",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },   // long ponytail hair
      { c: [0.054, 0.054, 0.054], role: "outfit" }, // dark dress
      { c: [0.913, 0.913, 0.913], role: "outfit" }, // light dress trim
    ],
    // The top hat is the only textured mesh → tag it as its own accessory
    // role so it doesn't collide with classic's "hat". The dress's second
    // white mesh is named "White.001", which the name rule would mis-tag as
    // eyewhite (it sits at torso level, not the eyes) — force it to outfit so
    // the outfit swap carries the whole dress.
    partTags: [
      { role: "tophat", textured: true },
      { role: "outfit", name: "white" },
    ],
  },
];
/** Back-compat · the first style's GLB. */
export const DEFAULT_AVATAR_URL = AVATAR_MODELS[0].url;

const _templates = new Map();    // model.id -> normalized gltf root (clone source)
const _loadPromises = new Map(); // model.id -> in-flight load promise

function resolveModel(idOrUrl) {
  if (!idOrUrl) return AVATAR_MODELS[0];
  return AVATAR_MODELS.find((m) => m.id === idOrUrl || m.url === idOrUrl) || AVATAR_MODELS[0];
}

export function isAvatar3DReady(idOrUrl) {
  return _templates.has(resolveModel(idOrUrl).id);
}

/** Load + cache a base model. Accepts a model id ("classic"/"glasses"),
 *  a known GLB url, or nothing (→ first model). Idempotent per model. */
export function loadAvatar3D(idOrUrl) {
  const model = resolveModel(idOrUrl);
  if (_templates.has(model.id)) return Promise.resolve(_templates.get(model.id));
  if (_loadPromises.has(model.id)) return _loadPromises.get(model.id);
  const loader = new GLTFLoader();
  const p = new Promise((resolve, reject) => {
    loader.load(
      model.url,
      (gltf) => {
        const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        if (!root) { reject(new Error("GLB has no scene: " + model.url)); return; }
        root.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            o.frustumCulled = false; // skinned meshes mis-cull when posed
          }
        });
        tagEyebrows(root, model); // tag brow meshes once on the template
        tagModelParts(root, model); // model-specific mesh→role overrides (cap / glasses)
        _templates.set(model.id, root);
        resolve(root);
      },
      undefined,
      (err) => { _loadPromises.delete(model.id); reject(err); },
    );
  });
  _loadPromises.set(model.id, p);
  return p;
}

/* ── Deterministic per-seed RNG (mulberry32 over a string hash) ──────── */
function makeRng(seed) {
  let s = 0;
  const str = String(seed || "default");
  for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0xffffffff;
  };
}

/* ── Palettes (sRGB hex) ─────────────────────────────────────────────── */
const SKIN_TONES = [
  "#ffe0bd", "#f1c27d", "#e0ac69", "#c68642", "#a8703a", "#8d5524", "#5c3a21", "#f7d7b8",
];
const HAIR_COLORS = [
  "#14100d", "#241c16", "#3a2a1e", "#4a3526", "#6f4e37", "#8d6a45",
  "#b08d57", "#d8b878", "#e8cf9a", "#3a3a3a", "#6e6e6e", "#9a9a9a", "#7a3b28",
];
const OUTFIT_COLORS = [
  // Muted / professional
  "#3b5b78", "#4a6b52", "#7a4a52", "#5a4a78", "#8a6d3b", "#445a5a", "#6b3f4a", "#3f4a6b",
  "#7a5a3b", "#556070", "#6d4a78", "#2f6b5e",
  // Neutrals · black + white
  "#1a1a1a", "#f2f2f2",
  // Vivid / saturated
  "#d8392b", "#1f6fe0", "#19a974", "#e87722", "#7d3cc4", "#0fb5b5", "#e0b400", "#e23a8a",
];
// Eyebrows read as a hair-family colour, so they share the hair palette.
const BROW_COLORS = HAIR_COLORS;
// Iris / pupil colours · the GLB pupils are all the same black mesh, so the
// only eye "variety" is colour. Mostly natural (near-black → browns) plus a
// few subtle iris tints (green / blue / slate).
const EYE_COLORS = [
  "#0d0d0d", "#241c16", "#3a2a1e", "#5a3a22", "#6f4e37", "#3a5a3a", "#2f5a78", "#4a4a55",
];
export const AVATAR_PALETTES = { skin: SKIN_TONES, hair: HAIR_COLORS, outfit: OUTFIT_COLORS, brow: BROW_COLORS, tie: OUTFIT_COLORS, eye: EYE_COLORS };

/* ── Role resolution · name rules first, then per-model colour match ──── */
function colorNear(c, rgb) {
  return Math.abs(c.r - rgb[0]) < 0.03 && Math.abs(c.g - rgb[1]) < 0.03 && Math.abs(c.b - rgb[2]) < 0.03;
}
function resolveRole(m, model) {
  if (m.map) return "hat";                              // only the (textured) hat carries a map
  const name = (m.name || "").toLowerCase();
  if (/insidemouth|mouth|tongue|gum|nail/.test(name)) return "mouth";
  if (/teeth|tooth/.test(name)) return "teeth";
  if (/blackshiny/.test(name)) return "eye";
  if (/white/.test(name)) return "eyewhite";
  if (/glass/.test(name)) return "glasses";             // transparent lens
  if (/hat/.test(name)) return "hat";
  if (m.color && model && model.colorRoles) {
    for (const e of model.colorRoles) if (colorNear(m.color, e.c)) return e.role;
  }
  return "other";
}

/** Mesh-level role · a pre-set `userData.avatarRole` (e.g. eyebrows tagged
 *  on the template, or parts tagged by the swap helpers) wins over the
 *  material colour classification. Use this — not raw resolveRole — anywhere
 *  visibility/role decisions are made per mesh, so e.g. eyebrows that share
 *  the hair colour aren't mistaken for hair. */
function meshRole(o, model) {
  const pre = o.userData && o.userData.avatarRole;
  if (pre) return pre;
  const m = Array.isArray(o.material) ? o.material[0] : o.material;
  return resolveRole(m, model);
}

/** Give every mesh under `root` its OWN material clone. Templates ship SHARED
 *  material objects (e.g. classic's hair mesh and brow mesh are one material),
 *  and SkeletonUtils.clone shares those refs. Without this, painting/recolouring
 *  a built instance mutates the cached template — corrupting later builds (a
 *  re-used hair source would lose its "hair" colour classification and vanish).
 *  buildAvatar3D does this for the body; the swap helpers must do it too. */
function cloneMaterialsInPlace(root) {
  root.traverse((o) => {
    if (o.isMesh && o.material) {
      o.material = Array.isArray(o.material) ? o.material.map((x) => x.clone()) : o.material.clone();
    }
  });
}

/** Tag eyebrow meshes on a freshly-loaded template so they're treated as
 *  their own role (independently colourable, and not hidden when hair is
 *  swapped). Eyebrows are the very-dark `Color_` mesh (~[0.025,0.011,0.009])
 *  in every model. In most models the hair is a distinct lighter colour, so
 *  the single dark mesh is unambiguously the brows; in models where the hair
 *  shares that dark colour (e.g. classic), the LARGER dark mesh is the hair
 *  and the smaller one(s) are the brows. */
function tagEyebrows(root, model) {
  const BROW = [0.025, 0.011, 0.009];
  const hairEntry = (model.colorRoles || []).find((e) => e.role === "hair");
  const hairSharesBrowColor = !!hairEntry &&
    Math.abs(hairEntry.c[0] - BROW[0]) < 0.03 &&
    Math.abs(hairEntry.c[1] - BROW[1]) < 0.03 &&
    Math.abs(hairEntry.c[2] - BROW[2]) < 0.03;

  const cands = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m.map) return; // textured (hat) — never a brow
    // Exclude facial features whose near-black colour also falls inside the
    // brow tolerance — esp. the BlackShiny eyes at [0,0,0]. Match by material
    // NAME so we don't recolour eyes / mouth / teeth / sclera / lens as brows.
    const nm = (m.name || "").toLowerCase();
    if (/insidemouth|mouth|tongue|gum|nail|teeth|tooth|blackshiny|white|glass|hat/.test(nm)) return;
    if (m.color && colorNear(m.color, BROW)) {
      const size = new THREE.Vector3();
      new THREE.Box3().setFromObject(o).getSize(size);
      cands.push({ o, vol: (size.x || 1e-4) * (size.y || 1e-4) * (size.z || 1e-4) });
    }
  });
  if (!cands.length) return;
  cands.sort((a, b) => b.vol - a.vol);
  // Drop the largest dark mesh (= hair) only when hair shares the colour.
  const brows = hairSharesBrowColor ? cands.slice(1) : cands;
  for (const c of brows) c.o.userData.avatarRole = "brow";
}

/** Apply a model's explicit `partTags` (load-time mesh→role overrides) for
 *  parts that colour/name classification can't separate — e.g. a white cap
 *  that shares the shorts' colour, or sunglasses that would misfire as a hat
 *  via the textured-mesh rule. Each rule matches on `textured` (has a map),
 *  `name` (case-insensitive substring of the material name), `color`
 *  (≈ base colour), and/or a `minY`/`maxY` band on the mesh's raw
 *  bounding-box centre; the first matching rule wins. Runs after tagEyebrows. */
function tagModelParts(root, model) {
  if (!model.partTags || !model.partTags.length) return;
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    let cy = null;
    for (const rule of model.partTags) {
      if (rule.textured && !m.map) continue;
      if (rule.name && !(m.name || "").toLowerCase().includes(rule.name.toLowerCase())) continue;
      if (rule.color && !(m.color && colorNear(m.color, rule.color))) continue;
      if (rule.minY != null || rule.maxY != null) {
        if (cy == null) {
          const b = new THREE.Box3().setFromObject(o);
          cy = (b.min.y + b.max.y) / 2;
        }
        if (rule.minY != null && cy < rule.minY) continue;
        if (rule.maxY != null && cy > rule.maxY) continue;
      }
      o.userData.avatarRole = rule.role;
      break;
    }
  });
}

/* ── Per-role surface finish · base GLBs ship every material at the GLTF
   default roughness 1.0 (matte). Lowering roughness + raising
   envMapIntensity lets skin / hair / eyes catch IBL reflections (the
   gloss). Requires the host scene to set `scene.environment`. */
const FINISH = {
  skin:   { roughness: 0.48, metalness: 0.0,  envMapIntensity: 1.15 },
  hair:   { roughness: 0.30, metalness: 0.05, envMapIntensity: 1.5 },
  brow:   { roughness: 0.45, metalness: 0.0,  envMapIntensity: 0.8 },
  outfit: { roughness: 0.72, metalness: 0.0,  envMapIntensity: 0.9 },
  eye:    { roughness: 0.06, metalness: 0.0,  envMapIntensity: 1.7 },
};
function applyFinish(m, f) {
  if (typeof f.roughness === "number") m.roughness = f.roughness;
  if (typeof f.metalness === "number") m.metalness = f.metalness;
  if ("envMapIntensity" in m && typeof f.envMapIntensity === "number") m.envMapIntensity = f.envMapIntensity;
  m.needsUpdate = true;
  return m;
}

function pick(arr, rng) { return arr[Math.floor(rng() * arr.length) % arr.length]; }

/** Build a fresh, normalized avatar instance. `opts`:
 *    model      · body style id ("classic" / "glasses"), default first
 *    hairStyle  · INDEPENDENT hair dimension · a model id whose hair to
 *                 wear, or "none" (bald), or omitted (keep the body's own
 *                 hair). Cross-model hair works because both GLBs share
 *                 the same Mixamo rig → the hair re-binds to the body's
 *                 skeleton. The source hair model must be loaded first.
 *    height     · world-unit height (default 1.6)
 *    skin/hair/outfit · explicit hex overrides (else seeded from palette)
 *    accessory  · false to hide the style's hat/glasses
 *    tint       · false to keep the GLB's baked colours untouched */
export function buildAvatar3D(seed, opts = {}) {
  const model = resolveModel(opts.model);
  const template = _templates.get(model.id);
  if (!template) return null;
  const rng = makeRng(seed);
  const targetHeight = typeof opts.height === "number" ? opts.height : 1.6;

  const inst = cloneSkeleton(template);
  inst.traverse((o) => {
    if (o.isMesh && o.material) {
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
    }
  });

  inst.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inst);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const s = targetHeight / (size.y || 1);
  inst.scale.setScalar(s);
  inst.position.set(-center.x * s, -box.min.y * s, -center.z * s);

  const group = new THREE.Group();
  group.name = "avatar3d";
  group.add(inst);

  // Hair dimension · swap BEFORE painting so swapped-in hair (tagged role
  // "hair") is coloured by the same pass.
  const hairStyle = opts.hairStyle || model.id;
  if (hairStyle !== model.id) swapHair(group, inst, model, hairStyle);

  // Clothing dimension · independent of body style. `opts.outfitStyle` is
  // a model id whose clothing to wear; default / own id keeps the built-in.
  const outfitStyle = opts.outfitStyle || model.id;
  if (outfitStyle !== model.id) swapOutfitStyle(group, inst, model, outfitStyle);

  // Eyebrow-shape dimension · `opts.browStyle` is a model id whose brows to
  // wear; "default" / omitted / own id keeps the body's built-in brows.
  // Swapped BEFORE painting so the overlaid brow (role "brow") gets 眉色.
  const browStyle = opts.browStyle || "default";
  if (browStyle !== "default" && browStyle !== model.id) overlayRole(group, inst, model, browStyle, "brow");

  // Tie dimension · `opts.tieStyle` is a model id supplying a tie, or
  // "none"/omitted for no tie.
  const tieStyle = opts.tieStyle && opts.tieStyle !== "none" ? opts.tieStyle : null;
  if (tieStyle) overlayRole(group, inst, model, tieStyle, "tie");

  // Eye-shape dimension · `opts.eyeStyle` is a model id whose eyes (role
  // "eye") to wear; "default" / omitted / own id keeps the body's own eyes.
  // Overlaid BEFORE painting so the swapped-in eyes still pick up 瞳色.
  const eyeStyle = opts.eyeStyle && opts.eyeStyle !== "default" ? opts.eyeStyle : null;
  if (eyeStyle) overlayRole(group, inst, model, eyeStyle, "eye");

  // Accessory dimension · independent of body style. `opts.accessory` is a
  // style id ("none" / "glasses" / "hat"); back-compat: false → "none",
  // true / undefined → the body's own accessory.
  let accStyle = opts.accessory;
  if (accStyle === false) accStyle = "none";
  else if (accStyle === true || accStyle == null) accStyle = model.accessory || "none";
  swapAccessory(group, inst, model, accStyle);

  const colors = {
    skin: opts.skin || pick(SKIN_TONES, rng),
    hair: opts.hair || pick(HAIR_COLORS, rng),
    outfit: opts.outfit || pick(OUTFIT_COLORS, rng),
  };
  // Eyebrows default to the hair colour (natural), but are independently
  // overridable via opts.brow / the customizer's 眉色 row.
  colors.brow = opts.brow || colors.hair;
  // Neckwear (tie / bow) colour · independently adjustable (颈饰色).
  colors.tie = opts.tie || OUTFIT_COLORS[0];
  // Iris / pupil colour · defaults to near-black (the original look).
  colors.eye = opts.eye || EYE_COLORS[0];
  paintInstance(group, model, colors, opts.tint !== false);

  group.userData.avatarSeed = seed;
  group.userData.avatarModel = model.id;
  group.userData.avatarHairStyle = hairStyle;
  group.userData.avatarOutfitStyle = outfitStyle;
  group.userData.avatarBrowStyle = browStyle || "default";
  group.userData.avatarTieStyle = tieStyle || "none";
  group.userData.avatarEyeStyle = eyeStyle || "default";
  group.userData.avatarAccessory = accStyle;
  return group;
}

/** Collect a model template's hair meshes (role "hair"). */
function templateHairMeshes(model) {
  const t = _templates.get(model.id);
  if (!t) return [];
  const out = [];
  t.traverse((o) => {
    if (o.isMesh && o.material && meshRole(o, model) === "hair") out.push(o);
  });
  return out;
}

/** Replace the body's hair with another style's hair (or none).
 *
 *  We do NOT re-bind across skeletons — the two GLBs share bone *names*
 *  but not the same bind pose, so re-binding distorts the mesh. Instead
 *  we instantiate the hair model with its OWN (consistent) skeleton and
 *  overlay it at the body instance's exact transform, showing only its
 *  hair. Size is therefore always correct; head *position* aligns only as
 *  far as the two rigs' bind poses agree (good for similarly-proportioned
 *  chibis; a per-pair offset can be added if needed). `hairStyle` is a
 *  model id, or "none" to go bald. */
function swapHair(group, inst, bodyModel, hairStyle) {
  // Hide the body's own hair (brows are role "brow" → kept).
  inst.traverse((o) => {
    if (o.isMesh && o.material && meshRole(o, bodyModel) === "hair") o.visible = false;
  });
  if (hairStyle === "none") return;
  const hairModel = resolveModel(hairStyle);
  if (hairModel.id === bodyModel.id) return;
  const hairTemplate = _templates.get(hairModel.id);
  if (!hairTemplate) return; // source not loaded → stay bald rather than break

  const hairClone = cloneSkeleton(hairTemplate);
  cloneMaterialsInPlace(hairClone); // isolate from the cached template
  // Overlay at the body instance's transform so size matches the body.
  hairClone.scale.copy(inst.scale);
  hairClone.position.copy(inst.position);
  hairClone.quaternion.copy(inst.quaternion);
  hairClone.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (meshRole(o, hairModel) === "hair") {
      o.userData.avatarRole = "hair";
      o.visible = true;
    } else {
      o.visible = false; // we only want the hair from this clone
    }
  });
  group.add(hairClone);
}

/** Which model supplies each accessory (it's baked into that model). */
const ACCESSORY_SRC = { hat: "classic", glasses: "glasses", headphones: "casual", cap: "street", crown: "royal", santa: "xmas", shades: "xmas", tophat: "style6" };
const ACCESSORY_ROLES = ["hat", "glasses", "headphones", "cap", "crown", "santa", "shades", "tophat"];

/** Swap the avatar's accessory · independent of body style. Hides the
 *  body's OWN accessory, then (if `accStyle` isn't "none" and isn't the
 *  body's own) overlays it from its source model via the same sibling-
 *  clone trick as hair (size from the body transform; head fit from the
 *  shared chibi proportions). */
function swapAccessory(group, inst, bodyModel, accStyle) {
  // Show only the body's own accessory mesh that matches accStyle; hide
  // any other built-in accessory (hat / glasses) it carries.
  inst.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const r = meshRole(o, bodyModel);
    if (ACCESSORY_ROLES.includes(r)) o.visible = (r === accStyle);
  });
  if (accStyle === "none") return;
  if (bodyModel.accessory === accStyle) return; // own accessory already shown
  const srcId = ACCESSORY_SRC[accStyle];
  const srcModel = resolveModel(srcId);
  const tpl = _templates.get(srcModel.id);
  if (!tpl) return; // source not loaded → just no accessory rather than break

  const clone = cloneSkeleton(tpl);
  cloneMaterialsInPlace(clone); // isolate from the cached template
  clone.scale.copy(inst.scale);
  clone.position.copy(inst.position);
  clone.quaternion.copy(inst.quaternion);
  clone.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (meshRole(o, srcModel) === accStyle) {
      o.userData.avatarRole = accStyle;
      o.visible = true;
    } else {
      o.visible = false; // only borrow the accessory from this clone
    }
  });
  group.add(clone);
}

/** Swap the avatar's clothing · independent of body style. `outfitStyle`
 *  is a model id whose outfit (role "outfit") meshes get borrowed. Same
 *  sibling-clone overlay as hair / accessory: hide the body's own outfit,
 *  then overlay the source model's outfit at the body transform. Passing
 *  the body's own id (or null) keeps the built-in clothing. */
function swapOutfitStyle(group, inst, bodyModel, outfitStyle) {
  if (!outfitStyle || outfitStyle === bodyModel.id) return; // keep own clothing
  const srcModel = resolveModel(outfitStyle);
  const tpl = _templates.get(srcModel.id);
  if (!tpl) return; // source not loaded → keep own rather than go nude

  // Hide the body's own outfit only once we know we can replace it.
  inst.traverse((o) => {
    if (o.isMesh && o.material && meshRole(o, bodyModel) === "outfit") o.visible = false;
  });

  const clone = cloneSkeleton(tpl);
  cloneMaterialsInPlace(clone); // isolate from the cached template
  clone.scale.copy(inst.scale);
  clone.position.copy(inst.position);
  clone.quaternion.copy(inst.quaternion);
  clone.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (meshRole(o, srcModel) === "outfit") {
      o.userData.avatarRole = "outfit";
      o.visible = true;
    } else {
      o.visible = false; // only borrow the clothing from this clone
    }
  });
  group.add(clone);
}

/** Generic single-role overlay · hide the body's own meshes of `role`, then
 *  overlay that role's meshes from `srcModelId` via the same sibling-clone
 *  trick (size from the body transform). Used by the eyebrow + tie dimensions.
 *  `srcModelId` === the body's id (or null) keeps the body's own part. */
function overlayRole(group, inst, bodyModel, srcModelId, role) {
  if (!srcModelId || srcModelId === bodyModel.id) return; // keep own
  const srcModel = resolveModel(srcModelId);
  const tpl = _templates.get(srcModel.id);
  if (!tpl) return; // source not loaded → keep own rather than break

  inst.traverse((o) => {
    if (o.isMesh && o.material && meshRole(o, bodyModel) === role) o.visible = false;
  });

  const clone = cloneSkeleton(tpl);
  cloneMaterialsInPlace(clone); // isolate from the cached template
  clone.scale.copy(inst.scale);
  clone.position.copy(inst.position);
  clone.quaternion.copy(inst.quaternion);
  clone.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (meshRole(o, srcModel) === role) {
      o.userData.avatarRole = role;
      o.visible = true;
    } else {
      o.visible = false; // only borrow this role from the clone
    }
  });
  group.add(clone);
}

/** Single colour/finish pass. Respects a pre-set `userData.avatarRole`
 *  (set by swapHair / swapAccessory on overlaid cross-model parts, whose
 *  material colour won't match the body model's role map). Visibility of
 *  hair / accessory is owned by the swap helpers, not here. */
function paintInstance(inst, model, colors, doTint) {
  inst.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const pre = o.userData && o.userData.avatarRole;
    let role = pre || "other";
    const out = mats.map((m) => {
      const r = pre || resolveRole(m, model);
      if (r !== "other") role = r;
      if (doTint) {
        if (r === "skin")   { m.color.set(colors.skin);   return applyFinish(m, FINISH.skin); }
        if (r === "hair")   { m.color.set(colors.hair);   return applyFinish(m, FINISH.hair); }
        if (r === "brow")   { m.color.set(colors.brow);   return applyFinish(m, FINISH.brow); }
        if (r === "tie")    { m.color.set(colors.tie);    return applyFinish(m, FINISH.outfit); }
        if (r === "outfit") { m.color.set(colors.outfit); return applyFinish(m, FINISH.outfit); }
        if (r === "eye")    { m.color.set(colors.eye);    return applyFinish(m, FINISH.eye); }
      }
      return m; // teeth / mouth / eyewhite / glasses / hat / other → untouched
    });
    o.material = Array.isArray(o.material) ? out : out[0];
    if (!pre) o.userData.avatarRole = role; // don't clobber swap tags
  });
}

/** Hair styles offered by the customizer · one per loaded model GLB, plus
 *  "none". Each id maps to the model whose hair to borrow. */
export const HAIR_STYLES = [
  { id: "classic", label: "短发" },
  { id: "glasses", label: "丸子头" },
  { id: "casual", label: "蓬松/乱发" },
  { id: "street", label: "街头短发" },
  { id: "royal", label: "中长发/刘海" },
  { id: "xmas", label: "披肩长发" },
  { id: "style6", label: "低马尾" },
  { id: "none", label: "无 (光头)" },
];

/** Eyebrow-shape dimension · "default" keeps the body's own brows; each model
 *  id overlays that model's brow mesh (role "brow"), still tinted by 眉色. */
export const BROW_STYLES = [
  { id: "default", label: "默认" },
  { id: "royal", label: "浓眉" },
  { id: "xmas", label: "自然眉" },
];

/** Neckwear dimension · independent toggle (overlaid from its source, role
 *  "tie"): a tie or a bow. */
export const TIE_STYLES = [
  { id: "none", label: "无" },
  { id: "royal", label: "领带" },
  { id: "xmas", label: "蝴蝶结" },
];

/** Eye-shape dimension · "default" keeps the body's own eyes; each model id
 *  overlays that model's eye mesh (role "eye"), still tinted by 瞳色. The
 *  pupil COLOUR is a separate dimension (AVATAR_PALETTES.eye). */
export const EYE_STYLES = [
  { id: "default", label: "默认" },
  { id: "style6", label: "圆亮眼" },
];

/** Clothing styles offered by the customizer · an independent dimension.
 *  Each id is a model whose outfit (role "outfit") is overlaid onto the
 *  body. The body's own clothing is the default for each style. */
export const OUTFIT_STYLES = [
  { id: "classic", label: "西装" },
  { id: "glasses", label: "蓝白校园" },
  { id: "casual", label: "T恤短裤" },
  { id: "street", label: "黑T短裤·街头" },
  { id: "style6", label: "背心裙" },
];

/** Accessory styles offered by the customizer · an independent dimension.
 *  Each (non-"none") id is overlaid from its source model. */
export const ACCESSORY_STYLES = [
  { id: "none", label: "无" },
  { id: "glasses", label: "眼镜" },
  { id: "shades", label: "墨镜" },
  { id: "hat", label: "帽子" },
  { id: "headphones", label: "耳机" },
  { id: "cap", label: "鸭舌帽" },
  { id: "crown", label: "王冠" },
  { id: "santa", label: "圣诞帽" },
  { id: "tophat", label: "礼帽" },
];

/** Live-recolour an existing avatar Group without rebuilding (customizer
 *  instant feedback). `colors` is a partial `{ skin, hair, brow, outfit, tie, eye }`. */
export function recolorAvatar(group, colors = {}) {
  if (!group) return;
  group.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const hex = colors[o.userData && o.userData.avatarRole];
    if (!hex) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m.color) m.color.set(hex);
  });
}

/** Deterministic per-seed default avatar config · the same `seed` always
 *  yields the same look. Used so an un-customized director shows an
 *  identical, distinct avatar in BOTH the editor and the voice room (the
 *  room and editor MUST call this with the same seed, e.g. the director id).
 *  Returns the persisted config shape `{model,hairStyle,outfitStyle,
 *  accessory,skin,hair,brow,outfit}`. Brows default to the hair colour. */
export function deriveDefaultAvatarConfig(seed) {
  const rng = makeRng("av3d:" + String(seed == null ? "default" : seed));
  const pickId = (list) => list[Math.floor(rng() * list.length) % list.length].id;
  // Only full bodies can be the base model · `partsOnly` entries (e.g. the
  // street cap/outfit source) contribute parts but aren't standalone bodies.
  const bodies = AVATAR_MODELS.filter((m) => !m.partsOnly);
  const model = bodies[Math.floor(rng() * bodies.length) % bodies.length];
  const hairChoices = HAIR_STYLES.filter((h) => h.id !== "none"); // not bald by default
  const hair = pick(HAIR_COLORS, rng);
  return {
    model: model.id,
    hairStyle: hairChoices[Math.floor(rng() * hairChoices.length) % hairChoices.length].id,
    outfitStyle: pickId(OUTFIT_STYLES),
    accessory: pickId(ACCESSORY_STYLES),
    browStyle: "default", // keep the body's own brows by default
    tieStyle: "none",     // no tie by default
    eyeStyle: "default",  // keep the body's own eyes by default
    skin: pick(SKIN_TONES, rng),
    hair,
    brow: hair,
    outfit: pick(OUTFIT_COLORS, rng),
    tie: pick(OUTFIT_COLORS, rng), // neckwear colour (only shows when a tie/bow is on)
    eye: pick(EYE_COLORS, rng),    // iris / pupil colour
  };
}

/** Reliable face mesh roles · used by getFaceBox to compute a head-
 *  anchor for portrait framing. Stays head-only: ear/eyewhite/shoes
 *  / etc. would drag the box to the wrong region. */
const FACE_ROLES = ["eye", "brow", "mouth", "teeth"];

/** Compute the world-space bounding box of the avatar's face mesh
 *  set (eye / brow / mouth / teeth). Used by `applyFaceFraming` to
 *  anchor head-and-shoulders portraits at a consistent zoom across
 *  hairstyles / accessories — the avatar's total height (with hats
 *  or crowns) varies, but the face doesn't. Returns null when no
 *  face roles are present (e.g. body still building). */
export function getFaceBox(group) {
  if (!group) return null;
  group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  let any = false;
  group.traverse((o) => {
    if (o.isMesh && o.visible && o.userData && FACE_ROLES.includes(o.userData.avatarRole)) {
      box.expandByObject(o);
      any = true;
    }
  });
  return any ? box : null;
}

/** Position `cam` for a consistent head-and-shoulders portrait of
 *  `group`. Used by the avatar-customizer's `capturePng` + by the
 *  new-agent composer's "hire a known mind" cards + anywhere else
 *  the app needs a face-anchored portrait. The TOP / BOTTOM
 *  multipliers are in units of face height; verified across every
 *  preset look. Fallback (no face mesh) lands a reasonable upper-
 *  body crop so the caller still gets something usable. */
export function applyFaceFraming(cam, group) {
  const face = getFaceBox(group);
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

/** Toggle a part by role · "hat", "glasses" (frame + lens), or "headphones". */
export function setAvatarPartVisible(group, part, visible) {
  if (!group) return;
  group.traverse((o) => {
    if (o.isMesh && o.userData && o.userData.avatarRole === part) o.visible = !!visible;
  });
}

if (typeof window !== "undefined") {
  window.Avatar3D = {
    loadAvatar3D, buildAvatar3D, isAvatar3DReady, recolorAvatar, setAvatarPartVisible,
    deriveDefaultAvatarConfig,
    getFaceBox, applyFaceFraming,
    DEFAULT_AVATAR_URL, AVATAR_MODELS, AVATAR_PALETTES, HAIR_STYLES, OUTFIT_STYLES, ACCESSORY_STYLES,
    BROW_STYLES, TIE_STYLES, EYE_STYLES,
  };
}
