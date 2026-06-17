import SwiftUI

/// Rooms content · hosted inside HomeView's ScrollView, below the masthead.
/// Top: a horizontal rail of ACTIVE sessions (live + paused) with a game-y,
/// status-tinted card. Below: ADJOURNED sessions bucketed by Today / This Week
/// / Earlier.
struct RoomsPanel: View {
    @Environment(AppState.self) private var app
    @Binding var path: NavigationPath
    var onCreate: () -> Void = {}   // empty-state CTA · routes to HomeView.startRoom (LLM-key gated)

    private var activeRooms: [Room] { app.rooms.filter { $0.bucket != .adjourned } }

    private struct Bucket: Identifiable { let id: String; let title: String; let rooms: [Room] }

    /// ALL rooms split into Today / This Week / Earlier by `createdAt`. Live /
    /// paused rooms also appear in the top Active rail — surfacing them here too
    /// (by date) keeps the chronological list complete; the two views coexist.
    private var buckets: [Bucket] {
        let cal = Calendar.current
        let now = Date()
        let weekAgo = cal.date(byAdding: .day, value: -7, to: now)
        var today: [Room] = [], week: [Room] = [], earlier: [Room] = []
        for r in app.rooms {
            if let d = r.createdAt?.date, cal.isDateInToday(d) { today.append(r) }
            else if let d = r.createdAt?.date, let wk = weekAgo, d >= wk { week.append(r) }
            else { earlier.append(r) }
        }
        return [
            Bucket(id: "today", title: Loc.t("m_home_today"), rooms: today),
            Bucket(id: "week", title: Loc.t("m_home_week"), rooms: week),
            Bucket(id: "earlier", title: Loc.t("m_home_earlier"), rooms: earlier),
        ]
    }

    var body: some View {
        if app.rooms.isEmpty {
            inlineState
        } else {
            LazyVStack(alignment: .leading, spacing: 16) {
                if !activeRooms.isEmpty {
                    railKicker(activeRooms.count)
                    activeRail
                }
                ForEach(buckets) { b in
                    if !b.rooms.isEmpty {
                        bucketHeader(b.title, b.rooms.count)
                        ForEach(b.rooms) { room in
                            // Programmatic push (NOT NavigationLink) — value links
                            // inside a LazyVStack/ScrollView fire navigation twice.
                            Button { path.append(room) } label: { RoomCard(room: room) }
                                .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    // ── Active rail ────────────────────────────────────────────────────────
    private var activeRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(activeRooms) { room in
                    Button { path.append(room) } label: { ActiveRoomCard(room: room) }
                        .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 2)
        }
        .scrollClipDisabled()
    }

    private func railKicker(_ count: Int) -> some View {
        HStack(spacing: 9) {
            PulseDot(color: .bbGold, on: true)
            Text(Loc.t("m_home_active").uppercased())
                .font(.system(size: 13, weight: .bold, design: .monospaced)).kerning(1.8)
                .foregroundStyle(Color.bbGold)
            countChip(count, bg: Color.bbGold.opacity(0.18), fg: .bbGold)
            Spacer()
        }
        .padding(.horizontal, 2)
    }

    private func bucketHeader(_ title: String, _ count: Int) -> some View {
        HStack(spacing: 10) {
            Text(title.uppercased())
                .font(.system(size: 13, weight: .bold, design: .monospaced)).kerning(1.5)
                .foregroundStyle(Color.bbInk)
            countChip(count, bg: Color.white.opacity(0.07), fg: .bbInkDim)
            Rectangle().fill(Color.bbLine).frame(height: 1)
        }
        .padding(.horizontal, 2).padding(.top, 6)
    }

    private func countChip(_ n: Int, bg: Color, fg: Color) -> some View {
        Text("\(n)")
            .font(.system(size: 11, weight: .bold, design: .monospaced))
            .foregroundStyle(fg)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(bg))
    }

    @ViewBuilder private var inlineState: some View {
        switch app.phase {
        case .error(let message):
            StateMessage(icon: "wifi.exclamationmark", title: message) { Task { await app.refresh() } }
        case .loading:
            ProgressView().tint(.bbGold).frame(maxWidth: .infinity).padding(.top, 60)
        default:
            RoomsEmptyState(onCreate: onCreate)
        }
    }
}

/// Gamified empty-rooms placeholder · a top-down round-table emblem with depth —
/// a radial gold glow, layered table rings, gradient seat chips (the head seat
/// tinted gold) around a breathing gold "convene" core, plus a slow orbiting
/// marker for life. No CTA button: the gold "+" FAB in the bottom bar is the
/// single create entry point and the sub copy already points to it.
struct RoomsEmptyState: View {
    var onCreate: () -> Void
    @State private var breathe = false
    @State private var spin = false
    private let seats = 8
    private let seatRadius: CGFloat = 84

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 16)
            emblem
            Text(Loc.t("m_rooms_start_kicker"))
                .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(2.4)
                .foregroundStyle(Color.bbGold).padding(.top, 30)
            Text(Loc.t("m_rooms_start_head"))
                .font(.system(size: 23, weight: .bold)).foregroundStyle(Color.bbInk)
                .multilineTextAlignment(.center).padding(.top, 9)
            Text(Loc.t("m_rooms_start_sub"))
                .font(.system(size: 14)).foregroundStyle(Color.bbInkDim).lineSpacing(3)
                .multilineTextAlignment(.center).padding(.top, 8).padding(.horizontal, 34)
            Spacer(minLength: 16)
        }
        .frame(maxWidth: .infinity)
        .containerRelativeFrame(.vertical, alignment: .center)
    }

    // ── Round-table emblem ─────────────────────────────────────────────────
    private var emblem: some View {
        ZStack {
            // Depth · soft radial gold glow behind the table.
            RadialGradient(colors: [Color.bbGold.opacity(0.13), .clear],
                           center: .center, startRadius: 4, endRadius: 132)
                .frame(width: 264, height: 264)

            // Table rings · outer solid rim + inner dashed "targeting" ring.
            Circle().stroke(Color.bbLine, lineWidth: 1).frame(width: 196, height: 196)
            Circle()
                .stroke(Color.bbGold.opacity(0.16), style: StrokeStyle(lineWidth: 1, dash: [2, 7]))
                .frame(width: 132, height: 132)

            // Seat chips · subtle vertical-gradient discs with a thin rim. The
            // head seat (top) is tinted gold — the chair / focal point.
            ForEach(0..<seats, id: \.self) { i in
                let ang = Double(i) / Double(seats) * 2 * .pi - .pi / 2
                seatChip(head: i == 0)
                    .offset(x: CGFloat(cos(ang)) * seatRadius, y: CGFloat(sin(ang)) * seatRadius)
            }

            // Orbiting marker · a slow gold dot that scans the table (gamified life).
            Circle().fill(Color.bbGold).frame(width: 7, height: 7)
                .offset(y: -seatRadius)
                .rotationEffect(.degrees(spin ? 360 : 0))

            // Convene core · a breathing gold orb with a top-left specular
            // highlight (gem depth) and a faint ring.
            conveneCore
        }
        .frame(height: 224)
        .onAppear {
            withAnimation(.easeInOut(duration: 2.1).repeatForever(autoreverses: true)) { breathe = true }
            withAnimation(.linear(duration: 14).repeatForever(autoreverses: false)) { spin = true }
        }
    }

    private func seatChip(head: Bool) -> some View {
        Circle()
            .fill(LinearGradient(
                colors: head ? [Color.bbGold, Color.bbGold.opacity(0.6)]
                             : [Color.bbSurfaceHi, Color.bbSurface],
                startPoint: .top, endPoint: .bottom))
            .frame(width: 19, height: 19)
            .overlay(Circle().stroke(head ? Color.bbGold.opacity(0.7) : Color.bbLine, lineWidth: 1))
    }

    private var conveneCore: some View {
        Circle()
            .fill(RadialGradient(
                colors: [Color.bbGold, Color.bbGold.opacity(0.5)],
                center: UnitPoint(x: 0.38, y: 0.3), startRadius: 2, endRadius: 42))
            .frame(width: 66, height: 66)
            .overlay(
                Circle().fill(Color.white.opacity(0.28))
                    .frame(width: 16, height: 16)
                    .offset(x: -11, y: -13).blur(radius: 4))
            .overlay(Circle().strokeBorder(Color.bbGold.opacity(0.65), lineWidth: 1))
            .scaleEffect(breathe ? 1.06 : 0.95)
    }
}

/// Active (live / paused) session card · horizontal-rail hero. Status-tinted
/// gradient wash + same-color hairline edge + pulsing status dot + a faded tone
/// glyph watermark — the "game" energy; the raw query is the hero.
struct ActiveRoomCard: View {
    @Environment(AppState.self) private var app
    let room: Room
    private var directors: [Agent] { app.directors(for: room) }
    private var status: RoomStatus { room.bucket }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                PulseDot(color: status.tint, on: status.pulses)
                Text(status.label.uppercased())
                    .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(1.4)
                    .foregroundStyle(status.tint)
                Spacer()
                Image(systemName: Tone.icon(room.mode)).font(.system(size: 12)).foregroundStyle(Color.bbInkDim)
            }
            Text(room.rawQuery)
                .font(.system(size: 17, weight: .semibold)).lineSpacing(2)
                .foregroundStyle(Color.bbInk).lineLimit(3)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            HStack(spacing: -8) {
                ForEach(directors.prefix(4)) { d in
                    AvatarView(path: d.avatarPath, name: d.name, size: 26)
                        .overlay(Circle().stroke(Color.bbSurfaceHi, lineWidth: 2))
                }
                Spacer(minLength: 0)
            }
        }
        .padding(16)
        .frame(width: 266, height: 168, alignment: .topLeading)
        .background {
            ZStack(alignment: .bottomTrailing) {
                Color.bbSurfaceHi
                LinearGradient(colors: [status.tint.opacity(0.18), .clear],
                               startPoint: .topLeading, endPoint: .center)
                Image(systemName: Tone.icon(room.mode))
                    .font(.system(size: 96, weight: .regular))
                    .foregroundStyle(Color.white.opacity(0.035))
                    .offset(x: 22, y: 26)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        // Same inset top-lit hairline as the Directors cards, tinted by the room's
        // status (live / paused) the way the chair card uses gold. Soft shadow floats it.
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(
                    LinearGradient(colors: [status.tint.opacity(0.5), status.tint.opacity(0.12)],
                                   startPoint: .top, endPoint: .bottom),
                    lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.28), radius: 9, y: 3)
    }
}

/// Room list card · 1:1 with the web `.vr-roomcard`:
/// tone icon + name (top) · raw opening query clamped to 3 lines · foot with
/// overlapping director avatars (left) + mono meta pushed right.
struct RoomCard: View {
    @Environment(AppState.self) private var app
    let room: Room

    private var directors: [Agent] { app.directors(for: room) }
    /// How many skeleton dots to hold while directors hydrate · the room's known
    /// director-id count when available, else a sensible default.
    private var placeholderCount: Int { min(5, max(2, room.directorIds?.count ?? 3)) }
    /// Stable count for the meta line · prefers the known director-ids so the
    /// number doesn't jump from 0 when the avatars hydrate.
    private var directorCount: Int { directors.isEmpty ? (room.directorIds?.count ?? 0) : directors.count }

    private var meta: String {
        let delivery = room.isVoice ? Loc.t("m_rc_voice") : Loc.t("m_rc_text")
        let n = "\(directorCount)"
        let ago = RelativeTime.short(room.createdAt?.date)
        return ago.isEmpty
            ? Loc.t("m_rc_meta_noago", ["delivery": delivery, "n": n])
            : Loc.t("m_rc_meta", ["delivery": delivery, "n": n, "ago": ago])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Head · tone icon + tone name, with the disclosure chevron pushed right
            // (matches the Directors cards).
            HStack(spacing: 6) {
                Image(systemName: Tone.icon(room.mode))
                    .font(.system(size: 13, weight: .regular))
                Text(Tone.name(room.mode))
                    .font(.system(size: 12))
                // Report badge · this room has a generated closing brief.
                if app.reportRoomIds.contains(room.id) {
                    HStack(spacing: 4) {
                        Image(systemName: "doc.text.fill").font(.system(size: 9))
                        Text(Loc.t("m_rc_report_badge"))
                            .font(.system(size: 9, weight: .bold, design: .monospaced)).kerning(0.6)
                    }
                    .foregroundStyle(Color.bbGold)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(Color.bbGold.opacity(0.14), in: Capsule())
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Color.bbInkFaint)
            }
            .foregroundStyle(Color.bbInkDim)

            // Raw opening query · 3-line clamp
            Text(room.rawQuery)
                .font(.system(size: 20, weight: .semibold))
                .lineSpacing(2)
                .foregroundStyle(Color.bbInk)
                .lineLimit(3)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            // Foot · overlapping avatars + mono meta. Directors hydrate async
            // (member fetch), so until they land we render skeleton circles —
            // same 26pt footprint — to hold the row height and avoid the card
            // jolting taller the moment the avatars pop in.
            HStack(spacing: 12) {
                HStack(spacing: -8) {
                    if directors.isEmpty {
                        ForEach(0..<placeholderCount, id: \.self) { _ in
                            SkeletonCircle(size: 26)
                                .overlay(Circle().stroke(Color.bbSurface, lineWidth: 2))
                        }
                    } else {
                        ForEach(directors.prefix(5)) { d in
                            AvatarView(path: d.avatarPath, name: d.name, size: 26)
                                .overlay(Circle().stroke(Color.bbSurface, lineWidth: 2))
                        }
                    }
                }
                Spacer()
                Text(meta)
                    .font(.system(size: 10, weight: .regular, design: .monospaced))
                    .kerning(0.3)
                    .foregroundStyle(Color.bbInkFaint)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Same premium treatment as the Directors cards · subtle vertical-gradient
        // fill + a single inset top-lit hairline + a soft shadow.
        .background(
            LinearGradient(colors: [Color(hex: 0x1A1A1A), Color(hex: 0x121212)],
                           startPoint: .top, endPoint: .bottom),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(
                    LinearGradient(colors: [Color.white.opacity(0.12), Color.white.opacity(0.025)],
                                   startPoint: .top, endPoint: .bottom),
                    lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.28), radius: 9, y: 3)
    }
}

/// Skeleton placeholder dot · a gently pulsing grey circle shown while async
/// content (director avatars) loads, so the layout reserves its final size and
/// doesn't jolt when the real content arrives. Single-dim opacity pulse only
/// (no shadow/glow animation · project rule).
struct SkeletonCircle: View {
    var size: CGFloat
    @State private var pulse = false
    var body: some View {
        Circle()
            .fill(Color.bbInk.opacity(pulse ? 0.13 : 0.06))
            .frame(width: size, height: size)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { pulse = true }
            }
    }
}

/// Tone → SF Symbol + localized name (mirrors the web TONES icons).
enum Tone {
    static func icon(_ id: String?) -> String {
        switch id {
        case "brainstorm": return "lightbulb"
        case "research":   return "testtube.2"
        case "debate":     return "bubble.left.and.bubble.right"
        case "critique":   return "target"
        default:           return "square.stack.3d.up"   // constructive
        }
    }
    static func name(_ id: String?) -> String { Loc.t("m_tone_\(id ?? "constructive")") }
}

/// Centered empty / error message — top-padded (safe inside a ScrollView; no
/// infinite frame).
struct StateMessage: View {
    let icon: String
    let title: String
    let action: (() -> Void)?
    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: icon).font(.largeTitle).foregroundStyle(Color.bbInkFaint)
            Text(title).font(.callout).foregroundStyle(Color.bbInkDim).multilineTextAlignment(.center)
            if let action { Button(Loc.t("common_retry")) { action() }.tint(.bbGold) }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
    }
}
