// iCloud sync · the engine that ties capture → transport → apply together.
// push() flushes our outbox into our oplog segment; pull() reads peers' segments
// and merges them; sync() does both. Quiescence (room adjourn / app background /
// before closeDb) is when callers invoke sync() — never on the live hot path.

import type Database from "better-sqlite3";

import type { Registry } from "./types.js";
import type { SyncTransport } from "./transport.js";
import { ENTITIES } from "./registry.js";
import { deviceId, getState, setState } from "./state.js";
import { readOutbox, clearOutbox } from "./outbox.js";
import { applyOps } from "./apply.js";
import { flushStaged, setCaptureSuppressed } from "./capture.js";
import { externalize, internalize } from "./blobs.js";
import { GENESIS_STATEMENTS, GENESIS_VERSION } from "./genesis.generated.js";

const CURSOR_PREFIX = "cursor:";
const GENESIS_PREFIX = "genesis:";

export class SyncEngine {
  readonly device: string;
  constructor(
    private readonly db: Database.Database,
    private readonly transport: SyncTransport,
    private readonly registry: Registry = ENTITIES,
  ) {
    this.device = deviceId(db);
    setState(db, "enabled", "1"); // turn on the capture triggers (no-op while absent)
    // Defensive · a crash mid-apply could leave capture suppressed forever.
    setCaptureSuppressed(db, false);
  }

  /** One-time full export of every existing local row into the outbox, the first
   *  time this device syncs to a given folder. The capture triggers only fire on
   *  writes made AFTER enabling, so without this a device that already had
   *  directors / rooms / memories would never upload them. Idempotent per folder
   *  (`genesis:<folderTag>` marker) — when the desktop later switches from the
   *  user iCloud Drive to the published app container, it re-genesises into the
   *  new folder so both devices' existing content converges. Returns rows staged. */
  ensureGenesis(folderTag: string): number {
    const key = `${GENESIS_PREFIX}${folderTag}:v${GENESIS_VERSION}`;
    if (getState(this.db, key) === "1") return 0;
    let staged = 0;
    const tx = this.db.transaction(() => {
      for (const sql of GENESIS_STATEMENTS) staged += this.db.prepare(sql).run().changes;
      setState(this.db, key, "1");
    });
    tx();
    return staged;
  }

  /** Flush locally-captured ops into our own append-only segment. */
  async push(): Promise<number> {
    flushStaged(this.db, this.registry); // assign HLC + field-clock to trigger-staged rows
    const ops = readOutbox(this.db);
    if (ops.length === 0) return 0;
    await externalize(this.transport, ops, this.registry); // big data-URLs → blob refs
    await this.transport.push(this.device, ops);
    clearOutbox(
      this.db,
      ops.map((o) => o.op_id),
    );
    return ops.length;
  }

  /** Fetch peers' new ops and merge them; persist cursors only after apply. */
  async pull(): Promise<number> {
    const cursors = this.loadCursors();
    const { ops, cursors: next } = await this.transport.pull(cursors);
    const remote = ops.filter((o) => o.device !== this.device);
    await internalize(this.transport, remote, this.registry); // blob refs → reconstructed data-URLs
    const applied = applyOps(this.db, remote, this.registry);
    this.saveCursors(next);
    return applied;
  }

  /** One quiescent convergence beat. */
  async sync(): Promise<{ pushed: number; applied: number }> {
    const pushed = await this.push();
    const applied = await this.pull();
    return { pushed, applied };
  }

  private loadCursors(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT key, value FROM sync_state WHERE key LIKE ?")
      .all(`${CURSOR_PREFIX}%`) as Array<{ key: string; value: string }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.key.slice(CURSOR_PREFIX.length)] = Number(r.value);
    return out;
  }

  private saveCursors(cursors: Record<string, number>): void {
    const tx = this.db.transaction(() => {
      for (const [device, n] of Object.entries(cursors)) {
        setState(this.db, `${CURSOR_PREFIX}${device}`, String(n));
      }
    });
    tx();
  }
}

export { ENTITIES, getState };
