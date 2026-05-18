-- 042_active_llm_provider_pref.sql
--
-- Multi-SIM LLM provider model · users keep multiple LLM keys on file
-- and flag exactly one as the active routing carrier. This column
-- replaces the destructive-collapse approach 041 attempted; key rows
-- are preserved, the user switches by changing this pref value.
--
-- Seed value · the highest-priority LLM key currently configured at
-- migration time (matches the ordering used by `LLM_PROVIDER_PRIORITY`
-- in `src/ai/providers.ts`). NULL when no LLM key exists. The runtime
-- still derives `defaultModelV` from this carrier; reconcile sweeps
-- agents accordingly.
--
-- Future addition of LLM providers: this migration's seed is one-shot
-- and only matters for existing users. New installs hit the empty
-- column and walk through onboarding to set their first provider as
-- active.

ALTER TABLE prefs ADD COLUMN active_llm_provider TEXT;

-- Seed from existing key set · pick the highest-priority configured
-- LLM provider (openrouter > bai > anthropic > openai > google > xai).
-- The seed is a one-shot UPDATE that only matches rows where the new
-- column is still NULL (= every existing prefs row).
UPDATE prefs
   SET active_llm_provider = (
     SELECT provider
       FROM provider_keys
      WHERE provider IN ('openrouter','bai','anthropic','openai','google','xai')
        AND length(key_blob) > 0
      ORDER BY CASE provider
                 WHEN 'openrouter' THEN 1
                 WHEN 'bai'        THEN 2
                 WHEN 'anthropic'  THEN 3
                 WHEN 'openai'     THEN 4
                 WHEN 'google'     THEN 5
                 WHEN 'xai'        THEN 6
               END
      LIMIT 1
   )
 WHERE active_llm_provider IS NULL;
