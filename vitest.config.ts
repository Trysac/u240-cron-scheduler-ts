import { configDefaults, defineConfig } from "vitest/config";

// Conformance tests that need an external tool or a download live in `*.conformance.test.ts` and
// run only when FABRICA_CI=1 (the CI conformance job); the local gates and coverage skip them.
const ciTier = process.env.FABRICA_CI === "1";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...(ciTier ? [] : ["test/**/*.conformance.test.ts"])],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
