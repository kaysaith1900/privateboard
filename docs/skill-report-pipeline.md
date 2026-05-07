---
name: Report Pipeline · Boardroom
slug: report-pipeline
version: "1.0"
description: End-to-end design of the report generation system — from raw room transcript to rendered editorial brief. Documents the 3-stage pipeline, the component / house-style / spine composition layers, and the CSS discipline that keeps every spine readable.
scope: src/orchestrator/brief.ts · src/ai/prompts/{composer,brief-stages,brief,house-styles}.ts · public/report.html · public/report/spines/*.css · public/app.js (brief card)
audience: engineers + AI agents iterating on the brief subsystem
---

# Report Pipeline · Boardroom

## 1. The big picture

A "report" (= `brief` in the codebase) is produced when a room is
adjourned (or post-hoc via `POST /api/rooms/:id/brief`). The pipeline
is a **3-stage LLM flow** that turns the transcript into an editorial
markdown document, plus a **rendering layer** that drapes one of six
visual "spines" over the same markdown.

```
transcript → [Stage 1: extract] → DirectorAssets[]
            → [Stage 1.5: composer] → { spine, components, house_style }
            → [Stage 2: scaffold]    → BriefScaffold (JSON)
            → [Stage 3: write]       → markdown body (streamed)
            → [Methodology footer]   → final markdown
            → [report.html renderer] → spine-styled HTML
```

The decoupling — analysis (components) vs presentation (spines) vs
voice (house-styles) — is the load-bearing design decision. Same
content, three orthogonal layers of variation.

---

## 2. Pipeline orchestration

`src/orchestrator/brief.ts`

### 2.1 Trigger

```ts
generateBrief({ roomId, style?, supplement? }) → { briefId }
```

Inserts a placeholder brief row, registers an `inFlightBriefs` entry
keyed by briefId (plus a roomId index for idempotency), kicks off
`runPipeline` fire-and-forget. Returns immediately.

`POST /api/rooms/:id/brief` route checks `inFlightBriefForRoom(id)`
first — if a generation is already running, returns the existing
briefId rather than spawning a parallel pipeline. Without this guard,
double-clicks across the three CTAs (header link, no-brief card,
adjourn overlay) created duplicate brief rows + parallel pipelines +
two "generating…" tabs.

### 2.2 SSE event surface (room bus)

| Event | When | Payload |
|---|---|---|
| `brief-started` | Stage 1 begins | `{ briefId, style, language, chairName }` |
| `brief-stage`   | Each stage transitions | `{ briefId, stage, status, progress?, etaSec? }` |
| `brief-compose` | Composer finished | `{ briefId, spine, components, rationale, houseStyle }` |
| `brief-token`   | Stage 3 streams | `{ briefId, delta }` |
| `brief-final`   | Pipeline succeeded | `{ briefId, title, modelV }` |
| `brief-error`   | Unrecoverable failure | `{ briefId, message }` |

The frontend rehydrates from `/api/briefs/:id/status` (returns
`{ generating, hasBody, completed, state }`) when a freshly-loaded
client lands mid-pipeline.

### 2.3 In-flight cancellation

`abortBriefGeneration(briefId)` aborts the controller; every plumbed
`callLLMStream` / `callLLMWithUsage` gets the signal. Pipeline's
`finally` clears the map entry. Used by `DELETE /api/briefs/:id`.

### 2.4 Model tiers

`stageCheapList()` / `stageFlagshipList()` resolve to the user's
configured carrier:

- **cheap** (Stage 1 extract, Stage 1.5 composer): `utilityModelFor()` — haiku-4-5 / gpt-5-4-mini / gemini-3-1-flash / grok-4-mini
- **flagship** (Stage 2 scaffold, Stage 3 write): `effectiveDefaultModel()` — opus-4-7 / gpt-5-5 / gemini-3-1 / grok-4

Each tier ships a fallback list (cheap-first with flagship safety net,
or vice versa) so a single-carrier user with degenerate tiers doesn't
double-retry the same model.

---

## 3. Stage 1 · per-director extract

`buildExtractMessages` + `parseDirectorAssets` (brief-stages.ts)

Every director runs in parallel through `callLLMWithUsage`
(`maxTokens: 1600`, temp 0.2). Each gets only their OWN turns from
the transcript and produces a 9-field structured asset bundle:

```ts
DirectorAssets = {
  directorId, directorName,
  claims:        Claim[],        // { text, lens, confidence, evidenceRefs[] }
  evidence:      Evidence[],     // { text, source, supports[] }
  tensions:      Tension[],      // { text, between?: [partyA, partyB] }
  assumptions:   Assumption[],   // { text, falsifier?, confidence }
  risks:         Risk[],         // { text, severity, likelihood }
  opportunities: Opportunity[],  // { text, conditions }
  actions:       Action[],       // { text, owner?, horizon? }
  quotes:        Quote[],        // { text, ≤ 40 words verbatim }
  openQuestions: OpenQuestion[], // { text, priority }
}
```

The `lens` tag (`data | dissent | narrative | structural | first-principle`)
is per-claim and propagates downstream into the methodology footer
+ the prior-context block for follow-up rooms.

Empty bundles are valid (`{ claims: [], … }`) — the composer + scaffold
treat them as "this director said nothing worth preserving". Per-field
caps drop overflow entries.

---

## 4. Stage 1.5 · composer

`buildComposerMessages` + `parseComposerOutput` (composer.ts)

Cheap LLM call (haiku tier) that picks **3 things**:

```json
{
  "house_style": "sequoia-memo",
  "spine": "a16z-thesis",
  "subject_type": "investment-judgement",
  "components": [
    { "kind": "thesis", "order": 1 },
    { "kind": "why-now", "order": 2 },
    ...
  ],
  "rationale": "≤ 120 chars · why this fit"
}
```

### 4.1 Tone-first picking discipline

The `ROOM TONE` block at the top of the composer's user message is
the **highest-priority constraint**. Each house-style entry declares
`tones` (mode it fits) + `avoidTones` (mode it clashes with). The
composer is told: pick house style to match the room's TONE first,
the subject second.

Why: a critique-mode room must NOT output a warm operator-essay
register; a brainstorm-mode room must NOT output a hedged scholarly
note. The voice register and the room's working agreement have to
match, or the brief reads as if a different room produced it.

### 4.2 Component substitute groups

```
Anchor   (pick exactly 1) · bottom-line | thesis | working-hypothesis
Findings (pick exactly 1) · headline-findings | big-ideas
Action   (pick exactly 1) · recommendations | the-bet | considerations
```

Validation: violating these is auto-rejected → fall back to
`DEFAULT_PRESET` (12 sections, neutral voice).

### 4.3 Optional + density blocks

| Bucket | Components |
|---|---|
| **Optional** | frame-shift, convergence, divergence, positions, visuals, two-paths, why-now, pre-mortem, new-questions, planning-assumption, open-questions |
| **Gartner-density** (uncertainty-heavy briefs) | strategic-outlook, critical-assumptions, scenario-tree, leading-indicators |
| **Self-criticism** | threats-to-validity (distinct from pre-mortem AND critical-assumptions) |
| **Visual** | metric-strip (3-5 KPI cards · `data` lens count > 0 required) |

### 4.4 Component-count caps (signal-budget gating)

```
≤ 12 signals → max 8 components
13–24 signals → max 10 components
> 24 signals → max 12 components
```

Briefs with 12 signals across 10 components recycle each signal across
multiple sections, producing thin / repetitive coverage. Picking fewer
when material is thin is strictly better.

### 4.5 Visualisation floor

Every brief should carry **≥ 1** visual component (visuals,
metric-strip, two-paths, scenario-tree, or leading-indicators) unless
genuinely unvisualisable (philosophical / pure narrative retro). The
floor exists because reports without visuals read as walls of text and
lose the reader.

Lens-fit constraint: `metric-strip` requires `data` lens count > 0.
The writer can't fabricate quantitative cards from non-quantitative
signals.

### 4.6 Fallback path

`defaultComposition(reason)` returns the safety-net 12-section preset
(`boardroom-dark` spine + `boardroom-default` house style) when:
- The LLM call failed
- Output couldn't be parsed
- Validation rejected the picks
- Room had no signals

Recorded as `fromComposer: false` so the brief row distinguishes
composer-driven vs fallback briefs.

---

## 5. House styles · 7 presets

`src/ai/prompts/house-styles.ts`

| Preset | Spine default | Voice | Best for tones |
|---|---|---|---|
| `boardroom-default` | boardroom-dark | Neutral analyst | any (fallback) |
| `sequoia-memo` | a16z-thesis | Investment-memo · declarative · partner-voice | constructive, debate |
| `a16z-thesis` | a16z-thesis | Contrarian thesis · claim-forward · "consensus says X — we think Y" | debate, constructive |
| `stanford-research` | openai-paper | Hedged scholarly · threats-to-validity surfaced | research, critique |
| `bcg-strategy` | mckinsey-deck | MECE · pyramid principle · imperative actions | constructive, critique, debate |
| `first-round-essay` | anthropic-essay | Operator essay · first-person plural · narrative | brainstorm, research |
| `gartner-research` | gartner-note | Probabilistic · watch-list · confidence + falsifier | research, critique, constructive |

Each preset declares:
- `voice` (zh + en, ≤ 600 chars each) — injected verbatim into Stage 3
- `labels` (per ComponentKind) — section heading overrides, bilingual,
  often as variant arrays (renderer picks one deterministically by
  briefId hash so the SAME brief always reads consistently but
  DIFFERENT briefs in the same style see different titling)
- `tones` (modes the style fits) + `avoidTones` (clashes)
- `fits` (subject types — soft hint)
- `pitch` (1-line catalog blurb for the composer)

The `boardroom-default` is the no-overrides fallback. Old briefs and
any composer slip render as before.

---

## 6. Stage 2 · scaffold

`buildScaffoldMessages` + `parseScaffold` (brief-stages.ts)

Single flagship-tier LLM call (sonnet/opus, `maxTokens: 8000`) that
takes the per-director assets + composer's component picks + house-
style voice and produces a **structured JSON scaffold** matching the
component shape contracts:

```ts
BriefScaffold = {
  bottomLine?:        { judgement, confidence, rationale }
  thesis?:            { claim, ≤ 16 words, pull-quote }
  workingHypothesis?: { hypothesis, why-it-may-be-wrong }
  headlineFindings?:  Pillar[3]   // each: title + supporters + challengers
  bigIdeas?:          Idea[3]     // numbered claims + why
  // Plus every other picked component's structured fields...
  // Components NOT picked are simply absent.
}
```

Retry budget: `STAGE_2_RETRIES = 2` × 2 models = 4 attempts max.
Rising temperature (`[0.2, 0.5]`) per retry. Exhausted retries surface
as `pipelineError = "Report writer couldn't structure this room
(3 retries failed). Try regenerating, or shorten the conversation."`

Scaffold's `bottomLine.judgement` (or thesis.claim / workingHypothesis.
hypothesis) is also used to set an INTERIM brief title BEFORE Stage 3
streams — so the user opening report.html mid-stream doesn't see the
placeholder room subject.

---

## 7. Stage 3 · final write

`buildWriteMessages` + `runStage3Streaming` (brief.ts)

Streaming flagship LLM call (`maxTokens: 12000`, temp 0.4). Inputs:
- Composer's component picks + order
- House-style's voice + section labels
- Stage 2's scaffold (the JSON skeleton)
- Per-director signals (for citation by attribution)
- Optional `supplement` (user's "add this perspective" request)

Output: a rendered markdown document, streamed token-by-token via
`brief-token` SSE → frontend appends to brief body.

The writer is told to:
- Render ONLY the picked components (composer's order)
- Use the house-style's voice register verbatim
- Use the house-style's section labels (variant pre-resolved per briefId)
- Cite directors by attribution when surfacing claims ("Socrates via
  definitional lens flagged X")
- Honor the brief's language (zh / en — detected from room.subject)

After Stage 3, an **auto-generated Methodology footer** is appended
(deterministic — no LLM tokens burned):

```markdown
## Methodology

This report is based on 3/3 directors' load-bearing observations
across **N signals**, distributed across five evidence lenses:
data 4 · dissent 6 · narrative 5 · structural 7 · first-principle 2.

Pipeline: each director extracted independently → chair clustered
into a scaffold → chair wrote the final report. Writer model: opus-4-7.

**Model chain:** composer haiku-4-5 · scaffold sonnet-4-6 · writer opus-4-7
```

---

## 8. Components catalog

25 kinds, append-only (legacy briefs always remain renderable).

```
Anchor          bottom-line · thesis · working-hypothesis
Findings        headline-findings · big-ideas
Action          recommendations · the-bet · considerations
Optional        frame-shift · convergence · divergence · positions
                · visuals · two-paths · why-now · pre-mortem
                · new-questions · planning-assumption · open-questions
Density blocks  strategic-outlook · critical-assumptions
                · scenario-tree · leading-indicators
Self-criticism  threats-to-validity
Visual         metric-strip
```

Each component has:
- A JSON shape (validated by parseScaffold)
- A markdown render contract (Stage 3 follows it)
- A spine-agnostic CSS class (`.section-{kind}`) that each spine can
  override

`visuals` itself is a parent component with 7 sub-types: comparison-
table, quadrant-chart, force-field, strengths-cautions, bar-chart
(mermaid xychart-beta), timeline (mermaid timeline), pie-chart
(mermaid pie). Triggers in the composer prompt: ranked numeric →
bar-chart; chronology → timeline; distribution → pie-chart; 2-axis →
quadrant-chart; options matrix → comparison-table or strengths-cautions;
drivers/resistors → force-field.

---

## 9. Spines · 6 visual CSS

`public/report/spines/*.css`

| Spine | Best for | Aesthetic |
|---|---|---|
| `boardroom-dark` | default · room recap · mixed | warm-dark editorial, mono kickers, lime accents |
| `a16z-thesis` | investment / opportunity / "should we bet on X" | bold thesis-essay, gold accents, pull-statement style |
| `anthropic-essay` | open-ended / philosophical / framing | warm cream, italic-clay emphasis, mono kickers above every section, drop cap on intro |
| `gartner-note` | strategic decision under uncertainty / vendor scoring | risk-conscious, table-heavy, probability bands |
| `mckinsey-deck` | execution / operational / "how do we do X" | structured, MECE, navy accents, pyramid presentation |
| `openai-paper` | technical / research-style / N-option comparison | scholarly, hedged, threats-to-validity surfaced |

The composer can override the house-style's default spine. The
renderer reads `briefs.spine` regardless of `briefs.house_style`.
Schema accepts any of the 6; coercion fallback is `boardroom-dark`.

### 9.1 Anthropic-essay spine · the reference design

`mvp/screen-7-report-anthropic.html` is the canonical typography +
component reference for the anthropic-essay spine. When in doubt
about a design choice in any spine, check whether the same choice
appears in this reference.

Key patterns from the reference:
- **Dual register** · serif (Tiempos / Charter) for headlines + emphasis
  quotes; sans (Söhne / Inter) for body prose + data; mono for kickers
  + labels
- **`<em>` is italic in spine accent colour** (`--clay-deep` for
  Anthropic, `--gold-deep` for a16z) — this single typographic gesture
  ties the doc together
- **Headings stay roman**; emphasis lives in the `<em>` they contain
- **Mono kicker on every section opener** (`01 — Section Name`,
  `font-family: mono`, 11px uppercase, 0.18em letter-spacing, accent
  colour, 16-24px above the H2)
- **Considerations / recommendations** → italic **lower-roman**
  (`i. ii. iii.`) numerals in spine accent
- **Open questions** → `decimal-leading-zero` (`01 02 03`) numerals,
  serif italic, accent colour, ~22px
- **Pull quote / blockquote** → top + bottom 1px rules ONLY · no
  `border-left`, no quotation marks, no decorative brackets
- **Drop cap** reserved for the FIRST paragraph of intro / working
  hypothesis · once per report
- **Container widths** · essay text 740px, figures + side-by-side 940px

---

## 10. Render layer

`public/report.html`

```
┌─ TOP RULE ──────────────────────────┐
│  Boardroom · Research Note          │
│  Dossier {ID} · Filed {date}        │
├─ COVER ─────────────────────────────┤
│  H1 · brief title                   │
│  cover-deck (lede, 2-3 lines)       │
│  byline-block grid                  │
│   · Filed     · Authors             │
│   · Subject   · Doc ID              │
├─ TOC (print only) ──────────────────┤
├─ BODY ──────────────────────────────┤
│  rendered markdown                  │
│  per-section CSS class:             │
│    .section-{kind}                  │
│  injected chapter numbers:          │
│    01 / 02 / 03 ...                 │
├─ METHODOLOGY (always last) ─────────┤
├─ FOOT RULE ─────────────────────────┤
│  // end of brief · boardroom        │
└─ COLOPHON ──────────────────────────┘
```

### 10.1 CSS layering

- **Spine CSS** (per spine, `report/spines/{spine}.css`) — typography,
  palette, component overrides
- **Spine-agnostic rules** in `report.html`'s inline `<style>` — load
  AFTER the per-spine CSS so they win specificity without `!important`.
  Use `:has()` to scope tightly.

Common spine-agnostic rules in report.html:
- Suppress duplicate parallel borders at section boundaries
- Drop heavy table top-rules when the table is the first content of
  a section (chapter-num underline already provides the divider)
- Methodology h2 border-top suppression when preceding section already
  carries a closing rule
- Author byline styling (recently changed from avatar imgs to name list)

### 10.2 CSS discipline (CLAUDE.md house rules)

These are RULES — not preferences. Violations recur if the rules
aren't enforced:

1. **No coloured `border-left` callouts** — never. Use top rules,
   prefix labels (`// label`), or pure typography. Applies to message
   bubbles, report sections, modal callouts, anywhere "this block is
   special" treatment is needed.

2. **No duplicate parallel borders at section boundaries** — when
   adding a `border-top` / `border-bottom`, check whether an adjacent
   element already carries a parallel rule. If yes, suppress one of
   the two. Spine-agnostic rules go in report.html's inline style;
   spine-specific go in the spine CSS.

3. **No sub-pixel sizing in the report system** — never `0.5px`,
   `13.5px`, `0.5px solid`, etc. anywhere in `report.html` or
   `report/spines/*.css`. Half-pixels render fuzzy on non-Retina
   screens. Two divider weights only:
   - `1px solid var(--rule)` — section dividers, card edges, byline
     rules. `--rule-soft` token gives a *lighter tone* at 1px (used
     for table row dividers).
   - `2px solid var(--ink)` — anchor / table top / cover bottom.
     Reserved for "this opens a major block."
   When pasting CSS from external references (Anthropic / a16z designs
   often use `0.5px` for hairline accents), normalise to 1px during
   the adaptation pass.

4. **Headings + section content share width** — don't put a
   `max-width` on `.body h2` while letting `.body table.md-table` use
   the full content width. The mismatch reads as a visual bug.

### 10.3 Inline script syntax check

`report.html` and `index.html` carry large inline `<script>` blocks
(report renderer is ~1250 lines inline). A single missing `})` produces
NO server error, NO build warning — the file serves cleanly and the
browser silently rejects the whole block, page renders blank.

After ANY edit to inline scripts:

```sh
awk '/<script>/{p=1;next} /<\/script>/{p=0} p' public/report.html | node --check
```

Exit 0 = clean. Symptom looks identical to "data lost" / "API broken"
but is purely a frontend syntax bug.

---

## 11. Lifecycle · regen, retry, multi-version

A room can have multiple briefs (initial + "add a perspective"
regenerations). The brief tab strip surfaces them; tabs ordered
oldest → newest, "01" reads as the original.

### 11.1 Regenerate ("Add a perspective")

Supplement overlay → POST `/api/rooms/:id/brief` with
`{ supplement: "look at this through a Gartner lens" }`. Server
inserts a NEW brief row. The composer + scaffold + writer all see the
supplement; Stage 1's per-director extraction stays independent (cached
from the original room).

**Frontend in-flight lock** (`_supplementInFlight`) on the supplement
overlay prevents double-clicks creating duplicate briefs.

**Do NOT mutate `currentBrief` on the new brief click**. The new
brief arrives via `brief-started` SSE with its own id; the dedup-by-id
push appends it. Mutating the prior good brief in-place corrupts a
working tab into a "Generating…" zombie.

### 11.2 Retry (failed brief)

Two failure modes:
- `b.error` (LLM error reached) — set by `brief-error` SSE
- `b.interrupted` / `b.timedOut` — set by zombie detector (no body +
  not in flight)

Retry button calls `retryBriefGeneration(targetBriefId)`:
1. DELETE the failed brief
2. POST a fresh `/brief`
3. New brief flows through the standard SSE pipeline

The `targetBriefId` parameter is required when the salvage banner
calls retry — currentBrief may have been swapped to a good brief by
the salvage path; passing the explicit failed id ensures the retry
deletes the right row.

### 11.3 Salvage path

When the active brief has `error` AND a prior good brief exists, the
brief card renders the GOOD brief's content (full report + tabs) and
prepends a compact retry banner at the top. The user keeps reading
the prior report while seeing that the regen failed.

`renderBrief({ bypassSalvage: true })` skips this — used by the tab
click handler so a user explicitly clicking the failed tab sees its
real error UI.

### 11.4 Zombie detection

On `openRoom` for an adjourned room, `checkBriefHealth` runs against
EVERY placeholder brief (not just the active one). Hits
`/api/briefs/:id/status`:
- `generating === true` → hydrate stages from server snapshot
- `generating === false && !hasBody` → mark `brief.error = "interrupted"`,
  flip into the retry UI

Without this, briefs whose pipeline died on server restart sit in DB
with empty body forever, rendering as stuck "Generating…" tabs.

### 11.5 No-brief path

Adjourn-with-skipBrief produces a chair message with
`meta.kind === "no-brief"`. Renders as a milestone marker card in
chat. Carries a `[ ▸ Generate report now ]` CTA when no brief exists
yet for the room — calls `generateBriefForAdjournedRoom()`. The
header-right `[ ⊘ No Report ]` static span has been replaced by the
same CTA.

---

## 12. Brief card (chat preview)

`public/app.js` · `renderBrief()` + `_renderBriefTabsHtml()` +
`_briefWordCount()`

Sits at the bottom of the chat for an adjourned room. Layout:

```
┌─ tab strip (when ≥ 2 briefs) ─────────────┐
│ [ 01 Initial ] [ 02 Sequoia view ] ...   │
├─ brief-banner ────────────────────────────┤
│ // report                       FILED ... │
├─ brief-body ──────────────────────────────┤
│ // filed by The Chair                     │
│ # Brief title                             │
│ 3 authors · 2,140 words                   │
│                                           │
│ [ ▸ open report → ]                       │
└───────────────────────────────────────────┘
```

Tab strip:
- Errored / interrupted / timed-out tabs get a small red `!` marker
  next to the version number (CSS `.brief-version-state`)
- Per-tab `×` deletes that brief
- Click switches `currentBrief` + re-renders with `bypassSalvage: true`

Word count helper strips markdown decoration before counting. CJK ≥
30% of stripped length AND > 80 chars → count chars (`~3,247 字`).
Otherwise whitespace-split words (`3,247 words`).

---

## 13. Tone-shift discipline (in-room → report alignment)

Two distinct tone axes that USED to be unlinked:

| Axis | Where | Values |
|---|---|---|
| Room tone | `room.mode` | brainstorm / constructive / debate / research / critique |
| Report register | `brief.house_style` | sequoia-memo / a16z-thesis / stanford-research / bcg-strategy / first-round-essay / gartner-research |

The composer now treats `room.mode` as the highest-priority constraint:
each house-style declares `tones` + `avoidTones` and the composer
prompt explicitly names which to AVOID. A critique room can no longer
output an operator-essay register; a brainstorm room can no longer
output a hedged scholarly note.

If the composer must override (e.g. "the room ran in `debate` but the
material is investment-judgement and `a16z-thesis` is the only honest
fit"), it states the override reason in `rationale`.

---

## 14. Authoring discipline (writing the brief)

The Stage 3 prompt threads several non-negotiable rules:

- **One anchor** (bottom-line / thesis / working-hypothesis) — the
  argument's load-bearing claim
- **One findings block** (headline-findings / big-ideas) — the
  evidence layer
- **One action block** (recommendations / the-bet / considerations) —
  the "what now"
- **Visual floor** — at least one component from { visuals,
  metric-strip, two-paths, scenario-tree, leading-indicators }
- **Attribution citation** — when a director's claim drives a section,
  cite by lens ("Socrates via definitional lens flagged…")
- **Voice fidelity** — house-style's voice prose injected verbatim
  into the writer's system prompt; the writer matches register
- **Section vocabulary** — house-style's `labels[kind]` provides the
  exact heading; one variant pre-resolved per briefId for
  reproducibility, different per brief for variety

---

## 15. Provenance footer

The Methodology footer surfaces the model chain:

```markdown
**Model chain:** composer haiku-4-5 · scaffold sonnet-4-6 · writer opus-4-7
```

`PipelineProvenance` is mutable, threaded through stages — each stage
writes its successful model into the matching field. Used at render
time as a small reproducibility log under the methodology line.

---

## 16. File map

```
src/orchestrator/brief.ts              · pipeline orchestrator + SSE bus
src/ai/prompts/brief-stages.ts         · Stage 1 + Stage 2 prompts + parsers
src/ai/prompts/brief.ts                · Stage 3 write prompt
src/ai/prompts/composer.ts             · Stage 1.5 picker
src/ai/prompts/house-styles.ts         · 7 voice/label/tone/spine presets
src/storage/briefs.ts                  · DB CRUD (schema below)
src/storage/migrations/                · brief column migrations
src/routes/rooms.ts (POST /:id/brief)  · regen + post-hoc generation
src/routes/briefs.ts                   · per-brief read / status / delete
public/report.html                     · cover + body + methodology renderer
public/report/spines/*.css             · 6 visual spine CSS files
public/app.js (renderBrief / tabs)     · in-chat brief card
public/index.html (brief card CSS)     · tabs / banner / retry / chips
mvp/screen-7-report-anthropic.html     · canonical anthropic-essay reference
```

---

## 17. DB schema (briefs)

```sql
CREATE TABLE briefs (
  id              TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL,
  style           TEXT NOT NULL,        -- legacy; v1 ignores
  title           TEXT NOT NULL,
  body_md         TEXT NOT NULL,
  spine           TEXT,                 -- composer pick (1 of 6)
  house_style     TEXT,                 -- composer pick (1 of 7)
  components_json TEXT,                 -- ComponentPick[] JSON
  composer_rationale TEXT,              -- non-null = composer succeeded
  subject_type    TEXT,                 -- analytics
  assets_json     TEXT,                 -- DirectorAssets[] cache
  supplement      TEXT,                 -- "add a perspective" text
  language        TEXT,                 -- zh | en
  created_at      INTEGER NOT NULL
);
```

`assets_json` caches Stage 1 output so regeneration with a supplement
can skip Stage 1 entirely (assets are room-scoped, not supplement-
scoped).

---

## 18. Things future-me should remember

1. **The composer fallback is silent** — when `fromComposer = false`,
   the brief renders fine but with the legacy 12-section preset.
   `composer_rationale` being null is the only signal it happened.

2. **House-style label variants are seeded by briefId** — same brief
   regenerated produces the same titling; different briefs in the
   same style get different titling. This is `pickIndex(briefId, kind, n)`
   in house-styles.ts. Don't randomise without seeding or you break
   reproducibility.

3. **Spine ≠ template** — the same scaffold renders through any spine.
   Spines override CSS, not section structure.

4. **The signal-budget cap is enforced in the prompt, not the parser**
   — the composer's prompt prints the cap explicitly; if the model
   exceeds it, validation rejects → fallback. So a "too noisy" brief
   is composer-driven not validator-driven.

5. **Report HTML inline script must syntax-check** — see §10.3.

6. **`-webkit-text-security: disc`** is the right tool for password-
   like inputs that should escape the browser's password manager
   (used in user-settings for API keys). Different problem from the
   report system but the same lesson applies: defaults aren't always
   right.

7. **`text-security: disc` (and the `-webkit-` variant)** lets us mask
   text without `type="password"` — keeps password managers from
   showing "save?" popups when the user navigates away from a typed
   key.

8. **CSS in report.html loads AFTER spine CSS** — that's WHY the
   spine-agnostic rules can suppress per-spine choices via plain
   `:has()` selectors instead of `!important`.
