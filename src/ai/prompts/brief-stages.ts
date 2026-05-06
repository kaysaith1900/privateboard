/**
 * Three-stage brief pipeline prompts.
 *
 *   Stage 1 · per-director extract  · short JSON list of signals
 *   Stage 2 · chair cluster/scaffold · JSON scaffold of findings
 *   Stage 3 · chair final write     · markdown report (streamed)
 *
 * Each stage's prompt is intentionally narrow so the LLM call can use
 * a smaller / cheaper model (haiku for stage 1) while the synthesis
 * stages stay strong.
 */
import type { LLMMessage } from "../adapter.js";
import type { Agent } from "../../storage/agents.js";
import type { Message } from "../../storage/messages.js";
import type { Room } from "../../storage/rooms.js";
import { houseStyleLabel, resolveHouseStyle } from "./house-styles.js";
import type { ComponentKind } from "./composer.js";

/** The five evidence lenses. Stage 2/3 enforce at least 2 distinct
 *  lenses per finding to guarantee diversity. */
export const EVIDENCE_LENSES = [
  "data",
  "dissent",
  "narrative",
  "structural",
  "first-principle",
] as const;
export type EvidenceLens = (typeof EVIDENCE_LENSES)[number];

export interface ExtractedSignal {
  text: string;
  lens: EvidenceLens;
  /** Indices into the director's own message list (0-based). */
  sources: number[];
}

export interface DirectorSignals {
  directorId: string;
  directorName: string;
  signals: ExtractedSignal[];
}

/** Confidence level — used on bottom line, headline findings, divergence
 *  rows, and recommendations. */
export type Confidence = "high" | "medium" | "low";

/** Section 2 · Bottom Line Up Front. Single-sentence judgement + confidence
 *  + a one-sentence rationale. Rendered as a designed callout in the report. */
export interface BottomLine {
  /** One-sentence load-bearing judgement of the whole session. */
  judgement: string;
  confidence: Confidence;
  /** One sentence on why we have that confidence (or why we don't have more). */
  rationale: string;
}

/** Section 3 · Frame Shift. The single most distinctive multi-director
 *  output: how the question itself changed during the session. If the
 *  frame did not shift, `shifted: false` and the section restates the
 *  question with the room's deeper understanding. */
export interface FrameShift {
  shifted: boolean;
  /** What the question looked like at the room's open. */
  original: string;
  /** What the question looks like now. Empty when shifted=false. */
  reframed: string;
  /** Why the reframe happened (or why the frame held). */
  trigger: string;
}

/** Section 4 · Headline Finding. Pyramid principle: exactly 3 of these
 *  per report, MECE-enforced. Each is a complete-sentence claim with
 *  supporters / challengers visible, confidence on the claim, and 2-3
 *  supporting sub-findings drawing on the evidence pool. */
export interface SubFinding {
  /** Complete sentence — typically 1-2 sentences of substance. */
  text: string;
  evidenceRefs: string[];
}
export interface HeadlineFinding {
  /** Complete-sentence section heading (not a topic — a takeaway). */
  title: string;
  /** Single-sentence claim (the load-bearing line). */
  claim: string;
  confidence: Confidence;
  /** Director ids who advanced this. */
  supporters: string[];
  /** Director ids who challenged this. Empty array when full alignment. */
  challengers: string[];
  /** 2-3 sub-findings that prove the claim. */
  supporting: SubFinding[];
  /** Lens tags spanning the sub-findings — must have ≥ 2 distinct. */
  lensesPresent: EvidenceLens[];
  /** Optional unresolved tension on this finding. */
  tension?: string;
  /** Counter-evidence the room raised against this finding · 1-2
   *  sentences naming the strongest argument *against* the claim. Makes
   *  the room's adversarial review structurally visible. Optional on
   *  legacy scaffolds; required on dense Gartner-style briefs. */
  counterEvidence?: string;
  /** What this finding implies for the decision the room is wrestling
   *  with · 1 sentence. Closes the gap between "interesting fact" and
   *  "actionable judgment". Optional on legacy scaffolds. */
  strategicImplication?: string;
}

/** Section 5 · Convergence point — where directors arrived at the same
 *  conclusion via independent reasoning paths. The "independence" is what
 *  makes this load-bearing, so each path includes the lens used and the
 *  director's specific reasoning chain. */
export interface ConvergencePath {
  directorId: string;
  /** The lens the director's path leans on (data / dissent / etc.). */
  lens: EvidenceLens;
  /** One-sentence reasoning chain that led this director to the point. */
  reasoning: string;
}
export interface ConvergencePoint {
  /** What the room agreed on, in one sentence. */
  point: string;
  /** Independent paths · ≥ 2 directors via ≥ 2 distinct lenses. */
  paths: ConvergencePath[];
}

/** Section 6 · Divergence (the Crux). Extends the previous Crux shape
 *  with confidence and cost-of-being-wrong per director, plus what we'd
 *  need to know to resolve it. */
export type DivergenceStance = "for" | "against" | "nuanced";
export interface DivergenceRow {
  directorId: string;
  stance: DivergenceStance;
  confidence: Confidence;
  /** What's at risk if this director is wrong. ≤ 80 chars. */
  costOfBeingWrong: string;
  /** Director's specific take. ≤ 80 chars. */
  note: string;
}
export interface Divergence {
  /** The single point everything hinges on, in one sentence. */
  statement: string;
  rows: DivergenceRow[];
  /** What we'd need to know to settle the divergence. 1-3 items. */
  resolutionRequirements: string[];
}

/** Section 7 · Position camps (existing). 2–3 named camps, each with a
 *  collective claim, the directors in it, and supporting signals. */
export interface PositionCamp {
  label: string;
  claim: string;
  directors: string[];
  evidenceRefs: string[];
}

/** Section 8 · Visual blocks. 0–4 allowed (was 0–2). Options Analysis
 *  scenarios should produce ≥ 1 visual; otherwise content-driven. */
export interface ComparisonTableVisual {
  type: "comparison-table";
  title: string;
  rowLabel: string;
  columns: string[];
  rows: { name: string; cells: string[] }[];
}
export interface QuadrantChartVisual {
  type: "quadrant-chart";
  title: string;
  xLabel: string;
  yLabel: string;
  q1: string; q2: string; q3: string; q4: string;
  items: { label: string; x: number; y: number }[];
}
export interface ForceFieldVisual {
  type: "force-field";
  title: string;
  drivers: string[];
  resistors: string[];
}
/** Strengths-and-cautions table — one row per option, with a pros / cons
 *  pair plus a recommendation tag. McKinsey-style "what's the trade?". */
export interface StrengthsCautionsVisual {
  type: "strengths-cautions";
  title: string;
  rows: {
    option: string;
    strengths: string[];
    cautions: string[];
    /** "Recommended" / "Caution required" / "Not recommended" — drives a colored badge. */
    verdict: "recommended" | "caution" | "not-recommended";
  }[];
}

/** Ranked bar chart · 2–8 bars side-by-side comparing one quantitative
 *  dimension across labelled items. Rendered through mermaid
 *  `xychart-beta`. Use when the room produced a comparable measure
 *  (cost, support strength, time-to-ship, market size) across discrete
 *  named items. */
export interface BarChartVisual {
  type: "bar-chart";
  title: string;
  /** Y-axis caption (the quantity being measured). ≤ 32 chars. */
  yLabel: string;
  /** Optional unit · rendered after the value in the description.
   *  Empty string is fine (mermaid ignores). ≤ 16 chars. */
  unit: string;
  bars: {
    /** Item name on the X axis. ≤ 24 chars. Avoid quotes / colons / brackets. */
    label: string;
    /** Numeric reading. Stage 2 emits as a number — Stage 3 stringifies for
     *  mermaid. */
    value: number;
  }[];
}

/** Timeline · 3–8 dated points telling the room's narrative arc
 *  (history beats / project phases / scenario chronology). Rendered
 *  through mermaid `timeline`. Strong fit for retro / historical-
 *  analogue / first-round-essay registers; opportunistic everywhere
 *  else. */
export interface TimelineVisual {
  type: "timeline";
  title: string;
  points: {
    /** Period label · the X-axis stop. ≤ 24 chars. ("2019", "Q3 2024",
     *  "Today", "+12 mo"). */
    period: string;
    /** Short event label. ≤ 60 chars. Concrete; avoid corporate verbs. */
    label: string;
    /** Optional one-clause expansion. ≤ 140 chars. Empty string is
     *  fine — the period + label often carry the point. */
    description: string;
  }[];
}

/** Pie chart · 2–6 slices showing a distribution. Rendered through
 *  mermaid `pie showData`. Slice values can be percentages (sum ~100)
 *  OR raw counts — mermaid normalises. The room's typical hits:
 *  scenario-tree probability split, lens distribution, vote tallies,
 *  market-share read. */
export interface PieChartVisual {
  type: "pie-chart";
  title: string;
  slices: {
    /** ≤ 32 chars. Avoid quotes / colons. */
    label: string;
    /** Number ≥ 0. */
    value: number;
  }[];
}

export type Visual =
  | ComparisonTableVisual
  | QuadrantChartVisual
  | ForceFieldVisual
  | StrengthsCautionsVisual
  | BarChartVisual
  | TimelineVisual
  | PieChartVisual;

/** Section 9 · Recommendation. Concrete action with priority, rationale,
 *  owner type, time horizon, and a success metric. Rendered as a numbered
 *  table or a labelled card.
 *
 *  v2 adds `criticalDependency` — the single thing that must be true for
 *  this action to work. Surfacing it explicitly turns the recommendation
 *  from a directive into a stress-testable plan. Optional for legacy
 *  scaffolds. */
export type Priority = "P0" | "P1" | "P2";
export interface Recommendation {
  priority: Priority;
  /** Imperative concrete action. */
  action: string;
  /** Why this works — 1-2 sentences. */
  rationale: string;
  /** Who should execute (e.g. "platform team", "the user", "PM"). */
  ownerType: string;
  /** Time horizon (e.g. "next 30 days", "Q2 2026"). */
  horizon: string;
  /** Observable proof of execution. */
  successMetric: string;
  /** What happens if you skip this. */
  riskIfSkipped: string;
  /** What MUST be true for this action to work (the load-bearing
   *  pre-condition). Empty/undefined on legacy scaffolds. */
  criticalDependency?: string;
}

/** Section 10 · Pre-mortem. How the recommendations could fail, with
 *  leading indicators that would warn us early. 2-3 failure modes. */
export interface FailureMode {
  /** How the recommendation could fail. 1 sentence. */
  scenario: string;
  /** Earliest observable warning sign. */
  leadingIndicator: string;
  /** What to do if the leading indicator fires. */
  mitigation: string;
}

/** Section 11 · New Questions Surfaced. Distinct from openQuestions
 *  (residuals) — these are questions that did not exist when the room
 *  opened but emerged from the conversation. The most generative output
 *  of a multi-director session. */
export interface NewQuestion {
  /** Complete question, ending with ?. */
  question: string;
  /** Why answering this matters next. */
  whyItMatters: string;
  /** Director id who first surfaced it. */
  surfacedByDirectorId: string;
}

/** Section 12 · Strategic Planning Assumption. A forward-looking
 *  probabilistic statement with conditions and a falsifiable test. */
export interface PlanningAssumption {
  /** Forward-looking statement. e.g. "By Q4 2027, X% of platforms will…" */
  statement: string;
  /** 0-100 integer. */
  probability: number;
  /** Conditions / triggers under which the statement holds. */
  trigger: string;
  /** Observable that would prove this wrong. */
  falsificationTest: string;
}

/** Open questions · residual unresolved questions (≠ NewQuestions). */
export type OpenQuestionPriority = "P0" | "P1";
export interface OpenQuestion {
  text: string;
  priority: OpenQuestionPriority;
}

/* ─────────── Alternative anchor / findings / action components ────────────
 *
 * The composer (Stage 1.5) picks one component per substitute group. When
 * a non-default substitute is picked, its corresponding field below is
 * filled and the default field (`bottomLine`, `headlineFindings`,
 * `recommendations`) is left empty / null. The renderer skips empty
 * fields, so a brief carrying `thesis` won't render `## Bottom Line`.
 *
 * These types are net-additive — every legacy scaffold passing through
 * `parseScaffold` without these fields keeps working unchanged. */

/** Anchor alternative · single load-bearing thesis claim (a16z style). */
export interface Thesis {
  /** Complete-sentence claim · 12-22 words. */
  claim: string;
  /** Why this is the load-bearing claim · 1-2 sentences. */
  reasoning: string;
}

/** Findings alternative · 3 numbered claims, lighter than HeadlineFindings. */
export interface BigIdea {
  /** 1-based, must equal index+1. */
  number: 1 | 2 | 3;
  /** Punchy claim · 8-14 words. */
  claim: string;
  /** Why · 1-2 sentences. */
  why: string;
  evidenceRefs: string[];
}

/** Action alternative · the conditions to back the call (a16z style). */
export interface TheBetCondition {
  /** Imperative · what must hold to back the call. */
  condition: string;
  /** Why this condition is load-bearing · 1-2 sentences. */
  why: string;
}
export interface TheBet {
  /** Opening sentence · "If we were to back this..." or equivalent. */
  ifBacked: string;
  /** 3-5 conditions. */
  conditions: TheBetCondition[];
  /** When we'd stop — observable failure trigger. */
  killCriteria: string;
}

/** Anchor alternative · Anthropic-style essay opener. The hypothesis
 *  followed by the reasons it might be wrong — invites disagreement
 *  rather than asserting the takeaway. */
export interface WorkingHypothesis {
  /** The hypothesis as one or two sentences in essay voice. */
  hypothesis: string;
  /** 2-3 reasons it may be wrong. Each one short (≤ 30 words). */
  reasonsItMayBeWrong: string[];
}

/** Strategic outlook · 2-paragraph contextual frame that sits between
 *  the anchor (thesis / bottom-line) and the findings. Heavier than a
 *  thesis claim, lighter than a working-hypothesis essay opener. Used
 *  for strategic-decision / market-forecast briefs where the room
 *  needs to set up the operating environment before the findings make
 *  sense. Gartner / Bain "Strategic Outlook" register. */
export interface StrategicOutlook {
  /** Paragraph 1 · the operating context: forces in motion, who's
   *  affected, what's at stake. 2-4 sentences, ≤ 600 chars. */
  context: string;
  /** Paragraph 2 · the strategic implication that flows from the
   *  context — what this changes for decision-makers. 2-3 sentences,
   *  ≤ 500 chars. */
  implication: string;
}

/** Critical assumption · one of 4-6 load-bearing assumptions the brief
 *  rests on. Each has a confidence band, a falsifier (the observable
 *  that would prove it wrong), and a time horizon for when the
 *  assumption needs to hold. Gartner "Critical Assumptions Log"
 *  register — making the foundation visible. */
export interface CriticalAssumption {
  /** The assumption as a complete sentence. ≤ 200 chars. */
  statement: string;
  /** Confidence band on whether the assumption holds. */
  confidence: Confidence;
  /** Observable / event that would prove this assumption wrong. ≤ 200 chars. */
  falsifier: string;
  /** Time window the assumption must hold for the brief's logic to
   *  stand (e.g. "next 12 months", "Q2 2026", "the duration of the
   *  conflict"). ≤ 80 chars. */
  horizon: string;
  /** Which director / lens surfaced this assumption. ≤ 80 chars. */
  attribution: string;
}

/** One scenario in the scenario tree · 2-4 named futures (typically 3:
 *  Base / Upside / Downside, or Path A / B / C) with explicit
 *  probabilities, triggers that would tip into them, the dominant
 *  effects under that scenario, and the decision implication for
 *  stakeholders. Gartner "Scenario Tree". */
export interface ScenarioBranch {
  /** Short name · ≤ 40 chars (e.g. "Protracted stalemate"). */
  label: string;
  /** 0-100 integer · the probability the room assigns to this branch.
   *  All branch probabilities sum to ~100 (drift up to 5pts allowed). */
  probability: number;
  /** What would tip the room into this scenario. ≤ 200 chars. */
  trigger: string;
  /** Dominant effects under this scenario · 2-3 bullets. */
  effects: string[];
  /** What this scenario implies for the decision at hand. ≤ 240 chars. */
  decisionImplication: string;
}
export interface ScenarioTree {
  /** One-sentence framing for the tree. */
  intro: string;
  /** 2-4 named scenarios. Probabilities sum to ~100. */
  branches: ScenarioBranch[];
}

/** Leading indicator · one of 3-5 signals the room recommends
 *  monitoring to detect which scenario is materializing. Each has a
 *  measurable signal, a threshold that flips interpretation, monitoring
 *  cadence, and which scenario(s) the threshold confirms. Gartner /
 *  oncall-runbook discipline. */
export interface LeadingIndicator {
  /** What to watch · short label, ≤ 80 chars. */
  signal: string;
  /** Threshold or pattern that flips the read. ≤ 200 chars. */
  threshold: string;
  /** Cadence (e.g. "daily", "weekly", "every CPI release"). ≤ 60 chars. */
  cadence: string;
  /** What hitting the threshold implies — which scenario it confirms
   *  or which assumption it falsifies. ≤ 240 chars. */
  flipsTo: string;
}

/** Trend direction on a metric card. `null` / undefined when the room
 *  did not produce a directional read. */
export type MetricTrend = "up" | "down" | "flat";

/** A single KPI / indicator card · shows up in the dashboard-style
 *  `metric-strip` component. Exactly one number-like value per card,
 *  surrounded by a label and (optionally) a unit / qualifier and a
 *  trend arrow. The "value" is intentionally a string so the LLM can
 *  emit ranges ("≤ 8%", "18–24 mo"), inequalities ("> 100×"), and CJK
 *  unit spelling ("≈ 三个季度") without losing fidelity to a numeric
 *  type. */
export interface MetricCard {
  /** ≤ 60 chars · what this number measures (e.g. "API revenue at
   *  risk", "Window before parity", "Convergence rate"). */
  label: string;
  /** ≤ 24 chars · the number-like reading (e.g. "≤ 8%", "18 mo",
   *  "3 of 4", "≈ $40M"). Keep it short — long text belongs in the
   *  qualifier or attribution lines, the value is the eye-catch. */
  value: string;
  /** Optional qualifier · one short phrase contextualising the value
   *  (e.g. "of total ARR", "if no leak", "in the base case"). ≤ 80
   *  chars. */
  qualifier: string | null;
  /** Optional directional read. Drives a small ↑ / ↓ / → glyph in the
   *  rendered card. Null when the value is a level, not a direction. */
  trend: MetricTrend | null;
  /** Optional · which director / lens generated the number. ≤ 80
   *  chars. Surfaces multi-director provenance the way Headline
   *  Findings does on the prose side. */
  attribution: string | null;
}

/** Dashboard-style strip of 3-5 indicator cards. The intro is a single
 *  framing sentence; the cards are the actual numbers. Stage 3 emits
 *  this as raw HTML (`<div class="metric-strip"> ...`) so the renderer
 *  can lay it out as a grid with per-spine visual treatment. Picked
 *  whenever the room produced ≥ 3 quantitative claims worth surfacing
 *  side-by-side. */
export interface MetricStrip {
  /** ≤ 200 chars · single sentence framing the strip ("Three numbers
   *  worth pricing in" / "By the numbers" / etc.). The room's house
   *  style provides the section heading; this field is the optional
   *  intro line that opens the strip. Empty string is fine. */
  intro: string;
  /** 3-5 cards. Below 3 reads as token effort; above 5 stops scanning
   *  as a strip. */
  cards: MetricCard[];
}

/** Severity of a validity threat · same coarse band as Confidence. */
export type ThreatSeverity = "low" | "medium" | "high";

/** Threats to validity · Stanford-style critical examination of how
 *  the brief itself could be wrong. Distinct from `pre-mortem` (how
 *  the *recommended action* could fail) and from `critical-assumptions`
 *  (the foundational assumptions the brief rests on, which carry
 *  confidence + falsifier). A threat-to-validity names a way the
 *  *analysis* could be misleading: selection bias, sample of N, lens
 *  blind spot, generalizability ceiling, confounding factor. Each has
 *  a category, the threat itself, an observable that would prove it
 *  realized, severity, and an optional mitigation. The room's
 *  intellectual honesty becomes structural — these are not appendix
 *  caveats, they're a load-bearing section of the brief. */
export interface ThreatToValidity {
  /** Concrete category label · ≤ 50 chars. Examples: "Selection bias",
   *  "Generalizability ceiling", "Construct validity", "Confounding
   *  factor", "Sample of N=1", "Lens blind spot", "Survivorship",
   *  "Anchoring on the loudest director". Pick a *named* category, not
   *  a free-form essay. */
  category: string;
  /** The threat in 1-2 sentences (≤ 280 chars). Concrete: explains
   *  what could be wrong about the *analysis itself*, not what could
   *  go wrong with the recommendation. */
  threat: string;
  /** Observable signal that would prove this threat is realized. ≤ 200
   *  chars. The observable is what makes the threat falsifiable — a
   *  threat without an observable is just a hedge. */
  observable: string;
  /** Severity if the threat is realized · low / medium / high. Drives
   *  visual weighting in the rendered table. */
  severity: ThreatSeverity;
  /** Optional mitigation — what would address or defuse this threat.
   *  ≤ 200 chars. Set null when the room had no concrete mitigation. */
  mitigation: string | null;
}

/** Forward / opportunity panel · used by a16z-thesis spine (and any
 *  spine when the conversation hinged on a window in time). */
export interface WhyNow {
  /** What recently opened this window. ≤ 200 chars. */
  windowOpened: string;
  /** When / why it closes. ≤ 200 chars. */
  windowCloses: string;
  /** The bet implied by the window. ≤ 200 chars. */
  whatToBetOn: string;
}

/** Optional comparison · two trajectories laid out side by side.
 *  Useful when the room argued two named futures (e.g. "platform play
 *  vs vertical play"). The renderer turns this into a 2-column block. */
export interface TwoPathPanel {
  /** Short label · ≤ 32 chars (e.g. "Platform play"). */
  label: string;
  /** 1-paragraph trajectory in prose. ≤ 500 chars. */
  body: string;
}
export interface TwoPaths {
  /** Optional one-sentence framing for both paths. */
  intro: string;
  pathA: TwoPathPanel;
  pathB: TwoPathPanel;
}

/* ───────────────────── Brainstorm-mode components ──────────────────────
 *
 * Used ONLY when `room.mode === "brainstorm"`. The composer's brainstorm
 * pool picks from these instead of the decision-grade kinds (thesis,
 * critical-assumptions, the-bet, etc.).
 *
 * Discipline that separates these from the constructive/decision pool:
 *   · No anchor that commits to a judgement (no `bottomLine` / `thesis`).
 *   · No action section (no `recommendations` / `the-bet`).
 *   · Verbs are exploratory (`could`, `might`, `what if`), never `must`
 *     / `will` / `should`.
 *   · Every "winner pick" is REPLACED by an enumeration. The brief
 *     should leave the user with MORE angles to chase, not one to act on.
 *
 * Field shapes are intentionally narrow — we want Stage 2 to resist the
 * temptation to inflate. Three angles, three consequences, three
 * questions. Quality is in the spread, not the depth.
 * ────────────────────────────────────────────────────────────────────── */

/** Opening hook · 1–2 sentence "what changes if this is real" lead-in.
 *  Replaces `bottomLine` as the brainstorm anchor — explicitly does NOT
 *  state a judgement. Restatement is a pull-quote-style line the renderer
 *  may surface as an italic block above the prose. */
export interface OpeningHook {
  hook: string;
  restatement?: string | null;
}

/** Opportunity shape · "size of the room" beat. Three dimensions:
 *    · scope    · who / where the topic reaches if it plays out
 *    · gravity  · why it pulls attention worth this conversation
 *    · tempo    · the time texture (window opening / decade-long shift)
 *  Optional sizing hint surfaces an analogue (other industry, prior wave)
 *  WITHOUT committing to a forecast number. */
export interface OpportunityShape {
  scope: string;
  gravity: string;
  tempo: string;
  sizingHint?: string | null;
}

/** Adjacent angles · 3–5 distinct ways INTO the topic. Each angle gets a
 *  name (re-usable handle), the lens it takes, and what becomes
 *  interesting when seen this way. NOT ranked, NOT a recommendation —
 *  the deliberate goal is "here are 4 doors, all worth opening." */
export interface AdjacentAngle {
  name: string;
  framing: string;
  whatOpens: string;
}

/** What if this works · the optimistic, generative branch. A 1-sentence
 *  setup ("if this plays out as described") followed by 3 short
 *  consequences worth playing out. Each consequence is exploration, not
 *  prediction — the writer must phrase them as "could / might / would
 *  open up", never as forecasts. */
export interface WhatIfThisWorks {
  setup: string;
  consequences: string[];
}

/** Worth chasing · 3–5 angles the room actually generated heat around.
 *  Replaces `recommendations`. Each gets:
 *    · handle              · 1–4 word reusable label
 *    · whyItPulled         · what made the room return to this angle
 *    · nextTestableQuestion · open-ended question that would advance
 *                              understanding (NOT a milestone / OKR /
 *                              kill-criterion). */
export interface WorthChasingAngle {
  handle: string;
  whyItPulled: string;
  nextTestableQuestion: string;
}

/** Dead ends noted · 0–3 angles the room briefly considered then dropped.
 *  Naming these prevents re-traversal and signals the conversation
 *  actually ranged. Distinct from `pre-mortem` (failure modes for an
 *  action) — this is "we walked down this corridor and turned back."  */
export interface DeadEndNoted {
  angle: string;
  whyDropped: string;
}

/** Brainstorm-mode open question. Different from `OpenQuestion` (which
 *  carries P0/P1 priority for action follow-up). Brainstorm questions are
 *  generative — they expand the field, not close it. Optional
 *  `whatWouldShift` names what answering this would unlock; not a
 *  prediction, not a kill criterion — purely "why this question
 *  matters." */
export interface BrainstormQuestion {
  question: string;
  whatWouldShift?: string | null;
}

/* ───────────────────── Critique-mode components ────────────────────────
 *
 * Used ONLY when `room.mode === "critique"`. The composer's critique
 * pool picks from these instead of the decision-grade kinds. Distinct
 * from brainstorm: critique is AUDIT-shaped (sharp, ranked, procedural)
 * rather than EXPLORATION-shaped.
 *
 * Discipline that separates these from the constructive/decision pool:
 *   · No thesis, no recommendations, no scenarios, no opportunity-shape.
 *     The brief is a deliverable review, not a forward strategy.
 *   · Severity is ranked explicitly. Every issue and every fix is
 *     tagged high/medium/low.
 *   · "What's already good" comes BEFORE issues — auditor decorum +
 *     calibrates the reviewer's signal-to-noise. Skipping it tilts the
 *     critique toward "nothing works", which tanks credibility.
 *   · Voice: inspector / standards-officer. Sharper than constructive,
 *     more procedural than debate.
 * ─────────────────────────────────────────────────────────────────── */

/** Severity tag · used on quality-issues and severity-ranked-fixes. */
export type CritiqueSeverity = "high" | "medium" | "low";

/** Deliverable summary · 1–2 sentence framing of what's being critiqued.
 *  Replaces `bottomLine` as the critique anchor — does NOT pass judgement
 *  on the deliverable, just states what the audit is reviewing. */
export interface DeliverableSummary {
  /** What's under review (e.g. "the v2 onboarding spec", "the proposed
   *  pricing matrix", "the migration runbook"). */
  subject: string;
  /** 1-sentence framing of the audit context: what shape the
   *  deliverable takes (doc / plan / artifact), what the critique is
   *  scoped to. */
  context: string;
  /** Optional one-line audit charter ("called to surface blockers
   *  before launch", "scope: technical correctness only"). */
  charter?: string | null;
}

/** What's already good · 2–4 things working in the deliverable, named
 *  explicitly. Critique discipline says these come BEFORE the issues
 *  — calibrates the reviewer's signal and signals the audit isn't a
 *  hatchet job. Each entry is a 1-sentence note. */
export interface WhatsGood {
  point: string;
  /** Optional · the director who flagged it (their phrasing IS the
   *  point), or which lens the praise comes from. */
  attribution?: string | null;
}

/** Quality issue · a discovered problem with the deliverable. Each
 *  issue is severity-ranked and pairs the symptom (the issue) with
 *  the impact (why it matters). NOT the fix — fixes live in the
 *  severity-ranked-fixes section so the room's diagnosis is separate
 *  from its prescription. */
export interface QualityIssue {
  /** Short title · ≤ 60 chars. */
  title: string;
  /** Severity tag · drives the rendered ordering and the colour band
   *  in spines that show severity visually. */
  severity: CritiqueSeverity;
  /** The issue itself · 1–2 sentences. */
  issue: string;
  /** Why it matters · 1–2 sentences. Concrete impact, not generic
   *  hand-wringing ("this confuses readers"). */
  impact: string;
  /** Optional · which director flagged it / which lens (data,
   *  structural, etc.) surfaced the problem. */
  attribution?: string | null;
}

/** Severity-ranked fix · the prescription paired with each issue (or
 *  cluster of issues). Distinct from `recommendations` — fixes are
 *  scoped to the deliverable under review, not the broader strategy. */
export interface SeverityRankedFix {
  /** Short title · ≤ 60 chars. Phrased as a do-action ("Tighten the
   *  contract for X", "Add a check before Y"). */
  title: string;
  /** Severity matches the issue(s) this fix addresses. */
  severity: CritiqueSeverity;
  /** What to change · 1–2 sentences, concrete and applicable. */
  fix: string;
  /** Rough effort estimate · 1 word ("trivial" / "small" / "medium"
   *  / "large") OR a 1-line note ("~half a day", "needs a re-spec"). */
  effort: string;
  /** Optional · who owns the fix or which role/team it sits with.
   *  Critique is a review — it doesn't dictate ownership unless the
   *  room actually agreed. */
  owner?: string | null;
}

/** Residual risk · things that may still bite even after the fixes
 *  land. Distinct from pre-mortem (which is forward-looking for an
 *  action plan) — these are caveats specific to this deliverable that
 *  can't be neutralised inside this audit's scope. */
export interface ResidualRisk {
  risk: string;
  /** Why this can't be closed inside the audit (out of scope, requires
   *  external dependency, needs more data, etc.). */
  whyResidual: string;
  /** Optional · severity, if it's worth flagging vs. just noting. */
  severity?: CritiqueSeverity | null;
}

/** Top-level scaffold. Composer-driven · only the picked component
 *  fields are filled by Stage 2; the rest are left at their zero values
 *  (empty array, null) so the existing renderer's "skip if empty" rules
 *  drop them cleanly. Methodology footer is appended by the orchestrator
 *  from auto-computed signal/lens/model stats. */
export interface BriefScaffold {
  title: string;
  // ── Anchor (substitute group · pick one) ──
  bottomLine: BottomLine;
  thesis?: Thesis | null;
  workingHypothesis?: WorkingHypothesis | null;
  // ── Reframe (optional) ──
  frameShift: FrameShift;
  // ── Findings (substitute group · pick one) ──
  /** Default · exactly 3 by hard cap, MECE. */
  headlineFindings: HeadlineFinding[];
  /** Alternative · exactly 3 numbered ideas. */
  bigIdeas?: BigIdea[] | null;
  // ── Multi-perspective (optional) ──
  convergence: ConvergencePoint[];
  divergence: Divergence | null;
  positions: PositionCamp[];
  // ── Exhibits (optional · 0-4) ──
  visuals: Visual[];
  /** Optional · 2 named trajectories side by side. */
  twoPaths?: TwoPaths | null;
  // ── Forward (optional) ──
  whyNow?: WhyNow | null;
  // ── Action (substitute group · pick one) ──
  recommendations: Recommendation[];
  theBet?: TheBet | null;
  /** Anthropic-style softer action substitute · same shape as
   *  recommendations but rendered with hedged voice. */
  considerations?: Recommendation[] | null;
  // ── Forward (optional · cont.) ──
  preMortem: FailureMode[];
  newQuestions: NewQuestion[];
  planningAssumption: PlanningAssumption | null;
  // ── Gartner-density blocks (optional, composer-picked) ──
  /** 2-paragraph strategic-outlook section sitting between anchor and
   *  findings. Picked for strategic-decision / market-forecast briefs. */
  strategicOutlook?: StrategicOutlook | null;
  /** 4-6 load-bearing assumptions with confidence + falsifier + horizon. */
  criticalAssumptions?: CriticalAssumption[] | null;
  /** 2-4 scenario branches with probabilities, triggers, effects,
   *  decision implications. Probabilities sum to ~100. */
  scenarioTree?: ScenarioTree | null;
  /** 3-5 leading indicators · signal / threshold / cadence / flipsTo. */
  leadingIndicators?: LeadingIndicator[] | null;
  /** 3-5 threats to validity · how the analysis itself could be wrong.
   *  Stanford-research-grade self-criticism that's distinct from
   *  pre-mortem (how the *action* could fail) and critical-assumptions
   *  (the foundations the brief rests on). Set when the composer picks
   *  the `threats-to-validity` component. */
  threatsToValidity?: ThreatToValidity[] | null;
  /** Dashboard-style KPI / indicator strip · 3-5 number cards that
   *  carry the room's quantitative reads side-by-side. Set when the
   *  composer picks the `metric-strip` component. Distinct from
   *  `visuals` (which holds discrete options-comparison artefacts) —
   *  metric-strip is "by the numbers", visuals is "by the options". */
  metricStrip?: MetricStrip | null;
  // ── Brainstorm-mode components (optional · only set when
  //    `room.mode === "brainstorm"` and the composer picked them).
  //    All decision-grade fields above are left at their zero values
  //    in brainstorm-mode briefs so the writer doesn't render them. ──
  openingHook?: OpeningHook | null;
  opportunityShape?: OpportunityShape | null;
  adjacentAngles?: AdjacentAngle[] | null;
  whatIfThisWorks?: WhatIfThisWorks | null;
  worthChasing?: WorthChasingAngle[] | null;
  deadEndsNoted?: DeadEndNoted[] | null;
  brainstormQuestions?: BrainstormQuestion[] | null;
  // ── Critique-mode components (optional · only set when
  //    `room.mode === "critique"` and the composer picked them).
  //    All decision-grade + brainstorm fields are zero-valued in
  //    critique-mode briefs. ──
  deliverableSummary?: DeliverableSummary | null;
  whatsGood?: WhatsGood[] | null;
  qualityIssues?: QualityIssue[] | null;
  severityRankedFixes?: SeverityRankedFix[] | null;
  residualRisks?: ResidualRisk[] | null;
  // ── Residual ──
  openQuestions: OpenQuestion[];
}

/** Language tag for the report. Determined from the room subject by the
 *  caller (CJK → "zh", else "en"). All three stages must produce output
 *  in this language so the report aligns with how the user phrased the
 *  Initial Question. */
export type ReportLanguage = "zh" | "en";

function languageInstruction(lang: ReportLanguage): string {
  if (lang === "zh") {
    return [
      "## 输出语言要求（重要）",
      "本次会议的 Initial Question 是中文。所有面向用户的输出（包括 JSON 字段中的字符串值、最终报告的 markdown）都必须使用**简体中文**。",
      "JSON 的 key 名（例如 `title`, `findings`, `tldr`, `evidenceRefs`、`lens` 标签如 `data` / `dissent` 等枚举值）保持英文不变；只把 value 中的人类阅读文本翻译为中文。",
    ].join("\n");
  }
  return [
    "## Output language",
    "This room's Initial Question was in English. Produce all human-readable output (string values inside JSON, and the final markdown) in **English**.",
    "JSON keys and enum values (e.g. `data`, `dissent`, `confirmed`, `for`, `P0`) stay as the literal strings shown in the schema.",
  ].join("\n");
}

/* ─────────────────────── Stage 1 · per-director extract ───────────────── */

interface ExtractOpts {
  director: Agent;
  /** Only the messages this director authored. Caller pre-filters. */
  ownMessages: Message[];
  room: Room;
  language: ReportLanguage;
}

const EXTRACT_SYSTEM = (director: Agent) =>
  [
    `You are ${director.name} (${director.handle}), ${director.roleTag}.`,
    `Your job: re-read your own contributions to a boardroom session and surface the 2–4 signals you most want preserved in the final report.`,
    ``,
    `## What counts as a signal`,
    ``,
    `A signal is a single load-bearing observation you made — a claim, a counterexample, a structural insight, a first-principles re-derivation, a story that crystallizes the point. Not a summary of what you said; the *one thing* that should outlive the conversation.`,
    ``,
    `## Lens tags (pick exactly one per signal)`,
    ``,
    `· \`data\`           — empirical data point, number, or named precedent`,
    `· \`dissent\`        — a counterexample or pushback against a default view`,
    `· \`narrative\`      — a story or analogy that makes the point land`,
    `· \`structural\`     — a system / mechanism / second-order argument`,
    `· \`first-principle\` — a derivation from foundational truths`,
    ``,
    `## Output format`,
    ``,
    `Return a single JSON object inside a fenced \`\`\`json code block. No prose outside the block.`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "signals": [`,
    `    { "text": "Short 1–2 sentence statement of the signal in your voice.", "lens": "dissent", "sources": [0, 2] }`,
    `  ]`,
    `}`,
    `\`\`\``,
    ``,
    `\`sources\` is an array of 0-based indices into your message list (provided in the user message). Cite at least one. If you said nothing worth preserving, return \`{"signals": []}\`.`,
    ``,
    `Constraints:`,
    `· 2–4 signals (or zero).`,
    `· Each signal has a different lens tag if possible.`,
    `· "text" is in your own voice, not a third-person paraphrase. Max 50 words.`,
  ].join("\n");

export function buildExtractMessages(opts: ExtractOpts): LLMMessage[] {
  const { director, ownMessages, room, language } = opts;

  const myMessages = ownMessages
    .map((m, i) => `[${i}] ${m.body.trim()}`)
    .join("\n\n");

  return [
    {
      role: "system",
      content: [EXTRACT_SYSTEM(director), "", languageInstruction(language)].join("\n"),
    },
    {
      role: "user",
      content: [
        `ROOM SUBJECT: ${room.subject}`,
        ``,
        `Your messages in this room (indexed):`,
        ``,
        myMessages || "(you said nothing)",
        ``,
        `Extract your signals now. JSON only.`,
      ].join("\n"),
    },
  ];
}

/* ─────────────────────── Stage 2 · chair cluster/scaffold ─────────────── */

interface ScaffoldOpts {
  chair: Agent | null;
  room: Room;
  members: Agent[];
  perDirectorSignals: DirectorSignals[];
  language: ReportLanguage;
  /** Optional supplementary perspective the user asked to be addressed
   *  in this regeneration. Empty string / undefined = no supplement. */
  supplement?: string;
  /** Components the composer picked. When undefined / empty, every
   *  Stage 2 / Stage 3 caller sees the legacy "fill all 12 sections"
   *  behaviour — preserves backwards compat with anything that doesn't
   *  yet route through the composer. */
  picked?: readonly string[];
}

const SCAFFOLD_SYSTEM = [
  "You are the chair of a boardroom session. The directors have each surfaced their own signals (with lens tags). Your job is to produce a structured scaffold for a McKinsey-grade research note — pyramid principle, MECE, with multi-director thinking surfaced as a structural feature.",
  "",
  "## Design philosophy",
  "",
  "A multi-director report's value is **not** a McKinsey report with multiple authors. It is the meta-output the conversation between directors produced — frame shifts, convergent independent reasoning, and questions that did not exist when the room opened. Your scaffold must surface those structurally, not bury them in an appendix.",
  "",
  "## What you must produce — 12 sections",
  "",
  "1. **Title** · 8–14 words. The title IS a complete-sentence thesis (e.g. \"AI dynamic comics will not kill manga but will compress it into a 'clean version' refuge\"), not a topic.",
  "",
  "2. **Bottom Line** · one-sentence judgement + confidence (high/medium/low) + a one-sentence rationale on why the confidence is what it is (and why not higher).",
  "",
  "3. **Frame Shift** · the most distinctive multi-director output. Compare the question as opened vs the question now. If the room **redefined** the question, set `shifted: true` and describe the trigger. If the **frame held**, set `shifted: false` and use the section to restate the question with the room's deeper understanding. Never skip this.",
  "",
  "4. **Headline Findings** · **exactly 3** (hard cap — pyramid principle, MECE). Each is a complete-sentence claim, not a topic. Each has:",
  "   · `confidence`: high/medium/low",
  "   · `supporters`: director ids who advanced this",
  "   · `challengers`: director ids who pushed back (empty array if full alignment — explicitly empty)",
  "   · `supporting`: 2–3 sub-findings with their own evidence refs",
  "   · `lensesPresent`: ≥ 2 distinct lens tags spanning the supporting sub-findings",
  "   · optional `tension`: unresolved disagreement on this finding",
  "",
  "5. **Convergence** · points where directors arrived at the same conclusion via INDEPENDENT reasoning paths. \"Independent\" = signals with distinct lens tags. Each ConvergencePoint has ≥ 2 paths via ≥ 2 distinct lenses. If only one director made each point, do NOT list it — convergence requires ≥ 2 directors. Empty array is fine if no real convergence happened.",
  "",
  "6. **Divergence** · the SINGLE central tension in the room. One sentence statement, then a per-director row with stance / confidence / cost-of-being-wrong / note. Plus 1–3 `resolutionRequirements` — what would we need to know to settle this? Set divergence to null only if there was genuinely no central tension (rare).",
  "",
  "7. **Positions** · 2–3 named camps. Short evocative label (\"The Skeptics\", \"The Long-Horizon Camp\"), one-sentence collective claim, director ids, supporting signal refs. A director appears in only one camp.",
  "",
  "8. **Visuals** · 0–4 blocks. Content-driven. Pick from:",
  "   · `comparison-table`  — ≥ 2 named options compared on shared dimensions (text matrix)",
  "   · `quadrant-chart`    — items plotted on two real axes (mermaid quadrantChart)",
  "   · `force-field`       — drivers vs resistors of one outcome (text two-column)",
  "   · `strengths-cautions`— strengths / cautions / verdict per option (text matrix)",
  "   · `bar-chart`         — 2–8 named items ranked by ONE quantitative dimension (mermaid xychart-beta · cost / support / size / time)",
  "   · `timeline`          — 3–8 dated points telling a narrative arc (mermaid timeline · retro / historical analogue / projected sequence)",
  "   · `pie-chart`         — 2–6 slices showing a distribution (mermaid pie · scenario probabilities / lens shares / vote tallies / market mix). Numbers can be percentages OR raw counts — mermaid normalises.",
  "   Strong rule: if the discussion contained ANY ranked numeric measure across items → bar-chart. ANY chronological sequence ≥ 3 events → timeline. ANY distribution that sums (probability split, votes, lens count, market share) → pie-chart. These three are massively higher information density than the equivalent prose.",
  "",
  "9. **Recommendations** · 3–5 concrete actions, each with: `priority` (P0/P1/P2), `action` (imperative), `rationale`, `ownerType`, `horizon` (e.g. \"next 30 days\"), `successMetric` (observable proof of execution), `riskIfSkipped`. Recommendations are imperatives — \"Do X\" not \"X should happen\".",
  "",
  "10. **Pre-mortem** · 2–3 ways the recommendations could fail. Each: `scenario`, `leadingIndicator` (earliest observable warning), `mitigation`. McKinsey-grade risk thinking.",
  "",
  "11. **New Questions** · questions that did NOT exist when the room opened but emerged from the conversation. **This is distinct from openQuestions** (residuals). New questions are the highest-value generative output. 1–4 items, each with `question`, `whyItMatters`, `surfacedByDirectorId`. If genuinely no new questions surfaced, return [].",
  "",
  "12. **Strategic Planning Assumption** · forward-looking probabilistic statement. `statement` is a dated forecast, `probability` is 0–100, `trigger` describes conditions, `falsificationTest` is the observable that would prove it wrong. Set null only if the conversation didn't produce material for one.",
  "",
  "Plus: **openQuestions** (1–3 residual unresolved questions, ≠ NewQuestions) tagged P0/P1.",
  "",
  "## Output format",
  "",
  "Return a single JSON object inside a fenced ```json code block. No prose outside the block.",
  "",
  "```json",
  "{",
  '  "title": "Complete-sentence thesis · 8-14 words",',
  '  "bottomLine": {',
  '    "judgement": "One-sentence load-bearing judgement.",',
  '    "confidence": "medium",',
  '    "rationale": "Why this confidence — what would we need to be more sure?"',
  '  },',
  '  "frameShift": {',
  '    "shifted": true,',
  '    "original": "What the question looked like at the open.",',
  '    "reframed": "What the question looks like now. Empty when shifted=false.",',
  '    "trigger": "Why the reframe (or why the frame held)."',
  '  },',
  '  "headlineFindings": [',
  "    {",
  '      "title": "Complete-sentence thesis · the takeaway, not the topic",',
  '      "claim": "One-sentence load-bearing claim.",',
  '      "confidence": "high",',
  '      "supporters": ["dirId-a", "dirId-b"],',
  '      "challengers": [],',
  '      "supporting": [',
  '        { "text": "Sub-finding sentence with evidence.", "evidenceRefs": ["dirId-a#0", "dirId-b#1"] }',
  '      ],',
  '      "lensesPresent": ["data", "structural"],',
  '      "tension": "(optional)",',
  '      "counterEvidence": "1–2 sentences · the STRONGEST argument the room raised AGAINST this finding. Required for dense briefs; \'\' acceptable when the room had no real pushback.",',
  '      "strategicImplication": "1 sentence · what this finding implies for the decision the room is wrestling with. Closes the gap between fact and judgment."',
  "    }",
  "  ],",
  '  "convergence": [',
  '    {',
  '      "point": "What the room aligned on, in one sentence.",',
  '      "paths": [',
  '        { "directorId": "dirId-a", "lens": "data", "reasoning": "1-sentence path." },',
  '        { "directorId": "dirId-b", "lens": "first-principle", "reasoning": "1-sentence path." }',
  '      ]',
  '    }',
  '  ],',
  '  "divergence": {',
  '    "statement": "The hinge in one sentence.",',
  '    "rows": [',
  '      { "directorId": "dirId-a", "stance": "against", "confidence": "high", "costOfBeingWrong": "≤ 80 chars", "note": "≤ 80 chars" }',
  '    ],',
  '    "resolutionRequirements": ["What we\'d need to know · 1", "...2", "...3"]',
  '  },',
  '  "positions": [',
  '    { "label": "The Skeptics", "claim": "One-sentence collective stance.", "directors": ["dirId-a"], "evidenceRefs": ["dirId-a#0"] }',
  '  ],',
  '  "visuals": [',
  '    { "type": "comparison-table", "title": "...", "rowLabel": "Option", "columns": ["Speed", "Risk", "Cost"], "rows": [ { "name": "Option A", "cells": ["Fast", "High", "Low"] } ] },',
  '    { "type": "quadrant-chart", "title": "...", "xLabel": "Effort", "yLabel": "Impact", "q1": "Quick wins", "q2": "Major projects", "q3": "Fill-ins", "q4": "Thankless tasks", "items": [ { "label": "Idea A", "x": 0.7, "y": 0.8 } ] },',
  '    { "type": "force-field", "title": "...", "drivers": ["..."], "resistors": ["..."] },',
  '    { "type": "strengths-cautions", "title": "...", "rows": [ { "option": "Option A", "strengths": ["..."], "cautions": ["..."], "verdict": "recommended" } ] },',
  '    { "type": "bar-chart", "title": "Estimated time-to-ship", "yLabel": "Months to ship", "unit": "mo", "bars": [ { "label": "Option A", "value": 6 }, { "label": "Option B", "value": 14 } ] },',
  '    { "type": "timeline", "title": "How the platform reached parity", "points": [ { "period": "2019", "label": "First open weights ship", "description": "..." }, { "period": "2022", "label": "...", "description": "" } ] },',
  '    { "type": "pie-chart", "title": "Scenario probability split", "slices": [ { "label": "Base", "value": 55 }, { "label": "Upside", "value": 25 }, { "label": "Downside", "value": 20 } ] }',
  '  ],',
  '  "recommendations": [',
  '    { "priority": "P0", "action": "Imperative concrete action.", "rationale": "Why this works.", "ownerType": "platform team", "horizon": "next 30 days", "successMetric": "Observable proof.", "riskIfSkipped": "What goes wrong.", "criticalDependency": "What MUST be true for this to work — the load-bearing pre-condition. Forces stress-testing." }',
  '  ],',
  '  "preMortem": [',
  '    { "scenario": "How it fails.", "leadingIndicator": "Earliest warning.", "mitigation": "What to do." }',
  '  ],',
  '  "newQuestions": [',
  '    { "question": "Question?", "whyItMatters": "Why this is generative.", "surfacedByDirectorId": "dirId-b" }',
  '  ],',
  '  "planningAssumption": {',
  '    // Strategic Planning Assumption · Gartner-format. The statement MUST follow:',
  '    //   "By [date / horizon], [N]% probability that [event will happen], unless [falsifier]."',
  '    // Probability is the integer 0–100 in the `probability` field, NOT prose. Falsifier is a',
  '    // separately-named observable in the `falsificationTest` field for downstream rendering.',
  '    "statement": "By Q4 2027, 70% probability that X% of platforms will Y, unless Z.",',
  '    "probability": 70,',
  '    "trigger": "Conditions under which this holds.",',
  '    "falsificationTest": "Single observable that would prove it wrong."',
  '  },',
  '  "openQuestions": [',
  '    { "text": "Residual unresolved question?", "priority": "P0" }',
  '  ],',
  "  // ── Gartner-density blocks (composer-picked · null when not picked) ──",
  '  "strategicOutlook": {',
  '    "context": "Operating context · 2–4 sentences (≤ 600 chars). What forces are in motion, who is affected, what is at stake.",',
  '    "implication": "The strategic implication for decision-makers · 2–3 sentences (≤ 500 chars)."',
  '  },',
  '  "criticalAssumptions": [',
  '    { "statement": "The brief\'s logic assumes …", "confidence": "medium", "falsifier": "Observable that would prove this wrong.", "horizon": "next 12 months", "attribution": "Marc · structural lens" }',
  '  ],',
  '  "scenarioTree": {',
  '    "intro": "One-sentence framing for the tree.",',
  '    "branches": [',
  '      { "label": "Base case", "probability": 55, "trigger": "What tips us into this.", "effects": ["Effect 1", "Effect 2"], "decisionImplication": "What this means for the decision." },',
  '      { "label": "Upside", "probability": 25, "trigger": "...", "effects": [], "decisionImplication": "..." },',
  '      { "label": "Downside", "probability": 20, "trigger": "...", "effects": [], "decisionImplication": "..." }',
  '    ]',
  '  },',
  '  "leadingIndicators": [',
  '    { "signal": "What to watch.", "threshold": "Threshold or pattern that flips the read.", "cadence": "weekly", "flipsTo": "Which scenario this confirms or which assumption it falsifies." }',
  '  ],',
  '  "threatsToValidity": [',
  '    { "category": "Selection bias", "threat": "1-2 sentences naming WHAT about the analysis could mislead.", "observable": "What you\'d see if this threat is realized.", "severity": "high", "mitigation": "What would address it (or null)." }',
  '  ],',
  '  "metricStrip": {',
  '    "intro": "Single sentence framing the strip (\'Three numbers worth pricing in\' / \'By the numbers\').",',
  '    "cards": [',
  '      { "label": "≤ 60 chars · what this number measures.", "value": "≤ 24 chars · the number-like reading (\'≤ 8%\', \'18 mo\').", "qualifier": "Optional · ≤ 80 chars context (\'of total ARR\').", "trend": "up | down | flat | null", "attribution": "Optional · which director / lens (≤ 80 chars)." }',
  '    ]',
  '  }',
  "}",
  "```",
  "",
  "## Hard rules (do not violate)",
  "",
  "· **headlineFindings.length === 3** — hard cap. Force MECE. If the room produced more, merge or drop.",
  "· Use the exact director ids supplied in the input — never fabricate.",
  "· Reference signals as `<directorId>#<signalIndex>` exactly as labelled.",
  "· `convergence` requires ≥ 2 directors via ≥ 2 distinct lenses. Otherwise empty array.",
  "· `challengers: []` (explicitly empty) when full alignment — never omit the field.",
  "· `frameShift.shifted` must be honest — only set to true when the question itself was redefined, not just deepened.",
  "· Output JSON only. Do not write the final prose.",
  "",
  "## Substitute groups · component selection (Stage 1.5)",
  "",
  "The user message will list which components have been picked for this room. Three substitute groups exist; each group has one default and one alternative. Fill ONLY the picked field; set the substitute's default to the empty value (the renderer skips empties cleanly).",
  "",
  "Anchor:",
  "  · `bottom-line` (default)  → fill `bottomLine`. Leave `thesis: null`, `workingHypothesis: null`.",
  "  · `thesis`                 → fill `thesis: { claim, reasoning }`. Leave others null.",
  "  · `working-hypothesis`     → fill `workingHypothesis: { hypothesis, reasonsItMayBeWrong[] }`. Leave others null.",
  "",
  "Findings:",
  "  · `headline-findings` (default) → fill `headlineFindings` with 3 pillars. Leave `bigIdeas: null`.",
  "  · `big-ideas`                    → fill `bigIdeas` with EXACTLY 3 numbered ideas. Leave `headlineFindings: []`.",
  "",
  "Action:",
  "  · `recommendations` (default) → fill `recommendations`. Leave `theBet: null`, `considerations: null`.",
  "  · `the-bet`                    → fill `theBet: { ifBacked, conditions[3-5], killCriteria }`. Leave others.",
  "  · `considerations`             → fill `considerations` with the SAME shape as `recommendations` (3-5 items, P0/P1/P2, owner, horizon, success metric, risk-if-skipped). Voice should be hedged in the prose (we'll worry about voice at write time; the data shape is identical).",
  "",
  "Optional kinds (`frame-shift`, `convergence`, `divergence`, `positions`, `visuals`, `two-paths`, `why-now`, `pre-mortem`, `new-questions`, `planning-assumption`, `open-questions`, `strategic-outlook`, `critical-assumptions`, `scenario-tree`, `leading-indicators`, `threats-to-validity`, `metric-strip`): when listed in the picked set, fill them as the spec above describes. When NOT listed, set them to the empty value (`[]` for arrays, `null` for nullable objects, `{shifted:false, original:'', reframed:'', trigger:''}` for frameShift).",
  "",
  "## Substitute schemas (when picked)",
  "",
  "`thesis`:",
  "```json",
  '{ "claim": "Complete-sentence load-bearing thesis · 12-22 words", "reasoning": "1-2 sentences on why this is THE claim." }',
  "```",
  "",
  "`bigIdeas` (exactly 3, numbered 1/2/3 in order):",
  "```json",
  "[",
  '  { "number": 1, "claim": "Punchy claim · 8-14 words", "why": "1-2 sentences.", "evidenceRefs": ["dirId-a#0"] },',
  '  { "number": 2, "claim": "...", "why": "...", "evidenceRefs": [] },',
  '  { "number": 3, "claim": "...", "why": "...", "evidenceRefs": [] }',
  "]",
  "```",
  "",
  "`theBet`:",
  "```json",
  "{",
  '  "ifBacked": "Opening sentence framing the bet — \\"If we were to back this...\\".",',
  '  "conditions": [',
  '    { "condition": "Imperative · what must hold", "why": "Why this condition is load-bearing." }',
  "  ],",
  '  "killCriteria": "The single observable that would tell us to stop."',
  "}",
  "```",
  "",
  "`workingHypothesis`:",
  "```json",
  "{",
  '  "hypothesis": "1-2 sentences in essay voice stating the working position.",',
  '  "reasonsItMayBeWrong": ["≤ 30 words · reason 1", "reason 2", "reason 3"]',
  "}",
  "```",
  "",
  "`whyNow`:",
  "```json",
  "{",
  '  "windowOpened": "What recently opened this window. ≤ 200 chars.",',
  '  "windowCloses": "When and why it closes. ≤ 200 chars.",',
  '  "whatToBetOn": "The bet implied by the window. ≤ 200 chars."',
  "}",
  "```",
  "",
  "`twoPaths`:",
  "```json",
  "{",
  '  "intro": "Optional 1-sentence framing for both paths. Empty string ok.",',
  '  "pathA": { "label": "Short label · ≤ 32 chars", "body": "1 paragraph trajectory. ≤ 500 chars." },',
  '  "pathB": { "label": "Short label · ≤ 32 chars", "body": "1 paragraph trajectory. ≤ 500 chars." }',
  "}",
  "```",
  "",
  "`considerations`: same JSON shape as `recommendations` (array of items with priority / action / rationale / ownerType / horizon / successMetric / riskIfSkipped).",
  "",
  "`strategicOutlook`:",
  "```json",
  "{",
  '  "context": "Paragraph 1 · 2–4 sentences naming forces in motion, stakeholders affected, what is at stake. ≤ 600 chars. Set up the operating environment so the findings have weight.",',
  '  "implication": "Paragraph 2 · 2–3 sentences flowing from the context to what this changes for decision-makers. ≤ 500 chars."',
  "}",
  "```",
  "",
  "`criticalAssumptions` (4–6 items · the load-bearing assumptions the brief\'s logic rests on):",
  "```json",
  "[",
  '  {',
  '    "statement": "The brief\'s logic assumes that … (complete sentence, ≤ 200 chars).",',
  '    "confidence": "high | medium | low",',
  '    "falsifier": "The single observable / event that would prove this assumption wrong (≤ 200 chars).",',
  '    "horizon": "Time window the assumption must hold (≤ 80 chars · e.g. \\"next 12 months\\", \\"Q2 2026\\", \\"the duration of the conflict\\")",',
  '    "attribution": "Director name · lens (≤ 80 chars · e.g. \\"Long Horizon · structural\\")"',
  "  }",
  "]",
  "```",
  "Surfacing assumptions is the discipline lever — these are the foundations the reader gets to stress-test.",
  "",
  "`scenarioTree` (2–4 named futures with quantitative anchoring):",
  "```json",
  "{",
  '  "intro": "One-sentence framing.",',
  '  "branches": [',
  '    {',
  '      "label": "≤ 40 chars · descriptive (e.g. \\"Protracted stalemate\\", not \\"Scenario 1\\")",',
  '      "probability": 55,    // 0–100 integer · all branches sum to ~100',
  '      "trigger": "What would tip the room into this branch (≤ 200 chars).",',
  '      "effects": ["2–3 dominant effects under this branch."],',
  '      "decisionImplication": "What this branch implies for the decision at hand (≤ 240 chars)."',
  '    }',
  "  ]",
  "}",
  "```",
  "Sum of `probability` across branches must be 95–105 (drift to 100 ± 5 allowed).",
  "",
  "`threatsToValidity` (3–5 ways the *analysis itself* could be wrong · Stanford-grade self-criticism):",
  "```json",
  "[",
  '  {',
  '    "category": "≤ 50 chars · concrete category name (e.g. \\"Selection bias\\", \\"Generalizability ceiling\\", \\"Construct validity\\", \\"Confounding factor\\", \\"Sample of N=1\\", \\"Lens blind spot\\", \\"Survivorship\\", \\"Anchoring on the loudest director\\"). Pick a NAMED category — not a free-form essay.",',
  '    "threat": "1-2 sentences (≤ 280 chars) naming WHAT about the *analysis itself* could mislead. Distinct from pre-mortem (how the recommended action could fail) and from critical-assumptions (the assumptions the brief rests on).",',
  '    "observable": "What you would see if this threat is realized (≤ 200 chars). Without an observable, a threat is just a hedge — it must be falsifiable.",',
  '    "severity": "low | medium | high",',
  '    "mitigation": "What would address or defuse this threat (≤ 200 chars). Set null when the room had no concrete mitigation."',
  "  }",
  "]",
  "```",
  "Threats name limits of the analysis, not limits of the conclusion. \"The recommendation might fail if X\" is pre-mortem material; \"our analysis only consulted Western strategy directors so the conclusion may not generalize\" is a threat to validity. Pick at most 5; below 3 reads as token effort, above 5 turns into noise.",
  "",
  "`metricStrip` (3–5 dashboard-style KPI cards · the room's quantitative reads side-by-side):",
  "```json",
  "{",
  '  "intro": "Single sentence framing the strip · ≤ 200 chars (e.g. \\"Three numbers worth pricing in\\", \\"By the numbers\\"). Empty string is fine when the section heading already does the framing.",',
  '  "cards": [',
  '    {',
  '      "label": "≤ 60 chars · what this number measures (e.g. \\"API revenue at risk\\", \\"Window before parity\\", \\"Convergence rate among directors\\"). Concrete, scannable.",',
  '      "value": "≤ 24 chars · the number-like reading. Strings, not numbers — preserves ranges (\\"≤ 8%\\", \\"18–24 mo\\"), inequalities (\\"> 100×\\"), and CJK units (\\"≈ 三个季度\\"). The eye-catch.",',
  '      "qualifier": "Optional · ≤ 80 chars context (\\"of total ARR\\", \\"if no leak\\", \\"in the base case\\"). Set null when the value stands alone.",',
  '      "trend": "up | down | flat | null · directional read. Null when the value is a level, not a direction.",',
  '      "attribution": "Optional · which director / lens generated the number (\\"First Principles · data\\"). ≤ 80 chars. Null acceptable but PREFER providing one — it makes the multi-director sourcing visible the way Headline Findings does."',
  "    }",
  "  ]",
  "}",
  "```",
  "Pick metric-strip whenever the room produced ≥ 3 quantitative claims worth surfacing as a row of cards (percentages, time windows, ratios, counts, ranges). Each card holds ONE number — never bury two numbers in one value. Distinct from `leadingIndicators` (which is a forward-looking watch-list with thresholds + cadence) — metric-strip carries the room's READS as numbers right now.",
  "",
  "`leadingIndicators` (3–5 monitoring signals):",
  "```json",
  "[",
  '  {',
  '    "signal": "What to watch (≤ 80 chars · e.g. \\"Brent crude vs $90\\", \\"Korean trade balance month-on-month\\").",',
  '    "threshold": "Threshold or pattern that flips the interpretation (≤ 200 chars).",',
  '    "cadence": "How often to check (≤ 60 chars · e.g. \\"daily\\", \\"every CPI release\\", \\"per Fed minutes\\").",',
  '    "flipsTo": "What hitting this threshold confirms — which scenario it points to or which assumption it falsifies (≤ 240 chars)."',
  "  }",
  "]",
  "```",
].join("\n");

/** Component-selection block · used by the orchestrator after Stage 1.5
 *  to tell Stage 2 / Stage 3 which components the composer picked. When
 *  the picked array is empty (e.g. a legacy code path that never went
 *  through the composer), this returns "" and the prompts behave as if
 *  every component was picked — preserves the v1 12-section behaviour. */
function pickedBlock(picked: readonly string[] | undefined): string {
  if (!picked || picked.length === 0) return "";
  const allKnown = new Set([
    "bottom-line", "thesis", "working-hypothesis",
    "frame-shift",
    "headline-findings", "big-ideas",
    "convergence", "divergence", "positions",
    "visuals", "two-paths", "why-now",
    "recommendations", "the-bet", "considerations",
    "pre-mortem", "new-questions", "planning-assumption",
    "open-questions",
    // Gartner-density blocks
    "strategic-outlook", "critical-assumptions", "scenario-tree", "leading-indicators",
    // Stanford-research self-criticism block
    "threats-to-validity",
    // Dashboard-style indicator strip
    "metric-strip",
    // Brainstorm-mode components · used only when room.mode === "brainstorm".
    // Discipline at the composer level prevents these from mixing with the
    // decision-grade pool above; listing them here so picked-block routing
    // is uniform for the scaffold prompt regardless of mode.
    "opening-hook",
    "opportunity-shape",
    "adjacent-angles",
    "what-if-this-works",
    "worth-chasing",
    "dead-ends-noted",
    "brainstorm-questions",
    // Critique-mode components · used only when room.mode === "critique".
    "deliverable-summary",
    "whats-good",
    "quality-issues",
    "severity-ranked-fixes",
    "residual-risks",
  ]);
  const set = new Set(picked.filter((k) => allKnown.has(k)));
  if (!set.size) return "";
  const skipped: string[] = [];
  for (const k of allKnown) if (!set.has(k)) skipped.push(k);
  return [
    ``,
    `─── COMPOSER PICKED COMPONENTS ───`,
    ``,
    `The composer (Stage 1.5) picked these components for this brief — fill ONLY these fields:`,
    ...[...set].sort().map((k) => `  · ${k}`),
    ``,
    `Skip these components (set their fields to empty/null per the substitute-group rules in the system prompt):`,
    ...skipped.sort().map((k) => `  · ${k}`),
    ``,
    `─── END PICKED ───`,
  ].join("\n");
}

/* ─────────────────── Stage 2 · brainstorm scaffold prompt ─────────────────
 *
 * Used when `room.mode === "brainstorm"`. A complete replacement for
 * SCAFFOLD_SYSTEM — not an addendum. The brainstorm scaffold's whole
 * job is the OPPOSITE of the decision-grade scaffold: enumerate angles,
 * surface possibilities, refuse to pick a winner.
 *
 * Hard rules in the prompt:
 *   · NEVER fill `bottomLine` / `thesis` / `recommendations` / `theBet` /
 *     `criticalAssumptions` / `headlineFindings` / `bigIdeas`. Leave them
 *     null / empty array. The brainstorm-only fields below replace them.
 *   · Verbs are exploratory: "could / might / what if / opens up". Banned
 *     verbs in any brainstorm scaffold field: "must / will / should / is".
 *   · Three is the magic number — exactly 3 consequences, 3-5 angles,
 *     3-5 worth-chasing handles, 5-8 brainstorm questions.
 *   · The brief should leave the user with MORE angles to chase, not
 *     one to act on.
 * ──────────────────────────────────────────────────────────────────── */
const BRAINSTORM_SCAFFOLD_SYSTEM = [
  "You are the chair of a boardroom session run in BRAINSTORM mode. The user explicitly chose `mode: brainstorm` for this room — they want the conversation to OPEN UP the topic, not narrow it to a decision.",
  "",
  "Produce a JSON scaffold for a brainstorm-shaped brief. The brief that gets written from this scaffold MUST read as exploration, not as a thesis or a decision memo.",
  "",
  "## Hard rules · violations are rejected",
  "",
  "1. **Never fill decision-grade fields.** Leave these at their zero values:",
  "   - `bottomLine` → set `judgement` to empty string `\"\"`, `confidence` to `\"low\"`, `rationale` to `\"\"`. The renderer will skip the section.",
  "   - `thesis` / `workingHypothesis` / `headlineFindings` (`[]`) / `bigIdeas` (`null`) / `recommendations` (`[]`) / `theBet` (`null`) / `considerations` (`null`) / `criticalAssumptions` (`null`) / `scenarioTree` (`null`) / `leadingIndicators` (`null`) / `preMortem` (`[]`) / `planningAssumption` (`null`) / `whyNow` (`null`) / `positions` (`[]`) / `twoPaths` (`null`) / `strategicOutlook` (`null`) / `threatsToValidity` (`null`).",
  "",
  "2. **Fill brainstorm-only fields** when the composer picked them. Possible kinds:",
  "   - `opening-hook` → `openingHook` · 1–2 sentence \"what changes if this is real\" lead-in. NOT a judgement.",
  "   - `opportunity-shape` → `opportunityShape` · 3 dimensions: scope (who/where), gravity (why it pulls attention), tempo (time texture). Optional `sizingHint` is an analogue, NOT a forecast number.",
  "   - `adjacent-angles` → `adjacentAngles` · 3–5 distinct angles. Each gets `name` (1–4 word handle), `framing` (the lens), `whatOpens` (what becomes interesting). NOT ranked. NOT \"the best one\".",
  "   - `what-if-this-works` → `whatIfThisWorks` · 1-sentence `setup` + EXACTLY 3 short `consequences`. Phrased as \"could open up\" / \"might unlock\", NEVER as predictions.",
  "   - `worth-chasing` → `worthChasing` · 3–5 angles the room generated heat around. Each gets `handle`, `whyItPulled`, `nextTestableQuestion`. The next-question is OPEN-ENDED — not a milestone, not a kill criterion, not an OKR.",
  "   - `dead-ends-noted` → `deadEndsNoted` · 0–3 angles the room dropped. `angle` + `whyDropped`. Naming these signals the conversation actually ranged.",
  "   - `brainstorm-questions` → `brainstormQuestions` · 5–8 generative questions. `question` + optional `whatWouldShift`. NOT a P0/P1 todo list.",
  "",
  "3. **Fill mode-neutral fields** when the composer picked them. These give the brief visual + analytical rhythm; their voice in a brainstorm brief stays exploratory (descriptive, never claim-front):",
  "   - `frame-shift` → `frameShift` · `{ shifted: bool, original, reframed, trigger }`. Describe how the question moved during the room (or held). Past-tense observational voice. NOT \"the room concluded X\" — \"the room kept asking Y after Z surfaced\".",
  "   - `convergence` → `convergence` · array of points where ≥2 directors arrived at the same observation via different lenses. Each `{ point, directors[], lenses[] }`. Descriptive, NOT a thesis.",
  "   - `divergence` → `divergence` · single hinge `{ summary, rows[], crux }` where directors split. Surface the tension; do NOT resolve it (this is brainstorm — the split stays open).",
  "   - `visuals` → `visuals` · 0–4 mermaid charts. Pick visual subtypes that fit BRAINSTORM material: `timeline` (chronology of waves), `pie` (distribution of attention / where the energy went), `comparison-table` (angle vs angle), `bar-chart` (ranked numeric reads), `quadrant-chart` (2-axis plot of angles). Use the existing schema (caption, chart-specific fields).",
  "   - `metric-strip` → `metricStrip` · `{ intro, cards[] }` with 3–5 KPI cards (label, value, qualifier, trend, attribution). For numeric reads the room surfaced (analogue numbers / sizing / time windows / ratios). Brainstorms often hint at quantities (\"X grew 5×\", \"by 2027\") — they belong here.",
  "   - `new-questions` → `newQuestions` · list of `{ question, attribution, lens, why }`. Questions that emerged DURING the room. Different from `brainstormQuestions` which are residual generative; pick at most ONE of the two.",
  "   - `open-questions` → `openQuestions` · residual P0/P1 list. Tactical asks only.",
  "",
  "4. **Voice rules.**",
  "   - Verbs allowed: `could`, `might`, `would open up`, `seems to`, `looks like`, `if X, then Y might`, `what if`.",
  "   - Verbs FORBIDDEN: `must`, `will`, `should`, `the bet is`, `the moat is`, `必须`, `应该`, `护城河`, `要做的是`, `the answer is`, `we recommend`.",
  "   - First-person framing is fine (`the room found` / `a few of us pulled toward` / `房间里反复回到`).",
  "   - Do NOT name a winner. If two angles seem strongest, surface both as `worth-chasing` entries — the user picks.",
  "",
  "5. **Title.** The `title` field MUST be exploratory — an open-ended question (\"What changes if 50 humans + 5000 agents is real?\") OR a \"shape of the space\" framing (\"Five doors into [topic]\" / \"如果 X 成立的几种打开方式\"). Never a thesis-style claim. Never a moat / underwriting / commitment framing.",
  "",
  "## JSON shape",
  "",
  "Strict JSON inside a fenced ```json code block. No prose outside the block. Field shapes:",
  "",
  "```json",
  "{",
  '  "title": "Open-ended question or \"shape of the space\" framing.",',
  '  "openingHook": { "hook": "1–2 sentence what-if lead-in.", "restatement": "≤30-char pull-quote OR null" },',
  '  "opportunityShape": {',
  '    "scope": "Who / where the topic reaches if it plays out.",',
  '    "gravity": "Why it pulls attention worth this conversation.",',
  '    "tempo": "Time texture · window opening / decade-long shift.",',
  '    "sizingHint": "Analogue from another industry / prior wave OR null"',
  "  },",
  '  "adjacentAngles": [',
  '    { "name": "1–4 words", "framing": "the lens this angle takes", "whatOpens": "1–2 sentences on what becomes interesting" }',
  "  ],",
  '  "whatIfThisWorks": {',
  '    "setup": "If this plays out as described, …",',
  '    "consequences": ["consequence 1", "consequence 2", "consequence 3"]',
  "  },",
  '  "worthChasing": [',
  '    { "handle": "1–4 word handle", "whyItPulled": "why the room kept returning", "nextTestableQuestion": "open question to advance understanding" }',
  "  ],",
  '  "deadEndsNoted": [',
  '    { "angle": "the angle", "whyDropped": "why the room turned back" }',
  "  ],",
  '  "brainstormQuestions": [',
  '    { "question": "the question", "whatWouldShift": "what answering this unlocks OR null" }',
  "  ],",
  "  // Mode-neutral fields · FILL when the composer picked them",
  "  // (frame-shift / convergence / divergence / visuals / metric-strip /",
  "  // new-questions / open-questions). Use the regular schema for each",
  "  // (same as constructive briefs · only the voice changes — descriptive",
  "  // and exploratory, never claim-front). Examples below show the shape;",
  "  // OMIT each block when not picked (or use the zero value).",
  '  "frameShift":         { "shifted": true, "original": "...", "reframed": "...", "trigger": "..." },',
  '  "convergence":        [{ "point": "...", "directors": [], "lenses": [] }],',
  '  "divergence":         { "summary": "...", "rows": [], "crux": "..." },',
  '  "visuals":            [],   // 0–4 mermaid charts · use existing visual schema',
  '  "metricStrip":        { "intro": "...", "cards": [] },',
  '  "newQuestions":       [],',
  '  "openQuestions":      [],',
  "  // ALWAYS leave these decision-grade fields at their zero values:",
  '  "bottomLine":         { "judgement": "", "confidence": "low", "rationale": "" },',
  '  "headlineFindings":   [],',
  '  "positions":          [],',
  '  "recommendations":    [],',
  '  "preMortem":          [],',
  '  "planningAssumption": null',
  "}",
  "```",
  "",
  "Skipped components in the COMPOSER PICKED COMPONENTS block stay at their zero values per the rule above. Filled components get rich content per the field shapes.",
].join("\n");

/* ───────────────────── Stage 2 · critique scaffold prompt ─────────────────
 *
 * Used when `room.mode === "critique"`. A complete replacement for
 * SCAFFOLD_SYSTEM. Critique is AUDIT-shaped: severity-ranked, "what's
 * good first", procedural. The opposite shape from brainstorm
 * (exploratory) and from constructive (decision-grade).
 *
 * Hard rules in the prompt:
 *   · NEVER fill `bottomLine` / `thesis` / `recommendations` /
 *     `criticalAssumptions` / `headlineFindings` / `bigIdeas` / brain-
 *     storm fields. Leave them at their zero values.
 *   · `whatsGood` MUST be filled with 2–4 entries when picked. Skipping
 *     it makes the audit read as a hatchet job and tanks credibility.
 *   · Issues and fixes are EXPLICITLY severity-ranked — every entry
 *     carries a `severity` tag from {high, medium, low}.
 *   · Voice: inspector / standards-officer. Sharper than constructive,
 *     more procedural than debate. NEVER prescriptive about strategy
 *     ("you should pivot the product") — only about the deliverable.
 * ──────────────────────────────────────────────────────────────────── */
const CRITIQUE_SCAFFOLD_SYSTEM = [
  "You are the chair of a boardroom session run in CRITIQUE mode. The user explicitly chose `mode: critique` for this room — they want a deliverable AUDIT, not a strategic memo.",
  "",
  "Produce a JSON scaffold for a critique-shaped brief. The brief that gets written from this scaffold MUST read as an audit: framed → what's good → what's broken (severity-ranked) → fixes (severity-ranked) → residual risks. No thesis. No strategy recommendations. No exploration.",
  "",
  "## Hard rules · violations are rejected",
  "",
  "1. **Never fill decision-grade or brainstorm fields.** Leave these at their zero values:",
  "   - `bottomLine` → set `judgement: \"\"`, `confidence: \"low\"`, `rationale: \"\"`. The renderer will skip the section.",
  "   - `thesis` / `workingHypothesis` / `headlineFindings` (`[]`) / `bigIdeas` (`null`) / `recommendations` (`[]`) / `theBet` (`null`) / `considerations` (`null`) / `criticalAssumptions` (`null`) / `scenarioTree` (`null`) / `leadingIndicators` (`null`) / `preMortem` (`[]`) / `planningAssumption` (`null`) / `whyNow` (`null`) / `frameShift` → use `{ shifted: false, original: \"\", reframed: \"\", trigger: \"\" }`.",
  "   - All brainstorm fields (`openingHook` / `opportunityShape` / `adjacentAngles` / `whatIfThisWorks` / `worthChasing` / `deadEndsNoted` / `brainstormQuestions`) → null / [].",
  "",
  "2. **Fill critique-only fields.** The composer's pick list tells you exactly which to fill. Possible kinds (the composer picks 4–7 of these per brief):",
  "   - `deliverable-summary` → `deliverableSummary` · `subject` (what's under review) + `context` (1-sentence framing) + optional `charter` (audit scope).",
  "   - `whats-good` → `whatsGood` · 2–4 entries, each `point` (the strength) + optional `attribution` (director or lens). REQUIRED — must come BEFORE issues.",
  "   - `quality-issues` → `qualityIssues` · 3–7 issues, each `title` + `severity` (high/medium/low) + `issue` (the symptom) + `impact` (why it matters) + optional `attribution`. Diagnosis only — fixes belong in the next section.",
  "   - `severity-ranked-fixes` → `severityRankedFixes` · 3–7 fixes, each `title` (do-action phrasing) + `severity` (matches the issues addressed) + `fix` (concrete change) + `effort` (1 word or 1-line note) + optional `owner`. Prescription scoped to the deliverable.",
  "   - `residual-risks` → `residualRisks` · 0–4 entries, each `risk` + `whyResidual` (why it can't close inside this audit) + optional `severity`.",
  "   - `openQuestions` → `openQuestions` · standard P0/P1 residual TODO list — questions for the deliverable's owner.",
  "",
  "3. **Severity discipline.**",
  "   - `severity` MUST be one of `\"high\"`, `\"medium\"`, `\"low\"`. No other strings, no prose.",
  "   - High = blocks shipping / correctness defect / data loss / contract break.",
  "   - Medium = degrades quality but ships viably / can be fixed in next iteration.",
  "   - Low = polish / nit / forward-looking.",
  "   - Issues and fixes should mostly pair · for every high-severity issue there's typically a high-severity fix. The renderer will surface mismatches.",
  "",
  "4. **Voice.** Inspector / standards-officer register. Sharp, procedural, evidence-anchored. NOT debate-style adversarial — this is review, not opposition. Verbs: `surfaces`, `breaks`, `omits`, `under-specifies`, `narrows`. Avoid `must` / `should` outside fixes; in fixes, `do X` / `add Y` is fine because that's the prescription. NEVER prescriptive about strategy beyond the deliverable.",
  "",
  "5. **Title.** The `title` field MUST name the deliverable + the audit's headline finding. Examples: \"Onboarding spec audit · 3 high-severity gaps in error states\" / \"v2 pricing matrix · sound on tiering, weak on enterprise carve-outs\". NOT a thesis. NOT exploratory.",
  "",
  "## JSON shape",
  "",
  "Strict JSON inside a fenced ```json code block. No prose outside the block. Field shapes:",
  "",
  "```json",
  "{",
  '  "title": "Deliverable name · headline finding.",',
  '  "deliverableSummary": {',
  '    "subject": "What\'s under review (≤120 chars).",',
  '    "context": "1-sentence framing of shape + scope.",',
  '    "charter": "1-line audit charter OR null"',
  "  },",
  '  "whatsGood": [',
  '    { "point": "1-sentence note on what works", "attribution": "director name OR lens OR null" }',
  "  ],",
  '  "qualityIssues": [',
  '    { "title": "≤60 chars", "severity": "high|medium|low", "issue": "1-2 sentences · the symptom", "impact": "1-2 sentences · why it matters", "attribution": "director name OR lens OR null" }',
  "  ],",
  '  "severityRankedFixes": [',
  '    { "title": "Do-action phrasing (≤60 chars)", "severity": "high|medium|low", "fix": "1-2 sentences · concrete change", "effort": "trivial|small|medium|large OR \\"~half a day\\"", "owner": "role/team OR null" }',
  "  ],",
  '  "residualRisks": [',
  '    { "risk": "the risk", "whyResidual": "why it can\'t close inside this audit", "severity": "high|medium|low OR null" }',
  "  ],",
  '  "openQuestions": [',
  '    { "question": "question for the deliverable owner", "priority": "P0|P1" }',
  "  ],",
  "  // Below this line: leave at zero values · the writer skips them.",
  '  "bottomLine":         { "judgement": "", "confidence": "low", "rationale": "" },',
  '  "frameShift":         { "shifted": false, "original": "", "reframed": "", "trigger": "" },',
  '  "headlineFindings":   [],',
  '  "convergence":        [],',
  '  "divergence":         null,',
  '  "positions":          [],',
  '  "visuals":            [],',
  '  "recommendations":    [],',
  '  "preMortem":          [],',
  '  "newQuestions":       [],',
  '  "planningAssumption": null',
  "}",
  "```",
  "",
  "Skipped components in the COMPOSER PICKED COMPONENTS block stay at their zero values per the rule above.",
].join("\n");

export function buildScaffoldMessages(opts: ScaffoldOpts): LLMMessage[] {
  const { room, members, perDirectorSignals, language, picked } = opts;

  const memberList = members
    .map((a) => `${a.id} · ${a.name} (${a.handle}) — ${a.roleTag}`)
    .join("\n  · ");

  const signalsBlock = perDirectorSignals
    .map((d) => {
      if (!d.signals.length) return `[${d.directorId}] ${d.directorName} — (no signals)`;
      const lines = d.signals
        .map(
          (s, i) =>
            `  · ${d.directorId}#${i} [${s.lens}] ${s.text}`,
        )
        .join("\n");
      return `[${d.directorId}] ${d.directorName}\n${lines}`;
    })
    .join("\n\n");

  const supplementBlock = opts.supplement && opts.supplement.trim()
    ? [
        ``,
        `─── SUPPLEMENTARY PERSPECTIVE FROM USER ───`,
        ``,
        `The user has asked you to additionally consider this angle when building the scaffold. Address it explicitly — work it into the scaffold's findings, divergence, recommendations, and/or new questions wherever it lands most cleanly. Do NOT add a separate section for it; weave it through.`,
        ``,
        opts.supplement.trim(),
        ``,
        `─── END SUPPLEMENT ───`,
      ].join("\n")
    : "";

  // Mode-axis dispatch · brainstorm and critique rooms each get a
  // completely different scaffold system prompt. Brainstorm produces
  // an exploration-shaped JSON (no thesis / no recommendations);
  // critique produces an audit-shaped JSON (severity-ranked issues +
  // fixes, "what's good" first). Constructive / debate / research
  // fall through to SCAFFOLD_SYSTEM.
  const scaffoldSystem = room.mode === "brainstorm"
    ? BRAINSTORM_SCAFFOLD_SYSTEM
    : room.mode === "critique"
      ? CRITIQUE_SCAFFOLD_SYSTEM
      : SCAFFOLD_SYSTEM;

  return [
    {
      role: "system",
      content: [scaffoldSystem, "", languageInstruction(language)].join("\n"),
    },
    {
      role: "user",
      content: [
        `ROOM #${room.number} · ${room.name}`,
        `Subject: ${room.subject}`,
        `Mode: ${room.mode}`,
        ``,
        `Directors:`,
        `  · ${memberList}`,
        ``,
        `─── SIGNALS ───`,
        ``,
        signalsBlock || "(no signals extracted)",
        ``,
        `─── END SIGNALS ───`,
        pickedBlock(picked),
        supplementBlock,
        ``,
        `Produce the scaffold now. JSON only.`,
      ].join("\n"),
    },
  ];
}

/* ─────────────────────── Stage 3 · chair final write ──────────────────── */

interface WriteOpts {
  room: Room;
  members: Agent[];
  scaffold: BriefScaffold;
  perDirectorSignals: DirectorSignals[];
  language: ReportLanguage;
  /** Optional supplementary perspective. The chair must visibly address
   *  this in the final write — not as a separate section, but woven
   *  through the relevant existing sections. */
  supplement?: string;
  /** Components the composer picked. When undefined / empty, every
   *  section is fair game — preserves legacy "render whatever's filled"
   *  behaviour. */
  picked?: readonly string[];
  /** Composer-picked house-style preset slug. Drives section vocabulary
   *  + voice register at write time. Defaults to `boardroom-default`
   *  (no overrides). */
  houseStyle?: string;
  /** Stable seed for the house-style variant picker · typically the
   *  briefId. Same seed + same kind always selects the same variant,
   *  so regeneration of a brief renders identically; different briefs
   *  in the same house style land on different variants for high-
   *  rotation kinds (anchor / findings / action / pre-mortem / etc.).
   *  Optional — omitted callers pin to variant 0 of every entry. */
  briefId?: string;
  /** Mode-contract retry addendum · injected verbatim into the writer
   *  system prompt when the previous Stage-3 attempt produced a brief
   *  that violated the room's mode contract (decision-defense language
   *  in a brainstorm brief, missing severity tags in a critique brief,
   *  etc.). Built by `buildContractRetryAddendum` from the violation
   *  list returned by `validateBriefBody`. Empty / undefined on the
   *  first attempt. */
  retryAddendum?: string;
}

const WRITE_SYSTEM = [
  "You are the chair of a boardroom session. You have a structured scaffold. Write the final report in markdown — a McKinsey-grade research note that makes the multi-director thinking visible. Pyramid principle, MECE, action-oriented.",
  "",
  "## Required structure (in order — never reorder)",
  "",
  "Start with a single H2 title from `scaffold.title` verbatim.",
  "",
  "  ## Bottom Line",
  "  One short paragraph (1–3 sentences). Lead with the scaffold's `bottomLine.judgement` rephrased for impact, italicized. Then state the confidence inline using this exact format: `**Confidence: {high/medium/low}** — {rationale}`.",
  "  This section is ALWAYS rendered. It is the report's visual anchor.",
  "",
  "  ## Frame Shift",
  "  This is the most distinctive multi-director output. ALWAYS rendered. Two cases:",
  "    · If `frameShift.shifted: true` — write 2–3 sentences using this pattern: \"The room opened with {original}. By {trigger description}, the question shifted to {reframed}.\"",
  "    · If `frameShift.shifted: false` — write \"The frame held: the room sharpened {original} rather than redefining it. {trigger as 1-sentence rationale}.\"",
  "",
  "  ## Headline Findings",
  "  Exactly 3 findings. For each one, render as:",
  "    ### {finding.title}",
  "    Open with the claim italicized in one line: *\"{claim}\"*",
  "    Then a `**Confidence: {high/medium/low}** · supported by {supporters as names} · challenged by {challengers as names, or \"none — full alignment\"}` line.",
  "    Then 2–3 prose paragraphs (NOT bullets — paragraphs) building the case. Each paragraph anchored on one sub-finding from `supporting`. Make evidence diversity visible: a finding tagged `[data, structural]` must visibly use both a data point AND a structural argument. Cite directors by name when their phrasing IS the point.",
  "    If `tension` is present, surface it explicitly with an em-dash aside or a dedicated final paragraph beginning *— However,*",
  "    If `counterEvidence` is non-empty, render it as a dedicated final paragraph beginning **— Counter-argument:** followed by the prose. Makes the room's adversarial review visible.",
  "    If `strategicImplication` is non-empty, render it as the closing italic line:",
  "      *Strategic implication: {strategicImplication}*",
  "    These two fields turn each finding from a fact into a stress-tested judgment — REQUIRED on dense briefs.",
  "",
  "  ## Where We Converged",
  "  Skip this section entirely if `convergence` is empty.",
  "  Otherwise: one short intro paragraph (1–2 sentences) explaining that despite different starting positions, certain conclusions held.",
  "  Then for each convergence point:",
  "    > **{point}**",
  "    > • {director name} via *{lens}*: {reasoning}",
  "    > • {another director name} via *{lens}*: {reasoning}",
  "    > • (etc.)",
  "    Render this as a blockquote, with bullets of the independent paths.",
  "",
  "  ## Where We Diverged",
  "  Skip this section entirely if `divergence` is null.",
  "  Otherwise:",
  "    Open with one short paragraph (2–3 sentences) stating `divergence.statement` and why it matters.",
  "    Then a markdown table with columns `Director | Stance | Confidence | Cost of Being Wrong | Note`. One row per `divergence.rows` entry. Render stance with markers: `for` → **For** · `against` → **Against** · `nuanced` → **Nuanced**.",
  "    Then a final subsection:",
  "      **What would resolve this:**",
  "      A bulleted list of `divergence.resolutionRequirements`.",
  "",
  "  ## Positions",
  "  Skip if `positions` is empty. Otherwise one subsection per camp:",
  "    ### {camp.label}",
  "    Open with **bold restatement of `claim`**. Then 2–3 sentences of explanation drawing on the camp's evidence refs. End the subsection with a blockquote pulling the most evocative phrase from one of the camp's directors:",
  "    > *\"…\"* — {director name}",
  "    Use the director's actual words from their signal text — pick the one that best lands the point. Trim to ≤ 40 words. **Each camp gets exactly one pull-quote.**",
  "",
  "  ## Options Analysis",
  "  Skip if `visuals` is empty. Otherwise, for each visual render as below. Use the visual's `title` as the H3 heading.",
  "",
  "    For `comparison-table`:",
  "      ### {title}",
  "      A markdown table with `{rowLabel}` as the first column header and `columns` as the rest. One row per `rows` entry.",
  "",
  "    For `quadrant-chart`:",
  "      ### {title}",
  "      Render a fenced ```mermaid block with `quadrantChart`. EXACT shape — mermaid 10.9.5 is strict:",
  "      ```",
  "      quadrantChart",
  "          title {title}",
  "          x-axis \"Low {xLabel}\" --> \"High {xLabel}\"",
  "          y-axis \"Low {yLabel}\" --> \"High {yLabel}\"",
  "          quadrant-1 \"{q1}\"",
  "          quadrant-2 \"{q2}\"",
  "          quadrant-3 \"{q3}\"",
  "          quadrant-4 \"{q4}\"",
  "          \"{item.label}\": [{item.x}, {item.y}]",
  "      ```",
  "      Hard rules to avoid mermaid syntax errors (the lexer fails on non-ASCII in unquoted labels):",
  "        · BOTH x-axis AND y-axis lines MUST be `... \"Low X\" --> \"High X\"` form — both ends in DOUBLE QUOTES.",
  "        · Quadrant labels MUST be in DOUBLE QUOTES (`quadrant-1 \"短语\"`) — never bare text. The lexer rejects unquoted CJK / parens / `+`.",
  "        · Each item line is `\"Label\": [x, y]` with the label in DOUBLE QUOTES. Inside the label: no `:` no `\"` no `[` no `]`. Replace with ` - ` if needed.",
  "        · Use HALFWIDTH parens `()` not fullwidth `（）` anywhere inside the diagram.",
  "        · Numeric coords are decimals strictly inside `(0, 1)` — round to 2 decimals. Never use 0 or 1 exactly.",
  "        · Title is one line, plain text — no quotes, no colons. Title is the only label that is NOT quoted.",
  "        · One item per indented line. No blank lines inside the fenced block.",
  "",
  "    For `force-field`:",
  "      ### {title}",
  "      A 2-column markdown table with headers `Drivers ↑` and `Resistors ↓`. Each driver/resistor on its own row. Pad shorter side with empty cells.",
  "",
  "    For `strengths-cautions`:",
  "      ### {title}",
  "      A markdown table with columns `Option | Strengths | Cautions | Verdict`. Each row's Strengths/Cautions cells are bullet-separated (· between items). Verdict markers: `recommended` → **Recommended** · `caution` → ⚠ **Caution required** · `not-recommended` → **Not recommended**.",
  "",
  "    For `bar-chart`:",
  "      ### {title}",
  "      Render a fenced ```mermaid block with `xychart-beta` (mermaid 10+ stable). Strict shape so the lexer doesn't reject:",
  "      ```",
  "      xychart-beta",
  "          title \"{title}\"",
  "          x-axis [\"{bar.label}\", \"{bar.label}\", ...]",
  "          y-axis \"{yLabel}\"",
  "          bar [{bar.value}, {bar.value}, ...]",
  "      ```",
  "      Hard rules:",
  "        · `x-axis` is a literal JSON-style array of DOUBLE-QUOTED labels, comma-separated. No bare strings. CJK is fine inside the quotes.",
  "        · Inside any quoted label: NO double-quote, NO `:`, NO `[`, NO `]`. Replace with ` - ` if needed.",
  "        · `bar` values are bare numbers, in the same order as x-axis labels. Match counts (lexer fails on mismatch).",
  "        · `title` is double-quoted. ASCII parens only — replace fullwidth `（）` with halfwidth `()`.",
  "        · 2–8 bars. Below 2 isn't a comparison; above 8 stops being scannable.",
  "        · NO blank lines inside the fenced block. Indent body lines 4 spaces.",
  "",
  "    For `timeline`:",
  "      ### {title}",
  "      Render a fenced ```mermaid block with `timeline`. Strict shape:",
  "      ```",
  "      timeline",
  "          title {title}",
  "          {period} : {label} : {description}",
  "      ```",
  "      Hard rules:",
  "        · `title` is plain text on its own line — NO quotes (mermaid timeline syntax differs from xychart). One line. ASCII parens only. NO `:` inside the title.",
  "        · One point per line: `{period} : {label} : {description}` — colons are the field separators, so labels / descriptions cannot contain `:`. Replace with ` — ` if needed.",
  "        · Period (e.g. \"2019\", \"Q3 2024\", \"Today\") is the column header rendered above the dot.",
  "        · Description is optional · when scaffold.description is empty, use the 2-segment form: `{period} : {label}` (no trailing colon, no empty third segment — mermaid 11.0+ rejects empty fields).",
  "        · 3–8 points. Below 3 reads as a stub; above 8 the strip overflows.",
  "        · NO blank lines inside the fenced block. Indent body lines 4 spaces.",
  "",
  "    For `pie-chart`:",
  "      ### {title}",
  "      Render a fenced ```mermaid block with `pie showData` so each slice's number is printed in the legend:",
  "      ```",
  "      pie showData",
  "          title {title}",
  "          \"{slice.label}\" : {slice.value}",
  "          \"{slice.label}\" : {slice.value}",
  "      ```",
  "      Hard rules:",
  "        · `title` is plain text — NO quotes. ASCII parens only. NO `:` inside the title.",
  "        · Each slice is `\"{label}\" : {number}` — label DOUBLE-QUOTED, value bare number. The literal colon between them is required.",
  "        · Labels: NO `\"`, NO `:`, NO `[`, NO `]` inside. Replace with ` - ` if needed.",
  "        · Values can be percentages summing to ~100 OR raw counts — mermaid normalises. Keep 2 decimals max.",
  "        · 2–6 slices. Pies with > 6 slices stop being readable.",
  "        · NO blank lines inside the fenced block. Indent body lines 4 spaces.",
  "",
  "  ## Recommendations",
  "  Skip if `recommendations` is empty. Otherwise render as a numbered list, one per recommendation, sorted by priority. Each item:",
  "    1. **`P0`** **{action}**",
  "       _Rationale:_ {rationale}",
  "       _Owner:_ {ownerType} · _Horizon:_ {horizon}",
  "       _Success metric:_ {successMetric}",
  "       _Critical dependency:_ {criticalDependency}",
  "       _Risk if skipped:_ {riskIfSkipped}",
  "    Use **`P0`** / **`P1`** / **`P2`** as priority badges (literal backticked text, bolded). Each numbered item gets one blank line before the next.",
  "    The _Critical dependency_ line is the load-bearing pre-condition — what MUST be true for this action to actually work. Render it whenever `criticalDependency` is non-empty; skip the line only on legacy scaffolds where the field is absent.",
  "",
  "  ## Pre-mortem",
  "  Skip if `preMortem` is empty. Otherwise a markdown table with columns `Failure mode | Leading indicator | Mitigation`. One row per failure mode.",
  "",
  "  ## New Questions This Surfaced",
  "  Skip if `newQuestions` is empty. Otherwise:",
  "    Open with one sentence framing this as the conversation's generative output: \"The conversation surfaced {N} questions that weren't on the table when the room opened — these are where to point the next session.\"",
  "    Then a numbered list. Each item:",
  "    1. **{question}**",
  "       _Why it matters:_ {whyItMatters}",
  "       _Surfaced by:_ {director name}",
  "",
  "  ## Strategic Planning Assumption",
  "  Skip if `planningAssumption` is null. Otherwise render in Gartner SPA format:",
  "    > **Strategic Planning Assumption · {probability}% probability**",
  "    > {statement}    (← MUST follow the SPA format: \"By [date / horizon], [N]% probability that [event will happen], unless [falsifier].\")",
  "    > ",
  "    > _Triggered when:_ {trigger}",
  "    > _Falsified by:_ {falsificationTest}",
  "  The statement field already encodes the date + probability + falsifier inline; the explicit `_Falsified by_` line surfaces the falsifier as a separate observable for monitoring. Do NOT relax the SPA format into prose — the structure is what makes the assumption stress-testable.",
  "",
  "  ## Open Questions",
  "  Skip if `openQuestions` is empty. Otherwise a bulleted list. Each bullet: priority badge `**\\`P0\\`**` or `\\`P1\\`` followed by the question text.",
  "",
  "## Substitute components (composer-driven · render only when filled)",
  "",
  "  ### thesis (anchor alternative)",
  "  When `scaffold.thesis` is non-null AND `scaffold.bottomLine.judgement` is empty, render in place of `## Bottom Line`:",
  "    ## The Thesis",
  "    *\"{thesis.claim}\"*",
  "",
  "    {thesis.reasoning · 1-2 sentences in prose, not italicized.}",
  "  Skip both this section AND `## Bottom Line` only if both fields are empty (should not happen — composer always picks an anchor).",
  "",
  "  ### bigIdeas (findings alternative)",
  "  When `scaffold.bigIdeas` is a 3-element array AND `scaffold.headlineFindings` is empty, render in place of `## Headline Findings`:",
  "    ## Three Big Ideas",
  "    Open with one sentence framing the trio.",
  "    Then a numbered list (3 items, in order):",
  "      1. **{idea.claim}**",
  "         {idea.why · 1-2 sentences citing director names where evidenceRefs land cleanly.}",
  "      2. **...**",
  "      3. **...**",
  "  Numbers come from the field — render `1.` `2.` `3.` literally.",
  "",
  "  ### theBet (action alternative)",
  "  When `scaffold.theBet` is non-null AND `scaffold.recommendations` is empty, render in place of `## Recommendations`:",
  "    ## The Bet",
  "    Open with `{theBet.ifBacked}` as a single italicized line: *{ifBacked}*",
  "    Then a numbered list of conditions:",
  "      1. **{condition.condition}**",
  "         {condition.why · 1-2 sentences.}",
  "    Close with a callout line:",
  "      > **Kill criteria:** {killCriteria}",
  "",
  "  ### workingHypothesis (anchor alternative · Anthropic-essay spine)",
  "  When `scaffold.workingHypothesis` is non-null and the other anchors are empty, render in place of `## Bottom Line`:",
  "    ## A working hypothesis",
  "    {workingHypothesis.hypothesis · written as essay prose, NOT italicized. 1-2 sentences.}",
  "",
  "    **Reasons it may be wrong:**",
  "      · {reason 1}",
  "      · {reason 2}",
  "      · {reason 3}",
  "  Voice register here is genuinely tentative — \"may be wrong\", \"if X, then\", \"we are uncertain about\". Do NOT collapse this into a confident judgement; the section's value is the hedge.",
  "",
  "  ### whyNow (forward / opportunity panel)",
  "  When `scaffold.whyNow` is non-null AND was picked, render after the anchor (or after frameShift if present):",
  "    ## Why Now",
  "    A short 3-paragraph block, one paragraph per field:",
  "      Paragraph 1 (the open): {windowOpened}",
  "      Paragraph 2 (the close): {windowCloses}",
  "      Paragraph 3 (the bet): {whatToBetOn}",
  "  Each paragraph is 2-3 sentences in plain prose. Do NOT add bullets. Do NOT label the paragraphs with the field names — the prose tells the reader which is which.",
  "",
  "  ### strategicOutlook (Gartner-density · sits between anchor and findings)",
  "  When `scaffold.strategicOutlook` is non-null AND was picked, render it AFTER the anchor (Bottom Line / Thesis / Working Hypothesis) and BEFORE the findings:",
  "    ## Strategic Outlook",
  "    Two prose paragraphs:",
  "      Paragraph 1: {strategicOutlook.context}",
  "      Paragraph 2: {strategicOutlook.implication}",
  "  Plain prose, no bullets, no labels on the paragraphs. The first paragraph sets the stage; the second flows the implication for decision-makers. Reads like a Gartner / Bain research-note opener.",
  "",
  "  ### criticalAssumptions (Gartner-density · the load-bearing assumptions log)",
  "  When `scaffold.criticalAssumptions` is non-empty AND was picked, render it AFTER the findings and BEFORE recommendations:",
  "    ## Critical Assumptions",
  "    Open with one sentence framing why surfacing assumptions matters: \"The brief's logic rests on the following — each assumption is named explicitly so it can be stress-tested.\"",
  "    Then a numbered list. Each item:",
  "      1. **{statement}**",
  "         _Confidence:_ {confidence} · _Horizon:_ {horizon} · _Attribution:_ {attribution}",
  "         _Falsified by:_ {falsifier}",
  "    The `_Falsified by_` line is what makes this Gartner-grade — every assumption has a single observable that would prove it wrong. Render even when confidence is high; high-confidence assumptions still need their falsifier named.",
  "",
  "  ### scenarioTree (Gartner-density · 2–4 named futures with probabilities)",
  "  When `scaffold.scenarioTree` is non-null AND was picked, render it AFTER critical assumptions:",
  "    ## Scenario Tree",
  "    {scenarioTree.intro · 1 sentence framing the tree.}",
  "    Then ONE subsection per branch (### header), in descending probability order:",
  "      ### {label} · {probability}%",
  "      _Trigger:_ {trigger}",
  "",
  "      _Effects:_",
  "      · {effect 1}",
  "      · {effect 2}",
  "      · {effect 3}",
  "",
  "      _What this means for the decision:_ {decisionImplication}",
  "    Probabilities visible in the heading make the scenario weights legible at a glance. Effects render as a tight bulleted list (2–3 per branch). Decision implication closes each branch by linking it to action.",
  "",
  "  ### leadingIndicators (Gartner-density · monitoring discipline)",
  "  When `scaffold.leadingIndicators` is non-empty AND was picked, render it AFTER the scenario tree (or after recommendations if there's no scenario tree):",
  "    ## Leading Indicators",
  "    Open with one sentence framing the watch-list: \"These are the signals to monitor — each has a threshold that flips the read of which scenario is materializing.\"",
  "    Then a markdown table with columns `Signal | Threshold | Cadence | Flips to`:",
  "      | Signal | Threshold | Cadence | Flips to |",
  "      | --- | --- | --- | --- |",
  "      | {signal} | {threshold} | {cadence} | {flipsTo} |",
  "    Each row is one indicator. Keep cell content tight — the value is in seeing all 3-5 indicators side-by-side as a watch-list, not in prose elaboration.",
  "",
  "  ### threatsToValidity (Stanford-style · how the analysis itself could be wrong)",
  "  When `scaffold.threatsToValidity` is non-empty AND was picked, render it AFTER critical-assumptions (or AFTER findings when no critical-assumptions). This section is the room's intellectual honesty made structural — not an appendix caveat.",
  "    ## Threats to Validity",
  "    Open with one sentence framing the section: \"The analysis below could be wrong in named ways. These are the threats — each is concrete, observable, and (where possible) mitigable.\"",
  "    Then a markdown table with columns `Category | Threat | Observable | Severity | Mitigation`. One row per item, sorted by severity (high → medium → low). Render severity as **`High`** / **`Medium`** / **`Low`** (literal backticked, bolded). The `Mitigation` cell is the literal string `—` when scaffold.mitigation is null.",
  "      | Category | Threat | Observable | Severity | Mitigation |",
  "      | --- | --- | --- | --- | --- |",
  "      | {category} | {threat} | {observable} | **`Severity`** | {mitigation or —} |",
  "    Don't pad the section with prose — the table IS the section. The voice register from the picked house style applies, but the table structure stays identical across styles. Threats here name the limits of the *analysis*, not the limits of the *recommendation* (that's pre-mortem).",
  "",
  "  ### metricStrip (dashboard · the room's numbers as a row of KPI cards)",
  "  When `scaffold.metricStrip` is non-null AND was picked, render it as the report's first quantitative beat — natural slot is RIGHT AFTER the anchor (Bottom Line / Thesis / Working Hypothesis), so a reader skimming the top of the report sees the headline judgement followed immediately by the numbers behind it. Acceptable alternative slot: right before Recommendations, when the numbers frame the action rather than the judgement.",
  "    Heading from the house style (default `## By the Numbers`).",
  "    Then emit a fenced code block with language tag `metric-strip` whose body is STRICT JSON. The report renderer detects this block and emits the styled card grid (mirrors how ```mermaid is handled today). Format:",
  "    ```metric-strip",
  "    {",
  '      "intro": "Three numbers worth pricing in",',
  '      "cards": [',
  '        { "label": "API revenue at risk", "value": "≤ 8%", "qualifier": "of total ARR", "attribution": "First Principles · data" },',
  '        { "label": "Window before parity", "value": "18 mo", "trend": "down", "qualifier": "unless training data leaks" },',
  '        { "label": "Convergence rate", "value": "2 of 3", "qualifier": "directors at high confidence" }',
  "      ]",
  "    }",
  "    ```",
  "    Hard rules:",
  "      · The block opens with the literal three backticks + `metric-strip` and closes with three backticks on a line by itself. Just like mermaid blocks.",
  "      · Body is one JSON object with `intro` (string, may be empty) and `cards` (array of 3–5 objects).",
  "      · Each card object: `label` (required string), `value` (required string), `qualifier` (optional string · omit key OR set null when empty), `trend` (optional · one of `\"up\"` / `\"down\"` / `\"flat\"` · omit key when null), `attribution` (optional string).",
  "      · Mirror the scaffold.metricStrip values 1:1. Don't invent extra cards; don't drop cards the scaffold supplied.",
  "      · Don't pad the section with surrounding prose. The cards carry the section.",
  "",
  "  ### twoPaths (multi-perspective / comparison alternative)",
  "  When `scaffold.twoPaths` is non-null AND was picked, render in place of (or alongside) `## Options Analysis`:",
  "    ## Two Paths",
  "    {intro · 1 sentence framing both paths. Skip if intro is empty.}",
  "",
  "    A 2-column markdown table with these exact headers:",
  "      | Path A · {pathA.label} | Path B · {pathB.label} |",
  "      | --- | --- |",
  "      | {pathA.body} | {pathB.body} |",
  "  Body cells are 1 paragraph each. Do NOT include line breaks inside table cells.",
  "",
  "  ### considerations (action alternative · softer voice)",
  "  When `scaffold.considerations` is non-empty AND `scaffold.recommendations` is empty, render in place of `## Recommendations`:",
  "    ## Considerations",
  "    A numbered list with the same shape as Recommendations BUT in hedged voice:",
  "      1. **{consideration as bold lead-in, ≤ 12 words}**",
  "         _Worth thinking about because:_ {rationale}",
  "         _Who'd own it:_ {ownerType} · _On what horizon:_ {horizon}",
  "         _What you'd watch:_ {successMetric}",
  "         _What you'd give up by not doing this:_ {riskIfSkipped}",
  "  No P0/P1/P2 priority badges in this voice — the priority is implicit in the order. Use \"might\", \"could\", \"worth considering\" instead of \"do\" / \"build\" / \"ship\". The data is the same as recommendations; the words around it are softer.",
  "",
  "## Voice rules",
  "",
  "· Plain prose. No flattery. No \"the room concluded that…\" hedging.",
  "· Use *italics* for load-bearing words and direct quotes.",
  "· Use **bold** for claims and section markers.",
  "· No \"I\" or \"we\" as the writer. The brief is the room speaking.",
  "· No preamble, no closing remarks, no \"in summary\". Just the brief.",
  "· Markdown only — fenced ```mermaid blocks are part of markdown for our renderer.",
  "· Replace all director ids (like `dirId-a`) with display names. Never let a raw id leak into prose.",
  "· Numbers everywhere — even qualitative claims get bracketed by numbers when possible (\"about 2/3 of the directors\", \"in the next 18 months\", \"~30% confidence\").",
  "· Section headings ARE the takeaway — never use topic-style headings (e.g. \"Market analysis\"). Always claim-style (e.g. \"China growth will slow to <5%\").",
].join("\n");

/** Render a single signal reference as a one-liner with lens + director + text. */
function renderSignalRef(
  ref: string,
  perDirectorSignals: DirectorSignals[],
): string {
  const [dirId, idxStr] = ref.split("#");
  const idx = Number(idxStr);
  for (const d of perDirectorSignals) {
    if (d.directorId === dirId && Number.isFinite(idx) && d.signals[idx]) {
      return `[${d.signals[idx].lens}] ${d.directorName}: ${d.signals[idx].text}`;
    }
  }
  return `[${ref}] (missing)`;
}

/** Default Stage-3 markdown heading per component kind · what
 *  WRITE_SYSTEM has been instructing the LLM to use. The house-style
 *  addendum overrides specific entries here without touching the rest
 *  of the prompt. Keeping this table small (only the kinds whose
 *  default heading is naturally rewriteable) keeps the addendum
 *  unambiguous — if a kind isn't here, the addendum doesn't try to
 *  rename it. */
const DEFAULT_KIND_LABELS: Partial<Record<ComponentKind, string>> = {
  "bottom-line":           "Bottom Line",
  "thesis":                "The Thesis",
  "working-hypothesis":    "A working hypothesis",
  "frame-shift":           "Frame Shift",
  "strategic-outlook":     "Strategic Outlook",
  "headline-findings":     "Headline Findings",
  "big-ideas":             "Three Big Ideas",
  "critical-assumptions":  "Critical Assumptions",
  "convergence":           "Where We Converged",
  "divergence":            "Where We Diverged",
  "positions":             "Positions",
  "visuals":               "Options Analysis",
  "two-paths":             "Two Paths",
  "why-now":               "Why Now",
  "recommendations":       "Recommendations",
  "the-bet":               "The Bet",
  "considerations":        "Considerations",
  "scenario-tree":         "Scenario Tree",
  "leading-indicators":    "Leading Indicators",
  "threats-to-validity":   "Threats to Validity",
  "metric-strip":          "By the Numbers",
  "pre-mortem":            "Pre-mortem",
  "new-questions":         "New Questions This Surfaced",
  "planning-assumption":   "Strategic Planning Assumption",
  "open-questions":        "Open Questions",
  // Brainstorm-mode component default headings · used only when
  // `room.mode === "brainstorm"` and the composer picked them. House
  // styles can override these per the standard label-table mechanism.
  "opening-hook":          "What If This Is Real",
  "opportunity-shape":     "The Shape of the Room",
  "adjacent-angles":       "Doors Worth Opening",
  "what-if-this-works":    "If This Plays Out",
  "worth-chasing":         "Threads Worth Pulling",
  "dead-ends-noted":       "Roads We Walked Back From",
  "brainstorm-questions":  "Questions Worth Sitting With",
  // Critique-mode component default headings · used only when
  // `room.mode === "critique"`.
  "deliverable-summary":   "Under Review",
  "whats-good":            "What's Already Working",
  "quality-issues":        "Issues Found",
  "severity-ranked-fixes": "Fixes, Ranked",
  "residual-risks":        "Residual Risks",
};

/** Build the house-style addendum to WRITE_SYSTEM · two blocks:
 *
 *    1. Voice register · short paragraph telling the LLM how to write.
 *    2. Section-label overrides · per-kind heading replacements. Only
 *       lists kinds the picked house style overrides; kinds not listed
 *       keep their default headings from WRITE_SYSTEM. When a label
 *       entry has multiple variants, `seed` (typically the brief id)
 *       deterministically selects one — same seed + kind always picks
 *       the same variant, so regeneration is stable while different
 *       briefs in the same house style get different titles.
 *
 *  Returns an empty string for `boardroom-default` (no overrides) so
 *  legacy behaviour passes through cleanly. */
function buildHouseStyleAddendum(
  styleId: string | undefined,
  language: ReportLanguage,
  seed: string | number | undefined,
): string {
  const style = resolveHouseStyle(styleId);
  if (style.id === "boardroom-default") return "";

  const overrideLines: string[] = [];
  for (const kind of Object.keys(DEFAULT_KIND_LABELS) as ComponentKind[]) {
    const override = houseStyleLabel(style, kind, language, seed);
    if (!override) continue;
    const def = DEFAULT_KIND_LABELS[kind];
    if (!def) continue;
    if (override.trim() === def.trim()) continue;
    overrideLines.push(`  · component=\`${kind}\` · default \`## ${def}\` → use \`## ${override}\``);
  }

  const voice = language === "zh" ? style.voice.zh : style.voice.en;

  const lines: string[] = [
    "",
    "## House style — applies to THIS brief",
    "",
    `Picked: \`${style.id}\` · ${style.label}`,
    "",
    "### Voice register",
    "",
    voice,
    "",
  ];

  if (overrideLines.length > 0) {
    lines.push(
      "### Section-heading overrides",
      "",
      "When you render the section for one of the component kinds below, use the H2 on the right INSTEAD of the default heading specified earlier in this prompt. The section's body rules (structure, fields, formatting) stay identical — only the heading text changes. Components not listed here keep their default headings. Do NOT add or drop sections based on this list — it's purely a rename.",
      "",
      ...overrideLines,
      "",
    );
  }

  lines.push(
    "### Override on heading style",
    "",
    "The default rule \"section headings ARE the takeaway, claim-style only\" is RELAXED for house-styled briefs. Use the override label verbatim — house-style headings are deliberately editorial (e.g. \"The Pillars\", \"Why Now\", \"Limitations\") rather than claim-style. The claim-style discipline still applies to H3 sub-headings inside the section.",
  );

  return lines.join("\n");
}

/* ─────────────── Stage 3 · brainstorm writer system prompt ───────────────
 *
 * Used when `room.mode === "brainstorm"`. A complete replacement for
 * WRITE_SYSTEM. The brainstorm writer's job is the OPPOSITE of the
 * decision-grade writer:
 *
 *   · NEVER produce thesis / bottom-line / recommendations sections
 *     even if the scaffold somehow contains those fields. The composer
 *     pool prevents this upstream, but defending the contract here too
 *     means a malformed scaffold can't leak decision-grade prose into
 *     a brainstorm brief.
 *   · Verbs are exploratory throughout: "could / might / would open up /
 *     opens up / makes possible". Banned: "must / will / should / 必须 /
 *     应该 / the bet is / the moat is / 护城河".
 *   · Title is exploratory · open-ended question OR "shape of the
 *     space" framing. Never claim-front.
 *
 * Each brainstorm component has its own narrow render template below.
 * The writer renders ONLY the components in the COMPOSER PICKED
 * COMPONENTS block — skipped components are silent. ──────────────── */
const BRAINSTORM_WRITE_SYSTEM = [
  "You are the chair of a boardroom session run in BRAINSTORM mode. The user explicitly chose `mode: brainstorm` — they want a brief that OPENS UP the topic, not one that narrows it to a decision. Write the final report in markdown.",
  "",
  "## Hard contract · this brief is NOT a decision document",
  "",
  "  · Verbs allowed: `could`, `might`, `would open up`, `makes possible`, `seems to`, `looks like`, `if X, then Y might`, `what if`. In Chinese: `可能`, `也许`, `会打开`, `若 X 成立`, `值得想想`.",
  "  · Verbs FORBIDDEN: `must`, `will`, `should`, `the bet is`, `the moat is`, `we recommend`, `the answer is`, `we conclude`. In Chinese: `必须`, `应该`, `护城河`, `要做的是`, `结论是`, `下注的是`.",
  "  · Heading style: open-ended questions or noun-phrase frames (\"Doors worth opening\", \"Three threads pulling on us\"). NEVER claim-front (\"The thesis is X\", \"The moat is Y\"). The user explicitly did not ask for thesis/decision output.",
  "  · Do NOT pick a winner. If two angles seem strongest, render both as `worth-chasing` entries — let the reader decide.",
  "",
  "## Required structure",
  "",
  "Start with a single H2 title from `scaffold.title` verbatim. The title is already exploratory — do not rewrite it.",
  "",
  "Render the picked components in the order below — skip any not in the picked list. The order interleaves brainstorm-specific sections with mode-neutral ones (frame-shift / metric-strip / visuals / convergence / divergence) so the brief reads with visual rhythm rather than as a flat block of brainstorm prose.",
  "",
  "  ## What If This Is Real    ← `opening-hook`",
  "  Render `openingHook.hook` as 1–2 prose sentences. If `openingHook.restatement` is set, render it on its own line above the hook as italicized pull-quote: `*\"{restatement}\"*`. NO judgement, NO confidence line, NO commitment.",
  "",
  "  ## The Shape of the Room    ← `opportunity-shape`",
  "  Render `opportunityShape` as exactly three short paragraphs (1–3 sentences each), in order: scope, gravity, tempo. NO heading per paragraph — the prose flows. If `sizingHint` is set, append it as a closing italic line: `*Worth comparing to: {sizingHint}*`.",
  "",
  "  ## How the Question Moved    ← `frame-shift`",
  "  Two cases:",
  "    · `frameShift.shifted: true` — \"The room opened with {original}. By {trigger}, the question shifted to {reframed}.\" Past-tense, descriptive.",
  "    · `frameShift.shifted: false` — \"The frame held: the room sharpened {original} rather than redefining it. {trigger as 1-sentence rationale}.\"",
  "",
  "  ## By the Numbers    ← `metric-strip`",
  "  Render the metric-strip as a `<div class=\"metric-strip\" data-cards=\"N\">` block of 3–5 metric-card divs. Each card: `<div class=\"metric-card\" data-trend=\"{trend or omit}\"><div class=\"metric-label\">{label}</div><div class=\"metric-value\">{value}</div><div class=\"metric-qualifier\">{qualifier or omit}</div><div class=\"metric-attribution\">{attribution or omit}</div></div>`. The HTML inside `<div class=\"metric-strip\">` is the ONLY embedded HTML allowed — every other section is markdown.",
  "",
  "  ## Doors Worth Opening    ← `adjacent-angles`",
  "  Render each angle in `adjacentAngles` as an H3 sub-section:",
  "    ### {angle.name}",
  "    *{angle.framing}*",
  "    {angle.whatOpens}",
  "  3–5 angles total. Do NOT rank. Do NOT pick a favourite. The list IS the point.",
  "",
  "  ## Sketches from the Room    ← `visuals` (skip if empty)",
  "  Render each `Visual` per its subtype using the existing schema:",
  "    · `comparison-table` → markdown table",
  "    · `quadrant-chart` → fenced ```mermaid block (xychart-beta with quadrants)",
  "    · `force-field` → fenced ```mermaid block",
  "    · `strengths-cautions` → 2-column markdown table",
  "    · `bar-chart` → fenced ```mermaid block (xychart-beta bar)",
  "    · `timeline` → fenced ```mermaid block (timeline)",
  "    · `pie-chart` → fenced ```mermaid block (pie showData)",
  "  Use captions where the schema provides them. Do NOT inject visuals beyond what `visuals[]` carries.",
  "",
  "  ## If This Plays Out    ← `what-if-this-works`",
  "  Open with `whatIfThisWorks.setup` italicized: `*{setup}*`. Then bullet the 3 consequences:",
  "    - {consequence 1}",
  "    - {consequence 2}",
  "    - {consequence 3}",
  "  Each bullet is 1 sentence, exploratory verbs only.",
  "",
  "  ## Where the Room Aligned    ← `convergence` (skip if empty)",
  "  One short intro paragraph (1 sentence) framing that despite different starting positions, certain observations held. Then for each convergence point, render as a blockquote:",
  "    > **{point}**",
  "  Optional `{directors[]}` and `{lenses[]}` may be appended in italics underneath each blockquote. NO claim-style framing — describe what the room noticed, don't conclude.",
  "",
  "  ## Where the Room Split    ← `divergence` (skip if empty)",
  "  Surface the tension. Open with `divergence.summary` (1–2 sentences). Then `divergence.crux` italicized: `*The crux: {crux}*`. Optional `divergence.rows[]` rendered as a markdown table when populated. Do NOT resolve the split — this is brainstorm; the split stays open.",
  "",
  "  ## Threads Worth Pulling    ← `worth-chasing`",
  "  Render each `worthChasing` entry as an H3 sub-section:",
  "    ### {entry.handle}",
  "    {entry.whyItPulled}",
  "    > {entry.nextTestableQuestion}",
  "  The blockquote on the question is deliberate — it makes the open-question shape visible. NO P0/P1 priority tags. NO milestones. NO kill criteria.",
  "",
  "  ## Roads We Walked Back From    ← `dead-ends-noted` (skip if empty)",
  "  Render each entry as a single bullet: `- **{angle}** — {whyDropped}`. Plain language; no judgement of why it was wrong, just what made the room turn back.",
  "",
  "  ## New Questions This Surfaced    ← `new-questions` (skip if empty)",
  "  Render each `newQuestions` entry as a single bullet with the question bolded; if `attribution` / `lens` / `why` are set, append them on a continuation line in italics. These are questions that emerged DURING the room — distinct from `brainstorm-questions` (residual generative).",
  "",
  "  ## Questions Worth Sitting With    ← `brainstorm-questions`",
  "  Render each entry as a numbered item:",
  "    1. **{question}**",
  "       *{whatWouldShift}*  ← only when set; skip the second line otherwise.",
  "  5–8 entries total. These are the questions the room OPENS UP — not a residual TODO list.",
  "",
  "  ## Open Questions    ← `open-questions` (skip if empty)",
  "  Standard residual P0/P1 list. One bullet per question, prefixed with priority: `- **[P0]** {question}` (or P1).",
  "",
  "## Methodology footer",
  "",
  "The orchestrator appends a deterministic `## Methodology` section after your output. Do NOT write one yourself.",
  "",
  "## Voice register · brainstorm-default",
  "",
  "Warm, curious, exploratory. First-person plural is welcome (\"the room kept returning\", \"we found ourselves pulled toward\", \"房间反复回到\"). Reference specific moments from the conversation when they're load-bearing. NO forecasting numbers, NO TAM/SAM math, NO competitive moats. The scaffold's voice register may be overridden by a house-style addendum below — when present, follow that override on top of these defaults.",
].join("\n");

/* ─────────────── Stage 3 · critique writer system prompt ───────────────
 *
 * Used when `room.mode === "critique"`. A complete replacement for
 * WRITE_SYSTEM. Audit-shaped, severity-ranked, "what's good first."
 *
 * Hard rules:
 *   · NEVER produce thesis / bottom-line / recommendations / strategic
 *     sections. Even if the scaffold has those fields filled, skip them.
 *   · ALWAYS render `whats-good` BEFORE `quality-issues`. Audit
 *     decorum — surfacing strengths first calibrates the reviewer's
 *     signal-to-noise.
 *   · Severity tags are visible in the rendered prose. Each issue and
 *     each fix opens with `**Severity: high/medium/low** ·` so the
 *     reader can scan the audit by severity at a glance.
 *   · Title is the deliverable name + headline finding. Never
 *     thesis-front, never exploratory.
 * ──────────────────────────────────────────────────────────────────── */
const CRITIQUE_WRITE_SYSTEM = [
  "You are the chair of a boardroom session run in CRITIQUE mode. The user explicitly chose `mode: critique` — they want a deliverable AUDIT, not a strategic memo. Write the final report in markdown.",
  "",
  "## Hard contract · this brief is an audit",
  "",
  "  · NEVER write thesis / bottom-line / recommendations / strategic-implication sections. Even if the scaffold has those fields filled, skip them — only the critique-mode sections render.",
  "  · Voice: inspector / standards-officer. Sharp, procedural, evidence-anchored. Verbs: `surfaces`, `breaks`, `omits`, `under-specifies`, `narrows`, `mis-handles`. Avoid `must` / `should` outside fixes.",
  "  · ALWAYS render `whats-good` BEFORE `quality-issues`. Audit decorum.",
  "  · Severity tags are visible in the prose. Issues open with `**Severity: high** · {title}` (or medium / low). Fixes do the same.",
  "  · Heading style: noun-phrase or audit-style framings (\"Issues found\", \"Fixes, ranked\", \"Residual risks\"). Not claim-front, not exploratory.",
  "",
  "## Required structure",
  "",
  "Start with a single H2 title from `scaffold.title` verbatim. The scaffold's title is already audit-shaped — do not rewrite it.",
  "",
  "Render the picked components in this order (skip any not in the picked list):",
  "",
  "  ## Under Review    ← `deliverable-summary`",
  "  Open with `deliverableSummary.subject` italicized as the lead-in: `*{subject}*`. Then 1–2 sentences of `context`. If `charter` is set, render it as a closing italic line: `*Audit charter: {charter}*`.",
  "",
  "  ## What's Already Working    ← `whats-good`",
  "  REQUIRED to come BEFORE issues. Render each `whatsGood` entry as a single bullet:",
  "    - {point} {`(via {attribution})`} ← attribution in italics, only when set",
  "  2–4 entries. Plain affirmation, no hedging — \"this works\" not \"this seems to work\".",
  "",
  "  ## Issues Found    ← `quality-issues`",
  "  Open with one short intro paragraph (1 sentence) framing the diagnostic scope.",
  "  Then for each issue, render an H3 sub-section sorted by severity descending (high → medium → low):",
  "    ### {issue.title}",
  "    **Severity: {severity}** · *{attribution if set}*",
  "    {issue.issue}",
  "    *Impact:* {issue.impact}",
  "  3–7 issues total. Each issue is diagnosis only — fixes are in the next section.",
  "",
  "  ## Fixes, Ranked    ← `severity-ranked-fixes`",
  "  Sort by severity descending (high → medium → low). Each fix as an H3:",
  "    ### {fix.title}",
  "    **Severity: {severity}** · effort: *{effort}* {`· owner: {owner}` if set}",
  "    {fix.fix}",
  "  3–7 fixes total. Pair fixes with issues by severity — the renderer surfaces the audit's prescription.",
  "",
  "  ## Residual Risks    ← `residual-risks` (skip if empty)",
  "  Open with one sentence framing what \"residual\" means (\"risks the audit can't close inside its scope\"). Then for each:",
  "    - {`**Severity: {severity}** · ` if set}**{risk}** — {whyResidual}",
  "  0–4 entries.",
  "",
  "  ## Open Questions for the Owner    ← `open-questions` (skip if empty)",
  "  Standard residual P0/P1 list. One bullet per question, prefixed with priority: `- **[P0]** {question}` (or P1).",
  "",
  "## Methodology footer",
  "",
  "The orchestrator appends a deterministic `## Methodology` section after your output. Do NOT write one yourself.",
  "",
  "## Voice register · critique-default",
  "",
  "Procedural, evidence-anchored, severity-aware. The deliverable is the subject — keep recommendations scoped to it (no \"and you should also pivot the product\"). Cite directors when their phrasing IS the diagnostic point. The scaffold's voice register may be overridden by a house-style addendum below — when present, follow that override on top of these defaults.",
].join("\n");

export function buildWriteMessages(opts: WriteOpts): LLMMessage[] {
  const { room, members, scaffold, perDirectorSignals, language, picked, houseStyle, briefId } = opts;

  const directorNameById = new Map(members.map((a) => [a.id, a.name]));
  const nameOf = (id: string) => directorNameById.get(id) || id;

  const memberList = members
    .map((a) => `${a.id} · ${a.name} (${a.handle}) — ${a.roleTag}`)
    .join("\n  · ");

  // ── Bottom Line ──
  const bottomLineBlock = [
    `  Judgement: ${scaffold.bottomLine.judgement}`,
    `  Confidence: ${scaffold.bottomLine.confidence}`,
    `  Rationale: ${scaffold.bottomLine.rationale || "(none)"}`,
  ].join("\n");

  // ── Frame Shift ──
  const frameShiftBlock = [
    `  Shifted: ${scaffold.frameShift.shifted}`,
    `  Original framing: ${scaffold.frameShift.original}`,
    `  Reframed: ${scaffold.frameShift.reframed || "(n/a — frame held)"}`,
    `  Trigger: ${scaffold.frameShift.trigger || "(none)"}`,
  ].join("\n");

  // ── Headline Findings ──
  const headlineFindingsBlock = scaffold.headlineFindings
    .map((f, i) => {
      const supporters = f.supporters.map(nameOf).join(", ") || "—";
      const challengers = f.challengers.length
        ? f.challengers.map(nameOf).join(", ")
        : "(none — full alignment)";
      const sub = f.supporting
        .map((s, si) => {
          const refs = s.evidenceRefs.length
            ? s.evidenceRefs.map((r) => `        · ${renderSignalRef(r, perDirectorSignals)}`).join("\n")
            : "        · (no evidence refs)";
          return [
            `      Sub-finding ${si + 1}: ${s.text}`,
            `      Evidence:`,
            refs,
          ].join("\n");
        })
        .join("\n\n");
      const tensionLine = f.tension ? `\n    Tension: ${f.tension}` : "";
      const counterLine = f.counterEvidence ? `\n    Counter-evidence: ${f.counterEvidence}` : "";
      const implicationLine = f.strategicImplication ? `\n    Strategic implication: ${f.strategicImplication}` : "";
      return [
        `  ### Finding ${i + 1}: ${f.title}`,
        `    Claim: ${f.claim}`,
        `    Confidence: ${f.confidence}`,
        `    Supporters: ${supporters}`,
        `    Challengers: ${challengers}`,
        `    Lenses present: ${f.lensesPresent.join(" + ") || "—"}${tensionLine}${counterLine}${implicationLine}`,
        `    Supporting:`,
        sub,
      ].join("\n");
    })
    .join("\n\n");

  // ── Convergence ──
  const convergenceBlock = scaffold.convergence.length
    ? scaffold.convergence
        .map((c, i) => {
          const paths = c.paths
            .map((p) => `      · ${nameOf(p.directorId)} via [${p.lens}]: ${p.reasoning}`)
            .join("\n");
          return [
            `  Convergence ${i + 1}: ${c.point}`,
            `    Independent paths:`,
            paths,
          ].join("\n");
        })
        .join("\n\n")
    : "  (no convergence — skip the section)";

  // ── Divergence ──
  const divergenceBlock = scaffold.divergence
    ? [
        `  Statement: ${scaffold.divergence.statement}`,
        `  Per-director stances:`,
        ...scaffold.divergence.rows.map((r) => {
          const name = nameOf(r.directorId);
          return `    · ${name} | ${r.stance} | confidence: ${r.confidence} | cost-of-being-wrong: ${r.costOfBeingWrong} | note: ${r.note}`;
        }),
        `  Resolution requirements:`,
        ...(scaffold.divergence.resolutionRequirements.length
          ? scaffold.divergence.resolutionRequirements.map((s) => `    · ${s}`)
          : ["    · (none)"]),
      ].join("\n")
    : "  (no central tension — skip the Where We Diverged section)";

  // ── Positions ──
  const positionsBlock = scaffold.positions.length
    ? scaffold.positions
        .map((p, i) => {
          const dirNames = p.directors.map(nameOf).join(", ");
          const evidence = p.evidenceRefs
            .map((ref) => `      · ${renderSignalRef(ref, perDirectorSignals)}`)
            .join("\n");
          return [
            `  ### Camp ${i + 1}: ${p.label}`,
            `    Claim: ${p.claim}`,
            `    Directors: ${dirNames || "—"}`,
            `    Evidence:`,
            evidence || "      (none)",
          ].join("\n");
        })
        .join("\n\n")
    : "  (no camps — skip the Positions section)";

  // ── Visuals ──
  const visualsBlock = scaffold.visuals.length
    ? scaffold.visuals
        .map((v) => {
          if (v.type === "comparison-table") {
            return [
              `  Visual · comparison-table`,
              `    Title: ${v.title}`,
              `    Row label: ${v.rowLabel}`,
              `    Columns: ${v.columns.join(" | ")}`,
              `    Rows:`,
              ...v.rows.map((r) => `      · ${r.name} | ${r.cells.join(" | ")}`),
            ].join("\n");
          }
          if (v.type === "quadrant-chart") {
            return [
              `  Visual · quadrant-chart`,
              `    Title: ${v.title}`,
              `    x-axis: ${v.xLabel}`,
              `    y-axis: ${v.yLabel}`,
              `    Quadrant labels: NE=${v.q1} · NW=${v.q2} · SW=${v.q3} · SE=${v.q4}`,
              `    Items:`,
              ...v.items.map((it) => `      · "${it.label}" at (x=${it.x.toFixed(2)}, y=${it.y.toFixed(2)})`),
            ].join("\n");
          }
          if (v.type === "force-field") {
            return [
              `  Visual · force-field`,
              `    Title: ${v.title}`,
              `    Drivers ↑:`,
              ...v.drivers.map((d) => `      · ${d}`),
              `    Resistors ↓:`,
              ...v.resistors.map((r) => `      · ${r}`),
            ].join("\n");
          }
          // strengths-cautions
          return [
            `  Visual · strengths-cautions`,
            `    Title: ${v.title}`,
            `    Rows:`,
            ...v.rows.map((r) =>
              [
                `      · Option: ${r.option}`,
                `        Strengths: ${r.strengths.join(" · ") || "(none)"}`,
                `        Cautions: ${r.cautions.join(" · ") || "(none)"}`,
                `        Verdict: ${r.verdict}`,
              ].join("\n"),
            ),
          ].join("\n");
        })
        .join("\n\n")
    : "  (no visuals — skip the Options Analysis section)";

  // ── Recommendations ──
  const recsBlock = scaffold.recommendations.length
    ? scaffold.recommendations
        .map((r, i) => {
          return [
            `  Rec ${i + 1} · [${r.priority}] ${r.action}`,
            `    Rationale: ${r.rationale}`,
            `    Owner: ${r.ownerType} · Horizon: ${r.horizon}`,
            `    Success metric: ${r.successMetric}`,
            ...(r.criticalDependency ? [`    Critical dependency: ${r.criticalDependency}`] : []),
            `    Risk if skipped: ${r.riskIfSkipped}`,
          ].join("\n");
        })
        .join("\n\n")
    : "  (no recommendations — skip the section)";

  // ── Pre-mortem ──
  const preMortemBlock = scaffold.preMortem.length
    ? scaffold.preMortem
        .map((f, i) =>
          [
            `  Failure ${i + 1}: ${f.scenario}`,
            `    Leading indicator: ${f.leadingIndicator}`,
            `    Mitigation: ${f.mitigation}`,
          ].join("\n"),
        )
        .join("\n\n")
    : "  (no pre-mortem — skip the section)";

  // ── New Questions ──
  const newQuestionsBlock = scaffold.newQuestions.length
    ? scaffold.newQuestions
        .map(
          (q, i) =>
            [
              `  New Q ${i + 1}: ${q.question}`,
              `    Why it matters: ${q.whyItMatters}`,
              `    Surfaced by: ${nameOf(q.surfacedByDirectorId)}`,
            ].join("\n"),
        )
        .join("\n\n")
    : "  (no new questions surfaced — skip the section)";

  // ── Strategic Planning Assumption ──
  const assumptionBlock = scaffold.planningAssumption
    ? [
        `  Statement: ${scaffold.planningAssumption.statement}`,
        `  Probability: ${scaffold.planningAssumption.probability}%`,
        `  Trigger: ${scaffold.planningAssumption.trigger}`,
        `  Falsification test: ${scaffold.planningAssumption.falsificationTest}`,
      ].join("\n")
    : "  (no planning assumption — skip the section)";

  // ── Open Questions ──
  const openQsBlock = scaffold.openQuestions.length
    ? scaffold.openQuestions.map((q) => `  · [${q.priority}] ${q.text}`).join("\n")
    : "  (none — skip the Open Questions section)";

  // ── Substitute components (only filled when composer picked them) ──
  const thesisBlock = scaffold.thesis && scaffold.thesis.claim
    ? [
        `  Claim: ${scaffold.thesis.claim}`,
        `  Reasoning: ${scaffold.thesis.reasoning || "(none)"}`,
      ].join("\n")
    : "  (no thesis — composer did not pick the substitute)";

  const bigIdeasBlock = scaffold.bigIdeas && scaffold.bigIdeas.length
    ? scaffold.bigIdeas
        .map((b) => {
          const evidence = b.evidenceRefs.length
            ? b.evidenceRefs
                .map((r) => `      · ${renderSignalRef(r, perDirectorSignals)}`)
                .join("\n")
            : "      · (no evidence refs)";
          return [
            `  Idea ${b.number}: ${b.claim}`,
            `    Why: ${b.why}`,
            `    Evidence:`,
            evidence,
          ].join("\n");
        })
        .join("\n\n")
    : "  (no big ideas — composer did not pick the substitute)";

  const theBetBlock = scaffold.theBet && scaffold.theBet.ifBacked
    ? [
        `  IfBacked: ${scaffold.theBet.ifBacked}`,
        `  Conditions:`,
        ...scaffold.theBet.conditions.map(
          (c, i) => `    ${i + 1}. ${c.condition}\n       Why: ${c.why}`,
        ),
        `  Kill criteria: ${scaffold.theBet.killCriteria || "(none)"}`,
      ].join("\n")
    : "  (no bet — composer did not pick the substitute)";

  const workingHypothesisBlock = scaffold.workingHypothesis && scaffold.workingHypothesis.hypothesis
    ? [
        `  Hypothesis: ${scaffold.workingHypothesis.hypothesis}`,
        `  Reasons it may be wrong:`,
        ...scaffold.workingHypothesis.reasonsItMayBeWrong.map((r) => `    · ${r}`),
      ].join("\n")
    : "  (no working hypothesis — composer did not pick the substitute)";

  const whyNowBlock = scaffold.whyNow
    ? [
        `  Window opened: ${scaffold.whyNow.windowOpened}`,
        `  Window closes: ${scaffold.whyNow.windowCloses || "(none)"}`,
        `  What to bet on: ${scaffold.whyNow.whatToBetOn}`,
      ].join("\n")
    : "  (no why-now — composer did not pick this component)";

  const twoPathsBlock = scaffold.twoPaths
    ? [
        `  Intro: ${scaffold.twoPaths.intro || "(none)"}`,
        `  Path A · ${scaffold.twoPaths.pathA.label}`,
        `    ${scaffold.twoPaths.pathA.body}`,
        `  Path B · ${scaffold.twoPaths.pathB.label}`,
        `    ${scaffold.twoPaths.pathB.body}`,
      ].join("\n")
    : "  (no two-paths — composer did not pick this component)";

  const considerationsBlock = scaffold.considerations && scaffold.considerations.length
    ? scaffold.considerations
        .map((r, i) =>
          [
            `  Consideration ${i + 1} · [${r.priority}] ${r.action}`,
            `    Rationale: ${r.rationale}`,
            `    Owner: ${r.ownerType} · Horizon: ${r.horizon}`,
            `    Success metric: ${r.successMetric}`,
            ...(r.criticalDependency ? [`    Critical dependency: ${r.criticalDependency}`] : []),
            `    Risk if skipped: ${r.riskIfSkipped}`,
          ].join("\n"),
        )
        .join("\n\n")
    : "  (no considerations — composer did not pick the substitute)";

  // ── Gartner-density blocks (composer-picked) ──
  const strategicOutlookBlock = scaffold.strategicOutlook
    ? [
        `  Context: ${scaffold.strategicOutlook.context}`,
        `  Implication: ${scaffold.strategicOutlook.implication}`,
      ].join("\n")
    : "  (no strategic outlook — composer did not pick this component)";

  const criticalAssumptionsBlock = scaffold.criticalAssumptions && scaffold.criticalAssumptions.length
    ? scaffold.criticalAssumptions
        .map((a, i) =>
          [
            `  Assumption ${i + 1}: ${a.statement}`,
            `    Confidence: ${a.confidence} · Horizon: ${a.horizon}`,
            `    Attribution: ${a.attribution}`,
            `    Falsifier: ${a.falsifier}`,
          ].join("\n"),
        )
        .join("\n\n")
    : "  (no critical assumptions — composer did not pick this component)";

  const scenarioTreeBlock = scaffold.scenarioTree && scaffold.scenarioTree.branches.length
    ? [
        `  Intro: ${scaffold.scenarioTree.intro}`,
        ...scaffold.scenarioTree.branches.map((b, i) => [
          `  Branch ${i + 1}: ${b.label} · ${b.probability}%`,
          `    Trigger: ${b.trigger}`,
          `    Effects:`,
          ...(b.effects.length ? b.effects.map((e) => `      · ${e}`) : ["      · (none)"]),
          `    Decision implication: ${b.decisionImplication}`,
        ].join("\n")),
      ].join("\n\n")
    : "  (no scenario tree — composer did not pick this component)";

  const leadingIndicatorsBlock = scaffold.leadingIndicators && scaffold.leadingIndicators.length
    ? scaffold.leadingIndicators
        .map((it, i) =>
          [
            `  Indicator ${i + 1}: ${it.signal}`,
            `    Threshold: ${it.threshold}`,
            `    Cadence: ${it.cadence}`,
            `    Flips to: ${it.flipsTo}`,
          ].join("\n"),
        )
        .join("\n\n")
    : "  (no leading indicators — composer did not pick this component)";

  const threatsToValidityBlock = scaffold.threatsToValidity && scaffold.threatsToValidity.length
    ? scaffold.threatsToValidity
        .map((t, i) =>
          [
            `  Threat ${i + 1}: ${t.category}`,
            `    Threat: ${t.threat}`,
            `    Observable: ${t.observable}`,
            `    Severity: ${t.severity}`,
            `    Mitigation: ${t.mitigation || "(none)"}`,
          ].join("\n"),
        )
        .join("\n\n")
    : "  (no threats-to-validity — composer did not pick this component)";

  const metricStripBlock = scaffold.metricStrip && scaffold.metricStrip.cards.length
    ? [
        `  Intro: ${scaffold.metricStrip.intro || "(none — the section heading is the framing)"}`,
        ``,
        ...scaffold.metricStrip.cards.map((c, i) =>
          [
            `  Card ${i + 1}: ${c.label}`,
            `    Value: ${c.value}`,
            `    Qualifier: ${c.qualifier || "(none — omit the .metric-qualifier div)"}`,
            `    Trend: ${c.trend || "(none — omit the data-trend attribute)"}`,
            `    Attribution: ${c.attribution || "(none — omit the .metric-attribution div)"}`,
          ].join("\n"),
        ),
      ].join("\n")
    : "  (no metric-strip — composer did not pick this component)";

  // ── Brainstorm-mode scaffold blocks ──
  // Populated only when room.mode === "brainstorm" and the composer
  // picked the corresponding kind. Otherwise rendered as a "(not
  // picked)" placeholder · the writer system prompt explicitly
  // instructs the model to skip non-picked sections.
  const openingHookBlock = scaffold.openingHook && scaffold.openingHook.hook
    ? [
        `  Hook: ${scaffold.openingHook.hook}`,
        `  Restatement: ${scaffold.openingHook.restatement || "(none — skip the pull-quote line)"}`,
      ].join("\n")
    : "  (no opening-hook — composer did not pick this component)";

  const opportunityShapeBlock = scaffold.opportunityShape && scaffold.opportunityShape.scope
    ? [
        `  Scope: ${scaffold.opportunityShape.scope}`,
        `  Gravity: ${scaffold.opportunityShape.gravity}`,
        `  Tempo: ${scaffold.opportunityShape.tempo}`,
        `  SizingHint: ${scaffold.opportunityShape.sizingHint || "(none — skip the closing italic line)"}`,
      ].join("\n")
    : "  (no opportunity-shape — composer did not pick this component)";

  const adjacentAnglesBlock = scaffold.adjacentAngles && scaffold.adjacentAngles.length
    ? scaffold.adjacentAngles
        .map((a, i) =>
          [
            `  Angle ${i + 1}: ${a.name}`,
            `    Framing: ${a.framing}`,
            `    What opens: ${a.whatOpens}`,
          ].join("\n"),
        )
        .join("\n\n")
    : "  (no adjacent-angles — composer did not pick this component)";

  const whatIfThisWorksBlock = scaffold.whatIfThisWorks && scaffold.whatIfThisWorks.consequences.length
    ? [
        `  Setup: ${scaffold.whatIfThisWorks.setup}`,
        `  Consequences:`,
        ...scaffold.whatIfThisWorks.consequences.map((c, i) => `    ${i + 1}. ${c}`),
      ].join("\n")
    : "  (no what-if-this-works — composer did not pick this component)";

  const worthChasingBlock = scaffold.worthChasing && scaffold.worthChasing.length
    ? scaffold.worthChasing
        .map((w, i) =>
          [
            `  Thread ${i + 1}: ${w.handle}`,
            `    Why it pulled: ${w.whyItPulled}`,
            `    Next testable question: ${w.nextTestableQuestion}`,
          ].join("\n"),
        )
        .join("\n\n")
    : "  (no worth-chasing — composer did not pick this component)";

  const deadEndsBlock = scaffold.deadEndsNoted && scaffold.deadEndsNoted.length
    ? scaffold.deadEndsNoted
        .map((d, i) => `  ${i + 1}. ${d.angle} — ${d.whyDropped}`)
        .join("\n")
    : "  (no dead-ends-noted — composer did not pick this component)";

  const brainstormQuestionsBlock = scaffold.brainstormQuestions && scaffold.brainstormQuestions.length
    ? scaffold.brainstormQuestions
        .map((q, i) => {
          const shift = q.whatWouldShift ? `\n     What would shift: ${q.whatWouldShift}` : "";
          return `  ${i + 1}. ${q.question}${shift}`;
        })
        .join("\n")
    : "  (no brainstorm-questions — composer did not pick this component)";

  // ── Critique-mode scaffold blocks ──
  const deliverableSummaryBlock = scaffold.deliverableSummary && scaffold.deliverableSummary.subject
    ? [
        `  Subject: ${scaffold.deliverableSummary.subject}`,
        `  Context: ${scaffold.deliverableSummary.context}`,
        `  Charter: ${scaffold.deliverableSummary.charter || "(none — skip the charter line)"}`,
      ].join("\n")
    : "  (no deliverable-summary — composer did not pick this component)";

  const whatsGoodBlock = scaffold.whatsGood && scaffold.whatsGood.length
    ? scaffold.whatsGood
        .map((g, i) => `  ${i + 1}. ${g.point}${g.attribution ? `  (via ${g.attribution})` : ""}`)
        .join("\n")
    : "  (no whats-good — composer did not pick this component)";

  const qualityIssuesBlock = scaffold.qualityIssues && scaffold.qualityIssues.length
    ? scaffold.qualityIssues
        .map((q, i) =>
          [
            `  Issue ${i + 1}: ${q.title}`,
            `    Severity: ${q.severity}`,
            `    Issue: ${q.issue}`,
            `    Impact: ${q.impact}`,
            `    Attribution: ${q.attribution || "(none)"}`,
          ].join("\n"),
        )
        .join("\n\n")
    : "  (no quality-issues — composer did not pick this component)";

  const severityRankedFixesBlock = scaffold.severityRankedFixes && scaffold.severityRankedFixes.length
    ? scaffold.severityRankedFixes
        .map((f, i) =>
          [
            `  Fix ${i + 1}: ${f.title}`,
            `    Severity: ${f.severity}`,
            `    Fix: ${f.fix}`,
            `    Effort: ${f.effort}`,
            `    Owner: ${f.owner || "(unowned — surface as a generic ask)"}`,
          ].join("\n"),
        )
        .join("\n\n")
    : "  (no severity-ranked-fixes — composer did not pick this component)";

  const residualRisksBlock = scaffold.residualRisks && scaffold.residualRisks.length
    ? scaffold.residualRisks
        .map((r, i) => {
          const sev = r.severity ? `[${r.severity}] ` : "";
          return `  ${i + 1}. ${sev}${r.risk} — ${r.whyResidual}`;
        })
        .join("\n")
    : "  (no residual-risks — composer did not pick this component)";

  const pickedNote = picked && picked.length
    ? [
        ``,
        `─── COMPOSER PICKED COMPONENTS ───`,
        ``,
        `Render ONLY these sections (in this order). Skip any section whose kind is not in this list, even if its scaffold field looks fillable.`,
        ...picked.map((k, i) => `  ${i + 1}. ${k}`),
        ``,
        `─── END PICKED ───`,
      ].join("\n")
    : "";

  const houseStyleAddendum = buildHouseStyleAddendum(houseStyle, language, briefId);

  // Mode-axis dispatch · brainstorm and critique rooms each get a
  // dedicated writer system prompt. Brainstorm renders the
  // exploration-shaped scaffold; critique renders the audit-shaped
  // scaffold. Constructive / debate / research fall through to
  // WRITE_SYSTEM. The user message below carries every scaffold
  // field (mode-irrelevant fields are zero-valued, so they read as
  // silent skips per the writer's "skip if empty" rules).
  const writerSystem = room.mode === "brainstorm"
    ? BRAINSTORM_WRITE_SYSTEM
    : room.mode === "critique"
      ? CRITIQUE_WRITE_SYSTEM
      : WRITE_SYSTEM;

  return [
    {
      role: "system",
      content: [
        writerSystem,
        "",
        languageInstruction(language),
        houseStyleAddendum,
        opts.retryAddendum || "",
      ].filter((s) => s).join("\n"),
    },
    {
      role: "user",
      content: [
        `ROOM #${room.number} · ${room.name}`,
        `Subject: ${room.subject}`,
        ``,
        `Directors at the table (id · display name):`,
        `  · ${memberList}`,
        ``,
        `─── SCAFFOLD ───`,
        ``,
        `Title: ${scaffold.title}`,
        ``,
        `## Bottom Line`,
        bottomLineBlock,
        ``,
        `## Frame Shift`,
        frameShiftBlock,
        ``,
        `## Headline Findings`,
        headlineFindingsBlock,
        ``,
        `## Convergence`,
        convergenceBlock,
        ``,
        `## Divergence`,
        divergenceBlock,
        ``,
        `## Positions`,
        positionsBlock,
        ``,
        `## Visuals`,
        visualsBlock,
        ``,
        `## Recommendations`,
        recsBlock,
        ``,
        `## Pre-mortem`,
        preMortemBlock,
        ``,
        `## New Questions`,
        newQuestionsBlock,
        ``,
        `## Planning Assumption`,
        assumptionBlock,
        ``,
        `## Open Questions`,
        openQsBlock,
        ``,
        `## Thesis (anchor substitute)`,
        thesisBlock,
        ``,
        `## Working Hypothesis (anchor substitute)`,
        workingHypothesisBlock,
        ``,
        `## Big Ideas (findings substitute)`,
        bigIdeasBlock,
        ``,
        `## The Bet (action substitute)`,
        theBetBlock,
        ``,
        `## Considerations (action substitute)`,
        considerationsBlock,
        ``,
        `## Why Now (forward / opportunity panel)`,
        whyNowBlock,
        ``,
        `## Two Paths (comparison panel)`,
        twoPathsBlock,
        ``,
        `## Strategic Outlook (Gartner-density)`,
        strategicOutlookBlock,
        ``,
        `## Critical Assumptions (Gartner-density)`,
        criticalAssumptionsBlock,
        ``,
        `## Scenario Tree (Gartner-density)`,
        scenarioTreeBlock,
        ``,
        `## Leading Indicators (Gartner-density)`,
        leadingIndicatorsBlock,
        ``,
        `## Threats to Validity (Stanford-style self-criticism)`,
        threatsToValidityBlock,
        ``,
        `## Metric Strip (dashboard · KPI cards)`,
        metricStripBlock,
        ``,
        `## Opening Hook (brainstorm anchor)`,
        openingHookBlock,
        ``,
        `## Opportunity Shape (brainstorm)`,
        opportunityShapeBlock,
        ``,
        `## Adjacent Angles (brainstorm)`,
        adjacentAnglesBlock,
        ``,
        `## What If This Works (brainstorm)`,
        whatIfThisWorksBlock,
        ``,
        `## Worth Chasing (brainstorm)`,
        worthChasingBlock,
        ``,
        `## Dead Ends Noted (brainstorm)`,
        deadEndsBlock,
        ``,
        `## Brainstorm Questions (brainstorm residual)`,
        brainstormQuestionsBlock,
        ``,
        `## Deliverable Summary (critique anchor)`,
        deliverableSummaryBlock,
        ``,
        `## What's Already Working (critique decorum · render BEFORE issues)`,
        whatsGoodBlock,
        ``,
        `## Quality Issues (critique · severity-ranked diagnosis)`,
        qualityIssuesBlock,
        ``,
        `## Severity-Ranked Fixes (critique · prescription)`,
        severityRankedFixesBlock,
        ``,
        `## Residual Risks (critique)`,
        residualRisksBlock,
        ``,
        `─── END SCAFFOLD ───`,
        pickedNote,
        ``,
        ...(opts.supplement && opts.supplement.trim()
          ? [
              `─── SUPPLEMENTARY PERSPECTIVE FROM USER ───`,
              ``,
              `The user asked for this additional angle to be explicitly addressed in the report. Weave it through — don't add a separate section for it. Make sure the relevant existing sections (Findings, Recommendations, New Questions, etc.) reflect it.`,
              ``,
              opts.supplement.trim(),
              ``,
              `─── END SUPPLEMENT ───`,
              ``,
            ]
          : []),
        `Write the final report now. Markdown only (the metricStrip block is the only embedded HTML — every other section is markdown). Start with the H2 title — no preamble. Replace director ids with display names from the directors list above. Follow the section order: Bottom Line / Thesis / Working Hypothesis (anchor) → Metric Strip (when picked) → Strategic Outlook (when picked) → Frame Shift → Headline Findings (or Big Ideas) → Where We Converged → Where We Diverged → Positions → Options Analysis / Two Paths → Critical Assumptions (when picked) → Threats to Validity (when picked) → Scenario Tree (when picked) → Why Now (when picked) → Recommendations / The Bet / Considerations (action) → Leading Indicators (when picked) → Pre-mortem → New Questions This Surfaced → Strategic Planning Assumption → Open Questions.`,
      ].join("\n"),
    },
  ];
}

/* ─────────────────── Mode contract validator ─────────────────────────
 *
 * Runs after Stage 3 produces markdown · checks the body for mode-
 * contract violations. Returns a list of violation reasons (empty when
 * the brief is clean). The orchestrator uses this to decide whether to
 * retry Stage 3 once with a stricter prompt.
 *
 * Brainstorm violations: decision-defense language ("the bet", "the
 * moat", "must hold", "护城河") that contradicts the open-up shape.
 * Critique violations: missing severity tags, strategy-creep verbs.
 * Constructive / debate / research / unknown modes: no violations
 * (the existing pipeline doesn't have a contract to validate against).
 *
 * Light-touch by design — the prompt-level constraints in the writer
 * system prompts catch most contract drift. This is the safety net for
 * the cases where a flagship model still slips into thesis register
 * despite explicit instructions to the contrary.
 * ────────────────────────────────────────────────────────────────── */

interface ContractViolation {
  /** Short tag to include in the retry prompt (e.g. "decision-defense
   *  language: \"the bet\""). */
  tag: string;
  /** Human-readable explanation for logging. */
  reason: string;
}

const BRAINSTORM_FORBIDDEN_PHRASES: { phrase: RegExp; tag: string }[] = [
  // Decision-defense / thesis register · these are the patterns that
  // most often leak into brainstorm briefs from the constructive prior.
  { phrase: /\bthe bet (is|on the table)\b/i,        tag: '"the bet is/on the table"' },
  { phrase: /\bthe moat\b/i,                          tag: '"the moat"' },
  { phrase: /\bcritical assumptions?\b/i,             tag: '"critical assumption(s)"' },
  { phrase: /\bmust hold\b/i,                         tag: '"must hold"' },
  { phrase: /\bwhat has to be true\b/i,               tag: '"what has to be true"' },
  { phrase: /\bunderwriting\b/i,                      tag: '"underwriting"' },
  { phrase: /\bwe recommend\b/i,                      tag: '"we recommend"' },
  // Chinese equivalents.
  { phrase: /护城河/,                                  tag: '"护城河"' },
  { phrase: /必须成立/,                                tag: '"必须成立"' },
  { phrase: /下注的(是|点是|对象是)/,                  tag: '"下注的是/点是"' },
  { phrase: /我们建议/,                                tag: '"我们建议"' },
];

const CRITIQUE_FORBIDDEN_PHRASES: { phrase: RegExp; tag: string }[] = [
  // Strategy creep — critique is scoped to the deliverable, not the
  // broader product / org direction.
  { phrase: /\bthe thesis is\b/i,                     tag: '"the thesis is" (strategy creep · critique is deliverable-scoped)' },
  { phrase: /\bthe moat is\b/i,                       tag: '"the moat is" (strategy creep)' },
  { phrase: /\byou should pivot\b/i,                  tag: '"you should pivot" (strategy creep)' },
  { phrase: /\bopportunity shape\b/i,                 tag: '"opportunity shape" (brainstorm leakage)' },
  { phrase: /护城河是/,                                tag: '"护城河是" (策略外延出 deliverable 范围)' },
  { phrase: /应该转型/,                                tag: '"应该转型" (策略外延)' },
];

/** Validate a Stage-3 markdown body against its room's mode contract.
 *  Returns an empty array for clean briefs and for modes without a
 *  contract (constructive / debate / research / other). */
export function validateBriefBody(body: string, mode: string): ContractViolation[] {
  if (!body) return [];
  const lower = body;  // case is preserved · regexes are case-insensitive where appropriate
  const out: ContractViolation[] = [];

  if (mode === "brainstorm") {
    for (const rule of BRAINSTORM_FORBIDDEN_PHRASES) {
      if (rule.phrase.test(lower)) {
        out.push({
          tag: rule.tag,
          reason: `brainstorm brief contains decision-defense phrase ${rule.tag}`,
        });
      }
    }
    return out;
  }

  if (mode === "critique") {
    for (const rule of CRITIQUE_FORBIDDEN_PHRASES) {
      if (rule.phrase.test(lower)) {
        out.push({
          tag: rule.tag,
          reason: `critique brief contains out-of-scope phrase ${rule.tag}`,
        });
      }
    }
    // Critique briefs that include quality-issues / severity-ranked-fixes
    // sections (heuristic: presence of "Issues" or "Fixes" H2 / H3) MUST
    // carry visible severity tags. Missing severity = the audit lost
    // its severity-ranking discipline.
    const hasIssuesOrFixes = /(^|\n)#{2,3}\s+(Issues|Fixes|严重|问题|修复)/i.test(body);
    const hasSeverityTag = /\*\*Severity:\s*(high|medium|low)\*\*/i.test(body)
      || /\*\*严重程度[：:]\s*(高|中|低)\*\*/i.test(body);
    if (hasIssuesOrFixes && !hasSeverityTag) {
      out.push({
        tag: "missing severity tags",
        reason: "critique brief has issues/fixes sections but no `**Severity: …**` markers",
      });
    }
    return out;
  }

  // Other modes: no contract validation (existing behaviour).
  return out;
}

/** Build a "retry · violations" addendum to inject into the writer
 *  system prompt on a retry. Names the violations and reiterates the
 *  contract so the second attempt has explicit corrections to make. */
export function buildContractRetryAddendum(violations: ContractViolation[], mode: string): string {
  if (violations.length === 0) return "";
  const lines: string[] = [
    "",
    "## RETRY · contract violations in previous attempt",
    "",
    "Your previous attempt produced these contract violations:",
    "",
    ...violations.map((v) => `  · ${v.tag}`),
    "",
  ];
  if (mode === "brainstorm") {
    lines.push(
      "This brief MUST be brainstorm-shaped. Rewrite from scratch:",
      "  · Replace any thesis / decision / commitment language with exploratory phrasing (`could`, `might`, `would open up`).",
      "  · Remove any \"the bet\", \"the moat\", \"critical assumptions\", \"must hold\" — those belong in decision briefs, not brainstorms.",
      "  · No `## Bottom Line`. No `## Recommendations`. No `## Critical Assumptions`. Use the brainstorm sections (`## Doors Worth Opening`, `## If This Plays Out`, `## Threads Worth Pulling`, etc.).",
      "  · The user will see a brief that OPENS UP the topic, not one that closes it down.",
    );
  } else if (mode === "critique") {
    lines.push(
      "This brief MUST be critique-shaped. Rewrite from scratch:",
      "  · Every issue and every fix MUST open with `**Severity: high/medium/low** ·` — visible tags are non-negotiable.",
      "  · Stay scoped to the deliverable. Strategy creep (`you should pivot`, `the moat is`, `应该转型`) is out of scope — the audit reviews what was submitted, not the broader product direction.",
      "  · `## What's Already Working` MUST come BEFORE `## Issues Found` — audit decorum.",
    );
  }
  return lines.join("\n");
}

/* ─────────────────────── JSON parsing helpers ────────────────────────── */

/**
 * Extract the first JSON object from a model response. Tolerates the
 * model emitting prose around a fenced ```json code block, or just
 * emitting bare JSON. Returns null on failure.
 */
export function extractJson<T = unknown>(raw: string): T | null {
  // Prefer fenced block.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fence ? fence[1] : raw;
  if (!candidate) return null;

  // Find the first balanced { ... } in the candidate.
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Validate + coerce a single director's stage-1 output. */
export function parseDirectorSignals(
  raw: string,
  director: Agent,
): DirectorSignals {
  const parsed = extractJson<{ signals?: unknown }>(raw);
  const out: DirectorSignals = {
    directorId: director.id,
    directorName: director.name,
    signals: [],
  };
  if (!parsed || !Array.isArray(parsed.signals)) return out;
  for (const s of parsed.signals) {
    if (!s || typeof s !== "object") continue;
    const obj = s as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    const lens = typeof obj.lens === "string" ? obj.lens.trim() : "";
    if (!text) continue;
    if (!(EVIDENCE_LENSES as readonly string[]).includes(lens)) continue;
    const sources = Array.isArray(obj.sources)
      ? obj.sources.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0)
      : [];
    out.signals.push({ text, lens: lens as EvidenceLens, sources });
    if (out.signals.length >= 4) break;
  }
  return out;
}

function parseConfidence(raw: unknown): Confidence {
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  return "medium";
}

function parsePriority(raw: unknown): Priority {
  if (raw === "P0" || raw === "P1" || raw === "P2") return raw;
  return "P1";
}

function parseLens(raw: unknown): EvidenceLens | null {
  if (typeof raw !== "string") return null;
  return (EVIDENCE_LENSES as readonly string[]).includes(raw) ? (raw as EvidenceLens) : null;
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

function parseEvidenceRefs(raw: unknown): string[] {
  return parseStringArray(raw);
}

function parseLensArray(raw: unknown): EvidenceLens[] {
  if (!Array.isArray(raw)) return [];
  const out: EvidenceLens[] = [];
  for (const x of raw) {
    const lens = parseLens(x);
    if (lens && !out.includes(lens)) out.push(lens);
  }
  return out;
}

function parseBottomLine(raw: unknown, fallbackJudgement: string): BottomLine {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    judgement: typeof obj.judgement === "string" && obj.judgement.trim()
      ? obj.judgement.trim()
      : fallbackJudgement,
    confidence: parseConfidence(obj.confidence),
    rationale: typeof obj.rationale === "string" ? obj.rationale.trim() : "",
  };
}

function parseFrameShift(raw: unknown, fallbackOriginal: string): FrameShift {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const shifted = obj.shifted === true;
  return {
    shifted,
    original: typeof obj.original === "string" && obj.original.trim()
      ? obj.original.trim()
      : fallbackOriginal,
    reframed: typeof obj.reframed === "string" ? obj.reframed.trim() : "",
    trigger: typeof obj.trigger === "string" ? obj.trigger.trim() : "",
  };
}

function parseSubFinding(raw: unknown): SubFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (!text) return null;
  return { text, evidenceRefs: parseEvidenceRefs(o.evidenceRefs) };
}

function parseHeadlineFinding(raw: unknown): HeadlineFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  const claim = typeof o.claim === "string" ? o.claim.trim() : "";
  if (!title || !claim) return null;
  const supportingRaw = Array.isArray(o.supporting) ? o.supporting : [];
  const supporting: SubFinding[] = [];
  for (const s of supportingRaw) {
    const sub = parseSubFinding(s);
    if (sub) supporting.push(sub);
    if (supporting.length >= 4) break;
  }
  return {
    title,
    claim,
    confidence: parseConfidence(o.confidence),
    supporters: parseStringArray(o.supporters),
    challengers: parseStringArray(o.challengers),
    supporting,
    lensesPresent: parseLensArray(o.lensesPresent),
    tension: typeof o.tension === "string" && o.tension.trim() ? o.tension.trim() : undefined,
  };
}

function parseConvergencePath(raw: unknown): ConvergencePath | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const directorId = typeof o.directorId === "string" ? o.directorId : "";
  const lens = parseLens(o.lens);
  const reasoning = typeof o.reasoning === "string" ? o.reasoning.trim() : "";
  if (!directorId || !lens || !reasoning) return null;
  return { directorId, lens, reasoning };
}

function parseConvergence(raw: unknown): ConvergencePoint[] {
  if (!Array.isArray(raw)) return [];
  const out: ConvergencePoint[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const point = typeof o.point === "string" ? o.point.trim() : "";
    if (!point) continue;
    const pathsRaw = Array.isArray(o.paths) ? o.paths : [];
    const paths: ConvergencePath[] = [];
    for (const p of pathsRaw) {
      const parsed = parseConvergencePath(p);
      if (parsed) paths.push(parsed);
    }
    // Convergence requires ≥ 2 distinct directors via ≥ 2 distinct lenses.
    const distinctDirs = new Set(paths.map((p) => p.directorId));
    const distinctLenses = new Set(paths.map((p) => p.lens));
    if (distinctDirs.size < 2 || distinctLenses.size < 2) continue;
    out.push({ point, paths });
    if (out.length >= 4) break;
  }
  return out;
}

function parseDivergenceStance(raw: unknown): DivergenceStance | null {
  if (raw === "for" || raw === "against" || raw === "nuanced") return raw;
  return null;
}

function parseDivergence(raw: unknown): Divergence | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const statement = typeof o.statement === "string" ? o.statement.trim() : "";
  if (!statement) return null;
  const rowsRaw = Array.isArray(o.rows) ? o.rows : [];
  const rows: DivergenceRow[] = [];
  for (const r of rowsRaw) {
    if (!r || typeof r !== "object") continue;
    const ro = r as Record<string, unknown>;
    const directorId = typeof ro.directorId === "string" ? ro.directorId : "";
    const stance = parseDivergenceStance(ro.stance);
    const note = typeof ro.note === "string" ? ro.note.trim() : "";
    const cost = typeof ro.costOfBeingWrong === "string" ? ro.costOfBeingWrong.trim() : "";
    if (!directorId || !stance) continue;
    rows.push({
      directorId,
      stance,
      confidence: parseConfidence(ro.confidence),
      costOfBeingWrong: cost.slice(0, 120),
      note: note.slice(0, 120),
    });
  }
  const resReqs = parseStringArray(o.resolutionRequirements)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  return { statement, rows, resolutionRequirements: resReqs };
}

function parsePositions(raw: unknown): PositionCamp[] {
  if (!Array.isArray(raw)) return [];
  const out: PositionCamp[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label.trim() : "";
    const claim = typeof o.claim === "string" ? o.claim.trim() : "";
    if (!label || !claim) continue;
    out.push({
      label,
      claim,
      directors: parseStringArray(o.directors),
      evidenceRefs: parseEvidenceRefs(o.evidenceRefs),
    });
    if (out.length >= 4) break;
  }
  return out;
}

function parseVisual(raw: unknown): Visual | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const type = o.type;
  const title = typeof o.title === "string" ? o.title.trim() : "";
  if (type === "comparison-table") {
    const rowLabel = typeof o.rowLabel === "string" ? o.rowLabel.trim() : "Option";
    const columns = parseStringArray(o.columns);
    const rowsRaw = Array.isArray(o.rows) ? o.rows : [];
    const rows: { name: string; cells: string[] }[] = [];
    for (const r of rowsRaw) {
      if (!r || typeof r !== "object") continue;
      const ro = r as Record<string, unknown>;
      const name = typeof ro.name === "string" ? ro.name.trim() : "";
      const cells = Array.isArray(ro.cells)
        ? (ro.cells.map((c) => (typeof c === "string" ? c : "")).slice(0, columns.length))
        : [];
      if (!name) continue;
      while (cells.length < columns.length) cells.push("");
      rows.push({ name, cells });
    }
    if (!columns.length || !rows.length) return null;
    return { type: "comparison-table", title, rowLabel, columns, rows };
  }
  if (type === "quadrant-chart") {
    const xLabel = typeof o.xLabel === "string" ? o.xLabel.trim() : "x";
    const yLabel = typeof o.yLabel === "string" ? o.yLabel.trim() : "y";
    const q1 = typeof o.q1 === "string" ? o.q1.trim() : "";
    const q2 = typeof o.q2 === "string" ? o.q2.trim() : "";
    const q3 = typeof o.q3 === "string" ? o.q3.trim() : "";
    const q4 = typeof o.q4 === "string" ? o.q4.trim() : "";
    const itemsRaw = Array.isArray(o.items) ? o.items : [];
    const items: { label: string; x: number; y: number }[] = [];
    for (const it of itemsRaw) {
      if (!it || typeof it !== "object") continue;
      const io = it as Record<string, unknown>;
      const label = typeof io.label === "string" ? io.label.trim() : "";
      const x = typeof io.x === "number" && Number.isFinite(io.x) ? Math.max(0, Math.min(1, io.x)) : null;
      const y = typeof io.y === "number" && Number.isFinite(io.y) ? Math.max(0, Math.min(1, io.y)) : null;
      if (!label || x === null || y === null) continue;
      items.push({ label, x, y });
    }
    if (!items.length) return null;
    return { type: "quadrant-chart", title, xLabel, yLabel, q1, q2, q3, q4, items };
  }
  if (type === "force-field") {
    const drivers = parseStringArray(o.drivers).map((s) => s.trim()).filter(Boolean);
    const resistors = parseStringArray(o.resistors).map((s) => s.trim()).filter(Boolean);
    if (!drivers.length && !resistors.length) return null;
    return { type: "force-field", title, drivers, resistors };
  }
  if (type === "strengths-cautions") {
    const rowsRaw = Array.isArray(o.rows) ? o.rows : [];
    const rows: StrengthsCautionsVisual["rows"] = [];
    for (const r of rowsRaw) {
      if (!r || typeof r !== "object") continue;
      const ro = r as Record<string, unknown>;
      const option = typeof ro.option === "string" ? ro.option.trim() : "";
      if (!option) continue;
      const verdictRaw = ro.verdict;
      const verdict: StrengthsCautionsVisual["rows"][number]["verdict"] =
        verdictRaw === "recommended" || verdictRaw === "caution" || verdictRaw === "not-recommended"
          ? verdictRaw
          : "caution";
      rows.push({
        option,
        strengths: parseStringArray(ro.strengths).map((s) => s.trim()).filter(Boolean),
        cautions: parseStringArray(ro.cautions).map((s) => s.trim()).filter(Boolean),
        verdict,
      });
    }
    if (!rows.length) return null;
    return { type: "strengths-cautions", title, rows };
  }
  if (type === "bar-chart") {
    const yLabel = typeof o.yLabel === "string" ? o.yLabel.trim() : "Value";
    const unit = typeof o.unit === "string" ? o.unit.trim() : "";
    const barsRaw = Array.isArray(o.bars) ? o.bars : [];
    const bars: BarChartVisual["bars"] = [];
    for (const b of barsRaw) {
      if (!b || typeof b !== "object") continue;
      const bo = b as Record<string, unknown>;
      const label = typeof bo.label === "string" ? bo.label.trim() : "";
      const valueRaw = bo.value;
      const value = typeof valueRaw === "number" && Number.isFinite(valueRaw) ? valueRaw : null;
      if (!label || value === null) continue;
      bars.push({ label, value });
      if (bars.length >= 8) break;
    }
    // 2 bars is the minimum that reads as a comparison; 1 bar is a number.
    if (bars.length < 2) return null;
    return { type: "bar-chart", title, yLabel, unit, bars };
  }
  if (type === "timeline") {
    const pointsRaw = Array.isArray(o.points) ? o.points : [];
    const points: TimelineVisual["points"] = [];
    for (const p of pointsRaw) {
      if (!p || typeof p !== "object") continue;
      const po = p as Record<string, unknown>;
      const period = typeof po.period === "string" ? po.period.trim() : "";
      const label = typeof po.label === "string" ? po.label.trim() : "";
      const description = typeof po.description === "string" ? po.description.trim() : "";
      if (!period || !label) continue;
      points.push({ period, label, description });
      if (points.length >= 8) break;
    }
    if (points.length < 3) return null;
    return { type: "timeline", title, points };
  }
  if (type === "pie-chart") {
    const slicesRaw = Array.isArray(o.slices) ? o.slices : [];
    const slices: PieChartVisual["slices"] = [];
    for (const s of slicesRaw) {
      if (!s || typeof s !== "object") continue;
      const so = s as Record<string, unknown>;
      const label = typeof so.label === "string" ? so.label.trim() : "";
      const valueRaw = so.value;
      const value =
        typeof valueRaw === "number" && Number.isFinite(valueRaw) && valueRaw >= 0
          ? valueRaw
          : null;
      if (!label || value === null) continue;
      slices.push({ label, value });
      if (slices.length >= 6) break;
    }
    if (slices.length < 2) return null;
    return { type: "pie-chart", title, slices };
  }
  return null;
}

function parseVisuals(raw: unknown): Visual[] {
  if (!Array.isArray(raw)) return [];
  const out: Visual[] = [];
  for (const v of raw) {
    const parsed = parseVisual(v);
    if (parsed) out.push(parsed);
    if (out.length >= 4) break;
  }
  return out;
}

function parseRecommendations(raw: unknown): Recommendation[] {
  if (!Array.isArray(raw)) return [];
  const out: Recommendation[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const action = typeof o.action === "string" ? o.action.trim() : "";
    if (!action) continue;
    out.push({
      priority: parsePriority(o.priority),
      action,
      rationale: typeof o.rationale === "string" ? o.rationale.trim() : "",
      ownerType: typeof o.ownerType === "string" ? o.ownerType.trim() : "",
      horizon: typeof o.horizon === "string" ? o.horizon.trim() : "",
      successMetric: typeof o.successMetric === "string" ? o.successMetric.trim() : "",
      riskIfSkipped: typeof o.riskIfSkipped === "string" ? o.riskIfSkipped.trim() : "",
    });
    if (out.length >= 6) break;
  }
  // Sort by priority: P0 first, then P1, then P2.
  out.sort((a, b) => {
    const order = { P0: 0, P1: 1, P2: 2 };
    return order[a.priority] - order[b.priority];
  });
  return out;
}

function parsePreMortem(raw: unknown): FailureMode[] {
  if (!Array.isArray(raw)) return [];
  const out: FailureMode[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const scenario = typeof o.scenario === "string" ? o.scenario.trim() : "";
    if (!scenario) continue;
    out.push({
      scenario,
      leadingIndicator: typeof o.leadingIndicator === "string" ? o.leadingIndicator.trim() : "",
      mitigation: typeof o.mitigation === "string" ? o.mitigation.trim() : "",
    });
    if (out.length >= 4) break;
  }
  return out;
}

function parseNewQuestions(raw: unknown): NewQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: NewQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const o = q as Record<string, unknown>;
    const question = typeof o.question === "string" ? o.question.trim() : "";
    if (!question) continue;
    out.push({
      question,
      whyItMatters: typeof o.whyItMatters === "string" ? o.whyItMatters.trim() : "",
      surfacedByDirectorId: typeof o.surfacedByDirectorId === "string" ? o.surfacedByDirectorId : "",
    });
    if (out.length >= 5) break;
  }
  return out;
}

function parsePlanningAssumption(raw: unknown): PlanningAssumption | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const statement = typeof o.statement === "string" ? o.statement.trim() : "";
  if (!statement) return null;
  let probability = 50;
  if (typeof o.probability === "number" && Number.isFinite(o.probability)) {
    probability = Math.max(0, Math.min(100, Math.round(o.probability)));
  }
  return {
    statement,
    probability,
    trigger: typeof o.trigger === "string" ? o.trigger.trim() : "",
    falsificationTest: typeof o.falsificationTest === "string" ? o.falsificationTest.trim() : "",
  };
}

function parseOpenQuestions(raw: unknown): OpenQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: OpenQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const o = q as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (!text) continue;
    const priority: OpenQuestionPriority = o.priority === "P0" ? "P0" : "P1";
    out.push({ text, priority });
    if (out.length >= 4) break;
  }
  return out;
}

/* ─────────── Substitute-component parsers (composer-driven) ─────────────── */

function parseThesis(raw: unknown): Thesis | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const claim = typeof o.claim === "string" ? o.claim.trim() : "";
  if (!claim) return null;
  const reasoning = typeof o.reasoning === "string" ? o.reasoning.trim() : "";
  return { claim, reasoning };
}

function parseBigIdeas(raw: unknown): BigIdea[] | null {
  if (!Array.isArray(raw)) return null;
  const out: BigIdea[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const claim = typeof o.claim === "string" ? o.claim.trim() : "";
    if (!claim) continue;
    const why = typeof o.why === "string" ? o.why.trim() : "";
    const numRaw = typeof o.number === "number" ? o.number : out.length + 1;
    const number = (numRaw === 1 || numRaw === 2 || numRaw === 3 ? numRaw : (out.length + 1)) as 1 | 2 | 3;
    out.push({
      number,
      claim,
      why,
      evidenceRefs: parseEvidenceRefs(o.evidenceRefs),
    });
    if (out.length >= 3) break;
  }
  if (out.length < 3) return null;
  // Renumber to ensure contiguous 1/2/3.
  out.forEach((idea, i) => {
    idea.number = (i + 1) as 1 | 2 | 3;
  });
  return out;
}

function parseTheBet(raw: unknown): TheBet | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const ifBacked = typeof o.ifBacked === "string" ? o.ifBacked.trim() : "";
  if (!ifBacked) return null;
  const conditionsRaw = Array.isArray(o.conditions) ? o.conditions : [];
  const conditions: TheBetCondition[] = [];
  for (const c of conditionsRaw) {
    if (!c || typeof c !== "object") continue;
    const co = c as Record<string, unknown>;
    const condition = typeof co.condition === "string" ? co.condition.trim() : "";
    if (!condition) continue;
    const why = typeof co.why === "string" ? co.why.trim() : "";
    conditions.push({ condition, why });
    if (conditions.length >= 5) break;
  }
  if (conditions.length < 1) return null;
  const killCriteria = typeof o.killCriteria === "string" ? o.killCriteria.trim() : "";
  return { ifBacked, conditions, killCriteria };
}

function parseWorkingHypothesis(raw: unknown): WorkingHypothesis | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const hypothesis = typeof o.hypothesis === "string" ? o.hypothesis.trim() : "";
  if (!hypothesis) return null;
  const reasonsRaw = Array.isArray(o.reasonsItMayBeWrong) ? o.reasonsItMayBeWrong : [];
  const reasons: string[] = [];
  for (const r of reasonsRaw) {
    if (typeof r !== "string") continue;
    const t = r.trim();
    if (!t) continue;
    reasons.push(t);
    if (reasons.length >= 3) break;
  }
  if (reasons.length < 1) return null;
  return { hypothesis, reasonsItMayBeWrong: reasons };
}

function parseWhyNow(raw: unknown): WhyNow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const windowOpened = typeof o.windowOpened === "string" ? o.windowOpened.trim() : "";
  const windowCloses = typeof o.windowCloses === "string" ? o.windowCloses.trim() : "";
  const whatToBetOn = typeof o.whatToBetOn === "string" ? o.whatToBetOn.trim() : "";
  // Need at least the open + bet to be a meaningful section.
  if (!windowOpened || !whatToBetOn) return null;
  return { windowOpened, windowCloses, whatToBetOn };
}

function parseTwoPaths(raw: unknown): TwoPaths | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const intro = typeof o.intro === "string" ? o.intro.trim() : "";
  const pathA = parseTwoPathPanel(o.pathA);
  const pathB = parseTwoPathPanel(o.pathB);
  if (!pathA || !pathB) return null;
  return { intro, pathA, pathB };
}

function parseTwoPathPanel(raw: unknown): TwoPathPanel | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === "string" ? o.label.trim() : "";
  const body = typeof o.body === "string" ? o.body.trim() : "";
  if (!label || !body) return null;
  return { label, body };
}

/* ─── Gartner-density + Stanford-research parsers · all defensive,
 *      net-additive. Each returns null / [] when the field is absent
 *      or shaped wrong; the renderer's "skip if empty" rules do the
 *      rest. Without these the LLM's output for the picked dense
 *      blocks was being silently dropped on the floor — the prompt
 *      sections existed but the parser never extracted them.
 */

function parseStrategicOutlook(raw: unknown): StrategicOutlook | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const context = typeof o.context === "string" ? o.context.trim() : "";
  const implication = typeof o.implication === "string" ? o.implication.trim() : "";
  if (!context || !implication) return null;
  return { context, implication };
}

function parseCriticalAssumption(raw: unknown): CriticalAssumption | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const statement = typeof o.statement === "string" ? o.statement.trim() : "";
  const falsifier = typeof o.falsifier === "string" ? o.falsifier.trim() : "";
  if (!statement || !falsifier) return null;
  const horizon = typeof o.horizon === "string" ? o.horizon.trim() : "";
  const attribution = typeof o.attribution === "string" ? o.attribution.trim() : "";
  return {
    statement,
    confidence: parseConfidence(o.confidence),
    falsifier,
    horizon,
    attribution,
  };
}

function parseCriticalAssumptions(raw: unknown): CriticalAssumption[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: CriticalAssumption[] = [];
  for (const entry of raw) {
    const a = parseCriticalAssumption(entry);
    if (a) out.push(a);
    if (out.length >= 6) break;
  }
  return out.length ? out : null;
}

function parseScenarioBranch(raw: unknown): ScenarioBranch | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === "string" ? o.label.trim() : "";
  const trigger = typeof o.trigger === "string" ? o.trigger.trim() : "";
  const decisionImplication = typeof o.decisionImplication === "string" ? o.decisionImplication.trim() : "";
  if (!label || !trigger) return null;
  const probabilityRaw = o.probability;
  const probability =
    typeof probabilityRaw === "number" && Number.isFinite(probabilityRaw)
      ? Math.max(0, Math.min(100, Math.round(probabilityRaw)))
      : 0;
  const effectsRaw = Array.isArray(o.effects) ? o.effects : [];
  const effects: string[] = [];
  for (const e of effectsRaw) {
    if (typeof e !== "string") continue;
    const t = e.trim();
    if (t) effects.push(t);
    if (effects.length >= 4) break;
  }
  return { label, probability, trigger, effects, decisionImplication };
}

function parseScenarioTree(raw: unknown): ScenarioTree | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const intro = typeof o.intro === "string" ? o.intro.trim() : "";
  const branchesRaw = Array.isArray(o.branches) ? o.branches : [];
  const branches: ScenarioBranch[] = [];
  for (const b of branchesRaw) {
    const parsed = parseScenarioBranch(b);
    if (parsed) branches.push(parsed);
    if (branches.length >= 4) break;
  }
  if (branches.length < 2) return null;
  return { intro, branches };
}

function parseLeadingIndicator(raw: unknown): LeadingIndicator | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const signal = typeof o.signal === "string" ? o.signal.trim() : "";
  const threshold = typeof o.threshold === "string" ? o.threshold.trim() : "";
  const flipsTo = typeof o.flipsTo === "string" ? o.flipsTo.trim() : "";
  if (!signal || !threshold || !flipsTo) return null;
  const cadence = typeof o.cadence === "string" ? o.cadence.trim() : "";
  return { signal, threshold, cadence, flipsTo };
}

function parseLeadingIndicators(raw: unknown): LeadingIndicator[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: LeadingIndicator[] = [];
  for (const entry of raw) {
    const parsed = parseLeadingIndicator(entry);
    if (parsed) out.push(parsed);
    if (out.length >= 5) break;
  }
  return out.length ? out : null;
}

function parseThreatSeverity(raw: unknown): ThreatSeverity {
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  return "medium";
}

function parseThreatToValidity(raw: unknown): ThreatToValidity | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const category = typeof o.category === "string" ? o.category.trim() : "";
  const threat = typeof o.threat === "string" ? o.threat.trim() : "";
  const observable = typeof o.observable === "string" ? o.observable.trim() : "";
  if (!category || !threat || !observable) return null;
  const severity = parseThreatSeverity(o.severity);
  const mitRaw = typeof o.mitigation === "string" ? o.mitigation.trim() : "";
  const mitigation = mitRaw.length > 0 ? mitRaw : null;
  return { category, threat, observable, severity, mitigation };
}

function parseThreatsToValidity(raw: unknown): ThreatToValidity[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: ThreatToValidity[] = [];
  for (const entry of raw) {
    const parsed = parseThreatToValidity(entry);
    if (parsed) out.push(parsed);
    if (out.length >= 5) break;
  }
  return out.length ? out : null;
}

function parseMetricTrend(raw: unknown): MetricTrend | null {
  if (raw === "up" || raw === "down" || raw === "flat") return raw;
  return null;
}

function parseMetricCard(raw: unknown): MetricCard | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === "string" ? o.label.trim() : "";
  const value = typeof o.value === "string" ? o.value.trim() : "";
  if (!label || !value) return null;
  const qualifierRaw = typeof o.qualifier === "string" ? o.qualifier.trim() : "";
  const qualifier = qualifierRaw.length > 0 ? qualifierRaw : null;
  const attributionRaw = typeof o.attribution === "string" ? o.attribution.trim() : "";
  const attribution = attributionRaw.length > 0 ? attributionRaw : null;
  return {
    label,
    value,
    qualifier,
    trend: parseMetricTrend(o.trend),
    attribution,
  };
}

function parseMetricStrip(raw: unknown): MetricStrip | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const intro = typeof o.intro === "string" ? o.intro.trim() : "";
  const cardsRaw = Array.isArray(o.cards) ? o.cards : [];
  const cards: MetricCard[] = [];
  for (const entry of cardsRaw) {
    const parsed = parseMetricCard(entry);
    if (parsed) cards.push(parsed);
    if (cards.length >= 5) break;
  }
  // Below 3 cards reads as a half-formed dashboard · drop the whole strip
  // rather than render a fragmented one.
  if (cards.length < 3) return null;
  return { intro, cards };
}

/* ─────────────── Brainstorm-mode field parsers ─────────────────── */

function parseOpeningHook(raw: unknown): OpeningHook | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const hook = typeof o.hook === "string" ? o.hook.trim() : "";
  if (!hook) return null;
  const restatement = typeof o.restatement === "string" && o.restatement.trim()
    ? o.restatement.trim()
    : null;
  return { hook, restatement };
}

function parseOpportunityShape(raw: unknown): OpportunityShape | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const scope = typeof o.scope === "string" ? o.scope.trim() : "";
  const gravity = typeof o.gravity === "string" ? o.gravity.trim() : "";
  const tempo = typeof o.tempo === "string" ? o.tempo.trim() : "";
  if (!scope || !gravity || !tempo) return null;
  const sizingHint = typeof o.sizingHint === "string" && o.sizingHint.trim()
    ? o.sizingHint.trim()
    : null;
  return { scope, gravity, tempo, sizingHint };
}

function parseAdjacentAngles(raw: unknown): AdjacentAngle[] {
  if (!Array.isArray(raw)) return [];
  const out: AdjacentAngle[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name.trim() : "";
    const framing = typeof o.framing === "string" ? o.framing.trim() : "";
    const whatOpens = typeof o.whatOpens === "string" ? o.whatOpens.trim() : "";
    if (!name || !framing || !whatOpens) continue;
    out.push({ name, framing, whatOpens });
    if (out.length >= 5) break;  // composer cap
  }
  return out;
}

function parseWhatIfThisWorks(raw: unknown): WhatIfThisWorks | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const setup = typeof o.setup === "string" ? o.setup.trim() : "";
  if (!setup) return null;
  const consRaw = Array.isArray(o.consequences) ? o.consequences : [];
  const consequences = consRaw
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    .map((c) => c.trim())
    .slice(0, 3);  // composer cap · exactly 3
  if (consequences.length < 2) return null;  // 2-3 acceptable; 1 reads as half-baked
  return { setup, consequences };
}

function parseWorthChasing(raw: unknown): WorthChasingAngle[] {
  if (!Array.isArray(raw)) return [];
  const out: WorthChasingAngle[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const handle = typeof o.handle === "string" ? o.handle.trim() : "";
    const whyItPulled = typeof o.whyItPulled === "string" ? o.whyItPulled.trim() : "";
    const nextTestableQuestion = typeof o.nextTestableQuestion === "string" ? o.nextTestableQuestion.trim() : "";
    if (!handle || !whyItPulled || !nextTestableQuestion) continue;
    out.push({ handle, whyItPulled, nextTestableQuestion });
    if (out.length >= 5) break;
  }
  return out;
}

function parseDeadEndsNoted(raw: unknown): DeadEndNoted[] {
  if (!Array.isArray(raw)) return [];
  const out: DeadEndNoted[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const angle = typeof o.angle === "string" ? o.angle.trim() : "";
    const whyDropped = typeof o.whyDropped === "string" ? o.whyDropped.trim() : "";
    if (!angle || !whyDropped) continue;
    out.push({ angle, whyDropped });
    if (out.length >= 3) break;
  }
  return out;
}

function parseBrainstormQuestions(raw: unknown): BrainstormQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: BrainstormQuestion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const question = typeof o.question === "string" ? o.question.trim() : "";
    if (!question) continue;
    const whatWouldShift = typeof o.whatWouldShift === "string" && o.whatWouldShift.trim()
      ? o.whatWouldShift.trim()
      : null;
    out.push({ question, whatWouldShift });
    if (out.length >= 8) break;
  }
  return out;
}

/* ─────────────── Critique-mode field parsers ─────────────────── */

function parseSeverity(raw: unknown): CritiqueSeverity | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "high" || v === "medium" || v === "low") return v;
  return null;
}

function parseDeliverableSummary(raw: unknown): DeliverableSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const subject = typeof o.subject === "string" ? o.subject.trim() : "";
  const context = typeof o.context === "string" ? o.context.trim() : "";
  if (!subject || !context) return null;
  const charter = typeof o.charter === "string" && o.charter.trim() ? o.charter.trim() : null;
  return { subject, context, charter };
}

function parseWhatsGood(raw: unknown): WhatsGood[] {
  if (!Array.isArray(raw)) return [];
  const out: WhatsGood[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const point = typeof o.point === "string" ? o.point.trim() : "";
    if (!point) continue;
    const attribution = typeof o.attribution === "string" && o.attribution.trim()
      ? o.attribution.trim()
      : null;
    out.push({ point, attribution });
    if (out.length >= 4) break;
  }
  return out;
}

function parseQualityIssues(raw: unknown): QualityIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: QualityIssue[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const severity = parseSeverity(o.severity);
    const issue = typeof o.issue === "string" ? o.issue.trim() : "";
    const impact = typeof o.impact === "string" ? o.impact.trim() : "";
    if (!title || !severity || !issue || !impact) continue;
    const attribution = typeof o.attribution === "string" && o.attribution.trim()
      ? o.attribution.trim()
      : null;
    out.push({ title, severity, issue, impact, attribution });
    if (out.length >= 7) break;
  }
  return out;
}

function parseSeverityRankedFixes(raw: unknown): SeverityRankedFix[] {
  if (!Array.isArray(raw)) return [];
  const out: SeverityRankedFix[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const severity = parseSeverity(o.severity);
    const fix = typeof o.fix === "string" ? o.fix.trim() : "";
    const effort = typeof o.effort === "string" ? o.effort.trim() : "";
    if (!title || !severity || !fix || !effort) continue;
    const owner = typeof o.owner === "string" && o.owner.trim() ? o.owner.trim() : null;
    out.push({ title, severity, fix, effort, owner });
    if (out.length >= 7) break;
  }
  return out;
}

function parseResidualRisks(raw: unknown): ResidualRisk[] {
  if (!Array.isArray(raw)) return [];
  const out: ResidualRisk[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const risk = typeof o.risk === "string" ? o.risk.trim() : "";
    const whyResidual = typeof o.whyResidual === "string" ? o.whyResidual.trim() : "";
    if (!risk || !whyResidual) continue;
    const severity = parseSeverity(o.severity);
    out.push({ risk, whyResidual, severity });
    if (out.length >= 4) break;
  }
  return out;
}

/** Validate + coerce the chair's stage-2 scaffold.
 *
 *  Mode-aware validity floor:
 *    · constructive / debate / research / critique / (default) · the
 *      scaffold must carry a load-bearing anchor (bottomLine OR thesis)
 *      AND a load-bearing findings block (≥ 1 headlineFinding OR a
 *      complete bigIdeas array). The legacy contract.
 *    · brainstorm · the scaffold must carry the brainstorm shape:
 *      `openingHook` filled AND ≥ 2 `adjacentAngles` AND ≥ 2
 *      `worthChasing`. Decision-grade fields (bottomLine / thesis /
 *      headlineFindings / recommendations / etc.) are explicitly
 *      ALLOWED to be empty — the brainstorm Stage 2 prompt instructs
 *      the LLM to leave them at zero values.
 *
 *  Substitute fields (`thesis`, `bigIdeas`, `theBet`) are net-additive
 *  in any mode: the parser returns them when filled and `null` otherwise.
 *  The renderer's "skip if empty" rules do the rest.
 */
export function parseScaffold(
  raw: string,
  fallbackTitle: string,
  fallbackOriginalQuestion: string,
  mode: string = "constructive",
): BriefScaffold | null {
  const parsed = extractJson<Record<string, unknown>>(raw);
  if (!parsed) return null;

  const title = typeof parsed.title === "string" && parsed.title.trim()
    ? parsed.title.trim()
    : fallbackTitle;

  const isBrainstorm = mode === "brainstorm";
  const isCritique = mode === "critique";

  // Anchor · at minimum one of bottomLine / thesis / workingHypothesis.
  const bottomLine = parseBottomLine(parsed.bottomLine, title);
  const thesis = parseThesis(parsed.thesis);
  const workingHypothesis = parseWorkingHypothesis(parsed.workingHypothesis);

  // Brainstorm-specific fields · parsed regardless of mode (the field
  // is optional on BriefScaffold), but only required-validated when
  // mode === "brainstorm".
  const openingHook = parseOpeningHook(parsed.openingHook);
  const opportunityShape = parseOpportunityShape(parsed.opportunityShape);
  const adjacentAngles = parseAdjacentAngles(parsed.adjacentAngles);
  const whatIfThisWorks = parseWhatIfThisWorks(parsed.whatIfThisWorks);
  const worthChasing = parseWorthChasing(parsed.worthChasing);
  const deadEndsNoted = parseDeadEndsNoted(parsed.deadEndsNoted);
  const brainstormQuestions = parseBrainstormQuestions(parsed.brainstormQuestions);

  // Critique-specific fields · parsed regardless of mode, only
  // required-validated when mode === "critique".
  const deliverableSummary = parseDeliverableSummary(parsed.deliverableSummary);
  const whatsGood = parseWhatsGood(parsed.whatsGood);
  const qualityIssues = parseQualityIssues(parsed.qualityIssues);
  const severityRankedFixes = parseSeverityRankedFixes(parsed.severityRankedFixes);
  const residualRisks = parseResidualRisks(parsed.residualRisks);

  if (isBrainstorm) {
    // Brainstorm contract: opening-hook + ≥2 adjacent-angles + ≥2
    // worth-chasing.
    if (!openingHook) return null;
    if (adjacentAngles.length < 2) return null;
    if (worthChasing.length < 2) return null;
  } else if (isCritique) {
    // Critique contract: deliverable-summary + whats-good (≥2) +
    // quality-issues OR severity-ranked-fixes (≥2 entries on whichever
    // is filled). "What's good" before issues is enforced by the
    // writer prompt's render order — at parse time we just need the
    // shape to be load-bearing.
    if (!deliverableSummary) return null;
    if (whatsGood.length < 2) return null;
    if (qualityIssues.length < 2 && severityRankedFixes.length < 2) return null;
  } else {
    // Decision/constructive contract: anchor + findings.
    const hasAnchor =
      (bottomLine.judgement && bottomLine.judgement.trim().length > 0) ||
      (thesis && thesis.claim.length > 0) ||
      (workingHypothesis && workingHypothesis.hypothesis.length > 0);
    if (!hasAnchor) return null;
  }

  // Findings · either headlineFindings (≥1) or bigIdeas (=3) for
  // decision-grade rooms. Brainstorm and critique rooms skip this gate.
  const findingsRaw = Array.isArray(parsed.headlineFindings) ? parsed.headlineFindings : [];
  const headlineFindings: HeadlineFinding[] = [];
  for (const f of findingsRaw) {
    const parsedF = parseHeadlineFinding(f);
    if (parsedF) headlineFindings.push(parsedF);
    if (headlineFindings.length >= 3) break;
  }
  const bigIdeas = parseBigIdeas(parsed.bigIdeas);
  if (!isBrainstorm && !isCritique && headlineFindings.length < 1 && !bigIdeas) return null;

  // Action substitutes are all best-effort — having none is allowed (the
  // composer may have skipped action entirely for an essay-style brief).
  const theBet = parseTheBet(parsed.theBet);
  const considerations = parseRecommendations(parsed.considerations);
  const considerationsField: Recommendation[] | null = considerations.length ? considerations : null;
  const whyNow = parseWhyNow(parsed.whyNow);
  const twoPaths = parseTwoPaths(parsed.twoPaths);

  return {
    title,
    bottomLine,
    thesis,
    workingHypothesis,
    frameShift: parseFrameShift(parsed.frameShift, fallbackOriginalQuestion),
    headlineFindings,
    bigIdeas,
    convergence: parseConvergence(parsed.convergence),
    divergence: parseDivergence(parsed.divergence),
    positions: parsePositions(parsed.positions),
    visuals: parseVisuals(parsed.visuals),
    twoPaths,
    whyNow,
    recommendations: parseRecommendations(parsed.recommendations),
    theBet,
    considerations: considerationsField,
    preMortem: parsePreMortem(parsed.preMortem),
    newQuestions: parseNewQuestions(parsed.newQuestions),
    planningAssumption: parsePlanningAssumption(parsed.planningAssumption),
    strategicOutlook: parseStrategicOutlook(parsed.strategicOutlook),
    criticalAssumptions: parseCriticalAssumptions(parsed.criticalAssumptions),
    scenarioTree: parseScenarioTree(parsed.scenarioTree),
    leadingIndicators: parseLeadingIndicators(parsed.leadingIndicators),
    threatsToValidity: parseThreatsToValidity(parsed.threatsToValidity),
    metricStrip: parseMetricStrip(parsed.metricStrip),
    // Brainstorm-mode fields · null in non-brainstorm rooms (the parsers
    // return empty arrays / null for missing input, which we collapse to
    // null here so the scaffold body_json column doesn't carry empty
    // brainstorm fields for decision-grade briefs).
    openingHook,
    opportunityShape,
    adjacentAngles: adjacentAngles.length ? adjacentAngles : null,
    whatIfThisWorks,
    worthChasing: worthChasing.length ? worthChasing : null,
    deadEndsNoted: deadEndsNoted.length ? deadEndsNoted : null,
    brainstormQuestions: brainstormQuestions.length ? brainstormQuestions : null,
    // Critique-mode fields · null in non-critique rooms.
    deliverableSummary,
    whatsGood: whatsGood.length ? whatsGood : null,
    qualityIssues: qualityIssues.length ? qualityIssues : null,
    severityRankedFixes: severityRankedFixes.length ? severityRankedFixes : null,
    residualRisks: residualRisks.length ? residualRisks : null,
    openQuestions: parseOpenQuestions(parsed.openQuestions),
  };
}
