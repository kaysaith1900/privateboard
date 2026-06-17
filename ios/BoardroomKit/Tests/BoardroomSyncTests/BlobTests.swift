// P4 · content-addressed blobs (Swift) — a data-URL avatar is externalized to
// blobs/<sha256> (not inlined in the oplog) and reconstructed on the peer.

import XCTest
import GRDB
import BoardroomStorage
@testable import BoardroomSync

final class BlobTests: XCTestCase {
    var dir: URL!
    var cloud: URL!
    var dbA: BoardroomDB!
    var dbB: BoardroomDB!
    var A: SyncEngine!
    var B: SyncEngine!

    let dataURL: String = {
        let bytes = Data(repeating: 0x41, count: 2000) // 2KB · over the inline threshold
        return "data:image/png;base64," + bytes.base64EncodedString()
    }()

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("blob-\(UUID().uuidString)")
        cloud = dir.appendingPathComponent("cloud")
        try FileManager.default.createDirectory(at: cloud, withIntermediateDirectories: true)
        dbA = try BoardroomDB(path: dir.appendingPathComponent("a.sqlite").path)
        dbB = try BoardroomDB(path: dir.appendingPathComponent("b.sqlite").path)
        A = try await SyncEngine(pool: dbA.pool, transport: FolderTransport(root: cloud))
        B = try await SyncEngine(pool: dbB.pool, transport: FolderTransport(root: cloud))
    }
    override func tearDown() async throws {
        dbA = nil; dbB = nil
        try? FileManager.default.removeItem(at: dir)
    }

    func insertAgent(_ db: BoardroomDB, _ id: String, _ avatar: String) throws {
        try db.pool.write { d in
            try d.execute(sql: """
                INSERT INTO agents (id,name,handle,instruction,model_v,avatar_path,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?)
                """, arguments: [id, id, "@\(id)", "inst", "sonnet-4-6", avatar,
                                 Int64(Date().timeIntervalSince1970 * 1000),
                                 Int64(Date().timeIntervalSince1970 * 1000)])
        }
    }
    func avatar(_ db: BoardroomDB, _ id: String) throws -> String? {
        try db.pool.read { d in try String.fetchOne(d, sql: "SELECT avatar_path FROM agents WHERE id = ?", arguments: [id]) }
    }
    func syncBoth() async throws {
        _ = try await A.sync(); _ = try await B.sync(); _ = try await A.sync(); _ = try await B.sync()
    }

    func testPortraitExternalizedAndReconstructed() async throws {
        try insertAgent(dbA, "ag1", dataURL)
        try await syncBoth()

        // Peer reconstructs the exact data-URL.
        XCTAssertEqual(try avatar(dbB, "ag1"), dataURL)

        // The oplog carries a blob reference, not the base64 payload.
        let opsFile = cloud.appendingPathComponent("devices/\(A.device)/ops.jsonl")
        let ops = try String(contentsOf: opsFile, encoding: .utf8)
        XCTAssertTrue(ops.contains("bsync-blob:"))
        XCTAssertFalse(ops.contains(Data(repeating: 0x41, count: 2000).base64EncodedString()))

        // The blob exists on disk, content-addressed (one file).
        let blobs = try FileManager.default.contentsOfDirectory(atPath: cloud.appendingPathComponent("blobs").path)
        XCTAssertEqual(blobs.count, 1)
    }

    func testBundledPathNotExternalized() async throws {
        try insertAgent(dbA, "ag2", "avatars/3d/royal.png")
        try await syncBoth()
        XCTAssertEqual(try avatar(dbB, "ag2"), "avatars/3d/royal.png")
        XCTAssertFalse(FileManager.default.fileExists(atPath: cloud.appendingPathComponent("blobs").path))
    }
}
