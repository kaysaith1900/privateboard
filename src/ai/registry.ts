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
  | "moonshot"
  // MiniMax · Hailuo / M-series LLMs. Reached via OpenRouter
  // (`minimax/minimax-mX.Y`) or B.AI aggregator (siliconflow /
  // paratera distributors). No direct @ai-sdk client · all MiniMax
  // models carry viaUniversalOnly: true. The `minimax` provider
  // already exists in keys.ts for their voice tier; this reuses the
  // same provider key for LLMs.
  | "minimax";

export type ModelV =
  | "sonnet-4-6"
  | "opus-4-7"
  | "opus-4-6-fast"
  | "haiku-4-5"
  | "gpt-5-4"
  | "gpt-5-4-mini"
  | "gpt-5-5"
  | "codex-5-4"
  | "gemini-3-1"
  | "gemini-3-flash"
  | "gemini-3-1-flash"
  | "deepseek-v4-pro"
  | "deepseek-v4-flash"
  | "glm-5-1"
  | "kimi-k2-6"
  | "minimax-m2-5"
  | "minimax-m2-7";

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
    baiId: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    contextBudget: 400_000,
    deck: "fast · 400k ctx",
  },
  // ── OpenAI · OR-only previews (Codex) ──
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
  // ── xAI · all Grok entries removed (2026-05-17) ──
  // B.AI's catalog lists no Grok models, the user base on B.AI saw
  // every grok-* call 503 with "no available channel". Direct xAI key
  // route and OpenRouter route still exist in the adapter (the `xai`
  // Provider type is retained), but no modelV currently maps to them.
  // Re-add a `grok-*` entry here if/when B.AI begins routing xAI again
  // or if the product re-introduces direct xAI as a first-class path.
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
  // ── Zhipu (Z.AI) · GLM family · direct + OR + B.AI ──
  // Direct route uses Zhipu's OpenAI-compatible chat-completions API
  // at https://open.bigmodel.cn/api/paas/v4/ (see adapter.ts
  // case "zhipu"). OpenRouter catalog convention: `z-ai/glm-X.Y`.
  // B.AI uses dotted lowercase: `glm-5.1`.
  "glm-5-1": {
    v: "glm-5-1",
    provider: "zhipu",
    directApiId: "glm-5.1",
    openrouterId: "z-ai/glm-5.1",
    baiId: "glm-5.1",
    displayName: "GLM 5.1",
    contextBudget: 200_000,
    deck: "Zhipu flagship · 200k ctx",
  },
  // ── Moonshot · Kimi family · direct + OR + B.AI ──
  // Direct route uses Moonshot's OpenAI-compatible chat-completions
  // API at https://api.moonshot.cn/v1 (see adapter.ts case "moonshot").
  // OpenRouter catalog convention: `moonshotai/kimi-k2.6` (the leading
  // `k` is part of the slug — `moonshotai/kimi-2.6` 404s). B.AI's
  // siliconflow distributor still ships the older `kimi-k2.5` channel
  // (per 2026-05-17 catalog snapshot), so the B.AI route serves K2.5
  // until B.AI picks up the newer build.
  "kimi-k2-6": {
    v: "kimi-k2-6",
    provider: "moonshot",
    directApiId: "kimi-k2.6",
    openrouterId: "moonshotai/kimi-k2.6",
    baiId: "kimi-k2.5",
    displayName: "Kimi K2.6",
    contextBudget: 256_000,
    deck: "Moonshot · long-context",
  },
  // ── MiniMax · M-series · OR + B.AI ──
  // No direct @ai-sdk client · viaUniversalOnly skips the direct path.
  // OpenRouter catalog slug: `minimax/minimax-mX.Y`. B.AI uses bare
  // model id: `minimax-mX.Y` (siliconflow / paratera distributors).
  "minimax-m2-7": {
    v: "minimax-m2-7",
    provider: "minimax",
    directApiId: "minimax-m2.7",
    openrouterId: "minimax/minimax-m2.7",
    baiId: "minimax-m2.7",
    displayName: "MiniMax M2.7",
    contextBudget: 245_000,
    deck: "MiniMax flagship · long-context",
    viaUniversalOnly: true,
  },
  "minimax-m2-5": {
    v: "minimax-m2-5",
    provider: "minimax",
    directApiId: "minimax-m2.5",
    openrouterId: "minimax/minimax-m2.5",
    baiId: "minimax-m2.5",
    displayName: "MiniMax M2.5",
    contextBudget: 245_000,
    deck: "MiniMax prior · long-context",
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
