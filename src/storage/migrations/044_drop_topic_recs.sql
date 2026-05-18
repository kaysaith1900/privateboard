-- 044_drop_topic_recs.sql
--
-- The interest-driven topic-recommendations feature ("找你可能感
-- 兴趣的话题" trigger card + the recommendation cards under the
-- home composer) has been removed. Its replacement is a static
-- catalog of five scenario ad cards rendered purely on the
-- frontend (see public/app.js · SCENARIO_CARDS), so there is no
-- need to keep the storage tables that fed the old dynamic tray.
--
-- Tables (and their indexes) removed:
--   · topic_rec_jobs        · async generation job tracking
--   · topic_recs            · synthesised recommendation rows
--   · topic_rec_batches     · one row per generation run
--
-- Drop order matters: topic_recs / topic_rec_jobs both FK into
-- topic_rec_batches (ON DELETE CASCADE / SET NULL), so SQLite
-- needs the child tables removed first when foreign_keys is ON.
-- `DROP TABLE IF EXISTS` is idempotent — re-runs are a no-op.

DROP TABLE IF EXISTS topic_recs;
DROP TABLE IF EXISTS topic_rec_jobs;
DROP TABLE IF EXISTS topic_rec_batches;
