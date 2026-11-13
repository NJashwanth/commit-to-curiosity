import { defineConfig } from "vitest/config";

// The core is everything that runs without a browser. CI fails if its
// coverage drops under 90%. Browser glue (ui, audio, debugger panel) is
// exercised by hand and by the Playwright screenshots instead.
export const CORE_FILES = [
  "src/hex.ts",
  "src/cpu.ts",
  "src/quirks.ts",
  "src/display.ts",
  "src/machine.ts",
  "src/disasm.ts",
];

export default defineConfig(({ command, isPreview }) => ({
  // Deployed to GitHub Pages under /commit-to-curiosity/chip8/. `npm run preview`
  // serves the build at the same path; `npm run dev` stays at the root.
  base: command === "build" || isPreview ? "/commit-to-curiosity/chip8/" : "/",
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
}));
