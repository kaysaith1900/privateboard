/**
 * keys-store.js · canonical key-state module
 *
 * Loaded as <script type="module"> so it can be imported by vitest
 * directly for unit-testing without a browser. The module also writes
 * itself onto window.keysStore so the non-module user-settings.js IIFE
 * can delegate to it at runtime.
 *
 * State lives HERE — user-settings.js must not maintain a parallel copy.
 */

// MIRROR: src/ai/providers.ts — single source of truth for the
// single-active-LLM-provider taxonomy. When a new multi-model carrier
// is added (future OpenRouter alternative), update BOTH this file AND
// `src/ai/providers.ts`. Future scripts/sync-provider-taxonomy.mjs may
// generate this block automatically from the TS source.
export const MULTI_MODEL_LLM_PROVIDERS = ["openrouter", "bai"];
export const SINGLE_MODEL_LLM_PROVIDERS = ["anthropic", "openai", "google", "xai"];
export const ALL_LLM_PROVIDERS = [...MULTI_MODEL_LLM_PROVIDERS, ...SINGLE_MODEL_LLM_PROVIDERS];

export const LLM_PROVIDER_CLASSIFICATION = {
  openrouter: "multi-model",
  bai:        "multi-model",
  anthropic:  "single-model",
  openai:     "single-model",
  google:     "single-model",
  xai:        "single-model",
};

export function isMultiModelProvider(p) {
  return p === "openrouter" || p === "bai";
}
export function isLlmProvider(p) {
  return ALL_LLM_PROVIDERS.indexOf(p) >= 0;
}

export let keysMeta = {};

/** LLM credentials list · live snapshot from /api/credentials. Each
 *  entry: `{ id, provider, label, preview, createdAt, updatedAt, isActive }`.
 *  Replaced wholesale on every refresh — never mutated in place — so
 *  callers can compare references to detect change. */
export let llmCredentials = [];

/** Server-authoritative active credential id (or null when none). */
export let activeLlmCredentialId = null;

/** Rebuild keysMeta from the server.  Replaces the whole object so callers
 *  that hold a reference to the old snapshot see stale data — always read
 *  via the exported binding, not a captured variable. */
export async function fetchKeyMeta() {
  try {
    const r = await fetch("/api/keys");
    if (!r.ok) return;
    const data = await r.json();
    const next = {};
    for (const row of (data.keys || [])) next[row.provider] = row;
    keysMeta = next;
  } catch { /* keep last snapshot on network failure */ }
}

/** Rebuild llmCredentials + activeLlmCredentialId from /api/credentials. */
export async function fetchLlmCredentials() {
  try {
    const r = await fetch("/api/credentials");
    if (!r.ok) return;
    const data = await r.json();
    llmCredentials = Array.isArray(data.credentials) ? data.credentials : [];
    activeLlmCredentialId = typeof data.activeId === "string" ? data.activeId : null;
  } catch { /* keep last snapshot on network failure */ }
}

/** Create a new credential. Returns the new credential payload or null. */
export async function createLlmCredentialRequest(provider, label, key) {
  try {
    const r = await fetch("/api/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, label: label || null, key }),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** Delete a credential. Returns true on success. */
export async function deleteLlmCredentialRequest(id) {
  try {
    const r = await fetch("/api/credentials/" + encodeURIComponent(id), { method: "DELETE" });
    return r.ok;
  } catch { return false; }
}

/** Switch the active credential. Pass null to clear. */
export async function setActiveLlmCredentialRequest(id) {
  try {
    const r = await fetch("/api/credentials/active", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    return r.ok;
  } catch { return false; }
}

/** PUT (non-empty value) or DELETE (empty/whitespace) a single key.
 *  Mirrors the resulting meta into keysMeta and returns it, or null on
 *  error. */
export async function setProviderKey(provider, value) {
  try {
    const trimmed = (value || "").trim();
    const r = await fetch("/api/keys/" + encodeURIComponent(provider), {
      method: trimmed ? "PUT" : "DELETE",
      headers: trimmed ? { "content-type": "application/json" } : undefined,
      body: trimmed ? JSON.stringify({ key: trimmed }) : undefined,
    });
    if (!r.ok) return null;
    const meta = await r.json();
    keysMeta[provider] = meta;
    return meta;
  } catch { return null; }
}

/** Returns only the configured providers (existence-check safe). */
export function getConfiguredKeys() {
  const out = {};
  for (const [p, m] of Object.entries(keysMeta)) {
    if (m && m.configured) out[p] = m;
  }
  return out;
}

/** Resolve the active credential's provider (or null when no
 *  credential is active). Reads from the local `llmCredentials`
 *  snapshot — fetchLlmCredentials() must have completed for the value
 *  to be accurate. */
export function activeLlmProvider() {
  const id = activeLlmCredentialId;
  if (!id) return null;
  const active = llmCredentials.find((c) => c.id === id);
  return active ? active.provider : null;
}

/** The active credential row itself (label, preview, etc.) or null. */
export function activeLlmCredential() {
  const id = activeLlmCredentialId;
  if (!id) return null;
  return llmCredentials.find((c) => c.id === id) || null;
}

// Expose globally for non-module scripts (user-settings.js IIFE +
// app.js / new-agent.js / onboarding.js).
if (typeof window !== "undefined") {
  window.keysStore = {
    get keysMeta() { return keysMeta; },
    get llmCredentials() { return llmCredentials; },
    get activeLlmCredentialId() { return activeLlmCredentialId; },
    fetchKeyMeta,
    fetchLlmCredentials,
    setProviderKey,
    createLlmCredentialRequest,
    deleteLlmCredentialRequest,
    setActiveLlmCredentialRequest,
    getConfiguredKeys,
    activeLlmProvider,
    activeLlmCredential,
    MULTI_MODEL_LLM_PROVIDERS,
    SINGLE_MODEL_LLM_PROVIDERS,
    ALL_LLM_PROVIDERS,
    LLM_PROVIDER_CLASSIFICATION,
    isMultiModelProvider,
    isLlmProvider,
  };
}
