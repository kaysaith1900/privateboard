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
        // never synced; a fresh insert gets a local MAX()+1. (room_members has a
        // composite PK · handled in a later migration — omitted here.)
        "rooms":            EntitySpec(entity: "rooms",            table: "rooms",            pk: "id", mode: .lww,
                                       insertDefaults: ["number": "(SELECT COALESCE(MAX(number),0)+1 FROM rooms)"]),
        "messages":         EntitySpec(entity: "messages",         table: "messages",         pk: "id", mode: .append),
        "key_points":       EntitySpec(entity: "key_points",       table: "key_points",       pk: "id", mode: .lww),
        "briefs":           EntitySpec(entity: "briefs",           table: "briefs",           pk: "id", mode: .append),
        "notes":            EntitySpec(entity: "notes",            table: "notes",            pk: "id", mode: .lww),
    ]
}
