// iCloud sync · the capture bridge. SQLite triggers (migration 060) stage every
// write to a syncable table into `sync_outbox` with an EMPTY hlc; this flush step
// (run at push time, on quiescence) assigns the HLC + per-field LWW clock + the
// idempotency-ledger seed, in local write order. Keeping the HLC out of the
// trigger means the same trigger SQL serves both platforms while the clock logic
// lives in code.

import type Database from "better-sqlite3";

import type { Registry } from "./types.js";
import { ROW_TOMBSTONE } from "./types.js";
import { deviceId, nextHlc } from "./state.js";
import { setFieldHlc, setTombstone } from "./fieldver.js";

const CAP_OFF = "cap_off";

/** Toggle trigger capture. applyOps wraps its writes with this so merging a
 *  remote op never re-captures it (which would echo it back out → a loop). */
export function setCaptureSuppressed(db: Database.Database, on: boolean): void {
  db.prepare(
    "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(CAP_OFF, on ? "1" : "0");
}

/** Fill HLC + field-version + ledger for trigger-staged rows (hlc = ''). Idempotent
 *  and ordered by `seq` (local causal order). Safe to call before every push. */
export function flushStaged(db: Database.Database, registry: Registry): number {
  const dev = deviceId(db);
  const staged = db
    .prepare(
      "SELECT seq, op_id, entity, pk, op, cols_json FROM sync_outbox WHERE hlc = '' ORDER BY seq ASC",
    )
    .all() as Array<{
    seq: number;
    op_id: string;
    entity: string;
    pk: string;
    op: "upsert" | "delete";
    cols_json: string | null;
  }>;
  if (staged.length === 0) return 0;

  const setHlc = db.prepare("UPDATE sync_outbox SET hlc = ? WHERE seq = ?");
  const seedLedger = db.prepare(
    "INSERT OR IGNORE INTO synced_ops (op_id, device, applied_at) VALUES (?, ?, ?)",
  );
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const row of staged) {
      const spec = registry[row.entity];
      if (!spec) {
        // Unknown/unsynced entity slipped in — drop the staged row so it can't wedge the flush.
        db.prepare("DELETE FROM sync_outbox WHERE seq = ?").run(row.seq);
        continue;
      }
      const hlc = nextHlc(db, dev);
      setHlc.run(hlc, row.seq);
      if (row.op === "delete") {
        setTombstone(db, row.entity, row.pk, hlc);
      } else if (spec.mode === "lww" && row.cols_json) {
        const cols = JSON.parse(row.cols_json) as Record<string, unknown>;
        for (const field of Object.keys(cols)) setFieldHlc(db, row.entity, row.pk, field, hlc);
      }
      seedLedger.run(row.op_id, dev, now);
    }
  });
  tx();
  return staged.length;
}

export { ROW_TOMBSTONE };
