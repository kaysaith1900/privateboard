/**
 * Agent long-term memory · per-agent notes about the USER that flow
 * across every room the agent participates in. Read on every prompt
 * build via `listMemoriesForAgent`; written at room adjourn by the
 * extraction step in the orchestrator (skipped when room.incognito).
 *
 * Each agent (directors + chair) keeps an independent set so the
 * multi-perspective product stays distinct — Skeptic and User-Empathy
 * accumulate different reads on the same user.
 */
import { getDb } from "./db.js";
import { newId } from "../utils/id.js";

export type MemoryKind = "fact" | "observation" | "preference" | "goal";
export type MemorySource = "extracted" | "user_added" | "user_pinned";
/** Memory tier (migration 026) · `short` is the default landing tier
 *  for fresh extractions; the dream cycle promotes memories that
 *  have been reinforced across multiple rooms to `long`, and
 *  retrieval treats long-tier as always-injected (no recency cap). */
export type MemoryTier = "short" | "long";

export interface AgentMemory {
  id: string;
  agentId: string;
  content: string;
  kind: MemoryKind;
  source: MemorySource;
  /** Room the memory was distilled from. Null for manually-added notes. */
  sourceRoom: string | null;
  confidence: number;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** Tier · 'short' (recency-capped) vs 'long' (always-injected). */
  tier: MemoryTier;
  /** How many prompts this memory has been injected into. Bumped by
   *  `bumpUsage`; consumed by the dream cycle's decay heuristic. */
  usageCount: number;
  /** Wall-clock of the last injection · null until first use. */
  lastUsedAt: number | null;
  /** When set, this row has been replaced by another memory and is
   *  no longer injected into prompts. Audit pointer survives so the
   *  user can review what was forgotten / merged. */
  supersededBy: string | null;
  /** When this memory was synthesised from a cluster, JSON array of
   *  source memory ids (null for native rows). Lets the UI walk
   *  back from a `[stable]` long-tier memory to its provenance. */
  consolidatedFrom: string[] | null;
  /** Number of distinct rooms that reinforced this fact. Phase 2's
   *  promote-to-long heuristic uses this — memories reinforced
   *  across 3+ rooms tend to be stable preferences vs one-off
   *  observations. Defaults to 1 for native rows; merged rows sum
   *  their sources' counts. */
  provenanceRooms: number;
}

/** Audit row for one dream cycle — written by `recordDream`. */
export interface DreamLog {
  id: string;
  agentId: string;
  startedAt: number;
  finishedAt: number | null;
  beforeCount: number;
  afterCount: number | null;
  decayed: number;
  merged: number;
  promoted: number;
  superseded: number;
  notes: string | null;
}

interface Row {
  id: string;
  agent_id: string;
  content: string;
  kind: string;
  source: string;
  source_room: string | null;
  confidence: number;
  pinned: number;
  created_at: number;
  updated_at: number;
  tier: string;
  usage_count: number;
  last_used_at: number | null;
  superseded_by: string | null;
  consolidated_from: string | null;
  provenance_rooms: number;
}

const SELECT_COLS =
  "id, agent_id, content, kind, source, source_room, confidence, pinned, " +
  "created_at, updated_at, tier, usage_count, last_used_at, superseded_by, " +
  "consolidated_from, provenance_rooms";

const ALLOWED_KINDS: ReadonlySet<MemoryKind> = new Set(["fact", "observation", "preference", "goal"]);
const ALLOWED_SOURCES: ReadonlySet<MemorySource> = new Set(["extracted", "user_added", "user_pinned"]);

const ALLOWED_TIERS: ReadonlySet<MemoryTier> = new Set(["short", "long"]);

function mapRow(row: Row): AgentMemory {
  const kind: MemoryKind = ALLOWED_KINDS.has(row.kind as MemoryKind) ? (row.kind as MemoryKind) : "fact";
  const source: MemorySource = ALLOWED_SOURCES.has(row.source as MemorySource)
    ? (row.source as MemorySource)
    : "extracted";
  const tier: MemoryTier = ALLOWED_TIERS.has(row.tier as MemoryTier) ? (row.tier as MemoryTier) : "short";
  let consolidatedFrom: string[] | null = null;
  if (row.consolidated_from) {
    try {
      const parsed = JSON.parse(row.consolidated_from);
      if (Array.isArray(parsed)) consolidatedFrom = parsed.filter((x): x is string => typeof x === "string");
    } catch { /* corrupt JSON · treat as null */ }
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    content: row.content,
    kind,
    source,
    sourceRoom: row.source_room,
    confidence: row.confidence,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tier,
    usageCount: row.usage_count ?? 0,
    lastUsedAt: row.last_used_at,
    supersededBy: row.superseded_by,
    consolidatedFrom,
    provenanceRooms: row.provenance_rooms ?? 1,
  };
}

/** All memories for one agent · pinned first, then most-recent.
 *  By default excludes superseded rows (the audit trail) so the
 *  Memory tab shows the live set. Pass `{includeSuperseded: true}`
 *  for the "Show forgotten" audit view. */
export function listMemoriesForAgent(
  agentId: string,
  opts: { includeSuperseded?: boolean } = {},
): AgentMemory[] {
  const where = opts.includeSuperseded
    ? "WHERE agent_id = ?"
    : "WHERE agent_id = ? AND superseded_by IS NULL";
  const rows = getDb()
    .prepare(
      `SELECT ${SELECT_COLS} FROM agent_memories
        ${where}
        ORDER BY pinned DESC, created_at DESC`,
    )
    .all(agentId) as Row[];
  return rows.map(mapRow);
}

/** Top-K context for prompt injection · tier-aware (migration 026):
 *  · ALL pinned memories (user's explicit choice — never capped).
 *  · ALL `tier='long'` memories (dream-promoted stable patterns —
 *    always injected because they're decision-relevant and have
 *    survived the consolidation pass).
 *  · Up to `recentCap` most-recent `tier='short'` non-pinned memories.
 *
 *  Pre-Phase-1 every memory has tier='short' so the behaviour is
 *  identical to the old "pinned + top 5 recent" rule. Once the dream
 *  cycle starts promoting, the long-tier set grows and short-tier
 *  becomes the "what's happened recently that hasn't yet stabilised"
 *  bucket. */
export function memoriesForContext(agentId: string, recentCap = 5): AgentMemory[] {
  const all = listMemoriesForAgent(agentId);
  const pinned = all.filter((m) => m.pinned);
  const longTier = all.filter((m) => !m.pinned && m.tier === "long");
  const shortTier = all
    .filter((m) => !m.pinned && m.tier === "short")
    .slice(0, recentCap);
  return [...pinned, ...longTier, ...shortTier];
}

/** All non-superseded memories for one agent at a given tier · used
 *  by the dream cycle's decay/cluster steps which only operate on
 *  `tier='short'`. Always excludes superseded rows so we don't try
 *  to re-cluster yesterday's already-merged junk. */
export function listTierForAgent(agentId: string, tier: MemoryTier): AgentMemory[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SELECT_COLS} FROM agent_memories
        WHERE agent_id = ? AND tier = ? AND superseded_by IS NULL
        ORDER BY pinned DESC, created_at DESC`,
    )
    .all(agentId, tier) as Row[];
  return rows.map(mapRow);
}

/** Bump usage_count + last_used_at for a list of memories. Called
 *  by the prompt builder after the WHAT YOU REMEMBER block lands.
 *  Memories that ARE being read regularly thus escape the next
 *  decay sweep — usage_count > 0 disqualifies a row from culling. */
export function bumpUsage(memoryIds: string[]): void {
  if (!memoryIds.length) return;
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE agent_memories
        SET usage_count = usage_count + 1,
            last_used_at = ?
      WHERE id = ?`,
  );
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(now, id);
  });
  tx(memoryIds);
}

/** Heuristic decay sweep · drop non-pinned `tier='short'` memories
 *  that are old, never-injected, AND low confidence. All three
 *  predicates AND-ed so we only catch the genuinely-forgotten set;
 *  a memory needs to fail every test to be culled.
 *
 *  Returns count of rows deleted. Pinned, manually-added, and
 *  long-tier memories are never touched.
 *
 *  Defaults match the plan: 30 days old, 0 usages, < 0.5 confidence.
 *  Passing different thresholds lets a forced sweep be more lenient
 *  (e.g. boot-time heavy sweep when an agent's pile has overflowed). */
export interface DecayThresholds {
  /** Minimum age in ms · default 30 days. */
  minAgeMs?: number;
  /** Maximum confidence to qualify · default 0.5. */
  maxConfidence?: number;
  /** Maximum usage_count to qualify · default 0 (never injected). */
  maxUsage?: number;
}
export function decayShortTermMemories(agentId: string, thresholds: DecayThresholds = {}): number {
  const minAgeMs = thresholds.minAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  const maxConfidence = thresholds.maxConfidence ?? 0.5;
  const maxUsage = thresholds.maxUsage ?? 0;
  const ageCutoff = Date.now() - minAgeMs;
  const r = getDb()
    .prepare(
      `DELETE FROM agent_memories
        WHERE agent_id = ?
          AND tier = 'short'
          AND pinned = 0
          AND created_at < ?
          AND confidence < ?
          AND usage_count <= ?`,
    )
    .run(agentId, ageCutoff, maxConfidence, maxUsage);
  return r.changes ?? 0;
}

/** Count of memories owned by an agent · used by the boot-time
 *  sweep which fires `runDreamCycle` for any agent whose pile has
 *  exceeded the safety ceiling (catches mid-cycle crashes). */
export function countMemoriesForAgent(agentId: string): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM agent_memories WHERE agent_id = ?`)
    .get(agentId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export interface MemoryCreate {
  agentId: string;
  content: string;
  kind?: MemoryKind;
  source?: MemorySource;
  sourceRoom?: string | null;
  confidence?: number;
  pinned?: boolean;
}

export function insertMemory(input: MemoryCreate): AgentMemory {
  const db = getDb();
  const id = newId();
  const now = Date.now();
  const kind: MemoryKind = input.kind ?? "fact";
  const source: MemorySource = input.source ?? "extracted";
  const sourceRoom = input.sourceRoom ?? null;
  const confidence = typeof input.confidence === "number" ? input.confidence : 0.7;
  const pinned = input.pinned === true ? 1 : 0;
  db.prepare(
    `INSERT INTO agent_memories
       (id, agent_id, content, kind, source, source_room, confidence, pinned, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.agentId, input.content, kind, source, sourceRoom, confidence, pinned, now, now);
  return getMemory(id)!;
}

export function getMemory(id: string): AgentMemory | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM agent_memories WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? mapRow(row) : null;
}

/** Patch a subset of a memory's fields. Returns the updated row. */
export function updateMemory(
  id: string,
  patch: { content?: string; kind?: MemoryKind; pinned?: boolean },
): AgentMemory | null {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (typeof patch.content === "string") {
    fields.push("content = ?");
    values.push(patch.content);
  }
  if (patch.kind && ALLOWED_KINDS.has(patch.kind)) {
    fields.push("kind = ?");
    values.push(patch.kind);
  }
  if (typeof patch.pinned === "boolean") {
    fields.push("pinned = ?");
    values.push(patch.pinned ? 1 : 0);
  }
  if (fields.length === 0) return getMemory(id);
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  const r = getDb()
    .prepare(`UPDATE agent_memories SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  if (r.changes === 0) return null;
  return getMemory(id);
}

export function deleteMemory(id: string): boolean {
  const r = getDb().prepare("DELETE FROM agent_memories WHERE id = ?").run(id);
  return r.changes > 0;
}

export function isMemoryKind(v: string): v is MemoryKind {
  return ALLOWED_KINDS.has(v as MemoryKind);
}

// ─────────────────────────────────────────────────────────────────
// Phase 2 · supersession / consolidation / promotion
// ─────────────────────────────────────────────────────────────────

/** Mark a set of memories as superseded by another · the merge pass
 *  uses this to point each cluster member at the canonical merged
 *  row. The conflict-resolve pass uses it to point an older claim
 *  at its newer replacement. Pinned memories are never superseded
 *  (they're the user's explicit choice). */
export function markSuperseded(memoryIds: string[], supersedingId: string): number {
  if (!memoryIds.length) return 0;
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE agent_memories
        SET superseded_by = ?,
            updated_at = ?
      WHERE id = ?
        AND pinned = 0
        AND id != ?`,
  );
  let changes = 0;
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) {
      const r = stmt.run(supersedingId, now, id, supersedingId);
      changes += r.changes ?? 0;
    }
  });
  tx(memoryIds);
  return changes;
}

/** Insert a merged-from-cluster memory · keeps `consolidated_from`
 *  as the JSON list of source ids, sums their provenance, picks
 *  max confidence, and inherits the most recent createdAt so the
 *  merged row doesn't look "fresher" than its sources in retrieval
 *  ordering. Caller wraps with markSuperseded(sources, mergedId). */
export interface ConsolidatedInput {
  agentId: string;
  content: string;
  kind?: MemoryKind;
  sources: AgentMemory[];
  /** Promote directly to long-tier? Defaults to source tier · if any
   *  source was already 'long', stay 'long'. Otherwise stay 'short'
   *  (lets the regular promotion heuristic decide later). */
  forceLong?: boolean;
}
export function insertConsolidatedMemory(input: ConsolidatedInput): AgentMemory {
  const db = getDb();
  const id = newId();
  const sources = input.sources;
  if (sources.length === 0) {
    throw new Error("insertConsolidatedMemory · sources must be non-empty");
  }
  const sourceIds = sources.map((s) => s.id);
  const conf = sources.reduce((max, s) => Math.max(max, s.confidence), 0);
  const provenance = sources.reduce((sum, s) => sum + (s.provenanceRooms || 1), 0);
  const tier: MemoryTier =
    input.forceLong || sources.some((s) => s.tier === "long") ? "long" : "short";
  // Inherit the most-recent createdAt from sources so the merged
  // row doesn't look "fresh" — it's a synthesis of older content.
  const createdAt = sources.reduce((max, s) => Math.max(max, s.createdAt), 0);
  const now = Date.now();
  const kind: MemoryKind = input.kind ?? sources[0].kind;
  db.prepare(
    `INSERT INTO agent_memories
       (id, agent_id, content, kind, source, source_room, confidence, pinned,
        created_at, updated_at, tier, usage_count, last_used_at,
        superseded_by, consolidated_from, provenance_rooms)
     VALUES (?, ?, ?, ?, 'extracted', NULL, ?, 0,
             ?, ?, ?, 0, NULL,
             NULL, ?, ?)`,
  ).run(
    id,
    input.agentId,
    input.content,
    kind,
    conf,
    createdAt,
    now,
    tier,
    JSON.stringify(sourceIds),
    provenance,
  );
  return getMemory(id)!;
}

/** Promote a set of memories from short to long tier · used by the
 *  dream cycle's promotion heuristic when a memory's provenance +
 *  age + confidence cross the stability threshold. Pinned memories
 *  are unaffected (they're already always-injected by other rules). */
export function promoteToLong(memoryIds: string[]): number {
  if (!memoryIds.length) return 0;
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE agent_memories
        SET tier = 'long',
            updated_at = ?
      WHERE id = ?
        AND tier = 'short'
        AND superseded_by IS NULL`,
  );
  let changes = 0;
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) {
      const r = stmt.run(now, id);
      changes += r.changes ?? 0;
    }
  });
  tx(memoryIds);
  return changes;
}

/** Increment provenance_rooms for memories that just survived another
 *  room without being contradicted · called by the merge pass when
 *  near-duplicates from a NEW room land on top of an existing canonical
 *  memory. Phase 2 uses this to feed the promotion heuristic. */
export function bumpProvenance(memoryId: string, by = 1): void {
  getDb()
    .prepare(
      `UPDATE agent_memories
          SET provenance_rooms = provenance_rooms + ?,
              updated_at = ?
        WHERE id = ?`,
    )
    .run(by, Date.now(), memoryId);
}

// ─────────────────────────────────────────────────────────────────
// Dream-cycle audit log (agent_dreams)
// ─────────────────────────────────────────────────────────────────

interface DreamRow {
  id: string;
  agent_id: string;
  started_at: number;
  finished_at: number | null;
  before_count: number;
  after_count: number | null;
  decayed: number;
  merged: number;
  promoted: number;
  superseded: number;
  notes: string | null;
}

function mapDream(row: DreamRow): DreamLog {
  return {
    id: row.id,
    agentId: row.agent_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    beforeCount: row.before_count,
    afterCount: row.after_count,
    decayed: row.decayed,
    merged: row.merged,
    promoted: row.promoted,
    superseded: row.superseded,
    notes: row.notes,
  };
}

export interface RecordDreamInput {
  agentId: string;
  startedAt: number;
  finishedAt: number;
  beforeCount: number;
  afterCount: number;
  decayed: number;
  merged: number;
  promoted: number;
  superseded: number;
  notes?: string | null;
}
/** Persist one dream-cycle's summary to the audit log. Returns the
 *  generated row id. Read by `listDreamsForAgent` for the Phase 3
 *  Memory-tab telemetry strip. */
export function recordDream(input: RecordDreamInput): string {
  const db = getDb();
  const id = newId();
  db.prepare(
    `INSERT INTO agent_dreams
       (id, agent_id, started_at, finished_at, before_count, after_count,
        decayed, merged, promoted, superseded, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.agentId,
    input.startedAt,
    input.finishedAt,
    input.beforeCount,
    input.afterCount,
    input.decayed,
    input.merged,
    input.promoted,
    input.superseded,
    input.notes ?? null,
  );
  return id;
}

/** Most-recent dreams for an agent (cap default 10). Surfaces the
 *  metabolism activity in the Memory tab + lets future debug paths
 *  reconstruct what was dropped / merged / promoted when. */
export function listDreamsForAgent(agentId: string, limit = 10): DreamLog[] {
  const rows = getDb()
    .prepare(
      `SELECT id, agent_id, started_at, finished_at, before_count, after_count,
              decayed, merged, promoted, superseded, notes
         FROM agent_dreams
        WHERE agent_id = ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(agentId, limit) as DreamRow[];
  return rows.map(mapDream);
}

/** Hard-delete superseded memories whose supersession happened more
 *  than `olderThanMs` ago (default 30 days). Long after the user
 *  could plausibly want to "undo" the consolidation, the audit row
 *  becomes pure storage cost. Returns count purged. */
export function purgeStaleSupersededMemories(olderThanMs = 30 * 24 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - olderThanMs;
  const r = getDb()
    .prepare(
      `DELETE FROM agent_memories
        WHERE superseded_by IS NOT NULL
          AND updated_at < ?`,
    )
    .run(cutoff);
  return r.changes ?? 0;
}
