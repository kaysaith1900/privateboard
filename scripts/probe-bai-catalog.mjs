/**
 * Probe B.AI's live /v1/models catalog and diff against the project's
 * MODELS registry. Surfaces three buckets so the user can keep
 * src/ai/registry.ts's `baiId` field accurate without trial-and-error
 * 503s on the first call to each model.
 *
 *   ✓ confirmed   · the baiId we set IS in B.AI's catalog
 *   ✗ missing     · the baiId we set is NOT in B.AI's catalog
 *                   (remove the baiId from the registry entry so the
 *                    adapter routes via OR / direct instead)
 *   ? unregistered· an id in B.AI's catalog we don't have a registry
 *                   entry for · candidates worth registering
 *
 * For each ✗, the script suggests the closest match in B.AI's catalog
 * (Levenshtein on the id) so renames are easy.
 *
 * Usage:
 *   BAI_API_KEY=sk-... node scripts/probe-bai-catalog.mjs
 *   node scripts/probe-bai-catalog.mjs --key sk-...
 *
 * Optional flags:
 *   --verbose        · also list every model in B.AI's catalog (raw dump)
 *   --json           · machine-readable output (single JSON object)
 *   --base <url>     · override B.AI base URL (default https://api.b.ai/v1)
 *
 * Exit codes:
 *   0 — diff completed (may include missing entries)
 *   1 — bad input (no key, network failure, malformed registry)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/* ─── CLI parsing ────────────────────────────────────────── */
const argv = process.argv.slice(2);
function flag(name) {
  const idx = argv.indexOf(name);
  if (idx < 0) return null;
  return argv[idx + 1] ?? "";
}
function bool(name) {
  return argv.includes(name);
}
const verbose = bool("--verbose");
const asJson = bool("--json");
const baseUrl = (flag("--base") || process.env.BAI_BASE || "https://api.b.ai/v1").replace(/\/+$/, "");
const explicitKey = flag("--key");
const apiKey = (explicitKey ?? process.env.BAI_API_KEY ?? "").trim();

if (!apiKey) {
  process.stderr.write(
    "B.AI key required · pass via BAI_API_KEY env var or --key flag\n" +
    "  Example: BAI_API_KEY=sk-... node scripts/probe-bai-catalog.mjs\n",
  );
  process.exit(1);
}

/* ─── Registry parsing ───────────────────────────────────── */
// Walk up from this file to find src/ai/registry.ts so the script
// runs from any cwd (npm scripts, the repo root, etc.).
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const registryPath = join(repoRoot, "src", "ai", "registry.ts");

let registrySrc;
try {
  registrySrc = readFileSync(registryPath, "utf8");
} catch (e) {
  process.stderr.write(`Failed to read ${registryPath}: ${e.message}\n`);
  process.exit(1);
}

/**
 * Extract { modelV → baiId | null } from the source. We walk each
 * `"<modelV>": { ... }` block and search inside it for `baiId: "..."`
 * — this tolerates the entries that intentionally OMIT baiId with a
 * `// No baiId · ...` comment.
 *
 * Format relies on the registry's stable shape (one entry per top-
 * level key in MODELS, body braces balanced on their own lines). If
 * that format changes, this regex needs revisiting.
 */
function parseRegistry(src) {
  // Find the MODELS object body.
  const modelsMatch = src.match(/export const MODELS:[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!modelsMatch) {
    throw new Error("could not locate `export const MODELS = { ... }` in registry.ts");
  }
  const body = modelsMatch[1];

  // Each entry: `  "modelV": {  ...  },` — match by capturing the
  // quoted key followed by a balanced { ... } at the same indent.
  // We rely on the registry's two-space indent: each entry starts
  // with `  "..."` (exactly two leading spaces).
  const entries = [];
  const entryRe = /^ {2}"([a-z0-9-]+)":\s*\{([\s\S]*?)^ {2}\},?$/gm;
  let m;
  while ((m = entryRe.exec(body)) !== null) {
    const modelV = m[1];
    const inner = m[2];
    const baiMatch = inner.match(/baiId:\s*"([^"]+)"/);
    const baiId = baiMatch ? baiMatch[1] : null;
    const displayMatch = inner.match(/displayName:\s*"([^"]+)"/);
    const displayName = displayMatch ? displayMatch[1] : modelV;
    entries.push({ modelV, baiId, displayName });
  }
  return entries;
}

let registry;
try {
  registry = parseRegistry(registrySrc);
} catch (e) {
  process.stderr.write(`Parse error: ${e.message}\n`);
  process.exit(1);
}
if (registry.length === 0) {
  process.stderr.write("Registry parse returned zero entries · regex may need updating\n");
  process.exit(1);
}

/* ─── Fetch B.AI catalog ─────────────────────────────────── */
async function fetchCatalog() {
  const url = `${baseUrl}/models`;
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
    });
  } catch (e) {
    throw new Error(`network failure fetching ${url}: ${e.message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 400)}`);
  }
  const json = await res.json().catch(() => null);
  if (!json) throw new Error("malformed JSON response");
  // OpenAI-compatible · expect `{ data: [{ id: "..." }, ...] }`. Some
  // proxies wrap with `{ object: "list", data: [...] }`. Tolerate both.
  const data = Array.isArray(json) ? json : (json.data || json.models || []);
  if (!Array.isArray(data)) {
    throw new Error(`unexpected response shape · top-level keys: ${Object.keys(json).join(", ")}`);
  }
  return data.map((m) => (typeof m === "string" ? m : m.id || m.model || m.name)).filter(Boolean);
}

let catalog;
try {
  catalog = await fetchCatalog();
} catch (e) {
  process.stderr.write(`B.AI catalog fetch failed: ${e.message}\n`);
  process.exit(1);
}
const catalogSet = new Set(catalog);

/* ─── Levenshtein helper for "did you mean" suggestions ─── */
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let upLeft = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1]
        ? upLeft
        : 1 + Math.min(upLeft, prev[j], prev[j - 1]);
      upLeft = tmp;
    }
  }
  return prev[b.length];
}
function closest(target, pool, maxDistance = 8) {
  let best = null;
  let bestDist = Infinity;
  for (const cand of pool) {
    const d = lev(target, cand);
    if (d < bestDist) { bestDist = d; best = cand; }
  }
  if (bestDist > maxDistance) return null;
  return { id: best, distance: bestDist };
}

/* ─── Diff ───────────────────────────────────────────────── */
const confirmed = [];
const missing = [];
const noBaiId = [];
for (const entry of registry) {
  if (!entry.baiId) {
    noBaiId.push(entry);
    continue;
  }
  if (catalogSet.has(entry.baiId)) {
    confirmed.push(entry);
  } else {
    missing.push({ ...entry, suggestion: closest(entry.baiId, catalog) });
  }
}

// Models in B.AI's catalog we don't have a registry baiId pointing
// to. Note: a single B.AI id might serve multiple modelV (unlikely
// but possible); we just report by raw id.
const registeredBaiIds = new Set(registry.map((e) => e.baiId).filter(Boolean));
const unregistered = catalog.filter((id) => !registeredBaiIds.has(id));

/* ─── Output ─────────────────────────────────────────────── */
if (asJson) {
  process.stdout.write(JSON.stringify({
    base: baseUrl,
    catalogSize: catalog.length,
    confirmed: confirmed.map((e) => ({ modelV: e.modelV, baiId: e.baiId })),
    missing: missing.map((e) => ({
      modelV: e.modelV,
      baiId: e.baiId,
      suggestion: e.suggestion,
    })),
    noBaiId: noBaiId.map((e) => ({ modelV: e.modelV, displayName: e.displayName })),
    unregistered,
  }, null, 2) + "\n");
  process.exit(0);
}

function hdr(s) { return `\n\x1b[1m${s}\x1b[0m`; }
function ok(s)  { return `\x1b[32m${s}\x1b[0m`; }
function bad(s) { return `\x1b[31m${s}\x1b[0m`; }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function warn(s){ return `\x1b[33m${s}\x1b[0m`; }

process.stdout.write(`B.AI catalog probe · base=${baseUrl} · ${catalog.length} models in remote catalog\n`);

process.stdout.write(hdr(`✓ Confirmed (${confirmed.length})`) + "\n");
for (const e of confirmed) {
  process.stdout.write(`  ${ok("✓")} ${e.modelV.padEnd(22)} → ${e.baiId}\n`);
}

process.stdout.write(hdr(`✗ Missing from B.AI catalog (${missing.length}) — remove baiId from registry`) + "\n");
for (const e of missing) {
  let suggestion = "";
  if (e.suggestion) {
    suggestion = `  ${dim(`(closest: ${e.suggestion.id} · dist=${e.suggestion.distance})`)}`;
  }
  process.stdout.write(`  ${bad("✗")} ${e.modelV.padEnd(22)} → ${e.baiId}${suggestion}\n`);
}
if (missing.length === 0) {
  process.stdout.write(`  ${dim("(none · registry baiIds all check out)")}\n`);
}

process.stdout.write(hdr(`— No baiId (${noBaiId.length}) — registry entries with no B.AI route`) + "\n");
for (const e of noBaiId) {
  // Heuristic suggestion · maybe B.AI carries this model under a
  // similar id even though we haven't registered one.
  const hint = closest(e.modelV, catalog, 6);
  const suggestion = hint
    ? `  ${dim(`(maybe: ${hint.id} · dist=${hint.distance})`)}`
    : "";
  process.stdout.write(`  ${dim("—")} ${e.modelV.padEnd(22)} ${dim(e.displayName)}${suggestion}\n`);
}
if (noBaiId.length === 0) {
  process.stdout.write(`  ${dim("(none · every registry entry has a baiId set)")}\n`);
}

process.stdout.write(hdr(`? Unregistered in B.AI catalog (${unregistered.length})`) + "\n");
if (verbose) {
  for (const id of unregistered) {
    process.stdout.write(`  ${warn("?")} ${id}\n`);
  }
} else {
  // Truncate by default · the catalog typically has 100+ entries the
  // user doesn't care about. Show the first 20.
  const head = unregistered.slice(0, 20);
  for (const id of head) {
    process.stdout.write(`  ${warn("?")} ${id}\n`);
  }
  if (unregistered.length > head.length) {
    process.stdout.write(`  ${dim(`… +${unregistered.length - head.length} more · pass --verbose to see all`)}\n`);
  }
}

process.stdout.write(`\nSummary: ${ok(`${confirmed.length} confirmed`)}, ${bad(`${missing.length} missing`)}, ` +
  `${noBaiId.length} no-baiId, ${unregistered.length} unregistered in catalog\n`);
process.exit(0);
