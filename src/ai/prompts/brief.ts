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
 * Detect H2 strings that look like topic labels rather than claim
 * sentences. The brief writer is instructed to emit a claim-style H2,
 * but it occasionally regresses to short noun-phrases ("反共识判断" /
 * "Market analysis" / "Investment Thesis"). Those leak into the brief
 * record and become unreadable in the sidebar / dashboard.
 *
 * Thresholds:
 *   · CJK text (no spaces, contains Han/Hiragana/Hangul): < 8 chars
 *   · Latin text (whitespace-tokenised): < 5 words
 */
function isLikelyTopicLabel(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const isCjk = !/\s/.test(trimmed) && /[一-鿿぀-ヿ가-힯]/.test(trimmed);
  if (isCjk) return trimmed.length < 8;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return wordCount < 5;
}

/**
 * Pull the title out of the brief markdown. Tries (1) the first H2 if
 * it's claim-style, then (2) the bottom-line judgement (which is
 * claim-style by schema), then (3) the supplied fallback.
 *
 * Skips the H2 when it's a topic-label noun-phrase ("反共识判断" /
 * "Market analysis"). Those titles render fine inside the brief body
 * but read as cryptic in the sidebar / link previews where context
 * isn't visible.
 */
export function extractBriefTitle(
  bodyMd: string,
  fallback: string,
  bottomLineJudgement?: string,
): string {
  const lines = bodyMd.split("\n").slice(0, 12);
  let firstH2: string | null = null;
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line.trim());
    if (m && m[1] && !/^(situation|findings|implication)$/i.test(m[1])) {
      firstH2 = m[1].trim();
      break;
    }
  }
  // Claim-style H2 wins · use it verbatim.
  if (firstH2 && !isLikelyTopicLabel(firstH2)) return firstH2;
  // H2 was missing or topic-style · prefer the bottom-line judgement
  // when it's substantive (≥ 12 chars). The judgement IS the brief's
  // claim sentence by schema.
  const judgement = (bottomLineJudgement || "").trim();
  if (judgement.length >= 12) return judgement;
  // Last resort · accept the short H2 if we have one, else the room
  // subject (which is the user's question).
  return firstH2 || fallback;
}
