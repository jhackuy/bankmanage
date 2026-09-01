import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "dist/ui",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: "index.html",
    },
  },
  resolve: {
    alias: {
      "@ui": fileURLToPath(new URL("./src/ui", import.meta.url)),
      "@data": fileURLToPath(new URL("./data", import.meta.url)),
    },
  },
});
