/**
 * /api/search-credentials · web-search provider credentials (multi-instance).
 *
 *   GET    /api/search-credentials         → list every search credential
 *   POST   /api/search-credentials         → create a new credential
 *   DELETE /api/search-credentials/:id     → remove (auto-rotates active)
 *   PUT    /api/search-credentials/active  → switch which credential is active
 *
 * Mirrors `src/routes/voice-credentials.ts` 1-for-1, minus the
 * `reconcile-*` invocation — agents don't carry per-search-provider
 * state, so switching active is a routing-only decision that the next
 * web-search call automatically honours.
 *
 * Plaintext keys never leave the server — responses carry the
 * `preview` mask (4+4) only.
 */
import { Hono } from "hono";

import { getPrefs, updatePrefs } from "../storage/prefs.js";
import {
  ALL_SEARCH_PROVIDERS,
  SEARCH_PROVIDER_PRIORITY,
  createSearchCredential,
  deleteSearchCredential,
  getSearchCredentialMeta,
  isSearchProvider,
  listSearchCredentials,
  type SearchCredentialMeta,
  type SearchProvider,
} from "../storage/search-credentials.js";

void ALL_SEARCH_PROVIDERS;

interface SearchCredentialPayload {
  id: string;
  provider: SearchProvider;
  label: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  isActive: boolean;
}

function payloadFor(meta: SearchCredentialMeta, activeId: string | null): SearchCredentialPayload {
  return {
    id: meta.id,
    provider: meta.provider,
    label: meta.label,
    preview: meta.preview,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    isActive: meta.id === activeId,
  };
}

/** Pick the next-highest-priority credential after deleting `removed`.
 *  Same-provider sibling first, then priority order, then creation
 *  time. Returns null when no credentials remain. Mirror of the LLM /
 *  voice rotation helpers. */
function pickNextActiveSearchId(removedProvider: SearchProvider | null): string | null {
  const all = listSearchCredentials();
  if (all.length === 0) return null;
  if (removedProvider) {
    const sameProvider = all.filter((c) => c.provider === removedProvider);
    if (sameProvider.length > 0) {
      sameProvider.sort((a, b) => a.createdAt - b.createdAt);
      return sameProvider[0].id;
    }
  }
  const sorted = all.slice().sort((a, b) => {
    const ai = SEARCH_PROVIDER_PRIORITY.indexOf(a.provider);
    const bi = SEARCH_PROVIDER_PRIORITY.indexOf(b.provider);
    if (ai !== bi) return ai - bi;
    return a.createdAt - b.createdAt;
  });
  return sorted[0]?.id ?? null;
}

export function searchCredentialsRouter(): Hono {
  const r = new Hono();

  r.get("/", (c) => {
    const activeId = getPrefs().activeSearchCredentialId;
    const items = listSearchCredentials().map((m) => payloadFor(m, activeId));
    return c.json({
      credentials: items,
      activeId: activeId,
    });
  });

  // PUT /api/search-credentials/active · switch the active credential.
  // Mounted BEFORE the parametric DELETE so Hono's matcher picks this
  // route first when the path is `/active`.
  r.put("/active", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }
    const rawId = (body as { id?: unknown })?.id;
    let nextId: string | null;
    if (rawId === null || rawId === undefined) {
      nextId = null;
    } else if (typeof rawId === "string") {
      nextId = rawId;
    } else {
      return c.json({ error: "id must be a string or null" }, 400);
    }

    if (nextId) {
      const meta = getSearchCredentialMeta(nextId);
      if (!meta) return c.json({ error: "credential not found" }, 404);
      updatePrefs({ activeSearchCredentialId: nextId });
    } else {
      updatePrefs({ activeSearchCredentialId: null });
    }

    return c.json({ activeId: nextId });
  });

  r.post("/", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }
    const provider = (body as { provider?: unknown })?.provider;
    const labelRaw = (body as { label?: unknown })?.label;
    const key = (body as { key?: unknown })?.key;
    if (typeof provider !== "string" || !isSearchProvider(provider)) {
      return c.json({ error: "provider must be 'brave' or 'tavily'" }, 400);
    }
    if (typeof key !== "string" || key.trim().length === 0) {
      return c.json({ error: "key must be a non-empty string" }, 400);
    }
    const label = typeof labelRaw === "string" ? labelRaw : null;
    const meta = createSearchCredential(provider, label, key);
    if (!meta) return c.json({ error: "failed to create credential" }, 500);

    // Auto-activate only on the FIRST credential · subsequent inserts
    // leave the active pointer alone so the user keeps using the
    // credential they explicitly picked. Symmetric with LLM and voice
    // POST handlers.
    const hadActive = !!getPrefs().activeSearchCredentialId;
    if (!hadActive) {
      updatePrefs({ activeSearchCredentialId: meta.id });
    }
    const activeId = getPrefs().activeSearchCredentialId;
    return c.json(payloadFor(meta, activeId), 201);
  });

  r.delete("/:id", (c) => {
    const id = c.req.param("id");
    const meta = getSearchCredentialMeta(id);
    if (!meta) return c.json({ error: "credential not found" }, 404);
    const prefs = getPrefs();
    const wasActive = prefs.activeSearchCredentialId === id;
    const removedProvider = deleteSearchCredential(id);
    if (wasActive) {
      const nextId = pickNextActiveSearchId(removedProvider);
      updatePrefs({ activeSearchCredentialId: nextId });
    }
    return c.json({
      id,
      deleted: true,
      activeId: getPrefs().activeSearchCredentialId,
    });
  });

  return r;
}
