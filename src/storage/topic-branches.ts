/**
 * Topic-tree storage · Layer 3.1 of the divergence stack.
 *
 * Branches represent distinct angles the room has explored. Each
 * director message gets tagged with a branch (either extending an
 * existing branch or opening a new one) so the dissent-picker can
 * favor speakers who haven't engaged with the dominant branches,
 * and the UI can surface coverage breadth.
 */
import { newId } from "../utils/id.js";

import { getDb } from "./db.js";

export interface TopicBranch {
  id: string;
  roomId: string;
  label: string;
  parentId: string | null;
  openedAt: number;
  turnCount: number;
  lastSpeakerId: string | null;
}

export interface MessageBranchTag {
  messageId: string;
  branchId: string;
  isOpener: boolean;
  taggedAt: number;
}

interface BranchRow {
  id: string;
  room_id: string;
  label: string;
  parent_id: string | null;
  opened_at: number;
  turn_count: number;
  last_speaker_id: string | null;
}

function mapBranch(r: BranchRow): TopicBranch {
  return {
    id: r.id,
    roomId: r.room_id,
    label: r.label,
    parentId: r.parent_id,
    openedAt: r.opened_at,
    turnCount: r.turn_count,
    lastSpeakerId: r.last_speaker_id,
  };
}

export function listBranchesForRoom(roomId: string): TopicBranch[] {
  const rows = getDb()
    .prepare(
      "SELECT id, room_id, label, parent_id, opened_at, turn_count, last_speaker_id " +
      "FROM topic_branches WHERE room_id = ? ORDER BY opened_at ASC",
    )
    .all(roomId) as BranchRow[];
  return rows.map(mapBranch);
}

export function createBranch(opts: {
  roomId: string;
  label: string;
  parentId?: string | null;
  openerSpeakerId?: string | null;
}): TopicBranch {
  const now = Date.now();
  const id = newId();
  const label = opts.label.trim().slice(0, 80);
  const parentId = opts.parentId || null;
  const speakerId = opts.openerSpeakerId || null;
  getDb()
    .prepare(
      "INSERT INTO topic_branches (id, room_id, label, parent_id, opened_at, turn_count, last_speaker_id) " +
      "VALUES (?, ?, ?, ?, ?, 1, ?)",
    )
    .run(id, opts.roomId, label, parentId, now, speakerId);
  return {
    id,
    roomId: opts.roomId,
    label,
    parentId,
    openedAt: now,
    turnCount: 1,
    lastSpeakerId: speakerId,
  };
}

export function tagMessageWithBranch(opts: {
  messageId: string;
  branchId: string;
  isOpener: boolean;
  speakerId?: string | null;
}): void {
  const now = Date.now();
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO message_branches (message_id, branch_id, is_opener, tagged_at) " +
    "VALUES (?, ?, ?, ?)",
  ).run(opts.messageId, opts.branchId, opts.isOpener ? 1 : 0, now);
  // Bump the branch's turn counter and update last_speaker_id when
  // this isn't the opener (opener already increments on createBranch).
  if (!opts.isOpener) {
    db.prepare(
      "UPDATE topic_branches SET turn_count = turn_count + 1, last_speaker_id = COALESCE(?, last_speaker_id) WHERE id = ?",
    ).run(opts.speakerId || null, opts.branchId);
  } else if (opts.speakerId) {
    db.prepare("UPDATE topic_branches SET last_speaker_id = ? WHERE id = ?")
      .run(opts.speakerId, opts.branchId);
  }
}

/** Speakers who have NOT been tagged on the given branches.
 *  Used by the dissent-picker to prefer "underexposed" speakers
 *  when the room is converging on a few branches. */
export function speakersOnBranches(
  roomId: string,
  branchIds: string[],
): Set<string> {
  if (branchIds.length === 0) return new Set();
  const placeholders = branchIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT m.author_id AS author_id
       FROM messages m
       JOIN message_branches mb ON mb.message_id = m.id
       WHERE m.room_id = ?
         AND mb.branch_id IN (${placeholders})
         AND m.author_kind = 'agent'
         AND m.author_id IS NOT NULL`,
    )
    .all(roomId, ...branchIds) as Array<{ author_id: string }>;
  return new Set(rows.map((r) => r.author_id));
}

/** Top-N branches by recent activity (turn_count desc, opened_at
 *  desc as tiebreaker). The "dominant branches" the dissent picker
 *  wants to avoid. */
export function dominantBranches(roomId: string, limit = 3): TopicBranch[] {
  const rows = getDb()
    .prepare(
      "SELECT id, room_id, label, parent_id, opened_at, turn_count, last_speaker_id " +
      "FROM topic_branches WHERE room_id = ? " +
      "ORDER BY turn_count DESC, opened_at DESC LIMIT ?",
    )
    .all(roomId, Math.max(1, Math.floor(limit))) as BranchRow[];
  return rows.map(mapBranch);
}
