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
  deleteKey,
  listKeyMeta,
  setKey,
  type Provider,
  type ProviderKeyMeta,
} from "../storage/keys.js";
import { updatePrefs } from "../storage/prefs.js";
import {
  PRIMARY_BY_CARRIER,
  reconcileAgentModels,
} from "../storage/reconcile-models.js";

const PROVIDERS = new Set<Provider>([
  "openrouter",
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "brave",
]);

function isProvider(s: string): s is Provider {
  return PROVIDERS.has(s as Provider);
}

export function keysRouter(): Hono {
  const r = new Hono();

  // GET /api/keys → list all providers, configured or not. Each entry
  // carries `preview` (4+4 mask of the stored key) so the UI can show
  // which key is in which slot without ever round-tripping plaintext.
  r.get("/", (c) => {
    const meta = listKeyMeta();
    const map = new Map<Provider, ProviderKeyMeta>();
    for (const m of meta) map.set(m.provider, m);
    const out = Array.from(PROVIDERS).map((p) =>
      map.get(p) ?? { provider: p, configured: false, updatedAt: null, preview: null },
    );
    return c.json({ keys: out });
  });

  r.put("/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.json({ error: "unknown provider" }, 400);

    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }

    const key = (body as { key?: unknown })?.key;
    if (typeof key !== "string") return c.json({ error: "body must contain { key: string }" }, 400);

    // Optional · onboarding sends `makeDefault: true` to signal "the
    // user just picked this provider as their primary." Without this,
    // a user who already had OpenRouter configured and adds Gemini
    // would see reconcile keep `opus-4-7` (still reachable via OR)
    // even though they clearly intended Gemini as the new default.
    // Setting `prefs.defaultModelV` to the new provider's flagship
    // before reconcile flips the active carrier, and reconcile then
    // switches every agent to that carrier's primary.
    const makeDefault = (body as { makeDefault?: unknown })?.makeDefault === true;

    setKey(provider, key);
    // Reconcile every agent's modelV against the new key set · LLM
    // providers only (skill providers like Brave don't affect chair
    // / director routing). When an agent's model becomes unreachable
    // it switches to the active carrier's primary; brand-new key on
    // a clean install bulk-promotes all agents to that primary.
    if (provider !== "brave") {
      const willForce = makeDefault && key.trim().length > 0;
      if (willForce) {
        const flagship = PRIMARY_BY_CARRIER[provider];
        if (flagship) {
          try { updatePrefs({ defaultModelV: flagship }); }
          catch (e) { process.stderr.write(`[keys.put] updatePrefs failed: ${e instanceof Error ? e.message : String(e)}\n`); }
        }
      }
      try { reconcileAgentModels({ forcePrimary: willForce }); }
      catch (e) { process.stderr.write(`[keys.put] reconcile failed: ${e instanceof Error ? e.message : String(e)}\n`); }
    }
    // Re-derive the meta (preview included) so the PUT response matches
    // the GET shape — frontend caches it directly into its keys map.
    const fresh = listKeyMeta().find((m) => m.provider === provider);
    return c.json(
      fresh ?? { provider, configured: key.trim().length > 0, updatedAt: Date.now(), preview: null },
    );
  });

  r.delete("/:provider", (c) => {
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.json({ error: "unknown provider" }, 400);
    deleteKey(provider);
    // Reconcile · agents whose model just lost its only carrier swap
    // to the new active primary, or get cleared if all carriers are
    // gone. Brave is skill-only and doesn't affect agent routing.
    if (provider !== "brave") {
      try { reconcileAgentModels(); }
      catch (e) { process.stderr.write(`[keys.delete] reconcile failed: ${e instanceof Error ? e.message : String(e)}\n`); }
    }
    return c.json({ provider, configured: false, updatedAt: null, preview: null });
  });

  return r;
}
