// iCloud sync · per-field HLC bookkeeping (the LWW clock) + tombstones,
// stored in `sync_field_version` (migration 059). Shared by the local-write
// recorder (outbox) and the remote-op applier (apply).

import type Database from "better-sqlite3";

import type { HLC } from "./types.js";
import { ROW_TOMBSTONE } from "./types.js";

export function getFieldHlc(
  db: Database.Database,
  entity: string,
  pk: string,
  field: string,
): HLC | null {
  const row = db
    .prepare("SELECT hlc FROM sync_field_version WHERE entity = ? AND pk = ? AND field = ?")
    .get(entity, pk, field) as { hlc: string } | undefined;
  return row ? row.hlc : null;
}

export function setFieldHlc(
  db: Database.Database,
  entity: string,
  pk: string,
  field: string,
  hlc: HLC,
): void {
  db.prepare(
    `INSERT INTO sync_field_version (entity, pk, field, hlc) VALUES (?, ?, ?, ?)
     ON CONFLICT(entity, pk, field) DO UPDATE SET hlc = excluded.hlc`,
  ).run(entity, pk, field, hlc);
}

export function getTombstone(db: Database.Database, entity: string, pk: string): HLC | null {
  return getFieldHlc(db, entity, pk, ROW_TOMBSTONE);
}

/** Record a delete tombstone and drop the row's per-field clocks (the
 *  tombstone alone now guards against a stale upsert resurrecting it). */
export function setTombstone(
  db: Database.Database,
  entity: string,
  pk: string,
  hlc: HLC,
): void {
  db.prepare("DELETE FROM sync_field_version WHERE entity = ? AND pk = ? AND field != ?").run(
    entity,
    pk,
    ROW_TOMBSTONE,
  );
  setFieldHlc(db, entity, pk, ROW_TOMBSTONE, hlc);
}
