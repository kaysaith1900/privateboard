/**
 * Per-room event bus. The orchestrator emits events here as it works; the
 * /api/rooms/:id/stream HTTP route subscribes per connected client and
 * fan-outs to SSE.
 *
 * Event shapes are typed so route handlers can format them deterministically.
 */
import { EventEmitter } from "node:events";

export type RoomEvent =
  | {
      type: "message-appended";
      messageId: string;
      authorKind: string;
      authorId: string | null;
      replyToId: string | null;
      body: string;
      meta: Record<string, unknown>;
      roundNum: number;
      createdAt: number;
    }
  | { type: "message-token"; messageId: string; delta: string }
  | { type: "message-final"; messageId: string; finishReason?: string }
  | { type: "message-removed"; messageId: string; reason?: string }
  | { type: "message-error"; messageId: string; message: string }
  | {
      /** Full body + meta replacement for an existing message · used
       *  by tool-use messages whose status flips running → done|failed
       *  after the side-effect (URL fetch) completes. Distinct from
       *  message-token (delta append for streaming) and message-final
       *  (finish marker for streamed bodies). */
      type: "message-updated";
      messageId: string;
      body: string;
      meta: Record<string, unknown>;
    }
  | { type: "config-event"; kind: string; payload: Record<string, unknown> | null; createdAt: number }
  | {
      type: "queue-update";
      queue: Array<{ agentId: string; status: "thinking" | "speaking" | "queued" }>;
      /** Round progress so the UI knows when "all directors spoke this round". */
      round: { spoken: number; total: number };
    };

class RoomBus {
  private emitters = new Map<string, EventEmitter>();

  private get(roomId: string): EventEmitter {
    let e = this.emitters.get(roomId);
    if (!e) {
      e = new EventEmitter();
      e.setMaxListeners(64);
      this.emitters.set(roomId, e);
    }
    return e;
  }

  emit(roomId: string, event: RoomEvent): void {
    this.get(roomId).emit("event", event);
  }

  /** Subscribe; returns an unsubscribe fn. */
  subscribe(roomId: string, listener: (event: RoomEvent) => void): () => void {
    const e = this.get(roomId);
    e.on("event", listener);
    return () => e.off("event", listener);
  }

  /** Drop all listeners for a room (e.g. when it's deleted). */
  drop(roomId: string): void {
    const e = this.emitters.get(roomId);
    if (e) {
      e.removeAllListeners();
      this.emitters.delete(roomId);
    }
  }
}

export const roomBus = new RoomBus();
