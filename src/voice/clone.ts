/* voice/clone · MiniMax + ElevenLabs voice cloning REST adapters.
 *
 * Both providers ultimately want a short audio sample (10s-3min)
 * and a label, and they return a `voice_id` that can be plugged
 * straight back into the existing t2a_v2 / text-to-speech pipelines.
 *
 *  · MiniMax · two-step (upload to /v1/files/upload, then call
 *    /v1/voice_clone with the file_id). The Group ID is read from
 *    the JWT key (it's encoded as a `GroupID` claim) so the user
 *    doesn't need to surface it separately.
 *  · ElevenLabs · single-step IVC via multipart POST to
 *    /v1/voices/add. PVC is intentionally not supported here —
 *    it requires a 30-minute sample and a web-side verification
 *    recording, neither of which fits the "paste a YouTube URL"
 *    flow we're building.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { randomBytes } from "node:crypto";

export type CloneProvider = "minimax" | "elevenlabs";

export interface CloneInput {
  provider: CloneProvider;
  apiKey: string;          // plaintext, decrypted by caller
  audioPath: string;       // absolute path to mp3 / m4a / wav
  agentId: string;         // used to generate stable provider voice_id (MiniMax)
  label?: string | null;   // user-friendly name for the new voice
  miniMaxBaseUrl?: string; // override · defaults derived from region
  /** Explicit Group ID override · used when the user's MiniMax key
   *  isn't a JWT (older `ApiKey` issuance) and we can't extract the
   *  Group ID from the token itself. UI surfaces a textbox to collect
   *  it; backend route passes it through. */
  miniMaxGroupId?: string | null;
  onProgress?: (pct: number, stage: "upload" | "clone") => void;
  signal?: AbortSignal;
}

export interface CloneResult {
  voiceId: string;
  /** Cloned voice's display label as the provider stored it. */
  label: string;
}

export type CloneErrorCode =
  | "audio_too_short"
  | "audio_too_long"
  | "audio_too_large"
  | "audio_unreadable"
  | "provider_auth"
  | "provider_quota"
  | "provider_invalid_voice_id"
  | "provider_unknown"
  | "cancelled"
  | "missing_group_id";

export class CloneError extends Error {
  code: CloneErrorCode;
  detail: string;
  constructor(code: CloneErrorCode, message: string, detail = "") {
    super(message);
    this.name = "CloneError";
    this.code = code;
    this.detail = detail;
  }
}

const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20MB cap (both providers)
const MIN_AUDIO_BYTES = 32 * 1024;        // 32KB · catches near-empty files

/** Try to read the MiniMax `GroupID` claim out of a JWT.
 *  Returns null if the key isn't a JWT or has no claim. The caller
 *  raises `missing_group_id` so the user sees a clear message
 *  rather than a 401 from the upload endpoint. */
export function extractMiniMaxGroupId(jwt: string): string | null {
  // JWTs are three base64url-encoded segments separated by '.'
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const candidates = ["GroupID", "group_id", "groupId", "g"];
    for (const k of candidates) {
      const v = payload[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/** Public · the entry the route layer calls. Dispatches on provider. */
export async function cloneFromAudio(input: CloneInput): Promise<CloneResult> {
  validateAudioFile(input.audioPath);
  if (input.provider === "minimax") return cloneMiniMax(input);
  if (input.provider === "elevenlabs") return cloneElevenLabs(input);
  throw new CloneError("provider_unknown", `Unsupported provider ${String(input.provider)}`);
}

function validateAudioFile(path: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (e) {
    throw new CloneError("audio_unreadable", "Could not read audio file", String(e));
  }
  if (size < MIN_AUDIO_BYTES) throw new CloneError("audio_too_short", "Audio file is too small to clone from");
  if (size > MAX_AUDIO_BYTES) throw new CloneError("audio_too_large", "Audio file exceeds 20MB");
}

/* ── MiniMax ───────────────────────────────────────────────────────── */

async function cloneMiniMax(input: CloneInput): Promise<CloneResult> {
  // Explicit override wins; otherwise try the JWT claim. If both
  // miss, the user's MiniMax credential is the legacy ApiKey form
  // and they need to supply the Group ID manually in the modal.
  const groupId = (input.miniMaxGroupId && input.miniMaxGroupId.trim())
    || extractMiniMaxGroupId(input.apiKey);
  if (!groupId) {
    throw new CloneError(
      "missing_group_id",
      "MiniMax needs a Group ID for voice cloning. Paste it into the \"MiniMax Group ID\" field on the clone dialog, or re-paste a JWT-format key that already carries the ID.",
    );
  }
  const baseUrl = input.miniMaxBaseUrl || "https://api.minimaxi.com";
  // Step 1 · upload audio · stream-based so the UI can show real
  // byte-by-byte progress over the 1-15s upload window.
  input.onProgress?.(0, "upload");
  const fileBuf = readFileSync(input.audioPath);
  const fileName = basename(input.audioPath);
  const upRes = await streamMultipartUpload({
    url: `${baseUrl}/v1/files/upload?GroupId=${encodeURIComponent(groupId)}`,
    headers: { "authorization": `Bearer ${input.apiKey}` },
    fields: { purpose: "voice_clone" },
    files: [{ fieldName: "file", bytes: fileBuf, mime: mimeForName(fileName), fileName }],
    onProgress: (pct) => input.onProgress?.(pct, "upload"),
    signal: input.signal,
  });
  if (!upRes.ok) throw await translateMinimaxError(upRes, "upload");
  const upJson = await upRes.json() as { file?: { file_id?: number | string }; base_resp?: { status_code?: number; status_msg?: string } };
  const fileId = upJson.file?.file_id;
  if (!fileId) {
    const msg = upJson.base_resp?.status_msg || "unknown error";
    throw new CloneError("provider_unknown", `MiniMax upload returned no file_id: ${msg}`);
  }
  input.onProgress?.(100, "upload");

  // Step 2 · clone
  input.onProgress?.(0, "clone");
  // MiniMax requires a client-supplied voice_id ≥ 8 chars matching
  // [A-Za-z0-9_-]. Derive it from the user-supplied label when
  // possible so the MiniMax dashboard / `/v1/get_voice` catalogue
  // shows something recognisable (e.g. "Chloe_l5xqf0") instead of
  // the opaque `pb_<agentId>_<ts>` fallback.
  const voiceId = buildMiniMaxVoiceId(input.agentId, input.label || null);
  const cloneRes = await fetch(`${baseUrl}/v1/voice_clone?GroupId=${encodeURIComponent(groupId)}`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      file_id: fileId,
      voice_id: voiceId,
      need_noise_reduction: true,
      need_volume_normalization: true,
    }),
    signal: input.signal,
  });
  if (!cloneRes.ok) throw await translateMinimaxError(cloneRes, "clone");
  const cloneJson = await cloneRes.json() as { base_resp?: { status_code?: number; status_msg?: string } };
  const status = cloneJson.base_resp?.status_code ?? 0;
  if (status !== 0) {
    const msg = cloneJson.base_resp?.status_msg || "unknown error";
    if (status === 1008 || /insufficient/i.test(msg)) {
      throw new CloneError("provider_quota", "MiniMax balance is insufficient for voice cloning.", msg);
    }
    if (/voice[_ ]id/i.test(msg)) {
      throw new CloneError("provider_invalid_voice_id", `MiniMax rejected the voice_id: ${msg}`);
    }
    throw new CloneError("provider_unknown", `MiniMax voice_clone failed (${status}): ${msg}`);
  }
  input.onProgress?.(100, "clone");
  return { voiceId, label: input.label?.trim() || `Cloned · ${voiceId}` };
}

async function translateMinimaxError(res: Response, where: "upload" | "clone"): Promise<CloneError> {
  const text = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) {
    return new CloneError("provider_auth", "MiniMax rejected the API key. Re-check it in voice settings.", text);
  }
  if (res.status === 402 || /insufficient/i.test(text)) {
    return new CloneError("provider_quota", "MiniMax balance is insufficient for voice cloning.", text);
  }
  return new CloneError("provider_unknown", `MiniMax ${where} returned HTTP ${res.status}`, text);
}

function buildMiniMaxVoiceId(agentId: string, label: string | null): string {
  // ≥8 chars, matches [A-Za-z0-9_-]. Prefer label-derived ids so the
  // MiniMax dashboard shows "Chloe_l5xqf0" rather than an opaque
  // hash. Fall back to the agent slug when the label is empty or
  // strips to nothing (CJK / emoji-only labels).
  const ts = Date.now().toString(36);
  const sanitizedLabel = (label || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16);
  if (sanitizedLabel && sanitizedLabel.length >= 2) {
    return `${sanitizedLabel}_${ts}`;
  }
  const safeAgent = agentId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "director";
  return `pb_${safeAgent}_${ts}`;
}

/* ── ElevenLabs · IVC ─────────────────────────────────────────────── */

async function cloneElevenLabs(input: CloneInput): Promise<CloneResult> {
  input.onProgress?.(0, "upload");
  const fileBuf = readFileSync(input.audioPath);
  const fileName = basename(input.audioPath);
  const label = input.label?.trim() || `Cloned · ${input.agentId.slice(0, 8)}`;
  // ElevenLabs lumps upload + clone into one request — `clone` stage
  // is essentially the server processing time of the same call. We
  // emit byte progress through the upload phase, then flip to clone
  // while the response (server-side training) is in flight.
  const res = await streamMultipartUpload({
    url: `https://api.elevenlabs.io/v1/voices/add`,
    headers: { "xi-api-key": input.apiKey },
    fields: { name: label },
    files: [{ fieldName: "files", bytes: fileBuf, mime: mimeForName(fileName), fileName }],
    onProgress: (pct) => input.onProgress?.(pct, "upload"),
    signal: input.signal,
  });
  input.onProgress?.(100, "upload");
  input.onProgress?.(0, "clone");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401) throw new CloneError("provider_auth", "ElevenLabs rejected the API key.", text);
    if (res.status === 402 || /paid_plan_required|quota_exceeded|insufficient/i.test(text)) {
      throw new CloneError("provider_quota", "ElevenLabs subscription doesn't allow voice cloning, or you're out of credits.", text);
    }
    throw new CloneError("provider_unknown", `ElevenLabs voices/add returned HTTP ${res.status}`, text);
  }
  const json = await res.json() as { voice_id?: string };
  const voiceId = json.voice_id;
  if (!voiceId) throw new CloneError("provider_unknown", "ElevenLabs returned no voice_id");
  input.onProgress?.(100, "clone");
  return { voiceId, label };
}

/** Stream a multipart/form-data POST · the standard `FormData + fetch`
 *  combination in Node has no hook for upload progress, so we hand-roll
 *  the multipart body as a `ReadableStream` and emit byte progress as
 *  the consumer (undici / fetch) pulls each chunk off. Total byte
 *  count is computed up front so we can send a real `Content-Length`
 *  header (many providers reject chunked transfer for multipart) and
 *  report progress as a stable 0-100%.
 *
 *  Requires Node 18+ (ReadableStream + `duplex: "half"`). */
interface StreamMultipartOpts {
  url: string;
  headers: Record<string, string>;
  fields: Record<string, string>;
  files: Array<{ fieldName: string; bytes: Buffer; mime: string; fileName: string }>;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

async function streamMultipartUpload(opts: StreamMultipartOpts): Promise<Response> {
  const boundary = `----pb-vc-${randomBytes(8).toString("hex")}`;
  const CRLF = "\r\n";
  const enc = (s: string): Buffer => Buffer.from(s, "utf8");

  const partsBeforeFiles: Buffer[] = [];
  for (const [k, v] of Object.entries(opts.fields)) {
    partsBeforeFiles.push(enc(`--${boundary}${CRLF}`));
    partsBeforeFiles.push(enc(`Content-Disposition: form-data; name="${k}"${CRLF}${CRLF}`));
    partsBeforeFiles.push(enc(`${v}${CRLF}`));
  }
  const filePreludes: Buffer[] = opts.files.map((f) => enc(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${f.fieldName}"; filename="${f.fileName}"${CRLF}` +
    `Content-Type: ${f.mime}${CRLF}${CRLF}`,
  ));
  const fileEndings: Buffer[] = opts.files.map(() => enc(CRLF));
  const closing = enc(`--${boundary}--${CRLF}`);

  // Sum total bytes for Content-Length. Files are the bulk; field /
  // prelude buffers are sub-1KB each.
  let total = 0;
  for (const b of partsBeforeFiles) total += b.length;
  for (let i = 0; i < opts.files.length; i++) {
    total += filePreludes[i].length + opts.files[i].bytes.length + fileEndings[i].length;
  }
  total += closing.length;

  // The stream emits, in order:
  //   1. one chunk per `partsBeforeFiles` Buffer
  //   2. for each file: its prelude, then 64KB body chunks, then CRLF
  //   3. the closing boundary
  // `pull` is called by the consumer one chunk at a time, so progress
  // tracks actual socket back-pressure rather than the in-memory enqueue.
  const CHUNK_SIZE = 64 * 1024;
  type Step =
    | { kind: "fixed"; idx: number; list: Buffer[] }
    | { kind: "fileBody"; fileIdx: number; off: number }
    | { kind: "closing" }
    | { kind: "done" };
  let step: Step = { kind: "fixed", idx: 0, list: partsBeforeFiles };
  let sent = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      for (;;) {
        if (step.kind === "done") {
          controller.close();
          return;
        }
        if (step.kind === "fixed") {
          if (step.idx >= step.list.length) {
            // Advance to next phase: either first file body or closing.
            if (opts.files.length === 0) step = { kind: "closing" };
            else {
              // Emit first file's prelude here, then body next.
              controller.enqueue(filePreludes[0]);
              sent += filePreludes[0].length;
              opts.onProgress?.(Math.min(99, (sent / total) * 100));
              step = { kind: "fileBody", fileIdx: 0, off: 0 };
              return;
            }
            continue;
          }
          const chunk = step.list[step.idx++];
          controller.enqueue(chunk);
          sent += chunk.length;
          opts.onProgress?.(Math.min(99, (sent / total) * 100));
          return;
        }
        if (step.kind === "fileBody") {
          const file = opts.files[step.fileIdx];
          if (step.off >= file.bytes.length) {
            // Emit trailing CRLF, then advance to next file or closing.
            const ending = fileEndings[step.fileIdx];
            controller.enqueue(ending);
            sent += ending.length;
            opts.onProgress?.(Math.min(99, (sent / total) * 100));
            const nextIdx = step.fileIdx + 1;
            if (nextIdx >= opts.files.length) {
              step = { kind: "closing" };
            } else {
              controller.enqueue(filePreludes[nextIdx]);
              sent += filePreludes[nextIdx].length;
              opts.onProgress?.(Math.min(99, (sent / total) * 100));
              step = { kind: "fileBody", fileIdx: nextIdx, off: 0 };
            }
            return;
          }
          const slice = file.bytes.subarray(step.off, step.off + CHUNK_SIZE);
          controller.enqueue(slice);
          step.off += slice.length;
          sent += slice.length;
          opts.onProgress?.(Math.min(99, (sent / total) * 100));
          return;
        }
        if (step.kind === "closing") {
          controller.enqueue(closing);
          sent += closing.length;
          opts.onProgress?.(100);
          step = { kind: "done" };
          return;
        }
      }
    },
    cancel() {
      step = { kind: "done" };
    },
  });

  const fetchInit: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers: {
      ...opts.headers,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(total),
    },
    body: stream,
    duplex: "half",
    signal: opts.signal,
  };
  return await fetch(opts.url, fetchInit);
}

function mimeForName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  return "application/octet-stream";
}
