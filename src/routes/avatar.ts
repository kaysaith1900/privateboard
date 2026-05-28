/**
 * /api/avatar — server-side avatar seed generation.
 *
 * The 3D portrait itself is rendered client-side by Avatar3DSnap
 * (public/avatar-3d-snap.js) so the visual style stays consistent
 * across surfaces. This endpoint just turns a director's name+bio
 * into a "vibe seed" via the LLM so the resulting avatar reflects
 * the persona instead of being a hash of name+bio.
 *
 * No LLM key configured? Falls back to a deterministic seed so the UI
 * always works even without API keys.
 */
import { Hono } from "hono";

import { callLLM } from "../ai/adapter.js";
import { utilityModelFor } from "../ai/availability.js";

const NAME_MAX = 80;
const BIO_MAX = 400;
const VIBE_MAX = 200;

export function avatarRouter() {
  const r = new Hono();

  r.post("/generate", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const b = (body ?? {}) as { name?: unknown; bio?: unknown };
    const name = (typeof b.name === "string" ? b.name : "").trim().slice(0, NAME_MAX);
    const bio = (typeof b.bio === "string" ? b.bio : "").trim().slice(0, BIO_MAX);
    if (!name) return c.json({ error: "name required" }, 400);

    // Default fallback · deterministic seed if the LLM call doesn't
    // land. A timestamp suffix makes successive clicks vary even
    // when name+bio haven't changed.
    let seed = `${name}|${bio}|${Date.now().toString(36)}`;
    let vibe = "";
    let usedLLM = false;

    // Cheap-tier model picker · adapts to user's keys (haiku /
    // gpt-4-mini / gemini-flash / grok-fast). The previous hardcoded
    // "haiku-4-5" silently fell through to the deterministic seed for
    // anyone without an Anthropic / OpenRouter key.
    const utilityModel = utilityModelFor();
    try {
      if (!utilityModel) throw new Error("no utility-tier model reachable");
      const out = await callLLM({
        modelV: utilityModel,
        temperature: 0.95,
        maxTokens: 60,
        messages: [
          {
            role: "user",
            content:
              "Imagine an 8-bit pixel-art avatar for this character. " +
              "Reply with a single short comma-separated list of visual traits (hair color, hair style, skin tone, eye color, shirt color, overall vibe). " +
              "One line. Max 12 words. No prose.\n\n" +
              `Name: ${name}\nBio: ${bio}`,
          },
        ],
      });
      vibe = String(out || "").trim().replace(/\s+/g, " ").slice(0, VIBE_MAX);
      if (vibe) {
        // The vibe becomes the deterministic seed for Avatar3DSnap on
        // the client. Same vibe → same avatar; LLM gives the variation.
        seed = `${name}::${vibe}`;
        usedLLM = true;
      }
    } catch (e) {
      // Swallow — caller falls back to the deterministic seed above.
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[avatar] LLM call failed (using deterministic seed): ${msg}\n`);
    }

    return c.json({ seed, vibe, usedLLM });
  });

  return r;
}
