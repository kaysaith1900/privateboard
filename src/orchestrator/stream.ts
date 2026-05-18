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
      type: "voice-chunk";
      messageId: string;
      seq: number;
      text: string;
      provider: string;
      model: string;
      voiceId: string;
      mimeType?: string;
      audioBase64?: string;
    }
  | { type: "voice-final"; messageId: string }
  | {
      /** TTS provider raised a tagged billing error (insufficient
       *  balance / paid plan required / out of credits). Forwarded
       *  from the chair / director streaming TTS callers so the
       *  frontend can open the upgrade overlay · this is a USER-
       *  ACTIONABLE failure, not a transient network blip. Identical
       *  shape to the `/api/voices/*` JSON error response so the
       *  same client handler can route both paths into the same
       *  modal. `messageId` is the speaker's message (may be empty
       *  for templated chair voice without a placeholder). */
      type: "voice-error";
      messageId: string;
      code: string;
      provider: string;
      message: string;
      upgradeUrl?: string;
    }
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

/** Bounded ring buffer entry · captures the event plus a monotonic
 *  id and ts so the SSE route can replay missed events to a reconnect
 *  carrying Last-Event-ID. */
interface BufferedEvent { id: number; event: RoomEvent; ts: number; }

/** Per-room cap on buffered events. 100 covers a busy ~30s window of
 *  voice-chunk / message-token traffic — enough for normal network
 *  blips without exploding memory across many rooms. */
const MAX_BUFFER_PER_ROOM = 100;
/** TTL on buffered events. After 5 min we drop them regardless of
 *  count — protects against a long-disconnected client trying to
 *  rejoin a room whose state has moved on substantially. */
const BUFFER_TTL_MS = 5 * 60 * 1000;

class RoomBus {
  private emitters = new Map<string, EventEmitter>();
  private buffers = new Map<string, BufferedEvent[]>();
  /** Monotonic event id (global across rooms · simpler than per-room
   *  counters and equivalent for SSE's Last-Event-ID use). Survives
   *  the lifetime of the process; reset on restart, which is fine ·
   *  EventSource treats a smaller id from the server as "fresh
   *  stream" and starts over. */
  private nextId = 1;

  private get(roomId: string): EventEmitter {
    let e = this.emitters.get(roomId);
    if (!e) {
      e = new EventEmitter();
      e.setMaxListeners(64);
      this.emitters.set(roomId, e);
    }
    return e;
  }

  private buffer(roomId: string): BufferedEvent[] {
    let b = this.buffers.get(roomId);
    if (!b) { b = []; this.buffers.set(roomId, b); }
    return b;
  }

  emit(roomId: string, event: RoomEvent): void {
    const id = this.nextId++;
    const ts = Date.now();
    const buf = this.buffer(roomId);
    buf.push({ id, event, ts });
    // Trim · drop by count first (cheap), then by age. Both bounds
    // keep memory predictable even for an extremely chatty room.
    while (buf.length > MAX_BUFFER_PER_ROOM) buf.shift();
    while (buf.length && ts - buf[0]!.ts > BUFFER_TTL_MS) buf.shift();
    this.get(roomId).emit("event", id, event);
  }

  /** Legacy subscribe · returns events without ids. Kept for callers
   *  that don't care about replay (none currently, but the surface
   *  stays compatible). */
  subscribe(roomId: string, listener: (event: RoomEvent) => void): () => void {
    return this.subscribeWithId(roomId, (_id, event) => listener(event));
  }

  /** Subscribe with monotonic event id · the SSE route uses this so
   *  every event written to the client carries an `id: N` line. The
   *  client's EventSource then sends `Last-Event-ID: N` on auto-
   *  reconnect, which the route maps back to replay() below. */
  subscribeWithId(roomId: string, listener: (id: number, event: RoomEvent) => void): () => void {
    const e = this.get(roomId);
    e.on("event", listener);
    return () => e.off("event", listener);
  }

  /** Return cached events with id > sinceId in emit order. Used by
   *  the SSE route on reconnect to replay the gap before subscribing
   *  fresh. Returns [] when there is no cache OR the gap is older
   *  than the buffer's retained window (caller treats as "no replay
   *  possible · client may have missed events permanently"). */
  replay(roomId: string, sinceId: number): BufferedEvent[] {
    const buf = this.buffers.get(roomId);
    if (!buf || buf.length === 0) return [];
    return buf.filter((e) => e.id > sinceId);
  }

  /** Drop all listeners for a room (e.g. when it's deleted). */
  drop(roomId: string): void {
    const e = this.emitters.get(roomId);
    if (e) {
      e.removeAllListeners();
      this.emitters.delete(roomId);
    }
    this.buffers.delete(roomId);
  }
}

export const roomBus = new RoomBus();
