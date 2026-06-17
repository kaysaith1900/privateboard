#!/usr/bin/env node
/**
 * gen-ios-prompts.mjs · codegen the director prompt guidance from the SAME TS
 * source the desktop uses (src/orchestrator/prompt.ts), byte-identical + no drift.
 *
 * prompt.ts can't be imported directly (it transitively pulls db.ts → `.sql`
 * imports that only tsup resolves). But the three guidance constants are PURE
 * string literals with no external refs, so we slice them textually and eval
 * them in isolation. Re-run when those blocks change:
 *   node scripts/gen-ios-prompts.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(repoRoot, "src/orchestrator/prompt.ts"), "utf8").split("\n");
const outDir = join(repoRoot, "ios/BoardroomKit/Sources/BoardroomEngine/Resources");
const outFile = join(outDir, "director-prompts.json");

/** Slice a const definition from its declaration line to the first line
 *  matching `endRe` (inclusive). */
function slice(startRe, endRe) {
  const start = src.findIndex((l) => startRe.test(l));
  if (start < 0) throw new Error(`not found: ${startRe}`);
  for (let i = start + 1; i < src.length; i++) {
    if (endRe.test(src[i])) return src.slice(start, i + 1).join("\n");
  }
  throw new Error(`no end for: ${startRe}`);
}

const proto = slice(/^export const SHARED_ROOM_PROTOCOL = \[/, /^\]\.join\(/);
const tone = slice(/^export const TONE_GUIDANCE/, /^\};/);
const intensity = slice(/^export const INTENSITY_GUIDANCE/, /^\};/);

const snippet =
  [proto, tone, intensity].join("\n")
    .replace(/export /g, "")
    .replace(/: Record<string, string>/g, "") +
  "\nconsole.log(JSON.stringify({sharedRoomProtocol:SHARED_ROOM_PROTOCOL,tone:TONE_GUIDANCE,intensity:INTENSITY_GUIDANCE}));";

const json = execFileSync("node", ["--input-type=module", "-e", snippet],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const parsed = JSON.parse(json);
if (!parsed.sharedRoomProtocol || !parsed.tone?.brainstorm || !parsed.intensity?.sharp) {
  console.error("[gen-ios-prompts] unexpected shape"); process.exit(1);
}
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(parsed, null, 2), "utf8");
console.log(`[gen-ios-prompts] wrote ${Object.keys(parsed.tone).length} tones + ${Object.keys(parsed.intensity).length} intensities → ${outFile}`);
