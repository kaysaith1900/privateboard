-- Chairman's notes · user-curated excerpts saved while reading
-- director output. The user selects a span of text inside a director
-- message, hits "+ Save" or the `S` shortcut, and we persist:
--
--   quote_text     · the exact selection (renders bolded in the
--                    note card and gets the dotted-underline overlay
--                    when the source room is re-opened)
--   context_before · ~1–2 sentences of the director's text immediately
--                    before the selection · displayed faded to give
--                    re-reading context, never displayed without the
--                    quote
--   context_after  · same, after the selection
--   char_offset_start / char_offset_end · the selection's position
--                    inside the rendered message body, used by the
--                    in-room highlight overlay to wrap the same span
--                    in <span class="note-highlight"> on next render
--
-- Source linkage is room_id + message_id (no FKs · briefs/messages can
-- be removed independently and notes degrade to "orphan" with the
-- source link nulled at read time).
--
-- author_kind / author_name / author_id snapshot the director's
-- identity at save-time so cards in the All Notes view can render
-- "ROOM #N · DirectorName · time" without joining live agents (which
-- may have been renamed or deleted since).

CREATE TABLE IF NOT EXISTS notes (
  id                 TEXT PRIMARY KEY,
  room_id            TEXT NOT NULL,
  message_id         TEXT NOT NULL,
  author_kind        TEXT NOT NULL,
  author_id          TEXT NULL,
  author_name        TEXT NOT NULL,
  quote_text         TEXT NOT NULL,
  context_before     TEXT NOT NULL DEFAULT '',
  context_after      TEXT NOT NULL DEFAULT '',
  char_offset_start  INTEGER NOT NULL,
  char_offset_end    INTEGER NOT NULL,
  -- Deferred-action fields · written via PATCH after the user opens
  -- the card and decides to annotate / tag / mark as acted-on. NULL
  -- on a fresh save (the MVP capture flow only fills the columns
  -- above).
  user_note          TEXT NULL,
  tags_json          TEXT NULL,
  status             TEXT NOT NULL DEFAULT 'open',  -- open | acted | archived
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_room       ON notes(room_id);
CREATE INDEX IF NOT EXISTS idx_notes_message    ON notes(message_id);
CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at DESC);
