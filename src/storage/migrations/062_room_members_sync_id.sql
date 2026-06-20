-- iCloud sync · give room_members a deterministic single-column surrogate id so
-- the room↔director links can ride the same single-PK sync machinery as every
-- other table. Its real PRIMARY KEY is composite (room_id, agent_id) — which the
-- oplog (one `pk` column) can't address — so without this room_members was left
-- out of sync entirely and synced rooms showed no directors.
--
-- id = room_id || ':' || agent_id · DETERMINISTIC, so two devices independently
-- generate the SAME id for the same membership → remote upserts dedupe against the
-- composite PK instead of creating phantom rows. Backfill existing rows; the
-- capture triggers (migration 063) read NEW.id, and apply-side rowExists/update/
-- delete look up by this id. PURELY ADDITIVE.
ALTER TABLE room_members ADD COLUMN id TEXT;
UPDATE room_members SET id = room_id || ':' || agent_id WHERE id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_members_sync_id ON room_members(id);
