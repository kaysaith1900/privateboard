/**
 * LLM provider taxonomy · single source of truth for the
 * single-active-LLM-provider invariant.
 *
 * The user can have at MOST ONE LLM provider key configured at a time.
 * Providers split into two classifications:
 *
 *   - multi-model-provider (carriers) · one key reaches many model
 *     families. Today: openrouter, bai. Tomorrow: more carriers can
 *     join this list — every caller in the codebase reads from these
 *     consts so adding a third carrier is a one-line change.
 *
 *   - single-model-provider (direct) · one key reaches one model
 *     family. Today: anthropic, openai, google, xai.
 *
 * The `storage/keys.ts` `Provider` union is wider (it includes
 * `zhipu`, `moonshot`, `minimax`, `elevenlabs`, `brave`, `tavily`,
 * `deepseek` for type-compat with the model registry + voice/skill
 * keys). This file is the LLM-only subset — voice keys (minimax,
 * elevenlabs) and skill keys (brave, tavily) live with their own
 * multi-key invariants and are not classified here.
 *
 * The frontend mirrors these arrays in `public/keys-store.js` with a
 * `// MIRROR: src/ai/providers.ts` comment so future provider adds
 * touch exactly two files (this one + that mirror).
 */

export type LlmProvider =
  | "openrouter"
  | "bai"
  | "anthropic"
  | "openai"
  | "google"
  | "xai";

export type LlmClassification = "multi-model" | "single-model";

export const MULTI_MODEL_LLM_PROVIDERS: readonly LlmProvider[] = [
  "openrouter",
  "bai",
] as const;

export const SINGLE_MODEL_LLM_PROVIDERS: readonly LlmProvider[] = [
  "anthropic",
  "openai",
  "google",
  "xai",
] as const;

export const ALL_LLM_PROVIDERS: readonly LlmProvider[] = [
  ...MULTI_MODEL_LLM_PROVIDERS,
  ...SINGLE_MODEL_LLM_PROVIDERS,
] as const;

/** Priority used by migration 041 + post-migration fallback ordering. */
export const LLM_PROVIDER_PRIORITY: readonly LlmProvider[] = [
  "openrouter",
  "bai",
  "anthropic",
  "openai",
  "google",
  "xai",
] as const;

export function isMultiModelProvider(p: string): p is "openrouter" | "bai" {
  return p === "openrouter" || p === "bai";
}

export function isLlmProvider(p: string): p is LlmProvider {
  return (ALL_LLM_PROVIDERS as readonly string[]).indexOf(p) >= 0;
}

export function llmClassification(p: LlmProvider): LlmClassification {
  return isMultiModelProvider(p) ? "multi-model" : "single-model";
}
