import Foundation

/// Director prompt guidance — the verbatim SHARED_ROOM_PROTOCOL + per-tone +
/// per-intensity blocks from `src/orchestrator/prompt.ts`, codegen'd into the
/// bundled `director-prompts.json` (see `scripts/gen-ios-prompts.mjs`) so the
/// on-device director system prompt matches desktop. These are the blocks that
/// give directors their adversarial/collaborative register + cadence — the
/// "soul" of a director turn. The full `buildDirectorMessages` (L0/L1/L2
/// context, memory, skills, chair brief) is still a partial port; this lands the
/// load-bearing guidance.
public enum DirectorPrompts {
    struct Catalog: Decodable { let sharedRoomProtocol: String; let tone: [String: String]; let intensity: [String: String] }

    static let catalog: Catalog? = {
        guard let url = Bundle.module.url(forResource: "director-prompts", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Catalog.self, from: data)
    }()

    /// Tone aliases (mirrors `normalizeTone`): no-mercy → debate.
    public static func normalizeTone(_ raw: String) -> String { raw == "no-mercy" ? "debate" : raw }
    /// Intensity aliases (mirrors `normalizeIntensity`): brutal → terse.
    public static func normalizeIntensity(_ raw: String) -> String { raw == "brutal" ? "terse" : raw }

    public static var sharedRoomProtocol: String { catalog?.sharedRoomProtocol ?? "" }
    public static func toneGuidance(_ mode: String) -> String {
        let t = normalizeTone(mode.lowercased())
        return catalog?.tone[t] ?? catalog?.tone["constructive"] ?? ""
    }
    public static func intensityGuidance(_ intensity: String) -> String {
        let i = normalizeIntensity(intensity.lowercased())
        return catalog?.intensity[i] ?? catalog?.intensity["sharp"] ?? ""
    }
}
