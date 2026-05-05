-- Follow-up rooms · "Convene a follow-up" feature
--
-- A room can be started as a continuation of a prior adjourned room.
-- Two reference columns are added:
--
--   parent_room_id  · the prior room being followed up. Both rooms
--                     remain independent (own messages, own briefs);
--                     the link is purely a reference for navigation
--                     and for context injection at director-prompt
--                     build time.
--   parent_brief_id · which specific brief the follow-up is scoped
--                     to. A parent room can carry multiple briefs
--                     (regenerations); the orchestrator uses this id
--                     to load exactly that brief's markdown + signal
--                     attribution into the new room's director system
--                     prompts.
--
-- Both nullable so existing standalone rooms keep working unchanged.
-- No FK constraints — parent rooms can be deleted independently
-- (the follow-up degrades gracefully into "orphan follow-up" with
-- the link nulled at read time if the parent disappears).

ALTER TABLE rooms ADD COLUMN parent_room_id  TEXT NULL;
ALTER TABLE rooms ADD COLUMN parent_brief_id TEXT NULL;

-- Persist Stage-1 per-director signals on the brief row so a
-- follow-up room can re-use the prior session's named-by-lens
-- observations without re-running the haiku extract pass. The
-- field carries a JSON array of { directorId, directorName,
-- signals: [{ text, lens, sources }] } — same shape the brief
-- orchestrator's Stage 2 receives. NULL on legacy briefs (the
-- follow-up reader falls back to brief markdown alone).
ALTER TABLE briefs ADD COLUMN signals_json TEXT NULL;
