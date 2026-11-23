import { defineConfig } from "vitest/config";

// The core is everything that runs without a browser. `npm run test:cov` fails
// if its coverage drops under 85%. The DOM glue in ui.ts and chart.ts is
// exercised by hand and by the Playwright screenshots instead.
export const CORE_FILES = [
  "src/rng.ts",
  "src/chart.ts",
  "src/genome.ts",
  "src/terrain.ts",
  "src/physics.ts",
  "src/sim.ts",
  "src/ga.ts",
  "src/hof.ts",
  "src/headless.ts",
];

export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000, // a few tests simulate real physics for many generations
    coverage: {
      provider: "v8",
      include: CORE_FILES,
      reporter: ["text", "text-summary"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 85 },
    },
  },
});
