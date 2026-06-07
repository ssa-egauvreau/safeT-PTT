// Flat ESLint config for the Vite + React dispatch/admin console.
//
// Mirrors the server config (non type-checked recommended set for speed; tsc
// already owns the type layer) and adds the React-specific rules the codebase
// already relies on — there are existing `react-hooks/exhaustive-deps` disable
// comments in the source, so those rules are expected to be live.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // `src/vendor/*` is generated Emscripten WASM glue (single minified lines);
    // it is not hand-maintained source, so linting it is pure noise.
    ignores: ["dist/**", "node_modules/**", "src/vendor/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Vite fast-refresh works best when a module exports only components;
      // warn (don't fail) on mixed exports, which are common in this codebase.
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);
