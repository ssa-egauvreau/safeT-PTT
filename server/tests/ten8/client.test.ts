import { test } from "node:test";
import assert from "node:assert/strict";

import { prepareTen8NewIncidentBody } from "../../src/ten8/client.js";

test("prepareTen8NewIncidentBody preserves exact CAD type punctuation and spacing", () => {
  const exactType = "459-A  - Burglary Alarm (Audible)";
  const out = prepareTen8NewIncidentBody({
    type: exactType,
    summary: "Unit reports alarm / possible forced entry @ rear gate",
    streetAddress: "1586 N. Batavia St.",
    city: "Anaheim",
    state: "CA",
    zip: "92806",
  });

  // 10-8 validates incident type strings verbatim; this must not be sanitized.
  assert.equal(out.type, exactType);
  // Other free-text fields still go through the safety sanitizer.
  assert.equal(out.summary, "Unit reports alarm possible forced entry rear gate");
  // Address normalization still runs after sanitization.
  assert.equal(out.streetAddress, "1586 N Batavia St");
});

test("prepareTen8NewIncidentBody keeps strict sanitization when no type is supplied", () => {
  const out = prepareTen8NewIncidentBody({
    summary: "Check lot #3 / side-door [west]",
    location: "2000 E. Gene Autry Way, Anaheim, CA 92806",
  });

  assert.equal(out.summary, "Check lot 3 side door west");
  assert.equal(out.location, "2000 E Gene Autry Way, Anaheim, CA 92806");
});
