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
import {
  buildClusterPrompt,
  parseClusterOutput,
  buildMergePrompt,
  parseMergeOutput,
  buildConflictPrompt,
  parseConflictOutput,
} from "../ai/prompts/dream-prompts.js";
import { getPrefs } from "../storage/prefs.js";

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

  const finishedAt = Date.now();
  const afterCount = countMemoriesForAgent(agentId);

  // Audit log line + persistent dream-log row.
  const agent = getAgent(agentId);
  const label = agent ? `${agent.name} (${agentId.slice(0, 8)})` : agentId.slice(0, 8);
  process.stderr.write(
    `[dream] ${label} · before=${beforeCount} after=${afterCount} ` +
      `decayed=${decayed} merged=${merged} promoted=${promoted} superseded=${supersededCount} ` +
      `took=${finishedAt - startedAt}ms\n`,
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
