import SwiftUI

/// Usage · cumulative LLM-call token accounting · a 1:1 native port of the mobile
/// web Usage panel (`voice-room-shell.js` renderUsage/usageChart/usageDetail):
/// a day-picker (All · cumulative / per-day), a 14-day stacked bar chart, and a
/// drill-down with total + meta stats, a provider-coloured model bar, a "By model"
/// list, and a "Top consumers" list. Token counts only — no cost/pricing.
struct UsageView: View {
    @Environment(AppState.self) private var app

    @State private var usage: UsageSummary?
    @State private var loading = true
    @State private var selectedDay: String?      // nil = cumulative

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if loading {
                    ProgressView().tint(.bbGold).frame(maxWidth: .infinity).padding(.top, 60)
                } else if let u = usage, u.totalTokens > 0 || !u.byModel.isEmpty {
                    dayPicker(u)
                    chart(u)
                    detail(u)
                } else {
                    emptyState
                }
            }
            .padding(16)
        }
        .scrollContentBackground(.hidden)
        .background(Color.bbBg.ignoresSafeArea())
        .navigationTitle(Loc.t("m_usage_title"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        usage = (try? await app.api?.getUsage()) ?? nil
        loading = false
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Text("0").font(.system(size: 44, weight: .bold, design: .monospaced)).foregroundStyle(Color.bbInkFaint)
            Text(Loc.t("m_usage_none")).font(.callout).foregroundStyle(Color.bbInkDim)
        }
        .frame(maxWidth: .infinity).padding(.top, 60)
    }

    // MARK: Day picker

    private func dayPicker(_ u: UsageSummary) -> some View {
        HStack(spacing: 8) {
            pill(Loc.t("m_usage_all"), on: selectedDay == nil) { selectedDay = nil }
            if let d = selectedDay {
                pill(Self.dayLong(d), on: true) { selectedDay = nil }
            }
            Spacer(minLength: 0)
        }
    }

    private func pill(_ label: String, on: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Text(label).font(.system(size: 13, weight: .semibold))
                .foregroundStyle(on ? Color.black : Color.bbInkDim)
                .padding(.vertical, 7).padding(.horizontal, 13)
                .background(on ? Color.bbGold : Color.white.opacity(0.05), in: Capsule())
                .overlay(Capsule().stroke(on ? Color.clear : Color.bbLine, lineWidth: 1))
        }.buttonStyle(.plain)
    }

    // MARK: 14-day chart

    private func chart(_ u: UsageSummary) -> some View {
        let days = u.daily
        let maxTok = max(days.map(\.totalTokens).max() ?? 0, 1)
        let last14 = days.reduce(0) { $0 + $1.totalTokens }
        let todayKey = days.last?.day
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(Loc.t("m_usage_last14")).font(.system(size: 12, weight: .medium, design: .monospaced)).foregroundStyle(Color.bbInkDim)
                Spacer()
                Text(Self.fmtTokens(last14)).font(.system(size: 13, weight: .bold, design: .monospaced)).foregroundStyle(Color.bbInk)
            }
            HStack(alignment: .bottom, spacing: 4) {
                ForEach(days) { d in
                    bar(d, maxTok: maxTok, isToday: d.day == todayKey)
                }
            }
            .frame(height: 104)
        }
        .padding(14)
        .background(Color.bbCard, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
    }

    private func bar(_ d: UsageDayRow, maxTok: Int, isToday: Bool) -> some View {
        let total = d.totalTokens
        let chartH: CGFloat = 84
        let hPct: CGFloat = total > 0 ? max(CGFloat(total) / CGFloat(maxTok), 0.025) : 0
        // Collapse models into one segment per provider (preserve byModel order).
        var segOrder: [String] = []
        var segTok: [String: Int] = [:]
        for m in d.byModel {
            if segTok[m.provider] == nil { segOrder.append(m.provider) }
            segTok[m.provider, default: 0] += m.tokens
        }
        let on = selectedDay == d.day
        return Button { selectedDay = (selectedDay == d.day) ? nil : d.day } label: {
            VStack(spacing: 5) {
                Spacer(minLength: 0)
                ZStack(alignment: .bottom) {
                    if total > 0 {
                        VStack(spacing: 0) {
                            ForEach(segOrder, id: \.self) { p in
                                Rectangle().fill(Self.color(p))
                                    .frame(height: chartH * hPct * (CGFloat(segTok[p] ?? 0) / CGFloat(max(total, 1))))
                            }
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
                        .overlay(isToday ? RoundedRectangle(cornerRadius: 3).stroke(Color.bbGold, lineWidth: 1.2) : nil)
                    } else {
                        Rectangle().fill(Color.white.opacity(0.08)).frame(height: 2)
                    }
                }
                .frame(height: chartH, alignment: .bottom)
                Text(Self.dayShort(d.day))
                    .font(.system(size: 8, weight: .medium, design: .monospaced))
                    .foregroundStyle(on ? Color.bbGold : Color.bbInkFaint)
                    .lineLimit(1).minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity)
            .opacity(selectedDay == nil || on ? 1 : 0.45)
        }.buttonStyle(.plain)
    }

    // MARK: Detail drill-down

    @ViewBuilder private func detail(_ u: UsageSummary) -> some View {
        if let day = selectedDay {
            if let d = u.daily.first(where: { $0.day == day }), d.totalTokens > 0 {
                detailBody(total: d.totalTokens, byModel: d.byModel, byAgent: d.byAgent,
                           agentCount: d.byAgent.count, retiredTokens: 0, retiredAgents: 0, scope: Self.dayLong(day))
            } else {
                Text("\(Self.dayLong(day)) · \(Loc.t("m_usage_day_none"))")
                    .font(.system(size: 14)).foregroundStyle(Color.bbInkDim).padding(.vertical, 20)
            }
        } else {
            detailBody(total: u.totalTokens, byModel: u.byModel, byAgent: u.byAgent,
                       agentCount: u.agentCount, retiredTokens: u.retired.tokens, retiredAgents: u.retired.agents,
                       scope: Loc.t("m_usage_cum"))
        }
    }

    private func detailBody(total: Int, byModel: [UsageModelRow], byAgent: [UsageAgentRow],
                            agentCount: Int, retiredTokens: Int, retiredAgents: Int, scope: String) -> some View {
        let denom = max(total, 1)
        let top = byAgent.filter { $0.tokens > 0 }.prefix(6)
        let activeCount = byAgent.filter { $0.tokens > 0 }.count
        let silent = byAgent.count - top.count
        return VStack(alignment: .leading, spacing: 18) {
            // Head · total + meta
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(scope.uppercased()).font(.system(size: 10, weight: .semibold, design: .monospaced)).kerning(0.6)
                        .foregroundStyle(Color.bbInkDim)
                    Text(Self.fmtTokens(total)).font(.system(size: 38, weight: .bold, design: .monospaced)).foregroundStyle(Color.bbInk)
                    Text("\(total.formatted()) \(Loc.t("m_usage_unit"))")
                        .font(.system(size: 12, design: .monospaced)).foregroundStyle(Color.bbInkFaint)
                }
                Spacer(minLength: 0)
                VStack(spacing: 6) {
                    metaRow(Loc.t("m_usage_meta_models"), byModel.count)
                    metaRow(Loc.t("m_usage_meta_agents"), agentCount)
                    metaRow(Loc.t("m_usage_meta_active"), activeCount)
                }
                .frame(width: 120)
            }
            // Combined provider bar
            GeometryReader { geo in
                HStack(spacing: 0) {
                    ForEach(byModel, id: \.modelV) { m in
                        Self.color(m.provider).frame(width: geo.size.width * CGFloat(m.tokens) / CGFloat(denom))
                    }
                }
            }
            .frame(height: 8).clipShape(Capsule())
            // By model
            VStack(alignment: .leading, spacing: 10) {
                sectionHeader(Loc.t("m_usage_by_model"))
                ForEach(byModel, id: \.modelV) { m in modelRow(m, denom: denom) }
            }
            // Top consumers
            if !top.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    sectionHeader(Loc.t("m_usage_top"))
                    ForEach(Array(top), id: \.self) { a in agentRow(a, denom: denom) }
                    if silent > 0 {
                        Text(Loc.t("m_usage_silent", ["n": String(silent)]))
                            .font(.system(size: 12)).foregroundStyle(Color.bbInkFaint)
                    }
                }
            }
            if retiredTokens > 0 {
                Text(Loc.t("m_usage_retired", ["agents": String(retiredAgents), "tokens": Self.fmtTokens(retiredTokens)]))
                    .font(.system(size: 12)).italic().foregroundStyle(Color.bbInkDim)
            }
        }
    }

    private func metaRow(_ label: String, _ value: Int) -> some View {
        HStack {
            Text(label).font(.system(size: 12)).foregroundStyle(Color.bbInkDim)
            Spacer()
            Text(String(value)).font(.system(size: 14, weight: .bold, design: .monospaced)).foregroundStyle(Color.bbInk)
        }
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text.uppercased()).font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(0.8)
            .foregroundStyle(Color.bbInkDim)
    }

    private func modelRow(_ m: UsageModelRow, denom: Int) -> some View {
        let pct = Double(m.tokens) / Double(denom) * 100
        return HStack(spacing: 10) {
            Circle().fill(Self.color(m.provider)).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(m.displayName).font(.system(size: 14, weight: .medium)).foregroundStyle(Color.bbInk).lineLimit(1)
                Text(m.provider).font(.system(size: 10, design: .monospaced)).foregroundStyle(Color.bbInkFaint)
            }
            Spacer(minLength: 6)
            Text(Self.fmtTokens(m.tokens)).font(.system(size: 13, weight: .semibold, design: .monospaced)).foregroundStyle(Color.bbInk)
            Text(String(format: pct < 10 ? "%.1f%%" : "%.0f%%", pct))
                .font(.system(size: 12, design: .monospaced)).foregroundStyle(Color.bbInkDim)
                .frame(width: 44, alignment: .trailing)
        }
    }

    private func agentRow(_ a: UsageAgentRow, denom: Int) -> some View {
        let pct = max(Double(a.tokens) / Double(denom) * 100, 1)
        let role = a.roleKind == "moderator" ? Loc.t("m_usage_chair") : Loc.t("m_usage_director")
        return HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(a.name).font(.system(size: 14, weight: .medium)).foregroundStyle(Color.bbInk).lineLimit(1)
                Text(role).font(.system(size: 10, design: .monospaced)).foregroundStyle(Color.bbInkFaint)
            }
            .frame(width: 120, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.07))
                    Capsule().fill(Self.color(a.provider)).frame(width: max(3, geo.size.width * CGFloat(pct) / 100))
                }
            }
            .frame(height: 6)
            Text(Self.fmtTokens(a.tokens)).font(.system(size: 13, weight: .semibold, design: .monospaced))
                .foregroundStyle(Color.bbInk).frame(width: 52, alignment: .trailing)
        }
    }

    // MARK: Helpers (1:1 with the mobile web)

    /// `n≥1M → X.XM · n≥1k → XK · else n` (mobile `fmtTokens`).
    static func fmtTokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return "\(Int((Double(n) / 1_000).rounded()))K" }
        return String(n)
    }

    /// Provider → colour · 1:1 with the mobile `PROVIDER_COLOR` map.
    static func color(_ provider: String) -> Color {
        switch provider {
        case "anthropic": return Color(hex: 0xC9A46B)
        case "openai", "google": return Color(hex: 0x6A9B97)
        case "openrouter", "deepseek": return Color(hex: 0x8E7CC3)
        case "bai": return Color(hex: 0xC0795B)
        default: return Color(hex: 0x5C5A52)
        }
    }

    static func dayShort(_ s: String) -> String {
        let p = s.split(separator: "-")
        guard p.count == 3, let m = Int(p[1]), let d = Int(p[2]) else { return s }
        return "\(m)·\(d)"
    }

    static func dayLong(_ s: String) -> String {
        let inFmt = DateFormatter(); inFmt.locale = Locale(identifier: "en_US_POSIX"); inFmt.dateFormat = "yyyy-MM-dd"
        guard let date = inFmt.date(from: s) else { return s }
        let out = DateFormatter(); out.locale = Locale(identifier: Loc.locale)
        out.setLocalizedDateFormatFromTemplate("MMMd")
        return out.string(from: date)
    }
}

private extension Color {
    init(hex: UInt) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}
