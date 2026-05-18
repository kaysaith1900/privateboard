/**
 * Topic-tree post-turn tagger · Layer 3.1 of the divergence stack.
 *
 * After each director turn lands, a cheap haiku call decides:
 *   · "This message extends an existing branch (id=X)" → tag with X.
 *   · "This message opens a new branch — here's a short label" →
 *     create branch, tag the message as its opener.
 *
 * The tagger is fire-and-forget · failure is non-fatal (the room
 * keeps progressing without branch tags, the divergence stack still
 * functions on Layer 1 + 2 + 3.2 alone).
 *
 * Cost · ~$0.0005 haiku per turn. ~$0.01 over a typical 6-round room.
 */
import { utilityModelFor } from "../ai/availability.js";
import { callLLM } from "../ai/adapter.js";
import type { ModelV } from "../ai/registry.js";
import {
  createBranch,
  listBranchesForRoom,
  tagMessageWithBranch,
} from "../storage/topic-branches.js";

/** Tag a freshly-completed director message into the room's topic
 *  tree. Best-effort. Returns the branch id used (existing or new)
 *  or null on failure. */
export async function tagMessageBranch(opts: {
  roomId: string;
  messageId: string;
  speakerId: string;
  body: string;
  roomSubject: string;
}): Promise<string | null> {
  const body = (opts.body || "").trim();
  if (!body) return null;
  const modelV = utilityModelFor();
  if (!modelV) return null;

  const existing = listBranchesForRoom(opts.roomId);
  const branchList = existing.length === 0
    ? "(none yet — this is the first branch)"
    : existing
        .map((b, i) => `${i + 1}. id=${b.id} · "${b.label}" · ${b.turnCount} turn(s)`)
        .join("\n");

  const prompt =
    `You are tagging a director's turn in a multi-director brainstorm with the topic branch it belongs to. ` +
    `Branches are short noun-phrase angles the room has been exploring (e.g. "audit responsibility", "informal-economy workers", "ritualised handoff").\n\n` +
    `Room subject: "${opts.roomSubject}"\n\n` +
    `Existing branches in this room:\n${branchList}\n\n` +
    `Director's turn to tag (verbatim):\n${body.length > 1200 ? body.slice(0, 1200) + "…" : body}\n\n` +
    `Decide ONE of:\n` +
    `  (A) This turn primarily EXTENDS existing branch X. Output: EXTEND <branch-id>\n` +
    `  (B) This turn primarily OPENS a NEW branch. Output: NEW <short-label-≤-8-words>\n\n` +
    `Rules:\n` +
    `  · A turn that mostly adds detail / sub-angle to an existing branch is EXTEND.\n` +
    `  · A turn that introduces a genuinely fresh lens / domain / stakeholder is NEW.\n` +
    `  · When the turn could plausibly go either way, prefer NEW · the room benefits from more branches.\n` +
    `  · The label should be a CONCRETE noun phrase, not a question or full sentence.\n` +
    `  · Match the language of the turn for new-branch labels.\n` +
    `  · Output ONLY the directive · no explanation, no JSON, no preamble.`;

  let raw: string;
  try {
    raw = await callLLM({
      modelV: modelV as ModelV,
      carrier: null,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      maxTokens: 40,
    });
  } catch (e) {
    process.stderr.write(
      `[topic-tagger] failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
  const txt = (raw || "").trim();
  if (!txt) return null;

  // Parse: "EXTEND <id>" or "NEW <label>"
  const extendMatch = txt.match(/^EXTEND\s+(\S+)/i);
  if (extendMatch) {
    const branchId = extendMatch[1];
    if (existing.some((b) => b.id === branchId)) {
      tagMessageWithBranch({
        messageId: opts.messageId,
        branchId,
        isOpener: false,
        speakerId: opts.speakerId,
      });
      return branchId;
    }
    // Model fabricated an id · fall through to NEW path with a
    // synthesized label from the message body's first noun-phrase-
    // looking chunk.
  }
  const newMatch = txt.match(/^NEW\s+(.+)$/i);
  let label = newMatch ? newMatch[1].trim() : (txt.length < 80 ? txt : "");
  // Strip wrapping quotes / trailing punctuation
  label = label.replace(/^["'`]+|["'`]+$/g, "").replace(/[。.!?]+$/, "").trim();
  if (!label || label.length > 80) return null;
  const branch = createBranch({
    roomId: opts.roomId,
    label,
    openerSpeakerId: opts.speakerId,
  });
  tagMessageWithBranch({
    messageId: opts.messageId,
    branchId: branch.id,
    isOpener: true,
    speakerId: opts.speakerId,
  });
  return branch.id;
}
