"use strict";
/**
 * Preload — the only bridge between the (sandboxed) UI and the main process.
 * Exposes a small, explicit `window.api` so the renderer can call backend
 * actions without any Node/Electron access of its own.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getVersion: () => ipcRenderer.invoke("app:version"),
  detectEnv: () => ipcRenderer.invoke("env:detect"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (patch) => ipcRenderer.invoke("config:save", patch),
  start: () => ipcRenderer.invoke("pipeline:start"),
  stop: () => ipcRenderer.invoke("pipeline:stop"),
  isRunning: () => ipcRenderer.invoke("pipeline:running"),
  attachDongle: () => ipcRenderer.invoke("dongle:attach"),
  listDongles: () => ipcRenderer.invoke("dongle:list"),
  sweep: (startMHz, endMHz, gain) => ipcRenderer.invoke("tuner:sweep", { startMHz, endMHz, gain }),
  talkgroupReport: () => ipcRenderer.invoke("report:talkgroups"),
  saveDiagnostics: () => ipcRenderer.invoke("diag:save"),
  getStatus: () => ipcRenderer.invoke("status:get"),
  recentLog: (lines) => ipcRenderer.invoke("log:recent", lines),
  openSafeT: () => ipcRenderer.invoke("safet:open"),
  getAutoStart: () => ipcRenderer.invoke("autostart:get"),
  setAutoStart: (enabled) => ipcRenderer.invoke("autostart:set", enabled),
  onLog: (cb) => {
    const listener = (_e, line) => cb(line);
    ipcRenderer.on("pipeline-log", listener);
    return () => ipcRenderer.removeListener("pipeline-log", listener);
  },
});
