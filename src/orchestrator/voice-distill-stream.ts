/**
 * Per-job event bus for the voice-distill pipeline · same shape as
 * `personaBus` in src/orchestrator/persona-stream.ts so the SSE route
 * code reads identically.
 */
import { EventEmitter } from "node:events";

/** Discriminated union of every event the voice-distill pipeline emits.
 *  The SSE route maps each variant to a named SSE `event:` field so the
 *  client can register typed listeners. */
export type VoiceDistillEvent =
  | { type: "voice-distill-phase-start"; phase: number; label: string }
  | { type: "voice-distill-phase-progress"; phase: number; detail: string; progressPct: number }
  | { type: "voice-distill-phase-end"; phase: number; progressPct: number }
  | { type: "voice-distill-warning"; phase: number; message: string }
  | { type: "voice-distill-final"; voiceId: string; agentId: string | null; credentialLabel: string }
  | { type: "voice-distill-error"; message: string }
  | { type: "voice-distill-aborted" };

class VoiceDistillBus {
  private emitters = new Map<string, EventEmitter>();

  private get(jobId: string): EventEmitter {
    let e = this.emitters.get(jobId);
    if (!e) {
      e = new EventEmitter();
      e.setMaxListeners(16);
      this.emitters.set(jobId, e);
    }
    return e;
  }

  emit(jobId: string, event: VoiceDistillEvent): void {
    this.get(jobId).emit("event", event);
  }

  subscribe(jobId: string, listener: (event: VoiceDistillEvent) => void): () => void {
    const e = this.get(jobId);
    e.on("event", listener);
    return () => e.off("event", listener);
  }

  drop(jobId: string): void {
    const e = this.emitters.get(jobId);
    if (e) {
      e.removeAllListeners();
      this.emitters.delete(jobId);
    }
  }
}

export const voiceDistillBus = new VoiceDistillBus();
