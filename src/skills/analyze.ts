/**
 * Skill ability auto-analyzer.
 *
 * Given a skill's name + description + when_to_use + body markdown,
 * asks a cheap LLM to estimate how installing this skill shifts the
 * agent's six ability axes. Used as a fallback when the user's
 * Skill.md frontmatter doesn't include an explicit `ability:` block —
 * manual values still win when present.
 *
 * Best-effort. Returns an empty map on any failure (no key, parse
 * error, network); the skill installs with no deltas in that case.
 */
import { callLLM, NoKeyError, type LLMMessage } from "../ai/adapter.js";
import type { ModelV } from "../ai/registry.js";

import { ABILITY_AXES, type AbilityAxis } from "./axes.js";

const ANALYZER_MODEL: ModelV = "haiku-4-5" as ModelV;

/** Boardroom-specific descriptions of each axis. The model needs the
 *  semantic anchor to map a skill to the right axes (otherwise it'll
 *  guess based on the literal axis names, which is noisy). */
const AXIS_DESCRIPTIONS: Record<AbilityAxis, string> = {
  dissent: "willingness to challenge, push back, disagree, raise objections, refuse to nod along",
  pattern_recall: "ability to cite history, prior cases, comparable patterns, market analogues, what's been tried before",
  rigor: "precision of argument, definitional clarity, logical strictness, demand for evidence and crisp reasoning",
  empathy: "ability to take the perspective of users, customers, or stakeholders not in the room — voice for absent parties",
  narrative: "storytelling, scenario-building, painting an arc, framing decisions as a story",
  decisiveness: "willingness to commit to a recommendation, cut losing threads, force a call rather than keep options open",
};

export interface AnalyzeInput {
  name: string;
  description: string;
  whenToUse?: string;
  bodyMd?: string;
}

/** Tolerant JSON extractor — strips ``` fences, attempts straight parse,
 *  then a slice between the first { and last }. */
function extractJson(text: string): unknown | null {
  if (!text) return null;
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const open = s.indexOf("{");
  const close = s.lastIndexOf("}");
  if (open >= 0 && close > open) {
    try { return JSON.parse(s.slice(open, close + 1)); } catch { return null; }
  }
  return null;
}

export async function analyzeSkillAbility(
  input: AnalyzeInput,
  signal?: AbortSignal,
): Promise<Record<AbilityAxis, number>> {
  const axesBlock = ABILITY_AXES
    .map((a) => `- ${a}: ${AXIS_DESCRIPTIONS[a]}`)
    .join("\n");
  // Cap body so we don't pay for huge skill documents — the first
  // ~2KB carries the intent in nearly every real-world skill.
  const body = (input.bodyMd || "").slice(0, 2048);

  const sys: LLMMessage = {
    role: "system",
    content: [
      "You analyze skills installed on AI agents that participate in multi-agent discussions ('boardrooms'). Each agent is rated on 6 axes (0-10).",
      "",
      "Your job: estimate how installing THIS skill shifts those axes — return integer deltas in [-3, 3] for each.",
      "",
      "Axes:",
      axesBlock,
      "",
      "Rules:",
      "- Output STRICT JSON ONLY. No prose, no markdown, no code fences.",
      "- Format exactly: {\"dissent\": N, \"pattern_recall\": N, \"rigor\": N, \"empathy\": N, \"narrative\": N, \"decisiveness\": N}",
      "- Each N is an integer in [-3, 3]. +3 strongly boosts the axis; -3 strongly damps it; 0 means no meaningful change.",
      "- A typical skill moves 1–3 axes. Be conservative — assign non-zero only where the skill clearly biases that axis.",
      "- The deltas should reflect HOW the agent thinks/argues differently after installing this skill, not the skill's topic.",
    ].join("\n"),
  };

  const user: LLMMessage = {
    role: "user",
    content: [
      `Skill name: ${input.name}`,
      ``,
      `Description: ${input.description}`,
      ...(input.whenToUse && input.whenToUse !== input.description
        ? [``, `When to use: ${input.whenToUse}`]
        : []),
      ...(body ? [``, `Body:`, body] : []),
      ``,
      `Estimate axis deltas as JSON.`,
    ].join("\n"),
  };

  let raw = "";
  try {
    raw = await callLLM({
      modelV: ANALYZER_MODEL,
      messages: [sys, user],
      temperature: 0,
      maxTokens: 200,
      signal,
    });
  } catch (e) {
    if (e instanceof NoKeyError) return {} as Record<AbilityAxis, number>;
    process.stderr.write(
      `[skills/analyze] analysis failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return {} as Record<AbilityAxis, number>;
  }

  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") {
    return {} as Record<AbilityAxis, number>;
  }

  const out: Record<AbilityAxis, number> = {} as Record<AbilityAxis, number>;
  const obj = parsed as Record<string, unknown>;
  for (const axis of ABILITY_AXES) {
    const v = obj[axis];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const clamped = Math.max(-3, Math.min(3, Math.round(v)));
    if (clamped !== 0) out[axis] = clamped;
  }
  return out;
}
