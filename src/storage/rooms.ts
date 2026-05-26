/** Rooms + room_members + lifecycle helpers. */
import { newId } from "../utils/id.js";

import { getChairAgent } from "./agents.js";
import { getDb } from "./db.js";

export type RoomStatus = "live" | "paused" | "adjourned";
export type RoomDeliveryMode = "text" | "voice";
/** Kind of room · "main" is the regular multi-director boardroom
 *  (default for all legacy rows); "thread" is a private 1:1 aside
 *  spawned from a main room. Threads carry `parentRoomId` + a
 *  `threadDirectorId` and skip brief / report inclusion. */
export type RoomKind = "main" | "thread";
/** Vote-trigger preference · controls whether the chair's vote
 *  phase (round-prompt) auto-fires at round wrap or only on a
 *  user click in the bottom bar. */
export type RoomVoteTrigger = "auto" | "manual";

export interface Room {
  id: string;
  number: number;
  name: string;
  subject: string;
  mode: string;       // tone: brainstorm | constructive | research | debate | critique
                      //       (legacy "no-mercy" rooms map to debate at read time)
  intensity: string;  // calm | sharp | terse  (legacy "brutal" maps to terse at read time)
  deliveryMode: RoomDeliveryMode;
  voteTrigger: RoomVoteTrigger;
  status: RoomStatus;
  briefStyle: string | null;  // auto | mckinsey | gartner | a16z | anthropic | 8bit
  /** Soft-pause flag set by the chair after a round-end key-points message. */
  awaitingContinue: boolean;
  /** Soft-pause during the chair's opening clarification phase — user
   *  replies route through the chair until it signals READY. */
  awaitingClarify: boolean;
  createdAt: number;
  pausedAt: number | null;
  adjournedAt: number | null;
  /** Incognito · when true, room adjourn does NOT extract long-term
   *  memory for any agent. Defaults to false; user toggles via Room
   *  Settings. Per-room flag, not global. */
  incognito: boolean;
  /** Follow-up reference · when set, this room was started as a
   *  continuation of `parentRoomId`'s session. Both rooms remain
   *  independent (own messages, own briefs); the link is purely a
   *  navigation reference + a context-injection signal at director-
   *  prompt build time. NULL for standalone rooms. */
  parentRoomId: string | null;
  /** Which specific brief in the parent room the follow-up scopes to
   *  (a parent room can have multiple briefs from regenerations).
   *  NULL when there's no parent OR the parent had no brief. */
  parentBriefId: string | null;
  /** True when `name` was auto-derived (the first 60 chars of
   *  `subject`) and is safe for the round-1 LLM topic-phrase pass to
   *  overwrite. False when the client passed an explicit name at
   *  creation — those are user-authored and must not be clobbered.
   *  The SQL-side guard lives in `setRoomNameFromAuto` (UPDATE ...
   *  WHERE name_auto = 1) so a future rename UI can flip this to 0
   *  without racing the auto pipeline. */
  nameAuto: boolean;
  /** Discriminator · "main" or "thread". Legacy rows default to
   *  "main" via the migration. Threads are single-member private
   *  asides with a parent main room. */
  kind: RoomKind;
  /** For thread rooms · the single director the user is in a private
   *  aside with. NULL on main rooms. Soft reference (no FK) so a
   *  deleted agent leaves the thread readable for transcript / memory
   *  forensics. */
  threadDirectorId: string | null;
}

export interface RoomMember {
  agentId: string;
  position: number;
  joinedAt: number;
  /** When the chair excused this member from the room. NULL = active.
   *  Soft-delete: `removeRoomMember` flips this to a timestamp instead
   *  of DELETE so past messages can still resolve the speaker. */
  removedAt: number | null;
}

interface Row {
  id: string;
  number: number;
  name: string;
  subject: string;
  mode: string;
  intensity: string;
  delivery_mode: string;
  vote_trigger: string;
  status: string;
  brief_style: string | null;
  awaiting_continue: number;
  awaiting_clarify: number;
  created_at: number;
  paused_at: number | null;
  adjourned_at: number | null;
  incognito: number;
  parent_room_id: string | null;
  parent_brief_id: string | null;
  name_auto: number;
  room_kind: string;
  thread_director_id: string | null;
}

interface MemberRow {
  agent_id: string;
  position: number;
  joined_at: number;
  removed_at: number | null;
}

const ROOM_COLS =
  "id, number, name, subject, mode, intensity, delivery_mode, vote_trigger, status, brief_style, awaiting_continue, " +
  "awaiting_clarify, created_at, paused_at, adjourned_at, incognito, " +
  "parent_room_id, parent_brief_id, name_auto, room_kind, thread_director_id";

function mapRow(row: Row): Room {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    subject: row.subject,
    mode: row.mode,
    intensity: row.intensity,
    deliveryMode: row.delivery_mode === "voice" ? "voice" : "text",
    voteTrigger: row.vote_trigger === "manual" ? "manual" : "auto",
    status: row.status as RoomStatus,
    briefStyle: row.brief_style,
    awaitingContinue: row.awaiting_continue === 1,
    awaitingClarify: row.awaiting_clarify === 1,
    createdAt: row.created_at,
    pausedAt: row.paused_at,
    adjournedAt: row.adjourned_at,
    incognito: row.incognito === 1,
    parentRoomId: row.parent_room_id,
    parentBriefId: row.parent_brief_id,
    nameAuto: row.name_auto === 1,
    kind: row.room_kind === "thread" ? "thread" : "main",
    threadDirectorId: row.thread_director_id,
  };
}

function mapMember(row: MemberRow): RoomMember {
  return {
    agentId: row.agent_id,
    position: row.position,
    joinedAt: row.joined_at,
    removedAt: row.removed_at,
  };
}

/** Sidebar / top-level room list · MAIN rooms only.
 *
 *  Thread rooms (room_kind = "thread") are private 1:1 asides spawned
 *  from a parent main room. They live in the same `rooms` table for
 *  storage convenience (reusing messages / SSE / pump plumbing) but
 *  must NEVER surface in the sidebar — every thread spawn would
 *  otherwise look like a brand-new room appearing in the user's list,
 *  with a confusingly inherited subject from its parent.
 *
 *  Callers that explicitly need thread rooms use `listThreadsForRoom`. */
export function listRooms(): Room[] {
  const rows = getDb()
    .prepare(
      `SELECT ${ROOM_COLS} FROM rooms ` +
      `WHERE room_kind = 'main' ` +
      `ORDER BY created_at DESC`,
    )
    .all() as Row[];
  return rows.map(mapRow);
}

export function getRoom(id: string): Room | null {
  const row = getDb()
    .prepare(`SELECT ${ROOM_COLS} FROM rooms WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? mapRow(row) : null;
}

export function listRoomMembers(roomId: string): RoomMember[] {
  const rows = getDb()
    .prepare(
      "SELECT agent_id, position, joined_at, removed_at FROM room_members " +
      "WHERE room_id = ? AND removed_at IS NULL ORDER BY position ASC",
    )
    .all(roomId) as MemberRow[];
  return rows.map(mapMember);
}

/** Every director who was EVER in this room — active + soft-deleted.
 *  Used by the orchestrator's room-state snapshot so the frontend can
 *  resolve speaker names / voice profiles for past messages from
 *  excused directors. Active subset = `listRoomMembers(roomId)`. */
export function listAllRoomMembers(roomId: string): RoomMember[] {
  const rows = getDb()
    .prepare(
      "SELECT agent_id, position, joined_at, removed_at FROM room_members " +
      "WHERE room_id = ? ORDER BY position ASC",
    )
    .all(roomId) as MemberRow[];
  return rows.map(mapMember);
}

/** Direct children of a parent room · the rooms that were started as
 *  follow-ups to `parentRoomId`. Newest-first so the parent room's
 *  UI lists most recent continuations at the top. Used by the
 *  parent-room view's "Follow-up rooms" panel. Does NOT recurse —
 *  grandchildren are reachable by clicking through.
 *
 *  Filters out thread rooms (kind = "thread") — those are private 1:1
 *  asides surfaced separately via `listThreadsForRoom`. Without this
 *  filter, threads would show up as "follow-up rooms" in the parent's
 *  navigation panel, which would expose private conversations to the
 *  room's public navigation. */
export function listFollowUpRooms(parentRoomId: string): Room[] {
  const rows = getDb()
    .prepare(
      `SELECT ${ROOM_COLS} FROM rooms ` +
      `WHERE parent_room_id = ? AND room_kind = 'main' ` +
      `ORDER BY created_at DESC`,
    )
    .all(parentRoomId) as Row[];
  return rows.map(mapRow);
}

/** Private thread rooms spawned from a main room · returns every
 *  active 1:1 aside with `parentRoomId = mainRoomId`. Optional
 *  `directorId` filter narrows to a single director's threads (used
 *  by the per-director memory injection path in
 *  `buildDirectorMessages`). Newest-first.
 *
 *  Threads are independent rooms — they carry their own messages,
 *  status, and lifecycle. This function is the canonical way to
 *  enumerate them; do NOT use `listFollowUpRooms` (which now filters
 *  threads out). */
export function listThreadsForRoom(
  parentRoomId: string,
  opts: { directorId?: string } = {},
): Room[] {
  const params: unknown[] = [parentRoomId];
  let sql =
    `SELECT ${ROOM_COLS} FROM rooms ` +
    `WHERE parent_room_id = ? AND room_kind = 'thread'`;
  if (opts.directorId) {
    sql += ` AND thread_director_id = ?`;
    params.push(opts.directorId);
  }
  sql += ` ORDER BY created_at DESC`;
  const rows = getDb().prepare(sql).all(...params) as Row[];
  return rows.map(mapRow);
}

/** Spawn a private thread room with a single director member. The
 *  thread reuses the regular `rooms` / `messages` plumbing — it
 *  appears as its own row in the rooms table and has its own SSE
 *  stream at `/api/rooms/:threadId/stream`. The parent main room is
 *  unaffected; threads spawn / close independently of parent status.
 *
 *  Field defaults:
 *    · subject inherits parent's subject (the LLM still wants the
 *      topical anchor; we just present this as a private aside)
 *    · mode inherits parent
 *    · deliveryMode forced to "text" (thread MVP doesn't do voice)
 *    · briefStyle null (threads don't generate briefs)
 *    · voteTrigger "manual" (vote isn't meaningful in a 1:1)
 *    · No name_auto · the thread is presented by director name in UI,
 *      not by an auto-generated title
 *
 *  Throws if the parent room doesn't exist OR the director isn't a
 *  current member of the parent (you can only thread someone you're
 *  actually in the room with). */
export function createThread(parentRoomId: string, directorId: string): { room: Room; members: RoomMember[] } {
  const parent = getRoom(parentRoomId);
  if (!parent) throw new Error(`createThread · parent room ${parentRoomId} not found`);
  if (parent.kind !== "main") {
    throw new Error(`createThread · parent room ${parentRoomId} is a ${parent.kind}; threads can only spawn from main rooms`);
  }
  const parentMembers = listRoomMembers(parentRoomId);
  const isMember = parentMembers.some((m) => m.agentId === directorId);
  if (!isMember) {
    throw new Error(`createThread · director ${directorId} is not a member of parent room ${parentRoomId}`);
  }

  const db = getDb();
  const id = newId();
  const number = nextRoomNumber();
  const now = Date.now();
  // Thread name + subject + name_auto coordination · the auto-
  // titling pipeline (`generateRoomTitle`) has two gates we need to
  // satisfy for threads:
  //   (1) `name_auto = 1` so the helper doesn't bail with
  //       reason:"user-named". Threads ARE auto-titled the same
  //       way main rooms are — the LLM distils the first user
  //       message into a sidebar-friendly phrase. We want this.
  //   (2) `name === subject.slice(0, 60)` so the "already-renamed"
  //       guard sees the title is still its initial fallback.
  // Both invariants are re-aligned in routes/rooms.ts the moment
  // the user sends their first thread message (we swap subject to
  // the user's body, sync name to the new truncation, then fire
  // generateRoomTitle). Until then the thread inherits the parent
  // subject's truncation — better than `thread:abc` for any
  // list view that surfaces it.
  const subject = parent.subject;
  const name = subject.slice(0, 60);
  const mode = parent.mode;
  const intensity = parent.intensity;
  // Thread = text-only in MVP (see plan section 6). Even if the
  // parent main room is in voice mode, the thread renders as a
  // floating chat window with keyboard input.
  const deliveryMode = "text";
  const voteTrigger = "manual";

  const insertRoom = db.prepare(
    `INSERT INTO rooms (
       id, number, name, subject, mode, intensity, delivery_mode, vote_trigger,
       brief_style, status, created_at,
       parent_room_id, parent_brief_id, name_auto, room_kind, thread_director_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'live', ?, ?, NULL, 1, 'thread', ?)`,
  );
  const insertMember = db.prepare(
    "INSERT INTO room_members (room_id, agent_id, position, joined_at) VALUES (?, ?, ?, ?)",
  );

  const tx = db.transaction(() => {
    insertRoom.run(id, number, name, subject, mode, intensity, deliveryMode, voteTrigger, now, parentRoomId, directorId);
    // Single member · the director. No chair in threads (they're not
    // moderated; the user-director pair drives the conversation).
    insertMember.run(id, directorId, 0, now);
  });
  tx();

  return {
    room: getRoom(id)!,
    members: listRoomMembers(id),
  };
}

/** How many of the last N rooms each director appeared in. Used by
 *  the director auto-picker for recency-bias — directors seated in
 *  recent rooms get downweighted when topical fit is comparable, so
 *  the user doesn't keep seeing the same trio across consecutive
 *  rooms. The chair (position -1) is excluded from the count.
 *  Returns a Map keyed by agentId. Missing keys = 0 recent appearances.
 *
 *  Threads excluded · a private 1:1 thread isn't a "room appearance"
 *  in the recency-bias sense; without this filter, a single thread
 *  with a director would skew the next room's auto-picker into
 *  preferring directors the user hasn't recently been threading with.
 *  Sidebar-level decisions consume the main-room appearances only. */
export function recentDirectorAppearances(
  windowSize: number,
): Map<string, number> {
  const rooms = getDb()
    .prepare("SELECT id FROM rooms WHERE room_kind = 'main' ORDER BY created_at DESC LIMIT ?")
    .all(Math.max(1, Math.floor(windowSize))) as Array<{ id: string }>;
  const counts = new Map<string, number>();
  if (rooms.length === 0) return counts;
  const placeholders = rooms.map(() => "?").join(",");
  const memberRows = getDb()
    .prepare(
      `SELECT agent_id FROM room_members
       WHERE room_id IN (${placeholders})
         AND position >= 0`,
    )
    .all(...rooms.map((r) => r.id)) as Array<{ agent_id: string }>;
  for (const row of memberRows) {
    counts.set(row.agent_id, (counts.get(row.agent_id) ?? 0) + 1);
  }
  return counts;
}

export function countRooms(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM rooms").get() as { n: number };
  return row.n;
}

function nextRoomNumber(): number {
  const row = getDb().prepare("SELECT COALESCE(MAX(number), 0) AS n FROM rooms").get() as { n: number };
  return row.n + 1;
}

export interface RoomCreate {
  name: string;
  subject: string;
  mode?: string;
  intensity?: string;
  briefStyle?: string;
  deliveryMode?: RoomDeliveryMode;
  agentIds: string[]; // ordered = speaking order
  /** Optional · marks the room as a follow-up to a prior adjourned
   *  room. The orchestrator detects this and injects the parent
   *  brief + Stage-1 signals into the director system prompts so the
   *  cast sees the prior judgement as settled context. */
  parentRoomId?: string | null;
  parentBriefId?: string | null;
  /** False when the caller explicitly named the room (client passed
   *  `name`); the round-1 auto-title pass must not overwrite. True
   *  (default) when `name` is the 60-char fallback derived from
   *  `subject` — fair game for the auto-summariser. */
  nameAuto?: boolean;
}

/**
 * Create a room with members in a single transaction. Returns the new room +
 * its members (so the caller can immediately seed the room-opened event).
 */
export function createRoom(input: RoomCreate): { room: Room; members: RoomMember[] } {
  const db = getDb();
  const id = newId();
  const number = nextRoomNumber();
  const now = Date.now();
  const mode = input.mode ?? "constructive";
  const intensity = input.intensity ?? "sharp";
  const briefStyle = input.briefStyle ?? "auto";
  const deliveryMode = input.deliveryMode === "voice" ? "voice" : "text";

  const insertRoom = db.prepare(
    "INSERT INTO rooms (id, number, name, subject, mode, intensity, delivery_mode, brief_style, status, created_at, parent_room_id, parent_brief_id, name_auto) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?)",
  );
  const insertMember = db.prepare(
    "INSERT INTO room_members (room_id, agent_id, position, joined_at) VALUES (?, ?, ?, ?)",
  );

  // Chair attaches to every room at position -1 (above all directors)
  // so the round-robin queue (which iterates positions 0+) skips them
  // automatically. Chair runs on lifecycle events, not the queue.
  const chair = getChairAgent();
  const parentRoomId = input.parentRoomId && input.parentRoomId.trim() ? input.parentRoomId.trim() : null;
  const parentBriefId = input.parentBriefId && input.parentBriefId.trim() ? input.parentBriefId.trim() : null;
  // Default to 1 (auto) when caller didn't say · same default as the
  // migration. Caller in routes/rooms.ts flips to 0 when an explicit
  // `name` came in on the request body.
  const nameAuto = input.nameAuto === false ? 0 : 1;

  const tx = db.transaction(() => {
    insertRoom.run(id, number, input.name, input.subject, mode, intensity, deliveryMode, briefStyle, now, parentRoomId, parentBriefId, nameAuto);
    if (chair) insertMember.run(id, chair.id, -1, now);
    input.agentIds.forEach((agentId, idx) => {
      // Don't double-insert if a caller passed the chair id explicitly.
      if (chair && agentId === chair.id) return;
      insertMember.run(id, agentId, idx, now);
    });
  });
  tx();

  return {
    room: getRoom(id)!,
    members: listRoomMembers(id),
  };
}

export interface RoomTimestampPatch {
  pausedAt?: number | null;
  adjournedAt?: number | null;
}

export function setRoomStatus(
  roomId: string,
  status: RoomStatus,
  ts: RoomTimestampPatch = {},
): void {
  const sets: string[] = ["status = ?"];
  const vals: unknown[] = [status];
  if (ts.pausedAt !== undefined)    { sets.push("paused_at = ?");    vals.push(ts.pausedAt); }
  if (ts.adjournedAt !== undefined) { sets.push("adjourned_at = ?"); vals.push(ts.adjournedAt); }
  vals.push(roomId);
  getDb().prepare(`UPDATE rooms SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

/**
 * Overwrite the room's display name with the round-1 LLM topic phrase,
 * but ONLY when name_auto = 1 (i.e. the existing `name` was the 60-char
 * fallback, not a user-authored title). The WHERE clause is enforced at
 * the SQL layer so a future rename UI flipping name_auto to 0 races
 * cleanly with an in-flight auto pass — the UPDATE just becomes a no-op.
 * Returns true when a row was actually rewritten.
 */
export function setRoomNameFromAuto(roomId: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const r = getDb()
    .prepare("UPDATE rooms SET name = ? WHERE id = ? AND name_auto = 1")
    .run(trimmed, roomId);
  return r.changes > 0;
}

/**
 * Force an auto-generated name onto a room AND (re)assert name_auto = 1,
 * bypassing the `WHERE name_auto = 1` guard in `setRoomNameFromAuto`.
 *
 * This exists for the THREAD title backfill: legacy thread rows were
 * created by an earlier `createThread` that wrote a `thread:<dir>`
 * placeholder name with name_auto = 0, which makes `generateRoomTitle`
 * bail at the "user-named" gate forever — so those threads can never
 * get a distilled title through the normal path. The thread titler
 * (`generateThreadTitle`) distils from the thread's own first user
 * message and writes through here so both legacy placeholders and
 * new threads whose fire-and-forget title generation was lost end up
 * with a proper short phrase. NOT for user-renamed rooms · the thread
 * titler's own idempotency check (name no longer looks like a raw
 * fallback) protects a name the user might have set.
 * Returns true when a row was rewritten.
 */
export function forceRoomAutoName(roomId: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const r = getDb()
    .prepare("UPDATE rooms SET name = ?, name_auto = 1 WHERE id = ?")
    .run(trimmed, roomId);
  return r.changes > 0;
}

/**
 * Overwrite a room's `subject` field. Used for THREADS to swap the
 * inherited-from-parent subject for the user's actual first message
 * in the thread, so the auto-title generator (which reads subject)
 * produces a thread-specific label like "性能优化讨论" instead of
 * reusing the parent room's broader question. No-op when `next` is
 * empty.
 */
export function setRoomSubject(roomId: string, next: string): boolean {
  const trimmed = next.trim();
  if (!trimmed) return false;
  const r = getDb()
    .prepare("UPDATE rooms SET subject = ? WHERE id = ?")
    .run(trimmed, roomId);
  return r.changes > 0;
}

/**
 * Add a director to a live room. The new member is appended at the
 * tail of the speaking order (one past the current max position) so
 * existing rotations don't reshuffle. No-op if already a member.
 * Returns the row that was created (or the existing one).
 */
export function addRoomMember(roomId: string, agentId: string): RoomMember | null {
  const db = getDb();
  const existing = db
    .prepare("SELECT agent_id, position, joined_at, removed_at FROM room_members WHERE room_id = ? AND agent_id = ?")
    .get(roomId, agentId) as MemberRow | undefined;
  if (existing) {
    // Already on the roster — either still active (no-op) or
    // previously excused → resurrect by clearing removed_at. Keep
    // the original position so prior speaker-queue rotations and
    // any messages filed under that index still line up.
    if (existing.removed_at !== null) {
      db.prepare("UPDATE room_members SET removed_at = NULL WHERE room_id = ? AND agent_id = ?")
        .run(roomId, agentId);
      return { agentId, position: existing.position, joinedAt: existing.joined_at, removedAt: null };
    }
    return mapMember(existing);
  }
  const maxRow = db
    .prepare("SELECT COALESCE(MAX(position), -1) AS p FROM room_members WHERE room_id = ?")
    .get(roomId) as { p: number };
  const position = maxRow.p + 1;
  const now = Date.now();
  db.prepare(
    "INSERT INTO room_members (room_id, agent_id, position, joined_at, removed_at) VALUES (?, ?, ?, ?, NULL)",
  ).run(roomId, agentId, position, now);
  return { agentId, position, joinedAt: now, removedAt: null };
}

/** Excuse a director from the room via soft-delete · flips
 *  `removed_at` from NULL to the current timestamp. The row stays
 *  in `room_members` so past messages can still resolve the
 *  speaker's name, avatar, and voice profile via
 *  `listAllRoomMembers`. No-op if already excused or not a member. */
export function removeRoomMember(roomId: string, agentId: string): boolean {
  const result = getDb()
    .prepare(
      "UPDATE room_members SET removed_at = ? " +
      "WHERE room_id = ? AND agent_id = ? AND removed_at IS NULL",
    )
    .run(Date.now(), roomId, agentId);
  return result.changes > 0;
}

/** Toggle the per-room incognito flag. While true, room adjourn skips
 *  the long-term memory extraction step for every agent. */
export function setRoomIncognito(roomId: string, incognito: boolean): void {
  getDb()
    .prepare("UPDATE rooms SET incognito = ? WHERE id = ?")
    .run(incognito ? 1 : 0, roomId);
}

/** Update the soft-pause flag set by the chair after a round-end. */
export function setAwaitingContinue(roomId: string, awaiting: boolean): void {
  getDb()
    .prepare("UPDATE rooms SET awaiting_continue = ? WHERE id = ?")
    .run(awaiting ? 1 : 0, roomId);
}

/** Update the soft-pause flag set by the chair during clarification. */
export function setAwaitingClarify(roomId: string, awaiting: boolean): void {
  getDb()
    .prepare("UPDATE rooms SET awaiting_clarify = ? WHERE id = ?")
    .run(awaiting ? 1 : 0, roomId);
}

export interface RoomSettingsPatch {
  mode?: string;
  intensity?: string;
  briefStyle?: string;
  deliveryMode?: RoomDeliveryMode;
  voteTrigger?: RoomVoteTrigger;
}

/**
 * Update room configuration (tone/intensity/report style). Only fields
 * present on the patch are touched — pass undefined to leave alone.
 * Returns the updated room or null if the row doesn't exist.
 */
export function updateRoomSettings(
  roomId: string,
  patch: RoomSettingsPatch,
): Room | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.mode !== undefined)       { sets.push("mode = ?");        vals.push(patch.mode); }
  if (patch.intensity !== undefined)  { sets.push("intensity = ?");   vals.push(patch.intensity); }
  if (patch.briefStyle !== undefined) { sets.push("brief_style = ?"); vals.push(patch.briefStyle); }
  if (patch.deliveryMode !== undefined) { sets.push("delivery_mode = ?"); vals.push(patch.deliveryMode === "voice" ? "voice" : "text"); }
  if (patch.voteTrigger !== undefined) { sets.push("vote_trigger = ?"); vals.push(patch.voteTrigger === "manual" ? "manual" : "auto"); }
  if (sets.length === 0) return getRoom(roomId);
  vals.push(roomId);
  getDb().prepare(`UPDATE rooms SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getRoom(roomId);
}

/**
 * Permanently delete a room and everything attached to it.
 * room_members / messages / config_events / briefs all CASCADE via FKs.
 * Returns true if a row was deleted.
 */
export function deleteRoom(roomId: string): boolean {
  const result = getDb().prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
  return result.changes > 0;
}

/**
 * Boot-time recovery for rooms left in `awaiting_clarify = 1` from a
 * previous process that died mid-stream. The chair-clarify pipeline
 * sets the flag synchronously when the room opens, then writes the
 * chair's clarifying question via streaming · if the process is
 * killed before the stream completes, the flag stays on but no chair
 * message ever lands, so the room appears empty to the user (just
 * their opening question, no chair, input bar disabled by the
 * awaiting-clarify lock). Clear the flag for any room where
 * awaiting_clarify is set but no chair message exists yet — the user
 * can then continue normally; their next message kicks the directors
 * straight off the user's opening as if clarify resolved.
 *
 * Returns the count of rows fixed.
 */
export function recoverStuckClarifyRooms(): number {
  const r = getDb()
    .prepare(
      `UPDATE rooms
       SET awaiting_clarify = 0
       WHERE awaiting_clarify = 1
         AND id NOT IN (
           SELECT DISTINCT m.room_id
             FROM messages m
             JOIN agents a ON a.id = m.author_id
            WHERE a.role_kind = 'moderator'
              AND m.author_kind = 'agent'
         )`,
    )
    .run();
  return r.changes;
}
