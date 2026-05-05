/**
 * /api/briefs · top-level brief access.
 *
 *   GET    /api/briefs/:id           → the full brief
 *   GET    /api/briefs/:id/status    → { generating, hasBody, completed }
 *   DELETE /api/briefs/:id           → permanently remove this brief
 *
 * Status is used by the frontend to detect "zombie" placeholders left
 * behind when the user refreshes the browser mid-generation. Delete is
 * used by the brief-card to remove a specific report version from the
 * room's history.
 */
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { Hono } from "hono";

import { getBriefGenerationState, isBriefGenerating } from "../orchestrator/brief.js";
import { deleteBrief, getBrief, listAllBriefs } from "../storage/briefs.js";
import { ensureBoardroomDir } from "../utils/paths.js";

export function briefsRouter(): Hono {
  const r = new Hono();

  // Cross-room brief index for the All Reports page · joins the parent
  // room's name/subject so cards render with full context in one call.
  // Newest first. The body_md / body_json columns ride along so the
  // client can preview the bottom-line judgement without a second
  // request per brief; the route still drops bodies for any brief
  // that's still generating to avoid surfacing partial output.
  r.get("/", (c) => {
    const briefs = listAllBriefs().filter((b) => !isBriefGenerating(b.id) && b.bodyMd && b.bodyMd.trim());
    return c.json({ briefs });
  });

  r.get("/:id", (c) => {
    const b = getBrief(c.req.param("id"));
    if (!b) return c.json({ error: "not found" }, 404);
    return c.json(b);
  });

  r.get("/:id/status", (c) => {
    const id = c.req.param("id");
    const b = getBrief(id);
    if (!b) return c.json({ error: "not found" }, 404);
    const hasBody = !!(b.bodyMd && b.bodyMd.trim());
    const generating = isBriefGenerating(id);
    const completed = hasBody && !generating;
    // When the pipeline is still running, hand back the per-stage
    // snapshot so a freshly-loaded client can rehydrate the loading
    // UI (which stage is active, when each stage started, the ETA
    // window) instead of watching a frozen blank card until the
    // brief finishes streaming.
    const state = generating ? getBriefGenerationState(id) : null;
    return c.json({ generating, hasBody, completed, state });
  });

  r.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (isBriefGenerating(id)) {
      return c.json({ error: "brief is still generating; wait for it to finish" }, 409);
    }
    const ok = deleteBrief(id);
    if (!ok) return c.json({ error: "not found" }, 404);
    // Best-effort cleanup of the markdown export. If the file isn't
    // there (it might never have been written) we just move on.
    try {
      const dirs = ensureBoardroomDir();
      await unlink(join(dirs.briefs, `${id}.md`));
    } catch { /* swallow ENOENT etc — not load-bearing */ }
    return c.json({ ok: true });
  });

  return r;
}
