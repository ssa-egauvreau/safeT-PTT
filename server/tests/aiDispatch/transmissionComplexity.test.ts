import { test } from "node:test";
import assert from "node:assert/strict";
import { transmissionLooksComplex } from "../../src/aiDispatch/parse.ts";

test("routine radio traffic uses the fast tier (not complex)", () => {
  for (const t of [
    "27-010, radio check",
    "352 going 10-8",
    "Dispatch, 401 on scene",
    "27-000, how do you copy",
    "352, I'm 10-97 at the station",
    "",
  ]) {
    assert.equal(transmissionLooksComplex(t), false, `should be routine: ${t}`);
  }
});

test("lookup-style traffic bumps to the complex tier", () => {
  for (const t of [
    "Dispatch, run this plate Adam Boy Charlie 1 2 3",
    "352, can you run a 10-28 on California plate 8ABC123",
    "Check for wants and warrants on John Smith DOB 1/1/90",
    "27-000, look up the incident number 25-04412",
    "Run this name, last Johnson first Mike",
    "Pull up the vehicle registration on that tag",
    "352, 10-29 on the driver",
  ]) {
    assert.equal(transmissionLooksComplex(t), true, `should be complex: ${t}`);
  }
});
