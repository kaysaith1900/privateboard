/**
 * Auto-skip / auto-fallback SSE signal.
 *
 * Fired whenever a server-side timeout (LLM stall, TTS timeout,
 * picker timeout, clarify-gate timeout) causes the orchestrator to
 * abandon the slow path and fall back to a safe default. The client
 * renders a 3s toast so the user understands WHY playback jumped
 * forward / why the chair didn't ask / why the speaker order isn't
 * what they configured.
 *
 * Phase strings are stable so the client can i18n them:
 *   "tts"      · TTS chunk-arrival watchdog or per-call timeout fired
 *   "llm"      · LLM stream first-token watchdog or hard cap fired
 *   "picker"   · pickNextSpeaker timeout · fell back to round-robin
 *   "clarify"  · pickChairClarifyDecision timeout · skipped clarify
 *   "voice"    · client-initiated skip via stalled-bubble or HUD Skip
 *
 * The optional `messageId` lets the client tag the toast to a
 * specific seat if the bubble for that message is currently rendered.
 */
import { roomBus } from "./stream.js";

export type AutoSkipPhase = "tts" | "llm" | "picker" | "clarify" | "voice";

export function emitAutoSkipped(
  roomId: string,
  phase: AutoSkipPhase,
  reason: string,
  messageId?: string,
): void {
  roomBus.emit(roomId, {
    type: "config-event",
    kind: "auto-skipped",
    payload: {
      phase,
      reason,
      ...(messageId ? { messageId } : {}),
    },
    createdAt: Date.now(),
  });
}
