/* ═══════════════════════════════════════════════════════════════
   AVATAR SKILL · 48×56 chibi pixel-art SVG generator
   ─────────────────────────────────────────────────────────────
   Head-only chibi sprites in the same hand-crafted style as the
   seeded directors (avatars/socrates.svg, first-principles.svg, etc.):
     · rounded face (chamfered top + chin)
     · multi-tone skin shading (highlight / mid / shadow / outline)
     · varied hair styles + colours, glasses, eyebrows, mouth
     · neck stub at the bottom (no body / clothes)
   viewBox is `0 -4 48 56` so the head sits with breathing room
   at the top and the neck stub fades into the canvas bottom.

   Public API · window.AvatarSkill:
     generate(seed?, opts?)            → SVG markup string
     generateDataUrl(seed?, opts?)     → "data:image/svg+xml;…"
     randomSeed()                      → fresh seed string
     attach({ frame, button, onSeed }) → wire a UI in one line.

   opts.placeholder = true → neutral grey silhouette w/ "?".
   ═══════════════════════════════════════════════════════════════ */

(function () {
  if (window.AvatarSkill) return;

  // ── Constants ────────────────────────────────────────────
  const W = 48;
  const H = 56;
  // The visible Y range is -4..52. Internally we operate on 0..H
  // and serialize with viewBox="0 -4 48 56".

  // ── Palettes (multi-tone) ────────────────────────────────
  const SKIN = [
    { hl: "#FFE5C5", mid: "#F2B585", shadow: "#D69570", deep: "#A8704A", outline: "#5A3520" }, // peach
    { hl: "#FFCFA2", mid: "#E8B084", shadow: "#D69970", deep: "#B58050", outline: "#6E4830" }, // warm tan
    { hl: "#EFD0AC", mid: "#D6A878", shadow: "#B58858", deep: "#6E4830", outline: "#3F2818" }, // olive (chair)
    { hl: "#E5BFA0", mid: "#C68863", shadow: "#A86B47", deep: "#6F4528", outline: "#2A1A12" }, // medium
    { hl: "#C68863", mid: "#A86B47", shadow: "#8B5A3C", deep: "#5A3520", outline: "#1A0A05" }, // bronze
    { hl: "#A86B47", mid: "#8B5A3C", shadow: "#6F4528", deep: "#3A2014", outline: "#1A0A05" }, // deep
  ];

  // Each hair colour ships highlight / mid / shadow / outline.
  const HAIR = [
    { name: "black-blue",  hl: "#3A5A9C", mid: "#1F2A4A", shadow: "#0A0A1A", outline: "#0A0A1A", brow: "#0A0A1A" },
    { name: "dark-brown",  hl: "#5C3A22", mid: "#3A2418", shadow: "#1F1006", outline: "#0E0501", brow: "#1F1006" },
    { name: "chestnut",    hl: "#A05A2C", mid: "#7B4F2A", shadow: "#5C3A22", outline: "#2A1A0A", brow: "#5C3A22" },
    { name: "auburn",      hl: "#F5904A", mid: "#E26336", shadow: "#A8482A", outline: "#5A1808", brow: "#A8482A" },
    { name: "blonde",      hl: "#FFE072", mid: "#F2C037", shadow: "#C99826", outline: "#7A5A14", brow: "#A07820" },
    { name: "silver",      hl: "#FFFFFF", mid: "#C8C5BE", shadow: "#9C9890", outline: "#3A3A3A", brow: "#6E665F" },
    { name: "white",       hl: "#FFFFFF", mid: "#F0EDE5", shadow: "#DAD5C8", outline: "#6E665F", brow: "#DAD5C8" },
    { name: "red",         hl: "#FF6A38", mid: "#D44820", shadow: "#A8281A", outline: "#5A1808", brow: "#A8281A" },
    { name: "plum",        hl: "#A88BD1", mid: "#7B5AA8", shadow: "#5A3D8F", outline: "#2A1A4A", brow: "#5A3D8F" },
    { name: "navy",        hl: "#3E78C8", mid: "#2D3E66", shadow: "#1A2540", outline: "#0A1228", brow: "#1A2540" },
    { name: "ginger",      hl: "#F5A05A", mid: "#C46A2C", shadow: "#8E4818", outline: "#3F1F08", brow: "#8E4818" },
    { name: "mint",        hl: "#A8E5C8", mid: "#5DBE9A", shadow: "#2F7A60", outline: "#0E3A28", brow: "#2F7A60" },
  ];

  // Eye iris colors (shown when chance hits)
  const IRIS = [
    "#3E78C8", // sky blue
    "#7BA0E8", // pale blue
    "#5A8A4D", // green
    "#7A5A3A", // hazel
    "#C99826", // amber
    "#6A9B97", // cyan
    "#5C3A22", // brown
  ];

  // Glasses · 4 distinct shapes + 5 frame colors
  const GLASSES_FRAMES = [
    { rim: "#1A1A1A", hi: "#3A3A3A", name: "black" },
    { rim: "#2C4AAB", hi: "#7BA0E8", name: "royal-blue" },
    { rim: "#A87818", hi: "#F2C037", name: "gold" },
    { rim: "#7A4838", hi: "#A86B47", name: "tortoise" },
    { rim: "#9C9890", hi: "#E0DDD3", name: "silver" },
  ];

  // Beanie palettes (multi-tone)
  const BEANIES = [
    { name: "red",     hl: "#F5604A", mid: "#E03020", shadow: "#A82820", outline: "#5A0E08" },
    { name: "yellow",  hl: "#FFE560", mid: "#FFC830", shadow: "#C98818", outline: "#7A4F0A" },
    { name: "navy",    hl: "#3E78C8", mid: "#2D3E66", shadow: "#1A2540", outline: "#0A1228" },
    { name: "forest",  hl: "#5DBE3F", mid: "#2F7A24", shadow: "#1A4818", outline: "#0E2A0E" },
    { name: "plum",    hl: "#A88BD1", mid: "#7B5AA8", shadow: "#5A3D8F", outline: "#2A1A4A" },
    { name: "charcoal",hl: "#9C948C", mid: "#5A5A5A", shadow: "#3A3A3A", outline: "#1A1A1A" },
  ];

  // ── Pixel grid + RNG ─────────────────────────────────────
  function makeGrid() {
    const g = new Array(H);
    for (let y = 0; y < H; y++) g[y] = new Array(W).fill(null);
    return g;
  }
  function px(grid, x, y, color) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    grid[y][x] = color;
  }
  function fillRect(grid, x, y, w, h, color) {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) px(grid, x + dx, y + dy, color);
    }
  }

  function makeRng(seed) {
    let s = 0;
    const str = String(seed || "default");
    for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xFFFFFFFF;
    };
  }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
  function chance(rng, p) { return rng() < p; }
  function weighted(rng, items, weights) {
    let total = 0;
    for (const w of weights) total += w;
    let r = rng() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  // ── ROUNDED HEAD · skin fill + outline ───────────────────
  // Shape:
  //   y=10: 22w (top chamfer)   x=13..34
  //   y=11: 26w                 x=11..36
  //   y=12: 30w                 x=9..38
  //   y=13..29: full 30w main   x=9..38
  //   y=30: 30w
  //   y=31: 26w (chin chamfer)
  //   y=32: 22w (chin tip)
  function drawHead(grid, skin) {
    // outline silhouette
    fillRect(grid, 13, 10, 22, 1, skin.outline);
    fillRect(grid, 11, 11, 2,  1, skin.outline);
    fillRect(grid, 35, 11, 2,  1, skin.outline);
    fillRect(grid, 9,  12, 2,  1, skin.outline);
    fillRect(grid, 37, 12, 2,  1, skin.outline);
    fillRect(grid, 8,  13, 1, 17, skin.outline);
    fillRect(grid, 39, 13, 1, 17, skin.outline);
    fillRect(grid, 9,  30, 2,  1, skin.outline);
    fillRect(grid, 37, 30, 2,  1, skin.outline);
    fillRect(grid, 11, 31, 2,  1, skin.outline);
    fillRect(grid, 35, 31, 2,  1, skin.outline);
    fillRect(grid, 13, 32, 22, 1, skin.outline);
    // skin fill (rounded interior)
    fillRect(grid, 13, 10, 22,  1, skin.mid);
    fillRect(grid, 11, 11, 26,  1, skin.mid);
    fillRect(grid, 9,  12, 30,  1, skin.mid);
    fillRect(grid, 9,  13, 30, 17, skin.mid);
    fillRect(grid, 9,  30, 30,  1, skin.mid);
    fillRect(grid, 11, 31, 26,  1, skin.mid);
    fillRect(grid, 13, 32, 22,  1, skin.mid);
    // forehead highlight
    fillRect(grid, 13, 11, 22, 2, skin.hl);
    fillRect(grid, 14, 12, 20, 1, skin.hl);
    // temple shadow
    fillRect(grid, 9,  18, 2, 9, skin.deep);
    fillRect(grid, 37, 18, 2, 9, skin.deep);
    // cheekbone highlight
    fillRect(grid, 11, 22, 3, 3, skin.hl);
    fillRect(grid, 34, 22, 3, 3, skin.hl);
    // jaw shadow
    fillRect(grid, 11, 27, 26, 2, skin.shadow);
    fillRect(grid, 13, 29, 22, 2, skin.deep);
  }

  // ── HAIR STYLES ──────────────────────────────────────────
  function drawShortHair(grid, hair) {
    fillRect(grid, 14, 3, 20, 1, hair.outline);
    fillRect(grid, 11, 4, 26, 2, hair.shadow);
    fillRect(grid, 9,  6, 30, 2, hair.shadow);
    fillRect(grid, 9,  8, 30, 2, hair.mid);
    // sideburns (rounded around head edge)
    fillRect(grid, 9,  10, 2, 3, hair.shadow);
    fillRect(grid, 37, 10, 2, 3, hair.shadow);
    fillRect(grid, 11, 10, 2, 2, hair.shadow);
    fillRect(grid, 35, 10, 2, 2, hair.shadow);
    // sheen highlights
    fillRect(grid, 14, 5, 6, 1, hair.hl);
    fillRect(grid, 24, 5, 6, 1, hair.hl);
    fillRect(grid, 11, 7, 5, 1, hair.hl);
    fillRect(grid, 28, 7, 5, 1, hair.hl);
  }

  function drawSidePartHair(grid, hair) {
    fillRect(grid, 12, 3, 24, 1, hair.outline);
    fillRect(grid, 10, 4, 28, 1, hair.shadow);
    fillRect(grid, 9,  5, 30, 1, hair.shadow);
    fillRect(grid, 9,  6, 30, 2, hair.mid);
    fillRect(grid, 9,  8, 30, 2, hair.mid);
    fillRect(grid, 9,  10, 2, 3, hair.shadow);
    fillRect(grid, 37, 10, 2, 3, hair.shadow);
    fillRect(grid, 11, 10, 2, 2, hair.shadow);
    fillRect(grid, 35, 10, 2, 2, hair.shadow);
    // side parting line (clear strip)
    fillRect(grid, 16, 5, 1, 5, hair.hl);
    fillRect(grid, 17, 5, 6, 1, hair.hl);
    fillRect(grid, 25, 5, 5, 1, hair.hl);
  }

  function drawLongHair(grid, hair) {
    // top mass
    fillRect(grid, 11, 2, 26, 1, hair.shadow);
    fillRect(grid, 9,  3, 30, 1, hair.mid);
    fillRect(grid, 8,  4, 32, 2, hair.mid);
    fillRect(grid, 7,  6, 34, 3, hair.mid);
    fillRect(grid, 7,  9, 34, 2, hair.shadow);
    // side hair flowing past head
    fillRect(grid, 6,  11, 3, 20, hair.mid);
    fillRect(grid, 39, 11, 3, 20, hair.mid);
    fillRect(grid, 5,  14, 2, 17, hair.shadow);
    fillRect(grid, 41, 14, 2, 17, hair.shadow);
    // outline
    fillRect(grid, 4,  17, 1, 14, hair.outline);
    fillRect(grid, 43, 17, 1, 14, hair.outline);
    fillRect(grid, 11, 2, 1, 9, hair.outline);
    fillRect(grid, 36, 2, 1, 9, hair.outline);
    // highlights
    fillRect(grid, 13, 4, 4, 1, hair.hl);
    fillRect(grid, 22, 4, 5, 1, hair.hl);
    fillRect(grid, 32, 4, 3, 1, hair.hl);
  }

  function drawCurlyHair(grid, hair) {
    // top curl bumps (5 separate clusters)
    fillRect(grid, 11, 2, 3, 1, hair.outline);
    fillRect(grid, 16, 2, 3, 1, hair.outline);
    fillRect(grid, 22, 2, 3, 1, hair.outline);
    fillRect(grid, 28, 2, 3, 1, hair.outline);
    fillRect(grid, 33, 2, 3, 1, hair.outline);
    fillRect(grid, 9,  3, 30, 1, hair.shadow);
    fillRect(grid, 8,  4, 32, 2, hair.shadow);
    fillRect(grid, 7,  6, 34, 3, hair.mid);
    fillRect(grid, 7,  9, 34, 2, hair.hl);
    // side curls flowing past head
    fillRect(grid, 6,  11, 3, 18, hair.mid);
    fillRect(grid, 39, 11, 3, 18, hair.mid);
    fillRect(grid, 5,  14, 2, 14, hair.hl);
    fillRect(grid, 41, 14, 2, 14, hair.hl);
    // curl outline
    fillRect(grid, 4,  14, 1, 14, hair.outline);
    fillRect(grid, 43, 14, 1, 14, hair.outline);
    fillRect(grid, 5,  28, 2, 3, hair.outline);
    fillRect(grid, 41, 28, 2, 3, hair.outline);
    // Side texture bumps removed · for silver / white / blonde palettes
    // these isolated single pixels (each at hair.hl) read as bright
    // white speckles scattered around the head silhouette rather than
    // the curl detail they were meant to suggest. The continuous
    // .hl strip at (5, 14) / (41, 14) and the outline columns above
    // already carry enough texture without the discrete dots.
  }

  function drawAfroHair(grid, hair) {
    // big round puffy mass
    fillRect(grid, 13, 1, 22, 1, hair.outline);
    fillRect(grid, 11, 2, 26, 2, hair.shadow);
    fillRect(grid, 8,  4, 32, 2, hair.shadow);
    fillRect(grid, 6,  6, 36, 3, hair.mid);
    fillRect(grid, 6,  9, 36, 2, hair.mid);
    fillRect(grid, 5,  11, 4, 6, hair.mid);
    fillRect(grid, 39, 11, 4, 6, hair.mid);
    // bumps for texture
    fillRect(grid, 4,  13, 1, 4, hair.outline);
    fillRect(grid, 43, 13, 1, 4, hair.outline);
    fillRect(grid, 5,  17, 4, 1, hair.outline);
    fillRect(grid, 39, 17, 4, 1, hair.outline);
    // highlights (catching light at the top)
    fillRect(grid, 14, 3, 4, 1, hair.hl);
    fillRect(grid, 22, 3, 4, 1, hair.hl);
    fillRect(grid, 30, 3, 4, 1, hair.hl);
  }

  function drawBunHair(grid, hair) {
    // base hair around head
    fillRect(grid, 12, 4, 24, 1, hair.outline);
    fillRect(grid, 10, 5, 28, 1, hair.shadow);
    fillRect(grid, 9,  6, 30, 2, hair.mid);
    fillRect(grid, 9,  8, 30, 2, hair.mid);
    fillRect(grid, 9,  10, 2, 3, hair.shadow);
    fillRect(grid, 37, 10, 2, 3, hair.shadow);
    fillRect(grid, 11, 10, 2, 2, hair.shadow);
    fillRect(grid, 35, 10, 2, 2, hair.shadow);
    // bun on top
    fillRect(grid, 19, 0, 10, 1, hair.outline);
    fillRect(grid, 17, 1, 14, 2, hair.shadow);
    fillRect(grid, 18, 1, 12, 1, hair.mid);
    fillRect(grid, 18, 3, 12, 1, hair.shadow);
    fillRect(grid, 20, 1, 4, 1, hair.hl);
  }

  // Bald = nothing drawn (head shows through)
  function drawBaldHair(_grid, _hair) {}

  const HAIR_STYLES = {
    short:    drawShortHair,
    sidepart: drawSidePartHair,
    long:     drawLongHair,
    curly:    drawCurlyHair,
    afro:     drawAfroHair,
    bun:      drawBunHair,
    bald:     drawBaldHair,
  };

  // ── ACCESSORIES ──────────────────────────────────────────
  function drawBeanie(grid, beanie) {
    fillRect(grid, 14, 5, 20, 1, beanie.outline);
    fillRect(grid, 11, 6, 26, 1, beanie.shadow);
    fillRect(grid, 9,  7, 30, 1, beanie.shadow);
    fillRect(grid, 9,  8, 30, 3, beanie.mid);
    fillRect(grid, 9,  11, 30, 2, beanie.hl);
    fillRect(grid, 9,  13, 30, 3, beanie.shadow);
    // ribbing bars
    for (const x of [11, 14, 17, 20, 23, 26, 29, 32, 35]) {
      fillRect(grid, x, 13, 1, 3, beanie.outline);
    }
    fillRect(grid, 9,  6, 1, 10, beanie.outline);
    fillRect(grid, 38, 6, 1, 10, beanie.outline);
    fillRect(grid, 13, 9, 4, 1, beanie.hl);
    fillRect(grid, 22, 9, 4, 1, beanie.hl);
    // pom-pom
    fillRect(grid, 22, 1, 4, 1, "#8E8675");
    fillRect(grid, 21, 2, 6, 2, "#FFFFFF");
    fillRect(grid, 22, 4, 4, 1, "#E5E2D8");
    px(grid, 20, 3, "#B8B0A0");
    px(grid, 27, 3, "#B8B0A0");
  }

  function drawLaurel(grid) {
    // top leaves
    fillRect(grid, 22, 2, 4, 1, "#1A4818");
    fillRect(grid, 22, 3, 4, 1, "#2F7A24");
    fillRect(grid, 23, 4, 2, 1, "#5DBE3F");
    fillRect(grid, 16, 3, 3, 1, "#1A4818");
    fillRect(grid, 15, 4, 4, 1, "#2F7A24");
    fillRect(grid, 16, 5, 3, 1, "#4DA53D");
    fillRect(grid, 29, 3, 3, 1, "#1A4818");
    fillRect(grid, 29, 4, 4, 1, "#2F7A24");
    fillRect(grid, 29, 5, 3, 1, "#4DA53D");
    fillRect(grid, 9,  5, 3, 1, "#1A4818");
    fillRect(grid, 9,  6, 4, 1, "#2F7A24");
    fillRect(grid, 10, 7, 3, 1, "#4DA53D");
    fillRect(grid, 36, 5, 3, 1, "#1A4818");
    fillRect(grid, 35, 6, 4, 1, "#2F7A24");
    fillRect(grid, 35, 7, 3, 1, "#4DA53D");
    // circlet band
    fillRect(grid, 8,  8, 32, 1, "#0E2A0E");
    fillRect(grid, 7,  9, 34, 1, "#1A4818");
    fillRect(grid, 7,  10, 34, 2, "#2F7A24");
    fillRect(grid, 7,  12, 34, 1, "#4DA53D");
    fillRect(grid, 9,  11, 3, 1, "#5DBE3F");
    fillRect(grid, 14, 11, 3, 1, "#7CD850");
    fillRect(grid, 20, 11, 3, 1, "#5DBE3F");
    fillRect(grid, 26, 11, 3, 1, "#7CD850");
    fillRect(grid, 32, 11, 3, 1, "#5DBE3F");
    // berries
    for (const bx of [13, 22, 31]) {
      fillRect(grid, bx, 9, 2, 2, "#7A5A14");
      fillRect(grid, bx, 9, 2, 1, "#F2C037");
      px(grid, bx, 9, "#FFE072");
    }
  }

  function drawHeadband(grid, color) {
    fillRect(grid, 9,  10, 30, 2, color);
    fillRect(grid, 9,  10, 30, 1, "#FFFFFF");
  }

  function drawHat(grid, hair) {
    // top brim
    fillRect(grid, 11, 4, 26, 1, hair.outline);
    fillRect(grid, 9,  5, 30, 1, hair.shadow);
    // hat body
    fillRect(grid, 12, 6, 24, 5, hair.mid);
    fillRect(grid, 12, 6, 24, 1, hair.hl);
    // hat band
    fillRect(grid, 12, 9, 24, 1, hair.outline);
    // brim wide
    fillRect(grid, 6,  11, 36, 1, hair.outline);
    fillRect(grid, 7,  12, 34, 1, hair.shadow);
  }

  function drawHood(grid, color) {
    fillRect(grid, 9,  4, 30, 1, color);
    fillRect(grid, 7,  5, 34, 2, color);
    fillRect(grid, 6,  7, 36, 4, color);
    fillRect(grid, 5,  11, 4, 18, color);
    fillRect(grid, 39, 11, 4, 18, color);
    // outline
    fillRect(grid, 5,  4, 1, 25, "#1A1A1A");
    fillRect(grid, 42, 4, 1, 25, "#1A1A1A");
    // inner shadow
    fillRect(grid, 9,  10, 2, 18, "#000000");
    fillRect(grid, 37, 10, 2, 18, "#000000");
  }

  // ── EYEBROWS ─────────────────────────────────────────────
  function drawEyebrows(grid, hair, kind) {
    const c = hair.brow || hair.shadow;
    if (kind === "bushy") {
      fillRect(grid, 13, 19, 9, 1, c);
      fillRect(grid, 26, 19, 9, 1, c);
      fillRect(grid, 13, 20, 9, 1, hair.shadow);
      fillRect(grid, 26, 20, 9, 1, hair.shadow);
      // straggler hairs
      px(grid, 14, 18, hair.shadow);
      px(grid, 20, 18, hair.shadow);
      px(grid, 28, 18, hair.shadow);
      px(grid, 33, 18, hair.shadow);
    } else if (kind === "sharp") {
      fillRect(grid, 13, 19, 9, 1, c);
      fillRect(grid, 26, 19, 9, 1, c);
      fillRect(grid, 20, 20, 2, 1, c);
      fillRect(grid, 26, 20, 2, 1, c);
    } else if (kind === "raised") {
      fillRect(grid, 13, 19, 7, 1, c);
      fillRect(grid, 28, 19, 7, 1, c);
      fillRect(grid, 28, 18, 3, 1, c); // right brow lifted
    } else {
      // "soft" default
      fillRect(grid, 13, 19, 7, 1, c);
      fillRect(grid, 28, 19, 7, 1, c);
    }
  }

  // ── EYES ─────────────────────────────────────────────────
  function drawEyes(grid, irisColor, hasLashes) {
    // sclera
    fillRect(grid, 14, 21, 6, 3, "#FFFFFF");
    fillRect(grid, 28, 21, 6, 3, "#FFFFFF");
    // pupils
    fillRect(grid, 15, 21, 4, 3, "#1F1F1F");
    fillRect(grid, 29, 21, 4, 3, "#1F1F1F");
    // iris (smaller circle inside pupil)
    if (irisColor) {
      fillRect(grid, 15, 21, 2, 2, irisColor);
      fillRect(grid, 29, 21, 2, 2, irisColor);
    }
    // catchlight
    px(grid, 15, 21, "#FFFFFF");
    px(grid, 29, 21, "#FFFFFF");
    // upper lid line
    fillRect(grid, 14, 20, 6, 1, "#5A3520");
    fillRect(grid, 28, 20, 6, 1, "#5A3520");
    // lashes
    if (hasLashes) {
      px(grid, 13, 20, "#1F1F1F");
      px(grid, 19, 20, "#1F1F1F");
      px(grid, 27, 20, "#1F1F1F");
      px(grid, 33, 20, "#1F1F1F");
    }
  }

  // ── GLASSES ──────────────────────────────────────────────
  function drawSquareGlasses(grid, frame) {
    // left lens outline
    fillRect(grid, 11, 18, 11, 1, frame.rim);
    fillRect(grid, 11, 24, 11, 1, frame.rim);
    fillRect(grid, 11, 19, 1, 5, frame.rim);
    fillRect(grid, 21, 19, 1, 5, frame.rim);
    // right lens
    fillRect(grid, 26, 18, 11, 1, frame.rim);
    fillRect(grid, 26, 24, 11, 1, frame.rim);
    fillRect(grid, 26, 19, 1, 5, frame.rim);
    fillRect(grid, 36, 19, 1, 5, frame.rim);
    // bridge
    fillRect(grid, 22, 20, 4, 1, frame.rim);
    // temple arms
    fillRect(grid, 9,  20, 2, 1, frame.rim);
    fillRect(grid, 37, 20, 2, 1, frame.rim);
    // lens highlights
    fillRect(grid, 13, 19, 3, 1, frame.hi);
    fillRect(grid, 28, 19, 3, 1, frame.hi);
  }

  function drawRoundGlasses(grid, frame) {
    // big round Lennon-style
    // left lens (circular outline)
    fillRect(grid, 13, 20, 6, 1, frame.rim);
    fillRect(grid, 13, 24, 6, 1, frame.rim);
    fillRect(grid, 12, 21, 1, 3, frame.rim);
    fillRect(grid, 19, 21, 1, 3, frame.rim);
    // right lens
    fillRect(grid, 28, 20, 6, 1, frame.rim);
    fillRect(grid, 28, 24, 6, 1, frame.rim);
    fillRect(grid, 27, 21, 1, 3, frame.rim);
    fillRect(grid, 34, 21, 1, 3, frame.rim);
    // bridge
    fillRect(grid, 20, 22, 7, 1, frame.rim);
    // temple arms
    fillRect(grid, 9,  22, 3, 1, frame.rim);
    fillRect(grid, 35, 22, 3, 1, frame.rim);
    // lens shine
    px(grid, 14, 21, frame.hi);
    px(grid, 29, 21, frame.hi);
  }

  function drawWireRimGlasses(grid, frame) {
    // thin gold half-moon scholar style
    fillRect(grid, 14, 18, 6, 1, frame.rim);
    fillRect(grid, 14, 22, 6, 1, frame.rim);
    fillRect(grid, 13, 19, 1, 3, frame.rim);
    fillRect(grid, 20, 19, 1, 3, frame.rim);
    fillRect(grid, 28, 18, 6, 1, frame.rim);
    fillRect(grid, 28, 22, 6, 1, frame.rim);
    fillRect(grid, 27, 19, 1, 3, frame.rim);
    fillRect(grid, 34, 19, 1, 3, frame.rim);
    fillRect(grid, 21, 20, 6, 1, frame.rim);
    fillRect(grid, 11, 20, 2, 1, frame.rim);
    fillRect(grid, 35, 20, 2, 1, frame.rim);
    // shine
    fillRect(grid, 15, 18, 2, 1, frame.hi);
    fillRect(grid, 29, 18, 2, 1, frame.hi);
    px(grid, 14, 19, frame.hi);
    px(grid, 28, 19, frame.hi);
  }

  function drawTortoiseGlasses(grid, frame) {
    // rectangular thick frames
    fillRect(grid, 11, 18, 11, 1, "#2A1A12");
    fillRect(grid, 11, 23, 11, 1, "#2A1A12");
    fillRect(grid, 11, 19, 1, 4, "#2A1A12");
    fillRect(grid, 21, 19, 1, 4, "#2A1A12");
    fillRect(grid, 26, 18, 11, 1, "#2A1A12");
    fillRect(grid, 26, 23, 11, 1, "#2A1A12");
    fillRect(grid, 26, 19, 1, 4, "#2A1A12");
    fillRect(grid, 36, 19, 1, 4, "#2A1A12");
    fillRect(grid, 12, 18, 9, 1, frame.rim);
    fillRect(grid, 27, 18, 9, 1, frame.rim);
    fillRect(grid, 12, 19, 1, 4, frame.rim);
    fillRect(grid, 20, 19, 1, 4, frame.rim);
    fillRect(grid, 27, 19, 1, 4, frame.rim);
    fillRect(grid, 35, 19, 1, 4, frame.rim);
    fillRect(grid, 22, 20, 4, 1, frame.rim);
    fillRect(grid, 9,  20, 2, 1, "#2A1A12");
    fillRect(grid, 37, 20, 2, 1, "#2A1A12");
    fillRect(grid, 14, 19, 2, 1, frame.hi);
    fillRect(grid, 29, 19, 2, 1, frame.hi);
  }

  // ── NOSE ─────────────────────────────────────────────────
  function drawNose(grid, skin) {
    fillRect(grid, 22, 20, 4, 6, skin.mid);
    fillRect(grid, 22, 20, 1, 6, skin.hl);
    fillRect(grid, 22, 20, 1, 3, skin.hl);
    fillRect(grid, 25, 22, 1, 4, skin.shadow);
    fillRect(grid, 22, 26, 4, 1, skin.deep);
    px(grid, 21, 26, skin.deep);
    px(grid, 26, 26, skin.deep);
    px(grid, 23, 26, skin.outline);
  }

  // ── MOUTH ────────────────────────────────────────────────
  function drawMouth(grid, kind) {
    if (kind === "smile") {
      px(grid, 14, 27, "#A85040");
      px(grid, 33, 27, "#A85040");
      fillRect(grid, 15, 28, 18, 1, "#A85040");
      fillRect(grid, 16, 29, 16, 1, "#D67F5C");
      fillRect(grid, 22, 28, 4, 1, "#FFFFFF"); // tooth shine
    } else if (kind === "frown") {
      fillRect(grid, 18, 28, 12, 1, "#5A3520");
      px(grid, 17, 29, "#5A3520");
      px(grid, 30, 29, "#5A3520");
    } else if (kind === "smirk") {
      fillRect(grid, 17, 28, 14, 1, "#7A4838");
      fillRect(grid, 29, 29, 3, 1, "#7A4838");
      fillRect(grid, 18, 29, 13, 1, "#D67F5C");
    } else {
      // neutral
      fillRect(grid, 18, 28, 12, 1, "#5A4838");
    }
  }

  // ── BEARDS ───────────────────────────────────────────────
  function drawBeard(grid, kind) {
    if (kind === "white-full") {
      // mustache layer
      fillRect(grid, 13, 27, 9, 1, "#8E8675");
      fillRect(grid, 26, 27, 9, 1, "#8E8675");
      fillRect(grid, 12, 28, 11, 1, "#DAD5C8");
      fillRect(grid, 25, 28, 11, 1, "#DAD5C8");
      fillRect(grid, 11, 29, 13, 1, "#FFFFFF");
      fillRect(grid, 24, 29, 13, 1, "#FFFFFF");
      // beard cascading
      fillRect(grid, 9,  30, 1, 14, "#4D4538");
      fillRect(grid, 38, 30, 1, 14, "#4D4538");
      fillRect(grid, 11, 44, 2, 1, "#4D4538");
      fillRect(grid, 35, 44, 2, 1, "#4D4538");
      fillRect(grid, 13, 45, 22, 1, "#4D4538");
      fillRect(grid, 10, 30, 28, 14, "#F0EDE5");
      fillRect(grid, 13, 45, 22, 1, "#F0EDE5");
      fillRect(grid, 11, 30, 26, 2, "#FFFFFF");
      fillRect(grid, 10, 38, 28, 2, "#DAD5C8");
      fillRect(grid, 10, 40, 28, 2, "#B8B0A0");
      fillRect(grid, 10, 42, 28, 2, "#8E8675");
      // strands
      for (const sx of [13, 17, 20, 24, 27, 31, 34]) {
        fillRect(grid, sx, 32, 1, 12, sx % 7 === 0 ? "#DAD5C8" : "#B8B0A0");
      }
      fillRect(grid, 15, 31, 1, 3, "#FFFFFF");
      fillRect(grid, 22, 31, 1, 3, "#FFFFFF");
      fillRect(grid, 29, 31, 1, 3, "#FFFFFF");
    } else if (kind === "stubble") {
      // scattered shadow pixels along jaw
      for (let x = 12; x < 36; x += 2) {
        if ((x % 3) !== 0) px(grid, x, 27, "#5A3520");
        if ((x % 5) === 0) px(grid, x, 29, "#5A3520");
      }
      fillRect(grid, 12, 30, 24, 1, "#5A3520");
    } else if (kind === "goatee") {
      fillRect(grid, 19, 29, 10, 1, "#3A2418");
      fillRect(grid, 20, 30, 8, 2, "#3A2418");
      fillRect(grid, 21, 32, 6, 1, "#3A2418");
    }
    // null = no beard
  }

  // ── NECK STUB ────────────────────────────────────────────
  function drawNeck(grid, skin) {
    fillRect(grid, 19, 33, 10, 6, skin.mid);
    fillRect(grid, 19, 33, 10, 1, skin.deep);
    fillRect(grid, 19, 33, 1, 6, skin.deep);
    fillRect(grid, 28, 33, 1, 6, skin.deep);
    fillRect(grid, 20, 34, 8, 1, skin.hl);
    // collar shadow at bottom (suggesting clothing off-frame)
    for (let x = 14; x < 34; x++) px(grid, x, 39, skin.deep);
    fillRect(grid, 13, 41, 22, 3, skin.outline);
  }

  // ── PLACEHOLDER (?) ──────────────────────────────────────
  function drawPlaceholder(grid) {
    const placeholderSkin = { hl: "#6E6C63", mid: "#5E5C53", shadow: "#48463F", deep: "#38362F", outline: "#1F1E18" };
    drawHead(grid, placeholderSkin);
    drawNeck(grid, placeholderSkin);
    // "?" centered on the face
    const q = [
      "  XXXX  ",
      " X    X ",
      "      X ",
      "    XX  ",
      "    X   ",
      "        ",
      "    X   ",
    ];
    const ox = 20, oy = 17;
    for (let dy = 0; dy < q.length; dy++) {
      for (let dx = 0; dx < q[dy].length; dx++) {
        if (q[dy][dx] === "X") px(grid, ox + dx, oy + dy, "#1A1A18");
      }
    }
  }

  // ── MAIN GENERATE ────────────────────────────────────────
  function generate(seed, opts) {
    const placeholder = !!(opts && opts.placeholder);
    const grid = makeGrid();

    if (placeholder) {
      drawPlaceholder(grid);
      return svgFromGrid(grid);
    }

    const rng = makeRng(seed);

    // ── Pick features deterministically ────────────────
    const skin = pick(rng, SKIN);
    const hair = pick(rng, HAIR);

    // Hair style — bald rare, beanie/laurel/hat are accessories that
    // OVERRIDE hair, so they're picked separately.
    const hairStyles = ["short", "sidepart", "long", "curly", "afro", "bun"];
    const hairWeights = [4, 4, 2, 3, 1, 1];
    let hairStyle = weighted(rng, hairStyles, hairWeights);
    if (chance(rng, 0.05)) hairStyle = "bald";

    // Accessory roll · most agents have nothing on top.
    const accessoryRoll = rng();
    let accessory = null;
    if (accessoryRoll < 0.10)      accessory = "beanie";
    else if (accessoryRoll < 0.16) accessory = "laurel";
    else if (accessoryRoll < 0.22) accessory = "headband";
    else if (accessoryRoll < 0.27) accessory = "hat";
    else if (accessoryRoll < 0.30) accessory = "hood";

    // Eyewear — varied, slight bias toward having glasses.
    const eyewearRoll = rng();
    let eyewear = null;
    if (eyewearRoll < 0.20)      eyewear = "square";
    else if (eyewearRoll < 0.36) eyewear = "round";
    else if (eyewearRoll < 0.48) eyewear = "wire";
    else if (eyewearRoll < 0.58) eyewear = "tortoise";
    const glassesFrame = pick(rng, GLASSES_FRAMES);

    // Eyebrow style
    const browKinds = ["soft", "sharp", "bushy", "raised"];
    const browWeights = [4, 3, 2, 2];
    const brow = weighted(rng, browKinds, browWeights);

    // Mouth
    const mouth = weighted(rng, ["smile", "smile", "neutral", "frown", "smirk"], [3, 2, 3, 2, 2]);

    // Beard (only for some agents — bias to none)
    const beardKinds = [null, null, null, null, "stubble", "goatee", "white-full"];
    const beard = pick(rng, beardKinds);
    const mouthCovered = beard === "white-full";

    // Iris color
    const irisColor = chance(rng, 0.55) ? pick(rng, IRIS) : null;
    const hasLashes = chance(rng, 0.30);

    // ── Compose ───────────────────────────────────────
    drawHead(grid, skin);

    // Hair drawn first (so the head shape covers the face area)
    if (accessory === "beanie") {
      drawBeanie(grid, pick(rng, BEANIES));
    } else if (accessory === "hat") {
      drawHat(grid, hair);
    } else if (accessory === "hood") {
      drawHood(grid, hair);
    } else {
      const drawHair = HAIR_STYLES[hairStyle] || HAIR_STYLES.short;
      drawHair(grid, hair);
      if (accessory === "laurel")    drawLaurel(grid);
      if (accessory === "headband")  drawHeadband(grid, "#" + ((Math.floor(rng() * 0xFFFFFF)).toString(16)).padStart(6, "0"));
    }

    drawEyebrows(grid, hair, brow);

    if (eyewear === "square")        drawSquareGlasses(grid, glassesFrame);
    else if (eyewear === "round")    drawRoundGlasses(grid, glassesFrame);
    else if (eyewear === "wire")     drawWireRimGlasses(grid, glassesFrame);
    else if (eyewear === "tortoise") drawTortoiseGlasses(grid, glassesFrame);

    drawEyes(grid, irisColor, hasLashes);
    drawNose(grid, skin);
    if (!mouthCovered) drawMouth(grid, mouth);
    drawBeard(grid, beard);
    drawNeck(grid, skin);

    return svgFromGrid(grid);
  }

  function svgFromGrid(grid) {
    let rects = "";
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = grid[y][x];
        if (c) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${c}"/>`;
      }
    }
    return `<svg viewBox="0 -4 48 56" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet">${rects}</svg>`;
  }

  function generateDataUrl(seed, opts) {
    return "data:image/svg+xml;utf8," + encodeURIComponent(generate(seed, opts));
  }

  function randomSeed() {
    return Math.random().toString(36).slice(2, 12);
  }

  /** Wire a UI in one line:
   *  AvatarSkill.attach({ frame, button, onSeed }) */
  function attach({ frame, button, onSeed, initialSeed }) {
    if (!frame || !button) return;
    let seed = initialSeed || null;
    function paintFrame(nextSeed, opts) {
      seed = nextSeed;
      frame.innerHTML = generate(nextSeed, opts);
      if (typeof onSeed === "function") onSeed(seed);
    }
    if (seed) paintFrame(seed);
    else paintFrame("__placeholder__", { placeholder: true });
    button.addEventListener("click", (e) => {
      e.preventDefault();
      paintFrame(randomSeed());
    });
  }

  window.AvatarSkill = {
    generate,
    generateDataUrl,
    randomSeed,
    attach,
  };
})();
