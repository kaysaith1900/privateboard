-- 053_room_threads.sql · Private 1:1 threads with a single director.
--
-- A "thread" is a lightweight room spawned from a live room (the
-- parent) for the user to pull one director aside without exposing
-- the conversation to the other directors. The thread reuses the
-- regular `rooms` / `messages` / `room_members` plumbing — only two
-- discriminators tell it apart:
--
--   room_kind            · 'main' (default · all existing rows) or 'thread'
--   thread_director_id   · the single director the thread is with;
--                          NULL on main rooms
--
-- parent_room_id (added in 020) is reused to point at the parent
-- main room. The follow-up-room feature also uses parent_room_id,
-- so callers must disambiguate via room_kind (follow-up = 'main'
-- with parent_room_id set; thread = 'thread' with both set).
--
-- No FK constraints — main room deletion handled at storage layer
-- so a future hard-delete path can cascade thread rooms explicitly.

ALTER TABLE rooms ADD COLUMN room_kind          TEXT NOT NULL DEFAULT 'main';
ALTER TABLE rooms ADD COLUMN thread_director_id TEXT NULL;

-- Index the parent → child relationship for the common dock-bar /
-- "list threads in this room" query. Filter to threads only so the
-- much larger main-room population doesn't dominate the index.
CREATE INDEX IF NOT EXISTS idx_rooms_parent_thread
  ON rooms (parent_room_id, room_kind)
  WHERE room_kind = 'thread';
