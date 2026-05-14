/**
 * Quality-Diversity scorer · Layer 4 of the divergence stack.
 *
 * Post-turn: ask a cheap haiku to rate the message on three
 * behavioral dimensions [0, 1]. Result feeds the MAP-Elites
 * archive in `storage/qd-archive.ts`.
 *
 * Fire-and-forget · cost ~$0.0005 per turn. Failure logs but
 * doesn't block the room.
 */
import { utilityModelFor } from "../ai/availability.js";
import { callLLM } from "../ai/adapter.js";
import type { ModelV } from "../ai/registry.js";
import { upsertQDScore, type QDScore } from "../storage/qd-archive.js";

function parseScore(line: string): number | null {
  const m = line.match(/(\d+\.\d+|\d+)/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (n > 1.0 && n <= 10) n = n / 10;  // model wrote 0-10 scale
  if (n > 1.0 && n <= 100) n = n / 100; // model wrote percent
  return Math.max(0, Math.min(1, n));
}

/** Score a director message on three behavioral dimensions and
 *  persist the result. Best-effort. */
export async function scoreAndArchive(opts: {
  roomId: string;
  messageId: string;
  body: string;
}): Promise<QDScore | null> {
  const body = (opts.body || "").trim();
  if (body.length < 40) return null;
  const modelV = utilityModelFor();
  if (!modelV) return null;

  const prompt =
    `Rate the director turn below on THREE behavioral dimensions. Each rating is a single floating-point number 0.00-1.00.\n\n` +
    `Dimension A · Abstraction level\n` +
    `  · 0.00 = concrete example (specific named user, specific product, specific scenario)\n` +
    `  · 0.33 = case / use-case (representative pattern, named domain)\n` +
    `  · 0.66 = mechanism / structural argument (how-it-works, conditions)\n` +
    `  · 1.00 = abstract principle (timeless / cross-domain / first-principles)\n\n` +
    `Dimension B · Time scale\n` +
    `  · 0.00 = this quarter / immediate (months)\n` +
    `  · 0.33 = product cycle (1-3 years)\n` +
    `  · 0.66 = strategic / generational (5-20 years)\n` +
    `  · 1.00 = civilizational / long-horizon (50+ years, structural)\n\n` +
    `Dimension C · Stakeholder scope\n` +
    `  · 0.00 = individual user / single role\n` +
    `  · 0.33 = team / org\n` +
    `  · 0.66 = industry / market\n` +
    `  · 1.00 = society / civilization\n\n` +
    `OUTPUT · exactly three lines, one float per line, in order A B C. No labels, no JSON, no commentary.\n\n` +
    `Turn:\n${body.length > 1200 ? body.slice(0, 1200) + "…" : body}\n\n` +
    `Three scores (one per line, A then B then C):`;

  let raw: string;
  try {
    raw = await callLLM({
      modelV: modelV as ModelV,
      carrier: null,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0,
      maxTokens: 30,
    });
  } catch (e) {
    process.stderr.write(
      `[qd-scorer] LLM call failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
  const lines = (raw || "").split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return null;
  const a = parseScore(lines[0]);
  const t = parseScore(lines[1]);
  const s = parseScore(lines[2]);
  if (a === null || t === null || s === null) return null;
  const scores: QDScore = { abstractionScore: a, timeScore: t, stakeholderScore: s };
  try {
    upsertQDScore({ messageId: opts.messageId, roomId: opts.roomId, scores });
  } catch (e) {
    process.stderr.write(
      `[qd-scorer] persist failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
  return scores;
}
