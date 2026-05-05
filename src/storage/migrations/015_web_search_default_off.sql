-- Reset every agent's Web Search flag to OFF.
--
-- Migration 014 introduced the column with `DEFAULT 1` because the
-- gating model at that point was "global key gates everything; per-
-- agent toggle is a fine-tune". After the first round of UX feedback
-- we flipped the philosophy: the default experience should be no
-- search, with the user opting in TWICE — once globally (configuring
-- the Brave key in Preferences) and once per-agent (flipping the
-- toggle on the director's profile).
--
-- This migration only resets the row values. The column DEFAULT in
-- the schema stays at 1 because changing it requires a SQLite full
-- table rebuild; the application layer (`insertAgent`) explicitly
-- writes 0 for newly created agents going forward.

UPDATE agents SET web_search_enabled = 0;
