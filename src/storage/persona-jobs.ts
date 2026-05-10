/**
 * Storage layer for in-flight Full-persona builds.
 *
 * Each row in `agent_persona_jobs` represents one build attempt. Rows
 * persist across the build's lifetime and survive tab close / SSE
 * disconnect — when the user reopens the composer, the API can read
 * the `partial_json` blob to replay the last completed phase to a
 * fresh SSE subscriber.
 *
 * What we DON'T persist mid-LLM-call:
 *   · Token-level streaming progress (lives in memory only).
 *   · Per-search-round details (writing on every round = amplified DB
 *     traffic + SSE contention; round detail lives in events, not the
 *     row, and is regenerable by re-running the round).
 *
 * What we DO persist at phase boundaries:
 *   · `current_phase` + `progress_pct` so the UI can show real state.
 *   · `partial_json` accumulating each completed phase's output.
 *   · `prompt_tokens` + `output_tokens` so the eventual `Save` flush
 *     credits the new agent's `tokens_consumed` accurately.
 *
 * On server restart: every `running` row is bulk-marked `failed` (via
 * `markRunningJobsFailed`) — we can't resume a mid-LLM-call so the
 * user sees a retry CTA instead of a hung spinner.
 */
import { getDb } from "./db.js";
import type { PersonaSpec } from "./agents.js";

export type PersonaJobStatus = "running" | "done" | "failed" | "aborted";

export interface PersonaJob {
  id: string;
  description: string;
  mode: "full";
  status: PersonaJobStatus;
  /** 1-indexed; 1..7 across the seven phases. */
  currentPhase: number;
  /** 0..100. Monotonic within a job lifetime. */
  progressPct: number;
  /** Whatever phases have completed so far · used to render the
   *  build-result preview when the user lands on the save screen. */
  partial: Partial<PersonaSpec> | null;
  /** Set once the user clicks Save and an agent row is materialised
   *  from the partial. NULL until then. */
  agentId: string | null;
  promptTokens: number;
  outputTokens: number;
  startedAt: number;
  updatedAt: number;
  error: string | null;
}

interface PersonaJobRow {
  id: string;
  description: string;
  mode: string;
  status: string;
  current_phase: number;
  progress_pct: number;
  partial_json: string | null;
  agent_id: string | null;
  prompt_tokens: number;
  output_tokens: number;
  started_at: number;
  updated_at: number;
  error: string | null;
}

function mapRow(r: PersonaJobRow): PersonaJob {
  let partial: Partial<PersonaSpec> | null = null;
  if (r.partial_json) {
    try { partial = JSON.parse(r.partial_json) as Partial<PersonaSpec>; }
    catch { partial = null; }
  }
  return {
    id: r.id,
    description: r.description,
    mode: "full",
    status: (["running", "done", "failed", "aborted"].includes(r.status) ? r.status : "failed") as PersonaJobStatus,
    currentPhase: r.current_phase,
    progressPct: r.progress_pct,
    partial,
    agentId: r.agent_id,
    promptTokens: r.prompt_tokens,
    outputTokens: r.output_tokens,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    error: r.error,
  };
}

const COLS =
  "id, description, mode, status, current_phase, progress_pct, partial_json, " +
  "agent_id, prompt_tokens, output_tokens, started_at, updated_at, error";

export interface CreatePersonaJobInput {
  id: string;
  description: string;
}

export function createPersonaJob(input: CreatePersonaJobInput): PersonaJob {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO agent_persona_jobs
       (id, description, mode, status, current_phase, progress_pct, partial_json,
        agent_id, prompt_tokens, output_tokens, started_at, updated_at, error)
       VALUES (?, ?, 'full', 'running', 1, 0, NULL, NULL, 0, 0, ?, ?, NULL)`,
    )
    .run(input.id, input.description, now, now);
  return getPersonaJob(input.id)!;
}

export function getPersonaJob(id: string): PersonaJob | null {
  const row = getDb()
    .prepare(`SELECT ${COLS} FROM agent_persona_jobs WHERE id = ?`)
    .get(id) as PersonaJobRow | undefined;
  return row ? mapRow(row) : null;
}

export interface UpdatePersonaJobPatch {
  status?: PersonaJobStatus;
  currentPhase?: number;
  progressPct?: number;
  partial?: Partial<PersonaSpec>;
  agentId?: string;
  /** Increment counters · added to existing values, not replaced. */
  addPromptTokens?: number;
  addOutputTokens?: number;
  error?: string | null;
}

/** Apply a patch to a job row. Token counters use ADD semantics so
 *  the pipeline can call this once per phase without tracking the
 *  cumulative total itself. */
export function updatePersonaJob(id: string, patch: UpdatePersonaJobPatch): PersonaJob | null {
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
  if (patch.agentId !== undefined) {
    fields.push("agent_id = ?");
    values.push(patch.agentId);
  }
  if (typeof patch.addPromptTokens === "number" && patch.addPromptTokens > 0) {
    fields.push("prompt_tokens = prompt_tokens + ?");
    values.push(Math.round(patch.addPromptTokens));
  }
  if (typeof patch.addOutputTokens === "number" && patch.addOutputTokens > 0) {
    fields.push("output_tokens = output_tokens + ?");
    values.push(Math.round(patch.addOutputTokens));
  }
  if (patch.error !== undefined) {
    fields.push("error = ?");
    values.push(patch.error);
  }
  if (fields.length === 0) return getPersonaJob(id);
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  getDb()
    .prepare(`UPDATE agent_persona_jobs SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getPersonaJob(id);
}

/** Boot-time recovery · marks every row left in `running` state as
 *  `failed` with a clear reason. Mid-LLM-call resume isn't realistic
 *  (the upstream HTTP fetch is dead), so the cleanest UX is to stop
 *  pretending and let the user retry. Mirrors the `cleanupOrphaned-
 *  Streams` pattern from `src/storage/messages.ts` that the brief +
 *  message pipelines already use at boot. */
export function markRunningJobsFailed(): number {
  const r = getDb()
    .prepare(
      `UPDATE agent_persona_jobs
          SET status = 'failed',
              error = COALESCE(error, 'server restarted mid-build'),
              updated_at = ?
        WHERE status = 'running'`,
    )
    .run(Date.now());
  return r.changes;
}
