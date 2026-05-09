-- When both Brave Search and Tavily API keys exist, picks which backend
-- serves Web Search turns. Single-key setups ignore this · the active
-- backend is inferred from whichever key is present.
ALTER TABLE prefs ADD COLUMN web_search_provider TEXT NOT NULL DEFAULT 'brave';
