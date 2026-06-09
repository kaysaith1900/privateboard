import XCTest
import BoardroomAI
import BoardroomCore
@testable import BoardroomEngine

/// Unit tests for the ported speaker pickers · scripted router (no network), so
/// these lock the PARSING + FALLBACK semantics that must match the desktop:
/// default-to-ASK clarify, default-to-CONTINUE round-wrap, round-robin null
/// fallback, id validation/scrub, and the deterministic diversity guardrail.
final class SpeakerPickerTests: XCTestCase {

    /// Scripted EngineRouter · returns a canned string (or throws) for `call`.
    struct ScriptedRouter: EngineRouter {
        var utility: ModelV? = .haiku_4_5
        var def: ModelV? = .haiku_4_5
        var reach: Set<ModelV> = [.haiku_4_5]
        var response: String = ""
        var fail: Bool = false
        func utilityModelV() -> ModelV? { utility }
        func defaultModelV() -> ModelV? { def }
        func reachableModelVs() -> Set<ModelV> { reach }
        func call(_ messages: [LLMMessage], modelV: ModelV, temperature: Double?, maxTokens: Int?) async throws -> String {
            struct E: Error {}
            if fail { throw E() }
            return response
        }
    }

    private func dir(_ id: String, _ name: String, handle: String, ability: [String: Int] = [:],
                     bio: String = "bio", roleTag: String = "director") -> DirectorRef {
        DirectorRef(id: id, name: name, modelV: .haiku_4_5, handle: handle, roleTag: roleTag,
                    instruction: "", bio: bio, ability: ability)
    }
    private func msg(_ kind: String, _ id: String?, _ body: String, round: Int = 1) -> EngineMessage {
        EngineMessage(id: UUID().uuidString, roomId: "r", authorKind: kind, authorId: id,
                      body: body, roundNum: round, streaming: false)
    }

    // MARK: extractJson

    func testExtractJsonFencedAndBalanced() {
        XCTAssertEqual((PickerSupport.extractJson("```json\n{\"a\":1}\n```") as? [String: Any])?["a"] as? Int, 1)
        XCTAssertEqual((PickerSupport.extractJson("prose before {\"a\":2} trailing") as? [String: Any])?["a"] as? Int, 2)
        XCTAssertNil(PickerSupport.extractJson("not json at all"))
    }

    func testDetectRoomLang() {
        XCTAssertEqual(PickerSupport.detectRoomLang("我们应该怎么做"), .zh)
        XCTAssertEqual(PickerSupport.detectRoomLang("how should we decide"), .en)
    }

    // MARK: clarify gate

    func testClarifyEmptyPromptAsksWithoutLLM() async {
        let d = await SpeakerPicker.pickChairClarifyDecision(router: ScriptedRouter(), history: [])
        XCTAssertTrue(d.shouldAsk)
        XCTAssertEqual(d.rationale, "no user prompt yet")
    }

    func testClarifyExplicitFalseReleases() async {
        let r = ScriptedRouter(response: #"{"ask": false, "rationale": "self-sufficient"}"#)
        let d = await SpeakerPicker.pickChairClarifyDecision(router: r, history: [msg("user", nil, "Should we raise a Series A now given 18mo runway?")])
        XCTAssertFalse(d.shouldAsk)
        XCTAssertEqual(d.rationale, "self-sufficient")
    }

    func testClarifyMissingAskDefaultsToAsk() async {
        let r = ScriptedRouter(response: #"{"rationale": "x"}"#)
        let d = await SpeakerPicker.pickChairClarifyDecision(router: r, history: [msg("user", nil, "help me decide")])
        XCTAssertTrue(d.shouldAsk)   // only literal false flips
    }

    func testClarifyLLMThrowDefaultsToAsk() async {
        let r = ScriptedRouter(response: "", fail: true)
        let d = await SpeakerPicker.pickChairClarifyDecision(router: r, history: [msg("user", nil, "q")])
        XCTAssertTrue(d.shouldAsk)
    }

    func testClarifyNoModelDefaultsToAsk() async {
        let r = ScriptedRouter(utility: nil, response: #"{"ask": false}"#)
        let d = await SpeakerPicker.pickChairClarifyDecision(router: r, history: [msg("user", nil, "q")])
        XCTAssertTrue(d.shouldAsk)
    }

    // MARK: round wrap

    func testRoundWrapEndOnlyOnLiteralEnd() async {
        let end = await SpeakerPicker.pickRoundWrap(
            router: ScriptedRouter(response: #"{"recommendation":"end","rationale":"done"}"#),
            history: [msg("agent", "a", "point")], roundNum: 3, roomSubject: "x")
        XCTAssertEqual(end.recommendation, "end")
        let other = await SpeakerPicker.pickRoundWrap(
            router: ScriptedRouter(response: #"{"recommendation":"maybe"}"#),
            history: [msg("agent", "a", "point")], roundNum: 1, roomSubject: "x")
        XCTAssertEqual(other.recommendation, "continue")
    }

    func testRoundWrapThrowDefaultsToContinue() async {
        let d = await SpeakerPicker.pickRoundWrap(router: ScriptedRouter(fail: true),
                                                  history: [msg("agent", "a", "p")], roundNum: 2, roomSubject: nil)
        XCTAssertEqual(d.recommendation, "continue")
    }

    // MARK: next speaker

    func testNextSpeakerNeedsTwoCandidates() async {
        let d = await SpeakerPicker.pickNextSpeaker(router: ScriptedRouter(response: #"{"agent_id":"a"}"#),
                                                    candidates: [dir("a", "A", handle: "@a")],
                                                    history: [], roomSubject: "x")
        XCTAssertNil(d.agentId)
    }

    func testNextSpeakerValidIdAndScrub() async {
        let cands = [dir("idA", "Alice", handle: "@a"), dir("idB", "Bob", handle: "@b")]
        let r = ScriptedRouter(response: #"{"agent_id":"idB","rationale":"idB brings rigor","intervention":"none"}"#)
        let d = await SpeakerPicker.pickNextSpeaker(router: r, candidates: cands,
                                                    history: [msg("agent", "idA", "claim")], roomSubject: "x")
        XCTAssertEqual(d.agentId, "idB")
        XCTAssertEqual(d.rationale, "Bob brings rigor")   // leaked id scrubbed to name
        XCTAssertNil(d.intervention)                       // "none" → nil
    }

    func testNextSpeakerInvalidIdFallsBack() async {
        let cands = [dir("idA", "A", handle: "@a"), dir("idB", "B", handle: "@b")]
        let r = ScriptedRouter(response: #"{"agent_id":"ghost","rationale":"r"}"#)
        let d = await SpeakerPicker.pickNextSpeaker(router: r, candidates: cands, history: [], roomSubject: nil)
        XCTAssertNil(d.agentId)
    }

    func testNextSpeakerKeepsRealIntervention() async {
        let cands = [dir("idA", "A", handle: "@a"), dir("idB", "B", handle: "@b")]
        let r = ScriptedRouter(response: #"{"agent_id":null,"rationale":"","intervention":"Define 'moat' before continuing."}"#)
        let d = await SpeakerPicker.pickNextSpeaker(router: r, candidates: cands, history: [], roomSubject: nil)
        XCTAssertEqual(d.intervention, "Define 'moat' before continuing.")
    }

    // MARK: director casting

    func testDirectorsTrivialSeatsAll() async {
        let cands = [dir("a", "A", handle: "@a"), dir("b", "B", handle: "@b")]
        let d = await SpeakerPicker.pickDirectors(router: ScriptedRouter(), subject: "x", candidates: cands)
        XCTAssertFalse(d.fromLlm)
        XCTAssertEqual(d.picks.map(\.agentId), ["a", "b"])
    }

    func testDirectorsLLMPickThenDiversityGuardrail() async {
        // LLM picks 3 all-dissent directors; the guardrail must swap one for a
        // rigor filler so ≥2 lenses are covered.
        let cands = [
            dir("a", "A", handle: "@a", ability: ["dissent": 8]),
            dir("b", "B", handle: "@b", ability: ["dissent": 8]),
            dir("c", "C", handle: "@c", ability: ["dissent": 8]),
            dir("d", "D", handle: "@d", ability: ["rigor": 9]),
            dir("e", "E", handle: "@e", ability: ["empathy": 8]),
        ]
        let r = ScriptedRouter(response: #"{"picks":[{"handle":"@a","reason":"lead"},{"handle":"@b"},{"handle":"@c"}],"rationale":"all skeptics"}"#)
        let d = await SpeakerPicker.pickDirectors(router: r, subject: "x", candidates: cands)
        XCTAssertTrue(d.fromLlm)
        let ids = Set(d.picks.map(\.agentId))
        XCTAssertEqual(d.picks.count, 3)
        XCTAssertTrue(ids.contains("d"), "rigor filler swapped in by the diversity guardrail")
        XCTAssertEqual(SpeakerPicker.coveredLenses(d.picks.map { p in cands.first { $0.id == p.agentId }! }).count, 2)
    }

    func testDirectorsThrowFallsBackToCast() async {
        let cands = (0..<5).map { dir("id\($0)", "N\($0)", handle: "@h\($0)") }
        let d = await SpeakerPicker.pickDirectors(router: ScriptedRouter(fail: true), subject: "x", candidates: cands)
        XCTAssertFalse(d.fromLlm)
        XCTAssertEqual(d.picks.count, 3)
    }
}
