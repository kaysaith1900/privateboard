-- 051_search_credentials.sql
--
-- Multi-instance SEARCH provider credentials · final mirror of the
-- pattern that migrations 044-046 introduced for LLM and migration 049
-- introduced for Voice TTS. The same web-search provider (Brave or
-- Tavily) can now appear multiple times with distinct user-supplied
-- labels (personal + team account, for example), with exactly one
-- "active" credential pointed to by `prefs.active_search_credential_id`.
--
-- After this migration runs, `provider_keys` is EMPTY · every
-- credential the user holds (LLM / voice / search) lives in its own
-- typed table with `(id, provider, label, key_blob)` columns. The
-- legacy `provider_keys` table itself stays in the schema for now ·
-- it's structurally tiny and dropping it would require coordinated
-- removal of the `getKey` / `setKey` helpers in `keys.ts`, which is
-- noise unrelated to this feature.
--
-- Unlike the LLM and voice flips, switching active search provider
-- has NO per-agent reshuffle · agents don't carry per-search-provider
-- state, so the active swap is purely a routing decision that the
-- next web-search call honours automatically. No `reconcile-*`
-- helper is needed.

CREATE TABLE IF NOT EXISTS search_credentials (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,                -- 'brave' | 'tavily'
  label       TEXT NOT NULL,
  key_blob    BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS search_credentials_provider_idx
  ON search_credentials(provider);

ALTER TABLE prefs ADD COLUMN active_search_credential_id TEXT;

-- One-shot migration · move every configured brave/tavily row from
-- provider_keys into search_credentials. Labels default to the
-- provider's display name; the seed-active step below picks brave
-- when both exist (matches the historical `webSearchProvider` default
-- of "brave" set in migration 029).
INSERT INTO search_credentials (id, provider, label, key_blob, created_at, updated_at)
SELECT
  lower(hex(randomblob(8))) AS id,
  provider,
  CASE provider
    WHEN 'brave'  THEN 'Brave Search'
    WHEN 'tavily' THEN 'Tavily Search'
    ELSE provider
  END AS label,
  key_blob,
  created_at,
  updated_at
FROM provider_keys
WHERE provider IN ('brave','tavily')
  AND length(key_blob) > 0;

-- Seed prefs.active_search_credential_id with the highest-priority
-- migrated credential. Priority mirrors the historical default in
-- migration 029 (brave first, tavily as alternate). If the user had
-- previously expressed a `web_search_provider = 'tavily'` preference,
-- that's preserved here by sorting on that pref first.
UPDATE prefs
   SET active_search_credential_id = (
     SELECT id FROM search_credentials
      ORDER BY CASE provider
                 WHEN (SELECT COALESCE(web_search_provider, 'brave') FROM prefs WHERE id = 1) THEN 0
                 WHEN 'brave'  THEN 1
                 WHEN 'tavily' THEN 2
               END,
               created_at ASC
      LIMIT 1
   )
 WHERE id = 1
   AND active_search_credential_id IS NULL;

-- Finally · remove the migrated search rows from provider_keys so
-- the legacy table is fully drained (all four credentialed providers
-- · openai/anthropic/google/xai for LLM, minimax/elevenlabs for voice,
-- brave/tavily for search · now live in their typed tables). After
-- this migration, `getKey("brave")` and `getKey("tavily")` always
-- return null · callers must read the active search credential via
-- `getActiveSearchKeyPlaintext()` instead.
DELETE FROM provider_keys
 WHERE provider IN ('brave','tavily');
