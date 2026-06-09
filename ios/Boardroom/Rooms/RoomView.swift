import SwiftUI
import UIKit
import BoardroomCore

/// Wave 3 · the room interior. Full-bleed: the 3D stage (voice) or the chat
/// transcript fills the screen, and Liquid-Glass chrome overlays it — top bar
/// (back · title · status · menu), rolling caption, cast rail, control dock,
/// interrupt-vs-queue ask sheet, round-end bar, queue sheet, adjourned bar.
struct RoomView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    let room: Room

    @State private var session: RoomSession?
    @State private var stage = StageController()
    @State private var showTranscript = false
    @State private var stageUnsupported = false
    @State private var askText: String?       // pending message awaiting interrupt-vs-queue choice
    @State private var showReport = false
    @State private var showNoReport = false   // "View report" tapped with no brief filed yet
    @State private var showQueue = false              // speaking-queue sheet (voice room)
    @State private var queueExpanded = false          // Progress Panel (director checklist) open
    @State private var captionsOn = true              // user toggle · show the spoken-caption band
    @State private var chromeHeight: CGFloat = 120     // measured bottom-chrome height → transcript bottom inset
    @State private var reportSupplement = ""          // supplement carried into the report on adjourn
    @State private var showSettings = false
    @State private var confirmDelete = false
    @State private var showAdjourn = false           // adjourn overlay (report type + supplement + end)
    @State private var adjournSupplement = ""
    @State private var adjournFmt = "research-note"   // chosen report MODE (research-note / magazine / newspaper)
    @State private var adjournStyle = ""              // chosen per-mode STYLE ("" = auto · spine or variant)
    @State private var adjourning = false
    @FocusState private var adjournFocused: Bool
    @State private var draft = ""
    @State private var conveningFollowUp = false      // adjourned · the follow-up convene round-trip is in flight
    @State private var followUpError: String?
    // 3D stage manual camera · orbit (drag) + zoom (pinch). Base = value at gesture start.
    @State private var stageYaw: Double = 0
    @State private var stageYawBase: Double = 0
    @State private var stagePitch: Double = 0
    @State private var stagePitchBase: Double = 0
    @State private var stageZoom: Double = 1         // userZoom distance multiplier (lower = closer)
    @State private var stageZoomBase: Double = 1
    @FocusState private var composerFocused: Bool

    // Live delivery mode · the session's `deliveryMode` is editable in room
    // settings (voice ↔ text), so read it (not the immutable room snapshot) so
    // turning voice off swaps the stage → transcript at once.
    private var isVoice: Bool { session?.isVoice ?? room.isVoice }
    private var showStage: Bool { isVoice && !showTranscript && !stageUnsupported }

    /// Flip between the 3D stage and the transcript. Returning to the stage clears
    /// any prior `stageUnsupported` flag so a stage that fell back (e.g. a slow
    /// first load that tripped the load watchdog) is RETRIED on the next toggle
    /// instead of being stuck in the transcript with no way back.
    private func toggleStageView() {
        if showTranscript { stageUnsupported = false }
        showTranscript.toggle()
        // Remember the user's explicit choice for THIS room so re-entry restores
        // the same view (3D stage vs transcript). Only persisted from the manual
        // toggle — a `stageUnsupported` fallback or a replay tap must not clobber
        // the saved preference.
        if isVoice {
            UserDefaults.standard.set(showTranscript ? "transcript" : "stage", forKey: Self.viewPrefKey(room.id))
        }
    }

    /// Per-room key for the persisted stage/transcript view preference.
    private static func viewPrefKey(_ roomId: String) -> String { "roomView.\(roomId)" }

    var body: some View {
        ZStack {
            Color.bbBg.ignoresSafeArea()
            if let session {
                background(session)
                bottomChrome(session)
                // Text/transcript rooms · the same frosted header band as the
                // Home masthead, so the chat dissolves under the top bar instead
                // of scrolling crisply to the top edge. (Voice stage stays
                // full-bleed under the floating pills — no scrim.)
                if !showStage {
                    VStack(spacing: 0) { TopScrim().frame(height: 112); Spacer() }
                        .ignoresSafeArea(edges: .top)
                }
                topBar(session)
                if askText != nil { askSheet(session) }
                // Voice rooms use a bottom-sheet overlay (the stage owns the screen);
                // text rooms render the round-end as an inline transcript card.
                if isVoice && session.roundEndActive && session.status != .adjourned { roundEndSheet(session) }
                if showAdjourn { adjournSheet(session) }
            } else {
                ProgressView().tint(.bbGold)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showReport) {
            if app.isNative { NativeBriefView(roomId: room.id, supplement: reportSupplement, initialMode: adjournFmt, initialStyle: adjournStyle) } else { ReportSheet(room: room) }
        }
        .sheet(isPresented: $showSettings) { if let session { RoomSettingsView(session: session) } }
        .sheet(isPresented: $showQueue) {
            if let session { QueueSheet(session: session).presentationDetents([.medium, .large]) }
        }
        .confirmationDialog(Loc.t("m_delete_confirm", ["subject": room.displayName]),
                            isPresented: $confirmDelete, titleVisibility: .visible) {
            Button(Loc.t("m_delete_do"), role: .destructive) { delete() }
            Button(Loc.t("common_cancel"), role: .cancel) {}
        }
        // "View report" with nothing filed yet · don't silently generate, just say so.
        .alert(Loc.t("m_rep_none"), isPresented: $showNoReport) {
            Button(Loc.t("common_done"), role: .cancel) {}
        }
        .task {
            guard session == nil else { return }
            // Restore this room's last-used view · a voice room reopens on the 3D
            // stage or the transcript exactly as the user last left it (text rooms
            // are always transcript, set by the branches below). Applied before the
            // session branches so every entry path inherits it.
            if room.isVoice, let saved = UserDefaults.standard.string(forKey: Self.viewPrefKey(room.id)) {
                showTranscript = (saved == "transcript")
            }
            // Re-entering a room that's still playing in the background mini-player ·
            // adopt that LIVE session (its SSE + TTS never stopped) instead of opening
            // a second one, and drop the mini-player since we're now viewing it.
            if let np = app.nowPlaying, np.room.id == room.id {
                session = np
                app.nowPlaying = nil
                if !isVoice || stageUnsupported { showTranscript = true }
                applyKeepAwake()
                return
            }
            // Native (no-server) engine when the flag is on; otherwise the REST
            // client. `RoomSession` is identical either way (the RoomBackend seam).
            let nativeHost = FeatureFlag.nativeEngine ? NativeEngineHost.shared : nil
            let backend: any RoomBackend = nativeHost?.backend
                ?? app.api
                ?? APIClient(backend: Backend(baseURL: URL(string: "http://127.0.0.1")!, authToken: nil))
            let s = RoomSession(room: room, api: backend)
            session = s
            if app.isDemo {
                s.startDemo(members: app.directors(for: room).map {
                    Member(id: $0.id, name: $0.name, avatarPath: $0.avatarPath, roleKind: $0.roleKind)
                })
                if !isVoice || stageUnsupported { showTranscript = true }
            } else {
                stage.onUnsupported = { stageUnsupported = true }
                await s.start()
                if let nativeHost {
                    // Voice rooms get the 3D stage via the loopback server; text
                    // rooms show the transcript. (Stage falls back to transcript
                    // if WebGL is unavailable — stage.onUnsupported.)
                    if !isVoice { showTranscript = true }
                    await nativeHost.conveneIfNeeded(room.id)
                }
            }
            applyKeepAwake()
        }
        // Keep the screen awake while a voice room is actually playing (live &
        // not paused, or replaying an adjourned room) — the meeting plays hands-
        // free, so the auto-dim/lock was killing the experience mid-turn.
        .onChange(of: session?.status) { _, _ in applyKeepAwake() }
        .onChange(of: session?.paused) { _, _ in applyKeepAwake() }
        .onChange(of: session?.replaying) { _, _ in applyKeepAwake() }
        .onChange(of: session?.deliveryMode) { _, _ in applyKeepAwake() }   // voice off → release the wake-lock
        .onDisappear {
            stage.teardown()                                   // 3D WebView only · audio lives in the session
            UIApplication.shared.isIdleTimerDisabled = false   // release the wake-lock; background audio continues
            // Continue playing in a background mini-player when leaving a voice room
            // that's actively playing — UNLESS the user paused first (their intent is
            // to stop). Hand the LIVE session to AppState (keeps its SSE + TTS alive);
            // otherwise tear it down normally.
            let keepPlaying = session?.isVoice == true && session?.status == .live
                && session?.paused == false && session?.replaying == false
            if keepPlaying, let s = session {
                app.nowPlaying = s
            } else {
                session?.leave()
                if app.nowPlaying === session { app.nowPlaying = nil }
            }
            // Reflect pause/resume/adjourn in the list. reloadRooms reads the DB,
            // but the engine's status write is async and can lose the race — so
            // re-apply the session's known status AFTER the reload to win it.
            let knownStatus = session?.status
            let rid = room.id
            Task {
                await app.reloadRooms()
                if let knownStatus { app.setRoomStatus(rid, knownStatus) }
            }
        }
    }

    /// Hold the display awake during voice playback; release otherwise.
    private func applyKeepAwake() {
        let s = session
        let awake = isVoice && (s?.replaying == true || (s?.status == .live && s?.paused == false))
        UIApplication.shared.isIdleTimerDisabled = awake
    }

    // MARK: Background (stage / transcript)

    @ViewBuilder
    private func background(_ session: RoomSession) -> some View {
        if showStage, let url = stageURL {
            ZStack {
                StageWebView(url: url, controller: stage)
                    .ignoresSafeArea()
                    // The stage is display-only (seat-tap is an unwired TODO); let its
                    // gesture recognizers NOT swallow taps meant for the SwiftUI chrome
                    // layered above (back button, dock). Re-enable when seat-tap lands.
                    .allowsHitTesting(false)
                    .onChange(of: session.stageSpeakerId) { stage.setSpeaker(id: session.stageSpeakerId, state: session.stageSpeakerState) }
                    .onChange(of: session.stageSpeakerState) { stage.setSpeaker(id: session.stageSpeakerId, state: session.stageSpeakerState) }
                    .onChange(of: session.audibleSpeakerId) { stage.setAudible(session.audibleSpeakerId) }
                    .onChange(of: session.roomMode) { _, m in stage.setMode(m) }   // tone edit → recolor floor live
                    .onAppear {
                        // (Re)mounting the stage — e.g. toggling back from the
                        // transcript while a director is mid-turn — gives us a fresh
                        // embed with NO speaker state. The .onChange handlers above
                        // only fire on a CHANGE, so the in-progress speaker + audible
                        // (lip-sync) + tone would stay unset until the NEXT director.
                        // Push the current snapshot now; StageController queues it
                        // until the new embed posts `ready`.
                        stage.setMode(session.roomMode)
                        stage.setSpeaker(id: session.stageSpeakerId, state: session.stageSpeakerState)
                        stage.setAudible(session.audibleSpeakerId)
                    }
                // Manual-camera layer (the WebView has hit-testing off; this clear
                // overlay sits above it but below the chrome, so drag/pinch move
                // the 3D camera while back/dock taps still work). One-finger drag
                // orbits, two-finger pinch zooms, double-tap resets.
                GeometryReader { geo in
                    Color.clear
                        .contentShape(Rectangle())
                        .gesture(
                            DragGesture(minimumDistance: 6)
                                .onChanged { v in
                                    let yaw = stageYawBase - Double(v.translation.width) * 0.006
                                    let pitch = min(0.65, max(-0.55, stagePitchBase - Double(v.translation.height) * 0.005))
                                    stageYaw = yaw; stagePitch = pitch
                                    stage.setOrbit(yaw, pitch)
                                }
                                .onEnded { _ in stageYawBase = stageYaw; stagePitchBase = stagePitch }
                        )
                        .simultaneousGesture(
                            MagnifyGesture()
                                .onChanged { v in
                                    // pinch-out (magnification > 1) → smaller userZoom → closer
                                    let z = min(2.2, max(0.5, stageZoomBase / Double(v.magnification)))
                                    stageZoom = z
                                    stage.setZoom(z)
                                }
                                .onEnded { _ in stageZoomBase = stageZoom }
                        )
                        // Single tap → raycast that point in the 3D scene + close up
                        // on the tapped director. The WebView's own tap handler can't
                        // fire (hit-testing is off so chrome stays tappable), so we
                        // hand the normalised tap point to the embed bridge.
                        .simultaneousGesture(
                            SpatialTapGesture(count: 1)
                                .onEnded { v in
                                    let w = geo.size.width, h = geo.size.height
                                    guard w > 0, h > 0 else { return }
                                    let nx = max(0, min(1, Double(v.location.x / w)))
                                    let ny = max(0, min(1, Double(v.location.y / h)))
                                    stage.tapAt(nx, ny)
                                }
                        )
                        .onTapGesture(count: 2) {
                            stageYaw = 0; stageYawBase = 0; stagePitch = 0; stagePitchBase = 0
                            stageZoom = 1; stageZoomBase = 1
                            stage.setOrbit(0, 0); stage.setZoom(1)
                        }
                }
                .ignoresSafeArea()
            }
        } else {
            transcript(session)
        }
    }

    private var stageURL: URL? {
        let rid = room.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? room.id
        let mode = (room.mode ?? "constructive").addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "constructive"
        let path = "/mobile/stage-embed.html?room=\(rid)&mode=\(mode)"
        // Native · the loopback server origin; server mode · the REST asset URL.
        if FeatureFlag.nativeEngine, let base = NativeEngineHost.shared?.stageBaseURL {
            return URL(string: path, relativeTo: base)?.absoluteURL
        }
        return app.api?.assetURL(path)
    }

    private func transcript(_ session: RoomSession) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    Color.clear.frame(height: 1)
                    ForEach(Array(session.transcript.enumerated()), id: \.element.id) { idx, line in
                        if idx > 0, line.round != session.transcript[idx - 1].round {
                            RoundDivider(round: line.round)
                        }
                        // Karaoke · only the row whose TTS clip is playing gets the
                        // live sentence; every other row gets "" so it doesn't churn
                        // on each 100ms caption tick.
                        TranscriptRow(line: line,
                                      spokenSentence: line.id == session.speakingMessageId ? session.captionSentenceKey : "")
                            .id(line.id)
                    }
                    // Chair "thinking" placeholder · fills the create-room / first-
                    // turn gap so the chat never opens blank. Cleared the moment a
                    // real turn streams in.
                    if !isVoice && session.chairThinking {
                        ChairThinkingBubble(name: session.chairThinkingName, avatarPath: session.chairThinkingAvatar)
                            .id("thinking")
                            .transition(.opacity)
                    }
                    // Text rooms · the round-end / vote shows as a special inline
                    // card at the foot of the chat (the chair's round-prompt bubble
                    // sits just above it). Voice rooms use the bottom sheet instead.
                    if session.awaitingContinue && session.status != .adjourned {
                        textRoundEndCard(session).id("roundend")
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 16)
                .padding(.top, 60)
            }
            // Reserve space for the bottom composer chrome as a scroll INSET (not an
            // in-stack spacer): `defaultScrollAnchor(.bottom)` + `scrollTo` honour it,
            // so the last message parks just above the composer — and the inset never
            // renders as empty transcript background. A spacer here over-reserved when
            // measured on the 3D stage (the caption band inflates `chromeHeight`),
            // leaving a black gap on the stage→text toggle that you had to scroll past.
            .contentMargins(.bottom, max(96, chromeHeight + 12), for: .scrollContent)
            // Open at the latest message (chat default), and stay pinned to the
            // bottom as new turns stream in.
            .defaultScrollAnchor(.bottom)
            .onChange(of: session.transcript.count) {
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("end", anchor: .bottom) }
            }
            // Toggling from the 3D stage RE-CREATES this transcript subtree, so an
            // `onChange(of: showTranscript)` here never fires (it's the initial value
            // for the freshly-mounted view). Pin to the latest line in `onAppear`
            // instead — otherwise the fresh LazyVStack opens parked in its bottom
            // content-margin with no rows realized (blank until you scroll up).
            .onAppear { pinTranscriptToLatest(proxy, session) }
            .onChange(of: session.awaitingContinue) { _, on in
                if on { withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("roundend", anchor: .bottom) } }
            }
            .onChange(of: session.chairThinking) { _, on in
                if on { withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("thinking", anchor: .bottom) } }
            }
        }
    }

    /// Park the transcript on the latest line. Runs an immediate pass plus a
    /// short-delayed retry: a freshly-mounted LazyVStack (the stage→transcript
    /// toggle creates one) hasn't realized its rows yet, so the first `scrollTo`
    /// can land in the empty bottom inset — the retry, after layout settles,
    /// lands on the real last row.
    private func pinTranscriptToLatest(_ proxy: ScrollViewProxy, _ session: RoomSession) {
        let target: String = {
            if session.awaitingContinue && session.status != .adjourned { return "roundend" }
            if !isVoice && session.chairThinking { return "thinking" }
            return session.transcript.last?.id ?? "end"
        }()
        proxy.scrollTo(target, anchor: .bottom)
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(60))
            proxy.scrollTo(target, anchor: .bottom)
        }
    }

    // MARK: Top bar

    private func topBar(_ session: RoomSession) -> some View {
        VStack {
            GlassEffectContainer(spacing: 10) {     // back · title · status · menu share one sampling region
            HStack(spacing: 10) {
                GlassIconButton(system: "chevron.left") { dismiss() }
                Text(session.roomTitle ?? room.displayName)   // in-room · AI-distilled title (list shows the raw query)
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                    .padding(.horizontal, 16).frame(height: 44)
                    .glassPill()
                Spacer(minLength: 4)
                if session.replaying {
                    HStack(spacing: 6) {
                        PulseDot(color: .bbAmber, on: true)
                        Text(Loc.t("m_adj_replay")).font(.bbKicker()).foregroundStyle(Color.bbAmber)
                    }
                    .padding(.horizontal, 14).frame(height: 44).glassPill()
                } else if session.status != .adjourned { LiveStatusPill(status: session.status) }
                Menu {
                    Button { showSettings = true } label: { Label(Loc.t("m_menu_settings"), systemImage: "slider.horizontal.3") }
                    Button { viewReport() } label: { Label(Loc.t("m_menu_genreport"), systemImage: "doc.text") }
                    if session.status != .adjourned {
                        Button { adjourn() } label: { Label(Loc.t("m_menu_adjourn"), systemImage: "flag.checkered") }
                    }
                    Divider()
                    Button(role: .destructive) { confirmDelete = true } label: { Label(Loc.t("m_menu_delete"), systemImage: "trash") }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Color.bbInk)
                        .frame(width: 44, height: 44)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: Circle())
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            }
            Spacer()
        }
    }

    // MARK: Bottom chrome (caption · rail · dock / composer)

    @ViewBuilder
    private func bottomChrome(_ session: RoomSession) -> some View {
        VStack(spacing: 0) {
            Spacer()
            Group {
                if session.awaitingContinue && session.status != .adjourned {
                    // Round wrapped · the bottom-sheet overlay owns the bottom. When the
                    // sheet is dismissed, a re-open pill takes its place here.
                    if !session.roundEndActive { roundEndReopenPill(session) }
                } else if session.status == .adjourned {
                    adjournedComposer(session)
                } else {
                    // EVERY live room — text AND 3D voice — uses the one composer card:
                    // textarea on top, its controls in the row below, the director-queue
                    // bar above. (The old voice dock / cast-rail / fold + caption band
                    // are gone; voice playback controls live in the card's action row.)
                    composer(session)
                }
            }
            // Feed the rendered chrome height back so the transcript reserves exactly
            // this much bottom space — the queue bar (and its expanded checklist) grow
            // the chrome, and a fixed inset would let the bar cover the last messages.
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { chromeHeight = $0 }
        }
    }


    // Adjourned · a clean follow-up composer (NOT the old circular-glass dock).
    // The meeting's over, so the natural next action is to ask a follow-up — the
    // textarea's send convenes a NEW room seeded with this room's cast / tone /
    // delivery and the typed question. Replay (voice) + report stay as quiet text
    // actions above the card.
    private func adjournedComposer(_ session: RoomSession) -> some View {
        let empty = draft.trimmingCharacters(in: .whitespaces).isEmpty
        return VStack(alignment: .leading, spacing: 8) {
            // Spoken caption · shown during replay over the stage (same band the
            // live room uses). Replay drives captionKicker/Text just like a live
            // turn, so this surfaces the subtitle + the audible line.
            if isVoice && !showTranscript && captionsOn && !session.captionHidden {
                captionBand(session)
            }
            // One card · textarea on top, action row below — identical structure +
            // control style to the live composer. Replay / stage-toggle / captions
            // / report use the same `composerCtl` icon buttons the live room uses
            // (not the old heavy glass dock, not plain text); send convenes a
            // follow-up.
            VStack(alignment: .leading, spacing: 10) {
                TextField(Loc.t("m_adj_followup_ph"), text: $draft, axis: .vertical)
                    .textFieldStyle(.plain).lineLimit(1...6).focused($composerFocused)
                    .font(.system(size: 16)).foregroundStyle(Color.bbInk).tint(.bbGold)
                    .submitLabel(.send).onSubmit { conveneFollowUp(session) }
                    .padding(.horizontal, 6).padding(.top, 4)
                HStack(spacing: 8) {
                    if isVoice {
                        composerCtl(session.replaying ? "stop.fill" : "play.fill", on: session.replaying) {
                            if session.replaying { session.stopReplay() }
                            else { withAnimation(.smooth(duration: 0.3)) { showTranscript = false }; session.startReplay() }
                        }
                        // Replay speed · same capsule control as the live composer.
                        Button { session.cycleRate() } label: {
                            Text(session.rateLabel)
                                .font(.system(size: 13, weight: .bold, design: .monospaced)).foregroundStyle(Color.bbInk)
                                .frame(height: 38).padding(.horizontal, 13)
                                .background(Capsule().fill(Color.white.opacity(0.05)))
                                .overlay(Capsule().stroke(Color.bbLine, lineWidth: 1))
                        }.buttonStyle(.plain)
                        composerCtl(showTranscript ? "waveform" : "text.alignleft") { toggleStageView() }
                        // Captions toggle · only meaningful on the stage (not transcript).
                        if !showTranscript {
                            composerCtl(captionsOn ? "captions.bubble.fill" : "captions.bubble", on: captionsOn) {
                                captionsOn.toggle()
                            }
                        }
                    }
                    composerCtl("doc.text") { viewReport() }
                    Spacer(minLength: 0)
                    if conveningFollowUp {
                        Text(Loc.t("m_adj_convening")).font(.system(size: 13)).foregroundStyle(Color.bbInkDim)
                    }
                    Button { conveneFollowUp(session) } label: {
                        Group {
                            if conveningFollowUp { ProgressView().tint(.bbBg) }
                            else { Image(systemName: "arrow.up").font(.system(size: 19, weight: .bold)) }
                        }
                        .foregroundStyle(Color.bbBg).frame(width: 42, height: 42)
                        .background(Circle().fill(empty ? Color.bbGold.opacity(0.4) : Color.bbGold))
                    }
                    .buttonStyle(.plain).disabled(empty || conveningFollowUp)
                }
            }
            .padding(12)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))

            if let followUpError {
                Text(followUpError).font(.footnote).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 4)
            }
        }
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 8)
    }

    /// Convene a follow-up room from the adjourned composer · the typed text is the
    /// new subject; cast / tone / delivery carry over from this room. On success we
    /// pop back to the list where the new live room sits on top (matches the old
    /// follow-up flow's landing).
    private func conveneFollowUp(_ session: RoomSession) {
        let subject = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !subject.isEmpty, !conveningFollowUp else { return }
        conveningFollowUp = true; followUpError = nil; composerFocused = false
        let dirIds = session.members
            .filter { $0.roleKind != "moderator" && $0.roleKind != "chair" && $0.id != "__user" }
            .map { $0.id }
        Task {
            do {
                let newRoom = try await app.createRoom(
                    subject: subject, mode: room.mode ?? "constructive",
                    intensity: room.intensity ?? "sharp",
                    deliveryMode: room.deliveryMode ?? "voice",
                    autoPick: dirIds.count < 2, agentIds: dirIds, parentRoomId: room.id)
                app.rooms.insert(newRoom, at: 0)
                draft = ""; conveningFollowUp = false
                dismiss()
            } catch {
                conveningFollowUp = false
                followUpError = (error as? APIClient.APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    /// Bottom composer · the textarea sits ON TOP of its action row (send below),
    /// one rounded card (mirrors the iOS chat-composer reference). Text rooms get
    /// an expandable director-queue bar above the card (desktop's roster strip).
    private func composer(_ session: RoomSession) -> some View {
        GlassEffectContainer(spacing: 8) {       // blend the glass panels
            VStack(spacing: 8) {
                // Spoken caption · auto-shows over the stage while a director speaks
                // (voice, not the transcript view, not paused). Unchanged behaviour.
                if isVoice && !showTranscript && captionsOn && !session.captionHidden && !session.paused {
                    captionBand(session)
                }
                // Director queue · collapsed by default into the action-row button
                // below the textarea; only the panel shows here when toggled open.
                if queueExpanded { directorQueueBar(session) }
                composerCard(session)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 8)
    }

    /// Spoken-caption band · the current speaker's words, karaoke-revealed in sync
    /// with the audio. A glass panel over the stage (the original subtitle effect).
    private func captionBand(_ session: RoomSession) -> some View {
        let thinking = session.captionThinking && session.captionText.isEmpty
        return VStack(alignment: .leading, spacing: 6) {
            Text(session.captionKicker.uppercased())
                .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(1.4)
                .foregroundStyle(Color.bbGold)
            Text(thinking ? "···" : session.captionText)
                .font(.system(size: 17, weight: .medium)).lineSpacing(3)
                .foregroundStyle(thinking ? Color.bbInkFaint : Color.bbInk)
                .lineLimit(3).truncationMode(.head)
                .frame(maxWidth: .infinity, alignment: .leading)
                .animation(.easeOut(duration: 0.16), value: session.captionSentenceKey)
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func composerCard(_ session: RoomSession) -> some View {
        let empty = draft.trimmingCharacters(in: .whitespaces).isEmpty
        return VStack(alignment: .leading, spacing: 10) {
            // Textarea · grows 1→6 lines, top of the card.
            TextField(Loc.t("m_composer_ask"), text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .focused($composerFocused)
                .font(.system(size: 16))
                .foregroundStyle(Color.bbInk)
                .tint(.bbGold)
                .submitLabel(.send)
                .onSubmit { submit(session) }
                .padding(.horizontal, 6).padding(.top, 4)
            // Action row · BELOW the textarea. Voice playback controls (play/pause,
            // speed, stage⇄text) sit left; send pinned right. Text rooms show only
            // send. (Replaces the old big circular dock — all in one card now.)
            HStack(spacing: 8) {
                if isVoice {
                    composerCtl(session.paused ? "play.fill" : "pause.fill") { session.togglePause() }
                    Button { session.cycleRate() } label: {
                        Text(session.rateLabel)
                            .font(.system(size: 13, weight: .bold, design: .monospaced)).foregroundStyle(Color.bbInk)
                            .frame(height: 38).padding(.horizontal, 13)
                            .background(Capsule().fill(Color.white.opacity(0.05)))
                            .overlay(Capsule().stroke(Color.bbLine, lineWidth: 1))
                    }.buttonStyle(.plain)
                    composerCtl(showTranscript ? "waveform" : "text.alignleft") { toggleStageView() }
                    // Caption toggle · show / hide the spoken-caption band over the
                    // stage. Only meaningful on the stage (not the transcript view).
                    if !showTranscript {
                        composerCtl(captionsOn ? "captions.bubble.fill" : "captions.bubble", on: captionsOn) {
                            captionsOn.toggle()
                        }
                    }
                }
                // Director-queue toggle · expands the Progress-Checklist panel above
                // the card. Shown in every room that has a cast (next to captions).
                if !queueRows(session).isEmpty {
                    composerCtl("list.bullet.indent", on: queueExpanded) {
                        withAnimation(.smooth(duration: 0.26)) { queueExpanded.toggle() }
                    }
                }
                Spacer(minLength: 0)
                Button { submit(session) } label: {
                    Image(systemName: "arrow.up").font(.system(size: 19, weight: .bold))
                        .foregroundStyle(Color.bbBg).frame(width: 42, height: 42)
                        .background(Circle().fill(empty ? Color.bbGold.opacity(0.4) : Color.bbGold))
                }
                .buttonStyle(.plain).disabled(empty)
            }
        }
        .padding(12)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    /// Small composer action-row control · subtle bordered circle (not the old
    /// big glass dock button). Used for the voice playback controls in the card.
    /// `on` tints the icon + border gold to mark an active toggle (e.g. captions).
    private func composerCtl(_ system: String, on: Bool = false, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system).font(.system(size: 16, weight: .semibold))
                .foregroundStyle(on ? Color.bbGold : Color.bbInk).frame(width: 38, height: 38).contentShape(Circle())
                .background(Circle().fill(on ? Color.bbGold.opacity(0.12) : Color.white.opacity(0.05)))
                .overlay(Circle().stroke(on ? Color.bbGold.opacity(0.55) : Color.bbLine, lineWidth: 1))
        }.buttonStyle(.plain)
    }

    private enum QStatus { case done, speaking, upNext, pending }
    private struct QRow: Identifiable { let id: String; let member: Member; let status: QStatus; let position: Int? }

    /// Director turn order as a progress checklist · done (spoke this round) →
    /// speaking (now) → up-next (queued, by position) → pending. The "done" set is
    /// derived from this round's transcript lines.
    private func queueRows(_ session: RoomSession) -> [QRow] {
        let directors = session.members.filter { $0.id != "__user" && $0.roleKind != "moderator" }
        let spoke = Set(session.transcript.filter { $0.round == session.roundNum && !$0.isUser }.map(\.name))
        var qi: [String: Int] = [:]
        for (i, id) in session.speakingQueue.enumerated() where qi[id] == nil { qi[id] = i }
        func st(_ m: Member) -> (QStatus, Int?) {
            if m.id == session.stageSpeakerId { return (.speaking, nil) }
            if let p = qi[m.id] { return (.upNext, p + 1) }
            if spoke.contains(m.name) { return (.done, nil) }
            return (.pending, nil)
        }
        func rank(_ s: QStatus) -> Int { switch s { case .done: return 0; case .speaking: return 1; case .upNext: return 2; case .pending: return 3 } }
        return directors.enumerated().map { (i, m) -> (Int, QRow) in
            let (s, p) = st(m); return (i, QRow(id: m.id, member: m, status: s, position: p))
        }
        .sorted { a, b in
            let (ra, rb) = (rank(a.1.status), rank(b.1.status))
            if ra != rb { return ra < rb }
            if a.1.status == .upNext { return (a.1.position ?? 0) < (b.1.position ?? 0) }
            return a.0 < b.0
        }
        .map(\.1)
    }

    /// Speaking-order panel above the composer · a clean roster of the round's
    /// turn order. Refined over the old timeline-rail checklist: a mono kicker
    /// header (order · round · collapse), a hairline, then compact rows — a small
    /// state column (live dot / ordinal / check / dim dot), avatar, name, and a
    /// subtle gold tint on the speaker. No connector rail, no halo nodes.
    @ViewBuilder
    private func directorQueueBar(_ session: RoomSession) -> some View {
        let rows = queueRows(session)
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Button { withAnimation(.smooth(duration: 0.26)) { queueExpanded = false } } label: {
                    HStack(spacing: 8) {
                        Text(Loc.t("m_menu_queue").uppercased())
                            .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(1.6)
                            .foregroundStyle(Color.bbInkDim)
                        Text(Loc.t("m_q_round", ["n": "\(session.roundNum)"]))
                            .font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.bbInkFaint)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.bbInkFaint)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 13)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Rectangle().fill(Color.bbLine).frame(height: 1)
                VStack(spacing: 0) {
                    ForEach(rows) { r in queueRowRefined(r) }
                }
                .padding(.vertical, 6)
            }
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }

    private func queueRowRefined(_ row: QRow) -> some View {
        let speaking = row.status == .speaking
        return HStack(spacing: 12) {
            // Compact state column · live pulse / ordinal / done check / dim dot.
            Group {
                switch row.status {
                case .speaking: PulseDot(color: .bbGold, on: true)
                case .upNext:
                    Text(String(format: "%02d", row.position ?? 0))
                        .font(.system(size: 12, weight: .bold, design: .monospaced)).foregroundStyle(Color.bbGold)
                case .done:
                    Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Color.bbInkFaint)
                case .pending:
                    Circle().fill(Color.bbInkFaint).frame(width: 4, height: 4)
                }
            }
            .frame(width: 22)
            AvatarView(path: row.member.avatarPath, name: row.member.name, size: 30)
                .overlay(Circle().strokeBorder(speaking ? Color.bbGold : .clear, lineWidth: 1.5))
            VStack(alignment: .leading, spacing: 1) {
                Text(row.member.name)
                    .font(.system(size: 14, weight: speaking ? .semibold : .medium))
                    .foregroundStyle(row.status == .done ? Color.bbInkDim : Color.bbInk).lineLimit(1)
                if let tag = row.member.roleTag, !tag.isEmpty {
                    Text(tag).font(.system(size: 11)).foregroundStyle(Color.bbInkFaint).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if speaking {
                Text(Loc.t("m_queue_speaking").uppercased())
                    .font(.system(size: 10, weight: .bold, design: .monospaced)).kerning(0.5)
                    .foregroundStyle(Color.bbGold)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(speaking ? Color.bbGold.opacity(0.08) : .clear)
        .opacity(row.status == .pending ? 0.5 : 1)
    }

    private func submit(_ session: RoomSession) {
        let text = draft.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        draft = ""
        composerFocused = false
        if isVoice, session.status == .live, session.stageSpeakerId != nil {
            askText = text   // mid-speaker → ask interrupt-now vs after-speaker
        } else {
            session.send(text, mode: "now")
            if isVoice { stage.setUserBubble(text) }   // pop the user's bubble (+countdown) above their seat on the 3D stage
        }
    }

    // Interrupt-vs-queue prompt when interjecting mid-speaker.
    private func askSheet(_ session: RoomSession) -> some View {
        let who = session.stageSpeakerName ?? "the speaker"
        return ZStack {
            Color.black.opacity(0.5).ignoresSafeArea().onTapGesture { askText = nil }
            VStack {
                Spacer()
                VStack(spacing: 12) {
                    Text(Loc.t("m_ask_q", ["who": who]))
                        .font(.system(size: 15)).foregroundStyle(Color.bbInkDim)
                        .multilineTextAlignment(.center)
                    Button { resolveAsk(session, mode: "now") } label: {
                        Text(Loc.t("m_ask_interrupt")).fontWeight(.semibold)
                            .frame(maxWidth: .infinity).padding(.vertical, 8).foregroundStyle(.black)
                    }
                    .buttonStyle(.glassProminent).tint(.bbGold)
                    Button { resolveAsk(session, mode: "after-speaker") } label: {
                        Text(Loc.t("m_ask_after", ["who": who])).fontWeight(.medium)
                            .frame(maxWidth: .infinity).padding(.vertical, 8).foregroundStyle(Color.bbInk)
                    }
                    .buttonStyle(.glass)
                    Button(Loc.t("m_ask_cancel")) { askText = nil }.tint(.bbInkDim).padding(.top, 2)
                }
                .padding(20)
                .background(Color.bbSurface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
                .padding(16)
            }
        }
    }

    private func resolveAsk(_ session: RoomSession, mode: String) {
        if let text = askText {
            session.send(text, mode: mode)
            if isVoice { stage.setUserBubble(text) }   // user's bubble (+countdown) on the 3D stage
        }
        askText = nil; composerFocused = false
    }

    // ── Round-end / vote · bottom-sheet overlay ─────────────────────────────
    // Port of the web round-end card + key-point vote panel (voice-room-shell
    // renderRoundEnd / renderVote). Two phases: a light prompt (Continue / Call
    // the vote / Adjourn) and the key-point vote panel. Presented as a bottom
    // sheet over a light scrim so the 3D stage stays visible behind it.

    private func roundEndTitle(_ session: RoomSession) -> String {
        let done = Loc.t("m_round_done").replacingOccurrences(of: ".", with: "")
            .replacingOccurrences(of: "。", with: "")
        return Loc.t("m_q_round", ["n": "\(session.roundNum)"]) + " · " + done
    }

    // Text rooms · the round-end / vote as a special inline transcript card
    // (mirrors desktop's `.round-prompt-card` / `.round-end-card`). Gold-edged so
    // it reads as a decision beat distinct from the chat bubbles around it. Reuses
    // the same phase content + actions as the voice bottom sheet.
    private func textRoundEndCard(_ session: RoomSession) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(roundEndTitle(session).uppercased())
                .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(1.4)
                .foregroundStyle(Color.bbGold)
                .padding(.horizontal, 16).padding(.top, 16)
            if session.roundEndPhase == .prompt {
                roundEndPrompt(session)
            } else {
                roundVotePanel(session)
            }
        }
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.bbSurface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Color.bbGold.opacity(0.35), lineWidth: 1))
    }

    private func roundEndSheet(_ session: RoomSession) -> some View {
        ZStack {
            // Light scrim · tap to dismiss (the re-open pill brings it back).
            Color.black.opacity(0.45).ignoresSafeArea()
                .onTapGesture { withAnimation(.smooth(duration: 0.25)) { session.dismissRoundEndSheet() } }
            VStack {
                Spacer()
                VStack(spacing: 0) {
                    Capsule().fill(Color.bbInkFaint.opacity(0.5)).frame(width: 36, height: 5).padding(.top, 10).padding(.bottom, 14)
                    Text(roundEndTitle(session).uppercased())
                        .font(.system(size: 12, weight: .bold, design: .monospaced)).kerning(1.4)
                        .foregroundStyle(Color.bbInkDim)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20)
                    if session.roundEndPhase == .prompt {
                        roundEndPrompt(session)
                    } else {
                        roundVotePanel(session)
                    }
                }
                .padding(.bottom, 10)
                .background(Color.bbSurface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
                .padding(.horizontal, 10)
                .padding(.bottom, 6)
            }
            .transition(.move(edge: .bottom))
        }
    }

    // Phase 1 · light prompt. Continue (gold) + Call the vote (only on the light
    // prompt) + Adjourn. The chair's recommendation highlights its button.
    @ViewBuilder
    private func roundEndPrompt(_ session: RoomSession) -> some View {
        VStack(spacing: 10) {
            Button { session.continueRound() } label: {
                sheetLabel(Loc.t("m_continue"), dark: true, recommended: session.roundEndRec == "continue")
            }
            .buttonStyle(.glassProminent).tint(.bbGold)
            if !session.roundEndFormal {
                Button { session.openVote() } label: {
                    sheetLabel(Loc.t("m_vote_adjourn"), dark: false, recommended: session.roundEndRec == "end")
                }
                .buttonStyle(.glass)
            }
            Button { adjourn() } label: { sheetLabel(Loc.t("m_adjourn_file"), dark: false) }
                .buttonStyle(.glass)
        }
        .padding(.horizontal, 16).padding(.top, 16)
    }

    // Phase 2 · key-point vote panel. Eyebrow + voteable points (or skeleton /
    // degraded) + optional tone-shift callout + CTAs.
    @ViewBuilder
    private func roundVotePanel(_ session: RoomSession) -> some View {
        let pts = session.roundKeyPoints.sorted { $0.position < $1.position }
        let eyebrow = !pts.isEmpty ? Loc.t("kp_eyebrow_vote")
            : (session.roundVoteResolved ? Loc.t("kp_eyebrow_degraded") : Loc.t("kp_eyebrow_drafting"))
        VStack(alignment: .leading, spacing: 12) {
            Text(eyebrow)
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(Color.bbInkDim)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !pts.isEmpty {
                ForEach(pts) { kp in keyPointRow(session, kp) }
            } else if !session.roundVoteResolved {
                ForEach(0..<3, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.white.opacity(0.05)).frame(height: 52)
                }
            }
            if let shift = session.roundModeShift { modeShiftCallout(shift) }
            roundVoteCTAs(session)
        }
        .padding(.horizontal, 16).padding(.top, 14)
    }

    private func keyPointRow(_ session: RoomSession, _ kp: RoomSession.KeyPoint) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(kp.body).font(.system(size: 15)).lineSpacing(2).foregroundStyle(Color.bbInk)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                voteChip(session, kp, "up", "arrowtriangle.up.fill", Loc.t("kp_vote_more"))
                voteChip(session, kp, "down", "arrowtriangle.down.fill", Loc.t("kp_vote_drop"))
                Spacer()
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
    }

    private func voteChip(_ session: RoomSession, _ kp: RoomSession.KeyPoint, _ which: String, _ icon: String, _ label: String) -> some View {
        let active = kp.vote == which
        return Button { session.voteKeyPoint(kp.id, which) } label: {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 11, weight: .bold))
                Text(label).font(.system(size: 14, weight: .medium))
            }
            .foregroundStyle(active ? Color.bbBg : Color.bbInkDim)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(active ? Color.bbGold : Color.white.opacity(0.06),
                        in: Capsule())
            .overlay(Capsule().stroke(active ? Color.clear : Color.bbLine, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Loc.t(which == "up" ? "kp_vote_aria_up" : "kp_vote_aria_down"))
    }

    private func modeShiftCallout(_ shift: RoomSession.ModeShift) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(Loc.t("kp_shift_prefix") + shift.to)
                .font(.system(size: 12, weight: .semibold, design: .monospaced)).foregroundStyle(Color.bbGold)
            if !shift.because.isEmpty {
                Text(shift.because).font(.system(size: 14)).foregroundStyle(Color.bbInkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.bbGold.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder
    private func roundVoteCTAs(_ session: RoomSession) -> some View {
        if let shift = session.roundModeShift {
            VStack(spacing: 10) {
                Button { session.switchModeAndContinue(to: shift.to) } label: {
                    sheetLabel(Loc.t("kp_switch_to", ["mode": shift.to]), dark: true)
                }
                .buttonStyle(.glassProminent).tint(.bbGold)
                Button { session.continueRound() } label: {
                    sheetLabel(Loc.t("kp_keep_mode", ["mode": (session.roomMode.isEmpty ? Loc.t("kp_mode_current") : session.roomMode)]), dark: false)
                }
                .buttonStyle(.glass)
                Button { adjourn() } label: { sheetLabel(Loc.t("kp_btn_adjourn"), dark: false) }
                    .buttonStyle(.glass)
            }
            .padding(.top, 2)
        } else {
            VStack(spacing: 10) {
                Button { session.continueRound() } label: { sheetLabel(Loc.t("m_continue"), dark: true) }
                    .buttonStyle(.glassProminent).tint(.bbGold)
                Button { adjourn() } label: { sheetLabel(Loc.t("m_adjourn_file"), dark: false) }
                    .buttonStyle(.glass)
            }
            .padding(.top, 2)
        }
    }

    private func sheetLabel(_ text: String, dark: Bool, recommended: Bool = false) -> some View {
        HStack(spacing: 6) {
            if recommended { Image(systemName: "sparkle").font(.system(size: 12, weight: .semibold)) }
            Text(text).fontWeight(.semibold)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 9)
        .foregroundStyle(dark ? .black : Color.bbInk)
    }

    // Re-open affordance · shown at the bottom when the sheet is dismissed but the
    // round is still awaiting (mirrors the web's vote dot).
    private func roundEndReopenPill(_ session: RoomSession) -> some View {
        Button { withAnimation(.smooth(duration: 0.25)) { session.reopenRoundEnd() } } label: {
            HStack(spacing: 8) {
                Image(systemName: "checklist").font(.system(size: 14, weight: .semibold))
                Text(Loc.t("m_round_reopen")).font(.system(size: 15, weight: .semibold))
            }
            .foregroundStyle(Color.bbInk)
            .padding(.horizontal, 18).frame(height: 48)
        }
        .buttonStyle(.plain).glassEffect(.regular.interactive(), in: Capsule())
        .padding(.bottom, 10)
    }

    // MARK: Room actions

    // Adjourn is a CHOICE, not an instant action · open the overlay (report type
    // + supplement + "Generate report" / "End without report"), mirroring desktop.
    private func adjourn() { adjournFocused = false; withAnimation(.smooth(duration: 0.25)) { showAdjourn = true } }

    /// Commit the adjourn · flip the room to adjourned (engine, fast) and, unless
    /// the user chose to end without a report, open the brief — which generates
    /// lazily with their supplement (so the overlay never blocks on the LLM).
    private func performAdjourn(skipBrief: Bool) {
        adjourning = true
        let supplement = adjournSupplement.trimmingCharacters(in: .whitespacesAndNewlines)
        session?.markAdjourned()
        Task {
            await app.adjournRoom(room.id)
            await app.refresh()
            adjourning = false
            withAnimation(.smooth(duration: 0.2)) { showAdjourn = false }
            if !skipBrief { reportSupplement = supplement; showReport = true }
        }
    }

    // Report modes + per-mode styles (strict desktop parity · brief.ts modes +
    // the spine / variant registries). Exactly THREE modes; each carries its own
    // style set — Report → 6 spines, Magazine → GQ/Vogue, Newspaper → Times/Post.
    // "" style = Auto (the composer picks the spine · the viewer seeds the variant).
    struct ReportMode: Identifiable { let id: String; let label: String; let styles: [(id: String, label: String)] }
    static let reportModes: [ReportMode] = [
        ReportMode(id: "research-note", label: "Report", styles: [
            ("", "Auto"), ("boardroom-dark", "Boardroom"), ("anthropic-essay", "Anthropic"),
            ("a16z-thesis", "a16z"), ("mckinsey-deck", "McKinsey"), ("gartner-note", "Gartner"), ("openai-paper", "OpenAI"),
        ]),
        ReportMode(id: "magazine", label: "Magazine", styles: [("", "Auto"), ("gq", "GQ"), ("vogue", "Vogue")]),
        ReportMode(id: "newspaper", label: "Newspaper", styles: [("", "Auto"), ("times", "Times"), ("post", "Post")]),
    ]
    private var currentReportMode: ReportMode { Self.reportModes.first { $0.id == adjournFmt } ?? Self.reportModes[0] }

    private func adjournSheet(_ session: RoomSession) -> some View {
        ZStack {
            Color.black.opacity(0.5).ignoresSafeArea()
                .onTapGesture { if !adjourning { withAnimation(.smooth(duration: 0.2)) { showAdjourn = false } } }
            VStack {
                Spacer()
                VStack(alignment: .leading, spacing: 0) {
                    Capsule().fill(Color.bbInkFaint.opacity(0.5)).frame(width: 36, height: 5)
                        .frame(maxWidth: .infinity).padding(.top, 10).padding(.bottom, 14)

                    Text(Loc.t("m_adjourn_title").uppercased())
                        .font(.system(size: 12, weight: .bold, design: .monospaced)).kerning(1.4)
                        .foregroundStyle(Color.bbInkDim).padding(.horizontal, 20)

                    // Report mode tiles · exactly three (Report / Magazine / Newspaper).
                    Text(Loc.t("m_adjourn_format")).font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundStyle(Color.bbInkFaint).padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 8)
                    HStack(spacing: 10) {
                        ForEach(Self.reportModes) { m in
                            let on = adjournFmt == m.id
                            Button { adjournFmt = m.id; adjournStyle = "" } label: {     // mode change → reset style to Auto
                                Text(m.label).font(.system(size: 14, weight: .medium))
                                    .frame(maxWidth: .infinity).padding(.vertical, 12)
                                    .foregroundStyle(on ? Color.bbGold : Color.bbInkDim)
                                    .background(on ? Color.bbGold.opacity(0.14) : Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(on ? Color.bbGold : Color.bbLine, lineWidth: 1))
                            }.buttonStyle(.plain)
                        }
                    }.padding(.horizontal, 16)

                    // Per-mode style chips · the spine (Report) or edition (Magazine /
                    // Newspaper). Auto lets the composer / viewer choose.
                    Text(Loc.t("m_rep_style")).font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundStyle(Color.bbInkFaint).padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 8)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(currentReportMode.styles, id: \.id) { s in
                                let on = adjournStyle == s.id
                                Button { adjournStyle = s.id } label: {
                                    Text(s.id.isEmpty ? Loc.t("m_rep_auto") : s.label)
                                        .font(.system(size: 13, weight: .medium))
                                        .padding(.horizontal, 14).padding(.vertical, 9)
                                        .foregroundStyle(on ? Color.bbGold : Color.bbInkDim)
                                        .background(on ? Color.bbGold.opacity(0.14) : Color.white.opacity(0.04), in: Capsule())
                                        .overlay(Capsule().stroke(on ? Color.bbGold : Color.bbLine, lineWidth: 1))
                                }.buttonStyle(.plain)
                            }
                        }.padding(.horizontal, 16)
                    }

                    // Supplement prompt.
                    Text(Loc.t("m_adjourn_supplement")).font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundStyle(Color.bbInkFaint).padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 8)
                    TextField(Loc.t("m_adjourn_supplement_ph"), text: $adjournSupplement, axis: .vertical)
                        .lineLimit(2...4).font(.system(size: 15)).foregroundStyle(Color.bbInk)
                        .focused($adjournFocused)
                        .padding(12).glassRound(12).padding(.horizontal, 16)

                    VStack(spacing: 10) {
                        Button { performAdjourn(skipBrief: false) } label: {
                            HStack { if adjourning { ProgressView().tint(.black) }
                                Text(Loc.t("m_adjourn_generate")).fontWeight(.semibold) }
                            .frame(maxWidth: .infinity).padding(.vertical, 9).foregroundStyle(.black)
                        }
                        .buttonStyle(.glassProminent).tint(.bbGold).disabled(adjourning)
                        Button { performAdjourn(skipBrief: true) } label: {
                            Text(Loc.t("m_adjourn_end")).fontWeight(.medium)
                                .frame(maxWidth: .infinity).padding(.vertical, 9).foregroundStyle(Color.bbInk)
                        }
                        .buttonStyle(.glass).disabled(adjourning)
                    }
                    .padding(.horizontal, 16).padding(.top, 18)
                }
                .padding(.bottom, 16)
                .background(Color.bbSurface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
                .padding(.horizontal, 10).padding(.bottom, 6)
            }
            .transition(.move(edge: .bottom))
        }
    }

    private func delete() {
        guard let api = app.api else { app.removeRoom(room.id); dismiss(); return }
        Task { try? await api.deleteRoom(room.id); app.removeRoom(room.id); dismiss() }
    }

    /// Open the report only when one exists (a filed brief, or a generation already
    /// in flight for this room); otherwise tell the user there's none yet — viewing
    /// must not silently kick off generation (that's the adjourn flow's job).
    private func viewReport() {
        let hasBrief = NativeEngineHost.shared?.latestBriefId(room.id) != nil
        let generating = app.briefJob?.roomId == room.id
        if hasBrief || generating { showReport = true } else { showNoReport = true }
    }
}

/// Live / paused status pill · blinking dot + label (web `.vr-live`).
private struct LiveStatusPill: View {
    let status: RoomStatus
    var body: some View {
        HStack(spacing: 6) {
            PulseDot(color: status == .paused ? .bbAmber : Color(hex: 0xFF3B30), on: status == .live)
            Text(Loc.t(status == .paused ? "m_status_paused" : "m_status_live").uppercased())
                .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(1.2)
                .foregroundStyle(status == .paused ? Color.bbAmber : .white)
        }
        .padding(.horizontal, 14).frame(height: 44)
        .glassPill()
    }
}

private struct TranscriptRow: View {
    let line: RoomSession.Line
    var spokenSentence: String = ""        // non-empty ⇒ this row's TTS is playing · karaoke-highlight this sentence
    @ViewBuilder var body: some View {
        if line.isToolUse {
            WebSearchCard(query: line.searchQuery, sources: line.sources ?? [])
        } else if line.isUser {
            userBubble
        } else if line.isThinking {
            // Pre-token "thinking" row · MUST come before the kind-specific cards
            // (intervention / chair-direct) so a chair note still shows a thinking
            // placeholder rather than an empty card. Chair → centred pending card
            // (phase text + dots); director → inline avatar + TypingDots bubble.
            if line.isChair {
                ChairPendingCard(kind: line.kind)
            } else {
                DirectorTurnBubble(line: line, spokenSentence: spokenSentence)
            }
        } else if line.kind == "intervention" {
            ChairInterventionCard(text: line.text)              // desktop .chair-intervention
        } else if line.kind == "chair-direct" {
            ChairDirectCard(name: line.name, text: line.text, time: line.time)   // desktop .chair-direct
        } else if line.kind == "billing-notice" {
            BillingNoticeCard(text: line.text)                  // desktop .chair-billing-notice
        } else if line.isChair {
            ChairTurnBubble(line: line, spokenSentence: spokenSentence)
        } else {
            DirectorTurnBubble(line: line, spokenSentence: spokenSentence)
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 56)
            Text(line.text)
                .font(.system(size: 16)).lineSpacing(3).foregroundStyle(Color.bbInk)
                .textSelection(.enabled)
                .padding(.horizontal, 16).padding(.vertical, 11)
                .background(Color.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }
}

/// Chair turn · left-aligned gold bubble (clarify / convening / round-prompt / round-end).
/// A pre-token row shows TypingDots in place of the body.
private struct ChairTurnBubble: View {
    let line: RoomSession.Line
    var spokenSentence: String = ""
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AvatarView(path: line.avatarPath, name: line.name, size: 34)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(line.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.bbGold)
                    if let role = line.role, !role.isEmpty {
                        Text(role).font(.system(size: 11, weight: .medium)).foregroundStyle(Color.bbInkDim).lineLimit(1)
                    }
                    if let time = line.time, !time.isEmpty {
                        Text(time).font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.bbInkFaint)
                    }
                }
                bodySlot
                    .padding(.horizontal, 15).padding(.vertical, 11)
                    .background(Color.bbGold.opacity(0.11), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.bbGold.opacity(0.22), lineWidth: 1))
            }
            Spacer(minLength: 40)
        }
    }
    @ViewBuilder private var bodySlot: some View {
        if line.isThinking {
            TypingDots()
        } else {
            Text(karaoke(mdInline(line.text, size: 15), sentence: spokenSentence))
                .font(.system(size: 15)).lineSpacing(4).foregroundStyle(Color.bbInk)
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
    }
}

/// Director turn · left-aligned neutral bubble under a byline. Pre-token row shows
/// TypingDots; a search-grounded turn shows the "🔍 N sources" disclosure below.
private struct DirectorTurnBubble: View {
    let line: RoomSession.Line
    var spokenSentence: String = ""
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AvatarView(path: line.avatarPath, name: line.name, size: 34)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text(line.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.bbGold)
                    if let role = line.role, !role.isEmpty {
                        Text(role).font(.system(size: 11, weight: .medium)).foregroundStyle(Color.bbInkDim).lineLimit(1)
                    }
                    if let model = line.model, !model.isEmpty {
                        Text(model).font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.bbInkFaint).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    if let time = line.time, !time.isEmpty {
                        Text(time).font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.bbInkFaint)
                    }
                }
                bodySlot
                    .padding(.horizontal, 15).padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.bbLine, lineWidth: 1))
                if let sources = line.sources, !sources.isEmpty {
                    DirectorSourcesBadge(sources: sources)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    @ViewBuilder private var bodySlot: some View {
        if line.isThinking {
            TypingDots().frame(maxWidth: .infinity, alignment: .leading)
        } else {
            SelectableText(attributed: karaokeNS(markdownAttributedNS(line.text), sentence: spokenSentence))
        }
    }
}

// MARK: - In-bubble TTS karaoke

/// Highlight the sentence currently being spoken by TTS inside an `AttributedString`
/// body (chair bubble). Exact-substring match against the rendered text — graceful
/// no-op when the sentence carries markdown the body stripped, so it never throws.
func karaoke(_ attr: AttributedString, sentence: String) -> AttributedString {
    let s = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
    guard s.count >= 2 else { return attr }
    var a = attr
    guard let r = a.range(of: s) else { return a }
    a[r].foregroundColor = Color.bbGold
    a[r].backgroundColor = Color.bbGold.opacity(0.16)
    return a
}

/// NSAttributedString twin (director bubble · UIKit `SelectableText`).
func karaokeNS(_ ns: NSAttributedString, sentence: String) -> NSAttributedString {
    let s = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
    guard s.count >= 2 else { return ns }
    let hay = ns.string
    guard let r = hay.range(of: s) else { return ns }
    let m = NSMutableAttributedString(attributedString: ns)
    let nsr = NSRange(r, in: hay)
    m.addAttribute(.foregroundColor, value: UIColor(Color.bbGold), range: nsr)
    m.addAttribute(.backgroundColor, value: UIColor(Color.bbGold.opacity(0.16)), range: nsr)
    return m
}

// MARK: - Web search modules (desktop parity)

/// Numbered web-search sources list · shared by the chair card + director badge.
private struct SourcesList: View {
    let sources: [SearchSource]
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(sources.enumerated()), id: \.offset) { i, s in
                HStack(alignment: .top, spacing: 8) {
                    Text(String(format: "%02d", i + 1))
                        .font(.system(size: 11, weight: .bold, design: .monospaced)).foregroundStyle(Color.bbGold)
                        .frame(width: 20, alignment: .leading)
                    VStack(alignment: .leading, spacing: 2) {
                        title(s)
                        if let host = Self.hostname(s.url) {
                            Text(host).font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.bbInkFaint)
                        }
                        if let d = s.description, !d.isEmpty {
                            Text(d).font(.system(size: 12)).foregroundStyle(Color.bbInkDim).lineLimit(2)
                        }
                    }
                }
            }
        }
    }
    @ViewBuilder private func title(_ s: SearchSource) -> some View {
        let label = (s.title?.isEmpty == false) ? s.title! : (s.url ?? "source")
        if let urlStr = s.url, let url = URL(string: urlStr) {
            Link(destination: url) {
                Text(label + " ↗").font(.system(size: 14, weight: .medium)).foregroundStyle(Color.bbInk).lineLimit(2)
            }
        } else {
            Text(label).font(.system(size: 14, weight: .medium)).foregroundStyle(Color.bbInk).lineLimit(2)
        }
    }
    static func hostname(_ url: String?) -> String? {
        guard let url, let host = URL(string: url)?.host, !host.isEmpty else { return nil }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}

/// Chair web-search CARD · mono "// WEB SEARCH" kicker + "✓ Searched 'q'" +
/// expandable sources. Sits as its own transcript row above the clarify bubble.
private struct WebSearchCard: View {
    let query: String?
    let sources: [SearchSource]
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("// WEB SEARCH").font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(0.8)
                    .foregroundStyle(Color.bbGold)
                Spacer()
                Text("\(sources.count) sources").font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.bbInkDim)
            }
            Button { withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() } } label: {
                HStack(spacing: 7) {
                    Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Color.bbGold)
                    Text("Searched \u{201C}\(query ?? "")\u{201D}").font(.system(size: 14)).foregroundStyle(Color.bbInk).lineLimit(1)
                    Spacer(minLength: 4)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.bbInkDim)
                }
            }.buttonStyle(.plain)
            if expanded { SourcesList(sources: sources) }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.bbGold.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.bbGold.opacity(0.25), lineWidth: 1))
    }
}

/// Director "🔍 N sources" disclosure under the bubble.
private struct DirectorSourcesBadge: View {
    let sources: [SearchSource]
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() } } label: {
                HStack(spacing: 5) {
                    Image(systemName: "magnifyingglass").font(.system(size: 11, weight: .semibold))
                    Text("\(sources.count) sources").font(.system(size: 12, weight: .medium, design: .monospaced))
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .semibold))
                }
                .foregroundStyle(Color.bbInkDim)
            }.buttonStyle(.plain)
            if expanded { SourcesList(sources: sources).padding(.leading, 4) }
        }
    }
}

// MARK: - Chair harness message styles (desktop parity)

/// Chair harness · a centred "ROOM NOTE" reframing note (desktop `.chair-intervention`):
/// transparent, a thin gold rule, a mono kicker, centred body. No byline/footer — it's
/// a marginal moderator note, not a turn.
private struct ChairInterventionCard: View {
    let text: String
    var body: some View {
        VStack(spacing: 10) {
            Rectangle().fill(Color.bbGold.opacity(0.85)).frame(width: 28, height: 1)
            Text(Loc.t("m_chair_room_note")).font(.bbKicker(10)).kerning(2.0).foregroundStyle(Color.bbGold)
            Text(mdInline(text, size: 14)).font(.system(size: 14)).lineSpacing(4)
                .foregroundStyle(Color.bbInkDim).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
    }
}

/// Chair billing-notice (desktop `.chair-billing-notice`) · the in-transcript
/// half of the billing prompt. An amber top rule + mono kicker mark it apart
/// from gold chair cards, so a quota halt reads as "needs attention", not a turn.
private struct BillingNoticeCard: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            Text(Loc.t("m_chair_billing_kicker")).font(.bbKicker(10)).kerning(2.0).foregroundStyle(Color.bbAmber)
            Text(mdInline(text, size: 15)).font(.system(size: 15)).lineSpacing(4).foregroundStyle(Color.bbInk)
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 18).padding(.vertical, 15)
        .background(Color.bbCard, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(alignment: .top) { Rectangle().fill(Color.bbAmber).frame(height: 1.5) }
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.bbLine, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// Chair harness · a lifted "DIRECT FROM CHAIR" panel (desktop `.chair-direct`):
/// a card surface with a gold top edge, a mono kicker, the body, and an author·time
/// footer. The chair speaking procedurally/factually — distinct from a normal turn.
private struct ChairDirectCard: View {
    let name: String
    let text: String
    let time: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            Text(Loc.t("m_chair_direct")).font(.bbKicker(10)).kerning(2.0).foregroundStyle(Color.bbGold)
            Text(mdInline(text, size: 15)).font(.system(size: 15)).lineSpacing(4).foregroundStyle(Color.bbInk)
                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            HStack(spacing: 6) {
                Text(name.uppercased()).font(.bbKicker(10)).kerning(1.4).foregroundStyle(Color.bbInkDim)
                if let time, !time.isEmpty {
                    Text("· \(time)").font(.system(size: 10, design: .monospaced)).foregroundStyle(Color.bbInkFaint)
                }
            }
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 18).padding(.vertical, 15)
        .background(Color.bbCard, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(alignment: .top) { Rectangle().fill(Color.bbGold).frame(height: 1.5) }
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.bbLine, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// Chair pre-token · desktop's centred `.chair-pending` card: a thin gold rule, a
/// mono kicker, an italic phase line, and animated dots. Shown while the chair's
/// LLM spins up (clarify / round-end / convening) before the first token lands.
private struct ChairPendingCard: View {
    let kind: String?
    var body: some View {
        VStack(spacing: 10) {
            Rectangle().fill(Color.bbGold.opacity(0.85)).frame(width: 28, height: 1)
            Text(Loc.t("m_chair_pend_kicker")).font(.bbKicker(10)).kerning(2.0).foregroundStyle(Color.bbGold)
            HStack(spacing: 10) {
                Text(phaseText).font(.system(size: 14)).italic().foregroundStyle(Color.bbInkFaint)
                TypingDots()
            }
        }
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }
    private var phaseText: String {
        switch kind {
        case "clarify":   return Loc.t("m_chair_pend_clarify")
        case "round-end": return Loc.t("m_chair_pend_round_end")
        case "convening": return Loc.t("m_chair_pend_convening")
        default:          return Loc.t("m_chair_pend_default")
        }
    }
}

/// Chair "thinking" placeholder bubble · the text-room twin of the voice stage's
/// thinking pose. Same gold chair-bubble chrome as a real chair turn, but the
/// body is an animated three-dot ellipsis while the first turn spins up.
private struct ChairThinkingBubble: View {
    let name: String
    let avatarPath: String?
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AvatarView(path: avatarPath, name: name.isEmpty ? "—" : name, size: 34)
            VStack(alignment: .leading, spacing: 6) {
                if !name.isEmpty {
                    Text(name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.bbGold)
                }
                TypingDots()
                    .padding(.horizontal, 16).padding(.vertical, 14)
                    .background(Color.bbGold.opacity(0.11), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.bbGold.opacity(0.22), lineWidth: 1))
            }
            Spacer(minLength: 40)
        }
    }
}

/// Three dots with a staggered opacity pulse · the "···" thinking indicator.
/// Opacity-only animation (project rule · no shadow/glow animations).
private struct TypingDots: View {
    @State private var phase = 0
    private let timer = Timer.publish(every: 0.32, on: .main, in: .common).autoconnect()
    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Color.bbGold)
                    .frame(width: 6, height: 6)
                    .opacity(phase == i ? 1 : 0.3)
            }
        }
        .onReceive(timer) { _ in withAnimation(.easeInOut(duration: 0.28)) { phase = (phase + 1) % 3 } }
    }
}

/// Round separator · a centered "ROUND N" mono label flanked by hairlines,
/// marking where one discussion round ends and the next begins.
private struct RoundDivider: View {
    let round: Int
    var body: some View {
        HStack(spacing: 12) {
            Rectangle().fill(Color.bbLine).frame(height: 1)
            Text(Loc.t("m_round_sep", ["n": "\(round)"]))
                .font(.system(size: 11, weight: .semibold, design: .monospaced)).kerning(1.4)
                .textCase(.uppercase)
                .foregroundStyle(Color.bbInkFaint)
                .fixedSize()
            Rectangle().fill(Color.bbLine).frame(height: 1)
        }
        .padding(.vertical, 4)
    }
}

/// Inline markdown → styled AttributedString. The spine treatment is baked PER
/// RUN so the trait + colour survive the View's outer `.font()` /
/// `.foregroundStyle()` (those modifiers otherwise flatten markdown's bold /
/// italic back to plain): `*em*` → gold italic, `**strong**` → ink bold,
/// `` `code` `` → mono on a faint chip. Mirrors web `.vr-md em / strong / code`.
/// Plain runs are left untouched so they inherit the block's base font + colour.
func mdInline(_ s: String, size: CGFloat = 19) -> AttributedString {
    let opts = AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
    guard var attr = try? AttributedString(markdown: s, options: opts) else { return AttributedString(s) }
    // Snapshot ranges first — mutating attributes while iterating `runs` is unsafe.
    let runs = attr.runs.map { ($0.range, $0.inlinePresentationIntent ?? []) }
    for (range, intent) in runs where !intent.isEmpty {
        let bold = intent.contains(.stronglyEmphasized)
        let italic = intent.contains(.emphasized)
        let code = intent.contains(.code)
        var font: Font = code ? .system(size: size - 2, design: .monospaced) : .system(size: size)
        if bold { font = font.weight(.bold) }
        if italic { font = font.italic() }
        attr[range].font = font
        attr[range].inlinePresentationIntent = nil          // baked into .font → don't let SwiftUI re-apply
        if code {
            attr[range].foregroundColor = .bbInk
            attr[range].backgroundColor = Color.white.opacity(0.06)
        } else if italic {
            attr[range].foregroundColor = .bbGold            // em → spine accent (web `.vr-md em`)
        } else if bold {
            attr[range].foregroundColor = .bbInk
        }
    }
    return attr
}

/// Lightweight markdown renderer for director messages · headings, bullets,
/// numbered + blockquote lines, fenced code, and inline emphasis. Mirrors the
/// web `mdToHtml` (no left-border callouts — blockquotes use italic + dim).
struct MarkdownText: View {
    let text: String

    private enum Block { case para(String), heading(String, CGFloat), bullet(String), quote(String), code(String), space }

    // The whole message renders as ONE Text so the selection drags freely across
    // paragraphs, headings and bullets — per-block Text views only let you select
    // within a single block. Block styling (heading weight, bullet glyph, quote
    // italic, inline code) is baked into the AttributedString instead of via view
    // modifiers.
    var body: some View {
        Text(attributed())
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)   // drag to select any partial range; copy from the menu
    }

    /// Set `font` only on runs that don't already carry one (mdInline bakes fonts
    /// onto styled runs — bold / italic / code — so we mustn't clobber those).
    private func baseFont(_ attr: AttributedString, _ font: Font) -> AttributedString {
        var out = attr
        for run in out.runs where run.font == nil { out[run.range].font = font }
        return out
    }

    private func attributed() -> AttributedString {
        var doc = AttributedString("")
        let blocks = parse()
        for (i, b) in blocks.enumerated() {
            if i > 0 { doc += AttributedString("\n") }
            switch b {
            case .space:
                break   // the inter-block "\n" already supplies the blank line
            case .heading(let s, let sz):
                var a = baseFont(mdInline(s, size: sz), .system(size: sz, weight: .bold))
                a.foregroundColor = .bbInk
                doc += a
            case .quote(let s):
                var a = baseFont(mdInline(s, size: 16), .system(size: 16).italic())
                a.foregroundColor = .bbInkDim
                doc += a
            case .bullet(let s):
                var dot = AttributedString("•  ")
                dot.foregroundColor = .bbGold
                dot.font = .system(size: 16)
                doc += dot
                var a = baseFont(mdInline(s, size: 16), .system(size: 16))
                a.foregroundColor = .bbInk
                doc += a
            case .code(let s):
                var a = AttributedString(s)
                a.font = .system(size: 14, design: .monospaced)
                a.foregroundColor = .bbInkDim
                a.backgroundColor = Color.white.opacity(0.06)
                doc += a
            case .para(let s):
                var a = baseFont(mdInline(s, size: 16), .system(size: 16))
                a.foregroundColor = .bbInk
                doc += a
            }
        }
        return doc
    }

    private func parse() -> [Block] {
        var out: [Block] = []
        var inFence = false, codeBuf: [String] = []
        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let t = raw.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("```") {
                if inFence { out.append(.code(codeBuf.joined(separator: "\n"))); codeBuf = []; inFence = false }
                else { inFence = true }
                continue
            }
            if inFence { codeBuf.append(raw); continue }
            if t.isEmpty { out.append(.space) }
            else if t.hasPrefix("### ") { out.append(.heading(String(t.dropFirst(4)), 16)) }
            else if t.hasPrefix("## ")  { out.append(.heading(String(t.dropFirst(3)), 18)) }
            else if t.hasPrefix("# ")   { out.append(.heading(String(t.dropFirst(2)), 20)) }
            else if t.hasPrefix("> ")   { out.append(.quote(String(t.dropFirst(2)))) }
            else if t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("+ ") { out.append(.bullet(String(t.dropFirst(2)))) }
            else if let m = t.range(of: #"^\d+\.\s"#, options: .regularExpression) { out.append(.bullet(String(t[m.upperBound...]))) }
            else { out.append(.para(raw)) }
        }
        if inFence && !codeBuf.isEmpty { out.append(.code(codeBuf.joined(separator: "\n"))) }
        return out
    }
}

// MARK: - Selectable message text (UITextView-backed)

/// A non-editable, *selectable* text view. SwiftUI `Text(...).textSelection(.enabled)`
/// is unreliable for long prose inside a ScrollView/LazyVStack (long-press tends
/// to act on the whole run instead of giving drag-handles for a partial range),
/// so director messages render through a `UITextView` — which gives the native
/// loupe + selection handles + copy/lookup/share menu and lets the user grab any
/// substring. Styling is baked into the `NSAttributedString` (markdown → fonts /
/// colours), matching `MarkdownText`.
struct SelectableText: UIViewRepresentable {
    let attributed: NSAttributedString

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.isEditable = false
        tv.isSelectable = true
        tv.isScrollEnabled = false                 // size to content · lives in the SwiftUI scroll view
        tv.backgroundColor = .clear
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.dataDetectorTypes = []
        tv.tintColor = UIColor(Color.bbGold)        // caret + selection handles
        tv.adjustsFontForContentSizeCategory = false
        tv.setContentCompressionResistancePriority(.required, for: .vertical)
        tv.setContentHuggingPriority(.required, for: .vertical)
        return tv
    }

    func updateUIView(_ tv: UITextView, context: Context) {
        if !tv.attributedText.isEqual(to: attributed) { tv.attributedText = attributed }
    }

    // iOS 16+ · report the wrapped height for the proposed width so the bubble
    // grows to fit (the director bubble is full-width, so width = the proposal).
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let w = proposal.width, w > 0 else { return nil }
        let s = uiView.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude))
        return CGSize(width: w, height: ceil(s.height))
    }
}

/// Inline markdown (bold / italic / code) → `NSAttributedString`, mirroring
/// `mdInline`. `baseBold` / `baseItalic` carry block-level styling (headings,
/// quotes) so a run with no inline intent still reads correctly.
func mdInlineNS(_ s: String, size: CGFloat, color: UIColor, baseBold: Bool = false, baseItalic: Bool = false) -> NSAttributedString {
    let opts = AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
    let parsed = (try? AttributedString(markdown: s, options: opts)) ?? AttributedString(s)
    let out = NSMutableAttributedString()
    for run in parsed.runs {
        let sub = String(parsed[run.range].characters)
        let intent = run.inlinePresentationIntent ?? []
        let em = intent.contains(.emphasized)
        let strong = intent.contains(.stronglyEmphasized)
        let code = intent.contains(.code)
        let bold = baseBold || strong
        let italic = baseItalic || em
        var font: UIFont = code ? .monospacedSystemFont(ofSize: size - 2, weight: .regular)
                                : .systemFont(ofSize: size, weight: bold ? .bold : .regular)
        if italic, !code, let d = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic)) {
            font = UIFont(descriptor: d, size: font.pointSize)
        }
        var attrs: [NSAttributedString.Key: Any] = [.font: font]
        if code {
            attrs[.foregroundColor] = UIColor(Color.bbInk)
            attrs[.backgroundColor] = UIColor.white.withAlphaComponent(0.06)
        } else if em && !baseItalic {
            attrs[.foregroundColor] = UIColor(Color.bbGold)   // <em> → spine accent (quotes stay dim)
        } else {
            attrs[.foregroundColor] = color
        }
        out.append(NSAttributedString(string: sub, attributes: attrs))
    }
    return out
}

/// Block-level markdown → `NSAttributedString` · the UIKit twin of
/// `MarkdownText.attributed()` (headings, bullets, quotes, fenced code, inline
/// emphasis), rendered as ONE attributed string so selection drags freely.
func markdownAttributedNS(_ text: String) -> NSAttributedString {
    let ink = UIColor(Color.bbInk), dim = UIColor(Color.bbInkDim), gold = UIColor(Color.bbGold)
    let out = NSMutableAttributedString()
    var inFence = false, codeBuf: [String] = []
    var blocks: [(kind: String, s: String, sz: CGFloat)] = []
    for raw in text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
        let t = raw.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("```") {
            if inFence { blocks.append(("code", codeBuf.joined(separator: "\n"), 0)); codeBuf = []; inFence = false }
            else { inFence = true }
            continue
        }
        if inFence { codeBuf.append(raw); continue }
        if t.isEmpty { blocks.append(("space", "", 0)) }
        else if t.hasPrefix("### ") { blocks.append(("h", String(t.dropFirst(4)), 16)) }
        else if t.hasPrefix("## ")  { blocks.append(("h", String(t.dropFirst(3)), 18)) }
        else if t.hasPrefix("# ")   { blocks.append(("h", String(t.dropFirst(2)), 20)) }
        else if t.hasPrefix("> ")   { blocks.append(("quote", String(t.dropFirst(2)), 0)) }
        else if t.hasPrefix("- ") || t.hasPrefix("* ") || t.hasPrefix("+ ") { blocks.append(("bullet", String(t.dropFirst(2)), 0)) }
        else if let m = t.range(of: #"^\d+\.\s"#, options: .regularExpression) { blocks.append(("bullet", String(t[m.upperBound...]), 0)) }
        else { blocks.append(("para", raw, 0)) }
    }
    if inFence && !codeBuf.isEmpty { blocks.append(("code", codeBuf.joined(separator: "\n"), 0)) }

    for (i, b) in blocks.enumerated() {
        if i > 0 { out.append(NSAttributedString(string: "\n")) }
        switch b.kind {
        case "space": break
        case "h": out.append(mdInlineNS(b.s, size: b.sz, color: ink, baseBold: true))
        case "quote": out.append(mdInlineNS(b.s, size: 16, color: dim, baseItalic: true))
        case "bullet":
            out.append(NSAttributedString(string: "•  ", attributes: [.font: UIFont.systemFont(ofSize: 16), .foregroundColor: gold]))
            out.append(mdInlineNS(b.s, size: 16, color: ink))
        case "code":
            out.append(NSAttributedString(string: b.s, attributes: [
                .font: UIFont.monospacedSystemFont(ofSize: 14, weight: .regular),
                .foregroundColor: dim, .backgroundColor: UIColor.white.withAlphaComponent(0.06)]))
        default: out.append(mdInlineNS(b.s, size: 16, color: ink))
        }
    }
    let para = NSMutableParagraphStyle(); para.lineSpacing = 3
    out.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: out.length))
    return out
}

// MARK: - Speaking-queue sheet (voice room)

/// The director speaking order for the current round · the current speaker, then
/// the engine's `queue-update` order (head = up next), then everyone else on
/// standby. Replaces the cramped avatar rail as the way to read who's up next.
private struct QueueSheet: View {
    let session: RoomSession
    @Environment(\.dismiss) private var dismiss

    private enum Status { case speaking, upNext, standby }
    private struct Row: Identifiable { let id: String; let member: Member; let status: Status; let position: Int? }

    /// Ordered rows: current speaker → queue order → the rest (standby / already spoke).
    private var rows: [Row] {
        let directors = session.members.filter { $0.id != "__user" && $0.roleKind != "moderator" }
        let byId = Dictionary(directors.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var out: [Row] = []
        var used = Set<String>()
        if let cur = session.stageSpeakerId, let m = byId[cur] {
            out.append(Row(id: cur, member: m, status: .speaking, position: nil)); used.insert(cur)
        }
        var pos = 1
        for id in session.speakingQueue where !used.contains(id) {
            guard let m = byId[id] else { continue }
            out.append(Row(id: id, member: m, status: .upNext, position: pos)); used.insert(id); pos += 1
        }
        for m in directors where !used.contains(m.id) {
            out.append(Row(id: m.id, member: m, status: .standby, position: nil))
        }
        return out
    }

    private var hasActiveQueue: Bool {
        session.stageSpeakerId != nil || !session.speakingQueue.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(Loc.t("m_queue_title"))
                    .font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.bbInk)
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.bbInkDim).frame(width: 30, height: 30)
                        .contentShape(Circle())
                }.buttonStyle(.plain)
            }
            .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 12)

            if !hasActiveQueue {
                Spacer()
                Text(Loc.t("m_queue_empty"))
                    .font(.system(size: 15)).foregroundStyle(Color.bbInkFaint)
                    .multilineTextAlignment(.center).padding(.horizontal, 32)
                Spacer()
            } else {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(rows) { row in rowView(row) }
                    }
                    .padding(.horizontal, 16).padding(.bottom, 24)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.bbBg.ignoresSafeArea())
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private func rowView(_ row: Row) -> some View {
        let speaking = row.status == .speaking
        HStack(spacing: 12) {
            AvatarView(path: row.member.avatarPath, name: row.member.name, size: 40)
                .overlay(Circle().strokeBorder(speaking ? Color.bbGold : .clear, lineWidth: 2))
            VStack(alignment: .leading, spacing: 2) {
                Text(row.member.name)
                    .font(.system(size: 15, weight: speaking ? .semibold : .medium))
                    .foregroundStyle(Color.bbInk).lineLimit(1)
                if let tag = row.member.roleTag, !tag.isEmpty {
                    Text(tag).font(.system(size: 12)).foregroundStyle(Color.bbInkDim).lineLimit(1)
                }
            }
            Spacer()
            statusChip(row)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(Color.bbCard, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .opacity(row.status == .standby ? 0.55 : 1)
    }

    @ViewBuilder
    private func statusChip(_ row: Row) -> some View {
        switch row.status {
        case .speaking:
            Text(Loc.t("m_queue_speaking"))
                .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(0.6)
                .foregroundStyle(Color.bbBg)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Color.bbGold, in: Capsule())
        case .upNext:
            Text("#\(row.position ?? 0)")
                .font(.system(size: 13, weight: .bold, design: .monospaced))
                .foregroundStyle(Color.bbGold)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Color.bbGold.opacity(0.14), in: Capsule())
        case .standby:
            Text(Loc.t("m_queue_standby")).font(.system(size: 12)).foregroundStyle(Color.bbInkFaint)
        }
    }
}
