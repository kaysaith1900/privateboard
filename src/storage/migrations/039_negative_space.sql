-- Negative-space memory · Layer 3.2 of the divergence stack.
-- At round-end the chair extracts "what this round did NOT touch
-- but should have" — angles raised-then-abandoned, dimensions
-- conspicuously absent. These get injected into the next round's
-- director prompts as "UNEXPLORED ANGLES" so the room has positive-
-- space breadcrumbs alongside the frame-break negative-space rules.
--
-- One row per angle (not one row per round) so the next-round
-- prompt can pull the top-N most recent regardless of round
-- boundaries · enables cross-round angle memory.
CREATE TABLE IF NOT EXISTS negative_space (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  round_num   INTEGER NOT NULL,
  angle       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  -- Soft consumption flag · when a subsequent round prompt injected
  -- this angle and the room actually engaged with it, the chair
  -- post-processor flips this to 1. Subsequent rounds prefer
  -- unconsumed angles to avoid suggesting the same thing twice.
  consumed    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_negative_space_room_round
  ON negative_space(room_id, round_num);
CREATE INDEX IF NOT EXISTS idx_negative_space_room_unconsumed
  ON negative_space(room_id, consumed);
