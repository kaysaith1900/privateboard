import Foundation

/// Model availability + carrier routing — the Swift port of the pure logic in
/// `src/ai/availability.ts`. Under the single-active-LLM-credential invariant,
/// the user has at most one LLM provider active; this resolves which models
/// that one key can reach, which carrier route to use, and which id string to
/// send on the wire.

/// The active LLM provider (carrier). Multi-model carriers (openrouter, bai)
/// reach the whole catalog; the rest are single-model direct providers.
public enum LLMCarrier: String, Sendable, CaseIterable {
    case anthropic, openai, google, xai, deepseek, zhipu, moonshot, minimax
    case openrouter, bai

    /// The wire route this carrier uses.
    public var route: ModelRoute {
        switch self {
        case .openrouter: return .openrouter
        case .bai: return .bai
        default: return .direct
        }
    }
}

public enum ModelRoute: String, Sendable { case direct, openrouter, bai }

public struct ModelAvailability: Sendable, Equatable {
    public let modelV: ModelV
    public let displayName: String
    public let provider: ModelProvider
    public let deck: String
    public let reachable: Bool
    public let preferredRoute: ModelRoute?
}

public enum Availability {
    /// Reachability for a single model under the active carrier (nil = no key).
    /// Mirrors `availabilityFor`.
    public static func availability(_ meta: ModelMeta, active: LLMCarrier?) -> ModelAvailability {
        var reachable = false
        switch active {
        case .openrouter: reachable = true                       // every model carries an openrouterId
        case .bai:        reachable = meta.baiId != nil
        case .some(let p):                                        // single-model direct provider
            reachable = meta.provider.rawValue == p.rawValue && !meta.viaUniversalOnly
        case nil:         reachable = false
        }
        return ModelAvailability(
            modelV: meta.v, displayName: meta.displayName, provider: meta.provider,
            deck: meta.deck, reachable: reachable,
            preferredRoute: reachable ? active?.route : nil)
    }

    /// Availability for every registry model under the active carrier.
    public static func all(active: LLMCarrier?) -> [ModelAvailability] {
        Registry.all.map { availability($0, active: active) }
    }

    /// Just the reachable models.
    public static func reachable(active: LLMCarrier?) -> [ModelAvailability] {
        all(active: active).filter(\.reachable)
    }

    /// The wire id string to send for `meta` on `route` (the value that goes in
    /// the request's `model` field). `direct` → directApiId, `openrouter` →
    /// openrouterId, `bai` → baiId (nil when the model isn't on B.AI).
    public static func wireId(_ meta: ModelMeta, route: ModelRoute) -> String? {
        switch route {
        case .direct: return meta.directApiId
        case .openrouter: return meta.openrouterId
        case .bai: return meta.baiId
        }
    }

    // MARK: Default / fast / utility selection (ports of availability.ts)

    static let providerFlagship: [ModelProvider: ModelV] = [
        .anthropic: .opus_4_7, .openai: .gpt_5_5, .google: .gemini_3_5_flash,
        .deepseek: .deepseek_v4_pro, .zhipu: .glm_5_1, .moonshot: .kimi_k2_6,
    ]
    static let carrierFlagship: [LLMCarrier: ModelV] = [.openrouter: .opus_4_7, .bai: .opus_4_7]

    static let providerFast: [ModelProvider: ModelV] = [
        .anthropic: .haiku_4_5, .openai: .gpt_5_4_mini, .google: .gemini_3_1_flash,
        .deepseek: .deepseek_v4_flash, .zhipu: .glm_5_1, .moonshot: .kimi_k2_6,
    ]
    static let carrierFast: [LLMCarrier: ModelV] = [.openrouter: .opus_4_6_fast, .bai: .haiku_4_5]

    static let cheapByCarrier: [LLMCarrier: ModelV] = [
        .openrouter: .haiku_4_5, .bai: .haiku_4_5, .anthropic: .sonnet_4_6,
        .openai: .gpt_5_4_mini, .google: .gemini_3_1_flash,
    ]
    static let utilityPreference: [ModelV] = [.haiku_4_5, .gpt_5_4_mini, .gemini_3_1_flash, .gemini_3_5_flash]

    /// Genuinely-light models per AGGREGATOR carrier (OpenRouter / B.AI). On the
    /// FIRST carrier config the reconcile spreads every seat — directors AND the
    /// chair — RANDOMLY across this pool, so a fresh board isn't a wall of the
    /// flagship. Deliberately EXCLUDES the opus-tier "fast" variant
    /// (`opus_4_6_fast`): it's still heavyweight, and the product intent is
    /// flash / mini / haiku-class. Reachability is filtered at pick time, so an
    /// id the key can't reach (e.g. some are B.AI-absent) is simply skipped.
    static let fastPoolByCarrier: [LLMCarrier: [ModelV]] = [
        .openrouter: [.haiku_4_5, .gpt_5_4_mini, .gemini_3_5_flash, .gemini_3_1_flash, .deepseek_v4_flash],
        .bai:        [.haiku_4_5, .gpt_5_4_mini, .gemini_3_5_flash, .gemini_3_1_flash, .deepseek_v4_flash],
    ]

    /// One random reachable fast model from the carrier's pool, or nil when the
    /// carrier has no pool (direct providers → caller keeps `defaultModel`).
    /// Called once per seat on first config; the result is memorised in the
    /// per-carrier model bucket so later reconciles restore rather than reroll.
    public static func pickRandomFastModel(active: LLMCarrier?) -> ModelV? {
        guard let active, let pool = fastPoolByCarrier[active], !pool.isEmpty else { return nil }
        let reach = Set(reachable(active: active).map(\.modelV))
        let candidates = pool.filter { reach.contains($0) }
        return (candidates.isEmpty ? pool : candidates).randomElement()
    }

    /// Fast-default policy: a fresh user lands on the active carrier's cheap/fast
    /// model. Mirrors `defaultModelFor`.
    public static func defaultModel(active: LLMCarrier?) -> ModelV? {
        guard let active else { return nil }
        let reach = Set(reachable(active: active).map(\.modelV))
        if reach.isEmpty { return nil }
        if let fast = fast(active), reach.contains(fast) { return fast }
        if let flag = flagship(active), reach.contains(flag) { return flag }
        return reachable(active: active).first?.modelV
    }

    /// Cheap utility model for background tasks. Mirrors `utilityModelFor`:
    /// active-carrier cheap pick first, then the static preference list.
    public static func utilityModel(active: LLMCarrier?, fallback: ModelV? = nil) -> ModelV? {
        let reach = Set(reachable(active: active).map(\.modelV))
        if let active, let preferred = cheapByCarrier[active], reach.contains(preferred) { return preferred }
        for v in utilityPreference where reach.contains(v) { return v }
        if let fallback, reach.contains(fallback) { return fallback }
        return reach.first
    }

    private static func flagship(_ c: LLMCarrier) -> ModelV? {
        carrierFlagship[c] ?? ModelProvider(rawValue: c.rawValue).flatMap { providerFlagship[$0] }
    }
    private static func fast(_ c: LLMCarrier) -> ModelV? {
        carrierFast[c] ?? ModelProvider(rawValue: c.rawValue).flatMap { providerFast[$0] }
    }
}
