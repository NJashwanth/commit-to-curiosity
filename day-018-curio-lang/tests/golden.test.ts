import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { out } from "./helpers.js";

const dir = join(import.meta.dirname, "..", "examples");
const programs = readdirSync(dir)
  .filter((f) => f.endsWith(".curio"))
  .sort();

describe("golden tests: every example program matches its .out file", () => {
  it("has at least the five playground examples", () => {
    for (const name of ["fizzbuzz", "fib", "closures", "quicksort", "wordcount"]) {
      expect(programs).toContain(`${name}.curio`);
    }
  });

  it("has an expected output for every program and no orphans", () => {
    const outs = readdirSync(dir)
      .filter((f) => f.endsWith(".out"))
      .map((f) => f.replace(/\.out$/, ".curio"))
      .sort();
    expect(outs).toEqual(programs);
  });

  it.each(programs)("%s", (file) => {
    const source = readFileSync(join(dir, file), "utf8");
    const expected = readFileSync(join(dir, file.replace(/\.curio$/, ".out")), "utf8");
    expect(out(source)).toBe(expected);
  });
});
