"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Report this client's platform to the relay as "desktop" (same flag the
// dispatch console shell sets), so rosters distinguish a desktop bridge box.
contextBridge.exposeInMainWorld("safetDesktop", true);

// Narrow, audited surface the renderer uses to persist config + credentials and
// query the host. No Node, no fs, no arbitrary IPC — only these calls.
contextBridge.exposeInMainWorld("bridgeHost", {
  /** Read the persisted config (server URL, autoLaunch, per-bridge settings). */
  getConfig: () => ipcRenderer.invoke("config:get"),
  /** Persist the full config object. */
  setConfig: (config) => ipcRenderer.invoke("config:set", config),
  /** Encrypt + store login credentials at rest (OS keychain / DPAPI). */
  saveCredentials: (creds) => ipcRenderer.invoke("credentials:save", creds),
  /** Decrypt + return stored credentials, or null if none/unavailable. */
  loadCredentials: () => ipcRenderer.invoke("credentials:load"),
  /** Forget stored credentials (operator signs out). */
  clearCredentials: () => ipcRenderer.invoke("credentials:clear"),
  /** App version string for the footer. */
  getVersion: () => ipcRenderer.invoke("app:get-version"),
});
