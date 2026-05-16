/* ═══════════════════════════════════════════════════════════════
   AVATAR SKILL · BRICK pet generator
   ─────────────────────────────────────────────────────────────
   Composable 8-bit pixel-art mascots based on the BRICK silhouette
   (chunky terracotta block + stub legs + tool belt). Five dimensions
   combined by seed:

     · body color   (12)  — terracotta default; chair always terracotta
     · glasses      (9)   — none, round, horn, monocle, sun, aviator,
                            cyber-visor, pince-nez, 3d
     · mustache     (10)  — clean, handlebar, walrus, pencil, chevron,
                            horseshoe, imperial, soul-patch, goatee, full
     · expression   (7)   — default, focused, wink, surprised, sleepy,
                            side-look, happy
     · prop         (9)   — none, coffee, notebook, magnifier, lightbulb,
                            gavel, scroll, pen, lantern
                            (held in front of body, doesn't break silhouette)

   Hats were deliberately removed — hatted vs. un-hatted avatars made
   the rendered head size inconsistent (per-avatar viewBox includes
   the hat in its bbox, so the body shrank inside the fixed-size
   container). Now every avatar has identical content bounds → body
   size is stable across the whole sidebar.

   Public API · window.AvatarSkill:
     generate(seed?, opts?)            → SVG markup string
     generateDataUrl(seed?, opts?)     → "data:image/svg+xml;…"
     randomSeed()                      → fresh seed string
     attach({ frame, button, onSeed }) → wire a UI in one line.

   opts.placeholder = true → grey silhouette w/ "?".
   opts.variant = "classic" → forces CLASSIC (default expression + clean
                              + no glasses / mustache / prop, terracotta).
                              Used by chair.svg.

   Grid: 32×32 cells, 16px each, viewBox computed per-avatar.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  if (window.AvatarSkill) return;

  // ── Grid constants ───────────────────────────────────────
  const GRID = 32;
  const PX = 16;
  const SIZE = GRID * PX; // 512

  // ── Body color palettes (12) ─────────────────────────────
  // Each: { name, base, hi, sh, deep, eye, belt, buckle }
  const BODY_COLORS = [
    { name: "terracotta",  base: "#a35a32", hi: "#ce8a5a", sh: "#6e3814", deep: "#3e1c08", eye: "#1a0805", belt: "#5a2a10", buckle: "#cfb56a" },
    { name: "slate",       base: "#5a6f88", hi: "#8294aa", sh: "#3a4e64", deep: "#202d3e", eye: "#15101c", belt: "#2a3848", buckle: "#c0c8d8" },
    { name: "moss",        base: "#5a7a3a", hi: "#8aaa5a", sh: "#3a5418", deep: "#1a2a08", eye: "#15140c", belt: "#2a3a18", buckle: "#d4c870" },
    { name: "plum",        base: "#6a3a6a", hi: "#9a5a9a", sh: "#3a1a3a", deep: "#1a081a", eye: "#15081a", belt: "#2a142a", buckle: "#d4a8d8" },
    { name: "dusty-rose",  base: "#c47a7a", hi: "#e8a8a8", sh: "#8a4848", deep: "#5a2828", eye: "#2a1414", belt: "#6a3a3a", buckle: "#e8c8a8" },
    { name: "mustard",     base: "#c4a040", hi: "#e8c870", sh: "#886820", deep: "#4a3808", eye: "#2a1c05", belt: "#685428", buckle: "#e8d8a8" },
    { name: "charcoal",    base: "#4a4a52", hi: "#6a6a78", sh: "#2a2a32", deep: "#15151a", eye: "#08080c", belt: "#1a1a22", buckle: "#a8a8b0" },
    { name: "copper",      base: "#b86a3a", hi: "#e08a5a", sh: "#7a3a18", deep: "#3a1a08", eye: "#1a0805", belt: "#5a2810", buckle: "#f5d870" },
    { name: "teal",        base: "#3a8a8a", hi: "#5aaaaa", sh: "#1a4848", deep: "#082828", eye: "#051818", belt: "#1a3838", buckle: "#c8e8d8" },
    { name: "burgundy",    base: "#7a2828", hi: "#a85050", sh: "#4a1010", deep: "#1a0808", eye: "#15050a", belt: "#380a0a", buckle: "#d8a8a8" },
    { name: "amber",       base: "#d4923a", hi: "#f5b85a", sh: "#8a5818", deep: "#4a2808", eye: "#1c0d05", belt: "#6a3a10", buckle: "#fff0a8" },
    { name: "navy",        base: "#2a4a78", hi: "#4a6aa8", sh: "#15284a", deep: "#08152a", eye: "#050a18", belt: "#15203a", buckle: "#c0d0e8" },
  ];

  // ── RNG ──────────────────────────────────────────────────
  function makeRng(seed) {
    let s = 0;
    const str = String(seed || "default");
    for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xFFFFFFFF;
    };
  }
  const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
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

  // ── Pixel grid ───────────────────────────────────────────
  function makeGrid() {
    const g = new Array(GRID);
    for (let y = 0; y < GRID; y++) g[y] = new Array(GRID).fill(null);
    return g;
  }
  function px(g, x, y, c) {
    if (x < 0 || x >= GRID || y < 0 || y >= GRID) return;
    g[y][x] = c;
  }
  function row(g, r, c1, c2, c) {
    for (let x = c1; x <= c2; x++) px(g, x, r, c);
  }
  function colp(g, c, r1, r2, color) {
    for (let y = r1; y <= r2; y++) px(g, c, y, color);
  }
  function rect(g, x, y, w, h, c) {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) px(g, x + dx, y + dy, c);
  }

  // ════════════════════════════════════════════════════════
  // BRICK BODY  (rows 10-22, cols 10-21)
  // ════════════════════════════════════════════════════════

  const BODY_SHAPE = [
    [10, 12, 19], [11, 11, 20], [12, 10, 21], [13, 10, 21],
    [14, 10, 21], [15, 10, 21], [16, 10, 21], [17, 10, 21],
    [18, 10, 21], [19, 10, 21], [20, 11, 20],
  ];

  function drawBody(g, p) {
    for (const [r, c1, c2] of BODY_SHAPE) row(g, r, c1, c2, p.base);
    // Stub legs
    rect(g, 12, 21, 2, 2, p.base);
    rect(g, 18, 21, 2, 2, p.base);
    // Foot bottom
    row(g, 22, 12, 13, p.deep);
    row(g, 22, 18, 19, p.deep);
    // Top-left highlight
    [[12,10],[13,10],[11,11],[12,11],[10,12],[11,12]].forEach(([x,y])=>px(g,x,y,p.hi));
    // Bottom-right shadow
    [[20,17],[21,17],[20,18],[21,18],[19,19],[20,19],[20,20]].forEach(([x,y])=>px(g,x,y,p.sh));
    px(g, 19, 21, p.sh);
    // Tool belt
    row(g, 17, 10, 21, p.belt);
    px(g, 15, 17, p.buckle);
    px(g, 16, 17, p.buckle);
  }

  // ════════════════════════════════════════════════════════
  // EXPRESSIONS  (eyes + brows; row 12-14)
  // ════════════════════════════════════════════════════════

  const EXPRESSIONS = {
    // Default: angled inward brows + dot eyes (the OG BRICK look)
    default(g, p) {
      px(g, 12, 12, p.eye); px(g, 13, 13, p.eye);
      px(g, 19, 12, p.eye); px(g, 18, 13, p.eye);
      px(g, 13, 14, p.eye); px(g, 18, 14, p.eye);
    },
    // Focused: flat brows + narrowed eyes
    focused(g, p) {
      row(g, 12, 12, 14, p.eye);
      row(g, 12, 17, 19, p.eye);
      px(g, 13, 14, p.eye); px(g, 14, 14, p.eye);
      px(g, 17, 14, p.eye); px(g, 18, 14, p.eye);
    },
    // Wink: left eye dot, right eye closed line
    wink(g, p) {
      px(g, 12, 12, p.eye); px(g, 13, 13, p.eye);
      px(g, 19, 12, p.eye); px(g, 18, 13, p.eye);
      px(g, 13, 14, p.eye);
      row(g, 14, 17, 19, p.eye);  // closed wink line
    },
    // Surprised: raised brows + bigger eyes (2x2)
    surprised(g, p) {
      row(g, 11, 12, 14, p.eye);
      row(g, 11, 17, 19, p.eye);
      rect(g, 13, 13, 1, 2, p.eye);
      rect(g, 18, 13, 1, 2, p.eye);
    },
    // Sleepy: low brows + closed-line eyes
    sleepy(g, p) {
      px(g, 12, 13, p.eye); px(g, 13, 13, p.eye);
      px(g, 18, 13, p.eye); px(g, 19, 13, p.eye);
      row(g, 14, 12, 14, p.eye);
      row(g, 14, 17, 19, p.eye);
    },
    // Side-look: eyes shifted right
    sideLook(g, p) {
      px(g, 12, 12, p.eye); px(g, 13, 13, p.eye);
      px(g, 19, 12, p.eye); px(g, 18, 13, p.eye);
      px(g, 14, 14, p.eye); px(g, 19, 14, p.eye);
    },
    // Happy: ^_^ curved-up eyes
    happy(g, p) {
      // brow tips up
      px(g, 12, 12, p.eye); px(g, 13, 12, p.eye);
      px(g, 18, 12, p.eye); px(g, 19, 12, p.eye);
      // ^_^
      px(g, 12, 14, p.eye); px(g, 14, 14, p.eye); px(g, 13, 13, p.eye);
      px(g, 17, 14, p.eye); px(g, 19, 14, p.eye); px(g, 18, 13, p.eye);
    },
  };

  // ════════════════════════════════════════════════════════
  // GLASSES  (rows 12-15)
  // ════════════════════════════════════════════════════════

  const GLASSES = {
    none(g, p) {},

    round(g, p) {
      const F = "#c9a040";
      px(g, 13, 13, F); px(g, 13, 15, F); px(g, 12, 14, F); px(g, 14, 14, F);
      px(g, 18, 13, F); px(g, 18, 15, F); px(g, 17, 14, F); px(g, 19, 14, F);
      px(g, 15, 14, F); px(g, 16, 14, F);
      px(g, 13, 13, "#ffd870"); px(g, 18, 13, "#ffd870");
    },

    horn(g, p) {
      const F = "#0a0512";
      row(g, 13, 12, 14, F); row(g, 15, 12, 14, F);
      px(g, 12, 14, F); px(g, 14, 14, F);
      row(g, 13, 17, 19, F); row(g, 15, 17, 19, F);
      px(g, 17, 14, F); px(g, 19, 14, F);
      row(g, 14, 15, 16, F);
    },

    monocle(g, p) {
      const F = "#c9a040";
      row(g, 12, 17, 18, F); row(g, 16, 17, 18, F);
      colp(g, 16, 13, 15, F); colp(g, 19, 13, 15, F);
      px(g, 17, 12, "#ffd870");
      // Chain hanging down
      px(g, 20, 14, "#7a5a18");
      px(g, 20, 15, F);
      px(g, 21, 15, "#7a5a18");
      px(g, 21, 16, F);
    },

    sun(g, p) {
      const F = "#0a0512";
      rect(g, 12, 13, 3, 3, "#15101c");
      rect(g, 17, 13, 3, 3, "#15101c");
      row(g, 12, 12, 14, F); row(g, 12, 17, 19, F);
      row(g, 14, 15, 16, F);
      px(g, 12, 13, "#3ad4e0"); px(g, 17, 13, "#3ad4e0");
    },

    aviator(g, p) {
      // Teardrop shape, gold
      const F = "#c9a040";
      // Left lens
      row(g, 13, 12, 14, F);
      px(g, 12, 14, F); px(g, 14, 14, F);
      px(g, 13, 15, F); px(g, 14, 15, F);
      // Right lens
      row(g, 13, 17, 19, F);
      px(g, 17, 14, F); px(g, 19, 14, F);
      px(g, 17, 15, F); px(g, 18, 15, F);
      // Bridge
      px(g, 15, 13, F); px(g, 16, 13, F);
      // Sheen
      px(g, 13, 13, "#ffd870"); px(g, 18, 13, "#ffd870");
    },

    visor(g, p) {
      // Cyber horizontal slit
      rect(g, 11, 13, 10, 3, "#15101c");
      row(g, 14, 12, 19, "#3ad4e0");
      px(g, 13, 14, "#aaf0f8"); px(g, 18, 14, "#aaf0f8");
      px(g, 11, 13, "#3a3445"); px(g, 20, 15, "#3a3445");
    },

    pince(g, p) {
      // Pince-nez: small lenses on nose, no temples, with chain
      px(g, 13, 14, "#5a5a5a"); px(g, 13, 13, "#5a5a5a");
      px(g, 14, 14, "#5a5a5a");
      px(g, 17, 14, "#5a5a5a"); px(g, 18, 13, "#5a5a5a");
      px(g, 18, 14, "#5a5a5a");
      px(g, 15, 14, "#5a5a5a"); px(g, 16, 14, "#5a5a5a");
      // Small chain to side
      px(g, 11, 15, "#5a5a5a");
      px(g, 11, 16, "#5a5a5a");
    },

    "3d"(g, p) {
      // Red + blue 3D glasses
      rect(g, 12, 13, 3, 3, "#c8281a");
      rect(g, 17, 13, 3, 3, "#3a78c8");
      row(g, 12, 12, 14, "#0a0512"); row(g, 12, 17, 19, "#0a0512");
      row(g, 14, 15, 16, "#0a0512");
      px(g, 12, 13, "#f25a3a"); px(g, 17, 13, "#7ba8e8");
    },
  };

  // ════════════════════════════════════════════════════════
  // MUSTACHES / BEARDS  (rows 15-16, careful w/ belt at 17)
  // ════════════════════════════════════════════════════════

  const MUSTACHES = {
    clean(g, p) {},

    handlebar(g, p) {
      const c = "#2a1408";
      row(g, 16, 13, 18, c);
      px(g, 14, 15, c); px(g, 17, 15, c);
      px(g, 12, 15, c); px(g, 11, 15, c);
      px(g, 19, 15, c); px(g, 20, 15, c);
      px(g, 15, 16, "#5a3018"); px(g, 16, 16, "#5a3018");
    },

    walrus(g, p) {
      const c = "#2a1408", cd = "#15080a";
      row(g, 15, 12, 19, c);
      row(g, 16, 11, 20, c);
      px(g, 11, 17, c); px(g, 20, 17, c);
      row(g, 16, 14, 17, cd);
    },

    pencil(g, p) {
      row(g, 15, 14, 17, "#2a1408");
    },

    chevron(g, p) {
      const c = "#2a1408", cd = "#15080a";
      row(g, 15, 13, 18, c);
      row(g, 16, 13, 18, c);
      px(g, 13, 16, cd); px(g, 18, 16, cd);
    },

    horseshoe(g, p) {
      const c = "#2a1408";
      row(g, 15, 13, 18, c);
      row(g, 16, 13, 18, c);
      px(g, 13, 17, c); px(g, 18, 17, c);
    },

    imperial(g, p) {
      // Big curls way up at the ends
      const c = "#2a1408";
      row(g, 16, 14, 17, c);
      // Curls up to row 14 / 13
      px(g, 13, 15, c); px(g, 12, 14, c); px(g, 11, 13, c); px(g, 11, 14, c);
      px(g, 18, 15, c); px(g, 19, 14, c); px(g, 20, 13, c); px(g, 20, 14, c);
    },

    soulPatch(g, p) {
      // Small tuft just under lip
      const c = "#2a1408";
      row(g, 16, 15, 16, c);
      px(g, 15, 15, c);
    },

    goatee(g, p) {
      // Chin + jaw line
      const c = "#2a1408";
      row(g, 16, 14, 17, c);
      px(g, 13, 16, c); px(g, 18, 16, c);
      // Sides going down to body bottom edge
      colp(g, 13, 16, 19, c);
      colp(g, 18, 16, 19, c);
      row(g, 19, 14, 17, c);
    },

    fullBeard(g, p) {
      // Covers lower face cols 11-20, rows 15-19
      const c = "#2a1408", cd = "#15080a";
      row(g, 15, 12, 19, c);
      row(g, 16, 11, 20, c);
      // Sideburns
      colp(g, 11, 15, 18, c);
      colp(g, 20, 15, 18, c);
      // Chin extension
      row(g, 18, 13, 18, c);
      row(g, 19, 14, 17, c);
      // Mustache shadow
      row(g, 16, 14, 17, cd);
    },
  };

  // ════════════════════════════════════════════════════════
  // PROPS  (held in front of body, rows 17-21 area)
  // Drawn LAST so they appear on top.
  // ════════════════════════════════════════════════════════

  const PROPS = {
    none(g, p) {},

    coffee(g, p) {
      // Mug w/ handle, in front of belt
      rect(g, 13, 18, 4, 4, "#2a1a14");      // mug body
      rect(g, 13, 18, 4, 1, "#5a3a2a");      // top rim
      // Coffee surface (steam-y dark brown)
      px(g, 14, 18, "#1a0a05"); px(g, 15, 18, "#1a0a05");
      // Handle
      px(g, 17, 19, "#2a1a14"); px(g, 17, 20, "#2a1a14");
      // Steam
      px(g, 14, 17, "#dad5c8"); px(g, 15, 16, "#dad5c8");
      // Highlight
      px(g, 13, 19, "#5a3a2a");
    },

    notebook(g, p) {
      // Open notebook / clipboard
      rect(g, 12, 18, 8, 4, "#f1dfc4");      // paper
      // Lines on paper
      row(g, 19, 13, 18, "#7a5a3a");
      row(g, 20, 13, 18, "#7a5a3a");
      // Clip on top
      rect(g, 14, 18, 4, 1, "#5a5a5a");
      px(g, 15, 17, "#5a5a5a"); px(g, 16, 17, "#5a5a5a");
      // Edge shadow
      colp(g, 19, 18, 21, "#c9b58a");
    },

    magnifier(g, p) {
      // Circle lens + handle
      // Lens ring
      row(g, 17, 13, 15, "#5a3a18");
      row(g, 19, 13, 15, "#5a3a18");
      px(g, 12, 18, "#5a3a18"); px(g, 16, 18, "#5a3a18");
      // Lens glass
      px(g, 13, 18, "#aaf0f8"); px(g, 14, 18, "#aaf0f8"); px(g, 15, 18, "#aaf0f8");
      px(g, 13, 17, "#ffffff"); // sparkle
      // Handle (going down-right)
      px(g, 16, 19, "#5a3a18"); px(g, 17, 20, "#5a3a18"); px(g, 18, 21, "#5a3a18");
    },

    lightbulb(g, p) {
      // Bulb above body w/ glow
      // Glow
      px(g, 16, 16, "#fff5b0");
      px(g, 14, 17, "#fff5b0"); px(g, 18, 17, "#fff5b0");
      // Bulb
      rect(g, 15, 18, 3, 3, "#ffe070");
      px(g, 14, 19, "#ffe070"); px(g, 18, 19, "#ffe070");
      // Bulb highlight
      px(g, 15, 18, "#ffffff");
      // Base / screw cap
      row(g, 21, 15, 17, "#5a5a5a");
    },

    gavel(g, p) {
      // Wooden gavel
      // Hammer head (horizontal block)
      rect(g, 12, 18, 4, 2, "#7a5a3a");
      px(g, 12, 18, "#a87a4a"); px(g, 13, 18, "#a87a4a");
      px(g, 15, 19, "#3a2a18");
      // Handle (diagonal)
      px(g, 16, 20, "#5a3a18"); px(g, 17, 21, "#5a3a18");
      // Strike plate small block underneath
      px(g, 14, 21, "#3a2a18"); px(g, 15, 21, "#3a2a18");
    },

    scroll(g, p) {
      // Rolled paper held diagonally
      rect(g, 13, 18, 6, 3, "#f1dfc4");      // paper
      row(g, 19, 14, 17, "#a87a4a");          // text line
      // Roll ends (darker)
      colp(g, 13, 18, 20, "#c9b58a");
      colp(g, 18, 18, 20, "#c9b58a");
      // Cap end caps (rounded curls)
      px(g, 12, 18, "#a87a4a"); px(g, 12, 20, "#a87a4a");
      px(g, 19, 18, "#a87a4a"); px(g, 19, 20, "#a87a4a");
    },

    pen(g, p) {
      // Diagonal pen
      px(g, 12, 21, "#15101c");
      px(g, 13, 20, "#15101c");
      px(g, 14, 19, "#15101c");
      px(g, 15, 18, "#3a3a44");      // body
      px(g, 16, 17, "#3a3a44");
      px(g, 17, 16, "#cfa040");      // gold cap end
      px(g, 18, 16, "#cfa040");
      // Tip ink dot
      px(g, 11, 21, "#15101c");
    },

    lantern(g, p) {
      // Box w/ handle
      rect(g, 13, 18, 4, 4, "#3a3a44");      // frame
      rect(g, 14, 19, 2, 2, "#ffe070");      // glow
      px(g, 14, 19, "#ffffff");
      // Top handle
      row(g, 17, 14, 15, "#5a5a5a");
      px(g, 14, 18, "#5a5a5a"); px(g, 15, 18, "#5a5a5a");
      // Bottom shadow
      row(g, 22, 13, 16, "#15101c");
    },
  };

  // ════════════════════════════════════════════════════════
  // PLACEHOLDER  (grey BRICK + "?")
  // ════════════════════════════════════════════════════════

  function drawPlaceholder(g) {
    const p = { name: "placeholder", base: "#5a5a5a", hi: "#7a7a7a", sh: "#3a3a3a", deep: "#1a1a1a", eye: "#15151a", belt: "#2a2a2a", buckle: "#a0a0a0" };
    drawBody(g, p);
    // "?" centered on face area (rows 12-15)
    const q = ["XXXX", "X  X", "  XX", "  X ", "    ", "  X "];
    const ox = 13, oy = 11;
    for (let dy = 0; dy < q.length; dy++)
      for (let dx = 0; dx < q[dy].length; dx++)
        if (q[dy][dx] === "X") px(g, ox + dx, oy + dy, "#fafafa");
  }

  // ════════════════════════════════════════════════════════
  // GENERATE
  // ════════════════════════════════════════════════════════

  const GLASSES_NAMES = Object.keys(GLASSES);
  const MUSTACHE_NAMES = Object.keys(MUSTACHES);
  const EXPRESSION_NAMES = Object.keys(EXPRESSIONS);
  const PROP_NAMES = Object.keys(PROPS);

  function generate(seed, opts) {
    const o = opts || {};
    const grid = makeGrid();

    if (o.placeholder) {
      drawPlaceholder(grid);
      return svgFromGrid(grid);
    }

    // CLASSIC: locked terracotta + no accessories (chair)
    if (o.variant === "classic") {
      const pal = BODY_COLORS[0]; // terracotta
      drawBody(grid, pal);
      EXPRESSIONS.default(grid, pal);
      return svgFromGrid(grid);
    }

    const rng = makeRng(seed);

    // Body color — bias slightly toward terracotta + warm earthy tones
    const bodyWeights = [4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
    const palette = weighted(rng, BODY_COLORS, bodyWeights);

    // Glasses — slight bias toward none / common shapes
    const glassWeights = [4, 2, 2, 1, 2, 1, 1, 1, 1];
    const glassName = weighted(rng, GLASSES_NAMES, glassWeights);

    // Mustache — most have none
    const stachWeights = [5, 2, 2, 2, 2, 1, 1, 1, 2, 1];
    const stachName = weighted(rng, MUSTACHE_NAMES, stachWeights);

    // Expression — default common, others rare
    const exprWeights = [5, 2, 1, 1, 1, 1, 2];
    const exprName = weighted(rng, EXPRESSION_NAMES, exprWeights);

    // Prop — most have none
    const propWeights = [10, 1, 1, 1, 1, 1, 1, 1, 1];
    const propName = weighted(rng, PROP_NAMES, propWeights);

    // ── Compose · order matters ───────────────────────────
    drawBody(grid, palette);

    // Expression (eyes + brows) — drawn before glasses so glasses overlay
    EXPRESSIONS[exprName](grid, palette);

    // Glasses sit on top of eyes
    GLASSES[glassName](grid, palette);

    // Mustache below eyes
    MUSTACHES[stachName](grid, palette);

    // Prop drawn very last — held in front of body
    PROPS[propName](grid, palette);

    return svgFromGrid(grid);
  }

  // ════════════════════════════════════════════════════════
  // SVG SERIALIZATION
  // ════════════════════════════════════════════════════════

  // Per-avatar viewBox: scan the drawn pixels for their actual bounding
  // box, then emit a square viewBox centered on that content with 1-cell
  // padding. This auto-centers every avatar regardless of hat presence
  // (CLASSIC chair fills its frame, wizard-hatted seats fit hat + body
  // without the body being shoved against the bottom edge).
  function svgFromGrid(grid) {
    let minX = GRID, maxX = -1, minY = GRID, maxY = -1;
    let rects = "";
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const c = grid[y][x];
        if (!c) continue;
        rects += `<rect x="${x * PX}" y="${y * PX}" width="${PX}" height="${PX}" fill="${c}"/>`;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) {
      return `<svg viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"/>`;
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const sz = Math.max(w, h) + 4;            // +4 cells = 2 cells padding each side
    const cx = (minX + maxX + 1) / 2;          // content center in cell coords
    const cy = (minY + maxY + 1) / 2;
    const vbX = (cx - sz / 2) * PX;
    const vbY = (cy - sz / 2) * PX;
    const vbSize = sz * PX;
    return `<svg viewBox="${vbX} ${vbY} ${vbSize} ${vbSize}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet">${rects}</svg>`;
  }

  function generateDataUrl(seed, opts) {
    return "data:image/svg+xml;utf8," + encodeURIComponent(generate(seed, opts));
  }

  function randomSeed() {
    return Math.random().toString(36).slice(2, 12);
  }

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
