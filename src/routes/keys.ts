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
  getKey,
  listKeyMeta,
  setKey,
  type Provider,
  type ProviderKeyMeta,
} from "../storage/keys.js";
import { listAllAgents, updateAgent, type AgentVoiceProfile } from "../storage/agents.js";
import { listConfiguredVoices } from "../voice/registry.js";

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

/** Reassign a random voice to EVERY agent · fired when the user
 *  transitions from 0 → 1 configured voice providers. The pool is
 *  restricted to the just-added provider's voices so we don't mix
 *  MiniMax + ElevenLabs before the user has explicitly chosen.
 *  Voices are Fisher-Yates shuffled then drawn in order, so up to
 *  pool.length agents get distinct voices; agents beyond that wrap
 *  the same shuffled order (collisions only when there are more
 *  directors than entries in the static voice list).
 *
 *  Why we re-shuffle every agent (not just `voice == null`): seeded
 *  agents ship with a default voice profile, so a filter that
 *  skipped non-null voices would leave every director on the same
 *  default — defeating the purpose of "let everyone sound
 *  different out of the box." Gated to the 0→1 voice-key
 *  transition only, so users who already had a voice key and
 *  manually tuned voices (which required having a key first) are
 *  never retroactively overwritten. */
function autoAssignVoicesOnFirstKey(provider: Provider): void {
  if (provider !== "minimax" && provider !== "elevenlabs") return;
  const pool = listConfiguredVoices().filter((v) => v.provider === provider);
  if (pool.length === 0) return;

  const agents = listAllAgents();
  if (agents.length === 0) return;

  // Fisher-Yates shuffle a copy of the pool.
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (let i = 0; i < agents.length; i++) {
    const v = shuffled[i % shuffled.length];
    // Preserve any speed/pitch/emotion tweaks the user has already
    // made — we're swapping the underlying voice, not nuking the
    // whole profile. The fine-tune values still translate
    // reasonably to a new voice in the same provider family.
    const prev = agents[i].voice;
    const profile: AgentVoiceProfile = {
      provider: v.provider,
      model: v.model,
      voiceId: v.voiceId,
      ...(prev?.speed !== undefined ? { speed: prev.speed } : {}),
      ...(prev?.pitch !== undefined ? { pitch: prev.pitch } : {}),
      ...(prev?.volume !== undefined ? { volume: prev.volume } : {}),
      ...(prev?.emotion !== undefined ? { emotion: prev.emotion } : {}),
    };
    try { updateAgent(agents[i].id, { voice: profile }); }
    catch (e) {
      process.stderr.write(
        `[keys.put] auto-assign voice failed for ${agents[i].id}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
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

    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }

    const key = (body as { key?: unknown })?.key;
    if (typeof key !== "string") return c.json({ error: "body must contain { key: string }" }, 400);

    // Snapshot whether ANY voice provider was configured BEFORE the
    // setKey call · used downstream to detect the 0→1 transition that
    // triggers the per-agent voice auto-assignment. Read first so the
    // setKey side-effect doesn't pollute the comparison.
    const hadAnyVoiceKeyBefore = !!getKey("minimax") || !!getKey("elevenlabs");

    setKey(provider, key);

    // Voice-key onboarding · when the user's FIRST voice provider key
    // lands (none → one), seed every existing agent's voice profile
    // with a random pick from that provider's voices so the deck of
    // directors immediately feels distinguishable in TTS without
    // forcing the user to assign each one manually. Subsequent voice-
    // key adds (e.g. user already had MiniMax, now adding ElevenLabs)
    // do NOT re-shuffle — that would overwrite explicit user picks.
    if ((provider === "minimax" || provider === "elevenlabs") && key.trim().length > 0 && !hadAnyVoiceKeyBefore) {
      try { autoAssignVoicesOnFirstKey(provider); }
      catch (e) { process.stderr.write(`[keys.put] voice auto-assign failed: ${e instanceof Error ? e.message : String(e)}\n`); }
    }

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
    deleteKey(provider);
    return c.json({ provider, configured: false, updatedAt: null, preview: null });
  });

  return r;
}
