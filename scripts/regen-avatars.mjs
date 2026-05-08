/**
 * Regenerate the seeded avatars using public/avatar-skill.js.
 *
 * The hand-crafted SVGs in public/avatars/*.svg accumulated stray
 * highlight pixels ("white noise") from earlier iterations of the
 * laurel / beard / glasses art. The AvatarSkill generator produces
 * cleaner pixel-art for the same set of directors when seeded by
 * the director's id (so the output is reproducible).
 *
 * Run · `node scripts/regen-avatars.mjs`
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const skillPath = join(repoRoot, "public", "avatar-skill.js");
const avatarsDir = join(repoRoot, "public", "avatars");

// Load the IIFE-style skill into a fake window so its public API
// (AvatarSkill.generate / generateDataUrl) lands on globalThis.
const skillSource = readFileSync(skillPath, "utf8");
globalThis.window = globalThis.window || globalThis;
// eslint-disable-next-line no-eval
eval(skillSource);
const AvatarSkill = globalThis.window.AvatarSkill;
if (!AvatarSkill || typeof AvatarSkill.generate !== "function") {
  throw new Error("avatar-skill.js did not expose window.AvatarSkill.generate");
}

// Director ids in directors.ts + chair · seed deterministically by id
// so re-runs produce the same artwork. Add new entries here when a
// new seed director ships.
const SEEDS = [
  { id: "socrates",          file: "socrates.svg" },
  { id: "first-principles",  file: "first-principles.svg" },
  { id: "value-investor",    file: "value-investor.svg" },
  { id: "historian",         file: "historian.svg" },
  { id: "user-empathy",      file: "user-empathy.svg" },
  { id: "long-horizon",      file: "long-horizon.svg" },
  { id: "phenomenologist",   file: "phenomenologist.svg" },
  { id: "chair",             file: "chair.svg" },
];

/** Strip any isolated white pixel (`#FFFFFF`, `#fff`) that has no
 *  cardinal-neighbour pixels of the same colour. The skill places
 *  intentional white runs (eye highlights, tooth shine, beard) as
 *  multi-cell rects, so they never read as "noise" — only stray
 *  1×1 white cells with empty neighbours do. This pass is defensive:
 *  if the generator ever leaks a stray white, this trims it before
 *  the SVG ships. */
function stripIsolatedWhite(svg) {
  // Parse `<rect x=".." y=".." width="1" height="1" fill="#FFFFFF"/>`
  // entries into a set keyed by "x,y".
  const whiteCells = new Set();
  const allCells = new Map(); // "x,y" → fill
  const rectRe = /<rect x="(\d+)" y="(\d+)" width="1" height="1" fill="(#[0-9A-Fa-f]{3,6})"\/>/g;
  let m;
  while ((m = rectRe.exec(svg))) {
    const key = `${m[1]},${m[2]}`;
    allCells.set(key, m[3]);
    if (/^#(?:FFFFFF|fff|FFF)$/i.test(m[3])) whiteCells.add(key);
  }
  const isolated = new Set();
  for (const key of whiteCells) {
    const [x, y] = key.split(",").map(Number);
    const neighbours = [
      `${x - 1},${y}`, `${x + 1},${y}`, `${x},${y - 1}`, `${x},${y + 1}`,
    ];
    // White cell is "supported" if it has at least one cardinal
    // neighbour that's also white OR is a face/hair fill (not
    // empty). Stray ones (no neighbour at all) get dropped.
    const supported = neighbours.some((n) => allCells.has(n));
    if (!supported) isolated.add(key);
  }
  if (isolated.size === 0) return svg;
  const cleaned = svg.replace(rectRe, (frag, x, y, fill) => {
    return isolated.has(`${x},${y}`) ? "" : frag;
  });
  return cleaned;
}

let total = 0;
let stripped = 0;
for (const seed of SEEDS) {
  const raw = AvatarSkill.generate(seed.id);
  const cleaned = stripIsolatedWhite(raw);
  if (cleaned.length < raw.length) stripped += 1;
  const out = join(avatarsDir, seed.file);
  writeFileSync(out, cleaned + "\n", "utf8");
  total += 1;
  process.stdout.write(`✓ ${seed.file}  (seed: ${seed.id})\n`);
}
process.stdout.write(`\n${total} avatar(s) regenerated · ${stripped} had isolated white pixels stripped\n`);
