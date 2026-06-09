import SwiftUI
import BoardroomStorage

/// Shared MiniMax extra config that isn't part of the credential row · the host
/// GroupID (required for voice cloning when the API key's JWT doesn't embed it).
/// Stored client-side; set from the API-key add / detail screens, read by the
/// voice-clone flow. (Region lives in the DB `prefs`; this is the parallel local bit.)
enum MiniMaxConfig {
    static let groupIdKey = "pb.voice-clone.minimax-group-id"
    static var groupId: String {
        get { (UserDefaults.standard.string(forKey: groupIdKey) ?? "").trimmingCharacters(in: .whitespaces) }
        set { UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespaces), forKey: groupIdKey) }
    }
}

/// Settings hub (sheet) · native iOS-26 grouped Form, matching the agent
/// profile. Server connection · API keys · language.
struct PrefsView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var usageTokens: Int?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    // One key hub for the on-device engine. The raw key lives in
                    // the Keychain; the engine reads the active one at call time.
                    NavigationLink { ApiKeysView() } label: {
                        settingsLabel("key.fill", Loc.t("m_prefs_keys"), nil)
                    }
                    NavigationLink { UsageView() } label: {
                        settingsLabel("chart.bar.fill", Loc.t("m_prefs_usage"),
                                      usageTokens.map { Loc.t("m_prefs_usage_sub", ["tokens": UsageView.fmtTokens($0)]) })
                    }
                    NavigationLink { UserAvatarView() } label: {
                        settingsLabel("person.crop.circle", Loc.t("m_prefs_avatar"), nil)
                    }
                    NavigationLink { LanguageView() } label: {
                        settingsLabel("globe", Loc.t("m_prefs_language"), Loc.localeNames[Loc.locale])
                    }
                }
                .listRowBackground(Color.bbCard)
            }
            .scrollContentBackground(.hidden)
            .background(Color.bbBg.ignoresSafeArea())
            .tint(Color.bbGold)
            .navigationTitle(Loc.t("m_prefs_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button(Loc.t("common_done")) { dismiss() } } }
            .task { usageTokens = (try? await app.api?.getUsage())??.totalTokens }
        }
    }

    private func settingsLabel(_ icon: String, _ title: String, _ value: String?) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 16)).foregroundStyle(Color.bbGold).frame(width: 28)
            Text(title).foregroundStyle(Color.bbInk)
            Spacer()
            if let value { Text(value).foregroundStyle(.secondary) }
        }
    }
}

/// Host user's own 3D avatar · customise the figure that represents YOU in the
/// room. Reuses the same capture editor the director flow uses; persists to
/// `prefs.avatar3d_json` + `prefs.avatar_url` via `NativeEngineHost` (the user
/// seat reads it). Seeds from the saved config so re-opening keeps your look.
struct UserAvatarView: View {
    @Environment(AppState.self) private var app
    @State private var config: Avatar3DConfig?
    @State private var avatarUrl: String?
    @State private var showEditor = false

    var body: some View {
        Form {
            Section {
                VStack(spacing: 16) {
                    AvatarRing(path: avatarUrl, name: app.userName, size: 96)
                    Button { showEditor = true } label: {
                        Label(Loc.t("m_av_edit"), systemImage: "wand.and.stars")
                            .fontWeight(.semibold)
                            .frame(maxWidth: .infinity).padding(.vertical, 6).foregroundStyle(.black)
                    }
                    .buttonStyle(.glassProminent).tint(.bbGold)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 12)
            } footer: {
                Text(Loc.t("m_av_foot")).foregroundStyle(.secondary)
            }
            .listRowBackground(Color.bbCard)
        }
        .scrollContentBackground(.hidden)
        .background(Color.bbBg.ignoresSafeArea())
        .tint(Color.bbGold)
        .navigationTitle(Loc.t("m_prefs_avatar"))
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showEditor) {
            if let url = app.api?.assetURL("/mobile/avatar-editor-embed.html") {
                AvatarEditorView(url: url, seed: "user", existing: config) { png, cfg in
                    config = cfg
                    avatarUrl = png
                    NativeEngineHost.shared?.setUserAvatar3d(cfg.dictionary, avatarUrl: png)
                }
            }
        }
        .task {
            if let raw = NativeEngineHost.shared?.userAvatar3d() { config = Avatar3DConfig(jsonObject: raw) }
            avatarUrl = NativeEngineHost.shared?.userAvatarUrl()
        }
    }
}

struct LanguageView: View {
    @State private var sel = Loc.locale
    var body: some View {
        Form {
            Section {
                ForEach(Loc.supported, id: \.self) { code in
                    Button { Loc.setLocale(code); sel = code } label: {
                        HStack {
                            Text(Loc.localeNames[code] ?? code).foregroundStyle(Color.bbInk)
                            Spacer()
                            if code == sel { Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Color.bbGold) }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .listRowBackground(Color.bbCard)
        }
        .scrollContentBackground(.hidden)
        .background(Color.bbBg.ignoresSafeArea())
        .tint(Color.bbGold)
        .navigationTitle(Loc.t("m_lang_title"))
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - API keys

/// Provider catalog · 1:1 with the web `PROVIDER_CATALOG`. `kind` ("multi" /
/// "single") only meaningful for LLM providers (carriers vs direct).
struct ApiProvider: Identifiable, Hashable {
    let id: String, name: String, cat: String, kind: String, hint: String, note: String
}
enum ApiCatalog {
    static let all: [ApiProvider] = [
        .init(id: "openrouter", name: "OpenRouter", cat: "llm", kind: "multi", hint: "sk-or-v1-…", note: "One key routes every model family."),
        .init(id: "bai", name: "B.AI", cat: "llm", kind: "multi", hint: "bai-…", note: "One key routes every model family."),
        .init(id: "anthropic", name: "Anthropic", cat: "llm", kind: "single", hint: "sk-ant-…", note: "Claude family, direct."),
        .init(id: "openai", name: "OpenAI", cat: "llm", kind: "single", hint: "sk-…", note: "GPT family, direct."),
        .init(id: "google", name: "Google", cat: "llm", kind: "single", hint: "AIza…", note: "Gemini family, direct."),
        .init(id: "xai", name: "xAI", cat: "llm", kind: "single", hint: "xai-…", note: "Grok family, direct."),
        .init(id: "moonshot", name: "Moonshot", cat: "llm", kind: "single", hint: "sk-…", note: "Kimi family, direct."),
        .init(id: "zhipu", name: "Zhipu", cat: "llm", kind: "single", hint: "…", note: "GLM family, direct."),
        .init(id: "minimax", name: "MiniMax", cat: "voice", kind: "", hint: "…", note: "TTS · live voice rooms."),
        .init(id: "elevenlabs", name: "ElevenLabs", cat: "voice", kind: "", hint: "…", note: "TTS · live voice rooms."),
        .init(id: "brave", name: "Brave", cat: "search", kind: "", hint: "BSA…", note: "Web-search skill source."),
        .init(id: "tavily", name: "Tavily", cat: "search", kind: "", hint: "tvly-…", note: "Web-search skill source."),
    ]
    static func name(_ id: String) -> String { all.first { $0.id == id }?.name ?? id }
    static func info(_ id: String) -> ApiProvider? { all.first { $0.id == id } }
    static func providers(cat: String, kind: String? = nil) -> [ApiProvider] {
        all.filter { $0.cat == cat && (kind == nil || $0.kind == kind) }
    }
}

/// API-key hub · a grouped Form, one Section per credential family. Each row is
/// a stored key (tap = make active, swipe = delete); a trailing "Add key" row
/// pushes the entry form.
struct ApiKeysView: View {
    @Environment(AppState.self) private var app
    @State private var data: [CredCategory: CredentialsResponse] = [:]

    var body: some View {
        Form {
            ForEach(CredCategory.allCases) { cat in section(cat) }
            Section { } footer: {
                Text(Loc.t("m_keys_foot")).foregroundStyle(.secondary)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Color.bbBg.ignoresSafeArea())
        .tint(Color.bbGold)
        .navigationTitle(Loc.t("m_keys_title"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    @ViewBuilder private func section(_ cat: CredCategory) -> some View {
        let resp = data[cat]
        let items = resp?.credentials ?? []
        Section {
            if items.isEmpty {
                Text(Loc.t("m_keys_none")).foregroundStyle(.secondary)
            } else {
                ForEach(items) { c in
                    NavigationLink {
                        CredentialDetailView(cat: cat, cred: c, isActive: c.id == resp?.activeId) {
                            Task { await load() }
                        }
                    } label: {
                        KeyRow(cred: c, isActive: c.id == resp?.activeId)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) { Task { await remove(cat, c.id) } } label: {
                            Label(Loc.t("m_delete_do"), systemImage: "trash")
                        }
                    }
                }
            }
            NavigationLink { AddKeyView(cat: cat) { Task { await load() } } } label: {
                Label(Loc.t("m_keys_add"), systemImage: "plus").foregroundStyle(Color.bbGold)
            }
        } header: {
            Text(Loc.t("m_cat_\(cat.rawValue)"))
        } footer: {
            Text(Loc.t("m_cat_\(cat.rawValue)_hint")).foregroundStyle(.secondary)
        }
        .listRowBackground(Color.bbCard)
    }

    private func load() async {
        guard let api = app.api else { return }
        var next: [CredCategory: CredentialsResponse] = [:]
        for cat in CredCategory.allCases {
            if let r = try? await api.listCredentials(cat) { next[cat] = r }
        }
        data = next
    }
    private func remove(_ cat: CredCategory, _ id: String) async {
        try? await app.api?.deleteCredential(cat, id: id); await load()
    }
}

private struct KeyRow: View {
    let cred: Credential
    let isActive: Bool

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(isActive ? Color.bbGold : Color.clear)
                    .overlay(Circle().strokeBorder(isActive ? Color.bbGold : Color.bbLine, lineWidth: 1.5))
                    .frame(width: 22, height: 22)
                if isActive {
                    Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(.black)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(ApiCatalog.name(cred.provider)).foregroundStyle(Color.bbInk)
                Text(metaLine).font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Color.bbInkFaint).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 8)
        }
    }
    private var metaLine: String {
        let label = (cred.label?.isEmpty == false) ? (cred.label! + " · ") : ""
        return label + (cred.preview ?? "")
    }
}

/// Detail for a stored credential · view the configured key (revealable) + any
/// provider settings (e.g. MiniMax host region), set it active, or delete it.
/// The full key is read from the on-device Keychain (the list API only returns a
/// masked preview).
private struct CredentialDetailView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    let cat: CredCategory
    let cred: Credential
    let isActive: Bool
    var onChange: () -> Void

    @State private var revealed = false
    @State private var fullKey: String?
    @State private var confirmDelete = false
    @State private var groupId = MiniMaxConfig.groupId

    private var isMiniMaxVoice: Bool { cat == .voice && cred.provider == "minimax" }

    /// MiniMax voice keys carry a host region (cn / intl); other providers don't.
    private var region: String? {
        guard isMiniMaxVoice else { return nil }
        return NativeEngineHost.shared?.minimaxRegion()
    }

    var body: some View {
        Form {
            Section {
                detailRow(Loc.t("m_credetail_provider"), ApiCatalog.name(cred.provider))
                if let label = cred.label, !label.isEmpty { detailRow(Loc.t("m_addkey_label"), label) }
                if isActive {
                    HStack {
                        Text(Loc.t("m_credetail_status")).foregroundStyle(Color.bbInkDim)
                        Spacer()
                        Label(Loc.t("m_credetail_active"), systemImage: "checkmark.seal.fill")
                            .font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.bbGold)
                    }
                }
            }.listRowBackground(Color.bbCard)

            Section {
                HStack(spacing: 10) {
                    Text(revealed ? (fullKey ?? cred.preview ?? "—") : "••••••••••••••••")
                        .font(.system(size: 14, design: .monospaced)).foregroundStyle(Color.bbInk)
                        .lineLimit(revealed ? nil : 1).truncationMode(.middle)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button { revealed.toggle() } label: {
                        Image(systemName: revealed ? "eye.slash" : "eye").foregroundStyle(Color.bbInkFaint)
                    }.buttonStyle(.plain)
                }
            } header: {
                Text(Loc.t("m_addkey_key"))
            }.listRowBackground(Color.bbCard)

            if let region {
                Section(Loc.t("m_addkey_region")) {
                    detailRow(region == "cn" ? Loc.t("m_addkey_region_cn") : Loc.t("m_addkey_region_intl"),
                              region == "cn" ? Loc.t("m_addkey_region_cn_host") : Loc.t("m_addkey_region_intl_host"))
                }.listRowBackground(Color.bbCard)
            }

            if isMiniMaxVoice {
                Section {
                    TextField(Loc.t("m_addkey_group_ph"), text: $groupId)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .font(.system(size: 15, design: .monospaced)).foregroundStyle(Color.bbInk)
                        .onChange(of: groupId) { _, v in MiniMaxConfig.groupId = v }   // persist as edited
                } header: {
                    Text(Loc.t("m_addkey_group"))
                } footer: {
                    Text(Loc.t("m_addkey_group_hint")).foregroundStyle(.secondary)
                }.listRowBackground(Color.bbCard)
            }

            Section {
                if !isActive {
                    Button(Loc.t("m_credetail_setactive")) {
                        Task { try? await app.api?.setActiveCredential(cat, id: cred.id); onChange(); dismiss() }
                    }.foregroundStyle(Color.bbGold)
                }
                Button(role: .destructive) { confirmDelete = true } label: { Text(Loc.t("m_delete_do")) }
            }.listRowBackground(Color.bbCard)
        }
        .scrollContentBackground(.hidden)
        .background(Color.bbBg.ignoresSafeArea())
        .tint(Color.bbGold)
        .navigationTitle(ApiCatalog.name(cred.provider))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if let kind = CredentialKind(rawValue: cat.rawValue) {
                fullKey = NativeEngineHost.shared?.credentialKey(kind, id: cred.id)
            }
        }
        .confirmationDialog(Loc.t("m_delete_do"), isPresented: $confirmDelete, titleVisibility: .visible) {
            Button(Loc.t("m_delete_do"), role: .destructive) {
                Task { try? await app.api?.deleteCredential(cat, id: cred.id); onChange(); dismiss() }
            }
            Button(Loc.t("common_cancel"), role: .cancel) {}
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(Color.bbInkDim)
            Spacer()
            Text(value).foregroundStyle(Color.bbInk).multilineTextAlignment(.trailing)
        }
    }
}

/// Add-credential form · provider picker (carriers / direct for LLM, plain list
/// otherwise) + optional label + the key field (masked, with a reveal toggle).
struct AddKeyView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    let cat: CredCategory
    var onSaved: () -> Void

    @State private var provider: String
    @State private var label = ""
    @State private var key = ""
    @State private var region = "cn"          // MiniMax host region · cn | intl
    @State private var groupId = MiniMaxConfig.groupId   // MiniMax GroupID (optional · only when the key's JWT lacks it)
    @State private var revealed = false
    @State private var saving = false
    @State private var errorText: String?

    private var isMiniMax: Bool { provider == "minimax" }

    init(cat: CredCategory, onSaved: @escaping () -> Void) {
        self.cat = cat
        self.onSaved = onSaved
        _provider = State(initialValue: ApiCatalog.providers(cat: cat.rawValue).first?.id ?? "openrouter")
    }

    private var info: ApiProvider? { ApiCatalog.info(provider) }

    var body: some View {
        Form {
            if cat == .llm {
                providerSection(Loc.t("m_addkey_carriers"), ApiCatalog.providers(cat: "llm", kind: "multi"))
                providerSection(Loc.t("m_addkey_direct"), ApiCatalog.providers(cat: "llm", kind: "single"))
            } else {
                providerSection(Loc.t("m_addkey_provider"), ApiCatalog.providers(cat: cat.rawValue))
            }

            if isMiniMax { regionSection; groupIdSection }

            Section(Loc.t("m_addkey_label")) {
                TextField(Loc.t("m_addkey_label_ph"), text: $label)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .foregroundStyle(Color.bbInk)
            }
            .listRowBackground(Color.bbCard)

            Section {
                HStack {
                    Group {
                        if revealed { TextField(info?.hint ?? "Paste key", text: $key) }
                        else { SecureField(info?.hint ?? "Paste key", text: $key) }
                    }
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .font(.system(size: 15, design: .monospaced)).foregroundStyle(Color.bbInk)
                    Button { revealed.toggle() } label: {
                        Image(systemName: revealed ? "eye.slash" : "eye").foregroundStyle(Color.bbInkFaint)
                    }
                    .buttonStyle(.plain).accessibilityLabel(Loc.t("m_addkey_eye_aria"))
                }
            } header: {
                Text(Loc.t("m_addkey_key"))
            } footer: {
                // Live format check (port of key-validators.js) · warn on an obvious
                // bad paste before it round-trips; else the provider's usage note.
                if let warning = keyWarning {
                    Label(warning, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 12)).foregroundStyle(Color.bbAmber)
                } else if let note = info?.note, !note.isEmpty {
                    Text(note).foregroundStyle(.secondary)
                }
            }
            .listRowBackground(Color.bbCard)

            if let errorText {
                Section { Text(errorText).foregroundStyle(.red) }
                    .listRowBackground(Color.bbCard)
            }

            Section {
                Button(action: save) {
                    HStack {
                        if saving { ProgressView().tint(.black) }
                        Text(Loc.t("m_addkey_save")).fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 6).foregroundStyle(.black)
                }
                .buttonStyle(.glassProminent).tint(.bbGold)
                .disabled(saving || !KeyValidator.isAcceptable(provider: provider, key: key))
            }
            .listRowBackground(Color.clear)
        }
        .scrollContentBackground(.hidden)
        .background(Color.bbBg.ignoresSafeArea())
        .tint(Color.bbGold)
        .navigationTitle(Loc.t("m_cat_\(cat.rawValue)"))
        .navigationBarTitleDisplayMode(.inline)
    }

    /// MiniMax host-region picker · cn → api.minimaxi.com, intl → api.minimax.io.
    /// Mirrors the desktop region pref; stored globally on save.
    private var regionSection: some View {
        Section {
            HStack(spacing: 10) {
                regionTile("cn", Loc.t("m_addkey_region_cn"), Loc.t("m_addkey_region_cn_host"))
                regionTile("intl", Loc.t("m_addkey_region_intl"), Loc.t("m_addkey_region_intl_host"))
            }
            .padding(.vertical, 4)
        } header: {
            Text(Loc.t("m_addkey_region"))
        } footer: {
            Text(Loc.t("m_addkey_region_hint")).foregroundStyle(.secondary)
        }
        .listRowBackground(Color.bbCard)
    }

    /// MiniMax GroupID · optional. Most MiniMax keys are JWTs that already embed the
    /// GroupID (then this can be left blank); set it only when the key doesn't.
    private var groupIdSection: some View {
        Section {
            TextField(Loc.t("m_addkey_group_ph"), text: $groupId)
                .autocorrectionDisabled().textInputAutocapitalization(.never)
                .font(.system(size: 15, design: .monospaced)).foregroundStyle(Color.bbInk)
        } header: {
            Text(Loc.t("m_addkey_group"))
        } footer: {
            Text(Loc.t("m_addkey_group_hint")).foregroundStyle(.secondary)
        }
        .listRowBackground(Color.bbCard)
    }

    private func regionTile(_ id: String, _ title: String, _ host: String) -> some View {
        Button { region = id } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(host).font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(region == id ? Color.bbGold.opacity(0.8) : Color.bbInkFaint)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12).padding(.horizontal, 12)
            .foregroundStyle(region == id ? Color.bbGold : Color.bbInkDim)
            .background(region == id ? Color.bbGold.opacity(0.14) : Color.white.opacity(0.04),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(region == id ? Color.bbGold : Color.bbLine, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private func providerSection(_ title: String, _ provs: [ApiProvider]) -> some View {
        Section(title) {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(provs) { p in
                    Button { provider = p.id } label: {
                        Text(p.name).font(.subheadline.weight(.medium))
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                            .foregroundStyle(provider == p.id ? Color.bbGold : Color.bbInkDim)
                            .background(provider == p.id ? Color.bbGold.opacity(0.14) : Color.white.opacity(0.04),
                                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .stroke(provider == p.id ? Color.bbGold : Color.bbLine, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 4)
        }
        .listRowBackground(Color.bbCard)
    }

    /// Format-validation message for a non-empty, not-yet-valid key (nil otherwise).
    private var keyWarning: String? {
        guard !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return KeyValidator.isAcceptable(provider: provider, key: key)
            ? nil : KeyValidator.describe(provider: provider, key: key)
    }

    private func save() {
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !k.isEmpty else { errorText = Loc.t("m_toast_paste_key"); return }
        if !KeyValidator.isAcceptable(provider: provider, key: k) {
            errorText = KeyValidator.describe(provider: provider, key: k); return
        }
        guard let api = app.api else { errorText = Loc.t("connect_bad"); return }
        if isMiniMax { MiniMaxConfig.groupId = groupId }   // persist the optional GroupID
        saving = true; errorText = nil
        Task {
            do {
                try await api.createCredential(cat, provider: provider, label: label, key: k,
                                               region: isMiniMax ? region : nil)
                saving = false; onSaved(); dismiss()
            } catch {
                saving = false
                errorText = (error as? APIClient.APIError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}
