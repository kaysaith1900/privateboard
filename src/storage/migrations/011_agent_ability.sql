-- Per-agent base ability profile (radar chart).
-- Stored as JSON: {"dissent": N, "pattern_recall": N, "rigor": N,
-- "empathy": N, "narrative": N, "decisiveness": N} where each N is in
-- 0..10. NULL means "no profile set" — radar falls back to flat 5/all
-- (legacy behaviour). New AI-generated directors carry a profile
-- inferred from their description so the radar reflects personality.
ALTER TABLE agents ADD COLUMN ability_json TEXT;
