// Listen-only scan client for the radio portal: opens one VoiceChannelClient per scanned channel
// so the browser receives audio from any of them while the operator's main channel client handles
// PTT. Mirrors the Android ScanVoiceListenTransport.

import { VoiceChannelClient, type VoiceState } from "./voiceClient";
import type { Permission } from "../api";

export interface ScanListenCallbacks {
  /** Fired whenever a scan channel transitions between idle and receiving voice. */
  onChannelActivity?: (channelName: string, receiving: boolean) => void;
}

export class ScanListenClient {
  private readonly clients = new Map<string, VoiceChannelClient>();
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
    for (const client of this.clients.values()) {
      try {
        client.close();
      } catch {
        /* already closing */
      }
    }
    this.clients.clear();
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
    // Drop sockets no longer in the scan list. Emit an idle callback for each removed channel
    // so the UI doesn't get stuck on "SCAN RX · <channel>" when an actively-receiving channel
    // is removed from the picker (or auto-removed because it became the new home channel).
    for (const existing of Array.from(this.clients.keys())) {
      if (!wanted.has(existing)) {
        const client = this.clients.get(existing);
        try {
          client?.close();
        } catch {
          /* already closing */
        }
        this.clients.delete(existing);
        try {
          this.callbacks.onChannelActivity?.(existing, false);
        } catch {
          /* listener errors must not block the next removal */
        }
      }
    }
    // Add sockets for new entries.
    for (const name of wanted) {
      if (this.clients.has(name)) continue;
      const client = new VoiceChannelClient(name, {
        onState: (_state: VoiceState) => {},
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
  }
}
