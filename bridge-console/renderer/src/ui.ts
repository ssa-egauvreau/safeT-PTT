// safeT Bridge UI controller (vanilla DOM — no framework, focused app).
//
// Drives the whole renderer: setup/login, the per-bridge audio settings cards,
// auto-resume of running bridges, and the auth watchdog that keeps the token
// fresh so reconnects survive server reboots unattended.

import { Api, describeApiError, isAuthError } from "./api";
import { host } from "./host";
import { BridgeRunnerClient, type BridgeRunState } from "./bridgeRunner";
import type { Bridge, BridgeConfig, BridgeSettings, SessionUser, StoredCredentials } from "./types";

/**
 * The dispatch server this app always talks to. Hard-wired so a bridge box
 * never has to be told where the server is — no address to type or mistype.
 */
const DEFAULT_SERVER_URL = "https://safet-ptt.com";

/** Re-validate the token on this cadence; re-login on failure. */
const AUTH_WATCHDOG_MS = 30000;
/** Re-list bridges on this cadence so server-side adds/edits show up. */
const BRIDGE_REFRESH_MS = 60000;

let api: Api | null = null;
let user: SessionUser | null = null;
let config: BridgeConfig = { serverUrl: DEFAULT_SERVER_URL, autoLaunch: true, bridges: {} };
let credentials: StoredCredentials | null = null;
let bridges: Bridge[] = [];
let inputs: MediaDeviceInfo[] = [];
let outputs: MediaDeviceInfo[] = [];
const runners = new Map<number, BridgeRunnerClient>();
const cards = new Map<number, BridgeCard>();
let authTimer: number | null = null;
let bridgeRefreshTimer: number | null = null;
let reauthInFlight: Promise<boolean> | null = null;

// --- tiny DOM helpers ---------------------------------------------------------
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "class") {
      node.className = String(value);
    } else if (key === "value") {
      (node as HTMLInputElement).value = String(value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function view(): HTMLElement {
  return document.getElementById("view") as HTMLElement;
}

function setHeaderStatus(text: string, kind: "ok" | "warn" | "off"): void {
  const chip = document.getElementById("conn-status");
  if (!chip) return;
  chip.textContent = text;
  chip.className = `chip ${kind}`;
}

// --- settings access ----------------------------------------------------------
function settingsFor(id: number): BridgeSettings {
  return config.bridges[String(id)] ?? {};
}

async function persistConfig(): Promise<void> {
  await host.setConfig(config);
}

async function updateBridgeSettings(id: number, patch: BridgeSettings): Promise<void> {
  config.bridges[String(id)] = { ...settingsFor(id), ...patch };
  await persistConfig();
}

function effVoxThreshold(b: Bridge): number {
  return settingsFor(b.id).voxThreshold ?? b.vox_threshold;
}
function effVoxHang(b: Bridge): number {
  return settingsFor(b.id).voxHangMs ?? b.vox_hang_ms;
}
function effGain(b: Bridge): number {
  return settingsFor(b.id).gain ?? 1;
}

/** Picks a sensible default input device — one whose label matches the hint. */
function defaultInput(devices: MediaDeviceInfo[], hint: string | null): string {
  if (hint) {
    const needle = hint.trim().toLowerCase();
    const match = devices.find((d) => d.label.toLowerCase().includes(needle));
    if (match) return match.deviceId;
  }
  return devices[0]?.deviceId ?? "";
}

function effInput(b: Bridge): string {
  const stored = settingsFor(b.id).inputDeviceId;
  if (stored && inputs.some((d) => d.deviceId === stored)) return stored;
  return defaultInput(inputs, b.device_hint);
}
function effOutput(b: Bridge): string {
  const stored = settingsFor(b.id).outputDeviceId;
  if (stored && outputs.some((d) => d.deviceId === stored)) return stored;
  return outputs[0]?.deviceId ?? "";
}

// --- audio devices ------------------------------------------------------------
async function enumerateDevices(): Promise<void> {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch {
    /* permission denied — labels will be blank but ids still enumerate */
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    inputs = devices.filter((d) => d.kind === "audioinput");
    outputs = devices.filter((d) => d.kind === "audiooutput");
  } catch {
    /* enumeration unavailable */
  }
}

// --- login / setup ------------------------------------------------------------
function showLogin(error?: string): void {
  stopTimers();
  const v = view();
  clear(v);

  const userInput = h("input", {
    id: "f-user",
    type: "text",
    placeholder: "dispatch login",
    value: credentials?.username || "",
    autocomplete: "off",
  });
  const passInput = h("input", {
    id: "f-pass",
    type: "password",
    placeholder: "password",
    value: credentials?.password || "",
    autocomplete: "off",
  });
  const agencyInput = h("input", {
    id: "f-agency",
    type: "text",
    placeholder: "agency code (if required)",
    value: credentials?.agencySlug || "",
    autocomplete: "off",
  });
  const remember = h("input", { id: "f-remember", type: "checkbox" }) as HTMLInputElement;
  remember.checked = true;
  const autostart = h("input", { id: "f-autostart", type: "checkbox" }) as HTMLInputElement;
  autostart.checked = config.autoLaunch;

  const errEl = h("p", { class: "err", id: "f-err" }, [error ?? ""]);
  if (!error) errEl.setAttribute("hidden", "");

  const submit = async (): Promise<void> => {
    errEl.removeAttribute("hidden");
    errEl.textContent = "Signing in…";
    const creds: StoredCredentials = {
      username: userInput.value.trim(),
      password: passInput.value,
      agencySlug: agencyInput.value.trim() || undefined,
    };
    if (!creds.username || !creds.password) {
      errEl.textContent = "Enter a username and password.";
      return;
    }
    config.autoLaunch = autostart.checked;
    await persistConfig();
    const ok = await doLogin(creds, { persist: remember.checked });
    if (!ok) {
      errEl.textContent = lastLoginError || "Sign-in failed.";
    }
  };

  v.append(
    h("section", { class: "card login" }, [
      h("h1", {}, ["Connect this bridge box"]),
      h("p", { class: "muted" }, [
        "safeT Bridge runs your radio bridges from this computer and reconnects on its own when the server restarts.",
      ]),
      field("Username", userInput),
      field("Password", passInput),
      field("Agency code", agencyInput),
      h("label", { class: "check" }, [remember, h("span", {}, ["Stay signed in (auto-login after a reboot)"])]),
      h("label", { class: "check" }, [autostart, h("span", {}, ["Start automatically when Windows signs in"])]),
      errEl,
      h("button", { class: "btn primary", onclick: submit as EventListener }, ["Sign in"]),
    ]),
  );

  passInput.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void submit();
  });
}

function field(label: string, input: HTMLElement): HTMLElement {
  return h("div", { class: "field" }, [h("label", {}, [label]), input]);
}

let lastLoginError = "";

/** Authenticates and, on success, switches to the bridges view. */
async function doLogin(creds: StoredCredentials, opts: { persist: boolean }): Promise<boolean> {
  lastLoginError = "";
  const client = new Api(config.serverUrl);
  try {
    user = await client.login(creds);
  } catch (err) {
    lastLoginError = describeApiError(err);
    return false;
  }
  api = client;
  credentials = creds;
  if (opts.persist) {
    await host.saveCredentials(creds);
  } else {
    await host.clearCredentials();
  }
  setHeaderStatus("Connected", "ok");
  await showBridges();
  return true;
}

async function signOut(): Promise<void> {
  for (const runner of runners.values()) runner.stop();
  runners.clear();
  cards.clear();
  // Drop run-intent so a sign-out doesn't auto-resume on next launch.
  for (const key of Object.keys(config.bridges)) {
    config.bridges[key] = { ...config.bridges[key], wantRunning: false };
  }
  await persistConfig();
  await host.clearCredentials();
  api = null;
  user = null;
  credentials = null;
  setHeaderStatus("Signed out", "off");
  showLogin();
}

// --- bridges view -------------------------------------------------------------
async function showBridges(): Promise<void> {
  await enumerateDevices();
  try {
    bridges = await api!.listRunnableBridges();
  } catch (err) {
    if (isAuthError(err)) {
      await triggerReauth();
      return;
    }
    renderBridgesError(describeApiError(err));
    return;
  }
  renderBridges();
  autoResume();
  startTimers();
}

function renderBridgesError(message: string): void {
  const v = view();
  clear(v);
  v.append(
    h("section", { class: "card" }, [
      h("h2", {}, ["Could not load bridges"]),
      h("p", { class: "err" }, [message]),
      h("button", { class: "btn", onclick: (() => void showBridges()) as EventListener }, ["Retry"]),
    ]),
  );
}

function renderBridges(): void {
  cards.clear();
  const v = view();
  clear(v);

  const head = h("div", { class: "bridges-head" }, [
    h("div", {}, [
      h("h2", {}, ["Run bridges"]),
      h("p", { class: "muted" }, [
        `Signed in as ${user?.displayName ?? user?.username ?? "—"}` +
          (user?.agencyName ? ` · ${user.agencyName}` : "") +
          ` · ${config.serverUrl}`,
      ]),
    ]),
    h("div", { class: "row" }, [
      h("button", { class: "btn ghost", onclick: (() => void showBridges()) as EventListener }, ["Refresh"]),
      h("button", { class: "btn ghost", onclick: (() => void signOut()) as EventListener }, ["Sign out"]),
    ]),
  ]);
  v.append(head);

  if (bridges.length === 0) {
    v.append(
      h("div", { class: "empty" }, [
        "No enabled line-in bridges for this agency. An admin can add one under ",
        h("strong", {}, ["Configure bridges"]),
        " in the dispatch console.",
      ]),
    );
    return;
  }

  for (const bridge of bridges) {
    const card = new BridgeCard(bridge);
    cards.set(bridge.id, card);
    v.append(card.el);
  }
}

/** Auto-resume any bridge that was running when the box last shut down. */
function autoResume(): void {
  for (const bridge of bridges) {
    if (settingsFor(bridge.id).wantRunning && effInput(bridge)) {
      cards.get(bridge.id)?.start();
    }
  }
}

// --- per-bridge card ----------------------------------------------------------
class BridgeCard {
  readonly bridge: Bridge;
  readonly el: HTMLElement;
  private readonly bidirectional: boolean;

  private statusPill!: HTMLElement;
  private detailEl!: HTMLElement;
  private meterFill!: HTMLElement;
  private meterMark!: HTMLElement;
  private keyedLamp!: HTMLElement;
  private rxLamp!: HTMLElement;
  private startBtn!: HTMLButtonElement;
  private inputSel!: HTMLSelectElement;
  private outputSel!: HTMLSelectElement | null;
  private gainOut!: HTMLElement;
  private voxOut!: HTMLElement;
  private hangOut!: HTMLElement;

  constructor(bridge: Bridge) {
    this.bridge = bridge;
    this.bidirectional = bridge.direction === "bidirectional";
    this.el = this.build();
  }

  private build(): HTMLElement {
    const b = this.bridge;
    this.statusPill = h("span", { class: "pill off" }, ["Idle"]);
    this.detailEl = h("span", { class: "muted detail" }, []);

    // Device pickers
    this.inputSel = h("select", {
      onchange: (() => {
        void updateBridgeSettings(b.id, { inputDeviceId: this.inputSel.value });
      }) as EventListener,
    }) as HTMLSelectElement;
    this.fillInputOptions();

    let outputField: HTMLElement | null = null;
    this.outputSel = null;
    if (this.bidirectional) {
      this.outputSel = h("select", {
        onchange: (() => {
          void updateBridgeSettings(b.id, { outputDeviceId: this.outputSel!.value });
          this.applyAudioParams();
        }) as EventListener,
      }) as HTMLSelectElement;
      this.fillOutputOptions();
      outputField = field("Output device (line-out / speaker)", this.outputSel);
    }

    // Gain slider (0.25×–6×)
    const gain = effGain(b);
    this.gainOut = h("span", { class: "slider-val" }, [formatGain(gain)]);
    const gainSlider = h("input", {
      type: "range",
      min: "0.25",
      max: "6",
      step: "0.05",
      value: String(gain),
    }) as HTMLInputElement;
    gainSlider.addEventListener("input", () => {
      const val = Number(gainSlider.value);
      this.gainOut.textContent = formatGain(val);
      void updateBridgeSettings(b.id, { gain: val });
      this.applyAudioParams();
    });

    // VOX threshold slider (0–0.2 normalized RMS)
    const vox = effVoxThreshold(b);
    this.voxOut = h("span", { class: "slider-val" }, [vox.toFixed(3)]);
    const voxSlider = h("input", {
      type: "range",
      min: "0",
      max: "0.2",
      step: "0.001",
      value: String(vox),
    }) as HTMLInputElement;
    voxSlider.addEventListener("input", () => {
      const val = Number(voxSlider.value);
      this.voxOut.textContent = val.toFixed(3);
      this.meterMark.style.left = `${Math.min(val / 0.2, 1) * 100}%`;
      void updateBridgeSettings(b.id, { voxThreshold: val });
      this.applyAudioParams();
    });

    // VOX hang slider (100–3000 ms)
    const hang = effVoxHang(b);
    this.hangOut = h("span", { class: "slider-val" }, [`${hang} ms`]);
    const hangSlider = h("input", {
      type: "range",
      min: "100",
      max: "3000",
      step: "50",
      value: String(hang),
    }) as HTMLInputElement;
    hangSlider.addEventListener("input", () => {
      const val = Number(hangSlider.value);
      this.hangOut.textContent = `${val} ms`;
      void updateBridgeSettings(b.id, { voxHangMs: val });
      this.applyAudioParams();
    });

    // Meter
    this.meterFill = h("div", { class: "meter-fill" }, []);
    this.meterMark = h("div", { class: "meter-mark" }, []);
    this.meterMark.style.left = `${Math.min(vox / 0.2, 1) * 100}%`;
    this.keyedLamp = h("span", { class: "lamp" }, ["TX"]);
    this.rxLamp = h("span", { class: "lamp" }, ["RX"]);
    const meter = h("div", { class: "meter-row" }, [
      h("div", { class: "meter" }, [this.meterFill, this.meterMark]),
      this.keyedLamp,
      ...(this.bidirectional ? [this.rxLamp] : []),
    ]);

    this.startBtn = h("button", {
      class: "btn primary",
      onclick: (() => this.toggle()) as EventListener,
    }) as HTMLButtonElement;
    this.startBtn.textContent = "Start bridge";

    const reset = h("button", {
      class: "btn ghost sm",
      onclick: (() => void this.resetAudio()) as EventListener,
    }, ["Reset audio settings"]);

    const directionBadge = h("span", { class: "badge" }, [
      this.bidirectional ? "Bidirectional" : "Inbound only",
    ]);

    return h("section", { class: "card bridge" }, [
      h("div", { class: "panel-head" }, [
        h("h3", {}, [b.name]),
        this.statusPill,
      ]),
      h("p", { class: "muted" }, [
        "Keys ",
        h("strong", {}, [b.target_channel]),
        " · ",
        directionBadge,
        " · ",
        b.yield_to_units ? "yields to real units" : "holds the channel",
      ]),
      h("div", { class: "grid" }, [
        field("Input device (line-in)", this.inputSel),
        ...(outputField ? [outputField] : []),
        sliderField("Input gain", gainSlider, this.gainOut),
        sliderField("VOX sensitivity (threshold)", voxSlider, this.voxOut),
        sliderField("VOX hang (tail)", hangSlider, this.hangOut),
      ]),
      meter,
      h("div", { class: "actions" }, [this.startBtn, reset, this.detailEl]),
    ]);
  }

  private fillInputOptions(): void {
    clear(this.inputSel);
    const selected = effInput(this.bridge);
    if (inputs.length === 0) {
      this.inputSel.append(h("option", { value: "" }, ["No input devices found"]));
    }
    for (const d of inputs) {
      const opt = h("option", { value: d.deviceId }, [d.label || `Input ${d.deviceId.slice(0, 6)}`]);
      if (d.deviceId === selected) opt.setAttribute("selected", "");
      this.inputSel.append(opt);
    }
    this.inputSel.value = selected;
  }

  private fillOutputOptions(): void {
    if (!this.outputSel) return;
    clear(this.outputSel);
    const selected = effOutput(this.bridge);
    if (outputs.length === 0) {
      this.outputSel.append(h("option", { value: "" }, ["System default"]));
    }
    for (const d of outputs) {
      const opt = h("option", { value: d.deviceId }, [d.label || `Output ${d.deviceId.slice(0, 6)}`]);
      if (d.deviceId === selected) opt.setAttribute("selected", "");
      this.outputSel.append(opt);
    }
    this.outputSel.value = selected;
  }

  /** Re-fill device dropdowns after a hot-plug (devicechange). */
  refreshDevices(): void {
    this.fillInputOptions();
    this.fillOutputOptions();
  }

  /** Push live gain/VOX changes into a running runner without restarting it. */
  private applyAudioParams(): void {
    const runner = runners.get(this.bridge.id);
    runner?.updateAudioParams({
      gain: effGain(this.bridge),
      voxThreshold: effVoxThreshold(this.bridge),
      voxHangMs: effVoxHang(this.bridge),
    });
  }

  private async resetAudio(): Promise<void> {
    await updateBridgeSettings(this.bridge.id, {
      gain: undefined,
      voxThreshold: undefined,
      voxHangMs: undefined,
    });
    // Re-render this card in place to reflect server defaults.
    const fresh = new BridgeCard(this.bridge);
    cards.set(this.bridge.id, fresh);
    this.el.replaceWith(fresh.el);
    // If running, keep it running and push the reset params into the live runner.
    if (runners.has(this.bridge.id)) {
      fresh.syncRunningUi();
      runners.get(this.bridge.id)?.updateAudioParams({
        gain: effGain(this.bridge),
        voxThreshold: effVoxThreshold(this.bridge),
        voxHangMs: effVoxHang(this.bridge),
      });
    }
  }

  private toggle(): void {
    if (runners.has(this.bridge.id)) {
      void this.stop();
    } else {
      this.start();
    }
  }

  start(): void {
    if (runners.has(this.bridge.id)) return;
    const inputId = effInput(this.bridge);
    if (!inputId) {
      this.setDetail("No input device selected.");
      return;
    }
    const runner = new BridgeRunnerClient(
      {
        serverUrl: config.serverUrl,
        bridgeId: this.bridge.id,
        bidirectional: this.bidirectional,
        getToken: () => api?.getToken() ?? "",
        voxThreshold: effVoxThreshold(this.bridge),
        voxHangMs: effVoxHang(this.bridge),
        gain: effGain(this.bridge),
        inputDeviceId: inputId,
        outputDeviceId: this.bidirectional ? effOutput(this.bridge) || null : null,
      },
      {
        onState: (state, detail) => this.onState(state, detail),
        onKeyed: (keyed) => this.keyedLamp.classList.toggle("on", keyed),
        onReceiving: (rx) => this.rxLamp.classList.toggle("on", rx),
        onLevel: (level) => this.onLevel(level),
        onAuthError: () => void triggerReauth(),
      },
    );
    runners.set(this.bridge.id, runner);
    void updateBridgeSettings(this.bridge.id, { wantRunning: true });
    this.syncRunningUi();
    void runner.start();
  }

  async stop(): Promise<void> {
    const runner = runners.get(this.bridge.id);
    runner?.stop();
    runners.delete(this.bridge.id);
    await updateBridgeSettings(this.bridge.id, { wantRunning: false });
    this.onLevel(0);
    this.syncStoppedUi();
  }

  private onState(state: BridgeRunState, detail?: string): void {
    let label = "Idle";
    let cls = "pill off";
    if (state === "connecting") {
      label = "Starting…";
      cls = "pill warn";
    } else if (state === "running") {
      label = "On the channel";
      cls = "pill on";
    } else if (state === "reconnecting") {
      label = "Reconnecting…";
      cls = "pill warn";
    } else if (state === "error") {
      label = "Error";
      cls = "pill off";
      // A terminal local fault dropped the runner — reflect that in the buttons.
      runners.delete(this.bridge.id);
      this.syncStoppedUi();
    } else if (state === "stopped") {
      label = "Stopped";
      cls = "pill off";
    }
    this.statusPill.textContent = label;
    this.statusPill.className = cls;
    this.setDetail(detail ?? "");
  }

  private onLevel(level: number): void {
    this.meterFill.style.width = `${Math.min(level / 0.2, 1) * 100}%`;
  }

  private setDetail(text: string): void {
    this.detailEl.textContent = text;
  }

  /** Reflect the running state in the controls (used on start + re-render). */
  syncRunningUi(): void {
    this.startBtn.textContent = "Stop bridge";
    this.startBtn.classList.remove("primary");
    this.startBtn.classList.add("danger");
    this.inputSel.disabled = true;
    if (this.outputSel) this.outputSel.disabled = true;
  }

  private syncStoppedUi(): void {
    this.startBtn.textContent = "Start bridge";
    this.startBtn.classList.remove("danger");
    this.startBtn.classList.add("primary");
    this.inputSel.disabled = false;
    if (this.outputSel) this.outputSel.disabled = false;
  }
}

function sliderField(label: string, slider: HTMLElement, valueOut: HTMLElement): HTMLElement {
  return h("div", { class: "field slider" }, [
    h("label", {}, [label, valueOut]),
    slider,
  ]);
}

function formatGain(g: number): string {
  const db = 20 * Math.log10(g);
  const sign = db >= 0 ? "+" : "";
  return `${g.toFixed(2)}× (${sign}${db.toFixed(1)} dB)`;
}

// --- auth watchdog + token refresh -------------------------------------------
function startTimers(): void {
  stopTimers();
  authTimer = window.setInterval(() => void checkAuth(), AUTH_WATCHDOG_MS);
  bridgeRefreshTimer = window.setInterval(() => void refreshBridgeList(), BRIDGE_REFRESH_MS);
}

function stopTimers(): void {
  if (authTimer !== null) {
    window.clearInterval(authTimer);
    authTimer = null;
  }
  if (bridgeRefreshTimer !== null) {
    window.clearInterval(bridgeRefreshTimer);
    bridgeRefreshTimer = null;
  }
}

async function checkAuth(): Promise<void> {
  if (!api) return;
  try {
    await api.me();
    setHeaderStatus("Connected", "ok");
  } catch (err) {
    if (isAuthError(err)) {
      await triggerReauth();
    } else {
      // Server unreachable (likely mid-redeploy). Bridges keep retrying on their
      // own; just reflect the degraded state in the header.
      setHeaderStatus("Server unreachable — retrying", "warn");
    }
  }
}

/**
 * Re-authenticates with stored credentials and pushes the fresh token to every
 * running bridge so they reconnect immediately. Deduped so a burst of auth
 * failures triggers only one login.
 */
async function triggerReauth(): Promise<boolean> {
  if (reauthInFlight) return reauthInFlight;
  reauthInFlight = (async () => {
    if (!api || !credentials) {
      // No stored credentials to recover with — fall back to the login screen.
      stopTimers();
      setHeaderStatus("Sign-in required", "off");
      showLogin("Your session ended. Please sign in again.");
      return false;
    }
    setHeaderStatus("Re-authenticating…", "warn");
    try {
      user = await api.login(credentials);
      setHeaderStatus("Connected", "ok");
      for (const runner of runners.values()) runner.notifyTokenRefreshed();
      return true;
    } catch (err) {
      if (isAuthError(err)) {
        // Credentials themselves are bad now — stop and ask the operator.
        stopTimers();
        setHeaderStatus("Sign-in required", "off");
        showLogin(describeApiError(err));
        return false;
      }
      // Transient (server down) — leave the bridges retrying; try again later.
      setHeaderStatus("Server unreachable — retrying", "warn");
      return false;
    }
  })();
  try {
    return await reauthInFlight;
  } finally {
    reauthInFlight = null;
  }
}

async function refreshBridgeList(): Promise<void> {
  if (!api) return;
  try {
    const next = await api.listRunnableBridges();
    // Only re-render if the set of bridges actually changed, so we don't disturb
    // running cards on every poll.
    const sameSet =
      next.length === bridges.length &&
      next.every((b) => bridges.some((o) => o.id === b.id));
    if (!sameSet) {
      bridges = next;
      // The card DOM is about to be rebuilt, which would orphan any live runner's
      // callbacks (they capture the old card's elements). Stop every runner first,
      // then auto-resume rebuilds them against the fresh cards. Run-intent is
      // persisted, so a bridge that was running comes right back up — only a brief
      // gap, and only when an admin actually adds/removes a bridge.
      for (const runner of runners.values()) runner.stop();
      runners.clear();
      renderBridges();
      autoResume();
    }
  } catch {
    /* leave the current view; auth watchdog handles token issues */
  }
}

// --- bootstrap ----------------------------------------------------------------
export async function initApp(): Promise<void> {
  config = await host.getConfig();
  // The server address is fixed — never rely on (or keep) a stored value, so an
  // old or blank config can't point a bridge box at the wrong place.
  if (config.serverUrl !== DEFAULT_SERVER_URL) {
    config.serverUrl = DEFAULT_SERVER_URL;
    await persistConfig();
  }
  credentials = await host.loadCredentials();
  try {
    const version = await host.getVersion();
    const vEl = document.getElementById("app-version");
    if (vEl) vEl.textContent = `v${version}`;
  } catch {
    /* ignore */
  }

  // Re-enumerate devices on hot-plug and refresh every card's dropdowns.
  navigator.mediaDevices.addEventListener?.("devicechange", async () => {
    await enumerateDevices();
    for (const card of cards.values()) card.refreshDevices();
  });

  // Fully unattended path: if we have a server + stored login, sign in and
  // resume automatically — no operator interaction required after a reboot.
  if (config.serverUrl && credentials) {
    setHeaderStatus("Signing in…", "warn");
    const ok = await doLogin(credentials, { persist: true });
    if (ok) return;
    showLogin(lastLoginError || undefined);
    return;
  }
  showLogin();
}
