/**
 * macOS native menu bar for PrivateBoard desktop.
 *
 * Five columns · trimmed from the boilerplate Electron template down to
 * just what's useful for this product:
 *   - **App menu** (PrivateBoard) · About / Hide / Quit. Standard macOS
 *     conventions, required for ⌘Q discoverability.
 *   - **File** · "New Room" (⌘N). Forwards via IPC `menu:new-room` →
 *     the renderer clears the route hash, landing on the new-room
 *     composer (the same destination the in-app "New room" entry hits).
 *   - **Edit** · Cut / Copy / Paste / Select All. Looks like dead
 *     scaffolding, BUT on macOS these role-based items are how the OS
 *     wires ⌘C / ⌘V / ⌘X / ⌘A to the focused webContents — without
 *     the menu, those accelerators silently don't fire in text inputs.
 *     Removed once already; ⌘A regressed in the renderer's textareas.
 *   - **View** · Reload / Toggle DevTools / Toggle Sidebar (⌘\). The
 *     last one fires IPC `menu:toggle-sidebar`; the renderer synthesises
 *     a click on `[data-sidebar-collapse]`, reusing the existing toggle
 *     handler.
 *   - **Help** · Show State Directory · Visit GitHub · Report an Issue.
 *
 * Window / Zoom / Undo / Redo dropped: ⌘M / ⌘W still fire via Chromium
 * defaults; nothing in the app is undoable in the OS sense.
 */
import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions, shell } from "electron";
// CJS module · see electron/main.ts for the rationale on the
// default-import + destructure dance.
import electronUpdaterPkg from "electron-updater";
const { autoUpdater } = electronUpdaterPkg;

import { VERSION } from "../dist/version.js";

const REPO_URL = "https://github.com/kaysaith1900/privateboard";

function sendToFocusedWindow(channel: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(channel);
}

export function buildAppMenu(stateDir: string): void {
  app.setAboutPanelOptions({
    applicationName: "PrivateBoard",
    applicationVersion: VERSION,
    copyright: "MIT licensed · local-first multi-agent thinking",
    credits: "Your private board meeting, on call.",
  });

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        // Manual update check · sits in the standard macOS "App ›
        // Check for Updates …" slot. autoUpdater also runs a passive
        // check on launch + every 4 h (see electron/main.ts
        // startAutoUpdater), so this item is the explicit "I'd like
        // to know now" path. Disabled in dev (unpackaged Electron has
        // no `app-update.yml` to read).
        {
          label: "Check for Updates…",
          enabled: app.isPackaged,
          click: async () => {
            const parent = BrowserWindow.getFocusedWindow() ?? undefined;
            try {
              const result = await autoUpdater.checkForUpdates();
              if (!result || !result.updateInfo || result.updateInfo.version === app.getVersion()) {
                dialog.showMessageBox(parent ?? undefined as unknown as BrowserWindow, {
                  type: "info",
                  title: "PrivateBoard",
                  message: "已是最新版本",
                  detail: `当前 v${app.getVersion()}`,
                });
              }
              // If a newer version exists, electron-updater fires
              // `update-available` → `update-downloaded` and the
              // restart-now dialog from startAutoUpdater handles the
              // rest. No need to re-show progress here.
            } catch (err) {
              dialog.showMessageBox(parent ?? undefined as unknown as BrowserWindow, {
                type: "error",
                title: "无法检查更新",
                message: "请稍后再试",
                detail: String(err instanceof Error ? err.message : err),
              });
            }
          },
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "New Room",
          accelerator: "CmdOrCtrl+N",
          click: () => sendToFocusedWindow("menu:new-room"),
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+\\",
          click: () => sendToFocusedWindow("menu:toggle-sidebar"),
        },
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Open Developer Console",
          accelerator: "CmdOrCtrl+Alt+I",
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (!win) return;
            // Detach so the inspector pops as its own window and
            // doesn't squeeze the main app layout. `toggleDevTools`
            // would close an already-open detached panel; explicit
            // open keeps the affordance idempotent for the menu.
            if (win.webContents.isDevToolsOpened()) {
              win.webContents.closeDevTools();
            } else {
              win.webContents.openDevTools({ mode: "detach" });
            }
          },
        },
        { type: "separator" },
        {
          label: "Show State Directory in Finder",
          click: () => {
            shell.showItemInFolder(stateDir);
          },
        },
        { type: "separator" },
        {
          label: "Visit GitHub Repository",
          click: () => {
            shell.openExternal(REPO_URL).catch(() => {});
          },
        },
        {
          label: "Report an Issue",
          click: () => {
            shell.openExternal(`${REPO_URL}/issues`).catch(() => {});
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export function focusedWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow();
}
