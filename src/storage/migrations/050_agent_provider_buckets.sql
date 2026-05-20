-- 050_agent_provider_buckets.sql
--
-- SIM-swap memory for per-agent model + voice picks · keyed by
-- provider. Today every `agents` row stores a single `model_v` and a
-- single `voice_json`; switching the active LLM credential's provider
-- runs `reconcileAgentModels({forcePrimary:true})` which overwrites
-- both fields with random picks from the new carrier's pool · the
-- user's manual per-director picks under the prior provider are lost.
--
-- This migration adds two TEXT columns that hold a JSON map keyed by
-- provider (LLM carrier for `model_by_provider_json`, voice provider
-- for `voice_by_provider_json`). The reconcile pass now:
--   1. Phase 1 · snapshots the current `model_v` / `voice_json` into
--      `bucket[priorProvider]` BEFORE overwriting.
--   2. Phase 2 · reads `bucket[newProvider]` and restores from it if
--      present (reachability-checked for models). Falls back to the
--      existing random-fast-pool pick when the bucket is empty / stale.
--
-- Effect · switching provider feels like a SIM swap. Every per-agent
-- config that existed on a provider is preserved and restored on the
-- next visit to that provider.
--
-- Purely additive · both columns start NULL on every existing row.
-- No data migration step; buckets seed organically as the user picks
-- models / switches providers post-deploy. The migration runner's
-- "already-applied" guard at db.ts handles ALTER retries idempotently
-- if a rebase ever reorders this past a column it adds elsewhere.

ALTER TABLE agents ADD COLUMN model_by_provider_json TEXT;
ALTER TABLE agents ADD COLUMN voice_by_provider_json TEXT;
