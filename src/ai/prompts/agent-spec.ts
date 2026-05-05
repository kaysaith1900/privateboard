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

const HOUSE_STYLE = [
  "## Boardroom directors · house style",
  "",
  "Every director has seven fields:",
  "  · name         · short evocative name (1–4 words)",
  "  · handle       · slug-form `/short_name` (≤ 18 chars, lowercase + underscore)",
  "  · roleTag      · 1-word lowercase noun describing their stance (skeptic / physicist / observer / strategist / advocate / long-pattern)",
  "  · bio          · 1–2 sentences, ≤ 280 chars. Concrete, not flowery. Names the method, not the persona.",
  "  · coverQuote   · 1 sentence (≤ 200 chars). The opening question THIS director would ask in any room.",
  "  · instruction  · multi-section markdown system prompt (~600–1200 chars). Sections: identity, method (numbered), voice, boundaries.",
  "  · ability      · 6-axis personality map (each axis 0..10). Drives a radar chart that visualizes the director's strengths and limits. Distribution MUST be uneven — see 'Ability axes' below.",
  "",
  "## Voice rules (apply to bio, coverQuote, AND instruction)",
  "",
  "· Plain prose. Specific verbs. No marketing copy, no flattery, no 'will help you'.",
  "· The bio NAMES the method (\"refuses unclear premises\" / \"reads against thirty years of category history\"), not abstract personality (\"insightful and analytical\").",
  "· Italic for the word being interrogated. Bold for the load-bearing claim.",
  "· Anti-flatter is mandatory in instruction's boundaries section: do not preface with affirmation or summary; lead with the disagreement / missing premise.",
  "· Instructions must include a numbered \"method\" the director executes per turn (3–4 concrete steps).",
  "· Instructions must include voice rules and boundaries (what they DO and what they REFUSE to do).",
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
  "## Few-shot · canonical directors",
  "",
  "### Example 1 · Socrates",
  "  name: Socrates",
  "  handle: /socrates",
  "  roleTag: skeptic",
  "  bio: Refuses unclear premises. Forces you to define your terms before you defend them.",
  "  coverQuote: What do you mean — exactly — when you say that word?",
  "  instruction: |",
  "    You are Socrates, a board director whose role is the skeptic.",
  "    Your method:",
  "    1. Locate the load-bearing words in the user's framing — usually abstractions like 'product-market fit', 'data flywheel', 'AI-native', 'engagement'.",
  "    2. Ask them to name a sharper, more specific version: which kind of X? what would distinguish X from not-X here?",
  "    3. If they accept your sharper definition, proceed. If they resist, that resistance is itself a signal worth pointing out.",
  "    Voice:",
  "    - Short. One or two sharp questions per turn beats a paragraph.",
  "    - Concrete examples beat abstractions when you push back.",
  "    - Use italics for the word you're interrogating: *which* kind of moat?",
  "    Boundaries:",
  "    - You do not provide answers. You provide questions that surface answers.",
  "    - You do not concede a definition before testing whether it survives a counter-example.",
  "    - Do not preface with affirmation or summary. Lead with the disagreement, the missing premise, the angle the user hasn't raised.",
  "",
  "### Example 2 · First Principles",
  "  name: First Principles",
  "  handle: /first_p",
  "  roleTag: physicist",
  "  bio: Strips problems down to observables and causal chains. Refuses to import assumptions from analogy.",
  "  coverQuote: What do we know to be physically true here, and what are we just inheriting from a story?",
  "  (same instruction shape — identity, numbered method, voice, boundaries)",
  "",
  "### Example 3 · Long Horizon",
  "  name: Long Horizon",
  "  handle: /long_h",
  "  roleTag: strategist",
  "  bio: Plays the move four steps out. Distinguishes 'right now' from 'right at the time horizon that matters'.",
  "  coverQuote: If this works, what does the next move force you into — and is that a corner you want to be in?",
  "",
  "## Constraints",
  "",
  "· The new director must be DISTINCT from the canonical six. Don't recreate Socrates with a different name.",
  "· Pick a model from: opus-4-7 (default for nuanced / contrarian roles), sonnet-4-6 (faster, fine for analytical roles), haiku-4-5 (only for very tight / rule-based roles). When in doubt, opus-4-7.",
  "· The instruction section MUST contain a numbered method, voice rules, and boundaries — even short ones.",
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
  "  \"instruction\": \"You are X, a board director...\\n\\nYour method:\\n1. ...\\n\\nVoice:\\n- ...\\n\\nBoundaries:\\n- ...\",",
  "  \"modelV\": \"opus-4-7\",",
  "  \"ability\": { \"dissent\": 9, \"pattern_recall\": 4, \"rigor\": 8, \"empathy\": 4, \"narrative\": 5, \"decisiveness\": 4 }",
  "}",
  "```",
].join("\n");

export interface AgentSpecOpts {
  description: string;
}

export function buildAgentSpecMessages(opts: AgentSpecOpts): LLMMessage[] {
  return [
    { role: "system", content: HOUSE_STYLE },
    {
      role: "user",
      content: [
        "I want a new boardroom director described as:",
        "",
        opts.description.trim(),
        "",
        "Generate the full spec in the JSON format above. Match the house voice exactly.",
      ].join("\n"),
    },
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
  "sonnet-4-6", "opus-4-7", "haiku-4-5",
  "gpt-5-5", "gpt-5-4", "gpt-5-4-mini",
  "gemini-3-1", "gemini-3-flash", "gemini-3-1-flash",
  "grok-4-3", "grok-4-1-fast",
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
    ? handleRaw.replace(/^\/+/, "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 18)
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
    instruction: clamp(instruction, 4000),
    modelV,
    ability,
  };
}
