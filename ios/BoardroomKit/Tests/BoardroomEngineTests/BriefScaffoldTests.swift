import XCTest
import BoardroomCore
@testable import BoardroomEngine

/// Stage-2 scaffold parser · locks the anchor + findings gates and the tolerant
/// per-field coercion (confidence/stance/priority defaults, substitute groups).
final class BriefScaffoldTests: XCTestCase {

    func testParsesFullCoreScaffold() {
        let raw = """
        {
          "title": "Defensibility note",
          "bottomLine": { "judgement": "The moat is the data flywheel", "confidence": "high", "rationale": "channel economics" },
          "frameShift": { "shifted": true, "original": "is the UI the moat?", "reframed": "is the data the moat?", "trigger": "Hypatia's point" },
          "headlineFindings": [
            { "title": "Data compounds", "claim": "Each cohort improves the model", "confidence": "medium",
              "supporters": ["d1"], "challengers": [], "supporting": [{ "text": "sf", "evidenceRefs": ["d1#0"] }], "lensesPresent": ["data","structural"] }
          ],
          "divergence": { "statement": "moat vs distribution", "rows": [
            { "directorId": "d1", "stance": "for", "confidence": "high", "costOfBeingWrong": "x", "note": "n" }
          ], "resolutionRequirements": ["benchmark"] },
          "recommendations": [
            { "priority": "P0", "action": "Run a 30-day pilot", "rationale": "why", "ownerType": "product", "horizon": "30d", "successMetric": "m", "riskIfSkipped": "r" }
          ],
          "openQuestions": [ { "text": "at what scale?", "priority": "P0" } ]
        }
        """
        let s = BriefScaffold.parse(raw, fallbackTitle: "fb", fallbackOriginalQuestion: "q")
        XCTAssertNotNil(s)
        XCTAssertEqual(s?.title, "Defensibility note")
        XCTAssertEqual(s?.bottomLine.judgement, "The moat is the data flywheel")
        XCTAssertEqual(s?.headlineFindings.count, 1)
        XCTAssertEqual(s?.headlineFindings.first?.supporting.first?.text, "sf")
        XCTAssertEqual(s?.divergence?.rows.first?.stance, "for")
        XCTAssertEqual(s?.recommendations.first?.priority, "P0")
        XCTAssertEqual(s?.frameShift.shifted, true)
        XCTAssertEqual(s?.openQuestions.first?.priority, "P0")
    }

    func testAnchorGate() {
        // findings present but NO anchor → nil
        let raw = #"{"headlineFindings":[{"title":"t","claim":"c"}]}"#
        XCTAssertNil(BriefScaffold.parse(raw, fallbackTitle: "fb", fallbackOriginalQuestion: "q"))
    }

    func testFindingsGate() {
        // anchor present but NO findings → nil
        let raw = #"{"bottomLine":{"judgement":"J"}}"#
        XCTAssertNil(BriefScaffold.parse(raw, fallbackTitle: "fb", fallbackOriginalQuestion: "q"))
    }

    func testThesisAnchorAndBigIdeasSubstitute() {
        let raw = #"{"thesis":{"claim":"X is the bet","reasoning":"r"},"bigIdeas":[{"number":1,"claim":"idea one","why":"w"}]}"#
        let s = BriefScaffold.parse(raw, fallbackTitle: "fb", fallbackOriginalQuestion: "q")
        XCTAssertNotNil(s)
        XCTAssertEqual(s?.thesis?.claim, "X is the bet")
        XCTAssertEqual(s?.bigIdeas?.count, 1)
        XCTAssertTrue(s?.bottomLine.judgement.isEmpty ?? false)   // anchor came from thesis
    }
}
