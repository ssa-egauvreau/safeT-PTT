"use strict";

// safeT Command — native desktop shell for the safeT PTT dispatch console.
// The Node server already builds and serves the web console with client-side
// routing, so this app simply points a hardened Electron window at that origin.
// The server address is configurable at runtime (env var or stored on the box).

const { app, BrowserWindow, Menu, session, shell, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
const FALLBACK_PAGE = path.join(__dirname, "fallback.html");

let mainWindow = null;
/** Currently configured dispatch server origin, or "" when not yet set. */
let dispatchUrl = "";
/** Drives what the bundled fallback page renders: { mode, url, error }. */
let viewState = { mode: "setup", url: "", error: "" };

function readStoredUrl() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return typeof parsed.dispatchUrl === "string" ? parsed.dispatchUrl : "";
  } catch {
    return "";
  }
}

function storeUrl(url) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ dispatchUrl: url }, null, 2));
  } catch (error) {
    console.error("Failed to persist dispatch URL", error);
  }
}

/** Accepts "host", "host:port" or a full URL; returns a clean origin or "". */
function normalizeUrl(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function resolveInitialUrl() {
  return normalizeUrl(process.env.RADIO_DISPATCH_URL) || normalizeUrl(readStoredUrl());
}

function dispatchOrigin() {
  try {
    return new URL(dispatchUrl).origin;
  } catch {
    return "";
  }
}

/** True when `url` belongs to the configured dispatch origin. */
function isDispatchUrl(url) {
  const origin = dispatchOrigin();
  if (!origin || !url) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function loadConsole() {
  if (!mainWindow) return;
  if (!dispatchUrl) {
    showFallback("setup");
    return;
  }
  viewState = { mode: "console", url: dispatchUrl, error: "" };
  mainWindow.loadURL(dispatchUrl);
}

function showFallback(mode, error) {
  if (!mainWindow) return;
  viewState = { mode, url: dispatchUrl, error: error || "" };
  mainWindow.loadFile(FALLBACK_PAGE);
}

// Only the live dispatch origin may use the microphone (voice transmit).
// "media" is broader than the mic, so audio-only requests are required and
// the requesting frame's origin (not the top-level page) is what's checked.
function configurePermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    if (permission !== "media") {
      callback(false);
      return;
    }
    const mediaTypes = (details && details.mediaTypes) || [];
    const audioOnly = mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
    callback(audioOnly && isDispatchUrl(details && details.requestingUrl));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (permission !== "media") return false;
    if (details && details.mediaType === "video") return false;
    return isDispatchUrl(requestingOrigin);
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
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Dispatch",
      submenu: [
        { label: "Reconnect", click: () => loadConsole() },
        { label: "Change Dispatch Server…", click: () => showFallback("setup") },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#0B1220",
    title: "safeT Command",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // External links open in the OS browser, never inside the console shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Block in-window navigation away from the dispatch console (links,
  // window.location); off-origin targets are handed to the OS browser.
  const guardNavigation = (event, url) => {
    if (isDispatchUrl(url) || (url || "").startsWith("file:")) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url || "")) {
      shell.openExternal(url);
    }
  };
  mainWindow.webContents.on("will-navigate", guardNavigation);
  mainWindow.webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return; // main frame is covered by will-navigate
    guardNavigation(details, details.url);
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (errorCode === -3) return; // ERR_ABORTED — fires during normal navigation
      showFallback("error", errorDescription || `Could not reach ${validatedURL}`);
    },
  );

  mainWindow.webContents.on("render-process-gone", () => {
    showFallback("error", "The dispatch console stopped responding.");
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  loadConsole();
}

ipcMain.handle("dispatch:get-state", () => viewState);

ipcMain.handle("dispatch:save-url", (_event, url) => {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    return { ok: false, error: "Enter a valid http(s) address." };
  }
  dispatchUrl = normalized;
  storeUrl(normalized);
  loadConsole();
  return { ok: true };
});

ipcMain.on("dispatch:retry", () => loadConsole());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    dispatchUrl = resolveInitialUrl();
    configurePermissions();
    buildMenu();
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
