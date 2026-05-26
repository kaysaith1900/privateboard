/**
 * MiniMax voice-clone API client · two-step:
 *
 *   1. POST /v1/files/upload (multipart) → file_id
 *   2. POST /v1/voice_clone (JSON, file_id + chosen voice_id) → confirms
 *      the voice is registered and usable in subsequent /v1/t2a_v2 calls
 *
 * Auth + base URL mirror the TTS path in src/voice/tts.ts · same
 * minimaxRegion preference selects api.minimaxi.com (cn) or
 * api.minimax.io (intl).
 *
 * Failures are normalised into Error instances with a meaningful
 * message · the orchestrator surfaces these directly to the user
 * (no Chinese-only stack traces in the UI).
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { getPrefs } from "../../storage/prefs.js";
import {
  getActiveVoiceKeyPlaintext,
  getActiveVoiceProvider,
} from "../../storage/voice-credentials.js";

/** Pick the active MiniMax voice API key. Throws when nothing is
 *  configured OR the active credential is for a different provider. */
export function getActiveMiniMaxKey(): string {
  if (getActiveVoiceProvider() !== "minimax") {
    throw new Error(
      "MiniMax voice credential is not active. Configure a MiniMax voice key in Preferences → Voice.",
    );
  }
  const key = getActiveVoiceKeyPlaintext();
  if (!key) {
    throw new Error(
      "MiniMax voice credential decryption failed. Re-enter the key in Preferences → Voice.",
    );
  }
  return key;
}

/** Base URL for the active MiniMax region. Mirrors
 *  `minimaxBaseUrl()` in src/voice/tts.ts; kept local rather than
 *  exported from tts.ts to avoid a circular import. */
export function minimaxBaseUrl(): string {
  return getPrefs().minimaxRegion === "intl"
    ? "https://api.minimax.io"
    : "https://api.minimaxi.com";
}

export interface UploadVoiceFileOpts {
  /** Absolute path to the audio file. mp3 / wav / m4a all accepted. */
  filePath: string;
  /** Defaults to "voice_clone" — the documented purpose tag for the
   *  voice-clone pipeline. Exposed in case MiniMax adds new purposes
   *  later (e.g. "voice_clone_prompt"). */
  purpose?: string;
  apiKey?: string;
  signal?: AbortSignal;
}

export interface UploadVoiceFileResult {
  fileId: number;
  fileBytes: number;
  filename: string;
}

interface MiniMaxFileUploadResponse {
  file?: {
    file_id?: number;
    bytes?: number;
    filename?: string;
  };
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
}

/** Upload a local audio file to MiniMax, returning the file_id needed
 *  for /v1/voice_clone. Throws on transport error, non-2xx, or a
 *  non-zero `base_resp.status_code`. */
export async function uploadVoiceFile(opts: UploadVoiceFileOpts): Promise<UploadVoiceFileResult> {
  const apiKey = opts.apiKey ?? getActiveMiniMaxKey();
  const purpose = opts.purpose ?? "voice_clone";
  const buf = await readFile(opts.filePath);
  const filename = basename(opts.filePath);

  const form = new FormData();
  form.append("purpose", purpose);
  // node:undici FormData accepts a File-like blob · construct one from
  // the Buffer so MiniMax sees a proper multipart part with filename
  // metadata. mime-type is best-effort (mp3 by extension).
  form.append(
    "file",
    new Blob([new Uint8Array(buf)], { type: guessMime(filename) }),
    filename,
  );

  const res = await fetch(`${minimaxBaseUrl()}/v1/files/upload`, {
    method: "POST",
    signal: opts.signal,
    headers: {
      "authorization": `Bearer ${apiKey}`,
    },
    body: form,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MiniMax /v1/files/upload HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  let parsed: MiniMaxFileUploadResponse;
  try {
    parsed = JSON.parse(text) as MiniMaxFileUploadResponse;
  } catch {
    throw new Error(`MiniMax /v1/files/upload returned non-JSON: ${text.slice(0, 200)}`);
  }
  const code = parsed.base_resp?.status_code ?? 0;
  if (code !== 0) {
    throw new Error(
      `MiniMax /v1/files/upload failed · status_code=${code} · ${parsed.base_resp?.status_msg || "unknown error"}`,
    );
  }
  const fileId = parsed.file?.file_id;
  if (typeof fileId !== "number") {
    throw new Error(`MiniMax /v1/files/upload returned no file_id: ${text.slice(0, 200)}`);
  }
  return {
    fileId,
    fileBytes: parsed.file?.bytes ?? buf.length,
    filename: parsed.file?.filename ?? filename,
  };
}

export interface RegisterVoiceCloneOpts {
  fileId: number;
  /** Caller-chosen voice_id. MiniMax requires this to be a string the
   *  user picks (typically slug-shaped). Must be unique within the
   *  user's account. */
  voiceId: string;
  apiKey?: string;
  signal?: AbortSignal;
  /** Optional · MiniMax can return a short demo audio rendered against
   *  this text to confirm the clone works. Skipping (undefined) is the
   *  cheap path. */
  previewText?: string;
  previewModel?: string;
  needNoiseReduction?: boolean;
  needVolumeNormalization?: boolean;
  /** Optional · biases the synthesis toward a target language. Pass
   *  e.g. "Chinese" for zh content, "auto" to let MiniMax decide. */
  languageBoost?: string;
}

export interface RegisterVoiceCloneResult {
  voiceId: string;
  demoAudioBase64?: string;
}

interface MiniMaxVoiceCloneResponse {
  demo_audio?: string;
  input_sensitive?: boolean;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
}

/** Finalise the clone · point MiniMax at an uploaded file_id and a
 *  user-chosen voice_id slug. On success the same voice_id can be
 *  used immediately in /v1/t2a_v2 calls. */
export async function registerVoiceClone(opts: RegisterVoiceCloneOpts): Promise<RegisterVoiceCloneResult> {
  const apiKey = opts.apiKey ?? getActiveMiniMaxKey();

  const body: Record<string, unknown> = {
    file_id: opts.fileId,
    voice_id: opts.voiceId,
    need_noise_reduction: opts.needNoiseReduction ?? true,
    need_volume_normalization: opts.needVolumeNormalization ?? true,
  };
  if (opts.previewText) {
    body.text = opts.previewText;
    body.model = opts.previewModel ?? "speech-2.8-hd";
  }
  if (opts.languageBoost) {
    body.language_boost = opts.languageBoost;
  }

  const res = await fetch(`${minimaxBaseUrl()}/v1/voice_clone`, {
    method: "POST",
    signal: opts.signal,
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MiniMax /v1/voice_clone HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  let parsed: MiniMaxVoiceCloneResponse;
  try {
    parsed = JSON.parse(text) as MiniMaxVoiceCloneResponse;
  } catch {
    throw new Error(`MiniMax /v1/voice_clone returned non-JSON: ${text.slice(0, 200)}`);
  }
  const code = parsed.base_resp?.status_code ?? 0;
  if (code !== 0) {
    throw new Error(
      `MiniMax /v1/voice_clone failed · status_code=${code} · ${parsed.base_resp?.status_msg || "unknown error"}`,
    );
  }
  return {
    voiceId: opts.voiceId,
    demoAudioBase64: parsed.demo_audio || undefined,
  };
}

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() || "";
  switch (ext) {
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "m4a": return "audio/mp4";
    case "ogg": return "audio/ogg";
    case "flac": return "audio/flac";
    default: return "application/octet-stream";
  }
}
