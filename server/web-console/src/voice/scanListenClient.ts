// Listen-only scan client for the radio portal: opens one VoiceChannelClient per scanned channel
// so the browser receives audio from any of them while the operator's main channel client handles
// PTT. Mirrors the Android ScanVoiceListenTransport.

import { VoiceChannelClient, type VoiceState } from "./voiceClient";
import type { Permission } from "../api";

export interface ScanListenCallbacks {
  /** Fired whenever a scan channel transitions between idle and receiving voice. */
  onChannelActivity?: (channelName: string, receiving: boolean) => void;
}

/** Quiet pause between a scan-channel WS close and the next reconnect attempt. */
const SCAN_RECONNECT_DELAY_MS = 3000;

export class ScanListenClient {
  private readonly clients = new Map<string, VoiceChannelClient>();
  /** Pending reconnect timers keyed by channel name, so we can cancel them on close/remove. */
  private readonly reconnectTimers = new Map<string, number>();
  private readonly callbacks: ScanListenCallbacks;
  private homeChannel: string;
  /** When false, [setScanList] still records the list but no sockets are opened. */
  private enabled = false;
  private lastList: ReadonlyArray<string> = [];

  constructor(homeChannel: string, callbacks: ScanListenCallbacks = {}) {
    this.homeChannel = homeChannel;
    this.callbacks = callbacks;
  }

  setHomeChannel(channelName: string): void {
    this.homeChannel = channelName;
    if (this.enabled) {
      // Re-apply so we don't duplicate the new home channel on a scan socket.
      this.applyList(this.lastList);
    }
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.applyList(this.lastList);
    } else {
      this.closeAll();
    }
  }

  setScanList(list: ReadonlyArray<string>): void {
    this.lastList = list;
    if (this.enabled) {
      this.applyList(list);
    }
  }

  /** Closes every scan socket. Idempotent. */
  closeAll(): void {
    for (const timer of this.reconnectTimers.values()) {
      window.clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    for (const client of this.clients.values()) {
      try {
        client.close();
      } catch {
        /* already closing */
      }
    }
    this.clients.clear();
  }

  /** Drops one client + any pending retry. Emits the idle callback so latched UI clears. */
  private dropChannel(name: string): void {
    const timer = this.reconnectTimers.get(name);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.reconnectTimers.delete(name);
    }
    const client = this.clients.get(name);
    if (client) {
      try {
        client.close();
      } catch {
        /* already closing */
      }
      this.clients.delete(name);
    }
    try {
      this.callbacks.onChannelActivity?.(name, false);
    } catch {
      /* listener errors must not block other state transitions */
    }
  }

  /** Spawns a single VoiceChannelClient for [name] and wires its lifecycle into the scan map. */
  private spawnClient(name: string): void {
    if (this.clients.has(name)) return;
    const client = new VoiceChannelClient(name, {
      onState: (state: VoiceState) => {
        /*
         * When a scan socket closes unexpectedly (relay restart, transient drop, etc.) it has to
         * be torn out of `this.clients` AND re-created — applyList() would otherwise skip
         * recreating because `this.clients.has(name)` is still true, and that channel would go
         * silent until the operator toggled scan on/off. Reconnect on `closed`, give up on
         * `error` (config / permission issues — another attempt won't help).
         */
        if (state !== "closed" && state !== "error") return;
        this.clients.delete(name);
        try {
          this.callbacks.onChannelActivity?.(name, false);
        } catch {
          /* listener errors must not block reconnect */
        }
        if (state === "error") return;
        if (!this.enabled) return;
        if (this.homeChannel.trim().toLowerCase() === name.toLowerCase()) return;
        if (!this.lastList.some((c) => c.trim() === name)) return;
        const existing = this.reconnectTimers.get(name);
        if (existing !== undefined) window.clearTimeout(existing);
        const timer = window.setTimeout(() => {
          this.reconnectTimers.delete(name);
          if (!this.enabled) return;
          if (!this.lastList.some((c) => c.trim() === name)) return;
          this.spawnClient(name);
        }, SCAN_RECONNECT_DELAY_MS);
        this.reconnectTimers.set(name, timer);
      },
      onPermission: (_p: Permission) => {},
      onReceiving: (receiving) => this.callbacks.onChannelActivity?.(name, receiving),
      onBusy: () => {},
    });
    this.clients.set(name, client);
    try {
      client.connect();
    } catch {
      this.clients.delete(name);
    }
  }

  /** Reconciles open sockets against [desired] (minus the home channel). */
  private applyList(desired: ReadonlyArray<string>): void {
    const wanted = new Set<string>();
    const homeLower = this.homeChannel.trim().toLowerCase();
    for (const raw of desired) {
      const name = raw.trim();
      if (!name) continue;
      if (name.toLowerCase() === homeLower) continue;
      wanted.add(name);
    }
    // Drop sockets no longer in the scan list. dropChannel() also fires the idle callback so
    // the UI doesn't get stuck on "SCAN RX · <channel>" when an actively-receiving channel is
    // removed from the picker (or auto-removed because it became the new home channel).
    for (const existing of Array.from(this.clients.keys())) {
      if (!wanted.has(existing)) {
        this.dropChannel(existing);
      }
    }
    // Cancel any pending reconnect for channels that are no longer wanted.
    for (const pending of Array.from(this.reconnectTimers.keys())) {
      if (!wanted.has(pending)) {
        const timer = this.reconnectTimers.get(pending);
        if (timer !== undefined) window.clearTimeout(timer);
        this.reconnectTimers.delete(pending);
      }
    }
    // Add sockets for new entries.
    for (const name of wanted) {
      this.spawnClient(name);
    }
  }
}
