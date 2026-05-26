/**
 * Skill router · Pass-1 of the two-pass turn.
 *
 * Given a speaker's installed skills + the recent conversation, ask a
 * cheap LLM to pick which skills (if any) apply this turn. Output is
 * strict JSON: { use: ["slug", ...], reason: "..." }.
 *
 * Design notes
 * - Picker is best-effort. If the LLM call fails, returns no picks
 *   (caller falls through to a normal single-pass turn).
 * - We hard-cap to 2 picks so the router can't bloat Pass-2 by
 *   selecting every available skill.
 * - The cheap model is fixed to `haiku-4-5`; if that key isn't
 *   configured, falls back to the speaker's own model so picking
 *   still works (just costs a bit more).
 */
import { callLLM, NoKeyError, type LLMMessage } from "../ai/adapter.js";
import { getAgent, type Agent } from "../storage/agents.js";
import type { Message } from "../storage/messages.js";
import type { AgentSkill } from "../storage/skills.js";
import type { ModelV } from "../ai/registry.js";
import { utilityModelFor } from "../ai/availability.js";
import { WEB_SEARCH_SLUG } from "../skills/system-skills.js";
import { detectRoomLang, languageLockBlock } from "./prompt.js";

/** Pick the cheapest reachable model for routing decisions. Thin
 *  delegate over `utilityModelFor()` (availability.ts) — same call,
 *  same active-carrier-first rule + UTILITY_PREFERENCE fallback +
 *  any-reachable last resort. Kept as a named function so the call
 *  sites read as "router model" semantically and future router-only
 *  divergence (e.g. honouring a per-call temperature ceiling) has a
 *  clean seam.
 *
 *  Earlier this file maintained its own carrier→cheap-model map and
 *  returned null on miss. That diverged from `utilityModelFor()`
 *  several times — the two resolvers silently disagreed on what a
 *  given carrier's cheap tier was, and a missing carrier entry
 *  bypassed the fallback chain entirely (skill picker fell through
 *  to the speaker's flagship instead of any-reachable cheap model). */
function pickRouterModel(): ModelV | null {
  return utilityModelFor();
}

/** Render a human-readable speaker label for a transcript line fed to a
 *  picker LLM. Falls back through cast → DB → role-kind tag so we never
 *  hand the model a raw author id — those leak straight into the picker's
 *  `intervention` / `rationale` text, which is posted to the room. */
function authorLabel(m: Message, cast?: Agent[]): string {
  if (m.authorKind === "user") return "USER";
  if (m.authorKind === "system") return "system";
  if (!m.authorId) return m.authorKind === "agent" ? "director" : m.authorKind;
  const fromCast = cast?.find((a) => a.id === m.authorId);
  if (fromCast) return `${fromCast.name} (${fromCast.handle})`;
  const a = getAgent(m.authorId);
  if (a) {
    const kindTag = a.roleKind === "moderator" ? "chair" : "director";
    return `${a.name} (${a.handle}, ${kindTag})`;
  }
  return m.authorKind === "agent" ? "director" : m.authorKind;
}

const MAX_PICKS = 2;

export interface SkillPickResult {
  used: AgentSkill[];
  reason: string;
  /** When the speaker has web-search available (key + per-agent flag),
   *  the router can return a search query to run before this turn.
   *  null means "no search needed for this turn" — a useful 0-cost
   *  decision that prevents Brave calls on philosophical questions. */
  webSearchQuery: string | null;
}

/** Chair-side clarify gate · cheap haiku call that decides whether the
 *  chair needs to ask a clarifying question on the FIRST turn after a
 *  room opens, or whether the user's subject is already self-sufficient
 *  enough to release directors immediately.
 *
 *  This is the discipline lever for the chair's clarify primitive — same
 *  shape as the web-search router (yes/no + rationale), so we don't burn
 *  a full chair LLM call on subjects that are already clear enough to
 *  open. Returns shouldAsk=false to short-circuit to READY, true to fall
 *  through to the structured chair clarify prompt as before.
 *
 *  Failures default to shouldAsk=true (safe path — keep existing
 *  behaviour rather than silently skipping clarification). */
export interface ChairClarifyDecision {
  /** True = run the chair's structured clarify prompt as today.
   *  False = the subject is self-sufficient; emit READY without an LLM
   *  round-trip and release directors. */
  shouldAsk: boolean;
  /** ≤120 chars — why this call. Logged + surfaced in chair turn meta
   *  for telemetry. Empty string when the call fails. */
  rationale: string;
}

export async function pickChairClarifyDecision(opts: {
  history: Message[];
  signal?: AbortSignal;
}): Promise<ChairClarifyDecision> {
  const prompt = latestUserPrompt(opts.history);
  // No user prompt yet → don't gate; the clarify call won't fire anyway.
  if (!prompt) return { shouldAsk: true, rationale: "no user prompt yet" };

  const sys: LLMMessage = {
    role: "system",
    content: [
      "You are the boardroom chair's clarify gate. You make ONE cheap binary",
      "decision: should the chair ask a clarifying question before releasing",
      "directors, or is the user's subject already self-sufficient?",
      "",
      "RELEASE (ask=false) when the subject already names:",
      "  · the concrete situation,",
      "  · the actual decision being wrestled with, AND",
      "  · at least one real constraint or stake.",
      "",
      "ASK (ask=true) only when a load-bearing piece is genuinely missing —",
      "the kind of ambiguity that would make 3 directors pull in different",
      "directions. Examples: 'help me decide' with no decision named, a",
      "topic so abstract no concrete situation grounds it, a question with",
      "two incompatible interpretations.",
      "",
      "Bias toward RELEASE. A slightly-fuzzy framing is fine — directors",
      "can sharpen it themselves. Asking when you don't need to kills",
      "momentum.",
      "",
      "Reply with STRICT JSON ONLY (no prose, no fences):",
      "{ \"ask\": true,  \"rationale\": \"≤120 chars · what's load-bearingly missing\" }",
      "{ \"ask\": false, \"rationale\": \"≤120 chars · why the subject is self-sufficient\" }",
    ].join("\n"),
  };

  const userMsg: LLMMessage = {
    role: "user",
    content: `Latest user message (the room subject):\n${prompt}\n\nDoes the chair need to ask a clarifying question before opening the room?`,
  };

  const routerModel = pickRouterModel();
  if (!routerModel) {
    // No key configured for any router-eligible carrier · keep the
    // existing chair clarify call running (safe path).
    return { shouldAsk: true, rationale: "" };
  }
  let raw = "";
  try {
    raw = await callLLM({
      modelV: routerModel,
      messages: [sys, userMsg],
      temperature: 0,
      maxTokens: 120,
      signal: opts.signal,
    });
  } catch (e) {
    if (!(e instanceof NoKeyError)) {
      process.stderr.write(
        `[chair-clarify-gate] failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    // Default to the safe path on failure — keep the existing chair
    // clarify call running rather than silently skipping clarification.
    return { shouldAsk: true, rationale: "" };
  }

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return { shouldAsk: true, rationale: "" };
  }
  const obj = parsed as { ask?: unknown; rationale?: unknown };
  const ask = obj.ask !== false; // truthy coercion · only literal `false` flips to skip
  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim().slice(0, 200) : "";
  return { shouldAsk: ask, rationale };
}

/** Chair-side round-wrap picker · cheap haiku call at round boundaries
 *  that recommends End-the-round vs Continue, based on whether the
 *  round has covered the load-bearing tensions or there's still
 *  productive ground to cover with another reactive sweep.
 *
 *  This is the chair's Synthesis primitive — instead of auto-ending
 *  (which takes control away from the user) we surface a recommendation
 *  on the round-prompt the user is about to act on. User still picks
 *  End or Continue; the chair just nudges with rationale.
 *
 *  Calibration: bias-to-continue early (rounds 1–2 usually need more
 *  reactive turns), bias-to-end after round 3+ (diminishing returns
 *  unless dialogue is still actively diverging). Failure → "continue"
 *  default — never accidentally push the user toward ending. */
export type RoundWrapRecommendation = "end" | "continue";
export interface RoundWrapDecision {
  recommendation: RoundWrapRecommendation;
  /** ≤120 chars · why this call, in one tight sentence. Surfaced in the
   *  round-prompt body so the user reads the chair's reasoning before
   *  pressing the button — keep it terse so the wrap doesn't read as
   *  a wall of text. */
  rationale: string;
}

export async function pickRoundWrap(opts: {
  history: Message[];
  roundNum: number;
  /** Optional room reference · when present, the rationale's language
   *  is locked to `room.subject` via the LANGUAGE LOCK appended to the
   *  system prompt. Optional so existing test paths keep working; in
   *  production the orchestrator always passes it. */
  room?: { subject?: string | null };
  signal?: AbortSignal;
}): Promise<RoundWrapDecision> {
  const { history, roundNum, room, signal } = opts;

  const transcript = history
    .slice(-20)
    .filter((m) => {
      if (!m.body || !m.body.trim()) return false;
      const meta = m.meta as { kind?: string } | undefined;
      if (meta?.kind === "tool-use" || meta?.kind === "tool-preamble") return false;
      if (meta?.kind === "round-open" || meta?.kind === "round-prompt") return false;
      return true;
    })
    .map((m) => `[${authorLabel(m)}] ${m.body.trim().slice(0, 600)}`)
    .join("\n\n");

  const sys: LLMMessage = {
    role: "system",
    content: [
      "You are the boardroom chair's round-wrap evaluator. A reactive",
      "round just finished; the user is about to choose End-round (file",
      "key points + maybe adjourn to a brief) or Continue (another",
      "reactive sweep). You make ONE recommendation.",
      "",
      "RECOMMEND END when:",
      "  · The load-bearing tensions are surfaced and named.",
      "  · Directors have stopped adding new lenses (the next round would",
      "    repeat patterns already in the transcript).",
      "  · Round number is high (3+) and dialogue feels structurally complete.",
      "",
      "RECOMMEND CONTINUE when:",
      "  · A specific tension was named but not actually pushed on yet.",
      "  · Directors are mid-disagreement on a load-bearing claim.",
      "  · It's round 1 or 2 and the divergence is still genuine.",
      "  · A director said something that demands a counter-argument no",
      "    one has yet provided.",
      "",
      "Calibration: be conservative. Pushing the user toward End when",
      "there's still substantive ground to cover is worse than letting",
      "them run one more round. When in doubt, recommend CONTINUE.",
      "",
      "Rationale style: ONE tight sentence, ≤120 chars. Name the load-",
      "bearing reason — no preamble, no \"the room has\", no hedges. Vary",
      "your phrasing across calls; don't lean on the same opener twice.",
      "",
      "Reply with STRICT JSON ONLY (no prose, no fences):",
      "{ \"recommendation\": \"end\" | \"continue\", \"rationale\": \"≤120 chars · one tight sentence on the load-bearing reason\" }",
      // Target-language LANGUAGE LOCK · the rationale must be in the
      // room's working language so the round-prompt the chair posts
      // afterwards is consistent with the rest of a zh / en room.
      // Appended at the tail of the system prompt (recency bias).
      ...(room ? [languageLockBlock(detectRoomLang(room))] : []),
    ].join("\n"),
  };

  const userMsg: LLMMessage = {
    role: "user",
    content: [
      `Round just finished: ${roundNum}`,
      ``,
      `Transcript:`,
      transcript || "(empty — should not happen at round wrap)",
      ``,
      `Recommend End or Continue.`,
    ].join("\n"),
  };

  const routerModel = pickRouterModel();
  if (!routerModel) {
    return { recommendation: "continue", rationale: "" };
  }
  let raw = "";
  try {
    raw = await callLLM({
      modelV: routerModel,
      messages: [sys, userMsg],
      temperature: 0,
      maxTokens: 200,
      signal,
    });
  } catch (e) {
    if (!(e instanceof NoKeyError)) {
      process.stderr.write(
        `[round-wrap] failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    // Failure default: continue. We never accidentally push the user
    // toward ending — that's a destructive action.
    return { recommendation: "continue", rationale: "" };
  }

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return { recommendation: "continue", rationale: "" };
  }
  const obj = parsed as { recommendation?: unknown; rationale?: unknown };
  const rec: RoundWrapRecommendation = obj.recommendation === "end" ? "end" : "continue";
  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim().slice(0, 160) : "";
  return { recommendation: rec, rationale };
}

/** Chair-side next-speaker picker · cheap haiku call that picks WHICH
 *  queued director should speak next in a reactive round, based on
 *  whose lens most sharply addresses the unresolved tension in the
 *  previous turn. Only fires when the queue has ≥ 2 candidates and at
 *  least one director has already spoken in this round (so there's a
 *  prior turn to react to).
 *
 *  Falls back to round-robin (returns agentId=null) when:
 *   · the call fails / no key,
 *   · the model returns an unrecognised agentId,
 *   · the response can't be parsed.
 *
 *  This is the discipline lever for the chair's next-speaker primitive
 *  — every reactive turn after the first becomes a deliberate moderator
 *  decision rather than mechanical round-robin order. Cost: ~$0.001
 *  per pick, only on reactive rounds with multiple remaining speakers. */
export interface NextSpeakerPick {
  /** agentId chosen from the candidates, or null to leave queue order
   *  unchanged (round-robin fallback). */
  agentId: string | null;
  /** ≤120 chars · why this lens fits the next move. Logged for telemetry
   *  + surfaced in the speaker turn's meta so the UI can show "Chair
   *  picked X because Y" on hover. */
  rationale: string;
  /** Optional frame-correction note · 1-2 sentences. Set when the picker
   *  detects a substantive misalignment in the prior turns (talking past
   *  each other, undefined load-bearing term, circling without progress,
   *  hidden trade-off). Bias is to skip — null is the common case.
   *  When present, the orchestrator posts it as a chair message before
   *  the picked director speaks, named "intervention" in meta. */
  intervention: string | null;
}

export async function pickNextSpeaker(opts: {
  candidates: Agent[];
  history: Message[];
  /** Optional room reference · when present, room.subject is surfaced
   *  in the user message as the canonical language signal AND a
   *  target-language LANGUAGE LOCK is appended to the system prompt.
   *  Without this, the picker would only see "recent transcript" —
   *  which can be polluted by past English director output and cause
   *  the chair-note intervention to drift to English in a Chinese
   *  room. Optional so callers can opt in gradually. */
  room?: { subject?: string | null };
  /** Layer 2.1 · picker mode. Default "lens-gap" matches the
   *  historical behaviour (find the director whose lens addresses
   *  the unresolved tension). "dissent-gap" is the divergence-stack
   *  variant · find the director MOST LIKELY to break the room's
   *  current frame, scored on the persona's contrarianTakes /
   *  failureModes against the room's recent fixation. Caller (room.ts)
   *  flips to dissent-gap when convergence detection (Layer 2.3)
   *  fires OR every Nth reactive round as a divergence guarantee. */
  mode?: "lens-gap" | "dissent-gap";
  /** When `mode === "dissent-gap"`, the convergent terms detected
   *  by the frame-break / convergence layer are surfaced to the
   *  picker so it can score each candidate against them. Empty
   *  array → picker falls back to lens-gap behaviour for this turn. */
  convergentTerms?: string[];
  signal?: AbortSignal;
}): Promise<NextSpeakerPick> {
  const { candidates, history, room, signal } = opts;
  const mode = opts.mode === "dissent-gap" ? "dissent-gap" : "lens-gap";
  const convergentTerms = (opts.convergentTerms || []).filter(Boolean);
  if (candidates.length < 2) return { agentId: null, rationale: "", intervention: null };

  // Build the candidate roster. We include role tag + bio so the picker
  // can match lens to the previous turn's gap, not just remember names.
  // In dissent-gap mode we ALSO surface up to 3 contrarianTakes per
  // candidate (when persona-spec is available) so the picker can score
  // who's most likely to disrupt the convergent frame.
  const roster = candidates
    .map((a) => {
      const baseRow = `- ${a.id} · ${a.name} (${a.handle}) · ${a.roleTag}\n  ${a.bio}`;
      if (mode !== "dissent-gap") return baseRow;
      const takes = a.personaSpec?.spec?.contrarianTakes?.slice(0, 3) || [];
      const failures = a.personaSpec?.spec?.failureModes?.slice(0, 1) || [];
      const extras: string[] = [];
      if (takes.length > 0) extras.push(`  · contrarian takes: ${takes.join(" · ")}`);
      if (failures.length > 0) extras.push(`  · failure mode: ${failures[0]}`);
      return extras.length > 0 ? `${baseRow}\n${extras.join("\n")}` : baseRow;
    })
    .join("\n");

  // Recent transcript · last ~10 messages with handle + body. Enough
  // context to see the dialogue's current direction without bloating
  // the haiku prompt. Skip system messages and tool-use rows; keep
  // user, chair, and director turns.
  const transcript = history
    .slice(-12)
    .filter((m) => {
      if (!m.body || !m.body.trim()) return false;
      const meta = m.meta as { kind?: string } | undefined;
      // Skip tool-use UI rows + chair structural pings.
      if (meta?.kind === "tool-use" || meta?.kind === "tool-preamble") return false;
      if (meta?.kind === "round-open" || meta?.kind === "round-prompt") return false;
      return true;
    })
    .map((m) => `[${authorLabel(m, candidates)}] ${m.body.trim().slice(0, 600)}`)
    .join("\n\n");

  const decision1Block = mode === "dissent-gap"
    ? [
        "DECISION 1 · Next speaker (DISSENT-GAP MODE).",
        "The room is converging on a single frame — for THIS pick, the chair",
        "needs the director MOST LIKELY to break that frame. Score each",
        "candidate on:",
        "  · Their `contrarian takes` (listed in the roster) versus the room's",
        "    detected convergent terms (surfaced in the user message below).",
        "    Pick whose stated contrarian moves DIRECTLY puncture the cluster.",
        "  · Their `failure mode` is a NEGATIVE signal — a director whose",
        "    failure mode is 'gets sucked into specifics' is exactly who you",
        "    do NOT pick when the room is already lost in specifics.",
        "  · Lens distance from the convergent frame · pick a lens furthest",
        "    from the cluster's gravitational center.",
        "  · Recency · prefer directors who haven't spoken in the last 2 turns",
        "    when scores are comparable.",
        "  · If NO candidate is clearly the frame-breaker (e.g. all candidates",
        "    have already been used recently OR none have relevant contrarian",
        "    takes), set agent_id=null and let round-robin run.",
      ].join("\n")
    : [
        "DECISION 1 · Next speaker. From the candidates below, pick which",
        "director should speak NEXT — the one whose lens most sharply",
        "addresses the unresolved tension, hidden assumption, or missing",
        "counter-argument in the previous turn.",
        "  · Match LENS to the gap, not just topic relevance. If the prior",
        "    turn made a structural claim, pick a director whose role",
        "    pushes back from a different lens (data → narrative,",
        "    empirical → first-principles, etc.).",
        "  · Prefer directors who haven't been quoted yet THIS round when",
        "    fits are comparable — diversity of voice.",
        "  · If no candidate clearly fits better than the current head of",
        "    queue, set agent_id=null and let round-robin run.",
      ].join("\n");

  const sys: LLMMessage = {
    role: "system",
    content: [
      "You are the boardroom chair's pre-turn moderator. The room is in",
      "a reactive round; one director just finished. You make TWO",
      "decisions in one pass.",
      "",
      decision1Block,
      "",
      "DECISION 2 · Intervention (optional · default: null). Read the",
      "prior 2–3 turns. Drop a 1-sentence chair note ONLY if a substantive",
      "misalignment is making the room less productive — and only one of",
      "these patterns:",
      "  · Talking past each other · two directors are using the same",
      "    word for different things (e.g. one says 'moat' meaning data,",
      "    the other meaning licenses — neither has named the difference).",
      "  · Undefined load-bearing term · a key claim hinges on a word",
      "    nobody has defined (e.g. 'engagement', 'AI-native').",
      "  · Hidden trade-off · two directors agree on the surface but are",
      "    silently making opposing assumptions about cost/timing/scale.",
      "  · Circling · 2+ turns repeating without advancing.",
      "Otherwise leave intervention=null. Bias HEAVILY to skip. False",
      "interventions feel preachy. The room's voice is the directors',",
      "not yours. Most reactive turns get no intervention.",
      "",
      "If you DO intervene: 1 sentence, neutral moderator voice, name",
      "the SPECIFIC pattern + the load-bearing piece worth pinning down.",
      "No greeting, no signature.",
      "",
      "NAMING · When `intervention` or `rationale` references a director,",
      "use their DISPLAY NAME (the part before the parenthesis in the",
      "roster — e.g. \"Maya\", not \"fk7wvt1bep62\"). The opaque id is for",
      "the `agent_id` JSON field ONLY; it must NEVER appear inside any",
      "user-facing prose text. The transcript above labels speakers by",
      "name already; mirror that format.",
      "",
      "LANGUAGE · the chair note must follow the room's DOMINANT",
      "language detected from the recent transcript (most recent",
      "messages weight highest). If most directors and the user are",
      "speaking Chinese, your intervention is CHINESE. If English,",
      "ENGLISH. Never default to English just because this prompt is",
      "in English. Never mix languages inside a single intervention.",
      "",
      "Reply with STRICT JSON ONLY (no prose, no fences):",
      "{",
      "  \"agent_id\": \"<exact id from roster>\" | null,",
      "  \"rationale\": \"≤120 chars · why this lens fits next\",",
      "  \"intervention\": \"≤200 chars · the one-sentence note\" | null",
      "}",
      // Target-language LANGUAGE LOCK · the intervention must match
      // the room's working language. Earlier "detect from transcript"
      // wording was unreliable in feedback-loop scenarios (one past
      // English director turn would re-bias the detector). Locked to
      // room.subject via the helper. Appended at the tail (recency).
      ...(room ? [languageLockBlock(detectRoomLang(room))] : []),
    ].join("\n"),
  };

  const userMsg: LLMMessage = {
    role: "user",
    content: [
      // Surface room.subject at the TOP of the user message so the
      // picker has the canonical language signal alongside the
      // candidate roster + transcript. Without this, the prompt's
      // only language signal was "recent transcript" — which a
      // single English chair drift could pollute.
      ...(room?.subject ? [`Room subject: ${room.subject}`, ``] : []),
      ...(mode === "dissent-gap" && convergentTerms.length > 0
        ? [
            `Detected convergent terms (room is over-investing here · the dissent pick should puncture these):`,
            ...convergentTerms.map((t) => `  · "${t}"`),
            ``,
          ]
        : []),
      `Candidates (queued, in current order):`,
      roster,
      ``,
      `Recent transcript:`,
      transcript || "(no prior turns yet — should not happen for next-speaker pick)",
      ``,
      `Pick the next speaker, and decide whether an intervention is warranted.`,
    ].join("\n"),
  };

  const routerModel = pickRouterModel();
  if (!routerModel) return { agentId: null, rationale: "", intervention: null };
  let raw = "";
  try {
    raw = await callLLM({
      modelV: routerModel,
      messages: [sys, userMsg],
      temperature: 0,
      // Bumped from 160 to 320 · response now carries optional 1-sentence
      // intervention text in addition to the pick + rationale.
      maxTokens: 320,
      signal,
    });
  } catch (e) {
    if (!(e instanceof NoKeyError)) {
      process.stderr.write(
        `[next-speaker] failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    return { agentId: null, rationale: "", intervention: null };
  }

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return { agentId: null, rationale: "", intervention: null };
  }
  const obj = parsed as { agent_id?: unknown; rationale?: unknown; intervention?: unknown };
  const validIds = new Set(candidates.map((c) => c.id));
  const id = typeof obj.agent_id === "string" && validIds.has(obj.agent_id)
    ? obj.agent_id
    : null;
  const rationale = typeof obj.rationale === "string"
    ? replaceLeakedIds(obj.rationale.trim(), candidates).slice(0, 200)
    : "";
  // Intervention · accept only meaningful strings; trim, cap length,
  // discard empty / "null" / "none" so the prompt's "default null" path
  // works even when the model emits a string literal instead of JSON null.
  let intervention: string | null = null;
  if (typeof obj.intervention === "string") {
    const t = replaceLeakedIds(obj.intervention.trim(), candidates);
    if (t.length > 0 && t.toLowerCase() !== "null" && t.toLowerCase() !== "none") {
      intervention = t.slice(0, 280);
    }
  }
  return { agentId: id, rationale, intervention };
}

/** Last-line defense · replace any raw agent id the picker still emits
 *  inside `intervention` / `rationale` with the agent's display name.
 *  The prompt + name-rendered transcript stop ~all leaks, but the haiku
 *  router occasionally still types an id from the candidate roster — and
 *  that text gets posted verbatim to the room. We look up the id against
 *  the live agent store (covers chair + dropped directors too, not just
 *  current candidates) and substitute. Unknown id-shaped tokens fall
 *  through unchanged. */
function replaceLeakedIds(text: string, candidates: Agent[]): string {
  if (!text) return text;
  // newId() alphabet: 0-9 a-h j k m n p q r s t v w x y z · length 12.
  // The negative lookbehind/ahead keep us from chewing into longer slugs.
  return text.replace(/(?<![A-Za-z0-9])[0-9a-hjkmnpqrstvwxyz]{12}(?![A-Za-z0-9])/g, (id) => {
    const fromCast = candidates.find((c) => c.id === id);
    if (fromCast) return fromCast.name;
    const a = getAgent(id);
    if (a) return a.name;
    return id;
  });
}

/** Pre-stream chair-side router · cheap haiku call that decides
 *  whether the chair should run a web search before its next reply.
 *  The chair has no installed-skill toolbox (its tool repertoire is
 *  hard-wired: fetch-url, web-search, etc.), so we don't need the full
 *  skill picker — just the search-or-not branch. Returns a query
 *  string when the latest user message would benefit from fresh web
 *  results, null otherwise.
 *
 *  Best-effort · failures → null (chair proceeds without search).
 *  Conservative by default · the prompt asks the model to skip search
 *  on philosophical / first-principles / pure-reasoning questions so
 *  Brave queries don't burn on every chair turn. */
export async function pickChairWebSearch(opts: {
  history: Message[];
  signal?: AbortSignal;
}): Promise<string | null> {
  const prompt = latestUserPrompt(opts.history);
  if (!prompt) return null;

  const currentYear = new Date().getFullYear();

  const sys: LLMMessage = {
    role: "system",
    content: [
      `Today's date is ${new Date().toISOString().slice(0, 10)} · the CURRENT year is ${currentYear}.`,
      `When the user asks for "latest" / "最新" / "recent" / "现在" anything, "latest"`,
      `means right now — anchor the query with the CURRENT MONTH, not just year.`,
      `Use "${currentYear}年${new Date().getMonth() + 1}月" for CJK queries or`,
      `"${new Date().toLocaleString("en-US", { month: "long" })} ${currentYear}" for English`,
      `queries. Year-alone is too coarse · "${currentYear}" alone lets year-old articles`,
      `outrank today's news. NEVER use an older year (e.g. "2024") when ${currentYear} is current.`,
      "",
      "You are the boardroom chair's pre-turn search router. You decide ONE thing:",
      "should the chair run a web search before its next reply, and if so what query.",
      "",
      "STRONG-SEARCH signals (pick one of these → ALWAYS issue a query):",
      "- Time markers: 'today' / 'this week' / 'this month' / 'recent' / 'recently' /",
      "  'latest' / 'just' / 'now' / '今天' / '最近' / '本周' / '本月' / '刚刚' /",
      "  '现在' / '目前'.",
      "- Verbs of recent action: 'released' / 'launched' / 'announced' / 'shipped' /",
      "  'reported' / 'filed' / '发布' / '推出' / '宣布' / '上线' / '披露'.",
      "- Specific named events / products / numbers / prices that the model can't",
      `  reliably know from training (CES ${currentYear}, model launches, IPO numbers, ARR figures,`,
      "  raise sizes, market caps).",
      "- A specific person's PUBLIC statements / posts (X/Twitter, blog, interviews)",
      "  asked about by name.",
      "- Explicit search verbs: 'search', 'look up', '查一下', '搜索', '搜一下'.",
      "- The user META-INSTRUCTS the chair to search ('go search this' / '你去搜一下' /",
      "  '用 web search 看看' / '涉及实事，搜索一下') — even when no time marker is",
      "  in the literal sentence. Pull the topic from the recent transcript: chair's",
      "  prior question, the room subject, or the original user message. If you can't",
      "  pull a coherent topic, return the room subject's keywords as the fallback.",
      "- A source URL is shared alongside the question (search complements fetch-url).",
      "",
      "WEAK-SEARCH signals (search is OPTIONAL, lean toward yes if the question",
      "claims a fact you'd want to verify):",
      "- Statistics / market sizing / industry numbers stated as fact.",
      "- 'Will X happen?' style forecasts that hinge on current trajectory.",
      "",
      "DON'T search WHEN:",
      "- The question is philosophical, first-principles, or about stable general",
      "  knowledge that doesn't change.",
      "- It's a pure reasoning / brainstorm / planning task with no time anchor.",
      "",
      "Reply with STRICT JSON ONLY (no prose, no fences):",
      "{ \"query\": \"3-8 keywords\" }   // when search is warranted",
      "{ \"query\": null }              // otherwise",
      "",
      "Query rules:",
      "- 3-8 keywords, no full sentences. Plain ASCII works best for most providers.",
      "- Match the language of the question when possible (English keywords for",
      "  global topics; CJK keywords if the question is China-specific).",
      "- For time-sensitive questions, INCLUDE the time marker in the query when",
      `  it sharpens results (e.g. '${currentYear}', 'this week', '最近').`,
      "- When the user is META-instructing search, BUILD the query from the actual",
      "  TOPIC in the transcript, NOT from the user's directive verbs. For example,",
      "  if the user said '搜一下' and the chair previously asked about 'AI moats',",
      `  the query should be \`AI moats ${currentYear}\` — never \`搜索 AI 护城河 用户\` or similar.`,
      "- DEFAULT WHEN UNCERTAIN: if any STRONG-SEARCH signal is present, ALWAYS",
      "  return a query — never null. Skipping a clearly time-sensitive question",
      "  is worse than issuing one web search.",
    ].join("\n"),
  };

  // Build a short transcript window so the picker can pull the actual
  // discussion topic when the user's latest message is just a meta-
  // instruction ("go search", "查一下"). Last ~6 substantive messages,
  // tagged with role so the picker sees what the chair just asked
  // about / what the room subject is.
  const transcript = opts.history
    .slice(-8)
    .filter((m) => m.body && m.body.trim())
    .map((m) => {
      if (m.authorKind === "user") return `[USER] ${m.body.trim().slice(0, 400)}`;
      const meta = m.meta as { kind?: string } | undefined;
      if (meta?.kind === "tool-use" || meta?.kind === "tool-preamble") return null;
      return `[CHAIR] ${m.body.trim().slice(0, 400)}`;
    })
    .filter((s): s is string => s !== null)
    .join("\n\n");

  const userMsg: LLMMessage = {
    role: "user",
    content: [
      `Recent transcript (most recent at the bottom):`,
      transcript || "(no transcript yet)",
      ``,
      `Latest user message (your decision keys off this, but use the transcript for query keywords when needed):`,
      prompt,
      ``,
      `Should the chair search the web before replying?`,
    ].join("\n"),
  };

  const routerModel = pickRouterModel();
  if (!routerModel) return null;
  let raw = "";
  try {
    raw = await callLLM({
      modelV: routerModel,
      messages: [sys, userMsg],
      temperature: 0,
      maxTokens: 100,
      signal: opts.signal,
    });
  } catch (e) {
    if (!(e instanceof NoKeyError)) {
      process.stderr.write(
        `[chair-search-picker] failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    return null;
  }

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const ws = parsed as { query?: unknown };
  if (typeof ws.query !== "string") return null;
  const q = ws.query.trim().slice(0, 200);
  return q.length > 0 ? q : null;
}

/** Return the most recent USER turn's body (the question that triggered
 *  this round), falling back to the latest message if there's no user
 *  turn in scope. The picker doesn't need full transcript context — it's
 *  routing on the question, not the discussion. */
function latestUserPrompt(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.authorKind === "user" && m.body && m.body.trim()) return m.body.trim();
  }
  // Fall back to the last meaningful message body.
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.body && m.body.trim()) return m.body.trim();
  }
  return "";
}

/** Layer 1 of progressive skill disclosure · the metadata-only index
 *  every router sees. One line per skill — name, description, when_to_use.
 *  The full bodyMd is intentionally NOT here; routers decide on metadata
 *  alone (Claude Code-style). When a router picks a skill, the caller
 *  loads its body via `loadSkillBody` and injects it into the main pass.
 *  Exported so future chair-side or third-party routers reuse the same
 *  shape — keeps the discipline consistent across the harness. */
export function buildSkillsIndex(skills: AgentSkill[]): string {
  return skills
    .map((s) => `- ${s.slug} · "${s.name}" · ${s.description}\n  USE WHEN: ${s.whenToUse}`)
    .join("\n");
}

/** Layer 2 of progressive skill disclosure · the full body of a skill,
 *  loaded only when a router has selected it. Currently a thin field
 *  read; declared as a discrete function so callers route through one
 *  documented seam. Future evolution (e.g. lazy on-disk loading,
 *  per-skill caching, body redaction) lands here without touching
 *  callers. */
export function loadSkillBody(skill: AgentSkill): string {
  return skill.bodyMd;
}

/** Tolerant JSON extractor — strips ``` fences and tries straight parse,
 *  then a slice between the first { and last } if the response wrapped
 *  the JSON in prose. Returns null on failure. */
function extractJson(text: string): unknown | null {
  if (!text) return null;
  let s = text.trim();
  // Strip code fences.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const open = s.indexOf("{");
  const close = s.lastIndexOf("}");
  if (open >= 0 && close > open) {
    try { return JSON.parse(s.slice(open, close + 1)); } catch { return null; }
  }
  return null;
}

export async function pickSkills(opts: {
  speaker: Agent;
  skills: AgentSkill[];
  history: Message[];
  /** True when the user has a Web Search API key AND this speaker has
   *  web-search enabled. When set, the router prompt also asks for
   *  an optional web-search query — same haiku call, no extra cost. */
  webSearchAvailable?: boolean;
  signal?: AbortSignal;
}): Promise<SkillPickResult> {
  const { speaker, skills, history, signal } = opts;
  const webSearchAvailable = opts.webSearchAvailable ?? false;
  const currentYear = new Date().getFullYear();
  // Web-search isn't a body-injection skill — it's an external action
  // decided in the same router call but executed separately. Keep it
  // out of the toolbox index so the LLM doesn't try to "apply" it as
  // method.
  const toolboxSkills = skills.filter((s) => s.slug !== WEB_SEARCH_SLUG);

  if (toolboxSkills.length === 0 && !webSearchAvailable) {
    return { used: [], reason: "", webSearchQuery: null };
  }

  const prompt = latestUserPrompt(history);
  if (!prompt) return { used: [], reason: "", webSearchQuery: null };

  const baseLines = [
    `Today's date is ${new Date().toISOString().slice(0, 10)} · the CURRENT year is ${currentYear}.`,
    `When the question asks about "latest" / "最新" / "recent" / "现在" anything, anchor the`,
    `web_search query with the CURRENT MONTH, not just the year. Use`,
    `"${currentYear}年${new Date().getMonth() + 1}月" for CJK queries or`,
    `"${new Date().toLocaleString("en-US", { month: "long" })} ${currentYear}" for English.`,
    `Year-alone is too coarse · "${currentYear}" alone lets year-old articles rank above`,
    `today's news. NEVER inject an older year (e.g. "2024") into the query.`,
    ``,
    `You are ${speaker.name}'s pre-turn router. You make two cheap decisions before ${speaker.name} answers.`,
    ``,
  ];
  if (toolboxSkills.length > 0) {
    baseLines.push(`Available skills (toolbox):`);
    baseLines.push(buildSkillsIndex(toolboxSkills));
    baseLines.push(``);
  }
  if (webSearchAvailable) {
    baseLines.push(
      `Web Search · You may also issue ONE live web search query for this turn.`,
    );
    baseLines.push(``);
    baseLines.push(`STRONG-SEARCH signals (pick one → ALWAYS issue a query):`);
    baseLines.push(`- Time markers: today / this week / recent / latest / just / now /`);
    baseLines.push(`  今天 / 最近 / 本周 / 刚刚 / 现在 / 目前.`);
    baseLines.push(`- Verbs of recent action: released / launched / announced / shipped /`);
    baseLines.push(`  reported / filed / 发布 / 推出 / 宣布 / 上线.`);
    baseLines.push(`- Named recent events / products / numbers / prices the model can't`);
    baseLines.push(`  reliably know from training.`);
    baseLines.push(`- A specific person's public statements asked about by name.`);
    baseLines.push(`- Explicit search verbs: search / look up / 查一下 / 搜索.`);
    baseLines.push(``);
    baseLines.push(`DON'T search on philosophical / first-principles / pure-reasoning`);
    baseLines.push(`questions with no time anchor — search adds noise. But when ANY of`);
    baseLines.push(`the STRONG-SEARCH signals above are present, ALWAYS issue a query`);
    baseLines.push(`— skipping a time-sensitive question is worse than the API cost.`);
    baseLines.push(``);
  }
  const schemaLines = [
    `Reply with STRICT JSON ONLY — no prose, no code fences:`,
    `{`,
    toolboxSkills.length > 0
      ? `  "use": ["slug1", "slug2"],         // 0-${MAX_PICKS} picks from the toolbox`
      : `  "use": [],                         // no toolbox available, leave empty`,
    `  "reason": "≤100 chars · why these picks (or why none)",`,
    webSearchAvailable
      ? `  "web_search": { "query": "..." }   // or null if no fresh info needed`
      : `  "web_search": null                 // not available this turn`,
    `}`,
    ``,
    `Rules:`,
  ];
  if (toolboxSkills.length > 0) {
    schemaLines.push(`- Pick at most ${MAX_PICKS} skills. Fewer is fine.`);
    schemaLines.push(`- Use the slug exactly as written in the toolbox.`);
    schemaLines.push(`- Match skills on USE WHEN, not name.`);
  }
  if (webSearchAvailable) {
    schemaLines.push(`- For \`web_search.query\`: 3-8 keywords, no full sentences. Plain ASCII works best.`);
    schemaLines.push(`- Match the question's language for the query (English keywords for global topics; CJK if China-specific).`);
    schemaLines.push(`- For time-sensitive questions, INCLUDE the time marker in the query when it sharpens results (e.g. '${currentYear}', 'this week', '最近').`);
    schemaLines.push(`- DEFAULT WHEN UNCERTAIN: if any STRONG-SEARCH signal is present in the question, ALWAYS issue a query — never null. Skipping a clearly time-sensitive question is worse than one search call.`);
  } else {
    schemaLines.push(`- \`web_search\` MUST be null — the user hasn't enabled it for this speaker.`);
  }

  const sys: LLMMessage = {
    role: "system",
    content: [...baseLines, ...schemaLines].join("\n"),
  };

  const userMsg: LLMMessage = {
    role: "user",
    content: `Latest user message:\n${prompt}\n\nWhich skills apply, and does this turn need web search?`,
  };

  // Try the cheap router model first; fall back to the speaker's own
  // model when no router-eligible carrier is configured. The
  // router lookup is keyed by the user's keys, so it returns null on
  // a fresh install — in that case we just use the speaker model.
  const routerModel = pickRouterModel();
  const candidates: ModelV[] = (routerModel
    ? [routerModel, speaker.modelV as ModelV]
    : [speaker.modelV as ModelV]);
  let raw = "";
  for (const modelV of candidates) {
    try {
      raw = await callLLM({
        modelV,
        messages: [sys, userMsg],
        temperature: 0,
        maxTokens: 240,
        signal,
      });
      if (raw && raw.trim()) break;
    } catch (e) {
      if (e instanceof NoKeyError) continue;
      // Other errors → bail (treat as no picks). Logged below.
      process.stderr.write(
        `[skill-picker] ${speaker.name} (${modelV}) failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      continue;
    }
  }

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return { used: [], reason: "", webSearchQuery: null };
  }
  const obj = parsed as { use?: unknown; reason?: unknown; web_search?: unknown };
  const slugs: string[] = Array.isArray(obj.use)
    ? obj.use.filter((s): s is string => typeof s === "string").slice(0, MAX_PICKS)
    : [];
  const reason = typeof obj.reason === "string" ? obj.reason.trim().slice(0, 200) : "";

  const bySlug = new Map(toolboxSkills.map((s) => [s.slug, s]));
  const used: AgentSkill[] = [];
  for (const slug of slugs) {
    const s = bySlug.get(slug);
    if (s && !used.includes(s)) used.push(s);
  }

  let webSearchQuery: string | null = null;
  if (webSearchAvailable && obj.web_search && typeof obj.web_search === "object") {
    const ws = obj.web_search as { query?: unknown };
    if (typeof ws.query === "string") {
      const q = ws.query.trim().slice(0, 200);
      if (q) webSearchQuery = q;
    }
  }
  return { used, reason, webSearchQuery };
}

/** Render the chosen skills into a system-prompt block · Layer 2
 *  injection. Caller appends this to the existing prompt after the
 *  standard sections. The skill bodies are loaded through `loadSkillBody`
 *  so any future indirection (lazy load, redaction) is centralized. */
export function renderActiveSkillsBlock(used: AgentSkill[]): string {
  if (used.length === 0) return "";
  const parts: string[] = [
    "─── ACTIVE SKILLS (apply these for THIS turn) ───",
    "You picked these from your toolbox because they match the question. Use them as your method, not as topics to discuss.",
    "",
  ];
  for (const s of used) {
    parts.push(`### ${s.name}`);
    parts.push(`When to use: ${s.whenToUse}`);
    parts.push("");
    parts.push(loadSkillBody(s).trim());
    parts.push("");
    parts.push("───");
    parts.push("");
  }
  return parts.join("\n");
}
