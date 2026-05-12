/**
 * Agent-spec generation prompt. The user describes what kind of director
 * they want in free text; the LLM returns a structured spec
 * (name / handle / role tag / bio / cover quote / instruction / model)
 * matching the boardroom's house voice.
 *
 * The prompt seeds with the canonical seed directors (Socrates, First
 * Principles, etc.) as few-shot examples so generated agents fit the
 * established style — short concrete bios, named methods, anti-flatter
 * boundaries, italic-for-load-bearing-word voice rules.
 */
import type { LLMMessage } from "../adapter.js";

/* ────────────────────────── Stage A · profile ─────────────────────────────
 *
 * Before we write the spec, we ask the model to produce a structured
 * "intellectual profile" of this director: their lineage, the concepts
 * they reach for, the cases they cite, their blind spots. The profile
 * is NOT returned to the user — it's intermediate scaffolding the spec
 * generator (Stage B) reads in addition to the user's free-text
 * description, so the resulting director has REAL anchors (named
 * thinkers, concrete cases, specific concepts) to draw on at debate
 * time instead of generic LLM-style abstractions.
 *
 * Empirically, two-stage generation is much more stable than one-shot
 * for character coherence — the model commits to a worldview before
 * picking a name, instead of inventing the worldview piecemeal as it
 * fills slots in a single JSON object.
 */
const PROFILE_SYSTEM = [
  "You are designing the intellectual profile of a NEW boardroom director the user has just described.",
  "Your job in THIS step is NOT to write the director's spec. It's to produce a tight, opinionated PROFILE that a downstream prompt will use as the source material for the actual spec.",
  "",
  "The profile is a JSON object with five fields. Every field must be SPECIFIC, NAMED, and FALSIFIABLE — no abstract personality language ('insightful', 'thoughtful', 'analytical'), no marketing copy, no hedging.",
  "",
  "## Fields",
  "",
  "1. `intellectualLineage` · 2-4 named influences this director descends from + 1-2 traditions / schools they push back against.",
  "   Format: { \"influencedBy\": [\"named thinker / school / tradition · 1-line on what they took\"], \"opposedTo\": [\"named tradition · 1-line on what they reject\"] }",
  "   Examples:",
  "     · influencedBy: [\"Karl Popper · falsifiability over fit\", \"Christensen · disruption read against incumbent advantage\", \"Charlie Munger · multidisciplinary mental models\"]",
  "     · opposedTo: [\"vibes-based 'product-market fit' storytelling that won't name a metric\", \"VC narratives that treat scale as inherently virtuous\"]",
  "",
  "2. `loadBearingConcepts` · 3-5 concepts / frames / mental tools this director reaches for repeatedly. Each is a NAMED handle (not a description) + a one-line gloss.",
  "   Format: [{ \"name\": \"short noun phrase\", \"gloss\": \"how they use it\" }]",
  "   Examples (good): \"Chesterton's fence · before tearing down a constraint, name why it was put there\"; \"second-order effects · the move after the move\"; \"the 80% case vs the 20% case · which world is this decision FOR?\"",
  "   Examples (bad — too generic): \"critical thinking\", \"strategic frameworks\", \"data-driven analysis\"",
  "",
  "3. `referentSet` · 3-5 specific anchors (companies, products, events, papers, eras, people) this director routinely cites. Each NAMED + 1-line on relevance.",
  "   Format: [{ \"ref\": \"named anchor\", \"why\": \"why they cite it\" }]",
  "   Examples (good): \"Quibi · case study in mistaking a clever distribution insight for a product insight\"; \"Concorde · technology can be 30 years too early in the wrong economic regime\"; \"Theranos / Worldcom · pattern of board capture by founder charisma\"",
  "   Examples (bad — generic): \"successful tech companies\", \"market history\", \"famous failures\"",
  "",
  "4. `failureModes` · 2-3 SELF-AWARE blind spots / failure modes for this director. What goes wrong when they over-apply their own method?",
  "   Format: [\"1-line specific failure mode\"]",
  "   Examples (good): \"Tends to over-correct toward dissent when the room is already aligned, even when alignment is correct\"; \"Risks treating any non-falsifiable claim as low-quality, missing rich pre-paradigmatic ideas\"; \"Citing one historical case as if it settles a present argument\"",
  "",
  "5. `contrarianTakes` · 2-3 concrete positions this director ROUTINELY takes against the dominant industry view. Each must be a NAMED stance, not a posture.",
  "   Format: [\"1-line stance against a specific common view\"]",
  "   Examples (good): \"Brand is mostly distribution by another name — pure 'brand strategy' decks usually paper over weak channel economics\"; \"'AI-native' is rarely a feature; usually it's a marketing reframe of 'has an LLM in the workflow'\"",
  "",
  "## Output format",
  "",
  "Return ONE JSON object inside a fenced ```json block. No prose outside the block.",
  "",
  "```json",
  "{",
  "  \"intellectualLineage\": {",
  "    \"influencedBy\": [\"...\"],",
  "    \"opposedTo\": [\"...\"]",
  "  },",
  "  \"loadBearingConcepts\": [{ \"name\": \"...\", \"gloss\": \"...\" }],",
  "  \"referentSet\": [{ \"ref\": \"...\", \"why\": \"...\" }],",
  "  \"failureModes\": [\"...\"],",
  "  \"contrarianTakes\": [\"...\"]",
  "}",
  "```",
  "",
  "Constraints:",
  "· DO NOT use generic personality words. Every entry names a person / case / concept / position.",
  "· If the user description maps to a real domain (VC, product, security, biotech, monetary policy, etc.), prefer NAMED references from that domain.",
  "· Avoid recreating the canonical six (Socrates, First Principles, Long Horizon, etc.) — pick a distinct angle.",
].join("\n");

/* ────────────────────────── Stage B · spec ────────────────────────────────
 *
 * With the profile in hand, Stage B writes the actual director spec. The
 * instruction template now has 8 sections instead of 4 — the new sections
 * (intellectual lineage, load-bearing concepts, referent set, failure
 * modes) come pre-loaded with the Stage A material so the model isn't
 * inventing them on the fly.
 */
const HOUSE_STYLE = [
  "## Boardroom directors · house style",
  "",
  "Every director has seven fields:",
  "  · name         · short evocative name (1–4 words)",
  "  · handle       · slug-form `/short_name` (≤ 18 chars, lowercase + underscore)",
  "  · roleTag      · 1-word lowercase noun describing their stance (skeptic / physicist / observer / strategist / advocate / long-pattern)",
  "  · bio          · 1–2 sentences, ≤ 280 chars. Concrete, not flowery. Names the method, not the persona.",
  "  · coverQuote   · 1 sentence (≤ 200 chars). The opening question THIS director would ask in any room.",
  "  · instruction  · multi-section markdown system prompt (~1500–2800 chars). EIGHT sections, in this exact order: identity, intellectual lineage, load-bearing concepts, method (numbered), referent set, voice, boundaries, failure modes. See template below.",
  "  · ability      · 6-axis personality map (each axis 0..10). Drives a radar chart that visualizes the director's strengths and limits. Distribution MUST be uneven — see 'Ability axes' below.",
  "",
  "## Voice rules (apply to bio, coverQuote, AND instruction)",
  "",
  "· Plain prose. Specific verbs. No marketing copy, no flattery, no 'will help you'.",
  "· The bio NAMES the method (\"refuses unclear premises\" / \"reads against thirty years of category history\"), not abstract personality (\"insightful and analytical\").",
  "· Italic for the word being interrogated. Bold for the load-bearing claim.",
  "· Anti-flatter is mandatory in the boundaries section: do not preface with affirmation or summary; lead with the disagreement / missing premise.",
  "",
  "## Instruction template (eight sections — REQUIRED, in this order)",
  "",
  "Use literal `## Section name` markdown headings. Each section ~80–400 chars. Total instruction ~1500–2800 chars.",
  "",
  "```",
  "You are {Name}, a board director whose role is the {roleTag}.",
  "",
  "## Identity",
  "[1-2 sentences on who they are. Specific angle on the world, not a personality cluster.]",
  "",
  "## Intellectual lineage",
  "[Influenced by: 2-3 named thinkers / schools / traditions, each with 1 line on what they took. Pushes back against: 1-2 named traditions or dominant narratives they reject.]",
  "",
  "## Load-bearing concepts",
  "[3-5 named concepts / frames / mental tools they reach for repeatedly. Bullet list. Each entry: **concept name** · 1-line gloss on how they use it.]",
  "",
  "## Method (per turn)",
  "1. [Concrete first move — what they DO when they read the room]",
  "2. [Second step — usually where their lens applies]",
  "3. [Third step — what they SAY that converts the lens into a usable claim]",
  "4. [Optional fourth step — boundary check / next-question handoff]",
  "",
  "## Referent set",
  "[3-5 named anchors (companies, papers, events, people, eras) they will cite by name when relevant. Bullet list. Each entry: **named anchor** · 1-line relevance.]",
  "",
  "## Voice",
  "- [Format / length rule, e.g. 'one sharp question beats a paragraph']",
  "- [Lexical rule — italics / bold usage, jargon they use or refuse]",
  "- [Tone rule — direct / dry / patient / clipped, with one example]",
  "",
  "## Boundaries",
  "- Do not preface with affirmation or summary. Lead with the disagreement, missing premise, or angle the user hasn't raised.",
  "- [What they REFUSE to do — e.g. 'do not concede a definition before testing it against a counter-example']",
  "- [Stance hold — what they will NOT cave on even under push-back]",
  "",
  "## Failure modes",
  "- [1-2 self-aware blind spots. Honest, not hedging. e.g. 'Tends to over-correct toward dissent when the room is already aligned'.]",
  "```",
  "",
  "## Ability axes (0..10 per axis)",
  "",
  "A director's `ability` is six numbers — each in 0..10 — that describe how they think and argue. The radar should NOT be flat — pick 1-3 dominant axes (8-10), 1-2 weak axes (1-3), and the remainder mid (4-7). Make the shape match the role.",
  "",
  "  · dissent         · willingness to challenge, push back, raise objections, refuse to nod along",
  "  · pattern_recall  · cites history, prior cases, comparable patterns, market analogues",
  "  · rigor           · precision of argument, definitional clarity, demand for evidence",
  "  · empathy         · takes the perspective of users / stakeholders not in the room",
  "  · narrative       · storytelling, scenario-building, framing decisions as a story",
  "  · decisiveness    · willingness to commit to a recommendation, force a call",
  "",
  "Examples of healthy NON-uniform shapes:",
  "  · A skeptic                    → dissent: 9, pattern_recall: 4, rigor: 8, empathy: 4, narrative: 5, decisiveness: 4",
  "  · A first-principles physicist → dissent: 6, pattern_recall: 5, rigor: 9, empathy: 3, narrative: 4, decisiveness: 6",
  "  · A long-pattern strategist    → dissent: 4, pattern_recall: 8, rigor: 6, empathy: 5, narrative: 7, decisiveness: 6",
  "  · A user-empath                → dissent: 5, pattern_recall: 4, rigor: 5, empathy: 9, narrative: 8, decisiveness: 5",
  "  · A ruthless decider           → dissent: 7, pattern_recall: 5, rigor: 6, empathy: 3, narrative: 4, decisiveness: 9",
  "",
  "Reject any uniform vector (e.g. all 5s or all 7s) — directors must have a clear shape that matches their stated method. Total of all six axes should typically land in 30..40.",
  "",
  "## Constraints",
  "",
  "· The new director must be DISTINCT from the canonical six (Socrates, First Principles, Long Horizon, Phenomenologist, Critique Reviewer, Pattern-Match).",
  "· Pick a model from: opus-4-7 (default for nuanced / contrarian roles), opus-4-6 (deep reasoning, 1M ctx), sonnet-4-6 (faster, fine for analytical roles), haiku-4-5 (only for very tight / rule-based roles). When in doubt, opus-4-7.",
  "· The instruction MUST contain ALL EIGHT sections in the order shown. Do NOT collapse or rename sections.",
  "· EVERY entry in 'load-bearing concepts' and 'referent set' must be NAMED — concrete people, cases, papers, events. No generic placeholders ('various studies', 'historical examples', 'modern frameworks').",
  "",
  "## Output format",
  "",
  "Return one JSON object inside a fenced ```json code block. No prose outside the block.",
  "",
  "```json",
  "{",
  "  \"name\": \"...\",",
  "  \"handle\": \"/short_form\",",
  "  \"roleTag\": \"skeptic\",",
  "  \"bio\": \"1-2 sentences, ≤ 280 chars\",",
  "  \"coverQuote\": \"the question they'd open every room with, ≤ 200 chars\",",
  "  \"instruction\": \"You are X, a board director...\\n\\n## Identity\\n...\\n\\n## Intellectual lineage\\n...\\n\\n## Load-bearing concepts\\n...\\n\\n## Method (per turn)\\n1. ...\\n\\n## Referent set\\n...\\n\\n## Voice\\n- ...\\n\\n## Boundaries\\n- ...\\n\\n## Failure modes\\n- ...\",",
  "  \"modelV\": \"opus-4-7\",",
  "  \"ability\": { \"dissent\": 9, \"pattern_recall\": 4, \"rigor\": 8, \"empathy\": 4, \"narrative\": 5, \"decisiveness\": 4 }",
  "}",
  "```",
].join("\n");

/* ─────────────────────────── Stage A · profile ─────────────────────────── */

export interface AgentProfile {
  intellectualLineage: {
    influencedBy: string[];
    opposedTo: string[];
  };
  loadBearingConcepts: { name: string; gloss: string }[];
  referentSet: { ref: string; why: string }[];
  failureModes: string[];
  contrarianTakes: string[];
}

export interface AgentProfileOpts {
  description: string;
  /** Optional web-search results, formatted as a brief context block.
   *  Empty / null when web search is OFF or returned no results. */
  webContext?: string | null;
}

export function buildAgentProfileMessages(opts: AgentProfileOpts): LLMMessage[] {
  const web = (opts.webContext || "").trim();
  const userBody: string[] = [
    "User description of the director they want:",
    "",
    opts.description.trim(),
  ];
  if (web) {
    userBody.push(
      "",
      "Reference material from the web (use to ground NAMED references — do not quote verbatim, distill into the profile fields):",
      "",
      web,
    );
  }
  userBody.push(
    "",
    "Now produce the profile JSON object as specified.",
  );
  return [
    { role: "system", content: PROFILE_SYSTEM },
    { role: "user", content: userBody.join("\n") },
  ];
}

/* ─────────────────────────── Stage B · spec ────────────────────────────── */

export interface AgentSpecOpts {
  description: string;
  /** Stage-A profile · always passed when available. The instruction
   *  template's lineage / concepts / referent / failure-modes sections
   *  pull directly from this so the model isn't reinventing them. */
  profile?: AgentProfile | null;
  /** Optional web context · the same block fed to Stage A, repeated
   *  here so Stage B can also cite it directly when writing referent
   *  set entries. */
  webContext?: string | null;
}

export function buildAgentSpecMessages(opts: AgentSpecOpts): LLMMessage[] {
  const userBody: string[] = [
    "I want a new boardroom director described as:",
    "",
    opts.description.trim(),
  ];
  if (opts.profile) {
    userBody.push(
      "",
      "## Profile (use this as the source for the lineage / concepts / referent / failure-modes sections)",
      "",
      "```json",
      JSON.stringify(opts.profile, null, 2),
      "```",
      "",
      "Translate the profile into the EIGHT-section instruction template literally — every named entry in `loadBearingConcepts` and `referentSet` must appear in the matching instruction section. The `failureModes` section of the spec mirrors `failureModes` from the profile. The Identity + Intellectual lineage sections may paraphrase but must keep the named influences.",
    );
  }
  if (opts.webContext && opts.webContext.trim()) {
    userBody.push(
      "",
      "## Web reference material (background, may corroborate referent set entries)",
      "",
      opts.webContext.trim(),
    );
  }
  userBody.push(
    "",
    "Generate the full spec in the JSON format above. Match the house voice exactly.",
  );
  return [
    { role: "system", content: HOUSE_STYLE },
    { role: "user", content: userBody.join("\n") },
  ];
}

/* ─────────────────────── parser + validation ──────────────────────────── */

export interface AgentSpec {
  name: string;
  handle: string;
  roleTag: string;
  bio: string;
  coverQuote: string;
  instruction: string;
  modelV: string;
  /** 6-axis radar profile · {axis: 0..10}. Empty when the LLM didn't
   *  produce a usable ability map; the agents route falls back to a
   *  heuristic distribution in that case. */
  ability: Record<string, number>;
}

const ABILITY_AXES = [
  "dissent",
  "pattern_recall",
  "rigor",
  "empathy",
  "narrative",
  "decisiveness",
] as const;

function parseAbility(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const axis of ABILITY_AXES) {
    const v = obj[axis];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    out[axis] = Math.max(0, Math.min(10, Math.round(v)));
  }
  // Reject obviously-flat vectors (all same value) — the prompt forbids
  // them; if the model returned one anyway, drop it so the route's
  // fallback distribution kicks in.
  const values = Object.values(out);
  if (values.length < 4) return {};
  const allSame = values.every((v) => v === values[0]);
  if (allSame) return {};
  return out;
}

const ALLOWED_MODELS = new Set([
  "sonnet-4-6", "opus-4-6", "opus-4-7", "haiku-4-5",
  "gpt-5-5", "gpt-5-4", "gpt-5-4-mini",
  "gemini-3-1", "gemini-3-flash", "gemini-3-1-flash",
  "grok-4-3", "grok-4-1-fast",
  "deepseek-v4-pro", "deepseek-v4-flash",
]);

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trim();
}

function extractJson<T>(raw: string): T | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fence ? fence[1] : raw;
  if (!candidate) return null;
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Validate + coerce a generated spec. Returns null only if essential
 *  fields are missing — name, bio, instruction. Other fields are
 *  trimmed / defaulted. */
export function parseAgentSpec(raw: string): AgentSpec | null {
  const parsed = extractJson<Record<string, unknown>>(raw);
  if (!parsed) return null;

  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const bio = typeof parsed.bio === "string" ? parsed.bio.trim() : "";
  const instruction = typeof parsed.instruction === "string" ? parsed.instruction.trim() : "";
  if (name.length < 2 || bio.length < 8 || instruction.length < 1) return null;

  const handleRaw = typeof parsed.handle === "string" ? parsed.handle.trim() : "";
  const handle = handleRaw
    ? handleRaw.replace(/^[@/]+/, "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 18)
    : name.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 18);

  const roleTagRaw = typeof parsed.roleTag === "string" ? parsed.roleTag.trim().toLowerCase() : "";
  const roleTag = roleTagRaw && roleTagRaw.length >= 3 && roleTagRaw.length <= 32
    ? roleTagRaw
    : "custom";

  const coverQuote = typeof parsed.coverQuote === "string" ? clamp(parsed.coverQuote.trim(), 200) : "";
  const modelRaw = typeof parsed.modelV === "string" ? parsed.modelV.trim() : "";
  const modelV = ALLOWED_MODELS.has(modelRaw) ? modelRaw : "opus-4-7";
  const ability = parseAbility(parsed.ability);

  return {
    name: clamp(name, 32),
    handle: handle || "new_agent",
    roleTag,
    bio: clamp(bio, 280),
    coverQuote,
    // Bumped from 4000 → 6000 to accommodate the new eight-section
    // instruction template (~1500-2800 chars typical, with headroom
    // for richer concept / referent lists).
    instruction: clamp(instruction, 6000),
    modelV,
    ability,
  };
}

/** Validate + coerce a Stage-A profile. Returns null when the JSON is
 *  missing or so degraded it can't seed Stage B (no concepts AND no
 *  referents — the two fields the spec template depends on). Drops
 *  individual entries that don't carry a name/ref so the spec generator
 *  doesn't see empty placeholders. */
export function parseAgentProfile(raw: string): AgentProfile | null {
  const parsed = extractJson<Record<string, unknown>>(raw);
  if (!parsed) return null;

  const lineage = (parsed.intellectualLineage && typeof parsed.intellectualLineage === "object")
    ? parsed.intellectualLineage as Record<string, unknown>
    : {};
  const influencedByRaw = Array.isArray(lineage.influencedBy) ? lineage.influencedBy : [];
  const opposedToRaw = Array.isArray(lineage.opposedTo) ? lineage.opposedTo : [];
  const influencedBy = influencedByRaw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => clamp(s.trim(), 200))
    .slice(0, 5);
  const opposedTo = opposedToRaw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => clamp(s.trim(), 200))
    .slice(0, 4);

  const conceptsRaw = Array.isArray(parsed.loadBearingConcepts) ? parsed.loadBearingConcepts : [];
  const loadBearingConcepts = conceptsRaw
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => ({
      name: typeof c.name === "string" ? clamp(c.name.trim(), 80) : "",
      gloss: typeof c.gloss === "string" ? clamp(c.gloss.trim(), 200) : "",
    }))
    .filter((c) => c.name.length > 0)
    .slice(0, 6);

  const referentsRaw = Array.isArray(parsed.referentSet) ? parsed.referentSet : [];
  const referentSet = referentsRaw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      ref: typeof r.ref === "string" ? clamp(r.ref.trim(), 80) : "",
      why: typeof r.why === "string" ? clamp(r.why.trim(), 200) : "",
    }))
    .filter((r) => r.ref.length > 0)
    .slice(0, 6);

  const failureModesRaw = Array.isArray(parsed.failureModes) ? parsed.failureModes : [];
  const failureModes = failureModesRaw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => clamp(s.trim(), 220))
    .slice(0, 4);

  const contrarianTakesRaw = Array.isArray(parsed.contrarianTakes) ? parsed.contrarianTakes : [];
  const contrarianTakes = contrarianTakesRaw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => clamp(s.trim(), 220))
    .slice(0, 4);

  // If both of the spec-template-load-bearing fields are empty we bail
  // out so the route falls back to single-stage generation instead of
  // feeding a useless profile downstream.
  if (loadBearingConcepts.length === 0 && referentSet.length === 0) return null;

  return {
    intellectualLineage: { influencedBy, opposedTo },
    loadBearingConcepts,
    referentSet,
    failureModes,
    contrarianTakes,
  };
}
