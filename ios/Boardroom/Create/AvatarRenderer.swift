import SwiftUI
import WebKit

// ════════════════════════════════════════════════════════════════════════════
//  AvatarRenderer · native front-end for the 3D-avatar snapshot pipeline.
//  Hosts a hidden WKWebView running `/mobile/avatar-embed.html` (the same
//  `Avatar3DSnap` render the desktop uses). `render(seed:)` asks the bridge for
//  a seed's portrait and awaits the PNG data-URL — used to give a freshly built
//  director a real 3D avatar, with a dice "re-roll" cycling new random seeds.
// ════════════════════════════════════════════════════════════════════════════
@MainActor
final class AvatarRenderer {
    fileprivate weak var webView: WKWebView?
    private var ready = false
    private var queued: [() -> Void] = []
    private var conts: [String: CheckedContinuation<(dataUrl: String?, config: [String: Any]?), Never>] = [:]

    nonisolated init() {}

    /// 8-char hex seed · byte-for-byte the format of the web `randomSeed()`
    /// (`r(0xffff).padStart(4) + r(0xffff).padStart(4)`), so the same seed yields
    /// the same face on both platforms.
    static func randomSeed() -> String {
        String(format: "%04x%04x", Int.random(in: 0...0xffff), Int.random(in: 0...0xffff))
    }

    fileprivate func attach(_ wv: WKWebView) { webView = wv }

    fileprivate func markReady() {
        guard !ready else { return }
        ready = true
        queued.forEach { $0() }
        queued.removeAll()
    }

    fileprivate func deliver(seed: String, dataUrl: String?, config: [String: Any]?) {
        guard let c = conts.removeValue(forKey: seed) else { return }   // idempotent · watchdog + reply race
        c.resume(returning: (dataUrl, config))
    }

    /// Render `seed` → (PNG data-URL, the seed's deterministic avatar3d config).
    /// dataUrl is nil on no-WebGL / failure / timeout; config rides along so the
    /// caller can PERSIST the rolled look (else the room renders a different per-id
    /// default — the "捏脸没生效" bug). Calls queue until the embed posts `ready`.
    @discardableResult
    func render(seed: String, size: Int = 256, timeout: TimeInterval = 14) async -> (dataUrl: String?, config: [String: Any]?) {
        await withCheckedContinuation { (cont: CheckedContinuation<(dataUrl: String?, config: [String: Any]?), Never>) in
            conts[seed] = cont
            let fire: () -> Void = { [weak self] in
                self?.webView?.evaluateJavaScript("window.AvatarBridge && AvatarBridge.render('\(seed)', \(size))")
            }
            if ready { fire() } else { queued.append(fire) }
            // Watchdog · WebGL can silently fail in a backgrounded / tiny WebView;
            // never leave the awaiting Task hung.
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.deliver(seed: seed, dataUrl: nil, config: nil)
            }
        }
    }
}

/// The hidden WKWebView that backs `AvatarRenderer`. Kept tiny but non-zero +
/// in-hierarchy so the WebGL context initializes (the actual render happens on
/// an offscreen canvas the embed creates, not this view's surface).
struct AvatarRenderWebView: UIViewRepresentable {
    let url: URL
    let controller: AvatarRenderer

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(context.coordinator, name: "avatar")
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.isOpaque = false
        wv.backgroundColor = .clear
        wv.scrollView.isScrollEnabled = false
        controller.attach(wv)
        wv.load(URLRequest(url: url))
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "avatar")
        uiView.stopLoading()
    }

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller) }

    final class Coordinator: NSObject, WKScriptMessageHandler {
        let controller: AvatarRenderer
        init(controller: AvatarRenderer) { self.controller = controller }

        nonisolated func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
            MainActor.assumeIsolated {
                guard let b = message.body as? [String: Any], let type = b["type"] as? String else { return }
                switch type {
                case "ready":
                    controller.markReady()
                case "rendered":
                    controller.deliver(seed: b["seed"] as? String ?? "", dataUrl: b["dataUrl"] as? String,
                                       config: b["config"] as? [String: Any])
                case "error":
                    controller.deliver(seed: b["seed"] as? String ?? "", dataUrl: nil, config: nil)
                default:
                    break
                }
            }
        }
    }
}
