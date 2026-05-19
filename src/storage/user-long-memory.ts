/**
 * Long-term USER memory · the sanctuary table that the auto-dream
 * cycle never touches. Tag-shaped abstractions about the user
 * ("founder", "anti-jargon", "long-horizon-bias") live here and
 * only get displaced on direct contradiction.
 *
 * Single user per install · no user_id column. Single conceptual
 * owner (the chair-relationship) · no agent_id column.
 *
 * Read on every chair prompt build via `listActiveUserLongMemory`.
 * Written by the dream cycle's new Step 6 (chair-only) which
 * harvests durable patterns from chair `tier='long'` memories,
 * and by the chair-profile UI when the user manually edits or
 * deletes a row.
 */
import { getDb } from "./db.js";
import { newId } from "../utils/id.js";

export interface UserLongMemory {
  id: string;
  label: string;
  claim: string;
  confidence: number;
  /** Distinct rooms that have reinforced this fact. Bumped by the
   *  dream-step harvester when the same tag is re-confirmed. */
  provenanceRooms: number;
  /** Wall-clock ms of the last harvest that re-counted this tag.
   *  Null until first reinforcement after insert. */
  lastReinforcedAt: number | null;
  /** When set, this row has been replaced by a newer row on
   *  direct contradiction. The audit pointer survives so the
   *  user can review what was displaced. */
  supersededBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  label: string;
  claim: string;
  confidence: number;
  provenance_rooms: number;
  last_reinforced_at: number | null;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
}

const SELECT_COLS =
  "id, label, claim, confidence, provenance_rooms, last_reinforced_at, " +
  "superseded_by, created_at, updated_at";

const LABEL_MAX = 32;
const CLAIM_MAX = 240;

function mapRow(row: Row): UserLongMemory {
  return {
    id: row.id,
    label: row.label,
    claim: row.claim,
    confidence: row.confidence,
    provenanceRooms: row.provenance_rooms,
    lastReinforcedAt: row.last_reinforced_at,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** All active (non-superseded) rows · sorted most-reinforced
 *  first. Used by the chair prompt assembly + the chair-profile
 *  UI. Capped queries should not be needed (cap-30 soft-prune
 *  in the dream step keeps the count bounded). */
export function listActiveUserLongMemory(): UserLongMemory[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SELECT_COLS} FROM user_long_memory
        WHERE superseded_by IS NULL
        ORDER BY provenance_rooms DESC, last_reinforced_at DESC, created_at DESC`,
    )
    .all() as Row[];
  return rows.map(mapRow);
}

/** All rows including superseded · for audit / future "show
 *  forgotten" UI. Active first, then displaced. */
export function listAllUserLongMemory(): UserLongMemory[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SELECT_COLS} FROM user_long_memory
        ORDER BY superseded_by IS NULL DESC, provenance_rooms DESC, created_at DESC`,
    )
    .all() as Row[];
  return rows.map(mapRow);
}

export function getUserLongMemory(id: string): UserLongMemory | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM user_long_memory WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? mapRow(row) : null;
}

/** Count of active rows · used by the dream-step harvester to
 *  decide whether the cap-30 soft-prune needs to fire. */
export function countActiveUserLongMemory(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM user_long_memory WHERE superseded_by IS NULL`)
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

export interface InsertUserLongMemoryInput {
  label: string;
  claim: string;
  confidence?: number;
  provenanceRooms?: number;
}

export function insertUserLongMemory(input: InsertUserLongMemoryInput): UserLongMemory {
  const id = newId();
  const now = Date.now();
  const label = input.label.trim().slice(0, LABEL_MAX);
  const claim = input.claim.trim().slice(0, CLAIM_MAX);
  if (!label || !claim) throw new Error("user_long_memory · label and claim required");
  const confidence = Math.max(0, Math.min(1, Number(input.confidence ?? 0.7) || 0.7));
  const provenanceRooms = Math.max(1, Math.floor(Number(input.provenanceRooms ?? 1) || 1));
  getDb()
    .prepare(
      `INSERT INTO user_long_memory
        (id, label, claim, confidence, provenance_rooms, last_reinforced_at, superseded_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(id, label, claim, confidence, provenanceRooms, now, now);
  return getUserLongMemory(id)!;
}

export interface UpdateUserLongMemoryPatch {
  label?: string;
  claim?: string;
  confidence?: number;
}

/** Patch update · only the three editable fields. Returns the
 *  updated row, or null if the id doesn't exist. */
export function updateUserLongMemory(id: string, patch: UpdateUserLongMemoryPatch): UserLongMemory | null {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (typeof patch.label === "string") {
    const label = patch.label.trim().slice(0, LABEL_MAX);
    if (!label) throw new Error("user_long_memory · label cannot be empty");
    fields.push("label = ?");
    values.push(label);
  }
  if (typeof patch.claim === "string") {
    const claim = patch.claim.trim().slice(0, CLAIM_MAX);
    if (!claim) throw new Error("user_long_memory · claim cannot be empty");
    fields.push("claim = ?");
    values.push(claim);
  }
  if (typeof patch.confidence === "number" && Number.isFinite(patch.confidence)) {
    fields.push("confidence = ?");
    values.push(Math.max(0, Math.min(1, patch.confidence)));
  }
  if (fields.length === 0) return getUserLongMemory(id);
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  getDb()
    .prepare(`UPDATE user_long_memory SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getUserLongMemory(id);
}

/** Increment provenance_rooms + stamp last_reinforced_at. Called
 *  by the dream-step harvester when the LLM confirms an existing
 *  tag is still supported by the chair's latest memories. */
export function bumpUserLongMemoryProvenance(id: string): void {
  getDb()
    .prepare(
      `UPDATE user_long_memory
          SET provenance_rooms = provenance_rooms + 1,
              last_reinforced_at = ?,
              updated_at = ?
        WHERE id = ?`,
    )
    .run(Date.now(), Date.now(), id);
}

/** Mark an old tag superseded by a newer one · only fired on
 *  direct contradiction detected during harvest. Both ids must
 *  exist; this is a no-op if either is missing. */
export function markUserLongMemorySuperseded(oldId: string, newId: string): void {
  getDb()
    .prepare(`UPDATE user_long_memory SET superseded_by = ?, updated_at = ? WHERE id = ?`)
    .run(newId, Date.now(), oldId);
}

/** Hard delete · only called via the chair-profile UI's delete
 *  button + the cap-30 soft-prune. */
export function deleteUserLongMemory(id: string): void {
  getDb()
    .prepare(`DELETE FROM user_long_memory WHERE id = ?`)
    .run(id);
}

/** Cap-30 safety prune · runs at the tail of the dream-step
 *  harvester when active row count exceeds 30. Removes the
 *  lowest-scoring active rows (score = confidence + provenance/10)
 *  until back to 30. Returns the number of rows dropped. */
export function pruneActiveUserLongMemoryToCap(cap = 30): number {
  const rows = getDb()
    .prepare(
      `SELECT id, confidence, provenance_rooms FROM user_long_memory
        WHERE superseded_by IS NULL
        ORDER BY (confidence + (provenance_rooms / 10.0)) ASC,
                 last_reinforced_at ASC,
                 created_at ASC`,
    )
    .all() as Array<{ id: string; confidence: number; provenance_rooms: number }>;
  const over = rows.length - cap;
  if (over <= 0) return 0;
  const victims = rows.slice(0, over);
  const stmt = getDb().prepare(`DELETE FROM user_long_memory WHERE id = ?`);
  for (const v of victims) stmt.run(v.id);
  return victims.length;
}
