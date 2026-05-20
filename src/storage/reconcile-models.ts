/**
 * Reconcile every agent's `modelV` against the user's currently
 * configured active LLM provider. Run after any key change (PUT /
 * DELETE) and after the default-model preference flips.
 *
 * Under the single-active-LLM-provider invariant (see
 * `src/ai/providers.ts` + migration 041), the user has AT MOST ONE
 * LLM key configured. The carrier-priority fallback chain that
 * previous versions walked is gone — `activeCarrier()` returns that
 * single provider (or null), `reachableModelVs()` and reconcile both
 * branch on its classification (multi-model vs single-model).
 *
 * The rule per agent:
 *   - modelV reachable via active provider → keep
 *   - modelV unreachable + active provider exists → switch to primary
 *     (chair) or random fast pool (director)
 *   - no active provider → clear modelV (agent visibly waits for keys)
 */
import {
  deleteModelBucketEntry,
  getModelBucket,
  listAllAgents,
  updateAgent,
  writeModelBucketEntry,
} from "./agents.js";
import { getPrefs, updatePrefs } from "./prefs.js";
import {
  getProviderKeyState,
  pickRandomFastModel,
} from "../ai/availability.js";
import {
  isMultiModelProvider,
  type LlmProvider,
} from "../ai/providers.js";
import { MODELS, type ModelMeta, type ModelV } from "../ai/registry.js";

/** Per-carrier primary model (the chair's default when that carrier
 *  is active). User-requested fast-tier policy: every primary here is
 *  a fast / mini / flash model so a brand-new user lands on a cheap-
 *  and-quick chair by default. OpenRouter / B.AI map to recognisable
 *  mid-tier so the brand identity is clear while throughput / cost
 *  stays in the fast band. Directors get random picks from
 *  `FAST_POOL_BY_CARRIER` (availability.ts) — see the reconcile loop. */
export const PRIMARY_BY_CARRIER: Record<string, ModelV> = {
  openrouter: "opus-4-6-fast",
  bai:        "haiku-4-5",
  anthropic:  "haiku-4-5",
  openai:     "gpt-5-4-mini",
  google:     "gemini-3-1-flash",
  // xai · no primary (no LLM modelV in registry as of 2026-05-17).
  moonshot:   "kimi-k2-6",
  zhipu:      "glm-5-1",
};

/** Compute which model IDs are reachable right now under the active
 *  LLM provider. */
export function reachableModelVs(): Set<ModelV> {
  const out = new Set<ModelV>();
  const p = getProviderKeyState().activeLlmProvider;
  if (!p) return out;
  for (const [v, meta] of Object.entries(MODELS) as Array<[ModelV, ModelMeta]>) {
    if (p === "openrouter") {
      if (meta.openrouterId) out.add(v);
    } else if (p === "bai") {
      if (meta.baiId) out.add(v);
    } else {
      if (meta.provider === p && !meta.viaUniversalOnly) out.add(v);
    }
  }
  return out;
}

/** Resolve the active LLM provider. Returns the single configured
 *  provider (or null when none). The legacy "walk carrier priority"
 *  fallback is gone — the single-active invariant guarantees at most
 *  one provider, so the answer is deterministic. */
export function activeCarrier(): LlmProvider | null {
  return getProviderKeyState().activeLlmProvider;
}

/** Translate the active carrier into its primary modelV. Returns null
 *  when no carrier is reachable. */
export function activeCarrierPrimary(): ModelV | null {
  const carrier = activeCarrier();
  if (!carrier) return null;
  return PRIMARY_BY_CARRIER[carrier] ?? null;
}

interface ReconcileResult {
  /** Agents whose model was switched to the active primary. */
  switched: string[];
  /** Agents whose model was cleared (no carrier reachable). */
  cleared: string[];
  /** New active primary, if any. */
  primary: ModelV | null;
}

/**
 * Walk every agent and align their `modelV` with the active provider:
 *  - Reachable model → keep (default behaviour)
 *  - Unreachable model + carrier exists → switch to primary (chair)
 *    or random fast pool (director)
 *  - Unreachable model + no carrier → clear (set empty string)
 *
 * `opts.forcePrimary = true` overrides the "keep if reachable" rule:
 * every agent gets re-picked even if their model is still reachable.
 * Used when the user explicitly swaps providers so the cast snaps to
 * the new provider's brand identity immediately.
 *
 * Always clears `agent.carrierPref` to null in the same pass — under
 * single-active, the old pin is at best redundant (= active provider)
 * and at worst stale (pointing at a provider whose key was just
 * swapped away).
 */
export interface ReconcileOptions {
  /** Switch every agent even if their stored modelV is still reachable.
   *  Default false. */
  forcePrimary?: boolean;
  /** The active LLM carrier BEFORE the caller flipped prefs to the new
   *  one. When set, we snapshot every agent's current `modelV` into
   *  `model_by_provider[priorCarrier]` BEFORE we overwrite it — so a
   *  subsequent switch back to `priorCarrier` can restore the user's
   *  manual picks exactly. When undefined / null (boot-time self-heal),
   *  no snapshot runs and we restore-only from existing bucket entries.
   */
  priorCarrier?: LlmProvider | null;
}

export function reconcileAgentModels(opts: ReconcileOptions = {}): ReconcileResult {
  const reachable = reachableModelVs();
  const carrier = activeCarrier();
  const primary = carrier ? PRIMARY_BY_CARRIER[carrier] ?? null : null;
  const forcePrimary = opts.forcePrimary === true;
  const priorCarrier = opts.priorCarrier ?? null;
  const switched: string[] = [];
  const cleared: string[] = [];

  for (const agent of listAllAgents()) {
    const v = (agent.modelV || "").trim();

    // Stale carrierPref sweep · the pin is meaningless under single-
    // active (the active provider IS the carrier). Clear unconditionally.
    if (agent.carrierPref) {
      updateAgent(agent.id, { carrierPref: null });
    }

    // PHASE 1 · snapshot the prior carrier's modelV into the bucket
    // BEFORE we overwrite the agent's row. The guard is symmetric:
    //   - priorCarrier omitted → boot self-heal, no snapshot
    //   - priorCarrier === new carrier → same-provider rotation (e.g.
    //     two OpenRouter credentials), bucket key would be self-write,
    //     skip
    //   - agent has no current modelV → nothing to snapshot
    if (priorCarrier && v && priorCarrier !== carrier) {
      writeModelBucketEntry(agent.id, priorCarrier, v);
    }

    // Default behaviour: leave reachable models alone. forcePrimary
    // skips this guard so every agent funnels into the switch branch.
    if (!forcePrimary && v && reachable.has(v as ModelV)) continue;
    if (primary && carrier) {
      // PHASE 2 · restore from the bucket when possible. Reachability-
      // checked because the model registry can drop entries between
      // sessions (registry refactor, model retired upstream); a stale
      // bucket pointer would resurrect a phantom model. When stale,
      // we drop the entry and fall through to the default pick.
      const bucket = getModelBucket(agent.id);
      const memorised = bucket[carrier];
      const isChair = agent.roleKind === "moderator";
      let target: ModelV;
      if (memorised && reachable.has(memorised as ModelV)) {
        target = memorised as ModelV;
      } else {
        if (memorised) deleteModelBucketEntry(agent.id, carrier);
        // Chair (moderator) stays on the carrier's primary fast model
        // when no bucket entry exists, so the user's "default model"
        // identity remains stable across resets. Directors get a
        // random pick from the carrier's fast pool so each seat shows
        // a different brand badge — on a multi-model carrier this
        // means a visibly mixed cast of brands; on a single-model
        // carrier the pool naturally collapses to that vendor's own
        // fast set.
        target = isChair
          ? primary
          : (pickRandomFastModel(carrier) ?? primary);
      }
      if (v === target) {
        // No row write needed, but DO seed the bucket entry so a
        // subsequent provider switch knows what "current" was even
        // without a prior PATCH having mirrored it (this matters for
        // fresh installs where the seed agents arrive pre-modelV'd
        // but never went through the PATCH write-through).
        if (bucket[carrier] !== target) {
          writeModelBucketEntry(agent.id, carrier, target);
        }
        continue;
      }
      updateAgent(agent.id, { modelV: target });
      writeModelBucketEntry(agent.id, carrier, target);
      switched.push(agent.id);
    } else {
      // No carrier reachable · clear the agent's model. agents.ts
      // model_v column is NOT NULL with a default; setting empty
      // string marks "unset" without violating the constraint. The
      // orchestrator's isModelV() guard treats this as "skip turn".
      // Phase 1 already snapshotted the prior value before this
      // branch runs, so the user's bucket survives even when the
      // active credential drops to none.
      if (v === "") continue;
      updateAgent(agent.id, { modelV: "" });
      cleared.push(agent.id);
    }
  }

  // Multi-model carriers benefit from the brand-mixed cast; single-
  // model active provider is fine with the pool naturally collapsing.
  // The classification is exposed via isMultiModelProvider() — used
  // elsewhere; no branch needed here.
  void isMultiModelProvider;

  // Keep prefs.defaultModelV in sync — but ONLY when the user's
  // explicit choice is unset, unreachable, or the caller asked to
  // force the primary (e.g. user picked a new provider).
  //
  // Unconditional overwrites are a footgun: cli.ts's self-heal
  // reconcile runs on every boot, and a user who explicitly picked
  // haiku-4-5 would see their preference revert on every restart
  // otherwise. Self-heal's job is making stale unreachable defaults
  // reachable again — not second-guessing a still-reachable choice.
  const prefs = getPrefs();
  const currentReachable = !!prefs.defaultModelV && reachable.has(prefs.defaultModelV as ModelV);
  const shouldBump = forcePrimary || !prefs.defaultModelV || !currentReachable;
  if (primary && shouldBump && prefs.defaultModelV !== primary) {
    updatePrefs({ defaultModelV: primary });
  } else if (!primary && prefs.defaultModelV !== null) {
    updatePrefs({ defaultModelV: null });
  }

  return { switched, cleared, primary };
}
