/**
 * /api/credentials · LLM provider credentials (multi-instance).
 *
 *   GET    /api/credentials           → list every LLM credential
 *   POST   /api/credentials           → create a new credential
 *   DELETE /api/credentials/:id       → remove (auto-rotates active)
 *   PUT    /api/credentials/active    → switch which credential is active
 *
 * Plaintext keys never leave the server — responses carry the `preview`
 * mask (4+4) only.
 */
import { Hono } from "hono";

import { isLlmProvider, LLM_PROVIDER_PRIORITY, type LlmProvider } from "../ai/providers.js";
import {
  createLlmCredential,
  deleteLlmCredential,
  getLlmCredentialMeta,
  listLlmCredentials,
} from "../storage/credentials.js";
import { getPrefs, updatePrefs } from "../storage/prefs.js";
import { PRIMARY_BY_CARRIER, reconcileAgentModels } from "../storage/reconcile-models.js";

interface CredentialPayload {
  id: string;
  provider: LlmProvider;
  label: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  /** True when this credential is the one currently routed through. */
  isActive: boolean;
}

function payloadFor(meta: ReturnType<typeof listLlmCredentials>[number], activeId: string | null): CredentialPayload {
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

/** Resolve the next-highest-priority credential after deleting `removed`.
 *  Priority: same provider first (so swapping to a sibling B.AI key is
 *  preferred over jumping to a different provider), then LLM_PROVIDER_PRIORITY
 *  order, then creation time. Returns null when no credentials remain. */
function pickNextActiveId(removedProvider: LlmProvider | null): string | null {
  const all = listLlmCredentials();
  if (all.length === 0) return null;
  // Prefer same provider as the removed active (multiple OpenRouter
  // accounts: removing one rolls to another OpenRouter key, not to a
  // foreign provider).
  if (removedProvider) {
    const sameProvider = all.filter((c) => c.provider === removedProvider);
    if (sameProvider.length > 0) {
      sameProvider.sort((a, b) => a.createdAt - b.createdAt);
      return sameProvider[0].id;
    }
  }
  // Otherwise · priority order, then by createdAt.
  const sorted = all.slice().sort((a, b) => {
    const ai = LLM_PROVIDER_PRIORITY.indexOf(a.provider);
    const bi = LLM_PROVIDER_PRIORITY.indexOf(b.provider);
    if (ai !== bi) return ai - bi;
    return a.createdAt - b.createdAt;
  });
  return sorted[0]?.id ?? null;
}

export function credentialsRouter(): Hono {
  const r = new Hono();

  r.get("/", (c) => {
    const activeId = getPrefs().activeLlmCredentialId;
    const items = listLlmCredentials().map((m) => payloadFor(m, activeId));
    return c.json({
      credentials: items,
      activeId: activeId,
    });
  });

  // PUT /api/credentials/active · switch the active credential. Mounted
  // BEFORE the parametric DELETE handler so Hono's matcher picks this
  // route first when the path happens to be `/active`.
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
      const meta = getLlmCredentialMeta(nextId);
      if (!meta) return c.json({ error: "credential not found" }, 404);
      updatePrefs({ activeLlmCredentialId: nextId });
      const flagship = PRIMARY_BY_CARRIER[meta.provider];
      if (flagship) updatePrefs({ defaultModelV: flagship });
    } else {
      updatePrefs({ activeLlmCredentialId: null });
    }
    try { reconcileAgentModels({ forcePrimary: true }); }
    catch (e) { process.stderr.write(`[credentials.active] reconcile failed: ${e instanceof Error ? e.message : String(e)}\n`); }
    return c.json({ activeId: nextId });
  });

  r.post("/", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }
    const provider = (body as { provider?: unknown })?.provider;
    const labelRaw = (body as { label?: unknown })?.label;
    const key = (body as { key?: unknown })?.key;
    if (typeof provider !== "string" || !isLlmProvider(provider)) {
      return c.json({ error: "provider must be a known LLM slug" }, 400);
    }
    if (typeof key !== "string" || key.trim().length === 0) {
      return c.json({ error: "key must be a non-empty string" }, 400);
    }
    const label = typeof labelRaw === "string" ? labelRaw : null;
    const meta = createLlmCredential(provider, label, key);
    if (!meta) return c.json({ error: "failed to create credential" }, 500);
    // Newly-added credential auto-activates · paste = intent to use.
    updatePrefs({ activeLlmCredentialId: meta.id });
    const flagship = PRIMARY_BY_CARRIER[provider];
    if (flagship) updatePrefs({ defaultModelV: flagship });
    try { reconcileAgentModels({ forcePrimary: true }); }
    catch (e) { process.stderr.write(`[credentials.post] reconcile failed: ${e instanceof Error ? e.message : String(e)}\n`); }
    const activeId = getPrefs().activeLlmCredentialId;
    return c.json(payloadFor(meta, activeId), 201);
  });

  r.delete("/:id", (c) => {
    const id = c.req.param("id");
    const meta = getLlmCredentialMeta(id);
    if (!meta) return c.json({ error: "credential not found" }, 404);
    const prefs = getPrefs();
    const wasActive = prefs.activeLlmCredentialId === id;
    const removedProvider = deleteLlmCredential(id);
    if (wasActive) {
      const nextId = pickNextActiveId(removedProvider);
      updatePrefs({ activeLlmCredentialId: nextId });
      if (nextId) {
        const nextMeta = getLlmCredentialMeta(nextId);
        if (nextMeta) {
          const flagship = PRIMARY_BY_CARRIER[nextMeta.provider];
          if (flagship) updatePrefs({ defaultModelV: flagship });
        }
      } else {
        updatePrefs({ defaultModelV: null });
      }
    }
    try { reconcileAgentModels(wasActive ? { forcePrimary: true } : undefined); }
    catch (e) { process.stderr.write(`[credentials.delete] reconcile failed: ${e instanceof Error ? e.message : String(e)}\n`); }
    return c.json({ id, deleted: true, activeId: getPrefs().activeLlmCredentialId });
  });

  return r;
}
