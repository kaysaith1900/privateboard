-- Memory metabolism · Phase 2 schema · supersession / consolidation
-- audit + dream-cycle log.
--
-- Three additions to agent_memories let the LLM dream pipeline:
--   · merge near-duplicates without losing the originals (the canonical
--     merged memory points back at its sources via consolidated_from;
--     each source is marked superseded_by → the merged row).
--   · resolve contradictions by superseding the older claim with the
--     newer one (audit pointer survives, prompt-injection filter
--     drops it).
--   · weight stable cross-room patterns for promotion to tier='long'
--     via a count of distinct rooms that reinforced the memory.
--
-- The agent_dreams table is the audit log · one row per cycle so we
-- can surface "last dream 2h ago · dropped 3, merged 4" in the UI
-- and grep stderr-equivalent metrics out of the DB.
--
-- Phase 1 columns (tier / usage_count / last_used_at) were added in
-- migration 026; this migration assumes those are present.

ALTER TABLE agent_memories ADD COLUMN superseded_by      TEXT REFERENCES agent_memories(id) ON DELETE SET NULL;
ALTER TABLE agent_memories ADD COLUMN consolidated_from  TEXT;     -- JSON array of source memory ids
ALTER TABLE agent_memories ADD COLUMN provenance_rooms   INTEGER NOT NULL DEFAULT 1;

-- Index on (agent, superseded) so retrieval can quickly skip
-- consolidated/superseded rows. Also benefits "list forgotten"
-- audit views.
CREATE INDEX IF NOT EXISTS idx_agent_memories_superseded
  ON agent_memories(agent_id, superseded_by);

CREATE TABLE IF NOT EXISTS agent_dreams (
  id           TEXT    PRIMARY KEY,
  agent_id     TEXT    NOT NULL,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  before_count INTEGER NOT NULL,
  after_count  INTEGER,
  decayed      INTEGER NOT NULL DEFAULT 0,
  merged       INTEGER NOT NULL DEFAULT 0,
  promoted     INTEGER NOT NULL DEFAULT 0,
  superseded   INTEGER NOT NULL DEFAULT 0,
  notes        TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dreams_agent_recent
  ON agent_dreams(agent_id, started_at DESC);
