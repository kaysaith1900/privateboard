import SwiftUI

/// First-run completion flag · once the 5-step flow finishes it never shows again.
enum OnboardingState {
    private static let key = "bb.onboarded.v1"
    static var completed: Bool { UserDefaults.standard.bool(forKey: key) }
    static func markCompleted() { UserDefaults.standard.set(true, forKey: key) }
}

/// First-run onboarding · a gamified, full-screen 5-beat flow faithful to the
/// desktop `onboarding.js`: 00 name → 01 philosophy → 02 LLM key (required) →
/// 03 voice key (optional) → 04 cast preview → into the room composer. Editorial
/// serif headlines, a dossier corner-frame, a top gold aurora, a numbered chapter
/// medallion, a filling progress rail, staggered reveals, and a live "✓ configured"
/// pill carry the premium, game-y tone. Cannot be skipped (the LLM step gates).
struct OnboardingFlow: View {
    @Environment(AppState.self) private var app
    var onDone: () -> Void

    @State private var step = 0
    private static let stepCount = 5

    // Name
    @State private var name = ""
    // LLM key
    @State private var llmProvider = "openrouter"
    @State private var llmKey = ""
    @State private var llmRevealed = false
    @State private var llmSaved = false
    @State private var llmSaving = false
    @State private var llmError: String?
    // Voice key
    @State private var voiceProvider = "minimax"
    @State private var voiceKey = ""
    @State private var voiceRevealed = false
    @State private var voiceRegion = "cn"
    @State private var voiceSaved = false
    @State private var voiceSaving = false
    @State private var voiceError: String?
    // Cast reveal animation
    @State private var castIn = false

    private var isVoiceMiniMax: Bool { voiceProvider == "minimax" }
    /// Short steps centre vertically; content-heavy steps top-align and scroll.
    private var centred: Bool { step == 0 || step == 1 }

    var body: some View {
        ZStack {
            backdrop
            VStack(spacing: 0) {
                progressHeader
                GeometryReader { geo in
                    ScrollView {
                        stepContent
                            .padding(.horizontal, 26).padding(.vertical, 18)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .frame(minHeight: geo.size.height, alignment: centred ? .center : .top)
                            .id(step)
                            .transition(.asymmetric(
                                insertion: .move(edge: .trailing).combined(with: .opacity),
                                removal: .move(edge: .leading).combined(with: .opacity)))
                    }
                    .scrollIndicators(.hidden)
                }
                ctaBar
            }
            .padding(14)
        }
    }

    // MARK: Chrome

    private var backdrop: some View {
        ZStack {
            Color.bbBg.ignoresSafeArea()
            RadialGradient(colors: [Color.bbGold.opacity(0.13), .clear],
                           center: .top, startRadius: 0, endRadius: 460)
                .ignoresSafeArea()
        }
    }

    private var progressHeader: some View {
        VStack(spacing: 9) {
            HStack {
                Text("PRIVATEBOARD")
                    .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(2.4)
                    .foregroundStyle(Color.bbGold)
                Spacer()
                Text(String(format: "%02d / %02d", step + 1, Self.stepCount))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced)).kerning(1)
                    .foregroundStyle(Color.bbInkFaint)
            }
            HStack(spacing: 6) {
                ForEach(0..<Self.stepCount, id: \.self) { i in
                    Capsule()
                        .fill(i <= step ? Color.bbGold : Color.white.opacity(0.09))
                        .frame(height: 3)
                        .shadow(color: i == step ? Color.bbGold.opacity(0.6) : .clear, radius: 4)
                        .animation(.smooth(duration: 0.35), value: step)
                }
            }
        }
        .padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 2)
    }

    @ViewBuilder private var stepContent: some View {
        switch step {
        case 0: nameStep
        case 1: philosophyStep
        case 2: llmStep
        case 3: voiceStep
        default: castStep
        }
    }

    // MARK: 00 · name

    private var nameStep: some View {
        VStack(alignment: .leading, spacing: 22) {
            chapter("00", Loc.t("onb_name_kicker"))
            serifTitle(Loc.t("onb_name_head"), size: 30)
            Text(Loc.t("onb_name_sub")).font(.system(size: 15)).foregroundStyle(Color.bbInkDim)
            HStack(spacing: 12) {
                Text(">").font(.system(size: 24, weight: .bold, design: .monospaced)).foregroundStyle(Color.bbGold)
                TextField("", text: $name, prompt: Text(Loc.t("onb_name_ph")).foregroundColor(Color.bbInkFaint))
                    .font(.system(size: 26, weight: .medium, design: .serif)).italic()
                    .foregroundStyle(Color.bbInk)
                    .textInputAutocapitalization(.words).autocorrectionDisabled()
                    .submitLabel(.go).onSubmit(advance)
            }
            .padding(.bottom, 10)
            .overlay(alignment: .bottom) {
                Rectangle().fill(Color.bbGold.opacity(0.7)).frame(height: 1.5)
            }
            .onChange(of: name) { _, v in if v.count > 32 { name = String(v.prefix(32)) } }
        }
    }

    // MARK: 01 · philosophy

    private var philosophyStep: some View {
        VStack(alignment: .leading, spacing: 22) {
            chapter("01", Loc.t("onb_phil_kicker"))
            serifTitle(Loc.t("onb_phil_head"), size: 27)
            actsRow
            Text(Loc.t("onb_phil_body"))
                .font(.system(size: 15)).lineSpacing(3).foregroundStyle(Color.bbInkDim)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .top, spacing: 8) {
                Text("// note").font(.system(size: 12, weight: .semibold, design: .monospaced)).foregroundStyle(Color.bbGold)
                Text(Loc.t("onb_phil_note"))
                    .font(.system(size: 14, design: .serif)).italic().lineSpacing(2).foregroundStyle(Color.bbInkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(14)
            .background(Color.bbGold.opacity(0.06), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    /// Convene · sharpen · adjourn — the three acts as gold-ticked chips.
    private var actsRow: some View {
        HStack(spacing: 8) {
            ForEach(["convene", "sharpen", "adjourn"], id: \.self) { act in
                HStack(spacing: 6) {
                    Circle().fill(Color.bbGold).frame(width: 5, height: 5)
                    Text(act.uppercased()).font(.system(size: 10, weight: .bold, design: .monospaced)).kerning(0.8)
                        .foregroundStyle(Color.bbInk)
                }
                .padding(.vertical, 7).padding(.horizontal, 11)
                .background(Color.white.opacity(0.04), in: Capsule())
                .overlay(Capsule().stroke(Color.bbLine, lineWidth: 1))
            }
        }
    }

    // MARK: 02 · LLM key (required)

    private var llmStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            chapter("02", Loc.t("onb_key_kicker"))
            serifTitle(Loc.t("onb_key_head"), size: 27)
            Text(Loc.t("onb_key_sub")).font(.system(size: 14)).foregroundStyle(Color.bbInkDim)
            kicker(Loc.t("onb_key_multi"))
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(ApiCatalog.providers(cat: "llm", kind: "multi")) { p in
                    providerCard(p, selected: llmProvider == p.id) { selectLLM(p.id) }
                }
            }
            kicker(Loc.t("onb_key_direct"))
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
                ForEach(ApiCatalog.providers(cat: "llm", kind: "single")) { p in
                    providerChip(p.name, selected: llmProvider == p.id) { selectLLM(p.id) }
                }
            }
            keyField(provider: llmProvider, key: $llmKey, revealed: $llmRevealed,
                     saved: llmSaved, saving: llmSaving, onChange: { llmSaved = false; llmError = nil })
        }
    }

    // MARK: 03 · voice key (optional)

    private var voiceStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            chapter("03", Loc.t("onb_voice_kicker"))
            serifTitle(Loc.t("onb_voice_head"), size: 27)
            Text(Loc.t("onb_voice_sub")).font(.system(size: 14)).lineSpacing(2).foregroundStyle(Color.bbInkDim)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                ForEach(ApiCatalog.providers(cat: "voice")) { p in
                    providerCard(p, selected: voiceProvider == p.id) { selectVoice(p.id) }
                }
            }
            if isVoiceMiniMax {
                HStack(spacing: 10) {
                    regionChip("cn", Loc.t("m_addkey_region_cn"))
                    regionChip("intl", Loc.t("m_addkey_region_intl"))
                }
            }
            keyField(provider: voiceProvider, key: $voiceKey, revealed: $voiceRevealed,
                     saved: voiceSaved, saving: voiceSaving, onChange: { voiceSaved = false; voiceError = nil })
        }
    }

    // MARK: 04 · cast preview

    private var castStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            chapter("04", Loc.t("onb_cast_kicker"))
            serifTitle(Loc.t("onb_cast_head"), size: 24)
            Text(Loc.t("onb_cast_body")).font(.system(size: 14)).lineSpacing(2).foregroundStyle(Color.bbInkDim)
                .fixedSize(horizontal: false, vertical: true)
            kicker(Loc.t("onb_cast_preview"))
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 18) {
                ForEach(Array(castMembers.enumerated()), id: \.element.id) { i, a in
                    castCell(a)
                        .opacity(castIn ? 1 : 0)
                        .scaleEffect(castIn ? 1 : 0.8)
                        .animation(.smooth(duration: 0.36).delay(Double(i) * 0.07), value: castIn)
                }
            }
            kicker(Loc.t("onb_cast_flow"))
            flowDiagram
        }
        .onAppear { castIn = true }
    }

    private var castMembers: [Agent] {
        var out: [Agent] = []
        if let c = app.chair { out.append(c) }
        out.append(contentsOf: app.agents.prefix(5))
        return out
    }

    private func castCell(_ a: Agent) -> some View {
        VStack(spacing: 7) {
            AvatarView(path: a.avatarPath, name: a.name, size: 56)
                .overlay(Circle().stroke(Color.bbGold.opacity(0.35), lineWidth: 1))
            Text(a.name).font(.system(size: 11, weight: .bold)).foregroundStyle(Color.bbInk)
                .lineLimit(1).minimumScaleFactor(0.7)
            if let r = a.roleTag, !r.isEmpty {
                Text(r).font(.system(size: 10, design: .serif)).italic().foregroundStyle(Color.bbInkDim)
                    .lineLimit(1).minimumScaleFactor(0.7)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var flowDiagram: some View {
        VStack(spacing: 6) {
            flowRow("01", Loc.t("onb_cast_s1"))
            flowConnector
            flowRow("02", Loc.t("onb_cast_s2"))
            flowConnector
            flowRow("03", Loc.t("onb_cast_s3"))
        }
    }

    private func flowRow(_ n: String, _ label: String) -> some View {
        HStack(spacing: 12) {
            Text(n).font(.system(size: 13, weight: .bold, design: .monospaced)).foregroundStyle(Color.bbGold)
                .frame(width: 28, height: 28)
                .background(Circle().fill(Color.bbGold.opacity(0.14)))
                .overlay(Circle().stroke(Color.bbGold.opacity(0.5), lineWidth: 1))
            Text(label).font(.system(size: 15, weight: .medium)).foregroundStyle(Color.bbInk)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 11).padding(.horizontal, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.bbSurface, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
    }

    private var flowConnector: some View {
        Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold)).foregroundStyle(Color.bbGold.opacity(0.6))
    }

    // MARK: CTA bar

    @ViewBuilder private var ctaBar: some View {
        VStack(spacing: 10) {
            if let err = step == 2 ? llmError : (step == 3 ? voiceError : nil) {
                Text(err).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 14) {
                if step > 0 {
                    Button { withAnimation(.smooth(duration: 0.3)) { step -= 1 } } label: {
                        Image(systemName: "chevron.left").font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.bbInkDim).frame(width: 46, height: 46)
                            .background(Circle().fill(Color.white.opacity(0.05)))
                            .overlay(Circle().stroke(Color.bbLine, lineWidth: 1))
                    }.buttonStyle(.plain)
                }
                if step == 3 && !voiceKey.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button(Loc.t("onb_voice_skip")) { go(4) }
                        .font(.system(size: 15, weight: .medium)).foregroundStyle(Color.bbInkDim)
                }
                primaryButton
            }
        }
        .padding(.horizontal, 18).padding(.top, 12).padding(.bottom, 6)
    }

    private var primaryButton: some View {
        Button(action: advance) {
            HStack(spacing: 9) {
                if llmSaving || voiceSaving { ProgressView().tint(.black) }
                Text(primaryLabel).font(.system(size: 16, weight: .bold))
                if !(llmSaving || voiceSaving) { Image(systemName: "arrow.right").font(.system(size: 15, weight: .bold)) }
            }
            .foregroundStyle(.black).frame(maxWidth: .infinity).padding(.vertical, 15)
            .background(
                LinearGradient(colors: primaryEnabled ? [Color.bbGold, Color.bbGold.opacity(0.82)] : [Color.gray.opacity(0.4), Color.gray.opacity(0.4)],
                               startPoint: .top, endPoint: .bottom),
                in: Capsule(style: .continuous))
            .shadow(color: primaryEnabled ? Color.bbGold.opacity(0.35) : .clear, radius: 12, y: 4)
        }
        .buttonStyle(.plain)
        .disabled(!primaryEnabled)
    }

    private var primaryLabel: String {
        switch step {
        case 0: return Loc.t("onb_name_cta")
        case 2: return Loc.t("onb_continue")
        case 3: return voiceKey.trimmingCharacters(in: .whitespaces).isEmpty ? Loc.t("onb_voice_skipcta") : Loc.t("onb_voice_save")
        case 4: return Loc.t("onb_cast_cta")
        default: return Loc.t("onb_continue")
        }
    }

    /// Step 2 is gated · the LLM key must be ALREADY saved or pass the format check
    /// (a bare non-empty "1234" no longer unlocks Continue). Step 3 (voice) is
    /// optional → an empty field still advances (skip), but a typed key must be valid.
    private var primaryEnabled: Bool {
        if llmSaving || voiceSaving { return false }
        if step == 2 { return llmSaved || KeyValidator.isAcceptable(provider: llmProvider, key: llmKey) }
        if step == 3 {
            let k = voiceKey.trimmingCharacters(in: .whitespaces)
            return voiceSaved || k.isEmpty || KeyValidator.isAcceptable(provider: voiceProvider, key: voiceKey)
        }
        return true
    }

    // MARK: Shared building blocks

    /// A numbered gold medallion + the chapter kicker — the chapter header.
    private func chapter(_ num: String, _ text: String) -> some View {
        HStack(spacing: 11) {
            Text(num)
                .font(.system(size: 15, weight: .bold, design: .monospaced)).foregroundStyle(Color.bbGold)
                .frame(width: 38, height: 38)
                .background(Circle().fill(Color.bbGold.opacity(0.12)))
                .overlay(Circle().stroke(Color.bbGold.opacity(0.55), lineWidth: 1))
            Text(text.replacingOccurrences(of: "\(num) · ", with: ""))
                .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(1.4)
                .foregroundStyle(Color.bbGold).lineLimit(2).minimumScaleFactor(0.8)
        }
    }

    private func serifTitle(_ text: String, size: CGFloat) -> some View {
        Text(text)
            .font(.system(size: size, weight: .semibold, design: .serif)).lineSpacing(3)
            .foregroundStyle(Color.bbInk).fixedSize(horizontal: false, vertical: true)
    }

    private func kicker(_ text: String) -> some View {
        Text(text.uppercased()).font(.system(size: 11, weight: .semibold, design: .monospaced)).kerning(0.6)
            .foregroundStyle(Color.bbInkDim).padding(.top, 4)
    }

    private func providerCard(_ p: ApiProvider, selected: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(p.name).font(.system(size: 15, weight: .semibold))
                    Spacer()
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 15)).foregroundStyle(selected ? Color.bbGold : Color.bbInkFaint)
                }
                Text(p.note).font(.system(size: 11)).foregroundStyle(selected ? Color.bbGold.opacity(0.85) : Color.bbInkFaint)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, minHeight: 58, alignment: .topLeading).padding(13)
            .foregroundStyle(selected ? Color.bbGold : Color.bbInk)
            .background(selected ? Color.bbGold.opacity(0.13) : Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(selected ? Color.bbGold : Color.bbLine, lineWidth: selected ? 1.5 : 1))
        }.buttonStyle(.plain)
    }

    private func providerChip(_ name: String, selected: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Text(name).font(.system(size: 14, weight: .medium)).lineLimit(1).minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity).padding(.vertical, 11)
                .foregroundStyle(selected ? Color.bbGold : Color.bbInkDim)
                .background(selected ? Color.bbGold.opacity(0.13) : Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).stroke(selected ? Color.bbGold : Color.bbLine, lineWidth: selected ? 1.5 : 1))
        }.buttonStyle(.plain)
    }

    private func regionChip(_ id: String, _ title: String) -> some View {
        let on = voiceRegion == id
        return Button { voiceRegion = id } label: {
            Text(title).font(.system(size: 13, weight: .medium))
                .frame(maxWidth: .infinity).padding(.vertical, 9)
                .foregroundStyle(on ? Color.bbGold : Color.bbInkDim)
                .background(on ? Color.bbGold.opacity(0.13) : Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(on ? Color.bbGold : Color.bbLine, lineWidth: 1))
        }.buttonStyle(.plain)
    }

    private func keyField(provider: String, key: Binding<String>, revealed: Binding<Bool>,
                          saved: Bool, saving: Bool, onChange: @escaping () -> Void) -> some View {
        let label = ApiCatalog.name(provider)
        return VStack(alignment: .leading, spacing: 9) {
            HStack {
                Group {
                    if revealed.wrappedValue { TextField(ApiCatalog.info(provider)?.hint ?? "", text: key) }
                    else { SecureField(ApiCatalog.info(provider)?.hint ?? "", text: key) }
                }
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .font(.system(size: 15, design: .monospaced)).foregroundStyle(Color.bbInk)
                .onChange(of: key.wrappedValue) { _, _ in onChange() }
                Button { revealed.wrappedValue.toggle() } label: {
                    Image(systemName: revealed.wrappedValue ? "eye.slash" : "eye").foregroundStyle(Color.bbInkFaint)
                }.buttonStyle(.plain)
            }
            .padding(.vertical, 14).padding(.horizontal, 15)
            .background(Color.bbSurface, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous)
                .stroke(saved ? Color.bbGold : Color.bbLine, lineWidth: saved ? 1.5 : 1))
            if saved {
                Label(Loc.t("onb_key_configured", ["provider": label]), systemImage: "checkmark.seal.fill")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.bbGold)
                    .transition(.opacity.combined(with: .move(edge: .leading)))
            } else if let warning = keyWarning(provider: provider, key: key.wrappedValue) {
                // Live format check (port of key-validators.js) · catches "1234", a
                // wrong-provider paste, a stray space BEFORE it round-trips to storage.
                Label(warning, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 12)).foregroundStyle(Color.bbAmber)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(Loc.t("onb_key_field", ["provider": label]))
                    .font(.system(size: 12, design: .monospaced)).foregroundStyle(Color.bbInkFaint)
            }
        }
        .animation(.smooth(duration: 0.25), value: saved)
    }

    /// Format-validation message for a non-empty, not-yet-valid key (nil otherwise).
    /// Empty stays nil so the field shows its neutral hint, not a "missing key" nag.
    private func keyWarning(provider: String, key: String) -> String? {
        guard !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return KeyValidator.isAcceptable(provider: provider, key: key)
            ? nil : KeyValidator.describe(provider: provider, key: key)
    }

    // MARK: Actions

    private func selectLLM(_ id: String) { llmProvider = id; llmSaved = false; llmError = nil }
    private func selectVoice(_ id: String) { voiceProvider = id; voiceSaved = false; voiceError = nil }

    private func advance() {
        switch step {
        case 0:
            app.setUserName(name)
            go(1)
        case 2:
            if llmSaved { go(3); return }
            saveLLM()
        case 3:
            let k = voiceKey.trimmingCharacters(in: .whitespaces)
            if voiceSaved || k.isEmpty { go(4); return }
            saveVoice()
        case 4:
            finish()
        default:
            go(step + 1)
        }
    }

    private func go(_ s: Int) { withAnimation(.smooth(duration: 0.32)) { step = s } }

    private func saveLLM() {
        let k = llmKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !k.isEmpty, let api = app.api else { return }
        if !KeyValidator.isAcceptable(provider: llmProvider, key: k) {
            llmError = KeyValidator.describe(provider: llmProvider, key: k); return
        }
        llmSaving = true; llmError = nil
        Task {
            do {
                try await api.createCredential(.llm, provider: llmProvider, label: nil, key: k)
                llmSaving = false
                withAnimation { llmSaved = true }
                try? await Task.sleep(nanoseconds: 450_000_000)
                go(3)
            } catch {
                llmSaving = false
                llmError = (error as? APIClient.APIError)?.errorDescription ?? Loc.t("onb_key_fail")
            }
        }
    }

    private func saveVoice() {
        let k = voiceKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !k.isEmpty, let api = app.api else { go(4); return }
        if !KeyValidator.isAcceptable(provider: voiceProvider, key: k) {
            voiceError = KeyValidator.describe(provider: voiceProvider, key: k); return
        }
        voiceSaving = true; voiceError = nil
        Task {
            do {
                try await api.createCredential(.voice, provider: voiceProvider, label: nil, key: k,
                                               region: isVoiceMiniMax ? voiceRegion : nil)
                voiceSaving = false
                withAnimation { voiceSaved = true }
                try? await Task.sleep(nanoseconds: 450_000_000)
                go(4)
            } catch {
                voiceSaving = false
                voiceError = (error as? APIClient.APIError)?.errorDescription ?? Loc.t("onb_key_fail")
            }
        }
    }

    private func finish() {
        OnboardingState.markCompleted()
        Task { await app.reloadAgents() }
        onDone()
    }
}
