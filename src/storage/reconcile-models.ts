/**
 * Reconcile every agent's `modelV` against the user's currently
 * configured keys. Run after any key change (PUT / DELETE) and after
 * the default-model preference flips.
 *
 * The carrier model · a single rule:
 *
 *   For each agent: if their current modelV is reachable (some carrier
 *   can serve it with the current keys), keep it. If not, switch to
 *   the current default carrier's primary model. If no carrier is
 *   reachable at all, clear the modelV (set to null) so the agent
 *   visibly waits for keys.
 *
 * "Default carrier" = the carrier of `prefs.defaultModelV`, or the
 * first reachable carrier in priority order [openrouter, anthropic,
 * openai, google, xai] when no default is set or its model is
 * unreachable.
 */
import { listAllAgents, updateAgent } from "./agents.js";
import { getKey } from "./keys.js";
import { getPrefs, updatePrefs } from "./prefs.js";
import { MODELS, type ModelMeta, type ModelV, type Provider } from "../ai/registry.js";
import { pickRandomFastModel } from "../ai/availability.js";

/** A "carrier" is the network path a model travels on · OpenRouter
 *  and B.AI route everything; the rest match the model's own provider.
 *  The Provider type tracks model creators (anthropic / openai / …);
 *  we widen it here to also cover universal carriers. */
type Carrier = Provider | "openrouter" | "bai";

/** Per-carrier primary model (the chair's default when that carrier
 *  is the active one). User-requested fast-tier policy: every primary
 *  here is a fast / mini / flash model so a brand-new user lands on a
 *  cheap-and-quick chair by default. OpenRouter / B.AI intentionally
 *  map to recognisable mid-tier so the brand identity is clear while
 *  the throughput / cost stays in the fast band. Directors are picked
 *  randomly from `FAST_POOL_BY_CARRIER` in availability.ts — see the
 *  reconcile loop below. */
export const PRIMARY_BY_CARRIER: Record<string, ModelV> = {
  openrouter: "opus-4-6-fast",
  bai:        "haiku-4-5",
  anthropic:  "haiku-4-5",
  openai:     "gpt-5-4-mini",
  google:     "gemini-3-1-flash",
  // xai · no primary (no LLM modelV in registry as of 2026-05-17). The
  // adapter / availability layer skip xai when this key is absent.
};

/** Carrier preference order when prefs.defaultModelV isn't set / its
 *  model is unreachable. OpenRouter first because it routes everything
 *  (historically the universal carrier); B.AI next as the second
 *  universal option; direct providers after. */
const CARRIER_PRIORITY: Carrier[] = ["openrouter", "bai", "anthropic", "openai", "google", "xai"];

/** Compute which model IDs are reachable right now. A modelV is
 *  reachable when at least one of its carriers has a configured key.
 *  Mirrors the precedence rules used by the LLM adapter. */
export function reachableModelVs(): Set<ModelV> {
  const out = new Set<ModelV>();
  const orKey = !!getKey("openrouter");
  const baiKey = !!getKey("bai");
  for (const [v, meta] of Object.entries(MODELS) as Array<[ModelV, ModelMeta]>) {
    // Path 1 · OpenRouter carries everything when the OR key exists.
    if (orKey) {
      out.add(v);
      continue;
    }
    // Path 2 · B.AI carries this model when a baiId is registered.
    if (baiKey && meta.baiId) {
      out.add(v);
      continue;
    }
    // Path 3 · direct provider key, model not universal-only.
    if (!meta.viaUniversalOnly && hasDirectKey(meta.provider)) {
      out.add(v);
      continue;
    }
    // Path 4 · universal-only model with NO OR / B.AI key but a direct
    // provider key exists → adapter falls back to direct (may fail at
    // the API level if the model id isn't on the SDK). Treat as
    // reachable so the picker exposes it; the LLM call is the source
    // of truth.
    if (meta.viaUniversalOnly && hasDirectKey(meta.provider)) {
      out.add(v);
    }
  }
  return out;
}

/** Direct keys are scoped to providers we have an SDK for. DeepSeek
 *  has no @ai-sdk client in this codebase, so a DeepSeek direct key
 *  would be unreachable; we treat the provider list as openai /
 *  anthropic / google / xai. */
function hasDirectKey(provider: Provider): boolean {
  switch (provider) {
    case "anthropic":
    case "openai":
    case "google":
    case "xai":
      return !!getKey(provider);
    default:
      return false;
  }
}

/** Resolve the active carrier · the carrier of prefs.defaultModelV,
 *  or the first reachable carrier in priority order. */
export function activeCarrier(): Carrier | null {
  const prefs = getPrefs();
  if (prefs.defaultModelV) {
    const meta = MODELS[prefs.defaultModelV as ModelV];
    if (meta) {
      // The default model exists; resolve which carrier is currently
      // serving it. OpenRouter wins for `viaUniversalOnly` models when
      // both OR + direct are configured (matches the adapter's
      // "viaUniversalOnly + OR key" precedence). Direct provider key
      // wins over B.AI / OR for non-universal-only models. B.AI is
      // preferred over OR among universal carriers (matches adapter
      // precedence).
      if (meta.viaUniversalOnly && getKey("openrouter")) return "openrouter";
      if (hasDirectKey(meta.provider)) return meta.provider;
      if (getKey("bai") && meta.baiId) return "bai";
      if (getKey("openrouter")) return "openrouter";
    }
  }
  // Fall through · pick the first reachable carrier in priority order.
  for (const c of CARRIER_PRIORITY) {
    if (c === "openrouter" && getKey("openrouter")) return "openrouter";
    if (c === "bai" && getKey("bai")) return "bai";
    if (c !== "openrouter" && c !== "bai" && hasDirectKey(c)) return c;
  }
  return null;
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
 * Walk every agent and align their `modelV` with the current key set.
 * - Reachable model → keep (default behavior)
 * - Unreachable model + carrier exists → switch to primary
 * - Unreachable model + no carrier → clear (set empty string)
 *
 * `opts.forcePrimary = true` overrides the "keep if reachable" rule:
 * every agent that isn't already on the active primary gets switched
 * to it, even if their current model is still reachable on a different
 * carrier. Used during onboarding when the user picks a provider as
 * their primary — without this, a user who already had OpenRouter
 * configured and adds Gemini would see the chair stay on `opus-4-7`
 * (still reachable via OR) instead of swinging to `gemini-3-flash`.
 *
 * Also bumps `prefs.defaultModelV` to the active primary whenever it
 * lands on a different value · keeps "what new agents will inherit"
 * consistent with "what existing agents are running".
 */
export interface ReconcileOptions {
  /** Switch every agent to the active primary even if their stored
   *  modelV is still reachable. Default false (conservative). */
  forcePrimary?: boolean;
}

export function reconcileAgentModels(opts: ReconcileOptions = {}): ReconcileResult {
  const reachable = reachableModelVs();
  const carrier = activeCarrier();
  const primary = carrier ? PRIMARY_BY_CARRIER[carrier] ?? null : null;
  const forcePrimary = opts.forcePrimary === true;
  const switched: string[] = [];
  const cleared: string[] = [];

  // Carrier-key reachability sweep · also used below to clear
  // unreachable `carrierPref` pins so an agent that was pinned to
  // (say) OpenRouter doesn't keep its now-meaningless pin once the
  // user revokes that key. The pin still falls through gracefully in
  // the adapter, but leaving it set is misleading state · the picker
  // would render "via OpenRouter" on an agent that's actually being
  // routed through B.AI under the hood.
  const orReachable = !!getKey("openrouter");
  const baiReachable = !!getKey("bai");
  function carrierKeyReachable(c: string): boolean {
    if (c === "openrouter") return orReachable;
    if (c === "bai") return baiReachable;
    return hasDirectKey(c as Provider);
  }

  for (const agent of listAllAgents()) {
    const v = (agent.modelV || "").trim();
    // Stale carrierPref sweep · clear pins to carriers whose key has
    // been deleted since the pin was set. Runs independently of the
    // modelV swap below so the pin gets unstuck even when the model
    // itself is still reachable via another carrier.
    if (agent.carrierPref && !carrierKeyReachable(agent.carrierPref)) {
      updateAgent(agent.id, { carrierPref: null });
    }
    // Default behavior: leave reachable models alone. forcePrimary
    // skips this guard so every agent funnels into the switch branch.
    if (!forcePrimary && v && reachable.has(v as ModelV)) continue;
    if (primary && carrier) {
      // Chair (moderator) stays on the carrier's primary fast model
      // so the user's "default model" identity remains stable across
      // resets. Directors get a random pick from the carrier's fast
      // pool so each seat shows a different brand badge (on
      // OpenRouter this means a visibly mixed cast of Anthropic /
      // OpenAI / Google / xAI / DeepSeek fast tiers; on direct
      // carriers it picks from that vendor's own fast set).
      const isChair = agent.roleKind === "moderator";
      const target: ModelV = isChair
        ? primary
        : (pickRandomFastModel(carrier) ?? primary);
      if (v === target) continue;
      updateAgent(agent.id, { modelV: target });
      switched.push(agent.id);
    } else {
      // No carrier reachable · clear the agent's model. agents.ts
      // model_v column is NOT NULL with a default; we set the empty
      // string to mark "unset" since SQLite's NOT NULL constraint
      // applies. The orchestrator's isModelV() guard treats this as
      // "skip turn" — the agent visibly waits for keys.
      if (v === "") continue;
      updateAgent(agent.id, { modelV: "" });
      cleared.push(agent.id);
    }
  }

  // Keep prefs.defaultModelV in sync — but ONLY when the user's
  // explicit choice is unset, unreachable, or the caller asked to
  // force the primary (e.g. onboarding picked a new provider as
  // primary, so the user expects their default to swing).
  //
  // The previous unconditional `prefs.defaultModelV !== primary →
  // overwrite` was a footgun: it ran on every server boot via
  // `cli.ts`'s self-heal reconcile, which meant a user who had
  // OpenRouter (primary = opus-4-7) and explicitly picked haiku-4-5
  // saw their preference revert to opus on every restart. The
  // "self-heal" job is to make stale unreachable defaults reachable
  // again — not to second-guess a still-reachable explicit choice.
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
