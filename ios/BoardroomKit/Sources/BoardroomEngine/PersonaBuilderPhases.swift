import Foundation
import BoardroomCore
import BoardroomAI

/// Persona builder Phases 4-7 (rules → few-shot → reflection → eval → name) +
/// the `buildFull` pipeline that runs profile → … → name and assembles a full
/// PersonaSpec. The ReAct knowledge loop (Phase 2) + streaming job table + the
/// save/UI wiring are later sub-phases; this is the LLM-artifact core. Each phase
/// is best-effort (empty on failure) — only the profile pass is load-bearing.
extension PersonaBuilder {

    /// Run the full multi-phase build (no ReAct knowledge loop). nil if the
    /// load-bearing profile pass fails (no model / unparseable).
    public static func buildFull(router: EngineRouter, description: String) async -> BuiltPersona? {
        guard let profile = await buildProfile(router: router, description: description) else { return nil }
        let core = toCore(profile)
        let rules = await buildRules(router: router, description: description, profile: profile, knowledgeSummary: "")
        let fewShot = await buildFewShot(router: router, description: description, profile: profile, rules: rules)
        let reflection = await buildReflection(router: router, description: description, profile: profile, fewShotCount: fewShot.count)
        let evalSet = await buildEval(router: router, description: description, profile: profile)
        let name = await buildName(router: router, description: description, profile: profile)
        return BuiltPersona(spec: core, rules: rules, fewShot: fewShot,
                            reflectionChecklist: reflection, evalSet: evalSet, name: name)
    }

    // MARK: Phase 4 · behavioural rules

    static func buildRules(router: EngineRouter, description: String, profile: AgentProfile, knowledgeSummary: String) async -> [PersonaRule] {
        guard let model = router.pickerModelV() else { return [] }
        let user = [
            "Director description:", "", description.trimmingCharacters(in: .whitespacesAndNewlines), "",
            "Refined persona spec (v2, after knowledge retrieval):", "", "```json", profileJSON(profile), "```", "",
            "Knowledge context summary:", "", knowledgeSummary, "",
            "Now produce the behavioural rules JSON as specified.",
        ].joined(separator: "\n")
        guard let raw = try? await router.call(
            [LLMMessage(role: .system, content: rulesSystem), LLMMessage(role: .user, content: user)],
            modelV: model, temperature: 0.5, maxTokens: 1800) else { return [] }
        guard let obj = PickerSupport.dict(PickerSupport.extractJson(raw)), let arr = obj["rules"] as? [Any] else { return [] }
        let valid: Set<String> = ["always", "never", "conditional"]
        var out: [PersonaRule] = []
        for e in arr {
            guard let d = e as? [String: Any], let kind = d["kind"] as? String, valid.contains(kind),
                  let rule = (d["rule"] as? String)?.trimmingCharacters(in: .whitespaces), !rule.isEmpty else { continue }
            out.append(PersonaRule(kind: kind, rule: rule))
            if out.count >= 20 { break }
        }
        return out
    }

    // MARK: Phase 5 · few-shot examples

    static func buildFewShot(router: EngineRouter, description: String, profile: AgentProfile, rules: [PersonaRule]) async -> [PersonaFewShot] {
        guard let model = router.pickerModelV() else { return [] }
        let rulesText = rules.map { "· (\($0.kind)) \($0.rule)" }.joined(separator: "\n")
        let user = [
            "Director description:", "", description.trimmingCharacters(in: .whitespacesAndNewlines), "",
            "Refined persona spec:", "", "```json", profileJSON(profile), "```", "",
            "Behavioural rules already defined:", "", rulesText.isEmpty ? "(none)" : rulesText, "",
            "Now produce 3-5 worked examples as specified.",
        ].joined(separator: "\n")
        guard let raw = try? await router.call(
            [LLMMessage(role: .system, content: fewShotSystem), LLMMessage(role: .user, content: user)],
            modelV: model, temperature: 0.65, maxTokens: 3000) else { return [] }
        guard let obj = PickerSupport.dict(PickerSupport.extractJson(raw)), let arr = obj["examples"] as? [Any] else { return [] }
        var out: [PersonaFewShot] = []
        for e in arr {
            guard let d = e as? [String: Any],
                  let scenario = (d["scenario"] as? String)?.trimmingCharacters(in: .whitespaces), !scenario.isEmpty,
                  let persona = (d["personaResponse"] as? String)?.trimmingCharacters(in: .whitespaces), !persona.isEmpty else { continue }
            out.append(PersonaFewShot(scenario: scenario,
                                      genericResponse: (d["genericResponse"] as? String)?.trimmingCharacters(in: .whitespaces) ?? "",
                                      personaResponse: persona,
                                      rationale: (d["rationale"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""))
            if out.count >= 5 { break }
        }
        return out
    }

    // MARK: Phase 6 · reflection checklist

    static func buildReflection(router: EngineRouter, description: String, profile: AgentProfile, fewShotCount: Int) async -> [String] {
        guard let model = router.pickerModelV() else { return [] }
        let user = [
            "Director description:", "", description.trimmingCharacters(in: .whitespacesAndNewlines), "",
            "Refined persona spec:", "", "```json", profileJSON(profile), "```", "",
            "Few-shot examples available · \(fewShotCount) total.", "",
            "Now produce the reflection checklist JSON as specified.",
        ].joined(separator: "\n")
        guard let raw = try? await router.call(
            [LLMMessage(role: .system, content: reflectionSystem), LLMMessage(role: .user, content: user)],
            modelV: model, temperature: 0.5, maxTokens: 800) else { return [] }
        guard let obj = PickerSupport.dict(PickerSupport.extractJson(raw)), let arr = obj["checklist"] as? [Any] else { return [] }
        return arr.compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.prefix(8).map { $0 }
    }

    // MARK: Phase 7 · eval set

    static func buildEval(router: EngineRouter, description: String, profile: AgentProfile) async -> [PersonaEvalEntry] {
        guard let model = router.pickerModelV() else { return [] }
        let user = [
            "Director description:", "", description.trimmingCharacters(in: .whitespacesAndNewlines), "",
            "Refined persona spec:", "", "```json", profileJSON(profile), "```", "",
            "Now produce the eval prompts JSON as specified.",
        ].joined(separator: "\n")
        guard let raw = try? await router.call(
            [LLMMessage(role: .system, content: evalSystem), LLMMessage(role: .user, content: user)],
            modelV: model, temperature: 0.5, maxTokens: 1500) else { return [] }
        guard let obj = PickerSupport.dict(PickerSupport.extractJson(raw)), let arr = obj["prompts"] as? [Any] else { return [] }
        var out: [PersonaEvalEntry] = []
        for e in arr {
            guard let d = e as? [String: Any],
                  let prompt = (d["prompt"] as? String)?.trimmingCharacters(in: .whitespaces), !prompt.isEmpty else { continue }
            out.append(PersonaEvalEntry(prompt: prompt,
                                        expectedSignature: (d["expectedSignature"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""))
            if out.count >= 10 { break }
        }
        return out
    }

    // MARK: Post-pipeline · name

    static func buildName(router: EngineRouter, description: String, profile: AgentProfile) async -> PersonaName? {
        guard let model = router.utilityModelV() ?? router.defaultModelV() else { return nil }
        let nameInput: [String: Any] = [
            "intellectualLineage": ["influencedBy": profile.intellectualLineage.influencedBy, "opposedTo": profile.intellectualLineage.opposedTo],
            "contrarianTakes": profile.contrarianTakes,
            "loadBearingConcepts": profile.loadBearingConcepts.map { ["name": $0.name, "gloss": $0.gloss] },
            "failureModes": profile.failureModes,
            "referentSet": profile.referentSet.map { ["ref": $0.ref, "why": $0.why] },
        ]
        let specJSON = (try? JSONSerialization.data(withJSONObject: nameInput, options: [.prettyPrinted]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let user = [
            "Director description (user seed):", "", description.trimmingCharacters(in: .whitespacesAndNewlines), "",
            "Refined persona spec (post knowledge retrieval):", "", "```json", specJSON, "```", "",
            "Now produce { \"name\": \"...\", \"handle\": \"...\" } for this director.",
        ].joined(separator: "\n")
        guard let raw = try? await router.call(
            [LLMMessage(role: .system, content: nameSystem), LLMMessage(role: .user, content: user)],
            modelV: model, temperature: 0.7, maxTokens: 120) else { return nil }
        guard let obj = PickerSupport.dict(PickerSupport.extractJson(raw)),
              let name = (obj["name"] as? String)?.trimmingCharacters(in: .whitespaces),
              name.count >= 2, name.count <= 48 else { return nil }
        return PersonaName(name: name, handle: (obj["handle"] as? String)?.trimmingCharacters(in: .whitespaces) ?? "")
    }

    // MARK: Helpers

    /// Pretty-print an AgentProfile as the JSON the phase user-messages embed.
    static func profileJSON(_ p: AgentProfile) -> String {
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted]
        return (try? enc.encode(p)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    /// The full `agents.persona_spec_json` blob from a complete build.
    public static func personaSpecJSONFull(_ built: BuiltPersona, description: String, generatedAt: String) -> String? {
        let core = built.spec
        let spec: [String: Any] = [
            "intellectualLineage": core.intellectualLineage, "loadBearingConcepts": core.loadBearingConcepts,
            "referentSet": core.referentSet, "failureModes": core.failureModes, "contrarianTakes": core.contrarianTakes,
        ]
        var blob: [String: Any] = [
            "version": 1, "generatedAt": generatedAt, "description": description, "spec": spec,
            "rules": built.rules.map { ["kind": $0.kind, "rule": $0.rule] },
            "fewShot": built.fewShot.map { ["scenario": $0.scenario, "genericResponse": $0.genericResponse, "personaResponse": $0.personaResponse, "rationale": $0.rationale] },
            "reflectionChecklist": built.reflectionChecklist,
            "evalSet": built.evalSet.map { ["prompt": $0.prompt, "expectedSignature": $0.expectedSignature] },
        ]
        if let n = built.name { blob["guessName"] = n.name; blob["guessHandle"] = n.handle }
        return (try? JSONSerialization.data(withJSONObject: blob)).flatMap { String(data: $0, encoding: .utf8) }
    }

    /// Compile a built persona into the 8-section `instruction` the rest of the
    /// engine reads (port of `synthesizePersonaInstruction`, minus the ReAct
    /// knowledge block which the native build doesn't produce yet). Capped 6000.
    public static func synthesizeInstruction(_ built: BuiltPersona, name: String, roleTag: String, description: String) -> String {
        let spec = built.spec
        var lines: [String] = ["You are \(name), a board director.", "", "## Identity"]
        if !spec.intellectualLineage.isEmpty { lines.append("Lineage · \(spec.intellectualLineage.prefix(3).joined(separator: " · "))") }
        lines.append("Role · \(roleTag)")
        if !description.isEmpty { lines.append("Origin · \(personaTruncate(description, 240))") }
        lines.append("")
        lines.append("## Method")
        if !spec.loadBearingConcepts.isEmpty {
            lines.append("Concepts you reach for first:")
            for c in spec.loadBearingConcepts.prefix(5) { lines.append("  · \(c)") }
            lines.append("")
        }
        if !spec.referentSet.isEmpty {
            lines.append("## Referent set")
            for r in spec.referentSet.prefix(6) { lines.append("  · \(r)") }
            lines.append("")
        }
        if !spec.contrarianTakes.isEmpty {
            lines.append("## Contrarian takes")
            for t in spec.contrarianTakes.prefix(5) { lines.append("  · \(t)") }
            lines.append("")
        }
        if !built.rules.isEmpty {
            lines.append("## Rules")
            for r in built.rules.prefix(12) { lines.append("  · (\(r.kind)) \(r.rule)") }
            lines.append("")
        }
        if !spec.failureModes.isEmpty {
            lines.append("## Failure modes you guard against")
            for f in spec.failureModes.prefix(5) { lines.append("  · \(f)") }
            lines.append("")
        }
        lines.append("## Voice")
        lines.append("Specific over general. Named referents over abstractions. Hold the position when challenged unless the challenge surfaces a genuinely new constraint.")
        return personaTruncate(lines.joined(separator: "\n"), 6000)
    }

    static func personaTruncate(_ s: String, _ max: Int) -> String {
        s.count <= max ? s : String(s.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }
}
