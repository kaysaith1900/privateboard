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

import type { DirectorAssets, ReportLanguage } from "./brief-stages.js";
import { extractJson } from "./brief-stages.js";
import { HOUSE_STYLES, formatHouseStyleCatalog, houseStylesForTone, resolveHouseStyle } from "./house-styles.js";

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

  // Self-criticism block · names how the analysis itself could be
  // wrong (selection bias, generalizability ceiling, lens blind
  // spots). Distinct from `risk-register` (operating-environment
  // risks) and `critical-assumptions` (the foundations the brief
  // rests on). Highest fit for `anthropic` / `gartner-research`
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

  // Standing risk landscape · 3-7 environment / product / team /
  // market risks with severity × likelihood × owner × mitigation.
  // Carries both environmental risks (whether or not we act) AND
  // concrete recommendation-failure modes when the room raised
  // them. (Replaces the old `pre-mortem` slot · its scenario /
  // leading-indicator / mitigation shape collapses cleanly into
  // a risk-register row.) Strong fit for strategy / execution
  // briefs and any room where the operating environment or
  // recommendation-failure is the hinge.
  "risk-register",

  // Structured N-option comparison · 2-5 candidate options with
  // shared pros/cons + an explicit recommended pick. Distinct from
  // `comparison-table` (raw matrix the writer assembles freeform)
  // and `two-paths` (binary trajectory). Strong fit for
  // decision-grade briefs where the room weighed multiple paths
  // and the choice is the load-bearing output.
  "decision-options",

  // Side-by-side binary structural comparison · ALWAYS 2 paths,
  // each verdict-tagged ("structurally fragile" / "plausibly
  // defensible") with 4-6 characteristic bullets. Accent colour
  // visualises which path the room views as fragile vs viable —
  // the verdict tag IS the recommendation, no separate flag.
  // Distinct from `two-paths` (prose-only, no structural verdict)
  // and `decision-options` (N options with pros/cons matrix).
  // Highest fit when the room argued ONE binary structural
  // choice (replacement vs augmentation, vertical vs horizontal,
  // build vs partner) where one trajectory is structurally
  // weaker than the other.
  "path-comparison",
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
  { kind: "risk-register", order: 9 },
  { kind: "new-questions", order: 10 },
  { kind: "open-questions", order: 11 },
  { kind: "recommendations", order: 12 },
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
  /** House-style preset slug (`sequoia-memo`, `anthropic`,
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
  "## TONE IS THE HIGHEST-PRIORITY CONSTRAINT",
  "",
  "The user message includes a `ROOM TONE` block naming the room's mode (brainstorm / constructive / debate / research / critique) and intensity. **Pick the house style to match the room's TONE first, the subject second.** A critique-mode room must NOT output a warm operator-essay register; a brainstorm-mode room must NOT output a hedged scholarly note; a research-mode room must NOT output an a16z thesis-essay. Each house-style entry below names its `tone fits` and (when present) its `AVOID` list — honour the AVOID list. If you must override (e.g. the room ran in `debate` but the actual material is investment-judgement and `a16z-thesis` is the only honest fit), state the override reason in `rationale`.",
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
  "  · `visuals`             0–4 visual exhibits. Seven sub-types — **prefer the inline-SVG chart sub-types (4) over text matrix (3)** unless the data shape genuinely doesn't fit. SVG charts render as a real diagram in seconds; text matrices are dense and slow to absorb. Inline-SVG sub-types (rendered through the `kami-chart` pipeline, spine-tokenised): `quadrant-chart` (2-axis plot), `bar-chart` (ranked numeric · 2–8 items), `timeline` (dated narrative · 3–8 beats), `pie-chart` (distribution · 2–6 slices · renders as a donut). Text-matrix sub-types: `comparison-table` (N options × M criteria), `force-field` (drivers vs resistors), `strengths-cautions` (pros/cons/verdict per option). Triggers: ranked numeric → bar-chart · chronology / historical analogue / projected sequence → timeline · distribution that sums (probability split / vote tallies / shares / mix) → pie-chart · 2-axis plot → quadrant-chart · N-options-with-mixed-cells → comparison-table · for/against forces → force-field · pros/cons/verdict matrix → strengths-cautions. **Beyond `visuals`, the writer ALSO emits inline charts (flowchart / mindmap / gantt / sequenceDiagram / stateDiagram / journey, all rendered through the `kami-chart` pipeline) inside body sections where prose can't carry the structure efficiently** — these are automatic and don't need to be picked here.",
  "  · `metric-strip`        3–5 KPI / indicator cards · the room's quantitative reads as a dashboard row. Pick whenever ≥ 3 numbers (percentages, time windows, ratios, counts, ranges) showed up worth surfacing side-by-side. Massively higher information density than the same numbers buried in prose — strongly favoured for investment / market-forecast / strategic-decision briefs.",
  "  · `two-paths`           Side-by-side trajectory comparison (Path A vs Path B). Pick when the room argued two distinct futures or routes — punchier than a comparison-table.",
  "  · `why-now`             Single panel: window opened by what · window closes when · the bet implied. For investment / opportunity rooms (a16z-thesis spine).",
  "  · `risk-register`       3–7 risks tagged with severity × likelihood × owner × mitigation. Carries BOTH operating-environment risks (whether or not we act) AND concrete recommendation-failure modes when the room raised them. Categories: market / execution / product / team / financial / compliance / technical. Pick whenever the room had ≥ 3 risk signals and the call is consequential. Strong fit for strategy_memo / execution_plan / risk_review archetypes.",
  "  · `decision-options`    2–5 named candidate options with shared pros/cons, effort + confidence tags, and ONE flagged as the recommended pick + a rationale anchor. Distinct from `comparison-table` (raw freeform matrix) and `two-paths` (binary). Pick whenever the room weighed ≥ 2 named options and the choice is the load-bearing output. Strong fit for decision_brief / debate_summary archetypes.",
  "  · `path-comparison`     EXACTLY 2 paths · verdict-tagged side-by-side structural comparison. Each path: short verdict (\"structurally fragile\" / \"plausibly defensible\"), serif name, 4-6 characteristic bullets. Stance (\"weak\" / \"strong\" / \"neutral\") drives accent colour — the verdict IS the recommendation, no separate flag. Highest fit when the room's hinge was ONE binary structural choice (replacement vs augmentation, vertical vs horizontal, build vs partner, replace vs augment) where one trajectory is structurally weaker. Distinct from `two-paths` (prose-only, no verdict) and `decision-options` (N options with matrix). Pair `path-comparison` with the binary view; pair `decision-options` with N>2 options; pair `two-paths` only when the comparison is narrative prose without bullet structure.",
  "  · `new-questions`       Questions that did NOT exist when the room opened but emerged. The most generative output of a multi-director session.",
  "  · `planning-assumption` Forward-looking probabilistic statement with falsification test. For market / strategy / forecasting rooms.",
  "  · `open-questions`      Residual unresolved questions tagged P0/P1.",
  "",
  "Gartner-density blocks · pick these when the room's value lives in the analysis of UNCERTAINTY, not in conclusions alone. These are the blocks that make a brief feel like a research-grade analysis instead of a meeting recap. Pull in 1–3 of them for any strategic-decision / market-forecast / impact-analysis room.",
  "  · `strategic-outlook`     2-paragraph context + implication, sits between the anchor and the findings. Use when the room needs to set up the operating environment before findings make sense (geopolitics, macro shifts, market state).",
  "  · `critical-assumptions`  4–6 load-bearing assumptions, each with confidence + falsifier + time horizon. Use when the brief's logic rests on assumptions that could shift — surfacing them lets the reader stress-test the conclusion.",
  "  · `scenario-tree`         2–4 named futures (typically Base / Upside / Downside) with probabilities, triggers, effects, decision implications. Use whenever the room argued multiple futures — richer than `two-paths` because it adds probability + trigger + decision implication per branch.",
  "  · `leading-indicators`    3–5 signals to monitor with thresholds + cadence + scenario each indicator confirms. Use when the brief tells the reader to wait-and-watch, or when scenarios diverge based on observable signals.",
  "  · `threats-to-validity`   3–5 ways the *analysis itself* could be wrong (selection bias, generalizability ceiling, sample of N, lens blind spot, confounding). Each names a category, the threat in 1-2 sentences, an observable that would prove it realized, severity, and an optional mitigation. Distinct from `risk-register` (operating-environment risks) and from `critical-assumptions` (the foundations the brief rests on). Pull in for `anthropic` / `gartner-research` / any brief where the room had a real moment of intellectual honesty — surfacing how we could be wrong is a load-bearing section, not a caveat.",
  "",
  "## Composition rules · violations are rejected",
  "",
  "· Exactly 1 anchor (from `bottom-line` / `thesis` / `working-hypothesis`).",
  "· Exactly 1 findings (from `headline-findings` / `big-ideas`).",
  "· Exactly 1 action (from `recommendations` / `the-bet` / `considerations`).",
  "· Honour the ASSET BUDGET printed in the user message. Density caps are non-negotiable: ≤ 12 total entries → max 8 components · 13–24 entries → max 10 · > 24 → max 12. A brief built on 12 entries across 10 components recycles each entry across multiple sections, producing thin / repetitive coverage. Pick fewer components when the material is thin — it's strictly better.",
  "· Lens-fit constraint: do NOT pick `metric-strip` when the ASSET BUDGET reports zero data-lens claims AND zero data-kind evidence. The writer cannot fabricate quantitative cards from non-quantitative material; the resulting section will be empty or wrong.",
  "· Drop a component if the conversation didn't produce material for it. Empty sections are worse than missing ones.",
  "· Spine ≠ template. Pick the spine whose voice fits the topic, then pick components independently.",
  "",
  "## Coverage matrix · the asset bundle dictates which components are MANDATORY",
  "",
  "The user message's ASSET BUDGET prints `Coverage triggers` listing what the room produced material for. Each trigger names a component (or alternatives) that MUST appear in your pick. Ignoring a trigger is automatic rejection by validatePicks — the rationale being: if the room raised tensions / risks / open questions / concrete actions / data, the report MUST surface them in a structurally distinct component, not bury them in generic findings.",
  "",
  "· `tensions ≥ 1` → MUST include `divergence` OR `positions`.",
  "· `risks ≥ 1` → MUST include `risk-register` OR `threats-to-validity`.",
  "· `openQuestions ≥ 1` → MUST include `open-questions` OR `new-questions`.",
  "· `actions ≥ 2` (concrete imperatives) → action component must be `recommendations` or `the-bet`, NOT `considerations` (which softens imperatives into hedges).",
  "· `dataAvailable ≥ 3` (data-lens claims + data-kind evidence) → MUST include `metric-strip` OR `visuals`. Numbers buried in prose lose their force.",
  "",
  "These rules ALSO apply transitively: if the asset bundle has 0 entries for a trigger, the matching component is encouraged but not mandatory.",
  "",
  "## Visualisation discipline · prefer charts where they fit naturally",
  "",
  "Reports benefit from diagrams when content has structure prose can't carry efficiently — but no fixed quota. Pick components that auto-fire charts (divergence / positions / decision-options / scenario-tree / risk-register / recommendations / convergence) when their material is real in the room. Skip them when material is thin. Source of charts (either / both):",
  "  1. Pick `visuals` with chart sub-types (`quadrant-chart` / `bar-chart` / `timeline` / `pie-chart`) — these render as inline SVG through the `kami-chart` pipeline (spine-tokenised, no JS runtime).",
  "  2. Stage 3 writer auto-emits inline charts (`flowchart` / `mindmap` / `gantt` / `sequenceDiagram` / `stateDiagram` / `journey`, all rendered through the `kami-chart` pipeline) on a per-section basis when content fits — knowing this helps you avoid double-allocating the same content to a typed visual.",
  "",
  "**Quality over quantity.** A substantive strategy brief might naturally land at 4–6 charts; a tight philosophical brief at 0–1; both are correct. Don't manufacture chart material that isn't in the conversation — that produces hollow diagrams that distract more than they inform.",
  "",
  "**Trigger map** (loose match — pick the matching visual whenever the room produced material that fits):",
  "  · ≥ 3 quantitative claims (percentages, ratios, time windows, counts) AND data lens > 0 → `metric-strip` (KPI dashboard) + `bar-chart` if the numbers are ranked across items.",
  "  · ≥ 2 named options / paths compared on shared criteria → `visuals` with `quadrant-chart` (2-axis plot, preferred) or `strengths-cautions` / `comparison-table` (when no axis).",
  "  · The room argued multiple futures → `scenario-tree` (probabilities + triggers) AND optionally `visuals.pie-chart` for the probability split.",
  "  · Watch-and-wait stance with named signals to monitor → `leading-indicators`.",
  "  · ANY chronology of ≥ 3 dated events (history / phases / projected sequence) → `visuals.timeline` is the strongest pick — chronology MUST go to timeline, not prose.",
  "  · ANY distribution of weights that sums (vote counts, scenario probabilities, lens shares, market mix) → `visuals.pie-chart`.",
  "  · ANY decision branch / if-then logic the room raised → the writer auto-emits an inline `flowchart`. You don't need to plan it, but ensure `risk-register` or `divergence` is picked so the writer has a section to attach it to.",
  "  · ANY brainstorm-style branching (radial framings / idea clusters off a central premise) → the writer auto-emits an inline `mindmap`. Pair with `big-ideas` or `new-questions` so it has a home.",
  "  · ANY multi-phase rollout with dependencies → the writer auto-emits an inline `gantt` inside `recommendations`. Ensure `recommendations` is picked (not `considerations`).",
  "  · ANY multi-party negotiation / approval-chain / system-call sequence → the writer auto-emits an inline `sequenceDiagram`. Surfaces under whichever section names the actors.",
  "  · ANY lifecycle / state-machine / phase-gating story → the writer auto-emits an inline `stateDiagram-v2`. Attach to `recommendations` or a `risk-register` branch.",
  "",
  "Truly unvisualisable rooms (purely philosophical / definitional / no concrete entities) are allowed to skip — but they're rare. **When in doubt, pick `visuals` with a chart sub-type.** Reports without a chart in 2026 read as 2018-era memos.",
  "",
  "## Picking presets",
  "",
  "· If unsure → `boardroom-dark` spine and the safe set: `bottom-line` + `frame-shift` + `headline-findings` + `convergence` (or `divergence`) + `visuals` (or `metric-strip` when the room had numbers) + `recommendations` + `new-questions` + `open-questions`. Note the visual is in the safe set now — earlier presets that omitted visualisation produced flat reports.",
  "· Strategic / market / forecast / impact-analysis subjects → `boardroom-dark` (or `gartner-note`) spine and the dense set: `bottom-line` + `metric-strip` + `strategic-outlook` + `headline-findings` + `critical-assumptions` + `scenario-tree` + `risk-register` + `leading-indicators` + `recommendations` + `new-questions`. ~10 components — feels like a research dashboard.",
  "· Investment / market opportunity rooms → `a16z-thesis` spine and: `thesis` + `metric-strip` + `why-now` + `big-ideas` + `risk-register` + `scenario-tree` + `new-questions` + `the-bet`. The metric-strip carries the underwriting numbers; the-bet sits last as the action close.",
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
  perDirectorAssets: DirectorAssets[];
  language: ReportLanguage;
  /** Optional supplementary perspective the user supplied — affects the
   *  composer's pick (e.g. "look at this as a Gartner-style scan" should
   *  flip the spine). */
  supplement?: string;
}

export function buildComposerMessages(opts: BuildOpts): LLMMessage[] {
  const { room, members, perDirectorAssets, language, supplement } = opts;

  const directors = members
    .filter((m) => m.roleKind === "director")
    .map((a) => `${a.id} · ${a.name} (${a.handle}) — ${a.roleTag}`)
    .join("\n  · ");

  // Asset budget · structural counts per field across all directors,
  // plus the lens distribution from `claims`. The composer uses these
  // to (1) size component density caps, (2) honour lens-fit constraints
  // (no metric-strip when zero `data` lens claims AND zero data
  // evidence), and (3) trigger the coverage matrix in validatePicks
  // (tensions present → must include divergence/positions, etc.).
  let totalAssets = 0;
  const counts = {
    claims: 0, evidence: 0, tensions: 0, assumptions: 0,
    risks: 0, opportunities: 0, actions: 0, quotes: 0, openQuestions: 0,
  };
  const lensCounts: Record<string, number> = {
    data: 0, dissent: 0, narrative: 0, structural: 0, "first-principle": 0,
  };
  let evidenceDataCount = 0;
  for (const d of perDirectorAssets) {
    counts.claims += d.claims.length;
    counts.evidence += d.evidence.length;
    counts.tensions += d.tensions.length;
    counts.assumptions += d.assumptions.length;
    counts.risks += d.risks.length;
    counts.opportunities += d.opportunities.length;
    counts.actions += d.actions.length;
    counts.quotes += d.quotes.length;
    counts.openQuestions += d.openQuestions.length;
    for (const c of d.claims) {
      if (lensCounts[c.lens] !== undefined) lensCounts[c.lens] += 1;
    }
    for (const e of d.evidence) {
      if (e.kind === "data") evidenceDataCount += 1;
    }
    totalAssets +=
      d.claims.length + d.evidence.length + d.tensions.length +
      d.assumptions.length + d.risks.length + d.opportunities.length +
      d.actions.length + d.quotes.length + d.openQuestions.length;
  }
  const dataAvailable = lensCounts.data + evidenceDataCount;
  const lensRow = (["data", "dissent", "narrative", "structural", "first-principle"] as const)
    .map((l) => `${l} ${lensCounts[l]}`)
    .join(" · ");

  // Per-field asset rendering · each asset entry is shown WITH its
  // category prefix so the composer can see what KIND of material the
  // room produced and pick components that match. Indices are
  // field-local (e.g. `claim:2`) — Stage 2 doesn't cite by these,
  // they're just for the composer's readability.
  const assetsBlock = perDirectorAssets
    .map((d) => {
      const lines: string[] = [];
      const total =
        d.claims.length + d.evidence.length + d.tensions.length +
        d.assumptions.length + d.risks.length + d.opportunities.length +
        d.actions.length + d.quotes.length + d.openQuestions.length;
      if (total === 0) {
        return `[${d.directorId}] ${d.directorName} — (no assets)`;
      }
      d.claims.forEach((c, i) => {
        const conf = c.confidence ? ` · ${c.confidence}` : "";
        lines.push(`  · claim:${i} [${c.lens}${conf}] ${c.text}`);
      });
      d.evidence.forEach((e, i) => {
        lines.push(`  · evidence:${i} [${e.kind}] ${e.text}`);
      });
      d.tensions.forEach((t, i) => {
        const w = t.with.length ? ` w/ ${t.with.join("+")}` : "";
        lines.push(`  · tension:${i}${w} ${t.text}`);
      });
      d.assumptions.forEach((u, i) => {
        const fals = u.falsifier ? ` · falsifier: ${u.falsifier}` : "";
        lines.push(`  · assumption:${i}${fals} ${u.text}`);
      });
      d.risks.forEach((r, i) => {
        const sev = r.severity ? `·${r.severity}` : "";
        lines.push(`  · risk:${i}${sev} ${r.text}`);
      });
      d.opportunities.forEach((o, i) => {
        lines.push(`  · opportunity:${i} ${o.text}`);
      });
      d.actions.forEach((a, i) => {
        const owner = a.owner ? `·${a.owner}` : "";
        const horizon = a.horizon ? `·${a.horizon}` : "";
        lines.push(`  · action:${i}${owner}${horizon} ${a.text}`);
      });
      d.quotes.forEach((q, i) => {
        lines.push(`  · quote:${i} "${q.text}"`);
      });
      d.openQuestions.forEach((oq, i) => {
        lines.push(`  · openQuestion:${i}·${oq.priority} ${oq.text}`);
      });
      return `[${d.directorId}] ${d.directorName}\n${lines.join("\n")}`;
    })
    .join("\n\n");

  // Coverage triggers · printed inline in the budget so the composer
  // knows which components are MANDATORY when the room produced
  // material for them. Mirrored by validatePicks coverage checks; if
  // the model ignores a trigger, the parser rejects the pick.
  const coverageTriggers: string[] = [];
  if (counts.tensions > 0) {
    coverageTriggers.push(`· ${counts.tensions} tension${counts.tensions === 1 ? "" : "s"} surfaced → MUST include \`divergence\` OR \`positions\` (don't bury tensions inside generic findings).`);
  }
  if (counts.risks > 0) {
    coverageTriggers.push(`· ${counts.risks} risk${counts.risks === 1 ? "" : "s"} surfaced → MUST include \`risk-register\` OR \`threats-to-validity\`.`);
  }
  if (counts.openQuestions > 0) {
    coverageTriggers.push(`· ${counts.openQuestions} open question${counts.openQuestions === 1 ? "" : "s"} surfaced → MUST include \`open-questions\` OR \`new-questions\`.`);
  }
  if (counts.actions > 0 && counts.actions >= 2) {
    coverageTriggers.push(`· ${counts.actions} concrete actions surfaced → action component should be \`recommendations\` or \`the-bet\` (NOT \`considerations\` — the room produced imperatives, not hedges).`);
  }
  if (dataAvailable >= 3) {
    coverageTriggers.push(`· ${dataAvailable} data-shaped entries (data-lens claims + data-kind evidence) → MUST include \`metric-strip\` OR a \`visuals\` block. Numbers buried in prose lose force.`);
  }

  const budgetBlock = [
    `─── ASSET BUDGET ───`,
    `Total entries: ${totalAssets}`,
    `Field counts: claims ${counts.claims} · evidence ${counts.evidence} · tensions ${counts.tensions} · assumptions ${counts.assumptions} · risks ${counts.risks} · opportunities ${counts.opportunities} · actions ${counts.actions} · quotes ${counts.quotes} · openQuestions ${counts.openQuestions}`,
    `Claim-lens distribution: ${lensRow}`,
    `Evidence kinds: data ${evidenceDataCount} · case ${counts.evidence - evidenceDataCount - perDirectorAssets.reduce((n, d) => n + d.evidence.filter((e) => e.kind === "quote").length, 0)} · quote ${perDirectorAssets.reduce((n, d) => n + d.evidence.filter((e) => e.kind === "quote").length, 0)}`,
    `Component cap by total entries: ${
      totalAssets <= 12 ? "≤ 8 components" :
      totalAssets <= 24 ? "≤ 10 components" :
      "≤ 12 components"
    } — pick fewer than the cap when the room's material doesn't fill them substantively.`,
    dataAvailable === 0
      ? `Lens-fit constraint: zero data-lens claims AND zero data-kind evidence → DO NOT pick \`metric-strip\`. The writer would have to fabricate numbers.`
      : `Lens-fit: ${dataAvailable} data-shaped entries — \`metric-strip\` is fittable.`,
    coverageTriggers.length > 0 ? "" : null,
    coverageTriggers.length > 0 ? "Coverage triggers (validatePicks rejects missing):" : null,
    ...coverageTriggers,
    `─── END BUDGET ───`,
  ].filter((s) => s !== null).join("\n");

  // Room tone block · the highest-priority steer. Printed before the
  // signal budget and the signals themselves so the composer reads the
  // tone constraint BEFORE seeing the material — picking from the
  // room's working agreement, not from the material in isolation.
  const tone = (room.mode || "constructive").toLowerCase();
  const intensity = (room.intensity || "sharp").toLowerCase();
  const { prefer: tonePrefer, avoid: toneAvoid } = houseStylesForTone(tone);
  const toneBlock = [
    `─── ROOM TONE (HIGHEST-PRIORITY STEER) ───`,
    `Mode: ${tone}`,
    `Intensity: ${intensity}`,
    tonePrefer.length
      ? `House styles that fit this tone: ${tonePrefer.map((id) => "`" + id + "`").join(", ")}`
      : "House styles that fit this tone: (none specifically — `boardroom-default` is the safe fallback)",
    toneAvoid.length
      ? `House styles to AVOID for this tone: ${toneAvoid.map((id) => "`" + id + "`").join(", ")}. Picking one of these requires a justification in \`rationale\` for why the material overrides the tone fit.`
      : "House styles to AVOID for this tone: (none — any preset is fittable)",
    `─── END ROOM TONE ───`,
  ].join("\n");

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
        ``,
        toneBlock,
        ``,
        `Directors:`,
        `  · ${directors || "(none)"}`,
        ``,
        budgetBlock,
        ``,
        `─── ASSETS ───`,
        ``,
        assetsBlock || "(no assets extracted)",
        ``,
        `─── END ASSETS ───`,
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
]);


interface ValidationProblem {
  reason: string;
}

/** Coverage-matrix inputs · let `validatePicks` know what KIND of
 *  material the room produced, so it can reject picks that ignore the
 *  available evidence (e.g. the room raised tensions but the composer
 *  picked nothing to surface them). Caller passes per-field totals
 *  derived from `perDirectorAssets`. All-zero `coverage` skips the
 *  matrix (e.g. the test path that doesn't have asset context). */
export interface CoverageInputs {
  /** Total tensions across all directors. */
  tensions?: number;
  /** Total risks across all directors. */
  risks?: number;
  /** Total open questions across all directors. */
  openQuestions?: number;
  /** Total concrete actions across all directors. */
  actions?: number;
  /** Total data-shaped entries (data-lens claims + data-kind evidence). */
  dataAvailable?: number;
}

/**
 * Parse + validate the composer's raw JSON. Returns null when the
 * output is unrecoverable — callers fall back to DEFAULT_PRESET.
 *
 * The optional `coverage` argument injects asset counts so the
 * coverage matrix in `validatePicks` can reject picks that ignored
 * the available material (tensions surfaced but no divergence /
 * positions, risks surfaced but no risk-register / threats-to-validity,
 * etc.). Tests / callers without asset context can omit it; the
 * baseline structural validation (1 anchor + 1 findings + 1 action,
 * 5–12 components) still runs.
 */
export function parseComposerOutput(
  raw: string,
  coverage: CoverageInputs = {},
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

  // House style · no mode-specific coercion. Brainstorm/critique used
  // to coerce to field-notes / audit-memo; both retired.
  const houseStyleRaw = typeof parsed.house_style === "string"
    ? parsed.house_style
    : typeof parsed.houseStyle === "string"
      ? parsed.houseStyle
      : "";
  const houseStyleTrim = houseStyleRaw.trim();
  const houseStyle = HOUSE_STYLE_SET.has(houseStyleTrim) ? houseStyleTrim : "boardroom-default";

  // Spine · default to the picked house style's preferred spine when
  // the composer didn't name one (or named an unknown slug).
  const spineRaw = typeof parsed.spine === "string" ? parsed.spine.trim() : "";
  const spine: Spine = SPINE_SET.has(spineRaw)
    ? (spineRaw as Spine)
    : resolveHouseStyle(houseStyle).spine;

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

  const problem = validatePicks(picks, coverage);
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
    houseStyle,
    fromComposer: true,
  };
}

function validatePicks(
  picks: ComponentPick[],
  coverage: CoverageInputs = {},
): ValidationProblem | null {
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

  // Coverage matrix · enforce that picks honour the asset material the
  // room actually produced. Each rule fires only when the corresponding
  // asset count is non-zero — skipping the matrix is the correct
  // behaviour when assets aren't supplied (legacy callers + tests).
  const tensions = coverage.tensions ?? 0;
  const risks = coverage.risks ?? 0;
  const openQuestions = coverage.openQuestions ?? 0;
  const actions = coverage.actions ?? 0;
  const dataAvailable = coverage.dataAvailable ?? 0;

  if (tensions > 0 && !kinds.has("divergence" as ComponentKind) && !kinds.has("positions" as ComponentKind)) {
    return { reason: `${tensions} tension(s) surfaced; pick must include 'divergence' or 'positions'` };
  }
  if (risks > 0 && !kinds.has("risk-register" as ComponentKind) && !kinds.has("threats-to-validity" as ComponentKind)) {
    return { reason: `${risks} risk(s) surfaced; pick must include 'risk-register' or 'threats-to-validity'` };
  }
  if (openQuestions > 0 && !kinds.has("open-questions" as ComponentKind) && !kinds.has("new-questions" as ComponentKind)) {
    return { reason: `${openQuestions} open question(s) surfaced; pick must include 'open-questions' or 'new-questions'` };
  }
  if (actions >= 2 && kinds.has("considerations" as ComponentKind)) {
    return { reason: `${actions} concrete actions surfaced; action component should be 'recommendations' or 'the-bet', not 'considerations' (which softens imperatives)` };
  }
  if (dataAvailable >= 3 && !kinds.has("metric-strip" as ComponentKind) && !kinds.has("visuals" as ComponentKind)) {
    return { reason: `${dataAvailable} data-shaped entries available; pick must include 'metric-strip' or 'visuals' to surface them` };
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
 */
export function defaultComposition(reason: string): ComposerResult {
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
