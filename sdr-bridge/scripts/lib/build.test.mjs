// Tests for the runtime-artifact generator that turns the local SDR config
// into the three files trunk-recorder + Icecast + the ffmpeg streamers run
// from (trunk-recorder/config.json, icecast/icecast.xml,
// generated/stream-talkgroups.sh).
//
// This module's behavior has caused real, on-the-air outages multiple times
// (see git log: "valid sample rate (multiple of 24000)", "covered control
// channels first (startup crash)", "first source inherits sdr defaults",
// "fail clearly when a P25 system has no control channel"). The fixes are
// pure data transforms and trivial to cover here, so we lock them in to
// prevent regressions that would silently break decoding for every operator.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_UDP_PORT,
  SCAN_ALL_UDP_PORT,
  tgidFromMount,
  writeArtifacts,
} from "./build.mjs";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

// A minimal but realistic decoder config: one dongle centered on the SafeT
// example trunk, one P25 trunked system with one in-window control channel.
// Use this as the baseline; tests override only what they care about.
function baseConfig(overrides = {}) {
  return {
    sdr: {
      centerHz: 854_000_000,
      rateHz: 2_400_000,
      gain: 40,
      ppm: 0,
    },
    system: {
      shortName: "occcs",
      type: "p25",
      controlChannelsHz: [853_950_000],
    },
    icecast: {
      host: "127.0.0.1",
      port: 8000,
      sourcePassword: "hackme",
      adminPassword: "admin",
    },
    ...overrides,
  };
}

function basePlan() {
  return [
    { tgid: 101, mount: "tg101", channel: "Dispatch" },
    { tgid: 202, mount: "tg202", channel: "Tactical" },
  ];
}

// Write artifacts into a fresh temp dir and return the parsed config plus the
// raw outputs the tests want to assert against.
function runWriteArtifacts(cfg, plan) {
  const root = mkdtempSync(join(tmpdir(), "sdr-build-test-"));
  // writeArtifacts reads config/occcs-talkgroups.csv if present; default to
  // absent for cleaner CSV assertions. Tests can opt in by writing the file
  // BEFORE calling this helper -- which means we need a hook. Easier: return
  // the root so the caller can pre-populate before re-running. The current
  // helper assumes no reference file.
  const withPorts = writeArtifacts(root, cfg, plan);
  const trunk = JSON.parse(
    readFileSync(join(root, "trunk-recorder", "config.json"), "utf8"),
  );
  const icecastXml = readFileSync(join(root, "icecast", "icecast.xml"), "utf8");
  const streamSh = readFileSync(join(root, "generated", "stream-talkgroups.sh"), "utf8");
  const talkgroupsCsv = readFileSync(
    join(root, "trunk-recorder", "talkgroups.csv"),
    "utf8",
  );
  // Cleanup the directory eagerly so a flaky test can't leak tmp files.
  rmSync(root, { recursive: true, force: true });
  return { trunk, icecastXml, streamSh, talkgroupsCsv, withPorts };
}

// Quiet console.warn so the test output is readable (the generator warns on
// snapped sample rates, uncovered control channels, zero gain, etc.).
test.beforeEach(() => {
  /* per-test: silenced inside each test that needs it */
});

function silenceWarnings(t) {
  const original = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = original;
  });
}

// ---------------------------------------------------------------------------
// tgidFromMount — small parser, lots of input shapes from the console
// ---------------------------------------------------------------------------

test("tgidFromMount parses bare mount names", () => {
  assert.equal(tgidFromMount("tg101"), 101);
  assert.equal(tgidFromMount("/tg42"), 42);
  assert.equal(tgidFromMount("TG7"), 7);
});

test("tgidFromMount parses Icecast URLs", () => {
  assert.equal(tgidFromMount("http://127.0.0.1:8000/tg9001"), 9001);
  assert.equal(tgidFromMount("https://example.com:9443/path/tg123"), 123);
});

test("tgidFromMount tolerates trailing whitespace", () => {
  assert.equal(tgidFromMount("tg88   "), 88);
});

test("tgidFromMount returns null for unrecognized inputs", () => {
  assert.equal(tgidFromMount("monitor"), null);
  assert.equal(tgidFromMount("/silence"), null);
  assert.equal(tgidFromMount("tg"), null);
  assert.equal(tgidFromMount("tgABC"), null);
  // Trailing chars after digits break the pattern (anchored to end-of-string).
  assert.equal(tgidFromMount("tg101/extra"), null);
});

// ---------------------------------------------------------------------------
// writeArtifacts — port assignment + Scan All stream
// ---------------------------------------------------------------------------

test("writeArtifacts assigns sequential UDP ports starting at BASE_UDP_PORT", (t) => {
  silenceWarnings(t);
  const plan = basePlan();
  const { withPorts, trunk } = runWriteArtifacts(baseConfig(), plan);

  // Each plan item gets an explicit, deterministic udpPort.
  assert.equal(withPorts.length, plan.length);
  assert.equal(withPorts[0].udpPort, BASE_UDP_PORT + 0);
  assert.equal(withPorts[1].udpPort, BASE_UDP_PORT + 1);

  // The trunk-recorder simplestream entries must agree byte-for-byte with the
  // ports the ffmpeg streamers will bind to; a drift here = silent mount.
  const perTgStreams = trunk.plugins[0].streams.filter((s) => s.TGID !== 0);
  assert.deepEqual(
    perTgStreams.map((s) => ({ TGID: s.TGID, port: s.port })),
    [
      { TGID: 101, port: BASE_UDP_PORT },
      { TGID: 202, port: BASE_UDP_PORT + 1 },
    ],
  );
});

test("writeArtifacts always includes the Scan All TGID-0 stream with sendTGID:true", (t) => {
  silenceWarnings(t);
  const { trunk } = runWriteArtifacts(baseConfig(), basePlan());
  const scanAll = trunk.plugins[0].streams.find((s) => s.TGID === 0);
  assert.ok(scanAll, "the all-talkgroups stream must exist (Scan All hub)");
  assert.equal(scanAll.port, SCAN_ALL_UDP_PORT);
  assert.equal(scanAll.sendTGID, true);
  // Per-TG streams must NOT prefix the TGID -- otherwise the per-mount ffmpeg
  // sees a 4-byte header it interprets as audio samples (audible click + bad
  // alignment). Lock this in.
  const perTg = trunk.plugins[0].streams.find((s) => s.TGID === 101);
  assert.equal(perTg.sendTGID, false);
});

test("writeArtifacts sets audioStreaming:true (required for simplestream to push call audio)", (t) => {
  silenceWarnings(t);
  const { trunk } = runWriteArtifacts(baseConfig(), basePlan());
  // Without this flag, trunk-recorder records calls to disk but sends NO UDP
  // -- every SafeT channel goes silent. The bug shipped once and the fix
  // (commit 48a454e) is what this assertion protects.
  assert.equal(trunk.audioStreaming, true);
});

// ---------------------------------------------------------------------------
// Sample-rate sanitization
// ---------------------------------------------------------------------------

test("writeArtifacts snaps decoder sample rate to a multiple of 24000", (t) => {
  silenceWarnings(t);
  // 2_400_001 is not a multiple of 24000 -> closest multiple is 2_400_000.
  const cfg = baseConfig({ sdr: { centerHz: 854_000_000, rateHz: 2_400_001, gain: 40 } });
  const { trunk } = runWriteArtifacts(cfg, basePlan());
  assert.equal(trunk.sources[0].rate % 24000, 0);
  assert.equal(trunk.sources[0].rate, 2_400_000);
});

test("writeArtifacts snaps a 'round' but invalid rate like 1_000_000 -> 1_008_000", (t) => {
  silenceWarnings(t);
  // 1_000_000 / 24000 ≈ 41.667 -> rounded = 42 -> 1_008_000 Hz.
  // This is the kind of value the desktop UI's number input used to emit
  // before the v1.3.0 fix and what crash-looped the decoder.
  // Move the SDR off 854 MHz so it still covers the control channel at 1.008 Msps.
  const cfg = baseConfig({
    sdr: { centerHz: 853_950_000, rateHz: 1_000_000, gain: 40 },
  });
  const { trunk } = runWriteArtifacts(cfg, basePlan());
  assert.equal(trunk.sources[0].rate, 1_008_000);
  assert.equal(trunk.sources[0].rate % 24000, 0);
});

test("writeArtifacts floors sample rate at 24000 (never zero, never negative)", (t) => {
  silenceWarnings(t);
  // Make the dongle "cover" the control channel by re-centering it on the CC.
  // A zero rate would otherwise also tank coverage detection and trigger the
  // control-channel guard before we ever see the floored rate.
  const cfg = baseConfig({
    sdr: { centerHz: 853_950_000, rateHz: 0, gain: 40 },
  });
  const { trunk } = runWriteArtifacts(cfg, basePlan());
  // Even rateHz: 0 must produce a runnable rate (>= 24000).
  assert.ok(trunk.sources[0].rate >= 24_000);
  assert.equal(trunk.sources[0].rate % 24000, 0);
});

// ---------------------------------------------------------------------------
// `sources[]` first-element defaults inheritance
// ---------------------------------------------------------------------------

test("writeArtifacts: sources[0] inherits sdr defaults so a partial stub can't blank center/gain", (t) => {
  silenceWarnings(t);
  // The desktop app sometimes writes a multi-dongle `sources` array but the
  // FIRST entry as a partial stub like `{ device: 0, rateHz: 2_400_000 }`.
  // Without the inheritance fix (commit e890fac/a088699) that would set
  // center to the default (854 MHz) and gain to 0 -- silently breaking
  // decoding. This guards that fix.
  const cfg = baseConfig({
    sources: [
      // Partial first entry: omits centerHz + gain.
      { device: 0, rateHz: 2_400_000 },
      // Second dongle: provides everything itself.
      { device: 1, centerHz: 460_000_000, rateHz: 2_400_000, gain: 35 },
    ],
  });
  const { trunk } = runWriteArtifacts(cfg, basePlan());
  // sources[0] inherits centerHz=854_000_000 and gain=40 from `sdr`.
  assert.equal(trunk.sources[0].center, 854_000_000);
  assert.equal(trunk.sources[0].gain, 40);
  // sources[1] does NOT inherit -- a separate dongle stands on its own.
  assert.equal(trunk.sources[1].center, 460_000_000);
  assert.equal(trunk.sources[1].gain, 35);
});

test("writeArtifacts: source device label maps to rtl=<value>", (t) => {
  silenceWarnings(t);
  const cfg = baseConfig({
    sources: [
      { device: "00000101", centerHz: 854_000_000, rateHz: 2_400_000, gain: 40 },
      { device: "00000102", centerHz: 460_000_000, rateHz: 2_400_000, gain: 35 },
    ],
  });
  const { trunk } = runWriteArtifacts(cfg, basePlan());
  // Serials let Windows enumerate dongles deterministically; we must pass them
  // through verbatim as `rtl=<serial>`.
  assert.equal(trunk.sources[0].device, "rtl=00000101");
  assert.equal(trunk.sources[1].device, "rtl=00000102");
});

// ---------------------------------------------------------------------------
// Control-channel coverage rules — the part that historically crash-looped
// trunk-recorder on first boot if anything went wrong.
// ---------------------------------------------------------------------------

test("writeArtifacts filters control channels to those a dongle actually covers", (t) => {
  silenceWarnings(t);
  // Dongle at 854 MHz with 2.4 Msps covers roughly 854 ± 1.152 MHz.
  // 853.95 MHz is IN-window; 460.0 MHz is OUT-of-window.
  const cfg = baseConfig({
    system: {
      shortName: "occcs",
      type: "p25",
      controlChannelsHz: [853_950_000, 460_000_000],
    },
  });
  const { trunk } = runWriteArtifacts(cfg, basePlan());
  assert.deepEqual(trunk.systems[0].control_channels, [853_950_000]);
});

test("writeArtifacts throws if NO control channel is within any dongle window", () => {
  // The pre-fix behavior (commit 7ff1887) was: emit a config with an
  // uncovered CC as the *first* entry, which made trunk-recorder exit on
  // boot ("Unable to find a source for this System") in a restart loop. We
  // now refuse to generate the artifact.
  const cfg = baseConfig({
    sdr: { centerHz: 854_000_000, rateHz: 2_400_000, gain: 40 },
    system: {
      shortName: "occcs",
      type: "p25",
      // Far outside the 854 MHz ±1.152 MHz window.
      controlChannelsHz: [460_000_000],
    },
  });
  const root = mkdtempSync(join(tmpdir(), "sdr-build-test-"));
  try {
    assert.throws(
      () => writeArtifacts(root, cfg, basePlan()),
      /none of its control channels fall inside any dongle/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeArtifacts throws if a P25 system has NEITHER control nor conventional channels", () => {
  // A trunked P25 system with no control channel makes trunk-recorder
  // segfault on boot. We must fail BEFORE writing the config.
  const cfg = baseConfig({
    system: { shortName: "occcs", type: "p25" /* no controlChannelsHz */ },
  });
  const root = mkdtempSync(join(tmpdir(), "sdr-build-test-"));
  try {
    assert.throws(
      () => writeArtifacts(root, cfg, basePlan()),
      /has no control channel/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeArtifacts: conventional system with channelsHz does NOT need a control channel", (t) => {
  silenceWarnings(t);
  // VHF/UHF conventional systems list their channels directly and have no
  // control channel; this must round-trip without throwing.
  const cfg = baseConfig({
    sdr: { centerHz: 155_500_000, rateHz: 2_400_000, gain: 40 },
    system: {
      shortName: "fire",
      type: "conventional",
      channelsHz: [155_490_000, 155_715_000],
    },
  });
  const { trunk } = runWriteArtifacts(cfg, basePlan());
  assert.deepEqual(trunk.systems[0].channels, [155_490_000, 155_715_000]);
  assert.equal(trunk.systems[0].control_channels, undefined);
});

test("writeArtifacts: control channel array with all falsy entries triggers the no-CC error, not a silent empty list", () => {
  // controlChannelsHz: [null, 0] is falsy-filtered to []; the P25 system then
  // has no real channels and must fail loudly rather than write a config
  // that crashes the decoder.
  const cfg = baseConfig({
    system: { shortName: "occcs", type: "p25", controlChannelsHz: [null, 0] },
  });
  const root = mkdtempSync(join(tmpdir(), "sdr-build-test-"));
  try {
    assert.throws(
      () => writeArtifacts(root, cfg, basePlan()),
      /has no control channel/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Multi-system support
// ---------------------------------------------------------------------------

test("writeArtifacts: primary system gets the bridged talkgroups; extra systems use their own", (t) => {
  silenceWarnings(t);
  // Two systems sharing one wide dongle window. The bridged talkgroups in the
  // SafeT plan belong to the PRIMARY system (simplestream tags streams with
  // its shortName); secondary systems list talkgroups themselves.
  const cfg = baseConfig({
    sources: [
      // Center between 853 and 855 with enough rate to cover both CCs.
      { centerHz: 854_000_000, rateHz: 2_400_000, gain: 40 },
    ],
    systems: [
      {
        shortName: "occcs",
        type: "p25",
        controlChannelsHz: [853_950_000],
      },
      {
        shortName: "sheriff",
        type: "p25",
        controlChannelsHz: [854_500_000],
        talkgroups: [501, 502],
      },
    ],
  });
  const { trunk } = runWriteArtifacts(cfg, basePlan());
  assert.equal(trunk.systems.length, 2);
  // Primary inherits the SafeT-bridged talkgroup ids.
  assert.deepEqual(trunk.systems[0].talkgroups, [101, 202]);
  // Secondary keeps its own list.
  assert.deepEqual(trunk.systems[1].talkgroups, [501, 502]);
});

test("writeArtifacts: extra system without `talkgroups` defaults to an empty list (not the primary's)", (t) => {
  silenceWarnings(t);
  const cfg = baseConfig({
    sources: [{ centerHz: 854_000_000, rateHz: 2_400_000, gain: 40 }],
    systems: [
      { shortName: "occcs", type: "p25", controlChannelsHz: [853_950_000] },
      { shortName: "sheriff", type: "p25", controlChannelsHz: [854_500_000] },
    ],
  });
  const { trunk } = runWriteArtifacts(cfg, basePlan());
  assert.deepEqual(trunk.systems[1].talkgroups, []);
});

// ---------------------------------------------------------------------------
// Talkgroups CSV — names so decoder logs / desktop Coverage tab work
// ---------------------------------------------------------------------------

test("writeArtifacts: talkgroups.csv lists bridged talkgroups first with SDR category", (t) => {
  silenceWarnings(t);
  const { talkgroupsCsv } = runWriteArtifacts(baseConfig(), basePlan());
  const lines = talkgroupsCsv.trim().split("\n");
  assert.equal(lines[0], "Decimal,Hex,Alpha Tag,Mode,Description,Tag,Category");
  // Two bridged rows; their Category MUST be "SDR" so the desktop Coverage
  // tab can pick them out.
  assert.match(lines[1], /^101,65,Dispatch,D,Dispatch,,SDR$/);
  assert.match(lines[2], /^202,ca,Tactical,D,Tactical,,SDR$/);
});

test("writeArtifacts: talkgroups.csv appends the reference roster when present, skipping bridged dups", (t) => {
  silenceWarnings(t);
  const root = mkdtempSync(join(tmpdir(), "sdr-build-test-"));
  try {
    // Drop a tiny reference roster with one duplicate (101 = the bridged
    // Dispatch row) and one unique entry.
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      join(root, "config", "occcs-talkgroups.csv"),
      [
        "Decimal,Hex,Alpha Tag,Mode,Description,Tag,Category",
        "101,65,Dispatch,D,Dispatch,,Sheriff",
        "777,309,Public Works,D,Public Works,,City",
        "",
      ].join("\n"),
    );
    writeArtifacts(root, baseConfig(), basePlan());
    const csv = readFileSync(join(root, "trunk-recorder", "talkgroups.csv"), "utf8");
    const lines = csv.trim().split("\n");
    // Header + 2 bridged + 1 unique reference row (the dup 101 is dropped).
    assert.equal(lines.length, 4);
    assert.ok(lines.includes("777,309,Public Works,D,Public Works,,City"));
    assert.equal(
      lines.filter((l) => l.startsWith("101,")).length,
      1,
      "bridged 101 must not be duplicated by the reference file",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Icecast XML
// ---------------------------------------------------------------------------

test("writeArtifacts: icecast.xml gives every bridged mount a /silence fallback (no 404 / cold start)", (t) => {
  silenceWarnings(t);
  const { icecastXml } = runWriteArtifacts(baseConfig(), basePlan());
  // Every per-talkgroup mount and /monitor must fall back to /silence; this
  // is what makes the always-on streamers work and what protects remote SafeT
  // listeners from getting "no source" 404s between calls.
  assert.match(icecastXml, /<mount-name>\/tg101<\/mount-name>[\s\S]*?<fallback-mount>\/silence<\/fallback-mount>/);
  assert.match(icecastXml, /<mount-name>\/tg202<\/mount-name>[\s\S]*?<fallback-mount>\/silence<\/fallback-mount>/);
  assert.match(icecastXml, /<mount-name>\/monitor<\/mount-name>[\s\S]*?<fallback-mount>\/silence<\/fallback-mount>/);
});

test("writeArtifacts: icecast.xml omits the /monitor mount when there are no bridges", (t) => {
  silenceWarnings(t);
  // No bridges -> no per-talkgroup amix inputs -> the monitor block must not
  // be emitted. Otherwise icecast would expose /monitor with zero sources.
  const { icecastXml } = runWriteArtifacts(baseConfig(), []);
  assert.doesNotMatch(icecastXml, /<mount-name>\/monitor<\/mount-name>/);
});

test("writeArtifacts: icecast credentials and host/port come from cfg.icecast", (t) => {
  silenceWarnings(t);
  const cfg = baseConfig({
    icecast: {
      host: "10.0.0.5",
      port: 9001,
      sourcePassword: "s3cret",
      adminPassword: "letmein",
    },
  });
  const { icecastXml } = runWriteArtifacts(cfg, basePlan());
  assert.match(icecastXml, /<source-password>s3cret<\/source-password>/);
  assert.match(icecastXml, /<relay-password>s3cret<\/relay-password>/);
  assert.match(icecastXml, /<admin-password>letmein<\/admin-password>/);
  assert.match(icecastXml, /<hostname>10\.0\.0\.5<\/hostname>/);
  assert.match(icecastXml, /<port>9001<\/port>/);
});

// ---------------------------------------------------------------------------
// stream-talkgroups.sh
// ---------------------------------------------------------------------------

test("writeArtifacts: stream-talkgroups.sh always-on silence + per-TG streamers + monitor mixer", (t) => {
  silenceWarnings(t);
  const { streamSh } = runWriteArtifacts(baseConfig(), basePlan());
  // Silence source -> /silence is the floor every mount falls back to.
  assert.match(streamSh, /icecast:\/\/source:hackme@127\.0\.0\.1:8000\/silence/);
  // Per-talkgroup persistent streamers, one per bridged talkgroup.
  assert.match(streamSh, /icecast:\/\/source:hackme@127\.0\.0\.1:8000\/tg101/);
  assert.match(streamSh, /icecast:\/\/source:hackme@127\.0\.0\.1:8000\/tg202/);
  // Each streamer must invoke udp-pcm.py with the matching UDP port.
  assert.match(streamSh, new RegExp(`udp-pcm\\.py ${BASE_UDP_PORT}\\b`));
  assert.match(streamSh, new RegExp(`udp-pcm\\.py ${BASE_UDP_PORT + 1}\\b`));
  // Monitor mixer publishes to /monitor.
  assert.match(streamSh, /icecast:\/\/source:hackme@127\.0\.0\.1:8000\/monitor/);
  // And reads back the per-tg Icecast mounts as its inputs (NOT the raw UDP
  // ports -- that's what makes amix non-blocking).
  assert.match(streamSh, /http:\/\/127\.0\.0\.1:8000\/tg101/);
  assert.match(streamSh, /http:\/\/127\.0\.0\.1:8000\/tg202/);
});

test("writeArtifacts: stream-talkgroups.sh degrades gracefully when there are no bridges", (t) => {
  silenceWarnings(t);
  const { streamSh } = runWriteArtifacts(baseConfig(), []);
  // No talkgroups -> no per-TG streamer stanzas and no monitor mixer; the
  // script must still produce a runnable silence-only floor.
  assert.match(streamSh, /No talkgroups to stream\./);
  assert.match(streamSh, /icecast:\/\/source:hackme@127\.0\.0\.1:8000\/silence/);
  assert.doesNotMatch(streamSh, /icecast:\/\/source:hackme@127\.0\.0\.1:8000\/monitor/);
});
