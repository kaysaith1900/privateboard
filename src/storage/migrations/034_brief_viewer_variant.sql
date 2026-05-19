-- Persist client-picked viewer template for structured briefs (ppt /
-- magazine / newspaper). NULL = legacy deterministic pick from brief id.
ALTER TABLE briefs ADD COLUMN viewer_variant TEXT;
