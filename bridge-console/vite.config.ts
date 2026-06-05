import { defineConfig } from "vite";

// The renderer is loaded by Electron from the local filesystem (file://), so:
// - `base: "./"` makes all emitted asset URLs relative (absolute "/assets/…"
//   paths do not resolve under file://).
// - the build is emitted to ../dist, which electron/main.js loads as index.html.
export default defineConfig({
  root: "renderer",
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
