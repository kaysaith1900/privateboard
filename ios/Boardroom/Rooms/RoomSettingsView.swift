import SwiftUI

/// Room settings · edit the live tone (mode) + intensity and manage the director
/// cast, mirroring the desktop room-settings overlay. Tone / intensity apply on
/// tap (optimistic → the 3D floor recolors via `session.roomMode`); the cast is
/// edited as a set and saved in one PATCH. Adjourned rooms are read-only (the
/// server freezes everything but deliveryMode), so the controls disable.
struct RoomSettingsView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    let session: RoomSession

    @State private var busyField: String?     // "mode" | "intensity" · disables that grid mid-PATCH
    @State private var castSel: Set<String> = []
    @State private var castBusy = false
    @State private var errorText: String?

    private var room: Room { session.room }
    private var isAdjourned: Bool { session.status == .adjourned }

    private let tones: [(id: String, icon: String)] = [
        ("brainstorm", "lightbulb"), ("constructive", "hammer"), ("research", "magnifyingglass"),
        ("debate", "bubble.left.and.bubble.right"), ("critique", "scope"),
    ]
    private let intensities: [(id: String, icon: String)] = [
        ("calm", "leaf"), ("sharp", "bolt"), ("terse", "scissors"),
    ]

    /// The room's current director ids (chair + user excluded).
    private var currentDirectorIds: Set<String> {
        Set(session.members
            .filter { $0.id != "__user" && $0.roleKind != "moderator" && $0.roleKind != "chair" }
            .map { $0.id })
    }
    private var castUnchanged: Bool { castSel == currentDirectorIds }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.bbBg.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        if isAdjourned {
                            Text(Loc.t("m_set_adjourned_note"))
                                .font(.system(size: 14)).foregroundStyle(Color.bbInkDim)
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        BBGroup(Loc.t("m_set_tone")) {
                            BBTileGrid {
                                ForEach(tones, id: \.id) { o in
                                    BBTile(icon: o.icon, label: toneName(o.id), selected: session.roomMode == o.id) {
                                        changeMode(o.id)
                                    }
                                }
                            }
                        }
                        .disabled(isAdjourned || busyField == "mode")

                        BBGroup(Loc.t("m_set_intensity")) {
                            BBTileGrid {
                                ForEach(intensities, id: \.id) { o in
                                    BBTile(icon: o.icon, label: Loc.t("m_int_\(o.id)"), selected: session.roomIntensity == o.id) {
                                        changeIntensity(o.id)
                                    }
                                }
                            }
                        }
                        .disabled(isAdjourned || busyField == "intensity")

                        deliverySection

                        voteSection

                        BBGroup(Loc.t("m_menu_cast")) {
                            VStack(spacing: 8) {
                                ForEach(app.agents) { a in
                                    Button { toggleCast(a.id) } label: { castRow(a) }
                                        .buttonStyle(.plain)
                                }
                                if castSel.isEmpty {
                                    Text(Loc.t("m_set_cast_min")).font(.system(size: 12)).foregroundStyle(.red)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                Button(action: saveCast) {
                                    HStack(spacing: 8) {
                                        if castBusy { ProgressView().tint(.black) }
                                        Text(Loc.t("m_set_cast_save")).fontWeight(.semibold)
                                    }
                                    .frame(maxWidth: .infinity).padding(.vertical, 8).foregroundStyle(.black)
                                }
                                .buttonStyle(.glassProminent).tint(.bbGold)
                                .disabled(castBusy || castSel.isEmpty || castUnchanged)
                                .padding(.top, 2)
                            }
                        }
                        .disabled(isAdjourned)

                        if let errorText {
                            Text(errorText).font(.footnote).foregroundStyle(.red)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle(Loc.t("m_menu_settings"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(Loc.t("common_done")) { dismiss() } } }
            .task {
                await app.ensureAgentsLoaded()
                castSel = currentDirectorIds
            }
        }
    }

    /// Voice on/off · text mode means no TTS (the server stops synthesising and
    /// the room shows the transcript). Editable live, including when adjourned
    /// (deliveryMode is the one setting the server keeps mutable post-adjourn).
    private var deliverySection: some View {
        BBGroup(Loc.t("m_set_delivery")) {
            HStack(spacing: 12) {
                Image(systemName: session.isVoice ? "waveform" : "text.bubble")
                    .font(.system(size: 18))
                    .foregroundStyle(session.isVoice ? Color.bbGold : Color.bbInkDim)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Loc.t("m_set_voice")).font(.bbCardTitle).foregroundStyle(Color.bbInk)
                    Text(Loc.t("m_set_voice_sub")).font(.system(size: 12)).foregroundStyle(Color.bbInkDim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                Toggle("", isOn: Binding(get: { session.isVoice }, set: { setVoice($0) }))
                    .labelsHidden().tint(.bbGold).disabled(busyField == "delivery")
            }
            .padding(12)
            .background(Color.bbSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
        }
    }

    /// Vote-phase trigger · Auto (chair gavels + opens the vote each round wrap) vs
    /// Manual (directors keep going; you open the vote with the composer button).
    /// Editable live; the running engine re-reads it at the next round wrap.
    private var voteSection: some View {
        BBGroup(Loc.t("m_set_vote")) {
            VStack(alignment: .leading, spacing: 8) {
                BBTileGrid {
                    BBTile(icon: "bolt.badge.automatic", label: Loc.t("m_vote_auto"),
                           selected: session.voteTrigger != "manual") { changeVoteTrigger("auto") }
                    BBTile(icon: "hand.tap", label: Loc.t("m_vote_manual"),
                           selected: session.voteTrigger == "manual") { changeVoteTrigger("manual") }
                }
                Text(session.voteTrigger == "manual" ? Loc.t("m_vote_manual_sub") : Loc.t("m_vote_auto_sub"))
                    .font(.system(size: 12)).foregroundStyle(Color.bbInkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .disabled(isAdjourned)
    }

    private func castRow(_ a: Agent) -> some View {
        let on = castSel.contains(a.id)
        return HStack(spacing: 12) {
            AvatarView(path: a.avatarPath, name: a.name, size: 38)
            VStack(alignment: .leading, spacing: 2) {
                Text(a.name).font(.bbCardTitle).foregroundStyle(Color.bbInk).lineLimit(1)
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
    }

    // MARK: Actions

    private func changeMode(_ m: String) {
        guard session.roomMode != m else { return }
        let prev = session.roomMode
        session.roomMode = m                 // optimistic · the floor recolors immediately
        guard let api = app.api else { return }
        busyField = "mode"; errorText = nil
        Task {
            do { _ = try await api.updateRoomSettings(room.id, mode: m) }
            catch { session.roomMode = prev; errorText = friendly(error) }
            busyField = nil
        }
    }

    private func changeIntensity(_ i: String) {
        guard session.roomIntensity != i else { return }
        let prev = session.roomIntensity
        session.roomIntensity = i
        guard let api = app.api else { return }
        busyField = "intensity"; errorText = nil
        Task {
            do { _ = try await api.updateRoomSettings(room.id, intensity: i) }
            catch { session.roomIntensity = prev; errorText = friendly(error) }
            busyField = nil
        }
    }

    /// Route the vote-trigger change through the SESSION's backend (the live
    /// `RoomBackend` — native `EngineRoomBackend` writes GRDB directly, REST hits
    /// the server). `app.api` is the loopback in native mode, whose PATCH doesn't
    /// map `vote_trigger`, so it would silently drop the edit. `setVoteTrigger`
    /// updates `session.voteTrigger` optimistically + reverts on failure.
    private func changeVoteTrigger(_ v: String) {
        errorText = nil
        session.setVoteTrigger(v)
    }

    private func setVoice(_ on: Bool) {
        guard session.isVoice != on else { return }
        let mode = on ? "voice" : "text"
        let prev = session.deliveryMode
        session.setDeliveryMode(mode)        // optimistic · stops TTS + swaps stage→transcript at once
        guard let api = app.api else { return }
        busyField = "delivery"; errorText = nil
        Task {
            do { _ = try await api.updateRoomSettings(room.id, deliveryMode: mode) }
            catch { session.setDeliveryMode(prev); errorText = friendly(error) }
            busyField = nil
        }
    }

    private func toggleCast(_ id: String) {
        if castSel.contains(id) { castSel.remove(id) } else { castSel.insert(id) }
    }

    private func saveCast() {
        guard !castSel.isEmpty, let api = app.api else { return }
        castBusy = true; errorText = nil
        let ids = Array(castSel)
        Task {
            do {
                try await api.updateRoomMembers(room.id, agentIds: ids)
                // The picker holds full agents → byline role/model resolve at once.
                let directors = app.agents.filter { castSel.contains($0.id) }.map {
                    Member(id: $0.id, name: $0.name, avatarPath: $0.avatarPath,
                           roleKind: $0.roleKind, roleTag: $0.roleTag, modelV: $0.modelV)
                }
                session.setDirectors(directors)
            } catch {
                errorText = friendly(error)
            }
            castBusy = false
        }
    }

    private func friendly(_ error: Error) -> String {
        (error as? APIClient.APIError)?.errorDescription ?? error.localizedDescription
    }
}
