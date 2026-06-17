import Foundation
import BoardroomAI

/// Closing brief — the on-device counterpart of `src/orchestrator/brief.ts`.
///
/// MVP: a SINGLE chair-authored markdown synthesis from the full transcript +
/// voted key points (one flagship LLM call), persisted to the `briefs` table.
/// The desktop's 3-stage pipeline (per-director extract → chair scaffold → chair
/// write) + the report-spine HTML rendering are a later port; this produces a
/// real, readable markdown brief the native UI shows as text. Returns the brief
/// markdown (also persisted; `briefId` available via the store).
public struct BriefGenerator: Sendable {
    let store: RoomStore
    let llm: EngineLLM
    let router: EngineRouter?
    public init(store: RoomStore, llm: EngineLLM, router: EngineRouter? = nil) {
        self.store = store; self.llm = llm; self.router = router
    }

    /// Brief output mode · research-note (the spine pipeline) or one of the three
    /// structured modes (single bento JSON → magazine/newspaper/ppt template).
    public enum Mode: String, Sendable { case researchNote = "research-note", magazine, newspaper, ppt
        var bento: BriefBento.Mode? {
            switch self { case .magazine: return .magazine; case .newspaper: return .newspaper; case .ppt: return .ppt; case .researchNote: return nil }
        }
    }

    /// Generate + persist the brief for a room. `chairModel` defaults to the
    /// chair's model. Returns (briefId, markdown). Throws on LLM error.
    @discardableResult
    public func generate(roomId: String, briefStore: BriefStore, supplement: String? = nil,
                         mode: Mode = .researchNote) async throws -> (id: String, markdown: String) {
        guard let chair = await store.chair(roomId) else { throw BriefError.noChair }
        let supp = (supplement ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        // Structured modes (magazine / newspaper / ppt) · skip the composer + Stage
        // 2/3. ONE chair-LLM call emits the BentoScaffold JSON, persisted as
        // body_json; the native renderer templates it via the matching HTML page.
        if let bentoMode = mode.bento, supp.isEmpty, let router {
            let subject = (await store.roomMeta(roomId))?.subject ?? ""
            let assets = await BriefExtractor.runStage1Assets(router: router, store: store, roomId: roomId)
            let signals = BriefExtractor.signalsFrom(assets)
            if !signals.isEmpty {
                let members = (await store.directors(roomId)).map { BriefStages.Member(id: $0.id, name: $0.name, handle: $0.handle, roleTag: $0.roleTag) }
                let fbSource = "From \(chair.name)"
                if let bento = await BriefBento.run(router: router, mode: bentoMode, subject: subject,
                                                    roomNumber: 0, roomName: subject, members: members,
                                                    signals: signals, fallbackSource: fbSource, fallbackFooterTag: subject) {
                    // body_md is a minimal text fallback (the renderer uses body_json).
                    let md = [bento.title, bento.conclusion].filter { !$0.isEmpty }.joined(separator: "\n\n")
                    let render = BriefRender(spine: "boardroom-dark", componentsJSON: "[]", houseStyle: "boardroom-default",
                                             rationale: nil, subjectType: nil, style: mode.rawValue, bodyJSON: bento.bodyJSON)
                    let id = await briefStore.insertBrief(roomId: roomId, title: bento.title, markdown: md, render: render)
                    return (id, md)
                }
            }
            // Bento failed → fall through to the research-note pipeline below.
        }

        let history = await store.recentMessages(roomId, limit: 200)
        let transcript = history
            .filter { !$0.body.isEmpty && $0.authorKind != "system" }
            .map { m -> String in
                let who = m.authorKind == "user" ? "User" : (m.authorId ?? "Director")
                return "[\(who)] \(m.body)"
            }
            .joined(separator: "\n\n")
        let subject = (await store.roomMeta(roomId))?.subject ?? ""

        // The full Stage 1→2→3 pipeline (P4-10) · extract per-director signals →
        // cluster into a structured scaffold → stream the McKinsey-grade markdown.
        // On any failure fall through to the simple signals-grounded chair write.
        // A user supplement (custom angle / focus) goes through the single chair
        // write below so the instruction is honored verbatim; the multi-stage
        // pipeline (which builds its own prompts) is skipped in that case.
        var signalsBlock = ""
        if let router, supp.isEmpty {
            let assets = await BriefExtractor.runStage1Assets(router: router, store: store, roomId: roomId)
            let signals = BriefExtractor.signalsFrom(assets)
            if !signals.isEmpty {
                let meta = await store.roomMeta(roomId)
                let members = (await store.directors(roomId)).map {
                    BriefStages.Member(id: $0.id, name: $0.name, handle: $0.handle, roleTag: $0.roleTag)
                }
                // Stage 1.5 · composer picks the spine + house-style + components.
                // The spine drives the native report.html render.
                let lang = PickerSupport.detectRoomLang(subject) == .zh ? "zh" : "en"
                let comp = await BriefComposer.run(
                    router: router, subject: subject, roomNumber: 0, roomName: subject,
                    mode: meta?.mode ?? "constructive", intensity: meta?.intensity ?? "sharp",
                    members: members, assets: assets, language: lang)
                let render = BriefRender(spine: comp.spine, componentsJSON: comp.componentsJSON,
                                         houseStyle: comp.houseStyle,
                                         rationale: comp.rationale.isEmpty ? nil : comp.rationale,
                                         subjectType: comp.subjectType)
                if let scaffold = await BriefStages.runStage2(router: router, subject: subject, roomName: subject, members: members, signals: signals),
                   let md = await BriefStages.runStage3(router: router, subject: subject, members: members, scaffold: scaffold, signals: signals) {
                    let trimmed = md.trimmingCharacters(in: .whitespacesAndNewlines)
                    let title = scaffold.title.isEmpty ? (Self.firstHeading(trimmed) ?? (subject.isEmpty ? "Closing Brief" : subject)) : scaffold.title
                    let id = await briefStore.insertBrief(roomId: roomId, title: title, markdown: trimmed, render: render)
                    return (id, trimmed)
                }
                signalsBlock = BriefExtractor.signalsBlock(signals)   // Stage 2/3 failed → signals-grounded simple write
            }
        }

        let system = [
            chair.instruction.isEmpty ? "You are the Chair." : chair.instruction,
            "",
            "─── YOUR TASK · WRITE THE CLOSING BRIEF ───",
            "The meeting has adjourned. Write the closing brief as Markdown — a tight, decision-useful synthesis of the discussion below, in the room's dominant language.",
            signalsBlock.isEmpty ? "" :
                "The DIRECTOR SIGNALS block lists each director's EXTRACTED, lens-tagged material (claims / evidence / tensions / risks / actions / open questions, cited to their turns). Use it to make the multi-director thinking VISIBLE — name who held which position, surface the tensions between directors, don't flatten distinct lenses into one voice.",
            "",
            "Structure (use `##` headings):",
            "## Summary — 2–3 sentences: what was actually decided or surfaced.",
            "## Key Points — the load-bearing conclusions / tensions (bullets).",
            "## Open Questions — what's still unresolved (bullets).",
            "## Recommended Next Steps — concrete, sequenced (numbered).",
            "",
            "Plain, substantive prose. No preamble, no flattery, no 'In conclusion'.",
            supp.isEmpty ? "" :
                "\n─── ADDITIONAL INSTRUCTION FROM THE USER (take priority on focus / angle / format) ───\n\(supp)",
        ].joined(separator: "\n")
        let user = [
            "Subject: \(subject)",
            signalsBlock.isEmpty ? "" : "\n\(signalsBlock)",
            "\nTranscript:\n\(transcript)",
            "\nWrite the brief now (Markdown, in the room's language).",
        ].joined(separator: "\n")

        var body = ""
        do {
            for try await chunk in llm.stream(
                [LLMMessage(role: .system, content: system), LLMMessage(role: .user, content: user)],
                modelV: chair.modelV, maxTokens: 4000, purpose: .roundEnd) {
                if case .textDelta(let d) = chunk { body += d }
            }
        } catch { throw BriefError.llm("\(error)") }

        let md = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !md.isEmpty else { throw BriefError.empty }
        let title = Self.firstHeading(md) ?? (subject.isEmpty ? "Closing Brief" : subject)
        let id = await briefStore.insertBrief(roomId: roomId, title: title, markdown: md)
        return (id, md)
    }

    /// First `# `/`## ` heading text, for the brief title.
    static func firstHeading(_ md: String) -> String? {
        for line in md.split(separator: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if let r = t.range(of: #"^#{1,3}\s+"#, options: .regularExpression) {
                let h = String(t[r.upperBound...]).trimmingCharacters(in: .whitespaces)
                if !h.isEmpty { return h }
            }
        }
        return nil
    }
}

public enum BriefError: Error, Equatable { case noChair, empty, llm(String) }

/// The composer's render decision, persisted onto the brief row (drives the
/// native report.html spine render). `nil` ⇒ the briefs-table column defaults.
public struct BriefRender: Sendable, Equatable {
    public var spine: String
    public var componentsJSON: String
    public var houseStyle: String
    public var rationale: String?
    public var subjectType: String?
    /// `briefs.style` · "auto" for research-note, else the structured mode slug
    /// (magazine / newspaper / ppt) so the native renderer picks the right page.
    public var style: String
    /// `briefs.body_json` · the BentoScaffold JSON for structured modes (nil for
    /// research-note, which uses body_md + the spine renderer).
    public var bodyJSON: String?
    public init(spine: String, componentsJSON: String, houseStyle: String, rationale: String?,
                subjectType: String?, style: String = "auto", bodyJSON: String? = nil) {
        self.spine = spine; self.componentsJSON = componentsJSON; self.houseStyle = houseStyle
        self.rationale = rationale; self.subjectType = subjectType
        self.style = style; self.bodyJSON = bodyJSON
    }
}

/// Persistence seam for briefs (the `briefs` table). GRDB impl + test stub.
public protocol BriefStore: Sendable {
    /// Insert a brief, return its id. `render` carries the composer's spine /
    /// components / house-style; nil ⇒ the briefs-table defaults (boardroom-dark).
    func insertBrief(roomId: String, title: String, markdown: String, render: BriefRender?) async -> String
    /// Latest brief markdown for a room, if any.
    func latestBriefMarkdown(roomId: String) async -> String?
}

public extension BriefStore {
    /// Back-compat overload · no composer render → table defaults.
    func insertBrief(roomId: String, title: String, markdown: String) async -> String {
        await insertBrief(roomId: roomId, title: title, markdown: markdown, render: nil)
    }
}
