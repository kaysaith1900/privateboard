/**
 * /api/voices/clone-from-video · public-video → cloned-voice pipeline.
 *
 * Three endpoints:
 *
 *   POST   /api/voices/clone-from-video
 *     body: { videoUrl, celebrity, agentId? }
 *     returns: { jobId }
 *
 *   GET    /api/voices/clone-from-video/:jobId/stream
 *     SSE · phase events + terminal final/error/aborted
 *
 *   POST   /api/voices/clone-from-video/:jobId/abort
 *     cancels the in-flight pipeline (idempotent · 200 either way)
 *
 *   GET    /api/voices/clone-from-video/recent
 *     lists the N most recent jobs · used by the agent composer UI
 *
 * The route surface intentionally mirrors `/api/agents/generate-persona/*`
 * (see src/routes/agents.ts) so the frontend SSE handler reuses the same
 * shape.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import {
  abortVoiceDistill,
  isVoiceDistillJobRunning,
  startVoiceDistill,
} from "../orchestrator/voice-distill.js";
import {
  voiceDistillBus,
  type VoiceDistillEvent,
} from "../orchestrator/voice-distill-stream.js";
import { getAgent } from "../storage/agents.js";
import {
  getVoiceDistillJob,
  listRecentVoiceDistillJobs,
} from "../storage/voice-distill-jobs.js";

interface CloneRequestBody {
  videoUrl?: unknown;
  celebrity?: unknown;
  agentId?: unknown;
}

export function voiceDistillRouter(): Hono {
  const r = new Hono();

  r.get("/recent", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") || 20), 1), 100);
    return c.json({ jobs: listRecentVoiceDistillJobs(limit) });
  });

  r.post("/", async (c) => {
    let body: CloneRequestBody;
    try { body = (await c.req.json()) as CloneRequestBody; }
    catch { return c.json({ error: "invalid JSON body" }, 400); }

    const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl.trim() : "";
    const celebrity = typeof body.celebrity === "string" ? body.celebrity.trim() : "";
    const agentId = typeof body.agentId === "string" && body.agentId.trim()
      ? body.agentId.trim()
      : null;

    if (!celebrity) return c.json({ error: "celebrity name is required" }, 400);
    // videoUrl is optional · when empty the orchestrator runs an
    // auto-search phase using yt-dlp's ytsearch: prefix to find a
    // suitable public video for the named celebrity.
    if (videoUrl && !/^https?:\/\//i.test(videoUrl)) {
      return c.json({ error: "videoUrl must start with http:// or https://" }, 400);
    }
    if (agentId && !getAgent(agentId)) {
      return c.json({ error: "agentId does not match a known agent" }, 404);
    }

    try {
      const jobId = startVoiceDistill({
        videoUrl: videoUrl || undefined,
        celebrity,
        agentId,
      });
      return c.json({ jobId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, 400);
    }
  });

  r.get("/:jobId/stream", (c) => {
    const jobId = c.req.param("jobId");
    const job = getVoiceDistillJob(jobId);
    if (!job) return c.json({ error: "job not found" }, 404);

    return streamSSE(c, async (s) => {
      // Greet · same shape as the persona stream's "hello" so the
      // frontend client glue is identical.
      await s.writeSSE({
        event: "hello",
        data: JSON.stringify({
          jobId,
          status: job.status,
          currentPhase: job.currentPhase,
          progressPct: job.progressPct,
          partial: job.partial,
          voiceId: job.voiceId,
          agentId: job.agentId,
          celebrity: job.celebrity,
          videoUrl: job.videoUrl,
        }),
      });

      // If the job has already terminated, send the terminal event
      // and close — don't sit in the bus loop.
      if (!isVoiceDistillJobRunning(jobId)) {
        if (job.status === "done" && job.voiceId) {
          await s.writeSSE({
            event: "voice-distill-final",
            data: JSON.stringify({
              type: "voice-distill-final",
              voiceId: job.voiceId,
              agentId: job.agentId,
              credentialLabel: `${job.celebrity} (cloned)`,
            }),
          });
        } else if (job.status === "aborted") {
          await s.writeSSE({
            event: "voice-distill-aborted",
            data: JSON.stringify({ type: "voice-distill-aborted" }),
          });
        } else if (job.status === "failed") {
          await s.writeSSE({
            event: "voice-distill-error",
            data: JSON.stringify({
              type: "voice-distill-error",
              message: job.error || "voice distill failed",
            }),
          });
        }
        return;
      }

      // Live · subscribe and pump events until terminal or client closes.
      const queue: VoiceDistillEvent[] = [];
      let resolveWaiter: (() => void) | null = null;
      let closed = false;

      const off = voiceDistillBus.subscribe(jobId, (event) => {
        queue.push(event);
        if (resolveWaiter) {
          resolveWaiter();
          resolveWaiter = null;
        }
      });

      s.onAbort(() => {
        closed = true;
        off();
        if (resolveWaiter) {
          resolveWaiter();
          resolveWaiter = null;
        }
      });

      while (!closed) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { resolveWaiter = resolve; });
          continue;
        }
        const event = queue.shift()!;
        await s.writeSSE({ event: event.type, data: JSON.stringify(event) });
        if (
          event.type === "voice-distill-final" ||
          event.type === "voice-distill-error" ||
          event.type === "voice-distill-aborted"
        ) {
          closed = true;
          off();
        }
      }
    });
  });

  r.post("/:jobId/abort", (c) => {
    const jobId = c.req.param("jobId");
    const ok = abortVoiceDistill(jobId);
    if (!ok) {
      const job = getVoiceDistillJob(jobId);
      if (!job) return c.json({ error: "job not found" }, 404);
      return c.json({ ok: true, status: job.status });
    }
    return c.json({ ok: true });
  });

  return r;
}
