// iCloud sync · binary blob externalization (port of `src/sync/blobs.ts`).
// data-URL avatar portraits are hashed, stored once in the content-addressed blob
// store, and replaced in the op with a `bsync-blob:<sha256>:<mime>` reference at
// push; reconstructed at pull. Non-data-URL avatar PATHS (bundled assets) pass
// through untouched. Structs are value types → returns NEW ops.

import Foundation
import CryptoKit

public enum SyncBlobs {
    static let PREFIX = "bsync-blob:"
    static let MIN_BYTES = 256

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func parseDataUrl(_ s: String) -> (mime: String, data: Data)? {
        guard s.hasPrefix("data:"), let comma = s.firstIndex(of: ",") else { return nil }
        let header = String(s[s.index(s.startIndex, offsetBy: 5)..<comma]) // "image/png;base64"
        guard header.hasSuffix(";base64") else { return nil }
        let mime = String(header.dropLast(";base64".count))
        guard let data = Data(base64Encoded: String(s[s.index(after: comma)...])) else { return nil }
        return (mime.isEmpty ? "application/octet-stream" : mime, data)
    }

    public static func externalize(_ transport: SyncTransport, _ ops: [SyncOp], _ registry: Registry) async throws -> [SyncOp] {
        var out: [SyncOp] = []
        for op in ops {
            guard op.op == .upsert, var cols = op.cols,
                  let blobCols = registry[op.entity]?.blobCols, !blobCols.isEmpty else { out.append(op); continue }
            var changed = false
            for col in blobCols {
                guard case .text(let v)? = cols[col] else { continue }
                // Never carry a blank or a dangling `bsync-blob:` ref — dropping the
                // column means LWW can't overwrite a peer's good avatar with a blank one.
                if v.isEmpty || v.hasPrefix(PREFIX) {
                    cols.removeValue(forKey: col)
                    changed = true
                    continue
                }
                guard v.count >= MIN_BYTES, v.hasPrefix("data:"), let parsed = parseDataUrl(v) else { continue }
                let hash = sha256(parsed.data)
                try await transport.putBlob(hash, parsed.data)
                cols[col] = .text("\(PREFIX)\(hash):\(parsed.mime)")
                changed = true
            }
            out.append(changed ? op.withCols(cols) : op)
        }
        return out
    }

    public static func internalize(_ transport: SyncTransport, _ ops: [SyncOp], _ registry: Registry) async throws -> [SyncOp] {
        var out: [SyncOp] = []
        for op in ops {
            guard op.op == .upsert, var cols = op.cols,
                  let blobCols = registry[op.entity]?.blobCols, !blobCols.isEmpty else { out.append(op); continue }
            var changed = false
            for col in blobCols {
                guard case .text(let v)? = cols[col], v.hasPrefix(PREFIX) else { continue }
                let rest = String(v.dropFirst(PREFIX.count))
                let sep = rest.firstIndex(of: ":")
                let hash = sep != nil ? String(rest[rest.startIndex..<sep!]) : rest
                let mime = sep != nil ? String(rest[rest.index(after: sep!)...]) : "application/octet-stream"
                if let data = try await transport.getBlob(hash) {
                    cols[col] = .text("data:\(mime);base64,\(data.base64EncodedString())")
                } else {
                    cols[col] = .text("") // not synced yet → graceful default avatar
                }
                changed = true
            }
            out.append(changed ? op.withCols(cols) : op)
        }
        return out
    }
}
