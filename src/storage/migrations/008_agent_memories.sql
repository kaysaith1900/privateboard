-- Long-term agent memory · per-agent notes about the USER that
-- accumulate across rooms. Each agent (directors + chair) keeps an
-- independent set so multi-perspective lenses stay distinct (Skeptic
-- vs Empath remember different things). Read back into every prompt
-- as a "Known about the user" block; written at room adjourn via a
-- small extraction LLM call (skipped when room.incognito = 1).
--
-- This is NOT room memory. Room-scoped context (chat history, key
-- points, brief) is already covered by the existing tables — we're
-- only adding the cross-room layer here.

CREATE TABLE IF NOT EXISTS agent_memories (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  content       TEXT NOT NULL,
  -- "fact"        · stable assertion ("user is cofounder at HR SaaS")
  -- "observation" · agent's read on the user ("user defines terms loosely")
  -- "preference"  · style / format / language pref
  -- "goal"        · stated objective with horizon
  kind          TEXT NOT NULL DEFAULT 'fact',
  -- "extracted"   · auto-written at room adjourn
  -- "user_added"  · manually entered via agent profile
  -- "user_pinned" · automatic flag set when user pins (denormalised mirror of `pinned`)
  source        TEXT NOT NULL DEFAULT 'extracted',
  -- room this memory was distilled from (NULL when user added manually)
  source_room   TEXT,
  -- LLM-self-reported confidence at extraction time (0..1)
  confidence    REAL NOT NULL DEFAULT 0.7,
  -- Pinned memories are ALWAYS injected into prompts; non-pinned go
  -- through a recency cap.
  pinned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (source_room) REFERENCES rooms(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_memories_agent ON agent_memories(agent_id, pinned DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memories_room ON agent_memories(source_room);

-- Per-room incognito flag · when set, room adjourn does NOT trigger
-- extraction and nothing from the room flows into long-term memory.
-- Default 0 (writes by default, per the v1 product decision).
ALTER TABLE rooms ADD COLUMN incognito INTEGER NOT NULL DEFAULT 0;
