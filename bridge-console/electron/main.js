"use strict";

// safeT Bridge — a dedicated, unattended Windows desktop app whose only job is
// to run safeT PTT radio bridges (line-in capture → channel, plus optional
// bidirectional channel monitoring) from the machine physically wired to an
// external radio or scanner.
//
// Why a separate app instead of the web console: the web console is *served by*
// the dispatch server, so when the server redeploys (e.g. a Railway push) the
// page itself reloads and its JS context — including the live voice socket — is
// torn down, which is exactly the "cannot connect to channel / restart the
// audio button" symptom operators hit. safeT Bridge loads its UI *locally*
// (file://), so a server reboot only drops the WebSocket, which the renderer
// reconnects on its own with backoff. The app, its settings, and its run-intent
// survive server reboots, power cycles, and network blips untouched.

const { app, BrowserWindow, Menu, session, shell, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
const CREDENTIALS_PATH = path.join(app.getPath("userData"), "credentials.bin");
const RENDERER_INDEX = path.join(__dirname, "..", "dist", "index.html");

let mainWindow = null;

/** Default persisted config; merged over whatever is on disk. */
const DEFAULT_CONFIG = {
  /** Dispatch server origin — fixed; the bridge box never needs to be told. */
  serverUrl: "https://safet-ptt.com",
  /** Launch the app automatically when Windows signs in (unattended recovery). */
  autoLaunch: true,
  /** Per-bridge device + VOX + gain + run-intent, keyed by bridge id. */
  bridges: {},
};

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { ...DEFAULT_CONFIG, ...parsed, bridges: { ...(parsed.bridges || {}) } };
  } catch {
    return { ...DEFAULT_CONFIG, bridges: {} };
  }
}

function writeConfig(config) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error("safeT Bridge: failed to persist config", error);
    return false;
  }
}

// --- Secure credential storage ------------------------------------------------
// An unattended bridge box must re-authenticate after a reboot with no operator
// present, so it has to remember its login. Credentials are encrypted at rest
// with the OS keychain (DPAPI on Windows) via Electron's safeStorage, never
// stored in plaintext. The renderer only ever receives the decrypted secret on
// an explicit IPC request and never persists it itself.

function saveCredentials(creds) {
  try {
    const json = JSON.stringify(creds);
    const blob = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json)
      : Buffer.from("plain:" + json, "utf8"); // last-resort fallback if DPAPI is unavailable
    fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true });
    fs.writeFileSync(CREDENTIALS_PATH, blob);
    return true;
  } catch (error) {
    console.error("safeT Bridge: failed to store credentials", error);
    return false;
  }
}

function loadCredentials() {
  try {
    const blob = fs.readFileSync(CREDENTIALS_PATH);
    const head = blob.subarray(0, 6).toString("utf8");
    if (head === "plain:") {
      return JSON.parse(blob.subarray(6).toString("utf8"));
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return null;
    }
    return JSON.parse(safeStorage.decryptString(blob));
  } catch {
    return null;
  }
}

function clearCredentials() {
  try {
    fs.rmSync(CREDENTIALS_PATH, { force: true });
  } catch {
    /* nothing to remove */
  }
}

/** Mirror the persisted autoLaunch flag into the OS login-items registry. */
function applyAutoLaunch(enabled) {
  // No-op in dev (unpackaged) — setLoginItemSettings would point at the Electron
  // binary, not the installed app. electron-builder's NSIS installer registers
  // the launch entry for production builds.
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: ["--autostart"] });
  } catch (error) {
    console.error("safeT Bridge: failed to set login item", error);
  }
}

// Only the local renderer (file://) may use the microphone — it is the bridge
// capture path. Audio-only requests from our own page are allowed; everything
// else (video, remote origins) is denied.
function configurePermissions() {
  const ses = session.defaultSession;
  const isLocal = (url) => typeof url === "string" && url.startsWith("file:");
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission !== "media") {
      callback(false);
      return;
    }
    const mediaTypes = (details && details.mediaTypes) || [];
    const audioOnly = mediaTypes.length === 0 || mediaTypes.every((t) => t === "audio");
    callback(audioOnly && isLocal(details && details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (permission !== "media") return false;
    if (details && details.mediaType === "video") return false;
    return isLocal(requestingOrigin) || requestingOrigin === "file://";
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: "#0B1220",
    title: "safeT Bridge",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // The renderer captures the mic and decodes audio in the background; keep
      // it running full-tilt even when the window is minimized to the tray/taskbar
      // on an unattended box.
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // The UI is local; never let it navigate away from the bundled file.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file:")) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // If the renderer crashes, reload the local UI so the box self-heals; the
  // renderer re-reads its run-intent and resumes any bridges that were running.
  mainWindow.webContents.on("render-process-gone", () => {
    if (mainWindow) mainWindow.loadFile(RENDERER_INDEX);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadFile(RENDERER_INDEX);
}

// --- IPC: renderer ↔ main -----------------------------------------------------
ipcMain.handle("config:get", () => readConfig());
ipcMain.handle("config:set", (_event, config) => {
  const safe = { ...DEFAULT_CONFIG, ...config, bridges: { ...(config && config.bridges) } };
  const ok = writeConfig(safe);
  applyAutoLaunch(safe.autoLaunch);
  return ok;
});
ipcMain.handle("credentials:save", (_event, creds) => saveCredentials(creds));
ipcMain.handle("credentials:load", () => loadCredentials());
ipcMain.handle("credentials:clear", () => {
  clearCredentials();
  return true;
});
ipcMain.handle("app:get-version", () => app.getVersion());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    configurePermissions();
    buildMenu();
    applyAutoLaunch(readConfig().autoLaunch);
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
