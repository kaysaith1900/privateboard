/**
 * finalize-mac-release.mjs
 *
 * Why · electron-builder 26.x signs + notarizes the `.app` but NOT the
 * `.dmg` container. A freshly built DMG is `spctl: no usable signature`,
 * so browser-download users hit Gatekeeper ("damaged / unverified
 * developer"). The zip is fine — its inner `.app` is stapled — only the
 * DMG container needs the extra pass electron-builder skips:
 *
 *   1. codesign --timestamp the DMG
 *   2. xcrun notarytool submit --wait the DMG
 *   3. xcrun stapler staple the DMG
 *
 * Stapling appends ~11 KB of ticket, so the DMG's build-time sha512/size
 * (already written into release/latest-mac.yml by electron-builder) go
 * stale and electron-updater would reject the download. We recompute the
 * DMG row of latest-mac.yml (zip row + top-level `path:` left untouched —
 * the zip is unchanged) and re-upload dmg + yml to the GitHub release
 * with --clobber.
 *
 * Runs automatically as the tail of `npm run electron:dist`. Standalone:
 * `npm run release:mac:finalize` (idempotent — re-runnable if a build
 * succeeded but finalize was interrupted).
 *
 * Env required (same as the signed build):
 *   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
 * Optional:
 *   MAC_SIGN_IDENTITY  (default: Developer ID Application: kaiwen shi (MC8P34EHRC))
 *   FINALIZE_ARCH      (default: arm64)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

function log(msg) {
  process.stdout.write(`finalize-mac · ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`finalize-mac · ERROR · ${msg}\n`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const ver = String(pkg.version || "").trim();
if (!ver) fail("package.json has no version field");

const arch = process.env.FINALIZE_ARCH || "arm64";
const tag = `v${ver}`;
const dmgName = `PrivateBoard-${ver}-${arch}.dmg`;
const dmgPath = join(repoRoot, "release", dmgName);
const ymlPath = join(repoRoot, "release", "latest-mac.yml");
const identity =
  process.env.MAC_SIGN_IDENTITY ||
  "Developer ID Application: kaiwen shi (MC8P34EHRC)";

if (!existsSync(dmgPath))
  fail(`DMG not found: ${dmgPath} — did electron-builder produce it?`);

// Idempotent: if the DMG already passes Gatekeeper we've signed it before,
// so skip the (slow) codesign/notarize/staple dance and just re-sync the yml.
let alreadyOk = false;
try {
  execFileSync("spctl", ["-a", "-vv", "-t", "install", dmgPath], {
    stdio: "pipe",
  });
  alreadyOk = true;
} catch {
  // rejected → needs the full signing pass
}

if (alreadyOk) {
  log("DMG already passes Gatekeeper — skipping codesign/notarize/staple");
} else {
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID)
    fail(
      "missing APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID env — " +
        "export them before the build (see macos-codesign-notarize memory)",
    );

  log(`codesign ${dmgName}`);
  execFileSync("codesign", ["--sign", identity, "--timestamp", dmgPath], {
    stdio: "inherit",
  });

  log("notarytool submit --wait (takes a few minutes)…");
  try {
    execFileSync(
      "xcrun",
      [
        "notarytool",
        "submit",
        dmgPath,
        "--apple-id",
        APPLE_ID,
        "--password",
        APPLE_APP_SPECIFIC_PASSWORD,
        "--team-id",
        APPLE_TEAM_ID,
        "--wait",
      ],
      { stdio: "inherit" },
    );
  } catch {
    // notarytool's status poll often times out (statusCode: nil) even though
    // the upload succeeded and Apple finishes server-side. Try to staple
    // anyway — if the ticket isn't ready, stapler below will throw.
    log(
      "notarytool --wait returned non-zero (commonly a status-poll timeout) — " +
        "attempting staple anyway",
    );
  }

  log("stapler staple");
  execFileSync("xcrun", ["stapler", "staple", dmgPath], { stdio: "inherit" });

  log("verifying with spctl");
  execFileSync("spctl", ["-a", "-vv", "-t", "install", dmgPath], {
    stdio: "inherit",
  });
}

// Recompute DMG sha512 (base64) + size — matches electron-builder's format.
const buf = readFileSync(dmgPath);
const sha512 = createHash("sha512").update(buf).digest("base64");
const size = statSync(dmgPath).size;
log(`dmg sha512=${sha512.slice(0, 16)}… size=${size}`);

if (!existsSync(ymlPath)) fail(`latest-mac.yml not found: ${ymlPath}`);
// Surgically replace only the dmg entry's sha512 + size via regex so the
// rest of electron-builder's output is byte-preserved (notably the quoted
// `releaseDate:` — re-emitting via a YAML lib drops the quotes, and js-yaml
// then parses the bare ISO string as a Date instead of a string).
let yml = readFileSync(ymlPath, "utf8");
const reDmg =
  /(- url: \S+\.dmg\n\s+sha512: )\S+(\n\s+size: )\d+/;
if (!reDmg.test(yml))
  fail("no .dmg entry (url + sha512 + size) found in latest-mac.yml#files");
yml = yml.replace(reDmg, `$1${sha512}$2${size}`);
writeFileSync(ymlPath, yml, "utf8");
log("latest-mac.yml dmg row updated (zip row + path untouched)");

log(`gh release upload ${tag} (dmg + yml, --clobber)`);
execFileSync("gh", ["release", "upload", tag, dmgPath, ymlPath, "--clobber"], {
  stdio: "inherit",
});

log(`done · ${tag} DMG signed + notarized + stapled, latest-mac.yml in sync`);
