#!/usr/bin/env node
/**
 * Build app-icon assets from `public/avatars/3d/chair.png`.
 *
 * Outputs:
 *   - `public/icons/logo.png` · 1024×1024 PNG (web + dev-mode dock icon)
 *   - `build/icon.png`        · same image at the path electron-builder
 *                                expects (it generates .icns / .ico
 *                                automatically from this PNG on mac/win
 *                                during `electron-builder --mac`).
 *
 * Source is the 3D Chair portrait (the canonical 杨天真 avatar) — a
 * head-and-shoulders RGBA PNG captured by `avatar3d-editor.js`
 * → `capturePng()` at 384×384 with a transparent background. The
 * previous icon source was the pixel-art `chair.svg` rendered with
 * nearest-neighbor for the 16-unit voxel aesthetic; the new source
 * is a smooth voxel render so we resize with Lanczos for clean
 * up-scaling rather than blocky stair-stepping.
 *
 * The interior squircle is pure black (`#000000`). Sat briefly at
 * the sidebar's #1A1A18 panel colour — turned out too washed-out
 * against the dock's other dark icons; pure black gives the chair
 * portrait the most contrast and matches the typical macOS dark-icon
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
 * rounded edges where the silhouette meets the chrome.
 */
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const SRC = resolve(root, "public/avatars/3d/chair.png");
const PNG_PUBLIC = resolve(root, "public/icons/logo.png");
const PNG_BUILD = resolve(root, "build/icon.png");
const CANVAS = 1024;
const INNER = 824;                                 // Apple template safe area
const OUTER_MARGIN = (CANVAS - INNER) / 2;         // 100 px transparent rim
const RADIUS = Math.round(INNER * 0.2237);         // squircle concentricity
// `capturePng()` already crops to a head-and-shoulders portrait
// at 384×384 with internal breathing room above the head and along
// the shoulders, so rendering it at the full INNER size lets that
// built-in framing become the squircle's natural padding — no extra
// inset / re-centring needed.

async function main() {
  const src = await readFile(SRC);

  // Step 1 · resize the source portrait to INNER size with Lanczos.
  // Voxel renders contain anti-aliased pixel edges (three.js MSAA);
  // nearest-neighbor would re-introduce stair-stepping after the
  // 384→824 upscale, so Lanczos is the right kernel for this source
  // (in contrast with the legacy pixel-art SVG path).
  const content = await sharp(src)
    .resize(INNER, INNER, { kernel: "lanczos3", fit: "fill" })
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

  // Source metadata · purely for the build-log readout. Sharp picks it
  // up from the file header; the value is the 3D portrait's native
  // capture size (currently 384×384).
  const meta = await sharp(src).metadata();
  console.log(
    `✓ ${CANVAS} canvas · ${INNER} squircle (r=${RADIUS}) on #000000 · ${OUTER_MARGIN}px outer rim · source ${meta.width}×${meta.height} (${SRC.split("/").slice(-3).join("/")})`,
  );
  console.log(`  ${PNG_PUBLIC}`);
  console.log(`  ${PNG_BUILD}`);
}

main().catch((err) => {
  console.error("[build-app-icon] failed:", err);
  process.exitCode = 1;
});
