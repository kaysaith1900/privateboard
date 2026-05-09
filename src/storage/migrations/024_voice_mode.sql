-- Voice mode · per-room delivery mode and per-agent TTS voice profile.
-- `delivery_mode = voice` switches director prompts and orchestrator pacing.
-- `agents.voice_json` stores provider/model/voiceId/speed/pitch/volume/instructions.
ALTER TABLE rooms ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'text';
ALTER TABLE agents ADD COLUMN voice_json TEXT;
