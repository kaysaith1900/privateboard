-- Persisted TTS audio for voice-mode messages · concatenated MP3 bytes
-- captured from live `voice-chunk` SSE stream, finalized on `voice-final`.
CREATE TABLE message_voice (
  message_id  TEXT    PRIMARY KEY,
  audio_mp3   BLOB    NOT NULL,
  meta_json   TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
