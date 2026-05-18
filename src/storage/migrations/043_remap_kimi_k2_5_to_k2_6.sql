-- 040_remap_kimi_k2_5_to_k2_6.sql
--
-- Bump stored `kimi-k2-5` rows to `kimi-k2-6` after the Kimi registry
-- entry was renamed (OpenRouter exposes the slug as
-- `moonshotai/kimi-k2.6`; the prior `moonshotai/kimi-k2.5` slug 404s).
--
-- This complements 039_remap_removed_models.sql: 039 was edited to
-- land users directly on `kimi-k2-6` for first-time runs, but any DB
-- that already ran the previous 039 (which mapped to `kimi-k2-5`) is
-- left holding the now-unknown `kimi-k2-5` string. This migration
-- fixes those. Idempotent · WHERE clause is a no-op on second run.
--
-- Live tables only (`agents.model_v`, `prefs.default_model_v`).
-- Historical snapshot tables are not touched — they record what
-- actually ran at the time.

UPDATE agents SET model_v = 'kimi-k2-6'  WHERE model_v = 'kimi-k2-5';
UPDATE prefs  SET default_model_v = 'kimi-k2-6'  WHERE default_model_v = 'kimi-k2-5';
