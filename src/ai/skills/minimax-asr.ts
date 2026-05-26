/**
 * MiniMax ASR (audio → transcript with timestamps) client.
 *
 * MiniMax's public API surface for ASR has shifted between regions; we
 * try the documented `/v1/audio_transcription` endpoint first and fall
 * back to `/v1/voice/recognition` if the primary 404s. Either way the
 * client returns a normalised `AsrSegment[]` shape the orchestrator
 * can feed to the LLM speaker-ID step.
 *
 * When BOTH endpoints fail (or the API key is for a tenant without
 * ASR access), the caller falls back to the ffmpeg silence-detect
 * heuristic in src/skills/ffmpeg.ts → findLongestSpeechSegment().
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { getActiveMiniMaxKey, minimaxBaseUrl } from "./minimax-voice-clone.js";

export interface AsrSegment {
  /** Speaker label · MiniMax emits "Speaker 1", "Speaker 2" when
   *  diarization is on. May be undefined for single-speaker output. */
  speaker?: string;
  text: string;
  startSec: number;
  endSec: number;
}

export interface TranscribeOpts {
  filePath: string;
  apiKey?: string;
  signal?: AbortSignal;
  /** Hint at the dominant language · "zh" / "en" / "auto". Defaults
   *  to "auto" so MiniMax picks. */
  language?: string;
  /** Request speaker diarization when supported. */
  enableDiarization?: boolean;
}

/** Loose segment shape · MiniMax's segment payload varies between
 *  endpoints and revisions; we accept any reasonable subset, indexed
 *  via optional string keys. The normaliser handles missing fields. */
interface MiniMaxAsrSegmentRaw {
  speaker?: string | number;
  text?: string;
  start?: number;
  end?: number;
  start_time?: number;
  end_time?: number;
  begin_time?: number;
  end_time_ms?: number;
}

interface MiniMaxAsrResponse {
  segments?: MiniMaxAsrSegmentRaw[];
  results?: MiniMaxAsrSegmentRaw[];
  text?: string;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
}

const ASR_ENDPOINTS: ReadonlyArray<string> = [
  "/v1/audio_transcription",
  "/v1/voice/recognition",
];

/** Attempt ASR via MiniMax. Returns null when no endpoint responds
 *  with a usable shape — caller is expected to fall back to a
 *  heuristic clipper. Throws only on transport-level failures that
 *  suggest a wider outage (network down, key missing). */
export async function transcribeAudio(opts: TranscribeOpts): Promise<AsrSegment[] | null> {
  const apiKey = opts.apiKey ?? getActiveMiniMaxKey();
  const buf = await readFile(opts.filePath);
  const filename = basename(opts.filePath);

  let lastError: Error | null = null;

  for (const path of ASR_ENDPOINTS) {
    try {
      const segs = await callAsrEndpoint({
        url: `${minimaxBaseUrl()}${path}`,
        apiKey,
        signal: opts.signal,
        fileBuffer: buf,
        filename,
        language: opts.language,
        enableDiarization: opts.enableDiarization ?? true,
      });
      if (segs && segs.length > 0) return segs;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // 404 → endpoint doesn't exist on this region · try the next.
      // Other errors → keep last error and also try the next; if all
      // endpoints fail we surface the latest error message.
      lastError = err;
      if (!/HTTP 404/.test(err.message)) {
        process.stderr.write(
          `[minimax-asr] ${path} failed: ${err.message.slice(0, 200)}\n`,
        );
      }
    }
  }

  if (lastError) {
    process.stderr.write(
      `[minimax-asr] all endpoints exhausted · last error: ${lastError.message.slice(0, 200)}\n`,
    );
  }
  return null;
}

async function callAsrEndpoint(opts: {
  url: string;
  apiKey: string;
  signal?: AbortSignal;
  fileBuffer: Buffer;
  filename: string;
  language?: string;
  enableDiarization: boolean;
}): Promise<AsrSegment[] | null> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(opts.fileBuffer)], { type: guessMime(opts.filename) }),
    opts.filename,
  );
  if (opts.language) form.append("language", opts.language);
  if (opts.enableDiarization) {
    form.append("enable_diarization", "true");
    form.append("diarization", "true");
  }
  form.append("response_format", "verbose_json");
  // Request timestamps. Different endpoint versions accept different
  // flags · sending all of them is harmless and lets the same client
  // work across MiniMax revisions.
  form.append("timestamp_granularities[]", "segment");
  form.append("enable_punctuation", "true");

  const res = await fetch(opts.url, {
    method: "POST",
    signal: opts.signal,
    headers: {
      "authorization": `Bearer ${opts.apiKey}`,
    },
    body: form,
  });
  const text = await res.text();
  if (res.status === 404) {
    throw new Error(`MiniMax ASR HTTP 404: ${opts.url}`);
  }
  if (!res.ok) {
    throw new Error(`MiniMax ASR HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  let parsed: MiniMaxAsrResponse;
  try {
    parsed = JSON.parse(text) as MiniMaxAsrResponse;
  } catch {
    throw new Error(`MiniMax ASR returned non-JSON: ${text.slice(0, 200)}`);
  }
  const code = parsed.base_resp?.status_code;
  if (typeof code === "number" && code !== 0) {
    throw new Error(
      `MiniMax ASR failed · status_code=${code} · ${parsed.base_resp?.status_msg || "unknown error"}`,
    );
  }
  return normaliseSegments(parsed);
}

function normaliseSegments(r: MiniMaxAsrResponse): AsrSegment[] | null {
  const rawSegs = r.segments || r.results || [];
  if (rawSegs.length === 0 && typeof r.text === "string" && r.text.trim()) {
    // Endpoint returned a flat transcript with no timestamps — treat
    // the whole utterance as one segment from t=0 onward. Better than
    // nothing for the speaker-ID prompt.
    return [{ text: r.text.trim(), startSec: 0, endSec: 0 }];
  }
  const out: AsrSegment[] = [];
  for (const seg of rawSegs) {
    const text = typeof seg.text === "string" ? seg.text.trim() : "";
    if (!text) continue;
    const startSec = pickTime(seg.start, seg.start_time, seg.begin_time);
    const endSec = pickTime(seg.end, seg.end_time, seg.end_time_ms);
    out.push({
      speaker: seg.speaker !== undefined ? String(seg.speaker) : undefined,
      text,
      startSec,
      endSec: endSec > startSec ? endSec : startSec + Math.max(text.length / 6, 1),
    });
  }
  return out.length > 0 ? out : null;
}

function pickTime(...candidates: Array<number | undefined>): number {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c >= 0) {
      // MiniMax sometimes returns milliseconds for *_time_ms fields;
      // detect by magnitude (>10_000 = ms for a typical short clip).
      return c > 10_000 ? c / 1000 : c;
    }
  }
  return 0;
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
