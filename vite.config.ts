import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readVersion } from "./scripts/version.mjs";

const host = process.env.TAURI_DEV_HOST;

/**
 * The version shown in the UI comes from `version.json` through the bundler, not
 * from a literal in the components. A hand-written constant is how the number in
 * «О программе» fell four releases behind the binary without anyone noticing.
 */
const launcherVersion = readVersion();

export default defineConfig({
  base: "./",
  // A single window with no routing.
  appType: "spa",
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
  define: {
    __LAUNCHER_VERSION__: JSON.stringify(launcherVersion),
  },
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari15",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
