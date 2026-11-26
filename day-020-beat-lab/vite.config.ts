import { defineConfig } from "vitest/config";

// The core is everything that runs without a real browser or audio hardware.
// `npm run test:cov` fails if its coverage drops under 85%. The DOM glue in
// ui.ts and main.ts is exercised by hand and by the Playwright screenshots.
export const CORE_FILES = [
  "src/audio-context.ts",
  "src/drums.ts",
  "src/synth.ts",
  "src/scheduler.ts",
  "src/sequencer.ts",
  "src/effects.ts",
  "src/state.ts",
  "src/controls.ts",
  "src/engine.ts",
  "src/presets.ts",
  "src/storage.ts",
  "src/url-codec.ts",
  "src/wav.ts",
  "src/render.ts",
  "src/visualizer.ts",
];

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
