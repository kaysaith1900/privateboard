-- Interest-driven topic recommendations · the home composer's
-- "找你可能感兴趣的话题" trigger drops a row in topic_rec_jobs,
-- the pipeline writes a topic_rec_batches row at start +
-- N topic_recs rows per recommendation it synthesises. The
-- composer tray pages topic_recs newest-first; each card can
-- carry web-search snippets in seed_context_json that get
-- forwarded into the room's opening message at convene time.

-- One batch per "user clicked the button" event. Lets us
-- show "generated 3h ago", keep older batches addressable via
-- pagination, and (later) attribute a room back to its rec.
CREATE TABLE topic_rec_batches (
  id            TEXT    PRIMARY KEY,
  has_web       INTEGER NOT NULL DEFAULT 0,  -- 1 = web-search ran for this batch
  keywords_json TEXT    NOT NULL,            -- JSON string[] · the 10 keywords pulled from chair memory
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_topic_rec_batches_created ON topic_rec_batches(created_at DESC);

-- One row per recommended topic. `source` drives the UI badge
-- (// web vs // memory). `seed_context_json` carries the web
-- snippets that informed this topic so the composer can attach
-- them to the room's opening message when the user convenes.
CREATE TABLE topic_recs (
  id                TEXT    PRIMARY KEY,
  batch_id          TEXT    NOT NULL REFERENCES topic_rec_batches(id) ON DELETE CASCADE,
  subject           TEXT    NOT NULL,           -- the suggested room subject
  rationale         TEXT    NOT NULL,           -- one-line "why this fits you" hint
  source            TEXT    NOT NULL,           -- 'web' | 'memory'
  seed_context_json TEXT,                       -- JSON [{ title, url, description }] · NULL when source=memory
  created_at        INTEGER NOT NULL,
  opened_room_id    TEXT    REFERENCES rooms(id) ON DELETE SET NULL
);
CREATE INDEX idx_topic_recs_created ON topic_recs(created_at DESC);
CREATE INDEX idx_topic_recs_batch   ON topic_recs(batch_id);

-- Async job tracker · 1:1 mirror of agent_persona_jobs.
-- Boot-time recovery flips status='running' → 'failed' so
-- crashed jobs surface a retry CTA instead of a hung spinner.
CREATE TABLE topic_rec_jobs (
  id            TEXT    PRIMARY KEY,
  status        TEXT    NOT NULL,                -- running | done | failed | aborted
  current_phase INTEGER NOT NULL DEFAULT 0,
  progress_pct  INTEGER NOT NULL DEFAULT 0,
  batch_id      TEXT    REFERENCES topic_rec_batches(id) ON DELETE SET NULL,
  error         TEXT,
  started_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_topic_rec_jobs_status ON topic_rec_jobs(status);
