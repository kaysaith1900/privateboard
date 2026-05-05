-- Adds the Chair role: a special always-on agent that opens with a
-- clarification, ends each round with key-points + a vote prompt,
-- announces config changes, and writes the closing brief.
--
-- The chair is modeled as a regular agent with role_kind = 'moderator'
-- so we can reuse the message + streaming pipeline.

ALTER TABLE agents ADD COLUMN role_kind TEXT NOT NULL DEFAULT 'director';

-- Key points: the chair generates 3 of these at the end of each round.
-- Users vote up/down; voted points feed back into the next director
-- system prompt as user-interest signals.
CREATE TABLE key_points (
  id          TEXT    PRIMARY KEY,
  room_id     TEXT    NOT NULL,
  message_id  TEXT,                                    -- round-end chair message that introduced these
  round_num   INTEGER NOT NULL,
  body        TEXT    NOT NULL,
  vote        TEXT,                                     -- 'up' | 'down' | NULL
  position    INTEGER NOT NULL,                         -- 0/1/2 ordering
  created_at  INTEGER NOT NULL,
  voted_at    INTEGER,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX idx_key_points_room ON key_points(room_id);
CREATE INDEX idx_key_points_round ON key_points(room_id, round_num);

-- Soft pause flag: set when the chair finishes a round-end message.
-- The orchestrator won't dispatch the next director until the user
-- clicks Continue (or Adjourn).
ALTER TABLE rooms ADD COLUMN awaiting_continue INTEGER NOT NULL DEFAULT 0;
