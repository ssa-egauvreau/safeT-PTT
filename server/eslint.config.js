// Flat ESLint config for the API server (`src/`) and its tests (`tests/`).
//
// Scope note: the Vite web console lives under `web-console/` and has its own
// ESLint config (different globals + React rules), so it is excluded here and
// linted by its own `npm run lint`.
//
// We use the *non* type-checked recommended set: it needs no TypeScript program
// per run, so `npm run lint` stays fast and matches how `tsc --noEmit` already
// owns the type-level checks in CI. ESLint's job here is the lint-level stuff
// tsc doesn't cover (unsafe patterns, dead code, accidental globals).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "web-console/**", "vocoder/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Allow intentionally-unused args/vars when prefixed with `_` (the
      // codebase already uses `_req`, `_res` for Express middleware signatures).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);
