import XCTest
import BoardroomAI
import BoardroomCore
@testable import BoardroomEngine

/// Stage-1 asset parse + flatten · locks the per-field validation (lens gate,
/// non-empty sources gate, kind/severity/priority fallbacks, caps) + the
/// bracket-prefix flattening the writer consumes.
final class BriefAssetsTests: XCTestCase {

    func testParseValidatesLensAndSources() {
        let raw = """
        ```json
        {
          "claims": [
            { "text": "valid claim", "lens": "dissent", "sources": [0,2], "confidence": "high" },
            { "text": "no sources dropped", "lens": "data", "sources": [] },
            { "text": "bad lens dropped", "lens": "bogus", "sources": [1] }
          ],
          "risks": [ { "text": "fragile channel", "severity": "high", "sources": [3] } ],
          "openQuestions": [ { "text": "moat?", "priority": "P0", "sources": [4] } ]
        }
        ```
        """
        let a = BriefAssets.parse(raw, directorId: "d1", directorName: "Hypatia")
        XCTAssertEqual(a.claims.count, 1)              // no-sources + bad-lens dropped
        XCTAssertEqual(a.claims.first?.confidence, "high")
        XCTAssertEqual(a.risks.first?.severity, "high")
        XCTAssertEqual(a.openQuestions.first?.priority, "P0")
    }

    func testParseFallbacks() {
        // evidence bad kind → "case"; risk bad severity → nil; oq bad priority → "P1"
        let raw = #"{"evidence":[{"text":"e","kind":"weird","sources":[0]}],"risks":[{"text":"r","severity":"x","sources":[0]}],"openQuestions":[{"text":"q","priority":"x","sources":[0]}]}"#
        let a = BriefAssets.parse(raw, directorId: "d", directorName: "N")
        XCTAssertEqual(a.evidence.first?.kind, "case")
        XCTAssertNil(a.risks.first?.severity)
        XCTAssertEqual(a.openQuestions.first?.priority, "P1")
    }

    func testCapsClaims() {
        let claims = (0..<10).map { #"{"text":"c\#($0)","lens":"data","sources":[0]}"# }.joined(separator: ",")
        let a = BriefAssets.parse("{\"claims\":[\(claims)]}", directorId: "d", directorName: "N")
        XCTAssertEqual(a.claims.count, 6)   // ASSET_CAPS.claims
    }

    func testAssetsToSignalsPrefixes() {
        let a = BriefAssets.DirectorAssets(
            directorId: "d", directorName: "N",
            claims: [.init(text: "c", lens: "data", sources: [0], confidence: nil)],
            evidence: [.init(text: "e", kind: "data", sources: [1])],
            tensions: [.init(text: "t", with: ["long-horizon"], sources: [2])],
            assumptions: [], risks: [.init(text: "r", severity: "high", sources: [3])],
            opportunities: [], actions: [], quotes: [],
            openQuestions: [.init(text: "q", priority: "P0", sources: [4])])
        let sig = BriefAssets.assetsToSignals(a).signals.map(\.text)
        XCTAssertTrue(sig.contains("[claim] c"))
        XCTAssertTrue(sig.contains("[evidence·data] e"))
        XCTAssertTrue(sig.contains("[tension w/ long-horizon] t"))
        XCTAssertTrue(sig.contains("[risk·high] r"))
        XCTAssertTrue(sig.contains("[open-q·P0] q"))
    }
}
