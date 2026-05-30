/**
 * App icon · geometry taken DIRECTLY from the reference system icon
 * (public/icons/app.icns): we extract its squircle alpha and reuse it as the
 * plate shape + clip mask, so the silhouette, size (824 solid / 100px margin)
 * and corner shape match the system pixel-for-pixel.
 *
 * The reference plate is FLAT near-black (luma ~2–6) with NO baked gradient,
 * rim or drop shadow — the macOS "Big Sur light" (the soft glow/shadow around
 * the icon) is added by the dock at render time, not baked into the asset.
 * So we keep the plate flat black; the 3D life comes from the foreground
 * (the chair sitting in its disc), exactly like the reference's glossy mark.
 *
 * Run · `node scripts/build-logo.mjs [outPath]`  (default: preview file)
 */
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);

const SIZE = 1024;
const PLATE_FILL = { r: 5, g: 5, b: 5 };      // flat near-black, like the reference
const DISC = { cx: 512, cy: 500, r: 300 };    // frames the head
const PORTRAIT_H = 645;
const HEAD_TOP = 158;                          // hair top; disc top = 200 → crest ~42px
const NECK_FRAC = 0.74;                        // below this = shoulders (cut by the disc arc)

const outPath = process.argv[2] || join(root, "public/icons/logo-preview.png");
const refIcns = join(root, "public/icons/app.icns");

// --- 1. Squircle shape from the reference icon's alpha (exact system geometry).
// Decode the 1024 representation out of the .icns via the iconset the build
// already produced, falling back to extracting on the fly.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
let ref1024 = "/tmp/app.iconset/icon_512x512@2x.png";
if (!existsSync(ref1024)) {
  const d = mkdtempSync(join(tmpdir(), "appicns-"));
  execFileSync("iconutil", ["-c", "iconset", refIcns, "-o", d]);
  ref1024 = join(d, "icon_512x512@2x.png");
}
// Alpha channel of the reference = the squircle coverage (incl. anti-aliased edge).
const refAlpha = await sharp(ref1024).resize(SIZE, SIZE).ensureAlpha().extractChannel(3).toColourspace("b-w").png().toBuffer();

// White squircle (final clip mask) and black squircle (the plate).
const squircleMask = await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r: 255, g: 255, b: 255 } } })
  .joinChannel(refAlpha).png().toBuffer();
const plate = await sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: PLATE_FILL } })
  .joinChannel(refAlpha).png().toBuffer();

// --- 2. Disc that frames the head.
const discSvg = Buffer.from(`
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="disc" cx="0.5" cy="0.40" r="0.66">
      <stop offset="0" stop-color="#6E6757"/>
      <stop offset="0.70" stop-color="#4E4940"/>
      <stop offset="1" stop-color="#39362F"/>
    </radialGradient>
  </defs>
  <circle cx="${DISC.cx}" cy="${DISC.cy}" r="${DISC.r}" fill="url(#disc)"/>
  <circle cx="${DISC.cx}" cy="${DISC.cy}" r="${DISC.r}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2.5"/>
</svg>`);

// --- 3. Portrait · clip to (disc ∪ head-rect): shoulders cut on the disc arc,
// hair-buns above the disc top kept (they crest over the rim).
const base = await sharp(join(root, "public/avatars/3d/chair.png"))
  .trim()
  .resize({ height: PORTRAIT_H })
  .toBuffer({ resolveWithObject: true });
const pW = base.info.width, pH = base.info.height;
const left = Math.round(DISC.cx - pW / 2);
const discCxL = DISC.cx - left, discCyL = DISC.cy - HEAD_TOP, neckY = Math.round(NECK_FRAC * pH);
const clipMask = Buffer.from(`
<svg width="${pW}" height="${pH}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${pW}" height="${neckY}" fill="#fff"/>
  <circle cx="${discCxL}" cy="${discCyL}" r="${DISC.r}" fill="#fff"/>
</svg>`);
const portrait = await sharp(base.data).composite([{ input: clipMask, blend: "dest-in" }]).toBuffer();

// --- 4. Compose: black squircle plate → disc → portrait → clip to squircle.
await sharp(plate)
  .composite([
    { input: discSvg },
    { input: portrait, top: HEAD_TOP, left },
    { input: squircleMask, blend: "dest-in" },
  ])
  .png()
  .toFile(outPath);

console.log(`wrote ${outPath} · shape from app.icns (824/margin100, no baked shadow); flat black plate; disc r=${DISC.r}@(${DISC.cx},${DISC.cy})`);
