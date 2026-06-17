// P2 · capture bridge — the trigger → flush → oplog → apply path on the REAL
// schema (agents/rooms), proving the live app's writes converge across devices,
// that rooms.number (a device-local UNIQUE counter) is re-minted locally on
// apply, and that merges never echo back (capture suppressed during apply).

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateDb } from "../src/storage/db.js";
import { SyncEngine } from "../src/sync/engine.js";
import { InMemoryTransport } from "../src/sync/transport.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrateDb(db); // all 60 migrations incl. the sync tables + capture triggers
  return db;
}
function insertAgent(db: Database.Database, id: string, name: string, handle: string, model = "sonnet-4-6") {
  db.prepare(
    `INSERT INTO agents (id,name,handle,instruction,model_v,avatar_path,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, name, handle, "inst", model, "avatar", Date.now(), Date.now());
}
function insertRoom(db: Database.Database, id: string, number: number, name: string) {
  db.prepare(
    `INSERT INTO rooms (id,number,name,subject,mode,status,created_at,intensity,
       awaiting_continue,awaiting_clarify,incognito,delivery_mode,vote_trigger,name_auto,room_kind)
     VALUES (?,?,?,?, 'constructive','live',?, 'sharp', 0,0,0,'text','auto',1,'main')`,
  ).run(id, number, name, "subj", Date.now());
}
const agent = (db: Database.Database, id: string) =>
  db.prepare("SELECT name, handle, model_v FROM agents WHERE id = ?").get(id) as
    | { name: string; handle: string; model_v: string }
    | undefined;
const room = (db: Database.Database, id: string) =>
  db.prepare("SELECT number, name FROM rooms WHERE id = ?").get(id) as
    | { number: number; name: string }
    | undefined;
const outboxCount = (db: Database.Database) =>
  (db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n;

describe("sync capture bridge · real schema", () => {
  let dbA: Database.Database;
  let dbB: Database.Database;
  let A: SyncEngine;
  let B: SyncEngine;

  beforeEach(() => {
    dbA = freshDb();
    dbB = freshDb();
    const t = new InMemoryTransport();
    A = new SyncEngine(dbA, t);
    B = new SyncEngine(dbB, t);
  });
  afterEach(() => {
    dbA.close();
    dbB.close();
  });
  async function syncBoth() {
    await A.sync(); await B.sync(); await A.sync(); await B.sync();
  }

  it("a director created on A appears on B (trigger → flush → apply)", async () => {
    insertAgent(dbA, "ag1", "Maya", "@maya");
    await syncBoth();
    expect(agent(dbB, "ag1")).toMatchObject({ name: "Maya", handle: "@maya" });
  });

  it("an edit to a director propagates (LWW via UPDATE trigger)", async () => {
    insertAgent(dbA, "ag1", "Maya", "@maya", "sonnet-4-6");
    await syncBoth();
    dbA.prepare("UPDATE agents SET model_v = ? WHERE id = ?").run("opus-4-8", "ag1");
    await syncBoth();
    expect(agent(dbB, "ag1")?.model_v).toBe("opus-4-8");
  });

  it("rooms sync but number (device-local UNIQUE counter) is re-minted locally", async () => {
    insertRoom(dbA, "rm1", 7, "Strategy");
    // B already has its own rooms occupying low numbers.
    insertRoom(dbB, "rmX", 1, "Existing");
    await syncBoth();
    const r = room(dbB, "rm1");
    expect(r?.name).toBe("Strategy");
    expect(r?.number).not.toBe(7);       // A's number did NOT cross over
    expect(r?.number).toBeGreaterThan(0); // a fresh local number was assigned
  });

  it("room status (live/paused/adjourned) propagates", async () => {
    insertRoom(dbA, "rm1", 7, "Strategy"); // inserted 'live'
    await syncBoth();
    dbA.prepare("UPDATE rooms SET status = ? WHERE id = ?").run("adjourned", "rm1");
    await syncBoth();
    const st = (dbB.prepare("SELECT status FROM rooms WHERE id = ?").get("rm1") as { status: string }).status;
    expect(st).toBe("adjourned");
  });

  it("delete propagates", async () => {
    insertAgent(dbA, "ag1", "Maya", "@maya");
    await syncBoth();
    expect(agent(dbB, "ag1")).toBeTruthy();
    dbA.prepare("DELETE FROM agents WHERE id = ?").run("ag1");
    await syncBoth();
    expect(agent(dbB, "ag1")).toBeUndefined();
  });

  it("applying a remote op does NOT re-capture it (no echo loop)", async () => {
    insertAgent(dbA, "ag1", "Maya", "@maya");
    await syncBoth();
    // B received ag1 by APPLY, not a local write → B's outbox must be empty.
    expect(outboxCount(dbB)).toBe(0);
    // And a second sync round applies nothing new + still no echo.
    const applied = await B.pull();
    expect(applied).toBe(0);
    expect(outboxCount(dbB)).toBe(0);
  });
});
