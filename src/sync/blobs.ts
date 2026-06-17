// iCloud sync · binary blob externalization. Large binary column values — most
// notably data-URL avatar portraits in agents.avatar_path — would bloat every op
// (and the oplog file) if carried inline. Instead, at push we hash the bytes,
// store them once in the content-addressed blob store (`blobs/<sha256>`), and put
// a small `bsync-blob:<sha256>:<mime>` reference in the op; at pull we fetch the
// bytes back and reconstruct the data-URL before applying. Non-data-URL values
// (bundled avatar PATHS like "avatars/3d/x.png") are left untouched — both apps
// already ship those assets, so the path string syncs as-is.

import { createHash } from "node:crypto";

import type { Registry, SyncOp } from "./types.js";
import type { SyncTransport } from "./transport.js";

const PREFIX = "bsync-blob:";
const MIN_BYTES = 256; // below this, inline is cheaper than a blob round-trip

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function parseDataUrl(s: string): { mime: string; data: Buffer } | null {
  const comma = s.indexOf(",");
  if (!s.startsWith("data:") || comma < 0) return null;
  const header = s.slice(5, comma); // e.g. "image/png;base64"
  if (!header.endsWith(";base64")) return null;
  const mime = header.slice(0, -";base64".length) || "application/octet-stream";
  try {
    return { mime, data: Buffer.from(s.slice(comma + 1), "base64") };
  } catch {
    return null;
  }
}

/** Replace large data-URL blob-column values with a content-addressed reference,
 *  storing the bytes in the transport. Mutates the ops in place (they're about to
 *  be serialized to our own segment). No-op when the transport has no blob store. */
export async function externalize(
  transport: SyncTransport,
  ops: SyncOp[],
  registry: Registry,
): Promise<void> {
  if (!transport.putBlob) return;
  for (const op of ops) {
    if (op.op !== "upsert" || !op.cols) continue;
    const blobCols = registry[op.entity]?.blobCols;
    if (!blobCols) continue;
    for (const col of blobCols) {
      const v = op.cols[col];
      if (typeof v !== "string") continue;
      // Never carry a blank or a dangling `bsync-blob:` ref (e.g. from a peer that
      // failed to fetch the blob and cleared the value) — dropping the column means
      // LWW can't overwrite a peer's good avatar with an empty one.
      if (v === "" || v.startsWith(PREFIX)) {
        delete op.cols[col];
        continue;
      }
      if (v.length < MIN_BYTES || !v.startsWith("data:")) continue; // bundled path → sync as-is
      const parsed = parseDataUrl(v);
      if (!parsed) continue;
      const hash = sha256(parsed.data);
      await transport.putBlob(hash, parsed.data);
      op.cols[col] = `${PREFIX}${hash}:${parsed.mime}`;
    }
  }
}

/** Reconstruct data-URLs from blob references, fetching bytes from the transport.
 *  A blob not yet synced → the column is cleared (graceful default avatar) rather
 *  than leaving a `bsync-blob:` string in the row. Mutates ops in place. */
export async function internalize(
  transport: SyncTransport,
  ops: SyncOp[],
  registry: Registry,
): Promise<void> {
  if (!transport.getBlob) return;
  for (const op of ops) {
    if (op.op !== "upsert" || !op.cols) continue;
    const blobCols = registry[op.entity]?.blobCols;
    if (!blobCols) continue;
    for (const col of blobCols) {
      const v = op.cols[col];
      if (typeof v !== "string" || !v.startsWith(PREFIX)) continue;
      const rest = v.slice(PREFIX.length);
      const sep = rest.indexOf(":");
      const hash = sep < 0 ? rest : rest.slice(0, sep);
      const mime = sep < 0 ? "application/octet-stream" : rest.slice(sep + 1);
      const data = await transport.getBlob(hash);
      op.cols[col] = data ? `data:${mime};base64,${data.toString("base64")}` : "";
    }
  }
}

export const BLOB_REF_PREFIX = PREFIX;
