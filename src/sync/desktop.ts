// iCloud sync · desktop control plane. A singleton the Electron main process +
// the /api/sync routes share: turn sync on/off (persisted), drive convergence on
// quiescence (periodic + fs.watch), and expose live progress/status for the
// settings UI. Resolves the sync folder as: BOARDROOM_SYNC_DIR override → the
// entitled iOS-published container → the user's own iCloud Drive folder.

import fs from "node:fs";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import { SyncEngine } from "./engine.js";
import { getState, setState } from "./state.js";
import { flushStaged, setCaptureSuppressed } from "./capture.js";
import { makeICloudTransport, resolveSyncRoot } from "./icloud-desktop.js";

export interface SyncStatus {
  enabled: boolean; // the user's toggle (persisted)
  available: boolean; // a sync folder is resolvable on this machine
  running: boolean; // the engine is active right now
  state: "off" | "idle" | "syncing" | "error";
  folder: string | null;
  folderKind: "override" | "container" | "drive" | null;
  deviceId: string | null;
  lastSyncAt: number | null;
  lastPushed: number;
  lastApplied: number;
  totalPushed: number;
  totalApplied: number;
  pending: number; // local changes waiting to upload (sync_outbox) · 0 = up to date
  tracked: number; // ops this device has synced over its lifetime (proof data is in iCloud)
  peers: string[]; // device ids visible in the shared folder (incl. self) · empty = no peer published yet
  error: string | null;
}

const USER_ENABLED = "user_enabled";
const DEFAULT_INTERVAL_MS = 30_000;

/** Stable short id for a sync folder · keys the per-folder genesis marker so a
 *  re-point (user iCloud Drive → published app container) re-exports once. */
function folderTag(root: string): string {
  return createHash("sha1").update(root).digest("hex").slice(0, 12);
}

class SyncManager {
  private db: Database.Database | null = null;
  private engine: SyncEngine | null = null;
  private interval: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private busy = false;
  private repointing = false;
  private intervalMs = DEFAULT_INTERVAL_MS;

  private status: SyncStatus = {
    enabled: false, available: false, running: false, state: "off",
    folder: null, folderKind: null, deviceId: null, lastSyncAt: null,
    lastPushed: 0, lastApplied: 0, totalPushed: 0, totalApplied: 0,
    pending: 0, tracked: 0, peers: [], error: null,
  };
  private transport: { listPeers?(): Promise<string[]> } | null = null;

  /** Boot · adopt the persisted toggle and start if the user had it on. */
  async init(db: Database.Database, opts: { intervalMs?: number } = {}): Promise<void> {
    this.db = db;
    if (opts.intervalMs) this.intervalMs = opts.intervalMs;
    // Env override forces-on for headless/dev use even without a persisted pref.
    const persisted = getState(db, USER_ENABLED) === "1";
    const forced = process.env.BOARDROOM_ICLOUD_SYNC === "1";
    this.status.available = (await resolveSyncRoot()) !== null;
    if (persisted || forced) await this.start();
  }

  async getStatus(): Promise<SyncStatus> {
    if (this.db) {
      this.status.available = (await resolveSyncRoot()) !== null;
      try {
        this.status.pending = (this.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n;
        this.status.tracked = (this.db.prepare("SELECT COUNT(*) AS n FROM synced_ops").get() as { n: number }).n;
      } catch { /* tables absent pre-migration */ }
    }
    if (this.transport?.listPeers) {
      try { this.status.peers = await this.transport.listPeers(); } catch { /* best-effort */ }
    }
    return { ...this.status };
  }

  /** User flipped the toggle. Persists + starts/stops. */
  async setEnabled(on: boolean): Promise<SyncStatus> {
    if (!this.db) throw new Error("[sync] manager not initialized");
    setState(this.db, USER_ENABLED, on ? "1" : "0");
    this.status.enabled = on;
    if (on) await this.start();
    else await this.stop();
    return this.getStatus();
  }

  private async start(): Promise<void> {
    if (!this.db || this.engine) return; // already running
    const made = await makeICloudTransport();
    this.status.enabled = true;
    if (!made) {
      // Toggle is on, but no iCloud folder yet (e.g. iCloud Drive off). Persisted
      // so it auto-starts once available; surface as "available:false".
      this.status.available = false;
      this.status.running = false;
      this.status.state = "error";
      this.status.error = "iCloud unavailable (turn on iCloud Drive, or sign in)";
      return;
    }
    this.engine = new SyncEngine(this.db, made.transport);
    this.transport = made.transport;
    this.status.available = true;
    this.status.running = true;
    this.status.state = "idle";
    this.status.error = null;
    this.status.folder = made.root;
    this.status.folderKind = made.kind as SyncStatus["folderKind"];
    this.status.deviceId = this.engine.device;
    // One-time full export of existing rows into THIS folder (no-op if already
    // done). Lets a device that already had directors/rooms upload them, and
    // re-runs when we re-point onto a different folder (drive → app container).
    this.engine.ensureGenesis(folderTag(made.root));

    this.interval = setInterval(() => void this.syncNow(), this.intervalMs);
    if (typeof this.interval.unref === "function") this.interval.unref();
    try {
      this.watcher = fs.watch(made.root, { recursive: true }, () => void this.syncNow());
    } catch {
      /* fs.watch best-effort; the periodic beat still converges */
    }
    await this.syncNow();
  }

  /** Final flush+push then tear down (also the user-disable path). */
  async stop(): Promise<void> {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.engine) {
      try {
        flushStaged(this.db!, (await import("./registry.js")).ENTITIES);
        await this.engine.push();
      } catch { /* best-effort final flush */ }
      this.engine = null;
    }
    this.transport = null;
    if (this.db) setCaptureSuppressed(this.db, false);
    this.status.running = false;
    // enabled stays as the persisted user choice; state reflects we're stopped.
    this.status.state = this.status.enabled ? "idle" : "off";
  }

  async syncNow(): Promise<SyncStatus> {
    // Re-point if the resolved folder changed since we started — e.g. the iOS app
    // just published the entitled container, so we switch off the user iCloud
    // Drive onto the shared container and re-genesis there (start() handles it).
    if (this.engine && !this.busy && !this.repointing) {
      const resolved = await resolveSyncRoot();
      if (resolved && resolved.root !== this.status.folder) {
        this.repointing = true;
        try {
          await this.stop();
          await this.start();
        } finally {
          this.repointing = false;
        }
        return this.getStatus();
      }
    }
    if (!this.engine || this.busy) return this.getStatus();
    this.busy = true;
    this.status.state = "syncing";
    try {
      const { pushed, applied } = await this.engine.sync();
      this.status.lastPushed = pushed;
      this.status.lastApplied = applied;
      this.status.totalPushed += pushed;
      this.status.totalApplied += applied;
      this.status.lastSyncAt = Date.now();
      this.status.error = null;
      this.status.state = "idle";
    } catch (e) {
      this.status.error = e instanceof Error ? e.message : String(e);
      this.status.state = "error";
    } finally {
      this.busy = false;
    }
    return this.getStatus(); // re-query pending/tracked so the caller sees fresh counts
  }
}

/** Process-wide singleton (boot.ts inits it; /api/sync routes drive it). */
export const syncManager = new SyncManager();
