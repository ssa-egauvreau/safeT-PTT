/**
 * Tests for `server/src/appUpdate.ts`.
 *
 * Why this module needs tight regression coverage
 * -----------------------------------------------
 * `appUpdate.ts` is the backend half of the over-the-air Android sideload
 * updater. The handset polls `/v1/app/android/update` and, if the manifest
 * advertises a newer build, downloads the APK from `/v1/app/android/apk` and
 * installs it directly — there's no Play Store and no MDM in the loop. That
 * makes the validation in `readManifest()` and the auth on the publish
 * endpoint security-relevant:
 *
 *   - If the manifest is allowed to reference a path-traversal "file" (e.g.
 *     "../../etc/passwd") the APK endpoint would happily serve whatever the
 *     server can read, with the APK content type, to anyone hitting the
 *     update URL.
 *   - If publish authentication regresses, anyone on the internet can drop a
 *     signed-looking APK onto the update directory and watch the entire fleet
 *     install it on the next poll.
 *   - If the manifest cache (sha256) returns a stale hash after a publish,
 *     handsets compare against the old hash and skip the new build (or, worse,
 *     fail the integrity check and never recover).
 *
 * These tests cover both happy and adversarial paths against the real
 * filesystem (under a tmpdir) so they're deterministic without any mocking
 * library.
 *
 * The module reads `APP_UPDATES_DIR` and `APP_UPDATE_PUBLISH_TOKEN` from the
 * environment at *import* time, so we set both before the dynamic import.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const updatesDir = mkdtempSync(join(tmpdir(), "appupdate-test-"));
process.env.APP_UPDATES_DIR = updatesDir;
process.env.APP_UPDATE_PUBLISH_TOKEN = "test-publish-token";

const { handleAndroidUpdateManifest, handleAndroidUpdatePublish, handleAndroidUpdateApk } = await import(
  "../src/appUpdate.js"
);

// Mock Express Response that captures whatever the handler does.
interface CapturedRes {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
  sentFile?: string;
}

function mockRes(): {
  res: import("express").Response;
  captured: CapturedRes;
} {
  const captured: CapturedRes = { headers: {} };
  const res = {
    status(n: number) {
      captured.status = n;
      return this;
    },
    json(obj: unknown) {
      captured.body = obj;
      if (captured.status === undefined) {
        captured.status = 200;
      }
      return this;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return this;
    },
    sendFile(path: string) {
      captured.sentFile = path;
      if (captured.status === undefined) {
        captured.status = 200;
      }
      return this;
    },
  } as unknown as import("express").Response;
  return { res, captured };
}

function mockReq(opts: { headers?: Record<string, string>; body?: Buffer | undefined } = {}) {
  return {
    headers: opts.headers ?? {},
    body: opts.body,
  } as unknown as import("express").Request;
}

function clearUpdatesDir(): void {
  // Wipe + recreate so each test sees a deterministic state.
  rmSync(updatesDir, { recursive: true, force: true });
  mkdirSync(updatesDir, { recursive: true });
}

function writeManifest(obj: Record<string, unknown> | string): void {
  const raw = typeof obj === "string" ? obj : JSON.stringify(obj);
  writeFileSync(join(updatesDir, "version.json"), raw);
}

function writeApk(name: string, contents: Buffer | string = "PK-fake-apk-bytes"): void {
  writeFileSync(join(updatesDir, name), contents);
}

// ===== handleAndroidUpdateManifest =====================================

test("handleAndroidUpdateManifest: 404 when no version.json published", () => {
  clearUpdatesDir();
  const { res, captured } = mockRes();
  handleAndroidUpdateManifest(mockReq(), res);
  assert.equal(captured.status, 404);
  assert.deepEqual(captured.body, { error: "no_update_published" });
});

test("handleAndroidUpdateManifest: 404 when version.json is malformed JSON", () => {
  clearUpdatesDir();
  writeManifest("{ this is not json");
  const { res, captured } = mockRes();
  handleAndroidUpdateManifest(mockReq(), res);
  assert.equal(captured.status, 404);
  assert.deepEqual(captured.body, { error: "no_update_published" });
});

test("handleAndroidUpdateManifest: 404 when versionCode is missing / non-integer / non-positive", () => {
  for (const bad of [undefined, "abc", 0, -1, 1.5, null]) {
    clearUpdatesDir();
    writeApk("safet-ptt-1.apk");
    writeManifest({ versionCode: bad, file: "safet-ptt-1.apk" });
    const { res, captured } = mockRes();
    handleAndroidUpdateManifest(mockReq(), res);
    assert.equal(captured.status, 404, `versionCode=${String(bad)}`);
  }
});

test("handleAndroidUpdateManifest: 404 when file field is empty / missing", () => {
  for (const bad of [undefined, "", null]) {
    clearUpdatesDir();
    writeManifest({ versionCode: 1, file: bad });
    const { res, captured } = mockRes();
    handleAndroidUpdateManifest(mockReq(), res);
    assert.equal(captured.status, 404, `file=${String(bad)}`);
  }
});

test("handleAndroidUpdateManifest: 404 when file uses path-traversal characters", () => {
  // Security: the comment in the source explicitly calls out that the APK
  // must live inside the updates dir. Confirm any slash or backslash in the
  // file field blocks the manifest entirely.
  for (const evil of [
    "../etc/passwd",
    "../../foo.apk",
    "subdir/foo.apk",
    "foo\\bar.apk",
    "/abs/path/foo.apk",
  ]) {
    clearUpdatesDir();
    writeApk("safet-ptt-1.apk");
    writeManifest({ versionCode: 1, file: evil });
    const { res, captured } = mockRes();
    handleAndroidUpdateManifest(mockReq(), res);
    assert.equal(captured.status, 404, `file=${evil}`);
  }
});

test("handleAndroidUpdateManifest: 404 when manifest references a missing APK on disk", () => {
  clearUpdatesDir();
  writeManifest({ versionCode: 1, file: "safet-ptt-missing.apk" });
  // Deliberately no writeApk(...) — file is missing.
  const { res, captured } = mockRes();
  handleAndroidUpdateManifest(mockReq(), res);
  assert.equal(captured.status, 404);
});

test("handleAndroidUpdateManifest: 200 returns sha256, url, mandatory, notes for a valid manifest", async () => {
  clearUpdatesDir();
  const apkBytes = Buffer.from("hello-apk");
  writeApk("safet-ptt-0.2.0-2.apk", apkBytes);
  writeManifest({
    versionCode: 2,
    versionName: "0.2.0",
    file: "safet-ptt-0.2.0-2.apk",
    mandatory: true,
    notes: "patch notes",
  });
  const { res, captured } = mockRes();
  handleAndroidUpdateManifest(mockReq(), res);

  assert.equal(captured.status, 200);
  const body = captured.body as Record<string, unknown>;
  assert.equal(body.versionCode, 2);
  assert.equal(body.versionName, "0.2.0");
  assert.equal(body.url, "/v1/app/android/apk");
  assert.equal(body.mandatory, true);
  assert.equal(body.notes, "patch notes");
  // The handler must compute sha256 of the actual APK bytes.
  const expected = (await import("node:crypto")).createHash("sha256").update(apkBytes).digest("hex");
  assert.equal(body.sha256, expected);
  // The manifest endpoint must be served no-cache (handsets poll it).
  assert.equal(captured.headers["cache-control"], "no-cache");
});

test("handleAndroidUpdateManifest: defaults versionName to String(versionCode) when missing/non-string", () => {
  clearUpdatesDir();
  writeApk("safet-ptt-3.apk");
  writeManifest({ versionCode: 3, file: "safet-ptt-3.apk", versionName: 12345 });
  const { res, captured } = mockRes();
  handleAndroidUpdateManifest(mockReq(), res);
  assert.equal(captured.status, 200);
  assert.equal((captured.body as { versionName: string }).versionName, "3");
});

test("handleAndroidUpdateManifest: defaults notes to '' and mandatory to false when missing", () => {
  clearUpdatesDir();
  writeApk("safet-ptt-4.apk");
  writeManifest({ versionCode: 4, file: "safet-ptt-4.apk" });
  const { res, captured } = mockRes();
  handleAndroidUpdateManifest(mockReq(), res);
  const body = captured.body as { notes: string; mandatory: boolean };
  assert.equal(body.notes, "");
  assert.equal(body.mandatory, false);
});

test("handleAndroidUpdateManifest: mandatory is only true for the strict boolean `true` (not 'true' / 1)", () => {
  for (const val of ["true", 1, "yes"] as unknown[]) {
    clearUpdatesDir();
    writeApk("safet-ptt-5.apk");
    writeManifest({ versionCode: 5, file: "safet-ptt-5.apk", mandatory: val });
    const { res, captured } = mockRes();
    handleAndroidUpdateManifest(mockReq(), res);
    assert.equal((captured.body as { mandatory: boolean }).mandatory, false, `mandatory=${String(val)}`);
  }
});

// ===== handleAndroidUpdateApk =========================================

test("handleAndroidUpdateApk: 404 when no manifest is published", () => {
  clearUpdatesDir();
  const { res, captured } = mockRes();
  handleAndroidUpdateApk(mockReq(), res);
  assert.equal(captured.status, 404);
});

test("handleAndroidUpdateApk: streams the APK and sets package-archive content type", () => {
  clearUpdatesDir();
  writeApk("safet-ptt-6.apk");
  writeManifest({ versionCode: 6, file: "safet-ptt-6.apk" });
  const { res, captured } = mockRes();
  handleAndroidUpdateApk(mockReq(), res);
  // Android refuses to install a download whose content type isn't APK; lock it.
  assert.equal(captured.headers["content-type"], "application/vnd.android.package-archive");
  assert.equal(captured.headers["cache-control"], "no-cache");
  assert.ok(
    captured.sentFile && captured.sentFile.endsWith("safet-ptt-6.apk"),
    `sentFile=${captured.sentFile}`,
  );
});

// ===== handleAndroidUpdatePublish =====================================

test("handleAndroidUpdatePublish: 401 when bearer token is missing or wrong", () => {
  clearUpdatesDir();
  for (const auth of [undefined, "", "Bearer wrong", "wrong"]) {
    const headers: Record<string, string> = {
      "x-version-code": "7",
    };
    if (auth !== undefined) headers.authorization = auth;
    const { res, captured } = mockRes();
    handleAndroidUpdatePublish(mockReq({ headers, body: Buffer.from("apk-bytes") }), res);
    assert.equal(captured.status, 401, `auth=${String(auth)}`);
    assert.deepEqual(captured.body, { error: "unauthorized" });
  }
});

test("handleAndroidUpdatePublish: 400 on missing / non-integer / non-positive versionCode", () => {
  clearUpdatesDir();
  for (const v of [undefined, "abc", "0", "-1", "1.5"]) {
    const headers: Record<string, string> = {
      authorization: "Bearer test-publish-token",
    };
    if (v !== undefined) headers["x-version-code"] = v;
    const { res, captured } = mockRes();
    handleAndroidUpdatePublish(mockReq({ headers, body: Buffer.from("apk-bytes") }), res);
    assert.equal(captured.status, 400, `versionCode=${String(v)}`);
    assert.deepEqual(captured.body, { error: "bad_version_code" });
  }
});

test("handleAndroidUpdatePublish: 400 on empty / missing APK body", () => {
  clearUpdatesDir();
  for (const body of [undefined, Buffer.alloc(0), "not a buffer" as unknown as Buffer]) {
    const { res, captured } = mockRes();
    handleAndroidUpdatePublish(
      mockReq({
        headers: { authorization: "Bearer test-publish-token", "x-version-code": "8" },
        body: body as Buffer | undefined,
      }),
      res,
    );
    assert.equal(captured.status, 400);
    assert.deepEqual(captured.body, { error: "empty_apk" });
  }
});

test("handleAndroidUpdatePublish: happy path writes APK + version.json and the next manifest read sees it", () => {
  clearUpdatesDir();
  const apkBytes = Buffer.from("real-apk-payload");
  const { res, captured } = mockRes();
  handleAndroidUpdatePublish(
    mockReq({
      headers: {
        authorization: "Bearer test-publish-token",
        "x-version-code": "9",
        "x-version-name": "0.9.0",
        "x-mandatory": "true",
        "x-notes": "patch notes 9",
      },
      body: apkBytes,
    }),
    res,
  );
  assert.equal(captured.status, 200);
  const body = captured.body as { ok: boolean; file: string; bytes: number };
  assert.equal(body.ok, true);
  assert.equal(body.file, "safet-ptt-0.9.0-9.apk");
  assert.equal(body.bytes, apkBytes.length);

  // File + manifest were written.
  assert.ok(existsSync(join(updatesDir, "safet-ptt-0.9.0-9.apk")));
  const manifestRaw = JSON.parse(readFileSync(join(updatesDir, "version.json"), "utf8"));
  assert.equal(manifestRaw.versionCode, 9);
  assert.equal(manifestRaw.versionName, "0.9.0");
  assert.equal(manifestRaw.file, "safet-ptt-0.9.0-9.apk");
  assert.equal(manifestRaw.mandatory, true);
  assert.equal(manifestRaw.notes, "patch notes 9");

  // The very next manifest read should reflect the new build (cache busted).
  const { res: res2, captured: cap2 } = mockRes();
  handleAndroidUpdateManifest(mockReq(), res2);
  assert.equal(cap2.status, 200);
  assert.equal((cap2.body as { versionCode: number }).versionCode, 9);
});

test("handleAndroidUpdatePublish: versionName is filename-sanitised (path-traversal safe)", () => {
  // The versionName lands inside the on-disk APK file name; characters
  // outside [A-Za-z0-9._-] must be stripped or an attacker controlling the
  // header could write outside the updates dir.
  clearUpdatesDir();
  const { res, captured } = mockRes();
  handleAndroidUpdatePublish(
    mockReq({
      headers: {
        authorization: "Bearer test-publish-token",
        "x-version-code": "10",
        "x-version-name": "../../evil 1.0/etc",
      },
      body: Buffer.from("apk"),
    }),
    res,
  );
  assert.equal(captured.status, 200);
  const fileName = (captured.body as { file: string }).file;
  // Sanitiser keeps only [A-Za-z0-9._-]; the "../../evil 1.0/etc" collapses
  // to "....evil1.0etc" (dots survive; slashes and the space don't).
  assert.equal(fileName, "safet-ptt-....evil1.0etc-10.apk");
  // The written APK must live inside updatesDir — no escape.
  assert.ok(existsSync(join(updatesDir, fileName)));
});

test("handleAndroidUpdatePublish: empty versionName after sanitisation falls back to versionCode string", () => {
  clearUpdatesDir();
  const { res, captured } = mockRes();
  handleAndroidUpdatePublish(
    mockReq({
      headers: {
        authorization: "Bearer test-publish-token",
        "x-version-code": "11",
        // After sanitisation '/././///' becomes '...//' → '..//' → '..' (only dots survive).
        // Then '....' is non-empty so we use a value that strips to "".
        "x-version-name": "%%%%",
      },
      body: Buffer.from("apk"),
    }),
    res,
  );
  assert.equal(captured.status, 200);
  const fileName = (captured.body as { file: string }).file;
  assert.equal(fileName, "safet-ptt-11-11.apk");
});

test("handleAndroidUpdatePublish: notes are truncated to 500 chars", () => {
  clearUpdatesDir();
  const longNotes = "a".repeat(800);
  const { res, captured } = mockRes();
  handleAndroidUpdatePublish(
    mockReq({
      headers: {
        authorization: "Bearer test-publish-token",
        "x-version-code": "12",
        "x-notes": longNotes,
      },
      body: Buffer.from("apk"),
    }),
    res,
  );
  assert.equal(captured.status, 200);
  const manifestRaw = JSON.parse(readFileSync(join(updatesDir, "version.json"), "utf8"));
  assert.equal(manifestRaw.notes.length, 500);
});

// ===== publish-disabled mode (env var unset) ==========================

test("handleAndroidUpdatePublish: 503 'publish_disabled' when APP_UPDATE_PUBLISH_TOKEN is unset", () => {
  // The token is read on every invocation (not at import time), so deleting
  // the env var before this single call is enough to simulate a deploy that
  // never opted in to the publish endpoint.
  clearUpdatesDir();
  const saved = process.env.APP_UPDATE_PUBLISH_TOKEN;
  delete process.env.APP_UPDATE_PUBLISH_TOKEN;
  try {
    const { res, captured } = mockRes();
    handleAndroidUpdatePublish(
      mockReq({
        headers: { authorization: "Bearer test-publish-token", "x-version-code": "13" },
        body: Buffer.from("apk"),
      }),
      res,
    );
    assert.equal(captured.status, 503);
    assert.deepEqual(captured.body, { error: "publish_disabled" });
  } finally {
    if (saved !== undefined) process.env.APP_UPDATE_PUBLISH_TOKEN = saved;
  }
});

// ===== sha256 cache invalidation =======================================

test("handleAndroidUpdateManifest: sha256 cache is invalidated when the published APK changes", () => {
  // Hashing is cached by (path, size, mtimeMs). If the cache key isn't busted
  // on republish (or a same-size/same-mtime swap reused the old hash) the
  // handset would compare its installed build against a stale digest and
  // either skip the upgrade or fail integrity. Pin the contract through the
  // publish endpoint, which explicitly clears the cache.
  clearUpdatesDir();

  // Initial publish.
  const r1 = mockRes();
  handleAndroidUpdatePublish(
    mockReq({
      headers: { authorization: "Bearer test-publish-token", "x-version-code": "20" },
      body: Buffer.from("first-build"),
    }),
    r1.res,
  );
  assert.equal(r1.captured.status, 200);

  const m1 = mockRes();
  handleAndroidUpdateManifest(mockReq(), m1.res);
  const firstHash = (m1.captured.body as { sha256: string }).sha256;

  // Publish a different build under a new version → cache MUST be busted.
  const r2 = mockRes();
  handleAndroidUpdatePublish(
    mockReq({
      headers: { authorization: "Bearer test-publish-token", "x-version-code": "21" },
      body: Buffer.from("second-build-differs"),
    }),
    r2.res,
  );
  assert.equal(r2.captured.status, 200);

  const m2 = mockRes();
  handleAndroidUpdateManifest(mockReq(), m2.res);
  const secondHash = (m2.captured.body as { sha256: string }).sha256;

  assert.notEqual(firstHash, secondHash, "new build must yield a different sha256");
});
