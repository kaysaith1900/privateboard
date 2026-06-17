// iCloud sync · `sync_state` key/value + the hybrid logical clock.
// Port of `src/sync/state.ts`. All functions run inside a GRDB write/read
// closure (synchronous against `Database`).

import Foundation
import GRDB

public enum SyncState {
    static let PT_PAD = 15
    static let CT_PAD = 6

    public static func get(_ db: Database, _ key: String) throws -> String? {
        try String.fetchOne(db, sql: "SELECT value FROM sync_state WHERE key = ?", arguments: [key])
    }

    public static func set(_ db: Database, _ key: String, _ value: String) throws {
        try db.execute(
            sql: "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            arguments: [key, value])
    }

    /// This device's stable id — minted once, then reused.
    public static func deviceId(_ db: Database) throws -> String {
        if let id = try get(db, "device_id") { return id }
        let id = UUID().uuidString
        try set(db, "device_id", id)
        return id
    }

    private static func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    /// Issue a monotonic HLC for a local write.
    public static func nextHlc(_ db: Database, device: String) throws -> HLC {
        let wall = nowMs()
        var pt = wall
        var ct: Int64 = 0
        if let last = try get(db, "hlc") {
            let parts = last.split(separator: ".")
            let lp = Int64(parts.first ?? "0") ?? 0
            let lc = Int64(parts.count > 1 ? parts[1] : "0") ?? 0
            if lp >= wall { pt = lp; ct = lc + 1 }
        }
        try set(db, "hlc", "\(pt).\(ct)")
        return encode(pt: pt, ct: ct, device: device)
    }

    /// Fold a remote op's HLC into our clock so our next local write is causally
    /// after anything observed.
    public static func observe(_ db: Database, _ remote: HLC) throws {
        let r = decode(remote)
        let wall = nowMs()
        var lp: Int64 = 0
        var lc: Int64 = 0
        if let last = try get(db, "hlc") {
            let parts = last.split(separator: ".")
            lp = Int64(parts.first ?? "0") ?? 0
            lc = Int64(parts.count > 1 ? parts[1] : "0") ?? 0
        }
        let maxPt = max(wall, lp, r.pt)
        var c: Int64 = 0
        if maxPt == lp && maxPt == r.pt { c = max(lc, r.ct) + 1 }
        else if maxPt == lp { c = lc + 1 }
        else if maxPt == r.pt { c = r.ct + 1 }
        try set(db, "hlc", "\(maxPt).\(c)")
    }

    public static func encode(pt: Int64, ct: Int64, device: String) -> HLC {
        let p = String(pt)
        let c = String(ct)
        let pPad = String(repeating: "0", count: max(0, PT_PAD - p.count)) + p
        let cPad = String(repeating: "0", count: max(0, CT_PAD - c.count)) + c
        return "\(pPad).\(cPad).\(device)"
    }

    public static func decode(_ hlc: HLC) -> (pt: Int64, ct: Int64, device: String) {
        let parts = hlc.split(separator: ".", maxSplits: 2, omittingEmptySubsequences: false)
        let pt = Int64(parts.count > 0 ? parts[0] : "0") ?? 0
        let ct = Int64(parts.count > 1 ? parts[1] : "0") ?? 0
        let dev = parts.count > 2 ? String(parts[2]) : ""
        return (pt, ct, dev)
    }

    /// Lexicographic compare IS the LWW order (padded encoding guarantees it).
    public static func greater(_ a: HLC, _ b: HLC?) -> Bool {
        guard let b else { return true }
        return a > b
    }
}
