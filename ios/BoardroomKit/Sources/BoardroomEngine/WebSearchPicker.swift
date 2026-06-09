import Foundation
import BoardroomAI

/// Pre-turn web-search query router (#10) · the cheap LLM decision that gates
/// per-turn web search. Ports the `web_search` half of `pickSkills` (director) and
/// `pickChairWebSearch` (chair) from `skill-picker.ts`. The toolbox-skill half is
/// intentionally omitted — the native engine has no skill registry, so ACTIVE
/// SKILLS is moot. Temperature 0, ~240 tokens, utility/picker model; ANY failure
/// (no model / parse error / LLM throw) → nil, so a turn never blocks on routing.
enum WebSearchPicker {
    /// Director-side · "does THIS turn need fresh web info, and what query?"
    /// Returns the search query, or nil to skip search this turn.
    static func pickDirectorQuery(router: EngineRouter, speakerName: String,
                                  speakerModel: ModelV, history: [EngineMessage]) async -> String? {
        let prompt = PickerSupport.latestUserPrompt(history)
        guard !prompt.isEmpty else { return nil }
        let user = "Latest user message:\n\(prompt)\n\nDoes this turn need web search?"
        return await runPicker(router: router, fallback: speakerModel,
                               sys: directorSystem(speakerName: speakerName), user: user)
    }

    /// Chair-side · runs on clarify turns. Pulls the topic from the recent
    /// transcript so a meta-instruction ("search this" / "查一下") still yields a
    /// coherent query keyed off what the room is actually about.
    static func pickChairQuery(router: EngineRouter, history: [EngineMessage],
                               subject: String = "") async -> String? {
        // The OPENING question lives as `rooms.subject`, NOT as a user message, so
        // on the first clarify pass `history` holds only the chair's convening line.
        // Key off the real user message when present, else fall back to the subject —
        // otherwise the picker would decide on the chair's greeting and skip search.
        let userMsg = history.reversed().first {
            $0.authorKind == "user" && !$0.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }?.body.trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = userMsg ?? subject.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return nil }
        let transcript = history.suffix(8).compactMap { m -> String? in
            let b = m.body.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !b.isEmpty else { return nil }
            if m.authorKind == "user" { return "[USER] \(String(b.prefix(400)))" }
            if let k = m.kind, k == "tool-use" || k == "tool-preamble" { return nil }
            return "[CHAIR] \(String(b.prefix(400)))"
        }.joined(separator: "\n\n")
        let user = [
            "Recent transcript (most recent at the bottom):",
            transcript.isEmpty ? "(no transcript yet)" : transcript, "",
            "Latest user message (your decision keys off this, but use the transcript for query keywords when needed):",
            prompt, "",
            "Should the chair search the web before replying?",
        ].joined(separator: "\n")
        return await runPicker(router: router, fallback: nil, sys: chairSystem, user: user)
    }

    // MARK: shared

    private static func runPicker(router: EngineRouter, fallback: ModelV?,
                                  sys: String, user: String) async -> String? {
        // Cheap router model first (haiku tier), matching desktop's pickRouterModel
        // — a per-turn routing decision must not pay for the big default model.
        guard let model = router.utilityModelV() ?? router.defaultModelV() ?? fallback else { return nil }
        let msgs = [LLMMessage(role: .system, content: sys), LLMMessage(role: .user, content: user)]
        guard let raw = try? await router.call(msgs, modelV: model, temperature: 0, maxTokens: 240),
              !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let obj = PickerSupport.dict(PickerSupport.extractJson(raw)) else { return nil }
        // director schema · { "web_search": { "query": "..." } | null }
        if let ws = obj["web_search"] as? [String: Any], let q = ws["query"] as? String {
            return cleanQuery(q)
        }
        // chair schema · { "query": "..." | null }
        if let q = obj["query"] as? String { return cleanQuery(q) }
        return nil
    }

    private static func cleanQuery(_ q: String) -> String? {
        let t = q.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        return String(t.prefix(200))
    }

    // MARK: prompts (verbatim from skill-picker.ts, web-search half only)

    private static func directorSystem(speakerName: String) -> String {
        [
            "You are \(speakerName)'s pre-turn search router. You decide ONE thing before \(speakerName) answers: should \(speakerName) issue ONE live web search query for this turn, and if so what query.",
            "",
            "STRONG-SEARCH signals (pick one → ALWAYS issue a query):",
            "- Time markers: today / this week / recent / latest / just / now / 今天 / 最近 / 本周 / 刚刚 / 现在 / 目前.",
            "- Verbs of recent action: released / launched / announced / shipped / reported / filed / 发布 / 推出 / 宣布 / 上线.",
            "- Named recent events / products / numbers / prices the model can't reliably know from training.",
            "- A specific person's public statements asked about by name.",
            "- Explicit search verbs: search / look up / 查一下 / 搜索.",
            "",
            "DON'T search on philosophical / first-principles / pure-reasoning questions with no time anchor — search adds noise. But when ANY of the STRONG-SEARCH signals above are present, ALWAYS issue a query — skipping a time-sensitive question is worse than the API cost.",
            "",
            "Reply with STRICT JSON ONLY — no prose, no code fences:",
            "{ \"web_search\": { \"query\": \"...\" } }   // or null if no fresh info needed",
            "",
            "Rules:",
            "- For `web_search.query`: 3-8 keywords, no full sentences. Plain ASCII works best.",
            "- Match the question's language for the query (English keywords for global topics; CJK if China-specific).",
            "- For time-sensitive questions, INCLUDE the time marker in the query when it sharpens results (e.g. '2025', 'this week', '最近').",
            "- DEFAULT WHEN UNCERTAIN: if any STRONG-SEARCH signal is present, ALWAYS issue a query — never null. Skipping a clearly time-sensitive question is worse than one search call.",
        ].joined(separator: "\n")
    }

    private static let chairSystem = [
        "You are the boardroom chair's pre-turn search router. You decide ONE thing:",
        "should the chair run a web search before its next reply, and if so what query.",
        "",
        "STRONG-SEARCH signals (pick one of these → ALWAYS issue a query):",
        "- Time markers: 'today' / 'this week' / 'this month' / 'recent' / 'recently' /",
        "  'latest' / 'just' / 'now' / '今天' / '最近' / '本周' / '本月' / '刚刚' /",
        "  '现在' / '目前'.",
        "- Verbs of recent action: 'released' / 'launched' / 'announced' / 'shipped' /",
        "  'reported' / 'filed' / '发布' / '推出' / '宣布' / '上线' / '披露'.",
        "- Specific named events / products / numbers / prices that the model can't",
        "  reliably know from training (CES 2025, model launches, IPO numbers, ARR figures,",
        "  raise sizes, market caps).",
        "- A specific person's PUBLIC statements / posts (X/Twitter, blog, interviews)",
        "  asked about by name.",
        "- Explicit search verbs: 'search', 'look up', '查一下', '搜索', '搜一下'.",
        "- The user META-INSTRUCTS the chair to search ('go search this' / '你去搜一下' /",
        "  '用 web search 看看' / '涉及实事，搜索一下') — even when no time marker is",
        "  in the literal sentence. Pull the topic from the recent transcript: chair's",
        "  prior question, the room subject, or the original user message. If you can't",
        "  pull a coherent topic, return the room subject's keywords as the fallback.",
        "- A source URL is shared alongside the question (search complements fetch-url).",
        "",
        "WEAK-SEARCH signals (search is OPTIONAL, lean toward yes if the question",
        "claims a fact you'd want to verify):",
        "- Statistics / market sizing / industry numbers stated as fact.",
        "- 'Will X happen?' style forecasts that hinge on current trajectory.",
        "",
        "DON'T search WHEN:",
        "- The question is philosophical, first-principles, or about stable general",
        "  knowledge that doesn't change.",
        "- It's a pure reasoning / brainstorm / planning task with no time anchor.",
        "",
        "Reply with STRICT JSON ONLY (no prose, no fences):",
        "{ \"query\": \"3-8 keywords\" }   // when search is warranted",
        "{ \"query\": null }              // otherwise",
        "",
        "Query rules:",
        "- 3-8 keywords, no full sentences. Plain ASCII works best for most providers.",
        "- Match the language of the question when possible (English keywords for",
        "  global topics; CJK keywords if the question is China-specific).",
        "- For time-sensitive questions, INCLUDE the time marker in the query when",
        "  it sharpens results (e.g. '2025', 'this week', '最近').",
        "- When the user is META-instructing search, BUILD the query from the actual",
        "  TOPIC in the transcript, NOT from the user's directive verbs.",
        "- DEFAULT WHEN UNCERTAIN: if any STRONG-SEARCH signal is present, ALWAYS",
        "  return a query — never null.",
    ].joined(separator: "\n")
}
