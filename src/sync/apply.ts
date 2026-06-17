// iCloud sync · apply remote ops into the local db. This is the merge core:
// per-field last-writer-wins for `lww` entities, union for `append` entities,
// delete tombstones that survive a stale resurrecting upsert, and idempotency
// via the `synced_ops` ledger so re-reading an oplog segment is a no-op.

import type Database from "better-sqlite3";

import type { EntitySpec, Registry, SyncOp } from "./types.js";
import { observeHlc, hlcGreater } from "./state.js";
import { getFieldHlc, setFieldHlc, getTombstone, setTombstone } from "./fieldver.js";
import { setCaptureSuppressed } from "./capture.js";

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`[sync] unsafe identifier ${name}`);
  return `"${name}"`;
}

function alreadyApplied(db: Database.Database, opId: string): boolean {
  return !!db.prepare("SELECT 1 FROM synced_ops WHERE op_id = ?").get(opId);
}

function markApplied(db: Database.Database, op: SyncOp): void {
  db.prepare("INSERT OR IGNORE INTO synced_ops (op_id, device, applied_at) VALUES (?, ?, ?)").run(
    op.op_id,
    op.device,
    op.ts,
  );
}

function rowExists(db: Database.Database, table: string, pkCol: string, pk: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM ${quoteIdent(table)} WHERE ${quoteIdent(pkCol)} = ?`)
    .get(pk);
}

/** Apply a batch of remote ops. Ops are sorted by HLC so a row's insert lands
 *  before its edits within a batch (keeps NOT-NULL inserts valid). Returns how
 *  many ops were newly applied (vs skipped as duplicates/stale). */
export function applyOps(db: Database.Database, ops: SyncOp[], registry: Registry): number {
  let applied = 0;
  const ordered = [...ops].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
  // Suppress trigger capture for the whole merge: applying a remote op writes to
  // the same syncable tables, which would otherwise re-stage it (echo loop).
  setCaptureSuppressed(db, true);
  try {
  for (const op of ordered) {
    if (alreadyApplied(db, op.op_id)) continue;
    const spec = registry[op.entity];
    if (!spec) continue; // forward-compat: unknown entity from a newer schema — leave unmarked

    const tx = db.transaction(() => {
      observeHlc(db, op.hlc);
      if (op.op === "delete") applyDelete(db, spec.table, spec.pk, op);
      else if (spec.mode === "append") applyAppend(db, spec, op);
      else applyLww(db, spec, op);
      markApplied(db, op);
    });
    try {
      tx();
      applied += 1;
    } catch (e) {
      // Leave unmarked so a later pull (e.g. once an out-of-order insert lands)
      // retries it; never poison the whole batch on one bad op.
      process.stderr?.write?.(
        `[sync] apply skipped op ${op.op_id} (${op.entity}/${op.pk}): ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
  }
  } finally {
    setCaptureSuppressed(db, false);
  }
  return applied;
}

function applyDelete(db: Database.Database, table: string, pkCol: string, op: SyncOp): void {
  const tomb = getTombstone(db, op.entity, op.pk);
  if (!hlcGreater(op.hlc, tomb)) return; // an equal/older delete already recorded
  setTombstone(db, op.entity, op.pk, op.hlc);
  db.prepare(`DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(pkCol)} = ?`).run(op.pk);
}

function applyAppend(db: Database.Database, spec: EntitySpec, op: SyncOp): void {
  const tomb = getTombstone(db, op.entity, op.pk);
  if (tomb && !hlcGreater(op.hlc, tomb)) return; // deleted-after; do not resurrect
  if (rowExists(db, spec.table, spec.pk, op.pk)) return; // immutable · first write wins
  insertRow(db, spec.table, spec.pk, op.pk, op.cols ?? {}, spec.insertDefaults);
}

function applyLww(db: Database.Database, spec: EntitySpec, op: SyncOp): void {
  const tomb = getTombstone(db, op.entity, op.pk);
  if (tomb && !hlcGreater(op.hlc, tomb)) return; // stale upsert vs a newer delete
  const cols = op.cols ?? {};
  const winners: Record<string, unknown> = {};
  for (const [field, val] of Object.entries(cols)) {
    if (hlcGreater(op.hlc, getFieldHlc(db, op.entity, op.pk, field))) winners[field] = val;
  }
  if (Object.keys(winners).length === 0) return; // every field already newer locally
  if (rowExists(db, spec.table, spec.pk, op.pk)) {
    updateRow(db, spec.table, spec.pk, op.pk, winners);
  } else {
    // First time we see this row: the op should carry the full row (genesis /
    // insert op). Insert all the columns it brought.
    insertRow(db, spec.table, spec.pk, op.pk, cols, spec.insertDefaults);
  }
  for (const field of Object.keys(winners)) setFieldHlc(db, op.entity, op.pk, field, op.hlc);
}

function insertRow(
  db: Database.Database,
  table: string,
  pkCol: string,
  pk: string,
  cols: Record<string, unknown>,
  insertDefaults?: Record<string, string>,
): void {
  const names = Object.keys(cols).filter((c) => c !== pkCol);
  // Device-local NOT-NULL columns absent from the op get a registry-supplied
  // SQL expression (trusted, inlined — e.g. rooms.number = local MAX()+1).
  const defaults = insertDefaults
    ? Object.keys(insertDefaults).filter((c) => c !== pkCol && !(c in cols))
    : [];
  const idents = [pkCol, ...names, ...defaults].map(quoteIdent).join(", ");
  const valueSql = [pkCol, ...names]
    .map(() => "?")
    .concat(defaults.map((c) => insertDefaults![c]))
    .join(", ");
  const values = [pk, ...names.map((n) => toSql(cols[n]))];
  db.prepare(
    `INSERT INTO ${quoteIdent(table)} (${idents}) VALUES (${valueSql})
     ON CONFLICT(${quoteIdent(pkCol)}) DO NOTHING`,
  ).run(...values);
}

function updateRow(
  db: Database.Database,
  table: string,
  pkCol: string,
  pk: string,
  cols: Record<string, unknown>,
): void {
  const names = Object.keys(cols).filter((c) => c !== pkCol);
  if (names.length === 0) return;
  const setClause = names.map((n) => `${quoteIdent(n)} = ?`).join(", ");
  const values = [...names.map((n) => toSql(cols[n])), pk];
  db.prepare(`UPDATE ${quoteIdent(table)} SET ${setClause} WHERE ${quoteIdent(pkCol)} = ?`).run(
    ...values,
  );
}

/** better-sqlite3 only binds primitives; coerce JSON-carried values. Objects/
 *  arrays should already be stringified opaque-JSON columns, but guard anyway. */
function toSql(v: unknown): string | number | bigint | Buffer | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "object") return JSON.stringify(v);
  return v as string | number;
}
