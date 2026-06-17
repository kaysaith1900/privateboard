import Foundation
import BoardroomCore
import BoardroomAI

/// Faithful Swift port of the speaker-selection pickers — `skill-picker.ts`
/// (pickChairClarifyDecision / pickRoundWrap / pickNextSpeaker) +
/// `director-picker.ts` (pickDirectors + diversity guardrail). Every picker is
/// best-effort with a deterministic fallback: the room never blocks on a picker
/// failure. The cheap utility model drives clarify/round-wrap/next-speaker; the
/// user's default model drives director casting (a consequential pick). All LLM
/// calls go through the injected `EngineRouter` (real adapter in the app, a
/// scripted stub in tests).
public enum SpeakerPicker {

    // MARK: Result types

    public struct ClarifyDecision: Sendable, Equatable {
        public let shouldAsk: Bool
        public let rationale: String
    }
    public struct RoundWrapDecision: Sendable, Equatable {
        public let recommendation: String   // "end" | "continue"
        public let rationale: String
    }
    public struct NextSpeakerPick: Sendable, Equatable {
        public let agentId: String?
        public let rationale: String
        public let intervention: String?
    }
    public struct DirectorPick: Sendable, Equatable {
        public let agentId: String
        public let reason: String
    }
    public struct DirectorPickResult: Sendable, Equatable {
        public let picks: [DirectorPick]
        public let rationale: String
        public let fromLlm: Bool
    }

    static let maxPicks = 2

    // MARK: 1 · Chair clarify gate

    /// Should the chair ask a clarifying question before releasing directors?
    /// Default-to-ASK on every failure path (no prompt / no model / LLM error /
    /// unparseable). Only an explicit `ask:false` short-circuits clarify.
    public static func pickChairClarifyDecision(
        router: EngineRouter, history: [EngineMessage], mode: String? = nil
    ) async -> ClarifyDecision {
        let prompt = PickerSupport.latestUserPrompt(history)
        if prompt.isEmpty { return ClarifyDecision(shouldAsk: true, rationale: "no user prompt yet") }
        let isBrainstorm = (mode ?? "").lowercased() == "brainstorm"

        var sysParts = [clarifySystem]
        if isBrainstorm { sysParts.append(clarifyBrainstorm) }
        sysParts.append(clarifySchema)
        let sys = sysParts.joined(separator: "\n\n")
        let user = "Latest user message (the room subject):\n\(prompt)\n\nDoes the chair need to ask a clarifying question before opening the room?"

        guard let model = router.utilityModelV() else { return ClarifyDecision(shouldAsk: true, rationale: "") }
        guard let raw = try? await router.call(
            [LLMMessage(role: .system, content: sys), LLMMessage(role: .user, content: user)],
            modelV: model, temperature: 0, maxTokens: 120)
        else { return ClarifyDecision(shouldAsk: true, rationale: "") }

        guard let obj = PickerSupport.dict(PickerSupport.extractJson(raw)) else {
            return ClarifyDecision(shouldAsk: true, rationale: "")
        }
        // Only a literal `false` flips to skip (truthy/missing → ASK).
        let ask = (obj["ask"] as? Bool) != false
        let rationale = PickerSupport.clip(PickerSupport.str(obj, "rationale") ?? "", 200)
        return ClarifyDecision(shouldAsk: ask, rationale: rationale)
    }

    // MARK: 2 · Round wrap recommendation

    /// Recommend End or Continue at a reactive round wrap. Default-to-CONTINUE on
    /// every failure path — never push the user toward the destructive End action.
    public static func pickRoundWrap(
        router: EngineRouter, history: [EngineMessage], roundNum: Int, roomSubject: String?
    ) async -> RoundWrapDecision {
        let roster: [DirectorRef] = []   // labels resolve by kind; roster not load-bearing here
        let transcript = PickerSupport.transcript(history, take: 20, bodyCap: 600, roster: roster)
        var sys = roundWrapSystem
        if let subject = roomSubject {
            sys += "\n" + PickerSupport.languageLockBlock(PickerSupport.detectRoomLang(subject))
        }
        let user = "Round just finished: \(roundNum)\n\nTranscript:\n\(transcript.isEmpty ? "(empty — should not happen at round wrap)" : transcript)\n\nRecommend End or Continue."

        guard let model = router.utilityModelV() else { return RoundWrapDecision(recommendation: "continue", rationale: "") }
        guard let raw = try? await router.call(
            [LLMMessage(role: .system, content: sys), LLMMessage(role: .user, content: user)],
            modelV: model, temperature: 0, maxTokens: 200)
        else { return RoundWrapDecision(recommendation: "continue", rationale: "") }

        guard let obj = PickerSupport.dict(PickerSupport.extractJson(raw)) else {
            return RoundWrapDecision(recommendation: "continue", rationale: "")
        }
        let rec = (obj["recommendation"] as? String) == "end" ? "end" : "continue"
        let rationale = PickerSupport.clip(PickerSupport.str(obj, "rationale") ?? "", 160)
        return RoundWrapDecision(recommendation: rec, rationale: rationale)
    }

    // MARK: 3 · Next speaker (reactive)

    public enum NextSpeakerMode: String, Sendable { case lensGap = "lens-gap", dissentGap = "dissent-gap" }

    /// Pick the director whose lens most sharply addresses the prior turn (or, in
    /// dissent-gap mode, the one most likely to break the converging frame), and
    /// optionally a one-sentence chair intervention. Round-robin fallback
    /// (agentId nil) on <2 candidates / no model / LLM error / unparseable /
    /// unrecognized id.
    public static func pickNextSpeaker(
        router: EngineRouter, candidates: [DirectorRef], history: [EngineMessage],
        roomSubject: String?, mode: NextSpeakerMode = .lensGap, convergentTerms: [String] = []
    ) async -> NextSpeakerPick {
        let nullPick = NextSpeakerPick(agentId: nil, rationale: "", intervention: nil)
        guard candidates.count >= 2 else { return nullPick }
        let terms = convergentTerms.filter { !$0.isEmpty }

        // Roster.
        let roster = candidates.map { a -> String in
            var row = "- \(a.id) · \(a.name) (\(a.handle)) · \(a.roleTag)\n  \(a.bio)"
            if mode == .dissentGap {
                if !a.contrarianTakes.isEmpty {
                    row += "\n  · contrarian takes: " + a.contrarianTakes.prefix(3).joined(separator: " · ")
                }
                if let fm = a.failureModes.first {
                    row += "\n  · failure mode: " + fm
                }
            }
            return row
        }.joined(separator: "\n")

        let transcript = PickerSupport.transcript(history, take: 12, bodyCap: 600, roster: candidates)
        let decision1 = mode == .dissentGap ? nextSpeakerDissentBlock : nextSpeakerLensBlock
        var sys = nextSpeakerHead + "\n\n" + decision1 + "\n\n" + nextSpeakerTail
        if let subject = roomSubject {
            sys += "\n" + PickerSupport.languageLockBlock(PickerSupport.detectRoomLang(subject))
        }

        var userParts: [String] = []
        if let subject = roomSubject, !subject.isEmpty { userParts.append("Room subject: \(subject)\n") }
        if mode == .dissentGap, !terms.isEmpty {
            var block = "Detected convergent terms (room is over-investing here · the dissent pick should puncture these):"
            for t in terms { block += "\n  · \"\(t)\"" }
            userParts.append(block)
        }
        userParts.append("Candidates (queued, in current order):\n\(roster)")
        userParts.append("Recent transcript:\n\(transcript.isEmpty ? "(no prior turns yet — should not happen for next-speaker pick)" : transcript)")
        userParts.append("Pick the next speaker, and decide whether an intervention is warranted.")
        let user = userParts.joined(separator: "\n\n")

        guard let model = router.utilityModelV() else { return nullPick }
        guard let raw = try? await router.call(
            [LLMMessage(role: .system, content: sys), LLMMessage(role: .user, content: user)],
            modelV: model, temperature: 0, maxTokens: 320)
        else { return nullPick }

        guard let obj = PickerSupport.dict(PickerSupport.extractJson(raw)) else { return nullPick }
        let validIds = Set(candidates.map(\.id))
        let id: String? = {
            if let s = obj["agent_id"] as? String, validIds.contains(s) { return s }
            return nil
        }()
        let rationale = PickerSupport.clip(
            PickerSupport.replaceLeakedIds(PickerSupport.str(obj, "rationale") ?? "", candidates: candidates), 200)
        var intervention: String? = nil
        if let raw = obj["intervention"] as? String {
            let t = PickerSupport.replaceLeakedIds(t_trim(raw), candidates: candidates)
            let lower = t.lowercased()
            if !t.isEmpty, lower != "null", lower != "none" { intervention = PickerSupport.clip(t, 280) }
        }
        return NextSpeakerPick(agentId: id, rationale: rationale, intervention: intervention)
    }

    private static func t_trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    // MARK: 4 · Director casting (auto-pick at room creation)

    static let targetCastSize = 3
    static let lensAxes = ["dissent", "rigor", "empathy", "pattern_recall"]
    static let lensThreshold = 7

    /// Pick a 3-director cast optimizing for lens coverage + recency variety.
    /// ≤3 candidates → seat all. No model / LLM error / unparseable → the default
    /// cast, passed through the deterministic diversity guardrail.
    public static func pickDirectors(
        router: EngineRouter, subject: String, candidates: [DirectorRef],
        recentAppearances: [String: Int] = [:]
    ) async -> DirectorPickResult {
        if candidates.count <= targetCastSize {
            return DirectorPickResult(
                picks: candidates.map { DirectorPick(agentId: $0.id, reason: "") },
                rationale: "fewer directors than target cast size", fromLlm: false)
        }
        let user = ([
            "Subject:", subject, "",
            "Director catalog (\(candidates.count)):",
        ] + candidates.map { describeDirector($0, recentAppearances[$0.id] ?? 0) } + [
            "", "Pick 3 handles. Optimise for lens coverage AND variety across rooms (lean on recency tags).",
        ]).joined(separator: "\n")

        func fallback(_ rationale: String) -> DirectorPickResult {
            let cast = enforceDiversity(fallbackCast(candidates), candidates: candidates)
            return DirectorPickResult(picks: cast.map { DirectorPick(agentId: $0.id, reason: "default cast") },
                                      rationale: rationale, fromLlm: false)
        }
        guard let model = router.pickerModelV() else { return fallback("no model reachable · default cast seated") }
        guard let raw = try? await router.call(
            [LLMMessage(role: .system, content: directorPickerSystem), LLMMessage(role: .user, content: user)],
            modelV: model, temperature: 0.7, maxTokens: 1500)
        else { return fallback("picker unavailable · default cast seated") }

        guard let obj = PickerSupport.dict(PickerSupport.extractJson(raw)),
              let picksRaw = obj["picks"] as? [Any] else {
            return fallback("picker output unparseable · default cast seated")
        }
        // Resolve LLM picks.
        var llmPicks: [(agent: DirectorRef, reason: String)] = []
        var seen = Set<String>()
        for p in picksRaw {
            guard let pd = p as? [String: Any], let handle = (pd["handle"] as? String) else { continue }
            guard let agent = resolveCatalogAgent(candidates, handle) else { continue }
            if seen.contains(agent.id) { continue }
            seen.insert(agent.id)
            let reason = PickerSupport.clip((pd["reason"] as? String)?.trimmingCharacters(in: .whitespaces) ?? "", 80)
            llmPicks.append((agent, reason))
            if llmPicks.count >= targetCastSize { break }
        }
        // Top-up from the fallback cast.
        if llmPicks.count < targetCastSize {
            for a in fallbackCast(candidates) where !seen.contains(a.id) {
                seen.insert(a.id)
                llmPicks.append((a, "balance · default"))
                if llmPicks.count >= targetCastSize { break }
            }
        }
        var reasonsByAgent = Dictionary(uniqueKeysWithValues: llmPicks.map { ($0.agent.id, $0.reason) })
        let adjusted = enforceDiversity(llmPicks.map(\.agent), candidates: candidates)
        let rationale = PickerSupport.clip(PickerSupport.str(obj, "rationale") ?? "covers complementary lenses", 120)
        let finalRationale = (PickerSupport.str(obj, "rationale")?.isEmpty == false) ? rationale : "covers complementary lenses"
        return DirectorPickResult(
            picks: adjusted.map { DirectorPick(agentId: $0.id, reason: reasonsByAgent[$0.id] ?? "balance · diversity guardrail") },
            rationale: finalRationale, fromLlm: true)
    }

    // MARK: Director catalog helpers

    static func describeDirector(_ a: DirectorRef, _ recentCount: Int) -> String {
        let ability = a.ability.filter { $0.value >= lensThreshold }
            .sorted { $0.key < $1.key }
            .map { "\($0.key):\($0.value)" }.joined(separator: ",")
        let bio = PickerSupport.clip(a.bio, 140).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        let tag = (a.roleTag.isEmpty ? "director" : a.roleTag).lowercased()
        let recencyTag = recentCount > 0 ? " · [seen \(recentCount)/5 recent rooms]" : " · [unseen recently]"
        return "- \(a.handle) · \(a.name) · \(tag) · \"\(bio)\"\(ability.isEmpty ? "" : " · strong on { \(ability) }")\(recencyTag)"
    }

    static func bareHandleSlug(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespaces).lowercased()
        if t.hasPrefix("@") { t.removeFirst() }
        return t
    }

    static func resolveCatalogAgent(_ candidates: [DirectorRef], _ handleRaw: String) -> DirectorRef? {
        let t = handleRaw.trimmingCharacters(in: .whitespaces)
        if t.isEmpty { return nil }
        let bare = bareHandleSlug(t)
        if let exact = candidates.first(where: { $0.handle == t }) { return exact }
        return candidates.first(where: { bareHandleSlug($0.handle) == bare })
    }

    // MARK: Diversity guardrail (deterministic)

    static func coveredLenses(_ cast: [DirectorRef]) -> Set<String> {
        var s = Set<String>()
        for axis in lensAxes where cast.contains(where: { ($0.ability[axis] ?? 0) >= lensThreshold }) { s.insert(axis) }
        return s
    }

    static func findGapFiller(_ candidates: [DirectorRef], cast: [DirectorRef], gaps: Set<String>) -> DirectorRef? {
        let castIds = Set(cast.map(\.id))
        var best: DirectorRef? = nil
        var bestScore = 0
        for c in candidates where !castIds.contains(c.id) && !c.ability.isEmpty {
            var score = 0
            for axis in gaps where (c.ability[axis] ?? 0) >= lensThreshold { score += c.ability[axis] ?? 0 }
            if score > bestScore { bestScore = score; best = c }
        }
        return bestScore > 0 ? best : nil
    }

    static func pickRedundantMember(_ cast: [DirectorRef]) -> DirectorRef {
        if cast.count <= 1 { return cast[0] }
        var worst = cast[0]
        var worstRedundancy = -1
        for m in cast {
            if m.ability.isEmpty { return m }   // no ability = most expendable
            var redundancy = 0
            for other in cast where other.id != m.id {
                for axis in lensAxes where (m.ability[axis] ?? 0) >= lensThreshold && (other.ability[axis] ?? 0) >= lensThreshold {
                    redundancy += 1
                }
            }
            if redundancy > worstRedundancy { worstRedundancy = redundancy; worst = m }
        }
        return worst
    }

    static func enforceDiversity(_ picks: [DirectorRef], candidates: [DirectorRef]) -> [DirectorRef] {
        var cast = picks
        for _ in 0..<4 {
            let covered = coveredLenses(cast)
            if covered.count >= 2 { return cast }
            let gaps = Set(lensAxes.filter { !covered.contains($0) })
            guard let filler = findGapFiller(candidates, cast: cast, gaps: gaps) else { return cast }
            let drop = pickRedundantMember(cast)
            guard let idx = cast.firstIndex(where: { $0.id == drop.id }) else { return cast }
            cast[idx] = filler
        }
        return cast
    }

    static func fallbackCast(_ candidates: [DirectorRef]) -> [DirectorRef] {
        if candidates.count <= targetCastSize { return candidates }
        let canonical = ["@socrates", "@first_p", "@user_e"]
        var resolved: [DirectorRef] = []
        for h in canonical { if let a = resolveCatalogAgent(candidates, h), !resolved.contains(where: { $0.id == a.id }) { resolved.append(a) } }
        if resolved.count >= targetCastSize { return Array(resolved.prefix(targetCastSize)) }
        var picked = resolved
        let pickedIds = Set(picked.map(\.id))
        for a in candidates where !pickedIds.contains(a.id) {
            picked.append(a)
            if picked.count >= targetCastSize { break }
        }
        return Array(picked.prefix(targetCastSize))
    }
}
