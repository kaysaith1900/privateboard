/**
 * Search provider credentials · multi-instance per provider.
 *
 * Each row is a single search-provider API key the user has on file.
 * The same provider (brave, tavily) can appear multiple times with
 * distinct user-supplied labels. Mirrors `voice-credentials.ts` 1-for-1
 * with the search-provider taxonomy in place of the voice taxonomy.
 *
 * Source of truth for "which search provider is active right now" is
 * `prefs.active_search_credential_id`. Switching active is a single
 * UPDATE on that column (see `routes/search-credentials.ts`); unlike
 * the LLM and voice flips, no per-agent reshuffle is needed because
 * agents don't carry per-search-provider state — the next web-search
 * call simply routes through the new credential.
 */
import { randomBytes } from "node:crypto";

import {
  decryptCredential,
  encryptCredential,
  maskCredential,
} from "./credential-crypto.js";
import { getDb } from "./db.js";
import { getPrefs } from "./prefs.js";

export type SearchProvider = "brave" | "tavily";

export const ALL_SEARCH_PROVIDERS: readonly SearchProvider[] = ["brave", "tavily"] as const;

export function isSearchProvider(p: string): p is SearchProvider {
  return (ALL_SEARCH_PROVIDERS as readonly string[]).includes(p);
}

/** Priority order for auto-rotation when the active credential is
 *  deleted. Brave first (mirrors the historical default in
 *  migration 029 where webSearchProvider defaulted to "brave"),
 *  Tavily as fallback. */
export const SEARCH_PROVIDER_PRIORITY: readonly SearchProvider[] = ["brave", "tavily"] as const;

export interface SearchCredentialMeta {
  id: string;
  provider: SearchProvider;
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

function rowToMeta(row: Row): SearchCredentialMeta | null {
  if (!isSearchProvider(row.provider)) return null;
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

/** All configured search credentials, ordered by creation time. */
export function listSearchCredentials(): SearchCredentialMeta[] {
  const rows = getDb()
    .prepare("SELECT id, provider, label, key_blob, created_at, updated_at FROM search_credentials ORDER BY created_at ASC")
    .all() as Row[];
  return rows.map(rowToMeta).filter((m): m is SearchCredentialMeta => m !== null);
}

export function getSearchCredentialMeta(id: string): SearchCredentialMeta | null {
  const row = getDb()
    .prepare("SELECT id, provider, label, key_blob, created_at, updated_at FROM search_credentials WHERE id = ?")
    .get(id) as Row | undefined;
  if (!row) return null;
  return rowToMeta(row);
}

export function getSearchCredentialKey(id: string): string | null {
  const row = getDb()
    .prepare("SELECT key_blob FROM search_credentials WHERE id = ?")
    .get(id) as { key_blob: Buffer } | undefined;
  if (!row) return null;
  try { return decryptCredential(row.key_blob); }
  catch { return null; }
}

function providerDisplayName(provider: SearchProvider): string {
  switch (provider) {
    case "brave":  return "Brave Search";
    case "tavily": return "Tavily Search";
  }
}

function resolveFreeLabel(provider: SearchProvider, suggested: string | null | undefined): string {
  const base = (suggested && suggested.trim()) || providerDisplayName(provider);
  const existing = new Set(
    (getDb().prepare("SELECT label FROM search_credentials").all() as Array<{ label: string }>).map((r) => r.label),
  );
  if (!existing.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export function createSearchCredential(
  provider: SearchProvider,
  label: string | null | undefined,
  plain: string,
): SearchCredentialMeta | null {
  const trimmed = plain.trim();
  if (!trimmed) return null;
  if (!isSearchProvider(provider)) return null;
  const resolvedLabel = resolveFreeLabel(provider, label);
  const id = randomBytes(8).toString("hex");
  const blob = encryptCredential(trimmed);
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO search_credentials (id, provider, label, key_blob, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, provider, resolvedLabel, blob, now, now);
  return getSearchCredentialMeta(id);
}

export function deleteSearchCredential(id: string): SearchProvider | null {
  const meta = getSearchCredentialMeta(id);
  if (!meta) return null;
  getDb().prepare("DELETE FROM search_credentials WHERE id = ?").run(id);
  return meta.provider;
}

/** Resolve the active search credential by reading
 *  `prefs.active_search_credential_id` and looking it up. Returns
 *  null when the pref is null OR the pointed row is missing
 *  (defensive · a stale pointer never crashes the caller). */
export function resolveActiveSearchCredential(): SearchCredentialMeta | null {
  const prefs = getPrefs();
  if (!prefs.activeSearchCredentialId) return null;
  return getSearchCredentialMeta(prefs.activeSearchCredentialId);
}

/** Shortcut · the active search provider, or null when nothing is
 *  configured. Used by the web-search routing layer. */
export function getActiveSearchProvider(): SearchProvider | null {
  return resolveActiveSearchCredential()?.provider ?? null;
}

/** Shortcut · plaintext key of the active search credential, or null
 *  when nothing is configured or decryption fails. The web-search
 *  callers (`runWebSearch` in routes/agents.ts + orchestrator) call
 *  this to fetch the API key for the upstream Brave / Tavily call. */
export function getActiveSearchKeyPlaintext(): string | null {
  const active = resolveActiveSearchCredential();
  if (!active) return null;
  return getSearchCredentialKey(active.id);
}
