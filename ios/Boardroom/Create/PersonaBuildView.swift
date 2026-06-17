import SwiftUI

// ════════════════════════════════════════════════════════════════════════════
//  Full-persona deep build · the native port of the desktop `personaJob` flow.
//  A 7-phase server pipeline (POST /generate-persona → SSE stream → /save),
//  rendered as a gamified "OPERATIVE DOSSIER" assembly: codename, segmented
//  HP-bar, a 7-step quest checklist with a blinking active marker, a live intel
//  feed of research rounds, and a stats grid that ticks up as sources / rules /
//  voice examples / self-checks accumulate. Mirrors the desktop's operative
//  theme in the app's gold/mono register (no emoji, no shadow animation).
// ════════════════════════════════════════════════════════════════════════════

/// Operative codenames for each phase (1:1 with desktop `PERSONA_PHASE_OP_LABELS`).
private let opLabels = [
    "FORGING IDENTITY",
    "INTERCEPTING KNOWLEDGE",
    "SHARPENING THE LENS",
    "DRAFTING PLAYBOOK",
    "CAPTURING VOICE",
    "SETTING SELF-CHECKS",
    "RUNNING TRIALS",
]
private let opHints = [
    "lineage · concepts · referents",
    "multi-angle parallel research",
    "critique · re-derive with live knowledge",
    "always / never / when-X rules",
    "worked input → output examples",
    "per-turn silent self-check",
    "eval prompts + differentiation",
]
private let phaseEtas: [Double] = [30, 280, 30, 45, 90, 30, 60]   // wall-clock seconds
private let etaTotal: Double = 565

@MainActor
@Observable
final class PersonaBuildModel {
    enum Status { case running, done, failed, aborted }

    let jobId: String
    var status: Status = .running
    var currentPhase = 1                       // 1…7
    var progressPct: Double = 0                // 0…100, server-authoritative
    var phaseDetail = ""                       // live sub-step on the active phase
    var dimensions: [PersonaDimension] = []
    var doneDimensions: Set<String> = []
    var rounds: [PersonaSearchRound] = []      // oldest→newest (de-duped)
    var feed: [FeedEntry] = []                 // newest first, capped
    var stats = Stats()
    var errorMessage: String?
    var final: PersonaFinal?
    let startedAt = Date()

    struct Stats: Equatable { var sources = 0; var searches = 0; var pages = 0; var rules = 0; var voice = 0; var checks = 0 }
    struct FeedEntry: Identifiable, Equatable {
        let id = UUID(); let kind: Kind; let text: String; let meta: String?
        enum Kind { case phase, search, active }
    }

    private let source: any PersonaEventSource
    private var task: Task<Void, Never>?

    init(jobId: String, source: any PersonaEventSource) { self.jobId = jobId; self.source = source }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            guard let self else { return }
            for await ev in source.personaEvents(jobId) {
                if Task.isCancelled { break }
                apply(ev)
                if ev.isTerminal { break }
            }
        }
    }

    func cancel() { task?.cancel(); task = nil }

    /// User-triggered abort · tell the source, stop streaming, flip local state.
    func abort() {
        guard status == .running else { cancel(); return }
        status = .aborted
        let id = jobId
        let src = source
        Task { try? await src.abortPersona(id) }
        cancel()
    }

    // MARK: Fold events into state

    private func apply(_ ev: PersonaEvent) {
        switch ev {
        case let .hello(phase, pct, partial):
            currentPhase = max(currentPhase, phase)
            progressPct = max(progressPct, pct)
            absorb(partial)
        case let .phaseStart(phase, label, _):
            currentPhase = phase
            phaseDetail = ""
            push(.init(kind: .active, text: "phase \(pad(phase)) · \(op(phase))", meta: label.isEmpty ? nil : label))
        case let .phaseProgress(phase, detail, pct, partial):
            currentPhase = max(currentPhase, phase)
            if let pct { progressPct = max(progressPct, pct) }
            if !detail.isEmpty { phaseDetail = detail }
            absorb(partial)
        case let .phaseEnd(phase, pct, partial):
            if let pct { progressPct = max(progressPct, pct) }
            absorb(partial)
            push(.init(kind: .phase, text: "✓ phase \(pad(phase)) · \(op(phase)) complete", meta: nil))
        case let .dimensionPlan(dims):
            dimensions = dims
        case let .searchRound(r):
            guard !rounds.contains(where: { $0.round == r.round && $0.query == r.query }) else { return }
            rounds.append(r)
            stats.searches += 1
            stats.pages += r.pagesRead
            if let d = r.dimension { doneDimensions.insert(d) }
            let tag = r.dimension.map { "[\($0.uppercased())] " } ?? ""
            push(.init(kind: .search, text: "⟶ \(tag)\"\(r.query)\"", meta: "\(r.resultsCount) results · \(r.pagesRead) pages"))
        case let .final(f):
            final = f
            progressPct = 100
            currentPhase = 7
            status = .done
        case let .error(m):
            errorMessage = m
            status = .failed
        case .aborted:
            status = .aborted
        }
    }

    private func absorb(_ p: PersonaPartial?) {
        guard let p else { return }
        stats.sources = max(stats.sources, p.sources)
        stats.rules = max(stats.rules, p.ruleCount)
        stats.voice = max(stats.voice, p.voiceCount)
        stats.checks = max(stats.checks, p.checkCount)
    }

    private func push(_ e: FeedEntry) {
        feed.insert(e, at: 0)
        if feed.count > 16 { feed.removeLast(feed.count - 16) }
    }

    private func op(_ phase: Int) -> String { (1...7).contains(phase) ? opLabels[phase - 1] : "PHASE \(phase)" }
    private func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

    /// Seconds remaining, eased off the server progress (never below ~the active
    /// phase's own ETA so the clock keeps a believable floor while researching).
    var etaRemaining: Double { max(0, etaTotal * (1 - progressPct / 100)) }
}

// ════════════════════════════════════════════════════════════════════════════

struct PersonaBuildView: View {
    @Bindable var model: PersonaBuildModel
    let subject: String
    var onDone: (PersonaFinal) -> Void
    var onAbort: () -> Void
    var onError: (String) -> Void

    var body: some View {
        // One periodic tick drives the elapsed clock + the active-marker blink +
        // the HP-bar leading pulse. 0.45 s cadence → a ~0.9 s blink cycle, cheap
        // vs a 60 fps TimelineView(.animation) over this whole tree. SSE-driven
        // state repaints independently via @Observable.
        TimelineView(.periodic(from: model.startedAt, by: 0.45)) { ctx in
            let el = max(0, ctx.date.timeIntervalSince(model.startedAt))
            let blink = Int(el / 0.45) % 2 == 0
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header(el)
                    hpBar(blink)
                    dossier(blink)
                    intelFeed(blink)
                }
                .frame(maxWidth: .infinity, alignment: .leading)   // pin to viewport · never horizontally scrollable
                .padding(16)
                .padding(.bottom, 28)
            }
            .safeAreaInset(edge: .bottom) { abortFooter }
        }
        .background(Color.bbBg.ignoresSafeArea())
        .onChange(of: model.status) { _, s in handleStatus(s) }
        // Reopened onto a build that already finished while the overlay was closed
        // → `onChange` won't fire (no transition), so settle the terminal state now.
        .onAppear { if model.status != .running { handleStatus(model.status) } }
    }

    private func handleStatus(_ s: PersonaBuildModel.Status) {
        switch s {
        case .done:    if let f = model.final { onDone(f) }
        case .failed:  onError(model.errorMessage ?? "Persona build failed.")
        case .aborted: onAbort()
        case .running: break
        }
    }

    // ── Header · kicker · subject · elapsed/eta/pct ────────────────────────
    private func header(_ el: TimeInterval) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("// operation · deep persona replication")
                .font(.bbKicker()).kerning(1.4).foregroundStyle(Color.bbGold)
            Text(subject)
                .font(.system(size: 15)).foregroundStyle(Color.bbInkDim)
                .lineLimit(2).truncationMode(.tail)
            HStack(alignment: .firstTextBaseline, spacing: 16) {
                stat("ELAPSED", clock(el))
                stat("ETA", clock(model.etaRemaining))
                Spacer()
                Text("\(Int(model.progressPct))%")
                    .font(.system(size: 30, weight: .bold, design: .monospaced))
                    .foregroundStyle(Color.bbGold)
                    .contentTransition(.numericText())
                    .animation(.easeOut(duration: 0.3), value: Int(model.progressPct))
            }
        }
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 9, weight: .bold, design: .monospaced)).kerning(1).foregroundStyle(Color.bbInkFaint)
            Text(value).font(.system(size: 14, weight: .semibold, design: .monospaced)).foregroundStyle(Color.bbInkDim)
        }
    }

    // ── 20-segment HP / progress bar ───────────────────────────────────────
    private func hpBar(_ blink: Bool) -> some View {
        let filled = Int((model.progressPct / 100) * 20)
        return HStack(spacing: 3) {
            ForEach(0..<20, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(segColor(i, filled: filled, blink: blink))
                    .frame(height: 10)
            }
        }
        .animation(.easeOut(duration: 0.3), value: filled)
    }

    private func segColor(_ i: Int, filled: Int, blink: Bool) -> Color {
        if i < filled { return Color.bbGold }
        if i == filled && model.status == .running { return Color.bbGold.opacity(blink ? 0.85 : 0.3) }   // leading pulse
        return Color.white.opacity(0.08)
    }

    // ── Operative dossier card ─────────────────────────────────────────────
    private func dossier(_ blink: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Dossier header · codename + status.
            HStack(spacing: 8) {
                Text("OPERATIVE-\(codename)")
                    .font(.system(size: 12, weight: .bold, design: .monospaced)).kerning(0.5)
                    .foregroundStyle(Color.bbInk)
                Spacer()
                HStack(spacing: 6) {
                    Circle().fill(statusColor).frame(width: 7, height: 7)
                        .opacity(model.status == .running ? (blink ? 1 : 0.35) : 1)
                    Text(statusWord).font(.system(size: 10, weight: .bold, design: .monospaced)).kerning(0.8)
                        .foregroundStyle(statusColor)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .overlay(Rectangle().fill(Color.bbLine).frame(height: 1), alignment: .bottom)

            // 7-phase quest checklist.
            VStack(spacing: 0) {
                ForEach(1...7, id: \.self) { p in
                    phaseRow(p, blink: blink)
                    if p == 2, model.currentPhase == 2, !model.dimensions.isEmpty {
                        dimensionList
                    }
                }
            }
            .padding(.vertical, 4)

            // Stats strip.
            statsStrip
                .overlay(Rectangle().fill(Color.bbLine).frame(height: 1), alignment: .top)
        }
        .background(Color.bbSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
    }

    private func phaseRow(_ p: Int, blink: Bool) -> some View {
        let state = phaseState(p)
        let active = state == .active
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 10) {
                Text(pad(p)).font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(active ? Color.bbGold : Color.bbInkFaint).frame(width: 18, alignment: .leading)
                Text(marker(state))
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(state == .done ? Color.bbGold : (active ? Color.bbGold : Color.bbInkFaint))
                    .opacity(active && !blink ? 0.35 : 1)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 2) {
                    Text(opLabels[p - 1])
                        .font(.system(size: 13, weight: active ? .bold : .semibold, design: .monospaced)).kerning(0.5)
                        .foregroundStyle(active ? Color.bbGold : (state == .done ? Color.bbInkDim : Color.bbInkFaint))
                    Text(opHints[p - 1])
                        .font(.system(size: 11)).foregroundStyle(Color.bbInkFaint)
                        .opacity(state == .pending ? 0.5 : 1)
                    if active, !model.phaseDetail.isEmpty {
                        Text("› \(model.phaseDetail)")
                            .font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.bbGold.opacity(0.85))
                            .lineLimit(2).truncationMode(.tail)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .background(active ? Color.bbGold.opacity(0.07) : .clear)
        .animation(.easeInOut(duration: 0.25), value: model.currentPhase)
    }

    private var dimensionList: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(model.dimensions) { d in
                let done = model.doneDimensions.contains(d.dimension)
                HStack(alignment: .top, spacing: 7) {
                    Text(done ? "✓" : "○").font(.system(size: 10, weight: .bold))
                        .foregroundStyle(done ? Color.bbGold : Color.bbInkFaint).frame(width: 12)
                    Text("[\(d.dimension.uppercased())]")
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundStyle(done ? Color.bbInkDim : Color.bbInkFaint)
                    Text(d.query).font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Color.bbInkFaint).lineLimit(1)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.leading, 44).padding(.trailing, 14).padding(.bottom, 8)
    }

    private var statsStrip: some View {
        let s = model.stats
        return HStack(spacing: 0) {
            statCell("SOURCES", s.sources)
            statCell("SEARCHES", s.searches)
            statCell("PAGES", s.pages)
            statCell("RULES", s.rules)
            statCell("VOICE", s.voice)
            statCell("CHECKS", s.checks)
        }
        .padding(.vertical, 12).padding(.horizontal, 8)
    }

    private func statCell(_ label: String, _ n: Int) -> some View {
        VStack(spacing: 3) {
            Text("\(n)")
                .font(.system(size: 18, weight: .bold, design: .monospaced))
                .foregroundStyle(n > 0 ? Color.bbGold : Color.bbInkFaint)
                .contentTransition(.numericText())
                .animation(.easeOut(duration: 0.3), value: n)
            Text(label).font(.system(size: 8, weight: .bold, design: .monospaced)).kerning(0.5)
                .foregroundStyle(Color.bbInkFaint)
        }
        .frame(maxWidth: .infinity)
    }

    // ── Intel feed ─────────────────────────────────────────────────────────
    private func intelFeed(_ blink: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("// intel feed").font(.bbKicker()).kerning(1.2).foregroundStyle(Color.bbGold)
                Text(blink ? "▶_" : "▶ ").font(.system(size: 11, weight: .bold, design: .monospaced)).foregroundStyle(Color.bbGold.opacity(0.7))
                Spacer()
            }
            if model.feed.isEmpty {
                Text("awaiting first signal…")
                    .font(.system(size: 12, design: .monospaced)).italic().foregroundStyle(Color.bbInkFaint)
                    .padding(.vertical, 6)
            } else {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(model.feed.prefix(12)) { e in feedRow(e) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.black.opacity(0.25), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
    }

    private func feedRow(_ e: PersonaBuildModel.FeedEntry) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(e.text)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(e.kind == .active ? Color.bbGold : (e.kind == .search ? Color.bbInk : Color.bbInkDim))
                .lineLimit(2).truncationMode(.tail)
            if let m = e.meta {
                Text(m).font(.system(size: 10, design: .monospaced)).foregroundStyle(Color.bbInkFaint)
                    .lineLimit(1).truncationMode(.tail)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .transition(.opacity)
    }

    // ── Abort footer ───────────────────────────────────────────────────────
    private var abortFooter: some View {
        VStack(spacing: 6) {
            Button { model.abort() } label: {
                Text("⏻  ABORT OPERATION")
                    .font(.system(size: 13, weight: .bold, design: .monospaced)).kerning(0.8)
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
                    .foregroundStyle(Color.bbInkDim)
            }
            .buttonStyle(.plain)
            .background(Color.bbSurface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.bbLine, lineWidth: 1))
            Text("tokens already absorbed · no director will be saved")
                .font(.system(size: 10, design: .monospaced)).foregroundStyle(Color.bbInkFaint)
        }
        .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 8)
        .background(.ultraThinMaterial)
    }

    // ── Helpers ──────────────────────────────────────────────────────────
    private enum PhaseState { case done, active, pending }
    private func phaseState(_ p: Int) -> PhaseState {
        if p < model.currentPhase { return .done }
        if p == model.currentPhase { return model.status == .done ? .done : .active }
        return .pending
    }
    private func marker(_ s: PhaseState) -> String {
        switch s { case .done: return "✓"; case .active: return "▣"; case .pending: return "▢" }
    }
    private var codename: String { String(model.jobId.replacingOccurrences(of: "-", with: "").prefix(4)).uppercased() }
    private var statusColor: Color {
        switch model.status { case .running: return .bbGold; case .done: return .bbGold; case .failed: return .red; case .aborted: return .bbInkFaint }
    }
    private var statusWord: String {
        switch model.status { case .running: return "ASSEMBLING"; case .done: return "READY"; case .failed: return "FAILED"; case .aborted: return "ABORTED" }
    }
    private func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }
    private func clock(_ t: TimeInterval) -> String {
        let s = Int(t.rounded()); return String(format: "%02d:%02d", s / 60, s % 60)
    }
}
