-- Memory metabolism · Sleep / Dreaming Mode infrastructure (Phase 1).
--
-- Three forward-compatible additions to agent_memories that let a
-- periodic "dream" pass decide which memories to keep, decay, or
-- promote to long-term.  Phase 1 only uses `usage_count` /
-- `last_used_at` (decay heuristic) and `tier` (default 'short' for
-- everything pre-existing). The remaining columns (superseded_by,
-- consolidated_from, provenance_rooms) plus the agent_dreams audit
-- table land in the Phase 2 migration.
--
-- Rationale per column:
--   · tier         · 'short' / 'long' · stable cross-room patterns
--                    promote out of the recency cap (tier='long' is
--                    always injected into prompts; 'short' goes
--                    through the top-N recency window).
--   · usage_count  · how many times this memory has been injected
--                    into a director's prompt. Memories that ARE
--                    being read escape the decay sweep — only
--                    genuinely-forgotten rows get culled.
--   · last_used_at · timestamp of most recent injection. Lets
--                    future tier-promotion rules consider "freshness
--                    of relevance" separately from "freshness of
--                    creation."

ALTER TABLE agent_memories ADD COLUMN tier         TEXT    NOT NULL DEFAULT 'short';
ALTER TABLE agent_memories ADD COLUMN usage_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_memories ADD COLUMN last_used_at INTEGER;

-- Tier-aware retrieval · listTier(agentId, tier) reads through this
-- index when memoriesForContext composes the prompt-injection set.
CREATE INDEX IF NOT EXISTS idx_agent_memories_tier
  ON agent_memories(agent_id, tier, pinned DESC, created_at DESC);
