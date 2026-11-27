import { defineConfig } from "vitest/config";

// The core is everything that runs without a browser: the inference engine, the preprocessing and
// the pure helpers behind the UI. `npm run test:cov` fails if its coverage drops under 85%.
// The DOM glue (main.ts, canvas-pad.ts, view.ts) is exercised by the Playwright screenshot script.
export const CORE_FILES = ["src/nn/*.ts", "src/preprocess.ts", "src/colormap.ts", "src/format.ts"];

export default defineConfig({
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: CORE_FILES,
      reporter: ["text", "text-summary"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 85 },
    },
  },
});
