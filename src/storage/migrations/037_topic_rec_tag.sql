-- Per-topic category tag · the synthesiser produces a 1-2 word
-- label per recommendation (e.g. "strategy", "product", "market",
-- "ops") so the composer card can display a meaningful tag in
-- the left column instead of the source token (which was always
-- "web" / "memory" and didn't tell the user what the topic was
-- about). NULL on rows generated before this migration · the
-- frontend falls back to the source token in that case.
ALTER TABLE topic_recs ADD COLUMN tag TEXT;
