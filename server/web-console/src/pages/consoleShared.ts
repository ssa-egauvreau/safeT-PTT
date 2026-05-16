// Shared constants and helpers for the console pages (ConsolePage + ChannelPanel).

import type { Permission } from "../api";
import type { VoiceState } from "../voice/voiceClient";

export const PERMISSION_LABEL: Record<Permission, string> = {
  talk_priority: "Talk priority",
  talk: "Talk",
  listen_only: "Listen only",
};

export const STATE_LABEL: Record<VoiceState, string> = {
  idle: "Idle",
  connecting: "Connecting…",
  listening: "Listening",
  transmitting: "On air",
  error: "Error",
  closed: "Disconnected",
};

export const OPEN_CHANNELS_KEY = "securityradio.openChannels";
export const LAST_CHANNEL_KEY = "securityradio.lastChannel";
export const PTT_CODE_KEY = "securityradio.pttKey";
export const DEFAULT_PTT_CODE = "Space";
export const KEYBOARD_ENABLED_KEY = "securityradio.keyboardOn";

export const volumeKey = (id: number) => `securityradio.vol.${id}`;
export const muteKey = (id: number) => `securityradio.mute.${id}`;
export const txDigitalKey = (id: number) => `securityradio.txDigital.${id}`;

/** Friendly label for a KeyboardEvent.code (e.g. "KeyT" -> "T", "F12" -> "F12"). */
export function keyLabel(code: string): string {
  if (code === "Space") return "Space";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  if (code.startsWith("Arrow")) return `${code.slice(5)} Arrow`;
  return code;
}

/** Per-channel listen volume (0–1), defaulting to full when unset or invalid. */
export function loadVolume(id: number): number {
  const raw = Number(localStorage.getItem(volumeKey(id)));
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 1;
}

export function loadMuted(id: number): boolean {
  return localStorage.getItem(muteKey(id)) === "1";
}

/** Per-channel TX mode — digital P25 (true) unless explicitly set to analog. */
export function loadTxDigital(id: number): boolean {
  return localStorage.getItem(txDigitalKey(id)) !== "0";
}
