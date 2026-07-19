import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiProxyTarget =
  process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8787";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Listen on all interfaces so http://<any-ip>:5173 works on LAN.
    // Restrict with VITE_DEV_HOST=127.0.0.1 if needed.
    host: process.env.VITE_DEV_HOST ?? "0.0.0.0",
    port: Number(process.env.VITE_DEV_PORT ?? "5173"),
    strictPort: true,
    // Browser always talks to the Vite origin (/api/...). Proxy forwards to
    // the Node server on this machine — no hardcoded LAN IP in the client.
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
