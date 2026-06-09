import Foundation

/// Model registry — the Swift port of `src/ai/registry.ts`. Single source of
/// truth for model ids, per-carrier routing strings, and routing flags. Kept as
/// a hand-maintained static table (it changes rarely); re-sync by hand when
/// `registry.ts` changes.

/// Direct-API provider that "owns" a model.
public enum ModelProvider: String, Sendable, CaseIterable {
    case anthropic, openai, google, xai, deepseek, zhipu, moonshot, minimax
}

/// Our internal stable model id (`modelV`).
public enum ModelV: String, Sendable, CaseIterable {
    case sonnet_4_6 = "sonnet-4-6"
    case opus_4_8 = "opus-4-8"
    case opus_4_7 = "opus-4-7"
    case opus_4_6_fast = "opus-4-6-fast"
    case haiku_4_5 = "haiku-4-5"
    case gpt_5_4 = "gpt-5-4"
    case gpt_5_4_mini = "gpt-5-4-mini"
    case gpt_5_5 = "gpt-5-5"
    case codex_5_4 = "codex-5-4"
    case gemini_3_1 = "gemini-3-1"
    case gemini_3_5_flash = "gemini-3-5-flash"
    case gemini_3_1_flash = "gemini-3-1-flash"
    case deepseek_v4_pro = "deepseek-v4-pro"
    case deepseek_v4_flash = "deepseek-v4-flash"
    case glm_5_1 = "glm-5-1"
    case kimi_k2_6 = "kimi-k2-6"
    case minimax_m2_5 = "minimax-m2-5"
    case minimax_m2_7 = "minimax-m2-7"
}

public struct ModelMeta: Sendable, Equatable {
    public let v: ModelV
    public let provider: ModelProvider
    public let directApiId: String
    public let openrouterId: String
    public let baiId: String?
    public let displayName: String
    public let contextBudget: Int
    public let deck: String
    public let viaUniversalOnly: Bool
    public let noTemperature: Bool
}

public enum Registry {
    /// Every model, in registry.ts declaration order.
    public static let all: [ModelMeta] = [
        m(.sonnet_4_6, .anthropic, "claude-sonnet-4-6", "anthropic/claude-sonnet-4.6", "claude-sonnet-4.6", "Sonnet 4.6", 200_000, "balanced · default"),
        m(.opus_4_8, .anthropic, "claude-opus-4-8", "anthropic/claude-opus-4.8", "claude-opus-4.8", "Opus 4.8", 200_000, "deepest reasoning · latest", noTemperature: true),
        m(.opus_4_7, .anthropic, "claude-opus-4-7", "anthropic/claude-opus-4.7", "claude-opus-4.7", "Opus 4.7", 200_000, "deep reasoning", noTemperature: true),
        m(.opus_4_6_fast, .anthropic, "claude-opus-4-6-fast", "anthropic/claude-opus-4.6-fast", nil, "Opus 4.6 Fast", 200_000, "faster 4.6 · same intelligence"),
        m(.haiku_4_5, .anthropic, "claude-haiku-4-5-20251001", "anthropic/claude-haiku-4.5", "claude-haiku-4.5", "Haiku 4.5", 200_000, "fast · low-cost"),
        m(.gpt_5_5, .openai, "gpt-5.5", "openai/gpt-5.5", "gpt-5.5", "GPT-5.5", 1_000_000, "flagship · 1M ctx"),
        m(.gpt_5_4, .openai, "gpt-5.4", "openai/gpt-5.4", "gpt-5.4", "GPT-5.4", 1_000_000, "general · 1M ctx"),
        m(.gpt_5_4_mini, .openai, "gpt-5.4-mini", "openai/gpt-5.4-mini", "gpt-5.4-mini", "GPT-5.4 Mini", 400_000, "fast · 400k ctx"),
        m(.codex_5_4, .openai, "gpt-5.3-codex", "openai/gpt-5.3-codex", nil, "ChatGPT Codex 5.4", 400_000, "code · agents", viaUniversalOnly: true),
        m(.gemini_3_1, .google, "gemini-3.1-pro-preview", "google/gemini-3.1-pro-preview", "gemini-3.1-pro", "Gemini 3.1 Pro", 1_000_000, "flagship · 1M ctx"),
        m(.gemini_3_5_flash, .google, "gemini-3.5-flash-preview", "google/gemini-3.5-flash-preview", "gemini-3.5-flash", "Gemini 3.5 Flash", 1_000_000, "frontier flash · 1M ctx"),
        m(.gemini_3_1_flash, .google, "gemini-3.1-flash-lite-preview", "google/gemini-3.1-flash-lite-preview", nil, "Gemini 3.1 Flash Lite", 1_000_000, "fast · 1M ctx"),
        m(.deepseek_v4_pro, .deepseek, "deepseek-v4-pro", "deepseek/deepseek-v4-pro", "deepseek-v4-pro", "DeepSeek V4 Pro", 128_000, "reasoning · open weights", viaUniversalOnly: true),
        m(.deepseek_v4_flash, .deepseek, "deepseek-v4-flash", "deepseek/deepseek-v4-flash", "deepseek-v4-flash", "DeepSeek Lite", 1_000_000, "V4 Flash · fast · 1M ctx", viaUniversalOnly: true),
        m(.glm_5_1, .zhipu, "glm-5.1", "z-ai/glm-5.1", "glm-5.1", "GLM 5.1", 200_000, "Zhipu flagship · 200k ctx"),
        m(.kimi_k2_6, .moonshot, "kimi-k2.6", "moonshotai/kimi-k2.6", "kimi-k2.5", "Kimi K2.6", 256_000, "Moonshot · long-context"),
        m(.minimax_m2_7, .minimax, "minimax-m2.7", "minimax/minimax-m2.7", "minimax-m2.7", "MiniMax M2.7", 245_000, "MiniMax flagship · long-context", viaUniversalOnly: true),
        m(.minimax_m2_5, .minimax, "minimax-m2.5", "minimax/minimax-m2.5", "minimax-m2.5", "MiniMax M2.5", 245_000, "MiniMax prior · long-context", viaUniversalOnly: true),
    ]

    private static let byV: [ModelV: ModelMeta] = Dictionary(uniqueKeysWithValues: all.map { ($0.v, $0) })

    public static func meta(_ v: ModelV) -> ModelMeta? { byV[v] }
    public static func meta(id: String) -> ModelMeta? { ModelV(rawValue: id).flatMap { byV[$0] } }
    public static func isModelV(_ id: String) -> Bool { ModelV(rawValue: id) != nil }

    /// All carrier-level id strings belonging to a `noTemperature` model — the
    /// adapter strips `temperature` from outbound bodies for these (Claude 4.7
    /// rejects it across every carrier). Mirrors `noTemperatureModelIds()`.
    public static let noTemperatureIds: Set<String> = {
        var ids = Set<String>()
        for m in all where m.noTemperature {
            ids.insert(m.directApiId)
            ids.insert(m.openrouterId)
            if let bai = m.baiId { ids.insert(bai) }
        }
        return ids
    }()

    private static func m(_ v: ModelV, _ p: ModelProvider, _ direct: String,
                          _ or: String, _ bai: String?, _ name: String,
                          _ ctx: Int, _ deck: String,
                          viaUniversalOnly: Bool = false, noTemperature: Bool = false) -> ModelMeta {
        ModelMeta(v: v, provider: p, directApiId: direct, openrouterId: or, baiId: bai,
                  displayName: name, contextBudget: ctx, deck: deck,
                  viaUniversalOnly: viaUniversalOnly, noTemperature: noTemperature)
    }
}
