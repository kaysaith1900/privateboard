/**
 * Director auto-picker.
 *
 * Given a room subject and the available director catalog, asks a
 * cheap LLM (haiku) to pick a 3-director cast that gives the user
 * good COVERAGE OF PERSPECTIVES — not just topical similarity. The
 * boardroom's value comes from multi-lens reading; if every director
 * would say the same thing, the pick has failed.
 *
 * After the LLM returns its picks, we run a deterministic diversity
 * guardrail: the cast must cover at least 2 of the four "lens types"
 * — { dissent, rigor, empathy, pattern_recall } — measured against
 * each director's `ability` map. If the LLM's pick fails the rule,
 * we swap the weakest member for a director that fills the gap.
 *
 * Failures (no key, network, parse error, no candidates) fall back
 * silently to a canonical triple. Callers always get 3 directors.
 */
import { callLLM, NoKeyError, type LLMMessage } from "../ai/adapter.js";
import { effectiveDefaultModel, utilityModelFor } from "../ai/availability.js";
import type { ModelV } from "../ai/registry.js";
import type { Agent } from "../storage/agents.js";
import { bareHandleSlug } from "../utils/agent-handle.js";

/** Match LLM / legacy output (`/foo`) to catalog rows stored as `@foo`. */
function resolveCatalogAgent(candidates: Agent[], handleRaw: string): Agent | undefined {
  const t = handleRaw.trim();
  if (!t) return undefined;
  const bare = bareHandleSlug(t);
  return (
    candidates.find((a) => a.handle === t) ??
    candidates.find((a) => bareHandleSlug(a.handle) === bare)
  );
}

/** Auto-pick is one of the most consequential routing decisions in
 *  the room (which 3 directors get seated determines the room's whole
 *  character), so we use the user's configured DEFAULT model — not
 *  the cheap utility tier. The previous hardcoded `haiku-4-5` ignored
 *  the user's preference entirely AND silently failed when haiku
 *  wasn't reachable on their carrier (OpenAI / Google / xAI direct
 *  with no OR or Anthropic key) — falling back to the canonical
 *  triple every time. Resolved per-call so a key change mid-session
 *  is honoured immediately. */
function resolvePickerModel(): ModelV | null {
  const def = effectiveDefaultModel();
  if (def) return def;
  // Fallback when the user has no default model set (rare — the
  // reconcile sweep usually back-fills one). Try the cheap tier so
  // we still pick SOMETHING reachable rather than throwing.
  return utilityModelFor();
}
const TARGET_CAST_SIZE = 3;
/** The 4 lens types the cast must cover at least 2 of. Tied to the
 *  ability axes a director scores well on; "high" means ≥ 7 of 10. */
const LENS_AXES = ["dissent", "rigor", "empathy", "pattern_recall"] as const;
const LENS_THRESHOLD = 7;

export interface DirectorPick {
  agentId: string;
  reason: string;
}
export interface DirectorPickResult {
  picks: DirectorPick[];
  /** One-line explanation the picker gave for the cast as a whole. */
  rationale: string;
  /** Whether the LLM produced this cast (false = silent fallback). */
  fromLlm: boolean;
}

function clipString(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trim();
}

function describeDirector(a: Agent, recentCount: number): string {
  const ability = a.ability ? Object.entries(a.ability)
    .filter(([, v]) => typeof v === "number" && v >= LENS_THRESHOLD)
    .map(([k, v]) => `${k}:${v}`)
    .join(",") : "";
  const bio = clipString(a.bio || "", 140).replace(/\s+/g, " ");
  const tag = (a.roleTag || "director").toLowerCase();
  // Recency tag · the picker prompt instructs the model to prefer
  // directors with low recency counts when topical fit is comparable.
  // Format is "[seen N/5]" so the model has a numeric anchor.
  const recencyTag = recentCount > 0 ? ` · [seen ${recentCount}/5 recent rooms]` : ` · [unseen recently]`;
  return `- ${a.handle} · ${a.name} · ${tag} · "${bio}"${ability ? ` · strong on { ${ability} }` : ""}${recencyTag}`;
}

function tolerantJson<T>(raw: string): T | null {
  if (!raw) return null;
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(s) as T; } catch { /* fall through */ }
  const open = s.indexOf("{");
  const close = s.lastIndexOf("}");
  if (open >= 0 && close > open) {
    try { return JSON.parse(s.slice(open, close + 1)) as T; } catch { return null; }
  }
  return null;
}

/** Compute which lens types the given cast already covers. */
function coveredLenses(cast: Agent[]): Set<string> {
  const covered = new Set<string>();
  for (const a of cast) {
    if (!a.ability) continue;
    for (const axis of LENS_AXES) {
      const v = a.ability[axis];
      if (typeof v === "number" && v >= LENS_THRESHOLD) covered.add(axis);
    }
  }
  return covered;
}

/** Find the best director outside `cast` who'd cover one of `gaps`. */
function findGapFiller(
  candidates: Agent[],
  cast: Agent[],
  gaps: Set<string>,
): Agent | null {
  const inCast = new Set(cast.map((a) => a.id));
  let best: { a: Agent; score: number } | null = null;
  for (const a of candidates) {
    if (inCast.has(a.id)) continue;
    if (!a.ability) continue;
    let score = 0;
    for (const axis of gaps) {
      const v = a.ability[axis];
      if (typeof v === "number" && v >= LENS_THRESHOLD) score += v;
    }
    if (score > 0 && (!best || score > best.score)) best = { a, score };
  }
  return best?.a ?? null;
}

/** Drop the least-essential cast member to make room for a gap filler.
 *  Heuristic: remove the one whose ability axes are most redundant
 *  with another cast member (highest overlap on covered lenses). */
function pickRedundantMember(cast: Agent[]): Agent {
  if (cast.length <= 1) return cast[0];
  let worst: { a: Agent; redundancy: number } | null = null;
  for (const a of cast) {
    if (!a.ability) {
      // No ability data → most expendable
      return a;
    }
    let redundancy = 0;
    for (const b of cast) {
      if (a.id === b.id || !b.ability) continue;
      for (const axis of LENS_AXES) {
        const av = a.ability[axis];
        const bv = b.ability[axis];
        if (typeof av === "number" && typeof bv === "number" && av >= LENS_THRESHOLD && bv >= LENS_THRESHOLD) {
          redundancy++;
        }
      }
    }
    if (!worst || redundancy > worst.redundancy) worst = { a, redundancy };
  }
  return worst!.a;
}

/** Diversity guardrail · ensures the cast covers ≥ 2 of the four lens
 *  types. Swaps out the most redundant member for a gap-filler if the
 *  LLM's pick failed the rule. */
function enforceDiversity(picks: Agent[], candidates: Agent[]): Agent[] {
  const cast = picks.slice();
  let safety = 4;
  while (safety-- > 0) {
    const covered = coveredLenses(cast);
    if (covered.size >= 2) return cast;
    // Find gaps (lenses we DON'T cover) and swap a redundant member
    // for someone who fills one of them.
    const gaps = new Set<string>(LENS_AXES.filter((x) => !covered.has(x)));
    const filler = findGapFiller(candidates, cast, gaps);
    if (!filler) return cast; // catalog can't help; ship what we have
    const drop = pickRedundantMember(cast);
    const idx = cast.findIndex((a) => a.id === drop.id);
    if (idx < 0) return cast;
    cast[idx] = filler;
  }
  return cast;
}

/** Canonical fallback · used when the LLM call fails or returns no
 *  usable picks. Preference order: by handle if those exist (the
 *  seeded triple is socrates / first-principles / user-empathy),
 *  otherwise the first three available directors. */
function fallbackCast(candidates: Agent[]): Agent[] {
  if (candidates.length <= TARGET_CAST_SIZE) return candidates.slice();
  const preferredHandles = ["@socrates", "@first_p", "@user_e"];
  const preferred = preferredHandles
    .map((h) => resolveCatalogAgent(candidates, h))
    .filter((a): a is Agent => !!a);
  if (preferred.length >= TARGET_CAST_SIZE) return preferred.slice(0, TARGET_CAST_SIZE);
  // Fill in with first-N from the remaining catalog.
  const seen = new Set(preferred.map((a) => a.id));
  const fill = candidates.filter((a) => !seen.has(a.id)).slice(0, TARGET_CAST_SIZE - preferred.length);
  return [...preferred, ...fill];
}

/** Pick a 3-director cast for the given room subject. */
export async function pickDirectors(opts: {
  subject: string;
  candidates: Agent[];
  /** Recent-appearance count keyed by agentId · directors seated in
   *  recent rooms get downweighted in the prompt so the user doesn't
   *  keep seeing the same trio for similar topics. Empty / missing
   *  map → no recency bias (first room of the install, or test path). */
  recentAppearances?: Map<string, number>;
}): Promise<DirectorPickResult> {
  const { subject, candidates } = opts;
  const recent = opts.recentAppearances ?? new Map<string, number>();
  // Trivial cases · ≤ 3 directors total: seat them all, no algorithm.
  if (candidates.length <= TARGET_CAST_SIZE) {
    return {
      picks: candidates.map((a) => ({ agentId: a.id, reason: "" })),
      rationale: "fewer directors than target cast size",
      fromLlm: false,
    };
  }

  const sys: LLMMessage = {
    role: "system",
    content: [
      "You are choosing a 3-director cast for a boardroom session.",
      "",
      "The boardroom's value is COVERAGE OF PERSPECTIVES, not topical similarity. If every director would say the same thing, you have failed. Two directors with the same lens (e.g. both \"long-pattern\" / \"value\" types) is a redundant pick — replace one.",
      "",
      "Goal:",
      "- Pick exactly 3 director handles from the catalog below.",
      "- Cover ≥ 2 of these 4 lens types: dissent, rigor, empathy, pattern_recall.",
      "- Pick the topically-best LEAD, then DIVERSIFY (lens not yet covered), then BALANCE (narrative or decisiveness).",
      "",
      "RECENCY BIAS · Each catalog entry shows whether the director appeared in the last 5 rooms. When two candidates fit the same lens role comparably, PREFER the one with `[unseen recently]` over `[seen N/5 recent rooms]`. The user notices when the same trio shows up across consecutive rooms — variety across rooms is part of the boardroom's value. Only override the recency bias when the topical fit is genuinely uneven (e.g. only one specialist exists for a domain-specific question).",
      "",
      "Reply with strict JSON only — no prose outside the block:",
      "```json",
      "{",
      "  \"picks\": [",
      "    {\"handle\": \"@socrates\", \"reason\": \"≤ 60 chars · why this director\"},",
      "    {\"handle\": \"@long_h\", \"reason\": \"...\"},",
      "    {\"handle\": \"@user_e\", \"reason\": \"...\"}",
      "  ],",
      "  \"rationale\": \"≤ 80 chars · why this combination as a whole\"",
      "}",
      "```",
    ].join("\n"),
  };

  const user: LLMMessage = {
    role: "user",
    content: [
      `Subject:`,
      subject,
      ``,
      `Director catalog (${candidates.length}):`,
      ...candidates.map((a) => describeDirector(a, recent.get(a.id) ?? 0)),
      ``,
      `Pick 3 handles. Optimise for lens coverage AND variety across rooms (lean on recency tags).`,
    ].join("\n"),
  };

  let raw = "";
  const pickerModel = resolvePickerModel();
  if (!pickerModel) {
    // No model reachable at all (no keys configured) · fall back to
    // the canonical triple immediately rather than entering the
    // try/catch and burning a wasted call.
    const cast = enforceDiversity(fallbackCast(candidates), candidates);
    return {
      picks: cast.map((a) => ({ agentId: a.id, reason: "default cast" })),
      rationale: "no model reachable · default cast seated",
      fromLlm: false,
    };
  }
  try {
    raw = await callLLM({
      modelV: pickerModel,
      messages: [sys, user],
      // 0.7 (was 0.3) gives the picker enough variation to actually
      // honor the recency bias when topical fit is comparable; 0.3 was
      // too deterministic and locked the picker into the same trio
      // across similar topics.
      temperature: 0.7,
      // 1500 (was 360) · the picker is one of the most consequential
      // routing calls in the pipeline, and now runs on the user's
      // chosen default model (often a flagship). 360 was tight enough
      // that a model with a "reasoning trace" (Gemini 3, GPT-5
      // thinking modes) could exhaust the budget on private reasoning
      // and return a truncated / empty JSON. 1500 leaves 1k+ headroom
      // even when reasoning eats 500 tokens.
      maxTokens: 1500,
    });
  } catch (e) {
    if (!(e instanceof NoKeyError)) {
      process.stderr.write(
        `[director-picker] llm failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    const cast = enforceDiversity(fallbackCast(candidates), candidates);
    return {
      picks: cast.map((a) => ({ agentId: a.id, reason: "default cast" })),
      rationale: "picker unavailable · default cast seated",
      fromLlm: false,
    };
  }

  type PickRaw = { handle?: unknown; reason?: unknown };
  const parsed = tolerantJson<{ picks?: unknown; rationale?: unknown }>(raw);
  if (!parsed || !Array.isArray(parsed.picks)) {
    const cast = enforceDiversity(fallbackCast(candidates), candidates);
    return {
      picks: cast.map((a) => ({ agentId: a.id, reason: "default cast" })),
      rationale: "picker output unparseable · default cast seated",
      fromLlm: false,
    };
  }

  const llmPicks: { agent: Agent; reason: string }[] = [];
  for (const p of parsed.picks as PickRaw[]) {
    const handle = typeof p.handle === "string" ? p.handle.trim() : "";
    if (!handle) continue;
    const agent = resolveCatalogAgent(candidates, handle);
    if (!agent) continue;
    if (llmPicks.find((x) => x.agent.id === agent.id)) continue; // dedupe
    const reason = typeof p.reason === "string" ? clipString(p.reason.trim(), 80) : "";
    llmPicks.push({ agent, reason });
    if (llmPicks.length >= TARGET_CAST_SIZE) break;
  }

  // Top up if the LLM gave us fewer than TARGET_CAST_SIZE valid picks.
  if (llmPicks.length < TARGET_CAST_SIZE) {
    const fill = fallbackCast(candidates).filter(
      (a) => !llmPicks.find((p) => p.agent.id === a.id),
    );
    for (const a of fill) {
      llmPicks.push({ agent: a, reason: "balance · default" });
      if (llmPicks.length >= TARGET_CAST_SIZE) break;
    }
  }

  // Reasons get attached to the cast; diversity guardrail may swap
  // members. When a swap happens the new member inherits a default
  // reason (the LLM didn't pick it, so no original rationale exists).
  const reasonsByAgent = new Map(llmPicks.map((p) => [p.agent.id, p.reason]));
  const adjusted = enforceDiversity(llmPicks.map((p) => p.agent), candidates);

  const rationale = typeof parsed.rationale === "string"
    ? clipString(parsed.rationale.trim(), 120)
    : "covers complementary lenses";

  return {
    picks: adjusted.map((a) => ({
      agentId: a.id,
      reason: reasonsByAgent.get(a.id) || "balance · diversity guardrail",
    })),
    rationale,
    fromLlm: true,
  };
}
