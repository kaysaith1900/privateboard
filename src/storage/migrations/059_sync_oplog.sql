-- iCloud cross-device sync · the platform-agnostic oplog scaffolding.
-- Shared verbatim by the desktop (better-sqlite3) and iOS (GRDB) stores —
-- this file is the single source of truth; `scripts/gen-ios-migrations.mjs`
-- mirrors it into Migrations.generated.swift.
--
-- DESIGN · the local SQLite db stays the source of truth. iCloud only carries
-- a per-device, append-only change log (oplog). These four tables are the
-- sync layer's OWN bookkeeping — they are PURELY ADDITIVE and touch no
-- existing table, so this migration is a no-op for all current behaviour
-- (nothing reads/writes them until the P1 sync engine ships behind a flag).
-- Crucially this means we do NOT have to backfill `updated_at` onto tables
-- that lack it (e.g. rooms on iOS): the sync layer keeps its own per-field
-- clock in `sync_field_version`, so last-writer-wins is uniform across both
-- platforms and independent of each table's own timestamp columns.

-- ── 1 · sync_outbox · local writes awaiting flush into this device's oplog ──
-- Every mutation to a syncable entity drops one row here (via GRDB
-- afterCommit on iOS / wrapped storage writers on desktop). A background
-- flush — on the same quiescence beats as the WAL checkpoint (room adjourn /
-- app background / before closeDb) — appends these as JSONL lines into the
-- device's current `devices/<self>/ops-NNNNNN.jsonl` segment, then clears them.
CREATE TABLE IF NOT EXISTS sync_outbox (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- strict-monotonic local flush order
  op_id       TEXT    NOT NULL UNIQUE,            -- globally-unique op id (uuid) · echo key
  entity      TEXT    NOT NULL,                   -- canonical logical name (agents/rooms/messages/…)
  pk          TEXT    NOT NULL,                   -- the row's UUID primary key
  op          TEXT    NOT NULL,                   -- 'upsert' | 'delete'
  cols_json   TEXT,                               -- JSON of the changed columns (NULL for delete) · opaque JSON cols carried verbatim
  hlc         TEXT    NOT NULL,                   -- hybrid logical clock string (ts.counter.device)
  created_at  INTEGER NOT NULL                    -- ms epoch
);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_seq ON sync_outbox (seq);

-- ── 2 · synced_ops · idempotency + echo-suppression ledger ──
-- Every op_id we have already APPLIED (our own flushed writes AND peers'
-- ops). Re-reading an oplog segment is therefore idempotent, and we never
-- re-apply or echo a change back out. Extends the CLAUDE.md streaming /
-- WAL-recovery "make every replay a no-op" discipline to cross-device sync.
CREATE TABLE IF NOT EXISTS synced_ops (
  op_id       TEXT    PRIMARY KEY,                -- the applied op's id
  device      TEXT    NOT NULL,                   -- origin device id
  applied_at  INTEGER NOT NULL                    -- ms epoch
);

-- ── 3 · sync_field_version · per-field clock for last-writer-wins + tombstones ──
-- One row per (entity, pk, field) holding the HLC of the last write that the
-- merged state reflects. On apply we keep a field only if the incoming op's
-- HLC is newer — giving PER-COLUMN LWW (two devices editing different fields
-- of the same director both win) with no lost edits. A delete records the
-- sentinel field '__row__' so a stale upsert that arrives later cannot
-- resurrect a deleted row (tombstone). Append-only entities (messages,
-- briefs, key_points, notes) simply never produce a second write per pk, so
-- they union without ever consulting this table.
CREATE TABLE IF NOT EXISTS sync_field_version (
  entity      TEXT    NOT NULL,
  pk          TEXT    NOT NULL,
  field       TEXT    NOT NULL,                   -- column name, or '__row__' for a delete tombstone
  hlc         TEXT    NOT NULL,                   -- HLC that set this field/tombstone
  PRIMARY KEY (entity, pk, field)
);

-- ── 4 · sync_state · device identity, HLC, per-peer cursors, flags ──
-- A tiny key/value store. Known keys:
--   'device_id'        · this device's stable UUID (the devices/<id>/ folder)
--   'hlc'              · last issued HLC (for monotonic clock generation)
--   'enabled'          · '0' | '1' · the sync feature flag / kill-switch
--   'genesis_done'     · '1' once this device has dumped its full local state
--   'schema_version'   · highest applied migration ordinal (oplog gate)
--   'cursor:<deviceId>'· high-water op seq already consumed from that peer
CREATE TABLE IF NOT EXISTS sync_state (
  key         TEXT    PRIMARY KEY,
  value       TEXT
);
