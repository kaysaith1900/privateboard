/**
 * /api/sync · the desktop iCloud-sync control surface for the settings UI.
 *   GET  /api/sync/status → live status (enabled / available / state / progress)
 *   PUT  /api/sync        → { enabled } · turn Apple-account sync on/off (persisted)
 *   POST /api/sync/now    → force a convergence beat now
 * The heavy lifting lives in the SyncManager singleton; these are thin wrappers.
 */
import { Hono } from "hono";

import { syncManager } from "../sync/desktop.js";

export function syncRouter(): Hono {
  const r = new Hono();

  r.get("/status", async (c) => c.json(await syncManager.getStatus()));

  r.put("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const enabled = !!(body as { enabled?: unknown })?.enabled;
    try {
      return c.json(await syncManager.setEnabled(enabled));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  r.post("/now", async (c) => c.json(await syncManager.syncNow()));

  return r;
}
