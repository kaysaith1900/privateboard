// iCloud sync · the transport seam. The engine talks ONLY to this interface,
// so the merge core is testable with an in-memory fake and the real iCloud
// file backend (per-device append-only `ops-*.jsonl` segments under the
// ubiquity container) is a drop-in implementation added in P2/P3.

import type { SyncOp } from "./types.js";

export interface PullResult {
  ops: SyncOp[];
  /** Updated high-water cursors (per origin device) to persist after a
   *  successful apply, so the next pull only sees newer ops. */
  cursors: Record<string, number>;
}

export interface SyncTransport {
  /** Append this device's outbound ops to its own segment (append-only). */
  push(device: string, ops: SyncOp[]): Promise<void>;
  /** Return ops from every device beyond the given per-device cursors. */
  pull(cursors: Record<string, number>): Promise<PullResult>;
  /** Content-addressed blob store (optional). Large binary column values (data-URL
   *  avatar portraits) are externalized to `blobs/<sha256>` so they don't bloat the
   *  oplog; `getBlob` returns null when the blob hasn't synced yet. */
  putBlob?(hash: string, data: Buffer): Promise<void>;
  getBlob?(hash: string): Promise<Buffer | null>;
  /** Diagnostic · the device ids currently visible in the shared folder (one
   *  subdir per device under `devices/`). Lets status show whether a peer (the
   *  phone) has actually published its segment yet. */
  listPeers?(): Promise<string[]>;
  /** Kill-switch · delete a device's whole segment (`devices/<device>/`) from the
   *  shared folder. Used to remove THIS device's synced data from iCloud when the
   *  user turns sync off and opts to wipe. Shared blobs are content-addressed and
   *  left as-is (other ops may reference them). */
  removeDevice?(device: string): Promise<void>;
}

/** In-memory stand-in for the shared iCloud folder. Multiple engines sharing
 *  ONE instance = multiple devices syncing through "iCloud". Each device's
 *  array is its append-only segment; the cursor is the count consumed. */
export class InMemoryTransport implements SyncTransport {
  private segments = new Map<string, SyncOp[]>();
  private blobs = new Map<string, Buffer>();

  async push(device: string, ops: SyncOp[]): Promise<void> {
    const seg = this.segments.get(device) ?? [];
    // Deep-copy via JSON to simulate serialization (so externalize mutations on
    // the caller's ops don't leak, matching a real wire transport).
    seg.push(...ops.map((o) => JSON.parse(JSON.stringify(o)) as SyncOp));
    this.segments.set(device, seg);
  }

  async putBlob(hash: string, data: Buffer): Promise<void> {
    this.blobs.set(hash, Buffer.from(data));
  }
  async removeDevice(device: string): Promise<void> {
    this.segments.delete(device);
  }
  async getBlob(hash: string): Promise<Buffer | null> {
    return this.blobs.get(hash) ?? null;
  }

  async pull(cursors: Record<string, number>): Promise<PullResult> {
    const out: SyncOp[] = [];
    const next: Record<string, number> = { ...cursors };
    for (const [device, seg] of this.segments) {
      const from = cursors[device] ?? 0;
      for (let i = from; i < seg.length; i++) out.push({ ...seg[i] });
      next[device] = seg.length;
    }
    return { ops: out, cursors: next };
  }
}
