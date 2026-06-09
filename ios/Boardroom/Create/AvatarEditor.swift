import SwiftUI
import WebKit

// ════════════════════════════════════════════════════════════════════════════
//  AvatarEditorController · drives the live 3D-avatar customiser embed
//  (`/mobile/avatar-editor-embed.html`) shown in a visible WKWebView. Native
//  holds the `Avatar3DConfig`; every edit pushes `setConfig` (rebuild/recolor
//  live); `catalog` populates the pickers; `capture` returns the head-on PNG.
// ════════════════════════════════════════════════════════════════════════════
@MainActor
@Observable
final class AvatarEditorController {
    var catalog: AvatarCatalog?
    var config: Avatar3DConfig?
    private(set) var ready = false
    private(set) var loadFailed = false   // cold load never posted `ready` after retries → show a Retry

    @ObservationIgnored fileprivate weak var webView: WKWebView?
    @ObservationIgnored private var loadURL: URL?
    @ObservationIgnored private var watchdog: DispatchWorkItem?
    @ObservationIgnored private var reloadAttempts = 0
    private static let maxReloads = 3
    private static let watchdogSeconds: TimeInterval = 5
    @ObservationIgnored private var queue: [() -> Void] = []
    @ObservationIgnored private var captureCont: CheckedContinuation<String?, Never>?
    /// Starting point · derive from this seed, or load `existingJSON` if set.
    @ObservationIgnored var seed = "editor"
    @ObservationIgnored var existingJSON: String?

    nonisolated init() {}

    fileprivate func attach(_ wv: WKWebView, url: URL) {
        webView = wv; loadURL = url
        armWatchdog()
    }

    fileprivate func markReady() {
        guard !ready else { return }
        watchdog?.cancel(); watchdog = nil       // bridge is up → the cold-load watchdog can stand down
        ready = true; loadFailed = false
        run("window.AvatarBridge && AvatarBridge.catalog()")
        run("window.AvatarBridge && AvatarBridge.initConfig('\(seed)', \(Self.jsArg(existingJSON)))")
        queue.forEach { $0() }; queue.removeAll()
    }

    /// First-run cold-load recovery · if the embed never posts `ready` within the
    /// watchdog window (loopback just bound / three.js + GLB uncached / WebGL init
    /// stalled, sometimes contending with the hidden snapshot WebView), reload it.
    /// Bounded; surfaces a Retry button after `maxReloads`. Mirrors the stage-embed
    /// watchdog so a fresh install never lands on an infinite spinner.
    private func armWatchdog() {
        watchdog?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.reloadIfNotReady(reason: "watchdog") }
        watchdog = item
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.watchdogSeconds, execute: item)
    }

    fileprivate func reloadIfNotReady(reason: String) {
        guard !ready else { return }
        watchdog?.cancel(); watchdog = nil
        guard reloadAttempts < Self.maxReloads, let wv = webView, let url = loadURL else {
            loadFailed = true; return
        }
        reloadAttempts += 1
        NSLog("🧩AVATAR editor not ready (\(reason)) · reload \(reloadAttempts)/\(Self.maxReloads)")
        wv.load(URLRequest(url: url))
        armWatchdog()
    }

    /// A provisional / committed navigation failed (e.g. the loopback wasn't serving
    /// yet on first run) · retry quickly rather than wait out the full watchdog.
    fileprivate func handleNavFailure() {
        guard !ready else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.reloadIfNotReady(reason: "nav-failure")
        }
    }

    /// Manual Retry from the load-failed fallback · reset the budget and reload.
    func retry() {
        reloadAttempts = 0; loadFailed = false
        guard let wv = webView, let url = loadURL else { return }
        wv.load(URLRequest(url: url)); armWatchdog()
    }

    fileprivate func onCatalog(_ c: AvatarCatalog) { catalog = c }
    fileprivate func onConfig(_ c: Avatar3DConfig) { config = c }
    fileprivate func onCaptured(_ url: String?) {
        guard let cont = captureCont else { return }
        captureCont = nil
        cont.resume(returning: url)
    }

    private func run(_ js: String) {
        if ready { webView?.evaluateJavaScript(js) } else { queue.append { [weak self] in self?.webView?.evaluateJavaScript(js) } }
    }

    /// Push an edited config to the live preview (and keep it as the truth).
    func apply(_ cfg: Avatar3DConfig) {
        config = cfg
        run("window.AvatarBridge && AvatarBridge.setConfig(\(Self.jsArg(cfg.jsonString())))")
    }

    /// Re-roll a brand-new random avatar · the embed derives + echoes the config.
    func reroll() {
        let s = AvatarRenderer.randomSeed()
        seed = s
        run("window.AvatarBridge && AvatarBridge.initConfig('\(s)', null)")
    }

    /// Capture the head-on PNG data-URL (nil on failure / timeout).
    func capture(size: Int = 512) async -> String? {
        await withCheckedContinuation { (cont: CheckedContinuation<String?, Never>) in
            captureCont = cont
            run("window.AvatarBridge && AvatarBridge.capture(\(size))")
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in self?.onCaptured(nil) }
        }
    }

    /// JSON-encode a string into a valid JS string literal (or `null`).
    private static func jsArg(_ s: String?) -> String {
        guard let s, let d = try? JSONEncoder().encode(s), let lit = String(data: d, encoding: .utf8) else { return "null" }
        return lit
    }
}

/// The visible WKWebView hosting the live customiser preview.
struct AvatarEditorWebView: UIViewRepresentable {
    let url: URL
    let controller: AvatarEditorController

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.userContentController.add(context.coordinator, name: "avatar")
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.isOpaque = false
        wv.backgroundColor = .clear
        wv.scrollView.isScrollEnabled = false
        wv.scrollView.bounces = false
        wv.navigationDelegate = context.coordinator   // retry on cold-load nav failure
        controller.attach(wv, url: url)
        wv.load(URLRequest(url: url))
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "avatar")
        uiView.stopLoading()
    }

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller) }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let controller: AvatarEditorController
        init(controller: AvatarEditorController) { self.controller = controller }

        nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            MainActor.assumeIsolated { controller.handleNavFailure() }
        }
        nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            MainActor.assumeIsolated { controller.handleNavFailure() }
        }

        nonisolated func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
            MainActor.assumeIsolated {
                guard let b = message.body as? [String: Any], let type = b["type"] as? String else { return }
                switch type {
                case "ready":
                    controller.markReady()
                case "catalog":
                    if let data = b["data"], let cat = Self.decode(AvatarCatalog.self, data) { controller.onCatalog(cat) }
                case "config":
                    if let data = b["data"], let cfg = Self.decode(Avatar3DConfig.self, data) { controller.onConfig(cfg) }
                case "captured":
                    controller.onCaptured(b["dataUrl"] as? String)
                default:
                    break
                }
            }
        }

        private static func decode<T: Decodable>(_ type: T.Type, _ obj: Any) -> T? {
            guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
            return try? JSONDecoder().decode(T.self, from: data)
        }
    }
}
