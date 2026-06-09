import XCTest
import BoardroomAI
import BoardroomCore
@testable import BoardroomEngine

/// Memory-extraction parser + transcript builder (the desktop `parseExtractionOutput`
/// semantics: NONE sentinel, JSON-line-per-note, kind fallback, confidence clamp,
/// cap 3, fence strip).
final class MemoryTests: XCTestCase {

    func testParseNoneAndEmpty() {
        XCTAssertEqual(Memory.parseExtractionOutput("NONE").count, 0)
        XCTAssertEqual(Memory.parseExtractionOutput("  none  ").count, 0)
        XCTAssertEqual(Memory.parseExtractionOutput("").count, 0)
    }

    func testParseJsonLines() {
        let raw = """
        {"content": "Kai is a founder building an iOS app", "kind": "fact", "confidence": 0.9}
        {"content": "prefers terse replies", "kind": "preference", "confidence": 0.6}
        """
        let notes = Memory.parseExtractionOutput(raw)
        XCTAssertEqual(notes.count, 2)
        XCTAssertEqual(notes[0].kind, "fact")
        XCTAssertEqual(notes[0].confidence, 0.9, accuracy: 0.001)
        XCTAssertEqual(notes[1].kind, "preference")
    }

    func testParseKindFallbackAndCap() {
        let raw = (0..<5).map { "{\"content\": \"note \($0)\", \"kind\": \"bogus\", \"confidence\": 2}" }.joined(separator: "\n")
        let notes = Memory.parseExtractionOutput(raw)
        XCTAssertEqual(notes.count, 3)                 // hard cap 3
        XCTAssertEqual(notes[0].kind, "fact")          // bogus kind → fact
        XCTAssertEqual(notes[0].confidence, 1.0)       // 2 clamped to 1
    }

    func testParseStripsFence() {
        let raw = "```json\n{\"content\": \"x is a designer\", \"kind\": \"fact\"}\n```"
        let notes = Memory.parseExtractionOutput(raw)
        XCTAssertEqual(notes.count, 1)
        XCTAssertEqual(notes[0].confidence, 0.7)       // missing → default 0.7
    }

    func testBuildTranscriptLabels() {
        let agents = [DirectorRef(id: "d1", name: "Hypatia", modelV: .haiku_4_5, handle: "@hyp")]
        let msgs = [
            EngineMessage(id: "1", roomId: "r", authorKind: "user", authorId: nil, body: "my plan", roundNum: 1, streaming: false),
            EngineMessage(id: "2", roomId: "r", authorKind: "agent", authorId: "d1", body: "counterpoint", roundNum: 1, streaming: false),
        ]
        let t = Memory.buildTranscript(msgs, agents: agents, userName: "Kai")
        XCTAssertEqual(t, "[Kai] my plan\n\n[Hypatia · @hyp] counterpoint")
    }
}
