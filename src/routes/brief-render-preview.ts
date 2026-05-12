/**
 * Theme preview for the adjourn / supplement modal · Stage 1 + composer (report)
 * + deterministic structured variants. Mounted on the *parent* app as
 * `/api/rooms/:id/brief-render-preview` — not only on roomsRouter().
 *
 * Rationale (2026 · user report): registering only under `app.route('/api/rooms',
 * roomsRouter)` made POST occasionally fall through to `serveStatic` and return an
 * empty 404, even though the handler existed in TS. Matching the absolute path on
 * the root Hono instance removes that ambiguity.
 */
import type { Context } from "hono";

import { hasAnyModelKey } from "../ai/availability.js";
import { previewBriefRender } from "../orchestrator/brief.js";
import { getRoom } from "../storage/rooms.js";

export function briefRenderPreviewGET(c: Context) {
  const id = c.req.param("id");
  c.header("Allow", "POST");
  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      error:
        "This endpoint expects POST only. Opening it in the browser sends GET.",
      hint: `curl -sS -X POST "${origin}/api/rooms/${encodeURIComponent(id)}/brief-render-preview"`,
      code: "METHOD_NOT_ALLOWED_USE_POST",
    },
    405,
  );
}

export async function briefRenderPreviewPOST(c: Context) {
  const id = c.req.param("id");
  const room = getRoom(id);
  if (!room) {
    return c.json(
      {
        error: "Unknown room (id not in database or room was deleted).",
        code: "ROOM_NOT_FOUND",
        roomId: id,
      },
      400,
    );
  }
  if (room.status === "adjourned") {
    return c.json({ error: "room adjourned", code: "ROOM_ADJOURNED" }, 409);
  }
  if (!hasAnyModelKey()) {
    return c.json({ error: "no model key configured" }, 503);
  }
  try {
    return c.json(await previewBriefRender(id));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[brief-render-preview] ${msg}\n`);
    return c.json({ error: msg }, 500);
  }
}
