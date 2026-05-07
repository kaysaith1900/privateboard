-- 023_brief_assets · rename signals_json → assets_json on briefs.
--
-- Stage 1 of the brief pipeline produces a richer 9-field asset bundle
-- per director (claims / evidence / tensions / assumptions / risks /
-- opportunities / actions / quotes / openQuestions) instead of the
-- legacy 2-4 flat signals list. The persisted column for this
-- structured material is renamed to assets_json. Rows that carry the
-- old signals_json shape are intentionally NOT migrated in place — the
-- old shape isn't a subset of the new one (no `claims` / `evidence` /
-- etc. fields), so re-using the column with a shape change would mean
-- every old row reads as parse failure → null assets. Cleaner to drop
-- the old column and start fresh; old briefs simply lose the persisted
-- signals (their markdown body is intact, follow-up rooms just fall
-- back to brief markdown for prior context, same as briefs filed
-- before signals_json existed).
--
-- SQLite doesn't support DROP COLUMN before 3.35 in a way we can rely
-- on. Use the standard recreate-and-copy dance: rename the table,
-- recreate with the new column, copy preserved fields over, drop old.
-- The components_json / composer_rationale / subject_type / house_style
-- columns from earlier migrations are all preserved.

-- Recreate-and-copy under FK enforcement requires temporarily disabling
-- foreign-key checks so DROP TABLE briefs__old doesn't cascade-delete
-- referenced rows. PRAGMA foreign_keys takes effect outside transactions
-- in SQLite — but the migration runner already turned FKs ON at
-- connection open. Toggling within the migration is the standard
-- recreate-and-copy pattern (see SQLite docs § "Making Other Kinds of
-- Table Schema Changes"). The PRAGMA reverts to its prior value when
-- the transaction commits, so the next migration / connection sees
-- foreign_keys = ON again.
PRAGMA foreign_keys = OFF;

ALTER TABLE briefs RENAME TO briefs__old;

CREATE TABLE briefs (
  id                  TEXT PRIMARY KEY,
  room_id             TEXT NOT NULL,
  style               TEXT NOT NULL,
  title               TEXT NOT NULL,
  body_md             TEXT NOT NULL,
  body_json           TEXT,
  supplement          TEXT,
  spine               TEXT NOT NULL DEFAULT 'boardroom-dark',
  components_json     TEXT NOT NULL DEFAULT '[]',
  composer_rationale  TEXT,
  subject_type        TEXT,
  house_style         TEXT NOT NULL DEFAULT 'boardroom-default',
  assets_json         TEXT,
  created_at          INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

INSERT INTO briefs (
  id, room_id, style, title, body_md, body_json, supplement,
  spine, components_json, composer_rationale, subject_type, house_style,
  assets_json, created_at
)
SELECT
  id, room_id, style, title, body_md, body_json, supplement,
  spine, components_json, composer_rationale, subject_type, house_style,
  NULL,                  -- legacy signals_json drops on the floor
  created_at
FROM briefs__old;

DROP TABLE briefs__old;

-- Restore the index from migration 010 (briefs(room_id, created_at DESC))
-- under its original name so query plans remain stable across the rename.
CREATE INDEX IF NOT EXISTS idx_briefs_room_created ON briefs(room_id, created_at DESC);

PRAGMA foreign_keys = ON;
