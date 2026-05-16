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
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions, shell } from "electron";

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
