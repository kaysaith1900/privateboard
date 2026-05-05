/**
 * Vitest setup: every test gets a fresh ~/.boardroom-equivalent in a tmpdir.
 * BOARDROOM_DIR is honored by src/utils/paths.ts, so all storage is isolated.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

import { closeDb, runMigrations } from "../src/storage/db.js";
import { ensureBoardroomDir } from "../src/utils/paths.js";

let dir: string | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "boardroom-test-"));
  process.env.BOARDROOM_DIR = dir;
  ensureBoardroomDir();
  runMigrations();
});

afterEach(() => {
  closeDb();
  if (dir) {
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ }
  }
  dir = null;
  delete process.env.BOARDROOM_DIR;
});
