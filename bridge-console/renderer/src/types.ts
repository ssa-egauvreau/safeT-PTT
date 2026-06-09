// Shared types for the safeT Bridge renderer.

/** A runnable audio-device bridge as returned by GET /v1/bridges/runnable. */
export interface Bridge {
  id: number;
  name: string;
  source_type: string;
  device_hint: string | null;
  target_channel: string;
  /** "bidirectional" plays channel audio back out; anything else is inbound-only. */
  direction: string;
  yield_to_units: boolean;
  vox_threshold: number;
  vox_hang_ms: number;
  enabled: boolean;
}

/** The minimal session user fields the bridge box cares about. */
export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: string;
  agencyName: string | null;
}

/** Per-bridge operator overrides + run-intent, persisted on the box. */
export interface BridgeSettings {
  inputDeviceId?: string;
  outputDeviceId?: string;
  /** VOX trigger level 0–1; falls back to the bridge's server config when unset. */
  voxThreshold?: number;
  /** VOX hang time in ms; falls back to the bridge's server config when unset. */
  voxHangMs?: number;
  /** Linear input gain applied to captured PCM before VOX + send (1 = unity). */
  gain?: number;
  /** True if this bridge should auto-resume on launch (unattended recovery). */
  wantRunning?: boolean;
  /** True when the card's settings/diagnostics body is collapsed to one row. */
  collapsed?: boolean;
}

/** The full persisted config (mirrors electron/main.js DEFAULT_CONFIG). */
export interface BridgeConfig {
  serverUrl: string;
  autoLaunch: boolean;
  bridges: Record<string, BridgeSettings>;
}

/** Stored login, encrypted at rest by the main process. */
export interface StoredCredentials {
  username: string;
  password: string;
  agencySlug?: string;
}

/** The IPC surface exposed by preload.js (window.bridgeHost). */
export interface BridgeHost {
  getConfig(): Promise<BridgeConfig>;
  setConfig(config: BridgeConfig): Promise<boolean>;
  saveCredentials(creds: StoredCredentials): Promise<boolean>;
  loadCredentials(): Promise<StoredCredentials | null>;
  clearCredentials(): Promise<boolean>;
  getVersion(): Promise<string>;
}
