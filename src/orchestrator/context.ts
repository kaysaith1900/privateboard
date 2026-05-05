/**
 * Build the layered history context handed to a director's LLM call.
 *
 * The default `listRecentMessages(roomId, 30)` blew up on long rooms:
 * the bottom of the window ate user pivots and the top still hit
 * context-rot. This assembler replaces it with a 3-tier model:
 *
 *   ANCHORS  · room.subject + chair convening + every user message,
 *              all verbatim regardless of age (load-bearing, cheap)
 *   L2       · single rolling narrative covering rounds older than
 *              L1_BACK
 *   L1       · per-round narratives covering the L1 window
 *   L0       · last L0_KEEP rounds, raw messages
 *
 * Returns `{ historyMessages, summaryPreamble }`. Callers feed
 * historyMessages to buildDirectorMessages as the chat record (drops
 * straight in where listRecentMessages was), and inject summaryPreamble
 * as a system block before the chat record.
 */
import { listMessages, type Message } from "../storage/messages.js";
import { getRoom } from "../storage/rooms.js";
import {
  getL2Summary,
  listL1Summaries,
} from "../storage/summaries.js";
import { L0_KEEP, L1_BACK } from "./summarize.js";

export interface DirectorContext {
  /** Messages to feed buildDirectorMessages as `history`. Combines
   *  anchors (foundational messages of any age) + L0 raw messages
   *  (the last L0_KEEP rounds). Chronologically ordered. */
  historyMessages: Message[];
  /** Pre-built narrative text to inject as a system block. Empty
   *  string when the room is too young for any summarisation. */
  summaryPreamble: string;
  /** Diagnostic · which round the room is currently at. */
  currentRound: number;
}

export function buildDirectorContext(roomId: string): DirectorContext {
  const room = getRoom(roomId);
  const allMessages = listMessages(roomId);
  if (allMessages.length === 0) {
    return { historyMessages: [], summaryPreamble: "", currentRound: 0 };
  }

  const currentRound = Math.max(...allMessages.map((m) => m.roundNum ?? 0), 0);
  const l0Cutoff = Math.max(1, currentRound - L0_KEEP + 1);

  // ── Anchor selection ────────────────────────────────────────
  // Always-keep set, regardless of round age:
  //   · every user message (drives the conversation)
  //   · chair convening (cast intro · meta.kind === "convening")
  // We DON'T re-include these as anchors when they already sit inside
  // the L0 window — they're already in the raw messages slice.
  const anchorIds = new Set<string>();
  for (const m of allMessages) {
    const round = m.roundNum ?? 0;
    if (round >= l0Cutoff) continue; // already in L0
    if (m.authorKind === "user") {
      anchorIds.add(m.id);
      continue;
    }
    if (m.authorKind === "agent") {
      const meta = (m.meta || {}) as { kind?: string };
      if (meta.kind === "convening") anchorIds.add(m.id);
    }
  }

  const anchors = allMessages.filter((m) => anchorIds.has(m.id));
  const l0 = allMessages.filter((m) => (m.roundNum ?? 0) >= l0Cutoff);
  const historyMessages = [...anchors, ...l0].sort((a, b) => a.createdAt - b.createdAt);

  // ── Summary preamble ────────────────────────────────────────
  const summaryPreamble = buildSummaryPreamble(roomId, room?.subject ?? "", currentRound, l0Cutoff);

  return { historyMessages, summaryPreamble, currentRound };
}

function buildSummaryPreamble(
  roomId: string,
  subject: string,
  currentRound: number,
  l0Cutoff: number,
): string {
  const sections: string[] = [];

  if (subject.trim()) {
    sections.push(`// ROOM SUBJECT (anchor · the original question)\n${subject.trim()}`);
  }

  // L2 covers everything older than the L1 window. Show it first
  // (oldest → newest reading order matches how the rest of the
  // history reads top-down).
  const l2 = getL2Summary(roomId);
  if (l2 && l2.body.trim()) {
    sections.push(
      `// EARLIER IN THIS ROOM · rounds ${l2.startRound}-${l2.endRound} (consolidated)\n${l2.body.trim()}`,
    );
  }

  // L1 entries · rounds in [l0Cutoff - L1_BACK + L0_KEEP, l0Cutoff - 1].
  // Just take whatever L1 rows exist that are older than L0; the
  // L2-folding step in summarize.ts has already removed any L1 row
  // that's been absorbed into L2.
  const l1Rows = listL1Summaries(roomId).filter((row) => (row.roundNum ?? 0) < l0Cutoff);
  if (l1Rows.length > 0) {
    const lines = l1Rows.map((row) => `· round ${row.roundNum}: ${row.body.trim()}`);
    sections.push(`// RECENT ROUNDS · per-round summaries\n${lines.join("\n")}`);
  }

  if (sections.length === 0) return "";

  // Wrap with a kicker so the director knows this section is
  // distillation, not live record.
  return [
    "",
    "═══ context · earlier in this room ═══",
    sections.join("\n\n"),
    "═══ end context · live transcript follows ═══",
    "",
  ].join("\n");
}
