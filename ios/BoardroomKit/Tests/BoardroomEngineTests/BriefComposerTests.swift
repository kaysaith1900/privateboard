import XCTest
@testable import BoardroomEngine

/// Composer parse + validate gates (port of composer.ts parseComposerOutput /
/// validatePicks) + the codegen'd prompt resource.
final class BriefComposerTests: XCTestCase {

    func testComposerPromptBundled() {
        XCTAssertNotNil(BriefStages.catalog?.composer)
        XCTAssertGreaterThan(BriefStages.catalog?.composer.count ?? 0, 200)
    }

    func testParseValidComposition() {
        let raw = """
        ```json
        {
          "house_style": "a16z-thesis",
          "spine": "a16z-thesis",
          "subject_type": "investment-judgement",
          "components": [
            {"kind":"thesis","order":1},
            {"kind":"metric-strip","order":2},
            {"kind":"big-ideas","order":3},
            {"kind":"divergence","order":4},
            {"kind":"risk-register","order":5},
            {"kind":"the-bet","order":6}
          ],
          "rationale": "investment room"
        }
        ```
        """
        // Coverage with tensions + risks → divergence + risk-register satisfy it.
        let cov = BriefComposer.Coverage(tensions: 2, risks: 1, openQuestions: 0, actions: 0, dataAvailable: 3)
        guard let c = BriefComposer.parse(raw, coverage: cov) else { return XCTFail("should parse") }
        XCTAssertEqual(c.spine, "a16z-thesis")
        XCTAssertEqual(c.houseStyle, "a16z-thesis")
        XCTAssertEqual(c.subjectType, "investment-judgement")
        XCTAssertEqual(c.components.count, 6)
        XCTAssertEqual(c.components.first?.order, 1)             // renumbered contiguous
        XCTAssertTrue(c.fromComposer)
    }

    func testValidateRejectsTooFewAndMissingCoverage() {
        // Too few components.
        let few = [BriefComposer.Composition.Component(kind: "bottom-line", order: 1)]
        XCTAssertNotNil(BriefComposer.validate(few, coverage: .init()))
        // 5 components, valid anchor/findings/action, but tensions surfaced with no
        // divergence/positions → rejected.
        let picks = ["bottom-line", "headline-findings", "recommendations", "frame-shift", "convergence"]
            .enumerated().map { BriefComposer.Composition.Component(kind: $0.element, order: $0.offset + 1) }
        XCTAssertNil(BriefComposer.validate(picks, coverage: .init()))                       // ok with no coverage
        XCTAssertNotNil(BriefComposer.validate(picks, coverage: BriefComposer.Coverage(tensions: 1)))  // needs divergence/positions
    }

    func testSpineFallsBackToHouseStyleDefault() {
        // No spine named, house_style anthropic → anthropic-essay default spine.
        let raw = #"""
        {"house_style":"anthropic","components":[
          {"kind":"working-hypothesis","order":1},{"kind":"big-ideas","order":2},
          {"kind":"considerations","order":3},{"kind":"frame-shift","order":4},
          {"kind":"open-questions","order":5}]}
        """#
        guard let c = BriefComposer.parse(raw, coverage: .init()) else { return XCTFail("should parse") }
        XCTAssertEqual(c.spine, "anthropic-essay")
    }

    func testDefaultComposition() {
        let d = BriefComposer.defaultComposition("no assets")
        XCTAssertEqual(d.spine, "boardroom-dark")
        XCTAssertEqual(d.houseStyle, "boardroom-default")
        XCTAssertFalse(d.fromComposer)
        XCTAssertEqual(d.components.count, 12)
    }

    func testMergeAppliesPrefsOverride() {
        let d = BriefComposer.defaultComposition("x")
        let merged = BriefComposer.merge(d, prefsSpine: "mckinsey-deck", prefsHouseStyle: "bcg-strategy")
        XCTAssertEqual(merged.spine, "mckinsey-deck")
        XCTAssertEqual(merged.houseStyle, "bcg-strategy")
        // Unknown override ignored.
        let merged2 = BriefComposer.merge(d, prefsSpine: "bogus", prefsHouseStyle: nil)
        XCTAssertEqual(merged2.spine, "boardroom-dark")
    }
}
