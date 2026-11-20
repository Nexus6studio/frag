import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
  },
  preview: {
    host: "127.0.0.1",
    strictPort: true,
  },
  build: {
    // three.js is one chunk and sits just over Vite's default 500 kB warning.
    chunkSizeWarningLimit: 600,
  },
});
