import SwiftUI

/// Report flow for a room · fetch the latest brief and either show it
/// (full-fidelity WebView), poll while it generates, or offer to generate one.
struct ReportSheet: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    let room: Room

    private enum Phase {
        case loading, generating, ready(URL), none, error(String)
    }
    @State private var phase: Phase = .loading
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.bbBg.ignoresSafeArea()
                switch phase {
                case .loading:
                    ProgressView().tint(.bbGold)
                case .generating:
                    statusView("Generating the report…", showSpinner: true)
                case .ready(let url):
                    ReportWebView(url: url).ignoresSafeArea(edges: .bottom)
                case .none:
                    noneView
                case .error(let message):
                    errorView(message)
                }
            }
            .navigationTitle("Report")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
        .task { await load() }
        .onDisappear { pollTask?.cancel() }
    }

    // MARK: Flow

    private func load() async {
        guard let api = app.api else { phase = .error("No server connected."); return }
        do {
            let briefs = try await api.roomBriefs(room.id)
            guard let latest = briefs.first else { phase = .none; return }
            apply(latest, api: api)
        } catch {
            phase = .error((error as? APIClient.APIError)?.errorDescription ?? error.localizedDescription)
        }
    }

    private func apply(_ brief: Brief, api: APIClient) {
        if brief.isReady, let url = api.reportURL(brief: brief, roomId: room.id) {
            phase = .ready(url)
        } else {
            phase = .generating
            poll(brief.id, api: api)
        }
    }

    private func poll(_ id: String, api: APIClient) {
        pollTask?.cancel()
        pollTask = Task {
            for _ in 0..<60 {                       // ~2 min budget
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if Task.isCancelled { return }
                if let full = try? await api.getBrief(id), full.isReady,
                   let url = api.reportURL(brief: full, roomId: room.id) {
                    phase = .ready(url); return
                }
            }
            phase = .error("The report is taking longer than expected. Try again shortly.")
        }
    }

    private func generate() {
        guard let api = app.api else { return }
        phase = .generating
        Task {
            do { try await api.generateBrief(room.id); await load() }
            catch { phase = .error((error as? APIClient.APIError)?.errorDescription ?? error.localizedDescription) }
        }
    }

    // MARK: Subviews

    private func statusView(_ text: String, showSpinner: Bool) -> some View {
        VStack(spacing: 12) {
            if showSpinner { ProgressView().tint(.bbGold) }
            Text(text).font(.callout).foregroundStyle(Color.bbInkDim)
        }
    }

    private var noneView: some View {
        VStack(spacing: 14) {
            Text("No report yet").font(.headline).foregroundStyle(Color.bbInk)
            Text("Generate one from the discussion so far.")
                .font(.callout).foregroundStyle(Color.bbInkDim).multilineTextAlignment(.center)
            Button("Generate report") { generate() }
                .buttonStyle(.borderedProminent).tint(.bbGold)
        }
        .padding(32)
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle").font(.title2).foregroundStyle(Color.bbInkFaint)
            Text(message).font(.callout).foregroundStyle(Color.bbInkDim).multilineTextAlignment(.center)
            Button("Retry") { Task { await load() } }.tint(.bbGold)
        }
        .padding(32)
    }
}
