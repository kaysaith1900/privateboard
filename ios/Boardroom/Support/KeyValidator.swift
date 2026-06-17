import Foundation

/// Static API-key validators · the Swift 1:1 port of `public/key-validators.js`.
/// Sanity-checks pasted keys at the input layer BEFORE they round-trip to storage
/// — catches the obvious bad pastes ("123", a Brave key dropped in the OpenAI slot,
/// a stray space) that would otherwise sit in the DB until the first SSE turn fails.
/// The upstream provider stays the real authority (every key is exercised on first
/// call); these rules only block the obviously-wrong.
enum KeyValidator {
    struct Rule { let label: String; let prefixes: [String]; let minLen: Int }

    /// Per-provider rules — `prefixes` empty = no prefix check (keys too varied);
    /// `minLen` is a conservative floor (real keys run well above it, so it only
    /// catches "123" / "test" / a single word). Mirrors RULES in key-validators.js.
    private static let rules: [String: Rule] = [
        "openrouter": .init(label: "OpenRouter",     prefixes: ["sk-or-"],  minLen: 24),
        "bai":        .init(label: "B.AI",           prefixes: [],          minLen: 16),
        "anthropic":  .init(label: "Claude",         prefixes: ["sk-ant-"], minLen: 40),
        "openai":     .init(label: "ChatGPT",        prefixes: ["sk-"],     minLen: 20),
        "google":     .init(label: "Gemini",         prefixes: ["AIza"],    minLen: 30),
        "xai":        .init(label: "Grok",           prefixes: ["xai-"],    minLen: 32),
        // Moonshot uses the OpenAI `sk-` convention — only enforce prefix + floor.
        "moonshot":   .init(label: "Kimi",           prefixes: ["sk-"],     minLen: 40),
        // Zhipu keys are `<32-hex>.<16-alnum>` — floor catches the obvious bad paste.
        "zhipu":      .init(label: "GLM",            prefixes: [],          minLen: 30),
        "minimax":    .init(label: "MiniMax",        prefixes: [],          minLen: 24),
        "elevenlabs": .init(label: "ElevenLabs",     prefixes: [],          minLen: 24),
        "brave":      .init(label: "Brave Search",   prefixes: ["BSA"],     minLen: 24),
        "tavily":     .init(label: "Tavily Search",  prefixes: ["tvly-"],   minLen: 16),
    ]

    enum Code { case empty, whitespace, prefix, length }
    struct Failure { let code: Code; let rule: Rule }

    /// Validate a key for a provider. Returns nil when it passes (or the provider is
    /// unknown → server is the authority); else the failure code + rule.
    static func validate(provider: String, key raw: String) -> Failure? {
        guard let rule = rules[provider] else { return nil }   // unknown → let it through
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return Failure(code: .empty, rule: rule) }
        if trimmed.rangeOfCharacter(from: .whitespacesAndNewlines) != nil {
            return Failure(code: .whitespace, rule: rule)
        }
        if !rule.prefixes.isEmpty {
            // Defer the prefix verdict until the value is long enough to definitively
            // fail it — otherwise a user mid-type sees "must start with sk-ant-" after
            // one keystroke. Falls through to the length check, the honest answer then.
            let maxPrefix = rule.prefixes.map(\.count).max() ?? 0
            if trimmed.count >= maxPrefix, !rule.prefixes.contains(where: { trimmed.hasPrefix($0) }) {
                return Failure(code: .prefix, rule: rule)
            }
        }
        if trimmed.count < rule.minLen { return Failure(code: .length, rule: rule) }
        return nil
    }

    /// True when the key is acceptable to SAVE (non-empty + passes format checks).
    static func isAcceptable(provider: String, key: String) -> Bool {
        validate(provider: provider, key: key) == nil
    }

    /// Localised one-line message for a failed validate() result ("" when it passes).
    static func describe(provider: String, key raw: String) -> String {
        guard let f = validate(provider: provider, key: raw) else { return "" }
        let prefix = f.rule.prefixes.count == 1 ? f.rule.prefixes[0] : f.rule.prefixes.joined(separator: " / ")
        let params = ["label": f.rule.label, "prefix": prefix, "minLen": String(f.rule.minLen)]
        switch f.code {
        case .empty:      return Loc.t("key_validate_empty", params)
        case .whitespace: return Loc.t("key_validate_whitespace", params)
        case .prefix:     return Loc.t("key_validate_prefix", params)
        case .length:     return Loc.t("key_validate_length", params)
        }
    }
}
