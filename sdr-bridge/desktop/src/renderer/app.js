"use strict";
/* Renderer logic. Talks to the backend only through window.api (see preload.js). */

const $ = (id) => document.getElementById(id);
const MHZ = 1_000_000;

// ---- tabs ----------------------------------------------------------------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ---- toast ---------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ---- settings load / save ------------------------------------------------
function mhz(hz) {
  return hz ? +(hz / MHZ).toFixed(4) : "";
}

async function loadSettings() {
  const cfg = (await window.api.getConfig()) || {};
  const sources = Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources : [cfg.sdr || {}];
  const d1 = sources[0] || {};
  const d2 = sources[1] || null;
  const sys = (Array.isArray(cfg.systems) && cfg.systems[0]) || cfg.system || {};
  const ice = cfg.icecast || {};
  const safet = cfg.safet || {};

  $("centerMHz").value = mhz(d1.centerHz);
  $("gain").value = d1.gain ?? "";
  $("ppm").value = d1.ppm ?? "";
  $("rateHz").value = d1.rateHz ?? 2400000;

  // second dongle
  $("dongle2on").checked = !!d2;
  $("dongle2fields").hidden = !d2;
  $("d2center").value = d2 ? mhz(d2.centerHz) : "";
  $("d2gain").value = d2 && d2.gain != null ? d2.gain : "";
  $("d2ppm").value = d2 && d2.ppm != null ? d2.ppm : "";
  $("d2device").value = d2 && d2.device != null ? d2.device : 1;
  $("controlMHz").value = (sys.controlChannelsHz || []).map((h) => +(h / MHZ).toFixed(4)).join(", ");
  $("modulation").value = sys.modulation || "qpsk";
  $("icecastSource").value = ice.sourcePassword || "";
  $("icecastAdmin").value = ice.adminPassword || "";
  $("safetUrl").value = safet.baseUrl || "";
  $("safetUser").value = safet.username || "";
  $("safetPass").value = safet.password || "";

  const s = (await window.api.getSettings()) || {};
  $("distro").value = s.distro || "Ubuntu";
  $("projectDir").value = s.projectDir || "~/safeT-PTT/sdr-bridge";

  $("autostart").checked = await window.api.getAutoStart();
}

function parseControl(text) {
  return String(text || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Math.round(Number(x) * MHZ))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function saveSettings() {
  const btn = $("saveBtn");
  const msg = $("saveMsg");
  btn.disabled = true;
  msg.className = "save-msg";
  msg.textContent = "Saving…";

  const num = (id) => ($(id).value !== "" ? Number($(id).value) : undefined);
  const mhzToHz = (id) => ($(id).value ? Math.round(Number($(id).value) * MHZ) : undefined);

  // Dongle 1 (always present) + optional dongle 2 -> a `sources` array.
  const sources = [
    { device: 0, centerHz: mhzToHz("centerMHz"), gain: num("gain"), ppm: num("ppm"), rateHz: num("rateHz") },
  ];
  if ($("dongle2on").checked) {
    sources.push({
      device: $("d2device").value !== "" ? Number($("d2device").value) : 1,
      centerHz: mhzToHz("d2center"),
      gain: num("d2gain"),
      ppm: num("d2ppm"),
      rateHz: num("rateHz"),
    });
  }

  const patch = {
    sources,
    system: {
      controlChannelsHz: parseControl($("controlMHz").value),
      modulation: $("modulation").value,
    },
    icecast: {
      sourcePassword: $("icecastSource").value || undefined,
      adminPassword: $("icecastAdmin").value || undefined,
    },
    safet: {
      baseUrl: $("safetUrl").value || undefined,
      username: $("safetUser").value || undefined,
      password: $("safetPass").value || undefined,
    },
  };
  // Drop undefined leaves so we never overwrite a value with nothing
  // (skip `sources` — it's an array we want written whole).
  for (const [key, sect] of Object.entries(patch)) {
    if (key === "sources" || typeof sect !== "object") continue;
    for (const k of Object.keys(sect)) if (sect[k] === undefined) delete sect[k];
  }

  try {
    await window.api.saveSettings({ distro: $("distro").value || "Ubuntu", projectDir: $("projectDir").value || "~/safeT-PTT/sdr-bridge" });
    const res = await window.api.saveConfig(patch);
    if (!res || !res.ok) throw new Error((res && res.error) || "write failed");

    const want = $("autostart").checked;
    if (want !== (await window.api.getAutoStart())) {
      await window.api.setAutoStart(want);
    }
    msg.textContent = "Saved. Restart streaming to apply radio changes.";
  } catch (e) {
    msg.className = "save-msg err";
    msg.textContent = "Couldn't save: " + (e.message || e);
  } finally {
    btn.disabled = false;
    setTimeout(() => (msg.textContent = ""), 6000);
  }
}
$("saveBtn").addEventListener("click", saveSettings);
$("dongle2on").addEventListener("change", () => {
  $("dongle2fields").hidden = !$("dongle2on").checked;
});

// ---- start / stop --------------------------------------------------------
function setRunState(state) {
  const el = $("runState");
  el.className = "run-state " + (state === "on" ? "on" : state === "starting" ? "starting" : "");
  el.textContent = state === "on" ? "Running" : state === "starting" ? "Starting…" : "Stopped";
  $("startBtn").hidden = state === "on" || state === "starting";
  $("stopBtn").hidden = !($("startBtn").hidden);
  $("startBtn").disabled = state === "starting";
}

$("startBtn").addEventListener("click", async () => {
  setRunState("starting");
  document.querySelector('.tab[data-tab="logs"]').click();
  try {
    const res = await window.api.start();
    if (res && res.dongle === false) {
      const hint = $("dongleHint");
      hint.hidden = false;
      hint.textContent = "⚠ " + (res.dongleMessage || "The SDR dongle isn't attached.");
    }
    setRunState("on");
  } catch (e) {
    toast("Start failed: " + (e.message || e));
    setRunState("off");
  }
});

$("stopBtn").addEventListener("click", async () => {
  $("stopBtn").disabled = true;
  try {
    await window.api.stop();
  } finally {
    $("stopBtn").disabled = false;
    setRunState("off");
  }
});

$("openSafet").addEventListener("click", () => window.api.openSafeT());

// ---- status polling ------------------------------------------------------
function setCard(id, cls, text) {
  const card = $(id);
  card.className = "card " + cls;
  card.querySelector("p").textContent = text;
}

async function poll() {
  let s;
  try {
    s = await window.api.getStatus();
  } catch {
    return;
  }

  setCard("card-wsl", s.wsl ? "ok" : "bad", s.wsl ? "Ready" : "Not reachable");
  setCard("card-dongle", s.dongle ? "ok" : "bad", s.dongle ? "Attached" : "Not attached");

  if (!s.decoder.running) setCard("card-decoder", "bad", "Stopped");
  else if (s.decoder.decodeRate && s.decoder.decodeRate > 0)
    setCard("card-decoder", "ok", `Locked ${s.decoder.controlChannel || ""} · ${s.decoder.decodeRate}/s`.trim());
  else setCard("card-decoder", "warn", "Running, acquiring lock…");

  if (!s.icecast.up) setCard("card-icecast", "bad", "Down");
  else if (s.icecast.mounts > 0) setCard("card-icecast", "ok", `${s.icecast.mounts} mounts live`);
  else setCard("card-icecast", "warn", "Up, no mounts yet");

  if (s.cloudflared === "Running") setCard("card-tunnel", "ok", "Running");
  else if (s.cloudflared === "NotInstalled") setCard("card-tunnel", "warn", "Not installed");
  else setCard("card-tunnel", "warn", s.cloudflared || "Unknown");

  const running = s.decoder.running || s.pipelineRunning;
  if (running && $("runState").textContent !== "Starting…") setRunState("on");
  else if (!running && $("runState").textContent === "Running") setRunState("off");

  if (s.dongle) $("dongleHint").hidden = true;
}

// ---- logs ----------------------------------------------------------------
const logView = $("logView");
function appendLog(line) {
  logView.textContent += line + "\n";
  if (logView.textContent.length > 200000) logView.textContent = logView.textContent.slice(-150000);
  if ($("autoscroll").checked) logView.scrollTop = logView.scrollHeight;
}
window.api.onLog(appendLog);

$("refreshLog").addEventListener("click", async () => {
  const text = await window.api.recentLog(300);
  logView.textContent = text;
  if ($("autoscroll").checked) logView.scrollTop = logView.scrollHeight;
});
$("clearLog").addEventListener("click", () => (logView.textContent = ""));

// ---- boot ----------------------------------------------------------------
(async function init() {
  await loadSettings();
  const env = await window.api.detectEnv();
  if (!env.wsl) toast("WSL isn't reachable — run the one-time Setup first.");
  else if (!env.repo) toast("Project folder not found in WSL — check Advanced settings.");
  setRunState((await window.api.isRunning()) ? "on" : "off");
  poll();
  setInterval(poll, 4000);
})();
