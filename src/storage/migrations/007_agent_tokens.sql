-- Track cumulative tokens consumed by each agent across every LLM
-- turn they've been the speaker for. Counted from the Vercel AI SDK's
-- usage report when each director / chair stream finishes — see
-- src/orchestrator/room.ts. Rooms-joined and rounds-spoken are
-- derived on read (room_members count, distinct round_num count).
ALTER TABLE agents ADD COLUMN tokens_consumed INTEGER NOT NULL DEFAULT 0;
