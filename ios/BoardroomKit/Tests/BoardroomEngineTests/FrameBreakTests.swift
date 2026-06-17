import XCTest
import BoardroomAI
import BoardroomCore
@testable import BoardroomEngine

/// Unit tests for the Layer-2 divergence subsystems · pure parsers + a scripted
/// router for the LLM-driven extractors. Lock the parse semantics that must match
/// the desktop (NONE sentinel, comma/quote handling, score rescaling, EXTEND/NEW).
final class FrameBreakTests: XCTestCase {

    struct ScriptedRouter: EngineRouter {
        var utility: ModelV? = .haiku_4_5
        var response: String = ""
        func utilityModelV() -> ModelV? { utility }
        func defaultModelV() -> ModelV? { utility }
        func reachableModelVs() -> Set<ModelV> { [.haiku_4_5] }
        func call(_ messages: [LLMMessage], modelV: ModelV, temperature: Double?, maxTokens: Int?) async throws -> String { response }
    }

    private func dirTurn(_ id: String, _ body: String) -> EngineMessage {
        EngineMessage(id: UUID().uuidString, roomId: "r", authorKind: "agent", authorId: id,
                      body: body, roundNum: 1, streaming: false)
    }

    // MARK: frame-break parse

    func testFrameBreakParse() {
        XCTAssertEqual(FrameBreak.parse("audit responsibility, compliance burden, data moat"),
                       ["audit responsibility", "compliance burden", "data moat"])
        XCTAssertEqual(FrameBreak.parse("NONE"), [])
        XCTAssertEqual(FrameBreak.parse("无"), [])
        // fullwidth + ideographic commas, quote strip
        XCTAssertEqual(FrameBreak.parse("\"护城河\"，数据、合规"), ["护城河", "数据", "合规"])
        // cap at 5
        XCTAssertEqual(FrameBreak.parse("a,b,c,d,e,f,g").count, 5)
        // drop a >60-char run-on
        XCTAssertEqual(FrameBreak.parse(String(repeating: "x", count: 70) + ", ok"), ["ok"])
    }

    func testExtractDominantTermsNeedsFourTurns() async {
        let r = ScriptedRouter(response: "alpha, beta")
        let few = await FrameBreak.extractDominantTerms(router: r, messages: [dirTurn("a", "one")])
        XCTAssertEqual(few, [])   // <4 director turns → no extraction
        let many = (0..<4).map { dirTurn("a", "turn \($0) about the data moat") }
        let terms = await FrameBreak.extractDominantTerms(router: r, messages: many)
        XCTAssertEqual(terms, ["alpha", "beta"])
    }

    // MARK: negative space parse

    func testNegativeSpaceParseAndNone() async {
        let turns = [dirTurn("a", "first point here"), dirTurn("b", "second point here")]
        let r = ScriptedRouter(response: "- informal-economy workers\n2. regulatory horizon\nfront-line staff")
        let angles = await NegativeSpace.extractNegativeSpace(router: r, roundMessages: turns, roomSubject: "x")
        XCTAssertEqual(angles, ["informal-economy workers", "regulatory horizon", "front-line staff"])
        let none = await NegativeSpace.extractNegativeSpace(
            router: ScriptedRouter(response: "NONE"), roundMessages: turns, roomSubject: "x")
        XCTAssertEqual(none, [])
    }

    // MARK: QD score parse

    func testQDParseScoreRescaling() {
        XCTAssertEqual(QDScorer.parseScore("0.5"), 0.5)
        XCTAssertEqual(QDScorer.parseScore("7"), 0.7)        // 0-10 scale
        XCTAssertEqual(QDScorer.parseScore("50"), 0.5)       // percent
        XCTAssertEqual(QDScorer.parseScore("1.0"), 1.0)
        XCTAssertNil(QDScorer.parseScore("abc"))
    }
}
