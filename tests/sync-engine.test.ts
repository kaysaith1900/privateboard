// P1 · sync engine core — deterministic two-device convergence over an
// in-memory transport (no iCloud). Exercises: propagation, per-field LWW,
// same-field conflict convergence, append union, delete tombstones (no
// resurrection), idempotency, and no-echo of a device's own ops.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateDb } from "../src/storage/db.js";
import { SyncEngine } from "../src/sync/engine.js";
import { InMemoryTransport } from "../src/sync/transport.js";
import { recordUpsert, recordDelete } from "../src/sync/outbox.js";
import type { Registry } from "../src/sync/types.js";

const REG: Registry = {
  t_lww: { entity: "t_lww", table: "t_lww", pk: "id", mode: "lww" },
  t_app: { entity: "t_app", table: "t_app", pk: "id", mode: "append" },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrateDb(db); // brings up sync_outbox / synced_ops / sync_field_version / sync_state
  db.exec("CREATE TABLE t_lww (id TEXT PRIMARY KEY, a TEXT, b TEXT)");
  db.exec("CREATE TABLE t_app (id TEXT PRIMARY KEY, body TEXT)");
  return db;
}

// Simulate the app's storage write + the capture hook that P3 will install.
function putLww(db: Database.Database, pk: string, cols: Record<string, string>) {
  const keys = Object.keys(cols);
  const idents = ["id", ...keys].join(", ");
  const ph = ["id", ...keys].map(() => "?").join(", ");
  const set = keys.map((k) => `${k}=excluded.${k}`).join(", ");
  db.prepare(
    `INSERT INTO t_lww (${idents}) VALUES (${ph}) ON CONFLICT(id) DO UPDATE SET ${set}`,
  ).run(pk, ...keys.map((k) => cols[k]));
  recordUpsert(db, REG, "t_lww", pk, cols);
}
function appendMsg(db: Database.Database, pk: string, body: string) {
  db.prepare("INSERT INTO t_app (id, body) VALUES (?, ?)").run(pk, body);
  recordUpsert(db, REG, "t_app", pk, { body });
}
function del(db: Database.Database, entity: string, table: string, pk: string) {
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(pk);
  recordDelete(db, REG, entity, pk);
}

const rowLww = (db: Database.Database, pk: string) =>
  db.prepare("SELECT a, b FROM t_lww WHERE id = ?").get(pk) as { a: string; b: string } | undefined;
const appIds = (db: Database.Database) =>
  (db.prepare("SELECT id FROM t_app ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);

describe("sync engine · two-device convergence", () => {
  let dbA: Database.Database;
  let dbB: Database.Database;
  let transport: InMemoryTransport;
  let A: SyncEngine;
  let B: SyncEngine;

  beforeEach(() => {
    dbA = freshDb();
    dbB = freshDb();
    transport = new InMemoryTransport();
    A = new SyncEngine(dbA, transport, REG);
    B = new SyncEngine(dbB, transport, REG);
  });
  afterEach(() => {
    dbA.close();
    dbB.close();
  });

  async function syncBoth() {
    await A.sync();
    await B.sync();
    await A.sync(); // second pass so each sees the other's just-pushed ops
    await B.sync();
  }

  it("propagates a new row A→B", async () => {
    putLww(dbA, "x", { a: "a1", b: "b1" });
    await syncBoth();
    expect(rowLww(dbB, "x")).toEqual({ a: "a1", b: "b1" });
  });

  it("per-field LWW · concurrent edits to different fields both win", async () => {
    putLww(dbA, "x", { a: "a1", b: "b1" });
    await syncBoth();
    // concurrent, before exchanging
    putLww(dbA, "x", { a: "a2" });
    putLww(dbB, "x", { b: "b2" });
    await syncBoth();
    expect(rowLww(dbA, "x")).toEqual({ a: "a2", b: "b2" });
    expect(rowLww(dbB, "x")).toEqual({ a: "a2", b: "b2" });
  });

  it("same-field conflict · both converge to the higher-HLC value", async () => {
    putLww(dbA, "x", { a: "a0", b: "b0" });
    await syncBoth();
    putLww(dbB, "x", { a: "fromB" });
    await sleep(2); // ensure A's edit is strictly later in wall-clock
    putLww(dbA, "x", { a: "fromA" });
    await syncBoth();
    expect(rowLww(dbA, "x")!.a).toBe("fromA");
    expect(rowLww(dbB, "x")!.a).toBe("fromA");
  });

  it("append entities union across devices", async () => {
    appendMsg(dbA, "m1", "hi");
    appendMsg(dbA, "m2", "there");
    appendMsg(dbB, "m3", "yo");
    await syncBoth();
    expect(appIds(dbA)).toEqual(["m1", "m2", "m3"]);
    expect(appIds(dbB)).toEqual(["m1", "m2", "m3"]);
  });

  it("delete tombstone propagates and a stale older upsert cannot resurrect", async () => {
    putLww(dbA, "x", { a: "a1", b: "b1" });
    await syncBoth();
    // B edits x (older), A deletes x (newer) — before exchanging.
    putLww(dbB, "x", { a: "zombie" });
    await sleep(2);
    del(dbA, "t_lww", "t_lww", "x");
    await syncBoth();
    expect(rowLww(dbA, "x")).toBeUndefined();
    expect(rowLww(dbB, "x")).toBeUndefined();
  });

  it("is idempotent · re-pull applies nothing and creates no duplicates", async () => {
    putLww(dbA, "x", { a: "a1", b: "b1" });
    appendMsg(dbA, "m1", "hi");
    await syncBoth();
    const again = await B.pull();
    expect(again).toBe(0);
    expect(appIds(dbB)).toEqual(["m1"]);
    expect(rowLww(dbB, "x")).toEqual({ a: "a1", b: "b1" });
  });

  it("does not echo a device's own ops back onto itself", async () => {
    putLww(dbA, "x", { a: "a1", b: "b1" });
    await A.sync();
    const reapplied = await A.pull();
    expect(reapplied).toBe(0);
    expect(rowLww(dbA, "x")).toEqual({ a: "a1", b: "b1" });
  });
});
