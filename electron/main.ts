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
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, shell } from "electron";
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
  const TRAFFIC_LIGHT_POSITION = { x: 21, y: 22 };

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

    win.webContents.setWindowOpenHandler(({ url: target }) => {
      shell.openExternal(target).catch(() => {});
      return { action: "deny" };
    });

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

  // Graceful quit · intercept once, run async shutdown, then re-quit.
  // shutdownApp drains the server and forces a WAL checkpoint via closeDb.
  let quitting = false;
  app.on("before-quit", (e) => {
    if (quitting || !server) return;
    e.preventDefault();
    quitting = true;
    void shutdownApp(server).finally(() => {
      server = null;
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

  void app.whenReady().then(async () => {
    try {
      const result = await bootApp({ host: "127.0.0.1" });
      server = result.server;
      buildAppMenu(result.dirs.base);
      await createWindow(result.server.url);
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
