import Foundation
#if canImport(Security)
import Security
#endif

/// The three credential families (mirrors the desktop `llm/voice/search`
/// credential tables). Non-secret metadata (provider, label, active flag) lives
/// in SQLite rows; only the raw API key lives in the secret store.
public enum CredentialKind: String, Sendable, CaseIterable {
    case llm, voice, search
    var keychainService: String { "ai.boardroom.cred.\(rawValue)" }
}

/// Secret storage for raw API keys. On-device this is the iOS Keychain — NOT
/// the desktop's scrypt-from-OS-username AES scheme (a desktop-only construct
/// that can't be re-derived on iOS, see the plan's credential-migration risk).
/// A credential's id is the SQLite row id; the key is fetched on demand.
public protocol CredentialStore: Sendable {
    func set(_ kind: CredentialKind, id: String, key: String) throws
    func key(_ kind: CredentialKind, id: String) -> String?
    func delete(_ kind: CredentialKind, id: String) throws
}

// MARK: - Keychain implementation

#if canImport(Security)
public struct KeychainCredentialStore: CredentialStore {
    public init() {}

    public func set(_ kind: CredentialKind, id: String, key: String) throws {
        let base = query(kind, id)
        SecItemDelete(base as CFDictionary)   // replace semantics
        var add = base
        add[kSecValueData as String] = Data(key.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func key(_ kind: CredentialKind, id: String) -> String? {
        var q = query(kind, id)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func delete(_ kind: CredentialKind, id: String) throws {
        let status = SecItemDelete(query(kind, id) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }

    private func query(_ kind: CredentialKind, _ id: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: kind.keychainService,
            kSecAttrAccount as String: id,
        ]
    }

    public struct KeychainError: Error, CustomStringConvertible {
        public let status: OSStatus
        public var description: String {
            "Keychain error \(status): \(SecCopyErrorMessageString(status, nil) as String? ?? "unknown")"
        }
    }
}
#endif

// MARK: - In-memory implementation (tests / previews)

public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var store: [String: String] = [:]
    public init() {}
    private func k(_ kind: CredentialKind, _ id: String) -> String { "\(kind.rawValue)/\(id)" }

    public func set(_ kind: CredentialKind, id: String, key: String) {
        lock.lock(); defer { lock.unlock() }; store[k(kind, id)] = key
    }
    public func key(_ kind: CredentialKind, id: String) -> String? {
        lock.lock(); defer { lock.unlock() }; return store[k(kind, id)]
    }
    public func delete(_ kind: CredentialKind, id: String) {
        lock.lock(); defer { lock.unlock() }; store[k(kind, id)] = nil
    }
}
