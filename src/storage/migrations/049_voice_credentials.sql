-- 049_voice_credentials.sql
--
-- Multi-instance VOICE TTS provider credentials · mirrors the LLM
-- credential model that landed in 046. The same TTS provider can
-- now be added more than once (e.g. two MiniMax accounts, or
-- personal + team ElevenLabs) with distinct user-supplied labels.
-- Legacy `provider_keys` was keyed by `provider` (one row per
-- provider), which doesn't support this. The new table is keyed by
-- an opaque `id`.
--
-- `prefs.active_voice_credential_id` is the single pointer that
-- decides which TTS provider is "active" right now. Switching is
-- a one-write change to this id; the credential rows themselves
-- stay on file so the user can flip back without re-pasting.
--
-- Skill keys (brave, tavily) remain in `provider_keys` — they have
-- no use case for multiple credentials per provider and their
-- routes work fine as-is. After this migration, `provider_keys`
-- holds ONLY skill rows.

CREATE TABLE IF NOT EXISTS voice_credentials (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  label       TEXT NOT NULL,
  key_blob    BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS voice_credentials_provider_idx
  ON voice_credentials(provider);

ALTER TABLE prefs ADD COLUMN active_voice_credential_id TEXT;

-- One-shot migration · move every configured voice row from
-- provider_keys into voice_credentials. Generated id uses a
-- 16-char hex randomblob slice for collision resistance; labels
-- default to the provider's display name (UI surfaces them under
-- that label until the user renames). Empty key_blobs are skipped
-- (legacy "ever-configured" rows that have since been emptied).
INSERT INTO voice_credentials (id, provider, label, key_blob, created_at, updated_at)
SELECT
  lower(hex(randomblob(8))) AS id,
  provider,
  CASE provider
    WHEN 'minimax'    THEN 'MiniMax'
    WHEN 'elevenlabs' THEN 'ElevenLabs'
    ELSE provider
  END AS label,
  key_blob,
  created_at,
  updated_at
FROM provider_keys
WHERE provider IN ('minimax','elevenlabs')
  AND length(key_blob) > 0;

-- Seed prefs.active_voice_credential_id with the highest-priority
-- migrated credential. Priority mirrors the existing fallback chain
-- in src/voice/tts.ts:165-179 (MiniMax > ElevenLabs).
UPDATE prefs
   SET active_voice_credential_id = (
     SELECT id FROM voice_credentials
      ORDER BY CASE provider
                 WHEN 'minimax'    THEN 1
                 WHEN 'elevenlabs' THEN 2
               END,
               created_at ASC
      LIMIT 1
   )
 WHERE id = 1
   AND active_voice_credential_id IS NULL;

-- Finally · remove the migrated voice rows from provider_keys so
-- that table is purely skill keys (brave + tavily) from here on.
-- Cleared by name; an explicit IN() list matches what we inserted
-- above. After this migration, `getKey("minimax")` and
-- `getKey("elevenlabs")` always return null; callers must read
-- the active voice credential instead.
DELETE FROM provider_keys
 WHERE provider IN ('minimax','elevenlabs');
