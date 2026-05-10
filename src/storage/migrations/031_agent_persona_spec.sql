-- 029_agent_persona_spec · Full Persona Replication mode
--
-- Two surfaces:
--
-- (1) `agents.persona_spec_json` · the deep persona artifact for
--     directors built via the new "Full persona" flow. Holds the
--     7-phase output (spec / knowledge context / behavioural rules /
--     few-shot examples / reflection checklist / eval set + build
--     report). Compiled into the `instruction` column at save time so
--     existing readers (brief Stage 1, chair, room orchestration)
--     stay backward-compatible with no consumer changes.
--
--     NULL on every existing agent (Signal-mode default) and on every
--     seeded director — those flows render unchanged. The runtime
--     few-shot + reflection-checklist injection in prompt.ts is
--     gated on `persona_spec_json IS NOT NULL`, so non-Full agents
--     don't pay the per-turn token cost.
--
-- (2) `agent_persona_jobs` · one row per in-flight or completed Full-
--     persona build. Persisted at phase boundaries so a tab close /
--     SSE disconnect can resume from the last completed phase. Server
--     restart marks `running` jobs as `failed` (mid-LLM-call resume
--     isn't realistic) and surfaces a retry path.
--
--     Tokens are tracked here until the user clicks Save — at that
--     point they flush via `incrementAgentTokens(newAgentId, total)`
--     so usage stats credit the agent the user actually ended up
--     creating. Aborted / failed jobs absorb the cost (no synthetic
--     `__persona_builder__` agent to seed and reconcile).

ALTER TABLE agents ADD COLUMN persona_spec_json TEXT;

CREATE TABLE IF NOT EXISTS agent_persona_jobs (
  id            TEXT PRIMARY KEY,
  description   TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'full',  -- 'full' (only mode persisted; 'signal' is in-memory)
  status        TEXT NOT NULL,                 -- 'running' | 'done' | 'failed' | 'aborted'
  current_phase INTEGER NOT NULL DEFAULT 1,    -- 1..7
  progress_pct  INTEGER NOT NULL DEFAULT 0,    -- 0..100, monotonic
  partial_json  TEXT,                          -- accumulated phase outputs (JSON)
  agent_id      TEXT,                          -- set after the user clicks Save
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  started_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS agent_persona_jobs_status ON agent_persona_jobs(status);
CREATE INDEX IF NOT EXISTS agent_persona_jobs_started_at ON agent_persona_jobs(started_at DESC);
