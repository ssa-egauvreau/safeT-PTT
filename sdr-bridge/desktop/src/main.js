"use strict";
/**
 * SafeT SDR — Electron main process.
 *
 * Owns the window + tray and wires the renderer (the UI) to the orchestrator
 * (all the WSL/usbipd/pipeline plumbing) over IPC. The renderer never touches
 * Node or the shell directly — it only calls the safe `window.api` surface
 * defined in preload.js, which forwards to the handlers registered here.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const orch = require("./orchestrator");

// electron-updater is optional at runtime: in a dev run (`npm start`) the
// dependency may be absent and auto-update is a no-op anyway (only installed
// builds can self-update). Guarded so a missing module never crashes boot.
let autoUpdater = null;
try {
  ({ autoUpdater } = require("electron-updater"));
} catch {
  /* updates disabled (dev / not installed) */
}

const startedHidden = process.argv.includes("--hidden");
const ICON_PATH = path.join(__dirname, "icon.png");
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
    icon: ICON_PATH,
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

  // Watchdog / status notifications -> native Windows toasts.
  orch.setNotifier((title, body) => {
    if (Notification.isSupported()) new Notification({ title, body, icon: ICON_PATH }).show();
  });
}

function createTray() {
  let img = nativeImage.createFromPath(ICON_PATH);
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
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

// ---- auto-update (electron-updater + GitHub Releases) --------------------
// Silent background download; installs on the next quit. The updater is fail-
// safe: an unreachable feed just emits 'error' and the app keeps running on its
// current version. Only ever active in an installed (packaged) build.
function setupAutoUpdate() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const send = (state, extra) => {
    if (win && !win.isDestroyed()) win.webContents.send("update-status", { state, ...extra });
  };
  autoUpdater.on("checking-for-update", () => send("checking"));
  autoUpdater.on("update-available", (info) => send("available", { version: info && info.version }));
  autoUpdater.on("update-not-available", () => send("none"));
  autoUpdater.on("download-progress", (p) => send("downloading", { percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on("error", (err) => send("error", { message: String((err && err.message) || err) }));
  autoUpdater.on("update-downloaded", (info) => {
    send("ready", { version: info && info.version });
    if (Notification.isSupported())
      new Notification({
        title: "SafeT SDR update ready",
        body: `v${info && info.version} installs when you quit. Reopen SafeT SDR to restart now.`,
        icon: ICON_PATH,
      }).show();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check(); // once at boot
  const t = setInterval(check, 6 * 60 * 60 * 1000); // and every 6h (long-running tray app)
  t.unref?.();
}

// ---- IPC: thin pass-through to the orchestrator --------------------------

function register() {
  const handlers = {
    "app:version": () => app.getVersion(),
    "env:detect": () => orch.detectEnvironment(),
    "settings:get": () => orch.getSettings(),
    "settings:save": (_e, patch) => orch.saveSettings(patch),
    "config:get": () => orch.readConfig(),
    "config:save": (_e, patch) => orch.writeConfig(patch),
    "pipeline:start": () => orch.startPipeline(),
    "pipeline:stop": () => orch.stopPipeline(),
    "pipeline:running": () => orch.pipelineRunning(),
    "dongle:attach": () => orch.attachDongle(),
    "dongle:list": () => orch.listDongles(),
    "tuner:sweep": (_e, a) => orch.runSweep(a.startMHz, a.endMHz, a.gain),
    "report:talkgroups": () => orch.talkgroupReport(),
    "diag:save": async () => {
      const text = await orch.collectDiagnostics();
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const def = path.join(app.getPath("desktop"), `safet-sdr-diagnostics-${ts}.txt`);
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: def,
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      fs.writeFileSync(filePath, text, "utf8");
      shell.showItemInFolder(filePath);
      return { ok: true, path: filePath };
    },
    "status:get": () => orch.getStatus(),
    "log:recent": (_e, lines) => orch.recentDecoderLog(lines),
    "safet:open": () => orch.openSafeT(),
    "autostart:get": () => orch.getAutoStart(),
    "autostart:set": (_e, enabled) => orch.setAutoStart(enabled),
    "update:check": () => {
      if (autoUpdater && app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
      return { ok: !!(autoUpdater && app.isPackaged) };
    },
    "update:install": () => {
      // Set isQuitting first or the window 'close' handler hides to tray and the
      // relaunch never happens.
      isQuitting = true;
      if (autoUpdater) setImmediate(() => autoUpdater.quitAndInstall());
      return { ok: !!autoUpdater };
    },
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
    // Required on Windows for toast notifications to display (must match appId).
    app.setAppUserModelId("com.sunsetsafety.safetsdr");
    register();
    createWindow();
    createTray();
    orch.startWatchdog();
    setupAutoUpdate();

    // Launched at login (hidden) -> start streaming on its own. The dongle was
    // already attached by the login scheduled task, so no UAC prompt here.
    if (startedHidden) {
      setTimeout(() => orch.startPipeline({ quiet: true }).catch(() => {}), 6000);
    }

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
