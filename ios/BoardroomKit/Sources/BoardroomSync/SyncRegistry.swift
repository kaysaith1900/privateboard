// iCloud sync · canonical entity registry (port of `src/sync/registry.ts`).
// Must stay 1:1 with the desktop registry — same canonical names, pks, modes.
// Device-local tables are omitted by design (omission == never synced).

public enum SyncRegistry {
    public static let entities: Registry = [
        // The "brain".
        "agents":           EntitySpec(entity: "agents",           table: "agents",           pk: "id", mode: .lww,
                                       blobCols: ["avatar_path"]), // data-URL portraits → content-addressed blobs
        "agent_memories":   EntitySpec(entity: "agent_memories",   table: "agent_memories",   pk: "id", mode: .append),
        "user_long_memory": EntitySpec(entity: "user_long_memory", table: "user_long_memory", pk: "id", mode: .append),
        // Sessions + transcripts. rooms.number is a UNIQUE per-device counter —
        // never synced; a fresh insert gets a local MAX()+1.
        "rooms":            EntitySpec(entity: "rooms",            table: "rooms",            pk: "id", mode: .lww,
                                       insertDefaults: ["number": "(SELECT COALESCE(MAX(number),0)+1 FROM rooms)"]),
        // room_members has a composite real PK (room_id, agent_id); migration 062
        // adds a deterministic surrogate `id = room_id||':'||agent_id` so it syncs
        // through the single-PK machinery (captured cols carry room_id + agent_id, so
        // an apply insert satisfies the composite PK). Without it, synced rooms had
        // no directors. Must stay 1:1 with src/sync/registry.ts.
        "room_members":     EntitySpec(entity: "room_members",     table: "room_members",     pk: "id", mode: .lww),
        "messages":         EntitySpec(entity: "messages",         table: "messages",         pk: "id", mode: .append),
        "key_points":       EntitySpec(entity: "key_points",       table: "key_points",       pk: "id", mode: .lww),
        "briefs":           EntitySpec(entity: "briefs",           table: "briefs",           pk: "id", mode: .append),
        "notes":            EntitySpec(entity: "notes",            table: "notes",            pk: "id", mode: .lww),
    ]
}
