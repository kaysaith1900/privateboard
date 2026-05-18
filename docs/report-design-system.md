# Report Design System

Adapted from [tw93/Kami](https://github.com/tw93/Kami)'s **Type System**
and **Rhythm & Form** sections, tightened to PrivateBoard's editorial
register (which keeps italic emphasis, supports 6 spines with distinct
accents, and is bilingual EN/CJK).

This document is the **source of truth** for all numeric values inside
`public/report.html` and `public/report/spines/*.css`. New component CSS
references the tokens below; per-spine CSS overrides palette only.

---

## Layers · who owns what

| Layer | What it controls | Where it lives |
|---|---|---|
| Tokens | type scale · line-heights · tracking · spacing · radii · shadows | `public/report.html` `:root{}` (the `--rep-*` block) |
| Palette | per-spine ink / paper / accent / rule | `public/report/spines/*.css` `:root{}` |
| Components | structural CSS using the tokens above | `public/report.html` (cross-spine baseline) + spine CSS (palette-aware adjustments) |

**Hard rule**: spine CSS must NOT redefine `--rep-*` tokens. If a spine
needs a different rhythm, the rhythm becomes a new token, not a spine
override. Spines own colour and font family only.

---

## Type · the 12-tier ladder

| Token | px | pt-equiv | Use |
|---|---|---|---|
| `--rep-display` | 44 | 33 | Cover title |
| `--rep-h1` | 30 | 22 | Chapter / part divider |
| `--rep-h2` | 24 | 18 | Section heading |
| `--rep-h3` | 18 | 13 | Sub-section · recommendation action |
| `--rep-h4` | 15 | 11 | Small heading inside cards |
| `--rep-lede` | 17 | 13 | Intro paragraph (first ¶ after H1/H2) |
| `--rep-pullquote` | 19 | 14 | Italic pull-quote inside callouts |
| `--rep-body` | 16 | 12 | Reading prose |
| `--rep-body-dense` | 14 | 10.5 | Compact body · sidebars · dense lists |
| `--rep-rationale` | 16 | 12 | Secondary prose (matches body) |
| `--rep-meta` | 13 | 10 | Meta strips, metadata rows |
| `--rep-caption` | 11 | 8 | Footer captions, figure annotations |
| `--rep-label` | 10 | 7.5 | Mono uppercase labels (kickers) |
| `--rep-tiny` | 9 | 7 | Footer meta · colophon · minor numerals |

**Weight discipline**:
- Serif body sits at 400, headings at 500. **Never 700/900** — those
  feel like browser-default content; the report is editorial.
- `strong` inside running prose is 600 only when the surrounding body
  is 400. Inside a 500-weight register (like an H2), `strong` stays at
  500 or shifts to italic instead.
- Italic `<em>` in the spine accent IS our signature gesture
  (Charter / Tiempos italic). Kami forbids italic entirely; we use it
  deliberately. See `feedback_kami_chart_pipeline.md` adjacency for
  spine accent rules.

**Sub-pixel forbidden** per CLAUDE.md (`feedback_no_subpixel.md`). No
13.5px, no 10.5px. Round to nearest integer. The token ladder above
already enforces this.

---

## Line-height · 5 tiers, by content type

| Token | Value | Use |
|---|---|---|
| `--rep-leading-display` | 1.18 | Display · H1 · H2 |
| `--rep-leading-heading` | 1.40 | H3 · H4 · lede |
| `--rep-leading-body` | 1.70 | Reading prose (loose, English-leaning) |
| `--rep-leading-tight` | 1.55 | Secondary prose, captions |
| `--rep-leading-dense` | 1.42 | Compact lists, sidebars (Kami's "dense body") |

**Kami invariant we adopt**: print is tighter than web body. ≥ 1.60 reads
floaty at print scale; ≤ 1.10 collides except at display sizes. Body
prose sits in 1.55-1.70; dense rhythm at 1.42-1.45; headlines at 1.10-1.30.

---

## Letter-spacing · with CJK density compensation

Latin body sits at **0**. CJK body (especially TsangerJinKai02 / PingFang)
needs **0.03-0.06em** to open up density. Display CJK takes a smaller
bump (glyphs are already large).

| Token | Value | Applied to |
|---|---|---|
| `--rep-tracking-display` | -0.012em | Display + H1 (slight Latin optical tightening) |
| `--rep-tracking-body` | -0.005em | Body Latin prose (slight optical tightening) |
| `--rep-tracking-cjk-body` | 0.04em | `body.is-cjk` body / li / blockquote / td / th |
| `--rep-tracking-cjk-display` | 0.02em | `body.is-cjk` h1 / h2 / h3 / cover-title |
| `--rep-tracking-mono` | 0.04em | Mono code (inline + pre) |
| `--rep-tracking-label` | 0.20em | Mono uppercase kickers / overlines |

The CJK tokens take effect only when `body.is-cjk` is set by `report.js`
based on the brief's locale. EN reports stay untouched.

---

## Spacing · 7-tier, base 4px

The full kami xs/sm/md/lg/xl/2xl/3xl ladder. **Always use semantic
aliases in component CSS** — never the bare tier number, so the
rhythm stays intention-named.

| Token | Value | Tier use |
|---|---|---|
| `--rep-space-xs` | 4px | Inline adjacent · row internal padding |
| `--rep-space-sm` | 8px | Tag padding · dense layout · row gap |
| `--rep-space-md` | 12px | Component interior · paragraph gap |
| `--rep-space-lg` | 20px | Between components · card padding |
| `--rep-space-xl` | 32px | Section-title margins · between rich list items |
| `--rep-space-2xl` | 56px | Between major sections (H2 zones) |
| `--rep-space-3xl` | 96px | Between chapters · part-cover dividers |

### Semantic aliases · prefer these

| Alias | Resolves to | Use |
|---|---|---|
| `--rep-section-gap` | `--rep-space-2xl` (56px) | Before each H2 |
| `--rep-item-gap` | `--rep-space-xl` (32px) | Between rich list items |
| `--rep-para-gap` | `--rep-space-md` (12px) | Between paragraphs |
| `--rep-row-gap` | `--rep-space-sm` (8px) | Tight rows inside a card |

**Discipline**: when you need a new semantic gap (e.g.
`--rep-caption-gap`), define it as an alias to a tier, not a fresh
number. The 7 tiers are the universe.

---

## Radii · 5 levels, capped at 10px

| Token | Value | Use |
|---|---|---|
| `--rep-radius-tight` | 2px | Swatches · mini-tags · inline pills |
| `--rep-radius-card` | 4px | Tag pads · code blocks |
| `--rep-radius-container` | 6px | Card edges · callout asides |
| `--rep-radius-feature` | 10px | Feature cards · lockup tiles |
| `--rep-radius-hero` | 16px | **RESERVED · cover hero only** |

**The 10px ceiling** comes from CLAUDE.md project rules: beyond 10px,
surfaces start to feel like App Store chrome and clash with the
editorial register. Kami's design system runs up to 32px; we tighten.

---

## Depth · three methods, no hard drop shadows

Kami's invariant: depth comes from **ring shadow** + **whisper shadow** +
**light-dark surface alternation**, never hard drop shadows. We adopt
this 1:1.

| Token | Value | Use |
|---|---|---|
| `--rep-shadow-ring` | `0 0 0 1px var(--rule)` | Buttons · card hover · focus indicators |
| `--rep-shadow-whisper` | `0 4px 24px rgba(0,0,0,0.05)` | Feature card elevation · pull-quote callouts |

**Forbidden**:
- `box-shadow: 0 4px 12px rgba(0,0,0,0.3)` — hard drop, reads as 2010s
  material-design.
- `filter: drop-shadow(...)` for editorial elements (icons can use it
  sparingly, never headlines or cards).
- ANY animated shadow per `feedback_no_shadow_animations.md`. State
  changes use opacity / colour / scale.

For section-level emphasis (e.g. the part-cover divider), use
**light-dark surface alternation** instead of any shadow — flip from
paper to slate / paper-deep for one whole section, ride the contrast.

---

## Working with this system

### Adding a new component

1. Pick tokens from each axis (type / line-height / tracking / spacing /
   radius). Do NOT introduce fresh numbers.
2. If no existing token fits, propose a NEW token — extend `:root` in
   `report.html`, update this doc, then use it.
3. Test the component across at least 2 spines (one warm, one cool) to
   catch palette-driven contrast issues.

### Adapting kami patterns

When porting a kami component to PrivateBoard:
1. Strip kami's `#1B365D` accent · replace with `var(--accent)`.
2. Strip kami's hard-coded greys · map to `var(--ink-*)` semantic ramp.
3. Replace kami's pt sizes with the equivalent `--rep-*` token (the
   pt-equiv column above is the lookup).
4. Drop kami's "no italic" rule — italic `<em>` in accent IS our
   signature. Apply where appropriate.

### Migration TODOs

Pre-system code in the spines still uses hand-set values. **Don't bulk
refactor** — migrate incrementally as you touch each component:
- When editing a component, replace its inline numbers with tokens.
- When adding new components, only use tokens.
- When a spine CSS needs a number, check if a token covers it (it
  almost always does) before adding a fresh value.

Spine palette overrides (clay / brass / navy / etc.) stay in spine
CSS — those are spine-owned. Type / spacing / radii / shadows are
system-owned.

---

## Source · adaptation notes

| Kami's value | Our value | Why we diverged |
|---|---|---|
| Single accent: ink-blue `#1B365D` | 6 spine accents (clay / brass / navy / teal / etc.) | Multi-spine system; each brief has a register-specific palette |
| **No italic anywhere** | Italic `<em>` in spine accent IS the signature | Editorial brand · italic-emphasis-in-clay is the typographic gesture that ties every doc together |
| All grays warm-toned (yellow-brown undertone) | Same · per-spine `--ink-*` ramps are all warm | Adopted as-is |
| Single serif per page · `--sans` = `--serif` | Serif headlines + sans body (per CLAUDE.md anthropic-essay reference) | Bilingual register · sans is more legible for CJK body |
| Radii up to 32pt | Capped at 10px (16px reserved for hero) | CLAUDE.md rule · 12+ feels like App Store chrome |
| Print pt sizes | Px sizes with pt-equivalent in the table | Report is screen-first, print-second; our pipeline doesn't go to WeasyPrint |
| Tight body 1.40-1.45 / reading 1.50-1.55 | 1.42 dense / 1.55 tight / 1.70 body | We added a "loose body" tier (1.70) for English long-form reading; CJK falls back to 1.55 |
