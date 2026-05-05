-- ═══════════════════════════════════════════
-- Default seeded directors switch to Opus 4.7.
-- Only agents that are still on the prior default (`sonnet-4-6`) AND were
-- originally seeded by Boardroom (is_seed = 1) get bumped — any agent the
-- user has explicitly customized is left alone.
-- ═══════════════════════════════════════════

UPDATE agents
SET model_v = 'opus-4-7',
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE is_seed = 1 AND model_v = 'sonnet-4-6';
