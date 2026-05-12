/**
 * Per-job event bus for the interest-driven topic-recommendation
 * pipeline. Mirrors the shape of `personaBus` (`persona-stream.ts`)
 * 1:1 so the SSE route in `src/routes/topic-recs.ts` stays
 * familiar to anyone who's already read the persona handler.
 *
 * The pipeline at `src/orchestrator/topic-recommender.ts` emits
 * here; the SSE route subscribes per connected client and
 * forwards events down the wire.
 */
import { EventEmitter } from "node:events";

import type { TopicRec, TopicRecSnippet } from "../storage/topic-recs.js";

/** Discriminated union of every event the pipeline can emit.
 *  The SSE route maps each variant to a named SSE `event:` field. */
export type TopicRecEvent =
  | {
      /** Phase entered · UI flips that row to active. */
      type: "topic-phase-start";
      phase: number;             // 1..4
      label: string;             // "Reading your boardroom history" · "Distilling keywords" · ...
    }
  | {
      /** Phase still running · sub-detail (current keyword being
       *  searched, "scanning 7 of 10 keywords", etc.). */
      type: "topic-phase-progress";
      phase: number;
      detail: string;
      progressPct: number;       // 0..100, monotonic
    }
  | {
      /** Phase complete · UI flips that row to done. */
      type: "topic-phase-end";
      phase: number;
      progressPct: number;
    }
  | {
      /** Pipeline produced one recommendation row · the route
       *  pushes it through SSE so the UI can render cards as they
       *  land instead of waiting for the whole synthesis to
       *  finish. */
      type: "topic-rec";
      rec: TopicRec;
    }
  | {
      /** Phase 3 sub-event · the planner just ran one web-search
       *  query. Lets the UI show a query log alongside the phase
       *  progress (mirrors persona's `persona-search-round`). */
      type: "topic-search-round";
      keyword: string;
      query: string;
      resultsCount: number;
      snippets: TopicRecSnippet[];
    }
  | {
      /** Pipeline finished cleanly · job row is now `done`. */
      type: "topic-final";
      batchId: string;
      totalRecs: number;
      hasWeb: boolean;
    }
  | {
      /** Hard failure · job row is `failed`. */
      type: "topic-error";
      message: string;
    }
  | {
      /** User aborted via the cancel button · job row is `aborted`. */
      type: "topic-aborted";
    };

class TopicRecBus {
  private emitters = new Map<string, EventEmitter>();

  private get(jobId: string): EventEmitter {
    let e = this.emitters.get(jobId);
    if (!e) {
      e = new EventEmitter();
      // Same cap as personaBus · enough headroom for a reconnect
      // mid-build plus a dev-tools subscriber.
      e.setMaxListeners(16);
      this.emitters.set(jobId, e);
    }
    return e;
  }

  emit(jobId: string, event: TopicRecEvent): void {
    this.get(jobId).emit("event", event);
  }

  subscribe(jobId: string, listener: (event: TopicRecEvent) => void): () => void {
    const e = this.get(jobId);
    e.on("event", listener);
    return () => e.off("event", listener);
  }

  /** Free the EventEmitter for a job. Call on terminal events
   *  (`topic-final`, `topic-error`, `topic-aborted`) so the Map
   *  doesn't grow unbounded across many runs in one process. */
  drop(jobId: string): void {
    const e = this.emitters.get(jobId);
    if (e) {
      e.removeAllListeners();
      this.emitters.delete(jobId);
    }
  }
}

export const topicRecBus = new TopicRecBus();
