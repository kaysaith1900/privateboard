import SwiftUI
import UIKit

/// Directors panel · 1:1 with the web directors tab:
/// • "MOST USED" — a horizontally-scrolling strip of ranked podium cards
///   (rank · portrait · name · role · room count; #1 is a gold champion tile).
/// • "ALL DIRECTORS" — a vertical list of identity cards (avatar ring + role
///   kicker / name / handle + chevron, then a 2-line bio).
struct DirectorsPanel: View {
    @Environment(AppState.self) private var app
    @Binding var path: NavigationPath

    /// Persisted "ALL DIRECTORS" sort order. The chair is always pinned first
    /// (it's the moderator, not a created seat); only the directors below sort.
    enum DirSort: String, CaseIterable, Identifiable {
        case newest, oldest, name
        var id: String { rawValue }
        var label: String {
            switch self {
            case .newest: return Loc.t("m_dir_sort_newest")
            case .oldest: return Loc.t("m_dir_sort_oldest")
            case .name:   return Loc.t("m_dir_sort_name")
            }
        }
    }
    @AppStorage("directorSort") private var sortRaw: String = DirSort.newest.rawValue
    private var sortMode: DirSort { DirSort(rawValue: sortRaw) ?? .newest }

    private func isChairSeat(_ a: Agent) -> Bool { a.roleKind == "chair" || a.roleKind == "moderator" }

    /// Roster sorted for display · chair pinned first, directors ordered by the
    /// persisted mode. `createdAt` is epoch-ms (nil sorts as 0 → oldest).
    private var sortedRoster: [Agent] {
        let chairs = app.roster.filter(isChairSeat)
        let dirs = app.roster.filter { !isChairSeat($0) }
        let sorted: [Agent]
        switch sortMode {
        case .newest: sorted = dirs.sorted { ($0.createdAt ?? 0) > ($1.createdAt ?? 0) }
        case .oldest: sorted = dirs.sorted { ($0.createdAt ?? 0) < ($1.createdAt ?? 0) }
        case .name:   sorted = dirs.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }
        return chairs + sorted
    }

    /// How many rooms a director sits in · uses the hydrated member cache
    /// (real rooms — the list endpoint omits members) falling back to the
    /// room's directorIds (demo / when ids are present).
    private func usage(_ id: String) -> Int {
        app.rooms.filter { room in
            if let cached = app.roomDirectorCache[room.id] { return cached.contains { $0.id == id } }
            return (room.directorIds ?? []).contains(id)
        }.count
    }
    private var topUsed: [(agent: Agent, n: Int)] {
        var ranked: [(agent: Agent, n: Int)] = app.agents.map { (agent: $0, n: usage($0.id)) }
        ranked.sort { $0.n > $1.n }
        return Array(ranked.prefix(3)).filter { $0.n > 0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if app.roster.isEmpty {
                StateMessage(icon: "person.2",
                             title: app.agentsError ?? Loc.t("m_rooms_empty")) {
                    Task { await app.ensureAgentsLoaded() }
                }
            } else {
                if topUsed.isEmpty {
                    allDirectorsHeader(rule: false)
                        .padding(.bottom, 11)
                } else {
                    sectionHeader(Loc.t("m_dir_most_used"), topUsed.count, rule: false, color: .bbGold)
                        .padding(.bottom, 11)
                    featStrip
                    allDirectorsHeader(rule: true)
                        .padding(.top, 22).padding(.bottom, 11)
                }
                VStack(spacing: 12) {
                    ForEach(sortedRoster) { agent in
                        Button { path.append(agent) } label: { DirCard(agent: agent) }
                            .buttonStyle(.plain)
                    }
                }
            }
        }
        .task {
            await app.ensureAgentsLoaded()
            await app.hydrateRoomDirectors()   // fills usage data for the "Most used" strip
        }
    }

    /// The 16pt margin HomeView wraps every panel in. The strip cancels it so the
    /// horizontal scroll runs EDGE-TO-EDGE (cards cut at the device width, not 16pt
    /// early), while the inner content inset re-applies it so the first card still
    /// lines up with the section header and the list below.
    private static let panelInset: CGFloat = 16

    private var featStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(Array(topUsed.enumerated()), id: \.element.agent.id) { i, item in
                    Button { path.append(item.agent) } label: {
                        FeatCard(agent: item.agent, rank: i + 1, count: item.n)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Self.panelInset)   // align first/last with the content margin
            .padding(.bottom, 2)
        }
        .padding(.horizontal, -Self.panelInset)      // break out of HomeView's panel padding → full-width scroll
        .defaultScrollAnchor(.leading)
    }

    /// "ALL DIRECTORS" header · the section label + count, the fill rule, AND a
    /// trailing sort menu (persisted via `@AppStorage`). Built on top of
    /// `sectionHeader`'s register so it matches the Most-Used header exactly.
    private func allDirectorsHeader(rule: Bool) -> some View {
        HStack(spacing: 10) {
            Text(Loc.t("m_dir_all").uppercased())
                .font(.system(size: 13, weight: .bold, design: .monospaced)).kerning(1.5)
                .foregroundStyle(rule ? Color.bbInk : Color.bbGold)
            countChip(app.roster.count,
                      bg: rule ? Color.white.opacity(0.07) : Color.bbGold.opacity(0.18),
                      fg: rule ? .bbInkDim : .bbGold)
            if rule { Rectangle().fill(Color.bbLine).frame(height: 1) } else { Spacer(minLength: 0) }
            sortMenu
        }
        .padding(.horizontal, 2)
    }

    /// Sort picker · a glass pill showing the active order; tapping opens a menu
    /// with a checkmark on the current choice. The selection binds straight to
    /// the persisted `sortRaw`, so it survives relaunch.
    private var sortMenu: some View {
        Menu {
            Picker(selection: $sortRaw) {
                ForEach(DirSort.allCases) { mode in Text(mode.label).tag(mode.rawValue) }
            } label: { Text(Loc.t("m_dir_all")) }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "arrow.up.arrow.down").font(.system(size: 10, weight: .bold))
                Text(sortMode.label)
                    .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(0.3)
            }
            .foregroundStyle(Color.bbInkDim)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(Capsule().fill(Color.white.opacity(0.06)))
        }
    }

    /// Section header · mirrors RoomsPanel.bucketHeader so the Directors tab reads
    /// the same as the Rooms tab: mono label + count chip, and (for non-leading
    /// sections) a hairline rule that fills to the RIGHT of the label.
    private func sectionHeader(_ text: String, _ count: Int, rule: Bool, color: Color) -> some View {
        HStack(spacing: 10) {
            Text(text.uppercased())
                .font(.system(size: 13, weight: .bold, design: .monospaced)).kerning(1.5)
                .foregroundStyle(color)
            countChip(count,
                      bg: color == .bbGold ? Color.bbGold.opacity(0.18) : Color.white.opacity(0.07),
                      fg: color == .bbGold ? .bbGold : .bbInkDim)
            if rule { Rectangle().fill(Color.bbLine).frame(height: 1) }
            else { Spacer(minLength: 0) }
        }
        .padding(.horizontal, 2)
    }

    private func countChip(_ n: Int, bg: Color, fg: Color) -> some View {
        Text("\(n)")
            .font(.system(size: 11, weight: .bold, design: .monospaced))
            .foregroundStyle(fg)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(bg))
    }
}

// MARK: - Avatar ring (chair / champion gets a gold rim)

/// Director avatar · a flat solid-colour circle with the figure scaled up large and
/// anchored to the TOP, so the head shows in full with a little headroom while the
/// lower body runs off the bottom (clipped to the circle). No shadow / ring / gradient.
struct AvatarRing: View {
    let path: String?
    let name: String
    let size: CGFloat
    var gold: Bool = false
    @State private var img: UIImage?

    var body: some View {
        ZStack {
            Circle().fill(gold ? Color(hex: 0x6E5A38) : Color(hex: 0x5C5C60))

            if let img {
                Image(uiImage: img)
                    .resizable().scaledToFill()
                    .scaleEffect(1.08, anchor: .top)       // head + shoulders/upper body visible; only the very bottom runs off
            } else {
                Text(String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
                    .font(.system(size: size * 0.4, weight: .bold))
                    .foregroundStyle(gold ? Color.bbGold : Color.bbInk)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())                               // lower body truncated by the circle
        .task(id: path) { img = AvatarView.loadLocal(path) }
    }
}

// MARK: - Featured podium card

private struct FeatCard: View {
    let agent: Agent
    let rank: Int
    let count: Int
    private var isTop: Bool { rank == 1 }

    var body: some View {
        VStack(spacing: 5) {
            AvatarRing(path: agent.avatarPath, name: agent.name, size: 64, gold: isTop)
            Text(agent.name)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.bbInk).lineLimit(1)
            Text((agent.roleTag ?? Loc.t("m_ap_title")).uppercased())
                .font(.system(size: 9, weight: .bold, design: .monospaced)).kerning(1.0)
                .foregroundStyle(Color.bbGold).lineLimit(1)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("\(count)").font(.system(size: 17, weight: .bold)).foregroundStyle(Color.bbInk)
                Text(Loc.t("m_dir_rooms").uppercased())
                    .font(.system(size: 10, design: .monospaced)).kerning(0.8)
                    .foregroundStyle(Color.bbInkFaint)
            }
            .padding(.top, 1)
        }
        .frame(width: 138)
        .padding(EdgeInsets(top: 16, leading: 12, bottom: 14, trailing: 12))
        .background(
            LinearGradient(
                colors: isTop
                    ? [Color.bbGold.opacity(0.16), Color(hex: 0x141210)]
                    : [Color(hex: 0x1B1B1B), Color(hex: 0x131313)],
                startPoint: .top, endPoint: .bottom),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: isTop
                            ? [Color.bbGold.opacity(0.5), Color.bbGold.opacity(0.10)]
                            : [Color.white.opacity(0.12), Color.white.opacity(0.025)],
                        startPoint: .top, endPoint: .bottom),
                    lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.28), radius: 9, y: 3)
        .overlay(alignment: .topLeading) {
            Text(String(format: "%02d", rank))
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(isTop ? Color.bbGold : Color.bbInkFaint)
                .padding(.init(top: 11, leading: 13, bottom: 0, trailing: 0))
        }
    }
}

// MARK: - Identity card

private struct DirCard: View {
    let agent: Agent
    private var isChair: Bool { agent.roleKind == "chair" || agent.roleKind == "moderator" }
    private var handle: String { "@" + agent.name.lowercased().replacingOccurrences(of: " ", with: "") }
    private var roleKicker: String {
        agent.roleTag ?? (isChair ? Loc.t("m_ap_moderator") : Loc.t("m_ap_title"))
    }

    var body: some View {
        // Avatar vertically centred against the whole text column (role → name →
        // handle → bio), and the bio lives INSIDE that column so it aligns to the
        // same leading edge as the name instead of spanning under the avatar.
        HStack(alignment: .center, spacing: 13) {
            AvatarRing(path: agent.avatarPath, name: agent.name, size: 54, gold: isChair)
            VStack(alignment: .leading, spacing: 5) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(roleKicker.uppercased())
                        .font(.system(size: 10, weight: .bold, design: .monospaced)).kerning(1.4)
                        .foregroundStyle(Color.bbGold).lineLimit(1)
                    Text(agent.name)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Color.bbInk).lineLimit(1)
                    Text(handle)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.bbInkFaint).lineLimit(1)
                }
                if let bio = agent.bio, !bio.isEmpty {
                    Text(bio)
                        .font(.system(size: 14)).lineSpacing(2)
                        .foregroundStyle(Color.bbInkDim).lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            // Chevron pinned to the TOP of the row (avatar stays centred) so it sits
            // high like the Rooms card chevron, not floating mid-card.
            Image(systemName: "chevron.right")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Color.bbInkFaint)
                .frame(maxHeight: .infinity, alignment: .top)
        }
        .padding(EdgeInsets(top: 14, leading: 15, bottom: 14, trailing: 15))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(colors: [Color(hex: 0x1A1A1A), Color(hex: 0x121212)],
                           startPoint: .top, endPoint: .bottom),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        // Single INSET hairline (strokeBorder) with a top-lit gradient — a soft
        // beveled edge catching light from above, not a flat outline that doubles up.
        // Chair gets a gold-lit edge. This is the premium treatment the Rooms cards mirror.
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: isChair
                            ? [Color.bbGold.opacity(0.5), Color.bbGold.opacity(0.10)]
                            : [Color.white.opacity(0.12), Color.white.opacity(0.025)],
                        startPoint: .top, endPoint: .bottom),
                    lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.28), radius: 9, y: 3)
    }
}
