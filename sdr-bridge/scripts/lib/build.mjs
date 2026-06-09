/**
 * Shared artifact builder. Given the local RF/Icecast config and a "plan" (the
 * list of talkgroups to bridge), write the three runtime files:
 *
 *   trunk-recorder/config.json      decode + UDP-stream each talkgroup
 *   icecast/icecast.xml             accept a mount per talkgroup
 *   generated/stream-talkgroups.sh  one ffmpeg per talkgroup: UDP PCM -> Icecast
 *
 * Two callers produce the plan differently:
 *   - generate.mjs        from config/system.json's `bridges[]` (offline path)
 *   - sync-from-safet.mjs from the bridges you created in the SafeT console
 *
 * A plan item: { tgid:Number, mount:String, channel:String }.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** First UDP port; talkgroup N streams on BASE_UDP_PORT + N. */
export const BASE_UDP_PORT = 9000;

/** Derive a talkgroup id from a `…/tg<NNN>` stream mount, or null. */
export function tgidFromMount(mountOrUrl) {
  const m = String(mountOrUrl).match(/\/?tg(\d+)\s*$/i);
  return m ? Number(m[1]) : null;
}

function buildTrunkConfig(cfg, plan) {
  // Multiple dongles and multiple systems are both supported. The friendly
  // single-dongle / single-system form (`sdr`, `system`) still works; if the
  // `sources` / `systems` arrays are present they win. Each source (dongle)
  // covers its own ~2 MHz window, so two dongles span a wider band — or a
  // second one can sit on a different band entirely (UHF/VHF) for a 2nd system.
  // The friendly single-dongle `sdr` block seeds defaults. A `sources` array (the
  // desktop app's multi-dongle form) wins, but its FIRST entry inherits any field
  // it omits from `sdr` — so a partial stub like {device,rateHz} can't silently
  // erase your centerHz/gain and leave the dongle tuned to 854 MHz at gain 0.
  const sdrDefaults = cfg.sdr ?? {};
  const sourcesCfg =
    Array.isArray(cfg.sources) && cfg.sources.length
      ? cfg.sources.map((s, i) => (i === 0 ? { ...sdrDefaults, ...s } : s))
      : [sdrDefaults];
  const systemsCfg =
    Array.isArray(cfg.systems) && cfg.systems.length ? cfg.systems : [cfg.system ?? {}];

  // The talkgroups you picked in SafeT belong to the PRIMARY (first) system;
  // simplestream tags its UDP streams with that system's shortName.
  const primaryShort = systemsCfg[0]?.shortName ?? "occcs";

  const sources = sourcesCfg.map((s, i) => {
    // trunk-recorder hard-requires the sample rate to be a multiple of 24000
    // (the P25 symbol rate) — anything else aborts on boot ("OsmoSDR must have
    // a sample rate that is a multiple of 24000"). Snap to the nearest valid
    // rate instead of emitting a config that crash-loops the decoder.
    const askedRate = s.rateHz ?? 2400000;
    const rate = Math.max(24000, Math.round(askedRate / 24000) * 24000);
    if (rate !== askedRate)
      console.warn(`  ! dongle ${i}: sample rate ${askedRate} isn't a multiple of 24000 — using ${rate} instead.`);
    return {
      center: s.centerHz ?? 854000000,
      rate,
      gain: s.gain ?? 0,
      ppm: s.ppm ?? 0,
      digitalRecorders: Math.max(4, plan.length),
      driver: "osmosdr",
      // Default each dongle to its array index (rtl=0, rtl=1, …). Set `device`
      // to a serial (e.g. "00000101") if Windows enumerates them inconsistently.
      device: `rtl=${s.device ?? i}`,
    };
  });

  const systems = systemsCfg.map((s, i) => {
    const isPrimary = i === 0;
    const sys = {
      shortName: s.shortName ?? (isPrimary ? "occcs" : `sys${i}`),
      type: s.type ?? "p25",
      modulation: s.modulation ?? "qpsk",
      talkgroupsFile: "talkgroups.csv",
    };
    // Trunked systems lock a control channel; conventional (often the simplest
    // way to do a VHF/UHF system) lists its channels directly.
    const channels = Array.isArray(s.channelsHz) ? s.channelsHz.filter(Boolean) : [];
    const control = Array.isArray(s.controlChannelsHz) ? s.controlChannelsHz.filter(Boolean) : [];
    if (channels.length) {
      sys.channels = channels;
    } else {
      sys.control_channels = control;
    }
    // A trunked (P25) system with NO control channel makes trunk-recorder
    // segfault on startup — it has nothing to tune the control decoder to. Fail
    // here with a clear message instead of handing it a config that core-dumps
    // in a restart loop. (A conventional system listing `channels` is exempt.)
    if (!channels.length && !control.length) {
      throw new Error(
        `system "${sys.shortName}" has no control channel — set the control channel ` +
          `frequency in the desktop app (Settings → Control channel frequencies) or ` +
          `config/system.json (system.controlChannelsHz). Without it trunk-recorder crashes on start.`,
      );
    }
    // Primary system records the SafeT talkgroups; extra systems use whatever
    // talkgroup ids you list for them in config.
    sys.talkgroups = isPrimary ? plan.map((p) => Number(p.tgid)) : s.talkgroups ?? [];
    return sys;
  });

  // Zero gain rarely decodes — warn loudly but don't block (some setups feed an
  // amplified front-end). The desktop app's Gain field maps to source.gain.
  for (const [i, s] of sources.entries()) {
    if (!s.gain) console.warn(`  ! dongle ${i} has gain 0 — set a gain (e.g. 40) or it likely won't decode.`);
  }

  return {
    ver: 2,
    // REQUIRED for the simplestream plugin: hands decoded call audio to plugins.
    // Defaults to false — and with it off, trunk-recorder still records calls
    // but streams NOTHING to the UDP ports, so no audio reaches Icecast/SafeT.
    audioStreaming: true,
    sources,
    systems,
    plugins: [
      {
        name: "simplestream",
        library: "/usr/local/lib/trunk-recorder/libsimplestream.so",
        streams: plan.map((p) => ({
          TGID: Number(p.tgid),
          address: "127.0.0.1",
          port: p.udpPort,
          sendTGID: false,
          shortName: primaryShort,
        })),
      },
    ],
    captureDir: "/tmp/trunk-recorder",
    callTimeout: 3,
    logFile: false,
  };
}

function buildIcecastXml(cfg, plan) {
  const ice = cfg.icecast ?? {};
  // Every talkgroup mount (and /monitor) falls back to the always-on /silence
  // source. So a client connecting to /tgNNN always gets audio — silence while
  // idle, and Icecast seamlessly swaps to the live source when a call starts
  // (fallback-override). This is what makes the per-talkgroup ffmpegs able to be
  // dead-simple UDP->Icecast streamers that only connect during calls.
  const fallbackMount = (name) => `  <mount type="normal">
    <mount-name>/${name}</mount-name>
    <fallback-mount>/silence</fallback-mount>
    <fallback-override>all</fallback-override>
    <fallback-when-full>1</fallback-when-full>
  </mount>`;
  const mounts = plan.map((p) => fallbackMount(p.mount)).join("\n");
  const monitorMount = plan.length > 0 ? fallbackMount("monitor") + "\n" : "";
  return `<icecast>
  <!-- Generated by sdr-bridge — edit config/system.json, not this file. -->
  <limits>
    <clients>100</clients>
    <sources>${Math.max(16, plan.length + 4)}</sources>
    <queue-size>524288</queue-size>
    <client-timeout>30</client-timeout>
    <header-timeout>15</header-timeout>
    <source-timeout>10</source-timeout>
    <burst-size>65535</burst-size>
  </limits>
  <authentication>
    <source-password>${ice.sourcePassword ?? "hackme"}</source-password>
    <relay-password>${ice.sourcePassword ?? "hackme"}</relay-password>
    <admin-user>admin</admin-user>
    <admin-password>${ice.adminPassword ?? "hackme"}</admin-password>
  </authentication>
  <hostname>${ice.host ?? "127.0.0.1"}</hostname>
  <listen-socket>
    <port>${ice.port ?? 8000}</port>
  </listen-socket>
  <fileserve>0</fileserve>
${monitorMount}${mounts}
  <paths>
    <logdir>/tmp/icecast-logs</logdir>
    <webroot>/usr/share/icecast2/web</webroot>
    <adminroot>/usr/share/icecast2/admin</adminroot>
  </paths>
  <logging>
    <loglevel>2</loglevel>
  </logging>
</icecast>
`;
}

function buildStreamScript(cfg, plan) {
  const ice = cfg.icecast ?? {};
  const icePort = ice.port ?? 8000;
  const iceHost = ice.host ?? "127.0.0.1";
  const srcPass = ice.sourcePassword ?? "hackme";

  // Always-on silence source. Every mount falls back to this, so listeners
  // never get a 404 and there's no per-call cold start.
  const silence = `# Always-on silence source -> /silence (fallback for every mount).
( while :; do
  ffmpeg -hide_banner -loglevel error -re \\
    -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=8000" \\
    -c:a libmp3lame -b:a 32k -ar 8000 -ac 1 \\
    -content_type audio/mpeg -f mp3 \\
    "icecast://source:${srcPass}@${iceHost}:${icePort}/silence" 2>/dev/null
  sleep 0.5
done ) &
STREAMER_PIDS+=($!)`;

  // Per-talkgroup: a plain UDP->Icecast streamer (no amix, so it can never
  // block). It connects only while trunk-recorder is sending a call; rw_timeout
  // makes it exit ~2s after audio stops, so Icecast falls back to /silence
  // promptly. The while-loop respawns it to wait for the next call.
  const stanzas = plan
    .map(
      (p) => `# ${p.channel}  (TGID ${p.tgid})  ->  mount /${p.mount}
# Persistent source so the SafeT server (a remote listener) always receives
# audio. udp-pcm.py turns the decoder's bursty, call-only UDP into a CONTINUOUS
# PCM stream (silence in the gaps), which ffmpeg publishes as an always-live
# mount. Feeding ffmpeg the UDP directly does NOT work — with no packets between
# calls it stalls and never publishes, so the mount stays dark and a remote
# listener is stranded on silence.
( while :; do
  python3 scripts/udp-pcm.py ${p.udpPort} 2>/dev/null \\
  | ffmpeg -hide_banner -loglevel error \\
      -f s16le -ar 8000 -ac 1 -i - \\
      -af "volume=1.6,alimiter=limit=0.95" \\
      -c:a libmp3lame -b:a 32k -ar 8000 -ac 1 \\
      -content_type audio/mpeg -f mp3 \\
      "icecast://source:${srcPass}@${iceHost}:${icePort}/${p.mount}" 2>/dev/null
  sleep 1
done ) &
STREAMER_PIDS+=($!)`,
    )
    .join("\n\n");

  // Monitor — mix every talkgroup mount into /monitor (a "scan all" channel).
  // The inputs are the Icecast mounts, which always return audio (silence via
  // fallback, or live voice), so this amix never blocks.
  const monitorInputs = plan
    .map((p) => `    -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 2 -i "http://${iceHost}:${icePort}/${p.mount}"`)
    .join(" \\\n");
  const monitorBlock = plan.length > 0 ? `# Monitor — every unencrypted talkgroup mixed into /monitor.
# Add one SafeT bridge: stream_url -> <base>/monitor, channel "Scanner".
( sleep 5; while :; do
  ffmpeg -hide_banner -loglevel error \\
${monitorInputs} \\
    -filter_complex "amix=inputs=${plan.length}:duration=longest:dropout_transition=0,volume=2[a]" \\
    -map "[a]" -c:a libmp3lame -b:a 32k -ar 8000 -ac 1 \\
    -content_type audio/mpeg -f mp3 \\
    "icecast://source:${srcPass}@${iceHost}:${icePort}/monitor" 2>/dev/null
  sleep 1
done ) &
STREAMER_PIDS+=($!)` : "";

  return `#!/usr/bin/env bash
# Generated by sdr-bridge — do not edit by hand.
# One PERSISTENT UDP->Icecast streamer per talkgroup (an always-on silence floor
# with the decoder's voice mixed in), so every mount is continuously live and a
# remote listener (the SafeT server) always receives audio. Plus /silence and
# /monitor. This is what makes audio actually reach SafeT, not just Icecast.

STREAMER_PIDS=()
cleanup() {
  trap '' EXIT INT TERM
  echo "stopping streamers..."
  for pid in "\${STREAMER_PIDS[@]:-}"; do kill "\$pid" 2>/dev/null || true; done
  # Reap the children the loops spawned: the ffmpegs (carry the icecast URL) and
  # the udp-pcm.py feeders.
  pkill -9 -f "icecast://source" 2>/dev/null || true
  pkill -9 -f "udp-pcm.py" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

${silence}

${stanzas || "echo 'No talkgroups to stream.'"}

${monitorBlock}
echo "Streaming ${plan.length} talkgroup mount(s) + /silence + /monitor to icecast://${iceHost}:${icePort}/  (Ctrl-C to stop)"
wait
`;
}

/**
 * Write all three runtime files. `plan` items only need { tgid, mount, channel };
 * a UDP port is assigned here so the trunk-recorder targets and the ffmpeg
 * listeners always agree.
 */
export function writeArtifacts(root, cfg, plan) {
  const withPorts = plan.map((p, i) => ({ ...p, udpPort: BASE_UDP_PORT + i }));
  mkdirSync(join(root, "generated"), { recursive: true });
  mkdirSync(join(root, "trunk-recorder"), { recursive: true });
  mkdirSync(join(root, "icecast"), { recursive: true });

  writeFileSync(
    join(root, "trunk-recorder", "config.json"),
    JSON.stringify(buildTrunkConfig(cfg, withPorts), null, 2) + "\n",
  );
  // Always emit the talkgroups CSV trunk-recorder names calls from, so the file
  // the container mounts is guaranteed to exist (the console path may have no
  // hand-supplied config/talkgroups.csv) and calls get readable labels.
  const csv =
    "Decimal,Hex,Alpha Tag,Mode,Description,Tag,Category\n" +
    withPorts
      .map((p) => `${p.tgid},${Number(p.tgid).toString(16)},${p.channel},D,${p.channel},,SDR`)
      .join("\n") +
    "\n";
  writeFileSync(join(root, "trunk-recorder", "talkgroups.csv"), csv);
  writeFileSync(join(root, "icecast", "icecast.xml"), buildIcecastXml(cfg, withPorts));
  writeFileSync(join(root, "generated", "stream-talkgroups.sh"), buildStreamScript(cfg, withPorts), {
    mode: 0o755,
  });
  return withPorts;
}
