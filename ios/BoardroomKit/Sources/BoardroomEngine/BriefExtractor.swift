import Foundation
import BoardroomCore
import BoardroomAI

/// Brief Stage 1 runner · per-director asset extraction via a cheap model.
/// EXTRACT_SYSTEM is verbatim from `brief-stages.ts`; each director re-reads only
/// its own (indexed) messages and emits the 9-field bundle. Best-effort — a
/// failed/empty director contributes an empty bundle, never blocks the brief.
public enum BriefExtractor {

    /// Run Stage 1 for every director → raw per-director assets (drives the
    /// composer's coverage + asset-budget block). Directors with no own turns are
    /// skipped. ONE LLM call per director — derive signals from this, don't
    /// re-extract.
    public static func runStage1Assets(router: EngineRouter, store: RoomStore, roomId: String) async -> [BriefAssets.DirectorAssets] {
        let directors = await store.directors(roomId)
        guard !directors.isEmpty else { return [] }
        let history = await store.recentMessages(roomId, limit: 200)
        let subject = (await store.roomMeta(roomId))?.subject ?? ""
        var out: [BriefAssets.DirectorAssets] = []
        for d in directors {
            let own = history.filter { $0.authorKind == "agent" && $0.authorId == d.id && !$0.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            guard !own.isEmpty else { continue }
            out.append(await extractDirector(router: router, director: d, ownMessages: own, subject: subject))
        }
        return out
    }

    /// Flatten extracted assets → writer-consumable signals (drops empties).
    public static func signalsFrom(_ assets: [BriefAssets.DirectorAssets]) -> [BriefAssets.DirectorSignals] {
        assets.map(BriefAssets.assetsToSignals).filter { !$0.signals.isEmpty }
    }

    /// Run Stage 1 for every director → flattened signals (writer-consumable).
    public static func runStage1(router: EngineRouter, store: RoomStore, roomId: String) async -> [BriefAssets.DirectorSignals] {
        signalsFrom(await runStage1Assets(router: router, store: store, roomId: roomId))
    }

    static func extractDirector(router: EngineRouter, director: DirectorRef,
                                ownMessages: [EngineMessage], subject: String) async -> BriefAssets.DirectorAssets {
        let empty = BriefAssets.parse("", directorId: director.id, directorName: director.name)
        guard let model = router.utilityModelV() ?? router.defaultModelV() else { return empty }
        let indexed = ownMessages.enumerated()
            .map { "[\($0.offset)] \($0.element.body.trimmingCharacters(in: .whitespacesAndNewlines))" }
            .joined(separator: "\n\n")
        let lang = PickerSupport.languageLockBlock(PickerSupport.detectRoomLang(subject))
        let system = extractSystem(director) + "\n\n" + lang
        let user = [
            "ROOM SUBJECT: \(subject)",
            "",
            "Your messages in this room (indexed · cite by these indices in every `sources` array):",
            "",
            indexed.isEmpty ? "(you said nothing)" : indexed,
            "",
            "Walk every asset field. If any indexed message has substantive material, preserve it in the matching fields. JSON only.",
        ].joined(separator: "\n")
        guard let raw = try? await router.call(
            [LLMMessage(role: .system, content: system), LLMMessage(role: .user, content: user)],
            modelV: model, temperature: 0.2, maxTokens: 4400) else { return empty }
        return BriefAssets.parse(raw, directorId: director.id, directorName: director.name)
    }

    /// Render the flattened per-director signals as the writer's input block.
    public static func signalsBlock(_ all: [BriefAssets.DirectorSignals]) -> String {
        guard !all.isEmpty else { return "" }
        var lines = ["─── DIRECTOR SIGNALS (extracted per-director · lens-tagged) ───"]
        for d in all {
            lines.append("\n\(d.directorName):")
            for s in d.signals { lines.append("  · [\(s.lens)] \(s.text)") }
        }
        return lines.joined(separator: "\n")
    }

    static func extractSystem(_ director: DirectorRef) -> String {
        """
You are \(director.name) (\(director.handle)), \(director.roleTag).
Your job: re-read your own contributions to a boardroom session and surface a structured asset bundle for the report — every kind of material worth preserving, by category. Do NOT collapse to a flat 2–4 signal list anymore; the report writer needs to see what KIND of material you brought (claim vs evidence vs risk vs question) so it can place each one in the right section.

## Walk every asset field once. Use empty arrays only for fields with no substantive material

Walking through your messages, capture every relevant entry per field. If you raised no risks, return `"risks": []`. If you didn't propose actions, return `"actions": []`. Do not fabricate to fill a field, but do not return an all-empty bundle when the indexed messages contain substantive claims, risks, questions, disagreements, recommendations, or evidence.

## Asset fields

· **claims** — load-bearing claims you made (the takeaways you stand behind). Each: `{ "text": "...", "lens": "data|dissent|narrative|structural|first-principle", "sources": [...], "confidence": "high|medium|low" (optional) }`. Up to 6.

· **evidence** — concrete material you brought IN to the room: data points, named cases, verbatim quotes from outside. Distinct from claims (which interpret evidence). Each: `{ "text": "...", "kind": "data|case|quote", "sources": [...] }`. Up to 6.

· **tensions** — places you pushed back on or differed from another director. Each: `{ "text": "...", "with": [directorId, ...], "sources": [...] }`. Use `"with": []` when the tension is with the framing / user rather than a director. Up to 4.

· **assumptions** — foundational beliefs your reasoning rests on (often unstated). Each: `{ "text": "...", "falsifier": "what would prove this wrong" (optional), "sources": [...] }`. Up to 4.

· **risks** — failure modes / downsides you raised. Each: `{ "text": "...", "severity": "high|medium|low" (optional), "sources": [...] }`. Up to 4.

· **opportunities** — upside / openings you named that the room should chase. Each: `{ "text": "...", "sources": [...] }`. Up to 3.

· **actions** — concrete moves you proposed. Each: `{ "text": "...", "owner": "..." (optional), "horizon": "..." (optional · e.g. "30 days"), "sources": [...] }`. Up to 4.

· **quotes** — your own memorable lines worth pull-quoting in the report. Verbatim, not paraphrase. Each: `{ "text": "...", "sources": [...] }`. Up to 3.

· **openQuestions** — questions you surfaced or pushed on, tagged with priority. Each: `{ "text": "...", "priority": "P0|P1|P2", "sources": [...] }`. Up to 4.

## Lens tags (used in claims field)

· `data`           — empirical data point, number, or named precedent
· `dissent`        — a counterexample or pushback against a default view
· `narrative`      — a story or analogy that makes the point land
· `structural`     — a system / mechanism / second-order argument
· `first-principle` — a derivation from foundational truths

## Output format

Strict JSON inside a fenced ```json code block. No prose outside the block. All 9 fields MUST be present (use `[]` for fields with no material).

```json
{
  "claims": [
    { "text": "Short 1–2 sentence claim in your voice.", "lens": "dissent", "sources": [0, 2], "confidence": "medium" }
  ],
  "evidence": [
    { "text": "GMV declined 23% Q3 against a 7% category baseline.", "kind": "data", "sources": [3] }
  ],
  "tensions": [
    { "text": "Long Horizon framed this as a moat play; I read it as distribution leverage.", "with": ["long-horizon"], "sources": [4] }
  ],
  "assumptions": [
    { "text": "We assume regulator timing slips by ≥2 quarters.", "falsifier": "FTC files before March", "sources": [5] }
  ],
  "risks": [
    { "text": "Channel concentration on 2 platforms creates fragility.", "severity": "high", "sources": [6] }
  ],
  "opportunities": [
    { "text": "Underserved mid-market segment if we relax the enterprise-only stance.", "sources": [7] }
  ],
  "actions": [
    { "text": "Run a 30-day pilot on the API-only tier.", "owner": "product", "horizon": "30 days", "sources": [8] }
  ],
  "quotes": [
    { "text": "The defensibility lives in the data flywheel, not the UI.", "sources": [2] }
  ],
  "openQuestions": [
    { "text": "What turns model-quality lead into a moat at our scale?", "priority": "P0", "sources": [3, 5] }
  ]
}
```

Constraints:
· Every entry's `sources` array is non-empty (cite at least one of your messages by 0-based index).
· "text" is in your own voice, not third-person paraphrase. Each entry max 60 words.
· Return all 9 fields as `[]` only when every indexed message is empty, "空席", punctuation-only, or a procedural stop/termination note with no substantive argument.
"""
    }
}
