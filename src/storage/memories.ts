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
}

const SELECT_COLS =
  "id, agent_id, content, kind, source, source_room, confidence, pinned, created_at, updated_at";

const ALLOWED_KINDS: ReadonlySet<MemoryKind> = new Set(["fact", "observation", "preference", "goal"]);
const ALLOWED_SOURCES: ReadonlySet<MemorySource> = new Set(["extracted", "user_added", "user_pinned"]);

function mapRow(row: Row): AgentMemory {
  const kind: MemoryKind = ALLOWED_KINDS.has(row.kind as MemoryKind) ? (row.kind as MemoryKind) : "fact";
  const source: MemorySource = ALLOWED_SOURCES.has(row.source as MemorySource)
    ? (row.source as MemorySource)
    : "extracted";
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
  };
}

/** All memories for one agent · pinned first, then most-recent. Used by
 *  the agent profile to render the Memory tab AND by the prompt builder
 *  to inject "Known about the user". */
export function listMemoriesForAgent(agentId: string): AgentMemory[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SELECT_COLS} FROM agent_memories
        WHERE agent_id = ?
        ORDER BY pinned DESC, created_at DESC`,
    )
    .all(agentId) as Row[];
  return rows.map(mapRow);
}

/** Top-K context for prompt injection · all pinned + up to `recentCap`
 *  most-recent non-pinned. v1 ignores semantic relevance and uses pure
 *  recency; embedding-based scoring can replace this later without
 *  changing the call site signature. */
export function memoriesForContext(agentId: string, recentCap = 5): AgentMemory[] {
  const all = listMemoriesForAgent(agentId);
  const pinned = all.filter((m) => m.pinned);
  const recent = all.filter((m) => !m.pinned).slice(0, recentCap);
  return [...pinned, ...recent];
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
