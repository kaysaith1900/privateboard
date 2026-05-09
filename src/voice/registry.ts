import { getKey } from "../storage/keys.js";
import { getPrefs } from "../storage/prefs.js";

export interface VoiceOption {
  provider: "openai" | "minimax" | "elevenlabs" | "browser";
  model: string;
  voiceId: string;
  label: string;
  language?: string;
  configured: boolean;
}

function minimaxBaseUrl(): string {
  const region = getPrefs().minimaxRegion;
  return region === "intl"
    ? "https://api.minimax.io"
    : "https://api.minimaxi.com";
}

const OPENAI_VOICES: VoiceOption[] = [
  { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "marin", label: "Marin", configured: false },
  { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "cedar", label: "Cedar", configured: false },
  { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "alloy", label: "Alloy", configured: false },
  { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "nova", label: "Nova", configured: false },
  { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "onyx", label: "Onyx", configured: false },
  { provider: "openai", model: "gpt-4o-mini-tts", voiceId: "shimmer", label: "Shimmer", configured: false },
];

// Small built-in subset. MiniMax exposes 300+ system voices and custom voices
// via get_voice; this list keeps the picker useful even before the dynamic
// call succeeds.
/** Built-in defaults when the ElevenLabs key is set · expanded via GET /v1/voices. */
const ELEVENLABS_DEFAULT_VOICES: VoiceOption[] = [
  {
    provider: "elevenlabs",
    model: "eleven_multilingual_v2",
    voiceId: "21m00Tcm4TlvDq8ikWAM",
    label: "Rachel",
    language: "en",
    configured: false,
  },
  {
    provider: "elevenlabs",
    model: "eleven_multilingual_v2",
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
    label: "George",
    language: "en",
    configured: false,
  },
];

const MINIMAX_SYSTEM_VOICES: VoiceOption[] = [
  // China mainland voiceIds (api.minimaxi.com)
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "male-qn-qingse", label: "青涩青年", language: "zh", configured: false },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "female-shaonv", label: "少女", language: "zh", configured: false },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "female-yujie", label: "御姐", language: "zh", configured: false },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "male-qn-jingying", label: "精英青年", language: "zh", configured: false },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "female-chengshu", label: "成熟女性", language: "zh", configured: false },
  { provider: "minimax", model: "speech-2.8-hd", voiceId: "female-tianmei", label: "甜美女性", language: "zh", configured: false },
];

export function listConfiguredVoices(): VoiceOption[] {
  const out: VoiceOption[] = [];
  const openaiReady = !!getKey("openai");
  if (openaiReady) out.push(...OPENAI_VOICES.map((v) => ({ ...v, configured: true })));
  const minimaxReady = !!getKey("minimax");
  if (minimaxReady) out.push(...MINIMAX_SYSTEM_VOICES.map((v) => ({ ...v, configured: true })));
  const elevenReady = !!getKey("elevenlabs");
  if (elevenReady) out.push(...ELEVENLABS_DEFAULT_VOICES.map((v) => ({ ...v, configured: true })));
  out.push({
    provider: "browser",
    model: "speechSynthesis",
    voiceId: "system-default",
    label: "Browser default",
    configured: true,
  });
  return out;
}

export async function listAvailableVoices(): Promise<VoiceOption[]> {
  let voices = listConfiguredVoices();
  const mmKey = getKey("minimax");
  if (mmKey) {
    try {
      const res = await fetch(`${minimaxBaseUrl()}/v1/get_voice`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${mmKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ voice_type: "all" }),
      });
      if (res.ok) {
        const json = await res.json() as Record<string, unknown>;
        const rows = [
          ...voiceRows(json.system_voice, "system"),
          ...voiceRows(json.voice_cloning, "clone"),
          ...voiceRows(json.voice_generation, "generated"),
        ];
        if (rows.length > 0) {
          const nonMiniMax = voices.filter((v) => v.provider !== "minimax");
          voices = [
            ...nonMiniMax,
            ...rows.map((r) => ({
              provider: "minimax" as const,
              model: "speech-2.8-hd",
              voiceId: r.voiceId,
              label: r.label,
              language: r.kind,
              configured: true,
            })),
          ];
        }
      }
    } catch { /* keep voices */ }
  }

  const elKey = getKey("elevenlabs");
  if (elKey) {
    try {
      const res = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": elKey },
      });
      if (res.ok) {
        const json = await res.json() as { voices?: unknown };
        const rows = elevenLabsVoiceRows(json.voices);
        if (rows.length > 0) {
          const nonEl = voices.filter((v) => v.provider !== "elevenlabs");
          voices = [
            ...nonEl,
            ...rows.map((r) => ({
              provider: "elevenlabs" as const,
              model: "eleven_multilingual_v2",
              voiceId: r.voiceId,
              label: r.label,
              language: r.category,
              configured: true,
            })),
          ];
        }
      }
    } catch { /* keep voices */ }
  }

  return voices;
}

function elevenLabsVoiceRows(raw: unknown): Array<{ voiceId: string; label: string; category: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ voiceId: string; label: string; category: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const voiceId = typeof obj.voice_id === "string" ? obj.voice_id : "";
    if (!voiceId) continue;
    const label = typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : voiceId;
    const category = typeof obj.category === "string" && obj.category.trim()
      ? obj.category.trim()
      : "voice";
    out.push({ voiceId, label, category });
  }
  return out;
}

function voiceRows(raw: unknown, kind: string): Array<{ voiceId: string; label: string; kind: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ voiceId: string; label: string; kind: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const voiceId = typeof obj.voice_id === "string" ? obj.voice_id : "";
    if (!voiceId) continue;
    const label = typeof obj.voice_name === "string" && obj.voice_name.trim()
      ? obj.voice_name.trim()
      : voiceId;
    out.push({ voiceId, label, kind });
  }
  return out;
}

export function defaultVoiceForProvider(provider: string): VoiceOption | null {
  return listConfiguredVoices().find((v) => v.provider === provider) ?? listConfiguredVoices()[0] ?? null;
}
