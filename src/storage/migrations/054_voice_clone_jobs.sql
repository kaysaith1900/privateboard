-- 054_voice_clone_jobs.sql · Persist voice-clone jobs across a process restart.
--
-- A clone job spans 5-60 s (YouTube fetch → upload → clone) and the
-- user can minimize the modal into a bottom-right pill. If the
-- process is killed mid-job (Ctrl+C, hard restart) the row would
-- otherwise be left in `running` forever; boot-time recovery (see
-- src/boot.ts) flips stale `running` rows to `failed` so the UI can
-- surface "last clone was interrupted" instead of silently losing it.
--
-- Fields:
--   id            uuid · primary key, also exposed to client as jobId
--   agent_id      director receiving the cloned voice
--   provider      'minimax' | 'elevenlabs' · resolved from active credential at start
--   source_kind   'file' | 'youtube'
--   source_ref    absolute filesystem path (file) or YouTube URL (youtube)
--   label         user-supplied display label for the new voice; nullable
--   status        'queued' | 'running' | 'done' | 'failed' | 'cancelled'
--   current_stage 'fetch' | 'upload' | 'clone' · which 3rd of the pipeline
--   pct           0-100 overall progress (each stage covers ~33 pp)
--   voice_id      provider-issued voice id when status='done'; NULL otherwise
--   error_code    short token like 'yt_age_gated' / 'provider_quota'
--   error_message human-readable detail for the modal
--   created_at    epoch millis
--   updated_at    epoch millis · refreshed on every progress write

CREATE TABLE IF NOT EXISTS clone_jobs (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  provider      TEXT NOT NULL,
  source_kind   TEXT NOT NULL,
  source_ref    TEXT NOT NULL,
  label         TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',
  current_stage TEXT NOT NULL DEFAULT 'fetch',
  pct           INTEGER NOT NULL DEFAULT 0,
  voice_id      TEXT,
  error_code    TEXT,
  error_message TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clone_jobs_status_updated
  ON clone_jobs (status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_clone_jobs_agent_running
  ON clone_jobs (agent_id, status)
  WHERE status IN ('queued', 'running');
