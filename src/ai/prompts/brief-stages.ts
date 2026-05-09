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

/** Per-director asset bundle. Replaces the legacy 2-4 signals shape
 *  with 9 typed fields so the composer / scaffold writer can see what
 *  KIND of material the room produced and pick / fill components
 *  accordingly. Every field is a (possibly empty) array — directors
 *  who produced no quote, no risk, no tension simply return [] for
 *  those fields. The schema is the single source of truth that flows
 *  through the whole pipeline (Stage 1 extract → composer → scaffold
 *  → writer). */
export interface DirectorAssets {
  directorId: string;
  directorName: string;
  /** Load-bearing claims this director made. Each carries a lens tag
   *  + sources (indices into own message list) + optional confidence. */
  claims: AssetClaim[];
  /** Concrete material the director introduced: data points, named
   *  cases, verbatim quotes pulled in from outside the room. */
  evidence: AssetEvidence[];
  /** Where this director pushed back on or differed from another
   *  director. `with` lists the director ids implicated; empty array
   *  means tension is with the framing / user, not another director. */
  tensions: AssetTension[];
  /** Foundational beliefs the director's reasoning rests on. Optional
   *  falsifier names what would prove the assumption wrong. */
  assumptions: AssetAssumption[];
  /** Risks / failure modes the director raised, with optional severity. */
  risks: AssetRisk[];
  /** Opportunities or upside the director identified. */
  opportunities: AssetOpportunity[];
  /** Action proposals from this director, with optional owner /
   *  horizon when stated. */
  actions: AssetAction[];
  /** Memorable verbatim phrasings worth preserving as pull quotes —
   *  the director's OWN words, not paraphrases of someone else. */
  quotes: AssetQuote[];
  /** Open questions this director surfaced or pushed on, tagged with
   *  P0 / P1 / P2 priority. */
  openQuestions: AssetOpenQuestion[];
}

/** Sources are 0-based indices into the director's own message list.
 *  Every asset entry carries at least one source so downstream stages
 *  can cite back to the originating turn. */
interface AssetSourceRef {
  sources: number[];
}

export interface AssetClaim extends AssetSourceRef {
  text: string;
  lens: EvidenceLens;
  confidence?: Confidence;
}

export interface AssetEvidence extends AssetSourceRef {
  text: string;
  /** Material kind:
   *    · `data` — number / metric / statistic
   *    · `case` — named precedent / example / story
   *    · `quote` — verbatim phrasing from outside the room */
  kind: "data" | "case" | "quote";
}

export interface AssetTension extends AssetSourceRef {
  text: string;
  /** Director ids the tension is *with*. Empty = tension with the
   *  user / framing rather than another director. */
  with: string[];
}

export interface AssetAssumption extends AssetSourceRef {
  text: string;
  falsifier?: string;
}

export interface AssetRisk extends AssetSourceRef {
  text: string;
  severity?: "high" | "medium" | "low";
}

export interface AssetOpportunity extends AssetSourceRef {
  text: string;
}

export interface AssetAction extends AssetSourceRef {
  text: string;
  owner?: string;
  horizon?: string;
}

export interface AssetQuote extends AssetSourceRef {
  text: string;
}

export interface AssetOpenQuestion extends AssetSourceRef {
  text: string;
  priority: "P0" | "P1" | "P2";
}

/** Per-field caps · keep individual fields bounded so a runaway
 *  director (extracting 50 claims in a single pass) can't blow Stage 2's
 *  context. Caps are enforced by the parser, not the prompt — overflow
 *  is dropped quietly after the per-field limit. Sum of all caps = 38,
 *  so a fully-loaded director adds at most that many entries to the
 *  pipeline. Realistically most directors land in 8-20 total. */
export const ASSET_CAPS = {
  claims: 6,
  evidence: 6,
  tensions: 4,
  assumptions: 4,
  risks: 4,
  opportunities: 3,
  actions: 4,
  quotes: 3,
  openQuestions: 4,
} as const;

/** Sum of every asset entry across the 9 fields. Used by the composer
 *  to size density caps + by the scaffold writer to size content. */
export function countAssets(a: DirectorAssets): number {
  return (
    a.claims.length + a.evidence.length + a.tensions.length +
    a.assumptions.length + a.risks.length + a.opportunities.length +
    a.actions.length + a.quotes.length + a.openQuestions.length
  );
}

/** Transitional adapter · flattens a `DirectorAssets` bundle into the
 *  legacy `DirectorSignals` shape that Stage 2 / Stage 3 still consume.
 *  Each asset entry's KIND is encoded as a bracket prefix in the
 *  signal `text` (e.g. `[risk·high] foo`, `[claim] bar`) so the
 *  scaffold writer sees what kind of material it's citing without
 *  needing to handle the new schema directly. Field order is stable
 *  across regenerations: claims → evidence → tensions → assumptions
 *  → risks → opportunities → actions → quotes → openQuestions. The
 *  flattened index (used in `directorId#N` citations) is therefore
 *  reproducible.
 *
 *  Phase 1 boundary helper · Phase 2 will replace it by rewriting the
 *  scaffold prompt to consume assets natively. */
export function assetsToSignals(a: DirectorAssets): DirectorSignals {
  const signals: ExtractedSignal[] = [];
  for (const c of a.claims) {
    signals.push({ text: `[claim] ${c.text}`, lens: c.lens, sources: c.sources });
  }
  for (const e of a.evidence) {
    const lens: EvidenceLens =
      e.kind === "data" ? "data" :
      e.kind === "quote" ? "narrative" : "narrative";
    signals.push({ text: `[evidence·${e.kind}] ${e.text}`, lens, sources: e.sources });
  }
  for (const t of a.tensions) {
    const withTag = t.with.length ? ` w/ ${t.with.join("+")}` : "";
    signals.push({ text: `[tension${withTag}] ${t.text}`, lens: "dissent", sources: t.sources });
  }
  for (const u of a.assumptions) {
    const falsTag = u.falsifier ? ` · falsifier: ${u.falsifier}` : "";
    signals.push({ text: `[assumption${falsTag}] ${u.text}`, lens: "structural", sources: u.sources });
  }
  for (const r of a.risks) {
    const sevTag = r.severity ? `·${r.severity}` : "";
    signals.push({ text: `[risk${sevTag}] ${r.text}`, lens: "structural", sources: r.sources });
  }
  for (const o of a.opportunities) {
    signals.push({ text: `[opportunity] ${o.text}`, lens: "structural", sources: o.sources });
  }
  for (const ac of a.actions) {
    const ownerTag = ac.owner ? `·${ac.owner}` : "";
    const horizonTag = ac.horizon ? `·${ac.horizon}` : "";
    signals.push({ text: `[action${ownerTag}${horizonTag}] ${ac.text}`, lens: "structural", sources: ac.sources });
  }
  for (const q of a.quotes) {
    signals.push({ text: `[quote] ${q.text}`, lens: "narrative", sources: q.sources });
  }
  for (const oq of a.openQuestions) {
    signals.push({ text: `[open-q·${oq.priority}] ${oq.text}`, lens: "first-principle", sources: oq.sources });
  }
  return { directorId: a.directorId, directorName: a.directorName, signals };
}

/** Legacy flat signal shape · still consumed by Stage 2 (scaffold) and
 *  Stage 3 (writer). Phase 1 keeps it alive as the boundary type
 *  produced by `assetsToSignals()`. The text carries asset-kind
 *  prefixes so the downstream prompts get the kind information for
 *  free without needing schema changes. */
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
  /** What acting on this earns · the upside / payoff stated as a
   *  concrete benefit, not a metric to watch. Distinct from
   *  `successMetric` (observable proof) and `rationale` (why this
   *  works) — this is "what you GET if you do this" stated for a
   *  decision-maker who needs to justify the investment. Empty/
   *  undefined on legacy scaffolds. */
  expectedBenefit?: string;
}

/** Risk-register item · 3-7 standing risks the operating environment
 *  poses. Includes both environmental risks (whether or not we act)
 *  and concrete recommendation-failure modes when the room surfaced
 *  them as load-bearing. severity + likelihood are independent axes;
 *  owner is who watches it (functional / role, not a person name);
 *  mitigation is the playbook if the risk materialises.
 *
 *  (Replaced the older `FailureMode` / `pre-mortem` section · its
 *  scenario / leading-indicator / mitigation shape collapses cleanly
 *  into a risk-register row when the room's failure-mode signals
 *  warrant a Risk Register at all.) */
export type RiskCategory =
  | "market"      // demand / competition / regulation / macro
  | "execution"   // build / launch / scale / hiring
  | "product"     // user-experience / quality / scope creep
  | "team"        // capacity / morale / key-person / coordination
  | "financial"   // burn / runway / pricing / unit economics
  | "compliance"  // legal / privacy / certification
  | "technical";  // architecture / debt / security / reliability
export type RiskSeverity = "high" | "medium" | "low";
export type RiskLikelihood = "high" | "medium" | "low";
export interface RiskItem {
  /** One-sentence risk statement. ≤ 180 chars. */
  risk: string;
  /** Category drives the icon / colour band; pick the closest. */
  category: RiskCategory;
  /** Impact if it lands. */
  severity: RiskSeverity;
  /** Probability over the brief's planning horizon (≈12-18 months). */
  likelihood: RiskLikelihood;
  /** Functional owner who watches this risk · role label, not a name.
   *  Examples: "product", "ops", "legal", "founders", "hiring lead". */
  owner: string;
  /** Concrete mitigation playbook if the risk fires · ≤ 220 chars.
   *  When the room had no clear mitigation, set to "monitor only" so
   *  the renderer surfaces it explicitly rather than rendering blank. */
  mitigation: string;
}

/** Structured comparison of N candidate options the room weighed ·
 *  shared criteria across all options, plus per-option pros / cons,
 *  with one option flagged as the room's recommended pick. Distinct
 *  from `comparison-table` (which is a raw matrix the writer assembles
 *  ad-hoc) and `two-paths` (binary trajectory comparison). Used when
 *  the room said "we considered options A, B, C and recommend B
 *  because…". 2-5 options. */
export interface DecisionOption {
  /** Short label · ≤ 32 chars (e.g. "Build in-house", "Acquire", "Wait"). */
  label: string;
  /** One-sentence summary of the option. ≤ 200 chars. */
  summary: string;
  /** 2-4 pros · each a short clause ≤ 80 chars. */
  pros: string[];
  /** 2-4 cons · each a short clause ≤ 80 chars. */
  cons: string[];
  /** Estimated effort to pursue this option. */
  effort: "low" | "medium" | "high";
  /** Confidence the option pays off if pursued. */
  confidence: Confidence;
  /** True only on the option the room recommends. EXACTLY ONE option
   *  in the array should have `recommended: true`; the renderer marks
   *  it with a "Recommended" badge. */
  recommended: boolean;
}
export interface DecisionOptionsBlock {
  /** Optional one-sentence framing for the comparison. ≤ 200 chars. */
  intro: string;
  /** 2-5 options. The recommended option (`recommended: true`) is
   *  rendered first regardless of array order. */
  options: DecisionOption[];
  /** Why the recommended option wins · ≤ 280 chars. Anchors the
   *  reader's takeaway and connects this section to recommendations. */
  rationale: string;
}

/** Director-perspectives comparison · MANDATORY in every brief with
 *  ≥ 2 active directors. The component renders a "social map" of the
 *  room: every director's stance + position + optional verbatim quote,
 *  grouped by where they aligned and where they split, with the
 *  chair's structural observation closing the block. Distinct from:
 *    · `convergence` — narrow structural insight (≥2 directors hit
 *      the same conclusion via independent lenses; not every director
 *      has to appear).
 *    · `divergence` — the SINGLE central tension (one fork, not a
 *      multi-axis comparison).
 *    · `positions` — 2-3 named camps with a pull-quote per camp; less
 *      structured than this component's per-director rows.
 *  views-compared is the bird's-eye view: every active director gets
 *  a row, alignment / divergence groups are explicit, the chair's
 *  meta-observation closes it. Reading just this section tells a
 *  stakeholder who was in the room and where each one stood. */
export interface DirectorPerspective {
  /** Director id from the room's member list. Required. */
  directorId: string;
  /** ≤ 60 chars · short label of this director's angle on the topic
   *  (e.g. "Sees this as a moat play", "Reads it as distribution
   *  leverage", "Frames it as a regulatory-window question"). */
  stance: string;
  /** 1-2 sentences (≤ 300 chars) · the director's load-bearing
   *  position. Should read as their argument, not the chair's
   *  paraphrase. */
  position: string;
  /** Optional verbatim phrase from the director (≤ 40 words). Empty
   *  when no memorable verbatim is available. Rendered as italic
   *  pull-quote next to the position. */
  quote: string;
  /** The lens this director argued from. Helps the reader see WHY
   *  two directors disagree (different lenses) or agree (independent
   *  paths to same conclusion). */
  lens: EvidenceLens;
}
export interface PerspectiveAlignment {
  /** Short name for what this group converges on. ≤ 80 chars. */
  pointOfAgreement: string;
  /** Director ids in this group · ≥ 2. */
  directorIds: string[];
  /** ≤ 220 chars · why this convergence is structurally meaningful
   *  (independent paths, contrarian agreement, etc.). */
  note: string;
}
export interface PerspectiveDivergence {
  /** The hinge that separates the directors. ≤ 140 chars. */
  hinge: string;
  /** 2-3 sides · each side has a label, the directors on that side,
   *  and a 1-sentence stance. */
  sides: { label: string; directorIds: string[]; stance: string }[];
  /** What would resolve the split · ≤ 220 chars. Empty when the
   *  divergence remains unresolved. */
  resolution: string;
}
export interface DirectorPerspectivesBlock {
  /** Optional one-sentence intro framing the comparison. ≤ 200 chars. */
  intro: string;
  /** Groups of directors who arrived at similar conclusions. Each
   *  group ≥ 2 directors. ≥ 0 groups (all-divergence rooms have 0). */
  alignment: PerspectiveAlignment[];
  /** Where directors split. Most rooms have 0-1 entries; complex
   *  rooms can have 2 (multi-axis disagreement). */
  divergence: PerspectiveDivergence[];
  /** EVERY active director gets one entry, no exceptions. The reader
   *  should see all participants accounted for in their own row. */
  perspectives: DirectorPerspective[];
  /** The chair's synthesis · 2-4 sentences (≤ 400 chars). What the
   *  chair takes away from comparing the views. Moderator-neutral
   *  voice — observation, not advocacy. */
  chairSynthesis: string;
}

/** Side-by-side structural comparison · ALWAYS exactly 2 paths, each
 *  carrying a verdict tag (\"structurally fragile\" / \"plausibly
 *  defensible\") and 4-6 characteristic bullets. The component's hinge
 *  is a binary choice the room argued — replacement vs augmentation,
 *  vertical vs horizontal, build vs partner — where one trajectory
 *  is structurally weaker than the other. The accent colour visualises
 *  the verdict immediately (clay / red for weak, sage / green for
 *  strong) so a reader sees the shape of the room's judgment without
 *  reading the bullets. Distinct from:
 *    · `two-paths` (binary trajectories, but PROSE-only — no bullet
 *      structure, no verdict tags, no accent encoding)
 *    · `decision-options` (2-5 options with pros/cons and one recommended
 *      flag, no structural-weakness framing)
 *    · `force-field` (one outcome with drivers vs resistors, not two
 *      named paths)
 *  Reference design: anthropic-essay's "03 — A Comparison" block. */
export interface ComparisonPath {
  /** Verdict tag · short clause that carries the room's judgment in
   *  2-5 words. Examples: \"structurally fragile\" / \"plausibly
   *  defensible\" / \"high-conviction\" / \"speculative\" / \"the
   *  obvious bet\" / \"the contrarian read\". ≤ 40 chars. Rendered
   *  as a mono-uppercase tag in the path's accent colour. */
  verdict: string;
  /** Stance drives the accent colour and bullet marker:
   *    · \"strong\"  — sage / green / supportive accent
   *    · \"weak\"    — clay / red / cautioning accent
   *    · \"neutral\" — rule colour, no verdict accent (used when both
   *                    paths are presented without a structural pick)
   *  At most one path should be \"strong\" and at most one \"weak\".
   *  Two \"neutral\" paths are valid (the room laid out both without
   *  taking a side). */
  stance: "weak" | "strong" | "neutral";
  /** Path name · serif headline. Can be a single phrase or two phrases
   *  joined with \" · \" or a `\\n` for label + sublabel. ≤ 90 chars. */
  name: string;
  /** 4-6 bullet characteristics · what makes this path what it is.
   *  Each ≤ 110 chars. NOT pros/cons — these are characteristics that
   *  collectively describe the path's structural fit (\"HR procurement
   *  resists tools positioned as threat\" / \"product-led embedding
   *  compresses sales cycles\"). The bullets read as evidence FOR the
   *  verdict tag. */
  characteristics: string[];
}
export interface PathComparisonBlock {
  /** Optional one-sentence framing for the comparison. ≤ 200 chars.
   *  Names what the binary choice is about (e.g. \"the choice between
   *  framing the product as replacement vs augmentation\"). */
  intro: string;
  /** EXACTLY 2 paths · the component is binary by design. The first
   *  is rendered LEFT, the second RIGHT. Stance drives accent colour
   *  but doesn't reorder the array. */
  paths: [ComparisonPath, ComparisonPath];
  /** Optional implication line · ≤ 220 chars. Anchors the comparison
   *  to its downstream consequence (e.g. \"It propagates through every
   *  subsequent decision\"). Rendered after both columns as a single
   *  italic sentence in the spine's body voice. */
  implication?: string;
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
 *  the brief itself could be wrong. Distinct from `risk-register`
 *  (operating-environment risks the room raised) and from
 *  `critical-assumptions` (the foundational assumptions the brief
 *  rests on, which carry confidence + falsifier). A threat-to-validity
 *  names a way the *analysis* could be misleading: selection bias,
 *  sample of N, lens blind spot, generalizability ceiling, confounding
 *  factor. Each has
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

/* ──────────────────────── Bento scaffold ───────────────────────────
 * Single-page infographic alternative to the markdown research note.
 * Fixed shape (no composer · no substitute groups) so the renderer can
 * lay out a deterministic 8-slot grid:
 *   · header band     (title · kicker · source line)
 *   · 3 milestones    (left column · vertical timeline · period · title
 *                      · 2-3 sentence body · big-number callout · tags)
 *   · ranked bars     (right column top · 3-5 named entries with ratios)
 *   · verification    (right column mid · 3-5 single-sentence bullets)
 *   · talking points  (right column bottom · 3-5 elevator-pitch lines)
 *   · conclusion      (bottom band · one-line takeaway)
 *   · flow diagram    (optional inline arrow chain · "before → after"
 *                      or "10× → 10×" · 2-4 nodes)
 *   · footer tag      (mono caption right-aligned at the bottom)
 *
 * The bento writer fills these slots in a SINGLE chair-LLM call (Stage
 * 2 produces the structured JSON; Stage 3 is deterministic templating).
 * The bento body is intentionally lossy — the room's full discussion
 * compresses into the highest-signal claims, big numbers, and the one
 * thing that actually changes a reader's call. This is by design: the
 * research-note path remains for users who want the full memo. */
export interface BentoScaffold {
  /** Hero headline · serif, 1 line · the room's takeaway in claim form. */
  title: string;
  /** Italic deck under the title · 1 sentence · the angle / what's new. */
  kicker: string;
  /** Mono small-caps source line · "from {chair name} · {date}" or
   *  similar. Auto-filled from room metadata when the LLM doesn't set
   *  one. */
  source: string;
  /** EXACTLY 3 milestones, ordered chronologically or by importance.
   *  Vertical-timeline cards on the left side of the bento. */
  milestones: BentoMilestone[];
  /** Optional · top-right · 3-5 ranked entries with ratio bars.
   *  Renders only when the room produced quantifiable comparisons. */
  rankedBars: BentoRankedBars | null;
  /** Optional · mid-right · 3-5 verification bullets · the validation
   *  signals that, if observed, would confirm the takeaway. Maps from
   *  convergence + leading indicators material. */
  verification: BentoVerification | null;
  /** ALWAYS rendered · bottom-right · 3-5 talking-point bullets · the
   *  elevator-pitch sentences a reader could use to brief a colleague.
   *  Maps from recommendations and bottom-line, collapsed to single
   *  declarative sentences. */
  talkingPoints: BentoTalkingPoints;
  /** Bottom band · one-line conclusion · ≤ 80 chars · the takeaway
   *  collapsed to a single sentence the reader walks away with. */
  conclusion: string;
  /** Optional flow diagram inline next to the conclusion · 2-4 nodes
   *  joined by arrows · "before → after" or "step 1 → step 2 → step 3".
   *  Skipped when no clean transformation arc exists. */
  flow: BentoFlow | null;
  /** Footer mono tag · "{room subject short} · {time horizon}" or
   *  similar. Auto-filled from room metadata when the LLM doesn't
   *  set one. */
  footerTag: string;
}

export interface BentoMilestone {
  /** Time / phase tag · "2025H2" · "Q1 2026" · "Phase 2" · ≤ 24 chars. */
  period: string;
  /** Card headline · ≤ 60 chars · the milestone's name. */
  title: string;
  /** 2-3 sentence body explaining what happened / will happen. ≤ 220 chars. */
  body: string;
  /** Big-number callout · ≤ 12 chars · the metric / multiplier / count
   *  that anchors the milestone visually. e.g. "-10×", "2000万颗",
   *  "$120M ARR", "T+90". Empty string when no clean numeric anchor
   *  exists — the card renders without the gold-callout slot. */
  callout: string;
  /** Optional 0-4 short tags rendered as chips (entity names, owners,
   *  domains). ≤ 16 chars each. */
  tags: string[];
}

export interface BentoRankedBars {
  /** Card title · ≤ 40 chars. */
  title: string;
  /** 3-5 entries, sorted in render order. Each ratio is normalized
   *  0-1 by the writer (e.g. "1.0 / 0.1 / 0.01"). The renderer paints
   *  bars proportional to ratio. */
  entries: Array<{
    /** Bar label · ≤ 40 chars. */
    label: string;
    /** Display value · ≤ 20 chars · "1.0×" / "$45M" / "23%". */
    value: string;
    /** Normalized 0-1 for bar width. */
    ratio: number;
  }>;
}

export interface BentoVerification {
  /** Card title · ≤ 40 chars. */
  title: string;
  /** 3-5 single-sentence bullets · ≤ 140 chars each. */
  bullets: string[];
}

export interface BentoTalkingPoints {
  /** Card title · default "How to say this" / "口播提纲" · spine-style. */
  title: string;
  /** 3-5 elevator-pitch sentences · ≤ 120 chars each. */
  bullets: string[];
}

export interface BentoFlow {
  /** Inline arrow chain · 2-4 nodes joined by "→" at render time. */
  nodes: string[];
  /** Optional caption under the arrow chain · ≤ 60 chars. */
  caption?: string;
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
  /** Director-perspectives comparison · MANDATORY in every brief with
   *  ≥ 2 active directors. NOT a composer-picked optional component —
   *  always populated by Stage 2 and always rendered by Stage 3 (skip
   *  only when there's exactly 1 active director, in which case
   *  `perspectives` will have ≤ 1 entry and the writer drops the
   *  section). The "social map" of the room. */
  directorPerspectives: DirectorPerspectivesBlock | null;
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
   *  risk-register (operating-environment risks) and critical-assumptions
   *  (the foundations the brief rests on). Set when the composer picks
   *  the `threats-to-validity` component. */
  threatsToValidity?: ThreatToValidity[] | null;
  /** 3-7 standing risks the room surfaced · operating environment +
   *  recommendation-failure modes (the latter folded in here after
   *  the older `pre-mortem` slot was retired). Surfaces the risk
   *  landscape with severity × likelihood × owner × mitigation. Set
   *  when the composer picks the `risk-register` component. */
  riskRegister?: RiskItem[] | null;
  /** Structured N-option comparison · used when the room weighed 2-5
   *  named options and recommended one. Distinct from `comparison-table`
   *  (raw matrix · column-and-row freeform) and `two-paths` (binary
   *  trajectory). Set when the composer picks the `decision-options`
   *  component. */
  decisionOptions?: DecisionOptionsBlock | null;
  /** Side-by-side binary structural comparison · 2 paths with verdict
   *  tags + characteristic bullets, accent-colour-coded by stance.
   *  Set when the composer picks the `path-comparison` component.
   *  Structurally distinct from `two-paths` (prose-only) and
   *  `decision-options` (N options + pros/cons + recommended flag);
   *  this component carries the room's *structural* read — which
   *  trajectory is fragile vs viable. */
  pathComparison?: PathComparisonBlock | null;
  /** Dashboard-style KPI / indicator strip · 3-5 number cards that
   *  carry the room's quantitative reads side-by-side. Set when the
   *  composer picks the `metric-strip` component. Distinct from
   *  `visuals` (which holds discrete options-comparison artefacts) —
   *  metric-strip is "by the numbers", visuals is "by the options". */
  metricStrip?: MetricStrip | null;
  /** Appendices · supplementary detail too dense for the main body
   *  (verbatim quotes >80 words, raw signal extracts, supporting
   *  calculations, source chains). Each appendix is a titled block
   *  rendered AFTER methodology, with `page-break-before` in print.
   *  Used sparingly — most briefs have none. Set only when the
   *  scaffold writer judges that the body would suffer from carrying
   *  the material inline. */
  appendices?: AppendixItem[] | null;
  // ── Residual ──
  openQuestions: OpenQuestion[];
}

/** Section-level appendix item. The body is markdown — quotes,
 *  bullets, tables all render normally. Title becomes `## Appendix
 *  A: {title}` with the letter auto-assigned in render order. */
export interface AppendixItem {
  /** Short label · 4–10 words · "Verbatim director exchange on the
   *  pricing question" / "Source chain for the 60% capture estimate". */
  title: string;
  /** Markdown body · paragraphs, blockquotes, tables, lists allowed. */
  bodyMd: string;
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
    `Your job: re-read your own contributions to a boardroom session and surface a structured asset bundle for the report — every kind of material worth preserving, by category. Do NOT collapse to a flat 2–4 signal list anymore; the report writer needs to see what KIND of material you brought (claim vs evidence vs risk vs question) so it can place each one in the right section.`,
    ``,
    `## Walk every asset field once. Empty arrays are correct when you raised no material of that kind`,
    ``,
    `Walking through your messages, capture every relevant entry per field. If you raised no risks, return \`"risks": []\`. If you didn't propose actions, return \`"actions": []\`. **Empty arrays are CORRECT** — do not fabricate to fill a field.`,
    ``,
    `## Asset fields`,
    ``,
    `· **claims** — load-bearing claims you made (the takeaways you stand behind). Each: \`{ "text": "...", "lens": "data|dissent|narrative|structural|first-principle", "sources": [...], "confidence": "high|medium|low" (optional) }\`. Up to 6.`,
    ``,
    `· **evidence** — concrete material you brought IN to the room: data points, named cases, verbatim quotes from outside. Distinct from claims (which interpret evidence). Each: \`{ "text": "...", "kind": "data|case|quote", "sources": [...] }\`. Up to 6.`,
    ``,
    `· **tensions** — places you pushed back on or differed from another director. Each: \`{ "text": "...", "with": [directorId, ...], "sources": [...] }\`. Use \`"with": []\` when the tension is with the framing / user rather than a director. Up to 4.`,
    ``,
    `· **assumptions** — foundational beliefs your reasoning rests on (often unstated). Each: \`{ "text": "...", "falsifier": "what would prove this wrong" (optional), "sources": [...] }\`. Up to 4.`,
    ``,
    `· **risks** — failure modes / downsides you raised. Each: \`{ "text": "...", "severity": "high|medium|low" (optional), "sources": [...] }\`. Up to 4.`,
    ``,
    `· **opportunities** — upside / openings you named that the room should chase. Each: \`{ "text": "...", "sources": [...] }\`. Up to 3.`,
    ``,
    `· **actions** — concrete moves you proposed. Each: \`{ "text": "...", "owner": "..." (optional), "horizon": "..." (optional · e.g. "30 days"), "sources": [...] }\`. Up to 4.`,
    ``,
    `· **quotes** — your own memorable lines worth pull-quoting in the report. Verbatim, not paraphrase. Each: \`{ "text": "...", "sources": [...] }\`. Up to 3.`,
    ``,
    `· **openQuestions** — questions you surfaced or pushed on, tagged with priority. Each: \`{ "text": "...", "priority": "P0|P1|P2", "sources": [...] }\`. Up to 4.`,
    ``,
    `## Lens tags (used in claims field)`,
    ``,
    `· \`data\`           — empirical data point, number, or named precedent`,
    `· \`dissent\`        — a counterexample or pushback against a default view`,
    `· \`narrative\`      — a story or analogy that makes the point land`,
    `· \`structural\`     — a system / mechanism / second-order argument`,
    `· \`first-principle\` — a derivation from foundational truths`,
    ``,
    `## Output format`,
    ``,
    `Strict JSON inside a fenced \`\`\`json code block. No prose outside the block. All 9 fields MUST be present (use \`[]\` for fields with no material).`,
    ``,
    `\`\`\`json`,
    `{`,
    `  "claims": [`,
    `    { "text": "Short 1–2 sentence claim in your voice.", "lens": "dissent", "sources": [0, 2], "confidence": "medium" }`,
    `  ],`,
    `  "evidence": [`,
    `    { "text": "GMV declined 23% Q3 against a 7% category baseline.", "kind": "data", "sources": [3] }`,
    `  ],`,
    `  "tensions": [`,
    `    { "text": "Long Horizon framed this as a moat play; I read it as distribution leverage.", "with": ["long-horizon"], "sources": [4] }`,
    `  ],`,
    `  "assumptions": [`,
    `    { "text": "We assume regulator timing slips by ≥2 quarters.", "falsifier": "FTC files before March", "sources": [5] }`,
    `  ],`,
    `  "risks": [`,
    `    { "text": "Channel concentration on 2 platforms creates fragility.", "severity": "high", "sources": [6] }`,
    `  ],`,
    `  "opportunities": [`,
    `    { "text": "Underserved mid-market segment if we relax the enterprise-only stance.", "sources": [7] }`,
    `  ],`,
    `  "actions": [`,
    `    { "text": "Run a 30-day pilot on the API-only tier.", "owner": "product", "horizon": "30 days", "sources": [8] }`,
    `  ],`,
    `  "quotes": [`,
    `    { "text": "The defensibility lives in the data flywheel, not the UI.", "sources": [2] }`,
    `  ],`,
    `  "openQuestions": [`,
    `    { "text": "What turns model-quality lead into a moat at our scale?", "priority": "P0", "sources": [3, 5] }`,
    `  ]`,
    `}`,
    `\`\`\``,
    ``,
    `Constraints:`,
    `· Every entry's \`sources\` array is non-empty (cite at least one of your messages by 0-based index).`,
    `· "text" is in your own voice, not third-person paraphrase. Each entry max 60 words.`,
    `· If you said nothing in this room, return all 9 fields as \`[]\` (empty bundle, still valid JSON).`,
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
        `Your messages in this room (indexed · cite by these indices in every \`sources\` array):`,
        ``,
        myMessages || "(you said nothing)",
        ``,
        `Walk every asset field. Empty arrays are correct when no material exists for a field. JSON only.`,
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
  "## Signal kind tags",
  "",
  "Each signal in the SIGNALS block carries a bracket prefix that names the KIND of material the director extracted: `[claim]`, `[evidence·data|case|quote]`, `[tension]`, `[assumption]`, `[risk·high|medium|low]`, `[opportunity]`, `[action·owner·horizon]`, `[quote]`, `[open-q·P0|P1|P2]`. **Use these tags to place each signal in the right scaffold section** — `[risk]` material belongs in `risk-register` or `threats-to-validity`, NOT in headline-findings; `[action]` belongs in `recommendations` or `the-bet`; `[tension]` belongs in `divergence` or as a tension on a finding; `[open-q]` belongs in `open-questions` or `new-questions`. Treat the tag as a routing hint — the writer who placed it there already classified it.",
  "",
  "## Design philosophy",
  "",
  "A multi-director report's value is **not** a McKinsey report with multiple authors. It is the meta-output the conversation between directors produced — frame shifts, convergent independent reasoning, and questions that did not exist when the room opened. Your scaffold must surface those structurally, not bury them in an appendix.",
  "",
  "## What you must produce — 12 sections",
  "",
  "1. **Title** · 8–18 words (≥ 14 Chinese characters). The title IS a complete-sentence thesis — a reader who hasn't seen the room subject MUST be able to read it standalone and understand what the brief argues. Examples: \"AI dynamic comics will not kill manga but will compress it into a 'clean version' refuge\" / \"为什么飞书的 AI agent 平台终局是责任清算层而不是 SaaS 升级\". Hard FORBIDDEN: 2–3 word slogans (\"The Bet on Workflow\", \"AI 终局\"); abstract noun phrases without verbs (\"On Routing\", \"关于多模态的思考\"); titles that omit the room's actual subject. Name the specific topic + state the actual claim.",
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
  "7b. **Director Perspectives** (`directorPerspectives`) · MANDATORY in every brief with ≥ 2 active directors. The \"social map\" of the room — every active director gets a row, alignment / divergence groups are explicit, the chair's structural observation closes the block. Distinct from convergence (narrow), divergence (single central tension), positions (2-3 camps with quotes). views-compared is the bird's-eye view that lets a stakeholder skim WHO was in the room and where each one stood. Object shape: `{ intro, alignment: [...], divergence: [...], perspectives: [...], chairSynthesis }`. Each entry of `perspectives`: `directorId` (must match the room's member list), `stance` (≤ 60 chars short label of the director's angle), `position` (1-2 sentences ≤ 300 chars · the director's load-bearing argument in their voice), `quote` (optional verbatim ≤ 40 words; empty when no memorable line), `lens` (data | dissent | narrative | structural | first-principle). EVERY active director gets one entry — no exceptions. Each `alignment` group: `pointOfAgreement` (≤ 80 chars), `directorIds` (≥ 2), `note` (≤ 220 chars · why the convergence is structurally interesting · prefer to surface independent paths to same conclusion). Each `divergence` entry: `hinge` (≤ 140 chars · what separates them), `sides` (2-3 named sides; each: label / directorIds / 1-sentence stance), `resolution` (≤ 220 chars · what would settle it; empty when unresolved). `chairSynthesis` (2-4 sentences, ≤ 400 chars) is the chair's meta-observation comparing the views — moderator-neutral voice, observation not advocacy. Set the WHOLE block to `null` ONLY when there's exactly 1 active director (no comparison possible).",
  "",
  "8. **Visuals** · 0–4 blocks. Content-driven. **Strongly prefer mermaid sub-types over text matrices** — mermaid renders as a real diagram readers can scan in seconds; text matrices are dense tables that take paragraphs to absorb. Only fall back to text matrix when the data shape genuinely doesn't fit any mermaid form.",
  "",
  "   Mermaid (preferred):",
  "   · `quadrant-chart`    — items plotted on two real axes (mermaid quadrantChart). Effort/impact, support/strength, urgency/uncertainty.",
  "   · `bar-chart`         — 2–8 named items ranked by ONE quantitative dimension (mermaid xychart-beta · cost / support / size / time)",
  "   · `timeline`          — 3–8 dated points telling a narrative arc (mermaid timeline · retro / historical analogue / projected sequence)",
  "   · `pie-chart`         — 2–6 slices showing a distribution (mermaid pie · scenario probabilities / lens shares / vote tallies / market mix). Numbers can be percentages OR raw counts — mermaid normalises.",
  "",
  "   Text matrices (fall back when no mermaid form fits):",
  "   · `comparison-table`  — ≥ 2 named options compared on shared dimensions",
  "   · `force-field`       — drivers vs resistors of one outcome",
  "   · `strengths-cautions`— strengths / cautions / verdict per option",
  "",
  "   Strong rules (these are routing constraints — disregarding them = a lost visualisation):",
  "   · ANY ranked numeric measure across items → `bar-chart` (NOT comparison-table).",
  "   · ANY chronological sequence ≥ 3 events → `timeline` (NOT a numbered list in prose).",
  "   · ANY distribution that sums (probability split, votes, lens count, market share) → `pie-chart` (NOT a sentence with percentages).",
  "   · ANY 2-axis plot (effort × impact, urgency × confidence) → `quadrant-chart`.",
  "   · ONLY when the data is N-options × M-criteria with mixed cell types (text + numbers + tags) → `comparison-table`.",
  "   · ONLY when the room argued exactly one outcome with for/against forces → `force-field`.",
  "   · ONLY when N options each need a strengths/cautions/verdict triplet AND no numeric ranking → `strengths-cautions`.",
  "   These six routes cover most rooms. Default toward picking 2–3 visuals (one quantitative + one categorical) — the writer is forbidden from emitting only text matrices. Beyond these, the Stage 3 writer also emits inline mermaid (flowchart / mindmap / gantt / sequenceDiagram / stateDiagram / journey) where prose can't carry the structure efficiently — those don't go in the typed `visuals` list, so don't pre-allocate them here.",
  "",
  "9. **Recommendations** · 3–5 concrete actions, each with: `priority` (P0/P1/P2), `action` (imperative), `rationale`, `ownerType`, `horizon` (e.g. \"next 30 days\"), `successMetric` (observable proof of execution), `riskIfSkipped`, `expectedBenefit` (the upside if you act — stated as a concrete payoff, NOT a metric to watch). Recommendations are imperatives — \"Do X\" not \"X should happen\". The `expectedBenefit` is what gets a stakeholder to actually approve the action — it answers \"if I do this, what do I get?\" in one short sentence.",
  "",
  "10. **Risk Register** (`riskRegister`) · ONLY emit when the composer picked `risk-register`; otherwise return null. 3–7 standing risks the operating environment poses — or specific failure modes of the recommendation when the room raised them concretely. Each entry: `risk` (≤180 chars), `category` (one of: market / execution / product / team / financial / compliance / technical), `severity` (high / medium / low), `likelihood` (high / medium / low), `owner` (functional role label · \"product\", \"ops\", \"legal\" — NOT a person), `mitigation` (≤220 chars · concrete playbook OR \"monitor only\"). Pick categories that match the actual risk; default to `execution` only when no other category fits.",
  "",
  "10c. **Decision Options** (`decisionOptions`) · ONLY emit when the composer picked `decision-options`; otherwise return null. 2–5 named candidate options the room weighed, with shared pros/cons. Object shape: `{ intro, options: [...], rationale }`. Each option: `label` (≤32 chars), `summary` (≤200 chars), `pros` (2–4 short clauses ≤80 chars each), `cons` (2–4 short clauses ≤80 chars each), `effort` (low / medium / high), `confidence` (high / medium / low), `recommended` (boolean). EXACTLY ONE option must have `recommended: true` — the room's pick. The `rationale` (≤280 chars) explains why the recommended option wins and connects back to the recommendations section.",
  "",
  "10d. **Path Comparison** (`pathComparison`) · ONLY emit when the composer picked `path-comparison`; otherwise return null. EXACTLY 2 paths, side-by-side, verdict-tagged. Object shape: `{ intro, paths: [pathA, pathB], implication }`. Each path: `verdict` (≤40 chars · short clause carrying the room's structural read · examples: \"structurally fragile\" / \"plausibly defensible\" / \"the obvious bet\" / \"the contrarian read\"), `stance` (one of: \"weak\" / \"strong\" / \"neutral\" · drives the accent colour at render time), `name` (≤90 chars · serif headline · can be a single phrase or two phrases joined by `\\n`), `characteristics` (4–6 bullets, each ≤110 chars · what makes this path what it is — NOT pros/cons, these are characteristics that collectively support the verdict). At most one path is \"strong\" and at most one is \"weak\"; both \"neutral\" is valid when the room presented both without picking. `intro` (≤200 chars · one-sentence framing of what the binary choice is about). `implication` (optional · ≤220 chars · downstream consequence of the choice). Reserve this for rooms that argued ONE binary structural hinge (replacement vs augmentation, vertical vs horizontal, build vs partner). For 3+ options use `decisionOptions`; for prose-only paths use `twoPaths`.",
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
  '  "title": "Claim-style sentence · 8-18 words · the takeaway, NOT the topic · self-contained without context · prefer a quantified element when one fits naturally (a number / count / horizon / ratio). Strong: \\"Three commitments that change the trajectory\\" / \\"Build for obligation, not for the model\\" / \\"提升X销售额的三点建议\\". Weak: \\"反共识判断\\" / \\"Market analysis\\" / \\"关于X的报告\\" — those describe the topic, not the takeaway. Avoid noun-phrase labels.",',
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
  '  "directorPerspectives": {',
  '    "intro": "Optional one-sentence intro framing how the directors compared (≤ 200 chars). Leave empty when the H2 is enough.",',
  '    "alignment": [',
  '      { "pointOfAgreement": "≤ 80 chars · what they converge on", "directorIds": ["dirId-a", "dirId-b"], "note": "≤ 220 chars · why this convergence is structurally interesting (e.g. independent paths to the same conclusion)" }',
  '    ],',
  '    "divergence": [',
  '      { "hinge": "≤ 140 chars · what separates them", "sides": [ { "label": "Side A", "directorIds": ["dirId-a"], "stance": "1-sentence stance" }, { "label": "Side B", "directorIds": ["dirId-b"], "stance": "1-sentence stance" } ], "resolution": "≤ 220 chars · what would settle the split (empty when unresolved)" }',
  '    ],',
  '    "perspectives": [',
  '      { "directorId": "dirId-a", "stance": "≤ 60 chars · short label of this director\'s angle", "position": "1-2 sentence load-bearing argument in their voice (≤ 300 chars)", "quote": "Optional verbatim ≤ 40 words; empty when no memorable line", "lens": "structural" },',
  '      { "directorId": "dirId-b", "stance": "...", "position": "...", "quote": "", "lens": "data" }',
  '    ],',
  '    "chairSynthesis": "2-4 sentences (≤ 400 chars) · the chair\'s structural observation from comparing the views. Moderator-neutral · observation, not advocacy."',
  '  },',
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
  '    { "priority": "P0", "action": "Imperative concrete action.", "rationale": "Why this works.", "ownerType": "platform team", "horizon": "next 30 days", "successMetric": "Observable proof.", "riskIfSkipped": "What goes wrong.", "criticalDependency": "What MUST be true for this to work — the load-bearing pre-condition. Forces stress-testing.", "expectedBenefit": "The concrete upside if you act — stated as the payoff a stakeholder cares about (revenue captured / risk avoided / position locked in)." }',
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
  '  "riskRegister": [',
  '    { "risk": "≤ 180 chars · one-sentence risk statement.", "category": "market", "severity": "high", "likelihood": "medium", "owner": "product", "mitigation": "≤ 220 chars · concrete playbook OR \\"monitor only\\"." }',
  '  ],',
  '  "decisionOptions": {',
  '    "intro": "Optional one-sentence framing for the comparison (≤ 200 chars).",',
  '    "options": [',
  '      { "label": "Build in-house", "summary": "≤ 200 chars one-sentence summary.", "pros": ["Pro 1", "Pro 2"], "cons": ["Con 1"], "effort": "high", "confidence": "medium", "recommended": false },',
  '      { "label": "Acquire", "summary": "...", "pros": ["..."], "cons": ["..."], "effort": "medium", "confidence": "high", "recommended": true }',
  '    ],',
  '    "rationale": "≤ 280 chars · why the recommended option wins."',
  '  },',
  '  "pathComparison": {',
  '    "intro": "Optional one-sentence framing of what the binary choice is about (≤ 200 chars).",',
  '    "paths": [',
  '      { "verdict": "structurally fragile", "stance": "weak", "name": "Replace HR with AI\\nResume screening as the primary value proposition", "characteristics": ["HR procurement resists tools positioned as threat", "Capability replicable from open weights within days", "No proprietary data accumulates; advantage plateaus", "Pattern across two decades of HR Tech: replacement plays consistently fail"] },',
  '      { "verdict": "plausibly defensible", "stance": "strong", "name": "Augment HR with AI\\nWorkflow embedding and proprietary data flywheel", "characteristics": ["HR is buyer and user; becomes internal advocate", "Defensibility from workflow lock-in; the model commoditizes, the process does not", "Product-led embedding compresses sales cycles to under three months", "Proprietary data flywheel; switching costs compound with usage"] }',
  '    ],',
  '    "implication": "Optional · ≤ 220 chars · downstream consequence of the binary choice."',
  '  },',
  '  "metricStrip": {',
  '    "intro": "Single sentence framing the strip (\'Three numbers worth pricing in\' / \'By the numbers\').",',
  '    "cards": [',
  '      { "label": "≤ 60 chars · what this number measures.", "value": "≤ 24 chars · the number-like reading (\'≤ 8%\', \'18 mo\').", "qualifier": "Optional · ≤ 80 chars context (\'of total ARR\').", "trend": "up | down | flat | null", "attribution": "Optional · which director / lens (≤ 80 chars)." }',
  '    ]',
  '  },',
  '  "appendices": [',
  '    { "title": "≤ 10 words · what the appendix carries.", "bodyMd": "Markdown body — paragraphs, blockquotes, tables, lists OK. For verbatim transcripts >80 words, raw signal extracts, supporting calculations, source chains. Empty array when no material warrants an appendix (most briefs). At most 4." }',
  '  ]',
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
  "Optional kinds (`frame-shift`, `convergence`, `divergence`, `positions`, `visuals`, `two-paths`, `why-now`, `new-questions`, `planning-assumption`, `open-questions`, `strategic-outlook`, `critical-assumptions`, `scenario-tree`, `leading-indicators`, `threats-to-validity`, `risk-register`, `metric-strip`): when listed in the picked set, fill them as the spec above describes. When NOT listed, set them to the empty value (`[]` for arrays, `null` for nullable objects, `{shifted:false, original:'', reframed:'', trigger:''}` for frameShift).",
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
  '    "threat": "1-2 sentences (≤ 280 chars) naming WHAT about the *analysis itself* could mislead. Distinct from risk-register (operating-environment risks) and from critical-assumptions (the assumptions the brief rests on).",',
  '    "observable": "What you would see if this threat is realized (≤ 200 chars). Without an observable, a threat is just a hedge — it must be falsifiable.",',
  '    "severity": "low | medium | high",',
  '    "mitigation": "What would address or defuse this threat (≤ 200 chars). Set null when the room had no concrete mitigation."',
  "  }",
  "]",
  "```",
  "Threats name limits of the analysis, not limits of the conclusion. \"The recommendation might fail if X\" is risk-register material; \"our analysis only consulted Western strategy directors so the conclusion may not generalize\" is a threat to validity. Pick at most 5; below 3 reads as token effort, above 5 turns into noise.",
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
    "new-questions", "planning-assumption",
    "open-questions",
    // Gartner-density blocks
    "strategic-outlook", "critical-assumptions", "scenario-tree", "leading-indicators",
    // Stanford-research self-criticism block
    "threats-to-validity",
    // Dashboard-style indicator strip
    "metric-strip",
    // Phase 2B · structurally distinct components for richer briefs
    "risk-register", "decision-options", "path-comparison",
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

  return [
    {
      role: "system",
      content: [SCAFFOLD_SYSTEM, "", languageInstruction(language)].join("\n"),
    },
    {
      role: "user",
      content: [
        `ROOM #${room.number} · ${room.name}`,
        `Subject: ${room.subject}`,
        // `Mode: …` deliberately omitted · see composer.ts for the
        // same change. Surfacing the room mode here biased the LLM
        // toward critique-shaped / brainstorm-shaped output even
        // though the standard scaffold prompt asks for decision-grade
        // JSON, leading to parseScaffold rejecting every retry.
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

/* ─────────────────────── Bento mode · single-page infographic ──────────
 *
 * Bento is a parallel output mode to the markdown research note. The
 * chair runs a SINGLE chair-LLM call (no separate Stage 3 streaming —
 * the structured JSON IS the deliverable; the renderer is deterministic
 * client-side templating).
 *
 * The bento body is intentionally lossy — the room's full discussion
 * compresses into 3 milestones + 3 sidebars + 1 conclusion that fit on
 * a single screen / single print page. Users who want the full memo
 * pick research-note instead. */

const BENTO_SYSTEM = [
  "You are the chair of a boardroom session. You produce a SINGLE-PAGE INFOGRAPHIC report — a structured \"bento box\" that compresses the room's discussion into a one-screen visual brief. Not a memo. Not a research note. A poster.",
  "",
  "## What a bento is for",
  "",
  "Bento is for the moment AFTER the discussion when the user wants to forward the takeaway to someone in 60 seconds. Not the analysis itself · the answer. Not the room's debate · the conclusion the room reached. Not all the evidence · the 3 most load-bearing claims with their numerics.",
  "",
  "Lossy is feature, not bug. If you can't compress to 3 milestones + a one-line conclusion, you didn't pick the load-bearing pieces. Compression is the work.",
  "",
  "## The 8 slots you fill (output is JSON only)",
  "",
  "1. **title** · the takeaway in claim form · serif headline · ≤ 110 chars · ONE sentence that names what the room concluded. Quantified is stronger (\"X cuts cost 10×\" beats \"X is meaningful\").",
  "",
  "2. **kicker** · 1 italic sentence · ≤ 200 chars · the angle / what's new about this conclusion. Reads like a magazine deck under the headline.",
  "",
  "3. **source** · ≤ 80 chars · attribution / context. Format: \"From {chair name} · {date or horizon}\" or \"{room subject short} · {date}\". Mono small caps register; auto-filled if you skip.",
  "",
  "4. **milestones** · EXACTLY 3 cards in the LEFT timeline. Each card has:",
  "   · `period` · time / phase tag · ≤ 24 chars · \"2025H2\" / \"Q1 2026\" / \"Phase 2\" / \"Top finding\" / \"Step 1\". Choose the lens (chronological, ranked, or sequential) that fits this room.",
  "   · `title` · ≤ 60 chars · the milestone's name in claim form.",
  "   · `body` · 2-3 sentences · ≤ 220 chars · what happened / will happen / why it matters.",
  "   · `callout` · ≤ 12 chars · the metric / multiplier / count that anchors this card visually. Examples: \"-10×\", \"2000万颗\", \"$120M ARR\", \"T+90\". Empty string when no clean numeric exists for this milestone.",
  "   · `tags` · 0-4 short chips · ≤ 16 chars each · entity names, owners, domains. Render as small rounded chips beside the body.",
  "",
  "   Pick the 3 most load-bearing pieces of the discussion. NOT the 3 most-mentioned. The 3 that, taken together, produce the takeaway from §1.",
  "",
  "5. **rankedBars** · OPTIONAL · top-right card · 3-5 ranked entries with normalised ratio bars. Pick this slot when the room produced quantitative comparisons (e.g. competitor TAM, model latencies, milestone costs). Each entry: `label` (≤ 40), `value` (≤ 20, the displayed number), `ratio` (0-1 normalised for bar width — divide by the largest entry). Set to `null` when the room had no real ranked-numeric material.",
  "",
  "6. **verification** · OPTIONAL · mid-right card · 3-5 single-sentence bullets · ≤ 140 chars each · the validation signals that, if observed, would confirm the takeaway. Maps from convergence + leading-indicator material. The card title is your call (default \"What we'd verify\" / \"验证线索\"). Set to `null` when the room raised no clean signals to watch.",
  "",
  "7. **talkingPoints** · ALWAYS rendered · bottom-right card · 3-5 elevator-pitch sentences · ≤ 120 chars each · what a reader could literally say to brief a colleague verbally. Imperative, declarative, no hedging. Maps from recommendations + bottom line, collapsed to single declarative sentences. Default title \"How to say this\" / \"口播提纲\".",
  "",
  "8. **conclusion** · bottom band · ≤ 100 chars · ONE sentence · the takeaway compressed further than the title. The reader walks away with this single line.",
  "",
  "Plus optional **flow** · 2-4 short nodes joined by arrows at render time · for transformations the room argued (\"before → after\" / \"10× → 10×\" / \"weak → defensible\"). Set to `null` when no clean transformation arc exists.",
  "",
  "Plus auto **footerTag** · ≤ 80 chars · short caption mono caps · room subject + horizon. Auto-filled if you skip.",
  "",
  "## Routing the SIGNALS block into bento slots",
  "",
  "The SIGNALS block carries each director's extracted material with kind prefixes (`[claim]`, `[evidence·data]`, `[risk]`, etc.). Route them into bento slots:",
  "  · **milestones** ← the 3 strongest `[claim]` + `[evidence·data]` pairs · pair each claim with its supporting datapoint when one exists; that becomes the card's `body` + `callout`.",
  "  · **rankedBars** ← `[evidence·data]` entries that are numeric AND comparable (the room mentioned multiple options / competitors / sizes / dates as ranked numerics).",
  "  · **verification** ← `[evidence·data]` + `[claim]` material that READS as something to monitor (\"if X stays above Y, the call holds\").",
  "  · **talkingPoints** ← `[action]` + `[claim·confidence:high]` material distilled to imperative single-sentence form.",
  "  · **conclusion** ← compressed restatement of the room's anchor (Bottom Line / Thesis equivalent).",
  "  · **flow** ← when the room argued a transformation (X becomes Y) or a multi-step path, distill it to 2-4 nodes.",
  "",
  "## Output format",
  "",
  "Strict JSON inside a fenced ```json code block. No prose outside the block. The shape is fixed:",
  "",
  "```json",
  "{",
  '  "title": "Sentence-form takeaway with a quantified element when one fits.",',
  '  "kicker": "1-sentence italic deck explaining the angle.",',
  '  "source": "From {chair name} · {date or horizon}",',
  '  "milestones": [',
  '    { "period": "2025H2", "title": "Milestone name", "body": "2-3 sentences.", "callout": "-10×", "tags": ["AWS", "GCP"] },',
  '    { "period": "Q1 2026", "title": "...", "body": "...", "callout": "...", "tags": [] },',
  '    { "period": "2026H2", "title": "...", "body": "...", "callout": "...", "tags": [] }',
  "  ],",
  '  "rankedBars": {',
  '    "title": "By the numbers",',
  '    "entries": [',
  '      { "label": "Hopper", "value": "1.0×", "ratio": 1.0 },',
  '      { "label": "Blackwell", "value": "0.1×", "ratio": 0.1 },',
  '      { "label": "Rubin", "value": "0.01×", "ratio": 0.01 }',
  "    ]",
  "  },",
  '  "verification": {',
  '    "title": "What we\'d verify",',
  '    "bullets": [',
  '      "Single sentence verification signal #1.",',
  '      "Single sentence verification signal #2.",',
  '      "Single sentence verification signal #3."',
  "    ]",
  "  },",
  '  "talkingPoints": {',
  '    "title": "How to say this",',
  '    "bullets": [',
  '      "First elevator-pitch sentence.",',
  '      "Second elevator-pitch sentence.",',
  '      "Third elevator-pitch sentence."',
  "    ]",
  "  },",
  '  "conclusion": "One-line takeaway · ≤ 100 chars.",',
  '  "flow": { "nodes": ["Hopper", "Blackwell", "Rubin"], "caption": "Two-stage cost step-down" },',
  '  "footerTag": "Q4 update · 2025H2 → 2026H2"',
  "}",
  "```",
  "",
  "Constraints:",
  "· Title MUST be claim-style (state the takeaway, not the topic). \"Three commitments that change the trajectory\" not \"Analysis of strategic options\".",
  "· Milestones MUST be 3. Pad with the most-mentioned claim if the room only surfaced 2 strong points; trim to the 3 most load-bearing if the room surfaced more.",
  "· `callout` field carries ONE numeric or unit · no English plus number combinations (\"$120M ARR\" OK; \"makes $120M\" not OK).",
  "· `talkingPoints` is mandatory · if the room had no recommendations, distil the bottom-line claim into 3 ways a colleague could quote it.",
  "· No markdown formatting inside string fields. No bullet characters. No headings. Plain prose only — the renderer adds visual structure.",
].join("\n");

interface BentoOpts extends Omit<ScaffoldOpts, "picked"> {
  /** Optional auto-filled fallbacks · used when the LLM omits the
   *  source / footerTag fields. The orchestrator fills these from the
   *  chair's display name + the room subject. */
  fallbackSource?: string;
  fallbackFooterTag?: string;
}

export function buildBentoMessages(opts: BentoOpts): LLMMessage[] {
  const { room, members, perDirectorSignals, language } = opts;

  const memberList = members
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

  const supplementBlock = opts.supplement && opts.supplement.trim()
    ? [
        ``,
        `─── SUPPLEMENTARY PERSPECTIVE FROM USER ───`,
        ``,
        `The user has asked you to additionally consider this angle when building the bento. Surface it in the most fitting slot (most often as one of the milestones, occasionally as a verification bullet or a talking point).`,
        ``,
        opts.supplement.trim(),
        ``,
        `─── END SUPPLEMENT ───`,
      ].join("\n")
    : "";

  return [
    {
      role: "system",
      content: [BENTO_SYSTEM, "", languageInstruction(language)].join("\n"),
    },
    {
      role: "user",
      content: [
        `ROOM #${room.number} · ${room.name}`,
        `Subject: ${room.subject}`,
        ``,
        `Directors:`,
        `  · ${memberList}`,
        ``,
        `─── SIGNALS ───`,
        ``,
        signalsBlock || "(no signals extracted)",
        ``,
        `─── END SIGNALS ───`,
        supplementBlock,
        ``,
        `Produce the bento now. JSON only.`,
      ].join("\n"),
    },
  ];
}

/* ─────────────────────────── Magazine mode · same JSON ──────────────────
 *
 * Magazine reuses the BentoScaffold JSON shape but routes the content
 * to a different layout (magazine.html). The system prompt biases the
 * writer toward magazine-spread content density:
 *   · 5 numbered talking points (the right-side card grid in the
 *     magazine layout) · each is a self-contained "tip" or "tactic"
 *     paired with a body sentence
 *   · 3 setup-step milestones (the middle band's 3-column step row)
 *   · 4 verification bullets ("why it matters" closer band)
 *   · A hero takeaway as the conclusion
 *
 * Same parser (parseBento) reads the output · the only client-side
 * difference is which page renders the JSON.
 * ────────────────────────────────────────────────────────────────────── */

const MAGAZINE_SYSTEM = [
  "You are the chair of a boardroom session. You produce a MAGAZINE-SPREAD report — an editorial single-page layout that opens like a magazine cover, lays out a numbered card grid of takeaways, walks through a 3-step setup band, and closes with a high-contrast \"why this matters\" pull-list. Not a memo. Not a research note. A magazine.",
  "",
  "## What a magazine spread is for",
  "",
  "Magazine is for the moment when the user wants to share the takeaway as a *piece of editorial content* — something a reader could scroll on a feed. Not the analysis itself · the cover line + the numbered tactics + the setup recipe. Not the room's debate · the published version a stranger could understand cold.",
  "",
  "Editorial register · magazines lead with personality, not with hedging. Headlines are claim-style, decks have voice, talking points read like \"5 tactics that actually work\" rather than \"considerations\". You are writing the cover spread, not the white paper.",
  "",
  "## The 8 slots you fill (output is JSON only)",
  "",
  "1. **title** · the cover headline · serif display · ≤ 110 chars · ONE sentence in claim form. Magazine covers state the takeaway with confidence — quantified or named (\"How {chair} {verb} {object}\" / \"X is the operating system for Y\" / \"Three commitments that change the trajectory\").",
  "",
  "2. **kicker** · the cover deck · ≤ 200 chars · 1 sentence under the headline. Non-italic register · subtitle voice. Names the angle / what's new.",
  "",
  "3. **source** · ≤ 80 chars · the masthead byline · \"From {chair name} · {date}\" / \"Issue 01 · {date}\" / \"{chair name} presents\". Mono small caps register; auto-filled if you skip.",
  "",
  "4. **milestones** · EXACTLY 3 cards · these become the magazine's middle band — a \"how to set this up in 10 minutes\" 3-step recipe. Each card has:",
  "   · `period` · short step label · ≤ 24 chars · \"Step 1\" / \"准备\" / \"Phase 2\" / \"First\". Imperative or sequential.",
  "   · `title` · ≤ 60 chars · what to do at this step. Imperative voice (\"Set up environment\" / \"准备环境\").",
  "   · `body` · 2 sentences · ≤ 220 chars · the concrete instruction · how a reader actually does this step.",
  "   · `callout` · ≤ 12 chars · optional anchor numeric · usually empty in magazine mode (the layout doesn't lean on big numbers in this band).",
  "   · `tags` · empty array (`[]`) · the magazine layout doesn't render tags on the setup band.",
  "",
  "5. **rankedBars** · OPTIONAL · 3-5 ranked entries. Renders only when the room produced a clean ranking. Set to `null` when there's no real ranked-numeric material.",
  "",
  "6. **verification** · MANDATORY for magazine · these become the dark closing band's \"why this matters\" pull-list. Provide 4 bullets · ≤ 140 chars each · each bullet is a SHORT REASON the takeaway matters · phrased as a stand-alone declaration (\"Saves time · routine work compresses to minutes\" / \"Highly personalized · tailored to your context\"). Title is your call (default \"Why this matters\" / \"为什么这很强大\").",
  "",
  "7. **talkingPoints** · MANDATORY · 5 numbered cards · ≤ 120 chars each · these become the magazine's hero card grid · the \"5 tactics\" feature. EACH BULLET MUST BEGIN WITH A SHORT PHRASE (the card's title — what the renderer extracts as the card headline) FOLLOWED BY \" · \" (a middle-dot with spaces) AND THEN THE BODY SENTENCE. Example format: \"Weekly check-in · Run /weekly check-in to track key metrics across a personal dashboard.\" The renderer splits on \" · \" to extract title + body. If you can't fit 5, output as many as you have ≥3.",
  "",
  "   Title side ≤ 24 chars · body side ≤ 100 chars. Imperative voice in the body (\"Run X\" / \"使用 X\"). Imperative for English magazine voice; in Chinese, lead the body with the verb (\"使用…\" / \"运行…\" / \"通过…\").",
  "",
  "   Default talkingPoints title · \"5 tactics\" / \"5 个例子看明白\" / \"5 ways to use this\" · the LARGE outline numeral on the magazine cover is derived from this section's count.",
  "",
  "8. **conclusion** · ≤ 100 chars · ONE sentence · the cover-line reinforcement. The reader walks away with this single line · usually a short imperative or claim restatement.",
  "",
  "Plus optional **flow** · usually `null` in magazine mode · only fill when the room argued a clean transformation arc.",
  "",
  "Plus auto **footerTag** · ≤ 80 chars · masthead-style caption · auto-filled if you skip.",
  "",
  "## Routing the SIGNALS block into magazine slots",
  "",
  "  · **title** ← the strongest claim · phrased as a magazine cover headline.",
  "  · **kicker** ← the supporting deck · ≤ 1 sentence · what's new about this conclusion.",
  "  · **milestones** ← if the room argued a setup / how-to flow, route the 3 most important steps. If the room didn't produce a clean recipe, distill the 3 most actionable items into imperative steps.",
  "  · **talkingPoints** ← the 5 strongest action / claim entries · each rewritten in \"Title · Body\" form (split with the middle dot + spaces).",
  "  · **verification** ← 4 reasons the takeaway matters · drawn from the room's evidence + bottom-line material · phrased as standalone declarations.",
  "  · **conclusion** ← compressed restatement of the room's anchor.",
  "",
  "## Output format",
  "",
  "Strict JSON inside a fenced ```json code block. No prose outside the block. The shape is fixed (same as bento mode):",
  "",
  "```json",
  "{",
  '  "title": "Cover-line takeaway in claim form.",',
  '  "kicker": "1-sentence deck explaining the angle.",',
  '  "source": "From {chair name} · {date}",',
  '  "milestones": [',
  '    { "period": "Step 1", "title": "Set up environment", "body": "Install the tooling and create the workspace folder.", "callout": "", "tags": [] },',
  '    { "period": "Step 2", "title": "Initialize and configure", "body": "Run the init command and follow the prompts to wire up your slash commands.", "callout": "", "tags": [] },',
  '    { "period": "Step 3", "title": "Run and customize", "body": "Run weekly or daily, customize prompts to your context.", "callout": "", "tags": [] }',
  "  ],",
  '  "rankedBars": null,',
  '  "verification": {',
  '    "title": "Why this matters",',
  '    "bullets": [',
  '      "Saves time · routine work compresses to minutes a week.",',
  '      "Highly personalized · tailored to the context you provide.",',
  '      "Beyond coding · use cases extend well past development tasks.",',
  '      "Infinite extensibility · spin up more agents to fit any new need."',
  "    ]",
  "  },",
  '  "talkingPoints": {',
  '    "title": "5 tactics",',
  '    "bullets": [',
  '      "Weekly check-in · Run /weekly check-in to track key metrics on a personal dashboard.",',
  '      "Daily journal · Run /daily check-in to journal accomplishments and feelings.",',
  '      "Content research · Use /newsletter researcher to draft your own briefs in your voice.",',
  '      "Brain-dump analyzer · Run /brain dump analysis on raw notes to surface a mind-map.",',
  '      "Daily brief · Use /daily brief for a tailored news round-up by your interests."',
  "    ]",
  "  },",
  '  "conclusion": "One-line takeaway · ≤ 100 chars.",',
  '  "flow": null,',
  '  "footerTag": "Issue 01 · {date}"',
  "}",
  "```",
  "",
  "Constraints:",
  "· Title MUST be cover-style (a magazine wouldn't run \"Analysis of strategic options\" — it would run \"How X built the operating system for Y\"). State the takeaway, not the topic.",
  "· talkingPoints bullets MUST follow \"Title · Body\" with the middle dot + spaces · the renderer's split is exact.",
  "· Provide 4 verification bullets when the room has the material; 3 acceptable as a floor.",
  "· No markdown formatting inside string fields. No bullet characters. No headings. Plain prose only — the renderer adds visual structure.",
].join("\n");

export function buildMagazineMessages(opts: BentoOpts): LLMMessage[] {
  const { room, members, perDirectorSignals, language } = opts;

  const memberList = members
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

  const supplementBlock = opts.supplement && opts.supplement.trim()
    ? [
        ``,
        `─── SUPPLEMENTARY PERSPECTIVE FROM USER ───`,
        ``,
        `The user has asked you to additionally consider this angle when building the magazine. Surface it in the most fitting slot (most often as one of the talking points or verification bullets).`,
        ``,
        opts.supplement.trim(),
        ``,
        `─── END SUPPLEMENT ───`,
      ].join("\n")
    : "";

  return [
    {
      role: "system",
      content: [MAGAZINE_SYSTEM, "", languageInstruction(language)].join("\n"),
    },
    {
      role: "user",
      content: [
        `ROOM #${room.number} · ${room.name}`,
        `Subject: ${room.subject}`,
        ``,
        `Directors:`,
        `  · ${memberList}`,
        ``,
        `─── SIGNALS ───`,
        ``,
        signalsBlock || "(no signals extracted)",
        ``,
        `─── END SIGNALS ───`,
        supplementBlock,
        ``,
        `Produce the magazine spread now. JSON only.`,
      ].join("\n"),
    },
  ];
}

/* ─────────────────────────── Newspaper mode · same JSON ─────────────────
 *
 * Newspaper reuses the BentoScaffold JSON shape but drives a broadsheet
 * front-page layout (newspaper.html). The writer's tonal register is
 * front-page journalism: declarative claim-form headlines, lead-
 * paragraph editorial body, longer prose per milestone (each fills a
 * full newspaper column).
 *
 * Same parser (parseBento) reads the output · only the system prompt
 * and renderer differ.
 * ────────────────────────────────────────────────────────────────────── */

const NEWSPAPER_SYSTEM = [
  "You are the chair of a boardroom session. You produce a NEWSPAPER FRONT-PAGE report — a broadsheet single-page layout with a banner masthead, a full-width front-page headline, and a 3-column editorial spread with sidebar callouts. Not a memo. Not a magazine. A NEWSPAPER.",
  "",
  "## Voice",
  "",
  "Front-page journalism. Headlines are declarative, present-tense, claim-form (\"BOARD COMMITS TO TWO-TRACK RELEASE\" — not \"An analysis of release strategy\" or \"What the board decided\"). Body prose is lead-paragraph editorial: each paragraph carries one claim with its supporting evidence, sentences are short, transitions are crisp, hedging is minimal.",
  "",
  "Newspaper voice is more formal than magazine voice and more confident than research-note voice. Imagine the front page of a serious broadsheet · The Wall Street Journal, The Financial Times, The Economist if it ran a daily.",
  "",
  "## The 8 slots you fill (output is JSON only)",
  "",
  "1. **title** · the front-page banner headline · ≤ 110 chars · ALL-CAPS-ABLE claim (the renderer applies uppercase) · NOT a question, NOT a label, a CLAIM. Examples: \"BOARD COMMITS TO TWO-TRACK RELEASE\", \"MARKETS BRACE FOR Q4 RESET\", \"REGULATORS MOVE AGAINST DARK PATTERNS\".",
  "",
  "2. **kicker** · the subheading deck · ≤ 200 chars · 1 sentence under the headline · expands the claim with the angle / what's new.",
  "",
  "3. **source** · masthead byline · ≤ 80 chars · \"From the desk of {chair name} · {date}\" or similar. Mono small caps register; auto-filled if you skip.",
  "",
  "4. **milestones** · EXACTLY 3 column-stories. Each milestone IS one of the newspaper's 3 main columns. Each card has:",
  "   · `period` · column section label · ≤ 24 chars · \"TOP STORY\" / \"MARKETS\" / \"POLICY\" / \"OPS\" / \"OPINION\". Section-banner register. ALL-CAPS-ABLE.",
  "   · `title` · column subheading · ≤ 60 chars · the column's hook. Question or claim form OK.",
  "   · `body` · 4-7 sentences · ≤ 420 chars · LONGER than other modes since this fills a full editorial column. Lead-paragraph style: open with the claim, support with evidence, close with the so-what. Present tense, declarative.",
  "   · `callout` · usually empty · the layout doesn't lean on big-number callouts in this pattern.",
  "   · `tags` · empty array.",
  "",
  "5. **rankedBars** · OPTIONAL · top-right \"image slot\" · 3-5 ranked entries painted as a small editorial chart. Set null when the room has no clean ranked-numeric material.",
  "",
  "6. **verification** · MANDATORY · these become the bottom-left \"MORE HEADINGS\" stacked sidebar · 3-5 entries · each ≤ 180 chars · phrased as \"Heading: body sentence.\" — use a colon as separator (the renderer splits on it for typography). Each entry is a SHORT NEWS ITEM that supports or qualifies the front-page claim.",
  "",
  "7. **talkingPoints** · MANDATORY · 3-5 quotable lines · ≤ 140 chars each · these become the bottom editorial column's paragraphs · imperative or declarative, no hedging. Each is a self-contained line a reader could pull-quote.",
  "",
  "8. **conclusion** · the front-page \"BOTTOM LINE\" inverted callout · ≤ 100 chars · ONE sentence · the takeaway compressed to a quote. The reader walks away with this single line.",
  "",
  "Plus optional **flow** · usually `null` in newspaper mode · only fill when the room argued a clean transformation arc.",
  "",
  "Plus auto **footerTag** · ≤ 80 chars · masthead-style date caption · auto-filled if you skip.",
  "",
  "## Routing the SIGNALS block into newspaper slots",
  "",
  "  · **title** ← the strongest claim · phrased as a front-page headline (declarative, claim-form).",
  "  · **kicker** ← the supporting deck · ≤ 1 sentence · what's new about this conclusion.",
  "  · **milestones** ← the 3 most load-bearing columns of the discussion · each milestone gets a section banner (TOP STORY / MARKETS / etc.) + a column-length editorial body.",
  "  · **verification** ← the room's secondary findings · each phrased as \"Heading: body.\" with a colon separator.",
  "  · **talkingPoints** ← the room's actionable conclusions · 3-5 quotable lines.",
  "  · **conclusion** ← the IMPORTANT-DETAILS callout · the room's bottom line in claim form.",
  "",
  "## Output format",
  "",
  "Strict JSON inside a fenced ```json code block. No prose outside the block. The shape is fixed (same as bento mode):",
  "",
  "```json",
  "{",
  '  "title": "Banner headline in claim form",',
  '  "kicker": "1-sentence subdeck explaining the angle.",',
  '  "source": "From the desk of {chair name} · {date}",',
  '  "milestones": [',
  '    { "period": "TOP STORY", "title": "What the board decided", "body": "4-7 sentence editorial column body explaining the lead story with evidence and so-what.", "callout": "", "tags": [] },',
  '    { "period": "MARKETS", "title": "Why the market is reading this", "body": "4-7 sentence editorial column body covering the second angle.", "callout": "", "tags": [] },',
  '    { "period": "POLICY", "title": "Open questions for the regulator", "body": "4-7 sentence editorial column body covering the third angle.", "callout": "", "tags": [] }',
  "  ],",
  '  "rankedBars": null,',
  '  "verification": {',
  '    "title": "More headings",',
  '    "bullets": [',
  '      "Q4 outlook: Three commitments anchor the next quarter\'s plan.",',
  '      "Pricing: The pilot programme survives, but caps are tightening.",',
  '      "Hiring: Two new senior roles open by next board meeting.",',
  '      "Risk: Compliance review remains the gating constraint."',
  "    ]",
  "  },",
  '  "talkingPoints": {',
  '    "title": "From the editorial",',
  '    "bullets": [',
  '      "First quotable editorial line that names the takeaway.",',
  '      "Second quotable line that addresses the obvious objection.",',
  '      "Third quotable line that sets the next-step expectation."',
  "    ]",
  "  },",
  '  "conclusion": "One-sentence bottom-line takeaway · ≤ 100 chars.",',
  '  "flow": null,',
  '  "footerTag": "{date} · Edition 01"',
  "}",
  "```",
  "",
  "Constraints:",
  "· Title MUST be declarative claim-form (newspaper headlines DO NOT ask questions on the front page · they STATE).",
  "· Milestones bodies are LONGER than other modes (4-7 sentences) · this is a column, not a card.",
  "· Verification bullets MUST follow \"Heading: body.\" with a colon separator · the renderer splits on it.",
  "· No markdown formatting inside string fields. No bullet characters. No headings. Plain prose only — the renderer adds visual structure.",
].join("\n");

export function buildNewspaperMessages(opts: BentoOpts): LLMMessage[] {
  const { room, members, perDirectorSignals, language } = opts;

  const memberList = members
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

  const supplementBlock = opts.supplement && opts.supplement.trim()
    ? [
        ``,
        `─── SUPPLEMENTARY PERSPECTIVE FROM USER ───`,
        ``,
        `The user has asked you to additionally consider this angle when building the newspaper. Surface it in the most fitting slot (most often as one of the 3 milestone columns or as a verification headline).`,
        ``,
        opts.supplement.trim(),
        ``,
        `─── END SUPPLEMENT ───`,
      ].join("\n")
    : "";

  return [
    {
      role: "system",
      content: [NEWSPAPER_SYSTEM, "", languageInstruction(language)].join("\n"),
    },
    {
      role: "user",
      content: [
        `ROOM #${room.number} · ${room.name}`,
        `Subject: ${room.subject}`,
        ``,
        `Directors:`,
        `  · ${memberList}`,
        ``,
        `─── SIGNALS ───`,
        ``,
        signalsBlock || "(no signals extracted)",
        ``,
        `─── END SIGNALS ───`,
        supplementBlock,
        ``,
        `Produce the newspaper front page now. JSON only.`,
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
   *  rotation kinds (anchor / findings / action / risk-register / etc.).
   *  Optional — omitted callers pin to variant 0 of every entry. */
  briefId?: string;
}

const WRITE_SYSTEM = [
  "You are the chair of a boardroom session. You have a structured scaffold. Write the final report in markdown — a McKinsey-grade research note that makes the multi-director thinking visible. Pyramid principle, MECE, action-oriented.",
  "",
  "## Signal kind tags in the source material",
  "",
  "When you cite a director's signal back into prose, the SIGNALS block in the user message tags each entry with its kind: `[claim]`, `[evidence·data|case|quote]`, `[tension]`, `[risk·severity]`, `[action·owner·horizon]`, `[open-q·P0|P1|P2]`, `[quote]`, etc. The tags are routing hints from the extract stage — `[evidence·data]` is hard data worth featuring as a number, `[risk]` is a downside the room raised, `[quote]` is a verbatim line worth preserving as a pull-quote. STRIP the bracket prefix when you weave a signal into your prose; keep the underlying claim. The prefix is metadata for placement, not content.",
  "",
  "## Required structure (in order — never reorder)",
  "",
  "Start with a single H2 title. Use `scaffold.title` if it's already claim-style (states the takeaway, ideally with a quantified element — \"Three commitments that change the trajectory\" / \"提升X销售额的三点建议\"). If `scaffold.title` is a topic label or noun-phrase (\"反共识判断\" / \"Market analysis\" / \"关于X的分析报告\"), rewrite it into a claim-style sentence that names what the report concludes. The H2 is the first thing a stakeholder reads — it must carry the takeaway, not the topic.",
  "",
  "  ## Bottom Line",
  "  Render as a STANDALONE executive summary — a stakeholder who reads only this section should know the call, the supporting evidence, and the action. ALWAYS rendered. The report's visual anchor.",
  "  Open paragraph (1–2 sentences) with the scaffold's `bottomLine.judgement` rephrased for impact, italicized. Then state the confidence inline using this exact format: `**Confidence: {high/medium/low}** — {rationale}`.",
  "  After that opening paragraph, add up to two sub-blocks — render each only when its source data is present in the scaffold:",
  "    · `**What's behind it**` followed by a 2–3 bullet list, each bullet ≤ 18 words, distilling each Headline Finding's `claim` into a single line. Use the claim verbatim if it's already short; otherwise compress without changing the meaning. Skip this sub-block when `headlineFindings` and `bigIdeas` are both empty.",
  "    · `**What to do**` followed by ONE bullet collapsing the highest-priority recommendation (the first item after sort) into ≤ 16 words — imperative voice, drop the metric / horizon / risk fields here, those live in the Recommendations section. Skip this sub-block when `recommendations` is empty. When `considerations` is the action substitute, replace the kicker with `**Worth considering**` and use the hedged voice (\"could ...\" / \"might ...\").",
  "  Don't pad either sub-block with prose. The bullets carry the section. The expanded shape exists so a reader who stops here still leaves with the call + the why + the do-next.",
  "",
  "  ## Introduction",
  "  Render this section ONLY when the brief has 6 or more body sections (a standalone reader needs framing before diving in; short briefs don't earn an intro). 2-3 sentences, no bullets:",
  "    Sentence 1 · paraphrase the room's initial question — what was being investigated. Use the language the room used; don't editorialize.",
  "    Sentence 2 · scope · the room's composition (e.g. \"three directors over X turns, working through Y\"). Pull from the methodology context provided in the user message.",
  "    Sentence 3 (optional) · what kind of decision this brief supports — a forward investment / a retrospective audit / an open exploration / etc. Skip this sentence when it's obvious from the question and would feel redundant.",
  "  Plain prose. No kicker labels. Skip entirely when total section count is 5 or fewer (the Bottom Line + a few chapters is its own intro).",
  "",
  "  ## Frame Shift",
  "  This is the most distinctive multi-director output. ALWAYS rendered. Two cases:",
  "    · If `frameShift.shifted: true` — write 2–3 sentences using this pattern: \"The room opened with {original}. By {trigger description}, the question shifted to {reframed}.\"",
  "    · If `frameShift.shifted: false` — write \"The frame held: the room sharpened {original} rather than redefining it. {trigger as 1-sentence rationale}.\"",
  "",
  "  ## Headline Findings",
  "  Each finding must demonstrably support the anchor (Bottom Line / Thesis / Working Hypothesis). Before rendering, audit each scaffold finding against this question: \"would removing this finding weaken the anchor's case?\" If the answer is no — the finding is interesting but tangential — DROP it from the report. Do not render the H3. A 2-finding section that all carry the conclusion beats a 3-finding section where one is decorative. Cohesion of supporting evidence is what makes the report land; one weakly-connected finding dilutes the others.",
  "  Length budget · the WHOLE Headline Findings section should land between 2,000 and 3,500 characters total (≈ 350–600 words across 2–3 findings). Per finding: ~1,000–1,200 chars. If you find yourself writing a 4th paragraph for a single finding, you've over-built — cut to 3 paragraphs and trust the reader. Density beats verbosity; this is the section a stakeholder is most likely to skim, so every paragraph must do work.",
  "  Render up to 3 findings (drop weakly-connected ones to 2 if needed; never invent a third). For each one, render as:",
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
  "  ## Views Compared",
  "  ALWAYS rendered when `directorPerspectives` is non-null (i.e. ≥ 2 active directors). This is the room's social map · every active director gets a row, alignment / divergence groups are explicit, the chair's structural observation closes the block. Skip ONLY when `directorPerspectives` is null (single-director rooms).",
  "  Emit a fenced ```views-compared block · the renderer turns the strict JSON into a structured comparison view (alignment cards, divergence panels, per-director rows, chair synthesis card). Same dispatch pattern as `metric-strip` and `path-comparison`. Do NOT also write a markdown table or prose duplicating the same content.",
  "    ```views-compared",
  '    {',
  '      \"intro\": \"{directorPerspectives.intro · or empty string when null}\",',
  '      \"alignment\": [',
  '        { \"pointOfAgreement\": \"...\", \"directorIds\": [\"...\", \"...\"], \"note\": \"...\" }',
  '      ],',
  '      \"divergence\": [',
  '        { \"hinge\": \"...\", \"sides\": [ { \"label\": \"...\", \"directorIds\": [\"...\"], \"stance\": \"...\" } ], \"resolution\": \"...\" }',
  '      ],',
  '      \"perspectives\": [',
  '        { \"directorId\": \"...\", \"stance\": \"...\", \"position\": \"...\", \"quote\": \"...\", \"lens\": \"structural\" }',
  '      ],',
  '      \"chairSynthesis\": \"...\"',
  '    }',
  "    ```",
  "  Hard rules:",
  "    · The fence info-string is exactly `views-compared` (no version, no extras). The renderer dispatches on this string.",
  "    · Strict JSON inside · no comments, no trailing commas. Newlines inside string values must be escaped as `\\n`.",
  "    · Use the EXACT director ids from the room's member list (provided in the user message). Misspelled ids leave directors stranded — they render as their raw id instead of their display name.",
  "    · `perspectives` MUST include EVERY active director who spoke in the room. Don't omit a director because their position was thin — render their position with a low-confidence framing instead.",
  "    · Each `alignment` group needs ≥ 2 directors. Single-director \"groups\" are dropped by the parser.",
  "    · Each `divergence` entry needs ≥ 2 sides. Single-side divergence is also dropped.",
  "    · `chairSynthesis` is moderator-neutral · observation about the SHAPE of the disagreement / agreement, NOT advocacy. Examples: \"Even directors who disagreed on X all converged on Y as the load-bearing question\" / \"What's striking is that the dissent came from the data lens, not the structural one — usually the opposite\".",
  "    · Section title alternatives — pick one that matches the brief's voice: \"Views Compared\" (default), \"Where Each Director Stood\" (anthropic / first-round-essay), \"How the Room Read This\" (gartner-research), \"观点对比\" (zh).",
  "    · Leave a BLANK LINE between the H2 heading and the fenced block.",
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
  "## Inline mermaid · additional chart types",
  "",
  "Beyond the typed visuals (`comparison-table` / `quadrant-chart` / `force-field` / `strengths-cautions` / `bar-chart` / `timeline` / `pie-chart`), the writer drops fenced ```mermaid blocks inline within body sections to surface logic, sequence, hierarchy, or state that prose can't carry as efficiently. Each must visualise something prose can't.",
  "",
  "**Mermaid bias · prefer mermaid where it fits naturally — no fixed quota.** Two sources count:",
  "  · Typed visuals where the sub-type is mermaid (`quadrant-chart` / `bar-chart` / `timeline` / `pie-chart`).",
  "  · Inline mermaid blocks from the catalogue below (`flowchart` / `mindmap` / `gantt` / `sequenceDiagram` / `journey` / `stateDiagram-v2`).",
  "Quality over quantity. Emit a chart whenever the section's content has structure prose can't carry efficiently. Skip when the prose alone is clear — a forced chart is worse than no chart. There is NO minimum count; a substantive strategy brief might naturally land at 4–6 charts, a tight philosophical brief at 0–1, both are correct.",
  "",
  "**The default lean is YES** when a section's content matches one of these shapes: branching logic, sequenced events, multi-party interactions, hierarchical structure, state transitions, 2-axis comparisons, distributions, before/after framings. The cost of an extra chart is small; the cost of a wall of text is a reader who skips. But don't manufacture structure that isn't in the material — chart only what the room actually produced.",
  "",
  "**Complexity floor — never emit a trivial chart.** A trivial chart looks naive (\"幼齿\") and pulls down the report's register. The floor:",
  "  · `flowchart` · MINIMUM 5 nodes AND at least one BRANCH (a node with 2+ outgoing edges, OR a `{diamond}` decision with branching paths). Pure linear `A → B → C` chains are FORBIDDEN — those belong in prose or as a numbered list, never as a flowchart.",
  "  · `mindmap` · MINIMUM 4 top-level branches (or 3 branches × ≥ 2 children each = 9+ leaf nodes). A 2-3 branch mindmap is just a bullet list with extra steps.",
  "  · `sequenceDiagram` · MINIMUM 4 messages across ≥ 2 actors. Below that, prose carries it.",
  "  · `stateDiagram-v2` · MINIMUM 4 states with at least one cycle / back-transition. A pure linear state chain is a flowchart waiting to happen.",
  "  · `gantt` · MINIMUM 2 sections OR 4 tasks. A 2-task gantt is overkill — use prose.",
  "  · When a candidate chart fails the floor, **drop the chart and use prose / table instead**. A missing chart is fine; a trivial chart is worse than nothing.",
  "",
  "**Per-section trigger map** (consult this for EVERY rendered section · ✓ = strong fit when material is non-trivial; ◇ = optional, fire only when the complexity floor above is comfortably met):",
  "  · `Bottom Line` → ◇ rarely; the executive summary is intentionally text.",
  "  · `Frame Shift` → ◇ ONLY when the reframe involves ≥ 4 distinct moves with branching (e.g. original → trigger → 2-3 reframed angles → resolved frame). The 3-node `original → trigger → reframed` chain is exactly the trivial case banned above — render those as prose with the original quoted, the trigger named, the reframe as a callout.",
  "  · `Headline Findings` → ◇ ONLY when ≥ 4 findings interrelate causally with at least one branch (rare). Three independent findings in a row → no chart.",
  "  · `Convergence` → ◇ ONLY when there are ≥ 4 directors converging via ≥ 4 distinct lenses. With 2-3 directors / 2-3 lenses it's a small star that reads as decoration. Pair the chart only when the structural insight (many independent paths to one conclusion) survives the floor.",
  "  · `Divergence` → ◇ ONLY when the divergence has ≥ 3 distinct positions PLUS the resolution requirements form their own sub-branches (5+ nodes, branched). The classic two-branch fork is not enough — render those as the typed divergence table, no chart.",
  "  · `Positions` → ✓ `mindmap` when there are ≥ 3 named camps, EACH with ≥ 2 directors (= 9+ nodes). With only 2 camps OR 1 director per camp, render as prose; the mindmap of 2 branches × 1 leaf is naive.",
  "  · `Options Analysis` / `Decision Options` → ◇ ONLY when there are ≥ 4 options OR each option branches into 2+ sub-considerations (5+ nodes total with branching). With 2-3 options, the typed table / decision-options block carries it — no chart.",
  "  · `Two Paths` → ◇ rarely; two parallel trajectories joined at a hinge is exactly the trivial case. Render the typed table only.",
  "  · `Strategic Outlook` → ◇ `mindmap` ONLY when the room named ≥ 4 distinct forces with internal sub-structure (4 branches × ≥ 2 children).",
  "  · `Critical Assumptions` → ◇ `flowchart TD` ONLY when assumptions form a multi-step dependency chain WITH branching (assumption A holds → either B or C → recommendation D), 5+ nodes. Linear 3-step dependency = prose.",
  "  · `Scenario Tree` → ✓ `flowchart TD` when there are ≥ 3 scenarios EACH with named effects/triggers as sub-nodes (root + 3 scenarios + 3-6 effect children = 7-10 nodes). Below that, the typed table is enough.",
  "  · `Threats to Validity` → ◇ `flowchart TD` ONLY when threats compound (sample bias → selection bias → generalizability ceiling) with branching, 5+ nodes.",
  "  · `Recommendations` → ✓ `gantt` for multi-phase rollouts (≥ 2 sections AND ≥ 4 tasks). For sequenced action chains under 4 tasks, use prose / numbered list — NOT a linear flowchart.",
  "  · `Leading Indicators` → ◇ `stateDiagram-v2` when indicators map to ≥ 4 scenario states with at least one feedback loop / back-transition.",
  "  · `Risk Register` → ✓ `flowchart TD` when there are ≥ 5 risks AND multiple risks share a category cluster (root → category nodes → individual risks as leaves = ≥ 10 nodes). The typed risk table is enough on its own when the register is < 5 entries.",
  "  · `Risk Register` → ✓ `quadrantChart` of severity × likelihood (always — the quadrant chart is a 2-axis plot, not subject to the flowchart-complexity floor).",
  "  · `New Questions This Surfaced` → ◇ `mindmap` when there are ≥ 4 new questions clustering into ≥ 3 themes.",
  "  · `Strategic Planning Assumption` → ◇ rarely.",
  "  · `Open Questions` → ◇ rarely.",
  "",
  "**Reading the trigger map**: ✓ does NOT mean \"always emit\". It means \"emit when the material is non-trivial AND the complexity floor is met\". When in doubt about whether content has enough structure, render prose / a typed table — those don't have a complexity floor and never read as naive.",
  "",
  "**Routing constraints** (avoid double-rendering the same content):",
  "  · Risk Register flowchart + Risk Register table = ✓ both, complementary.",
  "  · Risk Register quadrantChart + Risk Register table = ✓ both, complementary.",
  "  · A single section gets at MOST one inline mermaid (plus the typed visual if any). Never stack 2+ inline charts in one section.",
  "  · A `gantt` and a `flowchart` covering the SAME recommendation rollout = pick one (gantt if dates matter, flowchart if branching matters).",
  "  · If a typed `visuals` block already covers a content shape (e.g. `bar-chart` for ranked options), don't add an inline `flowchart` for the same options.",
  "",
  "  ### flowchart · decision tree / process branches",
  "  Use when a section argues a decision sequence (\"if X then Y else Z\") or a process where order + branching matters. Natural fits: risk-register branches (\"if risk A materialises, do P; else monitor\"), the divergence section when there are 3+ positions, scenario trees with named effects.",
  "    ```",
  "    flowchart TD",
  "        A[Starting state] --> B{Decision point}",
  "        B -->|condition true| C[Branch A]",
  "        B -->|condition false| D[Branch B]",
  "        C --> E[Outcome]",
  "        D --> E",
  "    ```",
  "  Hard rules:",
  "    · **Complexity floor · ≥ 5 nodes AND ≥ 1 branch** (a node with 2+ outgoing edges, OR a `{diamond}` decision with branching paths). Pure linear `A → B → C` flowcharts are FORBIDDEN — those read as naive (\"幼齿\") and must render as prose / a numbered list instead. If your candidate flowchart has 3-4 nodes OR no branching, **drop the chart and use prose**. A missing chart is fine; a trivial one is worse than nothing.",
  "    · Direction is `TD` (top-down) or `LR` (left-right) ONLY. `TD` is the default for decision trees, `LR` for process sequences.",
  "    · Node labels: square brackets `[label]` for boxes, curly `{label}` for diamonds (decisions), round `(label)` for terminal states. Keep labels ≤ 6 words.",
  "    · Edge labels (`-->|text|`) are quoted only if they contain spaces — short text without spaces can be unquoted.",
  "    · NO `:`, NO `(`, NO `)`, NO `\"` inside node labels. ASCII parens only — never fullwidth.",
  "    · Maximum 8 nodes per chart. Above 8 stops being scannable; split into multiple charts.",
  "    · NO blank lines inside the fenced block. Indent body lines 4 spaces.",
  "",
  "  ### mindmap · hierarchical idea tree",
  "  Use when a section needs to surface the *shape* of the room's thinking — typically in brainstorm-mode rooms (`adjacent-angles`, `worth-chasing`) where the directors generated multiple branches off a central premise. Avoid in decision-grade briefs where the structure is already linear (anchor → findings → action).",
  "    ```",
  "    mindmap",
  "        root((Central question))",
  "            Branch A",
  "                Sub-thread A1",
  "                Sub-thread A2",
  "            Branch B",
  "                Sub-thread B1",
  "    ```",
  "  Hard rules:",
  "    · **Complexity floor · ≥ 4 top-level branches OR ≥ 3 branches with ≥ 2 children each (= 9+ leaf nodes total)**. A 2-3 branch mindmap is just a bullet list with extra steps and reads as naive — drop it and use a markdown bullet list instead.",
  "    · Root node uses `root((label))` — double parens for the cloud shape. ASCII parens only.",
  "    · Indentation IS the hierarchy — children indent 4 spaces under their parent.",
  "    · Node text is plain — NO `:`, NO `\"`, NO brackets, NO leading `-` / `*`. Just the text.",
  "    · 4–6 top-level branches (after the floor). Each branch 2–4 children. Above that the diagram unreads.",
  "    · NO blank lines inside the fenced block.",
  "",
  "  ### gantt · execution timeline with dependencies",
  "  Use when a section names a multi-phase rollout or campaign with time-bound activities and dependencies — typically inside Recommendations or a follow-up Strategic Outlook. Skip when the recommendations are atomic / not phased.",
  "    ```",
  "    gantt",
  "        title Rollout phasing",
  "        dateFormat YYYY-MM",
  "        section Foundations",
  "        Discovery        :a1, 2026-04, 2M",
  "        Pilot scope      :a2, after a1, 1M",
  "        section Build",
  "        Vertical 1       :b1, after a2, 3M",
  "        Vertical 2       :b2, after b1, 3M",
  "    ```",
  "  Hard rules:",
  "    · **Complexity floor · ≥ 2 sections AND ≥ 4 tasks total**. A single-section gantt with 2-3 tasks is a bullet list with bars; drop it and render as numbered prose.",
  "    · `title` plain text — NO quotes, NO `:` inside.",
  "    · `dateFormat` is `YYYY-MM` (months) or `YYYY-MM-DD` (days). Pick one and stick to it.",
  "    · Each task line: `Label :id, start, duration` — `start` is either an absolute date matching dateFormat OR `after {otherId}`. Duration is `Nd` / `Nw` / `Nm` (days/weeks/months).",
  "    · Section headers (`section Name`) group tasks. 2–4 sections, 2–6 tasks per section.",
  "    · Task labels: NO `:`, NO `\"`, NO commas, NO brackets. Replace with ` - ` if needed.",
  "    · NO blank lines inside the fenced block.",
  "",
  "  ### sequenceDiagram · actor interactions over time",
  "  Use when a section describes a multi-party negotiation, a system-call sequence, or a step-by-step protocol where the *order of who-talks-to-whom* matters. Best fit: technical workflow rooms, governance / approval-chain briefs.",
  "    ```",
  "    sequenceDiagram",
  "        participant U as User",
  "        participant S as Service",
  "        participant A as Auth",
  "        U->>S: Request resource",
  "        S->>A: Validate token",
  "        A-->>S: Token valid",
  "        S-->>U: Resource",
  "    ```",
  "  Hard rules:",
  "    · **Complexity floor · ≥ 2 participants AND ≥ 4 message lines**. A 3-message diagram between 2 actors is just a bullet list with arrow glyphs — drop it and render as prose.",
  "    · `participant {alias} as {Display Name}` — short ASCII alias on the left, display name on the right. Use the alias in the message lines.",
  "    · Message arrows: `->>` for solid (request), `-->>` for dashed (response). NEVER use plain `->` (renders as a bare line).",
  "    · Message text after the colon: NO `:`, NO `\"` — bare text. ≤ 6 words per line.",
  "    · 2–4 participants, 4–8 message lines. Above that the diagram becomes a wall.",
  "    · NO blank lines inside the fenced block. Indent body lines 4 spaces.",
  "",
  "  ### journey · user / stakeholder journey scoring",
  "  Use when a section maps how a stakeholder experiences a process — best for product / UX rooms scoring touchpoints, or for adoption-friction analysis (\"the buyer's journey from awareness to renewal\"). Each step gets a 1–5 score for satisfaction.",
  "    ```",
  "    journey",
  "        title Stakeholder adoption journey",
  "        section Awareness",
  "            Hear about it: 3: Buyer",
  "            Read landing page: 4: Buyer",
  "        section Trial",
  "            Sign up: 2: Buyer",
  "            First task: 1: Buyer, IT",
  "        section Adopt",
  "            Approve rollout: 4: Buyer, Legal",
  "    ```",
  "  Hard rules:",
  "    · `title` plain text — NO quotes.",
  "    · Each step: `Step text: score: Actor[, Actor2]` — score is 1–5 (5 = best). Actors comma-separated.",
  "    · Step text: NO `:`, NO `\"`. ≤ 6 words.",
  "    · 2–4 sections, 2–4 steps per section.",
  "    · NO blank lines inside the fenced block. Indent body lines 4 spaces.",
  "",
  "  ### stateDiagram · lifecycle / phase transitions",
  "  Use when a section names a process with discrete states the subject moves between (deal lifecycle, customer onboarding, product evolution, regulatory approval phases, scenario branching with feedback loops). Reads cleaner than a flowchart when the *states themselves* are the load-bearing concept, not the conditions. Best fit: execution-plan rollouts with stage gates, market-evolution narratives, retro post-mortems where the system passed through phases.",
  "    ```",
  "    stateDiagram-v2",
  "        [*] --> Discovery",
  "        Discovery --> Pilot: Hypothesis validated",
  "        Pilot --> Scale: Pilot win-rate >= 60%",
  "        Pilot --> Iterate: Pilot below threshold",
  "        Iterate --> Pilot",
  "        Scale --> [*]",
  "    ```",
  "  Hard rules:",
  "    · **Complexity floor · ≥ 4 states AND at least one cycle / back-transition** (a state that loops back, OR a state that branches into 2+ next states). A pure linear `Discovery → Pilot → Scale` chain is a flowchart waiting to happen — drop it and use prose. The thing that justifies a stateDiagram (vs a flowchart or prose) is the back-transition / cycle.",
  "    · First line is `stateDiagram-v2` (the v2 dialect — older `stateDiagram` syntax has lexer quirks). Indent body lines 4 spaces.",
  "    · `[*]` is the start / end pseudo-state. Use `[*] --> First` for entry and `Last --> [*]` for exit. Both are optional.",
  "    · Each transition: `From --> To` or `From --> To: condition label`. Condition label is plain text after `:` — NO `\"`, NO additional `:`, NO `[` `]` inside.",
  "    · State names: ASCII identifiers (alphanumerics + underscore), ≤ 20 chars, no spaces. Use camelCase or snake_case. The diagram caption can carry the human-readable label via composite states (skip if not needed).",
  "    · 4–7 states (after the floor). Below 4 isn't a lifecycle; above 7 stops being scannable.",
  "    · NO blank lines inside the fenced block.",
  "",
  "  ## Recommendations",
  "  Skip if `recommendations` is empty. Otherwise render as a numbered list, one per recommendation, sorted by priority. Each item:",
  "    1. **`P0`** **{action}**",
  "       _Rationale:_ {rationale}",
  "       _Owner:_ {ownerType} · _Horizon:_ {horizon}",
  "       _Success metric:_ {successMetric}",
  "       _Critical dependency:_ {criticalDependency}",
  "       _Risk if skipped:_ {riskIfSkipped}",
  "       _What this earns:_ {expectedBenefit}",
  "    Use **`P0`** / **`P1`** / **`P2`** as priority badges (literal backticked text, bolded). Each numbered item gets one blank line before the next.",
  "    The _Critical dependency_ line is the load-bearing pre-condition — what MUST be true for this action to actually work. Render it whenever `criticalDependency` is non-empty; skip the line only on legacy scaffolds where the field is absent.",
  "    The _What this earns_ line is the upside payoff in a stakeholder's language (revenue captured / risk avoided / position locked in / time saved). Render it whenever `expectedBenefit` is non-empty; skip the line only when the field is absent or empty. This is the line that gets the action approved — without it, the recommendation reads as cost without payoff.",
  "    Length budget · the WHOLE Recommendations section should land between 1,500 and 2,500 characters total. Per item: ~400–600 chars including all the labelled lines. The Rationale field is the only one that benefits from elaboration (1–2 sentences); every other labelled line is a single phrase or clause. Keep the action / metric / risk / dependency / benefit lines tight — verbose action items get skipped.",
  "",
  "  ## Risk Register",
  "  Skip if `riskRegister` is empty / null. Otherwise render TWO complementary blocks (in this order):",
  "",
  "    1. **Severity × Likelihood quadrant** — fenced `quadrantChart` plotting every risk on a 2-axis grid. Top-right = address now; top-left = monitor closely; bottom-right = accept the trade; bottom-left = log only. Layout each risk's coordinates from its `severity` × `likelihood`:",
  "       severity high   → y ≈ 0.80 · medium → y ≈ 0.50 · low → y ≈ 0.20",
  "       likelihood high → x ≈ 0.80 · medium → x ≈ 0.50 · low → x ≈ 0.20",
  "       Add slight jitter (±0.05) when 2+ risks would land on the same coordinate. Use the risk's first 4–6 words (or a tightened paraphrase) as the item label — keep ≤ 24 chars per label, follow the same ASCII / no-`:` / no-quote rules from the `quadrant-chart` spec above.",
  "       ```",
  "       quadrantChart",
  "           title \"Risks: severity × likelihood\"",
  "           x-axis \"Low likelihood\" --> \"High likelihood\"",
  "           y-axis \"Low severity\" --> \"High severity\"",
  "           quadrant-1 \"Address now\"",
  "           quadrant-2 \"Monitor closely\"",
  "           quadrant-3 \"Log only\"",
  "           quadrant-4 \"Accept the trade\"",
  "           \"Channel concentration\": [0.80, 0.80]",
  "           \"Hiring bench thin\": [0.50, 0.20]",
  "       ```",
  "       Leave a BLANK LINE between the H2 heading and the fenced ```mermaid block.",
  "",
  "    2. **Risk table** — markdown table with columns `Risk | Category | Severity | Likelihood | Owner | Mitigation`. One row per `RiskItem`. Sort rows: severity high before medium before low; within the same severity, likelihood high before medium before low. Render category and severity / likelihood as **bold inline tags** (`**Market**`, `**High**`). Leave a BLANK LINE between the quadrant chart and the table header row · without that gap markdown parsers concatenate the prose with the table and pipe syntax leaks.",
  "       When `mitigation` is the literal string `\"monitor only\"`, render the cell as italic: `_monitor only_` so the reader sees this row as a watch-list rather than a closeable risk.",
  "",
  "  Section title alternatives — pick one that matches the brief's voice: \"Risk Register\" (default · McKinsey/Gartner), \"Standing Risks\" (a16z), \"Risks We're Carrying\" (Anthropic-essay).",
  "",
  "  ## A Comparison",
  "  Skip if `pathComparison` is null. Otherwise emit a fenced ```path-comparison block · the renderer turns the strict JSON into a 2-column structured view (mono verdict tag + serif path name + bullet characteristics, accent-colour-coded by stance). Same dispatch pattern as `metric-strip`. The fenced JSON is the WHOLE rendering — do NOT also write a markdown table of the same content.",
  "    ```path-comparison",
  '    {',
  '      \"intro\": \"{pathComparison.intro · or empty string when null}\",',
  '      \"paths\": [',
  '        {',
  '          \"verdict\": \"{paths[0].verdict}\",',
  '          \"stance\": \"{paths[0].stance}\",',
  '          \"name\": \"{paths[0].name}\",',
  '          \"characteristics\": [\"...\", \"...\", \"...\", \"...\"]',
  '        },',
  '        {',
  '          \"verdict\": \"{paths[1].verdict}\",',
  '          \"stance\": \"{paths[1].stance}\",',
  '          \"name\": \"{paths[1].name}\",',
  '          \"characteristics\": [\"...\", \"...\", \"...\", \"...\"]',
  '        }',
  '      ],',
  '      \"implication\": \"{pathComparison.implication · or omit the field when null}\"',
  '    }',
  "    ```",
  "  Hard rules:",
  "    · The fence info-string is exactly `path-comparison` (no version, no extras). The renderer dispatches on this string.",
  "    · Strict JSON inside · no comments, no trailing commas. Newlines inside string values must be escaped as `\\n`.",
  "    · EXACTLY 2 entries in `paths` — the component is binary. If the scaffold somehow gives more or fewer, render the first 2 / pad with the available one.",
  "    · stance values: literal `weak` / `strong` / `neutral`. The renderer falls back to `neutral` for anything else.",
  "    · 4-6 characteristics per path. Each ≤ 110 chars. Avoid sentence-ending punctuation; these read as fragments.",
  "    · Section title alternatives — pick one that matches the brief's voice: \"A Comparison\" (default · anthropic-essay), \"Two Trajectories\" (gartner / a16z), \"Side by Side\" (mckinsey), \"对比 / 两条路径\" (zh).",
  "    · Leave a BLANK LINE between the H2 heading and the fenced block.",
  "",
  "  ## Decision Options",
  "  Skip if `decisionOptions` is null. Otherwise render the comparison as a structured block:",
  "    1. Optional one-sentence intro from `decisionOptions.intro` (skip the sentence if intro is empty).",
  "    2. For each option (RECOMMENDED option first, then the rest in array order):",
  "       ### {label} {RECOMMENDED badge if recommended}",
  "       The recommended badge is the literal text `**✓ Recommended**` immediately after the H3 label, separated by a single space. Other options get no badge.",
  "       Body line 1 (italic summary): `_{summary}_`",
  "       Then a 2-column markdown table `Pros | Cons` — one cell row per pro/con (pad shorter side with empty cells so rows align).",
  "       Body line under the table (mono caps for the tags): `**Effort:** {effort} · **Confidence:** {confidence}`. Use the literal title-cased values (Low / Medium / High).",
  "    3. Final paragraph: `**Why {recommended.label}:** {rationale}` — the takeaway anchored to the recommended option.",
  "  Section title alternatives: \"Decision Options\" (default), \"Options We Weighed\" (Anthropic-essay), \"The Path We're Recommending\" (a16z).",
  "  Leave a BLANK LINE between the section H2 and the first H3 option, AND between each option's table and the next H3 — without those gaps the table syntax leaks. SAME gluing rule as Risk Register above.",
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
  "  ## Where This Leaves You",
  "  ALWAYS render — this is the report's narrative close. Without it the body ends on a list (Recommendations / Leading Indicators / Open Questions) and the reader experiences \"戛然而止\" — abrupt drop-out. The Closing reorients the reader before the methodology footer.",
  "",
  "  Tight prose paragraph — 3 to 4 sentences, ≤ 360 chars total. NO bullets, NO tables, NO labels (\"Echo:\" / \"Action:\"), NO sub-headings. The structure is internal to the prose:",
  "    1. **ECHO** · paraphrase the bottom line / thesis / working hypothesis in collapsed form. Don't quote it; render its essence in tighter language than the opening did. ≤ 1 sentence.",
  "    2. **ACKNOWLEDGE** · name the unresolved unknown that would change the call. Pull from highest-priority `openQuestions` (P0 first), or the most fragile entry in `criticalAssumptions`, or a load-bearing `riskRegister` row, or the SPA falsifier. Skip this beat ONLY when the room genuinely surfaced no real uncertainty. ≤ 1 sentence.",
  "    3. **POINT FORWARD** · one specific next move. From `recommendations[0].action` collapsed to ≤ 16 words, or `theBet.commitment`, or for considerations: \"the next thing worth testing is X\". Imperative, concrete, not a meta-instruction. ≤ 1 sentence.",
  "",
  "  House style alternatives for the section title (override the default \"Where This Leaves You\"):",
  "    · mckinsey-deck → \"Next Steps\"",
  "    · a16z-thesis → \"If This Holds\"",
  "    · gartner-research → \"What to Watch\"",
  "    · anthropic-essay → \"Where We Are Left\"",
  "    · boardroom-default / 8bit / others → \"Where This Leaves You\"",
  "",
  "  Voice register applies (mckinsey is imperative, anthropic is reflective, a16z is implicational), but the 3-sentence Echo→Acknowledge→Point-Forward structure is INVARIANT across styles. If you find yourself writing a 4th paragraph or > 360 chars or adding bullets, you've over-built it — the Closing's whole job is the felt close, a tight prose moment.",
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
  "  ### scenarioTree (2–4 named futures, side-by-side comparison TABLE)",
  "  When `scaffold.scenarioTree` is non-null AND was picked, render it AFTER critical assumptions as a markdown table — NOT as nested H3 subsections. Scenarios are inherently a comparison artifact (\"if A then X, if B then Y, if C then Z\"); a table surfaces that comparison directly. The previous nested-H3 format produced a vertical wall of repeated `_Trigger:_` / `_Effects:_` / `_What this means_` labels per branch and lost the comparison-grid affordance entirely.",
  "    ## Scenario Tree",
  "    {scenarioTree.intro · 1 sentence framing the tree.}",
  "",
  "    | Scenario | Probability | Trigger | Key Effects | Decision Implication |",
  "    | --- | --- | --- | --- | --- |",
  "    | **{label}** | {probability}% | {trigger} | {effects joined by ` · `} | {decisionImplication} |",
  "    Sort rows descending by probability so the most likely scenario reads first. **Bold the scenario name** in the first cell so it anchors the row. The Effects cell joins the 3 effects with ` · ` (space-middot-space) into one cell — keep each effect short (≤ 12 words) so the cell wraps cleanly. Trigger + Decision Implication stay as single short sentences per row. Probabilities visible inline make scenario weights legible at a glance.",
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
  "    Don't pad the section with prose — the table IS the section. The voice register from the picked house style applies, but the table structure stays identical across styles. Threats here name the limits of the *analysis*, not the limits of the *recommendation* (recommendation-failure goes in risk-register when picked).",
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
  "         _What this could earn:_ {expectedBenefit}",
  "  No P0/P1/P2 priority badges in this voice — the priority is implicit in the order. Use \"might\", \"could\", \"worth considering\" instead of \"do\" / \"build\" / \"ship\". The data is the same as recommendations; the words around it are softer.",
  "  Render the _What this could earn_ line whenever `expectedBenefit` is non-empty; skip the line when the field is absent. In hedged voice, this is the upside if the consideration is taken — phrased as a possibility (\"could capture\", \"may unlock\", \"would let us hold\") rather than a guaranteed outcome.",
  "",
  "## Editorial components (optional · use sparingly · 0–2 per brief)",
  "",
  "These are decorative fenced-block components the renderer styles into magazine-grade interludes. Each instance should EARN its space — over-using them dilutes the research-note voice. Skip entirely when no natural fit; silence beats forced theatre.",
  "",
  "  ### Display pull-quote · for the room's signature line",
  "",
  "  When ONE director phrasing captures the central tension or breakthrough that the brief is built around, lift it into a display pull-quote. Natural slot is right after `## Where We Converged`, or after the Headline Finding whose argument the quote lands. Maximum ONE per brief.",
  "    ```callout-display-quote",
  "    The model is not the moat. We can replicate any of these capabilities in a week. What we cannot replicate is the depth of a customer's workflow accumulated over years.",
  "",
  "    — First Principles",
  "    ```",
  "  · First paragraph(s) = the quote (italic serif 24px with a decorative `\"` glyph). Last line starting with `—` (em-dash) = attribution (director name, optionally `· lens`). Trim to ≤ 50 words.",
  "  · Use the director's own words from their signal text. Don't paraphrase — the point is verbatim impact.",
  "  · Skip when no quote is genuinely memorable. Don't manufacture one.",
  "",
  "  ### Sidebar callouts · case study / counterpoint / quote / note",
  "",
  "  Boxed interludes for evidence anchors and asides that don't fit linearly. Render as a fenced block; first non-empty line = title (serif headline); rest = paragraph body (sans). Each variant gets its own kicker label.",
  "    ```callout-case-study",
  "    Stripe's 2014–2017 trajectory",
  "",
  "    Stripe held workflow embedding above all else from year one — every product decision routed through \"does this make us harder to leave?\" The data flywheel they built in the first 18 months still compounds today.",
  "    ```",
  "  Variants — pick the closest fit:",
  "    · `callout-case-study` · a real-world anchor exemplifying a finding (a company, a region, a historical episode). Best when the brief leans on one concrete precedent.",
  "    · `callout-counterpoint` · a substantive opposing view that didn't earn its own divergence row but is worth surfacing. Use to demonstrate that the conclusion held up to a real challenge.",
  "    · `callout-quote` · a director's verbatim line as evidence (italic serif body register). Use when the line is supporting argument, not signature — for the signature line, use `callout-display-quote` instead.",
  "    · `callout-note` · short methodological aside or caveat. Use sparingly — most asides belong in Methodology.",
  "  · 0–3 callouts per brief total. Density above this turns the report into a sidebar collage.",
  "",
  "  ### Part-cover divider · for long briefs with discrete movements",
  "",
  "  When the brief has clearly distinct movements that read as separate conversations (e.g. \"The Diagnosis\" → \"The Action\" → \"The Watch List\"), insert a part-cover banner BEFORE each new movement. Skip entirely for single-movement briefs (most briefs).",
  "    ```part-cover",
  "    Part Two",
  "    The Operative Constraints",
  "    ```",
  "  · First line = mono kicker (typically `Part {N}` or `Coda` / `Postscript`).",
  "  · Subsequent lines joined = serif title (the part's name, ≤ 8 words).",
  "  · 1–2 banners per brief maximum. The banner forces a page break in PDF — only use when the structural break genuinely earns its own page.",
  "",
  "## Appendices · supplementary detail (optional)",
  "",
  "Render each item in `scaffold.appendices` AFTER all body sections (after Considerations / Recommendations / The Bet / New Questions / Open Questions, etc.) but BEFORE the orchestrator-appended Methodology footer. Skip the entire block when `scaffold.appendices` is empty / null — most briefs have no appendices.",
  "  Each appendix becomes its own H2 section, lettered A / B / C / D in render order:",
  "    ## Appendix A: {scaffold.appendices[0].title}",
  "    {scaffold.appendices[0].bodyMd verbatim — paragraphs, blockquotes, tables, lists all render normally}",
  "  Use this slot for material that's load-bearing for credibility but too dense for the main body: verbatim director exchanges (>80 words), raw signal extracts, supporting calculations, source chains, full transcripts of quoted passages. Don't relocate body sections here — appendix is for ADDITIONAL detail, not for things that should have been in the body.",
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
  "new-questions":         "New Questions This Surfaced",
  "planning-assumption":   "Strategic Planning Assumption",
  "open-questions":        "Open Questions",
  // Note · the always-rendered "Where This Leaves You" closing
  // section is NOT in this dictionary — it's not a composer-picked
  // component, just a structural close. Its heading + house-style
  // alternatives ("Next Steps" / "If This Holds" / "What to Watch")
  // are described directly in the WRITE_SYSTEM section render rule.
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

  // ── Director Perspectives ── ALWAYS-rendered social map of the room.
  const directorPerspectivesBlock = scaffold.directorPerspectives
    ? [
        `  Intro: ${scaffold.directorPerspectives.intro || "(none — H2 heading is the framing)"}`,
        `  Chair synthesis: ${scaffold.directorPerspectives.chairSynthesis || "(none — leave the chair synthesis card empty)"}`,
        ``,
        `  Alignment groups:`,
        ...(scaffold.directorPerspectives.alignment.length
          ? scaffold.directorPerspectives.alignment.map((a, i) =>
              [
                `    Group ${i + 1}: ${a.pointOfAgreement}`,
                `      Directors: ${a.directorIds.map(nameOf).join(", ")}`,
                `      Note: ${a.note || "(none)"}`,
              ].join("\n"),
            )
          : ["    (none — the room had no convergence)"]),
        ``,
        `  Divergence:`,
        ...(scaffold.directorPerspectives.divergence.length
          ? scaffold.directorPerspectives.divergence.map((d, i) =>
              [
                `    Hinge ${i + 1}: ${d.hinge}`,
                ...d.sides.map((s) =>
                  `      Side "${s.label}" — ${s.directorIds.map(nameOf).join(", ")}: ${s.stance}`,
                ),
                `      Resolution: ${d.resolution || "(unresolved)"}`,
              ].join("\n"),
            )
          : ["    (none — the room had no fork)"]),
        ``,
        `  Per-director perspectives:`,
        ...scaffold.directorPerspectives.perspectives.map((p) =>
          [
            `    [${p.directorId}] ${nameOf(p.directorId)} · lens=${p.lens}`,
            `      Stance: ${p.stance}`,
            `      Position: ${p.position}`,
            `      Quote: ${p.quote || "(none)"}`,
          ].join("\n"),
        ),
      ].join("\n")
    : "  (no director-perspectives — only 1 active director · skip the section)";

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
          if (v.type === "strengths-cautions") {
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
          }
          if (v.type === "bar-chart") {
            return [
              `  Visual · bar-chart`,
              `    Title: ${v.title}`,
              `    y-axis: ${v.yLabel}${v.unit ? ` (${v.unit})` : ""}`,
              `    Bars:`,
              ...v.bars.map((b) => `      · ${b.label}: ${b.value}`),
            ].join("\n");
          }
          if (v.type === "timeline") {
            return [
              `  Visual · timeline`,
              `    Title: ${v.title}`,
              `    Points:`,
              ...v.points.map((p) =>
                p.description
                  ? `      · ${p.period} · ${p.label} — ${p.description}`
                  : `      · ${p.period} · ${p.label}`,
              ),
            ].join("\n");
          }
          if (v.type === "pie-chart") {
            return [
              `  Visual · pie-chart`,
              `    Title: ${v.title}`,
              `    Slices:`,
              ...v.slices.map((s) => `      · ${s.label}: ${s.value}`),
            ].join("\n");
          }
          // Defensive · should be unreachable. If a future visual type
          // is added to parseVisual without a matching render branch
          // here, surface it as a generic line rather than crashing
          // mid-pipeline (which previously dropped the user into a
          // broken-brief retry card with "reading 'map'").
          const unknownType = (v as { type?: unknown }).type ?? "unknown";
          return `  Visual · ${String(unknownType)} · (no renderer; skip)`;
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
            ...(r.expectedBenefit ? [`    Expected benefit: ${r.expectedBenefit}`] : []),
          ].join("\n");
        })
        .join("\n\n")
    : "  (no recommendations — skip the section)";

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
            ...(r.expectedBenefit ? [`    Expected benefit: ${r.expectedBenefit}`] : []),
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

  const riskRegisterBlock = scaffold.riskRegister && scaffold.riskRegister.length
    ? scaffold.riskRegister
        .map((r, i) =>
          [
            `  Risk ${i + 1}: ${r.risk}`,
            `    Category: ${r.category}`,
            `    Severity: ${r.severity}`,
            `    Likelihood: ${r.likelihood}`,
            `    Owner: ${r.owner}`,
            `    Mitigation: ${r.mitigation}`,
          ].join("\n"),
        )
        .join("\n\n")
    : "  (no risk-register — composer did not pick this component)";

  const pathComparisonBlock = scaffold.pathComparison
    ? [
        `  Intro: ${scaffold.pathComparison.intro || "(none — H2 heading is the framing)"}`,
        `  Implication: ${scaffold.pathComparison.implication || "(none — omit the implication line)"}`,
        ``,
        ...scaffold.pathComparison.paths.map((p, i) =>
          [
            `  Path ${i + 1} · stance=${p.stance}`,
            `    Verdict: ${p.verdict}`,
            `    Name: ${p.name}`,
            `    Characteristics:`,
            ...p.characteristics.map((c) => `      · ${c}`),
          ].join("\n"),
        ),
      ].join("\n")
    : "  (no path-comparison — composer did not pick this component)";

  const decisionOptionsBlock = scaffold.decisionOptions && scaffold.decisionOptions.options.length
    ? [
        `  Intro: ${scaffold.decisionOptions.intro || "(none — H2 heading is the framing)"}`,
        `  Rationale (anchor for the recommended option): ${scaffold.decisionOptions.rationale || "(none — derive from option summaries)"}`,
        ``,
        ...scaffold.decisionOptions.options.map((o, i) =>
          [
            `  Option ${i + 1}: ${o.label}${o.recommended ? " · RECOMMENDED" : ""}`,
            `    Summary: ${o.summary}`,
            `    Pros:`,
            ...o.pros.map((p) => `      · ${p}`),
            `    Cons:`,
            ...o.cons.map((c) => `      · ${c}`),
            `    Effort: ${o.effort} · Confidence: ${o.confidence}`,
          ].join("\n"),
        ),
      ].join("\n")
    : "  (no decision-options — composer did not pick this component)";

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

  return [
    {
      role: "system",
      content: [
        WRITE_SYSTEM,
        "",
        languageInstruction(language),
        houseStyleAddendum,
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
        `## Director Perspectives (MANDATORY · the room's social map · views compared)`,
        directorPerspectivesBlock,
        ``,
        `## Visuals`,
        visualsBlock,
        ``,
        `## Recommendations`,
        recsBlock,
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
        `## Risk Register (standing risks · environment / product / team)`,
        riskRegisterBlock,
        ``,
        `## Decision Options (N candidate options · one recommended)`,
        decisionOptionsBlock,
        ``,
        `## Path Comparison (binary structural · 2 paths · verdict-tagged)`,
        pathComparisonBlock,
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
        `Write the final report now. Markdown only (the metricStrip / path-comparison / views-compared fenced blocks are embedded HTML — every other section is markdown). Start with the H2 title — no preamble. Replace director ids with display names from the directors list above. Follow the section order: Bottom Line / Thesis / Working Hypothesis (anchor) → Metric Strip (when picked) → Strategic Outlook (when picked) → Frame Shift → Headline Findings (or Big Ideas) → Where We Converged → Where We Diverged → Positions → Views Compared (MANDATORY when ≥ 2 active directors) → A Comparison (when picked · path-comparison) → Options Analysis / Two Paths → Decision Options (when picked) → Critical Assumptions (when picked) → Threats to Validity (when picked) → Scenario Tree (when picked) → Why Now (when picked) → Risk Register (when picked) → New Questions This Surfaced → Strategic Planning Assumption → Open Questions → Recommendations / The Bet / Considerations (action) → Leading Indicators (when picked) → Where This Leaves You (ALWAYS — narrative close that reorients the reader). The Closing is the report's last body section before the methodology footer; without it the report ends on a list and feels truncated. Render order is now uncertainty-then-action: lay out what's true / what's still open BEFORE telling the user what to do, so the action sits at the end where it lands hardest.`,
      ].join("\n"),
    },
  ];
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

/** Validate + coerce a single director's stage-1 output into an asset
 *  bundle. Each of the 9 fields is parsed independently — a malformed
 *  entry inside one field doesn't poison the others, and a completely
 *  malformed field falls back to `[]` rather than failing the whole
 *  director. The per-field cap (ASSET_CAPS) drops overflow entries
 *  past the limit. Empty bundles are valid (`{ ..., claims: [], ... }`)
 *  and the composer / scaffold treat them as "this director said
 *  nothing worth preserving" — same semantics as the legacy
 *  `signals: []` case. */
export function parseDirectorAssets(
  raw: string,
  director: Agent,
): DirectorAssets {
  const empty: DirectorAssets = {
    directorId: director.id,
    directorName: director.name,
    claims: [], evidence: [], tensions: [], assumptions: [],
    risks: [], opportunities: [], actions: [], quotes: [], openQuestions: [],
  };
  const parsed = extractJson<Record<string, unknown>>(raw);
  if (!parsed || typeof parsed !== "object") return empty;
  return {
    directorId: director.id,
    directorName: director.name,
    claims: parseAssetClaims(parsed.claims),
    evidence: parseAssetEvidence(parsed.evidence),
    tensions: parseAssetTensions(parsed.tensions),
    assumptions: parseAssetAssumptions(parsed.assumptions),
    risks: parseAssetRisks(parsed.risks),
    opportunities: parseAssetOpportunities(parsed.opportunities),
    actions: parseAssetActions(parsed.actions),
    quotes: parseAssetQuotes(parsed.quotes),
    openQuestions: parseAssetOpenQuestions(parsed.openQuestions),
  };
}

/** Parse a per-asset `sources` array (0-based message indices). Tolerant:
 *  drops anything non-numeric / negative, keeps the rest. Returns [] for
 *  any non-array input. Non-empty result is the entry's eligibility gate
 *  upstream — entries with no parseable source are dropped. */
function parseSourceArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const n of v) {
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) {
      out.push(Math.floor(n));
    }
  }
  return out;
}

function parseAssetClaims(v: unknown): AssetClaim[] {
  if (!Array.isArray(v)) return [];
  const out: AssetClaim[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const lens = typeof o.lens === "string" ? o.lens.trim() : "";
    const sources = parseSourceArray(o.sources);
    if (!text || !(EVIDENCE_LENSES as readonly string[]).includes(lens) || sources.length === 0) continue;
    const cRaw = typeof o.confidence === "string" ? o.confidence.trim() : "";
    const claim: AssetClaim = { text, lens: lens as EvidenceLens, sources };
    if (cRaw === "high" || cRaw === "medium" || cRaw === "low") claim.confidence = cRaw;
    out.push(claim);
    if (out.length >= ASSET_CAPS.claims) break;
  }
  return out;
}

function parseAssetEvidence(v: unknown): AssetEvidence[] {
  if (!Array.isArray(v)) return [];
  const out: AssetEvidence[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const sources = parseSourceArray(o.sources);
    if (!text || sources.length === 0) continue;
    const kRaw = typeof o.kind === "string" ? o.kind.trim() : "";
    const kind = (kRaw === "data" || kRaw === "case" || kRaw === "quote") ? kRaw : "case";
    out.push({ text, kind, sources });
    if (out.length >= ASSET_CAPS.evidence) break;
  }
  return out;
}

function parseAssetTensions(v: unknown): AssetTension[] {
  if (!Array.isArray(v)) return [];
  const out: AssetTension[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const sources = parseSourceArray(o.sources);
    if (!text || sources.length === 0) continue;
    const withArr = Array.isArray(o.with)
      ? o.with.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim())
      : [];
    out.push({ text, with: withArr, sources });
    if (out.length >= ASSET_CAPS.tensions) break;
  }
  return out;
}

function parseAssetAssumptions(v: unknown): AssetAssumption[] {
  if (!Array.isArray(v)) return [];
  const out: AssetAssumption[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const sources = parseSourceArray(o.sources);
    if (!text || sources.length === 0) continue;
    const entry: AssetAssumption = { text, sources };
    const fals = typeof o.falsifier === "string" ? o.falsifier.trim() : "";
    if (fals) entry.falsifier = fals;
    out.push(entry);
    if (out.length >= ASSET_CAPS.assumptions) break;
  }
  return out;
}

function parseAssetRisks(v: unknown): AssetRisk[] {
  if (!Array.isArray(v)) return [];
  const out: AssetRisk[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const sources = parseSourceArray(o.sources);
    if (!text || sources.length === 0) continue;
    const sev = typeof o.severity === "string" ? o.severity.trim() : "";
    const entry: AssetRisk = { text, sources };
    if (sev === "high" || sev === "medium" || sev === "low") entry.severity = sev;
    out.push(entry);
    if (out.length >= ASSET_CAPS.risks) break;
  }
  return out;
}

function parseAssetOpportunities(v: unknown): AssetOpportunity[] {
  if (!Array.isArray(v)) return [];
  const out: AssetOpportunity[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const sources = parseSourceArray(o.sources);
    if (!text || sources.length === 0) continue;
    out.push({ text, sources });
    if (out.length >= ASSET_CAPS.opportunities) break;
  }
  return out;
}

function parseAssetActions(v: unknown): AssetAction[] {
  if (!Array.isArray(v)) return [];
  const out: AssetAction[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const sources = parseSourceArray(o.sources);
    if (!text || sources.length === 0) continue;
    const entry: AssetAction = { text, sources };
    const owner = typeof o.owner === "string" ? o.owner.trim() : "";
    const horizon = typeof o.horizon === "string" ? o.horizon.trim() : "";
    if (owner) entry.owner = owner;
    if (horizon) entry.horizon = horizon;
    out.push(entry);
    if (out.length >= ASSET_CAPS.actions) break;
  }
  return out;
}

function parseAssetQuotes(v: unknown): AssetQuote[] {
  if (!Array.isArray(v)) return [];
  const out: AssetQuote[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const sources = parseSourceArray(o.sources);
    if (!text || sources.length === 0) continue;
    out.push({ text, sources });
    if (out.length >= ASSET_CAPS.quotes) break;
  }
  return out;
}

function parseAssetOpenQuestions(v: unknown): AssetOpenQuestion[] {
  if (!Array.isArray(v)) return [];
  const out: AssetOpenQuestion[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    const sources = parseSourceArray(o.sources);
    if (!text || sources.length === 0) continue;
    const pRaw = typeof o.priority === "string" ? o.priority.trim() : "";
    const priority: "P0" | "P1" | "P2" = (pRaw === "P0" || pRaw === "P1" || pRaw === "P2") ? pRaw : "P1";
    out.push({ text, priority, sources });
    if (out.length >= ASSET_CAPS.openQuestions) break;
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

/** Soft cap on scaffold title length. The writer prompt says 8–18 words
 *  with a quantified element when possible, but the LLM occasionally
 *  produces a 24-word run-on (e.g. "X closes Y and forces Z to do W").
 *  When the title exceeds 20 words AND a natural break exists (em-dash,
 *  semicolon, " — and ", " · "), truncate at the break to land ≤ 18.
 *  When no natural break exists, leave the title as-is — silent mid-
 *  sentence truncation reads worse than a long title. The writer
 *  prompt's "rewrite if topic-style or > 18 words" rule then covers
 *  the remaining case at H2 emission time. */
function compressLongTitle(title: string): string {
  const wordCount = title.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 20) return title;
  const breakPatterns = [
    /\s+[—–]\s+/,    // em-dash / en-dash
    /\s*;\s+/,       // semicolon
    /\s+·\s+/,       // middle dot separator
  ];
  for (const re of breakPatterns) {
    const m = re.exec(title);
    if (!m) continue;
    const head = title.slice(0, m.index).trim();
    const headWords = head.split(/\s+/).filter(Boolean).length;
    if (headWords >= 4 && headWords <= 18) return head;
  }
  return title;
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
    const criticalDependency = typeof o.criticalDependency === "string" ? o.criticalDependency.trim() : "";
    const expectedBenefit = typeof o.expectedBenefit === "string" ? o.expectedBenefit.trim() : "";
    out.push({
      priority: parsePriority(o.priority),
      action,
      rationale: typeof o.rationale === "string" ? o.rationale.trim() : "",
      ownerType: typeof o.ownerType === "string" ? o.ownerType.trim() : "",
      horizon: typeof o.horizon === "string" ? o.horizon.trim() : "",
      successMetric: typeof o.successMetric === "string" ? o.successMetric.trim() : "",
      riskIfSkipped: typeof o.riskIfSkipped === "string" ? o.riskIfSkipped.trim() : "",
      ...(criticalDependency ? { criticalDependency } : {}),
      ...(expectedBenefit ? { expectedBenefit } : {}),
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

const RISK_CATEGORIES: readonly RiskCategory[] = [
  "market", "execution", "product", "team", "financial", "compliance", "technical",
];

function parseRiskRegister(raw: unknown): RiskItem[] {
  if (!Array.isArray(raw)) return [];
  const out: RiskItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const risk = typeof o.risk === "string" ? o.risk.trim() : "";
    if (!risk) continue;
    const catRaw = typeof o.category === "string" ? o.category.trim().toLowerCase() : "";
    const category = (RISK_CATEGORIES as readonly string[]).includes(catRaw)
      ? (catRaw as RiskCategory)
      : "execution";
    const sevRaw = typeof o.severity === "string" ? o.severity.trim().toLowerCase() : "";
    const severity: RiskSeverity =
      sevRaw === "high" || sevRaw === "low" ? sevRaw : "medium";
    const likRaw = typeof o.likelihood === "string" ? o.likelihood.trim().toLowerCase() : "";
    const likelihood: RiskLikelihood =
      likRaw === "high" || likRaw === "low" ? likRaw : "medium";
    const owner = typeof o.owner === "string" ? o.owner.trim() : "";
    const mitigation = typeof o.mitigation === "string" ? o.mitigation.trim() : "";
    out.push({
      risk,
      category,
      severity,
      likelihood,
      owner: owner || "—",
      mitigation: mitigation || "monitor only",
    });
    if (out.length >= 7) break;
  }
  return out;
}

function parseDirectorPerspectives(raw: unknown): DirectorPerspectivesBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const intro = typeof o.intro === "string" ? o.intro.trim() : "";
  const chairSynthesis = typeof o.chairSynthesis === "string" ? o.chairSynthesis.trim() : "";

  // Per-director rows · the meat of the section. Each entry must
  // carry directorId + position. Lens defaults to 'structural' when
  // unrecognised so the row still renders.
  const perspectives: DirectorPerspective[] = [];
  if (Array.isArray(o.perspectives)) {
    for (const p of o.perspectives) {
      if (!p || typeof p !== "object") continue;
      const po = p as Record<string, unknown>;
      const directorId = typeof po.directorId === "string" ? po.directorId.trim() : "";
      const stance = typeof po.stance === "string" ? po.stance.trim() : "";
      const position = typeof po.position === "string" ? po.position.trim() : "";
      if (!directorId || !position) continue;
      const lensRaw = typeof po.lens === "string" ? po.lens.trim() : "";
      const lens: EvidenceLens = (EVIDENCE_LENSES as readonly string[]).includes(lensRaw)
        ? (lensRaw as EvidenceLens)
        : "structural";
      const quote = typeof po.quote === "string" ? po.quote.trim() : "";
      perspectives.push({ directorId, stance, position, quote, lens });
    }
  }

  // Alignment groups · each must have ≥ 2 directors AND a name. Drops
  // single-director "groups" (those aren't alignment).
  const alignment: PerspectiveAlignment[] = [];
  if (Array.isArray(o.alignment)) {
    for (const a of o.alignment) {
      if (!a || typeof a !== "object") continue;
      const ao = a as Record<string, unknown>;
      const pointOfAgreement = typeof ao.pointOfAgreement === "string" ? ao.pointOfAgreement.trim() : "";
      const note = typeof ao.note === "string" ? ao.note.trim() : "";
      const directorIds = Array.isArray(ao.directorIds)
        ? ao.directorIds.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim())
        : [];
      if (!pointOfAgreement || directorIds.length < 2) continue;
      alignment.push({ pointOfAgreement, directorIds, note });
    }
  }

  // Divergence groups · each must have ≥ 2 sides, each side with ≥ 1
  // director + a stance. Otherwise it's not a real fork.
  const divergence: PerspectiveDivergence[] = [];
  if (Array.isArray(o.divergence)) {
    for (const d of o.divergence) {
      if (!d || typeof d !== "object") continue;
      const dgo = d as Record<string, unknown>;
      const hinge = typeof dgo.hinge === "string" ? dgo.hinge.trim() : "";
      const resolution = typeof dgo.resolution === "string" ? dgo.resolution.trim() : "";
      const sides: PerspectiveDivergence["sides"] = [];
      if (Array.isArray(dgo.sides)) {
        for (const s of dgo.sides) {
          if (!s || typeof s !== "object") continue;
          const so = s as Record<string, unknown>;
          const label = typeof so.label === "string" ? so.label.trim() : "";
          const stance = typeof so.stance === "string" ? so.stance.trim() : "";
          const ids = Array.isArray(so.directorIds)
            ? so.directorIds.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
            : [];
          if (!label || !stance || ids.length === 0) continue;
          sides.push({ label, directorIds: ids, stance });
        }
      }
      if (!hinge || sides.length < 2) continue;
      divergence.push({ hinge, sides, resolution });
    }
  }

  // The block is meaningful only when ≥ 2 directors actually have
  // perspectives. Below that, return null so Stage 3 renders the
  // section as skipped (single-director rooms, or extraction failure).
  if (perspectives.length < 2) return null;

  return { intro, alignment, divergence, perspectives, chairSynthesis };
}

function parsePathComparison(raw: unknown): PathComparisonBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const intro = typeof o.intro === "string" ? o.intro.trim() : "";
  const implRaw = typeof o.implication === "string" ? o.implication.trim() : "";
  if (!Array.isArray(o.paths)) return null;
  const parsed: ComparisonPath[] = [];
  for (const p of o.paths) {
    if (!p || typeof p !== "object") continue;
    const po = p as Record<string, unknown>;
    const verdict = typeof po.verdict === "string" ? po.verdict.trim() : "";
    const name = typeof po.name === "string" ? po.name.trim() : "";
    if (!verdict || !name) continue;
    const stRaw = typeof po.stance === "string" ? po.stance.trim().toLowerCase() : "";
    const stance: ComparisonPath["stance"] =
      stRaw === "strong" || stRaw === "weak" ? stRaw : "neutral";
    const characteristics = Array.isArray(po.characteristics)
      ? po.characteristics
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, 6)
      : [];
    if (characteristics.length < 2) continue;
    parsed.push({ verdict, stance, name, characteristics });
    if (parsed.length >= 2) break;
  }
  // Component is binary by design · need exactly 2 valid paths.
  if (parsed.length !== 2) return null;
  const block: PathComparisonBlock = {
    intro,
    paths: [parsed[0], parsed[1]],
  };
  if (implRaw) block.implication = implRaw;
  return block;
}

function parseDecisionOptions(raw: unknown): DecisionOptionsBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const intro = typeof o.intro === "string" ? o.intro.trim() : "";
  const rationale = typeof o.rationale === "string" ? o.rationale.trim() : "";
  if (!Array.isArray(o.options)) return null;
  const options: DecisionOption[] = [];
  for (const opt of o.options) {
    if (!opt || typeof opt !== "object") continue;
    const oo = opt as Record<string, unknown>;
    const label = typeof oo.label === "string" ? oo.label.trim() : "";
    const summary = typeof oo.summary === "string" ? oo.summary.trim() : "";
    if (!label) continue;
    const pros = Array.isArray(oo.pros)
      ? oo.pros.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()).slice(0, 4)
      : [];
    const cons = Array.isArray(oo.cons)
      ? oo.cons.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()).slice(0, 4)
      : [];
    const effRaw = typeof oo.effort === "string" ? oo.effort.trim().toLowerCase() : "";
    const effort: DecisionOption["effort"] =
      effRaw === "low" || effRaw === "high" ? effRaw : "medium";
    const confRaw = typeof oo.confidence === "string" ? oo.confidence.trim().toLowerCase() : "";
    const confidence: Confidence =
      confRaw === "high" || confRaw === "low" ? confRaw : "medium";
    const recommended = oo.recommended === true;
    options.push({ label, summary, pros, cons, effort, confidence, recommended });
    if (options.length >= 5) break;
  }
  if (options.length < 2) return null;
  // Force exactly one `recommended: true`. If the model marked zero or
  // multiple, pick the first option as the recommendation. Better to
  // surface SOMETHING than render a comparison with no winner.
  const recCount = options.filter((o) => o.recommended).length;
  if (recCount !== 1) {
    options.forEach((o, i) => { o.recommended = i === 0; });
  }
  return { intro, options, rationale };
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

/** Validate + coerce the chair's stage-2 scaffold.
 *
 *  Validity floor: at minimum the scaffold must carry a load-bearing
 *  anchor (bottomLine OR thesis OR workingHypothesis) AND a load-
 *  bearing findings block (≥ 1 headlineFinding OR a complete bigIdeas
 *  array). Other sections fall back to empty / null / default.
 *
 *  Substitute fields (`thesis`, `bigIdeas`, `theBet`) are net-additive:
 *  the parser returns them when filled and `null` otherwise. The
 *  renderer's "skip if empty" rules do the rest.
 */
export function parseScaffold(
  raw: string,
  fallbackTitle: string,
  fallbackOriginalQuestion: string,
): BriefScaffold | null {
  const parsed = extractJson<Record<string, unknown>>(raw);
  if (!parsed) return null;

  const titleRaw = typeof parsed.title === "string" && parsed.title.trim()
    ? parsed.title.trim()
    : fallbackTitle;
  const title = compressLongTitle(titleRaw);

  // Anchor · at minimum one of bottomLine / thesis / workingHypothesis.
  const bottomLine = parseBottomLine(parsed.bottomLine, title);
  const thesis = parseThesis(parsed.thesis);
  const workingHypothesis = parseWorkingHypothesis(parsed.workingHypothesis);
  const hasAnchor =
    (bottomLine.judgement && bottomLine.judgement.trim().length > 0) ||
    (thesis && thesis.claim.length > 0) ||
    (workingHypothesis && workingHypothesis.hypothesis.length > 0);
  if (!hasAnchor) return null;

  // Findings · either headlineFindings (≥1) or bigIdeas (=3).
  const findingsRaw = Array.isArray(parsed.headlineFindings) ? parsed.headlineFindings : [];
  const headlineFindings: HeadlineFinding[] = [];
  for (const f of findingsRaw) {
    const parsedF = parseHeadlineFinding(f);
    if (parsedF) headlineFindings.push(parsedF);
    if (headlineFindings.length >= 3) break;
  }
  const bigIdeas = parseBigIdeas(parsed.bigIdeas);
  if (headlineFindings.length < 1 && !bigIdeas) return null;

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
    newQuestions: parseNewQuestions(parsed.newQuestions),
    planningAssumption: parsePlanningAssumption(parsed.planningAssumption),
    strategicOutlook: parseStrategicOutlook(parsed.strategicOutlook),
    criticalAssumptions: parseCriticalAssumptions(parsed.criticalAssumptions),
    scenarioTree: parseScenarioTree(parsed.scenarioTree),
    leadingIndicators: parseLeadingIndicators(parsed.leadingIndicators),
    threatsToValidity: parseThreatsToValidity(parsed.threatsToValidity),
    riskRegister: parseRiskRegister(parsed.riskRegister),
    decisionOptions: parseDecisionOptions(parsed.decisionOptions),
    pathComparison: parsePathComparison(parsed.pathComparison),
    directorPerspectives: parseDirectorPerspectives(parsed.directorPerspectives),
    metricStrip: parseMetricStrip(parsed.metricStrip),
    appendices: parseAppendices(parsed.appendices),
    openQuestions: parseOpenQuestions(parsed.openQuestions),
  };
}

/* ──────────────────────── Bento parser ─────────────────────────────
 * Tolerant JSON parser for the bento-mode scaffold. Returns null when
 * the LLM produced an unusable shape (no parseable JSON, no milestones,
 * no title — any of these is a fail). The orchestrator surfaces a
 * clear error to the user rather than rendering a half-empty bento.
 *
 * Field-level tolerance: each slot's parser clamps strings to the
 * declared char limits, drops malformed array entries, and falls back
 * to safe defaults. The bento body is shorter than the research-note
 * scaffold, so parser leniency is less important — but the same
 * "best-effort, never throw" pattern keeps the pipeline resilient. */
export function parseBento(
  raw: string,
  fallbackTitle: string,
  fallbackSource: string,
  fallbackFooterTag: string,
): BentoScaffold | null {
  const parsed = extractJson<Record<string, unknown>>(raw);
  if (!parsed) return null;

  const title = clipString(stringField(parsed.title) || fallbackTitle, 110);
  if (!title) return null;
  const kicker = clipString(stringField(parsed.kicker), 200);
  const source = clipString(stringField(parsed.source) || fallbackSource, 80);

  const milestones = parseBentoMilestones(parsed.milestones);
  if (milestones.length === 0) return null;
  // Pad / trim to exactly 3 milestones · the bento layout reserves 3
  // slots in the left timeline. Fewer leaves the column ragged; more
  // overflows. Pad with placeholder cards built from openQuestions or
  // empty strings; trim to the first 3 by render order.
  while (milestones.length < 3) {
    milestones.push({ period: "", title: "", body: "", callout: "", tags: [] });
  }
  if (milestones.length > 3) milestones.length = 3;

  const rankedBars = parseBentoRankedBars(parsed.rankedBars);
  const verification = parseBentoVerification(parsed.verification);
  const talkingPoints = parseBentoTalkingPoints(parsed.talkingPoints);

  const conclusion = clipString(stringField(parsed.conclusion), 100);
  const flow = parseBentoFlow(parsed.flow);
  const footerTag = clipString(stringField(parsed.footerTag) || fallbackFooterTag, 80);

  return {
    title,
    kicker,
    source,
    milestones,
    rankedBars,
    verification,
    talkingPoints,
    conclusion,
    flow,
    footerTag,
  };
}

function stringField(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clipString(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function parseBentoMilestones(raw: unknown): BentoMilestone[] {
  if (!Array.isArray(raw)) return [];
  const out: BentoMilestone[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    const title = clipString(stringField(o.title), 60);
    const body = clipString(stringField(o.body), 220);
    if (!title || !body) continue;
    const period = clipString(stringField(o.period), 24);
    const callout = clipString(stringField(o.callout), 12);
    const tagsRaw = Array.isArray(o.tags) ? o.tags : [];
    const tags = tagsRaw
      .map((t) => (typeof t === "string" ? clipString(t.trim(), 16) : ""))
      .filter(Boolean)
      .slice(0, 4);
    out.push({ period, title, body, callout, tags });
    if (out.length >= 3) break;
  }
  return out;
}

function parseBentoRankedBars(raw: unknown): BentoRankedBars | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = clipString(stringField(o.title), 40);
  if (!title) return null;
  const entriesRaw = Array.isArray(o.entries) ? o.entries : [];
  const entries: BentoRankedBars["entries"] = [];
  for (const e of entriesRaw) {
    if (!e || typeof e !== "object") continue;
    const eo = e as Record<string, unknown>;
    const label = clipString(stringField(eo.label), 40);
    const value = clipString(stringField(eo.value), 20);
    if (!label || !value) continue;
    const ratioRaw = typeof eo.ratio === "number" ? eo.ratio : 0;
    const ratio = Math.max(0, Math.min(1, Number.isFinite(ratioRaw) ? ratioRaw : 0));
    entries.push({ label, value, ratio });
    if (entries.length >= 5) break;
  }
  if (entries.length < 2) return null;
  return { title, entries };
}

function parseBentoVerification(raw: unknown): BentoVerification | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = clipString(stringField(o.title), 40);
  if (!title) return null;
  const bullets = parseBentoBullets(o.bullets, 140, 5);
  if (bullets.length === 0) return null;
  return { title, bullets };
}

function parseBentoTalkingPoints(raw: unknown): BentoTalkingPoints {
  // ALWAYS rendered · falls back to a default title + empty bullets
  // when the LLM omits this slot. The renderer treats an empty bullets
  // array gracefully (single placeholder line).
  if (!raw || typeof raw !== "object") {
    return { title: "How to say this", bullets: [] };
  }
  const o = raw as Record<string, unknown>;
  const title = clipString(stringField(o.title), 40) || "How to say this";
  const bullets = parseBentoBullets(o.bullets, 120, 5);
  return { title, bullets };
}

function parseBentoBullets(raw: unknown, maxChars: number, maxCount: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const b of raw) {
    const s = typeof b === "string" ? clipString(b.trim(), maxChars) : "";
    if (s) out.push(s);
    if (out.length >= maxCount) break;
  }
  return out;
}

function parseBentoFlow(raw: unknown): BentoFlow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nodesRaw = Array.isArray(o.nodes) ? o.nodes : [];
  const nodes: string[] = [];
  for (const n of nodesRaw) {
    const s = typeof n === "string" ? clipString(n.trim(), 24) : "";
    if (s) nodes.push(s);
    if (nodes.length >= 4) break;
  }
  if (nodes.length < 2) return null;
  const caption = clipString(stringField(o.caption), 60);
  return caption ? { nodes, caption } : { nodes };
}

function parseAppendices(raw: unknown): AppendixItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AppendixItem[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const bodyMd = typeof o.bodyMd === "string" ? o.bodyMd.trim() : "";
    if (!title || !bodyMd) continue;
    out.push({ title, bodyMd });
    if (out.length >= 4) break;
  }
  return out.length ? out : null;
}
