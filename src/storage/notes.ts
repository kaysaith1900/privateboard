/** Notes · chairman's notes feature. User-curated excerpts saved
 *  from director output while re-reading a room. Quote + adjacent
 *  context + char-range so the in-room overlay can wrap the same
 *  span on next render. */
import { newId } from "../utils/id.js";

import { getDb } from "./db.js";

export type NoteAuthorKind = "agent" | "user" | "system";
export type NoteStatus = "open" | "acted" | "archived";

export interface Note {
  id: string;
  roomId: string;
  messageId: string;
  authorKind: NoteAuthorKind;
  authorId: string | null;
  authorName: string;
  quoteText: string;
  contextBefore: string;
  contextAfter: string;
  charOffsetStart: number;
  charOffsetEnd: number;
  userNote: string | null;
  tags: string[];
  status: NoteStatus;
  createdAt: number;
}

interface Row {
  id: string;
  room_id: string;
  message_id: string;
  author_kind: string;
  author_id: string | null;
  author_name: string;
  quote_text: string;
  context_before: string;
  context_after: string;
  char_offset_start: number;
  char_offset_end: number;
  user_note: string | null;
  tags_json: string | null;
  status: string;
  created_at: number;
}

const COLS =
  "id, room_id, message_id, author_kind, author_id, author_name, " +
  "quote_text, context_before, context_after, char_offset_start, " +
  "char_offset_end, user_note, tags_json, status, created_at";

function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  } catch { return []; }
}

function mapRow(row: Row): Note {
  return {
    id: row.id,
    roomId: row.room_id,
    messageId: row.message_id,
    authorKind: row.author_kind as NoteAuthorKind,
    authorId: row.author_id,
    authorName: row.author_name,
    quoteText: row.quote_text,
    contextBefore: row.context_before,
    contextAfter: row.context_after,
    charOffsetStart: row.char_offset_start,
    charOffsetEnd: row.char_offset_end,
    userNote: row.user_note,
    tags: parseTags(row.tags_json),
    status: (row.status === "acted" || row.status === "archived" ? row.status : "open") as NoteStatus,
    createdAt: row.created_at,
  };
}

export interface NoteInsert {
  roomId: string;
  messageId: string;
  authorKind: NoteAuthorKind;
  authorId: string | null;
  authorName: string;
  quoteText: string;
  contextBefore?: string;
  contextAfter?: string;
  charOffsetStart: number;
  charOffsetEnd: number;
}

export function createNote(n: NoteInsert): Note {
  const db = getDb();
  const id = newId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO notes (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    n.roomId,
    n.messageId,
    n.authorKind,
    n.authorId,
    n.authorName,
    n.quoteText,
    n.contextBefore ?? "",
    n.contextAfter ?? "",
    n.charOffsetStart,
    n.charOffsetEnd,
    null,    // user_note · deferred
    null,    // tags_json · deferred
    "open",
    now,
  );
  return getNote(id)!;
}

export function getNote(id: string): Note | null {
  const row = getDb().prepare(`SELECT ${COLS} FROM notes WHERE id = ?`).get(id) as Row | undefined;
  return row ? mapRow(row) : null;
}

export function listNotes(): Note[] {
  const rows = getDb()
    .prepare(`SELECT ${COLS} FROM notes ORDER BY created_at DESC`)
    .all() as Row[];
  return rows.map(mapRow);
}

export function listNotesByRoom(roomId: string): Note[] {
  const rows = getDb()
    .prepare(`SELECT ${COLS} FROM notes WHERE room_id = ? ORDER BY created_at DESC`)
    .all(roomId) as Row[];
  return rows.map(mapRow);
}

/** Notes for a single message · used by the in-room highlight overlay
 *  when rendering a director message to know which char ranges should
 *  be wrapped in <span class="note-highlight">. */
export function listNotesByMessage(messageId: string): Note[] {
  const rows = getDb()
    .prepare(`SELECT ${COLS} FROM notes WHERE message_id = ? ORDER BY created_at ASC`)
    .all(messageId) as Row[];
  return rows.map(mapRow);
}

/** Bulk fetch notes for a list of messages · single round-trip
 *  alternative to N calls of listNotesByMessage when rendering an
 *  entire room. Returns a Map keyed by messageId. */
export function listNotesForMessages(messageIds: string[]): Map<string, Note[]> {
  const out = new Map<string, Note[]>();
  if (messageIds.length === 0) return out;
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT ${COLS} FROM notes WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...messageIds) as Row[];
  for (const row of rows) {
    const note = mapRow(row);
    const list = out.get(note.messageId) ?? [];
    list.push(note);
    out.set(note.messageId, list);
  }
  return out;
}

export function deleteNote(id: string): boolean {
  const result = getDb().prepare("DELETE FROM notes WHERE id = ?").run(id);
  return result.changes > 0;
}

export function countNotes(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number };
  return row.c ?? 0;
}

/** Note + the parent room's display fields, joined at read time so
 *  the All Notes view can render a card without a follow-up
 *  /api/rooms/:id call per note. Mirrors BriefWithRoom's pattern. */
export interface NoteWithRoom extends Note {
  roomName: string;
  roomSubject: string;
  roomNumber: number;
  roomStatus: string;
}

interface RowWithRoom extends Row {
  room_name: string;
  room_subject: string;
  room_number: number;
  room_status: string;
}

export function listAllNotesWithRoom(): NoteWithRoom[] {
  const rows = getDb()
    .prepare(
      `SELECT n.id, n.room_id, n.message_id, n.author_kind, n.author_id,
              n.author_name, n.quote_text, n.context_before, n.context_after,
              n.char_offset_start, n.char_offset_end, n.user_note, n.tags_json,
              n.status, n.created_at,
              r.name AS room_name, r.subject AS room_subject,
              r.number AS room_number, r.status AS room_status
         FROM notes n
         JOIN rooms r ON r.id = n.room_id
         ORDER BY n.created_at DESC`,
    )
    .all() as RowWithRoom[];
  return rows.map((row) => ({
    ...mapRow(row),
    roomName: row.room_name,
    roomSubject: row.room_subject,
    roomNumber: row.room_number,
    roomStatus: row.room_status,
  }));
}
