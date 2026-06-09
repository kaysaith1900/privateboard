# Boardroom · iOS (native Swift, hybrid)

Native SwiftUI client for the same backend that powers the desktop app. The
3D stage and the report renderer are embedded `WKWebView`s (see `BRIDGE.md`);
everything else — rooms list, room shell, dock/rail/captions, voice playback,
settings, creation — is native.

**Backend model:** for now the app talks to the desktop server over the LAN.
Cloud-hosted mode is a later swap (just a different `baseURL` + an auth token —
see `Net/Backend.swift`). Nothing else changes.

---

## Build

Prereqs: Xcode 15+, and [XcodeGen](https://github.com/yonyz/XcodeGen)
(`brew install xcodegen`). The Xcode project is generated from `project.yml`
so it never needs hand-merging.

```sh
cd ios
xcodegen generate      # → Boardroom.xcodeproj
open Boardroom.xcodeproj
```

Set your Apple Developer team in `project.yml` (`DEVELOPMENT_TEAM`) or in Xcode
signing before running on a device. Simulator runs without signing but **can't
reach a LAN backend** — use a real iPhone on the same Wi-Fi (or point at
`127.0.0.1` only when the server runs on the same machine as the simulator).

> The `.swift` files show "Cannot find type …" in an editor that opens them
> outside the project — that's expected (they're one module only once XcodeGen
> wires the target). Generate the project first.

## Run against the desktop backend

1. Start the server bound to all interfaces so the phone can reach it:
   ```sh
   boardroom --host 0.0.0.0 -p 3030
   ```
2. Find your Mac's LAN IP (System Settings → Wi-Fi → Details, or
   `ipconfig getifaddr en0`).
3. Launch the app → enter `‹mac-ip›:3030` on the Connect screen.
4. iOS will prompt for **Local Network** access the first time — allow it.

ATS already permits cleartext LAN traffic (`NSAllowsLocalNetworking` in
`project.yml`). No CORS setup is needed — a native client isn't a browser.

---

## Layout

```
Boardroom/
  App/        BoardroomApp, RootView, AppState (@Observable store)
  Net/        Backend (config), Models (Codable), APIClient (REST), SSEClient
  Rooms/      RoomsListView (status-grouped), RoomDetailView (Phase-1 stub)
  Settings/   ConnectView (server address)
  Support/    Theme (palette), RelativeTime, Info.generated.plist (by XcodeGen)
```

## Status / roadmap

- **Phase 1 (this commit):** networking layer (REST + SSE) + Codable models +
  rooms list grouped Live / Paused / Adjourned + connect-to-LAN-backend flow +
  room-detail stub. Runnable end-to-end against a local server.
- **Phase 2:** room shell — live SSE (tokens/queue), native voice playback
  (chunk queue + `/voice-progress` heartbeat + `/voice-done`), caption sync,
  background audio.
- **Phase 3 (done):** 3D stage — `stage-embed.html` (self-boots the cast from
  `?room=`) in a WKWebView (`Stage/StageWebView.swift`), with native speaker +
  audible state pushed in to drive camera + lip-sync. Voice rooms show the
  stage; a toolbar toggle flips to the transcript; WebGL-less devices fall back.
- **Phase 4 (in progress):** report viewing — `Report/ReportSheet.swift` fetches
  the latest brief, polls while it generates (or generates one), and shows it
  full-fidelity in `ReportWebView` (the backend's own `report.html` / spine).
  Create room — `Create/NewRoomView.swift` (subject + tone/intensity/delivery +
  auto-pick or ≥2 directors) → `POST /api/rooms`, inserted at the top of the
  list. Entry points: "+" in the rooms list, doc icon in the room.
  Room lifecycle — a room menu (⋯) adjourns or deletes the room. Home is now a
  two-tab `HomeView` (Rooms / Directors); the Directors tab lists the board and
  opens a profile (`AgentProfileView`, full record via `GET /api/agents/:id`).
  *Remaining:* settings depth, onboarding, Keychain (lands with cloud), seat-tap
  → profile, polish.
- **Later:** cloud backend switch (auth token + hosted `baseURL`).
