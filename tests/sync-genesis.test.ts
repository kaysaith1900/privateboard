// Genesis · the one-time full export of rows that existed BEFORE sync was first
// enabled. The capture triggers only fire on writes made while enabled='1', so a
// device that already has directors/rooms/memories would never upload them
// without this. Proves: (1) a pre-existing director (never seen by a trigger)
// converges after genesis, (2) genesis is idempotent per folder, (3) it re-runs
// for a DIFFERENT folder (the desktop drive → app-container re-point).

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrateDb } from "../src/storage/db.js";
import { SyncEngine } from "../src/sync/engine.js";
import { InMemoryTransport } from "../src/sync/transport.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrateDb(db);
  return db;
}
function insertAgent(db: Database.Database, id: string, name: string, handle: string) {
  db.prepare(
    `INSERT INTO agents (id,name,handle,instruction,model_v,avatar_path,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, name, handle, "inst", "sonnet-4-6", "avatar", Date.now(), Date.now());
}
const agent = (db: Database.Database, id: string) =>
  db.prepare("SELECT name, handle FROM agents WHERE id = ?").get(id) as
    | { name: string; handle: string }
    | undefined;
const outboxCount = (db: Database.Database) =>
  (db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n;

describe("sync genesis · one-time export of pre-existing rows", () => {
  let dbA: Database.Database | undefined;
  let dbB: Database.Database | undefined;
  afterEach(() => {
    dbA?.close();
    dbB?.close();
    dbA = dbB = undefined;
  });

  it("a director created BEFORE sync was enabled converges after genesis", async () => {
    dbA = freshDb();
    // No engine yet → enabled != '1' → the capture trigger does NOT fire.
    insertAgent(dbA, "ag1", "Maya", "@maya");
    expect(outboxCount(dbA)).toBe(0); // confirms the row was never captured

    dbB = freshDb();
    const t = new InMemoryTransport();
    const A = new SyncEngine(dbA, t);
    const B = new SyncEngine(dbB, t);

    const staged = A.ensureGenesis("folder-1");
    expect(staged).toBeGreaterThanOrEqual(1);
    expect(outboxCount(dbA)).toBeGreaterThanOrEqual(1);

    await A.sync();
    await B.sync();
    expect(agent(dbB, "ag1")).toMatchObject({ name: "Maya", handle: "@maya" });
  });

  it("is idempotent per folder · a second call for the same folder stages nothing", async () => {
    dbA = freshDb();
    insertAgent(dbA, "ag1", "Maya", "@maya");
    const A = new SyncEngine(dbA, new InMemoryTransport());
    expect(A.ensureGenesis("folder-1")).toBeGreaterThanOrEqual(1);
    expect(A.ensureGenesis("folder-1")).toBe(0);
  });

  it("re-genesises into a DIFFERENT folder (desktop drive → app-container re-point)", async () => {
    dbA = freshDb();
    insertAgent(dbA, "ag1", "Maya", "@maya");
    const A = new SyncEngine(dbA, new InMemoryTransport());
    A.ensureGenesis("folder-1");
    await A.push(); // drain the outbox to the first folder
    expect(outboxCount(dbA)).toBe(0);
    // A new folder has never seen this device's data → full export runs again.
    expect(A.ensureGenesis("folder-2")).toBeGreaterThanOrEqual(1);
  });
});
