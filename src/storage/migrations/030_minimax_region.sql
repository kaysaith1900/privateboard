-- MiniMax API region preference.
-- "cn" = China mainland (api.minimaxi.com)
-- "intl" = International (api.minimax.io)
-- Default "cn" because the China endpoint is more commonly used.
ALTER TABLE prefs ADD COLUMN minimax_region TEXT NOT NULL DEFAULT 'cn';
