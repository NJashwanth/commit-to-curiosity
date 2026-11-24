import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { USAGE, VERSION, main, runSource, type CliIO } from "../src/cli.js";

function harness() {
  const log = { out: "", err: "" };
  const io: CliIO = {
    stdout: (t) => (log.out += t),
    stderr: (t) => (log.err += t),
    readFile: (p) => {
      if (p === "good.curio") return 'print("hello from a file");';
      if (p === "bad-syntax.curio") return 'let a = ;\nprint("x"\nlet b = 1 +;';
      if (p === "bad-runtime.curio") return "fn f() {\n  return 1 / 0;\n}\nf();";
      throw new Error("ENOENT");
    },
  };
  return { log, io };
}

describe("cli", () => {
  it("starts the REPL when given no arguments", () => {
    expect(main([], harness().io)).toBe("repl");
  });

  it("runs a file", () => {
    const { log, io } = harness();
    expect(main(["good.curio"], io)).toBe(0);
    expect(log.out).toBe("hello from a file\n");
    expect(log.err).toBe("");
  });

  it("reports every syntax error with a caret and exits 65", () => {
    const { log, io } = harness();
    expect(main(["bad-syntax.curio"], io)).toBe(65);
    expect(log.out).toBe("");
    expect(log.err).toContain("error: Expected expression, found ';'");
    expect(log.err).toContain("--> bad-syntax.curio:1:9");
    expect(log.err).toContain("3 | let b = 1 +;");
    expect(log.err).toContain("3 syntax errors found.");
  });

  it("reports runtime errors with a stack trace and exits 70", () => {
    const { log, io } = harness();
    expect(main(["bad-runtime.curio"], io)).toBe(70);
    expect(log.err).toContain("runtime error: Division by zero");
    expect(log.err).toContain("at f (bad-runtime.curio:2)");
    expect(log.err).toContain("at <main> (bad-runtime.curio:4)");
  });

  it("keeps the output printed before a runtime error", () => {
    const { log, io } = harness();
    expect(runSource('print("before");\nnope;', "t.curio", io)).toBe(70);
    expect(log.out).toBe("before\n");
  });

  it("exits 66 for a file that cannot be read", () => {
    const { log, io } = harness();
    expect(main(["missing.curio"], io)).toBe(66);
    expect(log.err).toBe("curio: cannot read 'missing.curio'\n");
  });

  it("runs a snippet with -e", () => {
    const { log, io } = harness();
    expect(main(["-e", 'print(1 + 2);'], io)).toBe(0);
    expect(log.out).toBe("3\n");
    expect(main(["-e", "print("], io)).toBe(65);
    expect(log.err).toContain("<-e>:1:7");
  });

  it("validates arguments", () => {
    const { log, io } = harness();
    expect(main(["-e"], io)).toBe(64);
    expect(main(["--nope"], io)).toBe(64);
    expect(main(["a.curio", "b.curio"], io)).toBe(64);
    expect(log.err).toContain("-e needs exactly one argument");
    expect(log.err).toContain("unexpected arguments");
  });

  it("prints help and the version", () => {
    const { log, io } = harness();
    expect(main(["--help"], io)).toBe(0);
    expect(main(["-h"], io)).toBe(0);
    expect(log.out).toBe(USAGE + "\n" + USAGE + "\n");
    log.out = "";
    expect(main(["--version"], io)).toBe(0);
    expect(main(["-v"], io)).toBe(0);
    expect(log.out).toBe(`curio ${VERSION}\ncurio ${VERSION}\n`);
  });

  it("reads real files through the default I/O", () => {
    const dir = mkdtempSync(join(tmpdir(), "curio-"));
    const file = join(dir, "t.curio");
    writeFileSync(file, "let x = 1;");
    expect(main([file])).toBe(0);
    expect(main([join(dir, "nope.curio")])).toBe(66);
  });
});
