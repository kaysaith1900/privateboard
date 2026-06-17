import Foundation

/// A starter "play" shown in the empty-rooms placeholder · the native port of the
/// desktop SCENARIO_CARDS. Each scenario pre-fills the New Room composer with a
/// starter subject, tone + intensity, and a suggested director cast (matched by
/// seed handle), so a first-time user lands one tap from a real boardroom instead
/// of a blank form. Text is resolved through `Loc` at access time so it follows
/// the active locale; the cast is matched against the live roster (gracefully
/// falls back to auto-pick when a referenced seed director is absent).
struct RoomScenario: Identifiable, Hashable {
    let id: String
    let tag: String                 // mono kicker · "Investor · Pitch"
    let headline: String
    let body: String
    let tone: String                // brainstorm | constructive | research | debate | critique
    let intensity: String           // sharp | calm
    let directorHandles: [String]   // e.g. ["@socrates", "@value_inv", "@first_p"]
    let subject: String             // starter subject pre-filled into the composer

    /// Static cast/tone definitions · the localized strings hang off `scn_<id>_*`
    /// keys. A curated 4-card subset of the desktop's 12 covering ideation,
    /// pitching, auditing, and deciding.
    private static let defs: [(id: String, tone: String, intensity: String, handles: [String])] = [
        ("brainstorm", "brainstorm", "calm",  ["@first_p", "@user_e", "@long_h"]),
        ("pitch",      "debate",     "sharp", ["@socrates", "@value_inv", "@first_p"]),
        ("audit",      "critique",   "sharp", ["@socrates", "@first_p", "@long_h"]),
        ("fork",       "debate",     "calm",  ["@long_h", "@first_p", "@value_inv"]),
    ]

    /// The localized scenario set for the current locale.
    static var all: [RoomScenario] {
        defs.map { d in
            RoomScenario(
                id: d.id,
                tag: Loc.t("scn_\(d.id)_tag"),
                headline: Loc.t("scn_\(d.id)_head"),
                body: Loc.t("scn_\(d.id)_body"),
                tone: d.tone, intensity: d.intensity,
                directorHandles: d.handles,
                subject: Loc.t("scn_\(d.id)_subj"))
        }
    }

    /// Directors from `roster` whose handle matches this scenario's cast, in cast
    /// order. Handles are compared case-insensitively and `@`-prefix-agnostic so a
    /// stored `@socrates` matches a referenced `socrates`.
    func matchedDirectors(in roster: [Agent]) -> [Agent] {
        let norm: (String) -> String = { $0.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "@")) }
        let wanted = directorHandles.map(norm)
        return wanted.compactMap { h in roster.first { norm($0.handle ?? "") == h } }
    }
}
