/**
 * Frame-break extraction · Layer 1.4 of the divergence stack.
 *
 * Multi-director boardroom rooms converge fast — by round 3-4 the
 * transcript is densely populated with one or two terms (e.g. "audit
 * responsibility", "accountability") and transformer attention reads
 * those terms as the room's gravitational center. Each subsequent
 * director's prompt sees the convergence and contributes a sub-angle
 * inside it, deepening rather than diverging.
 *
 * Counter · before each director's turn (reactive rounds only), call
 * a cheap utility-tier LLM to identify the 3-5 noun phrases that are
 * functioning as the recurring fixation. Those terms get injected into
 * the director's system prompt as "FRAME-BREAK GUIDANCE · do NOT
 * extend these; counter-example or assumption-poke only". Combined
 * with the Layer 1.2 persona-lens-reminder at prompt tail, this gives
 * the model an explicit anti-anchor signal at peak attention weight.
 *
 * Cost · ~80-token completion at haiku tier, ~$0.001 per turn. On a
 * typical 6-round room with 3 directors each = 18 turns, frame-break
 * adds ~$0.02 to the room. Negligible.
 *
 * Returns an empty array on:
 *   · history too short (< 4 director turns)
 *   · no utility model reachable
 *   · LLM call fails / returns NONE
 *   · upstream caller passed an empty / undefined message list
 *
 * Empty-array callers see the block omitted entirely, so failure is
 * a clean no-op (no broken system prompts).
 */
import { utilityModelFor } from "../ai/availability.js";
import { callLLM } from "../ai/adapter.js";
import type { ModelV } from "../ai/registry.js";
import type { Message } from "../storage/messages.js";

/** Render messages as a compact transcript the convergence checker
 *  can scan. Caps body length per message so a single bloated turn
 *  doesn't dominate the input. */
function renderForExtraction(messages: Message[], maxBodyChars = 360): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.authorKind !== "agent") continue;
    const meta = (m.meta || {}) as { kind?: string };
    if (meta.kind === "round-open" || meta.kind === "settings" || meta.kind === "round-prompt") continue;
    const body = (m.body || "").trim();
    if (!body) continue;
    lines.push(body.length > maxBodyChars ? body.slice(0, maxBodyChars) + "…" : body);
  }
  return lines.join("\n---\n");
}

/**
 * Identify recurring fixation terms in the last several director
 * turns. Returns an empty array when the conversation is genuinely
 * diverse OR the upstream call fails.
 *
 * Caller is expected to skip invocation for opening rounds (where
 * directors are blind to each other) and short rooms (< 4 director
 * turns). This function is defensive about both cases anyway.
 */
export async function extractDominantTerms(opts: {
  messages: Message[];
  windowSize?: number;
}): Promise<string[]> {
  const window = opts.windowSize ?? 15;
  const recent = (opts.messages || []).slice(-window);
  const directorTurns = recent.filter(
    (m) => m.authorKind === "agent" &&
      !((m.meta as { kind?: string } | undefined)?.kind),
  );
  if (directorTurns.length < 4) return [];

  const modelV = utilityModelFor();
  if (!modelV) return [];

  const transcript = renderForExtraction(directorTurns);
  if (!transcript.trim()) return [];

  const prompt =
    `You are inspecting a multi-director brainstorm for SIGNS OF CONVERGENCE. ` +
    `Read the recent director turns below and identify the noun phrases / concepts that have become the room's recurring fixation — terms mentioned by multiple directors across multiple turns that are now functioning as the room's gravitational center.\n\n` +
    `RULES\n` +
    `  · Return ONLY a comma-separated list (no preamble, no JSON, no explanation).\n` +
    `  · 3-5 terms maximum. Each term ≤ 4 words.\n` +
    `  · Prefer the highest-content noun phrases (e.g. "audit responsibility", "compliance burden") over generic words ("AI", "tool", "user").\n` +
    `  · If the conversation is genuinely diverse and no single fixation has emerged, return the literal token NONE (no list).\n` +
    `  · Match the language of the transcript (Chinese in, Chinese terms out).\n\n` +
    `Recent director turns:\n${transcript}\n\n` +
    `Recurring fixation terms (comma-separated, or NONE):`;

  let body: string;
  try {
    body = await callLLM({
      modelV: modelV as ModelV,
      carrier: null,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      maxTokens: 80,
    });
  } catch (e) {
    process.stderr.write(
      `[frame-break] extract failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return [];
  }
  const txt = (body || "").trim();
  if (!txt) return [];
  if (/^none\b/i.test(txt) || /^无$/.test(txt)) return [];
  // Split on comma (English/Chinese variants) and normalize.
  const raw = txt.split(/[,，、]/);
  const out: string[] = [];
  for (const r of raw) {
    const trimmed = r.trim().replace(/^["'"'"']+|["'"'"'.。]+$/g, "");
    if (!trimmed) continue;
    if (trimmed.length > 60) continue;          // a malformed run-on
    if (/[\n:：]/.test(trimmed)) continue;       // model leaked a structure header
    out.push(trimmed);
    if (out.length >= 5) break;
  }
  return out;
}
