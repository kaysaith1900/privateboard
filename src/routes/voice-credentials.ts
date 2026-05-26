/**
 * /api/voice-credentials · TTS voice credentials (multi-instance).
 *
 *   GET    /api/voice-credentials         → list every voice credential
 *   POST   /api/voice-credentials         → create a new credential
 *   DELETE /api/voice-credentials/:id     → remove (auto-rotates active)
 *   PUT    /api/voice-credentials/active  → switch which credential is active
 *
 * Mirrors `src/routes/credentials.ts` (LLM) · same shape, same patterns,
 * same first-credential auto-activation rule. Provider-switch (a switch
 * that crosses provider boundaries — e.g. MiniMax → ElevenLabs) triggers
 * `reconcileAgentVoices` so every agent's stored voice id is dragged back
 * onto the new provider's catalog. Same-provider switches (MiniMax-A →
 * MiniMax-B) are no-ops for the reshuffle path · voice ids are stable per
 * provider.
 *
 * Plaintext keys never leave the server — responses carry the `preview`
 * mask (4+4) only.
 */
import { Hono } from "hono";

import { getPrefs, updatePrefs } from "../storage/prefs.js";
import { reconcileAgentVoices } from "../storage/reconcile-voices.js";
import {
  ALL_VOICE_PROVIDERS,
  VOICE_PROVIDER_PRIORITY,
  createVoiceCredential,
  deleteVoiceCredential,
  getVoiceCredentialMeta,
  isVoiceProvider,
  listVoiceCredentials,
  type VoiceCredentialMeta,
  type VoiceProvider,
} from "../storage/voice-credentials.js";

void ALL_VOICE_PROVIDERS;

interface VoiceCredentialPayload {
  id: string;
  provider: VoiceProvider;
  label: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  /** True when this credential is the one currently routed through. */
  isActive: boolean;
}

function payloadFor(meta: VoiceCredentialMeta, activeId: string | null): VoiceCredentialPayload {
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
 *  Priority: same provider first (so swapping to a sibling MiniMax key is
 *  preferred over jumping to a different provider), then
 *  VOICE_PROVIDER_PRIORITY order, then creation time. Returns null when no
 *  credentials remain. */
function pickNextActiveVoiceId(removedProvider: VoiceProvider | null): string | null {
  const all = listVoiceCredentials();
  if (all.length === 0) return null;
  if (removedProvider) {
    const sameProvider = all.filter((c) => c.provider === removedProvider);
    if (sameProvider.length > 0) {
      sameProvider.sort((a, b) => a.createdAt - b.createdAt);
      return sameProvider[0].id;
    }
  }
  const sorted = all.slice().sort((a, b) => {
    const ai = VOICE_PROVIDER_PRIORITY.indexOf(a.provider);
    const bi = VOICE_PROVIDER_PRIORITY.indexOf(b.provider);
    if (ai !== bi) return ai - bi;
    return a.createdAt - b.createdAt;
  });
  return sorted[0]?.id ?? null;
}

export function voiceCredentialsRouter(): Hono {
  const r = new Hono();

  r.get("/", (c) => {
    const activeId = getPrefs().activeVoiceCredentialId;
    const items = listVoiceCredentials().map((m) => payloadFor(m, activeId));
    return c.json({
      credentials: items,
      activeId: activeId,
    });
  });

  // PUT /api/voice-credentials/active · switch the active credential.
  // Mounted BEFORE the parametric DELETE handler so Hono's matcher picks
  // this route first when the path happens to be `/active`.
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

    const prefs = getPrefs();
    const priorActiveId = prefs.activeVoiceCredentialId;
    const priorProvider = priorActiveId
      ? getVoiceCredentialMeta(priorActiveId)?.provider ?? null
      : null;

    let nextProvider: VoiceProvider | null = null;
    if (nextId) {
      const meta = getVoiceCredentialMeta(nextId);
      if (!meta) return c.json({ error: "credential not found" }, 404);
      nextProvider = meta.provider;
      updatePrefs({ activeVoiceCredentialId: nextId });
    } else {
      updatePrefs({ activeVoiceCredentialId: null });
    }

    // Same-provider switches don't reshuffle voices · voice ids are
    // stable per provider. Cross-provider switches AND "switch to null"
    // both go through reconcile (the latter clears every agent's voice).
    // SIM-swap memory · pass priorProvider so reconcile snapshots every
    // agent's current voice into bucket[priorProvider] before overwriting.
    if (priorProvider !== nextProvider) {
      try { reconcileAgentVoices({ reason: "provider-switch", priorProvider }); }
      catch (e) {
        process.stderr.write(
          `[voice-credentials.active] reconcile failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
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
    if (typeof provider !== "string" || !isVoiceProvider(provider)) {
      return c.json({ error: "provider must be 'minimax' or 'elevenlabs'" }, 400);
    }
    if (typeof key !== "string" || key.trim().length === 0) {
      return c.json({ error: "key must be a non-empty string" }, 400);
    }
    const label = typeof labelRaw === "string" ? labelRaw : null;
    const meta = createVoiceCredential(provider, label, key);
    if (!meta) return c.json({ error: "failed to create credential" }, 500);

    // Activation policy:
    //   · No active credential yet → activate (first-key) + reconcile so
    //     a fresh install has a provider to dispatch against.
    //   · Active credential is the SAME provider → activate the new one.
    //     This is a key rotation / region switch (e.g. swapping a MiniMax
    //     CN key for an `intl` one after toggling minimaxRegion). The
    //     button literally says "Save & activate", and leaving the old
    //     key active silently sends it to the new region's host →
    //     1004 "login fail". Same provider ⇒ director voice_ids stay
    //     valid, so no reconcile is needed — just point at the new key.
    //   · Active credential is a DIFFERENT provider → do NOT take over,
    //     so adding a secondary provider's key never clobbers the user's
    //     configured voice provider + director voices. They switch
    //     manually via the credential list.
    const priorActiveId = getPrefs().activeVoiceCredentialId;
    const priorActive = priorActiveId ? getVoiceCredentialMeta(priorActiveId) : null;
    if (!priorActive) {
      updatePrefs({ activeVoiceCredentialId: meta.id });
      try { reconcileAgentVoices({ reason: "first-key", priorProvider: null }); }
      catch (e) {
        process.stderr.write(
          `[voice-credentials.post] reconcile failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    } else if (priorActive.provider === provider) {
      updatePrefs({ activeVoiceCredentialId: meta.id });
    }
    const activeId = getPrefs().activeVoiceCredentialId;
    return c.json(payloadFor(meta, activeId), 201);
  });

  r.delete("/:id", (c) => {
    const id = c.req.param("id");
    const meta = getVoiceCredentialMeta(id);
    if (!meta) return c.json({ error: "credential not found" }, 404);
    const prefs = getPrefs();
    const wasActive = prefs.activeVoiceCredentialId === id;
    const removedProvider = deleteVoiceCredential(id);

    let reshuffled = false;
    if (wasActive) {
      const nextId = pickNextActiveVoiceId(removedProvider);
      updatePrefs({ activeVoiceCredentialId: nextId });
      // Reshuffle when the rotation crossed providers OR when there's
      // no replacement credential (active=null clears every agent's
      // voice profile so synthesis falls back to browser).
      const nextProvider = nextId
        ? getVoiceCredentialMeta(nextId)?.provider ?? null
        : null;
      if (nextProvider !== removedProvider) {
        // SIM-swap memory · removedProvider was the active provider
        // before this delete (wasActive guard). Pass it as priorProvider
        // so reconcile snapshots every agent's current voice into
        // bucket[removedProvider] before clearing / reshuffling — a
        // subsequent add-back-and-switch round-trip restores them.
        try {
          reconcileAgentVoices({ reason: "provider-switch", priorProvider: removedProvider });
          reshuffled = true;
        }
        catch (e) {
          process.stderr.write(
            `[voice-credentials.delete] reconcile failed: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }
    }
    return c.json({
      id,
      deleted: true,
      activeId: getPrefs().activeVoiceCredentialId,
      reshuffled,
    });
  });

  return r;
}
