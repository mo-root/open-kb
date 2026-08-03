import { defineConfig } from "vitest/config"

// `packages/web` colocates its tests beside the code they cover, following v1,
// so the pattern has to reach those too. It did not, and a new store's whole
// test file was collected by nothing and reported as neither passing nor
// failing: the suite went green while the code was untested.
export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
      "packages/web/lib/**/*.test.ts",
      "packages/web/components/**/*.test.ts",
    ],
  },
})
