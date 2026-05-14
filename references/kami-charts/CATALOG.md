# Kami inline-chart catalog · adaptation map

Source: https://github.com/tw93/Kami · MIT-licensed · ~14 templates.

This catalog maps **our current mermaid sub-types** (in `brief-stages.ts` and
`composer.ts`) to **kami inline-SVG templates** (mirrored in this folder).
The goal is to drop mermaid's runtime renderer and JSON-DSL altogether — every
chart becomes a self-contained inline SVG block our renderer can drop into the
report verbatim.

## Why we're moving

Mermaid problems we've been patching for v0.1–0.15:
- Strict, fragile DSL — colons, parens, non-ASCII in labels all crash the lexer
- Whole subsystem of `mermaid-sanitize.ts` (~150 lines) just to make
  LLM output parse
- Palette-takeover race condition (`feedback_mermaid_palette_takeover.md`) —
  we render twice to avoid the user seeing the default theme
- `dmermaid-*` scratchpad div that has to be CSS-hidden
- Spine palette mapping that has to mirror tokens
  (`feedback_mermaid_spine_tokens.md`)
- ~215 lines of mermaid-related CSS in `report.html` alone

Kami's approach replaces the entire pipeline with **inline SVG emitted by the
brief writer, fronted by spine-tokenized templates we own**.

## Visual catalogue · 14 kami types

Each row: kami template (file in this folder) · what it draws · which of our
current mermaid types it replaces.

| Kami template     | What it draws                                          | Replaces mermaid type           | Used in current `visuals`? |
|---                |---                                                     |---                              |---                         |
| `quadrant.html`   | 2-axis plot, labelled items                            | `quadrantChart`                 | yes · `quadrant-chart`     |
| `bar-chart.html`  | Categorical comparison · 1–3 series × ≤8 categories    | `xychart-beta`                  | yes · `bar-chart`          |
| `line-chart.html` | Trend over time · 1–3 lines × ≤12 points               | (none; new capability)          | new                        |
| `donut-chart.html`| Proportional breakdown · ≤6 slices                     | `pie showData`                  | yes · `pie-chart` (rename) |
| `timeline.html`   | Time axis + milestone events                           | `timeline`                      | yes · `timeline`           |
| `flowchart.html`  | Decision branches · if-then-else                       | `flowchart`                     | inline mermaid             |
| `state-machine.html` | Finite states + directed transitions                | `stateDiagram-v2`               | inline mermaid             |
| `swimlane.html`   | Cross-responsibility process · multi-role              | `sequenceDiagram` / `journey`   | inline mermaid             |
| `tree.html`       | Hierarchical relationships · org chart / module deps   | `mindmap`                       | inline mermaid             |
| `architecture.html` | System components + connections                      | (none; new capability)          | new                        |
| `layer-stack.html`| Vertically stacked system layers · OSI / app stack     | (none; new capability)          | new                        |
| `venn.html`       | Set intersections · 2–3 circles                        | (none; new capability)          | new                        |
| `candlestick.html`| OHLC price action · ≤30 days                           | (none; new capability)          | new                        |
| `waterfall.html`  | Revenue bridge / decomposition · ≤8 segments           | (none; new capability)          | new                        |

**Gaps & notes:**
- `gantt` (mermaid) → no exact kami equivalent. Decision: render as `timeline`
  with each entry showing period + duration, OR as `swimlane` if multi-track.
  Default: timeline.
- `mindmap` → `tree` is the closest geometric match; kami's tree is hierarchical
  rather than radial. For our use case (clustering ideas) hierarchical is fine.
- `pie-chart` → renamed to `donut-chart` in the new system; kami doesn't ship
  a pie variant (and donut is more readable at small sizes).

## Token mapping · kami palette → PrivateBoard spine tokens

Kami uses ONE palette across all charts. We have **six spines**, each with
its own palette. Strategy: the chart templates use **CSS variables**, not
hard-coded hex values, so each spine paints them differently at render time.

| Kami token       | Kami hex   | PrivateBoard spine variable           | Spine fallback (anthropic-essay)  |
|---               |---         |---                                    |---                                |
| `--parchment`    | `#f5f4ed`  | `--paper`                             | `#F4EFE6`                         |
| `--ivory`        | `#faf9f5`  | `--paper-soft`                        | `#ECE6DA`                         |
| `--near-black`   | `#141413`  | `--ink`                               | `#2A2724`                         |
| `--olive`        | `#504e49`  | `--ink-mid`                           | `#6A655D`                         |
| `--stone`        | `#6b6a64`  | `--ink-soft`                          | `#9A938A`                         |
| `--brand`        | `#1B365D`  | `--accent` (per-spine)                | `#B0664C` (clay) / brass (#7A5E26)|
| `--brand-tint`   | `#EEF2F7`  | `--accent-tint` (per-spine)           | `#F3E5DC` (clay tint)             |
| `--border`       | `#e8e6dc`  | `--rule`                              | `rgba(42,39,36,0.14)`             |

Each spine's CSS already declares `--paper / --ink / --ink-mid / --accent`,
so kami's hard-coded hex values get replaced with `var(--paper)` etc., and
the spine's own palette flows through automatically. This is the same
mechanism that powered mermaid's spine-token mapping (only simpler — no JS
takeover).

## Renderer format · `kami-chart` fenced block

Replace mermaid's

````markdown
```mermaid
quadrantChart
title Foo
x-axis Effort --> ...
...
```
````

with

````markdown
```kami-chart
{
  "type": "quadrant",
  "title": "Effort vs. impact, 2026 Q3 launches",
  "xLabel": "Effort",
  "yLabel": "Impact",
  "quadrants": { "q1": "Quick wins", "q2": "Major projects", "q3": "Fill-ins", "q4": "Thankless tasks" },
  "items": [
    { "label": "Idea A", "x": 0.72, "y": 0.84 },
    { "label": "Idea B", "x": 0.35, "y": 0.66 }
  ],
  "focal": "Idea A",
  "caption": "Idea A dominates effort-adjusted impact; B is a fast follow."
}
```
````

The renderer in `report.html`:
1. Detects fenced ` ```kami-chart ` blocks (mirrors how `metric-strip` blocks
   are detected today).
2. Parses the JSON.
3. Looks up the `type` in a registry of SVG generators (one per kami template).
4. Emits the inline SVG with the data filled in.
5. Wraps in `<figure>` + `<figcaption>`.

LLM never sees raw SVG. The generator owns coordinates / scaling / palette.
Failure mode shifts from "syntax error" to "bad JSON" — orders of magnitude
easier to validate (we already do JSON parse + retry for the scaffold stage).

## Per-spine accent strategy

Each spine has ONE accent (clay / orange / navy / teal / lime / brass).
The accent maps to `--brand` inside the chart, used for:
- The focal series in bar / line / donut / waterfall
- The focal item in quadrant / architecture / tree
- Focal text in timeline / swimlane
- Q1 highlight in quadrant (top-right wins)
- "Up" candles in candlestick (down stays neutral)

Non-focal data stays in the neutral grayscale (`olive` → `--ink-mid`,
`stone` → `--ink-soft`, mist / light-stone → tinted neutrals).

This preserves kami's **1–2 focal element rule** at the system level.

## Migration phases

**Phase 1** — Mirror templates + write catalog. ✓
**Phase 2** — Pilot · bar-chart end-to-end. ✓
  - CSS + JS dispatcher in `report.html`
  - `renderKamiBar()` SVG generator
  - `brief-stages.ts` bar-chart prompt → `kami-chart` JSON
  - Renderer test harness in `_adapted/_renderer-test.html`
**Phase 3** — Remaining typed visuals (quadrant / timeline / donut). ✓
  - `renderKamiQuadrant()` · 2-axis plot with preferred Q1 tint, optional
    `focal` item, optional per-item `tier` (1–4) for visual weight
  - `renderKamiTimeline()` · 3–8 events on a horizontal axis, alternating
    above/below, `focal` event renders in accent
  - `renderKamiDonut()` · 2–6 slices (renames `pie-chart` to donut),
    largest slice = accent + centre value
  - `brief-stages.ts` prompts for all 3 → `kami-chart` JSON
  - `composer.ts` updated · "mermaid" → "chart" in picker descriptors
  - 4 typed visuals now fully on kami pipeline
**Phase 4 (first half)** — Inline mermaid types · flowchart / mindmap / gantt. ✓
  - `renderKamiFlowchart()` · two layouts (`linear-v` for 2–5 node chains,
    `y-decision` for root → 2 branches → optional join). Node `kind`
    drives shape: start/end (pill), step (square), decision (diamond),
    outcome (faint square). `focal` highlights one node in accent.
  - `renderKamiTree()` · 1 root + 2–6 branches × 0–4 leaves. Right-angle
    connectors with chevron arrows. Replaces mermaid `mindmap`.
  - `renderKamiGantt()` · phases as horizontal bars on a shared time
    axis, optional `section` grouping. Auto-scales to nice-round max.
    Replaces mermaid `gantt`.
  - `brief-stages.ts` prompts for all 3 → `kami-chart` JSON. Trigger map
    "flowchart TD" references stripped to bare "flowchart".
**Phase 4 (second half)** — sequenceDiagram / journey / stateDiagram. ✓
  - `renderKamiSwimlane()` handles BOTH sequenceDiagram + journey.
    Multi-lane layout (2–4 lanes × 3–10 steps), elbow connectors with
    chevron arrowheads, optional 1–5 score dots per step (journey
    only), focal step + focal lane.
  - `renderKamiStateMachine()` · 2–6 states in a horizontal row,
    auto-drawn forward arrows with optional event labels
    (`forwardLabels` array), explicit back-transitions (dashed Q-curves
    above), optional start dot + double-circle end marker.
  - `brief-stages.ts` prompts for all 3 → `kami-chart` JSON. Section
    header changed from "Inline mermaid" to "Inline charts · all
    rendered through `kami-chart`".
**Phase 5** — Remove mermaid. ✓
  - `src/utils/mermaid-sanitize.ts` deleted (had no callers; report.html
    had its own copy which was also removed).
  - `public/report.html` · stripped:
    · the CDN `<script src="…mermaid.min.js">` tag
    · the entire `sanitizeMermaid()` function (~60 lines)
    · the BIG render-and-takeover JS block (~1364 lines, lines 6684–8047)
    · the per-spine mermaid CSS palette + chart-display-sizes blocks
      (~180 lines, lines 600–779)
    · all `pre.mermaid` selectors in the print page-break + dark-spine
      override CSS (replaced with `figure.kami-chart` where appropriate)
    · the `MERMAID_TYPES` dispatch case · replaced with a
      `LEGACY_MERMAID_TYPES` fallback that emits a
      `kami-chart-error` placeholder saying "// legacy mermaid · re-
      generate this brief to render in the current pipeline"
    Net result: `report.html` went from 8181 lines down to 6557 lines
    (~1624 lines removed).
  - `src/ai/prompts/composer.ts` · 2 mentions updated.
  - `src/ai/prompts/brief-stages.ts` · 7 mentions updated.
  - `src/orchestrator/brief.ts` · 2 comment lines updated.
  - Auto-memory · deleted `feedback_mermaid_palette_takeover.md` +
    `feedback_mermaid_spine_tokens.md`; replaced with
    `feedback_kami_chart_pipeline.md` documenting the new system.
  - Delete `mermaid-sanitize.ts`
  - Strip mermaid CSS + lib import from `report.html`
  - Remove mermaid references from composer.ts and brief-stages.ts
  - Update memory file `feedback_mermaid_spine_tokens.md` /
    `feedback_mermaid_palette_takeover.md` to point at the new system

Each phase is independently shippable. **Current state (end of Phase 3)**
is coherent: all `visuals` typed sub-types use kami, all inline-mermaid
(in body prose) still uses mermaid. Both pipelines coexist in `report.html`
without conflict.
