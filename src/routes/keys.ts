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
  getKey,
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
import { listAllAgents, updateAgent, type AgentVoiceProfile } from "../storage/agents.js";
import { listConfiguredVoices } from "../voice/registry.js";

const PROVIDERS = new Set<Provider>([
  "openrouter",
  "bai",
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "minimax",
  "elevenlabs",
  "brave",
  "tavily",
]);

/** Provider ids that count toward the "at least one LLM key required"
 *  guardrail. Voice (minimax / elevenlabs) and search (brave / tavily)
 *  keys are independently optional and don't lock removal. */
const LLM_PROVIDERS = new Set<Provider>([
  "openrouter",
  "bai",
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
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

    // Snapshot whether ANY voice provider was configured BEFORE the
    // setKey call · used downstream to detect the 0→1 transition that
    // triggers the per-agent voice auto-assignment. Read first so the
    // setKey side-effect doesn't pollute the comparison.
    const hadAnyVoiceKeyBefore = !!getKey("minimax") || !!getKey("elevenlabs");

    setKey(provider, key);
    // Reconcile every agent's modelV against the new key set · LLM
    // providers only (skill providers like Brave don't affect chair
    // / director routing). When an agent's model becomes unreachable
    // it switches to the active carrier's primary; brand-new key on
    // a clean install bulk-promotes all agents to that primary.
    if (provider !== "brave" && provider !== "tavily" && provider !== "minimax" && provider !== "elevenlabs") {
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

    // Last-LLM-key guardrail · removing the only configured LLM key
    // would strand every director / chair on a model with no usable
    // carrier (and the brief writer / agent-spec generator silently
    // fail). Block the delete and tell the user to add another LLM
    // key first. Voice + search keys aren't gated — they're
    // optional skill services. Removing an UNCONFIGURED LLM row is
    // also fine (it doesn't change the count of working keys).
    if (LLM_PROVIDERS.has(provider)) {
      const allMeta = listKeyMeta();
      const targetConfigured = !!allMeta.find((m) => m.provider === provider && m.configured);
      const configuredLlmCount = allMeta.filter(
        (m) => LLM_PROVIDERS.has(m.provider) && m.configured,
      ).length;
      if (targetConfigured && configuredLlmCount <= 1) {
        return c.json(
          {
            error:
              "Can't remove your only LLM key — add another LLM provider first, then remove this one.",
          },
          409,
        );
      }
    }

    deleteKey(provider);
    // Reconcile · agents whose model just lost its only carrier swap
    // to the new active primary, or get cleared if all carriers are
    // gone. Brave is skill-only and doesn't affect agent routing.
    if (provider !== "brave" && provider !== "tavily" && provider !== "minimax" && provider !== "elevenlabs") {
      try { reconcileAgentModels(); }
      catch (e) { process.stderr.write(`[keys.delete] reconcile failed: ${e instanceof Error ? e.message : String(e)}\n`); }
    }
    return c.json({ provider, configured: false, updatedAt: null, preview: null });
  });

  return r;
}
