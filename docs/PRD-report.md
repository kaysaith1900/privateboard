# PRD · Report Composer (v1)

## Goal

Today the chair's `report-writer` system skill always produces the same
12-section McKinsey-style brief. Every report looks the same regardless
of whether the room argued about an investment thesis, a philosophical
question, an operational decision, or a comparison of options.

Target: a **report composer** that, given the room's subject and the
extracted per-director signals, picks (a) a **style spine** and (b) a
**component set** that fit the conversation. Each report is composed
from a library of ~30 analytical components rendered through one of
several visual spines (a16z thesis · Anthropic essay · Gartner research
note · McKinsey deck · OpenAI paper · the existing Boardroom dark deck).

Two design principles, ranked:

1. **Depth before decoration.** Components exist because they unlock
   an analytical move (reframe, falsify, plot, contrast). A pretty
   block that doesn't change what the reader concludes is dropped.
2. **Composition before presets.** The composer assembles components;
   spines are just renderers. Same JSON, swap the CSS, get a different
   document. No spine has hardcoded sections.

The product feel — "the same boardroom speaking in different
registers" — depends on holding typography, palette, and voice
constant across spines. Only structure and component density vary.

---

## 1 · Architecture

Two layers, decoupled:

```
            ┌──────────────────────────────────────────┐
            │  Component library (analysis)            │
            │   ~30 components · each has              │
            │     · JSON schema                        │
            │     · extract prompt fragment            │
            │     · render contract (markdown shape)   │
            └──────────────────────────────────────────┘
                              │ (composer picks subset + order)
                              ▼
            ┌──────────────────────────────────────────┐
            │  Style spines (presentation)             │
            │   6 spines · each has                    │
            │     · cover layout                       │
            │     · component CSS overrides            │
            │     · voice rules (tone, density)        │
            └──────────────────────────────────────────┘
```

A brief is now: `{ spine, components: Component[], rationale }`. The
storage row keeps the rendered markdown as today; the JSON shape is
the new source of truth.

### Pipeline (current → new)

```
                Stage 1            Stage 1.5            Stage 2              Stage 3
              extract         →   COMPOSER         →   scaffold        →    write
              (haiku)             (haiku)              (sonnet)             (opus → sonnet)
              per director        pick spine +         fill the picked      stream markdown
              signals             components + order   components only      using picked spine
```

Stage 1.5 is new. Stages 2 and 3 are modified to be *component-aware*:
the SCAFFOLD/WRITE prompts are split into per-component fragments, and
only the fragments matching the composer's picks are concatenated.

If the composer fails (network/parse), we fall back to the current
"all 12 components, mckinsey-dark spine" preset — old behaviour
preserved.

---

## 2 · Component library

A component is one analytical move. It has:

- a `kind` (string slug, unique)
- a `category` (anchor / findings / multi-perspective / exhibit /
  comparison / action / forward / residual / meta)
- a JSON schema (the data the chair extracts)
- a render contract (markdown that will be produced) and a CSS class
  hook (`.section-<kind>`)
- optional `requires` predicates (e.g. `comparison-table` requires
  ≥ 2 named options surfaced in the signals)

### v1 inventory

| kind | category | summary | derived from |
|---|---|---|---|
| `bottom-line` | anchor | Sentence judgement + confidence + rationale | current v1 |
| `thesis` | anchor | Massive single-line thesis pull-statement | a16z |
| `working-hypothesis` | anchor | Essay-style "this is our working hypothesis, here's why it may be wrong" | Anthropic |
| `abstract` | anchor | 3-5 sentence dense paper abstract | OpenAI |
| `frame-shift` | reframe | How the question itself moved (or didn't) | current v1 |
| `headline-findings` | findings | Exactly 3 MECE pillar claims · supporters / challengers / sub-findings | current v1 |
| `big-ideas` | findings | 3 numbered claims, each with a why-now line | a16z |
| `numbered-observations` | findings | Essay-style numbered observations with prose, not bullets | Anthropic |
| `key-findings-list` | findings | Gartner-style flat list of bold-led observations | Gartner |
| `director-cards` | multi-persp | Per-director card · their take, their lens, their cost-of-being-wrong | a16z |
| `positions` | multi-persp | 2-3 named camps with pull-quote per camp | current v1 |
| `convergence` | multi-persp | Where directors aligned via independent reasoning paths | current v1 |
| `divergence` | multi-persp | The single hinge · per-director stance table · resolution requirements | current v1 |
| `contention-table` | multi-persp | Gartner-style two-column "Argument · Counter-argument" | Gartner |
| `magic-quadrant` | exhibit | Vendor/option positioning on Ability-to-execute × Completeness-of-vision | Gartner |
| `quadrant-chart` | exhibit | Generic 2×2 with axis labels, items plotted | current v1 |
| `heat-map` | exhibit | Options × dimensions with hot/cold cells | McKinsey |
| `s-curve` | exhibit | Two trajectories on time × maturity | Anthropic, OpenAI |
| `force-field` | exhibit | Drivers vs resistors of one outcome | current v1 |
| `logic-tree` | exhibit | Decision/problem tree, MECE branches | McKinsey |
| `comparison-table` | comparison | N × M options/dimensions table | current v1 |
| `strengths-cautions` | comparison | Per-option strengths · cautions · verdict | current v1 |
| `two-paths` | comparison | A vs B side-by-side · diverging consequences | a16z, McKinsey |
| `comparison-bar` | comparison | Single-axis bar (cost / risk / time) across N options | OpenAI |
| `recommendations` | action | 3-5 P0/P1/P2 actions with owner / horizon / success metric / risk-if-skipped | current v1 |
| `considerations` | action | Anthropic's softer "things you might consider" — same data, hedged voice | Anthropic |
| `the-bet` | action | a16z "if we were to back this, we'd require these N conditions" | a16z |
| `implications` | action | McKinsey "what this means for X / Y / Z" callout | McKinsey |
| `why-now` | forward | Why this window is open and how long it stays open | a16z |
| `planning-assumption` | forward | Probabilistic forecast · trigger · falsification test | current v1 |
| `outlook` | forward | Soft 12-24 month directional bet, no probability | OpenAI, Anthropic |
| `pre-mortem` | forward | 2-3 failure modes · leading indicators · mitigations | current v1 |
| `new-questions` | residual | Questions that did not exist when the room opened | current v1 |
| `open-questions` | residual | Residual unresolved questions tagged P0/P1 | current v1 |
| `acknowledgments` | residual | Anthropic-style "we are uncertain about / would change our mind if" | Anthropic |
| `methodology` | meta | Auto-generated · signal counts · lens distribution · models used | current v1 |
| `pull-quote` | meta | Standalone director quote, can appear ≤ 1×, anywhere | Anthropic, McKinsey |

### Composition rules

- Always exactly one `anchor`.
- At most one of `headline-findings` / `big-ideas` / `numbered-observations` / `key-findings-list` (they're substitutes).
- At most one of `recommendations` / `considerations` / `the-bet` (substitutes).
- At most one of `quadrant-chart` / `magic-quadrant` (substitutes).
- At most one of `comparison-table` / `strengths-cautions` / `two-paths` / `comparison-bar` (substitutes).
- At most 2 `exhibit`-category components total (forced visuals are worse than none).
- `methodology` always present (auto-generated, not LLM-written).
- Total non-meta components: 5–9. Below 5 = thin, above 9 = noise.
- A component is dropped if its `requires` predicate is not met by the
  signal pool (e.g. `comparison-table` needs ≥ 2 named options
  surfaced by ≥ 2 directors).

---

## 3 · Style spines

A spine is purely presentational: a cover treatment, a palette adjustment
inside the locked Boardroom token system, and per-component CSS overrides.
Spines never add or remove sections.

| spine | when to pick | feel |
|---|---|---|
| `boardroom-dark` | default · room recap, philosophical, mixed | current dark warm palette · McKinsey discipline |
| `a16z-thesis` | investment / market opportunity / "should we bet on X" | full-bleed thesis cover · big claims · oxidized orange accent |
| `anthropic-essay` | open-ended exploration / philosophical / framing | warm cream · serif essay body · numbered observations |
| `gartner-note` | strategic decision under uncertainty / vendor / option scoring | clinical white · numbered chapters · Magic Quadrant |
| `mckinsey-deck` | execution / operational / "how do we do X" | white deck · 3 pillars · exhibits with figure numbers |
| `openai-paper` | technical / research-style / N-option comparison | minimal sans · abstract-led · figure captions |

The spine controls cover, headings, exhibit captions, palette, and
voice register (terse / essay / clinical). It does not control which
components render — the composer does.

Locked across spines: the body type scale, baseline grid, the lime
accent token, dark/light parity, and the "no flattery, no preamble"
voice rules from `brief.ts`.

---

## 4 · Composer (Stage 1.5)

**Model**: `haiku-4-5` → `sonnet-4-6` fallback. Cheap, structured.

**Input**:
- `room.subject` (the user's question)
- `room.mode`
- The flattened signal pool from Stage 1 (with lens tags + director ids)
- A capabilities catalogue: the component library + spine list + composition rules

**Output** (strict JSON, fenced):

```json
{
  "spine": "a16z-thesis",
  "components": [
    { "kind": "thesis", "order": 1 },
    { "kind": "big-ideas", "order": 2 },
    { "kind": "why-now", "order": 3 },
    { "kind": "director-cards", "order": 4 },
    { "kind": "two-paths", "order": 5 },
    { "kind": "the-bet", "order": 6 },
    { "kind": "open-questions", "order": 7 }
  ],
  "rationale": "Investment-judgement framing, clear options, room split on which to back — a16z spine fits.",
  "subject_type": "investment-judgement"
}
```

**System prompt sketch** (~600 tokens):

```
You are the report composer. Pick the spine and components that will
produce the most useful brief for this specific room.

Rules:
· Pick exactly one anchor.
· Pick at most one from each substitute group (see catalogue).
· Total non-meta components: 5-9.
· Drop components whose `requires` is not satisfied by the signals.
· Spine ≠ template. Pick the spine whose voice fits, then pick
  components independently.
· If the topic doesn't clearly map to a spine, default to
  `boardroom-dark`.

Substitute groups:
{rendered from library config}

Topic→spine heuristics (non-binding):
{rendered table}

Output strict JSON, no prose.
```

**Validation**: server enforces all composition rules after the call.
Violations → strip excess components → retry once with the violation
in the user message. Second failure → fall back to default preset.

---

## 5 · Stage 2 changes (scaffold)

Today's `SCAFFOLD_SYSTEM` is one ~10 KB block enumerating all 12
sections. Split into per-component fragments:

```
src/ai/prompts/components/
  bottom-line/
    schema.ts           # TS interface + zod (or runtime check)
    extract.ts          # the prompt fragment that asks the LLM to fill it
    render.ts           # markdown contract: what it emits + CSS hooks
  thesis/
  big-ideas/
  ...
```

Stage 2's prompt becomes:

```
[SCAFFOLD_PREAMBLE]
[language instruction]

The composer has picked these components, in this order:
  1. thesis
  2. big-ideas
  3. why-now
  4. director-cards
  5. two-paths
  6. the-bet
  7. open-questions

For each, fill the schema:

[fragment for thesis]
[fragment for big-ideas]
...
```

The output JSON shape is still flat-keyed, but only the picked
component keys are present:

```json
{
  "title": "...",
  "spine": "a16z-thesis",
  "thesis": { ... },
  "bigIdeas": { ... },
  "whyNow": { ... },
  ...
}
```

Validation per component (rules from the schema), retry budget
unchanged (3× rising temperature).

---

## 6 · Stage 3 changes (final write)

`WRITE_SYSTEM` is similarly split. Each component fragment specifies
its markdown contract (heading shape, table shape, CSS class hooks)
keyed on the spine for spine-specific overrides.

For example, `bottom-line/render.ts` exports:

```ts
export const bottomLineRender: Record<Spine, RenderFragment> = {
  "boardroom-dark":   "## Bottom Line\\n[lead with judgement italicised]\\n[Confidence inline as `**Confidence: …**`]",
  "a16z-thesis":      "## The Thesis\\n[judgement as 36px pull-statement]\\n[confidence as small caps below]",
  "anthropic-essay":  "## A working hypothesis\\n[essay paragraph leading with the judgement]",
  "gartner-note":     "## 1.0 Bottom Line\\n[Bold one-line judgement followed by paragraph]",
  ...
}
```

The final markdown carries CSS class hooks via HTML comments that the
post-render pass converts to wrapping `<section class="section-…">`
divs (the same mechanism `report.html` uses today).

A component can omit a spine and inherit `boardroom-dark` rendering.

---

## 7 · Component schemas (illustrative subset)

Reuses existing TS interfaces in `src/ai/prompts/brief-stages.ts`
where possible. New schemas:

```ts
// thesis · single load-bearing claim
interface Thesis {
  claim: string;          // 12-22 words, complete sentence
  reasoning: string;      // 1-2 sentences on why this is the load-bearing claim
}

// big-ideas · 3 numbered claims, each with a why
interface BigIdea {
  number: 1 | 2 | 3;
  claim: string;          // 8-14 words
  why: string;            // 1-2 sentences
  evidenceRefs: string[]; // signal refs as `<directorId>#<idx>`
}
type BigIdeas = { ideas: [BigIdea, BigIdea, BigIdea] };

// why-now · single panel
interface WhyNow {
  windowOpened: string;       // what changed recently
  windowCloses: string;       // when/why it closes
  whatToBetOn: string;        // the bet implied by the window
}

// director-cards · per-director take
interface DirectorCard {
  directorId: string;
  oneLineTake: string;        // ≤ 80 chars
  lens: EvidenceLens;         // reuses existing 5-lens enum
  costOfBeingWrong: string;   // ≤ 80 chars
  pullQuote?: string;         // ≤ 40 words, in director's actual voice
}

// the-bet · a16z-style conditions
interface TheBet {
  ifBacked: string;           // "If we were to back this..."
  conditions: {               // 3-5 conditions
    condition: string;
    why: string;
  }[];
  killCriteria: string;       // when do we stop
}

// numbered-observations · Anthropic essay form
interface Observation {
  number: number;
  claim: string;
  prose: string;              // 3-5 sentences, essay register, not bullets
  pullQuote?: string;
}
type NumberedObservations = { intro: string; observations: Observation[] };
```

(Existing schemas — `BottomLine`, `FrameShift`, `HeadlineFinding`,
`ConvergencePoint`, `Divergence`, `PositionCamp`, `Visual` family,
`Recommendation`, `FailureMode`, `NewQuestion`, `PlanningAssumption`,
`OpenQuestion` — keep their current shape.)

---

## 8 · Topic → spine routing (composer heuristics)

Non-binding hints baked into the composer's system prompt. The
composer has discretion when the heuristic is ambiguous.

| signal in subject / signals | suggested spine | suggested anchor |
|---|---|---|
| "should we invest / build / back / bet" | a16z-thesis | thesis |
| "is X defensible / a moat / a market" | a16z-thesis | thesis |
| "what does X mean / are we right that" | anthropic-essay | working-hypothesis |
| "compare / which option / pick between" | openai-paper or gartner-note | abstract / bottom-line |
| "vendor / category / sizing / market scan" | gartner-note | bottom-line |
| "how do we do / roll out / execute / fix" | mckinsey-deck | bottom-line |
| philosophical / open-ended | anthropic-essay | working-hypothesis |
| post-mortem / retro / what happened | boardroom-dark | bottom-line |

If ≥ 2 directors used the `data` lens heavily → bias toward exhibit
components (`s-curve`, `quadrant-chart`, `comparison-bar`).

If divergence is sharp (≥ 2 directors with opposing stances) →
`director-cards` + `divergence` + (if applicable) `two-paths`.

If the conversation produced ≥ 1 new question that's clearly more
generative than the original → bias toward `new-questions` early in
the report (top 3), not buried.

---

## 9 · UI

### Brief card (room toolbar)

Today: "Generate brief" → fixed McKinsey output.
After: "Generate brief" → composer-picked spine. The card shows the
chosen spine with a small mono tag (`SPINE · a16z-thesis`) and the
composer's `rationale` on hover.

### Override

Beside the regenerate button, a `change spine` dropdown lists all 6.
Selecting one bypasses the composer's spine pick (components still
re-composed for that spine). This is the user's escape hatch when the
composer guesses wrong.

The existing "add a perspective" supplement field stays. Supplement
text is also shown to the composer — it can shift the spine pick
(e.g. user adds "look at this as a Gartner-style market scan" →
composer flips to `gartner-note`).

### Reading view

`public/report.html` becomes the `boardroom-dark` spine renderer. The
file splits into:

```
public/report/
  report.html              # shell · loads brief json + spine css
  spines/
    boardroom-dark.css
    a16z-thesis.css
    anthropic-essay.css
    gartner-note.css
    mckinsey-deck.css
    openai-paper.css
  components/
    bottom-line.css        # base styles, overridden per spine
    thesis.css
    ...
```

---

## 10 · API & storage

### `briefs` row · new columns

```sql
ALTER TABLE briefs ADD COLUMN spine TEXT NOT NULL DEFAULT 'boardroom-dark';
ALTER TABLE briefs ADD COLUMN components_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE briefs ADD COLUMN composer_rationale TEXT;
ALTER TABLE briefs ADD COLUMN subject_type TEXT;
```

`body_json` stays — now stores the full filled scaffold including only
the picked component keys. `body_md` stays — rendered markdown.

### API

```
GET  /api/rooms/:id/briefs/:briefId          → adds spine, components, rationale
POST /api/rooms/:id/briefs                   → body now optional { spine?, supplement? }
                                                spine forces composer's pick
GET  /api/composer/catalog                   → { components, spines, rules } for UI dropdown
```

The existing `style: BriefStyle` field on the route becomes an alias
for `spine` for backwards compat (single value `"mckinsey"` maps to
`boardroom-dark`).

### `report-writer` system skill

Updated `bodyMd` describes the composer model rather than the fixed
12-section shape. The skill remains read-only (still the chair's
source of truth). The "comparability over time" justification is
softened: spines are stable, so two `a16z-thesis` briefs are
comparable; cross-spine comparison is a known degradation accepted
in exchange for fit.

---

## 11 · Migration

- Existing briefs in the DB have `spine = 'boardroom-dark'` and
  `components_json = []` (empty = legacy, render via existing
  `report.html` path unchanged).
- New briefs always populate both fields.
- The legacy `BriefStyle = 'mckinsey'` value continues to work via the
  alias — no client changes required to keep generating today's
  reports.
- Phase the rollout:
  1. Ship the schema, wire `boardroom-dark` as the only spine, all 12
     current components always picked. Refactor only — no behaviour
     change.
  2. Add the composer (Stage 1.5). Component picks now vary; spine
     stays `boardroom-dark`.
  3. Add the other 5 spines, one per PR, behind a `composer.spines`
     allowlist in user prefs. Default-on once each spine has a
     working CSS renderer.

---

## 12 · Cost & latency

| stage | tokens in / out | model | latency |
|---|---|---|---|
| 1 (extract) | 800 / 300 × N directors | haiku-4-5 | parallel · ≤ 2s |
| **1.5 (compose)** | **1500 / 200** | **haiku-4-5** | **≤ 1s** |
| 2 (scaffold) | 4000 / 1500 (smaller — only picked components) | sonnet-4-6 | 4-8s |
| 3 (write) | 5000 / 3500 (smaller — only picked components) | opus-4-7 | streamed, 12-25s |

Net change vs. current: **+1s end-to-end, ~equal token spend** (Stage
2/3 shrink because they no longer carry every component's prompt
fragment, offsetting Stage 1.5).

---

## 13 · Out of scope (v1)

- User-authored components (only the catalogue the chair ships with).
- User-authored spines.
- Mixing spines mid-report (one spine per brief).
- Cross-brief comparison views (the storage supports it — the UI
  doesn't).
- Per-room composer-pinning ("always use a16z for room X").
- Streaming the composer's pick to the UI before Stage 2 starts. (Not
  hard, but not v1.)
- Live-editing a generated brief (still: regenerate or supplement).

---

## 14 · Test plan

**Unit · composer**
- Investment-themed subject + signals → spine `a16z-thesis`, components include `thesis` + `the-bet` + `why-now`.
- Philosophical subject → spine `anthropic-essay`, components include `working-hypothesis` + `numbered-observations`.
- N-option comparison signals → spine `openai-paper` or `gartner-note`, components include a comparison component + an exhibit.
- Composer returns invalid JSON → fallback to default preset, brief still produces.
- Composer picks 2 anchors → server strips excess and retries.

**Unit · per-component schema**
- Each component's extract prompt produces parseable JSON for a fixture transcript.
- Render contract for each `(component, spine)` pair produces markdown that lints (no broken tables, no orphan list items, valid mermaid in quadrant-chart).

**Integration · full pipeline**
- Adjourn a multi-director investment-themed room → produced brief uses `a16z-thesis` spine, ≥ 5 components, all required-by-rules sections present.
- Adjourn a single-director room (degenerate) → composer returns minimum 5 components or falls back gracefully.
- Mid-pipeline failure (kill stage 2) → placeholder brief is marked errored, not orphaned.

**UI**
- Spine dropdown shows the catalogue from `/api/composer/catalog`.
- "Change spine" regenerates and renders the new spine's CSS without page reload.
- Composer rationale appears on hover of the SPINE tag.
- Legacy briefs (no `components_json`) render via the existing
  `report.html` path — no regression.

**Visual regression**
- Each of the 6 spines, rendered against the same fixture brief, holds its visual identity within tolerance (manual review on first ship; automated screenshot diff is out of scope for v1).

---

## 15 · Resolved decisions

- **Anchor mandatory · always exactly one.** Pyramid-principle is non-negotiable: every report leads with a load-bearing claim. Spines that "feel essay-like" still pick an anchor — Anthropic essays use `working-hypothesis`, papers use `abstract`. Zero-anchor is a future relaxation if a real need emerges.
- **Composer model · `haiku-4-5` → `sonnet-4-6` fallback.** Mirrors Stage 1's escalation policy. If a 50-fixture eval shows haiku making poor picks (>15% of fixtures get a "wrong" spine on human review), the order flips to sonnet-first.
- **Catalogue versioning · never break a kind.** Component kinds are append-only. Schema evolution within a kind is forward-compatible only (new fields are optional with sensible defaults). Removing a kind requires ≥ 1 release of deprecation. Old briefs always render; new readers tolerate missing optional fields.
- **Multi-language · composer prompt is English; rationale is localized.** Component kinds and spine slugs are English literal strings (not translated). The composer's `rationale` field is produced in the report's output language so the UI hover reads naturally. The composer's system prompt explicitly states this split to prevent leakage in either direction.
