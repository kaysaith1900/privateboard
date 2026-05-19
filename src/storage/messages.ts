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

/**
 * Boot-time recovery for messages stuck in `meta.streaming = true`.
 *
 * A streaming placeholder lives in DB while a director's LLM call is
 * mid-flight; pumpQueue / streamSpeakerTurn flip it to `streaming:
 * false` when the call resolves or errors. If the server crashes
 * mid-stream — or, historically, if the stream iterator throws and
 * the catch path skipped cleanup — the row stays `streaming: true`
 * forever, and every subsequent room load shows the director as
 * "thinking" with no recovery path.
 *
 * Scope this to startup so the in-memory orchestrator state can't
 * collide with our writes. Empty-body placeholders get deleted (no
 * useful content to keep); non-empty ones are finalised with an
 * error note so the user sees what's left of the partial reply
 * instead of a silent disappearance.
 */
/** Cross-room keyword search. Substring match against `body` only ·
 *  filters out streaming placeholders (so "thinking…" / partial
 *  drafts don't show up) and drops empty bodies.
 *
 *  Returns oldest-first per room so the UI can group by room with a
 *  stable order; `LIMIT` caps the result count globally to keep the
 *  response cheap. The match offset is the byte index of the first
 *  case-insensitive hit so the client can render a centered snippet
 *  without re-searching. */
export interface MessageSearchHit {
  messageId: string;
  roomId: string;
  authorKind: AuthorKind;
  authorId: string | null;
  body: string;
  matchOffset: number;       // index of first match in `body`, lowercase-compared
  createdAt: number;
}
export function searchMessages(query: string, limit = 200): MessageSearchHit[] {
  const q = (query || "").trim();
  if (q.length < 1) return [];
  const like = "%" + q.replace(/([%_\\])/g, "\\$1") + "%";
  const rows = getDb()
    .prepare(
      `SELECT id, room_id, author_kind, author_id, body, created_at
       FROM messages
       WHERE body LIKE ? ESCAPE '\\'
         AND body IS NOT NULL
         AND trim(body) <> ''
         AND (
           meta_json IS NULL
           OR NOT json_valid(meta_json)
           OR json_extract(meta_json, '$.streaming') IS NULL
           OR json_extract(meta_json, '$.streaming') = 0
         )
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(like, limit) as Array<{
      id: string;
      room_id: string;
      author_kind: string;
      author_id: string | null;
      body: string;
      created_at: number;
    }>;
  const ql = q.toLowerCase();
  return rows.map((r) => ({
    messageId: r.id,
    roomId: r.room_id,
    authorKind: r.author_kind as AuthorKind,
    authorId: r.author_id,
    body: r.body,
    matchOffset: r.body.toLowerCase().indexOf(ql),
    createdAt: r.created_at,
  }));
}

/** Strict-finalize a single message that's stuck in streaming:true.
 *  Sets meta.streaming=false, meta.speakerStatus='final', meta.error
 *  to the supplied reason. Used by:
 *   - Per-turn try/finally blocks (LLM abort / exception / timeout)
 *   - The runtime orphan sweep (5min-stale messages)
 *  Idempotent · running it on an already-finalised message is a no-op
 *  in semantic terms (streaming flag is already 0) and the SQL just
 *  re-sets the same fields. Returns true when the row was actually
 *  flipped (was streaming before), false if it was already done. */
export function finalizeStreamingMessage(messageId: string, reason: string): boolean {
  const db = getDb();
  // Check current state · only count "flipped" when we changed the
  // streaming flag from 1 → 0. If it was already 0, callers can treat
  // this as a no-op.
  const before = db
    .prepare(
      `SELECT json_extract(meta_json, '$.streaming') AS streaming
       FROM messages WHERE id = ?`,
    )
    .get(messageId) as { streaming: number | null } | undefined;
  if (!before) return false;
  if (before.streaming !== 1) return false;
  db
    .prepare(
      `UPDATE messages
       SET meta_json = json_set(
         COALESCE(meta_json, '{}'),
         '$.streaming', 0,
         '$.speakerStatus', 'final',
         '$.error', ?
       )
       WHERE id = ?`,
    )
    .run(String(reason || "finalized"), messageId);
  return true;
}

/** Sweep stuck streaming:true messages. Two modes:
 *   - No args / maxAgeMs unset → original boot behaviour: nuke empty-
 *     body placeholders, flip non-empty ones to final with the boot
 *     reason. Catches every orphan regardless of age.
 *   - maxAgeMs set → only target messages whose updated_at (or
 *     created_at, if updated_at isn't tracked) is older than that
 *     threshold. Used by the runtime sweep (every 60s, threshold 5min)
 *     so legitimate long-running streams aren't killed mid-flight.
 *  Returns counts for telemetry. */
export function cleanupOrphanedStreams(
  opts: { maxAgeMs?: number; reason?: string } = {},
): { fixed: number; deleted: number } {
  const db = getDb();
  const reason = opts.reason || "orphaned · server restarted mid-stream";
  const ageClause = typeof opts.maxAgeMs === "number"
    ? `AND created_at < ${Math.floor(Date.now() - opts.maxAgeMs)}`
    : "";
  const del = db
    .prepare(
      `DELETE FROM messages
       WHERE json_valid(meta_json)
         AND json_extract(meta_json, '$.streaming') = 1
         AND (body IS NULL OR trim(body) = '')
         ${ageClause}`,
    )
    .run();
  // 0 instead of `json('false')` — SQLite stores it as a JSON number
  // and the frontend's truthiness check (`if (meta.streaming)`) reads
  // it as falsy. The strict `=== true` check in chair-interrupt also
  // rejects 0. Both downstream consumers behave correctly.
  const upd = db
    .prepare(
      `UPDATE messages
       SET meta_json = json_set(
         meta_json,
         '$.streaming', 0,
         '$.speakerStatus', 'final',
         '$.error', ?
       )
       WHERE json_valid(meta_json)
         AND json_extract(meta_json, '$.streaming') = 1
         ${ageClause}`,
    )
    .run(reason);
  return { fixed: upd.changes, deleted: del.changes };
}
