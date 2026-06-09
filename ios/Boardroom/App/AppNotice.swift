import Foundation

/// Debounced, decoupled poster for app-level error prompts (billing / auth /
/// network / reconnect). The engine-driven `RoomSession`, the foreground-resume
/// path, and the TTS adapter all funnel here; `RootView` observes `didPost` and
/// raises ONE modal alert. Per-kind 30s debounce so a round where every turn
/// hits the same failure pops one alert, not seven — mirrors the existing
/// `TTSEngineAdapter.VoiceBillingAlert` debounce.
@MainActor
enum AppNotice {
    static let didPost = Notification.Name("bb.app.notice")
    enum Kind: String { case billing, auth, network, reconnect }
    private static var lastPost: [String: Date] = [:]

    static func post(kind: Kind, provider: String? = nil, message: String, ctaURL: String? = nil) {
        let now = Date()
        if let last = lastPost[kind.rawValue], now.timeIntervalSince(last) < 30 { return }
        lastPost[kind.rawValue] = now
        var info: [String: Any] = ["kind": kind.rawValue, "message": message]
        if let provider { info["provider"] = provider }
        if let ctaURL { info["ctaURL"] = ctaURL }
        NotificationCenter.default.post(name: didPost, object: nil, userInfo: info)
    }

    /// Best-effort billing page per LLM carrier (the recharge CTA target). nil ⇒
    /// the alert falls back to the "open API keys" action.
    static func billingURL(forProvider provider: String?) -> String? {
        switch provider?.lowercased() {
        case "openrouter": return "https://openrouter.ai/credits"
        case "openai":     return "https://platform.openai.com/account/billing/overview"
        case "anthropic":  return "https://console.anthropic.com/settings/billing"
        case "google":     return "https://console.cloud.google.com/billing"
        case "xai":        return "https://console.x.ai"
        default:           return nil
        }
    }
}
