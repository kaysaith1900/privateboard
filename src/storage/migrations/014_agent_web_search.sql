-- Per-agent web-search toggle.
--
-- Default 1 (enabled). The actual gate is the user-supplied Brave
-- Search API key in `provider_keys` — without that key, no agent
-- can search regardless of this flag. With the key set, every agent
-- is search-capable by default; the user can switch any individual
-- director off via the agent profile page (e.g. to keep one
-- director on first-principles only).

ALTER TABLE agents ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 1;
