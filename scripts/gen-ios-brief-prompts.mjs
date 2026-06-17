#!/usr/bin/env node
/**
 * gen-ios-brief-prompts.mjs · codegen the brief Stage-2/3 (+ structured-mode)
 * system prompts from the SAME TS source the desktop uses
 * (src/ai/prompts/brief-stages.ts), byte-identical + no drift.
 *
 * brief-stages.ts can't be imported directly (transitive `.sql` imports only
 * tsup resolves), but SCAFFOLD_SYSTEM / WRITE_SYSTEM / MAGAZINE_SYSTEM /
 * NEWSPAPER_SYSTEM / PPT_SYSTEM are PURE string-literal arrays (`[...].join("\n")`,
 * verified 0 interpolations), so we slice them textually and eval in isolation.
 * Re-run when those blocks change:
 *   node scripts/gen-ios-brief-prompts.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(repoRoot, "src/ai/prompts/brief-stages.ts"), "utf8").split("\n");
const outDir = join(repoRoot, "ios/BoardroomKit/Sources/BoardroomEngine/Resources");
const outFile = join(outDir, "brief-prompts.json");

/** Slice `const NAME = [ ... ].join("\n");` textually (declaration → first
 *  `].join(` line, inclusive). */
function slice(name) {
  const startRe = new RegExp(`^const ${name} = \\[`);
  const start = src.findIndex((l) => startRe.test(l));
  if (start < 0) throw new Error(`not found: ${name}`);
  for (let i = start + 1; i < src.length; i++) {
    if (/^\]\.join\(/.test(src[i])) return src.slice(start, i + 1).join("\n");
  }
  throw new Error(`no end for: ${name}`);
}

const names = ["SCAFFOLD_SYSTEM", "WRITE_SYSTEM", "MAGAZINE_SYSTEM", "NEWSPAPER_SYSTEM", "PPT_SYSTEM"];
const snippet =
  names.map(slice).join("\n") +
  "\nconsole.log(JSON.stringify({" +
  "scaffold:SCAFFOLD_SYSTEM,write:WRITE_SYSTEM,magazine:MAGAZINE_SYSTEM,newspaper:NEWSPAPER_SYSTEM,ppt:PPT_SYSTEM}));";

const json = execFileSync("node", ["--input-type=module", "-e", snippet],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const parsed = JSON.parse(json);
for (const k of ["scaffold", "write", "magazine", "newspaper", "ppt"]) {
  if (typeof parsed[k] !== "string" || parsed[k].length < 200) {
    console.error(`[gen-ios-brief-prompts] unexpected shape for ${k}`); process.exit(1);
  }
}

// Composer SYSTEM_PROMPT (composer.ts) · embeds `formatHouseStyleCatalog()`, so we
// must eval it WITH house-styles.ts in scope. house-styles.ts has only `import
// type` (no runtime deps), so we strip its import lines and concat it as a pure
// module before the composer slice. The composer slice's `formatHouseStyleCatalog()`
// then resolves, producing the byte-identical catalog the desktop sends.
const composerSrc = readFileSync(join(repoRoot, "src/ai/prompts/composer.ts"), "utf8").split("\n");
function sliceFrom(lines, name) {
  const startRe = new RegExp(`^const ${name} = \\[`);
  const start = lines.findIndex((l) => startRe.test(l));
  if (start < 0) throw new Error(`not found: ${name}`);
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\]\.join\(/.test(lines[i])) return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`no end for: ${name}`);
}
// house-styles.ts is pure (only `import type`) but carries TS type syntax, so
// node can't eval it raw — transpile to JS via esbuild (strips types, drops the
// type-only imports). The result defines HOUSE_STYLES + formatHouseStyleCatalog.
const esbuildBin = join(repoRoot, "node_modules/.bin/esbuild");
const houseStylesSrc = execFileSync(
  esbuildBin,
  ["src/ai/prompts/house-styles.ts", "--format=esm"],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const composerSnippet =
  houseStylesSrc + "\n" +
  sliceFrom(composerSrc, "SYSTEM_PROMPT") + "\n" +
  "console.log(JSON.stringify({composer:SYSTEM_PROMPT}));";
const composerJson = execFileSync("node", ["--input-type=module", "-e", composerSnippet],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const composerParsed = JSON.parse(composerJson);
if (typeof composerParsed.composer !== "string" || composerParsed.composer.length < 200) {
  console.error(`[gen-ios-brief-prompts] unexpected shape for composer`); process.exit(1);
}
parsed.composer = composerParsed.composer;

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(parsed, null, 2), "utf8");
console.log(`[gen-ios-brief-prompts] wrote scaffold(${parsed.scaffold.length}) + write(${parsed.write.length}) + 3 bento + composer(${parsed.composer.length}) → ${outFile}`);
