/**
 * LLM credentials · multi-instance per provider.
 *
 * Each row is a single API key the user has on file. The same provider
 * can appear multiple times (e.g. two OpenRouter accounts) with
 * distinct user-supplied labels. Voice + skill keys stay in
 * `provider_keys`; this module is LLM-only.
 *
 * Encryption mirrors `storage/keys.ts` (AES-256-GCM with scrypt-derived
 * key from OS username). Keep the crypto helpers consistent — when
 * `keys.ts` swaps to OS keychain in v1.2, this file follows.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { userInfo } from "node:os";

import {
  ALL_LLM_PROVIDERS,
  isLlmProvider,
  type LlmProvider,
} from "../ai/providers.js";
import { getDb } from "./db.js";

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

function maskKey(plain: string): string {
  const trimmed = plain.trim();
  if (!trimmed) return "";
  const n = trimmed.length;
  if (n <= 4) return "•".repeat(n);
  if (n <= 12) return `${trimmed.slice(0, 2)}${"•".repeat(n - 4)}${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}${"•".repeat(n - 8)}${trimmed.slice(-4)}`;
}

export interface LlmCredentialMeta {
  id: string;
  provider: LlmProvider;
  label: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  provider: string;
  label: string;
  key_blob: Buffer;
  created_at: number;
  updated_at: number;
}

function rowToMeta(row: Row): LlmCredentialMeta | null {
  if (!isLlmProvider(row.provider)) return null;
  let preview = "";
  try { preview = maskKey(decrypt(row.key_blob)); }
  catch { preview = ""; }
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    preview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** All configured LLM credentials, ordered by creation time. */
export function listLlmCredentials(): LlmCredentialMeta[] {
  const rows = getDb()
    .prepare("SELECT id, provider, label, key_blob, created_at, updated_at FROM llm_credentials ORDER BY created_at ASC")
    .all() as Row[];
  return rows.map(rowToMeta).filter((m): m is LlmCredentialMeta => m !== null);
}

/** Fetch a single credential (meta only — no plaintext). */
export function getLlmCredentialMeta(id: string): LlmCredentialMeta | null {
  const row = getDb()
    .prepare("SELECT id, provider, label, key_blob, created_at, updated_at FROM llm_credentials WHERE id = ?")
    .get(id) as Row | undefined;
  if (!row) return null;
  return rowToMeta(row);
}

/** Fetch the plaintext key for a credential id. Returns null when the
 *  id doesn't exist or the blob can't be decrypted. */
export function getLlmCredentialKey(id: string): string | null {
  const row = getDb()
    .prepare("SELECT key_blob FROM llm_credentials WHERE id = ?")
    .get(id) as { key_blob: Buffer } | undefined;
  if (!row) return null;
  try { return decrypt(row.key_blob); }
  catch { return null; }
}

/** Resolve a free label for a new credential. If the user supplied a
 *  non-empty name, use it (with the same dedup suffix logic). When
 *  empty, default to the provider's display name. Repeated labels
 *  get a numeric suffix (`B.AI`, `B.AI 2`, `B.AI 3`, …). */
function resolveFreeLabel(provider: LlmProvider, suggested: string | null | undefined): string {
  const base = (suggested && suggested.trim()) || providerDisplayName(provider);
  const existing = new Set(
    (getDb().prepare("SELECT label FROM llm_credentials").all() as Array<{ label: string }>).map((r) => r.label),
  );
  if (!existing.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  // Hard ceiling fallback · 1000 credentials sharing one label is
  // implausible; the loop guards an infinite-loop bug in the future
  // more than a real user scenario.
  return `${base} ${Date.now()}`;
}

function providerDisplayName(provider: LlmProvider): string {
  switch (provider) {
    case "openrouter": return "OpenRouter";
    case "bai":        return "B.AI";
    case "anthropic":  return "Claude";
    case "openai":     return "ChatGPT";
    case "google":     return "Gemini";
    case "xai":        return "Grok";
  }
}

/** Create a new credential and return its meta. The plaintext key is
 *  trimmed; empty inputs return null (caller should reject before
 *  reaching here, but the helper is defensive). The auto-label
 *  collision-handling suffix is applied here, not at the route. */
export function createLlmCredential(
  provider: LlmProvider,
  label: string | null | undefined,
  plain: string,
): LlmCredentialMeta | null {
  const trimmed = plain.trim();
  if (!trimmed) return null;
  if (!(ALL_LLM_PROVIDERS as readonly string[]).includes(provider)) return null;
  const resolvedLabel = resolveFreeLabel(provider, label);
  const id = randomBytes(8).toString("hex");
  const blob = encrypt(trimmed);
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO llm_credentials (id, provider, label, key_blob, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, provider, resolvedLabel, blob, now, now);
  return getLlmCredentialMeta(id);
}

/** Delete a credential by id. Returns the deleted row's provider so
 *  the caller can decide whether to rotate the active-credential pref. */
export function deleteLlmCredential(id: string): LlmProvider | null {
  const meta = getLlmCredentialMeta(id);
  if (!meta) return null;
  getDb().prepare("DELETE FROM llm_credentials WHERE id = ?").run(id);
  return meta.provider;
}
