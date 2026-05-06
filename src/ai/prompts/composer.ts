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
import { HOUSE_STYLES, formatHouseStyleCatalog, resolveHouseStyle } from "./house-styles.js";

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

  // Stanford-research self-criticism · names how the analysis itself
  // could be wrong (selection bias, generalizability ceiling, lens
  // blind spots). Distinct from `pre-mortem` (how the recommendation
  // could fail) and `critical-assumptions` (the foundations the brief
  // rests on). Highest fit for stanford-research / gartner-research
  // styles, but a useful add to any brief that wants to surface
  // intellectual honesty as a load-bearing section instead of an
  // appendix caveat.
  "threats-to-validity",

  // Dashboard-style indicator strip · 3-5 KPI cards (label / value /
  // qualifier / trend / attribution). The "by the numbers" beat right
  // after the anchor, before a reader has to swim through the
  // findings prose. Pick whenever the room produced ≥ 3 quantitative
  // claims worth surfacing side-by-side. Genuinely visual — emits
  // raw HTML that each spine styles into a card grid.
  "metric-strip",

  // ── Brainstorm-mode kinds · used ONLY when room.mode === "brainstorm".
  //    The mode-axis composer dispatch ensures these never mix with the
  //    decision-grade pool above. Listing them in the same enum keeps
  //    rendering / labelling / persistence uniform across modes. ──
  "opening-hook",          // anchor-equivalent · 1–2 sentence "what if this is real" lead-in
  "opportunity-shape",     // 3-dimension "size of the room" beat (scope / gravity / tempo)
  "adjacent-angles",       // 3–5 distinct ways INTO the topic · NOT ranked
  "what-if-this-works",    // 1 setup + 3 exploratory consequences
  "worth-chasing",         // 3–5 threads the room generated heat around · open questions, not actions
  "dead-ends-noted",       // 0–3 angles dropped · prevents re-traversal
  "brainstorm-questions",  // 5–8 generative questions · NOT a P0/P1 todo list

  // ── Critique-mode kinds · used ONLY when room.mode === "critique".
  //    Audit-shaped: severity-ranked, "what's good first", procedural. ──
  "deliverable-summary",   // anchor-equivalent · what's under review (subject + context)
  "whats-good",            // 2–4 things already working · MUST come before issues
  "quality-issues",        // 3–7 issues, severity-ranked, paired with impact
  "severity-ranked-fixes", // 3–7 fixes, severity-ranked, with effort estimate
  "residual-risks",        // 0–4 risks the audit can't close inside its scope
] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** Substitute groups · the composer picks exactly one kind from each.
 *  Apply only to constructive / decision-grade modes — brainstorm has
 *  its own substitute groups (see BRAINSTORM_* below). */
export const ANCHORS = ["bottom-line", "thesis", "working-hypothesis"] as const satisfies readonly ComponentKind[];
export const FINDINGS = ["headline-findings", "big-ideas"] as const satisfies readonly ComponentKind[];
export const ACTIONS = ["recommendations", "the-bet", "considerations"] as const satisfies readonly ComponentKind[];

/** Brainstorm-mode kind sets. The composer's brainstorm branch picks
 *  ONLY from BRAINSTORM_KINDS; mixing in any decision-grade kind from
 *  the pool above is a validation error.
 *
 *  Required: opening-hook (anchor) · adjacent-angles (lens enumeration) ·
 *            worth-chasing (threads with open questions).
 *  Optional but encouraged: opportunity-shape · what-if-this-works ·
 *            brainstorm-questions.
 *  Optional: dead-ends-noted · visuals (the existing `visuals` kind is
 *            still allowed in brainstorm mode for timeline / pie /
 *            comparison-table — the only constructive kind that crosses
 *            over because visuals are mode-agnostic). */
export const BRAINSTORM_KINDS = [
  "opening-hook",
  "opportunity-shape",
  "adjacent-angles",
  "what-if-this-works",
  "worth-chasing",
  "dead-ends-noted",
  "brainstorm-questions",
  "visuals",  // mode-agnostic · timeline / pie / comparison-table fit brainstorm fine
] as const satisfies readonly ComponentKind[];

export const BRAINSTORM_REQUIRED = ["opening-hook", "adjacent-angles", "worth-chasing"] as const satisfies readonly ComponentKind[];

/** Default brainstorm preset · safety net when the composer fails on a
 *  brainstorm room. 6 components, all from BRAINSTORM_KINDS. */
export const DEFAULT_BRAINSTORM_PRESET: ComponentPick[] = [
  { kind: "opening-hook",         order: 1 },
  { kind: "opportunity-shape",    order: 2 },
  { kind: "adjacent-angles",      order: 3 },
  { kind: "what-if-this-works",   order: 4 },
  { kind: "worth-chasing",        order: 5 },
  { kind: "brainstorm-questions", order: 6 },
];

/** Critique-mode kind sets. Mirror brainstorm's structure.
 *  Required: deliverable-summary (anchor) · whats-good (audit decorum) ·
 *  quality-issues OR severity-ranked-fixes (the meat of the review).
 *  Optional: residual-risks · open-questions · visuals (severity table). */
export const CRITIQUE_KINDS = [
  "deliverable-summary",
  "whats-good",
  "quality-issues",
  "severity-ranked-fixes",
  "residual-risks",
  "open-questions",  // mode-agnostic · fits critique fine for the residual TODO list
  "visuals",         // mode-agnostic · severity comparison-table fits critique
] as const satisfies readonly ComponentKind[];

export const CRITIQUE_REQUIRED = ["deliverable-summary", "whats-good"] as const satisfies readonly ComponentKind[];

/** Default critique preset · safety net when the composer fails on a
 *  critique room. 5 components, all from CRITIQUE_KINDS. */
export const DEFAULT_CRITIQUE_PRESET: ComponentPick[] = [
  { kind: "deliverable-summary",   order: 1 },
  { kind: "whats-good",            order: 2 },
  { kind: "quality-issues",        order: 3 },
  { kind: "severity-ranked-fixes", order: 4 },
  { kind: "residual-risks",        order: 5 },
];

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
 *  composer fails or the room has no signals. Visual components are
 *  included by default — empty fields render as nothing, but having
 *  the slots in place lets Stage 2 fill them when material exists,
 *  which avoids the "every fallback brief is a wall of text" failure
 *  mode. */
export const DEFAULT_PRESET: ComponentPick[] = [
  { kind: "bottom-line", order: 1 },
  { kind: "metric-strip", order: 2 },
  { kind: "frame-shift", order: 3 },
  { kind: "headline-findings", order: 4 },
  { kind: "convergence", order: 5 },
  { kind: "divergence", order: 6 },
  { kind: "positions", order: 7 },
  { kind: "visuals", order: 8 },
  { kind: "recommendations", order: 9 },
  { kind: "pre-mortem", order: 10 },
  { kind: "new-questions", order: 11 },
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
  /** House-style preset slug (`sequoia-memo`, `stanford-research`,
   *  `bcg-strategy`, etc.). Drives section vocabulary + voice register
   *  at write time. Defaults to `boardroom-default` when the composer
   *  fails or skips the field — that preset has no overrides, so the
   *  brief renders with the legacy default headings + neutral voice. */
  houseStyle: string;
  /** True when the composer's own output validated cleanly. False when
   *  the orchestrator fell back to DEFAULT_PRESET. The brief row records
   *  this distinction via the presence of `composer_rationale`. */
  fromComposer: boolean;
}

/* ─────────────────────────── Prompt ────────────────────────────────────── */

const SYSTEM_PROMPT = [
  "You are the Boardroom report composer. Pick (a) the house style, (b) the spine, and (c) the components that will produce the most useful brief for THIS specific room. Pick deliberately — the same room under different house styles reads as a different document. Avoid defaulting to `boardroom-default` unless the room genuinely doesn't fit any of the named registers.",
  "",
  "## What you must output",
  "",
  "Strict JSON inside a fenced ```json code block. No prose outside the block.",
  "",
  "```json",
  "{",
  '  "house_style": "sequoia-memo",',
  '  "spine": "a16z-thesis",',
  '  "subject_type": "investment-judgement",',
  '  "components": [',
  '    { "kind": "thesis", "order": 1 },',
  '    { "kind": "why-now", "order": 2 }',
  "  ],",
  '  "rationale": "≤ 120 chars · why this house-style + spine + components fit the room"',
  "}",
  "```",
  "",
  "## House-style catalog (7 presets)",
  "",
  formatHouseStyleCatalog(),
  "",
  "Picking discipline:",
  "  · The house style is the most consequential pick. It changes section vocabulary, voice register, and the kind of register the prose should adopt — investment-memo declarative vs scholarly hedged vs operator-essay narrative. Two reports under different house styles must FEEL different even when components overlap.",
  "  · Vary across rooms. If two consecutive rooms could plausibly fit the same house style, prefer the one that fits more sharply rather than always defaulting to the safest pick. The point is variety; redundancy across briefs is a failure mode.",
  "  · Match the spine to the house style by default (each style declares a default spine in its catalog entry above). Override only when the visual register obviously fits a different spine.",
  "",
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
  "  · `visuals`             0–4 visual exhibits. Seven sub-types now: comparison-table / quadrant-chart / force-field / strengths-cautions (the original four · text matrices + 2-axis plot) PLUS bar-chart (mermaid xychart-beta · 2–8 ranked items on one quantity), timeline (mermaid timeline · 3–8 dated narrative beats), pie-chart (mermaid pie showData · 2–6 distribution slices). Pick liberally — visuals carry information faster than prose. Triggers: any ranked numeric comparison → bar-chart; any chronology / historical analogue → timeline; any distribution that sums (probability split / votes / lens shares / market mix) → pie-chart; any 2-axis plot → quadrant-chart; any options matrix → comparison-table or strengths-cautions; any drivers-vs-resistors framing → force-field.",
  "  · `metric-strip`        3–5 KPI / indicator cards · the room's quantitative reads as a dashboard row. Pick whenever ≥ 3 numbers (percentages, time windows, ratios, counts, ranges) showed up worth surfacing side-by-side. Massively higher information density than the same numbers buried in prose — strongly favoured for investment / market-forecast / strategic-decision briefs.",
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
  "  · `threats-to-validity`   3–5 ways the *analysis itself* could be wrong (selection bias, generalizability ceiling, sample of N, lens blind spot, confounding). Each names a category, the threat in 1-2 sentences, an observable that would prove it realized, severity, and an optional mitigation. Distinct from `pre-mortem` (how the *recommendation* could fail) and from `critical-assumptions` (the foundations the brief rests on). Pull in for stanford-research / gartner-research / any brief where the room had a real moment of intellectual honesty — surfacing how we could be wrong is a load-bearing section, not a caveat.",
  "",
  "## Composition rules · violations are rejected",
  "",
  "· Exactly 1 anchor (from `bottom-line` / `thesis` / `working-hypothesis`).",
  "· Exactly 1 findings (from `headline-findings` / `big-ideas`).",
  "· Exactly 1 action (from `recommendations` / `the-bet` / `considerations`).",
  "· Total components: 5–12. Below 5 = thin; above 12 = noise. The new range allows for the Gartner-density blocks when warranted.",
  "· Drop a component if the conversation didn't produce material for it. Empty sections are worse than missing ones.",
  "· Spine ≠ template. Pick the spine whose voice fits the topic, then pick components independently.",
  "",
  "## Visualisation discipline · pick at least one per brief unless genuinely impossible",
  "",
  "Reports without any visual component (no `visuals`, no `metric-strip`, no `two-paths`, no `scenario-tree`, no `leading-indicators`) read as walls of text and lose the reader. The floor is: every brief should carry **at least one** component from the visual set. The bar is low — even a single quadrant-chart, a 3-card metric-strip, or a 2-column two-paths table satisfies this.",
  "  · If the room produced ≥ 3 quantitative claims (percentages, time windows, ratios) → `metric-strip` is the strongest pick.",
  "  · If the room compared ≥ 2 named options/paths → `visuals` (quadrant-chart or strengths-cautions) is the strongest.",
  "  · If the room argued multiple futures → `scenario-tree` (probabilities visible) beats prose every time.",
  "  · If the brief is a watch-and-wait stance → `leading-indicators` carries the structure.",
  "  · Truly unvisualisable rooms (philosophical / definitional / pure narrative retro) are allowed to skip — but they're rare. When in doubt, pick a visual.",
  "",
  "## Picking presets",
  "",
  "· If unsure → `boardroom-dark` spine and the safe set: `bottom-line` + `frame-shift` + `headline-findings` + `convergence` (or `divergence`) + `visuals` (or `metric-strip` when the room had numbers) + `recommendations` + `new-questions` + `open-questions`. Note the visual is in the safe set now — earlier presets that omitted visualisation produced flat reports.",
  "· Strategic / market / forecast / impact-analysis subjects → `boardroom-dark` (or `gartner-note`) spine and the dense set: `bottom-line` + `metric-strip` + `strategic-outlook` + `headline-findings` + `critical-assumptions` + `scenario-tree` + `recommendations` + `leading-indicators` + `pre-mortem` + `new-questions`. ~10 components — feels like a research dashboard.",
  "· Investment / market opportunity rooms → `a16z-thesis` spine and: `thesis` + `metric-strip` + `why-now` + `big-ideas` + `the-bet` + `pre-mortem` + `scenario-tree` + `new-questions`. The metric-strip carries the underwriting numbers.",
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

/* ───────────────────── Brainstorm-mode system prompt ──────────────────────
 *
 * Used when `room.mode === "brainstorm"`. A complete replacement for the
 * decision-grade SYSTEM_PROMPT above. Restricted to BRAINSTORM_KINDS so
 * the composer cannot pick thesis / recommendations / the-bet / etc.
 * even by accident.
 *
 * `subject_type` is FIXED to `exploration` for brainstorm rooms — the
 * decision-grade subject types (investment-judgement, strategic-decision)
 * misrepresent the conversation's intent. Persisted distinctly so
 * analytics can tell brainstorm rooms apart from decision rooms.
 * ────────────────────────────────────────────────────────────────────── */
const BRAINSTORM_SYSTEM_PROMPT = [
  "You are the Boardroom report composer running in BRAINSTORM mode. The user explicitly chose `mode: brainstorm` for this room — they want a brief that OPENS UP the topic, not one that narrows it to a thesis or a decision. Pick the components that produce the most generative brief for THIS specific room.",
  "",
  "## What you must output",
  "",
  "Strict JSON inside a fenced ```json code block. No prose outside the block.",
  "",
  "```json",
  "{",
  '  "house_style": "field-notes",',
  '  "spine": "anthropic-essay",',
  '  "subject_type": "exploration",',
  '  "components": [',
  '    { "kind": "opening-hook",         "order": 1 },',
  '    { "kind": "opportunity-shape",    "order": 2 },',
  '    { "kind": "adjacent-angles",      "order": 3 },',
  '    { "kind": "what-if-this-works",   "order": 4 },',
  '    { "kind": "worth-chasing",        "order": 5 },',
  '    { "kind": "brainstorm-questions", "order": 6 }',
  "  ],",
  '  "rationale": "≤ 120 chars · why this brainstorm shape fits the room"',
  "}",
  "```",
  "",
  "## Brainstorm component pool — pick ONLY from this list",
  "",
  "  · `opening-hook`           1–2 sentence \"what changes if this is real\" lead-in. NOT a judgement, NOT a thesis. REQUIRED — every brainstorm brief has one.",
  "  · `opportunity-shape`      3-dimension \"size of the room\" beat (scope · gravity · tempo). Recommended — sets the field for everything that follows.",
  "  · `adjacent-angles`        3–5 distinct ways INTO the topic, each with a name + framing + what-opens. NOT ranked. REQUIRED — the lens enumeration IS the point of a brainstorm.",
  "  · `what-if-this-works`     1 setup + 3 exploratory consequences. Phrased as \"could / might\", never as predictions.",
  "  · `worth-chasing`          3–5 threads the room generated heat around. Each gets a handle + why it pulled + an open testable question (NOT a milestone). REQUIRED — these are the user's takeaways, in question form.",
  "  · `dead-ends-noted`        0–3 angles the room dropped. Optional. Naming these signals the conversation actually ranged.",
  "  · `brainstorm-questions`   5–8 generative questions that opened up. Different from a P0/P1 todo list — these are the field's next horizon.",
  "  · `visuals`                Optional. Timeline (chronology / waves), pie (distribution of attention), or comparison-table (angle vs angle). bar-chart and quadrant-chart are also allowed but rarely fit a brainstorm.",
  "",
  "## FORBIDDEN kinds — do not pick any of these",
  "",
  "These are decision-grade kinds and don't belong in a brainstorm brief, no matter how strategic the topic feels:",
  "",
  "  · `bottom-line` / `thesis` / `working-hypothesis` (anchor commitment)",
  "  · `headline-findings` / `big-ideas` (claim-front findings)",
  "  · `recommendations` / `the-bet` / `considerations` (action prescriptions)",
  "  · `critical-assumptions` / `scenario-tree` / `leading-indicators` (decision uncertainty analysis)",
  "  · `pre-mortem` / `planning-assumption` / `why-now` / `frame-shift` / `convergence` / `divergence` / `positions` / `two-paths` / `strategic-outlook` / `threats-to-validity` / `metric-strip` / `new-questions` / `open-questions`",
  "",
  "If the conversation feels like it COULD be turned into a thesis, that's because brainstorm directors are doing their job — opening up the field. The composer's job is to KEEP it open, not collapse it into a thesis prematurely.",
  "",
  "## Composition rules",
  "",
  "  · MUST include: `opening-hook`, `adjacent-angles`, `worth-chasing`. These three define the brainstorm shape; missing any of them and the brief reads as something else.",
  "  · Total components: 4–8. Below 4 = thin; above 8 = decision-document creep.",
  "  · `subject_type` is ALWAYS `\"exploration\"` for brainstorm briefs. Do not pick from the decision-grade subject-type list.",
  "",
  "## House style — pick a brainstorm-friendly one",
  "",
  "  · `field-notes`         · narrative \"observer's notebook\" register · warm, curious, reference specific moments. Default for brainstorm.",
  "  · `boardroom-default`   · neutral analyst voice. Fallback if no other style fits.",
  "",
  "Do NOT pick `sequoia-memo`, `a16z-thesis`, `bcg-strategy`, `gartner-research`, or `stanford-research` for brainstorm briefs — those are decision/thesis/research registers and they fight against the brainstorm shape.",
  "",
  "## Spine",
  "",
  "Brainstorm-friendly spines: `anthropic-essay` (default), `boardroom-dark`. Avoid `a16z-thesis` / `gartner-note` / `mckinsey-deck` — those signal decision content visually.",
  "",
  "## Subject type",
  "",
  "Always pick `\"exploration\"` for brainstorm rooms. This is the SINGLE allowed value in this branch.",
  "",
  "## Language",
  "",
  "Component kinds and spine slugs are LITERAL English strings — never translate them. The `rationale` field IS user-facing — produce it in the room's output language (zh / en).",
].join("\n");

/* ─────────────────────── Critique-mode system prompt ──────────────────────
 *
 * Used when `room.mode === "critique"`. A complete replacement for the
 * decision-grade SYSTEM_PROMPT and a sibling to BRAINSTORM_SYSTEM_PROMPT.
 * Restricted to CRITIQUE_KINDS so the composer cannot pick thesis /
 * recommendations / opportunity-shape / etc. even by accident.
 *
 * `subject_type` is FIXED to `audit` for critique rooms.
 * ────────────────────────────────────────────────────────────────────── */
const CRITIQUE_SYSTEM_PROMPT = [
  "You are the Boardroom report composer running in CRITIQUE mode. The user explicitly chose `mode: critique` for this room — they want a deliverable AUDIT, not a strategic memo. Pick the components that produce the sharpest critique brief for THIS specific deliverable.",
  "",
  "## What you must output",
  "",
  "Strict JSON inside a fenced ```json code block. No prose outside the block.",
  "",
  "```json",
  "{",
  '  "house_style": "audit-memo",',
  '  "spine": "boardroom-dark",',
  '  "subject_type": "audit",',
  '  "components": [',
  '    { "kind": "deliverable-summary",   "order": 1 },',
  '    { "kind": "whats-good",            "order": 2 },',
  '    { "kind": "quality-issues",        "order": 3 },',
  '    { "kind": "severity-ranked-fixes", "order": 4 },',
  '    { "kind": "residual-risks",        "order": 5 }',
  "  ],",
  '  "rationale": "≤ 120 chars · why this critique shape fits the deliverable"',
  "}",
  "```",
  "",
  "## Critique component pool — pick ONLY from this list",
  "",
  "  · `deliverable-summary`     1–2 sentence framing of what's being audited (subject + context + optional charter). REQUIRED.",
  "  · `whats-good`              2–4 things working in the deliverable, named explicitly. REQUIRED — calibrates reviewer signal, signals the audit isn't a hatchet job. Goes BEFORE issues in render order.",
  "  · `quality-issues`          3–7 severity-ranked issues, each pairing the symptom with its impact. The audit's diagnostic core.",
  "  · `severity-ranked-fixes`   3–7 severity-ranked fixes, each with effort estimate. Distinct from `quality-issues`: issues are diagnosis, fixes are prescription.",
  "  · `residual-risks`          0–4 risks the audit can't close inside its scope. Optional but recommended for any audit with non-trivial out-of-scope dependencies.",
  "  · `open-questions`          Residual TODO questions for the deliverable's owner. Optional.",
  "  · `visuals`                 Optional. Severity comparison-table is the natural fit.",
  "",
  "## FORBIDDEN kinds — do not pick any of these",
  "",
  "Critique is an audit, not a strategy memo. These kinds belong elsewhere:",
  "",
  "  · `bottom-line` / `thesis` / `working-hypothesis` (decision anchors don't fit an audit)",
  "  · `headline-findings` / `big-ideas` (claim-front findings — wrong shape for a review)",
  "  · `recommendations` / `the-bet` / `considerations` (use `severity-ranked-fixes` instead)",
  "  · `critical-assumptions` / `scenario-tree` / `leading-indicators` / `pre-mortem` / `planning-assumption` / `why-now` (forward strategy, not deliverable review)",
  "  · `frame-shift` / `convergence` / `divergence` / `positions` / `two-paths` / `strategic-outlook` / `threats-to-validity` / `metric-strip` / `new-questions`",
  "  · All brainstorm kinds (`opening-hook`, `opportunity-shape`, `adjacent-angles`, etc.)",
  "",
  "## Composition rules",
  "",
  "  · MUST include: `deliverable-summary`, `whats-good`. These two define audit decorum.",
  "  · MUST include at least one of: `quality-issues`, `severity-ranked-fixes`. A critique with neither is empty.",
  "  · Total components: 4–7. Critique briefs are tight — long audits read as defensive.",
  "  · `subject_type` is ALWAYS `\"audit\"` for critique briefs.",
  "",
  "## House style — pick a critique-friendly one",
  "",
  "  · `audit-memo`         · standards-officer register · sharp, procedural, severity-tagged. Default for critique.",
  "  · `stanford-research`  · hedged academic register, fits when the deliverable IS analysis (a paper / a report).",
  "  · `boardroom-default`  · neutral analyst voice. Fallback.",
  "",
  "Do NOT pick `sequoia-memo`, `a16z-thesis`, `bcg-strategy`, `gartner-research`, `field-notes`, or `first-round-essay` for critique briefs.",
  "",
  "## Spine",
  "",
  "Critique-friendly spines: `boardroom-dark` (default), `gartner-note`, `openai-paper`. Avoid `a16z-thesis` / `anthropic-essay` — those signal commitment / exploration visually.",
  "",
  "## Subject type",
  "",
  "Always pick `\"audit\"` for critique rooms. This is the SINGLE allowed value in this branch.",
  "",
  "## Language",
  "",
  "Component kinds and spine slugs are LITERAL English strings — never translate them. The `rationale` field IS user-facing — produce it in the room's output language (zh / en).",
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

  // Mode-axis dispatch · brainstorm and critique rooms each get a
  // completely different system prompt + component pool. The user
  // message body is the same shape (room, signals, supplement) — only
  // the system prompt changes. Other modes (constructive / debate /
  // research) fall through to the decision-grade SYSTEM_PROMPT.
  const systemPrompt = room.mode === "brainstorm"
    ? BRAINSTORM_SYSTEM_PROMPT
    : room.mode === "critique"
      ? CRITIQUE_SYSTEM_PROMPT
      : SYSTEM_PROMPT;

  return [
    { role: "system", content: [systemPrompt, "", langLine].join("\n") },
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
const BRAINSTORM_KIND_SET: ReadonlySet<string> = new Set(BRAINSTORM_KINDS);
const BRAINSTORM_REQUIRED_SET: ReadonlySet<string> = new Set(BRAINSTORM_REQUIRED);
const CRITIQUE_KIND_SET: ReadonlySet<string> = new Set(CRITIQUE_KINDS);
const CRITIQUE_REQUIRED_SET: ReadonlySet<string> = new Set(CRITIQUE_REQUIRED);
const HOUSE_STYLE_SET: ReadonlySet<string> = new Set(HOUSE_STYLES.map((s) => s.id));

const ALLOWED_SUBJECT_TYPES = new Set([
  "investment-judgement",
  "option-comparison",
  "strategic-decision",
  "philosophical",
  "operational",
  "market-forecast",
  "retro",
  "other",
  // Brainstorm rooms record their distinctive subject type so analytics
  // can tell exploration briefs apart from decision briefs. The brainstorm
  // composer prompt FIXES `subject_type` to `exploration` for every
  // brainstorm pick.
  "exploration",
  // Critique rooms record `audit` so the dataset shows three distinct
  // brief shapes (decision / exploration / audit).
  "audit",
]);

/** House styles that are appropriate to recommend for brainstorm rooms.
 *  Used by the brainstorm validator to coerce decision-grade picks
 *  (sequoia-memo, a16z-thesis, bcg-strategy, gartner-research) down to a
 *  brainstorm-friendly default. */
const BRAINSTORM_HOUSE_STYLE_ALLOW = new Set(["field-notes", "boardroom-default"]);

/** House styles that are appropriate to recommend for critique rooms.
 *  Audit-shaped registers only · `audit-memo` is the new house style we
 *  add for critique, `stanford-research` works when the deliverable IS
 *  analysis, `boardroom-default` is the neutral fallback. */
const CRITIQUE_HOUSE_STYLE_ALLOW = new Set(["audit-memo", "stanford-research", "boardroom-default"]);

interface ValidationProblem {
  reason: string;
}

/**
 * Parse + validate the composer's raw JSON. Returns null when the
 * output is unrecoverable — callers fall back to the mode-appropriate
 * default preset.
 *
 * Mode-aware: brainstorm rooms run a brainstorm validator (BRAINSTORM_-
 * KINDS pool, no anchor/findings/action substitute groups, no decision
 * kinds) and coerce house style to a brainstorm-friendly preset. All
 * other modes use the constructive/decision validator.
 */
export function parseComposerOutput(
  raw: string,
  mode: string = "constructive",
): ComposerResult | null {
  const parsed = extractJson<{
    spine?: unknown;
    components?: unknown;
    rationale?: unknown;
    subject_type?: unknown;
    subjectType?: unknown;
    house_style?: unknown;
    houseStyle?: unknown;
  }>(raw);
  if (!parsed) return null;

  const isBrainstorm = mode === "brainstorm";
  const isCritique = mode === "critique";

  // House style · mode-aware coercion. Brainstorm coerces to
  // `field-notes`, critique coerces to `audit-memo`, when the LLM
  // picks a decision-grade style despite the prompt's instructions.
  const houseStyleRaw = typeof parsed.house_style === "string"
    ? parsed.house_style
    : typeof parsed.houseStyle === "string"
      ? parsed.houseStyle
      : "";
  const houseStyleTrim = houseStyleRaw.trim();
  let houseStyle = HOUSE_STYLE_SET.has(houseStyleTrim) ? houseStyleTrim : "boardroom-default";
  if (isBrainstorm && !BRAINSTORM_HOUSE_STYLE_ALLOW.has(houseStyle)) {
    houseStyle = "field-notes";
  } else if (isCritique && !CRITIQUE_HOUSE_STYLE_ALLOW.has(houseStyle)) {
    houseStyle = "audit-memo";
  }

  // Spine · default to the picked house style's preferred spine when
  // the composer didn't name one (or named an unknown slug). Keeps the
  // visual register coherent with the editorial register.
  const spineRaw = typeof parsed.spine === "string" ? parsed.spine.trim() : "";
  const spine: Spine = SPINE_SET.has(spineRaw)
    ? (spineRaw as Spine)
    : resolveHouseStyle(houseStyle).spine;

  // Components · normalize, dedupe, drop unknowns. In brainstorm mode
  // any kind outside BRAINSTORM_KINDS is dropped silently — protects
  // the brief from decision-grade kinds leaking in.
  if (!Array.isArray(parsed.components)) return null;
  const seen = new Set<ComponentKind>();
  const picks: ComponentPick[] = [];
  for (const entry of parsed.components) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const kind = typeof e.kind === "string" ? e.kind.trim() : "";
    if (!KIND_SET.has(kind)) continue;
    if (isBrainstorm && !BRAINSTORM_KIND_SET.has(kind)) continue;
    if (isCritique && !CRITIQUE_KIND_SET.has(kind)) continue;
    if (seen.has(kind as ComponentKind)) continue;
    const order = typeof e.order === "number" && Number.isFinite(e.order)
      ? Math.floor(e.order)
      : picks.length;
    picks.push({ kind: kind as ComponentKind, order });
    seen.add(kind as ComponentKind);
  }

  const problem = isBrainstorm
    ? validateBrainstormPicks(picks)
    : isCritique
      ? validateCritiquePicks(picks)
      : validatePicks(picks);
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
  // Brainstorm always → `exploration`; critique always → `audit`.
  // Other modes use what the composer picks (or null if invalid).
  const subjectType = isBrainstorm
    ? "exploration"
    : isCritique
      ? "audit"
      : (subjectTypeRaw && ALLOWED_SUBJECT_TYPES.has(subjectTypeRaw.trim())
        ? subjectTypeRaw.trim()
        : null);

  return {
    spine,
    components: picks,
    rationale,
    subjectType,
    houseStyle,
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

/** Brainstorm-mode validator. Different rules from the decision-grade
 *  validator above:
 *    · No anchor / findings / action substitute groups (those are
 *      decision-shaped and don't belong in a brainstorm brief).
 *    · Required: opening-hook, adjacent-angles, worth-chasing — these
 *      three define the brainstorm shape. Missing any and the brief
 *      reads as something else.
 *    · 4–8 component cap (looser floor than the constructive 5-min,
 *      tighter ceiling than 12 — brainstorm briefs are short by design).
 */
function validateBrainstormPicks(picks: ComponentPick[]): ValidationProblem | null {
  if (picks.length < 4) return { reason: `brainstorm: too few components (${picks.length} < 4)` };
  if (picks.length > 8) return { reason: `brainstorm: too many components (${picks.length} > 8)` };

  const kinds = new Set(picks.map((p) => p.kind));
  const missing: string[] = [];
  for (const required of BRAINSTORM_REQUIRED_SET) {
    if (!kinds.has(required as ComponentKind)) missing.push(required);
  }
  if (missing.length) {
    return { reason: `brainstorm: missing required component(s): ${missing.join(", ")}` };
  }
  return null;
}

/** Critique-mode validator. Audit-shaped rules:
 *    · Required: deliverable-summary + whats-good. These two define
 *      audit decorum; without them the brief reads as a hatchet job.
 *    · Required: AT LEAST ONE of `quality-issues` / `severity-ranked-fixes`.
 *      A critique with neither has no diagnostic content.
 *    · 4–7 component cap. Critique briefs stay tight; long audits read
 *      as defensive.
 */
function validateCritiquePicks(picks: ComponentPick[]): ValidationProblem | null {
  if (picks.length < 4) return { reason: `critique: too few components (${picks.length} < 4)` };
  if (picks.length > 7) return { reason: `critique: too many components (${picks.length} > 7)` };

  const kinds = new Set(picks.map((p) => p.kind));
  const missing: string[] = [];
  for (const required of CRITIQUE_REQUIRED_SET) {
    if (!kinds.has(required as ComponentKind)) missing.push(required);
  }
  if (missing.length) {
    return { reason: `critique: missing required component(s): ${missing.join(", ")}` };
  }
  // At least one of quality-issues / severity-ranked-fixes — the
  // diagnostic content. The required set above only mandates the
  // decorum components.
  if (!kinds.has("quality-issues") && !kinds.has("severity-ranked-fixes")) {
    return { reason: `critique: must include at least one of quality-issues / severity-ranked-fixes` };
  }
  return null;
}

function countMembers(have: ReadonlySet<string>, group: ReadonlySet<string>): number {
  let n = 0;
  for (const k of have) if (group.has(k)) n++;
  return n;
}

/**
 * The safety-net composition · used when (a) the LLM call failed,
 * (b) output couldn't be parsed, (c) validation rejected the picks, or
 * (d) the room had no signals at all.
 *
 * Mode-aware: brainstorm rooms get DEFAULT_BRAINSTORM_PRESET (6
 * brainstorm components + field-notes house style + anthropic-essay
 * spine) so a fallback brief still lands as exploration, not as a
 * decision document. All other modes get the legacy 12-section preset.
 */
export function defaultComposition(reason: string, mode: string = "constructive"): ComposerResult {
  if (mode === "brainstorm") {
    return {
      spine: "anthropic-essay",
      components: DEFAULT_BRAINSTORM_PRESET.map((p) => ({ ...p })),
      rationale: reason,
      subjectType: "exploration",
      houseStyle: "field-notes",
      fromComposer: false,
    };
  }
  if (mode === "critique") {
    return {
      spine: "boardroom-dark",
      components: DEFAULT_CRITIQUE_PRESET.map((p) => ({ ...p })),
      rationale: reason,
      subjectType: "audit",
      houseStyle: "audit-memo",
      fromComposer: false,
    };
  }
  return {
    spine: "boardroom-dark",
    components: DEFAULT_PRESET.map((p) => ({ ...p })),
    rationale: reason,
    subjectType: null,
    houseStyle: "boardroom-default",
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
