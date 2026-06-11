// Tests for the RdioScanner call-upload receiver — the transport that carries
// sdrtrunk's finished calls into the SafeT bridge. Covers the multipart parse,
// the call/test discrimination, and the live HTTP path end-to-end (no ffmpeg).

import test from "node:test";
import assert from "node:assert/strict";

import { callFromUpload, createCallUploadServer, parseMultipart } from "./sdrtrunk-rdio.mjs";

const B = "----safetBoundary123";
/** Assemble a multipart/form-data body from string fields + one binary file. */
function multipart(fields, file) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`),
    );
    parts.push(file.data);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${B}--\r\n`));
  return Buffer.concat(parts);
}
const CT = `multipart/form-data; boundary=${B}`;

test("parseMultipart: fields + binary file survive intact (incl. NUL/CRLF bytes)", () => {
  const audio = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x49, 0x44, 0x33, 0x00]); // bytes that could confuse a text parser
  const body = multipart({ talkgroup_id: "2500", talkgroup_label: "ACO Silver 1" }, { field: "audio", filename: "c.mp3", data: audio });
  const { fields, file } = parseMultipart(body, CT);
  assert.equal(fields.talkgroup_id, "2500");
  assert.equal(fields.talkgroup_label, "ACO Silver 1");
  assert.equal(file.filename, "c.mp3");
  assert.deepEqual([...file.data], [...audio]);
});

test("callFromUpload: maps fields and parses the talkgroup id", () => {
  const body = multipart({ talkgroup_id: "391", talkgroup_label: "TAN-CALL", source: "5921719", frequency: "856212500", date_time: "1781131741" }, { field: "audio", filename: "c.mp3", data: Buffer.from([1, 2, 3, 4]) });
  const call = callFromUpload(parseMultipart(body, CT));
  assert.equal(call.talkgroupId, 391);
  assert.equal(call.talkgroupLabel, "TAN-CALL");
  assert.equal(call.source, "5921719");
  assert.equal(call.frequency, 856212500);
  assert.equal(call.audio.length, 4);
});

test("callFromUpload: a test ping (test=1) yields null", () => {
  const call = callFromUpload(parseMultipart(multipart({ key: "safet", system: "1", test: "1" }, null), CT));
  assert.equal(call, null);
});

test("callFromUpload: an empty audio file yields null (no phantom transmission)", () => {
  const body = multipart({ talkgroup_id: "100" }, { field: "audio", filename: "c.mp3", data: Buffer.alloc(0) });
  assert.equal(callFromUpload(parseMultipart(body, CT)), null);
});

async function post(port, body, contentType) {
  const res = await fetch(`http://127.0.0.1:${port}/api/call-upload`, { method: "POST", headers: { "content-type": contentType }, body });
  return { status: res.status, text: await res.text() };
}

test("server: a real upload reaches onCall and answers the success string", async () => {
  const got = [];
  const server = await createCallUploadServer({ port: 0, onCall: (c) => got.push(c) });
  const { port } = server.address();
  try {
    const body = multipart({ talkgroup_id: "2580", talkgroup_label: "SO Transit 1" }, { field: "audio", filename: "c.mp3", data: Buffer.from([9, 9, 9, 9]) });
    const r = await post(port, body, CT);
    assert.equal(r.status, 200);
    assert.match(r.text, /imported successfully/i);
    assert.equal(got.length, 1);
    assert.equal(got[0].talkgroupId, 2580);
    assert.equal(got[0].talkgroupLabel, "SO Transit 1");
  } finally {
    server.close();
  }
});

test("server: a test ping does not invoke onCall and answers the string sdrtrunk's testConnection() requires", async () => {
  let calls = 0;
  const server = await createCallUploadServer({ port: 0, onCall: () => calls++ });
  const { port } = server.address();
  try {
    const r = await post(port, multipart({ key: "safet", system: "1", test: "1" }, null), CT);
    assert.equal(r.status, 200);
    // sdrtrunk: response.toLowerCase().startsWith("incomplete call data: no talkgroup")
    assert.ok(r.text.toLowerCase().startsWith("incomplete call data: no talkgroup"), `got "${r.text}"`);
    assert.equal(calls, 0);
  } finally {
    server.close();
  }
});

test("server: onCall throwing is contained — sdrtrunk still gets a 200", async () => {
  const server = await createCallUploadServer({ port: 0, onCall: () => { throw new Error("decode boom"); }, log: () => {} });
  const { port } = server.address();
  try {
    const body = multipart({ talkgroup_id: "1" }, { field: "audio", filename: "c.mp3", data: Buffer.from([1, 2, 3, 4]) });
    const r = await post(port, body, CT);
    assert.equal(r.status, 200);
  } finally {
    server.close();
  }
});

test("server: a non-upload path 404s", async () => {
  const server = await createCallUploadServer({ port: 0, onCall: () => {} });
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});
