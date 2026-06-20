// iCloud sync · desktop file-backed transport (Node fs). The TS counterpart of
// the Swift FolderTransport: each device appends its ops as JSONL to its OWN
// file `<root>/devices/<deviceId>/ops.jsonl` (the "one writer per file" invariant
// that dodges iCloud conflict-copies). Directory-driven, so it's fully unit-tested
// against a plain temp dir; in production `root` is the iOS-published iCloud
// ubiquity container (see icloud-desktop.ts), with `materialize` triggering
// download of evicted `.icloud` placeholders.

import { promises as fs } from "node:fs";
import path from "node:path";

import type { SyncOp } from "./types.js";
import type { PullResult, SyncTransport } from "./transport.js";

export interface FolderTransportOptions {
  /** Called before reading a device's segment to materialize an evicted iCloud
   *  placeholder (no-op on a plain local dir). */
  materialize?: (file: string) => Promise<void>;
}

export class FolderTransport implements SyncTransport {
  constructor(
    private readonly root: string,
    private readonly opts: FolderTransportOptions = {},
  ) {}

  private deviceDir(device: string): string {
    return path.join(this.root, "devices", device);
  }
  private opsFile(device: string): string {
    return path.join(this.deviceDir(device), "ops.jsonl");
  }
  private blobFile(hash: string): string {
    return path.join(this.root, "blobs", hash);
  }

  async putBlob(hash: string, data: Buffer): Promise<void> {
    await fs.mkdir(path.join(this.root, "blobs"), { recursive: true });
    const file = this.blobFile(hash);
    try {
      await fs.access(file);
      return; // content-addressed · already present, immutable
    } catch {
      /* write it */
    }
    await fs.writeFile(file, data);
  }

  async getBlob(hash: string): Promise<Buffer | null> {
    const file = this.blobFile(hash);
    if (this.opts.materialize) {
      try {
        await this.opts.materialize(file);
      } catch {
        /* best-effort */
      }
    }
    try {
      return await fs.readFile(file);
    } catch {
      return null; // not synced yet
    }
  }

  async push(device: string, ops: SyncOp[]): Promise<void> {
    if (ops.length === 0) return;
    await fs.mkdir(this.deviceDir(device), { recursive: true });
    const blob = ops.map((o) => JSON.stringify(o)).join("\n") + "\n";
    await fs.appendFile(this.opsFile(device), blob, "utf8"); // append-only · one writer per file
  }

  /** Kill-switch · delete a device's whole segment from the shared folder. */
  async removeDevice(device: string): Promise<void> {
    await fs.rm(this.deviceDir(device), { recursive: true, force: true });
  }

  /** Diagnostic · device subdirs currently visible under `devices/` (one per
   *  device that has published a segment). Used by the desktop status to show
   *  whether the phone's folder has actually arrived. */
  async listPeers(): Promise<string[]> {
    try {
      const entries = await fs.readdir(path.join(this.root, "devices"));
      return entries.filter((e) => !e.startsWith("."));
    } catch {
      return [];
    }
  }

  async pull(cursors: Record<string, number>): Promise<PullResult> {
    const out: SyncOp[] = [];
    const next = { ...cursors };
    const devicesRoot = path.join(this.root, "devices");
    let devices: string[];
    try {
      devices = await fs.readdir(devicesRoot);
    } catch {
      return { ops: out, cursors: next }; // nothing published yet
    }
    for (const device of devices) {
      if (device.startsWith(".")) continue; // skip dotfiles / `.ops.jsonl.icloud` stubs
      const file = this.opsFile(device);
      if (this.opts.materialize) {
        try {
          await this.opts.materialize(file);
        } catch {
          /* best-effort; fall through to the read */
        }
      }
      let data: string;
      try {
        data = await fs.readFile(file, "utf8");
      } catch {
        continue; // a device dir without a (downloaded) segment yet
      }
      const lines = data.split("\n").filter((l) => l.length > 0);
      const from = cursors[device] ?? 0;
      for (let i = from; i < lines.length; i++) {
        try {
          out.push(JSON.parse(lines[i]) as SyncOp);
        } catch {
          /* skip a torn/partial trailing line — picked up once fully written */
        }
      }
      next[device] = lines.length;
    }
    return { ops: out, cursors: next };
  }
}
