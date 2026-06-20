import SwiftUI

/// 支持模型列表 · the supported-model catalog for the active LLM key, grouped by
/// brand. "更新" pulls the carrier's latest models (aggregators only — bai /
/// openrouter), brand-filters to PrivateBoard's known brands, and adds any new
/// ones as DYNAMIC (usable) models. Mirrors `UsageView`'s surface + chrome.
struct SupportedModelsView: View {
    @Environment(AppState.self) private var app

    @State private var models: [ModelInfo] = []
    @State private var staleAgents: [StaleAgent] = []   // directors on a now-unreachable model
    @State private var loading = true
    @State private var refreshing = false
    @State private var resetting = false
    @State private var resetDone: Int?                  // directors reset, after 一键重置
    @State private var result: RefreshOutcome?          // inline banner after 更新

    private enum RefreshOutcome: Equatable {
        case added(Int)         // 发现 N 个新模型
        case upToDate           // 已经是最新
        case unsupported        // 需要聚合器密钥
        case failed             // 拉取失败
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if loading {
                    ProgressView().tint(.bbGold).frame(maxWidth: .infinity).padding(.top, 60)
                } else {
                    updateBar
                    if !staleAgents.isEmpty { staleCard }
                    if let n = resetDone, staleAgents.isEmpty {
                        Text(Loc.t("m_models_reset_done", ["n": String(n)]))
                            .font(.system(size: 13)).foregroundStyle(Color.bbGold)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if let result { banner(result) }
                    if visibleModels.isEmpty {
                        emptyState
                    } else {
                        ForEach(brands, id: \.self) { brand in brandSection(brand) }
                        if hiddenCount > 0 { hiddenHint }
                    }
                }
            }
            .padding(16)
        }
        .scrollContentBackground(.hidden)
        .background(Color.bbBg.ignoresSafeArea())
        .navigationTitle(Loc.t("m_models_title"))
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    // MARK: Update

    private var updateBar: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Loc.t("m_models_subtitle")).font(.system(size: 14)).foregroundStyle(Color.bbInkDim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button(action: { Task { await refresh() } }) {
                HStack(spacing: 7) {
                    if refreshing { ProgressView().tint(.black).controlSize(.small) }
                    else { Image(systemName: "arrow.clockwise") }
                    Text(Loc.t("m_models_update")).fontWeight(.semibold)
                }
                .font(.system(size: 14))
                .padding(.vertical, 8).padding(.horizontal, 14).foregroundStyle(.black)
            }
            .buttonStyle(.glassProminent).tint(.bbGold)
            .disabled(refreshing)
        }
    }

    /// Shown when 更新 (or a key switch) leaves directors on an unreachable model.
    /// "一键重置" reassigns them all to a random fast model.
    private var staleCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Color.bbAmber)
                Text(Loc.t("m_models_stale_title")).font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.bbInk)
            }
            Text(Loc.t("m_models_stale_msg", ["n": String(staleAgents.count)]))
                .font(.system(size: 13)).foregroundStyle(Color.bbInkDim)
                .fixedSize(horizontal: false, vertical: true)
            // The affected directors + the model that's gone.
            VStack(alignment: .leading, spacing: 4) {
                ForEach(staleAgents.prefix(6)) { a in
                    HStack(spacing: 6) {
                        Text(a.name ?? a.id).font(.system(size: 12, weight: .medium)).foregroundStyle(Color.bbInk).lineLimit(1)
                        Text("· \(a.label)").font(.system(size: 12, design: .monospaced)).foregroundStyle(Color.bbInkFaint).lineLimit(1)
                    }
                }
                if staleAgents.count > 6 {
                    Text("+\(staleAgents.count - 6)").font(.system(size: 12, design: .monospaced)).foregroundStyle(Color.bbInkFaint)
                }
            }
            Button(action: { Task { await resetStale() } }) {
                HStack(spacing: 7) {
                    if resetting { ProgressView().tint(.black).controlSize(.small) }
                    else { Image(systemName: "wand.and.stars") }
                    Text(Loc.t("m_models_reset")).fontWeight(.semibold)
                }
                .font(.system(size: 14))
                .frame(maxWidth: .infinity).padding(.vertical, 9).foregroundStyle(.black)
            }
            .buttonStyle(.glassProminent).tint(.bbGold).disabled(resetting)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.bbCard, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Color.bbAmber.opacity(0.5), lineWidth: 1))
    }

    @ViewBuilder private func banner(_ r: RefreshOutcome) -> some View {
        let (text, warn): (String, Bool) = {
            switch r {
            case .added(let n): return (Loc.t("m_models_found", ["n": String(n)]), false)
            case .upToDate:     return (Loc.t("m_models_uptodate"), false)
            case .unsupported:  return (Loc.t("m_models_needs_aggregator"), true)
            case .failed:       return (Loc.t("m_models_failed"), true)
            }
        }()
        HStack(spacing: 8) {
            Image(systemName: warn ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                .foregroundStyle(warn ? Color.bbAmber : Color.bbGold)
            Text(text).font(.system(size: 14)).foregroundStyle(Color.bbInk)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.bbCard, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
    }

    // MARK: Brand sections

    /// Only the models the CURRENT key (active carrier) can actually reach — the
    /// unreachable ones are dropped from the list (a hint notes how many).
    private var visibleModels: [ModelInfo] { models.filter { $0.reachable ?? true } }
    private var hiddenCount: Int { models.count - visibleModels.count }

    /// Brands present among reachable models, in registry-provider order then
    /// alphabetical for the rest.
    private var brands: [String] {
        let order = ["anthropic", "openai", "google", "deepseek", "zhipu", "moonshot", "minimax"]
        let present = Set(visibleModels.map { $0.provider ?? "unknown" })
        let ordered = order.filter { present.contains($0) }
        let extra = present.subtracting(ordered).sorted()
        return ordered + extra
    }

    private func brandSection(_ brand: String) -> some View {
        let rows = visibleModels.filter { ($0.provider ?? "unknown") == brand }
            .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(UsageView.color(brand)).frame(width: 8, height: 8)
                Text(Self.brandName(brand).uppercased())
                    .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(0.8)
                    .foregroundStyle(Color.bbInkDim)
                Spacer()
                Text(String(rows.count)).font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.bbInkFaint)
            }
            LazyVStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { idx, m in
                    if idx > 0 { Divider().overlay(Color.bbLine) }
                    modelRow(m)
                }
            }
            .padding(.horizontal, 12)
            .background(Color.bbCard, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
        }
    }

    private func modelRow(_ m: ModelInfo) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(m.label).font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Color.bbInk).lineLimit(1)
                if let deck = m.deck, !deck.isEmpty, deck != "dynamic" {
                    Text(deck).font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.bbInkFaint).lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            if m.dynamic == true {
                Text(Loc.t("m_models_dynamic_badge"))
                    .font(.system(size: 10, weight: .bold, design: .monospaced)).kerning(0.5)
                    .padding(.vertical, 3).padding(.horizontal, 7)
                    .foregroundStyle(Color.bbGold)
                    .background(Color.bbGold.opacity(0.12), in: Capsule())
            }
        }
        .padding(.vertical, 11)
    }

    /// Note that unreachable models (other providers / not on this key) were hidden.
    private var hiddenHint: some View {
        Text(Loc.t("m_models_hidden", ["n": String(hiddenCount)]))
            .font(.system(size: 12)).foregroundStyle(Color.bbInkFaint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 2)
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "square.stack.3d.up.slash").font(.system(size: 34)).foregroundStyle(Color.bbInkFaint)
            Text(Loc.t("m_models_none")).font(.callout).foregroundStyle(Color.bbInkDim)
        }
        .frame(maxWidth: .infinity).padding(.top, 60)
    }

    // MARK: Data

    private func load() async {
        if let catalog = try? await app.api?.modelCatalog() {
            models = catalog.models
            staleAgents = catalog.staleAgents ?? []
        }
        app.modelsNeedAttention = !staleAgents.isEmpty   // keep the Settings badge in sync
        loading = false
    }

    private func refresh() async {
        guard let api = app.api else { return }
        refreshing = true; result = nil; resetDone = nil
        defer { refreshing = false }
        do {
            let r = try await api.refreshModels()
            if r.unsupported == true { result = .unsupported }
            else if r.error != nil { result = .failed }
            else if r.added.isEmpty { result = .upToDate }
            else { result = .added(r.added.count) }
            // Reload the merged catalog so newly-added models — and any directors
            // left on a now-unreachable model — surface immediately.
            await load()
        } catch {
            result = .failed
        }
    }

    private func resetStale() async {
        guard let api = app.api else { return }
        resetting = true
        defer { resetting = false }
        let n = (try? await api.resetStaleModels())?.reset ?? 0
        resetDone = n
        await load()        // clears the stale list once reassigned
    }

    static func brandName(_ provider: String) -> String {
        switch provider {
        case "anthropic": return "Anthropic"
        case "openai":    return "OpenAI"
        case "google":    return "Google"
        case "deepseek":  return "DeepSeek"
        case "zhipu":     return "Zhipu"
        case "moonshot":  return "Moonshot"
        case "minimax":   return "MiniMax"
        default:          return provider
        }
    }
}
