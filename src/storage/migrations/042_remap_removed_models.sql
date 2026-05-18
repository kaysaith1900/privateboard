-- 039_remap_removed_models.sql
--
-- Remap stored modelV strings for the six modelVs deleted from the
-- registry on 2026-05-17 (B.AI catalog reconcile + xAI removal):
--
--   opus-4-6        → opus-4-7    (Anthropic flagship peer)
--   gpt-5-5-pro     → gpt-5-5     (drop the -pro suffix; same family)
--   kimi-2-6        → kimi-k2-6   (current Kimi model · OR slug `moonshotai/kimi-k2.6`)
--   grok-4-3        → sonnet-4-6  (no Grok in registry; safe default)
--   grok-4-1-fast   → haiku-4-5   (fast-tier peer)
--   grok-4-20       → opus-4-7    (long-context peer; was 2M ctx)
--
-- Two live tables hold modelV: agents.model_v (every agent record) and
-- prefs.default_model_v (the user's default-model choice). Historical
-- snapshot tables (room_summaries.model_v, retired_token_usage.model_v,
-- usage_daily.model_v) are NOT touched — they record what actually ran
-- at the time and rewriting them would lie about history.
--
-- Idempotent · `WHERE model_v = '<old>'` is a no-op on second run.

UPDATE agents SET model_v = 'opus-4-7'   WHERE model_v = 'opus-4-6';
UPDATE agents SET model_v = 'gpt-5-5'    WHERE model_v = 'gpt-5-5-pro';
UPDATE agents SET model_v = 'kimi-k2-6'  WHERE model_v = 'kimi-2-6';
UPDATE agents SET model_v = 'sonnet-4-6' WHERE model_v = 'grok-4-3';
UPDATE agents SET model_v = 'haiku-4-5'  WHERE model_v = 'grok-4-1-fast';
UPDATE agents SET model_v = 'opus-4-7'   WHERE model_v = 'grok-4-20';

UPDATE prefs SET default_model_v = 'opus-4-7'   WHERE default_model_v = 'opus-4-6';
UPDATE prefs SET default_model_v = 'gpt-5-5'    WHERE default_model_v = 'gpt-5-5-pro';
UPDATE prefs SET default_model_v = 'kimi-k2-6'  WHERE default_model_v = 'kimi-2-6';
UPDATE prefs SET default_model_v = 'sonnet-4-6' WHERE default_model_v = 'grok-4-3';
UPDATE prefs SET default_model_v = 'haiku-4-5'  WHERE default_model_v = 'grok-4-1-fast';
UPDATE prefs SET default_model_v = 'opus-4-7'   WHERE default_model_v = 'grok-4-20';
