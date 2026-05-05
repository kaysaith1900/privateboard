/**
 * Per-agent skills · uploaded as Skill.md files (YAML frontmatter +
 * markdown body). Read on every prompt build to construct the Pass-1
 * router toolbox; full body is injected into Pass-2 only when the
 * router picks the slug for that turn (Claude Code-style progressive
 * disclosure).
 *
 * v1 is per-agent (no shared library) — each upload installs onto a
 * single agent. Slug uniqueness is enforced per agent.
 */
import { getDb } from "./db.js";
import { newId } from "../utils/id.js";

/** Optional runtime state attached to a system skill so the agent
 *  profile can render the right control (toggle vs. configure-link)
 *  without making a second roundtrip. Today only `web-search` uses
 *  this — toggle gated by Brave key + per-agent flag. */
export interface AgentSkillState {
  /** Per-agent on/off flag for skills with a toggle (web-search). */
  enabled?: boolean;
  /** True when the global service this skill depends on is configured.
   *  When false, the toggle should render as "Configure key" pointing
   *  at User Settings instead of an interactive switch. */
  keyConfigured?: boolean;
  /** When set, points the UI at which Preferences row to surface for
   *  configuring the dependency. */
  requiresKey?: { provider: string; label: string };
}

export interface AgentSkill {
  id: string;
  agentId: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  whenToUse: string;
  bodyMd: string;
  /** Axis → integer delta. Axes are boardroom-specific (see PRD). */
  ability: Record<string, number>;
  tips: string[];
  createdAt: number;
  updatedAt: number;
  /** True for hardcoded system skills (e.g. the chair's report writer).
   *  System skills aren't stored in the DB — they're synthesized at read
   *  time and cannot be deleted or edited. */
  system?: boolean;
  /** Runtime state for system skills with optional gates / toggles. */
  state?: AgentSkillState;
}

interface Row {
  id: string;
  agent_id: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  when_to_use: string;
  body_md: string;
  ability_json: string;
  tips_json: string;
  created_at: number;
  updated_at: number;
}

const SELECT_COLS =
  "id, agent_id, slug, name, version, description, when_to_use, body_md, ability_json, tips_json, created_at, updated_at";

function safeParseObject(s: string): Record<string, number> {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, number> = {};
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
      }
      return out;
    }
  } catch { /* fall through */ }
  return {};
}

function safeParseStringArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  } catch { /* fall through */ }
  return [];
}

function mapRow(row: Row): AgentSkill {
  return {
    id: row.id,
    agentId: row.agent_id,
    slug: row.slug,
    name: row.name,
    version: row.version,
    description: row.description,
    whenToUse: row.when_to_use,
    bodyMd: row.body_md,
    ability: safeParseObject(row.ability_json),
    tips: safeParseStringArray(row.tips_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** All skills installed on an agent · most-recent first. Used by the
 *  agent profile to render the Skills block AND by the orchestrator
 *  to build the Pass-1 router toolbox. */
export function listSkillsForAgent(agentId: string): AgentSkill[] {
  const rows = getDb()
    .prepare(
      `SELECT ${SELECT_COLS} FROM agent_skills
        WHERE agent_id = ?
        ORDER BY created_at DESC`,
    )
    .all(agentId) as Row[];
  return rows.map(mapRow);
}

export function getSkill(id: string): AgentSkill | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM agent_skills WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? mapRow(row) : null;
}

/** Lookup by (agent, slug). Used to detect duplicates before insert. */
export function getSkillBySlug(agentId: string, slug: string): AgentSkill | null {
  const row = getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM agent_skills WHERE agent_id = ? AND slug = ?`)
    .get(agentId, slug) as Row | undefined;
  return row ? mapRow(row) : null;
}

export function countSkillsForAgent(agentId: string): number {
  const r = getDb()
    .prepare("SELECT COUNT(*) AS c FROM agent_skills WHERE agent_id = ?")
    .get(agentId) as { c: number };
  return r?.c ?? 0;
}

export interface SkillCreate {
  agentId: string;
  slug: string;
  name: string;
  version?: string;
  description: string;
  whenToUse: string;
  bodyMd: string;
  ability?: Record<string, number>;
  tips?: string[];
}

export function insertSkill(input: SkillCreate): AgentSkill {
  const db = getDb();
  const id = newId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_skills
       (id, agent_id, slug, name, version, description, when_to_use, body_md,
        ability_json, tips_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.agentId,
    input.slug,
    input.name,
    input.version ?? "1.0",
    input.description,
    input.whenToUse,
    input.bodyMd,
    JSON.stringify(input.ability ?? {}),
    JSON.stringify(input.tips ?? []),
    now,
    now,
  );
  return getSkill(id)!;
}

export function deleteSkill(id: string): boolean {
  const r = getDb().prepare("DELETE FROM agent_skills WHERE id = ?").run(id);
  return r.changes > 0;
}
