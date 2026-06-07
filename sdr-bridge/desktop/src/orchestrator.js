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

function setLogSink(fn) {
  onLogLine = typeof fn === "function" ? fn : () => {};
}

function pipelineRunning() {
  return pipelineChild != null && !pipelineChild.killed;
}

/** Attach the dongle, then run the full stack (Icecast + streamers + decoder). */
async function startPipeline() {
  if (pipelineRunning()) return { ok: true, already: true };

  const attach = await attachDongle();
  onLogLine(`[dongle] ${attach.message}`);

  const { distro, projectDir } = getSettings();
  onLogLine("[start] launching decoder + streaming…");
  const child = spawn("wsl.exe", ["-d", distro, "--", "bash", "-lc", `cd ${projectDir} && npm start`], {
    windowsHide: true,
  });
  pipelineChild = child;

  const pump = (buf) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) onLogLine(line);
    }
  };
  child.stdout.on("data", pump);
  child.stderr.on("data", pump);
  child.on("close", (code) => {
    onLogLine(`[stopped] pipeline exited (code ${code ?? 0}).`);
    if (pipelineChild === child) pipelineChild = null;
  });

  return { ok: true, dongle: attach.ok, dongleMessage: attach.message };
}

/** Stop everything: clean up the WSL side, then kill the launcher process. */
async function stopPipeline({ detach = true } = {}) {
  onLogLine("[stop] shutting down…");
  await runWsl(
    `cd ${getSettings().projectDir} 2>/dev/null; ` +
      `docker compose down >/dev/null 2>&1; ` +
      `pkill -9 -f scripts/run-all.sh 2>/dev/null; ` +
      `pkill -9 -f stream-talkgroups 2>/dev/null; ` +
      `pkill -9 icecast2 2>/dev/null; ` +
      `pkill -9 -f 'icecast://source' 2>/dev/null; true`,
    { timeout: 30000 },
  );
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

// ---- live status ---------------------------------------------------------

async function getStatus() {
  const status = {
    wsl: false,
    dongle: false,
    pipelineRunning: pipelineRunning(),
    decoder: { running: false, controlChannel: null, decodeRate: null },
    icecast: { up: false, mounts: 0, names: [] },
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
    const log = await runWsl(
      "docker logs --tail 250 sdr-bridge-trunk-recorder-1 2>&1 | grep -E 'Control Channel Message Decode Rate|Started with Control Channel' | tail -1",
    );
    const m = log.stdout.match(/Decode Rate:\s*([\d.]+)\/sec/);
    if (m) status.decoder.decodeRate = Number(m[1]);
    const cc = log.stdout.match(/(\d{3}\.\d+)\s*MHz/);
    if (cc) status.decoder.controlChannel = cc[1] + " MHz";
  }

  const ice = await runWsl("curl -s --max-time 2 http://127.0.0.1:8000/status-json.xsl || true");
  if (ice.stdout.includes("icestats")) {
    status.icecast.up = true;
    try {
      const data = JSON.parse(ice.stdout).icestats;
      let src = data.source || [];
      if (!Array.isArray(src)) src = [src];
      status.icecast.names = src.map((s) => String(s.listenurl || "").split("/").pop()).filter(Boolean);
      status.icecast.mounts = status.icecast.names.length;
    } catch {
      /* leave defaults */
    }
  }

  const cf = await runPowershell(
    ["-Command", "$s = Get-Service cloudflared -ErrorAction SilentlyContinue; if ($s) { $s.Status.ToString() } else { 'NotInstalled' }"],
    { timeout: 15000 },
  );
  status.cloudflared = cf.stdout.trim() || "unknown";

  return status;
}

// ---- recent decoder log (for the log viewer) -----------------------------

async function recentDecoderLog(lines = 200) {
  const res = await runWsl(`docker logs --tail ${lines} sdr-bridge-trunk-recorder-1 2>&1 || echo '(decoder not running)'`);
  return res.stdout;
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
  const taskName = "SafeT SDR Dongle Attach";
  const script = path.join(scriptsDir(), "attach-dongle.ps1");
  let reg;
  if (enabled) {
    reg =
      `$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ` +
      `'-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"${script}\" -Action attach'; ` +
      `$t = New-ScheduledTaskTrigger -AtLogOn; ` +
      `$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; ` +
      `Register-ScheduledTask -TaskName '${taskName}' -Action $a -Trigger $t -RunLevel Highest -Force | Out-Null`;
  } else {
    reg = `Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue`;
  }
  // Run elevated (one UAC) to (un)register the task.
  const inner = `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',"${reg.replace(/"/g, '\\"')}"`;
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
  startPipeline,
  stopPipeline,
  pipelineRunning,
  setLogSink,
  getStatus,
  recentDecoderLog,
  openSafeT,
  setAutoStart,
  getAutoStart,
};
