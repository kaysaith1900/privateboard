/**
 * Prompts for the Full-persona builder pipeline.
 *
 * Phase 1 reuses `agent-spec.ts` Stage A as-is (no changes needed —
 * the v1 profile is exactly what Stage A already produces).
 *
 * Phase 2 (the ReAct knowledge loop) lives here · `buildPlannerMessages`
 * for the per-round planner that decides "next query?" / "stop", and
 * `buildKnowledgeSynthesisMessages` for the post-loop structuring.
 *
 * Phase 3 (spec v2 critique) reuses Stage A again but with the
 * accumulated knowledge folded into `webContext`, so the second pass
 * absorbs the real referents the loop surfaced.
 *
 * Phases 4-7 (rules / few-shot / reflection / eval) are bespoke
 * prompts here. Each returns LLMMessage[] ready to feed into
 * `callLLM`; the orchestrator parses the result via `extractJson`
 * imported from agent-spec.ts.
 */
import type { LLMMessage } from "../adapter.js";

import type {
  AgentProfile,
} from "./agent-spec.js";

/* ─────────────────── Phase 2a · dimension planner ───────────────────
   Runs ONCE before any searches, emitting 4-6 distinct angles to fan
   out in parallel. The ReAct planner below then runs as a top-up to
   fill any gaps the dimension planner missed. */

const DIMENSION_PLANNER_SYSTEM = [
  "You are the research dimension planner inside a persona-building pipeline. Before any searches run, your job is to pick 4–6 distinct ANGLES to investigate IN PARALLEL — each producing one focused web query.",
  "",
  "Inputs you receive:",
  "  · the user's director description",
  "  · the persona-spec v1 draft (intellectual lineage, load-bearing concepts, referent set, failure modes, contrarian takes)",
  "",
  "Output JSON · no preamble:",
  "```json",
  "{",
  "  \"dimensions\": [",
  "    { \"dimension\": \"<short-tag>\", \"query\": \"<≤12 words>\", \"why\": \"<one sentence>\" }",
  "  ]",
  "}",
  "```",
  "",
  "Canonical dimension tags · you MAY invent others if more fitting, but prefer these when they fit:",
  "  · biography             — life events, formative context",
  "  · lineage               — intellectual influences, schools, predecessors",
  "  · key_works             — books, papers, frameworks they authored or signed",
  "  · signature_concepts    — named ideas they coined or popularised",
  "  · contested_claims      — positions that drew counterarguments, by whom",
  "  · recent_developments   — last 1–3 years of activity, news, evolutions",
  "  · counter_movements     — schools that explicitly oppose them",
  "",
  "Discipline:",
  "  · 4–6 dimensions · adapt to the seed (a living tech founder weights `recent_developments` heavily, downweights `key_works`; a historical philosopher inverse).",
  "  · Each `query` should be NAMED-entity-rich · \"Stuart Russell AI alignment textbook\" beats \"AI alignment philosophy\". Generic queries waste a parallel slot.",
  "  · DISTINCT angles · two queries on the same axis is wasted budget.",
  "  · Do not restate the v1 profile's referent set verbatim · advance the picture, don't echo it.",
  "  · Output raw JSON, no prose preamble, no fenced block needed (but allowed).",
].join("\n");

export interface DimensionPlannerOpts {
  description: string;
  profileV1: AgentProfile;
}

export function buildDimensionPlannerMessages(opts: DimensionPlannerOpts): LLMMessage[] {
  const profile = JSON.stringify(opts.profileV1, null, 2);
  const userBody = [
    `User's director description:`,
    ``,
    opts.description.trim(),
    ``,
    `Persona spec v1 (draft, before knowledge retrieval):`,
    ``,
    "```json",
    profile,
    "```",
    ``,
    `Now decide 4–6 distinct research dimensions and a focused web query for each.`,
  ].join("\n");
  return [
    { role: "system", content: DIMENSION_PLANNER_SYSTEM },
    { role: "user", content: userBody },
  ];
}

export interface DimensionPlanEntry {
  dimension: string;
  query: string;
  why: string;
}

export function parseDimensionPlan(raw: string): DimensionPlanEntry[] | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const arr = obj.dimensions;
    if (!Array.isArray(arr) || arr.length === 0 || arr.length > 8) return null;
    const out: DimensionPlanEntry[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const e = item as Record<string, unknown>;
      const dimension = typeof e.dimension === "string" ? e.dimension.trim() : "";
      const query = typeof e.query === "string" ? e.query.trim() : "";
      const why = typeof e.why === "string" ? e.why.trim() : "";
      if (!dimension || !query) continue;
      out.push({ dimension, query, why });
    }
    if (out.length === 0) return null;
    return out;
  } catch {
    return null;
  }
}

/* ─────────────────────── Phase 2c · ReAct top-up planner ──────────────────────
   Same prompt as before · used now as a TOP-UP after the parallel
   dimension batch has completed. The audit log it sees is pre-
   populated with `[dimension: ...]` tags so the planner knows which
   angles are already covered and only fills genuine gaps. */

const PLANNER_SYSTEM = [
  "You are the research planner inside a multi-step persona-building pipeline. Your job is to decide what the LLM should search for NEXT to flesh out a director persona — or to declare 'enough material, stop searching'.",
  "",
  "Each turn you receive:",
  "  · the user's original director description",
  "  · the persona-spec v1 draft (intellectual lineage, load-bearing concepts, referent set, failure modes, contrarian takes)",
  "  · the audit log of every query already run, with result counts",
  "  · the per-query notes from prior rounds (what was learned)",
  "",
  "You output a JSON object with EXACTLY one of two shapes:",
  "",
  "Shape A · continue searching:",
  "```json",
  "{ \"action\": \"search\", \"query\": \"<≤12 words, focused>\", \"angle\": \"<one phrase: which axis of the persona this query advances>\", \"why\": \"<one sentence on what new info would unblock>\" }",
  "```",
  "",
  "Shape B · terminate:",
  "```json",
  "{ \"action\": \"stop\", \"reason\": \"<one sentence · saturated / diminishing returns / no key axis remains>\" }",
  "```",
  "",
  "Discipline:",
  "  · NEVER repeat a query that's already in the audit log (case-insensitive normalised match).",
  "  · NEVER propose a query whose `angle` matches an angle already covered in 2+ prior rounds.",
  "  · Prefer NAMED entities (people / books / institutions / specific historical events) over generic concept queries — they yield citable referents.",
  "  · Stop early when the persona has 5+ named referents AND 3+ contrarian takes AND 3+ documented failure modes. Don't burn the budget for diminishing returns.",
  "  · Stop when 2+ recent rounds returned <3 useful results — the topic is shallow and more queries won't help.",
  "  · If the audit log already includes rows tagged `[dimension: ...]`, those angles have been covered by an earlier parallel batch. Propose ONLY queries that fill genuine gaps the parallel batch missed; otherwise return `{ \"action\": \"stop\" }`. It is often correct to stop on round 1 of the top-up when the parallel batch covered the persona's primary axes.",
  "",
  "Output: raw JSON, no prose preamble, no fenced block needed (but allowed).",
].join("\n");

export interface PlannerOpts {
  description: string;
  profileV1: AgentProfile;
  pastRounds: Array<{
    query: string;
    angle: string;
    resultsCount: number;
    pagesRead: number;
    notes: string;
  }>;
  /** Cap signal · the planner sees its remaining budget so it can
   *  prefer terminate when only one round is left. */
  roundsRemaining: number;
}

export function buildPlannerMessages(opts: PlannerOpts): LLMMessage[] {
  const auditLog = opts.pastRounds.length === 0
    ? "(none yet — this is the first round)"
    : opts.pastRounds.map((r, i) => (
        `${i + 1}. "${r.query}" · angle: ${r.angle} · results: ${r.resultsCount} · pages read: ${r.pagesRead}` +
        (r.notes ? `\n     notes: ${r.notes}` : "")
      )).join("\n");
  const profile = JSON.stringify(opts.profileV1, null, 2);
  const userBody = [
    `User's director description:`,
    ``,
    opts.description.trim(),
    ``,
    `Persona spec v1 (draft, before knowledge retrieval):`,
    ``,
    "```json",
    profile,
    "```",
    ``,
    `Search audit log so far:`,
    ``,
    auditLog,
    ``,
    `Rounds remaining: ${opts.roundsRemaining}`,
    ``,
    `Decide: search (with a fresh query covering an UNCOVERED angle) or stop.`,
  ].join("\n");
  return [
    { role: "system", content: PLANNER_SYSTEM },
    { role: "user", content: userBody },
  ];
}

export interface PlannerDecision {
  action: "search" | "stop";
  query?: string;
  angle?: string;
  why?: string;
  reason?: string;
}

export function parsePlannerDecision(raw: string): PlannerDecision | null {
  // Inline lightweight parse · agent-spec.ts's extractJson is fine
  // but copying its body would create a circular import; for the
  // planner's small object we walk the first { … } directly.
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const action = obj.action === "search" || obj.action === "stop" ? obj.action : null;
    if (!action) return null;
    if (action === "search") {
      const query = typeof obj.query === "string" ? obj.query.trim() : "";
      if (!query) return null;
      return {
        action: "search",
        query,
        angle: typeof obj.angle === "string" ? obj.angle.trim() : "",
        why: typeof obj.why === "string" ? obj.why.trim() : "",
      };
    }
    return {
      action: "stop",
      reason: typeof obj.reason === "string" ? obj.reason.trim() : "",
    };
  } catch {
    return null;
  }
}

/* ─────────── Phase 2 · post-loop knowledge structuring ─────────── */

const KNOWLEDGE_SYSTEM = [
  "You are a research librarian. The persona-builder loop just ran multiple web searches and read pages from the results. Your job is to organise the raw material into a structured knowledge bundle the persona spec can pull from.",
  "",
  "Output JSON with this exact shape:",
  "```json",
  "{",
  "  \"keyThinkers\": [{ \"title\": \"Person name\", \"summary\": \"1-2 sentences on their core contribution\", \"citations\": [\"https://...\"] }],",
  "  \"foundationalWorks\": [{ \"title\": \"Book / paper / framework name\", \"summary\": \"1-2 sentences\", \"citations\": [\"https://...\"] }],",
  "  \"recentDevelopments\": [{ \"title\": \"What happened\", \"summary\": \"1-2 sentences with a year\", \"citations\": [\"https://...\"] }],",
  "  \"contestedClaims\": [{ \"title\": \"The claim\", \"summary\": \"Why it's contested + by whom\", \"citations\": [\"https://...\"] }]",
  "}",
  "```",
  "",
  "Discipline:",
  "  · Every entry needs at least one citation URL drawn from the source material below. NEVER invent URLs.",
  "  · Distinct entries — don't repeat the same thinker / work across categories.",
  "  · Concise summaries: 1-2 sentences. The instruction this feeds into has its own length budget; long summaries get truncated.",
  "  · 3-8 entries per category. Empty arrays allowed when the material genuinely doesn't cover that category.",
  "  · When source blocks are tagged `─── DIMENSION · X`, prefer to draw `recentDevelopments` from `recent_developments`-tagged blocks, `foundationalWorks` from `key_works`-tagged blocks, `keyThinkers` from `lineage` / `biography` / `counter_movements`-tagged blocks, and `contestedClaims` from `contested_claims` / `counter_movements`-tagged blocks. You may still cite freely across blocks when the material crosses dimensions.",
].join("\n");

export interface KnowledgeSynthesisOpts {
  description: string;
  profileV1: AgentProfile;
  rawSources: string;  // concatenated search-result text + page extracts
}

export function buildKnowledgeSynthesisMessages(opts: KnowledgeSynthesisOpts): LLMMessage[] {
  const userBody = [
    `Persona being built · the director should embody:`,
    ``,
    opts.description.trim(),
    ``,
    `Persona spec v1 (so you know which angles to weight):`,
    ``,
    "```json",
    JSON.stringify(opts.profileV1, null, 2),
    "```",
    ``,
    `Raw source material from the search loop:`,
    ``,
    opts.rawSources,
    ``,
    `Now produce the structured knowledge bundle as specified.`,
  ].join("\n");
  return [
    { role: "system", content: KNOWLEDGE_SYSTEM },
    { role: "user", content: userBody },
  ];
}

/* ─────────────── Phase 4 · behavioural rules ─────────────── */

const RULES_SYSTEM = [
  "You are distilling a director persona into a small set of behavioural rules — the kind a senior executive coach would print on the back of a card. The director will speak in multi-agent rooms; these rules govern WHAT they will and won't do, not how they sound (voice is handled separately).",
  "",
  "Output JSON with this shape:",
  "```json",
  "{",
  "  \"rules\": [",
  "    { \"kind\": \"always\", \"rule\": \"<imperative sentence · ≤ 18 words>\" },",
  "    { \"kind\": \"never\", \"rule\": \"<imperative sentence · ≤ 18 words>\" },",
  "    { \"kind\": \"conditional\", \"rule\": \"When <trigger>, <do this>.\" }",
  "  ]",
  "}",
  "```",
  "",
  "Discipline:",
  "  · 8-15 rules total, ranked from most-load-bearing to least. The first 3 should capture the persona's signature moves; later rules handle edge cases.",
  "  · `kind` must be one of: \"always\" / \"never\" / \"conditional\".",
  "  · Each rule names a concrete behaviour, not a vague aspiration. \"Cite a specific source\" beats \"Be rigorous\".",
  "  · No rule should be generic (\"think clearly\", \"be helpful\"). Every rule must be something this PERSONA does that a generic AI wouldn't.",
  "  · Avoid stamp-vocabulary the model will parrot literally · don't write rules like \"State your confidence (high/medium/low)\" or \"Announce the strongest version is...\" — those produce form-filling output in Chinese rooms. Push for behavioural rules whose execution is implicit in how the director writes.",
].join("\n");

export interface RulesOpts {
  description: string;
  profileV2: AgentProfile;
  knowledgeSummary: string;
}

export function buildRulesMessages(opts: RulesOpts): LLMMessage[] {
  const userBody = [
    `Director description:`,
    ``,
    opts.description.trim(),
    ``,
    `Refined persona spec (v2, after knowledge retrieval):`,
    ``,
    "```json",
    JSON.stringify(opts.profileV2, null, 2),
    "```",
    ``,
    `Knowledge context summary:`,
    ``,
    opts.knowledgeSummary,
    ``,
    `Now produce the behavioural rules JSON as specified.`,
  ].join("\n");
  return [
    { role: "system", content: RULES_SYSTEM },
    { role: "user", content: userBody },
  ];
}

/* ─────────────── Phase 5 · few-shot examples ─────────────── */

const FEWSHOT_SYSTEM = [
  "You are generating worked examples that distill a director's voice. Few-shot examples are the highest-leverage way to keep multi-agent rooms from collapsing into one homogeneous voice — far more reliable than additional rule text. Each example shows the director acting; the contrast with a generic-AI baseline makes the lens visible.",
  "",
  "Output JSON with this shape:",
  "```json",
  "{",
  "  \"examples\": [",
  "    {",
  "      \"scenario\": \"<one-sentence prompt the director might receive in a room>\",",
  "      \"genericResponse\": \"<2-4 sentences of what a default helpful AI would say · safe, balanced, generic>\",",
  "      \"personaResponse\": \"<2-5 sentences of what THIS director says · the lens visibly active>\",",
  "      \"rationale\": \"<one sentence on what makes them differ — name the specific lens move>\"",
  "    }",
  "  ]",
  "}",
  "```",
  "",
  "Discipline:",
  "  · 3-5 examples · cover different room moments (a fresh question, a counter to another director, a critique of the user's framing, a moment where the room is converging too fast).",
  "  · The `personaResponse` must SHOW the lens, not announce it. Don't write \"Speaking from a contrarian lens, …\" — just be contrarian.",
  "  · Each `genericResponse` should be plausible — what most LLMs would default to. The contrast only works if the baseline is a real LLM voice, not a strawman.",
  "  · Avoid vocabulary stamps (\"the strongest version is\", \"my confidence is high\", \"as a [persona] I would\") · those produce parrot patterns in Chinese rooms. The persona's distinctness must show in the SUBSTANCE of what they say.",
  "  · One example should demonstrate the persona pushing back on an OBVIOUS framing — that's the highest-signal differentiation move.",
].join("\n");

export interface FewShotOpts {
  description: string;
  profileV2: AgentProfile;
  rules: Array<{ kind: string; rule: string }>;
}

export function buildFewShotMessages(opts: FewShotOpts): LLMMessage[] {
  const rulesText = opts.rules.map((r) => `· (${r.kind}) ${r.rule}`).join("\n");
  const userBody = [
    `Director description:`,
    ``,
    opts.description.trim(),
    ``,
    `Refined persona spec:`,
    ``,
    "```json",
    JSON.stringify(opts.profileV2, null, 2),
    "```",
    ``,
    `Behavioural rules already defined:`,
    ``,
    rulesText || "(none)",
    ``,
    `Now produce 3-5 worked examples as specified.`,
  ].join("\n");
  return [
    { role: "system", content: FEWSHOT_SYSTEM },
    { role: "user", content: userBody },
  ];
}

/* ─────────────── Phase 6 · reflection checklist ─────────────── */

const REFLECTION_SYSTEM = [
  "You are writing a self-check protocol for a director who's about to speak in a multi-agent room. The checklist runs silently before EVERY turn the director takes. Its job: catch the failure modes that cause directors to drift toward generic AI voice or repeat each other.",
  "",
  "Output JSON with this shape:",
  "```json",
  "{ \"checklist\": [\"<question 1>\", \"<question 2>\", ...] }",
  "```",
  "",
  "Discipline:",
  "  · 5-8 questions · short, punchy, second-person. Each catches a SPECIFIC failure mode of THIS persona.",
  "  · Mix universal questions (\"Am I repeating @another_director's mechanism point?\" — applicable to any director) with persona-specific ones (e.g. for a Historian: \"Did I name a date and place, not just 'in the past'?\").",
  "  · Avoid generic questions (\"Am I being thoughtful?\" \"Did I give a good answer?\") — those don't catch anything.",
  "  · Frame as questions the model can answer YES/NO before generating — not as instructions.",
  "  · The most important questions go FIRST · the model may run out of attention budget on long checklists.",
].join("\n");

export interface ReflectionOpts {
  description: string;
  profileV2: AgentProfile;
  fewShotCount: number; // for prompt context · "you're working from N examples"
}

export function buildReflectionMessages(opts: ReflectionOpts): LLMMessage[] {
  const userBody = [
    `Director description:`,
    ``,
    opts.description.trim(),
    ``,
    `Refined persona spec:`,
    ``,
    "```json",
    JSON.stringify(opts.profileV2, null, 2),
    "```",
    ``,
    `Few-shot examples available · ${opts.fewShotCount} total.`,
    ``,
    `Now produce the reflection checklist JSON as specified.`,
  ].join("\n");
  return [
    { role: "system", content: REFLECTION_SYSTEM },
    { role: "user", content: userBody },
  ];
}

/* ─────────────── Phase 7 · eval set ─────────────── */

const EVAL_SYSTEM = [
  "You are designing the eval set for a newly-built director persona. The set is used twice:",
  "  (1) NOW · build-time differentiation pass · each prompt is fed to a cheap LLM probe with the full persona vs a generic-baseline; embedding distance scores how distinct this persona is from a default AI voice.",
  "  (2) LATER · regression smoke when the persona spec is edited.",
  "",
  "Output JSON with this shape:",
  "```json",
  "{",
  "  \"prompts\": [",
  "    { \"prompt\": \"<one sentence the director might be asked>\", \"expectedSignature\": \"<what a high-fidelity persona response would do · 1-2 sentences>\" }",
  "  ]",
  "}",
  "```",
  "",
  "Discipline:",
  "  · 5-10 prompts · short, concrete, designed to USE the persona's lens.",
  "  · Each `expectedSignature` names the specific behaviour you'd grade for · not a model answer, but the moves the persona should make.",
  "  · At least one prompt should be a hard case: a question where the persona's lens DOESN'T have a clear answer — to test whether they say so honestly vs. confabulating.",
  "  · At least one prompt should be a generic case: a question that almost any AI could answer the same way · this prompt's score will be LOWER, and that's diagnostic.",
  "  · Avoid prompts that name the persona explicitly (\"Tell me as Aurelia what you think of X\") · that's leakage. Prompts should be neutral — the response shows the persona, not the prompt.",
].join("\n");

export interface EvalOpts {
  description: string;
  profileV2: AgentProfile;
}

export function buildEvalMessages(opts: EvalOpts): LLMMessage[] {
  const userBody = [
    `Director description:`,
    ``,
    opts.description.trim(),
    ``,
    `Refined persona spec:`,
    ``,
    "```json",
    JSON.stringify(opts.profileV2, null, 2),
    "```",
    ``,
    `Now produce the eval prompts JSON as specified.`,
  ].join("\n");
  return [
    { role: "system", content: EVAL_SYSTEM },
    { role: "user", content: userBody },
  ];
}

/* ─────────── Phase 7 build-time differentiation probe ───────────
   Each eval prompt is fed twice · once with the persona, once
   without. The probe model is a cheap one (utility tier). The
   responses get embedded and the cosine distance between them is
   the per-prompt divergence score. Mean across prompts is the
   build's overall differentiation score. */

export interface ProbeOpts {
  prompt: string;
  /** When set · render the persona's compiled instruction + a few-shot
   *  example into the system prompt so the model speaks AS the
   *  persona. When omitted · system is a vanilla helpful-AI prompt
   *  (the baseline). */
  personaSystem?: string;
}

export function buildProbeMessages(opts: ProbeOpts): LLMMessage[] {
  const system = opts.personaSystem ?? "You are a helpful AI assistant. Answer the user's question concisely and clearly.";
  return [
    { role: "system", content: system },
    { role: "user", content: opts.prompt },
  ];
}

/* ─────────────── Post-pipeline · persona naming ───────────────
   Runs after Phase 7 with the fully-built persona spec. Produces a
   short director-style name + handle the save form prefills. Cheap
   utility-tier model · the artifact only needs ~30 output tokens. */

const NAME_SYSTEM = [
  "You name newly-built director personas. The pipeline has produced a full persona spec (lineage, concepts, contrarian takes, rules, voice examples). Your job is to give the director a short, memorable identifier the user sees on the save form.",
  "",
  "Output JSON · no preamble:",
  "```json",
  "{ \"name\": \"<2-4 word display name>\", \"handle\": \"<short_lowercase_handle, snake_case, ≤ 16 chars>\" }",
  "```",
  "",
  "Discipline:",
  "  · `name` is 2-4 words. Capitalise like a real name. The character can be a real person if they're clearly the figure being channelled (e.g. \"Michel Foucault\"), an evocative invented name (\"Aurelia Strand\"), or a role-style title (\"The Empiricist\"). Match the register the user's description implies.",
  "  · NEVER name a real living public figure unless the user's description explicitly named them. Inventing \"Patrick Collison\" or \"Sam Altman\" out of a generic seed is wrong; only echo a real person if the user did first.",
  "  · `handle` is lowercase snake_case derived from `name`, ≤ 16 chars. Example: \"Michel Foucault\" → \"foucault\" or \"m_foucault\"; \"Aurelia Strand\" → \"aurelia\" or \"a_strand\"; \"The Empiricist\" → \"empiricist\".",
  "  · Avoid generic placeholders: \"director\", \"agent\", \"persona\", \"the_thinker\". Names should feel inhabited.",
  "  · Do not echo the user's seed verbatim · the name should evoke the persona, not restate the seed words.",
  "  · Output raw JSON, no prose preamble.",
].join("\n");

export interface NameOpts {
  description: string;
  profileV2: AgentProfile;
  contrarianTakes?: string[];
  loadBearingConcepts?: string[];
}

export function buildPersonaNameMessages(opts: NameOpts): LLMMessage[] {
  const userBody = [
    `Director description (user seed):`,
    ``,
    opts.description.trim(),
    ``,
    `Refined persona spec (post knowledge retrieval):`,
    ``,
    "```json",
    JSON.stringify({
      intellectualLineage: opts.profileV2.intellectualLineage,
      contrarianTakes: opts.contrarianTakes ?? opts.profileV2.contrarianTakes,
      loadBearingConcepts: opts.loadBearingConcepts ?? opts.profileV2.loadBearingConcepts,
      failureModes: opts.profileV2.failureModes,
      referentSet: opts.profileV2.referentSet,
    }, null, 2),
    "```",
    ``,
    `Now produce { "name": "...", "handle": "..." } for this director.`,
  ].join("\n");
  return [
    { role: "system", content: NAME_SYSTEM },
    { role: "user", content: userBody },
  ];
}

export interface PersonaName {
  name: string;
  handle: string;
}

export function parsePersonaName(raw: string): PersonaName | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const handle = typeof obj.handle === "string" ? obj.handle.trim() : "";
    if (!name || name.length < 2 || name.length > 48) return null;
    return { name, handle };
  } catch {
    return null;
  }
}
