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

export let keysMeta = {};

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

// Expose globally for non-module scripts (user-settings.js IIFE).
if (typeof window !== "undefined") {
  window.keysStore = {
    get keysMeta() { return keysMeta; },
    fetchKeyMeta,
    setProviderKey,
    getConfiguredKeys,
  };
}
