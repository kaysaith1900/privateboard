import Foundation
import BoardroomAI

/// Faithful port of the chair prompt builders from `src/orchestrator/prompt.ts`
/// (`buildChairSystem` + `buildChairClarifyMessages` + `buildChairRoundEndMessages`
/// + `renderHistoryForChair`). Deterministic string assembly → unit-tested.
///
/// Self-contained: takes explicit context rather than the live DB/agent objects.
/// The memory / mode-protocol / shared-materials / language-lock-tail blocks
/// (which depend on subsystems not yet ported — long-term memory, fetch-url,
/// detectRoomLang) are intentionally omitted and marked TODO; the core identity,
/// room context, language rule, voice delivery, task, and history are verbatim.
///
/// Built standalone this pass; `RoomActor` adoption needs the `RoomStore` seam to
/// surface room subject/tone + director handles/roleTags + chair.instruction
/// (a separate, test-covered wiring step).
public enum ChairPromptBuilder {
    public struct Director: Sendable, Equatable {
        public let name: String, handle: String, roleTag: String
        public init(name: String, handle: String, roleTag: String) {
            self.name = name; self.handle = handle; self.roleTag = roleTag
        }
    }
    public struct HistoryTurn: Sendable, Equatable {
        public enum Kind: Sendable { case user, system, agent }
        public let kind: Kind
        public let name: String?     // agent display name
        public let handle: String?   // agent @handle
        public let body: String
        public init(kind: Kind, name: String? = nil, handle: String? = nil, body: String) {
            self.kind = kind; self.name = name; self.handle = handle; self.body = body
        }
    }
    public struct Context: Sendable {
        public var chairInstruction: String
        public var subject: String
        public var mode: String          // tone
        public var intensity: String
        public var directors: [Director]
        public var userName: String
        public var userIntro: String?
        public var deliveryVoice: Bool
        public var history: [HistoryTurn]
        /// Pre-rendered chair-only `user_long_memory` sanctuary block (durable
        /// tag-shaped abstractions about the user). Rendered by RoomActor from the
        /// UserLongMemoryStore; empty when the table is empty (P4-7c).
        public var userLongBlock: String
        /// Pre-rendered chair's own per-agent memory block (cross-room notes).
        public var memoryBlock: String
        /// Web-search SHARED MATERIALS block (#10) · the chair's grounding for a
        /// clarify turn. Empty when no search ran. Injected between the mode
        /// protocol and the per-turn task, mirroring prompt.ts:1390.
        public var sharedMaterials: String
        public init(chairInstruction: String, subject: String, mode: String, intensity: String,
                    directors: [Director], userName: String, userIntro: String? = nil,
                    deliveryVoice: Bool = false, history: [HistoryTurn] = [],
                    userLongBlock: String = "", memoryBlock: String = "", sharedMaterials: String = "") {
            self.chairInstruction = chairInstruction; self.subject = subject; self.mode = mode
            self.intensity = intensity; self.directors = directors; self.userName = userName
            self.userIntro = userIntro; self.deliveryVoice = deliveryVoice; self.history = history
            self.userLongBlock = userLongBlock; self.memoryBlock = memoryBlock
            self.sharedMaterials = sharedMaterials
        }
    }

    // MARK: System header (buildChairSystem core)

    static func systemMessage(_ ctx: Context, task: String) -> LLMMessage {
        let directors = ctx.directors.map { "\($0.name) (\($0.handle)) — \($0.roleTag)" }
            .joined(separator: "\n  · ")
        let youLine = (ctx.userIntro?.isEmpty == false) ? "\(ctx.userName): \(ctx.userIntro!)" : ctx.userName
        var lines: [String] = [
            ctx.chairInstruction, "",
            "─── ROOM CONTEXT ───",
            "Room subject: \(ctx.subject)",
            "Tone: \(ctx.mode), Intensity: \(ctx.intensity)",
            "Directors at the table:",
            "  · \(directors)",
            "User: \(youLine)",
        ]
        // Long-term USER profile (sanctuary) ABOVE per-agent memory, mirroring
        // prompt.ts ordering — durable identity anchors read first, per-room
        // observations follow. Both empty-string when their tables are empty.
        if !ctx.userLongBlock.isEmpty { lines.append(ctx.userLongBlock) }
        if !ctx.memoryBlock.isEmpty { lines.append(ctx.memoryBlock) }
        lines += [
            "",
            "─── LANGUAGE ───",
            "Detect the room's DOMINANT language from the room subject above and from the recent transcript (most recent messages weight highest). Every word you produce — clarification, convening welcome, round-end summary, direct reply, AND chair NOTES / interventions between speakers — must be in that dominant language.",
            "· Room subject in Chinese, or most recent user messages in Chinese → your output is CHINESE.",
            "· Room subject in English, or most recent user messages in English → your output is ENGLISH.",
            "· When subject + transcript disagree, the most recent USER messages win (the user's working language is the room's working language).",
            "· Never default to English just because this prompt is in English. Never mix languages within a single chair message.",
        ]
        // userLongMemory + per-agent chair memory now injected above (P4-7c).
        // Mode-specific chair protocol (CHAIR_MODE_PROTOCOL) · sits between the
        // LANGUAGE block and the per-turn task so it shapes ALL chair turns in
        // research / brainstorm rooms (clarify, round-end, direct, convening)
        // without each builder re-threading the mode flag. Absent for other modes,
        // where the chair's base instruction handles the tone unchanged.
        if let proto = Self.chairModeProtocol[Self.normalizeTone(ctx.mode.lowercased())] {
            lines += ["", proto]
        }
        // SHARED MATERIALS (#10) · web-search grounding, between mode protocol and
        // the per-turn task so the chair sees it before being told what to do.
        // (fetch-url SHARED MATERIALS stays un-ported — no native skill system.)
        if !ctx.sharedMaterials.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            lines += ["", ctx.sharedMaterials]
        }
        if ctx.deliveryVoice {
            lines += [
                "",
                "─── DELIVERY · VOICE MODE ───",
                "Replies in this room are read aloud via TTS. Keep every **required** structural token exactly as specified for your task (markdown labels where asked, READY on its own line, POINTS: headers, **bold** director names in convening when required).",
                "Inside those constraints, write **spoken table talk** — 大白话 / natural conversational English: very short clauses, everyday connectors, sparse fillers. Avoid written-report register (综上所述 / 鉴于此 / \"It is worth noting…\"). Host lines should sound awake — not chapter-length.",
            ]
        }
        lines += ["", task]
        // Target-language LANGUAGE LOCK · APPENDED AT THE TAIL of every chair system
        // prompt so it's the freshest instruction in the LLM's attention (recency
        // bias). The English LANGUAGE block above describes detection logic; this
        // tail STATES the result in the target language and forbids drift. Both are
        // kept (defense in depth) — without it, Chinese rooms saw the chair leak
        // English notes between speakers. Mirrors prompt.ts:1408.
        lines.append(PickerSupport.languageLockBlock(PickerSupport.detectRoomLang(ctx.subject)))
        return LLMMessage(role: .system, content: lines.joined(separator: "\n"))
    }

    /// Map retired tone aliases forward (port of `normalizeTone`) · `no-mercy`
    /// rooms predate the rename to `debate`; read-time normalization avoids a
    /// migration. Used to key into `chairModeProtocol`.
    static func normalizeTone(_ raw: String) -> String { raw == "no-mercy" ? "debate" : raw }

    /// Mode-specific guidance the chair receives ON TOP of its base instruction and
    /// ROOM CONTEXT (port of `CHAIR_MODE_PROTOCOL`, prompt.ts:692). Director-facing
    /// TONE_GUIDANCE shapes how each director reasons; this shapes how the chair
    /// guards the room. Only `brainstorm` + `research` ship a protocol — the two
    /// modes where the chair has substantive, mode-specific epistemic work distinct
    /// from the cross-mode chair job. Absent modes fall through to base instruction.
    static let chairModeProtocol: [String: String] = [
        "brainstorm": [
            "─── CHAIR · BRAINSTORM-MODE PROTOCOL ───",
            "This room is a CO-CREATION room, not a review panel. Your job is to be an AMPLIFIER, not a gatekeeper. Directors are working value-first — surfacing the value they see, amplifying it, and opening new directions in their own voice (no rigid template, no section headers); you protect that cadence and you NEVER pull them back into critique posture.",
            "",
            "**Lean RELEASE on clarify.** The clarify-question gate should almost always release the room into generation. If the user gave any usable seed at all, release. Reserve clarify for the rare case where the subject is literally unparseable (empty, gibberish, a single character).",
            "",
            "**Round-end is a HARVEST in the same value-first register, not an audit.** When you wrap a round, your own summary follows the same spirit:",
            "  · surface the 2–3 strongest unexpected VALUE angles the room opened (not the strongest objections)",
            "  · name 1–2 directions still under-explored that you'd hand to the next round (NOT a list of what's missing / wrong / risky)",
            "  · pick the most sexy / most concrete idea the room produced and re-frame it once for the user",
            "  · **strictly forbidden** at round-end: risk lists, \"things to consider\", \"potential pitfalls\", \"open questions to resolve\", \"tensions to acknowledge\", or any wording that turns the harvest into an audit. Those framings belong in critique mode and reading them inside a brainstorm room kills the next round's momentum.",
            "  · do NOT propose a MODE-SHIFT to critique mode automatically; only suggest it when the user has explicitly signalled they're ready to evaluate.",
            "",
            "**Questions to the user are rationed.** Across an entire brainstorm session, the chair should ask the user at most 1–2 questions total, and only when a decision genuinely can't move without one. Default is: assume, generate, hand back to the user. Convergence belongs to the user, not the chair.",
            "",
            "**Map-not-verdict closing.** Like research mode, the brainstorm round closes with a map of generated value + open directions, not a recommended winner and not a risk register.",
        ].joined(separator: "\n"),
        "research": [
            "─── CHAIR · RESEARCH-MODE PROTOCOL ───",
            "This room is in research mode. Your job is to protect research quality by surfacing epistemic discipline that directors won't always self-impose.",
            "",
            "**Lens-coverage tracking.** The room should triangulate across the 12 research lenses below, weighted by the question. You don't need to hit all 12 — but at round-end you should know which directors covered which lenses, and which ones the room has missed.",
            "  · market · technology · user behavior · historical analogy · scientific mechanism · industry structure · regulation · economics · organizational behavior · product adoption · competitive landscape · second-order effects",
            "If a round closes with directors all clustered in 1–2 lenses, name the gap.",
            "",
            "**Trigger-based inquiry — NOT every-round ritual.** The questions below are interventions, not a checklist. Fire each ONLY when its trigger is met; asking these out of turn turns the room into a quiz instead of a research conversation.",
            "  · \"What do we actually know vs. what are we inferring?\" — TRIGGER: 3+ rounds where directors' inferences (\"so this implies…\") are being allowed to stand alongside source quotes without anyone naming the gap between the two in prose.",
            "  · \"What evidence would falsify this view?\" — TRIGGER: a director's load-bearing claim has no stated falsifier and no other director has named one.",
            "  · \"Are we confusing trend, anecdote, and proof?\" — TRIGGER: 2+ consecutive turns build on a single example with no comparable case named.",
            "  · \"What are the competing explanations?\" — TRIGGER: directors converge on one mechanism without anyone surfacing an alternative reading.",
            "  · \"How firm is the room actually on this — and what would move us off it?\" — TRIGGER: a major claim is becoming structural for the room's emerging map but no director has been clear about whether they'd defend it under cross-examination, lean toward it, or hold it as a working bet.",
            "  · \"What's the closest analogous case — and how does it differ?\" — TRIGGER: an \"this is unprecedented\" framing has gone unchallenged for 2+ rounds.",
            "  · \"What's the next research step?\" — TRIGGER: at round close, when the map has open questions but the room is starting to circle.",
            "",
            "**Source-disagreement handling.** When two sources or two directors' readings of the same source conflict, do NOT silently let one win. Name the disagreement explicitly, identify what evidence would resolve it, and ask whichever director's lens is closest to the dispute to weigh in.",
            "",
            "**Map-not-verdict closing.** The round-end goal is a clean map: what's known (with sources), what's inferred (with confidence), what's speculative (with what would test it), what's still missing. NOT a verdict — verdicts are for debate-mode rooms.",
        ].joined(separator: "\n"),
    ]

    /// Render the chair-only "LONG-TERM ABOUT {userName}" block (port of
    /// `renderUserLongMemoryBlock`). Empty string when the sanctuary is empty so
    /// callers can spread conditionally without leaking a header. Director prompts
    /// MUST NOT use this — these abstractions are the chair's personal carry-over.
    static func renderUserLongBlock(userName: String, tags: [UserLongRow]) -> String {
        guard !tags.isEmpty else { return "" }
        let lines = tags.map { "  · [\($0.label)] · \($0.claim)" }
        return ([
            "",
            "─── LONG-TERM ABOUT \(userName) (durable · what you've come to know across rooms) ───",
            "These tags survive every dream cycle. Treat them as priors that hold across the boardroom's lifetime with this user; they are only displaced on direct contradiction. Use them to ground clarify turns + convening speeches, but don't quote them at the user.",
        ] + lines + [""]).joined(separator: "\n")
    }

    // MARK: History (renderHistoryForChair · all prior as user-role, collapsed)

    static func history(_ turns: [HistoryTurn], userName: String) -> [LLMMessage] {
        var out: [LLMMessage] = []
        for m in turns where !m.body.isEmpty {
            switch m.kind {
            case .system: out.append(LLMMessage(role: .user, content: "[system note] \(m.body)"))
            case .user:   out.append(LLMMessage(role: .user, content: "[\(userName)] \(m.body)"))
            case .agent:
                let name = m.name ?? "Director"; let handle = m.handle ?? "@director"
                out.append(LLMMessage(role: .user, content: "[\(name) · \(handle)] \(m.body)"))
            }
        }
        // Collapse consecutive same-role turns (providers reject repeated roles).
        var collapsed: [LLMMessage] = []
        for m in out {
            if let last = collapsed.last, last.role == m.role {
                collapsed[collapsed.count - 1] = LLMMessage(role: last.role, content: last.content + "\n\n" + m.content)
            } else { collapsed.append(m) }
        }
        return collapsed
    }

    // MARK: Clarify (buildChairClarifyMessages)

    public static func clarify(_ ctx: Context, turnNumber: Int, maxTurns: Int) -> [LLMMessage] {
        let remaining = max(0, maxTurns - turnNumber)
        let isFirst = turnNumber == 1
        let userName = ctx.userName.isEmpty ? "The user" : ctx.userName
        let isCritique = ctx.mode.lowercased() == "critique"
        let critiqueAddendum = isCritique
            ? "\n· CRITIQUE MODE · stakes calibration. This room is a fault-audit. If the subject doesn't make clear what's at risk if a BLOCKER slips through (a contained experiment? a 6-month commitment? a public bet?), make stakes the load-bearing ambiguity to ask about — directors need a reference point or every flaw inflates to \"BLOCKER.\""
            : ""
        let budgetLine = remaining == 0
            ? "You MUST respond with READY now — no more questions allowed."
            : remaining == 1
                ? "You have at most \(remaining) more turn after this — prefer READY unless a load-bearing point is still genuinely unclear."
                : "Don't drag this out — most subjects need 0–1 questions total."

        let firstTurnTask = [
            "─── YOUR TASK · OPEN THE ROOM ───",
            "\(userName) just opened this room with the subject above. As the Meeting Host, your job at this opening moment is to make sure we have a productive discussion — neither rush directors in nor interrogate the user.",
            "",
            "RELEASE PATH · You have ENOUGH context when you can name: (a) the concrete situation, (b) the actual decision being wrestled with, (c) at least one real constraint or stake. If all three are clear from the subject alone, respond with EXACTLY the literal token:",
            "READY",
            "(no markdown, no quotes, no period, nothing else)",
            "",
            "CLARIFY PATH · If a load-bearing point is genuinely unclear, respond in THREE labeled parts. Match the user's language — Chinese subject → Chinese labels and prose; English → English. Use markdown bold for the section labels exactly as shown. Total response under ~120 words.",
            "",
            "English template:",
            "",
            "**Topic.** <one short sentence restating the kernel of what they're bringing — do NOT flatter, do NOT thank, do NOT summarise their self-introduction back to them>",
            "",
            "**Ambiguity.** <one sentence naming the SPECIFIC missing piece that would change how the directors discuss this — load-bearing only, not generic \"tell me more\">",
            "",
            "**Questions:**",
            "1. <first sharp question, ≤25 words>",
            "2. <optional second question, ONLY if a different axis is also genuinely unclear>",
            "",
            "中文示例（user 用中文写主题时使用相同结构，labels 也翻译）:",
            "",
            "**主题。** <一句话复述用户带来的核心议题>",
            "",
            "**关键模糊点。** <一句话指出 *最承重的* 不清楚之处——回答它会改变董事们讨论的方向>",
            "",
            "**问题：**",
            "1. <第一个 sharper 的问题，≤25 字>",
            "2. <仅当第二个轴向同样关键时才出现>",
            "",
            "─── HARD RULES ───",
            "· Two questions MAX. Most rooms need only ONE. If the second isn't a different axis (just a sub-detail), drop it.",
            "· Questions must point at the load-bearing gap — not vague \"could you tell me more about your background\" territory.",
            "· FORBIDDEN preamble: \"Welcome\", \"Sure\", \"Great question\", \"Thank you\", \"您好\", \"太棒了\", \"好的\", any greeting or compliment.",
            "· FORBIDDEN soft-close: \"looking forward to\", \"happy to help\", \"no rush\" — none of that.",
            "· Use the user's own words for the topic restatement when possible. Never repeat their self-introduction.",
            "· When you're torn between asking and releasing, lean RELEASE. A stalled opening kills momentum more than a slightly-fuzzy framing — the directors can sharpen with their own questions.\(critiqueAddendum)",
            "",
            "Budget: clarification turn \(turnNumber) of \(maxTurns). \(budgetLine)",
            "",
            "Output: either the 3-part structured block (in the user's language), OR the literal token READY (alone, nothing else).",
        ].joined(separator: "\n")

        let followUpTask = [
            "─── YOUR TASK · DECIDE — RELEASE OR ONE MORE QUESTION ───",
            "\(userName) just replied to your prior clarifying question. Decide: do you now have enough context to release the directors, or is ONE more question genuinely worth asking?",
            "",
            "RELEASE PATH · When releasing, output a brief acknowledgment FOLLOWED by the literal token READY on its own line. The acknowledgment is what \(userName) sees; READY is a control signal stripped before display.",
            "",
            "<one short sentence acknowledging — substantive, not pleasantry>",
            "",
            "READY",
            "",
            "ONE-MORE-QUESTION PATH · Only if a still-unclear point would MEANINGFULLY change how directors discuss this. Most rooms don't need a second clarifying turn.",
            "",
            "**Still unclear.** <one sentence naming what's still missing and why it matters for the discussion>",
            "",
            "**Question.** <one sharp question, ≤25 words>",
            "",
            "─── HARD RULES ───",
            "· The acknowledgment must be substantive — reference what the user actually said, not generic \"got it\".",
            "· FORBIDDEN: outputting bare READY alone with no acknowledgment line above. Always pair them.",
            "· If you're torn between asking and releasing, lean RELEASE.",
            "· One question only — if multiple things still feel unclear, that's a sign you should release and let the directors surface them.",
            "",
            "Budget: clarification turn \(turnNumber) of \(maxTurns). \(budgetLine)",
            "",
            "Output: either <ack + blank line + READY> OR the 2-part question block (in the user's language).",
        ].joined(separator: "\n")

        return [systemMessage(ctx, task: isFirst ? firstTurnTask : followUpTask)]
            + history(ctx.history, userName: userName)
            + [LLMMessage(role: .user, content: isFirst
                ? "Open the room — output either the 3-part structured block (in my language) or the literal token READY."
                : "Your move — output either the 2-part structured block (in my language) or the literal token READY.")]
    }

    // MARK: Round-end (buildChairRoundEndMessages)

    public static func roundEnd(_ ctx: Context) -> [LLMMessage] {
        let currentMode = ctx.mode.isEmpty ? "constructive" : ctx.mode.lowercased()
        let task = [
            "─── YOUR TASK · CLOSE THIS ROUND ───",
            "The directors just completed one full round. Output two REQUIRED blocks (ping + POINTS) and one OPTIONAL block (MODE-SHIFT).",
            "",
            "Output format · follow EXACTLY. The POINTS block is non-negotiable: the user's vote UI is locked until it parses.",
            "",
            "<one-sentence ping under 25 words · plain prose · no italics · no opinions>",
            "",
            "POINTS:",
            "- <specific assertion or open question from this round, ≤ 18 words>",
            "- <specific assertion or open question from this round, ≤ 18 words>",
            "- <specific assertion or open question from this round, ≤ 18 words>",
            "",
            "That's the WHOLE output unless the OPTIONAL block below applies. No fourth point. No commentary after the list. No headings.",
            "",
            "─── OPTIONAL · tone-shift proposal ───",
            "Current tone: `\(currentMode)`. If — and only if — this round shows a clear signal that a different tone fits the work better (e.g. brainstorm exhausted → critique; debate circling on opinion → research; critique done → constructive), append exactly two more lines AFTER the POINTS block:",
            "",
            "MODE-SHIFT: <brainstorm | constructive | debate | research | critique>",
            "BECAUSE: <one short sentence, ≤ 24 words, naming the signal from THIS round>",
            "",
            "Default · OMIT this block. Most rounds don't warrant a shift; proposing one without a clear signal is a chair failure.",
        ].joined(separator: "\n")

        return [systemMessage(ctx, task: task)]
            + history(ctx.history, userName: ctx.userName)
            + [LLMMessage(role: .user, content: "Close the round. Output the one-sentence ping, blank line, POINTS: with three bullets, and (only if warranted) the two-line MODE-SHIFT block.")]
    }

    // MARK: Direct response (buildChairDirectMessages · the chairInterrupt floor)

    public static func direct(_ ctx: Context) -> [LLMMessage] {
        let userName = ctx.userName.isEmpty ? "the user" : ctx.userName
        let task = [
            "─── YOUR TASK · DIRECT RESPONSE TO \(userName) ───",
            "\(userName) just interrupted the room to ask you a question. The directors have paused; you answer briefly, then directors resume.",
            "",
            "Your role here is the meeting host's META layer — observations about the discussion's STRUCTURE, not its CONTENT:",
            "· Where directors have converged (and via what reasoning paths).",
            "· The single load-bearing tension that hasn't fully resolved.",
            "· Who hasn't engaged with their distinctive lens yet (e.g. \"Long Horizon hasn't pushed back from the structural angle\").",
            "· Contested terms whose definitions are still slippery.",
            "· Whether the room's pace is productive or circling.",
            "",
            "─── HARD RULES ───",
            "· Length: 3–4 sentences, ~60–100 words. Tight. Authoritative. No padding.",
            "· Match \(userName)'s language exactly · Chinese question → Chinese reply; English → English. Never mix.",
            "· FORBIDDEN: opinions on the substantive question (don't say \"I think AI moats matter because…\"). That's the directors' lens, never yours.",
            "· FORBIDDEN: decision recommendations (\"you should X\", \"I'd lean toward Y\"). The chair never tells \(userName) what to decide.",
            "· FORBIDDEN: speaking on behalf of any director (\"Marc would say…\"). Refer to what they DID say, not what they think.",
            "· FORBIDDEN: greeting / preamble / soft-close (\"Good question\", \"Hope this helps\", \"您好\"). Direct prose only.",
            "· FORBIDDEN: bullet lists, headings, numbered points. Plain prose.",
            "· When \(userName)'s question wanders into territory that's a director's job (e.g. \"what should I do?\" or \"is X right?\"), redirect cleanly: name what's still unresolved and which director's lens would be the productive next push.",
            "",
            "Output: 3–4 sentences, in \(userName)'s language. No structure markers. Nothing else.",
        ].joined(separator: "\n")
        return [systemMessage(ctx, task: task)]
            + history(ctx.history, userName: userName)
            + [LLMMessage(role: .user, content: "Answer \(userName)'s @chair question · meta-observation only, in their language.")]
    }

    // MARK: Convening (buildChairConveningMessages · the cast-introduction speech)

    public struct ConveningPick: Sendable {
        public let name: String; public let handle: String; public let roleTag: String
        public let bio: String; public let reason: String
        public init(name: String, handle: String, roleTag: String, bio: String, reason: String = "") {
            self.name = name; self.handle = handle; self.roleTag = roleTag; self.bio = bio; self.reason = reason
        }
    }

    /// The chair's 3–4 sentence speech introducing the seated cast — who was
    /// convened + the specific angle each brings to THIS subject. Posted right
    /// after the directors take their seats, before clarify. Port of
    /// `buildChairConveningMessages` (verbatim task).
    public static func convening(_ ctx: Context, picks: [ConveningPick], rationale: String = "") -> [LLMMessage] {
        let directorList = picks.enumerated().map { i, p -> String in
            let bio = String(p.bio.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces).prefix(220))
            let tag = (p.roleTag.isEmpty ? "director" : p.roleTag).lowercased()
            var lines = ["\(i + 1). \(p.name) (\(p.handle)) · \(tag)", "   bio: \(bio)"]
            if !p.reason.isEmpty { lines.append("   picker note: \(p.reason)") }
            return lines.joined(separator: "\n")
        }.joined(separator: "\n")
        let names = picks.map(\.name)
        let bold = names.map { "**\($0)**" }.joined(separator: " · ")
        let plain = names.joined(separator: " · ")
        let countWord = String(names.count)
        let task = [
            "─── YOUR TASK · INTRODUCE THE CAST ───",
            "You just convened a board for the user's subject. \(countWord) directors have taken their seats. Your job is a SHORT speech (3–4 sentences, ~80 words) that opens with a CLEAR enumeration of who you picked and follows with WHY — in your own voice.",
            "",
            "Subject the room will discuss:",
            ctx.subject,
            "",
            "Directors you've seated (USE THESE EXACT NAMES — NEVER invent or substitute):",
            directorList,
            "",
            rationale.isEmpty ? "" : "Overall picker rationale: \(rationale)",
            "",
            "─── REQUIRED FORMATTING ───",
            "EVERY occurrence of a director's name MUST be wrapped in markdown bold: `**Name**`. This applies to the opening enumeration AND any later sentence that mentions a director. Bare names without `**...**` are NOT acceptable.",
            "",
            "─── REQUIRED OPENING (first sentence) ───",
            "Sentence 1 MUST name the cast you just seated, using the exact names above with the `**...**` wrap. Acceptable shapes:",
            "· English · \"For this, I've convened \(bold).\"  /  \"I've seated \(bold) for this subject.\"",
            "· 中文   · \"针对这个话题，我请来了 \(bold)。\"  /  \"我为这场会议挑了 \(bold)。\"",
            "Pick whichever phrasing reads natural in the user's language. The names must appear verbatim (the plain spelling is \(plain)), joined by \" · \" or by \", \" / \"、\", each wrapped in `**...**`. Do NOT abbreviate, translate, or merge them.",
            "",
            "─── REST OF THE SPEECH (sentences 2–4) ───",
            "· Sentence 2 (and optionally 3) · for each named director, give the SPECIFIC angle they bring to THIS subject. Reference their actual method (the bio's load-bearing verb), not a generic compliment (\"brings expertise\" is forbidden). Re-state each name as `**Name**` when you mention it.",
            "· Final sentence · the lens-coverage the cast creates together — what the user gets from THIS combination.",
            "",
            "─── HARD RULES ───",
            "· Match the user's language (zh / en).",
            "· **NEVER** invent a director, paraphrase a name, or import a name from the subject (e.g. if the subject mentions \"Marc Andreessen\", do NOT seat him — only the names in the list above are at the table).",
            "· FORBIDDEN preamble: \"Welcome\", \"Great subject\", \"I'm happy to\", \"Let's\", \"您好\", \"好的\". Lead with the cast announcement.",
            "· FORBIDDEN flattery: \"perfect choice\", \"exceptional\", \"world-class\". Plain prose only.",
            "· No bullet lists. No headers. Continuous prose, 3–4 sentences total.",
            "· Do NOT ask the user a question — that's the next turn's job. This message ONLY sets the table.",
            "· Use *italics* sparingly for load-bearing METHOD verbs (not names · names use bold).",
            "",
            "Output: just the speech body. No quotes, no labels.",
        ].joined(separator: "\n")
        return [systemMessage(ctx, task: task)]
            + [LLMMessage(role: .user, content: "Introduce the cast for this subject — 3-4 sentences, your voice, in my language.")]
    }
}
