/**
 * Renderer preload · context-isolated bridge.
 *
 * v0 exposes a thin info-only surface; the renderer already talks to the
 * server over HTTP for every real action, so there's nothing to bridge
 * yet. Future native features (file dialogs, system notifications,
 * deep-link handling) hang off this same `privateboard` object.
 */
import { contextBridge, ipcRenderer } from "electron";

// Mirrors the `UpdaterState` discriminated union in electron/main.ts.
// Kept inline (not imported) because preload runs sandboxed — it can
// only depend on Electron's preload-safe API and Node primitives, no
// reach into the rest of the codebase.
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

contextBridge.exposeInMainWorld("privateboard", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  // Reserved hooks · main process can add `ipcMain.handle("…")` listeners
  // later and the renderer will invoke them via these helpers.
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  // Sidebar visibility drives the macOS traffic lights (Arc-style). The
  // renderer wraps this with platform + state guards in
  // `syncElectronTrafficLights`.
  setTrafficLightsVisible: (visible: boolean) =>
    ipcRenderer.invoke("window:set-traffic-lights", visible),
  // App appearance follows the renderer's theme picker. Pushing the user
  // pref (not the resolved value) lets macOS keep tracking the system
  // accent when the user selects "system". Drives macOS window vibrancy
  // tone so the frosted blur matches the app's light / dark surfaces.
  setThemeSource: (theme: "light" | "dark" | "system") =>
    ipcRenderer.invoke("window:set-theme-source", theme),
  // App version · resolved from the packaged bundle's package.json
  // via `app.getVersion()` in main. Used by the auto-updater modal to
  // render the "current → new" version delta.
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:get-version"),
  // Auto-updater bridge · main process owns `electron-updater` and
  // pushes every state transition (available / downloading / ready /
  // error) over the `updater:state` channel. Renderer subscribes via
  // `onState`; the returned function unsubscribes. `getState` lets a
  // late-mounted renderer rehydrate without missing the initial event.
  updater: {
    onState: (cb: (s: UpdaterState) => void) => {
      const listener = (_e: unknown, s: UpdaterState) => cb(s);
      ipcRenderer.on("updater:state", listener);
      return () => ipcRenderer.removeListener("updater:state", listener);
    },
    getState: (): Promise<UpdaterState> => ipcRenderer.invoke("updater:get-state"),
    startDownload: (): Promise<boolean> => ipcRenderer.invoke("updater:start-download"),
    installNow: (): Promise<boolean> => ipcRenderer.invoke("updater:install-now"),
    dismiss: (): Promise<boolean> => ipcRenderer.invoke("updater:dismiss"),
  },
});

// Native menu → renderer one-way push. The menu handlers in
// `electron/menu.ts` call `webContents.send("menu:*")`; we rebroadcast
// each as a DOM CustomEvent (`boardroom:menu-*`) so the renderer can
// listen without touching `ipcRenderer` directly. Keeps the context
// isolation boundary clean and matches the project's existing
// `boardroom:*` DOM event convention.
ipcRenderer.on("menu:new-room", () => {
  window.dispatchEvent(new CustomEvent("boardroom:menu-new-room"));
});
ipcRenderer.on("menu:toggle-sidebar", () => {
  window.dispatchEvent(new CustomEvent("boardroom:menu-toggle-sidebar"));
});
