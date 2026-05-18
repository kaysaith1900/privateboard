-- 043_llm_credentials.sql
--
-- Multi-instance LLM provider credentials · the same provider can now
-- be added more than once (e.g. two separate OpenRouter accounts, or
-- a personal + team B.AI key). The legacy `provider_keys` table is
-- keyed by `provider` (one row per provider), which doesn't support
-- this. We introduce a new table keyed by an opaque `id` so the same
-- provider can appear multiple times with distinct user-supplied
-- labels.
--
-- Voice (minimax, elevenlabs) and skill (brave, tavily) keys stay in
-- `provider_keys` — they have no use case for multiple credentials
-- per provider and the existing routes work fine for them.
--
-- `prefs.active_llm_credential_id` replaces the brief-lived
-- `prefs.active_llm_provider` from migration 042. Switching is now a
-- one-write change to this id; the old column stays in place (NULL
-- after this migration) to avoid an ALTER…DROP COLUMN that requires
-- table rebuilds on older SQLite.

CREATE TABLE IF NOT EXISTS llm_credentials (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  label       TEXT NOT NULL,
  key_blob    BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS llm_credentials_provider_idx
  ON llm_credentials(provider);

ALTER TABLE prefs ADD COLUMN active_llm_credential_id TEXT;

-- One-shot migration · for every configured LLM row in provider_keys,
-- create a credential row carrying the same encrypted key_blob. The
-- generated id uses a 12-char base64 slice of randomblob() for
-- collision-resistance; labels default to the provider's display
-- name (frontend will surface them under that label until the user
-- renames). Empty key_blobs are skipped (legacy "ever-configured"
-- rows that have since been emptied).
INSERT INTO llm_credentials (id, provider, label, key_blob, created_at, updated_at)
SELECT
  lower(hex(randomblob(8))) AS id,
  provider,
  CASE provider
    WHEN 'openrouter' THEN 'OpenRouter'
    WHEN 'bai'        THEN 'B.AI'
    WHEN 'anthropic'  THEN 'Claude'
    WHEN 'openai'     THEN 'ChatGPT'
    WHEN 'google'     THEN 'Gemini'
    WHEN 'xai'        THEN 'Grok'
    WHEN 'deepseek'   THEN 'DeepSeek'
    ELSE provider
  END AS label,
  key_blob,
  created_at,
  updated_at
FROM provider_keys
WHERE provider IN ('openrouter','bai','anthropic','openai','google','xai','deepseek')
  AND length(key_blob) > 0;

-- Seed prefs.active_llm_credential_id with the highest-priority
-- migrated credential. Priority mirrors LLM_PROVIDER_PRIORITY in
-- src/ai/providers.ts.
UPDATE prefs
   SET active_llm_credential_id = (
     SELECT id FROM llm_credentials
      ORDER BY CASE provider
                 WHEN 'openrouter' THEN 1
                 WHEN 'bai'        THEN 2
                 WHEN 'anthropic'  THEN 3
                 WHEN 'openai'     THEN 4
                 WHEN 'google'     THEN 5
                 WHEN 'xai'        THEN 6
                 WHEN 'deepseek'   THEN 7
               END,
               created_at ASC
      LIMIT 1
   )
 WHERE id = 1
   AND active_llm_credential_id IS NULL;

-- Clear the now-redundant active_llm_provider · the credential id is
-- the new source of truth. The column stays in the schema (avoids a
-- table rebuild) but post-migration it's always NULL; any reader
-- that still consults it sees "no active" and falls back to the
-- credential lookup.
UPDATE prefs SET active_llm_provider = NULL WHERE id = 1;

-- Finally · remove the migrated LLM rows from provider_keys so the
-- table is purely voice + skill from here on. Cleared by name; an
-- explicit IN() list matches what we inserted above.
DELETE FROM provider_keys
 WHERE provider IN ('openrouter','bai','anthropic','openai','google','xai','deepseek');
