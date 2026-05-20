-- 052_room_name_auto.sql
-- Track whether a room's `name` was auto-derived from the opening
-- question's first 60 chars (default · 1) or explicitly set by the
-- client at creation (0). The orchestrator's round-1-complete hook
-- runs an LLM topic-phrase summariser and writes a short title back
-- ONLY when name_auto = 1 (SQL-side guard via UPDATE WHERE), so any
-- future rename UI can flip the flag to 0 without racing the auto
-- pipeline.

ALTER TABLE rooms ADD COLUMN name_auto INTEGER NOT NULL DEFAULT 1;
