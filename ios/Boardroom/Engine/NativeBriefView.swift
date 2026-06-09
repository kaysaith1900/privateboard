import SwiftUI
import WebKit
import UIKit
import BoardroomEngine

/// Native closing-brief viewer. Generates the brief (if none) then renders it via
/// the loopback — `report.html` (spine system + kami-chart inline-SVG) for the
/// research-note mode, or `magazine`/`newspaper`/`ppt.html` for the structured
/// modes (P4-10). The Format menu regenerates the brief in another mode. Falls
/// back to a light markdown line-renderer if the loopback assets are unavailable.
struct NativeBriefView: View {
    let roomId: String
    var supplement: String = ""        // user's custom angle/focus from the adjourn overlay
    var initialMode: String = "research-note"
    var initialStyle: String = ""
    @Environment(\.dismiss) private var dismiss
    @Environment(AppState.self) private var app

    @State private var reportURL: URL?       // loopback <page>.html?b=&r= (preferred)
    @State private var markdown: String?     // fallback line-renderer
    @State private var mode: BriefGenerator.Mode
    @State private var style: String         // chosen spine (report) / variant (magazine·newspaper); "" = auto
    // Generation state lives on the shared `app.briefJob` so minimising the overlay
    // doesn't cancel it. This view starts/observes that job.
    private var job: BriefJob? { let j = app.briefJob; return j?.roomId == roomId ? j : nil }
    private var busy: Bool { reportURL == nil && markdown == nil && (job?.status != .failed) }

    init(roomId: String, supplement: String = "", initialMode: String = "research-note", initialStyle: String = "") {
        self.roomId = roomId
        self.supplement = supplement
        self.initialMode = initialMode
        self.initialStyle = initialStyle
        _mode = State(initialValue: Self.mode(from: initialMode))
        _style = State(initialValue: initialStyle)
    }

    /// The three canonical modes (Slides/ppt is intentionally dropped on mobile).
    private static let formats: [(BriefGenerator.Mode, String)] = [
        (.researchNote, "Report"), (.magazine, "Magazine"), (.newspaper, "Newspaper"),
    ]

    private static func mode(from id: String) -> BriefGenerator.Mode {
        BriefGenerator.Mode(rawValue: id) ?? .researchNote
    }
    /// Per-mode style options · mirrors `RoomView.reportModes`.
    private var styleOptions: [(id: String, label: String)] {
        (RoomView.reportModes.first { $0.id == mode.rawValue } ?? RoomView.reportModes[0]).styles
    }

    var body: some View {
        NavigationStack {
            Group {
                if let error = job?.error, job?.status == .failed {
                    VStack(spacing: 8) {
                        Text("Couldn't generate the brief").font(.headline)
                        Text(error).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    }.padding()
                } else if busy {
                    // Anchor the cosmetic progress to the JOB's real start, not this
                    // view's appearance — so reopening a minimised generation resumes
                    // the animation where it is, instead of snapping back to 0%.
                    BriefGenView(chairName: app.chair?.name, mode: mode, startedAt: job?.startedAt ?? Date())
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let reportURL {
                    BriefWebView(url: reportURL, title: roomTitle).ignoresSafeArea(edges: .bottom)
                } else if let markdown {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(lines(markdown).enumerated()), id: \.offset) { _, line in line }
                        }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    Text("No brief yet.").foregroundStyle(.secondary)
                }
            }
            .background(Color.bbBg.ignoresSafeArea())
            .navigationTitle("Closing brief")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        // Format · regenerates (different body vs markdown).
                        Section(Loc.t("m_adjourn_format")) {
                            ForEach(Self.formats, id: \.0) { m, label in
                                Button { Task { await regenerate(as: m) } } label: {
                                    if m == mode { Label(label, systemImage: "checkmark") } else { Text(label) }
                                }
                            }
                        }
                        // Style · re-renders only (spine / edition), no LLM round-trip.
                        Section(Loc.t("m_rep_style")) {
                            ForEach(styleOptions, id: \.id) { s in
                                Button { setStyle(s.id) } label: {
                                    let label = s.id.isEmpty ? Loc.t("m_rep_auto") : s.label
                                    if s.id == style { Label(label, systemImage: "checkmark") } else { Text(label) }
                                }
                            }
                        }
                    } label: { Image(systemName: "doc.text.image") }
                    .disabled(busy)
                }
                // Minimise · keep generating in the background (the global badge
                // tracks it + reopens here); does NOT cancel the job.
                ToolbarItem(placement: .topBarTrailing) {
                    Button { dismiss() } label: { Image(systemName: "chevron.down") }
                }
                // Done · finished viewing → drop the job + its badge.
                ToolbarItem(placement: .topBarTrailing) {
                    Button(Loc.t("common_done")) { app.clearBriefJob(); dismiss() }.disabled(busy)
                }
            }
            .task { await load() }
            .onChange(of: app.briefJob?.status) { _, _ in Task { await applyJobIfReady() } }
        }
    }

    private var roomTitle: String { app.rooms.first { $0.id == roomId }?.rawQuery ?? Loc.t("m_menu_genreport") }

    private func load() async {
        // Start (or reuse) the SHARED background job, then render if it already
        // finished (e.g. reopened from the global badge after completion).
        app.startBriefJob(roomId: roomId, roomTitle: roomTitle, mode: mode, supplement: supplement, style: style)
        await applyJobIfReady()
    }

    /// Build the report URL / markdown once the shared job reports a ready briefId.
    private func applyJobIfReady() async {
        guard reportURL == nil, markdown == nil,
              let job, job.status == .ready, let bid = job.briefId,
              let host = NativeEngineHost.shared else { return }
        if let url = host.reportURL(briefId: bid, roomId: roomId, style: style) {
            reportURL = url
        } else {
            markdown = await host.client.latestBriefMarkdown(roomId)
        }
    }

    /// Regenerate the brief in a different mode · forces a fresh brief row, then the
    /// matching loopback page renders it. Resets style to Auto. Runs as a (shared)
    /// background job so minimising mid-regenerate doesn't cancel it.
    private func regenerate(as newMode: BriefGenerator.Mode) async {
        guard newMode != mode else { return }
        mode = newMode; style = ""; reportURL = nil; markdown = nil
        app.startBriefJob(roomId: roomId, roomTitle: roomTitle, mode: newMode, supplement: supplement, style: "", force: true)
        await applyJobIfReady()
    }

    /// Change the style WITHOUT regenerating · spine / edition is a render-time
    /// param (report.html `?spine=`, magazine/newspaper `?v=`), so we just rebuild
    /// the URL and the web view reloads.
    private func setStyle(_ newStyle: String) {
        style = newStyle
        guard let host = NativeEngineHost.shared, let bid = job?.briefId else { return }
        reportURL = host.reportURL(briefId: bid, roomId: roomId, style: newStyle)
    }

    // MARK: markdown fallback

    private func lines(_ md: String) -> [AnyView] {
        md.split(separator: "\n", omittingEmptySubsequences: false).map { raw -> AnyView in
            let t = String(raw).trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("## ") {
                return AnyView(Text(t.dropFirst(3)).font(.title3.bold()).padding(.top, 6))
            } else if t.hasPrefix("# ") {
                return AnyView(Text(t.dropFirst(2)).font(.title2.bold()).padding(.top, 6))
            } else if t.hasPrefix("- ") || t.hasPrefix("* ") {
                return AnyView(HStack(alignment: .top, spacing: 6) { Text("•"); Text(inline(String(t.dropFirst(2)))) })
            } else if t.isEmpty {
                return AnyView(Spacer().frame(height: 2))
            } else {
                return AnyView(Text(inline(t)).font(.callout))
            }
        }
    }
    private func inline(_ s: String) -> AttributedString { (try? AttributedString(markdown: s)) ?? AttributedString(s) }
}

/// WKWebView at the loopback report URL · report.html fetches /api/briefs/:id +
/// /api/rooms/:id same-origin and renders by spine. The report's "Download PDF"
/// button calls `window.print()`, which WKWebView ignores — so we override
/// `window.print` to post a native message, render a paginated A4 PDF from the page
/// and hand it to a share sheet (save to Files / AirDrop / etc.).
private struct BriefWebView: UIViewRepresentable {
    let url: URL
    let title: String

    func makeCoordinator() -> Coordinator { Coordinator(title: title) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(context.coordinator, name: "download")
        // Route the report's window.print() (both Download-PDF buttons call it) to native.
        let js = "window.print = function(){ try { window.webkit.messageHandlers.download.postMessage('pdf'); } catch(e){} };"
        cfg.userContentController.addUserScript(
            WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        let w = WKWebView(frame: .zero, configuration: cfg)
        w.isOpaque = false
        w.backgroundColor = .black
        w.scrollView.backgroundColor = .black
        context.coordinator.webView = w
        w.load(URLRequest(url: url))
        return w
    }
    func updateUIView(_ w: WKWebView, context: Context) {
        // Reload when the brief URL changes (e.g. the Format menu regenerated in a
        // different mode → a new briefId / page).
        if w.url?.absoluteString != url.absoluteString { w.load(URLRequest(url: url)) }
    }
    static func dismantleUIView(_ w: WKWebView, coordinator: Coordinator) {
        w.configuration.userContentController.removeScriptMessageHandler(forName: "download")
    }

    @MainActor final class Coordinator: NSObject, WKScriptMessageHandler {
        weak var webView: WKWebView?
        let title: String
        init(title: String) { self.title = title }

        nonisolated func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
            MainActor.assumeIsolated { exportPDF() }
        }

        /// Render the web view's content to a paginated A4 PDF and present a share sheet.
        private func exportPDF() {
            guard let web = webView else { return }
            let render = UIPrintPageRenderer()
            render.addPrintFormatter(web.viewPrintFormatter(), startingAtPageAt: 0)
            let a4 = CGRect(x: 0, y: 0, width: 595.2, height: 841.8)        // A4 @ 72dpi
            render.setValue(a4, forKey: "paperRect")
            render.setValue(a4.insetBy(dx: 28, dy: 36), forKey: "printableRect")

            let data = NSMutableData()
            UIGraphicsBeginPDFContextToData(data, a4, nil)
            let pages = max(1, render.numberOfPages)
            render.prepare(forDrawingPages: NSRange(location: 0, length: pages))
            for i in 0..<pages {
                UIGraphicsBeginPDFPage()
                render.drawPage(at: i, in: a4)
            }
            UIGraphicsEndPDFContext()

            let safe = title.trimmingCharacters(in: .whitespacesAndNewlines)
            let name = (safe.isEmpty ? "Report" : safe).replacingOccurrences(of: "/", with: "-")
            let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("\(name).pdf")
            do { try data.write(to: fileURL) } catch { return }

            let av = UIActivityViewController(activityItems: [fileURL], applicationActivities: nil)
            guard let top = Self.topViewController() else { return }
            if let pop = av.popoverPresentationController {            // iPad anchor
                pop.sourceView = web
                pop.sourceRect = CGRect(x: web.bounds.midX, y: web.bounds.midY, width: 1, height: 1)
                pop.permittedArrowDirections = []
            }
            top.present(av, animated: true)
        }

        private static func topViewController() -> UIViewController? {
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            var vc = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController
                ?? scene?.windows.first?.rootViewController
            while let presented = vc?.presentedViewController { vc = presented }
            return vc
        }
    }
}

/// Report-generation animation · the native twin of the desktop brief-build
/// screen (`renderBriefStages`). Native brief generation is one opaque async
/// call (no streamed per-stage progress), so this is a COSMETIC time-driven
/// sequence: it walks the same stages with the same labels + rotating substage
/// hints as desktop, holds on "writing" until the real call returns and the
/// parent swaps in the report. Gold accent to match the app (vs desktop lime).
private struct BriefGenView: View {
    let chairName: String?
    let mode: BriefGenerator.Mode
    var startedAt: Date = Date()        // the job's real start · survives view re-creation on reopen
    private var start: Date { startedAt }

    private struct Stage {
        let labelKey: String
        let pip: String
        let subKeys: [String]
        let lo: Int
        let hi: Int
        var mid: Double { Double(lo + hi) / 2 }
    }

    /// research-note runs the full 7-stage pipeline; structured spines (magazine /
    /// newspaper / slides) are extract → compose, matching desktop.
    private var stages: [Stage] {
        let extract = Stage(labelKey: "m_bg_extract_label", pip: "read",
                            subKeys: ["m_bg_sub_extract_0", "m_bg_sub_extract_1", "m_bg_sub_extract_2"], lo: 5, hi: 15)
        switch mode {
        case .researchNote:
            return [
                extract,
                Stage(labelKey: "m_bg_compose_label", pip: "pick",
                      subKeys: ["m_bg_sub_compose_0", "m_bg_sub_compose_1", "m_bg_sub_compose_2"], lo: 1, hi: 4),
                Stage(labelKey: "m_bg_anchor_label", pip: "anchor",
                      subKeys: ["m_bg_sub_anchor_0", "m_bg_sub_anchor_1", "m_bg_sub_anchor_2"], lo: 3, hi: 8),
                Stage(labelKey: "m_bg_findings_label", pip: "find",
                      subKeys: ["m_bg_sub_findings_0", "m_bg_sub_findings_1", "m_bg_sub_findings_2"], lo: 4, hi: 12),
                Stage(labelKey: "m_bg_cluster_label", pip: "split",
                      subKeys: ["m_bg_sub_cluster_0", "m_bg_sub_cluster_1", "m_bg_sub_cluster_2"], lo: 3, hi: 8),
                Stage(labelKey: "m_bg_actions_label", pip: "act",
                      subKeys: ["m_bg_sub_actions_0", "m_bg_sub_actions_1", "m_bg_sub_actions_2"], lo: 4, hi: 12),
                Stage(labelKey: "m_bg_write_label", pip: "write",
                      subKeys: (0...7).map { "m_bg_sub_write_\($0)" }, lo: 30, hi: 90),
            ]
        default:
            let writeKey: String = mode == .magazine ? "m_bg_write_magazine"
                : mode == .newspaper ? "m_bg_write_newspaper" : "m_bg_write_ppt"
            return [
                extract,
                Stage(labelKey: writeKey, pip: "compose",
                      subKeys: (0...7).map { "m_bg_sub_write_\($0)" }, lo: 30, hi: 90),
            ]
        }
    }

    var body: some View {
        let stages = self.stages
        // Cumulative end-time per stage (eta midpoints), for cosmetic scheduling.
        var cum: [Double] = []; var acc = 0.0
        for s in stages { acc += s.mid; cum.append(acc) }

        return TimelineView(.animation) { ctx in
            let el = max(0, ctx.date.timeIntervalSince(start))
            // Active stage · first whose cumulative end hasn't passed; hold on the
            // last (write) once elapsed exceeds the estimate (real call still running).
            let active = cum.firstIndex(where: { el < $0 }) ?? (stages.count - 1)
            let st = stages[active]
            let stageStart = active == 0 ? 0 : cum[active - 1]
            let inStage = max(0, el - stageStart)
            let pct = min(0.97, 1 - exp(-el / 22))                  // eased overall fill, never 100%
            let sub = st.subKeys.isEmpty ? "" : Loc.t(st.subKeys[Int(inStage / 3) % st.subKeys.count])
            let dot = 0.3 + 0.7 * (0.5 + 0.5 * sin(el * 2 * .pi))   // 1s pulse
            let spin = (el / 1.1).truncatingRemainder(dividingBy: 1) * 360   // 1.1s revolution
            let chair = chairName?.isEmpty == false ? chairName! : Loc.t("m_bg_chair_fallback")

            VStack(spacing: 0) {
                Spacer(minLength: 8)

                // ── Hero · a progress ring with the chair's seal forming inside.
                // Big, centred, touch-irrelevant focal point (mobile-first); the
                // gold arc fills with progress, a thin chasing arc keeps it alive,
                // the centre glyph breathes and the live % counts up. ──
                ZStack {
                    Circle().stroke(Color.white.opacity(0.07), lineWidth: 7)
                    Circle().trim(from: 0, to: pct)
                        .stroke(Color.bbGold, style: StrokeStyle(lineWidth: 7, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .animation(.easeOut(duration: 0.6), value: pct)
                    Circle().trim(from: 0, to: 0.12)
                        .stroke(Color.bbGold.opacity(0.85), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        .rotationEffect(.degrees(spin))
                    VStack(spacing: 3) {
                        Image(systemName: "doc.text")
                            .font(.system(size: 26, weight: .light)).foregroundStyle(Color.bbGold)
                            .opacity(0.6 + 0.4 * dot)
                        Text("\(Int(pct * 100))%")
                            .font(.system(size: 30, weight: .bold, design: .monospaced)).foregroundStyle(Color.bbInk)
                            .contentTransition(.numericText())
                    }
                }
                .frame(width: 168, height: 168)
                .padding(.bottom, 22)

                // Kicker · "// {chair} is preparing the minutes" + typing dots.
                HStack(spacing: 6) {
                    Text("// " + Loc.t("m_bg_kicker", ["chair": chair]))
                        .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(1.1)
                        .foregroundStyle(Color.bbGold).lineLimit(1).minimumScaleFactor(0.7)
                    HStack(spacing: 3) {
                        ForEach(0..<3) { i in
                            Circle().fill(Color.bbGold).frame(width: 3, height: 3)
                                .opacity(Double(max(0.25, min(1, dot - Double(i) * 0.18))))
                        }
                    }
                }
                .padding(.bottom, 14)

                // Step counter · gamified "quest step N / total".
                Text("\(Loc.t("m_bg_step")) \(active + 1) / \(stages.count)")
                    .font(.system(size: 11, weight: .bold, design: .monospaced)).kerning(1.4)
                    .foregroundStyle(Color.bbInkFaint)
                    .padding(.bottom, 6)
                // Big current-stage label.
                Text(Loc.t(st.labelKey))
                    .font(.system(size: 20, weight: .semibold)).foregroundStyle(Color.bbInk)
                    .multilineTextAlignment(.center)
                    .animation(.easeInOut(duration: 0.2), value: active)
                    .padding(.bottom, 8)
                // Rotating substage hint.
                Text(sub).font(.system(size: 15, design: .serif)).italic()
                    .foregroundStyle(Color.bbInkDim).multilineTextAlignment(.center)
                    .lineLimit(2).frame(minHeight: 40, alignment: .top)
                    .animation(.easeInOut(duration: 0.25), value: sub)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 22)

                // Segmented stepper · one bar per stage, fills as stages clear
                // (touch-scale, replaces the cramped desktop pip rail).
                HStack(spacing: 6) {
                    ForEach(Array(stages.enumerated()), id: \.offset) { i, _ in
                        Capsule()
                            .fill(i < active ? Color.bbGold
                                  : i == active ? Color.bbGold.opacity(0.4 + 0.4 * dot)
                                  : Color.white.opacity(0.08))
                            .frame(height: 5)
                            .frame(maxWidth: .infinity)
                    }
                }
                .frame(maxWidth: 300)

                Spacer(minLength: 8)
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
