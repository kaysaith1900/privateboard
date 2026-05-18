/**
 * Negative-space memory storage · Layer 3.2 of the divergence stack.
 *
 * Persists "angles the room raised but did NOT develop" so future
 * rounds can be prompted with positive-space breadcrumbs (the
 * UNEXPLORED ANGLES block in prompt.ts).
 */
import { newId } from "../utils/id.js";

import { getDb } from "./db.js";

export interface NegativeSpaceAngle {
  id: string;
  roomId: string;
  roundNum: number;
  angle: string;
  createdAt: number;
  consumed: boolean;
}

interface Row {
  id: string;
  room_id: string;
  round_num: number;
  angle: string;
  created_at: number;
  consumed: number;
}

function mapRow(r: Row): NegativeSpaceAngle {
  return {
    id: r.id,
    roomId: r.room_id,
    roundNum: r.round_num,
    angle: r.angle,
    createdAt: r.created_at,
    consumed: r.consumed === 1,
  };
}

/** Insert a batch of angles for a round. Idempotent · re-running for
 *  the same room+round just appends more rows (the post-round
 *  extractor is normally invoked once, but a duplicate call is harmless). */
export function insertNegativeSpaceAngles(
  roomId: string,
  roundNum: number,
  angles: string[],
): void {
  if (angles.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    "INSERT INTO negative_space (id, room_id, round_num, angle, created_at, consumed) VALUES (?, ?, ?, ?, ?, 0)",
  );
  const now = Date.now();
  const tx = db.transaction((rows: { id: string; angle: string }[]) => {
    for (const r of rows) {
      stmt.run(r.id, roomId, roundNum, r.angle, now);
    }
  });
  tx(angles
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && a.length < 280)
    .map((a) => ({ id: newId(), angle: a }))
  );
}

/** Read the top-N most recent, unconsumed angles for the room.
 *  Used by streamSpeakerTurn to populate buildDirectorMessages'
 *  `unexploredAngles` field. */
export function getRecentUnexploredAngles(
  roomId: string,
  limit = 5,
): NegativeSpaceAngle[] {
  const rows = getDb()
    .prepare(
      "SELECT id, room_id, round_num, angle, created_at, consumed " +
      "FROM negative_space " +
      "WHERE room_id = ? AND consumed = 0 " +
      "ORDER BY created_at DESC LIMIT ?",
    )
    .all(roomId, Math.max(1, Math.floor(limit))) as Row[];
  return rows.map(mapRow);
}

/** Mark angles as consumed once they've been injected into a director
 *  prompt OR engaged with by the room. Best-effort cleanup so
 *  subsequent rounds don't keep re-suggesting the same angle. */
export function markAnglesConsumed(angleIds: string[]): void {
  if (angleIds.length === 0) return;
  const db = getDb();
  const stmt = db.prepare("UPDATE negative_space SET consumed = 1 WHERE id = ?");
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(id);
  });
  tx(angleIds);
}
