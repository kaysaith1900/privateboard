-- Multiple briefs per room. Previously the briefs table had `room_id
-- NOT NULL UNIQUE`, enforcing a single deliverable per room with a
-- regenerate-overwrites-original UX. The new model preserves history:
-- the first brief is generated on adjourn; each "Add a perspective"
-- regeneration appends a new row. The user can switch between briefs
-- via a tab strip in the brief card and the report viewer.
--
-- Also adds an optional `supplement` column to record the user's input
-- when a brief was a regeneration (the first brief has supplement = NULL).
--
-- SQLite can't DROP a UNIQUE constraint in place, so we rebuild the
-- table. The migration runner already wraps each migration in a
-- transaction, so no explicit BEGIN/COMMIT here.

CREATE TABLE briefs_new (
  id          TEXT    PRIMARY KEY,
  room_id     TEXT    NOT NULL,
  style       TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  body_md     TEXT    NOT NULL,
  body_json   TEXT,
  supplement  TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

INSERT INTO briefs_new (id, room_id, style, title, body_md, body_json, supplement, created_at)
SELECT id, room_id, style, title, body_md, body_json, NULL, created_at FROM briefs;

DROP TABLE briefs;
ALTER TABLE briefs_new RENAME TO briefs;

-- Fast lookup of the latest brief for a room (newest first).
CREATE INDEX idx_briefs_room_created ON briefs(room_id, created_at DESC);
