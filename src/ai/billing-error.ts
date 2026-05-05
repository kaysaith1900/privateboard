/**
 * Detect billing / quota / credit-exhaustion errors across providers.
 *
 * Each provider phrases this slightly differently in their error body —
 * we pattern-match on the substrings that don't change over time:
 *
 *   OpenAI    · "insufficient_quota" / "exceeded your current quota"
 *   Anthropic · "credit balance is too low" / "billing"
 *   Google    · "quota exceeded" / "billing"
 *   xAI       · "insufficient credits" / "billing"
 *   OpenRouter· passes the underlying provider's message through; usually
 *               also surfaces "insufficient credits" in its own envelope
 *
 * Used by the orchestrator to swap a failed director turn for a chair-
 * authored explainer, so the user sees a human-readable notice instead
 * of the silent placeholder-deletion that used to happen.
 */

const BILLING_NEEDLES = [
  "insufficient_quota",
  "insufficient quota",
  "exceeded your current quota",
  "exceeded your quota",
  "credit balance is too low",
  "credit balance",
  "insufficient credits",
  "insufficient credit",
  "quota exceeded",
  "billing",
  "payment required",
  "402",
  // xAI · "Your newly created team doesn't have any credits or
  // licenses yet." Plus close variants observed across providers when
  // the account is provisioned but funded for $0.
  "any credits",
  "any credit",
  "no credits",
  "no credit ",         // trailing space avoids matching "no credit_card" etc.
  "out of credit",
  "credits or licenses",
  "no licenses",
  "any licenses",
];

/** True when the error message looks like a quota / credit issue. We
 *  match on lowercased message; that's enough to cover every provider's
 *  phrasing without overfitting to specific status codes. */
export function isBillingError(message: string | null | undefined): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return BILLING_NEEDLES.some((needle) => m.includes(needle));
}

/** Best-effort provider-name extraction so the chair message can name
 *  the carrier the user needs to top up ("OpenAI"/"Anthropic"/…). The
 *  hint comes from message content — provider error bodies typically
 *  mention themselves, and our adapter prefixes "[adapter] direct:openai"
 *  type strings into the surrounding logs which sometimes leak through.
 *  Returns null when we can't tell — caller should phrase generically. */
export function extractProviderHint(message: string | null | undefined): string | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes("openrouter")) return "OpenRouter";
  if (m.includes("openai") || m.includes("gpt-") || m.includes("insufficient_quota")) return "OpenAI";
  if (m.includes("anthropic") || m.includes("claude")) return "Anthropic";
  if (m.includes("google") || m.includes("gemini")) return "Google";
  if (m.includes("xai") || m.includes("grok")) return "xAI";
  return null;
}
