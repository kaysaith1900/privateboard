/**
 * Storage layer for in-flight voice-distill builds.
 *
 * One row per attempt at the public-video → cloned-voice pipeline.
 * Shape mirrors `agent_persona_jobs` (src/storage/persona-jobs.ts) so
 * the boot-time recovery + SSE replay glue lifts straight across.
 *
 * Lifecycle:
 *   running  -> done       · pipeline finished, voice_id materialised
 *   running  -> failed     · any step errored, see `error` column
 *   running  -> aborted    · user cancelled OR wall-clock OR boot recovery
 */
import { getDb } from "./db.js";

export type VoiceDistillJobStatus = "running" | "done" | "failed" | "aborted";

/** Per-phase partial outputs the orchestrator accumulates as it runs.
 *  Persisted as JSON in `partial_json` so the build-log preview can
 *  show what completed even before the row flips to `done`. */
export interface VoiceDistillPartial {
  /** Resolved URL when the caller didn't supply one and the orchestrator
   *  used the auto-search phase to pick a candidate. */
  resolvedUrl?: string;
  /** Title of the auto-picked candidate (for UI display). */
  resolvedTitle?: string;
  rawAudioPath?: string;
  normalizedAudioPath?: string;
  durationSec?: number;
  transcriptSegmentCount?: number;
  identifiedSegments?: Array<{ start: number; end: number }>;
  clipPath?: string;
  clipDurationSec?: number;
  fileId?: number;
  voiceId?: string;
  voiceClonedAt?: number;
  /** Free-form phase status hints rendered as a build-log timeline
   *  on the frontend. Each event is append-only · the orchestrator
   *  writes once per phase boundary. */
  events?: VoiceDistillEvent[];
}

export interface VoiceDistillEvent {
  kind:
    | "phase-start"
    | "phase-end"
    | "warning"
    | "fallback"
    | "note";
  ts: number;
  phase: number;
  label: string;
  detail?: string;
}

export interface VoiceDistillJob {
  id: string;
  videoUrl: string;
  celebrity: string;
  agentId: string | null;
  status: VoiceDistillJobStatus;
  /** 1..9 across the nine pipeline steps. */
  currentPhase: number;
  progressPct: number;
  partial: VoiceDistillPartial | null;
  voiceId: string | null;
  credentialId: string | null;
  startedAt: number;
  updatedAt: number;
  error: string | null;
}

interface VoiceDistillJobRow {
  id: string;
  video_url: string;
  celebrity: string;
  agent_id: string | null;
  status: string;
  current_phase: number;
  progress_pct: number;
  partial_json: string | null;
  voice_id: string | null;
  credential_id: string | null;
  started_at: number;
  updated_at: number;
  error: string | null;
}

function mapRow(r: VoiceDistillJobRow): VoiceDistillJob {
  let partial: VoiceDistillPartial | null = null;
  if (r.partial_json) {
    try {
      partial = JSON.parse(r.partial_json) as VoiceDistillPartial;
    } catch {
      partial = null;
    }
  }
  const status: VoiceDistillJobStatus = (
    ["running", "done", "failed", "aborted"].includes(r.status)
      ? r.status
      : "failed"
  ) as VoiceDistillJobStatus;
  return {
    id: r.id,
    videoUrl: r.video_url,
    celebrity: r.celebrity,
    agentId: r.agent_id,
    status,
    currentPhase: r.current_phase,
    progressPct: r.progress_pct,
    partial,
    voiceId: r.voice_id,
    credentialId: r.credential_id,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    error: r.error,
  };
}

const COLS =
  "id, video_url, celebrity, agent_id, status, current_phase, progress_pct, " +
  "partial_json, voice_id, credential_id, started_at, updated_at, error";

export interface CreateVoiceDistillJobInput {
  id: string;
  videoUrl: string;
  celebrity: string;
  agentId?: string | null;
}

export function createVoiceDistillJob(input: CreateVoiceDistillJobInput): VoiceDistillJob {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO voice_distill_jobs
       (id, video_url, celebrity, agent_id, status, current_phase, progress_pct,
        partial_json, voice_id, credential_id, started_at, updated_at, error)
       VALUES (?, ?, ?, ?, 'running', 1, 0, NULL, NULL, NULL, ?, ?, NULL)`,
    )
    .run(
      input.id,
      input.videoUrl,
      input.celebrity,
      input.agentId ?? null,
      now,
      now,
    );
  return getVoiceDistillJob(input.id)!;
}

export function getVoiceDistillJob(id: string): VoiceDistillJob | null {
  const row = getDb()
    .prepare(`SELECT ${COLS} FROM voice_distill_jobs WHERE id = ?`)
    .get(id) as VoiceDistillJobRow | undefined;
  return row ? mapRow(row) : null;
}

export interface UpdateVoiceDistillJobPatch {
  status?: VoiceDistillJobStatus;
  currentPhase?: number;
  progressPct?: number;
  partial?: VoiceDistillPartial;
  voiceId?: string;
  credentialId?: string;
  error?: string | null;
}

export function updateVoiceDistillJob(
  id: string,
  patch: UpdateVoiceDistillJobPatch,
): VoiceDistillJob | null {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
  }
  if (typeof patch.currentPhase === "number") {
    fields.push("current_phase = ?");
    values.push(patch.currentPhase);
  }
  if (typeof patch.progressPct === "number") {
    fields.push("progress_pct = ?");
    values.push(Math.max(0, Math.min(100, Math.round(patch.progressPct))));
  }
  if (patch.partial !== undefined) {
    fields.push("partial_json = ?");
    values.push(JSON.stringify(patch.partial));
  }
  if (patch.voiceId !== undefined) {
    fields.push("voice_id = ?");
    values.push(patch.voiceId);
  }
  if (patch.credentialId !== undefined) {
    fields.push("credential_id = ?");
    values.push(patch.credentialId);
  }
  if (patch.error !== undefined) {
    fields.push("error = ?");
    values.push(patch.error);
  }
  if (fields.length === 0) return getVoiceDistillJob(id);
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  getDb()
    .prepare(`UPDATE voice_distill_jobs SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getVoiceDistillJob(id);
}

/** Boot-time recovery · marks every row left in `running` state as
 *  `failed` with a clear reason. Mid-pipeline resume isn't realistic
 *  (upstream HTTP fetch / yt-dlp process is dead), so the cleanest UX
 *  is to stop pretending and let the user retry. Mirrors persona-jobs
 *  `markRunningJobsFailed`. */
export function markRunningVoiceDistillJobsFailed(): number {
  const r = getDb()
    .prepare(
      `UPDATE voice_distill_jobs
          SET status = 'failed',
              error = COALESCE(error, 'server restarted mid-distill'),
              updated_at = ?
        WHERE status = 'running'`,
    )
    .run(Date.now());
  return r.changes;
}

/** List the N most recently started jobs · used by the UI to surface
 *  history on the agent composer. */
export function listRecentVoiceDistillJobs(limit = 20): VoiceDistillJob[] {
  const rows = getDb()
    .prepare(
      `SELECT ${COLS} FROM voice_distill_jobs ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as VoiceDistillJobRow[];
  return rows.map(mapRow);
}
