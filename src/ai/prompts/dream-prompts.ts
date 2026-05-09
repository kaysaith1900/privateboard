/**
 * Dream-cycle prompt templates · the three LLM calls inside one
 * memory-metabolism pass (cluster · merge · conflict-resolve).
 *
 * All three target the cheap utility model (utilityModelFor) and
 * emit strict JSON that the dream pipeline parses with a tolerant
 * recovery layer. If a step's output doesn't parse, the cycle
 * skips that step and continues — partial completion is always
 * better than aborting and leaving the memory pile unprocessed.
 *
 * Each builder returns `{system, user}` so the call sites stay
 * uniform and the prompts are testable in isolation (the test
 * file imports them and asserts shape / examples are present).
 */
import type { AgentMemory } from "../../storage/memories.js";

export interface PromptPair {
  system: string;
  user: string;
}

/** Compact one-line representation per memory · used inside the
 *  prompt so the model can refer to memories by id without the
 *  full `[{id, kind, content, ...}]` blob ballooning the context. */
function formatMemoryForPrompt(m: AgentMemory): string {
  const flag = m.tier === "long" ? " [stable]" : "";
  return `${m.id}${flag} (${m.kind}, conf=${m.confidence.toFixed(2)}): ${m.content}`;
}

// ─────────────────────────────────────────────────────────────────
// Step 2 · Cluster · group near-duplicates
// ─────────────────────────────────────────────────────────────────

/** Build the cluster prompt · sends a flat list of memories and
 *  asks for arrays of ids that are duplicate / near-duplicate.
 *  Output: JSON array of arrays of ids, e.g. `[["m1","m2"],["m4","m7","m9"]]`.
 *  Memories not in any cluster are implicit singletons.
 *
 *  Design notes:
 *  · "near-duplicate" defined as "if both became one, no information
 *    lost" — protects against over-merging things that share a
 *    keyword but make different claims (e.g. "user uses Python" vs
 *    "user prefers typed Python over JS"; same theme, different
 *    granularity).
 *  · Singletons NOT echoed (saves tokens + simplifies parser).
 *  · Empty result allowed: `[]`. */
export function buildClusterPrompt(memories: AgentMemory[], userName: string): PromptPair {
  const lines = memories.map(formatMemoryForPrompt).join("\n");
  const system = [
    `You are processing one agent's accumulated long-term memories about ${userName}.`,
    `Your job NOW is to find near-duplicates — memories that, if collapsed into one, would lose no information.`,
    "",
    `Output STRICT JSON · a 2-D array of memory ids forming clusters. Singletons MUST NOT appear (any id you don't list is implicitly its own cluster).`,
    "",
    `Examples:`,
    `Input lines · two are near-duplicates ("prefers concise" + "dislikes long lists"), one stands alone.`,
    `Output: [["m1","m2"]]`,
    "",
    `Input lines · all distinct.`,
    `Output: []`,
    "",
    `Hard rules:`,
    `· Cluster only when BOTH would lose nothing if collapsed. Same theme but different granularity (e.g. "uses Python" vs "prefers typed Python over dynamic JS") are NOT a cluster.`,
    `· Output ONLY a JSON array. No prose, no code fence, no explanation.`,
    `· Empty array \`[]\` is a valid + correct answer when nothing duplicates.`,
  ].join("\n");
  const user = [
    `─── ${memories.length} MEMORIES ───`,
    lines,
    "",
    `─── YOUR CLUSTERS (JSON) ───`,
  ].join("\n");
  return { system, user };
}

/** Tolerant parser · returns clusters as arrays of ids. Drops any
 *  cluster whose ids reference unknown memories or are smaller
 *  than 2 (singletons are meaningless). */
export function parseClusterOutput(raw: string, knownIds: Set<string>): string[][] {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  if (!stripped) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(stripped); }
  catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: string[][] = [];
  for (const cluster of parsed) {
    if (!Array.isArray(cluster)) continue;
    const ids = cluster.filter((x): x is string => typeof x === "string" && knownIds.has(x));
    // Dedupe within a cluster
    const dedup = Array.from(new Set(ids));
    if (dedup.length >= 2) out.push(dedup);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Step 3 · Merge · synthesize one canonical sentence per cluster
// ─────────────────────────────────────────────────────────────────

/** Per-cluster prompt · given a small cluster (2-5 memories), ask
 *  the model to write ONE replacement sentence that captures the
 *  merged claim without losing any information. Output is a single
 *  JSON object `{"content": "<sentence>", "kind": "<kind>"}` so
 *  parser failures are easy to detect.
 *
 *  Design notes:
 *  · Picks the best phrasing rather than averaging. "User prefers
 *    concise output" + "User dislikes long lists" → "User prefers
 *    concise output, never long lists" (carries both claims).
 *  · Falls back to the first source's content if parse fails. */
export function buildMergePrompt(cluster: AgentMemory[], userName: string): PromptPair {
  const lines = cluster.map(formatMemoryForPrompt).join("\n");
  const system = [
    `You are collapsing ${cluster.length} near-duplicate memories about ${userName} into ONE canonical memory.`,
    "",
    `Output STRICT JSON · a single object: {"content": "<sentence in the same first-person assertion style>", "kind": "<one of: fact|observation|preference|goal>"}`,
    "",
    `Examples:`,
    `Input: two memories saying "user prefers concise output" + "user dislikes long lists with bullet padding"`,
    `Output: {"content": "${userName} prefers concise output, never padded lists", "kind": "preference"}`,
    "",
    `Hard rules:`,
    `· The merged sentence must preserve every distinct claim across the sources — pick wording that includes both, don't average them.`,
    `· Match the language the source memories were written in (English, Chinese, etc.).`,
    `· Output ONLY the JSON object. No prose, no code fence.`,
    `· Maximum 200 characters in \`content\`.`,
  ].join("\n");
  const user = [
    `─── CLUSTER (${cluster.length} memories) ───`,
    lines,
    "",
    `─── YOUR MERGED MEMORY (JSON) ───`,
  ].join("\n");
  return { system, user };
}

export interface MergeResult {
  content: string;
  kind: "fact" | "observation" | "preference" | "goal";
}
const MERGE_KINDS: ReadonlySet<MergeResult["kind"]> = new Set([
  "fact",
  "observation",
  "preference",
  "goal",
]);
export function parseMergeOutput(raw: string): MergeResult | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  if (!stripped) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(stripped); }
  catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const content = typeof obj.content === "string" ? obj.content.trim() : "";
  if (!content || content.length > 200) return null;
  const kindRaw = typeof obj.kind === "string" ? obj.kind : "fact";
  const kind = MERGE_KINDS.has(kindRaw as MergeResult["kind"])
    ? (kindRaw as MergeResult["kind"])
    : "fact";
  return { content, kind };
}

// ─────────────────────────────────────────────────────────────────
// Step 4 · Conflict resolve · find pairs that contradict
// ─────────────────────────────────────────────────────────────────

/** Send the post-merge memory set, ask for ordered pairs where the
 *  newer one CONTRADICTS the older one. Output: JSON array of
 *  `[olderId, newerId]` pairs, plus a free-text "why" we use only
 *  for debug logging.
 *
 *  Why pairs not graphs: contradictions are local. If A→B and B→C,
 *  the next dream cycle will see A as already superseded and C as
 *  the canonical, then notice C contradicts something else.
 *
 *  Design notes:
 *  · Newer wins because the user's view evolved. We pass createdAt
 *    in the line format so the model can pick correctly.
 *  · Empty array allowed when nothing contradicts. */
export function buildConflictPrompt(memories: AgentMemory[], userName: string): PromptPair {
  // Include createdAt in the line format so the model has the
  // ordering signal without inventing it. Use ISO truncated to date
  // for human-readability.
  const lines = memories
    .map((m) => {
      const d = new Date(m.createdAt).toISOString().slice(0, 10);
      return `${m.id} (${d}): ${m.content}`;
    })
    .join("\n");
  const system = [
    `You are looking for direct contradictions among ${userName}'s long-term memories.`,
    `A "contradiction" is a pair where the newer memory makes a claim that's incompatible with what the older one said — i.e., ${userName}'s view evolved.`,
    "",
    `Output STRICT JSON · array of {"older": "<id>", "newer": "<id>", "why": "<brief reason>"}.`,
    "",
    `Examples:`,
    `Two memories · old "user is exploring crypto" + newer "user has decided crypto isn't relevant".`,
    `Output: [{"older": "m3", "newer": "m9", "why": "exploration → rejected"}]`,
    "",
    `Two memories · "user is in fintech" + "user prefers concise output". Different topics — NOT a contradiction.`,
    `Output: []`,
    "",
    `Hard rules:`,
    `· Only pair memories that make incompatible claims about the SAME thing. Different topics ≠ contradiction.`,
    `· Newer always wins — older goes in "older", newer in "newer". Use the date stamps to determine ordering.`,
    `· Output ONLY a JSON array. No prose, no code fence.`,
    `· Empty array \`[]\` is the correct answer when nothing contradicts.`,
  ].join("\n");
  const user = [
    `─── ${memories.length} MEMORIES (id, date, content) ───`,
    lines,
    "",
    `─── YOUR CONTRADICTIONS (JSON) ───`,
  ].join("\n");
  return { system, user };
}

export interface ConflictPair {
  older: string;
  newer: string;
  why: string;
}
export function parseConflictOutput(raw: string, knownIds: Set<string>): ConflictPair[] {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  if (!stripped) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(stripped); }
  catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: ConflictPair[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const older = typeof obj.older === "string" ? obj.older : "";
    const newer = typeof obj.newer === "string" ? obj.newer : "";
    const why = typeof obj.why === "string" ? obj.why.slice(0, 200) : "";
    if (!older || !newer) continue;
    if (older === newer) continue;
    if (!knownIds.has(older) || !knownIds.has(newer)) continue;
    out.push({ older, newer, why });
  }
  return out;
}
