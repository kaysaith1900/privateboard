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
    // The blue mesh is actually a one-piece uniform that spans torso AND
    // legs (raw y=0.18..0.85), so it's tagged "top" only — there's no
    // separable bottom on this body. The "white" mesh sits at feet level
    // (raw y=0.00..0.14) and is the shoe mesh, NOT shorts — it's tagged
    // "shoes" so picking glasses in BOTTOM_STYLES wouldn't put white at
    // ankle level.
    id: "glasses", label: "眼镜 · 丸子头",
    // The blue one-piece uniform spans torso → legs · when worn as a TOP on
    // another body it covers the hip/leg region, so a separate bottom would
    // only clip through it (see `coversBottom` handling in buildAvatar3D).
    coversBottom: true,
    url: "/avatars/models/glasses.glb",
    accessory: "glasses",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },
      { c: [0.565, 0.021, 0.021], role: "glasses" }, // red frame
      { c: [0.010, 0.181, 0.644], role: "top" },     // blue one-piece uniform
      { c: [0.913, 0.913, 0.913], role: "bottom" },  // small white floor mesh (shoes)
    ],
  },
  {
    id: "casual", label: "休闲 · 耳机",
    url: "/avatars/models/casual.glb",
    accessory: "headphones",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },       // shaggy hair
      { c: [0.119, 0.119, 0.119], role: "headphones" }, // over-ear cans
      { c: [0.054, 0.054, 0.054], role: "top" },        // t-shirt
      { c: [0.913, 0.913, 0.913], role: "bottom" },     // shorts
    ],
  },
  {
    // Parts source only · supplies a baseball cap, hair, and a T-shirt+shorts
    // outfit. Not offered as a body style (partsOnly) — its cap, hair, and
    // clothing are mixed onto the other bodies via the swap dimensions.
    id: "street", label: "街头 · 鸭舌帽", partsOnly: true,
    url: "/avatars/models/street.glb",
    accessory: "cap",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },   // short hair
      { c: [0.054, 0.054, 0.054], role: "top" },    // black tee
      { c: [0.913, 0.913, 0.913], role: "bottom" }, // white shorts + shoes
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
    url: "/avatars/models/royal.glb",
    accessory: "crown",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },   // mid-length hair
      { c: [0.054, 0.054, 0.054], role: "top" },    // black tee
      { c: [0.913, 0.913, 0.913], role: "bottom" }, // white shorts + shoes
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
    url: "/avatars/models/xmas.glb",
    accessory: "santa",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },   // long hair
      { c: [0.054, 0.054, 0.054], role: "top" },    // black tee
      { c: [0.913, 0.913, 0.913], role: "bottom" }, // white shorts + shoes
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
    // hairstyle, distinct eyes, and a sleeveless dress. The dress is a single
    // piece spanning torso + thighs — tagged entirely as "top" since it can't
    // be cleanly split at the waist. Not offered in BOTTOM_STYLES.
    id: "style6", label: "礼帽 · 背心裙", partsOnly: true,
    // The pinafore dress spans torso → thighs · worn as a top it covers the
    // hip region, so white shorts under it would clip through (see
    // `coversBottom` handling in buildAvatar3D — the bottom is suppressed).
    coversBottom: true,
    url: "/avatars/models/dress.glb",
    accessory: "tophat",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },   // long ponytail hair
      { c: [0.054, 0.054, 0.054], role: "top" },    // dark dress body
      { c: [0.913, 0.913, 0.913], role: "top" },    // dress trim
    ],
    // The top hat is the only textured mesh → tag it as its own accessory
    // role so it doesn't collide with classic's "hat". The dress's second
    // white mesh is named "White.001", which the name rule would mis-tag as
    // eyewhite (it sits at torso level, not the eyes) — keep it as "top".
    partTags: [
      { role: "tophat", textured: true },
      { role: "top", name: "white" },
    ],
  },
  {
    // Parts source only · side-parted short hair, calm closed-eye expression,
    // a teal long-sleeve top + white shorts, and a wine cloth face mask.
    // Not a standalone body (partsOnly).
    id: "style7", label: "口罩 · 长袖", partsOnly: true,
    url: "/avatars/models/mask.glb",
    accessory: "mask",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },   // short side-parted hair
      { c: [0.000, 0.117, 0.127], role: "top" },    // teal long-sleeve top
    ],
    // The wine cloth mask gets its own accessory role. For the bottom, only
    // claim the UPPER white mesh (the actual shorts at cy≈0.40); the lower
    // white sock cuffs (cy≈0.09) and the Wood.001 sandal sole (cy≈0.03)
    // would otherwise tag as "bottom" too and render as floating brown
    // rings around the ankles when this outfit gets overlaid on another
    // body whose bind pose doesn't match. Those low meshes drop to "other"
    // → not painted, not borrowed in the overlay.
    partTags: [
      { role: "mask", color: [0.543, 0.251, 0.367] },
      { role: "bottom", color: [0.913, 0.913, 0.913], minY: 0.2 },
    ],
  },
  {
    // Parts source only · brown bear-suit onesie, dark "blindfold" glasses
    // band, dark beard + matching brows, yellow star face decals. The suit
    // is a one-piece (textured "Bear" white) — tagged entirely as "top",
    // not offered in BOTTOM_STYLES. `hasBeard:true` tells tagEyebrows to
    // split the two dark meshes into beard (larger, lower) + brow (smaller).
    id: "style8", label: "熊熊 · 络腮胡", partsOnly: true,
    hasBeard: true,
    // One-piece suit that encloses the legs · when worn as a top it must
    // suppress the bottom (otherwise the previous shorts/pants clip through
    // the suit at the legs). See the `fullBody` handling in buildAvatar3D.
    fullBody: true,
    url: "/avatars/models/bear.glb",
    accessory: "blindfold",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" }, // short hair under the hood
    ],
    // Both textured meshes would auto-classify as "hat" via the textured
    // rule — claim them explicitly. The bear suit is the white textured
    // "Bear" mesh → tag as "top". The dark textured "Color_.001" is the
    // glasses / eye band → tag as "blindfold" (its own accessory role). The
    // yellow stars are decals → tag as "star" (also accessory).
    partTags: [
      // The bear suit keeps its baked white fur · noPaint so the top-colour
      // picker (and recolorAvatar) don't tint the costume off its own look.
      { role: "top", textured: true, color: [1.0, 1.0, 1.0], noPaint: true },
      { role: "blindfold", textured: true, color: [0.054, 0.054, 0.054] },
      { role: "star", color: [1.0, 0.637, 0.0] },
    ],
  },
  {
    // Parts source only · short side hair on a bald top, handlebar mustache
    // (+ small chin beard), red anger marks on the temple, a grey high-
    // waisted jumpsuit that reads as "long pants" (the mesh actually
    // extends from thighs up to mid-torso, so it isn't separable into a
    // distinct shirt + pants), white sock cuffs at the ankles, and a
    // wood-tone shoe sole. The white + wood meshes together form the
    // shoes layer. `hasBeard:true` splits the two dark (brow-coloured)
    // meshes into beard (larger handlebar) + brow.
    id: "style9", label: "络腮胡 · 长裤", partsOnly: true,
    hasBeard: true,
    url: "/avatars/models/mustache.glb",
    accessory: "anger",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" },   // short side hair
      { c: [0.527, 0.527, 0.527], role: "bottom" }, // grey jumpsuit (legs + low torso)
    ],
    // Red anger marks → their own accessory role. The white sock cuffs
    // (cy≈0.37 / 0.09) and the Wood.001 sandal sole (cy≈0.03) are
    // deliberately NOT tagged "bottom": their geometry is shaped for
    // style9's bind pose and renders as floating brown bands around the
    // ankles when overlaid on a different body. They drop to "other" →
    // not painted, not borrowed in the swap. The clean grey jumpsuit is
    // the single piece the bottom-swap carries.
    partTags: [
      { role: "anger", color: [0.816, 0.031, 0.031] },
    ],
  },
  {
    // Parts source only · pikachu onesie. The yellow textured "Pika"
    // costume + black "BlackMatt" tail / ear-tips form the body suit
    // (both marked noPaint so the costume stays its baked yellow + black
    // regardless of the top-colour picker). Red cheek dots are a
    // separate accessory role ("redcheek"). Short brown hair under the
    // hood, plus a small dark mustache split out via tagModelParts'
    // sizeYMax matcher (the larger dark mesh is the brows; the
    // smaller-volume one is the mustache → "beard").
    id: "style10", label: "皮卡丘 · 黄外衣", partsOnly: true,
    // One-piece pikachu suit that encloses the legs · suppresses the bottom
    // when worn as a top (see `fullBody` handling in buildAvatar3D).
    fullBody: true,
    url: "/avatars/models/pikachu.glb",
    accessory: "redcheek",
    colorRoles: [
      { c: [0.913, 0.565, 0.376], role: "skin" },
      { c: [0.147, 0.076, 0.031], role: "hair" }, // short brown hair under the hood
    ],
    partTags: [
      { role: "top", textured: true, color: [1.0, 1.0, 1.0], noPaint: true }, // Pika yellow body
      { role: "top", name: "blackmatt", noPaint: true },                      // tail + ear tips
      { role: "redcheek", color: [0.816, 0.031, 0.031] },                     // red cheek dots
      // The mustache and the brows share the same dark colour AND
      // similar (small) Y spans — they're only separated by position.
      // Raw centroid Y: brows ≈ 1.84 (forehead), mustache ≈ 1.51
      // (mouth). A maxY threshold of 1.7 claims only the mustache as
      // beard; the brow mesh stays for tagEyebrows to pick up.
      { role: "beard", color: [0.025, 0.011, 0.009], maxY: 1.7 },
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
        // tagModelParts FIRST so explicit partTag rules (e.g. style8's
        // textured bear suit → "top", textured "Color_.001" → "blindfold")
        // pre-claim meshes BEFORE colour classification + tagEyebrows run.
        // tagEyebrows then skips any mesh whose role is already set.
        tagModelParts(root, model);
        tagEyebrows(root, model);
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
export const AVATAR_PALETTES = {
  skin: SKIN_TONES, hair: HAIR_COLORS, brow: BROW_COLORS, eye: EYE_COLORS,
  // Outfit-related palettes all share OUTFIT_COLORS (same swatches for
  // shirts, pants, ties, beards, and the legacy combined "outfit" entry).
  top: OUTFIT_COLORS, bottom: OUTFIT_COLORS, tie: OUTFIT_COLORS,
  // Beard tints from the hair palette so it reads as a hair-family colour.
  beard: BROW_COLORS,
  // Legacy alias kept for any caller still reading `palettes.outfit`.
  outfit: OUTFIT_COLORS,
};

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
 *  and the smaller one(s) are the brows.
 *
 *  When `model.hasBeard` is true, the model has both brow + beard meshes
 *  sharing the same dark colour — the LARGEST candidate is the beard (chin
 *  whiskers are geometrically much bigger than eyebrows) and the rest are
 *  brows. Beard becomes its own role so it's tinted by 胡子色 and not hidden
 *  by hair swaps.
 *
 *  Runs AFTER tagModelParts, so it skips any mesh whose role is already
 *  claimed by a partTag rule. */
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
    // Skip meshes already claimed by tagModelParts.
    if (o.userData && o.userData.avatarRole) return;
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
  let brows = hairSharesBrowColor ? cands.slice(1) : cands;
  // Models with a beard split the largest remaining dark mesh off as "beard".
  if (model.hasBeard && brows.length > 0) {
    brows[0].o.userData.avatarRole = "beard";
    brows = brows.slice(1);
  }
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
    // Facial-feature materials should never be retagged by partTag rules ·
    // their near-black colours (BlackShiny eyes [0,0,0], InsideMouth
    // [0.031,0,0.001]) drift into the brow-colour tolerance and silently
    // hijack rules like style10's mustache (`color:[0.025,...]`) →
    // mouth + eyes end up in the beard overlay. "white"-named meshes
    // intentionally stay open here because some models name dress trims
    // / clothing "White.001" (style6).
    const nm = (m.name || "").toLowerCase();
    if (/insidemouth|mouth|tongue|gum|nail|teeth|tooth|blackshiny|glass/.test(nm)) return;
    let cy = null;
    let sy = null; // bbox y span cache
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
      if (rule.sizeYMin != null || rule.sizeYMax != null) {
        if (sy == null) {
          const b = new THREE.Box3().setFromObject(o);
          sy = b.max.y - b.min.y;
        }
        if (rule.sizeYMin != null && sy < rule.sizeYMin) continue;
        if (rule.sizeYMax != null && sy > rule.sizeYMax) continue;
      }
      o.userData.avatarRole = rule.role;
      // `noPaint:true` pins the mesh's baked colour/texture · paintInstance
      // honours `avatarColorLocked` and skips the role-keyed material.color
      // set. Used for textured costumes (e.g. style10 Pikachu) where the
      // texture pattern IS the look and any tint would muddy it.
      if (rule.noPaint) o.userData.avatarColorLocked = true;
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
  beard:  { roughness: 0.45, metalness: 0.0,  envMapIntensity: 0.85 },
  outfit: { roughness: 0.72, metalness: 0.0,  envMapIntensity: 0.9 },
  top:    { roughness: 0.72, metalness: 0.0,  envMapIntensity: 0.9 },
  // The bottom (white shorts) is pushed back in the depth buffer so that where
  // it overlaps a cross-model top at the waist, the top wins and hides the
  // shorts' protruding band — fixes shorts clipping through the shirt without
  // moving geometry (which would risk exposing skin / poking legs out). Only
  // masks small overlaps; a top that should fully cover the bottom uses
  // `coversBottom` instead.
  bottom: { roughness: 0.72, metalness: 0.0,  envMapIntensity: 0.9, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 6 },
  // Eyes were near-mirror (roughness 0.06 · envMap 1.7), which washed the iris
  // albedo out with reflection — dark colours (#0d0d0d/#241c16/#3a2a1e) all
  // read as the same glossy black, so picking the dark browns looked like a
  // no-op. Softer + less env reflection lets the iris colour actually show,
  // while a low-ish roughness keeps a small catch-light.
  eye:    { roughness: 0.25, metalness: 0.0,  envMapIntensity: 0.9 },
};
function applyFinish(m, f) {
  if (typeof f.roughness === "number") m.roughness = f.roughness;
  if (typeof f.metalness === "number") m.metalness = f.metalness;
  if ("envMapIntensity" in m && typeof f.envMapIntensity === "number") m.envMapIntensity = f.envMapIntensity;
  // Optional depth-bias · lets a layer (e.g. the bottom under a cross-model
  // top) lose the depth test where it overlaps so the outer layer covers it.
  if (f.polygonOffset) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = f.polygonOffsetFactor || 0;
    m.polygonOffsetUnits = f.polygonOffsetUnits || 0;
  }
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

  // Clothing dimensions · split into independent top (上衣) + bottom (裤子)
  // overlays. `opts.topStyle` / `opts.bottomStyle` are model ids; "default"
  // / own id keeps the body's own. Legacy `opts.outfitStyle` (single combined
  // dimension, kept for old saved configs) falls through to BOTH when the
  // newer fields are absent.
  const legacyOutfit = opts.outfitStyle;
  // A full-body COSTUME (bear / pikachu onesie) is chosen from the accessory
  // dimension now, not the top dimension. When one is selected it overrides
  // the top and renders as a hooded full-body suit. The legacy path where
  // these were `topStyle`s still resolves (old saves / the voice room).
  const costumeTop = (typeof opts.accessory === "string") ? COSTUME_TOPS[opts.accessory] : undefined;
  const topStyle = (opts.topStyle && opts.topStyle !== "default") ? opts.topStyle
                 : (legacyOutfit && legacyOutfit !== "default") ? legacyOutfit
                 : model.id;
  const effectiveTop = costumeTop || topStyle;
  if (effectiveTop !== model.id) overlayRole(group, inst, model, effectiveTop, "top");
  const bottomStyle = (opts.bottomStyle && opts.bottomStyle !== "default") ? opts.bottomStyle
                    : (legacyOutfit && legacyOutfit !== "default") ? legacyOutfit
                    : model.id;
  // When an OVERLAID top extends over the hip/leg region — a full-body onesie
  // (`fullBody`), the one-piece uniform, or the dress (`coversBottom`) — a
  // separate bottom only clips through it, so suppress the bottom. A hooded
  // onesie (`fullBody`) also encloses the head, so suppress the hair too
  // (otherwise the chosen hairstyle pokes through the hood). Traverse the
  // whole group so a swapped-in hair clone (sibling of `inst`) is caught too.
  const topSrc = effectiveTop !== model.id ? resolveModel(effectiveTop) : null;
  const topCoversBottom = !!topSrc && (topSrc.fullBody || topSrc.coversBottom);
  const topCoversHead = !!topSrc && topSrc.fullBody;
  if (topCoversBottom) {
    group.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const r = meshRole(o, model);
      if (r === "bottom" || (topCoversHead && r === "hair")) o.visible = false;
    });
  } else if (bottomStyle !== model.id) {
    overlayRole(group, inst, model, bottomStyle, "bottom");
  }

  // Eyebrow-shape dimension · `opts.browStyle` is a model id whose brows to
  // wear; "default" / omitted / own id keeps the body's built-in brows.
  // Swapped BEFORE painting so the overlaid brow (role "brow") gets 眉色.
  const browStyle = opts.browStyle || "default";
  if (browStyle !== "default" && browStyle !== model.id) overlayRole(group, inst, model, browStyle, "brow");

  // Eye-shape dimension · `opts.eyeStyle` is a model id whose eyes (role "eye",
  // the dark BlackShiny pupils) to wear; "default"/omitted/own id keeps the
  // body's built-in eyes. Only the eye mesh is borrowed — the sclera/eyewhite
  // stays the body's own. Overlaid BEFORE painting so the borrowed eye still
  // gets 瞳色.
  const eyeStyle = opts.eyeStyle || "default";
  if (eyeStyle !== "default" && eyeStyle !== model.id) {
    overlayRole(group, inst, model, eyeStyle, "eye");
    // Solid beady eyes carry no sclera · hide the body's face eyewhite so it
    // doesn't poke out around the smaller pupils. The midY guard skips any
    // foot-level mesh that resolves to "eyewhite" by a white material name.
    if (EYE_HIDE_SCLERA.has(eyeStyle)) {
      inst.updateMatrixWorld(true);
      const ebox = new THREE.Box3().setFromObject(inst);
      const midY = (ebox.min.y + ebox.max.y) / 2;
      inst.traverse((o) => {
        if (!o.isMesh || !o.material || meshRole(o, model) !== "eyewhite") return;
        const b = new THREE.Box3().setFromObject(o);
        if ((b.min.y + b.max.y) / 2 > midY) o.visible = false;
      });
    }
  }

  // Beard-shape dimension · `opts.beardStyle` is a model id supplying a
  // beard (role "beard"), or "none" / omitted for no beard. Only models
  // with `hasBeard:true` actually carry a beard mesh; selecting one that
  // doesn't is a no-op.
  const beardStyle = opts.beardStyle && opts.beardStyle !== "none" ? opts.beardStyle : null;
  if (beardStyle) overlayRole(group, inst, model, beardStyle, "beard");

  // Tie dimension · `opts.tieStyle` is a model id supplying a tie, or
  // "none"/omitted for no tie.
  const tieStyle = opts.tieStyle && opts.tieStyle !== "none" ? opts.tieStyle : null;
  if (tieStyle) overlayRole(group, inst, model, tieStyle, "tie");

  // Accessory dimension · independent of body style. `opts.accessory` is a
  // style id ("none" / "glasses" / "hat"); back-compat: false → "none",
  // true / undefined → the body's own accessory.
  let accStyle = opts.accessory;
  if (accStyle === false) accStyle = "none";
  else if (accStyle === true || accStyle == null) accStyle = model.accessory || "none";
  // A costume (bear / pikachu) IS the whole outfit, not a small accessory ·
  // it's already rendered as the top above, so don't also run the accessory
  // swap for it — clear any body accessory instead. The logical selection is
  // still stored in userData below so it round-trips.
  swapAccessory(group, inst, model, costumeTop ? "none" : accStyle);
  // A face mask covers the mouth / chin · hide the beard so its (3D, voluminous)
  // whiskers don't poke through the mask cloth. Traverse the whole group so an
  // overlaid beard clone (sibling of `inst`) is caught too.
  if (!costumeTop && accStyle === "mask") {
    group.traverse((o) => {
      if (o.isMesh && o.material && meshRole(o, model) === "beard") o.visible = false;
    });
  }
  const colors = {
    skin: opts.skin || pick(SKIN_TONES, rng),
    hair: opts.hair || pick(HAIR_COLORS, rng),
  };
  // Top / bottom colours · independently adjustable (上衣色 / 裤子色).
  // Legacy `opts.outfit` (single combined colour) falls through to both.
  colors.top    = opts.top    || opts.outfit || pick(OUTFIT_COLORS, rng);
  colors.bottom = opts.bottom || opts.outfit || pick(OUTFIT_COLORS, rng);
  // Eyebrows default to the hair colour (natural), but are independently
  // overridable via opts.brow / the customizer's 眉色 row.
  colors.brow = opts.brow || colors.hair;
  // Beard tints with its own colour · defaults to the brow colour so a model
  // that has a beard but no explicit colour still looks coherent.
  colors.beard = opts.beard || colors.brow;
  // Neckwear (tie / bow) colour · independently adjustable (颈饰色).
  colors.tie = opts.tie || OUTFIT_COLORS[0];
  // Iris / pupil colour · defaults to near-black (the original look).
  colors.eye = opts.eye || EYE_COLORS[0];
  paintInstance(group, model, colors, opts.tint !== false);

  group.userData.avatarSeed = seed;
  group.userData.avatarModel = model.id;
  group.userData.avatarHairStyle = hairStyle;
  group.userData.avatarTopStyle = topStyle;
  group.userData.avatarBottomStyle = bottomStyle;
  group.userData.avatarBrowStyle = browStyle || "default";
  group.userData.avatarEyeStyle = eyeStyle || "default";
  group.userData.avatarBeardStyle = beardStyle || "none";
  group.userData.avatarTieStyle = tieStyle || "none";
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
const ACCESSORY_SRC = { glasses: "glasses", headphones: "casual", cap: "street", crown: "royal", santa: "xmas", shades: "xmas", tophat: "style6", mask: "style7", blindfold: "style8", star: "style8", anger: "style9", redcheek: "style10" };
const ACCESSORY_ROLES = ["glasses", "headphones", "cap", "crown", "santa", "shades", "tophat", "mask", "blindfold", "star", "anger", "redcheek"];
/** Flat face decals (blush / anger marks / star) borrowed cross-model · they
 *  sit right on the cheek/temple, so a slightly different bind pose buries them
 *  in the face and they clip through. A negative depth-bias renders them on
 *  top of the face surface (see swapAccessory) without moving geometry. */
const FACE_DECAL_ACCESSORIES = new Set(["anger", "star"]);
/** Full-body COSTUMES offered in the accessory dimension · each maps to the
 *  model whose full-body suit (role "top", `fullBody`) to wear. Selecting one
 *  overrides the top + suppresses the bottom & hair (see buildAvatar3D). */
export const COSTUME_TOPS = { bearsuit: "style8", pikasuit: "style10" };

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
  const decal = FACE_DECAL_ACCESSORIES.has(accStyle);
  // A cap sits on the scalp and hair bulges through its dome · bias the cap
  // toward the camera so it covers the intersecting hair (keeping the hair
  // visible at the sides / back / under the brim, unlike hiding it). Lighter
  // bias than the face decals so front hair isn't swallowed.
  const cap = accStyle === "cap";
  clone.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (meshRole(o, srcModel) === accStyle) {
      o.userData.avatarRole = accStyle;
      o.visible = true;
      // Depth-bias toward the camera · flat face decals win against the face,
      // the cap wins against the hair it intersects.
      if (decal || cap) {
        o.renderOrder = 5;
        const factor = decal ? -8 : -4;
        const units = decal ? -40 : -16;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          m.polygonOffset = true;
          m.polygonOffsetFactor = factor;
          m.polygonOffsetUnits = units;
          m.needsUpdate = true;
        }
      }
    } else {
      o.visible = false; // only borrow the accessory from this clone
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
      // Colour-locked meshes (partTag noPaint:true) preserve their baked
      // texture / colour even when their role would normally take a paint
      // pass. The role tag still rides so overlay visibility still works.
      const colorLocked = o.userData && o.userData.avatarColorLocked;
      if (colorLocked) return m;
      if (doTint) {
        if (r === "skin")   { m.color.set(colors.skin);   return applyFinish(m, FINISH.skin); }
        if (r === "hair")   { m.color.set(colors.hair);   return applyFinish(m, FINISH.hair); }
        if (r === "brow")   { m.color.set(colors.brow);   return applyFinish(m, FINISH.brow); }
        if (r === "beard")  { m.color.set(colors.beard);  return applyFinish(m, FINISH.beard); }
        if (r === "tie")    { m.color.set(colors.tie);    return applyFinish(m, FINISH.outfit); }
        if (r === "top")    { m.color.set(colors.top);    return applyFinish(m, FINISH.top); }
        if (r === "bottom") { m.color.set(colors.bottom); return applyFinish(m, FINISH.bottom); }
        // Legacy `outfit` role · should no longer appear on freshly-built
        // avatars (all current models tag top/bottom), but if a stale config
        // somehow keeps a mesh on that role just tint with the top colour.
        if (r === "outfit") { m.color.set(colors.top);    return applyFinish(m, FINISH.outfit); }
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
  { id: "glasses", label: "丸子头" },
  { id: "casual", label: "蓬松/乱发" },
  { id: "street", label: "街头短发" },
  { id: "royal", label: "中长发/刘海" },
  { id: "xmas", label: "披肩长发" },
  { id: "style6", label: "低马尾" },
  { id: "style7", label: "短发偏分" },
  { id: "style8", label: "熊熊短发" },
  { id: "style9", label: "光头侧发" },
  { id: "none", label: "无 (光头)" },
];

/** Eyebrow-shape dimension · "default" keeps the body's own brows; each other
 *  id overlays JUST that model's brow mesh (role "brow", isolated by
 *  tagEyebrows at load · beard/hair/eyes are never borrowed), still tinted by
 *  眉色. The ten source GLBs collapse to a handful of DISTINCT designs — many
 *  only differed in position — so each entry below is one representative
 *  source model for its design family:
 *    · default  (= glasses / casual / street brows · the natural everyday shape)
 *    · royal    (= xmas · the thicker royal shape)
 *    · style6, style7 · their own shapes
 *    · style8   (= style9 / style10 · the heavy bearded-model shape)
 *  Stale ids from older saves are migrated to these in normalizeConfig. */
export const BROW_STYLES = [
  { id: "default", label: "标准" },
  { id: "royal", label: "浓眉" },
  { id: "style6", label: "细眉" },
  { id: "style7", label: "柔眉" },
  { id: "style8", label: "粗眉" },
];

/** Eye-shape dimension · "default" keeps the body's own eyes; each model id
 *  overlays JUST that model's eye mesh (role "eye" · the dark BlackShiny
 *  pupils, isolated by overlayRole — the sclera/mouth/brows are never
 *  borrowed), still tinted by 瞳色. The sclera (eyewhite) is intentionally NOT
 *  swapped: it's the body's own, which also dodges the shoe-"White" mis-tag.
 *  Numbered because shapes are picked by preview, not by name.
 *  NOTE · cross-model eye overlays are position-sensitive (an earlier
 *  eye-shape dimension was dropped for bind-pose misalignment); each entry
 *  needs a visual check, and clearly-broken ones should be merged out like
 *  the brow families were. */
export const EYE_STYLES = [
  { id: "default", label: "默认" },
  { id: "casual", label: "圆眼" },
  { id: "street", label: "细眼" },
  { id: "royal", label: "杏眼" },
  { id: "style7", label: "笑眼" },
  { id: "style8", label: "豆豆眼" },
  { id: "style9", label: "锐眼" },
  { id: "style10", label: "圆豆眼" },
];
// Beady cartoon eyes (bear / pikachu) are solid — they carry no sclera, so the
// body's own eyewhite pokes out around the smaller borrowed pupils as stray
// white dots. For these eye styles the body's FACE eyewhite is suppressed
// (see buildAvatar3D · a midY guard keeps any foot-level white mesh).
const EYE_HIDE_SCLERA = new Set(["street", "royal", "style8", "style9", "style10"]);

/** Beard dimension · independent toggle (overlaid from its source, role
 *  "beard"). Only models with hasBeard:true carry a beard mesh; the rest are
 *  no-ops when picked. */
export const BEARD_STYLES = [
  { id: "none", label: "无" },
  { id: "style8", label: "络腮胡" },
  { id: "style9", label: "八字胡" },
  { id: "style10", label: "皮卡丘小胡" },
];

/** Neckwear dimension · independent toggle (overlaid from its source, role
 *  "tie"): a tie or a bow. */
export const TIE_STYLES = [
  { id: "none", label: "无" },
  { id: "royal", label: "领带" },
  { id: "xmas", label: "蝴蝶结" },
];

/** Top (上衣) dimension · model ids whose role "top" meshes get overlaid.
 *  Independent of bottom; the body keeps its own top when none / its own id
 *  is picked. Dresses / onesies are tagged entirely as "top" so they show
 *  up here. */
export const TOP_STYLES = [
  { id: "glasses", label: "蓝色上衣" },
  { id: "casual", label: "黑T" },
  { id: "style6", label: "背心裙" },
  { id: "style7", label: "长袖" },
  // style8 (bear) + style10 (pikachu) are full-body costumes · they live in
  // ACCESSORY_STYLES now (rendered via COSTUME_TOPS), not the top dimension.
];

/** Bottom (裤子 / 裙子) dimension · model ids whose role "bottom" meshes
 *  get overlaid. Models with no separable bottom (style6 dress, style8
 *  onesie, glasses uniform) are omitted from this list — picking them as
 *  a body still uses their built-in bottom, but the "swap bottom from X"
 *  surface only lists models that actually carry a distinct bottom mesh. */
export const BOTTOM_STYLES = [
  { id: "casual", label: "白短裤" },
  { id: "street", label: "街头白短裤" },
];

/** Accessory styles offered by the customizer · an independent dimension.
 *  Each (non-"none") id is overlaid from its source model. */
export const ACCESSORY_STYLES = [
  { id: "none", label: "无" },
  { id: "glasses", label: "眼镜" },
  { id: "shades", label: "墨镜" },
  { id: "headphones", label: "耳机" },
  { id: "cap", label: "鸭舌帽" },
  { id: "crown", label: "王冠" },
  { id: "santa", label: "圣诞帽" },
  { id: "tophat", label: "礼帽" },
  { id: "mask", label: "口罩" },
  { id: "blindfold", label: "眼罩" },
  { id: "star", label: "星星" },
  { id: "anger", label: "怒火" },
  // blush (redcheek) removed · the pikachu-sourced flat cheek decal clips into
  // other face shapes (incomplete circle) and can't map cleanly cross-model.
  // Full-body costumes · rendered as a hooded one-piece (COSTUME_TOPS) rather
  // than a small accessory; grouped here in 装饰 instead of 上衣.
  { id: "bearsuit", label: "熊熊连体" },
  { id: "pikasuit", label: "皮卡丘外衣" },
];

/** Live-recolour an existing avatar Group without rebuilding (customizer
 *  instant feedback). `colors` is a partial `{ skin, hair, brow, outfit, tie, eye }`. */
export function recolorAvatar(group, colors = {}) {
  if (!group) return;
  group.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    // Colour-locked meshes (partTag noPaint:true · e.g. the pikachu / bear
    // costume) keep their baked look · skip them here too, otherwise live
    // recolour would tint the suit off its own colour (paintInstance already
    // honours this on build).
    if (o.userData && o.userData.avatarColorLocked) return;
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
  // Only full bodies can be the base model · `partsOnly` entries (parts
  // source GLBs) contribute parts but aren't standalone bodies.
  const bodies = AVATAR_MODELS.filter((m) => !m.partsOnly);
  const model = bodies[Math.floor(rng() * bodies.length) % bodies.length];
  const hairChoices = HAIR_STYLES.filter((h) => h.id !== "none"); // not bald by default
  // Don't default a director into a full-body costume · the onesies are an
  // opt-in accessory, not a random starting look.
  const accChoices = ACCESSORY_STYLES.filter((a) => !COSTUME_TOPS[a.id]);
  const hair = pick(HAIR_COLORS, rng);
  return {
    model: model.id,
    hairStyle: hairChoices[Math.floor(rng() * hairChoices.length) % hairChoices.length].id,
    topStyle: pickId(TOP_STYLES),
    bottomStyle: pickId(BOTTOM_STYLES),
    accessory: accChoices[Math.floor(rng() * accChoices.length) % accChoices.length].id,
    browStyle: "default", // keep the body's own brows by default
    beardStyle: "none",   // no beard by default
    tieStyle: "none",     // no tie by default
    skin: pick(SKIN_TONES, rng),
    hair,
    brow: hair,
    beard: hair, // beard tinted to the hair-family colour by default
    top: pick(OUTFIT_COLORS, rng),
    bottom: pick(OUTFIT_COLORS, rng),
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
    DEFAULT_AVATAR_URL, AVATAR_MODELS, AVATAR_PALETTES, HAIR_STYLES, TOP_STYLES, BOTTOM_STYLES,
    ACCESSORY_STYLES, BROW_STYLES, EYE_STYLES, BEARD_STYLES, TIE_STYLES, COSTUME_TOPS,
  };
}
