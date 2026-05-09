-- Daily-granularity token usage log · the cumulative `agents.tokens_consumed`
-- column stays the canonical "All / lifetime" total, but the user-settings
-- Usage panel now also renders a 14-day stacked bar chart that needs
-- per-day-per-model resolution. This table is the source for that chart.
--
-- Granularity: (day · agent_id · model_v).
--   day      · 'YYYY-MM-DD' formatted in the server's local time at
--              billing time. Local-first software running on the user's
--              own machine, so wall-clock matches their intuition of
--              "today" without TZ gymnastics on the client.
--   agent_id · who actually spoke that day (the column the UI uses to
--              render per-agent rows in the day's drill-down).
--   model_v  · SNAPSHOT at billing time. If the user reassigns an
--              agent's model later, that day's history stays tied to
--              the model that actually ran — without this, all of an
--              agent's history would silently re-skin under the new
--              model on next chart render.
--
-- Writes happen atomically alongside the `agents.tokens_consumed`
-- update in `incrementAgentTokens()` (UPSERT here, UPDATE there, single
-- transaction). Single chokepoint; every billing path (director turns,
-- chair turns, brief stages 1/1.5/2/3) flows through it.
--
-- No backfill: pre-migration cumulative stays in `agents.tokens_consumed`
-- and continues to drive the "All · cumulative" view in the UI. Day-level
-- history begins from migration day; days before that render as empty
-- bars in the 14-day chart.

CREATE TABLE IF NOT EXISTS usage_daily (
  day      TEXT    NOT NULL,
  agent_id TEXT    NOT NULL,
  model_v  TEXT    NOT NULL,
  tokens   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, agent_id, model_v)
);

-- Day-only index for the 14-day window query (`WHERE day >= ?`). The
-- composite primary key already covers (day, agent_id, ...) in lookup
-- order so the per-row UPSERT path doesn't need a separate index.
CREATE INDEX IF NOT EXISTS usage_daily_day ON usage_daily(day);
