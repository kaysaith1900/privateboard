import { Hono } from "hono";

import { listAvailableVoices } from "../voice/registry.js";
import { synthesizeSpeech } from "../voice/tts.js";
import type { AgentVoiceProfile } from "../storage/agents.js";

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

  return r;
}
