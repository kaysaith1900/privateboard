-- Topic-tree tracking · Layer 3.1 of the divergence stack.
-- Each director turn gets tagged with a branch_id · the cluster of
-- prior turns it extended. New top-level branches are surfaced when
-- a turn opens a genuinely fresh angle. Drives:
--   · dissent-gap picker (Layer 2.1) prefers directors who have NOT
--     spoken on the dominant branches
--   · UI · optional "topic map" overlay so the user sees the room's
--     coverage breadth
--   · structured summarization · long rooms can summarize by branch
--     instead of by chronological round
CREATE TABLE IF NOT EXISTS topic_branches (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,         -- short noun-phrase name (≤ 8 words)
  parent_id   TEXT,                  -- nullable · top-level branches have NULL
  opened_at   INTEGER NOT NULL,      -- ms epoch · ordering / decay
  -- Activity counters · maintained by the post-turn tagger so the
  -- picker can score "this branch is hot" / "this branch is unspoken".
  turn_count  INTEGER NOT NULL DEFAULT 0,
  last_speaker_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_topic_branches_room
  ON topic_branches(room_id, opened_at);

-- Per-message branch assignment · one row per director message.
-- Populated by a post-turn haiku tagger that reads the message body
-- + the room's current branch list and decides: "extends branch X"
-- or "opens new branch Y". Idempotent · re-running the tagger for
-- the same message_id replaces the row.
CREATE TABLE IF NOT EXISTS message_branches (
  message_id  TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  branch_id   TEXT NOT NULL REFERENCES topic_branches(id) ON DELETE CASCADE,
  is_opener   INTEGER NOT NULL DEFAULT 0,   -- 1 = this message opened the branch
  tagged_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_branches_branch
  ON message_branches(branch_id);
