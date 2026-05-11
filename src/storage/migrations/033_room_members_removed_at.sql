-- Soft-delete column on room_members so excused directors stay
-- queryable for chat-history rendering + voice replay. NULL marks
-- an active member; a non-null timestamp records when the chair
-- excused them from the room. Prior to this migration a director
-- removal hard-DELETEd the row, which dropped the director from
-- `listRoomMembers` and broke speaker-name lookups + voice profile
-- resolution for their past messages.
ALTER TABLE room_members ADD COLUMN removed_at INTEGER;
