/**
 * Negative-space extraction · Layer 3.2 of the divergence stack.
 *
 * At round-end, generate 1-3 short angle descriptions for "what this
 * round notably did NOT touch". These get persisted to the
 * `negative_space` table and injected into NEXT round's director
 * prompts as "UNEXPLORED ANGLES".
 *
 * Companion to the frame-break extractor (`frame-break.ts`):
 *   · frame-break · "what the room is over-investing in" (negative · don't go)
 *   · negative-space · "what the room hasn't gone to" (positive · consider going)
 *
 * Cost · ~$0.001 haiku call per round (NOT per turn). Cheap.
 *
 * Returns an empty array on:
 *   · no utility model reachable
 *   · LLM call fails
 *   · model returned NONE / empty
 *
 * The caller (chair.ts round-end) persists the result via
 * `insertNegativeSpaceAngles` and proceeds with key-point extraction
 * regardless of whether negative-space extraction succeeded.
 */
import { utilityModelFor } from "../ai/availability.js";
import { callLLM } from "../ai/adapter.js";
import type { ModelV } from "../ai/registry.js";
import type { Message } from "../storage/messages.js";

function renderTranscriptForRound(roundMessages: Message[]): string {
  const lines: string[] = [];
  for (const m of roundMessages) {
    if (m.authorKind !== "agent") continue;
    const kind = (m.meta as { kind?: string } | undefined)?.kind;
    if (kind && (kind === "round-open" || kind === "settings" || kind === "round-prompt")) continue;
    const body = (m.body || "").trim();
    if (!body) continue;
    lines.push(body.length > 500 ? body.slice(0, 500) + "…" : body);
  }
  return lines.join("\n---\n");
}

/**
 * Extract unexplored angles from this round's transcript. Returns up
 * to 3 short angle descriptions. Each angle is a NOUN-PHRASE-LIKE
 * one-line suggestion the model thinks the round should have touched
 * but didn't.
 */
export async function extractNegativeSpace(opts: {
  /** Just the messages from the round that just ended. Caller is
   *  expected to filter to a single round. */
  roundMessages: Message[];
  /** The room subject · gives the extractor a sense of "what the
   *  room is supposed to be about" so unexplored-angle suggestions
   *  stay topically relevant. */
  roomSubject: string;
}): Promise<string[]> {
  const turns = (opts.roundMessages || []).filter(
    (m) => m.authorKind === "agent" &&
      !((m.meta as { kind?: string } | undefined)?.kind),
  );
  if (turns.length < 2) return [];

  const transcript = renderTranscriptForRound(turns);
  if (!transcript) return [];

  const modelV = utilityModelFor();
  if (!modelV) return [];

  const prompt =
    `You are protecting the divergence of a multi-director brainstorm. ` +
    `The room's subject is: "${opts.roomSubject}". A round of director turns just ended. ` +
    `Read those turns below and identify 1-3 ANGLES the round did NOT touch but plausibly SHOULD have, given the room's subject. ` +
    `An "angle" is a short noun phrase ≤ 8 words — a stakeholder type, a time horizon, a domain analogy, a technical layer, a cultural / regulatory context, a material constraint, a hidden user, a counter-population.\n\n` +
    `RULES\n` +
    `  · Each angle is a NEW direction the room could explore next, not a critique of what was said.\n` +
    `  · Each angle is a CONCRETE noun phrase, not a question. ("informal-economy workers" yes; "what about workers?" no.)\n` +
    `  · Each angle is genuinely fresh — NOT a paraphrase of what the round already discussed.\n` +
    `  · Match the language of the transcript.\n` +
    `  · Return ONLY a newline-separated list (max 3 lines). No bullets, no numbering, no preamble.\n` +
    `  · If the round was already genuinely diverse and no obvious angle is missing, return the literal token NONE.\n\n` +
    `Round transcript:\n${transcript}\n\n` +
    `Unexplored angles (newline-separated, or NONE):`;

  let body: string;
  try {
    body = await callLLM({
      modelV: modelV as ModelV,
      carrier: null,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      maxTokens: 120,
    });
  } catch (e) {
    process.stderr.write(
      `[negative-space] extract failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return [];
  }
  const txt = (body || "").trim();
  if (!txt) return [];
  if (/^none\b/i.test(txt) || /^无$/.test(txt)) return [];
  const lines = txt
    .split(/\n/)
    .map((l) => l.trim().replace(/^[-·•*\d.)\s]+/, "").replace(/[。.]+$/, ""))
    .filter((l) => l.length > 0 && l.length < 200);
  return lines.slice(0, 3);
}
