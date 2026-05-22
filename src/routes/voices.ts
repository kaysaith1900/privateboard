import { Hono } from "hono";

import { listAvailableVoices, listVoicesPage } from "../voice/registry.js";
import { cleanForSpeech, synthesizeSpeech, voiceProfileForAgent } from "../voice/tts.js";
import { getAgent, getChairAgent } from "../storage/agents.js";
import { getMessage } from "../storage/messages.js";
import type { AgentVoiceProfile } from "../storage/agents.js";
import { getUsableMessageVoice, listRoomVoiceMessageIds } from "../storage/message-voice.js";

/** Unwrap a network-layer fetch error so callers see the actual cause
 *  instead of Node's bare "fetch failed" string. Undici stashes the
 *  real reason on `e.cause` (e.g. `getaddrinfo ENOTFOUND`, `connect
 *  ECONNREFUSED`, `unable to verify the first certificate`); without
 *  this, the user just sees "fetch failed" and can't tell whether
 *  it's DNS, TLS, blocked host, or wrong key.
 *
 *  Stderr logs the full chain (including the cause's code if present)
 *  so server-side diagnosis stays possible even when the response is
 *  trimmed for the UI. */
function ttsErrorMessage(e: unknown, providerLabel: string): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  if (cause && cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    const tail = code ? ` (${String(code)})` : "";
    const full = `${e.message}: ${cause.message}${tail}`;
    process.stderr.write(`[tts-preview] ${providerLabel} fetch error · ${full}\n`);
    return full;
  }
  process.stderr.write(`[tts-preview] ${providerLabel} error · ${e.message}\n`);
  return e.message;
}

/** In-memory LRU cache for per-message TTS audio · keyed by
 *  `${messageId}:${voice fingerprint}`. Caps at ~50 entries so a
 *  long replay session reuses the same audio when the user hits
 *  pause/resume or re-runs replay without paying re-synthesis cost.
 *  Keyed on profile fingerprint so a voice change invalidates. */
const TTS_CACHE_MAX = 50;
const ttsCache = new Map<string, { audioBase64: string; mimeType: string; voiceProvider: string; voiceId: string }>();
function ttsCacheKey(messageId: string, profile: AgentVoiceProfile): string {
  return [
    messageId,
    profile.provider,
    profile.model,
    profile.voiceId,
    profile.speed ?? 1,
    profile.pitch ?? 0,
    profile.volume ?? 1,
    profile.emotion ?? "",
  ].join(":");
}
function ttsCacheGet(key: string) {
  const v = ttsCache.get(key);
  if (!v) return null;
  // Bump to most-recent by re-inserting (Map preserves insertion order).
  ttsCache.delete(key);
  ttsCache.set(key, v);
  return v;
}
function ttsCacheSet(key: string, val: { audioBase64: string; mimeType: string; voiceProvider: string; voiceId: string }) {
  ttsCache.set(key, val);
  if (ttsCache.size > TTS_CACHE_MAX) {
    // Evict oldest (first inserted).
    const first = ttsCache.keys().next().value;
    if (first) ttsCache.delete(first);
  }
}

export function voicesRouter(): Hono {
  const r = new Hono();

  r.get("/", async (c) => {
    // Two response modes share this route:
    //   (A) PAGED · client passes `cursor` and/or `pageSize`. Returns
    //       one chunk of the catalogue + an opaque next-cursor for
    //       infinite-scroll dropdowns. This is what the voice picker
    //       in agent-profile.js uses now (ElevenLabs accounts can
    //       have hundreds of voices · rendering all at once stutters
    //       the UI and serializing a 200-voice JSON inflates the
    //       round-trip).
    //   (B) FULL · client passes neither param. Returns the entire
    //       catalogue in one response · used by voice-replay.js's
    //       availability gate and app.js's voice-label prefetch,
    //       which need a complete map to resolve any voiceId →
    //       friendly label. The 5-minute MiniMax cache absorbs the
    //       repeated full-fetch cost; ElevenLabs walks v2 pages
    //       internally.
    const url = new URL(c.req.url);
    const cursor = url.searchParams.get("cursor");
    const pageSizeRaw = url.searchParams.get("pageSize");
    if (cursor !== null || pageSizeRaw !== null) {
      const pageSize = pageSizeRaw ? Math.max(1, Number.parseInt(pageSizeRaw, 10) || 30) : 30;
      const page = await listVoicesPage(cursor, pageSize);
      return c.json({
        voices: page.voices,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        provider: page.provider,
        configured: page.configured,
        // Structured upstream error · the picker uses this to render
        // a clear "your API key is missing voices_read permission"
        // banner + a link to the ElevenLabs API-key settings page
        // instead of a silently empty dropdown.
        ...(page.error ? { error: page.error } : {}),
      });
    }
    const catalog = await listAvailableVoices();
    return c.json({
      voices: catalog.voices,
      provider: catalog.provider,
      configured: catalog.configured,
    });
  });

  /**
   * Raw MP3 bytes for a message whose live voice stream was persisted
   * (`message_voice` table). 404 when missing or invalidated.
   */
  r.get("/message/:id/audio", (c) => {
    const messageId = c.req.param("id");
    const row = getUsableMessageVoice(messageId);
    if (!row) {
      return c.notFound();
    }
    c.header("Content-Type", row.meta.mimeType || "audio/mpeg");
    c.header("Cache-Control", "no-store");
    return c.body(new Uint8Array(row.audioMp3), 200);
  });

  /** Ordered message IDs in a room that have persisted voice MP3. */
  r.get("/room/:roomId/clips", (c) => {
    const roomId = c.req.param("roomId");
    return c.json({ messageIds: listRoomVoiceMessageIds(roomId) });
  });

  /** Preview/audition a voice configuration — returns base64 MP3 audio. */
  r.post("/preview", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const b = (body ?? {}) as Record<string, unknown>;

    const text = typeof b.text === "string" && b.text.trim()
      ? b.text.trim().slice(0, 200)
      : "你好，我是你的董事会成员，很高兴为你服务。";

    const profile: AgentVoiceProfile = {
      provider: (typeof b.provider === "string" ? b.provider : "minimax") as AgentVoiceProfile["provider"],
      model: typeof b.model === "string" ? b.model : "speech-2.8-hd",
      voiceId: typeof b.voiceId === "string" ? b.voiceId : "male-qn-qingse",
      speed: typeof b.speed === "number" ? b.speed : 1,
      pitch: typeof b.pitch === "number" ? b.pitch : 0,
      volume: typeof b.volume === "number" ? b.volume : 1,
      emotion: typeof b.emotion === "string" ? b.emotion : undefined,
      modifyPitch: typeof b.modifyPitch === "number" ? b.modifyPitch : undefined,
      modifyIntensity: typeof b.modifyIntensity === "number" ? b.modifyIntensity : undefined,
      modifyTimbre: typeof b.modifyTimbre === "number" ? b.modifyTimbre : undefined,
    };

    try {
      const chunk = await synthesizeSpeech(text, profile);
      if (!chunk.audioBase64 || !chunk.mimeType) {
        return c.json({ error: "TTS returned no audio" }, 502);
      }
      return c.json({ audioBase64: chunk.audioBase64, mimeType: chunk.mimeType });
    } catch (e) {
      // Propagate structured fields (code / provider / upgradeUrl) when
      // the synthesizer tagged the error · the client uses these to
      // route into the upgrade-overlay panel instead of a plain alert.
      const tagged = (e ?? {}) as { code?: unknown; provider?: unknown; upgradeUrl?: unknown };
      const payload: Record<string, unknown> = { error: ttsErrorMessage(e, profile.provider) };
      if (typeof tagged.code === "string") payload.code = tagged.code;
      if (typeof tagged.provider === "string") payload.provider = tagged.provider;
      if (typeof tagged.upgradeUrl === "string") payload.upgradeUrl = tagged.upgradeUrl;
      return c.json(payload, 502);
    }
  });

  /** Per-message TTS · powers the adjourned-room voice replay.
   *  Resolves messageId → author → voice profile, calls the buffered
   *  synthesizer, returns base64 MP3. User messages are spoken with
   *  the chair's voice when `asUser: true` is passed (the chair is a
   *  reasonable narrator since no per-user voice profile exists).
   *
   *  Body (all optional):
   *    { asUser?: boolean }   // read user message via chair's voice
   *
   *  Response:
   *    { audioBase64, mimeType, voiceProvider, voiceId }
   *  Errors return 4xx/5xx with a `code` so the frontend can route
   *  "no key configured" → settings deep-link.
   */
  r.post("/by-message/:id", async (c) => {
    const messageId = c.req.param("id");
    const message = getMessage(messageId);
    if (!message) return c.json({ error: "message not found", code: "not-found" }, 404);

    const cleanedText = cleanForSpeech(message.body || "").trim();
    if (!cleanedText) {
      return c.json({ error: "message has no speakable content", code: "empty" }, 422);
    }

    let body: unknown = {};
    try { body = await c.req.json(); } catch { /* empty body OK */ }
    const asUser = !!(body && typeof body === "object" && (body as { asUser?: unknown }).asUser);

    // Resolve voice profile · directors / chair use their stored
    // profile (or default fallback by key precedence). User messages
    // borrow the chair's voice when the caller opts in.
    let profile: AgentVoiceProfile;
    if (message.authorKind === "user" || asUser) {
      const chair = getChairAgent();
      if (!chair) return c.json({ error: "chair agent missing · can't read user message", code: "no-chair" }, 500);
      profile = voiceProfileForAgent(chair);
    } else if (message.authorKind === "agent" && message.authorId) {
      const agent = getAgent(message.authorId);
      if (!agent) return c.json({ error: "author agent missing", code: "no-author" }, 404);
      profile = voiceProfileForAgent(agent);
    } else {
      return c.json({ error: "system messages aren't speakable", code: "system" }, 422);
    }

    // Prefer audio captured during the live voice meeting (same bytes the
    // user heard), when still valid for current body + voice profile.
    const persisted = getUsableMessageVoice(messageId);
    if (persisted) {
      const out = {
        audioBase64: persisted.audioMp3.toString("base64"),
        mimeType: persisted.meta.mimeType || "audio/mpeg",
        voiceProvider: persisted.meta.voice.provider,
        voiceId: persisted.meta.voice.voiceId,
      };
      const key = ttsCacheKey(messageId, profile);
      ttsCacheSet(key, {
        audioBase64: out.audioBase64,
        mimeType: out.mimeType,
        voiceProvider: out.voiceProvider,
        voiceId: out.voiceId,
      });
      return c.json(out);
    }

    // Cache check.
    const key = ttsCacheKey(messageId, profile);
    const cached = ttsCacheGet(key);
    if (cached) return c.json(cached);

    try {
      const chunk = await synthesizeSpeech(cleanedText, profile);
      if (!chunk.audioBase64 || !chunk.mimeType) {
        return c.json({
          error: "TTS returned no audio",
          code: "no-audio",
          provider: profile.provider,
        }, 502);
      }
      const out = {
        audioBase64: chunk.audioBase64,
        mimeType: chunk.mimeType,
        voiceProvider: profile.provider,
        voiceId: profile.voiceId,
      };
      ttsCacheSet(key, out);
      return c.json(out);
    } catch (e) {
      // Preserve structured tagging (paid-plan-required + upgradeUrl)
      // when the synthesizer threw a billing-class error · the frontend
      // routes those into the upgrade overlay. Earlier this catch
      // overwrote `code` with a heuristic and discarded `upgradeUrl`,
      // so insufficient-balance failures landed as plain "tts-error"
      // with no actionable affordance.
      const tagged = (e ?? {}) as { code?: unknown; provider?: unknown; upgradeUrl?: unknown };
      const msg = ttsErrorMessage(e, profile.provider);
      const isNoKey = /401|403|api[\s-]?key|unauthor/i.test(msg);
      const payload: Record<string, unknown> = {
        error: msg,
        provider: typeof tagged.provider === "string" ? tagged.provider : profile.provider,
      };
      if (typeof tagged.code === "string") {
        payload.code = tagged.code;
      } else {
        payload.code = isNoKey ? "no-key" : "tts-error";
      }
      if (typeof tagged.upgradeUrl === "string") {
        payload.upgradeUrl = tagged.upgradeUrl;
      }
      return c.json(payload, 502);
    }
  });

  return r;
}
