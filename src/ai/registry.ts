/**
 * Model registry · single source of truth for everything model-related.
 *
 *   modelV          — our internal stable id ('sonnet-4-6')
 *   provider        — direct API provider
 *   directApiId     — the model name as the provider's own SDK expects it
 *   openrouterId    — the same model addressed via openrouter
 *   baiId           — the same model addressed via B.AI aggregator
 *                     (https://api.b.ai/v1, OpenAI-compatible)
 *   contextBudget   — how many tokens of input we'll give it before trimming
 */

export type Provider =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "deepseek"
  // Zhipu AI · GLM family. Reached via OpenRouter (`z-ai/…`) or B.AI ·
  // no @ai-sdk client in this codebase so all GLM models carry
  // viaUniversalOnly: true.
  | "zhipu"
  // Moonshot AI · Kimi family. Reached via OpenRouter (`moonshotai/…`)
  // or B.AI · no @ai-sdk client so all Kimi models carry
  // viaUniversalOnly: true.
  | "moonshot";

export type ModelV =
  | "sonnet-4-6"
  | "opus-4-6"
  | "opus-4-7"
  | "opus-4-6-fast"
  | "haiku-4-5"
  | "gpt-5-4"
  | "gpt-5-4-mini"
  | "gpt-5-5"
  | "gpt-5-5-pro"
  | "codex-5-4"
  | "gemini-3-1"
  | "gemini-3-flash"
  | "gemini-3-1-flash"
  | "grok-4-3"
  | "grok-4-1-fast"
  | "grok-4-20"
  | "deepseek-v4-pro"
  | "deepseek-v4-flash"
  | "glm-5-1"
  | "kimi-2-6";

export interface ModelMeta {
  v: ModelV;
  provider: Provider;
  /** id used when calling the direct provider's SDK */
  directApiId: string;
  /** id used when routing through openrouter */
  openrouterId: string;
  /** id used when routing through B.AI · OpenAI-compatible aggregator
   *  at https://api.b.ai/v1. When undefined, this model is not on
   *  B.AI's catalog and the carrier resolver skips B.AI for it. The
   *  ids mirror B.AI's documented URL slugs (hyphenated form, e.g.
   *  `claude-sonnet-4-6`, `gpt-5-4-mini`); if the actual API rejects
   *  the value, B.AI usually echoes the correct form in the error so
   *  the user can paste it back here. */
  baiId?: string;
  /** human-readable label for UI */
  displayName: string;
  /** soft input cap; trimming kicks in above this */
  contextBudget: number;
  /** rough hint shown next to the model in the picker */
  deck: string;
  /** When true, the model can ONLY be reached via a universal carrier
   *  (OpenRouter or B.AI) · the direct-provider SDK path is skipped.
   *  Used for two cases:
   *    1. Provider has no @ai-sdk client in this codebase (DeepSeek,
   *       Zhipu/GLM, Moonshot/Kimi).
   *    2. Model is a preview / variant the provider's own SDK doesn't
   *       acknowledge yet (e.g. OpenAI codex preview, Grok 4.20).
   *  Reachability still works as long as the model has `openrouterId`
   *  or `baiId` set and the user has the matching universal carrier
   *  key configured · the flag is purely about *disabling the direct
   *  path*, not "OpenRouter exclusively". */
  viaUniversalOnly?: boolean;
}

export const MODELS: Record<ModelV, ModelMeta> = {
  // ── Anthropic · Opus 4.6 / 4.7, Sonnet 4.6, Haiku 4.5 direct-routable ──
  // Per Anthropic + OpenRouter catalog (`anthropic/claude-opus-4.6` etc.).
  // Users with an Anthropic direct key reach these without OpenRouter.
  "sonnet-4-6": {
    v: "sonnet-4-6",
    provider: "anthropic",
    directApiId: "claude-sonnet-4-6",
    openrouterId: "anthropic/claude-sonnet-4.6",
    baiId: "claude-sonnet-4.6",
    displayName: "Sonnet 4.6",
    contextBudget: 200_000,
    deck: "balanced · default",
  },
  "opus-4-6": {
    v: "opus-4-6",
    provider: "anthropic",
    directApiId: "claude-opus-4-6",
    openrouterId: "anthropic/claude-opus-4.6",
    baiId: "claude-opus-4.6",
    displayName: "Opus 4.6",
    contextBudget: 1_000_000,
    deck: "deep reasoning · 1M ctx",
  },
  "opus-4-7": {
    v: "opus-4-7",
    provider: "anthropic",
    directApiId: "claude-opus-4-7",
    openrouterId: "anthropic/claude-opus-4.7",
    baiId: "claude-opus-4.7",
    displayName: "Opus 4.7",
    contextBudget: 200_000,
    deck: "deep reasoning",
  },
  "opus-4-6-fast": {
    v: "opus-4-6-fast",
    provider: "anthropic",
    directApiId: "claude-opus-4-6-fast",
    openrouterId: "anthropic/claude-opus-4.6-fast",
    // No baiId · B.AI's catalog doesn't carry Anthropic's "fast"
    // variants (only the base models). Routing this through B.AI 503s
    // with "no available channel". Direct Anthropic key or OR carries it.
    displayName: "Opus 4.6 Fast",
    contextBudget: 200_000,
    deck: "faster 4.6 · same intelligence",
  },
  "haiku-4-5": {
    v: "haiku-4-5",
    provider: "anthropic",
    // Dated alias — Anthropic's Haiku 4.5 ships under the dated id;
    // the unsuffixed `claude-haiku-4-5` 404s on the direct API.
    directApiId: "claude-haiku-4-5-20251001",
    openrouterId: "anthropic/claude-haiku-4.5",
    baiId: "claude-haiku-4.5",
    displayName: "Haiku 4.5",
    contextBudget: 200_000,
    deck: "fast · low-cost",
  },
  // ── OpenAI · current frontier (5.5 / 5.4 / 5.4-mini direct) ──
  // Replaced the legacy gpt-5 / gpt-5-mini / gpt-4o entries — all three
  // are direct-routable on the OpenAI Responses API. See
  // https://developers.openai.com/api/docs/models for the canonical
  // ID strings (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`).
  "gpt-5-5": {
    v: "gpt-5-5",
    provider: "openai",
    directApiId: "gpt-5.5",
    openrouterId: "openai/gpt-5.5",
    baiId: "gpt-5.5",
    displayName: "GPT-5.5",
    contextBudget: 1_000_000,
    deck: "flagship · 1M ctx",
  },
  "gpt-5-4": {
    v: "gpt-5-4",
    provider: "openai",
    directApiId: "gpt-5.4",
    openrouterId: "openai/gpt-5.4",
    baiId: "gpt-5.4",
    displayName: "GPT-5.4",
    contextBudget: 1_000_000,
    deck: "general · 1M ctx",
  },
  "gpt-5-4-mini": {
    v: "gpt-5-4-mini",
    provider: "openai",
    directApiId: "gpt-5.4-mini",
    openrouterId: "openai/gpt-5.4-mini",
    // No baiId · B.AI's catalog reports "No available channel for
    // model gpt-5-4-mini" on the OneAPI distributor — the mini
    // variant isn't routed there. The full `gpt-5-4` IS available on
    // B.AI; pick that or use direct / OR for the mini tier.
    displayName: "GPT-5.4 Mini",
    contextBudget: 400_000,
    deck: "fast · 400k ctx",
  },
  // ── OpenAI · OR-only previews (Pro / Codex) ──
  "gpt-5-5-pro": {
    v: "gpt-5-5-pro",
    provider: "openai",
    directApiId: "gpt-5.5-pro",
    openrouterId: "openai/gpt-5.5-pro",
    baiId: "gpt-5.5-pro",
    displayName: "GPT-5.5 Pro",
    contextBudget: 1_000_000,
    deck: "deep reasoning · 1M ctx",
    viaUniversalOnly: true,
  },
  "codex-5-4": {
    v: "codex-5-4",
    provider: "openai",
    directApiId: "gpt-5.3-codex",
    openrouterId: "openai/gpt-5.3-codex",
    // No baiId · B.AI's catalog doesn't list a codex variant; the
    // preview only ships via OR. Routing it through B.AI 503s.
    displayName: "ChatGPT Codex 5.4",
    contextBudget: 400_000,
    deck: "code · agents",
    viaUniversalOnly: true,
  },
  // ── Google · current frontier (3.1 Pro / 3 Flash / 3.1 Flash Lite) ──
  // Replaced the legacy gemini-2.5-pro / gemini-2.5-flash entries — all
  // three new IDs are direct-routable on Google's Gemini API. The IDs
  // carry the `-preview` suffix Google uses for not-yet-GA models;
  // confirmed against OpenRouter's catalog (see /v1/models for matches).
  "gemini-3-1": {
    v: "gemini-3-1",
    provider: "google",
    directApiId: "gemini-3.1-pro-preview",
    openrouterId: "google/gemini-3.1-pro-preview",
    baiId: "gemini-3.1-pro",
    displayName: "Gemini 3.1 Pro",
    contextBudget: 1_000_000,
    deck: "flagship · 1M ctx",
  },
  "gemini-3-flash": {
    v: "gemini-3-flash",
    provider: "google",
    directApiId: "gemini-3-flash-preview",
    openrouterId: "google/gemini-3-flash-preview",
    baiId: "gemini-3-flash",
    displayName: "Gemini 3 Flash",
    contextBudget: 1_000_000,
    deck: "frontier flash · 1M ctx",
  },
  "gemini-3-1-flash": {
    v: "gemini-3-1-flash",
    provider: "google",
    directApiId: "gemini-3.1-flash-lite-preview",
    openrouterId: "google/gemini-3.1-flash-lite-preview",
    // No baiId · B.AI's catalog only has `gemini-3-1-pro` and
    // `gemini-3-flash` for the Gemini family — no 3.1 Flash Lite
    // channel. Earlier mapping to `gemini-3-1-flash` 503'd with
    // "no available channel for model gemini-3-1-flash". Direct
    // Google key or OR carries this preview model.
    displayName: "Gemini 3.1 Flash Lite",
    contextBudget: 1_000_000,
    deck: "fast · 1M ctx",
  },
  // ── xAI · current frontier (4.3 / 4.1 Fast direct + 4.20 big-ctx OR) ──
  // Replaced the legacy grok-4 / grok-4-mini entries — 4.3 is xAI's
  // current "most intelligent and fastest" model per their docs; 4.1
  // Fast is the new cheap tier. 4.20 stays OR-only since it's a 2M-ctx
  // preview that the direct SDK hasn't acknowledged yet.
  "grok-4-3": {
    v: "grok-4-3",
    provider: "xai",
    directApiId: "grok-4.3",
    openrouterId: "x-ai/grok-4.3",
    baiId: "grok-4.3",
    displayName: "Grok 4.3",
    contextBudget: 1_000_000,
    deck: "flagship · 1M ctx",
  },
  "grok-4-1-fast": {
    v: "grok-4-1-fast",
    provider: "xai",
    directApiId: "grok-4.1-fast",
    openrouterId: "x-ai/grok-4.1-fast",
    baiId: "grok-4.1-fast",
    displayName: "Grok 4.1 Fast",
    contextBudget: 256_000,
    deck: "fast · 256k ctx",
  },
  "grok-4-20": {
    v: "grok-4-20",
    provider: "xai",
    directApiId: "grok-4.20",
    openrouterId: "x-ai/grok-4.20",
    baiId: "grok-4.20",
    displayName: "Grok 4.20",
    contextBudget: 2_000_000,
    deck: "2M ctx · big context",
    viaUniversalOnly: true,
  },
  // ── DeepSeek (OR-only · no @ai-sdk/deepseek shipped) ──
  "deepseek-v4-pro": {
    v: "deepseek-v4-pro",
    provider: "deepseek",
    directApiId: "deepseek-v4-pro",
    openrouterId: "deepseek/deepseek-v4-pro",
    baiId: "deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    contextBudget: 128_000,
    deck: "reasoning · open weights",
    viaUniversalOnly: true,
  },
  // OpenRouter catalog id · deepseek/deepseek-v4-flash ("V4 Flash" — lite tier).
  "deepseek-v4-flash": {
    v: "deepseek-v4-flash",
    provider: "deepseek",
    directApiId: "deepseek-v4-flash",
    openrouterId: "deepseek/deepseek-v4-flash",
    baiId: "deepseek-v4-flash",
    displayName: "DeepSeek Lite",
    contextBudget: 1_000_000,
    deck: "V4 Flash · fast · 1M ctx",
    viaUniversalOnly: true,
  },
  // ── Zhipu (Z.AI) · GLM family · OR + B.AI only ──
  // OpenRouter catalog convention: `z-ai/glm-X.Y`. B.AI uses
  // hyphenated lowercase: `glm-5-1`. No direct @ai-sdk client ·
  // viaUniversalOnly skips the direct path.
  "glm-5-1": {
    v: "glm-5-1",
    provider: "zhipu",
    directApiId: "glm-5.1",
    openrouterId: "z-ai/glm-5.1",
    baiId: "glm-5.1",
    displayName: "GLM 5.1",
    contextBudget: 200_000,
    deck: "Zhipu flagship · 200k ctx",
    viaUniversalOnly: true,
  },
  // ── Moonshot · Kimi family · OR + B.AI only ──
  // OpenRouter catalog convention: `moonshotai/kimi-…`. B.AI uses
  // hyphenated lowercase: `kimi-2-6`. No direct @ai-sdk client ·
  // viaUniversalOnly skips the direct path.
  "kimi-2-6": {
    v: "kimi-2-6",
    provider: "moonshot",
    directApiId: "kimi-2.6",
    openrouterId: "moonshotai/kimi-2.6",
    baiId: "kimi-2.6",
    displayName: "Kimi 2.6",
    contextBudget: 256_000,
    deck: "Moonshot · long-context",
    viaUniversalOnly: true,
  },
};

export function getModel(v: ModelV): ModelMeta {
  const m = MODELS[v];
  if (!m) throw new Error(`Unknown model: ${v}`);
  return m;
}

export function isModelV(v: string): v is ModelV {
  return Object.hasOwn(MODELS, v);
}

export function listModels(): ModelMeta[] {
  return Object.values(MODELS);
}
