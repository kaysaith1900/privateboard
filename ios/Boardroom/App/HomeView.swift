import SwiftUI

/// Home · iOS-26 Photos layout.
/// • Native large-title nav bar → the title collapses + a blurred bar fades in
///   as the list scrolls, and the settings button stays pinned (the Photos
///   "hovering header with blur transition"). iOS 26 renders the toolbar
///   button as Liquid Glass automatically.
/// • Bottom: a single Liquid-Glass SEGMENTED tab control (one pill, the gold
///   selection slides between equal-width segments) + a separate glass + button.
struct HomeView: View {
    @Environment(AppState.self) private var app
    @State private var tab: HomeTab =
        ProcessInfo.processInfo.environment["BB_TAB"] == "directors" ? .directors : .rooms
    @State private var showNewRoom = false
    @State private var showNewDir = false
    @State private var showPrefs = false
    @State private var showApiKeys = false              // no-key gate → deep-link to API keys
    @State private var showNoKeyAlert = false
    @State private var showOnboarding = false           // first-run starter-plays overlay
    @State private var onboardingArmed = true           // auto-present once per session when empty
    @State private var scenarioSeed: RoomScenario?      // starter play → pre-filled composer
    @State private var pendingScenario: RoomScenario?   // play picked in the overlay, gated after dismiss
    @State private var path = NavigationPath()

    enum HomeTab: Hashable { case rooms, directors }

    private var title: String { tab == .rooms ? Loc.t("m_home_rooms") : Loc.t("m_home_directors") }

    /// An active LLM credential exists · gates room / director / scenario creation.
    private var hasLLMKey: Bool { app.hasLLMKey }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if tab == .rooms { RoomsPanel(path: $path, onCreate: startRoom) } else { DirectorsPanel(path: $path) }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 8)
            }
            .background(Color.bbBg.ignoresSafeArea())
            .scrollIndicators(.hidden)
            .defaultScrollAnchor(.top)
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .top, spacing: 0) { masthead }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    // Background voice player · shown on Home while a room left
                    // mid-playback keeps going. Tap → back into the room; ✕ → stop.
                    // (A pushed RoomView covers this inset, so it only shows on Home.)
                    if let np = app.nowPlaying {
                        MiniPlayerBar(session: np,
                                      onOpen: { app.pendingOpenRoom = np.room },
                                      onClose: { app.stopNowPlaying() })
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                    bottomBar
                }
                .animation(.smooth(duration: 0.28), value: app.nowPlaying == nil)
            }
            // Mini-player tapped · push its room (the .task there re-adopts the live session).
            .onChange(of: app.pendingOpenRoom) { _, room in
                if let room { path.append(room); app.pendingOpenRoom = nil }
            }
            .onAppear {   // honor the screenshot env even if scene restoration set a tab
                if ProcessInfo.processInfo.environment["BB_TAB"] == "directors" { tab = .directors }
                if let rid = ProcessInfo.processInfo.environment["BB_OPEN"], path.isEmpty,
                   let room = app.rooms.first(where: { $0.id == rid }) ?? app.rooms.first {
                    path.append(room)
                }
                maybeOnboard()
            }
            .onChange(of: app.phase) { _, _ in maybeOnboard() }
            .onChange(of: app.starterPlaysNonce) { _, _ in   // onboarding finished → starter plays
                onboardingArmed = true; tab = .rooms; maybeOnboard()
            }
            .navigationDestination(for: Room.self) { RoomView(room: $0) }
            .navigationDestination(for: Agent.self) { AgentProfileView(agent: $0) }
            .sheet(isPresented: $showNewRoom) { NewRoomView(onCreated: { room in showNewRoom = false; path.append(room) }) }
            .sheet(item: $scenarioSeed) { s in
                NewRoomView(scenario: s, onCreated: { room in scenarioSeed = nil; path.append(room) })
            }
            .sheet(isPresented: $showNewDir) { NewDirectorView() }
            .sheet(isPresented: $showPrefs) { PrefsView() }
            // First-run onboarding overlay · picking a play is gated AFTER the
            // overlay dismisses (onDismiss) to avoid sheet-over-sheet races.
            .sheet(isPresented: $showOnboarding, onDismiss: {
                if let s = pendingScenario { pendingScenario = nil; startScenario(s) }
            }) {
                OnboardingOverlay(roster: app.agents, onPick: { s in pendingScenario = s; showOnboarding = false })
            }
            // No-key gate · deep-link straight to the API-keys page.
            .sheet(isPresented: $showApiKeys) {
                NavigationStack {
                    ApiKeysView()
                        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button(Loc.t("common_done")) { showApiKeys = false } } }
                }
            }
            .alert(Loc.t("m_nokey_title"), isPresented: $showNoKeyAlert) {
                Button(Loc.t("common_cancel"), role: .cancel) {}
                Button(Loc.t("m_nokey_go")) { showApiKeys = true }
            } message: { Text(Loc.t("m_nokey_msg")) }
        }
    }

    /// Auto-present the starter-plays overlay once per session when the Rooms tab
    /// is ready and empty — keeps the onboarding off the rooms list itself.
    private func maybeOnboard() {
        // Only after the first-run flow is done — don't stack the starter-plays
        // overlay under the onboarding cover.
        guard OnboardingState.completed, onboardingArmed, tab == .rooms,
              app.rooms.isEmpty, case .ready = app.phase else { return }
        onboardingArmed = false
        showOnboarding = true
    }

    // MARK: Gated creation entry points

    /// Start a room / director / scenario only when an LLM key is configured;
    /// otherwise prompt the user to set one up (→ API keys page).
    private func startRoom() { if hasLLMKey { showNewRoom = true } else { showNoKeyAlert = true } }
    private func startDirector() { if hasLLMKey { showNewDir = true } else { showNoKeyAlert = true } }
    private func startScenario(_ s: RoomScenario) { if hasLLMKey { scenarioSeed = s } else { showNoKeyAlert = true } }

    /// Pinned masthead · title + settings on ONE row, hovering over the list.
    /// `safeAreaInset(.top)` pins it below the status bar (native safe-area
    /// handling) and reserves its height so the list scrolls cleanly beneath
    /// the blurred gradient bar.
    private var masthead: some View {
        HStack(alignment: .center) {
            Text(title)
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(Color.bbInk)
            Spacer()
            GlassIconButton(system: "gearshape") { showPrefs = true }   // system .glass
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { TopScrim().ignoresSafeArea(edges: .top) }
    }

    // ── Floating bottom bar · FabBar (vendored) ────────────────────────────
    // The genuine iOS-26 Liquid Glass tab bar (icon+label segments with the
    // bubbly squish selection) + the gold FAB. Implemented by FabBar
    // (Vendor/FabBar, MIT, ryanashcraft.com/introducing-fabbar): a
    // UISegmentedControl with injected icon/label content views inside a
    // UIGlassContainerEffect — the only faithful way to get the system squish,
    // which pure SwiftUI can't reproduce.
    private var bottomBar: some View {
        FabBarRepresentable(
            tabs: [
                FabBarTab(value: HomeTab.rooms, title: Loc.t("m_home_rooms"), systemImage: "square.grid.2x2"),
                FabBarTab(value: HomeTab.directors, title: Loc.t("m_home_directors"), systemImage: "person.2"),
            ],
            action: FabBarAction(systemImage: "plus", accessibilityLabel: Loc.t("m_home_new")) {
                if tab == .rooms { startRoom() } else { startDirector() }
            },
            // Directors tab · spin the "+" while a persona build runs in the
            // background (overlay closed); tapping reopens the live build screen.
            actionLoading: tab == .directors && app.directorBuilding,
            activeTab: $tab
        )
        .frame(height: 62)
        .tint(.bbGold)
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
    }
}

/// Floating background player · a glass bar shown on Home while a voice room
/// left mid-playback keeps streaming. Avatar + current speaker, a play/pause
/// toggle, and ✕ to stop. Tapping the body returns to the room.
private struct MiniPlayerBar: View {
    let session: RoomSession
    var onOpen: () -> Void
    var onClose: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onOpen) {
                HStack(spacing: 12) {
                    AvatarView(path: session.currentSpeakerAvatar, name: session.currentSpeakerName, size: 36)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Loc.t("m_mini_playing")).font(.system(size: 9, weight: .bold, design: .monospaced))
                            .kerning(1.2).foregroundStyle(Color.bbGold)
                        Text(session.currentSpeakerName).font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Color.bbInk).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // Play / pause without leaving Home.
            Button { session.togglePause() } label: {
                Image(systemName: session.paused ? "play.fill" : "pause.fill")
                    .font(.system(size: 15, weight: .bold)).foregroundStyle(Color.bbInk)
                    .frame(width: 38, height: 38).contentShape(Circle())
                    .background(Circle().fill(Color.white.opacity(0.06)))
                    .overlay(Circle().stroke(Color.bbLine, lineWidth: 1))
            }.buttonStyle(.plain)
            // Stop + dismiss the player.
            Button(action: onClose) {
                Image(systemName: "xmark").font(.system(size: 13, weight: .bold)).foregroundStyle(Color.bbInkDim)
                    .frame(width: 38, height: 38).contentShape(Circle())
            }.buttonStyle(.plain)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(.horizontal, 16)
    }
}
