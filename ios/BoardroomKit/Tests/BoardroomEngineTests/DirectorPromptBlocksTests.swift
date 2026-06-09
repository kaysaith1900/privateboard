import XCTest
import BoardroomCore
@testable import BoardroomEngine

final class DirectorPromptBlocksTests: XCTestCase {
    private func kp(_ body: String, _ vote: String?) -> ConfigEvent.KeyPoint {
        .init(id: UUID().uuidString, body: body, position: 0, vote: vote)
    }

    // MARK: interestLines (#6) · user up/down votes as priority weights

    func testInterestLinesPursueAndDrop() {
        let block = DirectorPromptBlocks.interestLines([
            kp("Anchor on willingness-to-pay", "up"),
            kp("Cut the loyalty-program tangent", "down"),
            kp("Untouched point", nil),          // unvoted → excluded entirely
        ])
        XCTAssertTrue(block.contains("─── USER SIGNAL · WEIGHT THIS ───"))
        XCTAssertTrue(block.contains("PURSUE — the user wants the room to dig deeper here:"))
        XCTAssertTrue(block.contains("  · Anchor on willingness-to-pay"))
        XCTAssertTrue(block.contains("DROP — the user has flagged these threads as not worth more turns:"))
        XCTAssertTrue(block.contains("  · Cut the loyalty-program tangent"))
        XCTAssertFalse(block.contains("Untouched point"))   // unvoted points never surface
    }

    func testInterestLinesPursueOnly() {
        let block = DirectorPromptBlocks.interestLines([kp("Keep pushing on moat", "up")])
        XCTAssertTrue(block.contains("PURSUE"))
        XCTAssertFalse(block.contains("DROP —"))
    }

    func testInterestLinesEmptyWhenNoVotes() {
        XCTAssertEqual(DirectorPromptBlocks.interestLines([]), "")
        XCTAssertEqual(DirectorPromptBlocks.interestLines([kp("unvoted", nil)]), "")
    }

    // MARK: persona few-shot (#12)

    private func ex(_ n: Int) -> PersonaBuilder.PersonaFewShot {
        .init(scenario: "scenario\(n)", genericResponse: "generic\(n)",
              personaResponse: "persona\(n)", rationale: "rationale\(n)")
    }

    func testPersonaFewShotTextMode() {
        let block = DirectorPromptBlocks.personaFewShot(name: "Hypatia", deliveryVoice: false, examples: [ex(1)])
        XCTAssertTrue(block.contains("─── HOW YOU SPEAK · HYPATIA VOICE EXAMPLES ───"))
        XCTAssertTrue(block.contains("  · Scenario · scenario1"))
        XCTAssertTrue(block.contains("  · A generic AI would say · generic1"))
        XCTAssertTrue(block.contains("  · You say · persona1"))
        XCTAssertTrue(block.contains("  · Why these differ · rationale1"))
    }

    func testPersonaFewShotVoiceModeIsProseNoLabels() {
        let block = DirectorPromptBlocks.personaFewShot(name: "Hypatia", deliveryVoice: true, examples: [ex(1)])
        XCTAssertTrue(block.contains("when asked \"scenario1\""))
        XCTAssertTrue(block.contains("you instead rationale1"))
        XCTAssertFalse(block.contains("· Scenario ·"))      // no structured labels in voice
        XCTAssertFalse(block.contains("· You say ·"))
    }

    func testPersonaFewShotCapsAtThree() {
        let block = DirectorPromptBlocks.personaFewShot(name: "X", deliveryVoice: false, examples: [ex(1), ex(2), ex(3), ex(4)])
        XCTAssertTrue(block.contains("scenario3"))
        XCTAssertFalse(block.contains("scenario4"))         // 4th dropped
    }

    func testPersonaFewShotEmptyWhenNone() {
        XCTAssertEqual(DirectorPromptBlocks.personaFewShot(name: "X", deliveryVoice: false, examples: []), "")
    }

    // MARK: persona reflection (#12)

    func testPersonaReflectionNumberedAndCapped() {
        let block = DirectorPromptBlocks.personaReflection((1...8).map { "q\($0)" })
        XCTAssertTrue(block.contains("─── BEFORE YOU SPEAK · SILENT SELF-CHECK ───"))
        XCTAssertTrue(block.contains("  1. q1"))
        XCTAssertTrue(block.contains("  6. q6"))
        XCTAssertFalse(block.contains("7. q7"))             // capped at 6
        XCTAssertEqual(DirectorPromptBlocks.personaReflection([]), "")
    }

    // MARK: user rules (absolute, NON-NEGOTIABLE)

    func testUserRulesBlock() {
        let block = DirectorPromptBlocks.userRules(["不要谈及范冰冰", "  ", "always cite a number"])
        XCTAssertTrue(block.contains("─── ABSOLUTE RULES · set by the user · NON-NEGOTIABLE ───"))
        XCTAssertTrue(block.contains("  · 不要谈及范冰冰"))
        XCTAssertTrue(block.contains("  · always cite a number"))
        XCTAssertFalse(block.contains("  · \n"))            // blank rule filtered
        XCTAssertEqual(DirectorPromptBlocks.userRules([]), "")
        XCTAssertEqual(DirectorPromptBlocks.userRules(["  "]), "")
    }

    // MARK: follow-up prior context (#11)

    func testFollowUpPriorContextWithBriefEnglish() {
        let block = DirectorPromptBlocks.followUpPriorContext(
            parentNumber: 7, parentSubject: "Should we raise prices?",
            briefTitle: "Pricing Verdict", briefBodyMd: "The room settled on value-based pricing.", isZh: false)
        XCTAssertTrue(block.contains("─── CONTINUING FROM ROOM #7 ───"))
        XCTAssertTrue(block.contains("prior subject was: \"Should we raise prices?\""))
        XCTAssertTrue(block.contains("*settled judgement*"))
        XCTAssertTrue(block.contains("## Pricing Verdict"))
        XCTAssertTrue(block.contains("The room settled on value-based pricing."))
        XCTAssertTrue(block.contains("─── END OF PRIOR CONTEXT · NEW QUESTION + DIALOGUE BELOW ───"))
    }

    func testFollowUpPriorContextChineseNoBrief() {
        let block = DirectorPromptBlocks.followUpPriorContext(
            parentNumber: 3, parentSubject: "我们应该涨价吗？",
            briefTitle: nil, briefBodyMd: nil, isZh: true)
        XCTAssertTrue(block.contains("─── 上一场延续 · Room #3 ───"))
        XCTAssertTrue(block.contains("「我们应该涨价吗？」"))
        XCTAssertTrue(block.contains("（上一场没有归档报告"))   // no-brief fallback
        XCTAssertFalse(block.contains("## "))                  // no brief title rendered
        XCTAssertTrue(block.contains("─── 上一场上下文结束"))
    }
}
