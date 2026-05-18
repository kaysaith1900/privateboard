#!/usr/bin/env node
/**
 * Ensure better-sqlite3's compiled binary matches the runtime we're about
 * to launch — `node dist/cli.js` (Node ABI) vs `electron .` (Electron ABI).
 *
 * better-sqlite3 ships a single `build/Release/better_sqlite3.node`. When
 * the user alternates between the two entrypoints, whichever ran the last
 * rebuild wins, and the other breaks with NODE_MODULE_VERSION mismatch.
 *
 * We cache rebuilt binaries by ABI signature so the second switch is a
 * file copy instead of a full compile. First-time per ABI still pays the
 * compile cost.
 *
 *   node scripts/ensure-sqlite-abi.mjs node       # before running cli
 *   node scripts/ensure-sqlite-abi.mjs electron   # before running electron
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (target !== "node" && target !== "electron") {
  console.error("usage: ensure-sqlite-abi.mjs <node|electron>");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const binaryPath = path.join(root, "node_modules/better-sqlite3/build/Release/better_sqlite3.node");
// Cache lives OUTSIDE `build/` · node-gyp wipes that directory on every
// rebuild, so cached siblings in `build/Release/` get nuked too. The
// stamp also moves out of build/ to keep it consistent.
const cacheDir = path.join(root, "node_modules/better-sqlite3/.abi-cache");
const stampPath = path.join(cacheDir, "stamp");

if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}
if (!fs.existsSync(path.dirname(binaryPath))) {
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
}

const nodeAbi = `node-${process.versions.modules}`;
const electronPkg = JSON.parse(
  fs.readFileSync(path.join(root, "node_modules/electron/package.json"), "utf8"),
);
const electronAbi = `electron-${electronPkg.version}`;
const wantAbi = target === "node" ? nodeAbi : electronAbi;

let haveAbi = null;
try { haveAbi = fs.readFileSync(stampPath, "utf8").trim(); } catch {}

if (haveAbi === wantAbi && fs.existsSync(binaryPath)) {
  process.exit(0);
}

const cachedBinary = path.join(cacheDir, `better_sqlite3.${wantAbi}.node`);
if (fs.existsSync(cachedBinary)) {
  fs.copyFileSync(cachedBinary, binaryPath);
  fs.writeFileSync(stampPath, wantAbi);
  console.log(`[sqlite] swapped to cached ${wantAbi} binary`);
  process.exit(0);
}

console.log(`[sqlite] rebuilding for ${wantAbi} (this happens once per ABI)`);
if (target === "node") {
  execSync("npm rebuild better-sqlite3", { stdio: "inherit", cwd: root });
} else {
  // --build-from-source is required: prebuild-install otherwise falls back
  // to whatever prebuilt is on disk for the current arch, which is often
  // the Node ABI version (since better-sqlite3 publishes Node prebuilts
  // for darwin-arm64 but not Electron-specific ones). Force-compiling
  // against Electron's headers guarantees the right NODE_MODULE_VERSION.
  execSync("npx @electron/rebuild --force --build-from-source --only better-sqlite3", {
    stdio: "inherit",
    cwd: root,
  });
}

if (!fs.existsSync(binaryPath)) {
  console.error(`[sqlite] rebuild produced no binary at ${binaryPath}`);
  process.exit(1);
}

fs.copyFileSync(binaryPath, cachedBinary);
fs.writeFileSync(stampPath, wantAbi);
console.log(`[sqlite] cached ${wantAbi} binary for future switches`);
