"use strict";
/**
 * Orchestrator — all the Windows/WSL plumbing the UI drives.
 *
 * Everything the user used to type by hand lives here:
 *   - attach/detach the RTL-SDR via usbipd (elevated)
 *   - read/write the WSL-side config/system.json (no JSON editing)
 *   - start/stop the decoder+streaming pipeline (`npm start` in WSL)
 *   - report live status (dongle, decoder lock, Icecast mounts, tunnel)
 *
 * The renderer never touches any of this directly — it goes through IPC in
 * main.js, which calls these functions.
 */

const { app, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULTS = { distro: "Ubuntu", projectDir: "~/safeT-PTT/sdr-bridge" };

// ---- app settings (distro / projectDir) ---------------------------------

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}
function getSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

function scriptsDir() {
  // Packaged: resources/scripts. Dev: ../scripts next to src/.
  return app.isPackaged
    ? path.join(process.resourcesPath, "scripts")
    : path.join(__dirname, "..", "scripts");
}

// ---- low-level runners ---------------------------------------------------

/** Run a bash command inside WSL. Resolves { code, stdout, stderr } (never rejects). */
function runWsl(cmd, { timeout = 15000 } = {}) {
  const { distro } = getSettings();
  return new Promise((resolve) => {
    execFile(
      "wsl.exe",
      ["-d", distro, "--", "bash", "-lc", cmd],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === "number" ? err.code : err ? 1 : 0, stdout: stdout || "", stderr: stderr || "" });
      },
    );
  });
}

/** Run a bash command in WSL, feeding `input` to its stdin. For writing files. */
function runWslStdin(cmd, input, { timeout = 15000 } = {}) {
  const { distro } = getSettings();
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", ["-d", distro, "--", "bash", "-lc", cmd], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stderr });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

function runPowershell(psArgs, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", ...psArgs],
      { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout: stdout || "", stderr: stderr || "" }),
    );
  });
}

// ---- environment detection (first-run wizard) ----------------------------

async function detectEnvironment() {
  const { distro, projectDir } = getSettings();
  const out = { distro, projectDir, wsl: false, repo: false, usbipd: false, dongle: false };

  const ping = await runWsl("echo ok", { timeout: 8000 });
  out.wsl = ping.stdout.trim() === "ok";
  if (out.wsl) {
    const repo = await runWsl(`[ -f ${projectDir}/package.json ] && echo yes || echo no`);
    out.repo = repo.stdout.trim() === "yes";
    const dongle = await runWsl("lsusb 2>/dev/null | grep -iq '2838\\|2832\\|RTL' && echo yes || echo no");
    out.dongle = dongle.stdout.trim() === "yes";
  }
  const usb = await runPowershell(["-Command", "if (Get-Command usbipd -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }"], { timeout: 15000 });
  out.usbipd = usb.stdout.trim() === "yes";
  return out;
}

// ---- config read / write -------------------------------------------------

/** Read config/system.json (seeding it from the example on first run). */
async function readConfig() {
  const { projectDir } = getSettings();
  await runWsl(`cd ${projectDir} && [ -f config/system.json ] || cp config/system.example.json config/system.json`);
  const res = await runWsl(`cat ${projectDir}/config/system.json`);
  let parsed = {};
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    /* leave {} — UI shows blanks */
  }
  return parsed;
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Merge form values into the existing config (preserving comments) and save. */
async function writeConfig(patch) {
  const { projectDir } = getSettings();
  const current = await readConfig();
  const next = deepMerge(current, patch);
  const json = JSON.stringify(next, null, 2) + "\n";
  const res = await runWslStdin(`cat > ${projectDir}/config/system.json`, json);
  return { ok: res.code === 0, error: res.stderr };
}

// ---- dongle attach / detach (elevated) -----------------------------------

function usbipdResultFile() {
  return path.join(os.tmpdir(), "safet-sdr-usbipd.txt");
}

/** Launch the elevated usbipd helper (one UAC prompt) and wait for it. */
async function runElevatedUsbipd(action) {
  const script = path.join(scriptsDir(), "attach-dongle.ps1");
  try {
    fs.rmSync(usbipdResultFile(), { force: true });
  } catch {
    /* ignore */
  }
  // Start-Process -Verb RunAs triggers UAC; -Wait blocks until the helper exits.
  const inner =
    `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ` +
    `'-NoProfile','-ExecutionPolicy','Bypass','-File','${script}','-Action','${action}'`;
  await runPowershell(["-Command", inner], { timeout: 120000 });
  let result = "";
  try {
    result = fs.readFileSync(usbipdResultFile(), "utf8").trim();
  } catch {
    /* helper may not have written it */
  }
  return result;
}

async function attachDongle() {
  const result = await runElevatedUsbipd("attach");
  // The real proof is whether WSL can see it now.
  const seen = await runWsl("lsusb 2>/dev/null | grep -iq '2838\\|2832\\|RTL' && echo yes || echo no");
  const ok = seen.stdout.trim() === "yes";
  let message = ok ? "Dongle attached and visible in WSL." : "Dongle not visible in WSL yet.";
  if (!ok && result.startsWith("ERROR")) {
    if (result.includes("no-device")) message = "No RTL-SDR found. Is it plugged in?";
    else if (result.includes("usbipd-not-installed")) message = "usbipd isn't installed. Run the one-time Setup.";
    else if (result.includes("attach-failed")) message = "Attach failed — try a different USB port (a bus-id clash), then retry.";
  }
  return { ok, message, raw: result };
}

async function detachDongle() {
  const result = await runElevatedUsbipd("detach");
  return { ok: true, raw: result };
}

// ---- pipeline start / stop ----------------------------------------------

let pipelineChild = null;
let onLogLine = () => {};
let notifyFn = () => {};
let armed = false; // user wants it running (drives the watchdog)

function setLogSink(fn) {
  onLogLine = typeof fn === "function" ? fn : () => {};
}
function setNotifier(fn) {
  notifyFn = typeof fn === "function" ? fn : () => {};
}
function notify(title, body) {
  if (getSettings().notifications === false) return;
  try {
    notifyFn(title, body);
  } catch {
    /* ignore */
  }
}

function pipelineRunning() {
  return pipelineChild != null && !pipelineChild.killed;
}

const CLEANUP_CMD =
  `cd ${getSettings().projectDir} 2>/dev/null; ` +
  `docker compose down >/dev/null 2>&1; ` +
  `pkill -9 -f scripts/run-all.sh 2>/dev/null; ` +
  `pkill -9 -f stream-talkgroups 2>/dev/null; ` +
  `pkill -9 -f udp-pcm.py 2>/dev/null; ` +
  `pkill -9 -f local-bridge.mjs 2>/dev/null; ` +
  `pkill -9 -f 'i udp://127.0.0.1:9' 2>/dev/null; ` +
  `pkill -9 icecast2 2>/dev/null; ` +
  `pkill -9 -f 'icecast://source' 2>/dev/null; true`;

function spawnPipeline() {
  const { distro, projectDir, streamBase } = getSettings();
  // If a public stream URL is set (cloud SafeT), pass it so the sync step
  // repoints every bridge to <streamBase>/tg<NNN> — the address the SafeT
  // server can actually reach. Blank = SafeT runs on this PC (localhost).
  const env = streamBase ? `SDR_STREAM_BASE='${streamBase}' ` : "";
  if (streamBase) onLogLine(`[start] SafeT will pull audio from ${streamBase}`);
  onLogLine("[start] launching decoder + streaming…");
  const child = spawn("wsl.exe", ["-d", distro, "--", "bash", "-lc", `cd ${projectDir} && ${env}npm start`], {
    windowsHide: true,
  });
  pipelineChild = child;
  const pump = (buf) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) if (line.trim()) onLogLine(line);
  };
  child.stdout.on("data", pump);
  child.stderr.on("data", pump);
  child.on("close", (code) => {
    onLogLine(`[stopped] pipeline process exited (code ${code ?? 0}).`);
    if (pipelineChild === child) pipelineChild = null;
  });
}

/** Re-attach the dongle without a UAC prompt when possible (uses the login
 * scheduled task created by auto-start); falls back to the elevated attach. */
async function reattachQuiet() {
  const r = await runPowershell(
    ["-Command", "try { Start-ScheduledTask -TaskName 'SafeT SDR Dongle Attach' -ErrorAction Stop; 'ok' } catch { 'no' }"],
    { timeout: 20000 },
  );
  if (r.stdout.includes("ok")) {
    await new Promise((res) => setTimeout(res, 2500));
    return true;
  }
  await attachDongle(); // UAC fallback
  return true;
}

/** Attach the dongle, then run the full stack (Icecast + streamers + decoder).
 * `quiet` (used by login auto-start) avoids the UAC prompt by leaning on the
 * scheduled task that already attached the dongle at boot. */
async function startPipeline({ quiet = false } = {}) {
  if (pipelineRunning()) return { ok: true, already: true };
  armed = true;
  try {
    onLogLine(`[app] SafeT SDR v${app.getVersion()}`);
  } catch {
    /* dev run without packaging */
  }
  let dongleOk = true;
  let dongleMessage = "Dongle already attached.";

  // Only attach (and trigger UAC) if the dongle isn't already visible in WSL.
  const seen = await runWsl("lsusb 2>/dev/null | grep -iq '2838\\|2832\\|RTL' && echo yes || echo no");
  if (seen.stdout.trim() !== "yes") {
    if (quiet) {
      await reattachQuiet();
      dongleMessage = "Attached via login task.";
    } else {
      const attach = await attachDongle();
      dongleOk = attach.ok;
      dongleMessage = attach.message;
    }
  }
  onLogLine(`[dongle] ${dongleMessage}`);

  // Self-update: the pipeline scripts run straight out of the WSL repo, so a
  // pull here means every Start runs the latest code with no rebuild (only UI
  // changes to this app need a rebuild). Offline or a dirty tree just logs.
  const { projectDir } = getSettings();
  const pull = await runWsl(
    `cd ${projectDir} && git checkout -q main 2>/dev/null; git pull --ff-only 2>&1 | tail -1`,
    { timeout: 45000 },
  );
  const pulled = (pull.stdout || pull.stderr).trim();
  onLogLine(`[update] ${pulled || "(could not check for updates — using existing code)"}`);

  spawnPipeline();
  return { ok: true, dongle: dongleOk, dongleMessage };
}

/** Stop everything: clean up the WSL side, then kill the launcher process.
 * Leaves the dongle attached by default so the next Start needs no UAC prompt
 * and the signal sweep can use it; only a full Quit detaches it. */
async function stopPipeline({ detach = false } = {}) {
  armed = false;
  onLogLine("[stop] shutting down…");
  await runWsl(CLEANUP_CMD, { timeout: 30000 });
  if (pipelineChild) {
    try {
      pipelineChild.kill();
    } catch {
      /* ignore */
    }
    pipelineChild = null;
  }
  if (detach) await detachDongle();
  onLogLine("[stop] done.");
  return { ok: true };
}

/** Internal restart used by the watchdog — keeps `armed` true. */
async function restartPipeline() {
  await runWsl(CLEANUP_CMD, { timeout: 30000 });
  if (pipelineChild) {
    try {
      pipelineChild.kill();
    } catch {
      /* ignore */
    }
    pipelineChild = null;
  }
  await reattachQuiet();
  spawnPipeline();
}

// ---- watchdog: auto-recover dongle drops / decoder crashes ---------------

let watchdogTimer = null;
let lastRecoverAt = 0;
let lastLocked = null;

/** Strip ANSI color codes — trunk-recorder colorizes its logs, which otherwise
 * breaks regexes that expect e.g. a number right after "TG:". */
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

/** Is the decoder actually locked onto the control channel? trunk-recorder
 * STOPS printing the "Decode Rate" line once it's healthy, so we can't rely on
 * that — instead we look for live trunking activity (following grants, decoding
 * the system) and treat a run of "Decode Rate: 0/sec" errors as lost lock. */
function logShowsLock(text) {
  const clean = stripAnsi(text);
  const zeroRate = (clean.match(/Decode Rate:\s*0\/sec/g) || []).length;
  const activity = /Decoding System ID|RFSS:|Starting P25 Recorder|\bTG:\s*\d/.test(clean);
  return activity && zeroRate < 5;
}

async function watchdogTick() {
  if (!armed) return;
  // Cooldown so we don't thrash while a restart settles.
  if (Date.now() - lastRecoverAt < 45000) return;

  const dongle = await runWsl("lsusb 2>/dev/null | grep -iq '2838\\|2832\\|RTL' && echo yes || echo no", { timeout: 8000 });
  const st = await runWsl("docker ps -a --format '{{.Names}}|{{.Status}}' 2>/dev/null | grep trunk-recorder || echo none", { timeout: 8000 });
  const status = st.stdout.trim();
  const dongleMissing = dongle.stdout.trim() !== "yes";
  const unhealthy = status === "none" || /Restarting|Exited/i.test(status);

  if (dongleMissing || unhealthy) {
    lastRecoverAt = Date.now();
    const reason = dongleMissing ? "SDR dongle dropped" : "decoder crashed";
    onLogLine(`[watchdog] ${reason} — recovering…`);
    notify("SafeT SDR — recovering", `${reason}; re-attaching the dongle and restarting.`);
    try {
      await restartPipeline();
      notify("SafeT SDR — recovered", "Streaming restarted.");
      lastLocked = null;
    } catch (e) {
      onLogLine("[watchdog] recovery error: " + (e.message || e));
    }
    return;
  }

  // Healthy → watch the control-channel lock and notify on transitions.
  const log = await runWsl("docker logs --tail 150 sdr-bridge-trunk-recorder-1 2>&1 | tail -150", { timeout: 8000 });
  const locked = logShowsLock(log.stdout);
  if (lastLocked !== null && locked !== lastLocked) {
    if (locked) notify("SafeT SDR — locked", "Control channel locked; decoding.");
    else notify("SafeT SDR — lost lock", "Control channel decode dropped.");
  }
  lastLocked = locked;
}

function startWatchdog() {
  if (!watchdogTimer) watchdogTimer = setInterval(() => watchdogTick().catch(() => {}), 15000);
}
function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

// ---- scan for connected dongles ------------------------------------------

/**
 * Report the RTL-SDRs Windows sees (via usbipd) and, for any attached to WSL,
 * their index -> serial mapping (via rtl_test) so the user can pick the right
 * `device` index for a second dongle.
 */
async function listDongles() {
  const result = { windowsCount: 0, windows: [], wsl: [], wslError: null };

  const ps = await runPowershell(["-Command", "usbipd list"], { timeout: 15000 });
  for (const line of ps.stdout.split(/\r?\n/)) {
    const b = line.match(/(\d+-\d+)\s+0bda:283[28]/);
    if (b) {
      const st = line.match(/(Attached|Shared|Not shared|Not attached)\s*$/);
      result.windows.push({ busid: b[1], state: st ? st[1] : "?" });
    }
  }
  result.windowsCount = result.windows.length;

  // rtl_test lists every device (index, name, serial) before it tries to open
  // one, so this works even while trunk-recorder is using the dongles.
  const rt = await runWsl("timeout 4 rtl_test 2>&1 | head -25 || true", { timeout: 9000 });
  for (const line of rt.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+):\s+(.+?),\s*SN:\s*(\S+)/);
    if (m) result.wsl.push({ index: Number(m[1]), name: m[2].trim(), serial: m[3] });
  }
  if (result.wsl.length === 0) {
    if (/No supported devices|usb_open error|No such/i.test(rt.stdout)) result.wslError = "No dongles attached to WSL yet.";
    else if (!/Found/i.test(rt.stdout)) result.wslError = "Couldn't read dongles in WSL (rtl-sdr tools / none attached).";
  }
  return result;
}

// ---- live status ---------------------------------------------------------

let cfCache = { value: "unknown", at: 0 };

async function getStatus() {
  const status = {
    wsl: false,
    dongle: false,
    pipelineRunning: pipelineRunning(),
    decoder: { running: false, locked: false, controlChannel: null, decodeRate: null },
    bridge: { running: false, channels: 0 },
    cloudflared: "unknown",
  };

  const ping = await runWsl("echo ok", { timeout: 6000 });
  status.wsl = ping.stdout.trim() === "ok";
  if (!status.wsl) return status;

  const dongle = await runWsl("lsusb 2>/dev/null | grep -iq '2838\\|2832\\|RTL' && echo yes || echo no");
  status.dongle = dongle.stdout.trim() === "yes";

  const ps = await runWsl("docker ps --format '{{.Names}}|{{.Status}}' 2>/dev/null | grep trunk-recorder || true");
  status.decoder.running = ps.stdout.trim().length > 0;

  if (status.decoder.running) {
    const log = await runWsl("docker logs --tail 200 sdr-bridge-trunk-recorder-1 2>&1 | tail -200");
    const text = stripAnsi(log.stdout);
    // Control-channel frequency: the last one it locked / retuned to.
    const ccs = [...text.matchAll(/Control Channel:\s*(\d{3}\.\d+)\s*MHz/g)];
    if (ccs.length) status.decoder.controlChannel = ccs[ccs.length - 1][1] + " MHz";
    const rates = [...text.matchAll(/Decode Rate:\s*([\d.]+)\/sec/g)];
    if (rates.length) status.decoder.decodeRate = Number(rates[rates.length - 1][1]);
    status.decoder.locked = logShowsLock(text);
  }

  // Local SafeT bridge: a single source of truth — the status file the bridge
  // rewrites at least every 5s. Its own updatedAt stamp decides liveness (a
  // second wsl.exe call for stat/date proved flaky and showed false "Stopped").
  status.bridge = { running: false, channels: 0 };
  status.channels = [];
  const stj = await runWsl("cat /tmp/sdr-bridge-status.json 2>/dev/null || echo '{}'");
  try {
    const detail = JSON.parse(stj.stdout);
    status.bridge.running = Number.isFinite(detail.updatedAt) && Date.now() - detail.updatedAt < 15000;
    if (status.bridge.running && Array.isArray(detail.bridges)) {
      status.channels = detail.bridges;
      status.bridge.channels = detail.bridges.filter((c) => c.state === "on air").length;
    }
  } catch {
    /* partial write — next poll gets it */
  }

  // When the bridge is down, surface WHY on the dashboard card instead of a
  // bare "Stopped" (the cause lives in /tmp/sdr-bridge.log, which nobody reads).
  if (!status.bridge.running) {
    const t = await runWsl(
      "grep -v '^\\s*$' /tmp/sdr-bridge.log 2>/dev/null | tail -1 | cut -c1-140",
    );
    status.bridge.lastLog = t.stdout.trim();
  }

  // cloudflared is a Windows service that rarely changes — cache it ~30s so the
  // frequent status poll doesn't spawn powershell.exe every few seconds.
  if (Date.now() - cfCache.at > 30000) {
    const cf = await runPowershell(
      ["-Command", "$s = Get-Service cloudflared -ErrorAction SilentlyContinue; if ($s) { $s.Status.ToString() } else { 'NotInstalled' }"],
      { timeout: 15000 },
    );
    cfCache = { value: cf.stdout.trim() || "unknown", at: Date.now() };
  }
  status.cloudflared = cfCache.value;

  return status;
}

// ---- recent decoder log (for the log viewer) -----------------------------

async function recentDecoderLog(lines = 200) {
  const res = await runWsl(`docker logs --tail ${lines} sdr-bridge-trunk-recorder-1 2>&1 || echo '(decoder not running)'`);
  return res.stdout;
}

// ---- signal tuner (rtl_power sweep) --------------------------------------

/** Sweep a frequency range and report the strongest bins (the peak is usually
 * the control channel). Needs exclusive use of the dongle, so stop first. */
async function runSweep(startMHz, endMHz, gain) {
  if (pipelineRunning()) {
    return { ok: false, error: "Stop streaming first — the tuner needs exclusive use of the dongle." };
  }
  const s = Number(startMHz), e = Number(endMHz);
  if (!(e > s)) return { ok: false, error: "End frequency must be above start." };
  if (e - s > 30) return { ok: false, error: "Keep the span under 30 MHz." };
  const g = gain !== undefined && gain !== null && gain !== "" ? Number(gain) : 40;

  // The dongle must be attached to WSL for rtl_power to open it.
  const seen = await runWsl("lsusb 2>/dev/null | grep -iq '2838\\|2832\\|RTL' && echo yes || echo no");
  if (seen.stdout.trim() !== "yes") {
    onLogLine("[tuner] attaching dongle for sweep…");
    await reattachQuiet();
  }

  const cmd = `rm -f /tmp/sweep.csv; timeout 25 rtl_power -f ${s}M:${e}M:25k -g ${g} -i 1 -1 /tmp/sweep.csv 2>/dev/null; cat /tmp/sweep.csv 2>/dev/null`;
  const res = await runWsl(cmd, { timeout: 35000 });
  if (!res.stdout.trim()) return { ok: false, error: "No sweep data — is the dongle attached and not in use?" };

  const bins = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const parts = line.split(",").map((x) => x.trim());
    if (parts.length < 7) continue;
    const low = Number(parts[2]), step = Number(parts[4]);
    if (!Number.isFinite(low) || !Number.isFinite(step)) continue;
    const dbs = parts.slice(6).map(Number);
    for (let i = 0; i < dbs.length; i++) {
      const f = low + i * step;
      if (Number.isFinite(f) && Number.isFinite(dbs[i])) bins.push({ hz: f, db: dbs[i] });
    }
  }
  if (!bins.length) return { ok: false, error: "Couldn't parse the sweep output." };
  bins.sort((a, b) => b.db - a.db);
  const peak = bins[0];
  // De-dupe nearby peaks (within 100 kHz) for a cleaner top list.
  const top = [];
  for (const b of bins) {
    if (top.length >= 8) break;
    if (top.some((t) => Math.abs(t.hz - b.hz) < 100000)) continue;
    top.push(b);
  }
  return {
    ok: true,
    peakHz: Math.round(peak.hz),
    peakMHz: +(peak.hz / 1e6).toFixed(4),
    peakDb: +peak.db.toFixed(1),
    suggestedCenterHz: Math.round(peak.hz),
    top: top.map((b) => ({ mhz: +(b.hz / 1e6).toFixed(4), db: +b.db.toFixed(1) })),
  };
}

// ---- talkgroup activity report -------------------------------------------

/** Tally decoder activity per talkgroup: real voice vs encrypted vs out-of-range. */
async function talkgroupReport() {
  const { projectDir } = getSettings();
  const names = {};
  const bridged = new Set();
  const csv = await runWsl(`cat ${projectDir}/trunk-recorder/talkgroups.csv 2>/dev/null || true`);
  for (const line of csv.stdout.split(/\r?\n/).slice(1)) {
    const c = line.split(",");
    const id = (c[0] || "").trim();
    if (/^\d+$/.test(id)) {
      names[id] = (c[2] || "").trim();
      // The generated CSV holds the whole system's talkgroups for labeling;
      // only Category "SDR" rows are actually bridged to SafeT channels.
      if ((c[6] || "").trim() === "SDR") bridged.add(Number(id));
    }
  }

  const log = await runWsl("docker logs --tail 5000 sdr-bridge-trunk-recorder-1 2>&1 || true", { timeout: 25000 });
  const stats = {};
  const get = (t) => (stats[t] || (stats[t] = { voice: 0, enc: 0, nosrc: 0 }));
  // trunk-recorder colorizes its output; strip ANSI codes so "TG: <n>" parses
  // (the escape sequence sits between "TG:" and the number).
  for (const line of stripAnsi(log.stdout).split(/\r?\n/)) {
    const m = line.match(/TG:\s*(\d+)/);
    if (!m) continue;
    const t = m[1];
    if (line.includes("Starting P25 Recorder")) get(t).voice++;
    else if (line.includes("ENCRYPTED")) get(t).enc++;
    else if (line.includes("no source covering Freq")) get(t).nosrc++;
  }

  const rows = Object.entries(stats).map(([tgid, s]) => ({
    tgid: Number(tgid),
    name: names[tgid] || "",
    bridged: bridged.has(Number(tgid)),
    ...s,
  }));
  // Bridged first, then by most voice, then by most activity.
  rows.sort(
    (a, b) =>
      Number(b.bridged) - Number(a.bridged) ||
      b.voice - a.voice ||
      b.enc + b.nosrc - (a.enc + a.nosrc),
  );
  return { rows, bridgedCount: bridged.size };
}

// ---- diagnostics bundle --------------------------------------------------

function redactSecrets(obj) {
  const SECRET = /password|secret|token/i;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[k] = SECRET.test(k) && val ? "***" : walk(val);
      return o;
    }
    return v;
  };
  return walk(obj);
}

/** Gather logs + redacted config + environment into one text blob for support. */
async function collectDiagnostics() {
  const { distro, projectDir } = getSettings();
  const parts = [];
  const sec = (title, body) => parts.push(`\n===== ${title} =====\n${(body || "").toString().trim() || "(empty)"}\n`);

  parts.push(`SafeT SDR diagnostics — ${new Date().toISOString()}`);
  try {
    parts.push(`app ${app.getVersion()} · distro=${distro} · projectDir=${projectDir}`);
  } catch {
    /* ignore */
  }

  try {
    sec("config/system.json (secrets redacted)", JSON.stringify(redactSecrets(await readConfig()), null, 2));
  } catch {
    sec("config/system.json", "(could not read)");
  }

  const cmds = [
    ["dongle (lsusb)", "lsusb 2>/dev/null | grep -i 'RTL\\|2838\\|2832' || echo none"],
    ["rtl devices", "timeout 4 rtl_test 2>&1 | head -8 || true"],
    ["docker ps", "docker ps -a --format '{{.Names}} | {{.Status}}' 2>/dev/null || echo 'docker not reachable'"],
    ["bridged talkgroups (talkgroups.csv)", `head -15 ${projectDir}/trunk-recorder/talkgroups.csv 2>/dev/null || echo none`],
    ["bridge channel status (live)", "cat /tmp/sdr-bridge-status.json 2>/dev/null | head -c 5000 || echo none"],
    ["recent talkgroup activity (decoder)", "docker logs --tail 4000 sdr-bridge-trunk-recorder-1 2>&1 | grep -E 'TG: ' | tail -50 || echo none"],
    ["icecast status", "curl -s --max-time 2 http://127.0.0.1:8000/status-json.xsl | head -c 1500 || true"],
    ["icecast log (tail)", "tail -40 /tmp/sdr-icecast.log 2>/dev/null || echo none"],
    ["streamer log (tail)", "tail -40 /tmp/sdr-streamers.log 2>/dev/null || echo none"],
    ["safet bridge log (tail)", "tail -60 /tmp/sdr-bridge.log 2>/dev/null || echo none"],
    ["decoder log (tail)", "docker logs --tail 150 sdr-bridge-trunk-recorder-1 2>&1 | tail -150 || echo none"],
    // The decode-vs-delivery tiebreaker: the decoder writes one audio file per
    // call. For .wav, bytes/16000 = seconds of actual decoded audio; compare
    // against the radio airtime in the transmission log. Full-length files =
    // decode fine, audio lost downstream; tiny files = decode is the bottleneck.
    [
      "decoder recordings (newest 15)",
      "docker exec sdr-bridge-trunk-recorder-1 sh -c " +
        "'find /tmp/trunk-recorder -type f \\( -name \"*.wav\" -o -name \"*.m4a\" \\) -printf \"%T@ %s %p\\n\" 2>/dev/null | sort -rn | head -15' " +
        "2>/dev/null | awk '{printf \"%10d bytes  %s\\n\", $2, $3}' || echo none",
    ],
    [
      "decoder recordings — true durations (newest 5, via ffprobe)",
      "docker exec sdr-bridge-trunk-recorder-1 sh -c " +
        "'for f in $(find /tmp/trunk-recorder -type f \\( -name \"*.wav\" -o -name \"*.m4a\" \\) -printf \"%T@ %p\\n\" 2>/dev/null | sort -rn | head -5 | cut -d\" \" -f2); do " +
        "d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 \"$f\" 2>/dev/null); echo \"$d sec  $f\"; done' 2>/dev/null || echo none",
    ],
  ];
  for (const [title, cmd] of cmds) {
    const r = await runWsl(cmd, { timeout: 20000 });
    sec(title, r.stdout || r.stderr);
  }

  const usb = await runPowershell(["-Command", "usbipd list 2>$null | Out-String"], { timeout: 15000 });
  sec("usbipd list (Windows)", usb.stdout);
  const cf = await runPowershell(
    ["-Command", "$s = Get-Service cloudflared -ErrorAction SilentlyContinue; if ($s) { $s.Status.ToString() } else { 'NotInstalled' }"],
    { timeout: 15000 },
  );
  sec("cloudflared service", cf.stdout);

  return parts.join("\n");
}

// ---- open the SafeT console in the browser -------------------------------

async function openSafeT() {
  const cfg = await readConfig();
  let url = (cfg && cfg.safet && cfg.safet.baseUrl) || "";
  url = url.replace(/\/v1\/?$/, "");
  if (!/^https?:\/\//.test(url)) url = "http://127.0.0.1:8080";
  await shell.openExternal(url);
  return { ok: true, url };
}

// ---- auto-start on login -------------------------------------------------

async function setAutoStart(enabled) {
  // 1) Launch the app (hidden) at login.
  app.setLoginItemSettings({ openAtLogin: !!enabled, args: ["--hidden"] });

  // 2) Auto-attach the dongle at login via a scheduled task (needs admin once).
  //    Write the registration to a temp .ps1 and run THAT elevated — far more
  //    robust than nesting quotes through Start-Process -ArgumentList, which
  //    breaks on the space in the "SafeT SDR" install path.
  const taskName = "SafeT SDR Dongle Attach";
  const script = path.join(scriptsDir(), "attach-dongle.ps1");
  const body = enabled
    ? [
        `$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}" -Action attach'`,
        `$t = New-ScheduledTaskTrigger -AtLogOn`,
        `$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`,
        `Register-ScheduledTask -TaskName '${taskName}' -Action $a -Trigger $t -RunLevel Highest -Force | Out-Null`,
      ].join("\n")
    : `Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue`;

  const tmp = path.join(os.tmpdir(), "safet-sdr-autostart.ps1");
  fs.writeFileSync(tmp, body, "utf8");
  const inner = `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${tmp}'`;
  await runPowershell(["-Command", inner], { timeout: 60000 });
  return { ok: true, enabled: !!enabled };
}

function getAutoStart() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

module.exports = {
  getSettings,
  saveSettings,
  detectEnvironment,
  readConfig,
  writeConfig,
  attachDongle,
  detachDongle,
  listDongles,
  startPipeline,
  stopPipeline,
  pipelineRunning,
  setLogSink,
  setNotifier,
  startWatchdog,
  stopWatchdog,
  runSweep,
  talkgroupReport,
  getStatus,
  recentDecoderLog,
  collectDiagnostics,
  openSafeT,
  setAutoStart,
  getAutoStart,
};
