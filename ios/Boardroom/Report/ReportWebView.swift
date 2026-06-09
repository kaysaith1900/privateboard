import SwiftUI
import WebKit

/// Full-fidelity report · loads the backend's own spine renderer
/// (`report.html` / `magazine.html` / …) for a brief. Self-contained: the page
/// fetches its own data same-origin, so there's no JS bridge to wire (download
/// / share routing to a native sheet is a later nicety — see BRIDGE.md).
struct ReportWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let wv = WKWebView()
        wv.isOpaque = false
        wv.backgroundColor = .black
        wv.scrollView.backgroundColor = .black
        wv.load(URLRequest(url: url))
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
