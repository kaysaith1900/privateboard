-- 048_user_long_memory.sql
--
-- Long-term USER memory sanctuary · a parallel lane that the
-- auto-dream cycle never touches. The chair's existing memory
-- consolidation (heuristic decay → cluster → merge → conflict
-- → promote-to-long, in src/orchestrator/dream.ts) strips
-- abstract recurring facts about the user along with the noise.
-- This table holds tag-shaped abstractions ("founder",
-- "anti-jargon", "long-horizon-bias") that survive forever and
-- are only displaced on explicit contradiction.
--
-- Per the project design doc: rows here are owned conceptually
-- by the chair-relationship (the chair is the user's interface
-- to the boardroom). There is one user per install, so no
-- user_id column. No agent_id either — facts here are about
-- the USER, not authored by any single director.
--
-- Lifecycle:
--   · Insert · the dream pipeline's new Step 6 (chair-only)
--              harvests durable patterns from chair's tier='long'
--              memories and writes them here.
--   · Reinforce · same harvest step bumps provenance_rooms +
--                 last_reinforced_at when an existing tag is
--                 confirmed by new evidence.
--   · Supersede · only on direct contradiction · sets
--                 superseded_by on the older row and inserts a
--                 new row. The old row stays for audit.
--   · Delete · only via the user's explicit UI action on the
--              chair's profile page, OR the cap-30 safety prune.
--
-- The dream cycle's pruning of unused agent_memories continues
-- unchanged — this table is purely additive and sits outside
-- that lifecycle.

CREATE TABLE user_long_memory (
  id                  TEXT    PRIMARY KEY,
  label               TEXT    NOT NULL,                -- ≤ 32 chars · short tag
  claim               TEXT    NOT NULL,                -- ≤ 240 chars · unpacked sentence
  confidence          REAL    NOT NULL DEFAULT 0.7,    -- 0..1
  provenance_rooms    INTEGER NOT NULL DEFAULT 1,      -- distinct rooms reinforcing it
  last_reinforced_at  INTEGER,                         -- ms epoch · last harvest re-counting this tag
  superseded_by       TEXT    REFERENCES user_long_memory(id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Active rows query · `WHERE superseded_by IS NULL ORDER BY
-- provenance_rooms DESC, last_reinforced_at DESC` is the hot
-- path (chair prompt + chair-profile UI both call it). The
-- index includes superseded_by as the leading column so the
-- IS NULL filter is index-resolvable.
CREATE INDEX idx_user_long_memory_active
  ON user_long_memory(superseded_by, provenance_rooms DESC, last_reinforced_at DESC);
