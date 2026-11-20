import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    // convex-test imports each component's convex.config to find its init,
    // and batch-worker's published config (imported from workpool's) has
    // extensionless relative imports.
    server: { deps: { inline: [/@convex-dev\//] } },
    typecheck: {
      tsconfig: "./tsconfig.test.json",
    },
  },
});
