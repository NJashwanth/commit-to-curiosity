import { defineConfig } from "vitest/config";

// The core is everything that runs without a browser. `npm run test:cov` fails
// if its coverage drops under 90%. The DOM glue in ui.ts is exercised by hand
// and by the Playwright screenshots instead.
export const CORE_FILES = ["src/engine.ts", "src/rng.ts", "src/nn.ts", "src/optim.ts", "src/datasets.ts", "src/train.ts", "src/graphview.ts"];

export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: CORE_FILES,
      reporter: ["text", "text-summary"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
