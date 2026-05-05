/**
 * Brief writer prompt — turns a room's transcript into a structured deliverable.
 *
 * V1 supports one style: 'mckinsey' (situation / findings / implication).
 * Other styles will plug in here without touching the orchestrator.
 */
import type { LLMMessage } from "../adapter.js";
import type { Agent } from "../../storage/agents.js";
import type { Message } from "../../storage/messages.js";
import type { Room } from "../../storage/rooms.js";

export type BriefStyle = "mckinsey";

interface BuildOpts {
  room: Room;
  members: Agent[];
  transcript: Message[];
  style: BriefStyle;
  /** Output language. Optional for backwards compat with existing
   *  callers / tests; defaults to English. The structured pipeline
   *  always passes this through. */
  language?: "zh" | "en";
}

const SYSTEM_MCKINSEY = [
  "You are the boardroom's brief writer. Your single output is the filed brief: a structured synthesis of what was said, what holds up, and what the user should do.",
  "",
  "FORMAT: McKinsey-style three-section frame, in markdown.",
  "",
  "## Required structure",
  "",
  "Start with a single H2 title (5-12 words) capturing the load-bearing claim, not the question.",
  "Then exactly three sections with these H2 headings, in order:",
  "",
  "  ## Situation",
  "  One paragraph (3-5 sentences) framing the problem as it stood when the room opened. Plain language, no jargon.",
  "",
  "  ## Findings",
  "  Three to five bullets. Each starts with a **bold claim** (one short sentence), then 1-2 sentences of why. Bullets must be the actual disagreements / decisions reached, not summaries of what each director said.",
  "",
  "  ## Implication",
  "  One paragraph (3-5 sentences) stating what the user should do, in order. End with the falsifiable test — the observable that would prove the brief right or wrong over time.",
  "",
  "## Voice rules",
  "",
  "· Plain prose. No flattery. No 'the room concluded that...' hedging.",
  "· Use *italics* for the load-bearing word in a claim.",
  "· Use **bold** for the claim itself in each Findings bullet.",
  "· Quote a director only when their exact phrase is the cleanest expression of the point — at most twice in the whole brief.",
  "· Never include 'I' or 'we' as the writer. The brief is the room speaking, not the writer.",
  "· No preamble, no closing remarks, no 'in summary'. Just the brief.",
  "",
  "## What to leave out",
  "",
  "· Side threads that didn't bear weight.",
  "· Disagreements that were resolved — only surface unresolved ones if they materially affect the implication.",
  "· Anything the user said that wasn't picked up by the directors.",
].join("\n");

export function buildBriefMessages(opts: BuildOpts): LLMMessage[] {
  const { room, members, transcript, style } = opts;
  const language: "zh" | "en" = opts.language ?? "en";

  const memberList = members
    .map((a) => `${a.name} (${a.handle}) — ${a.roleTag}: ${a.bio}`)
    .join("\n  · ");

  const renderedTranscript = transcript
    .map((m) => {
      if (m.authorKind === "user") return `[You]: ${m.body}`;
      if (m.authorKind === "system") return `[system]: ${m.body}`;
      const a = members.find((x) => x.id === m.authorId);
      const name = a ? `${a.name} (${a.handle})` : "[unknown]";
      return `[${name}]: ${m.body}`;
    })
    .join("\n\n");

  const langLine = language === "zh"
    ? "## 输出语言\n本次会议的 Initial Question 是中文，请用**简体中文**撰写报告。"
    : "## Output language\nThis room's Initial Question was in English. Write the brief in English.";

  const system: LLMMessage = {
    role: "system",
    content: [style === "mckinsey" ? SYSTEM_MCKINSEY : SYSTEM_MCKINSEY, "", langLine].join("\n"),
  };

  const user: LLMMessage = {
    role: "user",
    content: [
      `ROOM #${room.number} · ${room.name}`,
      `Subject: ${room.subject}`,
      `Mode: ${room.mode}`,
      ``,
      `Directors at the table:`,
      `  · ${memberList}`,
      ``,
      `─── TRANSCRIPT ───`,
      ``,
      renderedTranscript,
      ``,
      `─── END TRANSCRIPT ───`,
      ``,
      `Write the brief now. Markdown only. Start with the H2 title — no preamble.`,
    ].join("\n"),
  };

  return [system, user];
}

/**
 * Pull the H2 title out of the brief markdown. Falls back to the room subject
 * if no H2 found in the first 8 lines.
 */
export function extractBriefTitle(bodyMd: string, fallback: string): string {
  const lines = bodyMd.split("\n").slice(0, 12);
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line.trim());
    if (m && m[1] && !/^(situation|findings|implication)$/i.test(m[1])) {
      return m[1].trim();
    }
  }
  return fallback;
}
