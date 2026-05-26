import assert from "node:assert/strict";
import { test } from "node:test";

import { createApiRouter } from "../src/apiRoutes.js";

test("createApiRouter: module loads and router constructs", () => {
  const router = createApiRouter();
  assert.ok(router);
});
