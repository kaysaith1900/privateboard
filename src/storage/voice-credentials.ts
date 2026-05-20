/**
 * Voice TTS credentials · multi-instance per provider.
 *
 * Each row is a single voice-provider API key the user has on file.
 * The same provider (minimax, elevenlabs) can appear multiple times
 * with distinct user-supplied labels. Skill keys (brave, tavily)
 * stay in `provider_keys`; this module is voice-only.
 *
 * Encryption is the same AES-256-GCM scheme used by
 * `credentials.ts` (LLM) — both go through `credential-crypto.ts`
 * so the schemes can't drift.
 *
 * Source of truth for "which voice provider is active right now"
 * is `prefs.active_voice_credential_id`. Switching active is a
 * single UPDATE on that column (see `routes/voice-credentials.ts`).
 */
import { randomBytes } from "node:crypto";

import {
  decryptCredential,
  encryptCredential,
  maskCredential,
} from "./credential-crypto.js";
import { getDb } from "./db.js";
import { getPrefs } from "./prefs.js";

export type VoiceProvider = "minimax" | "elevenlabs";

export const ALL_VOICE_PROVIDERS: readonly VoiceProvider[] = ["minimax", "elevenlabs"] as const;

export function isVoiceProvider(p: string): p is VoiceProvider {
  return (ALL_VOICE_PROVIDERS as readonly string[]).includes(p);
}

/** Priority order for auto-rotation when the active credential is
 *  deleted. MiniMax first (Chinese-mainland accounts are the most
 *  common in this project's user base), ElevenLabs as fallback.
 *  Mirrors the legacy fallback chain in `src/voice/tts.ts:165-179`. */
export const VOICE_PROVIDER_PRIORITY: readonly VoiceProvider[] = ["minimax", "elevenlabs"] as const;

export interface VoiceCredentialMeta {
  id: string;
  provider: VoiceProvider;
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

function rowToMeta(row: Row): VoiceCredentialMeta | null {
  if (!isVoiceProvider(row.provider)) return null;
  let preview = "";
  try { preview = maskCredential(decryptCredential(row.key_blob)); }
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

/** All configured voice credentials, ordered by creation time. */
export function listVoiceCredentials(): VoiceCredentialMeta[] {
  const rows = getDb()
    .prepare("SELECT id, provider, label, key_blob, created_at, updated_at FROM voice_credentials ORDER BY created_at ASC")
    .all() as Row[];
  return rows.map(rowToMeta).filter((m): m is VoiceCredentialMeta => m !== null);
}

/** Fetch a single credential (meta only — no plaintext). */
export function getVoiceCredentialMeta(id: string): VoiceCredentialMeta | null {
  const row = getDb()
    .prepare("SELECT id, provider, label, key_blob, created_at, updated_at FROM voice_credentials WHERE id = ?")
    .get(id) as Row | undefined;
  if (!row) return null;
  return rowToMeta(row);
}

/** Fetch the plaintext key for a credential id. Returns null when
 *  the id doesn't exist or the blob can't be decrypted. */
export function getVoiceCredentialKey(id: string): string | null {
  const row = getDb()
    .prepare("SELECT key_blob FROM voice_credentials WHERE id = ?")
    .get(id) as { key_blob: Buffer } | undefined;
  if (!row) return null;
  try { return decryptCredential(row.key_blob); }
  catch { return null; }
}

function providerDisplayName(provider: VoiceProvider): string {
  switch (provider) {
    case "minimax":    return "MiniMax";
    case "elevenlabs": return "ElevenLabs";
  }
}

/** Resolve a free label for a new credential. Same dedup-suffix
 *  logic as `credentials.ts` so adding three MiniMax accounts in
 *  a row produces "MiniMax", "MiniMax 2", "MiniMax 3". */
function resolveFreeLabel(provider: VoiceProvider, suggested: string | null | undefined): string {
  const base = (suggested && suggested.trim()) || providerDisplayName(provider);
  const existing = new Set(
    (getDb().prepare("SELECT label FROM voice_credentials").all() as Array<{ label: string }>).map((r) => r.label),
  );
  if (!existing.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** Create a new credential and return its meta. The plaintext key
 *  is trimmed; empty inputs return null (caller should reject
 *  before reaching here, but the helper is defensive). */
export function createVoiceCredential(
  provider: VoiceProvider,
  label: string | null | undefined,
  plain: string,
): VoiceCredentialMeta | null {
  const trimmed = plain.trim();
  if (!trimmed) return null;
  if (!isVoiceProvider(provider)) return null;
  const resolvedLabel = resolveFreeLabel(provider, label);
  const id = randomBytes(8).toString("hex");
  const blob = encryptCredential(trimmed);
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO voice_credentials (id, provider, label, key_blob, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, provider, resolvedLabel, blob, now, now);
  return getVoiceCredentialMeta(id);
}

/** Delete a credential by id. Returns the deleted row's provider
 *  so the caller can decide whether to rotate the active-pref. */
export function deleteVoiceCredential(id: string): VoiceProvider | null {
  const meta = getVoiceCredentialMeta(id);
  if (!meta) return null;
  getDb().prepare("DELETE FROM voice_credentials WHERE id = ?").run(id);
  return meta.provider;
}

/** Resolve the active voice credential by reading
 *  `prefs.active_voice_credential_id` and looking it up. Returns
 *  null when the pref is null OR the pointed row is missing
 *  (defensive · a stale pointer never crashes the caller). */
export function resolveActiveVoiceCredential(): VoiceCredentialMeta | null {
  const prefs = getPrefs();
  if (!prefs.activeVoiceCredentialId) return null;
  return getVoiceCredentialMeta(prefs.activeVoiceCredentialId);
}

/** Shortcut · the active voice provider, or null when nothing is
 *  configured. Used by the catalog endpoint + TTS routing. */
export function getActiveVoiceProvider(): VoiceProvider | null {
  return resolveActiveVoiceCredential()?.provider ?? null;
}

/** Shortcut · plaintext key of the active voice credential, or
 *  null when nothing is configured or decryption fails. */
export function getActiveVoiceKeyPlaintext(): string | null {
  const active = resolveActiveVoiceCredential();
  if (!active) return null;
  return getVoiceCredentialKey(active.id);
}
