/**
 * Provider API keys · stored AES-GCM encrypted.
 *
 * MVP-grade encryption: 256-bit key derived via scrypt from the local OS
 * username + a constant salt. Better than plaintext but not a vault — v1.2
 * will replace this with the OS keychain (macOS Keychain / Linux Secret
 * Service / Windows Credential Vault).
 *
 * Layout of stored blob:  [iv:12][tag:16][ciphertext:N]
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { userInfo } from "node:os";

import { getDb } from "./db.js";
import { getPrefs } from "./prefs.js";

const SALT = "boardroom.v1.salt";
const ALGO = "aes-256-gcm";

let _key: Buffer | null = null;
function deriveKey(): Buffer {
  if (_key) return _key;
  const username = userInfo().username || "boardroom-default";
  _key = scryptSync(username, SALT, 32);
  return _key;
}

function encrypt(plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

function decrypt(blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv(ALGO, deriveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export type Provider =
  | "openrouter"
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "deepseek"
  | "minimax"
  | "elevenlabs"
  // Skill-service keys (not LLM providers). Currently:
  //   · brave   · Brave Search API
  //   · tavily  · Tavily Search API — same Web Search orchestration hook.
  | "brave"
  | "tavily";

export type WebSearchKeyProvider = "brave" | "tavily";

/** Brave key configured (Brave-only gate for legacy callers / copy). */
export function hasBraveKey(): boolean {
  const k = getKey("brave");
  return typeof k === "string" && k.length > 0;
}

export function hasTavilyKey(): boolean {
  const k = getKey("tavily");
  return typeof k === "string" && k.length > 0;
}

/** True when at least one search API backing Web Search is available. */
export function hasWebSearchKey(): boolean {
  return hasBraveKey() || hasTavilyKey();
}

/** Pick which search backend executes this turn · `preference` applies
 *  only when both keys exist (see prefs `web_search_provider`). */
export function resolveWebSearchBackend(preference: WebSearchKeyProvider): WebSearchKeyProvider | null {
  const b = hasBraveKey();
  const t = hasTavilyKey();
  if (!b && !t) return null;
  if (b && !t) return "brave";
  if (!b && t) return "tavily";
  if (preference === "tavily" && t) return "tavily";
  if (preference === "brave" && b) return "brave";
  return b ? "brave" : "tavily";
}

/** Active backend + plaintext key · null when no search key configured. */
export function getActiveWebSearchCredentials(): {
  backend: WebSearchKeyProvider;
  apiKey: string;
} | null {
  const prefRaw = getPrefs().webSearchProvider;
  const preference: WebSearchKeyProvider = prefRaw === "tavily" ? "tavily" : "brave";
  const backend = resolveWebSearchBackend(preference);
  if (!backend) return null;
  const apiKey = getKey(backend);
  return apiKey ? { backend, apiKey } : null;
}

export interface ProviderKeyMeta {
  provider: Provider;
  configured: boolean;
  updatedAt: number | null;
  /** Recognisable masked preview of the stored key · first 4 + `…` +
   *  last 4 chars (e.g. `sk-or…YjNH`). `null` when not configured.
   *  This is the *only* echo of the key the server ever sends back —
   *  enough for the user to confirm which key is in which slot, far
   *  too short to recover the full secret. Keys ≤ 12 chars get a
   *  tighter mask (2+2) so we don't leak too much of a small string. */
  preview: string | null;
}

interface Row {
  provider: string;
  key_blob: Buffer;
  updated_at: number;
}

function maskKey(plain: string): string {
  const trimmed = plain.trim();
  if (!trimmed) return "";
  // Length-preserving mask · the visual width of the masked preview
  // matches the original key's character count. Prefix + suffix bytes
  // are real (so the user can verify which key is in the slot); the
  // middle is bullet-padded to N − prefix − suffix dots so a 60-char
  // OpenRouter key looks unmistakably "long" and a 31-char Brave key
  // looks distinctly shorter.
  const n = trimmed.length;
  if (n <= 4) return "•".repeat(n);
  if (n <= 12) {
    // Short keys · 2+dots+2 to keep entropy leakage proportionate.
    return `${trimmed.slice(0, 2)}${"•".repeat(n - 4)}${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 4)}${"•".repeat(n - 8)}${trimmed.slice(-4)}`;
}

export function listKeyMeta(): ProviderKeyMeta[] {
  const rows = getDb()
    .prepare("SELECT provider, key_blob, updated_at FROM provider_keys")
    .all() as Row[];
  const map = new Map<string, ProviderKeyMeta>();
  for (const r of rows) {
    let preview: string | null = null;
    if (r.key_blob.length > 0) {
      try { preview = maskKey(decrypt(r.key_blob)); }
      catch { preview = null; /* corrupt blob · treat as no preview */ }
    }
    map.set(r.provider, {
      provider: r.provider as Provider,
      configured: r.key_blob.length > 0,
      updatedAt: r.updated_at,
      preview,
    });
  }
  return Array.from(map.values());
}

export function getKey(provider: Provider): string | null {
  const row = getDb()
    .prepare("SELECT key_blob FROM provider_keys WHERE provider = ?")
    .get(provider) as { key_blob: Buffer } | undefined;
  if (!row) return null;
  try {
    return decrypt(row.key_blob);
  } catch {
    // Corrupt or wrong derivation key — treat as missing.
    return null;
  }
}

export function setKey(provider: Provider, plain: string): void {
  const trimmed = plain.trim();
  if (!trimmed) {
    deleteKey(provider);
    return;
  }
  const blob = encrypt(trimmed);
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO provider_keys (provider, key_blob, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET key_blob = excluded.key_blob, updated_at = excluded.updated_at`,
    )
    .run(provider, blob, now, now);
}

export function deleteKey(provider: Provider): void {
  getDb().prepare("DELETE FROM provider_keys WHERE provider = ?").run(provider);
}
