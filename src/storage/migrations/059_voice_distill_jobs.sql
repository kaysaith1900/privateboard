-- 059_voice_distill_jobs.sql
--
-- Persistence for the "voice distill from public video" pipeline.
-- One row per attempt; survives SSE disconnect / tab close so a
-- reopened composer can read the partial state and replay the last
-- completed phase. Mirrors `agent_persona_jobs` (migration 031 area)
-- in shape so the boot-time `markRunningJobsFailed` + the SSE replay
-- glue lift straight across.
--
-- Lifecycle:
--   running  -> done       · pipeline finished, voice_id materialised
--   running  -> failed     · any step errored, see `error` column
--   running  -> aborted    · user cancelled OR wall-clock hit OR
--                            server restarted mid-run (boot recovery)
--
-- `partial_json` holds the in-progress phase outputs (download path,
-- clip path, file_id, voice_id) so the UI can render a build-log
-- preview even before `done`. On `done` the row carries the final
-- voice_id; the orchestrator additionally writes the new voice into
-- `voice_credentials` so the rest of the app sees a normal voice row.

CREATE TABLE IF NOT EXISTS voice_distill_jobs (
  id            TEXT PRIMARY KEY,
  -- The public video URL the user submitted (YouTube / Bilibili / direct mp4 / etc.)
  video_url     TEXT NOT NULL,
  -- Display name of the target person. Drives the
  -- speaker-ID step + the eventual voice_credential label.
  celebrity     TEXT NOT NULL,
  -- Optional · when set, on `done` the orchestrator updates this
  -- agent's `voice_id` column so the freshly cloned voice becomes
  -- the agent's default TTS voice.
  agent_id      TEXT,
  status        TEXT NOT NULL,                 -- 'running' | 'done' | 'failed' | 'aborted'
  current_phase INTEGER NOT NULL DEFAULT 1,    -- 1..9, matches the pipeline step indices
  progress_pct  INTEGER NOT NULL DEFAULT 0,    -- 0..100, monotonic within a job
  partial_json  TEXT,                          -- accumulated phase outputs (JSON)
  -- The MiniMax voice_id materialised on success. NULL until phase 7
  -- (clone) succeeds. Surfaced separately from partial_json so the
  -- save / link step doesn't have to JSON-parse to look it up.
  voice_id      TEXT,
  -- The local voice_credentials row id once the orchestrator persists
  -- the new voice. Lets the UI deep-link to the voice-management surface.
  credential_id TEXT,
  started_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS voice_distill_jobs_status
  ON voice_distill_jobs(status);
CREATE INDEX IF NOT EXISTS voice_distill_jobs_started_at
  ON voice_distill_jobs(started_at DESC);
