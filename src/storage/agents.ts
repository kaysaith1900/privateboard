/** Directors / agents. */
import { getDb } from "./db.js";

export type AgentRoleKind = "director" | "moderator";

/** Optional per-agent carrier override. The same modelV may be reachable
 *  via multiple carriers when the user has multiple provider keys (e.g.
 *  GPT-5.5 via OpenRouter or via OpenAI direct). The adapter's default
 *  precedence rules pick one; this lets each agent pin a specific carrier.
 *  NULL = "use default precedence". */
export type AgentCarrierPref = "openrouter" | "anthropic" | "openai" | "google" | "xai";
const VALID_CARRIER_PREFS: ReadonlySet<AgentCarrierPref> = new Set([
  "openrouter", "anthropic", "openai", "google", "xai",
]);
function parseCarrierPref(raw: string | null): AgentCarrierPref | null {
  if (!raw) return null;
  return VALID_CARRIER_PREFS.has(raw as AgentCarrierPref)
    ? (raw as AgentCarrierPref)
    : null;
}

export interface Agent {
  id: string;
  name: string;
  handle: string;
  roleTag: string;
  roleKind: AgentRoleKind;
  bio: string;
  coverQuote: string | null;
  instruction: string;
  modelV: string;
  /** Carrier override — see AgentCarrierPref. NULL keeps the default
   *  routing precedence (OR-only models prefer OR; otherwise direct). */
  carrierPref: AgentCarrierPref | null;
  avatarPath: string;
  /** Base ability profile · {axis: 0-10}. NULL when not set (legacy
   *  records); the radar falls back to flat 5/all. */
  ability: Record<string, number> | null;
  isPinned: boolean;
  isSeed: boolean;
  /** Per-agent toggle for the Web Search system skill. Defaults to
   *  true. The actual gate is the user-supplied Brave Search key in
   *  provider_keys — without that key, no agent searches regardless
   *  of this flag. */
  webSearchEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  name: string;
  handle: string;
  role_tag: string;
  role_kind: string;
  bio: string;
  cover_quote: string | null;
  instruction: string;
  model_v: string;
  carrier_pref: string | null;
  avatar_path: string;
  ability_json: string | null;
  is_pinned: number;
  is_seed: number;
  web_search_enabled: number;
  created_at: number;
  updated_at: number;
}

function parseAbility(raw: string | null): Record<string, number> | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

function mapRow(row: Row): Agent {
  const kind: AgentRoleKind = row.role_kind === "moderator" ? "moderator" : "director";
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    roleTag: row.role_tag,
    roleKind: kind,
    bio: row.bio,
    coverQuote: row.cover_quote,
    instruction: row.instruction,
    modelV: row.model_v,
    carrierPref: parseCarrierPref(row.carrier_pref),
    avatarPath: row.avatar_path,
    ability: parseAbility(row.ability_json),
    isPinned: row.is_pinned === 1,
    isSeed: row.is_seed === 1,
    webSearchEnabled: row.web_search_enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLS =
  "id, name, handle, role_tag, role_kind, bio, cover_quote, instruction, model_v, carrier_pref, " +
  "avatar_path, ability_json, is_pinned, is_seed, web_search_enabled, created_at, updated_at";

/** Directors only — the moderator (chair) is hidden from generic listings. */
export function listAgents(): Agent[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SELECT_COLS} FROM agents
       WHERE role_kind = 'director'
       ORDER BY is_pinned DESC, created_at ASC`,
    )
    .all() as Row[];
  return rows.map(mapRow);
}

/** All agents including the chair — used by orchestrator + room state. */
export function listAllAgents(): Agent[] {
  const rows = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM agents ORDER BY is_pinned DESC, created_at ASC`)
    .all() as Row[];
  return rows.map(mapRow);
}

/** The single chair agent. There's only ever one moderator in v1. */
export function getChairAgent(): Agent | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM agents WHERE role_kind = 'moderator' LIMIT 1`)
    .get() as Row | undefined;
  return row ? mapRow(row) : null;
}

export function countAgents(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number };
  return row.n;
}

export interface AgentStats {
  /** Distinct rooms the agent has been a member of (chair seat at
   *  position -1 excluded). */
  roomsJoined: number;
  /** Distinct (room_id, round_num) pairs the agent has spoken in.
   *  Counts a round only if the agent actually produced a message —
   *  silent presence doesn't bump the counter. */
  roundsSpoken: number;
  /** Cumulative tokens billed against this agent across every LLM
   *  turn — written by the orchestrator after each callLLMStream
   *  finishes via incrementAgentTokens. */
  tokensConsumed: number;
}

/** Returns the three counters surfaced on the agent profile. Cheap
 *  enough to compute on every profile open (small tables, indexed
 *  columns); skip a stats table until volumes warrant it. */
export function getAgentStats(agentId: string): AgentStats {
  const db = getDb();
  const rooms = db
    .prepare(
      "SELECT COUNT(*) AS n FROM room_members WHERE agent_id = ? AND position >= 0",
    )
    .get(agentId) as { n: number } | undefined;
  const rounds = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT room_id, round_num FROM messages
         WHERE author_id = ? AND author_kind = 'agent'
       )`,
    )
    .get(agentId) as { n: number } | undefined;
  const tokens = db
    .prepare("SELECT tokens_consumed AS n FROM agents WHERE id = ?")
    .get(agentId) as { n: number } | undefined;
  return {
    roomsJoined: rooms?.n ?? 0,
    roundsSpoken: rounds?.n ?? 0,
    tokensConsumed: tokens?.n ?? 0,
  };
}

/** Bump an agent's cumulative token counter by `delta`. Negative or
 *  zero deltas are no-ops. Called from the orchestrator after each
 *  director / chair stream finishes with the SDK's reported usage. */
export function incrementAgentTokens(agentId: string, delta: number): void {
  if (!Number.isFinite(delta) || delta <= 0) return;
  getDb()
    .prepare("UPDATE agents SET tokens_consumed = tokens_consumed + ? WHERE id = ?")
    .run(Math.round(delta), agentId);
}

/** Cumulative usage summary used by the Usage panel in user-settings.
 *  Aggregates the per-agent token counter into total / by-model / by-agent
 *  rollups in a single pass. Cheap (small tables, indexed on agents.id). */
export interface UsageAgentRow {
  id: string;
  name: string;
  handle: string;
  modelV: string;
  roleKind: AgentRoleKind;
  tokens: number;
}
export interface UsageModelRow {
  modelV: string;
  tokens: number;
  agents: number;
}
/** Aggregate of tokens that belonged to since-deleted agents. Per-agent
 *  identity is gone but the model-level rollup survives so the Usage
 *  panel total stays accurate. */
export interface UsageRetired {
  /** Total tokens billed to retired agents across all models. */
  tokens: number;
  /** Distinct retired agents folded in (sum across all models). */
  agents: number;
  /** Per-model breakdown of the retired bucket. Each entry already
   *  flows into the matching `byModel` row in the summary; this exists
   *  for callers that want to surface retired-only data separately. */
  byModel: UsageModelRow[];
}

export interface UsageSummary {
  totalTokens: number;
  agentCount: number;
  byModel: UsageModelRow[];
  byAgent: UsageAgentRow[];
  retired: UsageRetired;
}

export function getUsageSummary(): UsageSummary {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, name, handle, model_v, role_kind, tokens_consumed
         FROM agents
       ORDER BY tokens_consumed DESC, created_at ASC`,
    )
    .all() as Array<{
      id: string;
      name: string;
      handle: string;
      model_v: string;
      role_kind: string;
      tokens_consumed: number;
    }>;

  let liveTokens = 0;
  // Track live vs. retired separately so the per-model row can split
  // them when surfacing rollups.
  const modelLive = new Map<string, { tokens: number; agents: number }>();
  const byAgent: UsageAgentRow[] = [];

  for (const r of rows) {
    const tokens = r.tokens_consumed || 0;
    liveTokens += tokens;
    const cur = modelLive.get(r.model_v) ?? { tokens: 0, agents: 0 };
    cur.tokens += tokens;
    cur.agents += 1;
    modelLive.set(r.model_v, cur);
    byAgent.push({
      id: r.id,
      name: r.name,
      handle: r.handle,
      modelV: r.model_v,
      roleKind: r.role_kind === "moderator" ? "moderator" : "director",
      tokens,
    });
  }

  // Pull the retired rollup. `agents` here is the count of distinct
  // deleted agents — they never fold back into byAgent (their identity
  // is gone), only their tokens do, via byModel.
  const retiredRows = db
    .prepare("SELECT model_v AS modelV, tokens, agents FROM retired_token_usage")
    .all() as Array<{ modelV: string; tokens: number; agents: number }>;
  const retiredByModel: UsageModelRow[] = [];
  let retiredTokens = 0;
  let retiredAgents = 0;
  for (const r of retiredRows) {
    if (!r.tokens) continue;
    retiredTokens += r.tokens;
    retiredAgents += r.agents;
    retiredByModel.push({ modelV: r.modelV, tokens: r.tokens, agents: r.agents });
  }

  // Merge live + retired by model so the panel's per-model rollup
  // reflects everything ever billed against the user's wallet.
  const merged = new Map<string, { tokens: number; agents: number }>();
  for (const [m, v] of modelLive) merged.set(m, { ...v });
  for (const r of retiredByModel) {
    const cur = merged.get(r.modelV) ?? { tokens: 0, agents: 0 };
    cur.tokens += r.tokens;
    cur.agents += r.agents;
    merged.set(r.modelV, cur);
  }
  const byModel: UsageModelRow[] = Array.from(merged.entries())
    .map(([modelV, v]) => ({ modelV, tokens: v.tokens, agents: v.agents }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    totalTokens: liveTokens + retiredTokens,
    agentCount: rows.length,
    byModel,
    byAgent,
    retired: {
      tokens: retiredTokens,
      agents: retiredAgents,
      byModel: retiredByModel.sort((a, b) => b.tokens - a.tokens),
    },
  };
}

export function getAgent(id: string): Agent | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM agents WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? mapRow(row) : null;
}

export function getAgentByHandle(handle: string): Agent | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM agents WHERE handle = ?`)
    .get(handle) as Row | undefined;
  return row ? mapRow(row) : null;
}

export interface AgentInsert {
  id: string;
  name: string;
  handle: string;
  roleTag: string;
  roleKind?: AgentRoleKind;
  bio: string;
  coverQuote?: string | null;
  instruction: string;
  modelV: string;
  /** Optional carrier override at insert time. Most seed paths leave
   *  this null and let the adapter route by default precedence. */
  carrierPref?: AgentCarrierPref | null;
  avatarPath: string;
  ability?: Record<string, number> | null;
  isPinned?: boolean;
  isSeed?: boolean;
}

export function insertAgent(a: AgentInsert): Agent {
  const now = Date.now();
  const abilityJson = a.ability && Object.keys(a.ability).length > 0
    ? JSON.stringify(a.ability)
    : null;
  // Web Search defaults OFF for new agents. Schema-level default
  // stays at 1 (changing it requires a SQLite full table rebuild),
  // so we explicitly write 0 here. Users opt in via the toggle on
  // the agent profile after configuring the global Brave key.
  getDb()
    .prepare(
      `INSERT INTO agents
       (id, name, handle, role_tag, role_kind, bio, cover_quote, instruction, model_v, carrier_pref,
        avatar_path, ability_json, is_pinned, is_seed, web_search_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      a.id,
      a.name,
      a.handle,
      a.roleTag,
      a.roleKind ?? "director",
      a.bio,
      a.coverQuote ?? null,
      a.instruction,
      a.modelV,
      a.carrierPref ?? null,
      a.avatarPath,
      abilityJson,
      a.isPinned ? 1 : 0,
      a.isSeed ? 1 : 0,
      0, // web_search_enabled · opt-in only
      now,
      now,
    );
  return getAgent(a.id)!;
}

/** Permanently delete an agent. room_members / skills / memories all
 *  cascade via FK ON DELETE CASCADE. Messages keep their author_id
 *  but resolve to "unknown agent" on the frontend (acceptable — we
 *  preserve the transcript history rather than cascading-delete every
 *  past utterance the agent ever spoke). Returns true on a real delete. */
/** Delete a custom agent. Before the row is removed, any
 *  `tokens_consumed` it has accumulated is transferred to
 *  `retired_token_usage`, keyed by model. This keeps the Usage panel's
 *  grand total + per-model rollup honest after deletions — the bytes
 *  the user already paid for don't silently vanish from the dashboard.
 *
 *  Per-agent identity is intentionally lost (deletion means "make it
 *  go away"); only the aggregate by model survives. */
export function deleteAgent(id: string): boolean {
  const db = getDb();
  const tx = db.transaction((agentId: string) => {
    const row = db
      .prepare(
        "SELECT model_v AS modelV, tokens_consumed AS tokens FROM agents WHERE id = ?",
      )
      .get(agentId) as { modelV: string; tokens: number } | undefined;
    if (row && row.tokens > 0 && row.modelV) {
      const now = Date.now();
      db.prepare(
        `INSERT INTO retired_token_usage (model_v, tokens, agents, updated_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(model_v) DO UPDATE SET
           tokens     = tokens + excluded.tokens,
           agents     = agents + 1,
           updated_at = excluded.updated_at`,
      ).run(row.modelV, row.tokens, now);
    }
    return db.prepare("DELETE FROM agents WHERE id = ?").run(agentId).changes;
  });
  return tx(id) > 0;
}

/** Patch a subset of fields on an existing agent. Returns the row
 *  after the update, or null if no row matched. */
export function updateAgent(
  id: string,
  patch: {
    avatarPath?: string;
    modelV?: string;
    /** Pass `null` to clear the override, an `AgentCarrierPref` to
     *  set it, or omit the key to leave the field untouched. */
    carrierPref?: AgentCarrierPref | null;
    bio?: string;
    instruction?: string;
    webSearchEnabled?: boolean;
    ability?: Record<string, number> | null;
  },
): Agent | null {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (typeof patch.avatarPath === "string") {
    fields.push("avatar_path = ?");
    values.push(patch.avatarPath);
  }
  if (typeof patch.modelV === "string") {
    fields.push("model_v = ?");
    values.push(patch.modelV);
  }
  if (patch.carrierPref !== undefined) {
    fields.push("carrier_pref = ?");
    values.push(patch.carrierPref ?? null);
  }
  if (typeof patch.bio === "string") {
    fields.push("bio = ?");
    values.push(patch.bio);
  }
  if (typeof patch.instruction === "string") {
    fields.push("instruction = ?");
    values.push(patch.instruction);
  }
  if (typeof patch.webSearchEnabled === "boolean") {
    fields.push("web_search_enabled = ?");
    values.push(patch.webSearchEnabled ? 1 : 0);
  }
  if (patch.ability !== undefined) {
    fields.push("ability_json = ?");
    const json = patch.ability && Object.keys(patch.ability).length > 0
      ? JSON.stringify(patch.ability)
      : null;
    values.push(json);
  }
  if (fields.length === 0) return getAgent(id);
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  const r = getDb()
    .prepare(`UPDATE agents SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  if (r.changes === 0) return null;
  return getAgent(id);
}
