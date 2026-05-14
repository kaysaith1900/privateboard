/**
 * Quality-Diversity (MAP-Elites) behavioral archive · Layer 4 of
 * the divergence stack.
 *
 * Each director turn lands in one cell of a 4×4×4 = 64-cell grid
 * defined over three behavioral dimensions:
 *   · abstraction-level  · 0=concrete-example .. 3=abstract-principle
 *   · time-scale         · 0=this-quarter      .. 3=civilization-scale
 *   · stakeholder-scope  · 0=individual         .. 3=societal
 *
 * The room's "coverage" is the count of distinct cells touched.
 * Divergence engineering goal · keep coverage growing each round.
 * Picker layers can read the empty-cell map to favor candidates
 * whose persona naturally fills underexplored cells.
 */
import { getDb } from "./db.js";

export const QD_BUCKETS_PER_DIM = 4;
export const QD_TOTAL_CELLS = QD_BUCKETS_PER_DIM ** 3;

export interface QDScore {
  /** Continuous [0, 1] scores. The bucket is derived from these. */
  abstractionScore: number;
  timeScore: number;
  stakeholderScore: number;
}

export interface QDArchiveRow {
  messageId: string;
  roomId: string;
  abstractionBucket: number;
  timeBucket: number;
  stakeholderBucket: number;
  abstractionScore: number;
  timeScore: number;
  stakeholderScore: number;
  scoredAt: number;
}

interface Row {
  message_id: string;
  room_id: string;
  abstraction_score: number;
  abstraction_bucket: number;
  time_score: number;
  time_bucket: number;
  stakeholder_score: number;
  stakeholder_bucket: number;
  scored_at: number;
}

function mapRow(r: Row): QDArchiveRow {
  return {
    messageId: r.message_id,
    roomId: r.room_id,
    abstractionBucket: r.abstraction_bucket,
    timeBucket: r.time_bucket,
    stakeholderBucket: r.stakeholder_bucket,
    abstractionScore: r.abstraction_score,
    timeScore: r.time_score,
    stakeholderScore: r.stakeholder_score,
    scoredAt: r.scored_at,
  };
}

export function bucketize(score: number): number {
  const s = Math.max(0, Math.min(1, score));
  const b = Math.floor(s * QD_BUCKETS_PER_DIM);
  // Clamp the right edge · score=1.0 should map to bucket QD_BUCKETS_PER_DIM-1.
  return b === QD_BUCKETS_PER_DIM ? QD_BUCKETS_PER_DIM - 1 : b;
}

export function upsertQDScore(opts: {
  messageId: string;
  roomId: string;
  scores: QDScore;
}): QDArchiveRow {
  const now = Date.now();
  const ab = bucketize(opts.scores.abstractionScore);
  const tb = bucketize(opts.scores.timeScore);
  const sb = bucketize(opts.scores.stakeholderScore);
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO qd_archive " +
      "(message_id, room_id, abstraction_score, abstraction_bucket, time_score, time_bucket, stakeholder_score, stakeholder_bucket, scored_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      opts.messageId,
      opts.roomId,
      opts.scores.abstractionScore,
      ab,
      opts.scores.timeScore,
      tb,
      opts.scores.stakeholderScore,
      sb,
      now,
    );
  return {
    messageId: opts.messageId,
    roomId: opts.roomId,
    abstractionBucket: ab,
    timeBucket: tb,
    stakeholderBucket: sb,
    abstractionScore: opts.scores.abstractionScore,
    timeScore: opts.scores.timeScore,
    stakeholderScore: opts.scores.stakeholderScore,
    scoredAt: now,
  };
}

export function listQDForRoom(roomId: string): QDArchiveRow[] {
  const rows = getDb()
    .prepare(
      "SELECT message_id, room_id, abstraction_score, abstraction_bucket, time_score, time_bucket, stakeholder_score, stakeholder_bucket, scored_at " +
      "FROM qd_archive WHERE room_id = ?",
    )
    .all(roomId) as Row[];
  return rows.map(mapRow);
}

/** Compute the set of (a, t, s) bucket-triples filled in the room.
 *  Returns the set encoded as packed integers for fast set ops. */
export function filledCellsForRoom(roomId: string): Set<number> {
  const rows = getDb()
    .prepare(
      "SELECT DISTINCT abstraction_bucket AS ab, time_bucket AS tb, stakeholder_bucket AS sb " +
      "FROM qd_archive WHERE room_id = ?",
    )
    .all(roomId) as Array<{ ab: number; tb: number; sb: number }>;
  const set = new Set<number>();
  for (const r of rows) {
    set.add(packCell(r.ab, r.tb, r.sb));
  }
  return set;
}

export function packCell(a: number, t: number, s: number): number {
  // a, t, s each in [0, QD_BUCKETS_PER_DIM). Pack as base-N integer.
  return a * QD_BUCKETS_PER_DIM * QD_BUCKETS_PER_DIM + t * QD_BUCKETS_PER_DIM + s;
}

export function unpackCell(packed: number): { a: number; t: number; s: number } {
  const s = packed % QD_BUCKETS_PER_DIM;
  const t = Math.floor(packed / QD_BUCKETS_PER_DIM) % QD_BUCKETS_PER_DIM;
  const a = Math.floor(packed / (QD_BUCKETS_PER_DIM * QD_BUCKETS_PER_DIM));
  return { a, t, s };
}

/** Coverage report · returns { filled, total, pct }. The room-end
 *  card surfaces this as a divergence KPI ("this brainstorm covered
 *  N of 64 behavioral cells"). */
export function coverageForRoom(roomId: string): { filled: number; total: number; pct: number } {
  const filled = filledCellsForRoom(roomId).size;
  return {
    filled,
    total: QD_TOTAL_CELLS,
    pct: filled / QD_TOTAL_CELLS,
  };
}
