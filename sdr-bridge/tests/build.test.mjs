/**
 * Tests for `sdr-bridge/scripts/lib/build.mjs`.
 *
 * The shared artifact builder is what writes the three runtime files that
 * trunk-recorder, Icecast, and the per-talkgroup ffmpeg streamers all run
 * from. A regression here doesn't surface as a test failure — it surfaces as
 * trunk-recorder crash-looping in production with unhelpful messages
 * ("Unable to find a source for this System", segfaults, "OsmoSDR must have
 * a sample rate that is a multiple of 24000"). Recent commits in this area:
 *
 *   - 7ff1887 fix(sdr): covered control channels first (startup crash)
 *   - 877e148 fix(sdr): per-channel ingest uses in-process UDP sockets
 *   - 9937560 feat(sdr): Scan All carries every clear voice call on the system
 *
 * What we lock in here:
 *   - Per-talkgroup UDP port assignment (BASE_UDP_PORT + index). The decoder
 *     and the ffmpeg listeners both compute this independently; if they
 *     disagree, audio goes to a port no one is listening on and every
 *     bridge runs silent.
 *   - Sample rate snapping to multiples of 24000 — anything else aborts
 *     trunk-recorder on boot.
 *   - Control-channel coverage filtering — uncovered control channels
 *     must be dropped from the decoder hunt list, not handed to trunk-
 *     recorder (which would deafen it for ~3s per cycle).
 *   - The "no covered control channel" hard-fail (clear error vs trunk-
 *     recorder segfault on start).
 *   - SCAN_ALL_UDP_PORT TGID-0 stream is always emitted with `sendTGID:
 *     true` so the per-call demuxer can label datagrams.
 *   - tgidFromMount tolerates the URL forms the SafeT API hands us.
 *   - Single-dongle defaults inherit into the first source of a sources[]
 *     array (so a partial stub can't silently erase centerHz/gain).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_UDP_PORT,
  SCAN_ALL_UDP_PORT,
  tgidFromMount,
  writeArtifacts,
} from "../scripts/lib/build.mjs";

// ---------- tgidFromMount ----------------------------------------------

test("tgidFromMount: bare 'tgN' style mounts return the numeric tgid", () => {
  assert.equal(tgidFromMount("tg16"), 16);
  assert.equal(tgidFromMount("tg304"), 304);
  assert.equal(tgidFromMount("tg9999"), 9999);
});

test("tgidFromMount: leading slash and capitalization tolerated", () => {
  // SafeT bridges are stored with both shapes (mount value and URL path).
  assert.equal(tgidFromMount("/tg16"), 16);
  assert.equal(tgidFromMount("/TG16"), 16);
  assert.equal(tgidFromMount("Tg16"), 16);
});

test("tgidFromMount: full Icecast URL form returns the trailing tgid", () => {
  // The bridge worker stores stream URLs like
  //   http://127.0.0.1:8000/tg16
  // import-bridges.mjs uses tgidFromMount on those URLs to thread the tgid
  // through to trunk-recorder. A regression that fails on the URL form
  // means newly imported bridges silently route to "no tgid".
  assert.equal(tgidFromMount("http://127.0.0.1:8000/tg16"), 16);
  assert.equal(
    tgidFromMount("https://stream.example.com:443/tg304"),
    304,
  );
});

test("tgidFromMount: no tgN suffix returns null (never a NaN tgid)", () => {
  assert.equal(tgidFromMount("dsp-dsp"), null);
  assert.equal(tgidFromMount("/monitor"), null);
  assert.equal(tgidFromMount(""), null);
  assert.equal(tgidFromMount("tg"), null);
  assert.equal(tgidFromMount("tgABC"), null);
});

test("tgidFromMount: trailing whitespace tolerated", () => {
  assert.equal(tgidFromMount("tg16 "), 16);
  assert.equal(tgidFromMount("/tg16\t"), 16);
});

// ---------- BASE_UDP_PORT / SCAN_ALL_UDP_PORT --------------------------

test("BASE_UDP_PORT and SCAN_ALL_UDP_PORT are stable, non-overlapping constants", () => {
  // Both decoder.json and the listening ffmpegs key off these. If a refactor
  // changes one without the other, audio goes to a port no one is reading
  // and every bridge runs silent.
  assert.equal(typeof BASE_UDP_PORT, "number");
  assert.equal(typeof SCAN_ALL_UDP_PORT, "number");
  assert.equal(BASE_UDP_PORT, 9000);
  assert.equal(SCAN_ALL_UDP_PORT, 8999);
  // SCAN_ALL must be below BASE so the per-talkgroup ports never collide
  // with the always-on TGID 0 stream.
  assert.ok(SCAN_ALL_UDP_PORT < BASE_UDP_PORT);
});

// ---------- writeArtifacts (config + ports) ----------------------------

function makeBaseCfg(overrides = {}) {
  return {
    icecast: { host: "127.0.0.1", port: 8000, sourcePassword: "pw", adminPassword: "ad" },
    sdr: {
      device: 0,
      centerHz: 857_350_000,
      // 2.4 MHz — already a multiple of 24000 (100x).
      rateHz: 2_400_000,
      gain: 40,
      ppm: 0,
    },
    system: {
      shortName: "occcs",
      type: "p25",
      modulation: "qpsk",
      // Two CCs: 857.4625 is inside the 857.35 ± 1.2 window; 856.0 is not.
      controlChannelsHz: [857_462_500, 860_462_500],
    },
    ...overrides,
  };
}

function makePlan() {
  return [
    { tgid: 16, mount: "dsp-dsp", channel: "DSP-DSP" },
    { tgid: 112, mount: "air-call", channel: "Air Call" },
  ];
}

function withTmpRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "sdr-bridge-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readJsonArtifact(root, ...parts) {
  return JSON.parse(readFileSync(join(root, ...parts), "utf8"));
}

test("writeArtifacts: each plan entry gets its own UDP port (BASE_UDP_PORT + index)", () => {
  // The decoder simplestream block and the ffmpeg listeners use the SAME
  // formula independently. Locking it here prevents a future "let's pack
  // ports tighter" refactor from silently desyncing them.
  withTmpRoot((root) => {
    const planned = writeArtifacts(root, makeBaseCfg(), makePlan());
    assert.equal(planned[0].udpPort, BASE_UDP_PORT);
    assert.equal(planned[1].udpPort, BASE_UDP_PORT + 1);
  });
});

test("writeArtifacts: trunk-recorder config maps each plan entry to its UDP port", () => {
  withTmpRoot((root) => {
    writeArtifacts(root, makeBaseCfg(), makePlan());
    const trunk = readJsonArtifact(root, "trunk-recorder", "config.json");
    const streams = trunk.plugins[0].streams;
    // streams: one per talkgroup + the TGID-0 scan-all stream.
    assert.equal(streams.length, 3);

    const dsp = streams.find((s) => s.TGID === 16);
    const air = streams.find((s) => s.TGID === 112);
    const scanAll = streams.find((s) => s.TGID === 0);
    assert.ok(dsp && air && scanAll);
    assert.equal(dsp.port, BASE_UDP_PORT);
    assert.equal(air.port, BASE_UDP_PORT + 1);
    assert.equal(scanAll.port, SCAN_ALL_UDP_PORT);

    // Critical contract: per-talkgroup streams must NOT prefix datagrams
    // with the tgid (the listener already knows which tgid that port is
    // for) — but the TGID-0 scan-all hub MUST, since its demuxer uses
    // the prefix to label each clear call.
    assert.equal(dsp.sendTGID, false);
    assert.equal(air.sendTGID, false);
    assert.equal(scanAll.sendTGID, true);
  });
});

test("writeArtifacts: audioStreaming is true (without it the simplestream plugin emits NOTHING)", () => {
  // trunk-recorder defaults this to false. With it off, calls still record
  // to disk but no UDP audio reaches the bridges — every channel runs
  // silent in production with no obvious error. Lock it on.
  withTmpRoot((root) => {
    writeArtifacts(root, makeBaseCfg(), makePlan());
    const trunk = readJsonArtifact(root, "trunk-recorder", "config.json");
    assert.equal(trunk.audioStreaming, true);
  });
});

test("writeArtifacts: source rate snaps to the nearest multiple of 24000", () => {
  // 2_560_000 / 24_000 = 106.667 → trunk-recorder aborts on boot. Snap to
  // 2_568_000 (107 × 24_000) — the nearest multiple of 24000. The earlier
  // SDR README warned about 2.56M / 3.2M crashing trunk-recorder; locking
  // the snap-to-nearest behaviour here pins the fix.
  withTmpRoot((root) => {
    const cfg = makeBaseCfg({
      sdr: {
        device: 0,
        centerHz: 857_350_000,
        rateHz: 2_560_000,
        gain: 40,
        ppm: 0,
      },
    });
    writeArtifacts(root, cfg, makePlan());
    const trunk = readJsonArtifact(root, "trunk-recorder", "config.json");
    assert.equal(trunk.sources[0].rate % 24_000, 0);
    // round(2_560_000 / 24_000) = round(106.667) = 107 → 2_568_000.
    assert.equal(trunk.sources[0].rate, 2_568_000);
  });
});

test("writeArtifacts: a rate that is ALREADY a multiple of 24000 is preserved exactly", () => {
  withTmpRoot((root) => {
    const cfg = makeBaseCfg({
      sdr: { device: 0, centerHz: 857_350_000, rateHz: 2_400_000, gain: 40, ppm: 0 },
    });
    writeArtifacts(root, cfg, makePlan());
    const trunk = readJsonArtifact(root, "trunk-recorder", "config.json");
    assert.equal(trunk.sources[0].rate, 2_400_000);
  });
});

test("writeArtifacts: control channels OUTSIDE the dongle window are dropped from the hunt list", () => {
  // 857.35 ± 1.2 MHz covers 857.4625 (in) but not 860.4625 (out).
  // trunk-recorder hunting a frequency it can't reach burns ~3 deaf seconds
  // per cycle and misses call grants. The artifact must list ONLY the
  // covered ones.
  withTmpRoot((root) => {
    writeArtifacts(root, makeBaseCfg(), makePlan());
    const trunk = readJsonArtifact(root, "trunk-recorder", "config.json");
    const sys = trunk.systems[0];
    assert.deepEqual(sys.control_channels, [857_462_500]);
  });
});

test("writeArtifacts: throws when NO control channel is covered by any dongle window", () => {
  // Better a clear setup-time error than a trunk-recorder crash loop
  // ("Unable to find a source for this System") in production.
  withTmpRoot((root) => {
    const cfg = makeBaseCfg({
      sdr: { device: 0, centerHz: 700_000_000, rateHz: 2_400_000, gain: 40, ppm: 0 },
    });
    assert.throws(
      () => writeArtifacts(root, cfg, makePlan()),
      /none of its control channels/i,
    );
  });
});

test("writeArtifacts: throws when a trunked system has no control channel listed", () => {
  // Without a control channel and without a `channels` list, trunk-recorder
  // segfaults on start. We must fail at config-write time with a useful
  // message instead.
  withTmpRoot((root) => {
    const cfg = makeBaseCfg({
      system: { shortName: "occcs", type: "p25", modulation: "qpsk" },
    });
    assert.throws(
      () => writeArtifacts(root, cfg, makePlan()),
      /no control channel/i,
    );
  });
});

test("writeArtifacts: a sources[] array's FIRST entry inherits missing fields from sdr defaults", () => {
  // A partial sources[] stub like { device: 1, rateHz: 2400000 } would
  // otherwise erase centerHz/gain on the first dongle and leave it tuned
  // to 854 MHz at gain 0 — a recorder that never decodes anything.
  withTmpRoot((root) => {
    const cfg = makeBaseCfg({
      sources: [
        // Partial stub: rateHz only.
        { rateHz: 2_400_000 },
        // Second source is fully specified.
        { device: 1, centerHz: 859_800_000, rateHz: 2_400_000, gain: 50, ppm: 1 },
      ],
    });
    writeArtifacts(root, cfg, makePlan());
    const trunk = readJsonArtifact(root, "trunk-recorder", "config.json");
    assert.equal(trunk.sources.length, 2);
    // First source: centerHz/gain inherited from cfg.sdr.
    assert.equal(trunk.sources[0].center, 857_350_000);
    assert.equal(trunk.sources[0].gain, 40);
    assert.equal(trunk.sources[0].rate, 2_400_000);
    // Second source: as configured, NOT inherited.
    assert.equal(trunk.sources[1].center, 859_800_000);
    assert.equal(trunk.sources[1].gain, 50);
  });
});

test("writeArtifacts: device defaults to its array index when not set explicitly (rtl=0, rtl=1)", () => {
  // A sources[] array with `device` omitted must produce rtl=0, rtl=1, …
  // — never two entries with rtl=undefined that fight for the same dongle.
  withTmpRoot((root) => {
    const cfg = makeBaseCfg({
      sources: [
        { centerHz: 857_350_000, rateHz: 2_400_000, gain: 40 },
        { centerHz: 859_800_000, rateHz: 2_400_000, gain: 40, controlChannelsHz: [] },
      ],
    });
    writeArtifacts(root, cfg, makePlan());
    const trunk = readJsonArtifact(root, "trunk-recorder", "config.json");
    assert.equal(trunk.sources[0].device, "rtl=0");
    assert.equal(trunk.sources[1].device, "rtl=1");
  });
});

test("writeArtifacts: digitalRecorders is at least 4, scaling with plan size", () => {
  // Recorder slots gate concurrent calls. Fewer than 4 means a busy
  // talkgroup will steal slots from another, dropping audio. Scale up
  // for larger plans so a 50-talkgroup system actually has 50+ slots.
  withTmpRoot((root) => {
    const small = writeArtifacts(root, makeBaseCfg(), makePlan());
    assert.ok(small.length === 2);
    const trunk = readJsonArtifact(root, "trunk-recorder", "config.json");
    assert.ok(trunk.sources[0].digitalRecorders >= 4);

    // Plan of 10 → digitalRecorders should grow.
    const bigPlan = Array.from({ length: 10 }, (_, i) => ({
      tgid: 100 + i,
      mount: `tg-${i}`,
      channel: `Ch ${i}`,
    }));
    writeArtifacts(root, makeBaseCfg(), bigPlan);
    const trunk2 = readJsonArtifact(root, "trunk-recorder", "config.json");
    assert.ok(trunk2.sources[0].digitalRecorders >= 10);
  });
});

test("writeArtifacts: the talkgroups CSV labels every bridged tgid with its SafeT channel name", () => {
  // The decoder picks call labels from this CSV. A regression that drops
  // the channel name leaves recordings tagged with bare tgids in
  // production — unreadable in the Coverage and recording UIs.
  withTmpRoot((root) => {
    writeArtifacts(root, makeBaseCfg(), makePlan());
    const csv = readFileSync(
      join(root, "trunk-recorder", "talkgroups.csv"),
      "utf8",
    );
    // Header is line 1; bridged tgids should appear on subsequent lines
    // with the SafeT channel name and Category=SDR (used by the desktop
    // Coverage tab).
    assert.match(csv, /^Decimal,Hex,Alpha Tag/);
    assert.match(csv, /^16,10,DSP-DSP,D,DSP-DSP,,SDR$/m);
    assert.match(csv, /^112,70,Air Call,D,Air Call,,SDR$/m);
  });
});

test("writeArtifacts: empty plan still produces a valid trunk config and CSV", () => {
  // 'No talkgroups picked yet' is a real first-boot state. Must not crash;
  // the plan-size-driven defaults must still produce a usable config.
  withTmpRoot((root) => {
    const planned = writeArtifacts(root, makeBaseCfg(), []);
    assert.deepEqual(planned, []);
    const trunk = readJsonArtifact(root, "trunk-recorder", "config.json");
    // Only the TGID-0 scan-all stream remains.
    assert.equal(trunk.plugins[0].streams.length, 1);
    assert.equal(trunk.plugins[0].streams[0].TGID, 0);
    assert.equal(trunk.plugins[0].streams[0].port, SCAN_ALL_UDP_PORT);
    // Recorder slots floor of 4 is preserved even with no plan.
    assert.ok(trunk.sources[0].digitalRecorders >= 4);
  });
});

test("writeArtifacts: stream-talkgroups.sh references the assigned UDP ports", () => {
  // The bash script and the trunk-recorder config compute UDP ports
  // independently; this is the cross-check that they agree.
  withTmpRoot((root) => {
    writeArtifacts(root, makeBaseCfg(), makePlan());
    const sh = readFileSync(
      join(root, "generated", "stream-talkgroups.sh"),
      "utf8",
    );
    // udp-pcm.py is invoked with the per-talkgroup UDP port; one stanza
    // per plan entry.
    assert.match(sh, new RegExp(`udp-pcm\\.py ${BASE_UDP_PORT}\\b`));
    assert.match(sh, new RegExp(`udp-pcm\\.py ${BASE_UDP_PORT + 1}\\b`));
  });
});
