import SwiftUI

struct RootView: View {
    @Environment(AppState.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var showOnboarding = false
    @State private var showSplash = true
    @State private var notice: Notice?
    @State private var showApiKeys = false       // billing/auth CTA → deep-link to the API-keys screen
    @State private var showBrief = false        // reopen the minimised report

    /// A user-facing error prompt, raised from the engine / room-session / TTS /
    /// foreground-resume via `AppNotice` (and the TTS `VoiceBillingAlert`). One
    /// modal `.alert` presents all kinds; buttons differ per `kind`.
    struct Notice: Identifiable {
        let id = UUID()
        let kind: AppNotice.Kind
        let provider: String?
        let message: String
        let ctaURL: String?
    }

    var body: some View {
        ZStack {
            // Native-only · the on-device engine is the sole backend (no ConnectView).
            home
            // Launch splash · black surface, centred logo + slogan. Fades out after a
            // brief beat so the cold start lands on a branded surface, not a flash of
            // the empty home grid.
            if showSplash {
                SplashView()
                    .transition(.opacity)
                    .zIndex(1)
                    .task {
                        try? await Task.sleep(for: .milliseconds(1400))
                        withAnimation(.easeOut(duration: 0.45)) { showSplash = false }
                    }
            }
            // Global "generating report" badge · the report overlay keeps generating
            // in the background after it's minimised (the job lives on AppState, not
            // the view), and this floating pill reports progress + reopens it. Hidden
            // while the report sheet itself is up (it occludes / or showBrief gates it).
            if let job = app.briefJob, !showBrief, !showSplash {
                BriefBadge(job: job,
                           onTap: { showBrief = true },
                           onDismiss: { withAnimation(.spring(response: 0.4, dampingFraction: 0.85)) { app.clearBriefJob() } })
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, 104)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .zIndex(2)
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.82), value: app.briefJob?.id)
        .animation(.easeInOut(duration: 0.25), value: app.briefJob?.status)
        .sheet(isPresented: $showBrief) {
            if let job = app.briefJob {
                NativeBriefView(roomId: job.roomId, supplement: job.supplement,
                                initialMode: job.mode.rawValue, initialStyle: job.style)
                    .environment(app)
            }
        }
        // TTS voice-billing failure → fold into the unified notice (its own
        // localized "voice paused" copy; the room going silent is explained).
        .onReceive(NotificationCenter.default.publisher(for: TTSEngineAdapter.VoiceBillingAlert.didFail)) { note in
            guard let info = note.userInfo, let provider = info["provider"] as? String,
                  let url = info["upgradeUrl"] as? String else { return }
            notice = Notice(kind: .billing, provider: provider,
                            message: Loc.t("m_tts_billing_msg", ["provider": Self.providerName(provider)]),
                            ctaURL: url)
        }
        // TTS key REJECTED (invalid / wrong-region key) → an auth notice so the room
        // going silent is explained + the user is sent to fix the key (not muted blindly).
        .onReceive(NotificationCenter.default.publisher(for: TTSEngineAdapter.VoiceBillingAlert.didFailKey)) { note in
            guard let info = note.userInfo, let provider = info["provider"] as? String else { return }
            notice = Notice(kind: .auth, provider: provider,
                            message: Loc.t("m_tts_keyerror_msg", ["provider": Self.providerName(provider)]),
                            ctaURL: nil)
        }
        // Engine / room-session / foreground-resume prompts (billing / auth / network / reconnect).
        .onReceive(NotificationCenter.default.publisher(for: AppNotice.didPost)) { note in
            guard let info = note.userInfo, let raw = info["kind"] as? String,
                  let kind = AppNotice.Kind(rawValue: raw), let message = info["message"] as? String else { return }
            notice = Notice(kind: kind, provider: info["provider"] as? String,
                            message: message, ctaURL: info["ctaURL"] as? String)
        }
        .alert(Self.noticeTitle(notice?.kind),
               isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } }),
               presenting: notice) { n in
            noticeButtons(n)
        } message: { n in Text(n.message) }
        // Billing / auth CTA → the API-keys screen (manage providers + keys).
        .sheet(isPresented: $showApiKeys) {
            NavigationStack {
                ApiKeysView()
                    .toolbar { ToolbarItem(placement: .topBarTrailing) { Button(Loc.t("common_done")) { showApiKeys = false } } }
            }
            .environment(app)
        }
    }

    @ViewBuilder private func noticeButtons(_ n: Notice) -> some View {
        switch n.kind {
        case .billing:
            if let url = n.ctaURL, let u = URL(string: url) {
                Button(Loc.t("m_tts_billing_recharge")) { openURL(u) }
            }
            Button(Loc.t("m_auth_cta")) { showApiKeys = true }
            Button(Loc.t("m_tts_billing_dismiss"), role: .cancel) {}
        case .auth:
            Button(Loc.t("m_auth_cta")) { showApiKeys = true }
            Button(Loc.t("common_done"), role: .cancel) {}
        case .network:
            Button(Loc.t("common_retry")) { Task { await app.refresh() } }
            Button(Loc.t("common_done"), role: .cancel) {}
        case .reconnect:
            Button(Loc.t("common_retry")) { app.handleForeground() }
            Button(Loc.t("common_done"), role: .cancel) {}
        }
    }

    private static func noticeTitle(_ kind: AppNotice.Kind?) -> String {
        switch kind {
        case .billing:   return Loc.t("m_billing_title")
        case .auth:      return Loc.t("m_auth_title")
        case .network:   return Loc.t("m_net_title")
        case .reconnect: return Loc.t("m_reconnect_title")
        case nil:        return ""
        }
    }

    private static func providerName(_ id: String) -> String {
        switch id { case "minimax": return "MiniMax"; case "elevenlabs": return "ElevenLabs"
                    case "openai": return "OpenAI"; default: return id }
    }

    private var home: some View {
        HomeView()
            .task {
                if app.isNative { await app.refresh() }
                // First-run gate · show the gamified 5-step onboarding until the
                // user finishes it (which requires an LLM key). Returning users
                // who already have a key never see it.
                if !OnboardingState.completed && !app.hasLLMKey { showOnboarding = true }
            }
            .fullScreenCover(isPresented: $showOnboarding) {
                OnboardingFlow(onDone: {
                    showOnboarding = false
                    Task { await app.refresh() }
                    app.requestStarterPlays()   // lead straight into the room composer
                })
                .environment(app)
                .interactiveDismissDisabled()   // can't skip · must complete the flow
            }
    }
}

/// Global floating "report is generating" badge · a gold glass capsule pinned
/// above the tab bar. Shown whenever a `BriefJob` is in flight (or finished but
/// not yet dismissed) and the report sheet itself isn't open. Tapping reopens
/// the report; the × drops the job. Mirrors the desktop's minimised-brief chip.
private struct BriefBadge: View {
    let job: BriefJob
    let onTap: () -> Void
    let onDismiss: () -> Void

    private var title: String {
        switch job.status {
        case .generating: return Loc.t("m_brief_badge_generating")
        case .ready:      return Loc.t("m_brief_badge_ready")
        case .failed:     return Loc.t("m_brief_badge_failed")
        }
    }

    var body: some View {
        HStack(spacing: 11) {
            // Status glyph · spinning gold ring (generating) / check (ready) / warn (failed).
            Group {
                switch job.status {
                case .generating: BriefBadgeRing()
                case .ready:      Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.bbGold)
                case .failed:     Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Color.bbAmber)
                }
            }
            .font(.system(size: 17, weight: .semibold))
            .frame(width: 22, height: 22)

            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.bbInk)
                    .lineLimit(1)
                Text(job.roomTitle)
                    .font(.system(size: 12)).foregroundStyle(Color.bbInkDim)
                    .lineLimit(1).truncationMode(.tail)
            }

            Spacer(minLength: 6)

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Color.bbInkFaint)
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 16).padding(.trailing, 6).padding(.vertical, 9)
        .frame(maxWidth: 320)
        .glassEffect(.regular.interactive(), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.bbGold.opacity(0.28), lineWidth: 1))
        .contentShape(Capsule())
        .onTapGesture(perform: onTap)
        .shadow(color: .black.opacity(0.28), radius: 18, y: 6)
        .padding(.horizontal, 20)
    }
}

/// A small spinning gold arc for the global brief badge · SwiftUI twin of the
/// FAB orbit loader, sized for a 22pt slot.
private struct BriefBadgeRing: View {
    @State private var spin = false
    var body: some View {
        ZStack {
            Circle().stroke(Color.bbGold.opacity(0.18), lineWidth: 2.2)
            Circle().trim(from: 0, to: 0.3)
                .stroke(Color.bbGold, style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
                .rotationEffect(.degrees(spin ? 360 : 0))
        }
        .frame(width: 18, height: 18)
        .onAppear {
            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { spin = true }
        }
    }
}
