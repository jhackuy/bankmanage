import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run tests in a Node-compatible environment (not jsdom) for unit/integration tests
    // UI component tests would use jsdom but we keep M0 CI lightweight.
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: ["node_modules", "dist", "src/ui/**"],
    },
  },
  resolve: {
    alias: {
      "@worker": fileURLToPath(new URL("./src/worker", import.meta.url)),
      "@adapters": fileURLToPath(new URL("./src/adapters", import.meta.url)),
      "@data": fileURLToPath(new URL("./data", import.meta.url)),
    },
  },
});
