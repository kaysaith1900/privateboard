/**
 * /api/usage · cumulative LLM-call accounting surfaced in the Usage
 * panel of the user-settings overlay.
 *
 *   GET /summary  → { totalTokens, agentCount, byModel[], byAgent[] }
 *
 * Tokens are aggregated from `agents.tokens_consumed`, which the
 * orchestrator increments after every successful turn (director +
 * chair + composer + brief stages all bill to the speaking agent).
 *
 * The endpoint also enriches `byModel` with display metadata from
 * the model registry so the frontend doesn't have to keep a parallel
 * map. Unknown / dropped model versions (e.g. an agent still pointing
 * at a retired slug) are returned with the raw `modelV` and a synthetic
 * displayName so they remain visible in the chart instead of silently
 * disappearing.
 */
import { Hono } from "hono";

import { getUsageSummary } from "../storage/agents.js";
import { isModelV, MODELS } from "../ai/registry.js";

interface ModelDisplay {
  displayName: string;
  provider: string;
}
function modelDisplay(modelV: string): ModelDisplay {
  if (isModelV(modelV)) {
    const m = MODELS[modelV];
    return { displayName: m.displayName, provider: m.provider };
  }
  return { displayName: modelV, provider: "unknown" };
}

export function usageRouter(): Hono {
  const r = new Hono();

  r.get("/summary", (c) => {
    const s = getUsageSummary();
    return c.json({
      totalTokens: s.totalTokens,
      agentCount: s.agentCount,
      byModel: s.byModel.map((m) => ({
        modelV: m.modelV,
        tokens: m.tokens,
        agents: m.agents,
        ...modelDisplay(m.modelV),
      })),
      byAgent: s.byAgent.map((a) => ({
        ...a,
        ...modelDisplay(a.modelV),
      })),
      retired: {
        tokens: s.retired.tokens,
        agents: s.retired.agents,
        byModel: s.retired.byModel.map((m) => ({
          modelV: m.modelV,
          tokens: m.tokens,
          agents: m.agents,
          ...modelDisplay(m.modelV),
        })),
      },
      // Rolling 14-day window for the bar chart at the top of the
      // Usage panel. Each entry mirrors the cumulative summary's
      // byModel / byAgent shape so the frontend can feed the same
      // render component either source (cumulative · day-specific).
      daily: s.daily.map((d) => ({
        day: d.day,
        totalTokens: d.totalTokens,
        byModel: d.byModel.map((m) => ({
          modelV: m.modelV,
          tokens: m.tokens,
          agents: m.agents,
          ...modelDisplay(m.modelV),
        })),
        byAgent: d.byAgent.map((a) => ({
          ...a,
          ...modelDisplay(a.modelV),
        })),
      })),
    });
  });

  return r;
}
