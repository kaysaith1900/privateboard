-- Soft pause for the chair's opening clarification phase. While set, the
-- orchestrator routes user replies through the chair instead of the
-- director queue, so the chair can ask multiple follow-up questions
-- before releasing the directors. Capped at 3 chair turns by the
-- orchestrator to prevent unbounded loops.
ALTER TABLE rooms ADD COLUMN awaiting_clarify INTEGER NOT NULL DEFAULT 0;
