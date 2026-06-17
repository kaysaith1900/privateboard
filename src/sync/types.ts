// iCloud sync · shared types for the platform-agnostic oplog engine.
// The local SQLite db stays the source of truth; these describe the change
// log that flows through iCloud (file-based, append-only, per device).

/** Hybrid logical clock value, encoded string-comparable: `<pt>.<counter>.<device>`.
 *  Lexicographic order == causal/LWW order, with the device id as the final
 *  deterministic tiebreak so two devices never deadlock on an equal instant. */
export type HLC = string;

export type OpType = "upsert" | "delete";

/** How an entity merges across devices.
 *  - `lww`    · mutable row · per-FIELD last-writer-wins (two devices editing
 *               different columns of the same row both win, no lost edits).
 *  - `append` · immutable row · union by primary key, first write wins,
 *               later writes for the same pk are ignored (messages, briefs…). */
export type SyncMode = "lww" | "append";

/** One row-level change carried through the oplog. `cols` holds the changed
 *  columns for an upsert (all NOT-NULL columns on a row's first/insert op;
 *  just the touched columns on a later edit). Opaque JSON columns
 *  (meta_json, persona_spec_json, …) travel as their verbatim string value. */
export interface SyncOp {
  op_id: string;       // globally-unique (uuid) · the idempotency / echo key
  device: string;      // origin device id
  entity: string;      // canonical entity name (see EntitySpec.entity)
  pk: string;          // the row's primary-key value
  op: OpType;
  cols?: Record<string, unknown> | null; // upsert payload · null/undefined for delete
  hlc: HLC;
  ts: number;          // ms epoch the op was created (ledger / diagnostics)
}

/** Binds a canonical entity to its local table + merge rule. The engine is
 *  otherwise COLUMN-AGNOSTIC: it applies whatever columns an op carries, so
 *  the same code serves every table and both platforms. */
export interface EntitySpec {
  entity: string;  // canonical name shared across platforms
  table: string;   // local table name
  pk: string;      // primary-key column
  mode: SyncMode;
  /** Device-local NOT-NULL columns that are NOT synced but must be supplied on
   *  a fresh insert. Maps column → a raw SQL expression evaluated at apply time
   *  (trusted, from this registry — e.g. rooms.number = a local MAX()+1 counter). */
  insertDefaults?: Record<string, string>;
  /** Columns whose large data-URL values are externalized to the blob store
   *  instead of being carried inline in the oplog (e.g. agents.avatar_path). */
  blobCols?: string[];
}

export type Registry = Record<string, EntitySpec>;

/** Sentinel field name used in `sync_field_version` to mark a delete tombstone. */
export const ROW_TOMBSTONE = "__row__";
