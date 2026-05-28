/**
 * Sidebar topic-phrase pass · turns the room's opening question into a
 * short, scannable label that replaces the 60-char truncation of
 * `subject` that `createRoom` writes into `name` at creation time.
 * Modeled on ChatGPT's sidebar behavior — given a verbose opening,
 * render the conversation's topic as 4-8 CJK chars or 2-5 Latin words.
 *
 * Trigger · fired fire-and-forget from the POST /api/rooms handler
 * right after the opening message is inserted. We rename from the
 * user's initial question alone — director replies aren't needed and
 * waiting for round 1 to "end" was unreliable (rooms in manual-vote
 * mode or with users who only click Continue never fired the hook).
 *
 * Guarantees · this function never throws to its caller. LLM
 * outages, sanitisation failure, or storage races degrade silently
 * (the original 60-char fallback in `name` remains). The SQL guard
 * in `setRoomNameFromAuto` (UPDATE ... WHERE name_auto = 1) is the
 * source of truth for "don't clobber user-authored names" — this
 * file doesn't re-check the flag.
 */
import { callLLM } from "../ai/adapter.js";
import { utilityModelFor } from "../ai/availability.js";
import type { ModelV } from "../ai/registry.js";

import { listMessages } from "../storage/messages.js";
import { forceRoomAutoName, getRoom, setRoomNameFromAuto } from "../storage/rooms.js";

import { roomBus } from "./stream.js";

/** Hard cap on the LLM's returned phrase. Prompt asks for ≤24 chars,
 *  but utility models occasionally append a trailing clarifier. The
 *  TS-side cap is the safety net so the sidebar's row-title never
 *  overflows even if the model misbehaves. */
const MAX_TITLE_CHARS = 32;

/** Generic outputs the model sometimes emits when it can't find a
 *  topic — drop these and let the original `subject` truncation
 *  remain. Match case-insensitively against the trimmed phrase. */
const REJECT_PHRASES = new Set([
  "untitled",
  "untitled room",
  "discussion",
  "chat",
  "conversation",
  "topic",
  "summary",
  "未命名",
  "讨论",
  "对话",
  "聊天",
]);

/** Outcome of a single room's title-gen attempt. */
export type RoomTitleResult =
  | { kind: "ok"; before: string; after: string }
  | {
      kind: "skipped";
      reason:
        | "no-room"
        | "not-thread"
        | "no-message"
        | "user-named"
        | "already-renamed"
        | "no-subject"
        | "no-model"
        | "llm-error"
        | "empty-output"
        | "rejected-generic"
        | "race-after-rename";
      detail?: string;
    };

export async function generateRoomTitle(roomId: string): Promise<RoomTitleResult> {
  const room = getRoom(roomId);
  if (!room) {
    process.stderr.write(`[room-title] room=${roomId} skip=no-room\n`);
    return { kind: "skipped", reason: "no-room" };
  }
  if (!room.nameAuto) {
    process.stderr.write(`[room-title] room=${roomId} kind=${room.kind} skip=user-named\n`);
    return { kind: "skipped", reason: "user-named" };
  }

  const subject = room.subject.trim();
  if (!subject) {
    process.stderr.write(`[room-title] room=${roomId} kind=${room.kind} skip=no-subject\n`);
    return { kind: "skipped", reason: "no-subject" };
  }

  // Idempotency guard · `name_auto` stays 1 after a successful rename
  // (it tracks user-set vs auto-set, not "still the fallback"). If the
  // current name no longer matches the original 60-char truncation,
  // someone already renamed it — skip the LLM call.
  const fallbackName = room.subject.slice(0, 60);
  if (room.name !== fallbackName) {
    process.stderr.write(
      `[room-title] room=${roomId} kind=${room.kind} skip=already-renamed ` +
      `name="${room.name.slice(0, 30)}" fallback="${fallbackName.slice(0, 30)}"\n`,
    );
    return { kind: "skipped", reason: "already-renamed", detail: room.name.slice(0, 60) };
  }

  const r = await distillTitle(subject, `room=${roomId} kind=${room.kind}`);
  if (!r.ok) return { kind: "skipped", reason: r.reason, detail: r.detail };

  const updated = setRoomNameFromAuto(roomId, r.phrase);
  if (!updated) return { kind: "skipped", reason: "race-after-rename" };

  // SSE push so any open client (sidebar, room header, mini-player)
  // can reflect the new name without a refetch. Reuses the existing
  // settings-changed protocol — the frontend's listener patches
  // currentRoom + the rooms array + re-renders the sidebar list.
  roomBus.emit(roomId, {
    type: "config-event",
    kind: "settings-changed",
    payload: { changes: { name: { from: room.name, to: r.phrase } } },
    createdAt: Date.now(),
  });

  return { kind: "ok", before: room.name, after: r.phrase };
}

/** Build the few-shot title-distillation prompt around an input text.
 *
 *  Prompt design notes:
 *  - Few-shot examples · utility-tier models (haiku-4-5 / gpt-5-4-mini /
 *    gemini-3-1-flash) benefit much more from concrete examples than
 *    from longer rule lists. Each example pairs a verbose opening
 *    (with throat-clearing, framing, product names, polite scaffolding)
 *    with the bare subject-matter title that survives the strip.
 *  - Length window · CJK 5-10 chars / Latin 3-6 words.
 *  - "Strip what doesn't distinguish" framing · gives the model a
 *    concrete operation to perform instead of an abstract goal. */
function buildTitlePrompt(text: string): string {
  return (
    "You are titling a conversation for a sidebar entry, the way ChatGPT does it. " +
    "Read the user's opening question and write the title that another reader " +
    "would expect to see for THIS conversation — specific enough to distinguish " +
    "it from any neighbouring entry in the same domain.\n\n" +
    "How to write a representative title:\n" +
    "1. Identify the CORE SUBJECT or TASK (the noun, the deliverable, the decision being made).\n" +
    "2. Strip throat-clearing, polite framing, self-introduction, and product names that are not the subject itself.\n" +
    "3. Keep one distinguishing modifier when the bare noun would be ambiguous (\"产品宣传视频脚本\" beats \"视频脚本\"; \"LoRA vs 全量微调\" beats \"LoRA\").\n" +
    "4. Use the SAME language as the opening question.\n\n" +
    "Length:\n" +
    "- Chinese / Japanese: 5-10 characters.\n" +
    "- English / Spanish / other Latin scripts: 3-6 words.\n" +
    "- ≤24 characters total.\n\n" +
    "Format:\n" +
    "- Output ONLY the title — no quotes, no brackets, no trailing punctuation, no labels like \"Topic:\" / \"主题：\", no explanation.\n" +
    "- Never output fillers like \"Untitled\", \"Discussion\", \"Chat\", \"Conversation\", \"讨论\", \"对话\", \"聊天\".\n\n" +
    "Examples:\n\n" +
    "Input: privateboard.ai 是我的创业产品，我现在想剪辑一个视频放到官网和 x.com 上面宣传介绍产品。你帮我写一个脚本。\n" +
    "Output: 产品宣传视频脚本\n\n" +
    "Input: 我们公司在考虑要不要从 Postgres 迁移到 ClickHouse 处理分析查询，能帮我列出权衡么\n" +
    "Output: Postgres 转 ClickHouse 权衡\n\n" +
    "Input: 我想讨论一下 LoRA 微调相比全量微调有什么优缺点，特别是在小模型上\n" +
    "Output: LoRA vs 全量微调\n\n" +
    "Input: Can you help me debug this Python regex that's failing on Unicode strings with combining marks?\n" +
    "Output: Python regex Unicode bug\n\n" +
    "Input: I want to redesign our onboarding email sequence — currently 5 emails over 2 weeks, low click-through.\n" +
    "Output: Onboarding email redesign\n\n" +
    `--- User's opening question ---\n${text}\n\n` +
    "--- Title ---\n"
  );
}

/** Shared distillation core · run the utility model over `text` and
 *  sanitise into a short phrase. Used by both the main-room titler
 *  and the thread titler so the prompt + model + cleanup stay in one
 *  place. Returns the phrase or a structured skip reason; never
 *  throws. `ctx` is a short label for the diagnostic log lines. */
async function distillTitle(
  text: string,
  ctx: string,
): Promise<
  | { ok: true; phrase: string }
  | { ok: false; reason: "no-model" | "llm-error" | "empty-output" | "rejected-generic"; detail?: string }
> {
  const modelV = utilityModelFor();
  if (!modelV) {
    process.stderr.write(`[room-title] ${ctx} skip=no-model\n`);
    return { ok: false, reason: "no-model" };
  }
  process.stderr.write(`[room-title] ${ctx} model=${modelV} input="${text.slice(0, 40)}…" · calling LLM\n`);
  let raw = "";
  try {
    raw = await callLLM({
      modelV: modelV as ModelV,
      carrier: null,
      messages: [{ role: "user", content: buildTitlePrompt(text) }],
      // Low but not zero · 0.2 kept locking onto a generic first-noun
      // pick; 0.4 lets the model trade off alternatives without
      // wandering into creative territory.
      temperature: 0.4,
      // 40 truncated mid-title for models that think briefly first;
      // 80 fits the title plus margin without inviting paragraphs.
      maxTokens: 80,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[room-title] ${ctx} LLM call failed: ${detail}\n`);
    return { ok: false, reason: "llm-error", detail };
  }
  if (!raw.trim()) {
    process.stderr.write(`[room-title] ${ctx} skip=empty-output model=${modelV}\n`);
    return { ok: false, reason: "empty-output", detail: `model=${modelV}` };
  }
  const phrase = sanitiseTitle(raw);
  if (!phrase) {
    process.stderr.write(`[room-title] ${ctx} skip=rejected-generic raw="${raw.trim().slice(0, 80)}"\n`);
    return { ok: false, reason: "rejected-generic", detail: raw.trim().slice(0, 80) };
  }
  process.stderr.write(`[room-title] ${ctx} llm_raw="${raw.trim().slice(0, 60)}" phrase="${phrase}"\n`);
  return { ok: true, phrase };
}

/** Normalise a thread's first user message into clean title-input text.
 *
 *  The qcta "Thread" button pre-seeds the composer with a markdown
 *  blockquote of the selected director line (`> …`) plus a `— @Director`
 *  attribution, then the user adds their own prose below (see
 *  public/quote-cta.js → public/app.js). We KEEP the quoted text — it's
 *  the topic the thread is about, and the user's own prose is frequently
 *  just a vague pointer ("展开讲讲这个" / "说说这里的高价值") that has no
 *  titleable content on its own. We only strip the markdown markers and
 *  the attribution line so the LLM sees plain "quoted topic + user
 *  angle" prose. */
function threadSeedText(body: string): string {
  return body
    .replace(/^\s*[—–-]\s*@.*$/gm, "") // drop the "— @Director" attribution line
    .replace(/^\s*>\s?/gm, "")          // unwrap markdown blockquote markers
    .replace(/\n{2,}/g, "\n")           // collapse the blank line between quote + prose
    .trim();
}

/**
 * Thread title pass · distil a private 1:1 thread's FIRST user message
 * into a short sidebar-style phrase, the same way main rooms get
 * titled.
 *
 * Why a separate function from `generateRoomTitle`:
 *   - Threads must title from their own first user message, NOT from
 *     `subject` (which legacy threads inherited verbatim from the
 *     parent room — so every thread off the same room shared one
 *     subject).
 *   - Legacy threads carry `name_auto = 0` + a `thread:<dir>`
 *     placeholder name, which makes `generateRoomTitle` bail at the
 *     "user-named" gate forever. Here we detect the raw/placeholder
 *     state directly and force the name through `forceRoomAutoName`.
 *
 * Idempotent + safe to re-fire (the popover's GET /threads handler
 * calls this for every listed thread): a thread whose name is already
 * a distilled phrase (not a placeholder, not the subject/message
 * truncation) is left untouched, so no LLM call is spent on it. Never
 * throws to its caller.
 */
export async function generateThreadTitle(threadId: string): Promise<RoomTitleResult> {
  const room = getRoom(threadId);
  if (!room) {
    process.stderr.write(`[thread-title] thread=${threadId} skip=no-room\n`);
    return { kind: "skipped", reason: "no-room" };
  }
  if (room.kind !== "thread") {
    return { kind: "skipped", reason: "not-thread" };
  }

  const firstUser = listMessages(threadId).find((m) => m.authorKind === "user");
  if (!firstUser || !firstUser.body.trim()) {
    return { kind: "skipped", reason: "no-message" };
  }
  const seed = threadSeedText(firstUser.body);
  if (!seed) {
    return { kind: "skipped", reason: "no-subject" };
  }

  // Raw-state detection · the name still needs distilling when it is a
  // legacy `thread:<dir>` placeholder, OR matches a 60-char truncation
  // of either the inherited subject or the first user message (the two
  // forms `createThread` / the first-message re-align leave behind).
  // Anything else is a phrase a prior pass (or the user) already set →
  // leave it. This is the idempotency guard that keeps the GET
  // /threads backfill from re-calling the LLM on already-titled rows.
  const name = (room.name || "").trim();
  const isPlaceholder = /^thread:/.test(name);
  const isRawTruncation =
    name === room.subject.slice(0, 60) || name === firstUser.body.slice(0, 60);
  if (!isPlaceholder && !isRawTruncation) {
    return { kind: "skipped", reason: "already-renamed", detail: name.slice(0, 60) };
  }

  const r = await distillTitle(seed, `thread=${threadId}`);
  if (!r.ok) return { kind: "skipped", reason: r.reason, detail: r.detail };

  const updated = forceRoomAutoName(threadId, r.phrase);
  if (!updated) return { kind: "skipped", reason: "race-after-rename" };

  roomBus.emit(threadId, {
    type: "config-event",
    kind: "settings-changed",
    payload: { changes: { name: { from: name, to: r.phrase } } },
    createdAt: Date.now(),
  });
  process.stderr.write(`[thread-title] OK thread=${threadId} "${name.slice(0, 30)}" → "${r.phrase}"\n`);
  return { kind: "ok", before: name, after: r.phrase };
}

/** Strip the cruft utility models like to add (quotes, leading
 *  labels, trailing periods, surrounding whitespace) and apply the
 *  hard length cap + generic-phrase reject. Returns null when the
 *  result is empty or matches a reject phrase. */
function sanitiseTitle(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  // If the model output multiple lines (an explanation, scaffolding,
  // or a stray second example), keep just the first non-empty line.
  // Run BEFORE whitespace collapse so newlines survive long enough to
  // split on.
  const firstLine = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine) s = firstLine;
  // The few-shot prompt uses "Input: … Output: …" pairs; some models
  // echo the "Output:" prefix on their own answer.
  s = s.replace(/^\s*output\s*[:：]\s*/i, "");
  // Some utility models prefix "Topic: " / "主题：" / "Title: ".
  s = s.replace(/^\s*(topic|title|主题|主題|标题|標題|タイトル)\s*[:：]\s*/i, "");
  // Strip wrapping quotes / brackets in any common script.
  s = s.replace(/^[\s"'`「『《【〈“‘]+/, "").replace(/[\s"'`」』》】〉”’]+$/, "");
  // Trailing punctuation that a "phrase, not a sentence" should drop.
  s = s.replace(/[\s.。!！?？,，;；:：]+$/, "");
  // Collapse internal whitespace.
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  // Reject filler outputs.
  if (REJECT_PHRASES.has(s.toLowerCase())) return null;
  // Hard length cap — Array.from to count code points (not UTF-16
  // units) so CJK + emoji aren't accidentally truncated mid-glyph.
  const cps = Array.from(s);
  if (cps.length > MAX_TITLE_CHARS) {
    s = cps.slice(0, MAX_TITLE_CHARS).join("");
  }
  return s;
}
