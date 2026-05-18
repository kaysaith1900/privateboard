/**
 * Post-pipeline narrator · turns the structured `BuildEvent[]` log from
 * a Full-persona build into a 200-400 word pitch-style summary in the
 * user's locale. Shown as the hero block of the Build-log modal on the
 * agent profile.
 *
 * Why a separate file (not a method on persona-builder.ts):
 *   · The narrator's input is "what already happened" — it reads the
 *     completed event log, never injects new events back into the bus.
 *     Keeping it isolated makes the contract obvious.
 *   · The narrative is the only place in the build pipeline that has
 *     locale-sensitive output. The prompt steers tone + bans jargon
 *     up front; co-locating with other phase prompts buries the
 *     intent.
 *
 * Failure is non-fatal · the caller saves `narrative: ""` and the UI
 * falls back to rendering the timeline + a static "this agent was built
 * across 7 phases" line.
 */
import { callLLMWithUsage } from "../ai/adapter.js";
import { effectiveDefaultModel, FLAGSHIP_TIER, reachableModels, utilityModelFor } from "../ai/availability.js";
import { isModelV } from "../ai/registry.js";
import type { AgentProfile } from "../ai/prompts/agent-spec.js";

import type { BuildEvent } from "./persona-stream.js";

interface NarratorState {
  controller: AbortController;
  /** Lifetime counters · narrator bumps these so the build's overall
   *  token total in `state.totalPromptTokens` / `state.totalOutputTokens`
   *  reflects the narrator's spend too. Passed by reference (mutated
   *  in place) from the orchestrator's `state` object. */
  totalPromptTokens: number;
  totalOutputTokens: number;
}

interface NarratorInput {
  description: string;
  locale: "en" | "zh" | "ja" | "es";
  events: BuildEvent[];
  profileV2: AgentProfile | null;
  differentiationScore: number | null;
  guessName: string | null;
}

const NARRATOR_TIMEOUT_MS = 60_000;
const NARRATOR_MAX_TOKENS = 900;

/** Pick narrator model · prefer utility tier (cheap), fall back to
 *  flagship reachable. Mirrors the naming-pass selection in
 *  persona-builder.ts so the same model handles both small post-
 *  pipeline jobs. */
function narratorCandidates(): string[] {
  const out: string[] = [];
  const utility = utilityModelFor();
  if (utility) out.push(utility);
  const flagship = effectiveDefaultModel();
  if (flagship && !out.includes(flagship)) out.push(flagship);
  for (const m of reachableModels()) {
    if (FLAGSHIP_TIER.has(m.modelV) && !out.includes(m.modelV)) out.push(m.modelV);
  }
  return out;
}

const LOCALE_HINTS: Record<NarratorInput["locale"], string> = {
  en: "Write the summary in clear, warm English.",
  zh: "用流畅自然的简体中文写这段总述。",
  ja: "親しみやすい自然な日本語で書いてください。",
  es: "Escribe el resumen en español claro y cercano.",
};

/** Compact, machine-readable rollup of the events list. The narrator
 *  prompt asks for a narrative summary; this gives it the raw material
 *  in a form short enough to fit comfortably in the context window
 *  even on long builds. */
function summarizeEvents(events: BuildEvent[]): string {
  const phases: Array<{ phase: number; label: string; durationMs?: number }> = [];
  const searchesByDim = new Map<string, { count: number; sources: number; queries: string[] }>();
  const topupSearches: Array<{ query: string; sources: number }> = [];
  let dimensionPlan: Array<{ dimension: string; query: string; why: string }> = [];
  let divergenceScore: number | null = null;

  for (const e of events) {
    if (e.kind === "phase-start") {
      phases.push({ phase: e.phase, label: e.label });
    } else if (e.kind === "phase-end") {
      const found = phases.find((p) => p.phase === e.phase);
      if (found) found.durationMs = e.durationMs;
    } else if (e.kind === "dimension-plan") {
      dimensionPlan = e.dimensions;
    } else if (e.kind === "search") {
      if (e.topup) {
        topupSearches.push({ query: e.query, sources: e.pagesRead });
      } else if (e.dimension) {
        const cur = searchesByDim.get(e.dimension) ?? { count: 0, sources: 0, queries: [] };
        cur.count += 1;
        cur.sources += e.pagesRead;
        cur.queries.push(e.query);
        searchesByDim.set(e.dimension, cur);
      }
    } else if (e.kind === "divergence") {
      divergenceScore = e.score;
    }
  }

  const lines: string[] = [];
  lines.push("Phases that ran:");
  for (const p of phases) {
    const dur = typeof p.durationMs === "number" ? ` (${Math.round(p.durationMs / 1000)}s)` : "";
    lines.push(`  ${p.phase}. ${p.label}${dur}`);
  }
  if (dimensionPlan.length > 0) {
    lines.push("");
    lines.push(`Research angles (picked by the planner, ${dimensionPlan.length} total):`);
    for (const d of dimensionPlan) {
      const stats = searchesByDim.get(d.dimension);
      const tail = stats ? ` — ${stats.sources} sources read` : "";
      lines.push(`  • ${d.dimension}: ${d.why || d.query}${tail}`);
    }
  }
  if (topupSearches.length > 0) {
    lines.push("");
    lines.push(`Top-up gap searches (${topupSearches.length}):`);
    for (const t of topupSearches) {
      lines.push(`  • "${t.query}" → ${t.sources} sources`);
    }
  }
  if (divergenceScore !== null) {
    lines.push("");
    lines.push(`Voice uniqueness vs generic AI baseline: ${Math.round(divergenceScore * 100)}%`);
  }
  return lines.join("\n");
}

const NARRATOR_SYSTEM = [
  "You are writing a short, pitch-style summary of how a custom AI persona was just built.",
  "",
  "Audience: the person who kicked the build. They watched a progress bar — they have no idea what the pipeline actually DID under the hood. Your job is to tell them, in plain language.",
  "",
  "Hard rules:",
  "  1. NEVER use jargon. Do NOT say 'multi-dimensional retrieval', 'ReAct loop', 'lexical divergence', 'parallel batch', 'synthesis', 'critique pass', 'eval set', 'differentiation probe'.",
  "  2. Instead, say things like: 'we looked at the question from several different angles', 'we double-checked a couple of gaps', 'we drafted the personality twice — once cold, once after reading up', 'this voice came out N% different from a generic AI'.",
  "  3. First-person plural ('we'). Warm tone. Short sentences. 3-5 short paragraphs.",
  "  4. Use specific details from the build log — name the angles by name, mention concrete sources-read counts, quote a sample query if it helps.",
  "  5. Stay between 200 and 400 words.",
  "  6. Do NOT use Markdown. Plain prose only, no headers, no bullet points.",
  "  7. Do NOT mention the model name, the agent's database id, or any internal terminology.",
  "  8. End with a single short sentence that invites the user to talk to the new director.",
].join("\n");

/** Run the narrator pass. Returns the trimmed narrative on success or
 *  the empty string on any failure (parse, abort, no model, etc.). */
export async function runPersonaNarrator(
  state: NarratorState,
  input: NarratorInput,
): Promise<string> {
  const eventsSummary = summarizeEvents(input.events);
  if (!eventsSummary.trim()) return "";

  const profileBlock = input.profileV2
    ? [
        "Persona shape (refined):",
        "",
        "```json",
        JSON.stringify(
          {
            intellectualLineage: input.profileV2.intellectualLineage,
            contrarianTakes: input.profileV2.contrarianTakes,
            loadBearingConcepts: input.profileV2.loadBearingConcepts,
          },
          null,
          2,
        ),
        "```",
      ].join("\n")
    : "";

  const userBody = [
    `What the user asked us to build:`,
    ``,
    input.description.trim(),
    ``,
    input.guessName ? `Director we ended up naming: ${input.guessName}` : "",
    "",
    "Build log (structured):",
    "",
    eventsSummary,
    "",
    profileBlock,
    "",
    LOCALE_HINTS[input.locale],
    "",
    "Now write the 200-400 word pitch-style summary.",
  ]
    .filter((s) => s !== "")
    .join("\n");

  const messages = [
    { role: "system" as const, content: NARRATOR_SYSTEM },
    { role: "user" as const, content: userBody },
  ];

  const candidates = narratorCandidates();
  for (const modelV of candidates) {
    if (!isModelV(modelV)) continue;
    if (state.controller.signal.aborted) return "";
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    state.controller.signal.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), NARRATOR_TIMEOUT_MS);
    try {
      const r = await callLLMWithUsage({
        modelV,
        messages,
        temperature: 0.7,
        maxTokens: NARRATOR_MAX_TOKENS,
        signal: controller.signal,
      });
      if (r.usage) {
        state.totalPromptTokens += r.usage.promptTokens;
        state.totalOutputTokens += r.usage.completionTokens;
      }
      const out = (r.text || "").trim();
      if (out.length >= 80) return out;
    } catch (e) {
      process.stderr.write(`[persona-narrator] ${modelV} failed: ${e instanceof Error ? e.message : String(e)}\n`);
    } finally {
      clearTimeout(timer);
      state.controller.signal.removeEventListener("abort", onParentAbort);
    }
  }
  return "";
}
