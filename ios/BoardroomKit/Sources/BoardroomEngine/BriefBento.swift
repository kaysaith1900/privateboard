import Foundation
import BoardroomAI

/// Brief structured modes (`brief-stages.ts` · magazine / newspaper / ppt). These
/// modes skip the composer + Stage 2 scaffold + Stage 3 write. Instead the chair
/// runs ONE LLM call that emits a `BentoScaffold` JSON (the structured output IS
/// the deliverable; the renderer is deterministic client-side templating against
/// magazine.html / newspaper.html / ppt.html). All three share the BentoScaffold
/// schema + the `parseBento` tolerant parser; only the system prompt differs
/// (codegen'd into `brief-prompts.json`). The parsed scaffold is persisted as the
/// brief row's `body_json`. Faithful port of the types + parseBento + the run.
public enum BriefBento {
    public enum Mode: String, Sendable { case magazine, newspaper, ppt }

    // MARK: BentoScaffold schema (Codable · keys = desktop body_json shape)

    public struct Scaffold: Codable, Sendable, Equatable {
        public var title: String
        public var kicker: String
        public var source: String
        public var milestones: [Milestone]
        public var rankedBars: RankedBars?
        public var verification: Verification?
        public var talkingPoints: TalkingPoints
        public var conclusion: String
        public var flow: Flow?
        public var footerTag: String
        public var directorBlock: PptDirectorBlock?
        public var bodyJSON: String {
            let enc = JSONEncoder(); enc.outputFormatting = [.withoutEscapingSlashes]
            return (try? enc.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        }
    }
    public struct Milestone: Codable, Sendable, Equatable {
        public var period: String; public var title: String; public var body: String
        public var callout: String; public var tags: [String]
    }
    public struct RankedBars: Codable, Sendable, Equatable {
        public var title: String; public var entries: [Entry]
        public struct Entry: Codable, Sendable, Equatable { public var label: String; public var value: String; public var ratio: Double }
    }
    public struct Verification: Codable, Sendable, Equatable { public var title: String; public var bullets: [String] }
    public struct TalkingPoints: Codable, Sendable, Equatable { public var title: String; public var bullets: [String] }
    public struct Flow: Codable, Sendable, Equatable { public var nodes: [String]; public var caption: String? }
    public struct PptDirectorBlock: Codable, Sendable, Equatable {
        public var perspectives: [Perspective]; public var alignment: [Alignment]
        public var divergence: [Divergence]; public var chairSynthesis: String
        public struct Perspective: Codable, Sendable, Equatable { public var directorName: String; public var directorRole: String; public var stance: String; public var position: String; public var quote: String }
        public struct Alignment: Codable, Sendable, Equatable { public var pointOfAgreement: String; public var directorNames: [String]; public var note: String }
        public struct Divergence: Codable, Sendable, Equatable { public var hinge: String; public var sides: [Side]; public var resolution: String }
        public struct Side: Codable, Sendable, Equatable { public var label: String; public var directorNames: [String]; public var stance: String }
    }

    // MARK: run (single LLM call · flagship, temps [0.2, 0.5], max16000)

    public static func run(router: EngineRouter, mode: Mode, subject: String, roomNumber: Int,
                           roomName: String, members: [BriefStages.Member], signals: [BriefAssets.DirectorSignals],
                           supplement: String? = nil, fallbackSource: String = "", fallbackFooterTag: String = "") async -> Scaffold? {
        let sys: String?
        switch mode {
        case .magazine: sys = BriefStages.catalog?.magazine
        case .newspaper: sys = BriefStages.catalog?.newspaper
        case .ppt: sys = BriefStages.catalog?.ppt
        }
        guard let system = sys, let model = router.defaultModelV() ?? router.utilityModelV() else { return nil }
        let lang = PickerSupport.languageLockBlock(PickerSupport.detectRoomLang(subject))
        let user = buildUser(subject: subject, roomNumber: roomNumber, roomName: roomName, members: members, signals: signals, supplement: supplement)
        let msgs = [LLMMessage(role: .system, content: system + "\n\n" + lang), LLMMessage(role: .user, content: user)]
        let fbTitle = roomName.isEmpty ? (subject.isEmpty ? "Brief" : String(subject.prefix(60))) : roomName
        for temp in [0.2, 0.5] {
            guard let raw = try? await router.call(msgs, modelV: model, temperature: temp, maxTokens: 16000) else { continue }
            if let s = parse(raw, fallbackTitle: fbTitle, fallbackSource: fallbackSource, fallbackFooterTag: fallbackFooterTag) { return s }
        }
        return nil
    }

    static func buildUser(subject: String, roomNumber: Int, roomName: String, members: [BriefStages.Member],
                          signals: [BriefAssets.DirectorSignals], supplement: String?) -> String {
        let memberList = members.map { "\($0.id) · \($0.name) (\($0.handle)) — \($0.roleTag)" }.joined(separator: "\n  · ")
        let byId = Dictionary(uniqueKeysWithValues: signals.map { ($0.directorId, $0) })
        let signalsBlock = members.map { m -> String in
            guard let d = byId[m.id], !d.signals.isEmpty else { return "[\(m.id)] \(m.name) — (no signals)" }
            let lines = d.signals.enumerated().map { "  · \(d.directorId)#\($0.offset) [\($0.element.lens)] \($0.element.text)" }.joined(separator: "\n")
            return "[\(d.directorId)] \(d.directorName)\n\(lines)"
        }.joined(separator: "\n\n")
        let supp = supplement?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let supplementBlock = supp.isEmpty ? "" : [
            "", "─── SUPPLEMENTARY PERSPECTIVE FROM USER ───", "",
            "The user has asked you to additionally consider this angle. Surface it in the most fitting slot.",
            "", supp, "", "─── END SUPPLEMENT ───",
        ].joined(separator: "\n")
        return [
            "ROOM #\(roomNumber) · \(roomName)", "Subject: \(subject)", "",
            "Directors:", "  · \(memberList)", "",
            "─── SIGNALS ───", "",
            signalsBlock.isEmpty ? "(no signals extracted)" : signalsBlock, "",
            "─── END SIGNALS ───", supplementBlock, "",
            "Produce the structured report now. JSON only.",
        ].joined(separator: "\n")
    }

    // MARK: parseBento (tolerant · port of parseBento + sub-parsers)

    static func clip(_ s: String, _ max: Int) -> String {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard t.count > max else { return t }
        return String(t.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }
    static func strField(_ o: [String: Any], _ k: String) -> String { (o[k] as? String)?.trimmingCharacters(in: .whitespaces) ?? "" }

    public static func parse(_ raw: String, fallbackTitle: String, fallbackSource: String, fallbackFooterTag: String) -> Scaffold? {
        guard let o = PickerSupport.extractJson(raw) as? [String: Any] else { return nil }
        let title = clip(strField(o, "title").isEmpty ? fallbackTitle : strField(o, "title"), 110)
        guard !title.isEmpty else { return nil }
        var milestones = parseMilestones(o["milestones"])
        guard !milestones.isEmpty else { return nil }
        while milestones.count < 3 { milestones.append(Milestone(period: "", title: "", body: "", callout: "", tags: [])) }
        if milestones.count > 3 { milestones = Array(milestones.prefix(3)) }
        return Scaffold(
            title: title,
            kicker: clip(strField(o, "kicker"), 200),
            source: clip(strField(o, "source").isEmpty ? fallbackSource : strField(o, "source"), 80),
            milestones: milestones,
            rankedBars: parseRankedBars(o["rankedBars"]),
            verification: parseVerification(o["verification"]),
            talkingPoints: parseTalkingPoints(o["talkingPoints"]),
            conclusion: clip(strField(o, "conclusion"), 100),
            flow: parseFlow(o["flow"]),
            footerTag: clip(strField(o, "footerTag").isEmpty ? fallbackFooterTag : strField(o, "footerTag"), 80),
            directorBlock: parsePptDirectorBlock(o["directorBlock"]))
    }

    static func parseMilestones(_ raw: Any?) -> [Milestone] {
        guard let arr = raw as? [Any] else { return [] }
        var out: [Milestone] = []
        for m in arr {
            guard let o = m as? [String: Any] else { continue }
            let title = clip(strField(o, "title"), 60), body = clip(strField(o, "body"), 220)
            guard !title.isEmpty, !body.isEmpty else { continue }
            let tags = ((o["tags"] as? [Any]) ?? []).compactMap { ($0 as? String).map { clip($0, 16) } }.filter { !$0.isEmpty }.prefix(4)
            out.append(Milestone(period: clip(strField(o, "period"), 24), title: title, body: body,
                                 callout: clip(strField(o, "callout"), 12), tags: Array(tags)))
            if out.count >= 3 { break }
        }
        return out
    }
    static func parseRankedBars(_ raw: Any?) -> RankedBars? {
        guard let o = raw as? [String: Any] else { return nil }
        let title = clip(strField(o, "title"), 40); guard !title.isEmpty else { return nil }
        var entries: [RankedBars.Entry] = []
        for e in (o["entries"] as? [Any]) ?? [] {
            guard let eo = e as? [String: Any] else { continue }
            let label = clip(strField(eo, "label"), 40), value = clip(strField(eo, "value"), 20)
            guard !label.isEmpty, !value.isEmpty else { continue }
            var ratio = 0.0
            if let r = eo["ratio"] as? Double, r.isFinite { ratio = max(0, min(1, r)) }
            else if let r = (eo["ratio"] as? NSNumber)?.doubleValue, r.isFinite { ratio = max(0, min(1, r)) }
            entries.append(.init(label: label, value: value, ratio: ratio))
            if entries.count >= 5 { break }
        }
        return entries.count >= 2 ? RankedBars(title: title, entries: entries) : nil
    }
    static func parseVerification(_ raw: Any?) -> Verification? {
        guard let o = raw as? [String: Any] else { return nil }
        let title = clip(strField(o, "title"), 40); guard !title.isEmpty else { return nil }
        let bullets = parseBullets(o["bullets"], 140, 5)
        return bullets.isEmpty ? nil : Verification(title: title, bullets: bullets)
    }
    static func parseTalkingPoints(_ raw: Any?) -> TalkingPoints {
        guard let o = raw as? [String: Any] else { return TalkingPoints(title: "How to say this", bullets: []) }
        let title = clip(strField(o, "title"), 40)
        return TalkingPoints(title: title.isEmpty ? "How to say this" : title, bullets: parseBullets(o["bullets"], 120, 5))
    }
    static func parseBullets(_ raw: Any?, _ maxChars: Int, _ maxCount: Int) -> [String] {
        guard let arr = raw as? [Any] else { return [] }
        var out: [String] = []
        for b in arr { if let s = b as? String { let c = clip(s, maxChars); if !c.isEmpty { out.append(c) } }; if out.count >= maxCount { break } }
        return out
    }
    static func parseFlow(_ raw: Any?) -> Flow? {
        guard let o = raw as? [String: Any] else { return nil }
        var nodes: [String] = []
        for n in (o["nodes"] as? [Any]) ?? [] { if let s = n as? String { let c = clip(s, 24); if !c.isEmpty { nodes.append(c) } }; if nodes.count >= 4 { break } }
        guard nodes.count >= 2 else { return nil }
        let caption = clip(strField(o, "caption"), 60)
        return caption.isEmpty ? Flow(nodes: nodes, caption: nil) : Flow(nodes: nodes, caption: caption)
    }
    static func parsePptDirectorBlock(_ raw: Any?) -> PptDirectorBlock? {
        guard let o = raw as? [String: Any] else { return nil }
        var perspectives: [PptDirectorBlock.Perspective] = []
        for p in (o["perspectives"] as? [Any]) ?? [] {
            guard let po = p as? [String: Any] else { continue }
            let name = clip(strField(po, "directorName"), 32), position = clip(strField(po, "position"), 240)
            guard !name.isEmpty, !position.isEmpty else { continue }
            perspectives.append(.init(directorName: name, directorRole: clip(strField(po, "directorRole"), 48),
                                      stance: clip(strField(po, "stance"), 60), position: position, quote: clip(strField(po, "quote"), 160)))
        }
        guard perspectives.count >= 2 else { return nil }
        var alignment: [PptDirectorBlock.Alignment] = []
        for a in (o["alignment"] as? [Any]) ?? [] {
            guard let ao = a as? [String: Any] else { continue }
            let point = clip(strField(ao, "pointOfAgreement"), 120)
            let names = ((ao["directorNames"] as? [Any]) ?? []).compactMap { ($0 as? String).map { clip($0, 32) } }.filter { !$0.isEmpty }.prefix(6)
            guard !point.isEmpty, names.count >= 2 else { continue }
            alignment.append(.init(pointOfAgreement: point, directorNames: Array(names), note: clip(strField(ao, "note"), 200)))
            if alignment.count >= 3 { break }
        }
        var divergence: [PptDirectorBlock.Divergence] = []
        for d in (o["divergence"] as? [Any]) ?? [] {
            guard let dgo = d as? [String: Any] else { continue }
            let hinge = clip(strField(dgo, "hinge"), 140)
            var sides: [PptDirectorBlock.Side] = []
            for s in (dgo["sides"] as? [Any]) ?? [] {
                guard let so = s as? [String: Any] else { continue }
                let label = clip(strField(so, "label"), 40), stance = clip(strField(so, "stance"), 160)
                let names = ((so["directorNames"] as? [Any]) ?? []).compactMap { ($0 as? String).map { clip($0, 32) } }.filter { !$0.isEmpty }.prefix(4)
                guard !label.isEmpty, !stance.isEmpty, !names.isEmpty else { continue }
                sides.append(.init(label: label, directorNames: Array(names), stance: stance))
            }
            guard !hinge.isEmpty, sides.count >= 2 else { continue }
            divergence.append(.init(hinge: hinge, sides: sides, resolution: clip(strField(dgo, "resolution"), 200)))
            if divergence.count >= 2 { break }
        }
        return PptDirectorBlock(perspectives: perspectives, alignment: alignment, divergence: divergence,
                                chairSynthesis: clip(strField(o, "chairSynthesis"), 240))
    }
}
