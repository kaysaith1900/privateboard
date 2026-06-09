import Foundation

/// Transient-failure classification + backoff — ported from `adapter.ts`'s
/// `isTransientStreamError` / `backoffDelay`. Retry only fires BEFORE the first
/// text-delta (mid-stream errors surface as-is). Permanent errors (4xx auth,
/// model-not-found, quota) are NOT transient — the regexes stay tight so we
/// don't burn budget retrying unrecoverable failures.
public enum Retry {
    public static let maxAttempts = 3

    public static func isTransient(_ message: String) -> Bool {
        if message.isEmpty { return false }
        let m = message.lowercased()
        func rx(_ pattern: String) -> Bool { m.range(of: pattern, options: .regularExpression) != nil }

        // 5xx HTTP families · upstream unhealthy / capacity-blocking.
        if rx(#"\bhttp\s*5\d\d\b"#) { return true }
        if rx(#"\b5\d\d\s+(internal|service|bad\s+gateway|gateway\s+timeout)"#) { return true }
        // OpenRouter capacity / routing (allow_fallbacks=false surfaces these).
        if rx(#"no\s+instances?\s+available"#) { return true }
        if rx(#"all\s+providers?\s+(returned\s+errors|are\s+down|busy)"#) { return true }
        if rx(#"provider\s+returned\s+error"#) { return true }
        // Generic capacity / overload.
        if rx(#"overloaded|capacity|temporarily\s+unavailable|service\s+unavailable"#) { return true }
        // Rate limits.
        if rx(#"rate[\s-]?limit|too\s+many\s+requests|\b429\b"#) { return true }
        // Network-layer (dropped sockets, DNS).
        if rx(#"\becon(n|nreset|nrefused)\b|\betimedout\b|\benotfound\b|\beai_"#) { return true }
        if rx(#"socket\s+hang\s+up|fetch\s+failed|network\s+error|aborted\s+by\s+upstream"#) { return true }
        if rx(#"upstream\s+(timeout|reset|connect|disconnect)"#) { return true }
        return false
    }

    /// Deterministic backoff base · retry 1 → 800ms, retry 2+ → 2400ms.
    public static func baseDelayMs(retryNumber: Int) -> Int { retryNumber == 1 ? 800 : 2400 }

    /// Backoff with ±20% jitter so concurrent retries don't synchronise.
    public static func jitteredDelayMs(retryNumber: Int) -> Int {
        let base = Double(baseDelayMs(retryNumber: retryNumber))
        let jitter = base * 0.2 * (Double.random(in: 0...1) - 0.5)
        return Int((base + jitter).rounded())
    }
}
