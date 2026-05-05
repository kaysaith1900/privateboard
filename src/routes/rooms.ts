/**
 * /api/rooms · room lifecycle + messaging.
 *
 *   POST   /api/rooms                       → create
 *   GET    /api/rooms                       → list
 *   GET    /api/rooms/:id                   → full state (room + members + messages)
 *   GET    /api/rooms/:id/stream            → SSE: room events
 *   POST   /api/rooms/:id/messages          → user sends a message · triggers tick
 *   POST   /api/rooms/:id/abort             → cancel current in-flight LLM call
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { generateBrief } from "../orchestrator/brief.js";
import {
  announceAdjournNoBrief,
  announceMemberChange,
  announceResearchHint,
  announceSettingsChange,
  runChairClarify,
  runChairConvening,
  runChairRoundEnd,
} from "../orchestrator/chair.js";
import { extractMemoriesAfterAdjourn } from "../orchestrator/memory.js";
import {
  abortRoom,
  chairInterrupt,
  getRoomFullState,
  getRoomQueueSnapshot,
  injectSpeakers,
  isRoomSpeaking,
  requestSoftPause,
  resumeRoom,
  setPendingUserAfterCurrent,
  tickRoom,
} from "../orchestrator/room.js";
import { pickDirectors } from "../orchestrator/director-picker.js";
import { roomBus, type RoomEvent } from "../orchestrator/stream.js";
import { getAgent, getChairAgent, listAgents } from "../storage/agents.js";
import { getBriefByRoom, listBriefsForRoom } from "../storage/briefs.js";
import { hasBraveKey } from "../storage/keys.js";
import { insertConfigEvent, listConfigEvents } from "../storage/config-events.js";
import {
  getKeyPoint,
  setKeyPointVote,
  type KeyPointVote,
} from "../storage/key_points.js";
import { getCurrentRound, insertMessage, listMessages, nextUserRoundNum } from "../storage/messages.js";
import {
  addRoomMember,
  createRoom,
  deleteRoom,
  getRoom,
  listRoomMembers,
  listRooms,
  recentDirectorAppearances,
  removeRoomMember,
  setAwaitingClarify,
  setAwaitingContinue,
  setRoomIncognito,
  setRoomStatus,
  updateRoomSettings,
} from "../storage/rooms.js";

/**
 * Auto-pick path · runs the LLM picker over the available director
 * catalog, seats each pick into the room with its own `member-added`
 * config event, posts a `convening` milestone message carrying the
 * picker's rationale, then returns. The caller (POST /api/rooms)
 * triggers chair-clarify after this resolves.
 *
 * Designed to be called fire-and-forget after the room has been
 * created with no director members yet · the SSE listener on the
 * frontend renders a "convening" animation while this runs and
 * fills the cast as `member-added` events arrive.
 */
async function runAutoPickAndSeat(roomId: string, subject: string): Promise<void> {
  // Tell the frontend "auto-pick is running" so it can show the
  // convening animation. Carries the candidate count so the UI can
  // render the empty slots up-front.
  const candidates = listAgents().filter((a) => a.roleKind === "director");
  roomBus.emit(roomId, {
    type: "config-event",
    kind: "auto-pick-started",
    payload: { subject, candidateCount: candidates.length, target: 3 },
    createdAt: Date.now(),
  });

  let result;
  try {
    // Recency bias · the picker downweights directors seated in the
    // last few rooms so consecutive rooms surface a different cast
    // when topical fit is comparable. Window of 5 is conservative —
    // covers ~a session's worth of rooms without prematurely
    // refusing a director who's a uniquely good fit.
    const recentAppearances = recentDirectorAppearances(5);
    result = await pickDirectors({ subject, candidates, recentAppearances });
  } catch (e) {
    // Picker should already swallow its own errors and fall back,
    // but this guard catches any truly catastrophic case.
    process.stderr.write(`[auto-pick] failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return;
  }

  // Seat each picked director with its own event so the UI fills
  // slots one-by-one. Tiny stagger between picks gives the animation
  // visible "directors arriving" beats rather than a single flash.
  const picks = result.picks;
  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i];
    const member = addRoomMember(roomId, pick.agentId);
    if (!member) continue;
    roomBus.emit(roomId, {
      type: "config-event",
      kind: "member-added",
      payload: {
        agentId: pick.agentId,
        position: member.position,
        reason: pick.reason || "",
        autoPicked: true,
        index: i,
        total: picks.length,
      },
      createdAt: Date.now(),
    });
    if (i < picks.length - 1) {
      await new Promise((res) => setTimeout(res, 220));
    }
  }

  // Auto-pick is done · let the frontend dissolve the convening
  // overlay before the chair starts speaking, so the speech bubble
  // doesn't fight the overlay for the user's attention.
  roomBus.emit(roomId, {
    type: "config-event",
    kind: "auto-pick-complete",
    payload: { count: picks.length, fromLlm: result.fromLlm },
    createdAt: Date.now(),
  });

  // Stream a real chair speech introducing the cast · 3-4 sentences
  // explaining what's being decided + why each director was picked
  // + what lens-coverage they create together. Replaces the
  // templated "chair convened: A · B · C" milestone with substance
  // in the chair's own voice.
  const picksWithReasons = picks
    .map((p) => {
      const a = candidates.find((x) => x.id === p.agentId);
      return a ? { agent: a, reason: p.reason } : null;
    })
    .filter((x): x is { agent: typeof candidates[number]; reason: string } => x !== null);

  if (picksWithReasons.length > 0) {
    try {
      await runChairConvening(roomId, picksWithReasons, result.rationale);
    } catch (e) {
      // Convening speech is best-effort · if the LLM call fails the
      // room still proceeds to clarify. The directors are seated
      // either way so the user just doesn't get the "why" intro.
      process.stderr.write(
        `[auto-pick] convening speech failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
}

export function roomsRouter(): Hono {
  const r = new Hono();

  // ── List
  r.get("/", (c) => c.json({ rooms: listRooms() }));

  // ── Create
  r.post("/", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }

    const b = (body ?? {}) as {
      name?: unknown;
      subject?: unknown;
      mode?: unknown;
      intensity?: unknown;
      briefStyle?: unknown;
      agentIds?: unknown;
      autoPick?: unknown;
    };

    const subject = typeof b.subject === "string" ? b.subject.trim() : "";
    if (!subject) return c.json({ error: "subject is required" }, 400);

    // Auto-pick · the chair selects directors in the background after
    // the room opens. The user sees a "convening" animation in the
    // room view while the picker runs (haiku, ~1s), then directors
    // get added one by one with a rationale from the picker.
    const autoPick = b.autoPick === true;

    const agentIds: string[] = Array.isArray(b.agentIds)
      ? (b.agentIds as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    if (!autoPick && agentIds.length === 0) {
      return c.json({ error: "at least one agent must be invited" }, 400);
    }

    // Validate agents exist (only when manually picked).
    for (const id of agentIds) {
      if (!getAgent(id)) return c.json({ error: `unknown agent: ${id}` }, 400);
    }

    const name = typeof b.name === "string" && b.name.trim()
      ? b.name.trim().slice(0, 80)
      : subject.slice(0, 60);

    // Tone (mode), intensity, and brief style — accepted from the convene
    // overlay and stored on the room. Out-of-range values fall back to the
    // sane defaults so legacy clients still work.
    // `no-mercy` retired · existing rooms with that mode keep loading
    // (the prompt builder maps no-mercy → debate at runtime), but new
    // rooms can only choose from this set. Replaced by `critique`
    // (systematic flaw audit on a deliverable) which captures the
    // value of high-pushback without the hostile-tone framing.
    const ALLOWED_MODES = new Set(["brainstorm", "constructive", "research", "debate", "critique"]);
    const ALLOWED_INTENSITY = new Set(["calm", "sharp", "brutal"]);
    const ALLOWED_STYLES = new Set(["auto", "mckinsey", "gartner", "a16z", "anthropic", "8bit"]);
    // Map legacy short codes to canonical style names.
    const STYLE_ALIAS: Record<string, string> = { mck: "mckinsey" };

    const rawMode = typeof b.mode === "string" ? b.mode.trim() : "";
    const mode = ALLOWED_MODES.has(rawMode) ? rawMode : "constructive";

    const rawIntensity = typeof b.intensity === "string" ? b.intensity.trim() : "";
    const intensity = ALLOWED_INTENSITY.has(rawIntensity) ? rawIntensity : "sharp";

    const rawStyle = typeof b.briefStyle === "string" ? b.briefStyle.trim() : "";
    const styleResolved = STYLE_ALIAS[rawStyle] ?? rawStyle;
    const briefStyle = ALLOWED_STYLES.has(styleResolved) ? styleResolved : "auto";

    const { room, members } = createRoom({ name, subject, mode, intensity, briefStyle, agentIds });

    // Seed the room-opened lifecycle event. For auto-pick rooms the
    // member list will fill in via subsequent `member-added` events
    // once the picker resolves.
    insertConfigEvent({
      roomId: room.id,
      kind: "room-opened",
      payload: { mode, intensity, briefStyle, members: members.map((m) => m.agentId), autoPick },
      actorKind: "user",
    });

    // The convene subject IS the user's opening question — insert it as the
    // first user message. The chair fires a clarification turn FIRST; if
    // the subject is concrete enough the chair returns SKIP and we tick
    // directors immediately. Otherwise the chair asks one question and
    // the directors wait for the user's reply.
    const opening = insertMessage({
      roomId: room.id,
      authorKind: "user",
      body: subject,
      roundNum: 1,
    });
    roomBus.emit(room.id, {
      type: "message-appended",
      messageId: opening.id,
      authorKind: "user",
      authorId: null,
      replyToId: null,
      body: opening.body,
      meta: opening.meta,
      roundNum: opening.roundNum,
      createdAt: opening.createdAt,
    });
    roomBus.emit(room.id, { type: "message-final", messageId: opening.id });

    // Mark the room as in clarification phase synchronously, before the
    // POST response goes back. The frontend's openRoom fetch will then
    // see awaiting_clarify=true and the queue strip can render its
    // pending preview from the very first paint — without waiting for
    // the chair to start streaming.
    setAwaitingClarify(room.id, true);

    // Research-mode hint · the room defaults web search ON, but it
    // can only actually run when a Brave Search API key is configured.
    // Post a one-time chair notice up front so the user knows what's
    // missing without blocking the room. Inferred language matches the
    // subject to keep the chair's voice consistent.
    if (mode === "research" && !hasBraveKey()) {
      const langGuess: "zh" | "en" = /[一-鿿]/.test(subject) ? "zh" : "en";
      announceResearchHint(room.id, langGuess);
    }

    // Fire-and-forget — chair clarification streams in the background, then
    // either ticks directors (on READY) or waits for the user's reply.
    // Subsequent user replies route back through the chair (see POST
    // /:id/messages) until the chair signals READY or exhausts the cap.
    //
    // Auto-pick path: before clarify runs, the chair picks the cast
    // (haiku call, ~1s), seats each director with a per-pick SSE
    // event, posts a "convening" milestone message, then proceeds to
    // clarify normally.
    void (async () => {
      try {
        if (autoPick) {
          await runAutoPickAndSeat(room.id, subject);
        }
        const result = await runChairClarify(room.id);
        if (result.ready) tickRoom(room.id, { roundNum: 1 });
      } catch (e) {
        process.stderr.write(`[rooms] convene flow failed: ${e instanceof Error ? e.message : String(e)}\n`);
        // Fallback: still kick the directors so the room isn't stranded.
        setAwaitingClarify(room.id, false);
        tickRoom(room.id, { roundNum: 1 });
      }
    })();

    return c.json({ room, members });
  });

  // ── State (snapshot)
  r.get("/:id", (c) => {
    const id = c.req.param("id");
    const state = getRoomFullState(id);
    if (!state) return c.json({ error: "not found" }, 404);
    const events = listConfigEvents(id);
    const snap = getRoomQueueSnapshot(id);
    return c.json({ ...state, events, queue: snap.queue, round: snap.round });
  });

  // ── Markdown export · single-file bundle for backup / paste / share.
  //   Contains: room header (subject, mode, intensity, timestamps,
  //   directors), full chronological transcript with round dividers
  //   and per-message timestamps, every filed brief verbatim. Browser
  //   downloads via Content-Disposition. Filename pattern:
  //   `boardroom-NNN-YYYY-MM-DD.md`.
  r.get("/:id/export.md", (c) => {
    const id = c.req.param("id");
    const room = getRoom(id);
    if (!room) return c.text("not found", 404);

    const memberRows = listRoomMembers(id);
    const members = memberRows
      .map((m) => getAgent(m.agentId))
      .filter((a): a is NonNullable<typeof a> => a !== null);
    const messages = listMessages(id);
    const briefs = listBriefsForRoom(id).slice().sort((a, b) => a.createdAt - b.createdAt);

    const md = buildRoomExportMarkdown({ room, members, messages, briefs });
    const filename = roomExportFilename(room);
    return c.body(md, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    });
  });

  // ── SSE event stream
  r.get("/:id/stream", (c) => {
    const id = c.req.param("id");
    if (!getRoom(id)) return c.json({ error: "not found" }, 404);

    // streamSSE sets Content-Type / Cache-Control / Connection automatically
    // and flushes the response on every writeSSE — the prior `stream` helper
    // was buffering until the generator returned, hiding token-by-token output.
    return streamSSE(c, async (s) => {
      // Send a hello so the client knows the channel is live.
      await s.writeSSE({ event: "hello", data: JSON.stringify({ roomId: id, ts: Date.now() }) });

      const queue: RoomEvent[] = [];
      let resolveWaiter: (() => void) | null = null;
      let closed = false;

      const off = roomBus.subscribe(id, (event: RoomEvent) => {
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

      // Pump events from the bus to the client one at a time, awaiting each
      // write so back-pressure is honored.
      while (!closed) {
        if (queue.length === 0) {
          // Wait for the next event (or abort).
          await new Promise<void>((resolve) => { resolveWaiter = resolve; });
          continue;
        }
        const event = queue.shift()!;
        await s.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }
    });
  });

  // ── User sends a message → triggers orchestrator tick
  r.post("/:id/messages", async (c) => {
    const id = c.req.param("id");
    const room = getRoom(id);
    if (!room) return c.json({ error: "not found" }, 404);
    if (room.status !== "live") return c.json({ error: "room is not live" }, 409);

    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }

    const b = (body ?? {}) as { body?: unknown; replyToId?: unknown; mentions?: unknown; mode?: unknown };
    const text = typeof b.body === "string" ? b.body.trim() : "";
    if (!text) return c.json({ error: "body is required" }, 400);

    const replyToId = typeof b.replyToId === "string" ? b.replyToId : null;
    const mentions: string[] = Array.isArray(b.mentions)
      ? (b.mentions as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const mode = b.mode === "after-speaker" ? "after-speaker" : "now";

    // ── after-speaker mode · user opted to wait for the current
    //   director to finish. If a director is in flight, hand the
    //   payload to the orchestrator (which drains it between turns
    //   so the user message lands in the correct slot). If no one
    //   is in flight, fall through to the normal "now" path.
    if (mode === "after-speaker" && isRoomSpeaking(id)) {
      setPendingUserAfterCurrent(id, { text, mentions, replyToId });
      return c.json({ deferred: true });
    }

    // Each user message opens a new round; directors that respond share it.
    const roundNum = nextUserRoundNum(id);

    const msg = insertMessage({
      roomId: id,
      authorKind: "user",
      body: text,
      replyToId,
      meta: mentions.length ? { mentions } : {},
      roundNum,
    });
    roomBus.emit(id, {
      type: "message-appended",
      messageId: msg.id,
      authorKind: "user",
      authorId: null,
      replyToId: msg.replyToId,
      body: msg.body,
      meta: msg.meta,
      roundNum: msg.roundNum,
      createdAt: msg.createdAt,
    });
    roomBus.emit(id, { type: "message-final", messageId: msg.id });

    // A user reply implicitly resumes the room from any soft-pause the
    // chair set after a round-end. Drop the flag so tickRoom can dispatch,
    // and emit round-resumed so the round-end card flips its CTAs.
    if (room.awaitingContinue) {
      setAwaitingContinue(id, false);
      roomBus.emit(id, {
        type: "config-event",
        kind: "round-resumed",
        payload: {},
        createdAt: Date.now(),
      });
    }

    // If the chair is still in clarification phase, route the reply
    // back through the chair instead of the director queue. The chair
    // either asks one more question (room stays in awaiting_clarify)
    // or signals READY, at which point we release the directors.
    if (room.awaitingClarify) {
      void (async () => {
        try {
          const result = await runChairClarify(id);
          if (result.ready) tickRoom(id, { roundNum, forceSpeakerId: mentions[0] ?? null });
        } catch (e) {
          process.stderr.write(`[rooms] chair clarify failed: ${e instanceof Error ? e.message : String(e)}\n`);
          tickRoom(id, { roundNum, forceSpeakerId: mentions[0] ?? null });
        }
      })();
      return c.json(msg);
    }

    // @chair detection · the user can summon the chair to respond
    // directly, interrupting the director queue. Detected two ways:
    //   1. mentions[] contains the chair's agent id (future-proof for
    //      when the frontend grows a real @mention picker).
    //   2. The literal `@chair` keyword appears in the message body
    //      (works today without frontend changes — typing @chair just
    //      works). Case-insensitive, must be at start or after space
    //      so handles like @charles don't false-fire.
    // Forks to chairInterrupt: aborts any in-flight director, runs the
    // chair's direct response, then restores the queue. Skipped
    // entirely during awaitingClarify (handled above — user is already
    // mid-conversation with the chair).
    const chair = getChairAgent();
    const chairMentioned =
      !!chair &&
      (mentions.includes(chair.id) || /(?:^|\s)@chair\b/i.test(text));
    if (chairMentioned) {
      // Fire-and-forget · the chair's stream lands via SSE. We return
      // the user message immediately so the frontend's send-blocking
      // state lifts.
      void chairInterrupt(id).catch((e) => {
        process.stderr.write(
          `[rooms] chair-interrupt failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      });
      return c.json(msg);
    }

    // First mention takes priority for who should respond; otherwise the
    // entire room speaks once in join-order.
    tickRoom(id, { roundNum, forceSpeakerId: mentions[0] ?? null });

    return c.json(msg);
  });

  // ── Abort the current in-flight director turn
  r.post("/:id/abort", (c) => {
    const id = c.req.param("id");
    if (!getRoom(id)) return c.json({ error: "not found" }, 404);
    abortRoom(id);
    return c.json({ ok: true });
  });

  // ── Pause the room — body { mode: "hard" | "soft" }.
  //   hard: abort current director immediately + flip status.
  //   soft: wait for current speaker to finish, then orchestrator flips status.
  //         If no speaker is in flight, behaves like hard.
  r.post("/:id/pause", async (c) => {
    const id = c.req.param("id");
    const room = getRoom(id);
    if (!room) return c.json({ error: "not found" }, 404);
    if (room.status !== "live") return c.json({ error: "room is not live" }, 409);

    let body: unknown = {};
    try { body = await c.req.json(); } catch { /* body optional */ }
    const mode = (body as { mode?: unknown })?.mode === "soft" ? "soft" : "hard";

    if (mode === "soft" && isRoomSpeaking(id)) {
      // Honored when the speaker's stream finishes; orchestrator emits
      // the room-paused event itself.
      requestSoftPause(id);
      return c.json({ room: getRoom(id), mode: "soft", pending: true });
    }

    // Hard path (or soft with no speaker → also immediate)
    abortRoom(id);
    const pausedAt = Date.now();
    setRoomStatus(id, "paused", { pausedAt });

    insertConfigEvent({
      roomId: id,
      kind: "room-paused",
      payload: { pausedAt, mode: "hard" },
      actorKind: "user",
    });
    roomBus.emit(id, {
      type: "config-event",
      kind: "room-paused",
      payload: { pausedAt, mode: "hard" },
      createdAt: pausedAt,
    });

    return c.json({ room: getRoom(id), mode: "hard" });
  });

  // ── Resume the room — flip back to live and pick up the speaker
  //   queue exactly where it was paused (the orchestrator stashed a
  //   snapshot in abortRoom / soft-pause). If there's no snapshot
  //   (e.g. the room was paused with an empty queue), the next user
  //   message will replan via tickRoom as before.
  r.post("/:id/resume", (c) => {
    const id = c.req.param("id");
    const room = getRoom(id);
    if (!room) return c.json({ error: "not found" }, 404);
    if (room.status !== "paused") return c.json({ error: "room is not paused" }, 409);

    setRoomStatus(id, "live", { pausedAt: null });

    const ts = Date.now();
    insertConfigEvent({
      roomId: id,
      kind: "room-resumed",
      payload: { resumedAt: ts },
      actorKind: "user",
    });
    roomBus.emit(id, {
      type: "config-event",
      kind: "room-resumed",
      payload: { resumedAt: ts },
      createdAt: ts,
    });

    // Restore the saved queue + re-engage the speaker pump.
    resumeRoom(id);

    return c.json({ room: getRoom(id) });
  });

  // ── User adds a supplemental message while the room is paused.
  //   The message lands in the chat immediately (so the user sees
  //   their input took); the saved director queue is left untouched
  //   so resumeRoom plays out exactly as it was — but the directors
  //   read the new user message in the transcript and respond to it
  //   first when they next speak. No tickRoom, no auto-resume.
  //   Round number is preserved (current round) so the supplement
  //   sits inside the round that was running when pause hit, instead
  //   of opening a fresh round divider in the chat.
  r.post("/:id/paused-input", async (c) => {
    const id = c.req.param("id");
    const room = getRoom(id);
    if (!room) return c.json({ error: "not found" }, 404);
    if (room.status !== "paused") return c.json({ error: "room is not paused" }, 409);

    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }
    const b = (body ?? {}) as { body?: unknown };
    const text = typeof b.body === "string" ? b.body.trim() : "";
    if (!text) return c.json({ error: "body is required" }, 400);

    const roundNum = Math.max(1, getCurrentRound(id));
    const msg = insertMessage({
      roomId: id,
      authorKind: "user",
      body: text,
      meta: {},
      roundNum,
    });
    roomBus.emit(id, {
      type: "message-appended",
      messageId: msg.id,
      authorKind: "user",
      authorId: null,
      replyToId: null,
      body: msg.body,
      meta: msg.meta,
      roundNum: msg.roundNum,
      createdAt: msg.createdAt,
    });
    roomBus.emit(id, { type: "message-final", messageId: msg.id });

    return c.json(msg);
  });

  // ── Update room settings (tone / intensity / report style)
  r.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const room = getRoom(id);
    if (!room) return c.json({ error: "not found" }, 404);
    if (room.status === "adjourned") return c.json({ error: "room is adjourned" }, 409);

    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }

    const b = (body ?? {}) as { mode?: unknown; intensity?: unknown; briefStyle?: unknown; incognito?: unknown };

    // `no-mercy` retired · existing rooms with that mode keep loading
    // (the prompt builder maps no-mercy → debate at runtime), but new
    // rooms can only choose from this set. Replaced by `critique`
    // (systematic flaw audit on a deliverable) which captures the
    // value of high-pushback without the hostile-tone framing.
    const ALLOWED_MODES = new Set(["brainstorm", "constructive", "research", "debate", "critique"]);
    const ALLOWED_INTENSITY = new Set(["calm", "sharp", "brutal"]);
    const ALLOWED_STYLES = new Set(["auto", "mckinsey", "gartner", "a16z", "anthropic", "8bit"]);
    const STYLE_ALIAS: Record<string, string> = { mck: "mckinsey" };

    const patch: { mode?: string; intensity?: string; briefStyle?: string } = {};
    let incognitoNext: boolean | null = null;

    if (typeof b.mode === "string") {
      const m = b.mode.trim();
      if (!ALLOWED_MODES.has(m)) return c.json({ error: `invalid mode: ${m}` }, 400);
      patch.mode = m;
    }
    if (typeof b.intensity === "string") {
      const i = b.intensity.trim();
      if (!ALLOWED_INTENSITY.has(i)) return c.json({ error: `invalid intensity: ${i}` }, 400);
      patch.intensity = i;
    }
    if (typeof b.briefStyle === "string") {
      const raw = b.briefStyle.trim();
      const resolved = STYLE_ALIAS[raw] ?? raw;
      if (!ALLOWED_STYLES.has(resolved)) return c.json({ error: `invalid briefStyle: ${raw}` }, 400);
      patch.briefStyle = resolved;
    }
    if (typeof b.incognito === "boolean") {
      incognitoNext = b.incognito;
    }

    if (Object.keys(patch).length === 0 && incognitoNext === null) {
      return c.json({ room });
    }

    const updated = Object.keys(patch).length > 0 ? updateRoomSettings(id, patch) : room;
    if (!updated) return c.json({ error: "update failed" }, 500);
    if (incognitoNext !== null && incognitoNext !== room.incognito) {
      setRoomIncognito(id, incognitoNext);
    }

    // Log + broadcast a config-change event so the chat marker + sidebar
    // can react in-place without a refetch.
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (patch.mode !== undefined && patch.mode !== room.mode) {
      changes.mode = { from: room.mode, to: patch.mode };
    }
    if (patch.intensity !== undefined && patch.intensity !== room.intensity) {
      changes.intensity = { from: room.intensity, to: patch.intensity };
    }
    if (patch.briefStyle !== undefined && patch.briefStyle !== room.briefStyle) {
      changes.briefStyle = { from: room.briefStyle, to: patch.briefStyle };
    }
    if (Object.keys(changes).length > 0) {
      const ts = Date.now();
      insertConfigEvent({
        roomId: id,
        kind: "settings-changed",
        payload: { changes },
        actorKind: "user",
      });
      roomBus.emit(id, {
        type: "config-event",
        kind: "settings-changed",
        payload: { changes },
        createdAt: ts,
      });
      // Chair announces the change in chat (template-driven, no LLM
      // call) so the timeline reflects the shift inline.
      announceSettingsChange(id, changes);
    }

    // Re-fetch when incognito changed so the response reflects the
    // updated flag (updateRoomSettings doesn't touch incognito).
    const final = incognitoNext !== null ? getRoom(id) : updated;
    return c.json({ room: final });
  });

  // ── Reconcile room members in one shot. Body: { agentIds: string[] }
  //    (the full desired director set, ordered). Server diffs against the
  //    current members and applies adds/removes atomically. Side effects:
  //    chair posts a join/leave announcement; new directors get appended
  //    to the live speaker queue so they speak in this round.
  r.patch("/:id/members", async (c) => {
    const id = c.req.param("id");
    const room = getRoom(id);
    if (!room) return c.json({ error: "not found" }, 404);
    if (room.status === "adjourned") return c.json({ error: "room is adjourned" }, 409);

    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON body" }, 400); }
    const b = (body ?? {}) as { agentIds?: unknown };
    if (!Array.isArray(b.agentIds) || !b.agentIds.every((x) => typeof x === "string")) {
      return c.json({ error: "agentIds must be an array of agent ids" }, 400);
    }
    const desiredIds = (b.agentIds as string[]).filter((x) => x.length > 0);

    // Validate every desired id resolves to a director the agents store
    // knows about. Reject otherwise — adding a phantom id would later
    // wedge the speaker queue.
    for (const aid of desiredIds) {
      const a = getAgent(aid);
      if (!a) return c.json({ error: `unknown agent: ${aid}` }, 400);
      if (a.roleKind !== "director") {
        return c.json({ error: `agent ${aid} is not a director` }, 400);
      }
    }

    // Diff against current room membership (chair excluded — they're at
    // position -1 and not user-managed).
    const currentMembers = listRoomMembers(id);
    const currentIds = new Set(
      currentMembers
        .filter((m) => {
          const a = getAgent(m.agentId);
          return a && a.roleKind === "director";
        })
        .map((m) => m.agentId),
    );
    const desiredSet = new Set(desiredIds);
    const added = desiredIds.filter((aid) => !currentIds.has(aid));
    const removed = [...currentIds].filter((aid) => !desiredSet.has(aid));

    if (added.length === 0 && removed.length === 0) {
      return c.json({ room, members: currentMembers, added: [], removed: [] });
    }

    // Floor: a room must keep at least one director. Refuse a removal
    // that would empty the cast.
    const remainingDirectorCount = currentIds.size - removed.length + added.length;
    if (remainingDirectorCount < 1) {
      return c.json({ error: "a room must have at least one director" }, 400);
    }

    for (const aid of added)   addRoomMember(id, aid);
    for (const aid of removed) removeRoomMember(id, aid);

    const ts = Date.now();
    insertConfigEvent({
      roomId: id,
      kind: "members-changed",
      payload: { added, removed },
      actorKind: "user",
    });
    roomBus.emit(id, {
      type: "config-event",
      kind: "members-changed",
      payload: { added, removed },
      createdAt: ts,
    });

    // Chair posts the welcome / farewell line in chat.
    announceMemberChange(id, added, removed);

    // New directors get appended to the live speaker queue and start
    // talking immediately if the pump can run. Removed ones are left
    // to the orchestrator's per-turn `getAgent` resolve to skip.
    if (added.length > 0) {
      injectSpeakers(id, added);
    }

    return c.json({
      room: getRoom(id),
      members: listRoomMembers(id),
      added,
      removed,
    });
  });

  // ── Trigger the chair to wrap the current round + open a vote.
  //    User-driven (the queue strip exposes a "wrap round" button).
  //    Refuses if the room isn't actively running, if a director is
  //    mid-stream, or if we're already paused / clarifying.
  r.post("/:id/round-end", (c) => {
    const id = c.req.param("id");
    const room = getRoom(id);
    if (!room) return c.json({ error: "not found" }, 404);
    if (room.status !== "live") return c.json({ error: "room is not live" }, 409);
    if (room.awaitingClarify) return c.json({ error: "still in clarification" }, 409);
    if (room.awaitingContinue) return c.json({ error: "already in round-end" }, 409);
    if (isRoomSpeaking(id)) return c.json({ error: "wait for the current speaker to finish" }, 409);

    // Cancel any queued directors so the round wraps cleanly.
    abortRoom(id);

    // Resolve the round number from the latest user message (mirrors
    // what the orchestrator uses).
    const roundNum = Math.max(1, nextUserRoundNum(id) - 1);

    // Fire-and-forget — the chair streams its summary + persists key
    // points + flips awaitingContinue when it's done.
    void runChairRoundEnd(id, roundNum).catch((e) => {
      process.stderr.write(`[rooms] round-end failed: ${e instanceof Error ? e.message : String(e)}\n`);
    });

    return c.json({ ok: true });
  });

  // ── Continue · kick the next round of directors.
  //    Used by:
  //      · the round-end card's Continue button (chair just paused)
  //      · the queue-strip Continue button + 10s auto-continue (room idle)
  //    If the room is currently in a chair-driven round-end pause, this
  //    clears it and emits round-resumed; either way it ticks a new round.
  r.post("/:id/continue", (c) => {
    const id = c.req.param("id");
    const room = getRoom(id);
    if (!room) return c.json({ error: "not found" }, 404);
    if (room.status !== "live") return c.json({ error: "room is not live" }, 409);
    if (room.awaitingClarify) return c.json({ error: "room is in clarification" }, 409);

    if (room.awaitingContinue) {
      setAwaitingContinue(id, false);
      roomBus.emit(id, {
        type: "config-event",
        kind: "round-resumed",
        payload: {},
        createdAt: Date.now(),
      });
    }
    // Each Continue opens a fresh round number — the chair posts a
    // new round-open marker ("Round #2 · reactive…") so the user can
    // see the chronology, and the spent card on the prior round-
    // prompt suppresses cleanly because the next message IS a chair
    // round-open. Without bumping, every Continue would re-use the
    // last user-message's roundNum and the UI would say "round #1"
    // forever. `kind: "continue"` keeps this a reactive sweep so
    // directors see each other's prior turns.
    const roundNum = nextUserRoundNum(id);
    tickRoom(id, { roundNum, kind: "continue" });
    return c.json({ room: getRoom(id) });
  });

  // ── Cast a vote on a chair-generated key point.
  // Body: { vote: "up" | "down" | null }
  r.post("/:id/keypoints/:kpId/vote", async (c) => {
    const id = c.req.param("id");
    const kpId = c.req.param("kpId");
    if (!getRoom(id)) return c.json({ error: "not found" }, 404);
    const kp = getKeyPoint(kpId);
    if (!kp || kp.roomId !== id) return c.json({ error: "key point not found" }, 404);

    let body: unknown = {};
    try { body = await c.req.json(); } catch { /* */ }
    const raw = (body as { vote?: unknown })?.vote;
    let vote: KeyPointVote;
    if (raw === "up") vote = "up";
    else if (raw === "down") vote = "down";
    else if (raw === null || raw === undefined || raw === "") vote = null;
    else return c.json({ error: "vote must be 'up' | 'down' | null" }, 400);

    const updated = setKeyPointVote(kpId, vote);
    if (!updated) return c.json({ error: "vote save failed" }, 500);

    roomBus.emit(id, {
      type: "config-event",
      kind: "key-point-voted",
      payload: { keyPointId: kpId, vote },
      createdAt: Date.now(),
    });
    return c.json({ keyPoint: updated });
  });

  // ── Adjourn the room and kick async brief generation
  r.post("/:id/adjourn", async (c) => {
    const id = c.req.param("id");
    const room = getRoom(id);
    if (!room) return c.json({ error: "not found" }, 404);
    if (room.status === "adjourned") return c.json({ error: "already adjourned" }, 409);

    let body: unknown = {};
    try { body = await c.req.json(); } catch { /* allow empty body */ }
    const b = (body ?? {}) as { style?: unknown; skipBrief?: unknown };
    const skipBrief = b.skipBrief === true;
    // Style precedence: explicit body.style > room.briefStyle > "mckinsey".
    // "auto" means "let the room pick" — for v1 that resolves to mckinsey.
    const explicit = typeof b.style === "string" && b.style ? b.style : null;
    const fromRoom = room.briefStyle && room.briefStyle !== "auto" ? room.briefStyle : null;
    const style = explicit || fromRoom || "mckinsey";

    // Cancel any in-flight director turn before transitioning state.
    abortRoom(id);

    const adjournedAt = Date.now();
    setRoomStatus(id, "adjourned", { adjournedAt });

    insertConfigEvent({
      roomId: id,
      kind: "room-adjourned",
      payload: { style: skipBrief ? null : style, adjournedAt, skipBrief },
      actorKind: "user",
    });
    roomBus.emit(id, {
      type: "config-event",
      kind: "room-adjourned",
      payload: { style: skipBrief ? null : style, adjournedAt, skipBrief },
      createdAt: adjournedAt,
    });

    // Long-term memory extraction · runs in parallel for every agent
    // that participated in the room. Fire-and-forget — extraction is
    // best-effort and shouldn't block the adjourn HTTP response.
    // Internally honours room.incognito so an opted-out room writes
    // nothing. Errors are logged per-agent and swallowed.
    extractMemoriesAfterAdjourn(id).catch((e) => {
      process.stderr.write(
        `[adjourn] memory extraction failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    });

    // skipBrief · user opted to end the room without filing a report.
    // Skip the LLM call entirely; chair posts a closing marker so the
    // transcript ends with a clear "no brief filed" card. The brief
    // endpoint keeps 404'ing (briefs panel handles that as "no brief
    // filed") since no row was created.
    if (skipBrief) {
      announceAdjournNoBrief(id);
      return c.json({
        room: getRoom(id),
        briefId: null,
        status: "skipped",
      });
    }

    let briefId: string | null = null;
    try {
      const result = await generateBrief({ roomId: id, style: style as "mckinsey" });
      briefId = result.briefId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `brief kickoff failed: ${msg}` }, 500);
    }

    return c.json({
      room: getRoom(id),
      briefId,
      status: "generating",
    });
  });

  // ── Read the latest brief for a room (back-compat — single brief).
  r.get("/:id/brief", (c) => {
    const id = c.req.param("id");
    if (!getRoom(id)) return c.json({ error: "not found" }, 404);
    const brief = getBriefByRoom(id);
    if (!brief) return c.json({ error: "brief not yet generated" }, 404);
    return c.json(brief);
  });

  // ── List ALL briefs for a room · newest first.
  // Multiple briefs accumulate when the user clicks "Add a perspective"
  // and regenerates. The frontend uses this to render a tab strip;
  // report.html uses this to navigate between regenerations.
  r.get("/:id/briefs", (c) => {
    const id = c.req.param("id");
    if (!getRoom(id)) return c.json({ error: "not found" }, 404);
    return c.json({ briefs: listBriefsForRoom(id) });
  });

  // ── Generate a new brief for an adjourned room.
  // Used in two flows:
  //   · post-hoc generation when the user adjourned with skipBrief
  //   · "Add a perspective" regeneration (with `supplement`)
  // Always inserts a NEW brief — older ones are preserved as history.
  r.post("/:id/brief", async (c) => {
    const id = c.req.param("id");
    const room = getRoom(id);
    if (!room) return c.json({ error: "not found" }, 404);
    if (room.status !== "adjourned") {
      return c.json({ error: "room is not adjourned" }, 409);
    }
    let body: unknown = {};
    try { body = await c.req.json(); } catch { /* allow empty body */ }
    const b = (body ?? {}) as { style?: unknown; supplement?: unknown };
    const supplement = typeof b.supplement === "string" ? b.supplement.trim() : "";
    const explicit = typeof b.style === "string" && b.style ? b.style : null;
    const fromRoom = room.briefStyle && room.briefStyle !== "auto" ? room.briefStyle : null;
    const style = explicit || fromRoom || "mckinsey";
    try {
      const result = await generateBrief({
        roomId: id,
        style: style as "mckinsey",
        supplement: supplement || undefined,
      });
      return c.json({ briefId: result.briefId, status: "generating" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: `brief kickoff failed: ${msg}` }, 500);
    }
  });

  // ── Permanently delete a room (transcript, members, brief, events all cascade)
  r.delete("/:id", (c) => {
    const id = c.req.param("id");
    if (!getRoom(id)) return c.json({ error: "not found" }, 404);

    // Cancel any in-flight LLM call and clear orchestrator state.
    abortRoom(id);
    // Drop SSE bus listeners — any open EventSource will see the connection
    // close shortly when the client navigates away.
    roomBus.drop(id);

    const ok = deleteRoom(id);
    if (!ok) return c.json({ error: "delete failed" }, 500);
    return c.json({ ok: true });
  });

  return r;
}

/* ─────────────────────── Markdown export helpers ────────────────────────
 *
 *  Self-contained · no LLM calls, no network. Pure formatting of what's
 *  already in the DB into a single markdown bundle the user can paste
 *  into Notion / Obsidian / GitHub / wherever. Producing a single file
 *  (instead of a zip) keeps the UX dead-simple — the browser handles
 *  the download natively from the Content-Disposition header.
 */

function roomExportFilename(room: { number: number; createdAt: number }): string {
  const num = String(room.number).padStart(3, "0");
  const d = new Date(room.createdAt);
  const date = isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
  return `boardroom-${num}-${date}.md`;
}

interface ExportOpts {
  room: ReturnType<typeof getRoom>;
  members: ReturnType<typeof getAgent>[];
  messages: ReturnType<typeof listMessages>;
  briefs: ReturnType<typeof listBriefsForRoom>;
}

function buildRoomExportMarkdown(opts: ExportOpts): string {
  const { room, members, messages, briefs } = opts;
  if (!room) return "";

  const fmtFull = (ts: number | null | undefined): string => {
    if (!ts) return "—";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  };
  const fmtTime = (ts: number): string => {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    return d.toISOString().slice(11, 19) + "Z";
  };

  // Director list for the header — moderator (chair) intentionally
  // excluded so the line reads as "the cast at the table" not the
  // entire roster.
  const directors = members.filter((a): a is NonNullable<typeof a> => !!a && a.roleKind === "director");
  const directorLine =
    directors.length > 0
      ? directors.map((a) => a.name).join(" · ")
      : "(no directors)";

  // Lookup for authorId → display, used by the transcript walker.
  // Includes ALL agents (chair + directors) since chair messages also
  // need name-resolved attribution.
  const nameById = new Map<string, { name: string; handle: string; roleKind: string }>();
  for (const a of members) {
    if (a) nameById.set(a.id, { name: a.name, handle: a.handle, roleKind: a.roleKind });
  }

  // ── Header ──
  const headerLines: string[] = [
    `# Room #${room.number} · ${room.subject}`,
    ``,
    `· **Status** · ${room.status}`,
    `· **Mode** · ${room.mode}`,
    `· **Intensity** · ${room.intensity}`,
    `· **Convened** · ${fmtFull(room.createdAt)}`,
  ];
  if (room.adjournedAt) headerLines.push(`· **Adjourned** · ${fmtFull(room.adjournedAt)}`);
  headerLines.push(`· **Directors** · ${directorLine}`);
  headerLines.push(``, `---`, ``);

  // ── Transcript ──
  const transcriptLines: string[] = [`## Transcript`, ``];
  let lastRound = -1;
  for (const m of messages) {
    if (m.authorKind === "system") continue;
    if (!m.body || !m.body.trim()) continue;

    if (m.roundNum !== lastRound && m.roundNum > 0) {
      transcriptLines.push(`### Round ${m.roundNum}`, ``);
      lastRound = m.roundNum;
    }

    const t = fmtTime(m.createdAt);

    if (m.authorKind === "user") {
      transcriptLines.push(`**You** · ${t}`, ``);
      const quoted = m.body
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      transcriptLines.push(quoted, ``);
      continue;
    }

    // agent
    const meta = m.authorId ? nameById.get(m.authorId) : null;
    const speakerName = meta ? meta.name : "(unknown)";
    const handlePart = meta && meta.handle ? ` · _${meta.handle}_` : "";
    const rolePart = meta && meta.roleKind === "moderator" ? " · Chair" : "";
    transcriptLines.push(`**${speakerName}**${handlePart}${rolePart} · ${t}`, ``);
    transcriptLines.push(m.body.trim(), ``);
  }

  // ── Filed reports ──
  const briefsLines: string[] = [`---`, ``, `## Filed Reports`, ``];
  if (briefs.length === 0) {
    briefsLines.push(`_No reports filed in this room._`, ``);
  } else {
    briefs.forEach((b, i) => {
      const ts = fmtFull(b.createdAt);
      const styleParts: string[] = [];
      if (b.houseStyle && b.houseStyle !== "boardroom-default") styleParts.push(b.houseStyle);
      if (b.spine && b.spine !== "boardroom-dark") styleParts.push(b.spine);
      const stylePart = styleParts.length > 0 ? ` · ${styleParts.join(" / ")}` : "";
      const supplementPart = b.supplement ? ` · supplement: "${b.supplement}"` : "";
      briefsLines.push(`_Brief #${i + 1} · ${ts}${stylePart}${supplementPart}_`, ``);
      briefsLines.push(b.bodyMd.trim(), ``);
      if (i < briefs.length - 1) briefsLines.push(`---`, ``);
    });
  }

  return [...headerLines, ...transcriptLines, ...briefsLines].join("\n") + "\n";
}
