/**
 * RoomOrchestrator · drives a single Room's life.
 *
 * Per-room state is held in a Map keyed by room id (M3-M4 are single-process,
 * so this is fine). State includes:
 *   · queue          — directors lined up to speak this round
 *   · inflight       — AbortController for the speaker currently streaming
 *   · processing     — guard against double-pump
 *   · roundNum       — round_num shared by user msg + all director replies
 *
 * Round-robin (Q1 · A): when the user sends a message with no @mention, every
 * director in the room speaks once, in their join-order position. With an
 * @mention, only that director replies.
 *
 * Re-tick mid-turn (next user message arriving while the queue is still
 * draining) aborts the current speaker and replaces the queue with the new
 * round's plan. Partial responses stay in the transcript with finishReason:
 * 'aborted' in their meta — visible but flagged.
 */
import { callLLMStream, type LLMMessage } from "../ai/adapter.js";
import { isModelV } from "../ai/registry.js";
import { getAgent, incrementAgentTokens, type Agent } from "../storage/agents.js";
import { insertConfigEvent } from "../storage/config-events.js";
import { listKeyPointsForRoom } from "../storage/key_points.js";
import {
  deleteMessage,
  insertMessage,
  listRecentMessages,
  nextUserRoundNum,
  updateMessageBody,
  type Message,
} from "../storage/messages.js";
import { getKey, hasBraveKey } from "../storage/keys.js";
import { getPrefs } from "../storage/prefs.js";
import {
  reachableModelVs,
  reconcileAgentModels,
} from "../storage/reconcile-models.js";
import { getRoom, listRoomMembers, setAwaitingContinue, setRoomStatus, type Room } from "../storage/rooms.js";
import { getBrief } from "../storage/briefs.js";

import { formatSearchResults, runBraveSearch } from "../ai/skills/web-search.js";
import { isBillingError, extractProviderHint } from "../ai/billing-error.js";
import {
  announceBillingNotice,
  announceIntervention,
  announceRoundOpen,
  announceRoundPrompt,
  runChairDirectResponse,
} from "./chair.js";
import { buildDirectorContext } from "./context.js";
import { buildDirectorMessages, buildFollowUpPriorContext } from "./prompt.js";
import { pickNextSpeaker, pickRoundWrap, pickSkills } from "./skill-picker.js";
import { roomBus, type RoomEvent } from "./stream.js";
import { listSkillsForAgent } from "../storage/skills.js";

type QueueStatus = "queued" | "speaking";

interface QueueEntry {
  agentId: string;
  status: QueueStatus;
}

interface PendingUserAfterCurrent {
  text: string;
  mentions: string[];
  replyToId: string | null;
}

interface RoomState {
  queue: QueueEntry[];
  inflight: AbortController | null;
  processing: boolean;
  roundNum: number;
  /** Total speakers fired since the last user message. Capped to avoid runaway. */
  speakersThisTurn: number;
  /** Hard cap for this turn (cast.length × 3, min 9). */
  maxSpeakersThisTurn: number;
  /** Soft pause flag — set by user clicking "After they finish" while a director streams.
   *  pumpQueue checks this between speakers and transitions the room to paused. */
  pauseAfterCurrent: boolean;
  /** A user message the user opted to deliver _after_ the currently
   *  speaking director finishes. pumpQueue drains this between turns
   *  so the message lands BEFORE the next director starts — and so
   *  the next director's response is keyed off the user's question. */
  pendingUserAfterCurrent: PendingUserAfterCurrent | null;
  /** Snapshot taken when the room is paused so resume can pick up the
   *  same queue / round / speaker-count instead of starting from scratch.
   *  Cleared on tickRoom (a fresh user message replans the round). */
  savedOnPause: {
    queue: QueueEntry[];
    roundNum: number;
    speakersThisTurn: number;
    maxSpeakersThisTurn: number;
  } | null;
  /** Chair's next-speaker rationale waiting to be attached to the next
   *  director's message meta. Populated by pumpQueue when the haiku
   *  picker reorders the queue; consumed by streamSpeakerTurn when the
   *  matching speaker spins up its placeholder. Cleared after
   *  attachment so a stale rationale can't leak onto a later turn. */
  pendingChairPick: { agentId: string; rationale: string } | null;
  /** Set when a director turn fails with a billing / quota error. The
   *  pump checks this between turns and drains the queue without firing
   *  more directors — once the carrier is dry, every subsequent call
   *  would just hit the same upstream rejection. The flag clears on the
   *  next user-message tick (tickRoom resets state) so the user can try
   *  again after fixing the key. */
  billingHaltedThisTurn: boolean;
}

const _state = new Map<string, RoomState>();

/**
 * Dev-mode trace for the orchestrator. Writes a single line to stderr per
 * state transition (tick / pump / pause / resume / per-speaker turn) so the
 * developer console makes it obvious which agent · which modelV · which
 * round is on the wire at any moment. Always-on like the [adapter] line —
 * the room console is the only audit trail for multi-turn flow now that
 * the verify overlay is gone.
 */
function rlog(roomId: string, label: string, fields?: Record<string, unknown>): void {
  const tag = roomId.slice(0, 8);
  let line = `[room ${tag}] ${label}`;
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      const formatted = typeof v === "string" ? v : JSON.stringify(v);
      line += ` ${k}=${formatted}`;
    }
  }
  process.stderr.write(line + "\n");
}

function ensureState(roomId: string): RoomState {
  let s = _state.get(roomId);
  if (!s) {
    s = {
      queue: [],
      inflight: null,
      processing: false,
      roundNum: 1,
      speakersThisTurn: 0,
      maxSpeakersThisTurn: 0,
      pauseAfterCurrent: false,
      pendingUserAfterCurrent: null,
      savedOnPause: null,
      pendingChairPick: null,
      billingHaltedThisTurn: false,
    };
    _state.set(roomId, s);
  }
  return s;
}

/** True if a director is currently streaming a turn. */
export function isRoomSpeaking(roomId: string): boolean {
  const s = _state.get(roomId);
  if (!s) return false;
  return s.inflight !== null;
}

/**
 * Append director(s) onto the live speaker queue without resetting
 * the round. Called when a user adds members via room settings — the
 * new agent should speak as part of the current round, not trigger a
 * full replan that re-fires already-spoken directors. Bumps the per-
 * turn cap so the pump doesn't exit early before reaching them, and
 * kicks the pump if it's idle (and the room is in a state that
 * permits a director turn).
 */
export function injectSpeakers(roomId: string, agentIds: string[]): void {
  if (agentIds.length === 0) return;
  const state = ensureState(roomId);
  let appended = 0;
  for (const id of agentIds) {
    if (state.queue.find((q) => q.agentId === id)) continue;
    state.queue.push({ agentId: id, status: "queued" });
    state.maxSpeakersThisTurn += 1;
    appended += 1;
  }
  if (appended === 0) return;
  emitQueueUpdate(roomId, state);

  // Snapshot any existing pause snapshot too — if the room is paused,
  // the user's resume click should pick up the new agents alongside.
  if (state.savedOnPause) {
    for (const id of agentIds) {
      if (state.savedOnPause.queue.find((q) => q.agentId === id)) continue;
      state.savedOnPause.queue.push({ agentId: id, status: "queued" });
      state.savedOnPause.maxSpeakersThisTurn += 1;
    }
  }

  const room = getRoom(roomId);
  const canPump =
    !state.processing &&
    !!room &&
    room.status === "live" &&
    !room.awaitingContinue &&
    !room.awaitingClarify;

  rlog(roomId, "inject-speakers", {
    added: appended,
    queue: state.queue.length,
    round: state.roundNum,
    cap: state.maxSpeakersThisTurn,
    pumping: canPump,
  });

  if (canPump) {
    void pumpQueue(roomId);
  }
}

/** Mark the room to pause after the current speaker finishes. */
export function requestSoftPause(roomId: string): void {
  const s = ensureState(roomId);
  s.pauseAfterCurrent = true;
  rlog(roomId, "soft-pause-requested", { remaining: s.queue.length, speaking: s.inflight ? 1 : 0 });
}

/** Stash a user message to be delivered between the current speaker
 *  and the next one. pumpQueue picks this up after the current turn
 *  finishes; the message lands before any subsequent director starts. */
export function setPendingUserAfterCurrent(
  roomId: string,
  payload: PendingUserAfterCurrent,
): void {
  const s = ensureState(roomId);
  s.pendingUserAfterCurrent = payload;
}

/** Has a soft-pause request been honored / cleared? */
export function consumeSoftPause(roomId: string): boolean {
  const s = _state.get(roomId);
  if (!s) return false;
  if (s.pauseAfterCurrent) {
    s.pauseAfterCurrent = false;
    return true;
  }
  return false;
}

/**
 * Chair-interrupt flow · the user @mentioned the chair to ask a meta
 * question about the discussion. We pause the director queue, abort
 * any in-flight director (deleting their partial message so the chat
 * doesn't show a truncated bubble), run the chair's direct response,
 * then restore the queue and let the pump resume.
 *
 * The interrupted director DOES re-run when the queue restores —
 * they're still queue[0] in the snapshot. Their fresh turn will see
 * the chair's interruption in the transcript and naturally engage
 * with it. This mirrors a real-meeting feel: chair interrupts, current
 * speaker pauses, chair speaks, current speaker resumes from where
 * they were (with new context).
 *
 * Best-effort. A failed chair-direct streams an empty message which
 * streamChairMessage cleans up; the queue still restores.
 */
export async function chairInterrupt(roomId: string): Promise<void> {
  const state = ensureState(roomId);

  // Snapshot the current queue so we can restore after chair finishes.
  // The in-flight speaker (if any) is still queue[0] here — they're
  // included in the snapshot and will re-run when the queue resumes.
  const queueSnapshot: QueueEntry[] = state.queue.map((q) => ({
    agentId: q.agentId,
    status: "queued" as const,
  }));

  // Abort the in-flight speaker · cancel their stream and delete their
  // partial message so the chat doesn't carry a truncated bubble next
  // to the chair's direct response.
  let interruptedAgentId: string | null = null;
  if (state.inflight) {
    interruptedAgentId = state.queue[0]?.agentId ?? null;
    state.inflight.abort();
    state.inflight = null;
    if (interruptedAgentId) {
      // Find the most recent streaming agent message from this speaker
      // and remove it. The placeholder was inserted by streamSpeakerTurn
      // moments before the abort.
      const recent = listRecentMessages(roomId, 8);
      for (let i = recent.length - 1; i >= 0; i--) {
        const m = recent[i];
        if (
          m.authorKind === "agent" &&
          m.authorId === interruptedAgentId &&
          m.meta &&
          (m.meta as { streaming?: boolean }).streaming === true
        ) {
          deleteMessage(m.id);
          roomBus.emit(roomId, {
            type: "message-removed",
            messageId: m.id,
            reason: "chair-interrupt",
          });
          break;
        }
      }
    }
  }

  // Clear the live queue so any in-flight pumpQueue iteration exits its
  // while-loop cleanly. We restore the snapshot after the chair speaks.
  state.queue = [];
  emitQueueUpdate(roomId, state);

  rlog(roomId, "chair-interrupt-start", {
    aborted: interruptedAgentId !== null,
    interrupted: interruptedAgentId
      ? getAgent(interruptedAgentId)?.name ?? interruptedAgentId
      : null,
    snapshot: queueSnapshot.length,
  });

  // Run the chair's direct response · streamed via SSE. Best-effort:
  // any failure just means no chair message; we still restore queue.
  try {
    await runChairDirectResponse(roomId);
  } catch (e) {
    process.stderr.write(
      `[chair-interrupt] chair-direct failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }

  // Restore queue and resume the pump. By now the prior pumpQueue
  // iteration (if it was running) has exited via empty-queue, so
  // state.processing should be false. We void pumpQueue defensively;
  // it self-guards if processing is somehow still true.
  state.queue = queueSnapshot;
  emitQueueUpdate(roomId, state);
  rlog(roomId, "chair-interrupt-end", { restored: queueSnapshot.length });

  if (!state.processing && state.queue.length > 0) {
    void pumpQueue(roomId);
  }
}

export function abortRoom(roomId: string): void {
  const s = _state.get(roomId);
  if (!s) {
    rlog(roomId, "abort-noop", { reason: "no-state" });
    return;
  }
  // Snapshot the queue before clearing so a later resumeRoom can pick
  // up the same speaker order. The in-flight speaker (if any) is
  // re-prepended as `queued` since their turn was cut short.
  const remaining: QueueEntry[] = s.queue.map((q) => ({ agentId: q.agentId, status: "queued" as const }));
  s.savedOnPause = {
    queue: remaining,
    roundNum: s.roundNum,
    speakersThisTurn: s.speakersThisTurn,
    maxSpeakersThisTurn: s.maxSpeakersThisTurn,
  };
  s.queue = [];
  const wasSpeaking = s.inflight !== null;
  // Don't reset s.speakersThisTurn — leaving it at K means the
  // queue-update we emit below carries the *true* "K spoken / N total"
  // for the paused round. Resetting it to 0 used to make the round
  // counter momentarily lie about its own state ("0 of N" mid-pause)
  // and any UI gate that consults currentRound during the pause window
  // would read the wrong value. resumeRoom restores from the snapshot
  // (a no-op since we kept the same value here); tickRoom does its own
  // explicit reset when the resume falls through to a fresh replan.
  if (s.inflight) {
    s.inflight.abort();
    s.inflight = null;
  }
  rlog(roomId, "abort", {
    snapshot: remaining.length,
    round: s.roundNum,
    aborted: wasSpeaking,
    spoken: s.savedOnPause.speakersThisTurn,
  });
  emitQueueUpdate(roomId, s);
}

/** Restore the queue snapshot taken at pause and resume the pump.
 *  If the snapshot is missing or empty (paused at end-of-round, or after
 *  tickRoom cleared it), fall back to replanning the round so resume
 *  always produces a visible agent reply — silent no-op was the source
 *  of the "click resume, nothing happens" bug. */
export function resumeRoom(roomId: string): void {
  const s = ensureState(roomId);
  const snap = s.savedOnPause;
  s.savedOnPause = null;

  if (snap && snap.queue.length > 0) {
    s.queue = snap.queue.map((q) => ({ agentId: q.agentId, status: "queued" as const }));
    s.roundNum = snap.roundNum;
    s.speakersThisTurn = snap.speakersThisTurn;
    s.maxSpeakersThisTurn = snap.maxSpeakersThisTurn;
    emitQueueUpdate(roomId, s);
    rlog(roomId, "resume", {
      mode: "snapshot",
      queue: s.queue.length,
      round: s.roundNum,
      spoken: `${s.speakersThisTurn}/${s.maxSpeakersThisTurn}`,
      processing: s.processing,
    });
    if (!s.processing) {
      void pumpQueue(roomId);
    }
    return;
  }

  // Live-queue salvage · if state.queue somehow still holds entries
  // (race between hard pause + abort), prefer that over a fresh round.
  if (s.queue.length > 0) {
    rlog(roomId, "resume", {
      mode: "live-queue",
      queue: s.queue.length,
      round: s.roundNum,
      processing: s.processing,
    });
    if (!s.processing) {
      void pumpQueue(roomId);
    }
    return;
  }

  // Fallback path · snapshot null/empty AND state queue empty.
  // Per the user's brief: clicking Resume should ALWAYS restart the
  // queue, even when the room paused at end-of-round (chair prompt
  // owns the next step). Clear awaitingContinue so tickRoom's guard
  // doesn't no-op us, then replan as a *new* round — fresh number,
  // reactive kind. Re-using s.roundNum used to post a duplicate
  // "Round #N · parallel" marker for what is conceptually a new
  // pass; mirroring the Continue button (`nextUserRoundNum` +
  // `kind: "continue"`) keeps the round counter monotone and the
  // mode label honest.
  const room = getRoom(roomId);
  if (room && room.awaitingContinue) {
    setAwaitingContinue(roomId, false);
    roomBus.emit(roomId, {
      type: "config-event",
      kind: "round-resumed",
      payload: {},
      createdAt: Date.now(),
    });
  }
  const nextRound = nextUserRoundNum(roomId);
  rlog(roomId, "resume", {
    mode: "fallback-replan",
    snapshot: snap ? "empty" : "missing",
    fromRound: s.roundNum,
    toRound: nextRound,
    clearedAwaitingContinue: !!(room && room.awaitingContinue),
  });
  tickRoom(roomId, { roundNum: nextRound, kind: "continue" });
}

function emitQueueUpdate(roomId: string, s: RoomState): void {
  const update: RoomEvent = {
    type: "queue-update",
    queue: s.queue.map((q) => ({ agentId: q.agentId, status: q.status })),
    round: {
      spoken: s.speakersThisTurn,
      total: s.maxSpeakersThisTurn,
    },
  };
  roomBus.emit(roomId, update);
}

interface TickOptions {
  roundNum: number;
  /** First mention in the user's message (if any) — bypasses round-robin. */
  forceSpeakerId?: string | null;
  /** Origin of this tick:
   *   "user"     · default; treats this as the OPENING sweep — directors
   *                respond in parallel, no cross-pollination.
   *   "continue" · user clicked Continue after a round-end → reactive
   *                round; directors see each other's prior turns.
   *   "force"    · single @-mention reply; no round marker is fired.
   *  Drives the chair's round-open announcement + the prompt's round
   *  mode block in `buildDirectorMessages`. */
  kind?: "user" | "continue" | "force";
}

/**
 * Replace the queue with a fresh plan for `roundNum`, abort any speaker mid-
 * stream, and kick the pump. Returns immediately; streaming happens off-thread.
 */
export function tickRoom(roomId: string, opts: TickOptions): void {
  const room = getRoom(roomId);
  if (!room) return;
  if (room.status !== "live") return;
  // Soft-pause flags set by the chair. Directors don't fire while the
  // room is mid-clarification or waiting for the user to Continue
  // after a round-end. The route layer handles releasing these.
  if (room.awaitingContinue || room.awaitingClarify) return;

  const memberRows = listRoomMembers(roomId);
  if (memberRows.length === 0) return;
  // Directors only — the chair (role_kind = 'moderator') never enters
  // the round-robin queue.
  const directors: Agent[] = memberRows
    .map((m) => getAgent(m.agentId))
    .filter((a): a is Agent => a !== null && a.roleKind === "director");
  if (directors.length === 0) return;

  // Decide who speaks this round.
  let plan: Agent[];
  if (opts.forceSpeakerId) {
    const found = directors.find((a) => a.id === opts.forceSpeakerId);
    plan = found ? [found] : [];
  } else {
    plan = directors;
  }
  if (plan.length === 0) return;

  const state = ensureState(roomId);

  // Abort any in-flight speaker; the pump's finally clause will see the new
  // queue when it resumes.
  if (state.inflight) state.inflight.abort();

  state.queue = plan.map((a) => ({ agentId: a.id, status: "queued" }));
  state.roundNum = opts.roundNum;
  state.speakersThisTurn = 0;
  // A fresh user message replans the round — drop any pause snapshot.
  state.savedOnPause = null;
  // Drop any pending chair-pick rationale — it belonged to the prior
  // queue, not this fresh plan. Otherwise it could leak onto a future
  // speaker who happens to share the prior pick's agentId.
  state.pendingChairPick = null;
  // Clear the billing halt · a fresh user tick is the natural moment
  // to retry. If the carrier still has no credit the next director will
  // re-trip the flag and a fresh chair notice posts.
  state.billingHaltedThisTurn = false;
  // One full round = each director speaks once. The chair takes over
  // when the queue drains; the user decides whether to continue with
  // another round.
  state.maxSpeakersThisTurn = plan.length;
  emitQueueUpdate(roomId, state);

  // Round-open marker · chair posts a centred chip in chat so the
  // user sees whether this round is parallel (independent) or
  // reactive. Skipped for forced single-speaker replies (those are
  // direct @-mention answers, not "rounds" in the multi-director
  // sense).
  const tickKind = opts.kind ?? "user";
  if (!opts.forceSpeakerId && tickKind !== "force") {
    announceRoundOpen(roomId, opts.roundNum, tickKind === "user");
  }

  rlog(roomId, "tick", {
    round: opts.roundNum,
    plan: plan.map((a) => `${a.name}:${a.modelV}`),
    forced: opts.forceSpeakerId ?? null,
    processing: state.processing,
  });

  if (!state.processing) {
    void pumpQueue(roomId);
  }
}

async function pumpQueue(roomId: string): Promise<void> {
  const state = ensureState(roomId);
  if (state.processing) {
    rlog(roomId, "pump-skip", { reason: "already-processing" });
    return;
  }
  state.processing = true;
  rlog(roomId, "pump-start", {
    queue: state.queue.length,
    round: state.roundNum,
    spoken: `${state.speakersThisTurn}/${state.maxSpeakersThisTurn}`,
  });

  try {
    while (state.queue.length > 0 && state.speakersThisTurn < state.maxSpeakersThisTurn) {
      // Billing halt · a prior speaker hit insufficient_quota / billing
      // and the chair has already posted the explainer. Stop firing
      // more directors at the dry carrier — every call would just
      // re-trigger the same upstream rejection. Drain the queue so
      // queue UI clears, and exit. The flag clears on the next
      // tickRoom (fresh user message), giving the user a chance to
      // top up / swap carriers and retry naturally.
      if (state.billingHaltedThisTurn) {
        rlog(roomId, "pump-halt", { reason: "billing" });
        state.queue = [];
        emitQueueUpdate(roomId, state);
        break;
      }
      // ─── Next-speaker discipline · reactive rounds only ───────────
      // Before pulling the head of the queue, ask haiku to pick the
      // director whose lens most sharply addresses the previous turn's
      // unresolved tension. Skipped on opening rounds (parallel, no
      // prior turn to react to), on the FIRST speaker of a reactive
      // round (no prior turn yet either), and on single-candidate
      // queues. Failures fall back to the existing round-robin order.
      if (state.queue.length >= 2) {
        const recent = listRecentMessages(roomId, 30);
        const round = state.roundNum;
        let isReactive = false;
        let directorAlreadySpoke = false;
        for (let i = recent.length - 1; i >= 0; i--) {
          const m = recent[i];
          if (m.roundNum !== round) continue;
          if (m.authorKind !== "agent") continue;
          const meta = m.meta as { kind?: string; opening?: boolean } | undefined;
          if (meta?.kind === "round-open" && typeof meta.opening === "boolean") {
            isReactive = meta.opening === false;
          }
          // A director turn this round = something to react to. Chair
          // messages don't count (round-open / round-prompt / clarify
          // are structural pings, not content for next-speaker pick).
          if (!meta?.kind) {
            const author = m.authorId ? getAgent(m.authorId) : null;
            if (author && author.roleKind === "director") directorAlreadySpoke = true;
          }
        }
        if (isReactive && directorAlreadySpoke) {
          const queueSnapshot = state.queue.slice();
          const candidates = queueSnapshot
            .map((q) => getAgent(q.agentId))
            .filter((a): a is Agent => a !== null);
          if (candidates.length >= 2) {
            try {
              const pick = await pickNextSpeaker({ candidates, history: recent });
              // Guard · fresh tickRoom may have replaced state.queue
              // while haiku was thinking. Only reorder if the snapshot
              // is still the live queue.
              const stillSameQueue =
                state.queue.length === queueSnapshot.length &&
                state.queue.every((q, i) => q.agentId === queueSnapshot[i]!.agentId);
              if (stillSameQueue) {
                if (
                  pick.agentId &&
                  pick.agentId !== state.queue[0]!.agentId
                ) {
                  const idx = state.queue.findIndex((q) => q.agentId === pick.agentId);
                  if (idx > 0) {
                    const [picked] = state.queue.splice(idx, 1);
                    state.queue.unshift(picked!);
                    rlog(roomId, "next-speaker-reorder", {
                      picked: getAgent(pick.agentId)?.name ?? pick.agentId,
                      rationale: pick.rationale,
                    });
                    // Stash the rationale so streamSpeakerTurn can attach
                    // it to the speaker's message meta — surfacing the
                    // chair's reasoning makes the moderator visible.
                    if (pick.rationale && pick.rationale.trim()) {
                      state.pendingChairPick = {
                        agentId: pick.agentId,
                        rationale: pick.rationale.trim(),
                      };
                    }
                    emitQueueUpdate(roomId, state);
                  }
                }
                // Intervention · the picker emits this only when prior
                // turns show substantive misalignment (talking past each
                // other, undefined term, hidden trade-off, circling).
                // Posted as a chair frame note BEFORE the picked
                // director speaks, so the room hears the moderator's
                // re-framing first. Common case is null — the picker is
                // biased to skip.
                if (pick.intervention) {
                  rlog(roomId, "chair-intervene", {
                    note: pick.intervention.slice(0, 80),
                    nextSpeaker: getAgent(state.queue[0]!.agentId)?.name ?? state.queue[0]!.agentId,
                  });
                  announceIntervention(roomId, pick.intervention, pick.rationale);
                }
              }
            } catch (e) {
              // Best-effort · round-robin fallback. Logged at debug
              // level since the picker has its own stderr trace.
              rlog(roomId, "next-speaker-error", {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }
      }

      const entry = state.queue[0]!;
      entry.status = "speaking";
      emitQueueUpdate(roomId, state);

      let speaker = getAgent(entry.agentId);
      if (!speaker) {
        rlog(roomId, "speaker-skip", { reason: "agent-missing", agentId: entry.agentId });
        state.queue.shift();
        emitQueueUpdate(roomId, state);
        continue;
      }
      // Self-heal · if the speaker's stored modelV isn't reachable
      // with the current key set (e.g. a fresh-onboarded user whose
      // seeded directors still carry opus-4-7 because reconcile got
      // skipped), re-run the reconciler and re-fetch the speaker so
      // their modelV swings to the active carrier's primary before
      // we attempt the LLM call.
      if (!isModelV(speaker.modelV) || !reachableModelVs().has(speaker.modelV)) {
        try {
          reconcileAgentModels();
          const refreshed = getAgent(entry.agentId);
          if (refreshed) speaker = refreshed;
        } catch (e) {
          rlog(roomId, "reconcile-on-stale-failed", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (!isModelV(speaker.modelV)) {
        rlog(roomId, "speaker-skip", {
          reason: "unknown-modelV",
          agent: speaker.name,
          agentId: speaker.id,
          modelV: speaker.modelV,
        });
        appendSystemMessage(
          roomId,
          `${speaker.name}'s configured model "${speaker.modelV}" is unknown. Skipping turn.`,
        );
        state.queue.shift();
        emitQueueUpdate(roomId, state);
        continue;
      }

      const ac = new AbortController();
      state.inflight = ac;

      const turnStart = Date.now();
      rlog(roomId, "speaker-start", {
        agent: speaker.name,
        agentId: speaker.id,
        modelV: speaker.modelV,
        round: state.roundNum,
        position: `${state.speakersThisTurn + 1}/${state.maxSpeakersThisTurn}`,
      });

      try {
        await streamSpeakerTurn({
          roomId,
          speaker,
          roundNum: state.roundNum,
          signal: ac.signal,
        });
        state.speakersThisTurn++;
        rlog(roomId, "speaker-end", {
          agent: speaker.name,
          modelV: speaker.modelV,
          ms: Date.now() - turnStart,
          aborted: ac.signal.aborted,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        rlog(roomId, "speaker-error", {
          agent: speaker.name,
          modelV: speaker.modelV,
          ms: Date.now() - turnStart,
          error: msg,
        });
        process.stderr.write(`[orchestrator] stream error: ${msg}\n`);
      } finally {
        state.inflight = null;
      }

      // Was this turn aborted by a fresh tick? If so, the queue's been
      // replaced under us — bail out of the recycling logic.
      if (state.queue[0] !== entry) {
        continue;
      }

      // One-round semantics: pop from the front and DON'T recycle —
      // each director speaks exactly once per user message. The chair
      // takes over when the queue drains.
      state.queue.shift();
      emitQueueUpdate(roomId, state);

      // Pending user message · the user opted to deliver this AFTER the
      // current speaker finishes. Drain it before starting the next
      // speaker so the message lands in the right slot AND the next
      // speaker's response is keyed off the user's question (via
      // tickRoom's replan).
      if (state.pendingUserAfterCurrent) {
        const pending = state.pendingUserAfterCurrent;
        state.pendingUserAfterCurrent = null;
        const userRound = nextUserRoundNum(roomId);
        const userMsg = insertMessage({
          roomId,
          authorKind: "user",
          body: pending.text,
          replyToId: pending.replyToId,
          meta: pending.mentions.length ? { mentions: pending.mentions } : {},
          roundNum: userRound,
        });
        roomBus.emit(roomId, {
          type: "message-appended",
          messageId: userMsg.id,
          authorKind: "user",
          authorId: null,
          replyToId: userMsg.replyToId,
          body: userMsg.body,
          meta: userMsg.meta,
          roundNum: userMsg.roundNum,
          createdAt: userMsg.createdAt,
        });
        roomBus.emit(roomId, { type: "message-final", messageId: userMsg.id });
        // Replan the round around the user's message. tickRoom replaces
        // state.queue + resets counters; the while loop then continues
        // with the new plan instead of the stale queue we were draining.
        tickRoom(roomId, {
          roundNum: userRound,
          forceSpeakerId: pending.mentions[0] ?? null,
        });
        continue;
      }

      // Soft pause requested mid-turn → snapshot the remaining queue so
      // resume picks up the same speaker order, then drain + flip to
      // 'paused'. Emit the lifecycle event so the UI follows.
      if (state.pauseAfterCurrent) {
        state.pauseAfterCurrent = false;
        state.savedOnPause = {
          queue: state.queue.map((q) => ({ agentId: q.agentId, status: "queued" as const })),
          roundNum: state.roundNum,
          speakersThisTurn: state.speakersThisTurn,
          maxSpeakersThisTurn: state.maxSpeakersThisTurn,
        };
        state.queue = [];
        emitQueueUpdate(roomId, state);
        rlog(roomId, "soft-pause-honored", {
          snapshot: state.savedOnPause.queue.length,
          spoken: `${state.speakersThisTurn}/${state.maxSpeakersThisTurn}`,
        });

        const pausedAt = Date.now();
        setRoomStatus(roomId, "paused", { pausedAt });
        insertConfigEvent({
          roomId,
          kind: "room-paused",
          payload: { pausedAt, mode: "soft" },
          actorKind: "user",
        });
        roomBus.emit(roomId, {
          type: "config-event",
          kind: "room-paused",
          payload: { pausedAt, mode: "soft" },
          createdAt: pausedAt,
        });
        break;
      }
    }
  } finally {
    state.processing = false;
    // Drain whatever's left so the UI clears the queue when we hit the cap.
    const reachedCap = state.speakersThisTurn >= state.maxSpeakersThisTurn;
    if (reachedCap) state.queue = [];
    emitQueueUpdate(roomId, state);
    rlog(roomId, "pump-end", {
      round: state.roundNum,
      spoken: `${state.speakersThisTurn}/${state.maxSpeakersThisTurn}`,
      remaining: state.queue.length,
      reachedCap,
    });

    // Round complete (cap reached, not soft-paused, not adjourned) →
    // drop the chair's round-prompt into the chat. The user picks
    // End-round (vote) or Continue from inline buttons inside that
    // message. Skipped if we're already in another phase.
    //
    // Synthesis primitive · before posting the prompt, run a cheap
    // haiku that recommends End vs Continue based on the round's
    // transcript. The recommendation is folded into the round-prompt
    // body + meta so the user reads the chair's call before pressing
    // a button. Failure → continue default (never accidentally push
    // toward ending). The await is intentional: the user should NOT
    // see the round-prompt until the chair has decided.
    if (reachedCap) {
      const room = getRoom(roomId);
      if (
        room &&
        room.status === "live" &&
        !room.awaitingContinue &&
        !room.awaitingClarify
      ) {
        const wrappedRound = state.roundNum;
        let recommendation: { kind: "end" | "continue"; rationale: string } | undefined;
        try {
          const recent = listRecentMessages(roomId, 30);
          const wrap = await pickRoundWrap({ history: recent, roundNum: wrappedRound });
          recommendation = { kind: wrap.recommendation, rationale: wrap.rationale };
        } catch (e) {
          rlog(roomId, "round-wrap-error", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
        // Re-check guards after the haiku · a competing tickRoom could
        // have flipped the room's status / phase / round mid-flight.
        // Re-fetch room and current state so we don't post a stale
        // round-prompt against a room that's moved on.
        const roomAgain = getRoom(roomId);
        const stateNow = ensureState(roomId);
        if (
          roomAgain &&
          roomAgain.status === "live" &&
          !roomAgain.awaitingContinue &&
          !roomAgain.awaitingClarify &&
          stateNow.roundNum === wrappedRound
        ) {
          rlog(roomId, "round-prompt", {
            round: wrappedRound,
            recommendation: recommendation?.kind ?? "(none)",
          });
          announceRoundPrompt(roomId, wrappedRound, recommendation);
        } else {
          rlog(roomId, "round-prompt-skip", {
            reason: "phase-changed-during-haiku",
            wrappedRound,
            currentRound: stateNow.roundNum,
            status: roomAgain?.status,
            awaitingContinue: roomAgain?.awaitingContinue,
            awaitingClarify: roomAgain?.awaitingClarify,
          });
        }
      }
    }
  }
}

interface StreamArgs {
  roomId: string;
  speaker: Agent;
  roundNum: number;
  signal: AbortSignal;
}

async function streamSpeakerTurn(args: StreamArgs): Promise<void> {
  const { roomId, speaker, roundNum, signal } = args;

  const room = getRoom(roomId);
  if (!room) return;

  const memberRows = listRoomMembers(roomId);
  const cast: Agent[] = memberRows
    .map((m) => getAgent(m.agentId))
    .filter((a): a is Agent => a !== null && a.roleKind === "director");

  const prefs = getPrefs();
  // Layered context · L0 verbatim + L1/L2 summary preamble + always-
  // anchored room subject / user pivots / chair convening. Replaces
  // the old flat "last 30 messages" slice that ate user pivots on
  // long rooms. See src/orchestrator/context.ts + summarize.ts.
  const directorCtx = buildDirectorContext(roomId);
  const history = directorCtx.historyMessages;
  const summaryPreamble = directorCtx.summaryPreamble;
  const keyPoints = listKeyPointsForRoom(roomId);

  // Skills + Web Search · Pass-1 router. The same haiku call decides
  // (a) which installed .md skills apply, and (b) whether the turn
  // would benefit from a Brave search query. Both are gated by the
  // user having configured the relevant key + the per-agent toggle.
  const installedSkills = listSkillsForAgent(speaker.id);
  // Research mode bypasses the per-agent web-search toggle · the
  // whole point of the room is mining external material, so we
  // assume every director can search by default. Other modes still
  // honour the per-director opt-in. Either way, hasBraveKey() is
  // the floor — without a Brave API key configured, web search
  // can't run regardless of mode (the chair posts a one-time hint
  // about this when a research room opens; see runChairConvening
  // / announceResearchHint).
  const isResearchMode = (room.mode || "").toLowerCase() === "research";
  const braveAvailable = hasBraveKey() && (speaker.webSearchEnabled || isResearchMode);
  let activeSkills: ReturnType<typeof listSkillsForAgent> = [];
  let pickerReason = "";
  let webSearchQuery: string | null = null;
  if (installedSkills.length > 0 || braveAvailable) {
    try {
      const picked = await pickSkills({
        speaker,
        skills: installedSkills,
        history,
        webSearchAvailable: braveAvailable,
        signal,
      });
      activeSkills = picked.used;
      pickerReason = picked.reason;
      webSearchQuery = picked.webSearchQuery;
      rlog(roomId, "skill-picker", {
        agent: speaker.name,
        installed: installedSkills.length,
        used: activeSkills.map((s) => s.slug),
        webSearch: webSearchQuery,
        reason: pickerReason,
      });
    } catch (e) {
      // Best-effort. Picker failure must not block the turn.
      process.stderr.write(
        `[skill-picker] ${speaker.name} crashed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  // Run Brave Search when the router decided the turn needs fresh info.
  // Failure (timeout / network / 4xx) is non-fatal: the agent answers
  // without the SHARED MATERIALS block, never sees an error.
  let webSearchSources: Array<{ title: string; url: string; description: string }> = [];
  let sharedMaterialsBlock = "";
  if (braveAvailable && webSearchQuery) {
    const apiKey = getKey("brave");
    if (apiKey) {
      const results = await runBraveSearch({ apiKey, query: webSearchQuery });
      if (results && results.length > 0) {
        webSearchSources = results.map((r) => ({
          title: r.title,
          url: r.url,
          description: r.description,
        }));
        sharedMaterialsBlock = formatSearchResults(webSearchQuery, results);
        rlog(roomId, "web-search", {
          agent: speaker.name,
          query: webSearchQuery,
          sources: results.length,
        });
      }
    }
  }

  // Chair-pick rationale · stamped by pumpQueue when the next-speaker
  // haiku reordered the queue to put this director on top. Consumed
  // here BEFORE buildDirectorMessages so it can flow into both:
  //   · the system prompt as a private CHAIR'S BRIEF (shapes content),
  //   · the placeholder meta as chairPick.rationale (drives the UI
  //     kicker so the user sees the moderator's reasoning).
  // Cleared after read so a later turn doesn't inherit a stale cue.
  const turnState = ensureState(roomId);
  let chairBriefForTurn: string | null = null;
  if (
    turnState.pendingChairPick &&
    turnState.pendingChairPick.agentId === speaker.id
  ) {
    chairBriefForTurn = turnState.pendingChairPick.rationale;
    turnState.pendingChairPick = null;
  }

  // Follow-up prior context · when this room was started as a
  // continuation of a prior adjourned room, prepend the parent's
  // brief + Stage-1 signals to the director system prompt. Built
  // here so prompt.ts stays pure (no DB). Defensive · if the parent
  // record vanished or never had a brief, the block degrades to
  // signals-only or empty.
  let priorContext: string | undefined;
  if (room.parentRoomId) {
    try {
      const parentRoom = getRoom(room.parentRoomId);
      if (parentRoom) {
        const parentBrief = room.parentBriefId ? getBrief(room.parentBriefId) : null;
        const langGuess: "zh" | "en" =
          /[一-鿿]/.test(parentRoom.subject || "") ? "zh" : "en";
        const block = buildFollowUpPriorContext({
          parentRoomNumber: parentRoom.number,
          parentRoomSubject: parentRoom.subject,
          parentBrief: parentBrief
            ? { title: parentBrief.title, bodyMd: parentBrief.bodyMd }
            : null,
          parentSignals: parentBrief && parentBrief.signals
            ? parentBrief.signals.map((d) => ({
                directorName: d.directorName,
                signals: d.signals.map((s) => ({ text: s.text, lens: s.lens })),
              }))
            : null,
          language: langGuess,
        });
        if (block.trim()) priorContext = block;
      }
    } catch (e) {
      rlog(roomId, "follow-up-context-error", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const llmMessages: LLMMessage[] = buildDirectorMessages({
    speaker,
    cast,
    room,
    prefs,
    history,
    keyPoints,
    activeSkills,
    sharedMaterials: sharedMaterialsBlock,
    chairBrief: chairBriefForTurn ?? undefined,
    summaryPreamble,
    priorContext,
  });

  // Streaming placeholder so the UI has an id immediately.
  const placeholderMeta: Record<string, unknown> = {
    speakerStatus: "streaming",
    streaming: true,
  };
  if (activeSkills.length > 0) {
    placeholderMeta.skillsUsed = activeSkills.map((s) => s.slug);
    if (pickerReason) placeholderMeta.skillsReason = pickerReason;
  }
  if (webSearchSources.length > 0 && webSearchQuery) {
    placeholderMeta.webSearchUsed = true;
    placeholderMeta.webSearchQuery = webSearchQuery;
    placeholderMeta.webSearchSources = webSearchSources;
  }
  if (chairBriefForTurn) {
    placeholderMeta.chairPick = { rationale: chairBriefForTurn };
  }
  const placeholder = insertMessage({
    roomId,
    authorKind: "agent",
    authorId: speaker.id,
    body: "",
    meta: placeholderMeta,
    roundNum,
  });

  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: placeholder.id,
    authorKind: "agent",
    authorId: speaker.id,
    replyToId: null,
    body: "",
    meta: placeholder.meta,
    roundNum: placeholder.roundNum,
    createdAt: placeholder.createdAt,
  });

  let buf = "";
  let finishReason: string | undefined;
  let errored = false;

  try {
  for await (const chunk of callLLMStream({
    modelV: speaker.modelV as never,
    // Per-agent carrier override · adapter falls back to default
    // precedence when null, when the agent set a carrier whose key
    // was later removed, or when the chosen carrier doesn't actually
    // host the agent's modelV.
    carrier: speaker.carrierPref ?? null,
    messages: llmMessages,
    temperature: 0.65,
    // 4000 (was 800 → 2000). Gemini 3 Pro's thinking trace routinely
    // burns 2-3k tokens on a single director turn; with the cap at
    // 2000, reasoning ate the whole budget and the visible reply got
    // truncated mid-sentence. 4000 leaves ~1-2k of visible headroom
    // even for the heaviest reasoners. If a model STILL truncates,
    // the next move is to cap reasoning explicitly via providerOptions
    // (`reasoning.max_tokens`) instead of just enlarging the total cap.
    maxTokens: 4000,
    signal,
  })) {
    if (signal.aborted) break;

    if (chunk.type === "text") {
      buf += chunk.delta;
      updateMessageBody(placeholder.id, buf, {
        ...placeholderMeta,
        speakerStatus: "streaming",
        streaming: true,
      });
      roomBus.emit(roomId, {
        type: "message-token",
        messageId: placeholder.id,
        delta: chunk.delta,
      });
    } else if (chunk.type === "usage") {
      // Bump the per-agent cumulative token counter (surfaced on the
      // agent profile under "Track Record · Tokens"). Charged in full
      // even on error / partial responses — those still cost upstream.
      incrementAgentTokens(speaker.id, chunk.totalTokens);
      rlog(roomId, "speaker-usage", {
        agent: speaker.name,
        modelV: speaker.modelV,
        promptTokens: chunk.promptTokens,
        completionTokens: chunk.completionTokens,
        totalTokens: chunk.totalTokens,
      });
    } else if (chunk.type === "done") {
      finishReason = chunk.finishReason;
    } else if (chunk.type === "error") {
      errored = true;
      // Loud stderr so the dev console shows the upstream message even
      // when the UI has the placeholder removed before the user can see
      // the error toast. The "no tokens output" symptom is almost
      // always a 4xx/5xx the user never noticed.
      process.stderr.write(
        `[stream-error] room=${roomId} agent=${speaker.name} modelV=${speaker.modelV} · ${chunk.message}\n`,
      );

      // Billing / quota errors get a chair-authored explainer in the
      // chat stream instead of an opaque `[error: ...]` bubble. Drop
      // the failed director's placeholder, post the chair notice, and
      // raise the per-turn flag so pumpQueue stops feeding more
      // directors at a dry carrier. ensureState (not a fresh state)
      // because we're inside an active pump.
      if (isBillingError(chunk.message)) {
        const turnState = ensureState(roomId);
        deleteMessage(placeholder.id);
        roomBus.emit(roomId, {
          type: "message-removed",
          messageId: placeholder.id,
          reason: "billing",
        });
        if (!turnState.billingHaltedThisTurn) {
          announceBillingNotice(roomId, {
            providerHint: extractProviderHint(chunk.message),
            rawError: chunk.message,
            agentName: speaker.name,
          });
          turnState.billingHaltedThisTurn = true;
        }
        // Bail out of the streaming loop · further chunks (incl. usage /
        // done) are irrelevant for a turn we just disowned.
        return;
      }

      roomBus.emit(roomId, {
        type: "message-error",
        messageId: placeholder.id,
        message: chunk.message,
      });
      updateMessageBody(placeholder.id, buf || `[error: ${chunk.message}]`, {
        ...placeholderMeta,
        speakerStatus: "final",
        streaming: false,
        error: chunk.message,
      });
    }
  }
  } catch (e) {
    // The async iterator threw (network error, JSON parse error,
    // provider hang-up, etc.) instead of emitting a `chunk.type ===
    // "error"` chunk. Without this catch the placeholder would stay
    // `streaming: true` forever — the symptom is "director loads
    // forever, refresh doesn't help" because the stuck state is
    // persisted to the messages row and getRoomFullState reads it
    // back as-is. Mark as final-with-error here so the UI moves on
    // and the next user tick can plan a fresh round, then re-throw
    // so pumpQueue's outer catch still logs (and skips the
    // speakersThisTurn increment).
    errored = true;
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[stream-throw] room=${roomId} agent=${speaker.name} modelV=${speaker.modelV} · ${msg}\n`,
    );
    updateMessageBody(placeholder.id, buf || `[error: ${msg}]`, {
      ...placeholderMeta,
      speakerStatus: "final",
      streaming: false,
      error: msg,
    });
    roomBus.emit(roomId, {
      type: "message-error",
      messageId: placeholder.id,
      message: msg,
    });
    throw e;
  }

  if (signal.aborted) {
    finishReason = finishReason ?? "aborted";
  }

  // If the LLM never produced any text, drop the empty placeholder rather
  // than leaving a blank bubble in the chat. Common reasons: aborted before
  // first token, provider returned no content, context-window refusal.
  // Errored turns are KEPT (with the `[error: …]` body) so the user can
  // see what went wrong rather than getting a silent disappearance.
  const hasContent = buf.trim().length > 0;
  if (!hasContent && !errored) {
    deleteMessage(placeholder.id);
    roomBus.emit(roomId, {
      type: "message-removed",
      messageId: placeholder.id,
      reason: finishReason || "empty",
    });
    return;
  }

  if (!errored) {
    updateMessageBody(placeholder.id, buf, {
      ...placeholderMeta,
      speakerStatus: "final",
      streaming: false,
      ...(finishReason ? { finishReason } : {}),
    });
    roomBus.emit(roomId, {
      type: "message-final",
      messageId: placeholder.id,
      finishReason,
    });
  }
}

/** System-side note (e.g. "agent has unknown model"). */
function appendSystemMessage(roomId: string, body: string): void {
  const m = insertMessage({ roomId, authorKind: "system", body });
  roomBus.emit(roomId, {
    type: "message-appended",
    messageId: m.id,
    authorKind: "system",
    authorId: null,
    replyToId: null,
    body: m.body,
    meta: m.meta,
    roundNum: m.roundNum,
    createdAt: m.createdAt,
  });
  roomBus.emit(roomId, { type: "message-final", messageId: m.id });
}

/** Snapshot used by GET /api/rooms/:id. The chair shows up in
 *  `chair` separately from `members` (which is directors only) so
 *  the frontend can render them differently. */
export function getRoomFullState(roomId: string): {
  room: Room;
  members: Agent[];
  chair: Agent | null;
  messages: Message[];
  keyPoints: ReturnType<typeof listKeyPointsForRoom>;
} | null {
  const room = getRoom(roomId);
  if (!room) return null;
  const memberRows = listRoomMembers(roomId);
  const all = memberRows
    .map((m) => getAgent(m.agentId))
    .filter((a): a is Agent => a !== null);
  const members = all.filter((a) => a.roleKind === "director");
  const chair = all.find((a) => a.roleKind === "moderator") ?? null;
  const messages = listRecentMessages(roomId, 200);
  const keyPoints = listKeyPointsForRoom(roomId);
  return { room, members, chair, messages, keyPoints };
}

/** Current speaking-queue snapshot — shown to clients on initial load. */
export function getRoomQueueSnapshot(roomId: string): {
  queue: QueueEntry[];
  round: { spoken: number; total: number };
} {
  const s = _state.get(roomId);
  if (!s) return { queue: [], round: { spoken: 0, total: 0 } };
  return {
    queue: s.queue.map((q) => ({ ...q })),
    round: { spoken: s.speakersThisTurn, total: s.maxSpeakersThisTurn },
  };
}
