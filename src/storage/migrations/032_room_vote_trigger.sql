-- Per-room vote-trigger preference. Controls whether the chair's
-- round-prompt (vote phase) auto-fires when a round caps, or only
-- fires when the user explicitly clicks an "End round & vote"
-- button in the bottom bar.
--   · 'auto'   — original behaviour: chair auto-drops round-prompt
--                at every round wrap (cap reached).
--   · 'manual' — chair never auto-drops; user must click the
--                bottom-bar button to enter vote phase.
-- Default 'auto' preserves existing behaviour for legacy rooms.
ALTER TABLE rooms ADD COLUMN vote_trigger TEXT NOT NULL DEFAULT 'auto';
