-- Add paused_at column for the paused room status.
ALTER TABLE rooms ADD COLUMN paused_at INTEGER;
