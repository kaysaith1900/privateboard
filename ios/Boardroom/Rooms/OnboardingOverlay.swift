import SwiftUI

/// First-run onboarding · a dismissable overlay (sheet) of gamified "starter
/// plays" shown over an empty Rooms tab. Deliberately a standalone overlay so the
/// RoomsPanel / RoomsListView stay a pure rooms list — no onboarding logic leaks
/// into that surface. Picking a play hands the scenario back up (`onPick`) where
/// HomeView gates it on an API key and opens the pre-filled composer.
struct OnboardingOverlay: View {
    let roster: [Agent]
    var onPick: (RoomScenario) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    VStack(spacing: 12) {
                        ForEach(RoomScenario.all) { s in
                            Button { onPick(s) } label: { ScenarioCard(scenario: s, roster: roster) }
                                .buttonStyle(.plain)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .padding(.bottom, 24)
            }
            .scrollContentBackground(.hidden)
            .background(Color.bbBg.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button(Loc.t("common_done")) { dismiss() } } }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 9) {
                PulseDot(color: .bbGold, on: true)
                Text(Loc.t("m_rooms_start_kicker"))
                    .font(.system(size: 12, weight: .bold, design: .monospaced)).kerning(1.6)
                    .foregroundStyle(Color.bbGold)
            }
            Text(Loc.t("m_rooms_start_head"))
                .font(.system(size: 26, weight: .bold)).foregroundStyle(Color.bbInk)
                .fixedSize(horizontal: false, vertical: true)
            Text(Loc.t("m_rooms_start_sub"))
                .font(.system(size: 14)).lineSpacing(2).foregroundStyle(Color.bbInkDim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 2).padding(.top, 4)
    }
}

/// One starter-play card · mono kicker + headline + hint + overlapping cast.
private struct ScenarioCard: View {
    let scenario: RoomScenario
    let roster: [Agent]

    private var cast: [Agent] { scenario.matchedDirectors(in: roster) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(scenario.tag.uppercased())
                    .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(0.8)
                    .foregroundStyle(Color.bbGold).lineLimit(1).minimumScaleFactor(0.8)
                Spacer(minLength: 6)
                Image(systemName: "arrow.right.circle.fill")
                    .font(.system(size: 18)).foregroundStyle(Color.bbGold.opacity(0.9))
            }
            Text(scenario.headline)
                .font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.bbInk)
                .fixedSize(horizontal: false, vertical: true)
            Text(scenario.body)
                .font(.system(size: 13)).lineSpacing(2).foregroundStyle(Color.bbInkDim)
                .lineLimit(3).fixedSize(horizontal: false, vertical: true)
            if !cast.isEmpty {
                HStack(spacing: -8) {
                    ForEach(cast.prefix(4)) { d in
                        AvatarView(path: d.avatarPath, name: d.name, size: 28)
                            .overlay(Circle().stroke(Color.bbSurface, lineWidth: 2))
                    }
                    Spacer(minLength: 0)
                }
                .padding(.top, 2)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.bbSurface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
    }
}
