import SwiftUI

// ════════════════════════════════════════════════════════════════════════════
//  Create flows · New Room + New Director. Styled after public/mobile
//  (renderNewRoom / renderNewAgent): mono-kicker section headers, gold tile
//  grids, a board field that opens a director picker, and an AI-draft → edit →
//  save director flow. Shared building blocks (BBGroup / BBTile) live at the
//  bottom so both screens read identically.
// ════════════════════════════════════════════════════════════════════════════

// MARK: - New Room

/// Convene a new room · subject + format + tone + board (auto-pick or ≥2
/// directors), then `POST /api/rooms`. On success the new room is inserted at
/// the top of the list (it's live) and the sheet dismisses.
/// Seed for a follow-up room · carries the parent's cast / tone / delivery so the
/// new-room sheet opens pre-configured and the user only writes the next question.
struct FollowUpSeed: Identifiable {
    var id: String { parentRoomId }
    let parentRoomId: String
    let tone: String
    let delivery: String
    let directorIds: [String]
}

struct NewRoomView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    var onCreated: (Room) -> Void = { _ in }   // auto-enter the live room after convene (web parity)

    @State private var subject = ""
    @State private var tone = "brainstorm"
    @State private var intensity = "sharp"
    @State private var delivery = "voice"
    @State private var autoPick = true
    @State private var selected: Set<String> = []
    @State private var showPicker = false
    @State private var busy = false
    @State private var errorText: String?
    @State private var parentRoomId: String? = nil   // set for follow-up rooms
    @State private var created = false               // a room was convened → drop the draft (don't re-save on dismiss)
    @State private var restored = false              // one-time draft restore guard
    private let scenario: RoomScenario?               // starter play · resolves its cast in .task
    private let isDefaultFlow: Bool                   // plain New Room (no scenario / follow-up seed) → draft-persisted

    init(followUp: FollowUpSeed? = nil, scenario: RoomScenario? = nil,
         onCreated: @escaping (Room) -> Void = { _ in }) {
        self.onCreated = onCreated
        self.scenario = scenario
        self.isDefaultFlow = (followUp == nil && scenario == nil)
        if let f = followUp {
            _tone = State(initialValue: f.tone)
            _delivery = State(initialValue: f.delivery)
            _autoPick = State(initialValue: f.directorIds.count < 2)   // keep the parent cast when we have it
            _selected = State(initialValue: Set(f.directorIds))
            _parentRoomId = State(initialValue: f.parentRoomId)
        } else if let s = scenario {
            // Starter play · pre-fill the scalar fields now; the cast (handle →
            // id) resolves in .task once the roster is loaded.
            _subject = State(initialValue: s.subject)
            _tone = State(initialValue: s.tone)
            _intensity = State(initialValue: s.intensity)
            _autoPick = State(initialValue: false)
        }
    }

    private let tones: [(id: String, icon: String)] = [
        ("brainstorm", "lightbulb"), ("constructive", "hammer"), ("research", "magnifyingglass"),
        ("debate", "bubble.left.and.bubble.right"), ("critique", "scope"),
    ]
    private let formats: [(id: String, icon: String, key: String)] = [
        ("voice", "mic", "m_rc_voice"), ("text", "text.bubble", "m_rc_text"),
    ]

    private var selectedDirs: [Agent] { app.agents.filter { selected.contains($0.id) } }
    private var canConvene: Bool {
        !subject.trimmingCharacters(in: .whitespaces).isEmpty && (autoPick || selected.count >= 2)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.bbBg.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        BBGroup(Loc.t("m_nr_subject")) {
                            TextField(Loc.t("m_nr_subject_ph"), text: $subject, axis: .vertical)
                                .lineLimit(3...8).font(.system(size: 16)).foregroundStyle(Color.bbInk)
                                .padding(13).glassRound(12)
                        }
                        BBGroup(Loc.t("m_nr_format")) {
                            BBTileGrid {
                                ForEach(formats, id: \.id) { f in
                                    BBTile(icon: f.icon, label: Loc.t(f.key), selected: delivery == f.id) { delivery = f.id }
                                }
                            }
                        }
                        BBGroup(Loc.t("m_nr_tone")) {
                            BBTileGrid {
                                ForEach(tones, id: \.id) { o in
                                    BBTile(icon: o.icon, label: toneName(o.id), selected: tone == o.id) { tone = o.id }
                                }
                            }
                        }
                        BBGroup(Loc.t("m_nr_board")) {
                            VStack(alignment: .leading, spacing: 12) {
                                boardModeSeg
                                boardDetail
                            }
                        }
                        if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
                        Button(action: convene) {
                            HStack {
                                if busy { ProgressView().tint(.black) }
                                Text(busy ? Loc.t("m_nr_convening") : Loc.t("m_nr_convene")).fontWeight(.semibold)
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 8).foregroundStyle(.black)
                        }
                        .buttonStyle(.glassProminent).tint(.bbGold).disabled(!canConvene || busy)
                    }
                    .padding(16)
                }
            }
            .navigationTitle(Loc.t("m_nr_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(Loc.t("common_cancel")) { dismiss() } } }
            .sheet(isPresented: $showPicker) {
                DirectorPickerSheet(selected: $selected)
            }
            .task {
                await app.ensureAgentsLoaded()
                // Resolve a starter play's cast (seed handles → roster ids) once
                // the roster is loaded. Fewer than two matched → fall back to
                // auto-pick so the composer is never stuck below the minimum.
                if let s = scenario, selected.isEmpty {
                    let ids = Set(s.matchedDirectors(in: app.agents).map(\.id))
                    if ids.count >= 2 { selected = ids } else { autoPick = true }
                }
            }
            .onAppear(perform: restoreDraft)
            .onDisappear(perform: persistDraft)
        }
    }

    /// Restore the in-progress composer after an accidental dismiss (default flow
    /// only · scenario / follow-up seed their own fields in `init`). One-shot.
    private func restoreDraft() {
        guard isDefaultFlow, !restored, let d = app.newRoomDraft else { return }
        restored = true
        subject = d.subject; tone = d.tone; intensity = d.intensity
        delivery = d.delivery; autoPick = d.autoPick; selected = d.selected
    }

    /// On dismiss: drop the draft if a room was created, else snapshot the current
    /// input so reopening picks up exactly where the user left off.
    private func persistDraft() {
        guard isDefaultFlow else { return }
        if created { app.newRoomDraft = nil; return }
        var d = AppState.NewRoomDraft()
        d.subject = subject; d.tone = tone; d.intensity = intensity
        d.delivery = delivery; d.autoPick = autoPick; d.selected = selected
        app.newRoomDraft = d.isPristine ? nil : d
    }

    // Board mode · an explicit 2-segment choice (sibling to the Format / Tone
    // tile pickers above), NOT a row that hides the choice behind a sheet. The
    // cast only matters in manual mode, so it's revealed inline below the segments
    // (progressive disclosure) and the picker sheet does exactly one thing — pick.
    private var boardModeSeg: some View {
        HStack(spacing: 10) {
            boardSeg(auto: true,  icon: "sparkles", title: Loc.t("m_nr_auto"))
            boardSeg(auto: false, icon: "person.2", title: Loc.t("m_nr_choose"))
        }
    }

    private func boardSeg(auto: Bool, icon: String, title: String) -> some View {
        let on = autoPick == auto
        return Button {
            withAnimation(.smooth(duration: 0.2)) { autoPick = auto }
            // Choosing "manual" expresses intent to pick — open the list straight
            // away when nothing's selected yet (saves a dead-end empty row + tap).
            if !auto && selected.isEmpty { showPicker = true }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: icon).font(.system(size: 14))
                Text(title).font(.system(size: 14, weight: .medium)).lineLimit(1)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 10)
            .foregroundStyle(on ? Color.bbGold : Color.bbInkDim)
            .background(on ? Color.bbGold.opacity(0.14) : Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).stroke(on ? Color.bbGold : Color.bbLine, lineWidth: 1))
        }.buttonStyle(.plain)
    }

    @ViewBuilder private var boardDetail: some View {
        if autoPick {
            Text(Loc.t("m_nr_auto_hint")).font(.system(size: 13)).lineSpacing(2)
                .foregroundStyle(Color.bbInkDim)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4).padding(.bottom, 2)
        } else {
            Button { showPicker = true } label: {
                HStack(spacing: 12) {
                    if selectedDirs.isEmpty {
                        Image(systemName: "person.2").font(.system(size: 18)).foregroundStyle(Color.bbGold).frame(width: 30)
                        Text(Loc.t("m_nr_choose_prompt")).font(.bbCardTitle).foregroundStyle(Color.bbInk)
                    } else {
                        HStack(spacing: -8) {
                            ForEach(selectedDirs.prefix(6)) { a in
                                AvatarView(path: a.avatarPath, name: a.name, size: 30)
                                    .overlay(Circle().stroke(Color.bbSurface, lineWidth: 2))
                            }
                        }
                        Text(Loc.t("m_nr_directors", ["n": String(selected.count)])).font(.bbCardTitle).foregroundStyle(Color.bbInk)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 13)).foregroundStyle(Color.bbInkFaint)
                }
                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.bbSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
            }.buttonStyle(.plain)
            if selected.count < 2 {
                Text(Loc.t("m_toast_pick_two")).font(.system(size: 12)).foregroundStyle(Color.bbInkFaint).padding(.horizontal, 4)
            }
        }
    }

    private func convene() {
        busy = true; errorText = nil
        let subjectText = subject.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                // Dispatches to the native engine or the REST server.
                let room = try await app.createRoom(
                    subject: subjectText, mode: tone, intensity: intensity,
                    deliveryMode: delivery, autoPick: autoPick, agentIds: Array(selected),
                    parentRoomId: parentRoomId
                )
                app.rooms.insert(room, at: 0)
                busy = false
                created = true            // room convened → clear the draft on dismiss (don't restore a submitted one)
                app.newRoomDraft = nil
                onCreated(room)   // navigate straight into the live room so its convene + TTS play
            } catch {
                busy = false
                errorText = (error as? APIClient.APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

/// Board picker · a single-purpose multi-select of the roster. Mode (auto vs
/// manual) is owned by the segmented control on the New Room screen, so this
/// sheet no longer carries an auto-pick toggle or a disabled state — it only
/// picks directors. A live count + "pick ≥2" hint sit in the nav bar.
struct DirectorPickerSheet: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Binding var selected: Set<String>

    var body: some View {
        NavigationStack {
            ZStack {
                Color.bbBg.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(app.agents) { a in
                            Button { toggle(a.id) } label: {
                                let on = selected.contains(a.id)
                                HStack(spacing: 12) {
                                    AvatarView(path: a.avatarPath, name: a.name, size: 38)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(a.name).font(.bbCardTitle).foregroundStyle(Color.bbInk)
                                        if let role = a.roleTag, !role.isEmpty {
                                            Text(role).font(.system(size: 12)).foregroundStyle(Color.bbInkDim).lineLimit(1)
                                        }
                                    }
                                    Spacer()
                                    Image(systemName: on ? "checkmark.circle.fill" : "circle")
                                        .font(.system(size: 20))
                                        .foregroundStyle(on ? Color.bbGold : Color.bbInkFaint)
                                }
                                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                .background(on ? Color.bbGold.opacity(0.10) : Color.bbSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(on ? Color.bbGold : Color.bbLine, lineWidth: 1))
                            }.buttonStyle(.plain)
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle(selected.count >= 2
                             ? Loc.t("m_nr_directors", ["n": String(selected.count)])
                             : Loc.t("m_toast_pick_two"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(Loc.t("m_dpick_done")) { dismiss() } } }
            .task { await app.ensureAgentsLoaded() }
        }
    }

    private func toggle(_ id: String) {
        if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
    }
}

// MARK: - New Director

/// Describe → AI-draft → edit → save. Mirrors the web `renderNewAgent`: a
/// description + build-mode (Signal / Full) that calls `generate-spec`, then an
/// editable form (name · role · bio · instruction · model) that POSTs to
/// `/api/agents`. Signal = the quick web-grounded draft; Full = the deep 7-phase
/// persona build (`generate-persona` SSE job, rendered by `PersonaBuildView`).
struct NewDirectorView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss

    enum Step { case describe, generating, buildingFull, form }
    @State private var step: Step = .describe
    @State private var desc = ""
    @State private var mode = "signal"          // signal | full
    @State private var errorText: String?

    // Form fields (pre-filled from the spec; all editable).
    @State private var name = ""
    @State private var role = ""
    @State private var bio = ""
    @State private var instruction = ""
    @State private var modelV = "sonnet-4-6"
    @State private var models: [ModelInfo] = []
    @State private var saving = false

    // Full-persona deep build · the live SSE job lives in AppState (`app.directorBuild`)
    // so it survives closing this sheet; these are the fields it hands the form.
    @State private var personaJobId: String?          // set → save() finalizes the job instead of createAgent
    @State private var personaCoverQuote: String?
    @State private var personaAbility: [String: Double]?

    // 3D avatar · rendered off a hidden WKWebView (the desktop Avatar3DSnap
    // pipeline); the dice re-rolls a new random seed. Saved as `avatarPath`.
    @State private var avatarRenderer = AvatarRenderer()
    @State private var avatarSeed: String?
    @State private var avatarDataUrl: String?
    @State private var avatarRendering = false
    @State private var avatarConfig: Avatar3DConfig?      // set when the user customises (捏脸); persisted as avatar3d
    @State private var showAvatarEditor = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.bbBg.ignoresSafeArea()
                Group {
                    switch step {
                    case .describe:     describeView
                    case .generating:   generatingView
                    case .buildingFull: buildingFullView
                    case .form:         formView
                    }
                }
            }
            .navigationTitle(Loc.t("m_na_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(Loc.t("common_cancel")) { dismiss() } } }
            // Hidden 3D-avatar render surface · kept in-hierarchy (occluded by the
            // bg) so its WebGL context stays warm and renders happen offscreen.
            .background { avatarRendererLayer }
        }
        .onAppear {
            // Reopened with a background build that's still running — or that
            // finished while closed — drop the user back into the build screen
            // (PersonaBuildView settles a finished build straight into the form).
            if let s = app.directorBuild?.status, s == .running || s == .done { step = .buildingFull }
        }
        .onDisappear {
            // Keep a RUNNING build alive (it lives in AppState) so the Directors
            // "+" can show a spinner and reopen it. Only clean up a finished /
            // failed leftover that the user didn't carry into the form.
            if let b = app.directorBuild, b.status != .running {
                b.cancel(); app.directorBuild = nil
            }
        }
    }

    @ViewBuilder
    private var avatarRendererLayer: some View {
        if let url = app.api?.assetURL("/mobile/avatar-embed.html") {
            AvatarRenderWebView(url: url, controller: avatarRenderer)
                .frame(width: 48, height: 48)
                .opacity(0.012)
                .allowsHitTesting(false)
        }
    }

    /// Roll a new random seed and render its 3D portrait into `avatarDataUrl`.
    /// Also captures the seed's config into `avatarConfig` so the rolled look is
    /// PERSISTED as `avatar3d` — without this the room renders a different per-id
    /// default and the portrait the user picked "doesn't take effect".
    private func reroll() {
        let seed = AvatarRenderer.randomSeed()
        avatarSeed = seed
        avatarRendering = true
        Task {
            let (url, cfg) = await avatarRenderer.render(seed: seed, size: 256)
            if let url, !url.isEmpty { avatarDataUrl = url }
            if let cfg, let parsed = Avatar3DConfig(jsonObject: cfg) { avatarConfig = parsed }
            avatarRendering = false
        }
    }

    // ── Step 2b · full-persona deep build (gamified) ───────────────
    @ViewBuilder
    private var buildingFullView: some View {
        if let persona = app.directorBuild {
            PersonaBuildView(
                model: persona,
                subject: desc.trimmingCharacters(in: .whitespacesAndNewlines),
                onDone: { applyPersonaFinal($0) },
                onAbort: { app.directorBuild?.abort(); app.directorBuild = nil; step = .describe },
                onError: { msg in errorText = msg; app.directorBuild?.abort(); app.directorBuild = nil; step = .describe }
            )
        } else {
            ProgressView().tint(.bbGold)
        }
    }

    // ── Step 1 · describe ──────────────────────────────────────────
    private var describeView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                BBGroup(Loc.t("m_na_desc_label")) {
                    TextField(Loc.t("m_na_desc_ph"), text: $desc, axis: .vertical)
                        .lineLimit(5...12).font(.system(size: 16)).foregroundStyle(Color.bbInk)
                        .padding(13).glassRound(12)
                }
                BBGroup(Loc.t("m_na_build_mode")) {
                    HStack(spacing: 10) {
                        modeTile("signal", Loc.t("m_na_signal"), Loc.t("m_na_signal_deck"))
                        modeTile("full", Loc.t("m_na_full"), Loc.t("m_na_full_deck"))
                    }
                }
                if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
                Button { generate() } label: {
                    Text(Loc.t("m_na_generate")).fontWeight(.semibold)
                        .frame(maxWidth: .infinity).padding(.vertical, 8).foregroundStyle(.black)
                }
                .buttonStyle(.glassProminent).tint(.bbGold)
                .disabled(desc.trimmingCharacters(in: .whitespaces).count < 4)

                Button { startManual() } label: {
                    Text(Loc.t("m_na_manual")).font(.system(size: 15, weight: .medium))
                        .frame(maxWidth: .infinity).foregroundStyle(Color.bbInkDim)
                }.buttonStyle(.plain).padding(.top, 2)
            }
            .padding(16)
        }
    }

    private func modeTile(_ id: String, _ title: String, _ deck: String) -> some View {
        Button { mode = id } label: {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 15, weight: .semibold))
                Text(deck).font(.system(size: 12)).foregroundStyle(Color.bbInkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(14)
            .foregroundStyle(mode == id ? Color.bbGold : Color.bbInk)
            .background(mode == id ? Color.bbGold.opacity(0.14) : Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(mode == id ? Color.bbGold : Color.bbLine, lineWidth: 1))
        }.buttonStyle(.plain)
    }

    // ── Step 2 · generating · gamified "signal build" animation ────
    private var generatingView: some View {
        SignalGenView(phases: Self.signalPhases)
    }

    /// The six cosmetic build steps shown lighting up one-by-one (mirrors the
    /// web `SIGNAL_PHASES`). Localised; the real `generate-spec` promise flips
    /// to the form when it resolves regardless of where the clock is.
    private static var signalPhases: [String] { (1...6).map { Loc.t("m_na_p\($0)") } }

    // ── Step 3 · form ──────────────────────────────────────────────
    private var formView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                avatarSection
                BBGroup(Loc.t("m_na_name")) {
                    TextField(Loc.t("m_na_name"), text: $name)
                        .font(.system(size: 16)).foregroundStyle(Color.bbInk).padding(13).glassRound(12)
                }
                BBGroup(Loc.t("m_na_role")) {
                    TextField(Loc.t("m_na_role"), text: $role)
                        .font(.system(size: 16)).foregroundStyle(Color.bbInk).padding(13).glassRound(12)
                }
                BBGroup(Loc.t("m_ap_bio")) {
                    TextField(Loc.t("m_na_intro_ph"), text: $bio, axis: .vertical)
                        .lineLimit(2...5).font(.system(size: 16)).foregroundStyle(Color.bbInk).padding(13).glassRound(12)
                }
                BBGroup(Loc.t("m_ap_instruction")) {
                    TextField(Loc.t("m_na_instr_ph"), text: $instruction, axis: .vertical)
                        .lineLimit(4...14).font(.system(size: 15)).foregroundStyle(Color.bbInk).padding(13).glassRound(12)
                }
                BBGroup(Loc.t("m_model_director")) {
                    Menu {
                        ForEach(models) { m in Button(m.label) { modelV = m.modelV } }
                    } label: {
                        HStack {
                            Text(models.first { $0.modelV == modelV }?.label ?? modelV)
                                .font(.bbCardTitle).foregroundStyle(Color.bbInk)
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down").font(.system(size: 13)).foregroundStyle(Color.bbInkFaint)
                        }
                        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.bbSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
                    }
                    Text(Loc.t("m_model_director_hint")).font(.system(size: 12)).foregroundStyle(Color.bbInkDim).padding(.horizontal, 2)
                }
                if let errorText { Text(errorText).font(.footnote).foregroundStyle(.red) }
                Button { save() } label: {
                    HStack {
                        if saving { ProgressView().tint(.black) }
                        Text(saving ? Loc.t("m_na_saving") : Loc.t("m_na_save")).fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 8).foregroundStyle(.black)
                }
                .buttonStyle(.glassProminent).tint(.bbGold)
                .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(16)
        }
        .task {
            if models.isEmpty, let api = app.api { models = (try? await api.listModels()) ?? [] }
            if avatarDataUrl == nil && !avatarRendering { reroll() }   // first portrait on entering the form
        }
    }

    /// 3D-avatar picker · circular portrait + a dice that re-rolls a new seed.
    private var avatarSection: some View {
        BBGroup(Loc.t("m_na_avatar")) {
            HStack(spacing: 14) {
                Button { if avatarDataUrl != nil { showAvatarEditor = true } } label: {
                    ZStack {
                        if let url = avatarDataUrl {
                            AvatarView(path: url, name: name.isEmpty ? "?" : name, size: 64)
                        } else {
                            Circle().fill(Color.bbSurface).frame(width: 64, height: 64)
                                .overlay(Circle().stroke(Color.bbLine, lineWidth: 1))
                        }
                        if avatarRendering {
                            Circle().fill(Color.black.opacity(0.45)).frame(width: 64, height: 64)
                            ProgressView().tint(.bbGold)
                        }
                    }
                }
                .buttonStyle(.plain).disabled(avatarRendering || avatarDataUrl == nil)
                Text(Loc.t("m_na_avatar_hint"))
                    .font(.system(size: 12)).foregroundStyle(Color.bbInkDim)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button { reroll() } label: {
                    Image(systemName: "dice")
                        .font(.system(size: 19, weight: .medium)).foregroundStyle(Color.bbInk)
                        .frame(width: 48, height: 48).contentShape(Circle())
                }
                .buttonStyle(.plain).glassCircle().disabled(avatarRendering)
            }
        }
        .sheet(isPresented: $showAvatarEditor) {
            if let url = app.api?.assetURL("/mobile/avatar-editor-embed.html") {
                AvatarEditorView(url: url, seed: avatarSeed ?? AvatarRenderer.randomSeed(), existing: avatarConfig) { png, cfg in
                    avatarDataUrl = png
                    avatarConfig = cfg
                }
            }
        }
    }

    // ── Actions ────────────────────────────────────────────────────
    private func startManual() {
        name = ""; role = "Director"; bio = ""; instruction = ""; modelV = "sonnet-4-6"
        errorText = nil; step = .form
    }

    private func generate() {
        let d = desc.trimmingCharacters(in: .whitespacesAndNewlines)
        guard d.count >= 4 else { errorText = Loc.t("m_toast_describe_first"); return }
        errorText = nil
        // Full mode · the deep 7-phase persona build. On-device it runs through
        // the native engine (NativePersonaSource); on a server build, the REST SSE.
        if mode == "full" { startFullBuild(personaSource, d); return }
        step = .generating
        Task {
            do {
                let spec = try await app.generateSpec(d, webSearch: false)
                name = spec.name ?? ""
                role = spec.roleLabel ?? "Director"
                bio = spec.bio ?? ""
                instruction = spec.instruction ?? ""
                modelV = spec.modelV ?? modelV
                step = .form
            } catch {
                errorText = (error as? APIClient.APIError)?.errorDescription ?? Loc.t("m_na_gen_fail")
                step = .describe
            }
        }
    }

    /// Kick off the deep 7-phase persona build and hand the live job to
    /// `PersonaBuildView`. The job streams server-side; the kickoff returns fast.
    private func startFullBuild(_ source: any PersonaEventSource, _ d: String) {
        step = .buildingFull
        Task {
            do {
                let jobId = try await source.generatePersona(d, locale: Loc.locale)
                let m = PersonaBuildModel(jobId: jobId, source: source)
                app.directorBuild = m
                m.start()
            } catch {
                errorText = (error as? APIClient.APIError)?.errorDescription ?? Loc.t("m_na_gen_fail")
                app.directorBuild = nil
                step = .describe
            }
        }
    }

    /// The build finished · pre-fill the editable form from the drafted persona
    /// and remember the jobId so save() materializes the job (server has the spec).
    private func applyPersonaFinal(_ f: PersonaFinal) {
        name = f.guessName ?? ""
        role = (f.guessRoleTag?.isEmpty == false ? f.guessRoleTag : nil) ?? "Director"
        bio = f.bio ?? ""
        instruction = f.instruction ?? ""
        personaCoverQuote = f.coverQuote
        personaAbility = f.ability
        personaJobId = app.directorBuild?.jobId
        app.directorBuild?.cancel()
        app.directorBuild = nil          // build consumed → "+" stops loading
        step = .form
    }

    /// Full-persona build runs through the native engine on-device, the REST SSE
    /// otherwise — both behind the `PersonaEventSource` seam.
    private var personaSource: any PersonaEventSource {
        if app.isNative { return NativePersonaSource.shared }
        if let api = app.api { return api }
        return NativePersonaSource.shared
    }

    private func save() {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty else { return }
        saving = true; errorText = nil
        Task {
            do {
                if let jobId = personaJobId {
                    // Full-persona path · materialize the built persona (native:
                    // insert from the cached build; server: re-read the job spec).
                    try await personaSource.savePersona(jobId: jobId, name: n, role: role, bio: bio,
                                                        instruction: instruction, modelV: modelV,
                                                        coverQuote: personaCoverQuote, ability: personaAbility,
                                                        avatarPath: avatarDataUrl, avatar3d: avatarConfig?.dictionary)
                } else {
                    guard let api = app.api else { errorText = Loc.t("connect_bad"); saving = false; return }
                    try await api.createAgent(name: n, role: role, bio: bio, instruction: instruction,
                                              modelV: modelV, avatarPath: avatarDataUrl, avatar3d: avatarConfig?.dictionary)
                }
                await app.reloadAgents()
                saving = false; dismiss()
            } catch {
                saving = false
                errorText = (error as? APIClient.APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

// MARK: - Signal build animation

/// Gamified "signal build" generation screen · a spinning orb (gold arc + a
/// pulsing core), an eased progress bar, and six phases lighting up one by one.
/// 1:1 with the web `renderNAGeneratingSignal`: cosmetic only — every frame is
/// derived from elapsed time via `TimelineView(.animation)` (no `repeatForever`
/// state to fight the per-frame redraw), the bar eases toward 95 % and holds,
/// and the real `generate-spec` promise flips the step to the form on resolve.
private struct SignalGenView: View {
    let phases: [String]
    @State private var start = Date()

    var body: some View {
        TimelineView(.animation) { ctx in
            let el = max(0, ctx.date.timeIntervalSince(start))
            let pct = min(0.95, 1 - exp(-el / 4.2))                       // eases to 95 %, never finishes
            let idx = min(phases.count - 1, Int(pct * Double(phases.count)))
            let angle = (el / 0.9).truncatingRemainder(dividingBy: 1) * 360   // 0.9 s per revolution
            let corePulse = 0.775 + 0.225 * sin(el / 1.4 * 2 * .pi)       // 0.55 ↔ 1 over 1.4 s
            let dotPulse = 0.55 + 0.45 * (0.5 + 0.5 * sin(el * 2 * .pi))  // active-dot pulse, 1 s

            VStack(spacing: 0) {
                Spacer(minLength: 8)
                // Orb · gray ring + chasing gold arc + pulsing core glyph.
                ZStack {
                    Circle().stroke(Color.bbLine, lineWidth: 2)
                    Circle().trim(from: 0, to: 0.28)
                        .stroke(Color.bbGold, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        .rotationEffect(.degrees(angle))
                    Image(systemName: "cpu").font(.system(size: 24, weight: .medium))
                        .foregroundStyle(Color.bbGold).opacity(corePulse)
                }
                .frame(width: 76, height: 76)
                .padding(.bottom, 18)

                Text(phases[idx]).font(.system(size: 17, weight: .bold))
                    .foregroundStyle(Color.bbInk).multilineTextAlignment(.center)
                    .animation(.easeInOut(duration: 0.2), value: idx)
                Text(Loc.t("m_na_sig_step", ["n": "\(idx + 1)", "total": "\(phases.count)"]))
                    .font(.system(size: 11, design: .monospaced)).kerning(0.6)
                    .foregroundStyle(Color.bbInkFaint).padding(.top, 5)

                // Eased progress bar.
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.08))
                        Capsule().fill(Color.bbGold).frame(width: geo.size.width * pct)
                    }
                }
                .frame(maxWidth: 280).frame(height: 5).padding(.vertical, 20)

                // Phase checklist · done (gold dot · ink-dim) → active (gold
                // pulsing dot · ink) → pending (faint dot · faint text).
                VStack(alignment: .leading, spacing: 11) {
                    ForEach(Array(phases.enumerated()), id: \.offset) { i, p in
                        HStack(spacing: 11) {
                            Circle().fill(i <= idx ? Color.bbGold : Color.bbInkFaint)
                                .frame(width: 8, height: 8)
                                .opacity(i == idx ? dotPulse : 1)
                            Text(p).font(.system(size: 14))
                                .foregroundStyle(i == idx ? Color.bbInk : (i < idx ? Color.bbInkDim : Color.bbInkFaint))
                        }
                    }
                }
                .frame(maxWidth: 280, alignment: .leading)
                Spacer(minLength: 8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(.horizontal, 16)
    }
}

// MARK: - Shared building blocks

/// A labelled section · mono uppercase kicker over its content (1:1 with the
/// web `.vr-set-group` header).
struct BBGroup<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title; self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(1.6)
                .foregroundStyle(Color.bbInkDim).padding(.horizontal, 4)
            content
        }
    }
}

/// A 3-column grid of tiles (format / tone pickers).
struct BBTileGrid<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
            content
        }
    }
}

/// A selectable icon+label tile · gold fill/border when selected (web `.vr-tile`).
struct BBTile: View {
    let icon: String?
    let label: String
    let selected: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 5) {
                if let icon { Image(systemName: icon).font(.system(size: 17)) }
                Text(label).font(.system(size: 12, weight: .medium)).lineLimit(1).minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 10).padding(.horizontal, 4)
            .foregroundStyle(selected ? Color.bbGold : Color.bbInkDim)
            .background(selected ? Color.bbGold.opacity(0.14) : Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).stroke(selected ? Color.bbGold : Color.bbLine, lineWidth: 1))
        }.buttonStyle(.plain)
    }
}

/// Localised tone name · `m_tone_<id>` (falls back to the id).
func toneName(_ id: String) -> String { Loc.t("m_tone_\(id)") }
