import XCTest
import BoardroomAI
@testable import BoardroomEngine

final class ChairPromptBuilderTests: XCTestCase {
    private func ctx(mode: String = "constructive", voice: Bool = false,
                     history: [ChairPromptBuilder.HistoryTurn] = []) -> ChairPromptBuilder.Context {
        .init(chairInstruction: "You are Socrates, the chair.",
              subject: "Should we raise prices?", mode: mode, intensity: "sharp",
              directors: [.init(name: "Alice", handle: "@alice", roleTag: "economist"),
                          .init(name: "Bob", handle: "@bob", roleTag: "skeptic")],
              userName: "Kay", userIntro: "founder", deliveryVoice: voice, history: history)
    }

    func testSystemHeaderHasRoomContextAndLanguageRule() {
        let msgs = ChairPromptBuilder.clarify(ctx(), turnNumber: 1, maxTurns: 3)
        let sys = msgs.first!
        XCTAssertEqual(sys.role, .system)
        XCTAssertTrue(sys.content.contains("You are Socrates, the chair."))   // instruction first
        XCTAssertTrue(sys.content.contains("Room subject: Should we raise prices?"))
        XCTAssertTrue(sys.content.contains("Tone: constructive, Intensity: sharp"))
        XCTAssertTrue(sys.content.contains("Alice (@alice) — economist"))
        XCTAssertTrue(sys.content.contains("User: Kay: founder"))
        XCTAssertTrue(sys.content.contains("─── LANGUAGE ───"))
    }

    func testClarifyFirstTurnHasReleaseAndClarifyPaths() {
        let msgs = ChairPromptBuilder.clarify(ctx(), turnNumber: 1, maxTurns: 3)
        let sys = msgs.first!.content
        XCTAssertTrue(sys.contains("YOUR TASK · OPEN THE ROOM"))
        XCTAssertTrue(sys.contains("RELEASE PATH"))
        XCTAssertTrue(sys.contains("**Topic.**"))
        XCTAssertTrue(sys.contains("**主题。**"))                    // ZH template present
        XCTAssertTrue(sys.contains("Budget: clarification turn 1 of 3"))
        XCTAssertTrue(sys.contains("Don't drag this out"))           // remaining ≥ 2 budget line
        // last message is the user nudge.
        XCTAssertEqual(msgs.last?.role, .user)
        XCTAssertTrue(msgs.last!.content.contains("Open the room"))
    }

    func testClarifyFollowUpAndBudgetLines() {
        let two = ChairPromptBuilder.clarify(ctx(), turnNumber: 2, maxTurns: 3).first!.content
        XCTAssertTrue(two.contains("DECIDE — RELEASE OR ONE MORE QUESTION"))
        XCTAssertTrue(two.contains("at most 1 more turn"))           // remaining == 1
        let last = ChairPromptBuilder.clarify(ctx(), turnNumber: 3, maxTurns: 3).first!.content
        XCTAssertTrue(last.contains("You MUST respond with READY now"))  // remaining == 0
    }

    func testCritiqueModeAddendumOnlyInCritique() {
        XCTAssertTrue(ChairPromptBuilder.clarify(ctx(mode: "critique"), turnNumber: 1, maxTurns: 3).first!.content.contains("CRITIQUE MODE · stakes calibration"))
        XCTAssertFalse(ChairPromptBuilder.clarify(ctx(mode: "debate"), turnNumber: 1, maxTurns: 3).first!.content.contains("CRITIQUE MODE · stakes calibration"))
    }

    func testVoiceDeliveryBlock() {
        XCTAssertTrue(ChairPromptBuilder.clarify(ctx(voice: true), turnNumber: 1, maxTurns: 3).first!.content.contains("DELIVERY · VOICE MODE"))
        XCTAssertFalse(ChairPromptBuilder.clarify(ctx(voice: false), turnNumber: 1, maxTurns: 3).first!.content.contains("DELIVERY · VOICE MODE"))
    }

    func testRoundEndHasPointsAndModeShiftFormat() {
        let msgs = ChairPromptBuilder.roundEnd(ctx(mode: "debate"))
        let sys = msgs.first!.content
        XCTAssertTrue(sys.contains("YOUR TASK · CLOSE THIS ROUND"))
        XCTAssertTrue(sys.contains("POINTS:"))
        XCTAssertTrue(sys.contains("Current tone: `debate`"))
        XCTAssertTrue(sys.contains("MODE-SHIFT: <brainstorm | constructive | debate | research | critique>"))
        XCTAssertEqual(msgs.last?.role, .user)
    }

    func testHistoryRendersSpeakerPrefixesAndCollapses() {
        let h: [ChairPromptBuilder.HistoryTurn] = [
            .init(kind: .user, body: "raise 10%?"),
            .init(kind: .agent, name: "Alice", handle: "@alice", body: "margins allow it"),
            .init(kind: .agent, name: "Bob", handle: "@bob", body: "churn risk"),
        ]
        let msgs = ChairPromptBuilder.clarify(ctx(history: h), turnNumber: 2, maxTurns: 3)
        // Between system and the final user-nudge sit the collapsed history turns.
        let mid = msgs.dropFirst().dropLast()
        let joined = mid.map(\.content).joined(separator: "\n")
        XCTAssertTrue(joined.contains("[Kay] raise 10%?"))
        XCTAssertTrue(joined.contains("[Alice · @alice] margins allow it"))
        XCTAssertTrue(joined.contains("[Bob · @bob] churn risk"))
        // Two consecutive agent turns collapse into ONE user-role message.
        XCTAssertTrue(mid.allSatisfy { $0.role == .user })
    }

    // MARK: CHAIR_MODE_PROTOCOL (#5) · injected for research/brainstorm only

    func testChairModeProtocolResearch() {
        let sys = ChairPromptBuilder.clarify(ctx(mode: "research"), turnNumber: 1, maxTurns: 3).first!.content
        XCTAssertTrue(sys.contains("CHAIR · RESEARCH-MODE PROTOCOL"))
        XCTAssertTrue(sys.contains("Lens-coverage tracking"))
        XCTAssertTrue(sys.contains("Trigger-based inquiry"))
        XCTAssertFalse(sys.contains("CHAIR · BRAINSTORM-MODE PROTOCOL"))
    }

    func testChairModeProtocolBrainstorm() {
        let sys = ChairPromptBuilder.roundEnd(ctx(mode: "brainstorm")).first!.content
        XCTAssertTrue(sys.contains("CHAIR · BRAINSTORM-MODE PROTOCOL"))
        XCTAssertTrue(sys.contains("AMPLIFIER, not a gatekeeper"))
    }

    func testChairModeProtocolAbsentForOtherModes() {
        for mode in ["constructive", "debate", "critique"] {
            let sys = ChairPromptBuilder.clarify(ctx(mode: mode), turnNumber: 1, maxTurns: 3).first!.content
            XCTAssertFalse(sys.contains("MODE PROTOCOL"), "mode \(mode) should ship no chair protocol")
        }
    }

    func testNoMercyToneMapsToDebateProtocol() {
        // no-mercy has no protocol of its own AND normalizes to debate (also none) →
        // the dictionary lookup must not crash and must inject nothing.
        XCTAssertEqual(ChairPromptBuilder.normalizeTone("no-mercy"), "debate")
        let sys = ChairPromptBuilder.clarify(ctx(mode: "no-mercy"), turnNumber: 1, maxTurns: 3).first!.content
        XCTAssertFalse(sys.contains("MODE PROTOCOL"))
    }

    // MARK: LANGUAGE LOCK tail (#4) · appended last for recency bias

    func testLanguageLockTailEnglishRoom() {
        // ctx() subject is English → English lock at the very tail.
        let sys = ChairPromptBuilder.clarify(ctx(), turnNumber: 1, maxTurns: 3).first!.content
        XCTAssertTrue(sys.contains("─── LANGUAGE LOCK ───"))
        XCTAssertTrue(sys.contains("LOCKED to English"))
        XCTAssertTrue(sys.hasSuffix("No mixed languages."), "lock block must be the final tail")
    }

    // MARK: SHARED MATERIALS (#10) · web-search grounding on clarify turns

    func testSharedMaterialsInjectedWhenPresent() {
        let c = ChairPromptBuilder.Context(
            chairInstruction: "You are the chair.", subject: "What did OpenAI ship this week?",
            mode: "research", intensity: "sharp",
            directors: [.init(name: "A", handle: "@a", roleTag: "x")], userName: "Kay",
            sharedMaterials: "─── SHARED MATERIALS · WEB SEARCH ───\n[1] OpenAI ships GPT-5\n─── END SHARED MATERIALS ───")
        let sys = ChairPromptBuilder.clarify(c, turnNumber: 1, maxTurns: 3).first!.content
        XCTAssertTrue(sys.contains("─── SHARED MATERIALS · WEB SEARCH ───"))
        XCTAssertTrue(sys.contains("[1] OpenAI ships GPT-5"))
        // Sits before the task (chair reads materials before being told what to do).
        XCTAssertTrue(sys.range(of: "SHARED MATERIALS")!.lowerBound < sys.range(of: "YOUR TASK")!.lowerBound)
    }

    func testNoSharedMaterialsBlockWhenEmpty() {
        let sys = ChairPromptBuilder.clarify(ctx(), turnNumber: 1, maxTurns: 3).first!.content
        XCTAssertFalse(sys.contains("SHARED MATERIALS"))
    }

    func testLanguageLockTailChineseRoom() {
        let zh = ChairPromptBuilder.Context(
            chairInstruction: "你是主席。", subject: "我们应该涨价吗？", mode: "constructive",
            intensity: "sharp", directors: [.init(name: "Alice", handle: "@alice", roleTag: "经济学家")],
            userName: "Kay")
        let sys = ChairPromptBuilder.clarify(zh, turnNumber: 1, maxTurns: 3).first!.content
        XCTAssertTrue(sys.contains("─── 语言锁定 (LANGUAGE LOCK) ───"))
        XCTAssertTrue(sys.contains("本对话的工作语言已锁定为【中文】。"))
    }
}
