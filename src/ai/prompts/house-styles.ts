/**
 * House-style presets · editorial register + section vocabulary the
 * composer picks alongside the spine and components.
 *
 * The component substitute system already gives each report some
 * shape variety (thesis vs bottom-line vs working-hypothesis, etc.),
 * but two reports under the same components used to read identically
 * because section LABELS were hard-coded English literals (`## Bottom
 * Line`, `## Headline Findings`, …) and the voice register was
 * uniformly McKinsey-neutral.
 *
 * A house style sits on top of those component picks and adds:
 *
 *   · `labels`  ─ section-heading overrides per component kind. The
 *                 same `headline-findings` component renders as
 *                 "## The Pillars" under `sequoia-memo`, "## Findings"
 *                 under `stanford-research`, "## Three Strategic
 *                 Insights" under `bcg-strategy`, etc. Bilingual so
 *                 zh-rooms see Chinese headings instead of the LLM
 *                 mis-translating the literal English.
 *
 *   · `voice`   ─ a paragraph of register guidance threaded into
 *                 Stage 3's system prompt. Sequoia memos read as
 *                 declarative present-tense; Stanford research notes
 *                 hedge; First Round essays use first-person plural
 *                 narrative voice. Same scaffold, different tone.
 *
 *   · `spine`   ─ a default visual CSS to suggest. The composer can
 *                 override (spine and house-style are independent in
 *                 the schema).
 *
 *   · `fits`    ─ which `subject_type` slugs the composer should
 *                 prefer this style for. Soft hint, not enforced.
 *
 * Append-only · ids never get repurposed, so old briefs always render.
 * The `boardroom-default` preset (no overrides) is the fallback used
 * by legacy briefs and by the safety-net composition.
 */
import type { ComponentKind } from "./composer.js";
import type { ReportLanguage } from "./brief-stages.js";

/** Renderer keys · 1:1 with `public/report/spines/*.css`. Re-stated
 *  here (instead of imported from composer.ts) to avoid an import
 *  cycle — composer.ts already imports from this file. */
export const SPINES = [
  "boardroom-dark",
  "a16z-thesis",
  "anthropic-essay",
  "gartner-note",
  "mckinsey-deck",
  "openai-paper",
] as const;

export type Spine = (typeof SPINES)[number];

/** A single section-heading override · the markdown rendered by
 *  Stage 3 when this component kind appears. Bilingual; the room's
 *  language picks the variant. */
interface BiText {
  en: string;
  zh: string;
}

/** Either a single label or an array of variants. When an array is
 *  supplied, the renderer deterministically picks one variant per
 *  brief (seeded by briefId + kind), so the same brief always reads
 *  consistently while different briefs in the same house style get
 *  different titling — that's where the "every report looks the
 *  same" complaint actually lives. */
export type LabelEntry = BiText | BiText[];

export interface HouseStyle {
  /** Slug · stored verbatim in `briefs.house_style`. Append-only. */
  id: string;
  /** Display label · surfaced in the composer's catalog and on the
   *  brief card's house-style tag (when shown). */
  label: string;
  /** Default visual spine. The composer can override; the renderer
   *  reads `briefs.spine` regardless of `briefs.house_style`. */
  spine: Spine;
  /** Voice / register guidance · injected verbatim into Stage 3's
   *  system prompt so the prose matches the picked register. ≤ 600
   *  chars per language so we don't blow the prompt budget. */
  voice: BiText;
  /** Section-heading overrides per component kind. When a kind is
   *  absent here, Stage 3 falls back to the legacy default heading
   *  baked into `WRITE_SYSTEM`. Store labels without the `## ` prefix.
   *  Either a single BiText or an array of variants (the renderer
   *  picks one per brief via the seed). */
  labels: Partial<Record<ComponentKind, LabelEntry>>;
  /** Subject types this preset reads naturally for. Soft hint to the
   *  composer. Subject types match `composer.ts`'s ALLOWED_SUBJECT_TYPES. */
  fits: string[];
  /** One-line catalog pitch · shown to the composer alongside the
   *  preset's id so it can pick deliberately. */
  pitch: string;
}

/** ─────────────────────── Catalog ──────────────────────────────────────
 *
 *  Picking rationale per preset:
 *    · boardroom-default ─ fallback. No overrides; preserves legacy.
 *    · sequoia-memo      ─ "Why we'd back this" investment memo.
 *                          Pull-quote anchor, present-tense, declarative.
 *    · a16z-thesis       ─ Big-idea thesis + Why Now + The Bet.
 *                          Contrarian, claim-forward.
 *    · stanford-research ─ Hypothesis-driven, hedged, threats-to-validity
 *                          register. Best for philosophical / open rooms.
 *    · bcg-strategy      ─ MECE strategic memo with imperatives.
 *                          For "what should we do" rooms.
 *    · first-round-essay ─ Operator-wisdom narrative essay. First-person
 *                          plural, warm, references specific moments.
 *    · gartner-research  ─ Risk-conscious research note with assumptions,
 *                          scenarios, leading indicators. Watch-list voice.
 */
export const HOUSE_STYLES: HouseStyle[] = [
  {
    id: "boardroom-default",
    label: "Boardroom (default)",
    spine: "boardroom-dark",
    voice: {
      en: "Plain analytical voice. State the call, show the reasoning, name the trade-offs. No house-style flourishes.",
      zh: "中立分析口吻。先给判断，再陈述理据，明确权衡。不带特定流派的修辞。",
    },
    labels: {},
    fits: ["other", "retro", "philosophical", "operational"],
    pitch: "Default · neutral analyst voice with the legacy section vocabulary.",
  },

  {
    id: "sequoia-memo",
    label: "Sequoia memo",
    spine: "a16z-thesis",
    voice: {
      en: "Investment-memo register. Present-tense, declarative, no hedging. Lead each section with the load-bearing claim, then the evidence. Address \"we\" as a reader; the writer is the partnership weighing the call. Trim qualifiers — \"strong\", \"clear\", \"compelling\" only when earned. Concrete numbers, named precedents, no marketing adjectives.",
      zh: "投资备忘录式语气。现在时陈述句，不含 hedge。每段先给关键判断，再引证据。对读者用 \"我们\"，写作主体是合伙团队。剔除修饰词 —— \"强\"\"清晰\"\"令人信服\" 只在确实站得住时使用。给出具体数字、命名先例，不用营销腔形容词。",
    },
    labels: {
      "bottom-line": [
        { en: "The Memo",                          zh: "备忘要点" },
        { en: "Where We Land",                     zh: "我们的判断" },
      ],
      "thesis": [
        { en: "Why We'd Back It",                  zh: "为什么我们会支持" },
        { en: "The Bet We'd Take",                 zh: "我们愿意下的注" },
      ],
      "working-hypothesis":   { en: "The Working View",          zh: "当前判断" },
      "frame-shift": [
        { en: "How the Question Sharpened",        zh: "问题如何被磨锋利" },
        { en: "What the Room Got Clearer About",   zh: "全场逐渐明确的事" },
      ],
      "headline-findings": [
        { en: "The Pillars",                       zh: "支柱" },
        { en: "Why We Like It",                    zh: "我们喜欢这事的理由" },
      ],
      "big-ideas": [
        { en: "Three Reasons We're In",            zh: "我们入局的三个理由" },
        { en: "Three Things That Stand Out",       zh: "最显眼的三件事" },
      ],
      "convergence":          { en: "Where the Partners Aligned", zh: "合伙人共识所在" },
      "divergence":           { en: "The Open Disagreement",     zh: "我们当前的分歧" },
      "why-now": [
        { en: "Why Now",                           zh: "为什么是现在" },
        { en: "Why the Window Is Open",            zh: "为什么这扇窗户现在开着" },
      ],
      "the-bet": [
        { en: "Conditions to Back It",             zh: "支持这笔下注的前提" },
        { en: "What Has to Be True",               zh: "什么必须成立" },
      ],
      "recommendations": [
        { en: "What Would Make This Work",         zh: "让它成立需要做的事" },
        { en: "How We'd Move",                     zh: "我们会怎么做" },
      ],
      "considerations":       { en: "Things We'd Stress-Test",   zh: "需要压力测试的点" },
      "pre-mortem": [
        { en: "Where It Could Break",              zh: "可能崩盘之处" },
        { en: "How This Goes Wrong",               zh: "这事会怎么搞砸" },
      ],
      "critical-assumptions": { en: "What We're Assuming",       zh: "我们的假设" },
      "threats-to-validity": [
        { en: "What Could Be Wrong With This Read", zh: "这套判断可能错在哪" },
        { en: "Where Our Analysis Could Mislead Us", zh: "分析可能把我们带偏的地方" },
      ],
      "metric-strip": [
        { en: "By the Numbers",                    zh: "用数字说话" },
        { en: "The Underwrite",                    zh: "支撑数据" },
        { en: "Three Numbers Worth Pricing In",    zh: "值得定价的三个数字" },
      ],
      "new-questions": [
        { en: "What's Still Unclear",              zh: "仍未明确的问题" },
        { en: "What We'd Want to Know Next",       zh: "下一步想搞清楚的事" },
      ],
      "open-questions":       { en: "Outstanding Items",         zh: "待办事项" },
      "scenario-tree":        { en: "How This Could Play Out",   zh: "可能的演化路径" },
      "leading-indicators":   { en: "What We'll Be Watching",    zh: "我们会盯的信号" },
      "planning-assumption":  { en: "The Bet Behind the Bet",    zh: "背后的下注假设" },
      "two-paths":            { en: "Two Routes",                zh: "两条路线" },
      "positions":            { en: "Camps Around the Table",    zh: "桌上的几派立场" },
    },
    fits: ["investment-judgement", "market-forecast"],
    pitch: "Investment memo · declarative, present-tense, partner voice. For \"should we back this\" rooms.",
  },

  {
    id: "a16z-thesis",
    label: "a16z thesis",
    spine: "a16z-thesis",
    voice: {
      en: "Contrarian thesis-essay register. Lead with the counter-consensus claim — sharp, opinionated, willing to be wrong loudly. Optimistic-but-rigorous: every bold claim earns its place with one named evidence point. Use \"the consensus says X — we think Y because Z\" framings. Avoid corporate hedges; embrace strong verbs (\"breaks\", \"unlocks\", \"compounds\"). One pull-quote per section is plenty.",
      zh: "逆共识论文体。先抛出反共识的判断 —— 锋利、有立场、敢于公开承担错。乐观但严谨：每个大胆主张都有一个具名证据点撑住。多用 \"共识认为 X —— 我们认为 Y，因为 Z\" 这类框架。不要公司式 hedging；多用强动词（\"打破\"\"解锁\"\"复利累积\"）。每节一句拉得出来的金句即可。",
    },
    labels: {
      "thesis": [
        { en: "The Thesis",                        zh: "核心论点" },
        { en: "The Counter-Consensus Read",        zh: "反共识判断" },
      ],
      "bottom-line": [
        { en: "The Read",                          zh: "判断" },
        { en: "What We Think Is True",             zh: "我们认为成立的事" },
      ],
      "frame-shift": [
        { en: "How the Question Moved",            zh: "问题如何转移" },
        { en: "The Frame the Consensus Is Missing", zh: "共识看漏的视角" },
      ],
      "headline-findings": [
        { en: "Three Pillars",                     zh: "三个支撑" },
        { en: "Why This Compounds",                zh: "为什么这事会复利" },
      ],
      "big-ideas": [
        { en: "Three Big Ideas",                   zh: "三个大想法" },
        { en: "Three Things the Consensus Misses", zh: "共识忽视的三件事" },
      ],
      "why-now": [
        { en: "Why Now",                           zh: "为什么是现在" },
        { en: "The Window That Just Opened",       zh: "刚刚打开的窗口" },
      ],
      "the-bet": [
        { en: "What We'd Bet",                     zh: "我们会下的注" },
        { en: "The Bet on the Table",              zh: "桌上的这笔下注" },
      ],
      "recommendations": [
        { en: "How to Play It",                    zh: "怎么打这局" },
        { en: "Where to Push",                     zh: "在哪发力" },
      ],
      "scenario-tree":        { en: "Where the World Could Land", zh: "世界可能落到哪几种状态" },
      "leading-indicators": [
        { en: "What We're Watching",               zh: "我们盯着什么" },
        { en: "The Signals That Tell Us We're Right", zh: "证明我们对了的信号" },
      ],
      "pre-mortem": [
        { en: "How This Goes Wrong",               zh: "这事会怎么搞砸" },
        { en: "The Failure Modes We're Underwriting", zh: "我们在替谁兜底的失败模式" },
      ],
      "convergence":          { en: "What We Agreed On",         zh: "我们达成的共识" },
      "divergence":           { en: "The Open Question Inside",  zh: "我们之间的分歧" },
      "threats-to-validity": [
        { en: "Where We Could Be Wrong",           zh: "我们可能错在哪" },
        { en: "What Would Break the Thesis",       zh: "什么会击穿这套论点" },
      ],
      "metric-strip": [
        { en: "The Numbers",                       zh: "数字" },
        { en: "Why the Math Works",                zh: "为什么数算得过来" },
        { en: "What the Data Says",                zh: "数据怎么说的" },
      ],
      "new-questions": [
        { en: "What This Opens Up",                zh: "由此打开的问题" },
        { en: "The Next Set of Questions",         zh: "下一组问题" },
      ],
      "open-questions":       { en: "Still on the Table",        zh: "尚在桌上" },
      "two-paths":            { en: "Platform vs Vertical",      zh: "平台路 vs 纵深路" },
      "critical-assumptions": { en: "What Has to Be True",       zh: "必须成立的前提" },
      "considerations":       { en: "Things to Watch",           zh: "值得留意的点" },
      "positions":            { en: "Where the Camps Sit",       zh: "几派的位置" },
      "planning-assumption":  { en: "The Forecast",              zh: "预判" },
    },
    fits: ["investment-judgement", "market-forecast", "strategic-decision"],
    pitch: "a16z-style thesis · contrarian, claim-forward, optimistic-but-rigorous. For market opportunity / big-idea rooms.",
  },

  {
    id: "stanford-research",
    label: "Stanford research note",
    spine: "openai-paper",
    voice: {
      en: "Hedged scholarly register. Frame conclusions as working hypotheses, name uncertainty explicitly, surface threats to validity before stating recommendations. Third-person where natural; \"the analysis suggests\" beats \"we conclude\". Each finding cites which director / lens generated it. Counter-evidence and limitations get equal footprint to findings — they're not afterthoughts. No imperatives in the action section; substitute with \"considerations\" framing.",
      zh: "克制的学术口吻。把结论框定为工作假设，明确点名不确定性，先讲对结论有效性的威胁，再给建议。能用第三人称就用 —— \"分析显示\" 优于 \"我们认为\"。每条发现注明由哪位董事 / 视角产生。对立证据和局限与发现等量呈现，不当作附录。行动段不用祈使句，改为 \"值得考虑\" 式表达。",
    },
    labels: {
      "working-hypothesis": [
        { en: "Working Hypothesis",                zh: "工作假设" },
        { en: "Tentative Position",                zh: "初步立场" },
      ],
      "bottom-line": [
        { en: "Abstract",                          zh: "摘要" },
        { en: "Summary of Findings",               zh: "研究综述" },
      ],
      "thesis":               { en: "Central Claim",             zh: "核心主张" },
      "frame-shift": [
        { en: "How the Question Was Reframed",     zh: "问题如何被重新定义" },
        { en: "Reframing the Research Question",   zh: "对研究问题的重新框定" },
      ],
      "headline-findings": [
        { en: "Findings",                          zh: "研究发现" },
        { en: "Principal Findings",                zh: "主要发现" },
        { en: "What the Analysis Suggests",        zh: "分析所揭示的内容" },
      ],
      "big-ideas": [
        { en: "Three Observations",                zh: "三点观察" },
        { en: "Three Patterns Worth Naming",       zh: "三个值得命名的模式" },
      ],
      "convergence":          { en: "Independent Convergence",   zh: "独立路径上的趋同" },
      "divergence":           { en: "Where Reasonable Lenses Disagree", zh: "理性视角下的分歧" },
      "positions":            { en: "Schools of Thought",        zh: "几种思想流派" },
      // critical-assumptions remains "Threats to Validity" — it shipped
      // before the dedicated `threats-to-validity` component existed; we
      // keep the legacy mapping intact so old briefs render unchanged,
      // and the new component below gets the canonical labelling.
      "critical-assumptions": { en: "Critical Assumptions",      zh: "关键假设" },
      "threats-to-validity": [
        { en: "Threats to Validity",               zh: "对结论有效性的威胁" },
        { en: "Where the Analysis Could Mislead",  zh: "分析可能误导之处" },
        { en: "Internal & External Validity Concerns", zh: "内外部效度的担忧" },
      ],
      "metric-strip": [
        { en: "Quantitative Reads",                zh: "定量结果" },
        { en: "Key Metrics",                       zh: "关键指标" },
        { en: "Empirical Anchors",                 zh: "实证锚点" },
      ],
      "pre-mortem": [
        { en: "Failure Modes Considered",          zh: "已考虑的失败模式" },
        { en: "How the Argument Could Fail",       zh: "论点可能如何失败" },
      ],
      "considerations": [
        { en: "Things Worth Considering",          zh: "值得考虑的事项" },
        { en: "Practical Implications",            zh: "实践层面的含义" },
      ],
      "recommendations": [
        { en: "Implications",                      zh: "由此引出的影响" },
        { en: "Practical Implications",            zh: "实践层面的影响" },
      ],
      "the-bet":              { en: "Conditions for the Claim",  zh: "支撑该主张的条件" },
      "scenario-tree":        { en: "Plausible Futures",         zh: "可能的未来情景" },
      "leading-indicators":   { en: "Empirical Signals to Track", zh: "可追踪的经验信号" },
      "new-questions": [
        { en: "Future Work",                       zh: "后续工作" },
        { en: "Open Lines of Inquiry",             zh: "尚开放的研究方向" },
      ],
      "open-questions":       { en: "Limitations",               zh: "研究局限" },
      "why-now":              { en: "Temporal Window",           zh: "时间窗口" },
      "planning-assumption":  { en: "Forecasting Assumption",    zh: "预测假设" },
      "two-paths":            { en: "Two Lines of Inquiry",      zh: "两条研究路径" },
    },
    fits: ["philosophical", "market-forecast", "other"],
    pitch: "Stanford research note · hedged, hypothesis-driven, threats-to-validity surfaced. For open-ended / philosophical rooms.",
  },

  {
    id: "bcg-strategy",
    label: "BCG strategy memo",
    spine: "mckinsey-deck",
    voice: {
      en: "Structured strategy-consulting register. Pyramid principle in every section: lead claim, then 3 supporting points, then evidence. MECE wherever possible — list items must be mutually exclusive and collectively exhaustive. Imperative voice in actions (\"Do X\", \"Stop Y\"). Each insight earns its inclusion by being load-bearing for the recommendations. Avoid academic hedging; this is a memo to a CEO with 20 minutes.",
      zh: "结构化战略咨询语气。每节都用金字塔原理：主张在前，3 个支撑点居中，证据在后。能 MECE 就 MECE —— 列表项之间互斥、合在一起穷尽。行动段用祈使句（\"做 X\"\"停 Y\"）。每条洞察都得对最终建议有承重作用，否则删掉。少学术 hedging，这是给 CEO 的二十分钟备忘录。",
    },
    labels: {
      "bottom-line": [
        { en: "The Strategic Imperative",          zh: "战略要务" },
        { en: "The Call to the Board",             zh: "对董事会的判断" },
      ],
      "thesis": [
        { en: "The Strategic Call",                zh: "战略判断" },
        { en: "The Position We'd Hold",            zh: "我们会持的立场" },
      ],
      "working-hypothesis":   { en: "Working Strategic View",    zh: "当前战略观点" },
      "frame-shift":          { en: "Reframing the Question",    zh: "对问题的重新定义" },
      "strategic-outlook": [
        { en: "The Operating Environment",         zh: "经营环境" },
        { en: "The Context We're Operating In",    zh: "我们所处的格局" },
      ],
      "headline-findings": [
        { en: "Three Strategic Insights",          zh: "三大战略洞察" },
        { en: "Three Findings That Drive the Call", zh: "支撑判断的三项发现" },
      ],
      "big-ideas": [
        { en: "Three Strategic Themes",            zh: "三个战略主题" },
        { en: "Three Themes That Recurred",        zh: "反复出现的三个主题" },
      ],
      "convergence":          { en: "Where the Analysis Aligns", zh: "分析的共识所在" },
      "divergence":           { en: "The Strategic Tension",     zh: "战略层面的张力" },
      "positions":            { en: "Strategic Camps",           zh: "战略阵营" },
      "critical-assumptions": { en: "Critical Assumptions",      zh: "关键假设" },
      "threats-to-validity": [
        { en: "Where the Analysis Could Be Wrong", zh: "分析可能错在哪里" },
        { en: "Holes in This Read",                zh: "这套判断的漏洞" },
      ],
      "metric-strip": [
        { en: "Strategic Indicators",              zh: "战略指标" },
        { en: "The Diagnostic at a Glance",        zh: "诊断速览" },
        { en: "Numbers That Drive the Call",       zh: "驱动判断的数字" },
      ],
      "scenario-tree":        { en: "Strategic Scenarios",       zh: "战略情景" },
      "leading-indicators":   { en: "Indicators to Monitor",     zh: "需监测的先行指标" },
      "recommendations": [
        { en: "What to Do",                        zh: "应当采取的行动" },
        { en: "The Move",                          zh: "动作" },
        { en: "Strategic Imperatives",             zh: "战略要务" },
      ],
      "the-bet":              { en: "Conditions for Commitment", zh: "做出承诺的前提条件" },
      "considerations":       { en: "Trade-offs to Weigh",       zh: "需要权衡的取舍" },
      "pre-mortem": [
        { en: "Risks to Manage",                   zh: "需管理的风险" },
        { en: "Where Execution Could Fail",        zh: "执行可能崩盘之处" },
      ],
      "two-paths":            { en: "Strategic Options",         zh: "战略选项对照" },
      "why-now":              { en: "Why the Window Is Open",    zh: "为何窗口现在打开" },
      "new-questions": [
        { en: "Questions for the Next Phase",      zh: "下一阶段需要回答的问题" },
        { en: "What the Next Diagnostic Should Probe", zh: "下一次诊断该深入的问题" },
      ],
      "open-questions":       { en: "Open Items",                zh: "待解决事项" },
      "planning-assumption":  { en: "Strategic Planning Assumption", zh: "战略规划假设" },
    },
    fits: ["strategic-decision", "operational", "option-comparison"],
    pitch: "BCG / strategy-consulting memo · MECE, pyramid principle, imperative actions. For \"what should we do\" rooms.",
  },

  {
    id: "first-round-essay",
    label: "First Round Review essay",
    spine: "anthropic-essay",
    voice: {
      en: "Operator-essay register, narrative voice. Use first-person plural (\"we found\", \"we learned\") as if the room is the author. Reference specific moments from the conversation rather than abstracted findings — \"when Socrates pressed on the definition of engagement, the room realized…\". Warm, reflective, willing to admit confusion. Imperative voice is too sharp here; default to \"things worth thinking about\" / \"considerations\". Each section can open with a small story before the claim.",
      zh: "操盘者写随笔的语气，叙事口吻。第一人称复数（\"我们发现\"\"我们意识到\"），把会议本身当成作者。引用对话中的具体片段，而不是抽象提炼 —— \"当 Socrates 追问 engagement 的定义时，全场才意识到……\"。温暖、有反思感、愿意承认困惑。这里祈使句太锋利，默认改用 \"值得思考的事\"\"可能的考量\" 这类表达。每节可以先讲一个小故事再上判断。",
    },
    labels: {
      "working-hypothesis": [
        { en: "What We've Come to Believe",        zh: "我们逐渐相信的事" },
        { en: "Where We Are with This",            zh: "我们目前对它的理解" },
      ],
      "bottom-line": [
        { en: "Where We Landed",                   zh: "我们最后落到哪里" },
        { en: "What We Took Away",                 zh: "我们带走的东西" },
      ],
      "thesis":               { en: "The Idea That Stuck",        zh: "立住了的那个想法" },
      "frame-shift":          { en: "How the Question Changed Us", zh: "问题如何反过来改造了我们" },
      "headline-findings": [
        { en: "Three Things We Saw",               zh: "我们看到的三件事" },
        { en: "Three Things That Kept Coming Back", zh: "反复回到桌上的三件事" },
      ],
      "big-ideas": [
        { en: "Three Things We Noticed",           zh: "我们注意到的三件事" },
        { en: "Three Patterns Worth Naming",       zh: "值得说出来的三个模式" },
      ],
      "convergence":          { en: "Where We Agreed",            zh: "我们彼此同意的地方" },
      "divergence":           { en: "Where We Couldn't Agree",    zh: "我们彼此无法说服的地方" },
      "positions":            { en: "How the Room Split",         zh: "房间分成了哪几派" },
      "critical-assumptions": { en: "What We're Quietly Assuming", zh: "我们暗自假设的事" },
      "threats-to-validity": [
        { en: "Where We Might Be Fooling Ourselves", zh: "我们可能在自欺的地方" },
        { en: "What Could Be Wrong With This Take", zh: "这套看法可能错在哪" },
      ],
      "metric-strip": [
        { en: "A Few Numbers That Came Up",        zh: "几个浮上来的数字" },
        { en: "What the Numbers Said",             zh: "数字告诉我们的事" },
      ],
      "considerations": [
        { en: "Things Worth Thinking About",       zh: "值得想想的事" },
        { en: "Questions We'd Sit With",           zh: "我们会陪着的问题" },
      ],
      "recommendations": [
        { en: "What We'd Do With This",            zh: "我们会怎么用这个" },
        { en: "How We'd Carry This Out",           zh: "我们会怎么把这事落下来" },
      ],
      "the-bet":              { en: "What We'd Need to Believe to Move", zh: "要行动需要相信什么" },
      "pre-mortem": [
        { en: "Where We'd Get Stuck",              zh: "我们大概会卡在哪" },
        { en: "Where Things Tend to Fall Apart",   zh: "通常会崩在哪" },
      ],
      "new-questions": [
        { en: "Questions We Walked Out With",      zh: "走出会议室时带着的新问题" },
        { en: "What We're Going Home With",        zh: "我们打包带回家的问题" },
      ],
      "open-questions":       { en: "Still Unresolved",           zh: "仍未解决" },
      "why-now":              { en: "Why This Mattered Today",    zh: "为什么这事此刻要紧" },
      "scenario-tree":        { en: "How This Might Unfold",      zh: "这事可能怎么演" },
      "leading-indicators":   { en: "What We'd Watch For",        zh: "我们会留意什么" },
      "two-paths":            { en: "Two Roads",                  zh: "两条路" },
      "planning-assumption":  { en: "What We Think Will Hold",    zh: "我们认为会成立的判断" },
    },
    fits: ["philosophical", "retro", "operational"],
    pitch: "First Round-style operator essay · first-person plural, narrative, references specific moments. For retro / philosophical rooms.",
  },

  {
    id: "gartner-research",
    label: "Gartner research note",
    spine: "gartner-note",
    voice: {
      en: "Risk-conscious analyst register. Every claim carries a confidence band; every assumption carries a falsifier; every recommendation carries a horizon. Probability-aware: \"by 2027, 60% probability that …, unless …\". Watch-list orientation — the brief tells the reader what to monitor as much as what to conclude. Avoid the sales-deck adjectives (\"transformative\", \"game-changing\"); the voice is the analyst writing for a procurement committee, not the vendor selling to it.",
      zh: "风险意识强的分析师口吻。每个判断都有置信度带；每个假设都有可证伪触发条件；每条建议都有时间窗。带概率感：\"到 2027 年，60% 概率 X 发生，除非 Y\"。\"监测清单\" 心态 —— 报告告诉读者要持续盯什么，跟告诉他们结论一样重要。避免推销 PPT 形容词（\"颠覆性的\"\"改变游戏规则\"），语气是分析师写给采购委员会的，不是供应商写给客户的。",
    },
    labels: {
      "bottom-line": [
        { en: "The Read",                          zh: "判断要点" },
        { en: "Analyst Read",                      zh: "分析师判断" },
      ],
      "thesis":               { en: "Analyst Position",           zh: "分析师立场" },
      "working-hypothesis":   { en: "Current Working View",       zh: "当前工作判断" },
      "strategic-outlook":    { en: "Strategic Outlook",          zh: "战略展望" },
      "frame-shift":          { en: "Reframing the Decision",     zh: "对决策框架的重置" },
      "headline-findings": [
        { en: "Key Findings",                      zh: "关键发现" },
        { en: "Findings That Drive the Read",      zh: "驱动判断的发现" },
      ],
      "big-ideas": [
        { en: "Three Themes",                      zh: "三个主题" },
        { en: "Three Patterns the Data Supports",  zh: "数据支持的三个模式" },
      ],
      "critical-assumptions": { en: "Critical Assumptions",       zh: "关键假设" },
      "threats-to-validity": [
        { en: "Validity Concerns",                 zh: "对结论效度的担忧" },
        { en: "Threats to the Read",               zh: "对判断的威胁" },
        { en: "Where the Analysis Could Be Wrong", zh: "分析可能错在哪" },
      ],
      "metric-strip": [
        { en: "Indicator Dashboard",               zh: "指标看板" },
        { en: "Key Metrics at a Glance",           zh: "关键指标一览" },
        { en: "Quantitative Read",                 zh: "定量判读" },
      ],
      "scenario-tree":        { en: "Scenario Tree",              zh: "情景树" },
      "leading-indicators":   { en: "Leading Indicators",         zh: "先行指标" },
      "convergence":          { en: "Areas of Analyst Agreement", zh: "分析共识所在" },
      "divergence":           { en: "Analyst Disagreement",       zh: "分析师分歧" },
      "positions":            { en: "Vendor / Camp Positions",    zh: "厂商 / 阵营立场" },
      "pre-mortem": [
        { en: "Failure Modes",                     zh: "失败模式" },
        { en: "Downside Scenarios",                zh: "下行情景" },
      ],
      "recommendations": [
        { en: "Strategic Imperatives",             zh: "战略要务" },
        { en: "Recommended Actions",               zh: "建议行动" },
        { en: "Action Items for Decision-Makers",  zh: "决策者的行动清单" },
      ],
      "the-bet":              { en: "Conditions to Commit",       zh: "做出承诺的前提" },
      "considerations":       { en: "Decision Considerations",    zh: "决策考量" },
      "planning-assumption":  { en: "Strategic Planning Assumption", zh: "战略规划假设" },
      "new-questions": [
        { en: "Emerging Questions",                zh: "新浮现的问题" },
        { en: "Questions to Track",                zh: "需要追踪的问题" },
      ],
      "open-questions":       { en: "Outstanding Items",          zh: "尚未解决的事项" },
      "why-now":              { en: "Decision Window",            zh: "决策窗口" },
      "two-paths":            { en: "Option A vs Option B",       zh: "选项 A 对照 选项 B" },
    },
    fits: ["strategic-decision", "market-forecast", "option-comparison"],
    pitch: "Gartner research note · probabilistic, watch-list-oriented, every claim carries a confidence + falsifier. For uncertainty-heavy decisions.",
  },

  {
    id: "field-notes",
    label: "Field notes",
    spine: "anthropic-essay",
    voice: {
      en: "Observer's-notebook register. Warm, curious, tentative. The room is the protagonist — refer back to specific moments (\"when Long Horizon pressed on tempo, the room kept returning to…\"). Verbs allowed: `could`, `might`, `would open up`, `seems to`, `looks like`, `if X, then Y might`. Verbs FORBIDDEN: `must`, `will`, `should`, `the bet is`, `the moat is`, `we recommend`. NEVER claim a winner. NEVER quantify (\"60% probability\", \"$2B TAM\"). The brief should leave the reader with MORE angles to chase, not one to act on.",
      zh: "观察笔记式语气。温暖、好奇、留有余地。会议本身是主角 —— 引用具体片段（\"当 Long Horizon 追问 tempo 时，房间反复回到……\"）。允许的动词：`可能`、`也许`、`会打开`、`看起来`、`若 X 成立`。**禁止**的动词：`必须`、`应该`、`护城河`、`要做的是`、`下注的是`、`结论是`。永不挑出赢家。永不量化（不写 \"60% 概率\"、\"$2B TAM\"）。这份 brief 应该让读者带走更多值得追的角度，而不是一个要执行的动作。",
    },
    labels: {
      "opening-hook": [
        { en: "What If This Is Real",            zh: "如果这事成立呢" },
        { en: "What Changes If This Holds",      zh: "若这件事真的发生" },
        { en: "The Premise Worth Sitting With",  zh: "值得呆一会儿的前提" },
      ],
      "opportunity-shape": [
        { en: "The Shape of the Room",           zh: "房间的形状" },
        { en: "How Big the Question Is",         zh: "这个问题有多大" },
        { en: "Where This Lives",                zh: "这事生活在哪里" },
      ],
      "adjacent-angles": [
        { en: "Doors Worth Opening",             zh: "值得打开的几扇门" },
        { en: "Different Ways In",               zh: "几种不同的进入方式" },
        { en: "Angles the Room Tried On",        zh: "房间试戴过的几个角度" },
      ],
      "what-if-this-works": [
        { en: "If This Plays Out",               zh: "如果这条线走通了" },
        { en: "What This Could Open Up",         zh: "这会打开什么" },
      ],
      "worth-chasing": [
        { en: "Threads Worth Pulling",           zh: "值得拉的几条线" },
        { en: "Where the Heat Is",               zh: "热度在哪里" },
        { en: "Things the Room Kept Returning To", zh: "房间反复回到的事" },
      ],
      "dead-ends-noted": [
        { en: "Roads We Walked Back From",       zh: "我们折返的几条路" },
        { en: "Paths the Room Set Down",         zh: "房间放下的几条路径" },
      ],
      "brainstorm-questions": [
        { en: "Questions Worth Sitting With",    zh: "值得多坐一会儿的问题" },
        { en: "What This Opens Up",              zh: "由此打开的问题" },
        { en: "The Field's Next Horizon",        zh: "这个领域的下一道地平线" },
      ],
      "visuals":              { en: "Sketches from the Room", zh: "房间里的草图" },
      "open-questions":       { en: "Still Open",             zh: "仍然开放" },
    },
    fits: ["exploration"],
    pitch: "Field-notes register · warm, curious, observer's voice. Default for brainstorm rooms — refuses to pick a winner.",
  },

  {
    id: "audit-memo",
    label: "Audit memo",
    spine: "boardroom-dark",
    voice: {
      en: "Inspector / standards-officer register. Sharp, procedural, evidence-anchored. Severity-tagged: every issue and every fix opens with `**Severity: high/medium/low** ·`. Verbs allowed: `surfaces`, `breaks`, `omits`, `under-specifies`, `narrows`, `mis-handles`, `lacks`, `assumes without check`. Verbs FORBIDDEN outside the fixes section: `must`, `should`, `we recommend` (those belong in fixes, where prescription is welcome). NEVER prescriptive about strategy beyond the deliverable — \"the deliverable doesn't address X\" is fair; \"and you should pivot the product\" is out of scope. Audit decorum: name what works BEFORE what's broken. Cite directors when their phrasing IS the diagnostic point.",
      zh: "标准审查官的语气。锋利、程序化、证据驱动。带 severity 标签：每个 issue 和每个 fix 都用 `**严重程度：高/中/低** ·` 起头。允许的动词：`揭示`、`打破`、`遗漏`、`欠规约`、`收窄了`、`处理失当`、`缺少`、`未经核实地假设`。**禁止**在 fixes 之外用：`必须`、`应该`、`我们建议`（这些只属于 fixes，那里 prescription 是合适的）。不要超出 deliverable 范围给战略建议 —— \"这份交付物没回答 X\" 可以；\"另外你应该转型产品\" 超出范围。审查礼貌：先说什么是 working 的，再说什么坏了。当某位董事的原话**就是**诊断本身时，引用他/她的名字。",
    },
    labels: {
      "deliverable-summary": [
        { en: "Under Review",                    zh: "审查对象" },
        { en: "What This Audit Covers",          zh: "本次审查的范围" },
      ],
      "whats-good": [
        { en: "What's Already Working",          zh: "已经在起作用的部分" },
        { en: "Strengths Worth Preserving",      zh: "值得保留的优点" },
        { en: "What the Deliverable Gets Right", zh: "交付物已经做对的事" },
      ],
      "quality-issues": [
        { en: "Issues Found",                    zh: "发现的问题" },
        { en: "Where the Deliverable Breaks Down", zh: "交付物的失效点" },
        { en: "Quality Defects, Severity-Ranked", zh: "质量缺陷（按严重程度）" },
      ],
      "severity-ranked-fixes": [
        { en: "Fixes, Ranked",                   zh: "修复方案（按严重程度排序）" },
        { en: "What to Change",                  zh: "需要修改的地方" },
        { en: "Prescriptions",                   zh: "处方" },
      ],
      "residual-risks": [
        { en: "Residual Risks",                  zh: "残余风险" },
        { en: "Risks the Audit Couldn't Close",  zh: "本次审查无法关闭的风险" },
      ],
      "open-questions": [
        { en: "Open Questions for the Owner",    zh: "留给负责人的问题" },
        { en: "What We'd Need from the Author",  zh: "我们需要作者补充的信息" },
      ],
      "visuals":              { en: "Severity Matrix",          zh: "严重程度矩阵" },
    },
    fits: ["audit"],
    pitch: "Audit-memo register · standards-officer voice, severity-tagged, \"what's good first\". Default for critique rooms.",
  },
];

const HOUSE_STYLE_BY_ID = new Map<string, HouseStyle>(HOUSE_STYLES.map((s) => [s.id, s]));

/** Slug-string union shaped from the catalog. */
export type HouseStyleId = HouseStyle["id"];

/** Resolve a house-style id (or unknown / null) to a concrete style.
 *  Falls back to `boardroom-default`, which carries no overrides — old
 *  briefs and any composer slip end up rendering exactly as before. */
export function resolveHouseStyle(id: string | null | undefined): HouseStyle {
  if (id) {
    const found = HOUSE_STYLE_BY_ID.get(id);
    if (found) return found;
  }
  return HOUSE_STYLE_BY_ID.get("boardroom-default")!;
}

/** Deterministic index pick · same `(seed, kind, n)` always returns
 *  the same index, so a regenerated brief renders identically to the
 *  first run, but different briefs land on different variants. The
 *  kind is folded into the hash so the same brief picks different
 *  variants for different sections (otherwise every override in a
 *  brief would land on variant 0). djb2 hash, deliberately tiny. */
function pickIndex(seed: string | number | undefined, kind: string, n: number): number {
  if (n <= 1) return 0;
  const s = (seed === undefined ? "" : String(seed)) + "::" + kind;
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return Math.abs(h | 0) % n;
}

/** Render the override label for `kind` under `style` in `lang`,
 *  or null when the style has no override (caller falls back to the
 *  legacy default heading). When the entry is a variant array, the
 *  optional `seed` (e.g. brief id) deterministically picks one — same
 *  seed + kind always returns the same variant, so regeneration is
 *  stable. Omitting `seed` yields the first variant (legacy behaviour
 *  for any caller that hasn't been updated yet). */
export function houseStyleLabel(
  style: HouseStyle,
  kind: ComponentKind,
  lang: ReportLanguage,
  seed?: string | number,
): string | null {
  const entry = style.labels[kind];
  if (!entry) return null;
  const variants = Array.isArray(entry) ? entry : [entry];
  if (variants.length === 0) return null;
  const idx = pickIndex(seed, kind, variants.length);
  const picked = variants[idx];
  return lang === "zh" ? picked.zh : picked.en;
}

/** Format the house-style catalog as plain text for the composer's
 *  system prompt. Keeps the prompt size modest (id + pitch + fits)
 *  rather than dumping every label override. */
export function formatHouseStyleCatalog(): string {
  return HOUSE_STYLES.map((s) => {
    const fitsLine = s.fits.length ? `  fits: ${s.fits.join(", ")}` : "";
    return [
      `  · \`${s.id}\` · ${s.label}`,
      `    ${s.pitch}`,
      fitsLine,
    ].filter((l) => l.trim()).join("\n");
  }).join("\n");
}
