import Foundation

/// Web search — Brave (GET) / Tavily (POST), ported from `src/ai/skills/web-search.ts`.
/// Failures are NON-fatal: any timeout / 4xx / 5xx / parse error returns nil and
/// the caller proceeds without search (the agent answers from training). 6s
/// timeout. `formatResults` renders the SHARED MATERIALS prompt block.
public struct SearchResult: Sendable, Equatable {
    public let title: String
    public let url: String
    public let description: String
    public let age: String?      // ISO publication date when surfaced
    public init(title: String, url: String, description: String, age: String?) {
        self.title = title; self.url = url; self.description = description; self.age = age
    }
}

public enum SearchBackend: String, Sendable { case brave, tavily }

public struct WebSearch: Sendable {
    public static let defaultTimeout: TimeInterval = 6
    public static let defaultCount = 5

    let session: URLSession
    public init(session: URLSession = .shared) { self.session = session }

    /// Dispatch to the active backend. Returns nil on any failure.
    public func run(_ backend: SearchBackend, apiKey: String, query: String,
                    count: Int = defaultCount, timeout: TimeInterval = defaultTimeout) async -> [SearchResult]? {
        switch backend {
        case .brave:  return await brave(apiKey: apiKey, query: query, count: count, timeout: timeout)
        case .tavily: return await tavily(apiKey: apiKey, query: query, count: count, timeout: timeout)
        }
    }

    private func brave(apiKey: String, query: String, count: Int, timeout: TimeInterval) async -> [SearchResult]? {
        let key = apiKey.trimmingCharacters(in: .whitespaces)
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty, !q.isEmpty, let req = Self.braveRequest(apiKey: key, query: q, count: count, timeout: timeout)
        else { return nil }
        guard let (data, resp) = try? await session.data(for: req),
              let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
        return Self.parseBrave(data, limit: max(1, min(count, 10)))
    }

    private func tavily(apiKey: String, query: String, count: Int, timeout: TimeInterval) async -> [SearchResult]? {
        let key = apiKey.trimmingCharacters(in: .whitespaces)
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty, !q.isEmpty, let req = Self.tavilyRequest(apiKey: key, query: q, count: count, timeout: timeout)
        else { return nil }
        guard let (data, resp) = try? await session.data(for: req),
              let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
        return Self.parseTavily(data, limit: max(1, min(count, 10)))
    }

    // MARK: Pure builders + parsers (unit-tested)

    public static func braveRequest(apiKey: String, query: String, count: Int, timeout: TimeInterval) -> URLRequest? {
        var comps = URLComponents(string: "https://api.search.brave.com/res/v1/web/search")
        comps?.queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "count", value: String(max(1, min(count, 10)))),
            URLQueryItem(name: "safesearch", value: "moderate"),
        ]
        guard let url = comps?.url else { return nil }
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue(apiKey, forHTTPHeaderField: "X-Subscription-Token")
        return req
    }

    public static func tavilyRequest(apiKey: String, query: String, count: Int, timeout: TimeInterval) -> URLRequest? {
        guard let url = URL(string: "https://api.tavily.com/search") else { return nil }
        let body: [String: Any] = ["api_key": apiKey, "query": query,
                                   "search_depth": "basic", "max_results": max(1, min(count, 10))]
        var req = URLRequest(url: url, timeoutInterval: timeout)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        return req
    }

    public static func parseBrave(_ data: Data, limit: Int) -> [SearchResult] {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let web = json["web"] as? [String: Any],
              let raw = web["results"] as? [[String: Any]] else { return [] }
        var out: [SearchResult] = []
        for r in raw {
            let title = ((r["title"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
            let url = ((r["url"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
            guard !title.isEmpty, !url.isEmpty else { continue }
            out.append(SearchResult(title: title, url: url,
                                    description: stripHtml(r["description"] as? String ?? "").trimmingCharacters(in: .whitespaces),
                                    age: r["age"] as? String))
            if out.count >= limit { break }
        }
        return out
    }

    public static func parseTavily(_ data: Data, limit: Int) -> [SearchResult] {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = json["results"] as? [[String: Any]] else { return [] }
        var out: [SearchResult] = []
        for r in raw {
            let title = ((r["title"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
            let url = ((r["url"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
            guard !title.isEmpty, !url.isEmpty else { continue }
            let content = (r["content"] as? String ?? "").replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            out.append(SearchResult(title: title, url: url, description: stripHtml(content),
                                    age: r["published_date"] as? String))
            if out.count >= limit { break }
        }
        return out
    }

    static func stripHtml(_ s: String) -> String {
        s.replacingOccurrences(of: #"(?i)</?[a-z][^>]*>"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    }

    /// SHARED MATERIALS prompt block — mirrors `formatSearchResults` exactly so
    /// the prompt bytes match the desktop.
    public static func formatResults(query: String, results: [SearchResult]) -> String {
        if results.isEmpty { return "" }
        var lines: [String] = ["─── SHARED MATERIALS · WEB SEARCH ───", "", "Query: \(query)", ""]
        lines.append("Cite sources by their bracketed number when you use a fact below "
                   + "(e.g. \"...as reported in [2]\"). If a source contradicts your "
                   + "training, prefer the search result — it's more recent.")
        lines.append("")
        for (i, r) in results.enumerated() {
            let age = r.age.map { " · \($0)" } ?? ""
            lines.append("[\(i + 1)] \(r.title)\(age)")
            lines.append("    \(r.url)")
            if !r.description.isEmpty {
                let desc = r.description.count > 320 ? String(r.description.prefix(317)) + "…" : r.description
                lines.append("    \(desc)")
            }
            lines.append("")
        }
        lines.append("─── END SHARED MATERIALS ───")
        return lines.joined(separator: "\n")
    }
}
