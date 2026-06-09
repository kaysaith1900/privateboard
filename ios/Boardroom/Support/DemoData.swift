import Foundation

/// Sample rooms + directors for the "Explore a demo" path — lets the app be
/// driven (and screenshotted) without a live backend. Decoded through the real
/// Codable models so it exercises the same shapes the server returns.
enum DemoData {
    static let rooms: [Room] = decode("""
    [
      {"id":"d1","name":"Q3 redesign ship call","subject":"Should we ship the redesign in Q3, or hold it until the new onboarding flow is ready and the perf regressions on Android are sorted out?","mode":"debate","intensity":"sharp","status":"live","deliveryMode":"voice","directorIds":["a1","a2","a4","a3"]},
      {"id":"d2","name":"Enterprise pricing","subject":"How should we price the enterprise tier given that our top three accounts already pay for seats they don't use?","mode":"research","intensity":"calm","status":"live","deliveryMode":"voice","directorIds":["a5","a2","a1"]},
      {"id":"d3","name":"Platform hiring plan","subject":"What should the hiring plan for the platform team look like over the next two quarters?","mode":"constructive","intensity":"sharp","status":"paused","deliveryMode":"text","directorIds":["a2","a3","a6","a1","a4"]},
      {"id":"d4","name":"April outage post-mortem","subject":"Post-mortem on the April outage: what actually failed, and what do we change so it can't happen the same way again?","mode":"critique","intensity":"terse","status":"adjourned","deliveryMode":"voice","directorIds":["a1","a2","a4"]},
      {"id":"d5","name":"Brand refresh","subject":"Which direction should the brand refresh take, and how far can we push it without losing the people who already know us?","mode":"brainstorm","intensity":"calm","status":"adjourned","deliveryMode":"voice","directorIds":["a6","a3","a1"]}
    ]
    """)

    static let agents: [Agent] = decode("""
    [
      {"id":"a1","name":"Socrates","roleTag":"The questioner","roleKind":"director","bio":"Refuses to accept a premise until it has survived three rounds of why. Surfaces the assumption everyone is leaning on.","coverQuote":"The unexamined plan is not worth shipping."},
      {"id":"a2","name":"Ada","roleTag":"Systems engineer","roleKind":"director","bio":"Reasons from first principles and unit economics. Wants the one number that decides it.","coverQuote":"Show me where the load actually lands."},
      {"id":"a3","name":"Maya","roleTag":"User advocate","roleKind":"director","bio":"Holds the room to the person on the other end of the decision."},
      {"id":"a4","name":"Rex","roleTag":"Devil's advocate","roleKind":"director","bio":"Argues the opposite of whatever the room is converging on — hard."},
      {"id":"a5","name":"Lin","roleTag":"Pricing strategist","roleKind":"director","bio":"Distrusts vanity metrics; reasons from willingness-to-pay."},
      {"id":"a6","name":"Iris","roleTag":"Narrative lead","roleKind":"director","bio":"Turns the decision into a story the company can repeat."}
    ]
    """)

    private static func decode<T: Decodable>(_ json: String) -> T {
        // Static, controlled JSON — a decode failure is a programmer error.
        try! JSONDecoder().decode(T.self, from: Data(json.utf8))
    }
}
