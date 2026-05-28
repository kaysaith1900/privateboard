/* voice-clone routes · the one-shot pipeline that runs a director's
 *  voice cloning job from "user clicked Confirm" to "new voice_id
 *  written into the agent's voice_json".
 *
 *  Endpoints:
 *   · POST  /api/voice-clone/upload      · multipart audio upload
 *                                          (returns a tmp filePath)
 *   · POST  /api/voice-clone/start       · queue a job; returns jobId
 *   · GET   /api/voice-clone/:id/stream  · SSE progress stream
 *   · GET   /api/voice-clone/:id         · snapshot (used when the
 *                                          modal re-opens via popout)
 *   · DELETE /api/voice-clone/:id        · cancel job
 *
 *  Concurrency model · only ONE active job per process · the UI
 *  routes a second "Clone" click to a popover instead of stacking.
 *  This is enforced by the storage layer
 *  (`findAnyActiveJob`) so a restart can recover even if the user
 *  somehow raced two requests.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCloneJob,
  findActiveJobForAgent,
  findAnyActiveJob,
  getCloneJob,
  updateCloneJobProgress,
  type CloneJob,
  type CloneJobStage,
} from "../storage/clone-jobs.js";
import { cloneFromAudio, CloneError } from "../voice/clone.js";
import { invalidateVoicesCache } from "../voice/registry.js";
import { setVoiceLabel } from "../storage/voice-labels.js";
import { getActiveVoiceKeyPlaintext, getActiveVoiceProvider } from "../storage/voice-credentials.js";
import { getPrefs } from "../storage/prefs.js";
import { updateAgent, getAgent, writeVoiceBucketEntry } from "../storage/agents.js";

/** Lightweight in-memory bus for SSE consumers. The clone_jobs row
 *  is the durable source of truth; this emitter just lets us push
 *  events to the open SSE connection without polling. */
interface CloneEvent {
  jobId: string;
  stage: CloneJobStage;
  pct: number;
  status: CloneJob["status"];
  message?: string;
  voiceId?: string | null;
  /** Provider the clone job ran against (minimax | elevenlabs). Set
   *  on terminal `done` events so the modal's preview-playback flow
   *  can target the right TTS endpoint without guessing. */
  provider?: CloneJob["provider"];
  errorCode?: string | null;
  errorMessage?: string | null;
  ts: number;
}

const listeners = new Map<string, Set<(e: CloneEvent) => void>>();

function emit(ev: CloneEvent): void {
  const set = listeners.get(ev.jobId);
  if (!set) return;
  for (const fn of set) {
    try { fn(ev); } catch { /* SSE consumer hung up */ }
  }
}

function subscribe(jobId: string, fn: (e: CloneEvent) => void): () => void {
  let set = listeners.get(jobId);
  if (!set) {
    set = new Set();
    listeners.set(jobId, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
    if (set?.size === 0) listeners.delete(jobId);
  };
}

/** Per-process abort handles · used by DELETE /:id to halt a worker
 *  mid-flight. AbortController is keyed by jobId. */
const aborters = new Map<string, AbortController>();

/** Per-job provider extras (e.g. MiniMax Group ID override) that
 *  don't warrant a clone_jobs column · the worker reads them via the
 *  jobId once and drops them when the job ends. */
const workerExtras = new Map<string, Record<string, unknown>>();

/** Build the overall % across the three stages (fetch/upload/clone).
 *  Each stage spans 1/3 of the bar; within a stage the inner pct
 *  refines the position. */
function overallPct(stage: CloneJobStage, innerPct: number): number {
  const stageIdx = stage === "fetch" ? 0 : stage === "upload" ? 1 : 2;
  return Math.round(stageIdx * (100 / 3) + (innerPct / 3));
}

function pushProgress(jobId: string, stage: CloneJobStage, innerPct: number, message?: string): void {
  const pct = overallPct(stage, innerPct);
  updateCloneJobProgress(jobId, { status: "running", currentStage: stage, pct });
  emit({ jobId, stage, pct, status: "running", message, ts: Date.now() });
}

async function runWorker(job: CloneJob): Promise<void> {
  const aborter = new AbortController();
  aborters.set(job.id, aborter);
  try {
    const apiKey = getActiveVoiceKeyPlaintext();
    if (!apiKey) {
      throw new CloneError("provider_auth", "No active voice credential. Configure one in voice settings first.");
    }

    // Stage 1 · fetch · only kind is "file" now (YouTube was retired
    // because YouTube's 2026 anti-bot wall blocked all stream URLs).
    // The browser-side trim + WAV encode runs before /upload, so by
    // the time we get here the file is exactly the clip the user
    // wants to clone from.
    const audioPath = job.sourceRef;
    pushProgress(job.id, "fetch", 100, "Using uploaded audio");

    // Stage 2 + 3 · upload + clone via provider adapter. The adapter
    // calls onProgress(pct, stage) with stage ∈ {upload, clone}.
    const extras = workerExtras.get(job.id) || {};
    const { voiceId, label } = await cloneFromAudio({
      provider: job.provider,
      apiKey,
      audioPath,
      agentId: job.agentId,
      label: job.label,
      miniMaxBaseUrl: job.provider === "minimax" ? minimaxBaseUrlFromPref() : undefined,
      miniMaxGroupId: job.provider === "minimax" && typeof extras.miniMaxGroupId === "string"
        ? extras.miniMaxGroupId
        : null,
      signal: aborter.signal,
      onProgress: (pct, stage) => {
        if (aborter.signal.aborted) return;
        pushProgress(job.id, stage, pct);
      },
    });

    // PATCH the agent's voice_json so the next utterance uses the
    // cloned voice. Preserve tuning params (speed/pitch/volume/emotion)
    // but DO NOT carry over the director's previous `model` · the
    // cloned voice lives on the provider's default cloning model and
    // any other value would mismatch the picker catalogue's row
    // (breaking dedup and showing two identical entries until reload).
    const agent = getAgent(job.agentId);
    const existing = agent?.voice;
    const cloneModel = job.provider === "minimax" ? "speech-2.8-hd" : "eleven_multilingual_v2";
    const updated = updateAgent(job.agentId, {
      voice: {
        provider: job.provider,
        model: cloneModel,
        voiceId,
        ...(existing?.speed != null ? { speed: existing.speed } : {}),
        ...(existing?.pitch != null ? { pitch: existing.pitch } : {}),
        ...(existing?.volume != null ? { volume: existing.volume } : {}),
        ...(existing?.emotion ? { emotion: existing.emotion } : {}),
      },
    });
    if (updated?.voice) writeVoiceBucketEntry(job.agentId, job.provider, updated.voice);

    // Persist the user-typed friendly name. MiniMax has no `name`
    // field on the voice_clone API, and ElevenLabs IVC's `name` is
    // already set during upload, so this is the only durable place
    // PrivateBoard owns the mapping between voice_id → display label.
    if (job.label) setVoiceLabel({ voiceId, provider: job.provider, label: job.label });

    // The provider's voice catalogue (`/v1/get_voice` for MiniMax,
    // `/v2/voices` for ElevenLabs) is cached on this server for 5
    // minutes. The just-cloned voice exists upstream but is invisible
    // in /api/voices and consequently in the picker UI until that
    // cache expires. Drop it here so the next picker open re-fetches
    // a fresh catalogue with the new voice_id in it.
    invalidateVoicesCache();

    updateCloneJobProgress(job.id, {
      status: "done",
      currentStage: "clone",
      pct: 100,
      voiceId,
      errorCode: null,
      errorMessage: null,
    });
    emit({
      jobId: job.id,
      stage: "clone",
      pct: 100,
      status: "done",
      voiceId,
      message: label,
      provider: job.provider,
      ts: Date.now(),
    });
  } catch (e) {
    const { code, message } = normaliseError(e);
    updateCloneJobProgress(job.id, {
      status: aborters.has(job.id) ? "failed" : "cancelled",
      errorCode: code,
      errorMessage: message,
    });
    emit({
      jobId: job.id,
      stage: getCloneJob(job.id)?.currentStage || "fetch",
      pct: getCloneJob(job.id)?.pct ?? 0,
      status: aborters.has(job.id) ? "failed" : "cancelled",
      errorCode: code,
      errorMessage: message,
      ts: Date.now(),
    });
  } finally {
    aborters.delete(job.id);
    workerExtras.delete(job.id);
  }
}

function normaliseError(e: unknown): { code: string; message: string } {
  // CloneError surfaces provider-side reasons (auth, quota, invalid
  // voice_id, …) with a `detail` tail; append a short slice so the
  // UI's progress text shows the actual cause without dumping a
  // 2 KB JSON blob.
  if (e instanceof CloneError) {
    const detail = e.detail ? `\n${e.detail.slice(-360)}` : "";
    return { code: e.code, message: `${e.message}${detail}` };
  }
  if (e instanceof Error && e.name === "AbortError") return { code: "cancelled", message: "Clone was cancelled." };
  return { code: "unknown", message: e instanceof Error ? e.message : String(e) };
}

function minimaxBaseUrlFromPref(): string {
  // Match `minimaxBaseUrl()` in src/voice/tts.ts · prefer cn, fall back to intl.
  try {
    const region = getPrefs().minimaxRegion;
    return region === "intl" ? "https://api.minimax.io" : "https://api.minimaxi.com";
  } catch {
    return "https://api.minimaxi.com";
  }
}

export function voiceCloneRouter(): Hono {
  const r = new Hono();

  // Multipart audio upload · stash the file in tmp and return its
  // absolute path so /start can reference it without re-uploading.
  r.post("/upload", async (c) => {
    const ct = c.req.header("content-type") || "";
    if (!ct.toLowerCase().startsWith("multipart/form-data")) {
      return c.json({ error: "expected multipart/form-data" }, 400);
    }
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "missing file field" }, 400);
    }
    const safeName = String(file.name || "source").replace(/[^A-Za-z0-9_.\- ]/g, "_") || "source";
    const dir = join(tmpdir(), `pb-voice-clone-${randomBytes(6).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, safeName);
    const buf = Buffer.from(await file.arrayBuffer());
    writeFileSync(path, buf);
    return c.json({ filePath: path, size: buf.length, name: safeName });
  });

  // Start a clone job.
  r.post("/start", async (c) => {
    const body = await c.req.json<{
      agentId?: string;
      source?: { kind?: "file"; filePath?: string };
      label?: string;
      miniMaxGroupId?: string;
    }>();
    const agentId = body.agentId?.trim();
    const source = body.source || {};
    if (!agentId) return c.json({ error: "missing agentId" }, 400);
    if (!getAgent(agentId)) return c.json({ error: "unknown agent" }, 404);
    if (findAnyActiveJob()) {
      return c.json({ error: "another clone job is in progress" }, 409);
    }
    if (findActiveJobForAgent(agentId)) {
      return c.json({ error: "this director already has a clone in progress" }, 409);
    }

    if (source.kind !== "file" || !source.filePath) {
      return c.json({ error: "source must be { kind: 'file', filePath }" }, 400);
    }
    if (!existsSync(source.filePath) || !statSync(source.filePath).isFile()) {
      return c.json({ error: "uploaded file is missing" }, 400);
    }
    const kind: "file" = "file";
    const ref = source.filePath;

    const provider = getActiveVoiceProvider();
    if (provider !== "minimax" && provider !== "elevenlabs") {
      return c.json({ error: "active voice credential must be minimax or elevenlabs" }, 400);
    }

    const label = (body.label || "").trim();
    if (!label) {
      return c.json({ error: "label is required" }, 400);
    }

    const job = createCloneJob({
      agentId,
      provider,
      sourceKind: kind,
      sourceRef: ref,
      label,
    });

    // Stash provider-specific extras on the in-memory worker map; the
    // clone_jobs row keeps minimal schema, and these aren't worth a
    // migration since they're only relevant while the job runs.
    const extras: Record<string, unknown> = {};
    if (body.miniMaxGroupId) extras.miniMaxGroupId = body.miniMaxGroupId.trim();
    workerExtras.set(job.id, extras);

    // Fire-and-forget the worker · errors are caught inside and
    // written to the job row, so we don't need to await here.
    void runWorker(job);

    return c.json({ jobId: job.id, status: job.status });
  });

  r.get("/active", (c) => {
    const j = findAnyActiveJob();
    return c.json({ job: j ?? null });
  });

  r.get("/:id", (c) => {
    const j = getCloneJob(c.req.param("id"));
    if (!j) return c.json({ error: "not found" }, 404);
    return c.json({ job: j });
  });

  r.get("/:id/stream", async (c) => {
    const id = c.req.param("id");
    const initial = getCloneJob(id);
    if (!initial) return c.json({ error: "not found" }, 404);

    return streamSSE(c, async (s) => {
      // Emit current snapshot so a re-connecting client lands at
      // the right pct immediately (no flash of 0%).
      await s.writeSSE({
        event: "snapshot",
        data: JSON.stringify({
          jobId: initial.id,
          stage: initial.currentStage,
          pct: initial.pct,
          status: initial.status,
          voiceId: initial.voiceId,
          errorCode: initial.errorCode,
          errorMessage: initial.errorMessage,
          ts: Date.now(),
        }),
      });
      // Terminal-state jobs are done — write the final event and
      // close out so the client doesn't wait on a never-firing
      // listener.
      if (initial.status === "done" || initial.status === "failed" || initial.status === "cancelled") {
        await s.writeSSE({ event: "end", data: JSON.stringify({ jobId: id, status: initial.status }) });
        return;
      }

      const queue: CloneEvent[] = [];
      let wake: (() => void) | null = null;
      let closed = false;
      const off = subscribe(id, (ev) => {
        queue.push(ev);
        if (wake) { wake(); wake = null; }
      });
      s.onAbort(() => { closed = true; off(); if (wake) { wake(); wake = null; } });

      while (!closed) {
        if (queue.length === 0) {
          await new Promise<void>((res) => { wake = res; });
          if (closed) break;
        }
        const ev = queue.shift()!;
        await s.writeSSE({ event: "progress", data: JSON.stringify(ev) });
        if (ev.status === "done" || ev.status === "failed" || ev.status === "cancelled") {
          await s.writeSSE({ event: "end", data: JSON.stringify({ jobId: id, status: ev.status }) });
          break;
        }
      }
      off();
    });
  });

  r.delete("/:id", (c) => {
    const id = c.req.param("id");
    const job = getCloneJob(id);
    if (!job) return c.json({ error: "not found" }, 404);
    const aborter = aborters.get(id);
    if (aborter) {
      aborter.abort();
      aborters.delete(id);
    }
    updateCloneJobProgress(id, {
      status: "cancelled",
      errorCode: "cancelled",
      errorMessage: "Cancelled by user.",
    });
    emit({
      jobId: id,
      stage: job.currentStage,
      pct: job.pct,
      status: "cancelled",
      errorCode: "cancelled",
      errorMessage: "Cancelled by user.",
      ts: Date.now(),
    });
    // tmp file cleanup is left to the OS tmpdir reaper; we don't
    // hold open handles past worker exit.
    return c.json({ ok: true });
  });

  return r;
}

// Re-export for boot.ts so it can sweep stuck rows at startup.
export { recoverStuckCloneJobs } from "../storage/clone-jobs.js";

// Suppress unused-import warning for rmSync (kept for future cleanup pass).
void rmSync;
