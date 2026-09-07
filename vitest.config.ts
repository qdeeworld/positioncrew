import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    root: ".",
    include: ["test/**/*.test.ts", "test/shadow-grid-cohort-consumers.test.js"],
  },
});
