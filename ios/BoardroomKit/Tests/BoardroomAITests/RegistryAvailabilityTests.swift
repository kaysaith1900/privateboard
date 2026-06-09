import XCTest
@testable import BoardroomAI

final class RegistryTests: XCTestCase {
    func testRegistryShape() {
        XCTAssertEqual(Registry.all.count, 18)
        XCTAssertEqual(Set(Registry.all.map(\.v)).count, 18, "no duplicate modelV")
        XCTAssertEqual(Registry.meta(.opus_4_7)?.directApiId, "claude-opus-4-7")
        XCTAssertEqual(Registry.meta(id: "sonnet-4-6")?.displayName, "Sonnet 4.6")
        XCTAssertNil(Registry.meta(id: "not-a-model"))
        XCTAssertTrue(Registry.isModelV("kimi-k2-6"))
        XCTAssertFalse(Registry.isModelV("kimi-k9"))
    }

    func testNoTemperatureIds() {
        // opus-4-7 + opus-4-8 are the noTemperature models → their carrier ids.
        XCTAssertTrue(Registry.meta(.opus_4_7)?.noTemperature ?? false)
        XCTAssertTrue(Registry.meta(.opus_4_8)?.noTemperature ?? false)
        XCTAssertFalse(Registry.meta(.sonnet_4_6)?.noTemperature ?? true)
        XCTAssertTrue(Registry.noTemperatureIds.contains("claude-opus-4-7"))      // direct
        XCTAssertTrue(Registry.noTemperatureIds.contains("anthropic/claude-opus-4.7")) // OR
        XCTAssertTrue(Registry.noTemperatureIds.contains("claude-opus-4.7"))      // B.AI
        XCTAssertFalse(Registry.noTemperatureIds.contains("claude-sonnet-4-6"))
    }

    func testBaiGaps() {
        // These three carry no baiId (not on B.AI's catalog).
        XCTAssertNil(Registry.meta(.opus_4_6_fast)?.baiId)
        XCTAssertNil(Registry.meta(.codex_5_4)?.baiId)
        XCTAssertNil(Registry.meta(.gemini_3_1_flash)?.baiId)
        XCTAssertEqual(Registry.meta(.kimi_k2_6)?.baiId, "kimi-k2.5")   // B.AI still on K2.5
    }
}

final class AvailabilityTests: XCTestCase {
    func testOpenRouterReachesEverything() {
        let r = Availability.reachable(active: .openrouter)
        XCTAssertEqual(r.count, 18)
        XCTAssertTrue(r.allSatisfy { $0.preferredRoute == .openrouter })
    }

    func testBaiExcludesModelsWithoutBaiId() {
        let r = Availability.reachable(active: .bai)
        XCTAssertEqual(r.count, 15)   // 18 minus opus-4-6-fast, codex-5-4, gemini-3-1-flash
        XCTAssertFalse(r.contains { $0.modelV == .codex_5_4 })
        XCTAssertTrue(r.allSatisfy { $0.preferredRoute == .bai })
    }

    func testDirectProviderOnlyOwnNonUniversalModels() {
        let r = Availability.reachable(active: .anthropic)
        XCTAssertEqual(Set(r.map(\.modelV)), [.sonnet_4_6, .opus_4_8, .opus_4_7, .opus_4_6_fast, .haiku_4_5])
        XCTAssertTrue(r.allSatisfy { $0.preferredRoute == .direct })
        // deepseek is viaUniversalOnly → unreachable on a direct deepseek key.
        XCTAssertTrue(Availability.reachable(active: .deepseek).isEmpty)
    }

    func testNoKeyReachesNothing() {
        XCTAssertTrue(Availability.reachable(active: nil).isEmpty)
        XCTAssertNil(Availability.defaultModel(active: nil))
    }

    func testWireIdPerRoute() {
        let opus = Registry.meta(.opus_4_7)!
        XCTAssertEqual(Availability.wireId(opus, route: .direct), "claude-opus-4-7")
        XCTAssertEqual(Availability.wireId(opus, route: .openrouter), "anthropic/claude-opus-4.7")
        XCTAssertEqual(Availability.wireId(opus, route: .bai), "claude-opus-4.7")
        XCTAssertNil(Availability.wireId(Registry.meta(.opus_4_6_fast)!, route: .bai))
    }

    func testDefaultModelFastPolicy() {
        XCTAssertEqual(Availability.defaultModel(active: .anthropic), .haiku_4_5)       // provider fast
        XCTAssertEqual(Availability.defaultModel(active: .openrouter), .opus_4_6_fast)  // carrier fast
        XCTAssertEqual(Availability.defaultModel(active: .bai), .haiku_4_5)
    }

    func testUtilityModel() {
        XCTAssertEqual(Availability.utilityModel(active: .anthropic), .sonnet_4_6)   // cheapByCarrier
        XCTAssertEqual(Availability.utilityModel(active: .openrouter), .haiku_4_5)
        XCTAssertNil(Availability.utilityModel(active: nil))
    }
}
