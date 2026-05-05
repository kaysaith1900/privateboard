-- Per-agent skill catalog. Skills are installed by uploading a Skill.md
-- file with YAML frontmatter (name, slug, description, when_to_use,
-- ability deltas, tips) plus a free markdown body. The body is only
-- injected into the agent's Pass-2 system prompt when the Pass-1 router
-- picks the skill for that turn (Claude Code-style progressive
-- disclosure). Per-agent storage in v1 — no shared library.
CREATE TABLE IF NOT EXISTS agent_skills (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  version      TEXT NOT NULL DEFAULT '1.0',
  description  TEXT NOT NULL,
  when_to_use  TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  ability_json TEXT NOT NULL DEFAULT '{}',
  tips_json    TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (agent_id, slug),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills (agent_id);
