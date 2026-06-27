// Plays the radio's UI tones for console actions. Each agency may upload its
// own tone set; absent a custom upload, the bundled default is used. Tones are
// re-pulled whenever the server reports a new version, so an admin upload on
// the Sounds page reaches an already-open console without a manual reload.

import { getToken } from "./api";
import { resetMarker1033Cache } from "./voice/marker1033";

interface SoundDef {
  /** Server-side sound kind for `/v1/sounds/:kind`. */
  server: string;
  /** Bundled fallback, served as a static asset. */
  bundled: string;
  volume: number;
}

const SOUNDS = {
  permit: { server: "permit", bundled: "/sounds/ptt_permit.wav", volume: 1 },
  channelSwitch: { server: "channel_switch", bundled: "/sounds/channel_switch.wav", volume: 0.7 },
  emergency: { server: "emergency", bundled: "/sounds/emergency.wav", volume: 1 },
  busy: { server: "busy", bundled: "/sounds/busy.wav", volume: 0.8 },
} satisfies Record<string, SoundDef>;

type SoundKey = keyof typeof SOUNDS;

/** Playable URL per key — the agency's custom tone when present, else the bundled file. */
const resolved: Record<SoundKey, string> = {
  permit: SOUNDS.permit.bundled,
  channelSwitch: SOUNDS.channelSwitch.bundled,
  emergency: SOUNDS.emergency.bundled,
  busy: SOUNDS.busy.bundled,
};

/** Object URL of the loaded custom tone per key, kept so it can be revoked. */
const customUrl: Record<SoundKey, string | null> = {
  permit: null,
  channelSwitch: null,
  emergency: null,
  busy: null,
};

const cache = new Map<string, HTMLAudioElement>();
const active = new Set<HTMLAudioElement>();

/** The single looping channel-busy clip, while an operator keys a busy channel. */
let busyLoopClip: HTMLAudioElement | null = null;

/** One-shot lost-link clip (same busy.wav, stopped after 1.5s). */
let busyAlertClip: HTMLAudioElement | null = null;
let busyAlertStopTimer: number | null = null;

/** Repeats the 1.5s lost-link alert every 15s while the browser reports offline. */
let lostLinkAlertInterval: number | null = null;

const BUSY_ALERT_MS = 2000;
const LOST_LINK_ALERT_INTERVAL_MS = 15_000;

/** Settle guard added after the permit tone before the uplink un-mutes, so the
 *  tone's acoustic tail / output latency can't bleed onto transmitted audio. */
const PERMIT_TAIL_GUARD_MS = 150;
/** Fallback permit length (ms) used until the clip's real duration has loaded. */
const PERMIT_FALLBACK_MS = 280;

/** Server tone-set version last seen — a change means the tones must be re-pulled. */
let soundsVersion: string | null = null;

/** Background re-pull cadence; focus/visibility changes also trigger a check. */
const REFRESH_INTERVAL_MS = 60_000;

function template(url: string): HTMLAudioElement {
  let element = cache.get(url);
  if (!element) {
    element = new Audio(url);
    element.preload = "auto";
    cache.set(url, element);
  }
  return element;
}

/** Real permit-clip duration (ms), cached once its metadata loads. Lets the mute
 *  window be correct on the FIRST key-up even right after an agency swaps in a
 *  longer custom permit tone — otherwise that first press would fall back to the
 *  bundled-length estimate and under-mute, leaking the longer tone's tail. */
let permitDurationMs: number | null = null;

/** Read + cache the permit clip's real duration; if metadata isn't ready yet,
 *  catch it once it loads (and nudge the load). Best-effort, never throws.
 *  Called whenever the permit clip (re)resolves, so by key-up the duration is
 *  known. Re-arms on a fresh clip so a prior tone's length isn't reused. */
function warmPermitDuration(): void {
  const el = template(resolved.permit);
  if (Number.isFinite(el.duration) && el.duration > 0) {
    permitDurationMs = Math.round(el.duration * 1000);
    return;
  }
  permitDurationMs = null;
  el.addEventListener(
    "loadedmetadata",
    () => {
      if (Number.isFinite(el.duration) && el.duration > 0) {
        permitDurationMs = Math.round(el.duration * 1000);
      }
    },
    { once: true },
  );
  try {
    el.load();
  } catch {
    /* best-effort metadata warm */
  }
}

/**
 * How long to mute the uplink after keying up so the talk-permit tone (and its
 * tail) stays off the air: the resolved permit clip's length plus a settle
 * guard. Adapts to an agency's custom permit tone automatically. Prefers the
 * clip's live duration, then the cached value warmed at refresh/preload time,
 * and only falls back to a fixed estimate before either is known.
 */
function permitMuteWindowMs(): number {
  const el = template(resolved.permit);
  const liveMs =
    Number.isFinite(el.duration) && el.duration > 0
      ? Math.round(el.duration * 1000)
      : null;
  const durMs = liveMs ?? permitDurationMs ?? PERMIT_FALLBACK_MS;
  return durMs + PERMIT_TAIL_GUARD_MS;
}

function play(key: SoundKey): void {
  // Clone so rapid repeats overlap instead of cutting each other off.
  const clip = template(resolved[key]).cloneNode(true) as HTMLAudioElement;
  clip.volume = SOUNDS[key].volume;
  active.add(clip);
  clip.addEventListener("ended", () => active.delete(clip));
  // Autoplay can be blocked until the page has been interacted with — ignore that.
  void clip.play().catch(() => undefined);
}

// --- synthesized UI cues -------------------------------------------------
// Short success/error blips for action feedback (send page, save, etc.). These
// are app polish, not the agency-customizable radio tones, so they're generated
// with the Web Audio API rather than shipped as assets.
let cueCtx: AudioContext | null = null;

function cueContext(): AudioContext | null {
  try {
    if (!cueCtx) {
      cueCtx = new AudioContext();
    }
    if (cueCtx.state === "suspended") {
      void cueCtx.resume();
    }
    return cueCtx;
  } catch {
    return null;
  }
}

/** Schedules one enveloped tone on the shared cue context. */
function cueTone(
  ctx: AudioContext,
  freq: number,
  startAt: number,
  durSec: number,
  peak: number,
  type: OscillatorType = "sine",
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durSec);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + durSec + 0.02);
}

/** Rising two-note chime — confirms a completed action. */
function successCue(): void {
  const ctx = cueContext();
  if (!ctx) {
    return;
  }
  const t = ctx.currentTime;
  cueTone(ctx, 660, t, 0.12, 0.16);
  cueTone(ctx, 988, t + 0.085, 0.16, 0.16);
}

/** Low descending blip — signals a failed action. */
function errorCue(): void {
  const ctx = cueContext();
  if (!ctx) {
    return;
  }
  const t = ctx.currentTime;
  cueTone(ctx, 320, t, 0.16, 0.14, "square");
  cueTone(ctx, 232, t + 0.11, 0.2, 0.12, "square");
}


function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Releases the cached custom tone for a key, reverting it to the bundled default. */
function dropCustom(key: SoundKey): void {
  const url = customUrl[key];
  if (url) {
    cache.delete(url);
    URL.revokeObjectURL(url);
    customUrl[key] = null;
  }
  resolved[key] = SOUNDS[key].bundled;
}

/** Fetches the agency's custom tone for one key, or reverts to the bundled default. */
async function loadCustom(key: SoundKey): Promise<void> {
  const def = SOUNDS[key];
  try {
    const res = await fetch(`/v1/sounds/${def.server}`, { headers: authHeaders() });
    if (!res.ok) {
      // 404 — the agency has no (or no longer a) custom tone for this key.
      dropCustom(key);
      return;
    }
    const blob = await res.blob();
    dropCustom(key);
    const url = URL.createObjectURL(blob);
    customUrl[key] = url;
    resolved[key] = url;
    template(url); // warm the cache
  } catch {
    /* network error — keep whatever tone is currently resolved */
  }
}

/** Reads the agency's tone-set version, or null when it can't be determined. */
async function fetchVersion(): Promise<string | null> {
  try {
    const res = await fetch("/v1/sounds", { headers: authHeaders() });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  }
}

/** Re-pulls every custom tone when the server's tone-set version has changed. */
async function refresh(force = false): Promise<void> {
  const version = await fetchVersion();
  const changed = version !== null && version !== soundsVersion;
  if (!force && !changed) {
    return;
  }
  if (version !== null) {
    soundsVersion = version;
  }
  if (changed) {
    resetMarker1033Cache(); // the 10-33 marker re-decodes from the updated tone
  }
  await Promise.all((Object.keys(SOUNDS) as SoundKey[]).map(loadCustom));
  // The permit clip may have just resolved to a new custom tone — warm its real
  // duration so the next key-up mutes for the right length, not the fallback.
  warmPermitDuration();
}

/**
 * Watches for tone-set changes (admin uploads): re-pulls on an interval and
 * whenever the console regains focus. Returns a stop function.
 */
function startAutoRefresh(): () => void {
  const tick = (): void => {
    void refresh();
  };
  const onVisible = (): void => {
    if (document.visibilityState === "visible") {
      tick();
    }
  };
  const interval = window.setInterval(tick, REFRESH_INTERVAL_MS);
  window.addEventListener("focus", tick);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener("focus", tick);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export const sounds = {
  /** Talk-permit tone — played when the operator keys up. */
  permit: () => play("permit"),
  /** Uplink mute window (ms) — pass to `startTransmit` so the permit tone the
   *  operator hears locally isn't transmitted to peers. */
  permitMuteWindowMs,
  /** Channel-change blip. */
  channelSwitch: () => play("channelSwitch"),
  /** Emergency alert tone. */
  emergency: () => play("emergency"),
  /** Rising chime confirming a completed action (send page, save, etc.). */
  success: () => successCue(),
  /** Low blip signalling a failed action. */
  error: () => errorCue(),
  /** Plays ~1.5s of the busy clip for no-connection / lost-link (not looped). */
  busyAlert: () => {
    if (busyAlertStopTimer !== null) {
      window.clearTimeout(busyAlertStopTimer);
      busyAlertStopTimer = null;
    }
    if (busyAlertClip) {
      busyAlertClip.pause();
      busyAlertClip.currentTime = 0;
      active.delete(busyAlertClip);
      busyAlertClip = null;
    }
    const clip = template(resolved.busy).cloneNode(true) as HTMLAudioElement;
    clip.loop = false;
    clip.volume = SOUNDS.busy.volume;
    busyAlertClip = clip;
    active.add(clip);
    clip.addEventListener("ended", () => {
      if (busyAlertClip === clip) {
        active.delete(clip);
        busyAlertClip = null;
      }
    });
    void clip.play().catch(() => undefined);
    busyAlertStopTimer = window.setTimeout(() => {
      busyAlertStopTimer = null;
      if (!busyAlertClip) {
        return;
      }
      busyAlertClip.pause();
      busyAlertClip.currentTime = 0;
      active.delete(busyAlertClip);
      busyAlertClip = null;
    }, BUSY_ALERT_MS);
  },
  /** Stops a lost-link alert mid-play; also when connectivity returns. */
  busyAlertStop: () => {
    if (busyAlertStopTimer !== null) {
      window.clearTimeout(busyAlertStopTimer);
      busyAlertStopTimer = null;
    }
    if (!busyAlertClip) {
      return;
    }
    busyAlertClip.pause();
    busyAlertClip.currentTime = 0;
    active.delete(busyAlertClip);
    busyAlertClip = null;
  },
  /** Starts the channel-busy tone looping — held while an operator keys a busy channel. */
  busyLoopStart: () => {
    if (busyLoopClip) {
      return;
    }
    const clip = template(resolved.busy).cloneNode(true) as HTMLAudioElement;
    clip.loop = true;
    clip.volume = SOUNDS.busy.volume;
    busyLoopClip = clip;
    active.add(clip);
    void clip.play().catch(() => undefined);
  },
  /** Stops the looping channel-busy tone (operator released the key). */
  busyLoopStop: () => {
    if (!busyLoopClip) {
      return;
    }
    busyLoopClip.pause();
    busyLoopClip.currentTime = 0;
    active.delete(busyLoopClip);
    busyLoopClip = null;
  },
  /** Stop All Sounds — silences every alert/page tone currently playing. */
  stopAll: () => {
    busyLoopClip = null;
    if (busyAlertStopTimer !== null) {
      window.clearTimeout(busyAlertStopTimer);
      busyAlertStopTimer = null;
    }
    busyAlertClip = null;
    for (const clip of active) {
      clip.pause();
      clip.currentTime = 0;
    }
    active.clear();
  },
  /** Warms the browser cache and pulls in any agency-custom tones. */
  preload: () => {
    for (const key of Object.keys(SOUNDS) as SoundKey[]) {
      template(resolved[key]);
    }
    // Warm the permit duration up front so the first key-up after console open
    // mutes for the right length (refresh() warms it again after any custom pull).
    warmPermitDuration();
    void refresh(true);
  },
  /** Starts watching for admin tone uploads; returns a stop function. */
  startAutoRefresh,
};

function startLostLinkBusyAlerts(): void {
  if (lostLinkAlertInterval !== null) {
    return;
  }
  sounds.busyAlert();
  lostLinkAlertInterval = window.setInterval(() => {
    sounds.busyAlert();
  }, LOST_LINK_ALERT_INTERVAL_MS);
}

function stopLostLinkBusyAlerts(): void {
  if (lostLinkAlertInterval !== null) {
    window.clearInterval(lostLinkAlertInterval);
    lostLinkAlertInterval = null;
  }
  sounds.busyAlertStop();
  sounds.busyLoopStop();
}

/**
 * While offline: play 1.5s of busy.wav immediately, then every 15s until online.
 * Stops all busy audio when the browser reports connectivity again.
 */
export function bindLostLinkBusyAlerts(): () => void {
  const onOffline = (): void => {
    startLostLinkBusyAlerts();
  };
  const onOnline = (): void => {
    stopLostLinkBusyAlerts();
  };
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  if (!navigator.onLine) {
    onOffline();
  }
  return () => {
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    stopLostLinkBusyAlerts();
  };
}
