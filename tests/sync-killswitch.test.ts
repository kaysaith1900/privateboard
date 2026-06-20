// Kill-switch · forgetCloud removes THIS device's segment from the shared folder
// and clears the local sync bookkeeping, so a peer joining afterwards sees none
// of the wiped device's data and a re-enable would re-publish from scratch.

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateDb } from "../src/storage/db.js";
import { SyncEngine } from "../src/sync/engine.js";
import { InMemoryTransport } from "../src/sync/transport.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrateDb(db);
  return db;
}
function insertAgent(db: Database.Database, id: string) {
  db.prepare(
    `INSERT INTO agents (id,name,handle,instruction,model_v,avatar_path,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, id, `@${id}`, "i", "sonnet-4-6", "a", Date.now(), Date.now());
}
const count = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe("sync kill-switch · forgetCloud", () => {
  let dbA: Database.Database;
  let A: SyncEngine;
  let t: InMemoryTransport;

  beforeEach(() => {
    dbA = freshDb();
    t = new InMemoryTransport();
    A = new SyncEngine(dbA, t);
  });
  afterEach(() => dbA.close());

  it("removes this device's segment + clears genesis/cursor/synced_ops", async () => {
    insertAgent(dbA, "ag1");
    await A.push(); // publish A's segment into the shared transport
    dbA
      .prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('genesis:folder:v2','1'), ('cursor:peer','5')")
      .run();
    expect(count(dbA, "SELECT COUNT(*) AS n FROM synced_ops")).toBeGreaterThan(0);

    await A.forgetCloud();

    // local bookkeeping wiped
    expect(count(dbA, "SELECT COUNT(*) AS n FROM sync_state WHERE key LIKE 'genesis:%' OR key LIKE 'cursor:%'")).toBe(0);
    expect(count(dbA, "SELECT COUNT(*) AS n FROM synced_ops")).toBe(0);

    // a brand-new device pulling the shared folder sees NOTHING from A (segment gone)
    const dbB = freshDb();
    const B = new SyncEngine(dbB, t);
    await B.pull();
    expect(count(dbB, "SELECT COUNT(*) AS n FROM agents WHERE id = 'ag1'")).toBe(0);
    dbB.close();
  });
});
