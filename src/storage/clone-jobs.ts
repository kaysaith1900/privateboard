/* clone-jobs · CRUD over the `clone_jobs` table (migration 054).
 *
 * Persists voice-clone progress so a process restart can mark
 * interrupted runs as `failed` (recovery sweep in boot) and so the
 * UI's minimize-to-pill flow can poll history on reload. Active
 * job state in this module's process is kept in-memory in
 * routes/voice-clone.ts; this file is the durable mirror.
 */
import { randomBytes } from "node:crypto";
import { getDb } from "./db.js";

export type CloneJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type CloneJobStage = "fetch" | "upload" | "clone";
/** Originally accepted "youtube" too, but YouTube's 2026 anti-bot
 *  wall blocked all automated stream URLs so the YouTube path was
 *  retired. We keep the column shape for forward-compatibility if a
 *  future source kind comes back (e.g. screen-recording capture). */
export type CloneJobSourceKind = "file";
export type CloneJobProvider = "minimax" | "elevenlabs";

export interface CloneJob {
  id: string;
  agentId: string;
  provider: CloneJobProvider;
  sourceKind: CloneJobSourceKind;
  sourceRef: string;
  label: string | null;
  status: CloneJobStatus;
  currentStage: CloneJobStage;
  pct: number;
  voiceId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  agent_id: string;
  provider: string;
  source_kind: string;
  source_ref: string;
  label: string | null;
  status: string;
  current_stage: string;
  pct: number;
  voice_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

function rowToJob(r: Row): CloneJob {
  return {
    id: r.id,
    agentId: r.agent_id,
    provider: r.provider as CloneJobProvider,
    sourceKind: r.source_kind as CloneJobSourceKind,
    sourceRef: r.source_ref,
    label: r.label,
    status: r.status as CloneJobStatus,
    currentStage: r.current_stage as CloneJobStage,
    pct: r.pct,
    voiceId: r.voice_id,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createCloneJob(input: {
  agentId: string;
  provider: CloneJobProvider;
  sourceKind: CloneJobSourceKind;
  sourceRef: string;
  label?: string | null;
}): CloneJob {
  const id = randomBytes(8).toString("hex");
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO clone_jobs (id, agent_id, provider, source_kind, source_ref, label,
                               status, current_stage, pct, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 'fetch', 0, ?, ?)`,
    )
    .run(id, input.agentId, input.provider, input.sourceKind, input.sourceRef, input.label ?? null, now, now);
  const row = getDb().prepare(`SELECT * FROM clone_jobs WHERE id = ?`).get(id) as Row;
  return rowToJob(row);
}

export function getCloneJob(id: string): CloneJob | null {
  const row = getDb().prepare(`SELECT * FROM clone_jobs WHERE id = ?`).get(id) as Row | undefined;
  return row ? rowToJob(row) : null;
}

export function findActiveJobForAgent(agentId: string): CloneJob | null {
  const row = getDb()
    .prepare(`SELECT * FROM clone_jobs WHERE agent_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`)
    .get(agentId) as Row | undefined;
  return row ? rowToJob(row) : null;
}

export function findAnyActiveJob(): CloneJob | null {
  const row = getDb()
    .prepare(`SELECT * FROM clone_jobs WHERE status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`)
    .get() as Row | undefined;
  return row ? rowToJob(row) : null;
}

export function updateCloneJobProgress(id: string, patch: {
  status?: CloneJobStatus;
  currentStage?: CloneJobStage;
  pct?: number;
  voiceId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): CloneJob | null {
  const cur = getCloneJob(id);
  if (!cur) return null;
  const next = {
    status: patch.status ?? cur.status,
    currentStage: patch.currentStage ?? cur.currentStage,
    pct: patch.pct ?? cur.pct,
    voiceId: patch.voiceId !== undefined ? patch.voiceId : cur.voiceId,
    errorCode: patch.errorCode !== undefined ? patch.errorCode : cur.errorCode,
    errorMessage: patch.errorMessage !== undefined ? patch.errorMessage : cur.errorMessage,
  };
  getDb()
    .prepare(
      `UPDATE clone_jobs SET status=?, current_stage=?, pct=?, voice_id=?, error_code=?, error_message=?, updated_at=?
       WHERE id=?`,
    )
    .run(
      next.status,
      next.currentStage,
      next.pct,
      next.voiceId,
      next.errorCode,
      next.errorMessage,
      Date.now(),
      id,
    );
  return getCloneJob(id);
}

/** Mark any 'queued' or 'running' jobs as 'failed' with a recovery
 *  error code. Called at boot — see CLAUDE.md "Mid-stream interrupts
 *  leave rooms in awaiting-clarify limbo" for the precedent. */
export function recoverStuckCloneJobs(): number {
  const r = getDb()
    .prepare(
      `UPDATE clone_jobs
       SET status = 'failed',
           error_code = COALESCE(error_code, 'interrupted'),
           error_message = COALESCE(error_message, 'Process restarted while clone was in progress.'),
           updated_at = ?
       WHERE status IN ('queued', 'running')`,
    )
    .run(Date.now());
  return r.changes;
}
