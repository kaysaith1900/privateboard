import XCTest
import BoardroomAI
import BoardroomCore
@testable import BoardroomEngine

/// Thread-safe collector for the streaming build's @Sendable onEvent callback.
private actor PhaseCollector {
    private(set) var phases: [Int] = []
    private(set) var dimensionSeen = false
    func start(_ p: Int) { phases.append(p) }
    func sawDimension() { dimensionSeen = true }
}

/// Profile-pass parser + flatten + spec-blob encode (the slice that feeds the
/// live loop). Locks the lenient alias parsing + toCore prefixes + blob shape.
final class PersonaBuilderTests: XCTestCase {

    func testParseCanonical() {
        let raw = """
        ```json
        {
          "intellectualLineage": { "influencedBy": ["Popper · falsifiability"], "opposedTo": ["vibes PMF"] },
          "loadBearingConcepts": [{ "name": "second-order effects", "gloss": "the move after the move" }],
          "referentSet": [{ "ref": "Quibi", "why": "distribution ≠ product" }],
          "failureModes": ["over-corrects toward dissent"],
          "contrarianTakes": ["brand is mostly distribution"]
        }
        ```
        """
        let p = PersonaBuilder.parseAgentProfile(raw)
        XCTAssertNotNil(p)
        XCTAssertEqual(p?.intellectualLineage.influencedBy, ["Popper · falsifiability"])
        XCTAssertEqual(p?.loadBearingConcepts.first?.name, "second-order effects")
        XCTAssertEqual(p?.contrarianTakes, ["brand is mostly distribution"])
    }

    func testParseSnakeCaseAndBareStringConcepts() {
        // weaker models: snake_case + bare-string concept ("name · gloss")
        let raw = """
        { "intellectual_lineage": { "influences": ["Munger"], "opposes": ["scale worship"] },
          "concepts": ["Chesterton's fence · name why it was built"],
          "contrarian_takes": ["AI-native is marketing"] }
        """
        let p = PersonaBuilder.parseAgentProfile(raw)
        XCTAssertEqual(p?.intellectualLineage.influencedBy, ["Munger"])
        XCTAssertEqual(p?.loadBearingConcepts.first?.name, "Chesterton's fence")
        XCTAssertEqual(p?.loadBearingConcepts.first?.gloss, "name why it was built")
        XCTAssertEqual(p?.contrarianTakes, ["AI-native is marketing"])
    }

    func testParseEmptyReturnsNil() {
        XCTAssertNil(PersonaBuilder.parseAgentProfile("not json"))
        XCTAssertNil(PersonaBuilder.parseAgentProfile(#"{"intellectualLineage":{"influencedBy":[],"opposedTo":[]}}"#))
    }

    func testToCoreFlattenPrefixes() {
        let p = PersonaBuilder.AgentProfile(
            intellectualLineage: .init(influencedBy: ["Popper"], opposedTo: ["vibes"]),
            loadBearingConcepts: [.init(name: "C1", gloss: "g1"), .init(name: "C2", gloss: "")],
            referentSet: [.init(ref: "Quibi", why: "w"), .init(ref: "Concorde", why: "")],
            failureModes: ["fm"], contrarianTakes: ["ct"])
        let core = PersonaBuilder.toCore(p)
        XCTAssertEqual(core.intellectualLineage, ["Influenced by: Popper", "Opposed to: vibes"])
        XCTAssertEqual(core.loadBearingConcepts, ["C1: g1", "C2"])
        XCTAssertEqual(core.referentSet, ["Quibi — w", "Concorde"])
        XCTAssertEqual(core.failureModes, ["fm"])
        XCTAssertEqual(core.contrarianTakes, ["ct"])
    }

    struct ScriptedRouter: EngineRouter {
        var response: String
        func utilityModelV() -> ModelV? { .haiku_4_5 }
        func defaultModelV() -> ModelV? { .haiku_4_5 }
        func reachableModelVs() -> Set<ModelV> { [.haiku_4_5] }
        func call(_ messages: [LLMMessage], modelV: ModelV, temperature: Double?, maxTokens: Int?) async throws -> String { response }
    }
    private let profile = PersonaBuilder.AgentProfile(
        intellectualLineage: .init(influencedBy: ["Popper"], opposedTo: []),
        loadBearingConcepts: [], referentSet: [], failureModes: [], contrarianTakes: ["ct"])

    func testBuildRulesFiltersKind() async {
        let r = ScriptedRouter(response: #"{"rules":[{"kind":"always","rule":"cite a source"},{"kind":"bogus","rule":"x"},{"kind":"never","rule":"y"}]}"#)
        let rules = await PersonaBuilder.buildRules(router: r, description: "d", profile: profile, knowledgeSummary: "")
        XCTAssertEqual(rules.map(\.kind), ["always", "never"])   // bogus kind dropped
    }

    func testBuildNameValidatesLength() async {
        let ok = await PersonaBuilder.buildName(router: ScriptedRouter(response: #"{"name":"Aurelia Strand","handle":"aurelia"}"#),
                                                description: "d", profile: profile)
        XCTAssertEqual(ok?.name, "Aurelia Strand")
        let tooShort = await PersonaBuilder.buildName(router: ScriptedRouter(response: #"{"name":"A","handle":"a"}"#),
                                                      description: "d", profile: profile)
        XCTAssertNil(tooShort)
    }

    func testBuildFewShotRequiresScenarioAndPersona() async {
        let r = ScriptedRouter(response: #"{"examples":[{"scenario":"s","personaResponse":"p","rationale":"r"},{"scenario":"","personaResponse":"x"}]}"#)
        let ex = await PersonaBuilder.buildFewShot(router: r, description: "d", profile: profile, rules: [])
        XCTAssertEqual(ex.count, 1)
        XCTAssertEqual(ex.first?.scenario, "s")
    }

    func testPlanDimensionsGates() async {
        // <3-word query dropped; duplicate query dropped; seed-equal query dropped.
        let r = ScriptedRouter(response: #"""
        {"dimensions":[
          {"dimension":"biography","query":"life formative period work"},
          {"dimension":"short","query":"too short"},
          {"dimension":"dup","query":"life formative period work"}
        ]}
        """#)
        let dims = await PersonaBuilder.planDimensions(router: r, model: .haiku_4_5, description: "seed", profile: profile)
        XCTAssertEqual(dims.count, 1)
        XCTAssertEqual(dims.first?.dimension, "biography")
    }

    func testBuildFullStreamingEmitsSevenPhases() async {
        // A valid profile JSON lets phase 1 succeed; later phases parse it as their
        // own shapes → graceful empties. Search disabled → no dimension plan.
        let profileJSON = #"{"intellectualLineage":{"influencedBy":["Popper"],"opposedTo":[]},"contrarianTakes":["x"]}"#
        let collector = PhaseCollector()
        let built = await PersonaBuilder.buildFullStreaming(
            router: ScriptedRouter(response: profileJSON), description: "a stoic systems thinker",
            webSearch: .disabled
        ) { ev in
            switch ev {
            case .phaseStart(let p, _, _, _): await collector.start(p)
            case .dimensionPlan: await collector.sawDimension()
            default: break
            }
        }
        let phases = await collector.phases
        XCTAssertEqual(phases, [1, 2, 3, 4, 5, 6, 7])    // every phase boundary, in order
        let sawDim = await collector.dimensionSeen
        XCTAssertFalse(sawDim)                            // search disabled → no Phase-2 plan
        XCTAssertNotNil(built)                            // build completed end-to-end
    }

    func testSpecBlobShapeMatchesReader() throws {
        let core = PersonaBuilder.PersonaSpecCore(intellectualLineage: ["l"], loadBearingConcepts: ["c"],
                                                  referentSet: ["r"], failureModes: ["fm"], contrarianTakes: ["ct"])
        let json = PersonaBuilder.personaSpecJSON(core: core, description: "desc", generatedAt: "2026")
        let data = try XCTUnwrap(json?.data(using: .utf8))
        let obj = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let spec = try XCTUnwrap(obj["spec"] as? [String: Any])
        // GRDBRoomStore.parsePersonaSpec reads spec.contrarianTakes / failureModes
        XCTAssertEqual(spec["contrarianTakes"] as? [String], ["ct"])
        XCTAssertEqual(spec["failureModes"] as? [String], ["fm"])
    }
}
