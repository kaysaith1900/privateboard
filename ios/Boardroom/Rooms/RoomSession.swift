import Foundation
import Observation
import BoardroomCore

/// Per-room controller · the Swift port of the live half of `voice-room-shell.js`.
/// Owns the SSE stream, the transcript, the rolling caption, and the native
/// `VoicePlayer`. `@MainActor` so all UI-facing state mutates on the main actor;
/// the SSE events are consumed in order via the client's `AsyncStream`.
@MainActor
@Observable
final class RoomSession {
    struct Line: Identifiable, Hashable {
        let id: String
        let name: String
        var text: String              // var · streams in via upsertStreamingLine
        let isUser: Bool
        var round: Int = 1            // which discussion round this line belongs to (for the round divider)
        var role: String? = nil       // director role tag (byline)
        var model: String? = nil      // modelV powering the turn (byline)
        var time: String? = nil       // HH:mm the turn landed (byline)
        var avatarPath: String? = nil // portrait (data:/url) shown left of the byline (desktop parity)
        var isChair: Bool = false     // chair/moderator turn → rendered as a left bubble, not full-width prose
        // Web search · chair tool-use card (isToolUse) renders a full-width WEB SEARCH
        // card; a director line carrying `sources` renders a "🔍 N sources" badge.
        var isToolUse: Bool = false
        var searchQuery: String? = nil
        var sources: [SearchSource]? = nil
        // Message kind ("clarify" | "convening" | "intervention" | "chair-direct" | …)
        // so the chair harness messages render with their own style. `isThinking` ·
        // a pre-token loading row (TypingDots in place of the body) — desktop parity.
        var kind: String? = nil
        var isThinking: Bool = false
    }

    let room: Room
    private let api: any RoomBackend

    // UI-observed state
    var transcript: [Line] = []
    var captionKicker = ""
    var captionText = ""
    var captionHidden = true
    var captionThinking = false       // caption "···" placeholder (display only; the SFX is driven separately)
    var captionSentenceKey = ""       // current spoken sentence (NOT the revealed prefix) · drives the page cross-fade so char-by-char karaoke doesn't flicker
    var speakingMessageId: String?    // transcript row whose TTS clip is playing now · drives the in-bubble karaoke highlight (live + replay)
    // Chair "thinking" placeholder · fills the empty gap at room creation (and on
    // continue) before the first turn streams. Voice rooms show it on the stage +
    // caption; text rooms render a chair thinking bubble at the foot of the chat.
    var chairThinking = false
    var chairThinkingName = ""
    var chairThinkingAvatar: String?
    var roomTitle: String?            // AI-distilled title (in-room header); list keeps the raw subject
    var status: RoomStatus
    var paused = false
    var roundNum = 1
    var roomMode: String               // live tone · drives the 3D floor + future turns (editable in room settings)
    var roomIntensity: String          // live intensity · calm / sharp / terse
    var deliveryMode: String           // "voice" | "text" · text = no TTS (editable in room settings)
    var members: [Member] = []         // cast rail (chair + directors + you)
    var awaitingContinue = false       // a round ended · gates input (the round-end sheet owns the bottom)

    // Round-end / vote sheet · the Swift port of the web's round-end card +
    // key-point vote panel (voice-room-shell.js renderRoundEnd / renderVote).
    enum RoundEndPhase { case prompt, vote }
    struct KeyPoint: Identifiable, Hashable { let id: String; var body: String; var position: Int; var vote: String? }
    struct ModeShift: Hashable { let to: String; let because: String }
    var roundEndActive = false         // the bottom sheet is visible (dismissible → re-open pill while awaitingContinue)
    var roundEndPhase: RoundEndPhase = .prompt
    var roundEndRec: String?           // chair's recommendation · "end" | "continue" | nil → highlights a button
    var roundEndFormal = false         // formal round-end (already voted) → drop the Open-vote button
    var roundKeyPoints: [KeyPoint] = []
    var roundModeShift: ModeShift?
    var roundVoteResolved = false      // the round-ended event landed (key points final) → skeleton vs degraded
    @ObservationIgnored private var roundPromptRec: [String: String?] = [:]   // round-prompt msgId → recommendation, raised on its message-final

    var playRate: Double = 1           // playback speed cycler
    var replaying = false              // adjourned voice replay in progress
    private(set) var connecting = true

    private struct ReplayBeat { let id: String; let speakerId: String?; let name: String; let text: String; let isUser: Bool }
    @ObservationIgnored private var replayBeats: [ReplayBeat] = []
    @ObservationIgnored private let replay = ReplayPlayer()
    @ObservationIgnored private var replayTask: Task<Void, Never>?
    @ObservationIgnored private var replayEpoch = 0
    @ObservationIgnored private var replayCapTimer: Timer?

    private static let rateSteps: [Double] = [1, 1.25, 1.5, 2, 0.75]
    var rateLabel: String { playRate == 1 ? "1×" : (playRate.truncatingRemainder(dividingBy: 1) == 0 ? "\(Int(playRate))×" : "\(playRate)×") }
    func cycleRate() {
        let i = Self.rateSteps.firstIndex(of: playRate) ?? 0
        playRate = Self.rateSteps[(i + 1) % Self.rateSteps.count]
        voice.setRate(Float(playRate))      // live clip
        replay.setRate(Float(playRate))     // adjourned-replay clip
    }

    /// Ordered director ids still to speak THIS round (head = up next), from the
    /// engine's `queue-update`. Drives the voice-room queue sheet. Cleared at
    /// round-end / idle. Pair with `stageSpeakerId` for the current speaker.
    var speakingQueue: [String] = []

    // 3D stage drivers (consumed by StageWebView in voice rooms)
    var stageSpeakerId: String?        // who is on stage
    var stageSpeakerState: String?     // "thinking" | "speaking" | nil
    var audibleSpeakerId: String?      // who is *audible* right now → lip-sync

    // working maps (not observed)
    @ObservationIgnored private var msgBody: [String: String] = [:]
    @ObservationIgnored private var msgAuthor: [String: String] = [:]
    @ObservationIgnored private var msgKind: [String: String?] = [:]   // messageId → meta.kind (harness styling)
    @ObservationIgnored private var seenMessageIds: Set<String> = []   // snapshot ids · drop their replayed events on re-entry
    @ObservationIgnored private var memberName: [String: String] = [:]
    @ObservationIgnored private var chair: Member?          // moderator · not in `members` (directors-only)
    @ObservationIgnored private var activeSpeaker: String?
    @ObservationIgnored private var pendingSpeakerId: String?   // voice · next director pre-warmed behind the current audio (promoted on voice-change)
    @ObservationIgnored private let voice = VoicePlayer()
    @ObservationIgnored private let nowPlaying = NowPlayingController()     // lock-screen transport + room/subtitle metadata
    @ObservationIgnored private var lastNowPlayingSubtitle = ""             // de-dups the per-sentence now-playing push
    @ObservationIgnored private var replayPaused = false                   // lock-screen pause of an in-progress replay clip
    @ObservationIgnored private let thinkingSfx = ThinkingSfx()
    @ObservationIgnored private let keepAlive = SilentKeepAlive()           // holds bg-audio across inter-turn gaps (lock screen)
    @ObservationIgnored private let roomSfx = RoomSfx()                     // gavel / speaker-change / typing tick (desktop parity)
    @ObservationIgnored private var lastSpokenMessageId: String?           // de-dups the per-turn entry cue (gavel/speaker-change)
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var captionTimer: Timer?
    @ObservationIgnored private var thinkingTimeout: Task<Void, Never>?   // clears a stuck chair-thinking placeholder if no turn follows
    @ObservationIgnored private var bridgeTask: Task<Void, Never>?        // debounced inter-turn "thinking" bridge (fills director→director / round gaps)

    var isVoice: Bool { deliveryMode == "voice" }

    // Background mini-player display · the current speaker (else the room title).
    var currentSpeakerName: String {
        if let sid = stageSpeakerId { return name(sid) }
        return roomTitle ?? room.displayName
    }
    var currentSpeakerAvatar: String? { stageSpeakerId.flatMap { memberAvatar($0) } }

    /// Flip voice ↔ text live (room settings). Switching OFF voice stops any
    /// in-flight TTS at once (acking owed turns so the orchestrator advances),
    /// clears the 3D stage, and — via `isVoice` flipping — swaps the room to the
    /// transcript. Future turns arrive text-only (the server stops synthesising).
    func setDeliveryMode(_ mode: String) {
        let m = (mode == "voice") ? "voice" : "text"
        guard deliveryMode != m else { return }
        deliveryMode = m
        if m != "voice" {
            voice.releaseAndReset()
            thinkingSfx.stop()
            stopCaptionTimer()
            captionHidden = true; captionText = ""; captionThinking = false
            stageSpeakerId = nil; stageSpeakerState = nil; audibleSpeakerId = nil; pendingSpeakerId = nil
        }
    }

    /// Ack a turn's voice playback without playing it (text mode) · POSTs
    /// voice-done once per message so the orchestrator's voice-done waiter
    /// releases and the next turn streams. De-duped (many chunks per message).
    @ObservationIgnored private var ackedVoiceText: Set<String> = []
    private func ackVoiceText(_ messageId: String) {
        guard !ackedVoiceText.contains(messageId) else { return }
        ackedVoiceText.insert(messageId)
        Task { await api.voiceDone(room.id, messageId) }
    }

    init(room: Room, api: any RoomBackend) {
        self.room = room
        self.api = api
        self.status = room.bucket
        self.paused = room.bucket == .paused
        self.roomMode = room.mode ?? "constructive"
        self.roomIntensity = room.intensity ?? "sharp"
        self.deliveryMode = room.deliveryMode ?? "voice"
        wireVoice()
    }

    private func wireVoice() {
        voice.onProgress = { [weak self] mid in
            guard let self else { return }
            Task { await self.api.voiceProgress(self.room.id, mid) }
        }
        voice.onDone = { [weak self] mid in
            guard let self else { return }
            Task { await self.api.voiceDone(self.room.id, mid) }
        }
        voice.onChange = { [weak self] in self?.onVoiceChange() }
        nowPlaying.onToggle = { [weak self] in self?.togglePlaybackFromRemote() }
    }

    // MARK: Lock-screen Now Playing

    /// Reflect the room's current voice state on the lock-screen / Control-Center
    /// panel. Cheap + idempotent; called on every state change that the user
    /// would see (speaker swap, sentence swap, pause/resume). Clears the panel
    /// when there's nothing to play (text room, or an adjourned room not replaying).
    private func syncNowPlaying() {
        guard isVoice, status == .live || status == .paused || replaying else {
            nowPlaying.clear(); lastNowPlayingSubtitle = ""; return
        }
        let isPlaying = replaying ? !replayPaused : (status == .live && !paused)
        let title = (roomTitle?.isEmpty == false) ? roomTitle! : room.rawQuery
        let speaker = captionKicker.isEmpty ? (stageSpeakerId.map { name($0) } ?? "") : captionKicker
        let line = captionHidden ? "" : captionText.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitle: String
        if !line.isEmpty {
            subtitle = speaker.isEmpty ? line : "\(speaker)\u{2002}·\u{2002}\(line)"
        } else if !speaker.isEmpty {
            subtitle = "\(speaker)\u{2002}·\u{2002}\(Loc.t("np_thinking"))"
        } else {
            subtitle = Loc.t("np_in_session")
        }
        nowPlaying.update(title: title, subtitle: subtitle, isPlaying: isPlaying)
    }

    /// Lock-screen play/pause · routes to live pause/resume or replay pause.
    private func togglePlaybackFromRemote() {
        if replaying { toggleReplayPause() } else { togglePause() }
    }

    private func toggleReplayPause() {
        guard replaying else { return }
        replayPaused.toggle()
        replay.setPaused(replayPaused)
        if replayPaused { thinkingSfx.stop() }
        audibleSpeakerId = replayPaused ? nil : audibleSpeakerId
        syncNowPlaying()
    }

    // MARK: Lifecycle

    func start() async {
        connecting = true
        if let snap = try? await api.getRoom(room.id) { applySnapshot(snap) }
        connecting = false
        refreshKeepAlive()             // hold bg-audio for the whole live voice session
        openStream()
        // Fill the create-room / first-turn gap · a freshly convened room sits
        // empty for seconds (chair picks the board, then the first director's LLM
        // + TTS spins up). Drop the chair onto the stage / chat in a "thinking"
        // pose right away so the room never opens to a blank screen. The first
        // real `message-appended` replaces it.
        showChairThinkingPlaceholder()
        // The AI room title is written ~1–3s after create (async titler), so the
        // in-room header swaps from the raw subject to the distilled title without
        // needing a reopen. A couple of delayed reads catch it.
        Task { [weak self] in
            for delay in [2.5, 5.0] {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                guard let self else { return }
                if let n = (try? await self.api.getRoom(self.room.id))?.room?.name, !n.isEmpty {
                    self.roomTitle = n
                }
            }
        }
    }

    /// Demo path · sample transcript + cast, no networking (for previewing the
    /// room chrome without a backend).
    func startDemo(members: [Member]) {
        self.members = members
        for m in members { memberName[m.id] = m.name }
        connecting = false
        let dirs = members.filter { $0.roleKind != "moderator" && $0.roleKind != "chair" }
        var lines: [Line] = []
        if let d0 = dirs.first {
            lines.append(Line(id: UUID().uuidString, name: d0.name,
                              text: "Let's start from the one number that actually decides this.", isUser: false,
                              avatarPath: d0.avatarPath))
        }
        lines.append(Line(id: UUID().uuidString, name: "You", text: room.rawQuery, isUser: true))
        if dirs.count > 1 {
            lines.append(Line(id: UUID().uuidString, name: dirs[1].name,
                              text: "I'd push back — we're optimizing for the wrong horizon here.", isUser: false,
                              avatarPath: dirs[1].avatarPath))
        }
        transcript = lines
        replayBeats = lines.map { l in
            ReplayBeat(id: "", speakerId: memberName.first(where: { $0.value == l.name })?.key,
                       name: l.name, text: l.text, isUser: l.isUser)
        }
        if room.bucket == .live, let speaker = dirs.first {
            stageSpeakerId = speaker.id; stageSpeakerState = "speaking"
            captionKicker = speaker.name; captionThinking = false; captionHidden = false
            captionText = "Let's start from the one number that actually decides this."
        }
    }

    func leave() {
        thinkingSfx.stop()
        keepAlive.stop()
        thinkingTimeout?.cancel(); thinkingTimeout = nil; chairThinking = false; cancelBridgeThinking()
        // Ack the in-flight turn so the orchestrator isn't stranded (live voice
        // only); plain reset otherwise.
        if status != .adjourned && isVoice { voice.releaseAndReset() } else { voice.reset() }
        if replaying { stopReplay() }
        streamTask?.cancel(); streamTask = nil   // tears down the underlying SSE via onTermination
        captionTimer?.invalidate(); captionTimer = nil
        nowPlaying.clear()                       // drop the lock-screen panel on exit
    }

    private func applySnapshot(_ snap: RoomSnapshot) {
        members = snap.members ?? []
        chair = snap.chair
        if let n = snap.room?.name, !n.isEmpty, n != room.rawQuery { roomTitle = n }   // AI title (≠ raw subject)
        for m in members { memberName[m.id] = m.name }
        if let c = chair { memberName[c.id] = c.name }   // chair speaks (clarify / close) but isn't a member
        // Restore the persisted phase from the engine. A room PAUSED in a prior
        // session (or another client) must reopen paused — never auto-run on entry.
        // Without this the stale rooms-list bucket wins and the room starts itself.
        if let s = snap.room?.status, s != .adjourned {
            status = s
            paused = (s == .paused)
            if isVoice { voice.setPaused(paused) }
        }
        // Every message we render from the snapshot is "already seen" — the live
        // stream replays their events to a fresh subscriber, and re-processing them
        // would re-play the old TTS. handle(_:) drops events for these ids.
        seenMessageIds = Set((snap.messages ?? []).compactMap { msg -> String? in
            let body = (msg.body ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !body.isEmpty, msg.authorKind != "system", let id = msg.id else { return nil }
            return id
        })
        transcript = (snap.messages ?? []).compactMap { msg in
            let body = (msg.body ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !body.isEmpty, msg.authorKind != "system" else { return nil }
            let isUser = msg.authorKind == "user"
            if let r = msg.roundNum { roundNum = max(roundNum, r) }
            // Web search · the chair tool-use card reconstructs as a WEB SEARCH card.
            if msg.kind == "tool-use" {
                return Line(id: msg.id ?? UUID().uuidString, name: name(msg.authorId), text: body,
                            isUser: false, round: msg.roundNum ?? 1, isChair: true,
                            isToolUse: true, searchQuery: msg.searchQuery, sources: msg.sources)
            }
            return Line(id: msg.id ?? UUID().uuidString,
                        name: isUser ? "You" : name(msg.authorId),
                        text: body, isUser: isUser, round: msg.roundNum ?? 1,
                        role: isUser ? nil : memberRole(msg.authorId),
                        model: isUser ? nil : memberModel(msg.authorId),
                        time: Self.timeFmt(msg.createdAt?.date),
                        avatarPath: isUser ? nil : memberAvatar(msg.authorId),
                        isChair: !isUser && isChair(msg.authorId),
                        searchQuery: msg.searchQuery,            // director sources badge
                        sources: msg.sources,
                        kind: isUser ? nil : msg.kind)           // harness styling on reload
        }
        // Opening-query bubble · the native engine deliberately keeps the opening
        // question in `rooms.subject`, NOT as a message row (RoomActor branches on
        // "no user message yet · query lives in rooms.subject"). So synthesize the
        // user's first bubble here, matching desktop where it IS the first message.
        // Guard: only when the snapshot doesn't already lead with a user message
        // (server mode DOES persist it → don't double it).
        let openingQuery = room.rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        if !openingQuery.isEmpty, transcript.first?.isUser != true {
            transcript.insert(Line(id: "opening", name: "You", text: openingQuery, isUser: true, round: 1), at: 0)
        }
        // Replay beats keep the messageId + speaker so we can fetch each clip. Skip
        // tool-use cards (no audio to replay).
        replayBeats = (snap.messages ?? []).compactMap { msg in
            let body = (msg.body ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !body.isEmpty, msg.authorKind != "system", msg.kind != "tool-use" else { return nil }
            let isUser = msg.authorKind == "user"
            return ReplayBeat(id: msg.id ?? "", speakerId: msg.authorId,
                              name: isUser ? "You" : name(msg.authorId),
                              text: body, isUser: isUser)
        }
        // Re-entered a room that wrapped a round and is still awaiting · restore the
        // AWAITING state but show only the dismissible "round wrapped · review" PILL,
        // NOT the full sheet. Auto-popping the sheet on every cold re-entry / unlock
        // (when the user already continued without voting) felt buggy; the live
        // round-ended event still pops it in-session. Tap the pill to vote / continue.
        if snap.room?.awaitingContinue == true && status != .adjourned {
            roundVoteResolved = true
            roundEndRec = nil
            roundEndFormal = true
            roundEndPhase = .vote
            awaitingContinue = true
            roundEndActive = false
        }
    }

    private func name(_ id: String?) -> String { id.flatMap { memberName[$0] } ?? id ?? "—" }

    // MARK: SSE

    private func openStream() {
        guard status != .adjourned else { return }
        streamTask = Task { [weak self] in
            guard let self else { return }
            for await ev in self.api.roomEvents(self.room.id) {
                if Task.isCancelled { break }
                self.handle(ev)
            }
        }
    }

    private func handle(_ ev: RoomEvent) {
        guard status != .adjourned else { return }
        // Re-entry replay guard · the EventBus replays a room's buffered events to a
        // fresh subscriber (it has no Last-Event-ID, since the snapshot carries the
        // history). For messages ALREADY loaded from the snapshot, re-processing
        // their events would re-render the bubble and — worse — RE-PLAY the old TTS
        // audio (the "a director auto-starts speaking when I reopen a paused room"
        // bug). Drop replayed events for already-seen messages; genuinely new turns
        // (new ids) flow through untouched.
        if let mid = ev.messageId, seenMessageIds.contains(mid) { return }
        switch ev {
        case .messageAppended(let d): onAppended(d)
        case .messageToken(let d): onToken(d)
        case .messageFinal(let d): onFinal(d)
        case .voiceChunk(let d):
            // Voice turned OFF mid-turn · the in-flight turn's chunks keep arriving;
            // drop the audio (else they'd re-start playback after we stopped it) and
            // ack the message so the orchestrator advances instead of parking on its
            // voice-done waiter.
            guard isVoice else { ackVoiceText(d.messageId); break }
            if let b = d.audioBase64 {
                voice.enqueueChunk(messageId: d.messageId, base64: b, mime: d.mimeType, seq: d.seq, seg: d.seg, text: d.text, author: activeSpeaker)
            }
        case .voiceFinal(let d):
            guard isVoice else { ackVoiceText(d.messageId); break }
            voice.voiceFinal(messageId: d.messageId, author: activeSpeaker)
        case .voiceError(let d):
            // TTS failed (billing / no key / upstream). Treat like voice-final so
            // the turn advances (plays whatever arrived, else finishes + acks)
            // instead of stranding the room in silence.
            guard isVoice else { ackVoiceText(d.messageId); break }
            voice.voiceFinal(messageId: d.messageId, author: activeSpeaker)
        case .configEvent(let d): onConfig(d)
        case .messageError(_, let kind, let provider):
            setThinkingSfx(false)
            clearChairThinking()
            clearStage()
            // A classified turn failure → raise the matching user prompt (debounced
            // per kind in AppNotice). `upstream`/nil keeps the in-bubble ⚠️ hint only.
            switch kind {
            case "billing":
                AppNotice.post(kind: .billing, provider: provider,
                               message: Loc.t("m_llm_billing_msg", ["provider": provider ?? Loc.t("m_provider_generic")]),
                               ctaURL: AppNotice.billingURL(forProvider: provider))
            case "auth":
                AppNotice.post(kind: .auth, message: Loc.t("m_auth_msg"))
            case "network":
                AppNotice.post(kind: .network, message: Loc.t("m_net_msg"))
            default: break
            }
        case .messageRemoved(let messageId, _):
            // chairInterrupt dropped an aborted partial director bubble — remove it
            // from the transcript so no truncated message lingers.
            transcript.removeAll { $0.id == messageId }
            setThinkingSfx(false)
            clearStage()
        case .unknown:
            break
        }
    }

    private func onAppended(_ d: MessageAppended) {
        if let r = d.roundNum, r > roundNum { roundNum = r }
        if d.authorKind == "user" { appendLine(authorId: nil, text: d.body ?? "", isUser: true); return }
        if d.authorKind == "system" || d.meta?.kind == "round-open" { return }
        // Chair web-search tool-use CARD · a silent transcript artifact (no speaker /
        // stage / caption / TTS) rendered as a "WEB SEARCH" card. Append + bail.
        if d.meta?.kind == "tool-use" {
            transcript.append(Line(id: d.messageId, name: name(d.authorId), text: d.body ?? "",
                                   isUser: false, round: roundNum, isChair: true,
                                   isToolUse: true, searchQuery: d.meta?.searchQuery, sources: d.meta?.sources))
            return
        }
        // A real turn is claiming the floor → drop the boot/continue chair-thinking
        // placeholder (the rest of this fn sets the proper stage / caption state, so
        // we clear just the flag + safety timer here — no clearStage flicker).
        chairThinking = false; thinkingTimeout?.cancel(); thinkingTimeout = nil; cancelBridgeThinking()
        // Light round-prompt · the common round wrap (cap reached). The chair's
        // text streams + appends as a normal bubble; we raise the round-end sheet
        // once it finalises (in voice rooms, after the chair has spoken it).
        if d.meta?.kind == "round-prompt" { roundPromptRec[d.messageId] = d.meta?.recommendation?.kind }
        msgAuthor[d.messageId] = d.authorId
        msgBody[d.messageId] = d.body ?? ""
        msgKind[d.messageId] = d.meta?.kind
        activeSpeaker = d.authorId
        // Text room · build the speaker's row NOW (empty + thinking) so a per-speaker
        // loading placeholder (TypingDots) shows BEFORE the first token — desktop
        // parity. The same row fills in on `onToken` (matched by messageId). Voice
        // rooms drive the placeholder via the stage/caption, not the transcript.
        if !isVoice, (d.body ?? "").trimmingCharacters(in: .whitespaces).isEmpty {
            // The chair is stored apart from `members`, so `isChair(authorId)` can miss
            // it — fall back to the chair-only message kinds so the chair's thinking
            // row renders with chair styling (not as a director bubble).
            let chairKinds: Set<String> = ["clarify", "convening", "round-end", "round-prompt", "chair-direct", "intervention"]
            let isC = isChair(d.authorId) || (d.meta?.kind.map(chairKinds.contains) ?? false)
            transcript.append(Line(id: d.messageId, name: name(d.authorId), text: "",
                                   isUser: false, round: roundNum,
                                   role: isC ? memberRole(d.authorId) : memberRole(d.authorId),
                                   model: isC ? nil : memberModel(d.authorId),
                                   time: Self.timeFmt(Date()), avatarPath: memberAvatar(d.authorId),
                                   isChair: isC, kind: d.meta?.kind, isThinking: true))
        }
        // Voice rooms · a turn is appended the moment the orchestrator starts
        // generating it, which can be WHILE the previous director's TTS is still
        // playing (pre-warm). Claiming the stage now would yank the camera +
        // caption onto a "thinking" director before the audible one finishes
        // talking. Only take the stage when nothing is audible (this turn is the
        // audio-queue HEAD); otherwise stash it as the pending speaker and let
        // onVoiceChange promote it once the audio drains. Text rooms have no audio
        // queue → always claim it (the first token is their speaking moment).
        if !isVoice || voice.playingId == nil {
            stageSpeakerId = d.authorId
            stageSpeakerState = "thinking"
            captionKicker = name(d.authorId)
            captionText = ""
            captionThinking = true
            captionHidden = false
            pendingSpeakerId = nil
            setThinkingSfx(true)            // thinking cue · stopped when this turn's audio starts (onVoiceChange)
        } else {
            pendingSpeakerId = d.authorId    // buffered behind the current audio · promoted on voice-change
        }
    }

    private func onToken(_ d: MessageToken) {
        let prev = msgBody[d.messageId] ?? ""
        let body = prev + (d.delta ?? "")
        msgBody[d.messageId] = body
        NSLog("📝RX onToken mid=\(d.messageId) deltaLen=\(d.delta?.count ?? 0) total=\(body.count) isVoice=\(isVoice)")
        roomSfx.tick()                              // keyboard click per token (throttled · desktop `tick()`)
        if activeSpeaker == nil { activeSpeaker = msgAuthor[d.messageId] }
        // TEXT rooms · the first token IS the speaking moment (no audio to sync
        // to) → flip the caption to "speaking" and preview the text live. VOICE
        // rooms · the text only ACCUMULATES here; the caption stays in its
        // "thinking" pose (name + cue, no subtitle text) until THIS turn's audio
        // actually starts — onVoiceChange flips to speaking and tickCaption then
        // reveals the words in sync with the clip. So the subtitle never appears
        // (and the stage never "speaks") before they really speak. This is the
        // exact desktop behaviour (voice-room-shell.js message-token is a no-op
        // for the caption in voice rooms); flooding captionText here on every
        // token was the regression — the subtitle churned all through thinking
        // and showed the wrong sentence before the audio caught up.
        if !isVoice {
            if prev.trimmingCharacters(in: .whitespaces).isEmpty {        // first token
                captionKicker = name(msgAuthor[d.messageId] ?? activeSpeaker)
                captionHidden = false
                captionThinking = false
                stageSpeakerState = "speaking"
            }
            captionText = Caption.currentSentence(body, revealedChars: body.count)
        }
        // Stream the chat bubble in BOTH modes · update (or create) this turn's
        // transcript row live as tokens arrive (the chat/transcript view streams
        // even in voice rooms — this is separate from the on-stage caption band).
        if !body.trimmingCharacters(in: .whitespaces).isEmpty {
            upsertStreamingLine(messageId: d.messageId, authorId: msgAuthor[d.messageId] ?? activeSpeaker, text: body)
        }
    }

    private func onFinal(_ d: MessageFinal) {
        setThinkingSfx(false)                       // web `message-final` · this turn's text is done → cue off
        let body = (msgBody[d.messageId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let author = msgAuthor[d.messageId] ?? activeSpeaker
        // Finalize the streaming bubble in place (it was created/updated by
        // onToken). Fallback: create it now if no tokens ever arrived.
        if !body.isEmpty { upsertStreamingLine(messageId: d.messageId, authorId: author, text: body) }
        // Web search · a director's sources land on finalize → attach to its bubble
        // so the "🔍 N sources" badge appears.
        if let srcs = d.sources, !srcs.isEmpty,
           let i = transcript.firstIndex(where: { $0.id == d.messageId }) {
            transcript[i].sources = srcs
            transcript[i].searchQuery = d.searchQuery
        }
        msgAuthor.removeValue(forKey: d.messageId)
        // Round-prompt finalised → raise the round-end sheet (Continue / Call the
        // vote / Adjourn). In voice rooms onFinal fires when the text is done; the
        // chair's audio plays behind the sheet.
        if let rec = roundPromptRec.removeValue(forKey: d.messageId) {
            raiseRoundEnd(recommendation: rec, formal: false)
        }
        if isVoice {
            voice.markTextFinal(messageId: d.messageId, author: author)
        } else {
            Task { await api.voiceDone(room.id, d.messageId) }            // text room · advance now
        }
    }

    private func onConfig(_ d: ConfigEvent) {
        switch d.kind {
        case "room-paused":  status = .paused; paused = true;  voice.setPaused(true);  refreshAudible(); setThinkingSfx(false); refreshKeepAlive()
        case "room-resumed": status = .live;  paused = false; voice.setPaused(false); refreshAudible(); refreshKeepAlive()   // next appended re-arms the cue
        case "round-ended":
            // Formal round-end · the chair's votable key points are final. Switch
            // the sheet to the vote panel (or raise it if it wasn't up yet).
            captionThinking = false; pendingSpeakerId = nil; speakingQueue = []; setThinkingSfx(false); clearChairThinking()   // round idle · drop the cue + any pre-warm + queue
            if let kps = d.payload?.keyPoints {
                roundKeyPoints = kps.map { KeyPoint(id: $0.id, body: $0.body, position: $0.position ?? 0, vote: $0.vote) }
            }
            if let ms = d.payload?.modeShiftProposal, let to = ms.to, !to.isEmpty {
                roundModeShift = ModeShift(to: to, because: ms.because ?? "")
            }
            roundVoteResolved = true
            // Prefer the engine's round-wrap recommendation (pickRoundWrap) when
            // present; else keep whatever a prior round-prompt set.
            raiseRoundEnd(recommendation: d.payload?.recommendation ?? roundEndRec, formal: true)
        case "member-added":
            // Auto-pick rooms open chair-only; directors are seated AFTER the
            // picker runs and arrive one-by-one as `member-added` config events.
            // Without this the cast rail (and message author-name resolution)
            // never sees the directors — the room looks empty (just chair + you).
            addMember(d.payload?.agentId)
        case "member-removed":
            if let aid = d.payload?.agentId { members.removeAll { $0.id == aid } }
        case "settings-changed":
            // Tone / intensity shifted (room settings on this or another client,
            // or an accepted chair tone-shift). Mirror it so the floor recolors
            // and future-turn copy reflects the change.
            if let to = d.payload?.changes?.mode?.to, !to.isEmpty { roomMode = to }
            if let to = d.payload?.changes?.intensity?.to, !to.isEmpty { roomIntensity = to }
            if let to = d.payload?.changes?.deliveryMode?.to, !to.isEmpty { setDeliveryMode(to) }
        case "queue-update":
            speakingQueue = d.payload?.queue?.map(\.agentId) ?? []
        case "chair-pending":
            // The chair is deciding the next speaker (a 5–8s LLM call that emits NO
            // streaming message) · show the thinking pose + cue right away so the
            // round→chair handoff never sits blank ("卡住了，没有 thinking 占位").
            showChairThinkingPlaceholder()
        default: break
        }
    }

    /// Replace the director cast (room settings · manage cast). The picker hands
    /// us full agents, so byline role/model resolve immediately. The chair is
    /// kept aside (it was never in `members`).
    func setDirectors(_ directors: [Member]) {
        members = directors
        for m in directors { memberName[m.id] = m.name }
    }

    /// Resolve a seated agentId → cast member (fetched lazily), append it to the
    /// rail, and register its name so its messages resolve a real byline.
    private func addMember(_ agentId: String?) {
        guard let aid = agentId, !members.contains(where: { $0.id == aid }) else { return }
        Task { @MainActor [weak self] in
            guard let self, let agent = try? await self.api.getAgent(aid) else { return }
            guard !self.members.contains(where: { $0.id == aid }) else { return }
            self.members.append(Member(id: agent.id, name: agent.name,
                                       avatarPath: agent.avatarPath, roleKind: agent.roleKind))
            self.memberName[aid] = agent.name
        }
    }

    // MARK: Round-end / vote actions (port of voice-room-shell doContinue /
    // doVote / voteKp / doSwitchMode)

    /// Raise (or re-target) the round-end sheet. `formal` drops the Open-vote
    /// button and lands on the vote panel; the light prompt keeps Open-vote.
    private func raiseRoundEnd(recommendation: String?, formal: Bool) {
        roundEndRec = recommendation
        roundEndFormal = formal
        roundEndPhase = formal ? .vote : .prompt
        awaitingContinue = true
        roundEndActive = true
    }

    /// Continue into the next reactive round · POST /continue (resume first if the
    /// user parked it paused, like the web). Tears the sheet down.
    func continueRound() {
        clearRoundEnd()
        let wasPaused = paused
        if wasPaused { paused = false; status = .live; voice.setPaused(false) }
        showChairThinkingPlaceholder()
        Task {
            if wasPaused { try? await api.resumeRoom(room.id) }
            try? await api.continueRoom(room.id)
        }
    }

    /// Optimistic placeholder while the orchestrator spins the next turn up.
    /// Resuming a paused room (or continuing a round) POSTs to the backend and
    /// then waits for the first `message-appended` — which can be SECONDS away
    /// (chair reasoning + LLM generation + TTS synthesis). Without this the 3D
    /// stage sits frozen on the wide establishing shot the whole time, so a tap
    /// on Play reads as unresponsive. Drop the chair onto the stage in a
    /// "thinking" pose right away → the camera closes up + the cue starts at once
    /// as a transition. The real `onAppended` replaces it the moment the turn
    /// lands (same chair → no visible change; a director → a natural cut).
    ///
    /// Guarded on `voice.playingId == nil` · only when NOTHING is audible is this
    /// a genuine "waiting for the next turn" gap. Resuming a clip that was paused
    /// mid-sentence (same session) must continue THAT audio, not flash the chair.
    private func showChairThinkingPlaceholder() {
        guard status == .live, !paused, !awaitingContinue,
              voice.playingId == nil, activeSpeaker == nil else { return }
        // Prefer the NEXT queued director (mid-round director→director gap) so the
        // stage shows who's actually coming up; fall back to the chair (room start /
        // round wrap, where the queue is empty).
        let who: (id: String, name: String, avatar: String?)?
        if let nid = speakingQueue.first, let m = members.first(where: { $0.id == nid }) {
            who = (m.id, m.name, m.avatarPath)
        } else if let chair {
            who = (chair.id, chair.name, chair.avatarPath)
        } else { who = nil }
        guard let w = who else { return }
        chairThinkingName = w.name
        chairThinkingAvatar = w.avatar
        chairThinking = true
        if isVoice {
            stageSpeakerId = w.id
            stageSpeakerState = "thinking"
            captionKicker = w.name
            captionText = ""
            captionThinking = true
            captionHidden = false
            pendingSpeakerId = nil
            setThinkingSfx(true)
        }
        armThinkingTimeout()
    }

    /// Debounced bridge for the gap BETWEEN turns / rounds · when a turn's audio
    /// ends and the next speaker hasn't landed yet (pre-warm still computing, round
    /// switching), show the next speaker "thinking" so the stage never goes blank
    /// ("感觉像卡死了"). Debounced so an instant pre-warm hit doesn't flash it.
    private func armBridgeThinking() {
        bridgeTask?.cancel()
        bridgeTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(450))
            guard let self, !Task.isCancelled else { return }
            if self.voice.playingId == nil, self.activeSpeaker == nil { self.showChairThinkingPlaceholder() }
        }
    }
    private func cancelBridgeThinking() { bridgeTask?.cancel(); bridgeTask = nil }

    /// Safety · a placeholder that never resolves (turn errored upstream, room
    /// went idle) would spin forever. Clear it after a generous wait if no turn
    /// has claimed the floor by then.
    private func armThinkingTimeout() {
        thinkingTimeout?.cancel()
        thinkingTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(25))
            guard let self, !Task.isCancelled else { return }
            if self.activeSpeaker == nil { self.clearChairThinking() }
        }
    }

    /// Drop the chair-thinking placeholder · called when a real turn claims the
    /// floor, or the room leaves the waiting state.
    private func clearChairThinking() {
        thinkingTimeout?.cancel(); thinkingTimeout = nil; cancelBridgeThinking()
        guard chairThinking else { return }
        chairThinking = false
        if isVoice && activeSpeaker == nil {
            captionThinking = false
            setThinkingSfx(false)
            clearStage()
        }
    }

    /// Escalate the light prompt to a formal round-end (desktop "Open vote").
    /// Stay in the sheet on the vote panel; the round-ended event repaints it with
    /// the chair's key points (skeleton until it lands).
    func openVote() {
        roundEndPhase = .vote
        roundVoteResolved = false
        Task {
            if paused {
                try? await api.resumeRoom(room.id)
                paused = false; status = .live; voice.setPaused(false)
            }
            try? await api.roundEnd(room.id, mode: "now")
        }
    }

    /// Vote a key point up/down · optimistic toggle, revert on failure.
    func voteKeyPoint(_ kpId: String, _ requested: String) {
        guard let i = roundKeyPoints.firstIndex(where: { $0.id == kpId }) else { return }
        let prev = roundKeyPoints[i].vote
        let next = prev == requested ? nil : requested
        roundKeyPoints[i].vote = next
        Task {
            do { try await api.voteKeyPoint(room.id, kpId, vote: next) }
            catch {
                if let j = self.roundKeyPoints.firstIndex(where: { $0.id == kpId }) { self.roundKeyPoints[j].vote = prev }
            }
        }
    }

    /// Accept the chair's tone-shift proposal · PATCH the room mode, then continue.
    func switchModeAndContinue(to: String) {
        Task {
            try? await api.updateRoomSettings(room.id, mode: to, intensity: nil, deliveryMode: nil, briefStyle: nil, voteTrigger: nil)
            roomMode = to
            continueRound()
        }
    }

    /// Hide the sheet without acting · the round is still awaiting, so a re-open
    /// pill stays available (mirrors the web's vote dot).
    func dismissRoundEndSheet() { roundEndActive = false }
    /// Re-open the dismissed sheet.
    func reopenRoundEnd() { if awaitingContinue { roundEndActive = true } }

    private func clearRoundEnd() {
        roundEndActive = false
        awaitingContinue = false
        roundKeyPoints = []
        roundModeShift = nil
        roundEndRec = nil
        roundEndFormal = false
        roundVoteResolved = false
        roundEndPhase = .prompt
    }

    // MARK: Adjourned replay (the Swift port of voice-room-shell `replayStep`)

    var canReplay: Bool { status == .adjourned && isVoice && !replayBeats.isEmpty }

    func toggleReplay() { replaying ? stopReplay() : startReplay() }

    func startReplay() {
        guard canReplay, !replaying else { return }
        replaying = true
        replayPaused = false
        replayEpoch += 1
        let epoch = replayEpoch
        refreshKeepAlive()               // hold bg-audio across replay beats too
        syncNowPlaying()                 // show the lock-screen transport for the replay
        replayTask?.cancel()
        replayTask = Task { [weak self] in await self?.runReplay(epoch) }
    }

    func stopReplay() {
        replayEpoch += 1                 // invalidate the in-flight loop
        replaying = false
        replayPaused = false
        keepAlive.stop()
        thinkingSfx.stop()               // drop the thinking cue if a beat was mid-fetch
        replayTask?.cancel(); replayTask = nil
        replay.stop()
        stopReplayCaption()
        captionHidden = true
        captionText = ""
        captionSentenceKey = ""
        speakingMessageId = nil
        captionThinking = false
        stageSpeakerId = nil
        stageSpeakerState = nil
        audibleSpeakerId = nil
        syncNowPlaying()                 // replay ended → tear down the lock-screen panel
    }

    /// Beat length for silent / no-audio lines — `max(1.5, min(5.2, len·0.036))s`.
    private func beatSeconds(_ text: String) -> Double {
        Swift.max(1.5, Swift.min(5.2, Double(text.count) * 0.036))
    }

    private func runReplay(_ epoch: Int) async {
        for beat in replayBeats {
            if epoch != replayEpoch { return }
            if beat.isUser {
                // Silent beat · empty stage, caption shows your turn for a moment.
                setThinkingSfx(false)
                stageSpeakerId = nil; stageSpeakerState = nil; audibleSpeakerId = nil
                captionKicker = beat.name; captionThinking = false; captionHidden = false
                captionText = Caption.currentSentence(beat.text, revealedChars: beat.text.count)
                await sleepBeat(beatSeconds(beat.text), epoch: epoch)
                continue
            }
            // Director / chair · think → fetch clip → speak. The thinking cue plays
            // while the clip is fetched/re-synthesised (parity with the live turn).
            stageSpeakerId = beat.speakerId; stageSpeakerState = "thinking"; audibleSpeakerId = nil
            captionKicker = beat.name; captionText = ""; captionThinking = true; captionHidden = false
            setThinkingSfx(true)
            syncNowPlaying()                                  // lock-screen: new speaker is up (thinking)
            let data = beat.id.isEmpty ? nil : await fetchClip(beat.id)
            if epoch != replayEpoch { setThinkingSfx(false); return }
            captionThinking = false
            setThinkingSfx(false)
            stageSpeakerState = "speaking"
            speakingMessageId = beat.id.isEmpty ? nil : beat.id   // light up this row's bubble while it's read
            if let data {
                audibleSpeakerId = beat.speakerId
                startReplayCaption(text: beat.text, epoch: epoch)
                await replay.play(data, rate: Float(playRate))
                stopReplayCaption()
                if epoch != replayEpoch { return }
                captionText = Caption.currentSentence(beat.text, revealedChars: beat.text.count)
                audibleSpeakerId = nil
            } else {
                // No saved/synth audio · timed reveal of the line.
                captionText = Caption.currentSentence(beat.text, revealedChars: beat.text.count)
                await sleepBeat(beatSeconds(beat.text), epoch: epoch)
            }
            speakingMessageId = nil
            captionSentenceKey = ""
        }
        if epoch == replayEpoch { stopReplay() }
    }

    private func fetchClip(_ messageId: String) async -> Data? {
        if let d = await api.messageAudio(messageId) { return d }
        return await api.synthMessageAudio(messageId)
    }

    private func sleepBeat(_ seconds: Double, epoch: Int) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        if epoch != replayEpoch { return }
    }

    private func startReplayCaption(text: String, epoch: Int) {
        stopReplayCaption()
        replayCapTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, epoch == self.replayEpoch, let p = self.replay.progress() else { return }
                let total = text.count
                let revealed = p.duration > 0
                    ? Int((p.time / p.duration) * Double(total))
                    : Swift.min(total, Int(p.time * 15))
                let sentence = Caption.currentSentence(text, revealedChars: revealed)
                let swapped = self.captionSentenceKey != sentence
                self.captionText = sentence
                self.captionSentenceKey = sentence    // bubble highlight tracks the same paged sentence
                if swapped { self.syncNowPlaying() }  // lock-screen subtitle pages with the replay clip
            }
        }
    }
    private func stopReplayCaption() { replayCapTimer?.invalidate(); replayCapTimer = nil }

    /// A speaker is audible only while their clip is actually playing (not
    /// paused) — the lip-sync gate the stage reads.
    private func refreshAudible() {
        audibleSpeakerId = (voice.playingId != nil && !voice.isPaused) ? voice.playingAuthor : nil
    }

    /// Thinking cue · runs from the HEAD speaker's `message-appended` until that
    /// turn's audio starts (voice rooms · `onVoiceChange`) or its `message-final`
    /// (text rooms · no audio), whichever comes first — the cue covers the
    /// "framing the reply" window and must never overlap the spoken TTS. `on` is
    /// honoured only in a live, unpaused room. The head check (caller side) keeps a
    /// pre-warmed next speaker — whose appended arrives while the current one is
    /// still audible — from starting it.
    private func setThinkingSfx(_ on: Bool) {
        // Live turns OR an active replay. An adjourned room that's NOT replaying
        // (e.g. re-entry replaying buffered live events) keeps the cue silent.
        if on, !paused, (status != .adjourned || replaying) { thinkingSfx.start() } else { thinkingSfx.stop() }
    }

    /// Hold the background-audio assertion for the whole active voice session so the
    /// app keeps running locked through the SILENT gaps between director turns (else
    /// the next director's LLM+TTS stalls until the user unlocks). Same condition as
    /// the wake-lock: voice + (replaying, or live & not paused). Idempotent.
    private func refreshKeepAlive() {
        let on = isVoice && (replaying || (status == .live && !paused))
        if on { keepAlive.start() } else { keepAlive.stop() }
    }

    // MARK: Caption karaoke (driven by the native clip)

    private func onVoiceChange() {
        cancelBridgeThinking()   // any voice-state change supersedes a pending bridge; the idle branch re-arms it
        if voice.playingId != nil {
            // A turn's audio just started · fire its entry cue ONCE (segments of the
            // same message keep the id, so the cue doesn't re-fire mid-turn). The
            // chair gets the gavel "knock-knock"; a director gets the scene-cut
            // chime — the texture the desktop has and the native lacked.
            if voice.playingId != lastSpokenMessageId {
                lastSpokenMessageId = voice.playingId
                if isChair(voice.playingAuthor) { roomSfx.gavel() } else { roomSfx.speakerChange() }
            }
            captionKicker = name(voice.playingAuthor)
            captionThinking = false
            captionHidden = false
            stageSpeakerId = voice.playingAuthor
            stageSpeakerState = "speaking"
            speakingMessageId = voice.playingId   // light up this row's bubble for the in-chat karaoke
            pendingSpeakerId = nil          // the audible speaker is on stage now · no one is waiting behind them
            // Voice rooms · audio for this turn has started → the speaker is no
            // longer "thinking", they're talking. Kill the cue here even though the
            // text stream (message-final) may not have landed yet — TTS plays
            // sentence-by-sentence and can start mid-stream, so the lifecycle's
            // own appended→final window would otherwise leave the cue looping
            // UNDER the spoken audio. Thinking SFX and TTS must never overlap.
            setThinkingSfx(false)
            startCaptionTimer()
        } else if let pending = pendingSpeakerId {
            // The audio queue drained but the next director was already pre-warmed
            // (their turn appended while the previous one spoke). Promote them to
            // the stage as "thinking" NOW — so the camera + caption move to the new
            // speaker exactly when the previous TTS finishes, not before, and we
            // skip a flash of the wide establishing shot between turns. The cue
            // stays OFF (this turn's generation window already overlapped the prior
            // audio); it'll go straight to "speaking" when their clip starts.
            stopCaptionTimer()
            stageSpeakerId = pending
            stageSpeakerState = "thinking"
            speakingMessageId = nil         // audio drained · no row is being read right now
            captionSentenceKey = ""
            captionKicker = name(pending)
            captionText = ""
            captionThinking = true
            captionHidden = false
            activeSpeaker = pending
            pendingSpeakerId = nil
            setThinkingSfx(true)            // the promoted speaker is thinking until their clip starts
        } else {
            stopCaptionTimer()
            captionHidden = true
            captionText = ""
            speakingMessageId = nil
            captionSentenceKey = ""
            activeSpeaker = nil
            stageSpeakerId = nil
            stageSpeakerState = nil
            // Inter-turn / round gap · the audio drained and no speaker is pre-warmed
            // yet (next director synthesising, or a round wrap → the chair's turn is
            // still generating). Arm the debounced "thinking bridge" so the stage
            // shows the next speaker (or the chair at a round wrap) THINKING + plays
            // the cue, instead of going blank + silent ("停一会 / 空场").
            armBridgeThinking()
        }
        refreshAudible()
        syncNowPlaying()
    }

    private func startCaptionTimer() {
        stopCaptionTimer()
        tickCaption()   // render the first frame at once (web captionFollowAudio calls tick() immediately)
        captionTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tickCaption() }
        }
    }
    private func stopCaptionTimer() { captionTimer?.invalidate(); captionTimer = nil }

    private func tickCaption() {
        guard voice.playingId != nil else { return }
        // Per-sentence karaoke · show the sentence whose clip is playing now,
        // revealed char-by-char by that clip's progress (web `captionFollowAudio`
        // parity). Each voice-chunk is one sentence with its own clip, so the
        // subtitle pages + reveals exactly in lock-step with the spoken audio.
        guard let seg = voice.captionSegment else { return }   // between segments · hold last frame
        let swapped = captionSentenceKey != seg.text
        captionSentenceKey = seg.text                          // changes only at sentence swaps → cross-fade fires there, not per char
        let n = max(0, min(seg.text.count, seg.revealed))
        captionText = String(seg.text.prefix(n))
        if swapped { syncNowPlaying() }                        // push the new lock-screen line once per sentence (not per char)
    }

    private func clearStage() {
        activeSpeaker = nil
        captionHidden = true
        captionText = ""
        captionSentenceKey = ""
        speakingMessageId = nil
        stageSpeakerId = nil
        stageSpeakerState = nil
        audibleSpeakerId = nil
    }

    /// Live-streaming agent bubble · keyed by messageId so tokens update the SAME
    /// transcript row as they arrive (chat bubble streams, not all-at-once on
    /// final). Creates the row on the first token, updates it thereafter.
    private func upsertStreamingLine(messageId: String, authorId: String?, text: String) {
        if let i = transcript.firstIndex(where: { $0.id == messageId }) {
            transcript[i].text = text
            transcript[i].isThinking = false   // first token landed → drop the loading dots
        } else {
            // Fallback create (no thinking row was made — e.g. a non-empty append).
            let kind = msgKind[messageId] ?? nil
            transcript.append(Line(id: messageId, name: name(authorId),
                                   text: text, isUser: false, round: roundNum,
                                   role: memberRole(authorId), model: memberModel(authorId),
                                   time: Self.timeFmt(Date()), avatarPath: memberAvatar(authorId),
                                   isChair: isChair(authorId), kind: kind))
        }
    }

    private func appendLine(authorId: String?, text: String, isUser: Bool, at: Date? = nil) {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        transcript.append(Line(id: UUID().uuidString,
                               name: isUser ? "You" : name(authorId),
                               text: body, isUser: isUser, round: roundNum,
                               role: isUser ? nil : memberRole(authorId),
                               model: isUser ? nil : memberModel(authorId),
                               time: Self.timeFmt(at ?? Date()),
                               avatarPath: isUser ? nil : memberAvatar(authorId),
                               isChair: !isUser && isChair(authorId)))
    }

    /// Resolve the speaking agent · directors live in `members`, the chair is
    /// kept aside (it's not a room member). Byline + avatar lookups go through here.
    private func member(_ id: String?) -> Member? {
        guard let id else { return nil }
        return members.first(where: { $0.id == id }) ?? (chair?.id == id ? chair : nil)
    }

    /// Director byline lookups · the snapshot members are full Agents (roleTag +
    /// modelV); fall back to a Moderator tag for the chair.
    private func memberRole(_ id: String?) -> String? {
        guard let m = member(id) else { return nil }
        if let r = m.roleTag, !r.isEmpty { return r }
        return m.roleKind == "moderator" ? "Moderator" : nil
    }
    /// The chair speaks (clarify / open / close / vote) but isn't a director member.
    /// Its turns render as a distinct left bubble so they don't read as just more
    /// director prose in a long transcript.
    private func isChair(_ id: String?) -> Bool {
        guard let m = member(id) else { return false }
        return m.roleKind == "moderator" || m.roleKind == "chair"
    }
    private func memberModel(_ id: String?) -> String? {
        guard let m = member(id), let mv = m.modelV, !mv.isEmpty else { return nil }
        return mv
    }
    private func memberAvatar(_ id: String?) -> String? {
        guard let p = member(id)?.avatarPath, !p.isEmpty else { return nil }
        return p
    }
    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "HH:mm"; return f
    }()
    private static func timeFmt(_ date: Date?) -> String? { date.map { timeFormatter.string(from: $0) } }

    // MARK: Controls

    func togglePause() {
        guard status != .adjourned else { return }
        if paused {
            paused = false; status = .live; voice.setPaused(false)       // resume clip immediately
            refreshAudible()                                             // next appended re-arms the cue
            showChairThinkingPlaceholder()                               // bridge the resume → first-turn gap so Play feels instant
            Task { try? await api.resumeRoom(room.id) }
        } else {
            paused = true; status = .paused; voice.setPaused(true)        // silence clip immediately
            refreshAudible(); setThinkingSfx(false)
            Task { try? await api.pauseRoom(room.id, mode: "soft") }
        }
        refreshKeepAlive()
        syncNowPlaying()
    }

    /// Meeting ended (from the room menu) · flip state + tear down voice so the
    /// in-room UI reflects it immediately. The list refreshes on return.
    func markAdjourned() {
        status = .adjourned
        paused = false
        voice.releaseAndReset()
        thinkingSfx.stop()
        keepAlive.stop()
        thinkingTimeout?.cancel(); thinkingTimeout = nil; chairThinking = false
        stopCaptionTimer()
        captionHidden = true
        captionText = ""
        captionThinking = false
        stageSpeakerId = nil
        stageSpeakerState = nil
        audibleSpeakerId = nil
        pendingSpeakerId = nil
        nowPlaying.clear()
    }

    /// Name of who's currently on stage (for the interrupt-vs-queue prompt).
    var stageSpeakerName: String? { stageSpeakerId.map { name($0) } }

    func send(_ text: String, mode: String = "now") {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        Task { try? await api.sendMessage(room.id, body: body, mode: mode) }
    }
}
