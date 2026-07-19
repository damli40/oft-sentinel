import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs before every test file. See setup.ts — it exists so that a run's
    // result does not depend on what happens to be in the ambient environment.
    setupFiles: ["./src/__tests__/setup.ts"],
  },
});
