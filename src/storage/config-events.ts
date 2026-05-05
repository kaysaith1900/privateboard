/** Lifecycle events for a room — opened / adjourned / member-add / pause / etc. */
import { newId } from "../utils/id.js";

import { getDb } from "./db.js";

export interface ConfigEvent {
  id: string;
  roomId: string;
  kind: string;
  payload: Record<string, unknown> | null;
  actorKind: "user" | "system";
  createdAt: number;
}

interface Row {
  id: string;
  room_id: string;
  kind: string;
  payload: string | null;
  actor_kind: string;
  created_at: number;
}

function mapRow(row: Row): ConfigEvent {
  return {
    id: row.id,
    roomId: row.room_id,
    kind: row.kind,
    payload: row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null,
    actorKind: row.actor_kind as "user" | "system",
    createdAt: row.created_at,
  };
}

export function listConfigEvents(roomId: string): ConfigEvent[] {
  const rows = getDb()
    .prepare(
      "SELECT id, room_id, kind, payload, actor_kind, created_at FROM config_events " +
        "WHERE room_id = ? ORDER BY created_at ASC",
    )
    .all(roomId) as Row[];
  return rows.map(mapRow);
}

export interface ConfigEventInsert {
  roomId: string;
  kind: string;
  payload?: Record<string, unknown> | null;
  actorKind: "user" | "system";
}

export function insertConfigEvent(e: ConfigEventInsert): ConfigEvent {
  const id = newId();
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO config_events (id, room_id, kind, payload, actor_kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, e.roomId, e.kind, e.payload ? JSON.stringify(e.payload) : null, e.actorKind, now);
  return {
    id,
    roomId: e.roomId,
    kind: e.kind,
    payload: e.payload ?? null,
    actorKind: e.actorKind,
    createdAt: now,
  };
}
