// P3 · desktop FolderTransport — real-table capture converging across two
// devices through REAL on-disk JSONL files (a temp dir stands in for the iCloud
// Drive folder; the read/append/cursor logic is identical to production).

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateDb } from "../src/storage/db.js";
import { SyncEngine } from "../src/sync/engine.js";
import { FolderTransport } from "../src/sync/folder-transport.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrateDb(db);
  return db;
}
const insertAgent = (db: Database.Database, id: string, name: string, handle: string) =>
  db
    .prepare(
      `INSERT INTO agents (id,name,handle,instruction,model_v,avatar_path,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(id, name, handle, "inst", "sonnet-4-6", "avatar", Date.now(), Date.now());
const agent = (db: Database.Database, id: string) =>
  db.prepare("SELECT name, handle FROM agents WHERE id = ?").get(id) as
    | { name: string; handle: string }
    | undefined;

describe("desktop FolderTransport · on-disk convergence (real schema)", () => {
  let cloud: string;
  let dbA: Database.Database;
  let dbB: Database.Database;
  let A: SyncEngine;
  let B: SyncEngine;

  beforeEach(() => {
    cloud = mkdtempSync(join(tmpdir(), "icloud-"));
    dbA = freshDb();
    dbB = freshDb();
    // Each "device" has its own transport at the SAME shared folder.
    A = new SyncEngine(dbA, new FolderTransport(cloud));
    B = new SyncEngine(dbB, new FolderTransport(cloud));
  });
  afterEach(() => {
    dbA.close();
    dbB.close();
    rmSync(cloud, { recursive: true, force: true });
  });
  async function syncBoth() {
    await A.sync(); await B.sync(); await A.sync(); await B.sync();
  }

  it("a director created on A converges to B through real JSONL files", async () => {
    insertAgent(dbA, "ag1", "Maya", "@maya");
    insertAgent(dbB, "ag2", "Bo", "@bo");
    await syncBoth();
    // The oplog files physically exist on disk for each device.
    expect(existsSync(join(cloud, "devices", A.device, "ops.jsonl"))).toBe(true);
    expect(existsSync(join(cloud, "devices", B.device, "ops.jsonl"))).toBe(true);
    // Both directors converged on both devices.
    expect(agent(dbA, "ag2")).toMatchObject({ name: "Bo" });
    expect(agent(dbB, "ag1")).toMatchObject({ name: "Maya" });
  });

  it("an edit + delete propagate through the files", async () => {
    insertAgent(dbA, "ag1", "Maya", "@maya");
    await syncBoth();
    dbA.prepare("UPDATE agents SET name = ? WHERE id = ?").run("Maya II", "ag1");
    await syncBoth();
    expect(agent(dbB, "ag1")?.name).toBe("Maya II");
    dbA.prepare("DELETE FROM agents WHERE id = ?").run("ag1");
    await syncBoth();
    expect(agent(dbB, "ag1")).toBeUndefined();
  });

  it("a fresh engine resumes from persisted cursors (no re-apply across restart)", async () => {
    insertAgent(dbA, "ag1", "Maya", "@maya");
    await syncBoth();
    expect(agent(dbB, "ag1")).toBeTruthy();
    const B2 = new SyncEngine(dbB, new FolderTransport(cloud)); // simulate relaunch
    const applied = await B2.pull();
    expect(applied).toBe(0);
  });
});
