# Native ⇄ WebView bridge contract

The hybrid app keeps **two** surfaces in `WKWebView` and builds everything else
natively: the **3D stage** and the **report renderer**. Both WebViews are loaded
from the backend origin (`{baseURL}/mobile/...` and `{baseURL}/report.html`), so
relative asset paths (`/avatars/...`, GLBs, fonts) and same-origin API calls
just work — no asset bundling into the app.

This file is the source of truth for the JS⇄Swift message surface. Define it
before writing the embeds so both sides agree.

---

## 1. 3D stage

### Engine we're wrapping

`public/mobile/voice-3d-mobile.js` exposes (verified):

```js
window.MobileVoiceStage3D = { isSupported, mount, update, unmount }
```

- `mount(host, opts)` — `opts = { camera: { distance, elevationDeg, lookAtY }, loadingLabel }`
- `update(state)` — the per-frame/per-change state (shape below)
- `unmount()` / `isSupported()`

`update(state)` shape (from the engine's `update()` + the web shell's `paintStage`):

```jsonc
{
  "mode": "constructive",              // tone → floor/wall/table palette
  "positions": [ /* seat layout, see below */ ],
  "speakerId": "agent_123" | null,
  "speakerState": "thinking" | "speaking" | null,
  "userWait": false,
  "userBubble": { "text": "…", "progress": 0.0 } | null,
  "labels": { "thinking": "…", "speaking": "…" },
  "votePop": ""                         // chair vote HTML (later)
}
```

`positions` is produced on the web by `computeSeatPositions(members)`, where each
member is:

```jsonc
{ "id": "agent_123", "name": "Socrates", "avatarPath": "/avatars/x.webp",
  "roleKind": "chair" | "director", "avatar3d": { "model": "casual" } | null }
```

> **TODO (first task of the stage phase):** port `computeSeatPositions` from
> `voice-room-shell.js` into the embed (or expose a `setCast(members)` that
> computes positions internally) so Swift only ever sends the **member list**,
> never seat geometry.

### `stage-embed.html` (✅ built · `public/mobile/stage-embed.html`)

Imports the engine, mounts it full-bleed, and **self-boots from the `?room=`
query param** — it fetches `/api/rooms/:id` same-origin and builds the cast
itself (chair-first + a synthetic `__user` seat), so Swift never models
`avatar3d` or seat geometry. `computeSeatPositions` is ported verbatim into the
embed. Native only pushes the live, transient state:

**Swift → JS** (`webView.evaluateJavaScript`, via `StageController`)

```js
window.StageBridge = {
  setSpeaker(id, state),   // id + "thinking"|"speaking"|null → camera + overlay
  setAudible(id),          // the single audible speaker (or null) → lip-sync
  setMode(mode),           // tone palette swap (optional)
  unmount()
}
```

Camera focus is automatic (the engine's `update()` glides to a changed speaker),
so no `focusSeat` is needed.

**JS → Swift** (`webkit.messageHandlers.stage.postMessage`)

```jsonc
{ "type": "ready" }                        // mounted + cast loaded → flush queued calls
{ "type": "unsupported" }                  // WebGL unavailable → native shows the transcript
{ "type": "tap", "seatId": "agent_123" }   // TODO Phase 4 · open that director natively
```

URL: `{baseURL}/mobile/stage-embed.html?room=<id>&mode=<tone>`.

### ⚠️ The one non-trivial seam: lip-sync

On the web the engine drives mouth visemes off `window.app.isSpeakerAudible(id)`,
which reads the **TTS audio element**. In the hybrid app the audio plays
**natively** (AVAudioEngine), so the WebView can't see it. Therefore:

- `stage-embed.html` defines `window.app = { isSpeakerAudible: (id) => _audible.has(id) }`
  backed by a local set.
- `StageBridge.setSpeakerAudible(id, on)` mutates that set.
- The native `VoicePlayer` pushes it on play/pause/end (and may push a
  `setMouthLevel(id, 0..1)` later if we want amplitude-driven mouths instead of
  the procedural flap).

So: native audio → native pushes audible flag → WebView animates the mouth.

---

## 2. Report

`public/report.html` already renders a brief by id and is self-contained
(the ~1250-line inline renderer + spines + kami-chart). Reuse as-is.

### `ReportWebView` (Swift)

- Loads `{baseURL}/report.html?briefId=<id>` (⚠️ **confirm the exact URL + query
  param** against the route before wiring — `report.html` may expect a hash or a
  different key).
- **Swift → JS:** none required for v1 (the page fetches its own data
  same-origin).
- **JS → Swift** (`webkit.messageHandlers.report.postMessage`): route the
  page's existing download / share / copy actions to the native share sheet
  instead of a browser download. Add the message post inside report.html's
  action handlers behind a `window.webkit?.messageHandlers?.report` check so the
  page still works in a plain browser.

---

## Open items

1. ~~Port `computeSeatPositions` so Swift sends members only.~~ ✅ Done — the
   embed self-fetches the cast from `?room=`, so Swift sends nothing about the
   cast at all.
2. **Report (Phase 4):** confirm `report.html`'s brief-loading URL contract
   (query vs hash, param name) before wiring `ReportWebView`.
3. Seat tap → open the director profile natively (the `tap` message is reserved;
   the engine doesn't emit it yet — needs a raycast hook or DOM overlay seats).
4. **Cloud mode:** the embed's same-origin `/api/rooms/:id` fetch is unauthed
   today (local server). When cloud lands, pass the token into the embed so its
   fetch authenticates.
5. Lip-sync is event-driven (`setAudible` on play/pause/end → procedural flap).
   Add `setMouthLevel(0..1)` only if amplitude-driven mouths are wanted.
