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

/** A "carrier" is the network path a model travels on · OpenRouter
 *  routes everything; the rest match the model's own provider. The
 *  Provider type tracks model creators (anthropic / openai / …) and
 *  doesn't include openrouter, so we widen it here. */
type Carrier = Provider | "openrouter";

/** Per-provider primary model (the chair's default when that carrier
 *  is the active one). Tied to which models in the registry are
 *  direct-routable for each provider. OpenRouter as a carrier carries
 *  every model — its primary is opus-4-7 (Anthropic's flagship). */
export const PRIMARY_BY_CARRIER: Record<string, ModelV> = {
  openrouter: "opus-4-7",
  anthropic:  "sonnet-4-6",
  openai:     "gpt-5-5",
  google:     "gemini-3-flash",
  xai:        "grok-4-3",
};

/** Carrier preference order when prefs.defaultModelV isn't set / its
 *  model is unreachable. OpenRouter first because it routes everything;
 *  beyond that, the order doesn't matter much — the user's first-
 *  configured key tends to be picked by onboarding anyway. */
const CARRIER_PRIORITY: Carrier[] = ["openrouter", "anthropic", "openai", "google", "xai"];

/** Compute which model IDs are reachable right now. A modelV is
 *  reachable when at least one of its carriers has a configured key.
 *  Mirrors the precedence rules used by the LLM adapter. */
export function reachableModelVs(): Set<ModelV> {
  const out = new Set<ModelV>();
  const orKey = !!getKey("openrouter");
  for (const [v, meta] of Object.entries(MODELS) as Array<[ModelV, ModelMeta]>) {
    // Path 1 · OpenRouter carries everything when the OR key exists.
    if (orKey) {
      out.add(v);
      continue;
    }
    // Path 2 · direct provider key, model not OR-only.
    if (!meta.openrouterOnly && hasDirectKey(meta.provider)) {
      out.add(v);
      continue;
    }
    // Path 3 · OR-only model, OR key missing, but direct provider key
    // exists → adapter falls back to direct (may fail at the API
    // level if the model id isn't on the SDK). Treat as reachable
    // so the picker exposes it; the LLM call is the source of truth.
    if (meta.openrouterOnly && hasDirectKey(meta.provider)) {
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
      // serving it. OpenRouter wins when both are configured (matches
      // the adapter's "openrouterOnly + OR key" precedence).
      if (meta.openrouterOnly && getKey("openrouter")) return "openrouter";
      if (hasDirectKey(meta.provider)) return meta.provider;
      if (getKey("openrouter")) return "openrouter";
    }
  }
  // Fall through · pick the first reachable carrier in priority order.
  for (const c of CARRIER_PRIORITY) {
    if (c === "openrouter" && getKey("openrouter")) return "openrouter";
    if (c !== "openrouter" && hasDirectKey(c)) return c;
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
  const primary = activeCarrierPrimary();
  const forcePrimary = opts.forcePrimary === true;
  const switched: string[] = [];
  const cleared: string[] = [];

  for (const agent of listAllAgents()) {
    const v = (agent.modelV || "").trim();
    // Default behavior: leave reachable models alone. forcePrimary
    // skips this guard so every agent funnels into the switch branch.
    if (!forcePrimary && v && reachable.has(v as ModelV)) continue;
    if (primary) {
      if (v === primary) continue; // already on primary somehow
      updateAgent(agent.id, { modelV: primary });
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

  // Keep prefs.defaultModelV in sync so the next "create agent" flow
  // and the user-settings UI both reflect what's actually running.
  const prefs = getPrefs();
  if (primary && prefs.defaultModelV !== primary) {
    updatePrefs({ defaultModelV: primary });
  } else if (!primary && prefs.defaultModelV !== null) {
    updatePrefs({ defaultModelV: null });
  }

  return { switched, cleared, primary };
}
