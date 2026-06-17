import XCTest
import BoardroomAI
import BoardroomCore
@testable import BoardroomEngine

/// Verifies the codegen'd brief prompts bundle correctly + the Stage-3 write
/// user-message dumps the scaffold sections.
final class BriefStagesTests: XCTestCase {

    func testCodegenPromptsBundled() {
        let cat = BriefStages.catalog
        XCTAssertNotNil(cat, "brief-prompts.json must be bundled (Package.swift resource)")
        XCTAssertTrue((cat?.scaffold.contains("McKinsey-grade research note")) ?? false)
        XCTAssertTrue((cat?.write.contains("kami-chart")) ?? false)   // the write spec describes the chart fences
        XCTAssertGreaterThan(cat?.scaffold.count ?? 0, 10000)
        XCTAssertGreaterThan(cat?.write.count ?? 0, 10000)
    }

    func testWriteUserDumpsCoreSections() {
        let members = [BriefStages.Member(id: "d1", name: "Hypatia", handle: "@hyp", roleTag: "skeptic")]
        let scaffold = BriefScaffold.Scaffold(
            title: "T",
            bottomLine: .init(judgement: "The moat is data", confidence: "high", rationale: "r"),
            thesis: nil, workingHypothesis: nil,
            frameShift: .init(shifted: true, original: "o", reframed: "rf", trigger: "t"),
            headlineFindings: [.init(title: "Data compounds", claim: "c", confidence: "medium",
                                     supporters: ["d1"], challengers: [], supporting: [.init(text: "sf", evidenceRefs: ["d1#0"])],
                                     lensesPresent: ["data"], tension: nil, counterEvidence: nil, strategicImplication: nil)],
            bigIdeas: nil, convergence: [], divergence: nil, positions: [],
            recommendations: [.init(priority: "P0", action: "Pilot", rationale: "w", ownerType: "product", horizon: "30d", successMetric: "m", riskIfSkipped: "r", criticalDependency: nil, expectedBenefit: nil)],
            theBet: nil, considerations: nil, newQuestions: [], planningAssumption: nil, openQuestions: [])
        let signals = [BriefAssets.DirectorSignals(directorId: "d1", directorName: "Hypatia", signals: [.init(text: "[claim] data compounds", lens: "data", sources: [0])])]
        let user = BriefStages.writeUser(subject: "moat?", members: members, scaffold: scaffold, signals: signals)
        XCTAssertTrue(user.contains("The moat is data"))            // bottom line
        XCTAssertTrue(user.contains("### Finding 1: Data compounds")) // finding
        XCTAssertTrue(user.contains("[claim] data compounds"))       // resolved evidence ref d1#0
        XCTAssertTrue(user.contains("[P0] Pilot"))                   // recommendation
        XCTAssertTrue(user.contains("Hypatia"))                       // director id → name
    }
}
