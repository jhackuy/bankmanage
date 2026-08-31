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
      "@worker": "/src/worker",
      "@adapters": "/src/adapters",
      "@domain": "/src/domain",
      "@data": "/data",
    },
  },
});
