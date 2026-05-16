import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev the Vite server proxies API + voice WebSocket traffic to the Node server on :8080.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: "http://localhost:8080", changeOrigin: true, ws: true },
      "/health": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
