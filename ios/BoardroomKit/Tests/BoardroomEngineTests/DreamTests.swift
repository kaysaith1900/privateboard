import XCTest
import BoardroomAI
import BoardroomCore
@testable import BoardroomEngine

/// Dream-cycle parsers (cluster / merge / conflict) · lock the tolerant JSON
/// shapes + the known-id / singleton / self-pair gates the metabolism relies on.
final class DreamTests: XCTestCase {

    func testParseClusterDropsSingletonsAndUnknownIds() {
        let known: Set<String> = ["m1", "m2", "m3"]
        let out = Dream.parseClusterOutput(#"[["m1","m2"],["m3"],["m1","ghost"]]"#, known: known)
        XCTAssertEqual(out.count, 1)            // ["m3"] singleton dropped; ["m1","ghost"]→["m1"] singleton dropped
        XCTAssertEqual(Set(out[0]), ["m1", "m2"])
    }

    func testParseClusterFenceAndEmpty() {
        XCTAssertEqual(Dream.parseClusterOutput("```json\n[]\n```", known: ["m1"]).count, 0)
        XCTAssertEqual(Dream.parseClusterOutput("not json", known: ["m1"]).count, 0)
    }

    func testParseMerge() {
        let ok = Dream.parseMergeOutput(#"{"content":"Kai prefers concise output","kind":"preference"}"#)
        XCTAssertEqual(ok?.content, "Kai prefers concise output")
        XCTAssertEqual(ok?.kind, "preference")
        XCTAssertEqual(Dream.parseMergeOutput(#"{"content":"x","kind":"bogus"}"#)?.kind, "fact")  // fallback
        XCTAssertNil(Dream.parseMergeOutput(#"{"content":"\#(String(repeating: "x", count: 250))","kind":"fact"}"#))  // >200
    }

    func testParseConflictGates() {
        let known: Set<String> = ["m1", "m2"]
        let out = Dream.parseConflictOutput(#"[{"older":"m1","newer":"m2","why":"w"},{"older":"m1","newer":"m1"},{"older":"m1","newer":"ghost"}]"#, known: known)
        XCTAssertEqual(out.count, 1)            // self-pair + unknown dropped
        XCTAssertEqual(out[0].older, "m1"); XCTAssertEqual(out[0].newer, "m2")
    }

    func testParseHarvestOutput() {
        let raw = #"""
        {
          "newTags": [
            {"label":"founder","claim":"Kai is a founder who reasons from first principles","confidence":0.9,"provenanceRooms":3},
            {"label":"","claim":"empty label dropped","confidence":0.5,"provenanceRooms":1}
          ],
          "reinforce": [{"id":"tag-1"},{"id":""}],
          "supersede": [{"oldId":"tag-2","newTag":{"label":"anti-jargon","claim":"Kai refuses corporate vocabulary","confidence":0.8,"provenanceRooms":2}}]
        }
        """#
        let out = Dream.parseHarvestOutput(raw)
        XCTAssertEqual(out.newTags.count, 1)               // empty-label tag dropped
        XCTAssertEqual(out.newTags[0].label, "founder")
        XCTAssertEqual(out.newTags[0].provenanceRooms, 3)
        XCTAssertEqual(out.reinforce, ["tag-1"])           // empty id dropped
        XCTAssertEqual(out.supersede.count, 1)
        XCTAssertEqual(out.supersede[0].oldId, "tag-2")
        XCTAssertEqual(out.supersede[0].newTag.label, "anti-jargon")
    }

    func testParseHarvestTolerant() {
        XCTAssertEqual(Dream.parseHarvestOutput("not json").newTags.count, 0)
        // fenced + missing arrays → empty, no crash
        let fenced = Dream.parseHarvestOutput("```json\n{\"newTags\":[]}\n```")
        XCTAssertEqual(fenced.newTags.count, 0)
        XCTAssertEqual(fenced.reinforce.count, 0)
    }

    func testHarvestPromptShape() {
        let mem = MemoryRow(id: "m1", content: "Kai is a founder", kind: "fact", tier: "long",
                            confidence: 0.9, createdAt: 0, provenanceRooms: 3, pinned: false)
        let existing = UserLongRow(id: "u1", label: "founder", claim: "Kai is a founder", confidence: 0.8, provenanceRooms: 2)
        let p = Dream.harvestPrompt(userName: "Kai", chairLong: [mem], existing: [existing])
        XCTAssertTrue(p.contains("[u1] founder"))
        XCTAssertTrue(p.contains("(fact, conf=0.90, rooms=3, tier=long) Kai is a founder"))
        XCTAssertTrue(p.contains("sanctuary table"))
    }

    func testDreamCounterThreshold() async {
        let c = DreamCounter()
        // director threshold 5
        var fired = false
        for _ in 0..<5 { fired = await c.bump(agentId: "d", isChair: false) }
        XCTAssertTrue(fired)
        // chair threshold 3
        let c2 = DreamCounter()
        _ = await c2.bump(agentId: "ch", isChair: true)
        _ = await c2.bump(agentId: "ch", isChair: true)
        let third = await c2.bump(agentId: "ch", isChair: true)
        XCTAssertTrue(third)
    }
}
