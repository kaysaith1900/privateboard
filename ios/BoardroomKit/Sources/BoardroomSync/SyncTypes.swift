// iCloud sync · shared types — the faithful Swift port of `src/sync/types.ts`.
// The local GRDB store stays the source of truth; these describe the per-device
// append-only oplog that flows through iCloud.

import Foundation
import GRDB

/// Hybrid logical clock value, encoded string-comparable: `<pt>.<counter>.<device>`.
/// Lexicographic order == LWW order (the device id is the final tiebreak).
public typealias HLC = String

public enum OpType: String, Codable, Sendable {
    case upsert
    case delete
}

/// How an entity merges across devices.
/// - `lww`    · mutable · per-FIELD last-writer-wins.
/// - `append` · immutable · union by primary key, first write wins.
public enum SyncMode: String, Codable, Sendable {
    case lww
    case append
}

/// A column value carried through the oplog. Encodes as a bare JSON scalar
/// (string / number / null) so the oplog line stays clean, and bridges to a
/// GRDB `DatabaseValue` for binding. Opaque-JSON columns (meta_json, …) ride
/// as `.text` of their verbatim string.
public enum SyncValue: Codable, Equatable, Sendable {
    case text(String)
    case int(Int64)
    case double(Double)
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let i = try? c.decode(Int64.self) { self = .int(i); return }
        if let d = try? c.decode(Double.self) { self = .double(d); return }
        self = .text(try c.decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .text(let s): try c.encode(s)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .null: try c.encodeNil()
        }
    }

    public var dbValue: DatabaseValue {
        switch self {
        case .text(let s): return s.databaseValue
        case .int(let i): return i.databaseValue
        case .double(let d): return d.databaseValue
        case .null: return .null
        }
    }

    public init(_ dbv: DatabaseValue) {
        switch dbv.storage {
        case .string(let s): self = .text(s)
        case .int64(let i): self = .int(i)
        case .double(let d): self = .double(d)
        case .blob, .null: self = .null
        }
    }
}

/// One row-level change carried through the oplog (port of `SyncOp`).
public struct SyncOp: Codable, Sendable, Equatable {
    public let op_id: String
    public let device: String
    public let entity: String
    public let pk: String
    public let op: OpType
    public let cols: [String: SyncValue]?   // upsert payload · nil for delete
    public let hlc: HLC
    public let ts: Int64                     // ms epoch

    public init(op_id: String, device: String, entity: String, pk: String,
                op: OpType, cols: [String: SyncValue]?, hlc: HLC, ts: Int64) {
        self.op_id = op_id; self.device = device; self.entity = entity; self.pk = pk
        self.op = op; self.cols = cols; self.hlc = hlc; self.ts = ts
    }

    /// A copy with replaced columns (blob externalize/internalize · structs are value types).
    public func withCols(_ newCols: [String: SyncValue]?) -> SyncOp {
        SyncOp(op_id: op_id, device: device, entity: entity, pk: pk, op: op, cols: newCols, hlc: hlc, ts: ts)
    }
}

/// Binds a canonical entity to its local table + merge rule (port of `EntitySpec`).
/// The engine is otherwise COLUMN-AGNOSTIC.
public struct EntitySpec: Sendable {
    public let entity: String
    public let table: String
    public let pk: String
    public let mode: SyncMode
    /// Device-local NOT-NULL columns NOT synced but required on a fresh insert,
    /// mapped to a trusted raw SQL expression (e.g. rooms.number = local MAX()+1).
    public let insertDefaults: [String: String]
    /// Columns whose large data-URL values are externalized to the blob store.
    public let blobCols: [String]
    public init(entity: String, table: String, pk: String, mode: SyncMode,
                insertDefaults: [String: String] = [:], blobCols: [String] = []) {
        self.entity = entity; self.table = table; self.pk = pk; self.mode = mode
        self.insertDefaults = insertDefaults; self.blobCols = blobCols
    }
}

public typealias Registry = [String: EntitySpec]

/// Sentinel field marking a delete tombstone in `sync_field_version`.
public let ROW_TOMBSTONE = "__row__"
