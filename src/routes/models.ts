/**
 * /api/models · model availability surface.
 *
 *   GET /api/models  → which models the user can reach right now,
 *                      grouped by provider, with the route the
 *                      adapter would use (direct vs OpenRouter).
 *                      Plus the global default model + a flag for
 *                      whether ANY LLM key is configured (the
 *                      bootstrap state for the frontend redirect).
 *
 * Frontend pickers (composer, agent profile, agent creation) call
 * this once on mount + after any /api/keys mutation, and filter
 * their dropdowns to `reachable === true`.
 */
import { Hono } from "hono";

import {
  effectiveDefaultModel,
  hasAnyModelKey,
  modelAvailability,
  utilityModelFor,
  type ModelAvailability,
} from "../ai/availability.js";

export function modelsRouter(): Hono {
  const r = new Hono();

  r.get("/", (c) => {
    const all = modelAvailability();
    const reachable = all.filter((m) => m.reachable);
    return c.json({
      /** Whether any LLM provider key is configured. False → frontend
       *  redirects the user to the API Key settings before letting
       *  them create agents / convene rooms. */
      hasAnyKey: hasAnyModelKey(),
      /** Every model in the registry · reachable or not. Settings UI
       *  uses this to show "this model would unlock if you add the
       *  Anthropic key" hints. */
      models: all,
      /** Convenience subset · just the models the user can actually
       *  use today. Pickers should default to this list. */
      reachable,
      /** Global default model · what new agents inherit and what
       *  stale-modelV agents fall back to. NULL when no key is
       *  configured yet. */
      defaultModelV: effectiveDefaultModel(),
      /** Cheap utility model used by background tasks (skill picker,
       *  director auto-pick, agent-spec gen, ability analyzer,
       *  convening speech). NULL when no key is configured. */
      utilityModelV: utilityModelFor(),
      /** Provider summary · so the frontend can show "you have OR +
       *  OpenAI direct" at a glance without iterating models. */
      providers: collectProviderSummary(all),
    });
  });

  return r;
}

function collectProviderSummary(models: ModelAvailability[]): Array<{
  provider: string;
  reachable: number;
  total: number;
}> {
  const map = new Map<string, { reachable: number; total: number }>();
  for (const m of models) {
    const cur = map.get(m.provider) ?? { reachable: 0, total: 0 };
    cur.total++;
    if (m.reachable) cur.reachable++;
    map.set(m.provider, cur);
  }
  return Array.from(map.entries()).map(([provider, v]) => ({ provider, ...v }));
}
