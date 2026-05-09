/**
 * Keep `src/version.ts` in lock-step with `package.json#version`.
 *
 * Why · two version strings used to drift (cli.ts banner once said
 * "0.1.2" while the npm tarball was already on 0.1.6). The CLI banner,
 * the /api/health and /api/version endpoints, the user-settings
 * sidebar footer all read from `src/version.ts`; the npm package is
 * stamped from `package.json`. Running this script before publish
 * (wired via the `prepublishOnly` script) guarantees they match.
 *
 * Run · `npm run sync-version`. Idempotent — re-running with no
 * version change exits 0 with a "no change" log line. Run it after
 * any `npm version <patch|minor|major>` so the bump is reflected.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const pkgPath = join(repoRoot, "package.json");
const versionFile = join(repoRoot, "src", "version.ts");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const target = String(pkg.version || "").trim();
if (!target) {
  process.stderr.write("sync-version · package.json has no version field — aborting\n");
  process.exit(1);
}

const current = readFileSync(versionFile, "utf8");
// Match `export const VERSION = "x.y.z";` exactly so the file's
// docstring + surrounding comments stay intact.
const re = /export const VERSION = "([^"]+)";/;
const match = re.exec(current);
if (!match) {
  process.stderr.write(
    `sync-version · could not find \`export const VERSION\` in src/version.ts — refusing to overwrite a file that doesn't match the expected shape\n`,
  );
  process.exit(1);
}
const previous = match[1];
if (previous === target) {
  process.stdout.write(`sync-version · already at ${target} · no change\n`);
  process.exit(0);
}

const updated = current.replace(re, `export const VERSION = "${target}";`);
writeFileSync(versionFile, updated, "utf8");
process.stdout.write(`sync-version · ${previous} → ${target}\n`);
