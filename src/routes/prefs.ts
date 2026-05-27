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

import { parseAvatar3d } from "../storage/agents.js";
import { getPrefs, updatePrefs, type PrefsPatch, type WebSearchProviderPref, type MinimaxRegion } from "../storage/prefs.js";

// The user's 3D-avatar portrait is a rendered PNG; the legacy 8-bit avatar is
// an inline SVG. Accept either as a data URL (or null to clear).
const AVATAR_URL_RE = /^data:image\/(png|svg\+xml)[;,]/i;

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
    if ("avatar3d" in b) {
      if (b.avatar3d === null) {
        patch.avatar3d = null;
      } else {
        const parsed = parseAvatar3d(JSON.stringify(b.avatar3d));
        if (!parsed) return c.json({ error: "invalid avatar3d config" }, 400);
        patch.avatar3d = parsed;
      }
    }
    if (b.avatarUrl === null) {
      patch.avatarUrl = null;
    } else if (typeof b.avatarUrl === "string") {
      if (!AVATAR_URL_RE.test(b.avatarUrl)) return c.json({ error: "invalid avatarUrl" }, 400);
      patch.avatarUrl = b.avatarUrl;
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
