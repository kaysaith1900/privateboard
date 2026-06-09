import XCTest
@testable import BoardroomStorage

final class CredentialStoreTests: XCTestCase {
    func testContract(_ store: CredentialStore) throws {
        XCTAssertNil(store.key(.llm, id: "c1"))
        try store.set(.llm, id: "c1", key: "sk-abc")
        XCTAssertEqual(store.key(.llm, id: "c1"), "sk-abc")
        // Kind-scoped: same id under a different family is independent.
        XCTAssertNil(store.key(.voice, id: "c1"))
        try store.set(.voice, id: "c1", key: "vk-xyz")
        XCTAssertEqual(store.key(.llm, id: "c1"), "sk-abc")
        XCTAssertEqual(store.key(.voice, id: "c1"), "vk-xyz")
        // Replace semantics.
        try store.set(.llm, id: "c1", key: "sk-new")
        XCTAssertEqual(store.key(.llm, id: "c1"), "sk-new")
        // Delete.
        try store.delete(.llm, id: "c1")
        XCTAssertNil(store.key(.llm, id: "c1"))
        XCTAssertEqual(store.key(.voice, id: "c1"), "vk-xyz")
    }

    func testInMemoryStore() throws {
        try testContract(InMemoryCredentialStore())
    }

    #if canImport(Security)
    /// Smoke-test the real Keychain. Skips gracefully if the host keychain is
    /// unavailable (headless CI) — full verification happens on-device (Phase 2).
    func testKeychainStoreIfAvailable() throws {
        let store = KeychainCredentialStore()
        let id = "test-\(UUID().uuidString)"
        do {
            try store.set(.search, id: id, key: "probe")
        } catch {
            throw XCTSkip("Keychain unavailable in this environment: \(error)")
        }
        defer { try? store.delete(.search, id: id) }
        XCTAssertEqual(store.key(.search, id: id), "probe")
        try store.delete(.search, id: id)
        XCTAssertNil(store.key(.search, id: id))
    }
    #endif
}
