#!/usr/bin/env node
/**
 * Re-export SSA_PROPERTIES from 10-8-alert-dashboard into safeT.
 * Usage: node scripts/export-ssa-properties.mjs /path/to/10-8-alert-dashboard/dispatcher-server.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcPath = process.argv[2];
if (!srcPath) {
  console.error("Usage: node scripts/export-ssa-properties.mjs <dispatcher-server.js>");
  process.exit(1);
}

const src = fs.readFileSync(srcPath, "utf8");
const start = src.indexOf("const SSA_PROPERTIES = {");
const end = src.indexOf("};", start) + 2;
if (start < 0 || end <= start) {
  console.error("SSA_PROPERTIES block not found");
  process.exit(1);
}

const props = new Function(`${src.slice(start, end)}; return SSA_PROPERTIES;`)();
const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../server/src/aiDispatch/data/ssaProperties.json",
);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(props, null, 2));
console.log(`Wrote ${out} (${Object.keys(props).length} properties)`);
