#!/usr/bin/env node
/**
 * Build the iOS app-icon asset from the desktop brand logo
 * (`public/icons/logo.png`): the 3D Chair portrait nested in a soft charcoal
 * disc on black — the canonical mark, reused verbatim so iOS matches desktop.
 *
 * iOS-only adjustments:
 *   1. ZOOM · the desktop logo is a macOS squircle whose disc + figure occupy
 *      only ~64% of the frame (the rest is black template margin). iOS is
 *      full-bleed, so we scale the mark UP (centred on the disc) to fill the
 *      icon — the circle + face read large, not lost in black.
 *   2. SHIFT DOWN · the portrait is head-heavy, so the disc rides a touch below
 *      geometric centre to sit VISUALLY centred.
 *   3. FULL-BLEED, no alpha · flatten onto black + crush the logo's near-black
 *      squircle (#050505) to pure #000 so iOS's own corner mask doesn't reveal a
 *      faint inset rounded-rect.
 *
 * Output: `ios/Boardroom/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png`
 */
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const SRC = resolve(root, "public/icons/logo.png");
const OUT = resolve(root, "ios/Boardroom/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png");

const S = 1024;
const ZOOM = 1.3;     // scale the mark up to fill the full-bleed icon (bigger figure)
const DOWN = -26;     // px below centre (negative = raise the disc) · visual centring · the head-heavy portrait reads centred with a touch more room below the shoulders than above the hair (measured: content box ~93px top / ~96px bottom)
const CX = 512, CY = 461;   // charcoal-disc centre in the source logo (measured)

async function main() {
  const src = await readFile(SRC);
  const big = Math.round(S * ZOOM);
  // lanczos3 = the sharpest upscale kernel sharp offers (the 1024 source is
  // scaled UP by ZOOM, so the kernel choice + the later unsharp pass are what
  // claw back crispness — there is no higher-res master to draw from).
  const resized = await sharp(src)
    .resize(big, big, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png().toBuffer();
  // Crop a centred 1024 window so the disc centre lands at (512, 512+DOWN).
  const left = Math.max(0, Math.min(big - S, Math.round(CX * ZOOM - S / 2)));
  const top = Math.max(0, Math.min(big - S, Math.round(CY * ZOOM - (S / 2 + DOWN))));
  const png = await sharp(resized)
    .extract({ left, top, width: S, height: S })
    .flatten({ background: { r: 0, g: 0, b: 0 } })   // drop the squircle's transparent corners
    .linear(1, -6)                                   // crush the #050505 squircle to pure #000
    .sharpen({ sigma: 1.1 })                         // unsharp mask · counteract the upscale softening
    .png({ compressionLevel: 9 })
    .toBuffer();

  mkdirSync(dirname(OUT), { recursive: true });
  await writeFile(OUT, png);
  console.log(`✓ ${S}×${S} iOS icon from logo.png · zoom ${ZOOM}× · down ${DOWN}px · no alpha`);
  console.log(`  ${OUT}`);
}

main().catch((err) => {
  console.error("[build-ios-app-icon] failed:", err);
  process.exitCode = 1;
});
