#!/usr/bin/env node
/**
 * gen-ios-seed.mjs · codegen the iOS seed catalog from the SAME TS seed the
 * desktop uses (src/seed/chair.ts + directors.ts), so the on-device director
 * roster is byte-identical to desktop and never drifts.
 *
 * Evaluates the TS exports via tsx and writes their JSON to a bundled resource
 * the `BoardroomStorage` target loads at first-run seed. Re-run when the seed
 * catalog changes:  node scripts/gen-ios-seed.mjs
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, "ios/BoardroomKit/Sources/BoardroomStorage/Resources");
const outFile = join(outDir, "seed.json");

const evalSrc =
  "import {SEED_CHAIR} from './src/seed/chair.ts';" +
  "import {SEED_DIRECTORS} from './src/seed/directors.ts';" +
  "process.stdout.write(JSON.stringify({chair:SEED_CHAIR,directors:SEED_DIRECTORS}));";

const json = execFileSync("npx", ["tsx", "-e", evalSrc], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

// Validate + pretty-print so diffs are readable.
const parsed = JSON.parse(json);
if (!parsed.chair || !Array.isArray(parsed.directors) || parsed.directors.length === 0) {
  console.error("[gen-ios-seed] unexpected seed shape"); process.exit(1);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(parsed, null, 2), "utf8");
console.log(`[gen-ios-seed] wrote chair + ${parsed.directors.length} directors → ${outFile}`);
