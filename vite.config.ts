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
    // three.js is one chunk. The drone and pickup code put it just over 600 kB.
    chunkSizeWarningLimit: 640,
  },
});
