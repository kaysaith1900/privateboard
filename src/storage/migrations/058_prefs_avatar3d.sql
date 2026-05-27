-- 058_prefs_avatar3d.sql · Let the USER (host) have a 3D "捏 avatar" too,
-- mirroring the per-director avatar3d feature (migration 057).
--
-- avatar3d_json · the customizer config { model, hairStyle, outfitStyle,
--   accessory, skin, hair, brow, outfit } so the editor reopens with the
--   saved look. NULL → the user has no 3D avatar (falls back to the 8-bit
--   seed-generated SVG in avatar_seed).
-- avatar_url · the rendered PNG portrait (data URL). Unlike directors, the
--   user's 2D avatar was previously generated on the fly from avatar_seed
--   (no stored image), so we need a column to hold the 3D screenshot that
--   the sidebar / room / settings then display in preference to the SVG.
ALTER TABLE prefs ADD COLUMN avatar3d_json TEXT;
ALTER TABLE prefs ADD COLUMN avatar_url TEXT;
