import Foundation

/// Classify an LLM failure into a user-actionable bucket so the app can show a
/// targeted prompt (top up / fix the key / network), not just bury a raw string
/// in a chat bubble.
///
/// Port of the desktop `isBillingError` + `extractProviderHint`
/// (`src/ai/billing-error.ts`), plus an auth (401) check and a network bucket
/// that reuses `Retry.isTransient`. `.upstream` is the "no targeted prompt"
/// fallback — the in-bubble ⚠️ hint already covers it.
public enum LLMErrorClass: Equatable {
    case billing(provider: String?)   // quota / credit exhaustion · name the carrier when we can
    case auth                         // 401 / invalid-or-missing key
    case network                      // transient: timeout / 5xx / rate-limit / dropped socket
    case upstream                     // anything else · in-bubble hint only

    /// The `RoomEvent.messageError(kind:)` tag the app reacts to. nil ⇒ no prompt.
    public var eventKind: String? {
        switch self {
        case .billing: return "billing"
        case .auth:    return "auth"
        case .network: return "network"
        case .upstream: return nil
        }
    }

    public var provider: String? {
        if case .billing(let p) = self { return p }
        return nil
    }

    public static func classify(_ error: Error) -> LLMErrorClass {
        guard let e = error as? LLMError else { return classify(message: "\(error)") }
        switch e {
        case .noKey: return .auth
        case .modelNotReachable: return .upstream
        case .upstream(let m), .exhausted(let m): return classify(message: m)
        }
    }

    public static func classify(message: String) -> LLMErrorClass {
        // Billing is checked FIRST — its messages often also mention "api key" /
        // status codes that the auth/network checks would otherwise claim.
        if isBilling(message) { return .billing(provider: providerHint(message)) }
        if isAuth(message)    { return .auth }
        if Retry.isTransient(message) { return .network }
        return .upstream
    }

    // ── Billing (ported verbatim from src/ai/billing-error.ts) ───────────────
    private static let billingNeedles = [
        "insufficient_quota", "insufficient quota", "exceeded your current quota",
        "exceeded your quota", "credit balance is too low", "credit balance",
        "insufficient credits", "insufficient credit", "quota exceeded", "billing",
        "payment required", "402", "any credits", "any credit", "no credits",
        "no credit ", "out of credit", "credits or licenses", "no licenses",
        "any licenses", "余额不足",
    ]
    public static func isBilling(_ message: String) -> Bool {
        let m = message.lowercased()
        return billingNeedles.contains { m.contains($0) }
    }

    public static func providerHint(_ message: String) -> String? {
        let m = message.lowercased()
        if m.contains("openrouter") { return "OpenRouter" }
        if m.contains("openai") || m.contains("gpt-") || m.contains("insufficient_quota") { return "OpenAI" }
        if m.contains("anthropic") || m.contains("claude") { return "Anthropic" }
        if m.contains("google") || m.contains("gemini") { return "Google" }
        if m.contains("xai") || m.contains("grok") { return "xAI" }
        return nil
    }

    // ── Auth · 401 / invalid key (tight, so billing/network aren't misclaimed) ─
    private static let authNeedles = [
        "401", "unauthorized", "invalid api key", "invalid_api_key", "incorrect api key",
        "invalid x-api-key", "authentication_error", "no auth credentials", "missing api key",
        "api key is invalid", "permission denied",
    ]
    public static func isAuth(_ message: String) -> Bool {
        let m = message.lowercased()
        return authNeedles.contains { m.contains($0) }
    }
}
