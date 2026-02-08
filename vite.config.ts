import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER_PORT = parseInt(process.env.PORT || "3002", 10);

// Detect if running under Tauri (TAURI_ENV_* vars are set by cargo tauri dev)
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  appType: "spa",
  plugins: [react()],

  // Expose TAURI_ env vars to client code
  envPrefix: ["VITE_", "TAURI_"],

  server: {
    port: 5181,
    // Tauri needs the exact port — fail instead of picking another
    strictPort: true,
    proxy: isTauri
      ? undefined
      : {
          "/ws": {
            target: `ws://localhost:${SERVER_PORT}`,
            ws: true,
            changeOrigin: true,
          },
          "/api": {
            target: `http://localhost:${SERVER_PORT}`,
            changeOrigin: true,
          },
        },
  },

  build: {
    outDir: "dist/client",
  },
});
