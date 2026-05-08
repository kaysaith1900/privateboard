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

import { abortBriefGeneration, getBriefGenerationState, isBriefGenerating } from "../orchestrator/brief.js";
import { countBriefs, deleteBrief, getBrief, listAllBriefs, type Brief } from "../storage/briefs.js";
import { ensureBoardroomDir } from "../utils/paths.js";

/** Mode-aware "has the brief landed its body content yet?" check.
 *  Research-note briefs put their content in body_md (markdown);
 *  bento briefs put theirs in body_json (BentoScaffold) and leave
 *  body_md empty by design. Without this routing, bento briefs were
 *  reported as `hasBody: false` forever after generation completed,
 *  which kept the frontend's "View Report" button hidden — the user
 *  saw their brief disappear after a page refresh. */
function briefHasBody(b: Brief): boolean {
  if (b.mode === "bento") {
    const j = b.bodyJson as { title?: unknown } | null;
    return !!(j && typeof j === "object" && typeof j.title === "string" && j.title.length > 0);
  }
  return !!(b.bodyMd && b.bodyMd.trim().length > 0);
}

export function briefsRouter(): Hono {
  const r = new Hono();

  // Cross-room brief index for the All Reports page · joins the parent
  // room's name/subject so cards render with full context in one call.
  // Newest first. The body_md / body_json columns ride along so the
  // client can preview the bottom-line judgement without a second
  // request per brief; the route still drops bodies for any brief
  // that's still generating to avoid surfacing partial output.
  r.get("/", (c) => {
    const briefs = listAllBriefs().filter((b) => !isBriefGenerating(b.id) && briefHasBody(b));
    return c.json({ briefs });
  });

  // Cheap count for the All Reports sidebar badge · mirrors
  // /api/notes/count. Counts briefs with non-empty body so the badge
  // matches what /api/briefs actually renders.
  r.get("/count", (c) => {
    return c.json({ total: countBriefs() });
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
    const hasBody = briefHasBody(b);
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
    // If the brief is still being generated, abort the in-flight
    // pipeline FIRST so the LLM upstream fetches die immediately
    // (saves tokens). The pipeline's `finally` block will clear the
    // in-flight map entry. We then delete the row regardless — a
    // user-initiated cancellation IS the deletion. The previous
    // 409-return-and-block behaviour was hostile to users who
    // realised mid-generation they didn't want this brief after all.
    if (isBriefGenerating(id)) {
      abortBriefGeneration(id);
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
