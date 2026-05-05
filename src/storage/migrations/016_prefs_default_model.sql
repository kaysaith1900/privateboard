-- Global default model · the modelV new agents inherit at create time
-- and the runtime fallback when an agent's stored modelV becomes
-- unreachable (user revoked the underlying API key). NULL on legacy
-- rows; the availability layer's `defaultModelFor()` helper picks a
-- sensible value at first use and the prefs row gets back-filled.
ALTER TABLE prefs ADD COLUMN default_model_v TEXT;
