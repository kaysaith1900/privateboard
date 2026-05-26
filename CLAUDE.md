# PrivateBoard · project rules for AI agents

Rules captured from feedback on this project. Re-read before any
non-trivial CSS / UI change so the same class of bug doesn't keep
getting shipped.

## Communication

### Reply in Chinese

All user-facing replies in this repo should be written in Chinese
(简体中文). The user is Chinese-speaking; English replies create
friction. Code, identifiers, file paths, log strings, commit
messages, and code comments stay in English — only the prose the
user reads (chat messages, summaries, explanations) is in Chinese.

## CSS

### No 13px font-size in app UI surfaces

Never set `font-size: 13px` in any app-shell CSS (`public/index.html`'s
inline `<style>`, `public/thread.css`, `public/agent-overlay.css`,
`public/room-settings.css`, `public/onboarding.css`,
`public/agent-profile.css`, `public/user-settings.css`,
`public/new-agent.css`, `public/adjourn-overlay.css`,
`public/voice-replay.css`, `public/app-updater.css`,
`public/quote-cta.css`, `public/mention-picker.js`). Round to **14px**
instead — the smallest body / chip / row-label register the app uses.

Why: 13px is the awkward in-between size that reads as "too small to
relax into, too large to feel like a label." A previous pass had it
scattered across ~70 callsites for body / meta / chip / row text. The
inconsistency made the UI feel typographically noisy and the chips
visually tiny against neighbouring 14px / 15px text. The chosen
register is 11/12px (mono kicker / pill label) → 14px (body / chip
text) → 15-16px (chat message / heading meta). No 13px tier.

**Exceptions** — explicitly NOT covered by this rule:

- `public/report.html` and `public/report/spines/*` — the report
  design system has its own type scale (see the *No sub-pixel sizing
  in the report system* section below); 13px caption against 15px
  body is part of that scale.
- `public/ppt.html`, `public/magazine.html`, `public/newspaper.html` —
  these are report spine templates.
- `public/home.html` — marketing landing page with its own scale.

Anywhere else: pick 12 or 14. If you're tempted to write 13 to "split
the difference," go with 14 (the app's body register).

### No coloured `border-left` callouts

Never use `border-left` as a callout treatment in any spine of the
project. Use top rules, prefix labels (`// label`), or pure typography
(weight / colour shift / italic) instead. Applies to message bubbles,
report sections, modal callouts, anywhere a "this block is special"
treatment is needed.

### No duplicate parallel borders at section boundaries

When adding a `border-top` / `border-bottom` to any element, check
whether an adjacent element already carries a parallel rule. If yes,
suppress one of the two — two close hairlines almost always read as
"doubled frame around the heading" or "thick weird divider," not
intentional design.

**Recurring collision sites in the report renderer:**

- `.chapter-num { border-bottom }` (above the H2)
   ↔ first-child `<table.md-table> { border-top: 1.5px }` (start of section)
- Last-child list `border-bottom` (closing rule of a section)
   ↔ next chapter's `.chapter-num { border-bottom }` (its own underline)
- `<h2.section-methodology> { border-top }` (its own divider)
   ↔ preceding section's table last-row `border-bottom`

**Where to put the suppression:**

- **Spine-agnostic** rules go in `public/report.html`'s inline `<style>`
  block under the "Suppress duplicate borders" comment. That block
  loads after the per-spine CSS so it wins specificity without needing
  `!important`. Use `:has()` selectors to scope tightly.
- **Spine-specific** tweaks (e.g. one spine has a much heavier table
  rule) go in that spine's CSS file.

When adding a new bordered element, scan its likely neighbours and
write the suppression rule in the SAME change. Don't ship the border
addition first and patch later.

### No sub-pixel sizing in the report system

Never use sub-pixel values (`0.5px`, `10.5px`, `13.5px`, etc.) anywhere
in `public/report.html` or `public/report/spines/*.css` — neither for
borders / heights nor for `font-size`. Half-pixels render fuzzy on
non-Retina screens, look inconsistent against integer-pixel siblings,
and break the design system's tiered weight hierarchy.

The report uses two divider weights:

- `1px solid var(--rule)` — default section dividers, card edges, byline
  rules, in-content rows. The `--rule-soft` token gives a *lighter
  tone* at the same 1px weight, used for table row dividers.
- `2px solid var(--ink)` — anchor / table top / cover bottom. Reserved
  for "this opens a major block."

Anything heavier (3-4px brand-color underlines from older mckinsey /
gartner tables) gets capped to one of these two in the unified design
system block at the bottom of `report.html`'s `<style>`.

For fonts, round to the nearest integer pixel. If you find yourself
wanting 13.5px to "split the difference" between 13 and 14, pick one
based on the surrounding type scale (15px body → 13px caption, 16px
body → 14px caption). The half-step is almost never worth the loss
of crispness.

When pasting CSS from external references (Anthropic / a16z designs
often use `0.5px` for hairline accents), normalise to 1px during the
adaptation pass — don't ship sub-pixel values even temporarily.

### Anthropic-essay spine — the reference design system

`mvp/screen-7-report-anthropic.html` (in the prototype folder) is the
canonical reference for the **anthropic-essay** spine. It models the
report after a research note: warm cream paper, italic-emphasis-in-clay
across every component, mono kickers above every section, serif
italic numerals, no decorative borders. When in doubt about a design
choice for any spine, check whether the same choice appears in the
reference — the patterns below are tested.

**Typography register**

- Dual register · serif (Tiempos / Charter) for **headlines** and
  **emphasis quotes**, sans (Söhne / Inter) for **body prose** and
  **data**, mono for **kickers** and **labels**. No spine should put
  body prose in serif when a sans face is available.
- `<em>` is italic in the **spine accent colour** (`--clay-deep` for
  Anthropic, `--gold-deep` for a16z, etc.) — applied across body p,
  H2, H3, blockquote, considerations, open questions, methodology.
  This is the single typographic gesture that ties the doc together.
- Italic styling on a heading itself is wrong — the heading is **roman**,
  emphasis lives in the `<em>` it contains. (Earlier iterations of the
  Anthropic spine had `font-style: italic` on `.body h2`. Removed.)
- For headings posed as **questions or claims**: italicise the operative
  word inside `<em>`, not the whole sentence. ("Where, exactly, does
  *defensibility* live?") The italic word carries the argument.

**Section opener**

Every section opens with a **mono kicker** — `font-family: var(--mono)`
11px uppercase 0.18em letter-spacing, in the spine accent (`clay-deep`
on Anthropic). Format: `01 — Section Name` or `— Introduction`. The
kicker sits 16-24px above the H2.

**Numerals (signature)**

- **Considerations / recommendations** → italic **lower-roman**
  (`i. ii. iii. iv.`) in serif italic, accent colour. Generated with
  `content: counter(rec, lower-roman) "."`. Not arabic — roman is the
  reference's signature.
- **Open questions** → `decimal-leading-zero` (`01 02 03`) in serif
  italic, accent colour, sized like a small heading (~22px).
- **Observations / headline findings** → italic serif kicker
  `— observation i / ii / iii` (14px clay-deep). NO big numerals on
  the left margin — observations use the kicker pattern, not the
  consideration pattern.

**Pull quote / blockquote**

Top + bottom rules (1px var(--rule)) ONLY — no `border-left`, no
quotation marks, no decorative brackets. Visual differentiation comes
from font (serif italic), size (28-36px), and spacing (40px margin
above and below). The italic style alone does the work.

**Frame chrome**

- **Top frame** (`.top-rule`): brand crumb left (serif 17px weight 500
  with a real circle for the · separator — 10×10 in the spine accent,
  drawn via `font-size: 0` + `background` + `border-radius`), action
  buttons right (mono 11px ink-mid with `↓` glyph in accent for
  download).
- **Doc footer** (`.foot-rule`): full-width chrome `padding: 28px 56px`
  with `display: flex; justify-content: space-between`. Serif brand
  on the left, mono meta on the right.

**Acknowledgments / methodology**

The closing card uses `paper-soft` surface, `1px var(--rule)` border,
`40px 48px` padding. Label is mono 11px clay-deep with a `— ` prefix.
Body is sans 15px line-height 1.75 with `<em>` italic clay-deep,
`<strong>` ink 600.

**Container widths**

Essay text (intro / observations / considerations / open questions)
uses **740px**; figures and side-by-side comparisons use **940px**.
The default is essay width.

**Drop cap**

Reserved for the **first paragraph of the introduction or working
hypothesis**. 64px serif accent-coloured first-letter, `float: left`,
`line-height: 0.85`, `margin: 8px 12px 0 0`. Not used elsewhere — once
per report, at the opening.

**Content tone**

The report frames findings as a **working hypothesis**, not as
authoritative claims. Section titles are full sentences ("Three
forces that *seem* to invalidate the obvious bet"; "What we have
*not* resolved"). Observations are attributed to a director by mono
caption (`— Socrates, on observed patterns`). Acknowledgments end
with an invitation to challenge / replace the analysis.

When generating brief content for the Anthropic spine, follow the
reference's voice: tentative, methodical, attribution-aware. Not
"the answer is X"; rather "after attempting to take the proposition
seriously, we are left less confident than we began."

### Headings and section content must share width

Don't put a `max-width` on `.body h2` (or any section heading) in a
report spine while letting `.body table.md-table` / `.body .chapter-num`
/ `.body p` use the full `.body` content width. The mismatch reads as
a visual bug — title text + its border (chapter-num underline OR
spines like mckinsey where H2 carries its own `border-bottom`) come
out narrower than the table beneath. Either remove the H2 max-width
or apply the same cap to chapter-num underline AND the content.
Default to removing the cap; section H2s are short labels in
practice, the typographic argument for narrow headings doesn't apply.

## Backend

### SQLite WAL must be checkpointed at shutdown

The DB runs in WAL mode (`journal_mode = WAL`). Writes go to
`state.db-wal` and only get merged into `state.db` at SQLite's
infrequent auto-checkpoints OR when the connection closes cleanly.
**Every process exit path must call `closeDb()`** — which now does
`PRAGMA wal_checkpoint(TRUNCATE)` then `db.close()`. Without it, the
WAL accumulates 4MB+ of writes and a non-clean shutdown (kill -9,
hard restart, terminal close) leaves the user's recent work in a
WAL that may get partially rolled back on next-start recovery.

`src/cli.ts` registers four exit paths that all funnel into
`closeDb()`:
- `SIGINT` (Ctrl+C)
- `SIGTERM` (`kill <pid>`)
- `SIGHUP` (terminal close, parent shell exit) — Node's default for
  this is to terminate WITHOUT running other handlers, so it must be
  named explicitly
- `process.on("exit")` last-resort sync flush — covers nodemon
  restarts, uncaughtException-after-microtask, parent SIGKILL of a
  child, anything else that bypasses the signal handlers

`closeDb()` is idempotent (nulls the handle), so multiple paths
firing in sequence is safe. Anything that adds a new shutdown route
needs to be funnelled through the same `shutdown()` helper.

### Mid-stream interrupts leave rooms in awaiting-clarify limbo

Chair-clarify and director turns both use streaming · the message
row is finalised only when the stream completes. If the process is
killed mid-stream, the message never lands and any flag set
synchronously (`rooms.awaiting_clarify`, `rooms.awaiting_continue`,
`messages.meta.streaming`) stays in the previous state forever. The
user perceives this as "data wiped" because the room shows their
opening question with no chair / director response and the input
bar is locked by the awaiting flag.

Recovery lives in `recoverStuckClarifyRooms()` (storage/rooms.ts)
and runs at boot via cli.ts. Pattern: scan rooms with the flag set
but no corresponding finalised message; clear the flag so the user
can resume. Any new "phase flag" that gates UI input (e.g. a new
`awaiting_X` column) needs a parallel recovery sweep at boot. The
clarify recovery is the prior-art template.

### Inline scripts in HTML need a syntax check

`public/report.html` and `public/index.html` carry large inline
`<script>` blocks (the report renderer is ~1250 lines inline). A
single missing `})` in there produces NO server error, NO build
warning — the file serves cleanly and the browser silently rejects
the whole block, so the page renders blank with no obvious cause.
Symptom looks identical to "data lost" or "API broken" but is
purely a frontend syntax bug.

After ANY edit to an inline script, syntax-check it:

```sh
awk '/<script>/{p=1;next} /<\/script>/{p=0} p' public/report.html | node --check
```

Exit 0 = clean. Any other output = a missing brace / paren that
will silently blank the page in browsers. The `awk` pulls just the
inline script's body; `node --check` does parse-only validation.

### Stuck "streaming" placeholders

Any code path that creates a message with `meta.streaming: true` MUST
have a try/catch around the iteration that promises to flip it to
`streaming: false` on every exit path (success, error chunk, iterator
throw, abort). Bare for-await loops without try/catch leave the
placeholder forever-loading in DB; the UI then renders "thinking"
indefinitely and refresh doesn't help. The boot-time recovery in
`cleanupOrphanedStreams` cleans up after crashes, but it's the safety
net — the source of truth is the streaming function itself.

## Release

### macOS DMG signing is auto-finalized — don't hand-sign

`electron-builder` 26.x signs + notarizes the `.app` but NOT the
`.dmg` container. A freshly built DMG is `spctl: no usable signature`,
so users who download the DMG from the browser hit Gatekeeper
("damaged / unverified developer"). The zip is fine — its inner `.app`
is stapled — only the DMG container needs the extra pass.

`npm run electron:dist` now ends with `npm run release:mac:finalize`
(`scripts/finalize-mac-release.mjs`), which does the three steps
electron-builder skips:

1. `codesign --timestamp` the DMG
2. `xcrun notarytool submit --wait` the DMG
3. `xcrun stapler staple` the DMG

then recomputes the **dmg** row of `release/latest-mac.yml` — stapling
appends ~11 KB of ticket so the build-time sha512/size go stale and
electron-updater would reject the download. The **zip** row and
top-level `path:` are left untouched (the zip is unchanged; macOS
auto-update downloads the zip, not the dmg). Finally it
`gh release upload v<ver> <dmg> <yml> --clobber`.

The script is idempotent: if `spctl` already accepts the DMG it skips
the signing dance and only re-syncs the yml. Re-runnable standalone via
`npm run release:mac:finalize` when a build succeeded but finalize was
interrupted.

**Env required** before the build (same as the signed `.app`):
`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, plus
`GH_TOKEN` (for electron-builder's own publish step). Full notes —
keychain identity hash, the Surge/Clash fake-ip proxy gotcha that
breaks `timestamp.apple.com`, the empty-shell-DMG fallback — are in the
`macos-codesign-notarize` memory.

**Do NOT** re-add a manual codesign / notarytool / staple sequence to
the release flow — it lives in the script now. If the DMG step needs
changing, edit `scripts/finalize-mac-release.mjs`.

## Frontend

### Composer drafts must persist across view switches

Any textarea that lives inside a view that gets re-rendered on
navigation (room composer, agent composer) must persist its value to
localStorage on `input` and re-populate on render. The view re-render
destroys the DOM node, so DOM-level value is lost. Cleared on
successful submit, not before.

### Sub-state restore tick can race with onboarding

`prototype-dashboard.html` (now `index.html`) runs a 2.5s polling tick
at boot to restore the last-viewed agent profile. If onboarding's
`refreshAgents()` mounts the sidebar rows mid-poll, the tick fires and
opens the saved agent profile instead of the room the user just
convened. Onboarding's `show()` writes "rooms" + "new" to the relevant
localStorage keys to short-circuit this. Anything new that triggers
agent-row mounts during onboarding needs to consider the same race.
