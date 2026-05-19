/**
 * Memory metabolism · the Sleep / Dreaming Mode pass.
 *
 * Every K adjourns (default 5) per agent we run a "dream cycle" that
 * processes accumulated memories the same way human sleep is thought
 * to consolidate the day's experience: drop noise, merge duplicates,
 * promote stable patterns to long-term, supersede contradicted
 * claims with newer ones.
 *
 * Phase 1 (this file): step 1 only · heuristic decay. Cheap, no LLM,
 * deterministic. Establishes the trigger plumbing + audit logging
 * shape so Phase 2 (cluster / merge / conflict / promote) can layer
 * in without rewiring callers.
 *
 * The full pipeline (per the design doc):
 *   1. heuristic decay        ← Phase 1
 *   2. cluster (LLM)          ← Phase 2
 *   3. merge per cluster (LLM)← Phase 2
 *   4. conflict resolve (LLM) ← Phase 2
 *   5. tier promotion         ← Phase 2
 *
 * Trigger surfaces:
 *   · `extractMemoriesAfterAdjourn` bumps a per-agent counter and
 *     fires `runDreamCycle(agentId)` when the threshold is crossed
 *     (post-extraction, async, non-blocking).
 *   · `cli.ts` boot-time sweep fires for any agent whose total
 *     memory count exceeds a safety ceiling — catches the case
 *     where adjourns crashed mid-cycle and the counter never
 *     advanced.
 *
 * Idempotent · running a dream when nothing qualifies for decay is
 * a no-op (zero rows changed, audit line still printed for
 * observability).
 */
import {
  decayShortTermMemories,
  countMemoriesForAgent,
  listTierForAgent,
  insertConsolidatedMemory,
  markSuperseded,
  promoteToLong,
  recordDream,
  type DecayThresholds,
  type AgentMemory,
} from "../storage/memories.js";
import { getAgent, type AgentRoleKind } from "../storage/agents.js";
import { callLLM } from "../ai/adapter.js";
import { utilityModelFor } from "../ai/availability.js";
import type { ModelV } from "../ai/registry.js";
import {
  buildClusterPrompt,
  parseClusterOutput,
  buildMergePrompt,
  parseMergeOutput,
  buildConflictPrompt,
  parseConflictOutput,
} from "../ai/prompts/dream-prompts.js";
import { getPrefs } from "../storage/prefs.js";
import {
  bumpUserLongMemoryProvenance,
  countActiveUserLongMemory,
  getUserLongMemory,
  insertUserLongMemory,
  listActiveUserLongMemory,
  markUserLongMemorySuperseded,
  pruneActiveUserLongMemoryToCap,
  type UserLongMemory,
} from "../storage/user-long-memory.js";

/** Adjourn-count K at which the next dream fires.
 *  Chair gets a tighter K because it participates in EVERY room
 *  (every cast — directors only show up when picked) and so its
 *  memory pile grows roughly 2× faster than any single director.
 *  Director K is the more conservative default. */
export const DREAM_TRIGGER_THRESHOLD_DIRECTOR = 5;
export const DREAM_TRIGGER_THRESHOLD_CHAIR = 3;
/** Default kept for callers that haven't been migrated yet · resolves
 *  to the director threshold. New code should use `triggerThresholdFor`. */
export const DREAM_TRIGGER_THRESHOLD = DREAM_TRIGGER_THRESHOLD_DIRECTOR;

/** Memory count at which the boot-time sweep force-fires a dream
 *  regardless of the per-agent counter. Catches mid-cycle crashes
 *  (process killed during extraction → counter never advanced).
 *  Chair's lower ceiling reflects the same accumulation-rate logic
 *  as its lower K. */
export const DREAM_BOOT_FORCE_CEILING_DIRECTOR = 80;
export const DREAM_BOOT_FORCE_CEILING_CHAIR = 50;
/** Default kept for callers that haven't been migrated · resolves to
 *  the director ceiling. New code should use `bootCeilingFor`. */
export const DREAM_BOOT_FORCE_CEILING = DREAM_BOOT_FORCE_CEILING_DIRECTOR;

/** Resolve the adjourn-count threshold for a given role. */
export function triggerThresholdFor(role: AgentRoleKind): number {
  return role === "moderator" ? DREAM_TRIGGER_THRESHOLD_CHAIR : DREAM_TRIGGER_THRESHOLD_DIRECTOR;
}
/** Resolve the boot-time memory-count ceiling for a given role. */
export function bootCeilingFor(role: AgentRoleKind): number {
  return role === "moderator" ? DREAM_BOOT_FORCE_CEILING_CHAIR : DREAM_BOOT_FORCE_CEILING_DIRECTOR;
}

/** In-memory adjourn counter keyed by agentId. Process-local · we
 *  don't persist it because (a) it resets on boot which is fine
 *  (the boot sweep handles overflowed agents), and (b) it would
 *  add a column for what's purely runtime bookkeeping. */
const adjournCounter = new Map<string, number>();

/** Bump the post-adjourn counter for one agent. If the bump crosses
 *  the role-aware threshold (chair K=3, director K=5), returns true
 *  (caller fires the dream and resets the counter via
 *  `resetAdjournCounter`). The role parameter is required so chair
 *  cycles through dreams faster than directors. */
export function bumpAdjournCounter(agentId: string, role: AgentRoleKind): boolean {
  const next = (adjournCounter.get(agentId) ?? 0) + 1;
  adjournCounter.set(agentId, next);
  return next >= triggerThresholdFor(role);
}

export function resetAdjournCounter(agentId: string): void {
  adjournCounter.set(agentId, 0);
}

/** Result of one dream cycle · returned for testing + logging. The
 *  shape mirrors the planned `agent_dreams` audit table from Phase 2;
 *  Phase 1 just prints these counts to stderr. */
export interface DreamSummary {
  agentId: string;
  startedAt: number;
  finishedAt: number;
  beforeCount: number;
  afterCount: number;
  decayed: number;
  /** Phase 2 fields · always 0 in Phase 1. Kept in the shape so the
   *  log line format stabilises ahead of the full pipeline. */
  merged: number;
  promoted: number;
  superseded: number;
}

/** Optional per-call config · the trigger sites pass nothing (use
 *  defaults), the manual-trigger endpoint can pass tighter
 *  thresholds for an aggressive sweep. */
export interface DreamConfig {
  /** Override the heuristic decay thresholds. */
  decay?: DecayThresholds;
  /** Skip LLM steps · used by tests and by environments without an
   *  available utility model. Decay + heuristic promote still run. */
  skipLLM?: boolean;
}

/** Memory count below which clustering is skipped · 5 items is
 *  smaller than the LLM call's overhead is worth. */
const CLUSTER_MIN_SIZE = 6;
/** Maximum memories sent to one cluster/conflict prompt. Above this
 *  we'd risk truncated output; the dream skips the step rather
 *  than send a partial set. */
const CLUSTER_MAX_SIZE = 60;

/** Promotion heuristic · a short-tier memory becomes long-tier when:
 *  · provenanceRooms >= 3  (reinforced across at least 3 rooms)
 *  · age >= 7 days         (had time to stabilise)
 *  · confidence >= 0.6     (not a low-conviction guess) */
const PROMOTE_MIN_PROVENANCE = 3;
const PROMOTE_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PROMOTE_MIN_CONFIDENCE = 0.6;

/** Step-6 harvest gate · only fire the chair-only user_long_memory
 *  harvest pass when there's enough signal to be worth an LLM call.
 *  Either the chair already has a substantial long-tier pool (>=5
 *  entries) OR this dream just promoted enough new memories
 *  (>=3) for fresh patterns to be worth lifting. */
const USER_LONG_HARVEST_MIN_LONG = 5;
const USER_LONG_HARVEST_MIN_NEW_PROMOTED = 3;
/** Soft cap on active user_long_memory rows · keeps the chair
 *  prompt block + chair-profile UI bounded. Cap is "active" rows
 *  only (superseded rows live forever as audit trail). */
const USER_LONG_CAP = 30;

/** Run one dream cycle for a single agent. Five-step pipeline:
 *  decay → cluster → merge → conflict-resolve → promote. Each step
 *  is wrapped so a failure cascades only that step's contribution
 *  (other steps still complete) — partial completion is always
 *  better than aborting and leaving the memory pile unprocessed.
 *
 *  Errors propagate from THIS function only when something
 *  unrecoverable happens (e.g. DB closed). LLM call failures inside
 *  steps 2-4 are caught and counted as zero-impact for that step. */
export async function runDreamCycle(agentId: string, config: DreamConfig = {}): Promise<DreamSummary> {
  const startedAt = Date.now();
  const beforeCount = countMemoriesForAgent(agentId);
  const userName = getPrefs().name?.trim() || "the user";

  // ── Step 1 · heuristic decay (no LLM) ────────────────────────
  // Drop non-pinned `tier='short'` memories that are old AND
  // never injected AND low confidence. AND-ing all three predicates
  // means we only catch the genuinely-forgotten set. Pinned + long-
  // tier memories are sacred.
  const decayed = decayShortTermMemories(agentId, config.decay);

  // Pull the post-decay short-tier set ONCE · steps 2-4 work
  // off this snapshot. We don't refetch between steps because
  // (a) each step's mutations are sub-additive (only mark older
  //   rows as superseded; never delete) and
  // (b) avoiding re-reads keeps the cycle cheap.
  let shortPool = listTierForAgent(agentId, "short").filter((m) => !m.pinned);

  let merged = 0;
  let supersededCount = 0;
  let promoted = 0;

  // ── Step 2 · cluster + Step 3 · merge per cluster ────────────
  // Skip LLM steps gracefully when no utility model is reachable
  // (e.g. fresh install with no API key configured). The decay +
  // promote heuristics still run, so the cycle still has an effect.
  const utility = config.skipLLM ? null : utilityModelFor();
  if (utility && shortPool.length >= CLUSTER_MIN_SIZE && shortPool.length <= CLUSTER_MAX_SIZE) {
    try {
      const { system, user } = buildClusterPrompt(shortPool, userName);
      const raw = await callLLM({
        modelV: utility,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        maxTokens: 600,
      });
      const knownIds = new Set(shortPool.map((m) => m.id));
      const clusters = parseClusterOutput(raw, knownIds);
      const byId = new Map(shortPool.map((m) => [m.id, m] as const));

      for (const ids of clusters) {
        const sources = ids.map((id) => byId.get(id)).filter((m): m is AgentMemory => !!m);
        if (sources.length < 2) continue;
        try {
          const mergePrompt = buildMergePrompt(sources, userName);
          const mergeRaw = await callLLM({
            modelV: utility,
            messages: [
              { role: "system", content: mergePrompt.system },
              { role: "user", content: mergePrompt.user },
            ],
            temperature: 0.2,
            maxTokens: 200,
          });
          const result = parseMergeOutput(mergeRaw);
          if (!result) continue;
          const consolidated = insertConsolidatedMemory({
            agentId,
            content: result.content,
            kind: result.kind,
            sources,
          });
          const supersededByMerge = markSuperseded(
            sources.map((s) => s.id),
            consolidated.id,
          );
          merged += 1;
          supersededCount += supersededByMerge;
        } catch (e) {
          process.stderr.write(
            `[dream] merge step for one cluster failed: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }
    } catch (e) {
      process.stderr.write(
        `[dream] cluster step failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    // Refresh shortPool · supersession + new merged rows changed it.
    shortPool = listTierForAgent(agentId, "short").filter((m) => !m.pinned);
  }

  // ── Step 4 · conflict resolve ────────────────────────────────
  // Looks for pairs of memories that contradict; the older one
  // gets superseded by the newer. Same skip rules as clustering.
  if (utility && shortPool.length >= 2 && shortPool.length <= CLUSTER_MAX_SIZE) {
    try {
      const { system, user } = buildConflictPrompt(shortPool, userName);
      const raw = await callLLM({
        modelV: utility,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        maxTokens: 400,
      });
      const knownIds = new Set(shortPool.map((m) => m.id));
      const pairs = parseConflictOutput(raw, knownIds);
      for (const pair of pairs) {
        // markSuperseded skips pinned and self · safe to call even
        // if the older row is somehow already superseded (no-op).
        const n = markSuperseded([pair.older], pair.newer);
        supersededCount += n;
      }
    } catch (e) {
      process.stderr.write(
        `[dream] conflict step failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  // ── Step 5 · promote stable memories to long tier (no LLM) ───
  // Memories surviving multiple rooms with high confidence get
  // pulled into the always-injected band so future prompts treat
  // them as decision-relevant priors instead of recency noise.
  const fresh = listTierForAgent(agentId, "short").filter((m) => !m.pinned);
  const ageCutoff = Date.now() - PROMOTE_MIN_AGE_MS;
  const promoteIds = fresh
    .filter(
      (m) =>
        m.provenanceRooms >= PROMOTE_MIN_PROVENANCE &&
        m.createdAt <= ageCutoff &&
        m.confidence >= PROMOTE_MIN_CONFIDENCE,
    )
    .map((m) => m.id);
  if (promoteIds.length > 0) {
    promoted = promoteToLong(promoteIds);
  }

  // Resolve the agent record once · used by Step 6's chair-gate
  // AND by the audit log block at the bottom.
  const agent = getAgent(agentId);

  // ── Step 6 · chair-only harvest into user_long_memory ────────
  // The four LLM-and-heuristic passes above operate on the
  // PER-AGENT memory pool (agent_memories). They consolidate
  // and tier-promote that pool — but a chair memory that the
  // dream considered "stable" can still be merged into another
  // canonical sentence on a later cycle, or marked superseded
  // when the user's framing shifts mid-arc, or simply lose its
  // entitled abstraction when collapsed alongside specifics.
  //
  // This step lifts a DIFFERENT shape of memory out of the
  // chair's tier='long' set — tag-shaped abstractions about the
  // USER themselves (founder · anti-jargon · long-horizon-bias)
  // — into the parallel `user_long_memory` table where the
  // dream cycle never touches them again. Future dreams over
  // agent_memories don't disturb that sanctuary; the LLM here
  // only ever appends or supersedes-on-direct-contradiction.
  let userLongInserted = 0;
  let userLongReinforced = 0;
  let userLongSuperseded = 0;
  let userLongPruned = 0;
  if (
    !config.skipLLM &&
    utility &&
    agent?.roleKind === "moderator"
  ) {
    try {
      const chairLong = listTierForAgent(agentId, "long");
      const eligible = chairLong.length >= USER_LONG_HARVEST_MIN_LONG
        || promoted >= USER_LONG_HARVEST_MIN_NEW_PROMOTED;
      if (eligible) {
        const existing = listActiveUserLongMemory();
        const harvest = await harvestUserLongMemory({
          modelV: utility,
          userName,
          chairLong,
          existing,
        });
        for (const t of harvest.newTags) {
          try {
            insertUserLongMemory({
              label: t.label,
              claim: t.claim,
              confidence: t.confidence,
              provenanceRooms: t.provenanceRooms,
            });
            userLongInserted++;
          } catch { /* skip malformed individual entries */ }
        }
        for (const r of harvest.reinforce) {
          if (getUserLongMemory(r.id)) {
            bumpUserLongMemoryProvenance(r.id);
            userLongReinforced++;
          }
        }
        for (const s of harvest.supersede) {
          if (!getUserLongMemory(s.oldId)) continue;
          try {
            const fresh = insertUserLongMemory({
              label: s.newTag.label,
              claim: s.newTag.claim,
              confidence: s.newTag.confidence,
              provenanceRooms: s.newTag.provenanceRooms,
            });
            markUserLongMemorySuperseded(s.oldId, fresh.id);
            userLongSuperseded++;
          } catch { /* skip · keep the old row alive rather than drop both */ }
        }
        // Cap-30 safety prune · only fires when the harvest
        // (plus prior runs) has pushed the table above cap.
        if (countActiveUserLongMemory() > USER_LONG_CAP) {
          userLongPruned = pruneActiveUserLongMemoryToCap(USER_LONG_CAP);
        }
      }
    } catch (e) {
      process.stderr.write(
        `[dream] user_long harvest failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  const finishedAt = Date.now();
  const afterCount = countMemoriesForAgent(agentId);

  // Audit log line + persistent dream-log row.
  const label = agent ? `${agent.name} (${agentId.slice(0, 8)})` : agentId.slice(0, 8);
  const userLongTail =
    userLongInserted + userLongReinforced + userLongSuperseded + userLongPruned > 0
      ? ` userLong=+${userLongInserted}/~${userLongReinforced}/×${userLongSuperseded}/-${userLongPruned}`
      : "";
  process.stderr.write(
    `[dream] ${label} · before=${beforeCount} after=${afterCount} ` +
      `decayed=${decayed} merged=${merged} promoted=${promoted} superseded=${supersededCount} ` +
      `took=${finishedAt - startedAt}ms${userLongTail}\n`,
  );
  try {
    recordDream({
      agentId,
      startedAt,
      finishedAt,
      beforeCount,
      afterCount,
      decayed,
      merged,
      promoted,
      superseded: supersededCount,
      notes: utility ? `utility=${utility}` : "no-utility-model · LLM steps skipped",
    });
  } catch (e) {
    process.stderr.write(
      `[dream] audit log failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }

  // Reset the adjourn counter — caller may also reset, but doing it
  // here makes the function self-contained: a manual call from a
  // debug endpoint or boot sweep doesn't leave a stale counter.
  resetAdjournCounter(agentId);

  return {
    agentId,
    startedAt,
    finishedAt,
    beforeCount,
    afterCount,
    decayed,
    merged,
    promoted,
    superseded: supersededCount,
  };
}

// ───────────────────────────────────────────────────────────────
// Step-6 harvest · chair-only LLM pass that lifts tag-shaped
// abstractions from the chair's tier='long' memory pool into the
// parallel `user_long_memory` table. Single short LLM call,
// strict-JSON output, tolerant parser. Failure is non-fatal — the
// dream cycle continues; the user_long_memory table just doesn't
// grow this round.
// ───────────────────────────────────────────────────────────────

interface HarvestNewTag {
  label: string;
  claim: string;
  confidence: number;
  provenanceRooms: number;
}
interface HarvestReinforce {
  id: string;
}
interface HarvestSupersede {
  oldId: string;
  newTag: HarvestNewTag;
}
interface HarvestResult {
  newTags: HarvestNewTag[];
  reinforce: HarvestReinforce[];
  supersede: HarvestSupersede[];
}

const HARVEST_EMPTY: HarvestResult = { newTags: [], reinforce: [], supersede: [] };

function buildHarvestPrompt(opts: {
  userName: string;
  chairLong: AgentMemory[];
  existing: UserLongMemory[];
}): string {
  const existingBlock = opts.existing.length === 0
    ? "(no existing tags yet)"
    : opts.existing
        .map((t) => `[${t.id}] ${t.label} · ${t.claim} · provenance=${t.provenanceRooms}`)
        .join("\n");
  const chairBlock = opts.chairLong.length === 0
    ? "(no long-tier chair memories yet)"
    : opts.chairLong
        .map((m) => `· (${m.kind}, conf=${m.confidence.toFixed(2)}, rooms=${m.provenanceRooms}) ${m.content}`)
        .join("\n");
  return [
    `You are reviewing the chair's long-term memories about ${opts.userName} to extract durable, tag-shaped abstractions that should live in a separate sanctuary table (never decayed, only displaced on direct contradiction).`,
    ``,
    `## Existing user-long-memory tags`,
    existingBlock,
    ``,
    `## Chair's long-tier memories about ${opts.userName}`,
    chairBlock,
    ``,
    `## Output`,
    `Return ONE JSON object with exactly three arrays, nothing else (no prose, no fences):`,
    `{`,
    `  "newTags": [`,
    `    { "label": "short-1-to-3-words", "claim": "short sentence ≤240 chars", "confidence": 0.0-1.0, "provenanceRooms": int>=1 }`,
    `  ],`,
    `  "reinforce": [`,
    `    { "id": "existing-tag-id-from-the-list-above" }`,
    `  ],`,
    `  "supersede": [`,
    `    { "oldId": "existing-tag-id", "newTag": { "label": "...", "claim": "...", "confidence": 0.0-1.0, "provenanceRooms": int>=1 } }`,
    `  ]`,
    `}`,
    ``,
    `## Rules`,
    `· newTags · only propose tags representing abstract, durable patterns about ${opts.userName} that aren't already covered by an existing tag. Each tag must be supported by at least TWO chair memories. Label is short (1-3 words, lowercase-hyphenated), claim is a complete sentence the chair could use as a working hypothesis ("User is a founder who reasons from first principles and refuses corporate vocabulary").`,
    `· reinforce · only when an existing tag's claim is clearly supported by NEW chair memories (memories that weren't already counted toward its provenance).`,
    `· supersede · ONLY on direct contradiction. The existing tag's claim must be NEGATED by evidence in the chair memories. Partial overlap, refinement, or different framing is NOT contradiction — leave those alone.`,
    `· Output empty arrays if nothing applies. Conservative is better than chatty — these tags persist forever unless contradicted.`,
  ].join("\n");
}

function parseHarvestOutput(raw: string): HarvestResult {
  let s = (raw || "").trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(s); } catch { return HARVEST_EMPTY; }
  if (!parsed || typeof parsed !== "object") return HARVEST_EMPTY;
  const j = parsed as Record<string, unknown>;
  const out: HarvestResult = { newTags: [], reinforce: [], supersede: [] };

  const parseTag = (raw: unknown): HarvestNewTag | null => {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label.trim() : "";
    const claim = typeof o.claim === "string" ? o.claim.trim() : "";
    if (!label || !claim) return null;
    if (label.length > 32 || claim.length > 240) return null;
    const confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence)
      ? Math.max(0, Math.min(1, o.confidence))
      : 0.7;
    const provenanceRooms = typeof o.provenanceRooms === "number" && Number.isFinite(o.provenanceRooms)
      ? Math.max(1, Math.floor(o.provenanceRooms))
      : 1;
    return { label, claim, confidence, provenanceRooms };
  };

  if (Array.isArray(j.newTags)) {
    for (const raw of j.newTags) {
      const t = parseTag(raw);
      if (t) out.newTags.push(t);
    }
  }
  if (Array.isArray(j.reinforce)) {
    for (const raw of j.reinforce) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id.trim() : "";
      if (id) out.reinforce.push({ id });
    }
  }
  if (Array.isArray(j.supersede)) {
    for (const raw of j.supersede) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const oldId = typeof o.oldId === "string" ? o.oldId.trim() : "";
      const newTag = parseTag(o.newTag);
      if (oldId && newTag) out.supersede.push({ oldId, newTag });
    }
  }
  return out;
}

async function harvestUserLongMemory(opts: {
  modelV: ModelV;
  userName: string;
  chairLong: AgentMemory[];
  existing: UserLongMemory[];
}): Promise<HarvestResult> {
  const prompt = buildHarvestPrompt({
    userName: opts.userName,
    chairLong: opts.chairLong,
    existing: opts.existing,
  });
  let raw: string;
  try {
    raw = await callLLM({
      modelV: opts.modelV,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      maxTokens: 1200,
    });
  } catch (e) {
    process.stderr.write(
      `[dream] user_long harvest LLM call failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return HARVEST_EMPTY;
  }
  return parseHarvestOutput(raw);
}
