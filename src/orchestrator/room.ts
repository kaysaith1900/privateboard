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
import { getActiveWebSearchCredentials, hasWebSearchKey } from "../storage/keys.js";
import { getPrefs } from "../storage/prefs.js";
import {
  reachableModelVs,
  reconcileAgentModels,
} from "../storage/reconcile-models.js";
import { getRoom, listAllRoomMembers, listRoomMembers, setAwaitingContinue, setRoomStatus, type Room } from "../storage/rooms.js";
import { getBrief } from "../storage/briefs.js";

import { formatSearchResults, runWebSearch } from "../ai/skills/web-search.js";
import { isBillingError, extractProviderHint } from "../ai/billing-error.js";
import {
  announceBillingNotice,
  announceIntervention,
  announceRoundOpen,
  announceRoundPrompt,
  emitChairPending,
  runChairDirectResponse,
  runChairRoundEnd,
} from "./chair.js";
import { buildDirectorContext } from "./context.js";
import { extractDominantTerms } from "./frame-break.js";
import { buildDirectorMessages, buildFollowUpPriorContext } from "./prompt.js";
import {
  getRecentUnexploredAngles,
  markAnglesConsumed,
} from "../storage/negative-space.js";
import { scoreAndArchive } from "./qd-scorer.js";
import { tagMessageBranch } from "./topic-tagger.js";
import {
  dominantBranches,
  speakersOnBranches,
} from "../storage/topic-branches.js";
import { pickNextSpeaker, pickRoundWrap, pickSkills } from "./skill-picker.js";
import { roomBus, type RoomEvent } from "./stream.js";
import { withTimeout, TimeoutError } from "./timeouts.js";
import { emitAutoSkipped } from "./auto-skip.js";
import { finalizeStreamingMessage } from "../storage/messages.js";
import { listSkillsForAgent } from "../storage/skills.js";
import { SentenceChunker } from "../voice/sentence-splitter.js";
import { stripSpokenLabels, synthesizeSpeechStream, tryExtractTtsBillingError, voiceProfileForAgent } from "../voice/tts.js";
import type { AgentVoiceProfile } from "../storage/agents.js";

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

/** Pre-warmed next-speaker state · cross-director pipelining.
 *  Populated by the `onMessageFinal` hook of the currently-streaming
 *  director's `streamSpeakerTurn` — the moment LLM text is done (so
 *  the next speaker's prompt has the full context), we fire B's
 *  streamSpeakerTurn off the side. The promise resolves in the
 *  background while A's TTS plays out client-side; pumpQueue's next
 *  iteration consumes it without re-issuing the call. `messageId` is
 *  empty until streamSpeakerTurn's `onPlaceholder` callback fills it
 *  in (after insertMessage + message-appended emit). */
interface PreWarmedSpeaker {
  agentId: string;
  messageId: string;
  promise: Promise<string | null>;
  abortController: AbortController;
}

interface RoomState {
  queue: QueueEntry[];
  /** In-flight LLM streams keyed by messageId. Up to two active at
   *  once during pre-warm: the currently-audible director (A) + the
   *  pre-warmed next-up (B). The map allows abort routes
   *  (abortRoom / chairInterrupt / tickRoom) to fan out an abort over
   *  every active stream. Sentinel key `pending:<agentId>` is used
   *  for the brief window between AbortController creation and the
   *  placeholder.id being known (streamSpeakerTurn rekeys via the
   *  `onPlaceholder` callback). */
  inflight: Map<string, AbortController>;
  /** One-deep look-ahead · the next speaker whose LLM is already
   *  running in the background. Null when no pre-warm is active.
   *  Consumed at the top of the next pumpQueue iteration when its
   *  `agentId` matches queue[0]. */
  preWarmed: PreWarmedSpeaker | null;
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
  /** Manual-vote-trigger deferred path · set by the user clicking
   *  "After current speaker" in the bottom-bar vote overlay while a
   *  director streams. pumpQueue checks this between speakers and,
   *  if set, clears the queue + dispatches runChairRoundEnd so the
   *  vote phase opens cleanly after the in-flight turn finishes.
   *  In-process only — a server restart loses the deferral, but the
   *  user can re-click the button after recovery. */
  pendingRoundEnd: boolean;
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
  /** Frame-break terms computed by pumpQueue (Layer 1.4 / 2.1) for
   *  the upcoming director turn. When non-empty, the next
   *  streamSpeakerTurn skips its own `extractDominantTerms` call and
   *  reuses this list — avoiding a duplicate haiku call. Cleared
   *  inside streamSpeakerTurn after consumption. */
  pendingFrameBreakTerms: string[] | null;
  /** Frame-breaker role assignment (Layer 2.2) · designates a single
   *  director per reactive round to do a structural frame-break move.
   *  Populated by pumpQueue and consumed by streamSpeakerTurn when
   *  the matching speaker spins up. Cleared after consumption. */
  pendingFrameBreakerRole: { agentId: string; convergentFrame: string } | null;
  /** Per-round rotation tracker for the frame-breaker role · stores
   *  the agentId chosen this reactive round so we can rotate to a
   *  different director next time. Reset at user-tick boundary. */
  lastFrameBreakerAgentId: string | null;
  /** Set when a director turn fails with a billing / quota error. The
   *  pump checks this between turns and drains the queue without firing
   *  more directors — once the carrier is dry, every subsequent call
   *  would just hit the same upstream rejection. The flag clears on the
   *  next user-message tick (tickRoom resets state) so the user can try
   *  again after fixing the key. */
  billingHaltedThisTurn: boolean;
  /** Per-message voice playback waiter. `resolve()` fires when the
   *  client POSTs /voice-done. `bump()` resets the no-heartbeat
   *  timeout — every /voice-progress POST from the client (driven by
   *  audio.timeupdate) calls this so a long but actively-playing
   *  audio doesn't trip the fallback. The fallback only fires when
   *  the heartbeat goes silent (browser tab killed, network drop). */
  voiceWaiters: Map<string, { resolve: () => void; bump: () => void }>;
  /** Pre-done messageIds · client posted /voice-done BEFORE the
   *  orchestrator called waitForVoicePlayback for that id. Without
   *  this set, the late waitForVoicePlayback would hang for its 30s
   *  fallback because the resolving POST has already been consumed
   *  and discarded. The user-skip path can race here in particular:
   *  POST /voice-done lands while streamSpeakerTurn is still
   *  processing the LLM abort; by the time pumpQueue gets to
   *  waitForVoicePlayback(messageId), the "done" signal is gone.
   *  waitForVoicePlayback checks this set first and resolves
   *  immediately if pre-marked, then deletes the entry. */
  voicePredone: Set<string>;
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

/** Detect "meta-silence" responses · short LLM completions that just
 *  narrate the model's abstention rather than carrying substance.
 *  Common after long rooms (~14+ rounds): the model has nothing new
 *  and outputs `（沉默）` / `(silent)` / `I have nothing to add` /
 *  `pass this round` instead of returning empty. Those bubbles read
 *  as bugs ("the director gave up") and pollute the transcript.
 *  This helper returns true when the buf is short AND matches one of
 *  the abstention patterns; the caller then drops the placeholder
 *  the same way it handles a true empty completion.
 *
 *  Threshold: 60 chars · long enough to catch every observed
 *  abstention phrase ("我没有更多要补充的了。" is 11; "I have
 *  nothing further to add at this point." is 41) but short enough
 *  not to flag a legitimate one-line zinger that happens to contain
 *  one of the keywords. Real director turns are typically ≥ 200
 *  chars even at the terse intensity. */
function looksLikeMetaSilence(body: string): boolean {
  const stripped = body.replace(/[\s\p{P}]/gu, "");
  if (stripped.length === 0) return true;
  if (body.length > 60) return false;
  const SILENCE_PATTERNS: RegExp[] = [
    /^[\s\p{P}]*[（(]\s*(?:沉默|silent|silence|skip|pass|abstain|abstention|noop|no\s*op|—)\s*[)）][\s\p{P}]*$/iu,
    /(沉默|无新|无补充|无更多|没有(?:更多|新)的?(?:观点|要(?:补充|说|加))|跳过(?:这|本)?(?:轮|回合)|本轮(?:跳过|沉默)|这轮(?:跳过|沉默)|我(?:选择)?(?:沉默|跳过|不发言|不说话))/u,
    /\b(?:I\s+(?:have\s+)?nothing\s+(?:more|further|to\s+add)|nothing\s+(?:more|new|to\s+add|further)|pass(?:ing)?\s+(?:this|on\s+this)\s+round|skip(?:ping)?\s+(?:this|my)\s+turn|abstain(?:ing)?(?:\s+this\s+(?:round|turn))?|no\s+(?:new\s+)?point\s+(?:to\s+add|here)|nothing\s+to\s+contribute)\b/i,
  ];
  return SILENCE_PATTERNS.some((re) => re.test(body));
}

function ensureState(roomId: string): RoomState {
  let s = _state.get(roomId);
  if (!s) {
    s = {
      queue: [],
      inflight: new Map(),
      preWarmed: null,
      processing: false,
      roundNum: 1,
      speakersThisTurn: 0,
      maxSpeakersThisTurn: 0,
      pauseAfterCurrent: false,
      pendingUserAfterCurrent: null,
      pendingRoundEnd: false,
      savedOnPause: null,
      pendingChairPick: null,
      pendingFrameBreakTerms: null,
      pendingFrameBreakerRole: null,
      lastFrameBreakerAgentId: null,
      billingHaltedThisTurn: false,
      voiceWaiters: new Map(),
      voicePredone: new Set(),
    };
    _state.set(roomId, s);
  }
  return s;
}

export function markVoicePlaybackDone(roomId: string, messageId: string): boolean {
  const s = _state.get(roomId);
  if (!s) return false;
  const waiter = s.voiceWaiters.get(messageId);
  if (waiter) {
    s.voiceWaiters.delete(messageId);
    waiter.resolve();
    return true;
  }
  // No waiter yet · record the "done" signal so a later
  // waitForVoicePlayback for this messageId resolves immediately
  // instead of hanging for the fallback. The user-initiated skip
  // path races here: the client POSTs /voice-done while
  // streamSpeakerTurn is still in its catch, then pumpQueue
  // eventually calls waitForVoicePlayback when the function returns
  // — by which point the "done" signal has nowhere to land.
  s.voicePredone.add(messageId);
  return false;
}

/** Client heartbeat · the audio element is actively producing sound.
 *  Called from POST /voice-progress, fired by the client every few
 *  seconds while audio.timeupdate ticks. Resets the no-heartbeat
 *  timeout so long playback (slow rate, long response) doesn't trip
 *  the fallback. Returns true when a waiter was found (and bumped),
 *  false when none was registered (waitForVoicePlayback hadn't been
 *  called yet, or the message is already done). */
export function bumpVoicePlaybackHeartbeat(roomId: string, messageId: string): boolean {
  const s = _state.get(roomId);
  if (!s) return false;
  const waiter = s.voiceWaiters.get(messageId);
  if (!waiter) return false;
  waiter.bump();
  return true;
}

/** Server-side fallback timeout for the client to POST /voice-done.
 *  The timeout is HEARTBEAT-BASED · every /voice-progress POST from
 *  the client (driven by audio.timeupdate while playback advances)
 *  resets the clock. So as long as audio is actively playing on the
 *  client, the wait extends indefinitely. The fallback only fires
 *  when the heartbeat goes silent — meaning the browser tab was
 *  killed, the user navigated away mid-audio, or the network dropped.
 *  60s of silence is generous enough to absorb a brief network blip
 *  while still recovering from a true client crash within the same
 *  minute. */
export function waitForVoicePlayback(
  roomId: string,
  messageId: string,
  timeoutMs = 60_000,
): Promise<void> {
  const s = ensureState(roomId);
  // Pre-done check · honour any /voice-done POST that arrived
  // BEFORE this waiter was registered. Consume the flag so subsequent
  // waits for the same id (shouldn't happen, but defensive) don't
  // resolve spuriously.
  if (s.voicePredone.has(messageId)) {
    s.voicePredone.delete(messageId);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        s.voiceWaiters.delete(messageId);
        process.stderr.write(
          `[voice-wait] no-heartbeat fallback fired for msg=${messageId.slice(0, 8)} after ${timeoutMs}ms\n`,
        );
        resolve();
      }, timeoutMs);
    };
    arm();
    s.voiceWaiters.set(messageId, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      bump: () => {
        clearTimeout(timer);
        arm();
      },
    });
  });
}

/** True if any director is currently streaming a turn. Counts BOTH
 *  the audible speaker and the pre-warmed look-ahead. */
export function isRoomSpeaking(roomId: string): boolean {
  const s = _state.get(roomId);
  if (!s) return false;
  return s.inflight.size > 0;
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
  rlog(roomId, "soft-pause-requested", { remaining: s.queue.length, speaking: s.inflight.size });
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

/** Manual-vote-trigger deferred path · queue a round-end to fire
 *  after the current speaker finishes their turn. pumpQueue checks
 *  this flag between turns and dispatches runChairRoundEnd; the
 *  remaining queued directors are dropped (the chair's vote phase
 *  supersedes them). The route handler uses this when the user
 *  picks "After current speaker" in the bottom-bar vote overlay
 *  while a director is in flight. */
export function requestRoundEndAfterCurrent(roomId: string): void {
  const s = ensureState(roomId);
  s.pendingRoundEnd = true;
  rlog(roomId, "round-end-deferred", { remaining: s.queue.length, speaking: s.inflight.size });
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

  // Abort all in-flight speakers (audible + pre-warmed) · cancel
  // their streams. The chair direct response supersedes whatever
  // director(s) were running. Pre-warmed must also abort so its LLM
  // doesn't keep producing tokens after the chair takes over.
  let interruptedAgentId: string | null = null;
  if (state.inflight.size > 0) {
    interruptedAgentId = state.queue[0]?.agentId ?? null;
    for (const ac of state.inflight.values()) ac.abort();
    state.inflight.clear();
  }
  if (state.preWarmed) {
    try { state.preWarmed.abortController.abort(); } catch (_) {}
    state.preWarmed = null;
  }
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
  const wasSpeaking = s.inflight.size > 0;
  // Don't reset s.speakersThisTurn — leaving it at K means the
  // queue-update we emit below carries the *true* "K spoken / N total"
  // for the paused round. Resetting it to 0 used to make the round
  // counter momentarily lie about its own state ("0 of N" mid-pause)
  // and any UI gate that consults currentRound during the pause window
  // would read the wrong value. resumeRoom restores from the snapshot
  // (a no-op since we kept the same value here); tickRoom does its own
  // explicit reset when the resume falls through to a fresh replan.
  for (const ac of s.inflight.values()) ac.abort();
  s.inflight.clear();
  // Pre-warmed look-ahead · abort + clear. The pre-warmed speaker's
  // LLM was launched without user consent for "right now play it";
  // a hard pause should kill it cleanly so credits aren't burned on
  // tokens nobody will hear.
  if (s.preWarmed) {
    try { s.preWarmed.abortController.abort(); } catch (_) {}
    s.preWarmed = null;
  }
  // Clear all pending voice waiters so waitForVoicePlayback resolves
  // immediately instead of hanging for its fallback timeout. The
  // frontend already stopped playback on hard-pause; these waiters
  // will never be fulfilled by a voice-done POST.
  for (const [, waiter] of s.voiceWaiters) {
    waiter.resolve();
  }
  s.voiceWaiters.clear();
  // Pre-done flags are room-scoped state · a hard pause invalidates
  // any deferred "done" signals, so clear them too. Otherwise a stale
  // predone entry from before pause could short-circuit a future
  // legitimate waitForVoicePlayback after resume.
  s.voicePredone.clear();
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

  // Abort all in-flight speakers (audible + pre-warmed). The pump's
  // finally clause will see the new queue when it resumes. Replanning
  // invalidates whoever was pre-warmed (their context is now stale),
  // so kill that one too.
  for (const ac of state.inflight.values()) ac.abort();
  state.inflight.clear();
  if (state.preWarmed) {
    try { state.preWarmed.abortController.abort(); } catch (_) {}
    state.preWarmed = null;
  }

  // Voice rooms · the aborted speaker streamed some text before the abort
  // → streamSpeakerTurn returns its messageId (not null) → the pump is
  // now sitting in `await waitForVoicePlayback(messageId)`, which only
  // resolves when the frontend POSTs /voice-done OR the 120s timeout
  // fires. After an interrupt (e.g. user picked "interrupt and send" on
  // a Second / Probe), the frontend stops the audio and the new round
  // takes over — /voice-done never lands, so the pump hangs for up to
  // two minutes before picking up the replanned queue. Drain all
  // outstanding waiters here so the pump unblocks immediately and
  // continues with the fresh plan. Mirrors abortRoom's voice-waiter
  // drain. Safe in text rooms · voiceWaiters is empty there.
  for (const [, waiter] of state.voiceWaiters) {
    waiter.resolve();
  }
  state.voiceWaiters.clear();

  state.queue = plan.map((a) => ({ agentId: a.id, status: "queued" }));
  state.roundNum = opts.roundNum;
  state.speakersThisTurn = 0;
  // A fresh user message replans the round — drop any pause snapshot.
  state.savedOnPause = null;
  // Drop any pending chair-pick rationale — it belonged to the prior
  // queue, not this fresh plan. Otherwise it could leak onto a future
  // speaker who happens to share the prior pick's agentId.
  state.pendingChairPick = null;
  // Divergence-stack scratch state also belongs to the prior plan; reset.
  state.pendingFrameBreakTerms = null;
  state.pendingFrameBreakerRole = null;
  state.lastFrameBreakerAgentId = null;
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

/* ── Cross-director pre-warm helpers ──────────────────────────────────
   Called by streamSpeakerTurn's `onMessageFinal` callback to launch
   the NEXT director's LLM stream while the current director's TTS is
   still playing on the client. Depth-1: never pre-warm more than one
   ahead. Reuses pickNextSpeaker for discipline (with a 15s timeout
   fallback to queue order). Stores the in-flight promise in
   state.preWarmed; pumpQueue's next iteration consumes it without
   re-issuing the LLM call. */

function schedulePreWarm(roomId: string, currentMessageId: string): void {
  // Fire-and-forget · the picker haiku is awaited inside, but pumpQueue
  // doesn't block on this scheduling call. Errors are logged, never
  // thrown — pre-warm is a UX optimisation, not a correctness gate.
  void runPickerThenPrewarm(roomId, currentMessageId).catch((e) => {
    process.stderr.write(`[pre-warm] failed: ${e instanceof Error ? e.message : String(e)}\n`);
  });
}

async function runPickerThenPrewarm(roomId: string, _currentMessageId: string): Promise<void> {
  const state = ensureState(roomId);
  // Race guards · these checks fire in the brief window between
  // message-final emit and pumpQueue's next iteration consuming
  // preWarmed. abortRoom / tickRoom / chairInterrupt all clear
  // preWarmed; if anyone did so between scheduling and execution,
  // bail out (the room state has moved on).
  if (state.preWarmed) return;
  if (state.queue.length < 2) return;
  const room = getRoom(roomId);
  if (!room || room.status !== "live") return;
  if (room.deliveryMode !== "voice") return; // text mode has no TTS gap to fill
  if (state.pendingRoundEnd || state.pauseAfterCurrent || state.billingHaltedThisTurn) return;
  if (room.awaitingClarify || room.awaitingContinue) return;

  // Lightweight picker discipline · simpler than pumpQueue's inline
  // path (no divergence-stack / convergent-terms feedback). The v1
  // pre-warm path trades that nuance for the 5-15s latency win.
  // When the picker times out or errors, fall back to queue order.
  const recent = listRecentMessages(roomId, 30);
  const directorAlreadySpoke = recent.some((m) => {
    if (m.authorKind !== "agent" || m.roundNum !== state.roundNum) return false;
    if ((m.meta as { kind?: string })?.kind) return false;
    const a = m.authorId ? getAgent(m.authorId) : null;
    return a?.roleKind === "director";
  });

  const candidates: Agent[] = state.queue
    .map((q) => getAgent(q.agentId))
    .filter((a): a is Agent => a !== null);

  let pickedAgentId: string | null = null;
  if (directorAlreadySpoke && candidates.length >= 2) {
    try {
      const pick = await withTimeout(
        pickNextSpeaker({
          candidates,
          history: recent,
          room: { subject: room.subject ?? null },
          mode: "lens-gap",
        }),
        15_000,
        "prewarm-picker",
      );
      pickedAgentId = pick.agentId;
    } catch (e) {
      process.stderr.write(`[pre-warm picker] ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // Re-check race guards after the await · the room might have moved
  // on while picker was running.
  if (state.preWarmed) return;
  const live = getRoom(roomId);
  if (!live || live.status !== "live") return;
  if (state.queue.length < 2) return;

  // Reorder · move picker's choice into queue[1] (queue[0] is the
  // currently-audible director, still streaming TTS chunks).
  if (pickedAgentId) {
    const idx = state.queue.findIndex((q) => q.agentId === pickedAgentId);
    if (idx > 1) {
      const [picked] = state.queue.splice(idx, 1);
      state.queue.splice(1, 0, picked!);
      emitQueueUpdate(roomId, state);
    }
  }

  const nextEntry = state.queue[1];
  if (!nextEntry) return;
  const nextSpeaker = getAgent(nextEntry.agentId);
  if (!nextSpeaker) return;
  // Skip self-heal here · streamSpeakerTurn does its own reconcile if
  // the modelV isn't reachable, so we don't need to duplicate.

  // Spin up B's stream fire-and-forget. Inflight is keyed by the
  // sentinel until streamSpeakerTurn calls onPlaceholder with the
  // real messageId, at which point we rekey.
  const ac = new AbortController();
  const sentinel = `pending:${nextSpeaker.id}`;
  state.inflight.set(sentinel, ac);

  rlog(roomId, "prewarm-start", {
    agent: nextSpeaker.name,
    agentId: nextSpeaker.id,
    pickedByHaiku: !!pickedAgentId,
    queueHead: state.queue[0]?.agentId,
  });

  const preWarmed: PreWarmedSpeaker = {
    agentId: nextEntry.agentId,
    messageId: "",
    promise: Promise.resolve(null), // backfilled below
    abortController: ac,
  };

  preWarmed.promise = streamSpeakerTurn({
    roomId,
    speaker: nextSpeaker,
    roundNum: state.roundNum,
    signal: ac.signal,
    preWarmed: true,
    onPlaceholder: (info) => {
      preWarmed.messageId = info.messageId;
      if (state.inflight.has(sentinel)) {
        state.inflight.delete(sentinel);
        state.inflight.set(info.messageId, ac);
      }
    },
    // Chain trigger lives in pumpQueue's consume point, NOT here.
    // Rationale: B's `message-final` fires while B is still occupying
    // `state.preWarmed`. A nested schedulePreWarm() call from inside
    // B's pre-warm stream would hit the `if (state.preWarmed) return`
    // guard at the top of runPickerThenPrewarm and bail — C never
    // gets pre-warmed, depth-1 collapses to "first pair only". The
    // correct hook is the moment pumpQueue clears preWarmed (consume
    // path); at that instant the slot is free, the queue head has
    // advanced, and the next pre-warm has the right context.
    // onMessageFinal intentionally omitted.
  });

  state.preWarmed = preWarmed;
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
      // Pre-warmed consume · the prior iteration's onMessageFinal
      // scheduled this speaker's LLM ahead of time (runPickerThenPrewarm
      // already ran the picker + started streamSpeakerTurn). If the
      // pre-warmed agent matches queue[0], skip the inline picker block
      // below (it would re-run pointlessly) and reuse the in-flight
      // promise + AbortController.
      const preWarmedHit = !!(state.preWarmed && state.queue[0]
        && state.preWarmed.agentId === state.queue[0].agentId);
      // ─── Next-speaker discipline · reactive rounds only ───────────
      // Before pulling the head of the queue, ask haiku to pick the
      // director whose lens most sharply addresses the previous turn's
      // unresolved tension. Skipped on opening rounds (parallel, no
      // prior turn to react to), on the FIRST speaker of a reactive
      // round (no prior turn yet either), and on single-candidate
      // queues. Failures fall back to the existing round-robin order.
      // Also skipped when consuming a pre-warmed stream · the picker
      // already ran in runPickerThenPrewarm; re-running here would
      // emit a confusing chair-pending "next-speaker" placeholder.
      if (!preWarmedHit && state.queue.length >= 2) {
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
              // Surface pre-TTFT loading · the picker's haiku call is
              // the silent gap before either a chair-note intervention
              // or the next director's bubble lands. Without this
              // placeholder the user stares at a static chat for 1-3s
              // with no signal that the room is moving. Cleared the
              // moment the next agent message-appended fires (chair
              // intervention OR director turn — frontend handler
              // hides on any agent author).
              emitChairPending(roomId, "next-speaker");
              // Fetch room here so the picker can language-lock the
              // intervention to room.subject (avoids the feedback-loop
              // bug where one stray English director turn re-biased
              // the detector toward English in a Chinese room).
              const pickRoom = getRoom(roomId);
              // Divergence stack · Layer 2.1 + 2.3 + 1.4 cooperate here:
              // (1) extractDominantTerms (Layer 1.4) finds the room's
              //     recurring fixation. Single haiku call per turn.
              // (2) If terms found → room is at least loosely converging.
              //     Flip picker into dissent-gap mode (Layer 2.1) so the
              //     next speaker is the director most likely to puncture
              //     the cluster, not just the unused-lens pick.
              // (3) Stash terms on state so streamSpeakerTurn (Layer 1.4)
              //     reuses them as frameBreakTerms without re-extracting.
              // (4) When terms found AND not yet assigned this round,
              //     designate ONE director (preferring NOT the most-
              //     recent frame-breaker) as the round's frame-breaker
              //     (Layer 2.2).
              let convergentTerms: string[] = [];
              try {
                convergentTerms = await extractDominantTerms({ messages: recent });
              } catch { /* swallowed inside; defensive */ }
              // Layer 3.1 · also feed the dominant TOPIC BRANCH labels
              // (from the topic-tree tagger) into the convergence signal.
              // The text-LLM extractor misses cluster signals that the
              // branch tagger has already classified; merging both gives
              // the picker a more reliable "what is the room over-
              // investing in" hint. Dedupe in case the two signals
              // overlap. Safe when no branches exist yet · returns [].
              try {
                const branches = dominantBranches(roomId, 3);
                if (branches.length > 0) {
                  const seen = new Set(convergentTerms.map((t) => t.toLowerCase()));
                  for (const b of branches) {
                    if (b.turnCount >= 2 && !seen.has(b.label.toLowerCase())) {
                      convergentTerms.push(b.label);
                      seen.add(b.label.toLowerCase());
                    }
                  }
                }
              } catch { /* defensive */ }
              const useDissentMode = convergentTerms.length > 0;
              if (useDissentMode) {
                state.pendingFrameBreakTerms = convergentTerms.slice();
                rlog(roomId, "divergence-detect", {
                  terms: convergentTerms,
                  pickerMode: "dissent-gap",
                });
              }
              // Layer 3.1 → 2.1 feedback · reorder candidates so the
              // picker LLM sees "underexposed" speakers first (those
              // who have NOT been tagged on the dominant branches).
              // The picker still has the final say, but front-loading
              // the underexposed set means the LLM's recency bias
              // works FOR divergence here.
              let pickerCandidates = candidates;
              if (useDissentMode) {
                try {
                  const branches = dominantBranches(roomId, 3);
                  const dominantBranchIds = branches.map((b) => b.id);
                  if (dominantBranchIds.length > 0) {
                    const exposed = speakersOnBranches(roomId, dominantBranchIds);
                    const underexposed = candidates.filter((c) => !exposed.has(c.id));
                    const overexposed = candidates.filter((c) => exposed.has(c.id));
                    if (underexposed.length > 0 && overexposed.length > 0) {
                      pickerCandidates = [...underexposed, ...overexposed];
                    }
                  }
                } catch { /* defensive */ }
              }
              // 15s timeout · picker is a single haiku call (2–3s typical).
              // If it hangs we fall back to the existing round-robin
              // queue order — pick.agentId resolves to null and the
              // reorder-block below skips, letting state.queue[0] win.
              // emitAutoSkipped tells the client a fallback happened so
              // the user sees a toast instead of wondering why the
              // dissent-mode pick didn't take effect.
              const fallbackPick: Awaited<ReturnType<typeof pickNextSpeaker>> = {
                agentId: null, rationale: "", intervention: null,
              };
              let pick: Awaited<ReturnType<typeof pickNextSpeaker>> = fallbackPick;
              try {
                pick = await withTimeout(
                  pickNextSpeaker({
                    candidates: pickerCandidates,
                    history: recent,
                    room: pickRoom ?? undefined,
                    mode: useDissentMode ? "dissent-gap" : "lens-gap",
                    convergentTerms: useDissentMode ? convergentTerms : undefined,
                  }),
                  15_000,
                  "speaker-picker",
                );
              } catch (e) {
                if (e instanceof TimeoutError) {
                  process.stderr.write(`[picker] timeout — falling back to round-robin\n`);
                  emitAutoSkipped(roomId, "picker", "picker-timeout");
                } else {
                  process.stderr.write(
                    `[picker] error: ${e instanceof Error ? e.message : String(e)}\n`,
                  );
                }
                pick = fallbackPick;
              }
              // Frame-breaker rotation · Layer 2.2 · designate ONE
              // director per converging reactive round to do a
              // structural frame-break. Preference order:
              //  (1) the speaker the picker just chose, if they're not
              //      the most-recent frame-breaker (rotation rule)
              //  (2) any candidate other than the most-recent
              //      frame-breaker
              //  (3) skip · all candidates have been frame-breaker
              //      recently, let dissent-picker carry the load alone
              // Stash on state so streamSpeakerTurn consumes when the
              // matching speaker spins up.
              if (useDissentMode && convergentTerms.length > 0) {
                const lastBreaker = state.lastFrameBreakerAgentId;
                const chosenId = pick.agentId ?? state.queue[0]?.agentId;
                let breakerId: string | null = null;
                if (chosenId && chosenId !== lastBreaker) {
                  breakerId = chosenId;
                } else {
                  const alt = candidates.find((c) => c.id !== lastBreaker && c.id !== chosenId);
                  if (alt) breakerId = alt.id;
                }
                if (breakerId) {
                  // Convergent frame label · first/strongest term, capped.
                  const frameLabel = (convergentTerms[0] || "").slice(0, 60);
                  state.pendingFrameBreakerRole = {
                    agentId: breakerId,
                    convergentFrame: frameLabel,
                  };
                  rlog(roomId, "frame-breaker-assign", {
                    agent: getAgent(breakerId)?.name ?? breakerId,
                    frame: frameLabel,
                  });
                }
              }
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
                  // Await · in voice mode the chair audio plays
                  // before the next director starts streaming, so
                  // the user hears the intervention as a distinct
                  // beat between turns rather than overlapping.
                  await announceIntervention(roomId, pick.intervention, pick.rationale);
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

      // Dispatch · consume pre-warmed promise when its agent matches
      // queue[0], otherwise start streamSpeakerTurn fresh. The fresh
      // path wires onPlaceholder (rekey inflight) and onMessageFinal
      // (schedule the FIRST pre-warm A→B). Subsequent links in the
      // rolling depth-1 chain (B→C, C→D, ...) are scheduled right
      // here at the consume point — see comment below.
      let ac: AbortController;
      let streamPromise: Promise<string | null>;
      if (preWarmedHit && state.preWarmed) {
        const justConsumed = state.preWarmed;
        ac = state.preWarmed.abortController;
        streamPromise = state.preWarmed.promise;
        state.preWarmed = null;
        rlog(roomId, "speaker-prewarm-consumed", {
          agent: speaker.name,
          agentId: speaker.id,
        });
        // Rolling depth-1 chain · the slot we just freed is the
        // place for the NEXT pre-warm. Without this hook the chain
        // dies after the A→B handoff: B's onMessageFinal already
        // fired while state.preWarmed was still B (guard bail in
        // runPickerThenPrewarm), so nothing ever schedules C. By
        // calling here, C/D/E each get pre-warmed exactly when the
        // queue head advances. schedulePreWarm has its own race
        // guards (live status, queue.length>=2, not paused, etc.),
        // so this is safe even when the round is winding down.
        schedulePreWarm(roomId, justConsumed.messageId);
      } else {
        rlog(roomId, "speaker-fresh-path", {
          agent: speaker.name,
          agentId: speaker.id,
          hasPrewarm: !!state.preWarmed,
          prewarmAgent: state.preWarmed?.agentId ?? null,
          queueHead: state.queue[0]?.agentId,
          note: "Pre-warm did NOT cover this speaker · they go through fresh path. Their meta.preWarmed will be false; their bubble will NOT be hidden during a prior TTS.",
        });
        ac = new AbortController();
        const sentinel = `pending:${speaker.id}`;
        state.inflight.set(sentinel, ac);
        streamPromise = streamSpeakerTurn({
          roomId,
          speaker,
          roundNum: state.roundNum,
          signal: ac.signal,
          onPlaceholder: (info) => {
            if (state.inflight.has(sentinel)) {
              state.inflight.delete(sentinel);
              state.inflight.set(info.messageId, ac);
            }
          },
          onMessageFinal: (info) => {
            schedulePreWarm(roomId, info.messageId);
          },
        });
      }

      const turnStart = Date.now();
      rlog(roomId, "speaker-start", {
        agent: speaker.name,
        agentId: speaker.id,
        modelV: speaker.modelV,
        round: state.roundNum,
        position: `${state.speakersThisTurn + 1}/${state.maxSpeakersThisTurn}`,
        preWarmed: preWarmedHit,
      });

      try {
        const messageId = await streamPromise;
        // Voice mode: wait for the frontend to signal playback is complete
        // before allowing the next director to speak.
        if (messageId && getRoom(roomId)?.deliveryMode === "voice") {
          await waitForVoicePlayback(roomId, messageId);
        }
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
        // Clean up inflight by AbortController reference · the entry
        // may be keyed by `pending:<agentId>` sentinel OR by the real
        // messageId depending on whether onPlaceholder fired before
        // catch/finally. Walking by ref handles both.
        const keysToDel: string[] = [];
        for (const [key, val] of state.inflight) {
          if (val === ac) keysToDel.push(key);
        }
        for (const key of keysToDel) state.inflight.delete(key);
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

      // Manual-vote-trigger deferred path · the user clicked "After
      // current speaker" in the bottom-bar vote overlay while the
      // in-flight director was streaming. Drop any remaining queued
      // directors (the chair's vote phase supersedes them) and
      // dispatch runChairRoundEnd, which streams the chair's
      // round-end summary, persists key points, and flips
      // awaitingContinue. Fire-and-forget so the pump-loop can exit
      // cleanly; the chair stream lands via SSE just like the auto
      // path. Resolve roundNum the same way the route handler does
      // (latest user-message round) so key-point ownership lines up.
      if (state.pendingRoundEnd) {
        state.pendingRoundEnd = false;
        state.queue = [];
        emitQueueUpdate(roomId, state);
        const roundNum = Math.max(1, nextUserRoundNum(roomId) - 1);
        rlog(roomId, "round-end-honored", { round: roundNum });
        void runChairRoundEnd(roomId, roundNum).catch((e) => {
          process.stderr.write(`[room] deferred round-end failed: ${e instanceof Error ? e.message : String(e)}\n`);
        });
        break;
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
        !room.awaitingClarify &&
        room.voteTrigger === "manual"
      ) {
        // Manual vote-trigger · the chair is suppressed between
        // rounds (the user explicitly opted out of "what next"
        // gavels). Without auto-continue here, the room would
        // freeze at end-of-round with no chair turn and no next
        // round — the user reported this as "playback completely
        // stops when chair's turn comes up." Fix: tick a fresh
        // round so the directors keep speaking until the user
        // clicks the bottom-bar vote button.
        //
        // tickRoom is sync · it fires `void pumpQueue(roomId)`
        // after `state.processing` was already cleared above, so
        // pumpQueue safely re-enters for the next round.
        const nextRound = nextUserRoundNum(roomId);
        rlog(roomId, "manual-auto-continue", {
          fromRound: state.roundNum,
          toRound: nextRound,
        });
        tickRoom(roomId, { roundNum: nextRound, kind: "continue" });
      } else if (
        room &&
        room.status === "live" &&
        !room.awaitingContinue &&
        !room.awaitingClarify
      ) {
        // Auto vote-trigger · chair posts the round-prompt; the user
        // picks End-round (vote) or Continue from inline buttons.
        const wrappedRound = state.roundNum;
        // Bridge the silent gap · pickRoundWrap is a haiku (1-3s
        // typical, slow path 10s+ on network blips). Without a
        // signal, the user sees the room frozen after the last
        // director speaks. emitChairPending lights up the chair
        // seat with "Summarizing round" so the user understands
        // why the next 1-3s are quiet. Phase string maps to
        // i18n key rt_phase_vote_summary.
        emitChairPending(roomId, "vote-summary");
        let recommendation: { kind: "end" | "continue"; rationale: string } | undefined;
        try {
          const recent = listRecentMessages(roomId, 30);
          // 15s timeout · matches the rest of the haiku call sites
          // (clarify-decision, next-speaker picker). On timeout,
          // proceed without a recommendation → announceRoundPrompt
          // falls back to the neutral templated tail.
          const wrap = await withTimeout(
            pickRoundWrap({ history: recent, roundNum: wrappedRound, room }),
            15_000,
            "pickRoundWrap",
          );
          recommendation = { kind: wrap.recommendation, rationale: wrap.rationale };
        } catch (e) {
          if (e instanceof TimeoutError) {
            process.stderr.write(`[round-wrap] timeout — using neutral prompt\n`);
            emitAutoSkipped(roomId, "picker", "pickRoundWrap-timeout");
          } else {
            rlog(roomId, "round-wrap-error", {
              error: e instanceof Error ? e.message : String(e),
            });
          }
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
          // Await · voice mode plays the vote prompt audio before
          // the pump returns; the vote popover only mounts after
          // the chair has audibly handed control back to the user.
          await announceRoundPrompt(roomId, wrappedRound, recommendation);
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
  /** True when this stream is the pre-warmed look-ahead (B started
   *  while A's TTS is still playing). The placeholder meta carries
   *  `preWarmed: true` so the client knows to hide the chat bubble
   *  until the audio actually starts playing. Default false. */
  preWarmed?: boolean;
  /** Called synchronously right after the placeholder is inserted +
   *  `message-appended` is emitted. Lets pumpQueue rekey its
   *  `pending:<agentId>` sentinel in `state.inflight` to the real
   *  messageId, so abort routes (pause, chairInterrupt, tickRoom)
   *  see the canonical key. Best-effort · failures are swallowed. */
  onPlaceholder?: (info: { messageId: string }) => void;
  /** Called synchronously after `message-final` is emitted but before
   *  this function returns. Used by pumpQueue to schedule pre-warm
   *  of the next speaker the moment LLM text is done (TTS chunks may
   *  still be emitting). The callback runs inside the same task as
   *  the message-final emit so the timestamps line up; callers
   *  should keep it cheap (fire-and-forget). */
  onMessageFinal?: (info: { messageId: string }) => void;
}

async function streamSpeakerTurn(args: StreamArgs): Promise<string | null> {
  const { roomId, speaker, roundNum, signal, preWarmed = false, onPlaceholder, onMessageFinal } = args;

  const room = getRoom(roomId);
  if (!room) return null;

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
  // would benefit from a web-search query. Both are gated by the
  // user having configured the relevant key + the per-agent toggle.
  const installedSkills = listSkillsForAgent(speaker.id);
  // Research mode bypasses the per-agent web-search toggle · the
  // whole point of the room is mining external material, so we
  // assume every director can search by default. Other modes still
  // honour the per-director opt-in. A search API key (Brave and/or
  // Tavily) is still required — without one, web search cannot run
  // regardless of mode (the chair posts a one-time hint when a
  // research room opens; see runChairConvening / announceResearchHint).
  const isResearchMode = (room.mode || "").toLowerCase() === "research";
  const webSearchAvail = hasWebSearchKey() && (speaker.webSearchEnabled || isResearchMode);
  let activeSkills: ReturnType<typeof listSkillsForAgent> = [];
  let pickerReason = "";
  let webSearchQuery: string | null = null;
  if (installedSkills.length > 0 || webSearchAvail) {
    try {
      const picked = await pickSkills({
        speaker,
        skills: installedSkills,
        history,
        webSearchAvailable: webSearchAvail,
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

  // Run configured search backend when the router decided the turn needs fresh info.
  // Failure (timeout / network / 4xx) is non-fatal: the agent answers
  // without the SHARED MATERIALS block, never sees an error.
  let webSearchSources: Array<{ title: string; url: string; description: string }> = [];
  let sharedMaterialsBlock = "";
  if (webSearchAvail && webSearchQuery) {
    const creds = getActiveWebSearchCredentials();
    if (creds) {
      const results = await runWebSearch(creds.backend, creds.apiKey, webSearchQuery);
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
          backend: creds.backend,
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
          // Flatten the structured `assets` bundle into the flat
          // `{text, lens}` shape the prior-context block expects. Claims
          // carry the lens natively; tensions / risks / open questions
          // get a synthesized lens so they still surface in the
          // "PRIOR DIRECTOR SIGNALS" list. Other fields (evidence /
          // quotes / opportunities / actions / assumptions) are
          // already carried through the brief markdown body which
          // sits above this block, so we don't double-render them
          // here — keeps the follow-up prompt punchy.
          parentSignals: parentBrief && parentBrief.assets
            ? parentBrief.assets.map((d) => ({
                directorName: d.directorName,
                signals: [
                  ...d.claims.map((c) => ({ text: c.text, lens: c.lens })),
                  ...d.tensions.map((t) => ({ text: `[tension] ${t.text}`, lens: "dissent" })),
                  ...d.risks.map((r) => ({
                    text: r.severity ? `[risk·${r.severity}] ${r.text}` : `[risk] ${r.text}`,
                    lens: "structural",
                  })),
                  ...d.openQuestions.map((q) => ({
                    text: `[open-q·${q.priority}] ${q.text}`,
                    lens: "first-principle",
                  })),
                ],
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

  // Frame-break extraction · Layer 1.4 of the divergence stack.
  // Reuse the terms pumpQueue's pickNextSpeaker call already
  // computed when it ran in dissent-gap mode — saves a duplicate
  // haiku call per turn. Falls back to a fresh extraction when
  // pumpQueue skipped it (e.g. opening round, or pumpQueue couldn't
  // run for any reason and we're being driven by a tickRoom that
  // bypassed the picker). Either way, the result feeds
  // buildDirectorMessages as `frameBreakTerms`.
  const tStateForTurn = ensureState(roomId);
  let frameBreakTerms: string[] | undefined;
  if (tStateForTurn.pendingFrameBreakTerms && tStateForTurn.pendingFrameBreakTerms.length > 0) {
    frameBreakTerms = tStateForTurn.pendingFrameBreakTerms.slice();
    // Don't clear yet · multiple directors in the same round share
    // the snapshot. Cleared by the next pumpQueue when it computes
    // fresh terms, or by tickRoom on the next user message.
  } else if (roundNum > 1 && history.length >= 4) {
    try {
      frameBreakTerms = await extractDominantTerms({ messages: history });
      if (frameBreakTerms.length > 0) {
        rlog(roomId, "frame-break-extract", {
          round: roundNum,
          speaker: speaker.name,
          terms: frameBreakTerms,
          via: "stream-fallback",
        });
        tStateForTurn.pendingFrameBreakTerms = frameBreakTerms.slice();
      }
    } catch { /* defensive · already swallowed in extractDominantTerms */ }
  }
  // Frame-breaker role · Layer 2.2 · consume the pumpQueue
  // assignment if it matches this speaker, else null. Clear after
  // consumption so the role doesn't leak onto the next speaker.
  let frameBreakerRole: { convergentFrame: string } | undefined;
  if (tStateForTurn.pendingFrameBreakerRole &&
      tStateForTurn.pendingFrameBreakerRole.agentId === speaker.id) {
    frameBreakerRole = { convergentFrame: tStateForTurn.pendingFrameBreakerRole.convergentFrame };
    tStateForTurn.lastFrameBreakerAgentId = speaker.id;
    tStateForTurn.pendingFrameBreakerRole = null;
  }
  // Layer 3.2 · pull negative-space angles persisted at the previous
  // round-end. Top 3 unconsumed, newest first. Once injected we mark
  // them consumed so future turns don't re-suggest the same angle.
  let unexploredAngles: string[] | undefined;
  if (roundNum > 1) {
    try {
      const rows = getRecentUnexploredAngles(roomId, 3);
      if (rows.length > 0) {
        unexploredAngles = rows.map((r) => r.angle);
        markAnglesConsumed(rows.map((r) => r.id));
      }
    } catch (e) {
      process.stderr.write(
        `[room] unexplored-angles read failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
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
    frameBreakTerms,
    frameBreakerRole,
    unexploredAngles,
    deliveryMode: room.deliveryMode,
  });

  // Streaming placeholder so the UI has an id immediately.
  const placeholderMeta: Record<string, unknown> = {
    speakerStatus: "streaming",
    streaming: true,
  };
  // Pre-warm marker · the cross-director pipeline emits message-
  // appended for B while A's TTS is still playing on this client. The
  // client uses this flag to hide B's bubble (data-prewarmed) until
  // its audio actually starts. _fireVoiceDone's promote logic +
  // message-error fallback reveal the bubble at the right time.
  if (preWarmed) {
    placeholderMeta.preWarmed = true;
  }
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

  // Tell pumpQueue the placeholder.id so it can rekey its inflight
  // sentinel from `pending:<agentId>` to the real messageId. Best-
  // effort · callback errors are swallowed so a buggy listener can't
  // crash the stream.
  if (onPlaceholder) {
    try { onPlaceholder({ messageId: placeholder.id }); }
    catch (e) { process.stderr.write(`[onPlaceholder] ${e instanceof Error ? e.message : String(e)}\n`); }
  }

  let buf = "";
  let finishReason: string | undefined;
  let errored = false;
  const voiceMode = room.deliveryMode === "voice";
  process.stderr.write(`[voice-debug] room=${roomId} deliveryMode="${room.deliveryMode}" voiceMode=${voiceMode}\n`);
  const voiceChunker = voiceMode ? new SentenceChunker({ maxChars: 120 }) : null;
  // Initial voice profile (captured at turn start). emitVoiceText
  // re-reads the agent's voice config FRESH per sentence so the
  // user can swap the agent's voice mid-turn (via Agent Profile
  // → Voice) and have the next sentence pick it up. Without this
  // fresh re-read, the closure-captured profile from turn-start
  // stayed locked, and a mid-turn voice change either kept using
  // the old voice OR — if the closure had been mutated in place
  // — failed silently in the catch below, leaving the audience
  // wondering why the agent went quiet. The "next sentence" cost
  // of a fresh getAgent() per call is a single SQLite read on a
  // primary-key lookup · trivial.
  const initialVoiceProfile = voiceMode ? voiceProfileForAgent(speaker) : null;
  let voiceSeq = 0;

  /** Resolve the latest voice profile for this turn's agent.
   *  Reads fresh from DB so PATCH /api/agents/:id changes during
   *  the turn propagate to the NEXT emitVoiceText call · the
   *  in-flight HTTP request to the TTS provider can't be cancelled
   *  mid-stream, but the sentence after it picks up the new
   *  config seamlessly. Falls back to the initial profile when
   *  the DB read fails (rare; defensive against transient errors). */
  function currentVoiceProfile(): AgentVoiceProfile | null {
    if (!voiceMode) return null;
    try {
      const fresh = getAgent(speaker.id);
      if (fresh) return voiceProfileForAgent(fresh);
    } catch (e) {
      process.stderr.write(`[tts] currentVoiceProfile read failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    return initialVoiceProfile;
  }

  /**
   * Emit a single sentence as streaming TTS audio chunks.
   * Uses MiniMax streaming API so each sentence is split into multiple
   * small audio fragments that arrive and play with minimal latency.
   */
  async function emitVoiceText(text: string): Promise<void> {
    if (!voiceMode || !text.trim()) return;
    // Strip 【label】 section headers (brainstorm template etc.) so the
    // TTS doesn't read "我看到的价值" / "我会怎么放大" as prefixes on
    // every utterance. The on-screen body keeps them — only the
    // synthesizer input loses them.
    const spoken = stripSpokenLabels(text);
    if (!spoken) return;
    const voiceProfile = currentVoiceProfile();
    if (!voiceProfile) return;
    process.stderr.write(`[tts] emitVoiceText called: provider=${voiceProfile.provider} voiceId=${voiceProfile.voiceId} textLen=${spoken.length} text="${spoken.slice(0, 50)}"\n`);

    // Per-attempt timeout · MiniMax / ElevenLabs occasionally accept
    // the HTTP request then never push the streaming body. Without a
    // timeout the for-await loop hangs forever and the room sits in
    // waitForVoicePlayback for its full grace window (~30s after the
    // client watchdog change). 30s is generous · a healthy first
    // chunk lands in 200-800ms; even a 5s response is unusual.
    //
    // Retry policy · only re-attempt when zero chunks reached the
    // client on the first try (pure timeout / network blip). If we
    // had partial success and then a mid-stream error, the client
    // already started playing audio · re-emitting the same sentence
    // from scratch would concatenate fresh audio onto the half-played
    // clip → duplicated / garbled speech. Accept the partial loss.
    const MAX_ATTEMPTS = 2;
    const TIMEOUT_MS = 30_000;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal.aborted) return;
      // Combine the outer room abort with a per-attempt timeout into
      // a single AbortController · synthesizeSpeechStream cancels on
      // EITHER signal.
      const timeoutCtrl = new AbortController();
      const timer = setTimeout(() => timeoutCtrl.abort(), TIMEOUT_MS);
      const onOuterAbort = (): void => timeoutCtrl.abort();
      signal.addEventListener("abort", onOuterAbort);

      let chunkCount = 0;
      let failure: Error | null = null;
      try {
        for await (const chunk of synthesizeSpeechStream(spoken, voiceProfile, timeoutCtrl.signal)) {
          if (signal.aborted) break;
          chunkCount++;
          roomBus.emit(roomId, {
            type: "voice-chunk",
            messageId: placeholder.id,
            seq: voiceSeq++,
            text: chunk.text,
            provider: chunk.provider,
            model: chunk.model,
            voiceId: chunk.voiceId,
            ...(chunk.mimeType ? { mimeType: chunk.mimeType } : {}),
            ...(chunk.audioBase64 ? { audioBase64: chunk.audioBase64 } : {}),
          });
        }
      } catch (e) {
        failure = e instanceof Error ? e : new Error(String(e));
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onOuterAbort);
      }

      if (signal.aborted) {
        process.stderr.write(`[tts] outer abort during attempt ${attempt}, giving up\n`);
        return;
      }
      if (!failure) {
        process.stderr.write(`[tts] emitVoiceText done (attempt ${attempt}/${MAX_ATTEMPTS}): ${chunkCount} chunks emitted\n`);
        return;
      }
      // Billing failure · don't waste retries on it (the user has to
      // top up first). Forward to the frontend so the upgrade overlay
      // surfaces and skip the remaining attempts.
      const billing = tryExtractTtsBillingError(failure);
      if (billing) {
        roomBus.emit(roomId, {
          type: "voice-error",
          messageId: placeholder.id,
          code: billing.code,
          provider: billing.provider,
          message: billing.message,
          upgradeUrl: billing.upgradeUrl,
        });
        process.stderr.write(
          `[tts] BILLING-ERROR room=${roomId} agent=${speaker.name} provider=${voiceProfile.provider} · ${billing.message}\n`,
        );
        return;
      }
      const willRetry = attempt < MAX_ATTEMPTS && chunkCount === 0;
      process.stderr.write(
        `[tts] ERROR attempt=${attempt}/${MAX_ATTEMPTS} room=${roomId} agent=${speaker.name} provider=${voiceProfile.provider} voiceId=${voiceProfile.voiceId} chunks=${chunkCount} · ${failure.stack || failure.message}` +
        (willRetry ? " · retrying\n" : " · giving up\n"),
      );
      if (!willRetry) return;
      // Small backoff before re-attempt · gives a transient upstream
      // failure (rate-limit, DNS hiccup) a moment to clear.
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // Per-turn timeout layer · composes the outer room signal with two
  // per-turn watchdogs so a hanging LLM doesn't leave the director
  // bubble in "Thinking…" forever:
  //   · firstTokenTimer  — 60s · if no text token has arrived, abort.
  //     Catches "stream opened but provider returns nothing."
  //   · hardCapTimer     — 120s · absolute ceiling on the entire LLM
  //     stream. Catches "first token arrives, then long mid-stream
  //     hang." 120s already covers the slowest legitimate turn we've
  //     observed (deep-reasoning models on long contexts).
  // Both timers abort `turnCtrl`, which is what we pass into
  // callLLMStream. emitVoiceText keeps the outer `signal` so TTS for
  // already-flushed sentences honours room pause/adjourn cleanly.
  const turnCtrl = new AbortController();
  const onRoomAbort = (): void => turnCtrl.abort();
  if (signal.aborted) turnCtrl.abort();
  else signal.addEventListener("abort", onRoomAbort);
  let hardCapTimedOut = false;
  let firstTokenTimedOut = false;
  const hardCapTimer = setTimeout(() => {
    if (!turnCtrl.signal.aborted) { hardCapTimedOut = true; turnCtrl.abort(); }
  }, 120_000);
  let firstTokenTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    if (buf.length === 0 && !turnCtrl.signal.aborted) {
      firstTokenTimedOut = true; turnCtrl.abort();
    }
  }, 60_000);

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
    signal: turnCtrl.signal,
  })) {
    if (signal.aborted) break;

    if (chunk.type === "text") {
      // First text token arrived · disarm the first-token watchdog
      // so a long mid-stream pause doesn't get killed by a stale
      // "nothing produced yet" check.
      if (firstTokenTimer) { clearTimeout(firstTokenTimer); firstTokenTimer = null; }
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
      if (voiceChunker) {
        for (const spoken of voiceChunker.push(chunk.delta)) {
          await emitVoiceText(spoken);
        }
      }
    } else if (chunk.type === "usage") {
      // Bump the per-agent cumulative token counter (surfaced on the
      // agent profile under "Track Record · Tokens"). Charged in full
      // even on error / partial responses — those still cost upstream.
      incrementAgentTokens(speaker.id, chunk.totalTokens);
      // Persist usage on the message's own meta so per-room aggregations
      // (session-analytics card after adjourn) can sum across messages
      // without needing a per-room ledger. Mutating placeholderMeta is
      // safe because the streaming loop spreads it into every subsequent
      // updateMessageBody call · the final write at the end of the
      // function carries this through.
      placeholderMeta.tokens = {
        prompt: chunk.promptTokens,
        completion: chunk.completionTokens,
        total: chunk.totalTokens,
      };
      placeholderMeta.modelV = speaker.modelV;
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
        return placeholder.id;
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
    let msg = e instanceof Error ? e.message : String(e);
    // Distinguish our per-turn watchdog timeouts from generic network
    // errors so the auto-skipped toast tells the right story. Each
    // watchdog also emits via emitAutoSkipped so the client toast
    // can be tagged to this messageId.
    if (firstTokenTimedOut) {
      msg = `LLM did not produce any token within 60s · auto-skipped`;
      emitAutoSkipped(roomId, "llm", "llm-first-token-timeout", placeholder.id);
    } else if (hardCapTimedOut) {
      msg = `LLM stream exceeded 120s hard cap · auto-skipped`;
      emitAutoSkipped(roomId, "llm", "llm-timeout", placeholder.id);
    }
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
    // Voice waiters · release the audio gate so the next speaker
    // queues immediately instead of waiting the 30s waitForVoicePlayback
    // fallback. Same path the client's stalled-bubble Skip uses.
    markVoicePlaybackDone(roomId, placeholder.id);
    // Don't re-throw on our own timeouts · they're a legitimate skip
    // path, not a crash. Re-throw only for true unknown errors so
    // pumpQueue's outer catch still surfaces them.
    if (!firstTokenTimedOut && !hardCapTimedOut) throw e;
  } finally {
    // Always tear down watchdogs + listener · finalizeStreamingMessage
    // is a defensive belt for any path that could leave the message
    // in streaming:true (e.g., a future code change adds a new throw
    // site). Idempotent · no-op when the message has already been
    // finalized by the normal happy path or the catch above.
    clearTimeout(hardCapTimer);
    if (firstTokenTimer) { clearTimeout(firstTokenTimer); firstTokenTimer = null; }
    signal.removeEventListener("abort", onRoomAbort);
    finalizeStreamingMessage(placeholder.id, "turn-cleanup");
  }

  if (signal.aborted) {
    finishReason = finishReason ?? "aborted";
  }

  // If the LLM never produced any text, drop the empty placeholder rather
  // than leaving a blank bubble in the chat. Common reasons: aborted before
  // first token, provider returned no content, context-window refusal.
  // Errored turns are KEPT (with the `[error: …]` body) so the user can
  // see what went wrong rather than getting a silent disappearance.
  //
  // Meta-silence guard · after ~14 rounds the model often "abstains" by
  // emitting a short narration of its silence — `（沉默）` / `I have
  // nothing to add` / `pass this round` / etc. — instead of returning
  // empty. Those bubbles read as bugs ("the director gave up") and
  // pollute the transcript. Detect short responses that look like
  // pure abstention text and treat them as empty: drop the placeholder,
  // pump the queue forward. The director's NEXT turn (later round) gets
  // a fresh chance once new material lands.
  const trimmed = buf.trim();
  const hasContent = trimmed.length > 0 && !looksLikeMetaSilence(trimmed);
  if (!hasContent && !errored) {
    deleteMessage(placeholder.id);
    roomBus.emit(roomId, {
      type: "message-removed",
      messageId: placeholder.id,
      reason: finishReason || (trimmed.length > 0 ? "meta-silence" : "empty"),
    });
    // Round-open retraction · if the user hard-paused this director
    // before any content streamed AND nobody else has spoken in this
    // round, the "Round N · directors speak in parallel" chip the
    // chair posted has nothing to mark. Pull it out so the chat
    // doesn't show an empty round header above the pause bar.
    if (signal.aborted || finishReason === "aborted") {
      retractEmptyRoundOpen(roomId, roundNum, placeholder.id);
    }
    return null;
  }

  if (!errored) {
    if (voiceChunker) {
      const tail = voiceChunker.flush();
      process.stderr.write(`[tts] flush tail="${(tail || "").slice(0, 50)}" tailLen=${(tail || "").length} totalSeq=${voiceSeq}\n`);
      if (tail) await emitVoiceText(tail);
      roomBus.emit(roomId, { type: "voice-final", messageId: placeholder.id });
    }
    // TTS produced zero audio chunks · short-circuit the pump's
    // `waitForVoicePlayback(messageId)` so it doesn't sit on the 60s
    // no-heartbeat fallback. Without this, a provider-side TTS outage
    // (auth drop, region block, empty stream) leaves the room visibly
    // frozen for a full minute after each silent turn before the next
    // speaker fires · users read that as "the room ended". Pre-marking
    // the messageId as done means the wait resolves immediately.
    if (voiceMode && voiceSeq === 0) {
      process.stderr.write(
        `[tts] zero-chunks for msg=${placeholder.id.slice(0, 8)} agent=${speaker.name} · short-circuiting voice wait\n`,
      );
      markVoicePlaybackDone(roomId, placeholder.id);
    }
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
    // Pre-warm hook · LLM text is done, full body is in DB, can be
    // used as context for the next speaker. pumpQueue uses this to
    // fire B's streamSpeakerTurn in the background while A's TTS
    // chunks keep streaming out to the client. Best-effort.
    if (onMessageFinal) {
      try { onMessageFinal({ messageId: placeholder.id }); }
      catch (e) { process.stderr.write(`[onMessageFinal] ${e instanceof Error ? e.message : String(e)}\n`); }
    }
    // Layer 3.1 · topic tree · fire-and-forget post-turn branch tag.
    // Layer 4   · QD archive · fire-and-forget post-turn cell score.
    // Both run in parallel · independent failures. Skip trivially
    // short turns (chair pings, abort placeholders) since they
    // contribute no signal to either system.
    if (buf.trim().length >= 40) {
      void (async () => {
        try {
          await tagMessageBranch({
            roomId,
            messageId: placeholder.id,
            speakerId: speaker.id,
            body: buf,
            roomSubject: room.subject || "",
          });
        } catch (e) {
          process.stderr.write(
            `[room] topic-tag failed: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      })();
      void (async () => {
        try {
          await scoreAndArchive({
            roomId,
            messageId: placeholder.id,
            body: buf,
          });
        } catch (e) {
          process.stderr.write(
            `[room] qd-score failed: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      })();
    }
  } else {
    // Error turns already persisted final body+meta inside the stream loop.
    // Still emit the same terminal SSE pair as success so clients clear
    // streaming / voice state without relying on a follow-up poll.
    if (voiceChunker) {
      roomBus.emit(roomId, { type: "voice-final", messageId: placeholder.id });
    }
    // Errored turn · pump must not sit on the 60s voice-wait. If any
    // chunks did land, the client will fire its own /voice-done after
    // playback ends; this pre-done covers the chunks=0 case (the
    // common one — error happens before the first TTS chunk).
    if (voiceMode && voiceSeq === 0) {
      markVoicePlaybackDone(roomId, placeholder.id);
    }
    roomBus.emit(roomId, {
      type: "message-final",
      messageId: placeholder.id,
      finishReason: "error",
    });
  }
  return placeholder.id;
}

/** Retract the chair's `round-open` marker for `roundNum` when nobody
 *  actually spoke in that round — typical after a hard pause that
 *  cuts the first director before any token streamed. The marker is
 *  a structural chip ("Round 4 · directors speak in parallel"); when
 *  no director speech follows it, the chip is misleading chat noise.
 *
 *  `excludeMessageId` is the just-deleted streaming placeholder — its
 *  DB row is already gone, but `listRecentMessages` may still return
 *  a stale snapshot in tests. Skip it when scanning for "real" turns.
 *
 *  Defensive · runs after `deleteMessage(placeholder.id)` AND only
 *  when the abort signal fired, so a normal "speaker produced no
 *  text" provider quirk doesn't accidentally retract the marker mid-
 *  round when later directors will still speak.  */
function retractEmptyRoundOpen(
  roomId: string,
  roundNum: number,
  excludeMessageId: string,
): void {
  // Pull a window large enough to cover a multi-round room without
  // missing the marker · the marker sits N speakers up at most.
  const recent = listRecentMessages(roomId, 32);
  const marker = recent.find(
    (m) =>
      m.authorKind === "agent" &&
      m.roundNum === roundNum &&
      (m.meta as { kind?: unknown } | null | undefined)?.kind === "round-open",
  );
  if (!marker) return;
  // Any director speech in this round (with body, not a structural
  // chair chip) keeps the marker — it's still load-bearing.
  const hasRealTurn = recent.some((m) => {
    if (m.id === excludeMessageId) return false;
    if (m.id === marker.id) return false;
    if (m.authorKind !== "agent") return false;
    if (m.roundNum !== roundNum) return false;
    const kind = (m.meta as { kind?: unknown } | null | undefined)?.kind;
    if (kind) return false; // round-open / round-prompt / settings / billing-notice etc.
    return !!(m.body && m.body.trim().length > 0);
  });
  if (hasRealTurn) return;
  deleteMessage(marker.id);
  roomBus.emit(roomId, {
    type: "message-removed",
    messageId: marker.id,
    reason: "empty-round",
  });
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
 *  the frontend can render them differently.
 *
 *  `historicalMembers` is the full director roster including any
 *  who have been soft-deleted via `removeRoomMember`. Each entry
 *  carries `removedAt` (null when active). The frontend uses this
 *  list — not `members` — for speaker-name + voice-profile
 *  resolution on past messages, so a director who's been excused
 *  mid-discussion still shows their name in the chat history and
 *  their voice still plays in voice replay. */
export type HistoricalMember = Agent & { joinedAt: number; removedAt: number | null };

export function getRoomFullState(roomId: string): {
  room: Room;
  members: Agent[];
  historicalMembers: HistoricalMember[];
  chair: Agent | null;
  messages: Message[];
  keyPoints: ReturnType<typeof listKeyPointsForRoom>;
} | null {
  const room = getRoom(roomId);
  if (!room) return null;
  const allRows = listAllRoomMembers(roomId);
  const activeAgents = allRows
    .filter((m) => m.removedAt === null)
    .map((m) => getAgent(m.agentId))
    .filter((a): a is Agent => a !== null);
  const members = activeAgents.filter((a) => a.roleKind === "director");
  const chair = activeAgents.find((a) => a.roleKind === "moderator") ?? null;

  // Directors only · chair is never excused, so historicalMembers
  // matches the same "directors only" contract `members` has.
  const historicalMembers: HistoricalMember[] = [];
  for (const m of allRows) {
    const a = getAgent(m.agentId);
    if (!a || a.roleKind !== "director") continue;
    historicalMembers.push({ ...a, joinedAt: m.joinedAt, removedAt: m.removedAt });
  }

  const messages = listRecentMessages(roomId, 200);
  const keyPoints = listKeyPointsForRoom(roomId);
  return { room, members, historicalMembers, chair, messages, keyPoints };
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
