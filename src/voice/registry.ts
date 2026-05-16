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

// Built-in library voices · seed defaults so the picker has something
// the moment the user adds an ElevenLabs key, before the dynamic
// GET /v1/voices fetch round-trips (or when it fails / is blocked by
// the network). These are "premade" voices in ElevenLabs's catalogue
// — paid plans synthesize them fine; free-tier API hits return 402
// `paid_plan_required` which synthesizeElevenLabs translates into a
// human-readable "library voices need a paid plan" message. So the
// picker stays populated regardless of plan tier; the failure surface
// is at preview/play time, where the error message is actionable.
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
    // Pull TWO sources in parallel so a paid user gets the full picture:
    //   (a) /v1/voices  — voices in their personal library (clones,
    //       premade defaults, voices they've previously added). For a
    //       fresh paid account this is typically ~10 voices.
    //   (b) /v1/shared-voices  — the public ElevenLabs Voice Library
    //       (community + featured voices). Paid users can synthesize
    //       these directly via /text-to-speech/{voice_id}. We pull the
    //       most popular first page (100 voices) so the picker has a
    //       useful catalogue without forcing the user to "add to library"
    //       first.
    //
    // Errors on either fetch are logged to stderr (no longer silently
    // swallowed) so when the picker shows the bare 2 defaults it's clear
    // from server logs why. `show_legacy=true` keeps the picker compatible
    // with users whose accounts still carry legacy voice IDs.
    const personal: Array<{ voiceId: string; label: string; category: string }> = [];
    const shared: Array<{ voiceId: string; label: string; category: string; language?: string }> = [];

    await Promise.all([
      (async () => {
        try {
          const res = await fetch(
            "https://api.elevenlabs.io/v1/voices?show_legacy=true&include_total_count=true",
            { headers: { "xi-api-key": elKey } },
          );
          if (!res.ok) {
            const errText = await res.text();
            process.stderr.write(
              `[voice-registry] elevenlabs /v1/voices HTTP ${res.status}: ${errText.slice(0, 300)}\n`,
            );
            return;
          }
          const json = await res.json() as { voices?: unknown };
          const rows = elevenLabsVoiceRows(json.voices);
          process.stderr.write(`[voice-registry] elevenlabs /v1/voices · ${rows.length} voices in personal library\n`);
          personal.push(...rows);
        } catch (e) {
          const cause = e instanceof Error ? (e as { cause?: { message?: string } }).cause : null;
          const detail = cause?.message ? `: ${cause.message}` : "";
          process.stderr.write(
            `[voice-registry] elevenlabs /v1/voices fetch failed${detail} · ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      })(),
      (async () => {
        try {
          // page_size capped at 100 by ElevenLabs; that's enough for the
          // picker without paginating. Sorted by `usage_character_count`
          // (default) so the most popular voices surface first.
          const res = await fetch(
            "https://api.elevenlabs.io/v1/shared-voices?page_size=100",
            { headers: { "xi-api-key": elKey } },
          );
          if (!res.ok) {
            const errText = await res.text();
            process.stderr.write(
              `[voice-registry] elevenlabs /v1/shared-voices HTTP ${res.status}: ${errText.slice(0, 300)}\n`,
            );
            return;
          }
          const json = await res.json() as { voices?: unknown };
          const rows = elevenLabsSharedVoiceRows(json.voices);
          process.stderr.write(`[voice-registry] elevenlabs /v1/shared-voices · ${rows.length} voices from public library\n`);
          shared.push(...rows);
        } catch (e) {
          const cause = e instanceof Error ? (e as { cause?: { message?: string } }).cause : null;
          const detail = cause?.message ? `: ${cause.message}` : "";
          process.stderr.write(
            `[voice-registry] elevenlabs /v1/shared-voices fetch failed${detail} · ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      })(),
    ]);

    if (personal.length > 0 || shared.length > 0) {
      const nonEl = voices.filter((v) => v.provider !== "elevenlabs");
      const personalIds = new Set(personal.map((r) => r.voiceId));
      // Dedupe · a voice the user has already added from the library
      // shows up in BOTH /v1/voices (as "owned") and /v1/shared-voices.
      // Prefer the personal-library row so its category label is honest.
      const sharedDeduped = shared.filter((r) => !personalIds.has(r.voiceId));
      const personalMapped = personal.map((r) => ({
        provider: "elevenlabs" as const,
        model: "eleven_multilingual_v2",
        voiceId: r.voiceId,
        label: r.label,
        // Personal-library rows keep their actual category
        // ("premade", "cloned", "professional", "generated").
        language: r.category,
        configured: true,
      }));
      const sharedMapped = sharedDeduped.map((r) => ({
        provider: "elevenlabs" as const,
        model: "eleven_multilingual_v2",
        voiceId: r.voiceId,
        // Prefix shared-library voices so users can tell at a glance
        // which set they're picking from. The dropdown's group header
        // already says "elevenlabs", so the per-row prefix is the
        // tightest signal we have for personal-vs-shared.
        label: `${r.label} · shared`,
        language: r.language || r.category,
        configured: true,
      }));
      voices = [...nonEl, ...personalMapped, ...sharedMapped];
    }
  }

  return voices;
}

/** Parse one voice row from the ElevenLabs /v1/shared-voices response.
 *  Schema differs from /v1/voices: shared rows use `name` for the
 *  display label, `category` carries "professional" / "high_quality",
 *  and there's a `language` field that's nice to surface to the user. */
function elevenLabsSharedVoiceRows(
  raw: unknown,
): Array<{ voiceId: string; label: string; category: string; language?: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ voiceId: string; label: string; category: string; language?: string }> = [];
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
      : "shared";
    const language = typeof obj.language === "string" && obj.language.trim()
      ? obj.language.trim()
      : undefined;
    out.push({ voiceId, label, category, language });
  }
  return out;
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
