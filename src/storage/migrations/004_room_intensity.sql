-- Add intensity column for the calm | sharp | brutal slider on convene.
-- 'sharp' is the prototype default.
ALTER TABLE rooms ADD COLUMN intensity TEXT NOT NULL DEFAULT 'sharp';
