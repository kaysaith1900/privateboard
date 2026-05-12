/**
 * Storage layer for interest-driven topic recommendations.
 *
 *   topic_rec_jobs      · async job tracking · mirrors persona-jobs
 *   topic_rec_batches   · one row per "user clicked the button" run
 *   topic_recs          · the synthesised recommendations themselves
 *
 * The composer's "找你可能感兴趣的话题" trigger creates a job →
 * the pipeline writes a batch row at start → as the synthesis
 * pass produces topics it inserts topic_recs rows pointing at the
 * batch. The composer tray pages topic_recs newest-first.
 *
 * Boot-time recovery: every `running` job → `failed` so killed
 * pipelines surface a retry CTA instead of a hung spinner.
 */
import { getDb } from "./db.js";

export type TopicRecJobStatus = "running" | "done" | "failed" | "aborted";
export type TopicRecSource = "web" | "memory";

export interface TopicRecSnippet {
  title: string;
  url: string;
  description: string;
}

export interface TopicRecBatch {
  id: string;
  hasWeb: boolean;
  keywords: string[];
  createdAt: number;
}

export interface TopicRec {
  id: string;
  batchId: string;
  subject: string;
  rationale: string;
  source: TopicRecSource;
  /** Synthesiser-produced 1-2 word category label (e.g.
   *  "strategy", "product", "market"). Renders in the composer
   *  card's left-tag column. NULL on rows from before the tag
   *  column existed — caller falls back to `source`. */
  tag: string | null;
  seedContext: TopicRecSnippet[] | null;
  createdAt: number;
  openedRoomId: string | null;
}

export interface TopicRecJob {
  id: string;
  status: TopicRecJobStatus;
  currentPhase: number;
  progressPct: number;
  batchId: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

// ─── batches ──────────────────────────────────────────────────

interface BatchRow {
  id: string;
  has_web: number;
  keywords_json: string;
  created_at: number;
}

function mapBatch(r: BatchRow): TopicRecBatch {
  let keywords: string[] = [];
  try {
    const parsed = JSON.parse(r.keywords_json);
    if (Array.isArray(parsed)) {
      keywords = parsed.filter((k): k is string => typeof k === "string");
    }
  } catch { /* leave empty */ }
  return {
    id: r.id,
    hasWeb: r.has_web === 1,
    keywords,
    createdAt: r.created_at,
  };
}

export function createTopicRecBatch(input: { id: string; hasWeb: boolean; keywords: string[] }): TopicRecBatch {
  const now = Date.now();
  getDb()
    .prepare("INSERT INTO topic_rec_batches (id, has_web, keywords_json, created_at) VALUES (?, ?, ?, ?)")
    .run(input.id, input.hasWeb ? 1 : 0, JSON.stringify(input.keywords), now);
  return { id: input.id, hasWeb: input.hasWeb, keywords: input.keywords, createdAt: now };
}

export function getTopicRecBatch(id: string): TopicRecBatch | null {
  const row = getDb()
    .prepare("SELECT id, has_web, keywords_json, created_at FROM topic_rec_batches WHERE id = ?")
    .get(id) as BatchRow | undefined;
  return row ? mapBatch(row) : null;
}

// ─── recs ─────────────────────────────────────────────────────

interface RecRow {
  id: string;
  batch_id: string;
  subject: string;
  rationale: string;
  source: string;
  tag: string | null;
  seed_context_json: string | null;
  created_at: number;
  opened_room_id: string | null;
}

function mapRec(r: RecRow): TopicRec {
  let seedContext: TopicRecSnippet[] | null = null;
  if (r.seed_context_json) {
    try {
      const parsed = JSON.parse(r.seed_context_json);
      if (Array.isArray(parsed)) {
        seedContext = parsed
          .filter((s): s is TopicRecSnippet =>
            s && typeof s.title === "string" && typeof s.url === "string" && typeof s.description === "string",
          );
      }
    } catch { /* leave null */ }
  }
  return {
    id: r.id,
    batchId: r.batch_id,
    subject: r.subject,
    rationale: r.rationale,
    source: r.source === "web" ? "web" : "memory",
    tag: typeof r.tag === "string" && r.tag.trim().length > 0 ? r.tag.trim() : null,
    seedContext,
    createdAt: r.created_at,
    openedRoomId: r.opened_room_id,
  };
}

const REC_COLS =
  "id, batch_id, subject, rationale, source, tag, seed_context_json, created_at, opened_room_id";

export interface InsertTopicRecInput {
  id: string;
  batchId: string;
  subject: string;
  rationale: string;
  source: TopicRecSource;
  /** Optional 1-2 word category from the synthesiser. */
  tag: string | null;
  seedContext: TopicRecSnippet[] | null;
}

export function insertTopicRec(input: InsertTopicRecInput): TopicRec {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO topic_recs
         (id, batch_id, subject, rationale, source, tag, seed_context_json, created_at, opened_room_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      input.id,
      input.batchId,
      input.subject,
      input.rationale,
      input.source,
      input.tag,
      input.seedContext ? JSON.stringify(input.seedContext) : null,
      now,
    );
  return {
    id: input.id,
    batchId: input.batchId,
    subject: input.subject,
    rationale: input.rationale,
    source: input.source,
    tag: input.tag,
    seedContext: input.seedContext,
    createdAt: now,
    openedRoomId: null,
  };
}

export function getTopicRec(id: string): TopicRec | null {
  const row = getDb()
    .prepare(`SELECT ${REC_COLS} FROM topic_recs WHERE id = ?`)
    .get(id) as RecRow | undefined;
  return row ? mapRec(row) : null;
}

/** Cursor-paginated, newest-first. `cursor` is the createdAt
 *  of the last seen row · we return rows with createdAt < cursor.
 *  When cursor is null we return the freshest page. */
export function listTopicRecs(opts: { cursor: number | null; limit: number }): {
  items: TopicRec[];
  nextCursor: number | null;
} {
  const limit = Math.max(1, Math.min(100, opts.limit));
  const stmt = opts.cursor === null
    ? getDb().prepare(`SELECT ${REC_COLS} FROM topic_recs ORDER BY created_at DESC LIMIT ?`)
    : getDb().prepare(`SELECT ${REC_COLS} FROM topic_recs WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`);
  const rows = (opts.cursor === null ? stmt.all(limit) : stmt.all(opts.cursor, limit)) as RecRow[];
  const items = rows.map(mapRec);
  const nextCursor = items.length === limit ? items[items.length - 1].createdAt : null;
  return { items, nextCursor };
}

/** Stamp the rec with the room id the user convened from it.
 *  Used at room-create time when seedContext.topicRecId is set. */
export function markTopicRecOpened(recId: string, roomId: string): void {
  getDb()
    .prepare("UPDATE topic_recs SET opened_room_id = ? WHERE id = ?")
    .run(roomId, recId);
}

/** Wipe every topic_rec row. Called by the orchestrator right
 *  before inserting a new batch so the home composer always
 *  shows ONLY the latest 6 recommendations · no history,
 *  no pagination. Batch rows are left alone — they're cheap
 *  audit data carrying the keyword list that drove each
 *  generation. The FK on topic_recs.batch_id → topic_rec_batches
 *  is intact; we just orphan the older batches. */
export function clearAllTopicRecs(): number {
  const r = getDb()
    .prepare("DELETE FROM topic_recs")
    .run();
  return r.changes;
}

// ─── jobs ─────────────────────────────────────────────────────

interface JobRow {
  id: string;
  status: string;
  current_phase: number;
  progress_pct: number;
  batch_id: string | null;
  error: string | null;
  started_at: number;
  updated_at: number;
}

function mapJob(r: JobRow): TopicRecJob {
  const status: TopicRecJobStatus = ["running", "done", "failed", "aborted"].includes(r.status)
    ? (r.status as TopicRecJobStatus)
    : "failed";
  return {
    id: r.id,
    status,
    currentPhase: r.current_phase,
    progressPct: r.progress_pct,
    batchId: r.batch_id,
    error: r.error,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
  };
}

const JOB_COLS =
  "id, status, current_phase, progress_pct, batch_id, error, started_at, updated_at";

export function createTopicRecJob(id: string): TopicRecJob {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO topic_rec_jobs (id, status, current_phase, progress_pct, batch_id, error, started_at, updated_at)
       VALUES (?, 'running', 0, 0, NULL, NULL, ?, ?)`,
    )
    .run(id, now, now);
  return getTopicRecJob(id)!;
}

export function getTopicRecJob(id: string): TopicRecJob | null {
  const row = getDb()
    .prepare(`SELECT ${JOB_COLS} FROM topic_rec_jobs WHERE id = ?`)
    .get(id) as JobRow | undefined;
  return row ? mapJob(row) : null;
}

export interface UpdateTopicRecJobPatch {
  status?: TopicRecJobStatus;
  currentPhase?: number;
  progressPct?: number;
  batchId?: string;
  error?: string | null;
}

export function updateTopicRecJob(id: string, patch: UpdateTopicRecJobPatch): TopicRecJob | null {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined)        { fields.push("status = ?");        values.push(patch.status); }
  if (typeof patch.currentPhase === "number") {
    fields.push("current_phase = ?");
    values.push(patch.currentPhase);
  }
  if (typeof patch.progressPct === "number") {
    fields.push("progress_pct = ?");
    values.push(Math.max(0, Math.min(100, Math.round(patch.progressPct))));
  }
  if (patch.batchId !== undefined) {
    fields.push("batch_id = ?");
    values.push(patch.batchId);
  }
  if (patch.error !== undefined) {
    fields.push("error = ?");
    values.push(patch.error);
  }
  if (fields.length === 0) return getTopicRecJob(id);
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  getDb()
    .prepare(`UPDATE topic_rec_jobs SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getTopicRecJob(id);
}

/** Boot-time recovery · mirrors `markRunningJobsFailed` in
 *  `persona-jobs.ts`. The HTTP fetch + LLM stream that powered
 *  a `running` job died with the previous process, so the
 *  honest move is to mark it failed and let the user retry. */
export function markRunningTopicRecJobsFailed(): number {
  const r = getDb()
    .prepare(
      `UPDATE topic_rec_jobs
          SET status = 'failed',
              error = COALESCE(error, 'server restarted mid-build'),
              updated_at = ?
        WHERE status = 'running'`,
    )
    .run(Date.now());
  return r.changes;
}
