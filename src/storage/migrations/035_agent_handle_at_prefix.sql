-- 035 · Agent handles · canonical form is `@slug` (was `/slug` before 2026-05).
-- Runs once on upgrade; new installs typically have seed rows already `@…`.
--
-- Rewrites each legacy `/…` handle to `@…` unless another row already owns the
-- target (UNIQUE(handle)) — in that rare case the row is left unchanged; the
-- app still resolves it via getAgentByHandle multi-candidate lookup.

UPDATE agents
SET handle = '@' || substr(agents.handle, 2)
WHERE substr(agents.handle, 1, 1) = '/'
  AND length(agents.handle) >= 2
  AND NOT EXISTS (
    SELECT 1 FROM agents AS o
    WHERE o.id != agents.id
      AND o.handle = '@' || substr(agents.handle, 2)
  );
