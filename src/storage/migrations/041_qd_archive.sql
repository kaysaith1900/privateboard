-- Quality-Diversity behavioral archive · Layer 4 of the divergence
-- stack. Each director message gets scored on 3 behavioral
-- dimensions (abstraction-level / time-scale / stakeholder-scope) by
-- a cheap haiku post-turn. The resulting (a, t, s) triple maps to a
-- single cell in a 4×4×4 = 64-cell grid · the room's "MAP-Elites
-- archive". Picker layers can query the archive to reward
-- candidates whose persona is likely to fill an EMPTY cell, and the
-- room-end report shows coverage as a divergence KPI.
--
-- One row per (message, dimensions) so re-tagging is idempotent ·
-- the post-turn scorer always INSERT OR REPLACE.
CREATE TABLE IF NOT EXISTS qd_archive (
  message_id   TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  room_id      TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  -- Dimension scores in [0, 1] · float for diagnostics, INTEGER
  -- bucket [0, 3] for the cell index. All scored by the same haiku
  -- pass to amortize cost.
  abstraction_score  REAL NOT NULL,
  abstraction_bucket INTEGER NOT NULL,
  time_score         REAL NOT NULL,
  time_bucket        INTEGER NOT NULL,
  stakeholder_score  REAL NOT NULL,
  stakeholder_bucket INTEGER NOT NULL,
  scored_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qd_archive_room
  ON qd_archive(room_id);
CREATE INDEX IF NOT EXISTS idx_qd_archive_room_cell
  ON qd_archive(room_id, abstraction_bucket, time_bucket, stakeholder_bucket);
