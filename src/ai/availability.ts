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

export type ModelRoute = "direct" | "openrouter" | "bai";

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
  routes: { direct: boolean; openrouter: boolean; bai: boolean };
  /** True when at least one route works (direct OR openrouter OR bai). */
  reachable: boolean;
  /** The route the adapter will use given the current key set.
   *  Direct wins over universal carriers (B.AI / OpenRouter) when
   *  available — the user paid for the direct subscription, so we use
   *  it (lower fees, fewer hops, often higher rate limits). When only
   *  a universal carrier works, B.AI is preferred over OpenRouter to
   *  match the adapter's precedence. */
  preferredRoute: ModelRoute | null;
}

/** Snapshot of which providers the user has configured. */
export interface ProviderKeyState {
  /** OpenRouter (universal-fallback route). */
  hasOpenRouter: boolean;
  /** B.AI (universal-fallback route · second universal carrier). */
  hasBai: boolean;
  /** Direct LLM provider keys, by provider. Skips brave (not an LLM). */
  directProviders: Set<Provider>;
}

export function getProviderKeyState(): ProviderKeyState {
  const directProviders = new Set<Provider>();
  let hasOpenRouter = false;
  let hasBai = false;
  for (const meta of listKeyMeta()) {
    if (!meta.configured) continue;
    if (meta.provider === "openrouter") hasOpenRouter = true;
    else if (meta.provider === "bai") hasBai = true;
    else if (meta.provider === "brave" || meta.provider === "tavily" || meta.provider === "minimax" || meta.provider === "elevenlabs") continue; // skill / voice keys, not LLM
    else directProviders.add(meta.provider);
  }
  return { hasOpenRouter, hasBai, directProviders };
}

/** Compute reachability for a single model under the given key state. */
export function availabilityFor(
  meta: ModelMeta,
  keys: ProviderKeyState,
): ModelAvailability {
  const directReachable = !meta.viaUniversalOnly && keys.directProviders.has(meta.provider);
  const orReachable = keys.hasOpenRouter && !!meta.openrouterId;
  const baiReachable = keys.hasBai && !!meta.baiId;
  const reachable = directReachable || orReachable || baiReachable;
  return {
    modelV: meta.v,
    displayName: meta.displayName,
    provider: meta.provider,
    deck: meta.deck,
    routes: { direct: directReachable, openrouter: orReachable, bai: baiReachable },
    reachable,
    preferredRoute: directReachable ? "direct" : baiReachable ? "bai" : orReachable ? "openrouter" : null,
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
  // Universal carriers (OpenRouter, B.AI) each count as "has a key" on
  // their own · without including hasBai here, a user who configured
  // only a B.AI key gets bounced to "no LLM key configured" in the
  // settings default-model panel even though every model with a baiId
  // is fully reachable.
  return keys.hasOpenRouter || keys.hasBai || keys.directProviders.size > 0;
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
  // xai · no LLM modelV currently in the registry (all grok-* entries
  // removed 2026-05-17 when B.AI dropped xAI). Keep the key so the
  // Record type stays exhaustive; the resolver naturally skips it.
  xai: null,
  deepseek: "deepseek-v4-pro",
  zhipu: "glm-5-1",
  moonshot: "kimi-k2-6",
  openrouter: "opus-4-7",
  bai: "opus-4-7",
  brave: null,
  tavily: null,
  // minimax has LLM models now (minimax-m2-7 / m2-5) but no direct
  // @ai-sdk path · only the B.AI route works. The Provider Record here
  // refers to *direct* providers, so `null` is correct: a user with
  // only a minimax voice key shouldn't try to use it as their LLM
  // flagship. B.AI carrier still picks up the MiniMax LLMs naturally.
  minimax: null,
  elevenlabs: null,
};

/** Fast-tier default per provider · the "cheap and fast" model
 *  the user gets as their default after onboarding. Per the
 *  user-requested fast-default policy: avoid pro/flagship for
 *  the auto-default so a brand-new user doesn't immediately
 *  burn the most expensive token rate on every chair turn.
 *  OpenRouter intentionally maps to `opus-4-6-fast` (the
 *  Anthropic 4.6 Fast variant) so the brand identity stays
 *  recognisable while the throughput / cost is the fast tier. */
const PROVIDER_FAST: Record<Provider, ModelV | null> = {
  anthropic: "haiku-4-5",
  openai: "gpt-5-4-mini",
  google: "gemini-3-1-flash",
  // xai · no LLM modelV in the registry (see PROVIDER_FLAGSHIP note).
  xai: null,
  deepseek: "deepseek-v4-flash",
  // GLM / Kimi · no separate fast/flash tier in our registry yet, so
  // both providers' "fast pick" falls back to the same flagship that
  // PROVIDER_FLAGSHIP names. Reachability-via-OR/B.AI carries it.
  zhipu: "glm-5-1",
  moonshot: "kimi-k2-6",
  openrouter: "opus-4-6-fast",
  bai: "haiku-4-5",
  brave: null,
  tavily: null,
  minimax: null,
  elevenlabs: null,
};

/** Per-carrier fast-tier POOL · used to randomize each director's
 *  model so a fresh user gets a visibly diverse cast (different
 *  brand badges per seat) instead of every director speaking
 *  through the same wire. OpenRouter routes everything so its
 *  pool spans brands; direct carriers stick to their own fast
 *  models since they can only call their own SDK. Consumed by
 *  `pickRandomFastModel()` below + `reconcile-models.ts` during
 *  the onboarding `forcePrimary` sweep. */
export const FAST_POOL_BY_CARRIER: Record<string, readonly ModelV[]> = {
  openrouter: [
    "opus-4-6-fast",
    "haiku-4-5",
    "gpt-5-4-mini",
    "gemini-3-flash",
    "gemini-3-1-flash",
    "deepseek-v4-flash",
  ],
  // B.AI carries the same brand-spanning fast catalog as OpenRouter
  // (minus Grok · B.AI dropped xAI 2026-05) · identical pool gives a
  // B.AI-only user the same visibly-mixed director cast (different
  // brand badges per seat) that the OpenRouter path produces. Members
  // are filtered against reachability inside `pickRandomFastModel`, so
  // models without a baiId fall out naturally if B.AI ends up not
  // carrying one of them in practice.
  bai: [
    "haiku-4-5",
    "gpt-5-4-mini",
    "gemini-3-flash",
    "gemini-3-1-flash",
    "deepseek-v4-flash",
  ],
  anthropic: ["opus-4-6-fast", "haiku-4-5"],
  openai: ["gpt-5-4-mini"],
  google: ["gemini-3-flash", "gemini-3-1-flash"],
  // xai · no fast pool (no LLM modelV in registry).
};

/** Pick a random fast-tier model for the given carrier. Filters
 *  to reachable models first so we never hand back a modelV the
 *  user's current keys can't actually serve. Falls back to the
 *  full pool if reachability narrows it to zero (the LLM call
 *  remains the source of truth for "can this model run"). */
export function pickRandomFastModel(carrier: string | null): ModelV | null {
  if (!carrier) return null;
  const pool = FAST_POOL_BY_CARRIER[carrier];
  if (!pool || pool.length === 0) return null;
  const reachable = new Set(reachableModels().map((m) => m.modelV));
  const candidates = pool.filter((v) => reachable.has(v));
  const list = candidates.length > 0 ? candidates : pool;
  return list[Math.floor(Math.random() * list.length)] ?? null;
}

/** Flagship-tier model pool · superset of PROVIDER_FLAGSHIP. Each
 *  provider's primary flagship plus any comparable peers (e.g.
 *  sonnet-4-6 alongside opus-4-7) so callers that need a fallback
 *  still have one when the user's pick isn't reachable.
 *
 *  Single source of truth · imported by
 *  `routes/agents.ts:agentSpecModelCandidates()`. Was previously a
 *  separate hardcoded Set in that file, which silently drifted from
 *  PROVIDER_FLAGSHIP — the gap surfaced as DeepSeek-only users
 *  having no flagship-tier fallbacks during agent-spec generation. */
export const FLAGSHIP_TIER: ReadonlySet<ModelV> = new Set<ModelV>([
  // Anthropic
  "opus-4-7", "sonnet-4-6",
  // OpenAI
  "gpt-5-5", "gpt-5-4",
  // Google
  "gemini-3-1", "gemini-3-flash",
  // xAI · no flagship in registry currently.
  // DeepSeek
  "deepseek-v4-pro",
  // Zhipu · Moonshot · MiniMax · single flagship each (B.AI routed).
  "glm-5-1",
  "kimi-k2-6",
  "minimax-m2-7",
]);

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
  // Fast-default policy · pick the FAST-tier model for the active
  // provider rather than its flagship. A brand-new user should
  // land on a cheap-and-quick chair by default; if they want the
  // flagship, they can flip it in settings. (PROVIDER_FLAGSHIP
  // still drives spec-generation candidates elsewhere — it's
  // not dead code, just no longer the user-facing default.)
  if (!keys.hasOpenRouter && keys.directProviders.size === 1) {
    const provider = Array.from(keys.directProviders)[0];
    const fast = PROVIDER_FAST[provider];
    if (fast && reachable.find((m) => m.modelV === fast)) return fast;
    const flagship = PROVIDER_FLAGSHIP[provider];
    if (flagship && reachable.find((m) => m.modelV === flagship)) return flagship;
  }
  // OpenRouter present · prefer Opus 4.6 Fast (per fast-default policy).
  if (keys.hasOpenRouter) {
    const fast = reachable.find((m) => m.modelV === "opus-4-6-fast");
    if (fast) return fast.modelV;
    const opus = reachable.find((m) => m.modelV === "opus-4-7");
    if (opus) return opus.modelV;
  }
  // B.AI present · prefer Haiku 4.5 (matches PRIMARY_BY_CARRIER.bai +
  // the fast-default policy). Falls back to Opus 4.7 if Haiku isn't
  // routable (e.g. if a future B.AI key set yanked it). Without this
  // branch, a B.AI-only user falls through to "any reachable" and
  // gets whatever happens to be first in MODELS iteration order ·
  // not necessarily the cheapest / fastest tier the user expects.
  if (keys.hasBai) {
    const fast = reachable.find((m) => m.modelV === "haiku-4-5");
    if (fast) return fast.modelV;
    const opus = reachable.find((m) => m.modelV === "opus-4-7");
    if (opus) return opus.modelV;
  }
  // Multiple direct, no OR · pick the first reachable provider's fast tier.
  for (const provider of keys.directProviders) {
    const fast = PROVIDER_FAST[provider];
    if (fast && reachable.find((m) => m.modelV === fast)) return fast;
  }
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
 *  a cheap-tier entry fall through to the static UTILITY_PREFERENCE.
 *
 *  Single source of truth · imported by both `utilityModelFor()` (this
 *  file) and `skill-picker.ts:pickRouterModel()` so adding a new
 *  carrier or swapping a carrier's cheap model only edits this map.
 *  Previously skill-picker carried its own copy and the two could
 *  silently drift on any update. */
export const CHEAP_BY_CARRIER: Partial<Record<Provider | "openrouter", ModelV>> = {
  openrouter: "haiku-4-5",
  bai:        "haiku-4-5",       // B.AI carries Haiku 4.5 (claude-haiku-4-5)
  anthropic:  "sonnet-4-6",     // only direct-routable Claude
  openai:     "gpt-5-4-mini",
  google:     "gemini-3-1-flash", // 3.1 Flash Lite · cheapest direct-routable Gemini
  // xai · no cheap tier (no LLM modelV in registry).
};

const UTILITY_PREFERENCE: ModelV[] = [
  "haiku-4-5",
  "gpt-5-4-mini",
  "gemini-3-1-flash",
  "gemini-3-flash",
];

export function utilityModelFor(fallback: ModelV | null = null): ModelV | null {
  const reachable = new Set(reachableModels().map((m) => m.modelV));

  // User-default-first · if the user explicitly picked a utility-class
  // model as their default (Gemini Flash, GPT-mini, Haiku, Grok Fast),
  // use it directly. The earlier carrier-aware path forced OpenRouter
  // users onto haiku-4-5 even when they'd switched their default to
  // a different family's small-fast model — the user reported this as
  // "I changed default to Gemini 3.1 Flash but report generation still
  // shows haiku in the terminal". That detour wasted both fidelity to
  // the user's explicit choice AND the chance to keep the whole
  // pipeline on a single model family. When the default is itself
  // small-fast, just use it.
  const prefs = getPrefs();
  const userDefault = prefs.defaultModelV as ModelV | null;
  if (
    userDefault &&
    (UTILITY_PREFERENCE as readonly ModelV[]).includes(userDefault) &&
    reachable.has(userDefault)
  ) {
    return userDefault;
  }

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
