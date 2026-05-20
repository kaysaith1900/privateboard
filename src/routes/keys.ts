/**
 * /api/keys · provider key management.
 *
 *   GET    /api/keys           → array of { provider, configured, updatedAt }
 *   PUT    /api/keys/:provider → set the key (body { key: "..." })
 *   DELETE /api/keys/:provider → remove
 *
 * The plaintext key is never returned over the wire — even to localhost — so
 * the UI shows status pills only, and the user must paste a fresh value to
 * change it. `configured` reflects whether a non-empty value is stored.
 */
import { Hono } from "hono";

import {
  ALL_LLM_PROVIDERS,
  MULTI_MODEL_LLM_PROVIDERS,
  SINGLE_MODEL_LLM_PROVIDERS,
  isLlmProvider,
} from "../ai/providers.js";
import {
  deleteKey,
  listKeyMeta,
  setKey,
  type Provider,
  type ProviderKeyMeta,
} from "../storage/keys.js";

const PROVIDERS = new Set<Provider>([
  ...(ALL_LLM_PROVIDERS as readonly Provider[]),
  // `deepseek` lives in the storage Provider union for type-compat
  // with the model registry; no @ai-sdk client routes through it, so
  // the row is accepted but unused.
  "deepseek",
  "minimax",
  "elevenlabs",
  "brave",
  "tavily",
]);

function isProvider(s: string): s is Provider {
  return PROVIDERS.has(s as Provider);
}

export function keysRouter(): Hono {
  const r = new Hono();

  // GET /api/keys → list all providers, configured or not. Each entry
  // carries `preview` (4+4 mask of the stored key) so the UI can show
  // which key is in which slot without ever round-tripping plaintext.
  //
  // `classification` is the wire-side projection of `src/ai/providers.ts`
  // — the frontend renders LLM cards as two rows (multi-model on top,
  // single-model below). Voice / skill keys remain multi-key by design
  // and live in their own arrays. Older frontends ignore the field.
  r.get("/", (c) => {
    const meta = listKeyMeta();
    const map = new Map<Provider, ProviderKeyMeta>();
    for (const m of meta) map.set(m.provider, m);
    const out = Array.from(PROVIDERS).map((p) =>
      map.get(p) ?? { provider: p, configured: false, updatedAt: null, preview: null },
    );
    return c.json({
      keys: out,
      classification: {
        multiModel: [...MULTI_MODEL_LLM_PROVIDERS],
        singleModel: [...SINGLE_MODEL_LLM_PROVIDERS],
        voice: ["minimax", "elevenlabs"] as const,
        skill: ["brave", "tavily"] as const,
      },
    });
  });

  r.put("/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.json({ error: "unknown provider" }, 400);

    // LLM providers no longer live in `provider_keys` — they're routed
    // through `/api/credentials` (multi-instance, with user-supplied
    // labels). Reject so older clients don't quietly write to a table
    // that's no longer the source of truth.
    if (isLlmProvider(provider)) {
      return c.json({ error: "LLM providers use POST /api/credentials" }, 410);
    }

    // Voice providers similarly migrated · all voice TTS credentials
    // route through `/api/voice-credentials` (multi-instance, with
    // user-supplied labels and a single-active pointer in prefs).
    // Reject so legacy callers don't write to a row that no longer
    // exists in `provider_keys` (migration 049 deletes them).
    if (provider === "minimax" || provider === "elevenlabs") {
      return c.json({ error: "voice providers use POST /api/voice-credentials" }, 410);
    }

    // Search providers similarly migrated · brave/tavily credentials
    // now route through `/api/search-credentials` (multi-instance,
    // user-supplied labels, single-active pointer in prefs). Reject
    // legacy callers writing here · migration 051 deletes the rows.
    if (provider === "brave" || provider === "tavily") {
      return c.json({ error: "search providers use POST /api/search-credentials" }, 410);
    }

    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }

    const key = (body as { key?: unknown })?.key;
    if (typeof key !== "string") return c.json({ error: "body must contain { key: string }" }, 400);

    setKey(provider, key);

    const fresh = listKeyMeta().find((m) => m.provider === provider);
    return c.json(
      fresh ?? { provider, configured: key.trim().length > 0, updatedAt: Date.now(), preview: null },
    );
  });

  r.delete("/:provider", (c) => {
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.json({ error: "unknown provider" }, 400);
    if (isLlmProvider(provider)) {
      return c.json({ error: "LLM providers use DELETE /api/credentials/:id" }, 410);
    }
    if (provider === "minimax" || provider === "elevenlabs") {
      return c.json({ error: "voice providers use DELETE /api/voice-credentials/:id" }, 410);
    }
    if (provider === "brave" || provider === "tavily") {
      return c.json({ error: "search providers use DELETE /api/search-credentials/:id" }, 410);
    }
    deleteKey(provider);
    return c.json({ provider, configured: false, updatedAt: null, preview: null });
  });

  return r;
}
