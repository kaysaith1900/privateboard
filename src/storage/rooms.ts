/** Rooms + room_members + lifecycle helpers. */
import { newId } from "../utils/id.js";

import { getChairAgent } from "./agents.js";
import { getDb } from "./db.js";

export type RoomStatus = "live" | "paused" | "adjourned";

export interface Room {
  id: string;
  number: number;
  name: string;
  subject: string;
  mode: string;       // tone: brainstorm | constructive | debate | no-mercy
  intensity: string;  // calm | sharp | brutal
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
}

export interface RoomMember {
  agentId: string;
  position: number;
  joinedAt: number;
}

interface Row {
  id: string;
  number: number;
  name: string;
  subject: string;
  mode: string;
  intensity: string;
  status: string;
  brief_style: string | null;
  awaiting_continue: number;
  awaiting_clarify: number;
  created_at: number;
  paused_at: number | null;
  adjourned_at: number | null;
  incognito: number;
}

interface MemberRow {
  agent_id: string;
  position: number;
  joined_at: number;
}

const ROOM_COLS =
  "id, number, name, subject, mode, intensity, status, brief_style, awaiting_continue, " +
  "awaiting_clarify, created_at, paused_at, adjourned_at, incognito";

function mapRow(row: Row): Room {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    subject: row.subject,
    mode: row.mode,
    intensity: row.intensity,
    status: row.status as RoomStatus,
    briefStyle: row.brief_style,
    awaitingContinue: row.awaiting_continue === 1,
    awaitingClarify: row.awaiting_clarify === 1,
    createdAt: row.created_at,
    pausedAt: row.paused_at,
    adjournedAt: row.adjourned_at,
    incognito: row.incognito === 1,
  };
}

function mapMember(row: MemberRow): RoomMember {
  return { agentId: row.agent_id, position: row.position, joinedAt: row.joined_at };
}

export function listRooms(): Room[] {
  const rows = getDb()
    .prepare(`SELECT ${ROOM_COLS} FROM rooms ORDER BY created_at DESC`)
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
      "SELECT agent_id, position, joined_at FROM room_members WHERE room_id = ? ORDER BY position ASC",
    )
    .all(roomId) as MemberRow[];
  return rows.map(mapMember);
}

/** How many of the last N rooms each director appeared in. Used by
 *  the director auto-picker for recency-bias — directors seated in
 *  recent rooms get downweighted when topical fit is comparable, so
 *  the user doesn't keep seeing the same trio across consecutive
 *  rooms. The chair (position -1) is excluded from the count.
 *  Returns a Map keyed by agentId. Missing keys = 0 recent appearances. */
export function recentDirectorAppearances(
  windowSize: number,
): Map<string, number> {
  const rooms = getDb()
    .prepare("SELECT id FROM rooms ORDER BY created_at DESC LIMIT ?")
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
  agentIds: string[]; // ordered = speaking order
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

  const insertRoom = db.prepare(
    "INSERT INTO rooms (id, number, name, subject, mode, intensity, brief_style, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?)",
  );
  const insertMember = db.prepare(
    "INSERT INTO room_members (room_id, agent_id, position, joined_at) VALUES (?, ?, ?, ?)",
  );

  // Chair attaches to every room at position -1 (above all directors)
  // so the round-robin queue (which iterates positions 0+) skips them
  // automatically. Chair runs on lifecycle events, not the queue.
  const chair = getChairAgent();

  const tx = db.transaction(() => {
    insertRoom.run(id, number, input.name, input.subject, mode, intensity, briefStyle, now);
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
 * Add a director to a live room. The new member is appended at the
 * tail of the speaking order (one past the current max position) so
 * existing rotations don't reshuffle. No-op if already a member.
 * Returns the row that was created (or the existing one).
 */
export function addRoomMember(roomId: string, agentId: string): RoomMember | null {
  const db = getDb();
  const existing = db
    .prepare("SELECT agent_id, position, joined_at FROM room_members WHERE room_id = ? AND agent_id = ?")
    .get(roomId, agentId) as MemberRow | undefined;
  if (existing) return mapMember(existing);
  const maxRow = db
    .prepare("SELECT COALESCE(MAX(position), -1) AS p FROM room_members WHERE room_id = ?")
    .get(roomId) as { p: number };
  const position = maxRow.p + 1;
  const now = Date.now();
  db.prepare(
    "INSERT INTO room_members (room_id, agent_id, position, joined_at) VALUES (?, ?, ?, ?)",
  ).run(roomId, agentId, position, now);
  return { agentId, position, joinedAt: now };
}

/** Remove a director from a room. No-op if they weren't a member. */
export function removeRoomMember(roomId: string, agentId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM room_members WHERE room_id = ? AND agent_id = ?")
    .run(roomId, agentId);
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
