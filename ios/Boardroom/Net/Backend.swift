import Foundation

/// Where the app talks to. The whole point of this type is that switching
/// between the **local desktop server** (now) and a **hosted cloud backend**
/// (later) is just a different `baseURL` + an optional `authToken` — no other
/// code changes. Local mode leaves `authToken` nil (the local server is
/// single-user, no auth); cloud mode fills it with a bearer token.
struct Backend: Codable, Equatable {
    var baseURL: URL
    var authToken: String?

    enum Mode { case local, cloud }
    var mode: Mode { authToken == nil ? .local : .cloud }

    /// Build from a user-typed host like `192.168.1.20:3030` or a full URL.
    /// Returns nil if it can't be made into an http(s) URL.
    static func fromHostString(_ raw: String, token: String? = nil) -> Backend? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withScheme = trimmed.contains("://") ? trimmed : "http://\(trimmed)"
        guard var url = URL(string: withScheme), url.scheme != nil, url.host != nil else { return nil }
        // Drop any trailing slash so paths like "/api/rooms" resolve cleanly.
        if url.path == "/" { url = url.deletingLastPathComponent() }
        return Backend(baseURL: url, authToken: token?.isEmpty == true ? nil : token)
    }
}

/// Persists the chosen backend across launches (UserDefaults). The auth token
/// will move to the Keychain when cloud mode lands; for the local, token-less
/// build UserDefaults is fine.
enum BackendStore {
    private static let key = "boardroom.backend"

    static func load() -> Backend? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(Backend.self, from: data)
    }

    static func save(_ backend: Backend?) {
        guard let backend, let data = try? JSONEncoder().encode(backend) else {
            UserDefaults.standard.removeObject(forKey: key); return
        }
        UserDefaults.standard.set(data, forKey: key)
    }
}
