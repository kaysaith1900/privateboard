// P4 · content-addressed blobs — a data-URL avatar portrait is externalized to
// `blobs/<sha256>` (NOT inlined in the oplog) and reconstructed byte-identically
// on the peer. Verifies the oplog file stays small and the blob round-trips.

import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateDb } from "../src/storage/db.js";
import { SyncEngine } from "../src/sync/engine.js";
import { FolderTransport } from "../src/sync/folder-transport.js";

const BYTES = Buffer.from("PNGDATA".repeat(400)); // ~2.8KB · well over the inline threshold
const DATA_URL = "data:image/png;base64," + BYTES.toString("base64");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  migrateDb(db);
  return db;
}
function insertAgent(db: Database.Database, id: string, avatar: string) {
  db.prepare(
    `INSERT INTO agents (id,name,handle,instruction,model_v,avatar_path,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, id, `@${id}`, "inst", "sonnet-4-6", avatar, Date.now(), Date.now());
}
const avatarOf = (db: Database.Database, id: string) =>
  (db.prepare("SELECT avatar_path FROM agents WHERE id = ?").get(id) as { avatar_path: string } | undefined)
    ?.avatar_path;

describe("sync blobs · data-URL avatars are content-addressed", () => {
  let cloud: string;
  let dbA: Database.Database;
  let dbB: Database.Database;
  let A: SyncEngine;
  let B: SyncEngine;

  beforeEach(() => {
    cloud = mkdtempSync(join(tmpdir(), "blob-"));
    dbA = freshDb();
    dbB = freshDb();
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

  it("externalizes the portrait to a blob and reconstructs it on the peer", async () => {
    insertAgent(dbA, "ag1", DATA_URL);
    await syncBoth();

    // Peer reconstructs the exact same data-URL.
    expect(avatarOf(dbB, "ag1")).toBe(DATA_URL);

    // The oplog segment carries a blob REFERENCE, not the base64 payload.
    const ops = readFileSync(join(cloud, "devices", A.device, "ops.jsonl"), "utf8");
    expect(ops).toContain("bsync-blob:");
    expect(ops).not.toContain(BYTES.toString("base64"));

    // The blob exists on disk, content-addressed.
    const blobsDir = join(cloud, "blobs");
    expect(existsSync(blobsDir)).toBe(true);
    expect(readdirSync(blobsDir).length).toBe(1);
  });

  it("a non-data-URL avatar path syncs as-is (bundled asset, no blob)", async () => {
    insertAgent(dbA, "ag2", "avatars/3d/royal.png");
    await syncBoth();
    expect(avatarOf(dbB, "ag2")).toBe("avatars/3d/royal.png");
    expect(existsSync(join(cloud, "blobs"))).toBe(false); // nothing externalized
  });

  it("a blank avatar does NOT overwrite a peer's good portrait (LWW blank-guard)", async () => {
    insertAgent(dbA, "ag1", DATA_URL);
    await syncBoth();
    expect(avatarOf(dbB, "ag1")).toBe(DATA_URL);
    // B clears its avatar to "" with a NEWER write (e.g. a failed blob fetch).
    dbB.prepare("UPDATE agents SET avatar_path = '' WHERE id = ?").run("ag1");
    await syncBoth();
    // The blank is dropped from the op → A keeps its real portrait.
    expect(avatarOf(dbA, "ag1")).toBe(DATA_URL);
  });

  it("identical portraits on two agents dedupe to one blob", async () => {
    insertAgent(dbA, "ag1", DATA_URL);
    insertAgent(dbA, "ag3", DATA_URL);
    await syncBoth();
    expect(avatarOf(dbB, "ag1")).toBe(DATA_URL);
    expect(avatarOf(dbB, "ag3")).toBe(DATA_URL);
    expect(readdirSync(join(cloud, "blobs")).length).toBe(1); // same sha256 → one file
  });
});
