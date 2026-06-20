// iCloud sync · the transport seam (port of `src/sync/transport.ts`). The
// engine talks ONLY to this protocol, so the merge core is testable with an
// in-memory fake; the real iCloud file backend (per-device append-only
// `ops-*.jsonl` segments under the ubiquity container) is `ICloudFolderTransport`.

import Foundation

public struct PullResult: Sendable {
    public let ops: [SyncOp]
    /// Updated per-device high-water cursors to persist after a successful apply.
    public let cursors: [String: Int]
    public init(ops: [SyncOp], cursors: [String: Int]) { self.ops = ops; self.cursors = cursors }
}

public protocol SyncTransport: Sendable {
    func push(device: String, ops: [SyncOp]) async throws
    func pull(cursors: [String: Int]) async throws -> PullResult
    /// Content-addressed blob store. Large binary column values (data-URL avatar
    /// portraits) are externalized to `blobs/<sha256>` so they don't bloat the
    /// oplog; getBlob returns nil when the blob hasn't synced yet.
    func putBlob(_ hash: String, _ data: Data) async throws
    func getBlob(_ hash: String) async throws -> Data?
    /// Kill-switch · delete a device's whole segment from the shared folder.
    func removeDevice(_ device: String) async throws
}

public extension SyncTransport {
    func putBlob(_ hash: String, _ data: Data) async throws {}      // default: no blob store
    func getBlob(_ hash: String) async throws -> Data? { nil }
    func removeDevice(_ device: String) async throws {}            // default: no-op
}

/// In-memory stand-in for the shared iCloud folder. Multiple engines sharing
/// ONE instance == multiple devices syncing through "iCloud".
public actor InMemoryTransport: SyncTransport {
    private var segments: [String: [SyncOp]] = [:]
    private var blobs: [String: Data] = [:]
    public init() {}

    public func putBlob(_ hash: String, _ data: Data) async throws { blobs[hash] = data }
    public func getBlob(_ hash: String) async throws -> Data? { blobs[hash] }
    public func removeDevice(_ device: String) async throws { segments[device] = nil }

    public func push(device: String, ops: [SyncOp]) async throws {
        segments[device, default: []].append(contentsOf: ops)
    }

    public func pull(cursors: [String: Int]) async throws -> PullResult {
        var out: [SyncOp] = []
        var next = cursors
        for (device, seg) in segments {
            let from = cursors[device] ?? 0
            if from < seg.count { out.append(contentsOf: seg[from..<seg.count]) }
            next[device] = seg.count
        }
        return PullResult(ops: out, cursors: next)
    }
}
