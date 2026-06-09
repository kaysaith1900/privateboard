import XCTest
@testable import BoardroomEngine

/// Structured-mode (magazine/newspaper/ppt) bento parser (port of parseBento) +
/// the codegen'd prompts.
final class BriefBentoTests: XCTestCase {

    func testStructuredPromptsBundled() {
        XCTAssertGreaterThan(BriefStages.catalog?.magazine.count ?? 0, 200)
        XCTAssertGreaterThan(BriefStages.catalog?.newspaper.count ?? 0, 200)
        XCTAssertGreaterThan(BriefStages.catalog?.ppt.count ?? 0, 200)
    }

    func testParseBentoPadsMilestonesAndGates() {
        let raw = """
        ```json
        {
          "title": "AI agents are the new operating system",
          "kicker": "Why the shift is happening now",
          "milestones": [
            {"period":"Step 1","title":"Set up","body":"Install the tooling and create the workspace.","callout":"","tags":["setup"]}
          ],
          "rankedBars": null,
          "verification": {"title":"Why this matters","bullets":["Saves time · routine work compresses.","Personalized · tailored to context."]},
          "talkingPoints": {"title":"5 tactics","bullets":["Weekly check-in · run it.","Daily digest · summarize."]},
          "conclusion": "Start small, compound the wins.",
          "footerTag": "agents · 2026"
        }
        ```
        """
        guard let b = BriefBento.parse(raw, fallbackTitle: "T", fallbackSource: "From Chair", fallbackFooterTag: "F") else {
            return XCTFail("should parse")
        }
        XCTAssertEqual(b.title, "AI agents are the new operating system")
        XCTAssertEqual(b.milestones.count, 3)                  // padded to exactly 3
        XCTAssertEqual(b.milestones.first?.title, "Set up")
        XCTAssertEqual(b.source, "From Chair")                 // fallback applied
        XCTAssertNil(b.rankedBars)
        XCTAssertEqual(b.verification?.bullets.count, 2)
        XCTAssertEqual(b.talkingPoints.bullets.count, 2)
    }

    func testParseBentoRejectsNoMilestones() {
        XCTAssertNil(BriefBento.parse(#"{"title":"x","milestones":[]}"#, fallbackTitle: "t", fallbackSource: "", fallbackFooterTag: ""))
        XCTAssertNil(BriefBento.parse("not json", fallbackTitle: "t", fallbackSource: "", fallbackFooterTag: ""))
    }

    func testPptDirectorBlockGate() {
        // <2 perspectives → null.
        let one = BriefBento.parsePptDirectorBlock(["perspectives": [["directorName": "A", "position": "p"]]])
        XCTAssertNil(one)
        let two = BriefBento.parsePptDirectorBlock([
            "perspectives": [["directorName": "A", "position": "pa"], ["directorName": "B", "position": "pb"]],
            "chairSynthesis": "we compared",
        ])
        XCTAssertEqual(two?.perspectives.count, 2)
        XCTAssertEqual(two?.chairSynthesis, "we compared")
    }

    func testScaffoldBodyJSONRoundTrips() {
        let s = BriefBento.Scaffold(title: "T", kicker: "K", source: "S",
            milestones: [.init(period: "p", title: "t", body: "b", callout: "", tags: [])],
            rankedBars: nil, verification: nil,
            talkingPoints: .init(title: "tp", bullets: ["x"]), conclusion: "c", flow: nil,
            footerTag: "f", directorBlock: nil)
        let json = s.bodyJSON
        XCTAssertTrue(json.contains("\"title\":\"T\""))
        XCTAssertTrue(json.contains("\"talkingPoints\""))
    }
}
