// Tests for the playlist merge that installs SafeT aliases into a user's
// sdrtrunk playlist (replacing the alias Import button newer builds lack).
const test = require("node:test");
const assert = require("node:assert/strict");

const { mergePlaylist, dominantListName, existingTalkgroups } = require("./sdrtrunk-merge.js");

const TARGET = `<?xml version="1.0"?>
<playlist version="4">
  <channel name="OC CCCS" system="OCCCS"></channel>
  <alias color="-1" list="MyList" name="Existing TG" group="x">
    <id protocol="APCO25" type="talkgroup" value="2500"/>
  </alias>
  <stream name="SafeT" host="http://127.0.0.1:8765/api/call-upload"/>
</playlist>
`;

const INCOMING = `<?xml version="1.0"?>
<playlist version="4">
  <alias color="-1" list="OCCCS" name="ACO SIL 1" group="OC CCCS">
    <id protocol="APCO25" type="talkgroup" value="2500"/>
    <id channel="SafeT" type="broadcastChannel"/>
  </alias>
  <alias color="-1" list="OCCCS" name="TAN-CALL" group="Interop">
    <id protocol="APCO25" type="talkgroup" value="391"/>
    <id channel="SafeT" type="broadcastChannel"/>
  </alias>
</playlist>
`;

test("merge appends only new talkgroups, before </playlist>", () => {
  const r = mergePlaylist(TARGET, INCOMING);
  assert.equal(r.added, 1);
  assert.equal(r.skipped, 1); // 2500 already aliased by the user
  assert.match(r.xml, /TAN-CALL/);
  assert.doesNotMatch(r.xml, /ACO SIL 1/);
  assert.ok(r.xml.trimEnd().endsWith("</playlist>"));
  // user's content untouched
  assert.match(r.xml, /Existing TG/);
  assert.match(r.xml, /<channel name="OC CCCS"/);
});

test("incoming aliases are re-pointed at the user's own alias list", () => {
  const r = mergePlaylist(TARGET, INCOMING);
  assert.equal(r.list, "MyList");
  assert.match(r.xml, /<alias color="-1" list="MyList" name="TAN-CALL"/);
  assert.doesNotMatch(r.xml, /list="OCCCS" name="TAN-CALL"/);
});

test("target without aliases keeps the incoming list name", () => {
  const empty = `<playlist version="4">\n</playlist>`;
  const r = mergePlaylist(empty, INCOMING);
  assert.equal(r.added, 2);
  assert.equal(r.list, null);
  assert.match(r.xml, /list="OCCCS" name="ACO SIL 1"/);
});

test("re-running the merge is a no-op (idempotent)", () => {
  const first = mergePlaylist(TARGET, INCOMING);
  const second = mergePlaylist(first.xml, INCOMING);
  assert.equal(second.added, 0);
  assert.equal(second.xml, first.xml);
});

test("a non-playlist target throws instead of corrupting", () => {
  assert.throws(() => mergePlaylist("<html></html>", INCOMING), /not a sdrtrunk playlist/);
});

test("helpers: talkgroup ids and dominant list", () => {
  assert.deepEqual([...existingTalkgroups(TARGET)], [2500]);
  assert.equal(dominantListName(TARGET), "MyList");
});
