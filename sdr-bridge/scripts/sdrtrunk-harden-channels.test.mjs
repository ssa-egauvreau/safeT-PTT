// Tests for the SDRTrunk channel-hardening patch. The rule: every ENABLED
// channel whose site isn't Countywide gets traffic_channel_pool_size="0" (so
// SDRTrunk decodes its control but chases zero out-of-band voice grants);
// Countywide and disabled channels are left alone. The patch must be
// line-targeted (CRLF preserved) and idempotent.

import test from "node:test";
import assert from "node:assert/strict";

import { hardenPlaylist } from "./sdrtrunk-harden-channels.mjs";

// A compact SDRTrunk-shaped playlist: system/site/enabled as attributes on
// <channel>, traffic_channel_pool_size as an attribute on <decode_configuration>.
const PLAYLIST =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<playlist version="4">\r\n` +
  `  <channel name="Countywide Control" enabled="true" system="OC CCCS" site="Countywide Tower">\r\n` +
  `    <decode_configuration type="P25P1" traffic_channel_pool_size="30"/>\r\n` +
  `  </channel>\r\n` +
  `  <channel name="North Control" enabled="true" system="OC CCCS" site="North">\r\n` +
  `    <decode_configuration type="P25P1" traffic_channel_pool_size="20"/>\r\n` +
  `  </channel>\r\n` +
  `  <channel name="South Control" enabled="true" system="OC CCCS" site="South">\r\n` +
  `    <decode_configuration type="P25P1" traffic_channel_pool_size="20"/>\r\n` +
  `  </channel>\r\n` +
  `  <channel name="Old North (off)" enabled="false" system="OC CCCS" site="North">\r\n` +
  `    <decode_configuration type="P25P1" traffic_channel_pool_size="20"/>\r\n` +
  `  </channel>\r\n` +
  `</playlist>\r\n`;

test("secondary-cell channels are zeroed, Countywide keeps its pool", () => {
  const { xml, changed } = hardenPlaylist(PLAYLIST);
  assert.match(xml, /name="Countywide Control"[\s\S]*?traffic_channel_pool_size="30"/);
  assert.match(xml, /name="North Control"[\s\S]*?traffic_channel_pool_size="0"/);
  assert.match(xml, /name="South Control"[\s\S]*?traffic_channel_pool_size="0"/);
  assert.deepEqual(
    changed.map((c) => c.name).sort(),
    ["North Control", "South Control"],
  );
});

test("disabled channels are left unchanged", () => {
  const { xml } = hardenPlaylist(PLAYLIST);
  assert.match(xml, /name="Old North \(off\)"[\s\S]*?traffic_channel_pool_size="20"/);
});

test("CRLF line endings are preserved", () => {
  const { xml } = hardenPlaylist(PLAYLIST);
  assert.ok(xml.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(xml), "no bare LF should be introduced");
});

test("idempotent: a second run changes nothing", () => {
  const first = hardenPlaylist(PLAYLIST);
  const second = hardenPlaylist(first.xml);
  assert.equal(second.changed.length, 0);
  assert.equal(second.xml, first.xml);
});

test("reports the previous pool size for each changed channel", () => {
  const { changed } = hardenPlaylist(PLAYLIST);
  for (const c of changed) assert.equal(c.from, "20");
});

test("child-element form of pool size and site is also handled", () => {
  const xml =
    `<playlist version="4">\r\n` +
    `  <channel name="NW Control">\r\n` +
    `    <enabled>true</enabled>\r\n` +
    `    <site>Northwest</site>\r\n` +
    `    <decode_configuration type="P25P1">\r\n` +
    `      <traffic_channel_pool_size>15</traffic_channel_pool_size>\r\n` +
    `    </decode_configuration>\r\n` +
    `  </channel>\r\n` +
    `</playlist>\r\n`;
  const res = hardenPlaylist(xml);
  assert.match(res.xml, /<traffic_channel_pool_size>0<\/traffic_channel_pool_size>/);
  assert.equal(res.changed[0].from, "15");
});

test("a Countywide site given as a child element is protected too", () => {
  const xml =
    `<playlist version="4">\r\n` +
    `  <channel name="CW">\r\n` +
    `    <enabled>true</enabled>\r\n` +
    `    <site>Countywide (simulcast)</site>\r\n` +
    `    <decode_configuration traffic_channel_pool_size="30"/>\r\n` +
    `  </channel>\r\n` +
    `</playlist>\r\n`;
  const { changed } = hardenPlaylist(xml);
  assert.equal(changed.length, 0);
});
