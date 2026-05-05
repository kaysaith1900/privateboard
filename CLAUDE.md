# PrivateBoard · project rules for AI agents

Rules captured from feedback on this project. Re-read before any
non-trivial CSS / UI change so the same class of bug doesn't keep
getting shipped.

## CSS

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
