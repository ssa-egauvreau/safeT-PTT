"use strict";
/**
 * SafeT SDR — Electron main process.
 *
 * Owns the window + tray and wires the renderer (the UI) to the orchestrator
 * (all the WSL/usbipd/pipeline plumbing) over IPC. The renderer never touches
 * Node or the shell directly — it only calls the safe `window.api` surface
 * defined in preload.js, which forwards to the handlers registered here.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require("electron");
const path = require("node:path");
const orch = require("./orchestrator");

const startedHidden = process.argv.includes("--hidden");
let win = null;
let tray = null;
let isQuitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    title: "SafeT SDR",
    backgroundColor: "#0f1419",
    autoHideMenuBar: true,
    show: !startedHidden,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Closing hides to tray (so auto-started/background runs keep streaming).
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Stream pipeline log lines to the renderer as they arrive.
  orch.setLogSink((line) => {
    if (win && !win.isDestroyed()) win.webContents.send("pipeline-log", line);
  });
}

function createTray() {
  // A 1x1 transparent fallback so the app still works without a packaged icon.
  const img = nativeImage.createEmpty();
  try {
    tray = new Tray(img);
  } catch {
    return;
  }
  const menu = Menu.buildFromTemplate([
    { label: "Open SafeT SDR", click: () => showWindow() },
    { label: "Open SafeT console", click: () => orch.openSafeT() },
    { type: "separator" },
    {
      label: "Quit (stops streaming)",
      click: async () => {
        isQuitting = true;
        try {
          await orch.stopPipeline({ detach: true });
        } catch {
          /* ignore */
        }
        app.quit();
      },
    },
  ]);
  tray.setToolTip("SafeT SDR");
  tray.setContextMenu(menu);
  tray.on("click", () => showWindow());
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

// ---- IPC: thin pass-through to the orchestrator --------------------------

function register() {
  const handlers = {
    "env:detect": () => orch.detectEnvironment(),
    "settings:get": () => orch.getSettings(),
    "settings:save": (_e, patch) => orch.saveSettings(patch),
    "config:get": () => orch.readConfig(),
    "config:save": (_e, patch) => orch.writeConfig(patch),
    "pipeline:start": () => orch.startPipeline(),
    "pipeline:stop": () => orch.stopPipeline({ detach: true }),
    "pipeline:running": () => orch.pipelineRunning(),
    "dongle:attach": () => orch.attachDongle(),
    "status:get": () => orch.getStatus(),
    "log:recent": (_e, lines) => orch.recentDecoderLog(lines),
    "safet:open": () => orch.openSafeT(),
    "autostart:get": () => orch.getAutoStart(),
    "autostart:set": (_e, enabled) => orch.setAutoStart(enabled),
  };
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, fn);
  }
}

// Single-instance: focus the existing window instead of opening a second.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    register();
    createWindow();
    createTray();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Keep running in the tray when all windows are closed.
  app.on("window-all-closed", (e) => {
    e.preventDefault();
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });
}
