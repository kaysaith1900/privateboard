import { getKey } from "../storage/keys.js";
import { getPrefs } from "../storage/prefs.js";
import {
  getActiveVoiceKeyPlaintext,
  getActiveVoiceProvider,
} from "../storage/voice-credentials.js";
import type { Agent, AgentVoiceProfile } from "../storage/agents.js";
import { defaultVoiceForProvider } from "./registry.js";

/** Plaintext key for the active voice credential, when it matches the
 *  per-call `wanted` provider. Returns null on a provider mismatch so
 *  callers can short-circuit to the browser fallback instead of
 *  routing a MiniMax voice request through an ElevenLabs key. */
function activeVoiceKeyFor(wanted: "minimax" | "elevenlabs"): string | null {
  if (getActiveVoiceProvider() !== wanted) return null;
  return getActiveVoiceKeyPlaintext();
}

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
const OPENAI_API = "https://api.openai.com/v1";

export interface TtsChunk {
  provider: string;
  model: string;
  voiceId: string;
  text: string;
  mimeType?: string;
  audioBase64?: string;
}

/** Tagged "MiniMax insufficient balance" error · the streaming AND
 *  non-streaming TTS paths both throw THIS exact shape so the chair /
 *  director SSE forwarders + the /api/voices route can recognise it
 *  and surface the same upgrade overlay to the frontend. */
export type TtsBillingError = Error & {
  code: "paid-plan-required";
  provider: string;
  upgradeUrl: string;
};

function makeMiniMaxBalanceError(): TtsBillingError {
  const err = new Error(
    "Your MiniMax account balance is insufficient for TTS. " +
    "Top up your account in the MiniMax console and try again.",
  ) as TtsBillingError;
  err.code = "paid-plan-required";
  err.provider = "minimax";
  // Pick the right console URL by region · CN keys can't sign in on
  // the .io console and vice-versa.
  err.upgradeUrl = getPrefs().minimaxRegion === "intl"
    ? "https://platform.minimax.io/user-center/billing/overview"
    : "https://platform.minimaxi.com/user-center/payment";
  return err;
}

/** Tagged ElevenLabs "out of credits / paid plan required" error.
 *  Library-voice gating (Rachel / George etc. on free tier) AND
 *  credit-exhaustion (quota_exceeded) both route to the same upgrade
 *  CTA — the user resolution is identical (upgrade or buy credits). */
function makeElevenLabsBillingError(message: string): TtsBillingError {
  const err = new Error(message) as TtsBillingError;
  err.code = "paid-plan-required";
  err.provider = "elevenlabs";
  err.upgradeUrl = "https://elevenlabs.io/pricing";
  return err;
}

/** Recognise the ElevenLabs credit/quota-exhaustion shapes that
 *  aren't covered by the paid_plan_required gate (which targets
 *  library voices specifically). Matches the JSON error bodies we've
 *  observed: `quota_exceeded`, `insufficient_credit`, `out of credits`,
 *  `voice_limit_reached`, plus a plain-text "credits" mention next to
 *  a remaining-balance number. */
function isElevenLabsCreditError(errText: string): boolean {
  return /quota_exceeded|insufficient[ _-]?(?:credit|quota|balance|fund)|out\s+of\s+credits?|voice_limit_reached|余额不足/i.test(errText);
}

/** Unwrap a caught error and return its TtsBillingError shape when it
 *  matches (code === "paid-plan-required"). Used by the streaming
 *  callers (chair + director TTS) to decide whether to forward the
 *  failure to the frontend via a `voice-error` SSE event so the
 *  upgrade overlay can open. Returns null for any other error · the
 *  caller still logs it to stderr as before. */
export function tryExtractTtsBillingError(err: unknown): TtsBillingError | null {
  if (!err || typeof err !== "object") return null;
  const tagged = err as { code?: unknown; provider?: unknown; upgradeUrl?: unknown; message?: unknown };
  if (tagged.code !== "paid-plan-required") return null;
  if (typeof tagged.provider !== "string") return null;
  const out = err as TtsBillingError;
  if (typeof tagged.upgradeUrl !== "string") {
    // Defensive · the producer should always set it, but if a future
    // code path forgets, drop a sensible default so the overlay still
    // surfaces (with no CTA · the close button still works).
    out.upgradeUrl = "";
  }
  if (typeof tagged.message !== "string") {
    out.message = "Voice synthesis requires a paid plan.";
  }
  return out;
}

/**
 * Strip 【label】 section headers (brainstorm's 5-slot template
 * 【我看到的价值】/【我会怎么放大】/etc., and analogous bracketed
 * cues in other modes) before TTS. They are visual prefixes for the
 * eye — reading them aloud makes every director turn open with the
 * same five labels and destroys the speech cadence. Bounded to short
 * inner content (≤40 chars, no newlines) so a director quoting a
 * 【...】 phrase mid-sentence doesn't swallow the surrounding prose.
 */
export function stripSpokenLabels(text: string): string {
  if (!text) return "";
  return text
    .replace(/【[^】\n]{1,40}】[ \t]*/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  // 【label】 section headers · drop (same rationale as stripSpokenLabels;
  // this is the replay path's pre-buffered equivalent).
  out = out.replace(/【[^】\n]{1,40}】[ \t]*/g, " ");
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
  const activeProvider = getActiveVoiceProvider();

  // Happy path · the agent already carries a voice from the active
  // provider (the `reconcileAgentVoices` reshuffle keeps this true
  // every time the active credential changes). Use it as-is.
  if (agent.voice && agent.voice.provider === activeProvider) {
    return agent.voice;
  }

  // Mismatch · the agent's stored voiceId belongs to a different
  // provider (rare · only between a provider switch and the
  // reconcile pass that follows). Pick a fresh default from the
  // active provider's catalog so synthesis doesn't 404 against the
  // wrong API. Preserve user-tuned dials (speed / pitch / volume /
  // emotion) — those translate reasonably across voices in the
  // same provider family.
  if (agent.voice && activeProvider) {
    const fresh = defaultVoiceForProvider(activeProvider);
    if (fresh) {
      return {
        provider: fresh.provider as AgentVoiceProfile["provider"],
        model: fresh.model,
        voiceId: fresh.voiceId,
        speed: agent.voice.speed ?? 1,
        pitch: agent.voice.pitch ?? 0,
        volume: agent.voice.volume ?? 1,
        ...(agent.voice.emotion ? { emotion: agent.voice.emotion } : {}),
      };
    }
  }

  // No stored voice · pick a provider-appropriate default.
  const fallback = defaultVoiceForProvider(
    activeProvider ?? (getKey("openai") ? "openai" : "browser"),
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
  if (profile.provider === "openai") return synthesizeOpenAI(text, profile, signal);
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
  if (profile.provider === "elevenlabs" && activeVoiceKeyFor("elevenlabs")) {
    yield* synthesizeElevenLabsStream(text, profile, signal);
    return;
  }

  const minimaxKey = activeVoiceKeyFor("minimax");
  if (profile.provider !== "minimax" || !minimaxKey) {
    // Fallback: yield a single chunk (non-streaming).
    yield await synthesizeSpeech(text, profile, signal);
    return;
  }

  const key = minimaxKey;
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
    // Even on HTTP errors, MiniMax sometimes returns the structured
    // base_resp · check for status_code 1008 / insufficient-balance
    // wording so the streaming path tags the same error shape as the
    // non-streaming `synthesizeMiniMax` below.
    if (res.status === 402 || /"status_code"\s*:\s*1008|insufficient[ _-]?(?:balance|quota|credit|fund)|余额不足|余额[^a-zA-Z]?(?:不足|不够)/i.test(errText)) {
      throw makeMiniMaxBalanceError();
    }
    throw new Error(`MiniMax TTS stream HTTP ${res.status}: ${errText}`);
  }

  // MiniMax returns 200 with an error body (JSON, not SSE) for auth
  // AND for insufficient-balance failures. This is the actual path the
  // user hits — the stream "succeeds" at the HTTP layer but the body
  // is `{"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}`.
  // Parse it explicitly so the failure surfaces as the same tagged
  // upgrade error as the non-streaming path · the chair/director
  // streaming callers then forward this via roomBus to the frontend.
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const errBody = await res.text();
    if (/"status_code"\s*:\s*1008|insufficient[ _-]?(?:balance|quota|credit|fund)|余额不足|余额[^a-zA-Z]?(?:不足|不够)/i.test(errBody)) {
      throw makeMiniMaxBalanceError();
    }
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
  const key = activeVoiceKeyFor("minimax");
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
  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 402 || /insufficient[ _-]?(?:balance|quota|credit|fund)|余额不足|余额[^a-zA-Z]?(?:不足|不够)/i.test(errText)) {
      throw makeMiniMaxBalanceError();
    }
    throw new Error(`MiniMax TTS HTTP ${res.status}: ${errText}`);
  }
  const json = await res.json() as {
    data?: { audio?: string };
    audio?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };
  // MiniMax returns 200 with a non-zero base_resp.status_code on a
  // logical failure (insufficient balance shows up here, not as
  // HTTP 402). Surface the same paid-plan-required tagging so the
  // frontend can route into the upgrade overlay.
  const status = json.base_resp?.status_code ?? 0;
  const statusMsg = json.base_resp?.status_msg || "";
  if (status !== 0 && (status === 1008 || /insufficient[ _-]?(?:balance|quota|credit|fund)|余额不足|余额[^a-zA-Z]?(?:不足|不够)/i.test(statusMsg))) {
    throw makeMiniMaxBalanceError();
  }
  const hex = json.data?.audio ?? json.audio ?? "";
  if (!hex) {
    if (status !== 0 && statusMsg) {
      throw new Error(`MiniMax TTS failed (${status}): ${statusMsg}`);
    }
    throw new Error("MiniMax TTS returned no audio");
  }
  return {
    provider: "minimax",
    model,
    voiceId: profile.voiceId,
    text,
    mimeType: "audio/mpeg",
    audioBase64: Buffer.from(hex, "hex").toString("base64"),
  };
}

/**
 * OpenAI Text-to-Speech · single-shot synthesis.
 *
 * Endpoint: POST {OPENAI_API}/audio/speech
 *   body: { model, input, voice, response_format: "mp3", speed }
 *   returns: binary MP3 (no streaming over HTTP for this endpoint —
 *   the response is the complete audio in one shot).
 *
 * Model defaults to `gpt-4o-mini-tts` (the model the registry lists
 * its voices under: marin / cedar / alloy / nova / onyx / shimmer).
 * Speed is clamped to OpenAI's documented 0.25–4.0 window; pitch /
 * volume aren't honoured by this endpoint (the model controls those
 * via `voice` + future `instructions` field), so they're silently
 * dropped here — the picker's pitch/volume sliders are still useful
 * for MiniMax / ElevenLabs agents.
 */
async function synthesizeOpenAI(text: string, profile: AgentVoiceProfile, signal?: AbortSignal): Promise<TtsChunk> {
  const key = getKey("openai");
  if (!key) {
    return { provider: "browser", model: "speechSynthesis", voiceId: "system-default", text };
  }
  const model = profile.model?.trim() || "gpt-4o-mini-tts";
  const voice = profile.voiceId?.trim() || "marin";
  const speed = Math.min(4, Math.max(0.25, profile.speed ?? 1));
  const res = await fetch(`${OPENAI_API}/audio/speech`, {
    method: "POST",
    signal,
    headers: {
      "authorization": `Bearer ${key}`,
      "content-type": "application/json",
      "accept": "audio/mpeg",
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: "mp3",
      speed,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI TTS HTTP ${res.status}: ${errText.slice(0, 400)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) {
    throw new Error("OpenAI TTS returned empty body");
  }
  return {
    provider: "openai",
    model,
    voiceId: voice,
    text,
    mimeType: "audio/mpeg",
    audioBase64: buf.toString("base64"),
  };
}

async function synthesizeElevenLabs(text: string, profile: AgentVoiceProfile, signal?: AbortSignal): Promise<TtsChunk> {
  const key = activeVoiceKeyFor("elevenlabs");
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
    // 402 paid_plan_required · ElevenLabs free-tier API blocks
    // "library/premade" voices (Rachel, George, Adam, etc.). Surface
    // a friendlier message than the raw JSON so users know to either
    // (a) clone their own voice, or (b) upgrade their ElevenLabs plan.
    if (res.status === 402 && /paid_plan_required|library voices/i.test(errText)) {
      throw makeElevenLabsBillingError(
        "ElevenLabs library voices (Rachel, George, etc.) require a paid plan to use via the API. " +
        "Either upgrade your ElevenLabs subscription, or clone your own voice in the ElevenLabs dashboard and pick it here.",
      );
    }
    // Credit / quota exhaustion · separate signal from the
    // paid_plan_required gate. ElevenLabs returns 401 or 422 here
    // depending on plan tier, with `quota_exceeded` in the body.
    if (isElevenLabsCreditError(errText)) {
      throw makeElevenLabsBillingError(
        "Your ElevenLabs account is out of credits. " +
        "Top up your ElevenLabs plan and try again.",
      );
    }
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
  const key = activeVoiceKeyFor("elevenlabs");
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
    if (res.status === 402 && /paid_plan_required|library voices/i.test(errText)) {
      throw makeElevenLabsBillingError(
        "ElevenLabs library voices (Rachel, George, etc.) require a paid plan to use via the API. " +
        "Either upgrade your ElevenLabs subscription, or clone your own voice in the ElevenLabs dashboard and pick it here.",
      );
    }
    if (isElevenLabsCreditError(errText)) {
      throw makeElevenLabsBillingError(
        "Your ElevenLabs account is out of credits. " +
        "Top up your ElevenLabs plan and try again.",
      );
    }
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
