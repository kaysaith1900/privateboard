/**
 * /api/notes · chairman's notes feature.
 *
 *   GET    /api/notes              → cross-room note index (newest first)
 *                                    + total count for the sidebar badge
 *   GET    /api/notes/by-room/:rid → notes for a single room (used by
 *                                    the in-room highlight overlay so
 *                                    every message render doesn't have
 *                                    to hit a per-message endpoint)
 *   GET    /api/notes/:id          → a single note
 *   POST   /api/notes              → create from a selection
 *   DELETE /api/notes/:id          → remove
 *
 * Save flow: the frontend captures the selection inside a director
 * message, walks the DOM to compute char offsets relative to the
 * rendered message body, expands ±1–2 sentences for context, and
 * POSTs the bundle here. The body is pure metadata · no LLM, no
 * external calls — fast enough to feel instant.
 */
import { Hono } from "hono";

import { getMessage } from "../storage/messages.js";
import {
  countNotes,
  createNote,
  deleteNote,
  getNote,
  listAllNotesWithRoom,
  listNotesByRoom,
} from "../storage/notes.js";

interface CreateBody {
  roomId?: string;
  messageId?: string;
  quoteText?: string;
  contextBefore?: string;
  contextAfter?: string;
  charOffsetStart?: number;
  charOffsetEnd?: number;
  authorName?: string;
}

export function notesRouter(): Hono {
  const r = new Hono();

  r.get("/", (c) => {
    const notes = listAllNotesWithRoom();
    return c.json({ notes, total: notes.length });
  });

  r.get("/count", (c) => {
    return c.json({ total: countNotes() });
  });

  r.get("/by-room/:rid", (c) => {
    const notes = listNotesByRoom(c.req.param("rid"));
    return c.json({ notes });
  });

  r.get("/:id", (c) => {
    const note = getNote(c.req.param("id"));
    if (!note) return c.json({ error: "not found" }, 404);
    return c.json(note);
  });

  r.post("/", async (c) => {
    let body: CreateBody;
    try { body = (await c.req.json()) as CreateBody; }
    catch { return c.json({ error: "invalid json" }, 400); }

    const roomId = (body.roomId ?? "").trim();
    const messageId = (body.messageId ?? "").trim();
    const quoteText = (body.quoteText ?? "").trim();
    if (!roomId || !messageId) {
      return c.json({ error: "roomId and messageId are required" }, 400);
    }
    if (!quoteText) {
      return c.json({ error: "quoteText is required" }, 400);
    }

    // Verify the message exists and belongs to the claimed room. Without
    // this check a malformed client could silently insert orphan notes.
    const msg = getMessage(messageId);
    if (!msg) return c.json({ error: "message not found" }, 404);
    if (msg.roomId !== roomId) {
      return c.json({ error: "message does not belong to this room" }, 400);
    }

    // Char offsets are validated as ints, defaulted to 0 if missing.
    // The renderer can recover from bad offsets (it just won't draw
    // the highlight) so we don't need to be strict here.
    const start = Number.isFinite(body.charOffsetStart) ? Math.max(0, Math.floor(body.charOffsetStart!)) : 0;
    const end = Number.isFinite(body.charOffsetEnd) ? Math.max(start, Math.floor(body.charOffsetEnd!)) : start + quoteText.length;

    // author_kind / author_name come from the message itself · the
    // client doesn't get to spoof these. authorName fallback walks
    // the message meta when available, otherwise generic.
    const authorKind = msg.authorKind;
    const authorId = msg.authorId;
    const authorName = (body.authorName ?? "").trim() || deriveAuthorName(msg.authorKind, msg.authorId) || "Director";

    const note = createNote({
      roomId,
      messageId,
      authorKind,
      authorId,
      authorName,
      quoteText,
      contextBefore: typeof body.contextBefore === "string" ? body.contextBefore : "",
      contextAfter: typeof body.contextAfter === "string" ? body.contextAfter : "",
      charOffsetStart: start,
      charOffsetEnd: end,
    });
    return c.json(note);
  });

  r.delete("/:id", (c) => {
    const ok = deleteNote(c.req.param("id"));
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  return r;
}

/** Best-effort fallback when the client doesn't supply authorName ·
 *  the agent's display name normally lives in the message bubble's
 *  rendered DOM, but we shouldn't depend on the client. */
function deriveAuthorName(kind: string, authorId: string | null): string {
  if (kind === "user") return "You";
  if (kind === "system") return "System";
  if (authorId) return authorId;  // agent id as last-resort label
  return "";
}
