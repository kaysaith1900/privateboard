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
  /** Composer-picked house style · drives section vocabulary + voice
   *  register at write time. Defaults to `boardroom-default` (no
   *  overrides) for legacy briefs and for the safety-net composition. */
  houseStyle: string;
  /** Persisted Stage-1 per-director asset bundles · the LLM-extracted
   *  9-field structured material each director surfaced for this brief
   *  (claims / evidence / tensions / assumptions / risks /
   *  opportunities / actions / quotes / openQuestions). Re-used by
   *  follow-up rooms as part of the prior-context block in director
   *  system prompts. NULL when the extract stage hasn't filled it
   *  yet (placeholder rows mid-pipeline) or when extract failed. */
  assets: BriefAssets[] | null;
  /** Output mode · drives which renderer + which Stage 2/3 path runs.
   *  · 'research-note' (default · the existing markdown report rendered
   *    by report.html through the spine system)
   *  · 'bento' (single-page infographic · BentoScaffold lives in
   *    body_json, rendered by bento.html · spine / components / house
   *    style are unused for this mode) */
  mode: BriefMode;
  createdAt: number;
}

export type BriefMode = "research-note" | "bento";

/** Per-director asset bundle persisted alongside a brief · mirrors
 *  the `DirectorAssets` shape Stage 1 produces. Storing it lets a
 *  follow-up room read the prior session's structured material
 *  without re-running the extract pass. The storage layer keeps a
 *  parallel local definition (rather than importing from
 *  ai/prompts/brief-stages) to avoid the storage → AI cycle. */
export interface BriefAssets {
  directorId: string;
  directorName: string;
  claims: { text: string; lens: string; sources: number[]; confidence?: string }[];
  evidence: { text: string; kind: string; sources: number[] }[];
  tensions: { text: string; with: string[]; sources: number[] }[];
  assumptions: { text: string; falsifier?: string; sources: number[] }[];
  risks: { text: string; severity?: string; sources: number[] }[];
  opportunities: { text: string; sources: number[] }[];
  actions: { text: string; owner?: string; horizon?: string; sources: number[] }[];
  quotes: { text: string; sources: number[] }[];
  openQuestions: { text: string; priority: string; sources: number[] }[];
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
  house_style: string;
  assets_json: string | null;
  mode: string;
  created_at: number;
}

const COLS =
  "id, room_id, style, title, body_md, body_json, supplement, " +
  "spine, components_json, composer_rationale, subject_type, " +
  "house_style, assets_json, mode, created_at";

/** Parse the persisted assets JSON into typed bundles. Tolerant: any
 *  malformed entry / field is dropped silently and falls through to
 *  empty array (rather than failing the whole brief read). Returns
 *  null only when the column itself is null / unparseable JSON. */
function parseAssets(json: string | null | undefined): BriefAssets[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: BriefAssets[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const directorId = typeof e.directorId === "string" ? e.directorId : "";
      const directorName = typeof e.directorName === "string" ? e.directorName : "";
      if (!directorId || !directorName) continue;
      out.push({
        directorId,
        directorName,
        claims: parseClaimList(e.claims),
        evidence: parseEvidenceList(e.evidence),
        tensions: parseTensionList(e.tensions),
        assumptions: parseAssumptionList(e.assumptions),
        risks: parseRiskList(e.risks),
        opportunities: parseSimpleList(e.opportunities),
        actions: parseActionList(e.actions),
        quotes: parseSimpleList(e.quotes),
        openQuestions: parseOpenQuestionList(e.openQuestions),
      });
    }
    return out;
  } catch {
    return null;
  }
}

function parseSourceArr(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
}

function parseStringArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
}

function parseClaimList(v: unknown): BriefAssets["claims"] {
  if (!Array.isArray(v)) return [];
  const out: BriefAssets["claims"] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text : "";
    const lens = typeof o.lens === "string" ? o.lens : "";
    if (!text || !lens) continue;
    const entry: BriefAssets["claims"][number] = { text, lens, sources: parseSourceArr(o.sources) };
    if (typeof o.confidence === "string") entry.confidence = o.confidence;
    out.push(entry);
  }
  return out;
}

function parseEvidenceList(v: unknown): BriefAssets["evidence"] {
  if (!Array.isArray(v)) return [];
  const out: BriefAssets["evidence"] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text : "";
    const kind = typeof o.kind === "string" ? o.kind : "";
    if (!text || !kind) continue;
    out.push({ text, kind, sources: parseSourceArr(o.sources) });
  }
  return out;
}

function parseTensionList(v: unknown): BriefAssets["tensions"] {
  if (!Array.isArray(v)) return [];
  const out: BriefAssets["tensions"] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text : "";
    if (!text) continue;
    out.push({ text, with: parseStringArr(o.with), sources: parseSourceArr(o.sources) });
  }
  return out;
}

function parseAssumptionList(v: unknown): BriefAssets["assumptions"] {
  if (!Array.isArray(v)) return [];
  const out: BriefAssets["assumptions"] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text : "";
    if (!text) continue;
    const entry: BriefAssets["assumptions"][number] = { text, sources: parseSourceArr(o.sources) };
    if (typeof o.falsifier === "string") entry.falsifier = o.falsifier;
    out.push(entry);
  }
  return out;
}

function parseRiskList(v: unknown): BriefAssets["risks"] {
  if (!Array.isArray(v)) return [];
  const out: BriefAssets["risks"] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text : "";
    if (!text) continue;
    const entry: BriefAssets["risks"][number] = { text, sources: parseSourceArr(o.sources) };
    if (typeof o.severity === "string") entry.severity = o.severity;
    out.push(entry);
  }
  return out;
}

function parseSimpleList(v: unknown): { text: string; sources: number[] }[] {
  if (!Array.isArray(v)) return [];
  const out: { text: string; sources: number[] }[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text : "";
    if (!text) continue;
    out.push({ text, sources: parseSourceArr(o.sources) });
  }
  return out;
}

function parseActionList(v: unknown): BriefAssets["actions"] {
  if (!Array.isArray(v)) return [];
  const out: BriefAssets["actions"] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text : "";
    if (!text) continue;
    const entry: BriefAssets["actions"][number] = { text, sources: parseSourceArr(o.sources) };
    if (typeof o.owner === "string") entry.owner = o.owner;
    if (typeof o.horizon === "string") entry.horizon = o.horizon;
    out.push(entry);
  }
  return out;
}

function parseOpenQuestionList(v: unknown): BriefAssets["openQuestions"] {
  if (!Array.isArray(v)) return [];
  const out: BriefAssets["openQuestions"] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text : "";
    const priority = typeof o.priority === "string" ? o.priority : "";
    if (!text || !priority) continue;
    out.push({ text, priority, sources: parseSourceArr(o.sources) });
  }
  return out;
}

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
    houseStyle: row.house_style || "boardroom-default",
    assets: parseAssets(row.assets_json),
    mode: row.mode === "bento" ? "bento" : "research-note",
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
              b.composer_rationale, b.subject_type, b.house_style, b.assets_json, b.mode, b.created_at,
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
  /** House-style preset slug. Defaults to `boardroom-default` when
   *  omitted (no section-label overrides, neutral voice). */
  houseStyle?: string;
  /** Output mode · 'research-note' (default · markdown report rendered
   *  by report.html) or 'bento' (single-page infographic rendered by
   *  bento.html with BentoScaffold persisted in body_json). */
  mode?: BriefMode;
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
  const houseStyle = b.houseStyle && b.houseStyle.trim() ? b.houseStyle.trim() : "boardroom-default";
  const mode: BriefMode = b.mode === "bento" ? "bento" : "research-note";
  db.prepare(
    `INSERT INTO briefs (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    houseStyle,
    null,            // assets_json · filled later by updateBriefAssets
    mode,
    now,
  );
  return getBrief(id)!;
}

/** Persist Stage-1 per-director asset bundles on the brief row · called
 *  by the brief orchestrator after Stage 1 succeeds. Stored as JSON so
 *  follow-up rooms can re-use the structured material as prior context
 *  without re-running the extract pass. */
export function updateBriefAssets(id: string, assets: BriefAssets[]): void {
  const json = JSON.stringify(assets);
  getDb().prepare("UPDATE briefs SET assets_json = ? WHERE id = ?").run(json, id);
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
    houseStyle?: string;
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
  if (fields.houseStyle !== undefined) {
    sets.push("house_style = ?");
    vals.push(fields.houseStyle);
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
 * Update only the brief's title. Used by the orchestrator to set an
 * interim claim-style title from `scaffold.bottomLine.judgement` as
 * soon as Stage 2 returns — so a reader who opens `report.html` while
 * Stage 3 is streaming sees the proper title instead of the room's
 * initial question (the placeholder set at insert time).
 */
export function setBriefTitle(id: string, title: string): void {
  getDb().prepare("UPDATE briefs SET title = ? WHERE id = ?").run(title, id);
}

/**
 * Persist a structured JSON body on the brief row. Used by bento mode
 * to save the BentoScaffold (the complete output for that mode lives
 * here · body_md stays empty for bento briefs). The `title` is set
 * atomically alongside, so the bento's headline becomes the brief's
 * card title without a second roundtrip.
 */
export function updateBriefBodyJson(id: string, bodyJson: unknown, title?: string): void {
  const json = JSON.stringify(bodyJson);
  if (title !== undefined) {
    getDb()
      .prepare("UPDATE briefs SET body_json = ?, title = ? WHERE id = ?")
      .run(json, title, id);
  } else {
    getDb().prepare("UPDATE briefs SET body_json = ? WHERE id = ?").run(json, id);
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

/** Count of briefs that have a non-empty body · drives the All Reports
 *  sidebar badge. Mirrors `countNotes()` in storage/notes.ts: cheap
 *  SELECT COUNT(*), one row, no joins. Excludes empty placeholders so
 *  the count matches what the All Reports page actually renders.
 *  Mode-aware · research-note briefs land their body in body_md
 *  (markdown); bento briefs land theirs in body_json (BentoScaffold)
 *  and leave body_md empty. The original count filtered on body_md
 *  alone, which silently dropped bento briefs from the badge / list.
 *  This version counts a brief as present when EITHER body channel
 *  has content. */
export function countBriefs(): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS c FROM briefs " +
      "WHERE (body_md IS NOT NULL AND TRIM(body_md) != '') " +
      "   OR (body_json IS NOT NULL AND TRIM(body_json) != '' AND TRIM(body_json) != 'null')",
    )
    .get() as { c: number };
  return row.c ?? 0;
}
