/**
 * sdrtrunk-rdio.mjs — an RdioScanner-compatible "call-upload" receiver.
 *
 * sdrtrunk's audio streaming is per-COMPLETED-call (it finishes decoding a
 * call, then uploads the whole recording), so we accept its RdioScanner
 * broadcaster POSTs instead of pulling a live/continuous stream. Each POST is
 * one finished call: multipart/form-data carrying the audio file plus
 * `talkgroup_id`, `talkgroup_label`, `source`, `frequency`, `date_time`.
 *
 * This module is transport-only: it parses the upload and hands a clean call
 * object to `onCall`. Audio decoding (ffmpeg) and SafeT routing live in the
 * caller so this stays dependency-free and unit-testable.
 */
import { createServer } from "node:http";

/** Minimal, binary-safe multipart/form-data parser for sdrtrunk's uploads.
 *  Returns { fields: {name->string}, file: {field, filename, data}|null }.
 *  Not a general RFC parser — handles the flat, single-file body sdrtrunk
 *  sends (no nested multipart, one file part). */
export function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) throw new Error("no multipart boundary");
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const fields = {};
  let file = null;

  let pos = body.indexOf(boundary);
  if (pos < 0) return { fields, file };
  pos += boundary.length;
  while (pos < body.length) {
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // closing "--"
    if (body[pos] === 0x0d) pos += 2; // skip CRLF after boundary
    const headerEnd = body.indexOf("\r\n\r\n", pos, "latin1");
    if (headerEnd < 0) break;
    const headers = body.toString("latin1", pos, headerEnd);
    const dataStart = headerEnd + 4;
    const next = body.indexOf(boundary, dataStart);
    if (next < 0) break;
    // The 2 bytes before the next boundary are the CRLF that precedes it.
    const data = body.subarray(dataStart, next - 2);

    const nameMatch = /name="([^"]*)"/i.exec(headers);
    const fileMatch = /filename="([^"]*)"/i.exec(headers);
    const name = nameMatch ? nameMatch[1] : null;
    if (name) {
      if (fileMatch) file = { field: name, filename: fileMatch[1], data: Buffer.from(data) };
      else fields[name] = data.toString("utf8");
    }
    pos = next + boundary.length;
  }
  return { fields, file };
}

/** Normalize one parsed upload into a call object, or null for a test ping. */
export function callFromUpload({ fields, file }) {
  if (fields.test != null && fields.test !== "" && fields.test !== "0") return null; // connection test
  if (!file || !file.data?.length) return null;
  const tgid = Number(fields.talkgroup_id ?? fields.talkgroupId);
  return {
    talkgroupId: Number.isFinite(tgid) ? tgid : null,
    talkgroupLabel: (fields.talkgroup_label || fields.talkgroupLabel || "").trim() || null,
    source: (fields.source || "").trim() || null,
    frequency: Number(fields.frequency) || null,
    dateTimeSec: Number(fields.date_time) || null,
    filename: file.filename || "call.mp3",
    audio: file.data,
  };
}

// RdioScanner response contract sdrtrunk checks for. Its testConnection()
// only sets the stream CONNECTED when the reply STARTS WITH the exact string
// "incomplete call data: no talkgroup" (case-insensitive) — anything else
// shows the stream as Error. Real uploads must contain
// "Call imported successfully.".
const TEST_REPLY = "incomplete call data: no talkgroup";
const OK_REPLY = "Call imported successfully.";

/**
 * Start the call-upload HTTP server. `onCall(call)` is invoked per finished
 * call (may be async); its rejection is logged but always answered OK so
 * sdrtrunk doesn't wedge its retry queue on a transient decode hiccup.
 */
export function createCallUploadServer({ port, host = "127.0.0.1", onCall, log = () => {} }) {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !/\/api\/call-upload\/?$/.test(req.url || "")) {
      res.writeHead(404).end("not found");
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) req.destroy(); // 64 MB guard (a call is ~<1 MB)
      else chunks.push(c);
    });
    req.on("error", () => {});
    req.on("end", () => {
      let call = null;
      try {
        call = callFromUpload(parseMultipart(Buffer.concat(chunks), req.headers["content-type"]));
      } catch (e) {
        log(`call-upload parse error: ${e.message}`);
        res.writeHead(200).end(TEST_REPLY);
        return;
      }
      if (!call) {
        res.writeHead(200).end(TEST_REPLY);
        return;
      }
      Promise.resolve()
        .then(() => onCall(call))
        .catch((e) => log(`onCall error: ${e.message}`))
        .finally(() => res.writeHead(200).end(OK_REPLY));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      log(`RdioScanner call-upload listening on http://${host}:${port}/api/call-upload`);
      resolve(server);
    });
  });
}
