/**
 * Model availability layer.
 *
 * Decides which models in the registry the user can ACTUALLY reach
 * right now, given the API keys they've configured. This is the
 * single source of truth that pickers (composer, agent profile,
 * agent creation) and the adapter consult before showing / using
 * any model.
 *
 * The five user states this resolves cleanly:
 *
 *   1. OpenRouter only       → every model reachable, route="openrouter"
 *   2. One direct provider   → only that provider's models, route="direct"
 *   3. Multiple direct       → union of those providers, route="direct"
 *   4. OR + 1+ direct        → every model; direct preferred when available
 *   5. No keys at all        → empty list, frontend prompts user to add one
 *
 * The adapter (src/ai/adapter.ts) already routes to direct vs
 * OpenRouter at call time based on the same key-presence checks;
 * this module surfaces that decision UPFRONT so frontends can hide
 * unreachable models from pickers and so the user has a clear
 * mental model of what they have access to.
 */
import { listKeyMeta, type Provider } from "../storage/keys.js";
import { getPrefs, updatePrefs } from "../storage/prefs.js";
import { activeCarrier } from "../storage/reconcile-models.js";

import { MODELS, type ModelMeta, type ModelV } from "./registry.js";

export type ModelRoute = "direct" | "openrouter";

export interface ModelAvailability {
  modelV: ModelV;
  displayName: string;
  provider: Provider;
  /** Sorting hint · the model's deck text from the registry ("deep
   *  reasoning", "fast · low-cost", etc.). Already part of the
   *  registry; copied here so consumers don't need a second lookup. */
  deck: string;
  /** Which routes are currently reachable. At least one is true if
   *  `reachable` is true. */
  routes: { direct: boolean; openrouter: boolean };
  /** True when at least one route works (direct OR openrouter). */
  reachable: boolean;
  /** The route the adapter will use given the current key set.
   *  Direct wins over OpenRouter when both work — the user paid for
   *  the direct subscription, so we use it (lower fees, fewer
   *  hops, often higher rate limits). */
  preferredRoute: ModelRoute | null;
}

/** Snapshot of which providers the user has configured. */
export interface ProviderKeyState {
  /** OpenRouter (the universal-fallback route). */
  hasOpenRouter: boolean;
  /** Direct LLM provider keys, by provider. Skips brave (not an LLM). */
  directProviders: Set<Provider>;
}

export function getProviderKeyState(): ProviderKeyState {
  const directProviders = new Set<Provider>();
  let hasOpenRouter = false;
  for (const meta of listKeyMeta()) {
    if (!meta.configured) continue;
    if (meta.provider === "openrouter") hasOpenRouter = true;
    else if (meta.provider === "brave") continue; // skill key, not an LLM provider
    else directProviders.add(meta.provider);
  }
  return { hasOpenRouter, directProviders };
}

/** Compute reachability for a single model under the given key state. */
export function availabilityFor(
  meta: ModelMeta,
  keys: ProviderKeyState,
): ModelAvailability {
  const directReachable = !meta.openrouterOnly && keys.directProviders.has(meta.provider);
  const orReachable = keys.hasOpenRouter && !!meta.openrouterId;
  const reachable = directReachable || orReachable;
  return {
    modelV: meta.v,
    displayName: meta.displayName,
    provider: meta.provider,
    deck: meta.deck,
    routes: { direct: directReachable, openrouter: orReachable },
    reachable,
    preferredRoute: directReachable ? "direct" : orReachable ? "openrouter" : null,
  };
}

/** Return availability for every model in the registry (whether
 *  reachable or not). Frontends typically filter to .reachable; the
 *  adapter / settings UI may want the full list to show "unreachable"
 *  states with hints on which key would unlock them. */
export function modelAvailability(): ModelAvailability[] {
  const keys = getProviderKeyState();
  return Object.values(MODELS).map((meta) => availabilityFor(meta, keys));
}

/** Convenience · just the reachable models. */
export function reachableModels(): ModelAvailability[] {
  return modelAvailability().filter((m) => m.reachable);
}

/** True iff the user has configured at least one LLM provider. The
 *  bootstrap state — `false` here — means model pickers should not
 *  render and convene flows should redirect to settings. */
export function hasAnyModelKey(): boolean {
  const keys = getProviderKeyState();
  return keys.hasOpenRouter || keys.directProviders.size > 0;
}

/** Pick a sensible default model for the user given their current
 *  keys. Used as the seed value for prefs.default_model_v on first
 *  key-add, and as a runtime fallback when a stored default is no
 *  longer reachable. Selection rule:
 *
 *    1. If only one direct provider is configured, return that
 *       provider's flagship.
 *    2. Else if OpenRouter is configured, return Opus 4.7 (the
 *       historical default for OR-routed setups).
 *    3. Else if any direct provider is configured, return its
 *       flagship.
 *    4. Else null (no keys at all).
 *
 *  "Flagship" per provider · roughly the most-capable mainstream
 *  model the user can hit with that key. Conservative picks so we
 *  don't surprise the user with an exotic 1M-ctx variant.
 */
const PROVIDER_FLAGSHIP: Record<Provider, ModelV | null> = {
  anthropic: "opus-4-7",
  openai: "gpt-5-5",
  google: "gemini-3-flash",
  xai: "grok-4-3",
  deepseek: "deepseek-v4-pro",
  openrouter: "opus-4-7",
  brave: null,
};

/** Resolve the default model the user should see RIGHT NOW, with
 *  prefs persistence:
 *
 *    1. If `prefs.default_model_v` is set AND that model is currently
 *       reachable, return it (the user's explicit choice wins).
 *    2. Else compute via `defaultModelFor()` and back-fill prefs so
 *       the value is stable across requests until the user picks
 *       something different OR their key set changes again.
 *
 *  The back-fill is what keeps the value sticky · once a single
 *  reachable default exists, subsequent calls are pure reads. When
 *  the key set changes (e.g. user revokes the provider that hosted
 *  the stored default), we transparently re-pick. */
export function effectiveDefaultModel(): ModelV | null {
  const prefs = getPrefs();
  const reachable = new Set(reachableModels().map((m) => m.modelV));
  if (prefs.defaultModelV && reachable.has(prefs.defaultModelV as ModelV)) {
    return prefs.defaultModelV as ModelV;
  }
  const fresh = defaultModelFor();
  if (fresh !== prefs.defaultModelV) {
    updatePrefs({ defaultModelV: fresh });
  }
  return fresh;
}

export function defaultModelFor(keys: ProviderKeyState = getProviderKeyState()): ModelV | null {
  const reachable = modelAvailability().filter((m) => m.reachable);
  if (reachable.length === 0) return null;
  // Single direct provider · pick its flagship.
  if (!keys.hasOpenRouter && keys.directProviders.size === 1) {
    const provider = Array.from(keys.directProviders)[0];
    const flagship = PROVIDER_FLAGSHIP[provider];
    if (flagship && reachable.find((m) => m.modelV === flagship)) return flagship;
  }
  // OpenRouter present · prefer Opus 4.7 (historical default).
  if (keys.hasOpenRouter) {
    const opus = reachable.find((m) => m.modelV === "opus-4-7");
    if (opus) return opus.modelV;
  }
  // Multiple direct, no OR · pick the first reachable provider's flagship.
  for (const provider of keys.directProviders) {
    const flagship = PROVIDER_FLAGSHIP[provider];
    if (flagship && reachable.find((m) => m.modelV === flagship)) return flagship;
  }
  // Last resort — any reachable model.
  return reachable[0].modelV;
}

/** Pick a "cheap utility" model for background tasks (skill picker,
 *  director auto-pick, agent-spec generation, ability analyzer,
 *  convening speech, etc.). Today these hardcode haiku-4-5; with
 *  per-user key sets that constant breaks for direct-only users.
 *
 *  Selection rule: prefer the user's small/fast tier in this order
 *    1. haiku-4-5         (Anthropic, cheap + fast)
 *    2. gpt-5-4-mini      (OpenAI · 400k ctx, current cheap-tier)
 *    3. gemini-3-1-flash  (Google · 3.1 Flash Lite, cheapest)
 *    4. gemini-3-flash    (Google · 3 Flash, frontier mid-tier)
 *    5. grok-4-mini       (xAI)
 *    6. <user's default model> (last resort — pricy but reachable)
 *
 *  Returns null only when the user has no keys at all, in which case
 *  callers should skip the background task altogether and fall back
 *  to deterministic logic (the spec parser + diversity guardrail
 *  both already have non-LLM fallbacks). */
/** Cheap-tier model that matches a given carrier. Used to bias the
 *  utility list toward whichever carrier the user is currently routing
 *  through, so a user who switched their default to Gemini doesn't
 *  silently keep getting OpenAI background calls. Carriers without
 *  a cheap-tier entry fall through to the static UTILITY_PREFERENCE. */
const CHEAP_BY_CARRIER: Partial<Record<Provider | "openrouter", ModelV>> = {
  openrouter: "haiku-4-5",
  anthropic:  "sonnet-4-6",     // only direct-routable Claude
  openai:     "gpt-5-4-mini",
  google:     "gemini-3-1-flash", // 3.1 Flash Lite · cheapest direct-routable Gemini
  xai:        "grok-4-1-fast",  // 4.1 Fast · cheapest direct-routable Grok
};

const UTILITY_PREFERENCE: ModelV[] = [
  "haiku-4-5",
  "gpt-5-4-mini",
  "gemini-3-1-flash",
  "gemini-3-flash",
  "grok-4-1-fast",
];

export function utilityModelFor(fallback: ModelV | null = null): ModelV | null {
  const reachable = new Set(reachableModels().map((m) => m.modelV));
  // Active-carrier-first · whichever carrier serves the user's current
  // default model gets first dibs on the utility slot. Prevents the
  // "I switched to Gemini but background calls still hit OpenAI" trap
  // where a user with multiple direct keys saw the static preference
  // table always pick gpt-5-4-mini.
  const carrier = activeCarrier();
  if (carrier) {
    const preferred = CHEAP_BY_CARRIER[carrier];
    if (preferred && reachable.has(preferred)) return preferred;
  }
  for (const v of UTILITY_PREFERENCE) {
    if (reachable.has(v)) return v;
  }
  if (fallback && reachable.has(fallback)) return fallback;
  // Last-ditch · any reachable model. Better than throwing.
  const any = Array.from(reachable)[0];
  return (any as ModelV | undefined) ?? null;
}
