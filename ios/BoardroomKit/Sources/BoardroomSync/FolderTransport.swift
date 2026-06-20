// iCloud sync · the file-backed transport. Each device appends its ops as
// JSONL to its OWN file under `<root>/devices/<deviceId>/ops.jsonl` — the
// "one writer per file" invariant that structurally dodges iCloud's
// conflict-copy ("ops 2.jsonl") + losing-version quota leak (TN2336).
//
// This implementation is directory-driven, so it runs against ANY folder:
// a plain local dir (fully unit-tested), or — in production — the iOS-published
// iCloud ubiquity container `Documents/PrivateBoard`. The iCloud-specific layer
// (resolving the container URL, NSMetadataQuery change pushes, and triggering
// download of dataless placeholders) is `ICloudContainer` + a thin wiring layer;
// the file format + read/append/cursor logic verified here is identical.

import Foundation

public actor FolderTransport: SyncTransport {
    private let root: URL
    /// When true, attempt to materialize evicted iCloud placeholders before
    /// reading (no-op on a plain local dir). Set on the real container.
    private let isUbiquitous: Bool
    private let coordinator = NSFileCoordinator()

    public init(root: URL, isUbiquitous: Bool = false) {
        self.root = root
        self.isUbiquitous = isUbiquitous
    }

    private func deviceDir(_ device: String) -> URL {
        root.appendingPathComponent("devices", isDirectory: true)
            .appendingPathComponent(device, isDirectory: true)
    }
    private func opsFile(_ device: String) -> URL {
        deviceDir(device).appendingPathComponent("ops.jsonl", isDirectory: false)
    }
    private func blobFile(_ hash: String) -> URL {
        root.appendingPathComponent("blobs", isDirectory: true).appendingPathComponent(hash, isDirectory: false)
    }

    public func putBlob(_ hash: String, _ data: Data) async throws {
        let dir = root.appendingPathComponent("blobs", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = blobFile(hash)
        if FileManager.default.fileExists(atPath: file.path) { return } // content-addressed · immutable
        try coordinatedWrite(file) { try data.write(to: file) }
    }

    /// Kill-switch · delete a device's whole segment from the shared folder.
    public func removeDevice(_ device: String) async throws {
        try coordinatedWrite(deviceDir(device)) {
            try? FileManager.default.removeItem(at: deviceDir(device))
        }
    }

    public func getBlob(_ hash: String) async throws -> Data? {
        let file = blobFile(hash)
        await awaitDownload(file) // a dataless iCloud stub reads back nil if we don't wait
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        var data: Data?
        try coordinatedRead(file) { data = try? Data(contentsOf: file) }
        return data
    }

    public func push(device: String, ops: [SyncOp]) async throws {
        guard !ops.isEmpty else { return }
        let dir = deviceDir(device)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = opsFile(device)
        let encoder = JSONEncoder()
        var blob = Data()
        for op in ops {
            blob.append(try encoder.encode(op))
            blob.append(0x0A) // newline
        }
        try coordinatedWrite(file) {
            if !FileManager.default.fileExists(atPath: file.path) {
                FileManager.default.createFile(atPath: file.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: blob)
        }
    }

    public func pull(cursors: [String: Int]) async throws -> PullResult {
        var out: [SyncOp] = []
        var next = cursors
        let devicesRoot = root.appendingPathComponent("devices", isDirectory: true)
        let deviceDirs = (try? FileManager.default.contentsOfDirectory(
            at: devicesRoot, includingPropertiesForKeys: nil)) ?? []
        let decoder = JSONDecoder()
        for dDir in deviceDirs {
            let device = dDir.lastPathComponent
            let file = opsFile(device)
            await awaitDownload(file) // wait out a dataless stub before reading peer ops
            guard FileManager.default.fileExists(atPath: file.path) else { continue }
            var data = Data()
            try coordinatedRead(file) { data = (try? Data(contentsOf: file)) ?? Data() }
            let lines = data.split(separator: 0x0A, omittingEmptySubsequences: true)
            let from = cursors[device] ?? 0
            if from < lines.count {
                for i in from..<lines.count {
                    if let op = try? decoder.decode(SyncOp.self, from: Data(lines[i])) { out.append(op) }
                }
            }
            next[device] = lines.count
        }
        return PullResult(ops: out, cursors: next)
    }

    private func coordinatedWrite(_ url: URL, _ body: () throws -> Void) throws {
        var coordErr: NSError?
        var thrown: Error?
        coordinator.coordinate(writingItemAt: url, options: [], error: &coordErr) { _ in
            do { try body() } catch { thrown = error }
        }
        if let coordErr { throw coordErr }
        if let thrown { throw thrown }
    }

    private func coordinatedRead(_ url: URL, _ body: () -> Void) throws {
        var coordErr: NSError?
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordErr) { _ in body() }
        if let coordErr { throw coordErr }
    }

    /// Block (bounded) until an evicted iCloud placeholder finishes downloading,
    /// so the subsequent read sees real bytes instead of a dataless stub —
    /// `startDownloadingUbiquitousItem` only *initiates* the transfer, it does not
    /// wait. No-op on a plain local dir, on an already-current file, or when no
    /// file/placeholder exists at the path.
    private func awaitDownload(_ file: URL, timeout: TimeInterval = 12) async {
        guard isUbiquitous else { return }
        let fm = FileManager.default
        let placeholder = file.deletingLastPathComponent()
            .appendingPathComponent(".\(file.lastPathComponent).icloud")
        guard fm.fileExists(atPath: file.path) || fm.fileExists(atPath: placeholder.path) else { return }
        try? fm.startDownloadingUbiquitousItem(at: file)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let status = (try? file.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]))?
                .ubiquitousItemDownloadingStatus
            if status == .current { return }
            try? await Task.sleep(nanoseconds: 150_000_000) // 150ms
        }
    }
}
