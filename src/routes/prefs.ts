/**
 * /api/prefs · the user's local profile (name, intro, avatar seed,
 * default model, search-provider + minimax-region prefs).
 * Single-row resource — there's no list, just GET + PATCH.
 *
 * Note: appearance (dark / light / system) is purely client-side —
 * it lives in localStorage so the FOUC bootstrap can apply it
 * synchronously before paint. No round-trip here.
 */
import { Hono } from "hono";

import { getPrefs, updatePrefs, type PrefsPatch, type WebSearchProviderPref, type MinimaxRegion } from "../storage/prefs.js";

export function prefsRouter(): Hono {
  const r = new Hono();

  r.get("/", (c) => c.json(getPrefs()));

  // PATCH-style: only fields present in the body are updated.
  r.put("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object") {
      return c.json({ error: "body must be an object" }, 400);
    }

    const patch: PrefsPatch = {};
    const b = body as Record<string, unknown>;

    if (typeof b.name === "string")  patch.name = b.name.trim().slice(0, 64);
    if (typeof b.intro === "string") patch.intro = b.intro.slice(0, 320);
    if (b.avatarSeed === null || typeof b.avatarSeed === "string") {
      patch.avatarSeed = b.avatarSeed as string | null;
    }
    if (b.defaultModelV === null || typeof b.defaultModelV === "string") {
      patch.defaultModelV = b.defaultModelV as string | null;
    }
    if (b.webSearchProvider === "brave" || b.webSearchProvider === "tavily") {
      patch.webSearchProvider = b.webSearchProvider as WebSearchProviderPref;
    }
    if (b.minimaxRegion === "cn" || b.minimaxRegion === "intl") {
      patch.minimaxRegion = b.minimaxRegion as MinimaxRegion;
    }

    return c.json(updatePrefs(patch));
  });

  return r;
}
