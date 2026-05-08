/**
 * Model registry · single source of truth for everything model-related.
 *
 *   modelV          — our internal stable id ('sonnet-4-6')
 *   provider        — direct API provider
 *   directApiId     — the model name as the provider's own SDK expects it
 *   openrouterId    — the same model addressed via openrouter
 *   contextBudget   — how many tokens of input we'll give it before trimming
 */

export type Provider = "anthropic" | "openai" | "google" | "xai" | "deepseek";

export type ModelV =
  | "sonnet-4-6"
  | "opus-4-7"
  | "opus-4-6"
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
  | "deepseek-v4-pro";

export interface ModelMeta {
  v: ModelV;
  provider: Provider;
  /** id used when calling the direct provider's SDK */
  directApiId: string;
  /** id used when routing through openrouter */
  openrouterId: string;
  /** human-readable label for UI */
  displayName: string;
  /** soft input cap; trimming kicks in above this */
  contextBudget: number;
  /** rough hint shown next to the model in the picker */
  deck: string;
  /** When true, skip the direct-provider path and always route via
   *  OpenRouter — for models that aren't shipped on the provider's
   *  own SDK yet (e.g. preview-only releases). */
  openrouterOnly?: boolean;
}

export const MODELS: Record<ModelV, ModelMeta> = {
  // ── Anthropic · all three current-gen models direct-routable ──
  // Per https://platform.claude.com/docs the current line-up is
  // Opus 4.7, Sonnet 4.6, Haiku 4.5 — all available on the direct
  // Anthropic SDK with the IDs below. Dropped the previous
  // `openrouterOnly` flag on Opus + Haiku; users with an Anthropic
  // direct key now reach all three without needing OpenRouter.
  "sonnet-4-6": {
    v: "sonnet-4-6",
    provider: "anthropic",
    directApiId: "claude-sonnet-4-6",
    openrouterId: "anthropic/claude-sonnet-4.6",
    displayName: "Sonnet 4.6",
    contextBudget: 200_000,
    deck: "balanced · default",
  },
  "opus-4-7": {
    v: "opus-4-7",
    provider: "anthropic",
    directApiId: "claude-opus-4-7",
    openrouterId: "anthropic/claude-opus-4.7",
    displayName: "Opus 4.7",
    contextBudget: 200_000,
    deck: "deep reasoning",
  },
  "opus-4-6": {
    v: "opus-4-6",
    provider: "anthropic",
    directApiId: "claude-opus-4-6",
    openrouterId: "anthropic/claude-opus-4.6",
    displayName: "Opus 4.6",
    contextBudget: 200_000,
    deck: "prior-gen flagship",
  },
  "opus-4-6-fast": {
    v: "opus-4-6-fast",
    provider: "anthropic",
    directApiId: "claude-opus-4-6-fast",
    openrouterId: "anthropic/claude-opus-4.6-fast",
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
    displayName: "GPT-5.5",
    contextBudget: 1_000_000,
    deck: "flagship · 1M ctx",
  },
  "gpt-5-4": {
    v: "gpt-5-4",
    provider: "openai",
    directApiId: "gpt-5.4",
    openrouterId: "openai/gpt-5.4",
    displayName: "GPT-5.4",
    contextBudget: 1_000_000,
    deck: "general · 1M ctx",
  },
  "gpt-5-4-mini": {
    v: "gpt-5-4-mini",
    provider: "openai",
    directApiId: "gpt-5.4-mini",
    openrouterId: "openai/gpt-5.4-mini",
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
    displayName: "GPT-5.5 Pro",
    contextBudget: 1_000_000,
    deck: "deep reasoning · 1M ctx",
    openrouterOnly: true,
  },
  "codex-5-4": {
    v: "codex-5-4",
    provider: "openai",
    directApiId: "gpt-5.3-codex",
    openrouterId: "openai/gpt-5.3-codex",
    displayName: "ChatGPT Codex 5.4",
    contextBudget: 400_000,
    deck: "code · agents",
    openrouterOnly: true,
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
    displayName: "Gemini 3.1 Pro",
    contextBudget: 1_000_000,
    deck: "flagship · 1M ctx",
  },
  "gemini-3-flash": {
    v: "gemini-3-flash",
    provider: "google",
    directApiId: "gemini-3-flash-preview",
    openrouterId: "google/gemini-3-flash-preview",
    displayName: "Gemini 3 Flash",
    contextBudget: 1_000_000,
    deck: "frontier flash · 1M ctx",
  },
  "gemini-3-1-flash": {
    v: "gemini-3-1-flash",
    provider: "google",
    directApiId: "gemini-3.1-flash-lite-preview",
    openrouterId: "google/gemini-3.1-flash-lite-preview",
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
    displayName: "Grok 4.3",
    contextBudget: 1_000_000,
    deck: "flagship · 1M ctx",
  },
  "grok-4-1-fast": {
    v: "grok-4-1-fast",
    provider: "xai",
    directApiId: "grok-4.1-fast",
    openrouterId: "x-ai/grok-4.1-fast",
    displayName: "Grok 4.1 Fast",
    contextBudget: 256_000,
    deck: "fast · 256k ctx",
  },
  "grok-4-20": {
    v: "grok-4-20",
    provider: "xai",
    directApiId: "grok-4.20",
    openrouterId: "x-ai/grok-4.20",
    displayName: "Grok 4.20",
    contextBudget: 2_000_000,
    deck: "2M ctx · big context",
    openrouterOnly: true,
  },
  // ── DeepSeek (OR-only · no @ai-sdk/deepseek shipped) ──
  "deepseek-v4-pro": {
    v: "deepseek-v4-pro",
    provider: "deepseek",
    directApiId: "deepseek-v4-pro",
    openrouterId: "deepseek/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    contextBudget: 128_000,
    deck: "reasoning · open weights",
    openrouterOnly: true,
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
