/**
 * Per-job event bus for the Full-persona builder. Mirrors the shape
 * of `roomBus` (`stream.ts`) so the SSE handler in `routes/agents.ts`
 * stays familiar to anyone who's already read the room SSE handler.
 *
 * Why a separate bus, not a key in `roomBus` keyed by jobId:
 *   · `roomBus` is consumed by `/api/rooms/:id/stream` in app.js,
 *     which knows the union of `RoomEvent` shapes and would need to
 *     learn about persona events to stay typesafe. Bending a room
 *     subscriber for non-room jobs pollutes the boundary.
 *   · `RoomEvent` is keyed by structural shapes (message-token, etc.)
 *     that have nothing in common with persona-build progress. Two
 *     different vocabularies in one bus means every consumer has to
 *     filter — easy to miss, easy to over-deliver.
 *
 * The persona pipeline `src/orchestrator/persona-builder.ts` emits
 * here; the SSE route in `routes/agents.ts` subscribes per connected
 * client and forwards.
 */
import { EventEmitter } from "node:events";

import type { PersonaSpec } from "../storage/agents.js";

/** Structured record of one thing that happened during a build. Saved
 *  alongside the final `PersonaSpec.buildLog.events` so the agent
 *  profile can render a timeline + per-dimension card grid after the
 *  build is gone from memory. Distinct from the live SSE `PersonaEvent`
 *  union: events are forward-only / lossy on disconnect; `BuildEvent`
 *  is durable and trimmed to what the user-facing build-log modal
 *  actually renders (no progress noise, no SSE-only signalling). */
export type BuildEvent =
  | { kind: "phase-start"; ts: number; phase: number; label: string }
  | { kind: "phase-end"; ts: number; phase: number; durationMs: number }
  | {
      kind: "dimension-plan";
      ts: number;
      dimensions: Array<{ dimension: string; query: string; why: string }>;
    }
  | {
      kind: "search";
      ts: number;
      query: string;
      resultsCount: number;
      pagesRead: number;
      dimension?: string;
      round?: number;
      topup?: boolean;
    }
  | { kind: "divergence"; ts: number; score: number | null }
  | { kind: "error"; ts: number; message: string };

/** Discriminated union of every event the persona pipeline can emit.
 *  The SSE route maps each variant to a named SSE `event:` field so
 *  the client can register typed listeners. */
export type PersonaEvent =
  | {
      /** Phase entered · UI promotes that row to `active`. */
      type: "persona-phase-start";
      phase: number;       // 1..7
      label: string;       // "Persona spec" · "Knowledge context" · ...
      etaSec: number;      // estimated wall-clock for THIS phase
    }
  | {
      /** Phase still running · sub-detail updates (search round
       *  counter, "reading 3 pages…", etc.). */
      type: "persona-phase-progress";
      phase: number;
      detail: string;
      progressPct: number; // 0..100, monotonic across the WHOLE build
      /** Optional · set only when Phase 5 has bridged a voice-distill
       *  substep event onto the persona stream. 1-10, one per
       *  `voice-distill.ts` substep (search / download / normalize /
       *  transcribe / identify / extract / upload / clone / persist /
       *  cleanup). UI surfaces use it to expand a nested mini-progress
       *  list under Phase 5 mirroring PC's voice-distill panel. */
      voiceDistillPhase?: number;
    }
  | {
      /** Phase complete · UI flips that row to `done` and the next
       *  one to `active`. Carries a snapshot of the current partial
       *  spec so a fresh SSE subscriber can hydrate without polling. */
      type: "persona-phase-end";
      phase: number;
      partial: Partial<PersonaSpec>;
      progressPct: number;
    }
  | {
      /** Phase 2 · the dimension planner picked N angles to fan out
       *  in parallel. Emitted ONCE before any searches start so the
       *  UI can render the dimension checklist immediately. Old
       *  clients that don't know this event ignore it. */
      type: "persona-dimension-plan";
      dimensions: Array<{ dimension: string; query: string; why: string }>;
    }
  | {
      /** Phase 2 ReAct loop · per-round telemetry. Distinct from
       *  `persona-phase-progress` so the UI can render a query log
       *  alongside the active sub-detail. `dimension` is set when
       *  the round originated from the parallel dimension batch
       *  (Phase 2b); top-up rounds (Phase 2c) leave it undefined.
       *  `phase` distinguishes the two; older clients ignore both. */
      type: "persona-search-round";
      round: number;       // 1..N (dim batch) or N+1..N+M (top-up)
      query: string;       // the query the planner just ran
      resultsCount: number;
      pagesRead: number;
      dimension?: string;
      phase?: "dimension" | "topup";
    }
  | {
      /** Build finished cleanly · final persona artifact ready to
       *  preview on the save screen. Job row is now `done`.
       *
       *  The route forwarder augments the outbound SSE payload with
       *  `instruction` / `coverQuote` / `ability` derived from this
       *  spec, so the client's save screen can mirror Signal-mode's
       *  preview shell. Those fields don't live on the bus event
       *  itself — keeping this type minimal preserves the contract
       *  that orchestrator → bus carries the structured artifact and
       *  routes layer on presentation-side fields. */
      type: "persona-final";
      spec: PersonaSpec;
    }
  | {
      /** Hard failure · job row is `failed`. Includes the user-
       *  visible reason (token cap hit, wall-clock exceeded, no LLM
       *  key reachable, upstream provider down). */
      type: "persona-error";
      message: string;
    }
  | {
      /** User aborted via the cancel button · job row is `aborted`.
       *  Distinct from `persona-error` so the UI can differentiate
       *  "you cancelled" from "the build broke". */
      type: "persona-aborted";
    };

class PersonaBus {
  private emitters = new Map<string, EventEmitter>();

  private get(jobId: string): EventEmitter {
    let e = this.emitters.get(jobId);
    if (!e) {
      e = new EventEmitter();
      // Allow several SSE clients on the same job (user reconnect,
      // dev tools open, etc.). Brief / room buses use 64; we don't
      // need that headroom — set 16 to keep accidental fan-outs
      // visibly noisy in stderr if anything misuses the bus.
      e.setMaxListeners(16);
      this.emitters.set(jobId, e);
    }
    return e;
  }

  emit(jobId: string, event: PersonaEvent): void {
    this.get(jobId).emit("event", event);
  }

  /** Subscribe; returns an unsubscribe fn. The SSE route uses this
   *  exclusively · drop() runs on terminal events to free the slot. */
  subscribe(jobId: string, listener: (event: PersonaEvent) => void): () => void {
    const e = this.get(jobId);
    e.on("event", listener);
    return () => e.off("event", listener);
  }

  /** Free the EventEmitter for a job. Call on terminal events
   *  (`persona-final`, `persona-error`, `persona-aborted`) so the Map
   *  doesn't grow unbounded across many builds in one process. */
  drop(jobId: string): void {
    const e = this.emitters.get(jobId);
    if (e) {
      e.removeAllListeners();
      this.emitters.delete(jobId);
    }
  }
}

export const personaBus = new PersonaBus();
