#!/usr/bin/env node
/**
 * Copy non-TypeScript assets into dist/ (tsc does not emit .txt files).
 */
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function copyTxtDir(fromRel, toRel) {
  const from = join(serverRoot, fromRel);
  const to = join(serverRoot, toRel);
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (!name.endsWith(".txt")) {
      continue;
    }
    cpSync(join(from, name), join(to, name));
    console.log(`[copy-server-assets] ${fromRel}/${name} → ${toRel}/${name}`);
  }
}

copyTxtDir("src/aiDispatch/prompts", "dist/aiDispatch/prompts");

const jsonFrom = join(serverRoot, "src/aiDispatch/data/ssaProperties.json");
const jsonTo = join(serverRoot, "dist/aiDispatch/data/ssaProperties.json");
mkdirSync(dirname(jsonTo), { recursive: true });
cpSync(jsonFrom, jsonTo);
console.log("[copy-server-assets] ssaProperties.json → dist/aiDispatch/data/");
