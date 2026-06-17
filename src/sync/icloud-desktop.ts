// iCloud sync · desktop-only layer that points the (unit-tested) FolderTransport
// at the real iCloud Drive folder the iOS app publishes, and materializes evicted
// `.icloud` placeholders before reading.
//
// ⚠️ NEEDS-DEVICE VERIFICATION · depends on a signed-in iCloud account + the iOS
// app having created/published the container. The transport's file format + merge
// logic ARE fully tested (tests/sync-folder-transport.test.ts). macOS-only by
// design (the product ships a macOS-arm64 Electron desktop); other platforms get
// `available() === false` and simply run without sync.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FolderTransport } from "./folder-transport.js";

// Must match the iOS ICloudContainer.identifier ("iCloud.ai.boardroom.mobile").
// On disk Apple maps the dots to tildes under ~/Library/Mobile Documents/.
export const ICLOUD_DIRNAME = "iCloud~ai~boardroom~mobile";
export const SUBFOLDER = "PrivateBoard";
// The user's plain iCloud Drive root (always present when iCloud Drive is on).
// Used as the desktop sync target today, since a Developer-ID Electron app
// cannot create the entitled app container — but a folder under the user's own
// iCloud Drive syncs across THEIR Apple devices just the same.
export const CLOUDDOCS_DIRNAME = "com~apple~CloudDocs";

const mobileDocs = () => path.join(os.homedir(), "Library", "Mobile Documents");

/** `<entitled-container>/Documents/PrivateBoard` — only exists once an entitled
 *  (iOS) app has published it. */
export function icloudRoot(): string {
  return path.join(mobileDocs(), ICLOUD_DIRNAME, "Documents", SUBFOLDER);
}

/** `<iCloud Drive>/PrivateBoard` — the user-visible folder synced under the
 *  signed-in Apple ID. The desktop's realistic "Apple account sync" target. */
export function userDriveRoot(): string {
  return path.join(mobileDocs(), CLOUDDOCS_DIRNAME, SUBFOLDER);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** True when the entitled app container is present (iOS published it). */
export async function available(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return exists(path.join(mobileDocs(), ICLOUD_DIRNAME));
}

/** True when the user has iCloud Drive enabled (CloudDocs container present). */
export async function userDriveAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return exists(path.join(mobileDocs(), CLOUDDOCS_DIRNAME));
}

/** Resolve the sync folder: an explicit dev override, else the entitled app
 *  container (if iOS published it), else the user's iCloud Drive folder.
 *  Returns null when none is available (sync can't run). */
export async function resolveSyncRoot(): Promise<{ root: string; kind: "override" | "container" | "drive" } | null> {
  const override = process.env.BOARDROOM_SYNC_DIR;
  if (override && override.trim()) return { root: override.trim(), kind: "override" };
  if (await available()) return { root: icloudRoot(), kind: "container" };
  if (await userDriveAvailable()) return { root: userDriveRoot(), kind: "drive" };
  return null;
}

/** Materialize an evicted iCloud placeholder before reading. `brctl download`
 *  was removed on recent macOS, so we rely on the FileProvider faulting a dataless
 *  file in ON READ: open + read the head, and retry until it yields bytes (or the
 *  file is genuinely absent / a 0-byte stub with no `.icloud` placeholder). The
 *  caller's subsequent readFile then hits the now-downloaded file. Best-effort —
 *  if it can't download (offline), the next sync beat retries. */
async function materialize(file: string): Promise<void> {
  const placeholder = path.join(path.dirname(file), `.${path.basename(file)}.icloud`);
  const stubExists = () => fs.access(placeholder).then(() => true, () => false);
  for (let i = 0; i < 50; i++) {
    let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      fh = await fs.open(file, "r");
      const buf = Buffer.alloc(64);
      const { bytesRead } = await fh.read(buf, 0, 64, 0); // a read faults the dataless file in
      if (bytesRead > 0) return; // has content → materialized
      if (!(await stubExists())) return; // genuinely empty, no placeholder → nothing to wait for
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT" && !(await stubExists())) return; // no file at all
      /* EIO / not-yet-faulted → wait + retry */
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The production transport, or null when no sync folder is available. Resolves
 *  override → entitled container → user iCloud Drive, creating the folder. */
export async function makeICloudTransport(): Promise<{ transport: FolderTransport; root: string; kind: string } | null> {
  const resolved = await resolveSyncRoot();
  if (!resolved) return null;
  await fs.mkdir(resolved.root, { recursive: true });
  const isUbiquitous = resolved.kind !== "override";
  return {
    transport: new FolderTransport(resolved.root, isUbiquitous ? { materialize } : {}),
    root: resolved.root,
    kind: resolved.kind,
  };
}
