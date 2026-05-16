/**
 * Renderer preload · context-isolated bridge.
 *
 * v0 exposes a thin info-only surface; the renderer already talks to the
 * server over HTTP for every real action, so there's nothing to bridge
 * yet. Future native features (file dialogs, system notifications,
 * deep-link handling) hang off this same `privateboard` object.
 */
import { contextBridge, ipcRenderer } from "electron";

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
