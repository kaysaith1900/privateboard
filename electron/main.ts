/**
 * Electron main process · PrivateBoard desktop client (v0)
 *
 * The Hono server runs in this same process — Electron's main IS Node, so
 * there's no need to spawn a sidecar. A single BrowserWindow loads the
 * server's localhost URL; renderer is fully sandboxed and talks to the
 * backend through the existing `/api/*` HTTP surface.
 *
 * Two non-obvious responsibilities:
 *   - `requestSingleInstanceLock` blocks a second app launch (better-sqlite3
 *     can't share a WAL across two processes).
 *   - `before-quit` waits for `shutdownApp()` so the SQLite WAL is
 *     checkpointed before the process exits. Electron's default quit path
 *     bypasses Node's SIGINT / SIGTERM handlers, which is the root cause of
 *     the "data appears to vanish after restart" failure mode the CLI
 *     already hardened against in `src/cli.ts`.
 */
import { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, nativeTheme, session, shell } from "electron";
// `electron-updater` ships as CommonJS · Node's strict ESM loader can't
// extract named exports from its `module.exports = { ... }` shape, so
// import the default and destructure at runtime. The TS types still
// flow through the destructure, no `any` needed.
import electronUpdaterPkg from "electron-updater";
const { autoUpdater } = electronUpdaterPkg;
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bootApp, closeDb, shutdownApp } from "../dist/boot.js";
import type { RunningServer } from "../dist/server.js";
import { buildAppMenu } from "./menu.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev-mode product name · the packaged .app reads its name from the
// bundle's Info.plist (productName="PrivateBoard"), but `npx electron .`
// runs the generic Electron binary whose `app.name` defaults to
// "Electron" — so the macOS menu bar and About panel would show that
// instead of the product name. `setName` has to be called before
// `whenReady` to take effect on the menu's app-label.
app.setName("PrivateBoard");

// Dev-mode dock icon · the packaged .app reads its icon from the
// bundled .icns (electron-builder generates it from `build/icon.png`),
// but `npx electron .` runs the generic Electron binary and would
// otherwise show the default Electron diamond in the Dock. Override
// it on macOS only; no-op everywhere else (`app.dock` is `undefined`
// on Windows / Linux). Wrapped in try/catch so a missing or unreadable
// PNG can't crash the main process — the dock icon is cosmetic.
if (process.platform === "darwin" && app.dock) {
  try {
    const iconPath = path.join(__dirname, "..", "public", "icons", "logo.png");
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) app.dock.setIcon(img);
  } catch (err) {
    process.stderr.write(`[electron] dock icon set failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let server: RunningServer | null = null;
  let win: BrowserWindow | null = null;

  // Traffic-light cluster position (macOS only). Used in two places:
  //  1. BrowserWindow constructor below, to set the initial position.
  //  2. The IPC handler that toggles visibility — Electron resets the
  //     cluster to the OS default when `setWindowButtonVisibility(false)`
  //     is called, and does NOT re-apply `trafficLightPosition` on the
  //     subsequent `(true)`. So we re-apply via `setWindowButtonPosition`
  //     every time we show the cluster.
  const TRAFFIC_LIGHT_POSITION = { x: 21, y: 23 };

  // Renderer toggles the native traffic lights when the sidebar collapses /
  // peeks back out — see public/index.html `syncElectronTrafficLights`.
  // setWindowButtonVisibility is macOS-only; silently no-op on other platforms
  // so the same renderer code is safe on Windows / Linux builds.
  ipcMain.handle("window:set-traffic-lights", (_e, visible: unknown) => {
    if (process.platform !== "darwin") return;
    if (!win) return;
    const show = Boolean(visible);
    win.setWindowButtonVisibility(show);
    // Re-pin the cluster every time it becomes visible. Without this,
    // the collapse → expand cycle leaves the buttons sitting at the
    // macOS default (~y:20, x:20) instead of our sidebar-aligned slot.
    if (show && typeof win.setWindowButtonPosition === "function") {
      win.setWindowButtonPosition(TRAFFIC_LIGHT_POSITION);
    }
  });

  // Renderer pushes the app's appearance preference (light / dark / system)
  // here whenever the user switches theme. `nativeTheme.themeSource` forces
  // macOS's appearance system for THIS app, which in turn re-renders the
  // vibrancy material in the matching tone — so the `under-window` blur
  // behind the window goes dark when the app's CSS goes dark, instead of
  // staying frosted-white against a dark UI. No-op on Windows / Linux
  // (no vibrancy concept there).
  ipcMain.handle("window:set-theme-source", (_e, v: unknown) => {
    if (v !== "dark" && v !== "light" && v !== "system") return;
    nativeTheme.themeSource = v;
  });

  async function createWindow(url: string): Promise<void> {
    const isMac = process.platform === "darwin";
    win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      // On macOS, the background must be transparent (or have alpha < 1)
      // for the vibrancy layer below to render — Electron docs:
      // "if the window backgroundColor is not transparent ... vibrancy
      // will not work." On Windows/Linux we keep the solid color since
      // those builds have no vibrancy.
      backgroundColor: isMac ? "#00000000" : "#0d0d0d",
      titleBarStyle: "hiddenInset",
      // `under-window` · classic macOS app-window vibrancy. Reads
      // lighter than the `sidebar` variant; pairs well with the
      // surrounding chrome without dominating the panels.
      // `visualEffectState: "active"` keeps vibrancy bright when the
      // window loses focus — otherwise macOS dims it and the app
      // feels half-asleep in the background.
      ...(isMac ? { vibrancy: "under-window" as const, visualEffectState: "active" as const } : {}),
      // Position the macOS traffic lights inside the sidebar-head slot, where
      // the brand logo used to sit. The renderer hides the brand on Electron
      // so the buttons take its place; visibility is toggled to follow the
      // sidebar's show/hide (Arc-browser style).
      //
      // Y-coordinate is keyed to `.sidebar-head` — the collapse-btn (height
      // 22px) sits center-aligned inside its `padding: 8px 12px` shell, but
      // the head is preceded by `.control { padding: Npx }` (the outer
      // window inset) plus a small macOS-specific drag-region offset, so
      // the empirically-matched value lands higher than naive geometry
      // suggests. If you change `.control` padding, bump both x and y
      // here by the same delta so the cluster stays aligned with the
      // sidebar's collapse button.
      ...(isMac ? { trafficLightPosition: TRAFFIC_LIGHT_POSITION } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // .cjs (not .js) · the renderer runs sandboxed, and sandboxed
        // preloads MUST be CommonJS. Our package.json sets `"type": "module"`,
        // so any plain `.js` under dist-electron is treated as ESM and the
        // preload silently fails to load — the renderer ends up with no
        // `window.privateboard`, and IPC-driven features (e.g. the traffic-
        // light sync that follows the sidebar) become silent no-ops. We
        // compile preload from `preload.cts` so tsc emits `.cjs` directly.
        preload: path.join(__dirname, "preload.cjs"),
      },
    });

    win.on("closed", () => {
      win = null;
    });

    // Fullscreen ↔ windowed sync · the renderer paints a 10px padding
    // ring around the body-grid and a 10px outer corner radius when
    // running as a windowed app on macOS. In fullscreen the OS window
    // is edge-to-edge against the screen, so that ring becomes a
    // wasted black margin and the rounded corners look like a card
    // stuck in the middle of the display. Flip a top-level
    // `is-fullscreen` class on `<html>` so the CSS can zero out both
    // when the user toggles fullscreen via the green button / shortcut.
    const setFullscreenClass = (on: boolean) => {
      if (!win || win.isDestroyed()) return;
      const js = on
        ? `document.documentElement.classList.add("is-fullscreen");`
        : `document.documentElement.classList.remove("is-fullscreen");`;
      void win.webContents.executeJavaScript(js).catch(() => {});
    };
    win.on("enter-full-screen", () => setFullscreenClass(true));
    win.on("leave-full-screen", () => setFullscreenClass(false));
    // Re-apply on every navigation / reload so the class survives the
    // renderer re-mounting (e.g. after `Cmd+R`).
    win.webContents.on("did-finish-load", () => {
      if (win && !win.isDestroyed() && win.isFullScreen()) setFullscreenClass(true);
    });

    win.webContents.setWindowOpenHandler(({ url: target }) => {
      shell.openExternal(target).catch(() => {});
      return { action: "deny" };
    });

    // Meeting recording · Electron 30+ removed the legacy
    // `getUserMedia({chromeMediaSource:"desktop"})` constraint
    // (Chromium 124+ drops it), so the renderer now calls
    // `getDisplayMedia()` and this handler silently picks our own
    // BrowserWindow as the source · no OS picker, no extra
    // permission step beyond the one-time macOS "Screen Recording"
    // grant. Without this handler installed, getDisplayMedia would
    // either pop the native picker (web fallback) or reject. Safe
    // to register per window; defaultSession dedupes.
    try {
      // Defer entirely to macOS Sequoia's ScreenCaptureKit picker via
      // `useSystemPicker: true`. The silent auto-pick path via
      // `desktopCapturer.getSources` is unreliable on macOS 14+ /
      // Electron 41 even with Screen Recording granted (intermittent
      // "Failed to get sources" from a TCC/ScreenCaptureKit race).
      // The system picker is invoked by the OS itself, has no such
      // race, and lets the user pick the PrivateBoard window in one
      // click. Trade-off accepted: +1 click vs. unreliable recording.
      session.defaultSession.setDisplayMediaRequestHandler(
        (request, callback) => {
          process.stderr.write(
            `[electron] displayMedia request · video=${request.videoRequested}` +
            ` audio=${request.audioRequested} gesture=${request.userGesture} ·` +
            ` deferring to system picker\n`,
          );
          // Empty callback · with useSystemPicker:true Electron
          // shows the macOS native picker regardless of what we
          // return. Pass {} to signal "let the OS decide."
          callback({});
        },
        { useSystemPicker: true },
      );
    } catch (e) {
      process.stderr.write(`[electron] setDisplayMediaRequestHandler failed: ${e instanceof Error ? e.message : String(e)}\n`);
    }

    await win.loadURL(url);
  }

  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) {
      void createWindow(server.url);
    }
  });

  // macOS default · keep app + server alive when all windows close so the
  // user can re-open via Dock without re-running migrations + recoveries.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // Recording-aware quit guard · the renderer's BoardroomRecorder pushes
  // a state flag through `recorder:set-state` so the main process knows
  // whether a meeting capture is in progress. On `before-quit` while a
  // recording is running, we preventDefault + ping the renderer to show
  // its modal · the user confirms via `app:confirm-quit`, which clears
  // the flag and re-triggers `app.quit()`. The graceful shutdown path
  // below runs on the second `before-quit` pass once recordingActive is
  // false (or was never set).
  let recordingActive = false;
  let recordingQuitConfirmed = false;
  ipcMain.handle("recorder:set-state", (_e, active: unknown) => {
    recordingActive = !!active;
  });
  // Returns the BrowserWindow's media source id for the renderer's
  // `getUserMedia({video:{mandatory:{chromeMediaSource:"desktop",
  // chromeMediaSourceId}}})` call · the renderer captures only this
  // window's pixels (no picker, no other windows leak in).
  ipcMain.handle("recorder:get-source-id", (event) => {
    if (!win || win.isDestroyed()) return null;
    try { return win.webContents.getMediaSourceId(event.sender); }
    catch (e) {
      process.stderr.write(`[electron] getMediaSourceId failed: ${e instanceof Error ? e.message : String(e)}\n`);
      return null;
    }
  });
  // Renderer-initiated quit (after the recording-exit modal's "Stop
  // & quit" choice). Clears the recording guard so the next quit pass
  // proceeds to graceful shutdown.
  ipcMain.handle("app:confirm-quit", () => {
    recordingActive = false;
    recordingQuitConfirmed = true;
    app.quit();
  });

  // Graceful quit · intercept once, run async shutdown, then re-quit.
  // shutdownApp drains the server and forces a WAL checkpoint via closeDb.
  let quitting = false;
  app.on("before-quit", (e) => {
    // First pass · recording in progress and user hasn't confirmed.
    // Defer to the renderer's modal flow.
    if (recordingActive && !recordingQuitConfirmed && win && !win.isDestroyed()) {
      e.preventDefault();
      win.webContents.send("recorder:quit-requested");
      return;
    }
    if (quitting || !server) return;
    e.preventDefault();
    quitting = true;
    void shutdownApp(server).finally(() => {
      server = null;
      // Force-close every window with destroy() (NOT close()). The
      // renderer arms a `beforeunload` guard while an agent is
      // speaking / a recording is active (public/app.js) — close()
      // honours that guard and CANCELS the quit, so a single ⌘Q
      // appeared to do nothing and the user had to mash it. destroy()
      // skips beforeunload entirely; data integrity is already
      // covered because shutdownApp() ran (server drained + WAL
      // checkpointed) before we get here.
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.destroy();
      }
      app.quit();
    });
  });

  // OS-level signals · Electron's defaults swallow SIGTERM / SIGHUP without
  // running `before-quit`, which would leak the in-flight WAL writes on
  // logout / shutdown / Activity-Monitor "Quit Process". Route them through
  // `app.quit()` so the same shutdown chain fires.
  const onSignal = (signal: string) => {
    process.stderr.write(`[electron] ${signal} received\n`);
    app.quit();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGHUP", () => onSignal("SIGHUP"));
  // Last-resort sync flush · runs even if signal handlers were bypassed
  // (uncaughtException, parent SIGKILL of the helper, etc.). closeDb is
  // idempotent — if shutdownApp already ran it's a no-op.
  process.on("exit", () => {
    try { closeDb(); } catch { /* */ }
  });

  /* ─── Auto-update · electron-updater + GitHub Releases ───────────
     The packaged .app pulls `latest-mac.yml` from this repo's GitHub
     Releases (configured in package.json `build.publish`). The flow is
     consent-driven: on launch we check for a new version and, if one
     exists, push an `updater:state` event to the renderer; the
     renderer shows the PrivateBoard-styled modal (`public/app-
     updater.js`) and only after the user clicks "现在更新" do we call
     `autoUpdater.downloadUpdate()`. Progress + ready states are
     forwarded as further `updater:state` events so the renderer can
     paint the progress bar and restart prompt.

     `updaterState` mirrors whatever the renderer should be showing.
     We also expose it via `updater:get-state` so a late-mounted
     renderer (refresh, devtools reload) can re-hydrate the modal
     without missing the original `update-available` event. Re-checks
     run every 4 hours; if the user dismissed the prompt last time the
     next check re-broadcasts and the modal re-opens.

     Dev path · `npx electron .` (unpackaged) sets `app.isPackaged =
     false` and we early-out so the updater doesn't try to read a
     non-existent `app-update.yml` and log noisy errors. */
  type UpdaterState =
    | { kind: "idle" }
    | { kind: "available"; version: string }
    | {
        kind: "downloading";
        version: string;
        percent: number;
        transferred: number;
        total: number;
        bytesPerSecond: number;
      }
    | { kind: "ready"; version: string }
    | { kind: "error"; message: string };

  let updaterState: UpdaterState = { kind: "idle" };

  function broadcastUpdaterState(): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("updater:state", updaterState);
    }
  }

  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("updater:get-state", () => updaterState);
  ipcMain.handle("updater:start-download", () => {
    if (updaterState.kind !== "available") return false;
    autoUpdater.downloadUpdate().catch((err: Error) => {
      console.error("[autoUpdater] downloadUpdate failed:", err);
      updaterState = { kind: "error", message: err.message };
      broadcastUpdaterState();
    });
    return true;
  });
  ipcMain.handle("updater:install-now", () => {
    if (updaterState.kind !== "ready") return false;
    // `quitAndInstall(isSilent, isForceRunAfter)` · second arg true
    // re-launches the app after the install completes so the user
    // doesn't have to find / click the dock icon again.
    autoUpdater.quitAndInstall(false, true);
    return true;
  });
  ipcMain.handle("updater:dismiss", () => {
    // Renderer just hides the UI; we keep `updaterState` so the
    // user can reopen if they change their mind. The 4-hour
    // re-check will also re-broadcast.
    return true;
  });

  function startAutoUpdater(): void {
    if (!app.isPackaged) return;
    // Consent-driven: never auto-download, never auto-install. The
    // renderer's modal gates both steps.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    // electron-updater accepts any console-like logger; bypass the
    // strict `Logger | null` type with a cast so `console` lands as
    // the active sink.
    (autoUpdater as unknown as { logger: unknown }).logger = console;

    autoUpdater.on("error", (err: Error) => {
      console.error("[autoUpdater]", err);
      updaterState = { kind: "error", message: err.message };
      broadcastUpdaterState();
    });
    autoUpdater.on("checking-for-update", () => {
      console.log("[autoUpdater] checking …");
    });
    autoUpdater.on("update-available", (info: { version?: string }) => {
      console.log(`[autoUpdater] update available · v${info.version}`);
      updaterState = { kind: "available", version: info.version ?? "" };
      broadcastUpdaterState();
    });
    autoUpdater.on("update-not-available", () => {
      console.log("[autoUpdater] up to date");
      // Only clear state if we weren't mid-download/ready — a late
      // re-check during a download shouldn't wipe the progress UI.
      if (updaterState.kind === "idle" || updaterState.kind === "available") {
        updaterState = { kind: "idle" };
        broadcastUpdaterState();
      }
    });
    autoUpdater.on(
      "download-progress",
      (p: { percent: number; transferred: number; total: number; bytesPerSecond: number }) => {
        const version =
          updaterState.kind === "downloading" || updaterState.kind === "available"
            ? updaterState.version
            : "";
        updaterState = {
          kind: "downloading",
          version,
          percent: p.percent,
          transferred: p.transferred,
          total: p.total,
          bytesPerSecond: p.bytesPerSecond,
        };
        broadcastUpdaterState();
      },
    );
    autoUpdater.on("update-downloaded", (info: { version?: string }) => {
      updaterState = { kind: "ready", version: info.version ?? "" };
      broadcastUpdaterState();
    });

    const kick = () => {
      // `checkForUpdates` (not `…AndNotify`) — the renderer owns the
      // user-facing prompt now, the native notification path is gone.
      autoUpdater.checkForUpdates().catch((err: Error) => {
        console.error("[autoUpdater] check failed:", err);
      });
    };
    // First check 3s after window boots; then every 4 hours while
    // the app stays open. The interval handler runs even if the
    // first check failed (transient network blip recovers automatically).
    setTimeout(kick, 3_000);
    setInterval(kick, 4 * 60 * 60 * 1000);
  }

  void app.whenReady().then(async () => {
    try {
      const result = await bootApp({ host: "127.0.0.1" });
      server = result.server;
      buildAppMenu(result.dirs.base);
      await createWindow(result.server.url);
      startAutoUpdater();
    } catch (err) {
      // bootApp may have started the server before a later step (createWindow,
      // menu build) threw. `app.exit` skips `before-quit`, so without an
      // explicit shutdown the listening socket survives as a zombie that
      // collides with the NEXT launch's `findFreePort(3030)` — the new
      // process picks 3031, but the orphan still holds 3030 and the renderer
      // ends up loading a port whose server isn't actually serving requests.
      // The same chain leaves the SQLite WAL uncheckpointed.
      console.error("[electron] boot failed:", err);
      try {
        await shutdownApp(server);
      } catch (shutdownErr) {
        console.error("[electron] shutdown after boot failure also failed:", shutdownErr);
      }
      server = null;
      app.exit(1);
    }
  });
}
