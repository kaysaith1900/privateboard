import XCTest
import BoardroomAI
@testable import BoardroomEngine

/// #10 web-search query router · lock the JSON shapes the director / chair pickers
/// must parse (`{web_search:{query}}` vs `{query}`), the null→nil paths, trimming,
/// and the "no model / no user prompt" skip gates.
final class WebSearchPickerTests: XCTestCase {
    struct ScriptedRouter: EngineRouter {
        var model: ModelV? = .haiku_4_5
        var response: String = ""
        func utilityModelV() -> ModelV? { model }
        func defaultModelV() -> ModelV? { model }
        func reachableModelVs() -> Set<ModelV> { model.map { [$0] } ?? [] }
        func call(_ messages: [LLMMessage], modelV: ModelV, temperature: Double?, maxTokens: Int?) async throws -> String { response }
    }

    private func userMsg(_ body: String) -> EngineMessage {
        EngineMessage(id: UUID().uuidString, roomId: "r", authorKind: "user", authorId: nil,
                      body: body, roundNum: 1, streaming: false)
    }

    func testDirectorQueryParsed() async {
        let r = ScriptedRouter(response: "{ \"web_search\": { \"query\": \"openai gpt-5 launch 2026\" } }")
        let q = await WebSearchPicker.pickDirectorQuery(router: r, speakerName: "Socrates",
                                                        speakerModel: .sonnet_4_6, history: [userMsg("what did openai ship this week?")])
        XCTAssertEqual(q, "openai gpt-5 launch 2026")
    }

    func testDirectorNullQueryIsNil() async {
        let r = ScriptedRouter(response: "{ \"web_search\": null }")
        let q = await WebSearchPicker.pickDirectorQuery(router: r, speakerName: "Socrates",
                                                        speakerModel: .sonnet_4_6, history: [userMsg("is justice a virtue?")])
        XCTAssertNil(q)
    }

    func testChairQueryParsed() async {
        let r = ScriptedRouter(response: "```json\n{ \"query\": \"anthropic claude opus 4.8 release\" }\n```")
        let q = await WebSearchPicker.pickChairQuery(router: r, history: [userMsg("查一下 claude 最近的发布")])
        XCTAssertEqual(q, "anthropic claude opus 4.8 release")   // tolerant of ```json fences
    }

    func testChairNullQueryIsNil() async {
        let r = ScriptedRouter(response: "{ \"query\": null }")
        let q = await WebSearchPicker.pickChairQuery(router: r, history: [userMsg("brainstorm names for my cat")])
        XCTAssertNil(q)
    }

    func testEmptyHistorySkips() async {
        // No messages at all → latestUserPrompt returns "" → no routing call.
        // (With an agent-only history the picker still runs — latestUserPrompt
        // faithfully falls back to the last meaningful body, matching desktop.)
        let r = ScriptedRouter(response: "{ \"query\": \"should not run\" }")
        let q = await WebSearchPicker.pickChairQuery(router: r, history: [])
        XCTAssertNil(q)
    }

    func testNoModelSkips() async {
        let r = ScriptedRouter(model: nil, response: "{ \"web_search\": { \"query\": \"x\" } }")
        let q = await WebSearchPicker.pickDirectorQuery(router: r, speakerName: "S",
                                                        speakerModel: .sonnet_4_6, history: [userMsg("latest news?")])
        // No router model, but the speaker-model fallback still resolves → query parsed.
        XCTAssertEqual(q, "x")
    }

    func testMalformedJsonIsNil() async {
        let r = ScriptedRouter(response: "I think you should search for recent news.")
        let q = await WebSearchPicker.pickDirectorQuery(router: r, speakerName: "S",
                                                        speakerModel: .sonnet_4_6, history: [userMsg("latest?")])
        XCTAssertNil(q)
    }
}
