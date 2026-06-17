import SwiftUI
import AVFoundation
import UniformTypeIdentifiers
import BoardroomVoice

/// Records a short voice sample (AAC m4a) for cloning. Mic permission + level /
/// elapsed metering; hard-capped at 3 min like the desktop recorder.
@MainActor
final class CloneRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
    @Published var isRecording = false
    @Published var elapsed: TimeInterval = 0
    @Published var level: CGFloat = 0          // 0…1 normalised input level
    @Published var recordedURL: URL?

    let maxDuration: TimeInterval = 180
    private var recorder: AVAudioRecorder?
    private var timer: Timer?

    func requestPermission() async -> Bool {
        await withCheckedContinuation { cont in
            AVAudioApplication.requestRecordPermission { ok in cont.resume(returning: ok) }
        }
    }

    func start() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("clone-sample.m4a")
        try? FileManager.default.removeItem(at: url)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 32000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        do {
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try AVAudioSession.sharedInstance().setActive(true)
            let rec = try AVAudioRecorder(url: url, settings: settings)
            rec.delegate = self
            rec.isMeteringEnabled = true
            rec.record()
            recorder = rec
            recordedURL = nil
            elapsed = 0
            isRecording = true
            timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
        } catch { isRecording = false }
    }

    private func tick() {
        guard let rec = recorder, rec.isRecording else { return }
        rec.updateMeters()
        elapsed = rec.currentTime
        // dBFS (-160…0) → 0…1 with a gentle floor at -50dB.
        let db = rec.averagePower(forChannel: 0)
        level = CGFloat(max(0, min(1, (db + 50) / 50)))
        if elapsed >= maxDuration { stop() }
    }

    func stop() {
        timer?.invalidate(); timer = nil
        recorder?.stop()
        recordedURL = recorder?.url
        recorder = nil
        isRecording = false
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    func reset() {
        stop()
        if let url = recordedURL { try? FileManager.default.removeItem(at: url) }
        recordedURL = nil
        elapsed = 0
    }
}

/// Director voice-clone sheet · mirrors the desktop flow (record OR import a
/// sample, optional label + MiniMax Group ID, clone, then preview the cloned
/// voice with an editable line before applying it). Progress is shown inline.
struct VoiceCloneView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss

    let agentId: String
    let agentName: String
    let provider: String                                   // "minimax" | "elevenlabs"
    let onApplied: (_ voiceId: String, _ provider: String, _ model: String, _ label: String) -> Void

    private enum Stage { case setup, cloning, success, failed }
    private enum Source: String, CaseIterable { case record, importFile }

    @StateObject private var recorder = CloneRecorder()
    @State private var stage: Stage = .setup
    @State private var source: Source = .record
    @State private var importedURL: URL?
    @State private var importedName = ""
    @State private var label = ""
    @State private var showImporter = false
    @State private var micDenied = false
    @State private var showGroupIdAlert = false   // MiniMax clone needs a GroupID that isn't configured yet

    // Progress (synthetic stage animation while the single clone call runs).
    @State private var progressStage = 0                   // 0 prepare · 1 upload · 2 clone
    @State private var errorCode = ""

    // Success preview.
    @State private var clonedVoiceId = ""
    @State private var clonedModel = ""
    @State private var clonedLabel = ""
    @State private var sampleLine = ""
    @State private var previewing = false
    @State private var preparedAudio: AVAudioPlayer?

    private static let scriptPrompt = "The quick brown fox jumps over the lazy dog. She sells seashells by the seashore. How vexingly quick daft zebras jump! Sphinx of black quartz, judge my vow."

    private var isMiniMax: Bool { provider == "minimax" }
    private var hasAudio: Bool { recorder.recordedURL != nil || importedURL != nil }
    private var audioURL: URL? { source == .record ? recorder.recordedURL : importedURL }

    /// The MiniMax GroupID to clone with · the one configured in API-key settings,
    /// else the GroupID embedded in the active key's JWT. nil ⇒ not configured →
    /// the clone is blocked with a guide-to-settings alert.
    private var effectiveGroupId: String? {
        let stored = MiniMaxConfig.groupId
        if !stored.isEmpty { return stored }
        if let key = NativeEngineHost.shared?.activeVoiceKey() { return VoiceCloneService.extractMiniMaxGroupId(key) }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                switch stage {
                case .setup: setupSections
                case .cloning: cloningSection
                case .success: successSections
                case .failed: failedSection
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.bbBg.ignoresSafeArea())
            .navigationTitle(Loc.t("m_vc_title", ["name": agentName]))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(Loc.t("common_cancel")) { recorder.reset(); dismiss() }
                }
            }
            .tint(Color.bbGold)
        }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.audio, .mpeg4Audio, .mp3, .wav]) { result in
            if case .success(let url) = result { adoptImported(url) }
        }
        .interactiveDismissDisabled(stage == .cloning)
        .alert(Loc.t("m_vc_group_needed_title"), isPresented: $showGroupIdAlert) {
            Button(Loc.t("common_ok"), role: .cancel) {}
        } message: {
            Text(Loc.t("m_vc_group_needed_msg"))
        }
    }

    // MARK: Setup

    @ViewBuilder private var setupSections: some View {
        Section {
            Picker("", selection: $source) {
                Text(Loc.t("m_vc_record")).tag(Source.record)
                Text(Loc.t("m_vc_import")).tag(Source.importFile)
            }
            .pickerStyle(.segmented)
            .frame(height: 52)
            .onAppear { Self.configureSegmentedAppearance() }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 6, leading: 4, bottom: 6, trailing: 4))
        }
        if source == .record { recordSection } else { importSection }
        detailsSection
    }

    private var recordSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 14) {
                Text(Loc.t("m_vc_script_label")).font(.caption.weight(.semibold)).foregroundStyle(Color.bbInkDim)
                Text(Self.scriptPrompt).font(.system(size: 15)).foregroundStyle(Color.bbInk).lineSpacing(3)
                HStack(spacing: 14) {
                    Button { toggleRecord() } label: {
                        ZStack {
                            Circle().fill(recorder.isRecording ? Color.red : Color.bbGold)
                                .frame(width: 56, height: 56)
                                .scaleEffect(1 + recorder.level * 0.18)
                                .animation(.easeOut(duration: 0.08), value: recorder.level)
                            Image(systemName: recorder.isRecording ? "stop.fill" : "mic.fill")
                                .font(.system(size: 22, weight: .bold)).foregroundStyle(Color.bbBg)
                        }
                    }
                    .buttonStyle(.plain)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(Self.fmt(recorder.isRecording ? recorder.elapsed : (recorder.recordedURL != nil ? recorder.elapsed : 0)))
                            .font(.system(size: 22, weight: .semibold, design: .monospaced)).foregroundStyle(Color.bbInk)
                        Text(recorder.isRecording ? Loc.t("m_vc_recording") :
                                (recorder.recordedURL != nil ? Loc.t("m_vc_recorded") : Loc.t("m_vc_tap_record")))
                            .font(.caption).foregroundStyle(Color.bbInkDim)
                    }
                    Spacer()
                }
                if recorder.recordedURL != nil && !recorder.isRecording {
                    HStack(spacing: 16) {
                        Button { Task { await previewSample() } } label: {
                            Label(previewing ? Loc.t("m_vc_stop") : Loc.t("m_vc_playback"),
                                  systemImage: previewing ? "stop.fill" : "play.fill").foregroundStyle(Color.bbGold)
                        }.buttonStyle(.plain)
                        Button { recorder.reset() } label: {
                            Label(Loc.t("m_vc_rerecord"), systemImage: "arrow.counterclockwise").foregroundStyle(Color.bbInkDim)
                        }.buttonStyle(.plain)
                    }
                    .font(.system(size: 15))
                }
                if micDenied {
                    Text(Loc.t("m_vc_mic_denied")).font(.caption).foregroundStyle(.red)
                }
            }
            .padding(.vertical, 4)
        }
        .listRowBackground(Color.bbCard)
    }

    private var importSection: some View {
        Section {
            Button { showImporter = true } label: {
                HStack {
                    Label(importedURL == nil ? Loc.t("m_vc_pick_file") : importedName,
                          systemImage: "waveform").foregroundStyle(importedURL == nil ? Color.bbGold : Color.bbInk)
                    Spacer()
                    if importedURL != nil { Image(systemName: "checkmark").foregroundStyle(Color.bbGold) }
                }
            }
            .buttonStyle(.plain)
        } footer: {
            Text(Loc.t("m_vc_import_hint")).font(.caption).foregroundStyle(Color.bbInkFaint)
        }
        .listRowBackground(Color.bbCard)
    }

    private var detailsSection: some View {
        Section {
            TextField(Loc.t("m_vc_label_ph"), text: $label).textInputAutocapitalization(.words)
            Button { Task { await startClone() } } label: {
                Text(Loc.t("m_vc_start")).frame(maxWidth: .infinity).fontWeight(.semibold)
            }
            .buttonStyle(.borderedProminent).tint(.bbGold)
            .disabled(!hasAudio)
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
        } footer: {
            if isMiniMax { Text(Loc.t("m_vc_group_hint")).font(.caption).foregroundStyle(Color.bbInkFaint) }
        }
        .listRowBackground(Color.bbCard)
    }

    // MARK: Cloning progress

    private var cloningSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 18) {
                ProgressView().tint(.bbGold).scaleEffect(1.2).frame(maxWidth: .infinity).padding(.top, 8)
                ForEach(Array(Self.stages.enumerated()), id: \.offset) { i, name in
                    HStack(spacing: 12) {
                        Image(systemName: i < progressStage ? "checkmark.circle.fill" : (i == progressStage ? "circle.dotted" : "circle"))
                            .foregroundStyle(i <= progressStage ? Color.bbGold : Color.bbInkFaint)
                        Text(Loc.t(name)).foregroundStyle(i <= progressStage ? Color.bbInk : Color.bbInkDim)
                        Spacer()
                    }
                }
            }
            .padding(.vertical, 8)
        }
        .listRowBackground(Color.bbCard)
    }

    // MARK: Success

    @ViewBuilder private var successSections: some View {
        Section {
            VStack(spacing: 14) {
                Text(Loc.t("m_vc_cloned_kicker")).font(.system(size: 11, weight: .bold, design: .monospaced))
                    .kerning(1.4).foregroundStyle(Color.bbGold)
                Text(Loc.t("m_vc_cloned_sub", ["name": clonedLabel])).font(.system(size: 15)).foregroundStyle(Color.bbInk)
                    .multilineTextAlignment(.center)
                Button { Task { await previewCloned() } } label: {
                    ZStack {
                        Circle().fill(Color.bbGold).frame(width: 64, height: 64)
                        Image(systemName: previewing ? "stop.fill" : "play.fill")
                            .font(.system(size: 24, weight: .bold)).foregroundStyle(Color.bbBg)
                    }
                }.buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 8)
        }
        .listRowBackground(Color.bbCard)
        Section {
            TextField(Loc.t("m_vc_sample_ph"), text: $sampleLine, axis: .vertical).lineLimit(2...5)
        } header: {
            Text(Loc.t("m_vc_sample_label"))
        } footer: {
            Text(Loc.t("m_vc_sample_hint")).font(.caption).foregroundStyle(Color.bbInkFaint)
        }
        .listRowBackground(Color.bbCard)
        Section {
            Button { applyAndClose() } label: {
                Text(Loc.t("m_vc_apply")).frame(maxWidth: .infinity).fontWeight(.semibold)
            }
            .buttonStyle(.borderedProminent).tint(.bbGold)
        }
        .listRowBackground(Color.bbCard)
    }

    // MARK: Failed

    private var failedSection: some View {
        Section {
            VStack(spacing: 14) {
                Image(systemName: "exclamationmark.triangle").font(.system(size: 30)).foregroundStyle(.red)
                Text(Loc.t(Self.errorKey(errorCode))).font(.system(size: 15)).foregroundStyle(Color.bbInk)
                    .multilineTextAlignment(.center)
                Button { stage = .setup } label: {
                    Text(Loc.t("m_vc_retry")).frame(maxWidth: .infinity).fontWeight(.semibold)
                }
                .buttonStyle(.borderedProminent).tint(.bbGold)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 8)
        }
        .listRowBackground(Color.bbCard)
    }

    // MARK: Actions

    private func toggleRecord() {
        if recorder.isRecording { recorder.stop(); return }
        Task {
            let ok = await recorder.requestPermission()
            if ok { micDenied = false; recorder.start() } else { micDenied = true }
        }
    }

    private func adoptImported(_ url: URL) {
        // Security-scoped · copy into temp so we can read it after the picker closes.
        let needsStop = url.startAccessingSecurityScopedResource()
        defer { if needsStop { url.stopAccessingSecurityScopedResource() } }
        let dest = FileManager.default.temporaryDirectory.appendingPathComponent("clone-import-" + url.lastPathComponent)
        try? FileManager.default.removeItem(at: dest)
        do {
            try FileManager.default.copyItem(at: url, to: dest)
            importedURL = dest
            importedName = url.lastPathComponent
        } catch { importedURL = nil }
    }

    private func startClone() async {
        guard let url = audioURL, let data = try? Data(contentsOf: url) else { return }
        // MiniMax cloning needs a GroupID · use the one configured in API-key settings
        // (or embedded in the key's JWT). If neither, guide the user to configure it.
        if isMiniMax, effectiveGroupId == nil { showGroupIdAlert = true; return }
        stopPlayback()
        stage = .cloning
        progressStage = 0
        // Synthetic stage animation while the one POST runs (real % isn't exposed
        // by the providers; the desktop %s are stage-derived too).
        let ticker = Task {
            try? await Task.sleep(for: .seconds(1)); await MainActor.run { if stage == .cloning { progressStage = max(progressStage, 1) } }
            try? await Task.sleep(for: .seconds(3)); await MainActor.run { if stage == .cloning { progressStage = max(progressStage, 2) } }
        }
        defer { ticker.cancel() }
        guard let api = app.api else { stage = .failed; errorCode = "provider_unknown"; return }
        do {
            let r = try await api.cloneVoice(agentId: agentId, audio: data,
                                             filename: url.lastPathComponent,
                                             label: label.trimmingCharacters(in: .whitespaces),
                                             groupId: isMiniMax ? effectiveGroupId : nil)
            if let code = r.error { stage = .failed; errorCode = code; return }
            guard let vid = r.voiceId else { stage = .failed; errorCode = "provider_unknown"; return }
            clonedVoiceId = vid
            clonedModel = r.model ?? (isMiniMax ? "speech-2.8-hd" : "eleven_multilingual_v2")
            clonedLabel = r.label ?? (label.isEmpty ? vid : label)
            sampleLine = Loc.t("m_vc_sample_default", ["name": clonedLabel])
            progressStage = 3
            stage = .success
        } catch {
            stage = .failed
            errorCode = "provider_unknown"
        }
    }

    private func applyAndClose() {
        onApplied(clonedVoiceId, provider, clonedModel, clonedLabel)
        recorder.reset()
        dismiss()
    }

    // MARK: Preview playback

    private func previewSample() async {
        if previewing { stopPlayback(); return }
        guard let url = recorder.recordedURL, let data = try? Data(contentsOf: url) else { return }
        playLocal(data)
    }

    private func previewCloned() async {
        if previewing { stopPlayback(); return }
        guard let api = app.api, !clonedVoiceId.isEmpty else { return }
        previewing = true
        let text = sampleLine.trimmingCharacters(in: .whitespaces)
        let data = await api.previewVoice(provider: provider, model: clonedModel, voiceId: clonedVoiceId,
                                          emotion: nil, text: text.isEmpty ? nil : text)
        guard previewing, let data else { previewing = false; return }
        playLocal(data)
    }

    private func playLocal(_ data: Data) {
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        try? AVAudioSession.sharedInstance().setActive(true)
        preparedAudio = try? AVAudioPlayer(data: data)
        guard let p = preparedAudio else { previewing = false; return }
        previewing = true
        p.play()
        let dur = p.duration
        Task { try? await Task.sleep(nanoseconds: UInt64((dur + 0.2) * 1_000_000_000)); previewing = false }
    }

    private func stopPlayback() { preparedAudio?.stop(); preparedAudio = nil; previewing = false }

    // MARK: Helpers

    private static let stages = ["m_vc_stage_prepare", "m_vc_stage_upload", "m_vc_stage_clone"]

    private static func fmt(_ t: TimeInterval) -> String {
        let s = Int(t); return String(format: "%d:%02d", s / 60, s % 60)
    }

    /// Theme the system segmented control · gold selected segment with dark text
    /// (the `.tint`/`.pickerStyle(.segmented)` combo doesn't reliably recolor the
    /// selected indicator, so set it on `UISegmentedControl.appearance`). Safe to
    /// set globally — this is the app's only system segmented picker.
    private static func configureSegmentedAppearance() {
        let ap = UISegmentedControl.appearance()
        ap.selectedSegmentTintColor = UIColor(Color.bbGold)
        ap.backgroundColor = UIColor(white: 1, alpha: 0.04)
        ap.setTitleTextAttributes([.foregroundColor: UIColor(Color.bbInkDim),
                                   .font: UIFont.systemFont(ofSize: 15, weight: .medium)], for: .normal)
        ap.setTitleTextAttributes([.foregroundColor: UIColor(Color.bbBg),
                                   .font: UIFont.systemFont(ofSize: 15, weight: .semibold)], for: .selected)
    }

    private static func errorKey(_ code: String) -> String {
        switch code {
        case "missing_group_id": return "m_vc_err_group"
        case "provider_auth": return "m_vc_err_auth"
        case "provider_quota": return "m_vc_err_quota"
        case "provider_invalid_voice_id": return "m_vc_err_voiceid"
        case "audio_too_short": return "m_vc_err_short"
        case "audio_too_long": return "m_vc_err_long"
        case "unsupported_provider": return "m_vc_err_unsupported"
        default: return "m_vc_err_unknown"
        }
    }
}
