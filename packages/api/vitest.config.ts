import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests share one Postgres database and reset it between files.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
