/**
 * Stage 1.5 · Report composer.
 *
 * Given the room's subject + the per-director signals from Stage 1,
 * the composer picks (a) a style spine and (b) a subset of components
 * that fit this specific conversation. Stage 2 / Stage 3 are then
 * parameterized to only fill / render the picked components.
 *
 * v1 ships with one spine (`boardroom-dark`) and 15 component kinds.
 * Future releases add the other 5 spines (a16z-thesis, anthropic-essay,
 * gartner-note, mckinsey-deck, openai-paper).
 */
import type { LLMMessage } from "../adapter.js";
import type { Agent } from "../../storage/agents.js";
import type { Room } from "../../storage/rooms.js";

import type { DirectorSignals, ReportLanguage } from "./brief-stages.js";
import { extractJson } from "./brief-stages.js";

/* ─────────────────────────── Catalogue ─────────────────────────────────── */

/** Every component the composer is allowed to pick. Append-only — kinds
 *  are never removed (legacy briefs always remain renderable). */
export const COMPONENT_KINDS = [
  // Anchor · pick exactly 1
  "bottom-line",
  "thesis",
  "working-hypothesis",

  // Findings · pick exactly 1
  "headline-findings",
  "big-ideas",

  // Action · pick exactly 1
  "recommendations",
  "the-bet",
  "considerations",

  // Optional · independent on/off
  "frame-shift",
  "convergence",
  "divergence",
  "positions",
  "visuals",
  "two-paths",
  "why-now",
  "pre-mortem",
  "new-questions",
  "planning-assumption",
  "open-questions",

  // Gartner-density blocks · for strategic-decision / market-forecast
  // briefs. The composer pulls these in when the room's value lives in
  // the analysis of UNCERTAINTY (assumptions, scenarios, indicators)
  // rather than in conclusions alone.
  "strategic-outlook",
  "critical-assumptions",
  "scenario-tree",
  "leading-indicators",
] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** Substitute groups · the composer picks exactly one kind from each. */
export const ANCHORS = ["bottom-line", "thesis", "working-hypothesis"] as const satisfies readonly ComponentKind[];
export const FINDINGS = ["headline-findings", "big-ideas"] as const satisfies readonly ComponentKind[];
export const ACTIONS = ["recommendations", "the-bet", "considerations"] as const satisfies readonly ComponentKind[];

/** Spines · v1 ships with `boardroom-dark` only. The catalogue is
 *  surfaced to the composer's prompt; the orchestrator coerces any
 *  non-`boardroom-dark` pick down to `boardroom-dark` until the other
 *  renderers ship. */
export const SPINES = [
  "boardroom-dark",
  "a16z-thesis",
  "anthropic-essay",
  "gartner-note",
  "mckinsey-deck",
  "openai-paper",
] as const;

export type Spine = (typeof SPINES)[number];

/** The default 12-section preset · used as a safety net when the
 *  composer fails or the room has no signals. Matches the static
 *  layout the codebase shipped before Stage 1.5 existed. */
export const DEFAULT_PRESET: ComponentPick[] = [
  { kind: "bottom-line", order: 1 },
  { kind: "frame-shift", order: 2 },
  { kind: "headline-findings", order: 3 },
  { kind: "convergence", order: 4 },
  { kind: "divergence", order: 5 },
  { kind: "positions", order: 6 },
  { kind: "visuals", order: 7 },
  { kind: "recommendations", order: 8 },
  { kind: "pre-mortem", order: 9 },
  { kind: "new-questions", order: 10 },
  { kind: "planning-assumption", order: 11 },
  { kind: "open-questions", order: 12 },
];

export interface ComponentPick {
  kind: ComponentKind;
  order: number;
}

export interface ComposerResult {
  spine: Spine;
  components: ComponentPick[];
  rationale: string;
  subjectType: string | null;
  /** True when the composer's own output validated cleanly. False when
   *  the orchestrator fell back to DEFAULT_PRESET. The brief row records
   *  this distinction via the presence of `composer_rationale`. */
  fromComposer: boolean;
}

/* ─────────────────────────── Prompt ────────────────────────────────────── */

const SYSTEM_PROMPT = [
  "You are the Boardroom report composer. Pick the spine and the components that will produce the most useful brief for THIS specific room.",
  "",
  "## What you must output",
  "",
  "Strict JSON inside a fenced ```json code block. No prose outside the block.",
  "",
  "```json",
  "{",
  '  "spine": "boardroom-dark",',
  '  "subject_type": "investment-judgement",',
  '  "components": [',
  '    { "kind": "bottom-line", "order": 1 },',
  '    { "kind": "frame-shift", "order": 2 }',
  "  ],",
  '  "rationale": "≤ 120 chars · why this spine + these components fit the room"',
  "}",
  "```",
  "",
  "## Component catalogue (19 kinds)",
  "",
  "Anchor (pick EXACTLY one):",
  "  · `bottom-line`         Sentence judgement + confidence + rationale. Default for recap / strategic rooms.",
  "  · `thesis`              Single load-bearing claim, ~16 words, pull-statement style. For investment / opportunity rooms.",
  "  · `working-hypothesis`  Essay-style opener: \"a working hypothesis, and the reasons it may be wrong.\" For philosophical / open-ended rooms (anthropic-essay spine).",
  "",
  "Findings (pick EXACTLY one):",
  "  · `headline-findings`   Three pillar claims, MECE, with supporters / challengers / sub-findings.",
  "  · `big-ideas`           Three numbered claims, each with a why. Lighter, punchier — for venture / market rooms.",
  "",
  "Action (pick EXACTLY one):",
  "  · `recommendations`     3–5 P0/P1/P2 actions with owner / horizon / success metric / risk-if-skipped.",
  "  · `the-bet`             Conditions to back the call (3–5 conditions), plus kill criteria. For investment / commitment rooms.",
  "  · `considerations`      Same shape as recommendations but in a softer, hedged voice (\"things you might consider\"). For philosophical / Anthropic-essay rooms where imperatives feel wrong.",
  "",
  "Optional · independent on/off (pick the ones the conversation actually produced material for):",
  "  · `frame-shift`         How the question itself moved (or held). Skip if the frame neither shifted nor sharpened.",
  "  · `convergence`         Where directors aligned via independent reasoning paths. Needs ≥ 2 directors via ≥ 2 lenses.",
  "  · `divergence`          The single hinge where directors split. Skip when the room had no real central tension.",
  "  · `positions`           2–3 named camps with a pull-quote per camp. Skip when directors didn't cluster.",
  "  · `visuals`             0–4 exhibits (comparison-table / quadrant-chart / force-field / strengths-cautions). Pick when ≥ 2 named options or paths were compared.",
  "  · `two-paths`           Side-by-side trajectory comparison (Path A vs Path B). Pick when the room argued two distinct futures or routes — punchier than a comparison-table.",
  "  · `why-now`             Single panel: window opened by what · window closes when · the bet implied. For investment / opportunity rooms (a16z-thesis spine).",
  "  · `pre-mortem`          2–3 failure modes with leading indicators + mitigations. Pair with `recommendations` or `the-bet` when the call is high-stakes.",
  "  · `new-questions`       Questions that did NOT exist when the room opened but emerged. The most generative output of a multi-director session.",
  "  · `planning-assumption` Forward-looking probabilistic statement with falsification test. For market / strategy / forecasting rooms.",
  "  · `open-questions`      Residual unresolved questions tagged P0/P1.",
  "",
  "Gartner-density blocks · pick these when the room's value lives in the analysis of UNCERTAINTY, not in conclusions alone. These are the blocks that make a brief feel like a research-grade analysis instead of a meeting recap. Pull in 1–3 of them for any strategic-decision / market-forecast / impact-analysis room.",
  "  · `strategic-outlook`     2-paragraph context + implication, sits between the anchor and the findings. Use when the room needs to set up the operating environment before findings make sense (geopolitics, macro shifts, market state).",
  "  · `critical-assumptions`  4–6 load-bearing assumptions, each with confidence + falsifier + time horizon. Use when the brief's logic rests on assumptions that could shift — surfacing them lets the reader stress-test the conclusion.",
  "  · `scenario-tree`         2–4 named futures (typically Base / Upside / Downside) with probabilities, triggers, effects, decision implications. Use whenever the room argued multiple futures — richer than `two-paths` because it adds probability + trigger + decision implication per branch.",
  "  · `leading-indicators`    3–5 signals to monitor with thresholds + cadence + scenario each indicator confirms. Use when the brief tells the reader to wait-and-watch, or when scenarios diverge based on observable signals.",
  "",
  "## Composition rules · violations are rejected",
  "",
  "· Exactly 1 anchor (from `bottom-line` / `thesis` / `working-hypothesis`).",
  "· Exactly 1 findings (from `headline-findings` / `big-ideas`).",
  "· Exactly 1 action (from `recommendations` / `the-bet` / `considerations`).",
  "· Total components: 5–12. Below 5 = thin; above 12 = noise. The new range allows for the Gartner-density blocks when warranted.",
  "· Drop a component if the conversation didn't produce material for it. Empty sections are worse than missing ones.",
  "· Spine ≠ template. Pick the spine whose voice fits the topic, then pick components independently.",
  "· If unsure → `boardroom-dark` spine and the safe set: `bottom-line` + `frame-shift` + `headline-findings` + `convergence` (or `divergence`) + `recommendations` + `new-questions` + `open-questions`.",
  "· Strategic / market / forecast / impact-analysis subjects → `boardroom-dark` (or `gartner-note`) spine and the dense set: `bottom-line` + `strategic-outlook` + `headline-findings` + `critical-assumptions` + `scenario-tree` + `recommendations` + `leading-indicators` + `pre-mortem` + `new-questions`. ~9 components — feels like a research note.",
  "",
  "## Spine catalogue",
  "",
  "v1 renders only `boardroom-dark`. The other spines are accepted by the schema but coerced to `boardroom-dark` until their renderers ship — your pick is still recorded for analytics.",
  "  · `boardroom-dark`  default · room recap · philosophical · mixed",
  "  · `a16z-thesis`     investment / market opportunity / 'should we bet on X'",
  "  · `anthropic-essay` open-ended exploration · philosophical / framing",
  "  · `gartner-note`    strategic decision under uncertainty · vendor / option scoring",
  "  · `mckinsey-deck`   execution / operational / 'how do we do X'",
  "  · `openai-paper`    technical / research-style / N-option comparison",
  "",
  "## Topic → spine heuristics (non-binding)",
  "",
  "· 'should we invest / build / back / bet' or 'is X defensible' → `a16z-thesis` (`thesis` + `the-bet`)",
  "· 'what does X mean' / philosophical / open-ended            → `anthropic-essay` (anchor stays `bottom-line`)",
  "· 'compare / pick between / which option / vendor scan'      → `gartner-note` or `openai-paper`",
  "· 'how do we do / roll out / execute / fix'                  → `mckinsey-deck`",
  "· post-mortem / retro / 'what happened'                      → `boardroom-dark`",
  "",
  "## Language",
  "",
  "Component kinds and spine slugs are LITERAL English strings — never translate them. The `rationale` field IS user-facing — produce it in the room's output language (zh / en).",
  "",
  "## Subject type",
  "",
  "Pick one of: `investment-judgement`, `option-comparison`, `strategic-decision`, `philosophical`, `operational`, `market-forecast`, `retro`, `other`. This is recorded for analytics and future presets — keep it honest, no guessing for marketing reasons.",
].join("\n");

/* ─────────────────────────── Builder ───────────────────────────────────── */

interface BuildOpts {
  room: Room;
  members: Agent[];
  perDirectorSignals: DirectorSignals[];
  language: ReportLanguage;
  /** Optional supplementary perspective the user supplied — affects the
   *  composer's pick (e.g. "look at this as a Gartner-style scan" should
   *  flip the spine). */
  supplement?: string;
}

export function buildComposerMessages(opts: BuildOpts): LLMMessage[] {
  const { room, members, perDirectorSignals, language, supplement } = opts;

  const directors = members
    .filter((m) => m.roleKind === "director")
    .map((a) => `${a.id} · ${a.name} (${a.handle}) — ${a.roleTag}`)
    .join("\n  · ");

  const signalsBlock = perDirectorSignals
    .map((d) => {
      if (!d.signals.length) return `[${d.directorId}] ${d.directorName} — (no signals)`;
      const lines = d.signals
        .map((s, i) => `  · ${d.directorId}#${i} [${s.lens}] ${s.text}`)
        .join("\n");
      return `[${d.directorId}] ${d.directorName}\n${lines}`;
    })
    .join("\n\n");

  const langLine = language === "zh"
    ? "## Output language\n本次会议的 Initial Question 是中文。`rationale` 字段请用**简体中文**。其它字段（`spine`, `kind`, `subject_type`）保留英文枚举值不变。"
    : "## Output language\nThis room's Initial Question was in English. Produce the `rationale` field in English. The `spine`, `kind`, and `subject_type` fields are literal enum strings — never translate them.";

  const supplementBlock = supplement && supplement.trim()
    ? [
        "",
        "─── SUPPLEMENTARY PERSPECTIVE FROM USER ───",
        "",
        "The user has asked the regenerated brief to address this angle. Let it influence both the spine and the components. The user mentioning a specific framing (e.g. 'as a Gartner research note', 'as an investment thesis') is a strong steer — follow it.",
        "",
        supplement.trim(),
        "",
        "─── END SUPPLEMENT ───",
      ].join("\n")
    : "";

  return [
    { role: "system", content: [SYSTEM_PROMPT, "", langLine].join("\n") },
    {
      role: "user",
      content: [
        `ROOM #${room.number} · ${room.name}`,
        `Subject: ${room.subject}`,
        `Mode: ${room.mode}`,
        ``,
        `Directors:`,
        `  · ${directors || "(none)"}`,
        ``,
        `─── SIGNALS ───`,
        ``,
        signalsBlock || "(no signals extracted)",
        ``,
        `─── END SIGNALS ───`,
        supplementBlock,
        ``,
        `Pick the spine and components now. JSON only.`,
      ].join("\n"),
    },
  ];
}

/* ─────────────────────────── Parser + validation ───────────────────────── */

const KIND_SET: ReadonlySet<string> = new Set(COMPONENT_KINDS);
const SPINE_SET: ReadonlySet<string> = new Set(SPINES);
const ANCHOR_SET: ReadonlySet<string> = new Set(ANCHORS);
const FINDINGS_SET: ReadonlySet<string> = new Set(FINDINGS);
const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);

const ALLOWED_SUBJECT_TYPES = new Set([
  "investment-judgement",
  "option-comparison",
  "strategic-decision",
  "philosophical",
  "operational",
  "market-forecast",
  "retro",
  "other",
]);

interface ValidationProblem {
  reason: string;
}

/**
 * Parse + validate the composer's raw JSON. Returns null when the
 * output is unrecoverable — callers fall back to DEFAULT_PRESET.
 *
 * Validation enforces the catalogue's substitute-group rules and the
 * 5–9 total component cap. We're permissive on minor sins (unknown
 * kinds are dropped silently rather than rejecting the whole pick) so
 * one weird kind doesn't throw away an otherwise good composition.
 */
export function parseComposerOutput(raw: string): ComposerResult | null {
  const parsed = extractJson<{
    spine?: unknown;
    components?: unknown;
    rationale?: unknown;
    subject_type?: unknown;
    subjectType?: unknown;
  }>(raw);
  if (!parsed) return null;

  // Spine.
  const spineRaw = typeof parsed.spine === "string" ? parsed.spine.trim() : "";
  const spine: Spine = SPINE_SET.has(spineRaw) ? (spineRaw as Spine) : "boardroom-dark";

  // Components · normalize, dedupe, drop unknowns.
  if (!Array.isArray(parsed.components)) return null;
  const seen = new Set<ComponentKind>();
  const picks: ComponentPick[] = [];
  for (const entry of parsed.components) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const kind = typeof e.kind === "string" ? e.kind.trim() : "";
    if (!KIND_SET.has(kind)) continue;
    if (seen.has(kind as ComponentKind)) continue;
    const order = typeof e.order === "number" && Number.isFinite(e.order)
      ? Math.floor(e.order)
      : picks.length;
    picks.push({ kind: kind as ComponentKind, order });
    seen.add(kind as ComponentKind);
  }

  const problem = validatePicks(picks);
  if (problem) return null;

  // Stable order: ascending `order`, ties broken by catalogue order.
  picks.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return COMPONENT_KINDS.indexOf(a.kind) - COMPONENT_KINDS.indexOf(b.kind);
  });
  // Re-number contiguously so the renderer doesn't have to.
  picks.forEach((p, i) => {
    p.order = i + 1;
  });

  const rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim().slice(0, 240) : "";
  const subjectTypeRaw = typeof parsed.subject_type === "string"
    ? parsed.subject_type
    : typeof parsed.subjectType === "string"
      ? parsed.subjectType
      : "";
  const subjectType = subjectTypeRaw && ALLOWED_SUBJECT_TYPES.has(subjectTypeRaw.trim())
    ? subjectTypeRaw.trim()
    : null;

  return {
    spine,
    components: picks,
    rationale,
    subjectType,
    fromComposer: true,
  };
}

function validatePicks(picks: ComponentPick[]): ValidationProblem | null {
  // 5–12 component cap · room for the Gartner-density blocks (strategic-
  // outlook, critical-assumptions, scenario-tree, leading-indicators)
  // when the brief's analytical depth justifies them. Below 5 reads as
  // a meeting recap; above 12 turns into noise.
  if (picks.length < 5) return { reason: `too few components (${picks.length} < 5)` };
  if (picks.length > 12) return { reason: `too many components (${picks.length} > 12)` };

  const kinds = new Set(picks.map((p) => p.kind));
  const anchorCount = countMembers(kinds, ANCHOR_SET);
  if (anchorCount !== 1) return { reason: `expected exactly 1 anchor, got ${anchorCount}` };
  const findingsCount = countMembers(kinds, FINDINGS_SET);
  if (findingsCount !== 1) return { reason: `expected exactly 1 findings, got ${findingsCount}` };
  const actionCount = countMembers(kinds, ACTION_SET);
  if (actionCount !== 1) return { reason: `expected exactly 1 action, got ${actionCount}` };
  return null;
}

function countMembers(have: ReadonlySet<string>, group: ReadonlySet<string>): number {
  let n = 0;
  for (const k of have) if (group.has(k)) n++;
  return n;
}

/**
 * The safety-net composition · the same 12-section layout the codebase
 * shipped before Stage 1.5 existed. Used when (a) the LLM call failed,
 * (b) output couldn't be parsed, (c) validation rejected the picks, or
 * (d) the room had no signals at all.
 */
export function defaultComposition(reason: string): ComposerResult {
  return {
    spine: "boardroom-dark",
    components: DEFAULT_PRESET.map((p) => ({ ...p })),
    rationale: reason,
    subjectType: null,
    fromComposer: false,
  };
}

/** Coerce a composer-picked spine down to a renderer the frontend
 *  actually has. All 6 spines now ship CSS renderers; this passthrough
 *  remains as a safety net for unknown values (in case the persisted
 *  spine string is from a future release we haven't loaded yet). */
export function activeSpine(picked: Spine): Spine {
  if (SPINE_SET.has(picked)) return picked;
  return "boardroom-dark";
}
