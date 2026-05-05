-- Token usage rollup for deleted custom agents.
--
-- When a user deletes a custom agent, the row is removed from the
-- `agents` table — but the LLM calls that agent already made were real:
-- the user already paid for those tokens, and the Usage panel's totals
-- become a lie if they silently disappear.
--
-- Before each `DELETE FROM agents`, the storage layer transfers the
-- agent's `tokens_consumed` into this rollup table, keyed by model.
-- Per-agent identity is intentionally lost (deletion = "make it go
-- away"), but the model rollup and the grand total stay honest.
--
-- Columns:
--   model_v     The model the retired agents used. Multiple deleted
--               agents that shared a model collapse into one row.
--   tokens      Cumulative tokens billed against retired agents on
--               this model.
--   agents      Number of agents folded into this row (used by the
--               UI to surface "+ N retired agents · X tokens").
--   updated_at  Last time a deletion landed here.

CREATE TABLE retired_token_usage (
  model_v     TEXT    PRIMARY KEY,
  tokens      INTEGER NOT NULL DEFAULT 0,
  agents      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
