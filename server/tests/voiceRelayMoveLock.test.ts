/**
 * Records-iterable regression tests for the live-control move-lock counter
 * (`unitChannelCountsFromRecords`).
 *
 * Background — the merge artifact fix in dd76ac9 made
 * `UnitChannelCountRecord.client` optional and routed both the live-roster
 * reader (`unitChannelCounts(agencyId)`) and the records-iterable form
 * through the same `computeUnitChannelCounts` helper. The unit tests in
 * `voiceRelay/unitChannelCounts.test.ts` set `deviceType` but omit `client`
 * (so they exercise the legacy "device type only" path); these tests pin
 * the inverse — explicit `client` values, including the new null-deviceType
 * fallback (PR #151) and the cases where the fallback must NOT fire.
 *
 * Each test must keep working without changes to the helper if a future
 * refactor narrows or widens the rule set, and must fail loudly if the
 * fallback rule (web/desktop with deviceType=null counts as console)
 * accidentally widens to other clients or skips the kind filter.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { unitChannelCountsFromRecords } from "../src/voiceRelay.js";

test("unitChannelCountsFromRecords: locks multi-channel web/desktop scanning even when deviceType is null", () => {
  const counts = unitChannelCountsFromRecords(42, [
    {
      channelKey: "42 alpha",
      channelName: "Alpha",
      unitId: "DISP-1",
      kind: "account",
      client: "web",
      deviceType: null,
    },
    {
      channelKey: "42 bravo",
      channelName: "Bravo",
      unitId: "disp-1",
      kind: "account",
      client: "desktop",
      deviceType: null,
    },
  ]);

  assert.equal(counts.get("DISP-1"), 2);
});

test("unitChannelCountsFromRecords: does not lock phone + single dashboard pairing", () => {
  const counts = unitChannelCountsFromRecords(7, [
    {
      channelKey: "7 north",
      channelName: "North",
      unitId: "u-12",
      kind: "account",
      client: "ios",
      deviceType: "phone",
    },
    {
      channelKey: "7 south",
      channelName: "South",
      unitId: "U-12",
      kind: "account",
      client: "web",
      deviceType: null,
    },
  ]);

  assert.equal(counts.get("U-12"), 1);
});

test("unitChannelCountsFromRecords: explicit non-console deviceType keeps web/desktop sessions movable", () => {
  // The null-deviceType fallback is only for temporary lookup misses. Once a
  // concrete non-console device_type is known (phone/unit_radio/etc), that row
  // must NOT count as a dispatch console even if the websocket client says
  // web/desktop.
  const counts = unitChannelCountsFromRecords(8, [
    {
      channelKey: "8 alpha",
      channelName: "Alpha",
      unitId: "U-99",
      kind: "account",
      client: "web",
      deviceType: "phone",
    },
    {
      channelKey: "8 bravo",
      channelName: "Bravo",
      unitId: "u-99",
      kind: "account",
      client: "desktop",
      deviceType: "phone",
    },
  ]);

  assert.equal(
    counts.size,
    0,
    "known non-console device_type should override the web/desktop null-device fallback",
  );
});

test("unitChannelCountsFromRecords: ignores non-console traffic and other agencies", () => {
  const counts = unitChannelCountsFromRecords(9, [
    {
      channelKey: "8 alpha",
      channelName: "Alpha",
      unitId: "A1",
      kind: "account",
      client: "web",
      deviceType: null,
    },
    {
      channelKey: "9 alpha",
      channelName: "Alpha",
      unitId: "A1",
      kind: "legacy",
      client: "android",
      deviceType: null,
    },
    {
      channelKey: "9 bravo",
      channelName: "Bravo",
      unitId: "A1",
      kind: "account",
      client: "android",
      deviceType: "phone",
    },
  ]);

  assert.equal(counts.size, 0);
});

test("unitChannelCountsFromRecords: legacy/bridge sockets with client=web/desktop are still skipped (kind filter wins)", () => {
  // Defense-in-depth: even if some odd path managed to set client=web on a
  // legacy radio-key socket or the in-process bridge worker, the kind check
  // at the top of `countsAsDispatchConsoleSession` must reject them — a
  // regression that flipped the order would let a remote bridge running
  // from a desktop console appear as a multi-channel dispatcher and lock
  // every unit it relays for.
  const counts = unitChannelCountsFromRecords(1, [
    {
      channelKey: "1 alpha",
      channelName: "Alpha",
      unitId: "BR1",
      kind: "legacy",
      client: "web",
      deviceType: null,
    },
    {
      channelKey: "1 bravo",
      channelName: "Bravo",
      unitId: "BR1",
      kind: "bridge",
      client: "desktop",
      deviceType: null,
    },
  ]);
  assert.equal(counts.size, 0);
});

test("unitChannelCountsFromRecords: explicit ios/android clients with null deviceType do NOT count", () => {
  // Symmetric guard for the negative side of the PR #151 fallback. The
  // rule is that web/desktop accounts with a null device_type are treated
  // as console; mobile clients are not. A regression that broadened the
  // fallback (e.g. `client !== "android"`) would silently lock every iOS
  // user with the dashboard tab plus the mobile app on the same account.
  const counts = unitChannelCountsFromRecords(3, [
    {
      channelKey: "3 north",
      channelName: "North",
      unitId: "U1",
      kind: "account",
      client: "ios",
      deviceType: null,
    },
    {
      channelKey: "3 south",
      channelName: "South",
      unitId: "U1",
      kind: "account",
      client: "android",
      deviceType: null,
    },
  ]);
  assert.equal(counts.size, 0);
});

test("unitChannelCountsFromRecords: 'unknown' / 'radio' / 'bridge' clients with null deviceType do NOT count", () => {
  // The relay's normalizeClient() folds anything outside {android, ios, web,
  // desktop, bridge} to "unknown". A regression that special-cased these
  // values into the fallback (or accidentally accepted any non-empty
  // client) would lock every unit whose UA the relay didn't recognise.
  const counts = unitChannelCountsFromRecords(5, [
    {
      channelKey: "5 alpha",
      channelName: "Alpha",
      unitId: "U1",
      kind: "account",
      client: "unknown",
      deviceType: null,
    },
    {
      channelKey: "5 bravo",
      channelName: "Bravo",
      unitId: "U1",
      kind: "account",
      client: "radio",
      deviceType: null,
    },
    {
      channelKey: "5 charlie",
      channelName: "Charlie",
      unitId: "U1",
      kind: "account",
      // The literal string "bridge" is the kind tag for the in-process
      // bridge worker — it should never appear as a client on an account
      // session, but if it ever did, the fallback must not fire.
      client: "bridge",
      deviceType: null,
    },
  ]);
  assert.equal(counts.size, 0);
});

test("unitChannelCountsFromRecords: omitted client field defaults to 'unknown' (legacy fixture path)", () => {
  // The dd76ac9 merge artifact fix made the `client` field optional so
  // pre-existing fixtures (which only set deviceType) keep working without
  // changes. The default is "unknown", which must NOT trigger the
  // web/desktop fallback — only an explicit dispatch_console deviceType
  // can count when client is missing.
  const counts = unitChannelCountsFromRecords(11, [
    {
      channelKey: "11 alpha",
      channelName: "Alpha",
      unitId: "DISP1",
      kind: "account",
      // client intentionally omitted
      deviceType: null,
    },
    {
      channelKey: "11 bravo",
      channelName: "Bravo",
      unitId: "DISP1",
      kind: "account",
      // client intentionally omitted
      deviceType: null,
    },
  ]);
  assert.equal(counts.size, 0, "missing client + null deviceType must NOT count as console");
});

test("unitChannelCountsFromRecords: omitted client + dispatch_console deviceType still counts (legacy path)", () => {
  // The companion of the previous test — the legacy fixture shape
  // (deviceType-only, no client) MUST still count when deviceType is
  // explicitly dispatch_console, otherwise every voiceRelay/unitChannelCounts
  // unit test that relies on the default-client fixture would silently
  // start producing empty counts and the suite would fail at the wrong
  // layer (or worse, pass with a degraded rule).
  const counts = unitChannelCountsFromRecords(13, [
    {
      channelKey: "13 alpha",
      channelName: "Alpha",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    },
    {
      channelKey: "13 bravo",
      channelName: "Bravo",
      unitId: "DISP1",
      kind: "account",
      deviceType: "dispatch_console",
    },
  ]);
  assert.equal(counts.get("DISP1"), 2);
});

test("unitChannelCountsFromRecords: explicit dispatch_console deviceType wins over a non-console client", () => {
  // Belt-and-braces: a dispatch_console session is a console regardless of
  // the client tag. The rule short-circuits on deviceType=== "dispatch_console"
  // before checking client, so an account running the iOS app that somehow
  // reports deviceType=dispatch_console (admin manually set device_type, or
  // a future console embedded in iOS) still counts.
  const counts = unitChannelCountsFromRecords(17, [
    {
      channelKey: "17 alpha",
      channelName: "Alpha",
      unitId: "DISP1",
      kind: "account",
      client: "ios",
      deviceType: "dispatch_console",
    },
    {
      channelKey: "17 bravo",
      channelName: "Bravo",
      unitId: "DISP1",
      kind: "account",
      client: "android",
      deviceType: "dispatch_console",
    },
  ]);
  assert.equal(counts.get("DISP1"), 2);
});

test("unitChannelCountsFromRecords: dedupes the same channel name even for the web/desktop fallback", () => {
  // The relay re-seats a roster record on every join — so a dispatch
  // console reconnecting on the same channel produces two entries with the
  // same channelName. The Set in computeUnitChannelCounts must dedupe them
  // for the fallback path the same way it does for explicit dispatch_console.
  const counts = unitChannelCountsFromRecords(23, [
    {
      channelKey: "23 alpha",
      channelName: "Alpha",
      unitId: "DISP1",
      kind: "account",
      client: "web",
      deviceType: null,
    },
    {
      channelKey: "23 alpha",
      channelName: "Alpha",
      unitId: "DISP1",
      kind: "account",
      client: "web",
      deviceType: null,
    },
    {
      channelKey: "23 bravo",
      channelName: "Bravo",
      unitId: "DISP1",
      kind: "account",
      client: "desktop",
      deviceType: null,
    },
  ]);
  assert.equal(counts.get("DISP1"), 2, "same-channel reseat must not inflate the count");
});
