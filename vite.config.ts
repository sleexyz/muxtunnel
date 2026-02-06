import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER_PORT = parseInt(process.env.PORT || "3002", 10);

export default defineConfig({
  appType: "spa",
  plugins: [react()],
  server: {
    port: 5181,
    proxy: {
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
