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
