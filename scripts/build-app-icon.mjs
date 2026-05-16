#!/usr/bin/env node
/**
 * Build app-icon assets from `public/avatars/chair.svg`.
 *
 * Outputs:
 *   - `public/icons/logo.png` · 1024×1024 PNG (web + dev-mode dock icon)
 *   - `build/icon.png`        · same image at the path electron-builder
 *                                expects (it generates .icns / .ico
 *                                automatically from this PNG on mac/win
 *                                during `electron-builder --mac`).
 *
 * Source is the Chair avatar (the "facilitator" agent's portrait) —
 * pixel art on a 16-unit grid, but the viewBox is a 272×272 padded
 * frame so the avatar reads centered inside its own breathing room.
 * We upscale with nearest-neighbor (`kernel: "nearest"`) so each
 * 16-unit cell becomes a clean integer-aligned block of pixels;
 * bilinear/Lanczos would soften the edges and destroy the pixel-art
 * aesthetic. The viewBox dimensions are parsed at build time so a
 * future avatar swap doesn't require touching the density math.
 *
 * The interior squircle is pure black (`#000000`). Sat briefly at
 * the sidebar's #1A1A18 panel colour — turned out too washed-out
 * against the dock's other dark icons; pure black gives the chair
 * pixels the most contrast and matches the typical macOS dark-icon
 * vocabulary (Terminal, Reminders dark mode, etc.).
 *
 * Final output is masked into a macOS squircle and **inset to match
 * Apple's app-icon template proportions**: a 1024×1024 transparent
 * canvas with the actual content occupying the centered 824×824
 * region (≈ 80 %), leaving a 100 px transparent margin on every edge.
 * This is the same scale Finder / Mail / Safari / etc. ship at, so
 * the icon visually matches its dock neighbours instead of standing
 * ~20 % larger. The corner radius is 22.37 % of the inner edge
 * (824 × 0.2237 ≈ 184) — Apple's "concentricity ratio".
 *
 * Rendering the squircle mask as a separate SVG gives us anti-aliased
 * rounded edges WITHOUT softening the pixel-art interior — the
 * avatar keeps its nearest-neighbor crispness, only the silhouette
 * gets anti-aliasing where it meets the chrome.
 */
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const SRC = resolve(root, "public/avatars/chair.svg");
const PNG_PUBLIC = resolve(root, "public/icons/logo.png");
const PNG_BUILD = resolve(root, "build/icon.png");
const CANVAS = 1024;
const INNER = 824;                                 // Apple template safe area
const OUTER_MARGIN = (CANVAS - INNER) / 2;         // 100 px transparent rim
const RADIUS = Math.round(INNER * 0.2237);         // squircle concentricity
// Chair avatar's viewBox includes generous internal padding (~14 %
// each side) so the figure reads centered. Rendering it at the full
// INNER size means that built-in padding becomes the squircle's
// breathing room — no extra CONTENT inset needed. macOS native
// app icons (Notes / Reminders) use this same "content fills inner
// safe area, internal art carries the visual padding" pattern.

async function main() {
  const svg = await readFile(SRC);
  const svgText = svg.toString("utf8");

  // Pull source dimensions from the SVG's viewBox so density scales
  // correctly for any avatar we point this script at. viewBox format:
  // "min-x min-y width height". We use the larger dimension to ensure
  // the longer axis fits within INNER, then composite into a square.
  const vbMatch = svgText.match(/viewBox\s*=\s*"([^"]+)"/i);
  const vbParts = vbMatch ? vbMatch[1].trim().split(/[\s,]+/).map(Number) : null;
  const [, , sourceW, sourceH] = vbParts && vbParts.length === 4 ? vbParts : [0, 0, 16, 16];
  const sourceSize = Math.max(sourceW, sourceH);

  // Step 1 · render the avatar at INNER size with nearest-neighbor.
  // `density` is calibrated so the SVG renders directly at INNER pixels
  // (no resize-step softening), and each 16-unit cell maps to an
  // integer-aligned block at this scale.
  const content = await sharp(svg, { density: 72 * (INNER / sourceSize) })
    .resize(INNER, INNER, { kernel: "nearest", fit: "fill" })
    .png()
    .toBuffer();

  // Step 2 · the squircle interior is INNER × INNER filled with
  // pure black. The avatar composites at (0,0) because its viewBox
  // already carries the centering padding — the bg shows through
  // wherever the avatar's pixels are transparent.
  const innerCanvas = await sharp({
    create: {
      width: INNER,
      height: INNER,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 }, // pure black
    },
  })
    .composite([{ input: content, top: 0, left: 0 }])
    .png()
    .toBuffer();

  // Step 3 · squircle alpha mask at inner size. Rendered as a
  // separate SVG so its rounded edge anti-aliases normally while the
  // pixel-art interior above stays nearest-sharp.
  const maskSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${INNER}" height="${INNER}">` +
      `<rect width="${INNER}" height="${INNER}" rx="${RADIUS}" ry="${RADIUS}" fill="white"/>` +
    `</svg>`
  );

  // Step 4 · mask with `dest-in` (keep destination where mask is
  // opaque, erase rest to transparent), then `extend` the 824 squircle
  // out to the 1024 canvas with the 100 px transparent margin on each
  // side. macOS uses the outer rim as breathing room around the icon
  // — without it, the icon reads as oversized next to Finder/Mail.
  const png = await sharp(innerCanvas)
    .composite([{ input: maskSvg, blend: "dest-in" }])
    .extend({
      top: OUTER_MARGIN, bottom: OUTER_MARGIN, left: OUTER_MARGIN, right: OUTER_MARGIN,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer();

  mkdirSync(dirname(PNG_PUBLIC), { recursive: true });
  mkdirSync(dirname(PNG_BUILD), { recursive: true });
  await writeFile(PNG_PUBLIC, png);
  await writeFile(PNG_BUILD, png);

  console.log(
    `✓ ${CANVAS} canvas · ${INNER} squircle (r=${RADIUS}) on #000000 · ${OUTER_MARGIN}px outer rim · source ${sourceSize}×${sourceSize} viewBox`,
  );
  console.log(`  ${PNG_PUBLIC}`);
  console.log(`  ${PNG_BUILD}`);
}

main().catch((err) => {
  console.error("[build-app-icon] failed:", err);
  process.exitCode = 1;
});
