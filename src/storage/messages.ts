/** Messages — full implementation with insert + streaming append helpers. */
import { newId } from "../utils/id.js";

import { getDb } from "./db.js";

export type AuthorKind = "agent" | "user" | "system";

export interface MessageMeta {
  mentions?: string[];        // agent ids
  speakerStatus?: "thinking" | "streaming" | "final";
  streaming?: boolean;
  [key: string]: unknown;
}

export interface Message {
  id: string;
  roomId: string;
  authorKind: AuthorKind;
  authorId: string | null;
  replyToId: string | null;
  body: string;
  meta: MessageMeta;
  roundNum: number;
  createdAt: number;
}

interface Row {
  id: string;
  room_id: string;
  author_kind: string;
  author_id: string | null;
  reply_to_id: string | null;
  body: string;
  meta_json: string | null;
  round_num: number;
  created_at: number;
}

const COLS =
  "id, room_id, author_kind, author_id, reply_to_id, body, meta_json, round_num, created_at";

function mapRow(row: Row): Message {
  return {
    id: row.id,
    roomId: row.room_id,
    authorKind: row.author_kind as AuthorKind,
    authorId: row.author_id,
    replyToId: row.reply_to_id,
    body: row.body,
    meta: row.meta_json ? (JSON.parse(row.meta_json) as MessageMeta) : {},
    roundNum: row.round_num,
    createdAt: row.created_at,
  };
}

export function listMessages(roomId: string): Message[] {
  const rows = getDb()
    .prepare(`SELECT ${COLS} FROM messages WHERE room_id = ? ORDER BY created_at ASC`)
    .all(roomId) as Row[];
  return rows.map(mapRow);
}

export function getMessage(id: string): Message | null {
  const row = getDb()
    .prepare(`SELECT ${COLS} FROM messages WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Most recent N messages for context-window assembly. Returned in chronological
 * order (oldest first), so callers can append straight onto the LLM history.
 */
export function listRecentMessages(roomId: string, limit = 30): Message[] {
  const rows = getDb()
    .prepare(`SELECT ${COLS} FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(roomId, limit) as Row[];
  return rows.map(mapRow).reverse();
}

export function getCurrentRound(roomId: string): number {
  const row = getDb()
    .prepare("SELECT COALESCE(MAX(round_num), 1) AS n FROM messages WHERE room_id = ?")
    .get(roomId) as { n: number };
  return row.n;
}

/**
 * Next round number for an incoming USER message. Each user turn opens a new
 * round; the directors that respond in that turn share the same round_num.
 */
export function nextUserRoundNum(roomId: string): number {
  const row = getDb()
    .prepare("SELECT COALESCE(MAX(round_num), 0) AS n FROM messages WHERE room_id = ?")
    .get(roomId) as { n: number };
  return row.n + 1;
}

export interface MessageInsert {
  roomId: string;
  authorKind: AuthorKind;
  authorId?: string | null;
  replyToId?: string | null;
  body: string;
  meta?: MessageMeta;
  roundNum?: number;
}

export function insertMessage(m: MessageInsert): Message {
  const id = newId();
  const now = Date.now();
  const roundNum = m.roundNum ?? getCurrentRound(m.roomId);
  const metaJson = m.meta ? JSON.stringify(m.meta) : null;

  getDb()
    .prepare(
      "INSERT INTO messages (id, room_id, author_kind, author_id, reply_to_id, body, meta_json, round_num, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      m.roomId,
      m.authorKind,
      m.authorId ?? null,
      m.replyToId ?? null,
      m.body,
      metaJson,
      roundNum,
      now,
    );

  return getMessage(id)!;
}

/**
 * Update the body and (optionally) meta of an existing message. Used by the
 * orchestrator while a director is streaming — we insert a placeholder and
 * keep replacing its body as deltas arrive.
 */
export function updateMessageBody(id: string, body: string, meta?: MessageMeta): void {
  if (meta) {
    getDb()
      .prepare("UPDATE messages SET body = ?, meta_json = ? WHERE id = ?")
      .run(body, JSON.stringify(meta), id);
  } else {
    getDb().prepare("UPDATE messages SET body = ? WHERE id = ?").run(body, id);
  }
}

/** Permanently remove a message — used to drop empty placeholders. */
export function deleteMessage(id: string): boolean {
  const r = getDb().prepare("DELETE FROM messages WHERE id = ?").run(id);
  return r.changes > 0;
}
