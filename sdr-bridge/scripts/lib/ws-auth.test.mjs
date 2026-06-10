import test from "node:test";
import assert from "node:assert/strict";
import { isAuthWsFailure, wsFailureText } from "./ws-auth.mjs";

test("wsFailureText reads common ws error shapes", () => {
  assert.equal(wsFailureText(new Error("Unexpected server response: 401")), "Unexpected server response: 401");
  assert.equal(wsFailureText({ message: "socket closed" }), "socket closed");
  assert.equal(wsFailureText({ reason: "Forbidden" }), "Forbidden");
  assert.equal(wsFailureText({ error: new Error("Unauthorized") }), "Unauthorized");
});

test("wsFailureText returns empty string for falsy or empty inputs", () => {
  assert.equal(wsFailureText(null), "");
  assert.equal(wsFailureText(undefined), "");
  assert.equal(wsFailureText(""), "");
  assert.equal(wsFailureText(0), "");
});

test("wsFailureText returns the string when given a primitive string", () => {
  assert.equal(wsFailureText("Unauthorized"), "Unauthorized");
  assert.equal(wsFailureText("connect ECONNREFUSED"), "connect ECONNREFUSED");
});

test("wsFailureText prefers message, then reason, then nested error.message", () => {
  // message wins over reason
  assert.equal(wsFailureText({ message: "primary", reason: "secondary" }), "primary");
  // empty message falls through to reason
  assert.equal(wsFailureText({ message: "", reason: "fallback" }), "fallback");
  // empty message + empty reason falls through to error.message
  assert.equal(
    wsFailureText({ message: "", reason: "", error: new Error("nested") }),
    "nested",
  );
});

test("wsFailureText reads nested non-Error objects exposing a message", () => {
  // CloseEvent-style payloads sometimes wrap a plain object, not an Error instance
  assert.equal(
    wsFailureText({ error: { message: "wrapped failure" } }),
    "wrapped failure",
  );
});

test("wsFailureText falls back to String() for unknown shapes", () => {
  // Errors with no message should still produce something non-empty (the toString form)
  const errNoMsg = new Error("");
  assert.equal(wsFailureText(errNoMsg), String(errNoMsg));
  // Plain object with no recognized fields → object toString
  assert.equal(wsFailureText({ foo: "bar" }), "[object Object]");
  // Number → its string form
  assert.equal(wsFailureText(404), "404");
});

test("isAuthWsFailure detects auth/token failures", () => {
  assert.equal(isAuthWsFailure(new Error("Unexpected server response: 401")), true);
  assert.equal(isAuthWsFailure({ message: "Unexpected server response: 403" }), true);
  assert.equal(isAuthWsFailure({ reason: "token expired" }), true);
  assert.equal(isAuthWsFailure({ error: new Error("unauthorized") }), true);
});

test("isAuthWsFailure matches each recognized auth signal", () => {
  // 401 / 403 HTTP codes on the WebSocket upgrade
  assert.equal(isAuthWsFailure("Unexpected server response: 401"), true);
  assert.equal(isAuthWsFailure("Unexpected server response: 403"), true);
  // "unauth" substring (covers "unauthorized", "unauthenticated", ...)
  assert.equal(isAuthWsFailure("unauthorized"), true);
  assert.equal(isAuthWsFailure("unauthenticated"), true);
  // "forbidden" substring
  assert.equal(isAuthWsFailure("forbidden"), true);
  assert.equal(isAuthWsFailure("Access Forbidden"), true);
  // "token" substring
  assert.equal(isAuthWsFailure("token rejected"), true);
  assert.equal(isAuthWsFailure("bad token"), true);
  // standalone "auth" word
  assert.equal(isAuthWsFailure("auth"), true);
  assert.equal(isAuthWsFailure("join denied: auth"), true);
});

test("isAuthWsFailure is case-insensitive", () => {
  assert.equal(isAuthWsFailure(new Error("UNAUTHORIZED")), true);
  assert.equal(isAuthWsFailure({ message: "FORBIDDEN" }), true);
  assert.equal(isAuthWsFailure({ reason: "TOKEN expired" }), true);
});

test("isAuthWsFailure ignores non-auth transport failures", () => {
  assert.equal(isAuthWsFailure(new Error("connect ECONNREFUSED 127.0.0.1:8080")), false);
  assert.equal(isAuthWsFailure({ message: "socket hang up" }), false);
  assert.equal(isAuthWsFailure(null), false);
});

// Safety property: an unnecessary relogin terminates this account's other
// voice sockets server-side. The codes the relay actually emits today
// (see server/src/voiceRelay.ts) must therefore NEVER look like auth failures.
test("isAuthWsFailure does NOT trigger on relay error codes that are not auth-related", () => {
  for (const code of ["bad_join", "unknown_channel", "not_a_member", "rate_limited", "bad_codec"]) {
    assert.equal(isAuthWsFailure(code), false, `code "${code}" must not be treated as auth failure`);
  }
});

test("isAuthWsFailure does NOT trigger on benign close events or empty payloads", () => {
  assert.equal(isAuthWsFailure(undefined), false);
  assert.equal(isAuthWsFailure(""), false);
  assert.equal(isAuthWsFailure({}), false);
  // Normal close codes (1000 OK, 1006 abnormal closure, 1011 internal error)
  assert.equal(isAuthWsFailure({ code: 1000, reason: "" }), false);
  assert.equal(isAuthWsFailure({ code: 1006, reason: "" }), false);
  assert.equal(isAuthWsFailure({ code: 1011, reason: "internal error" }), false);
});

// Word-boundary behavior of /\b401\b/ and /\b403\b/: only the exact status
// codes should trigger, not arbitrary numbers that happen to contain those
// digits. This guards against false positives like sample/order IDs.
test("isAuthWsFailure word-boundary checks do not over-match unrelated digits", () => {
  assert.equal(isAuthWsFailure("4011"), false);
  assert.equal(isAuthWsFailure("14010"), false);
  assert.equal(isAuthWsFailure("error 4030"), false);
});
