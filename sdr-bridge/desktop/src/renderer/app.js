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
    // The pipeline can rewrite config/system.json behind the UI (the RF profile
    // migration runs on every Start) — re-read on open so the form never shows
    // stale values that a Save would then write back.
    if (btn.dataset.tab === "settings") loadSettings().catch(() => {});
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
  // The first source inherits any field it omits from the friendly `sdr` block —
  // matches build.mjs, so a partial {device,rateHz} stub doesn't show the UI a
  // blank Center/Gain (which a Save would then write back, losing the values).
  const d1 = { ...(cfg.sdr || {}), ...(sources[0] || {}) };
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
  $("streamBase").value = s.streamBase || "";

  $("decoder").value = cfg.decoder === "sdrtrunk" ? "sdrtrunk" : "trunk-recorder";
  $("sdrtrunkPath").value = s.sdrtrunkPath || "";
  applyDecoderVisibility();

  $("autostart").checked = await window.api.getAutoStart();
  $("notifications").checked = s.notifications !== false;
}

function applyDecoderVisibility() {
  const isSdrtrunk = $("decoder").value === "sdrtrunk";
  $("sdrtrunkPathBox").hidden = !isSdrtrunk;
  $("sdrtrunkNote").hidden = !isSdrtrunk;
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

  // Center frequency and control channel are the two silent killers: with no
  // center the dongle tunes to the wrong place, and with no control channel a
  // P25 system can't be followed — either way the decoder produces nothing and
  // the bridge looks "stopped" for no obvious reason. Refuse to save that.
  const fail = (text) => {
    msg.className = "save-msg err";
    msg.textContent = text;
    btn.disabled = false;
  };
  const isSdrtrunk = $("decoder").value === "sdrtrunk";
  const centerHz = mhzToHz("centerMHz");
  const controlChannelsHz = parseControl($("controlMHz").value);
  // sdrtrunk owns the radio on Windows, so the center / control-channel fields
  // below don't apply — only validate them for the built-in decoder.
  if (!isSdrtrunk && !centerHz)
    return fail("Enter a center frequency first — without it the decoder tunes to the wrong place and the bridge stays silent.");
  if (!isSdrtrunk && !controlChannelsHz.length)
    return fail("Enter at least one control channel frequency first — a P25 system can't be followed without it.");
  if (!isSdrtrunk && $("dongle2on").checked && !mhzToHz("d2center"))
    return fail("Enter a center frequency for the second dongle, or turn it off.");

  // Dongle 1 (always present) + optional dongle 2 -> a `sources` array.
  const sources = [
    { device: 0, centerHz, gain: num("gain"), ppm: num("ppm"), rateHz: num("rateHz") },
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
    decoder: $("decoder").value === "sdrtrunk" ? "sdrtrunk" : "trunk-recorder",
    sources,
    system: {
      controlChannelsHz,
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
    let streamBase = $("streamBase").value.trim();
    if (streamBase && !/^https?:\/\//i.test(streamBase)) streamBase = "https://" + streamBase;
    await window.api.saveSettings({
      distro: $("distro").value || "Ubuntu",
      projectDir: $("projectDir").value || "~/safeT-PTT/sdr-bridge",
      streamBase,
      sdrtrunkPath: $("sdrtrunkPath").value.trim(),
      notifications: $("notifications").checked,
    });
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
$("decoder").addEventListener("change", applyDecoderVisibility);
$("dongle2on").addEventListener("change", () => {
  $("dongle2fields").hidden = !$("dongle2on").checked;
});

$("scanDongles").addEventListener("click", async () => {
  const out = $("scanResult");
  out.textContent = "Scanning…";
  try {
    const r = await window.api.listDongles();
    let msg = `Windows sees ${r.windowsCount} RTL-SDR${r.windowsCount === 1 ? "" : "s"}.`;
    if (r.wsl && r.wsl.length) {
      msg += " WSL: " + r.wsl.map((d) => `device ${d.index} = SN ${d.serial}`).join(", ") + ".";
    } else if (r.wslError) {
      msg += " " + r.wslError + " Press Start once to attach, then scan again.";
    }
    out.textContent = msg;
  } catch (e) {
    out.textContent = "Scan failed: " + (e.message || e);
  }
});

// ---- signal sweep --------------------------------------------------------
$("sweepBtn").addEventListener("click", async () => {
  const msg = $("sweepMsg");
  const result = $("sweepResult");
  msg.className = "save-msg";
  msg.textContent = "Sweeping… (up to ~25s)";
  result.innerHTML = "";
  try {
    const r = await window.api.sweep($("sweepFrom").value, $("sweepTo").value, $("gain").value);
    if (!r || !r.ok) {
      msg.className = "save-msg err";
      msg.textContent = (r && r.error) || "Sweep failed.";
      return;
    }
    msg.textContent = "";
    const rows = r.top
      .map((b) => `<tr><td>${b.mhz.toFixed(4)} MHz</td><td>${b.db} dB</td></tr>`)
      .join("");
    result.innerHTML =
      `<p><strong>Strongest:</strong> ${r.peakMHz.toFixed(4)} MHz (${r.peakDb} dB) — likely the control channel.</p>` +
      `<div class="sweep-actions">` +
      `<button type="button" class="btn-sm" id="useD1">Use as Dongle 1 center</button>` +
      `<button type="button" class="btn-sm" id="useD2">Use as Dongle 2 center</button>` +
      `</div>` +
      `<table class="report mini"><thead><tr><th>Frequency</th><th>Level</th></tr></thead><tbody>${rows}</tbody></table>`;
    $("useD1").addEventListener("click", () => {
      $("centerMHz").value = r.peakMHz.toFixed(4);
      toast("Set Dongle 1 center — Save to apply.");
    });
    $("useD2").addEventListener("click", () => {
      $("dongle2on").checked = true;
      $("dongle2fields").hidden = false;
      $("d2center").value = r.peakMHz.toFixed(4);
      toast("Set Dongle 2 center — Save to apply.");
    });
  } catch (e) {
    msg.className = "save-msg err";
    msg.textContent = "Sweep failed: " + (e.message || e);
  }
});

// ---- coverage / talkgroup activity ---------------------------------------
$("refreshReport").addEventListener("click", async () => {
  const msg = $("reportMsg");
  const tbody = $("reportTable").querySelector("tbody");
  msg.textContent = "Reading decoder logs…";
  tbody.innerHTML = "";
  try {
    const r = await window.api.talkgroupReport();
    if (!r.rows.length) {
      msg.textContent = "No decoder activity yet (is it running?).";
      return;
    }
    msg.textContent = `${r.rows.length} talkgroups seen · ${r.bridgedCount} bridged.`;
    tbody.innerHTML = r.rows
      .map((row) => {
        const name = row.name || (row.bridged ? "" : "(not bridged)");
        const star = row.bridged ? "★ " : "";
        const vcls = row.voice > 0 ? "good" : "";
        return `<tr class="${row.bridged ? "bridged" : "dim"}">
          <td>${star}${name}</td><td>${row.tgid}</td>
          <td class="${vcls}">${row.voice}</td><td>${row.enc}</td><td>${row.nosrc}</td></tr>`;
      })
      .join("");
  } catch (e) {
    msg.textContent = "Report failed: " + (e.message || e);
  }
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
    // The startup migration may rewrite the RF config — refresh the Settings
    // form once it has had time to run.
    setTimeout(() => loadSettings().catch(() => {}), 10000);
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
    // A real stop: drop the retained channel rows so the panel reflects it.
    lastChannels = [];
    renderChannels([]);
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
  else if (s.decoder.locked) {
    let txt = "Locked";
    if (s.decoder.controlChannel) txt += " " + s.decoder.controlChannel;
    if (s.decoder.decodeRate) txt += ` · ${s.decoder.decodeRate}/s`;
    setCard("card-decoder", "ok", txt);
  } else setCard("card-decoder", "warn", "Running, acquiring lock…");

  const b = s.bridge || { running: false, channels: 0, active: 0 };
  if (b.running && b.channels > 0) setCard("card-bridge", "ok", `${b.channels} channels on air`);
  else if (b.running && b.active > 0) setCard("card-bridge", "ok", "Delivering audio");
  else if (b.running) setCard("card-bridge", "warn", "Connecting…");
  else setCard("card-bridge", "bad", b.lastLog ? `Stopped — ${b.lastLog}` : "Stopped");

  // Keep the last-good channel list so a single empty/partial status read (a
  // mid-write file, a slow wsl call) never blanks the whole panel. Only clear
  // when the bridge is genuinely down (a real stop), not on a transient blip.
  if (s.channels && s.channels.length) {
    lastChannels = s.channels;
    renderChannels(lastChannels);
  } else if (b.running) {
    renderChannels(lastChannels); // transient empty while alive — hold the rows
  } else {
    lastChannels = [];
    renderChannels([]);
  }

  const running = s.decoder.running || s.pipelineRunning;
  if (running && $("runState").textContent !== "Starting…") setRunState("on");
  else if (!running && $("runState").textContent === "Running") setRunState("off");

  if (s.dongle) $("dongleHint").hidden = true;
}

// ---- per-channel status (live "is audio reaching SafeT" view) -------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Last non-empty channel list, so a transient empty status read never blanks
// the panel (see poll()).
let lastChannels = [];

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
function fmtDur(ms) {
  return ms >= 59500 ? Math.round(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s" : (ms / 1000).toFixed(1) + "s";
}

function renderChannels(chans) {
  $("channelsPanel").hidden = chans.length === 0;
  if (!chans.length) return;
  const rows = [...chans].sort((a, b) => Number(a.scan) - Number(b.scan) || String(a.channel).localeCompare(String(b.channel)));
  $("channelsTable").querySelector("tbody").innerHTML = rows
    .map((c) => {
      let dot = "bad";
      if (c.transmitting) dot = "tx";
      else if (c.state === "on air") dot = "ok";
      else if (c.state === "connecting" || c.state === "reconnecting") dot = "warn";

      let last = "<span class='dim'>nothing yet</span>";
      if (c.transmitting) {
        last = `<strong>● transmitting now</strong>${c.scan && c.via ? " — " + esc(c.via) : ""}`;
      } else if (c.lastTxStartMs) {
        // Decode coverage: % of the keyed span that was real decoded audio.
        // Low % = simulcast distortion eating voice — tune gain/antenna up.
        let pct = "";
        if (Number.isFinite(c.lastTxAudioPct)) {
          const color = c.lastTxAudioPct >= 75 ? "#3fb950" : c.lastTxAudioPct >= 40 ? "#d29922" : "#f85149";
          pct = ` · <span style="color:${color}" title="How much of this transmission actually decoded — tune gain until this climbs">${c.lastTxAudioPct}% decoded</span>`;
        }
        last = `${fmtClock(c.lastTxStartMs)} · ${fmtDur(c.lastTxDurMs ?? 0)}${pct}${c.scan && c.via ? " — " + esc(c.via) : ""}`;
      }

      const mainRow = `<tr class="${c.transmitting ? "live" : ""}">
        <td><span class="chandot ${dot}"></span></td>
        <td>${esc(c.channel)}${c.scan ? ' <span class="tag">scan</span>' : ""}</td>
        <td>${c.tgid ?? "—"}</td>
        <td>${esc(c.state)}</td>
        <td>${last}</td>
        <td>${c.txCount || 0}</td></tr>`;

      // Scan All channels carry a rolling history of which talkgroups fed them —
      // render it as an indented activity feed beneath the row so you can see
      // exactly what traffic crossed Scan All, not just the most recent call.
      let activity = "";
      if (c.scan && Array.isArray(c.recent) && c.recent.length) {
        const items = c.recent
          .map((it) => {
            const who = it.source ? ` <span class="dim">[${esc(it.source)}]</span>` : "";
            const dur = it.durMs != null ? ` · ${fmtDur(it.durMs)}` : "";
            return `<div class="scan-line"><span class="dim">${fmtClock(it.atMs)}</span> ${esc(it.label)}${who}${dur}</div>`;
          })
          .join("");
        activity = `<tr class="scan-activity"><td></td><td colspan="5">
          <div class="scan-activity-head">Recent traffic on ${esc(c.channel)}</div>${items}</td></tr>`;
      }
      return mainRow + activity;
    })
    .join("");
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
$("saveDiag").addEventListener("click", async () => {
  toast("Collecting diagnostics…");
  try {
    const r = await window.api.saveDiagnostics();
    if (r.ok) toast("Saved: " + r.path);
    else if (!r.canceled) toast("Couldn't save diagnostics.");
  } catch (e) {
    toast("Diagnostics failed: " + (e.message || e));
  }
});

// ---- updates -------------------------------------------------------------
$("checkUpdate").addEventListener("click", () => {
  toast("Checking for updates…");
  window.api.checkForUpdates().then((r) => {
    if (r && r.ok === false) toast("Updates only work in the installed app (not a dev run).");
  });
});
if (window.api.onUpdateStatus) {
  window.api.onUpdateStatus((s) => {
    const m = $("updateMsg");
    if (s.state === "checking") m.textContent = "checking…";
    else if (s.state === "available") m.textContent = `downloading v${s.version}…`;
    else if (s.state === "downloading") m.textContent = `update ${s.percent}%`;
    else if (s.state === "none") { m.textContent = ""; toast("You're on the latest version."); }
    else if (s.state === "error") {
      m.textContent = "";
      // Surface the real reason — most often there's simply no release published
      // yet to check against, which is not the same as being offline.
      toast(s.message ? "Update check failed: " + s.message : "Update check failed — no release published yet, or you're offline.");
    }
    else if (s.state === "ready") {
      m.textContent = `v${s.version} ready — quit to install`;
      // Only prompt when the window is actually visible; when it's hidden in the
      // tray a confirm() would block invisibly. Either way it installs on quit
      // (autoInstallOnAppQuit), and the native toast already notified the user.
      if (!document.hidden && confirm(`Update v${s.version} downloaded. Restart SafeT SDR now to install?`)) {
        window.api.installUpdate();
      }
    }
  });
}

// ---- boot ----------------------------------------------------------------
(async function init() {
  try {
    $("appVersion").textContent = "v" + (await window.api.getVersion());
  } catch {
    /* older main process without the handler */
  }
  await loadSettings();
  const env = await window.api.detectEnv();
  if (!env.wsl) toast("WSL isn't reachable — run the one-time Setup first.");
  else if (!env.repo) toast("Project folder not found in WSL — check Advanced settings.");
  setRunState((await window.api.isRunning()) ? "on" : "off");
  poll();
  setInterval(poll, 4000);
})();
