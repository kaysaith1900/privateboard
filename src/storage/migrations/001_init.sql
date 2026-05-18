-- ═══════════════════════════════════════════
-- Boardroom · initial schema
-- All tables for the v1 MVP. memory_* and knowledge_* are deferred
-- (post-MVP) and will land in a later migration.
-- ═══════════════════════════════════════════

-- User preferences · single-row table.
-- Note: the `theme` column is historical · appearance moved to
-- localStorage. The column stays defined here so existing rows
-- keep validating (NOT NULL DEFAULT), but the server code no
-- longer reads or writes it. Will be retired in a future cleanup
-- migration bundled with other DB-shape changes.
CREATE TABLE prefs (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  name        TEXT    NOT NULL DEFAULT 'You',
  intro       TEXT    NOT NULL DEFAULT '',
  avatar_seed TEXT,
  theme       TEXT    NOT NULL DEFAULT 'regent',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

INSERT INTO prefs (id, name, intro, theme, created_at, updated_at)
VALUES (1, 'You', '', 'regent',
        CAST(strftime('%s','now') AS INTEGER) * 1000,
        CAST(strftime('%s','now') AS INTEGER) * 1000);

-- LLM provider API keys · stored AES-GCM encrypted.
CREATE TABLE provider_keys (
  provider   TEXT PRIMARY KEY,
  key_blob   BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Directors / Agents.
CREATE TABLE agents (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  handle      TEXT    UNIQUE NOT NULL,
  role_tag    TEXT    NOT NULL DEFAULT '',     -- e.g. 'skeptic', 'physicist'
  bio         TEXT    NOT NULL DEFAULT '',
  cover_quote TEXT,
  instruction TEXT    NOT NULL,
  model_v     TEXT    NOT NULL,                 -- 'sonnet-4-6' | 'gpt-5' | ...
  avatar_path TEXT    NOT NULL,
  is_pinned   INTEGER NOT NULL DEFAULT 0,
  is_seed     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Rooms (boardroom sessions).
CREATE TABLE rooms (
  id           TEXT    PRIMARY KEY,
  number       INTEGER NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  subject      TEXT    NOT NULL,
  mode         TEXT    NOT NULL DEFAULT 'discovery',  -- discovery|constructive|adversarial
  status       TEXT    NOT NULL DEFAULT 'live',       -- live|adjourned
  brief_style  TEXT,
  created_at   INTEGER NOT NULL,
  adjourned_at INTEGER
);

-- Room ↔ Agent membership (M:N).
CREATE TABLE room_members (
  room_id   TEXT    NOT NULL,
  agent_id  TEXT    NOT NULL,
  position  INTEGER NOT NULL,                     -- speaking order in round-robin
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, agent_id),
  FOREIGN KEY (room_id)  REFERENCES rooms(id)  ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX idx_room_members_room ON room_members(room_id, position);

-- Messages (user, agents, system).
CREATE TABLE messages (
  id           TEXT    PRIMARY KEY,
  room_id      TEXT    NOT NULL,
  author_kind  TEXT    NOT NULL,                  -- 'agent' | 'user' | 'system'
  author_id    TEXT,                              -- agent.id or NULL
  reply_to_id  TEXT,
  body         TEXT    NOT NULL,
  meta_json    TEXT,                              -- JSON: mentions[], speakerStatus, ...
  round_num    INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (room_id)     REFERENCES rooms(id)     ON DELETE CASCADE,
  FOREIGN KEY (reply_to_id) REFERENCES messages(id)  ON DELETE SET NULL
);

CREATE INDEX idx_messages_room ON messages(room_id, created_at);

-- Configuration / lifecycle events (room-opened, room-adjourned, member-add, ...).
CREATE TABLE config_events (
  id          TEXT    PRIMARY KEY,
  room_id     TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  payload     TEXT,                                -- JSON
  actor_kind  TEXT    NOT NULL,                    -- 'user' | 'system'
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);

-- Briefs · adjourn product.
CREATE TABLE briefs (
  id          TEXT    PRIMARY KEY,
  room_id     TEXT    NOT NULL UNIQUE,
  style       TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  body_md     TEXT    NOT NULL,
  body_json   TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
);
