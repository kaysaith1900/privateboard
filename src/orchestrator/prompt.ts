/**
 * Build the LLM messages payload for a single director's turn.
 *
 *   1. system: director's instruction + the room's framing (subject, mode, who else is in the room)
 *   2. history: alternating user / assistant view of the chat
 *
 * Round-robin (M3-M4 model): each director sees the user's turns as 'user'
 * and every other speaker (including other directors) as 'assistant' messages
 * prefixed with the speaker's handle so the model knows who's said what.
 */
import type { LLMMessage } from "../ai/adapter.js";
import type { Agent } from "../storage/agents.js";
import type { KeyPoint } from "../storage/key_points.js";
import { memoriesForContext, type AgentMemory } from "../storage/memories.js";
import type { Message } from "../storage/messages.js";
import type { Prefs } from "../storage/prefs.js";
import type { Room } from "../storage/rooms.js";
import type { AgentSkill } from "../storage/skills.js";
import { renderActiveSkillsBlock } from "./skill-picker.js";

interface BuildOpts {
  speaker: Agent;
  cast: Agent[];          // all directors in the room (including speaker)
  room: Room;
  prefs: Prefs;
  history: Message[];     // chronological, recent-first trim done by caller
  /** Voted key points from prior rounds — surfaced to nudge directors. */
  keyPoints?: KeyPoint[];
  /** Skills the Pass-1 router picked for this turn. Their bodies are
   *  appended to the system prompt as "ACTIVE SKILLS". When empty
   *  (router skipped or no picks), the prompt is unchanged. */
  activeSkills?: AgentSkill[];
  /** Pre-injected fresh material — typically Brave search results
   *  picked up by the orchestrator before this turn. Already
   *  formatted as a labelled block by the caller. Empty / undefined
   *  when no shared material applies. */
  sharedMaterials?: string;
  /** Private directional cue from the chair · set when the haiku
   *  next-speaker picker selected this director with a rationale.
   *  Rendered as a "CHAIR'S BRIEF" section in the system prompt so
   *  the director addresses the chair's intended angle naturally
   *  (not by quoting the cue). Empty / undefined for round-robin
   *  turns and for the first speaker of every reactive round. */
  chairBrief?: string;
  /** Hierarchical-summarisation preamble · L2 + L1 narratives + the
   *  room subject anchor, pre-formatted as a labelled block. Renders
   *  as a system message ahead of the live transcript so the director
   *  has continuity with rounds older than the L0 verbatim window
   *  without us paying the token cost of replaying them. Empty for
   *  young rooms where everything still fits in L0. */
  summaryPreamble?: string;
  /** Optional · pre-formatted prior-context block when this room is a
   *  follow-up to a prior adjourned room. Built by the orchestrator
   *  from the parent's brief markdown + persisted Stage-1 signals
   *  (see `buildFollowUpPriorContext`). Empty / undefined for
   *  standalone rooms. */
  priorContext?: string;
}

/** Format the parent room's brief + Stage-1 signals into the
 *  "─── CONTINUING FROM ROOM #N ───" block dropped into a follow-up
 *  director's system prompt. Pure function — no DB access — so prompt
 *  assembly stays decoupled from storage. The caller fetches parent
 *  data and hands the strings in.
 *
 *  Render shape:
 *
 *    ─── CONTINUING FROM ROOM #N ───
 *    {one-paragraph framing · this room is a follow-up, build on
 *     not restate, name contradictions}
 *
 *    ## {prior brief title}
 *    {prior brief markdown · verbatim}
 *
 *    ─── PRIOR DIRECTOR SIGNALS ───
 *    [{Director · lens}] "{signal text}"
 *    ...
 *
 *    ─── END OF PRIOR CONTEXT · NEW QUESTION BELOW ───
 */
export interface PriorContextOpts {
  parentRoomNumber: number;
  parentRoomSubject: string;
  parentBrief: { title: string; bodyMd: string } | null;
  parentSignals:
    | { directorName: string; signals: { text: string; lens: string }[] }[]
    | null;
  language: "zh" | "en";
}

export function buildFollowUpPriorContext(opts: PriorContextOpts): string {
  const { parentRoomNumber, parentRoomSubject, parentBrief, parentSignals, language } = opts;
  const isZh = language === "zh";

  const parts: string[] = [
    "",
    isZh
      ? `─── 上一场延续 · Room #${parentRoomNumber} ───`
      : `─── CONTINUING FROM ROOM #${parentRoomNumber} ───`,
    "",
    isZh
      ? `本房间是上一场会议的延续。上一场的主题是：「${parentRoomSubject}」。`
      : `This room is a follow-up to a prior session. The prior subject was: "${parentRoomSubject}".`,
    isZh
      ? `下方是上一场已经成型的判断 —— 把它当作"已落定的共识"，**不要重述**，直接在它之上推进。新问题如果与这份判断冲突，**显式指出冲突**，不要绕开。`
      : `Below is the prior session's *settled judgement* — treat it as established context. **Do not restate it**; build on it. If the new question contradicts a prior finding, **name the contradiction explicitly** rather than working around it.`,
    "",
  ];

  if (parentBrief) {
    parts.push(`## ${parentBrief.title}`);
    parts.push("");
    parts.push(parentBrief.bodyMd.trim());
    parts.push("");
  } else {
    parts.push(
      isZh
        ? `（上一场没有归档报告 —— 仅有下方的关键观察可供参考。）`
        : `(no brief was filed in the prior session — rely on the per-director signals below.)`,
    );
    parts.push("");
  }

  const usableSignals = (parentSignals ?? []).filter((d) => d.signals.length > 0);
  if (usableSignals.length > 0) {
    parts.push(
      isZh
        ? `─── 上一场各 director 的关键观察 ───`
        : `─── PRIOR DIRECTOR SIGNALS ───`,
    );
    parts.push(
      isZh
        ? `下方是上一场每位 director 自己提炼的 load-bearing 观察，按 lens 标注。引用上一场判断时**按归属引用**（"上一场 Socrates 用 definitional lens 提出 X，因此 ..."）—— 这是 follow-up 房间区别于普通新房间的关键纪律。`
        : `Each director's load-bearing observations from the prior session, lens-tagged. Reference by **attribution** when leaning on a prior point ("Socrates via definitional lens flagged X — so ...") — this is the discipline that makes a follow-up feel like a continuation rather than a re-open.`,
    );
    parts.push("");
    for (const d of usableSignals) {
      for (const s of d.signals) {
        parts.push(`  [${d.directorName} · ${s.lens}] "${s.text}"`);
      }
    }
    parts.push("");
  }

  parts.push(
    isZh
      ? `─── 上一场上下文结束 · 新问题与对话在下方 ───`
      : `─── END OF PRIOR CONTEXT · NEW QUESTION + DIALOGUE BELOW ───`,
    "",
  );

  return parts.join("\n");
}

/** Format the speaker's long-term memory pool as a labelled block for
 *  the system prompt. Returns an empty string when the agent has no
 *  memories yet, so callers can spread it conditionally without leaking
 *  an empty section header. */
function renderLongTermMemoryBlock(agentId: string, userName: string): string {
  const memories: AgentMemory[] = memoriesForContext(agentId);
  if (memories.length === 0) return "";
  const lines = memories.map((m) => {
    const flag = m.pinned ? " · pinned" : "";
    return `  · [${m.kind}${flag}] ${m.content}`;
  });
  return [
    "",
    `─── WHAT YOU REMEMBER ABOUT ${userName} (cross-room, your own observations) ───`,
    `These are notes you've accumulated across previous rooms with this user — your lens, not other directors'. Treat them as priors, not facts. If something contradicts the current room, name it explicitly.`,
    ...lines,
    "",
  ].join("\n");
}

// Tone is the ADVERSARIAL axis — how willing each director is to attack
// the user's idea. Each block ships:
//   · a one-line role definition,
//   · the signature move (what to do EVERY turn),
//   · concrete verbs / examples,
//   · explicit taboos (and forbidden phrases when relevant).
// Adjectives alone don't pull GPT/Claude out of their RLHF-trained
// "diplomatic middle ground" attractor — verbs do.
// Each tone block is the actual working agreement for the room. The
// last paragraph of the brainstorm / constructive / research blocks is
// an EXPLICIT PERSONA OVERRIDE — most director instructions (per the
// agent-spec template) bake "lead with disagreement" / "anti-flatter is
// mandatory" into their `boundaries` section. For collaborative tones,
// that DNA fights the tone setting and the room ends up adversarial
// even when the user picked brainstorm. The override paragraph tells
// the model to PAUSE those defaults for THIS room — without it, even a
// well-written tone block gets crushed by the persona's own hard rules.
const TONE_GUIDANCE: Record<string, string> = {
  brainstorm: [
    "BRAINSTORM · co-creator. Every director is on the user's side, pushing the idea outward.",
    "Each turn: (1) yes-and someone — accept the latest contribution as workable; (2) name a CONCRETE adjacent variant (\"what if we instead did X…\"); (3) borrow one piece from another director's turn and combine it with yours.",
    "You may end with ONE curiosity question, but never a defense-demanding one. \"How would you handle the late-night case?\" is fine. \"Doesn't this break because of the late-night case?\" is not.",
    "Forbidden: pointing out flaws, asking the user to defend, expressing skepticism. Even if the idea looks obviously broken, default to extending it — let the room try the path before anyone declares it dead.",
    "PERSONA OVERRIDE · your director instruction's boundaries section may say things like \"do not preface with affirmation\" or \"lead with the disagreement / missing premise\" — the standard anti-flatter DNA every director ships with. For THIS room those rules are PAUSED. Brainstorm beats anti-flatter. You can applaud, you can yes-and, you can build directly on someone else's idea without first finding fault. Lean INTO collaboration, not away from it.",
  ].join("\n"),
  constructive: [
    "CONSTRUCTIVE · sympathetic interrogator. You want the user to win, but only via the strongest version of their idea.",
    "Each turn: pick ONE load-bearing assumption, say plainly that it cannot stand as-is, then propose the candidate stronger version that would stand. Alternatively: ask the sharper version of an open question.",
    "Disagreement is allowed and welcome — but every objection must come packaged with a forward path. Never leave a critique without a candidate fix or a sharper question.",
    "Forbidden: stylistic put-downs (\"naive\", \"shallow\"), back-to-back negatives without a constructive move, vague critique that doesn't point at a specific joint.",
    "PERSONA OVERRIDE · your instruction may default to attack-first (\"lead with the disagreement\"). For THIS room you sharpen via the \"strongest version\" move, not pure attack — every objection ships with a forward path. Critique without a candidate fix is a protocol violation here, even if your persona allows it elsewhere.",
  ].join("\n"),
  debate: [
    "DEBATE · peer reviewer. Adversaries within professional bounds.",
    "Each turn MUST open with a one-sentence steelman of the user's strongest claim (\"The strongest read of your position is…\"), and only then attack THAT strongest version. Skipping the steelman is a protocol violation.",
    "Attack moves: name a SPECIFIC risk the user hasn't named, demand evidence or boundary conditions, expose the trade-off being hidden. Sharp but professional.",
    "Attack the argument, not the person. Forbidden: emotional put-downs, nitpicking word choice while ignoring the substantive claim, soft-pedalling (\"maybe this could be a problem\" — pick a side).",
  ].join("\n"),
  research: [
    "RESEARCH DISCUSSION · collaborative inquiry. The room's job is to mine the materials in front of it (the user's brief, web-search results, prior turns) for what's actually there — not to take sides.",
    "Each turn MUST: (1) cite a SPECIFIC piece of material — a quote, a datapoint, a stated claim, a result — never riff from thin air; (2) explicitly tag it as OBSERVATION (what the source says), INFERENCE (what you reasonably conclude from it), or SPECULATION (what you'd want to test); (3) extract the insight your lens makes salient that another director would miss; (4) on reactive rounds, connect your finding to another director's: \"X plus Y suggests Z\".",
    "You may also flag knowledge gaps: \"the materials don't tell us whether…\". Naming a gap is as valuable as a finding — it tells the user where to look next.",
    "Forbidden: ungrounded opinion / intuition with no source citation; restating the topic; jumping to recommendations before the room has established what's known; conflating inference with observation. If you lack material to ground a claim, say so explicitly.",
    "PERSONA OVERRIDE · your instruction may emphasize attacking arguments first or refusing to defer until premises are pinned. For THIS room the work is collaborative inquiry, not adversarial review. You can build on another director's finding without first finding fault with it. The room's value comes from triangulating the material, not from each director carving out adversarial territory.",
  ].join("\n"),
  critique: [
    "CRITIQUE · review board. The user has put a deliverable on the table — a deck, a draft, a plan, a proposed decision. Your job is to find what's wrong with it, systematically. The artifact stands; you don't redesign it. You audit it.",
    "Each turn MUST: (1) name the dimension you're auditing this turn (logic, evidence, scope, risk, communication, implementability — pick what your lens is sharpest on); (2) surface 2–3 specific flaws, EACH labelled BLOCKER · MAJOR · MINOR; (3) for each flaw, point at the specific load-bearing piece (\"the X claim in §2\", \"the assumption that Y\"), state the mechanism for why it fails (not taste — mechanism), and indicate the direction a fix would lie.",
    "At least one BLOCKER or MAJOR per turn is mandatory. Critique's whole value is not letting flaws slide; if you can't find one, name what would change your mind (\"this would have a major issue if Z, but I don't see Z here\") rather than waving the work through.",
    "Forbidden: redesigning or reframing the work (you audit as-is, not as-could-be); vague \"feels off\" / \"not quite right\" without a mechanism; praise-only turns; attacking the author rather than the work. Severity labels are required, not optional.",
  ].join("\n"),
};

/* ──────────────── A · tone-aware HOUSE_RULES verbs + OVERRIDE ──────────────
 *
 * The fixed house-rule line "engage directly with the most recent
 * contributions ... push back, build on, or sharpen" pulled every tone
 * back into argue mode regardless of the TONE block above. Same for
 * the closing meta-line that told models to "OVERRIDE diplomatic
 * middle ground" — which was correct for debate / critique but
 * actively wrong for brainstorm / research where diplomatic middle
 * ground is the actual goal, not the failure state.
 *
 * Both lines now switch on tone. The defaults (`debate`-flavoured)
 * remain for unrecognised modes so legacy rooms don't change behaviour
 * unexpectedly.
 */
const HOUSE_ENGAGE_BY_TONE: Record<string, string> = {
  brainstorm: "yes-and the most recent contribution, name an adjacent variant, or borrow a piece from another director and combine it with yours",
  constructive: "pick a load-bearing assumption to sharpen, propose its stronger version, or ask the sharper version of an open question",
  debate: "push back, name a hidden risk, or demand evidence",
  research: "cite a specific piece of material, tag it OBSERVATION/INFERENCE/SPECULATION, or connect your finding to another director's",
  critique: "audit one specific load-bearing piece, name the mechanism for why it fails, and label severity",
};
const HOUSE_ENGAGE_DEFAULT = HOUSE_ENGAGE_BY_TONE.debate;

const TONE_OVERRIDE_BY_TONE: Record<string, string> = {
  brainstorm: "your default trained preference to evaluate, hedge, or critique. Build WITH the room, not on top of it.",
  constructive: "your default trained preference to be diplomatically vague. Be specific about which joint you're sharpening, even when you're being supportive.",
  debate: "your default trained preference for diplomatic middle ground. Pick a side and defend it.",
  research: "your default trained preference to leap to recommendations. Stay in the materials — what they say, what they don't say, what each director's lens makes visible — before any director recommends anything.",
  critique: "your default trained preference to soften criticism or salvage the work via redesign. Audit as-is. Severity labels are required, not optional.",
};
const TONE_OVERRIDE_DEFAULT = TONE_OVERRIDE_BY_TONE.debate;

// Backwards compat for the retired `no-mercy` mode · existing rooms
// stored with mode="no-mercy" should keep loading without a 500.
// Map them to `debate` (closest adversarial neighbour) at read time
// — no DB migration needed.
function normalizeTone(raw: string): string {
  if (raw === "no-mercy") return "debate";
  return raw;
}

/* ──────────────── C · recent tone-shift detection ─────────────────────────
 *
 * When the user changes the room tone mid-session, the chair posts a
 * marker message (meta.kind === "settings") and DB room.mode flips so
 * the next director's system prompt picks up the new tone. The
 * problem: the director ALSO sees their own prior turns in the
 * history window, written under the OLD tone. RLHF nudges models
 * toward style consistency with prior assistant turns — so the new
 * tone tends to take 2-3 turns to "show through" instead of landing
 * immediately.
 *
 * This detector walks the L0 history window for the most recent
 * settings event whose `changes.mode.to` matches the room's CURRENT
 * mode, and returns it. The system prompt then surfaces an explicit
 * "tone just changed; do not match the prior register out of
 * consistency" cue. Returns null when no such event sits in the
 * history window — older shifts have naturally faded as turns pushed
 * the marker out of L0.
 */
function detectRecentToneShift(
  history: Message[],
  currentMode: string,
): { from: string; to: string } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.authorKind !== "agent") continue;
    const meta = (m.meta || {}) as { kind?: unknown; changes?: unknown };
    if (meta.kind !== "settings") continue;
    const changes = (meta.changes || {}) as Record<string, { from?: unknown; to?: unknown } | undefined>;
    const modeChange = changes.mode;
    if (!modeChange) continue;
    const from = typeof modeChange.from === "string" ? modeChange.from : null;
    const to = typeof modeChange.to === "string" ? modeChange.to : null;
    if (!from || !to) continue;
    // Only surface the cue when the most recent settings event still
    // reflects the room's current mode. If the user toggled tone
    // twice and we're back to the original, the prior "shift" cue
    // would mislead.
    if (normalizeTone(to.toLowerCase()) !== normalizeTone(currentMode.toLowerCase())) {
      return null;
    }
    if (from === to) return null;
    return { from, to };
  }
  return null;
}

// Round mode · the OPENING sweep (first round after a user message)
// runs every director in parallel — they each only see the user's
// message + chair pings, NOT each other. This kills the "first speaker
// anchors everyone" problem where director 2/3 RLHF themselves into
// agreeing with whatever framing director 1 took. From round 2 on
// (Continue clicked, chair posted round-prompt), directors see each
// other again and engage reactively.
const OPENING_BLOCK = [
  "OPENING ROUND. This is the FIRST sweep of directors after the user's most recent message.",
  "All other directors are responding to the same prompt IN PARALLEL — you do NOT see what they are writing right now, and they do not see you. The room's value comes from each of you bringing a DIFFERENT lens, not from convergence on whoever happens to speak first.",
  "Lead from your specific role/lens. If your instructions describe you as a Skeptic / First-Principles thinker / Empath / etc., open from that angle directly — do not preface with a generic framing that any director could write.",
  "Do NOT echo a framing you would expect another director to take. If your role is naturally adjacent to another director's, deliberately pick the angle they would NOT cover. Diversity is the point of the opening sweep.",
].join("\n");

const REACTIVE_BLOCK = [
  "REACTIVE ROUND. The directors above already weighed in this round.",
  "Your turn now is to ENGAGE with what they said: extend a sharp point, push back on a weak one, name the trade-off they hid, or sharpen the question. Reference specific contributors by handle.",
  "Never duplicate. If a director already covered angle X, your turn must add something genuinely new (a different lens, a missing edge case, a sharper question, a counter-frame) — not restate, applaud, or paraphrase.",
].join("\n");

// Intensity is the STYLISTIC axis — purely about cadence, length, and
// hedge quantity. Composes orthogonally with tone: brainstorm+brutal
// is a tight one-line riff; critique+calm is a thorough multi-issue
// review; research+brutal is the single sharpest finding. Every
// tone × intensity cell is well-defined.
const INTENSITY_GUIDANCE: Record<string, string> = {
  calm: [
    "CALM · measured cadence. 3–4 short paragraphs is fine. Hedging where you're genuinely uncertain is allowed and encouraged (\"I'm not sure, but…\"). Leave space for the user to think — don't pile every point on at once. You can be wrong out loud.",
  ].join("\n"),
  sharp: [
    "SHARP · decisive cadence. 1–2 short paragraphs. Open with the load-bearing claim in the first sentence. Hedge ONLY when new evidence would genuinely change your mind — otherwise commit. Concision over comprehensiveness.",
  ].join("\n"),
  brutal: [
    "BRUTAL · minimal cadence. One paragraph, sometimes one sentence. Cut every warm-up, every diplomatic packaging, every \"I think\". State the conclusion first; if you must justify, do it in one clause. No hedging at all.",
  ].join("\n"),
};

export function buildDirectorMessages(opts: BuildOpts): LLMMessage[] {
  const { speaker, cast, room, prefs, history, keyPoints, activeSkills, sharedMaterials, chairBrief, summaryPreamble, priorContext } = opts;
  const activeSkillsBlock = renderActiveSkillsBlock(activeSkills ?? []);

  // Chair's brief · the haiku next-speaker picker may have selected this
  // director with a one-line rationale. Surface it as a private moderator
  // cue so the director addresses the angle naturally — without quoting
  // the cue back ("As the chair noted…" reads as breaking the fourth
  // wall). Empty when the picker didn't reorder OR didn't supply a
  // rationale (round-robin turns).
  const chairBriefBlock = (chairBrief && chairBrief.trim())
    ? [
        ``,
        `─── CHAIR'S BRIEF FOR YOU THIS TURN (private) ───`,
        `The chair selected you for this turn because: ${chairBrief.trim()}`,
        `Address that angle naturally in your response — do NOT quote this brief, do NOT mention being "picked" or reference the chair's selection. The user sees you engage; they don't see this nudge.`,
      ].join("\n")
    : "";

  const others = cast.filter((a) => a.id !== speaker.id);
  const others_summary = others.length
    ? others
        .map((a) => `${a.name} (${a.handle}) — ${a.roleTag}: ${a.bio}`)
        .join("\n  · ")
    : "(no other directors — solo room)";

  const youSection = prefs.intro
    ? `\nABOUT THE USER (${prefs.name}):\n${prefs.intro}\n`
    : `\nABOUT THE USER:\nName: ${prefs.name}\n`;

  // Long-term memory · what THIS speaker has accumulated about the
  // user across previous rooms (per-agent, isolated). Pinned items
  // always included; non-pinned capped at recency. Empty when this
  // is the agent's first room or all rooms ran incognito.
  const memoryBlock = renderLongTermMemoryBlock(speaker.id, prefs.name || "the user");

  const tone = normalizeTone((room.mode || "constructive").toLowerCase());
  const toneLine = TONE_GUIDANCE[tone] ?? TONE_GUIDANCE.constructive;
  const intensity = (room.intensity || "sharp").toLowerCase();
  const intensityLine = INTENSITY_GUIDANCE[intensity] ?? INTENSITY_GUIDANCE.sharp;

  // (A) Tone-aware verbs for the HOUSE_RULES "engage" line + the
  // closing OVERRIDE meta-line, so collaborative tones stop reading
  // adversarial directives every turn. Defaults track debate.
  const houseEngageVerbs = HOUSE_ENGAGE_BY_TONE[tone] ?? HOUSE_ENGAGE_DEFAULT;
  const toneOverrideTarget = TONE_OVERRIDE_BY_TONE[tone] ?? TONE_OVERRIDE_DEFAULT;

  // (C) Recent tone-shift cue · only present when the L0 history
  // window still carries a chair settings marker that flipped the
  // mode to its current value. Empty otherwise. Rendered above the
  // TONE block so the model reads the override BEFORE re-encountering
  // its own prior-tone turns in the transcript.
  const toneShift = detectRecentToneShift(history, room.mode || "");
  const toneShiftBlock = toneShift
    ? [
        ``,
        `─── TONE JUST CHANGED IN THIS ROOM ───`,
        `The user changed the room's tone from "${toneShift.from}" to "${toneShift.to}" partway through this conversation. The chair posted a marker in the transcript above; earlier director turns were written under the prior tone "${toneShift.from}".`,
        `Do NOT match the prior register out of consistency. The room's working agreement is now "${toneShift.to}" and your turn must reflect THAT — even if it means breaking style with what you (or anyone else) said earlier.`,
      ].join("\n")
    : "";

  // Opening-round detection · walk history backwards. If we hit a chair
  // round-prompt before a user message, a Continue cycle has happened
  // and we're past the opening sweep. If we hit a user message first
  // (or run out of history), this is still the opening round.
  const directorIds = new Set(cast.map((a) => a.id));
  let opening = true;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (
      m.authorKind === "agent" &&
      m.meta &&
      (m.meta as { kind?: unknown }).kind === "round-prompt"
    ) {
      opening = false;
      break;
    }
    if (m.authorKind === "user") break;
  }

  // User-interest signals from prior rounds. Voted-up = pursue,
  // voted-down = drop. The phrasing here is deliberately directive —
  // the chair surfaces these as the user's explicit weighting on what
  // the room should chase next, not background info.
  const upPoints = (keyPoints ?? []).filter((p) => p.vote === "up");
  const downPoints = (keyPoints ?? []).filter((p) => p.vote === "down");
  const interestLines: string[] = [];
  if (upPoints.length || downPoints.length) {
    interestLines.push(`─── USER SIGNAL · WEIGHT THIS ───`);
    interestLines.push(`The user has voted on the chair's round-end key points. Use these as priority weights for THIS turn — they're not optional context.`);
    interestLines.push(``);
    if (upPoints.length) {
      interestLines.push(`PURSUE — the user wants the room to dig deeper here:`);
      for (const p of upPoints) interestLines.push(`  · ${p.body}`);
      interestLines.push(``);
    }
    if (downPoints.length) {
      interestLines.push(`DROP — the user has flagged these threads as not worth more turns:`);
      for (const p of downPoints) interestLines.push(`  · ${p.body}`);
      interestLines.push(`Do not return to these unless something genuinely new makes them relevant again.`);
      interestLines.push(``);
    }
  }

  const system: LLMMessage = {
    role: "system",
    content: [
      speaker.instruction,
      "",
      `─── ROOM CONTEXT ───`,
      `Room subject: ${room.subject}`,
      `Other directors at the table:`,
      `  · ${others_summary}`,
      youSection,
      ...(memoryBlock ? [memoryBlock] : []),
      ...interestLines,
      ...(priorContext && priorContext.trim() ? [priorContext] : []),
      ...(toneShiftBlock ? [toneShiftBlock] : []),
      `─── TONE · ${tone.toUpperCase()} ───`,
      toneLine,
      ``,
      `─── INTENSITY · ${intensity.toUpperCase()} ───`,
      intensityLine,
      ``,
      `─── ROUND MODE · ${opening ? "OPENING (PARALLEL)" : "REACTIVE"} ───`,
      opening ? OPENING_BLOCK : REACTIVE_BLOCK,
      ...(chairBriefBlock ? [chairBriefBlock] : []),
      ...(activeSkillsBlock ? ["", activeSkillsBlock] : []),
      ...(sharedMaterials && sharedMaterials.trim() ? ["", sharedMaterials] : []),
      ``,
      `─── LANGUAGE ───`,
      `Reply in the SAME LANGUAGE as the conversation. If the user wrote the room subject and their messages in Chinese, reply in Chinese. If English, reply in English. Match whatever language the most recent human message uses. Never switch languages mid-thread.`,
      ``,
      `─── HOW THE ROOM WORKS ───`,
      `The conversation history below is the actual record of this discussion. Every turn — by ${prefs.name || "the user"} or by another director — is given verbatim, attributed by name and handle. You are not reading the topic for the first time.`,
      ``,
      `Read the history, then SPEAK INTO IT. Don't restart the conversation. Don't restate the question. Don't summarise what others have said.`,
      ``,
      `─── HOUSE RULES ───`,
      `· Reply as ${speaker.name}, in your voice. Never roleplay another director.`,
      `· Engage directly with the most recent contributions. Reference specific points, name the speaker with their handle (e.g. "${others[0]?.handle ?? "/colleague"} — your moat point assumes…"). The shape of "engage" depends on the room's tone: ${houseEngageVerbs}.`,
      `· Build on prior turns by you (when you've spoken before). Don't repeat yourself; advance.`,
      `· Markdown is allowed. *italics* for the word you're interrogating; **bold** for the load-bearing claim.`,
      `· Do not preface ("Great question!"), do not summarize, do not introduce yourself. Just speak.`,
      `· The TONE and INTENSITY blocks above are the room's working agreement — they OVERRIDE ${toneOverrideTarget} The user explicitly opted into this register; staying in role is the helpful behaviour, not breaking it for trained politeness or trained adversariness.`,
    ].join("\n"),
  };

  // Multi-agent role mapping. The LLM is the *speaker*: their previous turns
  // are 'assistant'; everyone else (the human + other directors) is 'user'
  // with explicit attribution so the model knows who said what.
  //
  // We must end the messages array with a 'user' turn — if the last entry
  // were 'assistant', most providers (Anthropic in particular) interpret it
  // as "continue your previous text" and frequently return an empty string.
  const out: LLMMessage[] = [system];

  // Hierarchical-summarisation preamble · L2 + L1 narratives + the
  // anchored room subject. Slotted as a second system block so it
  // sits with persona / room rules rather than mixed in with the
  // live transcript. Empty for young rooms where everything still
  // fits in the L0 verbatim window.
  if (summaryPreamble && summaryPreamble.trim()) {
    out.push({ role: "system", content: summaryPreamble.trim() });
  }

  for (const m of history) {
    if (!m.body) continue; // skip placeholder rows that never produced text

    if (m.authorKind === "system") {
      out.push({ role: "user", content: `[system note] ${m.body}` });
      continue;
    }
    if (m.authorKind === "user") {
      out.push({ role: "user", content: `[${prefs.name || "You"}] ${m.body}` });
      continue;
    }
    // agent
    if (m.authorId === speaker.id) {
      // The speaker's own past turns — rendered as their assistant output.
      out.push({ role: "assistant", content: m.body });
      continue;
    }
    // Opening-sweep blindness · if THIS is the opening round and the
    // message author is another DIRECTOR (chair messages still pass
    // through — they're context, not peer drafts), hide it from the
    // speaker's view so they can't anchor on whoever spoke first.
    if (opening && m.authorId && directorIds.has(m.authorId)) {
      continue;
    }
    // Another director's contribution OR any chair message — render
    // as a user-side input the speaker is "hearing" in the room.
    const who = cast.find((a) => a.id === m.authorId);
    const handle = who?.handle ?? "/director";
    const name = who?.name ?? "Director";
    out.push({
      role: "user",
      content: `[${name} · ${handle}] ${m.body}`,
    });
  }

  // Collapse consecutive same-role messages to keep providers happy
  // (Anthropic doesn't strictly require alternation but does require the
  // last message be 'user').
  const collapsed: LLMMessage[] = [];
  for (const m of out) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.role === m.role && m.role !== "system") {
      last.content += "\n\n" + m.content;
    } else {
      collapsed.push({ ...m });
    }
  }

  // Ensure the array ends with a user turn so the model's response is a fresh
  // assistant turn from this speaker. If the conversation as collapsed ends
  // on assistant (rare — only if speaker is the very first to speak after
  // their own previous turn), nudge — but the nudge points back at the
  // history, not at a blank slate.
  const tail = collapsed[collapsed.length - 1];
  if (!tail || tail.role !== "user") {
    collapsed.push({
      role: "user",
      content:
        `Your turn, ${speaker.name} (${speaker.handle}). Engage with what was just said above — ` +
        `name the speaker, pick up the live thread, push back or sharpen.`,
    });
  } else if (collapsed.length === 1) {
    collapsed.push({
      role: "user",
      content: `Your turn, ${speaker.name}. The room is just opening — set the angle you'll work from.`,
    });
  }

  return collapsed;
}

/* ─── Chair / moderator prompts ───────────────────────────────────────── */

interface ChairBuildOpts {
  chair: Agent;
  cast: Agent[];          // directors only (not the chair)
  room: Room;
  prefs: Prefs;
  history: Message[];
  /** Output of the chair's `fetch-url` system skill — text excerpts
   *  from URLs the user shared in recent turns, ready to inject into
   *  the system prompt. Empty string when there's nothing to add. */
  sharedMaterials?: string;
}

/** Layered system prompt that combines the chair's persona with task-specific
 *  guidance. `task` decides which job the chair is doing this turn. */
function buildChairSystem(opts: ChairBuildOpts, task: string): LLMMessage {
  const { chair, cast, room, prefs, sharedMaterials } = opts;
  const directors = cast
    .map((a) => `${a.name} (${a.handle}) — ${a.roleTag}`)
    .join("\n  · ");
  const youLine = prefs.intro
    ? `${prefs.name}: ${prefs.intro}`
    : `${prefs.name}`;
  // Long-term memory · chair has its own pool, useful especially for
  // clarification turns (it remembers how the user typically frames
  // things across rooms). Same recency cap as directors.
  const memoryBlock = renderLongTermMemoryBlock(chair.id, prefs.name || "the user");
  return {
    role: "system",
    content: [
      chair.instruction,
      "",
      `─── ROOM CONTEXT ───`,
      `Room subject: ${room.subject}`,
      `Tone: ${room.mode}, Intensity: ${room.intensity}`,
      `Directors at the table:`,
      `  · ${directors}`,
      `User: ${youLine}`,
      ...(memoryBlock ? [memoryBlock] : []),
      // Shared materials · output of the chair's `fetch-url` system
      // skill. Sits between room context and task so the chair sees it
      // before being told what to do this turn.
      ...(sharedMaterials ? ["", sharedMaterials] : []),
      "",
      task,
    ].join("\n"),
  };
}

/** Render the recent transcript as alternating user/assistant turns from the
 *  chair's perspective: every prior message is "user" (since the chair has
 *  never spoken in the assistant role yet for this task). */
function renderHistoryForChair(history: Message[], cast: Agent[], prefs: Prefs): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (const m of history) {
    if (!m.body) continue;
    if (m.authorKind === "system") {
      out.push({ role: "user", content: `[system note] ${m.body}` });
      continue;
    }
    if (m.authorKind === "user") {
      out.push({ role: "user", content: `[${prefs.name || "You"}] ${m.body}` });
      continue;
    }
    const who = cast.find((a) => a.id === m.authorId);
    const name = who?.name ?? "Director";
    const handle = who?.handle ?? "/director";
    out.push({ role: "user", content: `[${name} · ${handle}] ${m.body}` });
  }
  // Collapse consecutive user-roles to keep providers happy.
  const collapsed: LLMMessage[] = [];
  for (const m of out) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content;
    else collapsed.push({ ...m });
  }
  return collapsed;
}

/** Chair · clarification turn. Supports multi-turn back-and-forth with
 *  the user before directors are released. The chair either asks ONE
 *  crisp question (its turn count is surfaced in the prompt so it knows
 *  how much budget remains) or returns the literal token READY when
 *  enough context has been gathered. */
interface ClarifyOpts extends ChairBuildOpts {
  /** 1-indexed turn number for THIS clarification step. */
  turnNumber: number;
  /** Hard cap on chair clarify turns enforced by the orchestrator. */
  maxTurns: number;
}
export function buildChairClarifyMessages(opts: ClarifyOpts): LLMMessage[] {
  const remaining = Math.max(0, opts.maxTurns - opts.turnNumber);
  const isFirstTurn = opts.turnNumber === 1;
  const userName = opts.prefs.name || "The user";
  const budgetLine =
    remaining === 0
      ? "You MUST respond with READY now — no more questions allowed."
      : remaining === 1
        ? `You have at most ${remaining} more turn after this — prefer READY unless a load-bearing point is still genuinely unclear.`
        : "Don't drag this out — most subjects need 0–1 questions total.";

  // First turn · structured "moderator intake": Topic restatement +
  // load-bearing ambiguity + 1-2 sharp questions. Replaces the old
  // "one ≤25-word question" prompt which made the chair feel like a
  // chatbot instead of a meeting host. Examples in EN + ZH so the
  // model has a concrete shape regardless of user language.
  const firstTurnTask = [
    `─── YOUR TASK · OPEN THE ROOM ───`,
    `${userName} just opened this room with the subject above. As the Meeting Host, your job at this opening moment is to make sure we have a productive discussion — neither rush directors in nor interrogate the user.`,
    ``,
    `RELEASE PATH · You have ENOUGH context when you can name: (a) the concrete situation, (b) the actual decision being wrestled with, (c) at least one real constraint or stake. If all three are clear from the subject alone, respond with EXACTLY the literal token:`,
    `READY`,
    `(no markdown, no quotes, no period, nothing else)`,
    ``,
    `CLARIFY PATH · If a load-bearing point is genuinely unclear, respond in THREE labeled parts. Match the user's language — Chinese subject → Chinese labels and prose; English → English. Use markdown bold for the section labels exactly as shown. Total response under ~120 words.`,
    ``,
    `English template:`,
    ``,
    `**Topic.** <one short sentence restating the kernel of what they're bringing — do NOT flatter, do NOT thank, do NOT summarise their self-introduction back to them>`,
    ``,
    `**Ambiguity.** <one sentence naming the SPECIFIC missing piece that would change how the directors discuss this — load-bearing only, not generic "tell me more">`,
    ``,
    `**Questions:**`,
    `1. <first sharp question, ≤25 words>`,
    `2. <optional second question, ONLY if a different axis is also genuinely unclear>`,
    ``,
    `中文示例（user 用中文写主题时使用相同结构，labels 也翻译）:`,
    ``,
    `**主题。** <一句话复述用户带来的核心议题>`,
    ``,
    `**关键模糊点。** <一句话指出 *最承重的* 不清楚之处——回答它会改变董事们讨论的方向>`,
    ``,
    `**问题：**`,
    `1. <第一个 sharper 的问题，≤25 字>`,
    `2. <仅当第二个轴向同样关键时才出现>`,
    ``,
    `─── HARD RULES ───`,
    `· Two questions MAX. Most rooms need only ONE. If the second isn't a different axis (just a sub-detail), drop it.`,
    `· Questions must point at the load-bearing gap — not vague "could you tell me more about your background" territory.`,
    `· FORBIDDEN preamble: "Welcome", "Sure", "Great question", "Thank you", "您好", "太棒了", "好的", any greeting or compliment.`,
    `· FORBIDDEN soft-close: "looking forward to", "happy to help", "no rush" — none of that.`,
    `· Use the user's own words for the topic restatement when possible. Never repeat their self-introduction.`,
    `· When you're torn between asking and releasing, lean RELEASE. A stalled opening kills momentum more than a slightly-fuzzy framing — the directors can sharpen with their own questions.`,
    ``,
    `Budget: clarification turn ${opts.turnNumber} of ${opts.maxTurns}. ${budgetLine}`,
    ``,
    `Output: either the 3-part structured block (in the user's language), OR the literal token READY (alone, nothing else).`,
  ].join("\n");

  // Follow-up turn · the user already answered a clarification.
  // Tighter shape: a brief acknowledgment + READY token, OR a 2-part
  // structured block asking ONE more question.
  //
  // The acknowledgment is critical · it's what ${userName} reads to
  // know the chair heard their reply. Without it, the placeholder
  // bubble flashes and disappears and the user feels ignored.
  const followUpTask = [
    `─── YOUR TASK · DECIDE — RELEASE OR ONE MORE QUESTION ───`,
    `${userName} just replied to your prior clarifying question. Decide: do you now have enough context to release the directors, or is ONE more question genuinely worth asking?`,
    ``,
    `RELEASE PATH · When releasing, output a brief acknowledgment FOLLOWED by the literal token READY on its own line. The acknowledgment is what ${userName} sees; READY is a control signal stripped before display.`,
    ``,
    `Format · MATCH ${userName}'s LANGUAGE for the ack:`,
    ``,
    `<one short sentence acknowledging — substantive, not pleasantry>`,
    ``,
    `READY`,
    ``,
    `English ack examples (use the user's actual reply, don't paste these verbatim):`,
    `· "Got it — directors will pick up the entry-vs-exit question with that constraint in mind."`,
    `· "That's the load-bearing piece. Releasing the room with web search live for the recent-events angle."`,
    ``,
    `中文示例（按用户实际回复来组织，不要照抄）:`,
    `· "了解 — directors 会带着这个约束开场。"`,
    `· "这条信息够了，让董事们带着 web search 接力。"`,
    ``,
    `If ${userName}'s reply was a META instruction (e.g. "去搜一下" / "search this first" / "用 web search"), acknowledge briefly and release — directors have web-search built in and will use it when their turn comes.`,
    ``,
    `ONE-MORE-QUESTION PATH · Only if a still-unclear point would MEANINGFULLY change how directors discuss this. Most rooms don't need a second clarifying turn.`,
    ``,
    `English template:`,
    ``,
    `**Still unclear.** <one sentence naming what's still missing and why it matters for the discussion>`,
    ``,
    `**Question.** <one sharp question, ≤25 words>`,
    ``,
    `中文示例:`,
    ``,
    `**仍不清楚。** <一句话说明剩余关键模糊点>`,
    ``,
    `**问题。** <一个最后的问题，≤25 字>`,
    ``,
    `─── HARD RULES ───`,
    `· The acknowledgment must be substantive — reference what the user actually said, not generic "got it".`,
    `· FORBIDDEN soft-close: "happy to help", "looking forward", trailing pleasantry.`,
    `· FORBIDDEN: outputting bare READY alone with no acknowledgment line above. Always pair them.`,
    `· If you're torn between asking and releasing, lean RELEASE.`,
    `· One question only — if multiple things still feel unclear, that's a sign you should release and let the directors surface them.`,
    ``,
    `Budget: clarification turn ${opts.turnNumber} of ${opts.maxTurns}. ${budgetLine}`,
    ``,
    `Output: either <ack + blank line + READY> OR the 2-part question block (in the user's language).`,
  ].join("\n");

  return [
    buildChairSystem(opts, isFirstTurn ? firstTurnTask : followUpTask),
    ...renderHistoryForChair(opts.history, opts.cast, opts.prefs),
    {
      role: "user",
      content: isFirstTurn
        ? "Open the room — output either the 3-part structured block (in my language) or the literal token READY."
        : "Your move — output either the 2-part structured block (in my language) or the literal token READY.",
    },
  ];
}

/** Chair · convening speech. Posted right after the auto-picker has
 *  seated 3 directors, before the chair runs its clarify turn. The
 *  speech explains in the chair's voice WHY each director was picked
 *  for this specific subject — gives the user authoritative context
 *  for the cast and reinforces that the chair is acting intentionally,
 *  not randomly assembling a panel. */
interface ConveningOpts extends ChairBuildOpts {
  /** Per-director rationales captured from the picker's haiku call. */
  picksWithReasons: Array<{ agent: Agent; reason: string }>;
  /** The picker's overall rationale (≤ 80 chars). May be empty. */
  pickerRationale: string;
}
export function buildChairConveningMessages(opts: ConveningOpts): LLMMessage[] {
  const subject = opts.room.subject;
  const directorList = opts.picksWithReasons
    .map((p, i) => {
      const a = p.agent;
      const bio = (a.bio || "").trim().replace(/\s+/g, " ").slice(0, 220);
      const tag = (a.roleTag || "director").toLowerCase();
      return [
        `${i + 1}. ${a.name} (${a.handle}) · ${tag}`,
        `   bio: ${bio}`,
        p.reason ? `   picker note: ${p.reason}` : "",
      ].filter(Boolean).join("\n");
    })
    .join("\n");

  const seatedNames = opts.picksWithReasons.map((p) => p.agent.name);
  const seatedJoinBold = seatedNames.map((n) => `**${n}**`).join(" · ");
  const seatedJoinPlain = seatedNames.join(" · ");
  const seatedCountWord = String(seatedNames.length);

  const task = [
    `─── YOUR TASK · INTRODUCE THE CAST ───`,
    `You just convened a board for the user's subject. ${seatedCountWord} directors have taken their seats. Your job is a SHORT speech (3–4 sentences, ~80 words) that opens with a CLEAR enumeration of who you picked and follows with WHY — in your own voice.`,
    ``,
    `Subject the room will discuss:`,
    subject,
    ``,
    `Directors you've seated (USE THESE EXACT NAMES — NEVER invent or substitute):`,
    directorList,
    ``,
    opts.pickerRationale ? `Overall picker rationale: ${opts.pickerRationale}` : "",
    ``,
    `─── REQUIRED FORMATTING ───`,
    `EVERY occurrence of a director's name MUST be wrapped in markdown bold: \`**Name**\`. This applies to the opening enumeration AND any later sentence that mentions a director. Bare names without \`**...**\` are NOT acceptable.`,
    ``,
    `─── REQUIRED OPENING (first sentence) ───`,
    `Sentence 1 MUST name the cast you just seated, using the exact names above with the \`**...**\` wrap. Acceptable shapes:`,
    `· English · "For this, I've convened ${seatedJoinBold}."  /  "I've seated ${seatedJoinBold} for this subject."`,
    `· 中文   · "针对这个话题，我请来了 ${seatedJoinBold}。"  /  "我为这场会议挑了 ${seatedJoinBold}。"`,
    `Pick whichever phrasing reads natural in the user's language. The names must appear verbatim (the plain spelling is ${seatedJoinPlain}), joined by " · " or by ", " / "、", each wrapped in \`**...**\`. Do NOT abbreviate, translate, or merge them.`,
    ``,
    `─── REST OF THE SPEECH (sentences 2–4) ───`,
    `· Sentence 2 (and optionally 3) · for each named director, give the SPECIFIC angle they bring to THIS subject. Reference their actual method (the bio's load-bearing verb), not a generic compliment ("brings expertise" is forbidden). Re-state each name as \`**Name**\` when you mention it.`,
    `· Final sentence · the lens-coverage the cast creates together — what the user gets from THIS combination.`,
    ``,
    `─── HARD RULES ───`,
    `· Match the user's language (zh / en).`,
    `· **NEVER** invent a director, paraphrase a name, or import a name from the subject (e.g. if the subject mentions "Marc Andreessen", do NOT seat him — only the names in the list above are at the table).`,
    `· FORBIDDEN preamble: "Welcome", "Great subject", "I'm happy to", "Let's", "您好", "好的". Lead with the cast announcement.`,
    `· FORBIDDEN flattery: "perfect choice", "exceptional", "world-class". Plain prose only.`,
    `· No bullet lists. No headers. Continuous prose, 3–4 sentences total.`,
    `· Do NOT ask the user a question — that's the next turn's job. This message ONLY sets the table.`,
    `· Use *italics* sparingly for load-bearing METHOD verbs (not names · names use bold).`,
    ``,
    `Output: just the speech body. No quotes, no labels.`,
  ].join("\n");

  return [
    buildChairSystem(opts, task),
    {
      role: "user",
      content: `Introduce the cast for this subject — 3-4 sentences, your voice, in my language.`,
    },
  ];
}

/** Chair · round-end summary + 3 key points. The frontend parses the
 *  POINTS: block to render vote chips. */
export function buildChairRoundEndMessages(opts: ChairBuildOpts): LLMMessage[] {
  const task = [
    `─── YOUR TASK · CLOSE THIS ROUND ───`,
    `The directors have just completed one full round on this subject. Your job has two parts:`,
    ``,
    `1) Write a single 1-sentence acknowledgment ping (under 25 words). State what just happened in the room. Plain prose, no italics, no opinions.`,
    ``,
    `2) Then a blank line, then output exactly three key points the user might want to dig into next or drop. Each point is a SPECIFIC assertion or open question that surfaced this round — not a generic theme. Use the directors' own language.`,
    ``,
    `Format strictly:`,
    `<your 1-sentence ping>`,
    ``,
    `POINTS:`,
    `- <point 1, ≤ 18 words>`,
    `- <point 2, ≤ 18 words>`,
    `- <point 3, ≤ 18 words>`,
    ``,
    `Do not write a fourth point. Do not add commentary after the list.`,
  ].join("\n");
  return [
    buildChairSystem(opts, task),
    ...renderHistoryForChair(opts.history, opts.cast, opts.prefs),
    {
      role: "user",
      content: `Close the round — your one-sentence ping, then the POINTS block.`,
    },
  ];
}

/** Chair · direct response to a user @chair mention. The user has
 *  interrupted the director queue to ask the chair a meta question
 *  about the discussion's structure. Strict scope: ONLY observations
 *  about HOW the room is moving (convergence · divergence · who
 *  hasn't really engaged · contested load-bearing terms · current
 *  framing tensions). NOT content opinions, NOT decision recommendations
 *  — that's the directors' job, never the chair's. */
export function buildChairDirectMessages(opts: ChairBuildOpts): LLMMessage[] {
  const userName = opts.prefs.name || "the user";
  const task = [
    `─── YOUR TASK · DIRECT RESPONSE TO ${userName} ───`,
    `${userName} just interrupted the room to ask you a question. The directors have paused; you answer briefly, then directors resume.`,
    ``,
    `Your role here is the meeting host's META layer — observations about the discussion's STRUCTURE, not its CONTENT:`,
    `· Where directors have converged (and via what reasoning paths).`,
    `· The single load-bearing tension that hasn't fully resolved.`,
    `· Who hasn't engaged with their distinctive lens yet (e.g. "Long Horizon hasn't pushed back from the structural angle").`,
    `· Contested terms whose definitions are still slippery.`,
    `· Whether the room's pace is productive or circling.`,
    ``,
    `─── HARD RULES ───`,
    `· Length: 3–4 sentences, ~60–100 words. Tight. Authoritative. No padding.`,
    `· Match ${userName}'s language exactly · Chinese question → Chinese reply; English → English. Never mix.`,
    `· FORBIDDEN: opinions on the substantive question (don't say "I think AI moats matter because…"). That's the directors' lens, never yours.`,
    `· FORBIDDEN: decision recommendations ("you should X", "I'd lean toward Y"). The chair never tells ${userName} what to decide.`,
    `· FORBIDDEN: speaking on behalf of any director ("Marc would say…"). Refer to what they DID say, not what they think.`,
    `· FORBIDDEN: greeting / preamble / soft-close ("Good question", "Hope this helps", "您好"). Direct prose only.`,
    `· FORBIDDEN: bullet lists, headings, numbered points. Plain prose.`,
    `· When ${userName}'s question wanders into territory that's a director's job (e.g. "what should I do?" or "is X right?"), redirect cleanly: name what's still unresolved and which director's lens would be the productive next push.`,
    ``,
    `Output: 3–4 sentences, in ${userName}'s language. No structure markers. Nothing else.`,
  ].join("\n");
  return [
    buildChairSystem(opts, task),
    ...renderHistoryForChair(opts.history, opts.cast, opts.prefs),
    {
      role: "user",
      content: `Answer ${userName}'s @chair question · meta-observation only, in their language.`,
    },
  ];
}

/** Parse the chair's round-end output into a ping + 3 key-point bodies.
 *  Returns the points in order; the ping is whatever came before POINTS:. */
export function parseRoundEndOutput(text: string): { ping: string; points: string[] } {
  const idx = text.search(/POINTS\s*:/i);
  if (idx < 0) return { ping: text.trim(), points: [] };
  const ping = text.slice(0, idx).trim();
  const block = text.slice(idx).replace(/^POINTS\s*:\s*/i, "");
  const points: string[] = [];
  for (const line of block.split("\n")) {
    const m = /^\s*[-*•]\s+(.+?)\s*$/.exec(line);
    if (m && m[1]) points.push(m[1]);
    if (points.length >= 3) break;
  }
  return { ping, points };
}
