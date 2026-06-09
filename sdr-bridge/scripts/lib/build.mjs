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
  // `sdr` is the single-dongle shorthand for `sources[0]`. When BOTH are present
  // (the desktop app writes `sources`; the example ships `sdr`), treat `sdr` as
  // defaults for the first dongle so a half-filled `sources[0]` — e.g.
  // `{ device, rateHz }` with no centerHz/gain/ppm — inherits those instead of
  // silently snapping to the 854 MHz / gain-0 fallbacks (which tunes the dongle
  // to the wrong place and leaves the bridge quiet with no obvious cause).
  const sdrShorthand = cfg.sdr ?? {};
  const rawSources =
    Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources : [sdrShorthand];
  const systemsCfg =
    Array.isArray(cfg.systems) && cfg.systems.length ? cfg.systems : [cfg.system ?? {}];

  // The talkgroups you picked in SafeT belong to the PRIMARY (first) system;
  // simplestream tags its UDP streams with that system's shortName.
  const primaryShort = systemsCfg[0]?.shortName ?? "occcs";

  const sources = rawSources.map((raw, i) => {
    // First dongle inherits any unset RF field from the `sdr` shorthand.
    const s = i === 0 ? { ...sdrShorthand, ...raw } : raw;
    return {
      center: s.centerHz ?? 854000000,
      rate: s.rateHz ?? 2400000,
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
    if (Array.isArray(s.channelsHz) && s.channelsHz.length) {
      sys.channels = s.channelsHz;
    } else {
      sys.control_channels = s.controlChannelsHz ?? [];
    }
    // A trunked system with no control channel (or a conventional one with no
    // channels) gives trunk-recorder nothing to tune: it dies on boot and the
    // whole bridge silently goes dark. Fail loudly here, pointing at the fix.
    if (!sys.channels?.length && !sys.control_channels?.length) {
      throw new Error(
        `system "${sys.shortName}" has no frequencies to tune. Set "controlChannelsHz" ` +
          `(trunked, e.g. [856712500, 857462500]) or "channelsHz" (conventional) in ` +
          `config/system.json — without one the decoder can't lock and no audio reaches SafeT.`,
      );
    }
    // Primary system records the SafeT talkgroups; extra systems use whatever
    // talkgroup ids you list for them in config.
    sys.talkgroups = isPrimary ? plan.map((p) => Number(p.tgid)) : s.talkgroups ?? [];
    return sys;
  });

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
    <fallback-override>1</fallback-override>
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
( while :; do
  ffmpeg -hide_banner -loglevel error -rw_timeout 2000000 \\
    -f s16le -ar 8000 -ac 1 -fflags nobuffer \\
    -i "udp://127.0.0.1:${p.udpPort}?fifo_size=1000000&overrun_nonfatal=1" \\
    -af "volume=1.6,alimiter=limit=0.95" \\
    -c:a libmp3lame -b:a 32k -ar 8000 -ac 1 \\
    -content_type audio/mpeg -f mp3 \\
    "icecast://source:${srcPass}@${iceHost}:${icePort}/${p.mount}" 2>/dev/null
  sleep 0.2
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
# Always-on /silence source + one UDP->Icecast streamer per talkgroup, with
# every mount falling back to /silence so SafeT always has audio.

STREAMER_PIDS=()
cleanup() {
  trap '' EXIT INT TERM
  echo "stopping streamers..."
  for pid in "\${STREAMER_PIDS[@]:-}"; do kill "\$pid" 2>/dev/null || true; done
  # Reap the ffmpeg children the loops spawned (they all carry the icecast URL).
  pkill -9 -f "icecast://source" 2>/dev/null || true
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
