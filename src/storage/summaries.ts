/**
 * Storage layer for hierarchical room summaries (see migration 019).
 *
 * Two flavours:
 *   L1 · per-round narrative · one row per (room, round)
 *   L2 · rolling consolidated narrative · one row per room
 *
 * The orchestrator-side summarizer in src/orchestrator/summarize.ts
 * owns the generation cadence; this module is purely CRUD.
 */
import { getDb } from "./db.js";

export interface SummaryRow {
  id: number;
  roomId: string;
  level: 1 | 2;
  roundNum: number | null;
  startRound: number | null;
  endRound: number | null;
  body: string;
  modelV: string | null;
  sourceHash: string | null;
  createdAt: number;
}

interface DbRow {
  id: number;
  room_id: string;
  level: number;
  round_num: number | null;
  start_round: number | null;
  end_round: number | null;
  body: string;
  model_v: string | null;
  source_hash: string | null;
  created_at: number;
}

function rowFrom(r: DbRow): SummaryRow {
  return {
    id: r.id,
    roomId: r.room_id,
    level: r.level as 1 | 2,
    roundNum: r.round_num,
    startRound: r.start_round,
    endRound: r.end_round,
    body: r.body,
    modelV: r.model_v,
    sourceHash: r.source_hash,
    createdAt: r.created_at,
  };
}

/** All L1 rows for a room, ordered by round_num asc. */
export function listL1Summaries(roomId: string): SummaryRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM room_summaries
       WHERE room_id = ? AND level = 1
       ORDER BY round_num ASC`,
    )
    .all(roomId)
    .map((r) => rowFrom(r as DbRow));
}

/** Returns the existing L1 row for (room, round), or null. */
export function getL1Summary(roomId: string, roundNum: number): SummaryRow | null {
  const r = getDb()
    .prepare(
      `SELECT * FROM room_summaries
       WHERE room_id = ? AND level = 1 AND round_num = ?
       LIMIT 1`,
    )
    .get(roomId, roundNum);
  return r ? rowFrom(r as DbRow) : null;
}

/** The single L2 row for a room, or null when nothing's been folded yet. */
export function getL2Summary(roomId: string): SummaryRow | null {
  const r = getDb()
    .prepare(
      `SELECT * FROM room_summaries
       WHERE room_id = ? AND level = 2
       LIMIT 1`,
    )
    .get(roomId);
  return r ? rowFrom(r as DbRow) : null;
}

interface UpsertL1Args {
  roomId: string;
  roundNum: number;
  body: string;
  modelV: string | null;
  sourceHash: string | null;
}

/** Insert or replace the L1 row for (room, round). */
export function upsertL1Summary(args: UpsertL1Args): SummaryRow {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO room_summaries (room_id, level, round_num, start_round, end_round, body, model_v, source_hash, created_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (room_id, level, round_num) WHERE level = 1
       DO UPDATE SET body = excluded.body, model_v = excluded.model_v, source_hash = excluded.source_hash, created_at = excluded.created_at`,
    )
    .run(args.roomId, args.roundNum, args.roundNum, args.roundNum, args.body, args.modelV, args.sourceHash, now);
  return getL1Summary(args.roomId, args.roundNum)!;
}

interface UpsertL2Args {
  roomId: string;
  startRound: number;
  endRound: number;
  body: string;
  modelV: string | null;
  sourceHash: string | null;
}

/** Insert or replace the (single) L2 row for a room. */
export function upsertL2Summary(args: UpsertL2Args): SummaryRow {
  const now = Date.now();
  // Delete-then-insert · the partial unique index is on (room_id, level)
  // for level=2, but ON CONFLICT with WHERE-clause indexes can be
  // finicky across SQLite versions. Two-statement form is reliably
  // portable and the table is tiny.
  const db = getDb();
  db.prepare("DELETE FROM room_summaries WHERE room_id = ? AND level = 2").run(args.roomId);
  db.prepare(
    `INSERT INTO room_summaries (room_id, level, round_num, start_round, end_round, body, model_v, source_hash, created_at)
     VALUES (?, 2, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(args.roomId, args.startRound, args.endRound, args.body, args.modelV, args.sourceHash, now);
  return getL2Summary(args.roomId)!;
}

/** Drop the L1 row for (room, round) — used after folding it into L2. */
export function deleteL1Summary(roomId: string, roundNum: number): void {
  getDb()
    .prepare("DELETE FROM room_summaries WHERE room_id = ? AND level = 1 AND round_num = ?")
    .run(roomId, roundNum);
}
