import { Hono } from "hono";

import { listAvailableVoices } from "../voice/registry.js";
import { cleanForSpeech, synthesizeSpeech, voiceProfileForAgent } from "../voice/tts.js";
import { getAgent, getChairAgent } from "../storage/agents.js";
import { getMessage } from "../storage/messages.js";
import type { AgentVoiceProfile } from "../storage/agents.js";

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

  r.get("/", async (c) => c.json({ voices: await listAvailableVoices() }));

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
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
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
      const msg = e instanceof Error ? e.message : String(e);
      // Heuristic: missing key surfaces as a fetch error to the
      // provider domain. The frontend uses the `code` to decide
      // whether to deep-link to settings.
      const isNoKey = /401|403|api[\s-]?key|unauthor/i.test(msg);
      return c.json({
        error: msg,
        code: isNoKey ? "no-key" : "tts-error",
        provider: profile.provider,
      }, 502);
    }
  });

  return r;
}
