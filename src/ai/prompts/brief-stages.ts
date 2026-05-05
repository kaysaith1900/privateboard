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
export type Visual =
  | ComparisonTableVisual
  | QuadrantChartVisual
  | ForceFieldVisual
  | StrengthsCautionsVisual;

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
  "   · `comparison-table` — when ≥ 2 named options were compared on shared dimensions",
  "   · `quadrant-chart` — when items can be plotted on two real axes",
  "   · `force-field` — drivers vs resistors of one outcome",
  "   · `strengths-cautions` — strengths / cautions / verdict per option",
  "   If the discussion contained ≥ 2 named options or paths, you SHOULD produce ≥ 1 visual.",
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
  '    { "type": "strengths-cautions", "title": "...", "rows": [ { "option": "Option A", "strengths": ["..."], "cautions": ["..."], "verdict": "recommended" } ] }',
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
  "Optional kinds (`frame-shift`, `convergence`, `divergence`, `positions`, `visuals`, `two-paths`, `why-now`, `pre-mortem`, `new-questions`, `planning-assumption`, `open-questions`, `strategic-outlook`, `critical-assumptions`, `scenario-tree`, `leading-indicators`): when listed in the picked set, fill them as the spec above describes. When NOT listed, set them to the empty value (`[]` for arrays, `null` for nullable objects, `{shifted:false, original:'', reframed:'', trigger:''}` for frameShift).",
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

export function buildWriteMessages(opts: WriteOpts): LLMMessage[] {
  const { room, members, scaffold, perDirectorSignals, language, picked } = opts;

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

  return [
    {
      role: "system",
      content: [WRITE_SYSTEM, "", languageInstruction(language)].join("\n"),
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
        `Write the final report now. Markdown only. Start with the H2 title — no preamble. Replace director ids with display names from the directors list above. Follow the section order: Bottom Line / Thesis / Working Hypothesis (anchor) → Strategic Outlook (when picked) → Frame Shift → Headline Findings (or Big Ideas) → Where We Converged → Where We Diverged → Positions → Options Analysis / Two Paths → Critical Assumptions (when picked) → Scenario Tree (when picked) → Why Now (when picked) → Recommendations / The Bet / Considerations (action) → Leading Indicators (when picked) → Pre-mortem → New Questions This Surfaced → Strategic Planning Assumption → Open Questions.`,
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

/** Validate + coerce the chair's stage-2 scaffold.
 *
 *  Validity floor: at minimum the scaffold must carry a load-bearing
 *  anchor (bottomLine OR thesis) AND a load-bearing findings block
 *  (≥ 1 headlineFinding OR a complete bigIdeas array). Other sections
 *  fall back to empty / null / default.
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

  const title = typeof parsed.title === "string" && parsed.title.trim()
    ? parsed.title.trim()
    : fallbackTitle;

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
    preMortem: parsePreMortem(parsed.preMortem),
    newQuestions: parseNewQuestions(parsed.newQuestions),
    planningAssumption: parsePlanningAssumption(parsed.planningAssumption),
    openQuestions: parseOpenQuestions(parsed.openQuestions),
  };
}
