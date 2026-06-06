// Typed access to the preload-exposed host bridge (config + secure credentials).
//
// When the renderer runs inside Electron, `window.bridgeHost` is provided by
// preload.js. When it runs in a plain browser (e.g. `vite dev` for UI work), we
// fall back to a localStorage-backed shim so the UI is still exercisable —
// credentials are NOT encrypted in that mode, which is fine for dev only.

import type { BridgeConfig, BridgeHost, StoredCredentials } from "./types";

const DEFAULT_CONFIG: BridgeConfig = {
  serverUrl: "https://safet-ptt.com",
  autoLaunch: true,
  bridges: {},
};

const CONFIG_KEY = "safetBridge.config";
const CREDS_KEY = "safetBridge.credentials";

const browserFallback: BridgeHost = {
  async getConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  },
  async setConfig(config) {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      return true;
    } catch {
      return false;
    }
  },
  async saveCredentials(creds) {
    try {
      localStorage.setItem(CREDS_KEY, JSON.stringify(creds));
      return true;
    } catch {
      return false;
    }
  },
  async loadCredentials() {
    try {
      const raw = localStorage.getItem(CREDS_KEY);
      return raw ? (JSON.parse(raw) as StoredCredentials) : null;
    } catch {
      return null;
    }
  },
  async clearCredentials() {
    localStorage.removeItem(CREDS_KEY);
    return true;
  },
  async getVersion() {
    return "dev";
  },
};

declare global {
  interface Window {
    bridgeHost?: BridgeHost;
    safetDesktop?: boolean;
  }
}

export const host: BridgeHost = window.bridgeHost ?? browserFallback;

/** True when running inside the Electron shell (vs. a plain dev browser). */
export const isDesktop = Boolean(window.bridgeHost);
