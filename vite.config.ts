import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  base: "./",
  // `/preview.html` is the design sandbox (src/preview.tsx); the app itself is
  // a single window with no routing.
  appType: "mpa",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || "0.0.0.0",
    allowedHosts: [".e2b.app", "localhost", "127.0.0.1"],
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,

    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Two pages: the app window and the design sandbox.
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        preview: path.resolve(import.meta.dirname, "preview.html"),
      },
    },
    target:
      process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari15",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
