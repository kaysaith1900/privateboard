/**
 * Cross-room keyword search · GET /api/search?q=<term>
 *
 * Substring search over messages.body. Returns hits enriched with
 * room name + author name so the sidebar's Search view can render
 * a result list without a second round-trip per row.
 *
 * Cap is generous (200 hits) since SQLite LIKE on a few thousand
 * rows is sub-millisecond on local-first hardware. The frontend
 * additionally clusters results by room before rendering.
 */
import { Hono } from "hono";

import { listAllAgents } from "../storage/agents.js";
import { searchMessages } from "../storage/messages.js";
import { listRooms } from "../storage/rooms.js";

export function searchRouter(): Hono {
  const r = new Hono();

  r.get("/", (c) => {
    const q = (c.req.query("q") || "").trim();
    if (q.length < 1) {
      return c.json({ query: q, count: 0, results: [] });
    }
    if (q.length > 200) {
      return c.json({ error: "query too long (max 200 chars)" }, 400);
    }
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10) || 200)) : 200;
    const hits = searchMessages(q, limit);
    if (hits.length === 0) {
      return c.json({ query: q, count: 0, results: [] });
    }
    // Enrich · room name from listRooms() (one query, in-memory join)
    // and author name from listAllAgents() so the result row shows
    // "<Agent Name> · <Room Title>" without N+1 lookups.
    const rooms = new Map(listRooms().map((rm) => [rm.id, rm]));
    const agents = new Map(listAllAgents().map((a) => [a.id, a]));
    const results = hits.map((h) => {
      const room = rooms.get(h.roomId);
      const author = h.authorId ? agents.get(h.authorId) : null;
      return {
        messageId: h.messageId,
        roomId: h.roomId,
        roomTitle: room ? (room.subject || "Untitled room") : "Unknown room",
        roomStatus: room ? room.status : "unknown",
        authorKind: h.authorKind,
        authorName: author
          ? author.name
          : h.authorKind === "user"
            ? "You"
            : h.authorKind === "system"
              ? "System"
              : "Director",
        authorAvatar: author ? author.avatarPath : null,
        body: h.body,
        matchOffset: h.matchOffset,
        createdAt: h.createdAt,
      };
    });
    return c.json({ query: q, count: results.length, results });
  });

  return r;
}
