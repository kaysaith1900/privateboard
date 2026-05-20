/**
 * Shared credential crypto · AES-256-GCM helpers used by both
 * `credentials.ts` (LLM keys) and `voice-credentials.ts` (TTS keys).
 *
 * Key derived from OS username via scrypt; same scheme as legacy
 * `keys.ts` so a single store-wide swap to OS keychain in v1.2
 * lands all three modules at once. Blob layout is
 *   [iv:12][authTag:16][ciphertext:N]
 *
 * Do NOT duplicate this logic in callers — if you need a custom
 * key-derivation path, extend this module instead so the encryption
 * scheme stays uniform across the project.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { userInfo } from "node:os";

const SALT = "boardroom.v1.salt";
const ALGO = "aes-256-gcm";

let _key: Buffer | null = null;
function deriveKey(): Buffer {
  if (_key) return _key;
  const username = userInfo().username || "boardroom-default";
  _key = scryptSync(username, SALT, 32);
  return _key;
}

/** Encrypt a plaintext key into a buffer suitable for `key_blob`
 *  columns. Layout is `[iv:12][tag:16][ciphertext:N]`. */
export function encryptCredential(plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/** Decrypt a `key_blob` back to plaintext. Throws on tag mismatch
 *  (returned as a thrown error — callers wrap in try/catch and
 *  treat as "missing key" so a corrupted blob never crashes the
 *  request). */
export function decryptCredential(blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv(ALGO, deriveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Render a key preview safe to show in UI · keeps the first and
 *  last few characters with bullets in between. Empty input
 *  returns empty string. */
export function maskCredential(plain: string): string {
  const trimmed = plain.trim();
  if (!trimmed) return "";
  const n = trimmed.length;
  if (n <= 4) return "•".repeat(n);
  if (n <= 12) return `${trimmed.slice(0, 2)}${"•".repeat(n - 4)}${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}${"•".repeat(n - 8)}${trimmed.slice(-4)}`;
}
