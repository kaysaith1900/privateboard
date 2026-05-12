/**
 * /api/topic-recs · interest-driven topic recommendations.
 *
 *   POST /                            → start a new generation job
 *   GET  /jobs/:id/stream             → SSE: hello + phase events + terminal
 *   POST /jobs/:id/abort              → cancel an in-flight job
 *   GET  /                            → cursor-paginated list (newest first)
 *   GET  /:id                         → one rec with full seedContext
 *
 * Mirrors the persona-builder routes in `routes/agents.ts` —
 * same SSE rehydrate pattern, same abort semantics, same job
 * row lifecycle.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { hasAnyModelKey } from "../ai/availability.js";
import {
  abortTopicRecommend,
  isTopicRecJobRunning,
  startTopicRecommend,
} from "../orchestrator/topic-recommender.js";
import { topicRecBus, type TopicRecEvent } from "../orchestrator/topic-stream.js";
import {
  getTopicRec,
  getTopicRecJob,
  listTopicRecs,
} from "../storage/topic-recs.js";

export function topicRecsRouter(): Hono {
  const r = new Hono();

  // ── Start a generation job ───────────────────────────────
  r.post("/", (c) => {
    if (!hasAnyModelKey()) {
      return c.json({ error: "configure an LLM provider key first" }, 400);
    }
    const jobId = startTopicRecommend();
    return c.json({ jobId });
  });

  // ── SSE event stream for a single job ───────────────────
  r.get("/jobs/:id/stream", (c) => {
    const jobId = c.req.param("id");
    const job = getTopicRecJob(jobId);
    if (!job) return c.json({ error: "job not found" }, 404);

    return streamSSE(c, async (s) => {
      // Greet · gives the client enough to render the progress
      // strip immediately, including for late subscribers that
      // attached after a phase boundary.
      await s.writeSSE({
        event: "hello",
        data: JSON.stringify({
          jobId,
          status: job.status,
          currentPhase: job.currentPhase,
          progressPct: job.progressPct,
          batchId: job.batchId,
          error: job.error,
        }),
      });

      // Already-terminal · send the matching terminal event +
      // close. The bus has already been dropped.
      if (!isTopicRecJobRunning(jobId)) {
        if (job.status === "done") {
          await s.writeSSE({
            event: "topic-final",
            data: JSON.stringify({
              type: "topic-final",
              batchId: job.batchId,
              totalRecs: null,
              hasWeb: null,
            }),
          });
        } else if (job.status === "aborted") {
          await s.writeSSE({
            event: "topic-aborted",
            data: JSON.stringify({ type: "topic-aborted" }),
          });
        } else if (job.status === "failed") {
          await s.writeSSE({
            event: "topic-error",
            data: JSON.stringify({
              type: "topic-error",
              message: job.error || "generation failed",
            }),
          });
        }
        return;
      }

      // Live · subscribe + pump until terminal.
      const queue: TopicRecEvent[] = [];
      let resolveWaiter: (() => void) | null = null;
      let closed = false;

      const off = topicRecBus.subscribe(jobId, (event) => {
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
        if (event.type === "topic-final" || event.type === "topic-error" || event.type === "topic-aborted") {
          closed = true;
          off();
        }
      }
    });
  });

  // ── Abort an in-flight job ──────────────────────────────
  r.post("/jobs/:id/abort", (c) => {
    const jobId = c.req.param("id");
    const ok = abortTopicRecommend(jobId);
    if (!ok) {
      const job = getTopicRecJob(jobId);
      if (!job) return c.json({ error: "job not found" }, 404);
      // Already terminal · idempotent.
      return c.json({ ok: true, status: job.status });
    }
    return c.json({ ok: true });
  });

  // ── List recommendations (cursor-paginated) ─────────────
  r.get("/", (c) => {
    const cursorRaw = c.req.query("cursor");
    const limitRaw = c.req.query("limit");
    const cursor = cursorRaw && /^\d+$/.test(cursorRaw) ? Number(cursorRaw) : null;
    const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.max(1, Math.min(100, Number(limitRaw))) : 20;
    const { items, nextCursor } = listTopicRecs({ cursor, limit });
    return c.json({ items, nextCursor });
  });

  // ── Single rec (with full seedContext) ──────────────────
  r.get("/:id", (c) => {
    const id = c.req.param("id");
    const rec = getTopicRec(id);
    if (!rec) return c.json({ error: "not found" }, 404);
    return c.json(rec);
  });

  return r;
}
