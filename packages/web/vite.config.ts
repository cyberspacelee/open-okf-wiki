import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // 0.0.0.0 = reachable on LAN; override with `vite --host 127.0.0.1` for local-only.
    host: process.env.VITE_DEV_HOST ?? "0.0.0.0",
    port: Number(process.env.VITE_DEV_PORT ?? "5173"),
    strictPort: true,
  },
});
