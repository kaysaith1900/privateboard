// iCloud sync · the canonical entity registry — which local tables sync and
// how they merge. Column lists are intentionally absent: the engine is
// column-agnostic (it applies whatever an op carries), so this only binds the
// canonical name → table + primary key + merge mode. Device-local tables
// (usage_daily, qd_archive, negative_space, topic_branches, room_summaries,
// agent_dreams, *_jobs, credentials, prefs pointers, UI state) are OMITTED by
// design — omission == "never synced".
//
// `lww`    = mutable · per-field last-writer-wins.
// `append` = immutable · union by pk, first write wins.

import type { Registry } from "./types.js";

export const ENTITIES: Registry = {
  // The "brain" — highest value, lowest conflict.
  agents:           { entity: "agents",           table: "agents",           pk: "id", mode: "lww",
                      blobCols: ["avatar_path"] }, // data-URL portraits → content-addressed blobs
  agent_memories:   { entity: "agent_memories",   table: "agent_memories",   pk: "id", mode: "append" },
  user_long_memory: { entity: "user_long_memory", table: "user_long_memory", pk: "id", mode: "append" },

  // Sessions + transcripts. rooms.number is a UNIQUE per-device counter — never
  // synced; a fresh insert gets a local MAX()+1. (room_members has a composite
  // PK and is handled in a later migration — omitted here.)
  rooms:            { entity: "rooms",            table: "rooms",            pk: "id", mode: "lww",
                      insertDefaults: { number: "(SELECT COALESCE(MAX(number),0)+1 FROM rooms)" } },
  messages:         { entity: "messages",         table: "messages",         pk: "id", mode: "append" },
  key_points:       { entity: "key_points",       table: "key_points",       pk: "id", mode: "lww" },
  briefs:           { entity: "briefs",           table: "briefs",           pk: "id", mode: "append" },
  notes:            { entity: "notes",            table: "notes",            pk: "id", mode: "lww" },
};
