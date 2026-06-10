import test from "node:test";
import assert from "node:assert/strict";
import { isAuthWsFailure, wsFailureText } from "./ws-auth.mjs";

test("wsFailureText reads common ws error shapes", () => {
  assert.equal(wsFailureText(new Error("Unexpected server response: 401")), "Unexpected server response: 401");
  assert.equal(wsFailureText({ message: "socket closed" }), "socket closed");
  assert.equal(wsFailureText({ reason: "Forbidden" }), "Forbidden");
  assert.equal(wsFailureText({ error: new Error("Unauthorized") }), "Unauthorized");
});

test("isAuthWsFailure detects auth/token failures", () => {
  assert.equal(isAuthWsFailure(new Error("Unexpected server response: 401")), true);
  assert.equal(isAuthWsFailure({ message: "Unexpected server response: 403" }), true);
  assert.equal(isAuthWsFailure({ reason: "token expired" }), true);
  assert.equal(isAuthWsFailure({ error: new Error("unauthorized") }), true);
});

test("isAuthWsFailure ignores non-auth transport failures", () => {
  assert.equal(isAuthWsFailure(new Error("connect ECONNREFUSED 127.0.0.1:8080")), false);
  assert.equal(isAuthWsFailure({ message: "socket hang up" }), false);
  assert.equal(isAuthWsFailure(null), false);
});
