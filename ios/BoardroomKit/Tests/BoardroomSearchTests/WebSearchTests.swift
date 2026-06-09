import XCTest
@testable import BoardroomSearch

final class WebSearchTests: XCTestCase {
    func testBraveRequest() {
        let req = WebSearch.braveRequest(apiKey: "bk", query: "ai agents", count: 20, timeout: 6)
        XCTAssertEqual(req?.url?.host, "api.search.brave.com")
        XCTAssertEqual(req?.value(forHTTPHeaderField: "X-Subscription-Token"), "bk")
        let qs = req?.url?.query ?? ""
        XCTAssertTrue(qs.contains("q=ai%20agents"))
        XCTAssertTrue(qs.contains("count=10"))          // clamped to 10
        XCTAssertTrue(qs.contains("safesearch=moderate"))
    }

    func testTavilyRequest() throws {
        let req = try XCTUnwrap(WebSearch.tavilyRequest(apiKey: "tk", query: "q", count: 3, timeout: 6))
        XCTAssertEqual(req.httpMethod, "POST")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(req.httpBody)) as? [String: Any])
        XCTAssertEqual(body["api_key"] as? String, "tk")
        XCTAssertEqual(body["search_depth"] as? String, "basic")
        XCTAssertEqual(body["max_results"] as? Int, 3)
    }

    func testParseBraveStripsHtmlAndFiltersEmpty() {
        let json = """
        {"web":{"results":[
          {"title":"One","url":"https://a.com","description":"<strong>big</strong> news","age":"2026-01-01"},
          {"title":"","url":"https://skip.com","description":"no title"},
          {"title":"Two","url":"https://b.com","description":"plain"}
        ]}}
        """
        let results = WebSearch.parseBrave(Data(json.utf8), limit: 5)
        XCTAssertEqual(results.count, 2)   // empty-title row dropped
        XCTAssertEqual(results[0].description, "big news")
        XCTAssertEqual(results[0].age, "2026-01-01")
    }

    func testParseTavily() {
        let json = #"{"results":[{"title":"T","url":"https://t.com","content":"line\n\nmore","published_date":"2026-02"}]}"#
        let results = WebSearch.parseTavily(Data(json.utf8), limit: 5)
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].description, "line more")   // whitespace collapsed
        XCTAssertEqual(results[0].age, "2026-02")
    }

    func testFormatResultsBlock() {
        let out = WebSearch.formatResults(query: "q", results: [
            SearchResult(title: "Title A", url: "https://a.com", description: "desc a", age: "2026"),
        ])
        XCTAssertTrue(out.hasPrefix("─── SHARED MATERIALS · WEB SEARCH ───"))
        XCTAssertTrue(out.contains("Query: q"))
        XCTAssertTrue(out.contains("[1] Title A · 2026"))
        XCTAssertTrue(out.contains("    https://a.com"))
        XCTAssertTrue(out.hasSuffix("─── END SHARED MATERIALS ───"))
        XCTAssertEqual(WebSearch.formatResults(query: "q", results: []), "")
    }
}
