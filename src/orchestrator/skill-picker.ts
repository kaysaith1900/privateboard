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
import type { Agent } from "../storage/agents.js";
import type { Message } from "../storage/messages.js";
import type { AgentSkill } from "../storage/skills.js";
import type { ModelV } from "../ai/registry.js";
import { activeCarrier } from "../storage/reconcile-models.js";
import { WEB_SEARCH_SLUG } from "../skills/system-skills.js";

/** Cheap-tier model for each carrier · the model the picker uses for
 *  routing decisions (clarify gate / web-search / next-speaker /
 *  round-wrap / skill match). Mirrors the carrier-priority table in
 *  reconcile-models.ts; kept colocated with the picker since this is
 *  the only place that distinguishes "cheap tier per carrier" from
 *  "primary tier per carrier". */
const CHEAP_BY_CARRIER: Record<string, ModelV> = {
  openrouter: "haiku-4-5",
  anthropic:  "sonnet-4-6",     // only direct-routable Claude
  openai:     "gpt-5-4-mini",
  google:     "gemini-3-1-flash",  // 3.1 Flash Lite · cheapest direct-routable Gemini
  xai:        "grok-4-1-fast",  // 4.1 Fast · cheapest direct-routable Grok
};

/** Pick the cheapest reachable model for routing decisions. Follows
 *  the user's *active carrier* (the carrier of `prefs.defaultModelV`
 *  when it's reachable, otherwise the first reachable in priority
 *  order) — same resolution rule used by reconcile + chair primary.
 *
 *  Why activeCarrier rather than a hardcoded order over `getKey()`:
 *  if the user configured BOTH OpenAI and Google but switched their
 *  default to Gemini, the picker should also use Gemini's cheap tier
 *  (`gemini-3-1-flash`) — not silently keep firing OpenAI calls just
 *  because OpenAI key is still configured. Earlier versions did the
 *  latter and it surfaced as "I switched to Gemini but every picker
 *  call still bills OpenAI". */
function pickRouterModel(): ModelV | null {
  const carrier = activeCarrier();
  if (carrier && CHEAP_BY_CARRIER[carrier]) return CHEAP_BY_CARRIER[carrier];
  return null;
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
  /** ≤200 chars · why this call. Surfaced in the round-prompt body so
   *  the user reads the chair's reasoning before pressing the button. */
  rationale: string;
}

export async function pickRoundWrap(opts: {
  history: Message[];
  roundNum: number;
  signal?: AbortSignal;
}): Promise<RoundWrapDecision> {
  const { history, roundNum, signal } = opts;

  const transcript = history
    .slice(-20)
    .filter((m) => {
      if (!m.body || !m.body.trim()) return false;
      const meta = m.meta as { kind?: string } | undefined;
      if (meta?.kind === "tool-use" || meta?.kind === "tool-preamble") return false;
      if (meta?.kind === "round-open" || meta?.kind === "round-prompt") return false;
      return true;
    })
    .map((m) => {
      const who = m.authorKind === "user" ? "USER" : (m.authorId || "agent");
      return `[${who}] ${m.body.trim().slice(0, 600)}`;
    })
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
      "Reply with STRICT JSON ONLY (no prose, no fences):",
      "{ \"recommendation\": \"end\" | \"continue\", \"rationale\": \"≤200 chars · the load-bearing reason\" }",
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
  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim().slice(0, 240) : "";
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
  signal?: AbortSignal;
}): Promise<NextSpeakerPick> {
  const { candidates, history, signal } = opts;
  if (candidates.length < 2) return { agentId: null, rationale: "", intervention: null };

  // Build the candidate roster. We include role tag + bio so the picker
  // can match lens to the previous turn's gap, not just remember names.
  const roster = candidates
    .map((a) => `- ${a.id} · ${a.name} (${a.handle}) · ${a.roleTag}\n  ${a.bio}`)
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
    .map((m) => {
      const who = m.authorKind === "user" ? "USER" : (m.authorId || "agent");
      return `[${who}] ${m.body.trim().slice(0, 600)}`;
    })
    .join("\n\n");

  const sys: LLMMessage = {
    role: "system",
    content: [
      "You are the boardroom chair's pre-turn moderator. The room is in",
      "a reactive round; one director just finished. You make TWO",
      "decisions in one pass.",
      "",
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
      "Match the user's language (Chinese subject → Chinese; English →",
      "English). No greeting, no signature.",
      "",
      "Reply with STRICT JSON ONLY (no prose, no fences):",
      "{",
      "  \"agent_id\": \"<exact id from roster>\" | null,",
      "  \"rationale\": \"≤120 chars · why this lens fits next\",",
      "  \"intervention\": \"≤200 chars · the one-sentence note\" | null",
      "}",
    ].join("\n"),
  };

  const userMsg: LLMMessage = {
    role: "user",
    content: [
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
  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim().slice(0, 200) : "";
  // Intervention · accept only meaningful strings; trim, cap length,
  // discard empty / "null" / "none" so the prompt's "default null" path
  // works even when the model emits a string literal instead of JSON null.
  let intervention: string | null = null;
  if (typeof obj.intervention === "string") {
    const t = obj.intervention.trim();
    if (t.length > 0 && t.toLowerCase() !== "null" && t.toLowerCase() !== "none") {
      intervention = t.slice(0, 280);
    }
  }
  return { agentId: id, rationale, intervention };
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

  const sys: LLMMessage = {
    role: "system",
    content: [
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
      "  reliably know from training (CES 2025, model launches, IPO numbers, ARR figures,",
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
      "  it sharpens results (e.g. '2025', 'this week', '最近').",
      "- When the user is META-instructing search, BUILD the query from the actual",
      "  TOPIC in the transcript, NOT from the user's directive verbs. For example,",
      "  if the user said '搜一下' and the chair previously asked about 'AI moats',",
      "  the query should be `AI moats 2025` — never `搜索 AI 护城河 用户` or similar.",
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
    schemaLines.push(`- For time-sensitive questions, INCLUDE the time marker in the query when it sharpens results (e.g. '2025', 'this week', '最近').`);
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
