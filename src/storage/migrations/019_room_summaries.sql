-- Hierarchical summarization · per-room cached summaries used by the
-- director-context assembler to stay under context-window pressure on
-- long rooms without dropping continuity.
--
-- Tier model:
--   level=1 · per-round narrative, generated once when the round drops
--            out of the L0 (verbatim) window. round_num identifies which
--            round this summary represents.
--   level=2 · rolling consolidated summary of all rounds older than the
--            L1 window. start_round + end_round describe the range it
--            covers; regenerated when a new L1 row gets folded in.
--
-- A row's `body` is plain narrative text (not key-points, not JSON);
-- the assembler concatenates it directly into the system prompt under
-- a "// EARLIER IN THIS ROOM" header.
--
-- `source_hash` lets future invalidation logic detect whether the
-- inputs changed (e.g. a new message inserted into an old round); for
-- v1 we only generate forward, so the hash is informational.
CREATE TABLE IF NOT EXISTS room_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level IN (1, 2)),
  round_num INTEGER,            -- L1: the round this summary represents; L2: NULL
  start_round INTEGER,          -- L2: oldest round covered; L1: same as round_num
  end_round INTEGER,            -- L2: newest round covered; L1: same as round_num
  body TEXT NOT NULL,
  model_v TEXT,                 -- which utility model generated this row
  source_hash TEXT,             -- hash of the input chunk(s); v2 invalidation hook
  created_at INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

-- One L1 row per (room, round). One L2 row per room at any moment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_summaries_l1 ON room_summaries(room_id, level, round_num) WHERE level = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_summaries_l2 ON room_summaries(room_id, level) WHERE level = 2;

-- Read path: assembler queries by room + level.
CREATE INDEX IF NOT EXISTS idx_room_summaries_room_level ON room_summaries(room_id, level);
