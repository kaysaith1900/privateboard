// iCloud sync · the `sync_state` key/value helpers + the hybrid logical clock.
// All clock + cursor state lives in `sync_state` (migration 059) so it survives
// restarts and is identical on desktop and (ported) iOS.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import type { HLC } from "./types.js";

export function getState(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as
    | { value: string | null }
    | undefined;
  return row ? row.value : null;
}

export function setState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** This device's stable id — minted once, then reused (the `devices/<id>/`
 *  oplog folder is keyed off it). */
export function deviceId(db: Database.Database): string {
  let id = getState(db, "device_id");
  if (!id) {
    id = randomUUID();
    setState(db, "device_id", id);
  }
  return id;
}

const PT_PAD = 15; // ms-epoch fits in 13 digits today; 15 keeps it sortable past year 5138
const CT_PAD = 6;

/** Issue a monotonically-increasing HLC for a local write. Standard hybrid
 *  logical clock: physical time, bumped by a logical counter when two writes
 *  land in the same millisecond, so the value is unique + causally ordered. */
export function nextHlc(db: Database.Database, device: string): HLC {
  const wall = Date.now();
  const last = getState(db, "hlc");
  let pt = wall;
  let ct = 0;
  if (last) {
    const [lpRaw, lcRaw] = last.split(".");
    const lp = Number(lpRaw);
    const lc = Number(lcRaw);
    if (lp >= wall) {
      pt = lp;
      ct = lc + 1;
    }
  }
  const stored = `${pt}.${ct}`;
  setState(db, "hlc", stored);
  return encodeHlc(pt, ct, device);
}

/** Fold a remote op's HLC into our clock so our next local write is causally
 *  after anything we've observed (keeps the merge a true LWW lattice). */
export function observeHlc(db: Database.Database, remote: HLC): void {
  const r = decodeHlc(remote);
  const wall = Date.now();
  const last = getState(db, "hlc");
  let lp = 0;
  let lc = 0;
  if (last) {
    const parts = last.split(".");
    lp = Number(parts[0]);
    lc = Number(parts[1]);
  }
  const maxPt = Math.max(wall, lp, r.pt);
  let c = 0;
  if (maxPt === lp && maxPt === r.pt) c = Math.max(lc, r.ct) + 1;
  else if (maxPt === lp) c = lc + 1;
  else if (maxPt === r.pt) c = r.ct + 1;
  // else maxPt === wall (strictly ahead of both) → counter resets to 0
  setState(db, "hlc", `${maxPt}.${c}`);
}

export function encodeHlc(pt: number, ct: number, device: string): HLC {
  return `${String(pt).padStart(PT_PAD, "0")}.${String(ct).padStart(CT_PAD, "0")}.${device}`;
}

export function decodeHlc(hlc: HLC): { pt: number; ct: number; device: string } {
  const [p, c, ...rest] = hlc.split(".");
  return { pt: Number(p), ct: Number(c), device: rest.join(".") };
}

/** Lexicographic compare IS the LWW order (padded encoding guarantees it). */
export function hlcGreater(a: HLC, b: HLC | null | undefined): boolean {
  if (!b) return true;
  return a > b;
}
