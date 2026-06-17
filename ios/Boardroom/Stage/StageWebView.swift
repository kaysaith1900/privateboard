import SwiftUI
import WebKit

/// Handle the room view + session push into the embedded 3D stage. Calls are
/// queued until the embed posts `ready`, then flushed in order. (See BRIDGE.md.)
@MainActor
final class StageController {
    fileprivate weak var webView: WKWebView?
    var onUnsupported: (() -> Void)?

    private var ready = false
    private var pending: [String] = []
    private var watchdog: Task<Void, Never>?

    nonisolated init() {}     // lets SwiftUI @State create it from a nonisolated View.init

    fileprivate func attach(_ wv: WKWebView) {
        webView = wv
        // A fresh WebView (first mount, or a REMOUNT after the user toggled to the
        // transcript and back) has not booted its embed yet — re-queue every bridge
        // call until THIS webview posts `ready`. Without resetting, a stale `ready`
        // left true by the previous mount makes run() fire JS at a webview whose
        // StageBridge doesn't exist yet, so the in-progress speaker / lip-sync state
        // is silently dropped until the next change repaints it (the "stage came
        // back without a close-up or mouth movement until the next director" bug).
        ready = false
        pending.removeAll()
        // If the embed never posts `ready` (dev server down, unreachable host,
        // JS error), don't sit on a black WebView forever — fall back to the
        // transcript. Cancelled the moment `ready` arrives.
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 7_000_000_000)
            guard let self, !self.ready, !Task.isCancelled else { return }
            self.onUnsupported?()
        }
    }

    fileprivate func markReady() {
        watchdog?.cancel(); watchdog = nil
        ready = true
        pending.forEach { webView?.evaluateJavaScript($0) }
        pending.removeAll()
    }

    /// The stage page itself failed to load (network / HTTP error).
    fileprivate func loadFailed() {
        guard !ready else { return }
        watchdog?.cancel(); watchdog = nil
        onUnsupported?()
    }

    private func run(_ js: String) {
        if ready { webView?.evaluateJavaScript(js) } else { pending.append(js) }
    }

    /// Who is on stage + their state ("thinking" / "speaking" / nil).
    func setSpeaker(id: String?, state: String?) {
        run("window.StageBridge && StageBridge.setSpeaker(\(arg(id)), \(arg(state)))")
    }

    /// Who is currently *audible* (TTS playing) → drives mouth lip-sync. The
    /// native VoicePlayer is the source of truth; nil when nothing plays/paused.
    func setAudible(_ id: String?) {
        run("window.StageBridge && StageBridge.setAudible(\(arg(id)))")
    }

    /// Re-tint the stage floor + walls when the tone changes in room settings,
    /// without reloading the scene (StageBridge.setMode → MV.update).
    func setMode(_ mode: String) {
        run("window.StageBridge && StageBridge.setMode(\(arg(mode)))")
    }

    /// Manual pinch-zoom factor (userZoom distance multiplier) from the native MagnifyGesture.
    func setZoom(_ z: Double) {
        run("window.StageBridge && StageBridge.setZoom(\(z))")
    }

    /// Manual drag-rotate (orbit yaw/pitch radians) from the native DragGesture.
    func setOrbit(_ yaw: Double, _ pitch: Double) {
        run("window.StageBridge && StageBridge.setOrbit(\(yaw), \(pitch))")
    }

    /// A tap from the native overlay (normalised 0..1 canvas coords) · the embed
    /// raycasts to that point and closes the camera up on the hit director.
    func tapAt(_ nx: Double, _ ny: Double) {
        run("window.StageBridge && StageBridge.tapAt(\(nx), \(ny))")
    }

    /// Show the user's just-sent message as a bubble above their seat, with the
    /// 6s countdown bar that auto-dismisses it (the embed owns the timer). Pass
    /// nil/empty to clear immediately. Mirrors the desktop voice room's
    /// `showUserBubble` + the mobile-web `pendingUserBubble`.
    func setUserBubble(_ text: String?) {
        run("window.StageBridge && StageBridge.setUserBubble(\(arg(text)))")
    }

    func teardown() {
        watchdog?.cancel(); watchdog = nil
        webView?.evaluateJavaScript("window.StageBridge && StageBridge.unmount()")
    }

    private func arg(_ s: String?) -> String {
        guard let s else { return "null" }
        let escaped = s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")   // user message may be multi-line · a raw newline breaks the JS string literal
            .replacingOccurrences(of: "\r", with: "\\r")
        return "\"\(escaped)\""
    }
}

/// WKWebView hosting `stage-embed.html`. The embed self-boots from the `room`
/// query param (fetches the cast same-origin, mounts the WebGL ring); this view
/// only wires the message channel and hands the web view to the controller.
struct StageWebView: UIViewRepresentable {
    let url: URL
    let controller: StageController

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.userContentController.add(context.coordinator, name: "stage")

        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.isOpaque = false
        wv.backgroundColor = .clear
        wv.navigationDelegate = context.coordinator
        wv.scrollView.isScrollEnabled = false
        wv.scrollView.bounces = false
        controller.attach(wv)
        wv.load(URLRequest(url: url))
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "stage")
        uiView.stopLoading()
    }

    func makeCoordinator() -> Coordinator { Coordinator(controller: controller) }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let controller: StageController
        init(controller: StageController) { self.controller = controller }

        // Network / load failures → fall back to the transcript (never a black stage).
        nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            MainActor.assumeIsolated { controller.loadFailed() }
        }
        nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            MainActor.assumeIsolated { controller.loadFailed() }
        }
        nonisolated func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if let http = navigationResponse.response as? HTTPURLResponse, !(200..<400).contains(http.statusCode) {
                MainActor.assumeIsolated { controller.loadFailed() }
                decisionHandler(.cancel); return
            }
            decisionHandler(.allow)
        }

        nonisolated func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
            // WebKit always delivers script messages on the main thread.
            MainActor.assumeIsolated {
                guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
                let seatId = body["seatId"] as? String
                switch type {
                case "ready":       controller.markReady()
                case "unsupported": controller.onUnsupported?()
                case "tap":         _ = seatId            // TODO: open the tapped director's profile
                default:            break
                }
            }
        }
    }
}
