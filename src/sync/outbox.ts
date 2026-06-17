// iCloud sync · capture local writes into `sync_outbox` so they can be flushed
// into this device's append-only oplog segment. Called by the storage-write
// hooks (desktop wrappers / iOS GRDB afterCommit) AFTER the app has written the
// row to its own table — this layer only records the change, it never owns the
// authoritative write.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import type { Registry, SyncOp } from "./types.js";
import { ROW_TOMBSTONE } from "./types.js";
import { deviceId, nextHlc } from "./state.js";
import { setFieldHlc, setTombstone } from "./fieldver.js";

/** Record a local UPSERT. `cols` is the full row on insert, or just the
 *  touched columns on an edit. Advances the per-field LWW clock so a peer's
 *  older write can never clobber this one, and pre-marks the op as `synced`
 *  so its own echo (the op reappearing when we read our oplog back) is a
 *  no-op. Returns the op for tests / direct flushing. */
export function recordUpsert(
  db: Database.Database,
  registry: Registry,
  entity: string,
  pk: string,
  cols: Record<string, unknown>,
): SyncOp {
  return record(db, registry, entity, pk, "upsert", cols);
}

/** Record a local DELETE (tombstone). */
export function recordDelete(
  db: Database.Database,
  registry: Registry,
  entity: string,
  pk: string,
): SyncOp {
  return record(db, registry, entity, pk, "delete", null);
}

function record(
  db: Database.Database,
  registry: Registry,
  entity: string,
  pk: string,
  op: "upsert" | "delete",
  cols: Record<string, unknown> | null,
): SyncOp {
  const spec = registry[entity];
  if (!spec) throw new Error(`[sync] unknown entity ${entity}`);
  const dev = deviceId(db);
  const hlc = nextHlc(db, dev);
  const opId = randomUUID();
  const ts = Date.now();

  db.prepare(
    `INSERT INTO sync_outbox (op_id, entity, pk, op, cols_json, hlc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(opId, entity, pk, op, cols ? JSON.stringify(cols) : null, hlc, ts);

  // Advance our own clocks so the merge keeps our local write over any older peer op.
  if (op === "delete") {
    setTombstone(db, entity, pk, hlc);
  } else if (spec.mode === "lww") {
    for (const field of Object.keys(cols ?? {})) setFieldHlc(db, entity, pk, field, hlc);
  }
  // Pre-seed the applied ledger so reading our own oplog back is a no-op.
  db.prepare(
    "INSERT OR IGNORE INTO synced_ops (op_id, device, applied_at) VALUES (?, ?, ?)",
  ).run(opId, dev, ts);

  return { op_id: opId, device: dev, entity, pk, op, cols, hlc, ts };
}

/** Drain pending outbox rows in flush order. The caller writes them to the
 *  oplog segment and, only on success, calls {@link clearOutbox}. */
export function readOutbox(db: Database.Database, limit = 5000): SyncOp[] {
  const dev = deviceId(db);
  const rows = db
    .prepare(
      `SELECT seq, op_id, entity, pk, op, cols_json, hlc, created_at
       FROM sync_outbox ORDER BY seq ASC LIMIT ?`,
    )
    .all(limit) as Array<{
    seq: number;
    op_id: string;
    entity: string;
    pk: string;
    op: "upsert" | "delete";
    cols_json: string | null;
    hlc: string;
    created_at: number;
  }>;
  return rows.map((r) => ({
    op_id: r.op_id,
    device: dev,
    entity: r.entity,
    pk: r.pk,
    op: r.op,
    cols: r.cols_json ? (JSON.parse(r.cols_json) as Record<string, unknown>) : null,
    hlc: r.hlc,
    ts: r.created_at,
  }));
}

export function clearOutbox(db: Database.Database, throughSeqOpIds: string[]): void {
  if (throughSeqOpIds.length === 0) return;
  const del = db.prepare("DELETE FROM sync_outbox WHERE op_id = ?");
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) del.run(id);
  });
  tx(throughSeqOpIds);
}

export { ROW_TOMBSTONE };
