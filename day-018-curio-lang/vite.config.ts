import { defineConfig } from "vitest/config";

// The core is everything that runs without a browser. `npm run test:cov` fails if
// coverage of these modules drops under 90%. The DOM glue in playground.ts is
// exercised by hand and by the Playwright screenshot instead.
export const CORE_FILES = [
  "src/token.ts",
  "src/errors.ts",
  "src/lexer.ts",
  "src/ast.ts",
  "src/parser.ts",
  "src/values.ts",
  "src/environment.ts",
  "src/stdlib.ts",
  "src/interpreter.ts",
  "src/repl.ts",
  "src/cli.ts",
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
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
