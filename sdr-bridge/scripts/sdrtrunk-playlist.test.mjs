// Tests for the sdrtrunk alias-list generator. The XML must import cleanly into
// sdrtrunk: right root/version, one alias per talkgroup, each tagged with both
// the P25 talkgroup id and the SafeT broadcast channel, with escaped labels.

import test from "node:test";
import assert from "node:assert/strict";

import { PLAYLIST_VERSION, buildAliasList, escapeXml } from "./sdrtrunk-playlist.mjs";

test("escapeXml: ampersands and quotes are entity-encoded", () => {
  assert.equal(escapeXml('Fire & Rescue "1"'), "Fire &amp; Rescue &quot;1&quot;");
});

test("alias list: root element carries the current playlist version", () => {
  const xml = buildAliasList([{ tgid: 2500, label: "ACO Silver 1" }]);
  assert.match(xml, new RegExp(`<playlist version="${PLAYLIST_VERSION}">`));
});

test("alias list: each talkgroup gets a talkgroup id + broadcast channel", () => {
  const xml = buildAliasList([{ tgid: 391, label: "TAN-CALL", group: "Law Dispatch" }], { listName: "OCCCS", streamName: "SafeT" });
  assert.match(xml, /<alias color="-1" list="OCCCS" name="TAN-CALL" group="Law Dispatch">/);
  assert.match(xml, /<id protocol="APCO25" type="talkgroup" value="391"\/>/);
  assert.match(xml, /<id channel="SafeT" type="broadcastChannel"\/>/);
});

test("alias list: duplicate and invalid talkgroups are dropped", () => {
  const xml = buildAliasList([
    { tgid: 100, label: "A" },
    { tgid: 100, label: "A-dup" },
    { tgid: 0, label: "bad" },
    { tgid: "x", label: "nan" },
  ]);
  assert.equal((xml.match(/<alias /g) || []).length, 1);
});

test("alias list: labels with XML-significant chars are escaped", () => {
  const xml = buildAliasList([{ tgid: 7, label: 'PW <Yard> & "Ops"' }]);
  assert.match(xml, /name="PW &lt;Yard&gt; &amp; &quot;Ops&quot;"/);
  assert.doesNotMatch(xml, /name="PW <Yard>/);
});

test("alias list: stream name is configurable", () => {
  const xml = buildAliasList([{ tgid: 1, label: "x" }], { streamName: "MyFeed" });
  assert.match(xml, /channel="MyFeed"/);
});
