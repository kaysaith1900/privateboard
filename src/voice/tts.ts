import { getKey } from "../storage/keys.js";
import { getPrefs } from "../storage/prefs.js";
import type { Agent, AgentVoiceProfile } from "../storage/agents.js";
import { defaultVoiceForProvider } from "./registry.js";

/**
 * MiniMax API base URL, selected by the user's `minimaxRegion` preference.
 * - "cn"   → https://api.minimaxi.com  (China mainland, platform.minimaxi.com keys)
 * - "intl" → https://api.minimax.io    (International, platform.minimax.chat keys)
 */
function minimaxBaseUrl(): string {
  const region = getPrefs().minimaxRegion;
  return region === "intl"
    ? "https://api.minimax.io"
    : "https://api.minimaxi.com";
}

const ELEVENLABS_API = "https://api.elevenlabs.io/v1";

export interface TtsChunk {
  provider: string;
  model: string;
  voiceId: string;
  text: string;
  mimeType?: string;
  audioBase64?: string;
}

/**
 * Strip markdown / code / urls / table syntax from a message body so
 * TTS doesn't read the formatting characters out loud. Used by both
 * the live voice flow (sentence-by-sentence streaming) and the
 * post-adjourn replay (per-message buffered synthesis).
 *
 * Conservative: only strips formatting noise that's purely visual.
 * Keeps the actual content + sentence structure intact so the
 * sentence-splitter / TTS get a clean stream of natural language.
 *
 * Order matters · fences and inline code first (they may carry
 * other markdown chars inside that we shouldn't mistake for prose).
 */
export function cleanForSpeech(md: string): string {
  if (!md) return "";
  let out = md;
  // Fenced code blocks · drop entirely (TTS shouldn't read code aloud).
  out = out.replace(/```[\s\S]*?```/g, " ");
  // Inline code · strip ticks, keep content.
  out = out.replace(/`([^`\n]+)`/g, "$1");
  // Images · drop entirely (alt text is rarely useful aurally).
  out = out.replace(/!\[[^\]]*\]\([^)]+\)/g, " ");
  // Markdown links · keep the label text, drop the URL.
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Bare URLs · replace with the word "link" so the cadence isn't
  // a long stream of letters being spelled out.
  out = out.replace(/https?:\/\/\S+/gi, "link");
  // Headings · drop the leading hashes, keep the heading text.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  // Blockquote markers · drop ">" prefix.
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  // Unordered + ordered list markers · drop bullet, keep content.
  out = out.replace(/^\s*[-*+]\s+/gm, "");
  out = out.replace(/^\s*\d+[.)]\s+/gm, "");
  // Table rows · pipes become commas so columns read as clauses.
  // Skip the |---| separator lines entirely.
  out = out.replace(/^\s*\|[\s:|-]+\|\s*$/gm, " ");
  out = out.replace(/\|/g, ", ");
  // Emphasis decoration · `**bold**`, `__bold__`, `*italic*`, `_em_`,
  // `~~strike~~`. Keep the content.
  out = out.replace(/(\*\*|__)(.+?)\1/g, "$2");
  out = out.replace(/(?<!\w)([*_])([^*_\n]+)\1(?!\w)/g, "$2");
  out = out.replace(/~~(.+?)~~/g, "$1");
  // Raw HTML tags · drop. (Brief content shouldn't have any but
  // belt-and-braces.)
  out = out.replace(/<[^>]+>/g, " ");
  // Common HTML entities · resolve a small set, leave the rest.
  out = out
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse runs of whitespace · keep newlines so the sentence-
  // splitter still sees paragraph breaks.
  out = out.replace(/[ \t]+/g, " ");
  out = out.replace(/\n[ \t]+/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

export function voiceProfileForAgent(agent: Agent): AgentVoiceProfile {
  if (agent.voice) return agent.voice;
  const fallback = defaultVoiceForProvider(
    getKey("minimax") ? "minimax"
      : getKey("elevenlabs") ? "elevenlabs"
        : getKey("openai") ? "openai"
          : "browser",
  );
  return {
    provider: (fallback?.provider ?? "browser") as AgentVoiceProfile["provider"],
    model: fallback?.model ?? "speechSynthesis",
    voiceId: fallback?.voiceId ?? "system-default",
    speed: 1,
    pitch: 0,
    volume: 1,
  };
}

/**
 * Synchronous (non-streaming) speech synthesis — used as a fallback.
 * For real-time playback, prefer `synthesizeSpeechStream`.
 */
export async function synthesizeSpeech(text: string, profile: AgentVoiceProfile, signal?: AbortSignal): Promise<TtsChunk> {
  if (profile.provider === "minimax") return synthesizeMiniMax(text, profile, signal);
  if (profile.provider === "elevenlabs") return synthesizeElevenLabs(text, profile, signal);
  // Browser and not-yet-implemented providers: text-only chunk.
  return {
    provider: profile.provider,
    model: profile.model,
    voiceId: profile.voiceId,
    text,
  };
}

/**
 * Streaming TTS synthesis via MiniMax — yields audio chunks as they arrive.
 * Each yielded TtsChunk contains a partial audioBase64 segment that can be
 * concatenated / played immediately. The `text` field carries the full input
 * (repeated in each chunk for logging convenience).
 *
 * Falls back to a single non-streaming call when the provider key is absent
 * or the provider doesn't support HTTP streaming.
 */
export async function* synthesizeSpeechStream(
  text: string,
  profile: AgentVoiceProfile,
  signal?: AbortSignal,
): AsyncGenerator<TtsChunk> {
  if (profile.provider === "elevenlabs" && getKey("elevenlabs")) {
    yield* synthesizeElevenLabsStream(text, profile, signal);
    return;
  }

  if (profile.provider !== "minimax" || !getKey("minimax")) {
    // Fallback: yield a single chunk (non-streaming).
    yield await synthesizeSpeech(text, profile, signal);
    return;
  }

  const key = getKey("minimax")!;
  const model = profile.model || "speech-2.8-hd";

  const res = await fetch(`${minimaxBaseUrl()}/v1/t2a_v2`, {
    method: "POST",
    signal,
    headers: {
      "authorization": `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      text,
      stream: true,
      language_boost: "auto",
      voice_setting: {
        voice_id: profile.voiceId,
        speed: profile.speed ?? 1,
        vol: profile.volume ?? 1,
        pitch: profile.pitch ?? 0,
        ...(profile.emotion ? { emotion: profile.emotion } : {}),
      },
      ...((profile.modifyPitch != null || profile.modifyIntensity != null || profile.modifyTimbre != null) ? {
        voice_modify: {
          ...(profile.modifyPitch != null ? { pitch: profile.modifyPitch } : {}),
          ...(profile.modifyIntensity != null ? { intensity: profile.modifyIntensity } : {}),
          ...(profile.modifyTimbre != null ? { timbre: profile.modifyTimbre } : {}),
        },
      } : {}),
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
      // Exclude the aggregated final audio to save bandwidth —
      // we already have all chunks by the time the last event arrives.
      stream_options: { exclude_aggregated_audio: true },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MiniMax TTS stream HTTP ${res.status}: ${errText}`);
  }

  // MiniMax may return 200 with an error body (JSON, not SSE) for auth failures.
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const errBody = await res.text();
    throw new Error(`MiniMax TTS: expected event-stream but got ${contentType}: ${errBody.slice(0, 200)}`);
  }

  // MiniMax streaming returns text/event-stream with SSE-like chunks.
  // Each line: `data: {...}\n\n`
  const body = res.body;
  if (!body) {
    throw new Error("MiniMax TTS stream: no response body");
  }

  process.stderr.write(`[tts-stream] response status=${res.status} content-type=${res.headers.get("content-type")}\n`);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let rawBytesRead = 0;
  let linesProcessed = 0;
  let chunksYielded = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const decoded = decoder.decode(value, { stream: true });
      rawBytesRead += decoded.length;
      buffer += decoded;

      // Log first chunk of raw data for debugging
      if (rawBytesRead === decoded.length) {
        process.stderr.write(`[tts-stream] first raw data (${decoded.length} chars): ${decoded.slice(0, 200)}\n`);
      }

      // Parse complete SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete last line

      for (const line of lines) {
        linesProcessed++;
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;

        try {
          const event = JSON.parse(jsonStr) as {
            data?: { audio?: string; status?: number };
            base_resp?: { status_code?: number; status_msg?: string };
          };

          // Check for errors
          if (event.base_resp?.status_code && event.base_resp.status_code !== 0) {
            process.stderr.write(`[tts-stream] MiniMax error: ${event.base_resp.status_msg}\n`);
            continue;
          }

          const hex = event.data?.audio;
          if (!hex) continue;

          chunksYielded++;
          yield {
            provider: "minimax",
            model,
            voiceId: profile.voiceId,
            text,
            mimeType: "audio/mpeg",
            audioBase64: Buffer.from(hex, "hex").toString("base64"),
          };
        } catch (parseErr) {
          process.stderr.write(`[tts-stream] parse error on line: ${trimmed.slice(0, 100)}\n`);
        }
      }
    }
  } finally {
    process.stderr.write(`[tts-stream] done: rawBytes=${rawBytesRead} lines=${linesProcessed} chunks=${chunksYielded} remainingBuffer=${buffer.length}\n`);
    reader.releaseLock();
  }
}

/** Original non-streaming MiniMax synthesis (kept for reference / fallback). */
async function synthesizeMiniMax(text: string, profile: AgentVoiceProfile, signal?: AbortSignal): Promise<TtsChunk> {
  const key = getKey("minimax");
  if (!key) {
    return { provider: "browser", model: "speechSynthesis", voiceId: "system-default", text };
  }
  const model = profile.model || "speech-2.8-hd";
  const res = await fetch(`${minimaxBaseUrl()}/v1/t2a_v2`, {
    method: "POST",
    signal,
    headers: {
      "authorization": `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      text,
      stream: false,
      language_boost: "auto",
      voice_setting: {
        voice_id: profile.voiceId,
        speed: profile.speed ?? 1,
        vol: profile.volume ?? 1,
        pitch: profile.pitch ?? 0,
        ...(profile.emotion ? { emotion: profile.emotion } : {}),
      },
      ...((profile.modifyPitch != null || profile.modifyIntensity != null || profile.modifyTimbre != null) ? {
        voice_modify: {
          ...(profile.modifyPitch != null ? { pitch: profile.modifyPitch } : {}),
          ...(profile.modifyIntensity != null ? { intensity: profile.modifyIntensity } : {}),
          ...(profile.modifyTimbre != null ? { timbre: profile.modifyTimbre } : {}),
        },
      } : {}),
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
    }),
  });
  if (!res.ok) throw new Error(`MiniMax TTS HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json() as { data?: { audio?: string }; audio?: string };
  const hex = json.data?.audio ?? json.audio ?? "";
  if (!hex) throw new Error("MiniMax TTS returned no audio");
  return {
    provider: "minimax",
    model,
    voiceId: profile.voiceId,
    text,
    mimeType: "audio/mpeg",
    audioBase64: Buffer.from(hex, "hex").toString("base64"),
  };
}

async function synthesizeElevenLabs(text: string, profile: AgentVoiceProfile, signal?: AbortSignal): Promise<TtsChunk> {
  const key = getKey("elevenlabs");
  if (!key) {
    return { provider: "browser", model: "speechSynthesis", voiceId: "system-default", text };
  }
  const modelId = profile.model?.trim() || "eleven_multilingual_v2";
  const outputFormat = "mp3_44100_128";
  const url = `${ELEVENLABS_API}/text-to-speech/${encodeURIComponent(profile.voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "xi-api-key": key,
      "content-type": "application/json",
      "accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs TTS HTTP ${res.status}: ${errText.slice(0, 400)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    provider: "elevenlabs",
    model: modelId,
    voiceId: profile.voiceId,
    text,
    mimeType: "audio/mpeg",
    audioBase64: buf.toString("base64"),
  };
}

async function* synthesizeElevenLabsStream(
  text: string,
  profile: AgentVoiceProfile,
  signal?: AbortSignal,
): AsyncGenerator<TtsChunk> {
  const key = getKey("elevenlabs");
  if (!key) {
    yield await synthesizeSpeech(text, profile, signal);
    return;
  }
  const modelId = profile.model?.trim() || "eleven_multilingual_v2";
  const outputFormat = "mp3_44100_128";
  const url = `${ELEVENLABS_API}/text-to-speech/${encodeURIComponent(profile.voiceId)}/stream?output_format=${encodeURIComponent(outputFormat)}`;
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "xi-api-key": key,
      "content-type": "application/json",
      "accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs TTS stream HTTP ${res.status}: ${errText.slice(0, 400)}`);
  }
  const body = res.body;
  if (!body) {
    throw new Error("ElevenLabs TTS stream: no response body");
  }

  const reader = body.getReader();
  const model = modelId;
  const voiceId = profile.voiceId;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      yield {
        provider: "elevenlabs",
        model,
        voiceId,
        text,
        mimeType: "audio/mpeg",
        audioBase64: Buffer.from(value).toString("base64"),
      };
    }
  } finally {
    reader.releaseLock();
  }
}
