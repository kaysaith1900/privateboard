/** Briefs · the room's filed deliverables. A room can have multiple
 *  briefs: the first is generated on adjourn; each "Add a perspective"
 *  regeneration appends a new row. Old briefs are preserved. */
import { newId } from "../utils/id.js";

import { getDb } from "./db.js";

/** A single component the composer picked, with its render order. */
export interface BriefComponent {
  kind: string;
  order: number;
}

export interface Brief {
  id: string;
  roomId: string;
  style: string;
  title: string;
  bodyMd: string;
  bodyJson: unknown | null;
  /** The supplementary perspective the user supplied when this brief
   *  was a regeneration. NULL for the first / canonical brief. */
  supplement: string | null;
  /** Renderer key picked by the composer (v1: `boardroom-dark`). Legacy
   *  rows default to `boardroom-dark` via the migration. */
  spine: string;
  /** Components the composer picked, in render order. Empty array =
   *  legacy / no composer ran (renderer falls back to today's static
   *  12-section layout). */
  components: BriefComponent[];
  /** One-line composer rationale, surfaced on hover of the SPINE tag. */
  composerRationale: string | null;
  /** Coarse subject classification (e.g. `investment-judgement`). */
  subjectType: string | null;
  createdAt: number;
}

interface Row {
  id: string;
  room_id: string;
  style: string;
  title: string;
  body_md: string;
  body_json: string | null;
  supplement: string | null;
  spine: string;
  components_json: string;
  composer_rationale: string | null;
  subject_type: string | null;
  created_at: number;
}

const COLS =
  "id, room_id, style, title, body_md, body_json, supplement, " +
  "spine, components_json, composer_rationale, subject_type, created_at";

function parseComponents(json: string | null | undefined): BriefComponent[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: BriefComponent[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.kind !== "string" || !e.kind.trim()) continue;
      const order = typeof e.order === "number" && Number.isFinite(e.order)
        ? e.order
        : out.length;
      out.push({ kind: e.kind, order });
    }
    return out;
  } catch {
    return [];
  }
}

function mapRow(row: Row): Brief {
  return {
    id: row.id,
    roomId: row.room_id,
    style: row.style,
    title: row.title,
    bodyMd: row.body_md,
    bodyJson: row.body_json ? (JSON.parse(row.body_json) as unknown) : null,
    supplement: row.supplement,
    spine: row.spine || "boardroom-dark",
    components: parseComponents(row.components_json),
    composerRationale: row.composer_rationale,
    subjectType: row.subject_type,
    createdAt: row.created_at,
  };
}

export function getBrief(id: string): Brief | null {
  const row = getDb().prepare(`SELECT ${COLS} FROM briefs WHERE id = ?`).get(id) as Row | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Latest brief for a room — newest by created_at. Returns null if the
 * room has none. Existing callers that asked for "the brief" of a room
 * keep working through this; clients that need history use
 * listBriefsForRoom.
 */
export function getBriefByRoom(roomId: string): Brief | null {
  const row = getDb()
    .prepare(`SELECT ${COLS} FROM briefs WHERE room_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(roomId) as Row | undefined;
  return row ? mapRow(row) : null;
}

/**
 * All briefs for a room · newest first. Used by the brief-card tab
 * strip and the report viewer when navigating between regenerations.
 */
export function listBriefsForRoom(roomId: string): Brief[] {
  const rows = getDb()
    .prepare(`SELECT ${COLS} FROM briefs WHERE room_id = ? ORDER BY created_at DESC`)
    .all(roomId) as Row[];
  return rows.map(mapRow);
}

/** Brief + the parent room's display fields, joined at read time so
 *  the All Reports page can render a card without a follow-up
 *  /api/rooms/:id call per brief. */
export interface BriefWithRoom extends Brief {
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

/**
 * Every brief across every room · newest first. Used by /api/briefs
 * (the All Reports view in the sidebar). Joins the parent room's
 * name/subject/number/status so each card has its full context in a
 * single response. The body_md and body_json columns are intentionally
 * INCLUDED so cards can preview the Bottom-Line judgement; client trims
 * what it doesn't render.
 */
export function listAllBriefs(): BriefWithRoom[] {
  const rows = getDb()
    .prepare(
      `SELECT b.id, b.room_id, b.style, b.title, b.body_md, b.body_json,
              b.supplement, b.spine, b.components_json,
              b.composer_rationale, b.subject_type, b.created_at,
              r.name AS room_name, r.subject AS room_subject,
              r.number AS room_number, r.status AS room_status
         FROM briefs b
         JOIN rooms r ON r.id = b.room_id
         ORDER BY b.created_at DESC`,
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

export interface BriefInsert {
  roomId: string;
  style: string;
  title: string;
  bodyMd: string;
  bodyJson?: unknown;
  /** Optional supplementary perspective the user requested. NULL when
   *  this is the room's first brief. */
  supplement?: string | null;
  /** Composer's spine pick. Defaults to `boardroom-dark` when omitted. */
  spine?: string;
  /** Composer's component picks, in order. Empty array (the default)
   *  means "legacy / no composer ran" — renderer falls back to the
   *  static layout. */
  components?: BriefComponent[];
  composerRationale?: string | null;
  subjectType?: string | null;
}

/**
 * Insert a new brief row. Always inserts (no upsert) — multiple briefs
 * per room is the v2 model. The orchestrator inserts an empty
 * placeholder up-front and streams body/title updates via
 * updateBriefBody as tokens arrive. Composer fields are usually
 * unknown at placeholder-insert time and filled in later via
 * updateBriefCompose once Stage 1.5 returns.
 */
export function insertBrief(b: BriefInsert): Brief {
  const db = getDb();
  const id = newId();
  const now = Date.now();
  const bodyJson = b.bodyJson === undefined ? null : JSON.stringify(b.bodyJson);
  const supplement = b.supplement && b.supplement.trim() ? b.supplement.trim() : null;
  const spine = b.spine && b.spine.trim() ? b.spine.trim() : "boardroom-dark";
  const components = JSON.stringify(b.components ?? []);
  const composerRationale =
    b.composerRationale && b.composerRationale.trim() ? b.composerRationale.trim() : null;
  const subjectType = b.subjectType && b.subjectType.trim() ? b.subjectType.trim() : null;
  db.prepare(
    `INSERT INTO briefs (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    b.roomId,
    b.style,
    b.title,
    b.bodyMd,
    bodyJson,
    supplement,
    spine,
    components,
    composerRationale,
    subjectType,
    now,
  );
  return getBrief(id)!;
}

/**
 * Persist composer output discovered after the placeholder was created.
 * Called once Stage 1.5 returns, before Stage 2 starts. Keeps the
 * placeholder row's id stable — the UI's brief-card already binds to it.
 */
export function updateBriefCompose(
  id: string,
  fields: {
    spine?: string;
    components?: BriefComponent[];
    composerRationale?: string | null;
    subjectType?: string | null;
  },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.spine !== undefined) {
    sets.push("spine = ?");
    vals.push(fields.spine);
  }
  if (fields.components !== undefined) {
    sets.push("components_json = ?");
    vals.push(JSON.stringify(fields.components));
  }
  if (fields.composerRationale !== undefined) {
    sets.push("composer_rationale = ?");
    vals.push(fields.composerRationale);
  }
  if (fields.subjectType !== undefined) {
    sets.push("subject_type = ?");
    vals.push(fields.subjectType);
  }
  if (!sets.length) return;
  vals.push(id);
  getDb()
    .prepare(`UPDATE briefs SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);
}

export function updateBriefBody(id: string, bodyMd: string, title?: string): void {
  if (title !== undefined) {
    getDb()
      .prepare("UPDATE briefs SET body_md = ?, title = ? WHERE id = ?")
      .run(bodyMd, title, id);
  } else {
    getDb().prepare("UPDATE briefs SET body_md = ? WHERE id = ?").run(bodyMd, id);
  }
}

/**
 * Permanently delete a brief by id. Returns true if a row was removed.
 * The on-disk markdown export at ~/.boardroom/briefs/{id}.md is the
 * caller's concern (route-level cleanup); this only touches SQLite.
 */
export function deleteBrief(id: string): boolean {
  const r = getDb().prepare("DELETE FROM briefs WHERE id = ?").run(id);
  return r.changes > 0;
}
