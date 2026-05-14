/* ──────────────────────────────────────────────────────────────────
   share-cover-svg-creator.js · randomized 8-bit pixel-art cover for
   the All-Notes share-card modal's "boardroom" template.

   Each `generate()` call rolls a fresh variation:
     · sky palette  (sunset / dawn / midnight / dusk / tropical / aurora)
     · ground material  (warm-sand / moss / snow / lavender / volcanic / desert)
     · river  (random control-point ys, random width 30-48 px)
     · sky decorations  (moon at fixed top-right, stars 12-20, clouds 2-4)

   Trees / stones / flowers / dirt patches were all removed — the
   composition is now ASCII logo (top) + black quote panel (centre)
   + river (low ground) + sky decorations. The helper functions
   (`placeStones`, `placeTrees`, `placeFlowers`, `placeDirt`) are
   kept as dead code in case the user wants to bring them back.

   Output is consumed by `renderShareCardHtml`'s boardroom branch in
   `app.js`: the consumer pulls `skyGradient` into an inline
   `style="background: …"` on the `.share-card` div and injects
   `skyDeco + groundDeco` inside the `.sc-sky-deco` SVG. The module
   owns NO DOM — it just returns markup strings.

   Public API:
     window.shareCoverSvgCreator.generate(opts?) → {
       seed: number,
       skyGradient: string,       // CSS linear-gradient(...) value
       skyDeco: string,           // SVG inner markup (sky band)
       groundDeco: string,        // SVG inner markup (ground band)
       palette: { skyName, groundName }
     }

   Seeded mode (for tests / reproducibility):
     window.shareCoverSvgCreator.generate({ seed: 42 }) → deterministic
   ────────────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  // ── Deterministic seeded RNG · mulberry32 ────────────────────
  function makeRng(seed) {
    let s = (seed | 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
  const between = (rng, a, b) => a + rng() * (b - a);
  const betweenInt = (rng, a, b) => Math.floor(between(rng, a, b + 1));

  // ── Sky palettes · each is a 9-stop hard-step gradient ───────
  // Stop 0 = top (deepest), stop 8 = horizon (warmest / lightest).
  // The bottom two stops get overwritten with the chosen ground
  // material's base color so the horizon blends into the ground.
  const SKY_PALETTES = [
    { name: "sunset",
      stops: ["#1B0A35", "#2D1452", "#4A2070", "#6B2B6E", "#A03B5E",
              "#D85F4C", "#ED8E48", "#F4C078", "#F8D898"] },
    { name: "dawn",
      stops: ["#1A1B3A", "#2D3460", "#4A5790", "#7A6FA8", "#C08BB0",
              "#E8A088", "#F5C5A0", "#FBE2B8", "#FFEED2"] },
    { name: "midnight",
      stops: ["#08051A", "#100A28", "#1C1545", "#2A2058", "#3A2D68",
              "#4A3878", "#5A4288", "#7050A0", "#9070B0"] },
    { name: "dusk",
      stops: ["#0A1538", "#152258", "#243088", "#3A4AA0", "#5C68A8",
              "#88789C", "#B89090", "#DCA888", "#F0C898"] },
    { name: "tropical",
      stops: ["#1A0850", "#3A1070", "#702090", "#A82C82", "#D84878",
              "#F06868", "#F88858", "#F8A858", "#F8D898"] },
    { name: "aurora",
      stops: ["#001528", "#003050", "#005078", "#208098", "#40B0A8",
              "#80D8A8", "#B0E8B8", "#D8F0C8", "#F0F8E0"] },
  ];

  // ── Ground materials · base color + 4-tone dirt palette ──────
  const GROUND_MATERIALS = [
    { name: "warm-sand",
      base: "#F8D898", dirt: ["#A0814F", "#8A6A48", "#5A3A22", "#3A2410"] },
    { name: "moss-field",
      base: "#A8C088", dirt: ["#6A8050", "#506838", "#3A5024", "#2A3818"] },
    { name: "snow-drift",
      base: "#E8E8EE", dirt: ["#A8A8B0", "#82828C", "#60606C", "#404048"] },
    { name: "lavender-bloom",
      base: "#E0C8E0", dirt: ["#9080A0", "#705C80", "#503C60", "#382848"] },
    { name: "volcanic",
      base: "#3A2828", dirt: ["#4A302C", "#3A2420", "#2A1814", "#1A0C08"] },
    { name: "desert-sand",
      base: "#F4C078", dirt: ["#A8784A", "#885828", "#684020", "#482818"] },
  ];

  // Each band stops at this percent (rest go in between).
  const BAND_STOPS = [5, 11, 18, 25, 33, 41, 49, 57];

  function gradientFromStops(stops) {
    // Build hard-step bands so the gradient reads as 8-bit horizontal
    // stripes (no anti-aliased fades between bands).
    const parts = [];
    parts.push(`${stops[0]} 0%`);
    parts.push(`${stops[0]} ${BAND_STOPS[0]}%`);
    for (let i = 1; i < BAND_STOPS.length; i++) {
      parts.push(`${stops[i]} ${BAND_STOPS[i - 1]}%`);
      parts.push(`${stops[i]} ${BAND_STOPS[i]}%`);
    }
    parts.push(`${stops[8]} ${BAND_STOPS[BAND_STOPS.length - 1]}%`);
    parts.push(`${stops[8]} 100%`);
    return `linear-gradient(180deg, ${parts.join(", ")})`;
  }

  // ── Sprite generators (return SVG markup strings) ────────────
  function star(x, y, color) {
    return `<rect x="${x}" y="${y}" width="2" height="2" fill="${color || "#FFF6D9"}"/>`;
  }
  function tinyStar(x, y, color) {
    return `<rect x="${x}" y="${y}" width="1" height="1" fill="${color || "#FFE8A8"}"/>`;
  }
  function cloud(x, y) {
    return `
      <rect x="${x + 4}" y="${y - 2}" width="10" height="2" fill="#FFF6D9"/>
      <rect x="${x}"     y="${y}"     width="18" height="4" fill="#FFF6D9"/>
      <rect x="${x + 2}" y="${y + 4}" width="14" height="2" fill="#F4C078"/>
    `;
  }
  function bigCloud(x, y) {
    return `
      <rect x="${x + 6}" y="${y - 4}" width="14" height="2" fill="#FFF6D9"/>
      <rect x="${x + 2}" y="${y - 2}" width="22" height="2" fill="#FFF6D9"/>
      <rect x="${x}"     y="${y}"     width="26" height="4" fill="#FFF6D9"/>
      <rect x="${x + 2}" y="${y + 4}" width="22" height="2" fill="#F4C078"/>
    `;
  }
  function moon(x, y) {
    return `
      <g transform="translate(${x} ${y})">
        <rect x="8"  y="0"  width="20" height="4" fill="#FFF6D9"/>
        <rect x="4"  y="4"  width="28" height="4" fill="#FFF6D9"/>
        <rect x="0"  y="8"  width="36" height="14" fill="#FFF6D9"/>
        <rect x="4"  y="22" width="28" height="4" fill="#FFF6D9"/>
        <rect x="8"  y="26" width="20" height="4" fill="#FFF6D9"/>
        <rect x="14" y="10" width="3" height="3" fill="#F4D898"/>
        <rect x="22" y="14" width="2" height="2" fill="#F4D898"/>
        <rect x="10" y="18" width="2" height="2" fill="#F4D898"/>
      </g>
    `;
  }

  // Top-down stones · three sizes. Mid body, bright dome highlight,
  // specular spot, soft drop shadow. Same fills as the inline
  // version they're replacing.
  function stoneSmall(x, y) {
    return `
      <rect x="${x + 4}" y="${y + 14}" width="16" height="2" fill="#1B0A35" opacity="0.28"/>
      <rect x="${x + 4}" y="${y}"      width="12" height="2" fill="#7A6F62"/>
      <rect x="${x + 2}" y="${y + 2}"  width="16" height="2" fill="#7A6F62"/>
      <rect x="${x}"     y="${y + 4}"  width="20" height="6" fill="#7A6F62"/>
      <rect x="${x + 2}" y="${y + 10}" width="16" height="2" fill="#7A6F62"/>
      <rect x="${x + 4}" y="${y + 12}" width="12" height="2" fill="#7A6F62"/>
      <rect x="${x + 6}" y="${y + 2}"  width="8"  height="2" fill="#9F9388"/>
      <rect x="${x + 4}" y="${y + 4}"  width="12" height="4" fill="#9F9388"/>
      <rect x="${x + 6}" y="${y + 8}"  width="8"  height="2" fill="#9F9388"/>
      <rect x="${x + 7}" y="${y + 4}"  width="4"  height="2" fill="#B5A998"/>
      <rect x="${x + 4}" y="${y + 12}" width="12" height="1" fill="#4A4038"/>
    `;
  }
  function stoneMed(x, y) {
    return `
      <rect x="${x + 4}"  y="${y + 20}" width="24" height="2" fill="#1B0A35" opacity="0.30"/>
      <rect x="${x + 6}"  y="${y + 22}" width="20" height="1" fill="#1B0A35" opacity="0.18"/>
      <rect x="${x + 6}"  y="${y}"      width="20" height="2" fill="#7A6F62"/>
      <rect x="${x + 3}"  y="${y + 2}"  width="26" height="2" fill="#7A6F62"/>
      <rect x="${x + 1}"  y="${y + 4}"  width="30" height="2" fill="#7A6F62"/>
      <rect x="${x}"      y="${y + 6}"  width="32" height="8" fill="#7A6F62"/>
      <rect x="${x + 1}"  y="${y + 14}" width="30" height="2" fill="#7A6F62"/>
      <rect x="${x + 3}"  y="${y + 16}" width="26" height="2" fill="#7A6F62"/>
      <rect x="${x + 6}"  y="${y + 18}" width="20" height="2" fill="#7A6F62"/>
      <rect x="${x + 9}"  y="${y + 2}"  width="14" height="2" fill="#9F9388"/>
      <rect x="${x + 6}"  y="${y + 4}"  width="20" height="2" fill="#9F9388"/>
      <rect x="${x + 4}"  y="${y + 6}"  width="24" height="4" fill="#9F9388"/>
      <rect x="${x + 6}"  y="${y + 10}" width="20" height="2" fill="#9F9388"/>
      <rect x="${x + 11}" y="${y + 5}"  width="10" height="3" fill="#B5A998"/>
      <rect x="${x + 4}"  y="${y + 16}" width="24" height="1" fill="#5A5048"/>
      <rect x="${x + 7}"  y="${y + 18}" width="18" height="1" fill="#4A4038"/>
    `;
  }
  function stoneLarge(x, y) {
    return `
      <rect x="${x + 6}"  y="${y + 28}" width="36" height="2" fill="#1B0A35" opacity="0.32"/>
      <rect x="${x + 8}"  y="${y + 30}" width="32" height="1" fill="#1B0A35" opacity="0.20"/>
      <rect x="${x + 10}" y="${y}"      width="26" height="2" fill="#7A6F62"/>
      <rect x="${x + 6}"  y="${y + 2}"  width="34" height="2" fill="#7A6F62"/>
      <rect x="${x + 3}"  y="${y + 4}"  width="40" height="2" fill="#7A6F62"/>
      <rect x="${x + 1}"  y="${y + 6}"  width="44" height="2" fill="#7A6F62"/>
      <rect x="${x}"      y="${y + 8}"  width="46" height="10" fill="#7A6F62"/>
      <rect x="${x + 1}"  y="${y + 18}" width="44" height="2" fill="#7A6F62"/>
      <rect x="${x + 3}"  y="${y + 20}" width="40" height="2" fill="#7A6F62"/>
      <rect x="${x + 6}"  y="${y + 22}" width="34" height="2" fill="#7A6F62"/>
      <rect x="${x + 10}" y="${y + 24}" width="26" height="2" fill="#7A6F62"/>
      <rect x="${x + 14}" y="${y + 2}"  width="18" height="2" fill="#9F9388"/>
      <rect x="${x + 10}" y="${y + 4}"  width="26" height="2" fill="#9F9388"/>
      <rect x="${x + 6}"  y="${y + 6}"  width="34" height="2" fill="#9F9388"/>
      <rect x="${x + 4}"  y="${y + 8}"  width="38" height="6" fill="#9F9388"/>
      <rect x="${x + 6}"  y="${y + 14}" width="34" height="2" fill="#9F9388"/>
      <rect x="${x + 16}" y="${y + 6}"  width="14" height="4" fill="#B5A998"/>
      <rect x="${x + 18}" y="${y + 10}" width="10" height="2" fill="#C7BDB0"/>
      <rect x="${x + 6}"  y="${y + 20}" width="34" height="1" fill="#5A5048"/>
      <rect x="${x + 10}" y="${y + 22}" width="26" height="1" fill="#4A4038"/>
      <rect x="${x + 14}" y="${y + 24}" width="18" height="1" fill="#3A302A"/>
    `;
  }

  // Flower · 4-petal pixel head with a stem. The "big" variant is
  // ~1.4× the small. Stem and one leaf in `leaf` color.
  const FLOWER_PALETTES = [
    { petal: "#E26AA0", center: "#F8D848", leaf: "#3D6E2F" }, // pink
    { petal: "#F0D848", center: "#E26AA0", leaf: "#3D6E2F" }, // yellow
    { petal: "#FCFCFC", center: "#F0D848", leaf: "#3D6E2F" }, // white-daisy
    { petal: "#C8B8E8", center: "#F0D848", leaf: "#3D6E2F" }, // lavender
    { petal: "#F86868", center: "#F8D848", leaf: "#3D6E2F" }, // red
    { petal: "#90C8E8", center: "#F0D848", leaf: "#3D6E2F" }, // sky-blue
  ];
  // Bigger flowers · sized to match the stones (was tiny ~8×11 /
  // ~9×16 before, now ~18×28 / ~26×36 so the bloom reads as a
  // substantial landscape element, not a sprinkled crumb). 6-7 tier
  // round daisy head + 4-6 pixel center + lit-corner highlight +
  // stem with a leaf or two.
  function flower(x, y, p) {
    return `
      <!-- Daisy head · 9 stepped petal rows -->
      <rect x="${x + 7}"  y="${y}"      width="4"  height="2" fill="${p.petal}"/>
      <rect x="${x + 5}"  y="${y + 2}"  width="8"  height="2" fill="${p.petal}"/>
      <rect x="${x + 3}"  y="${y + 4}"  width="12" height="2" fill="${p.petal}"/>
      <rect x="${x + 1}"  y="${y + 6}"  width="16" height="2" fill="${p.petal}"/>
      <rect x="${x + 1}"  y="${y + 8}"  width="16" height="4" fill="${p.petal}"/>
      <rect x="${x + 1}"  y="${y + 12}" width="16" height="2" fill="${p.petal}"/>
      <rect x="${x + 3}"  y="${y + 14}" width="12" height="2" fill="${p.petal}"/>
      <rect x="${x + 5}"  y="${y + 16}" width="8"  height="2" fill="${p.petal}"/>
      <rect x="${x + 7}"  y="${y + 18}" width="4"  height="2" fill="${p.petal}"/>
      <!-- Center · 6×6 block of the center color + 2×2 sparkle -->
      <rect x="${x + 6}"  y="${y + 7}"  width="6"  height="6" fill="${p.center}"/>
      <rect x="${x + 8}"  y="${y + 9}"  width="2"  height="2" fill="#FFFFFF"/>
      <!-- Stem -->
      <rect x="${x + 8}"  y="${y + 20}" width="2"  height="8" fill="${p.leaf}"/>
      <!-- Leaf branches off to the right -->
      <rect x="${x + 10}" y="${y + 24}" width="4"  height="2" fill="${p.leaf}"/>
      <rect x="${x + 12}" y="${y + 22}" width="2"  height="2" fill="${p.leaf}"/>
    `;
  }
  function flowerBig(x, y, p) {
    return `
      <!-- Daisy head · 11 stepped petal rows (~24 px wide) -->
      <rect x="${x + 10}" y="${y}"      width="6"  height="2" fill="${p.petal}"/>
      <rect x="${x + 8}"  y="${y + 2}"  width="10" height="2" fill="${p.petal}"/>
      <rect x="${x + 6}"  y="${y + 4}"  width="14" height="2" fill="${p.petal}"/>
      <rect x="${x + 4}"  y="${y + 6}"  width="18" height="2" fill="${p.petal}"/>
      <rect x="${x + 2}"  y="${y + 8}"  width="22" height="2" fill="${p.petal}"/>
      <rect x="${x + 2}"  y="${y + 10}" width="22" height="6" fill="${p.petal}"/>
      <rect x="${x + 2}"  y="${y + 16}" width="22" height="2" fill="${p.petal}"/>
      <rect x="${x + 4}"  y="${y + 18}" width="18" height="2" fill="${p.petal}"/>
      <rect x="${x + 6}"  y="${y + 20}" width="14" height="2" fill="${p.petal}"/>
      <rect x="${x + 8}"  y="${y + 22}" width="10" height="2" fill="${p.petal}"/>
      <rect x="${x + 10}" y="${y + 24}" width="6"  height="2" fill="${p.petal}"/>
      <!-- Center · 8×8 in center color + 3×3 white sparkle -->
      <rect x="${x + 9}"  y="${y + 9}"  width="8"  height="8" fill="${p.center}"/>
      <rect x="${x + 11}" y="${y + 11}" width="3"  height="3" fill="#FFFFFF"/>
      <!-- Stem (longer) -->
      <rect x="${x + 12}" y="${y + 26}" width="2"  height="10" fill="${p.leaf}"/>
      <!-- Two leaves on opposite sides for symmetry -->
      <rect x="${x + 14}" y="${y + 28}" width="6"  height="2" fill="${p.leaf}"/>
      <rect x="${x + 18}" y="${y + 26}" width="2"  height="2" fill="${p.leaf}"/>
      <rect x="${x + 6}"  y="${y + 32}" width="6"  height="2" fill="${p.leaf}"/>
      <rect x="${x + 4}"  y="${y + 30}" width="2"  height="2" fill="${p.leaf}"/>
    `;
  }

  // Pixel trees · scaled 2× from the previous version so they read
  // as substantial canopy elements rather than small bushes. Multi-
  // tier rounded canopy in three greens (dark silhouette / mid body
  // / lit highlights), thick warm-brown trunk with a 2-px brighter
  // grain stripe, and a chunky drop shadow on the ground beneath.
  // Trees sit on the lower bank in front of the river.
  //
  // Bounding boxes used by the placement coordinator:
  //   treeSmall · ≈ 48 wide × 74 tall (canopy y=0-50, trunk to y=72)
  //   treeTall  · ≈ 56 wide × 98 tall (canopy y=0-58, trunk to y=96)
  function treeSmall(x, y) {
    return `
      <!-- Ground shadow -->
      <rect x="${x + 12}" y="${y + 72}" width="24" height="2" fill="#1B0A35" opacity="0.32"/>
      <!-- Trunk -->
      <rect x="${x + 20}" y="${y + 48}" width="8"  height="22" fill="#5A3A22"/>
      <rect x="${x + 16}" y="${y + 68}" width="16" height="4"  fill="#5A3A22"/>
      <rect x="${x + 21}" y="${y + 48}" width="2"  height="18" fill="#7A4F30"/>
      <!-- Canopy outer · dark silhouette (round, 9 stepped rows) -->
      <rect x="${x + 16}" y="${y}"      width="16" height="4"  fill="#2A4F1D"/>
      <rect x="${x + 10}" y="${y + 4}"  width="28" height="4"  fill="#2A4F1D"/>
      <rect x="${x + 6}"  y="${y + 8}"  width="36" height="4"  fill="#2A4F1D"/>
      <rect x="${x + 2}"  y="${y + 12}" width="44" height="4"  fill="#2A4F1D"/>
      <rect x="${x}"      y="${y + 16}" width="48" height="20" fill="#2A4F1D"/>
      <rect x="${x + 2}"  y="${y + 36}" width="44" height="4"  fill="#2A4F1D"/>
      <rect x="${x + 6}"  y="${y + 40}" width="36" height="4"  fill="#2A4F1D"/>
      <rect x="${x + 10}" y="${y + 44}" width="28" height="4"  fill="#2A4F1D"/>
      <rect x="${x + 16}" y="${y + 48}" width="16" height="2"  fill="#2A4F1D"/>
      <!-- Canopy mid · lighter green body inset 4 px -->
      <rect x="${x + 14}" y="${y + 4}"  width="20" height="4"  fill="#3D6E2F"/>
      <rect x="${x + 10}" y="${y + 8}"  width="28" height="4"  fill="#3D6E2F"/>
      <rect x="${x + 6}"  y="${y + 12}" width="36" height="4"  fill="#3D6E2F"/>
      <rect x="${x + 4}"  y="${y + 16}" width="40" height="20" fill="#3D6E2F"/>
      <rect x="${x + 6}"  y="${y + 36}" width="36" height="4"  fill="#3D6E2F"/>
      <rect x="${x + 10}" y="${y + 40}" width="28" height="2"  fill="#3D6E2F"/>
      <!-- Canopy highlights · brightest pixel clusters -->
      <rect x="${x + 12}" y="${y + 16}" width="8" height="4" fill="#6BAA48"/>
      <rect x="${x + 24}" y="${y + 12}" width="6" height="4" fill="#6BAA48"/>
      <rect x="${x + 18}" y="${y + 24}" width="4" height="4" fill="#6BAA48"/>
      <rect x="${x + 30}" y="${y + 20}" width="4" height="4" fill="#6BAA48"/>
      <rect x="${x + 10}" y="${y + 28}" width="4" height="4" fill="#6BAA48"/>
    `;
  }
  function treeTall(x, y) {
    return `
      <!-- Ground shadow -->
      <rect x="${x + 14}" y="${y + 96}" width="28" height="2" fill="#1B0A35" opacity="0.34"/>
      <!-- Trunk · longer than treeSmall -->
      <rect x="${x + 24}" y="${y + 58}" width="10" height="36" fill="#5A3A22"/>
      <rect x="${x + 20}" y="${y + 92}" width="20" height="4"  fill="#5A3A22"/>
      <rect x="${x + 25}" y="${y + 58}" width="2"  height="32" fill="#7A4F30"/>
      <!-- Canopy outer · taller, fuller body -->
      <rect x="${x + 20}" y="${y}"      width="16" height="4"  fill="#2A4F1D"/>
      <rect x="${x + 14}" y="${y + 4}"  width="28" height="4"  fill="#2A4F1D"/>
      <rect x="${x + 10}" y="${y + 8}"  width="36" height="4"  fill="#2A4F1D"/>
      <rect x="${x + 4}"  y="${y + 12}" width="48" height="4"  fill="#2A4F1D"/>
      <rect x="${x + 2}"  y="${y + 16}" width="52" height="28" fill="#2A4F1D"/>
      <rect x="${x + 4}"  y="${y + 44}" width="48" height="4"  fill="#2A4F1D"/>
      <rect x="${x + 10}" y="${y + 48}" width="36" height="4"  fill="#2A4F1D"/>
      <rect x="${x + 14}" y="${y + 52}" width="28" height="4"  fill="#2A4F1D"/>
      <rect x="${x + 20}" y="${y + 56}" width="16" height="2"  fill="#2A4F1D"/>
      <!-- Canopy mid -->
      <rect x="${x + 18}" y="${y + 4}"  width="20" height="4"  fill="#3D6E2F"/>
      <rect x="${x + 14}" y="${y + 8}"  width="28" height="4"  fill="#3D6E2F"/>
      <rect x="${x + 8}"  y="${y + 12}" width="40" height="4"  fill="#3D6E2F"/>
      <rect x="${x + 6}"  y="${y + 16}" width="44" height="28" fill="#3D6E2F"/>
      <rect x="${x + 8}"  y="${y + 44}" width="40" height="4"  fill="#3D6E2F"/>
      <rect x="${x + 14}" y="${y + 48}" width="28" height="2"  fill="#3D6E2F"/>
      <!-- Canopy highlights -->
      <rect x="${x + 16}" y="${y + 18}" width="8" height="4" fill="#6BAA48"/>
      <rect x="${x + 28}" y="${y + 12}" width="8" height="4" fill="#6BAA48"/>
      <rect x="${x + 22}" y="${y + 30}" width="4" height="4" fill="#6BAA48"/>
      <rect x="${x + 36}" y="${y + 24}" width="6" height="4" fill="#6BAA48"/>
      <rect x="${x + 12}" y="${y + 36}" width="4" height="4" fill="#6BAA48"/>
      <!-- Small fruit · 3 red pixel flecks scattered through canopy -->
      <rect x="${x + 30}" y="${y + 22}" width="3" height="3" fill="#F86868"/>
      <rect x="${x + 18}" y="${y + 28}" width="3" height="3" fill="#F86868"/>
      <rect x="${x + 38}" y="${y + 38}" width="3" height="3" fill="#F86868"/>
    `;
  }

  // Dirt patches · two sizes. Colors are sampled per call from the
  // chosen ground material's 4-tone dirt palette.
  function dirtPatch(x, y, c) {
    return `
      <rect x="${x}"     y="${y}"     width="14" height="1" fill="${c[0]}"/>
      <rect x="${x}"     y="${y + 1}" width="16" height="2" fill="${c[1]}"/>
      <rect x="${x}"     y="${y + 3}" width="14" height="2" fill="${c[2]}"/>
      <rect x="${x + 2}" y="${y + 5}" width="10" height="1" fill="${c[3]}"/>
      <rect x="${x + 4}" y="${y + 1}" width="2"  height="1" fill="${c[0]}"/>
      <rect x="${x + 9}" y="${y + 2}" width="2"  height="1" fill="${c[0]}"/>
    `;
  }
  function dirtPatchBig(x, y, c) {
    return `
      <rect x="${x + 1}"  y="${y}"     width="22" height="1" fill="${c[0]}"/>
      <rect x="${x}"      y="${y + 1}" width="26" height="2" fill="${c[1]}"/>
      <rect x="${x}"      y="${y + 3}" width="26" height="2" fill="${c[2]}"/>
      <rect x="${x + 2}"  y="${y + 5}" width="22" height="2" fill="${c[3]}"/>
      <rect x="${x + 4}"  y="${y + 7}" width="18" height="1" fill="${c[3]}"/>
      <rect x="${x + 5}"  y="${y + 1}" width="3"  height="1" fill="${c[0]}"/>
      <rect x="${x + 14}" y="${y + 2}" width="2"  height="1" fill="${c[0]}"/>
      <rect x="${x + 20}" y="${y + 4}" width="2"  height="1" fill="${c[0]}"/>
      <rect x="${x + 8}"  y="${y + 4}" width="1"  height="1" fill="${c[1]}"/>
    `;
  }

  // ── River generator ─────────────────────────────────────────
  // 7 anchor xs at -10 / 80 / 180 / 260 / 340 / 420 / 550.
  // Top edge y wanders ±12px around y≈685 with a tighter cap on the
  // outer endpoints. River shifted down ~100px from the original
  // 585 baseline so the ASCII PRIVATE BOARD logo (y=80-260) and the
  // black quote panel (centred at y=460, worst-case bottom y=630)
  // both have ample vertical room. Trees and stones are gone, so
  // the river is now the sole ground element and sits low in the
  // card to balance the watermark band at y=770+.
  const RIVER_ANCHOR_XS = [-10, 80, 180, 260, 340, 420, 550];

  function generateRiverPath(rng) {
    // Base top-edge y for each anchor · shifted +100 vs. the original
    // [583, 571, 603, 583, 563, 595, 575] so the river sits low in
    // the card, just above the watermark. We perturb each control
    // point a few pixels so the curve is fresh per roll but stays
    // within safe vertical bounds (max bottom ~735, clear of the
    // 770+ watermark band).
    const baseTopYs   = [683, 671, 703, 683, 663, 695, 675];
    const widthVar = betweenInt(rng, 30, 48);

    const topYs = baseTopYs.map((y, i) => {
      // Less wiggle at the endpoints (so the river enters / exits
      // the card at a predictable height), more at the controls.
      const isEndpoint = (i === 0 || i === 6);
      const jitter = isEndpoint ? betweenInt(rng, -6, 6) : betweenInt(rng, -12, 12);
      return y + jitter;
    });
    const bottomYs = topYs.map((y) => y + widthVar + betweenInt(rng, -4, 4));

    const fmt = (xs, ys) => xs.map((x, i) => `${x} ${ys[i]}`).join(", ");
    // Body · solid cyan, closed path running left-to-right along
    // the top edge then right-to-left along the bottom edge.
    const bodyD = [
      `M -10 ${topYs[0]}`,
      `C 80 ${topYs[1]}, 180 ${topYs[2]}, 260 ${topYs[3]}`,
      `C 340 ${topYs[4]}, 420 ${topYs[5]}, 550 ${topYs[6]}`,
      `L 550 ${bottomYs[6]}`,
      `C 420 ${bottomYs[5]}, 340 ${bottomYs[4]}, 260 ${bottomYs[3]}`,
      `C 180 ${bottomYs[2]}, 80 ${bottomYs[1]}, -10 ${bottomYs[0]} Z`,
    ].join(" ");
    const topHiD = [
      `M -10 ${topYs[0] + 2}`,
      `C 80 ${topYs[1] + 2}, 180 ${topYs[2] + 2}, 260 ${topYs[3] + 2}`,
      `C 340 ${topYs[4] + 2}, 420 ${topYs[5] + 2}, 550 ${topYs[6] + 2}`,
    ].join(" ");
    const botShadowD = [
      `M -10 ${bottomYs[0] - 2}`,
      `C 80 ${bottomYs[1] - 2}, 180 ${bottomYs[2] - 2}, 260 ${bottomYs[3] - 2}`,
      `C 340 ${bottomYs[4] - 2}, 420 ${bottomYs[5] - 2}, 550 ${bottomYs[6] - 2}`,
    ].join(" ");

    // Sparkle pixels along the river spine.
    const sparkles = [];
    const sparkleXs = [44, 116, 184, 244, 312, 368, 436, 496, 72, 160, 284, 396];
    for (const sx of sparkleXs) {
      const topAt = approxAt(sx, RIVER_ANCHOR_XS, topYs);
      const botAt = approxAt(sx, RIVER_ANCHOR_XS, bottomYs);
      const spineY = ((topAt + botAt) / 2) | 0;
      const sy = spineY + betweenInt(rng, -8, 8);
      const w = rng() > 0.5 ? 3 : 2;
      sparkles.push(`<rect x="${sx}" y="${sy}" width="${w}" height="1" fill="#FFFFFF"/>`);
    }

    return {
      topYs,
      bottomYs,
      widthVar,
      svg: `
        <path d="${bodyD}" fill="#5BC0EB" shape-rendering="geometricPrecision"/>
        <path d="${topHiD}" stroke="#9ADEFA" stroke-width="2" fill="none" shape-rendering="geometricPrecision"/>
        <path d="${botShadowD}" stroke="#2A6FA5" stroke-width="2" fill="none" shape-rendering="geometricPrecision"/>
        ${sparkles.join("")}
      `,
    };
  }

  function approxAt(x, anchorXs, ys) {
    for (let i = 0; i < anchorXs.length - 1; i++) {
      if (x >= anchorXs[i] && x <= anchorXs[i + 1]) {
        const t = (x - anchorXs[i]) / (anchorXs[i + 1] - anchorXs[i]);
        return ys[i] + (ys[i + 1] - ys[i]) * t;
      }
    }
    return x < anchorXs[0] ? ys[0] : ys[ys.length - 1];
  }
  const riverTopAt = (x, river) => approxAt(x, RIVER_ANCHOR_XS, river.topYs);
  const riverBotAt = (x, river) => approxAt(x, RIVER_ANCHOR_XS, river.bottomYs);

  // ── Placement helpers ───────────────────────────────────────
  // Shared placement coordinator · tracks rectangular "occupied"
  // regions claimed by earlier sprites so later sprites can land
  // somewhere else. Each entry is `{xMin, yMin, xMax, yMax}` in
  // the 540×800 card coordinate system.
  //
  // Two fixed containers to dodge (nothing else is placed on the
  // ground any more — trees/stones/flowers/dirt all removed):
  //   · the ASCII PRIVATE BOARD logo · anchored at top:130, span
  //     y=130-250 (10-line block at 12px line-height).
  //   · the BLACK QUOTE PANEL · centre-anchored at vertical y=460
  //     (CSS `top: 460; transform: translateY(-50%)` on the 800-
  //     tall card). Content drives the height up to a 340-px cap,
  //     so worst case spans y=290-630 (4-px drop-shadow extends
  //     below). Short notes occupy less but stay centred at y=460.
  function initOccupied() {
    return [
      { xMin: 32, yMin: 130, xMax: 508, yMax: 250 },
      { xMin: 32, yMin: 290, xMax: 508, yMax: 630 },
    ];
  }
  function overlapsAny(xMin, yMin, xMax, yMax, occupied, pad) {
    pad = pad || 0;
    for (const o of occupied) {
      if (xMin < o.xMax + pad
          && xMax > o.xMin - pad
          && yMin < o.yMax + pad
          && yMax > o.yMin - pad) {
        return true;
      }
    }
    return false;
  }
  function claim(occupied, xMin, yMin, xMax, yMax) {
    occupied.push({ xMin, yMin, xMax, yMax });
  }

  function placeStones(rng, river, occupied) {
    const out = [];
    // Upper bank (above the river) keeps NO stones — the cream
    // space between the black quote panel and the riverbank belongs
    // to the content. All boulders now sit on the lower bank.
    // Lower bank · 2-3 stones · medium / large only.
    const lowerCount = betweenInt(rng, 2, 3);
    for (let i = 0; i < lowerCount; i++) {
      const slot = (i + 0.5) * (540 / lowerCount);
      let x = Math.max(8, Math.min(490, slot + betweenInt(rng, -30, 30)));
      const sizes = [stoneMed, stoneMed, stoneLarge];
      const size = pick(rng, sizes);
      const isLarge = size === stoneLarge;
      const w = isLarge ? 46 : 32;
      const h = isLarge ? 30 : 24;
      const botAt = riverBotAt(x + w / 2, river);
      let y = Math.min(770 - h - 6, botAt + betweenInt(rng, 4, 14));
      for (let k = 0; k < 5 && overlapsAny(x, y, x + w, y + h, occupied, 4); k++) {
        if (x > 270) x = Math.max(8, x - 40);
        else x = Math.min(490, x + 40);
        y = Math.min(770 - h - 6, riverBotAt(x + w / 2, river) + 6);
      }
      claim(occupied, x, y, x + w, y + h);
      out.push(size(x, y));
    }
    return out.join("");
  }

  function placeFlowers(rng, river, occupied) {
    const out = [];
    // Count `[2, 5]` (was 4-8) · now that flowers are stone-sized
    // the cream ground reads cleaner with fewer, larger blooms
    // rather than a crowded daisy patch.
    const total = betweenInt(rng, 2, 5);
    let placed = 0;
    for (let attempt = 0; attempt < total * 4 && placed < total; attempt++) {
      const big = rng() < 0.5;
      const fn = big ? flowerBig : flower;
      const h = big ? 36 : 28;
      const w = big ? 26 : 18;
      const x = betweenInt(rng, 8, 540 - w - 8);
      const palette = pick(rng, FLOWER_PALETTES);
      // Flowers ONLY on the upper bank (between bubble bottom and
      // river top). The lower bank (below the river) gets none —
      // it looked busy and competed with trees / stones for the
      // eye when the river curves low.
      const topAt = riverTopAt(x + w / 2, river);
      const y = Math.max(525, topAt - h - betweenInt(rng, 2, 12));
      // Flowers are smaller than trees · accept some overlap with
      // dirt (which gets placed later anyway) but skip if they'd
      // step on the bubble / plaque / trees / stones.
      if (overlapsAny(x, y, x + w, y + h, occupied, 2)) continue;
      claim(occupied, x, y, x + w, y + h);
      out.push(fn(x, y, palette));
      placed++;
    }
    return out.join("");
  }

  // Trees · 1-3 per cover, scattered on the lower bank in front of
  // the river. Now twice the size from the previous version so
  // they read as proper canopy elements, not bushes. Placed FIRST
  // among ground sprites so they claim space and downstream
  // placements (stones, flowers, dirt) route around them.
  function placeTrees(rng, river, occupied) {
    const out = [];
    // Bumped from 1-3 to 2-4 · with all stones gone from the upper
    // bank, the lower band needs more foliage to keep the bottom
    // half from reading empty.
    const total = betweenInt(rng, 2, 4);
    // Five candidate x slots spread evenly across the card width.
    // Each is wide enough for the 56-px treeTall canopy plus a
    // little breathing room.
    const slots = [
      { x: 20 }, { x: 130 }, { x: 240 }, { x: 350 }, { x: 470 },
    ];
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = slots[i]; slots[i] = slots[j]; slots[j] = tmp;
    }
    let placed = 0;
    for (let i = 0; i < slots.length && placed < total; i++) {
      const slot = slots[i];
      const tall = rng() < 0.4;
      const fn = tall ? treeTall : treeSmall;
      const w = tall ? 56 : 48;
      const h = tall ? 98 : 74;
      const x = Math.max(4, Math.min(540 - w - 4, slot.x + betweenInt(rng, -10, 10)));
      const botAt = riverBotAt(x + w / 2, river);
      // Plant the trunk just below the riverbank so the tree looks
      // rooted in the cream ground. Clamp so the tree's foliage
      // doesn't extend past the watermark band.
      const y = Math.min(770 - h - 2, botAt + betweenInt(rng, 6, 18));
      if (overlapsAny(x, y, x + w, y + h, occupied, 6)) continue;
      claim(occupied, x, y, x + w, y + h);
      out.push(fn(x, y));
      placed++;
    }
    return out.join("");
  }

  function placeDirt(rng, river, dirtColors) {
    const out = [];
    // Slightly fewer but BIGGER patches so the cream ground doesn't
    // feel sprinkled with tiny crumbs. 85 % chance of the big patch.
    const total = betweenInt(rng, 3, 6);
    for (let i = 0; i < total; i++) {
      const x = betweenInt(rng, 8, 510);
      const big = rng() < 0.85;
      const fn = big ? dirtPatchBig : dirtPatch;
      const height = big ? 8 : 6;
      const onUpper = rng() < 0.5;
      let y;
      if (onUpper) {
        const topAt = riverTopAt(x, river);
        y = Math.max(525, topAt - height - betweenInt(rng, 4, 18));
      } else {
        const botAt = riverBotAt(x, river);
        y = Math.min(770 - height - 4, botAt + betweenInt(rng, 6, 22));
      }
      out.push(fn(x, y, dirtColors));
    }
    return out.join("");
  }

  // ── Sky decorations ─────────────────────────────────────────
  // Moon stays at the same upper-right anchor (clears the
  // "Privateboard.ai" header text). Stars wander but explicitly
  // dodge the header text-bounds. Clouds float in the middle bands.
  function placeSkyDeco(rng) {
    const out = [];
    out.push(moon(440, 78));

    const starCount = betweenInt(rng, 12, 20);
    for (let i = 0; i < starCount; i++) {
      let x = betweenInt(rng, 20, 510);
      let y = betweenInt(rng, 20, 180);
      // Header text band (top-right "Privateboard.ai") · push y down
      // a bit if the random landed inside it.
      if (y >= 22 && y <= 34 && x >= 400 && x <= 512) {
        y = betweenInt(rng, 44, 180);
      }
      // Skip stars that landed inside the moon's bounding box
      // (40 px right inset, y=78-108).
      if (x >= 432 && x <= 480 && y >= 76 && y <= 112) continue;
      out.push(rng() < 0.55 ? star(x, y) : tinyStar(x, y));
    }
    const cloudCount = betweenInt(rng, 2, 4);
    for (let i = 0; i < cloudCount; i++) {
      const x = betweenInt(rng, 40, 480);
      const y = betweenInt(rng, 130, 195);
      out.push(rng() < 0.5 ? bigCloud(x, y) : cloud(x, y));
    }
    return out.join("");
  }

  // ── Public API ──────────────────────────────────────────────
  function generate(opts) {
    opts = opts || {};
    const seed = opts.seed != null
      ? (opts.seed | 0) || 1
      : ((Date.now() ^ ((Math.random() * 0x7FFFFFFF) | 0)) | 0) || 1;
    const rng = makeRng(seed);

    const sky = pick(rng, SKY_PALETTES);
    const ground = pick(rng, GROUND_MATERIALS);

    // Bottom two sky-gradient stops blend into the ground material's
    // base color so the horizon transitions smoothly into the
    // chosen ground.
    const adjustedStops = sky.stops.slice();
    adjustedStops[8] = ground.base;
    adjustedStops[7] = ground.base;
    const skyGradient = gradientFromStops(adjustedStops);

    // Pick a watermark/stamp foreground color that stays legible
    // against whichever ground material rolled. Tiny luminance
    // check on the base color · dark grounds (volcanic, etc.) get
    // a warm cream foreground; light grounds (sand / snow /
    // lavender / moss / desert) stay with the dark purple. The
    // renderer emits this as a CSS variable on the card so the
    // watermark + stamp rules can pick it up.
    const groundFg = (function () {
      const hex = ground.base.replace("#", "");
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      return lum < 0.5 ? "#F4D898" : "#4A2070";
    })();

    const river = generateRiverPath(rng);

    const skyDeco = placeSkyDeco(rng);
    // Ground composition: the river is the only foreground element
    // left. Trees, stones, flowers, and dirt patches were all
    // removed — the lower band reads cleaner as pure cream ground +
    // a single curving river, with the ASCII PRIVATE BOARD logo and
    // the black quote panel carrying the composition above.
    const groundDeco = river.svg;

    // Per-roll ASCII-logo TYPEFACE · the renderer ships three
    // pre-baked "PRIVATE BOARD" letter-form designs, all drawn with
    // the same FULL BLOCK char (█) but at different widths /
    // proportions. Texture (glyph + colour + shadow) stays fixed
    // across rolls; only the letter shapes change.
    //   · block — 4-cell-wide letters, 5-row body (the original)
    //   · slim  — 3-cell-wide letters, sleek/elegant rhythm
    //   · thick — 5-cell-wide letters, chunky/imposing rhythm
    const logoFont = pick(rng, ["block", "slim", "thick"]);

    return {
      seed,
      skyGradient,
      skyDeco,
      groundDeco,
      groundFg,
      logoFont,
      palette: { skyName: sky.name, groundName: ground.name },
    };
  }

  // Expose on `window`. App.js calls `window.shareCoverSvgCreator?.generate()`
  // once per `openShareCard()` and caches the result across template
  // chip-switches in the same modal session.
  window.shareCoverSvgCreator = { generate };
})();
