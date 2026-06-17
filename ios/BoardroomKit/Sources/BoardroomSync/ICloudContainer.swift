// iCloud sync · the device-only layer that points the (unit-tested) FolderTransport
// at the real iCloud ubiquity container, and pushes a "remote changed" signal via
// NSMetadataQuery so a peer's writes trigger a pull promptly (instead of only on
// the next scenePhase beat).
//
// ⚠️ NEEDS-DEVICE VERIFICATION · everything below depends on a provisioned iCloud
// container + a signed-in iCloud account and cannot be exercised in unit tests.
// The file format + merge logic it sits on top of ARE fully tested
// (FolderTransportTests / SyncEngineTests). Requires, in the app target:
//   • iCloud capability + "iCloud Documents" + the container id below
//   • Info.plist NSUbiquitousContainers with the SAME container id and
//     NSUbiquitousContainerIsDocumentScopePublic = true   (so the macOS desktop
//     can POSIX-read it — see the desktop P3 reader)

import Foundation

public enum ICloudContainer {
    /// Must match the iCloud container provisioned for the app (Xcode iCloud
    /// capability · default `iCloud.<bundle-id>`) + the desktop reader path
    /// `~/Library/Mobile Documents/iCloud~ai~boardroom~mobile/`.
    public static let identifier = "iCloud.ai.boardroom.mobile"
    public static let subfolder = "PrivateBoard"

    /// True when the device is signed into an iCloud account at all (independent of
    /// whether THIS app's ubiquity container is provisioned). Lets the caller tell
    /// "not signed in" apart from "signed in, but the container isn't available"
    /// (a build / provisioning-profile problem, not a user-settings one).
    public static var isSignedIn: Bool { FileManager.default.ubiquityIdentityToken != nil }

    /// `<ubiquity>/Documents/PrivateBoard`, creating it. nil when iCloud is
    /// unavailable (not signed in / disabled) OR the app's container isn't
    /// provisioned. The FIRST `url(forUbiquityContainerIdentifier:)` after launch
    /// often returns nil while the daemon sets the container up, so we retry.
    /// MUST be called off the main thread (it can block for seconds).
    public static func documentsRoot(retries: Int = 6) -> URL? {
        for attempt in 0..<max(1, retries) {
            if let base = FileManager.default.url(forUbiquityContainerIdentifier: identifier) {
                let root = base.appendingPathComponent("Documents", isDirectory: true)
                    .appendingPathComponent(subfolder, isDirectory: true)
                try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                return root
            }
            if attempt < retries - 1 { Thread.sleep(forTimeInterval: 0.8) } // daemon may still be provisioning
        }
        return nil
    }

    /// The production transport, or nil when iCloud is unavailable.
    public static func makeTransport() -> FolderTransport? {
        guard let root = documentsRoot() else { return nil }
        return FolderTransport(root: root, isUbiquitous: true)
    }
}

/// Fires `onChange` whenever the ubiquity oplog folder reports updates, so the
/// owner can `Task { try await engine.pull() }`. Lifetimes: hold a strong ref;
/// `stop()` on teardown. ⚠️ NEEDS-DEVICE VERIFICATION (NSMetadataQuery only
/// surfaces real iCloud items).
public final class ICloudChangeObserver: NSObject, @unchecked Sendable {
    private let query = NSMetadataQuery()
    private let onChange: @Sendable () -> Void

    public init(onChange: @escaping @Sendable () -> Void) {
        self.onChange = onChange
        super.init()
        query.searchScopes = [NSMetadataQueryUbiquitousDocumentsScope]
        // Watch our oplog segments across all devices.
        query.predicate = NSPredicate(format: "%K LIKE %@", NSMetadataItemFSNameKey, "ops.jsonl")
        NotificationCenter.default.addObserver(
            self, selector: #selector(updated), name: .NSMetadataQueryDidUpdate, object: query)
        NotificationCenter.default.addObserver(
            self, selector: #selector(updated), name: .NSMetadataQueryDidFinishGathering, object: query)
    }

    public func start() { query.start() }
    public func stop() {
        query.stop()
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func updated(_ note: Notification) {
        query.disableUpdates()
        onChange()
        query.enableUpdates()
    }
}
