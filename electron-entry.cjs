/**
 * Electron entry wrapper · runs the ABI preflight before the real main.
 *
 * `npx electron .` reads `package.json#main`, which points here instead of
 * directly at `dist-electron/main.js`. We do a synchronous ABI check first:
 * if the `better-sqlite3` binary at `build/Release/better_sqlite3.node`
 * doesn't match Electron's ABI, we swap from the cache built by
 * `scripts/ensure-sqlite-abi.mjs`. If no cache exists yet, we run the
 * rebuild synchronously (slow once, fast forever after).
 *
 * Why this exists: alternating `node dist/cli.js` (Node ABI) and `npx
 * electron .` (Electron ABI) flips a single `.node` binary, so one
 * always breaks. The npm scripts (`npm run electron:dev`, `npm start`,
 * `npm run dev`) pre-flight; this wrapper covers the direct-invocation
 * path so the bare `npx electron .` heals itself too.
 */
const fs = require("node:fs");
const path = require("node:path");

(function ensureAbi() {
  const root = __dirname;
  const binaryPath = path.join(
    root,
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  );
  // node-gyp wipes `build/` on rebuild, so the cache and stamp live
  // outside it. Must match the layout in `scripts/ensure-sqlite-abi.mjs`.
  const cacheDir = path.join(root, "node_modules/better-sqlite3/.abi-cache");
  const stampPath = path.join(cacheDir, "stamp");

  let electronVersion;
  try {
    electronVersion = require(
      path.join(root, "node_modules/electron/package.json"),
    ).version;
  } catch {
    // Running from a packaged app (no electron in node_modules). The
    // binary that shipped with the package is the one electron-builder
    // rebuilt at packaging time — trust it.
    return;
  }
  const wantAbi = `electron-${electronVersion}`;

  let haveAbi = null;
  try { haveAbi = fs.readFileSync(stampPath, "utf8").trim(); } catch {}
  if (haveAbi === wantAbi && fs.existsSync(binaryPath)) return;

  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, `better_sqlite3.${wantAbi}.node`);
  if (fs.existsSync(cached)) {
    fs.copyFileSync(cached, binaryPath);
    fs.writeFileSync(stampPath, wantAbi);
    process.stderr.write(`[electron] swapped to cached ${wantAbi} better-sqlite3 binary\n`);
    return;
  }

  process.stderr.write(
    `[electron] no cached ${wantAbi} binary; rebuilding (one-time)\n`,
  );
  const { execSync } = require("node:child_process");
  // `electron-builder install-app-deps` is unreliable here: it sometimes
  // reuses a Node-ABI prebuilt for the same arch. Forcing from-source via
  // @electron/rebuild guarantees the binary links against Electron's
  // headers and reports the right NODE_MODULE_VERSION.
  execSync(
    "npx @electron/rebuild --force --build-from-source --only better-sqlite3",
    { stdio: "inherit", cwd: root },
  );
  if (fs.existsSync(binaryPath)) {
    fs.copyFileSync(binaryPath, cached);
    fs.writeFileSync(stampPath, wantAbi);
  }
})();

// Real main is ESM, so use dynamic import. Electron's main supports a
// promise-returning entry — the app will start once the import resolves.
import("./dist-electron/main.js").catch((err) => {
  process.stderr.write(`[electron] main import failed: ${err && err.stack || err}\n`);
  process.exit(1);
});
