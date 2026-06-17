import SwiftUI
import UIKit
import AVFoundation

/// Hexagonal ability radar · the SwiftUI counterpart of the web `renderRadarSvg`.
/// Draws the grid rings + spokes, the filled value polygon and per-axis dots,
/// with mono labels around the rim.
struct RadarChart: View {
    let axes: [String]                 // ordered axis keys
    let labels: [String: String]       // key → short uppercase label
    let values: [String: Double]       // key → value (0…maxValue)
    var maxValue: Double = 10
    var accent: Color = .bbGold

    /// Vertex for axis `i` of `n` at distance `r` from `center`.
    private func vertex(_ i: Int, _ n: Int, _ center: CGPoint, _ r: CGFloat) -> CGPoint {
        let a = -CGFloat.pi / 2 + 2 * .pi * CGFloat(i) / CGFloat(n)
        return CGPoint(x: center.x + r * cos(a), y: center.y + r * sin(a))
    }

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height)
            let center = CGPoint(x: geo.size.width / 2, y: side / 2)
            let radius = side / 2 - 28          // leave room for the rim labels
            let n = axes.count
            ZStack {
                Canvas { ctx, _ in
                    for ring in 1...3 {                              // grid rings · 3 concentric (33/66/100%), matching the desktop radar
                        let rr = radius * CGFloat(ring) / 3
                        var p = Path()
                        for i in 0..<n { let pt = vertex(i, n, center, rr); i == 0 ? p.move(to: pt) : p.addLine(to: pt) }
                        p.closeSubpath()
                        ctx.stroke(p, with: .color(.white.opacity(0.08)), lineWidth: 1)
                    }
                    for i in 0..<n {                                 // spokes
                        var p = Path(); p.move(to: center); p.addLine(to: vertex(i, n, center, radius))
                        ctx.stroke(p, with: .color(.white.opacity(0.08)), lineWidth: 1)
                    }
                    var vp = Path()                                  // value polygon
                    for i in 0..<n {
                        let v = values[axes[i]] ?? maxValue / 2
                        let pt = vertex(i, n, center, radius * CGFloat(min(1, max(0, v / maxValue))))
                        i == 0 ? vp.move(to: pt) : vp.addLine(to: pt)
                    }
                    vp.closeSubpath()
                    ctx.fill(vp, with: .color(accent.opacity(0.22)))
                    ctx.stroke(vp, with: .color(accent), lineWidth: 1.5)
                    for i in 0..<n {                                 // dots
                        let v = values[axes[i]] ?? maxValue / 2
                        let pt = vertex(i, n, center, radius * CGFloat(min(1, max(0, v / maxValue))))
                        ctx.fill(Path(ellipseIn: CGRect(x: pt.x - 2.5, y: pt.y - 2.5, width: 5, height: 5)), with: .color(accent))
                    }
                }
                ForEach(Array(axes.enumerated()), id: \.offset) { i, key in
                    let pt = vertex(i, n, center, radius + 16)
                    Text(labels[key] ?? key.uppercased())
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .foregroundStyle(Color.bbInkDim)
                        .position(x: pt.x, y: pt.y)
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

/// Text that clamps to `lineLimit` lines and reveals a "Show more" toggle only
/// when it actually overflows (measured with the matching UIFont). Used for the
/// long prose blocks — bio / instruction / memory notes.
struct ExpandableText: View {
    let text: String
    var lineLimit: Int = 3
    var size: CGFloat = 17
    var color: Color = .bbInk
    @State private var expanded = false
    @State private var truncated = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(.system(size: size)).foregroundStyle(color)
                .lineLimit(expanded ? nil : lineLimit)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(GeometryReader { proxy in
                    Color.clear
                        .onAppear { measure(proxy.size.width) }
                        .onChange(of: proxy.size.width) { _, w in measure(w) }
                })
            if truncated {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
                } label: {
                    Text(expanded ? Loc.t("m_ap_show_less") : Loc.t("m_ap_show_more"))
                        .font(.footnote.weight(.semibold)).foregroundStyle(Color.bbGold)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func measure(_ width: CGFloat) {
        guard width > 1 else { return }
        let font = UIFont.systemFont(ofSize: size)
        let full = (text as NSString).boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font], context: nil
        ).height
        let t = full > font.lineHeight * CGFloat(lineLimit) + 1
        if t != truncated { DispatchQueue.main.async { truncated = t } }
    }
}

/// Director profile · a native iOS-26 grouped Settings screen (`Form` + inset
/// sections), so row heights, fonts, separators and section headers all come
/// from the system. Editable bio / instruction / rules (PATCH), web-search
/// toggle, model + voice pickers, chair memory notes, delete.
struct AgentProfileView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    let agent: Agent

    @State private var full: Agent?
    @State private var bio = ""
    @State private var instruction = ""
    @State private var webSearch = false
    @State private var stats: AgentStats?
    @State private var memories: [AgentMemory] = []
    @State private var rules: [String] = []
    @State private var rulesSeeded = false
    @State private var modelV = ""
    @State private var models: [ModelInfo] = []
    @State private var voice: AgentVoice?
    @State private var voices: [VoiceOption] = []
    @State private var showVoicePicker = false
    @State private var showVoiceClone = false
    @State private var voiceProvider: String?   // active voice provider (from /api/voices)
    @State private var previewingId: String?
    @State private var previewLoadingId: String?   // synth/network in flight → spinner (before audio starts)
    @State private var audio: AVAudioPlayer?
    @State private var editing: EditField?
    @State private var draft = ""
    @State private var confirmDelete = false
    @State private var showRename = false     // rename alert (custom directors only)
    @State private var nameDraft = ""
    @State private var showDossier = false   // full-persona dossier sheet
    // 3D avatar re-roll · same hidden-WebView Avatar3DSnap renderer as new-director.
    @State private var avatarRenderer = AvatarRenderer()
    @State private var avatarRendering = false
    @State private var showAvatarEditor = false

    // Ability radar · canonical axis order + short labels (mirrors the web
    // RADAR_AXES / RADAR_LABEL). The server `ability` object is keyed by these.
    private static let radarAxes = ["dissent", "pattern_recall", "rigor", "empathy", "narrative", "decisiveness"]
    private static let radarLabels = ["dissent": "DISSENT", "pattern_recall": "RECALL", "rigor": "RIGOR",
                                      "empathy": "EMPATHY", "narrative": "NARRATIVE", "decisiveness": "DECIDE"]
    // Emotions offered in the voice section · "" = provider default.
    private static let emotions = ["", "happy", "calm", "fluent", "sad", "angry", "surprised"]
    private static let rulesMax = 5

    enum EditField: String, Identifiable {
        case bio, instruction, note
        var id: String { rawValue }
        var title: String {
            switch self {
            case .bio: return Loc.t("m_ap_bio")
            case .instruction: return Loc.t("m_ap_instruction")
            case .note: return Loc.t("m_ap_note")
            }
        }
    }

    private var shown: Agent { full ?? agent }
    private var isChair: Bool { shown.roleKind == "moderator" || shown.roleKind == "chair" }
    /// Rename is offered ONLY for user-created directors · a built-in seed
    /// director / the chair keeps its canonical name (`isSeed == false` means
    /// user-created; nil → unknown → not yet renameable until the profile loads).
    private var canRename: Bool { shown.isSeed == false && !isChair }

    // MARK: Body · native grouped Form

    var body: some View {
        Form {
            headerSection
            bioSection
            radarSection
            if let ps = shown.personaSpec, ps.hasContent { dossierSection(ps) }
            modelSection
            voiceSection
            instructionSection
            // Web search is a CHAIR-only capability · the chair grounds time-sensitive
            // initial questions for the whole room. Directors no longer search.
            if isChair { webSearchSection }
            rulesSection
            if isChair { memorySection }
            activitySection
            if !isChair { deleteSection }
        }
        .scrollContentBackground(.hidden)
        .background(Color.bbBg.ignoresSafeArea())
        .background { avatarRendererLayer }   // hidden 3D-avatar render surface (non-chair only)
        .tint(Color.bbGold)
        .navigationTitle(shown.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .sheet(item: $editing) { editor($0) }
        .sheet(isPresented: $showAvatarEditor) {
            if let url = app.api?.assetURL("/mobile/avatar-editor-embed.html") {
                AvatarEditorView(url: url, seed: agent.id, existing: shown.avatar3d) { png, cfg in
                    Task { await patch(["avatarPath": png, "avatar3d": cfg.dictionary]) }
                }
            }
        }
        .sheet(isPresented: $showVoicePicker) { voicePickerSheet }
        .sheet(isPresented: $showVoiceClone) {
            VoiceCloneView(agentId: agent.id, agentName: shown.name, provider: voiceProvider ?? "minimax") { vid, prov, model, _ in
                Task { await applyClonedVoice(vid, prov, model) }
            }
            .environment(app)
        }
        .sheet(isPresented: $showDossier) {
            if let ps = shown.personaSpec { PersonaDossierView(name: shown.name, spec: ps) }
        }
        .alert(Loc.t("m_ap_del_dir"), isPresented: $confirmDelete) {
            Button(Loc.t("common_cancel"), role: .cancel) {}
            Button(Loc.t("m_delete_do"), role: .destructive) { Task { await deleteAgent() } }
        } message: { Text(Loc.t("m_ap_del_confirm", ["name": shown.name])) }
        .alert(Loc.t("m_ap_rename"), isPresented: $showRename) {
            TextField(Loc.t("m_ap_name"), text: $nameDraft)
            Button(Loc.t("common_cancel"), role: .cancel) {}
            Button(Loc.t("m_ap_save")) { Task { await renameAgent() } }
        }
    }

    /// Commit a rename · custom directors only (UI gates it via `canRename`).
    private func renameAgent() async {
        let v = nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canRename, !v.isEmpty, v != shown.name else { return }
        await patch(["name": v])
    }

    // MARK: Header banner

    private var roleLine: String {
        var parts: [String] = []
        if let tag = shown.roleTag, !tag.isEmpty { parts.append(tag) }
        if let h = shown.handle, !h.isEmpty { parts.append(h) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var avatarRendererLayer: some View {
        if !isChair, let url = app.api?.assetURL("/mobile/avatar-embed.html") {
            AvatarRenderWebView(url: url, controller: avatarRenderer)
                .frame(width: 48, height: 48)
                .opacity(0.012)
                .allowsHitTesting(false)
        }
    }


    private var headerSection: some View {
        Section {
            HStack(spacing: 14) {
                AvatarRing(path: shown.avatarPath, name: shown.name, size: 58, gold: isChair)
                    .overlay {
                        if avatarRendering {
                            ZStack { Circle().fill(Color.black.opacity(0.45)); ProgressView().tint(.bbGold) }
                        }
                    }
                    .contentShape(Circle())
                    .onTapGesture { if !isChair, !avatarRendering { showAvatarEditor = true } }   // tap → 捏脸 editor
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 7) {
                        Text(shown.name).font(.title3.weight(.semibold)).foregroundStyle(Color.bbInk)
                        if canRename {
                            Button { nameDraft = shown.name; showRename = true } label: {
                                Image(systemName: "pencil")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Color.bbGold)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Loc.t("m_ap_rename"))
                        }
                    }
                    if !roleLine.isEmpty { Text(roleLine).font(.subheadline).foregroundStyle(.secondary) }
                }
                Spacer()
                Text((isChair ? Loc.t("m_ap_moderator") : Loc.t("m_ap_available")).uppercased())
                    .font(.caption2.weight(.bold)).kerning(0.6)
                    .foregroundStyle(isChair ? Color.bbGold : Color.secondary)
            }
            .padding(.vertical, 6)
            if let q = shown.coverQuote, !q.isEmpty {
                Text("\u{201C}\(q)\u{201D}")
                    .font(.system(size: 16, weight: .regular, design: .serif)).italic()
                    .foregroundStyle(Color.bbGold)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // Explicit affordance for the 捏脸 editor · the avatar tap-gesture alone
            // wasn't discoverable. Chair avatar is fixed, so the button is director-only.
            if !isChair {
                Button { showAvatarEditor = true } label: {
                    Label(Loc.t("m_av_edit"), systemImage: "wand.and.stars")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                        .foregroundStyle(Color.bbGold)
                        .background(Color.bbGold.opacity(0.10), in: Capsule())
                        .overlay(Capsule().stroke(Color.bbGold.opacity(0.35), lineWidth: 1))
                }
                .buttonStyle(.plain).disabled(avatarRendering)
                .padding(.top, 2)
            }
        }
        .listRowBackground(Color.bbCard)
    }

    /// Section header with a trailing "Edit" button (used for bio + instruction).
    private func editHeader(_ title: String, _ action: @escaping () -> Void) -> some View {
        HStack {
            Text(title)
            Spacer()
            Button(Loc.t("m_ap_edit"), action: action)
                .font(.footnote.weight(.semibold)).foregroundStyle(Color.bbGold).textCase(nil)
        }
    }

    // MARK: Bio

    private var bioSection: some View {
        Section {
            if bio.isEmpty {
                Text(Loc.t("m_ap_bio_empty")).foregroundStyle(.secondary)
            } else {
                ExpandableText(text: bio, lineLimit: 3, size: 17, color: .bbInk)
            }
        } header: {
            editHeader(Loc.t("m_ap_bio")) { draft = bio; editing = .bio }
        }
        .listRowBackground(Color.bbCard)
    }

    // MARK: Ability radar

    private var radarSection: some View {
        let radar = shown.abilityRadar ?? [:]
        let scale = (radar.values.max() ?? 10) > 10 ? 100.0 : 10.0
        return Section(Loc.t("m_ap_radar")) {
            RadarChart(axes: Self.radarAxes, labels: Self.radarLabels, values: radar, maxValue: scale)
                .frame(height: 240)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            ForEach(Self.radarAxes, id: \.self) { key in
                let val = radar[key] ?? scale / 2
                HStack(spacing: 12) {
                    Text(Self.radarLabels[key] ?? key.uppercased())
                        .font(.system(size: 12, weight: .semibold, design: .monospaced)).kerning(0.5)
                        .foregroundStyle(Color.bbInkDim)
                        .frame(width: 88, alignment: .leading)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.white.opacity(0.08))
                            Capsule().fill(Color.bbGold)
                                .frame(width: max(3, geo.size.width * min(1, val / scale)))
                        }
                    }
                    .frame(height: 6)
                    Text(String(Int(val.rounded())))
                        .font(.system(size: 13, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color.bbInk)
                        .frame(width: 22, alignment: .trailing)
                }
                .padding(.vertical, 3)
            }
        }
        .listRowBackground(Color.bbCard)
    }

    // MARK: Persona dossier (full-persona directors only)

    /// Teaser card mirroring the desktop `renderPersonaDossierSection` · a mono
    /// kicker, a 6-cell count grid (the lengths the spec carries), and a CTA that
    /// opens the full dossier sheet. Only rendered when `personaSpec.hasContent`.
    private func dossierSection(_ ps: PersonaSpec) -> some View {
        let cells: [(String, Int)] = [
            (Loc.t("m_dossier_concepts"), ps.spec?.loadBearingConcepts?.count ?? 0),
            (Loc.t("m_dossier_referents"), ps.spec?.referentSet?.count ?? 0),
            (Loc.t("m_dossier_rules"), ps.rules?.count ?? 0),
            (Loc.t("m_dossier_voice"), ps.fewShot?.count ?? 0),
            (Loc.t("m_dossier_checks"), ps.reflectionChecklist?.count ?? 0),
            (Loc.t("m_dossier_evals"), ps.evalSet?.count ?? 0),
        ]
        return Section {
            Button { showDossier = true } label: {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 7) {
                        Circle().fill(Color.bbGold).frame(width: 6, height: 6)
                        Text(Loc.t("m_dossier_kicker"))
                            .font(.system(size: 11, weight: .semibold, design: .monospaced)).kerning(0.7)
                            .foregroundStyle(Color.bbGold).lineLimit(1).minimumScaleFactor(0.8)
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                    }
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 14) {
                        ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(String(cell.1))
                                    .font(.system(size: 22, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(Color.bbInk)
                                Text(cell.0.uppercased())
                                    .font(.system(size: 10, weight: .semibold, design: .monospaced)).kerning(0.4)
                                    .foregroundStyle(Color.bbInkDim).lineLimit(1).minimumScaleFactor(0.7)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    Text(Loc.t("m_dossier_open").uppercased())
                        .font(.system(size: 11, weight: .semibold, design: .monospaced)).kerning(0.6)
                        .foregroundStyle(Color.bbGold)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } header: {
            Text(Loc.t("m_dossier_title"))
        }
        .listRowBackground(Color.bbCard)
    }

    // MARK: Model

    private var pickableModels: [ModelInfo] { models.filter { $0.reachable ?? true } }
    private var modelBinding: Binding<String> {
        Binding(get: { modelV }, set: { selectModel($0) })
    }

    private var modelSection: some View {
        Section(Loc.t("m_ap_model")) {
            Picker(Loc.t("m_ap_model"), selection: modelBinding) {
                ForEach(pickableModels) { m in Text(m.label).tag(m.modelV) }
                if pickableModels.allSatisfy({ $0.modelV != modelV }) && !modelV.isEmpty {
                    Text(modelV).tag(modelV)   // keep the current value selectable even if unreachable
                }
            }
        }
        .listRowBackground(Color.bbCard)
    }

    // MARK: Voice

    private var currentVoiceLabel: String {
        guard let v = voice, let vid = v.voiceId, !vid.isEmpty else { return Loc.t("m_ap_voice_none") }
        return voices.first { $0.voiceId == vid }?.name ?? vid
    }
    private var currentEmotion: String { voice?.emotion ?? "" }
    private var emotionBinding: Binding<String> {
        Binding(get: { currentEmotion }, set: { setEmotion($0) })
    }

    private var voiceSection: some View {
        Section(Loc.t("m_ap_voice")) {
            Button { showVoicePicker = true } label: {
                HStack {
                    Text(Loc.t("m_ap_voice_pick")).foregroundStyle(Color.bbInk)
                    Spacer()
                    Text(currentVoiceLabel).foregroundStyle(.secondary).lineLimit(1)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Picker(Loc.t("m_ap_emotion"), selection: emotionBinding) {
                ForEach(Self.emotions, id: \.self) { e in
                    Text(e.isEmpty ? Loc.t("m_ap_emotion_default") : e.capitalized).tag(e)
                }
            }
            .disabled(voice?.voiceId == nil)
            if voice?.voiceId != nil {
                Button { Task { await preview(nil) } } label: {
                    HStack(spacing: 6) {
                        if previewLoadingId == "current" {
                            ProgressView().controlSize(.mini).tint(.bbGold)
                            Text(Loc.t("m_ap_voice_loading"))
                        } else {
                            Image(systemName: previewingId == "current" ? "stop.fill" : "play.fill")
                            Text(previewingId == "current" ? Loc.t("m_ap_voice_stop") : Loc.t("m_ap_voice_preview"))
                        }
                    }
                    .foregroundStyle(Color.bbGold)
                }
            }
            // Clone voice · only when the active TTS provider supports it
            // (MiniMax / ElevenLabs) and we're not editing the chair.
            if canClone {
                Button { showVoiceClone = true } label: {
                    Label(Loc.t("m_ap_voice_clone"), systemImage: "waveform.badge.mic").foregroundStyle(Color.bbGold)
                }
            }
        }
        .listRowBackground(Color.bbCard)
    }

    /// Voice cloning is offered when the active voice provider is MiniMax or
    /// ElevenLabs (OpenAI / browser don't clone) and this isn't the chair.
    private var canClone: Bool {
        !isChair && (voiceProvider == "minimax" || voiceProvider == "elevenlabs")
    }

    /// A play/preview button used inside the voice-picker rows.
    private func previewButton(for option: VoiceOption?) -> some View {
        let id = option?.id ?? "current"
        return Button { Task { await preview(option) } } label: {
            Group {
                if previewLoadingId == id {
                    ProgressView().controlSize(.mini).tint(.bbGold)
                } else {
                    Image(systemName: previewingId == id ? "stop.fill" : "play.fill")
                        .font(.system(size: 13)).foregroundStyle(Color.bbGold)
                }
            }
            .frame(width: 32, height: 32)
            .background(Color.bbGold.opacity(0.14), in: Circle())
        }
        .buttonStyle(.plain)
    }

    private var voicePickerSheet: some View {
        NavigationStack {
            List {
                if voices.isEmpty {
                    Text(Loc.t("m_ap_voice_empty")).foregroundStyle(.secondary)
                        .listRowBackground(Color.bbCard)
                } else {
                    ForEach(voices) { v in
                        HStack(spacing: 10) {
                            Button { selectVoice(v) } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(v.name).foregroundStyle(Color.bbInk)
                                        if let lang = v.language, !lang.isEmpty {
                                            Text(lang).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer(minLength: 8)
                                    if v.voiceId == voice?.voiceId {
                                        Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Color.bbGold)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            previewButton(for: v)
                        }
                        .listRowBackground(Color.bbCard)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.bbBg.ignoresSafeArea())
            .navigationTitle(Loc.t("m_ap_voice_pick"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(Loc.t("common_done")) { showVoicePicker = false }
                }
            }
            .tint(Color.bbGold)
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: Instruction

    private var instructionSection: some View {
        Section {
            if instruction.isEmpty {
                Text(Loc.t("m_ap_instr_empty")).foregroundStyle(.secondary)
            } else {
                ExpandableText(text: instruction, lineLimit: 3, size: 17, color: .bbInk)
            }
        } header: {
            editHeader(Loc.t("m_ap_instruction")) { draft = instruction; editing = .instruction }
        }
        .listRowBackground(Color.bbCard)
    }

    // MARK: Web search

    private var webSearchBinding: Binding<Bool> {
        Binding(get: { webSearch }, set: { v in webSearch = v; Task { await patch(["webSearchEnabled": v]) } })
    }

    private var webSearchSection: some View {
        Section {
            Toggle(isOn: webSearchBinding) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Loc.t("m_ap_websearch")).foregroundStyle(Color.bbInk)
                    Text(Loc.t("m_ap_websearch_sub")).font(.caption).foregroundStyle(.secondary)
                }
            }
            .tint(Color.bbGold)
        }
        .listRowBackground(Color.bbCard)
    }

    // MARK: Rules (editable · swipe to delete)

    private func ruleBinding(_ i: Int) -> Binding<String> {
        Binding(get: { i < rules.count ? rules[i] : "" },
                set: { if i < rules.count { rules[i] = $0 } })
    }

    private var rulesSection: some View {
        Section(Loc.t("m_ap_rules")) {
            ForEach(rules.indices, id: \.self) { i in
                TextField(Loc.t("m_ap_rule_ph"), text: ruleBinding(i), axis: .vertical)
                    .foregroundStyle(Color.bbInk)
                    .onSubmit { Task { await saveRules() } }
            }
            .onDelete { idx in rules.remove(atOffsets: idx); Task { await saveRules() } }
            if rules.count < Self.rulesMax {
                Button { rules.append("") } label: {
                    Label(Loc.t("m_ap_rule_add"), systemImage: "plus").foregroundStyle(Color.bbGold)
                }
            }
        }
        .listRowBackground(Color.bbCard)
    }

    // MARK: Memory (chair · swipe to delete)

    private var memorySection: some View {
        Section(Loc.t("m_ap_mem_chair")) {
            if memories.isEmpty {
                Text(Loc.t("m_ap_notes_none")).foregroundStyle(.secondary)
            } else {
                ForEach(memories) { note in
                    ExpandableText(text: note.content, lineLimit: 3, size: 17, color: .bbInk)
                }
                .onDelete { idx in Task { await deleteNotes(idx) } }
            }
            Button { draft = ""; editing = .note } label: {
                Label(Loc.t("m_ap_note_add"), systemImage: "plus").foregroundStyle(Color.bbGold)
            }
        }
        .listRowBackground(Color.bbCard)
    }

    // MARK: Activity

    private var activitySection: some View {
        Section(Loc.t("m_ap_activity")) {
            statRow(Loc.t("m_ap_stat_rooms"), stats?.rooms)
            statRow(Loc.t("m_ap_stat_rounds"), stats?.rounds)
            statRow(Loc.t("m_ap_stat_tokens"), stats?.tokens)
        }
        .listRowBackground(Color.bbCard)
    }

    private func statRow(_ label: String, _ value: Int?) -> some View {
        LabeledContent(label) {
            Text(value.map(String.init) ?? "—").font(.body.monospacedDigit()).foregroundStyle(Color.bbInk)
        }
    }

    // MARK: Delete

    private var deleteSection: some View {
        Section {
            Button(role: .destructive) { confirmDelete = true } label: {
                Text(Loc.t("m_ap_del_dir")).frame(maxWidth: .infinity)
            }
        }
        .listRowBackground(Color.bbCard)
    }

    // MARK: Editor sheet (bio / instruction / new note)

    private func editor(_ field: EditField) -> some View {
        NavigationStack {
            ZStack {
                Color.bbBg.ignoresSafeArea()
                VStack(spacing: 0) {
                    TextEditor(text: $draft)
                        .scrollContentBackground(.hidden)
                        .font(.system(size: 17))
                        .foregroundStyle(Color.bbInk)
                        .padding(12)
                        .background(Color.bbCard, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .frame(maxHeight: .infinity)
                }
                .padding(18)
            }
            .navigationTitle(field.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(Loc.t("common_cancel")) { editing = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(Loc.t("m_ap_save")) { Task { await save(field) } }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: Data

    private func load() async {
        seed(agent)
        guard let api = app.api else { return }
        if models.isEmpty, let ms = try? await api.listModels() { models = ms }
        // One /api/voices round-trip · it carries both the catalog and the active
        // provider (a second call just doubled the MiniMax live-fetch wait).
        if let resp = try? await api.listVoicesFull() {
            if voices.isEmpty { voices = resp.voices }
            if let p = resp.provider { voiceProvider = p }
        }
        if let detail = try? await api.getAgent(agent.id) {
            full = detail
            seed(detail)
            if !rulesSeeded { rules = detail.userRules ?? []; rulesSeeded = true }
        }
        if let s = try? await api.agentStats(agent.id) { stats = s }
        if isChair, let mem = try? await api.listMemories(agent.id) { memories = mem }
    }

    /// Seed editable copies · skips while an editor is open so a late response
    /// can't clobber in-progress text.
    private func seed(_ a: Agent) {
        if let mv = a.modelV, !mv.isEmpty { modelV = mv }
        if let v = a.voice, voice == nil { voice = v }
        // Show the clone entry instantly when the director already has a voice
        // (its provider == the active one); the /api/voices fetch refines it.
        if voiceProvider == nil, let p = a.voice?.provider, !p.isEmpty { voiceProvider = p }
        guard editing == nil else { return }
        if let b = a.bio { bio = b }
        if let i = a.instruction { instruction = i }
        if let ws = a.webSearchEnabled { webSearch = ws }
    }

    private func selectModel(_ mv: String) {
        guard mv != modelV else { return }
        modelV = mv
        Task { await patch(["modelV": mv]) }
    }

    // MARK: Voice actions

    /// Resolve provider/model for a voice · the option carries them; fall back
    /// to the current voice's provider/model when picking emotion only.
    private func selectVoice(_ v: VoiceOption) {
        let provider = v.provider ?? voice?.provider ?? "minimax"
        let model = v.model ?? voice?.model ?? "speech-2.8-hd"
        voice = AgentVoice(provider: provider, model: model, voiceId: v.voiceId, emotion: voice?.emotion)
        showVoicePicker = false
        Task { await patchVoice() }
    }

    private func setEmotion(_ e: String) {
        guard let v = voice else { return }
        voice = AgentVoice(provider: v.provider, model: v.model, voiceId: v.voiceId, emotion: e.isEmpty ? nil : e)
        Task { await patchVoice() }
    }

    private func patchVoice() async {
        guard let v = voice, let vid = v.voiceId, !vid.isEmpty else { return }
        var body: [String: Any] = [
            "provider": v.provider ?? "minimax",
            "model": v.model ?? "speech-2.8-hd",
            "voiceId": vid,
        ]
        if let e = v.emotion, !e.isEmpty { body["emotion"] = e }
        await patch(["voice": body])
    }

    /// A clone completed · the server already wrote the agent's voice_json, so
    /// adopt it locally, refresh the catalog (the new clone now lists), and patch
    /// once more to sync the app's agent cache + keep any prior emotion.
    private func applyClonedVoice(_ voiceId: String, _ provider: String, _ model: String) async {
        voice = AgentVoice(provider: provider, model: model, voiceId: voiceId, emotion: voice?.emotion)
        await patchVoice()
        if let api = app.api, let vs = try? await api.listVoices() { voices = vs }
    }

    /// Audition a voice · `option` nil = the current selection.
    private func preview(_ option: VoiceOption?) async {
        let id = option?.id ?? "current"
        // Tapping the active row (loading OR playing) stops it.
        if previewingId == id || previewLoadingId == id { stopAudio(); return }
        guard let api = app.api else { return }
        let provider = option?.provider ?? voice?.provider ?? "minimax"
        let model = option?.model ?? voice?.model ?? "speech-2.8-hd"
        let voiceId = option?.voiceId ?? voice?.voiceId ?? ""
        guard !voiceId.isEmpty else { return }
        stopAudio()                    // drop any other in-flight / playing preview
        previewLoadingId = id          // spinner while the clip is synthesised + fetched
        let data = await api.previewVoice(provider: provider, model: model, voiceId: voiceId, emotion: voice?.emotion)
        // Bail if the user stopped / switched to another row while we were fetching.
        guard previewLoadingId == id else { return }
        previewLoadingId = nil
        guard let data else { return }
        play(data, id: id)
    }

    private func play(_ data: Data, id: String) {
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        audio = try? AVAudioPlayer(data: data)
        if audio == nil { previewingId = nil; return }
        previewingId = id              // loading → playing
        audio?.play()
        let dur = audio?.duration ?? 0
        Task {
            try? await Task.sleep(nanoseconds: UInt64((dur + 0.2) * 1_000_000_000))
            if previewingId == id { previewingId = nil }
        }
    }

    private func stopAudio() { audio?.stop(); audio = nil; previewingId = nil; previewLoadingId = nil }

    private func save(_ field: EditField) async {
        let val = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        switch field {
        case .bio:
            bio = val; editing = nil; await patch(["bio": val])
        case .instruction:
            instruction = val; editing = nil; await patch(["instruction": val])
        case .note:
            editing = nil
            await addNote(val)
        }
    }

    private func patch(_ fields: [String: Any]) async {
        guard let api = app.api else { return }
        if let updated = try? await api.patchAgent(agent.id, fields) {
            full = updated
            app.replaceAgent(updated)
        }
    }

    private func saveRules() async {
        let clean = rules.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        await patch(["userRules": clean])
    }

    private func addNote(_ content: String) async {
        let body = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, let api = app.api else { return }
        memories.insert(AgentMemory(content: body), at: 0)   // optimistic
        if let saved = try? await api.addMemory(agent.id, content: body),
           let i = memories.firstIndex(where: { $0.content == body && $0.id != saved.id }) {
            memories[i] = saved
        }
    }

    private func deleteNotes(_ offsets: IndexSet) async {
        let targets = offsets.compactMap { $0 < memories.count ? memories[$0] : nil }
        for n in targets { await deleteNote(n) }
    }

    private func deleteNote(_ note: AgentMemory) async {
        memories.removeAll { $0.id == note.id }
        if let api = app.api { try? await api.deleteMemory(agent.id, note.id) }
    }

    private func deleteAgent() async {
        guard let api = app.api else { return }
        try? await api.deleteAgent(agent.id)
        app.dropAgent(agent.id)
        dismiss()
    }
}
