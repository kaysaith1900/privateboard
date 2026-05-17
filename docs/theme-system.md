# Theme System

The app ships **two themes** — `data-theme="dark"` (regent) and
`data-theme="light"` (atrium). Both share a single token vocabulary
defined in `public/themes.css`. This doc is the contract for every
token: what it means, when to reach for it, and what NOT to do.

The report subsystem (`public/report/spines/*.css`) has its own
independent palette and is out of scope here.

---

## File: `public/themes.css`

```
:root[data-theme="dark"]  { … all 15 tokens … }
:root[data-theme="light"] { … same 15 tokens … }
```

Every token MUST be defined in both blocks. Drift (defining only in
one) breaks the inverse theme silently.

---

## Surface ladder

5 elevation steps, each visibly distinct from its neighbour without
needing a border. Use in the order of "depth of nesting":

| Token | Dark | Light | Use for |
|---|---|---|---|
| `--bg` | `#0A0A0A` | `#FFFFFF` | Page root; input / textarea fill (the deepest, most-recessed surface) |
| `--panel` | `#131312` | `#FAFAFA` | Primary elevated container — sidebar, modal body, message rail |
| `--panel-2` | `#1A1A18` | `#EEEEEE` | One level deeper — secondary cards inside a panel, hover surfaces on plain text rows |
| `--panel-3` | `#21211E` | `#E4E4E4` | Two levels deeper — selected row, active card, deepest interactive context |
| `--hi` | `#2A2A26` | `#D4D4D4` | Hover / pressed state on `--panel-3` rows, peak elevation |
| `--strip-bg` | `#1A1A18` | `#E5E4E1` | **Title bars / classification strips** — `.cmp-topbar`, `.na-classification`, `.rs-classification`, `.na-head`, `.rs-head`. Single source of truth so all "topbar" surfaces match. |

**Rule:** never reach below `--bg` (i.e. don't darken further on
dark, lighten further on light). The ladder is closed at both ends.

---

## Border weights

Three weights, "softest → structural". Always 0.5px unless decoration
requires 1-2px.

| Token | Dark | Light | Use for |
|---|---|---|---|
| `--line` | `#26241F` | `#E5E5E5` | Lowest-weight divider — row separators, hairlines inside a card |
| `--line-bright` | `#3A3934` | `#C8C8CD` | Everyday border — card edges, dashed dividers, default visible border |
| `--line-strong` | `#5A5852` | `#A6A6AC` | Structural border — input frames, modal edges, focus states (when not using `--lime`) |

If a border feels invisible, bump up to `--line-bright` BEFORE you
override with a hex code. If `--line-strong` still feels insufficient,
the answer is `--lime` (focus / active state), not a darker custom
grey.

---

## Text hierarchy

Four rungs, sloppily mapped to "primary / secondary / tertiary / hint".

| Token | Dark | Light | Contrast vs `--bg` (light) | Use for |
|---|---|---|---|---|
| `--text` | `#C8C5BE` | `#0D0D0D` | 18.7:1 AAA | Headings, body, primary text |
| `--text-soft` | `#8E8B83` | `#5D5D5D` | 7.0:1 AAA | Secondary labels, metadata |
| `--text-dim` | `#7E7B70` | `#717181` | 4.7:1 AA | Tertiary captions, placeholder labels |
| `--text-faint` | `#5A5848` | `#9A9A9A` | 2.8:1 (below normal-text AA, OK for hints) | Hints, disabled, decorative text. Don't use for content the user actually needs to read |

---

## Accent colours

Semantic accent tokens. Naming reflects the dark-mode hue
historically; **light mode intentionally carries a different hue**
for the primary slot. The semantic ("primary accent", "warning",
"error", etc.) is preserved across themes.

| Token | Dark | Light | Semantic |
|---|---|---|---|
| `--lime` | `#C9A46B` (gold) | `#10A37F` (OpenAI green) | **Primary** accent — focus ring, CTA, active state, key affordance. The token is named `--lime` for backward-compat with ~660 consumers; treat it as `--primary` semantically. |
| `--lime-deep` | `#9A7B40` | `#0D8868` | Pressed / active depth of `--lime` |
| `--lime-dim` | `#5C4422` | `#A7E8D0` | Soft tint of `--lime` for hover backgrounds, ghost focus rings (NOT for focus rings on interactive inputs — they're too pale to register; use `--lime` directly) |
| `--amber` | `#A57843` | `#C2410C` | Warning — caution, secondary alert |
| `--amber-dim` | `#5E441F` | `#FED7AA` | Subtle warning background tint |
| `--red` | `#B5706A` | `#DC2626` | Error / destructive |
| `--red-dim` | `#6B4540` | `#FEE2E2` | Subtle error background tint |
| `--cyan` | `#6A9B97` | `#0891B2` | Info / secondary accent (e.g. chair indicator) |
| `--magenta` | `#8E7A8E` | `#BE185D` | Reserved tertiary accent |

### Why `--lime` is gold in dark and green in light

Two deliberate brand identities:

- **Dark (regent)** — warm gold reads as institutional, executive,
  board-room. Pairs with the warm near-black surface ladder.
- **Light (atrium)** — OpenAI green reads as clean, modern, tools.
  Pairs with the ChatGPT-style cool-grey surface ladder.

Renaming `--lime` to `--primary` was considered and rejected: ~660
consumers across CSS and JS would all need updating, with no runtime
benefit. Documented here instead.

---

## Conventions

### No fallback hex codes in `var()`

❌ Don't:
```css
color: var(--lime, #6FB572);
border-color: var(--line-bright, #2A2A26);
```

✅ Do:
```css
color: var(--lime);
border-color: var(--line-bright);
```

Tokens are always defined (themes.css is loaded synchronously before
paint, see the bootstrap in index.html). The fallback hex never
triggers — it's dead code that confuses readers, and the dark-only
legacy values would render the WRONG colour in light mode if a load
ever did fail.

The single exception: JS that synthesises standalone SVG / image
artifacts (share cards, frozen avatar exports) — those need a
concrete hex because they're rendered outside the live CSS context.

### Where to add component-level scoped overrides

Sometimes a token doesn't quite work for a specific component. Two
forms of fix, in this order:

1. **Add the right semantic token.** If multiple components need the
   same exception, mint a token. `--strip-bg` is the canonical
   example — five surfaces needed the same "title-bar" treatment,
   so they share a token rather than five duplicate overrides.
2. **Add a scoped override** in `themes.css` after the `:root`
   blocks. Use `:root[data-theme="light"] .my-class { … }`. Reserve
   for one-off cases that don't justify a new token.

### No left-coloured borders for callouts

(CLAUDE.md rule, repeated here for completeness.) Use top rules,
prefix labels (`// label`), or pure typography (weight / colour /
italic) for emphasis blocks. Never `border-left: 4px solid var(--lime)`
or similar.

### No sub-pixel sizing in the report system

(CLAUDE.md rule.) Round to integer pixels. Two divider weights —
1px and 2px. App theme borders are 0.5px (hairlines) by convention;
report system is integer-only.

---

## Adding a new theme

The token surface area is small enough that a third theme is
mechanical:

1. Add a `:root[data-theme="<name>"]` block in `themes.css`.
2. Define ALL 15 tokens. No drift.
3. Register the name in the renderer's appearance picker (currently
   limited to `dark` / `light` / `system` in `public/user-settings.js`).
4. Eyeball the verification checklist below.

---

## Verification checklist (after token changes)

1. **Contrast probe** — recompute key pairs in node:
   ```bash
   node -e '
   function L(h){const r=parseInt(h.slice(1,3),16)/255,g=parseInt(h.slice(3,5),16)/255,b=parseInt(h.slice(5,7),16)/255;const lin=c=>c<=0.03928?c/12.92:Math.pow((c+0.055)/1.055,2.4);return 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);}
   function c(a,b){const la=L(a),lb=L(b);return ((Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05)).toFixed(2);}
   const T={bg:"#FFFFFF",panel:"#FAFAFA",panel2:"#EEEEEE",strip:"#E5E4E1",lineStrong:"#A6A6AC",text:"#0D0D0D",lime:"#10A37F"};
   console.log("text/bg",c(T.text,T.bg),"strip/panel",c(T.strip,T.panel),"lineStrong/bg",c(T.lineStrong,T.bg),"lime/bg",c(T.lime,T.bg));'
   ```
2. **Inline-script syntax** —
   ```
   awk '/<script>/{p=1;next} /<\/script>/{p=0} p' public/index.html | node --check
   ```
3. **Tests** — `npm test` (theme changes shouldn't touch any test).
4. **Visual** — boot the Electron app, toggle dark/light in user
   settings, sanity-check:
   - sidebar elevation reads
   - new-room composer topbar visible in light
   - new-agent classification + head visible in light
   - input focus rings show as `--lime` (not pale)
   - hover states feel "pressed"
