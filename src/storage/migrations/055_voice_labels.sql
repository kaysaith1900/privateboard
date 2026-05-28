-- 055_voice_labels.sql · Persist user-supplied friendly names for
-- provider voice_ids that don't have a name field of their own.
--
-- MiniMax's `voice_clone` API has no `name` parameter — the voice_id
-- IS the dashboard label — so when the user typed "Chloe" in the
-- clone modal, that string never reaches MiniMax. Previously we
-- mirrored the label to localStorage, which dies the moment the
-- user clears site data or moves to another machine. This table is
-- the durable record. `listVoicesPage` merges it into the catalogue
-- response so the picker / trigger / message-author labels stay
-- friendly across reloads, devices, and DB exports.
--
-- Fields:
--   voice_id    TEXT PRIMARY KEY · provider-issued voice id
--   provider    TEXT NOT NULL    · 'minimax' | 'elevenlabs'
--   label       TEXT NOT NULL    · user-typed name from the clone modal
--   created_at  INTEGER NOT NULL · epoch ms
--   updated_at  INTEGER NOT NULL · epoch ms · refreshed on rename

CREATE TABLE IF NOT EXISTS voice_labels (
  voice_id   TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS voice_labels_provider_idx
  ON voice_labels(provider);
